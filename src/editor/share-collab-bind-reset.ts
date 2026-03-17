type ShareCollabBindResetArgs = {
  requestedReset: boolean;
  allowEquivalentSkip: boolean;
  fragmentIsStructurallyEmpty: boolean;
  editorMatchesLiveFragment: boolean;
};

type ShareCollabYDocBindResetArgs = {
  requestedReset: boolean;
  allowEquivalentSkip: boolean;
  fragmentIsStructurallyEmpty: boolean;
};

export function shouldResetShareEditorBeforeCollabBind(
  args: ShareCollabBindResetArgs,
): boolean {
  if (!args.requestedReset) return false;
  if (!args.allowEquivalentSkip) return true;
  if (args.fragmentIsStructurallyEmpty) return true;
  return !args.editorMatchesLiveFragment;
}

export function shouldResetShareCollabYDocBeforeCollabBind(
  args: ShareCollabYDocBindResetArgs,
): boolean {
  if (!args.requestedReset) return false;
  if (!args.allowEquivalentSkip) return true;
  return args.fragmentIsStructurallyEmpty;
}
