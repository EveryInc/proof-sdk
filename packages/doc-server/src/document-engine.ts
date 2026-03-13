import { randomUUID } from 'crypto';
import {
  addDocumentEvent,
  bumpDocumentAccessEpoch,
  getDocumentBySlug,
  removeResurrectedMarksFromPayload,
  rebuildDocumentBlocks,
  shouldRejectMarkMutationByResolvedRevision,
  upsertMarkTombstone,
  updateDocumentAtomic,
  updateMarks,
} from './db.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import {
  applyCanonicalDocumentToCollab,
  getCanonicalReadableDocumentSync,
  invalidateCollabDocument,
  isCanonicalReadMutationReady,
  type CanonicalReadableDocument,
} from './collab-shared.js';
import { mutateCanonicalDocument } from './canonical-document-shared.js';
import { canonicalizeStoredMarks } from '@proof/core/marks';
import {
  finalizeSuggestionThroughRehydration,
  type ProofMarkRehydrationFailure,
} from './proof-mark-rehydration.js';

type JsonRecord = Record<string, unknown>;

type StoredMark = {
  kind?: string;
  by?: string;
  createdAt?: string;
  range?: { from: number; to: number };
  quote?: string;
  text?: string;
  thread?: unknown;
  threadId?: string;
  replies?: Array<{ by: string; text: string; at: string }>;
  resolved?: boolean;
  content?: string;
  status?: 'pending' | 'accepted' | 'rejected';
  startRel?: string;
  endRel?: string;
  [key: string]: unknown;
};

export interface EngineExecutionResult {
  status: number;
  body: JsonRecord;
}

export type AsyncDocumentMutationContext = {
  doc: CanonicalReadableDocument;
};

function getCanonicalReadableDocument(slug: string) {
  return getCanonicalReadableDocumentSync(slug, 'state') ?? getDocumentBySlug(slug);
}

function getMutationReadyDocument(
  slug: string,
  context?: AsyncDocumentMutationContext,
):
  | { doc: NonNullable<ReturnType<typeof getCanonicalReadableDocument>>; error: null }
  | { doc: null; error: EngineExecutionResult } {
  const doc = context?.doc ?? getCanonicalReadableDocument(slug);
  if (!doc) {
    return { doc: null, error: { status: 404, body: { success: false, error: 'Document not found' } } };
  }
  if (!isCanonicalReadMutationReady(doc)) {
    return { doc: null, error: projectionStaleMutationResult() };
  }
  return { doc, error: null };
}

function projectionStaleMutationResult(): EngineExecutionResult {
  return {
    status: 409,
    body: {
      success: false,
      code: 'PROJECTION_STALE',
      error: 'Document projection is stale; retry after repair completes',
    },
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMarks(raw: string): Record<string, StoredMark> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? canonicalizeStoredMarks(parsed as Record<string, StoredMark>) : {};
  } catch {
    return {};
  }
}

function normalizeQuote(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function stripMarkdownFormatting(markdown: string): string {
  let text = markdown ?? '';

  // Replace block-level tags with spaces, then remove remaining tags.
  text = text.replace(/<\/?(?:p|br|div|li)\b[^>]*>/gi, ' ');
  text = text.replace(/<[^>]+>/g, '');

  // Convert images/links to their visible text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

  // Strip fenced code blocks but keep inner text.
  text = text.replace(/```([\s\S]*?)```/g, '$1');
  text = text.replace(/~~~([\s\S]*?)~~~/g, '$1');

  // Strip inline code markers.
  text = text.replace(/`([^`]+)`/g, '$1');

  // Strip common emphasis/strike markers.
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/(?<!\w)___([^_]+)___(?!\w)/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(?<!\w)__([^_]+)__(?!\w)/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // Remove markdown line prefixes (headings, lists, blockquotes).
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');
  text = text.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '');
  text = text.replace(/^[ \t]*\[(?: |x|X)\][ \t]+/gm, '');
  text = text.replace(/^[ \t]*([-*_]){3,}[ \t]*$/gm, '');

  // Unescape markdown escapes.
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');

  return text;
}

function stripMarkdownWithMapping(markdown: string): { stripped: string; map: number[] } {
  const source = markdown ?? '';
  const strippedChars: string[] = [];
  const map: number[] = [];

  const pushChar = (ch: string, srcIdx: number): void => {
    strippedChars.push(ch);
    map.push(srcIdx);
  };

  const emitSpan = (start: number, end: number): void => {
    for (let idx = start; idx < end; idx += 1) {
      pushChar(source[idx], idx);
    }
  };

  const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

  // Bounded indexOf to prevent O(n²) on pathological input (e.g. 10k unmatched '[').
  // Set to 50k to handle large fenced code blocks while still bounding adversarial input.
  // This is a fallback path — primary quote matching uses exact substring search.
  const MAX_DELIMITER_SEARCH = 50_000;
  const boundedIndexOf = (needle: string, from: number): number => {
    const limit = Math.min(source.length, from + MAX_DELIMITER_SEARCH);
    const idx = source.slice(from, limit).indexOf(needle);
    return idx !== -1 ? from + idx : -1;
  };

  let i = 0;
  while (i < source.length) {
    // Line-level stripping (headings, lists, blockquotes, task lists, HR)
    if (i === 0 || source[i - 1] === '\n') {
      const lineEndIdx = source.indexOf('\n', i);
      const lineEnd = lineEndIdx === -1 ? source.length : lineEndIdx;
      const lineSlice = source.slice(i, lineEnd);
      if (/^[ \t]*([-*_]){3,}[ \t]*$/.test(lineSlice)) {
        i = lineEnd;
        continue;
      }

      let cursor = i;

      // Blockquote prefix
      let j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      if (j < lineEnd && source[j] === '>') {
        j += 1;
        if (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
        cursor = j;
      }

      // Heading prefix
      j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      let hashCount = 0;
      while (j < lineEnd && source[j] === '#' && hashCount < 6) {
        hashCount += 1;
        j += 1;
      }
      if (hashCount > 0 && j < lineEnd && (source[j] === ' ' || source[j] === '\t')) {
        while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
        cursor = j;
      }

      // List prefix
      j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      let listMatched = false;
      if (j < lineEnd && (source[j] === '-' || source[j] === '*' || source[j] === '+')) {
        j += 1;
        listMatched = true;
      } else if (j < lineEnd && /[0-9]/.test(source[j])) {
        let k = j;
        while (k < lineEnd && /[0-9]/.test(source[k])) k += 1;
        if (k < lineEnd && source[k] === '.') {
          j = k + 1;
          listMatched = true;
        }
      }
      if (listMatched && j < lineEnd && (source[j] === ' ' || source[j] === '\t')) {
        while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
        cursor = j;
      }

      // Task list prefix
      j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      if (
        j + 2 < lineEnd
        && source[j] === '['
        && (source[j + 1] === ' ' || source[j + 1] === 'x' || source[j + 1] === 'X')
        && source[j + 2] === ']'
      ) {
        j += 3;
        if (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) {
          while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
          cursor = j;
        }
      }

      if (cursor !== i) {
        i = cursor;
        continue;
      }
    }

    // HTML tag handling (only check when we see '<' to keep the loop O(n))
    if (source[i] === '<') {
      // Block-level HTML tags become a space.
      const blockTagMatch = source.slice(i).match(/^<\/?(?:p|br|div|li)\b[^>]*>/i);
      if (blockTagMatch) {
        const matchLen = blockTagMatch[0].length;
        const closingIdx = i + matchLen - 1;
        pushChar(' ', closingIdx);
        i += matchLen;
        continue;
      }

      // Remove remaining HTML tags.
      const anyTagMatch = source.slice(i).match(/^<[^>]+>/);
      if (anyTagMatch) {
        i += anyTagMatch[0].length;
        continue;
      }
    }

    // Images: ![alt](url)
    if (source[i] === '!' && source[i + 1] === '[') {
      const closeBracket = boundedIndexOf(']', i + 2);
      if (closeBracket !== -1 && source[closeBracket + 1] === '(') {
        const closeParen = boundedIndexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          emitSpan(i + 2, closeBracket);
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Links: [text](url) or [text][ref]
    if (source[i] === '[') {
      const closeBracket = boundedIndexOf(']', i + 1);
      if (closeBracket !== -1 && closeBracket > i + 1) {
        const nextChar = source[closeBracket + 1];
        if (nextChar === '(') {
          const closeParen = boundedIndexOf(')', closeBracket + 2);
          if (closeParen !== -1) {
            emitSpan(i + 1, closeBracket);
            i = closeParen + 1;
            continue;
          }
        } else if (nextChar === '[') {
          const closeRef = boundedIndexOf(']', closeBracket + 2);
          if (closeRef !== -1) {
            emitSpan(i + 1, closeBracket);
            i = closeRef + 1;
            continue;
          }
        }
      }
    }

    // Fenced code blocks
    if (source.startsWith('```', i) || source.startsWith('~~~', i)) {
      const fence = source.startsWith('```', i) ? '```' : '~~~';
      const closeIdx = boundedIndexOf(fence, i + fence.length);
      if (closeIdx !== -1) {
        emitSpan(i + fence.length, closeIdx);
        i = closeIdx + fence.length;
        continue;
      }
    }

    // Inline code markers
    if (source[i] === '`') {
      const closeIdx = boundedIndexOf('`', i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        emitSpan(i + 1, closeIdx);
        i = closeIdx + 1;
        continue;
      }
    }

    // Emphasis/strike markers
    if (source.startsWith('***', i)) {
      const closeIdx = boundedIndexOf('***', i + 3);
      if (closeIdx !== -1 && !source.slice(i + 3, closeIdx).includes('*')) {
        emitSpan(i + 3, closeIdx);
        i = closeIdx + 3;
        continue;
      }
    }
    if (source.startsWith('___', i)) {
      const prev = i > 0 ? source[i - 1] : '';
      const closeIdx = boundedIndexOf('___', i + 3);
      const next = closeIdx !== -1 ? source[closeIdx + 3] : '';
      if (
        closeIdx !== -1
        && !isWordChar(prev)
        && !isWordChar(next)
        && !source.slice(i + 3, closeIdx).includes('_')
      ) {
        emitSpan(i + 3, closeIdx);
        i = closeIdx + 3;
        continue;
      }
    }
    if (source.startsWith('**', i)) {
      const closeIdx = boundedIndexOf('**', i + 2);
      if (closeIdx !== -1 && !source.slice(i + 2, closeIdx).includes('*')) {
        emitSpan(i + 2, closeIdx);
        i = closeIdx + 2;
        continue;
      }
    }
    if (source.startsWith('__', i)) {
      const prev = i > 0 ? source[i - 1] : '';
      const closeIdx = boundedIndexOf('__', i + 2);
      const next = closeIdx !== -1 ? source[closeIdx + 2] : '';
      if (
        closeIdx !== -1
        && !isWordChar(prev)
        && !isWordChar(next)
        && !source.slice(i + 2, closeIdx).includes('_')
      ) {
        emitSpan(i + 2, closeIdx);
        i = closeIdx + 2;
        continue;
      }
    }
    if (source.startsWith('~~', i)) {
      const closeIdx = boundedIndexOf('~~', i + 2);
      if (closeIdx !== -1 && !source.slice(i + 2, closeIdx).includes('~')) {
        emitSpan(i + 2, closeIdx);
        i = closeIdx + 2;
        continue;
      }
    }
    if (source[i] === '*') {
      const closeIdx = boundedIndexOf('*', i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1 && !source.slice(i + 1, closeIdx).includes('*')) {
        emitSpan(i + 1, closeIdx);
        i = closeIdx + 1;
        continue;
      }
    }
    if (source[i] === '_') {
      const prev = i > 0 ? source[i - 1] : '';
      const closeIdx = boundedIndexOf('_', i + 1);
      const next = closeIdx !== -1 ? source[closeIdx + 1] : '';
      if (
        closeIdx !== -1
        && closeIdx > i + 1
        && !isWordChar(prev)
        && !isWordChar(next)
        && !source.slice(i + 1, closeIdx).includes('_')
      ) {
        emitSpan(i + 1, closeIdx);
        i = closeIdx + 1;
        continue;
      }
    }

    // Unescape markdown escapes.
    if (source[i] === '\\' && i + 1 < source.length) {
      const nextChar = source[i + 1];
      if (/^[\\`*_{}\[\]()#+\-.!]$/.test(nextChar)) {
        pushChar(nextChar, i + 1);
        i += 2;
        continue;
      }
    }

    pushChar(source[i], i);
    i += 1;
  }

  return { stripped: strippedChars.join(''), map };
}

function normalizeMarkdownForQuote(markdown: string): string {
  return normalizeQuote(stripMarkdownFormatting(markdown));
}

function expandMarkdownSpan(markdown: string, start: number, end: number): { start: number; end: number } {
  const pairs = [
    { open: '***', close: '***' },
    { open: '___', close: '___' },
    { open: '**', close: '**' },
    { open: '__', close: '__' },
    { open: '~~', close: '~~' },
    { open: '*', close: '*' },
    { open: '_', close: '_' },
    { open: '`', close: '`' },
  ];
  let expandedStart = start;
  let expandedEnd = end;
  const linePrefixLength = (lineText: string): number => {
    let idx = 0;
    while (idx < lineText.length && (lineText[idx] === ' ' || lineText[idx] === '\t')) idx += 1;
    let hasPrefix = false;
    while (idx < lineText.length && lineText[idx] === '>') {
      idx += 1;
      if (lineText[idx] === ' ' || lineText[idx] === '\t') idx += 1;
      hasPrefix = true;
    }

    const headingMatch = lineText.slice(idx).match(/^#{1,6}[ \t]+/);
    if (headingMatch) return idx + headingMatch[0].length;

    const listMatch = lineText.slice(idx).match(/^(?:[-*+]|\d+\.)[ \t]+/);
    if (listMatch) {
      idx += listMatch[0].length;
      const taskMatch = lineText.slice(idx).match(/^\[(?: |x|X)\][ \t]+/);
      if (taskMatch) idx += taskMatch[0].length;
      return idx;
    }

    return hasPrefix ? idx : 0;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of pairs) {
      const openStart = expandedStart - pair.open.length;
      const closeEnd = expandedEnd + pair.close.length;
      if (openStart < 0 || closeEnd > markdown.length) continue;
      if (markdown.slice(openStart, expandedStart) !== pair.open) continue;
      if (markdown.slice(expandedEnd, closeEnd) !== pair.close) continue;
      expandedStart = openStart;
      expandedEnd = closeEnd;
      changed = true;
      break;
    }
  }

  const htmlTagLookahead = 30;
  const htmlTagLookbehind = 50;
  changed = true;
  while (changed) {
    changed = false;
    const afterSlice = markdown.slice(expandedEnd, expandedEnd + htmlTagLookahead);
    const closeMatch = afterSlice.match(/^<\/([a-zA-Z][a-zA-Z0-9]*)>/);
    if (closeMatch) {
      const tagName = closeMatch[1];
      const beforeSlice = markdown.slice(Math.max(0, expandedStart - htmlTagLookbehind), expandedStart);
      const openPattern = new RegExp(`<${tagName}\\b[^>]*>$`);
      const openMatch = beforeSlice.match(openPattern);
      if (openMatch) {
        expandedStart -= openMatch[0].length;
        expandedEnd += closeMatch[0].length;
        changed = true;
      }
    }
  }

  const beforeChar = expandedStart > 0 ? markdown[expandedStart - 1] : '';
  const beforeChar2 = expandedStart > 1 ? markdown[expandedStart - 2] : '';
  if (beforeChar === '[') {
    const afterSlice = markdown.slice(expandedEnd);
    const linkClose = afterSlice.match(/^\]\([^)]*\)/);
    const refClose = afterSlice.match(/^\]\[[^\]]*\]/);
    if (linkClose) {
      const imgPrefix = beforeChar2 === '!' ? 2 : 1;
      expandedStart -= imgPrefix;
      expandedEnd += linkClose[0].length;
    } else if (refClose) {
      const imgPrefix = beforeChar2 === '!' ? 2 : 1;
      expandedStart -= imgPrefix;
      expandedEnd += refClose[0].length;
    }
  }

  const lineStart = markdown.lastIndexOf('\n', expandedStart - 1) + 1;
  const lineEndIdx = markdown.indexOf('\n', expandedEnd);
  const lineEnd = lineEndIdx === -1 ? markdown.length : lineEndIdx;
  if (expandedEnd === lineEnd) {
    const lineText = markdown.slice(lineStart, lineEnd);
    const prefixLen = linePrefixLength(lineText);
    if (prefixLen > 0 && expandedStart === lineStart + prefixLen) {
      expandedStart = lineStart;
    }
  }

  return { start: expandedStart, end: expandedEnd };
}

type QuoteAnchor = {
  rawStart: number;
  rawEnd: number;
  strippedStart: number;
  strippedEnd: number;
};

function findQuoteAnchorInMarkdown(markdown: string, quote: string): QuoteAnchor | null {
  if (!quote) return null;
  const { stripped, map } = stripMarkdownWithMapping(markdown);
  const hasDegenerateMap = (start: number, endInclusive: number): boolean => {
    for (let i = start; i < endInclusive; i += 1) {
      if (map[i] >= map[i + 1]) return true;
    }
    return false;
  };

  // First try direct match on stripped text
  let idx = stripped.indexOf(quote);

  // If not found, try with whitespace-normalized stripped text
  // (quotes are stored normalized via normalizeQuote which collapses whitespace)
  if (idx < 0) {
    const normalizedStripped = stripped.replace(/\s+/g, ' ').trim();
    const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
    const normIdx = normalizedStripped.indexOf(normalizedQuote);
    if (normIdx < 0) return null;

    // Map the normalized position back to the original stripped position.
    // Walk through stripped text counting non-collapsed characters to find
    // the original index corresponding to normIdx.
    let origIdx = 0;
    let normPos = 0;
    // Skip leading whitespace that was trimmed
    while (origIdx < stripped.length && /\s/.test(stripped[origIdx])) origIdx++;
    while (origIdx < stripped.length && normPos < normIdx) {
      origIdx++;
      // Skip extra whitespace (collapsed to single space in normalized)
      if (/\s/.test(stripped[origIdx - 1])) {
        while (origIdx < stripped.length && /\s/.test(stripped[origIdx])) origIdx++;
      }
      normPos++;
    }
    idx = origIdx;
    // Compute end in original stripped text
    let endOrigIdx = idx;
    let normLen = 0;
    while (endOrigIdx < stripped.length && normLen < normalizedQuote.length) {
      endOrigIdx++;
      if (/\s/.test(stripped[endOrigIdx - 1])) {
        while (endOrigIdx < stripped.length && /\s/.test(stripped[endOrigIdx])) endOrigIdx++;
      }
      normLen++;
    }
    if (endOrigIdx - 1 >= map.length) return null;
    if (hasDegenerateMap(idx, endOrigIdx - 1)) return null;
    const rawStart = map[idx];
    const rawEnd = map[endOrigIdx - 1] + 1;
    return {
      rawStart,
      rawEnd,
      strippedStart: idx,
      strippedEnd: endOrigIdx,
    };
  }

  const endIndex = idx + quote.length - 1;
  if (endIndex >= map.length) return null;
  if (hasDegenerateMap(idx, endIndex)) return null;
  const rawStart = map[idx];
  const rawEnd = map[endIndex] + 1;
  return {
    rawStart,
    rawEnd,
    strippedStart: idx,
    strippedEnd: endIndex + 1,
  };
}

function findRawQuoteSpanInMarkdown(markdown: string, quote: string): { start: number; end: number } | null {
  const anchor = findQuoteAnchorInMarkdown(markdown, quote);
  if (!anchor) return null;
  return { start: anchor.rawStart, end: anchor.rawEnd };
}

function findQuoteSpanInMarkdown(markdown: string, quote: string): { start: number; end: number } | null {
  const anchor = findQuoteAnchorInMarkdown(markdown, quote);
  if (!anchor) return null;
  return expandMarkdownSpan(markdown, anchor.rawStart, anchor.rawEnd);
}

function replaceFirstOccurrence(source: string, find: string, replace: string): string | null {
  const idx = source.indexOf(find);
  if (idx < 0) return null;
  return `${source.slice(0, idx)}${replace}${source.slice(idx + find.length)}`;
}

function buildAcceptedSuggestionMarkdown(markdown: string, suggestion: StoredMark): string | null {
  const quote = typeof suggestion.quote === 'string' ? suggestion.quote : '';
  if (!quote) return null;

  if (suggestion.kind === 'insert') {
    const content = typeof suggestion.content === 'string' ? suggestion.content : '';
    const span = findQuoteSpanInMarkdown(markdown, quote);
    if (span) {
      return `${markdown.slice(0, span.end)}${content}${markdown.slice(span.end)}`;
    }
    const idx = markdown.indexOf(quote);
    if (idx < 0) return null;
    return `${markdown.slice(0, idx + quote.length)}${content}${markdown.slice(idx + quote.length)}`;
  }

  if (suggestion.kind === 'delete') {
    const span = findQuoteSpanInMarkdown(markdown, quote);
    if (span) {
      return `${markdown.slice(0, span.start)}${markdown.slice(span.end)}`;
    }
    return replaceFirstOccurrence(markdown, quote, '');
  }

  if (suggestion.kind === 'replace') {
    const content = typeof suggestion.content === 'string' ? suggestion.content : '';
    const span = findQuoteSpanInMarkdown(markdown, quote);
    if (span) {
      const rawSpan = findRawQuoteSpanInMarkdown(markdown, quote);
      const canWrap = rawSpan && rawSpan.start >= span.start && rawSpan.end <= span.end;
      const prefix = canWrap ? markdown.slice(span.start, rawSpan.start) : '';
      const suffix = canWrap ? markdown.slice(rawSpan.end, span.end) : '';
      const wrappedContent = `${prefix}${content}${suffix}`;
      return `${markdown.slice(0, span.start)}${wrappedContent}${markdown.slice(span.end)}`;
    }
    return replaceFirstOccurrence(markdown, quote, content);
  }

  return markdown;
}

function toStructuredMutationFailureResult(
  failure: ProofMarkRehydrationFailure,
  fallbackAnchorMessage: string,
): EngineExecutionResult {
  const details = failure.missingRequiredMarkIds.length > 0
    ? { missingMarkIds: failure.missingRequiredMarkIds }
    : {};
  switch (failure.code) {
    case 'MARKDOWN_PARSE_FAILED':
      return {
        status: 422,
        body: {
          success: false,
          code: 'INVALID_MARKDOWN',
          error: failure.error,
          ...details,
        },
      };
    case 'MARK_NOT_HYDRATED':
      return {
        status: 409,
        body: {
          success: false,
          code: 'MARK_NOT_HYDRATED',
          error: fallbackAnchorMessage,
          ...details,
        },
      };
    case 'REQUIRED_MARKS_MISSING':
      return {
        status: 409,
        body: {
          success: false,
          code: 'MARK_REHYDRATION_INCOMPLETE',
          error: failure.error,
          ...details,
        },
      };
    case 'STRUCTURED_MUTATION_FAILED':
      return {
        status: 409,
        body: {
          success: false,
          code: 'STRUCTURED_MUTATION_FAILED',
          error: failure.error,
          ...details,
        },
      };
    default:
      return {
        status: 409,
        body: {
          success: false,
          code: 'MARK_REHYDRATION_FAILED',
          error: failure.error,
          ...details,
        },
      };
  }
}

function readState(slug: string): EngineExecutionResult {
  const doc = getCanonicalReadableDocument(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { error: 'Document not found', success: false } };
  }
  if (doc.share_state === 'REVOKED') {
    return { status: 403, body: { error: 'Document access revoked', success: false } };
  }
  const mutationReady = isCanonicalReadMutationReady(doc);
  const readSource = 'read_source' in doc ? doc.read_source : 'projection';
  const projectionFresh = 'projection_fresh' in doc ? doc.projection_fresh : true;
  const marks = parseMarks(doc.marks);
  return {
    status: 200,
    body: {
      success: true,
      slug: doc.slug,
      docId: doc.doc_id,
      title: doc.title,
      shareState: doc.share_state,
      content: doc.markdown,
      markdown: doc.markdown,
      marks,
      updatedAt: mutationReady ? doc.updated_at : null,
      revision: mutationReady ? doc.revision : null,
      readSource,
      projectionFresh,
      mutationReady,
      ...(!mutationReady
        ? {
          warning: {
            code: 'PROJECTION_STALE',
            error: 'Canonical reads are serving Yjs fallback content while projection repair catches up.',
          },
        }
        : {}),
    },
  };
}

function persistMarks(slug: string, marks: Record<string, StoredMark>, actor: string, eventType: string, eventData: JsonRecord): EngineExecutionResult {
  const scrubbed = removeResurrectedMarksFromPayload(slug, marks as unknown as Record<string, unknown>);
  const normalizedMarks = canonicalizeStoredMarks(scrubbed.marks as Record<string, StoredMark>);
  if (scrubbed.removed.length > 0) {
    console.warn('[document-engine] removed tombstoned marks from persistence payload', {
      slug,
      removed: scrubbed.removed.length,
      eventType,
    });
  }

  const ok = updateMarks(slug, normalizedMarks as unknown as Record<string, unknown>);
  if (!ok) {
    return { status: 500, body: { success: false, error: 'Failed to update marks' } };
  }
  // Sync marks to Yjs collab layer so they aren't overwritten on next materialization
  applyCanonicalDocumentToCollab(slug, { marks: normalizedMarks as unknown as Record<string, unknown>, source: 'engine' }).catch((error) => {
    console.error('[document-engine] Failed to sync marks to collab projection; invalidating collab state', { slug, error });
    invalidateCollabDocument(slug);
  });
  const eventId = addDocumentEvent(slug, eventType, eventData, actor);
  refreshSnapshotForSlug(slug);
  const doc = getDocumentBySlug(slug);
  const markId = typeof eventData.markId === 'string' && eventData.markId.trim().length > 0
    ? eventData.markId.trim()
    : undefined;
  return {
    status: 200,
    body: {
      success: true,
      eventId,
      ...(markId ? { markId } : {}),
      shareState: doc?.share_state ?? 'ACTIVE',
      updatedAt: doc?.updated_at ?? new Date().toISOString(),
      marks: normalizedMarks,
    },
  };
}

function addComment(slug: string, body: JsonRecord): EngineExecutionResult {
  const ready = getMutationReadyDocument(slug);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return { status: 400, body: { success: false, error: 'Missing text' } };
  }

  let quote = normalizeQuote(body.quote);
  if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
    quote = normalizeQuote(body.selector.quote);
  }
  if (quote) {
    const normalizedMarkdown = normalizeQuote(doc.markdown);
    const normalizedPlain = normalizeMarkdownForQuote(doc.markdown);
    if (!normalizedMarkdown.includes(quote) && !normalizedPlain.includes(quote)) {
      return {
        status: 409,
        body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Comment anchor quote not found in document' },
      };
    }
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const marks = parseMarks(doc.marks);
  marks[id] = {
    kind: 'comment',
    by,
    createdAt: now,
    quote,
    text,
    threadId: id,
    thread: [],
    resolved: false,
  };
  return persistMarks(slug, marks, by, 'comment.added', { markId: id, by, quote, text });
}

function addSuggestion(
  slug: string,
  body: JsonRecord,
  kind: 'insert' | 'delete' | 'replace',
): EngineExecutionResult {
  const ready = getMutationReadyDocument(slug);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  let quote = normalizeQuote(body.quote);
  if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
    quote = normalizeQuote(body.selector.quote);
  }
  if (!quote) {
    return { status: 400, body: { success: false, error: 'Missing quote' } };
  }
  const anchor = findQuoteAnchorInMarkdown(doc.markdown, quote);
  if (!anchor) {
    return {
      status: 409,
      body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' },
    };
  }
  if ((kind === 'insert' || kind === 'replace') && typeof body.content !== 'string') {
    return { status: 400, body: { success: false, error: 'Missing content' } };
  }
  const requestedStatus = typeof body.status === 'string' ? body.status.trim().toLowerCase() : 'pending';
  if (requestedStatus !== 'pending' && requestedStatus !== '') {
    if (requestedStatus === 'accepted') {
      return {
        status: 409,
        body: {
          success: false,
          code: 'ASYNC_REQUIRED',
          error: 'status:"accepted" requires executeDocumentOperationAsync',
        },
      };
    }
    return {
      status: 422,
      body: {
        success: false,
        code: 'INVALID_STATUS',
        error: 'suggestion.add only supports status "pending" or "accepted"',
      },
    };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const marks = parseMarks(doc.marks);
  const providedRange = isRecord(body.range)
    && Number.isFinite(body.range.from)
    && Number.isFinite(body.range.to)
    && Number(body.range.to) > Number(body.range.from)
    ? { from: Number(body.range.from), to: Number(body.range.to) }
    : null;
  marks[id] = {
    kind,
    by,
    createdAt: now,
    quote,
    status: 'pending',
    ...(kind !== 'delete' ? { content: body.content as string } : {}),
    startRel: typeof body.startRel === 'string' && body.startRel.trim() ? body.startRel.trim() : `char:${anchor.strippedStart}`,
    endRel: typeof body.endRel === 'string' && body.endRel.trim() ? body.endRel.trim() : `char:${anchor.strippedEnd}`,
    ...(providedRange ? { range: providedRange } : {}),
  };

  return persistMarks(slug, marks, by, `suggestion.${kind}.added`, {
    markId: id,
    by,
    quote,
    content: typeof body.content === 'string' ? body.content : undefined,
  });
}

function updateSuggestionStatus(
  slug: string,
  body: JsonRecord,
  status: 'accepted' | 'rejected',
): EngineExecutionResult {
  const doc = getCanonicalReadableDocument(slug);
  if (!doc) return { status: 404, body: { success: false, error: 'Document not found' } };
  if (!isCanonicalReadMutationReady(doc)) return projectionStaleMutationResult();
  const markId = typeof body.markId === 'string' ? body.markId : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing) {
    const revisionHint = typeof body.baseRevision === 'number'
      ? body.baseRevision
      : (typeof body.revision === 'number' ? body.revision : null);
    if (shouldRejectMarkMutationByResolvedRevision(slug, markId, revisionHint)) {
      return {
        status: 409,
        body: {
          success: false,
          code: 'STALE_BASE',
          error: 'Mark was already finalized at a newer revision',
        },
      };
    }
    return { status: 404, body: { success: false, error: 'Mark not found' } };
  }
  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'owner';
  if (existing.status === status) {
    return {
      status: 200,
      body: {
        success: true,
        shareState: doc.share_state,
        updatedAt: doc.updated_at,
        marks,
      },
    };
  }

  const nextMarks: Record<string, StoredMark> = {
    ...marks,
    [markId]: { ...existing, status },
  };
  let nextMarkdown = doc.markdown;

  if (status === 'accepted' && (existing.kind === 'insert' || existing.kind === 'delete' || existing.kind === 'replace')) {
    const acceptedMarkdown = buildAcceptedSuggestionMarkdown(doc.markdown, existing);
    if (acceptedMarkdown === null) {
      return { status: 409, body: { success: false, error: 'Cannot accept suggestion without quote anchor' } };
    }
    nextMarkdown = acceptedMarkdown;
  }

  const ok = updateDocumentAtomic(
    slug,
    doc.updated_at,
    nextMarkdown,
    nextMarks as unknown as Record<string, unknown>,
  );
  if (!ok) {
    return {
      status: 409,
      body: {
        success: false,
        error: 'Document was modified concurrently; retry with latest state',
      },
    };
  }
  const eventId = addDocumentEvent(slug, `suggestion.${status}`, { markId, status, by: actor }, actor);
  refreshSnapshotForSlug(slug);
  const updated = getDocumentBySlug(slug);
  const resolvedRevision = typeof updated?.revision === 'number' ? updated.revision : (doc.revision + 1);
  upsertMarkTombstone(slug, markId, status, resolvedRevision);
  if (status === 'rejected') {
    // Rejected suggestions must survive reload/cache clear, and stale live Yjs fragments
    // can otherwise rehydrate the rejected mark after the canonical DB write succeeds.
    // Bump the access epoch first so collab sessions on every node reconnect against
    // canonical DB state instead of reusing stale in-memory rooms on other instances.
    bumpDocumentAccessEpoch(slug);
    invalidateCollabDocument(slug);
  } else {
    const collabMarkdown = updated?.markdown ?? nextMarkdown;
    void applyCanonicalDocumentToCollab(slug, {
      markdown: collabMarkdown,
      marks: nextMarks as unknown as Record<string, unknown>,
      source: 'engine',
    }).catch((error) => {
      console.error('[document-engine] Failed to sync suggestion status to collab projection; invalidating collab state', { slug, status, error });
      invalidateCollabDocument(slug);
    });
  }
  if (updated) {
    void rebuildDocumentBlocks(updated, updated.markdown, updated.revision).catch((error) => {
      console.error('[document-engine] Failed to rebuild block index after suggestion update:', { slug, error });
    });
  }
  return {
    status: 200,
    body: {
      success: true,
      eventId,
      shareState: updated?.share_state ?? doc.share_state,
      updatedAt: updated?.updated_at ?? new Date().toISOString(),
      content: updated?.markdown ?? nextMarkdown,
      markdown: updated?.markdown ?? nextMarkdown,
      marks: nextMarks,
    },
  };
}

async function addSuggestionAsync(
  slug: string,
  body: JsonRecord,
  kind: 'insert' | 'delete' | 'replace',
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  const requestedStatus = typeof body.status === 'string' ? body.status.trim().toLowerCase() : 'pending';
  if (!requestedStatus || requestedStatus === 'pending') {
    return addSuggestion(slug, body, kind);
  }
  if (requestedStatus !== 'accepted') {
    return {
      status: 422,
      body: {
        success: false,
        code: 'INVALID_STATUS',
        error: 'suggestion.add only supports status "pending" or "accepted"',
      },
    };
  }

  const ready = getMutationReadyDocument(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  let quote = normalizeQuote(body.quote);
  if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
    quote = normalizeQuote(body.selector.quote);
  }
  if (!quote) {
    return { status: 400, body: { success: false, error: 'Missing quote' } };
  }
  const anchor = findQuoteAnchorInMarkdown(doc.markdown, quote);
  if (!anchor) {
    return {
      status: 409,
      body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' },
    };
  }
  if ((kind === 'insert' || kind === 'replace') && typeof body.content !== 'string') {
    return { status: 400, body: { success: false, error: 'Missing content' } };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const marks = parseMarks(doc.marks);
  const providedRange = isRecord(body.range)
    && Number.isFinite(body.range.from)
    && Number.isFinite(body.range.to)
    && Number(body.range.to) > Number(body.range.from)
    ? { from: Number(body.range.from), to: Number(body.range.to) }
    : null;
  const suggestion: StoredMark = {
    kind,
    by,
    createdAt: now,
    quote,
    status: 'accepted',
    ...(kind !== 'delete' ? { content: body.content as string } : {}),
    startRel: typeof body.startRel === 'string' && body.startRel.trim() ? body.startRel.trim() : `char:${anchor.strippedStart}`,
    endRel: typeof body.endRel === 'string' && body.endRel.trim() ? body.endRel.trim() : `char:${anchor.strippedEnd}`,
    ...(providedRange ? { range: providedRange } : {}),
  };

  const structuredAccepted = await finalizeSuggestionThroughRehydration({
    markdown: doc.markdown,
    marks: {
      ...marks,
      [id]: { ...suggestion, status: 'pending' },
    },
    markId: id,
    action: 'accept',
  });
  if (!structuredAccepted.ok) {
    return toStructuredMutationFailureResult(structuredAccepted, 'Suggestion anchor quote not found in document');
  }

  const mutation = await mutateCanonicalDocument({
    slug,
    nextMarkdown: structuredAccepted.markdown,
    nextMarks: structuredAccepted.marks as unknown as Record<string, unknown>,
    source: `engine:suggestion.add.accepted:${by}`,
    baseRevision: doc.revision,
    strictLiveDoc: true,
    guardPathologicalGrowth: true,
  });
  if (!mutation.ok) {
    return {
      status: mutation.status,
      body: {
        success: false,
        code: mutation.code,
        error: mutation.error,
        ...(mutation.retryWithState ? { retryWithState: mutation.retryWithState } : {}),
      },
    };
  }

  const eventId = addDocumentEvent(slug, 'suggestion.accepted', { markId: id, status: 'accepted', by }, by);
  upsertMarkTombstone(slug, id, 'accepted', mutation.document.revision);
  return {
    status: 200,
    body: {
      success: true,
      acceptedImmediately: true,
      eventId,
      markId: id,
      shareState: mutation.document.share_state,
      updatedAt: mutation.document.updated_at,
      content: mutation.document.markdown,
      markdown: mutation.document.markdown,
      marks: parseMarks(mutation.document.marks),
    },
  };
}

async function updateSuggestionStatusAsync(
  slug: string,
  body: JsonRecord,
  status: 'accepted' | 'rejected',
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  const ready = getMutationReadyDocument(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const markId = typeof body.markId === 'string' ? body.markId : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing) {
    const revisionHint = typeof body.baseRevision === 'number'
      ? body.baseRevision
      : (typeof body.revision === 'number' ? body.revision : null);
    if (shouldRejectMarkMutationByResolvedRevision(slug, markId, revisionHint)) {
      return {
        status: 409,
        body: {
          success: false,
          code: 'STALE_BASE',
          error: 'Mark was already finalized at a newer revision',
        },
      };
    }
    return { status: 404, body: { success: false, error: 'Mark not found' } };
  }

  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'owner';
  if (existing.status === status) {
    return {
      status: 200,
      body: {
        success: true,
        shareState: doc.share_state,
        updatedAt: doc.updated_at,
        marks,
      },
    };
  }

  if (existing.kind !== 'insert' && existing.kind !== 'delete' && existing.kind !== 'replace') {
    return updateSuggestionStatus(slug, body, status);
  }

  const structuredResult = await finalizeSuggestionThroughRehydration({
    markdown: doc.markdown,
    marks,
    markId,
    action: status === 'accepted' ? 'accept' : 'reject',
  });
  if (!structuredResult.ok) {
    return toStructuredMutationFailureResult(structuredResult, 'Suggestion anchor quote not found in document');
  }

  const mutation = await mutateCanonicalDocument({
    slug,
    nextMarkdown: structuredResult.markdown,
    nextMarks: structuredResult.marks as unknown as Record<string, unknown>,
    source: `engine:${status}:${actor}`,
    baseRevision: doc.revision,
    strictLiveDoc: true,
    guardPathologicalGrowth: true,
  });
  if (!mutation.ok) {
    return {
      status: mutation.status,
      body: {
        success: false,
        code: mutation.code,
        error: mutation.error,
        ...(mutation.retryWithState ? { retryWithState: mutation.retryWithState } : {}),
      },
    };
  }

  const eventId = addDocumentEvent(slug, `suggestion.${status}`, { markId, status, by: actor }, actor);
  upsertMarkTombstone(slug, markId, status, mutation.document.revision);
  const updatedMarks = parseMarks(mutation.document.marks);

  return {
    status: 200,
    body: {
      success: true,
      eventId,
      shareState: mutation.document.share_state,
      updatedAt: mutation.document.updated_at,
      content: mutation.document.markdown,
      markdown: mutation.document.markdown,
      marks: updatedMarks,
    },
  };
}

function resolveComment(slug: string, body: JsonRecord): EngineExecutionResult {
  const ready = getMutationReadyDocument(slug);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const markId = typeof body.markId === 'string' ? body.markId : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing) return { status: 404, body: { success: false, error: 'Mark not found' } };
  marks[markId] = { ...existing, resolved: true };
  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'owner';
  const result = persistMarks(slug, marks, actor, 'comment.resolved', { markId, by: actor });
  if (result.status >= 200 && result.status < 300) {
    const updated = getDocumentBySlug(slug);
    const resolvedRevision = typeof updated?.revision === 'number' ? updated.revision : (doc.revision + 1);
    upsertMarkTombstone(slug, markId, 'resolved', resolvedRevision);
  }
  return result;
}

function unresolveComment(slug: string, body: JsonRecord): EngineExecutionResult {
  const ready = getMutationReadyDocument(slug);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const markId = typeof body.markId === 'string' ? body.markId : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing) return { status: 404, body: { success: false, error: 'Mark not found' } };
  marks[markId] = { ...existing, resolved: false };
  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'owner';
  return persistMarks(slug, marks, actor, 'comment.unresolved', { markId, by: actor });
}

function replyComment(slug: string, body: JsonRecord): EngineExecutionResult {
  const ready = getMutationReadyDocument(slug);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const markId = typeof body.markId === 'string' ? body.markId : '';
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!markId || !text.trim()) return { status: 400, body: { success: false, error: 'Missing markId/text' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing) return { status: 404, body: { success: false, error: 'Mark not found' } };
  const threadReplies = Array.isArray(existing.thread)
    ? existing.thread as Array<{ by: string; text: string; at: string }>
    : [];
  const normalizedReplies = Array.isArray(existing.replies) ? existing.replies : [];
  const baseReplies = normalizedReplies.length >= threadReplies.length ? normalizedReplies : threadReplies;
  const replies = [...baseReplies, { by, text, at: new Date().toISOString() }];
  marks[markId] = { ...existing, thread: replies, replies, threadId: existing.threadId ?? markId };
  return persistMarks(slug, marks, by, 'comment.replied', { markId, by, text });
}

function rewriteDocument(slug: string, body: JsonRecord): EngineExecutionResult {
  return {
    status: 501,
    body: {
      success: false,
      code: 'REWRITE_ASYNC_REQUIRED',
      error: 'rewrite.apply must be executed through the async canonical mutation path',
    },
  };
}

export function executeDocumentOperation(
  slug: string,
  method: string,
  routePath: string,
  body: JsonRecord = {},
): EngineExecutionResult {
  if (method === 'GET' && routePath === '/state') return readState(slug);
  if (method === 'POST' && routePath === '/marks/comment') return addComment(slug, body);
  if (method === 'POST' && routePath === '/marks/suggest-replace') return addSuggestion(slug, body, 'replace');
  if (method === 'POST' && routePath === '/marks/suggest-insert') return addSuggestion(slug, body, 'insert');
  if (method === 'POST' && routePath === '/marks/suggest-delete') return addSuggestion(slug, body, 'delete');
  if (method === 'POST' && routePath === '/marks/accept') return updateSuggestionStatus(slug, body, 'accepted');
  if (method === 'POST' && routePath === '/marks/reject') return updateSuggestionStatus(slug, body, 'rejected');
  if (method === 'POST' && routePath === '/marks/resolve') return resolveComment(slug, body);
  if (method === 'POST' && routePath === '/marks/unresolve') return unresolveComment(slug, body);
  if (method === 'POST' && routePath === '/marks/reply') return replyComment(slug, body);
  if (method === 'POST' && routePath === '/rewrite') return rewriteDocument(slug, body);
  if (method === 'GET' && routePath === '/marks') {
    const doc = getCanonicalReadableDocument(slug);
    if (!doc) return { status: 404, body: { success: false, error: 'Document not found' } };
    return { status: 200, body: { success: true, marks: parseMarks(doc.marks) } };
  }
  return {
    status: 404,
    body: {
      success: false,
      error: `Unsupported document operation: ${method} ${routePath}`,
    },
  };
}

export async function executeDocumentOperationAsync(
  slug: string,
  method: string,
  routePath: string,
  body: JsonRecord = {},
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  if (method === 'POST' && routePath === '/marks/suggest-replace') {
    return addSuggestionAsync(slug, body, 'replace', context);
  }
  if (method === 'POST' && routePath === '/marks/suggest-insert') {
    return addSuggestionAsync(slug, body, 'insert', context);
  }
  if (method === 'POST' && routePath === '/marks/suggest-delete') {
    return addSuggestionAsync(slug, body, 'delete', context);
  }
  if (method === 'POST' && routePath === '/marks/accept') {
    return updateSuggestionStatusAsync(slug, body, 'accepted', context);
  }
  if (method === 'POST' && routePath === '/marks/reject') {
    return updateSuggestionStatusAsync(slug, body, 'rejected', context);
  }
  return executeDocumentOperation(slug, method, routePath, body);
}
