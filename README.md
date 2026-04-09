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

# 2. Optional: enable auth
echo "PROOF_AUTH_STRATEGY=local" >> .env
echo "PROOF_LOCAL_INVITE_CODE=your-secret" >> .env

# 3. Start
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

# 3. Optional: enable auth
fly secrets set PROOF_AUTH_STRATEGY=local
fly secrets set PROOF_LOCAL_INVITE_CODE=your-secret

# Or for WorkOS:
# fly secrets set PROOF_AUTH_STRATEGY=workos
# fly secrets set WORKOS_API_KEY=sk_...
# fly secrets set WORKOS_CLIENT_ID=client_...
# fly secrets set WORKOS_COOKIE_PASSWORD=$(openssl rand -hex 16)
# fly secrets set PROOF_ALLOWED_ORG_IDS=org_...

# 4. Deploy
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

## Authentication

Proof SDK supports pluggable authentication via `PROOF_AUTH_STRATEGY`:

| Strategy | Description |
|----------|-------------|
| `none` | Default. No authentication — anyone can access the instance. |
| `local` | Email/password accounts with optional invite-code gating. |
| `workos` | WorkOS AuthKit SSO with organization-level access control. |

### Local auth (email/password)

```bash
# Open registration
PROOF_AUTH_STRATEGY=local npm run serve

# Invite-code gated registration
PROOF_AUTH_STRATEGY=local PROOF_LOCAL_INVITE_CODE=your-secret npm run serve
```

Users register at `/auth/register` and log in at `/auth/login`. Account settings (name, email, password) are at `/auth/account`.

### WorkOS auth (SSO)

```bash
PROOF_AUTH_STRATEGY=workos \
WORKOS_API_KEY=sk_... \
WORKOS_CLIENT_ID=client_... \
WORKOS_COOKIE_PASSWORD=$(openssl rand -hex 16) \
PROOF_ALLOWED_ORG_IDS=org_... \
npm run serve
```

Add your callback URL (`http://localhost:5555/api/auth/callback`) in the WorkOS dashboard. Set `PROOF_ALLOWED_ORG_IDS` to restrict access to specific organizations.

### Adding a new strategy

1. Create `server/auth/my-strategy.ts` implementing `AuthStrategy` from `server/auth/strategy.ts`.
2. Add a `case` in `server/auth/index.ts`.

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
| `PROOF_AUTH_STRATEGY` | No | `none` | Auth strategy: `none`, `local`, or `workos` |
| `PROOF_LOCAL_INVITE_CODE` | No | — | Invite code for local registration (when set, required to register) |
| `WORKOS_API_KEY` | WorkOS | — | WorkOS API key |
| `WORKOS_CLIENT_ID` | WorkOS | — | WorkOS client ID |
| `WORKOS_COOKIE_PASSWORD` | WorkOS | — | Secret for sealing WorkOS sessions (min 32 chars) |
| `PROOF_ALLOWED_ORG_IDS` | No | — | Comma-separated WorkOS org IDs allowed access |

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
