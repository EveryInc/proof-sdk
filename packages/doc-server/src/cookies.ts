import type { Request, Response } from 'express';

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.header('cookie');
  if (typeof header !== 'string' || !header.trim()) return null;

  const parts = header.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = trimmed.slice(eq + 1);
    return decodeCookieValue(raw.trim());
  }

  return null;
}

export function shareTokenCookieName(slug: string): string {
  return `proof_share_token_${slug}`;
}

export function ownerTokenCookieName(slug: string): string {
  return `proof_owner_token_${slug}`;
}

export const SESSION_COOKIE_NAME = 'proof_session';
const DEFAULT_SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const DASHBOARD_AUTH_COOKIE_PREFIX = 'proof_dashboard_auth_';

function isSecureContext(req: Request): boolean {
  if (req.secure) return true;
  const proto = (req.header('x-forwarded-proto') || '').split(',')[0]?.trim().toLowerCase();
  return proto === 'https';
}

function getCookieDomain(req: Request): string | null {
  const forwardedHost = req.header('x-forwarded-host');
  const rawHost = (typeof forwardedHost === 'string' && forwardedHost.trim()
    ? forwardedHost.split(',')[0]
    : req.get('host') || '').trim().toLowerCase();
  const host = rawHost.split(':')[0] || rawHost;
  if (host === 'proof.com' || host === 'www.proof.com') {
    return '.proof.com';
  }
  return null;
}

export function getSessionCookie(req: Request): string | null {
  return getCookie(req, SESSION_COOKIE_NAME);
}

function appendCookie(
  req: Request,
  res: Response,
  name: string,
  value: string,
  options?: {
    maxAgeSec?: number;
    httpOnly?: boolean;
  },
): void {
  const secure = isSecureContext(req);
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
  ];
  const domain = getCookieDomain(req);
  if (domain) parts.push(`Domain=${domain}`);
  if (options?.httpOnly !== false) parts.push('HttpOnly');
  if (typeof options?.maxAgeSec === 'number') parts.push(`Max-Age=${options.maxAgeSec}`);
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(req: Request, res: Response, name: string, httpOnly: boolean = true): void {
  const secure = isSecureContext(req);
  const parts = [
    `${name}=`,
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  const domain = getCookieDomain(req);
  if (domain) parts.push(`Domain=${domain}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function setSessionCookie(req: Request, res: Response, token: string, maxAgeSec?: number): void {
  const age = maxAgeSec ?? DEFAULT_SESSION_MAX_AGE_SEC;
  appendCookie(req, res, SESSION_COOKIE_NAME, token, { maxAgeSec: age, httpOnly: true });
}

export function clearSessionCookie(req: Request, res: Response): void {
  clearCookie(req, res, SESSION_COOKIE_NAME, true);
}

function dashboardAuthCookieName(state: string): string {
  return `${DASHBOARD_AUTH_COOKIE_PREFIX}${state}`;
}

export function getDashboardAuthReturnCookie(req: Request, state: string): string | null {
  return getCookie(req, dashboardAuthCookieName(state));
}

export function setDashboardAuthReturnCookie(
  req: Request,
  res: Response,
  state: string,
  returnUrl: string,
  maxAgeSec: number,
): void {
  appendCookie(req, res, dashboardAuthCookieName(state), returnUrl, {
    maxAgeSec,
    httpOnly: true,
  });
}

export function clearDashboardAuthReturnCookie(req: Request, res: Response, state: string): void {
  clearCookie(req, res, dashboardAuthCookieName(state), true);
}

export function getOwnerTokenCookie(req: Request, slug: string): string | null {
  return getCookie(req, ownerTokenCookieName(slug));
}

export function setOwnerTokenCookie(req: Request, res: Response, slug: string, token: string): void {
  appendCookie(req, res, ownerTokenCookieName(slug), token, { httpOnly: true });
}

export function clearOwnerTokenCookie(req: Request, res: Response, slug: string): void {
  clearCookie(req, res, ownerTokenCookieName(slug), true);
}
