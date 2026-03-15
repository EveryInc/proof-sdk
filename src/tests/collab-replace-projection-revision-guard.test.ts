import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-replace-projection-revision-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');

  const markdownOriginal = '# Doc\n\nOriginal content.';
  const markdownYjsProjection = '# Doc\n\nYjs-derived content (from stale snapshot).';
  const markdownAgentEdit = '# Doc\n\nAgent edit content (should be preserved).';

  try {
    // ── Case 1: expectedRevision matches → update goes through ──────────────
    const slug1 = `revision-guard-match-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug1, markdownOriginal, {}, 'revision guard test');
    const row1Before = db.getDocumentBySlug(slug1);
    assert(row1Before?.revision === 1, 'Expected initial revision to be 1');

    const replaced1 = db.replaceDocumentProjection(slug1, markdownYjsProjection, {}, undefined, 1);
    assert(replaced1, 'Expected replaceDocumentProjection to succeed when expectedRevision matches');
    const row1After = db.getDocumentBySlug(slug1);
    assert(
      (row1After?.markdown ?? '').includes('Yjs-derived'),
      `Expected Yjs projection to be written when revision matches. markdown=${row1After?.markdown}`,
    );

    // ── Case 2: agent edit bumps revision, stale expectedRevision → no-op ───
    const slug2 = `revision-guard-stale-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug2, markdownOriginal, {}, 'revision guard stale test');
    const row2AtSnapshot = db.getDocumentBySlug(slug2);
    assert(row2AtSnapshot?.revision === 1, 'Expected initial revision to be 1');

    // Simulate agent HTTP edit: bumps revision 1 → 2
    const agentUpdated = db.updateDocument(slug2, markdownAgentEdit);
    assert(agentUpdated, 'Expected agent updateDocument to succeed');
    const row2AfterAgent = db.getDocumentBySlug(slug2);
    assert(row2AfterAgent?.revision === 2, `Expected revision to be 2 after agent edit, got ${row2AfterAgent?.revision}`);

    // Yjs persist fires with stale snapshot revision (1) → should be a no-op
    const replaced2 = db.replaceDocumentProjection(slug2, markdownYjsProjection, {}, undefined, 1);
    assert(!replaced2, 'Expected replaceDocumentProjection to be a no-op when expectedRevision is stale');
    const row2Final = db.getDocumentBySlug(slug2);
    assert(
      (row2Final?.markdown ?? '').includes('Agent edit'),
      `Expected agent content to be preserved after stale Yjs projection attempt. markdown=${row2Final?.markdown}`,
    );
    assert(
      !(row2Final?.markdown ?? '').includes('Yjs-derived'),
      `Expected Yjs-derived content NOT to overwrite agent edit. markdown=${row2Final?.markdown}`,
    );
    assert(row2Final?.revision === 2, `Expected revision to remain 2 after no-op. got ${row2Final?.revision}`);

    // ── Case 3: no expectedRevision → backward-compat unconditional UPDATE ──
    const slug3 = `revision-guard-compat-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug3, markdownOriginal, {}, 'revision guard compat test');
    db.updateDocument(slug3, markdownAgentEdit); // revision → 2

    const replaced3 = db.replaceDocumentProjection(slug3, markdownYjsProjection, {});
    assert(replaced3, 'Expected unconditional UPDATE when expectedRevision is omitted (backward-compat)');
    const row3Final = db.getDocumentBySlug(slug3);
    assert(
      (row3Final?.markdown ?? '').includes('Yjs-derived'),
      `Expected Yjs projection to overwrite when no expectedRevision. markdown=${row3Final?.markdown}`,
    );

    console.log('✓ replaceDocumentProjection revision guard: stale Yjs projection cannot overwrite a newer agent edit');
  } finally {
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
