import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-ghost-presence-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  const slug = `ghost-agent-${Math.random().toString(36).slice(2, 10)}`;

  try {
    db.createDocument(slug, '# Ghost test\n\nBody text.', {}, 'Ghost presence regression');

    // Build a Y.Doc that simulates a Yjs snapshot loaded from DB after restart:
    // presence is baked in (from a prior session) but NO SQLite agent_presence row
    // exists (the dual-write path was never invoked — e.g., legacy data or server crash).
    const ydoc = new Y.Doc();
    const ghostId = 'ai:ghost-session-agent';
    const ghostEntry = {
      id: ghostId,
      name: 'Ghost Session Agent',
      status: 'active',
      at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
    };
    ydoc.transact(() => {
      ydoc.getMap<unknown>('agentPresence').set(ghostId, ghostEntry);
    }, 'test-ghost-write');

    const presenceMap = ydoc.getMap<unknown>('agentPresence');
    assert(presenceMap.has(ghostId), 'Expected ghost to be in Yjs map before prune');

    // Sanity check: SQLite has no row for this agent (dual-write was never called).
    const activeBeforePrune = db.getActiveAgentPresence(slug);
    assert(
      !activeBeforePrune.some((r) => r.agentId === ghostId),
      'Expected ghost agent NOT in SQLite agent_presence before prune',
    );

    // Simulate the onLoadDocument ghost-eviction path: register the doc in loadedDocs
    // and call pruneExpiredAgentEphemera. This is exactly what the collab runtime does
    // when a document is first loaded after a restart (see onLoadDocument hooks in
    // startCollabRuntimeEmbedded / startCollabRuntime).
    collab.__unsafePruneAgentEphemeraForTests(slug, ydoc);

    assert(
      !presenceMap.has(ghostId),
      `Expected ghost agent "${ghostId}" to be evicted: present in Yjs but absent from SQLite active set`,
    );

    // Also verify that a legitimately active agent (with a current SQLite row) is NOT evicted.
    const activeId = 'ai:active-agent';
    const activeEntry = {
      id: activeId,
      name: 'Active Agent',
      status: 'active',
      at: new Date().toISOString(),
    };
    ydoc.transact(() => {
      presenceMap.set(activeId, activeEntry);
    }, 'test-active-write');

    // Upsert into SQLite as if applyAgentPresenceToLoadedCollab had been called normally.
    const ttlMs = 30_000;
    db.upsertAgentPresence(slug, activeId, 'presence', activeEntry, Date.now() + ttlMs);

    collab.__unsafePruneAgentEphemeraForTests(slug, ydoc);

    assert(
      presenceMap.has(activeId),
      `Expected active agent "${activeId}" to survive prune (present in SQLite active set)`,
    );

    console.log('✓ Ghost agent evicted on load; active agent preserved');
    console.log('✓ pruneExpiredAgentEphemera correctly cross-references SQLite active set');

    // --- Cursor ghost eviction ---
    const cursorMap = ydoc.getMap<unknown>('agentCursors');
    const ghostCursorId = 'ai:ghost-cursor-agent';
    const ghostCursorEntry = {
      id: ghostCursorId,
      quote: 'some text',
      ttlMs: 30_000,
      at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    ydoc.transact(() => {
      cursorMap.set(ghostCursorId, ghostCursorEntry);
    }, 'test-ghost-cursor-write');

    assert(cursorMap.has(ghostCursorId), 'Expected ghost cursor to be in Yjs map before prune');

    // No SQLite row for this cursor agent — simulates legacy / crashed state.
    const cursorActiveBeforePrune = db.getActiveAgentPresence(slug);
    assert(
      !cursorActiveBeforePrune.some((r) => r.agentId === ghostCursorId && r.kind === 'cursor'),
      'Expected ghost cursor agent NOT in SQLite agent_presence before prune',
    );

    collab.__unsafePruneAgentEphemeraForTests(slug, ydoc);

    assert(
      !cursorMap.has(ghostCursorId),
      `Expected ghost cursor "${ghostCursorId}" to be evicted: present in Yjs but absent from SQLite active set`,
    );

    // Verify that a legitimately active cursor (with a current SQLite row) is NOT evicted.
    const activeCursorId = 'ai:active-cursor-agent';
    const activeCursorEntry = {
      id: activeCursorId,
      quote: 'active text',
      ttlMs: 30_000,
      at: new Date().toISOString(),
    };
    ydoc.transact(() => {
      cursorMap.set(activeCursorId, activeCursorEntry);
    }, 'test-active-cursor-write');

    db.upsertAgentPresence(slug, activeCursorId, 'cursor', activeCursorEntry, Date.now() + 30_000);

    collab.__unsafePruneAgentEphemeraForTests(slug, ydoc);

    assert(
      cursorMap.has(activeCursorId),
      `Expected active cursor "${activeCursorId}" to survive prune (present in SQLite active set)`,
    );

    console.log('✓ Ghost cursor evicted on load; active cursor preserved');
  } finally {
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
