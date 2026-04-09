import type { Request, Response, NextFunction } from 'express';
import type { AuthStrategy } from './strategy.js';

/** Routes that never require authentication. */
const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
]);

/** Path prefixes that never require authentication. */
const PUBLIC_PREFIXES = [
  '/og/',            // OG image generation
  '/.well-known/',   // agent discovery
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  // Static assets
  if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/.test(pathname)) return true;
  return false;
}

/**
 * Creates an Express middleware that delegates authentication
 * and authorization to the given strategy.
 */
export function createAuthMiddleware(strategy: AuthStrategy) {
  // 'none' strategy — skip entirely, don't add overhead per-request
  if (strategy.name === 'none') {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    if (isPublicPath(req.path)) {
      next();
      return;
    }

    try {
      const user = await strategy.resolveUser(req);

      if (!user) {
        res.redirect(strategy.loginUrl(req.originalUrl));
        return;
      }

      const forbiddenHtml = strategy.checkAccess(user, req);
      if (forbiddenHtml) {
        res.status(403).type('html').send(forbiddenHtml);
        return;
      }

      req.authenticatedUser = user;
      next();
    } catch (err) {
      console.error('[auth] middleware error:', err);
      res.redirect(strategy.loginUrl(req.originalUrl));
    }
  };
}
