import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  noteDocumentLiveCollabLease,
  canMutateByOwnerIdentity,
  resolveDocumentAccessRole,
  upsertActiveCollabConnection,
} from './db.js';
import type { ShareRole } from './share-types.js';
import { recordShareLinkOpen } from './metrics.js';
import { getCookie, shareTokenCookieName } from './cookies.js';
import { handleShareMarkdown, shareMarkdownBodyParser } from './routes.js';
import { getSnapshotHtml, getSnapshotPublicUrl } from './snapshot.js';
import { stripProofSpanTags } from './proof-span-strip.js';
import {
  getCanonicalReadableDocumentSync,
  isCanonicalReadMutationReady,
  noteRecentCollabSessionLease,
} from './collab.js';
import {
  AGENT_DOCS_PATH,
  ALT_SHARE_TOKEN_HEADER_FORMAT,
  AUTH_HEADER_FORMAT,
  TOKEN_FROM_URL_HINT,
  TOKEN_MISSING_HINT,
} from './agent-guidance.js';
import {
  buildSharePreviewModel,
  renderShareMetaTags,
  renderShareOgPng,
  resolvePublicOrigin,
  type SharePreviewModel,
} from './share-preview.js';
import {
  buildProofSdkAgentDescriptor,
  buildProofSdkDocumentPaths,
  buildProofSdkLinks,
} from './proof-sdk-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const shareWebRoutes = Router();

// Headerless alias for agents: create a shared web doc without client-compat headers.
shareWebRoutes.post('/share/markdown', shareMarkdownBodyParser, handleShareMarkdown);

function isFeatureEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isLinkUnfurlBot(ua: string): boolean {
  return ua.includes('slackbot-linkexpanding')
    || ua.includes('discordbot')
    || ua.includes('twitterbot')
    || ua.includes('facebookexternalhit')
    || ua.includes('linkedinbot')
    || ua.includes('skypeuripreview')
    || ua.includes('telegrambot')
    || ua.includes('whatsapp');
}

function wantsJson(req: Request): boolean {
  if (req.query.format === 'html') return false;
  if (req.query.format === 'json' || req.query.format === 'agent') return true;
  const accept = (req.header('accept') || '').toLowerCase();
  if (accept.includes('text/markdown') || accept.includes('text/x-markdown')) return false;
  if (accept.includes('text/html')) return false;
  if (accept.includes('application/json')) return true;

  // If an AI or CLI tool simply "opens the link", it likely won't send browser Accept/UA headers.
  // Default those non-browser clients to the agent-friendly JSON manifest, but force known
  // link-expander bots onto the HTML/meta path so social unfurls can see the OG tags.
  const ua = (req.header('user-agent') || '').toLowerCase();
  if (!ua) return true;
  if (isLinkUnfurlBot(ua)) return false;
  const looksLikeBrowser = ua.includes('mozilla')
    || ua.includes('chrome')
    || ua.includes('safari')
    || ua.includes('firefox')
    || ua.includes('edg')
    || ua.includes('opr');
  return !looksLikeBrowser;
}

function wantsMarkdown(req: Request): boolean {
  const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : '';
  if (format === 'markdown' || format === 'md') return true;
  const accept = (req.header('accept') || '').toLowerCase();
  return accept.includes('text/markdown') || accept.includes('text/x-markdown');
}

function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = (req.header('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase();
  return proto === 'https';
}

function getPublicOrigin(req: Request): string {
  const configured = process.env.PROOF_PUBLIC_ORIGIN?.trim();
  if (configured) return resolvePublicOrigin(configured);
  const host = req.get('host') || '';
  if (!host) return resolvePublicOrigin(null);
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

function deriveShareCapabilities(role: ShareRole, shareState: string): { canRead: boolean; canComment: boolean; canEdit: boolean } {
  const isOwner = role === 'owner_bot';
  // Product decision: non-owners cannot access paused/revoked shares at all.
  const canRead = shareState === 'ACTIVE' || (isOwner && shareState !== 'DELETED');
  const canEdit = isOwner
    ? (shareState === 'ACTIVE' || shareState === 'PAUSED')
    : (role === 'editor' && shareState === 'ACTIVE');
  const canComment = shareState === 'ACTIVE' && (role === 'commenter' || role === 'editor' || isOwner);
  return { canRead, canComment, canEdit };
}

// SPA fallback: serve index.html for /d/:slug routes
// Rewrite relative asset paths to absolute so they work from /d/ subpath
let shareHtml: string | null = null;
const distPath = path.resolve(__dirname, '..', 'dist');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeCommentUiMode(value: string | undefined): 'legacy' | 'v2' | 'auto' | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'v2' || normalized === 'auto') return normalized;
  return null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isForcedLiveViewerRequest(req: Request): boolean {
  const view = typeof req.query.view === 'string' ? req.query.view.trim().toLowerCase() : '';
  const live = typeof req.query.live === 'string' ? req.query.live.trim().toLowerCase() : '';
  const liveHeader = (req.header('x-proof-live-viewer') || '').trim().toLowerCase();
  return view === 'live' || live === '1' || live === 'true' || liveHeader === '1' || liveHeader === 'true';
}

function buildLiveViewerLeaseConnectionId(
  slug: string,
  token: string,
  role: ShareRole,
  accessEpoch: number,
): string {
  const digest = createHash('sha256')
    .update(`${slug}:${role}:${accessEpoch}:${token}`)
    .digest('hex')
    .slice(0, 24);
  return `share-live:${slug}:${accessEpoch}:${role}:${digest}`;
}

function buildShareRuntimeConfigScript(slug: string, shareToken?: string | null): string {
  const commentUiDefaultMode = normalizeCommentUiMode(process.env.PROOF_COMMENT_UI_DEFAULT_MODE);
  const configLines = [
    shareToken ? `window.__PROOF_CONFIG__.shareSlug = ${JSON.stringify(slug)};` : '',
    shareToken ? `window.__PROOF_CONFIG__.shareToken = ${JSON.stringify(shareToken)};` : '',
    commentUiDefaultMode ? `window.__PROOF_CONFIG__.commentUiDefaultMode = ${JSON.stringify(commentUiDefaultMode)};` : '',
  ].filter(Boolean);
  if (configLines.length === 0) return '';
  return `<script>
window.__PROOF_CONFIG__ = window.__PROOF_CONFIG__ || {};
${configLines.join('\n')}
</script>`;
}

function injectShareHtmlDiscoveryTags(
  htmlTemplate: string,
  slug: string,
  markdown: string,
  preview: SharePreviewModel,
  shareToken?: string | null,
): string {
  const proofSdkPaths = buildProofSdkDocumentPaths(slug);
  const agentApi = proofSdkPaths.state;
  const editApi = proofSdkPaths.edit;
  const opsApi = proofSdkPaths.ops;
  const fullMetaTags = renderShareMetaTags(preview);
  const pageTitle = fullMetaTags.match(/<title>[\s\S]*?<\/title>/i)?.[0]
    ?? `<title>${escapeHtml(`${preview.title} | Proof`)}</title>`;
  const metaTags = [
    fullMetaTags.replace(/<title>[\s\S]*?<\/title>\n?/i, ''),
    `<meta name="agent-api" content="${escapeHtml(agentApi)}">`,
    '<meta name="agent-docs" content="/agent-docs">',
  ].join('\n');
  const configScript = buildShareRuntimeConfigScript(slug, shareToken);

  const instructionMarkup = `<h2>Proof Shared Document</h2>
  <p>This is a collaborative document on Proof. To read or edit it programmatically:</p>
  <ul>
    <li>Fetch this URL with <code>Accept: application/json</code> to get content + API links.</li>
    <li>Fetch this URL with <code>Accept: text/markdown</code> to get raw markdown.</li>
    <li>Edit endpoint: <code>POST ${escapeHtml(editApi)}</code></li>
    <li>Ops endpoint: <code>POST ${escapeHtml(opsApi)}</code></li>
    <li>Full API docs: <a href="/agent-docs">/agent-docs</a></li>
    <li>No browser automation needed — use plain HTTP requests (curl/web_fetch).</li>
  </ul>
  <p>Auth: If this URL includes <code>?token=</code>, send it as <code>${escapeHtml(AUTH_HEADER_FORMAT)}</code>.</p>`;

  // Readability extraction differs across agents:
  // - some include <noscript>
  // - some strip display:none
  // - some include clipped (screen-reader-only) content
  // Keep instructions in both places and include markdown in the clipped block.
  const noscript = `<noscript>\n${instructionMarkup}\n  <h3>Document Content</h3>\n  <pre>${escapeHtml(markdown)}</pre>\n</noscript>`;

  const agentDiv = `<div id="agent-instructions" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:pre-wrap;" aria-hidden="true">
  <h3>Document Content</h3>
  <pre>${escapeHtml(markdown)}</pre>
  <h2>Proof Shared Document</h2>
  ${instructionMarkup}
</div>`;

  let out = htmlTemplate;
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, pageTitle);
  } else if (out.includes('</head>')) {
    out = out.replace('</head>', `${pageTitle}\n</head>`);
  }
  if (out.includes('</head>')) {
    out = out.replace('</head>', `${metaTags}\n${configScript}\n</head>`);
  }
  out = out.replace(/<body\b[^>]*>/i, (match) => `${match}\n${noscript}\n${agentDiv}`);
  return out;
}

/**
 * Detect non-browser user-agents that explicitly request text/html.
 * These are typically agent web_fetch tools (e.g., OpenClaw, ChatGPT browsing)
 * that use readability extractors. They send Accept: text/html but aren't real browsers.
 */
function isAgentHtmlFetch(req: Request): boolean {
  const ua = (req.header('user-agent') || '').toLowerCase();
  if (!ua) return false;
  const looksLikeBrowser = ua.includes('mozilla')
    || ua.includes('chrome')
    || ua.includes('safari')
    || ua.includes('firefox')
    || ua.includes('edg')
    || ua.includes('opr');
  if (looksLikeBrowser) return false;
  // Non-browser UA requesting HTML — likely an agent tool
  const accept = (req.header('accept') || '').toLowerCase();
  return accept.includes('text/html') || accept.includes('*/*');
}

function renderAgentFriendlyHtml(
  origin: string,
  slug: string,
  markdown: string,
  token: string | null,
  preview: SharePreviewModel,
  mutationReady: boolean,
): string {
  const docUrl = `${origin}/d/${encodeURIComponent(slug)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const proofSdkPaths = buildProofSdkDocumentPaths(slug, origin);
  const stateUrl = proofSdkPaths.state;
  const editUrl = proofSdkPaths.edit;
  const opsUrl = proofSdkPaths.ops;
  const authHeader = token
    ? `Authorization: Bearer ${escapeHtml(token)}`
    : AUTH_HEADER_FORMAT;
  const authNote = token
    ? `<p><strong>Auth:</strong> Use the token from the URL as <code>Authorization: Bearer ${escapeHtml(token)}</code></p>`
    : '<p><strong>Auth:</strong> No token detected. Ask for a tokenized link for API access.</p>';
  const writeGuidance = mutationReady
    ? `
    <li><strong>Edit (append/replace/insert):</strong> <code>curl -X POST "${escapeHtml(editUrl)}" -H "Content-Type: application/json" -H "${authHeader}" -d '{"by":"ai:assistant","operations":[{"op":"append","section":"Notes","content":"\\n\\nNew bullet."}]}'</code></li>
    <li><strong>Ops (comment/suggest/rewrite):</strong> <code>curl -X POST "${escapeHtml(opsUrl)}" -H "Content-Type: application/json" -H "${authHeader}" -d '{"type":"comment.add","by":"ai:assistant","quote":"text to anchor","text":"comment body"}'</code></li>
`
    : `
    <li><strong>Writes temporarily unavailable:</strong> canonical reads are serving a Yjs fallback while projection repair catches up. Retry edits after the projection is healthy again.</li>
`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  ${renderShareMetaTags(preview)}
  <meta name="agent-api" content="/documents/${escapeHtml(slug)}/state">
  <meta name="agent-docs" content="/agent-docs">
  ${buildShareRuntimeConfigScript(slug, token)}
</head>
<body>
  <h1>Proof Shared Document</h1>
  <p>This is a collaborative document in Proof.</p>

  <h2>Document Content</h2>
  <pre>${escapeHtml(markdown)}</pre>

  <h2>API Quick Start</h2>
  <p><strong>No browser automation needed.</strong> Use plain HTTP requests (curl/web_fetch) against this same URL and API endpoints.</p>
  <ul>
    <li><strong>Read as JSON:</strong> <code>curl -H "Accept: application/json" "${escapeHtml(docUrl)}"</code></li>
    <li><strong>Read as markdown:</strong> <code>curl -H "Accept: text/markdown" "${escapeHtml(docUrl)}"</code></li>
    <li><strong>Read state:</strong> <code>curl -H "${authHeader}" "${escapeHtml(stateUrl)}"</code></li>
    ${writeGuidance}
    <li><strong>Full docs:</strong> <a href="${AGENT_DOCS_PATH}">${AGENT_DOCS_PATH}</a></li>
  </ul>
  ${authNote}

  <noscript>
    <h3>Agent Fallback</h3>
    <p>Use <code>Accept: application/json</code> on this URL or call <code>${escapeHtml(stateUrl)}</code>.</p>
    <pre>${escapeHtml(markdown)}</pre>
  </noscript>
</body>
</html>`;
}

function renderUnavailableHtml(preview: SharePreviewModel, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderShareMetaTags(preview)}
  <style>
    body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0f172a; color:#e2e8f0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { width:min(640px, 100%); background:rgba(15, 23, 42, 0.92); border:1px solid #334155; border-radius:24px; padding:32px; box-shadow:0 20px 50px rgba(15, 23, 42, 0.45); }
    .label { display:inline-flex; padding:8px 12px; border-radius:999px; border:1px solid #475569; color:#cbd5e1; font-size:13px; margin-bottom:16px; }
    h1 { margin:0 0 12px; font-size:30px; line-height:1.1; color:#f8fafc; }
    p { margin:0; font-size:16px; line-height:1.5; color:#cbd5e1; }
  </style>
</head>
<body>
  <div class="card">
    <div class="label">${escapeHtml(preview.statusLabel)}</div>
    <h1>${escapeHtml(preview.title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

shareWebRoutes.get('/og/share/:slug.png', async (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? (req.params.slug[0] ?? '') : (req.params.slug ?? '');
  const doc = slug ? (getCanonicalReadableDocumentSync(slug, 'share') ?? null) : null;
  const preview = buildSharePreviewModel({
    slug,
    origin: getPublicOrigin(req),
    doc: doc ? {
      title: doc.title,
      markdown: doc.markdown,
      updatedAt: doc.updated_at,
      shareState: doc.share_state,
      revision: doc.revision,
    } : null,
    shareState: doc?.share_state ?? 'MISSING',
  });
  const png = await renderShareOgPng(preview);
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.type('png').send(png);
});

shareWebRoutes.get('/d/:slug', (req: Request, res: Response) => {
  const slug = Array.isArray(req.params.slug) ? (req.params.slug[0] ?? '') : (req.params.slug ?? '');
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const origin = getPublicOrigin(req);

  const doc = slug ? (getCanonicalReadableDocumentSync(slug, 'share') ?? null) : null;
  const tokenFromCookie = slug ? getCookie(req, shareTokenCookieName(slug)) : null;
  const roleFromQuery = slug && tokenFromQuery ? resolveDocumentAccessRole(slug, tokenFromQuery) : null;
  const queryOwner = Boolean(doc && tokenFromQuery && canMutateByOwnerIdentity(doc, tokenFromQuery));
  const roleFromCookie = slug && tokenFromCookie ? resolveDocumentAccessRole(slug, tokenFromCookie) : null;
  const cookieOwner = Boolean(doc && tokenFromCookie && canMutateByOwnerIdentity(doc, tokenFromCookie));

  // Prefer URL token over cookie when it is valid, but allow a valid cookie to win if the query token is stale.
  let token: string | null = null;
  let roleFromToken: ShareRole | null = null;
  let tokenSource: 'query:token' | 'cookie' | 'none' = 'none';
  if (tokenFromQuery && (roleFromQuery || queryOwner)) {
    token = tokenFromQuery;
    roleFromToken = roleFromQuery;
    tokenSource = 'query:token';
  } else if (tokenFromCookie && (roleFromCookie || cookieOwner)) {
    token = tokenFromCookie;
    roleFromToken = roleFromCookie;
    tokenSource = 'cookie';
  }

  // If the share is PAUSED/REVOKED, only the owner can access the live web UI.
  // Everyone else should see a generic unavailable page (no snapshot content).
  const ownerOverride = Boolean(doc
    && doc.share_state !== 'DELETED'
    && (roleFromToken === 'owner_bot' || canMutateByOwnerIdentity(doc, token ?? '')));

  if (doc && doc.share_state !== 'ACTIVE' && !ownerOverride) {
    recordShareLinkOpen('failure', doc.share_state);
    const role = roleFromToken ?? 'editor';
    const capabilities = deriveShareCapabilities(role, doc.share_state);
    const status = doc.share_state === 'DELETED' ? 410 : 404;
    const preview = buildSharePreviewModel({
      slug,
      origin,
      doc: {
        title: doc.title,
        updatedAt: doc.updated_at,
        shareState: doc.share_state,
        revision: doc.revision,
      },
    });
    if (wantsJson(req)) {
      res.status(status).json({
        success: false,
        slug,
        title: null,
        shareState: doc.share_state,
        role,
        capabilities,
        error: 'Document unavailable',
      });
      return;
    }
    if (doc.share_state === 'DELETED') {
      res.status(status).type('html').send(renderUnavailableHtml(preview, 'This document has been deleted.'));
      return;
    }
    const snapshot = slug ? getSnapshotHtml(slug) : null;
    if (snapshot) {
      recordShareLinkOpen('success', `SNAPSHOT_${doc.share_state}`);
      res.setHeader('x-proof-fallback', 'snapshot');
      res.type('html').send(snapshot);
      return;
    }
    const publicUrl = slug ? getSnapshotPublicUrl(slug) : null;
    if (publicUrl) {
      recordShareLinkOpen('success', `CDN_SNAPSHOT_${doc.share_state}`);
      res.redirect(302, publicUrl);
      return;
    }
    res.status(status).type('html').send(renderUnavailableHtml(preview, 'This shared document is not currently accessible.'));
    return;
  }

  if (!doc && slug) {
    const preview = buildSharePreviewModel({
      slug,
      origin,
      shareState: 'MISSING',
    });
    if (!wantsJson(req)) {
      const snapshot = getSnapshotHtml(slug);
      if (snapshot) {
        recordShareLinkOpen('success', 'SNAPSHOT_MISSING_DOC');
        res.setHeader('x-proof-fallback', 'snapshot');
        res.type('html').send(snapshot);
        return;
      }
      const publicUrl = getSnapshotPublicUrl(slug);
      if (publicUrl) {
        recordShareLinkOpen('success', 'CDN_SNAPSHOT_MISSING_DOC');
        res.redirect(302, publicUrl);
        return;
      }
    }
    recordShareLinkOpen('failure', 'MISSING_DOC');
    if (!wantsJson(req) && !wantsMarkdown(req)) {
      res.status(404).type('html').send(renderUnavailableHtml(preview, 'This shared document could not be found.'));
      return;
    }
  }

  if (wantsMarkdown(req)) {
    if (!doc) {
      res.status(404).type('text/plain').send('Document not found');
      return;
    }
    res.type('text/markdown').send(stripProofSpanTags(doc.markdown ?? ''));
    return;
  }

  if (wantsJson(req)) {
    // Product decision: tokenless shares default to editable access (slug is the secret).
    const role = roleFromToken ?? 'editor';
    const shareState = doc?.share_state ?? (slug ? 'MISSING' : 'UNKNOWN');
    const capabilities = deriveShareCapabilities(role, shareState);
    const origin = getPublicOrigin(req);
    const editV2Enabled = isFeatureEnabled(process.env.AGENT_EDIT_V2_ENABLED);
    const mutationReady = doc ? isCanonicalReadMutationReady(doc) : false;
    const readSource = doc && 'read_source' in doc ? doc.read_source : 'projection';
    const projectionFresh = doc && 'projection_fresh' in doc ? doc.projection_fresh : true;
    const links: Record<string, unknown> = {
      ...buildProofSdkLinks(slug, {
        origin,
        includeMutationRoutes: mutationReady,
        includeSnapshotRoute: editV2Enabled,
        includeEditV2Route: editV2Enabled,
      }),
      self: `${origin}/d/${encodeURIComponent(slug)}`,
      agentDocs: `${origin}${AGENT_DOCS_PATH}`,
      agentDiscovery: `${origin}/.well-known/agent.json`,
    };
    const agent: Record<string, unknown> = {
      ...buildProofSdkAgentDescriptor(slug, {
        origin,
        includeMutationRoutes: mutationReady,
        includeSnapshotRoute: editV2Enabled,
        includeEditV2Route: editV2Enabled,
      }),
      mutationReady,
      auth: {
        tokenSource,
        headerFormat: AUTH_HEADER_FORMAT,
        altHeader: ALT_SHARE_TOKEN_HEADER_FORMAT,
      },
    };
    res.json({
      success: Boolean(doc),
      slug,
      title: doc?.title ?? null,
      markdown: doc?.markdown ? stripProofSpanTags(doc.markdown) : null,
      readSource,
      projectionFresh,
      mutationReady,
      shareState,
      role,
      capabilities,
      _links: links,
      agent,
      ...(!mutationReady
        ? {
          warning: {
            code: 'PROJECTION_STALE',
            error: 'Share JSON is serving canonical Yjs fallback content while projection repair catches up.',
          },
        }
        : {}),
      hint: tokenSource === 'query:token'
        ? TOKEN_FROM_URL_HINT
        : TOKEN_MISSING_HINT,
    });
    return;
  }

  // Keep the token in the URL. If present, we also set a cookie for backward-compatible
  // auth, but we do not redirect away from the tokenized URL.
  if (slug && tokenSource === 'query:token') {
    res.cookie(shareTokenCookieName(slug), tokenFromQuery, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureRequest(req),
      path: '/',
    });
  }

  // Option 1: Non-browser agents doing plain web_fetch get a readable HTML page
  // with the document content + API instructions instead of the JS SPA.
  if (isAgentHtmlFetch(req)) {
    if (doc) {
      recordShareLinkOpen('success', `AGENT_HTML_${doc.share_state}`);
    }
    res.append('Link', `</documents/${slug}/state>; rel="agent-state"`);
    res.append('Link', '</.well-known/agent.json>; rel="agent-discovery"');
    const agentHtmlToken = tokenSource === 'query:token' ? token : null;
    const preview = buildSharePreviewModel({
      slug,
      origin,
      doc: doc ? {
        title: doc.title,
        markdown: doc.markdown,
        updatedAt: doc.updated_at,
        shareState: doc.share_state,
        revision: doc.revision,
      } : null,
      shareState: doc?.share_state ?? 'MISSING',
    });
    res.type('html').send(
      renderAgentFriendlyHtml(
        origin,
        slug,
        doc?.markdown ?? '',
        agentHtmlToken,
        preview,
        doc ? isCanonicalReadMutationReady(doc) : false,
      ),
    );
    return;
  }

  // Cache HTML in production; always re-read in development for rebuilds.
  const shouldReloadShareHtml = process.env.NODE_ENV !== 'production' || !shareHtml;
  if (shouldReloadShareHtml) {
    try {
      shareHtml = readFileSync(path.join(distPath, 'index.html'), 'utf-8')
        .replace(/"\.\//g, '"/'); // "./assets/..." -> "/assets/..."
    } catch {
      recordShareLinkOpen('failure', 'SERVER_ERROR');
      res.status(500).send('Editor not built. Run: npm run build');
      return;
    }
  }
  if (doc) {
    recordShareLinkOpen('success', doc.share_state);
  }
  if (
    doc
    && token
    && roleFromToken
    && isForcedLiveViewerRequest(req)
    && typeof doc.access_epoch === 'number'
  ) {
    noteDocumentLiveCollabLease(slug, doc.access_epoch);
    console.warn('[share-web] live-viewer lease noted', {
      slug,
      role: roleFromToken,
      accessEpoch: doc.access_epoch,
      tokenSource,
    });
    upsertActiveCollabConnection({
      connectionId: buildLiveViewerLeaseConnectionId(slug, token, roleFromToken, doc.access_epoch),
      slug,
      role: roleFromToken,
      accessEpoch: doc.access_epoch,
      instanceId: 'share-web-live-viewer',
    });
    noteRecentCollabSessionLease(
      slug,
      doc.access_epoch,
      parsePositiveInt(process.env.COLLAB_SESSION_TTL_SECONDS, 5 * 60) * 1000,
    );
  }
  res.append('Link', `</documents/${slug}/state>; rel="agent-state"`);
  res.append('Link', '</.well-known/agent.json>; rel="agent-discovery"');
  // Option 2: The SPA HTML includes a hidden <div id="agent-instructions"> with
  // API discovery info, visible in raw markup for readability extractors.
  const configShareToken = tokenSource === 'query:token' ? token : null;
  const preview = buildSharePreviewModel({
    slug,
    origin,
    doc: doc ? {
      title: doc.title,
      markdown: doc.markdown,
      updatedAt: doc.updated_at,
      shareState: doc.share_state,
      revision: doc.revision,
    } : null,
    shareState: doc?.share_state ?? 'MISSING',
  });
  res.type('html').send(injectShareHtmlDiscoveryTags(shareHtml ?? '', slug, doc?.markdown ?? '', preview, configShareToken));
});
