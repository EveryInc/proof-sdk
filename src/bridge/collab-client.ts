import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import { shareClient, type CollabSessionInfo, type ShareRole } from './share-client';
import { shouldPreserveMissingLocalMark } from './marks-preservation';
import { recordClientIncidentEvent } from '../agent/client-incident-buffer';

type PresenceHandler = (count: number) => void;
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
export type CollabSyncStatus = {
  connectionStatus: ConnectionStatus;
  isSynced: boolean;
  unsyncedChanges: number;
  pendingLocalUpdates: number;
  offlineSinceMs: number | null;
};
type SyncStatusHandler = (status: CollabSyncStatus) => void;
export type CollabTerminalCloseReason = 'unshared' | 'permission-denied' | null;
type MarksHandler = (marks: Record<string, unknown>) => void;
type DocumentUpdatedHandler = () => void;

type CollabLocalUser = { name: string; color: string };

const USER_COLOR_PALETTE = [
  '#0ea5e9', // sky
  '#f97316', // orange
  '#a855f7', // purple
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#ec4899', // pink
  '#64748b', // slate
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#3b82f6', // blue
];

const DURABLE_UPDATE_KEY_PREFIX = 'proof:collab:pending-updates:';
const MAX_DURABLE_UPDATES = 200;

const DURABLE_CLIENT_ID_SESSION_KEY = 'proof:collab:durable-client-id';

function getOrCreateDurableClientId(): string {
  // Use sessionStorage so reloads in the same tab reuse the same key,
  // preventing orphaned localStorage keys from accumulating.
  try {
    const existing = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(DURABLE_CLIENT_ID_SESSION_KEY) : null;
    if (existing) return existing;
  } catch { /* ignore */ }

  const cryptoObj = typeof crypto !== 'undefined' ? crypto : null;
  const id = (cryptoObj && typeof cryptoObj.randomUUID === 'function')
    ? cryptoObj.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(DURABLE_CLIENT_ID_SESSION_KEY, id);
    }
  } catch { /* ignore */ }

  return id;
}

function hashString(input: string): number {
  // FNV-1a
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickStableColor(seed: string): string {
  const idx = hashString(seed) % USER_COLOR_PALETTE.length;
  return USER_COLOR_PALETTE[idx] || '#60a5fa';
}

function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof window === 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    if (typeof window === 'undefined') {
      return new Uint8Array(Buffer.from(value, 'base64'));
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

function applyYTextDiff(target: Y.Text, nextValue: string): void {
  const currentValue = target.toString();
  if (currentValue === nextValue) return;

  let prefix = 0;
  const maxPrefix = Math.min(currentValue.length, nextValue.length);
  while (prefix < maxPrefix && currentValue.charCodeAt(prefix) === nextValue.charCodeAt(prefix)) {
    prefix += 1;
  }

  let currentSuffix = currentValue.length;
  let nextSuffix = nextValue.length;
  while (
    currentSuffix > prefix
    && nextSuffix > prefix
    && currentValue.charCodeAt(currentSuffix - 1) === nextValue.charCodeAt(nextSuffix - 1)
  ) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  const deleteLength = currentSuffix - prefix;
  if (deleteLength > 0) {
    target.delete(prefix, deleteLength);
  }
  if (nextSuffix > prefix) {
    target.insert(prefix, nextValue.slice(prefix, nextSuffix));
  }
}

export class CollabClient {
  private ydoc: Y.Doc | null = null;
  private provider: HocuspocusProvider | null = null;
  private activeSession: CollabSessionInfo | null = null;
  private markdownText: Y.Text | null = null;
  private marksMap: Y.Map<unknown> | null = null;
  private marksHandler: MarksHandler | null = null;
  private presenceHandler: PresenceHandler | null = null;
  private syncStatusHandler: SyncStatusHandler | null = null;
  private documentUpdatedHandler: DocumentUpdatedHandler | null = null;
  private applyingLocalMarks = false;
  private hasSynced = false;
  private lastDisconnectAt: number | null = null;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private unsyncedChanges = 0;
  private localUser: CollabLocalUser | null = null;
  private pendingMarksSnapshot: Record<string, unknown> | null = null;
  private pendingReconnectReplayUpdates: string[] = [];
  private recentReconnectReplayUpdates: Array<{ encoded: string; at: number }> = [];
  private durableBufferKey: string | null = null;
  private durablePendingUpdates: string[] = [];
  private durablePendingSince: number | null = null;
  private durableUpdatesEnabled = false;
  private readonly durableClientId: string;
  private mergedDurableKeys: string[] = [];
  private documentUpdatedResyncTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DOCUMENT_UPDATED_DEBOUNCE_MS = 600;
  private sessionRole: ShareRole | null = null;
  terminalCloseReason: CollabTerminalCloseReason = null;
  lastAuthenticationFailureReason: string | null = null;

  constructor() {
    this.durableClientId = getOrCreateDurableClientId();
  }

  isConnected(): boolean {
    return this.provider?.isConnected === true;
  }

  onMarks(handler: MarksHandler): void {
    this.marksHandler = handler;
    if (this.marksHandler) {
      this.marksHandler(this.readMarks());
    }
  }

  onPresence(handler: PresenceHandler): void {
    this.presenceHandler = handler;
  }

  onSyncStatus(handler: SyncStatusHandler): void {
    this.syncStatusHandler = handler;
    this.emitSyncStatus();
  }

  onDocumentUpdated(handler: DocumentUpdatedHandler): void {
    this.documentUpdatedHandler = handler;
  }

  private emitSyncStatus(): void {
    if (!this.syncStatusHandler) return;
    this.syncStatusHandler({
      connectionStatus: this.connectionStatus,
      isSynced: this.hasSynced,
      unsyncedChanges: this.unsyncedChanges,
      pendingLocalUpdates: this.durablePendingUpdates.length,
      offlineSinceMs: this.connectionStatus === 'disconnected' ? this.lastDisconnectAt : null,
    });
  }

  private getDurableBufferKey(slug: string): string {
    return `${DURABLE_UPDATE_KEY_PREFIX}${slug}:${this.durableClientId}`;
  }

  private canPersistDurableUpdates(role: ShareRole): boolean {
    return role === 'editor' || role === 'owner_bot';
  }

  private resetDurableState(): void {
    this.durableBufferKey = null;
    this.durablePendingUpdates = [];
    this.durablePendingSince = null;
    this.mergedDurableKeys = [];
  }

  private loadDurableBuffer(slug: string): void {
    this.durableBufferKey = this.getDurableBufferKey(slug);
    this.durablePendingUpdates = [];
    this.durablePendingSince = null;
    this.mergedDurableKeys = [];
    const storage = getLocalStorage();
    if (!storage) return;
    // Only load from legacy key (no client id) and current client's key.
    // Other clients' keys are left alone to avoid cross-tab interference.
    const legacyKey = `${DURABLE_UPDATE_KEY_PREFIX}${slug}`;
    const keysToLoad = [legacyKey, this.durableBufferKey!].filter(Boolean);
    const mergedUpdates: string[] = [];
    let mergedSince: number | null = null;
    this.mergedDurableKeys = [];
    for (const key of keysToLoad) {
      const raw = storage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { updates?: unknown; since?: unknown };
        const updates = Array.isArray(parsed.updates)
          ? parsed.updates.filter((value): value is string => typeof value === 'string')
          : [];
        if (updates.length > 0) {
          mergedUpdates.push(...updates);
          if (typeof parsed.since === 'number') {
            mergedSince = mergedSince === null ? parsed.since : Math.min(mergedSince, parsed.since);
          }
        }
      } catch {
        // ignore malformed local storage entry
      }
      // Track legacy key for cleanup after successful replay, but only if it had data
      if (key === legacyKey && raw) {
        this.mergedDurableKeys.push(key);
      }
    }
    if (mergedUpdates.length > 0) {
      this.durablePendingUpdates = mergedUpdates.slice(-MAX_DURABLE_UPDATES);
      this.durablePendingSince = mergedSince ?? Date.now();
    }
  }

  private durableFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DURABLE_FLUSH_DEBOUNCE_MS = 500;
  private static readonly RECENT_RECONNECT_REPLAY_GRACE_MS = 5_000;

  private persistDurableBuffer(): void {
    // Debounce localStorage writes to avoid synchronous I/O jank under high edit throughput.
    if (this.durableFlushTimer !== null) return;
    this.durableFlushTimer = setTimeout(() => {
      this.durableFlushTimer = null;
      this.flushDurableBuffer();
    }, CollabClient.DURABLE_FLUSH_DEBOUNCE_MS);
  }

  private flushDurableBuffer(): void {
    if (!this.durableBufferKey) return;
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(
        this.durableBufferKey,
        JSON.stringify({
          updates: this.durablePendingUpdates,
          since: this.durablePendingSince,
        }),
      );
    } catch {
      // ignore write failures (quota, private mode, etc.)
    }
  }

  private appendDurableUpdate(update: Uint8Array): void {
    if (!this.durableUpdatesEnabled || !this.durableBufferKey) return;
    const encoded = encodeBase64(update);
    this.rememberRecentReconnectReplayUpdate(encoded);
    this.durablePendingUpdates.push(encoded);
    if (this.durablePendingUpdates.length > MAX_DURABLE_UPDATES) {
      this.durablePendingUpdates = this.durablePendingUpdates.slice(-MAX_DURABLE_UPDATES);
    }
    if (this.durablePendingSince === null) {
      this.durablePendingSince = Date.now();
    }
    this.persistDurableBuffer();
    this.emitSyncStatus();
  }

  private rememberRecentReconnectReplayUpdate(encoded: string): void {
    const now = Date.now();
    this.recentReconnectReplayUpdates = this.recentReconnectReplayUpdates
      .filter((entry) => (now - entry.at) <= CollabClient.RECENT_RECONNECT_REPLAY_GRACE_MS);
    this.recentReconnectReplayUpdates.push({ encoded, at: now });
    if (this.recentReconnectReplayUpdates.length > MAX_DURABLE_UPDATES) {
      this.recentReconnectReplayUpdates = this.recentReconnectReplayUpdates.slice(-MAX_DURABLE_UPDATES);
    }
  }

  private getRecentReconnectReplayUpdates(): string[] {
    const now = Date.now();
    this.recentReconnectReplayUpdates = this.recentReconnectReplayUpdates
      .filter((entry) => (now - entry.at) <= CollabClient.RECENT_RECONNECT_REPLAY_GRACE_MS);
    return this.recentReconnectReplayUpdates.map((entry) => entry.encoded);
  }

  private clearDurableBuffer(): void {
    if (this.durableFlushTimer !== null) {
      clearTimeout(this.durableFlushTimer);
      this.durableFlushTimer = null;
    }
    const storage = getLocalStorage();
    if (storage) {
      // Remove current instance key
      if (this.durableBufferKey) {
        try { storage.removeItem(this.durableBufferKey); } catch { /* ignore */ }
      }
      // Remove old/legacy keys that were merged during load
      for (const key of this.mergedDurableKeys) {
        try { storage.removeItem(key); } catch { /* ignore */ }
      }
    }
    this.mergedDurableKeys = [];
    this.durablePendingUpdates = [];
    this.durablePendingSince = null;
    this.emitSyncStatus();
  }

  private shouldPersistDurableUpdate(origin: unknown): boolean {
    if (origin === 'durable-replay') return false;
    if (origin === 'local-projection-sync') return false;
    if (origin && origin === this.provider) return false;
    if (typeof origin === 'string' && origin.startsWith('remote')) return false;
    return true;
  }

  private replayDurableUpdates(ydoc: Y.Doc): void {
    if (!this.durableUpdatesEnabled) return;
    if (this.durablePendingUpdates.length === 0) return;
    const nextUpdates = this.replayEncodedUpdates(ydoc, this.durablePendingUpdates);
    this.durablePendingUpdates = nextUpdates;
    if (this.durablePendingUpdates.length === 0) {
      this.durablePendingSince = null;
      this.persistDurableBuffer();
    }
  }

  private replayEncodedUpdates(ydoc: Y.Doc, encodedUpdates: string[]): string[] {
    const nextUpdates: string[] = [];
    for (const encoded of encodedUpdates) {
      const update = decodeBase64(encoded);
      if (!update) continue;
      try {
        Y.applyUpdate(ydoc, update, 'durable-replay');
        nextUpdates.push(encoded);
      } catch {
        // skip invalid update entries
      }
    }
    return nextUpdates;
  }

  private maybeClearDurableBuffer(): void {
    if (!this.durableUpdatesEnabled) return;
    if (this.connectionStatus !== 'connected') return;
    if (!this.hasSynced) return;
    if (this.unsyncedChanges > 0) return;
    if (this.durablePendingUpdates.length === 0) return;
    this.clearDurableBuffer();
  }

  private hasPendingLocalStateForReconnect(): boolean {
    return this.unsyncedChanges > 0 || this.durablePendingUpdates.length > 0;
  }

  private scheduleDocumentUpdatedResync(): void {
    if (!this.documentUpdatedHandler) return;
    if (this.documentUpdatedResyncTimer !== null) return;
    this.documentUpdatedResyncTimer = setTimeout(() => {
      this.documentUpdatedResyncTimer = null;
      this.documentUpdatedHandler?.();
    }, CollabClient.DOCUMENT_UPDATED_DEBOUNCE_MS);
  }

  private decodeStatelessMessage(payload: unknown): Record<string, unknown> | null {
    const container = (payload && typeof payload === 'object')
      ? payload as { payload?: unknown; data?: unknown }
      : null;
    const raw = container?.payload ?? container?.data ?? payload;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
      return null;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return null;
  }

  private shouldDebugLog(): boolean {
    try {
      return getLocalStorage()?.getItem('proof:collab:debug') === '1';
    } catch {
      return false;
    }
  }

  private debugLog(event: string, extra?: Record<string, unknown>): void {
    if (!this.shouldDebugLog()) return;
    console.info('[collab-client]', {
      event,
      role: this.sessionRole,
      connectionStatus: this.connectionStatus,
      hasSynced: this.hasSynced,
      unsyncedChanges: this.unsyncedChanges,
      ...(extra ?? {}),
    });
  }

  getYDoc(): Y.Doc | null {
    return this.ydoc;
  }

  getAwareness(): Awareness | null {
    return this.provider?.awareness ?? null;
  }

  setLocalUser(user: { name: string; color?: string }, slugSeed?: string): void {
    const rawName = typeof user.name === 'string' ? user.name.trim() : '';
    const name = rawName.length > 0 ? rawName : 'Anonymous';
    const color = (typeof user.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(user.color.trim()))
      ? user.color.trim()
      : pickStableColor(`${slugSeed ?? ''}:${name}`);
    this.localUser = { name, color };

    const awareness = this.provider?.awareness;
    if (awareness) {
      awareness.setLocalStateField('user', { name, color });
    }
  }

  private applyLocalUser(): void {
    const awareness = this.provider?.awareness;
    if (!awareness || !this.localUser) return;
    awareness.setLocalStateField('user', { name: this.localUser.name, color: this.localUser.color });
  }

  private readMarks(): Record<string, unknown> {
    if (!this.marksMap) return {};
    const marks: Record<string, unknown> = {};
    this.marksMap.forEach((value, key) => {
      marks[key] = value;
    });
    return marks;
  }

  private applyPendingMarksSnapshot(): void {
    if (!this.pendingMarksSnapshot || !this.ydoc || !this.marksMap) return;
    if (!this.sessionRole || !this.canPersistDurableUpdates(this.sessionRole)) {
      this.pendingMarksSnapshot = null;
      return;
    }
    const nextMarks = { ...this.pendingMarksSnapshot };
    this.pendingMarksSnapshot = null;
    this.setMarksMetadata(nextMarks);
  }

  private getProviderParameters(session: CollabSessionInfo): Record<string, string> {
    return {
      token: session.token,
      role: session.role,
    };
  }

  private usesSameLiveSession(session: CollabSessionInfo): boolean {
    if (!this.activeSession) return false;
    return this.activeSession.docId === session.docId
      && this.activeSession.slug === session.slug
      && this.activeSession.role === session.role
      && this.activeSession.shareState === session.shareState
      && this.activeSession.accessEpoch === session.accessEpoch;
  }

  requiresHardReconnect(session: CollabSessionInfo): boolean {
    if (!this.provider || !this.ydoc) return true;
    return !this.usesSameLiveSession(session);
  }

  connect(session: CollabSessionInfo, options?: { replayDurableBuffer?: boolean }): void {
    if (session.syncProtocol !== 'pm-yjs-v1') {
      throw new Error(`Unsupported collab sync protocol: ${session.syncProtocol}`);
    }

    this.disconnect();
    this.activeSession = { ...session };
    this.sessionRole = session.role;
    this.connectionStatus = 'connecting';
    this.unsyncedChanges = 0;
    this.hasSynced = false;
    this.terminalCloseReason = null;
    this.lastAuthenticationFailureReason = null;
    this.emitSyncStatus();
    this.durableUpdatesEnabled = this.canPersistDurableUpdates(session.role);
    if (this.durableUpdatesEnabled) {
      this.loadDurableBuffer(session.slug);
      if (options?.replayDurableBuffer === false) {
        this.clearDurableBuffer();
      }
    } else {
      this.resetDurableState();
    }

    const ydoc = new Y.Doc();
    const wsUrl = (() => {
      try {
        const url = new URL(session.collabWsUrl);
        url.searchParams.delete('slug');
        return url.toString();
      } catch {
        return session.collabWsUrl.replace(/\?slug=.*$/, '');
      }
    })();
    const room = session.slug;
    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: room,
      document: ydoc,
      preserveConnection: false,
      parameters: this.getProviderParameters(session),
      token: () => this.activeSession?.token ?? null,
    });

    ydoc.on('update', (update, origin) => {
      if (!this.shouldPersistDurableUpdate(origin)) return;
      this.appendDurableUpdate(update);
    });

    this.provider = provider;
    this.applyLocalUser();

    const markdownText = ydoc.getText('markdown');
    const marksMap = ydoc.getMap('marks');
    marksMap.observe((_event, transaction) => {
      if (!this.marksHandler) return;
      if (transaction.origin === 'local-marks-sync') return;
      if (this.applyingLocalMarks) return;
      this.marksHandler(this.readMarks());
    });

    provider.on('awarenessChange', (event: { states: Array<unknown> }) => {
      if (!this.presenceHandler) return;
      this.presenceHandler(event.states.length);
    });

    provider.on('status', (event: { status: ConnectionStatus }) => {
      this.connectionStatus = event.status;
      if (event.status === 'disconnected') {
        this.hasSynced = false;
        this.lastDisconnectAt = Date.now();
      }
      if (event.status === 'connected') {
        this.terminalCloseReason = null;
        this.lastAuthenticationFailureReason = null;
        if (this.lastDisconnectAt !== null) {
          const durationMs = Date.now() - this.lastDisconnectAt;
          this.lastDisconnectAt = null;
          shareClient.reportCollabReconnect(durationMs, 'web');
        }
      }
      recordClientIncidentEvent({
        type: 'collab.status_changed',
        level: event.status === 'disconnected' ? 'warn' : 'info',
        message: `Collab status changed to ${event.status}`,
        data: {
          slug: session.slug,
          role: session.role,
          status: event.status,
          hasSynced: this.hasSynced,
          unsyncedChanges: this.unsyncedChanges,
          pendingLocalUpdates: this.durablePendingUpdates.length,
        },
      });
      this.maybeClearDurableBuffer();
      this.emitSyncStatus();
    });

    provider.on('stateless', (payload: unknown) => {
      const message = this.decodeStatelessMessage(payload);
      if (!message) return;
      const type = message.type;
      if (type === 'document.updated') {
        this.scheduleDocumentUpdatedResync();
      }
    });

    provider.on('authenticationFailed', (event: { reason?: string }) => {
      const reason = typeof event?.reason === 'string' ? event.reason : 'permission-denied';
      this.lastAuthenticationFailureReason = reason;
      this.connectionStatus = 'disconnected';
      this.hasSynced = false;
      this.lastDisconnectAt = Date.now();
      recordClientIncidentEvent({
        type: 'collab.authentication_failed',
        level: 'error',
        message: `Collab authentication failed: ${reason}`,
        data: {
          slug: session.slug,
          role: session.role,
          reason,
        },
      });
      this.emitSyncStatus();
    });

    provider.on('close', () => {
      this.emitSyncStatus();
    });

    provider.on('unsyncedChanges', (changes: unknown) => {
      if (typeof changes === 'number' && Number.isFinite(changes)) {
        this.unsyncedChanges = Math.max(0, Math.floor(changes));
      } else {
        this.unsyncedChanges = 0;
      }
      if (!this.canPersistDurableUpdates(session.role) && this.unsyncedChanges > 0) {
        this.debugLog('readonly-unsynced-changes', { changes: this.unsyncedChanges });
      }
      this.maybeClearDurableBuffer();
      this.emitSyncStatus();
    });

    provider.on('synced', (event: { state?: boolean }) => {
      const state = event?.state;
      this.hasSynced = state !== false;
      this.maybeClearDurableBuffer();
      this.emitSyncStatus();
    });

    this.ydoc = ydoc;
    this.markdownText = markdownText;
    this.marksMap = marksMap;
    this.applyPendingMarksSnapshot();
    this.replayDurableUpdates(ydoc);
    if (this.pendingReconnectReplayUpdates.length > 0) {
      this.pendingReconnectReplayUpdates = this.replayEncodedUpdates(ydoc, this.pendingReconnectReplayUpdates);
    }
    this.pendingReconnectReplayUpdates = [];
    this.emitSyncStatus();

    if (this.marksHandler) {
      this.marksHandler(this.readMarks());
    }
  }

  softRefreshSession(session: CollabSessionInfo): boolean {
    if (!this.provider || !this.ydoc || this.requiresHardReconnect(session)) return false;

    this.activeSession = { ...session };
    this.sessionRole = session.role;
    this.terminalCloseReason = null;
    this.lastAuthenticationFailureReason = null;
    this.connectionStatus = 'connecting';
    this.hasSynced = false;
    this.emitSyncStatus();

    this.provider.setConfiguration({
      parameters: this.getProviderParameters(session),
      token: () => this.activeSession?.token ?? null,
    });
    this.provider.configuration.websocketProvider.setConfiguration({
      parameters: this.getProviderParameters(session),
    });

    this.provider.disconnect();
    void this.provider.connect();
    return true;
  }

  reconnectWithSession(session: CollabSessionInfo, options?: { preserveLocalState?: boolean }): void {
    const preserveLocalState = options?.preserveLocalState !== false;
    const recentReconnectReplayUpdates = preserveLocalState
      && this.canPersistDurableUpdates(session.role)
      ? this.getRecentReconnectReplayUpdates()
      : [];
    const canPreserveBufferedLocalState = preserveLocalState
      && this.canPersistDurableUpdates(session.role)
      && (this.hasPendingLocalStateForReconnect() || recentReconnectReplayUpdates.length > 0);
    if (canPreserveBufferedLocalState && this.marksMap) {
      this.pendingMarksSnapshot = this.readMarks();
    }
    this.pendingReconnectReplayUpdates = canPreserveBufferedLocalState
      ? recentReconnectReplayUpdates
      : [];
    if (!canPreserveBufferedLocalState) {
      this.pendingMarksSnapshot = null;
      this.recentReconnectReplayUpdates = [];
    }
    this.debugLog('reconnect', {
      preserveLocalState,
      canPreserveBufferedLocalState,
      recentReconnectReplayUpdates: recentReconnectReplayUpdates.length,
      nextRole: session.role,
    });
    // Hard reconnects change the live room identity. Replaying the entire previous
    // Y.Doc into the new room can duplicate or resurrect semantically stale content
    // when the server has already rebuilt authoritative state. Buffered local updates
    // are the only safe unit of preservation across that boundary.
    this.disconnect();
    this.connect(session, { replayDurableBuffer: canPreserveBufferedLocalState });
  }

  setProjectionMarkdown(markdown: string): void {
    if (this.activeSession) {
      this.debugLog('skip-projection-write-live-session', {
        markdownLength: markdown.length,
        slug: this.activeSession.slug,
        role: this.sessionRole,
      });
      return;
    }
    if (!this.sessionRole || !this.canPersistDurableUpdates(this.sessionRole)) {
      this.debugLog('skip-projection-write-readonly', { markdownLength: markdown.length });
      return;
    }
    if (!this.ydoc || !this.markdownText) return;
    const currentMarkdown = this.markdownText.toString();
    if (currentMarkdown === markdown) return;
    this.ydoc.transact(() => {
      if (this.markdownText) {
        applyYTextDiff(this.markdownText, markdown);
      }
    }, 'local-projection-sync');
    if (this.unsyncedChanges === 0) {
      this.unsyncedChanges = 1;
      this.emitSyncStatus();
    }
  }

  setMarksMetadata(marks: Record<string, unknown>): void {
    if (!this.ydoc || !this.marksMap) {
      this.pendingMarksSnapshot = { ...marks };
      return;
    }
    if (!this.sessionRole || !this.canPersistDurableUpdates(this.sessionRole)) {
      this.debugLog('skip-marks-write-readonly', { markCount: Object.keys(marks).length });
      return;
    }
    const currentMarksSnapshot = this.readMarks();
    const mergedMarks: Record<string, unknown> = { ...marks };
    this.marksMap.forEach((value, key) => {
      if (mergedMarks[key] !== undefined) return;
      if (!shouldPreserveMissingLocalMark(value)) return;
      mergedMarks[key] = value as unknown;
    });
    const currentKeys = Object.keys(currentMarksSnapshot);
    const nextKeys = Object.keys(mergedMarks);
    const sameKeyCount = currentKeys.length === nextKeys.length;
    const sameKeys = sameKeyCount && currentKeys.every((key) => Object.prototype.hasOwnProperty.call(mergedMarks, key));
    const marksChanged = !sameKeys || nextKeys.some((key) => !deepEqual(currentMarksSnapshot[key], mergedMarks[key]));
    if (!marksChanged) return;

    this.applyingLocalMarks = true;
    try {
      this.ydoc.transact(() => {
        const nextMarkKeys = new Set(Object.keys(mergedMarks));
        this.marksMap?.forEach((_value, key) => {
          if (!nextMarkKeys.has(key)) this.marksMap?.delete(key);
        });
        for (const [key, value] of Object.entries(mergedMarks)) {
          if (!deepEqual(currentMarksSnapshot[key], value)) {
            this.marksMap?.set(key, value);
          }
        }
      }, 'local-marks-sync');
    } finally {
      this.applyingLocalMarks = false;
    }
    if (this.unsyncedChanges === 0) {
      this.unsyncedChanges = 1;
      this.emitSyncStatus();
    }
  }

  flushPendingLocalStateForUnload(): void {
    if (this.durablePendingUpdates.length === 0) return;
    this.flushDurableBuffer();
  }

  disconnect(): void {
    if (this.documentUpdatedResyncTimer !== null) {
      clearTimeout(this.documentUpdatedResyncTimer);
      this.documentUpdatedResyncTimer = null;
    }
    if (this.durablePendingUpdates.length > 0) {
      this.flushDurableBuffer();
    }
    if (this.durableFlushTimer !== null) {
      clearTimeout(this.durableFlushTimer);
      this.durableFlushTimer = null;
    }
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    if (this.ydoc) {
      this.ydoc.destroy();
      this.ydoc = null;
    }
    this.markdownText = null;
    this.marksMap = null;
    this.activeSession = null;
    this.lastDisconnectAt = null;
    this.connectionStatus = 'disconnected';
    this.unsyncedChanges = 0;
    this.hasSynced = false;
    this.applyingLocalMarks = false;
    this.terminalCloseReason = null;
    this.lastAuthenticationFailureReason = null;
    this.sessionRole = null;
    this.emitSyncStatus();
  }
}

export const collabClient = new CollabClient();
