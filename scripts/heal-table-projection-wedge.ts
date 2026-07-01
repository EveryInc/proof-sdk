#!/usr/bin/env tsx
// One-time heal for documents wedged by the table-projection bug.
//
// Documents created before the write-time markdown normalization fix store raw
// canonical markdown that never matches the collab fragment's serialization
// (the Milkdown GFM serializer pads table columns and injects `:---` alignment
// markers). Such docs are stuck on readSource=yjs_fallback / mutationReady=false:
// agent mutations return 409 PROJECTION_STALE and browser edits are dropped.
//
// This script rewrites each affected doc's canonical markdown to the fragment
// serialization so the projection converges. It is idempotent — already-canonical
// docs are skipped — so it is safe to re-run.
//
// Usage (run with the server stopped to avoid write contention):
//   DATABASE_PATH=$HOME/.proof/proof-share.db npx tsx scripts/heal-table-projection-wedge.ts
//   DATABASE_PATH=... npx tsx scripts/heal-table-projection-wedge.ts --dry-run

const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const db = await import('../server/db.ts');
  const collab = await import('../server/collab.ts');

  const docs = db.listActiveDocuments();
  console.log(`[heal] scanning ${docs.length} active document(s)${dryRun ? ' (dry run)' : ''}`);

  let healed = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of docs) {
    try {
      if (dryRun) {
        // In dry-run, compute the normalized form without writing. Mirror the
        // real heal's gate exactly, including stripEphemeralCollabSpans, so the
        // count doesn't mislead the operator.
        const current = collab.stripEphemeralCollabSpans(doc.markdown ?? '');
        if (current.trim().length === 0) { skipped += 1; continue; }
        const normalized = await collab.deriveCanonicalMarkdownForStorage(current);
        // Match healCanonicalMarkdownForCollabFragment's gate: only structural
        // divergence wedges; trailing-whitespace-only diffs are skipped.
        if (normalized.trimEnd() !== current.trimEnd()) {
          healed += 1;
          console.log(`[heal] WOULD heal ${doc.slug} (${current.length} -> ${normalized.length} chars)`);
        } else {
          skipped += 1;
        }
        continue;
      }

      const result = await collab.healCanonicalMarkdownForCollabFragment(doc.slug);
      if (result.healed) {
        healed += 1;
        console.log(`[heal] healed ${doc.slug} (${result.before} -> ${result.after} chars)`);
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`[heal] FAILED ${doc.slug}:`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`[heal] done — ${healed} ${dryRun ? 'would be ' : ''}healed, ${skipped} already canonical, ${failed} failed`);
  await collab.stopCollabRuntime();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
