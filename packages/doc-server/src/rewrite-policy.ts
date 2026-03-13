import { getActiveCollabClientBreakdown } from './ws.js';

export type RewriteLiveClientGate = {
  connectedClients: number;
  accessEpoch: number | null;
  exactEpochCount: number;
  anyEpochCount: number;
  documentLeaseExactCount: number;
  documentLeaseAnyEpochCount: number;
  recentLeaseCount: number;
  force: boolean;
  forceRequested: boolean;
  forceHonored: boolean;
  forceIgnored: boolean;
  conservativeHostedBlock: boolean;
  hostedRuntime: boolean;
  runtimeEnvironment: string;
  blocked: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
}

export function parseRewriteForceFlag(body: unknown): boolean {
  const payload = asRecord(body);
  const raw = payload.force;
  if (raw === true) return true;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function normalizeEnvironment(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return 'development';
  if (normalized === 'prod' || normalized === 'production') return 'production';
  if (normalized === 'stage' || normalized === 'staging') return 'staging';
  if (normalized === 'dev' || normalized === 'development' || normalized === 'local') return 'development';
  if (normalized === 'test' || normalized === 'testing') return 'test';
  return normalized;
}

function isRailwayHostedRuntime(): boolean {
  return Boolean(
    (process.env.RAILWAY_GIT_COMMIT_SHA || '').trim()
    || (process.env.RAILWAY_ENVIRONMENT || '').trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME || '').trim()
    || (process.env.RAILWAY_PROJECT_ID || '').trim()
    || (process.env.RAILWAY_SERVICE_ID || '').trim()
    || (process.env.RAILWAY_DEPLOYMENT_ID || '').trim()
    || (process.env.RAILWAY_REPLICA_ID || '').trim()
    || (process.env.RAILWAY_STATIC_URL || '').trim(),
  );
}

export function getRewriteRuntimeEnvironment(): string {
  const explicit = normalizeEnvironment(process.env.PROOF_ENV || process.env.NODE_ENV);
  if (explicit !== 'development') return explicit;
  if (isRailwayHostedRuntime()) {
    return normalizeEnvironment(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || 'production');
  }
  return explicit;
}

export function isHostedRewriteEnvironment(runtimeEnvironment: string = getRewriteRuntimeEnvironment()): boolean {
  return runtimeEnvironment === 'production' || runtimeEnvironment === 'staging' || isRailwayHostedRuntime();
}

export function evaluateRewriteLiveClientGate(slug: string, body: unknown): RewriteLiveClientGate {
  const forceRequested = parseRewriteForceFlag(body);
  const runtimeEnvironment = getRewriteRuntimeEnvironment();
  const hostedRuntime = isHostedRewriteEnvironment(runtimeEnvironment);
  const forceHonored = forceRequested && !hostedRuntime;
  const forceIgnored = forceRequested && hostedRuntime;
  const conservativeHostedBlock = hostedRuntime;
  const breakdown = getActiveCollabClientBreakdown(slug);
  const connectedClients = breakdown.total;
  return {
    connectedClients,
    accessEpoch: breakdown.accessEpoch,
    exactEpochCount: breakdown.exactEpochCount,
    anyEpochCount: breakdown.anyEpochCount,
    documentLeaseExactCount: breakdown.documentLeaseExactCount,
    documentLeaseAnyEpochCount: breakdown.documentLeaseAnyEpochCount,
    recentLeaseCount: breakdown.recentLeaseCount,
    force: forceRequested,
    forceRequested,
    forceHonored,
    forceIgnored,
    conservativeHostedBlock,
    hostedRuntime,
    runtimeEnvironment,
    blocked: (conservativeHostedBlock || connectedClients > 0) && !forceHonored,
  };
}

export function rewriteBlockedResponseBody(gate: RewriteLiveClientGate, slug?: string): Record<string, unknown> {
  return {
    success: false,
    code: 'LIVE_CLIENTS_PRESENT',
    error: 'Rewrite is blocked while authenticated collaborators are connected. Wait for collaborators to disconnect, refresh state, and retry.',
    retryable: true,
    reason: 'live_clients_present',
    nextSteps: [
      'Wait for active authenticated collaborators to disconnect.',
      'Refresh document state and read the latest revision.',
      'Retry the rewrite request with a fresh baseRevision.',
    ],
    connectedClients: gate.connectedClients,
    force: gate.forceRequested,
    forceRequested: gate.forceRequested,
    forceHonored: gate.forceHonored,
    forceIgnored: gate.forceIgnored,
    hostedRuntime: gate.hostedRuntime,
    runtimeEnvironment: gate.runtimeEnvironment,
    retryWithState: slug ? `/api/agent/${slug}/state` : undefined,
  };
}

export function classifyRewriteBarrierFailureReason(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  const normalized = message.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('timed out') || normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('forced') || normalized.includes('test')) return 'forced';
  return 'barrier_error';
}

export function rewriteBarrierFailedResponseBody(
  slug?: string,
  reason: string = 'barrier_error',
): Record<string, unknown> {
  return {
    success: false,
    code: 'REWRITE_BARRIER_FAILED',
    error: 'Rewrite safety barrier failed before rewrite execution. The rewrite was not applied.',
    retryable: true,
    reason,
    retryWithState: slug ? `/api/agent/${slug}/state` : undefined,
    nextSteps: [
      'Refresh document state and confirm active collaborators are no longer connected.',
      'Retry the rewrite request with a fresh baseRevision.',
      'If retries continue failing, use exponential backoff with jitter (1s, 2s, 4s, max 30s) and stop after 5 attempts.',
    ],
  };
}

export function annotateRewriteDisruptionMetadata(
  body: unknown,
  gate: RewriteLiveClientGate,
): Record<string, unknown> {
  const payload = asRecord(body);
  return {
    ...payload,
    connectedClients: gate.connectedClients,
    force: gate.forceRequested,
    forceRequested: gate.forceRequested,
    forceHonored: gate.forceHonored,
    forceIgnored: gate.forceIgnored,
    hostedRuntime: gate.hostedRuntime,
    runtimeEnvironment: gate.runtimeEnvironment,
    rewriteBarrierApplied: true,
  };
}
