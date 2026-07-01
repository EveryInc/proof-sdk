import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next < 0) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type CreateResponse = { slug: string; ownerSecret: string };
type ReadDocResponse = { markdown: string };
type StateResponse = { updatedAt: string };
type CollabSessionResponse = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
  };
};

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

function normalizeWsBase(collabWsUrl: string): string {
  const raw = collabWsUrl.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(raw);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const SECTION_DIRTY = [
  '## Wednesday, Feb 25, 2026',
  '',
  '**12:00 PM** - Present at Thumbtack offsite**12:00 PM** - Present at Thumbtack offsite**12:00 PM** - Present at Thumbtack offsite',
  '',
  '**Pomodoro 1 - 9:13 AM (30 min)**',
  '',
  '* [x] Fix markdown rendering of checkboxes and links -> push to production',
  '',
  '* [x] Review podcast X copy -> respond to Rhea',
  '',
  '* [x] Diagnose and fix Brandon\'s Proof issue from claws-only',
  '',
  '**Done**',
  '',
  '* [x] Check with Natalia about Applecart (9 AM)',
  '',
  '* [x] Finish new share UX',
].join('\n');

const SECTION_CLEAN = [
  '## Wednesday, Feb 25, 2026',
  '',
  '**12:00 PM** - Present at Thumbtack offsite',
  '',
  '**Done**',
  '',
  '* [x] Check with Natalia about Applecart (9 AM)',
  '',
  '* [x] Fix markdown rendering of checkboxes and links -> push to production',
  '',
  '* [x] Review podcast X copy -> respond to Rhea',
  '',
  '* [x] Diagnose and fix Brandon\'s Proof issue from claws-only',
  '',
  '* [x] Finish new share UX',
].join('\n');

const DOC_PREFIX = [
  '# Daily Plan',
  '',
  '## Focus',
  '',
  'Live viewer regression test.',
  '',
].join('\n');

const DOC_SUFFIX = [
  '',
  '## Tuesday, Feb 24, 2026',
  '',
  '* [x] Another task',
  '',
].join('\n');

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-live-viewer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  let provider: HocuspocusProvider | null = null;
  let reconnectProvider: HocuspocusProvider | null = null;
  const ydoc = new Y.Doc();
  let reconnectDoc: Y.Doc | null = null;
  let connected = false;
  let synced = false;
  let yjsUpdates = 0;
  let currentSection = SECTION_DIRTY;
  let targetSection = SECTION_CLEAN;

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Live viewer + agent regression',
        markdown: `${DOC_PREFIX}${SECTION_DIRTY}${DOC_SUFFIX}`,
        marks: {},
      }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    // Capture the canonical markdown the server actually stored. Creation
    // normalizes markdown into the collab fragment's serialization, so the stored
    // canonical may differ cosmetically from the raw POST body (e.g. a canonical
    // blank line before a heading). The blocked-edit assertion below checks this
    // stored canonical is left unchanged, not that it equals the raw input.
    const canonicalAfterCreateRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const canonicalAfterCreate = (await mustJson<ReadDocResponse>(canonicalAfterCreateRes, 'read-after-create')).markdown;

    const collabSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const collabSession = await mustJson<CollabSessionResponse>(collabSessionRes, 'collab-session');
    assert(collabSession.success === true, 'Expected successful collab session');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(collabSession.session.collabWsUrl),
      name: collabSession.session.slug,
      document: ydoc,
      parameters: {
        token: collabSession.session.token,
        role: collabSession.session.role,
      },
      token: collabSession.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) synced = true;
    });
    ydoc.on('update', () => {
      yjsUpdates += 1;
    });

    await waitFor(() => connected, 10_000, 'provider connected');
    await waitFor(() => synced, 10_000, 'provider synced');

    const presenceRes = await fetch(`${httpBase}/api/agent/${created.slug}/presence`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
        'x-agent-id': 'r2c2',
      },
      body: JSON.stringify({
        by: 'ai:r2c2',
        agentId: 'ai:r2c2',
        name: 'R2C2',
        status: 'active',
        details: 'Regression test live agent',
      }),
    });
    const presencePayload = await mustJson<{ collabApplied?: boolean }>(presenceRes, 'presence');
    assert(presencePayload.collabApplied === true, 'Expected collab-applied agent presence');

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const state = await mustJson<StateResponse>(stateRes, 'state');
    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:r2c2',
        baseUpdatedAt: state.updatedAt,
        operations: [
          {
            op: 'replace',
            search: currentSection,
            content: targetSection,
          },
        ],
      }),
    });
    const edit = await editRes.json() as {
      success?: boolean;
      code?: string;
      recommendedEndpoint?: string;
    };
    assert(editRes.status === 409, `Expected legacy /edit to be blocked, got ${editRes.status}`);
    assert(edit.code === 'LEGACY_EDIT_UNSAFE', `Expected LEGACY_EDIT_UNSAFE, got ${String(edit.code)}`);
    assert(
      edit.recommendedEndpoint === `/api/agent/${created.slug}/edit/v2`,
      `Expected /edit/v2 guidance, got ${String(edit.recommendedEndpoint)}`,
    );

    const expectedFinal = canonicalAfterCreate;
    const readRes = await fetch(`${httpBase}/api/documents/${created.slug}`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const readDoc = await mustJson<ReadDocResponse>(readRes, 'read');
    assert(readDoc.markdown === expectedFinal, 'Expected blocked legacy /edit to leave canonical markdown unchanged');

    console.log('✓ agent /edit is blocked cleanly with live viewer + agent presence connected');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore provider shutdown errors
    }
    try {
      reconnectProvider?.disconnect();
      reconnectProvider?.destroy();
      try {
        (reconnectProvider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore provider shutdown errors
    }
    ydoc.destroy();
    reconnectDoc?.destroy();
    await collab.stopCollabRuntime();
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
