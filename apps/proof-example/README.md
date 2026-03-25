# Proof Example

This is the self-host example app for the Proof SDK, demonstrating:

- creating a document
- loading a shared document
- collaborative editing
- agent bridge reads and writes
- anonymous or token-based access

Shared editor, server, and bridge code lives in the workspace packages:
[packages/doc-core](../../packages/doc-core),
[packages/doc-editor](../../packages/doc-editor),
[packages/doc-server](../../packages/doc-server),
[packages/doc-store-sqlite](../../packages/doc-store-sqlite), and
[packages/agent-bridge](../../packages/agent-bridge).

## Agent Bridge Demo

First build the editor and start the server from the repo root:

```bash
npm run build
npm run serve
```

Then run the reference external-agent flow:

```bash
npm --workspace proof-example run demo:agent
```

Environment variables:

- `PROOF_BASE_URL`: defaults to `http://127.0.0.1:4000`
- `PROOF_DEMO_TITLE`: optional document title override
- `PROOF_DEMO_MARKDOWN`: optional initial markdown override

The demo creates a document through `POST /documents`, then uses `@proof/agent-bridge` to publish
presence, read state, and add a comment through the neutral `/documents/:slug/*` API. It prints a
`viewUrl` you can open in a browser to see the result.
