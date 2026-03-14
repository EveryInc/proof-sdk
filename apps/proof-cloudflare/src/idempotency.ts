/**
 * Idempotency middleware for agent mutation routes.
 *
 * All POST mutations require an idempotency-key header. If the key has been
 * seen before for the same document + route, the cached response is returned
 * without re-executing the mutation.
 */

import type { DocumentStorage, StorageIdempotencyRecord } from './storage-interface.js';

export interface IdempotencyResult {
  /** True if this is a replay of a previous request. */
  isReplay: boolean;
  /** The cached response (only set when isReplay is true). */
  cachedResponse?: Record<string, unknown>;
  /** The idempotency key extracted from the request. */
  key: string;
}

/**
 * Extract the idempotency key from request headers or body.
 * Returns null if not present.
 */
export function getIdempotencyKey(request: Request, body?: Record<string, unknown>): string | null {
  // Check header first (used by edit v1/v2)
  const headerKey = request.headers.get('idempotency-key');
  if (headerKey) return headerKey;

  // Check body (used by marks operations)
  if (body && typeof body.idempotencyKey === 'string') {
    return body.idempotencyKey;
  }

  return null;
}

/**
 * Check idempotency for a mutation request.
 * Returns a replay result if the key has been seen, or a fresh result
 * with the key for the caller to store after executing the mutation.
 */
export function checkIdempotency(
  storage: DocumentStorage,
  slug: string,
  route: string,
  key: string | null,
  required: boolean,
): IdempotencyResult | Response {
  if (!key) {
    if (required) {
      return Response.json(
        { error: 'idempotency-key required for mutation' },
        { status: 400 },
      );
    }
    // Not required and not provided — proceed without idempotency
    return { isReplay: false, key: '' };
  }

  const cached = storage.getStoredIdempotencyRecord(slug, route, key);
  if (cached) {
    return {
      isReplay: true,
      cachedResponse: cached.response,
      key,
    };
  }

  return { isReplay: false, key };
}

/**
 * Store the result of a mutation for future idempotency replays.
 */
export function storeIdempotencyResult(
  storage: DocumentStorage,
  slug: string,
  route: string,
  key: string,
  response: Record<string, unknown>,
): void {
  if (!key) return;
  storage.storeIdempotencyResult(slug, route, key, response);
}
