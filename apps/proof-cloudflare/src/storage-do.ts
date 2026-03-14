/**
 * Durable Object SQLite implementation of DocumentStorage.
 *
 * Each DO instance is scoped to a single document slug. The slug parameter on
 * interface methods is validated but the actual queries always target the
 * single-document tables owned by this DO.
 *
 * Tables are created lazily on first access. SQL syntax targets the standard
 * SQLite dialect available in Cloudflare DO `ctx.storage.sql`.
 */

import type {
  DocumentStorage,
  StorageDocumentEventRow,
  StorageDocumentRow,
  StorageIdempotencyRecord,
} from './storage-interface.js';
import type { DocumentEventType } from './event-types.js';
import type { ShareRole, ShareState } from './share-types.js';

const DEFAULT_EVENT_PAGE_SIZE = 100;

/**
 * Options for constructing a DODocumentStorage instance.
 */
interface DODocumentStorageOptions {
  /** The DurableObjectState providing `storage.sql`. */
  ctx: DurableObjectState;
  /** The document slug this DO instance manages. */
  slug: string;
}

export class DODocumentStorage implements DocumentStorage {
  private readonly sql: SqlStorage;
  private readonly slug: string;
  // Tables are created in DocumentSession.initStorage() at DO construction time.
  // Set to true by default since we can rely on them existing.
  private tablesInitialized = true;

  constructor(options: DODocumentStorageOptions) {
    this.sql = options.ctx.storage.sql;
    this.slug = options.slug;
  }

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  private ensureTables(): void {
    if (this.tablesInitialized) return;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        slug TEXT PRIMARY KEY,
        doc_id TEXT,
        title TEXT,
        markdown TEXT NOT NULL DEFAULT '',
        marks TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 0,
        y_state_version INTEGER NOT NULL DEFAULT 0,
        share_state TEXT NOT NULL DEFAULT 'ACTIVE',
        access_epoch INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS document_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_slug TEXT NOT NULL,
        document_revision INTEGER,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL DEFAULT '{}',
        actor TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        acked_by TEXT,
        acked_at TEXT
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mutation_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_slug TEXT NOT NULL,
        document_revision INTEGER,
        event_id INTEGER,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL DEFAULT '{}',
        actor TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_key TEXT NOT NULL,
        document_slug TEXT NOT NULL,
        route TEXT NOT NULL,
        response_json TEXT NOT NULL,
        request_hash TEXT,
        status_code INTEGER NOT NULL DEFAULT 200,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (idempotency_key, document_slug, route)
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS document_access (
        token_id TEXT PRIMARY KEY,
        document_slug TEXT NOT NULL,
        role TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT
      )
    `);

    this.tablesInitialized = true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private assertSlug(slug: string): void {
    if (slug !== this.slug) {
      throw new Error(
        `DODocumentStorage slug mismatch: expected "${this.slug}", got "${slug}"`,
      );
    }
  }

  private getDocumentRevision(): number | null {
    this.ensureTables();
    const rows = this.sql
      .exec('SELECT revision FROM documents WHERE slug = ? LIMIT 1', this.slug)
      .toArray();
    if (rows.length === 0) return null;
    const rev = rows[0]['revision'];
    return typeof rev === 'number' ? rev : null;
  }

  private now(): string {
    return new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // DocumentStorage implementation
  // -------------------------------------------------------------------------

  getDocumentBySlug(slug: string): StorageDocumentRow | undefined {
    this.assertSlug(slug);
    this.ensureTables();
    const rows = this.sql
      .exec('SELECT * FROM documents WHERE slug = ? LIMIT 1', this.slug)
      .toArray();
    if (rows.length === 0) return undefined;
    return rows[0] as unknown as StorageDocumentRow;
  }

  updateDocument(
    slug: string,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean {
    this.assertSlug(slug);
    this.ensureTables();
    const ts = this.now();
    if (marks !== undefined) {
      this.sql.exec(
        `UPDATE documents
         SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
         WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
        markdown,
        JSON.stringify(marks),
        ts,
        this.slug,
      );
    } else {
      this.sql.exec(
        `UPDATE documents
         SET markdown = ?, updated_at = ?, revision = revision + 1
         WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
        markdown,
        ts,
        this.slug,
      );
    }
    // DO SQLite sql.exec doesn't return changes count directly;
    // verify by re-reading the updated_at timestamp
    const doc = this.getDocumentBySlug(slug);
    return doc !== undefined && doc.updated_at === ts;
  }

  updateDocumentAtomic(
    slug: string,
    expectedUpdatedAt: string,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean {
    this.assertSlug(slug);
    this.ensureTables();
    const ts = this.now();
    if (marks !== undefined) {
      this.sql.exec(
        `UPDATE documents
         SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
         WHERE slug = ? AND updated_at = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
        markdown,
        JSON.stringify(marks),
        ts,
        this.slug,
        expectedUpdatedAt,
      );
    } else {
      this.sql.exec(
        `UPDATE documents
         SET markdown = ?, updated_at = ?, revision = revision + 1
         WHERE slug = ? AND updated_at = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
        markdown,
        ts,
        this.slug,
        expectedUpdatedAt,
      );
    }
    const doc = this.getDocumentBySlug(slug);
    return doc !== undefined && doc.updated_at === ts;
  }

  updateDocumentAtomicByRevision(
    slug: string,
    expectedRevision: number,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean {
    this.assertSlug(slug);
    this.ensureTables();
    const ts = this.now();
    if (marks !== undefined) {
      this.sql.exec(
        `UPDATE documents
         SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
         WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
        markdown,
        JSON.stringify(marks),
        ts,
        this.slug,
        expectedRevision,
      );
    } else {
      this.sql.exec(
        `UPDATE documents
         SET markdown = ?, updated_at = ?, revision = revision + 1
         WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
        markdown,
        ts,
        this.slug,
        expectedRevision,
      );
    }
    const doc = this.getDocumentBySlug(slug);
    return doc !== undefined && doc.updated_at === ts;
  }

  getMarks(slug: string): string | null {
    this.assertSlug(slug);
    const doc = this.getDocumentBySlug(slug);
    if (!doc) return null;
    return doc.marks;
  }

  setMarks(slug: string, marks: Record<string, unknown>): boolean {
    this.assertSlug(slug);
    this.ensureTables();
    const ts = this.now();
    this.sql.exec(
      `UPDATE documents
       SET marks = ?, updated_at = ?
       WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')`,
      JSON.stringify(marks),
      ts,
      this.slug,
    );
    const doc = this.getDocumentBySlug(slug);
    return doc !== undefined && doc.updated_at === ts;
  }

  addDocumentEvent(
    slug: string,
    eventType: DocumentEventType,
    eventData: unknown,
    actor: string,
    idempotencyKey?: string,
  ): number {
    this.assertSlug(slug);
    this.ensureTables();
    const ts = this.now();
    const payload = JSON.stringify(eventData);
    const documentRevision = this.getDocumentRevision();

    this.sql.exec(
      `INSERT INTO document_events
         (document_slug, document_revision, event_type, event_data, actor, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      this.slug,
      documentRevision,
      eventType,
      payload,
      actor,
      idempotencyKey ?? null,
      ts,
    );

    // Retrieve the auto-increment id of the inserted event
    const eventRows = this.sql
      .exec(
        'SELECT id FROM document_events WHERE document_slug = ? ORDER BY id DESC LIMIT 1',
        this.slug,
      )
      .toArray();
    const eventId = eventRows.length > 0 ? (eventRows[0]['id'] as number) : 0;

    this.sql.exec(
      `INSERT INTO mutation_outbox
         (document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      this.slug,
      documentRevision,
      eventId,
      eventType,
      payload,
      actor,
      idempotencyKey ?? null,
      ts,
    );

    return eventId;
  }

  addEvent(
    slug: string,
    eventType: DocumentEventType,
    eventData: unknown,
    actor: string,
  ): void {
    this.assertSlug(slug);
    // In the DO context there is no separate global `events` table.
    // Delegate to addDocumentEvent which writes to document_events + outbox.
    this.addDocumentEvent(slug, eventType, eventData, actor);
  }

  listDocumentEvents(
    slug: string,
    afterId: number,
    limit: number = DEFAULT_EVENT_PAGE_SIZE,
  ): StorageDocumentEventRow[] {
    this.assertSlug(slug);
    this.ensureTables();
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.sql
      .exec(
        `SELECT * FROM document_events
         WHERE document_slug = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
        this.slug,
        afterId,
        safeLimit,
      )
      .toArray();
    return rows as unknown as StorageDocumentEventRow[];
  }

  ackDocumentEvents(slug: string, upToId: number, ackedBy: string): number {
    this.assertSlug(slug);
    this.ensureTables();
    const ts = this.now();
    // Count matching rows before update since DO sql.exec doesn't return changes
    const beforeRows = this.sql
      .exec(
        `SELECT COUNT(*) AS cnt FROM document_events
         WHERE document_slug = ? AND id <= ? AND acked_at IS NULL`,
        this.slug,
        upToId,
      )
      .toArray();
    const count = (beforeRows[0]?.['cnt'] as number) ?? 0;

    if (count > 0) {
      this.sql.exec(
        `UPDATE document_events
         SET acked_by = ?, acked_at = ?
         WHERE document_slug = ? AND id <= ? AND acked_at IS NULL`,
        ackedBy,
        ts,
        this.slug,
        upToId,
      );
    }

    return count;
  }

  getStoredIdempotencyRecord(
    documentSlug: string,
    route: string,
    idempotencyKey: string,
  ): StorageIdempotencyRecord | null {
    this.assertSlug(documentSlug);
    this.ensureTables();
    const rows = this.sql
      .exec(
        `SELECT response_json, request_hash
         FROM idempotency_keys
         WHERE idempotency_key = ? AND document_slug = ? AND route = ?
         LIMIT 1`,
        idempotencyKey,
        documentSlug,
        route,
      )
      .toArray();

    if (rows.length === 0) return null;
    const row = rows[0];
    const responseJson = row['response_json'];
    if (typeof responseJson !== 'string') return null;

    try {
      const response = JSON.parse(responseJson) as Record<string, unknown>;
      const requestHash = row['request_hash'];
      return {
        response,
        requestHash: typeof requestHash === 'string' ? requestHash : null,
      };
    } catch {
      return null;
    }
  }

  storeIdempotencyResult(
    documentSlug: string,
    route: string,
    idempotencyKey: string,
    response: Record<string, unknown>,
    requestHash?: string | null,
    options?: { statusCode?: number; tombstoneRevision?: number | null },
  ): void {
    this.assertSlug(documentSlug);
    this.ensureTables();
    const ts = this.now();
    const statusCode = Number.isInteger(options?.statusCode)
      ? Number(options?.statusCode)
      : 200;
    const encoded = JSON.stringify(response);

    this.sql.exec(
      `INSERT OR REPLACE INTO idempotency_keys
         (idempotency_key, document_slug, route, response_json, request_hash, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      idempotencyKey,
      documentSlug,
      route,
      encoded,
      requestHash ?? null,
      statusCode,
      ts,
    );
  }

  resolveDocumentAccessRole(
    slug: string,
    presentedSecret: string,
  ): ShareRole | null {
    this.assertSlug(slug);
    this.ensureTables();

    // Access resolution requires comparing hashed secrets. The DO sql API is
    // synchronous so we cannot use the async Web Crypto digest here. Instead,
    // the caller is expected to pre-hash the secret before calling this method,
    // or the tokens should be stored with a hash that can be compared directly.
    //
    // For now we do a direct comparison of the presented value against the
    // stored secret_hash column. A full production integration would hash the
    // presented secret before comparison (e.g., via an async wrapper around
    // this method).

    const rows = this.sql
      .exec(
        `SELECT role, secret_hash FROM document_access
         WHERE document_slug = ? AND revoked_at IS NULL`,
        this.slug,
      )
      .toArray();

    for (const row of rows) {
      const storedHash = row['secret_hash'];
      const role = row['role'];
      if (typeof storedHash === 'string' && typeof role === 'string') {
        if (storedHash === presentedSecret) {
          return role as ShareRole;
        }
      }
    }

    return null;
  }
}
