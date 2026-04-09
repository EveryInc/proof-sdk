# Proof Example

This workspace is the extraction target for the public `Proof SDK` demo app.

The current private repo still runs the hosted product, but shared editor, server, and bridge code now lives behind the workspace packages in [packages/doc-core](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-core), [packages/doc-editor](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-editor), [packages/doc-server](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-server), [packages/doc-store-sqlite](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/doc-store-sqlite), and [packages/agent-bridge](/Users/danshipper/CascadeProjects/every-proof/.worktrees/proof-sdk-split/packages/agent-bridge).

When the public repo is extracted, this app should become the neutral self-host example for:

- creating a document
- loading a shared document
- collaborative editing
- agent bridge reads and writes
- anonymous or token-based access

## Agent Bridge Demo

Run the reference external-agent flow:

```bash
npm run proof-sdk:demo:agent
```

Environment variables:

- `PROOF_BASE_URL`: defaults to `http://127.0.0.1:5555`
- `PROOF_DEMO_TITLE`: optional document title override
- `PROOF_DEMO_MARKDOWN`: optional initial markdown override

The demo creates a document through `POST /documents`, then uses `@proof/agent-bridge` to publish presence, read state, and add a comment through the neutral `/documents/:slug/bridge/*` API.
