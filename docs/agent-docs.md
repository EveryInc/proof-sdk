# Proof Agent Docs

## Proof SDK Route Alias

Hosted Proof keeps the `/api/agent/*` and `/share/markdown` compatibility routes.

The reusable `Proof SDK` surface is mounted in parallel at:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

## Which Editing Method Should I Use?

Proof has three editing approaches. **Pick one — don't mix them.**

| Goal | Method | Endpoint |
|------|--------|----------|
| **Add/replace/insert a few lines** (recommended) | Edit V2 (block-level) | `GET /snapshot` → `POST /edit/v2` |
| **Simple text replacement** | Structured edit | `POST /edit` |
| **Replace entire document** | Rewrite | `POST /ops` with `rewrite.apply` |
| **Add a comment** | Ops | `POST /ops` with `comment.add` |

**Start with Edit V2** for most tasks. It uses stable block refs, handles concurrent edits cleanly, and returns clean markdown without internal HTML annotations.

`suggestion.add` now matches against annotated documents correctly and preserves stable anchors, but `edit/v2` is still the better default for programmatic content changes.

`rewrite.apply` is still disruptive. Avoid it if anyone might have the document open: hosted environments block rewrites while live authenticated collaborators are connected, and `force` is ignored there.

## I Just Received A Proof Link

No browser automation is required. Use HTTP directly (for example, `curl` or your tool's `web_fetch`).

If you received a shared link like:

  http://localhost:4000/d/<slug>?token=<token>

You can discover the API and read the document in one step using **content negotiation** on that same URL.

Fetch JSON (recommended):

  curl -H "Accept: application/json" "http://localhost:4000/d/<slug>?token=<token>"

Fetch raw markdown:

  curl -H "Accept: text/markdown" "http://localhost:4000/d/<slug>?token=<token>"

The JSON response includes:
- `markdown` (document content)
- `_links` (state, ops, docs)
- `agent.auth` hints (how to use the token)

### Quick copy/paste flow (token already in the shared URL)

```bash
SHARE_URL='http://localhost:4000/d/<slug>?token=<token>'
TOKEN='<token>'
SLUG='<slug>'

curl -H "Accept: application/json" "$SHARE_URL"
curl -H "Accept: text/markdown" "$SHARE_URL"
curl -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: your-agent" "http://localhost:4000/documents/$SLUG/state"
```

## Auth: Token From URL

If a URL contains `?token=`, treat it as an access token:

- Preferred: `Authorization: Bearer <token>`
- Also accepted: `x-share-token: <token>`

## Cloud Run Behind IAP

If you place Proof SDK behind Cloud Run + Identity-Aware Proxy, agents must satisfy the IAP layer **before** they can use Proof share tokens.

Recommended configuration:

```bash
PROOF_TRUST_PROXY_HEADERS=true
PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS=x-goog-authenticated-user-email
PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS=elastic.co
PROOF_SHARE_MARKDOWN_AUTH_MODE=oauth
```

What this does:

- IAP authenticates the caller and injects `x-goog-authenticated-user-email`.
- Proof SDK trusts that header only when `PROOF_TRUST_PROXY_HEADERS=true` and the email matches `PROOF_TRUSTED_IDENTITY_EMAILS` or `PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS`.
- `POST /api/share/markdown` and other hosted-auth checks can use that trusted identity without a separate Proof OAuth session.
- When a direct share is created this way, the document owner defaults to the trusted email unless you explicitly pass `ownerId`.

Example request from an agent that already has IAP access:

```bash
curl -X POST "https://your-proof.example.com/api/share/markdown" \
  -H "Content-Type: application/json" \
  -H "X-Goog-Authenticated-User-Email: accounts.google.com:agent@elastic.co" \
  -d '{"markdown":"# Hello from IAP"}'
```

After the request passes IAP, the returned Proof share token works the same as any other deployment:

```bash
curl -H "Authorization: Bearer <access-token>" \
  "https://your-proof.example.com/documents/<slug>/state"
```

Notes:

- This is intended for trusted reverse proxies such as IAP. Do **not** enable it on a public origin without a proxy that strips/spoofs those headers.
- External agents that cannot authenticate to IAP will still be blocked at the IAP layer. In that case, either give the agent an allowed IAP identity/service account or expose a separate non-IAP agent ingress.

## Edit Via Ops (Comments, Suggestions, Rewrite)

Use:

  POST /documents/<slug>/ops

`by` controls authorship. Presence is explicit-only: send `X-Agent-Id: <your-agent-id>` (or `agentId` in the JSON body) when you want the agent to appear in presence.

Add a comment:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"comment.add","by":"ai:your-agent","quote":"text to anchor","text":"comment body"}'

Suggest a replace:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"suggestion.add","by":"ai:your-agent","kind":"replace","quote":"old text","content":"new text"}'

Create and immediately apply a suggestion:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"suggestion.add","by":"ai:your-agent","kind":"replace","quote":"old text","content":"new text","status":"accepted"}'

Rewrite the whole document:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"rewrite.apply","by":"ai:your-agent","content":"# New markdown..."}'

## Edit Via Structured Operations (Append, Replace, Insert)

For surgical edits without rewriting the entire document, use the `/edit` endpoint:

  POST /documents/<slug>/edit

All requests require `Content-Type: application/json` and auth via `Authorization: Bearer <token>`.

The body must include an `operations` array (max 50 ops) and a `by` field for authorship. If you want presence, also send `X-Agent-Id: <your-agent-id>` or `agentId` in the body.

### Append to a section

Add content at the end of a named section (matched by heading text):

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "append", "section": "Brandon", "content": "\n\n**Feb 16, 2026**\n\nNew brainstorm idea here."}
      ]
    }'

The `section` value is matched against heading text (e.g., `"Brandon"` matches `### Brandon`).

### Replace text

Find and replace a specific string in the document:

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "replace", "search": "old text to find", "content": "new replacement text"}
      ]
    }'

### Insert after text

Insert content after a specific anchor string:

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "insert", "after": "anchor text to find", "content": "\n\nContent to insert after the anchor."}
      ]
    }'

`insert` only supports `after`. Payloads using `before` are rejected with `INVALID_OPERATIONS`.

### Multiple operations

You can combine operations in a single request (applied in order):

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "append", "section": "Dan", "content": "\n\nNew idea from Dan."},
        {"op": "replace", "search": "(placeholder)", "content": "Actual content here."}
      ]
    }'

### Response

A successful response includes:

  {
    "success": true,
    "slug": "<slug>",
    "updatedAt": "<ISO timestamp>",
    "collabApplied": true
  }

- `collabApplied: true` means the edit was pushed into the live collab session (connected viewers see it in real time).
- `presenceApplied` is only `true` when you also supplied explicit agent identity via `X-Agent-Id`, `agentId`, or `agent.id`.
- If the document changed since you last read it, you may get a `409 STALE_BASE` error — re-fetch state and retry.

Collab convergence fields:
- `collab.status` is render-authoritative (`confirmed` when the ProseMirror/Yjs fragment converged).
- `collab.fragmentStatus` tracks fragment convergence (`confirmed|pending`).
- `collab.markdownStatus` tracks SQL markdown projection convergence (`confirmed|pending`).
- `collabApplied` follows `fragmentStatus` (not markdown projection status).

### Optimistic locking (required for `/edit`)

Pass `baseUpdatedAt` (from a prior state response) to detect concurrent edits:

  {"by": "ai:your-agent", "baseUpdatedAt": "2026-02-16T...", "operations": [...]}

If the document's `updatedAt` doesn't match, you'll get a `409` with `retryWithState` pointing to the state endpoint.

## Update Title Metadata

Use:

  PUT /documents/<slug>/title

Example:

  curl -X PUT "http://localhost:4000/documents/<slug>/title" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -d '{"title":"Updated document title"}'

Discovery:
- `GET /documents/<slug>/state` includes `_links.title` and `agent.titleApi`.

## Edit V2 (Block IDs + Revision Locking)

Use v2 for top-level block edits with stable block IDs and revision-based optimistic locking.

### Get a snapshot

  GET /documents/<slug>/snapshot

Example:

  curl -H "Authorization: Bearer <token>" "http://localhost:4000/documents/<slug>/snapshot"

The response includes `revision` and an ordered `blocks` array with deterministic refs (`b1`, `b2`, ...).

### Apply edits

  POST /documents/<slug>/edit/v2

Example:

  curl -X POST "http://localhost:4000/documents/<slug>/edit/v2" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: <uuid>" \
    -d '{
      "by": "ai:your-agent",
      "baseRevision": 128,
      "operations": [
        { "op": "replace_block", "ref": "b3", "block": { "markdown": "Updated paragraph." } },
        { "op": "insert_after", "ref": "b3", "blocks": [{ "markdown": "## New Section" }] }
      ]
    }'

On success, the response includes the new `revision`, a `snapshot` payload, and a `collab` status.
If your `baseRevision` is stale, you'll receive `STALE_REVISION` plus the latest snapshot for retry.

v2 convergence fields:
- `collab.status` remains compatibility status (`confirmed|pending`) and is fragment-authoritative.
- `collab.fragmentStatus` and `collab.markdownStatus` expose render-vs-projection split directly.
- `202` is only expected when fragment convergence is pending.

Precondition contract for v2:
- `baseRevision` is required.
- `baseUpdatedAt` is not accepted on `/edit/v2`.

Idempotency guidance:
- Send `Idempotency-Key` for mutation requests (`X-Idempotency-Key` is also accepted for compatibility).
- `/edit/v2` examples include this header because block-level retries are common in automation.

Mutation contract discovery:
- Read `contract.mutationStage` from `GET /documents/<slug>/state` to detect Stage A/B/C rollout.
- `contract.idempotencyRequired` and `contract.preconditionMode` summarize current requirements.

Common mutation contract error codes:
- `IDEMPOTENCY_KEY_REQUIRED`: mutation request omitted idempotency key in required stage.
- `IDEMPOTENCY_KEY_REUSED`: same key reused with a different payload hash.
- `BASE_REVISION_REQUIRED`: stage requires `baseRevision` and request did not provide it.
- `LIVE_CLIENTS_PRESENT`: rewrite blocked because active authenticated collab clients are connected.
  Use `retryWithState` to refresh state, confirm `connectedClients === 0`, and if `forceIgnored=true` do not retry with `force` in hosted environments.
  This response is retryable and includes `reason` + `nextSteps`.
- `REWRITE_BARRIER_FAILED`: rewrite safety barrier failed before mutation; no rewrite was applied.
  This response is retryable and includes `reason` + `nextSteps`; retry with bounded exponential backoff and jitter.

## Presence And Event Polling

Poll for changes:

  GET /documents/<slug>/events/pending?after=<cursor>&limit=100

Ack processed events (editor/owner):

  POST /documents/<slug>/events/ack
  Body: {"upToId": <cursor>, "by": "ai:your-agent"}

## Archived Desktop Workflow

This repo is web-first. Desktop-native workflows are outside the public SDK scope and should be treated as separate implementation work.

## Projection Guardrails And QA

Operational metrics:
- `projection_guard_block_total{reason,source}`
- `projection_drift_total{reason,source}`
- `projection_repair_total{result,reason}`
- `projection_chars_bucket{source,le}`

Staging soak (live browser viewers + repeated `/edit` + `/edit/v2`):

  SHARE_BASE_URL=https://proof-web-staging.up.railway.app \
  SOAK_DURATION_MS=300000 \
  npx tsx scripts/staging-collab-projection-soak.ts

## Create A New Shared Doc

If you need to create a share from scratch, use:

  POST /documents

This is the canonical public create route.
Hosted Proof still accepts `POST /share/markdown` as a compatibility alias.
Legacy create routes like `/api/documents` are internal/legacy and may be warned or disabled on hosted environments.

## Recommended Workflow: Adding Content To An Existing Doc

This is the most reliable way to add a line, row, or section to an existing document:

### Step 1: Get the snapshot

  curl -H "Authorization: Bearer <token>" "http://localhost:4000/documents/<slug>/snapshot"

This returns clean markdown per block (no internal HTML tags) plus stable `ref` identifiers and a `revision` number.
### Step 2: Find the right block

Look through the `blocks` array for the block you want to edit or insert near. Each block has:
- `ref`: stable identifier (e.g., `b3`)
- `markdown`: the clean markdown content of that block
- `type`: block type (e.g., `paragraph`, `heading`, `table`)

### Step 3: Apply your edit

  curl -X POST "http://localhost:4000/documents/<slug>/edit/v2" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: <uuid>" \
    -d '{
      "by": "ai:your-agent",
      "baseRevision": 128,
      "operations": [
        { "op": "insert_after", "ref": "b3", "blocks": [{ "markdown": "New content here." }] }
      ]
    }'

### Step 4: Handle conflicts

If you get `STALE_REVISION`, the response includes the latest snapshot — re-read the blocks and retry.

## Troubleshooting

### `ANCHOR_NOT_FOUND` on `/edit` replace or insert

The `/edit` endpoint searches for your `search` or `after` text in the document. If the document was previously edited by agents, it may contain internal `<span data-proof="authored">` HTML tags. The search now automatically falls back to matching against clean text (with tags stripped), so this should be rare. If it still fails, the text genuinely doesn't exist in the document — re-read state and verify.

### `LIVE_CLIENTS_PRESENT` on `rewrite.apply`

`rewrite.apply` is blocked when authenticated collaborators are connected. Outside hosted environments you can pass `"force": true`, but on hosted environments `force` is ignored. If you still prefer the safer path:
1. Use `/edit` or `/edit/v2` instead (they work with live clients).
2. Wait for clients to disconnect (poll `/state` and check `connectedClients`).

### Suggestion anchors not matching

`suggestion.add` now resolves quotes against clean text even when the stored markdown contains internal `<span data-proof="authored">` annotations. If you still get `ANCHOR_NOT_FOUND`, re-read state and verify the quote text genuinely exists.

### Document content looks corrupted after suggestion reject cycles

Repeated suggest/reject cycles on annotated documents now preserve stable suggestion anchors so the document text should remain unchanged. If you still see unexpected content drift, re-read `Accept: text/markdown` and report the exact request/response pair.

### `COLLAB_SYNC_FAILED` errors

Edits via the API can fail when a browser has the document open with an active Yjs collab session. The `/edit` and `/edit/v2` endpoints handle this gracefully, but `rewrite.apply` does not. If you hit this, retry after a short delay or use `/edit`/`/edit/v2` instead.
