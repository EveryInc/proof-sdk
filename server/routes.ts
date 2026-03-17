import { createHash, randomUUID } from 'crypto';
import { Router, text, type Request, type Response } from 'express';
import { generateSlug } from './slug.js';
import {
  applyAgentCursorHintToLoadedCollab,
  applyAgentPresenceToLoadedCollab,
  applyCanonicalDocumentToCollab,
  buildCollabSession,
  getCanonicalReadableDocumentSync,
  getCollabRuntime,
  invalidateCollabDocument,
  invalidateCollabDocumentAndWait,
  loadedCollabMarksMatch,
  preserveMarksOnlyWriteIfAuthoritativeYjsMatches,
  refreshLoadedCollabMetaFromDb,
  syncCanonicalDocumentStateToCollab,
  stripEphemeralCollabSpans,
  acquireRewriteLock,
} from './collab.js';
import { getSnapshotPublicUrl, refreshSnapshotForSlug } from './snapshot.js';
import { executeCanonicalRewrite, mutateCanonicalDocument } from './canonical-document.js';
import {
  addEvent,
  addDocumentEvent,
  bumpDocumentAccessEpoch,
  canMutateByOwnerIdentity,
  createDocument,
  createDocumentAccessToken,
  deleteDocument,
  getDocument,
  getDocumentBySlug,
  getStoredIdempotencyRecord,
  pauseDocument,
  resolveDocumentAccess,
  resolveDocumentAccessRole,
  rebuildDocumentBlocks,
  resumeDocument,
  revokeDocument,
  revokeDocumentAccessTokens,
  storeIdempotencyResult,
  updateDocument,
  updateDocumentTitle,
  updateMarks,
} from './db.js';
import { isShareRole, type ShareRole } from './share-types.js';
import { broadcastToRoom, closeRoom, getActiveCollabClientBreakdown, getRoomSize } from './ws.js';
import { runLegacyMarkRangeBackfillOnce } from './marks-range-backfill.js';
import { createRateLimiter } from './rate-limiter.js';
import { getCookie, shareTokenCookieName } from './cookies.js';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';
import {
  recordRewriteBarrierFailure,
  recordRewriteBarrierLatency,
  recordRewriteForceIgnored,
  recordRewriteLiveClientBlock,
} from './metrics.js';
import {
  handleOAuthCallback,
  pollOAuthFlow,
  resolveShareMarkdownAuthMode,
  revokeHostedSessionToken,
  startOAuthFlow,
  validateHostedSessionToken,
} from './hosted-auth.js';
import {
  AGENT_DOCS_PATH,
  CANONICAL_CREATE_API_PATH,
  DIRECT_SHARE_AUTH_FIX,
  buildLegacyCreateDeprecationPayload,
  buildLegacyCreateDisabledPayload,
  canonicalCreateLink,
  getLegacyCreateResponseHeaders,
  resolveLegacyCreateMode,
  type LegacyCreateMode,
} from './agent-guidance.js';
import { captureDocumentCreatedTelemetry } from './telemetry.js';
import { executeDocumentOperationAsync, type EngineExecutionResult } from './document-engine.js';
import {
  type DocumentOpType,
  authorizeDocumentOp,
  parseDocumentOpRequest,
  resolveDocumentOpRoute,
} from './document-ops.js';
import { validateRewriteApplyPayload } from './rewrite-validation.js';
import { adaptMutationResponse } from './mutation-coordinator.js';
import {
  annotateRewriteDisruptionMetadata,
  classifyRewriteBarrierFailureReason,
  evaluateRewriteLiveClientGate,
  rewriteBarrierFailedResponseBody,
  rewriteBlockedResponseBody,
} from './rewrite-policy.js';
import { summarizeDocumentIntegrity } from './document-integrity.js';
import {
  getMutationContractStage,
  isIdempotencyRequired,
  validateOpPrecondition,
} from './mutation-stage.js';
import { resolveExplicitAgentIdentity } from '../src/shared/agent-identity.js';
import {
  buildProofSdkAgentDescriptor,
  buildProofSdkDocumentPaths,
  buildProofSdkLinks,
} from './proof-sdk-routes.js';

export const apiRoutes = Router();
runLegacyMarkRangeBackfillOnce();

const DIRECT_SHARE_RATE_LIMIT_BUCKETS = new Map<string, { count: number; resetAt: number }>();
const DEFAULT_DIRECT_SHARE_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_UNAUTH_PER_MIN = 20;
const DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_AUTH_PER_MIN = 120;
const DIRECT_SHARE_RATE_LIMIT_MAX_BUCKETS = 10_000;
const OPS_RATE_LIMIT_WINDOW_MS = parsePositiveIntEnv('PROOF_OPS_RATE_LIMIT_WINDOW_MS', 60_000);
const OPS_RATE_LIMIT_MAX_REQUESTS = parsePositiveIntEnv('PROOF_OPS_RATE_LIMIT_MAX', 120);
const REWRITE_BARRIER_TIMEOUT_MS = parsePositiveIntEnv('PROOF_REWRITE_BARRIER_TIMEOUT_MS', 5000);
const opsRateLimiter = createRateLimiter({
  windowMs: OPS_RATE_LIMIT_WINDOW_MS,
  maxRequests: OPS_RATE_LIMIT_MAX_REQUESTS,
  keyFn: (req) => `${getClientIp(req)}:${getSlugParam(req) || 'unknown'}`,
});

export const shareMarkdownBodyParser = text({
  type: ['text/plain', 'text/markdown'],
  limit: '10mb',
});

function getSlugParam(req: Request): string | null {
  const slugParam = req.params.slug;
  if (typeof slugParam === 'string' && slugParam.length > 0) return slugParam;
  if (Array.isArray(slugParam) && typeof slugParam[0] === 'string' && slugParam[0].length > 0) return slugParam[0];
  return null;
}

function isMarksPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trustProxyHeaders(): boolean {
  const value = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isMarksPayload(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getIdempotencyKey(req: Request): string | null {
  const header = req.header('idempotency-key') ?? req.header('x-idempotency-key');
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hashRequestBody(body: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  } catch {
    return createHash('sha256').update(String(body)).digest('hex');
  }
}

function getClientIp(req: Request): string {
  if (trustProxyHeaders()) {
    const forwardedFor = req.header('x-forwarded-for');
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
      const first = forwardedFor.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  if (req.ip && req.ip.trim()) return req.ip;
  if (req.socket?.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlankMarkdown(markdown: string): boolean {
  return !markdown.trim();
}

type CommentEventType = 'comment.added' | 'comment.replied' | 'comment.resolved';

type CommentEventEmission = {
  type: CommentEventType;
  data: Record<string, unknown>;
  actor: string;
};

type NormalizedCommentReply = {
  by: string;
  text: string;
  at: string;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCommentReplies(mark: Record<string, unknown>): NormalizedCommentReply[] {
  const rawReplies = Array.isArray(mark.thread)
    ? mark.thread
    : (Array.isArray(mark.replies) ? mark.replies : []);
  const replies: NormalizedCommentReply[] = [];
  for (const entry of rawReplies) {
    if (!isRecord(entry)) continue;
    const by = asNonEmptyString(entry.by);
    const text = asNonEmptyString(entry.text);
    const at = asNonEmptyString(entry.at) ?? '';
    if (!by || !text) continue;
    replies.push({ by, text, at });
  }
  return replies;
}

function replyFingerprint(reply: NormalizedCommentReply): string {
  return `${reply.by}\u0000${reply.text}\u0000${reply.at}`;
}

function collectCommentEventsFromMarksDiff(
  beforeMarks: Record<string, unknown>,
  afterMarks: Record<string, unknown>,
  fallbackActor: string,
): CommentEventEmission[] {
  const events: CommentEventEmission[] = [];

  for (const [markId, rawAfterMark] of Object.entries(afterMarks)) {
    if (!isRecord(rawAfterMark)) continue;
    if (rawAfterMark.kind !== 'comment') continue;

    const beforeMark = isRecord(beforeMarks[markId]) ? beforeMarks[markId] as Record<string, unknown> : null;
    const beforeWasComment = beforeMark?.kind === 'comment';
    const commentBy = asNonEmptyString(rawAfterMark.by) ?? fallbackActor;
    const commentText = typeof rawAfterMark.text === 'string' ? rawAfterMark.text : '';
    const commentQuote = typeof rawAfterMark.quote === 'string' ? rawAfterMark.quote : '';

    if (!beforeWasComment) {
      events.push({
        type: 'comment.added',
        data: { markId, by: commentBy, quote: commentQuote, text: commentText },
        actor: commentBy,
      });
    }

    const beforeReplies = beforeMark ? readCommentReplies(beforeMark) : [];
    const afterReplies = readCommentReplies(rawAfterMark);
    if (afterReplies.length > 0) {
      const beforeCounts = new Map<string, number>();
      for (const reply of beforeReplies) {
        const key = replyFingerprint(reply);
        beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
      }
      for (const reply of afterReplies) {
        const key = replyFingerprint(reply);
        const remaining = beforeCounts.get(key) ?? 0;
        if (remaining > 0) {
          beforeCounts.set(key, remaining - 1);
          continue;
        }
        events.push({
          type: 'comment.replied',
          data: { markId, by: reply.by, text: reply.text },
          actor: reply.by || fallbackActor,
        });
      }
    }

    if (beforeWasComment && !Boolean(beforeMark?.resolved) && Boolean(rawAfterMark.resolved)) {
      events.push({
        type: 'comment.resolved',
        data: { markId, by: fallbackActor },
        actor: fallbackActor,
      });
    }
  }

  return events;
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
        invalidateCollabDocumentAndWait(slug),
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
    console.error('[routes] Failed to prepare rewrite collab barrier:', { slug, error });
    invalidateCollabDocument(slug);
    throw error;
  }
}

function maybeBuildAgentParticipation(
  req: Request,
  body: Record<string, unknown>,
): { presenceEntry: Record<string, unknown>; cursorQuote: string | null } | null {
  const identity = resolveExplicitAgentIdentity(body, req.header('x-agent-id'));
  if (identity.kind !== 'ok') return null;

  const presenceEntry: Record<string, unknown> = {
    id: identity.id,
    name: identity.name,
    color: identity.color,
    avatar: identity.avatar,
    status: 'editing',
    details: 'ops',
    at: new Date().toISOString(),
  };

  const quote = typeof body.quote === 'string' && body.quote.trim() ? body.quote.trim() : null;
  return { presenceEntry, cursorQuote: quote };
}

function getDirectShareApiKey(): string | null {
  const key = (process.env.PROOF_SHARE_MARKDOWN_API_KEY || '').trim();
  return key.length > 0 ? key : null;
}

function getDirectSharePresentedToken(req: Request): string | null {
  const headerKey = req.header('x-api-key');
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

type DirectShareAuthorizationResult = {
  authed: boolean;
  authMode: 'none' | 'api_key' | 'oauth' | 'oauth_or_api_key';
  actor: string;
};

function buildOAuthNotConfiguredPayload(errorMessage: string): Record<string, unknown> {
  return {
    error: errorMessage,
    code: 'OAUTH_NOT_CONFIGURED',
    workaround: {
      endpoint: '/api/documents',
      method: 'POST',
      description: 'Use share tokens or PROOF_SHARE_MARKDOWN_API_KEY while OAuth is unavailable.',
      body: { markdown: '# Title\n\nHello' },
    },
  };
}

function sendOAuthChallenge(req: Request, res: Response, reason: string): null {
  const publicBaseUrl = getPublicBaseUrl(req);
  const started = startOAuthFlow(publicBaseUrl);
  if (!started.ok) {
    res.status(503).json(buildOAuthNotConfiguredPayload('OAuth is not configured on this server'));
    return null;
  }

  res.status(401).json({
    error: 'Authentication required',
    code: 'AUTH_REQUIRED',
    providerCode: 'OAUTH_REQUIRED',
    reason,
    fix: DIRECT_SHARE_AUTH_FIX,
    alternative: 'Or use OAuth: open authUrl in browser',
    authUrl: started.authUrl,
    pollUrl: started.pollUrl,
    pollToken: started.pollToken,
    expiresAt: started.expiresAt,
    expiresIn: started.expiresIn,
    auth: {
      provider: 'oauth',
      requestId: started.requestId,
      authUrl: started.authUrl,
      pollUrl: started.pollUrl,
      pollToken: started.pollToken,
      expiresAt: started.expiresAt,
      expiresIn: started.expiresIn,
      startEndpoint: '/api/auth/start',
      pollEndpoint: '/api/auth/poll/:requestId',
    },
  });
  return null;
}

function applyLegacyCreateHeaders(res: Response, mode: LegacyCreateMode): void {
  const headers = getLegacyCreateResponseHeaders(mode);
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function recordLegacyCreateRouteTelemetry(
  req: Request,
  mode: LegacyCreateMode,
  outcome: 'allowed' | 'allowed_warn' | 'blocked_disabled',
): void {
  console.info('[telemetry] legacy_create_route', JSON.stringify({
    mode,
    outcome,
    ip: getClientIp(req),
    host: req.get('host') || '',
    at: new Date().toISOString(),
  }));
}

async function authorizeDirectShareRequest(
  req: Request,
  res: Response,
): Promise<DirectShareAuthorizationResult | null> {
  const publicBaseUrl = getPublicBaseUrl(req);
  const authMode = resolveShareMarkdownAuthMode(publicBaseUrl);
  const presented = getDirectSharePresentedToken(req);

  if (authMode === 'none') {
    return { authed: false, authMode, actor: 'anonymous' };
  }

  if (authMode === 'api_key') {
    const requiredApiKey = getDirectShareApiKey();
    if (!requiredApiKey) {
      res.status(503).json({
        error: 'Direct share API key mode is enabled but PROOF_SHARE_MARKDOWN_API_KEY is missing',
        code: 'DIRECT_SHARE_MISCONFIGURED',
      });
      return null;
    }
    if (presented === requiredApiKey) {
      return { authed: true, authMode, actor: 'api-key' };
    }
    res.status(401).json({
      error: 'Unauthorized direct share request',
      code: 'UNAUTHORIZED',
      hint: 'Set Authorization: Bearer <PROOF_SHARE_MARKDOWN_API_KEY> or x-api-key.',
    });
    return null;
  }

  const requiredApiKey = getDirectShareApiKey();
  if (authMode === 'oauth_or_api_key' && requiredApiKey && presented === requiredApiKey) {
    return { authed: true, authMode, actor: 'api-key' };
  }

  if (!presented) {
    return sendOAuthChallenge(req, res, 'missing_token');
  }

  const validated = await validateHostedSessionToken(presented, publicBaseUrl);
  if (validated.ok && validated.principal) {
    return {
      authed: true,
      authMode,
      actor: `oauth:${validated.principal.userId}`,
    };
  }

  return sendOAuthChallenge(req, res, validated.reason || 'invalid_token');
}

function checkDirectShareRateLimit(
  req: Request,
  authed: boolean,
): { allowed: true } | { allowed: false; retryAfterSeconds: number; max: number; windowMs: number } {
  const max = authed
    ? parsePositiveIntEnv('PROOF_SHARE_MARKDOWN_RATE_LIMIT_MAX_AUTH_PER_MIN', DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_AUTH_PER_MIN)
    : parsePositiveIntEnv('PROOF_SHARE_MARKDOWN_RATE_LIMIT_MAX_UNAUTH_PER_MIN', DEFAULT_DIRECT_SHARE_RATE_LIMIT_MAX_UNAUTH_PER_MIN);
  const windowMs = parsePositiveIntEnv('PROOF_SHARE_MARKDOWN_RATE_LIMIT_WINDOW_MS', DEFAULT_DIRECT_SHARE_RATE_LIMIT_WINDOW_MS);
  const now = Date.now();
  if (DIRECT_SHARE_RATE_LIMIT_BUCKETS.size > 0) {
    for (const [key, bucket] of DIRECT_SHARE_RATE_LIMIT_BUCKETS.entries()) {
      if (bucket.resetAt <= now) {
        DIRECT_SHARE_RATE_LIMIT_BUCKETS.delete(key);
      }
    }
  }
  if (DIRECT_SHARE_RATE_LIMIT_BUCKETS.size > DIRECT_SHARE_RATE_LIMIT_MAX_BUCKETS) {
    const overflow = DIRECT_SHARE_RATE_LIMIT_BUCKETS.size - DIRECT_SHARE_RATE_LIMIT_MAX_BUCKETS;
    let pruned = 0;
    for (const key of DIRECT_SHARE_RATE_LIMIT_BUCKETS.keys()) {
      DIRECT_SHARE_RATE_LIMIT_BUCKETS.delete(key);
      pruned += 1;
      if (pruned >= overflow) break;
    }
  }
  const bucketKey = `${authed ? 'auth' : 'anon'}:${getClientIp(req)}`;
  const existing = DIRECT_SHARE_RATE_LIMIT_BUCKETS.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    DIRECT_SHARE_RATE_LIMIT_BUCKETS.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (existing.count >= max) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      max,
      windowMs,
    };
  }

  existing.count += 1;
  return { allowed: true };
}

function getPublicBaseUrl(req: Request): string {
  if (trustProxyHeaders()) {
    const forwardedProtoHeader = req.header('x-forwarded-proto');
    const forwardedHostHeader = req.header('x-forwarded-host');
    const forwardedProto = typeof forwardedProtoHeader === 'string'
      ? forwardedProtoHeader.split(',')[0]?.trim()
      : '';
    const forwardedHost = typeof forwardedHostHeader === 'string'
      ? forwardedHostHeader.split(',')[0]?.trim()
      : '';
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }
  }

  const configuredBase = (process.env.PROOF_PUBLIC_BASE_URL || '').trim();
  if (configuredBase) {
    return configuredBase.replace(/\/+$/, '');
  }

  const host = req.get('host') || '';
  if (!host) return '';
  return `${req.protocol || 'http'}://${host}`;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function resolveRequestScopedCollabWsBase(req: Request): string {
  const collabRuntime = getCollabRuntime();
  const runtimeBase = (collabRuntime.wsUrlBase || '').trim();
  if (!runtimeBase) return runtimeBase;

  const configuredPublicBase = (process.env.COLLAB_PUBLIC_BASE_URL || '').trim();
  if (configuredPublicBase) {
    return configuredPublicBase.replace(/\/+$/, '');
  }

  const embeddedRaw = (process.env.COLLAB_EMBEDDED_WS || '').trim().toLowerCase();
  const embedded = embeddedRaw === '1' || embeddedRaw === 'true' || embeddedRaw === 'yes' || embeddedRaw === 'on';

  const publicBase = getPublicBaseUrl(req);
  if (!publicBase) return runtimeBase;

  try {
    const wsUrl = new URL(runtimeBase);
    if (!isLoopbackHost(wsUrl.hostname)) {
      return runtimeBase;
    }

    const publicUrl = new URL(publicBase);
    wsUrl.protocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.hostname = publicUrl.hostname;

    if (embedded) {
      // Embedded mode: WS is multiplexed on the main HTTP port, keep same port.
      wsUrl.port = publicUrl.port;
    } else if (isLoopbackHost(publicUrl.hostname) && publicUrl.port) {
      const appPort = Number.parseInt(publicUrl.port, 10);
      if (!Number.isFinite(appPort) || appPort <= 0) {
        return runtimeBase;
      }
      wsUrl.port = String(appPort + 1);
    } else {
      wsUrl.port = publicUrl.port;
    }
    wsUrl.search = '';
    wsUrl.hash = '';
    return wsUrl.toString().replace(/\/+$/, '');
  } catch {
    return runtimeBase;
  }
}

function buildShareLink(req: Request, slug: string): { url: string; shareUrl: string } {
  const url = `/d/${slug}`;
  const base = getPublicBaseUrl(req);
  return {
    url,
    shareUrl: base ? `${base}${url}` : url,
  };
}

function withShareToken(url: string, token: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

function getExplicitShareSecret(req: Request): string | null {
  const bodySecret = req.body?.ownerSecret;
  if (typeof bodySecret === 'string' && bodySecret.trim()) return bodySecret.trim();

  const shareTokenHeader = req.header('x-share-token');
  if (typeof shareTokenHeader === 'string' && shareTokenHeader.trim()) return shareTokenHeader.trim();

  const bridgeTokenHeader = req.header('x-bridge-token');
  if (typeof bridgeTokenHeader === 'string' && bridgeTokenHeader.trim()) return bridgeTokenHeader.trim();

  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  const slugParam = req.params.slug;
  if (typeof slugParam === 'string' && slugParam.trim()) {
    const fromCookie = getCookie(req, shareTokenCookieName(slugParam.trim()));
    if (typeof fromCookie === 'string' && fromCookie.trim()) return fromCookie.trim();
  }

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      const token = match[1].trim();
      // Hosted app-session tokens should not be treated as share secrets.
      if (token && !token.startsWith('epsess_')) {
        return token;
      }
    }
  }

  return null;
}

function getPresentedSecret(req: Request): string | null {
  const explicit = getExplicitShareSecret(req);
  if (explicit) return explicit;

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }

  return null;
}

function getPresentedBearerToken(req: Request): string | null {
  const authHeader = req.header('authorization');
  if (typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function getAccessRole(req: Request, slug: string): ShareRole | null {
  const secret = getPresentedSecret(req);
  if (secret) return resolveDocumentAccessRole(slug, secret);
  // Product decision: tokenless shared docs default to editable access (slug is the secret).
  return 'editor';
}

function canOwnerMutate(req: Request, doc: { owner_secret: string | null; owner_secret_hash: string | null; owner_id: string | null }): boolean {
  return canMutateByOwnerIdentity(doc, getExplicitShareSecret(req));
}

function isOAuthPrincipalOwner(ownerId: string | null | undefined, oauthUserId: number): boolean {
  if (!ownerId || !ownerId.trim()) return false;
  const normalized = ownerId.trim();
  const asString = String(oauthUserId);
  return normalized === asString
    || normalized === `oauth:${asString}`
    || normalized === `oauth_user:${asString}`;
}

async function ownerAuthorizedViaOAuth(req: Request, ownerId: string | null | undefined): Promise<boolean> {
  const bearerToken = getPresentedBearerToken(req);
  if (!bearerToken) return false;
  const validated = await validateHostedSessionToken(bearerToken, getPublicBaseUrl(req));
  if (!validated.ok || !validated.principal) return false;
  return isOAuthPrincipalOwner(ownerId, validated.principal.userId);
}

type OpenContextAccess = {
  role: ShareRole;
  tokenId: string | null;
  ownerAuthorized: boolean;
};

async function resolveOpenContextAccess(
  req: Request,
  res: Response,
  slug: string,
  doc: { owner_id: string | null; owner_secret: string | null; owner_secret_hash: string | null },
): Promise<OpenContextAccess | null> {
  const explicitSecret = getExplicitShareSecret(req);
  const bearerToken = getPresentedBearerToken(req);
  const explicitResolved = explicitSecret ? resolveDocumentAccess(slug, explicitSecret) : null;
  const bearerResolved = !explicitResolved && bearerToken ? resolveDocumentAccess(slug, bearerToken) : null;
  const resolved = explicitResolved ?? bearerResolved;
  const ownerBySecret = canMutateByOwnerIdentity(doc, explicitSecret);
  const ownerByOAuth = await ownerAuthorizedViaOAuth(req, doc.owner_id);
  const ownerAuthorized = ownerBySecret || ownerByOAuth;

  if (ownerAuthorized) {
    return { role: 'owner_bot', tokenId: null, ownerAuthorized: true };
  }
  if (resolved) {
    return {
      role: resolved.role,
      tokenId: resolved.tokenId,
      ownerAuthorized: resolved.role === 'owner_bot',
    };
  }
  if (explicitSecret) {
    res.status(401).json({
      error: 'Invalid share token',
      code: 'UNAUTHORIZED',
    });
    return null;
  }

  // Tokenless links default to read-only access.
  return { role: 'editor', tokenId: null, ownerAuthorized: false };
}

function deriveShareCapabilities(role: ShareRole, shareState: string): {
  canRead: boolean;
  canComment: boolean;
  canEdit: boolean;
} {
  const isOwner = role === 'owner_bot';
  // Product decision: non-owners cannot access paused/revoked shares at all.
  const canRead = shareState === 'ACTIVE' || (isOwner && shareState !== 'DELETED');
  const canEdit = isOwner
    ? (shareState === 'ACTIVE' || shareState === 'PAUSED')
    : (role === 'editor' && shareState === 'ACTIVE');
  const canComment = shareState === 'ACTIVE'
    && (role === 'commenter' || role === 'editor' || isOwner);
  return {
    canRead,
    canComment,
    canEdit,
  };
}

// Create a shared document
apiRoutes.post('/documents', (req: Request, res: Response) => {
  const legacyCreateMode = resolveLegacyCreateMode(getPublicBaseUrl(req));
  if (legacyCreateMode === 'disabled') {
    recordLegacyCreateRouteTelemetry(req, legacyCreateMode, 'blocked_disabled');
    applyLegacyCreateHeaders(res, legacyCreateMode);
    res.status(410).json(buildLegacyCreateDisabledPayload());
    return;
  }
  if (legacyCreateMode === 'warn') {
    recordLegacyCreateRouteTelemetry(req, legacyCreateMode, 'allowed_warn');
    applyLegacyCreateHeaders(res, legacyCreateMode);
  } else {
    recordLegacyCreateRouteTelemetry(req, legacyCreateMode, 'allowed');
  }

  const { markdown, marks, title, ownerId } = req.body;

  if (typeof markdown !== 'string') {
    res.status(400).json({
      error: 'markdown field is required',
      code: 'MISSING_MARKDOWN',
      fix: '{"markdown":"# Title\\n\\nHello"}',
    });
    return;
  }
  const sanitizedMarkdown = stripEphemeralCollabSpans(markdown);
  if (isBlankMarkdown(sanitizedMarkdown)) {
    res.status(400).json({
      error: 'markdown must not be empty',
      code: 'EMPTY_MARKDOWN',
      fix: '{"markdown":"# Title\\n\\nHello"}',
    });
    return;
  }
  if (marks !== undefined && !isMarksPayload(marks)) {
    res.status(400).json({ error: 'marks must be an object when provided', code: 'INVALID_MARKS' });
    return;
  }

  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const normalizedMarks = canonicalizeStoredMarks(marks ?? {});
  const doc = createDocument(slug, sanitizedMarkdown, normalizedMarks, title, ownerId, ownerSecret);
  const defaultAccess = createDocumentAccessToken(slug, 'editor');
  const links = buildShareLink(req, doc.slug);
  const shareUrlWithToken = withShareToken(links.shareUrl, defaultAccess.secret);
  const urlWithToken = withShareToken(links.url, defaultAccess.secret);
  refreshSnapshotForSlug(slug);

  addEvent(slug, 'document.created', {
    title,
    ownerId,
    shareState: doc.share_state,
  }, ownerId || 'anonymous');
  captureDocumentCreatedTelemetry({
    slug: doc.slug,
    source: 'api.documents',
    ownerId,
    title,
    shareState: doc.share_state,
    accessRole: defaultAccess.role,
    authMode: 'none',
    authenticated: false,
    contentChars: sanitizedMarkdown.length,
  });

  res.json({
    success: true,
    slug: doc.slug,
    docId: doc.doc_id,
    // Canonical share links are clean; tokenized links are kept for compatibility/debugging.
    url: links.url,
    shareUrl: links.shareUrl,
    tokenPath: urlWithToken,
    tokenUrl: shareUrlWithToken,
    viewUrl: links.shareUrl,
    viewPath: links.url,
    ownerSecret,
    accessToken: defaultAccess.secret,
    accessRole: defaultAccess.role,
    active: true,
    shareState: doc.share_state,
    snapshotUrl: getSnapshotPublicUrl(doc.slug),
    createdAt: doc.created_at,
    _links: {
      view: links.url,
      web: links.shareUrl,
      tokenUrl: shareUrlWithToken,
      ...buildProofSdkLinks(doc.slug, {
        includeMutationRoutes: true,
        includeBridgeRoutes: true,
      }),
    },
    agent: buildProofSdkAgentDescriptor(doc.slug, {
      includeMutationRoutes: true,
      includeBridgeRoutes: true,
    }),
    ...(legacyCreateMode === 'warn'
      ? { deprecation: buildLegacyCreateDeprecationPayload(legacyCreateMode) }
      : {}),
  });
});

apiRoutes.post('/documents/:slug/access-links', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getCanonicalReadableDocumentSync(slug, 'share') ?? getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }

  const ownerAuthorized = canOwnerMutate(req, doc) || await ownerAuthorizedViaOAuth(req, doc.owner_id);
  const secret = getPresentedSecret(req);
  const role = secret ? resolveDocumentAccessRole(slug, secret) : null;
  const canCreateAccessLinks = ownerAuthorized || role === 'editor' || role === 'owner_bot';
  if (!canCreateAccessLinks) {
    res.status(403).json({ error: 'Not authorized to create access links' });
    return;
  }

  const requestedRole = req.body?.role;
  if (!isShareRole(requestedRole) || requestedRole === 'owner_bot') {
    res.status(400).json({ error: 'role must be viewer, commenter, or editor' });
    return;
  }

  const created = createDocumentAccessToken(slug, requestedRole);
  const links = buildShareLink(req, slug);
  const separator = links.shareUrl.includes('?') ? '&' : '?';
  const webShareUrl = `${links.shareUrl}${separator}token=${encodeURIComponent(created.secret)}`;

  res.json({
    success: true,
    slug,
    role: created.role,
    tokenId: created.tokenId,
    accessToken: created.secret,
    token: created.secret,
    webShareUrl,
    createdAt: created.createdAt,
  });
});

apiRoutes.post('/auth/start', (req: Request, res: Response) => {
  const started = startOAuthFlow(getPublicBaseUrl(req));
  if (!started.ok) {
    res.status(503).json(buildOAuthNotConfiguredPayload(started.error));
    return;
  }
  res.json({
    success: true,
    provider: 'oauth',
    ...started,
  });
});

function handleOAuthPoll(req: Request, res: Response): void {
  const requestId = req.params.requestId;
  if (!requestId || !requestId.trim()) {
    res.status(400).json({ error: 'Missing requestId', code: 'BAD_REQUEST' });
    return;
  }

  const queryToken = typeof req.query.pollToken === 'string' ? req.query.pollToken.trim() : '';
  const headerToken = typeof req.header('x-auth-poll-token') === 'string'
    ? req.header('x-auth-poll-token')!.trim()
    : '';
  const pollToken = queryToken || headerToken;
  if (!pollToken) {
    res.status(400).json({ error: 'Missing poll token', code: 'MISSING_POLL_TOKEN' });
    return;
  }

  const polled = pollOAuthFlow(requestId, pollToken);
  if (!polled) {
    res.status(404).json({ error: 'Auth request not found or expired', code: 'AUTH_REQUEST_NOT_FOUND' });
    return;
  }
  if (polled.status === 'failed' && polled.error === 'Invalid poll token') {
    res.status(401).json({ error: 'Invalid poll token', code: 'UNAUTHORIZED' });
    return;
  }
  res.json({ success: polled.status === 'completed', ...polled });
}

apiRoutes.get('/auth/poll/:requestId', handleOAuthPoll);

apiRoutes.get('/auth/callback', async (req: Request, res: Response) => {
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  const error = typeof req.query.error === 'string' ? req.query.error.trim() : '';
  if (!state) {
    res.status(400).type('html').send('<html><body><h1>Sign-in failed</h1><p>Missing OAuth state.</p></body></html>');
    return;
  }

  const result = await handleOAuthCallback({
    state,
    code: code || undefined,
    error: error || undefined,
    publicBaseUrl: getPublicBaseUrl(req),
  });
  const status = result.ok ? 200 : 400;
  const title = result.ok ? 'Sign-in complete' : 'Sign-in failed';
  const body = result.ok
    ? '<p>You can close this tab and return to your agent.</p>'
    : '<p>Please return to your agent and retry sign-in.</p>';
  res.status(status).type('html').send(`<!doctype html><html><body><h1>${title}</h1><p>${result.message}</p>${body}</body></html>`);
});

apiRoutes.post('/auth/logout', (req: Request, res: Response) => {
  const token = getDirectSharePresentedToken(req);
  if (!token) {
    res.status(400).json({ error: 'Missing session token', code: 'MISSING_TOKEN' });
    return;
  }
  const revoked = revokeHostedSessionToken(token);
  res.json({ success: revoked });
});

// Agent-friendly endpoint: send markdown directly and get a share link back.
apiRoutes.post(
  '/share/markdown',
  shareMarkdownBodyParser,
  handleShareMarkdown,
);

export async function handleShareMarkdown(req: Request, res: Response): Promise<void> {
  const auth = await authorizeDirectShareRequest(req, res);
  if (!auth) return;

  const rateLimit = checkDirectShareRateLimit(req, auth.authed);
  if (!rateLimit.allowed) {
    res.setHeader('retry-after', String(rateLimit.retryAfterSeconds));
    res.status(429).json({
      error: 'Rate limit exceeded for direct share creation',
      code: 'RATE_LIMITED',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      maxPerWindow: rateLimit.max,
      windowMs: rateLimit.windowMs,
    });
    return;
  }

  const isRawTextBody = typeof req.body === 'string';
  const body = (isRawTextBody ? null : req.body) as Record<string, unknown> | null;

  const markdownCandidate = isRawTextBody
    ? req.body
    : (body?.markdown ?? body?.content);
  const markdown = typeof markdownCandidate === 'string' ? markdownCandidate : '';
  const sanitizedMarkdown = stripEphemeralCollabSpans(markdown);
  if (!sanitizedMarkdown.trim()) {
    res.status(400).json({
      error: 'markdown field is required',
      code: 'MISSING_MARKDOWN',
      fix: '{"markdown":"# Title\\n\\nHello"}',
      hint: 'Send JSON { \"markdown\": \"...\" } or send the raw markdown body as text/plain.',
    });
    return;
  }

  const marksCandidate = body?.marks;
  if (marksCandidate !== undefined && !isMarksPayload(marksCandidate)) {
    res.status(400).json({ error: 'marks must be an object when provided', code: 'INVALID_MARKS' });
    return;
  }
  const marks = canonicalizeStoredMarks(isMarksPayload(marksCandidate) ? marksCandidate : {});

  const titleFromQuery = typeof req.query.title === 'string' ? req.query.title : undefined;
  const title = typeof body?.title === 'string'
    ? body.title
    : titleFromQuery;
  const ownerIdFromQuery = typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined;
  const ownerId = typeof body?.ownerId === 'string' ? body.ownerId : ownerIdFromQuery;

  const roleFromBody = body?.accessRole ?? body?.defaultRole ?? body?.role;
  const roleFromQuery = typeof req.query.role === 'string' ? req.query.role : undefined;
  const requestedRole = roleFromBody ?? roleFromQuery ?? 'editor';
  if (!isShareRole(requestedRole) || requestedRole === 'owner_bot') {
    res.status(400).json({ error: 'role must be viewer, commenter, or editor', code: 'INVALID_ROLE' });
    return;
  }

  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const doc = createDocument(slug, sanitizedMarkdown, marks, title, ownerId, ownerSecret);
  const access = createDocumentAccessToken(slug, requestedRole);
  const links = buildShareLink(req, doc.slug);
  const shareUrlWithToken = withShareToken(links.shareUrl, access.secret);
  const urlWithToken = withShareToken(links.url, access.secret);
  const proofSdkPaths = buildProofSdkDocumentPaths(doc.slug);
  refreshSnapshotForSlug(slug);

  addEvent(slug, 'document.created', {
    title,
    ownerId,
    shareState: doc.share_state,
    source: req.path === '/share/markdown' ? 'share.markdown' : 'api.share.markdown',
    accessRole: access.role,
    authMode: auth.authMode,
    authenticated: auth.authed,
  }, ownerId || auth.actor);
  captureDocumentCreatedTelemetry({
    slug: doc.slug,
    source: req.path === '/share/markdown' ? 'share.markdown' : 'api.share.markdown',
    ownerId,
    title,
    shareState: doc.share_state,
    accessRole: access.role,
    authMode: auth.authMode,
    authenticated: auth.authed,
    contentChars: sanitizedMarkdown.length,
  });

  res.json({
    success: true,
    slug: doc.slug,
    docId: doc.doc_id,
    url: links.url,
    shareUrl: links.shareUrl,
    tokenPath: urlWithToken,
    tokenUrl: shareUrlWithToken,
    viewUrl: links.shareUrl,
    viewPath: links.url,
    ownerSecret,
    accessToken: access.secret,
    accessRole: access.role,
    active: true,
    shareState: doc.share_state,
    snapshotUrl: getSnapshotPublicUrl(doc.slug),
    createdAt: doc.created_at,
    _links: {
      view: links.url,
      web: links.shareUrl,
      tokenUrl: shareUrlWithToken,
      ...buildProofSdkLinks(doc.slug, {
        includeMutationRoutes: true,
        includeBridgeRoutes: true,
      }),
      comment: {
        method: 'POST',
        href: proofSdkPaths.bridgeComments,
        body: { quote: '...', text: '...', by: 'ai:your-agent' },
      },
      suggest: {
        method: 'POST',
        href: proofSdkPaths.bridgeSuggestions,
        body: { kind: 'replace', quote: '...', content: '...', by: 'ai:your-agent' },
      },
      rewrite: {
        method: 'POST',
        href: proofSdkPaths.bridgeRewrite,
        body: { content: '# New draft...', by: 'ai:your-agent' },
      },
    },
    agent: buildProofSdkAgentDescriptor(doc.slug, {
      includeMutationRoutes: true,
      includeBridgeRoutes: true,
    }),
  });
}

// Get a shared document
apiRoutes.get('/documents/:slug', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getCanonicalReadableDocumentSync(slug, 'share') ?? getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const ownerOverride = canOwnerMutate(req, doc);
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  if (doc.share_state === 'REVOKED' && !ownerOverride) {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }
  if (doc.share_state === 'PAUSED' && !ownerOverride) {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }

  res.json({
    slug: doc.slug,
    docId: doc.doc_id,
    title: doc.title,
    markdown: doc.markdown,
    marks: parseJson(doc.marks),
    // Legacy compatibility for <=0.28 clients.
    active: doc.share_state === 'ACTIVE',
    shareState: doc.share_state,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    viewers: getRoomSize(doc.slug),
    _links: buildProofSdkLinks(doc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
    agent: buildProofSdkAgentDescriptor(doc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
  });
});

// Update document title metadata.
apiRoutes.put('/documents/:slug/title', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  if (doc.share_state === 'REVOKED') {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }

  const body = isRecord(req.body) ? req.body : {};
  const title = body.title;
  const actor = body.actor;
  const clientId = body.clientId;
  if (title !== null && typeof title !== 'string') {
    res.status(400).json({ error: 'title must be a string or null when provided' });
    return;
  }

  const accessRole = getAccessRole(req, slug);
  const ownerAuthorized = canOwnerMutate(req, doc);
  const ownerOrBot = ownerAuthorized || accessRole === 'owner_bot';
  const canEditTitle = ownerOrBot || (doc.share_state === 'ACTIVE' && accessRole === 'editor');

  if (doc.share_state === 'PAUSED' && !ownerOrBot) {
    res.status(403).json({ error: 'Document is paused' });
    return;
  }
  if (!canEditTitle) {
    res.status(403).json({ error: 'Not authorized to update document title' });
    return;
  }

  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  const canonicalTitle = normalizedTitle.length > 0 ? normalizedTitle : null;
  const writeSucceeded = updateDocumentTitle(slug, canonicalTitle);
  if (!writeSucceeded) {
    res.status(409).json({ error: 'Document changed during update; retry with latest state', code: 'STALE_BASE' });
    return;
  }

  const updatedDoc = getDocumentBySlug(slug);
  if (!updatedDoc) {
    res.status(500).json({ error: 'Document title updated but document could not be reloaded' });
    return;
  }

  broadcastToRoom(slug, {
    type: 'document.title.updated',
    title: updatedDoc.title,
    updatedAt: updatedDoc.updated_at,
    actor: actor || 'anonymous',
  }, clientId);
  addEvent(slug, 'document.title.updated', { actor }, actor || 'anonymous');

  refreshSnapshotForSlug(slug);

  res.json({
    success: true,
    title: updatedDoc.title,
    updatedAt: updatedDoc.updated_at,
  });
});

// Update document content + marks (from native app owner or web viewer)
apiRoutes.put('/documents/:slug', async (req: Request, res: Response) => {
  const { markdown, marks, title, actor, clientId, ownerSecret, ownerId } = req.body;
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  if (doc.share_state === 'REVOKED') {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }

  const hasMarkdownUpdate = markdown !== undefined;
  const hasMarksUpdate = marks !== undefined;
  const hasTitleUpdate = title !== undefined;
  const mutationActor = (typeof actor === 'string' && actor.trim()) ? actor.trim() : 'anonymous';
  const previousMarks = hasMarksUpdate ? parseJson(doc.marks) : null;
  const accessRole = getAccessRole(req, slug);
  const ownerAuthorized = canOwnerMutate(req, doc);
  const ownerOrBot = ownerAuthorized || accessRole === 'owner_bot';
  const canEditContent = ownerOrBot || (doc.share_state === 'ACTIVE' && accessRole === 'editor');
  const canMutateMarks = ownerOrBot
    || (doc.share_state === 'ACTIVE' && (accessRole === 'commenter' || accessRole === 'editor'));
  const normalizedTitle = hasTitleUpdate && typeof title === 'string' ? title.trim() : '';

  if (hasMarkdownUpdate && typeof markdown !== 'string') {
    res.status(400).json({ error: 'markdown must be a string when provided' });
    return;
  }
  const sanitizedMarkdown = hasMarkdownUpdate ? stripEphemeralCollabSpans(markdown as string) : '';
  if (hasMarkdownUpdate && isBlankMarkdown(sanitizedMarkdown)) {
    res.status(400).json({ error: 'markdown must not be empty', code: 'EMPTY_MARKDOWN' });
    return;
  }
  if (hasMarksUpdate && !isMarksPayload(marks)) {
    res.status(400).json({ error: 'marks must be an object when provided' });
    return;
  }
  const normalizedMarks = hasMarksUpdate ? canonicalizeStoredMarks(marks as Record<string, unknown>) : undefined;
  if (hasTitleUpdate && typeof title !== 'string') {
    res.status(400).json({ error: 'title must be a string when provided' });
    return;
  }
  if (hasTitleUpdate && normalizedTitle.length === 0) {
    res.status(400).json({ error: 'title must not be empty', code: 'EMPTY_TITLE' });
    return;
  }

  if (doc.share_state === 'PAUSED' && !ownerOrBot) {
    res.status(403).json({ error: 'Document is paused' });
    return;
  }

  if (hasMarkdownUpdate && !canEditContent) {
    res.status(403).json({ error: 'Not authorized to update document content' });
    return;
  }
  if (hasMarksUpdate && !canMutateMarks) {
    res.status(403).json({ error: 'Not authorized to update document marks' });
    return;
  }
  if (hasTitleUpdate && !canEditContent) {
    res.status(403).json({ error: 'Not authorized to update document title' });
    return;
  }

  if (hasMarkdownUpdate) {
    const barrierStartedAt = Date.now();
    try {
      await prepareRewriteCollabBarrier(slug);
      recordRewriteBarrierLatency('PUT /documents/:slug', Date.now() - barrierStartedAt);
    } catch (error) {
      const reason = classifyRewriteBarrierFailureReason(error);
      recordRewriteBarrierFailure('PUT /documents/:slug', reason);
      recordRewriteBarrierLatency('PUT /documents/:slug', Date.now() - barrierStartedAt);
      res.status(503).json(rewriteBarrierFailedResponseBody(slug, reason));
      return;
    }
  }

  const currentDoc = hasMarkdownUpdate ? (getDocumentBySlug(slug) ?? doc) : doc;
  let didUpdate = false;
  let writeSucceeded = true;
  let updatedDoc = currentDoc;
  let collabSyncFailed = false;
  let marksHandledDuringUpdate = false;
  if (hasMarkdownUpdate) {
    didUpdate = true;
    const mutation = await mutateCanonicalDocument({
      slug,
      nextMarkdown: sanitizedMarkdown,
      nextMarks: hasMarksUpdate
        ? normalizedMarks
        : canonicalizeStoredMarks(parseJson(currentDoc.marks) as Record<string, unknown>),
      source: 'rest-put',
      baseUpdatedAt: currentDoc.updated_at,
      strictLiveDoc: false,
      guardPathologicalGrowth: true,
    });
    if (!mutation.ok) {
      res.status(mutation.status).json({
        error: mutation.error,
        code: mutation.code,
        ...(mutation.retryWithState ? { retryWithState: mutation.retryWithState } : {}),
      });
      return;
    }
    updatedDoc = mutation.document;
  } else if (hasMarksUpdate) {
    didUpdate = true;
    const previousCanonicalMarks = canonicalizeStoredMarks(parseJson(currentDoc.marks) as Record<string, unknown>);
    writeSucceeded = updateMarks(slug, normalizedMarks ?? {});
    if (writeSucceeded) {
      marksHandledDuringUpdate = true;
      const collabClientBreakdown = getActiveCollabClientBreakdown(slug);
      const preserveLiveRoomOnMarksFallback = collabClientBreakdown.anyEpochCount > 0;
      let syncResult: { applied: boolean; reason?: string } | null = null;
      try {
        syncResult = await syncCanonicalDocumentStateToCollab(slug, {
          marks: normalizedMarks ?? {},
          source: 'rest-put',
        });
      } catch (error) {
        console.error('[routes] Failed to sync marks-only write into collab runtime:', { slug, error });
      }

      if (!syncResult?.applied) {
        const liveRoomAlreadyHasRequestedMarks = loadedCollabMarksMatch(slug, normalizedMarks ?? {});
        const preservedAuthoritativeMarks = syncResult?.reason === 'fragment_unhealthy_marks_only'
          ? await preserveMarksOnlyWriteIfAuthoritativeYjsMatches(slug, normalizedMarks ?? {})
          : false;
        if (preservedAuthoritativeMarks) {
          refreshLoadedCollabMetaFromDb(slug);
        } else {
          if (
            preserveLiveRoomOnMarksFallback
            && syncResult?.reason === 'fragment_unhealthy_marks_only'
            && !liveRoomAlreadyHasRequestedMarks
          ) {
            console.error('[routes] Refused marks-only canonical sync without matching live-authoritative marks', {
              slug,
              reason: syncResult.reason,
            });
          }
          const rolledBack = updateMarks(slug, previousCanonicalMarks);
          if (!rolledBack) {
            console.error('[routes] Failed to roll back marks-only write after collab sync failure', { slug });
          }
          try {
            await invalidateCollabDocumentAndWait(slug);
          } catch (error) {
            console.error('[routes] Failed to fully invalidate collab state after marks-only sync failure', { slug, error });
          }
          collabSyncFailed = true;
          writeSucceeded = false;
        }
      }
    }
  }
  if (hasTitleUpdate) {
    didUpdate = true;
    writeSucceeded = writeSucceeded && updateDocumentTitle(slug, normalizedTitle);
  }
  if (!didUpdate) {
    res.status(400).json({ error: 'Provide title, marks, and/or markdown' });
    return;
  }
  if (!writeSucceeded) {
    if (collabSyncFailed) {
      res.status(503).json({
        error: 'Failed to synchronize marks with collab state; retry with latest state',
        code: 'COLLAB_SYNC_FAILED',
      });
      return;
    }
    res.status(409).json({ error: 'Document changed during update; retry with latest state', code: 'STALE_BASE' });
    return;
  }

  updatedDoc = getDocumentBySlug(slug);
  if (!updatedDoc) {
    res.status(500).json({ error: 'Document update persisted but document could not be reloaded' });
    return;
  }
  const integrity = summarizeDocumentIntegrity(updatedDoc.markdown);
  if (hasMarkdownUpdate) {
    try {
      await rebuildDocumentBlocks(updatedDoc, updatedDoc.markdown, updatedDoc.revision);
    } catch (error) {
      console.error('[routes] Failed to rebuild block index after document update:', { slug, error });
    }
  }
  // Only include fields that were actually updated in the broadcast.
  // This allows receivers to distinguish marks-only updates from full content updates,
  // avoiding unnecessary full document reloads (which reset cursor position).
  const payload: Record<string, unknown> = {
    type: 'document.updated',
    updatedAt: updatedDoc.updated_at,
    actor: mutationActor,
    integrity: {
      revision: updatedDoc.revision,
      ...integrity,
    },
  };
  if (hasMarkdownUpdate) {
    payload.markdown = updatedDoc.markdown;
  }
  if (hasMarksUpdate) {
    payload.marks = parseJson(updatedDoc.marks);
  }
  if (hasTitleUpdate) {
    payload.title = updatedDoc.title;
  }
  payload.shareState = updatedDoc.share_state;

  if (!hasMarkdownUpdate && !marksHandledDuringUpdate) {
    // Marks-only updates still need explicit Yjs synchronization.
    try {
      const collabRuntime = getCollabRuntime();
      if (collabRuntime.enabled && hasMarksUpdate) {
        await applyCanonicalDocumentToCollab(slug, {
          marks: parseJson(updatedDoc.marks),
          source: 'rest-put',
        });
      } else if (hasMarksUpdate) {
        invalidateCollabDocument(slug);
      }
    } catch (error) {
      console.error('[routes] Failed to apply external write into collab runtime:', { slug, error });
      invalidateCollabDocument(slug);
    }
  }

  // Broadcast only after collab propagation attempt so listeners don't race stale runtime state.
  const commentEvents = (hasMarksUpdate && previousMarks)
    ? collectCommentEventsFromMarksDiff(previousMarks, parseJson(updatedDoc.marks), mutationActor)
    : [];
  broadcastToRoom(slug, payload, clientId);
  for (const event of commentEvents) {
    addDocumentEvent(slug, event.type, event.data, event.actor);
  }
  addEvent(slug, 'document.updated', {
    actor: mutationActor,
    source: 'rest-put',
    integrity: {
      revision: updatedDoc.revision,
      ...integrity,
    },
  }, mutationActor);
  if (integrity.repeatedHeadings.length > 0) {
    console.warn('[document.updated.integrity_warning]', {
      slug,
      actor: mutationActor,
      revision: updatedDoc.revision,
      ...integrity,
    });
  }

  refreshSnapshotForSlug(slug);

  res.json({
    success: true,
    shareState: updatedDoc.share_state,
    snapshotUrl: updatedDoc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(updatedDoc.slug) : null,
    updatedAt: updatedDoc.updated_at,
    _links: buildProofSdkLinks(updatedDoc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
    agent: buildProofSdkAgentDescriptor(updatedDoc.slug, {
      includeMutationRoutes: true,
      includeSnapshotRoute: true,
      includeEditV2Route: true,
      includeBridgeRoutes: true,
    }),
  });
});

// Canonical operations endpoint for comments/suggestions/rewrite.
apiRoutes.post('/documents/:slug/ops', opsRateLimiter, async (req: Request, res: Response) => {
  const mutationRoute = 'POST /documents/:slug/ops';
  const slug = getSlugParam(req);
  if (!slug) {
    sendMutationResponse(res, 400, { error: 'Invalid slug' }, { route: mutationRoute });
    return;
  }

  const rawBody = isRecord(req.body) ? req.body : {};
  const parsed = parseDocumentOpRequest(req.body);
  if ('error' in parsed) {
    sendMutationResponse(res, 400, { error: parsed.error }, { route: mutationRoute, slug });
    return;
  }
  const { op, payload } = parsed;
  const participation = maybeBuildAgentParticipation(req, { ...rawBody, ...payload });
  const stage = getMutationContractStage();
  const idempotencyKey = getIdempotencyKey(req);
  const requestHash = hashRequestBody(req.body);
  const routeKey = `${mutationRoute}:${op}`;

  if (isIdempotencyRequired(stage) && !idempotencyKey) {
    sendMutationResponse(res, 409, {
      success: false,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      error: 'Idempotency-Key header is required for mutation requests in this stage',
    }, { route: mutationRoute, slug });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    sendMutationResponse(res, 404, { error: 'Document not found' }, { route: mutationRoute, slug });
    return;
  }

  const accessRole = getAccessRole(req, slug);
  const ownerAuthorized = canOwnerMutate(req, doc);
  const denied = authorizeDocumentOp(op, accessRole, ownerAuthorized, doc.share_state);
  if (denied) {
    const status = denied.includes('revoked') ? 403 : denied.includes('deleted') ? 410 : 403;
    sendMutationResponse(res, status, { success: false, error: denied }, { route: mutationRoute, slug });
    return;
  }

  if (idempotencyKey) {
    const existing = getStoredIdempotencyRecord(slug, routeKey, idempotencyKey);
    if (existing) {
      if (existing.requestHash && existing.requestHash !== requestHash) {
        sendMutationResponse(res, 409, {
          success: false,
          code: 'IDEMPOTENCY_KEY_REUSED',
          error: 'Idempotency key cannot be reused with a different payload',
        }, { route: mutationRoute, slug });
        return;
      }
      sendMutationResponse(res, 200, existing.response, { route: mutationRoute, slug });
      return;
    }
  }

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
      console.warn('[routes] rewrite blocked by live clients', {
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

  const result: EngineExecutionResult = op === 'rewrite.apply'
    ? await executeCanonicalRewrite(slug, opRoute.body) as EngineExecutionResult
    : await executeDocumentOperationAsync(
      slug,
      opRoute.method,
      opRoute.path,
      opRoute.body,
    );

  if (op === 'rewrite.apply' && result.status >= 200 && result.status < 300 && rewriteGate) {
    result.body = annotateRewriteDisruptionMetadata(result.body, rewriteGate);
  }

  if (idempotencyKey && result.status >= 200 && result.status < 300) {
    storeIdempotencyResult(slug, routeKey, idempotencyKey, result.body, requestHash, { statusCode: result.status });
  }

  if (result.status >= 200 && result.status < 300) {
    // Collab mutations for rewrite.apply are committed through the canonical Yjs path.
    // Other ops still need explicit projection sync into the live room.
    if (op !== 'rewrite.apply') {
      try {
        const collabRuntime = getCollabRuntime();
        if (collabRuntime.enabled) {
          const updatedDoc = getDocumentBySlug(slug);
          if (updatedDoc) {
            const applyOptions = {
              markdown: typeof updatedDoc.markdown === 'string' ? updatedDoc.markdown : undefined,
              marks: parseJson(updatedDoc.marks),
              source: 'rest-ops',
            };
            await applyCanonicalDocumentToCollab(slug, applyOptions);

            if (participation) {
              try {
                applyAgentPresenceToLoadedCollab(slug, participation.presenceEntry, {
                  type: 'agent.presence',
                  ...participation.presenceEntry,
                });
                if (participation.cursorQuote) {
                  applyAgentCursorHintToLoadedCollab(slug, {
                    id: String(participation.presenceEntry.id),
                    quote: participation.cursorQuote,
                    ttlMs: 3000,
                    name: typeof participation.presenceEntry.name === 'string' ? participation.presenceEntry.name : undefined,
                    color: typeof participation.presenceEntry.color === 'string' ? participation.presenceEntry.color : undefined,
                    avatar: typeof participation.presenceEntry.avatar === 'string' ? participation.presenceEntry.avatar : undefined,
                  });
                }
              } catch {
                // ignore presence/cursor coupling failures
              }
            }
          } else {
            invalidateCollabDocument(slug);
          }
        } else {
          invalidateCollabDocument(slug);
        }
      } catch (error) {
        console.error('[routes] Failed to apply /ops mutation into collab runtime:', { slug, error });
        invalidateCollabDocument(slug);
      }
    }
    broadcastToRoom(slug, {
      type: 'document.updated',
      source: 'api',
      timestamp: new Date().toISOString(),
    });
  }

  sendMutationResponse(res, result.status, result.body, { route: mutationRoute, slug });
});

// DELETE is an alias for destructive delete.
apiRoutes.delete('/documents/:slug', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to delete document' });
    return;
  }

  deleteDocument(slug);
  revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.deleted', {}, 'owner');
  res.json({ success: true, shareState: 'DELETED', snapshotUrl: getSnapshotPublicUrl(slug) });
});

apiRoutes.post('/documents/:slug/pause', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to pause document' });
    return;
  }
  pauseDocument(slug);
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.paused', {}, 'owner');
  refreshSnapshotForSlug(slug);
  res.json({ success: true, shareState: 'PAUSED', snapshotUrl: null });
});

apiRoutes.post('/documents/:slug/resume', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to resume document' });
    return;
  }
  resumeDocument(slug);
  addEvent(slug, 'document.resumed', {}, 'owner');
  refreshSnapshotForSlug(slug);
  res.json({ success: true, shareState: 'ACTIVE', snapshotUrl: getSnapshotPublicUrl(slug) });
});

apiRoutes.post('/documents/:slug/revoke', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to revoke document' });
    return;
  }
  revokeDocument(slug);
  revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.revoked', {}, 'owner');
  refreshSnapshotForSlug(slug);
  res.json({ success: true, shareState: 'REVOKED', snapshotUrl: null });
});

apiRoutes.post('/documents/:slug/delete', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!canOwnerMutate(req, doc)) {
    res.status(403).json({ error: 'Not authorized to delete document' });
    return;
  }
  deleteDocument(slug);
  revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.deleted', {}, 'owner');
  res.json({ success: true, shareState: 'DELETED', snapshotUrl: null });
});

// Get document info (lightweight, no content)
apiRoutes.get('/documents/:slug/info', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  res.json({
    title: doc.share_state === 'ACTIVE' ? doc.title : null,
    shareState: doc.share_state,
  });
});

apiRoutes.get('/documents/:slug/open-context', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getCanonicalReadableDocumentSync(slug, 'share') ?? getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }

  const access = await resolveOpenContextAccess(req, res, slug, doc);
  if (!access) return;
  if (doc.share_state === 'REVOKED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }
  if (doc.share_state === 'PAUSED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }

  const role = access.role;
  const capabilities = deriveShareCapabilities(role, doc.share_state);
  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) {
    const snapshotUrl = doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null;
    res.json({
      success: true,
      collabAvailable: false,
      snapshotUrl,
      doc: {
        slug: doc.slug,
        docId: doc.doc_id,
        title: doc.title,
        markdown: doc.markdown,
        marks: parseJson(doc.marks),
        shareState: doc.share_state,
        active: doc.share_state === 'ACTIVE',
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        viewers: getRoomSize(doc.slug),
      },
      capabilities,
      links: {
        webUrl: buildShareLink(req, doc.slug).shareUrl,
        snapshotUrl,
      },
      collab: collabRuntime,
    });
    return;
  }

  const session = buildCollabSession(slug, role, {
    tokenId: access.tokenId,
    wsUrlBase: resolveRequestScopedCollabWsBase(req),
  });
  if (!session) {
    res.status(500).json({ error: 'Unable to build collab session' });
    return;
  }

  const links = buildShareLink(req, doc.slug);
  res.json({
    success: true,
    doc: {
      slug: doc.slug,
      docId: doc.doc_id,
      title: doc.title,
      markdown: doc.markdown,
      marks: parseJson(doc.marks),
      shareState: doc.share_state,
      // Legacy compatibility for <=0.28 clients.
      active: doc.share_state === 'ACTIVE',
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      viewers: getRoomSize(doc.slug),
    },
    session,
    capabilities,
    links: {
      webUrl: links.shareUrl,
      snapshotUrl: doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null,
    },
  });
});

apiRoutes.post('/documents/:slug/collab-refresh', async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }

  const access = await resolveOpenContextAccess(req, res, slug, doc);
  if (!access) return;
  if (doc.share_state === 'REVOKED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }
  if (doc.share_state === 'PAUSED' && !access.ownerAuthorized) {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }

  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) {
    res.json({
      collabAvailable: false,
      snapshotUrl: doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null,
    });
    return;
  }

  const role = access.role;
  const session = buildCollabSession(slug, role, {
    tokenId: access.tokenId,
    wsUrlBase: resolveRequestScopedCollabWsBase(req),
  });
  if (!session) {
    res.status(500).json({ error: 'Unable to build collab session' });
    return;
  }
  res.json({
    success: true,
    session,
    capabilities: deriveShareCapabilities(role, doc.share_state),
  });
});

apiRoutes.get('/documents/:slug/collab-session', (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (doc.share_state === 'DELETED') {
    res.status(410).json({ error: 'Document deleted' });
    return;
  }
  if (doc.share_state === 'PAUSED' || doc.share_state === 'REVOKED') {
    const role = getAccessRole(req, slug);
    if (role !== 'owner_bot' && !canOwnerMutate(req, doc)) {
      res.status(403).json({ error: 'Document is not currently accessible' });
      return;
    }
  }

  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) {
    res.json({
      collabAvailable: false,
      snapshotUrl: doc.share_state === 'ACTIVE' ? getSnapshotPublicUrl(doc.slug) : null,
    });
    return;
  }

  const ownerAuthorized = canOwnerMutate(req, doc);
  const presentedSecret = getPresentedSecret(req);
  const access = presentedSecret ? resolveDocumentAccess(slug, presentedSecret) : null;
  const requestedRole = access?.role ?? getAccessRole(req, slug);
  let role: ShareRole = requestedRole ?? 'editor';

  if (ownerAuthorized) {
    role = 'owner_bot';
  }
  if (doc.share_state === 'REVOKED' && role !== 'owner_bot') {
    res.status(403).json({ error: 'Document access has been revoked' });
    return;
  }
  if (doc.share_state === 'PAUSED' && role !== 'owner_bot') {
    res.status(403).json({ error: 'Document is not currently accessible' });
    return;
  }

  const canRead = doc.share_state !== 'DELETED';
  const canEdit = role === 'owner_bot'
    ? (doc.share_state === 'ACTIVE' || doc.share_state === 'PAUSED')
    : (role === 'editor' && doc.share_state === 'ACTIVE');
  const canComment = doc.share_state === 'ACTIVE'
    && (role === 'commenter' || role === 'editor' || role === 'owner_bot');

  const session = buildCollabSession(slug, role, {
    tokenId: access?.tokenId ?? null,
    wsUrlBase: resolveRequestScopedCollabWsBase(req),
  });
  if (!session) {
    res.status(500).json({ error: 'Unable to build collab session' });
    return;
  }

  res.json({
    success: true,
    session,
    capabilities: {
      canRead,
      canComment,
      canEdit,
    },
  });
});
