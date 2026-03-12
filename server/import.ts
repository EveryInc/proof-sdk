/**
 * Document Import Handler
 *
 * Converts uploaded .docx and .md files into Proof documents.
 *
 * Pipeline:
 *   .docx  ->  mammoth (HTML)  ->  turndown (markdown)  ->  remark normalize  ->  createDocument
 *   .md    ->  read UTF-8      ->  remark normalize      ->  createDocument
 */

import { randomUUID } from 'crypto';
import path from 'path';
import type { Request, Response } from 'express';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
// @ts-expect-error -- turndown-plugin-gfm has no type declarations
import { gfm } from 'turndown-plugin-gfm';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import { generateSlug } from './slug.js';
import { stripEphemeralCollabSpans } from './collab.js';
import { getSnapshotPublicUrl, refreshSnapshotForSlug } from './snapshot.js';
import {
  addEvent,
  createDocument,
  createDocumentAccessToken,
} from './db.js';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';
import {
  buildProofSdkAgentDescriptor,
  buildProofSdkLinks,
} from './proof-sdk-routes.js';
import { captureDocumentCreatedTelemetry } from './telemetry.js';
import { getPublicBaseUrl, buildShareLink, withShareToken } from './routes.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = new Set(['.md', '.docx']);

/** DOCX files are ZIP archives; first 4 bytes are the ZIP local file header. */
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// ============================================================================
// Turndown configuration
// ============================================================================

function createTurndownService(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  td.use(gfm);

  // Strip javascript: links (security: mammoth does not sanitize these)
  td.addRule('strip-javascript-links', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false;
      const href = (node as HTMLAnchorElement).getAttribute('href') || '';
      return /^\s*javascript\s*:/i.test(href);
    },
    replacement: (_content, node) => (node as HTMLElement).textContent || '',
  });

  return td;
}

// ============================================================================
// Markdown normalization
// ============================================================================

const remarkProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .use(remarkStringify as any, {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fences: true,
    listItemIndent: 'one',
  });

/**
 * Strip control characters that cause ProseMirror parsing issues.
 * Preserves \t, \n, \r which are meaningful in markdown.
 */
function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * Normalize markdown through a remark parse/stringify cycle.
 * Produces deterministic CommonMark with proper paragraph separation.
 */
async function normalizeMarkdown(raw: string): Promise<string> {
  const cleaned = stripControlChars(raw);
  const result = await remarkProcessor.process(cleaned);
  return String(result);
}

// ============================================================================
// File validation
// ============================================================================

function getExtension(filename: string): string {
  return path.extname(filename).toLowerCase();
}

function sanitizeFilename(filename: string): string {
  // Remove path separators and null bytes
  const basename = path.basename(filename);
  // Strip extension for use as title
  const name = basename.replace(/\.[^.]+$/, '');
  // Remove characters that could be problematic
  return name.replace(/[^\w\s\-().]/g, '').trim() || 'Untitled';
}

function validateDocxMagic(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return buffer.subarray(0, 4).equals(DOCX_MAGIC);
}

// ============================================================================
// Conversion
// ============================================================================

async function convertDocxToMarkdown(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer }, {
    styleMap: [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Heading 4'] => h4:fresh",
      "p[style-name='Heading 5'] => h5:fresh",
      "p[style-name='Heading 6'] => h6:fresh",
    ],
  });

  if (result.messages.length > 0) {
    console.log('[import] mammoth conversion warnings:', result.messages.map((m) => m.message));
  }

  const td = createTurndownService();
  const rawMarkdown = td.turndown(result.value);
  return normalizeMarkdown(rawMarkdown);
}

async function convertMdToNormalized(buffer: Buffer): Promise<string> {
  const raw = buffer.toString('utf-8');
  return normalizeMarkdown(raw);
}

// ============================================================================
// Route handler
// ============================================================================

export async function handleDocumentImport(req: Request, res: Response): Promise<void> {
  const file = (req as Request & { file?: Express.Multer.File }).file;

  if (!file) {
    res.status(400).json({
      error: 'No file uploaded',
      code: 'MISSING_FILE',
      fix: 'Send a multipart/form-data request with a "file" field containing a .md or .docx file.',
    });
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    res.status(413).json({
      error: `File too large (${Math.round(file.size / 1024 / 1024)}MB). Maximum size is 10MB.`,
      code: 'FILE_TOO_LARGE',
    });
    return;
  }

  const ext = getExtension(file.originalname);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    res.status(400).json({
      error: `Unsupported file type "${ext}". Accepted formats: .md, .docx`,
      code: 'UNSUPPORTED_FORMAT',
    });
    return;
  }

  // Validate DOCX magic bytes
  if (ext === '.docx' && !validateDocxMagic(file.buffer)) {
    res.status(400).json({
      error: 'File does not appear to be a valid .docx document',
      code: 'INVALID_DOCX',
    });
    return;
  }

  // Convert to markdown
  let markdown: string;
  try {
    markdown = ext === '.docx'
      ? await convertDocxToMarkdown(file.buffer)
      : await convertMdToNormalized(file.buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown conversion error';
    res.status(422).json({
      error: `Failed to convert file: ${message}`,
      code: 'CONVERSION_FAILED',
    });
    return;
  }

  const sanitizedMarkdown = stripEphemeralCollabSpans(markdown);
  if (!sanitizedMarkdown.trim()) {
    res.status(400).json({
      error: 'Imported file produced empty content',
      code: 'EMPTY_CONTENT',
    });
    return;
  }

  // Title: explicit form field > filename > "Untitled"
  const bodyTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const title = bodyTitle || sanitizeFilename(file.originalname);

  const ownerId = typeof req.body?.ownerId === 'string' ? req.body.ownerId : undefined;

  // Create document (same flow as POST /documents)
  const slug = generateSlug();
  const ownerSecret = randomUUID();
  const marks = canonicalizeStoredMarks({});
  const doc = createDocument(slug, sanitizedMarkdown, marks, title, ownerId, ownerSecret);
  const defaultAccess = createDocumentAccessToken(slug, 'editor');
  const links = buildShareLink(req, doc.slug);
  const shareUrlWithToken = withShareToken(links.shareUrl, defaultAccess.secret);
  const urlWithToken = withShareToken(links.url, defaultAccess.secret);
  refreshSnapshotForSlug(slug);

  addEvent(slug, 'document.created', {
    title,
    ownerId,
    shareState: doc.share_state,
    source: 'api.documents.import',
    importedFrom: ext,
    originalFilename: file.originalname,
  }, ownerId || 'anonymous');

  captureDocumentCreatedTelemetry({
    slug: doc.slug,
    source: 'api.documents.import',
    ownerId,
    title,
    shareState: doc.share_state,
    accessRole: defaultAccess.role,
    authMode: 'none',
    authenticated: false,
    contentChars: sanitizedMarkdown.length,
  });

  res.json({
    success: true,
    slug: doc.slug,
    docId: doc.doc_id,
    url: links.url,
    shareUrl: links.shareUrl,
    tokenPath: urlWithToken,
    tokenUrl: shareUrlWithToken,
    viewUrl: links.shareUrl,
    viewPath: links.url,
    ownerSecret,
    accessToken: defaultAccess.secret,
    accessRole: defaultAccess.role,
    active: true,
    shareState: doc.share_state,
    snapshotUrl: getSnapshotPublicUrl(doc.slug),
    createdAt: doc.created_at,
    importedFrom: ext,
    originalFilename: file.originalname,
    _links: {
      view: links.url,
      web: links.shareUrl,
      tokenUrl: shareUrlWithToken,
      ...buildProofSdkLinks(doc.slug, {
        includeMutationRoutes: true,
        includeBridgeRoutes: true,
      }),
    },
    agent: buildProofSdkAgentDescriptor(doc.slug, {
      includeMutationRoutes: true,
      includeBridgeRoutes: true,
    }),
  });
}
