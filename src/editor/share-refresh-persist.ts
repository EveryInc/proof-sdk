export function shouldKeepalivePersistShareContent(options: {
  keepalive: boolean;
  persistContent?: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
  hasCompletedInitialCollabHydration: boolean;
  hasLocalContentEditSinceHydration: boolean;
  collabConnectionStatus: 'connecting' | 'connected' | 'disconnected';
  collabIsSynced: boolean;
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
  markdown: string;
}): boolean {
  if (!options.keepalive) return false;
  if (options.persistContent !== true) return false;
  if (!options.collabEnabled || !options.collabCanEdit) return false;
  if (!options.hasCompletedInitialCollabHydration) return false;
  if (!options.hasLocalContentEditSinceHydration) return false;
  // If live Yjs still has local changes in flight, reconnect should recover from
  // the authoritative binary state instead of forcing a stale REST markdown write.
  if (options.collabUnsyncedChanges > 0 || options.collabPendingLocalUpdates > 0) {
    return false;
  }
  const liveSessionHealthy = options.collabConnectionStatus === 'connected'
    && options.collabIsSynced
    && options.collabUnsyncedChanges === 0
    && options.collabPendingLocalUpdates === 0;
  if (liveSessionHealthy) return false;
  return options.markdown.trim().length > 0;
}

export function shouldUseLocalKeepaliveBaseToken(options: {
  keepalive: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
  hasCompletedInitialCollabHydration: boolean;
  collabIsSynced: boolean;
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
}): boolean {
  if (!options.keepalive) return false;
  if (!options.collabEnabled || !options.collabCanEdit) return false;
  if (!options.hasCompletedInitialCollabHydration) return false;
  if (!options.collabIsSynced) return false;
  if (options.collabUnsyncedChanges > 0) return false;
  if (options.collabPendingLocalUpdates > 0) return false;
  return true;
}

export function shouldKeepalivePersistShareMarks(options: {
  keepalive: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
  hasCompletedInitialCollabHydration: boolean;
  hasLocalContentEditSinceHydration: boolean;
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
}): boolean {
  if (!options.keepalive) return true;
  if (!options.collabEnabled || !options.collabCanEdit) return true;
  return false;
}

export function shouldPreserveLocalContentEditMarkerOnRemoteChange(options: {
  isShareMode: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
}): boolean {
  return options.isShareMode && options.collabEnabled && options.collabCanEdit;
}
