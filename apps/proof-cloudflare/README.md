# Proof Cloudflare

Cloudflare Workers + Durable Objects deployment target for the Proof SDK. Same editor, same agent bridge, different runtime.

Each document gets its own Durable Object instance with embedded SQLite, Yjs collab, and WebSocket handling. D1 stores the cross-document catalog (slug-to-DO mapping).

## Quick Start

Prerequisites: Node.js 18+, Cloudflare account with Workers Paid ($5/mo), Wrangler CLI.

```bash
# From repo root
npm install && npm run build

# Create D1 database
wrangler d1 create proof-catalog
# Update database_id in wrangler.jsonc with the returned ID

# Run migration
cd apps/proof-cloudflare
wrangler d1 migrations apply proof-catalog --remote

# Deploy
npx wrangler deploy
```

## Local Development

```bash
npm run build            # build frontend assets (from repo root)
cd apps/proof-cloudflare
npm run dev              # Miniflare with D1 + DO simulation
```

## Architecture

```
Worker (index.ts)
├── GET  /              → create doc, redirect to /d/:slug
├── GET  /d/:slug       → serve SPA (rewrite asset paths)
├── POST /documents     → API doc creation
├── POST /share/markdown → create from raw markdown
├── GET  /health        → 200 OK
├── GET  /.well-known/agent.json → agent discovery
├── /api/agent/:slug/*  → route to Durable Object
├── /documents/:slug/*  → route to Durable Object
└── /ws/:slug           → route to Durable Object

DocumentSession (Durable Object)
├── Yjs Y.Doc with SQLite persistence + compaction
├── Hocuspocus WebSocket protocol (auth, sync, awareness)
├── Agent bridge HTTP routes (see table below)
└── DODocumentStorage (events, idempotency, access control)
```

## Route Parity with Express

The CF Worker implements the full agent bridge contract. Document lifecycle routes are also supported. Some Express-specific routes (collab management, legacy API paths) are not applicable to the DO architecture.

### Agent Bridge (full parity)

| Route | Method | Express | CF Worker |
|-------|--------|---------|-----------|
| `/api/agent/:slug/state` | GET | Y | Y |
| `/api/agent/:slug/snapshot` | GET | Y | Y |
| `/api/agent/:slug/edit` | POST | Y | Y |
| `/api/agent/:slug/edit/v2` | POST | Y | Y |
| `/api/agent/:slug/rewrite` | POST | Y | Y |
| `/api/agent/:slug/ops` | POST | Y | Y |
| `/api/agent/:slug/marks/comment` | POST | Y | Y |
| `/api/agent/:slug/marks/suggest-replace` | POST | Y | Y |
| `/api/agent/:slug/marks/suggest-insert` | POST | Y | Y |
| `/api/agent/:slug/marks/suggest-delete` | POST | Y | Y |
| `/api/agent/:slug/marks/accept` | POST | Y | Y |
| `/api/agent/:slug/marks/reject` | POST | Y | Y |
| `/api/agent/:slug/marks/reply` | POST | Y | Y |
| `/api/agent/:slug/marks/resolve` | POST | Y | Y |
| `/api/agent/:slug/marks/unresolve` | POST | Y | Y |
| `/api/agent/:slug/presence` | POST | Y | Y |
| `/api/agent/:slug/presence/disconnect` | POST | Y | Y |
| `/api/agent/:slug/events/pending` | GET | Y | Y |
| `/api/agent/:slug/events/ack` | POST | Y | Y |
| `/api/agent/:slug/repair` | POST | Y | Y |
| `/api/agent/:slug/clone-from-canonical` | POST | Y | Y |

### Document Routes

| Route | Method | Express | CF Worker | Notes |
|-------|--------|---------|-----------|-------|
| `POST /documents` | POST | Y | Y | |
| `POST /share/markdown` | POST | Y | Y | |
| `/documents/:slug/state` | GET | Y | Y | via DO |
| `/documents/:slug/snapshot` | GET | Y | Y | via DO |
| `/documents/:slug/content` | GET | Y | Y | via DO |
| `/documents/:slug/open-context` | GET | Y | Y | via DO |
| `/documents/:slug/collab-session` | GET | Y | Y | via DO |
| `/documents/:slug/collab-refresh` | POST | Y | Y | via DO |
| `/documents/:slug/events/pending` | GET | Y | Y | via DO |
| `/documents/:slug/events/ack` | POST | Y | Y | via DO |
| `/documents/:slug/pause` | POST | Y | Y | via DO |
| `/documents/:slug/resume` | POST | Y | Y | via DO |
| `/documents/:slug/revoke` | POST | Y | Y | via DO |
| `/documents/:slug/delete` | POST | Y | Y | via DO |
| `/documents/:slug/title` | PUT | Y | Y | via DO |

### Express-Only Routes (not in CF Worker)

| Route | Reason |
|-------|--------|
| `/api/capabilities` | Express middleware concern |
| `/d/:slug/bridge/*` | Neutral bridge mount — agents use `/api/agent/` or `/documents/` |
| `/api/documents` (legacy) | Legacy create route — use `POST /documents` |
| Collab management endpoints | DO handles collab internally; no external collab server to manage |

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entrypoint — routing, doc creation, SPA serving |
| `src/document-session.ts` | Durable Object — Yjs sync, agent routes, marks, edits |
| `src/document-engine.ts` | Marks CRUD (comment, suggest, accept/reject, reply, resolve) |
| `src/canonical-projection.ts` | Y.Doc <-> markdown via ProseMirror |
| `src/milkdown-headless.ts` | Headless Milkdown engine for Workers runtime |
| `src/storage-do.ts` | SQLite-backed events, idempotency, access control |
| `src/document-ops.ts` | Operation parsing and authorization for `ops` endpoint |
| `src/agent-edit-ops.ts` | Text-level edit operations (append, replace, insert) |
| `src/auth.ts` | Token resolution and role-based access |
| `src/idempotency.ts` | Mutation replay detection |
| `src/proof-span-strip.ts` | Proof span tag stripping for agent-facing markdown |

## See Also

- `docs/DEPLOYMENT.md` — full deployment guide (Express and Workers)
- `docs/adr/2026-03-cloudflare-workers-deployment.md` — decision record
- `AGENT_CONTRACT.md` — agent HTTP protocol
