import assert from 'node:assert/strict';

import {
  shouldKeepalivePersistShareMarks,
  shouldKeepalivePersistShareContent,
  shouldPreserveLocalContentEditMarkerOnRemoteChange,
  shouldUseLocalKeepaliveBaseToken,
} from '../editor/share-refresh-persist.js';

assert.equal(
  shouldKeepalivePersistShareContent({
    keepalive: true,
    persistContent: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: true,
    collabConnectionStatus: 'connected',
    collabIsSynced: true,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
    markdown: 'Sup dude!\n\n<br />\n\nDoes this work? Seems to!\n',
  }),
  false,
  'Expected healthy live collab sessions not to reverse-flow shared content through keepalive REST writes',
);

assert.equal(
  shouldKeepalivePersistShareContent({
    keepalive: true,
    persistContent: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: true,
    collabConnectionStatus: 'disconnected',
    collabIsSynced: false,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
    markdown: 'Sup dude!\n',
  }),
  true,
  'Expected degraded live sessions to keep the content keepalive fallback available after a local edit',
);

assert.equal(
  shouldKeepalivePersistShareContent({
    keepalive: true,
    persistContent: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: false,
    collabConnectionStatus: 'disconnected',
    collabIsSynced: false,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
    markdown: 'Sup dude!\n',
  }),
  false,
  'Expected keepalive content persistence to require a local content edit',
);

assert.equal(
  shouldKeepalivePersistShareContent({
    keepalive: true,
    persistContent: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: true,
    collabConnectionStatus: 'disconnected',
    collabIsSynced: false,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
    markdown: '',
  }),
  false,
  'Expected empty shared markdown to avoid PUT /documents empty-markdown failures',
);

assert.equal(
  shouldKeepalivePersistShareContent({
    keepalive: true,
    persistContent: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: true,
    collabConnectionStatus: 'connected',
    collabIsSynced: false,
    collabUnsyncedChanges: 1,
    collabPendingLocalUpdates: 0,
    markdown: 'Sup dude!\n',
  }),
  false,
  'Expected pending live Yjs changes to stay on the binary reconnect path instead of reverse-flowing content through REST keepalive',
);

assert.equal(
  shouldKeepalivePersistShareContent({
    keepalive: true,
    persistContent: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: true,
    collabConnectionStatus: 'disconnected',
    collabIsSynced: true,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 2,
    markdown: 'Sup dude!\n',
  }),
  false,
  'Expected pending local collab publishes to avoid keepalive content writes until the live room is quiescent',
);

assert.equal(
  shouldUseLocalKeepaliveBaseToken({
    keepalive: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    collabIsSynced: true,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
  }),
  true,
  'Expected keepalive writes to use a local base token only when collab is fully synced',
);

assert.equal(
  shouldUseLocalKeepaliveBaseToken({
    keepalive: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    collabIsSynced: false,
    collabUnsyncedChanges: 1,
    collabPendingLocalUpdates: 0,
  }),
  false,
  'Expected keepalive writes with unsynced local changes to avoid hashing the outgoing snapshot as the base token',
);

assert.equal(
  shouldUseLocalKeepaliveBaseToken({
    keepalive: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    collabIsSynced: true,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 2,
  }),
  false,
  'Expected pending local collab publishes to keep keepalive writes on observed-base preconditions',
);

assert.equal(
  shouldKeepalivePersistShareMarks({
    keepalive: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: true,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
  }),
  false,
  'Expected keepalive marks writes to stay off the REST row for editable live share sessions with local content edits',
);

assert.equal(
  shouldKeepalivePersistShareMarks({
    keepalive: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: false,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
  }),
  false,
  'Expected editable live share sessions not to mirror marks into the REST row during keepalive, even when quiescent',
);

assert.equal(
  shouldKeepalivePersistShareMarks({
    keepalive: true,
    collabEnabled: true,
    collabCanEdit: true,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: false,
    collabUnsyncedChanges: 1,
    collabPendingLocalUpdates: 0,
  }),
  false,
  'Expected unsynced local collab state to avoid external marks keepalive writes',
);

assert.equal(
  shouldKeepalivePersistShareMarks({
    keepalive: true,
    collabEnabled: true,
    collabCanEdit: false,
    hasCompletedInitialCollabHydration: true,
    hasLocalContentEditSinceHydration: false,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
  }),
  true,
  'Expected commenter and non-editable share sessions to keep REST mark durability available',
);

assert.equal(
  shouldPreserveLocalContentEditMarkerOnRemoteChange({
    isShareMode: true,
    collabEnabled: true,
    collabCanEdit: true,
  }),
  true,
  'Expected editable share sessions to retain their local-content marker across remote Yjs echoes until a real rehydration reset',
);

assert.equal(
  shouldPreserveLocalContentEditMarkerOnRemoteChange({
    isShareMode: false,
    collabEnabled: true,
    collabCanEdit: true,
  }),
  false,
  'Expected non-share sessions not to retain the share-only local-content marker on remote changes',
);

console.log('✓ share refresh keepalive persistence gating behaves as expected');
