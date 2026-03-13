export type CollabStatusLike = {
  confirmed?: boolean;
  fragmentConfirmed?: boolean;
  markdownConfirmed?: boolean;
  canonicalConfirmed?: boolean;
  presenceApplied?: boolean;
  cursorApplied?: boolean;
};

export function deriveCollabApplied(status: CollabStatusLike): boolean {
  if (typeof status.confirmed === 'boolean') return status.confirmed;
  return false;
}

export function derivePresenceApplied(status: CollabStatusLike): boolean {
  return status.presenceApplied === true;
}

export function deriveCursorApplied(status: CollabStatusLike): boolean {
  return status.cursorApplied === true;
}
