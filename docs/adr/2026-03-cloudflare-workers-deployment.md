# ADR: Cloudflare Workers Deployment Target

## Status

Proposed

## Decision

We are adding a Cloudflare Workers deployment target under `apps/proof-cloudflare/`. It runs the same editor frontend and agent bridge as the Express server, but on Cloudflare's edge runtime using Durable Objects for per-document state.

The architecture maps Proof SDK concepts to Cloudflare primitives:

| Proof SDK concept | Express server | Cloudflare Workers |
|---|---|---|
| Document catalog | SQLite table | D1 database |
| Document state + collab | Shared SQLite + Hocuspocus | Durable Object with embedded SQLite |
| WebSocket collab | Hocuspocus on separate port | Native DO WebSocket |
| Static assets | `express.static` / Vite dev server | Workers Assets |
| Agent bridge routes | Express middleware | Worker fetch handler → DO delegation |

Each document gets its own Durable Object instance. The Worker's fetch handler routes requests to the correct DO by slug, using D1 as the slug-to-DO-ID catalog. This gives per-document isolation: a crash or timeout in one document does not affect others.

The Worker reuses the shared `dist/` bundle built by `npm run build` — no separate frontend build is needed.

## Consequences

- The Express server remains the reference deployment and the default for local development. The Worker is an alternative, not a replacement.
- Agent bridge routes must be implemented independently in the Worker since they cannot import Express middleware directly. The route surface is kept in sync manually.
- Durable Object SQLite is local to each DO instance, not queryable across documents. Cross-document queries (e.g., listing all documents) go through D1.
- Workers Paid plan ($5/mo) is required for Durable Objects. This is a hosting cost, not a SDK licensing concern.
- The `apps/` directory establishes a pattern for additional deployment targets (e.g., Docker, serverless) without modifying the core SDK.
