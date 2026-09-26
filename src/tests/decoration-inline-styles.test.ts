/**
 * Regression: editor decorations must not carry inline styles.
 *
 * An inline decoration's span is ProseMirror-managed DOM. When an extension that rewrites inline
 * styles (Dark Reader, and any agent doing the same) rewrites the `style` attribute on one,
 * prosemirror-view registers the attribute mutation, marks the range dirty and redraws, which
 * reapplies the decoration's `style` — an endless redraw loop that wedges the tab.
 * (prosemirror-view dist/index.js:1110 ViewDesc.ignoreMutation, :4873 registerMutation, :4915.)
 *
 * The decoration paint therefore lives in the stylesheets these plugins already inject, keyed by
 * the classes the decorations already carry, at single-class specificity so a host page can still
 * restyle marks with its own rules.
 *
 * Covers marks.ts (compose anchor, comment, active comment, insert, delete, replace, and the
 * replace-insert widget); collab-cursors.ts (cursor widget, label, avatar, and collaborator
 * selection); agent-cursor.ts (cursor widget and agent selection); comments.ts (legacy comment
 * decoration); and find-highlights.ts (current find match). The widget checks recurse through
 * agent-face descendants too.
 */

import type { Ctx } from '@milkdown/kit/ctx';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, type Plugin } from '@milkdown/kit/prose/state';
import { DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { marksPlugin, marksPluginKey } from '../editor/plugins/marks.js';
import { collabCursorBuilder, collabSelectionBuilder } from '../editor/plugins/collab-cursors.js';
import { agentCursorPlugin, setAgentSelection } from '../editor/plugins/agent-cursor.js';
import { commentsPlugin, commentsPluginKey } from '../editor/plugins/comments.js';
import { findHighlightsPlugin, setFindHighlights } from '../editor/plugins/find-highlights.js';

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`  FAIL: ${message}`);
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), `${message}\n    Missing: ${needle}`);
}

// ---------------------------------------------------------------------------
// Minimal DOM. The repository has no DOM implementation in its dependencies; these plugins only
// need element creation, a head to inject a <style> into, and lookup by id. Neither plugin module
// touches `document` while it loads, so installing this before the first call is enough.
// ---------------------------------------------------------------------------

const STYLE_DECLARATIONS = Symbol('style declarations');

type StyleStub = Record<string, string> & { [STYLE_DECLARATIONS]: Map<string, string> };

function createStyleStub(): StyleStub {
  const declarations = new Map<string, string>();
  const stub = new Proxy({} as Record<string, string>, {
    get(_target, property) {
      if (property === STYLE_DECLARATIONS) return declarations;
      if (typeof property === 'symbol') return undefined;
      if (property === 'setProperty') {
        return (name: string, value: string) => void declarations.set(name, String(value));
      }
      if (property === 'removeProperty') return (name: string) => void declarations.delete(name);
      if (property === 'getPropertyValue') return (name: string) => declarations.get(name) ?? '';
      return declarations.get(property) ?? '';
    },
    set(_target, property, value) {
      if (typeof property === 'symbol') return true;
      if (value === '' || value === undefined || value === null) declarations.delete(property);
      else declarations.set(property, String(value));
      return true;
    },
  });
  // The proxy answers every property; only its own declaration map is not a CSS property name.
  return stub as StyleStub;
}

class StubElement {
  readonly tagName: string;
  className = '';
  id = '';
  textContent = '';
  src = '';
  alt = '';
  width = 0;
  height = 0;
  loading = '';
  decoding = '';
  readonly style = createStyleStub();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  children: unknown[] = [];
  readonly classList = {
    add: (...names: string[]): void => {
      const current = this.className.split(/\s+/).filter(Boolean);
      for (const name of names) if (!current.includes(name)) current.push(name);
      this.className = current.join(' ');
    },
  };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T>(child: T): T {
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children = nodes;
  }
}

const head = new StubElement('head');

const documentStub = {
  head,
  createElement: (tagName: string) => new StubElement(tagName),
  createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
  getElementById: (id: string): StubElement | null =>
    (head.children as StubElement[]).find((child) => child instanceof StubElement && child.id === id) ?? null,
};

Object.assign(globalThis, { document: documentStub });

/** Everything a real browser would serialize into the element's `style` attribute. */
function inlineStyleOf(element: StubElement): string {
  const fromProperties = Array.from(element.style[STYLE_DECLARATIONS], ([name, value]) => `${name}: ${value}`);
  return [element.attributes.get('style'), ...fromProperties].filter(Boolean).join('; ');
}

function firstInlineStyleInTree(element: StubElement): string | null {
  const ownStyle = inlineStyleOf(element);
  if (ownStyle) return `${element.className || element.tagName}: ${ownStyle}`;
  for (const child of element.children) {
    if (!(child instanceof StubElement)) continue;
    const childStyle = firstInlineStyleInTree(child);
    if (childStyle) return childStyle;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decorations from the real marks plugin
// ---------------------------------------------------------------------------

// Suggestion metadata only survives normalization when the document anchors it, so the test
// schema carries the proof mark types the editor's own schema defines.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: { id: { default: null }, kind: { default: 'replace' }, by: { default: 'unknown' } },
      inclusive: false,
      spanning: true,
    },
    proofComment: {
      attrs: { id: { default: null }, by: { default: 'unknown' } },
      inclusive: false,
      spanning: true,
    },
  },
});

const DOC_TEXT = 'alpha bravo charlie delta echo';
const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [
    schema.text('alpha', [schema.marks.proofComment.create({ id: 'comment-1', by: 'human:tester' })]),
    schema.text(' '),
    schema.text('bravo', [schema.marks.proofSuggestion.create({ id: 'insert-1', kind: 'insert', by: 'ai:tester' })]),
    schema.text(' '),
    schema.text('charlie', [schema.marks.proofSuggestion.create({ id: 'delete-1', kind: 'delete', by: 'ai:tester' })]),
    schema.text(' '),
    schema.text('delta', [schema.marks.proofSuggestion.create({ id: 'replace-1', kind: 'replace', by: 'ai:tester' })]),
    schema.text(' echo'),
  ]),
]);
// The paragraph's text starts at position 1, and `echo` carries no mark of its own.
const composeFrom = 1 + DOC_TEXT.indexOf('echo');
const composeRange = { from: composeFrom, to: composeFrom + 'echo'.length };

// Older than the 2s glow window, so no decoration picks up the transient `proof-mark-new` class.
const createdAt = new Date(Date.now() - 60_000).toISOString();

const metadata = {
  'comment-1': {
    kind: 'comment' as const,
    by: 'human:tester',
    createdAt,
    quote: 'alpha',
    text: 'Needs a citation',
    threadId: 'comment-1',
    thread: [],
    resolved: false,
  },
  'insert-1': { kind: 'insert' as const, by: 'ai:tester', createdAt, quote: 'bravo', status: 'pending' as const, content: 'bravo' },
  'delete-1': { kind: 'delete' as const, by: 'ai:tester', createdAt, quote: 'charlie', status: 'pending' as const },
  'replace-1': { kind: 'replace' as const, by: 'ai:tester', createdAt, quote: 'delta', status: 'pending' as const, content: 'foxtrot' },
};

// `$prose` hands the ProseMirror plugin back once its milkdown wrapper has run. The marks factory
// ignores the context it is given, so a context that answers `$prose`'s own wait and update is
// enough to build the real plugin.
const proseContext = {
  wait: async () => undefined,
  update: (_slice: unknown, updater: (plugins: unknown[]) => unknown[]) => void updater([]),
} as unknown as Ctx;
await marksPlugin(proseContext)();
const prosePlugin = marksPlugin.plugin();
await agentCursorPlugin(proseContext)();
await commentsPlugin(proseContext)();
await findHighlightsPlugin(proseContext)();
const agentPlugin = agentCursorPlugin.plugin();
const commentPlugin = commentsPlugin.plugin();
const findPlugin = findHighlightsPlugin.plugin();

let state = EditorState.create({ schema, doc, plugins: [prosePlugin] });
state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }));
state = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_COMPOSE_ANCHOR', range: composeRange }));
const activeState = state.apply(state.tr.setMeta(marksPluginKey, { type: 'SET_ACTIVE', markId: 'comment-1' }));

/** What the view reads off a decoration when it renders; prosemirror-view does not export it. */
interface RenderedDecoration {
  type: {
    attrs?: { class?: string; style?: string };
    toDOM?: ((view: unknown, getPos: () => number) => StubElement) | StubElement;
  };
}

interface DecorationProbe {
  classes: string;
  style: string | undefined;
  widget: StubElement | null;
}

function probeDecorations(prosePlugin: Plugin, editorState: EditorState): DecorationProbe[] {
  const source = prosePlugin.props.decorations?.call(prosePlugin, editorState);
  if (!(source instanceof DecorationSet)) throw new Error('the plugin produced no decoration set');
  const rendered = source.find() as unknown as RenderedDecoration[];
  return rendered.map(({ type }) => {
    const widget = typeof type.toDOM === 'function' ? type.toDOM(null, () => 0) : (type.toDOM ?? null);
    return {
      classes: type.attrs?.class ?? widget?.className ?? '',
      style: type.attrs?.style,
      widget,
    };
  });
}

const probes = probeDecorations(prosePlugin, state);
const activeProbes = probeDecorations(prosePlugin, activeState);

// The decorations under test must actually have been produced, or the style assertions are vacuous.
for (const cssClass of ['mark-compose-anchor', 'mark-comment', 'mark-insert', 'mark-delete', 'mark-replace', 'mark-replace-insert']) {
  assert(
    probes.some((probe) => probe.classes.split(/\s+/).includes(cssClass)),
    `expected a decoration carrying .${cssClass}`
  );
}
assert(
  activeProbes.some((probe) => probe.classes.split(/\s+/).includes('mark-active')),
  'expected the active comment decoration to carry .mark-active'
);

for (const probe of [...probes, ...activeProbes]) {
  assert(probe.style === undefined, `decoration "${probe.classes}" still sets a style attribute: ${probe.style}`);
  if (probe.widget) {
    assert(
      inlineStyleOf(probe.widget) === '',
      `widget "${probe.classes}" still sets inline styles: ${inlineStyleOf(probe.widget)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Every other ProseMirror decoration plugin installed in the editor
// ---------------------------------------------------------------------------

let agentState = EditorState.create({ schema, doc, plugins: [agentPlugin] });
const agentView = {
  get state(): EditorState {
    return agentState;
  },
  dispatch(transaction: Parameters<EditorState['apply']>[0]): void {
    agentState = agentState.apply(transaction);
  },
} as unknown as EditorView;
const agentSelectionFrom = 1 + DOC_TEXT.indexOf('bravo');
setAgentSelection(agentView, agentSelectionFrom, agentSelectionFrom + 'bravo'.length, 'ai:claude');
const agentProbes = probeDecorations(agentPlugin, agentState);
const agentSelection = agentProbes.find((probe) => probe.classes.split(/\s+/).includes('agent-selection'));
const agentCursor = agentProbes.find((probe) => probe.classes.split(/\s+/).includes('agent-cursor'));
assert(agentSelection !== undefined, 'expected the agent cursor plugin to produce an inline selection decoration');
const agentWidget = agentCursor?.widget ?? null;
assert(agentWidget !== null, 'expected the agent cursor plugin to produce its cursor widget');
assert(agentSelection?.style === undefined, `agent selection still sets a style attribute: ${agentSelection?.style}`);
assert(
  agentWidget !== null && firstInlineStyleInTree(agentWidget) === null,
  `agent cursor widget tree still sets inline styles: ${agentWidget ? firstInlineStyleInTree(agentWidget) : ''}`
);

let findState = EditorState.create({ schema, doc, plugins: [findPlugin] });
const findView = {
  get state(): EditorState {
    return findState;
  },
  dispatch(transaction: Parameters<EditorState['apply']>[0]): void {
    findState = findState.apply(transaction);
  },
} as unknown as EditorView;
const findMatchFrom = 1 + DOC_TEXT.indexOf('delta');
setFindHighlights(findView, [
  { from: agentSelectionFrom, to: agentSelectionFrom + 'bravo'.length },
  { from: findMatchFrom, to: findMatchFrom + 'delta'.length },
], 0);
const findProbes = probeDecorations(findPlugin, findState);
assert(findProbes.length === 2, 'expected the find plugin to produce current and non-current match decorations');
assert(
  findProbes.every((probe) => probe.style === undefined),
  `find match still sets a style attribute: ${findProbes.map((probe) => probe.style).join(', ')}`
);
assert(
  findProbes.some((probe) => probe.classes === 'proof-find-match proof-find-match--active'),
  `expected a current find match class, got ${findProbes.map((probe) => probe.classes).join(', ')}`
);
assert(
  findProbes.some((probe) => probe.classes === 'proof-find-match'),
  `expected a non-current find match class, got ${findProbes.map((probe) => probe.classes).join(', ')}`
);

let commentState = EditorState.create({ schema, doc, plugins: [commentPlugin] });
commentState = commentState.apply(commentState.tr.setMeta(commentsPluginKey, {
  type: 'SET_COMMENTS',
  comments: [{
    id: 'legacy-comment',
    selector: { range: { from: 1, to: 6 } },
    text: 'Legacy comment',
    author: 'human:tester',
    createdAt,
    resolved: false,
    replies: [],
  }],
}));
commentState = commentState.apply(commentState.tr.setMeta(commentsPluginKey, {
  type: 'SET_ACTIVE',
  commentId: 'legacy-comment',
}));
const commentProbes = probeDecorations(commentPlugin, commentState);
assert(commentProbes.length === 1, 'expected the comments plugin to produce the legacy comment decoration');
assert(commentProbes[0]?.style === undefined, `legacy comment decoration still sets a style attribute: ${commentProbes[0]?.style}`);
assert(
  commentProbes[0]?.classes === 'comment-highlight comment-active',
  `expected active legacy comment classes, got ${commentProbes[0]?.classes}`
);

// ---------------------------------------------------------------------------
// Collaborator cursors and selections
// ---------------------------------------------------------------------------

const PEER_COLOR = '#ff8800';

const selectionAttrs = collabSelectionBuilder({ name: 'Ada', color: PEER_COLOR });
assert(
  selectionAttrs.style === undefined,
  `the collab selection decoration still sets a style attribute: ${selectionAttrs.style}`
);
assertIncludes(
  selectionAttrs.class ?? '',
  `proof-collab-selection--${PEER_COLOR.slice(1).toLowerCase()}`,
  'the collab selection decoration should carry the class its generated rule is named after'
);

// The builders return the stub elements this test installed on `document`.
const avatarCursor = collabCursorBuilder({
  name: 'Ada',
  color: PEER_COLOR,
  avatar: 'https://example.com/ada.png',
}) as unknown as StubElement;
assertIncludes(
  avatarCursor.className,
  `proof-collab-cursor--${PEER_COLOR.slice(1).toLowerCase()}`,
  'the collab cursor widget should carry the class its generated rule is named after'
);
const avatarLabel = avatarCursor.children.find(
  (child): child is StubElement => child instanceof StubElement && child.className.includes('proof-collab-cursor__label')
);
assert(avatarLabel !== undefined, 'expected the cursor widget to carry a label');
const avatarImage = avatarLabel?.children.find(
  (child): child is StubElement => child instanceof StubElement && child.tagName === 'img'
);
assert(avatarImage !== undefined, 'expected an avatar image for a peer with an avatar URL');

// The agent peer takes the other label branch, including a face icon in the cursor widget tree.
const agentCollabCursor = collabCursorBuilder({ name: 'Proof Agent', color: PEER_COLOR }) as unknown as StubElement;
const agentLabel = agentCollabCursor.children.find(
  (child): child is StubElement => child instanceof StubElement && child.className.includes('proof-collab-cursor__label')
);
assert(agentLabel !== undefined, 'expected the agent cursor widget to carry a label');

const cursorElements: [string, StubElement | undefined][] = [
  ['cursor widget', avatarCursor],
  ['cursor label', avatarLabel],
  ['cursor avatar', avatarImage],
  ['agent cursor widget', agentCollabCursor],
  ['agent cursor label', agentLabel],
];
for (const [name, element] of cursorElements) {
  if (!element) continue;
  assert(firstInlineStyleInTree(element) === null, `the ${name} still sets inline styles: ${firstInlineStyleInTree(element)}`);
}

// ---------------------------------------------------------------------------
// The paint moved into the injected stylesheets, unchanged
// ---------------------------------------------------------------------------

const markStyles = documentStub.getElementById('proof-mark-glow-styles')?.textContent ?? '';
assert(markStyles !== '', 'expected the marks plugin to inject proof-mark-glow-styles');

const markRules: [string, string][] = [
  ['.mark-comment', 'background-color: rgba(252, 211, 77, 0.3); border-bottom: 2px solid #FCD34D;'],
  ['.mark-active', 'background-color: rgba(252, 211, 77, 0.5); border-bottom: 2px solid #FBBF24;'],
  ['.mark-compose-anchor', 'background-color: rgba(252, 211, 77, 0.22); border-bottom: 2px dashed #F59E0B;'],
  ['.mark-insert', 'background-color: rgba(34, 197, 94, 0.25); border-bottom: 2px solid #22C55E;'],
  ['.mark-delete', 'background-color: rgba(239, 68, 68, 0.2); text-decoration: line-through; color: #666;'],
];
for (const [selector, declarations] of markRules) {
  assertIncludes(markStyles, `${selector} { ${declarations} }`, `expected ${selector} to keep its original declarations`);
}

const expectedMarkRuleOrder = ['.mark-compose-anchor', '.mark-insert', '.mark-delete', '.mark-comment', '.mark-active'];
for (let index = 1; index < expectedMarkRuleOrder.length; index += 1) {
  const previous = expectedMarkRuleOrder[index - 1] ?? '';
  const current = expectedMarkRuleOrder[index] ?? '';
  assert(
    markStyles.indexOf(previous) < markStyles.indexOf(current),
    `expected ${previous} to precede ${current}, preserving decoration overlap precedence`
  );
}

const overlapState = activeState.apply(activeState.tr.setMeta(marksPluginKey, {
  type: 'SET_COMPOSE_ANCHOR',
  range: { from: 1, to: 6 },
}));
const overlapClasses = probeDecorations(prosePlugin, overlapState).map((probe) => probe.classes).join(' ');
assertIncludes(overlapClasses, 'mark-compose-anchor', 'expected a compose anchor to overlap the active comment in this precedence check');
assertIncludes(overlapClasses, 'mark-comment mark-active', 'expected an active comment to overlap the compose anchor in this precedence check');

const agentStyles = documentStub.getElementById('agent-cursor-styles')?.textContent ?? '';
assertIncludes(
  agentStyles,
  '.agent-selection { background-color: rgba(37, 99, 235, 0.14); border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.18); transition: background-color 0.15s ease-out; }',
  'expected the agent selection rule to keep its original declarations'
);
assertIncludes(
  agentStyles,
  '.agent-cursor { position: relative; width: 0; display: inline-block; pointer-events: none; }',
  'expected the agent cursor widget rule to replace its inline layout styles'
);
assertIncludes(
  agentStyles,
  '.agent-cursor-bar { position: absolute; left: 0; top: 0; width: 2px; height: 1.15em; background-color: #2563eb; border-radius: 2px; animation: agentCursorBlink 1.6s ease-in-out infinite; z-index: 100; }',
  'expected the agent cursor bar rule to replace its inline paint'
);

const findStyles = documentStub.getElementById('proof-find-highlight-styles')?.textContent ?? '';
assertIncludes(
  findStyles,
  '.proof-find-match--active { background-color: rgba(34, 211, 238, 0.55) !important; border-radius: 2px; box-shadow: 0 0 0 2px rgba(8, 145, 178, 0.95) !important; text-decoration: underline 2px rgba(8, 145, 178, 0.95); text-underline-offset: 1px; }',
  'expected the current find-match rule to keep its original declarations'
);
assertIncludes(
  findStyles,
  '.proof-find-match { background-color: rgba(250, 204, 21, 0.5) !important; border-radius: 2px; box-shadow: inset 0 -2px 0 rgba(217, 119, 6, 0.9); }',
  'expected the non-current find-match rule to keep its original declarations'
);

const commentStyles = documentStub.getElementById('proof-comment-highlight-styles')?.textContent ?? '';
assertIncludes(
  commentStyles,
  '.comment-highlight { background-color: rgba(255, 220, 100, 0.3); border-bottom: 2px solid rgb(255, 180, 0); }',
  'expected the legacy comment rule to keep its original declarations'
);
assertIncludes(
  commentStyles,
  '.comment-active { background-color: rgba(255, 180, 0, 0.5); border-bottom: 2px solid rgb(255, 140, 0); }',
  'expected the active legacy comment rule to keep its original declarations'
);

const agentFaceStyles = documentStub.getElementById('proof-agent-face-styles')?.textContent ?? '';
assertIncludes(
  agentFaceStyles,
  '.proof-agent-face { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 999px; }',
  'expected the shared agent-face rule to replace widget descendant inline layout styles'
);
assertIncludes(
  agentFaceStyles,
  '.proof-agent-face img { display: block; border-radius: 999px; }',
  'expected the shared agent-face image rule to replace widget descendant inline paint'
);

const cursorStyles = documentStub.getElementById('proof-collab-cursor-styles')?.textContent ?? '';
assert(cursorStyles !== '', 'expected the collab cursor plugin to inject proof-collab-cursor-styles');
assertIncludes(cursorStyles, `--proof-collab-cursor-color: ${PEER_COLOR};`, "expected the peer's cursor colour to reach the stylesheet");
assertIncludes(
  cursorStyles,
  `linear-gradient(180deg, ${PEER_COLOR}14 0%, ${PEER_COLOR}0d 100%)`,
  "expected the peer's selection tint to keep its original colours"
);
assertIncludes(cursorStyles, `outline: 1px solid ${PEER_COLOR}2e`, "expected the peer's selection outline to keep its original colour");
assertIncludes(cursorStyles, `border-bottom: 2px solid ${PEER_COLOR}66`, "expected the peer's selection underline to keep its original colour");

const colorRuleCount = cursorStyles.split(`--proof-collab-cursor-color: ${PEER_COLOR};`).length - 1;
assert(colorRuleCount === 1, `expected one rule per peer colour, found ${colorRuleCount}`);

// A mixed-case peer colour joins the sheet without evicting the first. The token classes must
// normalize case exactly as their generated selectors do.
const SECOND_PEER_COLOR = '#22AA55';
const secondSelectionAttrs = collabSelectionBuilder({ name: 'Grace', color: SECOND_PEER_COLOR });
const secondCursor = collabCursorBuilder({ name: 'Grace', color: SECOND_PEER_COLOR }) as unknown as StubElement;
const twoColorStyles = documentStub.getElementById('proof-collab-cursor-styles')?.textContent ?? '';
const secondSelectionClass = `proof-collab-selection--${SECOND_PEER_COLOR.slice(1).toLowerCase()}`;
const secondCursorClass = `proof-collab-cursor--${SECOND_PEER_COLOR.slice(1).toLowerCase()}`;
assertIncludes(
  secondSelectionAttrs.class ?? '',
  secondSelectionClass,
  'the mixed-case peer selection should carry the exact lowercased class its generated rule uses'
);
assertIncludes(
  secondCursor.className,
  secondCursorClass,
  'the mixed-case peer cursor should carry the exact lowercased class its generated rule uses'
);
assertIncludes(
  twoColorStyles,
  `.${secondCursorClass} {`,
  'expected the mixed-case peer cursor rule selector to match its emitted class exactly'
);
assertIncludes(
  twoColorStyles,
  `.${secondSelectionClass} {`,
  'expected the mixed-case peer selection rule selector to match its emitted class exactly'
);
assertIncludes(
  twoColorStyles,
  `--proof-collab-cursor-color: ${SECOND_PEER_COLOR};`,
  "expected a second peer's colour to reach the stylesheet"
);
assertIncludes(
  twoColorStyles,
  `--proof-collab-cursor-color: ${PEER_COLOR};`,
  "expected the first peer's colour to survive a second peer joining"
);

// The mark paint sheet is now load-bearing. Recreating a plugin after a host clears injected
// styles must restore it, rather than trusting a module-global boolean from an earlier document.
head.children = head.children.filter(
  (child) => !(child instanceof StubElement && child.id === 'proof-mark-glow-styles')
);
await marksPlugin(proseContext)();
assert(
  documentStub.getElementById('proof-mark-glow-styles') !== null,
  'expected marks plugin recreation to re-inject the missing load-bearing stylesheet'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
