/**
 * Regression: proof marks render only their own attributes, and a replace suggestion's widget
 * redraws when its replacement changes.
 *
 * Each proof mark's `$markAttr` default returned `{ id: {}, by: {} }` (plus `kind: {}` on
 * suggestions), and every `toDOM` spreads that result into the span's attributes, so a rendered
 * mark carried `id="[object Object]"` beside its real `data-id`. Milkdown's own default for a mark
 * attribute slice is `() => ({})`.
 *
 * The replace-insert widget was keyed by the mark id alone. prosemirror-view treats widgets with
 * equal keys as interchangeable and keeps the old DOM, so a revised replacement kept showing the
 * first one whenever nothing else redrew the paragraph: through
 * `applyRemoteMarks(..., { hydrateAnchors: false })` (the path for a viewer who cannot edit), and
 * on the editing path when a peer's document change arrives before its marks metadata.
 */

import type { Ctx } from '@milkdown/kit/ctx';
import { Schema, type Mark as ProseMirrorMark } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import { type Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';
import { marksPlugin, marksPluginKey } from '../editor/plugins/marks.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Proof mark DOM attributes
// ---------------------------------------------------------------------------

const { schema: editorSchema } = await getHeadlessMilkdownParser();

const markSamples: Array<[string, Record<string, unknown>]> = [
  ['proofSuggestion', { id: 'suggestion-1', kind: 'replace', by: 'ai:tester', content: 'new text' }],
  ['proofComment', { id: 'comment-1', by: 'human:tester' }],
  ['proofFlagged', { id: 'flag-1', by: 'human:tester' }],
  ['proofApproved', { id: 'approval-1', by: 'human:tester' }],
  ['proofAuthored', { id: 'authored-1', by: 'human:tester' }],
];

function renderedAttributes(mark: ProseMirrorMark): Record<string, unknown> {
  const spec: unknown = mark.type.spec.toDOM?.(mark, true);
  if (!Array.isArray(spec)) throw new Error(`${mark.type.name} should render a DOM output spec array`);
  const attrs: unknown = spec[1];
  if (typeof attrs !== 'object' || attrs === null) throw new Error(`${mark.type.name} should render attributes`);
  return attrs as Record<string, unknown>;
}

for (const [name, attrs] of markSamples) {
  test(`${name} renders only string attributes, none of them its schema attribute names`, () => {
    const markType = editorSchema.marks[name];
    assert(markType !== undefined, `the editor schema should define ${name}`);
    const rendered = renderedAttributes(markType.create(attrs));
    for (const [attribute, value] of Object.entries(rendered)) {
      assert(
        value === null || typeof value === 'string',
        `${name} renders ${attribute}=${String(value)}, which the browser writes as "[object Object]"`,
      );
    }
    for (const schemaAttribute of ['id', 'kind', 'by']) {
      assert(!(schemaAttribute in rendered), `${name} should not render a bare ${schemaAttribute} attribute`);
    }
    assert(rendered['data-by'] === attrs.by, `${name} keeps its data-by attribute`);
  });
}

// ---------------------------------------------------------------------------
// Replace-insert widget identity
// ---------------------------------------------------------------------------

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
  },
});

const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [
    schema.text('The '),
    schema.text('quick brown', [schema.marks.proofSuggestion.create({ id: 'replace-1', kind: 'replace', by: 'ai:tester' })]),
    schema.text(' fox'),
  ]),
]);

// Older than the 2s glow window, so the decoration's class does not change between reads.
const createdAt = new Date(Date.now() - 60_000).toISOString();

function replaceMetadata(content: string) {
  return {
    'replace-1': { kind: 'replace' as const, by: 'ai:tester', createdAt, quote: 'quick brown', status: 'pending' as const, content },
  };
}

// The marks plugin injects its stylesheet when it is created. The repository has no DOM
// implementation, and nothing below renders one; element creation and a head are enough.
const injected: Array<{ id: string }> = [];
Object.assign(globalThis, {
  document: {
    head: { appendChild: (element: { id: string }) => injected.push(element) },
    createElement: () => ({ id: '', textContent: '' }),
    getElementById: (id: string) => injected.find((element) => element.id === id) ?? null,
  },
});

// `$prose` hands the ProseMirror plugin back once its Milkdown wrapper has run; the marks factory
// ignores its context, so one that answers `$prose`'s own wait and update is enough.
const proseContext = {
  wait: async () => undefined,
  update: (_slice: unknown, updater: (plugins: unknown[]) => unknown[]) => void updater([]),
} as unknown as Ctx;
await marksPlugin(proseContext)();
const prosePlugin = marksPlugin.plugin();

const initialState = EditorState.create({ schema, doc, plugins: [prosePlugin] });

function withReplacement(content: string): EditorState {
  return initialState.apply(initialState.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: replaceMetadata(content) }));
}

function replaceWidget(state: EditorState): Decoration {
  const decorations = prosePlugin.props.decorations?.call(prosePlugin, state);
  assert(decorations instanceof DecorationSet, 'the marks plugin should produce a decoration set');
  const widget = (decorations as DecorationSet).find().find((decoration) => decoration.from === decoration.to);
  assert(widget !== undefined, 'a pending replace suggestion should render its replacement widget');
  return widget as Decoration;
}

test('a revised replacement is a different widget to prosemirror-view', () => {
  // prosemirror-view keeps a widget's DOM when the new widget has the same key.
  const before = replaceWidget(withReplacement('slow red')).spec.key;
  const after = replaceWidget(withReplacement('slow grey')).spec.key;
  assert(before !== after, `both replacements share the widget key ${String(before)}, so the view keeps "slow red"`);
});

test('an unchanged replacement keeps its widget', () => {
  const first = replaceWidget(withReplacement('slow red')).spec.key;
  const second = replaceWidget(withReplacement('slow red')).spec.key;
  assert(first === second, 'the same replacement should keep its widget key, so the view does not redraw it');
});

console.log('\n=== Summary ===');
console.log(`Total: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
