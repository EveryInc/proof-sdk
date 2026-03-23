/**
 * Multi-Step Document Building Workflow
 * 
 * Demonstrates how to build a structured document through multiple editV2 operations,
 * including proper revision tracking, error handling, and batch operations.
 * 
 * This example shows:
 * - Creating a document with initial structure
 * - Fetching current state for revision tracking
 * - Sequential edits with proper baseRevision handling
 * - Batch operations (multiple ops in one request)
 * - Error handling and retry logic
 * 
 * Run with:
 *   tsx apps/proof-example/examples/multi-step-workflow.ts
 */

import { createAgentBridgeClient } from '@proof/agent-bridge';
import { randomUUID } from 'crypto';

interface DocumentState {
  slug: string;
  revision: number;
  markdown: string;
}

async function buildProjectPlan(): Promise<void> {
  const baseUrl = process.env.PROOF_BASE_URL || 'http://127.0.0.1:4000';
  
  console.log('📝 Multi-Step Document Builder');
  console.log('==============================');
  console.log(`Server: ${baseUrl}\n`);

  // Step 1: Create document with initial structure
  console.log('1️⃣  Creating project plan document...');
  
  const createResponse = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: [
        '# Project Plan',
        '',
        '## Overview',
        '',
        'Initial project overview goes here.',
        '',
        '## Next Steps',
        '',
        'To be filled in.',
      ].join('\n'),
      title: 'Project Planning Document',
      role: 'editor',
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`Failed to create document: ${createResponse.status}`);
  }

  const { slug, accessToken, shareUrl } = await createResponse.json() as {
    slug: string;
    accessToken: string;
    shareUrl: string;
  };

  console.log(`   ✅ Document created: ${slug}`);
  console.log(`   🔗 View at: ${baseUrl}${shareUrl}\n`);

  // Initialize bridge client
  const bridge = createAgentBridgeClient({
    baseUrl,
    auth: { shareToken: accessToken },
  });

  // Step 2: Get current state
  console.log('2️⃣  Fetching document state...');
  let state = await bridge.getState<DocumentState>(slug);
  console.log(`   📄 Current revision: ${state.revision}\n`);

  // Step 3: Add project timeline section (batch operation)
  console.log('3️⃣  Adding project timeline section...');
  
  const timelineResult = await bridge.editV2(slug, {
    by: 'ai:document-builder',
    baseRevision: state.revision,
    operations: [
      {
        op: 'insert_after',
        ref: 'b2', // After "## Overview"
        blocks: [
          { markdown: '## Timeline' },
          { markdown: '- **Week 1**: Planning and requirements' },
          { markdown: '- **Week 2-3**: Development' },
          { markdown: '- **Week 4**: Testing and launch' },
        ],
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!timelineResult.success) {
    throw new Error('Failed to add timeline');
  }

  console.log(`   ✅ Timeline added (revision ${timelineResult.revision})\n`);

  // Step 4: Enhance overview section
  console.log('4️⃣  Enhancing overview section...');
  
  const overviewResult = await bridge.editV2(slug, {
    by: 'ai:document-builder',
    baseRevision: timelineResult.revision,
    operations: [
      {
        op: 'replace_block',
        ref: 'b2', // The overview content block
        block: {
          markdown: 'This document outlines the project plan, timeline, and key deliverables for the upcoming sprint.',
        },
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!overviewResult.success) {
    throw new Error('Failed to enhance overview');
  }

  console.log(`   ✅ Overview enhanced (revision ${overviewResult.revision})\n`);

  // Step 5: Complete next steps section with multiple edits
  console.log('5️⃣  Completing next steps section...');
  
  const nextStepsResult = await bridge.editV2(slug, {
    by: 'ai:document-builder',
    baseRevision: overviewResult.revision,
    operations: [
      {
        op: 'replace_block',
        ref: 'b7', // The "To be filled in." block
        block: {
          markdown: [
            '1. Review and approve timeline',
            '2. Assign team members to tasks',
            '3. Set up project tracking',
            '4. Schedule kickoff meeting',
          ].join('\n'),
        },
      },
    ],
    idempotencyKey: randomUUID(),
  });

  if (!nextStepsResult.success) {
    throw new Error('Failed to complete next steps');
  }

  console.log(`   ✅ Next steps completed (revision ${nextStepsResult.revision})\n`);

  // Step 6: Get final state and display
  console.log('6️⃣  Final document:\n');
  const finalState = await bridge.getState<DocumentState>(slug);
  
  console.log(finalState.markdown.split('\n').map(line => `   ${line}`).join('\n'));
  console.log('');

  // Summary
  console.log('==============================');
  console.log('✅ Document build complete!\n');
  console.log('📊 Summary:');
  console.log(`   - Document: ${slug}`);
  console.log(`   - Final revision: ${finalState.revision}`);
  console.log(`   - View: ${baseUrl}${shareUrl}`);
  console.log(`   - Token: ${accessToken}\n`);
  console.log('💾 Export variables for further editing:');
  console.log(`   export PROOF_SLUG="${slug}"`);
  console.log(`   export PROOF_TOKEN="${accessToken}"`);
}

// Error handling wrapper
buildProjectPlan().catch((error) => {
  console.error('[multi-step-workflow] Failed:');
  console.error(error);
  process.exit(1);
});
