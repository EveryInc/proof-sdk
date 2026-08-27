/**
 * A comment submitted while the collab provider is dead must still become
 * durable, and replaying it on reconnect must not duplicate it.
 *
 * This is the server-side half of the token-expiry defect. The client-side
 * decisions live in src/tests/collab-session-renewal-expiry.test.ts; this file
 * proves the REST path those decisions now select actually persists a comment
 * and converges on replay, with a live collab room loaded for the same slug.
 *
 * Field state being reproduced: revision=1, marks='{}', zero
 * document_y_updates, no comment events, while the browser tab showed the
 * comment.
 */

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function commentMark(id: string, text: string): Record<string, unknown> {
  return {
    kind: 'comment',
    by: 'human:durability-test',
    text,
    quote: 'collaborative session fixture',
    resolved: false,
    id,
  };
}

function readMarks(row: { marks?: string | null } | null | undefined): Record<string, unknown> {
  if (!row?.marks) return {};
  try {
    const parsed = JSON.parse(row.marks) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function commentKeys(marks: Record<string, unknown>): string[] {
  return Object.entries(marks)
    .filter(([, value]) => (value as { kind?: string } | null)?.kind === 'comment')
    .map(([key]) => key)
    .sort();
}

async function run(): Promise<void> {
  const dbName = `proof-comment-durability-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `comment-durability-${Math.random().toString(36).slice(2, 10)}`;
  const markdown = [
    '# Durability',
    '',
    'This is a longer collaborative session fixture with room for comment anchors.',
  ].join('\n');

  try {
    db.createDocument(slug, markdown, {}, 'comment durability across token expiry');

    await collab.startCollabRuntimeEmbedded(4000);
    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as {
      createDocument?: (
        slug: string,
        request: Record<string, unknown>,
        socketId: string,
        context: Record<string, unknown>,
        hooks: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    assert(Boolean(instance?.createDocument), 'Expected collab test instance');

    // A tab has the document open; the room is live even though the tab's own
    // provider is about to be closed out by an expired token.
    await instance.createDocument!(
      slug,
      {},
      'comment-durability-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );

    const baseline = readMarks(db.getDocumentBySlug(slug));
    assert(
      commentKeys(baseline).length === 0,
      `Expected no comments before the test writes any. keys=${commentKeys(baseline).join(',')}`,
    );

    // The provider is dead (expired token). shouldUseRestMarksFallback() now
    // selects REST, which lands here.
    const first = commentMark('c-first', 'written while the provider was dead');
    assert(db.updateMarks(slug, { 'c-first': first }), 'Expected REST marks write to succeed');

    await sleep(300);

    const afterFirst = readMarks(db.getDocumentBySlug(slug));
    assert(
      commentKeys(afterFirst).length === 1,
      `Expected exactly one durable comment after the REST fallback. keys=${commentKeys(afterFirst).join(',')}`,
    );
    assert(
      JSON.stringify(afterFirst['c-first']).includes('written while the provider was dead'),
      'Expected the comment body to survive the REST write',
    );

    // Reconnect: the preserved local Y.Doc replays the same mark. Marks are
    // keyed by mark id, so this must converge rather than append a second copy.
    assert(
      db.updateMarks(slug, { 'c-first': first }),
      'Expected replay of an already-persisted mark to be accepted',
    );

    await sleep(300);

    const afterReplay = readMarks(db.getDocumentBySlug(slug));
    assert(
      commentKeys(afterReplay).length === 1,
      `Expected replay not to duplicate the comment. keys=${commentKeys(afterReplay).join(',')}`,
    );

    // A genuinely new comment must still land, so convergence is not just
    // swallowing every subsequent write.
    const second = commentMark('c-second', 'added after reconnect');
    assert(
      db.updateMarks(slug, { 'c-first': first, 'c-second': second }),
      'Expected a second distinct comment to be accepted',
    );

    await sleep(300);

    const afterSecond = readMarks(db.getDocumentBySlug(slug));
    assert(
      commentKeys(afterSecond).join(',') === 'c-first,c-second',
      `Expected both comments to be durable and distinct. keys=${commentKeys(afterSecond).join(',')}`,
    );

    // The agent API reads through the canonical projection, which is where the
    // field report saw '{}' while the browser showed comments.
    const canonical = await collab.getCanonicalReadableDocument?.(slug, 'state');
    if (canonical) {
      const canonicalMarks = typeof (canonical as { marks?: unknown }).marks === 'string'
        ? readMarks(canonical as { marks?: string })
        : ((canonical as { marks?: Record<string, unknown> }).marks ?? {});
      assert(
        commentKeys(canonicalMarks).length === 2,
        `Expected the canonical read used by the agent API to expose both comments. keys=${commentKeys(canonicalMarks).join(',')}`,
      );
    }

    console.log('✓ comments written while the provider is dead persist once and survive replay');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDbPath;
    }
    try {
      const collab = await import('../../server/collab.ts');
      await collab.stopCollabRuntime();
    } catch {
      // ignore teardown errors
    }
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
