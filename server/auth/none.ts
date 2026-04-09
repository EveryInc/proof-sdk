import { Router, type Request, type Response } from 'express';
import type { AuthStrategy, AuthenticatedUser } from './strategy.js';

/**
 * No-op auth strategy. All requests pass through unauthenticated.
 * This is the default when PROOF_AUTH_STRATEGY is unset or 'none'.
 */
export class NoneAuthStrategy implements AuthStrategy {
  readonly name = 'none';
  readonly router = Router();

  resolveUser(_req: Request): AuthenticatedUser | null {
    return null;
  }

  checkAccess(_user: AuthenticatedUser, _req: Request): string | null {
    return null;
  }

  loginUrl(_returnTo: string): string {
    return '/';
  }

  logout(_req: Request, res: Response): void {
    res.redirect('/');
  }
}
