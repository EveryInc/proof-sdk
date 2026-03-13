import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  ackDocumentEvents,
  addDocumentEvent,
  bumpDocumentAccessEpoch,
  getDocumentBySlug,
  getStoredIdempotencyRecord,
  listDocumentEvents,
  rebuildDocumentBlocks,
  resolveDocumentAccessRole,
  storeIdempotencyResult,
  updateDocument,
  updateDocumentAtomic,
  updateDocumentAtomicByRevision,
} from './db.js';
import {
  applyAgentPresenceToLoadedCollab,
  applyAgentCursorHintToLoadedCollab,
  applyCanonicalDocumentToCollab,
  applyCanonicalDocumentToCollabWithVerification,
  verifyCanonicalDocumentInLoadedCollab,
  getCollabRuntime,
  getLoadedCollabLastChangedAt,
  getLoadedCollabMarkdownForVerification,
  getLoadedCollabMarkdownFromFragment,
  getLoadedCollabFragmentTextHash,
  getLoadedCollabMarkdown,
  getCanonicalReadableDocumentSync,
  hasAgentPresenceInLoadedCollab,
  isCanonicalReadMutationReady,
  invalidateLoadedCollabDocument,
  removeAgentPresenceFromLoadedCollab,
  invalidateLoadedCollabDocumentAndWait,
  acquireRewriteLock,
  releaseRewriteLock,
  stripEphemeralCollabSpans,
} from './collab-shared.js';
import { canonicalizeStoredMarks, type StoredMark } from '@proof/core/marks';
import {
  deriveCollabApplied,
  deriveCursorApplied,
  derivePresenceApplied,
} from './agent-collab-status.js';
import { executeDocumentOperation, executeDocumentOperationAsync } from './document-engine-shared.js';
import {
  recordAgentMutation,
  recordRewriteBarrierFailure,
  recordRewriteBarrierLatency,
  recordRewriteForceIgnored,
  recordRewriteLiveClientBlock,
} from './metrics.js';
import type { ShareRole } from './share-types.js';
import { broadcastToRoom, getActiveCollabClientBreakdown, getActiveCollabClientCount } from './ws.js';
import { getCookie, shareTokenCookieName } from './cookies.js';
import {
  authorizeDocumentOp,
  type DocumentOpType,
  parseDocumentOpRequest,
  resolveDocumentOpRoute,
} from './document-ops.js';
import { applyAgentEditOperations, type AgentEditOperation } from './agent-edit-ops.js';
import {
  ALT_SHARE_TOKEN_HEADER_FORMAT,
  AUTH_HEADER_FORMAT,
} from './agent-guidance.js';
import { buildAgentSnapshot } from './agent-snapshot.js';
import { stripProofSpanTags } from './proof-span-strip.js';
import { applyAgentEditV2 } from './agent-edit-v2.js';
import { cloneFromCanonical, executeCanonicalRewrite, repairCanonicalProjection } from './canonical-document-shared.js';
import { validateRewriteApplyPayload } from './rewrite-validation.js';
import { adaptMutationResponse } from './mutation-coordinator.js';
import {
  annotateRewriteDisruptionMetadata,
  classifyRewriteBarrierFailureReason,
  evaluateRewriteLiveClientGate,
  isHostedRewriteEnvironment,
  rewriteBarrierFailedResponseBody,
  rewriteBlockedResponseBody,
} from './rewrite-policy.js';
import {
  getMutationContractStage,
  isIdempotencyRequired,
  validateEditPrecondition,
  validateOpPrecondition,
} from './mutation-stage.js';
import {
  normalizeAgentScopedId,
  resolveExplicitAgentIdentity,
} from '@proof/core/agent-identity';
import {
  buildProofSdkAgentDescriptor,
  buildProofSdkDocumentPaths,
  buildProofSdkLinks,
} from './proof-sdk-routes.js';

export const agentRoutes = Router({ mergeParams: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const REWRITE_COLLAB_TIMEOUT_MS = parsePositiveInt(process.env.PROOF_REWRITE_COLLAB_TIMEOUT_MS, 3000);
const REWRITE_BARRIER_TIMEOUT_MS = parsePositiveInt(process.env.PROOF_REWRITE_BARRIER_TIMEOUT_MS, 5000);
const EDIT_COLLAB_STABILITY_MS = parsePositiveInt(process.env.AGENT_EDIT_COLLAB_STABILITY_MS, 2500);
const EDIT_COLLAB_STABILITY_SAMPLE_MS = parsePositiveInt(process.env.AGENT_EDIT_COLLAB_STABILITY_SAMPLE_MS, 100);
const EDIT_ACTIVE_COLLAB_SETTLE_MS = parsePositiveInt(process.env.AGENT_EDIT_ACTIVE_COLLAB_SETTLE_MS, 300);
const EDIT_ACTIVE_COLLAB_SETTLE_SAMPLE_MS = parsePositiveInt(process.env.AGENT_EDIT_ACTIVE_COLLAB_SETTLE_SAMPLE_MS, 50);
const EDIT_ACTIVE_COLLAB_MIN_WAIT_MS = parsePositiveInt(process.env.AGENT_EDIT_ACTIVE_COLLAB_MIN_WAIT_MS, 150);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFeatureEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function getSlug(req: Request): string | null {
  const raw = req.params.slug;
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0];
  return null;
}

function getPresentedSecret(req: Request, slug?: string | null): string | null {
  const shareTokenHeader = req.header('x-share-token');
  if (typeof shareTokenHeader === 'string' && shareTokenHeader.trim()) return shareTokenHeader.trim();

  const bridgeTokenHeader = req.header('x-bridge-token');
  if (typeof bridgeTokenHeader === 'string' && bridgeTokenHeader.trim()) return bridgeTokenHeader.trim();

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }

  const queryToken = req.query.token;
  const trimmedQueryToken = typeof queryToken === 'string' ? queryToken.trim() : '';

  const resolvedSlug = typeof slug === 'string' && slug.trim() ? slug.trim() : getSlug(req);
  if (resolvedSlug) {
    const fromCookie = getCookie(req, shareTokenCookieName(resolvedSlug));
    const trimmedCookie = typeof fromCookie === 'string' ? fromCookie.trim() : '';
    if (trimmedQueryToken) {
      const roleFromQuery = resolveDocumentAccessRole(resolvedSlug, trimmedQueryToken);
      if (roleFromQuery) return trimmedQueryToken;
    }
    if (trimmedCookie) {
      const roleFromCookie = resolveDocumentAccessRole(resolvedSlug, trimmedCookie);
      if (roleFromCookie) return trimmedCookie;
    }
  }

  if (trimmedQueryToken) return trimmedQueryToken;
  return null;
}

function hasRole(role: ShareRole | null, allowed: ShareRole[]): boolean {
  if (!role) return false;
  return allowed.includes(role);
}

function getIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key') ?? req.header('x-idempotency-key');
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

function hashRequestBody(body: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  } catch {
    return createHash('sha256').update(String(body)).digest('hex');
  }
}

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function normalizeMarkdownForVerification(markdown: string): string {
  return stripEphemeralCollabSpans(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/g, '');
}

function stableSortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableSortValue(entry));
  if (!value || typeof value !== 'object') return value;
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

function isCanonicalStabilityDebugEnabled(): boolean {
  const flag = (process.env.COLLAB_DEBUG_CANONICAL_STABILITY || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function parseCanonicalMarks(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
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

function normalizeCanonicalMarksForHash(marks: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [markId, value] of Object.entries(marks ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      normalized[markId] = value;
      continue;
    }
    const kind = (value as { kind?: unknown }).kind;
    if (kind === 'authored') continue;
    const status = (value as { status?: unknown }).status;
    if (
      (kind === 'insert' || kind === 'delete' || kind === 'replace')
      && (status === 'accepted' || status === 'rejected')
    ) {
      continue;
    }
    normalized[markId] = value;
  }
  return normalized;
}

function parseMarksPayload(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed marks payload
  }
  return {};
}

function hashCanonicalDocument(markdown: string, marks: Record<string, unknown> | undefined): string {
  const normalizedMarkdown = normalizeMarkdownForVerification(markdown);
  return createHash('sha256')
    .update(stableStringify({ markdown: normalizedMarkdown, marks: normalizeCanonicalMarksForHash(marks) }))
    .digest('hex');
}

function summarizeStringDiff(expected: string, observed: string): {
  index: number | null;
  expectedSnippet: string;
  observedSnippet: string;
} {
  const maxContext = 48;
  const minLength = Math.min(expected.length, observed.length);
  let index: number | null = null;
  for (let i = 0; i < minLength; i += 1) {
    if (expected[i] !== observed[i]) {
      index = i;
      break;
    }
  }
  if (index === null && expected.length !== observed.length) {
    index = minLength;
  }
  if (index === null) {
    return { index: null, expectedSnippet: '', observedSnippet: '' };
  }
  const start = Math.max(0, index - 16);
  const end = Math.min(Math.max(expected.length, observed.length), index + maxContext);
  return {
    index,
    expectedSnippet: expected.slice(start, end),
    observedSnippet: observed.slice(start, end),
  };
}

function summarizeMarksDiff(
  expected: Record<string, unknown>,
  observed: Record<string, unknown>,
): {
  missing: string[];
  extra: string[];
  changed: string[];
} {
  const expectedKeys = Object.keys(expected);
  const observedKeys = Object.keys(observed);
  const missing = expectedKeys.filter((key) => !(key in observed));
  const extra = observedKeys.filter((key) => !(key in expected));
  const changed: string[] = [];
  for (const key of expectedKeys) {
    if (!(key in observed)) continue;
    const expectedValue = stableStringify(expected[key]);
    const observedValue = stableStringify(observed[key]);
    if (expectedValue !== observedValue) changed.push(key);
  }
  return { missing, extra, changed };
}

function logCanonicalStabilityMismatch(params: {
  slug: string;
  expectedMarkdown: string;
  expectedMarks: Record<string, unknown>;
  observedMarkdown: string;
  observedMarks: Record<string, unknown>;
  expectedHash: string;
  observedHash: string | null;
}): void {
  if (!isCanonicalStabilityDebugEnabled()) return;
  const normalizedExpectedMarks = normalizeCanonicalMarksForHash(params.expectedMarks);
  const normalizedObservedMarks = normalizeCanonicalMarksForHash(params.observedMarks);
  const expectedMarkdown = params.expectedMarkdown ?? '';
  const observedMarkdown = params.observedMarkdown ?? '';
  const rawMarkdownDiff = summarizeStringDiff(expectedMarkdown, observedMarkdown);
  const normalizedExpectedMarkdown = normalizeMarkdownForVerification(expectedMarkdown);
  const normalizedObservedMarkdown = normalizeMarkdownForVerification(observedMarkdown);
  const normalizedMarkdownDiff = summarizeStringDiff(normalizedExpectedMarkdown, normalizedObservedMarkdown);
  const marksDiff = summarizeMarksDiff(normalizedExpectedMarks, normalizedObservedMarks);
  const normalizedHash = hashCanonicalDocument(normalizedExpectedMarkdown, normalizedExpectedMarks);
  const normalizedObservedHash = hashCanonicalDocument(normalizedObservedMarkdown, normalizedObservedMarks);
  console.warn('[agent-routes] canonical stability mismatch', {
    slug: params.slug,
    expectedHash: params.expectedHash,
    observedHash: params.observedHash,
    expectedMarkdownLength: expectedMarkdown.length,
    observedMarkdownLength: observedMarkdown.length,
    expectedMarkdownHash: hashMarkdown(expectedMarkdown),
    observedMarkdownHash: hashMarkdown(observedMarkdown),
    normalizedExpectedMarkdownHash: hashMarkdown(normalizedExpectedMarkdown),
    normalizedObservedMarkdownHash: hashMarkdown(normalizedObservedMarkdown),
    normalizedHash,
    normalizedObservedHash,
    rawDiffIndex: rawMarkdownDiff.index,
    rawExpectedSnippet: rawMarkdownDiff.expectedSnippet,
    rawObservedSnippet: rawMarkdownDiff.observedSnippet,
    normalizedDiffIndex: normalizedMarkdownDiff.index,
    normalizedExpectedSnippet: normalizedMarkdownDiff.expectedSnippet,
    normalizedObservedSnippet: normalizedMarkdownDiff.observedSnippet,
    marksMissing: marksDiff.missing,
    marksExtra: marksDiff.extra,
    marksChanged: marksDiff.changed,
  });
}

function shouldIncludeCanonicalDiagnostics(): boolean {
  const runtimeEnv = (process.env.PROOF_ENV || process.env.NODE_ENV || '').trim().toLowerCase();
  if (runtimeEnv !== 'production' && runtimeEnv !== 'prod') return true;
  const flag = (process.env.AGENT_EDIT_CANONICAL_DIAGNOSTICS || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

function hasUnsafeLegacyEditMarks(raw: string | null | undefined): boolean {
  const marks = parseMarksPayload(raw);
  return Object.values(marks).some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const kind = (value as { kind?: unknown }).kind;
    return kind === 'comment'
      || kind === 'insert'
      || kind === 'delete'
      || kind === 'replace'
      || kind === 'authored';
  });
}

type IdempotencyReplayResult = {
  handled: boolean;
  idempotencyKey: string | null;
  requestHash: string | null;
};

function maybeReplayIdempotentMutation(
  req: Request,
  res: Response,
  slug: string,
  mutationRoute: string,
  routeKey: string,
): IdempotencyReplayResult {
  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return { handled: false, idempotencyKey: null, requestHash: null };
  }
  const requestHash = hashRequestBody(req.body);
  const existing = getStoredIdempotencyRecord(slug, routeKey, idempotencyKey);
  if (!existing) {
    return { handled: false, idempotencyKey, requestHash };
  }
  if (existing.requestHash && existing.requestHash !== requestHash) {
    sendMutationResponse(
      res,
      409,
      {
        success: false,
        code: 'IDEMPOTENCY_KEY_REUSED',
        error: 'Idempotency key cannot be reused with a different payload',
      },
      { route: mutationRoute, slug },
    );
    return { handled: true, idempotencyKey, requestHash };
  }
  sendMutationResponse(res, 200, existing.response, { route: mutationRoute, slug });
  return { handled: true, idempotencyKey, requestHash };
}

function storeIdempotentMutationResult(
  slug: string,
  routeKey: string,
  replay: IdempotencyReplayResult,
  status: number,
  body: Record<string, unknown>,
): void {
  if (!replay.idempotencyKey) return;
  if (status < 200 || status >= 300) return;
  storeIdempotencyResult(slug, routeKey, replay.idempotencyKey, body, replay.requestHash);
}

function routeRequiresMutation(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  if (path === '/events/ack' || path.endsWith('/events/ack')) return false;
  return true;
}

function getMutationRouteLabel(req: Request): string {
  const parts = req.path.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return `/${parts.slice(1).join('/')}`;
}

async function resolveEditOperationBaseMarkdown(
  slug: string,
  route: string,
  canonicalMarkdown: string,
  collabRuntimeEnabled: boolean,
): Promise<{ markdown: string; source: 'db' | 'live'; activeCollabClients: number }> {
  if (!collabRuntimeEnabled) {
    return { markdown: canonicalMarkdown, source: 'db', activeCollabClients: 0 };
  }

  const activeCollabClients = getActiveCollabClientCount(slug);
  if (activeCollabClients <= 0) {
    return { markdown: canonicalMarkdown, source: 'db', activeCollabClients };
  }

  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, EDIT_ACTIVE_COLLAB_SETTLE_MS);
  const minWaitUntil = startedAt + Math.max(0, EDIT_ACTIVE_COLLAB_MIN_WAIT_MS);
  let collabBase = getLoadedCollabMarkdown(slug);
  let lastChangedAt = getLoadedCollabLastChangedAt(slug) ?? startedAt;

  while (Date.now() < deadline) {
    await sleep(Math.max(10, EDIT_ACTIVE_COLLAB_SETTLE_SAMPLE_MS));
    const currentBase = getLoadedCollabMarkdown(slug);
    const currentChangedAt = getLoadedCollabLastChangedAt(slug) ?? lastChangedAt;
    if (currentBase !== collabBase || currentChangedAt !== lastChangedAt) {
      collabBase = currentBase;
      lastChangedAt = currentChangedAt;
      continue;
    }
    if (Date.now() >= minWaitUntil) break;
  }

  const fragmentBase = await getLoadedCollabMarkdownFromFragment(slug);
  const liveBase = fragmentBase ?? collabBase;
  if (fragmentBase !== null && collabBase !== null && fragmentBase !== collabBase) {
    console.warn('[agent-routes] /edit detected fragment/projection drift; preferring fragment-derived live markdown', {
      slug,
      route,
      activeCollabClients,
      fragmentLength: fragmentBase.length,
      projectionLength: collabBase.length,
      settleMs: Date.now() - startedAt,
    });
  }

  if (liveBase !== null && liveBase !== canonicalMarkdown) {
    console.warn('[agent-routes] /edit detected live collab/base drift; using live collab markdown for op application', {
      slug,
      route,
      activeCollabClients,
      collabLength: liveBase.length,
      canonicalLength: canonicalMarkdown.length,
      settleMs: Date.now() - startedAt,
    });
    return { markdown: liveBase, source: 'live', activeCollabClients };
  }

  return { markdown: canonicalMarkdown, source: 'db', activeCollabClients };
}

async function prepareRewriteCollabBarrier(slug: string): Promise<void> {
  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) return;
  // Acquire a rewrite lock BEFORE disconnecting clients.  This prevents any
  // client-originated onChange/onStoreDocument writes from sneaking through
  // during the window between disconnect and rewrite completion.
  acquireRewriteLock(slug);
  try {
    if ((process.env.PROOF_REWRITE_BARRIER_FORCE_FAIL || '').trim() === '1') {
      throw new Error('forced rewrite barrier failure');
    }
    bumpDocumentAccessEpoch(slug);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        invalidateLoadedCollabDocumentAndWait(slug),
        new Promise<void>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`rewrite collab barrier timed out after ${REWRITE_BARRIER_TIMEOUT_MS}ms`));
          }, REWRITE_BARRIER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } catch (error) {
    console.error('[agent-routes] Failed to prepare rewrite collab barrier:', { slug, error });
    // Best-effort fire-and-forget invalidation, but re-throw so the caller
    // does NOT proceed with the rewrite while clients may still be connected.
    invalidateLoadedCollabDocument(slug);
    throw error;
  }
}

function checkAuth(
  req: Request,
  res: Response,
  slug: string,
  allowedRoles: ShareRole[],
): ShareRole | null {
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ success: false, error: 'Document not found' });
    return null;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ success: false, error: 'Document deleted' });
    return null;
  }

  const secret = getPresentedSecret(req, slug);
  const role = secret ? resolveDocumentAccessRole(slug, secret) : null;

  if (doc.share_state === 'REVOKED' && role !== 'owner_bot') {
    res.status(403).json({ success: false, error: 'Document access revoked' });
    return null;
  }
  if (doc.share_state === 'PAUSED' && role !== 'owner_bot') {
    res.status(403).json({ success: false, error: 'Document is not currently accessible' });
    return null;
  }

  if (!hasRole(role, allowedRoles)) {
    res.status(401).json({
      success: false,
      error: 'Missing or invalid share token',
      code: 'UNAUTHORIZED',
      acceptedHeaders: [
        'x-share-token: <ACCESS_TOKEN>',
        'x-bridge-token: <OWNER_SECRET>',
        'Authorization: Bearer <TOKEN>',
      ],
    });
    return null;
  }
  return role;
}

function sendMutationResponse(
  res: Response,
  status: number,
  body: unknown,
  context: { route: string; slug?: string; retryWithState?: string },
): void {
  const adapted = adaptMutationResponse(status, body, context);
  res.status(adapted.status).json(adapted.body);
}

function asPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function enforceMutationPrecondition(
  res: Response,
  slug: string,
  mutationRoute: string,
  opType: DocumentOpType,
  payload: Record<string, unknown>,
): boolean {
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { success: false, error: 'Document not found' }, { route: mutationRoute, slug });
    return false;
  }

  const canonicalDoc = getCanonicalReadableDocumentSync(slug, 'state') ?? doc;
  if (!isCanonicalReadMutationReady(canonicalDoc)) {
    sendMutationResponse(res, 409, {
      success: false,
      code: 'PROJECTION_STALE',
      error: 'Document projection is stale; retry after repair completes',
      latestUpdatedAt: null,
      latestRevision: null,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return false;
  }

  const stage = getMutationContractStage();
  const opPrecondition = validateOpPrecondition(stage, opType, doc, payload);
  if (!opPrecondition.ok) {
    sendMutationResponse(res, 409, {
      success: false,
      code: opPrecondition.code,
      error: opPrecondition.error,
      latestUpdatedAt: doc.updated_at,
      latestRevision: doc.revision,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return false;
  }
  return true;
}

type AgentParticipation = {
  presenceEntry: Record<string, unknown>;
  cursorHint?: { quote?: string; ttlMs?: number } | null;
};

function ensureAgentPresenceForAuthenticatedCall(
  req: Request,
  slug: string,
  body: Record<string, unknown>,
  details: string,
): boolean {
  const identity = resolveExplicitAgentIdentity(body, req.header('x-agent-id'));
  if (identity.kind !== 'ok') return false;
  const { id, name, color, avatar } = identity;

  if (hasAgentPresenceInLoadedCollab(slug, id)) return false;

  const now = new Date().toISOString();
  const entry = {
    id,
    name,
    color,
    avatar,
    status: 'active',
    details,
    at: now,
  };
  const activity = {
    type: 'agent.presence',
    ...entry,
    autoJoined: true,
  } satisfies Record<string, unknown>;

  const collabApplied = applyAgentPresenceToLoadedCollab(slug, entry, activity);
  if (!collabApplied) return false;

  addDocumentEvent(slug, 'agent.presence', entry, id);
  broadcastToRoom(slug, {
    type: 'agent.presence',
    source: 'agent',
    timestamp: now,
    ...entry,
    autoJoined: true,
  });
  return true;
}

function findQuoteForMarkId(slug: string, markId: string): string | null {
  const doc = getDocumentBySlug(slug);
  if (!doc || typeof doc.marks !== 'string' || !doc.marks.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.marks);
  } catch {
    return null;
  }

  const maxDepth = 6;
  const walk = (value: unknown, depth: number): string | null => {
    if (depth > maxDepth) return null;
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record.id === markId && typeof record.quote === 'string' && record.quote.trim()) {
        return record.quote.trim();
      }
      for (const child of Object.values(record)) {
        const found = walk(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(parsed, 0);
}

function extractCursorQuote(slug: string, body: Record<string, unknown>): string | null {
  const quote = typeof body.quote === 'string' && body.quote.trim() ? body.quote.trim() : null;
  if (quote) return quote;
  const markId = typeof body.markId === 'string' && body.markId.trim() ? body.markId.trim() : null;
  if (markId) {
    const fromMarks = findQuoteForMarkId(slug, markId);
    if (fromMarks) return fromMarks;
  }
  return null;
}

function buildParticipationFromMutation(
  req: Request,
  slug: string,
  body: Record<string, unknown>,
  options?: { quote?: string | null; details?: string | null; ttlMs?: number | null },
): AgentParticipation | null {
  const identity = resolveExplicitAgentIdentity(body, req.header('x-agent-id'));
  if (identity.kind !== 'ok') return null;
  const now = new Date().toISOString();
  const presenceEntry: Record<string, unknown> = {
    id: identity.id,
    name: identity.name,
    color: identity.color,
    avatar: identity.avatar,
    status: 'editing',
    details: options?.details ?? '',
    at: now,
  };
  const quote = (options?.quote ?? extractCursorQuote(slug, body)) ?? null;
  const cursorHint = quote ? { quote, ttlMs: options?.ttlMs ?? 3000 } : null;
  return { presenceEntry, cursorHint };
}

type CollabMutationStatus = {
  confirmed: boolean;
  reason?: string;
  markdownConfirmed?: boolean;
  fragmentConfirmed?: boolean;
  canonicalConfirmed?: boolean;
  canonicalExpectedHash?: string | null;
  canonicalObservedHash?: string | null;
  expectedFragmentTextHash?: string | null;
  liveFragmentTextHash?: string | null;
  presenceApplied?: boolean;
  cursorApplied?: boolean;
};

type CanonicalDocumentStability = {
  stable: boolean;
  expectedHash: string;
  observedHash: string | null;
  reason?: string;
};

async function verifyLoadedCollabMarkdownStable(
  slug: string,
  expectedMarkdown: string,
  stabilityMs: number,
): Promise<boolean> {
  if (stabilityMs <= 0) return true;
  const expectedSanitized = normalizeMarkdownForVerification(expectedMarkdown);
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, EDIT_COLLAB_STABILITY_SAMPLE_MS);
  while (Date.now() <= deadline) {
    const currentSample = await getLoadedCollabMarkdownForVerification(slug);
    const current = currentSample.markdown;
    if (current === null) return true;
    const sanitizedCurrent = normalizeMarkdownForVerification(current);
    if (sanitizedCurrent !== expectedSanitized) {
      const derived = await getLoadedCollabMarkdownFromFragment(slug);
      const sanitizedDerived = derived === null ? null : normalizeMarkdownForVerification(derived);
      if (sanitizedDerived === null || sanitizedDerived !== expectedSanitized) return false;
    }
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  return true;
}

async function verifyLoadedCollabFragmentStable(
  slug: string,
  expectedFragmentTextHash: string,
  stabilityMs: number,
): Promise<boolean> {
  if (stabilityMs <= 0) return true;
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, EDIT_COLLAB_STABILITY_SAMPLE_MS);
  while (Date.now() <= deadline) {
    const current = await getLoadedCollabFragmentTextHash(slug);
    if (current === null) return true;
    if (current !== expectedFragmentTextHash) return false;
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
  return true;
}

async function verifyCanonicalDocumentStable(
  slug: string,
  expectedMarkdown: string,
  expectedMarks: Record<string, unknown> | undefined,
  stabilityMs: number,
): Promise<CanonicalDocumentStability> {
  const expectedHash = hashCanonicalDocument(expectedMarkdown, expectedMarks);
  if (stabilityMs <= 0) {
    return { stable: true, expectedHash, observedHash: expectedHash };
  }
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, EDIT_COLLAB_STABILITY_SAMPLE_MS);
  let matched = false;
  let observedHash: string | null = null;
  while (Date.now() <= deadline) {
    const current = getDocumentBySlug(slug);
    if (!current) {
      return {
        stable: false,
        expectedHash,
        observedHash: null,
        reason: 'missing_document',
      };
    }
    const observedMarkdown = current.markdown ?? '';
    const observedMarks = parseCanonicalMarks(current.marks);
    observedHash = hashCanonicalDocument(observedMarkdown, observedMarks);
    if (observedHash === expectedHash) {
      matched = true;
    } else if (matched) {
      logCanonicalStabilityMismatch({
        slug,
        expectedMarkdown,
        expectedMarks: expectedMarks ?? {},
        observedMarkdown,
        observedMarks,
        expectedHash,
        observedHash,
      });
      return {
        stable: false,
        expectedHash,
        observedHash,
        reason: 'canonical_stability_regressed',
      };
    }
    await sleep(sampleMs);
  }
  if (!matched) {
    const current = getDocumentBySlug(slug);
    if (current) {
      logCanonicalStabilityMismatch({
        slug,
        expectedMarkdown,
        expectedMarks: expectedMarks ?? {},
        observedMarkdown: current.markdown ?? '',
        observedMarks: parseCanonicalMarks(current.marks),
        expectedHash,
        observedHash,
      });
    }
    return {
      stable: false,
      expectedHash,
      observedHash,
      reason: 'canonical_stability_regressed',
    };
  }
  return { stable: true, expectedHash, observedHash: expectedHash };
}

function notifyCollabMutation(
  slug: string,
  participation?: AgentParticipation | null,
  options?: { verify?: boolean; source?: string; stabilityMs?: number; fallbackBarrier?: boolean; strictLiveDoc?: boolean; apply?: boolean },
): Promise<CollabMutationStatus> {
  // Live collaboration has one authoritative source of truth: the loaded Yjs doc.
  // Canonical markdown/marks in the DB are a derived projection that must remain in
  // sync with that authoritative state. A mutation is only "confirmed" once the live
  // Yjs state converges and the derived canonical row stays stable afterward.
  return (async () => {
    const now = new Date().toISOString();
    try {
      const collab = getCollabRuntime();
      if (!collab.enabled) {
        invalidateLoadedCollabDocument(slug);
        return { confirmed: true, reason: 'collab_disabled' };
      }

      const doc = getDocumentBySlug(slug);
      if (!doc) {
        invalidateLoadedCollabDocument(slug);
        return { confirmed: false, reason: 'missing_document' };
      }

      const targetMarkdown = typeof doc.markdown === 'string' ? doc.markdown : '';
      const targetMarks = parseCanonicalMarks(doc.marks);

      let verifiedStatus: CollabMutationStatus = {
        confirmed: true,
        canonicalConfirmed: true,
        canonicalExpectedHash: hashCanonicalDocument(targetMarkdown, targetMarks),
        canonicalObservedHash: hashCanonicalDocument(targetMarkdown, targetMarks),
        presenceApplied: false,
        cursorApplied: false,
      };
      if (options?.verify) {
        const debugConvergence = (process.env.COLLAB_DEBUG_FRAGMENT_CONVERGENCE || '').trim() === '1';
        const activeCollabClients = getActiveCollabClientCount(slug);
        const verification = options?.apply === false
          ? await verifyCanonicalDocumentInLoadedCollab(slug, {
            markdown: targetMarkdown,
            marks: targetMarks,
            source: options.source ?? 'agent',
          }, REWRITE_COLLAB_TIMEOUT_MS)
          : await applyCanonicalDocumentToCollabWithVerification(slug, {
            markdown: targetMarkdown,
            marks: targetMarks,
            source: options.source ?? 'agent',
          }, REWRITE_COLLAB_TIMEOUT_MS);

        let confirmed = verification.confirmed;
        let reason = verification.reason;
        let markdownConfirmed = verification.markdownConfirmed;
        let fragmentConfirmed = verification.fragmentConfirmed;
        let canonicalConfirmed = true;
        let canonicalExpectedHash = hashCanonicalDocument(targetMarkdown, targetMarks);
        let canonicalObservedHash: string | null = canonicalExpectedHash;
        let expectedFragmentTextHash = verification.expectedFragmentTextHash;
        let liveFragmentTextHash = verification.liveFragmentTextHash;
        if (options?.strictLiveDoc && confirmed && reason === 'no_live_doc') {
          confirmed = false;
          reason = 'live_doc_unavailable';
        }
        if (debugConvergence) {
          console.info('[agent-routes] collab verification diagnostics', {
            slug,
            source: options.source ?? 'agent',
            activeCollabClients,
            confirmed,
            reason,
            markdownConfirmed,
            fragmentConfirmed,
            markdownSource: verification.markdownSource,
            canonicalConfirmed,
            canonicalExpectedHash,
            canonicalObservedHash,
            expectedFragmentTextHash,
            liveFragmentTextHash,
          });
        }
        if (confirmed && targetMarkdown && (options.stabilityMs ?? 0) > 0) {
          const stable = await verifyLoadedCollabMarkdownStable(slug, targetMarkdown, options.stabilityMs as number);
          if (!stable) {
            confirmed = false;
            reason = 'stability_regressed';
            markdownConfirmed = false;
          }
        }
        if (confirmed && expectedFragmentTextHash && (options.stabilityMs ?? 0) > 0) {
          const stableFragment = await verifyLoadedCollabFragmentStable(
            slug,
            expectedFragmentTextHash,
            options.stabilityMs as number,
          );
          if (!stableFragment) {
            confirmed = false;
            reason = 'fragment_stability_regressed';
            fragmentConfirmed = false;
            liveFragmentTextHash = await getLoadedCollabFragmentTextHash(slug);
          }
        }
        if (confirmed && (options.stabilityMs ?? 0) > 0) {
          const canonical = await verifyCanonicalDocumentStable(
            slug,
            targetMarkdown,
            targetMarks,
            options.stabilityMs as number,
          );
          canonicalConfirmed = canonical.stable;
          canonicalExpectedHash = canonical.expectedHash;
          canonicalObservedHash = canonical.observedHash;
          if (!canonical.stable) {
            confirmed = false;
            reason = canonical.reason ?? 'canonical_stability_regressed';
          }
        }

        if (!confirmed && options?.fallbackBarrier) {
          console.warn('[agent-routes] collab verification drift detected; applying rewrite barrier fallback', {
            slug,
            reason,
            yStateVersion: verification.yStateVersion,
          });
          let barrierLocked = false;
          try {
            barrierLocked = true;
            await prepareRewriteCollabBarrier(slug);
          } catch (error) {
            if (barrierLocked) releaseRewriteLock(slug);
            console.warn('[agent-routes] collab fallback barrier failed', { slug, error });
            invalidateLoadedCollabDocument(slug);
            return { confirmed: false, reason: 'fallback_barrier_failed' };
          }

          try {
            const refreshed = getDocumentBySlug(slug);
            if (!refreshed) {
              invalidateLoadedCollabDocument(slug);
              return { confirmed: false, reason: 'missing_document' };
            }
            const repaired = updateDocument(slug, targetMarkdown, targetMarks);
            if (!repaired) {
              invalidateLoadedCollabDocument(slug);
              return { confirmed: false, reason: 'canonical_repair_failed' };
            }

            const retry = await applyCanonicalDocumentToCollabWithVerification(slug, {
              markdown: targetMarkdown,
              marks: targetMarks,
              source: `${options.source ?? 'agent'}-fallback`,
            }, REWRITE_COLLAB_TIMEOUT_MS);
            confirmed = retry.confirmed;
            reason = retry.reason;
            markdownConfirmed = retry.markdownConfirmed;
            fragmentConfirmed = retry.fragmentConfirmed;
            expectedFragmentTextHash = retry.expectedFragmentTextHash;
            liveFragmentTextHash = retry.liveFragmentTextHash;
            if (options?.strictLiveDoc && confirmed && reason === 'no_live_doc') {
              confirmed = false;
              reason = 'live_doc_unavailable';
            }
            if (debugConvergence) {
              console.info('[agent-routes] collab verification retry diagnostics', {
                slug,
                confirmed,
                reason,
                markdownConfirmed,
                fragmentConfirmed,
                markdownSource: retry.markdownSource,
                canonicalConfirmed,
                canonicalExpectedHash,
                canonicalObservedHash,
                expectedFragmentTextHash,
                liveFragmentTextHash,
              });
            }
            if (confirmed && targetMarkdown && (options.stabilityMs ?? 0) > 0) {
              const stable = await verifyLoadedCollabMarkdownStable(slug, targetMarkdown, options.stabilityMs as number);
              if (!stable) {
                confirmed = false;
                reason = 'stability_regressed';
                markdownConfirmed = false;
              }
            }
            if (confirmed && expectedFragmentTextHash && (options.stabilityMs ?? 0) > 0) {
              const stableFragment = await verifyLoadedCollabFragmentStable(
                slug,
                expectedFragmentTextHash,
                options.stabilityMs as number,
              );
              if (!stableFragment) {
                confirmed = false;
                reason = 'fragment_stability_regressed';
                fragmentConfirmed = false;
                liveFragmentTextHash = await getLoadedCollabFragmentTextHash(slug);
              }
            }
            if (confirmed && (options.stabilityMs ?? 0) > 0) {
              const canonical = await verifyCanonicalDocumentStable(
                slug,
                targetMarkdown,
                targetMarks,
                options.stabilityMs as number,
              );
              canonicalConfirmed = canonical.stable;
              canonicalExpectedHash = canonical.expectedHash;
              canonicalObservedHash = canonical.observedHash;
              if (!canonical.stable) {
                confirmed = false;
                reason = canonical.reason ?? 'canonical_stability_regressed';
              }
            }
          } finally {
            if (barrierLocked) releaseRewriteLock(slug);
          }
        }

        if (!confirmed && !reason) {
          reason = 'sync_timeout';
        }

        if (!confirmed) {
          console.warn('[agent-routes] rewrite collab verification pending', {
            slug,
            reason,
            yStateVersion: verification.yStateVersion,
            markdownConfirmed,
            fragmentConfirmed,
            markdownSource: verification.markdownSource,
            canonicalConfirmed,
            canonicalExpectedHash,
            canonicalObservedHash,
          });
          invalidateLoadedCollabDocument(slug);
          return {
            confirmed: false,
            reason,
            markdownConfirmed,
            fragmentConfirmed,
            canonicalConfirmed,
            canonicalExpectedHash,
            canonicalObservedHash,
            expectedFragmentTextHash,
            liveFragmentTextHash,
            presenceApplied: false,
            cursorApplied: false,
          };
        }
        verifiedStatus = {
          confirmed: true,
          ...(reason ? { reason } : {}),
          markdownConfirmed,
          fragmentConfirmed,
          canonicalConfirmed,
          canonicalExpectedHash,
          canonicalObservedHash,
          expectedFragmentTextHash,
          liveFragmentTextHash,
          presenceApplied: false,
          cursorApplied: false,
        };
      } else {
        await applyCanonicalDocumentToCollab(slug, {
          markdown: targetMarkdown,
          marks: targetMarks,
          source: options?.source ?? 'agent',
        });
      }

      let presenceApplied = false;
      if (participation?.presenceEntry) {
        try {
          presenceApplied = applyAgentPresenceToLoadedCollab(slug, participation.presenceEntry, {
            type: 'agent.presence',
            ...participation.presenceEntry,
          });
        } catch {
          // ignore
        }
      }
      let cursorApplied = false;
      if (participation?.cursorHint?.quote) {
        try {
          cursorApplied = applyAgentCursorHintToLoadedCollab(slug, {
            id: String(participation.presenceEntry.id),
            quote: participation.cursorHint.quote,
            ttlMs: participation.cursorHint.ttlMs,
            name: typeof participation.presenceEntry.name === 'string' ? participation.presenceEntry.name : undefined,
            color: typeof participation.presenceEntry.color === 'string' ? participation.presenceEntry.color : undefined,
            avatar: typeof participation.presenceEntry.avatar === 'string' ? participation.presenceEntry.avatar : undefined,
          });
        } catch {
          // ignore
        }
      }
      return {
        ...verifiedStatus,
        presenceApplied,
        cursorApplied,
      };
    } catch (error) {
      console.error('[agent-routes] Failed to apply agent mutation into collab runtime:', { slug, error });
      invalidateLoadedCollabDocument(slug);
      return {
        confirmed: false,
        reason: 'apply_failed',
        presenceApplied: false,
        cursorApplied: false,
      };
    } finally {
      broadcastToRoom(slug, {
        type: 'document.updated',
        source: 'agent',
        timestamp: now,
      });
    }
  })();
}

agentRoutes.use((req: Request, res: Response, next) => {
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  if (!routeRequiresMutation(method, path)) {
    next();
    return;
  }
  const stage = getMutationContractStage();
  if (!isIdempotencyRequired(stage)) {
    next();
    return;
  }
  const idempotencyKey = getIdempotencyKey(req);
  if (idempotencyKey) {
    next();
    return;
  }
  const slug = getSlug(req) ?? undefined;
  sendMutationResponse(
    res,
    409,
    {
      success: false,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      error: 'Idempotency-Key header is required for mutation requests in this stage',
    },
    { route: `${method} ${path}`, slug },
  );
});

agentRoutes.use((req: Request, res: Response, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (!routeRequiresMutation(req.method.toUpperCase(), req.path || '/')) return;
    recordAgentMutation(
      getMutationRouteLabel(req),
      res.statusCode >= 200 && res.statusCode < 300,
      Date.now() - startedAt,
    );
  });
  next();
});

agentRoutes.get('/:slug/state', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  ensureAgentPresenceForAuthenticatedCall(req, slug, {}, 'state.read');
  const result = executeDocumentOperation(slug, 'GET', '/state');
  const body = asPayload(result.body);
  const doc = getDocumentBySlug(slug);
  const mutationStage = getMutationContractStage();
  const mutationReady = body.mutationReady !== false;
  const revision = mutationReady
    ? (typeof body.revision === 'number' ? body.revision : doc?.revision)
    : null;
  const editV2Enabled = isFeatureEnabled(process.env.AGENT_EDIT_V2_ENABLED);
  if (typeof revision === 'number') {
    body.revision = revision;
  } else if (!mutationReady) {
    body.revision = null;
  }
  if (!mutationReady && body.updatedAt === undefined) {
    body.updatedAt = null;
  }
  body.contract = {
    ...(isRecord(body.contract) ? body.contract : {}),
    mutationStage,
    idempotencyRequired: isIdempotencyRequired(mutationStage),
    preconditionMode: mutationStage === 'A'
      ? 'optional'
      : (mutationStage === 'C' ? 'revision-only' : 'revision-or-updatedAt'),
  };
  body.capabilities = {
    ...(isRecord(body.capabilities) ? body.capabilities : {}),
    snapshotV2: editV2Enabled,
    editV2: editV2Enabled && mutationReady,
    topLevelOnly: editV2Enabled && mutationReady,
    mutationReady,
  };
  const proofSdkPaths = buildProofSdkDocumentPaths(slug);
  const legacyTitlePath = `/api/documents/${encodeURIComponent(slug)}/title`;
  const links = {
    ...(isRecord(body._links) ? body._links : {}),
    ...buildProofSdkLinks(slug),
  };
  if (mutationReady) {
    links.ops = { method: 'POST', href: proofSdkPaths.ops };
    links.edit = { method: 'POST', href: proofSdkPaths.edit };
    links.title = { method: 'PUT', href: legacyTitlePath };
  }
  if (editV2Enabled) {
    links.snapshot = proofSdkPaths.snapshot;
    if (mutationReady) {
      links.editV2 = { method: 'POST', href: proofSdkPaths.editV2 };
    } else {
      delete links.editV2;
    }
  }
  body._links = links;
  const agent: Record<string, unknown> = {
    ...buildProofSdkAgentDescriptor(slug),
    ...(isRecord(body.agent) ? body.agent : {}),
    mutationReady,
    auth: {
      tokenSource: typeof req.query.token === 'string' && req.query.token.trim()
        ? 'query:token'
        : (typeof req.header('authorization') === 'string'
          ? 'header:authorization'
          : (typeof req.header('x-share-token') === 'string'
            ? 'header:x-share-token'
            : (typeof req.header('x-bridge-token') === 'string' ? 'header:x-bridge-token' : 'cookie-or-none'))),
      headerFormat: AUTH_HEADER_FORMAT,
      altHeader: ALT_SHARE_TOKEN_HEADER_FORMAT,
    },
    mutationContract: body.contract,
  };
  if (mutationReady) {
    agent.opsApi = proofSdkPaths.ops;
    agent.editApi = proofSdkPaths.edit;
    agent.titleApi = legacyTitlePath;
  }
  if (editV2Enabled) {
    agent.snapshotApi = proofSdkPaths.snapshot;
    if (mutationReady) {
      agent.editV2Api = proofSdkPaths.editV2;
    }
  }
  body.agent = agent;

  // Strip Proof-authored span tags from agent-facing markdown so agents see clean text.
  if (typeof body.markdown === 'string') {
    body.markdown = stripProofSpanTags(body.markdown);
  }
  if (typeof body.content === 'string') {
    body.content = stripProofSpanTags(body.content);
  }

  res.status(result.status).json(body);
});

agentRoutes.get('/:slug/snapshot', async (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!isFeatureEnabled(process.env.AGENT_EDIT_V2_ENABLED)) {
    res.status(404).json({ success: false, error: 'Edit v2 is disabled', code: 'EDIT_V2_DISABLED' });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;

  const revisionRaw = req.query.revision;
  const includeTextPreviewRaw = req.query.includeTextPreview;

  let revision: number | null = null;
  if (typeof revisionRaw === 'string' && revisionRaw.trim()) {
    const parsed = Number(revisionRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ success: false, error: 'Invalid revision', code: 'INVALID_REQUEST' });
      return;
    }
    revision = parsed;
  }

  let includeTextPreview: boolean | undefined;
  if (typeof includeTextPreviewRaw === 'string' && includeTextPreviewRaw.trim()) {
    const normalized = includeTextPreviewRaw.trim().toLowerCase();
    includeTextPreview = !(normalized === 'false' || normalized === '0' || normalized === 'no');
  }

  try {
    const result = await buildAgentSnapshot(slug, { revision, includeTextPreview });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[agent-routes] Failed to build agent snapshot:', { slug, error });
    res.status(500).json({ success: false, error: 'Failed to build snapshot', code: 'INTERNAL_ERROR' });
  }
});

agentRoutes.post('/:slug/edit/v2', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /edit/v2';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!isFeatureEnabled(process.env.AGENT_EDIT_V2_ENABLED)) {
    sendMutationResponse(
      res,
      404,
      { success: false, error: 'Edit v2 is disabled', code: 'EDIT_V2_DISABLED' },
      { route: mutationRoute, slug },
    );
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const editV2Body = isRecord(req.body) ? req.body : {};
  ensureAgentPresenceForAuthenticatedCall(req, slug, editV2Body, 'edit.v2');

  const routeKey = 'POST /edit/v2';
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;

  const result = await applyAgentEditV2(slug, req.body);
  if (result.status >= 200 && result.status < 300 && isRecord(result.body)) {
    const collabStatus = await notifyCollabMutation(
      slug,
      buildParticipationFromMutation(req, slug, editV2Body, { details: 'edit.v2' }),
      {
        verify: true,
        source: 'edit.v2',
        stabilityMs: EDIT_COLLAB_STABILITY_MS,
        fallbackBarrier: true,
        strictLiveDoc: true,
        apply: false,
      },
    );
    const priorCollab = isRecord(result.body.collab) ? result.body.collab : {};
    const {
      reason: _priorReason,
      status: _priorStatus,
      markdownStatus: _priorMarkdownStatus,
      fragmentStatus: _priorFragmentStatus,
      canonicalStatus: _priorCanonicalStatus,
      canonicalExpectedHash: _priorCanonicalExpectedHash,
      canonicalObservedHash: _priorCanonicalObservedHash,
      ...priorCollabRest
    } = priorCollab;
    const includeCanonicalDiagnostics = shouldIncludeCanonicalDiagnostics();
    result.body = {
      ...result.body,
      collab: {
        ...priorCollabRest,
        status: collabStatus.confirmed ? 'confirmed' : 'pending',
        markdownStatus: collabStatus.markdownConfirmed ? 'confirmed' : 'pending',
        fragmentStatus: collabStatus.fragmentConfirmed ? 'confirmed' : 'pending',
        canonicalStatus: collabStatus.canonicalConfirmed ? 'confirmed' : 'pending',
        ...(includeCanonicalDiagnostics
          ? {
              canonicalExpectedHash: collabStatus.canonicalExpectedHash ?? null,
              canonicalObservedHash: collabStatus.canonicalObservedHash ?? null,
            }
          : {}),
        ...(collabStatus.confirmed ? {} : { reason: collabStatus.reason ?? 'sync_timeout' }),
      },
    };

    if (collabStatus.confirmed) {
      // Only broadcast document.updated after collab confirmation attempt is complete.
      broadcastToRoom(slug, { type: 'document.updated', source: 'agent-edit-v2', timestamp: new Date().toISOString() });
    }
  }

  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// Apply targeted edit operations (agent-friendly; no compatibility headers).
agentRoutes.post('/:slug/edit', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /edit';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const body = isRecord(req.body) ? req.body : {};
  ensureAgentPresenceForAuthenticatedCall(req, slug, body, 'edit.request');
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const operationsRaw = body.operations;
  const operations = Array.isArray(operationsRaw) ? operationsRaw as unknown[] : [];
  if (operations.length === 0) {
    sendMutationResponse(
      res,
      400,
      { success: false, error: 'operations must be a non-empty array', code: 'INVALID_OPERATIONS' },
      { route: mutationRoute, slug },
    );
    return;
  }
  if (operations.length > 50) {
    sendMutationResponse(
      res,
      400,
      { success: false, error: 'Too many operations (max 50)', code: 'INVALID_OPERATIONS' },
      { route: mutationRoute, slug },
    );
    return;
  }

  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { success: false, error: 'Document not found' }, { route: mutationRoute, slug });
    return;
  }
  const stage = getMutationContractStage();
  const precondition = validateEditPrecondition(stage, doc, body);
  if (!precondition.ok) {
    sendMutationResponse(res, 409, {
      success: false,
      code: precondition.code,
      error: precondition.error,
      latestUpdatedAt: doc.updated_at,
      latestRevision: doc.revision,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }

  const collabRuntime = getCollabRuntime();
  const collabClientBreakdown = collabRuntime.enabled
    ? getActiveCollabClientBreakdown(slug)
    : null;
  const activeCollabClients = collabClientBreakdown?.total ?? 0;
  const hostedRuntime = isHostedRewriteEnvironment();
  res.setHeader('X-Proof-Agent-Routes', '1');
  res.setHeader('X-Proof-Legacy-Edit-Hosted', hostedRuntime ? '1' : '0');
  res.setHeader('X-Proof-Legacy-Edit-Collab', collabRuntime.enabled ? '1' : '0');
  res.setHeader('X-Proof-Legacy-Edit-Clients', String(activeCollabClients));
  if (collabRuntime.enabled && (hostedRuntime || activeCollabClients > 0 || hasUnsafeLegacyEditMarks(doc.marks))) {
    sendMutationResponse(res, 409, {
      success: false,
      code: 'LEGACY_EDIT_UNSAFE',
      error: hostedRuntime
        ? 'Legacy /edit is disabled on hosted runtimes; retry with /edit/v2'
        : 'Legacy /edit is unsafe for live or marked documents; retry with /edit/v2',
      retryWithState: `/api/agent/${slug}/state`,
      recommendedEndpoint: `/api/agent/${slug}/edit/v2`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }
  if (collabRuntime.enabled) {
    console.warn('[agent-routes] legacy /edit allowed in hosted runtime', {
      slug,
      route: mutationRoute,
      accessEpoch: collabClientBreakdown?.accessEpoch ?? null,
      activeCollabClients,
      exactEpochCount: collabClientBreakdown?.exactEpochCount ?? 0,
      anyEpochCount: collabClientBreakdown?.anyEpochCount ?? 0,
      documentLeaseExactCount: collabClientBreakdown?.documentLeaseExactCount ?? 0,
      documentLeaseAnyEpochCount: collabClientBreakdown?.documentLeaseAnyEpochCount ?? 0,
      recentLeaseCount: collabClientBreakdown?.recentLeaseCount ?? 0,
    });
  }

  const baseMarkdown = doc.markdown ?? '';
  const operationBase = await resolveEditOperationBaseMarkdown(slug, mutationRoute, baseMarkdown, collabRuntime.enabled);
  const operationBaseMarkdown = operationBase.markdown;
  const collabBase = collabRuntime.enabled ? getLoadedCollabMarkdown(slug) : null;
  if (operationBase.source === 'db' && collabBase !== null && collabBase !== baseMarkdown) {
    console.warn('[agent-routes] /edit detected collab/base drift without active clients; using canonical DB markdown for op application', {
      slug,
      route: mutationRoute,
      collabLength: collabBase.length,
      canonicalLength: baseMarkdown.length,
    });
  }

  const parsedOps: AgentEditOperation[] = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!isRecord(op) || typeof op.op !== 'string') {
      sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `Invalid operation at index ${i}` }, { route: mutationRoute, slug });
      return;
    }
    const kind = op.op;
    if (kind === 'append') {
      if (typeof op.section !== 'string' || typeof op.content !== 'string') {
        sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `append requires section + content (index ${i})` }, { route: mutationRoute, slug });
        return;
      }
      if (op.content.length > 200_000) {
        sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `content too large (index ${i})` }, { route: mutationRoute, slug });
        return;
      }
      parsedOps.push({ op: 'append', section: op.section, content: op.content });
      continue;
    }
    if (kind === 'replace') {
      if (typeof op.search !== 'string' || typeof op.content !== 'string') {
        sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `replace requires search + content (index ${i})` }, { route: mutationRoute, slug });
        return;
      }
      if (op.content.length > 200_000) {
        sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `content too large (index ${i})` }, { route: mutationRoute, slug });
        return;
      }
      parsedOps.push({ op: 'replace', search: op.search, content: op.content });
      continue;
    }
    if (kind === 'insert') {
      if (Object.prototype.hasOwnProperty.call(op, 'before')) {
        sendMutationResponse(res, 400, {
          success: false,
          code: 'INVALID_OPERATIONS',
          error: `insert.before is not supported; use insert.after (index ${i})`,
        }, { route: mutationRoute, slug });
        return;
      }
      if (typeof op.after !== 'string' || typeof op.content !== 'string') {
        sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `insert requires after + content (index ${i})` }, { route: mutationRoute, slug });
        return;
      }
      if (op.content.length > 200_000) {
        sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `content too large (index ${i})` }, { route: mutationRoute, slug });
        return;
      }
      parsedOps.push({ op: 'insert', after: op.after, content: op.content });
      continue;
    }
    sendMutationResponse(res, 400, { success: false, code: 'INVALID_OPERATIONS', error: `Unknown op: ${JSON.stringify(kind)} (index ${i})` }, { route: mutationRoute, slug });
    return;
  }
  const applied = applyAgentEditOperations(operationBaseMarkdown, parsedOps, { by });
  if (!applied.ok) {
    // Do NOT reconcile collab state on edit failure — the in-memory collab doc may have
    // newer unsaved changes from connected clients. Forcing DB state into collab here
    // would overwrite those changes and risk data loss.
    sendMutationResponse(res, 409, {
      success: false,
      code: applied.code,
      error: applied.message,
      opIndex: applied.opIndex,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }

  const nextMarkdown = applied.markdown;
  const ok = precondition.mode === 'revision'
    ? updateDocumentAtomicByRevision(slug, precondition.baseRevision as number, nextMarkdown)
    : updateDocumentAtomic(slug, precondition.baseUpdatedAt as string, nextMarkdown);
  if (!ok) {
    const latest = getDocumentBySlug(slug);
    sendMutationResponse(res, 409, {
      success: false,
      code: 'STALE_BASE',
      error: 'Document has changed; retry with latest state',
      latestUpdatedAt: latest?.updated_at ?? null,
      latestRevision: latest?.revision ?? null,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }

  const updated = getDocumentBySlug(slug);
  if (!updated) {
    sendMutationResponse(
      res,
      500,
      { success: false, error: 'Document update persisted but could not be reloaded' },
      { route: mutationRoute, slug },
    );
    return;
  }
  try {
    await rebuildDocumentBlocks(updated, updated.markdown, updated.revision);
  } catch (error) {
    console.error('[agent-routes] Failed to rebuild block index after v1 edit:', { slug, error });
  }

  addDocumentEvent(slug, 'agent.edit', { by, operations: parsedOps }, by);

  // Presence and cursor are a byproduct of mutations: every successful edit implies
  // the agent has "joined" the doc for a short TTL.
  const details = typeof body.details === 'string'
    ? body.details
    : typeof body.summary === 'string'
      ? body.summary
      : null;
  const quoteFromOps = (() => {
    const last = parsedOps[parsedOps.length - 1] as AgentEditOperation | undefined;
    if (!last) return null;
    if (last.op === 'append' || last.op === 'insert' || last.op === 'replace') {
      const content = (last as any).content;
      if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 600);
    }
    return null;
  })();

  const participation = buildParticipationFromMutation(req, slug, body, { quote: quoteFromOps, details });
  const collabSampleStartedAt = Date.now();
  const collabStatus = await notifyCollabMutation(
    slug,
    participation,
    { verify: true, source: by, stabilityMs: EDIT_COLLAB_STABILITY_MS, fallbackBarrier: true, strictLiveDoc: true },
  );
  const convergenceSampleMs = Date.now() - collabSampleStartedAt;
  const collabApplied = deriveCollabApplied(collabStatus);
  const presenceApplied = derivePresenceApplied(collabStatus);
  const cursorApplied = deriveCursorApplied(collabStatus);
  const expectedMarkdownHash = hashMarkdown(updated.markdown ?? '');
  const liveMarkdown = getLoadedCollabMarkdown(slug);
  const liveMarkdownHash = typeof liveMarkdown === 'string' ? hashMarkdown(liveMarkdown) : null;
  const markdownStatus = collabStatus.markdownConfirmed ? 'confirmed' : 'pending';
  const fragmentStatus = collabStatus.fragmentConfirmed ? 'confirmed' : 'pending';
  const canonicalStatus = collabStatus.canonicalConfirmed ? 'confirmed' : 'pending';
  const includeCanonicalDiagnostics = shouldIncludeCanonicalDiagnostics();

  const responseBody = {
    success: true,
    slug,
    updatedAt: updated.updated_at,
    collabApplied,
    collab: {
      status: collabApplied ? 'confirmed' : 'pending',
      markdownStatus,
      fragmentStatus,
      canonicalStatus,
      ...(includeCanonicalDiagnostics
        ? {
            canonicalExpectedHash: collabStatus.canonicalExpectedHash ?? null,
            canonicalObservedHash: collabStatus.canonicalObservedHash ?? null,
          }
        : {}),
      ...(collabApplied ? {} : { reason: collabStatus.reason ?? 'sync_timeout' }),
    },
    presenceApplied,
    cursorApplied,
    expectedMarkdownHash,
    liveMarkdownHash,
    expectedFragmentTextHash: collabStatus.expectedFragmentTextHash ?? null,
    liveFragmentTextHash: collabStatus.liveFragmentTextHash ?? null,
    convergenceSampleMs,
    _links: {
      view: `/d/${encodeURIComponent(slug)}`,
      ...buildProofSdkLinks(slug, {
        includeMutationRoutes: true,
      }),
    },
    agent: buildProofSdkAgentDescriptor(slug, {
      includeMutationRoutes: true,
    }),
  } satisfies Record<string, unknown>;

  storeIdempotentMutationResult(slug, routeKey, replay, 200, responseBody);
  sendMutationResponse(res, 200, responseBody, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/presence', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;

  const body = isRecord(req.body) ? req.body : {};
  const now = new Date().toISOString();

  const identity = resolveExplicitAgentIdentity(body, req.header('x-agent-id'));
  if (identity.kind !== 'ok') {
    res.status(400).json({
      success: false,
      code: 'INVALID_AGENT_IDENTITY',
      error: 'Explicit agent identity is required. Supply X-Agent-Id, agentId, or agent.id.',
    });
    return;
  }

  const { id: agentId, name, color, avatar } = identity;

  const entry = {
    id: agentId,
    name,
    color,
    avatar,
    status: typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'idle',
    details: typeof body.details === 'string'
      ? body.details
      : typeof body.summary === 'string'
        ? body.summary
        : '',
    at: now,
  };

  const activity = {
    type: 'agent.presence',
    ...entry,
  };

  addDocumentEvent(slug, 'agent.presence', entry, agentId);

  const collabApplied = applyAgentPresenceToLoadedCollab(slug, entry, activity);

  broadcastToRoom(slug, { type: 'agent.presence', source: 'agent', timestamp: now, ...entry });

  res.json({
    success: true,
    slug,
    collabApplied,
    _links: buildProofSdkLinks(slug, {
      includeMutationRoutes: true,
    }),
    agent: buildProofSdkAgentDescriptor(slug, {
      includeMutationRoutes: true,
    }),
  });
});

agentRoutes.post('/:slug/presence/disconnect', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  const role = checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot']);
  if (!role) return;
  if (role !== 'editor' && role !== 'owner_bot') {
    res.status(403).json({ success: false, error: 'Insufficient role for presence disconnect' });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const rawAgentId = typeof body.agentId === 'string' && body.agentId.trim()
    ? body.agentId.trim()
    : typeof body.id === 'string' && body.id.trim()
      ? body.id.trim()
      : '';
  if (!rawAgentId) {
    res.status(400).json({ success: false, error: 'agentId is required' });
    return;
  }
  const agentId = normalizeAgentScopedId(rawAgentId);
  if (!agentId) {
    res.status(400).json({ success: false, code: 'INVALID_AGENT_IDENTITY', error: 'agentId must be agent-scoped' });
    return;
  }

  const now = new Date().toISOString();
  const actor = typeof body.by === 'string' && body.by.trim()
    ? body.by.trim()
    : 'human:collaborator';
  const details = typeof body.details === 'string' ? body.details : 'Disconnected by collaborator';
  const activity = {
    type: 'agent.disconnected',
    id: agentId,
    status: 'disconnected',
    details,
    at: now,
  };

  const collabApplied = removeAgentPresenceFromLoadedCollab(slug, agentId, activity);
  const disconnected = true;
  addDocumentEvent(slug, 'agent.disconnected', activity, actor);
  broadcastToRoom(slug, {
    type: 'agent.presence',
    source: 'agent',
    timestamp: now,
    id: agentId,
    status: 'disconnected',
    disconnected: true,
    collabApplied,
  });

  res.json({
    success: true,
    slug,
    agentId,
    collabApplied,
    disconnected,
  });
});

// Canonical operations endpoint for comments/suggestions/rewrite (agent-friendly; no compatibility headers).
agentRoutes.post('/:slug/ops', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /ops';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }

  const parsed = parseDocumentOpRequest(req.body);
  if ('error' in parsed) {
    sendMutationResponse(res, 400, { success: false, error: parsed.error }, { route: mutationRoute, slug });
    return;
  }
  const { op, payload } = parsed;
  const routeKey = `${mutationRoute}:${op}`;

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { success: false, error: 'Document not found' }, { route: mutationRoute, slug });
    return;
  }

  const secret = getPresentedSecret(req, slug);
  const role = secret ? resolveDocumentAccessRole(slug, secret) : null;
  const denied = authorizeDocumentOp(op, role, role === 'owner_bot', doc.share_state);
  if (denied) {
    const status = denied.includes('revoked') ? 403 : denied.includes('deleted') ? 410 : 403;
    sendMutationResponse(res, status, { success: false, error: denied }, { route: mutationRoute, slug });
    return;
  }

  const participationBody = { ...asPayload(req.body), ...payload };
  ensureAgentPresenceForAuthenticatedCall(req, slug, participationBody, 'ops.request');

  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;

  const stage = getMutationContractStage();
  const opPrecondition = validateOpPrecondition(stage, op, doc, payload);
  if (!opPrecondition.ok) {
    sendMutationResponse(res, 409, {
      success: false,
      code: opPrecondition.code,
      error: opPrecondition.error,
      latestUpdatedAt: doc.updated_at,
      latestRevision: doc.revision,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }

  const opRoute = resolveDocumentOpRoute(op, payload);
  if (!opRoute) {
    sendMutationResponse(res, 400, { success: false, error: 'Unsupported operation payload' }, { route: mutationRoute, slug });
    return;
  }

  let rewriteGate: ReturnType<typeof evaluateRewriteLiveClientGate> | null = null;
  if (op === 'rewrite.apply') {
    const rewriteValidationError = validateRewriteApplyPayload(payload);
    if (rewriteValidationError) {
      sendMutationResponse(res, 400, { success: false, error: rewriteValidationError }, { route: mutationRoute, slug });
      return;
    }
    rewriteGate = evaluateRewriteLiveClientGate(slug, payload);
    if (rewriteGate.blocked) {
      recordRewriteLiveClientBlock(
        mutationRoute,
        rewriteGate.runtimeEnvironment,
        rewriteGate.forceRequested,
        rewriteGate.forceIgnored,
      );
      if (rewriteGate.forceIgnored) {
        recordRewriteForceIgnored(mutationRoute, rewriteGate.runtimeEnvironment);
      }
      console.warn('[agent-routes] rewrite blocked by live clients', {
        slug,
        route: mutationRoute,
        connectedClients: rewriteGate.connectedClients,
        forceRequested: rewriteGate.forceRequested,
        forceHonored: rewriteGate.forceHonored,
        forceIgnored: rewriteGate.forceIgnored,
        runtimeEnvironment: rewriteGate.runtimeEnvironment,
      });
      sendMutationResponse(
        res,
        409,
        rewriteBlockedResponseBody(rewriteGate, slug),
        { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
      );
      return;
    }
    console.warn('[agent-routes] rewrite allowed in hosted runtime', {
      slug,
      route: mutationRoute,
      connectedClients: rewriteGate.connectedClients,
      accessEpoch: rewriteGate.accessEpoch,
      exactEpochCount: rewriteGate.exactEpochCount,
      anyEpochCount: rewriteGate.anyEpochCount,
      documentLeaseExactCount: rewriteGate.documentLeaseExactCount,
      documentLeaseAnyEpochCount: rewriteGate.documentLeaseAnyEpochCount,
      recentLeaseCount: rewriteGate.recentLeaseCount,
      forceRequested: rewriteGate.forceRequested,
      runtimeEnvironment: rewriteGate.runtimeEnvironment,
    });
    const barrierStartedAt = Date.now();
    try {
      await prepareRewriteCollabBarrier(slug);
      recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
    } catch (error) {
      const reason = classifyRewriteBarrierFailureReason(error);
      recordRewriteBarrierFailure(mutationRoute, reason);
      recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
      sendMutationResponse(
        res,
        503,
        rewriteBarrierFailedResponseBody(slug, reason),
        { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
      );
      return;
    }
  }

  const result = op === 'rewrite.apply'
    ? await executeCanonicalRewrite(slug, opRoute.body)
    : await executeDocumentOperationAsync(slug, opRoute.method, opRoute.path, opRoute.body);
  if (op === 'rewrite.apply' && result.status >= 200 && result.status < 300 && rewriteGate) {
    result.body = annotateRewriteDisruptionMetadata(result.body, rewriteGate);
  }
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300 && op !== 'rewrite.apply') {
    await notifyCollabMutation(
      slug,
      buildParticipationFromMutation(req, slug, participationBody, {
        quote: typeof payload.quote === 'string' ? payload.quote : null,
        details: op,
      }),
      { verify: false },
    );
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/comment', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/comment';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'comment.add', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/comment', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.add' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/suggest-replace', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/suggest-replace';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.add', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/suggest-replace', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.add.replace' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/suggest-insert', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/suggest-insert';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.add', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/suggest-insert', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.add.insert' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/suggest-delete', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/suggest-delete';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.add', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/suggest-delete', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.add.delete' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/accept', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/accept';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.accept', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/accept', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    const collabStatus = await notifyCollabMutation(
      slug,
      buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.accept' }),
      {
        verify: true,
        source: 'marks.accept',
        stabilityMs: EDIT_COLLAB_STABILITY_MS,
        strictLiveDoc: true,
      },
    );
    if (isRecord(result.body)) {
      result.body = {
        ...result.body,
        collab: {
          status: collabStatus.confirmed ? 'confirmed' : 'pending',
          reason: collabStatus.reason ?? (collabStatus.confirmed ? 'confirmed' : 'sync_timeout'),
          markdownConfirmed: collabStatus.markdownConfirmed ?? null,
          fragmentConfirmed: collabStatus.fragmentConfirmed ?? null,
          canonicalConfirmed: collabStatus.canonicalConfirmed ?? null,
        },
      };
    }
    if (!collabStatus.confirmed) {
      sendMutationResponse(
        res,
        409,
        {
          success: false,
          code: 'COLLAB_SYNC_FAILED',
          error: 'Suggestion acceptance did not converge to live collaboration state',
          reason: collabStatus.reason ?? 'sync_timeout',
          retryWithState: `/api/agent/${slug}/state`,
          collab: {
            status: 'pending',
            reason: collabStatus.reason ?? 'sync_timeout',
            markdownConfirmed: collabStatus.markdownConfirmed ?? null,
            fragmentConfirmed: collabStatus.fragmentConfirmed ?? null,
            canonicalConfirmed: collabStatus.canonicalConfirmed ?? null,
          },
        },
        { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
      );
      return;
    }
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/reject', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/reject';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'suggestion.reject', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/reject', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'suggestion.reject' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/reply', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/reply';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'comment.reply', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/reply', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.reply' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/resolve', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/resolve';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'comment.resolve', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/resolve', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.resolve' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/marks/unresolve', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /marks/unresolve';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['commenter', 'editor', 'owner_bot'])) return;
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const payload = asPayload(req.body);
  if (!enforceMutationPrecondition(res, slug, mutationRoute, 'comment.unresolve', payload)) return;
  const result = await executeDocumentOperationAsync(slug, 'POST', '/marks/unresolve', payload);
  storeIdempotentMutationResult(slug, routeKey, replay, result.status, result.body);
  if (result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, payload, { details: 'comment.unresolve' }));
  }
  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/rewrite', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /rewrite';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { success: false, error: 'Document not found' }, { route: mutationRoute, slug });
    return;
  }
  const stage = getMutationContractStage();
  const opPrecondition = validateOpPrecondition(stage, 'rewrite.apply', doc, asPayload(req.body));
  if (!opPrecondition.ok) {
    sendMutationResponse(res, 409, {
      success: false,
      code: opPrecondition.code,
      error: opPrecondition.error,
      latestUpdatedAt: doc.updated_at,
      latestRevision: doc.revision,
      retryWithState: `/api/agent/${slug}/state`,
    }, { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` });
    return;
  }
  const routeKey = mutationRoute;
  const replay = maybeReplayIdempotentMutation(req, res, slug, mutationRoute, routeKey);
  if (replay.handled) return;
  const rewriteValidationError = validateRewriteApplyPayload(asPayload(req.body));
  if (rewriteValidationError) {
    sendMutationResponse(res, 400, { success: false, error: rewriteValidationError }, { route: mutationRoute, slug });
    return;
  }
  const rewriteGate = evaluateRewriteLiveClientGate(slug, asPayload(req.body));
  res.setHeader('X-Proof-Agent-Routes', '1');
  res.setHeader('X-Proof-Rewrite-Hosted', rewriteGate.hostedRuntime ? '1' : '0');
  res.setHeader('X-Proof-Rewrite-Blocked', rewriteGate.blocked ? '1' : '0');
  res.setHeader('X-Proof-Rewrite-Clients', String(rewriteGate.connectedClients));
  if (rewriteGate.blocked) {
    recordRewriteLiveClientBlock(
      mutationRoute,
      rewriteGate.runtimeEnvironment,
      rewriteGate.forceRequested,
      rewriteGate.forceIgnored,
    );
    if (rewriteGate.forceIgnored) {
      recordRewriteForceIgnored(mutationRoute, rewriteGate.runtimeEnvironment);
    }
    console.warn('[agent-routes] rewrite blocked by live clients', {
      slug,
      route: mutationRoute,
      connectedClients: rewriteGate.connectedClients,
      forceRequested: rewriteGate.forceRequested,
      forceHonored: rewriteGate.forceHonored,
      forceIgnored: rewriteGate.forceIgnored,
      runtimeEnvironment: rewriteGate.runtimeEnvironment,
    });
    sendMutationResponse(
      res,
      409,
      rewriteBlockedResponseBody(rewriteGate, slug),
      { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
    );
    return;
  }
  console.warn('[agent-routes] rewrite allowed in hosted runtime', {
    slug,
    route: mutationRoute,
    connectedClients: rewriteGate.connectedClients,
    accessEpoch: rewriteGate.accessEpoch,
    exactEpochCount: rewriteGate.exactEpochCount,
    anyEpochCount: rewriteGate.anyEpochCount,
    documentLeaseExactCount: rewriteGate.documentLeaseExactCount,
    documentLeaseAnyEpochCount: rewriteGate.documentLeaseAnyEpochCount,
    recentLeaseCount: rewriteGate.recentLeaseCount,
    forceRequested: rewriteGate.forceRequested,
    runtimeEnvironment: rewriteGate.runtimeEnvironment,
  });
  const barrierStartedAt = Date.now();
  try {
    await prepareRewriteCollabBarrier(slug);
    recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
  } catch (error) {
    const reason = classifyRewriteBarrierFailureReason(error);
    recordRewriteBarrierFailure(mutationRoute, reason);
    recordRewriteBarrierLatency(mutationRoute, Date.now() - barrierStartedAt);
    sendMutationResponse(
      res,
      503,
      rewriteBarrierFailedResponseBody(slug, reason),
      { route: mutationRoute, slug, retryWithState: `/api/agent/${slug}/state` },
    );
    return;
  }
  const result = await executeCanonicalRewrite(slug, asPayload(req.body));
  let responseStatus = result.status;
  let responseBody: Record<string, unknown> = result.body;
  if (result.status >= 200 && result.status < 300) {
    responseBody = annotateRewriteDisruptionMetadata(responseBody, rewriteGate);
  }
  storeIdempotentMutationResult(slug, routeKey, replay, responseStatus, responseBody);
  sendMutationResponse(res, responseStatus, responseBody, { route: mutationRoute, slug });
});

agentRoutes.post('/:slug/repair', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /repair';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['owner_bot'])) return;

  const result = await repairCanonicalProjection(slug);
  sendMutationResponse(
    res,
    result.ok ? 200 : result.status,
    result.ok
      ? {
        success: true,
        slug,
        revision: result.document.revision,
        yStateVersion: result.yStateVersion,
        health: 'healthy',
      }
      : {
        success: false,
        code: result.code,
        error: result.error,
      },
    { route: mutationRoute, slug },
  );
});

agentRoutes.post('/:slug/clone-from-canonical', async (req: Request, res: Response) => {
  const mutationRoute = 'POST /clone-from-canonical';
  const slug = getSlug(req);
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['owner_bot'])) return;

  const result = await cloneFromCanonical(slug, typeof req.body?.by === 'string' ? req.body.by : 'owner');
  sendMutationResponse(
    res,
    result.ok ? 200 : result.status,
    result.ok
      ? {
        success: true,
        sourceSlug: slug,
        cloneSlug: result.cloneSlug ?? result.document.slug,
        revision: result.document.revision,
        ...(result.ownerSecret ? { ownerSecret: result.ownerSecret } : {}),
      }
      : {
        success: false,
        code: result.code,
        error: result.error,
      },
    { route: mutationRoute, slug },
  );
});

agentRoutes.get('/:slug/events/pending', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  const after = Number.parseInt(String(req.query.after ?? '0'), 10);
  const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
  const events = listDocumentEvents(slug, Number.isFinite(after) ? Math.max(0, after) : 0, Number.isFinite(limit) ? limit : 100);
  res.json({
    success: true,
    events: events.map((event) => ({
      id: event.id,
      type: event.event_type,
      data: (() => {
        try {
          return JSON.parse(event.event_data);
        } catch {
          return {};
        }
      })(),
      actor: event.actor,
      createdAt: event.created_at,
      ackedAt: event.acked_at,
      ackedBy: event.acked_by,
    })),
    cursor: events.length > 0 ? events[events.length - 1]?.id ?? after : after,
  });
});

agentRoutes.post('/:slug/events/ack', (req: Request, res: Response) => {
  const slug = getSlug(req);
  if (!slug) {
    res.status(400).json({ success: false, error: 'Invalid slug' });
    return;
  }
  if (!checkAuth(req, res, slug, ['editor', 'owner_bot'])) return;
  const payload = asPayload(req.body);
  const upToId = typeof payload.upToId === 'number' ? payload.upToId : Number.NaN;
  if (!Number.isFinite(upToId) || upToId < 0) {
    res.status(400).json({ success: false, error: 'Invalid upToId' });
    return;
  }
  const by = typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : 'owner';
  const acked = ackDocumentEvents(slug, Math.trunc(upToId), by);
  res.json({ success: true, acked });
});

agentRoutes.use(async (req: Request, res: Response) => {
  const slug = getSlug(req);
  const method = req.method.toUpperCase();
  const path = req.path || '/';
  const mutationRoute = `${method} ${path}`;
  if (!slug) {
    sendMutationResponse(res, 400, { success: false, error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }
  if (!checkAuth(req, res, slug, ['viewer', 'commenter', 'editor', 'owner_bot'])) return;
  if (routeRequiresMutation(method, path)) {
      const role = resolveDocumentAccessRole(slug, getPresentedSecret(req, slug) ?? '');
    if (!hasRole(role, ['editor', 'owner_bot'])) {
      sendMutationResponse(
        res,
        403,
        { success: false, error: 'Insufficient role for mutation route' },
        { route: mutationRoute, slug },
      );
      return;
    }
  }
  const result = await executeDocumentOperationAsync(slug, method, path, asPayload(req.body));
  if (routeRequiresMutation(method, path) && result.status >= 200 && result.status < 300) {
    notifyCollabMutation(slug, buildParticipationFromMutation(req, slug, asPayload(req.body), { details: `${method} ${path}` }));
  }
  if (routeRequiresMutation(method, path)) {
    sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
    return;
  }
  res.status(result.status).json(result.body);
});
