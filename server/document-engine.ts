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
  type AuthoritativeMutationBase,
  getCanonicalReadableDocument as getAuthoritativeCanonicalReadableDocument,
  getCanonicalReadableDocumentSync,
  getLoadedCollabMarkdownFromFragment,
  invalidateCollabDocument,
  isCanonicalReadMutationReady,
  stripEphemeralCollabSpans,
  type CanonicalReadableDocument,
} from './collab.js';
import { mutateCanonicalDocument, recoverCanonicalDocumentIfNeeded } from './canonical-document.js';
import { canonicalizeStoredMarks } from '../src/formats/marks.js';
import {
  canonicalizeAnchorTargetText,
  stripMarkdownVisibleText,
} from '../src/shared/anchor-target-text.js';
import {
  applyPostMutationCleanup,
  buildAnchorRetrySteps,
  type AnchorResolveSuccess,
  stabilizeAnchorTarget,
  type AnchorTarget,
  isAgentEditAnchorV2Enabled,
  isAuthoredSpanRemapEnabled,
  isFailClosedDuplicateHandlingEnabled,
  isStructuralCleanupEnabled,
  resolveAnchorTarget,
} from './anchor-resolver.js';
import {
  finalizeSuggestionThroughRehydration,
  type ProofMarkRehydrationFailure,
} from './proof-mark-rehydration.js';
import {
  recordEditAnchorAmbiguous,
  recordEditAnchorNotFound,
  recordEditAuthoredSpanRemap,
  recordEditStructuralCleanupApplied,
} from './metrics.js';

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
  target?: AnchorTarget;
  startRel?: string;
  endRel?: string;
  [key: string]: unknown;
};

export interface EngineExecutionResult {
  status: number;
  body: JsonRecord;
}

type AsyncDocumentMutationPrecondition = {
  mode: 'none' | 'token' | 'revision' | 'updatedAt';
  baseToken?: string;
  baseRevision?: number;
  baseUpdatedAt?: string;
};

export type AsyncDocumentMutationContext = {
  doc: CanonicalReadableDocument;
  mutationBase?: AuthoritativeMutationBase | null;
  precondition?: AsyncDocumentMutationPrecondition;
  idempotencyKey?: string;
  idempotencyRoute?: string;
};

function mutationContextIdempotencyKey(context?: AsyncDocumentMutationContext): string | undefined {
  return typeof context?.idempotencyKey === 'string' && context.idempotencyKey.trim()
    ? context.idempotencyKey.trim()
    : undefined;
}

function mutationContextIdempotencyRoute(context?: AsyncDocumentMutationContext): string | undefined {
  return typeof context?.idempotencyRoute === 'string' && context.idempotencyRoute.trim()
    ? context.idempotencyRoute.trim()
    : undefined;
}

function getCanonicalReadableDocument(slug: string) {
  return getCanonicalReadableDocumentSync(slug, 'state') ?? getDocumentBySlug(slug);
}

type MutationReadyDocument = NonNullable<ReturnType<typeof getCanonicalReadableDocument>>;

function isMutationReadyRead(doc: MutationReadyDocument): boolean {
  return 'mutation_ready' in doc
    ? isCanonicalReadMutationReady(doc as { mutation_ready?: boolean })
    : true;
}

function isProjectionRepairPending(doc: MutationReadyDocument): boolean {
  const projectionDoc = doc as CanonicalReadableDocument;
  return 'projection_fresh' in doc
    ? projectionDoc.projection_fresh === false || projectionDoc.repair_pending === true
    : false;
}

async function getCanonicalReadableDocumentAsync(
  slug: string,
  docOverride?: MutationReadyDocument,
): Promise<MutationReadyDocument | null> {
  const doc = docOverride
    ?? await getAuthoritativeCanonicalReadableDocument(slug, 'state')
    ?? getDocumentBySlug(slug);
  if (!doc) return null;
  if (!isMutationReadyRead(doc)) return doc;
  const authoritativeDoc = await getAuthoritativeCanonicalReadableDocument(slug, 'state');
  return authoritativeDoc ?? doc;
}

function getMutationReadyDocument(
  slug: string,
  context?: AsyncDocumentMutationContext,
):
  | { doc: MutationReadyDocument; error: null }
  | { doc: null; error: EngineExecutionResult } {
  if (context?.mutationBase) {
    return { doc: context.doc, error: null };
  }
  const doc = context?.doc ?? getCanonicalReadableDocument(slug);
  if (!doc) {
    return { doc: null, error: { status: 404, body: { success: false, error: 'Document not found' } } };
  }
  if (!isMutationReadyRead(doc)) {
    return { doc: null, error: projectionStaleMutationResult() };
  }
  return { doc, error: null };
}

async function getMutationReadyDocumentAsync(
  slug: string,
  context?: AsyncDocumentMutationContext,
):
  Promise<
    | { doc: MutationReadyDocument; error: null }
    | { doc: null; error: EngineExecutionResult }
  > {
  if (context?.mutationBase) {
    return { doc: context.doc, error: null };
  }
  let doc = context?.doc
    ? await getCanonicalReadableDocumentAsync(slug, context.doc)
    : await getCanonicalReadableDocumentAsync(slug);
  if (!doc) {
    return { doc: null, error: { status: 404, body: { success: false, error: 'Document not found' } } };
  }
  const repairPending = isProjectionRepairPending(doc);
  if (repairPending || !isMutationReadyRead(doc)) {
    const recovered = await recoverCanonicalDocumentIfNeeded(slug, 'mutation');
    if (recovered) {
      doc = await getCanonicalReadableDocumentAsync(slug, recovered as MutationReadyDocument)
        ?? recovered as MutationReadyDocument;
    }
  }
  if (!isMutationReadyRead(doc)) {
    return { doc: null, error: projectionStaleMutationResult() };
  }
  return { doc: doc as MutationReadyDocument, error: null };
}

function resolveReadyDocument(
  slug: string,
  context?: MutationReadyDocument | AsyncDocumentMutationContext,
):
  | { doc: MutationReadyDocument; error: null }
  | { doc: null; error: EngineExecutionResult } {
  if (context && 'doc' in context) {
    return getMutationReadyDocument(slug, context);
  }
  if (context) {
    return { doc: context, error: null };
  }
  return getMutationReadyDocument(slug);
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

function buildCanonicalMutationBaseArgs(
  doc: Pick<MutationReadyDocument, 'revision' | 'updated_at'>,
  context?: AsyncDocumentMutationContext,
): { baseToken?: string; baseRevision?: number; baseUpdatedAt?: string } {
  const precondition = context?.precondition;
  if (precondition?.mode === 'token' && typeof precondition.baseToken === 'string' && precondition.baseToken.trim()) {
    return { baseToken: precondition.baseToken.trim() };
  }
  if (precondition?.mode === 'revision' && typeof precondition.baseRevision === 'number') {
    return { baseRevision: precondition.baseRevision };
  }
  if (precondition?.mode === 'updatedAt' && typeof precondition.baseUpdatedAt === 'string' && precondition.baseUpdatedAt.trim()) {
    return { baseUpdatedAt: precondition.baseUpdatedAt.trim() };
  }
  return typeof doc.revision === 'number' ? { baseRevision: doc.revision } : {};
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

function parseRelativeCharOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^char:(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
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
      // Block-level HTML tags become a block separator in the visible-text domain.
      const blockTagMatch = source.slice(i).match(/^<\/?(?:p|br|div|li)\b[^>]*>/i);
      if (blockTagMatch) {
        const matchLen = blockTagMatch[0].length;
        const closingIdx = i + matchLen - 1;
        pushChar('\n', closingIdx);
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
  return normalizeQuote(stripMarkdownVisibleText(markdown));
}

function canonicalizeVisibleTextWithMapping(
  stripped: string,
  map: number[],
): { text: string; map: number[] } {
  const textChars: string[] = [];
  const canonicalMap: number[] = [];
  let index = 0;

  while (index < stripped.length) {
    const ch = stripped[index];
    if (ch === '\r') {
      index += 1;
      continue;
    }

    if (ch === '\n') {
      let end = index + 1;
      while (end < stripped.length) {
        const next = stripped[end];
        if (next === '\r') {
          end += 1;
          continue;
        }
        if (next === '\n' || next === ' ' || next === '\t') {
          end += 1;
          continue;
        }
        break;
      }

      while (textChars.length > 0 && (textChars[textChars.length - 1] === ' ' || textChars[textChars.length - 1] === '\t')) {
        textChars.pop();
        canonicalMap.pop();
      }
      if (textChars.length > 0 && end < stripped.length && textChars[textChars.length - 1] !== '\n') {
        textChars.push('\n');
        canonicalMap.push(map[Math.min(end - 1, map.length - 1)] ?? map[index] ?? 0);
      }
      index = end;
      continue;
    }

    if ((ch === ' ' || ch === '\t') && textChars[textChars.length - 1] === '\n') {
      index += 1;
      continue;
    }

    textChars.push(ch);
    canonicalMap.push(map[index] ?? 0);
    index += 1;
  }

  return {
    text: textChars.join(''),
    map: canonicalMap,
  };
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

function canRejectSuggestionWithoutHydration(markdown: string, mark: StoredMark): boolean {
  if (mark.kind !== 'insert' && mark.kind !== 'delete' && mark.kind !== 'replace') return false;
  const quote = normalizeQuote(mark.quote);
  if (!quote) return false;
  const anchor = findQuoteAnchorInMarkdown(markdown, quote);
  if (!anchor) return false;

  const startRel = parseRelativeCharOffset(mark.startRel);
  const endRel = parseRelativeCharOffset(mark.endRel);
  if (startRel === null && endRel === null) return false;
  if (startRel !== null && Math.abs(anchor.strippedStart - startRel) > 1) return false;
  if (endRel !== null && Math.abs(anchor.strippedEnd - endRel) > 1) return false;
  return true;
}

export function __canRejectSuggestionWithoutHydrationForTests(markdown: string, mark: StoredMark): boolean {
  return canRejectSuggestionWithoutHydration(markdown, mark);
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

function parseAnchorTarget(raw: unknown): { ok: true; target: AnchorTarget } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'target must be an object' };
  if (typeof raw.anchor !== 'string' || !raw.anchor.length) {
    return { ok: false, error: 'target.anchor must be a non-empty string' };
  }

  const target: AnchorTarget = { anchor: raw.anchor };
  if (raw.mode !== undefined) {
    if (raw.mode !== 'exact' && raw.mode !== 'normalized' && raw.mode !== 'contextual') {
      return { ok: false, error: 'target.mode must be exact, normalized, or contextual' };
    }
    target.mode = raw.mode;
  }
  if (raw.occurrence !== undefined) {
    if (raw.occurrence === 'first' || raw.occurrence === 'last') {
      target.occurrence = raw.occurrence;
    } else if (Number.isInteger(raw.occurrence) && (raw.occurrence as number) >= 0) {
      target.occurrence = raw.occurrence as number;
    } else {
      return { ok: false, error: 'target.occurrence must be first, last, or a 0-based integer' };
    }
  }
  if (raw.contextBefore !== undefined) {
    if (typeof raw.contextBefore !== 'string') return { ok: false, error: 'target.contextBefore must be a string' };
    target.contextBefore = raw.contextBefore;
  }
  if (raw.contextAfter !== undefined) {
    if (typeof raw.contextAfter !== 'string') return { ok: false, error: 'target.contextAfter must be a string' };
    target.contextAfter = raw.contextAfter;
  }
  return { ok: true, target };
}

function buildImplicitLegacyTarget(anchor: string): AnchorTarget {
  return {
    anchor,
    mode: isAgentEditAnchorV2Enabled() ? 'normalized' : 'exact',
    occurrence: 'first',
  };
}

function mapVisibleSelectionToSourceRange(
  markdown: string,
  map: number[],
  startOffset: number,
  endOffset: number,
): { sourceStart: number; sourceEnd: number } | null {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) return null;
  if (startOffset < 0 || endOffset > map.length) return null;
  const sourceStart = map[startOffset];
  const sourceEndInclusive = map[endOffset - 1];
  if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEndInclusive)) return null;
  return {
    sourceStart: Math.max(0, Math.min(markdown.length, sourceStart)),
    sourceEnd: Math.max(0, Math.min(markdown.length, sourceEndInclusive + 1)),
  };
}

function buildAcceptedSuggestionMarkdownFromSelection(
  markdown: string,
  suggestion: StoredMark,
  selection: { sourceStart: number; sourceEnd: number },
): string {
  const rawStart = Math.min(selection.sourceStart, selection.sourceEnd);
  const rawEnd = Math.max(selection.sourceStart, selection.sourceEnd);
  const span = expandMarkdownSpan(markdown, rawStart, rawEnd);

  if (suggestion.kind === 'insert') {
    const content = typeof suggestion.content === 'string' ? suggestion.content : '';
    return `${markdown.slice(0, span.end)}${content}${markdown.slice(span.end)}`;
  }

  if (suggestion.kind === 'delete') {
    return `${markdown.slice(0, span.start)}${markdown.slice(span.end)}`;
  }

  if (suggestion.kind === 'replace') {
    const content = typeof suggestion.content === 'string' ? suggestion.content : '';
    const prefix = markdown.slice(span.start, rawStart);
    const suffix = markdown.slice(rawEnd, span.end);
    return `${markdown.slice(0, span.start)}${prefix}${content}${suffix}${markdown.slice(span.end)}`;
  }

  return markdown;
}

function resolveMutationAnchor(
  route: string,
  markdown: string,
  target: AnchorTarget,
  notFoundError: string,
): {
    ok: true;
    resolved: AnchorResolveSuccess;
    normalizedTarget: AnchorTarget;
    logicalSource: string;
  } | { ok: false; result: EngineExecutionResult } {
  const anchorV2Enabled = isAgentEditAnchorV2Enabled();
  const normalizedTarget = canonicalizeAnchorTargetText(target);
  const { stripped, map } = stripMarkdownWithMapping(markdown);
  const canonical = canonicalizeVisibleTextWithMapping(stripped, map);
  const resolved = resolveAnchorTarget(canonical.text, normalizedTarget, {
    defaultMode: normalizedTarget.mode,
    failClosedDuplicates: anchorV2Enabled ? isFailClosedDuplicateHandlingEnabled() : false,
    stripAuthoredSpans: false,
  });

  if (!resolved.ok) {
    if (resolved.code === 'ANCHOR_AMBIGUOUS') recordEditAnchorAmbiguous(route, resolved.mode);
    else recordEditAnchorNotFound(route, resolved.mode);
    return {
      ok: false,
      result: {
        status: 409,
        body: {
          success: false,
          code: resolved.code,
          error: resolved.code === 'ANCHOR_AMBIGUOUS' ? 'Anchor target is ambiguous in current markdown' : notFoundError,
          details: {
            candidateCount: resolved.candidateCount,
            mode: resolved.mode,
            remapUsed: resolved.remapUsed,
          },
          nextSteps: buildAnchorRetrySteps(resolved.code),
        },
      },
    };
  }

  const mappedSelection = mapVisibleSelectionToSourceRange(
    markdown,
    canonical.map,
    resolved.selection.sourceStart,
    resolved.selection.sourceEnd,
  );
  if (!mappedSelection) {
    recordEditAnchorNotFound(route, resolved.mode);
    return {
      ok: false,
      result: {
        status: 409,
        body: {
          success: false,
          code: 'ANCHOR_NOT_FOUND',
          error: notFoundError,
          details: {
            candidateCount: 0,
            mode: resolved.mode,
            remapUsed: resolved.remapUsed,
          },
          nextSteps: buildAnchorRetrySteps('ANCHOR_NOT_FOUND'),
        },
      },
    };
  }

  if (resolved.remapUsed && isAuthoredSpanRemapEnabled()) {
    recordEditAuthoredSpanRemap(route, resolved.mode);
  }

  return {
    ok: true,
    normalizedTarget,
    logicalSource: canonical.text,
    resolved: {
      ...resolved,
      selection: {
        ...resolved.selection,
        sourceStart: mappedSelection.sourceStart,
        sourceEnd: mappedSelection.sourceEnd,
      },
    },
  };
}

function buildStoredSelectionMetadata(
  markdown: string,
  selection: { sourceStart: number; sourceEnd: number },
  fallbackQuote: string,
): { quote: string; startRel?: string; endRel?: string } {
  const normalizedFallback = normalizeQuote(fallbackQuote);
  const { stripped, map } = stripMarkdownWithMapping(markdown);
  const canonical = canonicalizeVisibleTextWithMapping(stripped, map);
  const sourceStart = Math.min(selection.sourceStart, selection.sourceEnd);
  const sourceEnd = Math.max(selection.sourceStart, selection.sourceEnd);
  let startOffset = -1;
  let endOffset = -1;

  for (let i = 0; i < canonical.map.length; i += 1) {
    const sourceIndex = canonical.map[i];
    if (sourceIndex < sourceStart || sourceIndex >= sourceEnd) continue;
    if (startOffset < 0) startOffset = i;
    endOffset = i + 1;
  }

  if (startOffset >= 0 && endOffset > startOffset) {
    const quote = normalizeQuote(canonical.text.slice(startOffset, endOffset)) || normalizedFallback;
    return {
      quote,
      startRel: `char:${startOffset}`,
      endRel: `char:${endOffset}`,
    };
  }

  return { quote: normalizedFallback };
}

function applyMutationCleanup(route: string, markdown: string, structuralCleanupOffsets: number[] = []): string {
  const cleanup = applyPostMutationCleanup(markdown, {
    structuralCleanupEnabled: isStructuralCleanupEnabled(),
    structuralCleanupOffsets,
  });
  if (cleanup.structuralCleanupApplied) {
    recordEditStructuralCleanupApplied(route);
  }
  return cleanup.markdown;
}

function readState(slug: string): EngineExecutionResult {
  const doc = getCanonicalReadableDocument(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { error: 'Document not found', success: false } };
  }
  if (doc.share_state === 'REVOKED') {
    return { status: 403, body: { error: 'Document access revoked', success: false } };
  }
  const mutationReady = isMutationReadyRead(doc);
  const readSource = 'read_source' in doc ? doc.read_source : 'projection';
  const projectionFresh = 'projection_fresh' in doc ? doc.projection_fresh : true;
  const repairPending = 'repair_pending' in doc ? doc.repair_pending : !projectionFresh;
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
      repairPending,
      mutationReady,
      ...(repairPending
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

async function readStateAsync(slug: string): Promise<EngineExecutionResult> {
  const doc = await getCanonicalReadableDocumentAsync(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { error: 'Document not found', success: false } };
  }
  if (doc.share_state === 'REVOKED') {
    return { status: 403, body: { error: 'Document access revoked', success: false } };
  }
  const mutationReady = isMutationReadyRead(doc);
  const readSource = 'read_source' in doc ? doc.read_source : 'projection';
  const projectionFresh = 'projection_fresh' in doc ? doc.projection_fresh : true;
  const repairPending = 'repair_pending' in doc ? doc.repair_pending : !projectionFresh;
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
      repairPending,
      mutationReady,
      ...(repairPending
        ? { warning: 'Content is being repaired from authoritative collaborative state.' }
        : {}),
    },
  };
}

async function readMarksAsync(slug: string): Promise<EngineExecutionResult> {
  const doc = await getCanonicalReadableDocumentAsync(slug);
  if (!doc) return { status: 404, body: { success: false, error: 'Document not found' } };
  return { status: 200, body: { success: true, marks: parseMarks(doc.marks) } };
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

async function persistMarksAsync(
  slug: string,
  doc: MutationReadyDocument,
  marks: Record<string, StoredMark>,
  actor: string,
  eventType: string,
  eventData: JsonRecord,
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  const scrubbed = removeResurrectedMarksFromPayload(slug, marks as unknown as Record<string, unknown>);
  const normalizedMarks = canonicalizeStoredMarks(scrubbed.marks as Record<string, StoredMark>);
  if (scrubbed.removed.length > 0) {
    console.warn('[document-engine] removed tombstoned marks from persistence payload', {
      slug,
      removed: scrubbed.removed.length,
      eventType,
    });
  }

  const liveFragmentMarkdown = await getLoadedCollabMarkdownFromFragment(slug);
  const currentRow = getDocumentBySlug(slug);
  const persistedMarkdown = stripEphemeralCollabSpans(currentRow?.markdown ?? '');
  const authoritativeMarkdown = stripEphemeralCollabSpans(doc.markdown ?? '');
  const targetMarkdown = typeof liveFragmentMarkdown === 'string'
    ? liveFragmentMarkdown
    : (context?.mutationBase?.markdown ?? null);
  const hasPersistedYjsState = typeof currentRow?.y_state_version === 'number' && currentRow.y_state_version > 0;
  const yjsBackedMutationBase = context?.mutationBase
    && context.mutationBase.source !== 'projection'
    && context.mutationBase.source !== 'canonical_row';
  const shouldCommitCanonical = (Boolean(context?.precondition) && hasPersistedYjsState)
    || Boolean(yjsBackedMutationBase)
    || (typeof targetMarkdown === 'string'
      && stripEphemeralCollabSpans(targetMarkdown) !== persistedMarkdown);

  if (!shouldCommitCanonical) {
    return persistMarks(slug, normalizedMarks, actor, eventType, eventData);
  }

  const mutation = await mutateCanonicalDocument({
    slug,
    nextMarkdown: targetMarkdown ?? authoritativeMarkdown,
    nextMarks: normalizedMarks as unknown as Record<string, unknown>,
    source: `engine:${eventType}:${actor}`,
    ...buildCanonicalMutationBaseArgs(doc, context),
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

  const eventId = addDocumentEvent(
    slug,
    eventType,
    eventData,
    actor,
    mutationContextIdempotencyKey(context),
    mutationContextIdempotencyRoute(context),
  );
  refreshSnapshotForSlug(slug);
  const updated = mutation.document;
  const markId = typeof eventData.markId === 'string' && eventData.markId.trim().length > 0
    ? eventData.markId.trim()
    : undefined;
  return {
    status: 200,
    body: {
      success: true,
      eventId,
      ...(markId ? { markId } : {}),
      shareState: updated.share_state,
      updatedAt: updated.updated_at,
      marks: parseMarks(updated.marks),
    },
  };
}

function addComment(
  slug: string,
  body: JsonRecord,
  context?: MutationReadyDocument | AsyncDocumentMutationContext,
): EngineExecutionResult {
  const ready = resolveReadyDocument(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const route = 'POST /marks/comment';
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return { status: 400, body: { success: false, error: 'Missing text' } };
  }

  let quote = normalizeQuote(body.quote);
  if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
    quote = normalizeQuote(body.selector.quote);
  }
  let target: AnchorTarget | undefined;
  if (isRecord(body.target)) {
    const parsed = parseAnchorTarget(body.target);
    if (!parsed.ok) return { status: 400, body: { success: false, error: parsed.error } };
    target = parsed.target;
  } else if (isRecord(body.selector) && isRecord(body.selector.target)) {
    const parsed = parseAnchorTarget(body.selector.target);
    if (!parsed.ok) return { status: 400, body: { success: false, error: parsed.error } };
    target = parsed.target;
  } else if (quote) {
    const normalizedMarkdown = normalizeQuote(doc.markdown);
    const normalizedPlain = normalizeMarkdownForQuote(doc.markdown);
    if (!normalizedMarkdown.includes(quote) && !normalizedPlain.includes(quote)) {
      return {
        status: 409,
        body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Comment anchor quote not found in document' },
      };
    }
  }

  let resolvedTarget: AnchorTarget | undefined;
  let selectionMetadata: { quote: string; startRel?: string; endRel?: string } | null = null;
  if (target) {
    const resolved = resolveMutationAnchor(route, doc.markdown, target, 'Comment anchor quote not found in document');
    if (!resolved.ok) return resolved.result;
    resolvedTarget = stabilizeAnchorTarget(resolved.logicalSource, resolved.normalizedTarget, resolved.resolved);
    selectionMetadata = buildStoredSelectionMetadata(
      doc.markdown,
      resolved.resolved.selection,
      quote || resolved.normalizedTarget.anchor,
    );
    quote = selectionMetadata.quote;
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
    ...(resolvedTarget ? { target: resolvedTarget } : {}),
    ...(selectionMetadata?.startRel ? { startRel: selectionMetadata.startRel } : {}),
    ...(selectionMetadata?.endRel ? { endRel: selectionMetadata.endRel } : {}),
  };
  return persistMarks(slug, marks, by, 'comment.added', { markId: id, by, quote, text });
}

async function addCommentAsync(
  slug: string,
  body: JsonRecord,
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  const ready = await getMutationReadyDocumentAsync(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const route = 'POST /marks/comment';
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return { status: 400, body: { success: false, error: 'Missing text' } };
  }

  let quote = normalizeQuote(body.quote);
  if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
    quote = normalizeQuote(body.selector.quote);
  }
  let target: AnchorTarget | undefined;
  if (isRecord(body.target)) {
    const parsed = parseAnchorTarget(body.target);
    if (!parsed.ok) return { status: 400, body: { success: false, error: parsed.error } };
    target = parsed.target;
  } else if (isRecord(body.selector) && isRecord(body.selector.target)) {
    const parsed = parseAnchorTarget(body.selector.target);
    if (!parsed.ok) return { status: 400, body: { success: false, error: parsed.error } };
    target = parsed.target;
  } else if (quote) {
    const normalizedMarkdown = normalizeQuote(doc.markdown);
    const normalizedPlain = normalizeMarkdownForQuote(doc.markdown);
    if (!normalizedMarkdown.includes(quote) && !normalizedPlain.includes(quote)) {
      return {
        status: 409,
        body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Comment anchor quote not found in document' },
      };
    }
  }

  let resolvedTarget: AnchorTarget | undefined;
  let selectionMetadata: { quote: string; startRel?: string; endRel?: string } | null = null;
  if (target) {
    const resolved = resolveMutationAnchor(route, doc.markdown, target, 'Comment anchor quote not found in document');
    if (!resolved.ok) return resolved.result;
    resolvedTarget = stabilizeAnchorTarget(resolved.logicalSource, resolved.normalizedTarget, resolved.resolved);
    selectionMetadata = buildStoredSelectionMetadata(
      doc.markdown,
      resolved.resolved.selection,
      quote || resolved.normalizedTarget.anchor,
    );
    quote = selectionMetadata.quote;
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
    ...(resolvedTarget ? { target: resolvedTarget } : {}),
    ...(selectionMetadata?.startRel ? { startRel: selectionMetadata.startRel } : {}),
    ...(selectionMetadata?.endRel ? { endRel: selectionMetadata.endRel } : {}),
  };
  return persistMarksAsync(slug, doc, marks, by, 'comment.added', { markId: id, by, quote, text }, context);
}

function addSuggestion(
  slug: string,
  body: JsonRecord,
  kind: 'insert' | 'delete' | 'replace',
  context?: MutationReadyDocument | AsyncDocumentMutationContext,
): EngineExecutionResult {
  const route = `POST /marks/suggest-${kind}`;
  const ready = resolveReadyDocument(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  let quote = normalizeQuote(body.quote);
  if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
    quote = normalizeQuote(body.selector.quote);
  }
  let target: AnchorTarget | undefined;
  if (isRecord(body.target)) {
    const parsed = parseAnchorTarget(body.target);
    if (!parsed.ok) return { status: 400, body: { success: false, error: parsed.error } };
    target = parsed.target;
  } else if (quote) {
    target = buildImplicitLegacyTarget(quote);
  }
  if (!target) {
    return { status: 400, body: { success: false, error: 'Missing quote' } };
  }
  if ((kind === 'insert' || kind === 'replace') && typeof body.content !== 'string') {
    return { status: 400, body: { success: false, error: 'Missing content' } };
  }

  let resolvedTarget: AnchorTarget | undefined;
  let selectionMetadata: { quote: string; startRel?: string; endRel?: string } | null = null;
  if (isRecord(body.target)) {
    const resolved = resolveMutationAnchor(route, doc.markdown, target, 'Suggestion anchor quote not found in document');
    if (!resolved.ok) return resolved.result;
    resolvedTarget = stabilizeAnchorTarget(resolved.logicalSource, resolved.normalizedTarget, resolved.resolved);
    selectionMetadata = buildStoredSelectionMetadata(
      doc.markdown,
      resolved.resolved.selection,
      quote || resolved.normalizedTarget.anchor,
    );
    quote = selectionMetadata.quote;
  } else {
    const normalizedMarkdown = normalizeQuote(doc.markdown);
    const normalizedPlain = normalizeMarkdownForQuote(doc.markdown);
    if (!normalizedMarkdown.includes(quote) && !normalizedPlain.includes(quote)) {
      return {
        status: 409,
        body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' },
      };
    }
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
  const anchor = quote ? findQuoteAnchorInMarkdown(doc.markdown, quote) : null;
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
    ...(resolvedTarget ? { target: resolvedTarget } : {}),
    ...(kind !== 'delete' ? { content: body.content as string } : {}),
    startRel: typeof body.startRel === 'string' && body.startRel.trim()
      ? body.startRel.trim()
      : (selectionMetadata?.startRel ?? (anchor ? `char:${anchor.strippedStart}` : undefined)),
    endRel: typeof body.endRel === 'string' && body.endRel.trim()
      ? body.endRel.trim()
      : (selectionMetadata?.endRel ?? (anchor ? `char:${anchor.strippedEnd}` : undefined)),
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
  context?: MutationReadyDocument | AsyncDocumentMutationContext,
): EngineExecutionResult {
  const ready = resolveReadyDocument(slug, context);
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
  const asyncContext = context && 'doc' in context ? context : undefined;
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

  const existingWithTarget = isRecord(existing.target) ? existing.target : null;
  const existingForApply = existingWithTarget
    ? (() => {
        const parsedTarget = parseAnchorTarget(existing.target);
        if (!parsedTarget.ok) return null;
        const resolved = resolveMutationAnchor(
          status === 'accepted' ? 'POST /marks/accept' : 'POST /marks/reject',
          doc.markdown,
          parsedTarget.target,
          'Suggestion anchor quote not found in document',
        );
        if (!resolved.ok) return resolved;
        const stabilizedTarget = stabilizeAnchorTarget(
          resolved.logicalSource,
          resolved.normalizedTarget,
          resolved.resolved,
        );
        const selectionMetadata = buildStoredSelectionMetadata(
          doc.markdown,
          resolved.resolved.selection,
          typeof existing.quote === 'string' ? existing.quote : resolved.normalizedTarget.anchor,
        );
        return {
          ok: true as const,
          mark: {
            ...existing,
            target: stabilizedTarget,
            quote: selectionMetadata.quote,
            ...(selectionMetadata.startRel ? { startRel: selectionMetadata.startRel } : {}),
            ...(selectionMetadata.endRel ? { endRel: selectionMetadata.endRel } : {}),
          },
          resolvedSelection: resolved.resolved.selection,
        };
      })()
    : { ok: true as const, mark: existing, resolvedSelection: null };

  if (!existingForApply) {
    return { status: 409, body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion target metadata is invalid' } };
  }
  if ('result' in existingForApply) {
    return existingForApply.result;
  }

  const nextMarks: Record<string, StoredMark> = {
    ...marks,
    [markId]: { ...existingForApply.mark, status },
  };
  let nextMarkdown = doc.markdown;

  if (status === 'accepted' && (existing.kind === 'insert' || existing.kind === 'delete' || existing.kind === 'replace')) {
    const acceptedMarkdown = existingForApply.resolvedSelection
      ? buildAcceptedSuggestionMarkdownFromSelection(doc.markdown, existingForApply.mark, existingForApply.resolvedSelection)
      : buildAcceptedSuggestionMarkdown(doc.markdown, existingForApply.mark);
    if (acceptedMarkdown === null) {
      return { status: 409, body: { success: false, error: 'Cannot accept suggestion without quote anchor' } };
    }
    const deleteCleanupOffsets = existing.kind === 'delete'
      ? (() => {
          const quote = typeof existingForApply.mark.quote === 'string' ? existingForApply.mark.quote : '';
          const span = quote ? findRawQuoteSpanInMarkdown(doc.markdown, quote) : null;
          return span ? [span.start] : [];
        })()
      : [];
    nextMarkdown = applyMutationCleanup(
      'POST /marks/accept',
      acceptedMarkdown,
      deleteCleanupOffsets,
    );
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
  const eventId = addDocumentEvent(
    slug,
    `suggestion.${status}`,
    { markId, status, by: actor },
    actor,
    mutationContextIdempotencyKey(asyncContext),
  );
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
  const ready = await getMutationReadyDocumentAsync(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const requestedStatus = typeof body.status === 'string' ? body.status.trim().toLowerCase() : 'pending';
  if (!requestedStatus || requestedStatus === 'pending') {
    const route = `POST /marks/suggest-${kind}`;
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
    let quote = normalizeQuote(body.quote);
    if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
      quote = normalizeQuote(body.selector.quote);
    }
    let target: AnchorTarget | undefined;
    if (isRecord(body.target)) {
      const parsed = parseAnchorTarget(body.target);
      if (!parsed.ok) return { status: 400, body: { success: false, error: parsed.error } };
      target = parsed.target;
    } else if (quote) {
      target = buildImplicitLegacyTarget(quote);
    }
    if (!target) {
      return { status: 400, body: { success: false, error: 'Missing quote' } };
    }
    if ((kind === 'insert' || kind === 'replace') && typeof body.content !== 'string') {
      return { status: 400, body: { success: false, error: 'Missing content' } };
    }

    let resolvedTarget: AnchorTarget | undefined;
    let selectionMetadata: { quote: string; startRel?: string; endRel?: string } | null = null;
    if (isRecord(body.target)) {
      const resolved = resolveMutationAnchor(route, doc.markdown, target, 'Suggestion anchor quote not found in document');
      if (!resolved.ok) return resolved.result;
      resolvedTarget = stabilizeAnchorTarget(resolved.logicalSource, resolved.normalizedTarget, resolved.resolved);
      selectionMetadata = buildStoredSelectionMetadata(
        doc.markdown,
        resolved.resolved.selection,
        quote || resolved.normalizedTarget.anchor,
      );
      quote = selectionMetadata.quote;
    } else {
      const normalizedMarkdown = normalizeQuote(doc.markdown);
      const normalizedPlain = normalizeMarkdownForQuote(doc.markdown);
      if (!normalizedMarkdown.includes(quote) && !normalizedPlain.includes(quote)) {
        return {
          status: 409,
          body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' },
        };
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const marks = parseMarks(doc.marks);
    const anchor = quote ? findQuoteAnchorInMarkdown(doc.markdown, quote) : null;
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
      ...(resolvedTarget ? { target: resolvedTarget } : {}),
      ...(kind !== 'delete' ? { content: body.content as string } : {}),
      startRel: typeof body.startRel === 'string' && body.startRel.trim()
        ? body.startRel.trim()
        : (selectionMetadata?.startRel ?? (anchor ? `char:${anchor.strippedStart}` : undefined)),
      endRel: typeof body.endRel === 'string' && body.endRel.trim()
        ? body.endRel.trim()
        : (selectionMetadata?.endRel ?? (anchor ? `char:${anchor.strippedEnd}` : undefined)),
      ...(providedRange ? { range: providedRange } : {}),
    };

    return persistMarksAsync(slug, doc, marks, by, `suggestion.${kind}.added`, {
      markId: id,
      by,
      quote,
      content: typeof body.content === 'string' ? body.content : undefined,
    }, context);
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
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  let quote = normalizeQuote(body.quote);
  if (!quote && isRecord(body.selector) && typeof body.selector.quote === 'string') {
    quote = normalizeQuote(body.selector.quote);
  }
  let target: AnchorTarget | undefined;
  if (isRecord(body.target)) {
    const parsed = parseAnchorTarget(body.target);
    if (!parsed.ok) return { status: 400, body: { success: false, error: parsed.error } };
    target = parsed.target;
  } else if (quote) {
    target = buildImplicitLegacyTarget(quote);
  }
  if (!target) return { status: 400, body: { success: false, error: 'Missing quote' } };
  if ((kind === 'insert' || kind === 'replace') && typeof body.content !== 'string') {
    return { status: 400, body: { success: false, error: 'Missing content' } };
  }

  let stabilizedTarget: AnchorTarget | undefined;
  let selectionMetadata: { quote: string; startRel?: string; endRel?: string } | null = null;
  if (isRecord(body.target)) {
    const resolved = resolveMutationAnchor(`POST /marks/suggest-${kind}`, doc.markdown, target, 'Suggestion anchor quote not found in document');
    if (!resolved.ok) return resolved.result;
    stabilizedTarget = stabilizeAnchorTarget(resolved.logicalSource, resolved.normalizedTarget, resolved.resolved);
    selectionMetadata = buildStoredSelectionMetadata(
      doc.markdown,
      resolved.resolved.selection,
      quote || resolved.normalizedTarget.anchor,
    );
    quote = selectionMetadata.quote;
  } else {
    const anchorCheck = findQuoteAnchorInMarkdown(doc.markdown, quote);
    if (!anchorCheck) {
      return {
        status: 409,
        body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion anchor quote not found in document' },
      };
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const marks = parseMarks(doc.marks);
  const anchor = quote ? findQuoteAnchorInMarkdown(doc.markdown, quote) : null;
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
    ...(stabilizedTarget ? { target: stabilizedTarget } : {}),
    ...(kind !== 'delete' ? { content: body.content as string } : {}),
    startRel: typeof body.startRel === 'string' && body.startRel.trim()
      ? body.startRel.trim()
      : (selectionMetadata?.startRel ?? (anchor ? `char:${anchor.strippedStart}` : undefined)),
    endRel: typeof body.endRel === 'string' && body.endRel.trim()
      ? body.endRel.trim()
      : (selectionMetadata?.endRel ?? (anchor ? `char:${anchor.strippedEnd}` : undefined)),
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
    ...buildCanonicalMutationBaseArgs(doc, context),
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

  const eventId = addDocumentEvent(
    slug,
    'suggestion.accepted',
    { markId: id, status: 'accepted', by },
    by,
    mutationContextIdempotencyKey(context),
    mutationContextIdempotencyRoute(context),
  );
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
  const ready = await getMutationReadyDocumentAsync(slug, context);
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
    if (!context?.mutationBase) {
      return updateSuggestionStatus(slug, body, status, doc);
    }
    const nextMarks: Record<string, StoredMark> = {
      ...marks,
      [markId]: { ...existing, status },
    };
    const result = await persistMarksAsync(
      slug,
      doc,
      nextMarks,
      actor,
      `suggestion.${status}`,
      { markId, status, by: actor },
      context,
    );
    if (result.status >= 200 && result.status < 300) {
      const updated = getDocumentBySlug(slug);
      const resolvedRevision = typeof updated?.revision === 'number' ? updated.revision : (doc.revision + 1);
      upsertMarkTombstone(slug, markId, status, resolvedRevision);
      if (status === 'rejected') {
        if ((updated?.access_epoch ?? doc.access_epoch) === doc.access_epoch) {
          bumpDocumentAccessEpoch(slug);
        }
        invalidateCollabDocument(slug);
      }
    }
    return result;
  }

  let marksForRehydration = marks;
  if (isRecord(existing.target)) {
    const parsedTarget = parseAnchorTarget(existing.target);
    if (!parsedTarget.ok) {
      return { status: 409, body: { success: false, code: 'ANCHOR_NOT_FOUND', error: 'Suggestion target metadata is invalid' } };
    }
    const resolved = resolveMutationAnchor(
      status === 'accepted' ? 'POST /marks/accept' : 'POST /marks/reject',
      doc.markdown,
      parsedTarget.target,
      'Suggestion anchor quote not found in document',
    );
    if (!resolved.ok) return resolved.result;
    const stabilizedTarget = stabilizeAnchorTarget(
      resolved.logicalSource,
      resolved.normalizedTarget,
      resolved.resolved,
    );
    const selectionMetadata = buildStoredSelectionMetadata(
      doc.markdown,
      resolved.resolved.selection,
      typeof existing.quote === 'string' ? existing.quote : resolved.normalizedTarget.anchor,
    );
    marksForRehydration = {
      ...marks,
      [markId]: {
        ...existing,
        target: stabilizedTarget,
        quote: selectionMetadata.quote,
        ...(selectionMetadata.startRel ? { startRel: selectionMetadata.startRel } : {}),
        ...(selectionMetadata.endRel ? { endRel: selectionMetadata.endRel } : {}),
      },
    };
  }

  const structuredResult = await finalizeSuggestionThroughRehydration({
    markdown: doc.markdown,
    marks: marksForRehydration,
    markId,
    action: status === 'accepted' ? 'accept' : 'reject',
  });
  if (!structuredResult.ok) {
    if (
      status === 'rejected'
      && structuredResult.code === 'MARK_NOT_HYDRATED'
      && canRejectSuggestionWithoutHydration(doc.markdown, existing)
    ) {
      const nextMarks = { ...marks };
      delete nextMarks[markId];
      const mutation = await mutateCanonicalDocument({
        slug,
        nextMarkdown: doc.markdown,
        nextMarks: nextMarks as unknown as Record<string, unknown>,
        source: `engine:${status}:${actor}:fallback`,
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

      const eventId = addDocumentEvent(
        slug,
        `suggestion.${status}`,
        { markId, status, by: actor },
        actor,
        mutationContextIdempotencyKey(context),
        mutationContextIdempotencyRoute(context),
      );
      upsertMarkTombstone(slug, markId, status, mutation.document.revision);
      const updatedMarks = parseMarks(mutation.document.marks);
      const responseMarks: Record<string, StoredMark> = {
        ...updatedMarks,
        [markId]: {
          ...existing,
          ...(updatedMarks[markId] ?? {}),
          status,
        },
      };
      if ((mutation.document.access_epoch ?? doc.access_epoch) === doc.access_epoch) {
        bumpDocumentAccessEpoch(slug);
      }
      invalidateCollabDocument(slug);

      return {
        status: 200,
        body: {
          success: true,
          eventId,
          shareState: mutation.document.share_state,
          updatedAt: mutation.document.updated_at,
          content: mutation.document.markdown,
          markdown: mutation.document.markdown,
          marks: responseMarks,
        },
      };
    }
    return toStructuredMutationFailureResult(structuredResult, 'Suggestion anchor quote not found in document');
  }

  const mutation = await mutateCanonicalDocument({
    slug,
    nextMarkdown: structuredResult.markdown,
    nextMarks: structuredResult.marks as unknown as Record<string, unknown>,
    source: `engine:${status}:${actor}`,
    ...buildCanonicalMutationBaseArgs(doc, context),
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

  const eventId = addDocumentEvent(
    slug,
    `suggestion.${status}`,
    { markId, status, by: actor },
    actor,
    mutationContextIdempotencyKey(context),
    mutationContextIdempotencyRoute(context),
  );
  upsertMarkTombstone(slug, markId, status, mutation.document.revision);
  const updatedMarks = parseMarks(mutation.document.marks);
  const responseMarks: Record<string, StoredMark> = {
    ...updatedMarks,
    [markId]: {
      ...existing,
      ...(updatedMarks[markId] ?? {}),
      status,
    },
  };
  if (status === 'rejected') {
    if ((mutation.document.access_epoch ?? doc.access_epoch) === doc.access_epoch) {
      bumpDocumentAccessEpoch(slug);
    }
    invalidateCollabDocument(slug);
  }

  return {
    status: 200,
    body: {
      success: true,
      eventId,
      shareState: mutation.document.share_state,
      updatedAt: mutation.document.updated_at,
      content: mutation.document.markdown,
      markdown: mutation.document.markdown,
      marks: responseMarks,
    },
  };
}

function resolveComment(
  slug: string,
  body: JsonRecord,
  context?: MutationReadyDocument | AsyncDocumentMutationContext,
): EngineExecutionResult {
  const ready = resolveReadyDocument(slug, context);
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

async function resolveCommentAsync(
  slug: string,
  body: JsonRecord,
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  const ready = await getMutationReadyDocumentAsync(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const markId = typeof body.markId === 'string' ? body.markId : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing) return { status: 404, body: { success: false, error: 'Mark not found' } };
  marks[markId] = { ...existing, resolved: true };
  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'owner';
  const result = await persistMarksAsync(slug, doc, marks, actor, 'comment.resolved', { markId, by: actor }, context);
  if (result.status >= 200 && result.status < 300) {
    const updated = getDocumentBySlug(slug);
    const resolvedRevision = typeof updated?.revision === 'number' ? updated.revision : (doc.revision + 1);
    upsertMarkTombstone(slug, markId, 'resolved', resolvedRevision);
  }
  return result;
}

function unresolveComment(
  slug: string,
  body: JsonRecord,
  context?: MutationReadyDocument | AsyncDocumentMutationContext,
): EngineExecutionResult {
  const ready = resolveReadyDocument(slug, context);
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

async function unresolveCommentAsync(
  slug: string,
  body: JsonRecord,
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  const ready = await getMutationReadyDocumentAsync(slug, context);
  if (ready.error) return ready.error;
  const doc = ready.doc;
  const markId = typeof body.markId === 'string' ? body.markId : '';
  if (!markId) return { status: 400, body: { success: false, error: 'Missing markId' } };

  const marks = parseMarks(doc.marks);
  const existing = marks[markId];
  if (!existing) return { status: 404, body: { success: false, error: 'Mark not found' } };
  marks[markId] = { ...existing, resolved: false };
  const actor = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'owner';
  return persistMarksAsync(slug, doc, marks, actor, 'comment.unresolved', { markId, by: actor }, context);
}

function replyComment(
  slug: string,
  body: JsonRecord,
  context?: MutationReadyDocument | AsyncDocumentMutationContext,
): EngineExecutionResult {
  const ready = resolveReadyDocument(slug, context);
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

async function replyCommentAsync(
  slug: string,
  body: JsonRecord,
  context?: AsyncDocumentMutationContext,
): Promise<EngineExecutionResult> {
  const ready = await getMutationReadyDocumentAsync(slug, context);
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
  return persistMarksAsync(slug, doc, marks, by, 'comment.replied', { markId, by, text }, context);
}

function rewriteDocument(_slug: string, _body: JsonRecord): EngineExecutionResult {
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
  if (method === 'GET' && routePath === '/state') {
    return readStateAsync(slug);
  }
  if (method === 'GET' && routePath === '/marks') {
    return readMarksAsync(slug);
  }
  if (method === 'POST' && routePath === '/marks/comment') {
    return addCommentAsync(slug, body, context);
  }
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
  if (method === 'POST' && routePath === '/marks/resolve') {
    return resolveCommentAsync(slug, body, context);
  }
  if (method === 'POST' && routePath === '/marks/unresolve') {
    return unresolveCommentAsync(slug, body, context);
  }
  if (method === 'POST' && routePath === '/marks/reply') {
    return replyCommentAsync(slug, body, context);
  }
  return executeDocumentOperation(slug, method, routePath, body);
}
