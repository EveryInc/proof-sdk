# Proof Example

This workspace is the extraction target for the public `Proof SDK` demo app.

The current private repo still runs the hosted product, but shared editor, server, and bridge code now lives behind the workspace packages in [packages/doc-core](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-core), [packages/doc-editor](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-editor), [packages/doc-server](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-server), [packages/doc-store-sqlite](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-store-sqlite), and [packages/agent-bridge](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/agent-bridge).

When the public repo is extracted, this app should become the neutral self-host example for:

- creating a document
- loading a shared document
- collaborative editing
- agent bridge reads and writes
- anonymous or token-based access

## Agent Bridge Demos

### Basic Agent Flow

Run the reference external-agent flow:

```bash
npm run demo:agent
```

The demo creates a document through `POST /documents`, then uses `@proof/agent-bridge` to publish presence, read state, and add a comment.

### Multi-Step Workflow

Demonstrates building a structured document through sequential editV2 operations:

```bash
npm run demo:workflow
```

Shows:
- Document creation with initial structure
- Revision tracking between edits
- Batch operations (multiple blocks in one request)
- Proper error handling

### Edit V2 Operations Reference

Comprehensive demonstration of all 6 editV2 block-level operations:

```bash
npm run demo:operations
```

Tests:
- `replace_block` - Update single block
- `insert_after` - Add blocks after reference
- `insert_before` - Add blocks before reference
- `delete_block` - Remove block
- `find_replace_in_block` - Text replacement
- `replace_range` - Replace multiple consecutive blocks

### Environment Variables

All demos support:

- `PROOF_BASE_URL`: defaults to `http://127.0.0.1:4000`
- `PROOF_DEMO_TITLE`: optional document title override (basic demo only)
- `PROOF_DEMO_MARKDOWN`: optional initial markdown override (basic demo only)
