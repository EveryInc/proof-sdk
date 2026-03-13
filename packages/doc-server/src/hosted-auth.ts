export type ShareMarkdownAuthMode = 'none' | 'api_key' | 'oauth' | 'oauth_or_api_key' | 'auto';

type PendingAuthStatus = 'pending' | 'completed' | 'failed';

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
