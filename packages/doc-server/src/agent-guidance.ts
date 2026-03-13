export const CANONICAL_CREATE_API_PATH = '/documents';
export const HOSTED_COMPAT_CREATE_API_PATH = '/share/markdown';
export const LEGACY_CREATE_API_PATH = '/api/documents';
export const COMPAT_CREATE_API_PATH = '/api/share/markdown';
export const AGENT_DOCS_PATH = '/agent-docs';

export const DIRECT_SHARE_AUTH_FIX = 'Add Authorization: Bearer <your-api-key> or use an x-share-token from a document create/share response.';
export const AUTH_HEADER_FORMAT = 'Authorization: Bearer <token>';
export const ALT_SHARE_TOKEN_HEADER_FORMAT = 'x-share-token: <token>';
export const TOKEN_FROM_URL_HINT = 'If you received a URL with ?token=, use that token as Authorization: Bearer <token> (or x-share-token).';
export const TOKEN_MISSING_HINT = 'This link has no token. Ask for a tokenized link if you need a stable shareable URL.';
export const CREATE_NO_HEADERS_HINT = `Agents: to create a web doc without client headers, call POST ${CANONICAL_CREATE_API_PATH}. Hosted compatibility route: POST ${HOSTED_COMPAT_CREATE_API_PATH}.`;

export type LegacyCreateMode = 'allow' | 'warn' | 'disabled';

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function isLocalPublicBaseUrl(publicBaseUrl?: string): boolean {
  if (!publicBaseUrl) return false;
  try {
    const parsed = new URL(publicBaseUrl);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function resolveLegacyCreateMode(publicBaseUrl?: string): LegacyCreateMode {
  const configured = (process.env.PROOF_LEGACY_CREATE_MODE || 'auto').trim().toLowerCase();
  if (configured === 'allow' || configured === 'warn' || configured === 'disabled') {
    return configured;
  }

  if (isLocalPublicBaseUrl(publicBaseUrl)) return 'allow';
  return 'warn';
}

export function canonicalCreateHref(origin?: string): string {
  if (!origin) return CANONICAL_CREATE_API_PATH;
  return `${origin}${CANONICAL_CREATE_API_PATH}`;
}

export function canonicalCreateLink(origin?: string): { method: 'POST'; href: string } {
  return {
    method: 'POST',
    href: canonicalCreateHref(origin),
  };
}

export function buildLegacyCreateDisabledPayload(): Record<string, unknown> {
  return {
    error: 'Legacy document create route is disabled on this server',
    code: 'LEGACY_CREATE_DISABLED',
    fix: `Use POST ${CANONICAL_CREATE_API_PATH}`,
    docs: AGENT_DOCS_PATH,
    create: canonicalCreateLink(),
  };
}

export function buildLegacyCreateDeprecationPayload(mode: LegacyCreateMode): Record<string, unknown> {
  return {
    mode,
    legacyPath: LEGACY_CREATE_API_PATH,
    canonicalPath: CANONICAL_CREATE_API_PATH,
    fix: `Use POST ${CANONICAL_CREATE_API_PATH}`,
    docs: AGENT_DOCS_PATH,
    create: canonicalCreateLink(),
  };
}

export function getLegacyCreateResponseHeaders(mode: LegacyCreateMode): Record<string, string> {
  if (mode === 'warn') {
    return {
      deprecation: 'true',
      warning: `299 - "${LEGACY_CREATE_API_PATH} is legacy; migrate to ${CANONICAL_CREATE_API_PATH}"`,
      'x-proof-legacy-create': 'warn',
      link: `<${AGENT_DOCS_PATH}>; rel="help"`,
    };
  }
  if (mode === 'disabled') {
    return {
      'x-proof-legacy-create': 'disabled',
      link: `<${AGENT_DOCS_PATH}>; rel="help"`,
    };
  }
  return {};
}
