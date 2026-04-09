import type { Router, Request, Response } from 'express';

export interface AuthenticatedUser {
  /** Provider-specific user ID (e.g. WorkOS user ID). */
  id: string;
  email: string;
  name: string | null;
  /** Provider-specific organization ID, if applicable. */
  organizationId: string | null;
  /** Human-readable org name, if known. */
  organizationName: string | null;
  /** The raw session token (cookie value). */
  sessionToken: string;
}

export interface AuthStrategy {
  /** Strategy identifier (e.g. 'none', 'workos'). */
  readonly name: string;

  /**
   * Express router with any routes the strategy needs
   * (login, callback, logout, etc.). Mounted before the middleware.
   */
  readonly router: Router;

  /**
   * Resolve the authenticated user from the request (cookie, header, etc.).
   * Return null if no valid session is present.
   */
  resolveUser(req: Request): Promise<AuthenticatedUser | null> | AuthenticatedUser | null;

  /**
   * After resolveUser succeeds, check whether this user is allowed
   * to access the application (org gate, feature flags, etc.).
   * Return null if access is granted, or an HTML string for a 403 page.
   */
  checkAccess(user: AuthenticatedUser, req: Request): string | null;

  /**
   * URL to redirect unauthenticated users to.
   * @param returnTo - The URL the user was trying to reach.
   */
  loginUrl(returnTo: string): string;

  /**
   * Called on logout. Clear session state, cookies, etc.
   */
  logout(req: Request, res: Response): void;
}

/**
 * Extend Express Request to carry the authenticated user.
 */
declare global {
  namespace Express {
    interface Request {
      authenticatedUser?: AuthenticatedUser;
    }
  }
}
