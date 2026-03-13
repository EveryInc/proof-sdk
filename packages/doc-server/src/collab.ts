import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Server as HttpServer } from 'http';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { type Node as ProseMirrorNode, type Schema } from '@milkdown/prose/model';
import {
  appendYUpdate,
  clearYjsState,
  getDocumentAuthStateBySlug,
  getDocumentBySlug,
  getProjectedDocumentBySlug,
  getDb,
  getLatestYUpdate,
  getLatestYStateVersion,
  getLatestYSnapshot,
  getYUpdatesAfter,
  listDocsWithStaleProjection,
  listSuspiciousProjectionCandidates,
  noteDocumentLiveCollabLease,
  replaceDocumentProjection,
  saveYSnapshot,
  setDocumentProjectionHealth,
  removeActiveCollabConnection,
  upsertActiveCollabConnection,
  updateDocument,
  type DocumentProjectionRow,
  type DocumentRow,
  type ProjectedDocumentRow,
} from '../../../server/db.js';
import {
  recordCollabLogSuppressed,
  recordProjectionChars,
  recordProjectionDrift,
  recordProjectionGuardBlock,
  recordProjectionLag,
  recordProjectionMarkedStale,
  recordProjectionRepair,
  recordProjectionReadFallback,
  recordProjectionWipe,
} from '../../../server/metrics.js';
import { canonicalizeStoredMarks, type StoredMark } from '@proof/core/marks';
import { refreshSnapshotForSlug } from '../../../server/snapshot.js';
import { isShareRole, type ShareRole, type ShareState } from './share-types.js';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeMarkdown,
  summarizeParseError,
} from '../../../server/milkdown-headless.js';
import { normalizeAgentScopedId } from '@proof/core/agent-identity';

type HocuspocusInstance = {
  listen?: () => void | Promise<void>;
  destroy?: () => void | Promise<void>;
  handleConnection?: (socket: unknown, request: unknown) => void;
  // Available in @hocuspocus/server 2.x (Proof uses 2.15.x).
  openDirectConnection?: (documentName: string, context?: unknown) => Promise<unknown>;
};

export interface CollabSessionInfo {
  docId: string;
  slug: string;
  role: ShareRole;
  shareState: ShareState;
  accessEpoch: number;
  syncProtocol: 'pm-yjs-v1';
  collabWsUrl: string;
  token: string;
  snapshotVersion: number;
  expiresAt: string;
}

export interface CollabRuntime {
  enabled: boolean;
  wsUrlBase: string;
  reason?: string;
}

let runtime: CollabRuntime = {
  enabled: false,
  wsUrlBase: '',
  reason: 'Collab runtime not initialized',
};

export function createCollabRuntime(): CollabRuntime {
  return getCollabRuntime();
}

let hocuspocusInstance: HocuspocusInstance | null = null;
let collabWss: import('ws').WebSocketServer | null = null;
let collabUpgradeHandler: ((req: any, socket: any, head: any) => void) | null = null;
let collabUpgradeServer: HttpServer | null = null;
const loadedDocs = new Map<string, Y.Doc>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const persistInFlight = new Map<string, boolean>();
const persistPending = new Map<string, { ydoc: Y.Doc; sourceActor: string; expectedGeneration: number | null }>();
const persistGeneration = new Map<string, number>();
const docPersistGenerations = new WeakMap<Y.Doc, number>();
type FragmentEditState = { dirty: boolean };
const fragmentEditStateByDoc = new WeakMap<Y.Doc, FragmentEditState>();
const fragmentEditListenerAttached = new WeakSet<Y.Doc>();
const durablePersistListenerAttached = new WeakSet<Y.Doc>();
const FRAGMENT_REPAIR_ORIGINS = new Set(['server-fragment-repair', 'persisted-fragment-repair']);
const lastPersistedStateVectors = new Map<string, Uint8Array>();
const updatesSinceCompaction = new Map<string, number>();
const docLastAccessedAt = new Map<string, number>();
const docLastChangedAt = new Map<string, number>();
const lastProjectionLengths = new Map<string, number>();
type LoadedDocDbMeta = {
  updatedAt: string | null;
  yStateVersion: number;
  accessEpoch: number | null;
  baselineStateVector: Uint8Array;
};
const loadedDocDbMeta = new Map<string, LoadedDocDbMeta>();
// The loaded Yjs doc is the authoritative live state. Canonical markdown/marks in the
// DB are derived from that state and must never be allowed to overwrite a newer live
// Yjs document during active collaboration.
// When canonical state changes outside collab (PUT markdown, agent ops), we need to
// drop the in-memory Y.Doc and ensure no stale onStoreDocument write sneaks in.
const collabInvalidations = new Set<string>();
const skipOnStoreStateVectors = new Map<string, Uint8Array>();
const DEFAULT_COLLAB_SESSION_TTL_SECONDS = 5 * 60;
const DEFAULT_COLLAB_PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_COLLAB_COMPACTION_EVERY = 100;
const DEFAULT_MAX_LOADED_DOCS = 100;
const DEFAULT_DOC_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_DOC_EVICTION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DIRECT_CONNECTION_TIMEOUT_MS = 5 * 1000;
const DEFAULT_AGENT_PRESENCE_TTL_MS = 60 * 1000;
const DEFAULT_AGENT_CURSOR_TTL_MS = 3 * 1000;
const DEFAULT_INVALIDATION_COOLDOWN_MS = 1000;
const DEFAULT_STARTUP_STALE_PROJECTION_RECONCILE_ENABLED = false;
const DEFAULT_STARTUP_STALE_PROJECTION_RECONCILE_DELAY_MS = 30_000;
const DEFAULT_STARTUP_STALE_PROJECTION_RECONCILE_LIMIT = 25;
const DEFAULT_PROJECTION_GUARD_MAX_CHARS = 1_500_000;
const DEFAULT_PROJECTION_GUARD_MAX_GROWTH_MULTIPLIER = 8;
const DEFAULT_PROJECTION_GUARD_MAX_LENGTH_DRIFT_RATIO = 0.6;
const DEFAULT_PROJECTION_GUARD_MIN_TOKEN_OVERLAP = 0.3;
const DEFAULT_PATHOLOGICAL_REPEAT_MIN_REPEATS = 3;
const DEFAULT_PATHOLOGICAL_REPEAT_MIN_BASE_CHARS = 512;
const DEFAULT_PROJECTION_PATHOLOGY_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_STALE_ONSTORE_DRIFT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_WS_OVERSIZE_LOG_COOLDOWN_MS = 60 * 1000;
const DEFAULT_PROJECTION_REPAIR_RETRY_SCHEDULE_MS = [0, 500, 2_000];
const DEFAULT_PROJECTION_REPAIR_WORKER_ENABLED = true;
const DEFAULT_PROJECTION_REPAIR_WORKER_DELAY_MS = 45_000;
const DEFAULT_PROJECTION_REPAIR_WORKER_INTERVAL_MS = 120_000;
const DEFAULT_PROJECTION_REPAIR_WORKER_LIMIT = 10;
const DEFAULT_PROJECTION_REPAIR_WORKER_MIN_CHARS = 500_000;
const DEFAULT_PROJECTION_REPAIR_WORKER_OVERSIZED_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS = 15_000;
const warnedReadOnlyPersistSlugs = new Set<string>();
const agentPresenceExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const agentCursorExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const collabInvalidationReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const staleEpochWriteWarnings = new Map<string, number>();
const projectionRepairScheduled = new Map<string, ReturnType<typeof setTimeout>>();
const projectionRepairRunning = new Set<string>();
const projectionRepairRetryIndex = new Map<string, number>();
const projectionRepairReasons = new Map<string, Set<string>>();
type PathologyCooldownEntry = {
  fingerprint: string;
  reason: string;
  untilMs: number;
  suppressedCount: number;
};
const projectionPathologyCooldowns = new Map<string, PathologyCooldownEntry>();
const staleOnStoreDriftCooldowns = new Map<string, PathologyCooldownEntry>();
const collabWsOversizeCooldowns = new Map<string, PathologyCooldownEntry>();
const authenticatedCollabLeaseHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
let projectionRepairWorkerTimer: ReturnType<typeof setTimeout> | null = null;
let projectionRepairWorkerGeneration = 0;
let startupProjectionReconcileTimer: ReturnType<typeof setTimeout> | null = null;
const projectionRepairWorkerOversizedSeen = new Map<string, { fingerprint: string; queuedAt: number }>();

// Guard: while a force-rewrite is in flight (or cooling down), block all client-originated
// onChange / onStoreDocument persistence so stale client state can't overwrite the rewrite.
const rewriteLockSlugs = new Map<string, ReturnType<typeof setTimeout>>();
const REWRITE_LOCK_COOLDOWN_MS = 5_000; // keep lock for 5s after rewrite completes

export function acquireRewriteLock(slug: string): void {
  const existing = rewriteLockSlugs.get(slug);
  if (existing) clearTimeout(existing);
  rewriteLockSlugs.set(slug, setTimeout(() => rewriteLockSlugs.delete(slug), REWRITE_LOCK_COOLDOWN_MS));
  console.log('[collab] rewrite lock acquired', { slug });
}

export function releaseRewriteLock(_slug: string): void {
  // Don't release immediately — keep the cooldown to guard against late reconnects.
  // The timeout set in acquireRewriteLock will auto-release.
}

function isRewriteLocked(slug: string): boolean {
  return rewriteLockSlugs.has(slug);
}
const collabSigningSecret = (process.env.PROOF_COLLAB_SIGNING_SECRET || '').trim()
  || randomBytes(32).toString('hex');
let warnedAboutEphemeralCollabSecret = false;
const debugOnConnect = (process.env.COLLAB_DEBUG_ONCONNECT || '').trim() === '1';
const DEFAULT_PENDING_DELTA_SNIPPET_CHARS = 160;
const recentCollabSessionLeases = new Map<string, number>();
const ACTIVE_COLLAB_INSTANCE_ID = (
  process.env.RAILWAY_REPLICA_ID
  || process.env.RAILWAY_DEPLOYMENT_ID
  || process.env.HOSTNAME
  || `pid-${process.pid}-${randomUUID()}`
).trim();

export type AgentPresenceEntry = {
  id: string;
  name?: string;
  color?: string;
  avatar?: string;
  status?: string;
  details?: string;
  at?: string;
};

export type AgentCursorHint = {
  id: string;
  quote?: string;
  ttlMs?: number;
  at?: string;
  name?: string;
  color?: string;
  avatar?: string;
};

function agentTimerKey(slug: string, agentId: string): string {
  return `${slug}::${agentId}`;
}

function pruneExpiredAgentEphemera(slug: string, doc: Y.Doc): void {
  const now = Date.now();
  const presenceTtlMs = parsePositiveInt(process.env.AGENT_PRESENCE_TTL_MS, DEFAULT_AGENT_PRESENCE_TTL_MS);
  const cursorDefaultTtlMs = parsePositiveInt(process.env.AGENT_CURSOR_TTL_MS, DEFAULT_AGENT_CURSOR_TTL_MS);
  const removedPresenceIds = new Set<string>();
  const removedCursorIds = new Set<string>();

  try {
    doc.transact(() => {
      const presenceMap = doc.getMap<unknown>('agentPresence');
      for (const key of Array.from(presenceMap.keys())) {
        const value = presenceMap.get(key) as any;
        const normalizedKey = normalizeAgentScopedId(key);
        const normalizedValueId = normalizeAgentScopedId(value?.id);
        if (!normalizedKey || !normalizedValueId || normalizedKey !== normalizedValueId) {
          presenceMap.delete(key);
          if (typeof key === 'string' && key.trim()) removedPresenceIds.add(key.trim());
          if (typeof value?.id === 'string' && value.id.trim()) removedPresenceIds.add(value.id.trim());
          continue;
        }
        const atRaw = value?.at;
        const atMs = typeof atRaw === 'string' ? Date.parse(atRaw) : Number.NaN;
        if (!Number.isFinite(atMs)) continue;
        if (now - atMs > presenceTtlMs) {
          presenceMap.delete(key);
          removedPresenceIds.add(normalizedKey);
        }
      }

      const cursorMap = doc.getMap<unknown>('agentCursors');
      for (const key of Array.from(cursorMap.keys())) {
        const value = cursorMap.get(key) as any;
        const normalizedKey = normalizeAgentScopedId(key);
        const normalizedValueId = normalizeAgentScopedId(value?.id);
        if (!normalizedKey || !normalizedValueId || normalizedKey !== normalizedValueId || removedPresenceIds.has(normalizedKey)) {
          cursorMap.delete(key);
          if (typeof key === 'string' && key.trim()) removedCursorIds.add(key.trim());
          if (typeof value?.id === 'string' && value.id.trim()) removedCursorIds.add(value.id.trim());
          continue;
        }
        const atRaw = value?.at;
        const ttlMs = typeof value?.ttlMs === 'number' && Number.isFinite(value.ttlMs) && value.ttlMs > 0
          ? value.ttlMs
          : cursorDefaultTtlMs;
        const atMs = typeof atRaw === 'string' ? Date.parse(atRaw) : Number.NaN;
        if (!Number.isFinite(atMs)) {
          cursorMap.delete(key);
          removedCursorIds.add(normalizedKey);
          continue;
        }
        if (now - atMs > ttlMs) {
          cursorMap.delete(key);
          removedCursorIds.add(normalizedKey);
        }
      }
    }, 'agent-ephemera-prune');
  } catch {
    // ignore
  }

  for (const agentId of removedPresenceIds) {
    const timer = agentPresenceExpiryTimers.get(agentTimerKey(slug, agentId));
    if (!timer) continue;
    clearTimeout(timer);
    agentPresenceExpiryTimers.delete(agentTimerKey(slug, agentId));
  }
  for (const agentId of removedCursorIds) {
    const timer = agentCursorExpiryTimers.get(agentTimerKey(slug, agentId));
    if (!timer) continue;
    clearTimeout(timer);
    agentCursorExpiryTimers.delete(agentTimerKey(slug, agentId));
  }
}

function mergeAgentPresence(
  existing: unknown,
  incoming: AgentPresenceEntry,
): AgentPresenceEntry {
  const base = (existing && typeof existing === 'object' && !Array.isArray(existing))
    ? existing as Record<string, unknown>
    : {};

  // "First wins" identity: only fill in missing fields on refresh.
  const merged: AgentPresenceEntry = {
    id: incoming.id,
    name: (typeof base.name === 'string' && base.name.trim()) ? String(base.name) : incoming.name,
    color: (typeof base.color === 'string' && base.color.trim()) ? String(base.color) : incoming.color,
    avatar: (typeof base.avatar === 'string' && String(base.avatar).trim()) ? String(base.avatar) : incoming.avatar,
    status: incoming.status ?? (typeof base.status === 'string' ? String(base.status) : undefined),
    details: incoming.details ?? (typeof base.details === 'string' ? String(base.details) : undefined),
    at: incoming.at ?? (typeof base.at === 'string' ? String(base.at) : undefined),
  };

  // Ensure `name` is always non-empty for UI display.
  if (!merged.name || !merged.name.trim()) merged.name = merged.id;
  return merged;
}

function scheduleAgentPresenceExpiry(slug: string, agentId: string, at: string, ttlMs: number): void {
  const key = agentTimerKey(slug, agentId);
  const existing = agentPresenceExpiryTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    agentPresenceExpiryTimers.delete(key);
    clearAgentPresenceForSlug(slug, agentId, at);
  }, ttlMs);
  agentPresenceExpiryTimers.set(key, timer);
}

function scheduleAgentCursorExpiry(slug: string, agentId: string, at: string, ttlMs: number): void {
  const key = agentTimerKey(slug, agentId);
  const existing = agentCursorExpiryTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    agentCursorExpiryTimers.delete(key);
    clearAgentCursorForSlug(slug, agentId, at);
  }, ttlMs);
  agentCursorExpiryTimers.set(key, timer);
}

function clearAgentPresenceForSlug(slug: string, agentId: string, at: string): void {
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return;
  try {
    ydoc.transact(() => {
      const presenceMap = ydoc.getMap<unknown>('agentPresence');
      const current = presenceMap.get(agentId);
      const currentAt = (current && typeof current === 'object' && !Array.isArray(current))
        ? (current as any).at
        : null;
      if (typeof currentAt === 'string' && currentAt !== at) return;
      presenceMap.delete(agentId);
    }, 'agent-presence-expiry');
    // Persist the expiry deletion so stale presence doesn't reappear after reconnect/restart.
    schedulePersistDoc(slug, ydoc);
  } catch {
    // ignore
  }
}

function clearAgentCursorForSlug(slug: string, agentId: string, at: string): void {
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return;
  try {
    ydoc.transact(() => {
      const cursorMap = ydoc.getMap<unknown>('agentCursors');
      const current = cursorMap.get(agentId);
      const currentAt = (current && typeof current === 'object' && !Array.isArray(current))
        ? (current as any).at
        : null;
      if (typeof currentAt === 'string' && currentAt !== at) return;
      cursorMap.delete(agentId);
    }, 'agent-cursor-expiry');
  } catch {
    // ignore
  }
}

function readHeaderValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return '';
  const normalized = name.toLowerCase();
  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== normalized) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return '';
  }
  return '';
}

export function extractCollabTokenFromHeaders(headers: unknown): string {
  const shareToken = readHeaderValue(headers, 'x-share-token').trim();
  if (shareToken) return shareToken;
  const auth = readHeaderValue(headers, 'authorization').trim();
  if (auth) {
    const match = auth.match(/^bearer\s+(.+)$/i);
    return (match?.[1] ?? auth).trim();
  }
  const protocol = readHeaderValue(headers, 'sec-websocket-protocol').trim();
  if (protocol) {
    // If a token is present here, it is usually the first protocol entry.
    const first = protocol.split(',')[0]?.trim() ?? '';
    if (first) return first;
  }
  return '';
}

type CollabAuthContext = {
  slug: string;
  role: ShareRole;
  shareState: ShareState;
  canWrite: boolean;
  accessEpoch: number | null;
};

type CollabPresenceContext = CollabAuthContext & {
  activeCollabConnectionId?: string;
};

function authenticateCollabSession(documentName: string, token: string): CollabAuthContext {
  const claims = verifyCollabToken(token);
  if (!claims || claims.slug !== documentName) {
    throw new Error('permission-denied');
  }

  const doc = getDocumentAuthStateBySlug(documentName);
  if (!doc || doc.share_state === 'DELETED') {
    throw new Error('document-not-found');
  }
  const accessEpoch = typeof doc.access_epoch === 'number' ? doc.access_epoch : null;
  if (accessEpoch !== null && claims.accessEpoch !== accessEpoch) {
    throw new Error('session-stale');
  }
  if (doc.share_state === 'REVOKED' && claims.role !== 'owner_bot') {
    throw new Error('document-revoked');
  }
  if (doc.share_state === 'PAUSED' && claims.role !== 'owner_bot') {
    throw new Error('document-paused');
  }

  const canWrite = (
    (claims.role === 'owner_bot'
      && (doc.share_state === 'ACTIVE' || doc.share_state === 'PAUSED'))
    || (claims.role === 'editor' && doc.share_state === 'ACTIVE')
  );

  return {
    slug: claims.slug,
    role: claims.role,
    shareState: doc.share_state,
    canWrite,
    accessEpoch,
  };
}

export function buildActiveCollabConnectionId(socketId: string | null | undefined): string {
  const normalizedSocketId = typeof socketId === 'string' ? socketId.trim() : '';
  const suffix = normalizedSocketId || `generated-${randomUUID()}`;
  return `${ACTIVE_COLLAB_INSTANCE_ID}:${suffix}`;
}

function attachAuthenticatedCollabPresence(socketId: string, auth: CollabAuthContext): CollabPresenceContext {
  const connectionId = buildActiveCollabConnectionId(socketId);
  if (typeof auth.accessEpoch === 'number' && Number.isFinite(auth.accessEpoch)) {
    noteDocumentLiveCollabLease(auth.slug, auth.accessEpoch);
    console.warn('[collab] authenticated collab presence attached', {
      slug: auth.slug,
      role: auth.role,
      accessEpoch: auth.accessEpoch,
      connectionId,
    });
    const heartbeatMs = parsePositiveInt(
      process.env.DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS,
      DEFAULT_DOCUMENT_LIVE_COLLAB_LEASE_HEARTBEAT_MS,
    );
    if (heartbeatMs > 0) {
      const existingTimer = authenticatedCollabLeaseHeartbeatTimers.get(connectionId);
      if (existingTimer) clearInterval(existingTimer);
      const timer = setInterval(() => {
        try {
          noteDocumentLiveCollabLease(auth.slug, auth.accessEpoch as number);
        } catch {
          // best-effort heartbeat
        }
      }, heartbeatMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      authenticatedCollabLeaseHeartbeatTimers.set(connectionId, timer);
    }
    upsertActiveCollabConnection({
      connectionId,
      slug: auth.slug,
      role: auth.role,
      accessEpoch: auth.accessEpoch,
      instanceId: ACTIVE_COLLAB_INSTANCE_ID,
    });
    return {
      ...auth,
      activeCollabConnectionId: connectionId,
    };
  }
  return auth;
}

function detachAuthenticatedCollabPresence(context: unknown): void {
  const connectionId = (
    context
    && typeof context === 'object'
    && typeof (context as { activeCollabConnectionId?: unknown }).activeCollabConnectionId === 'string'
  )
    ? (context as { activeCollabConnectionId: string }).activeCollabConnectionId
    : '';
  if (!connectionId) return;
  const heartbeatTimer = authenticatedCollabLeaseHeartbeatTimers.get(connectionId);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    authenticatedCollabLeaseHeartbeatTimers.delete(connectionId);
  }
  try {
    removeActiveCollabConnection(connectionId);
  } catch (error) {
    console.warn('[collab] failed to remove authenticated collab presence', {
      connectionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function collabSessionLeaseKey(slug: string, accessEpoch: number | null): string {
  return `${slug}::${typeof accessEpoch === 'number' ? accessEpoch : 'none'}`;
}

function buildCollabSessionLeaseConnectionId(
  slug: string,
  accessEpoch: number,
  role: ShareRole,
  tokenId: string | null | undefined,
): string {
  const stableTokenPart = typeof tokenId === 'string' && tokenId.trim()
    ? tokenId.trim()
    : 'anonymous';
  return `collab-session:${slug}:${accessEpoch}:${role}:${stableTokenPart}`;
}

function pruneRecentCollabSessionLeases(nowMs: number = Date.now()): void {
  for (const [key, expiresAtMs] of recentCollabSessionLeases) {
    if (expiresAtMs > nowMs) continue;
    recentCollabSessionLeases.delete(key);
  }
}

export function noteRecentCollabSessionLease(slug: string, accessEpoch: number | null, ttlMs: number): void {
  if (ttlMs <= 0) return;
  const nowMs = Date.now();
  pruneRecentCollabSessionLeases(nowMs);
  recentCollabSessionLeases.set(collabSessionLeaseKey(slug, accessEpoch), nowMs + ttlMs);
}

export function getRecentCollabSessionLeaseCount(slug: string, accessEpoch: number | null): number {
  const nowMs = Date.now();
  pruneRecentCollabSessionLeases(nowMs);
  const expiresAtMs = recentCollabSessionLeases.get(collabSessionLeaseKey(slug, accessEpoch));
  return typeof expiresAtMs === 'number' && expiresAtMs > nowMs ? 1 : 0;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function normalizeIsoTimestamp(value: unknown, fallbackIso: string): string {
  if (typeof value !== 'string') return fallbackIso;
  const trimmed = value.trim();
  if (!trimmed) return fallbackIso;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return fallbackIso;
  return new Date(parsed).toISOString();
}

function getWsStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const symbol of Object.getOwnPropertySymbols(error)) {
    if (symbol.description !== 'status-code') continue;
    const value = (error as Record<symbol, unknown>)[symbol];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function summarizeWsError(error: unknown): { message: string; code?: string; statusCode?: number } {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown socket error');
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  const statusCode = getWsStatusCode(error);
  return { message, code, statusCode };
}

function normalizeWsErrorMessage(message: string): string {
  return message.trim().toLowerCase();
}

function hashSuppressionValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getRequestRemoteAddress(request: unknown): string {
  const socket = (request as { socket?: { remoteAddress?: unknown } } | null)?.socket;
  return typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : '';
}

function isOversizedWsError(summary: { message: string; code?: string; statusCode?: number }): boolean {
  const normalizedMessage = normalizeWsErrorMessage(summary.message);
  return summary.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
    || summary.statusCode === 1009
    || normalizedMessage.includes('max payload size exceeded');
}

function resolveSlugFromRequest(request: unknown): string | null {
  const rawUrl = (request as { url?: unknown } | null)?.url;
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    const slug = parsed.searchParams.get('slug');
    return slug && slug.trim().length > 0 ? slug.trim() : null;
  } catch {
    return null;
  }
}

function buildWsOversizeSuppressionKey(request: unknown, source: string, slug: string | null): string {
  const websocketKey = readHeaderValue((request as { headers?: unknown } | null)?.headers, 'sec-websocket-key').trim();
  const userAgent = readHeaderValue((request as { headers?: unknown } | null)?.headers, 'user-agent').trim();
  const remoteAddress = getRequestRemoteAddress(request).trim();
  const tokenPresent = extractCollabTokenFromHeaders((request as { headers?: unknown } | null)?.headers).trim().length > 0;
  return stableStringify({
    source: source || 'unknown',
    slug: slug || null,
    websocketKey: websocketKey ? hashSuppressionValue(websocketKey) : null,
    userAgent: userAgent ? hashSuppressionValue(userAgent) : null,
    remoteAddress: remoteAddress ? hashSuppressionValue(remoteAddress) : null,
    tokenPresent,
  });
}

function buildWsOversizeSuppressionFingerprint(
  request: unknown,
  source: string,
  slug: string | null,
  summary: { message: string; code?: string; statusCode?: number },
): string {
  return stableStringify({
    session: buildWsOversizeSuppressionKey(request, source, slug),
    source: source || 'unknown',
    slug: slug || null,
    code: summary.code || null,
    statusCode: summary.statusCode ?? null,
    message: normalizeWsErrorMessage(summary.message),
  });
}

function logWsOversizeSuppressionSummary(
  slug: string | null,
  source: string,
  summary: { code?: string; statusCode?: number; message: string },
  suppressedCount: number,
): void {
  if (!shouldEmitSuppressionSummary(suppressedCount)) return;
  console.warn('[collab] suppressed repeated websocket oversize errors', {
    slug,
    source,
    suppressedCount,
    code: summary.code,
    statusCode: summary.statusCode,
  });
}

export function logCollabSocketErrorWithSuppression(request: unknown, source: string, error: unknown): void {
  const slug = resolveSlugFromRequest(request);
  const summary = summarizeWsError(error);
  if (isOversizedWsError(summary)) {
    const reason = 'unsupported_message_length';
    const cooldown = registerPathologyCooldown(
      collabWsOversizeCooldowns,
      buildWsOversizeSuppressionKey(request, source, slug),
      reason,
      buildWsOversizeSuppressionFingerprint(request, source, slug, summary),
      Date.now(),
      parsePositiveInt(
        process.env.COLLAB_WS_OVERSIZE_LOG_COOLDOWN_MS,
        DEFAULT_WS_OVERSIZE_LOG_COOLDOWN_MS,
      ),
    );
    if (cooldown.suppressed) {
      recordCollabLogSuppressed('ws_oversize', reason);
      logWsOversizeSuppressionSummary(slug, source, summary, cooldown.suppressedCount);
      return;
    }
  }
  console.error('[collab] websocket connection error', {
    source,
    slug,
    code: summary.code,
    statusCode: summary.statusCode,
    message: summary.message,
  });
}

function attachCollabSocketErrorHandler(socket: unknown, request: unknown, source: string): void {
  const wsLike = socket as {
    on?: (event: string, listener: (error: unknown) => void) => void;
    close?: (code?: number, reason?: string) => void;
  };
  if (typeof wsLike.on !== 'function') return;
  wsLike.on('error', (error) => {
    logCollabSocketErrorWithSuppression(request, source, error);
    try {
      wsLike.close?.();
    } catch {
      // ignore
    }
  });
}

function isCollabPersistenceReadOnly(): boolean {
  const raw = (process.env.COLLAB_PERSIST_READONLY || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function releaseCollabInvalidation(slug: string): void {
  const existing = collabInvalidationReleaseTimers.get(slug);
  if (existing) {
    clearTimeout(existing);
    collabInvalidationReleaseTimers.delete(slug);
  }
  const cooldownMs = parsePositiveInt(
    process.env.COLLAB_INVALIDATION_COOLDOWN_MS,
    DEFAULT_INVALIDATION_COOLDOWN_MS,
  );
  if (cooldownMs <= 0) {
    collabInvalidations.delete(slug);
    return;
  }
  const timer = setTimeout(() => {
    collabInvalidationReleaseTimers.delete(slug);
    collabInvalidations.delete(slug);
  }, cooldownMs);
  collabInvalidationReleaseTimers.set(slug, timer);
}

function logStaleEpochWrite(
  slug: string,
  source: string,
  details: Record<string, unknown>,
): void {
  const key = `${slug}:${source}`;
  const now = Date.now();
  const previous = staleEpochWriteWarnings.get(key) ?? 0;
  if (now - previous < 5000) return;
  staleEpochWriteWarnings.set(key, now);
  console.warn('[collab] stale-epoch write dropped', { slug, source, ...details });
}

function getContextAccessEpoch(context: unknown): number | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const raw = (context as { accessEpoch?: unknown }).accessEpoch;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

function shouldDropStaleContextWrite(
  slug: string,
  context: unknown,
  source: 'onChange' | 'onStoreDocument' | 'durablePersistTracking',
): boolean {
  const sessionAccessEpoch = getContextAccessEpoch(context);
  if (sessionAccessEpoch === null) return false;
  const auth = getDocumentAuthStateBySlug(slug);
  if (!auth || typeof auth.access_epoch !== 'number') return false;
  if (auth.access_epoch === sessionAccessEpoch) return false;
  logStaleEpochWrite(slug, source, {
    sessionAccessEpoch,
    currentAccessEpoch: auth.access_epoch,
  });
  return true;
}

function sameStateVector(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function markSkipNextOnStorePersist(slug: string, ydoc: Y.Doc): void {
  skipOnStoreStateVectors.set(slug, Y.encodeStateVector(ydoc));
}

function shouldSkipOnStorePersistAfterExternalApply(slug: string, ydoc: Y.Doc): boolean {
  const expectedStateVector = skipOnStoreStateVectors.get(slug);
  if (!expectedStateVector) return false;
  const currentStateVector = Y.encodeStateVector(ydoc);
  if (!sameStateVector(expectedStateVector, currentStateVector)) {
    // External-apply skip only applies to the exact state we just wrote.
    skipOnStoreStateVectors.delete(slug);
    return false;
  }
  skipOnStoreStateVectors.delete(slug);
  const pending = persistTimers.get(slug);
  if (pending) {
    clearTimeout(pending);
    persistTimers.delete(slug);
  }
  rememberLoadedDoc(slug, ydoc);
  touchDoc(slug);
  return true;
}

function getPersistGeneration(slug: string): number {
  return persistGeneration.get(slug) ?? 0;
}

function advancePersistGeneration(slug: string): number {
  const nextGeneration = getPersistGeneration(slug) + 1;
  persistGeneration.set(slug, nextGeneration);
  return nextGeneration;
}

function rememberLoadedDoc(slug: string, ydoc: Y.Doc): void {
  loadedDocs.set(slug, ydoc);
  docPersistGenerations.set(ydoc, getPersistGeneration(slug));
  ensureFragmentEditTracking(ydoc);
  ensureDurablePersistTracking(slug, ydoc);
}

function ensureFragmentEditTracking(ydoc: Y.Doc): FragmentEditState {
  let state = fragmentEditStateByDoc.get(ydoc);
  if (!state) {
    state = { dirty: false };
    fragmentEditStateByDoc.set(ydoc, state);
  }
  if (!fragmentEditListenerAttached.has(ydoc)) {
    fragmentEditListenerAttached.add(ydoc);
    ydoc.on('afterTransaction', (transaction: any) => {
      const changedParentTypes = transaction?.changedParentTypes;
      if (!changedParentTypes || typeof changedParentTypes.has !== 'function') return;
      const fragment = ydoc.getXmlFragment('prosemirror');
      if (!changedParentTypes.has(fragment)) return;
      const origin = typeof transaction?.origin === 'string' ? transaction.origin : '';
      if (origin && FRAGMENT_REPAIR_ORIGINS.has(origin)) {
        const existing = fragmentEditStateByDoc.get(ydoc);
        if (existing) existing.dirty = false;
        return;
      }
      const markdownText = ydoc.getText('markdown');
      const markdownChanged = changedParentTypes.has(markdownText);
      const existing = fragmentEditStateByDoc.get(ydoc);
      if (!existing) return;
      existing.dirty = !markdownChanged;
    });
  }
  return state;
}

function shouldIgnoreDurablePersistOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string' || !origin.trim()) return false;
  if (FRAGMENT_REPAIR_ORIGINS.has(origin)) return true;
  return origin.startsWith('agent-')
    || origin.startsWith('canonical-')
    || origin.startsWith('external-')
    || origin.startsWith('legacy-')
    || origin.startsWith('persisted-')
    || origin.startsWith('server-');
}

function ensureDurablePersistTracking(slug: string, ydoc: Y.Doc): void {
  if (durablePersistListenerAttached.has(ydoc)) return;
  durablePersistListenerAttached.add(ydoc);
  ydoc.on('afterTransaction', (transaction: any) => {
    const changedParentTypes = transaction?.changedParentTypes;
    if (!changedParentTypes || typeof changedParentTypes.has !== 'function') return;
    const fragment = ydoc.getXmlFragment('prosemirror');
    const markdown = ydoc.getText('markdown');
    const marks = ydoc.getMap('marks');
    const docChanged = changedParentTypes.has(fragment)
      || changedParentTypes.has(markdown)
      || changedParentTypes.has(marks);
    if (!docChanged) return;
    if (shouldIgnoreDurablePersistOrigin(transaction?.origin)) return;
    const originContext = (
      transaction?.origin
      && typeof transaction.origin === 'object'
      && !Array.isArray(transaction.origin)
      && 'context' in transaction.origin
    )
      ? (transaction.origin as { context?: unknown }).context
      : null;
    if (originContext && shouldDropStaleContextWrite(slug, originContext, 'durablePersistTracking')) return;
    if (collabInvalidations.has(slug) || isRewriteLocked(slug)) return;
    if (loadedDocs.get(slug) !== ydoc) return;
    markDocChanged(slug);
    schedulePersistDoc(slug, ydoc);
  });
}

function cancelPendingPersistWork(
  slug: string,
  options?: {
    advanceGeneration?: boolean;
  },
): number {
  const generation = options?.advanceGeneration ? advancePersistGeneration(slug) : getPersistGeneration(slug);
  const timer = persistTimers.get(slug);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(slug);
  }
  persistPending.delete(slug);
  persistInFlight.delete(slug);
  return generation;
}

function isLocalWsUrlBase(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function shouldAttachToMainHttpServer(): boolean {
  const raw = (process.env.COLLAB_ATTACH_TO_MAIN_HTTP || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function resolveAttachedWsUrlBase(mainHttpPort: number): string {
  const configured = (process.env.COLLAB_PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const publicBase = (process.env.PROOF_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (publicBase) {
    try {
      const url = new URL(publicBase);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/collab';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      // fall through
    }
  }

  return `ws://localhost:${mainHttpPort}/collab`;
}

function resolveEmbeddedWsUrlBase(mainHttpPort: number): string {
  const configured = (process.env.COLLAB_PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const publicBase = (process.env.PROOF_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (publicBase) {
    try {
      const url = new URL(publicBase);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/ws';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      // fall through
    }
  }

  return `ws://localhost:${mainHttpPort}/ws`;
}

function encodeBase64Url(input: Buffer): string {
  return input.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(input: string): Buffer | null {
  if (!input) return null;
  const normalized = input
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  try {
    return Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
}

type CollabSessionClaims = {
  slug: string;
  role: ShareRole;
  exp: number;
  accessEpoch: number;
  tokenId: string | null;
  jti: string;
};

function signCollabClaims(claims: CollabSessionClaims): string {
  const payload = encodeBase64Url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const signature = createHmac('sha256', collabSigningSecret).update(payload).digest();
  return `${payload}.${encodeBase64Url(signature)}`;
}

function verifyCollabToken(token: string): CollabSessionClaims | null {
  const [payloadB64, signatureB64] = token.split('.', 2);
  if (!payloadB64 || !signatureB64) return null;

  const expectedSignature = createHmac('sha256', collabSigningSecret).update(payloadB64).digest();
  const providedSignature = decodeBase64Url(signatureB64);
  if (!providedSignature) return null;
  if (providedSignature.length !== expectedSignature.length) return null;
  if (!timingSafeEqual(providedSignature, expectedSignature)) return null;

  const payload = decodeBase64Url(payloadB64);
  if (!payload) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;

  const slug = (claims as { slug?: unknown }).slug;
  const role = (claims as { role?: unknown }).role;
  const exp = (claims as { exp?: unknown }).exp;
  const accessEpoch = (claims as { accessEpoch?: unknown }).accessEpoch;
  const tokenId = (claims as { tokenId?: unknown }).tokenId;
  const jti = (claims as { jti?: unknown }).jti;
  if (typeof slug !== 'string' || slug.length === 0) return null;
  if (!isShareRole(role)) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (typeof accessEpoch !== 'number' || !Number.isFinite(accessEpoch) || accessEpoch < 0) return null;
  if (tokenId !== null && typeof tokenId !== 'string') return null;
  if (typeof jti !== 'string' || jti.length < 6) return null;
  if (Date.now() >= exp * 1000) return null;

  return { slug, role, exp, accessEpoch, tokenId, jti };
}

export function isValidCollabSessionToken(token: string): boolean {
  return Boolean(verifyCollabToken(token));
}

export function getCollabSessionClaims(token: string): { slug: string; role: ShareRole; accessEpoch: number } | null {
  const claims = verifyCollabToken(token);
  if (!claims) return null;
  return { slug: claims.slug, role: claims.role, accessEpoch: claims.accessEpoch };
}

function encodeMarksMap(map: Y.Map<unknown>): Record<string, unknown> {
  const marks: Record<string, unknown> = {};
  map.forEach((value, key) => {
    marks[key] = value as unknown;
  });
  return marks;
}

function parseStoredMarks(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return canonicalizeStoredMarks(parsed as Record<string, StoredMark>);
    }
  } catch {
    // ignore malformed marks payload
  }
  return {};
}

function stableSortValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => stableSortValue(entry));
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = stableSortValue(entryValue);
  }
  return sorted;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value));
}

function shouldPreserveMissingMark(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'authored') return false;
  // Suggestion marks are intentionally removed when accepted/rejected in the editor.
  // Re-adding missing suggestions from stale DB state causes "sticky" marks to reappear.
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return false;
  const status = (value as { status?: unknown }).status;
  if (status === 'accepted' || status === 'rejected') return false;
  return true;
}

function mergePreservedActionMarks(
  slug: string,
  incomingMarks: Record<string, unknown>,
): Record<string, unknown> {
  const row = getDocumentBySlug(slug);
  if (!row) return incomingMarks;

  const existingMarks = parseStoredMarks(row.marks);
  let preserved = 0;
  for (const [markId, value] of Object.entries(existingMarks)) {
    if (incomingMarks[markId] !== undefined) continue;
    if (!shouldPreserveMissingMark(value)) continue;
    incomingMarks[markId] = value;
    preserved += 1;
  }

  if (preserved > 0) {
    console.warn('[collab] preserved non-authored marks from DB during projection materialization', {
      slug,
      preserved,
      incomingMarkCount: Object.keys(incomingMarks).length,
    });
  }
  return incomingMarks;
}

function touchDoc(slug: string): void {
  docLastAccessedAt.set(slug, Date.now());
}

function markDocChanged(slug: string): void {
  docLastChangedAt.set(slug, Date.now());
  touchDoc(slug);
}

function recordProjectionWipeWarning(slug: string, previousLength: number, nextLength: number): void {
  if (previousLength <= 0) return;
  if (nextLength === 0) {
    console.warn('[collab] Projection markdown emptied unexpectedly', {
      slug,
      previousLength,
      nextLength,
    });
    recordProjectionWipe('empty');
    return;
  }
  const shrinkRatio = nextLength / previousLength;
  if (shrinkRatio < 0.2) {
    console.warn('[collab] Projection markdown shrank by >80%', {
      slug,
      previousLength,
      nextLength,
      shrinkRatio,
    });
    recordProjectionWipe('shrink');
  }
}

export function detectPathologicalProjectionRepeat(
  baselineMarkdown: string,
  candidateMarkdown: string,
  minRepeats: number = DEFAULT_PATHOLOGICAL_REPEAT_MIN_REPEATS,
  minBaseChars: number = DEFAULT_PATHOLOGICAL_REPEAT_MIN_BASE_CHARS,
): number {
  if (typeof baselineMarkdown !== 'string' || typeof candidateMarkdown !== 'string') return 0;
  const baseLen = baselineMarkdown.length;
  const nextLen = candidateMarkdown.length;
  if (baseLen < minBaseChars) return 0;
  if (nextLen < baseLen * minRepeats) return 0;
  if (nextLen % baseLen !== 0) return 0;
  const repeatCount = Math.floor(nextLen / baseLen);
  if (repeatCount < minRepeats) return 0;
  for (let offset = 0; offset < nextLen; offset += baseLen) {
    if (candidateMarkdown.slice(offset, offset + baseLen) !== baselineMarkdown) return 0;
  }
  return repeatCount;
}

const PROSEMIRROR_BLOCK_NODE_NAMES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'list_item',
  'bullet_list',
  'ordered_list',
  'code_block',
  'table',
  'table_row',
  'table_cell',
  'table_header',
  'task_item',
  'horizontal_rule',
]);

function collectFragmentPlainText(node: unknown, parts: string[]): void {
  if (node instanceof Y.XmlText) {
    const text = node.toString();
    if (text.length > 0) parts.push(text);
    return;
  }
  if (!(node instanceof Y.XmlElement) && !(node instanceof Y.XmlFragment)) return;
  const nodeName = (node instanceof Y.XmlElement && typeof node.nodeName === 'string')
    ? node.nodeName.toLowerCase()
    : '';
  if (nodeName === 'hard_break') {
    parts.push('\n');
  }
  const children = node.toArray() as unknown[];
  for (const child of children) {
    collectFragmentPlainText(child, parts);
  }
  if (nodeName && PROSEMIRROR_BLOCK_NODE_NAMES.has(nodeName)) {
    parts.push('\n');
  }
}

function getFragmentPlainTextFromDoc(doc: Y.Doc): string {
  try {
    const fragment = doc.getXmlFragment('prosemirror');
    const parts: string[] = [];
    collectFragmentPlainText(fragment, parts);
    return normalizeFragmentPlainText(parts.join(' '));
  } catch {
    return '';
  }
}

function normalizeMarkdownForDriftComparison(markdown: string): string {
  if (!markdown) return '';
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, ' ');
  const withoutTags = withoutComments.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^>\n]*)?\s*\/?>/g, ' ');
  const withoutFences = withoutTags.replace(/```[\s\S]*?```/g, ' ');
  const withoutInlineCode = withoutFences.replace(/`([^`]+)`/g, '$1');
  const withoutLinks = withoutInlineCode.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  const withoutEmphasis = withoutLinks.replace(/[*_~>#|]/g, ' ');
  const withoutListMarkers = withoutEmphasis.replace(/^\s*[-+]\s+/gm, ' ');
  return normalizeFragmentPlainText(withoutListMarkers);
}

function tokenizeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function computeTokenOverlapRatio(a: string, b: string): number {
  const aTokens = tokenizeText(a);
  const bTokens = tokenizeText(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 1;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

type ProjectionSafetyDecision = {
  safe: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

export function evaluateProjectionSafety(
  baselineMarkdown: string,
  candidateMarkdown: string,
  doc: Y.Doc,
): ProjectionSafetyDecision {
  const maxChars = parsePositiveInt(
    process.env.COLLAB_PROJECTION_GUARD_MAX_CHARS,
    DEFAULT_PROJECTION_GUARD_MAX_CHARS,
  );
  const maxGrowthMultiplier = parsePositiveFloat(
    process.env.COLLAB_PROJECTION_GUARD_MAX_GROWTH_MULTIPLIER,
    DEFAULT_PROJECTION_GUARD_MAX_GROWTH_MULTIPLIER,
  );
  const maxLengthDriftRatio = parsePositiveFloat(
    process.env.COLLAB_PROJECTION_GUARD_MAX_LENGTH_DRIFT_RATIO,
    DEFAULT_PROJECTION_GUARD_MAX_LENGTH_DRIFT_RATIO,
  );
  const minTokenOverlap = parsePositiveFloat(
    process.env.COLLAB_PROJECTION_GUARD_MIN_TOKEN_OVERLAP,
    DEFAULT_PROJECTION_GUARD_MIN_TOKEN_OVERLAP,
  );

  if (candidateMarkdown.length > maxChars) {
    return {
      safe: false,
      reason: 'max_chars_exceeded',
      details: {
        candidateChars: candidateMarkdown.length,
        maxChars,
      },
    };
  }

  if (baselineMarkdown.length > 0 && candidateMarkdown.length > (baselineMarkdown.length * maxGrowthMultiplier)) {
    return {
      safe: false,
      reason: 'growth_multiplier_exceeded',
      details: {
        baselineChars: baselineMarkdown.length,
        candidateChars: candidateMarkdown.length,
        maxGrowthMultiplier,
      },
    };
  }

  const repeatCount = detectPathologicalProjectionRepeat(baselineMarkdown, candidateMarkdown);
  if (repeatCount > 0) {
    return {
      safe: false,
      reason: 'pathological_repeat',
      details: {
        baselineChars: baselineMarkdown.length,
        candidateChars: candidateMarkdown.length,
        repeatCount,
      },
    };
  }

  const fragmentPlain = getFragmentPlainTextFromDoc(doc);
  const markdownPlain = normalizeMarkdownForDriftComparison(candidateMarkdown);
  if (fragmentPlain.length > 0 && markdownPlain.length > 0) {
    const lengthDriftRatio = Math.abs(fragmentPlain.length - markdownPlain.length)
      / Math.max(fragmentPlain.length, markdownPlain.length);
    const tokenOverlap = computeTokenOverlapRatio(fragmentPlain, markdownPlain);
    if (lengthDriftRatio > maxLengthDriftRatio && tokenOverlap < minTokenOverlap) {
      return {
        safe: false,
        reason: 'fragment_markdown_drift',
        details: {
          fragmentChars: fragmentPlain.length,
          markdownChars: markdownPlain.length,
          lengthDriftRatio,
          tokenOverlap,
          maxLengthDriftRatio,
          minTokenOverlap,
        },
      };
    }
  }

  return { safe: true };
}

function materializeProjection(
  slug: string,
  doc: Y.Doc,
  options?: {
    bumpRevision?: boolean;
    refreshSnapshot?: boolean;
    markdownOverride?: string;
    source?: 'persist' | 'repair' | 'startup' | 'unknown';
  },
): void {
  const markdownText = options?.markdownOverride ?? doc.getText('markdown').toString();
  const source = options?.source ?? 'unknown';
  recordProjectionChars(markdownText.length, source);
  const previousLength = lastProjectionLengths.get(slug);
  if (previousLength !== undefined) {
    recordProjectionWipeWarning(slug, previousLength, markdownText.length);
  }
  lastProjectionLengths.set(slug, markdownText.length);
  const marksMap = doc.getMap('marks');
  const marks = mergePreservedActionMarks(slug, encodeMarksMap(marksMap));
  const yStateVersion = getLatestYStateVersion(slug);
  if (options?.bumpRevision === false) {
    const replaced = replaceDocumentProjection(slug, markdownText, marks, yStateVersion);
    if (!replaced) {
      throw new Error(`[collab] replaceDocumentProjection returned 0 rows for ${slug}`);
    }
  } else {
    const updated = updateDocument(slug, markdownText, marks, yStateVersion);
    if (!updated) {
      throw new Error(`[collab] updateDocument returned 0 rows for ${slug}`);
    }
  }
  if (options?.refreshSnapshot !== false) {
    refreshSnapshotForSlug(slug);
  }
}

function clearProjectionRepairState(slug: string): void {
  const timer = projectionRepairScheduled.get(slug);
  if (timer) clearTimeout(timer);
  projectionRepairScheduled.delete(slug);
  projectionRepairRunning.delete(slug);
  projectionRepairRetryIndex.delete(slug);
  projectionRepairReasons.delete(slug);
  clearAllSlugPathologyCooldowns(slug);
}

function getProjectionRepairRetryScheduleMs(): number[] {
  const raw = (process.env.COLLAB_PROJECTION_REPAIR_RETRY_SCHEDULE_MS || '').trim();
  if (!raw) return [...DEFAULT_PROJECTION_REPAIR_RETRY_SCHEDULE_MS];
  const parsed = raw
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (parsed.length === 0) return [...DEFAULT_PROJECTION_REPAIR_RETRY_SCHEDULE_MS];
  return parsed;
}

type ProjectionPathologyCooldownResult = {
  suppressed: boolean;
  suppressedCount: number;
};

function registerPathologyCooldown(
  state: Map<string, PathologyCooldownEntry>,
  key: string,
  reason: string,
  fingerprint: string,
  nowMs: number = Date.now(),
  cooldownMs: number = DEFAULT_PROJECTION_PATHOLOGY_COOLDOWN_MS,
): ProjectionPathologyCooldownResult {
  if (!key || !fingerprint) return { suppressed: false, suppressedCount: 0 };
  const existing = state.get(key);
  if (existing && existing.fingerprint === fingerprint && existing.untilMs > nowMs) {
    existing.suppressedCount += 1;
    state.set(key, existing);
    return {
      suppressed: true,
      suppressedCount: existing.suppressedCount,
    };
  }
  state.set(key, {
    fingerprint,
    reason: reason || 'unknown',
    untilMs: nowMs + Math.max(1, cooldownMs),
    suppressedCount: 0,
  });
  return {
    suppressed: false,
    suppressedCount: 0,
  };
}

export function registerProjectionPathologyCooldown(
  state: Map<string, PathologyCooldownEntry>,
  slug: string,
  reason: string,
  fingerprint: string,
  nowMs: number = Date.now(),
  cooldownMs: number = parsePositiveInt(
    process.env.COLLAB_PROJECTION_PATHOLOGY_COOLDOWN_MS,
    DEFAULT_PROJECTION_PATHOLOGY_COOLDOWN_MS,
  ),
): ProjectionPathologyCooldownResult {
  return registerPathologyCooldown(state, slug, reason, fingerprint, nowMs, cooldownMs);
}

function clearProjectionPathologyCooldown(slug: string): void {
  if (!slug) return;
  projectionPathologyCooldowns.delete(slug);
}

function clearStaleOnStoreDriftCooldown(slug: string): void {
  if (!slug) return;
  staleOnStoreDriftCooldowns.delete(slug);
}

function clearAllSlugPathologyCooldowns(slug: string): void {
  clearProjectionPathologyCooldown(slug);
  clearStaleOnStoreDriftCooldown(slug);
}

function buildProjectionPathologyFingerprint(
  reason: string,
  details: Record<string, unknown> | undefined,
  extras: Record<string, unknown> = {},
): string {
  return stableStringify({
    reason: reason || 'unknown',
    details: details || null,
    extras,
  });
}

function buildStaleOnStoreSuppressionFingerprint(
  reason: string,
  extras: Record<string, unknown> = {},
): string {
  return stableStringify({
    reason: reason || 'unknown',
    extras,
  });
}

function shouldEmitSuppressionSummary(suppressedCount: number): boolean {
  return suppressedCount === 10 || suppressedCount === 50 || suppressedCount === 100;
}

async function deriveMarkdownProjectionFromFragment(doc: Y.Doc): Promise<string | null> {
  if ((process.env.COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE || '').trim() === '1') {
    return null;
  }
  try {
    const parser = await getHeadlessMilkdownParser();
    const root = yXmlFragmentToProseMirrorRootNode(
      doc.getXmlFragment('prosemirror') as any,
      parser.schema as any,
    ) as ProseMirrorNode;
    return await serializeMarkdown(root);
  } catch (error) {
    console.error('[collab] failed to derive markdown from fragment for projection repair', {
      error: summarizeParseError(error),
    });
    return null;
  }
}

function ensureFragmentSeededFromMarkdownIfEmptySync(
  slug: string,
  ydoc: Y.Doc,
  sourceActor: string,
): boolean {
  const fragment = ydoc.getXmlFragment('prosemirror');
  if (!isProsemirrorFragmentStructurallyEmpty(fragment)) return false;

  const markdown = stripEphemeralCollabSpans(ydoc.getText('markdown').toString());
  ydoc.transact(() => {
    seedFragmentFromLegacyMarkdownFallback(ydoc, markdown);
  }, sourceActor);
  ensureFragmentEditTracking(ydoc).dirty = false;
  touchDoc(slug);
  console.warn('[collab] repaired empty prosemirror fragment from markdown text', {
    slug,
    markdownChars: markdown.length,
    mode: 'fallback',
  });
  return true;
}

async function ensureFragmentSeededFromMarkdownIfEmpty(
  slug: string,
  ydoc: Y.Doc,
  sourceActor: string,
): Promise<boolean> {
  const fragment = ydoc.getXmlFragment('prosemirror');
  if (!isProsemirrorFragmentStructurallyEmpty(fragment)) return false;

  const markdown = stripEphemeralCollabSpans(ydoc.getText('markdown').toString());
  await seedFragmentFromLegacyMarkdown(ydoc, markdown);
  ensureFragmentEditTracking(ydoc).dirty = false;
  touchDoc(slug);
  console.warn('[collab] repaired empty prosemirror fragment from markdown text', {
    slug,
    markdownChars: markdown.length,
    mode: 'headless',
  });
  return true;
}

async function refreshMarkdownTextFromFragment(
  slug: string,
  ydoc: Y.Doc,
  sourceActor: string,
): Promise<{ deriveFailed: boolean; refreshed: boolean; markdown: string | null }> {
  const fragmentState = ensureFragmentEditTracking(ydoc);
  if (!fragmentState.dirty) {
    await ensureFragmentSeededFromMarkdownIfEmpty(slug, ydoc, 'server-fragment-repair');
  }
  const currentRowMarkdown = getDocumentBySlug(slug)?.markdown ?? '';
  const currentMarkdown = ydoc.getText('markdown').toString();
  const derivedFragmentMarkdown = await deriveMarkdownProjectionFromFragment(ydoc);
  if (derivedFragmentMarkdown === null) {
    return { deriveFailed: true, refreshed: false, markdown: null };
  }
  if (derivedFragmentMarkdown !== currentMarkdown) {
    const fragmentMatchesRow = derivedFragmentMarkdown === currentRowMarkdown;
    const projectionMatchesRow = currentMarkdown === currentRowMarkdown;
    if (projectionMatchesRow && !fragmentMatchesRow && !fragmentState.dirty) {
      return { deriveFailed: false, refreshed: false, markdown: currentMarkdown };
    }
    ydoc.transact(() => {
      applyYTextDiff(ydoc.getText('markdown'), derivedFragmentMarkdown);
    }, sourceActor);
    fragmentState.dirty = false;
    touchDoc(slug);
    return { deriveFailed: false, refreshed: true, markdown: derivedFragmentMarkdown };
  }
  return { deriveFailed: false, refreshed: false, markdown: derivedFragmentMarkdown };
}

async function repairProjectionFromFragment(
  slug: string,
  reasons: string[],
  source: 'repair' | 'startup' = 'repair',
): Promise<'success' | 'retry' | 'stop'> {
  const row = getDocumentBySlug(slug);
  const projectedRow = getProjectedDocumentBySlug(slug);
  if (!row || row.share_state === 'DELETED') {
    recordProjectionRepair('skipped', reasons.join('|') || 'missing_doc');
    return 'stop';
  }

  const liveDoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug) ?? null;
  const persistedState = readPersistedDocState(slug);
  let ydoc = persistedState.ydoc;
  if (liveDoc) {
    const dbMissingLive = Y.encodeStateAsUpdate(persistedState.ydoc, Y.encodeStateVector(liveDoc));
    if (dbMissingLive.byteLength === 0) {
      ydoc = liveDoc;
    }
  }
  const fragmentPlain = getFragmentPlainTextFromDoc(ydoc);
  const rowPlain = normalizeMarkdownForDriftComparison(row.markdown);
  if (fragmentPlain.length === 0 && rowPlain.length > 0) {
    recordProjectionGuardBlock('empty_fragment_projection', source);
    recordProjectionRepair('failure', reasons.join('|') || 'empty_fragment_projection');
    console.error('[collab] projection repair aborted: empty fragment would overwrite non-empty canonical markdown', {
      slug,
      reasons,
      rowChars: row.markdown.length,
    });
    return 'retry';
  }
  const derivedMarkdown = await deriveMarkdownProjectionFromFragment(ydoc);
  if (derivedMarkdown === null) {
    recordProjectionRepair('failure', reasons.join('|') || 'derive_fragment_markdown_failed');
    return 'retry';
  }

  const marksMap = ydoc.getMap('marks');
  const marks = mergePreservedActionMarks(slug, encodeMarksMap(marksMap));
  const storedMarks = parseStoredMarks(row.marks);
  const marksUnchanged = stableStringify(storedMarks) === stableStringify(marks);
  const yStateVersion = getLatestYStateVersion(slug);
  if (derivedMarkdown === row.markdown && marksUnchanged) {
    const projectionNeedsHeal = projectedRow?.projection_health !== 'healthy'
      || projectedRow?.projection_y_state_version !== yStateVersion;
    if (projectionNeedsHeal) {
      const replaced = replaceDocumentProjection(slug, row.markdown, marks, yStateVersion);
      if (!replaced) {
        recordProjectionRepair('failure', reasons.join('|') || 'y_state_version_sync_no_rows');
        return 'retry';
      }
    }
    recordProjectionRepair('skipped', reasons.join('|') || 'already_converged');
    clearProjectionPathologyCooldown(slug);
    return 'success';
  }

  const safety = evaluateProjectionSafety(row.markdown, derivedMarkdown, ydoc);
  if (!safety.safe) {
    const reason = safety.reason || 'unknown';
    const fingerprint = buildProjectionPathologyFingerprint(reason, safety.details, {
      baselineChars: row.markdown.length,
      candidateChars: derivedMarkdown.length,
      source,
    });
    const pathology = registerProjectionPathologyCooldown(
      projectionPathologyCooldowns,
      slug,
      reason,
      fingerprint,
    );
    if (!pathology.suppressed) {
      recordProjectionGuardBlock(reason, source);
      recordProjectionRepair('failure', reason || reasons.join('|') || 'repair_guard_blocked');
      console.error('[collab] projection repair blocked by guardrail', {
        slug,
        reasons,
        guardReason: safety.reason,
        details: safety.details,
      });
    }
    return 'stop';
  }

  try {
    materializeProjection(slug, ydoc, {
      bumpRevision: false,
      refreshSnapshot: true,
      markdownOverride: derivedMarkdown,
      source,
    });
  } catch (error) {
    recordProjectionRepair('failure', reasons.join('|') || 'replace_projection_no_rows');
    console.error('[collab] projection repair write failed', {
      slug,
      reasons,
      error: summarizeParseError(error),
    });
    return 'retry';
  }
  recordProjectionRepair('success', reasons.join('|') || 'unspecified');
  clearProjectionPathologyCooldown(slug);
  console.warn('[collab] projection repair succeeded', {
    slug,
    reasons,
    markdownChars: derivedMarkdown.length,
    yStateVersion,
  });
  return 'success';
}

async function runQueuedProjectionRepair(slug: string): Promise<void> {
  if (projectionRepairRunning.has(slug)) return;
  projectionRepairRunning.add(slug);
  try {
    const reasons = [...(projectionRepairReasons.get(slug) ?? new Set<string>(['unspecified']))];
    const result = await repairProjectionFromFragment(slug, reasons, 'repair');
    if (result === 'success' || result === 'stop') {
      clearProjectionRepairState(slug);
      return;
    }

    const schedule = getProjectionRepairRetryScheduleMs();
    const currentIndex = projectionRepairRetryIndex.get(slug) ?? 0;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= schedule.length) {
      console.error('[collab] projection repair exhausted retries', { slug, reasons, retries: schedule.length });
      clearProjectionRepairState(slug);
      return;
    }

    projectionRepairRetryIndex.set(slug, nextIndex);
    const retryDelay = schedule[nextIndex];
    const retryTimer = setTimeout(() => {
      projectionRepairScheduled.delete(slug);
      void runQueuedProjectionRepair(slug);
    }, retryDelay);
    if (typeof (retryTimer as { unref?: () => void }).unref === 'function') {
      (retryTimer as { unref: () => void }).unref();
    }
    projectionRepairScheduled.set(slug, retryTimer);
  } finally {
    projectionRepairRunning.delete(slug);
  }
}

export function queueProjectionRepair(slug: string, reason: string): void {
  if (!slug) return;
  const trimmedReason = reason && reason.trim().length > 0 ? reason.trim() : 'unspecified';
  const reasons = projectionRepairReasons.get(slug) ?? new Set<string>();
  reasons.add(trimmedReason);
  projectionRepairReasons.set(slug, reasons);
  recordProjectionRepair('queued', trimmedReason);

  if (projectionRepairRunning.has(slug) || projectionRepairScheduled.has(slug)) return;

  projectionRepairRetryIndex.set(slug, 0);
  const delay = getProjectionRepairRetryScheduleMs()[0] ?? 0;
  const timer = setTimeout(() => {
    projectionRepairScheduled.delete(slug);
    void runQueuedProjectionRepair(slug);
  }, delay);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  projectionRepairScheduled.set(slug, timer);
}

type PersistedDocState = {
  ydoc: Y.Doc;
  updatedAt: string | null;
  yStateVersion: number;
  accessEpoch: number | null;
  stateVector: Uint8Array;
};

export type CanonicalYDocHandle = {
  ydoc: Y.Doc;
  cleanup?: () => Promise<void>;
  source: 'live' | 'persisted';
};

function setLoadedDocDbMeta(
  slug: string,
  updatedAt: string | null,
  yStateVersion: number,
  accessEpoch: number | null,
  baselineStateVector: Uint8Array,
): void {
  loadedDocDbMeta.set(slug, {
    updatedAt,
    yStateVersion,
    accessEpoch,
    baselineStateVector,
  });
}

function refreshLoadedDocDbMeta(
  slug: string,
  ydoc: Y.Doc,
  updatedAt: string | null,
  yStateVersion: number,
  accessEpoch: number | null,
): void {
  setLoadedDocDbMeta(
    slug,
    updatedAt,
    yStateVersion,
    accessEpoch,
    Y.encodeStateVector(ydoc),
  );
}

function seedFragmentFromLegacyMarkdownFallback(ydoc: Y.Doc, markdown: string): void {
  const fragment = ydoc.getXmlFragment('prosemirror');
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }

  if (blocks.length === 0) {
    const paragraph = new Y.XmlElement('paragraph');
    fragment.insert(0, [paragraph]);
    return;
  }

  const nodes: Array<Y.XmlElement> = [];
  for (const block of blocks) {
    const headingMatch = block.match(/^(#{1,6})\s+([\s\S]+)$/);
    if (headingMatch) {
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', String(headingMatch[1].length));
      const textNode = new Y.XmlText();
      textNode.insert(0, headingMatch[2]);
      heading.insert(0, [textNode]);
      nodes.push(heading);
      continue;
    }

    const paragraph = new Y.XmlElement('paragraph');
    const textNode = new Y.XmlText();
    textNode.insert(0, block);
    paragraph.insert(0, [textNode]);
    nodes.push(paragraph);
  }

  fragment.insert(0, nodes);
}

async function seedFragmentFromLegacyMarkdown(ydoc: Y.Doc, markdown: string): Promise<void> {
  const fragment = ydoc.getXmlFragment('prosemirror');
  try {
    const parser = await getHeadlessMilkdownParser();
    const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
    if (parsed.doc) {
      if (fragment.length > 0) {
        fragment.delete(0, fragment.length);
      }
      prosemirrorToYXmlFragment(parsed.doc as any, fragment as any);
      return;
    }
    console.warn('[collab] falling back to heuristic legacy fragment seed after markdown parse failure', {
      error: summarizeParseError(parsed.error),
      mode: parsed.mode,
    });
  } catch (error) {
    console.warn('[collab] falling back to heuristic legacy fragment seed after parser initialization failure', {
      error: summarizeParseError(error),
    });
  }
  seedFragmentFromLegacyMarkdownFallback(ydoc, markdown);
}

function persistCanonicalYjsBaseline(
  slug: string,
  row: NonNullable<ReturnType<typeof getDocumentBySlug>>,
  ydoc: Y.Doc,
): PersistedDocState {
  const markdown = stripEphemeralCollabSpans(row.markdown ?? '');
  const marks = parseStoredMarks(row.marks);
  const snapshot = Y.encodeStateAsUpdate(ydoc);
  if (snapshot.byteLength > 0) {
    saveYSnapshot(slug, 1, snapshot);
    replaceDocumentProjection(slug, markdown, marks, 1);
  }

  const updated = getDocumentBySlug(slug);
  const yStateVersion = updated?.y_state_version ?? 1;

  return {
    ydoc,
    updatedAt: updated?.updated_at ?? row.updated_at ?? null,
    yStateVersion,
    accessEpoch: typeof updated?.access_epoch === 'number'
      ? updated.access_epoch
      : typeof row.access_epoch === 'number'
        ? row.access_epoch
        : null,
    stateVector: Y.encodeStateVector(ydoc),
  };
}

function seedLegacyDocumentToPersistedYjs(slug: string, row: NonNullable<ReturnType<typeof getDocumentBySlug>>): PersistedDocState {
  const ydoc = new Y.Doc();
  const markdown = stripEphemeralCollabSpans(row.markdown ?? '');
  const marks = parseStoredMarks(row.marks);

  ydoc.transact(() => {
    ydoc.getText('markdown').insert(0, markdown);
    applyMarksMapDiff(ydoc.getMap('marks'), marks);
    seedFragmentFromLegacyMarkdownFallback(ydoc, markdown);
  }, 'legacy-seed');
  return persistCanonicalYjsBaseline(slug, row, ydoc);
}

async function seedLegacyDocumentToPersistedYjsAsync(
  slug: string,
  row: NonNullable<ReturnType<typeof getDocumentBySlug>>,
): Promise<PersistedDocState> {
  const ydoc = new Y.Doc();
  const markdown = stripEphemeralCollabSpans(row.markdown ?? '');
  const marks = parseStoredMarks(row.marks);

  ydoc.transact(() => {
    ydoc.getText('markdown').insert(0, markdown);
    applyMarksMapDiff(ydoc.getMap('marks'), marks);
  }, 'legacy-seed-markdown');
  await seedFragmentFromLegacyMarkdown(ydoc, markdown);
  return persistCanonicalYjsBaseline(slug, row, ydoc);
}

export async function ensureCanonicalYjsBaselineForDocument(slug: string): Promise<boolean> {
  if (!slug) return false;
  const row = getDocumentBySlug(slug);
  if (!row || row.share_state === 'DELETED' || row.share_state === 'REVOKED') return false;

  const snapshot = getLatestYSnapshot(slug);
  const startSeq = snapshot?.version ?? 0;
  const updates = getYUpdatesAfter(slug, startSeq);
  const persistedYStateVersion = getLatestYStateVersion(slug);
  if (snapshot || updates.length > 0) {
    if (persistedYStateVersion > 0) {
      const projection = getProjectedDocumentBySlug(slug);
      if ((row.y_state_version ?? 0) !== persistedYStateVersion || !projection || projection.projection_y_state_version !== persistedYStateVersion) {
        replaceDocumentProjection(
          slug,
          stripEphemeralCollabSpans(row.markdown ?? ''),
          parseStoredMarks(row.marks),
          persistedYStateVersion,
        );
      }
    }
    return false;
  }

  await seedLegacyDocumentToPersistedYjsAsync(slug, row);
  return true;
}

function readPersistedDocState(slug: string): PersistedDocState {
  const row = getDocumentBySlug(slug);
  let snapshot = getLatestYSnapshot(slug);
  let startSeq = snapshot?.version ?? 0;
  let updates = getYUpdatesAfter(slug, startSeq);

  if (!snapshot && updates.length === 0 && row) {
    console.warn('[collab] seeding missing canonical Yjs baseline from legacy projection row', { slug });
    return seedLegacyDocumentToPersistedYjs(slug, row);
  }

  const ydoc = new Y.Doc();
  if (snapshot) {
    Y.applyUpdate(ydoc, snapshot.snapshot);
  }
  for (const update of updates) {
    Y.applyUpdate(ydoc, update.update);
  }
  ensureFragmentSeededFromMarkdownIfEmptySync(slug, ydoc, 'persisted-fragment-repair');

  return {
    ydoc,
    updatedAt: row?.updated_at ?? null,
    yStateVersion: getLatestYStateVersion(slug),
    accessEpoch: typeof row?.access_epoch === 'number' ? row.access_epoch : null,
    stateVector: Y.encodeStateVector(ydoc),
  };
}

async function readPersistedDocStateAsync(slug: string): Promise<PersistedDocState> {
  const row = getDocumentBySlug(slug);
  const snapshot = getLatestYSnapshot(slug);
  const startSeq = snapshot?.version ?? 0;
  const updates = getYUpdatesAfter(slug, startSeq);

  if (!snapshot && updates.length === 0 && row) {
    console.warn('[collab] seeding missing canonical Yjs baseline from legacy projection row', { slug });
    return seedLegacyDocumentToPersistedYjsAsync(slug, row);
  }

  const ydoc = new Y.Doc();
  if (snapshot) {
    Y.applyUpdate(ydoc, snapshot.snapshot);
  }
  for (const update of updates) {
    Y.applyUpdate(ydoc, update.update);
  }
  await ensureFragmentSeededFromMarkdownIfEmpty(slug, ydoc, 'persisted-fragment-repair');

  return {
    ydoc,
    updatedAt: row?.updated_at ?? null,
    yStateVersion: getLatestYStateVersion(slug),
    accessEpoch: typeof row?.access_epoch === 'number' ? row.access_epoch : null,
    stateVector: Y.encodeStateVector(ydoc),
  };
}

export type CanonicalReadableDocument = DocumentRow & {
  plain_text: string;
  projection_health: DocumentProjectionRow['health'];
  projection_revision: number | null;
  projection_y_state_version: number | null;
  projection_updated_at: string | null;
  projection_fresh: boolean;
  mutation_ready: boolean;
  read_source: 'projection' | 'canonical_row' | 'yjs_fallback';
};

export function isCanonicalReadMutationReady(
  doc: { mutation_ready?: boolean } | null | undefined,
): boolean {
  if (!doc) return false;
  return doc.mutation_ready !== false;
}

function buildReadOnlyLegacyYDoc(row: DocumentRow): Y.Doc {
  const ydoc = new Y.Doc();
  const markdown = stripEphemeralCollabSpans(row.markdown ?? '');
  const marks = parseStoredMarks(row.marks);

  ydoc.transact(() => {
    ydoc.getText('markdown').insert(0, markdown);
    applyMarksMapDiff(ydoc.getMap('marks'), marks);
    seedFragmentFromLegacyMarkdownFallback(ydoc, markdown);
  }, 'legacy-read');

  return ydoc;
}

export function loadCanonicalYDocSync(slug: string): CanonicalYDocHandle | null {
  if (!slug) return null;

  const liveDoc = getLiveHocuspocusDoc(slug);
  if (liveDoc) {
    return {
      ydoc: liveDoc,
      source: 'live',
    };
  }

  const loaded = loadedDocs.get(slug);
  if (loaded) {
    return {
      ydoc: loaded,
      source: 'persisted',
    };
  }

  const row = getDocumentBySlug(slug);
  if (!row) return null;

  const snapshot = getLatestYSnapshot(slug);
  const startSeq = snapshot?.version ?? 0;
  const updates = getYUpdatesAfter(slug, startSeq);
  if (!snapshot && updates.length === 0) {
    return {
      ydoc: buildReadOnlyLegacyYDoc(row),
      source: 'persisted',
    };
  }

  return {
    ydoc: readPersistedDocState(slug).ydoc,
    source: 'persisted',
  };
}

export function isProjectionFresh(doc: ProjectedDocumentRow | null | undefined): boolean {
  if (!doc) return false;
  if (doc.projection_revision === null || doc.projection_y_state_version === null) return false;
  if (doc.projection_health !== 'healthy') return false;
  return doc.projection_y_state_version === doc.y_state_version;
}

function projectionPayloadMatchesCanonical(doc: ProjectedDocumentRow | null | undefined): boolean {
  if (!doc) return false;
  const canonicalMarkdown = typeof doc.canonical_markdown === 'string' ? doc.canonical_markdown : '';
  const canonicalMarks = typeof doc.canonical_marks === 'string' ? doc.canonical_marks : '{}';
  if (doc.markdown !== canonicalMarkdown) return false;
  return stableStringify(parseStoredMarks(doc.marks)) === stableStringify(parseStoredMarks(canonicalMarks));
}

function getProjectionFallbackReason(doc: ProjectedDocumentRow | null | undefined): string {
  if (!doc) return 'missing_document';
  if (doc.projection_revision === null || doc.projection_y_state_version === null) return 'projection_missing';
  if (doc.projection_health !== 'healthy') return `projection_${doc.projection_health}`;
  if (doc.projection_y_state_version !== doc.y_state_version) return 'projection_y_state_version_mismatch';
  if (!projectionPayloadMatchesCanonical(doc)) return 'projection_content_mismatch';
  return 'projection_unavailable';
}

export function getCanonicalReadableDocumentSync(
  slug: string,
  source: 'state' | 'snapshot' | 'share' | 'unknown' = 'unknown',
): CanonicalReadableDocument | undefined {
  const projected = getProjectedDocumentBySlug(slug);
  const projectionFresh = isProjectionFresh(projected);
  const projectionMatchesCanonical = projectionPayloadMatchesCanonical(projected);
  if (projectionFresh && projectionMatchesCanonical) {
    return {
      ...projected,
      projection_fresh: true,
      mutation_ready: true,
      read_source: 'projection',
    };
  }

  const row = getDocumentBySlug(slug);
  if (!row) {
    return projected
      ? {
        ...projected,
        projection_fresh: false,
        mutation_ready: false,
        read_source: 'projection',
      }
      : undefined;
  }

  if (projectionFresh && !projectionMatchesCanonical) {
    recordProjectionReadFallback(source, 'projection_content_mismatch');
    return {
      ...row,
      plain_text: row.markdown,
      projection_health: projected?.projection_health ?? 'projection_stale',
      projection_revision: projected?.projection_revision ?? null,
      projection_y_state_version: projected?.projection_y_state_version ?? null,
      projection_updated_at: projected?.projection_updated_at ?? null,
      projection_fresh: false,
      mutation_ready: true,
      read_source: 'canonical_row',
    };
  }

  const handle = loadCanonicalYDocSync(slug);
  if (!handle) {
    return projected
      ? {
        ...projected,
        projection_fresh: false,
        mutation_ready: false,
        read_source: 'projection',
      }
      : undefined;
  }

  const fallbackReason = getProjectionFallbackReason(projected);
  recordProjectionReadFallback(source, fallbackReason);
  const markdown = stripEphemeralCollabSpans(handle.ydoc.getText('markdown').toString());
  const marks = mergePreservedActionMarks(slug, encodeMarksMap(handle.ydoc.getMap('marks')));
  const rowMarks = parseStoredMarks(row.marks);
  const sanitizedRowMarkdown = stripEphemeralCollabSpans(row.markdown ?? '');
  const mutationReady = sanitizedRowMarkdown === markdown
    && stableStringify(rowMarks) === stableStringify(marks);

  return {
    ...row,
    markdown,
    marks: JSON.stringify(marks),
    plain_text: projected?.plain_text ?? row.markdown,
    projection_health: projected?.projection_health ?? 'projection_stale',
    projection_revision: projected?.projection_revision ?? null,
    projection_y_state_version: projected?.projection_y_state_version ?? null,
    projection_updated_at: projected?.projection_updated_at ?? null,
    projection_fresh: false,
    mutation_ready: mutationReady,
    read_source: 'yjs_fallback',
  };
}

export async function loadCanonicalYDoc(
  slug: string,
  options: { liveRequired?: boolean } = {},
): Promise<CanonicalYDocHandle | null> {
  if (!slug) return null;

  if (runtime.enabled) {
    const existingLiveDoc = getLiveHocuspocusDoc(slug);
    if (existingLiveDoc) {
      return {
        ydoc: existingLiveDoc,
        source: 'live',
      };
    }
    const { doc, cleanup } = await getOrLoadHocuspocusDoc(slug, {
      allowDirectConnection: options.liveRequired === true,
    });
    const registeredLiveDoc = getLiveHocuspocusDoc(slug);
    if (registeredLiveDoc) {
      return {
        ydoc: registeredLiveDoc,
        cleanup,
        source: 'live',
      };
    }
    if (options.liveRequired && doc) {
      await cleanup?.();
      return null;
    }
    if (options.liveRequired) return null;
  }

  const loaded = loadedDocs.get(slug);
  if (loaded) {
    return {
      ydoc: loaded,
      source: 'persisted',
    };
  }

  return {
    ydoc: await hydrateDocFromDbAsync(slug),
    source: 'persisted',
  };
}

export function registerCanonicalYDocPersistence(
  slug: string,
  ydoc: Y.Doc,
  meta: { updatedAt: string | null; yStateVersion: number; accessEpoch: number | null },
): void {
  rememberLoadedDoc(slug, ydoc);
  lastPersistedStateVectors.set(slug, Y.encodeStateVector(ydoc));
  updatesSinceCompaction.set(
    slug,
    Math.max(0, meta.yStateVersion - (getLatestYSnapshot(slug)?.version ?? 0)),
  );
  refreshLoadedDocDbMeta(slug, ydoc, meta.updatedAt, meta.yStateVersion, meta.accessEpoch);
  markSkipNextOnStorePersist(slug, ydoc);
  touchDoc(slug);
}

function refreshLoadedDocDbMetaFromDb(slug: string, ydoc: Y.Doc): void {
  const row = getDocumentBySlug(slug);
  const yStateVersion = getLatestYStateVersion(slug);
  refreshLoadedDocDbMeta(
    slug,
    ydoc,
    row?.updated_at ?? null,
    yStateVersion,
    typeof row?.access_epoch === 'number' ? row.access_epoch : null,
  );
}

async function hydrateDocFromDbAsync(slug: string): Promise<Y.Doc> {
  const persisted = await readPersistedDocStateAsync(slug);
  const ydoc = persisted.ydoc;
  docPersistGenerations.set(ydoc, getPersistGeneration(slug));
  lastPersistedStateVectors.set(slug, persisted.stateVector);
  updatesSinceCompaction.set(slug, 0);
  refreshLoadedDocDbMeta(slug, ydoc, persisted.updatedAt, persisted.yStateVersion, persisted.accessEpoch);
  touchDoc(slug);
  return ydoc;
}

async function persistDoc(
  slug: string,
  ydoc: Y.Doc,
  sourceActor: string = 'collab',
  expectedGeneration: number | null = null,
): Promise<void> {
  if (persistInFlight.get(slug)) {
    persistPending.set(slug, { ydoc, sourceActor, expectedGeneration });
    return;
  }
  if (isCollabPersistenceReadOnly()) {
    if (!warnedReadOnlyPersistSlugs.has(slug)) {
      warnedReadOnlyPersistSlugs.add(slug);
      console.warn('[collab] COLLAB_PERSIST_READONLY is enabled; skipping document persistence', { slug });
    }
    return;
  }
  const docRow = getDocumentBySlug(slug);
  if (docRow?.share_state === 'REVOKED' || docRow?.share_state === 'DELETED') {
    evictLocalDocState(slug);
    persistPending.delete(slug);
    persistInFlight.delete(slug);
    return;
  }
  if (collabInvalidations.has(slug)) {
    persistPending.delete(slug);
    return;
  }
  const currentGeneration = getPersistGeneration(slug);
  if (expectedGeneration !== null && expectedGeneration !== currentGeneration) {
    persistPending.delete(slug);
    console.warn('[collab] stale collab write dropped', {
      slug,
      source: 'persistDoc',
      reason: 'persist_generation_mismatch',
      sourceActor,
      expectedGeneration,
      currentGeneration,
    });
    return;
  }
  if (sourceActor === 'collab') {
    const docGeneration = docPersistGenerations.get(ydoc);
    if (typeof docGeneration === 'number' && docGeneration !== currentGeneration) {
      persistPending.delete(slug);
      console.warn('[collab] stale collab write dropped', {
        slug,
        source: 'persistDoc',
        reason: 'doc_generation_mismatch',
        sourceActor,
        docGeneration,
        currentGeneration,
      });
      return;
    }
    const currentLoadedDoc = loadedDocs.get(slug);
    if (currentLoadedDoc && currentLoadedDoc !== ydoc) {
      persistPending.delete(slug);
      console.warn('[collab] stale collab write dropped', {
        slug,
        source: 'persistDoc',
        reason: 'superseded_doc_reference',
        sourceActor,
      });
      return;
    }
    const loadedMeta = loadedDocDbMeta.get(slug);
    if (loadedMeta && typeof docRow?.access_epoch === 'number' && loadedMeta.accessEpoch !== docRow.access_epoch) {
      logStaleEpochWrite(slug, 'persistDoc', {
        reason: 'access_epoch_mismatch',
        sourceActor,
        loadedAccessEpoch: loadedMeta.accessEpoch,
        currentAccessEpoch: docRow.access_epoch,
      });
      persistPending.delete(slug);
      return;
    }
  }
  if (sourceActor === 'collab') {
    const loadedMeta = loadedDocDbMeta.get(slug);
    const row = getDocumentBySlug(slug);
    const currentUpdatedAt = row?.updated_at ?? null;
    const currentYStateVersion = getLatestYStateVersion(slug);
    const shouldResolveConflict = !loadedMeta
      || loadedMeta.updatedAt !== currentUpdatedAt
      || loadedMeta.yStateVersion !== currentYStateVersion;
    if (shouldResolveConflict) {
      const resolution = resolveOnStoreConflict(slug, ydoc);
      if (resolution.action === 'reload') {
        if (resolution.accessEpochChanged) {
          logStaleEpochWrite(slug, 'persistDoc', {
            reason: resolution.reason,
            sourceActor,
            loadedAccessEpoch: loadedMeta?.accessEpoch ?? null,
            currentAccessEpoch: resolution.persistedState.accessEpoch,
          });
        }
        applyPersistedStateToLoadedDoc(slug, resolution.persistedState);
        if (!resolution.logSuppressed) {
          console.warn('[collab_stale_onstore_reload]', {
            slug,
            reason: resolution.reason,
            accessEpochChanged: resolution.accessEpochChanged,
            projectionDrift: resolution.projectionDrift,
            loadedUpdatedAt: resolution.loadedUpdatedAt,
            currentUpdatedAt: resolution.currentUpdatedAt,
            loadedYStateVersion: resolution.loadedYStateVersion,
            currentYStateVersion: resolution.currentYStateVersion,
            dbMissingBytes: resolution.dbMissingBytes,
            localUnsavedBytes: resolution.localUnsavedBytes,
            sourceActor,
          });
        }
        scheduleStaleOnStoreReload(slug);
        persistPending.delete(slug);
        return;
      }
    }
  }
  let queuedRepairReason: string | null = null;
  let projectionMarkdownOverride: string | null = null;
  let skipProjectionWriteDueToDeriveFailure = false;
  try {
    const refreshed = await refreshMarkdownTextFromFragment(slug, ydoc, 'server-projection-refresh');
    if (refreshed.deriveFailed) {
      skipProjectionWriteDueToDeriveFailure = true;
      queuedRepairReason = queuedRepairReason ?? 'derive_fragment_markdown_failed';
    } else if (refreshed.refreshed && typeof refreshed.markdown === 'string') {
      projectionMarkdownOverride = refreshed.markdown;
    }
  } catch (error) {
    console.warn('[collab] failed to refresh projection markdown from fragment before persist', {
      slug,
      sourceActor,
      error: summarizeParseError(error),
    });
  }
  const generation = currentGeneration;
  persistInFlight.set(slug, true);
  const startedAt = Date.now();
  try {
    if ((persistGeneration.get(slug) ?? 0) !== generation || collabInvalidations.has(slug)) {
      return;
    }
    const priorVector = lastPersistedStateVectors.get(slug);
    const deltaUpdate = priorVector
      ? Y.encodeStateAsUpdate(ydoc, priorVector)
      : Y.encodeStateAsUpdate(ydoc);
    const compactionInterval = parsePositiveInt(
      process.env.COLLAB_COMPACTION_EVERY,
      DEFAULT_COLLAB_COMPACTION_EVERY,
    );
    const priorUpdateCount = updatesSinceCompaction.get(slug) ?? 0;
    let nextUpdateCount = priorUpdateCount;
    const shouldMaterializeProjection = sourceActor === 'collab';
    let shouldBumpRevision = shouldMaterializeProjection;
    const db = getDb();
    let aborted = false;
    const persistTx = db.transaction(() => {
      if ((persistGeneration.get(slug) ?? 0) !== generation || collabInvalidations.has(slug)) {
        aborted = true;
        return;
      }
      // Read docRow inside the transaction to avoid stale comparisons
      let shouldWriteProjection = true;
      if (shouldMaterializeProjection) {
        if (skipProjectionWriteDueToDeriveFailure) {
          shouldWriteProjection = false;
          setDocumentProjectionHealth(slug, 'projection_stale');
          recordProjectionMarkedStale('derive_fragment_markdown_failed', 'persist');
        } else {
          const currentRow = getDocumentBySlug(slug);
          const markdownText = projectionMarkdownOverride ?? ydoc.getText('markdown').toString();
          const marksMap = ydoc.getMap('marks');
          const marks = mergePreservedActionMarks(slug, encodeMarksMap(marksMap));
          if (currentRow) {
            const projectedRow = getProjectedDocumentBySlug(slug);
            const storedMarks = parseStoredMarks(currentRow.marks);
            const marksUnchanged = stableStringify(storedMarks) === stableStringify(marks);
            const markdownUnchanged = currentRow.markdown === markdownText;
            if (marksUnchanged && markdownUnchanged) {
              if (isProjectionFresh(projectedRow)) {
                shouldWriteProjection = false;
              } else {
                // Projection is stale but the canonical markdown/marks are unchanged.
                // Heal the projection without bumping the document revision.
                shouldBumpRevision = false;
              }
            } else {
              const safety = evaluateProjectionSafety(currentRow.markdown, markdownText, ydoc);
              if (!safety.safe) {
                const reason = safety.reason || 'unsafe_projection';
                shouldWriteProjection = false;
                setDocumentProjectionHealth(slug, 'projection_stale');
                recordProjectionMarkedStale(reason, 'persist');
                const fingerprint = buildProjectionPathologyFingerprint(reason, safety.details, {
                  baselineChars: currentRow.markdown.length,
                  candidateChars: markdownText.length,
                });
                const pathology = registerProjectionPathologyCooldown(
                  projectionPathologyCooldowns,
                  slug,
                  reason,
                  fingerprint,
                );
                if (!pathology.suppressed) {
                  queuedRepairReason = queuedRepairReason ?? reason;
                  recordProjectionGuardBlock(reason, 'persist');
                  if (reason === 'fragment_markdown_drift') {
                    recordProjectionDrift(reason, 'persist');
                  }
                  console.error('[collab] blocked unsafe projection write; keeping canonical DB projection', {
                    slug,
                    reason,
                    details: safety.details,
                    baselineChars: currentRow.markdown.length,
                    candidateChars: markdownText.length,
                  });
                }
              }
            }
          }
        }
      }
      if (deltaUpdate.byteLength > 0) {
        const seq = appendYUpdate(slug, deltaUpdate, sourceActor);
        nextUpdateCount = priorUpdateCount + 1;
        if (nextUpdateCount >= compactionInterval) {
          const fullSnapshot = Y.encodeStateAsUpdate(ydoc);
          saveYSnapshot(slug, seq, fullSnapshot);
          nextUpdateCount = 0;
        }
      }
      if (shouldWriteProjection) {
        clearAllSlugPathologyCooldowns(slug);
        materializeProjection(slug, ydoc, {
          bumpRevision: shouldBumpRevision,
          refreshSnapshot: false,
          source: 'persist',
        });
      } else if (deltaUpdate.byteLength > 0) {
        // Still advance y_state_version even when skipping projection writes
        // to prevent repeated stale-projection detection on startup.
        const yStateVersion = getLatestYStateVersion(slug);
        db.prepare('UPDATE documents SET y_state_version = ? WHERE slug = ? AND share_state IN (\'ACTIVE\', \'PAUSED\')').run(yStateVersion, slug);
      }
    });
    persistTx();
    if (aborted) {
      return;
    }
    if (deltaUpdate.byteLength > 0) {
      updatesSinceCompaction.set(slug, nextUpdateCount);
    }
    if (queuedRepairReason) {
      queueProjectionRepair(slug, queuedRepairReason);
    }
    lastPersistedStateVectors.set(slug, Y.encodeStateVector(ydoc));
    refreshLoadedDocDbMetaFromDb(slug, ydoc);
    refreshSnapshotForSlug(slug);
  } catch (error) {
    console.error('[collab] Failed to persist document:', { slug, error });
    const currentRow = getDocumentBySlug(slug);
    if (currentRow?.share_state === 'REVOKED' || currentRow?.share_state === 'DELETED') {
      evictLocalDocState(slug);
      persistPending.delete(slug);
      return;
    }
    if ((persistGeneration.get(slug) ?? 0) !== generation || collabInvalidations.has(slug)) {
      return;
    }
    schedulePersistDoc(slug, ydoc);
  } finally {
    persistInFlight.delete(slug);
    recordProjectionLag(Date.now() - startedAt);
    const pending = persistPending.get(slug);
    if (pending) {
      persistPending.delete(slug);
      void persistDoc(slug, pending.ydoc, pending.sourceActor, pending.expectedGeneration);
    }
  }
}

function schedulePersistDoc(slug: string, ydoc: Y.Doc): void {
  const debounceMs = parsePositiveInt(process.env.COLLAB_PERSIST_DEBOUNCE_MS, DEFAULT_COLLAB_PERSIST_DEBOUNCE_MS);
  const expectedGeneration = getPersistGeneration(slug);
  if (!docPersistGenerations.has(ydoc)) {
    docPersistGenerations.set(ydoc, expectedGeneration);
  }
  const existing = persistTimers.get(slug);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    persistTimers.delete(slug);
    void persistDoc(slug, ydoc, 'collab', expectedGeneration);
  }, debounceMs);
  persistTimers.set(slug, timer);
}

function registerStaleOnStoreDriftSuppression(
  slug: string,
  reason: string,
  extras: Record<string, unknown>,
): ProjectionPathologyCooldownResult {
  return registerPathologyCooldown(
    staleOnStoreDriftCooldowns,
    slug,
    reason,
    buildStaleOnStoreSuppressionFingerprint(reason, extras),
    Date.now(),
    parsePositiveInt(
      process.env.COLLAB_STALE_ONSTORE_DRIFT_COOLDOWN_MS,
      DEFAULT_STALE_ONSTORE_DRIFT_COOLDOWN_MS,
    ),
  );
}

function maybeLogStaleOnStoreSuppressionSummary(slug: string, reason: string, suppressedCount: number): void {
  if (!shouldEmitSuppressionSummary(suppressedCount)) return;
  console.warn('[collab] suppressed repeated stale onStore drift logs', {
    slug,
    reason,
    suppressedCount,
  });
}

type StoreConflictResolution =
  | { action: 'persist' }
  | {
      action: 'reload';
      persistedState: PersistedDocState;
      reason: 'access_epoch_mismatch' | 'projection_drift_onstore_reload' | 'concurrent_external_edit';
      accessEpochChanged: boolean;
      projectionDrift: boolean;
      loadedUpdatedAt: string | null;
      currentUpdatedAt: string | null;
      loadedYStateVersion: number;
      currentYStateVersion: number;
      dbMissingBytes: number;
      localUnsavedBytes: number;
      logSuppressed?: boolean;
    };

function applyPersistedStateToLoadedDoc(slug: string, persistedState: PersistedDocState): void {
  const liveDoc = getLiveHocuspocusDoc(slug);
  const nextDoc = liveDoc ?? persistedState.ydoc;
  rememberLoadedDoc(slug, nextDoc);
  touchDoc(slug);
  lastPersistedStateVectors.set(slug, persistedState.stateVector);
  updatesSinceCompaction.set(slug, 0);
  setLoadedDocDbMeta(
    slug,
    persistedState.updatedAt,
    persistedState.yStateVersion,
    persistedState.accessEpoch,
    persistedState.stateVector,
  );
}

function scheduleStaleOnStoreReload(slug: string): void {
  cancelPendingPersistWork(slug, { advanceGeneration: true });
  collabInvalidations.add(slug);
  setTimeout(() => {
    void invalidateLoadedCollabDocumentAndWait(slug).catch((error) => {
      console.error('[collab] Failed to reload stale live doc after onStore conflict:', { slug, error });
    });
  }, 0);
}

function resolveOnStoreConflict(slug: string, inMemoryDoc: Y.Doc): StoreConflictResolution {
  const loadedMeta = loadedDocDbMeta.get(slug);
  if (!loadedMeta) {
    // Missing metadata can happen after local eviction/reload races while a live room
    // is still active. Never blindly persist in-memory state over DB in this case.
    const persistedState = readPersistedDocState(slug);
    const dbMissingInMemory = Y.encodeStateAsUpdate(
      persistedState.ydoc,
      Y.encodeStateVector(inMemoryDoc),
    );
    if (dbMissingInMemory.byteLength > 0) {
      const inMemoryMissingDb = Y.encodeStateAsUpdate(inMemoryDoc, persistedState.stateVector);
      const hasLocalOnlyDelta = inMemoryMissingDb.byteLength > 0;
      return {
        action: 'reload',
        persistedState,
        reason: 'concurrent_external_edit',
        accessEpochChanged: false,
        projectionDrift: false,
        loadedUpdatedAt: null,
        currentUpdatedAt: persistedState.updatedAt,
        loadedYStateVersion: -1,
        currentYStateVersion: persistedState.yStateVersion,
        dbMissingBytes: dbMissingInMemory.byteLength,
        localUnsavedBytes: hasLocalOnlyDelta ? inMemoryMissingDb.byteLength : 0,
      };
    }

    refreshLoadedDocDbMetaFromDb(slug, inMemoryDoc);
    return { action: 'persist' };
  }

  const row = getDocumentBySlug(slug);
  const currentUpdatedAt = row?.updated_at ?? null;
  const currentYStateVersion = getLatestYStateVersion(slug);
  const currentAccessEpoch = typeof row?.access_epoch === 'number' ? row.access_epoch : null;
  if (currentAccessEpoch !== null && loadedMeta.accessEpoch !== currentAccessEpoch) {
    const persistedState = readPersistedDocState(slug);
    return {
      action: 'reload',
      persistedState,
      reason: 'access_epoch_mismatch',
      accessEpochChanged: true,
      projectionDrift: false,
      loadedUpdatedAt: loadedMeta.updatedAt,
      currentUpdatedAt,
      loadedYStateVersion: loadedMeta.yStateVersion,
      currentYStateVersion,
      dbMissingBytes: 0,
      localUnsavedBytes: 0,
    };
  }
  const versionChanged = loadedMeta.updatedAt !== currentUpdatedAt
    || loadedMeta.yStateVersion !== currentYStateVersion;
  const rowMarkdown = row?.markdown ?? '';
  const rowMarks = parseStoredMarks(row?.marks);
  const inMemoryMarkdown = inMemoryDoc.getText('markdown').toString();
  const inMemoryMarks = encodeMarksMap(inMemoryDoc.getMap('marks'));
  const projectionDrift = rowMarkdown !== inMemoryMarkdown
    || stableStringify(rowMarks) !== stableStringify(inMemoryMarks);
  if (!versionChanged && !projectionDrift) return { action: 'persist' };

  const persistedState = readPersistedDocState(slug);
  const dbMissingInMemory = Y.encodeStateAsUpdate(
    persistedState.ydoc,
    Y.encodeStateVector(inMemoryDoc),
  );
  if (dbMissingInMemory.byteLength === 0) {
    return { action: 'persist' };
  }

  const localDeltaSinceBaseline = Y.encodeStateAsUpdate(inMemoryDoc, loadedMeta.baselineStateVector);
  if (localDeltaSinceBaseline.byteLength === 0) {
    let logSuppressed = false;
    if (projectionDrift) {
      const reason = 'projection_drift_onstore_skip';
      const suppressionExtras = {
        skipSubtype: 'db_newer_projection_drift_skip',
        loadedUpdatedAt: loadedMeta.updatedAt,
        currentUpdatedAt,
        loadedYStateVersion: loadedMeta.yStateVersion,
        currentYStateVersion,
        projectionDrift,
      };
      const pathology = registerStaleOnStoreDriftSuppression(slug, reason, suppressionExtras);
      if (!pathology.suppressed) {
        recordProjectionDrift(reason, 'persist');
        queueProjectionRepair(slug, reason);
      } else {
        recordCollabLogSuppressed('stale_onstore_drift', reason);
        maybeLogStaleOnStoreSuppressionSummary(slug, reason, pathology.suppressedCount);
        logSuppressed = true;
      }
    }
    return {
      action: 'reload',
      persistedState,
      reason: projectionDrift ? 'projection_drift_onstore_reload' : 'concurrent_external_edit',
      accessEpochChanged: false,
      projectionDrift,
      loadedUpdatedAt: loadedMeta.updatedAt,
      currentUpdatedAt,
      loadedYStateVersion: loadedMeta.yStateVersion,
      currentYStateVersion,
      dbMissingBytes: dbMissingInMemory.byteLength,
      localUnsavedBytes: 0,
      logSuppressed,
    };
  }

  let logSuppressed = false;
  if (projectionDrift) {
    // When canonical markdown/marks and in-memory projection have drifted, merging
    // stale local deltas can duplicate large sections of text. Prefer canonical DB.
    const reason = 'projection_drift_onstore_skip';
    const suppressionExtras = {
      skipSubtype: 'projection_drift_merge_skip',
      loadedUpdatedAt: loadedMeta.updatedAt,
      currentUpdatedAt,
      loadedYStateVersion: loadedMeta.yStateVersion,
      currentYStateVersion,
    };
    const pathology = registerStaleOnStoreDriftSuppression(slug, reason, suppressionExtras);
    if (!pathology.suppressed) {
      recordProjectionDrift(reason, 'persist');
      queueProjectionRepair(slug, reason);
    } else {
      recordCollabLogSuppressed('stale_onstore_drift', reason);
      maybeLogStaleOnStoreSuppressionSummary(slug, reason, pathology.suppressedCount);
      logSuppressed = true;
    }
  }

  return {
    action: 'reload',
    persistedState,
    reason: projectionDrift ? 'projection_drift_onstore_reload' : 'concurrent_external_edit',
    accessEpochChanged: false,
    projectionDrift,
    loadedUpdatedAt: loadedMeta.updatedAt,
    currentUpdatedAt,
    loadedYStateVersion: loadedMeta.yStateVersion,
    currentYStateVersion,
    dbMissingBytes: dbMissingInMemory.byteLength,
    localUnsavedBytes: localDeltaSinceBaseline.byteLength,
    logSuppressed,
  };
}

async function persistOnStoreDocument(slug: string, inMemoryDoc: Y.Doc): Promise<void> {
  if (isCollabPersistenceReadOnly()) {
    if (!warnedReadOnlyPersistSlugs.has(slug)) {
      warnedReadOnlyPersistSlugs.add(slug);
      console.warn('[collab] COLLAB_PERSIST_READONLY is enabled; skipping onStoreDocument persistence', { slug });
    }
    return;
  }
  try {
    const refreshed = await refreshMarkdownTextFromFragment(slug, inMemoryDoc, 'server-projection-refresh');
    if (refreshed.deriveFailed) {
      queueProjectionRepair(slug, 'derive_fragment_markdown_failed');
    }
  } catch (error) {
    console.warn('[collab] failed to refresh projection markdown from fragment before onStoreDocument conflict resolution', {
      slug,
      error: summarizeParseError(error),
    });
  }
  const resolution = resolveOnStoreConflict(slug, inMemoryDoc);
  if (resolution.action === 'reload') {
    if (resolution.accessEpochChanged) {
      logStaleEpochWrite(slug, 'onStoreDocument', {
        reason: resolution.reason,
        loadedAccessEpoch: loadedDocDbMeta.get(slug)?.accessEpoch ?? null,
        currentAccessEpoch: resolution.persistedState.accessEpoch,
      });
    }
    applyPersistedStateToLoadedDoc(slug, resolution.persistedState);
    if (!resolution.logSuppressed) {
      if (resolution.projectionDrift) {
        console.warn('[collab] Stale onStoreDocument merge skipped due projection drift', {
          slug,
          reason: resolution.reason,
          loadedUpdatedAt: resolution.loadedUpdatedAt,
          currentUpdatedAt: resolution.currentUpdatedAt,
          loadedYStateVersion: resolution.loadedYStateVersion,
          currentYStateVersion: resolution.currentYStateVersion,
        });
      }
      console.warn('[collab_stale_onstore_reload]', {
        slug,
        reason: resolution.reason,
        accessEpochChanged: resolution.accessEpochChanged,
        projectionDrift: resolution.projectionDrift,
        loadedUpdatedAt: resolution.loadedUpdatedAt,
        currentUpdatedAt: resolution.currentUpdatedAt,
        loadedYStateVersion: resolution.loadedYStateVersion,
        currentYStateVersion: resolution.currentYStateVersion,
        dbMissingBytes: resolution.dbMissingBytes,
        localUnsavedBytes: resolution.localUnsavedBytes,
      });
    }
    scheduleStaleOnStoreReload(slug);
    return;
  }
  await persistDoc(slug, inMemoryDoc);
}

function applyYTextDiff(target: Y.Text, nextValue: string): void {
  const currentValue = target.toString();
  if (currentValue === nextValue) return;

  let prefix = 0;
  const maxPrefix = Math.min(currentValue.length, nextValue.length);
  while (prefix < maxPrefix && currentValue.charCodeAt(prefix) === nextValue.charCodeAt(prefix)) {
    prefix += 1;
  }

  let currentSuffix = currentValue.length;
  let nextSuffix = nextValue.length;
  while (
    currentSuffix > prefix
    && nextSuffix > prefix
    && currentValue.charCodeAt(currentSuffix - 1) === nextValue.charCodeAt(nextSuffix - 1)
  ) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  const deleteLength = currentSuffix - prefix;
  if (deleteLength > 0) {
    target.delete(prefix, deleteLength);
  }
  if (nextSuffix > prefix) {
    target.insert(prefix, nextValue.slice(prefix, nextSuffix));
  }
}

function replaceYXmlFragment(fragment: Y.XmlFragment, pmDoc: unknown): void {
  const length = fragment.length;
  if (length > 0) {
    fragment.delete(0, length);
  }
  prosemirrorToYXmlFragment(pmDoc as any, fragment as any);
}

function isProsemirrorFragmentStructurallyEmpty(fragment: Y.XmlFragment | null | undefined): boolean {
  if (!fragment) return true;
  const length = fragment.length;
  if (length === 0) return true;
  if (length !== 1) return false;

  const first = typeof (fragment as any).get === 'function'
    ? (fragment as any).get(0)
    : typeof (fragment as any).toArray === 'function'
      ? (fragment as any).toArray()[0]
      : null;
  if (!first) return true;
  if (first.nodeName !== 'paragraph') return false;
  try {
    if (String(first) === '<paragraph></paragraph>') return true;
  } catch {
    // ignore
  }
  return typeof first.length === 'number' ? first.length === 0 : false;
}

function normalizeFragmentPlainText(input: string): string {
  return input
    .replace(/\u2060/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getFragmentTextHashFromDoc(ydoc: Y.Doc, schema: Schema): string | null {
  try {
    const root = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('prosemirror') as any, schema as any) as ProseMirrorNode;
    const textContent = normalizeFragmentPlainText(root?.textContent ?? '');
    return hashText(textContent);
  } catch {
    return null;
  }
}

export async function computeFragmentTextHashFromMarkdown(markdown: string): Promise<string | null> {
  try {
    const parser = await getHeadlessMilkdownParser();
    const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
    if (!parsed.doc) return null;
    const doc = parsed.doc;
    const textContent = normalizeFragmentPlainText(doc?.textContent ?? '');
    return hashText(textContent);
  } catch {
    return null;
  }
}

export function stripEphemeralCollabSpans(markdown: string): string {
  if (!markdown || markdown.indexOf('<span') === -1) return markdown;

  const cursorSpanPattern = /<span\b[^>]*(?:ProseMirror-yjs-cursor|proof-collab-cursor|proof-agent-cursor|data-proof-cursor|data-agent-cursor)[^>]*>[\s\S]*?<\/span>/gi;
  let sanitized = markdown;
  let previous = '';
  while (sanitized !== previous) {
    previous = sanitized;
    sanitized = sanitized.replace(cursorSpanPattern, '');
  }

  // y-prosemirror cursor widgets use WORD JOINER separators (U+2060) around labels.
  sanitized = sanitized.replace(/\u2060/g, '');

  return sanitized;
}

function normalizeMarkdownForVerification(markdown: string): string {
  return stripEphemeralCollabSpans(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/g, '');
}

function applyMarksMapDiff(map: Y.Map<unknown>, next: Record<string, unknown>): void {
  const nextKeys = new Set(Object.keys(next));
  for (const key of Array.from(map.keys())) {
    if (!nextKeys.has(key)) map.delete(key);
  }
  for (const [key, value] of Object.entries(next)) {
    map.set(key, value as unknown);
  }
}

type CollabExternalApplyOptions = {
  markdown?: string;
  marks?: Record<string, unknown>;
  source?: string;
};

const externalApplyQueues = new Map<string, Promise<boolean>>();

function getLiveHocuspocusDoc(slug: string): Y.Doc | null {
  if (!slug) return null;
  const instance = hocuspocusInstance as any;
  if (!instance) return null;
  try {
    const entry = instance.documents?.get?.(slug) ?? null;
    // Hocuspocus may store either a Y.Doc directly, or a wrapper containing the doc.
    if (entry && typeof entry.getText === 'function') return entry as Y.Doc;
    const candidates = [
      entry?.document,
      entry?.ydoc,
      entry?.doc,
      entry?._doc,
      entry?.value?.document,
      entry?.value?.ydoc,
      entry?.value?.doc,
      entry?.state?.document,
      entry?.state?.ydoc,
      entry?.state?.doc,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate.getText === 'function') return candidate as Y.Doc;
    }
  } catch {
    // ignore
  }
  return null;
}

type DirectConnectionLike = {
  document?: Y.Doc | null;
  disconnect?: () => void | Promise<void>;
};

async function getOrLoadHocuspocusDoc(
  slug: string,
  options: { allowDirectConnection?: boolean } = {},
): Promise<{ doc: Y.Doc | null; cleanup?: () => Promise<void> }> {
  const existing = getLiveHocuspocusDoc(slug);
  if (existing) return { doc: existing };
  if (!options.allowDirectConnection) return { doc: null };

  const instance = hocuspocusInstance as any;
  const openDirectConnection = instance?.openDirectConnection;
  if (typeof openDirectConnection !== 'function') return { doc: null };
  const directConnectionTimeoutMs = parsePositiveInt(
    process.env.COLLAB_DIRECT_CONNECTION_TIMEOUT_MS,
    DEFAULT_DIRECT_CONNECTION_TIMEOUT_MS,
  );

  // Force-load the document into Hocuspocus so external writes can be applied to the
  // same Y.Doc that connected collaborators are subscribed to.
  let direct: DirectConnectionLike | null = null;
  let directTimedOut = false;
  try {
    const directPromise = Promise.resolve(
      openDirectConnection.call(instance, slug, { source: 'external-write' }),
    ) as Promise<DirectConnectionLike | null | undefined>;
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        directTimedOut = true;
        resolve(null);
      }, directConnectionTimeoutMs);
    });
    direct = await Promise.race([directPromise, timeoutPromise]) as DirectConnectionLike | null;
    if (directTimedOut) {
      void directPromise.then((lateDirect) => Promise.resolve(lateDirect?.disconnect?.()).catch(() => {})).catch(() => {});
      console.warn('[collab] direct live-doc connection timed out', { slug, timeoutMs: directConnectionTimeoutMs });
      direct = null;
    }
  } catch {
    direct = null;
  }

  const doc = direct?.document ?? null;
  const cleanup = async () => {
    try {
      await Promise.resolve(direct?.disconnect?.());
    } catch {
      // best-effort
    }
    try {
      const key = `onStoreDocument-${slug}`;
      const debouncer = instance?.debouncer;
      if (typeof debouncer?.cancel === 'function') {
        debouncer.cancel(key);
      } else if (typeof debouncer?.clear === 'function') {
        debouncer.clear(key);
      } else if (typeof debouncer?.remove === 'function') {
        debouncer.remove(key);
      } else if (typeof debouncer?.delete === 'function') {
        debouncer.delete(key);
      }
    } catch {
      // best-effort
    }
  };

  if (doc && typeof (doc as any).getText === 'function') return { doc, cleanup };
  if (direct) return { doc: null, cleanup };
  return { doc: null };
}

async function applyCanonicalDocumentToCollabInner(
  slug: string,
  options: CollabExternalApplyOptions,
): Promise<boolean> {
  if (!slug) return false;
  if (!runtime.enabled) return false;

  const instance = hocuspocusInstance as any;
  const hasHocuspocusEntry = Boolean(instance?.documents?.has?.(slug));
  const hadLiveDoc = loadedDocs.has(slug) || hasHocuspocusEntry;

  const hadLoadedDoc = loadedDocs.has(slug);
  const { doc: hocuspocusDoc, cleanup } = await getOrLoadHocuspocusDoc(slug, {
    allowDirectConnection: hadLiveDoc,
  });
  const liveDocSource = hocuspocusDoc
    ? 'hocuspocus'
    : hadLoadedDoc
      ? 'loadedDocs'
      : 'hydrated';

  if (hasHocuspocusEntry && !hocuspocusDoc) {
    console.warn('[collab] Live Hocuspocus doc entry exists but was not retrievable; refusing shadow apply', { slug });
    await cleanup?.();
    return false;
  }

  // Prefer the document that Hocuspocus currently serves to clients.
  let ydoc: Y.Doc | null = hocuspocusDoc ?? loadedDocs.get(slug) ?? null;

  if (!ydoc) {
    ydoc = await hydrateDocFromDbAsync(slug);
  }

  const { markdown, marks, source } = options;
  const origin = source ?? 'external-write';
  const debugConvergence = (process.env.COLLAB_DEBUG_FRAGMENT_CONVERGENCE || '').trim() === '1';

  const sanitizedMarkdown = typeof markdown === 'string'
    ? stripEphemeralCollabSpans(markdown)
    : undefined;

  let preMarkdownHash: string | null = null;
  let preFragmentTextHash: string | null = null;
  let postMarkdownHash: string | null = null;
  let postFragmentTextHash: string | null = null;
  let pmDocParsed = false;
  let debugSchema: Schema | null = null;
  if (debugConvergence) {
    try {
      debugSchema = (await getHeadlessMilkdownParser()).schema;
    } catch {
      debugSchema = null;
    }
    try {
      preMarkdownHash = hashText(ydoc.getText('markdown').toString());
    } catch {
      preMarkdownHash = null;
    }
    if (debugSchema) {
      preFragmentTextHash = getFragmentTextHashFromDoc(ydoc, debugSchema);
    }
  }

  try {
    let pmDoc: ProseMirrorNode | null = null;
    if (sanitizedMarkdown !== undefined) {
      const parser = await getHeadlessMilkdownParser();
      const parsed = parseMarkdownWithHtmlFallback(parser, sanitizedMarkdown);
      try {
        pmDoc = parsed.doc;
        if (!pmDoc) {
          throw parsed.error ?? new Error('unknown_markdown_parse_error');
        }
        pmDocParsed = true;
        if (parsed.mode !== 'original') {
          console.warn('[collab] canonical markdown parsed via HTML fallback mode', { slug, mode: parsed.mode });
        }
      } catch (error) {
        console.error('[collab] Failed to parse canonical markdown; falling back to plain text doc:', {
          slug,
          error: summarizeParseError(error),
        });
        // Never declare success if a live room is present but we cannot update its fragment.
        // A DB-only fallback in this state causes split-brain (API shows new markdown while
        // connected viewers continue rendering stale fragment state).
        if (hasHocuspocusEntry || hocuspocusDoc) {
          console.warn('[collab] Parse failure with live collab room; refusing DB-only fallback to avoid split-brain', { slug });
          return false;
        }
        // If there is no live room, persist only to keep canonical/Yjs state aligned for
        // future reconnects without discarding rich formatting for active clients.
        console.warn('[collab] Parse failure without live collab room; using DB-only persist fallback', { slug });
        return await reconcileCanonicalDocumentToYjs(slug, 'canonical-reconcile', { forcePersistOnly: true });
      }
    }

    ydoc.transact(() => {
      if (pmDoc) {
        const fragment = ydoc!.getXmlFragment('prosemirror');
        // Authoritative external writes should replace fragment state to avoid stale merge duplication.
        replaceYXmlFragment(fragment, pmDoc);
      }
      if (sanitizedMarkdown !== undefined) {
        applyYTextDiff(ydoc!.getText('markdown'), sanitizedMarkdown);
      }
      if (marks) {
        applyMarksMapDiff(ydoc!.getMap('marks'), marks);
      }
    }, origin);

    touchDoc(slug);

    // Persist immediately so DB projection and Yjs persistence stay consistent.
    const pending = persistTimers.get(slug);
    if (pending) {
      clearTimeout(pending);
      persistTimers.delete(slug);
    }
    rememberLoadedDoc(slug, ydoc);
    const currentRow = getDocumentBySlug(slug);
    refreshLoadedDocDbMeta(
      slug,
      ydoc,
      currentRow?.updated_at ?? null,
      getLatestYStateVersion(slug),
      typeof currentRow?.access_epoch === 'number' ? currentRow.access_epoch : null,
    );
    markSkipNextOnStorePersist(slug, ydoc);
    // When applying canonical external writes, always persist the full Yjs state (not a
    // delta from the prior vector).  The Yjs WAL may have been cleared by a preceding
    // invalidation barrier, so a delta-only update would be unreadable without its base.
    lastPersistedStateVectors.delete(slug);
    await persistDoc(slug, ydoc, origin);

    if (debugConvergence) {
      try {
        postMarkdownHash = hashText(ydoc.getText('markdown').toString());
      } catch {
        postMarkdownHash = null;
      }
      if (debugSchema) {
        postFragmentTextHash = getFragmentTextHashFromDoc(ydoc, debugSchema);
      }
      console.info('[collab] canonical apply diagnostics', {
        slug,
        origin,
        pmDocParsed,
        liveDocSource,
        preMarkdownHash,
        postMarkdownHash,
        preFragmentTextHash,
        postFragmentTextHash,
      });
    }

    // If we created the doc just for persistence (no connected clients), don't keep it
    // in memory. Future connects will hydrate from DB/Yjs updates.
    if (!hadLiveDoc) {
      loadedDocs.delete(slug);
      lastPersistedStateVectors.delete(slug);
      updatesSinceCompaction.delete(slug);
      loadedDocDbMeta.delete(slug);
      docLastAccessedAt.delete(slug);
    }

    return true;
  } finally {
    await cleanup?.();
  }
}

export function hasLoadedCollabDoc(slug: string): boolean {
  return loadedDocs.has(slug);
}

export function getLoadedCollabMarkdown(slug: string): string | null {
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return null;
  try {
    return ydoc.getText('markdown').toString();
  } catch {
    return null;
  }
}

export async function getLoadedCollabMarkdownForVerification(
  slug: string,
): Promise<{ markdown: string | null; source: 'ytext' | 'fragment' | 'none' }> {
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return { markdown: null, source: 'none' };
  try {
    const fragmentState = ensureFragmentEditTracking(ydoc);
    const ytext = ydoc.getText('markdown').toString();
    const sanitizedYtext = stripEphemeralCollabSpans(ytext);
    const shouldPreferFragment = fragmentState.dirty || sanitizedYtext !== ytext;
    if (shouldPreferFragment) {
      const derived = await deriveMarkdownProjectionFromFragment(ydoc);
      if (derived !== null) {
        return { markdown: derived, source: 'fragment' };
      }
    }
    return { markdown: ytext, source: 'ytext' };
  } catch {
    return { markdown: null, source: 'none' };
  }
}

export async function getLoadedCollabMarkdownFromFragment(slug: string): Promise<string | null> {
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return null;
  return deriveMarkdownProjectionFromFragment(ydoc);
}

export function getLoadedCollabLastChangedAt(slug: string): number | null {
  return docLastChangedAt.get(slug) ?? null;
}

export async function getLoadedCollabFragmentTextHash(slug: string): Promise<string | null> {
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return null;
  try {
    const parser = await getHeadlessMilkdownParser();
    return getFragmentTextHashFromDoc(ydoc, parser.schema);
  } catch {
    return null;
  }
}

export function hasAgentPresenceInLoadedCollab(slug: string, agentId: string): boolean {
  const normalizedAgentId = normalizeAgentScopedId(agentId);
  if (!normalizedAgentId) return false;
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return false;
  try {
    return ydoc.getMap<unknown>('agentPresence').has(normalizedAgentId);
  } catch {
    return false;
  }
}

export function applyAgentPresenceToLoadedCollab(
  slug: string,
  entry: Record<string, unknown>,
  activity?: Record<string, unknown>,
): boolean {
  if (!runtime.enabled) return false;
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return false;

  const agentId = normalizeAgentScopedId(entry.id);
  if (!agentId) return false;

  const nowIso = new Date().toISOString();
  const incomingAt = normalizeIsoTimestamp((entry as any).at, nowIso);
  const ttlMs = parsePositiveInt(process.env.AGENT_PRESENCE_TTL_MS, DEFAULT_AGENT_PRESENCE_TTL_MS);

  const incoming: AgentPresenceEntry = {
    ...(entry as any),
    id: agentId,
    at: incomingAt,
  };

  let merged: AgentPresenceEntry | null = null;
  ydoc.transact(() => {
    const presenceMap = ydoc.getMap<unknown>('agentPresence');
    const existing = presenceMap.get(agentId);
    merged = mergeAgentPresence(existing, incoming);
    presenceMap.set(agentId, merged!);

    if (activity) {
      const arr = ydoc.getArray<unknown>('agentActivity');
      arr.push([activity]);
      // Keep the last ~200 items.
      const maxItems = 200;
      const excess = arr.length - maxItems;
      if (excess > 0) {
        arr.delete(0, excess);
      }
    }
  }, 'agent-presence');

  touchDoc(slug);
  schedulePersistDoc(slug, ydoc);

  // Expire presence after inactivity.
  const expiryAt = typeof incoming.at === 'string' && incoming.at.trim().length > 0
    ? incoming.at
    : nowIso;
  scheduleAgentPresenceExpiry(slug, agentId, expiryAt, ttlMs);
  return true;
}

export function removeAgentPresenceFromLoadedCollab(
  slug: string,
  agentId: string,
  activity?: Record<string, unknown>,
): boolean {
  if (!runtime.enabled) return false;
  const normalizedAgentId = normalizeAgentScopedId(agentId);
  if (!normalizedAgentId) return false;

  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return false;

  const key = agentTimerKey(slug, normalizedAgentId);
  const presenceTimer = agentPresenceExpiryTimers.get(key);
  if (presenceTimer) {
    clearTimeout(presenceTimer);
    agentPresenceExpiryTimers.delete(key);
  }
  const cursorTimer = agentCursorExpiryTimers.get(key);
  if (cursorTimer) {
    clearTimeout(cursorTimer);
    agentCursorExpiryTimers.delete(key);
  }

  let removed = false;
  ydoc.transact(() => {
    const presenceMap = ydoc.getMap<unknown>('agentPresence');
    const cursorMap = ydoc.getMap<unknown>('agentCursors');
    if (presenceMap.has(normalizedAgentId)) {
      presenceMap.delete(normalizedAgentId);
      removed = true;
    }
    if (cursorMap.has(normalizedAgentId)) {
      cursorMap.delete(normalizedAgentId);
      removed = true;
    }
    if (removed && activity) {
      const arr = ydoc.getArray<unknown>('agentActivity');
      arr.push([activity]);
      const maxItems = 200;
      const excess = arr.length - maxItems;
      if (excess > 0) {
        arr.delete(0, excess);
      }
    }
  }, 'agent-presence-disconnect');

  if (!removed) return false;
  touchDoc(slug);
  schedulePersistDoc(slug, ydoc);
  return true;
}

export function applyAgentCursorHintToLoadedCollab(
  slug: string,
  hint: AgentCursorHint,
): boolean {
  if (!runtime.enabled) return false;
  const ydoc = getLiveHocuspocusDoc(slug) ?? loadedDocs.get(slug);
  if (!ydoc) return false;

  const agentId = normalizeAgentScopedId(hint.id);
  if (!agentId) return false;

  const nowIso = new Date().toISOString();
  const ttlMs = hint.ttlMs ?? parsePositiveInt(process.env.AGENT_CURSOR_TTL_MS, DEFAULT_AGENT_CURSOR_TTL_MS);
  const at = typeof hint.at === 'string' && hint.at.trim() ? hint.at : nowIso;

  ydoc.transact(() => {
    const cursorMap = ydoc.getMap<unknown>('agentCursors');
    cursorMap.set(agentId, {
      id: agentId,
      quote: typeof hint.quote === 'string' ? hint.quote : undefined,
      ttlMs,
      at,
      name: typeof hint.name === 'string' ? hint.name : undefined,
      color: typeof hint.color === 'string' ? hint.color : undefined,
      avatar: typeof hint.avatar === 'string' ? hint.avatar : undefined,
    } satisfies AgentCursorHint);
  }, 'agent-cursor');

  touchDoc(slug);

  // Cursor hints are ephemeral; don't bother persisting them explicitly.
  scheduleAgentCursorExpiry(slug, agentId, at, ttlMs);
  return true;
}

export async function applyCanonicalDocumentToCollab(
  slug: string,
  options: CollabExternalApplyOptions,
): Promise<boolean> {
  const prev = externalApplyQueues.get(slug) ?? Promise.resolve(true);
  const next = prev
    .catch(() => { /* swallow queue errors */ })
    .then(() => applyCanonicalDocumentToCollabInner(slug, options));
  externalApplyQueues.set(slug, next);
  try {
    return await next;
  } finally {
    if (externalApplyQueues.get(slug) === next) {
      externalApplyQueues.delete(slug);
    }
  }
}

export type CollabApplyVerificationResult = {
  applied: boolean;
  confirmed: boolean;
  reason?: string;
  yStateVersion: number;
  markdownConfirmed: boolean;
  fragmentConfirmed: boolean;
  markdownSource?: 'ytext' | 'fragment' | 'none';
  expectedFragmentTextHash: string | null;
  liveFragmentTextHash: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function applyCanonicalDocumentToCollabWithVerification(
  slug: string,
  options: CollabExternalApplyOptions,
  timeoutMs: number,
): Promise<CollabApplyVerificationResult> {
  if (!runtime.enabled) {
    return {
      applied: false,
      confirmed: true,
      reason: 'collab_disabled',
      yStateVersion: getLatestYStateVersion(slug),
      markdownConfirmed: true,
      fragmentConfirmed: true,
      expectedFragmentTextHash: null,
      liveFragmentTextHash: null,
    };
  }

  const applied = await applyCanonicalDocumentToCollab(slug, options);
  let yStateVersion = getLatestYStateVersion(slug);
  if (!applied) {
    return {
      applied: false,
      confirmed: false,
      reason: 'apply_failed',
      yStateVersion,
      markdownConfirmed: false,
      fragmentConfirmed: false,
      expectedFragmentTextHash: null,
      liveFragmentTextHash: null,
    };
  }

  const sanitizedMarkdown = typeof options.markdown === 'string'
    ? normalizeMarkdownForVerification(options.markdown)
    : null;
  if (!sanitizedMarkdown) {
    return {
      applied: true,
      confirmed: true,
      yStateVersion,
      markdownConfirmed: true,
      fragmentConfirmed: true,
      expectedFragmentTextHash: null,
      liveFragmentTextHash: null,
    };
  }

  const expectedFragmentTextHash = await computeFragmentTextHashFromMarkdown(sanitizedMarkdown);

  let markdownConfirmed = false;
  let fragmentConfirmed = false;
  let liveFragmentTextHash: string | null = null;
  let markdownSource: 'ytext' | 'fragment' | 'none' = 'none';

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline || timeoutMs <= 0) {
    const liveSample = await getLoadedCollabMarkdownForVerification(slug);
    const liveMarkdown = liveSample.markdown;
    markdownSource = liveSample.source;
    const sanitizedLiveMarkdown = liveMarkdown === null ? null : normalizeMarkdownForVerification(liveMarkdown);
    liveFragmentTextHash = await getLoadedCollabFragmentTextHash(slug);
    markdownConfirmed = sanitizedLiveMarkdown !== null && sanitizedLiveMarkdown === sanitizedMarkdown;
    fragmentConfirmed = (
      expectedFragmentTextHash !== null
      && liveFragmentTextHash !== null
      && expectedFragmentTextHash === liveFragmentTextHash
    );
    if (!markdownConfirmed && fragmentConfirmed) {
      const derivedMarkdown = await getLoadedCollabMarkdownFromFragment(slug);
      const sanitizedDerived = derivedMarkdown === null ? null : normalizeMarkdownForVerification(derivedMarkdown);
      if (sanitizedDerived !== null && sanitizedDerived === sanitizedMarkdown) {
        markdownConfirmed = true;
        markdownSource = 'fragment';
      }
    }
    if (markdownConfirmed && fragmentConfirmed) {
      yStateVersion = getLatestYStateVersion(slug);
      return {
        applied: true,
        confirmed: true,
        yStateVersion,
        markdownConfirmed,
        fragmentConfirmed,
        markdownSource,
        expectedFragmentTextHash,
        liveFragmentTextHash,
      };
    }
    if (timeoutMs <= 0) break;
    await sleep(50);
  }

  yStateVersion = getLatestYStateVersion(slug);
  const reason = (() => {
    const hasLiveDoc = getLoadedCollabMarkdown(slug) !== null;
    if (!hasLiveDoc && liveFragmentTextHash === null) return 'no_live_doc';
    if (!markdownConfirmed && !fragmentConfirmed) return 'markdown_fragment_mismatch';
    if (!markdownConfirmed) return 'markdown_mismatch';
    if (expectedFragmentTextHash === null) return 'expected_fragment_unavailable';
    return 'fragment_mismatch';
  })();
  if (reason === 'no_live_doc') {
    return {
      applied: true,
      confirmed: true,
      reason,
      yStateVersion,
      markdownConfirmed,
      fragmentConfirmed,
      markdownSource,
      expectedFragmentTextHash,
      liveFragmentTextHash,
    };
  }
  return {
    applied: true,
    confirmed: false,
    reason,
    yStateVersion,
    markdownConfirmed,
    fragmentConfirmed,
    markdownSource,
    expectedFragmentTextHash,
    liveFragmentTextHash,
  };
}

export async function verifyCanonicalDocumentInLoadedCollab(
  slug: string,
  options: CollabExternalApplyOptions,
  timeoutMs: number,
): Promise<CollabApplyVerificationResult> {
  if (!runtime.enabled) {
    return {
      applied: false,
      confirmed: true,
      reason: 'collab_disabled',
      yStateVersion: getLatestYStateVersion(slug),
      markdownConfirmed: true,
      fragmentConfirmed: true,
      expectedFragmentTextHash: null,
      liveFragmentTextHash: null,
    };
  }

  const sanitizedMarkdown = typeof options.markdown === 'string'
    ? normalizeMarkdownForVerification(options.markdown)
    : null;
  const yStateVersion = getLatestYStateVersion(slug);
  if (!sanitizedMarkdown) {
    return {
      applied: false,
      confirmed: true,
      yStateVersion,
      markdownConfirmed: true,
      fragmentConfirmed: true,
      expectedFragmentTextHash: null,
      liveFragmentTextHash: null,
    };
  }

  const expectedFragmentTextHash = await computeFragmentTextHashFromMarkdown(sanitizedMarkdown);
  let markdownConfirmed = false;
  let fragmentConfirmed = false;
  let liveFragmentTextHash: string | null = null;
  let markdownSource: 'ytext' | 'fragment' | 'none' = 'none';

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline || timeoutMs <= 0) {
    const liveSample = await getLoadedCollabMarkdownForVerification(slug);
    const liveMarkdown = liveSample.markdown;
    markdownSource = liveSample.source;
    const sanitizedLiveMarkdown = liveMarkdown === null ? null : normalizeMarkdownForVerification(liveMarkdown);
    liveFragmentTextHash = await getLoadedCollabFragmentTextHash(slug);
    markdownConfirmed = sanitizedLiveMarkdown !== null && sanitizedLiveMarkdown === sanitizedMarkdown;
    fragmentConfirmed = (
      expectedFragmentTextHash !== null
      && liveFragmentTextHash !== null
      && expectedFragmentTextHash === liveFragmentTextHash
    );
    if (!markdownConfirmed && fragmentConfirmed) {
      const derivedMarkdown = await getLoadedCollabMarkdownFromFragment(slug);
      const sanitizedDerived = derivedMarkdown === null ? null : normalizeMarkdownForVerification(derivedMarkdown);
      if (sanitizedDerived !== null && sanitizedDerived === sanitizedMarkdown) {
        markdownConfirmed = true;
        markdownSource = 'fragment';
      }
    }
    if (markdownConfirmed && fragmentConfirmed) {
      return {
        applied: false,
        confirmed: true,
        yStateVersion: getLatestYStateVersion(slug),
        markdownConfirmed,
        fragmentConfirmed,
        markdownSource,
        expectedFragmentTextHash,
        liveFragmentTextHash,
      };
    }
    if (timeoutMs <= 0) break;
    await sleep(50);
  }

  const reason = (() => {
    const hasLiveDoc = getLoadedCollabMarkdown(slug) !== null;
    if (!hasLiveDoc && liveFragmentTextHash === null) return 'no_live_doc';
    if (!markdownConfirmed && !fragmentConfirmed) return 'markdown_fragment_mismatch';
    if (!markdownConfirmed) return 'markdown_mismatch';
    if (expectedFragmentTextHash === null) return 'expected_fragment_unavailable';
    return 'fragment_mismatch';
  })();
  if (reason === 'no_live_doc') {
    return {
      applied: false,
      confirmed: true,
      reason,
      yStateVersion: getLatestYStateVersion(slug),
      markdownConfirmed,
      fragmentConfirmed,
      markdownSource,
      expectedFragmentTextHash,
      liveFragmentTextHash,
    };
  }
  return {
    applied: false,
    confirmed: false,
    reason,
    yStateVersion: getLatestYStateVersion(slug),
    markdownConfirmed,
    fragmentConfirmed,
    markdownSource,
    expectedFragmentTextHash,
    liveFragmentTextHash,
  };
}

function parseCanonicalMarks(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return canonicalizeStoredMarks(parsed as Record<string, StoredMark>);
    }
  } catch {
    // ignore malformed marks payload
  }
  return {};
}

function evictLocalDocState(slug: string): void {
  loadedDocs.delete(slug);
  lastPersistedStateVectors.delete(slug);
  updatesSinceCompaction.delete(slug);
  loadedDocDbMeta.delete(slug);
  docLastAccessedAt.delete(slug);
  docLastChangedAt.delete(slug);
  warnedReadOnlyPersistSlugs.delete(slug);
  lastProjectionLengths.delete(slug);
  clearAllSlugPathologyCooldowns(slug);
}

function dropHocuspocusDocumentReference(slug: string): void {
  const instance = hocuspocusInstance as any;
  if (!instance || !slug) return;
  try {
    instance.loadingDocuments?.delete?.(slug);
  } catch {
    // ignore
  }
}

function evictStaleLocalStateForAccessEpoch(slug: string, accessEpoch: number): void {
  const loadedMeta = loadedDocDbMeta.get(slug);
  if (!loadedMeta || loadedMeta.accessEpoch === accessEpoch) return;
  const nextPersistGeneration = cancelPendingPersistWork(slug, { advanceGeneration: true });

  console.warn('[collab] evicting stale in-memory doc for access epoch bump', {
    slug,
    loadedAccessEpoch: loadedMeta.accessEpoch,
    currentAccessEpoch: accessEpoch,
  });
  evictLocalDocState(slug);
  persistGeneration.set(slug, nextPersistGeneration);

  const instance = hocuspocusInstance as any;
  dropHocuspocusDocumentReference(slug);
  if (typeof instance?.closeConnections === 'function') {
    try {
      instance.closeConnections(slug);
    } catch (error) {
      console.warn('[collab] failed to close stale connections after epoch bump', { slug, error });
    }
  }
  try {
    instance?.documents?.delete?.(slug);
  } catch {
    // ignore
  }
}

function evictStaleLocalStateForPersistedVersion(
  slug: string,
  updatedAt: string | null,
  yStateVersion: number,
): void {
  const loadedMeta = loadedDocDbMeta.get(slug);
  if (!loadedMeta) return;
  const updatedAtMatches = updatedAt === null || loadedMeta.updatedAt === updatedAt;
  if (updatedAtMatches && loadedMeta.yStateVersion === yStateVersion) return;

  const nextPersistGeneration = cancelPendingPersistWork(slug, { advanceGeneration: true });
  console.warn('[collab] evicting stale in-memory doc for persisted version bump', {
    slug,
    loadedUpdatedAt: loadedMeta.updatedAt,
    currentUpdatedAt: updatedAt,
    loadedYStateVersion: loadedMeta.yStateVersion,
    currentYStateVersion: yStateVersion,
  });
  evictLocalDocState(slug);
  persistGeneration.set(slug, nextPersistGeneration);

  const instance = hocuspocusInstance as any;
  dropHocuspocusDocumentReference(slug);
  if (typeof instance?.closeConnections === 'function') {
    try {
      instance.closeConnections(slug);
    } catch (error) {
      console.warn('[collab] failed to close stale connections after persisted version bump', { slug, error });
    }
  }
  try {
    instance?.documents?.delete?.(slug);
  } catch {
    // ignore
  }
}

async function reconcileStaleProjectionsOnStartup(): Promise<void> {
  const startedAt = Date.now();
  const limit = parsePositiveInt(
    process.env.COLLAB_STARTUP_RECONCILE_LIMIT,
    DEFAULT_STARTUP_STALE_PROJECTION_RECONCILE_LIMIT,
  );
  const staleDocs = listDocsWithStaleProjection(limit);
  if (staleDocs.length === 0) return;
  console.warn('[collab] Reconciling stale projections on startup', {
    count: staleDocs.length,
    limit,
  });
  let queuedCount = 0;
  for (let index = 0; index < staleDocs.length; index += 1) {
    const doc = staleDocs[index];
    try {
      recordProjectionDrift('startup_stale_projection', 'startup');
      queueProjectionRepair(doc.slug, 'startup_stale_projection');
      queuedCount += 1;
    } catch (error) {
      console.error('[collab] Failed to reconcile stale projection:', { slug: doc.slug, error });
    }
    // Yield between docs so startup reconciliation cannot starve request handling.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  console.warn('[collab] Finished stale projection reconciliation', {
    count: queuedCount,
    durationMs: Date.now() - startedAt,
  });
}

function scheduleStartupProjectionReconcile(): void {
  const enabled = parseBooleanFlag(
    process.env.COLLAB_STARTUP_RECONCILE_ENABLED,
    DEFAULT_STARTUP_STALE_PROJECTION_RECONCILE_ENABLED,
  );
  if (!enabled) {
    console.log('[collab] startup stale projection reconcile disabled');
    return;
  }
  const delayMs = parsePositiveInt(
    process.env.COLLAB_STARTUP_RECONCILE_DELAY_MS,
    DEFAULT_STARTUP_STALE_PROJECTION_RECONCILE_DELAY_MS,
  );
  if (startupProjectionReconcileTimer) {
    clearTimeout(startupProjectionReconcileTimer);
    startupProjectionReconcileTimer = null;
  }
  const timer = setTimeout(() => {
    startupProjectionReconcileTimer = null;
    void reconcileStaleProjectionsOnStartup();
  }, delayMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  startupProjectionReconcileTimer = timer;
  console.log('[collab] scheduled startup stale projection reconcile', {
    delayMs,
  });
}

async function scanAndQueueSuspiciousProjectionRepairs(
  expectedGeneration: number = projectionRepairWorkerGeneration,
): Promise<void> {
  if (expectedGeneration !== projectionRepairWorkerGeneration) return;
  const rawScanDelayMs = Number.parseInt((process.env.COLLAB_PROJECTION_REPAIR_WORKER_SCAN_DELAY_MS || '').trim(), 10);
  if (Number.isFinite(rawScanDelayMs) && rawScanDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, rawScanDelayMs));
  }
  if (expectedGeneration !== projectionRepairWorkerGeneration) return;
  const limit = parsePositiveInt(
    process.env.COLLAB_PROJECTION_REPAIR_WORKER_LIMIT,
    DEFAULT_PROJECTION_REPAIR_WORKER_LIMIT,
  );
  const minMarkdownChars = parsePositiveInt(
    process.env.COLLAB_PROJECTION_REPAIR_WORKER_MIN_CHARS,
    DEFAULT_PROJECTION_REPAIR_WORKER_MIN_CHARS,
  );
  const oversizedCooldownMs = parsePositiveInt(
    process.env.COLLAB_PROJECTION_REPAIR_WORKER_OVERSIZED_COOLDOWN_MS,
    DEFAULT_PROJECTION_REPAIR_WORKER_OVERSIZED_COOLDOWN_MS,
  );
  const candidates = listSuspiciousProjectionCandidates(limit, minMarkdownChars);
  if (expectedGeneration !== projectionRepairWorkerGeneration) return;
  if (candidates.length === 0) return;

  const now = Date.now();
  const candidateSlugs = new Set(candidates.map((candidate) => candidate.slug));
  for (const slug of Array.from(projectionRepairWorkerOversizedSeen.keys())) {
    if (!candidateSlugs.has(slug)) {
      projectionRepairWorkerOversizedSeen.delete(slug);
    }
  }

  let queuedCount = 0;
  for (const candidate of candidates) {
    if (expectedGeneration !== projectionRepairWorkerGeneration) return;
    const reasons: string[] = [];
    let markdownChars = candidate.markdown_chars;
    if (candidate.latest_y_state_version > candidate.y_state_version) {
      reasons.push('stale_projection');
      recordProjectionDrift('stale_projection', 'repair');
    }
    if (candidate.projection_health !== 'healthy') {
      reasons.push(candidate.projection_health);
      recordProjectionDrift(candidate.projection_health, 'repair');
    }
    if (reasons.length > 0) {
      try {
        const handle = loadCanonicalYDocSync(candidate.slug);
        if (handle) {
          markdownChars = Math.max(markdownChars, handle.ydoc.getText('markdown').toString().length);
        }
      } catch {
        // Keep the DB-derived length when canonical Yjs state cannot be loaded.
      }
    }
    if (markdownChars >= minMarkdownChars) {
      const fingerprint = [
        candidate.updated_at,
        String(markdownChars),
        String(candidate.y_state_version),
        String(candidate.latest_y_state_version),
      ].join(':');
      const seen = projectionRepairWorkerOversizedSeen.get(candidate.slug);
      const sameFingerprint = seen?.fingerprint === fingerprint;
      const withinCooldown = seen ? (now - seen.queuedAt) < oversizedCooldownMs : false;
      const oversizedCooldownActive = sameFingerprint && withinCooldown;
      if (oversizedCooldownActive) continue;
      reasons.push('oversized_projection');
      projectionRepairWorkerOversizedSeen.set(candidate.slug, {
        fingerprint,
        queuedAt: now,
      });
    } else {
      projectionRepairWorkerOversizedSeen.delete(candidate.slug);
    }
    if (reasons.length === 0) continue;
    for (const reason of reasons) {
      queueProjectionRepair(candidate.slug, reason);
    }
    queuedCount += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (queuedCount > 0) {
    console.warn('[collab] queued suspicious projection repairs', {
      candidates: candidates.length,
      queued: queuedCount,
      limit,
      minMarkdownChars,
    });
  }
}

function scheduleProjectionRepairWorker(
  initialDelayMs?: number,
  expectedGeneration: number = projectionRepairWorkerGeneration,
): void {
  if (expectedGeneration !== projectionRepairWorkerGeneration) return;
  const enabled = parseBooleanFlag(
    process.env.COLLAB_PROJECTION_REPAIR_WORKER_ENABLED,
    DEFAULT_PROJECTION_REPAIR_WORKER_ENABLED,
  );
  if (!enabled) {
    projectionRepairWorkerGeneration += 1;
    if (projectionRepairWorkerTimer) {
      clearTimeout(projectionRepairWorkerTimer);
      projectionRepairWorkerTimer = null;
    }
    console.log('[collab] projection repair worker disabled');
    return;
  }

  const delayMs = initialDelayMs ?? parsePositiveInt(
    process.env.COLLAB_PROJECTION_REPAIR_WORKER_DELAY_MS,
    DEFAULT_PROJECTION_REPAIR_WORKER_DELAY_MS,
  );
  const intervalMs = parsePositiveInt(
    process.env.COLLAB_PROJECTION_REPAIR_WORKER_INTERVAL_MS,
    DEFAULT_PROJECTION_REPAIR_WORKER_INTERVAL_MS,
  );

  if (projectionRepairWorkerTimer) {
    clearTimeout(projectionRepairWorkerTimer);
    projectionRepairWorkerTimer = null;
  }

  const timer = setTimeout(() => {
    projectionRepairWorkerTimer = null;
    if (expectedGeneration !== projectionRepairWorkerGeneration) return;
    void (async () => {
      try {
        await scanAndQueueSuspiciousProjectionRepairs(expectedGeneration);
      } catch (error) {
        console.error('[collab] projection repair worker pass failed', { error });
      } finally {
        if (expectedGeneration === projectionRepairWorkerGeneration) {
          scheduleProjectionRepairWorker(intervalMs, expectedGeneration);
        }
      }
    })();
  }, delayMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  projectionRepairWorkerTimer = timer;
}

export async function reconcileCanonicalDocumentToYjs(
  slug: string,
  source: string = 'canonical-reconcile',
  options: { forcePersistOnly?: boolean } = {},
): Promise<boolean> {
  if (!slug) return false;
  const doc = getDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') return false;
  const marks = parseCanonicalMarks(doc.marks);

  if (runtime.enabled && !options.forcePersistOnly) {
    return applyCanonicalDocumentToCollab(slug, {
      markdown: doc.markdown,
      marks,
      source,
    });
  }

  const persisted = readPersistedDocState(slug);
  const ydoc = persisted.ydoc;
  ydoc.transact(() => {
    applyYTextDiff(ydoc.getText('markdown'), doc.markdown);
    applyMarksMapDiff(ydoc.getMap('marks'), marks);
  }, source);
  rememberLoadedDoc(slug, ydoc);
  lastPersistedStateVectors.set(slug, persisted.stateVector);
  updatesSinceCompaction.set(slug, 0);
  touchDoc(slug);
  void persistDoc(slug, ydoc, source);
  evictLocalDocState(slug);
  return true;
}

function evictIdleDocs(): void {
  const maxLoadedDocs = parsePositiveInt(process.env.COLLAB_MAX_LOADED_DOCS, DEFAULT_MAX_LOADED_DOCS);
  const idleTimeoutMs = parsePositiveInt(process.env.COLLAB_DOC_IDLE_TIMEOUT_MS, DEFAULT_DOC_IDLE_TIMEOUT_MS);
  const now = Date.now();

  const evictionCandidates = [...docLastAccessedAt.entries()]
    .sort((a, b) => a[1] - b[1]);

  for (const [slug, lastAccessedAt] of evictionCandidates) {
    if (!loadedDocs.has(slug)) {
      docLastAccessedAt.delete(slug);
      continue;
    }
    const shouldEvictForIdle = (now - lastAccessedAt) > idleTimeoutMs;
    const shouldEvictForCapacity = loadedDocs.size > maxLoadedDocs;
    if (!shouldEvictForIdle && !shouldEvictForCapacity) continue;

    const ydoc = loadedDocs.get(slug);
    if (ydoc) {
      void persistOnStoreDocument(slug, ydoc).catch((error) => {
        console.error('[collab] Failed to persist evicted document:', { slug, error });
      });
    }

    const timer = persistTimers.get(slug);
    if (timer) {
      clearTimeout(timer);
      persistTimers.delete(slug);
    }
    loadedDocs.delete(slug);
    lastPersistedStateVectors.delete(slug);
    updatesSinceCompaction.delete(slug);
    loadedDocDbMeta.delete(slug);
    docLastAccessedAt.delete(slug);
  }
}

const docEvictionInterval = setInterval(
  evictIdleDocs,
  parsePositiveInt(process.env.COLLAB_DOC_EVICTION_INTERVAL_MS, DEFAULT_DOC_EVICTION_INTERVAL_MS),
);
if (typeof (docEvictionInterval as { unref?: () => void }).unref === 'function') {
  (docEvictionInterval as { unref: () => void }).unref();
}

export function getCollabRuntime(): CollabRuntime {
  return runtime;
}

export function buildCollabSession(
  slug: string,
  role: ShareRole,
  options?: {
    tokenId?: string | null;
    wsUrlBase?: string | null;
  },
): CollabSessionInfo | null {
  const doc = getDocumentAuthStateBySlug(slug);
  if (!doc || !doc.doc_id || typeof doc.access_epoch !== 'number') return null;
  evictStaleLocalStateForAccessEpoch(slug, doc.access_epoch);
  evictStaleLocalStateForPersistedVersion(slug, doc.updated_at ?? null, getLatestYStateVersion(slug));

  const ttlSeconds = parsePositiveInt(process.env.COLLAB_SESSION_TTL_SECONDS, DEFAULT_COLLAB_SESSION_TTL_SECONDS);
  const expiresAtEpoch = Math.floor(Date.now() / 1000) + ttlSeconds;
  noteRecentCollabSessionLease(slug, doc.access_epoch, ttlSeconds * 1000);
  noteDocumentLiveCollabLease(slug, doc.access_epoch);
  console.warn('[collab] buildCollabSession lease noted', {
    slug,
    role,
    accessEpoch: doc.access_epoch,
    tokenId: options?.tokenId ?? null,
    ttlSeconds,
  });
  upsertActiveCollabConnection({
    connectionId: buildCollabSessionLeaseConnectionId(slug, doc.access_epoch, role, options?.tokenId ?? null),
    slug,
    role,
    accessEpoch: doc.access_epoch,
    instanceId: `${ACTIVE_COLLAB_INSTANCE_ID}:session-lease`,
  });
  const token = signCollabClaims({
    slug,
    role,
    exp: expiresAtEpoch,
    accessEpoch: doc.access_epoch,
    tokenId: options?.tokenId ?? null,
    jti: randomUUID(),
  });
  const snapshot = getLatestYSnapshot(slug);
  const wsUrlBase = (options?.wsUrlBase || runtime.wsUrlBase || '').replace(/\/+$/, '');
  if (!wsUrlBase) return null;
  let collabWsUrl = wsUrlBase;
  try {
    const url = new URL(wsUrlBase);
    // Do not include a pre-existing query string in the WS base URL. In-browser
    // HocuspocusProvider appends its own query string and does not reliably
    // handle an existing `?`, producing broken URLs like:
    //   `...?collab=1?token=...`
    //
    // We keep the collab entrypoint at `/ws` on Railway; collab connections are
    // detected server-side via the presence of the `role` query param.
    url.searchParams.set('slug', slug);
    collabWsUrl = url.toString();
  } catch {
    collabWsUrl = `${wsUrlBase}?slug=${encodeURIComponent(slug)}`;
  }
  return {
    docId: doc.doc_id,
    slug,
    role,
    shareState: doc.share_state,
    accessEpoch: doc.access_epoch,
    syncProtocol: 'pm-yjs-v1',
    collabWsUrl,
    token,
    snapshotVersion: snapshot?.version ?? 0,
    expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
  };
}

export function handleCollabWebSocketConnection(socket: unknown, request: unknown): void {
  attachCollabSocketErrorHandler(socket, request, 'ws-router');
  if (!hocuspocusInstance || typeof hocuspocusInstance.handleConnection !== 'function') {
    try {
      (socket as { close?: (code?: number, reason?: string) => void })?.close?.(1011, 'Collab runtime unavailable');
    } catch {
      // ignore
    }
    return;
  }
  hocuspocusInstance.handleConnection(socket, request);
}

export async function startCollabRuntime(mainHttpPort: number): Promise<CollabRuntime> {
  const flag = (process.env.PROOF_COLLAB_V2 || '').trim().toLowerCase();
  const disabled = flag === '0' || flag === 'false' || flag === 'off' || flag === 'disabled';
  if (disabled) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: 'Disabled by PROOF_COLLAB_V2 flag',
    };
    return runtime;
  }

  if (shouldAttachToMainHttpServer()) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: 'COLLAB_ATTACH_TO_MAIN_HTTP is enabled but startCollabRuntime was called without an HTTP server',
    };
    return runtime;
  }

  const collabPort = parsePositiveInt(process.env.COLLAB_PORT, mainHttpPort + 1);
  const collabHost = process.env.COLLAB_HOST || '0.0.0.0';
  const collabPublicBase = process.env.COLLAB_PUBLIC_BASE_URL || `ws://localhost:${collabPort}`;
  const hasConfiguredCollabSecret = Boolean((process.env.PROOF_COLLAB_SIGNING_SECRET || '').trim());
  if (!hasConfiguredCollabSecret && !isLocalWsUrlBase(collabPublicBase)) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: 'PROOF_COLLAB_SIGNING_SECRET is required for non-local collab runtime',
    };
    return runtime;
  }

  try {
    if (!warnedAboutEphemeralCollabSecret && !(process.env.PROOF_COLLAB_SIGNING_SECRET || '').trim()) {
      warnedAboutEphemeralCollabSecret = true;
      console.warn('[collab] PROOF_COLLAB_SIGNING_SECRET is not set; using ephemeral in-memory signing key');
    }

    const hocuspocusModule = await import('@hocuspocus/server');
    const factory = (hocuspocusModule as unknown as { Server?: { configure?: (options: unknown) => HocuspocusInstance } }).Server;
    if (!factory?.configure) {
      throw new Error('Hocuspocus Server.configure() is not available');
    }

    hocuspocusInstance = factory.configure({
      name: 'proof-collab',
      port: collabPort,
      address: collabHost,
      async onAuthenticate(data: {
        documentName: string;
        socketId: string;
        token?: string;
        requestParameters: URLSearchParams;
        requestHeaders?: unknown;
        connection: { readOnly: boolean };
      }) {
        const token = (typeof data.token === 'string' ? data.token : '')
          || data.requestParameters.get('token')
          || extractCollabTokenFromHeaders(data.requestHeaders);
        if (!token && debugOnConnect) {
          const headerKeys = Object.keys((data.requestHeaders as Record<string, unknown>) || {}).slice(0, 20);
          const paramKeys = Array.from(new Set(Array.from(data.requestParameters.keys()))).slice(0, 20);
          console.warn('[collab][onAuthenticate] missing token', { documentName: data.documentName, headerKeys, paramKeys });
        }
        const auth = authenticateCollabSession(data.documentName, token);
        // onConnect runs before onAuthenticate in Hocuspocus; enforce readOnly here.
        data.connection.readOnly = !auth.canWrite;
        return attachAuthenticatedCollabPresence(data.socketId, auth);
      },
      async onConnect(data: {
        documentName: string;
        requestParameters: URLSearchParams;
        connection: { readOnly: boolean };
        context?: unknown;
      }) {
        const ctx = data.context as Partial<CollabAuthContext> | undefined;
        if (typeof ctx?.canWrite === 'boolean') {
          data.connection.readOnly = !ctx.canWrite;
        }
        return ctx ?? {};
      },
      async onLoadDocument(data: { documentName: string }) {
        const slug = data.documentName;
        const docRow = getDocumentBySlug(slug);
        const loadedMeta = loadedDocDbMeta.get(slug);
        if (typeof docRow?.access_epoch === 'number' && loadedMeta && loadedMeta.accessEpoch !== docRow.access_epoch) {
          evictStaleLocalStateForAccessEpoch(slug, docRow.access_epoch);
        }
        if (loadedMeta) {
          evictStaleLocalStateForPersistedVersion(
            slug,
            docRow?.updated_at ?? null,
            getLatestYStateVersion(slug),
          );
        }
        if (!loadedDocs.has(slug)) {
          rememberLoadedDoc(slug, await hydrateDocFromDbAsync(slug));
        } else if (!loadedMeta) {
          const existing = loadedDocs.get(slug);
          if (existing) refreshLoadedDocDbMetaFromDb(slug, existing);
        }
        const doc = loadedDocs.get(slug);
        if (doc) pruneExpiredAgentEphemera(slug, doc);
        touchDoc(slug);
        return loadedDocs.get(slug);
      },
      async onStoreDocument(data: { documentName: string; document: Y.Doc; context?: unknown; transactionOrigin?: unknown }) {
        if (getContextAccessEpoch(data.context) === null) {
          // Server-origin transactions (e.g. projection refresh / canonical apply) persist explicitly.
          return;
        }
        if (shouldDropStaleContextWrite(data.documentName, data.context, 'onStoreDocument')) {
          return;
        }
        if (isRewriteLocked(data.documentName)) {
          console.warn('[collab] onStoreDocument blocked by rewrite lock', { slug: data.documentName });
          return;
        }
        if (collabInvalidations.has(data.documentName)) {
          // Drop any pending persistence and refuse to write stale collab state back to DB.
          const pending = persistTimers.get(data.documentName);
          if (pending) {
            clearTimeout(pending);
            persistTimers.delete(data.documentName);
          }
          loadedDocs.delete(data.documentName);
          lastPersistedStateVectors.delete(data.documentName);
          updatesSinceCompaction.delete(data.documentName);
          loadedDocDbMeta.delete(data.documentName);
          docLastAccessedAt.delete(data.documentName);
          return;
        }
        if (shouldSkipOnStorePersistAfterExternalApply(data.documentName, data.document)) {
          return;
        }
        rememberLoadedDoc(data.documentName, data.document);
        markDocChanged(data.documentName);
        const canonicalDoc = loadedDocs.get(data.documentName) ?? data.document;
        await persistOnStoreDocument(data.documentName, canonicalDoc);
      },
      async onChange(data: { documentName: string; document: Y.Doc; context?: unknown }) {
        if (getContextAccessEpoch(data.context) === null) {
          // Server-origin transactions (e.g. applyCanonicalDocumentToCollab) persist explicitly.
          return;
        }
        if (shouldDropStaleContextWrite(data.documentName, data.context, 'onChange')) {
          return;
        }
        if (collabInvalidations.has(data.documentName)) {
          // Ignore changes while we're tearing down the runtime state for this slug.
          return;
        }
        if (isRewriteLocked(data.documentName)) {
          // A force-rewrite is in flight or cooling down; drop client-originated writes
          // to prevent stale client state from overwriting the rewrite.
          console.warn('[collab] onChange blocked by rewrite lock', { slug: data.documentName });
          return;
        }
        rememberLoadedDoc(data.documentName, data.document);
        markDocChanged(data.documentName);
        schedulePersistDoc(data.documentName, data.document);
      },
      async onDisconnect(data: { context?: unknown }) {
        detachAuthenticatedCollabPresence(data.context);
      },
    } as unknown);

    if (typeof hocuspocusInstance.listen === 'function') {
      await Promise.resolve(hocuspocusInstance.listen());
    }

    runtime = {
      enabled: true,
      wsUrlBase: collabPublicBase.replace(/\/$/, ''),
    };
    console.log(`[collab] runtime enabled on ${collabHost}:${collabPort}`);
    scheduleStartupProjectionReconcile();
    projectionRepairWorkerGeneration += 1;
    scheduleProjectionRepairWorker(undefined, projectionRepairWorkerGeneration);
    return runtime;
  } catch (error) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: error instanceof Error ? error.message : String(error),
    };
    console.error('[collab] failed to start runtime:', runtime.reason);
    return runtime;
  }
}

export async function startCollabRuntimeEmbedded(mainHttpPort: number): Promise<CollabRuntime> {
  const flag = (process.env.PROOF_COLLAB_V2 || '').trim().toLowerCase();
  const disabled = flag === '0' || flag === 'false' || flag === 'off' || flag === 'disabled';
  if (disabled) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: 'Disabled by PROOF_COLLAB_V2 flag',
    };
    return runtime;
  }

  const wsUrlBase = resolveEmbeddedWsUrlBase(mainHttpPort);
  const hasConfiguredCollabSecret = Boolean((process.env.PROOF_COLLAB_SIGNING_SECRET || '').trim());
  if (!hasConfiguredCollabSecret && !isLocalWsUrlBase(wsUrlBase)) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: 'PROOF_COLLAB_SIGNING_SECRET is required for non-local collab runtime',
    };
    return runtime;
  }

  try {
    if (!warnedAboutEphemeralCollabSecret && !(process.env.PROOF_COLLAB_SIGNING_SECRET || '').trim()) {
      warnedAboutEphemeralCollabSecret = true;
      console.warn('[collab] PROOF_COLLAB_SIGNING_SECRET is not set; using ephemeral in-memory signing key');
    }

    const hocuspocusModule = await import('@hocuspocus/server');
    const factory = (hocuspocusModule as unknown as { Server?: { configure?: (options: unknown) => any } }).Server;
    if (!factory?.configure) {
      throw new Error('Hocuspocus Server.configure() is not available');
    }

    // Configure the collab runtime without binding a port. Connections are multiplexed onto /ws.
    hocuspocusInstance = factory.configure({
      name: 'proof-collab',
      async onAuthenticate(data: {
        documentName: string;
        socketId: string;
        token?: string;
        requestParameters: URLSearchParams;
        requestHeaders?: unknown;
        connection: { readOnly: boolean };
      }) {
        const token = (typeof data.token === 'string' ? data.token : '')
          || data.requestParameters.get('token')
          || extractCollabTokenFromHeaders(data.requestHeaders);
        if (!token && debugOnConnect) {
          const headerKeys = Object.keys((data.requestHeaders as Record<string, unknown>) || {}).slice(0, 20);
          const paramKeys = Array.from(new Set(Array.from(data.requestParameters.keys()))).slice(0, 20);
          console.warn('[collab][onAuthenticate] missing token', { documentName: data.documentName, headerKeys, paramKeys });
        }
        const auth = authenticateCollabSession(data.documentName, token);
        // onConnect runs before onAuthenticate in Hocuspocus; enforce readOnly here.
        data.connection.readOnly = !auth.canWrite;
        return attachAuthenticatedCollabPresence(data.socketId, auth);
      },
      async onConnect(data: {
        documentName: string;
        requestParameters: URLSearchParams;
        connection: { readOnly: boolean };
        context?: unknown;
      }) {
        const ctx = data.context as Partial<CollabAuthContext> | undefined;
        if (typeof ctx?.canWrite === 'boolean') {
          data.connection.readOnly = !ctx.canWrite;
        }
        return ctx ?? {};
      },
      async onLoadDocument(data: { documentName: string }) {
        const slug = data.documentName;
        if (!loadedDocs.has(slug)) {
          rememberLoadedDoc(slug, await hydrateDocFromDbAsync(slug));
        }
        const doc = loadedDocs.get(slug);
        if (doc) pruneExpiredAgentEphemera(slug, doc);
        touchDoc(slug);
        return loadedDocs.get(slug);
      },
      async onStoreDocument(data: { documentName: string; document: Y.Doc; context?: unknown; transactionOrigin?: unknown }) {
        if (getContextAccessEpoch(data.context) === null) {
          // Server-origin transactions (e.g. projection refresh / canonical apply) persist explicitly.
          return;
        }
        if (shouldDropStaleContextWrite(data.documentName, data.context, 'onStoreDocument')) {
          return;
        }
        if (isRewriteLocked(data.documentName)) {
          console.warn('[collab] onStoreDocument blocked by rewrite lock', { slug: data.documentName });
          return;
        }
        if (collabInvalidations.has(data.documentName)) {
          const pending = persistTimers.get(data.documentName);
          if (pending) {
            clearTimeout(pending);
            persistTimers.delete(data.documentName);
          }
          loadedDocs.delete(data.documentName);
          lastPersistedStateVectors.delete(data.documentName);
          updatesSinceCompaction.delete(data.documentName);
          loadedDocDbMeta.delete(data.documentName);
          docLastAccessedAt.delete(data.documentName);
          return;
        }
        if (shouldSkipOnStorePersistAfterExternalApply(data.documentName, data.document)) {
          return;
        }
        rememberLoadedDoc(data.documentName, data.document);
        markDocChanged(data.documentName);
        const canonicalDoc = loadedDocs.get(data.documentName) ?? data.document;
        await persistOnStoreDocument(data.documentName, canonicalDoc);
      },
      async onChange(data: { documentName: string; document: Y.Doc; context?: unknown }) {
        if (getContextAccessEpoch(data.context) === null) {
          // Server-origin transactions (e.g. applyCanonicalDocumentToCollab) persist explicitly.
          return;
        }
        if (shouldDropStaleContextWrite(data.documentName, data.context, 'onChange')) {
          return;
        }
        if (collabInvalidations.has(data.documentName)) {
          return;
        }
        if (isRewriteLocked(data.documentName)) {
          console.warn("[collab] onChange blocked by rewrite lock", { slug: data.documentName });
          return;
        }
        rememberLoadedDoc(data.documentName, data.document);
        markDocChanged(data.documentName);
        schedulePersistDoc(data.documentName, data.document);
      },
      async onDisconnect(data: { context?: unknown }) {
        detachAuthenticatedCollabPresence(data.context);
      },
    } as unknown);

    runtime = {
      enabled: true,
      wsUrlBase: wsUrlBase.replace(/\/+$/, ''),
    };
    console.log(`[collab] embedded runtime enabled wsUrlBase=${runtime.wsUrlBase}`);
    scheduleStartupProjectionReconcile();
    projectionRepairWorkerGeneration += 1;
    scheduleProjectionRepairWorker(undefined, projectionRepairWorkerGeneration);
    return runtime;
  } catch (error) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: error instanceof Error ? error.message : String(error),
    };
    console.error('[collab] failed to start embedded runtime:', runtime.reason);
    return runtime;
  }
}

export async function startCollabRuntimeAttached(mainHttpServer: HttpServer, mainHttpPort: number): Promise<CollabRuntime> {
  const flag = (process.env.PROOF_COLLAB_V2 || '').trim().toLowerCase();
  const disabled = flag === '0' || flag === 'false' || flag === 'off' || flag === 'disabled';
  if (disabled) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: 'Disabled by PROOF_COLLAB_V2 flag',
    };
    return runtime;
  }

  const wsUrlBase = resolveAttachedWsUrlBase(mainHttpPort);
  const hasConfiguredCollabSecret = Boolean((process.env.PROOF_COLLAB_SIGNING_SECRET || '').trim());
  if (!hasConfiguredCollabSecret && !isLocalWsUrlBase(wsUrlBase)) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: 'PROOF_COLLAB_SIGNING_SECRET is required for non-local collab runtime',
    };
    return runtime;
  }

  try {
    if (!warnedAboutEphemeralCollabSecret && !(process.env.PROOF_COLLAB_SIGNING_SECRET || '').trim()) {
      warnedAboutEphemeralCollabSecret = true;
      console.warn('[collab] PROOF_COLLAB_SIGNING_SECRET is not set; using ephemeral in-memory signing key');
    }

    const hocuspocusModule = await import('@hocuspocus/server');
    const factory = (hocuspocusModule as unknown as { Server?: { configure?: (options: unknown) => any } }).Server;
    if (!factory?.configure) {
      throw new Error('Hocuspocus Server.configure() is not available');
    }

    hocuspocusInstance = factory.configure({
      name: 'proof-collab',
      async onConnect(data: {
        documentName: string;
        socketId: string;
        requestParameters: URLSearchParams;
        connection: { readOnly: boolean };
      }) {
        const token = data.requestParameters.get('token')
          || extractCollabTokenFromHeaders((data as unknown as { requestHeaders?: unknown }).requestHeaders);
        const claims = verifyCollabToken(token);
        if (!claims || claims.slug !== data.documentName) {
          if (debugOnConnect) {
            const keys = Array.from(new Set(Array.from(data.requestParameters.keys()))).slice(0, 20);
            const headerKeys = Object.keys(((data as any)?.requestHeaders ?? {}) as Record<string, unknown>).slice(0, 20);
            console.warn('[collab][onConnect] permission-denied', {
              dataKeys: Object.keys(data as unknown as Record<string, unknown>),
              documentName: data.documentName,
              tokenLen: token.length,
              tokenDots: token.split('.').length - 1,
              paramKeys: keys,
              paramName: data.requestParameters.get('name') || null,
              paramDoc: data.requestParameters.get('document') || null,
              paramDocumentName: data.requestParameters.get('documentName') || null,
              headerKeys,
            });
          }
          throw new Error('permission-denied');
        }

        const doc = getDocumentAuthStateBySlug(data.documentName);
        if (!doc || doc.share_state === 'DELETED') {
          throw new Error('document-not-found');
        }
        if (typeof doc.access_epoch === 'number' && claims.accessEpoch !== doc.access_epoch) {
          throw new Error('session-stale');
        }
        if (doc.share_state === 'REVOKED' && claims.role !== 'owner_bot') {
          throw new Error('document-revoked');
        }
        if (doc.share_state === 'PAUSED' && claims.role !== 'owner_bot') {
          throw new Error('document-paused');
        }

        const canWrite = (
          (claims.role === 'owner_bot'
            && (doc.share_state === 'ACTIVE' || doc.share_state === 'PAUSED'))
          || (claims.role === 'editor' && doc.share_state === 'ACTIVE')
        );
        data.connection.readOnly = !canWrite;

        return attachAuthenticatedCollabPresence(data.socketId, {
          slug: claims.slug,
          role: claims.role,
          shareState: doc.share_state,
          canWrite,
          accessEpoch: typeof doc.access_epoch === 'number' ? doc.access_epoch : null,
        });
      },
      async onDisconnect(data: { context?: unknown }) {
        detachAuthenticatedCollabPresence(data.context);
      },
      async onLoadDocument(data: { documentName: string }) {
        const slug = data.documentName;
        if (!loadedDocs.has(slug)) {
          rememberLoadedDoc(slug, await hydrateDocFromDbAsync(slug));
        }
        const doc = loadedDocs.get(slug);
        if (doc) pruneExpiredAgentEphemera(slug, doc);
        touchDoc(slug);
        return loadedDocs.get(slug);
      },
      async onStoreDocument(data: { documentName: string; document: Y.Doc; context?: unknown; transactionOrigin?: unknown }) {
        if (getContextAccessEpoch(data.context) === null) {
          // Server-origin transactions (e.g. projection refresh / canonical apply) persist explicitly.
          return;
        }
        if (shouldDropStaleContextWrite(data.documentName, data.context, 'onStoreDocument')) {
          return;
        }
        if (isRewriteLocked(data.documentName)) {
          console.warn('[collab] onStoreDocument blocked by rewrite lock', { slug: data.documentName });
          return;
        }
        if (collabInvalidations.has(data.documentName)) {
          const pending = persistTimers.get(data.documentName);
          if (pending) {
            clearTimeout(pending);
            persistTimers.delete(data.documentName);
          }
          loadedDocs.delete(data.documentName);
          lastPersistedStateVectors.delete(data.documentName);
          updatesSinceCompaction.delete(data.documentName);
          loadedDocDbMeta.delete(data.documentName);
          docLastAccessedAt.delete(data.documentName);
          return;
        }
        if (shouldSkipOnStorePersistAfterExternalApply(data.documentName, data.document)) {
          return;
        }
        rememberLoadedDoc(data.documentName, data.document);
        markDocChanged(data.documentName);
        const canonicalDoc = loadedDocs.get(data.documentName) ?? data.document;
        await persistOnStoreDocument(data.documentName, canonicalDoc);
      },
      async onChange(data: { documentName: string; document: Y.Doc; context?: unknown }) {
        if (getContextAccessEpoch(data.context) === null) {
          // Server-origin transactions (e.g. applyCanonicalDocumentToCollab) persist explicitly.
          return;
        }
        if (shouldDropStaleContextWrite(data.documentName, data.context, 'onChange')) {
          return;
        }
        if (collabInvalidations.has(data.documentName)) {
          return;
        }
        if (isRewriteLocked(data.documentName)) {
          console.warn("[collab] onChange blocked by rewrite lock", { slug: data.documentName });
          return;
        }
        rememberLoadedDoc(data.documentName, data.document);
        markDocChanged(data.documentName);
        schedulePersistDoc(data.documentName, data.document);
      },
    } as unknown);

    const { WebSocketServer } = await import('ws');
    const path = (process.env.COLLAB_PATH || '/collab').trim() || '/collab';
    collabWss = new WebSocketServer({ noServer: true });
    collabWss.on('connection', (socket, request) => {
      attachCollabSocketErrorHandler(socket, request, 'attached-runtime');
      try {
        (hocuspocusInstance as any).handleConnection(socket, request);
      } catch (error) {
        try { socket.close(); } catch { /* ignore */ }
        console.error('[collab] Failed to handle WS connection:', error);
      }
    });
    collabWss.on('error', (error) => {
      console.error('[collab] WS server error:', error);
    });

    collabUpgradeHandler = (req, socket, head) => {
      try {
        const url = new URL(req?.url || '/', 'http://localhost');
        if (url.pathname !== path) return;
        collabWss?.handleUpgrade(req, socket, head, (ws) => {
          collabWss?.emit('connection', ws, req);
        });
      } catch (error) {
        try { socket.destroy(); } catch { /* ignore */ }
        console.error('[collab] upgrade handler failed:', error);
      }
    };
    collabUpgradeServer = mainHttpServer;
    mainHttpServer.on('upgrade', collabUpgradeHandler);

    runtime = {
      enabled: true,
      wsUrlBase: wsUrlBase.replace(/\/$/, ''),
    };
    console.log(`[collab] runtime attached on ${path} wsUrlBase=${runtime.wsUrlBase}`);
    void reconcileStaleProjectionsOnStartup();
    projectionRepairWorkerGeneration += 1;
    scheduleProjectionRepairWorker(undefined, projectionRepairWorkerGeneration);
    return runtime;
  } catch (error) {
    runtime = {
      enabled: false,
      wsUrlBase: '',
      reason: error instanceof Error ? error.message : String(error),
    };
    console.error('[collab] failed to start attached runtime:', runtime.reason);
    return runtime;
  }
}

export async function stopCollabRuntime(): Promise<void> {
  projectionRepairWorkerGeneration += 1;
  runtime = {
    enabled: false,
    wsUrlBase: '',
    reason: 'Collab runtime stopped',
  };
  if (collabWss) {
    try {
      for (const client of collabWss.clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => collabWss?.close(() => resolve()));
    } catch {
      // ignore
    } finally {
      collabWss = null;
    }
  }
  if (collabUpgradeHandler) {
    try {
      collabUpgradeServer?.off('upgrade', collabUpgradeHandler);
    } catch {
      // ignore
    }
    collabUpgradeHandler = null;
    collabUpgradeServer = null;
  }

  const current = hocuspocusInstance;
  hocuspocusInstance = null;

  if (current) {
    // Hocuspocus.destroy() waits for documents to unload (via afterUnloadDocument hooks).
    // If a doc is loaded but has no websocket connections, it can otherwise hang forever.
    try {
      const docs = (current as any)?.documents;
      const unload = (current as any)?.unloadDocument;
      if (docs && typeof docs.values === 'function' && typeof unload === 'function') {
        const toUnload = Array.from(docs.values());
        for (const doc of toUnload) {
          try {
            await Promise.resolve(unload.call(current, doc));
          } catch {
            // best-effort
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const docsToFlush = [...loadedDocs.entries()];
  for (const timer of persistTimers.values()) {
    clearTimeout(timer);
  }
  persistTimers.clear();
  for (const [slug, doc] of docsToFlush) {
    try {
      await persistOnStoreDocument(slug, doc);
    } catch (error) {
      console.error('[collab] Failed to flush document during shutdown:', { slug, error });
    }
  }
  loadedDocs.clear();
  lastPersistedStateVectors.clear();
  updatesSinceCompaction.clear();
  persistGeneration.clear();
  loadedDocDbMeta.clear();
  docLastAccessedAt.clear();
  docLastChangedAt.clear();
  warnedReadOnlyPersistSlugs.clear();
  for (const timer of projectionRepairScheduled.values()) {
    clearTimeout(timer);
  }
  projectionRepairScheduled.clear();
  projectionRepairRunning.clear();
  projectionRepairRetryIndex.clear();
  projectionRepairReasons.clear();
  projectionPathologyCooldowns.clear();
  staleOnStoreDriftCooldowns.clear();
  collabWsOversizeCooldowns.clear();
  projectionRepairWorkerOversizedSeen.clear();
  if (projectionRepairWorkerTimer) {
    clearTimeout(projectionRepairWorkerTimer);
    projectionRepairWorkerTimer = null;
  }
  if (startupProjectionReconcileTimer) {
    clearTimeout(startupProjectionReconcileTimer);
    startupProjectionReconcileTimer = null;
  }
  for (const timer of rewriteLockSlugs.values()) {
    clearTimeout(timer);
  }
  rewriteLockSlugs.clear();
  for (const timer of collabInvalidationReleaseTimers.values()) {
    clearTimeout(timer);
  }
  collabInvalidationReleaseTimers.clear();
  collabInvalidations.clear();
  skipOnStoreStateVectors.clear();
  if (current && typeof current.destroy === 'function') {
    await Promise.resolve(current.destroy());
  }
}

// Test-only escape hatch for validating Hocuspocus eviction behavior.
export function __unsafeGetHocuspocusInstanceForTests(): unknown {
  return hocuspocusInstance;
}

export function __unsafeGetLoadedDocForTests(slug: string): Y.Doc | null {
  return loadedDocs.get(slug) ?? null;
}

// Test-only helper for exercising stale onStoreDocument conflict handling paths.
export function __unsafePersistOnStoreDocumentForTests(slug: string, inMemoryDoc: Y.Doc): Promise<void> {
  return persistOnStoreDocument(slug, inMemoryDoc);
}

// Test-only helper for exercising onChange -> persistDoc conflict handling paths.
export function __unsafePersistDocFromOnChangeForTests(slug: string, inMemoryDoc: Y.Doc): void {
  void persistDoc(slug, inMemoryDoc, 'collab');
}

export function __unsafePersistDocForTests(slug: string, inMemoryDoc: Y.Doc, sourceActor: string): void {
  void persistDoc(slug, inMemoryDoc, sourceActor);
}

export function __unsafeSchedulePersistDocFromOnChangeForTests(slug: string, inMemoryDoc: Y.Doc): void {
  schedulePersistDoc(slug, inMemoryDoc);
}

// Test-only helper for exercising websocket error suppression behavior.
export function __unsafeAttachCollabSocketErrorHandlerForTests(
  socket: unknown,
  request: unknown,
  source: string,
): void {
  attachCollabSocketErrorHandler(socket, request, source);
}

// Test-only helper for direct websocket error suppression assertions.
export function __unsafeLogCollabSocketErrorForTests(request: unknown, source: string, error: unknown): void {
  logCollabSocketErrorWithSuppression(request, source, error);
}

async function evictHocuspocusDocument(slug: string): Promise<void> {
  const instance = hocuspocusInstance as any;
  if (!instance || !slug) return;

  try {
    // Ensure pending loads don't pin a stale document.
    instance.loadingDocuments?.delete?.(slug);
  } catch {
    // ignore
  }

  const doc = (() => {
    try {
      return instance.documents?.get?.(slug) ?? null;
    } catch {
      return null;
    }
  })();
  if (!doc) return;

  // If Hocuspocus has a debounced store queued, force it to run now so the document
  // can be unloaded immediately. Our onStoreDocument hook will no-op while the slug
  // is in collabInvalidations.
  try {
    const key = `onStoreDocument-${slug}`;
    if (instance.debouncer?.isDebounced?.(key)) {
      await Promise.resolve(instance.debouncer.executeNow(key));
    }
  } catch {
    // ignore
  }

  try {
    if (typeof instance.unloadDocument === 'function') {
      await Promise.resolve(instance.unloadDocument(doc));
    }
  } catch (error) {
    console.error('[collab] Failed to unload hocuspocus document during invalidate:', { slug, error });
  }

  try {
    // Best-effort hard delete in case unloadDocument short-circuited.
    instance.documents?.delete?.(slug);
  } catch {
    // ignore
  }
}

function logPendingYjsDeltaBeforeClear(slug: string, reason: string): void {
  try {
    const latest = getLatestYUpdate(slug);
    if (!latest) return;
    // Only log content snippets when explicitly enabled (contains user PII).
    const includeSnippet = (process.env.COLLAB_DEBUG_FORENSIC || '').trim() === '1';
    const snippet = includeSnippet
      ? (() => {
          const base64 = Buffer.from(latest.update).toString('base64');
          return base64.length > DEFAULT_PENDING_DELTA_SNIPPET_CHARS
            ? `${base64.slice(0, DEFAULT_PENDING_DELTA_SNIPPET_CHARS)}...`
            : base64;
        })()
      : undefined;
    console.warn('[collab] Pending Yjs delta before clear (forensic only)', {
      slug,
      reason,
      seq: latest.seq,
      bytes: latest.update.byteLength,
      ...(snippet !== undefined ? { base64Snippet: snippet } : {}),
      sourceActor: latest.source_actor,
      createdAt: latest.created_at,
    });
  } catch (error) {
    console.error('[collab] Failed to log pending Yjs delta before clear:', { slug, reason, error });
  }
}

type InvalidateCollabOptions = {
  clearPersistedState?: boolean;
};

async function invalidateCollabDocumentInner(
  slug: string,
  options?: InvalidateCollabOptions,
): Promise<void> {
  if (!slug) return;
  const clearPersistedState = options?.clearPersistedState !== false;
  skipOnStoreStateVectors.delete(slug);
  const nextPersistGeneration = cancelPendingPersistWork(slug, { advanceGeneration: true });
  const releaseTimer = collabInvalidationReleaseTimers.get(slug);
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    collabInvalidationReleaseTimers.delete(slug);
  }
  collabInvalidations.add(slug);
  evictLocalDocState(slug);
  persistGeneration.set(slug, nextPersistGeneration);
  if (clearPersistedState) {
    try {
      logPendingYjsDeltaBeforeClear(slug, 'invalidate:pre');
      clearYjsState(slug);
    } catch (error) {
      console.error('[collab] Failed to clear persisted Yjs state during invalidate:', { slug, error });
    }
  }

  const maybeClosable = hocuspocusInstance as unknown as {
    closeConnections?: (documentName?: string) => void | Promise<void>;
  } | null;
  try {
    if (maybeClosable && typeof maybeClosable.closeConnections === 'function') {
      try {
        await Promise.resolve(maybeClosable.closeConnections(slug));
      } catch {
        // Best effort; stale sessions are still constrained by short-lived tickets.
      }
    }
    await evictHocuspocusDocument(slug);
  } finally {
    if (clearPersistedState) {
      try {
        logPendingYjsDeltaBeforeClear(slug, 'invalidate:post');
        clearYjsState(slug);
      } catch (error) {
        console.error('[collab] Failed to clear persisted Yjs state after invalidate teardown:', { slug, error });
      }
    }
    releaseCollabInvalidation(slug);
  }
}

export function invalidateCollabDocument(slug: string): void {
  void invalidateCollabDocumentInner(slug);
}

export async function invalidateCollabDocumentAndWait(slug: string): Promise<void> {
  await invalidateCollabDocumentInner(slug);
}

export function invalidateLoadedCollabDocument(slug: string): void {
  void invalidateCollabDocumentInner(slug, { clearPersistedState: false });
}

export async function invalidateLoadedCollabDocumentAndWait(slug: string): Promise<void> {
  await invalidateCollabDocumentInner(slug, { clearPersistedState: false });
}
