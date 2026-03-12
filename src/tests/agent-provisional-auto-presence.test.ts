import { unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const DEFAULT_TIMEOUT_MS = 10_000;

type ShareCreateResponse = {
  slug: string;
  ownerSecret: string;
};

type CollabSessionPayload = {
  success: boolean;
  session: {
    slug: string;
    collabWsUrl: string;
    token: string;
    role: 'viewer' | 'commenter' | 'editor' | 'owner_bot';
  };
};

type AgentStateResponse = {
  success: boolean;
  updatedAt: string;
  revision: number;
};

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function mustJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return JSON.parse(text) as T;
}

async function run(): Promise<void> {
  const dbName = `proof-auto-presence-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_PRESENCE_TTL_MS = '5000';
  process.env.AGENT_CURSOR_TTL_MS = '5000';
  process.env.AGENT_EDIT_V2_ENABLED = '1';

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
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  let provider: HocuspocusProvider | null = null;
  const ydoc = new Y.Doc();
  let connected = false;
  let synced = false;

  const AGENT_UA = 'Claw/1.0';
  const expectedAutoId = 'ai:auto-' + createHash('sha1').update(AGENT_UA).digest('hex').slice(0, 8);

  try {
    // Create document.
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Auto Presence\n\n## Notes\n\nOriginal.\n',
        marks: {},
        title: 'Provisional auto-presence test',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    assert(created.slug.length > 0, 'Expected create response slug');
    assert(created.ownerSecret.length > 0, 'Expected create response ownerSecret');

    // Set up collab session + WebSocket.
    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const sessionPayload = await mustJson<CollabSessionPayload>(sessionRes);
    assert(sessionPayload.success === true, 'Expected collab-session success');

    const wsUrl = (() => {
      const raw = sessionPayload.session.collabWsUrl.replace(/\\?slug=.*$/, '');
      try {
        const url = new URL(raw);
        if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
        return url.toString();
      } catch {
        return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
      }
    })();

    provider = new HocuspocusProvider({
      url: wsUrl,
      name: created.slug,
      document: ydoc,
      parameters: { token: sessionPayload.session.token, role: sessionPayload.session.role },
      token: sessionPayload.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      const state = event?.state;
      if (state !== false) synced = true;
    });

    await waitFor(() => connected, DEFAULT_TIMEOUT_MS, 'provider connected');
    await waitFor(() => synced, DEFAULT_TIMEOUT_MS, 'provider synced');

    const presenceMap: any = ydoc.getMap('agentPresence');
    assert(presenceMap.size === 0, 'Expected agentPresence to start empty');

    // Step 1: Make a request with non-browser UA and no x-agent-id.
    // This should trigger provisional auto-presence.
    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
        'user-agent': AGENT_UA,
      },
    });
    const statePayload = await mustJson<AgentStateResponse>(stateRes);
    assert(typeof statePayload.updatedAt === 'string', 'Expected updatedAt from state');

    await waitFor(
      () => Boolean(presenceMap.get(expectedAutoId)),
      DEFAULT_TIMEOUT_MS,
      'provisional auto-presence appears',
    );

    const autoPresence = presenceMap.get(expectedAutoId) as any;
    assert(autoPresence?.name === 'AI collaborator', 'Expected auto-presence name to be "AI collaborator"');
    assert(autoPresence?.status === 'active', 'Expected auto-presence status to be "active"');
    assert(autoPresence?.id === expectedAutoId, `Expected auto-presence id to be "${expectedAutoId}"`);

    console.log(`✓ Provisional auto-presence created for non-browser UA (${expectedAutoId})`);

    // Step 2: Make a request with the same UA but now with an explicit x-agent-id.
    // This should evict the provisional auto-presence and create named presence.
    const namedAgentId = 'ai:real-agent';
    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
        'x-agent-id': 'real-agent',
        'user-agent': AGENT_UA,
      },
      body: JSON.stringify({
        by: namedAgentId,
        name: 'Real Agent',
        color: '#38bdf8',
        baseRevision: statePayload.revision,
        operations: [
          { op: 'insert_after', ref: 'b3', blocks: [{ markdown: 'Appended by real agent.' }] },
        ],
      }),
    });
    assert(editRes.ok, `Expected edit/v2 to succeed, got HTTP ${editRes.status}`);

    // The named agent should appear and the provisional one should be gone.
    await waitFor(
      () => Boolean(presenceMap.get(namedAgentId)),
      DEFAULT_TIMEOUT_MS,
      'named agent presence appears',
    );
    const namedPresence = presenceMap.get(namedAgentId) as any;
    assert(namedPresence?.name === 'Real Agent', 'Expected named presence name to be "Real Agent"');

    // Provisional auto-presence should be evicted.
    await waitFor(
      () => !presenceMap.get(expectedAutoId),
      DEFAULT_TIMEOUT_MS,
      'provisional auto-presence evicted after named agent joins',
    );

    console.log('✓ Provisional auto-presence evicted when named agent joins with same UA');

    // Step 3: Verify browser UA does NOT create auto-presence.
    const browserRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    assert(browserRes.ok, 'Expected browser state request to succeed');
    await sleep(200);

    let browserAutoPresenceFound = false;
    presenceMap.forEach((entry: any) => {
      if (typeof entry?.id === 'string' && entry.id.startsWith('ai:auto-') && entry.id !== expectedAutoId) {
        browserAutoPresenceFound = true;
      }
    });
    assert(!browserAutoPresenceFound, 'Expected NO auto-presence for browser user-agent');

    console.log('✓ Browser user-agent correctly excluded from provisional auto-presence');

    // Step 4: Verify Claude UA does NOT create auto-presence.
    const claudeRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
        'user-agent': 'Claude-Agent/2.0',
      },
    });
    assert(claudeRes.ok, 'Expected Claude state request to succeed');
    await sleep(200);

    let claudeAutoPresenceFound = false;
    presenceMap.forEach((entry: any) => {
      if (typeof entry?.id === 'string' && entry.id.startsWith('ai:auto-') && entry.id !== expectedAutoId) {
        claudeAutoPresenceFound = true;
      }
    });
    assert(!claudeAutoPresenceFound, 'Expected NO auto-presence for Claude user-agent');

    console.log('✓ Claude user-agent correctly excluded from provisional auto-presence');
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
      // ignore
    }
    ydoc.destroy();
    try { wss.close(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
