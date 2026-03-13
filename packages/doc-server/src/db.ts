import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import type { ShareRole, ShareState } from './share-types.js';
import { fileURLToPath } from 'url';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeSingleNode,
  summarizeParseError,
} from './milkdown-headless.js';
import { recordMutationBackfill, recordMutationIdempotencyDualRead } from './metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: Database.Database;

const DEFAULT_EVENT_PAGE_SIZE = 100;
const DB_METADATA_TABLE = 'system_metadata';
const DB_ENV_METADATA_KEY = 'db_environment';
const MUTATION_IDEMPOTENCY_TABLE = 'mutation_idempotency';
const MUTATION_OUTBOX_TABLE = 'mutation_outbox';
const MARK_TOMBSTONES_TABLE = 'mark_tombstones';
const ACTIVE_COLLAB_CONNECTIONS_TABLE = 'active_collab_connections';
const MARK_TOMBSTONE_RETENTION_DAYS = 35;
const MUTATION_IDEMPOTENCY_BACKFILL_CURSOR_KEY = 'backfill.mutation_idempotency.last_rowid';
const MUTATION_OUTBOX_BACKFILL_CURSOR_KEY = 'backfill.mutation_outbox.last_event_id';
let warnedCrossEnvironmentOverride = false;
let metadataTableInitialized = false;
let idempotencyTableInitialized = false;
let documentEventsTableInitialized = false;
let mutationIdempotencyTableInitialized = false;
let mutationOutboxTableInitialized = false;
let markTombstonesTableInitialized = false;
let activeCollabConnectionsTableInitialized = false;
let lastActiveCollabConnectionPruneAt = 0;
const DEFAULT_ACTIVE_COLLAB_CONNECTION_TTL_MS = 45_000;
const DEFAULT_ACTIVE_COLLAB_CONNECTION_PRUNE_INTERVAL_MS = 10_000;
const DEFAULT_DOCUMENT_LIVE_COLLAB_LEASE_TTL_MS = 45_000;

function normalizeEnvironment(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return 'development';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  if (normalized === 'dev' || normalized === 'development' || normalized === 'local') return 'development';
  if (normalized === 'stage' || normalized === 'staging') return 'staging';
  if (normalized === 'test' || normalized === 'testing') return 'test';
  return normalized;
}

function getRuntimeEnvironment(): string {
  return normalizeEnvironment(process.env.PROOF_ENV || process.env.NODE_ENV || 'development');
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isCrossEnvironmentWriteOverrideEnabled(): boolean {
  return isTruthyFlag(process.env.ALLOW_CROSS_ENV_WRITES);
}

function createMetadataTableIfNeeded(d: Database.Database): void {
  if (metadataTableInitialized) return;
  d.exec(`
    CREATE TABLE IF NOT EXISTS ${DB_METADATA_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  metadataTableInitialized = true;
}

function readMetadataValue(d: Database.Database, key: string): string | null {
  const row = d.prepare(`
    SELECT value
    FROM ${DB_METADATA_TABLE}
    WHERE key = ?
    LIMIT 1
  `).get(key) as { value?: string } | undefined;
  return typeof row?.value === 'string' && row.value.trim().length > 0
    ? row.value.trim()
    : null;
}

function writeMetadataValue(d: Database.Database, key: string, value: string): void {
  const now = new Date().toISOString();
  d.prepare(`
    INSERT OR REPLACE INTO ${DB_METADATA_TABLE} (key, value, updated_at)
    VALUES (?, ?, ?)
  `).run(key, value, now);
}

function readMetadataNumber(d: Database.Database, key: string, fallback: number = 0): number {
  const raw = readMetadataValue(d, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function writeMetadataNumber(d: Database.Database, key: string, value: number): void {
  const normalized = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  writeMetadataValue(d, key, String(normalized));
}

function hasAnyDocuments(d: Database.Database): boolean {
  const row = d.prepare(`
    SELECT 1 AS present
    FROM documents
    LIMIT 1
  `).get() as { present?: number } | undefined;
  return row?.present === 1;
}

function readOrInitializeDatabaseEnvironment(d: Database.Database): string {
  createMetadataTableIfNeeded(d);

  const existing = readMetadataValue(d, DB_ENV_METADATA_KEY);
  if (existing) return normalizeEnvironment(existing);

  const runtimeEnv = getRuntimeEnvironment();
  const explicitInitEnvRaw = (process.env.PROOF_DB_ENV_INIT || '').trim();
  const explicitInitEnv = explicitInitEnvRaw ? normalizeEnvironment(explicitInitEnvRaw) : '';
  if (explicitInitEnv) {
    writeMetadataValue(d, DB_ENV_METADATA_KEY, explicitInitEnv);
    return explicitInitEnv;
  }

  if (runtimeEnv === 'production') {
    writeMetadataValue(d, DB_ENV_METADATA_KEY, runtimeEnv);
    return runtimeEnv;
  }

  if (!hasAnyDocuments(d)) {
    writeMetadataValue(d, DB_ENV_METADATA_KEY, runtimeEnv);
    return runtimeEnv;
  }

  if (isCrossEnvironmentWriteOverrideEnabled()) {
    console.warn('[db] Existing DB missing environment label; inferring from runtime due to ALLOW_CROSS_ENV_WRITES override', {
      runtimeEnv,
    });
    writeMetadataValue(d, DB_ENV_METADATA_KEY, runtimeEnv);
    return runtimeEnv;
  }

  throw new Error(
    `[db] Existing database is missing ${DB_ENV_METADATA_KEY} metadata. `
      + `Refusing to infer label for runtime "${runtimeEnv}". `
      + `Set PROOF_DB_ENV_INIT once (for example: development).`,
  );
}

function assertDatabaseEnvironmentCompatibility(context: 'startup' | 'write', operation?: string): void {
  const d = getDb();
  const runtimeEnv = getRuntimeEnvironment();
  const dbEnv = readOrInitializeDatabaseEnvironment(d);
  if (runtimeEnv === dbEnv) return;

  if (isCrossEnvironmentWriteOverrideEnabled()) {
    if (!warnedCrossEnvironmentOverride) {
      warnedCrossEnvironmentOverride = true;
      console.warn('[db] Cross-environment write override enabled; proceeding unsafely', {
        context,
        operation: operation ?? null,
        runtimeEnv,
        dbEnv,
      });
    }
    return;
  }

  const operationPart = operation ? ` operation="${operation}"` : '';
  throw new Error(
    `[db] ${context} blocked due to environment mismatch:${operationPart} `
      + `runtime="${runtimeEnv}" database="${dbEnv}". `
      + 'Set ALLOW_CROSS_ENV_WRITES=1 to override (unsafe).',
  );
}

function assertWritesAllowed(operation: string): void {
  assertDatabaseEnvironmentCompatibility('write', operation);
}

export interface DocumentRow {
  slug: string;
  doc_id: string | null;
  title: string | null;
  markdown: string;
  marks: string;
  revision: number;
  y_state_version: number;
  share_state: ShareState;
  access_epoch: number;
  live_collab_seen_at: string | null;
  live_collab_access_epoch: number | null;
  active: number;
  owner_id: string | null;
  owner_secret: string | null;
  owner_secret_hash: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentProjectionRow {
  document_slug: string;
  revision: number;
  y_state_version: number;
  markdown: string;
  marks_json: string;
  plain_text: string;
  updated_at: string;
  health: 'healthy' | 'projection_stale' | 'quarantined';
}

export interface ProjectedDocumentRow extends DocumentRow {
  plain_text: string;
  projection_health: 'healthy' | 'projection_stale' | 'quarantined';
  projection_revision: number | null;
  projection_y_state_version: number | null;
  projection_updated_at: string | null;
  canonical_markdown: string;
  canonical_marks: string;
}

export interface DocumentAuthStateRow {
  slug: string;
  doc_id: string | null;
  share_state: ShareState;
  access_epoch: number;
  owner_secret: string | null;
  owner_secret_hash: string | null;
}

export interface DocumentBlockRow {
  document_id: string;
  block_id: string;
  ordinal: number;
  node_type: string;
  attrs_json: string;
  markdown_hash: string;
  text_preview: string;
  created_revision: number;
  last_seen_revision: number;
  retired_revision: number | null;
}

export interface DocumentAccessRow {
  token_id: string;
  document_slug: string;
  role: ShareRole;
  secret_hash: string;
  created_at: string;
  revoked_at: string | null;
}

export interface DocumentEventRow {
  id: number;
  document_slug: string;
  document_revision: number | null;
  event_type: string;
  event_data: string;
  actor: string;
  idempotency_key: string | null;
  tombstone_revision: number | null;
  created_at: string;
  acked_by: string | null;
  acked_at: string | null;
}

export interface MutationOutboxRow {
  id: number;
  document_slug: string;
  document_revision: number | null;
  event_id: number | null;
  event_type: string;
  event_data: string;
  actor: string;
  idempotency_key: string | null;
  tombstone_revision: number | null;
  created_at: string;
  delivered_at: string | null;
}

export interface MarkTombstoneRow {
  document_slug: string;
  mark_id: string;
  status: 'accepted' | 'rejected' | 'resolved';
  resolved_revision: number;
  created_at: string;
  expires_at: string;
}

export interface DocumentYUpdateMetaRow {
  seq: number;
  source_actor: string | null;
  created_at: string;
}

export interface DocumentYUpdateRow extends DocumentYUpdateMetaRow {
  update: Uint8Array;
}

export interface DocumentYSnapshotRow {
  version: number;
  snapshot: Uint8Array;
  created_at: string;
}

export interface ShareAuthSessionRow {
  session_token_hash: string;
  provider: string;
  every_user_id: number;
  email: string;
  name: string | null;
  subscriber: number;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string;
  session_expires_at: string;
  last_verified_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActiveCollabConnectionRow {
  connection_id: string;
  document_slug: string;
  role: ShareRole;
  access_epoch: number;
  instance_id: string;
  connected_at: string;
  last_seen_at: string;
}

export interface ActiveCollabConnectionInput {
  connectionId: string;
  slug: string;
  role: ShareRole;
  accessEpoch: number;
  instanceId: string;
  observedAt?: string;
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'proof-share.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Favor availability over full fsync durability for sync writes.
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    initDatabase();
  }
  return db;
}

export function getDatabaseEnvironment(): string {
  return readOrInitializeDatabaseEnvironment(getDb());
}

export function assertDatabaseEnvironmentSafeForRuntime(): void {
  assertDatabaseEnvironmentCompatibility('startup');
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashOpaqueToken(value: string): string {
  return hashSecret(value);
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProjectionPlainText(markdown: string): string {
  return (markdown ?? '')
    .replace(/<\/?(?:p|br|div|li|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function upsertDocumentProjectionRow(
  slug: string,
  markdown: string,
  marks: string,
  revision: number,
  yStateVersion: number,
  updatedAt: string,
  health: DocumentProjectionRow['health'] = 'healthy',
): void {
  getDb().prepare(`
    INSERT INTO document_projections (
      document_slug,
      revision,
      y_state_version,
      markdown,
      marks_json,
      plain_text,
      updated_at,
      health
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_slug) DO UPDATE SET
      revision = excluded.revision,
      y_state_version = excluded.y_state_version,
      markdown = excluded.markdown,
      marks_json = excluded.marks_json,
      plain_text = excluded.plain_text,
      updated_at = excluded.updated_at,
      health = excluded.health
  `).run(
    slug,
    revision,
    yStateVersion,
    markdown,
    marks,
    normalizeProjectionPlainText(markdown),
    updatedAt,
    health,
  );
}

function backfillDocumentProjections(): void {
  const d = getDb();
  const rows = d.prepare(`
    SELECT slug, markdown, marks, revision, y_state_version, updated_at
    FROM documents
    WHERE share_state != 'DELETED'
  `).all() as Array<{
    slug: string;
    markdown: string;
    marks: string;
    revision: number | null;
    y_state_version: number | null;
    updated_at: string;
  }>;

  const tx = d.transaction(() => {
    for (const row of rows) {
      upsertDocumentProjectionRow(
        row.slug,
        row.markdown ?? '',
        row.marks ?? '{}',
        typeof row.revision === 'number' ? row.revision : 1,
        typeof row.y_state_version === 'number' ? row.y_state_version : 0,
        row.updated_at,
      );
    }
  });
  tx();
}

function getDocumentRevisionForSlug(d: Database.Database, slug: string): number | null {
  const row = d.prepare(`
    SELECT revision
    FROM documents
    WHERE slug = ?
    LIMIT 1
  `).get(slug) as { revision?: number } | undefined;
  return typeof row?.revision === 'number' ? row.revision : null;
}

function addMissingDocumentColumns(): void {
  const d = getDb();
  const columns = d.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has('doc_id')) {
    d.exec('ALTER TABLE documents ADD COLUMN doc_id TEXT');
  }
  if (!names.has('share_state')) {
    d.exec('ALTER TABLE documents ADD COLUMN share_state TEXT NOT NULL DEFAULT \'ACTIVE\'');
  }
  if (!names.has('access_epoch')) {
    d.exec('ALTER TABLE documents ADD COLUMN access_epoch INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('live_collab_seen_at')) {
    d.exec('ALTER TABLE documents ADD COLUMN live_collab_seen_at TEXT');
  }
  if (!names.has('live_collab_access_epoch')) {
    d.exec('ALTER TABLE documents ADD COLUMN live_collab_access_epoch INTEGER');
  }
  if (!names.has('deleted_at')) {
    d.exec('ALTER TABLE documents ADD COLUMN deleted_at TEXT');
  }
  if (!names.has('owner_secret_hash')) {
    d.exec('ALTER TABLE documents ADD COLUMN owner_secret_hash TEXT');
  }
  if (!names.has('revision')) {
    d.exec('ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!names.has('y_state_version')) {
    d.exec('ALTER TABLE documents ADD COLUMN y_state_version INTEGER NOT NULL DEFAULT 0');
  }
}

function addMissingIdempotencyColumns(): void {
  if (idempotencyTableInitialized) return;
  const d = getDb();
  const columns = d.prepare('PRAGMA table_info(idempotency_keys)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('request_hash')) {
    d.exec('ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT');
  }
  idempotencyTableInitialized = true;
}

function addMissingDocumentEventColumns(): void {
  if (documentEventsTableInitialized) return;
  const d = getDb();
  const columns = d.prepare('PRAGMA table_info(document_events)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('document_revision')) {
    d.exec('ALTER TABLE document_events ADD COLUMN document_revision INTEGER');
  }
  if (!names.has('tombstone_revision')) {
    d.exec('ALTER TABLE document_events ADD COLUMN tombstone_revision INTEGER');
  }
  documentEventsTableInitialized = true;
}

function addMissingMutationIdempotencyColumns(): void {
  if (mutationIdempotencyTableInitialized) return;
  const d = getDb();
  const columns = d.prepare(`PRAGMA table_info(${MUTATION_IDEMPOTENCY_TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('request_hash')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN request_hash TEXT`);
  }
  if (!names.has('status_code')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN status_code INTEGER NOT NULL DEFAULT 200`);
  }
  if (!names.has('tombstone_revision')) {
    d.exec(`ALTER TABLE ${MUTATION_IDEMPOTENCY_TABLE} ADD COLUMN tombstone_revision INTEGER`);
  }
  mutationIdempotencyTableInitialized = true;
}

function addMissingMutationOutboxColumns(): void {
  if (mutationOutboxTableInitialized) return;
  const d = getDb();
  const columns = d.prepare(`PRAGMA table_info(${MUTATION_OUTBOX_TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('document_revision')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN document_revision INTEGER`);
  }
  if (!names.has('event_id')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN event_id INTEGER`);
  }
  if (!names.has('idempotency_key')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN idempotency_key TEXT`);
  }
  if (!names.has('tombstone_revision')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN tombstone_revision INTEGER`);
  }
  if (!names.has('delivered_at')) {
    d.exec(`ALTER TABLE ${MUTATION_OUTBOX_TABLE} ADD COLUMN delivered_at TEXT`);
  }
  mutationOutboxTableInitialized = true;
}

function addMissingMarkTombstoneColumns(): void {
  if (markTombstonesTableInitialized) return;
  const d = getDb();
  const columns = d.prepare(`PRAGMA table_info(${MARK_TOMBSTONES_TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('status')) {
    d.exec(`ALTER TABLE ${MARK_TOMBSTONES_TABLE} ADD COLUMN status TEXT NOT NULL DEFAULT 'resolved'`);
  }
  if (!names.has('resolved_revision')) {
    d.exec(`ALTER TABLE ${MARK_TOMBSTONES_TABLE} ADD COLUMN resolved_revision INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('expires_at')) {
    d.exec(`ALTER TABLE ${MARK_TOMBSTONES_TABLE} ADD COLUMN expires_at TEXT`);
    const ttlDays = parsePositiveInt(process.env.MARK_TOMBSTONE_RETENTION_DAYS, MARK_TOMBSTONE_RETENTION_DAYS);
    d.prepare(`
      UPDATE ${MARK_TOMBSTONES_TABLE}
      SET expires_at = datetime(created_at, ?)
      WHERE expires_at IS NULL
    `).run(`+${ttlDays} days`);
  }
  markTombstonesTableInitialized = true;
}

function backfillDocumentColumns(): void {
  const d = getDb();
  const rows = d.prepare(`
    SELECT slug, doc_id, active, share_state, owner_secret, owner_secret_hash, revision, y_state_version
    FROM documents
  `).all() as Array<{
    slug: string;
    doc_id: string | null;
    active: number;
    share_state: string | null;
    owner_secret: string | null;
    owner_secret_hash: string | null;
    revision: number | null;
    y_state_version: number | null;
  }>;

  const setDocId = d.prepare('UPDATE documents SET doc_id = ? WHERE slug = ?');
  const setShareState = d.prepare('UPDATE documents SET share_state = ? WHERE slug = ?');
  const setOwnerSecretHash = d.prepare('UPDATE documents SET owner_secret_hash = ? WHERE slug = ?');
  const setRevision = d.prepare('UPDATE documents SET revision = ? WHERE slug = ?');
  const setYStateVersion = d.prepare('UPDATE documents SET y_state_version = ? WHERE slug = ?');
  const clearLegacyOwnerSecret = d.prepare(`
    UPDATE documents
    SET owner_secret = NULL
    WHERE owner_secret_hash IS NOT NULL AND owner_secret IS NOT NULL
  `);

  for (const row of rows) {
    if (!row.doc_id) {
      setDocId.run(randomUUID(), row.slug);
    }
    const shareStateMissing = !row.share_state || row.share_state.trim().length === 0;
    const legacyInactiveMismatch = row.active === 0 && row.share_state === 'ACTIVE';
    if (shareStateMissing || legacyInactiveMismatch) {
      setShareState.run(row.active === 1 ? 'ACTIVE' : 'PAUSED', row.slug);
    }
    if (!row.owner_secret_hash && row.owner_secret) {
      setOwnerSecretHash.run(hashSecret(row.owner_secret), row.slug);
    }
    if (row.revision == null) {
      setRevision.run(1, row.slug);
    }
    if (row.y_state_version == null) {
      setYStateVersion.run(0, row.slug);
    }
  }
  clearLegacyOwnerSecret.run();
}

function initDatabase(): void {
  const d = db;

  d.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      slug TEXT PRIMARY KEY,
      doc_id TEXT UNIQUE,
      title TEXT,
      markdown TEXT NOT NULL,
      marks TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      y_state_version INTEGER NOT NULL DEFAULT 0,
      share_state TEXT NOT NULL DEFAULT 'ACTIVE',
      access_epoch INTEGER NOT NULL DEFAULT 0,
      live_collab_seen_at TEXT,
      live_collab_access_epoch INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      owner_id TEXT,
      owner_secret TEXT,
      owner_secret_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);

  createMetadataTableIfNeeded(d);
  assertDatabaseEnvironmentCompatibility('startup');

  addMissingDocumentColumns();
  backfillDocumentColumns();

  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_doc_id ON documents(doc_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_documents_share_state ON documents(share_state)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_documents_slug_revision ON documents(slug, revision)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_documents_owner_id ON documents(owner_id)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_projections (
      document_slug TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      y_state_version INTEGER NOT NULL DEFAULT 0,
      markdown TEXT NOT NULL,
      marks_json TEXT NOT NULL DEFAULT '{}',
      plain_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      health TEXT NOT NULL DEFAULT 'healthy',
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_projections_revision ON document_projections(document_slug, revision)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_projections_health ON document_projections(health, updated_at)');
  backfillDocumentProjections();

  d.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_access (
      token_id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_access_slug ON document_access(document_slug)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_access_secret ON document_access(secret_hash)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      document_revision INTEGER,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      idempotency_key TEXT,
      tombstone_revision INTEGER,
      created_at TEXT NOT NULL,
      acked_by TEXT,
      acked_at TEXT,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  addMissingDocumentEventColumns();
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_events_slug_id ON document_events(document_slug, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_events_slug_tombstone ON document_events(document_slug, tombstone_revision, id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_events_slug_revision ON document_events(document_slug, document_revision, id)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idempotency_key TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      route TEXT NOT NULL,
      response_json TEXT NOT NULL,
      request_hash TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, document_slug, route)
    )
  `);
  addMissingIdempotencyColumns();

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${MUTATION_IDEMPOTENCY_TABLE} (
      idempotency_key TEXT NOT NULL,
      document_slug TEXT NOT NULL,
      route TEXT NOT NULL,
      response_json TEXT NOT NULL,
      request_hash TEXT,
      status_code INTEGER NOT NULL DEFAULT 200,
      tombstone_revision INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, document_slug, route)
    )
  `);
  addMissingMutationIdempotencyColumns();
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_slug_created_at
    ON ${MUTATION_IDEMPOTENCY_TABLE}(document_slug, created_at)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_slug_tombstone
    ON ${MUTATION_IDEMPOTENCY_TABLE}(document_slug, tombstone_revision, created_at)
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${MUTATION_OUTBOX_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      document_revision INTEGER,
      event_id INTEGER,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      actor TEXT NOT NULL,
      idempotency_key TEXT,
      tombstone_revision INTEGER,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `);
  addMissingMutationOutboxColumns();
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_outbox_slug_id
    ON ${MUTATION_OUTBOX_TABLE}(document_slug, id)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_outbox_slug_revision
    ON ${MUTATION_OUTBOX_TABLE}(document_slug, document_revision, id)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_outbox_pending
    ON ${MUTATION_OUTBOX_TABLE}(document_slug, delivered_at, tombstone_revision, id)
  `);
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mutation_outbox_event_id_unique
    ON ${MUTATION_OUTBOX_TABLE}(event_id)
    WHERE event_id IS NOT NULL
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${MARK_TOMBSTONES_TABLE} (
      document_slug TEXT NOT NULL,
      mark_id TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (document_slug, mark_id)
    )
  `);
  addMissingMarkTombstoneColumns();
  d.exec(`CREATE INDEX IF NOT EXISTS idx_mark_tombstones_expires_at ON ${MARK_TOMBSTONES_TABLE}(expires_at)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_mark_tombstones_slug_revision ON ${MARK_TOMBSTONES_TABLE}(document_slug, resolved_revision)`);

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_blocks (
      document_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      node_type TEXT NOT NULL,
      attrs_json TEXT NOT NULL DEFAULT '{}',
      markdown_hash TEXT NOT NULL,
      text_preview TEXT NOT NULL DEFAULT '',
      created_revision INTEGER NOT NULL,
      last_seen_revision INTEGER NOT NULL,
      retired_revision INTEGER,
      PRIMARY KEY (document_id, block_id)
    )
  `);
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_blocks_live_ordinal
    ON document_blocks(document_id, ordinal)
    WHERE retired_revision IS NULL
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_document_blocks_live_doc
    ON document_blocks(document_id, retired_revision, ordinal)
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_y_updates (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      update_blob BLOB NOT NULL,
      source_actor TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_y_updates_slug_seq ON document_y_updates(document_slug, seq)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_y_updates_slug_created_at ON document_y_updates(document_slug, created_at)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS document_y_snapshots (
      document_slug TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_blob BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_slug, version),
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_document_y_snapshots_slug_version ON document_y_snapshots(document_slug, version)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_runs (
      run_key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      summary TEXT
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS share_auth_sessions (
      session_token_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      every_user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      subscriber INTEGER NOT NULL DEFAULT 1,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      access_expires_at TEXT NOT NULL,
      session_expires_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_share_auth_sessions_revoked ON share_auth_sessions(revoked_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_share_auth_sessions_expiry ON share_auth_sessions(session_expires_at)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS ${ACTIVE_COLLAB_CONNECTIONS_TABLE} (
      connection_id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      access_epoch INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_slug_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(document_slug, last_seen_at)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_instance_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(instance_id, last_seen_at)
  `);
  activeCollabConnectionsTableInitialized = true;

  d.exec(`
    CREATE TABLE IF NOT EXISTS user_document_visits (
      every_user_id INTEGER NOT NULL,
      document_slug TEXT NOT NULL,
      role TEXT,
      first_visited_at TEXT NOT NULL,
      last_visited_at TEXT NOT NULL,
      PRIMARY KEY (every_user_id, document_slug)
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_udv_user_last ON user_document_visits(every_user_id, last_visited_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_udv_document_slug ON user_document_visits(document_slug)');

  d.exec(`
    CREATE TABLE IF NOT EXISTS library_documents (
      every_user_id INTEGER PRIMARY KEY,
      document_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (document_slug) REFERENCES documents(slug)
    )
  `);
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_library_documents_slug ON library_documents(document_slug)');
}

export function createDocument(
  slug: string,
  markdown: string,
  marks: Record<string, unknown>,
  title?: string,
  ownerId?: string,
  ownerSecret?: string,
): DocumentRow {
  assertWritesAllowed('createDocument');
  const now = new Date().toISOString();
  const d = getDb();
  const docId = randomUUID();
  const ownerSecretHash = ownerSecret ? hashSecret(ownerSecret) : null;

  d.prepare(`
    INSERT INTO documents (
      slug, doc_id, title, markdown, marks, revision, y_state_version, share_state, access_epoch, active,
      owner_id, owner_secret, owner_secret_hash, created_at, updated_at, deleted_at
    )
    VALUES (?, ?, ?, ?, ?, 1, 0, 'ACTIVE', 0, 1, ?, NULL, ?, ?, ?, NULL)
  `).run(
    slug,
    docId,
    title || null,
    markdown,
    JSON.stringify(marks),
    ownerId || null,
    ownerSecretHash,
    now,
    now,
  );

  upsertDocumentProjectionRow(slug, markdown, JSON.stringify(marks), 1, 0, now);

  return d.prepare('SELECT * FROM documents WHERE slug = ?').get(slug) as DocumentRow;
}

export function getDocument(slug: string): DocumentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM documents WHERE slug = ? AND share_state = \'ACTIVE\'')
    .get(slug) as DocumentRow | undefined;
}

export function getDocumentBySlug(slug: string): DocumentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM documents WHERE slug = ?')
    .get(slug) as DocumentRow | undefined;
}

export function getDocumentProjectionBySlug(slug: string): DocumentProjectionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM document_projections WHERE document_slug = ? LIMIT 1')
    .get(slug) as DocumentProjectionRow | undefined;
}

export function getProjectedDocumentBySlug(slug: string): ProjectedDocumentRow | undefined {
  return getDb().prepare(`
    SELECT
      d.*,
      d.markdown AS canonical_markdown,
      d.marks AS canonical_marks,
      COALESCE(p.markdown, d.markdown) AS markdown,
      COALESCE(p.marks_json, d.marks) AS marks,
      COALESCE(p.plain_text, d.markdown) AS plain_text,
      COALESCE(p.health, 'projection_stale') AS projection_health,
      p.revision AS projection_revision,
      p.y_state_version AS projection_y_state_version,
      p.updated_at AS projection_updated_at
    FROM documents d
    LEFT JOIN document_projections p
      ON p.document_slug = d.slug
    WHERE d.slug = ?
    LIMIT 1
  `).get(slug) as ProjectedDocumentRow | undefined;
}

export function setDocumentProjectionHealth(
  slug: string,
  health: DocumentProjectionRow['health'],
): boolean {
  assertWritesAllowed('setDocumentProjectionHealth');

  const result = getDb().prepare(`
    UPDATE document_projections
    SET health = ?
    WHERE document_slug = ?
  `).run(health, slug);

  if (result.changes > 0) return true;

  const row = getDocumentBySlug(slug);
  if (!row) return false;
  upsertDocumentProjectionRow(
    slug,
    row.markdown,
    row.marks,
    row.revision,
    row.y_state_version,
    row.updated_at,
    health,
  );
  return true;
}

export function getDocumentAuthStateBySlug(slug: string): DocumentAuthStateRow | undefined {
  return getDb()
    .prepare(`
      SELECT slug, doc_id, share_state, access_epoch, owner_secret, owner_secret_hash
      FROM documents
      WHERE slug = ?
      LIMIT 1
    `)
    .get(slug) as DocumentAuthStateRow | undefined;
}

function ensureActiveCollabConnectionsTable(): void {
  if (activeCollabConnectionsTableInitialized) return;
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS ${ACTIVE_COLLAB_CONNECTIONS_TABLE} (
      connection_id TEXT PRIMARY KEY,
      document_slug TEXT NOT NULL,
      role TEXT NOT NULL,
      access_epoch INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_slug_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(document_slug, last_seen_at)
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_active_collab_connections_instance_seen
    ON ${ACTIVE_COLLAB_CONNECTIONS_TABLE}(instance_id, last_seen_at)
  `);
  activeCollabConnectionsTableInitialized = true;
}

function getActiveCollabConnectionTtlMs(): number {
  return parsePositiveInt(process.env.ACTIVE_COLLAB_CONNECTION_TTL_MS, DEFAULT_ACTIVE_COLLAB_CONNECTION_TTL_MS);
}

function getDocumentLiveCollabLeaseTtlMs(): number {
  return parsePositiveInt(process.env.DOCUMENT_LIVE_COLLAB_LEASE_TTL_MS, DEFAULT_DOCUMENT_LIVE_COLLAB_LEASE_TTL_MS);
}

function maybePruneExpiredActiveCollabConnections(nowIso: string): void {
  const nowMs = Date.now();
  if (nowMs - lastActiveCollabConnectionPruneAt < DEFAULT_ACTIVE_COLLAB_CONNECTION_PRUNE_INTERVAL_MS) return;
  lastActiveCollabConnectionPruneAt = nowMs;
  const cutoffIso = new Date(Date.parse(nowIso) - getActiveCollabConnectionTtlMs()).toISOString();
  getDb().prepare(`
    DELETE FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE last_seen_at < ?
  `).run(cutoffIso);
}

export function upsertActiveCollabConnection(input: ActiveCollabConnectionInput): void {
  assertWritesAllowed('upsertActiveCollabConnection');
  ensureActiveCollabConnectionsTable();
  const observedAt = input.observedAt ?? new Date().toISOString();
  maybePruneExpiredActiveCollabConnections(observedAt);
  getDb().prepare(`
    INSERT INTO ${ACTIVE_COLLAB_CONNECTIONS_TABLE} (
      connection_id,
      document_slug,
      role,
      access_epoch,
      instance_id,
      connected_at,
      last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(connection_id) DO UPDATE SET
      document_slug = excluded.document_slug,
      role = excluded.role,
      access_epoch = excluded.access_epoch,
      instance_id = excluded.instance_id,
      last_seen_at = excluded.last_seen_at
  `).run(
    input.connectionId,
    input.slug,
    input.role,
    input.accessEpoch,
    input.instanceId,
    observedAt,
    observedAt,
  );
}

export function removeActiveCollabConnection(connectionId: string): void {
  assertWritesAllowed('removeActiveCollabConnection');
  ensureActiveCollabConnectionsTable();
  getDb().prepare(`
    DELETE FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE connection_id = ?
  `).run(connectionId);
}

export function countActiveCollabConnections(
  slug: string,
  accessEpoch?: number | null,
  observedAt: string = new Date().toISOString(),
): number {
  ensureActiveCollabConnectionsTable();
  const cutoffIso = new Date(Date.parse(observedAt) - getActiveCollabConnectionTtlMs()).toISOString();
  if (typeof accessEpoch === 'number' && Number.isFinite(accessEpoch)) {
    const row = getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
      WHERE document_slug = ?
        AND access_epoch = ?
        AND last_seen_at >= ?
    `).get(slug, accessEpoch, cutoffIso) as { count?: number } | undefined;
    return typeof row?.count === 'number' ? row.count : 0;
  }
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM ${ACTIVE_COLLAB_CONNECTIONS_TABLE}
    WHERE document_slug = ?
      AND last_seen_at >= ?
  `).get(slug, cutoffIso) as { count?: number } | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

export function noteDocumentLiveCollabLease(
  slug: string,
  accessEpoch: number,
  observedAt: string = new Date().toISOString(),
): void {
  assertWritesAllowed('noteDocumentLiveCollabLease');
  getDb().prepare(`
    UPDATE documents
    SET live_collab_seen_at = ?, live_collab_access_epoch = ?
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(observedAt, accessEpoch, slug);
}

export function getRecentDocumentLiveCollabLeaseBreakdown(
  slug: string,
  accessEpoch?: number | null,
  observedAt: string = new Date().toISOString(),
): { exactEpochCount: number; anyEpochCount: number } {
  const cutoffIso = new Date(Date.parse(observedAt) - getDocumentLiveCollabLeaseTtlMs()).toISOString();
  const row = getDb().prepare(`
    SELECT live_collab_seen_at AS seenAt, live_collab_access_epoch AS leaseEpoch
    FROM documents
    WHERE slug = ?
    LIMIT 1
  `).get(slug) as { seenAt?: string | null; leaseEpoch?: number | null } | undefined;
  const seenAt = typeof row?.seenAt === 'string' ? row.seenAt : null;
  if (!seenAt || seenAt < cutoffIso) {
    return { exactEpochCount: 0, anyEpochCount: 0 };
  }
  const leaseEpoch = typeof row?.leaseEpoch === 'number' && Number.isFinite(row.leaseEpoch)
    ? row.leaseEpoch
    : null;
  const exactEpochCount = typeof accessEpoch === 'number' && Number.isFinite(accessEpoch) && leaseEpoch === accessEpoch
    ? 1
    : 0;
  return {
    exactEpochCount,
    anyEpochCount: 1,
  };
}

export function listActiveDocuments(): DocumentRow[] {
  return getDb()
    .prepare('SELECT * FROM documents WHERE share_state = \'ACTIVE\'')
    .all() as DocumentRow[];
}

export function updateDocument(
  slug: string,
  markdown: string,
  marks?: Record<string, unknown>,
  yStateVersion?: number,
): boolean {
  assertWritesAllowed('updateDocument');
  const now = new Date().toISOString();
  if (marks !== undefined) {
    if (yStateVersion !== undefined) {
      const result = getDb().prepare(`
        UPDATE documents
        SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1, y_state_version = ?
        WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
      `).run(markdown, JSON.stringify(marks), now, yStateVersion, slug);
      if (result.changes > 0) {
        const updated = getDocumentBySlug(slug);
        if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
      }
      return result.changes > 0;
    }
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, JSON.stringify(marks), now, slug);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  if (yStateVersion !== undefined) {
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, updated_at = ?, revision = revision + 1, y_state_version = ?
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, now, yStateVersion, slug);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  const result = getDb().prepare(`
    UPDATE documents
    SET markdown = ?, updated_at = ?, revision = revision + 1
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(markdown, now, slug);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function updateDocumentTitle(slug: string, title: string | null): boolean {
  assertWritesAllowed('updateDocumentTitle');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET title = ?, updated_at = ?
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(title, now, slug);
  return result.changes > 0;
}

export function updateDocumentAtomic(
  slug: string,
  expectedUpdatedAt: string,
  markdown: string,
  marks?: Record<string, unknown>,
): boolean {
  assertWritesAllowed('updateDocumentAtomic');
  const now = new Date().toISOString();
  if (marks !== undefined) {
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
      WHERE slug = ? AND updated_at = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, JSON.stringify(marks), now, slug, expectedUpdatedAt);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  const result = getDb().prepare(`
    UPDATE documents
    SET markdown = ?, updated_at = ?, revision = revision + 1
    WHERE slug = ? AND updated_at = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(markdown, now, slug, expectedUpdatedAt);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function updateDocumentAtomicByRevision(
  slug: string,
  expectedRevision: number,
  markdown: string,
  marks?: Record<string, unknown>,
): boolean {
  assertWritesAllowed('updateDocumentAtomicByRevision');
  const now = new Date().toISOString();
  if (marks !== undefined) {
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1
      WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, JSON.stringify(marks), now, slug, expectedRevision);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }

  const result = getDb().prepare(`
    UPDATE documents
    SET markdown = ?, updated_at = ?, revision = revision + 1
    WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(markdown, now, slug, expectedRevision);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function updateMarks(slug: string, marks: Record<string, unknown>): boolean {
  assertWritesAllowed('updateMarks');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET marks = ?, updated_at = ?
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(JSON.stringify(marks), now, slug);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

export function replaceDocumentProjection(
  slug: string,
  markdown: string,
  marks: Record<string, unknown>,
  yStateVersion?: number,
): boolean {
  assertWritesAllowed('replaceDocumentProjection');
  if (yStateVersion !== undefined) {
    const result = getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, y_state_version = ?
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(markdown, JSON.stringify(marks), yStateVersion, slug);
    if (result.changes > 0) {
      const updated = getDocumentBySlug(slug);
      if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
    }
    return result.changes > 0;
  }
  const result = getDb().prepare(`
    UPDATE documents
    SET markdown = ?, marks = ?
    WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
  `).run(markdown, JSON.stringify(marks), slug);
  if (result.changes > 0) {
    const updated = getDocumentBySlug(slug);
    if (updated) upsertDocumentProjectionRow(slug, updated.markdown, updated.marks, updated.revision, updated.y_state_version, updated.updated_at);
  }
  return result.changes > 0;
}

type BlockDescriptor = {
  ordinal: number;
  node_type: string;
  attrs_json: string;
  markdown: string;
  markdown_hash: string;
  text_preview: string;
};

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function buildTextPreview(text: string, limit: number = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

async function buildBlockDescriptors(markdown: string): Promise<BlockDescriptor[]> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown ?? '');
  if (!parsed.doc) {
    throw new Error(`Failed to parse markdown into blocks: ${summarizeParseError(parsed.error)}`);
  }
  const doc = parsed.doc;
  const blocks: BlockDescriptor[] = [];

  for (let i = 0; i < doc.childCount; i += 1) {
    const node = doc.child(i);
    const blockMarkdown = await serializeSingleNode(node);
    blocks.push({
      ordinal: i + 1,
      node_type: node.type.name,
      attrs_json: JSON.stringify(node.attrs ?? {}),
      markdown: blockMarkdown,
      markdown_hash: hashMarkdown(blockMarkdown),
      text_preview: buildTextPreview(node.textContent),
    });
  }

  return blocks;
}

function blockKey(block: { node_type: string; markdown_hash: string }): string {
  return `${block.node_type}::${block.markdown_hash}`;
}

function computeLcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

function matchBlocks(
  oldBlocks: DocumentBlockRow[],
  newBlocks: BlockDescriptor[],
): Map<number, number> {
  const matches = new Map<number, number>(); // newIndex -> oldIndex
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();

  const max = Math.min(oldBlocks.length, newBlocks.length);
  for (let i = 0; i < max; i += 1) {
    if (blockKey(oldBlocks[i]) === blockKey(newBlocks[i])) {
      matches.set(i, i);
      usedOld.add(i);
      usedNew.add(i);
    }
  }

  const remainingOld = oldBlocks.map((_, idx) => idx).filter((idx) => !usedOld.has(idx));
  const remainingNew = newBlocks.map((_, idx) => idx).filter((idx) => !usedNew.has(idx));

  if (remainingOld.length && remainingNew.length) {
    const oldKeys = remainingOld.map((idx) => blockKey(oldBlocks[idx]));
    const newKeys = remainingNew.map((idx) => blockKey(newBlocks[idx]));
    const lcsMatches = computeLcsMatches(oldKeys, newKeys);
    for (const [oldIdx, newIdx] of lcsMatches) {
      const oldIndex = remainingOld[oldIdx];
      const newIndex = remainingNew[newIdx];
      matches.set(newIndex, oldIndex);
      usedOld.add(oldIndex);
      usedNew.add(newIndex);
    }
  }

  const stillOld = oldBlocks.map((_, idx) => idx).filter((idx) => !usedOld.has(idx));
  const stillNew = newBlocks.map((_, idx) => idx).filter((idx) => !usedNew.has(idx));

  for (const newIndex of stillNew) {
    const candidates = stillOld.filter((idx) => blockKey(oldBlocks[idx]) === blockKey(newBlocks[newIndex]));
    if (candidates.length === 1) {
      matches.set(newIndex, candidates[0]);
      usedOld.add(candidates[0]);
      usedNew.add(newIndex);
      continue;
    }

    if (candidates.length > 1) {
      let prevOld = -Infinity;
      let nextOld = Infinity;
      for (let i = newIndex - 1; i >= 0; i -= 1) {
        const match = matches.get(i);
        if (match !== undefined) {
          prevOld = match;
          break;
        }
      }
      for (let i = newIndex + 1; i < newBlocks.length; i += 1) {
        const match = matches.get(i);
        if (match !== undefined) {
          nextOld = match;
          break;
        }
      }
      const constrained = candidates.filter((idx) => idx > prevOld && idx < nextOld);
      if (constrained.length === 1) {
        matches.set(newIndex, constrained[0]);
        usedOld.add(constrained[0]);
        usedNew.add(newIndex);
      }
    }
  }

  return matches;
}

export function listLiveDocumentBlocks(documentId: string): DocumentBlockRow[] {
  return getDb().prepare(`
    SELECT *
    FROM document_blocks
    WHERE document_id = ? AND retired_revision IS NULL
    ORDER BY ordinal ASC
  `).all(documentId) as DocumentBlockRow[];
}

export function listDocumentBlocks(documentId: string): DocumentBlockRow[] {
  return getDb().prepare(`
    SELECT *
    FROM document_blocks
    WHERE document_id = ?
    ORDER BY ordinal ASC
  `).all(documentId) as DocumentBlockRow[];
}

export async function rebuildDocumentBlocks(
  document: DocumentRow,
  markdown: string,
  revision: number,
): Promise<DocumentBlockRow[]> {
  assertWritesAllowed('rebuildDocumentBlocks');
  if (!document.doc_id) {
    throw new Error('Document is missing doc_id; cannot rebuild block index.');
  }

  const documentId = document.doc_id;
  const oldBlocks = listLiveDocumentBlocks(documentId);
  const newBlocks = await buildBlockDescriptors(markdown);
  const matches = matchBlocks(oldBlocks, newBlocks);

  const nextBlocks = newBlocks.map((block, index) => {
    const oldIndex = matches.get(index);
    const existing = oldIndex !== undefined ? oldBlocks[oldIndex] : null;
    return {
      document_id: documentId,
      block_id: existing?.block_id ?? randomUUID(),
      ordinal: block.ordinal,
      node_type: block.node_type,
      attrs_json: block.attrs_json,
      markdown_hash: block.markdown_hash,
      text_preview: block.text_preview,
      created_revision: existing?.created_revision ?? revision,
      last_seen_revision: revision,
      retired_revision: null,
    } satisfies DocumentBlockRow;
  });

  const oldBlockIds = new Set(oldBlocks.map((block) => block.block_id));
  const usedOldIds = new Set<string>(nextBlocks.map((block) => block.block_id));
  const retiredOld = oldBlocks.filter((block) => !usedOldIds.has(block.block_id));

  const db = getDb();
  const updateTemp = db.prepare(`
    UPDATE document_blocks
    SET ordinal = ?, node_type = ?, attrs_json = ?, markdown_hash = ?, text_preview = ?, last_seen_revision = ?, retired_revision = NULL
    WHERE document_id = ? AND block_id = ?
  `);
  const updateOrdinal = db.prepare(`
    UPDATE document_blocks
    SET ordinal = ?
    WHERE document_id = ? AND block_id = ?
  `);
  const retire = db.prepare(`
    UPDATE document_blocks
    SET retired_revision = ?
    WHERE document_id = ? AND block_id = ? AND retired_revision IS NULL
  `);
  const insert = db.prepare(`
    INSERT INTO document_blocks (
      document_id, block_id, ordinal, node_type, attrs_json, markdown_hash, text_preview,
      created_revision, last_seen_revision, retired_revision
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  const tx = db.transaction(() => {
    for (const block of retiredOld) {
      retire.run(revision, documentId, block.block_id);
    }

    for (let i = 0; i < nextBlocks.length; i += 1) {
      const block = nextBlocks[i];
      if (oldBlockIds.has(block.block_id)) {
        updateTemp.run(-(i + 1), block.node_type, block.attrs_json, block.markdown_hash, block.text_preview, revision, documentId, block.block_id);
      }
    }

    for (const block of nextBlocks) {
      if (!oldBlockIds.has(block.block_id)) {
        insert.run(
          block.document_id,
          block.block_id,
          block.ordinal,
          block.node_type,
          block.attrs_json,
          block.markdown_hash,
          block.text_preview,
          block.created_revision,
          block.last_seen_revision,
        );
      }
    }

    for (const block of nextBlocks) {
      if (oldBlockIds.has(block.block_id)) {
        updateOrdinal.run(block.ordinal, documentId, block.block_id);
      }
    }
  });

  tx();
  return listLiveDocumentBlocks(documentId);
}

function updateShareState(slug: string, state: ShareState): boolean {
  assertWritesAllowed('updateShareState');
  const now = new Date().toISOString();
  if (state === 'DELETED') {
    const result = getDb().prepare(`
      UPDATE documents
      SET share_state = ?, active = 0, deleted_at = ?, updated_at = ?, access_epoch = access_epoch + 1
      WHERE slug = ?
    `).run(state, now, now, slug);
    return result.changes > 0;
  }

  const active = state === 'ACTIVE' ? 1 : 0;
  const result = getDb().prepare(`
    UPDATE documents
    SET share_state = ?, active = ?, deleted_at = NULL, updated_at = ?, access_epoch = CASE WHEN ? = 'ACTIVE' THEN access_epoch ELSE access_epoch + 1 END
    WHERE slug = ?
  `).run(state, active, now, state, slug);
  return result.changes > 0;
}

export function pauseDocument(slug: string): boolean {
  return updateShareState(slug, 'PAUSED');
}

export function resumeDocument(slug: string): boolean {
  return updateShareState(slug, 'ACTIVE');
}

export function revokeDocument(slug: string): boolean {
  return updateShareState(slug, 'REVOKED');
}

export function deleteDocument(slug: string): boolean {
  return updateShareState(slug, 'DELETED');
}

export function deactivateDocument(slug: string): boolean {
  return pauseDocument(slug);
}

export function addEvent(slug: string, eventType: string, eventData: unknown, actor: string): void {
  assertWritesAllowed('addEvent');
  const now = new Date().toISOString();
  const payload = JSON.stringify(eventData);
  const d = getDb();
  const tx = d.transaction(() => {
    const documentRevision = getDocumentRevisionForSlug(d, slug);
    d.prepare(`
      INSERT INTO events (document_slug, event_type, event_data, actor, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(slug, eventType, payload, actor, now);
    const result = d.prepare(`
      INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at
      )
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(slug, documentRevision, eventType, payload, actor, now);
    const eventId = Number(result.lastInsertRowid);
    d.prepare(`
      INSERT INTO ${MUTATION_OUTBOX_TABLE} (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at, delivered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
    `).run(slug, documentRevision, eventId, eventType, payload, actor, now);
  });
  tx();
}

export function addDocumentEvent(
  slug: string,
  eventType: string,
  eventData: unknown,
  actor: string,
  idempotencyKey?: string,
): number {
  assertWritesAllowed('addDocumentEvent');
  const now = new Date().toISOString();
  const payload = JSON.stringify(eventData);
  const d = getDb();
  const tx = d.transaction(() => {
    const documentRevision = getDocumentRevisionForSlug(d, slug);
    const result = d.prepare(`
      INSERT INTO document_events (
        document_slug, document_revision, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(slug, documentRevision, eventType, payload, actor, idempotencyKey ?? null, now);
    const eventId = Number(result.lastInsertRowid);
    d.prepare(`
      INSERT INTO ${MUTATION_OUTBOX_TABLE} (
        document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at, delivered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(slug, documentRevision, eventId, eventType, payload, actor, idempotencyKey ?? null, now);
    return eventId;
  });
  return tx();
}

export function listDocumentEvents(
  slug: string,
  afterId: number,
  limit: number = DEFAULT_EVENT_PAGE_SIZE,
): DocumentEventRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return getDb().prepare(`
    SELECT * FROM document_events
    WHERE document_slug = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(slug, afterId, safeLimit) as DocumentEventRow[];
}

export function ackDocumentEvents(slug: string, upToId: number, ackedBy: string): number {
  assertWritesAllowed('ackDocumentEvents');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE document_events
    SET acked_by = ?, acked_at = ?
    WHERE document_slug = ? AND id <= ? AND acked_at IS NULL
  `).run(ackedBy, now, slug, upToId);
  return result.changes;
}

export function createDocumentAccessToken(
  slug: string,
  role: ShareRole,
  providedSecret?: string,
): { tokenId: string; role: ShareRole; secret: string; createdAt: string } {
  assertWritesAllowed('createDocumentAccessToken');
  const now = new Date().toISOString();
  const secret = providedSecret ?? randomUUID();
  const tokenId = randomUUID();
  getDb().prepare(`
    INSERT INTO document_access (token_id, document_slug, role, secret_hash, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(tokenId, slug, role, hashSecret(secret), now);
  return { tokenId, role, secret, createdAt: now };
}

export function revokeDocumentAccessTokens(
  slug: string,
  role?: ShareRole,
  options?: { bumpEpoch?: boolean },
): number {
  assertWritesAllowed('revokeDocumentAccessTokens');
  const now = new Date().toISOString();
  const shouldBumpEpoch = options?.bumpEpoch !== false;
  let changes = 0;
  if (role) {
    const result = getDb().prepare(`
      UPDATE document_access
      SET revoked_at = ?
      WHERE document_slug = ? AND role = ? AND revoked_at IS NULL
    `).run(now, slug, role);
    changes = result.changes;
    if (changes > 0 && shouldBumpEpoch) {
      bumpDocumentAccessEpoch(slug);
    }
    return changes;
  }
  const result = getDb().prepare(`
    UPDATE document_access
    SET revoked_at = ?
    WHERE document_slug = ? AND revoked_at IS NULL
  `).run(now, slug);
  changes = result.changes;
  if (changes > 0 && shouldBumpEpoch) {
    bumpDocumentAccessEpoch(slug);
  }
  return changes;
}

export type DocumentAccessResolution = {
  role: ShareRole;
  tokenId: string | null;
  source: 'owner_secret' | 'owner_secret_legacy' | 'access_token';
};

export function resolveDocumentAccess(slug: string, presentedSecret: string): DocumentAccessResolution | null {
  if (!presentedSecret) return null;
  const hashed = hashSecret(presentedSecret);
  const doc = getDocumentAuthStateBySlug(slug);
  if (!doc) return null;
  if (doc.owner_secret_hash && timingSafeEqualString(doc.owner_secret_hash, hashed)) {
    return { role: 'owner_bot', tokenId: null, source: 'owner_secret' };
  }
  if (doc.owner_secret && timingSafeEqualString(doc.owner_secret, presentedSecret)) {
    return { role: 'owner_bot', tokenId: null, source: 'owner_secret_legacy' };
  }
  const row = getDb().prepare(`
    SELECT token_id, role
    FROM document_access
    WHERE document_slug = ? AND secret_hash = ? AND revoked_at IS NULL
    LIMIT 1
  `).get(slug, hashed) as { token_id?: string; role?: ShareRole } | undefined;
  if (!row?.role) return null;
  return {
    role: row.role,
    tokenId: row.token_id ?? null,
    source: 'access_token',
  };
}

export function resolveDocumentAccessRole(slug: string, presentedSecret: string): ShareRole | null {
  return resolveDocumentAccess(slug, presentedSecret)?.role ?? null;
}

export function bumpDocumentAccessEpoch(slug: string): number | null {
  assertWritesAllowed('bumpDocumentAccessEpoch');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET access_epoch = access_epoch + 1, updated_at = ?
    WHERE slug = ?
  `).run(now, slug);
  if (result.changes <= 0) return null;
  const row = getDb().prepare(`
    SELECT access_epoch
    FROM documents
    WHERE slug = ?
    LIMIT 1
  `).get(slug) as { access_epoch?: number } | undefined;
  return typeof row?.access_epoch === 'number' ? row.access_epoch : null;
}

export function canMutateByOwnerIdentity(
  doc: Pick<DocumentRow, 'owner_secret' | 'owner_secret_hash' | 'owner_id'>,
  ownerSecret: unknown,
): boolean {
  if (typeof ownerSecret === 'string' && ownerSecret.length > 0) {
    const ownerSecretHash = hashSecret(ownerSecret);
    if (doc.owner_secret_hash && timingSafeEqualString(doc.owner_secret_hash, ownerSecretHash)) {
      return true;
    }
    if (doc.owner_secret && timingSafeEqualString(doc.owner_secret, ownerSecret)) {
      return true;
    }
  }
  return false;
}

export function getStoredIdempotencyResult(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): Record<string, unknown> | null {
  const d = getDb();
  const coordinatorRow = d.prepare(`
    SELECT response_json
    FROM ${MUTATION_IDEMPOTENCY_TABLE}
    WHERE idempotency_key = ? AND document_slug = ? AND route = ?
    LIMIT 1
  `).get(idempotencyKey, documentSlug, route) as { response_json?: string } | undefined;
  const legacyRow = d.prepare(`
    SELECT response_json
    FROM idempotency_keys
    WHERE idempotency_key = ? AND document_slug = ? AND route = ?
    LIMIT 1
  `).get(idempotencyKey, documentSlug, route) as { response_json?: string } | undefined;

  if (coordinatorRow && legacyRow) {
    if (coordinatorRow.response_json === legacyRow.response_json) {
      recordMutationIdempotencyDualRead('parity_match', route);
    } else {
      recordMutationIdempotencyDualRead('parity_mismatch', route);
      console.warn('[db] idempotency dual-read parity mismatch', { documentSlug, route, idempotencyKey });
    }
  } else if (coordinatorRow) {
    recordMutationIdempotencyDualRead('new_only', route);
  } else if (legacyRow) {
    recordMutationIdempotencyDualRead('legacy_fallback', route);
  }

  const row = coordinatorRow ?? legacyRow;
  if (!row?.response_json) return null;
  try {
    return JSON.parse(row.response_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getStoredIdempotencyRecord(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): { response: Record<string, unknown>; requestHash: string | null } | null {
  const d = getDb();
  const coordinatorRow = d.prepare(`
    SELECT response_json, request_hash
    FROM ${MUTATION_IDEMPOTENCY_TABLE}
    WHERE idempotency_key = ? AND document_slug = ? AND route = ?
    LIMIT 1
  `).get(idempotencyKey, documentSlug, route) as { response_json?: string; request_hash?: string | null } | undefined;
  const legacyRow = d.prepare(`
    SELECT response_json, request_hash
    FROM idempotency_keys
    WHERE idempotency_key = ? AND document_slug = ? AND route = ?
    LIMIT 1
  `).get(idempotencyKey, documentSlug, route) as { response_json?: string; request_hash?: string | null } | undefined;

  if (coordinatorRow && legacyRow) {
    const responseParity = coordinatorRow.response_json === legacyRow.response_json;
    const hashParity = (coordinatorRow.request_hash ?? null) === (legacyRow.request_hash ?? null);
    if (responseParity && hashParity) {
      recordMutationIdempotencyDualRead('parity_match', route);
    } else {
      recordMutationIdempotencyDualRead('parity_mismatch', route);
      console.warn('[db] idempotency record dual-read parity mismatch', { documentSlug, route, idempotencyKey });
    }
  } else if (coordinatorRow) {
    recordMutationIdempotencyDualRead('new_hit', route);
  } else if (legacyRow) {
    recordMutationIdempotencyDualRead('legacy_fallback', route);
  }

  const row = coordinatorRow ?? legacyRow;
  if (!row?.response_json) return null;
  try {
    const response = JSON.parse(row.response_json) as Record<string, unknown>;
    return {
      response,
      requestHash: typeof row.request_hash === 'string' ? row.request_hash : null,
    };
  } catch {
    return null;
  }
}

export function storeIdempotencyResult(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
  response: Record<string, unknown>,
  requestHash?: string | null,
  options?: { statusCode?: number; tombstoneRevision?: number | null },
): void {
  assertWritesAllowed('storeIdempotencyResult');
  const now = new Date().toISOString();
  const statusCode = Number.isInteger(options?.statusCode) ? Number(options?.statusCode) : 200;
  const tombstoneRevision = options?.tombstoneRevision ?? null;
  const encoded = JSON.stringify(response);
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare(`
      INSERT OR REPLACE INTO idempotency_keys (idempotency_key, document_slug, route, response_json, request_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(idempotencyKey, documentSlug, route, encoded, requestHash ?? null, now);
    d.prepare(`
      INSERT OR REPLACE INTO ${MUTATION_IDEMPOTENCY_TABLE} (
        idempotency_key, document_slug, route, response_json, request_hash, status_code, tombstone_revision, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      idempotencyKey,
      documentSlug,
      route,
      encoded,
      requestHash ?? null,
      statusCode,
      tombstoneRevision,
      now,
    );
  });
  tx();
}

export function cleanupIdempotencyKeys(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  assertWritesAllowed('cleanupIdempotencyKeys');
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const d = getDb();
  const tx = d.transaction(() => {
    const legacy = d.prepare(`
      DELETE FROM idempotency_keys
      WHERE created_at < ?
    `).run(cutoff).changes;
    const coordinator = d.prepare(`
      DELETE FROM ${MUTATION_IDEMPOTENCY_TABLE}
      WHERE created_at < ?
    `).run(cutoff).changes;
    return legacy + coordinator;
  });
  return tx();
}

export function cleanupMutationOutbox(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
  assertWritesAllowed('cleanupMutationOutbox');
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const result = getDb().prepare(`
    DELETE FROM ${MUTATION_OUTBOX_TABLE}
    WHERE created_at < ?
  `).run(cutoff);
  return result.changes;
}

export function cleanupExpiredMarkTombstones(nowIso: string = new Date().toISOString()): number {
  assertWritesAllowed('cleanupExpiredMarkTombstones');
  const result = getDb().prepare(`
    DELETE FROM ${MARK_TOMBSTONES_TABLE}
    WHERE expires_at <= ?
  `).run(nowIso);
  return result.changes;
}

export function upsertMarkTombstone(
  slug: string,
  markId: string,
  status: 'accepted' | 'rejected' | 'resolved',
  resolvedRevision: number,
): MarkTombstoneRow {
  assertWritesAllowed('upsertMarkTombstone');
  const now = new Date().toISOString();
  const ttlDays = parsePositiveInt(process.env.MARK_TOMBSTONE_RETENTION_DAYS, MARK_TOMBSTONE_RETENTION_DAYS);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare(`
    INSERT OR REPLACE INTO ${MARK_TOMBSTONES_TABLE}
      (document_slug, mark_id, status, resolved_revision, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    markId,
    status,
    Math.max(0, Math.trunc(resolvedRevision)),
    now,
    expiresAt,
  );
  return getDb().prepare(`
    SELECT document_slug, mark_id, status, resolved_revision, created_at, expires_at
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ? AND mark_id = ?
    LIMIT 1
  `).get(slug, markId) as MarkTombstoneRow;
}

export function getMarkTombstone(slug: string, markId: string): MarkTombstoneRow | null {
  const row = getDb().prepare(`
    SELECT document_slug, mark_id, status, resolved_revision, created_at, expires_at
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ? AND mark_id = ?
    LIMIT 1
  `).get(slug, markId) as MarkTombstoneRow | undefined;
  return row ?? null;
}

export function listMarkTombstonesForDocument(slug: string): MarkTombstoneRow[] {
  return getDb().prepare(`
    SELECT document_slug, mark_id, status, resolved_revision, created_at, expires_at
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ?
    ORDER BY resolved_revision ASC, created_at ASC
  `).all(slug) as MarkTombstoneRow[];
}

export function shouldRejectMarkMutationByResolvedRevision(
  slug: string,
  markId: string,
  candidateRevision: number | null | undefined,
): boolean {
  if (!Number.isFinite(candidateRevision)) return false;
  const tombstone = getMarkTombstone(slug, markId);
  if (!tombstone) return false;
  return Math.trunc(candidateRevision as number) <= tombstone.resolved_revision;
}

export function removeResurrectedMarksFromPayload(
  slug: string,
  marks: Record<string, unknown>,
): { marks: Record<string, unknown>; removed: string[] } {
  const markIds = Object.keys(marks);
  if (markIds.length === 0) return { marks, removed: [] };

  const placeholders = markIds.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT mark_id
    FROM ${MARK_TOMBSTONES_TABLE}
    WHERE document_slug = ?
      AND mark_id IN (${placeholders})
  `).all(slug, ...markIds) as Array<{ mark_id: string }>;
  if (rows.length === 0) return { marks, removed: [] };

  const tombstoned = new Set(rows.map((row) => row.mark_id));
  const next: Record<string, unknown> = { ...marks };
  const removed: string[] = [];
  for (const markId of tombstoned) {
    const raw = next[markId];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      delete next[markId];
      removed.push(markId);
      continue;
    }
    const value = raw as Record<string, unknown>;
    const status = typeof value.status === 'string' ? value.status : '';
    const resolved = value.resolved === true;
    const isTerminal = resolved || status === 'accepted' || status === 'rejected';
    if (!isTerminal) {
      delete next[markId];
      removed.push(markId);
    }
  }
  return { marks: next, removed };
}

export function backfillMutationIdempotencyBatch(limit: number = 500): {
  scanned: number;
  inserted: number;
  checkpoint: number;
  done: boolean;
} {
  assertWritesAllowed('backfillMutationIdempotencyBatch');
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
  const d = getDb();
  createMetadataTableIfNeeded(d);
  const cursor = readMetadataNumber(d, MUTATION_IDEMPOTENCY_BACKFILL_CURSOR_KEY, 0);

  const rows = d.prepare(`
    SELECT rowid, idempotency_key, document_slug, route, response_json, request_hash, created_at
    FROM idempotency_keys
    WHERE rowid > ?
    ORDER BY rowid ASC
    LIMIT ?
  `).all(cursor, safeLimit) as Array<{
    rowid: number;
    idempotency_key: string;
    document_slug: string;
    route: string;
    response_json: string;
    request_hash: string | null;
    created_at: string;
  }>;

  let inserted = 0;
  let checkpoint = cursor;
  const insertStmt = d.prepare(`
    INSERT OR IGNORE INTO ${MUTATION_IDEMPOTENCY_TABLE}
      (idempotency_key, document_slug, route, response_json, request_hash, status_code, tombstone_revision, created_at)
    VALUES (?, ?, ?, ?, ?, 200, NULL, ?)
  `);

  const tx = d.transaction(() => {
    for (const row of rows) {
      checkpoint = row.rowid;
      inserted += insertStmt.run(
        row.idempotency_key,
        row.document_slug,
        row.route,
        row.response_json,
        row.request_hash,
        row.created_at,
      ).changes;
    }
    if (rows.length > 0) {
      writeMetadataNumber(d, MUTATION_IDEMPOTENCY_BACKFILL_CURSOR_KEY, checkpoint);
    }
  });
  tx();

  if (inserted > 0) {
    recordMutationBackfill('mutation_idempotency', 'inserted', inserted);
  }
  if (rows.length - inserted > 0) {
    recordMutationBackfill('mutation_idempotency', 'skipped', rows.length - inserted);
  }

  return {
    scanned: rows.length,
    inserted,
    checkpoint,
    done: rows.length < safeLimit,
  };
}

export function backfillMutationOutboxBatch(limit: number = 500): {
  scanned: number;
  inserted: number;
  checkpoint: number;
  done: boolean;
} {
  assertWritesAllowed('backfillMutationOutboxBatch');
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
  const d = getDb();
  createMetadataTableIfNeeded(d);
  const cursor = readMetadataNumber(d, MUTATION_OUTBOX_BACKFILL_CURSOR_KEY, 0);

  const rows = d.prepare(`
    SELECT id, document_slug, document_revision, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at
    FROM document_events
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(cursor, safeLimit) as Array<{
    id: number;
    document_slug: string;
    document_revision: number | null;
    event_type: string;
    event_data: string;
    actor: string;
    idempotency_key: string | null;
    tombstone_revision: number | null;
    created_at: string;
  }>;

  let inserted = 0;
  let checkpoint = cursor;
  const insertStmt = d.prepare(`
    INSERT OR IGNORE INTO ${MUTATION_OUTBOX_TABLE}
      (document_slug, document_revision, event_id, event_type, event_data, actor, idempotency_key, tombstone_revision, created_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  const tx = d.transaction(() => {
    for (const row of rows) {
      checkpoint = row.id;
      inserted += insertStmt.run(
        row.document_slug,
        row.document_revision ?? null,
        row.id,
        row.event_type,
        row.event_data,
        row.actor,
        row.idempotency_key ?? null,
        row.tombstone_revision ?? null,
        row.created_at,
      ).changes;
    }
    if (rows.length > 0) {
      writeMetadataNumber(d, MUTATION_OUTBOX_BACKFILL_CURSOR_KEY, checkpoint);
    }
  });
  tx();

  if (inserted > 0) {
    recordMutationBackfill('mutation_outbox', 'inserted', inserted);
  }
  if (rows.length - inserted > 0) {
    recordMutationBackfill('mutation_outbox', 'skipped', rows.length - inserted);
  }

  return {
    scanned: rows.length,
    inserted,
    checkpoint,
    done: rows.length < safeLimit,
  };
}

export function appendYUpdate(documentSlug: string, update: Uint8Array, sourceActor?: string): number {
  assertWritesAllowed('appendYUpdate');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO document_y_updates (document_slug, update_blob, source_actor, created_at)
    VALUES (?, ?, ?, ?)
  `).run(documentSlug, Buffer.from(update), sourceActor ?? null, now);
  return Number(result.lastInsertRowid);
}

export function getYUpdatesAfter(
  documentSlug: string,
  afterSeq: number,
): Array<{ seq: number; update: Uint8Array }> {
  const rows = getDb().prepare(`
    SELECT seq, update_blob
    FROM document_y_updates
    WHERE document_slug = ? AND seq > ?
    ORDER BY seq ASC
  `).all(documentSlug, afterSeq) as Array<{ seq: number; update_blob: Buffer }>;
  return rows.map((row) => ({ seq: row.seq, update: new Uint8Array(row.update_blob) }));
}

export function getYUpdatesInRange(
  documentSlug: string,
  afterSeqExclusive: number,
  upToSeqInclusive: number,
): DocumentYUpdateRow[] {
  const rows = getDb().prepare(`
    SELECT seq, update_blob, source_actor, created_at
    FROM document_y_updates
    WHERE document_slug = ? AND seq > ? AND seq <= ?
    ORDER BY seq ASC
  `).all(documentSlug, afterSeqExclusive, upToSeqInclusive) as Array<{
    seq: number;
    update_blob: Buffer;
    source_actor: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    seq: row.seq,
    update: new Uint8Array(row.update_blob),
    source_actor: row.source_actor ?? null,
    created_at: row.created_at,
  }));
}

export function getYUpdateMetaPage(
  documentSlug: string,
  beforeSeqExclusive: number | null,
  limit: number,
): DocumentYUpdateMetaRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  if (typeof beforeSeqExclusive === 'number' && Number.isFinite(beforeSeqExclusive)) {
    return getDb().prepare(`
      SELECT seq, source_actor, created_at
      FROM document_y_updates
      WHERE document_slug = ? AND seq < ?
      ORDER BY seq DESC
      LIMIT ?
    `).all(documentSlug, beforeSeqExclusive, safeLimit) as DocumentYUpdateMetaRow[];
  }
  return getDb().prepare(`
    SELECT seq, source_actor, created_at
    FROM document_y_updates
    WHERE document_slug = ?
    ORDER BY seq DESC
    LIMIT ?
  `).all(documentSlug, safeLimit) as DocumentYUpdateMetaRow[];
}

export function getLatestYUpdate(documentSlug: string): DocumentYUpdateRow | null {
  const row = getDb().prepare(`
    SELECT seq, update_blob, source_actor, created_at
    FROM document_y_updates
    WHERE document_slug = ?
    ORDER BY seq DESC
    LIMIT 1
  `).get(documentSlug) as {
    seq?: number;
    update_blob?: Buffer;
    source_actor?: string | null;
    created_at?: string;
  } | undefined;
  if (!row?.update_blob || row.seq === undefined || typeof row.created_at !== 'string') return null;
  return {
    seq: row.seq,
    update: new Uint8Array(row.update_blob),
    source_actor: row.source_actor ?? null,
    created_at: row.created_at,
  };
}

export function getLatestYStateVersion(documentSlug: string): number {
  const row = getDb().prepare(`
    SELECT
      COALESCE((SELECT MAX(seq) FROM document_y_updates WHERE document_slug = ?), 0) AS max_update_seq,
      COALESCE((SELECT MAX(version) FROM document_y_snapshots WHERE document_slug = ?), 0) AS max_snapshot_version
  `).get(documentSlug, documentSlug) as {
    max_update_seq?: number;
    max_snapshot_version?: number;
  } | undefined;

  const maxUpdateSeq = Number(row?.max_update_seq ?? 0);
  const maxSnapshotVersion = Number(row?.max_snapshot_version ?? 0);
  return Math.max(
    Number.isFinite(maxUpdateSeq) ? maxUpdateSeq : 0,
    Number.isFinite(maxSnapshotVersion) ? maxSnapshotVersion : 0,
  );
}

export function saveYSnapshot(documentSlug: string, version: number, snapshot: Uint8Array): void {
  assertWritesAllowed('saveYSnapshot');
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT OR REPLACE INTO document_y_snapshots (document_slug, version, snapshot_blob, created_at)
    VALUES (?, ?, ?, ?)
  `).run(documentSlug, version, Buffer.from(snapshot), now);
}

export function getLatestYSnapshot(documentSlug: string): { version: number; snapshot: Uint8Array } | null {
  const row = getDb().prepare(`
    SELECT version, snapshot_blob
    FROM document_y_snapshots
    WHERE document_slug = ?
    ORDER BY version DESC
    LIMIT 1
  `).get(documentSlug) as { version?: number; snapshot_blob?: Buffer } | undefined;
  if (!row?.snapshot_blob || row.version === undefined) return null;
  return {
    version: row.version,
    snapshot: new Uint8Array(row.snapshot_blob),
  };
}

export function getLatestYSnapshotAtOrBefore(documentSlug: string, seq: number): DocumentYSnapshotRow | null {
  const row = getDb().prepare(`
    SELECT version, snapshot_blob, created_at
    FROM document_y_snapshots
    WHERE document_slug = ? AND version <= ?
    ORDER BY version DESC
    LIMIT 1
  `).get(documentSlug, seq) as { version?: number; snapshot_blob?: Buffer; created_at?: string } | undefined;
  if (!row?.snapshot_blob || row.version === undefined || typeof row.created_at !== 'string') return null;
  return {
    version: row.version,
    snapshot: new Uint8Array(row.snapshot_blob),
    created_at: row.created_at,
  };
}

export function getSnapshotVersionsForSeqs(documentSlug: string, seqs: number[]): Set<number> {
  const uniqueSeqs = Array.from(new Set(seqs.filter((value) => Number.isFinite(value) && value > 0)));
  if (uniqueSeqs.length === 0) return new Set<number>();
  const placeholders = uniqueSeqs.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT version
    FROM document_y_snapshots
    WHERE document_slug = ? AND version IN (${placeholders})
  `).all(documentSlug, ...uniqueSeqs) as Array<{ version: number }>;
  return new Set(rows.map((row) => row.version));
}

export function listDocumentEventsInTimeRange(
  slug: string,
  fromIsoInclusive: string,
  toIsoInclusive: string,
): DocumentEventRow[] {
  return getDb().prepare(`
    SELECT *
    FROM document_events
    WHERE document_slug = ? AND created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC, id ASC
  `).all(slug, fromIsoInclusive, toIsoInclusive) as DocumentEventRow[];
}

export type DocumentBaselineCandidate = {
  slug: string;
  markdown: string;
  marks: string;
};

export type StaleProjectionCandidate = {
  slug: string;
  y_state_version: number;
  latest_y_state_version: number;
  projection_health: DocumentProjectionRow['health'];
  updated_at: string;
};

export type SuspiciousProjectionCandidate = {
  slug: string;
  updated_at: string;
  markdown_chars: number;
  y_state_version: number;
  latest_y_state_version: number;
  projection_health: DocumentProjectionRow['health'];
};

export function listDocumentsMissingYjsState(limit: number = 500): DocumentBaselineCandidate[] {
  const safeLimit = Math.max(1, Math.min(limit, 10_000));
  return getDb().prepare(`
    SELECT d.slug, d.markdown, d.marks
    FROM documents d
    WHERE d.share_state != 'DELETED'
      AND NOT EXISTS (
        SELECT 1 FROM document_y_updates u
        WHERE u.document_slug = d.slug
      )
      AND NOT EXISTS (
        SELECT 1 FROM document_y_snapshots s
        WHERE s.document_slug = d.slug
      )
    ORDER BY d.created_at ASC
    LIMIT ?
  `).all(safeLimit) as DocumentBaselineCandidate[];
}

export function listDocsWithStaleProjection(limit: number = 100): StaleProjectionCandidate[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  return getDb().prepare(`
    WITH latest AS (
      SELECT
        d.slug AS slug,
        d.updated_at AS updated_at,
        (
          SELECT MAX(value)
          FROM (
            SELECT COALESCE(MAX(u.seq), 0) AS value
            FROM document_y_updates u
            WHERE u.document_slug = d.slug
            UNION ALL
            SELECT COALESCE(MAX(s.version), 0) AS value
            FROM document_y_snapshots s
            WHERE s.document_slug = d.slug
          )
        ) AS latest_y_state_version
      FROM documents d
      WHERE d.share_state IN ('ACTIVE', 'PAUSED')
    )
    SELECT
      latest.slug,
      COALESCE(p.y_state_version, 0) AS y_state_version,
      latest.latest_y_state_version,
      COALESCE(p.health, 'projection_stale') AS projection_health,
      latest.updated_at
    FROM latest
    LEFT JOIN document_projections p
      ON p.document_slug = latest.slug
    WHERE latest.latest_y_state_version > COALESCE(p.y_state_version, 0)
       OR COALESCE(p.health, 'projection_stale') != 'healthy'
    ORDER BY latest.updated_at DESC
    LIMIT ?
  `).all(safeLimit) as StaleProjectionCandidate[];
}

export function listSuspiciousProjectionCandidates(
  limit: number = 100,
  minMarkdownChars: number = 1_000_000,
): SuspiciousProjectionCandidate[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  const safeMinChars = Math.max(1_000, Math.min(Math.trunc(minMarkdownChars), 100_000_000));
  return getDb().prepare(`
    WITH latest AS (
      SELECT
        d.slug AS slug,
        d.updated_at AS updated_at,
        (
          SELECT MAX(value)
          FROM (
            SELECT COALESCE(MAX(u.seq), 0) AS value
            FROM document_y_updates u
            WHERE u.document_slug = d.slug
            UNION ALL
            SELECT COALESCE(MAX(s.version), 0) AS value
            FROM document_y_snapshots s
            WHERE s.document_slug = d.slug
          )
        ) AS latest_y_state_version
      FROM documents d
      WHERE d.share_state IN ('ACTIVE', 'PAUSED')
    )
    SELECT
      latest.slug,
      latest.updated_at,
      LENGTH(COALESCE(p.markdown, d.markdown)) AS markdown_chars,
      COALESCE(p.y_state_version, 0) AS y_state_version,
      latest.latest_y_state_version,
      COALESCE(p.health, 'projection_stale') AS projection_health
    FROM latest
    JOIN documents d
      ON d.slug = latest.slug
    LEFT JOIN document_projections p
      ON p.document_slug = latest.slug
    WHERE LENGTH(COALESCE(p.markdown, d.markdown)) >= ?
       OR latest.latest_y_state_version > COALESCE(p.y_state_version, 0)
       OR COALESCE(p.health, 'projection_stale') != 'healthy'
    ORDER BY markdown_chars DESC, latest.updated_at DESC
    LIMIT ?
  `).all(safeMinChars, safeLimit) as SuspiciousProjectionCandidate[];
}

export function clearYjsState(documentSlug: string): { clearedUpdates: number; clearedSnapshots: number } {
  assertWritesAllowed('clearYjsState');
  const d = getDb();
  const tx = d.transaction(() => {
    const clearedUpdates = d.prepare(`
      DELETE FROM document_y_updates
      WHERE document_slug = ?
    `).run(documentSlug).changes;
    const clearedSnapshots = d.prepare(`
      DELETE FROM document_y_snapshots
      WHERE document_slug = ?
    `).run(documentSlug).changes;
    d.prepare(`
      UPDATE documents
      SET y_state_version = 0
      WHERE slug = ?
    `).run(documentSlug);
    return { clearedUpdates, clearedSnapshots };
  });
  return tx();
}

export function hasMaintenanceRun(runKey: string): boolean {
  const row = getDb()
    .prepare('SELECT run_key FROM maintenance_runs WHERE run_key = ?')
    .get(runKey) as { run_key?: string } | undefined;
  return Boolean(row?.run_key);
}

export function recordMaintenanceRun(runKey: string, summary?: unknown): void {
  assertWritesAllowed('recordMaintenanceRun');
  const now = new Date().toISOString();
  const encodedSummary = summary === undefined ? null : JSON.stringify(summary);
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO maintenance_runs (run_key, completed_at, summary)
      VALUES (?, ?, ?)
    `)
    .run(runKey, now, encodedSummary);
}

export function createShareAuthSession(input: {
  sessionToken: string;
  provider?: string;
  everyUserId: number;
  email: string;
  name?: string | null;
  subscriber?: boolean;
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt: string;
  sessionExpiresAt: string;
}): ShareAuthSessionRow {
  assertWritesAllowed('createShareAuthSession');
  const now = new Date().toISOString();
  const provider = input.provider ?? 'every';
  const hash = hashSecret(input.sessionToken);
  getDb().prepare(`
    INSERT OR REPLACE INTO share_auth_sessions (
      session_token_hash, provider, every_user_id, email, name, subscriber,
      access_token, refresh_token, access_expires_at, session_expires_at,
      last_verified_at, revoked_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    hash,
    provider,
    input.everyUserId,
    input.email,
    input.name ?? null,
    input.subscriber === false ? 0 : 1,
    input.accessToken,
    input.refreshToken ?? null,
    input.accessExpiresAt,
    input.sessionExpiresAt,
    now,
    now,
    now,
  );
  return getDb().prepare(`
    SELECT *
    FROM share_auth_sessions
    WHERE session_token_hash = ?
    LIMIT 1
  `).get(hash) as ShareAuthSessionRow;
}

export function getShareAuthSession(sessionToken: string): ShareAuthSessionRow | null {
  if (!sessionToken) return null;
  const hash = hashSecret(sessionToken);
  const row = getDb().prepare(`
    SELECT *
    FROM share_auth_sessions
    WHERE session_token_hash = ?
    LIMIT 1
  `).get(hash) as ShareAuthSessionRow | undefined;
  return row ?? null;
}

export function updateShareAuthSessionTokens(input: {
  sessionToken: string;
  accessToken: string;
  refreshToken?: string | null;
  accessExpiresAt: string;
}): boolean {
  assertWritesAllowed('updateShareAuthSessionTokens');
  const now = new Date().toISOString();
  const hash = hashSecret(input.sessionToken);
  const result = getDb().prepare(`
    UPDATE share_auth_sessions
    SET access_token = ?, refresh_token = ?, access_expires_at = ?, updated_at = ?, revoked_at = NULL
    WHERE session_token_hash = ?
  `).run(
    input.accessToken,
    input.refreshToken ?? null,
    input.accessExpiresAt,
    now,
    hash,
  );
  return result.changes > 0;
}

export function touchShareAuthSessionVerification(input: {
  sessionToken: string;
  email?: string | null;
  name?: string | null;
  subscriber?: boolean;
  sessionExpiresAt?: string;
}): boolean {
  assertWritesAllowed('touchShareAuthSessionVerification');
  const now = new Date().toISOString();
  const hash = hashSecret(input.sessionToken);
  const subscriberValue = input.subscriber === undefined ? null : (input.subscriber ? 1 : 0);
  const result = subscriberValue === null
    ? getDb().prepare(`
      UPDATE share_auth_sessions
      SET
        email = COALESCE(?, email),
        name = COALESCE(?, name),
        session_expires_at = COALESCE(?, session_expires_at),
        last_verified_at = ?,
        updated_at = ?
      WHERE session_token_hash = ?
    `).run(
      input.email ?? null,
      input.name ?? null,
      input.sessionExpiresAt ?? null,
      now,
      now,
      hash,
    )
    : getDb().prepare(`
      UPDATE share_auth_sessions
      SET
        email = COALESCE(?, email),
        name = COALESCE(?, name),
        subscriber = ?,
        session_expires_at = COALESCE(?, session_expires_at),
        last_verified_at = ?,
        updated_at = ?,
        revoked_at = NULL
      WHERE session_token_hash = ?
    `).run(
      input.email ?? null,
      input.name ?? null,
      subscriberValue,
      input.sessionExpiresAt ?? null,
      now,
      now,
      hash,
    );
  return result.changes > 0;
}

export function revokeShareAuthSession(sessionToken: string): boolean {
  assertWritesAllowed('revokeShareAuthSession');
  const now = new Date().toISOString();
  const hash = hashSecret(sessionToken);
  const result = getDb().prepare(`
    UPDATE share_auth_sessions
    SET revoked_at = ?, updated_at = ?
    WHERE session_token_hash = ?
  `).run(now, now, hash);
  return result.changes > 0;
}

// ── User Document Visits (dashboard) ──────────────────────────────────────────

export function upsertUserDocumentVisit(everyUserId: number, slug: string, role?: string): void {
  assertWritesAllowed('upsertUserDocumentVisit');
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO user_document_visits (every_user_id, document_slug, role, first_visited_at, last_visited_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (every_user_id, document_slug) DO UPDATE SET
      last_visited_at = excluded.last_visited_at,
      role = COALESCE(excluded.role, user_document_visits.role)
  `).run(everyUserId, slug, role ?? null, now, now);
}

export function getLibraryDocumentSlug(everyUserId: number): string | null {
  const row = getDb()
    .prepare('SELECT document_slug FROM library_documents WHERE every_user_id = ? LIMIT 1')
    .get(everyUserId) as { document_slug: string } | undefined;
  return row?.document_slug ?? null;
}

export function upsertLibraryDocument(everyUserId: number, slug: string): void {
  assertWritesAllowed('upsertLibraryDocument');
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO library_documents (every_user_id, document_slug, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (every_user_id) DO UPDATE SET
      document_slug = excluded.document_slug,
      updated_at = excluded.updated_at
  `).run(everyUserId, slug, now, now);
}

export function listDocumentVisitUserIds(slug: string, limit: number = 200): number[] {
  const rows = getDb().prepare(`
    SELECT every_user_id
    FROM user_document_visits
    WHERE document_slug = ?
    ORDER BY last_visited_at DESC
    LIMIT ?
  `).all(slug, limit) as Array<{ every_user_id: number }>;
  return rows.map((row) => row.every_user_id);
}

export interface DashboardDocumentRow {
  slug: string;
  title: string | null;
  share_state: string;
  updated_at: string;
  created_at: string;
  last_visited_at?: string;
  is_owned?: number;
  copy_url?: string;
}

export function listUserOwnedDocuments(oauthUserId: number, limit: number = 50): DashboardDocumentRow[] {
  const asStr = String(oauthUserId);
  return getDb().prepare(`
    SELECT slug, title, share_state, updated_at, created_at
    FROM documents
    WHERE (owner_id = ? OR owner_id = ? OR owner_id = ?)
      AND deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(asStr, `oauth:${asStr}`, `oauth_user:${asStr}`, limit) as DashboardDocumentRow[];
}

export function listSharedWithMeDocuments(oauthUserId: number, limit: number = 50): DashboardDocumentRow[] {
  const asStr = String(oauthUserId);
  return getDb().prepare(`
    SELECT d.slug, d.title, d.share_state, d.updated_at, d.created_at, v.last_visited_at
    FROM user_document_visits v
    JOIN documents d ON d.slug = v.document_slug
    WHERE v.every_user_id = ?
      AND d.deleted_at IS NULL
      AND d.share_state != 'DELETED'
      AND (d.owner_id IS NULL OR (d.owner_id != ? AND d.owner_id != ? AND d.owner_id != ?))
    ORDER BY v.last_visited_at DESC
    LIMIT ?
  `).all(oauthUserId, asStr, `oauth:${asStr}`, `oauth_user:${asStr}`, limit) as DashboardDocumentRow[];
}

export function listRecentlyOpenedDocuments(oauthUserId: number, limit: number = 50): DashboardDocumentRow[] {
  const asStr = String(oauthUserId);
  return getDb().prepare(`
    SELECT d.slug, d.title, d.share_state, d.updated_at, d.created_at, v.last_visited_at,
      CASE
        WHEN (d.owner_id = ? OR d.owner_id = ? OR d.owner_id = ?) THEN 1
        ELSE 0
      END AS is_owned
    FROM user_document_visits v
    JOIN documents d ON d.slug = v.document_slug
    WHERE v.every_user_id = ?
      AND d.deleted_at IS NULL
      AND d.share_state != 'DELETED'
    ORDER BY v.last_visited_at DESC
    LIMIT ?
  `).all(asStr, `oauth:${asStr}`, `oauth_user:${asStr}`, oauthUserId, limit) as DashboardDocumentRow[];
}

export function listDashboardDocuments(oauthUserId: number, limit: number = 100): DashboardDocumentRow[] {
  const asStr = String(oauthUserId);
  return getDb().prepare(`
    SELECT slug, title, share_state, updated_at, created_at, last_visited_at, is_owned
    FROM (
      SELECT
        d.slug,
        d.title,
        d.share_state,
        d.updated_at,
        d.created_at,
        NULL AS last_visited_at,
        1 AS is_owned,
        d.updated_at AS sort_at
      FROM documents d
      WHERE (d.owner_id = ? OR d.owner_id = ? OR d.owner_id = ?)
        AND d.deleted_at IS NULL

      UNION ALL

      SELECT
        d.slug,
        d.title,
        d.share_state,
        d.updated_at,
        d.created_at,
        v.last_visited_at AS last_visited_at,
        0 AS is_owned,
        COALESCE(v.last_visited_at, d.updated_at) AS sort_at
      FROM user_document_visits v
      JOIN documents d ON d.slug = v.document_slug
      WHERE v.every_user_id = ?
        AND d.deleted_at IS NULL
        AND d.share_state = 'ACTIVE'
        AND (d.owner_id IS NULL OR (d.owner_id != ? AND d.owner_id != ? AND d.owner_id != ?))
    )
    ORDER BY sort_at DESC
    LIMIT ?
  `).all(
    asStr,
    `oauth:${asStr}`,
    `oauth_user:${asStr}`,
    oauthUserId,
    asStr,
    `oauth:${asStr}`,
    `oauth_user:${asStr}`,
    limit,
  ) as DashboardDocumentRow[];
}

export function updateDocumentOwnerId(slug: string, ownerId: string): boolean {
  assertWritesAllowed('updateDocumentOwnerId');
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE documents
    SET owner_id = ?, updated_at = ?
    WHERE slug = ? AND (owner_id IS NULL OR owner_id = '')
  `).run(ownerId, now, slug);
  return result.changes > 0;
}
