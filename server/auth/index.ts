import type { AuthStrategy } from './strategy.js';
import { NoneAuthStrategy } from './none.js';
import { WorkOSAuthStrategy } from './workos.js';

export type { AuthStrategy, AuthenticatedUser } from './strategy.js';

let activeStrategy: AuthStrategy | null = null;

/**
 * Returns the active auth strategy, creating it on first call.
 * Reads PROOF_AUTH_STRATEGY env var: 'none' (default) or 'workos'.
 */
export function getAuthStrategy(): AuthStrategy {
  if (activeStrategy) return activeStrategy;

  const strategyName = (process.env.PROOF_AUTH_STRATEGY || 'none').trim().toLowerCase();

  switch (strategyName) {
    case 'workos':
      activeStrategy = new WorkOSAuthStrategy();
      console.log('[auth] strategy: workos');
      break;
    case 'none':
      activeStrategy = new NoneAuthStrategy();
      console.log('[auth] strategy: none (no authentication)');
      break;
    default:
      throw new Error(
        `Unknown auth strategy: "${strategyName}". Valid values: none, workos`,
      );
  }

  return activeStrategy;
}
