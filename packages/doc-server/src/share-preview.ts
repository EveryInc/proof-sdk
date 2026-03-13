import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
const DEFAULT_PUBLIC_ORIGIN = 'http://localhost:4000';
const PROJECT_ROOT = path.resolve(__dirname, '..');

const CARD_BACKGROUND = '#f0eee7';
const CARD_TEXT = '#26251e';
const CARD_MUTED_TEXT = 'rgba(38,37,30,0.6)';
const LIVE_GREEN = '#1f8a65';
const LIVE_GREEN_SOFT = 'rgba(38,104,84,0.1)';
const PAUSE_GRAY = '#a5a5a5';
const UNAVAILABLE_TITLE = 'Document unavailable';
const SHARE_ASSET_PUBLIC_ROOT = '/assets/og-share';
const SHARE_OG_TEMPLATE_VERSION = 'figma-og-v2';

function resolveRepoPath(...segments: string[]): string {
  const localPath = path.resolve(PROJECT_ROOT, ...segments);
  if (existsSync(localPath)) return localPath;
  const sharedRootPath = path.resolve(PROJECT_ROOT, '..', '..', ...segments);
  if (existsSync(sharedRootPath)) return sharedRootPath;
  return localPath;
}

function publicAssetPath(...segments: string[]): string {
  return `${SHARE_ASSET_PUBLIC_ROOT}/${segments.join('/')}`;
}

function mimeTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ttf':
      return 'font/ttf';
    case '.woff':
      return 'font/woff';
    default:
      return 'application/octet-stream';
  }
}

function fileToDataUrl(filePath: string): string {
  const mimeType = mimeTypeForPath(filePath);
  const fileBuffer = readFileSync(filePath);
  return `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
}

const FONT_REGULAR_PATH = resolveRepoPath('public', 'assets', 'og-share', 'Switzer-Regular.ttf');
const FONT_MEDIUM_PATH = resolveRepoPath('public', 'assets', 'og-share', 'Switzer-Medium.ttf');
const BANNER_SOURCE_PATH = resolveRepoPath('public', 'assets', 'og-share', 'banner-source.png');
const LINK_ICON_PATH = resolveRepoPath('public', 'assets', 'og-share', 'link-icon.svg');
const LOGO_PATH = resolveRepoPath('public', 'assets', 'og-share', 'proof-logo-outlined.svg');

type FaceMood = 'happy' | 'sad';

export type FaceAssetId =
  | 'happy-blue'
  | 'happy-lime'
  | 'happy-mint'
  | 'happy-peach'
  | 'happy-pink'
  | 'happy-rose'
  | 'sad-purple'
  | 'sad-yellow';

type FaceVariant = {
  id: FaceAssetId;
  mood: FaceMood;
  publicPath: string;
  dataUrl: string;
};

const HAPPY_FACE_IDS: FaceAssetId[] = [
  'happy-blue',
  'happy-lime',
  'happy-mint',
  'happy-peach',
  'happy-pink',
  'happy-rose',
];

const SAD_FACE_IDS: FaceAssetId[] = [
  'sad-purple',
  'sad-yellow',
];

const FACE_ASSET_PATHS: Record<FaceAssetId, string> = {
  'happy-blue': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'happy-blue.svg'),
  'happy-lime': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'happy-lime.svg'),
  'happy-mint': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'happy-mint.svg'),
  'happy-peach': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'happy-peach.svg'),
  'happy-pink': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'happy-pink.svg'),
  'happy-rose': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'happy-rose.svg'),
  'sad-purple': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'sad-purple.svg'),
  'sad-yellow': resolveRepoPath('public', 'assets', 'og-share', 'faces', 'sad-yellow.svg'),
};

const FACE_ASSET_PUBLIC_PATHS: Record<FaceAssetId, string> = {
  'happy-blue': publicAssetPath('faces', 'happy-blue.svg'),
  'happy-lime': publicAssetPath('faces', 'happy-lime.svg'),
  'happy-mint': publicAssetPath('faces', 'happy-mint.svg'),
  'happy-peach': publicAssetPath('faces', 'happy-peach.svg'),
  'happy-pink': publicAssetPath('faces', 'happy-pink.svg'),
  'happy-rose': publicAssetPath('faces', 'happy-rose.svg'),
  'sad-purple': publicAssetPath('faces', 'sad-purple.svg'),
  'sad-yellow': publicAssetPath('faces', 'sad-yellow.svg'),
};

const FONT_REGULAR_DATA = readFileSync(FONT_REGULAR_PATH);
const FONT_MEDIUM_DATA = readFileSync(FONT_MEDIUM_PATH);
const BANNER_SOURCE_DATA_URL = fileToDataUrl(BANNER_SOURCE_PATH);
const LINK_ICON_DATA_URL = fileToDataUrl(LINK_ICON_PATH);
const LOGO_DATA_URL = fileToDataUrl(LOGO_PATH);
const FACE_ASSET_DATA_URLS = Object.fromEntries(
  Object.entries(FACE_ASSET_PATHS).map(([id, filePath]) => [id, fileToDataUrl(filePath)]),
) as Record<FaceAssetId, string>;

type PreviewSourceDocument = {
  title?: string | null;
  markdown?: string | null;
  updatedAt?: string | null;
  shareState?: string | null;
  revision?: number | string | null;
};

export type SharePreviewModel = {
  slug: string;
  publicOrigin: string;
  shareState: string;
  canonicalUrl: string;
  displayUrl: string | null;
  imageUrl: string;
  title: string;
  description: string;
  excerpt: string | null;
  bodyText: string;
  imageAlt: string;
  statusLabel: string;
  updatedAt: string | null;
  revisionTag: string;
  isUnavailable: boolean;
  faceAssetId: FaceAssetId;
  faceAssetPath: string;
  faceMood: FaceMood;
};

type Child = PreviewElement | string;

type PreviewElement = {
  type: string;
  props: Record<string, unknown> & { children?: Child | Child[] };
};

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer;
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

export function resolvePublicOrigin(origin?: string | null): string {
  const configured = process.env.PROOF_PUBLIC_ORIGIN?.trim();
  if (configured) return normalizeOrigin(configured);
  if (origin && origin.trim()) return normalizeOrigin(origin);
  return DEFAULT_PUBLIC_ORIGIN;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '');
}

function stripMarkdownInline(value: string): string {
  return collapseWhitespace(
    value
      .replace(/!\[[^\]]*]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/<[^>]+>/g, ''),
  );
}

function markdownToPlainText(markdown: string): string {
  return collapseWhitespace(
    stripFrontmatter(markdown)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}(?:[-+*]|\d+\.)\s+/gm, '')
      .replace(/[>*_~#`]/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function extractTitle(markdown: string, fallbackTitle?: string | null): string {
  const trimmedFallback = fallbackTitle?.trim();
  if (trimmedFallback) return trimmedFallback;
  const frontmatterStripped = stripFrontmatter(markdown);
  const lines = frontmatterStripped.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*#\s+(.+?)\s*$/);
    if (!match) continue;
    const heading = stripMarkdownInline(match[1]);
    if (heading) return heading;
  }
  return 'Untitled document';
}

function extractExcerpt(markdown: string, title: string): string | null {
  const frontmatterStripped = stripFrontmatter(markdown)
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n');
  const paragraphs = frontmatterStripped
    .split(/\n\s*\n/)
    .map((segment) => stripMarkdownInline(
      segment
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s{0,3}(?:[-+*]|\d+\.)\s+/gm, ''),
    ))
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph === title) continue;
    if (paragraph.length >= 12) return paragraph;
  }

  const fallback = markdownToPlainText(markdown);
  if (!fallback || fallback === title) return null;
  return fallback;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildUnavailableDescription(shareState: string): string {
  switch (shareState) {
    case 'PAUSED':
      return 'The shared Proof document is temporarily unavailable';
    case 'REVOKED':
      return 'The shared Proof document is no longer accessible';
    case 'DELETED':
      return 'The shared Proof document has been deleted';
    default:
      return 'The shared Proof document could not be found';
  }
}

function humanizeShareState(shareState: string): string {
  switch (shareState) {
    case 'ACTIVE':
      return 'Live';
    case 'PAUSED':
      return 'Paused';
    default:
      return 'Unavailable';
  }
}

function selectFaceVariant(slug: string, shareState: string): FaceVariant {
  const isUnavailable = shareState !== 'ACTIVE';
  const assetIds = isUnavailable ? SAD_FACE_IDS : HAPPY_FACE_IDS;
  const faceAssetId = assetIds[createHash('sha1').update(`${slug}:${shareState}`).digest()[0] % assetIds.length];

  return {
    id: faceAssetId,
    mood: isUnavailable ? 'sad' : 'happy',
    publicPath: FACE_ASSET_PUBLIC_PATHS[faceAssetId],
    dataUrl: FACE_ASSET_DATA_URLS[faceAssetId],
  };
}

export function buildSharePreviewModel(input: {
  slug: string;
  origin?: string | null;
  doc?: PreviewSourceDocument | null;
  shareState?: string | null;
}): SharePreviewModel {
  const publicOrigin = resolvePublicOrigin(input.origin);
  const shareState = (input.doc?.shareState ?? input.shareState ?? 'ACTIVE').toUpperCase();
  const isUnavailable = shareState !== 'ACTIVE';
  const markdown = input.doc?.markdown ?? '';
  const title = isUnavailable ? UNAVAILABLE_TITLE : extractTitle(markdown, input.doc?.title);
  const excerpt = isUnavailable ? null : extractExcerpt(markdown, title);
  const bodyText = truncate(
    isUnavailable ? buildUnavailableDescription(shareState) : (excerpt ?? 'Shared on Proof'),
    isUnavailable ? 120 : 220,
  );
  const description = truncate(bodyText, 160);
  const revisionTagRaw = input.doc?.revision ?? input.doc?.updatedAt ?? '0';
  const revisionTag = String(revisionTagRaw);
  const canonicalUrl = `${publicOrigin}/d/${encodeURIComponent(input.slug)}`;
  const displayUrl = isUnavailable ? null : canonicalUrl.replace(/^https?:\/\//, '');
  const imageUrl = `${publicOrigin}/og/share/${encodeURIComponent(input.slug)}.png?v=${encodeURIComponent(revisionTag)}&t=${encodeURIComponent(SHARE_OG_TEMPLATE_VERSION)}`;
  const imageAlt = bodyText
    ? `${title}. ${truncate(bodyText, 120)}`
    : `${title} on Proof`;
  const face = selectFaceVariant(input.slug, shareState);

  return {
    slug: input.slug,
    publicOrigin,
    shareState,
    canonicalUrl,
    displayUrl,
    imageUrl,
    title,
    description,
    excerpt,
    bodyText,
    imageAlt,
    statusLabel: humanizeShareState(shareState),
    updatedAt: input.doc?.updatedAt ?? null,
    revisionTag,
    isUnavailable,
    faceAssetId: face.id,
    faceAssetPath: face.publicPath,
    faceMood: face.mood,
  };
}

export function renderShareMetaTags(model: SharePreviewModel): string {
  const title = escapeHtml(`${model.title} | Proof`);
  const description = escapeHtml(model.description);
  const canonicalUrl = escapeHtml(model.canonicalUrl);
  const imageUrl = escapeHtml(model.imageUrl);
  const imageAlt = escapeHtml(model.imageAlt);
  const secureImageTag = model.imageUrl.startsWith('https://')
    ? `\n<meta property="og:image:secure_url" content="${imageUrl}">`
    : '';

  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${canonicalUrl}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Proof">',
    `<meta property="og:title" content="${escapeHtml(model.title)}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonicalUrl}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`,
    `<meta property="og:image:alt" content="${imageAlt}">${secureImageTag}`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(model.title)}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
    `<meta name="twitter:image:alt" content="${imageAlt}">`,
  ].join('\n');
}

function element(type: string, props: Record<string, unknown>, ...children: Child[]): PreviewElement {
  const nextProps: Record<string, unknown> & { children?: Child | Child[] } = { ...props };
  if (children.length === 1) nextProps.children = children[0];
  else if (children.length > 1) nextProps.children = children;
  return {
    type,
    props: nextProps,
  };
}

export function resolveOgTextLayout(title: string): {
  titleFontSize: number;
  excerptFontSize: number;
  excerptMaxLength: number;
  contentGap: string;
} {
  const length = title.trim().length;
  if (length >= 170) {
    return {
      titleFontSize: 44,
      excerptFontSize: 30,
      excerptMaxLength: 132,
      contentGap: '10px',
    };
  }
  if (length >= 140) {
    return {
      titleFontSize: 50,
      excerptFontSize: 34,
      excerptMaxLength: 150,
      contentGap: '12px',
    };
  }
  return {
    titleFontSize: 55,
    excerptFontSize: 38,
    excerptMaxLength: 180,
    contentGap: '12.595px',
  };
}

function buildStatusTree(model: SharePreviewModel): PreviewElement {
  const icon = model.isUnavailable
    ? element(
      'div',
      {
        style: {
          display: 'flex',
          gap: '3px',
          alignItems: 'center',
          height: '18px',
        },
      },
      element('div', {
        style: {
          width: '8px',
          height: '18px',
          backgroundColor: PAUSE_GRAY,
          display: 'flex',
        },
      }),
      element('div', {
        style: {
          width: '8px',
          height: '18px',
          backgroundColor: PAUSE_GRAY,
          display: 'flex',
        },
      }),
    )
    : element('div', {
      style: {
        width: '19px',
        height: '19px',
        borderRadius: '999px',
        backgroundColor: LIVE_GREEN,
        display: 'flex',
      },
    });

  return element(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        color: '#0f0f0f',
        fontSize: '31.908px',
        lineHeight: 1.1,
        letterSpacing: '-0.0924px',
        fontWeight: 400,
        fontFamily: 'Switzer',
      },
    },
    icon,
    model.statusLabel,
  );
}

function buildUrlChipTree(model: SharePreviewModel): PreviewElement {
  return element(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 30px',
        borderRadius: '1000px',
        backgroundColor: LIVE_GREEN_SOFT,
        color: LIVE_GREEN,
        fontSize: '30px',
        lineHeight: 1.1,
        letterSpacing: '-0.0924px',
        fontWeight: 400,
        fontFamily: 'Switzer',
        maxWidth: '805px',
      },
    },
    element('img', {
      alt: '',
      src: LINK_ICON_DATA_URL,
      width: 40,
      height: 40,
      style: {
        width: '40px',
        height: '40px',
        display: 'flex',
      },
    }),
    truncate(model.displayUrl ?? '', 54),
  );
}

function buildFooterTree(model: SharePreviewModel): PreviewElement {
  const footerTop = model.isUnavailable ? 555 : 542;
  const footerStyle = model.isUnavailable
    ? {
        position: 'absolute',
        left: '53px',
        top: `${footerTop}px`,
        width: '1095px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
      }
    : {
        position: 'absolute',
        left: '53px',
        top: `${footerTop}px`,
        width: '1095px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '38px',
      };

  if (model.displayUrl) {
    return element(
      'div',
      { style: footerStyle },
      buildUrlChipTree(model),
      buildStatusTree(model),
    );
  }

  return element(
    'div',
    { style: footerStyle },
    buildStatusTree(model),
  );
}

function buildOgTree(model: SharePreviewModel): PreviewElement {
  const textLayout = resolveOgTextLayout(model.title);
  const bodyText = truncate(model.bodyText, textLayout.excerptMaxLength);

  return element(
    'div',
    {
      style: {
        width: `${OG_IMAGE_WIDTH}px`,
        height: `${OG_IMAGE_HEIGHT}px`,
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: CARD_BACKGROUND,
        color: CARD_TEXT,
        fontFamily: 'Switzer',
      },
    },
    element('img', {
      alt: '',
      src: BANNER_SOURCE_DATA_URL,
      width: OG_IMAGE_WIDTH,
      height: OG_IMAGE_HEIGHT,
      style: {
        position: 'absolute',
        left: '0px',
        top: '0px',
        width: `${OG_IMAGE_WIDTH}px`,
        height: `${OG_IMAGE_HEIGHT}px`,
        objectFit: 'cover',
        display: 'flex',
      },
    }),
    element('div', {
      style: {
        position: 'absolute',
        left: '0px',
        top: '99px',
        width: `${OG_IMAGE_WIDTH}px`,
        height: '531px',
        backgroundColor: CARD_BACKGROUND,
        display: 'flex',
      },
    }),
    element('img', {
      alt: 'Proof',
      src: LOGO_DATA_URL,
      width: 353.008,
      height: 159.021,
      style: {
        position: 'absolute',
        left: '40.492px',
        top: '32.995px',
        width: '353.008px',
        height: '159.021px',
        display: 'flex',
      },
    }),
    element('img', {
      alt: '',
      src: FACE_ASSET_DATA_URLS[model.faceAssetId],
      width: 130.262,
      height: 130.262,
      style: {
        position: 'absolute',
        left: '1017.238px',
        top: model.isUnavailable ? '43px' : '45px',
        width: '130.262px',
        height: '130.262px',
        display: 'flex',
      },
    }),
    element(
      'div',
      {
        style: {
          position: 'absolute',
          left: '52.5px',
          top: model.isUnavailable ? '188.022px' : '190.022px',
          width: '1095px',
          display: 'flex',
          flexDirection: 'column',
          gap: textLayout.contentGap,
        },
      },
      element(
        'div',
        {
          style: {
            display: 'flex',
            fontSize: `${textLayout.titleFontSize}px`,
            lineHeight: 1.1,
            letterSpacing: '-0.2729px',
            fontWeight: 500,
            color: CARD_TEXT,
            fontFamily: 'Switzer',
          },
        },
        truncate(model.title, 160),
      ),
      element(
        'div',
        {
          style: {
            display: 'flex',
            fontSize: `${textLayout.excerptFontSize}px`,
            lineHeight: 1.1,
            letterSpacing: '-0.0924px',
            color: CARD_MUTED_TEXT,
            fontWeight: 400,
            fontFamily: 'Switzer',
          },
        },
        bodyText,
      ),
    ),
    buildFooterTree(model),
  );
}

export function renderSharePreviewHtmlPage(
  model: SharePreviewModel,
  options: { markdown?: string | null; note?: string | null } = {},
): string {
  const note = options.note?.trim();
  const markdown = options.markdown ?? null;
  const markdownSection = markdown
    ? `<div class="share-page__markdown">
      <div class="share-page__markdown-label">Snapshot</div>
      <pre>${escapeHtml(markdown)}</pre>
    </div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderShareMetaTags(model)}
  <style>
    :root {
      color-scheme: light;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: #e7e4dc;
      color: ${CARD_TEXT};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .share-page {
      width: 100%;
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 16px 40px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .share-page__note {
      font-size: 14px;
      line-height: 1.4;
      color: rgba(38,37,30,0.7);
      padding: 0 2px;
    }
    .share-page__card {
      width: min(1200px, 100%);
      display: block;
      margin: 0;
      border: 0;
    }
    .share-page__markdown {
      width: min(1200px, 100%);
      background: rgba(255,255,255,0.72);
      border: 1px solid rgba(38,37,30,0.12);
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 18px 38px rgba(38, 37, 30, 0.08);
    }
    .share-page__markdown-label {
      padding: 12px 16px;
      border-bottom: 1px solid rgba(38,37,30,0.1);
      font-size: 13px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: rgba(38,37,30,0.6);
    }
    .share-page__markdown pre {
      margin: 0;
      padding: 18px 16px 22px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 15px;
      line-height: 1.55;
      color: ${CARD_TEXT};
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
    }
  </style>
</head>
<body>
  <main class="share-page">
    ${note ? `<div class="share-page__note">${escapeHtml(note)}</div>` : ''}
    <img class="share-page__card" src="${escapeHtml(model.imageUrl)}" alt="${escapeHtml(model.imageAlt)}">
    ${markdownSection}
  </main>
</body>
</html>`;
}

export async function renderShareOgSvg(model: SharePreviewModel): Promise<string> {
  return satori(buildOgTree(model) as unknown as Parameters<typeof satori>[0], {
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    fonts: [
      {
        name: 'Switzer',
        data: toArrayBuffer(FONT_REGULAR_DATA),
        weight: 400,
        style: 'normal',
      },
      {
        name: 'Switzer',
        data: toArrayBuffer(FONT_MEDIUM_DATA),
        weight: 500,
        style: 'normal',
      },
    ],
  });
}

export async function renderShareOgPng(model: SharePreviewModel): Promise<Buffer> {
  const svg = await renderShareOgSvg(model);
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: 'width',
      value: OG_IMAGE_WIDTH,
    },
  });
  return Buffer.from(resvg.render().asPng());
}
