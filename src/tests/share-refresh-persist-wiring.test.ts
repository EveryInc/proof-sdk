import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, '../editor/index.ts'), 'utf8');

assert(
  source.includes("this.flushShareMarks({ keepalive: true, persistContent: true });"),
  'Expected lifecycle handlers to force a keepalive content flush for share refresh/unload',
);

assert(
  source.includes('collabClient.flushPendingLocalStateForUnload();'),
  'Expected share lifecycle handlers to synchronously flush buffered live Yjs state on unload/visibility transitions',
);

assert(
  source.includes("window.addEventListener('pagehide', () => {"),
  'Expected pagehide to trigger the share keepalive content flush path',
);

assert(
  source.includes("void shareClient.pushUpdate(markdown, metadata, getCurrentActor(), {"),
  'Expected share lifecycle flush to persist content through shareClient.pushUpdate',
);

assert(
  source.includes("document.visibilityState === 'hidden' && this.isShareMode"),
  'Expected share visibilitychange handling to stay wired for keepalive persistence',
);

assert(
  source.includes("this.flushShareMarks({ keepalive: true, persistContent: true });"),
  'Expected hidden-page lifecycle flushes to use the same keepalive content persistence path',
);

assert(
  !source.includes("const markdownSnapshot = this.getMarkdownSnapshot()?.content ?? null;"),
  'Expected keepalive content persistence not to resurrect embedded proof-span snapshots during unload recovery',
);

console.log('✓ share refresh lifecycle wiring includes the keepalive content flush path');
