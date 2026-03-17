type ShareCollabHydrationEquivalenceArgs = {
  fragmentIsStructurallyEmpty: boolean;
  editorStructurallyEmpty: boolean;
  editorHydrationText: string | null;
  liveFragmentHydrationText: string | null;
  editorHydrationMarkdown: string | null;
  liveYjsHydrationMarkdown: string | null;
};

export function isShareCollabHydrationEquivalent(
  args: ShareCollabHydrationEquivalenceArgs,
): boolean {
  if (args.fragmentIsStructurallyEmpty) return true;
  if (args.liveFragmentHydrationText === null) {
    return false;
  }
  if (args.editorHydrationText === null) return false;
  if (args.editorHydrationText !== args.liveFragmentHydrationText) return false;
  if (args.editorHydrationMarkdown === null || args.liveYjsHydrationMarkdown === null) {
    return true;
  }
  return args.editorHydrationMarkdown === args.liveYjsHydrationMarkdown;
}
