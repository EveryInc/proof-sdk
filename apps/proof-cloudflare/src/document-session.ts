import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { deriveMarkdownFromYDoc, applyMarkdownToYDoc } from "./canonical-projection.js";
import { stripProofSpanTags } from "./proof-span-strip.js";
import { DODocumentStorage } from "./storage-do.js";
import {
  addComment,
  addSuggestion,
  acceptSuggestion,
  rejectSuggestion,
  replyComment,
  resolveComment,
  unresolveComment,
  type MarkOperationResult,
} from "./document-engine.js";
import { applyAgentEditOperations, type AgentEditOperation } from "./agent-edit-ops.js";
import { stripProofSpanTags as stripSpansForEdit } from "./proof-span-strip.js";
import { getPresentedSecret, checkAuth, getAgentId } from "./auth.js";
import {
  getIdempotencyKey,
  checkIdempotency,
  storeIdempotencyResult,
} from "./idempotency.js";

export interface Env {
  DOCUMENT_SESSION: DurableObjectNamespace;
  CATALOG_DB: D1Database;
  ASSETS: Fetcher;
}

/**
 * Hocuspocus wire protocol message types.
 * Every message is framed as: varString(documentName) + varUint(type) + payload
 */
const MessageType = {
  Sync: 0,
  Awareness: 1,
  Auth: 2,
  QueryAwareness: 3,
  Stateless: 5,
  CLOSE: 7,
  SyncStatus: 8,
} as const;

/** Auth sub-message types (nested inside MessageType.Auth). */
const AuthMessageType = {
  Token: 0,
  PermissionDenied: 1,
  Authenticated: 2,
} as const;

/** Number of incremental updates before compacting into a single snapshot. */
const COMPACTION_THRESHOLD = 200;

/** Milliseconds to wait after last client disconnects before running cleanup. */
const CLEANUP_DELAY_MS = 30_000;

/**
 * Durable Object managing a single document's collaborative session.
 *
 * Each instance is keyed by document slug and owns:
 * - A Y.Doc with Hocuspocus-compatible Yjs sync over WebSocket
 * - SQLite storage for persisted document state
 * - Awareness broadcasting for cursors/presence
 */
export class DocumentSession extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private awareness: awarenessProtocol.Awareness | null = null;
  private updateCount = 0;
  /** The document name (slug) used for Hocuspocus protocol framing. */
  private roomName: string | null = null;
  /** Per-document storage for agent routes (events, idempotency, access). */
  private docStorage: DODocumentStorage | null = null;
  /** Maps each WebSocket to the awareness client IDs it controls. */
  private socketAwarenessClients = new Map<WebSocket, Set<number>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initStorage();
  }

  /** Get or create the DODocumentStorage for this document's slug. */
  private ensureDocStorage(slug: string): DODocumentStorage {
    if (this.docStorage) return this.docStorage;
    this.docStorage = new DODocumentStorage({ ctx: this.ctx, slug });
    return this.docStorage;
  }

  private initStorage(): void {
    const sql = this.ctx.storage.sql;

    // Yjs persistence tables
    sql.exec(`CREATE TABLE IF NOT EXISTS document_state (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS yjs_updates (
      id INTEGER PRIMARY KEY,
      update_data BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // Agent bridge tables (events, idempotency, access control)
    // Initialized here at DO construction so they don't add CPU cost during requests.
    sql.exec(`CREATE TABLE IF NOT EXISTS documents (
      slug TEXT PRIMARY KEY, doc_id TEXT, title TEXT,
      markdown TEXT NOT NULL DEFAULT '', marks TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 0, y_state_version INTEGER NOT NULL DEFAULT 0,
      share_state TEXT NOT NULL DEFAULT 'ACTIVE', access_epoch INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS document_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_slug TEXT NOT NULL,
      document_revision INTEGER, event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}', actor TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acked_by TEXT, acked_at TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS mutation_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_slug TEXT NOT NULL,
      document_revision INTEGER, event_id INTEGER, event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}', actor TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key TEXT NOT NULL, document_slug TEXT NOT NULL,
      route TEXT NOT NULL, response_json TEXT NOT NULL,
      request_hash TEXT, status_code INTEGER NOT NULL DEFAULT 200,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (idempotency_key, document_slug, route)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS document_access (
      token_id TEXT PRIMARY KEY, document_slug TEXT NOT NULL,
      role TEXT NOT NULL, secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT
    )`);
  }

  /**
   * Lazily initialize the Y.Doc from persisted SQLite state.
   * Called on first WebSocket connection or HTTP snapshot request.
   */
  private ensureDoc(): Y.Doc {
    if (this.doc) return this.doc;

    const doc = new Y.Doc();
    const sql = this.ctx.storage.sql;

    // Load base snapshot if present
    const snapshotRows = sql
      .exec("SELECT value FROM document_state WHERE key = 'yjs_snapshot'")
      .toArray();

    if (snapshotRows.length > 0) {
      const snapshotValue = snapshotRows[0]["value"];
      if (snapshotValue instanceof ArrayBuffer) {
        Y.applyUpdate(doc, new Uint8Array(snapshotValue));
      }
    }

    // Apply incremental updates on top of snapshot
    const updateRows = sql
      .exec("SELECT update_data FROM yjs_updates ORDER BY id ASC")
      .toArray();

    for (const row of updateRows) {
      const updateValue = row["update_data"];
      if (updateValue instanceof ArrayBuffer) {
        Y.applyUpdate(doc, new Uint8Array(updateValue));
      }
    }

    this.updateCount = updateRows.length;

    // Listen for updates from any source (local apply or remote sync)
    // and persist them. Only websocket-origin updates are broadcast.
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      // Updates applied during load (origin undefined/null) are already persisted.
      if (origin !== undefined && origin !== null) {
        this.persistUpdate(update);
      }
      if (origin instanceof WebSocket) {
        this.broadcastUpdate(update, origin);
      }
    });

    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);
    // Disable the awareness check interval — DO hibernation handles lifecycle
    if (this.awareness._checkInterval) {
      clearInterval(this.awareness._checkInterval);
      this.awareness._checkInterval = 0;
    }

    return doc;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(url);
    }

    // Agent bridge routes — must match before generic /snapshot, /content etc.
    const agentMatch = url.pathname.match(/\/agent\/([^/]+)\/(.+)$/);
    if (agentMatch) {
      return this.handleAgentRoute(request, url, agentMatch[2]);
    }

    // HTTP API endpoints (editor-facing)
    if (url.pathname.endsWith("/content")) {
      return this.handleContentRequest(request);
    }

    if (url.pathname.endsWith("/snapshot")) {
      return this.handleSnapshotRequest();
    }

    if (url.pathname.endsWith("/open-context")) {
      return this.handleOpenContext(request);
    }

    if (url.pathname.endsWith("/collab-session")) {
      return this.handleCollabSession(request);
    }

    if (url.pathname.endsWith("/collab-refresh")) {
      return this.handleCollabSession(request);
    }

    // GET /documents/:slug (bare) — return document data
    if (url.pathname.match(/\/documents\/[^/]+\/?$/) && request.method === "GET") {
      return this.handleGetDocument(request);
    }

    // PUT /documents/:slug/title
    if (url.pathname.endsWith("/title") && request.method === "PUT") {
      return this.handleUpdateTitle(request);
    }

    // POST /documents/:slug/events/ack
    if (url.pathname.endsWith("/events/ack") && request.method === "POST") {
      return this.handleEventsAck(request);
    }

    // Document lifecycle endpoints
    if (url.pathname.endsWith("/pause") && request.method === "POST") {
      return this.handleLifecycle(request, "PAUSED");
    }
    if (url.pathname.endsWith("/resume") && request.method === "POST") {
      return this.handleLifecycle(request, "ACTIVE");
    }
    if (url.pathname.endsWith("/revoke") && request.method === "POST") {
      return this.handleLifecycle(request, "REVOKED");
    }
    if (url.pathname.endsWith("/delete") && request.method === "POST") {
      return this.handleLifecycle(request, "DELETED");
    }
    if (request.method === "DELETE" && url.pathname.match(/\/documents\/[^/]+\/?$/)) {
      return this.handleLifecycle(request, "DELETED");
    }

    // GET /documents/:slug/events/pending (real implementation)
    if (url.pathname.endsWith("/events/pending") && request.method === "GET") {
      return this.handleEventsPending(request);
    }

    return Response.json(
      { error: "Not found", path: url.pathname },
      { status: 404 },
    );
  }

  /**
   * Returns the open-context payload the editor needs to initialize.
   * Mirrors the shape from the Express server's /documents/:slug/open-context.
   */
  private async handleOpenContext(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const slug = this.getSlugFromRequest(url);
    const metadata = await this.readDocumentMetadata(slug);

    // Derive canonical markdown from the ProseMirror fragment
    const ydoc = this.ensureDoc();
    let markdown = "";
    try {
      const projection = await deriveMarkdownFromYDoc(ydoc);
      markdown = projection.markdown;
    } catch {
      markdown = ydoc.getText("markdown").toString();
    }

    // Read marks from DODocumentStorage if available
    const storage = this.ensureDocStorage(slug);
    let marks: Record<string, unknown> = {};
    try {
      const marksJson = storage.getMarks(slug);
      if (marksJson) marks = JSON.parse(marksJson);
    } catch {
      // Ignore parse errors
    }

    return Response.json({
      success: true,
      doc: {
        slug,
        docId: metadata.docId,
        title: metadata.title,
        markdown,
        marks,
        shareState: "ACTIVE",
        active: true,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        viewers: this.getWebSockets().length,
      },
      session: this.buildCollabSession(url, slug),
      capabilities: {
        canRead: true,
        canEdit: true,
        canComment: true,
        canSuggest: true,
        canApprove: false,
        canDelete: false,
        canPause: false,
        canRevoke: false,
        canManageAccess: false,
      },
      links: {
        webUrl: `${url.origin}/d/${encodeURIComponent(slug)}`,
        snapshotUrl: null,
      },
    });
  }

  private handleCollabSession(request: Request): Response {
    const url = new URL(request.url);
    const slug = this.getSlugFromRequest(url);

    return Response.json({
      success: true,
      session: this.buildCollabSession(url, slug),
      capabilities: {
        canRead: true,
        canEdit: true,
        canComment: true,
      },
    });
  }

  /** Build a CollabSessionInfo matching the shape the editor validates. */
  private buildCollabSession(url: URL, slug: string) {
    // Use path-based routing: /ws/<slug>
    // The HocuspocusProvider strips ?slug= query params from collabWsUrl,
    // but preserves the path. The worker extracts the slug from the path.
    const wsUrl = `${url.origin.replace("http", "ws")}/ws/${encodeURIComponent(slug)}`;
    return {
      docId: slug,
      slug,
      role: "editor",
      shareState: "ACTIVE",
      accessEpoch: 1,
      syncProtocol: "pm-yjs-v1",
      collabWsUrl: wsUrl,
      token: "cf-session",
      snapshotVersion: 0,
    };
  }

  private async handleGetDocument(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const slug = this.getSlugFromRequest(url);
    const metadata = await this.readDocumentMetadata(slug);

    const ydoc = this.ensureDoc();
    let markdown = "";
    try {
      const projection = await deriveMarkdownFromYDoc(ydoc);
      markdown = projection.markdown;
    } catch {
      markdown = ydoc.getText("markdown").toString();
    }

    const storage = this.ensureDocStorage(slug);
    let marks: Record<string, unknown> = {};
    try {
      const marksJson = storage.getMarks(slug);
      if (marksJson) marks = JSON.parse(marksJson);
    } catch {
      // Ignore parse errors
    }

    return Response.json({
      success: true,
      slug,
      docId: metadata.docId,
      title: metadata.title,
      markdown,
      marks,
      shareState: "ACTIVE",
      active: true,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    });
  }

  private async handleUpdateTitle(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const url = new URL(request.url);
    const slug = this.getSlugFromRequest(url);
    const title = typeof body.title === "string" ? body.title : "";
    await this.env.CATALOG_DB.prepare(
      "UPDATE documents SET title = ?, updated_at = datetime('now') WHERE slug = ?",
    )
      .bind(title, slug)
      .run();
    return Response.json({
      success: true,
      title,
      updatedAt: new Date().toISOString(),
    });
  }

  private async readDocumentMetadata(slug: string): Promise<{
    docId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const row = await this.env.CATALOG_DB.prepare(
      "SELECT id, title, created_at, updated_at FROM documents WHERE slug = ?",
    )
      .bind(slug)
      .first<Record<string, unknown>>();

    return {
      docId: typeof row?.id === "string" ? row.id : slug,
      title: typeof row?.title === "string" ? row.title : "",
      createdAt: typeof row?.created_at === "string" ? row.created_at : new Date().toISOString(),
      updatedAt: typeof row?.updated_at === "string" ? row.updated_at : new Date().toISOString(),
    };
  }

  private getSlugFromRequest(url: URL): string {
    // Extract slug from /api/documents/:slug/... or /documents/:slug/...
    const match = url.pathname.match(/\/documents\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "unknown";
  }

  /** Extract slug from /api/agent/:slug/... paths. */
  private getAgentSlugFromRequest(url: URL): string {
    const match = url.pathname.match(/\/agent\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : "unknown";
  }

  // ---------------------------------------------------------------------------
  // Events (real implementation using DODocumentStorage)
  // ---------------------------------------------------------------------------

  private handleEventsPending(request: Request): Response {
    try {
      const url = new URL(request.url);
      // Try document path first, then agent path for slug extraction
      const docSlug = url.pathname.match(/\/documents\/([^/]+)/)
        ? this.getSlugFromRequest(url)
        : null;
      const slug = docSlug ?? this.getAgentSlugFromRequest(url);
      const storage = this.ensureDocStorage(slug);

      const afterParam = url.searchParams.get("after") ?? "0";
      const afterId = Number.parseInt(afterParam, 10);
      const cursor = Number.isFinite(afterId) ? Math.max(0, afterId) : 0;
      const limit = Math.min(
        Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
        500,
      );

      const events = storage.listDocumentEvents(slug, cursor, limit);
      const nextCursor = events.length > 0
        ? events[events.length - 1].id
        : cursor;

      return Response.json({
        success: true,
        events: events.map((e) => ({
          id: e.id,
          type: e.event_type,
          data: typeof e.event_data === "string" ? JSON.parse(e.event_data || "{}") : e.event_data,
          actor: e.actor,
          createdAt: e.created_at,
          ackedAt: e.acked_at,
          ackedBy: e.acked_by,
        })),
        cursor: nextCursor,
      });
    } catch (error) {
      return Response.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async handleEventsAck(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const docSlug = url.pathname.match(/\/documents\/([^/]+)/)
      ? this.getSlugFromRequest(url)
      : null;
    const slug = docSlug ?? this.getAgentSlugFromRequest(url);
    const storage = this.ensureDocStorage(slug);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const upToId = typeof body.upToId === "number" ? body.upToId : 0;
    const ackedBy = typeof body.by === "string" ? body.by : getAgentId(request);

    const acked = storage.ackDocumentEvents(slug, upToId, ackedBy);
    return Response.json({ success: true, acked });
  }

  // ---------------------------------------------------------------------------
  // Agent bridge route dispatcher
  // ---------------------------------------------------------------------------

  private async handleAgentRoute(
    request: Request,
    url: URL,
    subPath: string,
  ): Promise<Response> {
    const slug = this.getAgentSlugFromRequest(url);

    // Auth check — if a token is presented, verify it and enforce role.
    // If no token, allow access (open/no-auth mode per discovery endpoint).
    const secret = getPresentedSecret(request);
    if (secret) {
      const storage = this.ensureDocStorage(slug);
      const requiredRole = getRequiredRole(subPath, request.method);
      const auth = checkAuth(storage, slug, secret, requiredRole);
      if (!auth) {
        return Response.json(
          { error: "Insufficient permissions", requiredRole },
          { status: 403 },
        );
      }
    }

    // Agent events
    if (subPath === "events/pending" && request.method === "GET") {
      return this.handleEventsPending(request);
    }
    if (subPath === "events/ack" && request.method === "POST") {
      return this.handleEventsAck(request);
    }

    // --- Routes below here return 501 until implemented in later phases ---

    // Phase 3: Read routes
    if (subPath === "state" && request.method === "GET") {
      return this.handleAgentState(request, url, slug);
    }
    if (subPath === "snapshot" && request.method === "GET") {
      return this.handleAgentSnapshot(request, url, slug);
    }

    // Phase 4: Marks CRUD
    if (subPath.startsWith("marks/") && request.method === "POST") {
      return this.handleMarksRoute(request, slug, subPath.slice(6));
    }

    // Phase 5: Edits
    if (subPath === "edit" && request.method === "POST") {
      return this.handleAgentEdit(request, slug);
    }
    if (subPath === "edit/v2" && request.method === "POST") {
      return this.handleAgentEditV2(request, slug);
    }

    // Phase 6: Rewrite, ops, presence
    if (subPath === "rewrite" && request.method === "POST") {
      return this.handleAgentRewrite(request, slug);
    }
    if (subPath === "ops" && request.method === "POST") {
      return this.handleAgentOps(request, slug);
    }
    if (subPath === "presence" && request.method === "POST") {
      return this.handleAgentPresence(request, slug);
    }
    if (subPath === "presence/disconnect" && request.method === "POST") {
      return this.handleAgentPresenceDisconnect(request);
    }

    return Response.json(
      { error: "Not found", path: url.pathname },
      { status: 404 },
    );
  }

  // ---------------------------------------------------------------------------
  // Agent state + snapshot handlers
  // ---------------------------------------------------------------------------

  private async handleAgentState(
    request: Request,
    url: URL,
    slug: string,
  ): Promise<Response> {
    const metadata = await this.readDocumentMetadata(slug);
    const ydoc = this.ensureDoc();

    // Derive markdown from the ProseMirror fragment (what the browser sees)
    let markdown = "";
    let projectionSource = "fragment";
    try {
      const projection = await deriveMarkdownFromYDoc(ydoc);
      markdown = stripProofSpanTags(projection.markdown);
    } catch (err) {
      // Fall back to Y.Text if fragment conversion fails
      projectionSource = "ytext-fallback";
      markdown = stripProofSpanTags(ydoc.getText("markdown").toString());
    }

    // Read marks from the Y.Doc marks map if available
    let marks: Record<string, unknown> = {};
    try {
      const marksMap = ydoc.getMap("marks");
      if (marksMap.size > 0) {
        marks = marksMap.toJSON();
      }
    } catch {
      // Ignore
    }

    const revision = this.updateCount;
    const baseUrl = url.origin;

    return Response.json({
      success: true,
      slug,
      docId: metadata.docId,
      title: metadata.title,
      markdown,
      marks,
      revision,
      shareState: "ACTIVE",
      stage: "mutation_ready",
      capabilities: {
        snapshotV2: true,
        editV2: true,
        topLevelOnly: false,
        mutationReady: true,
      },
      _links: {
        self: `${baseUrl}/api/agent/${encodeURIComponent(slug)}/state`,
        edit: `${baseUrl}/api/agent/${encodeURIComponent(slug)}/edit/v2`,
        snapshot: `${baseUrl}/api/agent/${encodeURIComponent(slug)}/snapshot`,
        ops: `${baseUrl}/api/agent/${encodeURIComponent(slug)}/ops`,
        presence: `${baseUrl}/api/agent/${encodeURIComponent(slug)}/presence`,
        events: `${baseUrl}/api/agent/${encodeURIComponent(slug)}/events/pending`,
      },
      agent: {
        name: getAgentId(request),
        color: "#6366f1",
        avatar: "",
      },
      viewers: this.getWebSockets().length,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    });
  }

  private async handleAgentSnapshot(
    _request: Request,
    url: URL,
    slug: string,
  ): Promise<Response> {
    const metadata = await this.readDocumentMetadata(slug);
    const ydoc = this.ensureDoc();

    let markdown = "";
    try {
      const projection = await deriveMarkdownFromYDoc(ydoc);
      markdown = stripProofSpanTags(projection.markdown);
    } catch {
      markdown = stripProofSpanTags(ydoc.getText("markdown").toString());
    }
    const revision = this.updateCount;

    // Read marks from Y.Doc
    let marks: Record<string, unknown> = {};
    try {
      const marksMap = ydoc.getMap("marks");
      if (marksMap.size > 0) {
        marks = marksMap.toJSON();
      }
    } catch {
      // Ignore
    }

    return Response.json({
      success: true,
      slug,
      revision,
      title: metadata.title,
      markdown,
      marks,
      y_state_version: 0,
      access_epoch: 0,
      collab: {
        status: "converged",
        markdownStatus: "converged",
        fragmentStatus: "converged",
        canonicalStatus: "converged",
      },
      pendingEvents: {
        count: 0,
        types: [],
      },
      _links: {
        self: `${url.origin}/api/agent/${encodeURIComponent(slug)}/snapshot`,
        state: `${url.origin}/api/agent/${encodeURIComponent(slug)}/state`,
        edit: `${url.origin}/api/agent/${encodeURIComponent(slug)}/edit/v2`,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Document lifecycle handler
  // ---------------------------------------------------------------------------

  private async handleLifecycle(
    request: Request,
    newState: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const slug = this.getSlugFromRequest(url);

    await this.env.CATALOG_DB.prepare(
      "UPDATE documents SET title = COALESCE(title, ''), updated_at = datetime('now') WHERE slug = ?",
    )
      .bind(slug)
      .run();

    // Persist the lifecycle state in DO SQLite so it survives reconnects
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS document_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    sql.exec(
      `INSERT OR REPLACE INTO document_meta (key, value) VALUES ('share_state', ?)`,
      newState,
    );

    // For revoke/delete, close all WebSocket connections
    if (newState === "REVOKED" || newState === "DELETED") {
      for (const ws of this.getWebSockets()) {
        try { ws.close(1000, `Document ${newState.toLowerCase()}`); } catch { /* ignore */ }
      }
    }

    return Response.json({
      success: true,
      slug,
      shareState: newState,
      updatedAt: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // Rewrite, ops, and presence handlers
  // ---------------------------------------------------------------------------

  /**
   * Full document rewrite — replaces the entire markdown content.
   */
  private async handleAgentRewrite(
    request: Request,
    slug: string,
  ): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const doc = this.ensureDoc();
    const markdownText = doc.getText("markdown");

    // Accept either `content` (full replacement) or `markdown` field
    const newContent = typeof body.content === "string"
      ? body.content
      : typeof body.markdown === "string"
        ? body.markdown
        : null;

    if (newContent === null) {
      return Response.json(
        { success: false, error: "content or markdown field required" },
        { status: 400 },
      );
    }

    // Check live client gate (unless force=true)
    const force = body.force === true;
    if (!force && this.getWebSockets().length > 0) {
      return Response.json(
        { success: false, error: "REWRITE_BLOCKED_BY_LIVE_CLIENTS", liveClients: this.getWebSockets().length },
        { status: 409 },
      );
    }

    // Apply rewrite to ProseMirror fragment
    let finalMarkdown: string;
    try {
      finalMarkdown = await applyMarkdownToYDoc(doc, newContent, "cf-agent-rewrite");
    } catch {
      const markdownText = doc.getText("markdown");
      doc.transact(() => {
        const oldLen = markdownText.length;
        if (oldLen > 0) markdownText.delete(0, oldLen);
        markdownText.insert(0, newContent);
      }, "cf-agent-rewrite");
      finalMarkdown = newContent;
    }

    return Response.json({
      success: true,
      revision: this.updateCount,
      markdown: finalMarkdown,
    });
  }

  /**
   * Ops meta-dispatcher — routes { type, payload } to marks/edit handlers.
   */
  private async handleAgentOps(
    request: Request,
    slug: string,
  ): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const opType = typeof body.type === "string" ? body.type : "";
    const payload = typeof body.payload === "object" && body.payload !== null
      ? body.payload as Record<string, unknown>
      : body;

    // Build a new request with the extracted payload so downstream handlers
    // can call request.json() without hitting an already-consumed body.
    const forwardRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(payload),
    });

    // Route to appropriate handler based on op type
    switch (opType) {
      case "comment.add":
        return this.handleMarksRoute(forwardRequest, slug, "comment");
      case "suggest.replace":
        return this.handleMarksRoute(forwardRequest, slug, "suggest-replace");
      case "suggest.insert":
        return this.handleMarksRoute(forwardRequest, slug, "suggest-insert");
      case "suggest.delete":
        return this.handleMarksRoute(forwardRequest, slug, "suggest-delete");
      case "suggest.accept":
        return this.handleMarksRoute(forwardRequest, slug, "accept");
      case "suggest.reject":
        return this.handleMarksRoute(forwardRequest, slug, "reject");
      case "comment.reply":
        return this.handleMarksRoute(forwardRequest, slug, "reply");
      case "comment.resolve":
        return this.handleMarksRoute(forwardRequest, slug, "resolve");
      case "comment.unresolve":
        return this.handleMarksRoute(forwardRequest, slug, "unresolve");
      case "rewrite":
        return this.handleAgentRewrite(forwardRequest, slug);
      default:
        return Response.json(
          { success: false, error: `Unknown operation type: ${opType}` },
          { status: 400 },
        );
    }
  }

  /**
   * Set agent presence in the document's awareness.
   */
  private handleAgentPresence(
    request: Request,
    slug: string,
  ): Response {
    const agentId = getAgentId(request);

    if (this.awareness) {
      this.awareness.setLocalStateField("agent", {
        id: agentId,
        status: "active",
        timestamp: Date.now(),
      });
    }

    return Response.json({ success: true });
  }

  /**
   * Remove agent presence from the document.
   */
  private handleAgentPresenceDisconnect(
    request: Request,
  ): Response {
    if (this.awareness) {
      this.awareness.setLocalStateField("agent", null);
    }

    return Response.json({ success: true });
  }

  // ---------------------------------------------------------------------------
  // Agent edit handlers (v1 + v2)
  // ---------------------------------------------------------------------------

  /**
   * Edit v1: text-level operations (append, replace, insert).
   * Uses agent-edit-ops.ts for string-level markdown manipulation.
   */
  private async handleAgentEdit(
    request: Request,
    slug: string,
  ): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const agentId = getAgentId(request);

    // Idempotency check
    const idempKey = getIdempotencyKey(request, body);
    if (idempKey) {
      const storage = this.ensureDocStorage(slug);
      const idemp = checkIdempotency(storage, slug, "edit", idempKey, false);
      if (idemp instanceof Response) return idemp;
      if (idemp.isReplay && idemp.cachedResponse) {
        return Response.json(idemp.cachedResponse);
      }
    }

    const doc = this.ensureDoc();
    const markdownText = doc.getText("markdown");
    const currentMarkdown = markdownText.toString();

    // Parse operations from body
    const rawOps = Array.isArray(body.operations) ? body.operations : [];
    const operations: AgentEditOperation[] = [];
    for (const raw of rawOps) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (r.op === "append" && typeof r.content === "string") {
        operations.push({ op: "append", section: typeof r.section === "string" ? r.section : "", content: r.content });
      } else if (r.op === "replace" && typeof r.search === "string" && typeof r.content === "string") {
        operations.push({ op: "replace", search: r.search, content: r.content });
      } else if (r.op === "insert" && typeof r.after === "string" && typeof r.content === "string") {
        operations.push({ op: "insert", after: r.after, content: r.content });
      }
    }

    if (operations.length === 0) {
      return Response.json(
        { success: false, error: "No valid operations provided" },
        { status: 400 },
      );
    }

    // Apply operations to stripped markdown
    const result = applyAgentEditOperations(currentMarkdown, operations, { by: agentId });

    if (!result.ok) {
      return Response.json(
        { success: false, error: result.message, code: result.code, opIndex: result.opIndex },
        { status: 409 },
      );
    }

    // Apply to the ProseMirror fragment so the browser editor sees the change
    let finalMarkdown: string;
    try {
      finalMarkdown = await applyMarkdownToYDoc(doc, result.markdown, "cf-agent-edit");
    } catch {
      // Fallback: write to Y.Text only
      doc.transact(() => {
        const oldLen = markdownText.length;
        if (oldLen > 0) markdownText.delete(0, oldLen);
        markdownText.insert(0, result.markdown);
      }, "cf-agent-edit");
      finalMarkdown = result.markdown;
    }

    const response = {
      success: true,
      revision: this.updateCount,
      markdown: stripProofSpanTags(finalMarkdown),
      idempotencyKey: idempKey ?? null,
      collab: {
        status: "converged",
        markdownStatus: "converged",
        fragmentStatus: "converged",
        canonicalStatus: "converged",
      },
    };

    if (idempKey) {
      const storage = this.ensureDocStorage(slug);
      storeIdempotencyResult(storage, slug, "edit", idempKey, response);
    }

    return Response.json(response);
  }

  /**
   * Edit v2: block-level operations.
   * Simplified DO-native implementation that works on markdown sections
   * rather than ProseMirror blocks. Supports replace_block, insert_after,
   * insert_before, delete_block, and find_replace_in_block.
   */
  private async handleAgentEditV2(
    request: Request,
    slug: string,
  ): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    // Idempotency check
    const idempKey = getIdempotencyKey(request, body);
    if (idempKey) {
      const storage = this.ensureDocStorage(slug);
      const idemp = checkIdempotency(storage, slug, "edit/v2", idempKey, false);
      if (idemp instanceof Response) return idemp;
      if (idemp.isReplay && idemp.cachedResponse) {
        return Response.json(idemp.cachedResponse);
      }
    }

    const doc = this.ensureDoc();
    const markdownText = doc.getText("markdown");
    const currentMarkdown = stripProofSpanTags(markdownText.toString());

    // Parse the markdown into blocks (split by double newline or heading boundaries)
    const blocks = splitMarkdownIntoBlocks(currentMarkdown);

    const rawOps = Array.isArray(body.operations) ? body.operations : [];

    // Apply operations sequentially
    let modifiedBlocks = [...blocks];
    for (const rawOp of rawOps) {
      if (typeof rawOp !== "object" || rawOp === null) continue;
      const op = rawOp as Record<string, unknown>;
      const opType = typeof op.op === "string" ? op.op : "";
      const ref = typeof op.ref === "string" ? op.ref : "";
      const refIdx = parseBlockRef(ref);

      switch (opType) {
        case "replace_block": {
          if (refIdx === null || refIdx >= modifiedBlocks.length) {
            return Response.json(
              { success: false, error: `Invalid block ref: ${ref}`, code: "INVALID_REF" },
              { status: 409 },
            );
          }
          const block = op.block as Record<string, unknown> | undefined;
          const newMarkdown = typeof block?.markdown === "string" ? block.markdown : "";
          modifiedBlocks[refIdx] = newMarkdown;
          break;
        }
        case "insert_after": {
          if (refIdx === null || refIdx >= modifiedBlocks.length) {
            return Response.json(
              { success: false, error: `Invalid block ref: ${ref}`, code: "INVALID_REF" },
              { status: 409 },
            );
          }
          const newBlocks = Array.isArray(op.blocks)
            ? (op.blocks as Array<Record<string, unknown>>).map(b => typeof b.markdown === "string" ? b.markdown : "")
            : [];
          modifiedBlocks.splice(refIdx + 1, 0, ...newBlocks);
          break;
        }
        case "insert_before": {
          if (refIdx === null || refIdx >= modifiedBlocks.length) {
            return Response.json(
              { success: false, error: `Invalid block ref: ${ref}`, code: "INVALID_REF" },
              { status: 409 },
            );
          }
          const newBlocks = Array.isArray(op.blocks)
            ? (op.blocks as Array<Record<string, unknown>>).map(b => typeof b.markdown === "string" ? b.markdown : "")
            : [];
          modifiedBlocks.splice(refIdx, 0, ...newBlocks);
          break;
        }
        case "delete_block": {
          if (refIdx === null || refIdx >= modifiedBlocks.length) {
            return Response.json(
              { success: false, error: `Invalid block ref: ${ref}`, code: "INVALID_REF" },
              { status: 409 },
            );
          }
          modifiedBlocks.splice(refIdx, 1);
          break;
        }
        case "find_replace_in_block": {
          if (refIdx === null || refIdx >= modifiedBlocks.length) {
            return Response.json(
              { success: false, error: `Invalid block ref: ${ref}`, code: "INVALID_REF" },
              { status: 409 },
            );
          }
          const find = typeof op.find === "string" ? op.find : "";
          const replace = typeof op.replace === "string" ? op.replace : "";
          const occurrence = op.occurrence === "all" ? "all" : "first";
          if (occurrence === "all") {
            modifiedBlocks[refIdx] = modifiedBlocks[refIdx].replaceAll(find, replace);
          } else {
            modifiedBlocks[refIdx] = modifiedBlocks[refIdx].replace(find, replace);
          }
          break;
        }
        case "replace_range": {
          const fromRef = typeof op.fromRef === "string" ? op.fromRef : "";
          const toRef = typeof op.toRef === "string" ? op.toRef : "";
          const fromIdx = parseBlockRef(fromRef);
          const toIdx = parseBlockRef(toRef);
          if (fromIdx === null || toIdx === null || fromIdx > toIdx || toIdx >= modifiedBlocks.length) {
            return Response.json(
              { success: false, error: `Invalid range refs: ${fromRef}-${toRef}`, code: "INVALID_REF" },
              { status: 409 },
            );
          }
          const newBlocks = Array.isArray(op.blocks)
            ? (op.blocks as Array<Record<string, unknown>>).map(b => typeof b.markdown === "string" ? b.markdown : "")
            : [];
          modifiedBlocks.splice(fromIdx, toIdx - fromIdx + 1, ...newBlocks);
          break;
        }
        default:
          return Response.json(
            { success: false, error: `Unknown operation: ${opType}` },
            { status: 400 },
          );
      }
    }

    // Reassemble markdown
    const newMarkdown = modifiedBlocks.join("\n\n") + "\n";

    // Apply to ProseMirror fragment so the browser editor sees the change
    let finalMarkdown: string;
    try {
      finalMarkdown = await applyMarkdownToYDoc(doc, newMarkdown, "cf-agent-edit-v2");
    } catch {
      doc.transact(() => {
        const oldLen = markdownText.length;
        if (oldLen > 0) markdownText.delete(0, oldLen);
        markdownText.insert(0, newMarkdown);
      }, "cf-agent-edit-v2");
      finalMarkdown = newMarkdown;
    }

    const response = {
      success: true,
      revision: this.updateCount,
      markdown: newMarkdown,
      idempotencyKey: idempKey ?? null,
      collab: {
        status: "converged",
        markdownStatus: "converged",
        fragmentStatus: "converged",
        canonicalStatus: "converged",
      },
    };

    if (idempKey) {
      const storage = this.ensureDocStorage(slug);
      storeIdempotencyResult(storage, slug, "edit/v2", idempKey, response);
    }

    return Response.json(response);
  }

  // ---------------------------------------------------------------------------
  // Marks CRUD handler
  // ---------------------------------------------------------------------------

  private async handleMarksRoute(
    request: Request,
    slug: string,
    markAction: string,
  ): Promise<Response> {
    const doc = this.ensureDoc();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const agentId = getAgentId(request);

    // Idempotency check
    const idempKey = getIdempotencyKey(request, body);
    if (idempKey) {
      const storage = this.ensureDocStorage(slug);
      const idemp = checkIdempotency(storage, slug, `marks/${markAction}`, idempKey, false);
      if (idemp instanceof Response) return idemp;
      if (idemp.isReplay && idemp.cachedResponse) {
        return Response.json(idemp.cachedResponse);
      }
    }

    let result: MarkOperationResult;

    switch (markAction) {
      case "comment":
        result = addComment(doc, {
          by: typeof body.by === "string" ? body.by : agentId,
          text: typeof body.text === "string" ? body.text : "",
          quote: typeof body.quote === "string" ? body.quote : (body.selector as any)?.quote,
        });
        break;

      case "suggest-replace":
        result = addSuggestion(doc, "replace", {
          by: typeof body.by === "string" ? body.by : agentId,
          quote: typeof body.quote === "string" ? body.quote : (body.selector as any)?.quote ?? "",
          content: typeof body.content === "string" ? body.content : undefined,
        });
        break;

      case "suggest-insert":
        result = addSuggestion(doc, "insert", {
          by: typeof body.by === "string" ? body.by : agentId,
          quote: typeof body.quote === "string" ? body.quote : (body.selector as any)?.quote ?? "",
          content: typeof body.content === "string" ? body.content : undefined,
        });
        break;

      case "suggest-delete":
        result = addSuggestion(doc, "delete", {
          by: typeof body.by === "string" ? body.by : agentId,
          quote: typeof body.quote === "string" ? body.quote : (body.selector as any)?.quote ?? "",
        });
        break;

      case "accept":
        result = acceptSuggestion(doc, {
          markId: typeof body.markId === "string" ? body.markId : typeof body.suggestionId === "string" ? body.suggestionId : "",
          by: typeof body.by === "string" ? body.by : agentId,
        });
        break;

      case "reject":
        result = rejectSuggestion(doc, {
          markId: typeof body.markId === "string" ? body.markId : typeof body.suggestionId === "string" ? body.suggestionId : "",
          by: typeof body.by === "string" ? body.by : agentId,
        });
        break;

      case "reply":
        result = replyComment(doc, {
          markId: typeof body.markId === "string" ? body.markId : typeof body.commentId === "string" ? body.commentId : "",
          by: typeof body.by === "string" ? body.by : agentId,
          text: typeof body.text === "string" ? body.text : "",
        });
        break;

      case "resolve":
        result = resolveComment(doc, {
          markId: typeof body.markId === "string" ? body.markId : typeof body.commentId === "string" ? body.commentId : "",
          by: typeof body.by === "string" ? body.by : agentId,
        });
        break;

      case "unresolve":
        result = unresolveComment(doc, {
          markId: typeof body.markId === "string" ? body.markId : typeof body.commentId === "string" ? body.commentId : "",
          by: typeof body.by === "string" ? body.by : agentId,
        });
        break;

      default:
        return Response.json(
          { error: "Unknown marks action", action: markAction },
          { status: 404 },
        );
    }

    // Handle errors
    if (!result.success) {
      return Response.json(
        { success: false, error: result.error, code: result.errorCode },
        { status: result.statusCode ?? 400 },
      );
    }

    // Emit event for agent polling
    if (result.eventType && result.eventData) {
      const storage = this.ensureDocStorage(slug);
      storage.addDocumentEvent(slug, result.eventType, result.eventData, agentId);
    }

    const response = {
      success: true,
      markId: result.markId,
      markdown: result.markdown,
      marks: result.marks,
      updatedAt: new Date().toISOString(),
    };

    // Store idempotency result
    if (idempKey) {
      const storage = this.ensureDocStorage(slug);
      storeIdempotencyResult(storage, slug, `marks/${markAction}`, idempKey, response);
    }

    return Response.json(response);
  }

  // ---------------------------------------------------------------------------
  // Hocuspocus-compatible WebSocket handling
  // ---------------------------------------------------------------------------

  private handleWebSocketUpgrade(url: URL): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept with hibernation API
    this.ctx.acceptWebSocket(server);

    // Ensure doc is loaded before any messages arrive
    this.ensureDoc();

    // Derive room name from the URL path (/ws/:slug) or query param (?slug=...).
    // HocuspocusProvider strips ?slug= from collabWsUrl so we use path-based routing.
    const pathMatch = url.pathname.match(/\/ws\/([^/]+)/);
    const slug = pathMatch
      ? decodeURIComponent(pathMatch[1])
      : url.searchParams.get("slug") ?? "unknown";
    this.roomName = slug;

    // Don't send anything yet — Hocuspocus protocol requires the client to
    // initiate with Auth + SyncStep1. The server responds to those messages.

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Get the room name for Hocuspocus message framing. */
  private getRoomName(): string {
    return this.roomName ?? "unknown";
  }

  /**
   * Create an encoder pre-filled with the Hocuspocus message header:
   * varString(documentName) + varUint(messageType)
   */
  private createHocuspocusEncoder(messageType: number): encoding.Encoder {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, this.getRoomName());
    encoding.writeVarUint(encoder, messageType);
    return encoder;
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Hocuspocus protocol uses binary messages
    if (typeof message === "string") return;

    const doc = this.ensureDoc();
    const data = new Uint8Array(message);
    const decoder = decoding.createDecoder(data);

    // Hocuspocus wire format: varString(documentName) + varUint(messageType) + payload
    const documentName = decoding.readVarString(decoder);
    const messageType = decoding.readVarUint(decoder);

    // Remember the room name from the first message if not yet set
    if (!this.roomName) {
      this.roomName = documentName;
    }

    switch (messageType) {
      case MessageType.Sync:
        this.handleSyncMessage(ws, decoder, doc);
        break;
      case MessageType.Awareness:
        this.handleAwarenessMessage(ws, decoder);
        break;
      case MessageType.Auth:
        this.handleAuthMessage(ws, decoder);
        break;
      case MessageType.QueryAwareness:
        this.handleQueryAwarenessMessage(ws);
        break;
      case MessageType.CLOSE:
        ws.close();
        break;
    }
  }

  /**
   * Handle Hocuspocus Auth message.
   * Always responds with Authenticated + read-write scope.
   */
  private handleAuthMessage(
    ws: WebSocket,
    decoder: decoding.Decoder,
  ): void {
    // Read the auth sub-type and token (we accept any token)
    const authType = decoding.readVarUint(decoder);
    if (authType === AuthMessageType.Token) {
      // Read and discard the token value
      decoding.readVarString(decoder);
    }

    // Respond with Authenticated
    const encoder = this.createHocuspocusEncoder(MessageType.Auth);
    encoding.writeVarUint(encoder, AuthMessageType.Authenticated);
    encoding.writeVarString(encoder, "read-write");
    ws.send(encoding.toUint8Array(encoder));
  }

  private handleSyncMessage(
    ws: WebSocket,
    decoder: decoding.Decoder,
    doc: Y.Doc,
  ): void {
    // Build a reply encoder with the Hocuspocus header
    const encoder = this.createHocuspocusEncoder(MessageType.Sync);

    // readSyncMessage applies the message and writes a response if needed.
    // Origin is set to the WebSocket so our doc.on('update') handler knows
    // which client sent the update.
    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      doc,
      ws,
    );

    // If readSyncMessage wrote a response (e.g. step 2 reply to step 1),
    // send it back to the requesting client
    if (encoding.length(encoder) > encodedHeaderLength(this.getRoomName(), MessageType.Sync)) {
      ws.send(encoding.toUint8Array(encoder));
    }

    // After responding to SyncStep1 with SyncStep2, send a plain Sync/SyncStep1.
    // HocuspocusProvider answers that follow-up with SyncStep2, which lets the
    // server send SyncStatus and clear the client's initial unsynced counter.
    if (syncMessageType === 0) {
      ws.send(createSyncStep1Message(this.getRoomName(), doc));
    }

    // Send SyncStatus acknowledgment for step 2 and update messages
    if (syncMessageType === 1 || syncMessageType === 2) {
      const statusEncoder = this.createHocuspocusEncoder(MessageType.SyncStatus);
      encoding.writeVarUint(statusEncoder, 1); // 1 = success
      ws.send(encoding.toUint8Array(statusEncoder));
    }
  }

  private handleAwarenessMessage(
    ws: WebSocket,
    decoder: decoding.Decoder,
  ): void {
    if (!this.awareness) return;

    const update = decoding.readVarUint8Array(decoder);

    // Track which awareness client IDs this socket controls before applying,
    // by decoding the update's client IDs from the wire format.
    const clientIds = decodeAwarenessClientIds(update);
    if (clientIds.length > 0) {
      const existing = this.socketAwarenessClients.get(ws) ?? new Set();
      for (const id of clientIds) existing.add(id);
      this.socketAwarenessClients.set(ws, existing);
    }

    awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);

    // Broadcast awareness to all other connected clients (don't persist)
    const sockets = this.getWebSockets();
    for (const socket of sockets) {
      if (socket !== ws && socket.readyState === WebSocket.READY_STATE_OPEN) {
        const encoder = this.createHocuspocusEncoder(MessageType.Awareness);
        encoding.writeVarUint8Array(encoder, update);
        socket.send(encoding.toUint8Array(encoder));
      }
    }
  }

  private handleQueryAwarenessMessage(ws: WebSocket): void {
    if (!this.awareness) return;

    const states = this.awareness.getStates();
    if (states.size === 0) return;

    const encoder = this.createHocuspocusEncoder(MessageType.Awareness);
    const clients = Array.from(states.keys());
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    );
    ws.send(encoding.toUint8Array(encoder));
  }

  /**
   * Persist an incremental Y.Doc update to SQLite.
   * Triggers compaction when the update count exceeds the threshold.
   */
  private persistUpdate(update: Uint8Array): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO yjs_updates (update_data) VALUES (?)",
      update as unknown as ArrayBuffer,
    );
    this.updateCount++;
    if (this.roomName) {
      void this.touchDocumentMetadata(this.roomName);
    }

    if (this.updateCount >= COMPACTION_THRESHOLD) {
      this.compact();
    }
  }

  private async touchDocumentMetadata(slug: string): Promise<void> {
    await this.env.CATALOG_DB.prepare(
      "UPDATE documents SET updated_at = datetime('now') WHERE slug = ?",
    )
      .bind(slug)
      .run();
  }

  /**
   * Broadcast an update to all connected WebSocket clients except the origin.
   * Uses Hocuspocus framing: varString(documentName) + varUint(Sync) + update.
   */
  private broadcastUpdate(update: Uint8Array, origin: WebSocket): void {
    const encoder = this.createHocuspocusEncoder(MessageType.Sync);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);

    const sockets = this.getWebSockets();
    for (const socket of sockets) {
      if (socket !== origin && socket.readyState === WebSocket.READY_STATE_OPEN) {
        socket.send(message);
      }
    }
  }

  /**
   * Compact all incremental updates into a single snapshot.
   * This reduces SQLite row count and speeds up future doc loads.
   */
  private compact(): void {
    if (!this.doc) return;

    const sql = this.ctx.storage.sql;
    const snapshot = Y.encodeStateAsUpdate(this.doc);

    // Replace snapshot and clear incremental updates in one transaction
    sql.exec(
      `INSERT OR REPLACE INTO document_state (key, value, updated_at)
       VALUES ('yjs_snapshot', ?, datetime('now'))`,
      snapshot as unknown as ArrayBuffer,
    );
    sql.exec("DELETE FROM yjs_updates");
    this.updateCount = 0;
  }

  /**
   * Get all hibernated WebSocket connections managed by this DO.
   */
  private getWebSockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  private async handleContentRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const doc = this.ensureDoc();
      let content: string | null = null;
      try {
        const projection = await deriveMarkdownFromYDoc(doc);
        content = projection.markdown;
      } catch {
        // Fall back to raw Y.Text if ProseMirror projection fails
        content = doc.getText("markdown").toString() || null;
      }

      return Response.json({ content });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  /**
   * Returns the current Y.Doc state as a base64-encoded binary snapshot.
   */
  private handleSnapshotRequest(): Response {
    const doc = this.ensureDoc();
    const stateUpdate = Y.encodeStateAsUpdate(doc);

    // Convert to base64 for JSON transport
    const base64 = uint8ArrayToBase64(stateUpdate);

    return new Response(
      JSON.stringify({
        snapshot: base64,
        clientCount: this.getWebSockets().length,
        updateCount: this.updateCount,
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Remove awareness states for the disconnecting client's tracked IDs
    if (this.awareness) {
      const clientIds = this.socketAwarenessClients.get(ws);
      if (clientIds && clientIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(
          this.awareness,
          Array.from(clientIds),
          "websocket close",
        );
      }
      this.socketAwarenessClients.delete(ws);
    }

    ws.close();

    // If no clients remain, schedule cleanup alarm
    if (this.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();

    if (this.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_DELAY_MS);
    }
  }

  /**
   * Alarm handler for periodic maintenance.
   * When all clients have disconnected, compact and release the Y.Doc from memory.
   */
  async alarm(): Promise<void> {
    // If clients reconnected before the alarm fired, skip cleanup
    if (this.getWebSockets().length > 0) return;

    // Compact before releasing memory
    if (this.doc) {
      this.compact();
    }

    // Release Y.Doc and awareness from memory — they'll be rehydrated on
    // next connection
    if (this.awareness) {
      this.awareness.destroy();
      this.awareness = null;
    }
    if (this.doc) {
      this.doc.destroy();
      this.doc = null;
    }
    this.roomName = null;
  }
}

/**
 * Calculate the encoded byte length of a Hocuspocus message header
 * (varString(documentName) + varUint(messageType)).
 * Used to detect whether readSyncMessage wrote any reply payload.
 */
function encodedHeaderLength(documentName: string, messageType: number): number {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, messageType);
  return encoding.length(encoder);
}

function createSyncStep1Message(documentName: string, doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/**
 * Decode awareness client IDs from a y-protocols awareness update.
 * Wire format: varUint(count), then for each entry: varUint(clientID) + varUint(clock) + varString(state).
 */
function decodeAwarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder); // clock
    decoding.readVarString(decoder); // state JSON
  }
  return ids;
}

/**
 * Encode a Uint8Array as a base64 string.
 * Uses btoa which is available in the Workers runtime.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Split markdown into logical blocks (headings, paragraphs, lists, code blocks).
 * Each block is the raw markdown text. Blocks are separated by blank lines.
 */
function splitMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown.trim()) return [];

  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Track code fences
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      current.push(line);
      continue;
    }

    if (inCodeBlock) {
      current.push(line);
      continue;
    }

    // Blank line separates blocks
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }

    // Heading starts a new block
    if (/^#{1,6}\s/.test(trimmed) && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [line];
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }

  return blocks;
}

/**
 * Parse a block ref like "b1", "b2" into a 0-based index.
 * Returns null if invalid.
 */
function parseBlockRef(ref: string): number | null {
  const match = ref.match(/^b(\d+)$/);
  if (!match) return null;
  const idx = Number.parseInt(match[1], 10) - 1; // b1 → index 0
  return idx >= 0 ? idx : null;
}

/**
 * Determine the minimum required role for an agent route.
 */
function getRequiredRole(subPath: string, method: string): "viewer" | "commenter" | "editor" | "owner_bot" {
  // Read-only routes
  if (method === "GET") return "viewer";

  // Comment/suggestion creation
  if (subPath === "marks/comment" || subPath.startsWith("marks/suggest")) return "commenter";
  if (subPath === "marks/reply") return "commenter";

  // Resolve/unresolve — viewer can resolve own
  if (subPath === "marks/resolve" || subPath === "marks/unresolve") return "viewer";

  // Accept/reject, edit, rewrite, ops
  if (subPath === "marks/accept" || subPath === "marks/reject") return "editor";
  if (subPath === "edit" || subPath === "edit/v2") return "editor";
  if (subPath === "rewrite") return "editor";
  if (subPath === "ops") return "editor";
  if (subPath === "presence" || subPath === "presence/disconnect") return "editor";

  // Admin operations
  if (subPath === "repair" || subPath === "clone-from-canonical") return "owner_bot";

  // Events
  if (subPath === "events/ack") return "editor";

  return "viewer";
}
