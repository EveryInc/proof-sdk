import { getActiveCollabClientBreakdown } from './ws.js';
import { traceServerIncident } from './incident-tracing.js';

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

type RewriteLiveClientGateOptions = {
  route?: string;
  requestId?: string | null;
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

// Single-replica self-hosting. The live-doc gate assumes a multi-replica fleet:
// a recent collab-session lease with no live connection *on this node* is read
// as "another replica holds the doc live", returning LIVE_DOC_UNAVAILABLE. On a
// single replica there are no siblings, so that inference is a false positive
// that blocks all programmatic edits for the lease window after a viewer leaves.
// When set, callers trust this node's own connection view (exactEpochCount)
// instead of ghost leases. Auto-on when RAILWAY_REPLICA_ID is absent would be
// too aggressive (cold starts), so this stays explicit/opt-in.
export function isSingleReplicaDeployment(): boolean {
  const raw = (process.env.PROOF_SINGLE_REPLICA || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// Multi-replica hosted runtime: hosted AND not explicitly single-replica. Use
// this for the "another replica may hold the live doc" gating; keep
// isHostedRewriteEnvironment for genuinely environment-wide policy.
export function isHostedMultiReplicaRewriteEnvironment(): boolean {
  return isHostedRewriteEnvironment() && !isSingleReplicaDeployment();
}

export function evaluateRewriteLiveClientGate(slug: string, body: unknown): RewriteLiveClientGate {
  return evaluateRewriteLiveClientGateWithOptions(slug, body, {});
}

function hasStaleEpochBypassDiagnostics(gate: RewriteLiveClientGate): boolean {
  if (gate.connectedClients > 0) return false;
  return gate.anyEpochCount > gate.exactEpochCount
    || gate.documentLeaseAnyEpochCount > gate.documentLeaseExactCount;
}

function noteRewriteStaleEpochBypass(
  slug: string,
  gate: RewriteLiveClientGate,
  options: RewriteLiveClientGateOptions,
): void {
  if (!slug || !hasStaleEpochBypassDiagnostics(gate)) return;
  traceServerIncident({
    requestId: options.requestId ?? null,
    slug,
    subsystem: 'collab',
    level: 'info',
    eventType: 'collab.stale_epoch_bypass_admitted',
    message: 'Proceeding with rewrite admission despite stale prior-epoch collab diagnostics',
    data: {
      surface: 'rewrite_admission',
      source: options.route ?? 'rewrite',
      route: options.route ?? 'rewrite',
      authorityBranch: 'current_epoch_cold_room',
      accessEpoch: gate.accessEpoch,
      exactEpochCount: gate.exactEpochCount,
      anyEpochCount: gate.anyEpochCount,
      documentLeaseExactCount: gate.documentLeaseExactCount,
      documentLeaseAnyEpochCount: gate.documentLeaseAnyEpochCount,
      recentLeaseCount: gate.recentLeaseCount,
      total: gate.connectedClients,
    },
  });
}

export function evaluateRewriteLiveClientGateWithOptions(
  slug: string,
  body: unknown,
  options: RewriteLiveClientGateOptions,
): RewriteLiveClientGate {
  const forceRequested = parseRewriteForceFlag(body);
  const runtimeEnvironment = getRewriteRuntimeEnvironment();
  const hostedRuntime = isHostedRewriteEnvironment(runtimeEnvironment);
  const forceHonored = forceRequested && !hostedRuntime;
  const forceIgnored = forceRequested && hostedRuntime;
  const breakdown = getActiveCollabClientBreakdown(slug);
  const connectedClients = breakdown.total;
  const conservativeHostedBlock = hostedRuntime
    && breakdown.exactEpochCount === 0
    && breakdown.total > 0;
  const gate = {
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
    blocked: connectedClients > 0 && !forceHonored,
  };
  if (!gate.blocked) {
    noteRewriteStaleEpochBypass(slug, gate, options);
  }
  return gate;
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
