/**
 * End-to-end and integration tests for server routes and share lifecycle.
 *
 * Covers:
 * - static source checks for server route/config safety
 * - server onboarding/hook routes
 * - route payload validation for share document APIs
 *
 * Run: PORT=4000 npm run test:server-routes-share
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import * as Y from 'yjs';
import { buildSharePreviewModel, resolveOgTextLayout } from '../../server/share-preview';

const SHARE_BASE = process.env.SHARE_BASE_URL ?? 'http://localhost:4000';
const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message?: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message ?? `Expected ${haystack} to include ${needle}`);
  }
}

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${base}${path}`, { headers: { ...CLIENT_HEADERS, ...headers } });
  const body = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body,
    json: () => {
      try {
        return Promise.resolve(JSON.parse(body));
      } catch {
        return Promise.reject(new Error(`Response is not JSON: ${body.slice(0, 200)}`));
      }
    },
  };
}

async function getManualRedirect(base: string, path: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    headers: { ...CLIENT_HEADERS, ...headers },
    redirect: 'manual',
  });
  const body = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

async function getBinary(base: string, path: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    headers: { ...CLIENT_HEADERS, ...headers },
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

async function post(base: string, path: string, body?: object, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...CLIENT_HEADERS,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: bodyText,
    json: () => {
      try {
        return Promise.resolve(JSON.parse(bodyText));
      } catch {
        return Promise.reject(new Error(`Response is not JSON: ${bodyText.slice(0, 200)}`));
      }
    },
  };
}

async function postNoClientHeaders(base: string, path: string, body?: object, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: bodyText,
    json: () => {
      try {
        return Promise.resolve(JSON.parse(bodyText));
      } catch {
        return Promise.reject(new Error(`Response is not JSON: ${bodyText.slice(0, 200)}`));
      }
    },
  };
}

async function postRaw(
  base: string,
  requestPath: string,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): Promise<any> {
  const response = await fetch(`${base}${requestPath}`, {
    method: 'POST',
    headers: {
      ...CLIENT_HEADERS,
      'Content-Type': contentType,
      ...headers,
    },
    body,
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: bodyText,
    json: () => {
      try {
        return Promise.resolve(JSON.parse(bodyText));
      } catch {
        return Promise.reject(new Error(`Response is not JSON: ${bodyText.slice(0, 200)}`));
      }
    },
  };
}

async function put(
  base: string,
  requestPath: string,
  body: object,
  headers: Record<string, string> = {},
): Promise<any> {
  const response = await fetch(`${base}${requestPath}`, {
    method: 'PUT',
    headers: {
      ...CLIENT_HEADERS,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    body: bodyText,
    json: () => {
      try {
        return Promise.resolve(JSON.parse(bodyText));
      } catch {
        return Promise.reject(new Error(`Response is not JSON: ${bodyText.slice(0, 200)}`));
      }
    },
  };
}

async function del(
  base: string,
  requestPath: string,
  body?: object,
  headers: Record<string, string> = {},
): Promise<any> {
  const response = await fetch(`${base}${requestPath}`, {
    method: 'DELETE',
    headers: {
      ...CLIENT_HEADERS,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: bodyText,
    json: () => {
      try {
        return Promise.resolve(JSON.parse(bodyText));
      } catch {
        return Promise.reject(new Error(`Response is not JSON: ${bodyText.slice(0, 200)}`));
      }
    },
  };
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

async function withEphemeralApiServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const dbName = `proof-share-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const { apiRoutes } = await import('../../server/routes.ts');
  const { agentRoutes } = await import('../../server/agent-routes.ts');
  const { createBridgeMountRouter } = await import('../../server/bridge.ts');
  const { discoveryRoutes } = await import('../../server/discovery-routes.ts');
  const { shareWebRoutes } = await import('../../server/share-web-routes.ts');
  const { enforceApiClientCompatibility } = await import('../../server/client-capabilities.ts');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(discoveryRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/documents', createBridgeMountRouter());
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  try {
    const address = server.address();
    assert(address !== null && typeof address !== 'string', 'Server did not bind correctly');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await run(baseUrl);
  } finally {
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

async function withMockOAuth(run: (oauthBaseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.post('/oauth/token', (req, res) => {
    const grantType = typeof req.body?.grant_type === 'string' ? req.body.grant_type : '';
    const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
    const clientSecret = typeof req.body?.client_secret === 'string' ? req.body.client_secret : '';
    if (clientId !== 'test-every-client' || clientSecret !== 'test-every-secret') {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }

    if (grantType === 'authorization_code') {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      if (code !== 'valid-code') {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      res.json({
        access_token: 'access-valid',
        refresh_token: 'refresh-valid',
        token_type: 'bearer',
        expires_in: 3600,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
      if (refreshToken !== 'refresh-valid') {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      res.json({
        access_token: 'access-refreshed',
        refresh_token: 'refresh-valid',
        token_type: 'bearer',
        expires_in: 3600,
      });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  app.get('/oauth/userinfo', (req, res) => {
    const authHeader = typeof req.header('authorization') === 'string' ? req.header('authorization')! : '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== 'access-valid' && token !== 'access-refreshed') {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    res.json({
      user_id: 42,
      email: 'agent@example.com',
      name: 'Agent User',
      subscriber: true,
      username: 'agent-user',
    });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const address = server.address();
    assert(address !== null && typeof address !== 'string', 'Mock OAuth server failed to bind');
    const base = `http://127.0.0.1:${address.port}`;
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runServerSourceTests(): Promise<void> {
  const serverSource = readFileSync(path.resolve(process.cwd(), 'server', 'index.ts'), 'utf8');
  const homeTemplate = readFileSync(path.resolve(process.cwd(), 'server', 'resources', 'home.html'), 'utf8');

  await test('D1: server source mounts canonical /documents bridge routes', async () => {
    assertIncludes(
      serverSource,
      "app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));",
      'server source should mount the canonical /documents bridge routes',
    );
  });

  await test('D1: server source mounts discovery metadata routes', async () => {
    assertIncludes(
      serverSource,
      'app.use(discoveryRoutes);',
      'server source should mount discovery metadata routes',
    );
  });

  await test('D1: server source publishes a health endpoint', async () => {
    assertIncludes(
      serverSource,
      "app.get('/health'",
      'server source should publish a health endpoint',
    );
  });

  await test('D1: landing template keeps mobile hero CTA visible', async () => {
    assertIncludes(
      homeTemplate,
      '.hero-text + .btn-primary',
      'mobile CSS should scope desktop CTA visibility to the hero-text sibling selector',
    );
    assertIncludes(
      homeTemplate,
      '.hero-text + .btn-primary {\n      display: inline-flex !important;',
      'mobile CSS should force the hero CTA visible under the text block',
    );
  });

  await test('D1: landing template removes the hosted footer stamp art', async () => {
    assertIncludes(
      homeTemplate,
      '.showcase {\n    width: 100%;\n    max-width: 1300px;\n    height: 780px;\n    position: relative;\n    border-radius: 4px;\n    overflow: hidden;\n    background-image: linear-gradient(90deg, rgba(38, 37, 30, 0.05) 0%, rgba(38, 37, 30, 0.05) 100%), linear-gradient(90deg, #f5f3ec 0%, #f5f3ec 100%);\n    cursor: default;',
      'showcase wrapper should not advertise clickability',
    );
    assert(!homeTemplate.includes('/assets/every-logo.svg'), 'landing template should not reference hosted-product branding assets');
  });
}

async function runServerHookTests(): Promise<void> {
  const health = await get(SHARE_BASE, '/agent-setup')
    .then((r) => ({ ok: r.status === 200, status: r.status }))
    .catch(() => ({ ok: false, status: 0 }));
  if (!health.ok) {
    console.log(`SKIPPED server-route tests: ${SHARE_BASE} did not return /agent-setup (status ${health.status}).`);
    return;
  }

  await test('D1: /agent-setup returns streamlined setup guide content', async () => {
    const response = await get(SHARE_BASE, '/agent-setup');
    assert(response.status === 200, `/agent-setup should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(body, 'Proof — Agent Setup', 'agent-setup should include heading text');
    assertIncludes(body, 'Web-first Quickstart', 'agent-setup should include web-first quickstart instructions');
    assert(!/native split repo/i.test(body), 'agent-setup should stay focused on the web SDK setup flow');
  });

  await test('D1: /codex-agent-setup redirects to the unified setup guide', async () => {
    const response = await get(SHARE_BASE, '/codex-agent-setup');
    assert(response.status === 200, `/codex-agent-setup should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(body, 'Proof — Agent Setup', 'codex-agent-setup should resolve to unified setup text');
    assertIncludes(body, 'proof.SKILL.md', 'codex-agent-setup should include the unified skill install URL');
  });

  await test('D1: /install-hooks.sh is served and contains hook install steps', async () => {
    const response = await get(SHARE_BASE, '/install-hooks.sh');
    assert(response.status === 200, `/install-hooks.sh should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(body, '#!/bin/bash', 'install script should be a bash script');
    assertIncludes(body, 'Downloaded hooks from', 'install script should fetch hook resources from the configured base URL');
    assertIncludes(body, 'settings.json', 'install script should mention settings.json wiring');
  });

  await test('D1: /hooks/proof-pre-write.sh content includes JSON tool input parsing', async () => {
    const response = await get(SHARE_BASE, '/hooks/proof-pre-write.sh');
    assert(response.status === 200, `/hooks/proof-pre-write.sh should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(body, '#!/bin/bash', 'pre-write hook should be a bash script');
    assertIncludes(body, 'TOOL_NAME', 'pre-write hook should parse TOOL_NAME');
    assertIncludes(body, 'INPUT=$(cat)', 'pre-write script should include input reader');
  });

  await test('D1: /hooks/proof-post-write.sh content includes queue file behavior', async () => {
    const response = await get(SHARE_BASE, '/hooks/proof-post-write.sh');
    assert(response.status === 200, `/hooks/proof-post-write.sh should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(body, 'provenance-queue.jsonl', 'post-write hook should write to provenance queue');
    assertIncludes(body, 'TOOL_NAME', 'post-write hook should parse TOOL_NAME');
    assertIncludes(body, '"Write"', 'post-write hook should handle Write tool payload');
    assertIncludes(body, '"Edit"', 'post-write hook should handle Edit tool payload');
  });

  await test('D1: /proof.SKILL.md returns the unified skill', async () => {
    const response = await get(SHARE_BASE, '/proof.SKILL.md');
    assert(response.status === 200, `/proof.SKILL.md should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(body, 'name: proof', 'skill should include proof frontmatter');
    assertIncludes(body, '# Proof', 'skill should include the expected heading');
  });

  await test('D1: /proof-agent-ops.SKILL.md remains a compatibility alias', async () => {
    const response = await get(SHARE_BASE, '/proof-agent-ops.SKILL.md');
    assert(response.status === 200, `/proof-agent-ops.SKILL.md should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(body, 'name: proof', 'compat route should serve the unified skill frontmatter');
    assertIncludes(body, '# Proof', 'compat route should serve the unified skill content');
  });

  await test('D1: /agent-setup includes unified fail-fast skill install commands', async () => {
    const response = await get(SHARE_BASE, '/agent-setup');
    assert(response.status === 200, `/agent-setup should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(
      body,
      'http://localhost:4000/agent-setup',
      'agent-setup should point at the local SDK setup endpoint',
    );
    assertIncludes(
      body,
      '~/.codex/skills/proof/SKILL.md',
      'agent-setup should reference the installed codex proof skill path',
    );
  });

  await test('D1: /download redirects to the web homepage', async () => {
    const response = await getManualRedirect(SHARE_BASE, '/download');
    assert(response.status === 302, `/download should return 302, got ${response.status}`);
    assertEqual(response.headers.get('location'), '/', '/download should redirect to the homepage');
  });

  await test('D1: landing page Codex copy prompt includes unified skill install command', async () => {
    const response = await get(SHARE_BASE, '/');
    assert(response.status === 200, `/ should return 200, got ${response.status}`);
    const body = response.body || '';
    assertIncludes(
      body,
      '<title>Proof — A collaborative editor for humans and AI</title>',
      'landing page should preserve the web-first title',
    );
    assertIncludes(
      body,
      'href="/get-started"',
      'landing page Get started CTA should create a doc instead of only scrolling',
    );
    assertIncludes(
      body,
      'PROOF_BASE_URL="${PROOF_BASE_URL:-http://localhost:4000}"',
      'landing page should include a configurable local Proof SDK base URL',
    );
    assertIncludes(
      body,
      '.hero-text + .btn-primary',
      'landing page mobile CSS should only target the hero CTA sibling selector',
    );
    assertIncludes(
      body,
      '.hero-text + .btn-primary {\n      display: inline-flex !important;',
      'landing page mobile CSS should explicitly re-show the hero CTA on small screens',
    );
  });
}

async function runRoutePayloadValidationTests(): Promise<void> {
  await withEphemeralApiServer(async (baseUrl) => {
    const db = await import('../../server/db.ts');

    await test('D2: missing client headers returns actionable CLIENT_UPGRADE_REQUIRED', async () => {
      const response = await postNoClientHeaders(baseUrl, '/api/documents', { markdown: '# Hello' });
      assert(response.status === 426, `Expected status 426, got ${response.status}`);
      const payload = await response.json();
      assertEqual(payload.code, 'CLIENT_UPGRADE_REQUIRED');
      assertEqual(payload.docs, '/agent-docs');
      assert(payload.createNoHeaders?.href === '/documents', 'Expected createNoHeaders href to point to /documents');
    });

    await test('D2: POST /share/markdown works without client headers', async () => {
      const response = await postNoClientHeaders(baseUrl, '/share/markdown', { markdown: '# Hello', title: 'No headers' });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(typeof payload.shareUrl === 'string' && payload.shareUrl.includes('/d/'), 'Expected shareUrl');
      assert(typeof payload.ownerSecret === 'string' && payload.ownerSecret.length > 0, 'Expected ownerSecret');
      assert(payload._links?.edit?.href?.includes('/documents/'), 'Expected canonical _links.edit');
      assert(payload._links?.presence?.href?.includes('/documents/'), 'Expected canonical _links.presence');
      assert(typeof payload.agent?.createApi === 'string' && payload.agent.createApi.includes('/documents'), 'Expected agent.createApi');
    });

    await test('D2: POST /documents works as the neutral SDK create route', async () => {
      const response = await postNoClientHeaders(baseUrl, '/documents', {
        markdown: '# SDK Route',
        marks: {},
        title: 'Neutral create',
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(typeof payload.slug === 'string' && payload.slug.length > 0, 'Expected slug');
      assert(typeof payload._links?.view === 'string', 'Expected view link');
      assert(typeof payload._links?.edit?.href === 'string' && payload._links.edit.href.includes('/documents/'), 'Expected canonical edit link');
      assert(typeof payload.agent?.bridgeApi?.comments === 'string' && payload.agent.bridgeApi.comments.includes('/documents/'), 'Expected bridge comments route');
    });

    await test('D2: POST /api/documents in warn mode returns deprecation headers + metadata', async () => {
      const previousMode = process.env.PROOF_LEGACY_CREATE_MODE;
      process.env.PROOF_LEGACY_CREATE_MODE = 'warn';
      try {
        const response = await post(baseUrl, '/api/documents', {
          markdown: '# Legacy warn mode',
          marks: {},
        });
        assert(response.status === 200, `Expected status 200, got ${response.status}`);
        assert((response.headers.get('deprecation') || '').toLowerCase() === 'true', 'Expected deprecation=true header');
        assert((response.headers.get('x-proof-legacy-create') || '') === 'warn', 'Expected x-proof-legacy-create=warn');
        const payload = await response.json();
        assert(payload.deprecation?.mode === 'warn', 'Expected deprecation.mode=warn');
        assert(payload.deprecation?.canonicalPath === '/documents', 'Expected canonical path to /documents');
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_LEGACY_CREATE_MODE;
        else process.env.PROOF_LEGACY_CREATE_MODE = previousMode;
      }
    });

    await test('D2: POST /api/documents in disabled mode returns LEGACY_CREATE_DISABLED', async () => {
      const previousMode = process.env.PROOF_LEGACY_CREATE_MODE;
      process.env.PROOF_LEGACY_CREATE_MODE = 'disabled';
      try {
        const response = await post(baseUrl, '/api/documents', {
          markdown: '# Legacy disabled mode',
          marks: {},
        });
        assert(response.status === 410, `Expected status 410, got ${response.status}`);
        assert((response.headers.get('x-proof-legacy-create') || '') === 'disabled', 'Expected x-proof-legacy-create=disabled');
        const payload = await response.json();
        assert(payload.code === 'LEGACY_CREATE_DISABLED', `Expected LEGACY_CREATE_DISABLED, got ${String(payload.code)}`);
        assert(payload.fix === 'Use POST /documents', `Expected migration fix, got ${String(payload.fix)}`);
        assert(payload.docs === '/agent-docs', `Expected docs=/agent-docs, got ${String(payload.docs)}`);
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_LEGACY_CREATE_MODE;
        else process.env.PROOF_LEGACY_CREATE_MODE = previousMode;
      }
    });

    const createResponse = await post(baseUrl, '/api/documents', {
      markdown: '# Hello',
      marks: {},
      title: 'Validation test',
      ownerId: 'tester',
    });

    assert(createResponse.status === 200, `Expected create status 200, got ${createResponse.status}`);
    const created = await createResponse.json();
    const slug = created.slug as string;
    const ownerSecret = created.ownerSecret as string;
    const accessToken = created.accessToken as string;
    assert(typeof slug === 'string' && slug.length > 0, 'Expected create response to include slug');
    assert(typeof ownerSecret === 'string' && ownerSecret.length > 0, 'Expected create response to include ownerSecret');
    assert(typeof accessToken === 'string' && accessToken.length > 0, 'Expected create response to include accessToken');

    await test('D2: create responses include agent blocks and edit/presence links', async () => {
      assert(typeof created.agent?.createApi === 'string', 'Expected create response to include agent.createApi');
      assert(typeof created._links?.edit?.href === 'string', 'Expected create response to include _links.edit');
      assert(typeof created._links?.presence?.href === 'string', 'Expected create response to include _links.presence');
      assert(String(created._links.edit.href).includes('/documents/'), 'Expected canonical edit link');
      assert(String(created._links.presence.href).includes('/documents/'), 'Expected canonical presence link');
    });

    await test('D2: GET /documents/:slug/state works via neutral alias', async () => {
      const response = await get(baseUrl, `/documents/${slug}/state`, { 'x-share-token': accessToken });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(typeof payload.markdown === 'string' && payload.markdown.includes('# Hello'), 'Expected markdown in neutral state response');
      assert(typeof payload._links?.state === 'string' && payload._links.state.includes(`/documents/${slug}/state`), 'Expected canonical state link');
    });

    await test('D2: POST /documents/:slug/bridge/comments works via neutral bridge alias', async () => {
      const response = await post(baseUrl, `/documents/${slug}/bridge/comments`, {
        quote: 'Hello',
        by: 'ai:test-agent',
        text: 'Looks good',
      }, { 'x-share-token': accessToken });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assertEqual(payload.success, true, 'Expected bridge comment alias to succeed');
    });

    await test('D2: v1 agent insert rejects insert.before payloads', async () => {
      const stateResponse = await get(baseUrl, `/api/agent/${slug}/state`, {
        'x-share-token': accessToken,
      });
      assert(stateResponse.status === 200, `Expected state status 200, got ${stateResponse.status}`);
      const statePayload = await stateResponse.json();

      const response = await post(baseUrl, `/api/agent/${slug}/edit`, {
        by: 'ai:test-agent',
        baseUpdatedAt: statePayload.updatedAt,
        operations: [{ op: 'insert', before: 'Hello', content: 'Invalid before insert' }],
      }, {
        'x-share-token': accessToken,
      });
      assert(response.status === 400, `Expected insert.before rejection 400, got ${response.status}`);
      const payload = await response.json();
      assert(payload.code === 'INVALID_OPERATIONS', `Expected INVALID_OPERATIONS, got ${String(payload.code)}`);
    });

    await test('D2: v1 agent insert rejects payloads that include both before and after', async () => {
      const stateResponse = await get(baseUrl, `/api/agent/${slug}/state`, {
        'x-share-token': accessToken,
      });
      assert(stateResponse.status === 200, `Expected state status 200, got ${stateResponse.status}`);
      const statePayload = await stateResponse.json();

      const response = await post(baseUrl, `/api/agent/${slug}/edit`, {
        by: 'ai:test-agent',
        baseUpdatedAt: statePayload.updatedAt,
        operations: [{ op: 'insert', before: 'Hello', after: 'Hello', content: 'Ambiguous insert' }],
      }, {
        'x-share-token': accessToken,
      });
      assert(response.status === 400, `Expected before+after rejection 400, got ${response.status}`);
      const payload = await response.json();
      assert(payload.code === 'INVALID_OPERATIONS', `Expected INVALID_OPERATIONS, got ${String(payload.code)}`);
    });

    await test('D2: v1 agent insert.after remains supported', async () => {
      const stateResponse = await get(baseUrl, `/api/agent/${slug}/state`, {
        'x-share-token': accessToken,
      });
      assert(stateResponse.status === 200, `Expected state status 200, got ${stateResponse.status}`);
      const statePayload = await stateResponse.json();

      const response = await post(baseUrl, `/api/agent/${slug}/edit`, {
        by: 'ai:test-agent',
        baseUpdatedAt: statePayload.updatedAt,
        operations: [{ op: 'insert', after: 'Hello', content: ' there' }],
      }, {
        'x-share-token': accessToken,
      });
      assert(response.status === 200, `Expected insert.after success 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload.success === true, 'Expected successful insert.after edit');
    });

    await test('D2: discovery endpoints serve agent onboarding docs', async () => {
      const wellKnown = await get(baseUrl, '/.well-known/agent.json', { Accept: 'application/json' });
      assert(wellKnown.status === 200, `Expected agent.json 200, got ${wellKnown.status}`);
      const agentJson = JSON.parse(wellKnown.body || '{}') as Record<string, unknown>;
      assert(typeof agentJson.api_base === 'string' && String(agentJson.api_base).endsWith('/api'), 'Expected api_base to end with /api');
      assert(typeof agentJson.docs_url === 'string' && String(agentJson.docs_url).includes('/agent-docs'), 'Expected docs_url');
      assert(typeof agentJson.skill_url === 'string' && String(agentJson.skill_url).includes('/proof.SKILL.md'), 'Expected skill_url');
      assert(typeof agentJson.setup_url === 'string' && String(agentJson.setup_url).includes('/agent-setup'), 'Expected setup_url');

      const contract = await get(baseUrl, '/AGENT_CONTRACT.md', { Accept: 'text/markdown' });
      assert(contract.status === 200, `Expected AGENT_CONTRACT.md 200, got ${contract.status}`);
      assertIncludes(contract.body || '', 'POST /documents', 'Expected contract to mention document endpoint');

      const docs = await get(baseUrl, '/agent-docs', { Accept: 'text/markdown' });
      assert(docs.status === 200, `Expected agent-docs 200, got ${docs.status}`);
      assertIncludes(docs.body || '', '/documents', 'Expected agent-docs to mention document endpoint');
      assertIncludes(docs.body || '', 'X-Agent-Id', 'Expected agent-docs to require explicit agent identity for presence');
      assert(!(docs.body || '').includes('a `by` field identifying the agent'), 'Did not expect agent-docs to derive presence identity from by');
      assert(!(docs.body || '').includes('"presenceApplied": true'), 'Did not expect agent-docs to imply presence is automatic');
    });

    await test('D2: /d/:slug token query sets cookie (no redirect; token stays in URL)', async () => {
      const response = await getManualRedirect(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`, {
        Accept: 'text/html',
      });
      assert(response.status === 200, `Expected 200 HTML response, got ${response.status}`);
      const location = response.headers.get('location') || '';
      assert(location === '', `Expected no redirect Location header, got ${location}`);
      const setCookie = response.headers.get('set-cookie') || '';
      assert(setCookie.includes(`proof_share_token_${slug}=`), `Expected share token cookie, got ${setCookie}`);
      const linkHeader = response.headers.get('link') || '';
      assert(linkHeader.includes(`/documents/${slug}/state`), `Expected canonical agent-state Link header, got ${linkHeader}`);
    });

    await test('D2: /d/:slug query token takes precedence over stale share-token cookie', async () => {
      const precedenceCreate = await post(baseUrl, '/api/documents', {
        markdown: '# Precedence test',
        marks: {},
        title: 'Token precedence',
        ownerId: 'precedence-test',
      });
      assert(precedenceCreate.status === 200, `Expected create status 200, got ${precedenceCreate.status}`);
      const precedenceDoc = await precedenceCreate.json();
      const precedenceSlug = precedenceDoc.slug as string;
      const precedenceOwnerSecret = precedenceDoc.ownerSecret as string;
      assert(typeof precedenceSlug === 'string' && precedenceSlug.length > 0, 'Expected precedence slug');
      assert(typeof precedenceOwnerSecret === 'string' && precedenceOwnerSecret.length > 0, 'Expected precedence owner secret');

      const viewerToken = db.createDocumentAccessToken(precedenceSlug, 'viewer').secret;
      db.pauseDocument(precedenceSlug);

      const response = await get(
        baseUrl,
        `/d/${encodeURIComponent(precedenceSlug)}?token=${encodeURIComponent(precedenceOwnerSecret)}`,
        {
          Accept: 'application/json',
          Cookie: `${encodeURIComponent(`proof_share_token_${precedenceSlug}`)}=${encodeURIComponent(viewerToken)}`,
        },
      );
      assert(response.status === 200, `Expected owner token in query to allow paused doc access, got ${response.status}`);
      const payload = JSON.parse(response.body || '{}') as Record<string, unknown>;
      assertEqual(payload.role, 'owner_bot', 'Expected query token to win over stale cookie token');
      assertEqual(payload.shareState, 'PAUSED', 'Expected paused doc metadata');
      assert(payload.success === true, 'Expected successful payload');
    });

    await test('D2: /d/:slug falls back to cookie if query token is invalid', async () => {
      const fallbackCreate = await post(baseUrl, '/api/documents', {
        markdown: '# Cookie fallback test',
        marks: {},
        title: 'Cookie fallback',
        ownerId: 'cookie-fallback',
      });
      assert(fallbackCreate.status === 200, `Expected create status 200, got ${fallbackCreate.status}`);
      const fallbackDoc = await fallbackCreate.json();
      const fallbackSlug = fallbackDoc.slug as string;
      assert(typeof fallbackSlug === 'string' && fallbackSlug.length > 0, 'Expected fallback slug');

      const viewerToken = db.createDocumentAccessToken(fallbackSlug, 'viewer').secret;

      const response = await get(
        baseUrl,
        `/d/${encodeURIComponent(fallbackSlug)}?token=invalid-token`,
        {
          Accept: 'application/json',
          Cookie: `${encodeURIComponent(`proof_share_token_${fallbackSlug}`)}=${encodeURIComponent(viewerToken)}`,
        },
      );
      assert(response.status === 200, `Expected cookie auth to succeed, got ${response.status}`);
      const payload = JSON.parse(response.body || '{}') as Record<string, unknown>;
      assertEqual(payload.role, 'viewer', 'Expected cookie token to authorize viewer role');
      assert(payload.success === true, 'Expected successful payload');
      assertEqual(
        payload.hint,
        'This link has no token. Ask for a tokenized link if you need a stable shareable URL.',
        'Expected cookie-auth JSON response to avoid URL-token hint',
      );
    });

    await test('D2: /d/:slug agent-friendly HTML never embeds cookie-derived tokens', async () => {
      const cookieHtmlCreate = await post(baseUrl, '/api/documents', {
        markdown: '# Agent HTML cookie token test',
        marks: {},
        title: 'Cookie token redaction',
        ownerId: 'cookie-agent-html',
      });
      assert(cookieHtmlCreate.status === 200, `Expected create status 200, got ${cookieHtmlCreate.status}`);
      const cookieHtmlDoc = await cookieHtmlCreate.json();
      const cookieHtmlSlug = cookieHtmlDoc.slug as string;
      assert(typeof cookieHtmlSlug === 'string' && cookieHtmlSlug.length > 0, 'Expected cookie-html slug');

      const cookieViewerToken = db.createDocumentAccessToken(cookieHtmlSlug, 'viewer').secret;
      const response = await get(
        baseUrl,
        `/d/${encodeURIComponent(cookieHtmlSlug)}?token=invalid-token`,
        {
          Accept: 'text/html',
          'User-Agent': 'curl/8.7.1',
          Cookie: `${encodeURIComponent(`proof_share_token_${cookieHtmlSlug}`)}=${encodeURIComponent(cookieViewerToken)}`,
        },
      );
      assert(response.status === 200, `Expected agent-friendly HTML 200, got ${response.status}`);
      const body = response.body || '';
      assert(!body.includes(cookieViewerToken), 'Expected HTML response to redact cookie-derived token value');
      assert(
        !body.includes(`?token=${encodeURIComponent(cookieViewerToken)}`),
        'Expected HTML response to avoid tokenized URL when token source is cookie',
      );
      assertIncludes(body, 'No token detected', 'Expected no-token auth guidance in HTML response');
    });

    await test('D2: /d/:slug content negotiation returns JSON with markdown + links', async () => {
      const response = await get(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`, {
        Accept: 'application/json',
      });
      assert(response.status === 200, `Expected 200 JSON response, got ${response.status}`);
      const payload = JSON.parse(response.body || '{}') as Record<string, unknown>;
      assertEqual(payload.slug, slug, 'Expected slug to match');
      assert(typeof payload.markdown === 'string' && String(payload.markdown).includes('# Hello'), 'Expected markdown in response');
      const links = payload._links as any;
      assert(typeof links?.state === 'string' && String(links.state).includes(`/documents/${slug}/state`), 'Expected canonical _links.state');
      assert(typeof links?.snapshot === 'string' && String(links.snapshot).includes(`/documents/${slug}/snapshot`), 'Expected canonical _links.snapshot');
      assert(typeof links?.editV2?.href === 'string' && String(links.editV2.href).includes(`/documents/${slug}/edit/v2`), 'Expected canonical _links.editV2.href');
      const agent = payload.agent as any;
      assert(typeof agent?.auth?.headerFormat === 'string', 'Expected agent.auth hints');
      assert(typeof agent?.snapshotApi === 'string' && String(agent.snapshotApi).includes(`/documents/${slug}/snapshot`), 'Expected canonical agent.snapshotApi');
      assert(typeof agent?.editV2Api === 'string' && String(agent.editV2Api).includes(`/documents/${slug}/edit/v2`), 'Expected canonical agent.editV2Api');
    });

    await test('D2: /d/:slug defaults no-UA clients to agent JSON manifest', async () => {
      const response = await get(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`);
      assert(response.status === 200, `Expected 200 JSON response, got ${response.status}`);
      assertEqual(response.headers.get('content-type'), 'application/json; charset=utf-8', 'Expected JSON content type for headerless client');
      const payload = JSON.parse(response.body || '{}') as Record<string, unknown>;
      assertEqual(payload.slug, slug, 'Expected slug to match');
      assert(typeof payload.markdown === 'string' && String(payload.markdown).includes('# Hello'), 'Expected markdown in response');
    });

    await test('D2: /d/:slug Slack unfurl bots get HTML metadata without explicit Accept', async () => {
      const response = await get(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`, {
        'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      });
      assert(response.status === 200, `Expected 200 HTML response for Slack unfurl, got ${response.status}`);
      assertEqual(response.headers.get('content-type'), 'text/html; charset=utf-8', 'Expected HTML content type for Slack unfurl');
      const body = response.body || '';
      assertIncludes(body, '<meta property="og:title"', 'Expected og:title in Slack unfurl HTML');
      assertIncludes(body, '<meta property="og:image"', 'Expected og:image in Slack unfurl HTML');
      assertIncludes(body, '<meta name="twitter:description"', 'Expected twitter:description in Slack unfurl HTML');
      assertIncludes(body, '<title>Validation test | Proof</title>', 'Expected document-specific title in Slack unfurl HTML');
    });

    await test('D2: /d/:slug content negotiation returns raw markdown', async () => {
      const response = await get(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`, {
        Accept: 'text/markdown',
      });
      assert(response.status === 200, `Expected 200 markdown response, got ${response.status}`);
      assertIncludes(response.body || '', '# Hello', 'Expected markdown body to include document content');
    });

    await test('D2: /d/:slug HTML response includes agent discovery meta tags + noscript fallback', async () => {
      const response = await get(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`, {
        Accept: 'text/html',
      });
      assert(response.status === 200, `Expected 200 HTML response, got ${response.status}`);
      const body = response.body || '';
      assertIncludes(body, '<meta property="og:title"', 'Expected og:title meta tag');
      assertIncludes(body, '<meta property="og:description"', 'Expected og:description meta tag');
      assertIncludes(body, '<meta property="og:image"', 'Expected og:image meta tag');
      assertIncludes(body, '<meta name="twitter:card" content="summary_large_image">', 'Expected large Twitter card');
      assertIncludes(body, `<meta property="og:url" content="${baseUrl}/d/${slug}">`, 'Expected clean canonical og:url');
      assertIncludes(body, `${baseUrl}/og/share/${slug}.png?v=`, 'Expected versioned og:image URL');
      assertIncludes(body, '<meta name="twitter:image"', 'Expected twitter:image meta tag');
      assertIncludes(body, '<title>Validation test | Proof</title>', 'Expected dynamic document title in HTML head');
      const titleTags = body.match(/<title\b[^>]*>[\s\S]*?<\/title>/gi) || [];
      assertEqual(titleTags.length, 1, `Expected single title tag, got ${titleTags.length}`);
      assert(
        !body.includes('<title>Proof Editor</title>'),
        'Expected template title to be replaced with document-specific title'
      );
      assert(
        !body.includes(`<meta property="og:url" content="${baseUrl}/d/${slug}?token=`),
        'Expected og:url metadata to avoid leaking share token'
      );
      assert(
        !body.includes(`<link rel="canonical" href="${baseUrl}/d/${slug}?token=`),
        'Expected canonical metadata to avoid leaking share token'
      );
      assertIncludes(body, '<meta name="agent-api"', 'Expected agent-api meta tag');
      assertIncludes(body, '<meta name="agent-docs"', 'Expected agent-docs meta tag');
      assertIncludes(body, '<noscript>', 'Expected noscript fallback');
      assertIncludes(body, '# Hello', 'Expected noscript to contain markdown content');
    });

    await test('D2: /d/:slug agent-friendly HTML also includes social preview metadata', async () => {
      const response = await get(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`, {
        Accept: 'text/html',
        'User-Agent': 'curl/8.7.1',
      });
      assert(response.status === 200, `Expected 200 agent-friendly HTML response, got ${response.status}`);
      const body = response.body || '';
      assertIncludes(body, '<meta property="og:title"', 'Expected og:title in agent-friendly HTML');
      assertIncludes(body, '<meta property="og:image"', 'Expected og:image in agent-friendly HTML');
      assertIncludes(body, '<meta name="twitter:description"', 'Expected twitter:description in agent-friendly HTML');
      assertIncludes(body, 'API Quick Start', 'Expected agent-friendly HTML content');
    });

    await test('D2: /og/share/:slug.png returns a PNG social card', async () => {
      const response = await getBinary(baseUrl, `/og/share/${encodeURIComponent(slug)}.png`);
      assert(response.status === 200, `Expected 200 PNG response, got ${response.status}`);
      assertEqual(response.headers.get('content-type'), 'image/png', 'Expected image/png content type');
      assert(response.body.length > 5000, `Expected non-trivial PNG body, got ${response.body.length} bytes`);
      const signature = response.body.subarray(0, 8).toString('hex');
      assertEqual(signature, '89504e470d0a1a0a', 'Expected PNG file signature');
    });

    await test('D2: unavailable shares emit generic social metadata without doc excerpt', async () => {
      const pausedCreate = await post(baseUrl, '/api/documents', {
        markdown: '# Secret doc\n\nThis should not leak while paused.',
        marks: {},
        title: 'Paused doc',
        ownerId: 'paused-social-card',
      });
      assert(pausedCreate.status === 200, `Expected paused create status 200, got ${pausedCreate.status}`);
      const pausedDoc = await pausedCreate.json();
      const pausedSlug = pausedDoc.slug as string;
      const pausedOwnerSecret = pausedDoc.ownerSecret as string;
      assert(typeof pausedSlug === 'string' && pausedSlug.length > 0, 'Expected paused slug');
      assert(typeof pausedOwnerSecret === 'string' && pausedOwnerSecret.length > 0, 'Expected paused owner secret');
      const pauseResponse = await post(baseUrl, `/api/documents/${encodeURIComponent(pausedSlug)}/pause`, {
        ownerSecret: pausedOwnerSecret,
      });
      assert(pauseResponse.status === 200, `Expected pause status 200, got ${pauseResponse.status}`);
      const response = await get(baseUrl, `/d/${encodeURIComponent(pausedSlug)}`, {
        Accept: 'text/html',
      });
      assert(response.status === 200, `Expected paused HTML snapshot response 200, got ${response.status}`);
      const body = response.body || '';
      assertIncludes(body, '<meta property="og:title"', 'Expected og:title for paused share');
      assertIncludes(
        body,
        'content="Document unavailable"',
        'Expected generic unavailable title in metadata',
      );
      assert(
        !body.includes('Paused doc'),
        'Expected paused share HTML to avoid leaking document title',
      );
      assertIncludes(body, 'content="The shared Proof document is temporarily unavailable"', 'Expected generic unavailable metadata');
      assert(!body.includes('This should not leak while paused.'), 'Expected paused share HTML to avoid content excerpt');
    });

    await test('D2: unavailable OG cards hide canonical slug chips and titles', async () => {
      const unavailableModel = buildSharePreviewModel({
        slug: 'secret-slug',
        origin: 'https://example.com',
        doc: {
          title: 'Top Secret',
          shareState: 'PAUSED',
        },
      });
      assertEqual(unavailableModel.title, 'Document unavailable', 'Expected generic title for unavailable model');
      assertEqual(unavailableModel.displayUrl, null, 'Expected unavailable OG card to hide canonical slug chip');
      assert(
        !unavailableModel.imageAlt.includes('Top Secret'),
        'Expected unavailable OG image alt text to avoid the real document title',
      );

      const activeModel = buildSharePreviewModel({
        slug: 'active-slug',
        origin: 'https://example.com',
        doc: {
          title: 'Active Title',
          markdown: '# Active Title\n\nThis is visible.',
          shareState: 'ACTIVE',
        },
      });
      assertEqual(activeModel.title, 'Active Title', 'Expected active model to preserve document title');
      assertEqual(activeModel.displayUrl, 'example.com/d/active-slug', 'Expected active OG card to include canonical slug chip');
      assertIncludes(
        activeModel.imageAlt,
        'Active Title',
        'Expected active OG image alt text to include the document title',
      );
    });

    await test('D2: long OG titles shrink to preserve description space', async () => {
      const shortLayout = resolveOgTextLayout('Monday Product Sync');
      const longLayout = resolveOgTextLayout('How We Want the Proof SDK Bundle to Feel When Someone First Realizes It Can Actually Do Computer Errands Across the Entire Writing Stack Including Review, Rewrite, Comments, Provenance, and Collaboration');
      assert(longLayout.titleFontSize < shortLayout.titleFontSize, 'Expected long titles to use a smaller OG title size');
      assert(longLayout.excerptMaxLength < shortLayout.excerptMaxLength, 'Expected long titles to reserve more room for the description/footer');
      assert(longLayout.contentGap !== shortLayout.contentGap, 'Expected long titles to tighten title/description spacing');
    });

    await test('D2: /og/share/:slug.png returns a generic card for missing docs', async () => {
      const response = await getBinary(baseUrl, '/og/share/does-not-exist.png');
      assert(response.status === 200, `Expected 200 PNG response for missing doc, got ${response.status}`);
      assertEqual(response.headers.get('content-type'), 'image/png', 'Expected image/png content type for missing doc');
      const signature = response.body.subarray(0, 8).toString('hex');
      assertEqual(signature, '89504e470d0a1a0a', 'Expected PNG signature for missing doc card');
    });

    await test('D2: /d/:slug HTML response injects runtime comment UI default mode when configured', async () => {
      const previousMode = process.env.PROOF_COMMENT_UI_DEFAULT_MODE;
      process.env.PROOF_COMMENT_UI_DEFAULT_MODE = 'legacy';
      try {
        const response = await get(baseUrl, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(accessToken)}`, {
          Accept: 'text/html',
        });
        assert(response.status === 200, `Expected 200 HTML response, got ${response.status}`);
        assertIncludes(
          response.body || '',
          'window.__PROOF_CONFIG__.commentUiDefaultMode = "legacy";',
          'Expected runtime config to expose comment UI default mode'
        );
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_COMMENT_UI_DEFAULT_MODE;
        else process.env.PROOF_COMMENT_UI_DEFAULT_MODE = previousMode;
      }
    });

    await test('D2: POST /documents rejects non-object marks payload', async () => {
      const response = await post(baseUrl, '/api/documents', {
        markdown: '# Bad marks',
        marks: 'not-an-object' as unknown as object,
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
    });

    await test('D2: POST /documents missing markdown returns code + fix', async () => {
      const response = await post(baseUrl, '/api/documents', { title: 'Missing markdown' } as any);
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assertEqual(payload.code, 'MISSING_MARKDOWN');
      assert(typeof payload.fix === 'string' && payload.fix.includes('markdown'), 'Expected a fix snippet');
    });

    await test('D2: POST /documents rejects empty markdown', async () => {
      const response = await post(baseUrl, '/api/documents', { markdown: '   ' });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assertEqual(payload.code, 'EMPTY_MARKDOWN');
      assert(payload.error === 'markdown must not be empty', 'Expected empty markdown validation message');
    });

    await test('D2: POST /api/share/markdown missing markdown returns code + fix', async () => {
      const response = await post(baseUrl, '/api/share/markdown', { title: 'Missing markdown' } as any);
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assertEqual(payload.code, 'MISSING_MARKDOWN');
      assert(typeof payload.fix === 'string' && payload.fix.includes('markdown'), 'Expected a fix snippet');
    });

    await test('D2: PUT /documents/:slug rejects non-string markdown payload', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        markdown: null as unknown as string,
        ownerSecret,
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assert(payload.error === 'markdown must be a string when provided', 'Expected markdown validation message');
    });

    await test('D2: PUT /documents/:slug rejects empty markdown payload', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        markdown: '   ',
        ownerSecret,
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assertEqual(payload.code, 'EMPTY_MARKDOWN');
      assert(payload.error === 'markdown must not be empty', 'Expected empty markdown validation message');
    });

    await test('D2: PUT /documents/:slug rejects null marks payload', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        marks: null as unknown as object,
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assert(payload.error === 'marks must be an object when provided', 'Expected marks validation message');
    });

    await test('D2: PUT /documents/:slug rejects string marks payload', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        marks: 'nope' as unknown as object,
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assert(payload.error === 'marks must be an object when provided', 'Expected marks validation message');
    });

    await test('D2: PUT /documents/:slug rejects non-string title payload', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        title: 42 as unknown as string,
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assert(payload.error === 'title must be a string when provided', 'Expected title validation message');
    });

    await test('D2: PUT /documents/:slug rejects empty title payload', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        title: '   ',
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assertEqual(payload.code, 'EMPTY_TITLE');
      assert(payload.error === 'title must not be empty', 'Expected empty title validation message');
    });

    await test('D2: PUT /documents/:slug enforces title update edit authorization', async () => {
      const viewerAccess = await post(baseUrl, `/api/documents/${slug}/access-links`, {
        role: 'viewer',
        ownerSecret,
      });
      assert(viewerAccess.status === 200, `Expected viewer access-link status 200, got ${viewerAccess.status}`);
      const viewerPayload = await viewerAccess.json();
      const viewerToken = viewerPayload.accessToken as string;
      assert(typeof viewerToken === 'string' && viewerToken.length > 0, 'Expected viewer access token');

      const denied = await put(baseUrl, `/api/documents/${slug}`, {
        title: 'Viewer denied title',
      }, {
        'x-share-token': viewerToken,
      });
      assert(denied.status === 403, `Expected title update 403 for viewer, got ${denied.status}`);
      const payload = await denied.json();
      assert(payload.error === 'Not authorized to update document title', 'Expected title auth failure message');
    });

    await test('D2: PUT /documents/:slug accepts title-only update for editor', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        title: 'Updated pill title',
      }, {
        'x-share-token': accessToken,
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload.success === true, 'Expected successful title-only update');

      const fetched = await get(baseUrl, `/api/documents/${slug}`, { 'x-share-token': accessToken });
      assert(fetched.status === 200, `Expected fetch status 200, got ${fetched.status}`);
      const fetchedPayload = await fetched.json();
      assertEqual(fetchedPayload.title, 'Updated pill title', 'Expected persisted title update');
    });

    await test('D2: PUT /documents/:slug accepts valid marks-only update', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}`, {
        marks: {
          mark1: {
            kind: 'comment',
            quote: 'Hello',
            by: 'human:tester',
          },
        },
        actor: 'human:tester',
      }, {
        'x-share-token': accessToken,
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload.success === true, 'Expected successful marks-only update');
    });

    await test('D2: PUT /documents/:slug/title persists title metadata', async () => {
      const response = await put(baseUrl, `/api/documents/${slug}/title`, {
        title: 'Persisted title from test',
      }, {
        'x-share-token': accessToken,
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload.success === true, 'Expected successful title update');
      assertEqual(payload.title, 'Persisted title from test', 'Expected canonical title in response');

      const updated = await get(baseUrl, `/api/documents/${slug}`);
      assert(updated.status === 200, `Expected status 200, got ${updated.status}`);
      const updatedPayload = await updated.json();
      assertEqual(updatedPayload.title, 'Persisted title from test', 'Expected persisted title on document fetch');
    });

    await test('D2: PUT /documents/:slug/title handles non-object body with structured 400', async () => {
      const response = await fetch(`${baseUrl}/api/documents/${slug}/title`, {
        method: 'PUT',
        headers: {
          ...CLIENT_HEADERS,
          'Content-Type': 'text/plain',
          'x-share-token': accessToken,
        },
        body: 'not-json',
      });
      assert(response.status === 400, `Expected status 400 for non-object body, got ${response.status}`);
      const payload = await response.json() as { error?: string };
      assert(payload.error === 'title must be a string or null when provided', `Expected title validation error, got ${String(payload.error)}`);
    });
    await test('D2: PUT /documents/:slug/title rejects commenter role', async () => {
      const commenterToken = db.createDocumentAccessToken(slug, 'commenter').secret;
      const response = await put(baseUrl, `/api/documents/${slug}/title`, {
        title: 'Commenter cannot set this',
      }, {
        'x-share-token': commenterToken,
      });
      assert(response.status === 403, `Expected status 403, got ${response.status}`);
      const payload = await response.json();
      assert(payload.error === 'Not authorized to update document title', 'Expected auth error message');
    });

    await test('D2: PUT /documents/:slug preserves canonical Yjs state and updates it from markdown writes', async () => {
      const createdResponse = await post(baseUrl, '/api/documents', {
        markdown: '# Seed doc',
        marks: {},
        title: 'Yjs reset test',
      });
      assert(createdResponse.status === 200, `Expected create status 200, got ${createdResponse.status}`);
      const createdPayload = await createdResponse.json();
      const seededSlug = createdPayload.slug as string;
      const seededOwnerSecret = createdPayload.ownerSecret as string;
      assert(typeof seededSlug === 'string' && seededSlug.length > 0, 'Expected seeded slug');
      assert(typeof seededOwnerSecret === 'string' && seededOwnerSecret.length > 0, 'Expected seeded ownerSecret');

      // Seed persisted Yjs state with content A (simulates prior collab session persistence).
      const ydocA = new Y.Doc();
      ydocA.getText('markdown').insert(0, '# Original content');
      const updateA = Y.encodeStateAsUpdate(ydocA);
      const seq = db.appendYUpdate(seededSlug, updateA, 'test');
      db.saveYSnapshot(seededSlug, seq, updateA);

      // Update canonical markdown to B.
      const response = await put(baseUrl, `/api/documents/${seededSlug}`, {
        markdown: '# New content',
        ownerSecret: seededOwnerSecret,
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);

      // Persisted canonical Yjs state should now be updated in place.
      const snapshot = db.getLatestYSnapshot(seededSlug);
      assert(snapshot !== null, 'Expected canonical Yjs snapshot to remain available');
      const updates = db.getYUpdatesAfter(seededSlug, snapshot?.version ?? 0);
      assert(updates.length >= 0, 'Expected canonical Yjs updates query to succeed');

      // Simulate the collab hydrate path from snapshot+updates to ensure it reflects canonical markdown B.
      const hydrated = new Y.Doc();
      if (snapshot) {
        Y.applyUpdate(hydrated, snapshot.snapshot);
      }
      for (const update of updates) {
        Y.applyUpdate(hydrated, update.update);
      }
      assert(
        hydrated.getText('markdown').toString().includes('New content'),
        'Expected hydrated canonical Yjs markdown to reflect latest markdown write',
      );
    });

    await test('D2: owner-only routes reject spoofed ownerId body without owner secret', async () => {
      const owned = await post(baseUrl, '/api/documents', {
        markdown: '# Owner spoof test',
        marks: {},
        ownerId: 'owner-123',
      });
      assert(owned.status === 200, `Expected create status 200, got ${owned.status}`);
      const ownedPayload = await owned.json();
      const ownedSlug = ownedPayload.slug as string;

      const spoofedPause = await post(baseUrl, `/api/documents/${ownedSlug}/pause`, {
        ownerId: 'owner-123',
      });
      assert(spoofedPause.status === 403, `Expected status 403, got ${spoofedPause.status}`);
    });

    await test('D2: PUT /documents/:slug works for paused docs with owner secret', async () => {
      const owned = await post(baseUrl, '/api/documents', {
        markdown: '# Paused update',
        marks: {},
      });
      assert(owned.status === 200, `Expected create status 200, got ${owned.status}`);
      const ownedPayload = await owned.json();
      const ownedSlug = ownedPayload.slug as string;
      const ownedSecret = ownedPayload.ownerSecret as string;

      const paused = await post(baseUrl, `/api/documents/${ownedSlug}/pause`, {
        ownerSecret: ownedSecret,
      });
      assert(paused.status === 200, `Expected pause status 200, got ${paused.status}`);

      const updateWhilePaused = await put(baseUrl, `/api/documents/${ownedSlug}`, {
        markdown: '# Paused update\n\nstill editable by owner',
        ownerSecret: ownedSecret,
      });
      assert(updateWhilePaused.status === 200, `Expected paused update status 200, got ${updateWhilePaused.status}`);
      const payload = await updateWhilePaused.json();
      assert(payload.success === true, 'Expected successful paused owner update');
    });

    await test('D2: PUT /documents/:slug/title works for paused docs with owner secret', async () => {
      const owned = await post(baseUrl, '/api/documents', {
        markdown: '# Paused title update',
        marks: {},
      });
      assert(owned.status === 200, `Expected create status 200, got ${owned.status}`);
      const ownedPayload = await owned.json();
      const ownedSlug = ownedPayload.slug as string;
      const ownedSecret = ownedPayload.ownerSecret as string;

      const paused = await post(baseUrl, `/api/documents/${ownedSlug}/pause`, {
        ownerSecret: ownedSecret,
      });
      assert(paused.status === 200, `Expected pause status 200, got ${paused.status}`);

      const updateTitleWhilePaused = await put(baseUrl, `/api/documents/${ownedSlug}/title`, {
        title: 'Paused owner title update',
        ownerSecret: ownedSecret,
      });
      assert(updateTitleWhilePaused.status === 200, `Expected paused title update status 200, got ${updateTitleWhilePaused.status}`);
      const payload = await updateTitleWhilePaused.json();
      assert(payload.success === true, 'Expected successful paused owner title update');
      assertEqual(payload.title, 'Paused owner title update', 'Expected updated paused title');
    });

    await test('D2: open-context does not reject bare links when bearer token is an OAuth-style session token', async () => {
      const response = await get(baseUrl, `/api/documents/${slug}/open-context`, {
        Authorization: 'Bearer epsess_mock_session_token',
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload?.doc?.slug === slug, 'Expected open-context payload for requested slug');
    });

    await test('D2: tokenless open-context defaults to editor permissions', async () => {
      const response = await get(baseUrl, `/api/documents/${slug}/open-context`);
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      const capabilities = payload?.capabilities ?? {};
      assert(capabilities.canEdit === true, 'Expected tokenless open-context to be editable');
      assert(capabilities.canComment === true, 'Expected tokenless open-context to be commentable');
    });

    await test('D2: open-context session includes pm-yjs sync protocol when collab is enabled', async () => {
      const response = await get(baseUrl, `/api/documents/${slug}/open-context`, {
        'x-share-token': accessToken,
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      if (payload?.session) {
        assert(payload?.session?.syncProtocol === 'pm-yjs-v1', 'Expected open-context session.syncProtocol=pm-yjs-v1');
      } else {
        assert(payload?.collabAvailable === false, 'Expected collabAvailable=false when open-context lacks session');
      }
      const capabilities = payload?.capabilities ?? {};
      assert(typeof capabilities.canRead === 'boolean', 'Expected capabilities.canRead boolean');
      assert(typeof capabilities.canComment === 'boolean', 'Expected capabilities.canComment boolean');
      assert(typeof capabilities.canEdit === 'boolean', 'Expected capabilities.canEdit boolean');
    });

    await test('D2: collab-session preserves role/capabilities contract when available', async () => {
      const response = await get(baseUrl, `/api/documents/${slug}/collab-session`, {
        'x-share-token': accessToken,
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      if (payload?.session) {
        assert(payload?.session?.syncProtocol === 'pm-yjs-v1', 'Expected collab-session syncProtocol=pm-yjs-v1');
        assert(payload?.session?.role === 'editor', `Expected editor role, got ${String(payload?.session?.role)}`);
        assert(payload?.capabilities?.canEdit === true, 'Expected editor collab session to include canEdit=true');
        assert(payload?.capabilities?.canComment === true, 'Expected editor collab session to include canComment=true');
      } else {
        assert(payload?.collabAvailable === false, 'Expected collabAvailable=false when collab-session lacks session');
      }
    });


    await test('D2: collab-session rewrites localhost ws URL for forwarded public hosts', async () => {
      const previousTrustProxy = process.env.PROOF_TRUST_PROXY_HEADERS;
      process.env.PROOF_TRUST_PROXY_HEADERS = 'true';
      try {
        const response = await get(baseUrl, `/api/documents/${slug}/collab-session`, {
          'x-share-token': accessToken,
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'www.proof.com',
        });
        assert(response.status === 200, `Expected status 200, got ${response.status}`);
        const payload = await response.json();
        if (payload?.session) {
          const collabWsUrl = String(payload?.session?.collabWsUrl ?? '');
          assert(collabWsUrl.startsWith('wss://www.proof.com'), `Expected forwarded collab ws URL, got ${collabWsUrl}`);
          assert(!collabWsUrl.includes('localhost'), `Expected forwarded collab ws URL without localhost, got ${collabWsUrl}`);
        } else {
          assert(payload?.collabAvailable === false, 'Expected collabAvailable=false when collab-session lacks session');
        }
      } finally {
        if (previousTrustProxy === undefined) delete process.env.PROOF_TRUST_PROXY_HEADERS;
        else process.env.PROOF_TRUST_PROXY_HEADERS = previousTrustProxy;
      }
    });

    await test('D2: collab-refresh returns sync protocol and consistent capabilities when available', async () => {
      const response = await post(baseUrl, `/api/documents/${slug}/collab-refresh`, {}, {
        'x-share-token': accessToken,
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      if (payload?.session) {
        assert(payload?.session?.syncProtocol === 'pm-yjs-v1', 'Expected collab-refresh syncProtocol=pm-yjs-v1');
        assert(payload?.session?.role === 'editor', `Expected refreshed editor role, got ${String(payload?.session?.role)}`);
        const capabilities = payload?.capabilities ?? {};
        assert(capabilities.canRead === true, 'Expected canRead=true on collab-refresh');
        assert(capabilities.canComment === true, 'Expected canComment=true on collab-refresh');
        assert(capabilities.canEdit === true, 'Expected canEdit=true on collab-refresh');
      } else {
        assert(payload?.collabAvailable === false, 'Expected collabAvailable=false when collab-refresh lacks session');
      }
    });

    await test('D2: /documents/:slug/info omits sensitive metadata', async () => {
      const response = await get(baseUrl, `/api/documents/${slug}/info`);
      assert(response.status === 200, `Expected info status 200, got ${response.status}`);
      const payload = await response.json();
      assert(typeof payload.title === 'string' || payload.title === null, 'Expected title in info payload');
      assert(typeof payload.shareState === 'string', 'Expected shareState in info payload');
      assert(!('docId' in payload), 'Expected docId to be omitted from public info');
      assert(!('viewers' in payload), 'Expected viewers to be omitted from public info');
    });

    await test('D2: agent accept suggestion updates markdown content (not metadata-only)', async () => {
      const suggestionResponse = await post(baseUrl, `/api/agent/${slug}/marks/suggest-replace`, {
        quote: 'Hello',
        by: 'ai:test-agent',
        content: 'Hi',
      }, {
        'x-share-token': accessToken,
      });
      assert(suggestionResponse.status === 200, `Expected suggestion status 200, got ${suggestionResponse.status}`);
      const suggestionPayload = await suggestionResponse.json();
      const marks = suggestionPayload.marks as Record<string, unknown> | undefined;
      const markId = marks
        ? (Object.entries(marks).find(([, value]) => {
          const mark = value as Record<string, unknown>;
          return mark.kind === 'replace' && mark.content === 'Hi';
        })?.[0] ?? '')
        : '';
      assert(markId.length > 0, 'Expected suggestion mark id');

      const accessLinks = await post(baseUrl, `/api/documents/${slug}/access-links`, {
        role: 'editor',
        ownerSecret,
      });
      assert(accessLinks.status === 200, `Expected access-links status 200, got ${accessLinks.status}`);
      const linksPayload = await accessLinks.json();
      const editorToken = linksPayload.accessToken as string;
      assert(typeof editorToken === 'string' && editorToken.length > 0, 'Expected editor token');
      assert(typeof linksPayload.token === 'string' && linksPayload.token.length > 0, 'Expected legacy token alias');
      assertEqual(linksPayload.token, editorToken, 'Expected token alias to match accessToken');

      const acceptResponse = await post(baseUrl, `/api/agent/${slug}/marks/accept`, {
        markId,
        by: 'human:editor',
      }, {
        'x-share-token': editorToken,
      });
      assert(acceptResponse.status === 200, `Expected accept status 200, got ${acceptResponse.status}`);

      const updatedDoc = await get(baseUrl, `/api/documents/${slug}`);
      assert(updatedDoc.status === 200, `Expected updated doc status 200, got ${updatedDoc.status}`);
      const updatedPayload = await updatedDoc.json();
      assert(
        typeof updatedPayload.markdown === 'string' && updatedPayload.markdown.includes('Hi'),
        'Expected accepted suggestion to update markdown content',
      );
    });

    await test('D2: commenter can reply to comments via agent route', async () => {
      const commentResponse = await post(baseUrl, `/api/agent/${slug}/marks/comment`, {
        quote: 'Hi',
        by: 'human:commenter',
        text: 'initial comment',
      }, {
        'x-share-token': accessToken,
      });
      assert(commentResponse.status === 200, `Expected comment status 200, got ${commentResponse.status}`);
      const commentPayload = await commentResponse.json();
      const marks = commentPayload.marks as Record<string, unknown> | undefined;
      const markId = marks ? Object.keys(marks)[Object.keys(marks).length - 1] : '';
      assert(markId.length > 0, 'Expected comment mark id');

      const replyResponse = await post(baseUrl, `/api/agent/${slug}/marks/reply`, {
        markId,
        by: 'human:commenter',
        text: 'commenter reply',
      }, {
        'x-share-token': accessToken,
      });
      assert(replyResponse.status === 200, `Expected reply status 200, got ${replyResponse.status}`);
      const replyPayload = await replyResponse.json();
      assert(replyPayload.success === true, 'Expected successful commenter reply');
      const repliedMark = (replyPayload.marks as Record<string, any> | undefined)?.[markId];
      assert(Boolean(repliedMark), 'Expected replied mark metadata in payload');
      assert(Array.isArray(repliedMark.thread), 'Expected replied mark to persist normalized thread array');
      assert(Array.isArray(repliedMark.replies), 'Expected replied mark to persist normalized replies array');
      assertEqual(repliedMark.thread.length, 1, 'Expected one reply in thread array');
      assertEqual(repliedMark.replies.length, 1, 'Expected one reply in replies array');
    });

    await test('D2: POST /api/agent/:slug/presence/disconnect rejects invalid agentId payloads', async () => {
      const missing = await post(baseUrl, `/api/agent/${slug}/presence/disconnect`, {}, {
        'x-share-token': accessToken,
      });
      assert(missing.status === 400, `Expected status 400, got ${missing.status}`);
      const missingPayload = await missing.json();
      assert(missingPayload.error === 'agentId is required', 'Expected agentId validation error');

      const blank = await post(baseUrl, `/api/agent/${slug}/presence/disconnect`, { agentId: '   ' }, {
        'x-share-token': accessToken,
      });
      assert(blank.status === 400, `Expected status 400 for blank id, got ${blank.status}`);
    });

    await test('D2: POST /api/agent/:slug/presence requires explicit agent-scoped identity', async () => {
      const missing = await post(baseUrl, `/api/agent/${slug}/presence`, {
        status: 'thinking',
      }, {
        'x-share-token': accessToken,
      });
      assert(missing.status === 400, `Expected missing identity status 400, got ${missing.status}`);
      const missingPayload = await missing.json();
      assertEqual(missingPayload.code, 'INVALID_AGENT_IDENTITY', 'Expected INVALID_AGENT_IDENTITY for missing identity');

      const human = await post(baseUrl, `/api/agent/${slug}/presence`, {
        agentId: 'human:Dan',
        status: 'thinking',
      }, {
        'x-share-token': accessToken,
      });
      assert(human.status === 400, `Expected human identity status 400, got ${human.status}`);
      const humanPayload = await human.json();
      assertEqual(humanPayload.code, 'INVALID_AGENT_IDENTITY', 'Expected INVALID_AGENT_IDENTITY for human identity');

      const valid = await post(baseUrl, `/api/agent/${slug}/presence`, {
        agentId: 'presence-check',
        name: 'Presence Check',
        status: 'thinking',
      }, {
        'x-share-token': accessToken,
      });
      assert(valid.status === 200, `Expected valid identity status 200, got ${valid.status}`);
      const validPayload = await valid.json();
      assertEqual(validPayload.success, true, 'Expected explicit presence success');
    });

    await test('D2: POST /api/agent/:slug/presence/disconnect enforces editor/owner permissions', async () => {
      const viewerToken = db.createDocumentAccessToken(slug, 'viewer').secret;
      const commenterToken = db.createDocumentAccessToken(slug, 'commenter').secret;
      const agentId = `ai:disconnect-auth-${Math.random().toString(36).slice(2, 8)}`;

      const seededPresence = await post(baseUrl, `/api/agent/${slug}/presence`, {
        agentId,
        name: 'Disconnect Target',
        status: 'thinking',
      }, {
        'x-share-token': accessToken,
      });
      assert(seededPresence.status === 200, `Expected seeded presence status 200, got ${seededPresence.status}`);

      const viewerDenied = await post(baseUrl, `/api/agent/${slug}/presence/disconnect`, {
        agentId,
      }, {
        'x-share-token': viewerToken,
      });
      assert(viewerDenied.status === 403, `Expected viewer denial status 403, got ${viewerDenied.status}`);

      const commenterDenied = await post(baseUrl, `/api/agent/${slug}/presence/disconnect`, {
        agentId,
      }, {
        'x-share-token': commenterToken,
      });
      assert(commenterDenied.status === 403, `Expected commenter denial status 403, got ${commenterDenied.status}`);
    });

    await test('D2: POST /api/agent/:slug/presence/disconnect succeeds for editor and owner', async () => {
      const editorAgentId = `ai:disconnect-editor-${Math.random().toString(36).slice(2, 8)}`;
      const ownerAgentId = `ai:disconnect-owner-${Math.random().toString(36).slice(2, 8)}`;

      const seedEditorPresence = await post(baseUrl, `/api/agent/${slug}/presence`, {
        agentId: editorAgentId,
        name: 'Editor Disconnect Target',
        status: 'acting',
      }, {
        'x-share-token': accessToken,
      });
      assert(seedEditorPresence.status === 200, `Expected editor seed status 200, got ${seedEditorPresence.status}`);

      const editorDisconnect = await post(baseUrl, `/api/agent/${slug}/presence/disconnect`, {
        agentId: editorAgentId,
      }, {
        'x-share-token': accessToken,
      });
      assert(editorDisconnect.status === 200, `Expected editor disconnect status 200, got ${editorDisconnect.status}`);
      const editorPayload = await editorDisconnect.json();
      assert(editorPayload.success === true, 'Expected success=true for editor disconnect');
      assert(editorPayload.disconnected === true, 'Expected disconnected=true for editor disconnect');

      const seedOwnerPresence = await post(baseUrl, `/api/agent/${slug}/presence`, {
        agentId: ownerAgentId,
        name: 'Owner Disconnect Target',
        status: 'acting',
      }, {
        'x-share-token': accessToken,
      });
      assert(seedOwnerPresence.status === 200, `Expected owner seed status 200, got ${seedOwnerPresence.status}`);

      const ownerDisconnect = await post(baseUrl, `/api/agent/${slug}/presence/disconnect`, {
        agentId: ownerAgentId,
      }, {
        'x-share-token': ownerSecret,
      });
      assert(ownerDisconnect.status === 200, `Expected owner disconnect status 200, got ${ownerDisconnect.status}`);
      const ownerPayload = await ownerDisconnect.json();
      assert(ownerPayload.success === true, 'Expected success=true for owner disconnect');
      assert(ownerPayload.disconnected === true, 'Expected disconnected=true for owner disconnect');
    });

    await test('D2: DELETE /documents/:slug performs delete semantics (not pause)', async () => {
      const created = await post(baseUrl, '/api/documents', {
        markdown: '# Delete me',
        marks: {},
      });
      assert(created.status === 200, `Expected create status 200, got ${created.status}`);
      const createdPayload = await created.json();
      const deleteSlug = createdPayload.slug as string;
      const deleteOwnerSecret = createdPayload.ownerSecret as string;

      const response = await del(baseUrl, `/api/documents/${deleteSlug}`, { ownerSecret: deleteOwnerSecret });
      assert(response.status === 200, `Expected delete status 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload.shareState === 'DELETED', `Expected shareState=DELETED, got ${String(payload.shareState)}`);

      const getDeleted = await get(baseUrl, `/api/documents/${deleteSlug}`);
      assert(getDeleted.status === 410, `Expected deleted doc status 410, got ${getDeleted.status}`);
    });

    await test('D2: POST /share/markdown creates share link from JSON markdown payload', async () => {
      const response = await post(baseUrl, '/api/share/markdown', {
        markdown: '# Agent Plan\n\nShip this rewrite.\n',
        title: 'Agent Plan',
        role: 'editor',
      });
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload.success === true, 'Expected success=true');
      assert(typeof payload.slug === 'string' && payload.slug.length > 0, 'Expected slug');
      assert(typeof payload.url === 'string' && payload.url.startsWith('/d/'), 'Expected relative URL');
      assert(typeof payload.shareUrl === 'string' && payload.shareUrl.startsWith(`${baseUrl}/d/`), 'Expected absolute share URL');
      assert(payload.accessRole === 'editor', `Expected accessRole=editor, got ${payload.accessRole as string}`);
      assert(payload.active === true, 'Expected legacy active=true');
      assert(typeof payload._links?.state === 'string' && String(payload._links.state).includes(`/documents/${payload.slug as string}/state`), 'Expected canonical _links.state');
      assert(typeof payload._links?.ops?.href === 'string' && String(payload._links.ops.href).includes(`/documents/${payload.slug as string}/ops`), 'Expected canonical _links.ops.href');
      assert(typeof payload._links?.events === 'string' && String(payload._links.events).includes(`/documents/${payload.slug as string}/events/pending`), 'Expected canonical _links.events');

      const docResponse = await get(baseUrl, `/api/documents/${payload.slug as string}`);
      assert(docResponse.status === 200, `Expected created doc to load, got ${docResponse.status}`);
      const doc = await docResponse.json();
      assert(doc.markdown.includes('Ship this rewrite.'), 'Expected created markdown content');
      assert(doc.shareState === 'ACTIVE', 'Expected shareState ACTIVE');
    });

    await test('D2: POST /share/markdown accepts text/markdown body', async () => {
      const response = await postRaw(
        baseUrl,
        '/api/share/markdown?title=Raw%20Upload',
        '# Raw Upload\n\nfrom text body\n',
        'text/markdown',
      );
      assert(response.status === 200, `Expected status 200, got ${response.status}`);
      const payload = await response.json();
      assert(payload.success === true, 'Expected success=true for raw upload');
      assert(payload.accessRole === 'editor', `Expected default accessRole editor, got ${payload.accessRole as string}`);
      assert(typeof payload.shareUrl === 'string' && payload.shareUrl.includes('/d/'), 'Expected shareUrl');
    });

    await test('D2: POST /share/markdown rejects invalid role', async () => {
      const response = await post(baseUrl, '/api/share/markdown', {
        markdown: '# Invalid role test',
        role: 'owner_bot',
      });
      assert(response.status === 400, `Expected status 400, got ${response.status}`);
      const payload = await response.json();
      assert(payload.error === 'role must be viewer, commenter, or editor', 'Expected role validation error');
    });

    await test('D2: POST /share/markdown enforces API key when configured', async () => {
      const previousKey = process.env.PROOF_SHARE_MARKDOWN_API_KEY;
      const previousMode = process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
      process.env.PROOF_SHARE_MARKDOWN_API_KEY = 'test-direct-share-key';
      process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = 'api_key';
      try {
        const unauthorized = await post(baseUrl, '/api/share/markdown', {
          markdown: '# Auth required',
        });
        assert(unauthorized.status === 401, `Expected status 401 without API key, got ${unauthorized.status}`);
        const unauthorizedPayload = await unauthorized.json();
        assert(unauthorizedPayload.code === 'UNAUTHORIZED', 'Expected UNAUTHORIZED code');

        const authorized = await post(baseUrl, '/api/share/markdown', {
          markdown: '# Auth ok',
          role: 'viewer',
        }, {
          Authorization: 'Bearer test-direct-share-key',
        });
        assert(authorized.status === 200, `Expected status 200 with API key, got ${authorized.status}`);
        const authorizedPayload = await authorized.json();
        assert(authorizedPayload.success === true, 'Expected success with API key');
        assert(authorizedPayload.accessRole === 'viewer', 'Expected viewer role for authorized request');
      } finally {
        if (previousKey === undefined) {
          delete process.env.PROOF_SHARE_MARKDOWN_API_KEY;
        } else {
          process.env.PROOF_SHARE_MARKDOWN_API_KEY = previousKey;
        }
        if (previousMode === undefined) {
          delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
        } else {
          process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = previousMode;
        }
      }
    });

    await test('D2: POST /share/markdown defaults to anonymous create in Proof SDK', async () => {
      const previousMode = process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;

      delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;

      try {
        const response = await post(baseUrl, '/api/share/markdown', {
          markdown: '# anonymous create',
        });
        assert(response.status === 200, `Expected status 200 for anonymous create, got ${response.status}`);
        const payload = await response.json();
        assert(typeof payload.slug === 'string' && payload.slug.length > 0, 'Expected create response to include slug');
        assert(typeof payload.shareUrl === 'string' && payload.shareUrl.includes('/d/'), 'Expected create response to include shareUrl');
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
        else process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = previousMode;
      }
    });

    await test('D2: POST /share/markdown in api_key mode rejects unauthenticated requests', async () => {
      const previousMode = process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
      const previousApiKey = process.env.PROOF_SHARE_MARKDOWN_API_KEY;

      process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = 'api_key';
      process.env.PROOF_SHARE_MARKDOWN_API_KEY = 'sdk-test-key';

      try {
        const initial = await post(baseUrl, '/api/share/markdown', {
          markdown: '# Requires api key',
        });
        assert(initial.status === 401, `Expected status 401, got ${initial.status}`);
        const initialPayload = await initial.json();
        assert(initialPayload.code === 'UNAUTHORIZED', `Expected UNAUTHORIZED code, got ${String(initialPayload.code)}`);

        const authorized = await post(baseUrl, '/api/share/markdown', {
          markdown: '# Authorized via API key',
        }, {
          Authorization: 'Bearer sdk-test-key',
        });
        assert(authorized.status === 200, `Expected status 200 with API key, got ${authorized.status}`);
        const authorizedPayload = await authorized.json();
        assert(authorizedPayload.success === true, 'Expected successful share with API key');
        assert(typeof authorizedPayload.slug === 'string' && authorizedPayload.slug.length > 0, 'Expected created slug with API key');
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
        else process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = previousMode;

        if (previousApiKey === undefined) delete process.env.PROOF_SHARE_MARKDOWN_API_KEY;
        else process.env.PROOF_SHARE_MARKDOWN_API_KEY = previousApiKey;
      }
    });

    await test('D2: POST /share/markdown accepts trusted proxy email headers for Cloud Run IAP', async () => {
      const previousMode = process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
      const previousTrustProxy = process.env.PROOF_TRUST_PROXY_HEADERS;
      const previousTrustedHeaders = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
      const previousTrustedDomains = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
      const previousTrustedEmails = process.env.PROOF_TRUSTED_IDENTITY_EMAILS;

      process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = 'oauth';
      process.env.PROOF_TRUST_PROXY_HEADERS = 'true';
      process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS = 'x-goog-authenticated-user-email';
      process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = 'elastic.co';
      delete process.env.PROOF_TRUSTED_IDENTITY_EMAILS;

      try {
        const createResponse = await post(baseUrl, '/api/share/markdown', {
          markdown: '# IAP trusted create',
        }, {
          'X-Goog-Authenticated-User-Email': 'accounts.google.com:agent@elastic.co',
        });
        assert(createResponse.status === 200, `Expected status 200 for trusted proxy create, got ${createResponse.status}`);
        const createPayload = await createResponse.json();
        assert(createPayload.success === true, 'Expected trusted proxy create to succeed');
        assert(typeof createPayload.slug === 'string' && createPayload.slug.length > 0, 'Expected trusted proxy create slug');

        const accessLinksResponse = await post(baseUrl, `/api/documents/${encodeURIComponent(createPayload.slug as string)}/access-links`, {
          role: 'viewer',
        }, {
          'X-Goog-Authenticated-User-Email': 'accounts.google.com:agent@elastic.co',
        });
        assert(accessLinksResponse.status === 200, `Expected trusted proxy owner access-links status 200, got ${accessLinksResponse.status}`);
        const accessLinksPayload = await accessLinksResponse.json();
        assert(accessLinksPayload.success === true, 'Expected trusted proxy owner access-links success');

        const discoveryResponse = await get(baseUrl, '/.well-known/agent.json');
        assert(discoveryResponse.status === 200, `Expected discovery status 200, got ${discoveryResponse.status}`);
        const discoveryPayload = await discoveryResponse.json();
        const authMethods = Array.isArray(discoveryPayload?.auth?.methods) ? discoveryPayload.auth.methods : [];
        assert(authMethods.includes('trusted_proxy_email'), 'Expected discovery auth methods to advertise trusted_proxy_email');
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
        else process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = previousMode;
        if (previousTrustProxy === undefined) delete process.env.PROOF_TRUST_PROXY_HEADERS;
        else process.env.PROOF_TRUST_PROXY_HEADERS = previousTrustProxy;
        if (previousTrustedHeaders === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS = previousTrustedHeaders;
        if (previousTrustedDomains === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = previousTrustedDomains;
        if (previousTrustedEmails === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAILS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAILS = previousTrustedEmails;
      }
    });

    await test('D2: discovery endpoint redacts trusted proxy allowlists and header config', async () => {
      const previousMode = process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
      const previousTrustProxy = process.env.PROOF_TRUST_PROXY_HEADERS;
      const previousTrustedHeaders = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
      const previousTrustedDomains = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
      const previousTrustedEmails = process.env.PROOF_TRUSTED_IDENTITY_EMAILS;

      process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = 'oauth';
      process.env.PROOF_TRUST_PROXY_HEADERS = 'true';
      process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS = 'x-goog-authenticated-user-email,x-forwarded-email';
      process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = 'elastic.co';
      process.env.PROOF_TRUSTED_IDENTITY_EMAILS = 'agent@elastic.co';

      try {
        const response = await get(baseUrl, '/.well-known/agent.json');
        assert(response.status === 200, `Expected discovery status 200, got ${response.status}`);
        const payload = await response.json();
        const authMethods = Array.isArray(payload?.auth?.methods) ? payload.auth.methods : [];
        assert(authMethods.includes('trusted_proxy_email'), 'Expected discovery auth methods to advertise trusted_proxy_email');
        assert(!('trusted_proxy' in (payload?.auth ?? {})), 'Expected discovery payload to omit trusted proxy internals');
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
        else process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = previousMode;
        if (previousTrustProxy === undefined) delete process.env.PROOF_TRUST_PROXY_HEADERS;
        else process.env.PROOF_TRUST_PROXY_HEADERS = previousTrustProxy;
        if (previousTrustedHeaders === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS = previousTrustedHeaders;
        if (previousTrustedDomains === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = previousTrustedDomains;
        if (previousTrustedEmails === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAILS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAILS = previousTrustedEmails;
      }
    });

    await test('D2: trusted proxy auth does not trust x-forwarded-email by default', async () => {
      const previousMode = process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
      const previousTrustProxy = process.env.PROOF_TRUST_PROXY_HEADERS;
      const previousTrustedHeaders = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
      const previousTrustedDomains = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
      const previousTrustedEmails = process.env.PROOF_TRUSTED_IDENTITY_EMAILS;

      process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = 'oauth';
      process.env.PROOF_TRUST_PROXY_HEADERS = 'true';
      delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
      process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = 'elastic.co';
      delete process.env.PROOF_TRUSTED_IDENTITY_EMAILS;

      try {
        const response = await post(baseUrl, '/api/share/markdown', {
          markdown: '# spoofed forwarded email',
        }, {
          'X-Forwarded-Email': 'spoofed@elastic.co',
        });
        assert(
          response.status === 401 || response.status === 503,
          `Expected spoofed x-forwarded-email to be rejected (401 or 503), got ${response.status}`,
        );
        const payload = await response.json();
        // When OAuth is not configured, the server returns 503 after the proxy check fails.
        // Either way, the spoofed x-forwarded-email was NOT accepted as a trusted identity.
        assert(
          payload.code === 'UNAUTHORIZED' || payload.code === 'OAUTH_NOT_CONFIGURED',
          `Expected rejection code, got ${payload.code}`,
        );
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
        else process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = previousMode;
        if (previousTrustProxy === undefined) delete process.env.PROOF_TRUST_PROXY_HEADERS;
        else process.env.PROOF_TRUST_PROXY_HEADERS = previousTrustProxy;
        if (previousTrustedHeaders === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS = previousTrustedHeaders;
        if (previousTrustedDomains === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = previousTrustedDomains;
        if (previousTrustedEmails === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAILS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAILS = previousTrustedEmails;
      }
    });

    await test('D2: trusted proxy auth rejects ownerId mismatches', async () => {
      const previousMode = process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
      const previousTrustProxy = process.env.PROOF_TRUST_PROXY_HEADERS;
      const previousTrustedHeaders = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
      const previousTrustedDomains = process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
      const previousTrustedEmails = process.env.PROOF_TRUSTED_IDENTITY_EMAILS;

      process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = 'oauth';
      process.env.PROOF_TRUST_PROXY_HEADERS = 'true';
      process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS = 'x-goog-authenticated-user-email';
      process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = 'elastic.co';
      delete process.env.PROOF_TRUSTED_IDENTITY_EMAILS;

      try {
        const mismatchResponse = await post(baseUrl, '/api/share/markdown', {
          markdown: '# mismatched owner',
          ownerId: 'other@elastic.co',
        }, {
          'X-Goog-Authenticated-User-Email': 'accounts.google.com:agent@elastic.co',
        });
        assert(mismatchResponse.status === 403, `Expected ownerId mismatch to be rejected, got ${mismatchResponse.status}`);
        const mismatchPayload = await mismatchResponse.json();
        assertEqual(mismatchPayload.code, 'FORBIDDEN_OWNER_ID_MISMATCH', 'Expected ownerId mismatch code');

        const matchingResponse = await post(baseUrl, '/api/share/markdown', {
          markdown: '# matching owner',
          ownerId: 'agent@elastic.co',
        }, {
          'X-Goog-Authenticated-User-Email': 'accounts.google.com:agent@elastic.co',
        });
        assert(matchingResponse.status === 200, `Expected matching trusted ownerId to succeed, got ${matchingResponse.status}`);
      } finally {
        if (previousMode === undefined) delete process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE;
        else process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE = previousMode;
        if (previousTrustProxy === undefined) delete process.env.PROOF_TRUST_PROXY_HEADERS;
        else process.env.PROOF_TRUST_PROXY_HEADERS = previousTrustProxy;
        if (previousTrustedHeaders === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS = previousTrustedHeaders;
        if (previousTrustedDomains === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS = previousTrustedDomains;
        if (previousTrustedEmails === undefined) delete process.env.PROOF_TRUSTED_IDENTITY_EMAILS;
        else process.env.PROOF_TRUSTED_IDENTITY_EMAILS = previousTrustedEmails;
      }
    });

    await test('D2: /documents/:slug/ops enforces rate limiting', async () => {
      let saw429 = false;
      for (let i = 0; i < 140; i += 1) {
        const response = await post(baseUrl, `/api/documents/${slug}/ops`, {
          type: 'comment.add',
          payload: {
            quote: 'Hi',
            text: `rate-limit-${i}`,
            by: 'human:tester',
          },
        }, {
          'x-share-token': accessToken,
        });
        if (response.status === 429) {
          saw429 = true;
          const retryAfter = response.headers.get('retry-after') ?? response.headers.get('Retry-After');
          assert(Boolean(retryAfter), 'Expected Retry-After header for rate-limited ops');
          break;
        }
      }
      assert(saw429, 'Expected 429 from ops endpoint under sustained request volume');
    });
  });
}

async function run(): Promise<void> {
  console.log('\n=== Server + share lifecycle test suite ===');
  await runServerSourceTests();
  await runServerHookTests();
  await runRoutePayloadValidationTests();
}

run()
  .then(() => {
    console.log(`\n=== Server + share lifecycle test results ===`);
    console.log(`Passed: ${passed}, Failed: ${failed}`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error('Test harness error:', err);
    process.exit(1);
  });
