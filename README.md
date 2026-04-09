# Proof SDK

Proof SDK is the open-source editor, collaboration server, provenance model, and agent HTTP bridge that power collaborative documents in Proof.

If you want the hosted product, use [Proof](https://proofeditor.ai). Hosted Proof is made by [Every](https://every.to).

## What Is Included

- Collaborative markdown editor with provenance tracking
- Comments, suggestions, and rewrite operations
- Realtime collaboration server (WebSocket + Yjs)
- Agent HTTP bridge for state, marks, edits, presence, and events
- Landing page with agent setup instructions
- Docker and Fly.io deployment support
- A small example app under `apps/proof-example`

## Quick Start

```bash
npm install
```

Start both the server and the editor for local development:

```bash
# Terminal 1 — API server
npm run serve

# Terminal 2 — Editor (Vite dev server with hot reload)
npm run dev
```

Then open `http://localhost:5555`. Click **Get started** to create a document and open the editor with the welcome flow.

The API server runs on port **5555** and the Vite dev server on port **5556** (proxies API requests to 5555 automatically).

## Docker

Run the full stack in a single container (no separate Vite server needed — built assets are served by Express):

```bash
# 1. Copy and configure environment
cp .env.example .env
echo "PROOF_COLLAB_SIGNING_SECRET=$(openssl rand -hex 32)" >> .env

# 2. Start
docker compose up --build -d
```

Open `http://localhost:5555`.

## Deploy to Fly.io

```bash
# 1. Create the app and volume
fly launch --no-deploy
fly volumes create proof_data --size 1 --region iad

# 2. Set secrets
fly secrets set PROOF_COLLAB_SIGNING_SECRET=$(openssl rand -hex 32)
fly secrets set PROOF_PUBLIC_BASE_URL=https://your-app.fly.dev

# 3. Deploy
fly deploy
```

Set `PROOF_CORS_ALLOW_ORIGINS=https://your-app.fly.dev` if you need cross-origin access from a separate frontend.

## Workspace Layout

| Path | Description |
|------|-------------|
| `server/` | Express API server, collab runtime, agent bridge |
| `src/` | Editor frontend, bridge clients, tests |
| `packages/doc-core` | Core document model |
| `packages/doc-editor` | Editor components |
| `packages/doc-server` | Server-side document logic |
| `packages/doc-store-sqlite` | SQLite persistence layer |
| `packages/agent-bridge` | Agent HTTP bridge |
| `apps/proof-example` | Example app |

## Core Routes

Canonical Proof SDK routes:

- `POST /documents` — create a new document
- `GET /documents/:slug/state` — read document state
- `GET /documents/:slug/snapshot` — block-level snapshot with base token
- `POST /documents/:slug/edit/v2` — structural block edits
- `POST /documents/:slug/ops` — comments, suggestions, rewrites
- `POST /documents/:slug/presence` — agent presence
- `GET /documents/:slug/events/pending` — poll for events
- `POST /documents/:slug/events/ack` — acknowledge events

Bridge routes (for embedded editor integration):

- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `5555` | Server port |
| `DATABASE_PATH` | No | `./proof-share.db` | SQLite database path |
| `PROOF_COLLAB_SIGNING_SECRET` | Production | — | Signing secret for collab session tokens |
| `PROOF_PUBLIC_BASE_URL` | Production | — | Public URL for share links and WebSocket URLs |
| `PROOF_CORS_ALLOW_ORIGINS` | No | localhost | Comma-separated allowed CORS origins |
| `COLLAB_EMBEDDED_WS` | Docker | — | Set to `true` when WebSocket runs on the same port |
| `PROOF_TRUST_PROXY_HEADERS` | Production | — | Set to `true` behind a reverse proxy |

## Build

```bash
npm run build
```

The build outputs the web bundle to `dist/` and writes `dist/web-artifact-manifest.json`.

## Tests

```bash
npm test
```

## Docs

- `AGENT_CONTRACT.md` — document creation and mutation contract
- `docs/agent-docs.md` — full agent API reference
- `docs/proof.SKILL.md` — agent skill file for Claude Code, Codex, etc.

## License

- Code: `MIT` in `LICENSE`
- Trademark guidance: `TRADEMARKS.md`
