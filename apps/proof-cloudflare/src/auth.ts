/**
 * Auth middleware for agent routes in Cloudflare Workers.
 *
 * Token resolution follows the same fallback chain as the Express server:
 * x-share-token → x-bridge-token → Authorization: Bearer → ?token= query param
 */

import type { DocumentStorage } from './storage-interface.js';
import type { ShareRole } from './share-types.js';

const ROLE_RANK: Record<ShareRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  owner_bot: 3,
};

/**
 * Extract the presented secret from the request using the standard
 * fallback chain.
 */
export function getPresentedSecret(request: Request): string | null {
  const url = new URL(request.url);

  // 1. x-share-token header
  const shareToken = request.headers.get('x-share-token');
  if (shareToken) return shareToken;

  // 2. x-bridge-token header
  const bridgeToken = request.headers.get('x-bridge-token');
  if (bridgeToken) return bridgeToken;

  // 3. Authorization: Bearer <token>
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 4. Query param ?token= (lowest priority — may carry stale tokens from shared URLs)
  const queryToken = url.searchParams.get('token');
  if (queryToken) return queryToken;

  return null;
}

/**
 * Check whether the presented secret grants at least the required role.
 * Returns the resolved role on success, or null if unauthorized.
 */
export function checkAuth(
  storage: DocumentStorage,
  slug: string,
  secret: string | null,
  requiredRole: ShareRole,
): { role: ShareRole } | null {
  if (!secret) return null;

  const role = storage.resolveDocumentAccessRole(slug, secret);
  if (!role) return null;

  const resolvedRank = ROLE_RANK[role] ?? -1;
  const requiredRank = ROLE_RANK[requiredRole] ?? 0;

  if (resolvedRank < requiredRank) return null;

  return { role };
}

/**
 * Extract the agent ID from request headers.
 * Falls back to a default if not provided.
 */
export function getAgentId(request: Request): string {
  return request.headers.get('x-agent-id') ?? 'anonymous-agent';
}
