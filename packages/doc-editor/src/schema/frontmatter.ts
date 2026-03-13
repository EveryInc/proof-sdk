/**
 * Frontmatter Schema
 *
 * Adds YAML frontmatter support so it round-trips without being rewritten
 * as a horizontal rule + paragraphs.
 */

import { $nodeSchema } from '@milkdown/kit/utils';

type FrontmatterAstNode = {
  type: string;
  value?: string;
};

const FRONTMATTER_START = '---';
const FRONTMATTER_END = '---';
const FRONTMATTER_ALT_END = '...';

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function stripFrontmatterDelimiters(text: string): string {
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split('\n');

  if (lines.length < 2) return normalized;

  let startIndex = 0;
  while (startIndex < lines.length && lines[startIndex].trim() === '') {
    startIndex += 1;
  }
  if (startIndex >= lines.length) return normalized;

  if (lines[startIndex].trim() !== FRONTMATTER_START) return normalized;

  let endIndex = lines.length - 1;
  while (endIndex > startIndex && lines[endIndex].trim() === '') {
    endIndex -= 1;
  }

  const endMarker = lines[endIndex].trim();
  if (endMarker !== FRONTMATTER_END && endMarker !== FRONTMATTER_ALT_END) return normalized;

  return lines.slice(startIndex + 1, endIndex).join('\n');
}

export function wrapFrontmatterValue(value: string): string {
  const normalized = normalizeLineEndings(value);
  const stripped = stripFrontmatterDelimiters(normalized);

  if (stripped !== normalized) {
    return normalized;
  }

  if (!normalized) {
    return `${FRONTMATTER_START}\n${FRONTMATTER_END}`;
  }

  return `${FRONTMATTER_START}\n${normalized}\n${FRONTMATTER_END}`;
}

export const frontmatterSchema = $nodeSchema('frontmatter', () => ({
  group: 'block',
  content: 'text*',
  marks: '',
  defining: true,
  code: true,
  isolating: true,
  parseDOM: [
    {
      tag: 'pre[data-frontmatter]',
      preserveWhitespace: 'full',
    },
  ],
  toDOM: () => ['pre', { 'data-frontmatter': 'true' }, ['code', 0]],
  parseMarkdown: {
    match: (node) => (node as FrontmatterAstNode).type === 'yaml',
    runner: (state, node, type) => {
      const value = (node as FrontmatterAstNode).value ?? '';
      state.openNode(type);
      state.addText(wrapFrontmatterValue(value));
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'frontmatter',
    runner: (state, node) => {
      const value = stripFrontmatterDelimiters(node.textContent);
      state.addNode('yaml', undefined, value);
    },
  },
}));

