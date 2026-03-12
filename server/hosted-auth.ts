export type ShareMarkdownAuthMode = 'none' | 'api_key' | 'oauth' | 'oauth_or_api_key' | 'auto';

type PendingAuthStatus = 'pending' | 'completed' | 'failed';

export type TrustedProxyIdentityPrincipal = {
  provider: 'trusted_proxy_email';
  email: string;
  actor: string;
  ownerId: string;
  header: string;
};

export type TrustedProxyIdentityConfig = {
  enabled: boolean;
  emailHeaders: string[];
  allowedEmails: string[];
  allowedDomains: string[];
};

function parseCsvEnv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function trustProxyHeaders(): boolean {
  const value = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeTrustedIdentityEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^mailto:/i, '');
  const suffix = withoutScheme.includes(':')
    ? withoutScheme.slice(withoutScheme.lastIndexOf(':') + 1)
    : withoutScheme;
  const normalized = suffix.trim().toLowerCase();
  if (!normalized || !normalized.includes('@') || normalized.startsWith('@') || normalized.endsWith('@')) {
    return null;
  }
  return normalized;
}

function isTrustedIdentityEmailAllowed(email: string, config: TrustedProxyIdentityConfig): boolean {
  if (config.allowedEmails.includes(email)) return true;
  const domain = email.split('@')[1];
  return domain ? config.allowedDomains.includes(domain) : false;
}

export function getTrustedProxyIdentityConfig(): TrustedProxyIdentityConfig {
  const emailHeaders = parseCsvEnv(
    process.env.PROOF_TRUSTED_IDENTITY_EMAIL_HEADERS
    || 'x-goog-authenticated-user-email,x-forwarded-email',
  );
  const allowedEmails = parseCsvEnv(process.env.PROOF_TRUSTED_IDENTITY_EMAILS);
  const allowedDomains = parseCsvEnv(process.env.PROOF_TRUSTED_IDENTITY_EMAIL_DOMAINS);
  return {
    enabled: trustProxyHeaders() && emailHeaders.length > 0 && (allowedEmails.length > 0 || allowedDomains.length > 0),
    emailHeaders,
    allowedEmails,
    allowedDomains,
  };
}

export function resolveTrustedProxyIdentity(input: {
  header(name: string): string | string[] | undefined | null;
}): TrustedProxyIdentityPrincipal | null {
  const config = getTrustedProxyIdentityConfig();
  if (!config.enabled) return null;
  for (const headerName of config.emailHeaders) {
    const raw = input.header(headerName);
    const firstValue = Array.isArray(raw) ? raw[0] : raw;
    if (typeof firstValue !== 'string' || !firstValue.trim()) continue;
    const email = normalizeTrustedIdentityEmail(firstValue);
    if (!email || !isTrustedIdentityEmailAllowed(email, config)) continue;
    return {
      provider: 'trusted_proxy_email',
      email,
      actor: `email:${email}`,
      ownerId: email,
      header: headerName,
    };
  }
  return null;
}

export function isOAuthConfigured(_publicBaseUrl?: string): boolean {
  return false;
}

export function resolveShareMarkdownAuthMode(_publicBaseUrl?: string): Exclude<ShareMarkdownAuthMode, 'auto'> {
  const configured = (process.env.PROOF_SHARE_MARKDOWN_AUTH_MODE || 'none').trim().toLowerCase();
  if (configured === 'api_key') return 'api_key';
  if (configured === 'oauth_or_api_key') return 'oauth_or_api_key';
  if (configured === 'oauth') return 'oauth';
  return 'none';
}

export function startOAuthFlow(_publicBaseUrl: string):
  | {
    ok: true;
    requestId: string;
    pollToken: string;
    pollUrl: string;
    authUrl: string;
    expiresAt: string;
    expiresIn: number;
  }
  | {
    ok: false;
    error: string;
  } {
  return {
    ok: false,
    error: 'OAuth is not available in Proof SDK. Use share tokens or PROOF_SHARE_MARKDOWN_API_KEY.',
  };
}

export function pollOAuthFlow(
  _requestId: string,
  _pollToken: string,
): {
  status: PendingAuthStatus;
  error?: string;
} | null {
  return {
    status: 'failed',
    error: 'OAuth is not available in Proof SDK.',
  };
}

export async function handleOAuthCallback(_input: {
  state: string;
  code?: string;
  error?: string;
  publicBaseUrl?: string;
}): Promise<{
  ok: boolean;
  message: string;
}> {
  return {
    ok: false,
    message: 'OAuth is not available in Proof SDK.',
  };
}

export async function validateHostedSessionToken(
  _sessionToken: string,
  _publicBaseUrl?: string,
): Promise<{
  ok: boolean;
  principal?: {
    userId: number;
    email: string;
    name: string | null;
    sessionToken: string;
  };
  reason?: string;
}> {
  return {
    ok: false,
    reason: 'unsupported',
  };
}

export function revokeHostedSessionToken(_sessionToken: string): boolean {
  return false;
}
