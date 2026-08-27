/**
 * Collab session renewal and mark-durability decisions.
 *
 * These were inline conditions in `src/editor/index.ts` and
 * `src/bridge/collab-client.ts`. They are extracted here because the editor is
 * browser-only and cannot be instantiated in the test harness, so the decisions
 * that actually lose data were untestable where they lived.
 *
 * The defect they fix: a collab session token expires while the provider is
 * connected and healthy. The old renewal loop returned early whenever the
 * connection was `connected && isSynced`, so it never renewed ahead of expiry.
 * The server then closed the socket with 4401 "Invalid or expired collab
 * session token". A comment submitted after that point was written only into
 * the local Y.Doc — the REST safety path was skipped because `collabEnabled`
 * and `collabCanEdit` are capability flags that stay true on a dead provider —
 * and the deferral rule then blocked recovery *because* there was unsaved work.
 */

export type CollabConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export type CollabAuthFailureClass = 'expired' | 'permission-denied' | 'unknown';

/** Renew this far ahead of expiry under normal conditions. */
export const COLLAB_RENEWAL_LEAD_MS = 60_000;

/**
 * Inside this window, renewal happens regardless of typing or pending local
 * state. Past expiry there is nothing left to protect: the server will reject
 * the next message anyway.
 */
export const COLLAB_RENEWAL_HARD_DEADLINE_MS = 15_000;

/** Minimum spacing between renewal attempts, so a failing refresh cannot spin. */
export const COLLAB_RENEWAL_BACKOFF_MS = 5_000;

/**
 * Classify the reason carried by a Hocuspocus `authenticationFailed` event.
 *
 * The server produces two distinguishable shapes: the pre-gate in
 * `server/ws.ts` closes 4401 with "Invalid or expired collab session token",
 * and `authenticateCollabSession()` in `server/collab.ts` throws
 * 'permission-denied' or 'session-stale'.
 *
 * Classification is diagnostic only. Both classes attempt exactly one refresh,
 * because an expired token also surfaces as 'permission-denied' through the
 * Hocuspocus hook — the refresh response, not this string, is what decides
 * whether access is really gone.
 */
export function classifyCollabAuthFailure(
  reason: string | null | undefined,
): CollabAuthFailureClass {
  const normalized = (reason ?? '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('expired')) return 'expired';
  if (normalized.includes('session-stale') || normalized.includes('session stale')) return 'expired';
  if (normalized.includes('permission-denied') || normalized.includes('permission denied')) {
    return 'permission-denied';
  }
  if (normalized.includes('unauthorized')) return 'expired';
  return 'unknown';
}

export type ProactiveRenewalInput = {
  expiresAtMs: number | null;
  now: number;
  connectionStatus: CollabConnectionStatus;
  refreshInFlight: boolean;
  lastRenewalAttemptMs: number | null;
  hasPendingLocalState: boolean;
  lastLocalTypingAt: number;
  typingGraceMs: number;
  leadMs?: number;
  hardDeadlineMs?: number;
  backoffMs?: number;
};

/**
 * Whether to renew the collab session now.
 *
 * Two rules differ from the original inline logic, and each one on its own was
 * enough to lose a comment:
 *
 * 1. A healthy connection is NOT a reason to skip renewal. The old code
 *    returned early on `connected && isSynced`, which is precisely the state a
 *    session is in for the whole minute before it expires.
 * 2. Deferral for typing or unsaved work applies only while the connection is
 *    still usable. Once the provider is disconnected, unsaved work is the
 *    reason to reconnect, not a reason to wait — the old rule deadlocked
 *    exactly when recovery mattered.
 */
export function shouldRenewCollabSession(input: ProactiveRenewalInput): boolean {
  const {
    expiresAtMs,
    now,
    connectionStatus,
    refreshInFlight,
    lastRenewalAttemptMs,
    hasPendingLocalState,
    lastLocalTypingAt,
    typingGraceMs,
    leadMs = COLLAB_RENEWAL_LEAD_MS,
    hardDeadlineMs = COLLAB_RENEWAL_HARD_DEADLINE_MS,
    backoffMs = COLLAB_RENEWAL_BACKOFF_MS,
  } = input;

  if (refreshInFlight) return false;
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) return false;

  const remainingMs = expiresAtMs - now;
  if (remainingMs > leadMs) return false;

  if (lastRenewalAttemptMs !== null && (now - lastRenewalAttemptMs) < backoffMs) return false;

  // At or past the hard deadline nothing may defer renewal.
  if (remainingMs <= hardDeadlineMs) return true;

  // Only a live connection earns the courtesy of not being interrupted.
  if (connectionStatus === 'connected') {
    if (hasPendingLocalState) return false;
    if ((now - lastLocalTypingAt) < typingGraceMs) return false;
  }

  return true;
}

export type PreserveLocalStateInput = {
  collabCanEdit: boolean;
  hasPendingLocalState: boolean;
};

/**
 * Whether a reconnect should replay local state instead of resetting the doc.
 *
 * The stalled-collab recovery path previously hardcoded `false` here, so the
 * reconnect it triggered reset the Y.Doc and discarded the very comment the
 * user was waiting to see saved. Replay is safe: marks are keyed by mark id and
 * merged by key, so replaying an already-persisted comment is a no-op rather
 * than a duplicate.
 */
export function shouldPreserveLocalStateOnReconnect(input: PreserveLocalStateInput): boolean {
  return input.collabCanEdit && input.hasPendingLocalState;
}

export type RestMarksFallbackInput = {
  collabEnabled: boolean;
  collabCanEdit: boolean;
  legacyRestFallback: boolean;
  connectionStatus: CollabConnectionStatus;
};

/**
 * Whether `flushShareMarks` must also push marks over REST.
 *
 * `collabEnabled` and `collabCanEdit` describe what the session is *permitted*
 * to do, not whether a provider is alive to do it. Gating the REST path on
 * those alone meant a dead provider silently swallowed comments. Liveness is
 * the missing term.
 *
 * This does not create a parallel writer: REST is used only when the provider
 * is not connected, so there is no live Yjs writer to race. While connected,
 * the provider remains the sole owner of the canonical document.
 */
export function shouldUseRestMarksFallback(input: RestMarksFallbackInput): boolean {
  if (!input.collabEnabled) return true;
  if (!input.collabCanEdit) return true;
  if (input.legacyRestFallback) return true;
  return input.connectionStatus !== 'connected';
}

/**
 * Whether marks are durably acknowledged, i.e. whether the comment UI may stop
 * showing them as pending. A mark is durable once it has either round-tripped
 * through a synced provider or been accepted by the REST path.
 */
export function areMarksDurablyAcknowledged(input: {
  connectionStatus: CollabConnectionStatus;
  isSynced: boolean;
  unsyncedChanges: number;
  pendingLocalUpdates: number;
  lastRestMarksAckAt: number | null;
  lastLocalMarkAt: number | null;
}): boolean {
  const {
    connectionStatus,
    isSynced,
    unsyncedChanges,
    pendingLocalUpdates,
    lastRestMarksAckAt,
    lastLocalMarkAt,
  } = input;

  if (lastLocalMarkAt === null) return true;

  if (lastRestMarksAckAt !== null && lastRestMarksAckAt >= lastLocalMarkAt) return true;

  return connectionStatus === 'connected'
    && isSynced
    && unsyncedChanges === 0
    && pendingLocalUpdates === 0;
}
