import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function setMarkdown(doc: Y.Doc, value: string): void {
  const text = doc.getText('markdown');
  const current = text.toString();
  if (current.length > 0) text.delete(0, current.length);
  if (value.length > 0) text.insert(0, value);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-build-session-evict-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `build-session-evict-${Math.random().toString(36).slice(2, 10)}`;
  const markdownA = '# Doc\n\nOriginal content.';
  const markdownB = '# Doc\n\nCanonical content from another instance.';

  try {
    db.createDocument(slug, markdownA, {}, 'build session stale version eviction');

    const ydocA = new Y.Doc();
    setMarkdown(ydocA, markdownA);
    const updateA = Y.encodeStateAsUpdate(ydocA);
    const seqA = db.appendYUpdate(slug, updateA, 'seed');
    db.saveYSnapshot(slug, seqA, updateA);

    await collab.startCollabRuntimeEmbedded(4000);
    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected collab runtime to expose hocuspocus test instance');

    const loadedDoc = await instance.createDocument(
      slug,
      {},
      'stale-version-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(
      String(loadedDoc.getText('markdown').toString()).includes('Original content.'),
      'Expected loaded collab doc to start at original content',
    );
    assert(collab.__unsafeGetLoadedDocForTests(slug), 'Expected loaded doc to be cached before external update');

    const ydocB = new Y.Doc();
    Y.applyUpdate(ydocB, updateA);
    setMarkdown(ydocB, markdownB);
    const deltaB = Y.encodeStateAsUpdate(ydocB, Y.encodeStateVector(ydocA));
    db.appendYUpdate(slug, deltaB, 'external-edit');
    const updated = db.updateDocument(slug, markdownB);
    assert(updated, 'Expected external canonical update to persist');

    const session = collab.buildCollabSession(slug, 'editor', { wsUrlBase: 'ws://localhost:5555/ws' });
    assert(Boolean(session), 'Expected buildCollabSession to succeed');
    assert(!collab.__unsafeGetLoadedDocForTests(slug), 'Expected buildCollabSession to evict stale loaded doc after persisted version bump');

    const reloadedDoc = await instance.createDocument(
      slug,
      {},
      'reloaded-version-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    assert(
      String(reloadedDoc.getText('markdown').toString()).includes('Canonical content from another instance.'),
      'Expected subsequent collab load to hydrate the newer canonical content',
    );

    console.log('✓ buildCollabSession evicts stale loaded docs when persisted Yjs version advances');
  } finally {
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
