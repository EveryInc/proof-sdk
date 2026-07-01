// Regression: POST /documents (and the direct share-markdown route) must
// normalize canonical markdown to the collab fragment form so a table doc does
// not wedge. This exercises the actual HTTP route — the freshness unit test
// bypasses it by calling deriveCanonicalMarkdownForStorage directly, so without
// this test, deleting the route's normalization call would pass CI.

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-table-route-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const [{ apiRoutes }, collab, db] = await Promise.all([
    import('../../server/routes.ts'),
    import('../../server/collab.ts'),
    import('../../server/db.ts'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const rawTable = '# Route Doc\n\n| Name | Role |\n| --- | --- |\n| Alice | Eng |\n| Bob | Design |\n';

  try {
    const createRes = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Route Doc', markdown: rawTable }),
    });
    assert(createRes.status === 200 || createRes.status === 201, `Create failed: HTTP ${createRes.status}`);
    const created = await createRes.json() as { slug: string };

    // The route must have normalized the stored canonical to the fragment form
    // (`:--` alignment markers), not stored the raw `---` table the client
    // POSTed — otherwise the doc wedges on first load.
    const stored = db.getDocumentBySlug(created.slug)?.markdown ?? '';
    assert(
      /\|\s*:--/.test(stored),
      `POST /documents must normalize the table to fragment form. Stored:\n${JSON.stringify(stored)}`,
    );
    // The re-derived fragment must equal the stored canonical (no wedge).
    const readable = collab.getCanonicalReadableDocumentSync(created.slug, 'snapshot');
    assert(
      (readable as any)?.read_source === 'projection' && (readable as any)?.mutation_ready === true,
      `Route-created table doc must not wedge. read_source=${(readable as any)?.read_source} mutation_ready=${(readable as any)?.mutation_ready}`,
    );
    // Content preserved.
    assert(stored.includes('Alice') && stored.includes('Bob'), 'Table content must survive');

    console.log('✓ POST /documents normalizes table markdown so the doc does not wedge');
  } finally {
    server.close();
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
