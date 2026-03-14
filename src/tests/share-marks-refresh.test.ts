import assert from 'node:assert/strict';

import { shouldDeferShareMarksRefresh } from '../editor/share-marks-refresh';

assert.equal(
  shouldDeferShareMarksRefresh({
    collabCanEdit: false,
    collabUnsyncedChanges: 3,
    collabPendingLocalUpdates: 2,
  }),
  false,
  'Read-only/comment-only sessions should still run the authoritative marks refresh fallback',
);

assert.equal(
  shouldDeferShareMarksRefresh({
    collabCanEdit: true,
    collabUnsyncedChanges: 1,
    collabPendingLocalUpdates: 0,
  }),
  true,
  'Editable sessions should defer the fallback while live local changes are unsynced',
);

assert.equal(
  shouldDeferShareMarksRefresh({
    collabCanEdit: true,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 1,
  }),
  true,
  'Editable sessions should defer the fallback while buffered local updates remain pending',
);

assert.equal(
  shouldDeferShareMarksRefresh({
    collabCanEdit: true,
    collabUnsyncedChanges: 0,
    collabPendingLocalUpdates: 0,
  }),
  false,
  'Editable sessions should run the fallback once the room is clean',
);

console.log('✓ share marks refresh defer logic');
