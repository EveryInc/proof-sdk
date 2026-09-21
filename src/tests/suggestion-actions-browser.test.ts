// Install the test browser with: npx playwright-core install chromium
// Run the browser test with: npm run test:suggestion-browser
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';

const initialMarkdown = '# Apply test\n\nThe first value is red.\n\nThe second value is blue.\n';
const acceptedMarkdown = initialMarkdown.replace('red.', 'green.');

async function eventually(check: () => Promise<void>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let failure: unknown;
  do {
    try { await check(); return; } catch (error) { failure = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${String(failure)}`);
}

async function documentText(page: Page): Promise<string> {
  return page.locator('.ProseMirror').evaluate(root => {
    const copy = root.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.ProseMirror-yjs-cursor, .agent-cursor').forEach(node => node.remove());
    return Array.from(copy.children).map(node => node.textContent).join('\n\n');
  });
}

async function run(): Promise<void> {
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-suggestion-browser-'));
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(temp, 'test.db'),
      COLLAB_PUBLIC_BASE_URL: `ws://127.0.0.1:${port}/ws`, COLLAB_EMBEDDED_WS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-8000); });
  server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-8000); });
  const stopped = new Promise<void>(resolve => server.on('exit', () => resolve()));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await eventually(async () => { assert((await fetch(`${base}/health`)).ok); }, 'The server must start');
    browser = await chromium.launch({
      ...(process.env.PROOF_TEST_CHROME ? { executablePath: process.env.PROOF_TEST_CHROME } : {}),
      headless: true,
    });
    const errors: string[] = [];
    const openPage = async (url: string): Promise<Page> => {
      const context = await browser!.newContext();
      // The test supplies the built asset because the public server omits the dist route.
      await context.route('**/assets/editor.js', route => route.fulfill({
        path: path.resolve('dist/assets/editor.js'), contentType: 'text/javascript',
      }));
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
          errors.push(message.text());
        }
      });
      await page.goto(url);
      await page.locator('.ProseMirror').waitFor();
      const anonymous = page.getByRole('button', { name: 'Continue anonymously' });
      if (await anonymous.isVisible()) await anonymous.click();
      await page.waitForFunction(() => (window as any).proof.debugCollabYDocSummary().synced);
      return page;
    };
    const json = async (route: string, body?: object) => {
      const response = await fetch(`${base}${route}`, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : undefined);
      const payload = await response.json();
      assert(response.ok, JSON.stringify(payload));
      return payload;
    };
    const doc = await json('/documents', { title: 'Suggestion browser test', markdown: initialMarkdown });
    const auth = `?token=${doc.accessToken}`;
    const suggest = (quote: string, content: string) => json(`/documents/${doc.slug}/ops${auth}`, {
      type: 'suggestion.add', kind: 'replace', quote, content, by: 'ai:test',
    });
    const first = await suggest('red', 'green');
    const page = await openPage(`${base}${doc.tokenPath}`);
    const peer = await openPage(`${base}${doc.tokenPath}`);
    const clickAction = async (markId: string, action: 'Apply' | 'Reject') => {
      await page.locator(`.mark-replace-insert[data-mark-id="${markId}"]`).click();
      const response = page.waitForResponse(res => res.url().includes(`/marks/${action === 'Apply' ? 'accept' : 'reject'}`));
      await page.getByRole('button', { name: action, exact: true }).click();
      return response;
    };
    const assertFinal = async (expected: string) => {
      await eventually(async () => {
        const state = await json(`/documents/${doc.slug}/state${auth}`);
        assert.equal(state.markdown, expected);
        assert.equal(Object.values(state.marks).filter((mark: any) =>
          ['insert', 'delete', 'replace'].includes(mark.kind) && mark.status === 'pending').length, 0);
        for (const client of [page, peer]) {
          assert.equal(await documentText(client), expected.replace('# ', '').trim());
          assert.equal(await client.locator('[data-proof="suggestion"]').count(), 0);
        }
      }, 'The browser and server must agree');
      for (const client of [page, peer]) {
        await client.reload();
        await client.locator('.ProseMirror').waitFor();
      }
      await eventually(async () => {
        for (const client of [page, peer]) {
          assert.equal(await documentText(client), expected.replace('# ', '').trim());
          assert.equal(await client.locator('[data-proof="suggestion"]').count(), 0);
        }
      }, 'The completed suggestion must stay complete after reload');
    };
    const accept = await clickAction(first.markId, 'Apply');
    assert.equal(accept.status(), 200, await accept.text());
    await assertFinal(acceptedMarkdown);
    assert.deepEqual(errors, [], 'The suggestion action must not throw.');
    const second = await suggest('blue', 'orange');
    await clickAction(second.markId, 'Reject');
    await assertFinal(acceptedMarkdown);
    assert.deepEqual(errors, [], 'The suggestion action must not throw.');
    const failed = await suggest('blue', 'orange');
    for (const action of ['Apply', 'Reject'] as const) {
      const route = `**/marks/${action === 'Apply' ? 'accept' : 'reject'}`;
      await page.route(route, request => request.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'The test server is unavailable.' }),
      }));
      await clickAction(failed.markId, action);
      await eventually(async () => {
        assert.match(await page.locator('#error-banner').innerText({ timeout: 500 }), /could not/);
        assert.equal(await page.locator(`.mark-replace-insert[data-mark-id="${failed.markId}"]`).count(), 1);
        const state = await json(`/documents/${doc.slug}/state${auth}`);
        assert.equal(state.markdown, acceptedMarkdown);
        assert.equal(state.marks[failed.markId]?.status, 'pending');
      }, 'A failed request must show an error and keep the suggestion');
      await page.unroute(route);
    }
    await clickAction(failed.markId, 'Reject');
    await assertFinal(acceptedMarkdown);
    assert.equal(await page.locator('#error-banner').count(), 0);
    console.log('Apply and Reject preserve the text in both browsers and after reload.');
    console.log('Failed requests show an error and keep the suggestion for another try.');
  } catch (error) {
    console.error(serverLog);
    throw error;
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    await stopped;
    rmSync(temp, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
