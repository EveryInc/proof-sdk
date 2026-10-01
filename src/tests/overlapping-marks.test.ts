/**
 * Regression: two people's comments (or suggestions) may cover the same text.
 *
 * `proofComment` and `proofSuggestion` used ProseMirror's default `excludes`, under which a mark
 * excludes its own type. Commenting on text another person's comment covered therefore cut that
 * comment out of the overlap: `addMark` removes every mark the new one excludes before adding it,
 * so Bob's comment on "quick brown" became a comment on "quick " once Alice commented on "brown",
 * and his quote changed with it. With `excludes: ''` both marks stay, so every path that removes
 * one of them has to remove that mark, not every mark of its type over its text, and the markdown
 * parser has to close the span it is closing, not every open span of the type.
 */

import type { Mark as ProseMirrorMark, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { EditorState, Plugin, type Transaction } from '@milkdown/kit/prose/state';
import { getHeadlessMilkdownParser, serializeMarkdown } from '../../server/milkdown-headless.js';
import {
  accept,
  comment,
  deleteMark,
  getMarks,
  marksPluginKey,
  reject,
  rejectAll,
  type StoredMark,
} from '../editor/plugins/marks.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
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

const suggestion = (id: string, kind: 'insert' | 'delete' | 'replace', by: string) =>
  schema.marks.proofSuggestion.create({ id, kind, by });
const commentMark = (id: string, by: string) => schema.marks.proofComment.create({ id, by });
const text = (value: string, marks: readonly ProseMirrorMark[] = []) => schema.text(value, marks);
const paragraph = (...content: ProseMirrorNode[]) => schema.node('paragraph', null, content);

function stored(kind: StoredMark['kind'], by: string, extra: Partial<StoredMark> = {}): StoredMark {
  return { kind, by, createdAt, status: 'pending', ...extra } as StoredMark;
}

/** The text a mark covers, its runs joined in document order. */
function covered(doc: ProseMirrorNode, typeName: string, id: string): string {
  let out = '';
  doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === typeName && mark.attrs.id === id)) {
      out += node.text;
    }
    return true;
  });
  return out;
}

function editor(content: ProseMirrorNode[], metadata: Record<string, StoredMark> = {}) {
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
  let state = EditorState.create({ schema, doc: schema.node('doc', null, [paragraph(...content)]), plugins: [plugin] });
  const transactions: Transaction[] = [];
  return {
    view: {
      get state() {
        return state;
      },
      dispatch(tr: Transaction) {
        transactions.push(tr);
        state = state.apply(tr);
      },
    } as never,
    transactions,
    doc: () => state.doc,
    pending: () => getMarks(state).filter((mark) => mark.kind !== 'authored').map((mark) => mark.id).sort(),
  };
}

const alice = 'human:alice';
const bob = 'human:bob';

// "The quick brown fox": "quick brown" is 5..16 and "brown" 11..16, the paragraph opening at 0.
function bobThenAliceComment() {
  const doc = editor([text('The quick brown fox')]);
  const bobMark = comment(doc.view, 'quick brown', bob, 'Bob', { from: 5, to: 16 });
  const aliceMark = comment(doc.view, 'brown', alice, 'Alice', { from: 11, to: 16 });
  return { ...doc, bobId: bobMark.id, aliceId: aliceMark.id };
}

// "The quick lazy brown fox", Bob's suggestion over "quick lazy brown" and Alice's over "lazy ".
function aliceInsideBob(kind: 'insert' | 'delete' | 'replace') {
  return editor(
    [
      text('The '),
      text('quick ', [suggestion('b', kind, bob)]),
      text('lazy ', [suggestion('b', kind, bob), suggestion('a', kind, alice)]),
      text('brown', [suggestion('b', kind, bob)]),
      text(' fox'),
    ],
    {
      b: stored(kind, bob, { content: 'quick lazy brown' }),
      a: stored(kind, alice, { content: 'lazy ' }),
    },
  );
}

await test('comments and suggestions do not exclude their own type; the other proof marks still do', () => {
  const { proofComment, proofSuggestion, proofFlagged, proofApproved, proofAuthored } = schema.marks;
  assertEqual(proofComment.excludes(proofComment), false, 'proofComment excludes proofComment');
  assertEqual(proofSuggestion.excludes(proofSuggestion), false, 'proofSuggestion excludes proofSuggestion');
  assertEqual(proofFlagged.excludes(proofFlagged), true, 'proofFlagged excludes proofFlagged');
  assertEqual(proofApproved.excludes(proofApproved), true, 'proofApproved excludes proofApproved');
  assertEqual(proofAuthored.excludes(proofAuthored), true, 'proofAuthored excludes proofAuthored');
});

await test("commenting on text another comment covers leaves that comment whole", () => {
  const doc = bobThenAliceComment();
  assertEqual(covered(doc.doc(), 'proofComment', doc.bobId), 'quick brown', "Bob's comment");
  assertEqual(covered(doc.doc(), 'proofComment', doc.aliceId), 'brown', "Alice's comment");
  const steps = doc.transactions[1]?.steps.map((step) => step.toJSON().stepType);
  assertEqual(steps?.includes('removeMark'), false, "Alice's comment removes a mark");
});

await test('deleting one of two overlapping comments leaves the other whole', () => {
  const first = bobThenAliceComment();
  assertEqual(deleteMark(first.view, first.aliceId), true, "deleting Alice's comment applies");
  assertEqual(covered(first.doc(), 'proofComment', first.aliceId), '', "Alice's comment after its delete");
  assertEqual(covered(first.doc(), 'proofComment', first.bobId), 'quick brown', "Bob's comment after Alice's delete");

  const second = bobThenAliceComment();
  assertEqual(deleteMark(second.view, second.bobId), true, "deleting Bob's comment applies");
  assertEqual(covered(second.doc(), 'proofComment', second.bobId), '', "Bob's comment after its delete");
  assertEqual(covered(second.doc(), 'proofComment', second.aliceId), 'brown', "Alice's comment after Bob's delete");
});

await test("accepting an insert inside another person's insert keeps that insert pending on all its text", () => {
  const doc = aliceInsideBob('insert');
  assertEqual(accept(doc.view, 'a'), true, "accepting Alice's insert applies");
  assertEqual(doc.pending(), ['b'], 'pending after the accept');
  assertEqual(covered(doc.doc(), 'proofSuggestion', 'b'), 'quick lazy brown', "Bob's insert after the accept");
});

await test("rejecting a delete inside another person's delete keeps that delete on all its text", () => {
  const doc = aliceInsideBob('delete');
  assertEqual(reject(doc.view, 'a'), true, "rejecting Alice's delete applies");
  assertEqual(doc.pending(), ['b'], 'pending after the reject');
  assertEqual(covered(doc.doc(), 'proofSuggestion', 'b'), 'quick lazy brown', "Bob's delete after the reject");
  assertEqual(covered(doc.doc(), 'proofSuggestion', 'a'), '', "Alice's delete after the reject");
});

await test("rejecting a replace inside another person's replace keeps that replace on all its text", () => {
  const doc = aliceInsideBob('replace');
  assertEqual(reject(doc.view, 'a'), true, "rejecting Alice's replace applies");
  assertEqual(doc.pending(), ['b'], 'pending after the reject');
  assertEqual(covered(doc.doc(), 'proofSuggestion', 'b'), 'quick lazy brown', "Bob's replace after the reject");
});

await test('rejecting every suggestion removes both overlapping marks and leaves a comment over them', () => {
  const doc = editor(
    [
      text('The '),
      text('quick ', [suggestion('b', 'delete', bob)]),
      text('lazy ', [suggestion('b', 'delete', bob), suggestion('a', 'delete', alice), commentMark('c', alice)]),
      text('brown', [suggestion('b', 'delete', bob), commentMark('c', alice)]),
      text(' fox'),
    ],
    { b: stored('delete', bob), a: stored('delete', alice), c: stored('comment', alice, { text: 'Note' }) },
  );
  assertEqual(rejectAll(doc.view), 2, 'suggestions rejected');
  assertEqual(doc.doc().textContent, 'The quick lazy brown fox', 'the text after rejecting every delete');
  assertEqual(covered(doc.doc(), 'proofSuggestion', 'b'), '', "Bob's delete after rejectAll");
  assertEqual(covered(doc.doc(), 'proofSuggestion', 'a'), '', "Alice's delete after rejectAll");
  assertEqual(covered(doc.doc(), 'proofComment', 'c'), 'lazy brown', 'the comment after rejectAll');
});

for (const [shape, runs] of [
  ['the inner comment at the start of the outer one', [
    text('The '),
    text('quick', [commentMark('b', bob), commentMark('a', alice)]),
    text(' brown', [commentMark('b', bob)]),
    text(' fox'),
  ]],
  ['the inner comment inside the outer one', [
    text('The '),
    text('quick ', [commentMark('b', bob)]),
    text('brown', [commentMark('b', bob), commentMark('a', alice)]),
    text(' fox', [commentMark('b', bob)]),
  ]],
  ['the inner comment at the end of the outer one', [
    text('The '),
    text('quick ', [commentMark('b', bob)]),
    text('brown', [commentMark('b', bob), commentMark('a', alice)]),
    text(' fox'),
  ]],
  // The serializer writes a space at a mark's edge outside the span, for any one mark, so the
  // crossing run starts with a hyphen.
  ['two crossing comments', [
    text('The '),
    text('quick ', [commentMark('b', bob)]),
    text('brown', [commentMark('b', bob), commentMark('a', alice)]),
    text('-fox', [commentMark('a', alice)]),
  ]],
] as const) {
  await test(`markdown keeps both comments with ${shape}`, async () => {
    const doc = schema.node('doc', null, [paragraph(...runs)]);
    const markdown = await serializeMarkdown(doc);
    const parsed = parseMarkdown(markdown);
    for (const id of ['b', 'a']) {
      assertEqual(covered(parsed, 'proofComment', id), covered(doc, 'proofComment', id), `comment ${id} after ${JSON.stringify(markdown.trim())}`);
    }
  });
}

console.log('\n=== Summary ===');
console.log(`Total: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
