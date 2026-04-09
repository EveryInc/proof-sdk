import { revokeShareAuthSession } from './db.js';

export type ShareMarkdownAuthMode = 'none' | 'api_key' | 'oauth' | 'oauth_or_api_key' | 'auto';

type PendingAuthStatus = 'pending' | 'completed' | 'failed';

export function isOAuthConfigured(_publicBaseUrl?: string): boolean {
  const strategy = (process.env.PROOF_AUTH_STRATEGY || 'none').trim().toLowerCase();
  return strategy !== 'none';
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
  sessionToken: string,
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
  const { getShareAuthSession } = await import('./db.js');
  const session = getShareAuthSession(sessionToken);
  if (!session || session.revoked_at) {
    return { ok: false, reason: 'invalid_session' };
  }
  if (new Date(session.session_expires_at) < new Date()) {
    return { ok: false, reason: 'session_expired' };
  }
  return {
    ok: true,
    principal: {
      userId: session.every_user_id,
      email: session.email,
      name: session.name,
      sessionToken,
    },
  };
}

export function revokeHostedSessionToken(sessionToken: string): boolean {
  return revokeShareAuthSession(sessionToken);
}
