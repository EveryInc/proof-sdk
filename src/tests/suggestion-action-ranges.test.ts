/**
 * Regression: a mark action works on the mark's own runs, not on the text between them.
 *
 * `resolveActionRanges` joined all of a mark's runs into one range, from the first run's start to
 * the last run's end, whenever the text of that range equalled the mark's quote. The quote is
 * itself taken over that range, so the check always held. Where text without the mark lies
 * between two runs (someone else's insert suggested inside this one, or text pasted into it),
 * reject deleted that text, accept rewrote or re-attributed it, and deleteMark stripped the
 * other mark in between. Runs that meet across a block boundary or a non-text inline node are
 * still one range, so rejecting an insert typed across Enter joins the blocks again.
 */

import type { Mark as ProseMirrorMark, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';
import {
  accept,
  deleteMark,
  getMarks,
  marksPluginKey,
  reject,
  type StoredMark,
} from '../editor/plugins/marks.js';

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const { schema, parseMarkdown } = await getHeadlessMilkdownParser();
const createdAt = new Date(Date.now() - 60_000).toISOString();

const suggestion = (id: string, kind: 'insert' | 'delete', by: string) =>
  schema.marks.proofSuggestion.create({ id, kind, by });
const commentMark = (id: string, by: string) => schema.marks.proofComment.create({ id, by });
const text = (value: string, marks: readonly ProseMirrorMark[] = []) => schema.text(value, marks);
const paragraph = (...content: ProseMirrorNode[]) => schema.node('paragraph', null, content);

function stored(kind: StoredMark['kind'], by: string, extra: Partial<StoredMark> = {}): StoredMark {
  return { kind, by, createdAt, status: 'pending', ...extra } as StoredMark;
}

function editor(blocks: ProseMirrorNode[], metadata: Record<string, StoredMark>) {
  const plugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata, activeMarkId: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        return meta?.type === 'SET_METADATA' ? { ...value, metadata: meta.metadata } : value;
      },
    },
  });
  let state = EditorState.create({ schema, doc: schema.node('doc', null, blocks), plugins: [plugin] });
  return {
    view: {
      get state() {
        return state;
      },
      dispatch(tr: Parameters<EditorState['apply']>[0]) {
        state = state.apply(tr);
      },
    } as never,
    blocks: () => {
      const out: string[] = [];
      state.doc.forEach((block) => out.push(block.textContent));
      return out;
    },
    pending: () => getMarks(state).filter((mark) => mark.kind !== 'authored').map((mark) => mark.id),
    authored: () =>
      getMarks(state).flatMap((mark) =>
        mark.kind === 'authored' && mark.range ? [state.doc.textBetween(mark.range.from, mark.range.to)] : [],
      ),
  };
}

const alice = 'human:alice';
const bob = 'human:bob';

// "The quick brown fox", where alice's insert "quick brown " has bob's insert "lazy " inside it.
function aliceSplitByBob() {
  return editor(
    [
      paragraph(
        text('The '),
        text('quick ', [suggestion('a', 'insert', alice)]),
        text('lazy ', [suggestion('b', 'insert', bob)]),
        text('brown', [suggestion('a', 'insert', alice)]),
        text(' fox'),
      ),
    ],
    {
      a: stored('insert', alice, { content: 'quick brown' }),
      b: stored('insert', bob, { content: 'lazy ' }),
    },
  );
}

test("rejecting an insert keeps another person's insert between its runs", () => {
  const doc = aliceSplitByBob();
  assertEqual(reject(doc.view, 'a'), true, 'the reject should apply');
  assertEqual(doc.blocks(), ['The lazy  fox'], 'the document after the reject');
  assertEqual(doc.pending(), ['b'], "bob's insert should still be pending");
});

test('rejecting an insert keeps unmarked text pasted between its runs', () => {
  const doc = editor(
    [
      paragraph(
        text('The '),
        text('quick ', [suggestion('a', 'insert', alice)]),
        text('PASTED '),
        text('brown', [suggestion('a', 'insert', alice)]),
        text(' fox'),
      ),
    ],
    { a: stored('insert', alice, { content: 'quick brown' }) },
  );
  assertEqual(reject(doc.view, 'a'), true, 'the reject should apply');
  assertEqual(doc.blocks(), ['The PASTED  fox'], 'the document after the reject');
});

test("accepting an insert with the markdown parser keeps another person's insert between its runs", () => {
  const doc = aliceSplitByBob();
  assertEqual(accept(doc.view, 'a', parseMarkdown), true, 'the accept should apply');
  assertEqual(doc.blocks(), ['The quick lazy brown fox'], 'the document after the accept');
  assertEqual(doc.pending(), ['b'], "bob's insert should still be pending");
  assertEqual(doc.authored(), ['quick ', 'brown'], 'the text credited to alice');
});

test('accepting a delete keeps unmarked text between its runs', () => {
  const doc = editor(
    [
      paragraph(
        text('The '),
        text('quick ', [suggestion('d', 'delete', alice)]),
        text('KEEP '),
        text('brown', [suggestion('d', 'delete', alice)]),
        text(' end'),
      ),
    ],
    { d: stored('delete', alice) },
  );
  assertEqual(accept(doc.view, 'd'), true, 'the accept should apply');
  assertEqual(doc.blocks(), ['The KEEP  end'], 'the document after the accept');
});

test('deleting a comment keeps another comment between its runs', () => {
  const doc = editor(
    [
      paragraph(
        text('a', [commentMark('c1', alice)]),
        text('b', [commentMark('c2', bob)]),
        text('c', [commentMark('c1', alice)]),
      ),
    ],
    {
      c1: stored('comment', alice, { text: 'outer' }),
      c2: stored('comment', bob, { text: 'inner' }),
    },
  );
  assertEqual(deleteMark(doc.view, 'c1'), true, 'the delete should apply');
  assertEqual(doc.pending(), ['c2'], "bob's comment should keep its anchor");
});

test('rejecting an insert typed across a paragraph break joins the paragraphs', () => {
  const doc = editor(
    [
      paragraph(text('Keep '), text('abc', [suggestion('a', 'insert', alice)])),
      paragraph(text('def', [suggestion('a', 'insert', alice)]), text(' tail')),
    ],
    { a: stored('insert', alice, { content: 'abc\ndef' }) },
  );
  assertEqual(reject(doc.view, 'a'), true, 'the reject should apply');
  assertEqual(doc.blocks(), ['Keep  tail'], 'the document after the reject');
});

test('rejecting an insert around a hard break removes the break with it', () => {
  const doc = editor(
    [
      paragraph(
        text('Keep '),
        text('abc', [suggestion('a', 'insert', alice)]),
        schema.nodes.hardbreak.create(),
        text('def', [suggestion('a', 'insert', alice)]),
        text(' tail'),
      ),
    ],
    { a: stored('insert', alice, { content: 'abc\ndef' }) },
  );
  assertEqual(reject(doc.view, 'a'), true, 'the reject should apply');
  assertEqual(doc.blocks(), ['Keep  tail'], 'the document after the reject');
});

console.log('\n=== Summary ===');
console.log(`Total: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
