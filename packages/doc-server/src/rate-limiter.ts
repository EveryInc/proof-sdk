import type { Request, Response, NextFunction, RequestHandler } from 'express';

type Bucket = {
  count: number;
  resetAt: number;
};

type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
  keyFn: (req: Request) => string;
};

export function createRateLimiter(config: RateLimitConfig): RequestHandler {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = config.keyFn(req) || 'unknown';
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + config.windowMs });
      next();
      return;
    }

    if (current.count >= config.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        retryAfterSeconds,
        limit: {
          maxRequests: config.maxRequests,
          windowMs: config.windowMs,
        },
      });
      return;
    }

    current.count += 1;
    next();
  };
}
