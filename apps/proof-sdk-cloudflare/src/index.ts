import { DocumentSession } from "./document-session.js";

export { DocumentSession };

export interface Env {
  DOCUMENT_SESSION: DurableObjectNamespace<DocumentSession>;
  CATALOG_DB: D1Database;
  ASSETS: Fetcher;
}

const SLUG_LENGTH = 8;
const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  let slug = "";
  for (let i = 0; i < SLUG_LENGTH; i++) {
    slug += SLUG_CHARS[bytes[i] % SLUG_CHARS.length];
  }
  return slug;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Agent discovery
    if (path === "/.well-known/agent.json") {
      const base = url.origin;
      return Response.json({
        name: "Proof Editor",
        description: "Agent-native markdown editor with collaborative sharing and provenance tracking",
        api_base: `${base}/api`,
        capabilities: ["create_document", "share", "comment", "suggest", "rewrite", "collab", "provenance"],
        auth: {
          methods: ["api_key", "none"],
          api_key_header: "Authorization: Bearer <key>",
          no_auth_allowed: true,
          shared_link: {
            token_from_url: "?token=<token>",
            preferred_header: "x-share-token",
            alt_header: "x-bridge-token",
          },
        },
        quickstart: {
          received_link: {
            description: "Given a Proof share URL, read it in one step",
            method: "GET",
            url: "/api/agent/{slug}/state",
            headers: { "x-share-token": "{token}" },
            returns: "markdown + marks + _links",
          },
          create_and_share: {
            method: "POST",
            url: "/documents",
            body: { title: "My Document" },
            returns: "slug + url",
          },
        },
      }, {
        headers: { "cache-control": "public, max-age=300" },
      });
    }

    // Root → create a new document and redirect to /d/:slug
    if (path === "/") {
      const slug = generateSlug();
      const doId = env.DOCUMENT_SESSION.idFromName(slug).toString();
      await env.CATALOG_DB.prepare(
        "INSERT INTO documents (id, slug, title, do_id) VALUES (?, ?, ?, ?)",
      )
        .bind(doId, slug, "", doId)
        .run();
      return Response.redirect(new URL(`/d/${slug}?new=1`, url.origin).toString(), 302);
    }

    // Document editor — serve the SPA for /d/:slug
    const docPageMatch = path.match(/^\/d\/([^/]+)\/?$/);
    if (docPageMatch) {
      const slug = decodeURIComponent(docPageMatch[1]);
      // Fetch index.html via the static assets binding, then rewrite
      // relative paths to absolute so ./assets/editor.js doesn't resolve
      // to /d/assets/editor.js
      const assetResponse = await env.ASSETS.fetch(
        new Request(new URL("/index.html", url.origin)),
      );
      let html = await assetResponse.text();
      html = html.replaceAll('"./', '"/').replaceAll("'./", "'/");

      // When arriving from doc creation (?new=1), suppress the "shared with
      // you" welcome toast and name prompt — the user is the creator, not a
      // share recipient.
      const isNewDoc = url.searchParams.get("new") === "1";
      if (isNewDoc) {
        const suppressScript = `<script>try{sessionStorage.setItem("proof_share_welcome_${slug}","1")}catch(e){}</script>`;
        html = html.replace("</head>", `${suppressScript}</head>`);
      }

      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // POST /documents — API document creation
    if (path === "/documents" && request.method === "POST") {
      const slug = generateSlug();
      const doId = env.DOCUMENT_SESSION.idFromName(slug).toString();
      await env.CATALOG_DB.prepare(
        "INSERT INTO documents (id, slug, title, do_id) VALUES (?, ?, ?, ?)",
      )
        .bind(doId, slug, "", doId)
        .run();
      return new Response(
        JSON.stringify({ success: true, slug, url: `/d/${slug}` }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    // POST /share/markdown or /api/share/markdown — create doc from raw markdown
    if ((path === "/share/markdown" || path === "/api/share/markdown") && request.method === "POST") {
      const contentType = request.headers.get("content-type") ?? "";
      let markdown = "";
      let title = "";

      if (contentType.includes("application/json")) {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        markdown = typeof body.markdown === "string" ? body.markdown : "";
        title = typeof body.title === "string" ? body.title : "";
      } else {
        // text/plain or text/markdown — body IS the markdown
        markdown = await request.text();
      }

      if (!title) {
        // Extract title from first heading
        const headingMatch = markdown.match(/^#\s+(.+)$/m);
        title = headingMatch ? headingMatch[1].trim() : "Untitled";
      }

      const slug = generateSlug();
      const doId = env.DOCUMENT_SESSION.idFromName(slug).toString();
      await env.CATALOG_DB.prepare(
        "INSERT INTO documents (id, slug, title, do_id) VALUES (?, ?, ?, ?)",
      )
        .bind(doId, slug, title, doId)
        .run();

      // Write the markdown content to the DO
      if (markdown) {
        const id = env.DOCUMENT_SESSION.idFromName(slug);
        const stub = env.DOCUMENT_SESSION.get(id);
        await stub.fetch(new Request(
          new URL(`/api/agent/${slug}/rewrite`, url.origin),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: markdown, force: true }),
          },
        ));
      }

      const shareUrl = `${url.origin}/d/${slug}`;
      return Response.json(
        { success: true, slug, url: `/d/${slug}`, shareUrl, title },
        { status: 201 },
      );
    }

    if (path === "/api/metrics/collab-reconnect" && request.method === "POST") {
      return new Response(null, { status: 204 });
    }

    // Agent bridge routes — delegate to DO by slug
    // Matches /api/agent/:slug/* (state, edit, marks, events, etc.)
    const agentMatch = path.match(/^\/api\/agent\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      const slug = agentMatch[1];
      return routeToDocumentSession(request, env, slug);
    }

    // Document API routes — delegate to Durable Object by slug
    // Matches both /documents/:slug/... and /api/documents/:slug/...
    const documentMatch = path.match(/^(?:\/api)?\/documents\/([^/]+)(\/.*)?$/);
    if (documentMatch) {
      const slug = documentMatch[1];
      return routeToDocumentSession(request, env, slug);
    }

    // WebSocket upgrade — route to DO
    // Supports both /ws/:slug (path-based, used by HocuspocusProvider) and
    // /ws?slug=... (query-based, legacy)
    const wsMatch = path.match(/^\/ws\/([^/]+)\/?$/);
    if (wsMatch) {
      return routeToDocumentSession(request, env, decodeURIComponent(wsMatch[1]));
    }
    if (path === "/ws") {
      const slug = url.searchParams.get("slug");
      if (!slug) {
        return new Response("Missing slug parameter", { status: 400 });
      }
      return routeToDocumentSession(request, env, slug);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function routeToDocumentSession(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const id = env.DOCUMENT_SESSION.idFromName(slug);
  const stub = env.DOCUMENT_SESSION.get(id);
  return stub.fetch(request);
}

