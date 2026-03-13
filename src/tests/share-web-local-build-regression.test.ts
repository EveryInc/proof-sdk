import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const tempDistDir = mkdtempSync(path.join(os.tmpdir(), 'proof-share-web-dist-'));
  mkdirSync(tempDistDir, { recursive: true });
  writeFileSync(path.join(tempDistDir, 'index.html'), '<!doctype html><title>test</title>');

  const previousOverride = process.env.PROOF_WEB_DIST_DIR;
  process.env.PROOF_WEB_DIST_DIR = tempDistDir;

  try {
    const shareWebModule = await import(`../../packages/doc-server/src/share-web-routes.ts?ts=${Date.now()}`);
    assert(
      shareWebModule.resolveShareEditorDistPath() === tempDistDir,
      'Expected share web routes to honor PROOF_WEB_DIST_DIR for local editor build resolution',
    );
  } finally {
    if (previousOverride === undefined) {
      delete process.env.PROOF_WEB_DIST_DIR;
    } else {
      process.env.PROOF_WEB_DIST_DIR = previousOverride;
    }
  }

  const serverIndexSource = readFileSync(path.resolve(process.cwd(), 'server/index.ts'), 'utf8');
  assert(
    serverIndexSource.includes("app.use(express.static(builtWebDistDir, { index: false }));"),
    'Expected root server to serve built web artifacts from dist/ for local /d/:slug testing',
  );

  console.log('share-web-local-build-regression.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
