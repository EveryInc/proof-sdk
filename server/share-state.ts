import { invalidateCollabDocument } from './collab.js';
import { addEvent, pauseDocument } from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import { closeRoom } from './ws.js';

export function pauseDocumentAndPropagate(
  slug: string,
  actor: string,
): boolean {
  const paused = pauseDocument(slug);
  invalidateCollabDocument(slug);
  closeRoom(slug);
  addEvent(slug, 'document.paused', {}, actor);
  refreshSnapshotForSlug(slug);
  return paused;
}
