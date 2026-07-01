// Regression: a document containing a GFM markdown table must not wedge its
// projection. Before the fix, seeding the Yjs fragment from a table doc produced
// markdown that differed from the stored canonical (the Milkdown GFM serializer
// pads columns and injects `:---` alignment markers), so the projection was
// permanently stale — readSource=yjs_fallback, mutationReady=false, and every
// agent mutation returned 409 PROJECTION_STALE while browser edits were dropped.
//
// The fix normalizes canonical markdown at write time so the stored canonical
// equals what the fragment serializes back to. This test asserts the doc stays
// projection-fresh after seeding, and that the seed→derive round trip is byte
// exact against the stored canonical.

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-table-freshness-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { getHeadlessMilkdownParser, serializeMarkdown } = await import('../../server/milkdown-headless.ts');

  const slug = `table-fresh-${Math.random().toString(36).slice(2, 10)}`;
  const markdown = [
    '# Table Doc',
    '',
    'Intro paragraph.',
    '',
    '| Name | Role | Notes |',
    '| --- | --- | --- |',
    '| Alice | Engineer | Works on collab |',
    '| Bob | Designer | Owns the editor UI |',
    '',
  ].join('\n');

  try {
    // The create route stores canonical markdown in the collab fragment's
    // serialization (deriveCanonicalMarkdownForStorage). Mirror that here so the
    // test exercises the shipped normalization, not raw storage.
    const canonicalMarkdown = await collab.deriveCanonicalMarkdownForStorage(markdown);
    db.createDocument(slug, canonicalMarkdown, {}, 'table projection freshness');

    // Seed the canonical Yjs fragment (this is what a first read / browser
    // connection triggers).
    const handle = await collab.loadCanonicalYDoc(slug);
    assert(Boolean(handle), 'Expected canonical Yjs handle');

    // The stored canonical markdown after creation. With the fix it is the
    // serializer-canonical form; without a table it is unchanged.
    const stored = db.getDocumentBySlug(slug);
    assert(Boolean(stored), 'Expected document row after canonical load');
    const storedMarkdown = stored?.markdown ?? '';

    // The seed -> derive round trip must be byte-exact against the STORED
    // canonical, or the projection freshness check can never converge.
    const parser = await getHeadlessMilkdownParser();
    const root = yXmlFragmentToProseMirrorRootNode(
      handle!.ydoc.getXmlFragment('prosemirror') as any,
      parser.schema as any,
    );
    const serialized = await serializeMarkdown(root as any);
    assert(
      serialized === storedMarkdown,
      `Fragment must round-trip to the stored canonical markdown.\nStored:\n${JSON.stringify(storedMarkdown)}\n\nSerialized:\n${JSON.stringify(serialized)}`,
    );

    // The read surface must serve the projection and stay writable — otherwise
    // the doc is wedged (yjs_fallback / mutation_ready=false / 409 PROJECTION_STALE).
    const readable = collab.getCanonicalReadableDocumentSync(slug, 'snapshot');
    assert(Boolean(readable), 'Expected a readable document');
    assert(
      (readable as any).read_source === 'projection' && (readable as any).mutation_ready === true,
      `Table document must not wedge. read_source=${(readable as any)?.read_source} mutation_ready=${(readable as any)?.mutation_ready}`,
    );

    // The table's semantic content must survive normalization.
    assert(storedMarkdown.includes('Alice') && storedMarkdown.includes('Bob'), 'Table content must be preserved');

    // Pin the corrected VALUE, not just self-consistency: the stored canonical
    // must be the fragment fixed point, which serializes tables with explicit
    // `:--` alignment markers. Raw input (`---`) or a plain parse->serialize
    // (also `---`) would wedge; only the fragment form has the colon markers.
    assert(
      /\|\s*:--/.test(storedMarkdown),
      `Stored canonical must be the fragment form (\`:--\` alignment markers), got:\n${JSON.stringify(storedMarkdown)}`,
    );

    console.log('✓ table document stays projection-fresh and round-trips to stored canonical');
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
