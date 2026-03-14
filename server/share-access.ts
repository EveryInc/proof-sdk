import type { ShareRole, ShareState } from './share-types.js';

type ShareAccessDoc = {
  share_state: ShareState;
};

export function getEffectiveShareStateForRole(
  doc: ShareAccessDoc,
  _role: ShareRole | null | undefined,
  _authenticatedAccess: boolean = false,
): ShareState {
  return doc.share_state;
}
