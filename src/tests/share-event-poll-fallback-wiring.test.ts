import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shareClientSource = readFileSync(path.join(repoRoot, 'src', 'bridge', 'share-client.ts'), 'utf8');
const editorSource = readFileSync(path.join(repoRoot, 'src', 'editor', 'index.ts'), 'utf8');

assert(
  shareClientSource.includes('async fetchPendingEvents(')
    && shareClientSource.includes('/agent/${this.slug}/events/pending?'),
  'Expected ShareClient to expose a pending-events fetch helper for cross-instance share refresh fallback',
);

assert(
  editorSource.includes('this.startShareEventPoll();'),
  'Expected share-mode editor startup to begin the pending-events poll fallback',
);

assert(
  editorSource.includes("return event.type.startsWith('comment.')")
    && editorSource.includes("|| event.type.startsWith('suggestion.');")
    && editorSource.includes('this.scheduleShareMarksRefresh();')
    && editorSource.includes('this.pendingShareMarksRefresh = true;')
    && editorSource.includes('clearTimeout(this.shareMarksRefreshTimer);')
    && editorSource.includes('void shareClient.fetchOpenContext()')
    && editorSource.includes('this.applyAuthoritativeShareMarks(serverMarks);')
    && editorSource.includes("event.type === 'agent.edit.v2'")
    && editorSource.includes('private shouldSkipForcedCollabRefreshFromPendingEvent(): boolean')
    && editorSource.includes("this.collabConnectionStatus === 'connected'")
    && editorSource.includes('this.collabIsSynced')
    && editorSource.includes('if (this.shouldSkipForcedCollabRefreshFromPendingEvent()) return;')
    && editorSource.includes('this.scheduleShareDocumentUpdatedRefresh(true);'),
  'Expected pending comment/suggestion events to refresh authoritative marks and to skip forced collab refresh when the live room is already healthy',
);

assert(
  editorSource.includes('private stopShareEventPoll(): void')
    && editorSource.includes('private scheduleShareMarksRefresh(): void')
    && editorSource.includes('private shareMarksRefreshTimer: ReturnType<typeof setTimeout> | null = null;')
    && editorSource.includes('private pendingShareMarksRefresh: boolean = false;')
    && editorSource.includes('if (this.shareMarksRefreshTimer) {')
    && editorSource.includes('this.stopShareEventPoll();'),
  'Expected share event poller and marks refresh timer to be cleaned up during share/editor teardown',
);

console.log('✓ share event poll fallback wiring checks');
