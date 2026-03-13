import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  bumpDocumentAccessEpoch,
  getDocument,
  getDocumentBySlug,
  resolveDocumentAccessRole,
} from './db.js';
import { executeDocumentOperationAsync } from '../../../server/document-engine.js';
import { executeCanonicalRewrite } from '../../../server/canonical-document.js';
import {
  applyCanonicalDocumentToCollab,
  getCollabRuntime,
  invalidateCollabDocument,
  invalidateCollabDocumentAndWait,
} from '../../../server/collab.js';
import { broadcastToRoom, sendBridgeRequest, type BridgeError } from './ws.js';
import { findBridgeRoutePolicy, getBridgeRoutePolicies, type BridgeRoutePolicy } from './bridge-auth-policy.js';
import { validateRewriteApplyPayload } from './rewrite-validation.js';
import {
  recordRewriteBarrierFailure,
  recordRewriteBarrierLatency,
  recordRewriteForceIgnored,
  recordRewriteLiveClientBlock,
} from './metrics.js';
import {
  annotateRewriteDisruptionMetadata,
  classifyRewriteBarrierFailureReason,
  evaluateRewriteLiveClientGate,
  rewriteBarrierFailedResponseBody,
  rewriteBlockedResponseBody,
} from './rewrite-policy.js';
import { canonicalizeStoredMarks, type StoredMark } from '@proof/core/marks';

export const bridgeRouter = Router({ mergeParams: true });

export function createBridgeRouter(): Router {
  return bridgeRouter;
}

export function createBridgeMountRouter(middleware?: RequestHandler): Router {
  const router = Router({ mergeParams: true });
  if (middleware) {
    router.use('/:slug/bridge', middleware, bridgeRouter);
  } else {
    router.use('/:slug/bridge', bridgeRouter);
  }
  return router;
}
const AUTHLESS_RATE_LIMIT_PER_MIN = 60;
const AUTHED_RATE_LIMIT_PER_MIN = 240;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_BUCKETS = 10_000;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const REWRITE_BARRIER_TIMEOUT_MS = parsePositiveIntEnv('PROOF_REWRITE_BARRIER_TIMEOUT_MS', 5000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trustProxyHeaders(): boolean {
  const value = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function getRateLimitConfig(auth: 'none' | 'bridge-token'): { max: number; windowMs: number } {
  const max = auth === 'none'
    ? parsePositiveIntEnv('BRIDGE_RATE_LIMIT_MAX_UNAUTH_PER_MIN', AUTHLESS_RATE_LIMIT_PER_MIN)
    : parsePositiveIntEnv('BRIDGE_RATE_LIMIT_MAX_AUTH_PER_MIN', AUTHED_RATE_LIMIT_PER_MIN);
  const windowMs = parsePositiveIntEnv('BRIDGE_RATE_LIMIT_WINDOW_MS', RATE_LIMIT_WINDOW_MS);
  return { max, windowMs };
}

function pruneRateLimitBuckets(now: number): void {
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
  if (rateLimitBuckets.size <= RATE_LIMIT_MAX_BUCKETS) return;
  const overflow = rateLimitBuckets.size - RATE_LIMIT_MAX_BUCKETS;
  let removed = 0;
  for (const key of rateLimitBuckets.keys()) {
    rateLimitBuckets.delete(key);
    removed += 1;
    if (removed >= overflow) break;
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

function getSlugParam(req: Request): string | null {
  const raw = req.params.slug;
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0];
  const urlCandidates = [req.originalUrl, `${req.baseUrl || ''}${req.path || ''}`];
  for (const candidate of urlCandidates) {
    const match = candidate.match(/\/(?:documents|d)\/([^/]+)\/bridge(?:\/|$)/);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

function getBridgeToken(req: Request): string | null {
  const headerToken = req.header('x-bridge-token');
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  const authHeader = req.header('authorization');
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function getErrorStatus(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

function getErrorExtras(error: unknown): Record<string, unknown> {
  if (!isRecord(error)) return {};
  const keys = [
    'hint',
    'hints',
    'nextSteps',
    'invalidIndexes',
    'missingIndexes',
    'viewerUrl',
    'retryable',
    'retryAfterSeconds',
    'timeoutMs',
    'supportedRoutes',
    'didYouMean',
    'requestedRoute',
  ] as const;
  const extras: Record<string, unknown> = {};
  for (const key of keys) {
    if (error[key] !== undefined) {
      extras[key] = error[key];
    }
  }
  return extras;
}

function buildUnknownRouteResponse(method: string, bridgePath: string): Record<string, unknown> {
  const supportedRoutes = getBridgeRoutePolicies().map((policy) => `${policy.method} ${policy.path}`);
  const methodMatch = getBridgeRoutePolicies().find((policy) => policy.path === bridgePath);
  const pathMatch = getBridgeRoutePolicies().find((policy) => policy.method === method && policy.path.startsWith(bridgePath));
  const didYouMean = methodMatch
    ? `${methodMatch.method} ${methodMatch.path}`
    : pathMatch
      ? `${pathMatch.method} ${pathMatch.path}`
      : undefined;

  return {
    error: `Unknown bridge route: ${method} ${bridgePath}`,
    code: 'UNKNOWN_ROUTE',
    requestedRoute: `${method} ${bridgePath}`,
    hint: didYouMean
      ? `Try ${didYouMean}.`
      : 'Use one of the supported bridge routes.',
    didYouMean,
    supportedRoutes,
  };
}

function buildValidationError(
  method: string,
  bridgePath: string,
  message: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    error: message,
    code: 'VALIDATION_ERROR',
    route: `${method} ${bridgePath}`,
    ...extra,
  };

  if (bridgePath === '/rewrite') {
    payload.hint = 'Send either {"content":"..."} or {"changes":[{"find":"...","replace":"..."}]} (not both), plus baseRevision/expectedRevision.';
    payload.nextSteps = [
      'Fetch /state and use the current markdown as your rewrite source.',
      'Include expectedRevision (or baseRevision) from /state.revision.',
      'For targeted edits, send changes with non-empty "find" and string "replace".',
      'Retry /rewrite with a corrected payload.',
    ];
    return payload;
  }

  if (bridgePath === '/marks/comment' || bridgePath === '/comments') {
    payload.hint = 'Provide "quote" text or a structured "selector" object to anchor the comment.';
    payload.nextSteps = [
      'Fetch /state or /marks to locate the target text.',
      'Send either quote or selector along with by/text.',
      'Retry the same endpoint.',
    ];
  }

  return payload;
}

function buildUnauthorizedResponse(req: Request, slug: string): Record<string, unknown> {
  const viewerUrl = `${req.protocol}://${req.get('host')}/d/${slug}`;
  return {
    error: 'Missing or invalid bridge token',
    code: 'UNAUTHORIZED',
    hint: 'This protected endpoint requires the document owner bridge token.',
    acceptedHeaders: [
      'x-bridge-token: <OWNER_SECRET>',
      'Authorization: Bearer <OWNER_SECRET>',
    ],
    viewerUrl,
    nextSteps: [
      'Get the document owner token from the sharing flow.',
      'Attach it via x-bridge-token or Authorization Bearer.',
      'Retry the same bridge request.',
    ],
  };
}

function buildNoViewerResponse(req: Request, slug: string, code: string): Record<string, unknown> {
  const viewerUrl = `${req.protocol}://${req.get('host')}/d/${slug}`;
  if (code === 'NO_BRIDGE_CAPABLE_VIEWER') {
    return {
      error: 'No bridge-capable viewer for this document',
      hint: `A viewer is connected at ${viewerUrl}, but bridge messaging is not ready. Refresh that tab or open the URL in a current build, then retry.`,
      viewerUrl,
      nextSteps: [
        'Refresh the open document tab to reinitialize bridge capabilities.',
        'If needed, open the viewer URL in another browser tab.',
        'Retry the same bridge request once the viewer reconnects.',
      ],
      code,
    };
  }
  return {
    error: 'No active viewer for this document',
    hint: `No browser tab is connected for this doc. Open ${viewerUrl} yourself (recommended), or ask the user to open it, then retry.`,
    viewerUrl,
    nextSteps: [
      'Open the viewer URL directly if you can launch a browser.',
      'If you cannot open it, ask the user to open the URL.',
      'Retry the same bridge request once the viewer is connected.',
    ],
    code,
  };
}

function buildTimeoutResponse(req: Request, slug: string, timeoutMs?: number): Record<string, unknown> {
  const viewerUrl = `${req.protocol}://${req.get('host')}/d/${slug}`;
  return {
    error: 'Browser did not respond in time',
    code: 'TIMEOUT',
    hint: `The connected viewer did not complete the bridge request within ${Math.round((timeoutMs ?? 10_000) / 1000)}s.`,
    viewerUrl,
    retryable: true,
    timeoutMs,
    nextSteps: [
      'Check that the target tab is still open and responsive.',
      'Refresh the viewer tab if it appears stuck.',
      'Retry the same request.',
    ],
  };
}

function checkRateLimit(
  req: Request,
  slug: string,
  policy: BridgeRoutePolicy
): { allowed: true } | { allowed: false; retryAfterSeconds: number; max: number; windowMs: number } {
  const { max, windowMs } = getRateLimitConfig(policy.auth);
  const now = Date.now();
  pruneRateLimitBuckets(now);
  const key = `${slug}:${getClientIp(req)}:${policy.auth}`;
  const existing = rateLimitBuckets.get(key);

  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
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
  rateLimitBuckets.set(key, existing);
  return { allowed: true };
}

function normalizeBridgeMutationPath(
  method: string,
  bridgePath: string,
  body: Record<string, unknown>,
): string {
  if (method !== 'POST') return bridgePath;
  if (bridgePath === '/comments') return '/marks/comment';
  if (bridgePath === '/comments/reply') return '/marks/reply';
  if (bridgePath === '/comments/resolve') return '/marks/resolve';
  if (bridgePath !== '/suggestions') return bridgePath;

  const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  if (kind === 'insert') return '/marks/suggest-insert';
  if (kind === 'delete') return '/marks/suggest-delete';
  if (kind === 'replace') return '/marks/suggest-replace';
  return bridgePath;
}

function validateRoutePayload(
  method: string,
  bridgePath: string,
  body: Record<string, unknown>
): Record<string, unknown> | null {
  if (method === 'POST' && (bridgePath === '/marks/comment' || bridgePath === '/comments')) {
    const hasQuote = typeof body.quote === 'string' && body.quote.trim().length > 0;
    const hasSelector = isRecord(body.selector) && Object.keys(body.selector).length > 0;
    if (!hasQuote && !hasSelector) {
      return buildValidationError(method, bridgePath, 'Missing required field: quote or selector');
    }
  }

  if (method === 'POST' && bridgePath === '/rewrite') {
    const hasDirectContent = typeof body.content === 'string';
    const hasChanges = Array.isArray(body.changes);
    if (!hasDirectContent && !hasChanges) {
      return buildValidationError(method, bridgePath, 'Missing content parameter');
    }
    if (hasDirectContent && hasChanges) {
      return buildValidationError(method, bridgePath, 'Provide either content or changes, not both');
    }
    if (hasChanges) {
      const changes = body.changes as unknown[];
      const invalidIndexes: number[] = [];
      for (let i = 0; i < changes.length; i += 1) {
        const change = changes[i];
        const changeObj = isRecord(change) ? change : {};
        const find = typeof changeObj.find === 'string' ? changeObj.find : null;
        const replace = typeof changeObj.replace === 'string' ? changeObj.replace : null;
        if (!find || replace === null) {
          invalidIndexes.push(i);
        }
      }
      if (invalidIndexes.length > 0) {
        return buildValidationError(
          method,
          bridgePath,
          'Each /rewrite change requires non-empty string fields "find" and "replace".',
          { invalidIndexes }
        );
      }
    }
  }

  return null;
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

async function prepareRewriteCollabBarrier(slug: string): Promise<void> {
  const collabRuntime = getCollabRuntime();
  if (!collabRuntime.enabled) return;
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
    console.error('[bridge] Failed to prepare rewrite collab barrier:', { slug, error });
    invalidateCollabDocument(slug);
    throw error;
  }
}

bridgeRouter.use(async (req: Request, res: Response) => {
  const slug = getSlugParam(req);
  if (!slug) {
    res.status(400).json({ error: 'Invalid slug' });
    return;
  }

  const bridgePath = req.path || '/';
  const method = req.method.toUpperCase();
  const policy = findBridgeRoutePolicy(method, bridgePath);
  if (!policy) {
    res.status(404).json(buildUnknownRouteResponse(method, bridgePath));
    return;
  }

  const rateLimit = checkRateLimit(req, slug, policy);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({
      error: 'Rate limit exceeded for bridge requests',
      code: 'RATE_LIMITED',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      retryable: true,
      hint: `Too many requests for this document. Retry in about ${rateLimit.retryAfterSeconds}s.`,
      nextSteps: [
        'Back off and retry after the reported delay.',
        'Batch bridge operations to reduce request volume.',
        'If this persists, reduce polling frequency on unauthenticated reads.',
      ],
      limit: {
        maxRequests: rateLimit.max,
        windowMs: rateLimit.windowMs,
      },
    });
    return;
  }

  const requestBody = isRecord(req.body) ? { ...req.body } : {};
  const canonicalBridgePath = normalizeBridgeMutationPath(method, bridgePath, requestBody);
  for (const field of policy.required ?? []) {
    if (requestBody[field] === undefined) {
      res.status(400).json(buildValidationError(method, bridgePath, `Missing required field: ${field}`));
      return;
    }
  }

  const payloadValidation = validateRoutePayload(method, bridgePath, requestBody);
  if (payloadValidation) {
    res.status(400).json(payloadValidation);
    return;
  }

  if (method === 'POST' && canonicalBridgePath === '/rewrite') {
    const rewriteValidationError = validateRewriteApplyPayload(requestBody);
    if (rewriteValidationError) {
      res.status(400).json(buildValidationError(method, bridgePath, rewriteValidationError));
      return;
    }
    const rewriteGate = evaluateRewriteLiveClientGate(slug, requestBody);
    if (rewriteGate.blocked) {
      recordRewriteLiveClientBlock(
        'POST /d/:slug/bridge/rewrite',
        rewriteGate.runtimeEnvironment,
        rewriteGate.forceRequested,
        rewriteGate.forceIgnored,
      );
      if (rewriteGate.forceIgnored) {
        recordRewriteForceIgnored('POST /d/:slug/bridge/rewrite', rewriteGate.runtimeEnvironment);
      }
      console.warn('[bridge] rewrite blocked by live clients', {
        slug,
        route: 'POST /d/:slug/bridge/rewrite',
        connectedClients: rewriteGate.connectedClients,
        forceRequested: rewriteGate.forceRequested,
        forceHonored: rewriteGate.forceHonored,
        forceIgnored: rewriteGate.forceIgnored,
        runtimeEnvironment: rewriteGate.runtimeEnvironment,
      });
      res.status(409).json({
        ...rewriteBlockedResponseBody(rewriteGate, slug),
        execution: 'server',
      });
      return;
    }
    const barrierStartedAt = Date.now();
    try {
      await prepareRewriteCollabBarrier(slug);
      recordRewriteBarrierLatency('POST /d/:slug/bridge/rewrite', Date.now() - barrierStartedAt);
    } catch (error) {
      const reason = classifyRewriteBarrierFailureReason(error);
      recordRewriteBarrierFailure('POST /d/:slug/bridge/rewrite', reason);
      recordRewriteBarrierLatency('POST /d/:slug/bridge/rewrite', Date.now() - barrierStartedAt);
      res.status(503).json({
        ...rewriteBarrierFailedResponseBody(slug, reason),
        execution: 'server',
      });
      return;
    }
  }

  if (policy.auth === 'bridge-token') {
    const doc = getDocument(slug);
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const token = getBridgeToken(req);
    const role = token ? resolveDocumentAccessRole(slug, token) : null;
    if (role !== 'owner_bot') {
      res.status(401).json(buildUnauthorizedResponse(req, slug));
      return;
    }
  }

  const agentId = req.header('x-agent-id');
  if (typeof agentId === 'string' && agentId.trim()) {
    requestBody.__agentId = agentId.trim();
  }

  const serverResult = method === 'POST' && canonicalBridgePath === '/rewrite'
    ? await executeCanonicalRewrite(slug, requestBody)
    : await executeDocumentOperationAsync(slug, method, canonicalBridgePath, requestBody);
  if (method === 'POST' && canonicalBridgePath === '/rewrite' && serverResult.status >= 200 && serverResult.status < 300) {
    const rewriteGate = evaluateRewriteLiveClientGate(slug, requestBody);
    serverResult.body = annotateRewriteDisruptionMetadata(serverResult.body, rewriteGate);
  }
  if (serverResult.status !== 404) {
    if (serverResult.status >= 200 && serverResult.status < 300 && method === 'POST') {
      if (canonicalBridgePath !== '/rewrite') {
        try {
          const collabRuntime = getCollabRuntime();
          if (collabRuntime.enabled) {
            const updatedDoc = getDocumentBySlug(slug);
            if (updatedDoc) {
              const applyOptions = {
                markdown: typeof updatedDoc.markdown === 'string' ? updatedDoc.markdown : undefined,
                marks: parseCanonicalMarks(updatedDoc.marks),
                source: 'bridge',
              };
              await applyCanonicalDocumentToCollab(slug, applyOptions);
            } else {
              invalidateCollabDocument(slug);
            }
          } else {
            invalidateCollabDocument(slug);
          }
        } catch (error) {
          console.error('[bridge] Failed to apply server bridge mutation into collab runtime:', { slug, error });
          invalidateCollabDocument(slug);
        }
      }
      broadcastToRoom(slug, {
        type: 'document.updated',
        source: 'bridge',
        timestamp: new Date().toISOString(),
      });
    }
    res.setHeader('x-proof-bridge-execution', 'server');
    res.status(serverResult.status).json({
      ...serverResult.body,
      execution: 'server',
    });
    return;
  }

  try {
    const result = await sendBridgeRequest(
      slug,
      method,
      bridgePath,
      requestBody,
    );
    res.setHeader('x-proof-bridge-execution', 'viewer');
    res.json(result);
  } catch (error) {
    const bridgeError = error as BridgeError;
    const code = getErrorCode(bridgeError);
    if (code === 'NO_VIEWERS' || code === 'VIEWER_DISCONNECTED' || code === 'NO_BRIDGE_CAPABLE_VIEWER') {
      res.status(503).json(buildNoViewerResponse(req, slug, code));
      return;
    }
    if (code === 'TIMEOUT') {
      const timeoutMs = isRecord(bridgeError) && typeof bridgeError.timeoutMs === 'number'
        ? bridgeError.timeoutMs
        : undefined;
      res.status(504).json(buildTimeoutResponse(req, slug, timeoutMs));
      return;
    }

    const extras = getErrorExtras(bridgeError);
    const status = getErrorStatus(bridgeError);
    if (typeof status === 'number' && status >= 400 && status <= 499) {
      res.status(status).json({
        error: getErrorMessage(bridgeError, 'Bridge request failed'),
        code: code ?? 'BRIDGE_ERROR',
        ...extras,
      });
      return;
    }

    res.status(500).json({
      error: getErrorMessage(bridgeError, 'Bridge request failed'),
      code: code ?? 'BRIDGE_ERROR',
      ...extras,
    });
  }
});
