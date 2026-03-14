import type { Request, Response } from 'express';
import { getCurrentRequestId, getRequestStartedAtMs, readRequestId } from './request-context.js';

export type IncidentTraceLevel = 'info' | 'warn' | 'error';

export type IncidentTraceInput = {
  timestamp?: string;
  requestId?: string | null;
  slug?: string | null;
  subsystem: string;
  level: IncidentTraceLevel;
  eventType: string;
  message: string;
  data?: Record<string, unknown> | null;
};

type IncidentTraceEntry = Required<Omit<IncidentTraceInput, 'data'>> & {
  data: Record<string, unknown>;
};

const INCIDENT_TRACE_BUFFER_LIMIT = 200;
const incidentTraceBuffer: IncidentTraceEntry[] = [];

function normalizeTraceValue(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= 4) {
    if (typeof value === 'string') return value.slice(0, 400);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return String(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: typeof value.stack === 'string' ? value.stack.split('\n').slice(0, 6).join('\n') : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => normalizeTraceValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      normalized[key] = normalizeTraceValue(entry, depth + 1);
    }
    return normalized;
  }
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function appendIncidentTrace(entry: IncidentTraceEntry): void {
  incidentTraceBuffer.push(entry);
  if (incidentTraceBuffer.length > INCIDENT_TRACE_BUFFER_LIMIT) {
    incidentTraceBuffer.splice(0, incidentTraceBuffer.length - INCIDENT_TRACE_BUFFER_LIMIT);
  }
}

export function getRecentIncidentTraceEntries(limit: number = 50): IncidentTraceEntry[] {
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 50;
  return incidentTraceBuffer.slice(-normalizedLimit);
}

export function clearIncidentTraceEntries(): void {
  incidentTraceBuffer.length = 0;
}

export function toErrorTraceData(error: unknown): Record<string, unknown> {
  return {
    error: normalizeTraceValue(error),
  };
}

export function traceServerIncident(input: IncidentTraceInput): void {
  appendIncidentTrace({
    timestamp: input.timestamp ?? new Date().toISOString(),
    requestId: input.requestId ?? getCurrentRequestId(),
    slug: input.slug ?? null,
    subsystem: input.subsystem,
    level: input.level,
    eventType: input.eventType,
    message: input.message,
    data: (normalizeTraceValue(input.data ?? {}) as Record<string, unknown>) ?? {},
  });
}

export function traceRequestStarted(req: Request): void {
  traceServerIncident({
    requestId: readRequestId(req),
    subsystem: 'http',
    level: 'info',
    eventType: 'request.started',
    message: `${req.method.toUpperCase()} ${req.originalUrl || req.url || req.path || '/'}`,
    data: {
      method: req.method.toUpperCase(),
      path: req.originalUrl || req.url || req.path || '/',
      ip: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.header('user-agent') || null,
    },
  });
}

export function traceRequestFinished(req: Request, res: Response): void {
  const startedAtMs = getRequestStartedAtMs(res);
  const durationMs = typeof startedAtMs === 'number' ? Math.max(0, Date.now() - startedAtMs) : null;
  const level: IncidentTraceLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
  traceServerIncident({
    requestId: readRequestId(req),
    subsystem: 'http',
    level,
    eventType: 'request.finished',
    message: `${req.method.toUpperCase()} ${req.originalUrl || req.url || req.path || '/'} -> ${res.statusCode}`,
    data: {
      method: req.method.toUpperCase(),
      path: req.originalUrl || req.url || req.path || '/',
      statusCode: res.statusCode,
      durationMs,
    },
  });
}
