import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

type NormalizedIndex = {
  text: string;
  map: Array<{ start: number; end: number }>;
};

function normalizeMatchChar(ch: string): string {
  if (ch === '\u200B' || ch === '\uFEFF') return '';
  if (/\s/.test(ch)) return ' ';
  switch (ch) {
    case '\u2018':
    case '\u2019':
    case '\u201B':
    case '\u2032':
    case '\u02BC':
      return '\'';
    case '\u201C':
    case '\u201D':
    case '\u2033':
      return '"';
    case '\u2010':
    case '\u2011':
    case '\u2012':
    case '\u2013':
    case '\u2014':
    case '\u2212':
      return '-';
    default:
      return ch;
  }
}

function buildNormalizedIndex(text: string): NormalizedIndex {
  const chars: string[] = [];
  const map: Array<{ start: number; end: number }> = [];
  let lastWasSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const normalized = normalizeMatchChar(text[i]);
    if (!normalized) continue;

    if (normalized === ' ') {
      if (lastWasSpace) {
        const entry = map[map.length - 1];
        if (entry) entry.end = i;
      } else {
        chars.push(' ');
        map.push({ start: i, end: i });
        lastWasSpace = true;
      }
      continue;
    }

    chars.push(normalized);
    map.push({ start: i, end: i });
    lastWasSpace = false;
  }

  return { text: chars.join(''), map };
}

function normalizeForMatch(text: string): string {
  return buildNormalizedIndex(text).text.trim();
}

export interface TextRange {
  from: number;
  to: number;
}

export type TextIndex = {
  text: string;
  positions: Array<number | null>;
};

export const DEFAULT_BLOCK_SEPARATOR = '\n';
export const DEFAULT_LEAF_TEXT = '\n';

export function getTextForRange(
  doc: ProseMirrorNode,
  range: TextRange,
  blockSeparator: string = DEFAULT_BLOCK_SEPARATOR,
  leafText: string = DEFAULT_LEAF_TEXT
): string {
  return doc.textBetween(range.from, range.to, blockSeparator, leafText);
}

export function buildTextIndex(
  doc: ProseMirrorNode,
  range?: TextRange,
  blockSeparator: string = DEFAULT_BLOCK_SEPARATOR,
  leafText: string = DEFAULT_LEAF_TEXT
): TextIndex | null {
  const from = range?.from ?? 0;
  const to = range?.to ?? doc.content.size;
  let text = '';
  const positions: Array<number | null> = [];
  let firstBlock = true;

  doc.nodesBetween(from, to, (node, pos) => {
    let nodeText = '';
    const nodePositions: number[] = [];

    if (node.isText) {
      const sliceStart = Math.max(from, pos) - pos;
      const sliceEnd = Math.min(to, pos + node.nodeSize) - pos;
      nodeText = (node.text || '').slice(sliceStart, sliceEnd);
      for (let i = 0; i < nodeText.length; i += 1) {
        nodePositions.push(pos + sliceStart + i);
      }
    } else if (node.isLeaf) {
      if (leafText) {
        nodeText = leafText;
      } else if (node.type.spec.leafText) {
        nodeText = node.type.spec.leafText(node);
      }
      for (let i = 0; i < nodeText.length; i += 1) {
        nodePositions.push(pos);
      }
    }

    if (
      node.isBlock
      && ((node.isLeaf && nodeText) || node.isTextblock)
      && blockSeparator
    ) {
      if (firstBlock) {
        firstBlock = false;
      } else {
        text += blockSeparator;
        for (let i = 0; i < blockSeparator.length; i += 1) {
          positions.push(pos);
        }
      }
    }

    if (nodeText) {
      text += nodeText;
      positions.push(...nodePositions);
    }
  });

  const expected = doc.textBetween(from, to, blockSeparator, leafText);
  if (expected !== text) return null;

  return { text, positions };
}

function findMappedPosition(
  positions: Array<number | null>,
  index: number,
  direction: 1 | -1
): number | null {
  let i = index;
  while (i >= 0 && i < positions.length) {
    const pos = positions[i];
    if (typeof pos === 'number') return pos;
    i += direction;
  }
  return null;
}

function hasNullPositions(
  positions: Array<number | null>,
  from: number,
  to: number
): boolean {
  const start = Math.max(0, from);
  const end = Math.min(positions.length, to);
  for (let i = start; i < end; i += 1) {
    if (positions[i] === null) return true;
  }
  return false;
}

export function resolveQuoteRange(
  doc: ProseMirrorNode,
  quote: string,
  scope?: TextRange | null,
  blockSeparator: string = DEFAULT_BLOCK_SEPARATOR,
  leafText: string = DEFAULT_LEAF_TEXT
): TextRange | null {
  const normalizedQuote = normalizeForMatch(quote);
  if (!normalizedQuote) return null;

  const index = buildTextIndex(doc, scope ?? undefined, blockSeparator, leafText);
  if (!index) return null;

  const exactIndex = index.text.indexOf(quote);
  if (exactIndex !== -1) {
    const secondExact = index.text.indexOf(quote, exactIndex + quote.length);
    if (secondExact !== -1) return null;
    const exactRange = mapTextOffsetsToRange(index, exactIndex, exactIndex + quote.length);
    if (exactRange) return exactRange;
  }

  const normalizedIndex = buildNormalizedIndex(index.text);
  const normalizedDoc = normalizedIndex.text;
  const firstIndex = normalizedDoc.indexOf(normalizedQuote);
  if (firstIndex === -1) return null;
  const secondIndex = normalizedDoc.indexOf(normalizedQuote, firstIndex + normalizedQuote.length);
  if (secondIndex !== -1) return null;

  const start = normalizedIndex.map[firstIndex]?.start;
  const endIndex = firstIndex + normalizedQuote.length - 1;
  const end = normalizedIndex.map[endIndex]?.end;
  if (start === undefined || end === undefined) return null;

  const range = mapTextOffsetsToRange(index, start, end + 1);
  if (!range) return null;
  const actualText = getTextForRange(doc, range, blockSeparator, leafText);
  if (normalizeForMatch(actualText) !== normalizedQuote) return null;
  if (scope && (range.from < scope.from || range.to > scope.to)) return null;

  return range;
}

export function resolvePatternRange(
  doc: ProseMirrorNode,
  pattern: string,
  scope?: TextRange | null,
  blockSeparator: string = DEFAULT_BLOCK_SEPARATOR,
  leafText: string = DEFAULT_LEAF_TEXT
): TextRange | null {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return null;
  }

  const index = buildTextIndex(doc, scope ?? undefined, blockSeparator, leafText);
  if (!index) return null;

  const match = regex.exec(index.text);
  if (!match) return null;

  const from = match.index;
  const to = match.index + match[0].length;
  if (hasNullPositions(index.positions, from, to)) return null;

  const startPos = findMappedPosition(index.positions, from, 1);
  const endPos = findMappedPosition(index.positions, to - 1, -1);
  if (startPos === null || endPos === null || startPos > endPos) return null;

  const range = { from: startPos, to: endPos + 1 };
  if (scope && (range.from < scope.from || range.to > scope.to)) return null;

  return range;
}

export function mapTextOffsetsToRange(
  index: TextIndex,
  from: number,
  to: number
): TextRange | null {
  if (from < 0 || to <= from || from >= index.positions.length) return null;
  if (hasNullPositions(index.positions, from, to)) return null;

  const startPos = findMappedPosition(index.positions, from, 1);
  const endPos = findMappedPosition(index.positions, to - 1, -1);
  if (startPos === null || endPos === null || startPos > endPos) return null;

  return { from: startPos, to: endPos + 1 };
}
