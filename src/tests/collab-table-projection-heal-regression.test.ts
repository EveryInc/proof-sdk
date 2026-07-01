// Regression: healCanonicalMarkdownForCollabFragment un-wedges an EXISTING doc
// that was created (before the write-time fix) with a raw GFM table. Such a doc
// stores raw canonical markdown that never matches the fragment serialization
// (the Milkdown GFM serializer pads columns and injects `:---` markers), so its
// projection is permanently stale and every agent mutation returns 409
// PROJECTION_STALE. The heal rewrites canonical to the fragment serialization so
// the two converge.
//
// The wedge condition is: markdown derived from the seeded Yjs fragment != the
// stored canonical markdown. That is exactly what the projection-repair and
// snapshot paths compare, so this test asserts on that derived form.

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-table-heal-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { getHeadlessMilkdownParser, serializeMarkdown } = await import('../../server/milkdown-headless.ts');

  async function fragmentDerivedMarkdown(): Promise<string> {
    const handle = await collab.loadCanonicalYDoc(slug);
    const parser = await getHeadlessMilkdownParser();
    const root = yXmlFragmentToProseMirrorRootNode(
      handle!.ydoc.getXmlFragment('prosemirror') as any,
      parser.schema as any,
    );
    return serializeMarkdown(root as any);
  }

  const slug = `table-heal-${Math.random().toString(36).slice(2, 10)}`;
  // Raw, un-normalized table markdown — how a pre-fix doc was stored.
  const rawMarkdown = [
    '# Heal Doc',
    '',
    '| A | B |',
    '| --- | --- |',
    '| one | two |',
    '| three | four |',
    '',
  ].join('\n');

  try {
    // Simulate a pre-fix document: raw markdown stored directly (bypassing the
    // create route's normalization).
    db.createDocument(slug, rawMarkdown, {}, 'table projection heal');

    // Pre-heal: the fragment serialization diverges from stored canonical — this
    // is the wedge (projection can never converge; agent mutations 409).
    const derivedBefore = await fragmentDerivedMarkdown();
    const canonicalBefore = db.getDocumentBySlug(slug)?.markdown ?? '';
    assert(
      derivedBefore !== canonicalBefore,
      'Precondition: raw-table doc should be wedged (fragment serialization != canonical)',
    );

    // Heal it.
    const result = await collab.healCanonicalMarkdownForCollabFragment(slug);
    assert(result.healed, `Expected heal to run, got reason=${result.reason}`);

    // Post-heal: canonical now equals the fragment serialization — converged.
    const derivedAfter = await fragmentDerivedMarkdown();
    const canonicalAfter = db.getDocumentBySlug(slug)?.markdown ?? '';
    assert(
      derivedAfter === canonicalAfter,
      `Post-heal: fragment serialization must equal canonical.\nCanonical:\n${JSON.stringify(canonicalAfter)}\n\nDerived:\n${JSON.stringify(derivedAfter)}`,
    );

    // Content preserved.
    assert(
      canonicalAfter.includes('one') && canonicalAfter.includes('four'),
      'Table content must be preserved after heal',
    );

    // The heal updates canonical + projection but leaves the Yjs `markdown` text
    // mirror as-seeded. Confirm the sync read path does not re-wedge on a
    // canonical-vs-mirror mismatch (loaded_doc_ahead).
    const readable = collab.getCanonicalReadableDocumentSync(slug, 'snapshot');
    assert(Boolean(readable), 'Expected a readable document post-heal');
    assert(
      (readable as any).read_source === 'projection' && (readable as any).mutation_ready === true,
      `Post-heal sync read must be fresh + writable, not re-wedged. read_source=${(readable as any)?.read_source} mutation_ready=${(readable as any)?.mutation_ready}`,
    );

    // Idempotent: a second heal is a no-op.
    const second = await collab.healCanonicalMarkdownForCollabFragment(slug);
    assert(!second.healed && second.reason === 'already_canonical', `Second heal should be a no-op, got ${JSON.stringify(second)}`);

    console.log('✓ heal un-wedges an existing raw-table doc and is idempotent');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDbPath;
    }
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

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
