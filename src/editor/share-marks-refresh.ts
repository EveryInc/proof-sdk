export function shouldDeferShareMarksRefresh(args: {
  collabCanEdit: boolean;
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
}): boolean {
  if (!args.collabCanEdit) return false;
  return args.collabUnsyncedChanges > 0 || args.collabPendingLocalUpdates > 0;
}
