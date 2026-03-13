import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import {
  countActiveCollabConnections,
  getDocumentAuthStateBySlug,
  getRecentDocumentLiveCollabLeaseBreakdown,
  resolveDocumentAccess,
} from './db.js';
import type { ShareRole } from './share-types.js';
import {
  extractCollabTokenFromHeaders,
  getRecentCollabSessionLeaseCount,
  getCollabSessionClaims,
  handleCollabWebSocketConnection,
  logCollabSocketErrorWithSuppression,
} from './collab-shared.js';

interface Client {
  ws: WebSocket;
  clientId: string;
  slug: string;
  name?: string;
  bridgeCapable: boolean;
  role: ShareRole;
}

type BridgeErrorCode =
  | 'NO_VIEWERS'
  | 'NO_BRIDGE_CAPABLE_VIEWER'
  | 'TIMEOUT'
  | 'VIEWER_DISCONNECTED'
  | 'EXECUTION_ERROR'
  | 'BRIDGE_ERROR';

export interface BridgeError extends Error {
  code: BridgeErrorCode | string;
  status?: number;
  hint?: string;
  nextSteps?: string[];
  viewerUrl?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  [key: string]: unknown;
}

export type ActiveCollabClientBreakdown = {
  slug: string;
  accessEpoch: number | null;
  exactEpochCount: number;
  anyEpochCount: number;
  documentLeaseExactCount: number;
  documentLeaseAnyEpochCount: number;
  recentLeaseCount: number;
  total: number;
};

interface PendingBridgeRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  targetClientId: string;
}

// Map of slug -> Set of connected clients
const rooms = new Map<string, Set<Client>>();
const pendingBridgeRequests = new Map<string, PendingBridgeRequest>();
const ALLOWED_BROADCAST_TYPES = new Set(['cursor.update', 'selection.update']);

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBridgeTimeoutMs(): number {
  return parsePositiveIntEnv('BRIDGE_REQUEST_TIMEOUT_MS', 10_000);
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

function createBridgeError(
  message: string,
  code: BridgeErrorCode | string,
  status?: number,
  details?: Record<string, unknown>
): BridgeError {
  const error = new Error(message) as BridgeError;
  error.code = code;
  if (typeof status === 'number') {
    error.status = status;
  }
  if (details && typeof details === 'object') {
    Object.assign(error, details);
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectPendingForClient(clientId: string): void {
  for (const [requestId, pending] of pendingBridgeRequests) {
    if (pending.targetClientId !== clientId) continue;
    clearTimeout(pending.timer);
    pendingBridgeRequests.delete(requestId);
    pending.reject(createBridgeError('Viewer disconnected', 'VIEWER_DISCONNECTED', 503));
  }
}

export function getActiveCollabClientBreakdown(slug: string): ActiveCollabClientBreakdown {
  const auth = getDocumentAuthStateBySlug(slug);
  const accessEpoch = typeof auth?.access_epoch === 'number' ? auth.access_epoch : null;
  const exactEpochCount = countActiveCollabConnections(slug, accessEpoch);
  // Hosted safety gates should conservatively block if any authenticated collab
  // session for the slug is still live, even when the current access epoch has
  // just rolled and stale clients have not reconnected yet.
  const anyEpochCount = exactEpochCount > 0
    ? exactEpochCount
    : countActiveCollabConnections(slug, null);
  const documentLeaseBreakdown = getRecentDocumentLiveCollabLeaseBreakdown(slug, accessEpoch);
  const recentLeaseCount = getRecentCollabSessionLeaseCount(slug, accessEpoch);
  return {
    slug,
    accessEpoch,
    exactEpochCount,
    anyEpochCount,
    documentLeaseExactCount: documentLeaseBreakdown.exactEpochCount,
    documentLeaseAnyEpochCount: documentLeaseBreakdown.anyEpochCount,
    recentLeaseCount,
    total: Math.max(anyEpochCount, documentLeaseBreakdown.anyEpochCount, recentLeaseCount),
  };
}

export function getActiveCollabClientCount(slug: string): number {
  return getActiveCollabClientBreakdown(slug).total;
}

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const isCollabConnection = url.searchParams.get('collab') === '1' || url.searchParams.has('role');
    const collabToken = url.searchParams.get('token') || extractCollabTokenFromHeaders(req.headers);
    const slug = url.searchParams.get('slug');
    let bridgeClientId: string | null = null;

    ws.on('error', (error) => {
      logCollabSocketErrorWithSuppression(req, isCollabConnection ? 'ws-router' : 'ws-server', error);
      const summary = summarizeWsError(error);
      if (!(summary.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
        || summary.statusCode === 1009
        || String(summary.message || '').toLowerCase().includes('max payload size exceeded'))) {
        console.error('[ws] socket error', {
          mode: isCollabConnection ? 'collab' : 'bridge',
          slug,
          clientId: bridgeClientId,
          code: summary.code,
          statusCode: summary.statusCode,
          message: summary.message,
        });
      }
      if (bridgeClientId) {
        rejectPendingForClient(bridgeClientId);
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    });

    // Collab connections are multiplexed on `/ws` (Railway edge constraint).
    // HocuspocusProvider appends `token`/`role` as query params, so we can
    // reliably detect collab via `role` without requiring a pre-existing query.
    if (isCollabConnection) {
      // Some clients provide token/query upfront while others provide auth via
      // runtime hooks. Validate pre-gate token when present, but don't require
      // it at the router layer.
      if (collabToken) {
        const claims = getCollabSessionClaims(collabToken);
        if (!claims) {
          ws.close(4401, 'Invalid or expired collab session token');
          return;
        }
        if (slug && slug !== claims.slug) {
          ws.close(4401, 'Collab token slug mismatch');
          return;
        }
        const doc = getDocumentAuthStateBySlug(claims.slug);
        const accessEpoch = typeof doc?.access_epoch === 'number' ? doc.access_epoch : null;
        const shareState = doc?.share_state ?? null;
        const collabRole = claims.role;
        const accessEpochMatches = accessEpoch === null || claims.accessEpoch === accessEpoch;
        const sessionAllowed = Boolean(doc)
          && shareState !== 'DELETED'
          && accessEpochMatches
          && !((shareState === 'REVOKED' || shareState === 'PAUSED') && collabRole !== 'owner_bot');
        if (!sessionAllowed) {
          ws.close(4401, 'Invalid or expired collab session token');
          return;
        }
      }
      try {
        handleCollabWebSocketConnection(ws, req);
      } catch {
        try { ws.close(1011, 'Collab runtime failed'); } catch { /* ignore */ }
      }
      return;
    }
    const token = url.searchParams.get('token') || '';

    if (!slug) {
      ws.close(4000, 'Missing slug parameter');
      return;
    }
    if (!token) {
      ws.close(4001, 'Missing authentication token');
      return;
    }
    const access = resolveDocumentAccess(slug, token);
    if (!access) {
      ws.close(4003, 'Invalid or expired token');
      return;
    }

    const clientId = crypto.randomUUID();
    bridgeClientId = clientId;
    const client: Client = {
      ws,
      clientId,
      slug,
      bridgeCapable: false,
      role: access.role,
    };

    if (!rooms.has(slug)) {
      rooms.set(slug, new Set());
    }
    rooms.get(slug)!.add(client);

    ws.send(JSON.stringify({
      type: 'connected',
      clientId,
      slug,
    }));

    broadcastViewerList(slug);

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (!isRecord(message)) return;
        handleMessage(client, message);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      rejectPendingForClient(client.clientId);
      const room = rooms.get(slug);
      if (room) {
        room.delete(client);
        if (room.size === 0) {
          rooms.delete(slug);
        } else {
          broadcastViewerList(slug);
        }
      }
    });
  });
}

function handleMessage(sender: Client, message: Record<string, unknown>): void {
  if (message.type === 'bridge.response') {
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;
    if (!requestId) return;
    const pending = pendingBridgeRequests.get(requestId);
    if (!pending) return;
    if (pending.targetClientId !== sender.clientId) return;

    clearTimeout(pending.timer);
    pendingBridgeRequests.delete(requestId);

    if (message.ok === false) {
      const errorPayload = isRecord(message.error) ? message.error : {};
      const errorCode = typeof errorPayload.code === 'string'
        ? errorPayload.code
        : 'EXECUTION_ERROR';
      const errorMessage = typeof errorPayload.message === 'string'
        ? errorPayload.message
        : 'Bridge execution failed';
      const status = typeof errorPayload.status === 'number'
        ? errorPayload.status
        : undefined;
      pending.reject(createBridgeError(errorMessage, errorCode, status, errorPayload));
      return;
    }

    pending.resolve(message.result);
    return;
  }

  // Handle viewer identification
  if (message.type === 'viewer.identify') {
    sender.name = typeof message.name === 'string' && message.name.trim()
      ? message.name
      : 'Anonymous';
    const capabilities = isRecord(message.capabilities) ? message.capabilities : {};
    sender.bridgeCapable = capabilities.bridge === true;
    broadcastViewerList(sender.slug);
    return;
  }

  // Broadcast to all other clients in the same room
  const messageType = typeof message.type === 'string' ? message.type : '';
  if (!ALLOWED_BROADCAST_TYPES.has(messageType)) return;
  broadcastToRoom(sender.slug, message, sender.clientId);
}

function broadcastViewerList(slug: string): void {
  const room = rooms.get(slug);
  if (!room) return;

  const viewers = Array.from(room).map((client) => ({
    clientId: client.clientId,
    name: client.name || 'Anonymous',
  }));

  const payload = JSON.stringify({
    type: 'viewers.updated',
    viewers,
    count: viewers.length,
  });

  for (const client of room) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

export function sendBridgeRequest(
  slug: string,
  method: string,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const room = rooms.get(slug);
  if (!room || room.size === 0) {
    return Promise.reject(createBridgeError('No active viewer', 'NO_VIEWERS', 503));
  }

  const candidates = Array.from(room).filter((client) =>
    client.ws.readyState === WebSocket.OPEN && client.bridgeCapable
  );

  if (candidates.length === 0) {
    return Promise.reject(createBridgeError('No bridge-capable viewer', 'NO_BRIDGE_CAPABLE_VIEWER', 503));
  }

  // Prefer the most recently connected bridge-capable viewer first.
  candidates.reverse();

  return (async () => {
    let lastError: unknown = null;

    for (let index = 0; index < candidates.length; index += 1) {
      const target = candidates[index]!;
      try {
        return await sendBridgeRequestToClient(target, method, path, body);
      } catch (error) {
        lastError = error;
        const shouldRetry = isRetryableBridgeFailure(error);
        const hasNextCandidate = index < candidates.length - 1;
        if (shouldRetry && hasNextCandidate) {
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? createBridgeError('Bridge request failed', 'BRIDGE_ERROR', 503);
  })();
}

function isRetryableBridgeFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (typeof error.code !== 'string') return false;
  return error.code === 'EXECUTION_ERROR'
    || error.code === 'VIEWER_DISCONNECTED'
    || error.code === 'TIMEOUT';
}

function sendBridgeRequestToClient(
  target: Client,
  method: string,
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeoutMs = getBridgeTimeoutMs();
    const timer = setTimeout(() => {
      pendingBridgeRequests.delete(requestId);
      reject(createBridgeError('Browser did not respond in time', 'TIMEOUT', 504, { timeoutMs }));
    }, timeoutMs);

    pendingBridgeRequests.set(requestId, {
      resolve,
      reject,
      timer,
      targetClientId: target.clientId,
    });

    try {
      target.ws.send(JSON.stringify({
        type: 'bridge.request',
        requestId,
        method,
        path,
        body,
      }));
    } catch (error) {
      clearTimeout(timer);
      pendingBridgeRequests.delete(requestId);
      const message = error instanceof Error ? error.message : String(error);
      reject(createBridgeError(message || 'Failed to send bridge request', 'VIEWER_DISCONNECTED', 503));
    }
  });
}

export function broadcastToRoom(slug: string, message: Record<string, unknown>, excludeClientId?: string): void {
  const room = rooms.get(slug);
  if (!room) return;

  const payload = JSON.stringify(message);

  for (const client of room) {
    if (client.clientId === excludeClientId) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

export function closeRoom(slug: string): void {
  const room = rooms.get(slug);
  if (!room) return;

  for (const client of room) {
    rejectPendingForClient(client.clientId);
    client.ws.close(4001, 'Document unshared');
  }
  rooms.delete(slug);
}

export function getRoomSize(slug: string): number {
  return rooms.get(slug)?.size || 0;
}
