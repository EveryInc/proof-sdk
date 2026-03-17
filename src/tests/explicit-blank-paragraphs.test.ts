import { Schema } from '@milkdown/kit/prose/model';
import {
  __unsafeGetExplicitBlankParagraphPlaceholderForTests,
  prepareMarkdownForEditorLoad,
  restoreStandaloneBlankParagraphLines,
  restoreExplicitBlankParagraphPlaceholders,
} from '../editor/explicit-blank-paragraphs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        content: 'text*',
        group: 'block',
      },
      text: {
        group: 'inline',
      },
    },
  });

  const source = 'Sup dude!\n\n<br />\n\nDoes this work? Seems to!\n';
  const prepared = prepareMarkdownForEditorLoad(source);
  const placeholder = __unsafeGetExplicitBlankParagraphPlaceholderForTests();

  assert(
    prepared === `Sup dude!\n\n${placeholder}\n\nDoes this work? Seems to!\n`,
    `Expected standalone <br /> lines to be replaced before parse, got ${JSON.stringify(prepared)}`,
  );

  const parsedLikeDoc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('Sup dude!')),
    schema.node('paragraph', null, schema.text(placeholder)),
    schema.node('paragraph', null, schema.text('Does this work? Seems to!')),
  ]);

  const restored = restoreExplicitBlankParagraphPlaceholders(parsedLikeDoc, schema);
  const paragraphTexts: string[] = [];

  restored.forEach((node) => {
    if (node.type.name === 'paragraph') {
      paragraphTexts.push(node.textContent);
    }
  });

  assert(paragraphTexts.length === 3, `Expected three paragraphs after restore, got ${paragraphTexts.length}`);
  assert(paragraphTexts[0] === 'Sup dude!', 'Expected first paragraph text to survive');
  assert(paragraphTexts[1] === '', 'Expected placeholder paragraph to become an explicit blank paragraph');
  assert(paragraphTexts[2] === 'Does this work? Seems to!', 'Expected final paragraph text to survive');

  const legacyLiteral = 'PROOFEMPTYPARAGRAPHPLACEHOLDER';
  const userTypedDoc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text(legacyLiteral)),
  ]);
  const userTypedRestored = restoreExplicitBlankParagraphPlaceholders(userTypedDoc, schema);
  const userTypedParagraph = userTypedRestored.firstChild;
  assert(userTypedParagraph?.textContent === legacyLiteral, 'Expected ordinary user text to survive placeholder restoration');

  const fencedSource = ['```md', '<br />', '```', '', '<br />', ''].join('\n');
  const fencedPrepared = prepareMarkdownForEditorLoad(fencedSource);
  assert(
    fencedPrepared.startsWith('```md\n<br />\n```'),
    `Expected literal <br /> inside fenced code to survive preparation, got ${JSON.stringify(fencedPrepared)}`,
  );
  assert(
    fencedPrepared.endsWith(`\n\n${placeholder}\n`),
    `Expected standalone <br /> outside fenced code to remain recoverable, got ${JSON.stringify(fencedPrepared)}`,
  );

  const restoredBlankParagraphs = restoreStandaloneBlankParagraphLines('Alpha\n\n\nBeta\n');
  assert(
    restoredBlankParagraphs === 'Alpha\n\n<br />\n\nBeta\n',
    `Expected newline runs outside fences to restore explicit blank paragraphs, got ${JSON.stringify(restoredBlankParagraphs)}`,
  );

  const fencedBlankParagraphs = restoreStandaloneBlankParagraphLines(['```md', 'line one', '', '', 'line two', '```', '', '', 'Tail'].join('\n'));
  assert(
    fencedBlankParagraphs === ['```md', 'line one', '', '', 'line two', '```', '', '<br />', '', 'Tail'].join('\n'),
    `Expected newline runs inside fenced code to stay literal while outside-fence blank paragraphs remain recoverable, got ${JSON.stringify(fencedBlankParagraphs)}`,
  );

  console.log('✓ explicit blank paragraph helpers preserve standalone blank paragraph structure');
}

run();
