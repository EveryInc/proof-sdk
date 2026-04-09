import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { WorkOS } from '@workos-inc/node';
import type { AuthStrategy, AuthenticatedUser } from './strategy.js';
import { renderForbiddenPage } from './forbidden-page.js';
import { getSessionCookie, setSessionCookie, clearSessionCookie } from '../cookies.js';
import { createShareAuthSession, getShareAuthSession, revokeShareAuthSession } from '../db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Prevent open redirects: only allow relative paths. */
function sanitizeReturnTo(value: string): string {
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return '/';
}

// ── Config helpers ───────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for WorkOS auth strategy`);
  return value;
}

function getPublicBaseUrl(): string {
  return requireEnv('PROOF_PUBLIC_BASE_URL').replace(/\/+$/, '');
}

function getAllowedOrgIds(): Set<string> {
  const raw = (process.env.PROOF_ALLOWED_ORG_IDS || '').trim();
  if (!raw) return new Set();
  return new Set(raw.split(',').map((id) => id.trim()).filter(Boolean));
}

// ── WorkOS metadata stored in session ────────────────────────────────────────

interface WorkOSSessionData {
  workosUserId: string;
  organizationId: string | null;
  accessToken: string;
  refreshToken: string | null;
}

function parseSessionData(accessTokenField: string): WorkOSSessionData | null {
  try {
    return JSON.parse(accessTokenField);
  } catch {
    return null;
  }
}

// ── Strategy implementation ──────────────────────────────────────────────────

export class WorkOSAuthStrategy implements AuthStrategy {
  readonly name = 'workos';
  readonly router: Router;

  private readonly workos: WorkOS;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly allowedOrgIds: Set<string>;

  constructor() {
    this.workos = new WorkOS(requireEnv('WORKOS_API_KEY'));
    this.clientId = requireEnv('WORKOS_CLIENT_ID');
    this.redirectUri = `${getPublicBaseUrl()}/api/auth/callback`;
    this.allowedOrgIds = getAllowedOrgIds();
    this.router = this.buildRouter();
  }

  // ── AuthStrategy interface ───────────────────────────────────────────────

  resolveUser(req: Request): AuthenticatedUser | null {
    const sessionToken = getSessionCookie(req);
    if (!sessionToken) return null;

    const session = getShareAuthSession(sessionToken);
    if (!session || session.revoked_at || session.provider !== 'workos') return null;
    if (new Date(session.session_expires_at) < new Date()) return null;

    const data = parseSessionData(session.access_token);
    if (!data) return null;

    return {
      id: data.workosUserId,
      email: session.email,
      name: session.name,
      organizationId: data.organizationId,
      organizationName: null, // Could be fetched from WorkOS API if needed
      sessionToken,
    };
  }

  checkAccess(user: AuthenticatedUser, req: Request): string | null {
    if (this.allowedOrgIds.size === 0) return null; // No org restriction

    if (!user.organizationId || !this.allowedOrgIds.has(user.organizationId)) {
      const returnTo = encodeURIComponent(req.originalUrl);
      return renderForbiddenPage({
        email: user.email,
        organizationName: user.organizationName,
        loginUrl: '/auth/logout', // Switch Account = clear session, re-login
        switchOrgUrl: `/auth/login?return_to=${returnTo}`, // Re-enter AuthKit to pick org
      });
    }

    return null;
  }

  loginUrl(returnTo: string): string {
    return `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  }

  logout(req: Request, res: Response): void {
    const sessionToken = getSessionCookie(req);
    if (sessionToken) revokeShareAuthSession(sessionToken);
    clearSessionCookie(req, res);
    res.redirect('/auth/login');
  }

  // ── Routes ───────────────────────────────────────────────────────────────

  private buildRouter(): Router {
    const router = Router();

    /**
     * GET /auth/login
     * Redirects to WorkOS AuthKit.
     * Query params:
     *   - return_to: URL to redirect to after login (default: /)
     *   - organization: pre-select an org in AuthKit (for "Switch Organisation")
     *   - screen_hint: 'sign-up' | 'sign-in'
     */
    router.get('/auth/login', (req: Request, res: Response) => {
      const returnTo = sanitizeReturnTo(typeof req.query.return_to === 'string' ? req.query.return_to : '/');
      const organizationId = typeof req.query.organization === 'string' ? req.query.organization : undefined;
      const screenHint = typeof req.query.screen_hint === 'string' ? req.query.screen_hint : undefined;

      const state = Buffer.from(JSON.stringify({ returnTo })).toString('base64url');

      const authorizationUrl = this.workos.userManagement.getAuthorizationUrl({
        provider: 'authkit',
        clientId: this.clientId,
        redirectUri: this.redirectUri,
        state,
        organizationId,
        screenHint: screenHint as 'sign-up' | 'sign-in' | undefined,
      });

      res.redirect(authorizationUrl);
    });

    /**
     * GET /api/auth/callback
     * WorkOS redirects here after authentication.
     */
    router.get('/api/auth/callback', async (req: Request, res: Response) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const stateParam = typeof req.query.state === 'string' ? req.query.state : '';
      const error = typeof req.query.error === 'string' ? req.query.error : '';

      if (error) {
        console.error('[auth:workos] callback error:', error, req.query.error_description);
        res.status(400).type('html').send(
          `<!doctype html><html><body><h1>Sign-in failed</h1><p>${escapeHtml(error)}</p><p><a href="/auth/login">Try again</a></p></body></html>`,
        );
        return;
      }

      if (!code) {
        res.status(400).type('html').send(
          '<!doctype html><html><body><h1>Sign-in failed</h1><p>Missing authorization code.</p></body></html>',
        );
        return;
      }

      try {
        const result = await this.workos.userManagement.authenticateWithCode({
          clientId: this.clientId,
          code,
        });

        const user = result.user;
        const orgId = result.organizationId ?? null;

        const sessionToken = randomUUID();
        const now = new Date();
        const sessionExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
        const accessExpiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

        const sessionData: WorkOSSessionData = {
          workosUserId: user.id,
          organizationId: orgId,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        };

        createShareAuthSession({
          sessionToken,
          provider: 'workos',
          everyUserId: 0, // Not used for WorkOS; real ID is in sessionData
          email: user.email,
          name: user.firstName
            ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`
            : null,
          accessToken: JSON.stringify(sessionData),
          refreshToken: result.refreshToken,
          accessExpiresAt: accessExpiresAt.toISOString(),
          sessionExpiresAt: sessionExpiresAt.toISOString(),
        });

        setSessionCookie(req, res, sessionToken);

        // Parse return_to from state
        let returnTo = '/';
        if (stateParam) {
          try {
            const parsed = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
            if (typeof parsed.returnTo === 'string') returnTo = sanitizeReturnTo(parsed.returnTo);
          } catch {
            // ignore malformed state
          }
        }

        res.redirect(returnTo);
      } catch (err) {
        console.error('[auth:workos] authentication failed:', err);
        res.status(500).type('html').send(
          '<!doctype html><html><body><h1>Sign-in failed</h1><p>Authentication error. Please try again.</p><p><a href="/auth/login">Try again</a></p></body></html>',
        );
      }
    });

    /**
     * GET /auth/logout
     */
    router.get('/auth/logout', (req: Request, res: Response) => {
      this.logout(req, res);
    });

    return router;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
