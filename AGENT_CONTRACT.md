# Agent Contract: Direct Markdown Sharing

This contract defines the public Proof SDK flow for creating and operating on shared documents over HTTP. The routes and semantics apply to all deployment targets (Express server, Cloudflare Workers, etc.) — replace `localhost:4000` with your deployment URL.

## Endpoints

Canonical route:

`POST /documents`

Compatibility alias:

`POST /share/markdown`

Legacy internal route:

`POST /api/documents`

## Request Formats

### JSON

```http
POST /documents HTTP/1.1
Content-Type: application/json
Authorization: Bearer <apiKey>   # when API-key auth is enabled
```

```json
{
  "markdown": "# Plan\n\nShip the rewrite.",
  "title": "Rewrite Plan",
  "role": "commenter",
  "ownerId": "agent:claude"
}
```

### Raw markdown

```http
POST /documents?title=Rewrite%20Plan&role=commenter HTTP/1.1
Content-Type: text/markdown
Authorization: Bearer <apiKey>   # when API-key auth is enabled
```

````markdown
# Plan

Ship the rewrite.
````

## Response

```json
{
  "success": true,
  "slug": "abc123xy",
  "docId": "b9d9f8e8-5a4e-4af8-a9d4-5e0ecf7ff4ab",
  "url": "/d/abc123xy",
  "shareUrl": "https://your-proof.example/d/abc123xy",
  "tokenPath": "/d/abc123xy?token=...",
  "tokenUrl": "https://your-proof.example/d/abc123xy?token=...",
  "ownerSecret": "8b5f...owner secret...",
  "accessToken": "4d53...link token...",
  "accessRole": "commenter",
  "active": true,
  "shareState": "ACTIVE",
  "snapshotUrl": "https://your-proof.example/snapshots/abc123xy.html",
  "createdAt": "2026-02-12T16:10:00.000Z",
  "_links": {
    "view": "/d/abc123xy",
    "state": "/documents/abc123xy/state",
    "ops": { "method": "POST", "href": "/documents/abc123xy/ops" },
    "events": "/documents/abc123xy/events/pending?after=0",
    "docs": "/agent-docs"
  }
}
```

## Token Semantics

- `ownerSecret`
  - Full-owner credential for that document
  - Can pause, resume, revoke, delete, and perform owner-level agent actions
  - Store securely and do not expose in user-facing UI
- `accessToken`
  - Scoped link credential for `viewer`, `commenter`, or `editor`
  - Use this token for non-owner operations where possible
  - If you need a tokenized share URL, use `tokenUrl`

## Authentication Model

`PROOF_SHARE_MARKDOWN_AUTH_MODE` controls direct-share auth:

- `none`: open route, good for local/dev
- `api_key`: require `PROOF_SHARE_MARKDOWN_API_KEY`
- `auto`: resolve to `none` by default in Proof SDK

`/api/documents` is governed separately by `PROOF_LEGACY_CREATE_MODE`:

- `allow`
- `warn`
- `disabled`
- `auto`

## Minimal Agent Flow

1. `POST /documents`
2. Persist `ownerSecret` securely
3. Return `shareUrl` to the user
4. Use `accessToken` or `ownerSecret` for follow-up operations

## Read + Operate Contract

### Read state

- `GET /documents/:slug/state`
- `GET /api/documents/:slug/open-context`
- `GET /api/documents/:slug/collab-session`
- `GET /api/documents/:slug/info`

### Mutation endpoint

Use `POST /documents/:slug/ops` with:

- `type: "comment.add"`
- `type: "comment.reply"`
- `type: "comment.resolve"`
- `type: "suggestion.add"`
- `type: "suggestion.accept"`
- `type: "suggestion.reject"`
- `type: "rewrite.apply"`

Send `Idempotency-Key` on mutation requests so retries stay safe.

### Event polling

- Poll: `GET /documents/:slug/events/pending?after=<id>&limit=<n>`
- Ack: `POST /documents/:slug/events/ack`

## Collab Session Lifecycle

1. Resolve open context and capabilities
2. Join collab with `session.collabWsUrl` and `session.token`
3. Refresh with `POST /api/documents/:slug/collab-refresh` before token expiry
4. Reconnect using the refreshed token

## CLI Example

```bash
curl -X POST http://localhost:4000/documents \
  -H "Content-Type: application/json" \
  -d '{"markdown":"# Plan\n\nShip the rewrite.","title":"Rewrite Plan","role":"commenter"}'
```

See `docs/DEPLOYMENT.md` for deployment options and configuration.
