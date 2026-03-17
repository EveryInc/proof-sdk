import assert from 'node:assert/strict';
import { buildShareMutationBaseToken } from '../bridge/share-mutation-base.js';

type FetchRecord = {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withMockedEnvironment(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  runCase: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;

  (globalThis as { window: Record<string, unknown> }).window = {
    location: new URL('https://proof-web-staging.up.railway.app/d/test-doc?token=share-token'),
    __PROOF_CONFIG__: {
      proofClientVersion: '0.31.2',
      proofClientBuild: 'test',
      proofClientProtocol: '3',
    },
  };
  globalThis.fetch = fetchImpl;

  try {
    await runCase();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
}

async function runBaseTokenCase(): Promise<void> {
  const requests: FetchRecord[] = [];
  const markdown = 'Sup dude!\n\nDoes this work? Seems to!\n';
  const marks = {
    authored: {
      kind: 'authored',
      by: 'human:Dan',
      createdAt: '2026-03-14T23:00:00.000Z',
      startRel: 'text:0',
      endRel: 'text:8',
      quote: 'Sup dude!',
    },
  };

  await withMockedEnvironment(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
    requests.push({ path: url.pathname, method, body });

    if (url.pathname === '/api/documents/test-doc/open-context') {
      return jsonResponse({
        success: true,
        doc: {
          slug: 'test-doc',
          title: 'Test',
          markdown,
          marks,
          updatedAt: '2026-03-14T23:00:00.000Z',
        },
        session: {
          docId: 'doc-1',
          slug: 'test-doc',
          role: 'editor',
          shareState: 'ACTIVE',
          accessEpoch: 7,
          syncProtocol: 'pm-yjs-v1',
          collabWsUrl: 'ws://127.0.0.1:1234/ws',
          token: 'session-token',
          snapshotVersion: 1,
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com', snapshotUrl: null },
      });
    }
    if (url.pathname === '/api/documents/test-doc' && method === 'PUT') {
      return jsonResponse({ success: true, updatedAt: '2026-03-14T23:00:01.000Z' });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  }, async () => {
    const { shareClient } = await import('../bridge/share-client.js');
    shareClient.refreshRuntimeConfig();
    const openContext = await shareClient.fetchOpenContext();
    assert(openContext && !('error' in openContext), 'Expected open context to load');
    const success = await shareClient.pushUpdate(markdown, marks, 'human:Dan', {
      keepalive: true,
      allowLocalKeepaliveBaseToken: true,
    });
    assert.equal(success, true, 'Expected keepalive pushUpdate to succeed');
  });

  const pushUpdateRequest = requests.find((request) => request.path === '/api/documents/test-doc' && request.method === 'PUT');
  const expectedToken = await buildShareMutationBaseToken({ markdown, marks, accessEpoch: 7 });
  assert.equal(pushUpdateRequest?.body?.baseToken, expectedToken, 'Expected keepalive pushUpdate to include the current live-state base token');
  assert.equal(pushUpdateRequest?.body?.baseUpdatedAt, undefined, 'Expected keepalive pushUpdate to prefer baseToken over baseUpdatedAt when access epoch is known');
}

async function runBaseUpdatedAtFallbackCase(): Promise<void> {
  const requests: FetchRecord[] = [];

  await withMockedEnvironment(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
    requests.push({ path: url.pathname, method, body });

    if (url.pathname === '/api/documents/test-doc' && method === 'PUT') {
      return jsonResponse({ success: true, updatedAt: '2026-03-14T23:30:01.000Z' });
    }
    if (url.pathname === '/api/documents/test-doc') {
      return jsonResponse({
        slug: 'test-doc',
        title: 'Test',
        markdown: 'Hello world\n',
        marks: {},
        updatedAt: '2026-03-14T23:30:00.000Z',
      });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  }, async () => {
    const { shareClient } = await import('../bridge/share-client.js');
    shareClient.refreshRuntimeConfig();
    const doc = await shareClient.fetchDocument();
    assert(doc, 'Expected fetchDocument to succeed');
    const success = await shareClient.pushUpdate('Hello world\n', {}, 'human:Dan', { keepalive: true });
    assert.equal(success, true, 'Expected keepalive pushUpdate to succeed with updatedAt fallback');
  });

  const pushUpdateRequest = requests.find((request) => request.path === '/api/documents/test-doc' && request.method === 'PUT');
  assert.equal(pushUpdateRequest?.body?.baseUpdatedAt, '2026-03-14T23:30:00.000Z', 'Expected keepalive pushUpdate to fall back to the last observed updatedAt when no access epoch is known');
}

async function runAccessEpochFallbackCase(): Promise<void> {
  const requests: FetchRecord[] = [];
  const markdown = 'Hello from a fast refresh\n';

  await withMockedEnvironment(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
    requests.push({ path: url.pathname, method, body });

    if (url.pathname === '/api/documents/test-doc/open-context') {
      return jsonResponse({
        success: true,
        doc: {
          slug: 'test-doc',
          title: 'Test',
          markdown: 'Initial line\n',
          marks: {},
          updatedAt: '2026-03-14T23:45:00.000Z',
        },
        mutationBase: {
          token: 'observed-open-context-base-token',
          source: 'live_yjs',
          schemaVersion: 1,
        },
        session: {
          docId: 'doc-1',
          slug: 'test-doc',
          role: 'editor',
          shareState: 'ACTIVE',
          accessEpoch: 11,
          syncProtocol: 'pm-yjs-v1',
          collabWsUrl: 'ws://127.0.0.1:1234/ws',
          token: 'session-token',
          snapshotVersion: 1,
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com', snapshotUrl: null },
      });
    }
    if (url.pathname === '/api/documents/test-doc' && method === 'PUT') {
      return jsonResponse({ success: true, updatedAt: '2026-03-14T23:45:01.000Z' });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  }, async () => {
    const { shareClient } = await import('../bridge/share-client.js');
    shareClient.refreshRuntimeConfig();
    const openContext = await shareClient.fetchOpenContext();
    assert(openContext && !('error' in openContext), 'Expected open context to load');
    const success = await shareClient.pushUpdate(markdown, {}, 'human:Dan', {
      keepalive: true,
      allowLocalKeepaliveBaseToken: false,
    });
    assert.equal(success, true, 'Expected keepalive pushUpdate to fall back to updatedAt when local collab state is not fully synced');
  });

  const pushUpdateRequest = requests.find((request) => request.path === '/api/documents/test-doc' && request.method === 'PUT');
  assert.equal(pushUpdateRequest?.body?.baseToken, 'observed-open-context-base-token', 'Expected keepalive pushUpdate to reuse the last observed authoritative base when collab is not fully synced');
  assert.equal(pushUpdateRequest?.body?.baseUpdatedAt, undefined, 'Expected keepalive pushUpdate to prefer the last observed authoritative base over updatedAt when one is available');
}

async function runObservedBaseClearsAfterSuccessfulWriteCase(): Promise<void> {
  const requests: FetchRecord[] = [];

  await withMockedEnvironment(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
    requests.push({ path: url.pathname, method, body });

    if (url.pathname === '/api/documents/test-doc/open-context') {
      return jsonResponse({
        success: true,
        doc: {
          slug: 'test-doc',
          title: 'Test',
          markdown: 'Initial line\n',
          marks: {},
          updatedAt: '2026-03-14T23:50:00.000Z',
        },
        mutationBase: {
          token: 'observed-open-context-base-token',
          source: 'live_yjs',
          schemaVersion: 1,
        },
        session: {
          docId: 'doc-1',
          slug: 'test-doc',
          role: 'editor',
          shareState: 'ACTIVE',
          accessEpoch: 13,
          syncProtocol: 'pm-yjs-v1',
          collabWsUrl: 'ws://127.0.0.1:1234/ws',
          token: 'session-token',
          snapshotVersion: 1,
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com', snapshotUrl: null },
      });
    }
    if (url.pathname === '/api/documents/test-doc' && method === 'PUT') {
      if (requests.filter((request) => request.path === '/api/documents/test-doc' && request.method === 'PUT').length === 1) {
        return jsonResponse({ success: true, updatedAt: '2026-03-14T23:50:01.000Z' });
      }
      return jsonResponse({ success: true, updatedAt: '2026-03-14T23:50:02.000Z' });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  }, async () => {
    const { shareClient } = await import('../bridge/share-client.js');
    shareClient.refreshRuntimeConfig();
    const openContext = await shareClient.fetchOpenContext();
    assert(openContext && !('error' in openContext), 'Expected open context to load');

    const firstSuccess = await shareClient.pushUpdate('First unload edit\n', {}, 'human:Dan', {
      keepalive: true,
      allowLocalKeepaliveBaseToken: false,
    });
    assert.equal(firstSuccess, true, 'Expected first keepalive pushUpdate to succeed');

    const secondSuccess = await shareClient.pushUpdate('Second unload edit\n', {}, 'human:Dan', {
      keepalive: true,
      allowLocalKeepaliveBaseToken: false,
    });
    assert.equal(secondSuccess, true, 'Expected second keepalive pushUpdate to succeed');
  });

  const pushUpdateRequests = requests.filter((request) => request.path === '/api/documents/test-doc' && request.method === 'PUT');
  assert.equal(pushUpdateRequests.length, 2, `Expected two keepalive PUT requests, got ${pushUpdateRequests.length}`);
  assert.equal(pushUpdateRequests[0]?.body?.baseToken, 'observed-open-context-base-token', 'Expected the first keepalive write to use the observed authoritative base token');
  assert.equal(pushUpdateRequests[1]?.body?.baseToken, undefined, 'Expected the second keepalive write not to reuse the stale observed base token after a successful content write');
  assert.equal(pushUpdateRequests[1]?.body?.baseUpdatedAt, '2026-03-14T23:50:01.000Z', 'Expected the second keepalive write to fall back to the updatedAt returned by the first successful content write');
}

async function run(): Promise<void> {
  await runBaseTokenCase();
  await runBaseUpdatedAtFallbackCase();
  await runAccessEpochFallbackCase();
  await runObservedBaseClearsAfterSuccessfulWriteCase();
  console.log('share-client-keepalive-base-token.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
