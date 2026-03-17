import { isShareCollabHydrationEquivalent } from '../editor/share-collab-hydration-equivalence.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: true,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof',
      liveFragmentHydrationText: 'Welcome to Proof',
      editorHydrationMarkdown: '# Welcome to Proof',
      liveYjsHydrationMarkdown: '# Welcome to Proof',
    }) === true,
    'Expected structurally empty fragments to stay reset-safe',
  );

  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: false,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof Provenance',
      liveFragmentHydrationText: 'Welcome to Proof Provenance',
      editorHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
      liveYjsHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
    }) === true,
    'Expected identical text and collab markdown to allow the initial reset skip',
  );

  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: false,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof Provenance',
      liveFragmentHydrationText: 'Welcome to Proof Provenance',
      editorHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
      liveYjsHydrationMarkdown: '# Welcome to Proof\n\nProvenance',
    }) === false,
    'Expected matching plain text but drifted markdown structure to force a full editor reset before collab bind',
  );

  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: false,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof Provenance',
      liveFragmentHydrationText: null,
      editorHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
      liveYjsHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
    }) === false,
    'Expected unreadable live fragment hydration to fail closed and force a reset before collab bind',
  );
}

try {
  run();
  console.log('✓ share collab hydration equivalence requires markdown structure parity');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
