# Deployment

Proof SDK has two deployment targets: the Express server (any Node.js host) and Cloudflare Workers with Durable Objects. Both serve the same editor frontend and agent HTTP bridge.

| | Express | Cloudflare Workers |
|---|---------|-------------------|
| Architecture | Node.js process, SQLite on disk, Hocuspocus collab | Worker + Durable Objects, D1 catalog, DO-embedded SQLite |
| Scaling | Vertical (single process) | Horizontal (per-document DO isolation) |
| State | Single SQLite file | D1 for catalog, SQLite-in-DO per document |
| Cold start | None (long-running process) | ~10-50ms (Worker + DO) |
| WebSocket collab | Hocuspocus on dedicated port | WebSocket via Durable Object |
| Cost | Host-dependent | Workers Paid ($5/mo base) |
| Best for | Familiarity, self-hosting, full feature set | Global edge, per-document isolation, zero-ops scaling |

## Prerequisites

- Node.js 18+
- `npm install && npm run build` (Vite IIFE bundle to `dist/`)

## Option 1: Express Server

### Local production test

```bash
npm run serve
```

Express listens on `:4000`, Hocuspocus collab on `:4001`. SQLite (`proof-share.db`) is auto-created on first run — no migrations needed.

### Environment variables

Core:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | HTTP listen port |
| `NODE_ENV` | `development` | Node environment |
| `PROOF_ENV` | from `NODE_ENV` | Proof-specific environment override |
| `DATABASE_PATH` | `./proof-share.db` | SQLite database path |

Auth:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROOF_SHARE_MARKDOWN_AUTH_MODE` | `none` | Auth mode: `none` or `api_key` |
| `PROOF_SHARE_MARKDOWN_API_KEY` | — | Required when auth mode is `api_key` |

Collab:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROOF_COLLAB_SIGNING_SECRET` | auto-generated | Signing secret for collab tokens. Auto-generated in dev; set explicitly in production for stable sessions across restarts |
| `COLLAB_PORT` | `PORT + 1` | Hocuspocus WebSocket port |
| `COLLAB_PUBLIC_BASE_URL` | `ws://localhost:<COLLAB_PORT>` | Public WebSocket URL for clients |

Network:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROOF_CORS_ALLOW_ORIGINS` | localhost:3000,4000 | Comma-separated allowed CORS origins |
| `PROOF_PUBLIC_ORIGIN` | auto-detected | Public URL for link generation |
| `PROOF_PUBLIC_BASE_URL` | auto-detected | Base URL for API responses |

Many additional tuning variables exist for collab timeouts, agent edit stability, snapshot storage, and more. See `server/collab.ts` and `server/agent-routes.ts` for the full set.

### Deploy to Railway

1. Connect your GitHub repo in the Railway dashboard
2. Set environment variables:
   ```
   NODE_ENV=production
   PROOF_COLLAB_SIGNING_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   PROOF_CORS_ALLOW_ORIGINS=https://your-domain.up.railway.app
   PROOF_PUBLIC_ORIGIN=https://your-domain.up.railway.app
   ```
   (`PORT` is auto-assigned by Railway)
3. Add a volume mounted at `/data` for SQLite persistence
4. Set `DATABASE_PATH=/data/proof-share.db`
5. Generate a domain in Railway settings
6. Verify: `curl https://your-domain.up.railway.app/health`

### Other Node.js hosts

Works on any host that runs Node.js — Render, Fly.io, DigitalOcean App Platform, etc. Key requirements:

- **Persistent volume** for SQLite (ephemeral filesystems lose data on redeploy)
- **WebSocket support** for realtime collab (both HTTP and WS ports)
- **`PORT` env var** (most PaaS platforms set this automatically)

## Option 2: Cloudflare Workers + Durable Objects

### Prerequisites

- Cloudflare account with **Workers Paid plan** ($5/mo) — required for Durable Objects
- Wrangler CLI:
  ```bash
  npm install -g wrangler
  wrangler login
  ```

### Setup

1. Create the D1 database:
   ```bash
   wrangler d1 create proof-catalog
   ```

2. Update `database_id` in `apps/proof-cloudflare/wrangler.jsonc` with the ID from step 1.

3. Run the D1 migration:
   ```bash
   cd apps/proof-cloudflare
   wrangler d1 migrations apply proof-catalog --remote
   ```

4. Build the frontend (from repo root):
   ```bash
   npm run build
   ```

5. Deploy:
   ```bash
   cd apps/proof-cloudflare
   npx wrangler deploy
   ```

### Local development

```bash
npm run build                          # build frontend assets
cd apps/proof-cloudflare && npm run dev  # Miniflare with D1 + DO simulation
```

### Configuration

All bindings are declared in `wrangler.jsonc`:

- **D1** (`CATALOG_DB`) — document catalog (slug, title, DO mapping)
- **Durable Objects** (`DOCUMENT_SESSION`) — per-document state, collab, marks
- **Assets** — serves the built editor from `../../dist/`
- **`run_worker_first`** — routes `/`, `/d/*`, `/api/*`, `/documents/*`, `/ws`, `/health` to the Worker before falling through to static assets

DO migrations (`new_sqlite_classes`) are declared in config and auto-applied on deploy.

### CI/CD

A GitHub Actions workflow is included at `.github/workflows/deploy-cloudflare.yml`. It's **manual-trigger only** (`workflow_dispatch`) — it won't run on push or merge. This is intentional: the repo is an SDK, and most contributors won't have or need a Cloudflare deployment. The workflow is there so that anyone who *does* deploy can use it without writing their own.

**Setup:**

1. Create a Cloudflare API token with `Workers Scripts:Edit` and `D1:Edit` permissions
2. Add it as `CLOUDFLARE_API_TOKEN` in your repo (Settings > Secrets and variables > Actions)
3. Trigger from the Actions tab or CLI:
   ```bash
   gh workflow run deploy-cloudflare.yml
   ```

The workflow runs `npm ci`, `npm run build` (frontend bundle), then `wrangler deploy` from `apps/proof-cloudflare/`. D1 and Durable Object migrations are applied automatically by Wrangler on each deploy.

**Upgrading to auto-deploy:**

If you're running your own fork and want every merge to `main` to deploy automatically, add a `push` trigger alongside the existing `workflow_dispatch`:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "apps/proof-cloudflare/**"
      - "src/**"
      - "packages/**"
      - "package.json"
  workflow_dispatch:
    inputs:
      environment:
        description: "Deployment environment"
        required: false
        default: "production"
        type: choice
        options:
          - production
          - preview
```

The `paths` filter avoids deploying on doc-only changes. You can still trigger manually for off-cycle deploys or to select the preview environment.

### Custom domain

Add `routes` or `custom_domain` to `wrangler.jsonc`, or configure via the Cloudflare dashboard under Workers > your worker > Settings > Domains & Routes.

### Secrets

If using API key auth:

```bash
wrangler secret put PROOF_API_KEY
```

## Architecture Comparison

| | Express | Workers + DO |
|---|---------|-------------|
| Scaling model | Single process, vertical | Per-document Durable Object, horizontal |
| Document isolation | Shared process, shared SQLite | Each document in its own DO with embedded SQLite |
| Cold start | None | ~10-50ms |
| Failure blast radius | Whole server | Single document |
| Horizontal scaling | Requires external coordination | Automatic per-document |
| WebSocket | Hocuspocus (separate port) | Native DO WebSocket |
| Persistence | SQLite file on disk | D1 (catalog) + DO storage (documents) |

**Choose Express** when you want full feature parity with the reference server, need a single deployment artifact, or are already running Node.js infrastructure.

**Choose Workers** when you need global edge deployment, per-document isolation, or want to avoid managing servers.

## Health Checks

- **Express**: `GET /health` — returns JSON with `ok`, build info, and collab runtime state
- **Workers**: `GET /health` — returns `200 OK`

## Verify Your Deployment

1. Visit the root URL — you should see the Proof SDK landing page
2. Create a document: `curl -X POST https://your-host/documents`
3. Open the returned URL in two browser tabs to verify realtime collab
4. Test agent endpoints:
   ```bash
   # Get document state
   curl https://your-host/documents/<slug>/state

   # Add a comment
   curl -X POST https://your-host/documents/<slug>/bridge/comments \
     -H "Content-Type: application/json" \
     -d '{"text": "Test comment", "target": "first paragraph"}'
   ```
5. Check health: `curl https://your-host/health`
