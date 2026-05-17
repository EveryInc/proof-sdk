import { getHeadlessMilkdownParser, serializeMarkdown } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const parser = await getHeadlessMilkdownParser();

  // Canonical source: dash bullets, triple-dash thematic breaks. This is the
  // dominant style in CommonMark/GFM ecosystems (prettier, markdownlint, GitHub).
  const source = [
    '# Heading',
    '',
    'Paragraph one.',
    '',
    '- bullet one',
    '- bullet two',
    '- bullet three',
    '',
    '---',
    '',
    'Paragraph two.',
    '',
    '- nested list parent',
    '  - nested child a',
    '  - nested child b',
    '',
    '---',
    '',
    'Paragraph three.',
    '',
  ].join('\n');

  const doc = parser.parseMarkdown(source);
  const out = await serializeMarkdown(doc);

  // Style fidelity: the serializer must emit the same bullet and rule markers
  // it received. Without remark-stringify { bullet: '-', rule: '-' }, output
  // drifts to '*' bullets and '***' rules — semantically equivalent CommonMark
  // but cosmetically destructive for any workflow that round-trips real docs.
  assert(
    !out.includes('* bullet'),
    `Bullet drift: serializer emitted '*' bullets. Output was:\n${out}`,
  );
  assert(
    out.includes('- bullet one') && out.includes('- bullet two') && out.includes('- bullet three'),
    `Top-level bullets should serialize as '- '. Output was:\n${out}`,
  );
  assert(
    !out.includes('***'),
    `Thematic break drift: serializer emitted '***' rules. Output was:\n${out}`,
  );
  assert(
    out.includes('\n---\n'),
    `Thematic breaks should serialize as '---'. Output was:\n${out}`,
  );

  // Stability: serialize(parse(source)) === serialize(parse(serialize(parse(source))))
  // (the property the existing roundtrip test checks; verifying we didn't regress it).
  const reparsed = parser.parseMarkdown(out);
  const out2 = await serializeMarkdown(reparsed);
  assert(
    out === out2,
    `Serializer is not stable across round-trips. First output:\n${out}\nSecond output:\n${out2}`,
  );

  console.log('✓ headless Milkdown serializer style fidelity (bullets, thematic breaks)');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
