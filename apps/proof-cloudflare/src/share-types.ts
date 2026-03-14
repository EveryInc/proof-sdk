export type ShareState = 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'DELETED';

export type ShareRole = 'viewer' | 'commenter' | 'editor' | 'owner_bot';

export const ACTIVE_SHARE_STATES: ReadonlySet<ShareState> = new Set<ShareState>([
  'ACTIVE',
]);

export const MUTABLE_SHARE_STATES: ReadonlySet<ShareState> = new Set<ShareState>([
  'ACTIVE',
  'PAUSED',
]);

export function isShareState(value: unknown): value is ShareState {
  return value === 'ACTIVE'
    || value === 'PAUSED'
    || value === 'REVOKED'
    || value === 'DELETED';
}

export function isShareRole(value: unknown): value is ShareRole {
  return value === 'viewer'
    || value === 'commenter'
    || value === 'editor'
    || value === 'owner_bot';
}
