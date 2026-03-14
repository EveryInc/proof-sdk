export const CANONICAL_CREATE_API_PATH = '/documents';
export const HOSTED_COMPAT_CREATE_API_PATH = '/share/markdown';
export const LEGACY_CREATE_API_PATH = '/api/documents';
export const COMPAT_CREATE_API_PATH = '/api/share/markdown';
export const AGENT_DOCS_PATH = '/agent-docs';
export const REPORT_BUG_API_PATH = '/api/bridge/report_bug';
export const REPORT_BUG_DOC_ALIAS_PATH = '/d/:slug/bridge/report_bug';
export const REPORT_BUG_OPEN_SOURCE_REPO_URL = 'https://github.com/EveryInc/proof-sdk';
export const ACTIVE_INCIDENT_CODE = 'heavy_load_degradation';
export const ACTIVE_INCIDENT_SUMMARY = 'Proof SDK may be experiencing degraded performance due to heavy load.';
export const ACTIVE_INCIDENT_REPORT_HINT = 'If the issue may be related, still report it, but include timing, request ID, retry behavior, and whether the symptom looked slow, stale, or timeout-related.';
export const ACTIVE_INCIDENT_AGENT_NOTE = 'An active performance incident may be in progress. Retry once if the action was non-destructive. If it still looks wrong, report the failure with concrete evidence.';
export const ACTIVE_INCIDENT_EVIDENCE_EXAMPLES = [
  'Exact request URL, method, status, and x-request-id for the failing call',
  'Whether retrying once changed the outcome',
  'Document slug and which route or bridge flow was affected',
  'A short timeline with timestamps',
  'Raw response body or console/network error text',
];

export const DIRECT_SHARE_AUTH_FIX = 'Add Authorization: Bearer <your-api-key> or use an x-share-token from a document create/share response.';
export const AUTH_HEADER_FORMAT = 'Authorization: Bearer <token>';
export const ALT_SHARE_TOKEN_HEADER_FORMAT = 'x-share-token: <token>';
export const TOKEN_FROM_URL_HINT = 'If you received a URL with ?token=, use that token as Authorization: Bearer <token> (or x-share-token).';
export const TOKEN_MISSING_HINT = 'This link has no token. Ask for a tokenized link if you need a stable shareable URL.';
export const CREATE_NO_HEADERS_HINT = `Agents: to create a web doc without client headers, call POST ${CANONICAL_CREATE_API_PATH}. Hosted compatibility route: POST ${HOSTED_COMPAT_CREATE_API_PATH}.`;

function withOrigin(path: string, origin?: string): string {
  if (!origin) return path;
  return `${origin.replace(/\/+$/, '')}${path}`;
}

export function canonicalReportBugHref(origin?: string): string {
  return withOrigin(REPORT_BUG_API_PATH, origin);
}

export function docAwareReportBugHref(slug: string | null | undefined, origin?: string): string {
  if (!slug) return withOrigin(REPORT_BUG_DOC_ALIAS_PATH, origin);
  return withOrigin(`/d/${encodeURIComponent(slug)}/bridge/report_bug`, origin);
}

export function reportBugDocsHref(origin?: string): string {
  return withOrigin(AGENT_DOCS_PATH, origin);
}

export function canonicalReportBugLink(origin?: string): { method: 'POST'; href: string } {
  return {
    method: 'POST',
    href: canonicalReportBugHref(origin),
  };
}

export function docAwareReportBugLink(
  slug: string | null | undefined,
  origin?: string,
): { method: 'POST'; href: string } {
  return {
    method: 'POST',
    href: docAwareReportBugHref(slug, origin),
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || unique.includes(trimmed)) continue;
    unique.push(trimmed);
  }
  return unique;
}

export function buildReportBugHelp(input: {
  slug?: string | null;
  origin?: string;
  suggestedSummary?: string | null;
  suggestedContext?: string | null;
  suggestedEvidence?: string[];
} = {}): Record<string, unknown> {
  return {
    action: 'report_bug',
    description: 'Call report_bug with what you know. If it returns needs_more_info, ask those questions and call it again.',
    canonicalEndpoint: canonicalReportBugHref(input.origin),
    docAwareEndpoint: docAwareReportBugHref(input.slug, input.origin),
    docs: reportBugDocsHref(input.origin),
    openSourceRepo: REPORT_BUG_OPEN_SOURCE_REPO_URL,
    rawEvidenceAccepted: true,
    suggestedSummary: input.suggestedSummary ?? 'Describe the bug in one sentence.',
    suggestedContext: input.suggestedContext ?? 'Describe what you were trying to do and what looked wrong.',
    suggestedEvidence: uniqueStrings(input.suggestedEvidence ?? []),
    knownIncident: {
      code: ACTIVE_INCIDENT_CODE,
      status: 'active',
      summary: ACTIVE_INCIDENT_SUMMARY,
      reportHint: ACTIVE_INCIDENT_REPORT_HINT,
      agentNote: ACTIVE_INCIDENT_AGENT_NOTE,
      bestEvidence: ACTIVE_INCIDENT_EVIDENCE_EXAMPLES,
    },
  };
}

export function attachReportBugDiscovery(input: {
  links: Record<string, unknown>;
  agent: Record<string, unknown>;
  slug?: string | null;
  origin?: string;
}): void {
  input.links.reportBug = canonicalReportBugLink(input.origin);
  input.links.reportBugDocs = reportBugDocsHref(input.origin);
  if (input.slug) {
    input.links.reportBugForDoc = docAwareReportBugLink(input.slug, input.origin);
  }
  input.agent.reportBugApi = canonicalReportBugHref(input.origin);
  input.agent.reportBugDocs = reportBugDocsHref(input.origin);
  input.agent.reportBugOpenSourceRepo = REPORT_BUG_OPEN_SOURCE_REPO_URL;
  if (input.slug) {
    input.agent.reportBugDocAwareApi = docAwareReportBugHref(input.slug, input.origin);
  }
}

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

  // Local development keeps the old path open by default.
  if (isLocalPublicBaseUrl(publicBaseUrl)) return 'allow';
  // Hosted defaults to phase-A behavior.
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
