/**
 * Edit V2 Operations Reference
 * 
 * Comprehensive demonstration of all 6 editV2 block-level operations:
 * - replace_block
 * - insert_after
 * - insert_before
 * - delete_block
 * - find_replace_in_block
 * - replace_range
 * 
 * Each operation is demonstrated with proper error handling and revision tracking.
 * 
 * Run with:
 *   tsx apps/proof-example/examples/editv2-operations.ts
 */

import { createAgentBridgeClient } from '@proof/agent-bridge';
import { randomUUID } from 'crypto';

async function demonstrateEditV2Operations(): Promise<void> {
  const baseUrl = process.env.PROOF_BASE_URL || 'http://127.0.0.1:4000';
  
  console.log('🧪 Testing Proof SDK editV2 Operations');
  console.log('======================================\n');

  // Create test document
  console.log('1️⃣  Creating test document...');
  const createResponse = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: [
        '# Original Title',
        '',
        'First paragraph.',
        '',
        'Second paragraph.',
        '',
        'Third paragraph.',
      ].join('\n'),
      title: 'EditV2 Operations Test',
    }),
  });

  const { slug, accessToken } = await createResponse.json() as {
    slug: string;
    accessToken: string;
  };

  console.log(`   ✅ Created document: ${slug}\n`);

  const bridge = createAgentBridgeClient({
    baseUrl,
    auth: { shareToken: accessToken },
  });

  // Get initial state
  console.log('2️⃣  Getting initial state...');
  let state = await bridge.getState<{ revision: number; markdown: string }>(slug);
  console.log(`   📄 Revision: ${state.revision}`);
  console.log('   📝 Content:');
  console.log(state.markdown.split('\n').map(line => `      ${line}`).join('\n'));
  console.log('');

  // Operation 1: replace_block
  console.log('3️⃣  Testing replace_block operation...');
  const replaceResult = await bridge.editV2(slug, {
    by: 'ai:test-agent',
    baseRevision: state.revision,
    operations: [
      {
        op: 'replace_block',
        ref: 'b1',
        block: { markdown: '# REPLACED TITLE' },
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!replaceResult.success) {
    console.error('   ❌ Failed:', replaceResult);
    process.exit(1);
  }
  console.log(`   ✅ Success! New revision: ${replaceResult.revision}\n`);

  // Operation 2: insert_after
  console.log('4️⃣  Testing insert_after operation...');
  const insertAfterResult = await bridge.editV2(slug, {
    by: 'ai:test-agent',
    baseRevision: replaceResult.revision,
    operations: [
      {
        op: 'insert_after',
        ref: 'b2',
        blocks: [
          { markdown: '## Inserted Section' },
          { markdown: 'This was **inserted** after the second block.' },
        ],
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!insertAfterResult.success) {
    console.error('   ❌ Failed:', insertAfterResult);
    process.exit(1);
  }
  console.log(`   ✅ Success! New revision: ${insertAfterResult.revision}\n`);

  // Operation 3: find_replace_in_block
  console.log('5️⃣  Testing find_replace_in_block operation...');
  const findReplaceResult = await bridge.editV2(slug, {
    by: 'ai:test-agent',
    baseRevision: insertAfterResult.revision,
    operations: [
      {
        op: 'find_replace_in_block',
        ref: 'b2',
        find: 'First',
        replace: 'FIND-REPLACED',
        occurrence: 'all',
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!findReplaceResult.success) {
    console.error('   ❌ Failed:', findReplaceResult);
    process.exit(1);
  }
  console.log(`   ✅ Success! New revision: ${findReplaceResult.revision}\n`);

  // Operation 4: delete_block
  console.log('6️⃣  Testing delete_block operation...');
  const deleteResult = await bridge.editV2(slug, {
    by: 'ai:test-agent',
    baseRevision: findReplaceResult.revision,
    operations: [
      {
        op: 'delete_block',
        ref: 'b5',
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!deleteResult.success) {
    console.error('   ❌ Failed:', deleteResult);
    process.exit(1);
  }
  console.log(`   ✅ Success! New revision: ${deleteResult.revision}\n`);

  // Operation 5: insert_before
  console.log('7️⃣  Testing insert_before operation...');
  const insertBeforeResult = await bridge.editV2(slug, {
    by: 'ai:test-agent',
    baseRevision: deleteResult.revision,
    operations: [
      {
        op: 'insert_before',
        ref: 'b1',
        blocks: [{ markdown: '*Prepended at the top*' }],
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!insertBeforeResult.success) {
    console.error('   ❌ Failed:', insertBeforeResult);
    process.exit(1);
  }
  console.log(`   ✅ Success! New revision: ${insertBeforeResult.revision}\n`);

  // Operation 6: replace_range
  console.log('8️⃣  Testing replace_range operation...');
  const replaceRangeResult = await bridge.editV2(slug, {
    by: 'ai:test-agent',
    baseRevision: insertBeforeResult.revision,
    operations: [
      {
        op: 'replace_range',
        fromRef: 'b3',
        toRef: 'b4',
        blocks: [{ markdown: '## Consolidated Section\n\nThis replaces blocks 3-4.' }],
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!replaceRangeResult.success) {
    console.error('   ❌ Failed:', replaceRangeResult);
    process.exit(1);
  }
  console.log(`   ✅ Success! New revision: ${replaceRangeResult.revision}\n`);

  // Get final state
  console.log('9️⃣  Final document state:');
  const finalState = await bridge.getState<{ revision: number; markdown: string }>(slug);
  console.log(`   📄 Final revision: ${finalState.revision}`);
  console.log('   📝 Final content:');
  console.log(finalState.markdown.split('\n').map(line => `      ${line}`).join('\n'));
  console.log('');

  console.log('======================================');
  console.log('✅ All editV2 operations working!\n');
  console.log('📊 Summary:');
  console.log('   - replace_block: ✅');
  console.log('   - insert_after: ✅');
  console.log('   - insert_before: ✅');
  console.log('   - delete_block: ✅');
  console.log('   - find_replace_in_block: ✅');
  console.log('   - replace_range: ✅');
  console.log('');
  console.log(`🔗 View document: ${baseUrl}/d/${slug}`);
}

demonstrateEditV2Operations().catch((error) => {
  console.error('[editv2-operations] Failed:');
  console.error(error);
  process.exit(1);
});
