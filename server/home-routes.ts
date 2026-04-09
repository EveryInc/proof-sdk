import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import { fileURLToPath } from 'url';
import { generateSlug } from './slug.js';
import { createDocument, createDocumentAccessToken, addEvent } from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';
import { buildShareLink, withShareToken } from './routes.js';
import { buildProofSdkDocumentPaths, buildProofSdkLinks } from './proof-sdk-routes.js';
import { captureDocumentCreatedTelemetry } from './telemetry.js';
import { AGENT_TAB_UI_SCRIPT } from './homepage-script.js';
import { getPublicBaseUrl } from './public-base-url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const homeRoutes = Router();

// ---------------------------------------------------------------------------
// GET / — Serve the rich home page
// ---------------------------------------------------------------------------

let homeHtmlTemplate: string | null = null;

function getHomeHtmlTemplate(): string {
  if (homeHtmlTemplate && process.env.NODE_ENV === 'production') return homeHtmlTemplate;
  const raw = readFileSync(path.join(__dirname, 'resources', 'home.html'), 'utf-8');
  homeHtmlTemplate = raw.replace('__AGENT_TAB_UI_SCRIPT__', AGENT_TAB_UI_SCRIPT);
  return homeHtmlTemplate;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveBaseUrl(req: Request): string {
  const fromEnv = getPublicBaseUrl(req);
  if (fromEnv) return fromEnv;
  const host = req.get('host');
  if (!host) return `http://localhost:${process.env.PORT || '5555'}`;
  // Reject hosts that contain characters unsafe for URL/HTML interpolation.
  if (/[<>"'`]/.test(host)) return `http://localhost:${process.env.PORT || '5555'}`;
  return `${req.protocol}://${host}`;
}

homeRoutes.get('/', (req: Request, res: Response) => {
  const baseUrl = escapeHtmlAttr(resolveBaseUrl(req));
  const html = getHomeHtmlTemplate().replace(/__PROOF_BASE_URL__/g, baseUrl);
  res.type('html').send(html);
});

// ---------------------------------------------------------------------------
// GET /get-started — Create a blank document and redirect to the editor
// ---------------------------------------------------------------------------

const DEFAULT_STARTER_MARKDOWN = `# Untitled

`;

homeRoutes.post('/get-started', (req: Request, res: Response) => {
  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const markdown = DEFAULT_STARTER_MARKDOWN;
  const marks = canonicalizeStoredMarks({});
  const title = 'Untitled';

  const doc = createDocument(slug, markdown, marks, title, undefined, ownerSecret);
  const access = createDocumentAccessToken(slug, 'editor');
  const links = buildShareLink(req, doc.slug);
  refreshSnapshotForSlug(slug);

  addEvent(slug, 'document.created', {
    title,
    shareState: doc.share_state,
    source: 'get-started',
    accessRole: access.role,
  }, 'web:get-started');

  captureDocumentCreatedTelemetry({
    slug: doc.slug,
    source: 'get-started',
    ownerId: undefined,
    title,
    shareState: doc.share_state,
    accessRole: access.role,
    authMode: 'none',
    authenticated: false,
    contentChars: markdown.length,
  });

  const tokenUrl = withShareToken(links.url, access.secret);
  res.redirect(302, `${tokenUrl}&welcome=1`);
});

// ---------------------------------------------------------------------------
// GET /new — Alias for /get-started
// ---------------------------------------------------------------------------

homeRoutes.post('/new', (req: Request, res: Response) => {
  res.redirect(307, '/get-started');
});
