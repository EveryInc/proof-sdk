import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export type RequestContext = {
  requestId: string;
  method: string;
  path: string;
  startedAt: string;
  startedAtMs: number;
};

type MutableRequest = Request & { proofRequestId?: string };
type MutableLocals = {
  proofRequestId?: string;
  proofRequestStartedAtMs?: number;
};

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_RESPONSE_HEADER = 'X-Request-Id';
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

function normalizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

export function getRequestContext(): RequestContext | null {
  return requestContextStorage.getStore() ?? null;
}

export function getCurrentRequestId(): string | null {
  return getRequestContext()?.requestId ?? null;
}

export function readRequestId(req: Request): string | null {
  const attached = normalizeRequestId((req as MutableRequest).proofRequestId);
  if (attached) return attached;
  return normalizeRequestId(req.header(REQUEST_ID_HEADER));
}

export function getRequestStartedAtMs(res: Response): number | null {
  const value = (res.locals as MutableLocals | undefined)?.proofRequestStartedAtMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = readRequestId(req) ?? randomUUID();
  const startedAtMs = Date.now();
  const context: RequestContext = {
    requestId,
    method: req.method.toUpperCase(),
    path: req.originalUrl || req.url || req.path || '/',
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
  };

  (req as MutableRequest).proofRequestId = requestId;
  (res.locals as MutableLocals).proofRequestId = requestId;
  (res.locals as MutableLocals).proofRequestStartedAtMs = startedAtMs;
  res.setHeader(REQUEST_ID_RESPONSE_HEADER, requestId);

  requestContextStorage.run(context, () => next());
}
