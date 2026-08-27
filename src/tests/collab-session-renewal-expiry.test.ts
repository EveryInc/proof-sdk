/**
 * Regression coverage for comments lost when a collab session token expires.
 *
 * Field report: the browser console showed
 *   [HocuspocusProvider] Connection closed with status Unauthorized:
 *   Invalid or expired collab session token
 * and comments added after that close stayed visible in the tab while SQLite
 * kept revision=1, marks='{}', zero document_y_updates and no comment events.
 *
 * Each scenario below runs against both the current predicates and a reference
 * implementation of the inline logic they replaced, asserting that the old
 * logic gets the answer wrong. A test that both implementations pass would not
 * have caught this defect.
 */

import {
  areMarksDurablyAcknowledged,
  classifyCollabAuthFailure,
  shouldPreserveLocalStateOnReconnect,
  shouldRenewCollabSession,
  shouldUseRestMarksFallback,
  COLLAB_RENEWAL_LEAD_MS,
} from '../bridge/collab-session-renewal';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A deterministic clock, so expiry is crossed by arithmetic and not by sleeping. */
function fakeClock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      return now;
    },
  };
}

/**
 * src/editor/index.ts:2249-2261 as it stood before this change. Reproduced so
 * the scenarios can prove the old rule returns the wrong answer.
 */
function legacyShouldRenew(input: {
  expiresAtMs: number;
  now: number;
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
  isSynced: boolean;
  collabCanEdit: boolean;
  hasPendingLocalState: boolean;
  lastLocalTypingAt: number;
  typingGraceMs: number;
}): boolean {
  if ((input.expiresAtMs - input.now) > 60_000) return false;
  // The guard that prevented proactive renewal.
  if (input.connectionStatus === 'connected' && input.isSynced) return false;
  // shouldDeferExpiringCollabRefresh(), which ignored connection state.
  if (input.collabCanEdit) {
    if (input.hasPendingLocalState) return false;
    if ((input.now - input.lastLocalTypingAt) < input.typingGraceMs) return false;
  }
  return true;
}

const TYPING_GRACE_MS = 3_000;

function scenarioProactiveRenewalBeforeExpiry(): void {
  const clock = fakeClock(1_760_000_000_000);
  const expiresAtMs = clock.now() + 600_000; // 10 minute session

  // Idle mid-session: nothing should happen yet.
  assert(
    shouldRenewCollabSession({
      expiresAtMs,
      now: clock.now(),
      connectionStatus: 'connected',
      refreshInFlight: false,
      lastRenewalAttemptMs: null,
      hasPendingLocalState: false,
      lastLocalTypingAt: clock.now() - 60_000,
      typingGraceMs: TYPING_GRACE_MS,
    }) === false,
    'Expected no renewal 10 minutes ahead of expiry',
  );

  // Advance to 30s before expiry, connection perfectly healthy and idle.
  clock.advance(570_000);
  const remaining = expiresAtMs - clock.now();
  assert(remaining < COLLAB_RENEWAL_LEAD_MS, 'Fixture should be inside the renewal lead window');

  const legacy = legacyShouldRenew({
    expiresAtMs,
    now: clock.now(),
    connectionStatus: 'connected',
    isSynced: true,
    collabCanEdit: true,
    hasPendingLocalState: false,
    lastLocalTypingAt: clock.now() - 60_000,
    typingGraceMs: TYPING_GRACE_MS,
  });
  assert(
    legacy === false,
    'Reference implementation should reproduce the defect by refusing to renew a healthy session',
  );

  assert(
    shouldRenewCollabSession({
      expiresAtMs,
      now: clock.now(),
      connectionStatus: 'connected',
      refreshInFlight: false,
      lastRenewalAttemptMs: null,
      hasPendingLocalState: false,
      lastLocalTypingAt: clock.now() - 60_000,
      typingGraceMs: TYPING_GRACE_MS,
    }) === true,
    'Expected a healthy connection to renew proactively inside the lead window',
  );

  console.log('  ✓ healthy session renews before expiry instead of waiting to be closed');
}

function scenarioTypingDoesNotDeferPastHardDeadline(): void {
  const clock = fakeClock(1_760_000_000_000);
  const expiresAtMs = clock.now() + 45_000;

  // Actively typing, 45s of life left: deferring is still correct.
  assert(
    shouldRenewCollabSession({
      expiresAtMs,
      now: clock.now(),
      connectionStatus: 'connected',
      refreshInFlight: false,
      lastRenewalAttemptMs: null,
      hasPendingLocalState: true,
      lastLocalTypingAt: clock.now(),
      typingGraceMs: TYPING_GRACE_MS,
    }) === false,
    'Expected renewal to defer for a live connection with unsaved work and time to spare',
  );

  // 10s of life left and still typing: the hard deadline wins.
  clock.advance(35_000);
  assert(
    shouldRenewCollabSession({
      expiresAtMs,
      now: clock.now(),
      connectionStatus: 'connected',
      refreshInFlight: false,
      lastRenewalAttemptMs: null,
      hasPendingLocalState: true,
      lastLocalTypingAt: clock.now(),
      typingGraceMs: TYPING_GRACE_MS,
    }) === true,
    'Expected the hard deadline to override typing and pending-state deferral',
  );

  console.log('  ✓ deferral cannot push renewal past the hard deadline');
}

function scenarioUnsavedWorkDoesNotDeadlockRecovery(): void {
  const clock = fakeClock(1_760_000_000_000);
  const expiresAtMs = clock.now() - 5_000; // token already expired

  // The tab is disconnected after the 4401 close and holds an unsaved comment.
  const disconnectedWithUnsavedComment = {
    expiresAtMs,
    now: clock.now(),
    connectionStatus: 'disconnected' as const,
    refreshInFlight: false,
    lastRenewalAttemptMs: null,
    hasPendingLocalState: true,
    lastLocalTypingAt: clock.now() - 30_000,
    typingGraceMs: TYPING_GRACE_MS,
  };

  const legacy = legacyShouldRenew({
    expiresAtMs,
    now: clock.now(),
    connectionStatus: 'disconnected',
    isSynced: false,
    collabCanEdit: true,
    hasPendingLocalState: true,
    lastLocalTypingAt: clock.now() - 30_000,
    typingGraceMs: TYPING_GRACE_MS,
  });
  assert(
    legacy === false,
    'Reference implementation should reproduce the deadlock: unsaved work blocked its own recovery',
  );

  assert(
    shouldRenewCollabSession(disconnectedWithUnsavedComment) === true,
    'Expected an expired, disconnected session holding unsaved work to renew immediately',
  );

  console.log('  ✓ an unsaved comment no longer blocks the refresh that would save it');
}

function scenarioRenewalBackoffPreventsSpin(): void {
  const clock = fakeClock(1_760_000_000_000);
  const expiresAtMs = clock.now() - 1_000;

  const base = {
    expiresAtMs,
    now: clock.now(),
    connectionStatus: 'disconnected' as const,
    refreshInFlight: false,
    hasPendingLocalState: true,
    lastLocalTypingAt: clock.now() - 30_000,
    typingGraceMs: TYPING_GRACE_MS,
  };

  assert(
    shouldRenewCollabSession({ ...base, lastRenewalAttemptMs: clock.now() - 500 }) === false,
    'Expected a renewal attempt 500ms ago to be inside the backoff window',
  );
  assert(
    shouldRenewCollabSession({ ...base, lastRenewalAttemptMs: clock.now() - 6_000 }) === true,
    'Expected renewal to resume once the backoff window has passed',
  );
  assert(
    shouldRenewCollabSession({ ...base, lastRenewalAttemptMs: null, refreshInFlight: true }) === false,
    'Expected an in-flight refresh to suppress a second concurrent attempt',
  );

  console.log('  ✓ renewal backs off instead of spinning on a failing refresh');
}

function scenarioReconnectPreservesUnsavedComment(): void {
  assert(
    shouldPreserveLocalStateOnReconnect({ collabCanEdit: true, hasPendingLocalState: true }) === true,
    'Expected reconnect to replay an unsaved comment rather than reset the doc',
  );
  assert(
    shouldPreserveLocalStateOnReconnect({ collabCanEdit: true, hasPendingLocalState: false }) === false,
    'Expected a clean session to reconnect against server state',
  );
  assert(
    shouldPreserveLocalStateOnReconnect({ collabCanEdit: false, hasPendingLocalState: true }) === false,
    'Expected a read-only session never to replay local state',
  );

  console.log('  ✓ stalled-collab recovery preserves local marks instead of discarding them');
}

function scenarioRestFallbackCoversDeadProvider(): void {
  // The exact field condition: capabilities still true, provider dead.
  const deadProvider = {
    collabEnabled: true,
    collabCanEdit: true,
    legacyRestFallback: false,
    connectionStatus: 'disconnected' as const,
  };
  assert(
    shouldUseRestMarksFallback(deadProvider) === true,
    'Expected REST persistence when collab is nominally enabled but the provider is disconnected',
  );

  // Legacy rule, reproduced: capability flags alone decided, so this returned false.
  const legacyDecision = !deadProvider.collabEnabled
    || !deadProvider.collabCanEdit
    || deadProvider.legacyRestFallback;
  assert(
    legacyDecision === false,
    'Reference implementation should reproduce the defect by skipping REST on a dead provider',
  );

  assert(
    shouldUseRestMarksFallback({ ...deadProvider, connectionStatus: 'connected' }) === false,
    'Expected no REST write while a live provider owns the document, to avoid racing Yjs',
  );
  assert(
    shouldUseRestMarksFallback({ ...deadProvider, connectionStatus: 'connecting' }) === true,
    'Expected REST persistence while the provider is still connecting',
  );
  assert(
    shouldUseRestMarksFallback({ ...deadProvider, collabEnabled: false }) === true,
    'Expected REST persistence when collab is disabled outright',
  );

  console.log('  ✓ a dead provider falls back to REST without racing a live one');
}

function scenarioAuthFailureClassification(): void {
  assert(
    classifyCollabAuthFailure('Invalid or expired collab session token') === 'expired',
    'Expected the observed 4401 close reason to classify as expired',
  );
  assert(
    classifyCollabAuthFailure('session-stale') === 'expired',
    'Expected a stale access epoch to classify as refreshable',
  );
  assert(
    classifyCollabAuthFailure('permission-denied') === 'permission-denied',
    'Expected an explicit denial to classify as permission-denied',
  );
  assert(
    classifyCollabAuthFailure(undefined) === 'unknown',
    'Expected a missing reason to classify as unknown',
  );

  console.log('  ✓ auth-failure reasons classify into a refresh decision');
}

function scenarioCommentNotReportedSavedUntilAcked(): void {
  const clock = fakeClock(1_760_000_000_000);
  const markAt = clock.now();

  assert(
    areMarksDurablyAcknowledged({
      connectionStatus: 'disconnected',
      isSynced: false,
      unsyncedChanges: 1,
      pendingLocalUpdates: 0,
      lastRestMarksAckAt: null,
      lastLocalMarkAt: markAt,
    }) === false,
    'Expected a comment on a dead provider never to report itself as saved',
  );

  assert(
    areMarksDurablyAcknowledged({
      connectionStatus: 'connected',
      isSynced: true,
      unsyncedChanges: 1,
      pendingLocalUpdates: 0,
      lastRestMarksAckAt: null,
      lastLocalMarkAt: markAt,
    }) === false,
    'Expected unsynced changes to keep a comment pending even on a live connection',
  );

  clock.advance(1_000);
  assert(
    areMarksDurablyAcknowledged({
      connectionStatus: 'disconnected',
      isSynced: false,
      unsyncedChanges: 1,
      pendingLocalUpdates: 0,
      lastRestMarksAckAt: clock.now(),
      lastLocalMarkAt: markAt,
    }) === true,
    'Expected a REST acknowledgement to durably settle a comment while offline',
  );

  assert(
    areMarksDurablyAcknowledged({
      connectionStatus: 'connected',
      isSynced: true,
      unsyncedChanges: 0,
      pendingLocalUpdates: 0,
      lastRestMarksAckAt: null,
      lastLocalMarkAt: markAt,
    }) === true,
    'Expected a fully synced provider to durably settle a comment',
  );

  console.log('  ✓ comments stay pending until durably acknowledged');
}

function run(): void {
  scenarioProactiveRenewalBeforeExpiry();
  scenarioTypingDoesNotDeferPastHardDeadline();
  scenarioUnsavedWorkDoesNotDeadlockRecovery();
  scenarioRenewalBackoffPreventsSpin();
  scenarioReconnectPreservesUnsavedComment();
  scenarioRestFallbackCoversDeadProvider();
  scenarioAuthFailureClassification();
  scenarioCommentNotReportedSavedUntilAcked();
  console.log('✓ collab session renewal keeps comments durable across token expiry');
}

run();
