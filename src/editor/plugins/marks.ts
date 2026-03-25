/**
 * Unified Marks Plugin for ProseMirror/Milkdown
 *
 * Anchors live as inline marks in the document (portable Markdown spans).
 * Metadata (comment text, suggestion content/status) lives in the PROOF block.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { Fragment } from '@milkdown/kit/prose/model';
import type { Node as ProseMirrorNode, MarkType } from '@milkdown/kit/prose/model';
import { ySyncPluginKey } from 'y-prosemirror';
import { buildTextIndex, getTextForRange, mapTextOffsetsToRange, resolveQuoteRange } from '../utils/text-range';
import { SHARE_CONTENT_FILTER_ALLOW_META } from './share-content-filter';
import { getAuthoredDecorationStyle } from './authorship-color';

import {
  type Mark,
  type MarkKind,
  type MarkRange,
  type CommentData,
  type CommentReply,
  type InsertData,
  type DeleteData,
  type ReplaceData,
  type SuggestionStatus,
  type StoredMark,
  type OrchestratedMarkMeta,
  normalizeQuote,
  createApproval,
  createFlag,
  createComment,
  createInsertSuggestion,
  createDeleteSuggestion,
  createReplaceSuggestion,
  getPendingSuggestions,
  calculateAuthorshipStats,
  canonicalizeStoredMarks,
} from '../../formats/marks.js';

// ============================================================================
// Plugin State
// ============================================================================

export interface MarksPluginState {
  metadata: Record<string, StoredMark>;
  activeMarkId: string | null;
  composeAnchorRange?: MarkRange | null;
}

export const marksPluginKey = new PluginKey<MarksPluginState>('marks');

export const marksCtx = $ctx<MarksPluginState, 'marks'>(
  { metadata: {}, activeMarkId: null, composeAnchorRange: null },
  'marks'
);

// ============================================================================
// Resolved Mark (with document position)
// ============================================================================

export interface ResolvedMark extends Mark {
  resolvedRange: { from: number; to: number } | null;
  resolvedRanges?: MarkRange[];
}

// ============================================================================
// Helpers
// ============================================================================

const MARK_TYPE_NAMES = {
  suggestion: 'proofSuggestion',
  comment: 'proofComment',
  flagged: 'proofFlagged',
  approved: 'proofApproved',
  authored: 'proofAuthored',
};

const RESOLVED_MARK_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
const RESOLVED_COMMENT_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
const MARK_ANCHOR_HYDRATION_FAILURE_TTL_MS = 2 * 60 * 1000;
const AUTHORED_ANCHOR_HYDRATION_FAILURE_BUDGET_PER_PASS = 20;
type MarkTombstoneReason = 'resolved' | 'deleted';
type MarkTombstone = { expiresAt: number; reason: MarkTombstoneReason };
const resolvedMarkTombstones = new Map<string, MarkTombstone>();
type MarkAnchorHydrationFailure = { docFingerprint: string; lastAttemptAt: number };
const markAnchorHydrationFailures = new Map<string, MarkAnchorHydrationFailure>();

function reportMarkAnchorResolution(result: 'success' | 'failure'): void {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  if (!path.startsWith('/d/')) return;
  const url = `${window.location.origin}/api/metrics/mark-anchor`;
  const payload = JSON.stringify({ result, source: 'web' });
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      return;
    } catch {
      // fall through
    }
  }
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // best-effort observability only
  });
}

function shouldReportMarkAnchorResolution(kind: MarkKind): boolean {
  return kind !== 'authored';
}

function pruneResolvedMarkTombstones(now: number = Date.now()): void {
  for (const [id, tombstone] of resolvedMarkTombstones.entries()) {
    if (tombstone.expiresAt <= now) {
      resolvedMarkTombstones.delete(id);
    }
  }
}

function hashStringFNV1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function getHydrationDocumentId(): string | null {
  if (typeof window === 'undefined') return null;
  const config = (window as Window & { __PROOF_CONFIG__?: { documentId?: string } }).__PROOF_CONFIG__;
  const documentId = typeof config?.documentId === 'string' ? config.documentId.trim() : '';
  return documentId.length > 0 ? documentId : null;
}

function buildMarkAnchorHydrationDocFingerprint(doc: ProseMirrorNode): string {
  const size = doc.content.size;
  const text = doc.textBetween(0, size, '\n', '\n');
  const textHash = hashStringFNV1a(text);
  const documentId = getHydrationDocumentId();
  const base = `${size}:${doc.childCount}:${textHash}`;
  return documentId ? `doc:${documentId}:${base}` : `hash:${base}`;
}

function pruneMarkAnchorHydrationFailures(now: number = Date.now()): void {
  for (const [id, entry] of markAnchorHydrationFailures.entries()) {
    if (now - entry.lastAttemptAt >= MARK_ANCHOR_HYDRATION_FAILURE_TTL_MS) {
      markAnchorHydrationFailures.delete(id);
    }
  }
}

function shouldAttemptMarkAnchorHydration(
  id: string,
  doc: ProseMirrorNode,
  now: number = Date.now()
): boolean {
  const entry = markAnchorHydrationFailures.get(id);
  if (!entry) return true;
  if (now - entry.lastAttemptAt >= MARK_ANCHOR_HYDRATION_FAILURE_TTL_MS) {
    markAnchorHydrationFailures.delete(id);
    return true;
  }
  const docFingerprint = buildMarkAnchorHydrationDocFingerprint(doc);
  if (entry.docFingerprint !== docFingerprint) {
    markAnchorHydrationFailures.delete(id);
    return true;
  }
  return false;
}

function recordMarkAnchorHydrationFailure(id: string, doc: ProseMirrorNode, now: number = Date.now()): void {
  markAnchorHydrationFailures.set(id, {
    docFingerprint: buildMarkAnchorHydrationDocFingerprint(doc),
    lastAttemptAt: now,
  });
}

function clearMarkAnchorHydrationFailure(id: string): void {
  markAnchorHydrationFailures.delete(id);
}

// Test-only visibility into hydration throttling state.
export function __getMarkAnchorHydrationFailure(id: string): MarkAnchorHydrationFailure | null {
  return markAnchorHydrationFailures.get(id) ?? null;
}

export function __resetMarkAnchorHydrationFailures(): void {
  markAnchorHydrationFailures.clear();
}

export function __getMarkAnchorHydrationFailureCount(): number {
  return markAnchorHydrationFailures.size;
}

function markResolvedMarkIds(
  ids: string[],
  now: number = Date.now(),
  ttlMs: number = RESOLVED_MARK_TOMBSTONE_TTL_MS,
  reason: MarkTombstoneReason = 'deleted'
): void {
  if (ids.length === 0) return;
  pruneResolvedMarkTombstones(now);
  const expiresAt = now + ttlMs;
  for (const id of ids) {
    if (!id) continue;
    resolvedMarkTombstones.set(id, { expiresAt, reason });
  }
}

function isResolvedMarkTombstoned(
  id: string,
  now: number = Date.now(),
  reason?: MarkTombstoneReason
): boolean {
  const tombstone = resolvedMarkTombstones.get(id);
  if (!tombstone) return false;
  if (tombstone.expiresAt <= now) {
    resolvedMarkTombstones.delete(id);
    return false;
  }
  if (reason) return tombstone.reason === reason;
  return true;
}

type AnchorInfo = {
  id: string;
  kind: MarkKind;
  by: string;
  from: number;
  to: number;
  attrMeta?: Partial<StoredMark>;
};

function getMarkTypeForKind(state: EditorState, kind: MarkKind): MarkType | null {
  switch (kind) {
    case 'insert':
    case 'delete':
    case 'replace':
      return state.schema.marks[MARK_TYPE_NAMES.suggestion] ?? null;
    case 'comment':
      return state.schema.marks[MARK_TYPE_NAMES.comment] ?? null;
    case 'flagged':
      return state.schema.marks[MARK_TYPE_NAMES.flagged] ?? null;
    case 'approved':
      return state.schema.marks[MARK_TYPE_NAMES.approved] ?? null;
    case 'authored':
      return state.schema.marks[MARK_TYPE_NAMES.authored] ?? null;
  }
}

function resolveRangeFromQuote(doc: ProseMirrorNode, quote: string): MarkRange | null {
  return resolveQuoteRange(doc, quote);
}

function parseRelativeCharOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^char:(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function resolveRangeFromRelativeAnchors(
  doc: ProseMirrorNode,
  startRel: unknown,
  endRel: unknown
): MarkRange | null {
  const startOffset = parseRelativeCharOffset(startRel);
  const endOffset = parseRelativeCharOffset(endRel);
  if (startOffset === null || endOffset === null || endOffset <= startOffset) return null;
  const index = buildTextIndex(doc);
  if (!index) return null;
  return mapTextOffsetsToRange(index, startOffset, endOffset);
}

function resolveStoredMarkRange(doc: ProseMirrorNode, stored: StoredMark): MarkRange | null {
  const normalizedStoredQuote = typeof stored.quote === 'string'
    ? normalizeQuote(stored.quote)
    : '';
  const allowsQuoteLessAnchorFallback = stored.kind === 'authored';

  const relativeRange = resolveRangeFromRelativeAnchors(doc, stored.startRel, stored.endRel);
  if (relativeRange) {
    if (!normalizedStoredQuote) {
      if (allowsQuoteLessAnchorFallback) {
        return relativeRange;
      }
    } else {
      const actualRelativeQuote = normalizeQuote(getTextForRange(doc, relativeRange));
      if (actualRelativeQuote === normalizedStoredQuote) {
        return relativeRange;
      }
    }
  }

  const storedRange = stored.range;
  if (
    storedRange
    && typeof storedRange.from === 'number'
    && typeof storedRange.to === 'number'
    && Number.isFinite(storedRange.from)
    && Number.isFinite(storedRange.to)
    && storedRange.from >= 0
    && storedRange.to > storedRange.from
    && storedRange.to <= doc.content.size
  ) {
    const candidateRange = { from: storedRange.from, to: storedRange.to };
    if (!normalizedStoredQuote) {
      if (allowsQuoteLessAnchorFallback) {
        return candidateRange;
      }
    } else {
      const actualQuote = normalizeQuote(getTextForRange(doc, candidateRange));
      if (actualQuote === normalizedStoredQuote) {
        return candidateRange;
      }
    }
  }

  if (!normalizedStoredQuote) return null;
  return resolveRangeFromQuote(doc, normalizedStoredQuote);
}

function addRelativeAnchorsToMetadata(
  doc: ProseMirrorNode,
  mark: Mark,
  meta: StoredMark
): void {
  if (!mark.range) return;
  const index = buildTextIndex(doc);
  if (!index) return;

  let startOffset = -1;
  let endOffset = -1;
  for (let i = 0; i < index.positions.length; i += 1) {
    const pos = index.positions[i];
    if (typeof pos !== 'number') continue;
    if (startOffset < 0 && pos >= mark.range.from) {
      startOffset = i;
    }
    if (pos < mark.range.to) {
      endOffset = i + 1;
    }
  }

  if (startOffset >= 0 && endOffset > startOffset) {
    meta.startRel = `char:${startOffset}`;
    meta.endRel = `char:${endOffset}`;
  }
}

function isWordChar(char: string | undefined): boolean {
  return Boolean(char) && /[A-Za-z0-9]/.test(char as string);
}

function isMidWordAnchor(doc: ProseMirrorNode, range: MarkRange, actualQuote: string): boolean {
  if (!actualQuote) return false;
  const charBefore = range.from > 0
    ? doc.textBetween(range.from - 1, range.from, '\n', '\n').slice(-1)
    : '';
  const charAfter = range.to < doc.content.size
    ? doc.textBetween(range.to, range.to + 1, '\n', '\n').slice(0, 1)
    : '';
  const firstChar = actualQuote[0];
  const lastChar = actualQuote[actualQuote.length - 1];
  const midWordStart = isWordChar(charBefore) && isWordChar(firstChar);
  const midWordEnd = isWordChar(lastChar) && isWordChar(charAfter);
  return midWordStart || midWordEnd;
}

function resolveRangeWithValidation(
  doc: ProseMirrorNode,
  quote: string,
  range?: MarkRange
): { range: MarkRange | null; actualQuote: string; rangeProvided: boolean } {
  const rangeProvided = Boolean(range);
  let resolvedRange = range ?? resolveRangeFromQuote(doc, quote);
  if (!resolvedRange) {
    return { range: null, actualQuote: quote, rangeProvided };
  }

  let actualQuote = getTextForRange(doc, resolvedRange);
  if (rangeProvided) {
    const expectedNormalized = normalizeQuote(quote);
    const actualNormalized = normalizeQuote(actualQuote);
    if (expectedNormalized && actualNormalized && expectedNormalized !== actualNormalized) {
      console.warn('[marks] Provided range does not match quote; attempting to re-resolve.', {
        expected: quote.slice(0, 80),
        actual: actualQuote.slice(0, 80),
      });
      const freshRange = resolveRangeFromQuote(doc, quote);
      if (freshRange) {
        resolvedRange = freshRange;
        actualQuote = getTextForRange(doc, freshRange);
      } else {
        console.warn('[marks] Failed to re-resolve quote after range mismatch; rejecting mark.');
        return { range: null, actualQuote: quote, rangeProvided };
      }
    }
  }

  const midWord = isMidWordAnchor(doc, resolvedRange, actualQuote);
  if (midWord) {
    console.warn('[marks] Range appears to anchor mid-word; attempting to re-resolve.', {
      quote: quote.slice(0, 80),
      actual: actualQuote.slice(0, 80),
    });
    const freshRange = resolveRangeFromQuote(doc, quote);
    if (freshRange) {
      const freshQuote = getTextForRange(doc, freshRange);
      const freshMidWord = isMidWordAnchor(doc, freshRange, freshQuote);
      if (!freshMidWord) {
        resolvedRange = freshRange;
        actualQuote = freshQuote;
      } else {
        console.warn('[marks] Re-resolved range still anchors mid-word; rejecting mark.');
        return { range: null, actualQuote: quote, rangeProvided };
      }
    } else {
      console.warn('[marks] Unable to resolve non-mid-word range; rejecting mark.');
      return { range: null, actualQuote: quote, rangeProvided };
    }
  }

  return { range: resolvedRange, actualQuote, rangeProvided };
}

const TABLE_CELL_NODE_NAMES = new Set([
  'table_cell',
  'tableCell',
  'table_header',
  'tableHeader',
]);

function resolveTableCellIdentity(doc: ProseMirrorNode, pos: number): string | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (!TABLE_CELL_NODE_NAMES.has(node.type.name)) continue;
    return `${$pos.before(depth)}:${$pos.after(depth)}:${depth}`;
  }
  return null;
}

export function rangeCrossesTableCellBoundary(doc: ProseMirrorNode, range: MarkRange): boolean {
  if (range.to <= range.from) return false;
  const startCell = resolveTableCellIdentity(doc, range.from);
  const endProbe = Math.max(range.from, range.to - 1);
  const endCell = resolveTableCellIdentity(doc, endProbe);

  if (!startCell && !endCell) return false;
  return startCell !== endCell;
}

export function debugResolveRangeWithValidation(
  doc: ProseMirrorNode,
  quote: string,
  range?: MarkRange,
): {
  ok: boolean;
  reason:
    | 'unresolved'
    | 'range-quote-mismatch-re-resolve-failed'
    | 'range-quote-mismatch-re-resolve-midword'
    | 'midword-re-resolve-failed'
    | 'midword-re-resolve-still-midword'
    | 'resolved';
  rangeProvided: boolean;
  requestedRange: MarkRange | null;
  resolvedRange: MarkRange | null;
  actualQuote: string;
  expectedNormalized: string;
  actualNormalized: string;
  mismatch: boolean;
  midWord: boolean;
} {
  const rangeProvided = Boolean(range);
  const requestedRange = range ?? null;
  let resolvedRange = range ?? resolveRangeFromQuote(doc, quote);
  if (!resolvedRange) {
    return {
      ok: false,
      reason: 'unresolved',
      rangeProvided,
      requestedRange,
      resolvedRange: null,
      actualQuote: quote,
      expectedNormalized: normalizeQuote(quote),
      actualNormalized: '',
      mismatch: false,
      midWord: false,
    };
  }

  let actualQuote = getTextForRange(doc, resolvedRange);
  const expectedNormalized = normalizeQuote(quote);
  let actualNormalized = normalizeQuote(actualQuote);
  let mismatch = Boolean(expectedNormalized && actualNormalized && expectedNormalized !== actualNormalized);

  if (rangeProvided && mismatch) {
    const freshRange = resolveRangeFromQuote(doc, quote);
    if (!freshRange) {
      return {
        ok: false,
        reason: 'range-quote-mismatch-re-resolve-failed',
        rangeProvided,
        requestedRange,
        resolvedRange: null,
        actualQuote,
        expectedNormalized,
        actualNormalized,
        mismatch: true,
        midWord: isMidWordAnchor(doc, resolvedRange, actualQuote),
      };
    }
    const freshQuote = getTextForRange(doc, freshRange);
    const freshMidWord = isMidWordAnchor(doc, freshRange, freshQuote);
    if (freshMidWord) {
      return {
        ok: false,
        reason: 'range-quote-mismatch-re-resolve-midword',
        rangeProvided,
        requestedRange,
        resolvedRange: null,
        actualQuote: freshQuote,
        expectedNormalized,
        actualNormalized: normalizeQuote(freshQuote),
        mismatch: true,
        midWord: true,
      };
    }
    resolvedRange = freshRange;
    actualQuote = freshQuote;
    actualNormalized = normalizeQuote(actualQuote);
    mismatch = Boolean(expectedNormalized && actualNormalized && expectedNormalized !== actualNormalized);
  }

  const midWord = isMidWordAnchor(doc, resolvedRange, actualQuote);
  if (midWord) {
    const freshRange = resolveRangeFromQuote(doc, quote);
    if (!freshRange) {
      return {
        ok: false,
        reason: 'midword-re-resolve-failed',
        rangeProvided,
        requestedRange,
        resolvedRange: null,
        actualQuote,
        expectedNormalized,
        actualNormalized,
        mismatch,
        midWord: true,
      };
    }
    const freshQuote = getTextForRange(doc, freshRange);
    const freshMidWord = isMidWordAnchor(doc, freshRange, freshQuote);
    if (freshMidWord) {
      return {
        ok: false,
        reason: 'midword-re-resolve-still-midword',
        rangeProvided,
        requestedRange,
        resolvedRange: null,
        actualQuote: freshQuote,
        expectedNormalized,
        actualNormalized: normalizeQuote(freshQuote),
        mismatch,
        midWord: true,
      };
    }
    resolvedRange = freshRange;
    actualQuote = freshQuote;
    actualNormalized = normalizeQuote(actualQuote);
  }

  return {
    ok: true,
    reason: 'resolved',
    rangeProvided,
    requestedRange,
    resolvedRange,
    actualQuote,
    expectedNormalized,
    actualNormalized,
    mismatch,
    midWord,
  };
}

function isProseMirrorNode(value: unknown): value is ProseMirrorNode {
  return typeof value === 'object' && value !== null && 'type' in (value as Record<string, unknown>);
}

function buildReplacementContent(
  doc: ProseMirrorNode,
  range: MarkRange,
  markdown: string,
  parser: MarkdownParser | undefined,
  schemaText: (text: string) => ProseMirrorNode
): {
  content: ProseMirrorNode | ProseMirrorNode['content'];
  size: number;
  authoredInline: boolean;
  usedParsed: boolean;
} {
  const parent = doc.resolve(range.from).parent;
  const authoredInline = parent.type.inlineContent;

  const fallbackNode = schemaText(markdown);
  const fallback = {
    content: fallbackNode,
    size: fallbackNode.nodeSize,
    authoredInline,
    usedParsed: false,
  } as const;

  if (!parser) return fallback;

  let parsed: ProseMirrorNode;
  try {
    parsed = parser(markdown);
  } catch (error) {
    console.warn('[marks.accept] Failed to parse markdown during accept; falling back to text:', error);
    return fallback;
  }

  let candidate: ProseMirrorNode | ProseMirrorNode['content'] | null = null;

  if (parent.type.inlineContent) {
    // For inline replacements, extract inline content from a single parsed textblock.
    if (parsed.content.childCount === 1) {
      const firstBlock = parsed.content.child(0);
      if (firstBlock.isTextblock) {
        candidate = firstBlock.content;
      }
    }
  } else {
    candidate = parsed.content;
  }

  if (!candidate) {
    return fallback;
  }

  const candidateContent = isProseMirrorNode(candidate) ? candidate.content : candidate;
  if (!parent.type.validContent(candidateContent)) {
    return fallback;
  }

  if (parent.type.inlineContent) {
    const leadingWhitespace = markdown.match(/^\s+/)?.[0] ?? '';
    const trailingWhitespace = markdown.match(/\s+$/)?.[0] ?? '';
    if (leadingWhitespace.length > 0 || trailingWhitespace.length > 0) {
      const parsedText = candidateContent.textBetween(0, candidateContent.size, '\n', '\n');
      const droppedLeading = leadingWhitespace.length > 0 && !parsedText.startsWith(leadingWhitespace);
      const droppedTrailing = trailingWhitespace.length > 0 && !parsedText.endsWith(trailingWhitespace);
      if (droppedLeading || droppedTrailing) {
        // Keep literal text when markdown parsing would strip intentional edge whitespace.
        return fallback;
      }
    }
  }

  const size = isProseMirrorNode(candidate) ? candidate.nodeSize : candidate.size;
  if (size <= 0) {
    return fallback;
  }

  return {
    content: candidate,
    size,
    authoredInline,
    usedParsed: true,
  };
}

function buildPreservedTextblockContent(
  doc: ProseMirrorNode,
  range: MarkRange,
  markdown: string,
  parser: MarkdownParser | undefined,
  schemaText: (text: string) => ProseMirrorNode
): {
  content: ProseMirrorNode | ProseMirrorNode['content'];
  size: number;
} | null {
  const parent = doc.resolve(range.from).parent;
  if (!parent.isTextblock) return null;

  const parsedFragment = parseMarkdownFragment(parser, markdown);
  if (parsedFragment && parsedFragment.childCount > 0) {
    const unwrappedParagraph = unwrapSingleParagraph(parsedFragment);
    if (unwrappedParagraph && parent.type.validContent(unwrappedParagraph)) {
      return {
        content: unwrappedParagraph,
        size: unwrappedParagraph.size,
      };
    }

    if (!fragmentHasBlockNodes(parsedFragment) && parent.type.validContent(parsedFragment)) {
      return {
        content: parsedFragment,
        size: parsedFragment.size,
      };
    }
  }

  const fallbackNode = schemaText(markdown);
  const fallbackContent = Fragment.from(fallbackNode);
  if (!parent.type.validContent(fallbackContent)) {
    return null;
  }

  return {
    content: fallbackContent,
    size: fallbackContent.size,
  };
}

function addAuthoredMarkToTransaction(
  state: EditorState,
  tr: Transaction,
  range: MarkRange,
  by: string
): Transaction {
  const markType = getMarkTypeForKind(state, 'authored');
  if (!markType) return tr;
  tr = tr.removeMark(range.from, range.to, markType);
  tr = tr.addMark(range.from, range.to, markType.create({ by }));
  return tr;
}

function normalizeSuggestionKind(kind: string | null | undefined): 'insert' | 'delete' | 'replace' {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function extractOrchestrationMeta(meta: StoredMark | undefined): OrchestratedMarkMeta {
  if (!meta) return {};
  return {
    runId: meta.runId,
    focusAreaId: meta.focusAreaId,
    focusAreaName: meta.focusAreaName,
    agentId: meta.agentId,
    proposalId: meta.proposalId,
    provisional: meta.provisional,
    orchestrator: meta.orchestrator,
    debugAutoFixedQuotes: meta.debugAutoFixedQuotes,
    debugAutoFixedQuotesReason: meta.debugAutoFixedQuotesReason,
  };
}

function parseBooleanAttr(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function parseSuggestionStatus(value: unknown): SuggestionStatus | undefined {
  if (value === 'pending' || value === 'accepted' || value === 'rejected') return value;
  return undefined;
}

function extractSuggestionMetaFromAttrs(attrs: Record<string, unknown>): Partial<StoredMark> {
  const meta: Partial<StoredMark> = {};

  if (typeof attrs.content === 'string') meta.content = attrs.content;
  const status = parseSuggestionStatus(attrs.status);
  if (status) meta.status = status;
  if (typeof attrs.createdAt === 'string' && attrs.createdAt.trim()) meta.createdAt = attrs.createdAt;

  if (typeof attrs.runId === 'string' && attrs.runId.trim()) meta.runId = attrs.runId;
  if (typeof attrs.focusAreaId === 'string' && attrs.focusAreaId.trim()) meta.focusAreaId = attrs.focusAreaId;
  if (typeof attrs.focusAreaName === 'string' && attrs.focusAreaName.trim()) meta.focusAreaName = attrs.focusAreaName;
  if (typeof attrs.agentId === 'string' && attrs.agentId.trim()) meta.agentId = attrs.agentId;
  if (typeof attrs.proposalId === 'string' && attrs.proposalId.trim()) meta.proposalId = attrs.proposalId;
  if (typeof attrs.debugAutoFixedQuotesReason === 'string' && attrs.debugAutoFixedQuotesReason.trim()) {
    meta.debugAutoFixedQuotesReason = attrs.debugAutoFixedQuotesReason;
  }

  const provisional = parseBooleanAttr(attrs.provisional);
  if (provisional !== undefined) meta.provisional = provisional;
  const orchestrator = parseBooleanAttr(attrs.orchestrator);
  if (orchestrator !== undefined) meta.orchestrator = orchestrator;
  const debugAutoFixedQuotes = parseBooleanAttr(attrs.debugAutoFixedQuotes);
  if (debugAutoFixedQuotes !== undefined) meta.debugAutoFixedQuotes = debugAutoFixedQuotes;

  return meta;
}

function buildSuggestionAttrs(
  id: string,
  kind: 'insert' | 'delete' | 'replace',
  by: string,
  meta: Partial<StoredMark> | undefined
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    id,
    kind,
    by,
    content: null,
    status: null,
    createdAt: null,
    runId: null,
    focusAreaId: null,
    focusAreaName: null,
    agentId: null,
    proposalId: null,
    provisional: null,
    orchestrator: null,
    debugAutoFixedQuotes: null,
    debugAutoFixedQuotesReason: null,
  };

  if (!meta) return attrs;

  if ((kind === 'insert' || kind === 'replace') && typeof meta.content === 'string') {
    attrs.content = meta.content;
  }
  if (meta.status) attrs.status = meta.status;
  if (meta.createdAt) attrs.createdAt = meta.createdAt;
  if (meta.runId) attrs.runId = meta.runId;
  if (meta.focusAreaId) attrs.focusAreaId = meta.focusAreaId;
  if (meta.focusAreaName) attrs.focusAreaName = meta.focusAreaName;
  if (meta.agentId) attrs.agentId = meta.agentId;
  if (meta.proposalId) attrs.proposalId = meta.proposalId;
  if (typeof meta.provisional === 'boolean') attrs.provisional = meta.provisional;
  if (typeof meta.orchestrator === 'boolean') attrs.orchestrator = meta.orchestrator;
  if (typeof meta.debugAutoFixedQuotes === 'boolean') attrs.debugAutoFixedQuotes = meta.debugAutoFixedQuotes;
  if (meta.debugAutoFixedQuotesReason) attrs.debugAutoFixedQuotesReason = meta.debugAutoFixedQuotesReason;

  return attrs;
}

function suggestionAttrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key] === undefined ? null : a[key];
    const bv = b[key] === undefined ? null : b[key];
    if (av !== bv) return false;
  }
  return true;
}

function stampSuggestionMetadataOnDocument(
  state: EditorState,
  tr: Transaction,
  metadata: Record<string, StoredMark>
): Transaction {
  const suggestionType = state.schema.marks[MARK_TYPE_NAMES.suggestion];
  if (!suggestionType) return tr;

  const stepsBeforeStamp = tr.steps.length;

  tr.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const from = pos;
    const to = pos + node.nodeSize;

    for (const nodeMark of node.marks) {
      if (nodeMark.type !== suggestionType) continue;
      const id = nodeMark.attrs.id as string | null;
      if (!id) continue;

      const kind = normalizeSuggestionKind(nodeMark.attrs.kind as string | null | undefined);
      const by = typeof nodeMark.attrs.by === 'string' && nodeMark.attrs.by.trim()
        ? nodeMark.attrs.by
        : 'unknown';

      const attrMeta = extractSuggestionMetaFromAttrs(nodeMark.attrs as Record<string, unknown>);
      const pluginMeta = metadata[id];
      const mergedMeta = pluginMeta ? { ...attrMeta, ...pluginMeta } : attrMeta;
      const nextAttrs = buildSuggestionAttrs(id, kind, by, mergedMeta);

      if (suggestionAttrsEqual(nodeMark.attrs as Record<string, unknown>, nextAttrs)) continue;

      tr = tr.removeMark(from, to, nodeMark);
      tr = tr.addMark(from, to, suggestionType.create(nextAttrs));
    }

    return true;
  });

  if (stepsBeforeStamp === 0 && tr.steps.length > 0) {
    tr = tr.setMeta('addToHistory', false);
  }

  return tr;
}

function finalizeMarkTransaction(
  view: EditorView,
  tr: Transaction,
  metadata: Record<string, StoredMark>,
  options?: { isRemote?: boolean; skipDocStamp?: boolean }
): void {
  const normalized = normalizeMetadata(metadata, tr.doc);
  if (!options?.skipDocStamp) {
    tr = stampSuggestionMetadataOnDocument(view.state, tr, normalized);
  }
  tr = tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata: normalized });
  if (options?.isRemote) {
    tr = tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    tr = tr.setMeta('addToHistory', false);
  }
  view.dispatch(tr);
}

function removeSuggestionAnchors(
  tr: Transaction,
  ids: Set<string>
): Transaction {
  if (ids.size === 0) return tr;

  tr.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.length === 0) return true;
    const from = pos;
    const to = pos + node.nodeSize;
    for (const nodeMark of node.marks) {
      if (nodeMark.type.name !== MARK_TYPE_NAMES.suggestion) continue;
      const id = nodeMark.attrs.id as string | null;
      if (!id || !ids.has(id)) continue;
      tr = tr.removeMark(from, to, nodeMark);
    }
    return true;
  });

  return tr;
}

function applyShareContentMutationAllowance(
  tr: Transaction,
  meta?: OrchestratedMarkMeta
): Transaction {
  if ((meta as { allowShareContentMutation?: boolean } | undefined)?.allowShareContentMutation === true) {
    return tr.setMeta(SHARE_CONTENT_FILTER_ALLOW_META, true);
  }
  return tr;
}

// --- SSE Event Emission ---
// Callback set by index.ts to forward mark events to interested runtimes
let _eventCallback: ((event: string, data: Record<string, unknown>) => void) | null = null;

export function setEventCallback(cb: (event: string, data: Record<string, unknown>) => void): void {
  _eventCallback = cb;
}

function emitMarkEvent(event: string, data: Record<string, unknown>): void {
  if (_eventCallback) {
    try { _eventCallback(event, data); } catch (e) { console.warn('[marks] event emit error:', e); }
  }
}

function buildCommentData(id: string, meta: StoredMark | undefined): CommentData {
  const threadReplies = Array.isArray(meta?.thread) ? meta.thread : [];
  const normalizedReplies = Array.isArray(meta?.replies) ? meta.replies : [];
  const replies = normalizedReplies.length >= threadReplies.length ? normalizedReplies : threadReplies;
  const threadId = typeof meta?.thread === 'string'
    ? meta?.thread
    : meta?.threadId || id;
  const orchestrationMeta = extractOrchestrationMeta(meta);

  return {
    ...orchestrationMeta,
    text: meta?.text ?? '',
    thread: threadId,
    resolved: Boolean(meta?.resolved),
    replies: replies ?? [],
  };
}

function buildSuggestionData(
  kind: MarkKind,
  meta: StoredMark | undefined,
  quote: string
): InsertData | DeleteData | ReplaceData {
  const status = meta?.status ?? 'pending';
  const orchestrationMeta = extractOrchestrationMeta(meta);

  if (kind === 'insert') {
    return {
      ...orchestrationMeta,
      content: meta?.content ?? quote,
      status,
    } as InsertData;
  }

  if (kind === 'replace') {
    return {
      ...orchestrationMeta,
      content: meta?.content ?? quote,
      status,
    } as ReplaceData;
  }

  return {
    ...orchestrationMeta,
    status,
  } as DeleteData;
}

function buildAnchorMarks(
  doc: ProseMirrorNode,
  metadata: Record<string, StoredMark>
): Mark[] {
  const anchors = new Map<string, AnchorInfo>();
  const authored: Mark[] = [];
  const authoredMetadataIds = new Map<string, string>();

  for (const [id, stored] of Object.entries(metadata)) {
    if (stored?.kind !== 'authored') continue;
    const range = resolveStoredMarkRange(doc, stored);
    if (!range) continue;
    const by = typeof stored.by === 'string' && stored.by.trim().length > 0
      ? stored.by
      : 'human:unknown';
    const key = `${by}:${range.from}-${range.to}`;
    if (!authoredMetadataIds.has(key)) {
      authoredMetadataIds.set(key, id);
    }
  }

  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const from = pos;
    const to = pos + node.nodeSize;

    for (const mark of node.marks) {
      switch (mark.type.name) {
        case MARK_TYPE_NAMES.suggestion: {
          const id = mark.attrs.id as string | null;
          if (!id) continue;
          const kind = normalizeSuggestionKind(mark.attrs.kind);
          const by = mark.attrs.by || 'unknown';
          const attrMeta = extractSuggestionMetaFromAttrs(mark.attrs as Record<string, unknown>);
          const existing = anchors.get(id);
          if (existing) {
            existing.from = Math.min(existing.from, from);
            existing.to = Math.max(existing.to, to);
            existing.attrMeta = existing.attrMeta
              ? { ...existing.attrMeta, ...attrMeta }
              : attrMeta;
          } else {
            anchors.set(id, { id, kind, by, from, to, attrMeta });
          }
          break;
        }
        case MARK_TYPE_NAMES.comment: {
          const id = mark.attrs.id as string | null;
          if (!id) continue;
          const by = mark.attrs.by || 'unknown';
          const existing = anchors.get(id);
          if (existing) {
            existing.from = Math.min(existing.from, from);
            existing.to = Math.max(existing.to, to);
          } else {
            anchors.set(id, { id, kind: 'comment', by, from, to });
          }
          break;
        }
        case MARK_TYPE_NAMES.flagged: {
          const id = mark.attrs.id as string | null;
          if (!id) continue;
          const by = mark.attrs.by || 'unknown';
          const existing = anchors.get(id);
          if (existing) {
            existing.from = Math.min(existing.from, from);
            existing.to = Math.max(existing.to, to);
          } else {
            anchors.set(id, { id, kind: 'flagged', by, from, to });
          }
          break;
        }
        case MARK_TYPE_NAMES.approved: {
          const id = mark.attrs.id as string | null;
          if (!id) continue;
          const by = mark.attrs.by || 'unknown';
          const existing = anchors.get(id);
          if (existing) {
            existing.from = Math.min(existing.from, from);
            existing.to = Math.max(existing.to, to);
          } else {
            anchors.set(id, { id, kind: 'approved', by, from, to });
          }
          break;
        }
        case MARK_TYPE_NAMES.authored: {
          const by = mark.attrs.by || 'human:unknown';
          const quote = normalizeQuote(doc.textBetween(from, to, '\n', '\n'));
          const authoredId = (mark.attrs.id as string | null)
            ?? authoredMetadataIds.get(`${by}:${from}-${to}`)
            ?? `authored:${by}:${from}-${to}`;
          authored.push({
            id: authoredId,
            kind: 'authored',
            by,
            at: '1970-01-01T00:00:00.000Z',
            range: { from, to },
            quote,
            data: {},
          });
          break;
        }
      }
    }

    return true;
  });

  const marks: Mark[] = [];

  for (const anchor of anchors.values()) {
    const pluginMeta = metadata[anchor.id];
    const meta = pluginMeta
      ? { ...(anchor.attrMeta ?? {}), ...pluginMeta }
      : anchor.attrMeta;
    const text = doc.textBetween(anchor.from, anchor.to, '\n', '\n');
    const quote = normalizeQuote(text);
    const createdAt = meta?.createdAt ?? (meta as { at?: string } | undefined)?.at ?? '';

    // Comment text lives only in metadata. If we don't have a non-empty body, treat this anchor as
    // unhydrated/invalid and do not surface it (prevents persisting empty comments in share/collab).
    if (anchor.kind === 'comment') {
      const body = typeof pluginMeta?.text === 'string' ? pluginMeta.text.trim() : '';
      if (!body) continue;
    }

    let data: Mark['data'] | undefined;
    if (anchor.kind === 'comment') {
      data = buildCommentData(anchor.id, pluginMeta);
    } else if (anchor.kind === 'insert' || anchor.kind === 'delete' || anchor.kind === 'replace') {
      data = buildSuggestionData(anchor.kind, meta as StoredMark | undefined, quote);
    } else if (anchor.kind === 'flagged') {
      data = pluginMeta?.note ? { note: pluginMeta.note } : undefined;
    }

    marks.push({
      id: anchor.id,
      kind: anchor.kind,
      by: anchor.by || pluginMeta?.by || 'unknown',
      at: createdAt,
      range: { from: anchor.from, to: anchor.to },
      quote,
      data,
    });
  }

  for (const [id, stored] of Object.entries(metadata)) {
    if (anchors.has(id)) continue;
    if (!stored?.kind || stored.kind === 'authored') continue;
    if (stored.status === 'accepted' || stored.status === 'rejected') continue;

    const range = resolveStoredMarkRange(doc, stored);
    if (!range) continue;

    const text = getTextForRange(doc, range);
    const quote = normalizeQuote(text);
    const createdAt = stored.createdAt ?? (stored as { at?: string } | undefined)?.at ?? '';

    if (stored.kind === 'comment') {
      const body = typeof stored.text === 'string' ? stored.text.trim() : '';
      if (!body) continue;
    }

    let data: Mark['data'] | undefined;
    if (stored.kind === 'comment') {
      data = buildCommentData(id, stored);
    } else if (stored.kind === 'insert' || stored.kind === 'delete' || stored.kind === 'replace') {
      data = buildSuggestionData(stored.kind, stored, quote);
    } else if (stored.kind === 'flagged') {
      data = stored.note ? { note: stored.note } : undefined;
    }

    marks.push({
      id,
      kind: stored.kind,
      by: stored.by || 'unknown',
      at: createdAt,
      range,
      quote,
      data,
    });
  }

  return [...marks, ...authored];
}

function isMatchingAnchorMark(mark: Mark, nodeMark: { type: MarkType; attrs: Record<string, unknown> }): boolean {
  switch (mark.kind) {
    case 'insert':
    case 'delete':
    case 'replace':
      return (
        nodeMark.type.name === MARK_TYPE_NAMES.suggestion &&
        nodeMark.attrs.id === mark.id &&
        normalizeSuggestionKind(nodeMark.attrs.kind as string | null | undefined) === mark.kind
      );
    case 'comment':
      return nodeMark.type.name === MARK_TYPE_NAMES.comment && nodeMark.attrs.id === mark.id;
    case 'flagged':
      return nodeMark.type.name === MARK_TYPE_NAMES.flagged && nodeMark.attrs.id === mark.id;
    case 'approved':
      return nodeMark.type.name === MARK_TYPE_NAMES.approved && nodeMark.attrs.id === mark.id;
    default:
      return false;
  }
}

function collectAnchorRanges(doc: ProseMirrorNode, mark: Mark): MarkRange[] {
  if (mark.kind === 'authored' && mark.range) {
    return [mark.range];
  }

  const ranges: MarkRange[] = [];
  let current: MarkRange | null = null;

  doc.descendants((node, pos) => {
    if (!node.isText) return true;

    const matches = node.marks.some(nodeMark => isMatchingAnchorMark(mark, nodeMark));
    if (!matches) {
      if (current) {
        ranges.push(current);
        current = null;
      }
      return true;
    }

    const from = pos;
    const to = pos + node.nodeSize;

    if (current && from <= current.to) {
      current.to = Math.max(current.to, to);
    } else {
      if (current) ranges.push(current);
      current = { from, to };
    }

    return true;
  });

  if (current) ranges.push(current);
  return ranges;
}

function resolveActionRanges(doc: ProseMirrorNode, mark: Mark): MarkRange[] {
  const ranges = collectAnchorRanges(doc, mark);
  if (ranges.length === 0 && mark.range) return [mark.range];
  if (ranges.length <= 1) return ranges;

  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const composite: MarkRange = { from: sorted[0].from, to: sorted[sorted.length - 1].to };
  const compositeQuote = normalizeQuote(doc.textBetween(composite.from, composite.to, '\n', '\n'));
  if (compositeQuote && compositeQuote === mark.quote) {
    return [composite];
  }

  return sorted;
}

function resolveActionRangesDescending(doc: ProseMirrorNode, mark: Mark): MarkRange[] {
  return resolveActionRanges(doc, mark).sort((a, b) => b.from - a.from);
}

function getProofAnchorIds(doc: ProseMirrorNode): Map<string, { kind: MarkKind; by: string }> {
  const ids = new Map<string, { kind: MarkKind; by: string }>();

  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name === MARK_TYPE_NAMES.suggestion) {
        const id = mark.attrs.id as string | null;
        if (!id) continue;
        ids.set(id, { kind: normalizeSuggestionKind(mark.attrs.kind), by: mark.attrs.by || 'unknown' });
      } else if (mark.type.name === MARK_TYPE_NAMES.comment) {
        const id = mark.attrs.id as string | null;
        if (!id) continue;
        ids.set(id, { kind: 'comment', by: mark.attrs.by || 'unknown' });
      } else if (mark.type.name === MARK_TYPE_NAMES.flagged) {
        const id = mark.attrs.id as string | null;
        if (!id) continue;
        ids.set(id, { kind: 'flagged', by: mark.attrs.by || 'unknown' });
      } else if (mark.type.name === MARK_TYPE_NAMES.approved) {
        const id = mark.attrs.id as string | null;
        if (!id) continue;
        ids.set(id, { kind: 'approved', by: mark.attrs.by || 'unknown' });
      } else if (mark.type.name === MARK_TYPE_NAMES.authored) {
        const by = mark.attrs.by || 'human:unknown';
        const id = (mark.attrs.id as string | null) ?? `authored:${by}:${pos}-${pos + node.nodeSize}`;
        ids.set(id, { kind: 'authored', by });
      }
    }
    return true;
  });

  return ids;
}

function normalizeMetadata(
  metadata: Record<string, StoredMark>,
  doc: ProseMirrorNode
): Record<string, StoredMark> {
  const ids = getProofAnchorIds(doc);
  let changed = false;
  const next: Record<string, StoredMark> = { ...metadata };

  for (const [id, info] of ids.entries()) {
    if (!next[id]) {
      // Comment anchors are meaningless without metadata (the comment body lives only in metadata,
      // not in the ProseMirror mark attrs). Synthesizing an entry here can later be flushed as an
      // "empty comment" and overwrite the real payload when it arrives.
      if (info.kind === 'comment') continue;

      next[id] = {
        kind: info.kind,
        by: info.by,
        createdAt: new Date().toISOString(),
      };
      if (info.kind === 'comment') {
        next[id].threadId = next[id].threadId || id;
        next[id].thread = Array.isArray(next[id].thread) ? next[id].thread : [];
        next[id].resolved = Boolean(next[id].resolved);
      }
      changed = true;
      continue;
    }

    if (next[id].kind !== info.kind) {
      next[id] = { ...next[id], kind: info.kind };
      changed = true;
    }
    if (next[id].by !== info.by) {
      next[id] = { ...next[id], by: info.by };
      changed = true;
    }
    if (!next[id].createdAt) {
      next[id] = { ...next[id], createdAt: new Date().toISOString() };
      changed = true;
    }

    if (next[id].kind === 'comment') {
      if (typeof next[id].thread === 'string') {
        next[id] = {
          ...next[id],
          threadId: next[id].thread,
          thread: Array.isArray(next[id].replies) ? next[id].replies : [],
        };
        changed = true;
      }
      if (!next[id].threadId) {
        next[id] = { ...next[id], threadId: id };
        changed = true;
      }
      if (!Array.isArray(next[id].thread)) {
        next[id] = { ...next[id], thread: Array.isArray(next[id].replies) ? next[id].replies : [] };
        changed = true;
      }
    }
  }

  for (const id of Object.keys(next)) {
    if (!ids.has(id)) {
      const detached = next[id];
      if (detached?.kind === 'comment' && shouldIncludeMetadataEntry(detached, true)) continue;
      delete next[id];
      changed = true;
    }
  }

  return changed ? next : metadata;
}

function removeMetadataEntries(
  metadata: Record<string, StoredMark>,
  ids: string[]
): Record<string, StoredMark> {
  if (ids.length === 0) return metadata;
  const next = { ...metadata };
  let changed = false;
  for (const id of ids) {
    if (next[id]) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : metadata;
}

function applyOrchestrationMeta(meta: StoredMark, data: OrchestratedMarkMeta | undefined): void {
  if (!data) return;
  if (typeof data.runId === 'string' && data.runId.trim()) meta.runId = data.runId;
  if (typeof data.focusAreaId === 'string' && data.focusAreaId.trim()) meta.focusAreaId = data.focusAreaId;
  if (typeof data.focusAreaName === 'string' && data.focusAreaName.trim()) meta.focusAreaName = data.focusAreaName;
  if (typeof data.agentId === 'string' && data.agentId.trim()) meta.agentId = data.agentId;
  if (typeof data.proposalId === 'string' && data.proposalId.trim()) meta.proposalId = data.proposalId;
  if (typeof data.provisional === 'boolean') meta.provisional = data.provisional;
  if (typeof data.orchestrator === 'boolean') meta.orchestrator = data.orchestrator;
  if (typeof data.debugAutoFixedQuotes === 'boolean') meta.debugAutoFixedQuotes = data.debugAutoFixedQuotes;
  if (typeof data.debugAutoFixedQuotesReason === 'string' && data.debugAutoFixedQuotesReason.trim()) {
    meta.debugAutoFixedQuotesReason = data.debugAutoFixedQuotesReason;
  }
}

function buildMetadataFromMark(mark: Mark): StoredMark {
  const meta: StoredMark = {
    kind: mark.kind,
    by: mark.by,
    createdAt: mark.at,
  };
  if (mark.range) {
    meta.range = { from: mark.range.from, to: mark.range.to };
  }

  if (mark.kind === 'comment') {
    const data = mark.data as CommentData | undefined;
    meta.text = data?.text ?? '';
    meta.threadId = data?.thread ?? mark.id;
    meta.thread = data?.replies ?? [];
    meta.replies = data?.replies ?? [];
    meta.resolved = Boolean(data?.resolved);
    applyOrchestrationMeta(meta, data);
  } else if (mark.kind === 'insert') {
    const data = mark.data as InsertData | undefined;
    meta.content = data?.content ?? '';
    meta.status = data?.status ?? 'pending';
    applyOrchestrationMeta(meta, data);
  } else if (mark.kind === 'delete') {
    const data = mark.data as DeleteData | undefined;
    meta.status = data?.status ?? 'pending';
    applyOrchestrationMeta(meta, data);
  } else if (mark.kind === 'replace') {
    const data = mark.data as ReplaceData | undefined;
    meta.content = data?.content ?? '';
    meta.status = data?.status ?? 'pending';
    applyOrchestrationMeta(meta, data);
  } else if (mark.kind === 'flagged') {
    meta.note = (mark.data as { note?: string } | undefined)?.note;
  }

  return meta;
}

function shouldIncludeMetadataEntry(
  entry: StoredMark | undefined,
  includeAuthored: boolean
): entry is StoredMark {
  if (!entry || typeof entry !== 'object') return false;
  if (!includeAuthored && entry.kind === 'authored') return false;
  if (entry.kind === 'comment') {
    return typeof entry.text === 'string' && entry.text.trim().length > 0;
  }
  return true;
}

function buildMetadataSnapshot(
  state: EditorState,
  options?: { includeAuthored?: boolean; includeQuotes?: boolean }
): Record<string, StoredMark> {
  const pluginState = marksPluginKey.getState(state);
  if (!pluginState) return {};

  const includeAuthored = options?.includeAuthored === true;
  const anchoredIds = getProofAnchorIds(state.doc);
  const metadata: Record<string, StoredMark> = {};

  for (const [id, entry] of Object.entries(pluginState.metadata ?? {})) {
    if (!anchoredIds.has(id) && entry?.kind !== 'comment') continue;
    if (!shouldIncludeMetadataEntry(entry, includeAuthored)) continue;
    metadata[id] = { ...entry };
  }

  const marks = collectMarks(state);
  for (const mark of marks) {
    if (!includeAuthored && mark.kind === 'authored') continue;
    const stored = buildMetadataFromMark(mark);
    if (options?.includeQuotes && mark.quote) stored.quote = mark.quote;
    addRelativeAnchorsToMetadata(state.doc, mark, stored);
    metadata[mark.id] = mergeStoredMarkWithFallback(metadata[mark.id], stored);
  }

  return metadata;
}

function collectMarks(state: EditorState): Mark[] {
  const pluginState = marksPluginKey.getState(state);
  if (!pluginState) return [];
  return buildAnchorMarks(state.doc, pluginState.metadata);
}

// ============================================================================
// Mark Access Functions
// ============================================================================

export function getMarks(state: EditorState): Mark[] {
  return collectMarks(state);
}

export function getActiveMarkId(state: EditorState): string | null {
  const pluginState = marksPluginKey.getState(state);
  return pluginState?.activeMarkId ?? null;
}

export function getComposeAnchorRange(state: EditorState): MarkRange | null {
  const pluginState = marksPluginKey.getState(state);
  return pluginState?.composeAnchorRange ?? null;
}

export function getMarkMetadata(state: EditorState): Record<string, StoredMark> {
  return buildMetadataSnapshot(state);
}

// Disk persistence needs authored marks too. If we drop authored marks, a reload from disk
// loses provenance and the sidebar defaults "unmarked text" to AI-authored.
export function getMarkMetadataForDisk(state: EditorState): Record<string, StoredMark> {
  return buildMetadataSnapshot(state, { includeAuthored: true });
}

/** Like getMarkMetadata but includes `quote` for each mark — needed for share sync
 *  so remote clients can recreate ProseMirror anchors using quote-based range resolution. */
export function getMarkMetadataWithQuotes(state: EditorState): Record<string, StoredMark> {
  return buildMetadataSnapshot(state, { includeAuthored: true, includeQuotes: true });
}

function mergeStoredMarkWithFallback(
  existing: StoredMark | undefined,
  incoming: StoredMark
): StoredMark {
  if (!existing) return incoming;

  const merged: StoredMark = { ...existing, ...incoming };
  const kind = incoming.kind ?? existing.kind;

  if (kind === 'comment') {
    const incomingText = typeof incoming.text === 'string' ? incoming.text : null;
    const existingText = typeof existing.text === 'string' ? existing.text : null;
    if (
      (!incomingText || incomingText.trim().length === 0)
      && existingText
      && existingText.trim().length > 0
    ) {
      merged.text = existingText;
    }

    if (!incoming.threadId && existing.threadId) merged.threadId = existing.threadId;

    // Preserve local thread/replies when incoming data is missing or shorter.
    // Server may send stale/empty thread arrays; prefer whichever has more entries.
    const existingThread = Array.isArray(existing.thread) ? existing.thread : [];
    const incomingThread = Array.isArray(incoming.thread) ? incoming.thread : [];
    if (existingThread.length > 0 || incomingThread.length > 0) {
      merged.thread = existingThread.length >= incomingThread.length ? existing.thread : incoming.thread;
    } else if (typeof existing.thread === 'string' && incoming.thread === undefined) {
      merged.thread = existing.thread;
    }

    const existingReplies = Array.isArray(existing.replies) ? existing.replies : [];
    const incomingReplies = Array.isArray(incoming.replies) ? incoming.replies : [];
    if (existingReplies.length > 0 || incomingReplies.length > 0) {
      merged.replies = existingReplies.length >= incomingReplies.length ? existing.replies : incoming.replies;
    }

    if (incoming.resolved === undefined && existing.resolved !== undefined) {
      merged.resolved = existing.resolved;
    }
  }

  if (kind === 'insert' || kind === 'replace') {
    const incomingContent = typeof incoming.content === 'string' ? incoming.content : null;
    const existingContent = typeof existing.content === 'string' ? existing.content : null;
    if ((!incomingContent || incomingContent.length === 0) && existingContent && existingContent.length > 0) {
      merged.content = existingContent;
    }
  }

  if (!incoming.createdAt && existing.createdAt) merged.createdAt = existing.createdAt;
  if (!incoming.quote && existing.quote) merged.quote = existing.quote;
  if (!incoming.startRel && existing.startRel) merged.startRel = existing.startRel;
  if (!incoming.endRel && existing.endRel) merged.endRel = existing.endRel;
  if (!incoming.range && existing.range) merged.range = existing.range;

  return merged;
}

export function mergePendingServerMarks(
  localMetadata: Record<string, StoredMark>,
  serverMarks: Record<string, StoredMark>
): Record<string, StoredMark> {
  const canonicalLocal = canonicalizeStoredMarks(localMetadata);
  const canonicalServer = canonicalizeStoredMarks(serverMarks);
  const merged: Record<string, StoredMark> = { ...canonicalLocal };
  const now = Date.now();
  for (const [id, serverMark] of Object.entries(canonicalServer)) {
    const status = serverMark?.status;
    if (status === 'accepted' || status === 'rejected') {
      delete merged[id];
      continue;
    }
    const kind = serverMark?.kind;
    if (kind !== 'authored') {
      // Server is authoritative for non-authored marks (comments, suggestions, AI marks)
      const isDeletedTombstone = isResolvedMarkTombstoned(id, now, 'deleted');
      const isResolvedTombstone = isResolvedMarkTombstoned(id, now, 'resolved');
      if (isDeletedTombstone && !merged[id]) {
        // Mark was deleted locally — don't re-add from server
        continue;
      }
      if (kind === 'comment' && isResolvedTombstone && merged[id]?.resolved === true) {
        merged[id] = mergeStoredMarkWithFallback(merged[id], { ...serverMark, resolved: true });
      } else if (!isDeletedTombstone) {
        merged[id] = mergeStoredMarkWithFallback(merged[id], serverMark);
      }
      continue;
    }
    // Authored marks: only add if missing locally (local edits take precedence)
    if (!merged[id]) {
      merged[id] = serverMark;
    }
  }
  return canonicalizeStoredMarks(merged);
}

export function buildSuggestionMetadata(
  kind: 'insert' | 'delete' | 'replace',
  by: string,
  content: string | null,
  createdAt?: string,
  status: SuggestionStatus = 'pending',
  orchestrationMeta?: OrchestratedMarkMeta
): StoredMark {
  const meta: StoredMark = {
    kind,
    by,
    createdAt: createdAt ?? new Date().toISOString(),
    status,
  };

  if (kind === 'insert' || kind === 'replace') {
    meta.content = content ?? '';
  }

  applyOrchestrationMeta(meta, orchestrationMeta);
  return meta;
}

export function setMarkMetadata(view: EditorView, metadata: Record<string, StoredMark>): void {
  finalizeMarkTransaction(view, view.state.tr, metadata);
}

/** Apply marks from a remote client (share sync).
 *  Optionally creates ProseMirror anchors for marks that don't already exist in the document,
 *  using the `quote` field to resolve text ranges. Then merges all metadata. */
export function applyRemoteMarks(
  view: EditorView,
  metadata: Record<string, StoredMark>,
  options?: { hydrateAnchors?: boolean }
): void {
  const canonicalMetadata = canonicalizeStoredMarks(metadata);
  const hydrateAnchors = options?.hydrateAnchors !== false;
  const existingIds = getProofAnchorIds(view.state.doc);
  let tr = view.state.tr;
  const now = Date.now();
  pruneResolvedMarkTombstones(now);
  pruneMarkAnchorHydrationFailures(now);
  const allEntries = Object.entries(canonicalMetadata);
  const finalizedSuggestionIds = new Set<string>();
  let authoredHydrationFailures = 0;
  let authoredHydrationSuppressed = 0;

  // Merge with existing metadata so we don't lose local marks.
  // For tombstoned comment marks, we merge metadata (replies, thread, etc.)
  // but preserve the local resolved state to prevent stale server data from
  // flipping resolved comments back to unresolved.
  // For tombstoned suggestion marks, skip entirely (accepted/rejected locally).
  const merged = canonicalizeStoredMarks({ ...getMarkMetadata(view.state) });
  const filteredEntries: [string, StoredMark][] = [];
  for (const [id, stored] of allEntries) {
    const status = stored?.status;
    if (status === 'accepted' || status === 'rejected') {
      if (stored.kind === 'insert' || stored.kind === 'delete' || stored.kind === 'replace') {
        finalizedSuggestionIds.add(id);
      }
      delete merged[id];
      continue;
    }
    const isDeletedTombstone = isResolvedMarkTombstoned(id, now, 'deleted');
    const isResolvedTombstone = isResolvedMarkTombstoned(id, now, 'resolved');
    if (isDeletedTombstone) {
      // Skip deleted marks entirely (no metadata merge, no anchors)
      continue;
    }
    if (isResolvedTombstone && stored.kind === 'comment') {
      // Comment tombstones: merge everything except resolved field
      if (merged[id]) {
        const { resolved: _ignored, ...rest } = stored;
        merged[id] = mergeStoredMarkWithFallback(merged[id], rest as StoredMark);
      } else {
        merged[id] = stored;
      }
      filteredEntries.push([id, stored]);
      continue;
    }
    merged[id] = mergeStoredMarkWithFallback(merged[id], stored);
    filteredEntries.push([id, stored]);
  }

  tr = removeSuggestionAnchors(tr, finalizedSuggestionIds);

  if (hydrateAnchors) {
    for (const [id, stored] of filteredEntries) {
      if (existingIds.has(id)) continue; // Already has an anchor
      if (!stored.kind) continue;
      const isAuthored = stored.kind === 'authored';
      if (isAuthored && authoredHydrationFailures >= AUTHORED_ANCHOR_HYDRATION_FAILURE_BUDGET_PER_PASS) {
        authoredHydrationSuppressed += 1;
        continue;
      }
      if (!shouldAttemptMarkAnchorHydration(id, tr.doc, now)) continue;

      const range = resolveStoredMarkRange(tr.doc, stored);
      if (!range) {
        if (!isAuthored || authoredHydrationFailures < AUTHORED_ANCHOR_HYDRATION_FAILURE_BUDGET_PER_PASS) {
          console.warn(`[applyRemoteMarks] Could not resolve remote mark ${id}`);
        }
        recordMarkAnchorHydrationFailure(id, tr.doc, now);
        if (isAuthored) {
          authoredHydrationFailures += 1;
        }
        if (shouldReportMarkAnchorResolution(stored.kind)) {
          reportMarkAnchorResolution('failure');
        }
        continue;
      }

      const markTypeName = stored.kind === 'comment' ? 'comment'
        : stored.kind === 'flagged' ? 'flagged'
        : stored.kind === 'approved' ? 'approved'
        : 'suggestion';
      const markType = getMarkTypeForKind(view.state, stored.kind);
      if (!markType) {
        recordMarkAnchorHydrationFailure(id, tr.doc, now);
        if (isAuthored) {
          authoredHydrationFailures += 1;
        }
        if (shouldReportMarkAnchorResolution(stored.kind)) {
          reportMarkAnchorResolution('failure');
        }
        continue;
      }

      const attrs: Record<string, unknown> = { id, by: stored.by || 'unknown' };
      if (markTypeName === 'suggestion') {
        attrs.kind = stored.kind;
      }
      tr = tr.addMark(range.from, range.to, markType.create(attrs));
      clearMarkAnchorHydrationFailure(id);
      if (shouldReportMarkAnchorResolution(stored.kind)) {
        reportMarkAnchorResolution('success');
      }
    }
  }

  if (authoredHydrationSuppressed > 0) {
    console.warn(
      `[applyRemoteMarks] Skipped ${authoredHydrationSuppressed} authored mark anchor hydrations after ${authoredHydrationFailures} failures`
    );
  }

  finalizeMarkTransaction(view, tr, canonicalizeStoredMarks(merged), { isRemote: true, skipDocStamp: !hydrateAnchors });
}

export function setActiveMark(view: EditorView, markId: string | null): void {
  const tr = view.state.tr.setMeta(marksPluginKey, {
    type: 'SET_ACTIVE',
    markId,
  });
  view.dispatch(tr);
}

export function setComposeAnchorRange(view: EditorView, range: MarkRange | null): void {
  const tr = view.state.tr.setMeta(marksPluginKey, {
    type: 'SET_COMPOSE_ANCHOR',
    range: range ? { from: range.from, to: range.to } : null,
  });
  view.dispatch(tr);
}

// ============================================================================
// Mark Operations (exposed to editor/MCP)
// ============================================================================

export function approve(view: EditorView, quote: string, by: string, range?: MarkRange): Mark | null {
  const resolvedRange = range ?? resolveRangeFromQuote(view.state.doc, quote);
  if (!resolvedRange) return null;
  const actualQuote = getTextForRange(view.state.doc, resolvedRange);
  const mark = createApproval(actualQuote, by, resolvedRange);
  const markType = getMarkTypeForKind(view.state, 'approved');
  if (!markType) return null;

  let tr = view.state.tr;
  tr = tr.removeMark(resolvedRange.from, resolvedRange.to, markType);
  tr = tr.addMark(resolvedRange.from, resolvedRange.to, markType.create({ id: mark.id, by: mark.by }));

  const metadata = { ...getMarkMetadata(view.state), [mark.id]: buildMetadataFromMark(mark) };
  finalizeMarkTransaction(view, tr, metadata);
  return mark;
}

export function unapprove(view: EditorView, quote: string, by: string): boolean {
  const marks = getMarks(view.state);
  const toRemove = marks.find(
    m => m.kind === 'approved' && m.quote === normalizeQuote(quote) && m.by === by
  );
  if (!toRemove) return false;
  const markType = getMarkTypeForKind(view.state, 'approved');
  if (!markType) return false;

  const ranges = resolveActionRangesDescending(view.state.doc, toRemove);
  if (ranges.length === 0) return false;

  let tr = view.state.tr;
  for (const range of ranges) {
    tr = tr.removeMark(range.from, range.to, markType);
  }
  const metadata = removeMetadataEntries(getMarkMetadata(view.state), [toRemove.id]);
  finalizeMarkTransaction(view, tr, metadata);
  return true;
}

export function flag(view: EditorView, quote: string, by: string, note?: string, range?: MarkRange): Mark | null {
  const selection = view.state.selection;
  const selectionRange = selection.from !== selection.to ? { from: selection.from, to: selection.to } : null;
  const resolvedRange = range ?? resolveRangeFromQuote(view.state.doc, quote) ?? selectionRange ?? undefined;
  if (!resolvedRange) return null;
  const actualQuote = getTextForRange(view.state.doc, resolvedRange);
  const mark = createFlag(actualQuote, by, note, resolvedRange);
  const markType = getMarkTypeForKind(view.state, 'flagged');
  if (!markType) return null;

  let tr = view.state.tr;
  tr = tr.removeMark(resolvedRange.from, resolvedRange.to, markType);
  tr = tr.addMark(resolvedRange.from, resolvedRange.to, markType.create({ id: mark.id, by: mark.by }));

  const metadata = { ...getMarkMetadata(view.state), [mark.id]: buildMetadataFromMark(mark) };
  finalizeMarkTransaction(view, tr, metadata);
  return mark;
}

export function unflag(view: EditorView, quote: string, by: string): boolean {
  const marks = getMarks(view.state);
  const toRemove = marks.find(
    m => m.kind === 'flagged' && m.quote === normalizeQuote(quote) && m.by === by
  );
  if (!toRemove) return false;
  const markType = getMarkTypeForKind(view.state, 'flagged');
  if (!markType) return false;

  const ranges = resolveActionRangesDescending(view.state.doc, toRemove);
  if (ranges.length === 0) return false;

  let tr = view.state.tr;
  for (const range of ranges) {
    tr = tr.removeMark(range.from, range.to, markType);
  }
  const metadata = removeMetadataEntries(getMarkMetadata(view.state), [toRemove.id]);
  finalizeMarkTransaction(view, tr, metadata);
  return true;
}

export function comment(
  view: EditorView,
  quote: string,
  by: string,
  text: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta
): Mark {
  const selection = view.state.selection;
  const selectionRange = selection.from !== selection.to ? { from: selection.from, to: selection.to } : null;
  const resolvedRange = range ?? resolveRangeFromQuote(view.state.doc, quote) ?? selectionRange ?? undefined;
  const actualQuote = resolvedRange ? getTextForRange(view.state.doc, resolvedRange) : quote;
  const mark = createComment(actualQuote, by, text, undefined, resolvedRange ?? undefined, meta);
  const markType = getMarkTypeForKind(view.state, 'comment');
  if (!markType || !resolvedRange) return mark;

  let tr = view.state.tr;
  tr = tr.addMark(resolvedRange.from, resolvedRange.to, markType.create({ id: mark.id, by: mark.by }));

  const metadata = { ...getMarkMetadata(view.state), [mark.id]: buildMetadataFromMark(mark) };
  finalizeMarkTransaction(view, tr, metadata);
  emitMarkEvent('comment.added', { markId: mark.id, by, quote: actualQuote, text });
  return mark;
}

export function reply(view: EditorView, markId: string, by: string, text: string): Mark | null {
  const metadata = getMarkMetadata(view.state);
  const existing = metadata[markId];
  if (!existing) return null;

  const reply: CommentReply = {
    by,
    text,
    at: new Date().toISOString(),
  };

  const threadReplies = Array.isArray(existing.thread) ? existing.thread : [];
  const normalizedReplies = Array.isArray(existing.replies) ? existing.replies : [];
  const baseReplies = normalizedReplies.length >= threadReplies.length ? normalizedReplies : threadReplies;
  const replies = [...baseReplies, reply];

  const updated: StoredMark = {
    ...existing,
    threadId: existing.threadId || markId,
    thread: replies,
    replies: replies,
  };

  const next = { ...metadata, [markId]: updated };
  finalizeMarkTransaction(view, view.state.tr, next);
  emitMarkEvent('comment.replied', { markId, by, text });

  const marks = getMarks(view.state);
  const anchor = marks.find(m => m.id === markId) ?? null;
  return anchor;
}

export function resolve(view: EditorView, markId: string): boolean {
  const metadata = getMarkMetadata(view.state);
  const existing = metadata[markId];
  if (!existing) return false;

  const next = { ...metadata, [markId]: { ...existing, resolved: true } };
  finalizeMarkTransaction(view, view.state.tr, next);
  markResolvedMarkIds([markId], Date.now(), RESOLVED_COMMENT_TOMBSTONE_TTL_MS, 'resolved');
  emitMarkEvent('comment.resolved', { markId });
  return true;
}

export function unresolve(view: EditorView, markId: string): boolean {
  const metadata = getMarkMetadata(view.state);
  const existing = metadata[markId];
  if (!existing) return false;

  const next = { ...metadata, [markId]: { ...existing, resolved: false } };
  finalizeMarkTransaction(view, view.state.tr, next);
  resolvedMarkTombstones.delete(markId);
  return true;
}

export function suggestInsert(
  view: EditorView,
  quote: string,
  by: string,
  content: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta
): Mark | null {
  const requiresAnchor = Boolean(range) || meta?.orchestrator === true || meta?.provisional === true;
  let insertionRange: MarkRange | null = null;

  if (range) {
    const resolved = resolveRangeWithValidation(view.state.doc, quote, range);
    if (!resolved.range) {
      console.warn('[marks] Rejecting insert suggestion due to invalid provided range.');
      return null;
    }
    insertionRange = { from: resolved.range.to, to: resolved.range.to };
  } else {
    const resolved = resolveRangeFromQuote(view.state.doc, quote);
    if (resolved) {
      insertionRange = { from: resolved.to, to: resolved.to };
    } else if (requiresAnchor) {
      console.warn('[marks] Rejecting insert suggestion because quote could not be resolved.');
      return null;
    } else {
      insertionRange = { from: view.state.selection.to, to: view.state.selection.to };
    }
  }

  if (!insertionRange) return null;

  const mark = createInsertSuggestion(content, by, content, insertionRange, meta);
  const markType = getMarkTypeForKind(view.state, 'insert');
  if (!markType) return null;
  const markMeta = buildMetadataFromMark(mark);

  let tr = view.state.tr;
  tr = tr.insertText(content, insertionRange.to);
  tr = applyShareContentMutationAllowance(tr, meta);
  tr = tr.addMark(
    insertionRange.to,
    insertionRange.to + content.length,
    markType.create(buildSuggestionAttrs(mark.id, 'insert', mark.by, markMeta))
  );

  const metadata = { ...getMarkMetadata(view.state), [mark.id]: markMeta };
  finalizeMarkTransaction(view, tr, metadata);
  return mark;
}

export function suggestDelete(
  view: EditorView,
  quote: string,
  by: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta
): Mark | null {
  const { range: resolvedRange, actualQuote } = resolveRangeWithValidation(view.state.doc, quote, range);
  if (!resolvedRange) {
    console.warn('[marks] Rejecting delete suggestion because quote could not be resolved safely.');
    return null;
  }
  const mark = createDeleteSuggestion(actualQuote, by, resolvedRange, meta);
  const markType = getMarkTypeForKind(view.state, 'delete');
  if (!markType) return null;
  const markMeta = buildMetadataFromMark(mark);

  let tr = view.state.tr;
  tr = tr.addMark(
    resolvedRange.from,
    resolvedRange.to,
    markType.create(buildSuggestionAttrs(mark.id, 'delete', mark.by, markMeta))
  );

  const metadata = { ...getMarkMetadata(view.state), [mark.id]: markMeta };
  finalizeMarkTransaction(view, tr, metadata);
  return mark;
}

export function suggestReplace(
  view: EditorView,
  quote: string,
  by: string,
  content: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta,
  parser?: MarkdownParser
): Mark | null {
  const resolved = resolveRangeWithValidation(view.state.doc, quote, range);
  if (!resolved.range) {
    console.warn('[marks] Rejecting replace suggestion because quote could not be resolved safely.');
    return null;
  }

  if (rangeCrossesTableCellBoundary(view.state.doc, resolved.range)) {
    console.warn('[marks] Rejecting replace suggestion because range crosses table cell boundary.', {
      range: resolved.range,
      quotePreview: quote.slice(0, 80),
    });
    return null;
  }

  let effectiveRange = resolved.range;
  const structural = resolveStructuralReplaceRange(view.state.doc, effectiveRange, content, parser);
  if (structural.structural && !structural.safe) {
    console.warn('[marks] Rejecting structural replace suggestion that is not block-aligned.', {
      reason: structural.reason,
      range: effectiveRange,
      markdownPreview: content.slice(0, 80),
    });
    return null;
  }
  if (structural.upgraded) {
    effectiveRange = structural.range;
  }

  const actualQuote = getTextForRange(view.state.doc, effectiveRange);
  const mark = createReplaceSuggestion(actualQuote, by, content, effectiveRange, meta);
  const markType = getMarkTypeForKind(view.state, 'replace');
  if (!markType) return null;
  const markMeta = buildMetadataFromMark(mark);

  let tr = view.state.tr;
  tr = tr.addMark(
    effectiveRange.from,
    effectiveRange.to,
    markType.create(buildSuggestionAttrs(mark.id, 'replace', mark.by, markMeta))
  );

  const metadata = { ...getMarkMetadata(view.state), [mark.id]: markMeta };
  finalizeMarkTransaction(view, tr, metadata);
  return mark;
}

export function debugAnalyzeReplace(
  view: EditorView,
  quote: string,
  content: string,
  range?: MarkRange,
  parser?: MarkdownParser
): {
  resolution: { range: MarkRange | null; actualQuote: string; rangeProvided: boolean };
  structural: ReturnType<typeof resolveStructuralReplaceRange> | null;
  tableCellBoundaryCrossed: boolean;
} {
  const resolution = resolveRangeWithValidation(view.state.doc, quote, range);
  if (!resolution.range) {
    return {
      resolution: {
        range: null,
        actualQuote: resolution.actualQuote,
        rangeProvided: resolution.rangeProvided,
      },
      structural: null,
      tableCellBoundaryCrossed: false,
    };
  }

  const structural = resolveStructuralReplaceRange(view.state.doc, resolution.range, content, parser);
  return {
    resolution: {
      range: resolution.range,
      actualQuote: resolution.actualQuote,
      rangeProvided: resolution.rangeProvided,
    },
    structural,
    tableCellBoundaryCrossed: rangeCrossesTableCellBoundary(view.state.doc, resolution.range),
  };
}

export function modifySuggestionContent(view: EditorView, markId: string, newContent: string): boolean {
  const marks = getMarks(view.state);
  const mark = marks.find(item => item.id === markId);
  if (!mark || (mark.kind !== 'insert' && mark.kind !== 'replace')) return false;

  const metadata = getMarkMetadata(view.state);
  const existing = metadata[markId];
  if (!existing) return false;

  const next = { ...metadata, [markId]: { ...existing, content: newContent } };

  let tr = view.state.tr;
  if (mark.kind === 'insert') {
    const insertType = getMarkTypeForKind(view.state, 'insert');
    if (!insertType) return false;
    const ranges = resolveActionRangesDescending(view.state.doc, mark);
    if (ranges.length !== 1) return false;
    const range = ranges[0];
    tr = tr.replaceWith(range.from, range.to, view.state.schema.text(newContent));
    tr = tr.addMark(
      range.from,
      range.from + newContent.length,
      insertType.create(buildSuggestionAttrs(mark.id, 'insert', mark.by, next[markId]))
    );
  }

  finalizeMarkTransaction(view, tr, next);
  return true;
}

let defaultMarkdownParser: MarkdownParser | undefined;

export function setDefaultMarkdownParser(parser?: MarkdownParser): void {
  defaultMarkdownParser = parser;
}

function resolveMarkdownParser(parser?: MarkdownParser): MarkdownParser | undefined {
  return parser ?? defaultMarkdownParser;
}

function parseMarkdownFragment(parser: MarkdownParser | undefined, text: string): Fragment | null {
  if (!parser) return null;
  try {
    const parsed = parser(text);
    return parsed.content;
  } catch (error) {
    console.warn('[marks] Failed to parse markdown suggestion; falling back to text.', error);
    return null;
  }
}

function fragmentHasBlockNodes(fragment: Fragment): boolean {
  for (let i = 0; i < fragment.childCount; i += 1) {
    const child = fragment.child(i);
    if (!child.isInline) return true;
  }
  return false;
}

function unwrapSingleParagraph(fragment: Fragment): Fragment | null {
  if (fragment.childCount !== 1) return null;
  const first = fragment.firstChild;
  if (!first || first.type.name !== 'paragraph') return null;
  return first.content;
}

function firstNonEmptyLine(markdown: string): string {
  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function hasStructuralMarkdownSyntax(markdown: string): boolean {
  const firstLine = firstNonEmptyLine(markdown);
  if (!firstLine) return false;
  if (/^#{1,6}\s+\S/.test(firstLine)) return true;
  if (/^(-|\*|\+)\s+\S/.test(firstLine)) return true;
  if (/^\d+\.\s+\S/.test(firstLine)) return true;
  if (/^>\s+\S/.test(firstLine)) return true;
  if (/^```/.test(firstLine)) return true;
  if (/^---+$/.test(firstLine)) return true;
  return false;
}

function isStructuralMarkdown(markdown: string, parser?: MarkdownParser): boolean {
  if (hasStructuralMarkdownSyntax(markdown)) return true;
  const parsedFragment = parseMarkdownFragment(parser, markdown);
  if (!parsedFragment || parsedFragment.childCount === 0) return false;
  if (unwrapSingleParagraph(parsedFragment)) return false;
  return fragmentHasBlockNodes(parsedFragment);
}

function rangeMatchesEntireParentText(
  doc: ProseMirrorNode,
  range: MarkRange,
  analysis: ReturnType<typeof analyzeTextblockRange>
): boolean {
  if (!analysis.parentIsTextblock) return false;
  const rangeQuote = normalizeQuote(getTextForRange(doc, range));
  const parentQuote = normalizeQuote(
    doc.textBetween(analysis.parentContentFrom, analysis.parentContentTo, '\n', '\n')
  );
  return rangeQuote.length > 0 && rangeQuote === parentQuote;
}

const MAX_STRUCTURAL_MULTIBLOCK_TEXTBLOCKS = 2;
const MAX_STRUCTURAL_MULTIBLOCK_CHARS = 240;
const STRUCTURAL_MULTIBLOCK_EDGE_TOLERANCE = 1;

type StructuralTextblockSlice = {
  from: number;
  to: number;
  text: string;
  leadingWhitespace: number;
  trailingWhitespace: number;
};

function collectStructuralTextblockSlices(
  doc: ProseMirrorNode,
  range: MarkRange
): StructuralTextblockSlice[] {
  const slices: StructuralTextblockSlice[] = [];
  doc.nodesBetween(range.from, range.to, (node, pos) => {
    if (!node.isTextblock) return;
    const from = pos + 1;
    const to = pos + node.content.size;
    if (range.to <= from || range.from >= to) return;
    const text = doc.textBetween(from, to, '\n', '\n');
    const leadingWhitespace = text.match(/^\s+/)?.[0].length ?? 0;
    const trailingWhitespace = text.match(/\s+$/)?.[0].length ?? 0;
    slices.push({ from, to, text, leadingWhitespace, trailingWhitespace });
  });
  return slices;
}

function resolveStructuralMultiblockRange(
  doc: ProseMirrorNode,
  range: MarkRange
): MarkRange | null {
  const slices = collectStructuralTextblockSlices(doc, range);
  if (slices.length <= 1) return null;
  if (slices.length > MAX_STRUCTURAL_MULTIBLOCK_TEXTBLOCKS) return null;

  const first = slices[0];
  const last = slices[slices.length - 1];
  if (!first || !last) return null;

  const startEdgeMax = first.from + first.leadingWhitespace;
  const endEdgeMin = last.to - last.trailingWhitespace;
  const tolerance = STRUCTURAL_MULTIBLOCK_EDGE_TOLERANCE;
  const startAligned = range.from >= Math.max(0, first.from - tolerance)
    && range.from <= Math.min(first.to, startEdgeMax + tolerance);
  const endAligned = range.to <= Math.min(doc.content.size, last.to + tolerance)
    && range.to >= Math.max(last.from, endEdgeMin - tolerance);

  const normalizedRangeText = normalizeQuote(doc.textBetween(range.from, range.to, '\n', '\n'));
  const normalizedSlicesText = normalizeQuote(slices.map((slice) => slice.text).join('\n'));
  const contentMatchesSlices = normalizedRangeText.length > 0 && normalizedRangeText === normalizedSlicesText;
  if ((!startAligned || !endAligned) && !contentMatchesSlices) {
    return null;
  }

  for (let i = 1; i < slices.length - 1; i += 1) {
    const slice = slices[i];
    if (!slice) continue;
    const middleCovered = range.from <= slice.from + tolerance && range.to >= slice.to - tolerance;
    if (!middleCovered) {
      return null;
    }
  }

  const totalChars = slices.reduce((sum, slice) => sum + slice.text.length, 0);
  if (totalChars > MAX_STRUCTURAL_MULTIBLOCK_CHARS) return null;

  // Clamp to exact textblock boundaries so structural replacements stay block-aligned.
  return { from: first.from, to: last.to };
}

function resolveStructuralReplaceRange(
  doc: ProseMirrorNode,
  range: MarkRange,
  markdown: string,
  parser?: MarkdownParser
): { range: MarkRange; structural: boolean; safe: boolean; upgraded: boolean; reason?: string } {
  const structural = isStructuralMarkdown(markdown, parser);
  if (!structural) {
    return { range, structural: false, safe: true, upgraded: false };
  }

  const analysis = analyzeTextblockRange(doc, range);
  if (!analysis.parentIsTextblock) {
    const multiblockRange = resolveStructuralMultiblockRange(doc, range);
    if (multiblockRange) {
      const upgraded = multiblockRange.from !== range.from || multiblockRange.to !== range.to;
      return {
        range: multiblockRange,
        structural: true,
        safe: true,
        upgraded,
        reason: 'multiblock-aligned',
      };
    }
    return { range, structural: true, safe: false, upgraded: false, reason: 'parent-not-textblock' };
  }
  if (analysis.coversWholeParent) {
    return { range, structural: true, safe: true, upgraded: false };
  }
  if (rangeMatchesEntireParentText(doc, range, analysis)) {
    const upgradedRange: MarkRange = {
      from: analysis.parentContentFrom,
      to: analysis.parentContentTo,
    };
    return {
      range: upgradedRange,
      structural: true,
      safe: true,
      upgraded: true,
      reason: 'upgraded-to-parent',
    };
  }
  return { range, structural: true, safe: false, upgraded: false, reason: 'not-block-aligned' };
}

function parseHeadingMarkdown(
  schema: EditorView['state']['schema'],
  markdown: string,
  parser?: MarkdownParser,
): ProseMirrorNode | null {
  const trimmed = markdown.trim();
  if (!trimmed) return null;

  // Prefer the markdown parser when available so inline formatting (e.g., italics)
  // inside headings is preserved on accept.
  if (parser) {
    try {
      const parsed = parser(trimmed);
      const first = parsed.content.firstChild;
      if (parsed.content.childCount === 1 && first?.type?.name === 'heading') {
        return first;
      }
    } catch (error) {
      console.warn('[marks] Failed to parse heading markdown; falling back to regex.', error);
    }
  }

  const match = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (!match) return null;

  const headingType = schema.nodes.heading;
  if (!headingType) return null;

  const level = Math.min(6, Math.max(1, match[1].length));
  const text = match[2].trim();

  // Even in the regex fallback, try to preserve inline markdown (e.g., italics)
  // by parsing the heading text content into inline marks.
  if (parser) {
    try {
      const parsedInline = parser(text);
      if (parsedInline.content.childCount === 1) {
        const firstBlock = parsedInline.content.firstChild;
        if (firstBlock?.isTextblock && headingType.validContent(firstBlock.content)) {
          return headingType.create({ level }, firstBlock.content);
        }
      }
    } catch (error) {
      console.warn('[marks] Failed to parse inline heading markdown fallback; using plain text.', error);
    }
  }

  return headingType.create({ level }, schema.text(text));
}

function getReplacementSize(replacement: ProseMirrorNode | Fragment): number {
  return 'nodeSize' in replacement ? replacement.nodeSize : replacement.size;
}

function analyzeTextblockRange(doc: ProseMirrorNode, range: MarkRange): {
  sameParent: boolean;
  parentIsTextblock: boolean;
  coversWholeParent: boolean;
  parentDepth: number;
  parentStart: number;
  parentEnd: number;
  parentContentFrom: number;
  parentContentTo: number;
} {
  const $from = doc.resolve(range.from);
  const $to = doc.resolve(range.to);
  const sameParent = $from.parent === $to.parent;
  const parentIsTextblock = sameParent && $from.parent.isTextblock;
  const coversWholeParent = parentIsTextblock
    && $from.parentOffset === 0
    && $to.parentOffset === $to.parent.content.size;
  const parentDepth = $from.depth;
  const parentStart = $from.start(parentDepth) - 1;
  const parentEnd = parentStart + $from.parent.nodeSize;
  const parentContentFrom = $from.start(parentDepth);
  const parentContentTo = $from.end(parentDepth);
  return {
    sameParent,
    parentIsTextblock,
    coversWholeParent,
    parentDepth,
    parentStart,
    parentEnd,
    parentContentFrom,
    parentContentTo,
  };
}

type MarkdownApplySuccess = {
  ok: true;
  tr: Transaction;
  appliedRange: MarkRange;
};

type MarkdownApplyFailure = {
  ok: false;
};

type MarkdownApplyResult = MarkdownApplySuccess | MarkdownApplyFailure;

function buildTextblockSplitReplacement(
  doc: ProseMirrorNode,
  range: MarkRange,
  analysis: ReturnType<typeof analyzeTextblockRange>,
  parsedFragment: Fragment,
): {
  replaceFrom: number;
  replaceTo: number;
  replacement: Fragment;
  appliedRange: MarkRange;
} | null {
  if (!analysis.sameParent || !analysis.parentIsTextblock) return null;

  const $from = doc.resolve(range.from);
  const $to = doc.resolve(range.to);
  if ($from.parent !== $to.parent) return null;

  const parent = $from.parent;
  const beforeContent = parent.content.cut(0, $from.parentOffset);
  const afterContent = parent.content.cut($to.parentOffset, parent.content.size);

  const nodes: ProseMirrorNode[] = [];
  let insertedOffset = 0;

  if (beforeContent.size > 0) {
    const beforeNode = parent.type.create(parent.attrs, beforeContent, parent.marks);
    nodes.push(beforeNode);
    insertedOffset += beforeNode.nodeSize;
  }

  for (let index = 0; index < parsedFragment.childCount; index += 1) {
    nodes.push(parsedFragment.child(index));
  }

  if (afterContent.size > 0) {
    const afterNode = parent.type.create(parent.attrs, afterContent, parent.marks);
    nodes.push(afterNode);
  }

  if (nodes.length === 0) return null;

  const replacement = Fragment.fromArray(nodes);
  const appliedFrom = analysis.parentStart + insertedOffset;
  const appliedTo = appliedFrom + parsedFragment.size;

  return {
    replaceFrom: analysis.parentStart,
    replaceTo: analysis.parentEnd,
    replacement,
    appliedRange: { from: appliedFrom, to: appliedTo },
  };
}

function applyMarkdownReplace(
  view: EditorView,
  tr: Transaction,
  range: MarkRange,
  markdown: string,
  by: string,
  parser: MarkdownParser | undefined
): MarkdownApplyResult {
  const parsedFragment = parseMarkdownFragment(parser, markdown);
  const docBefore = tr.doc;
  const structural = resolveStructuralReplaceRange(docBefore, range, markdown, parser);
  const effectiveRange = structural.range;
  const structuralSafe = structural.structural && structural.safe;
  const analysis = analyzeTextblockRange(docBefore, effectiveRange);

  // Default to a plain-text replacement for non-structural inline content.
  let replaceFrom = effectiveRange.from;
  let replaceTo = effectiveRange.to;
  let replacement: ProseMirrorNode | Fragment = view.state.schema.text(markdown);
  let usedPreservedTextblock = false;
  let usedExplicitHeading = false;

  // For non-structural replacements that cover a whole textblock, preserve the
  // existing block/container type (heading level, list item paragraph, etc.)
  // and only replace the block's inline content.
  if (!structural.structural && analysis.coversWholeParent && analysis.parentIsTextblock) {
    const preserved = buildPreservedTextblockContent(
      docBefore,
      effectiveRange,
      markdown,
      parser,
      (text) => view.state.schema.text(text),
    );
    if (preserved) {
      replaceFrom = analysis.parentContentFrom;
      replaceTo = analysis.parentContentTo;
      replacement = preserved.content;
      usedPreservedTextblock = true;
    }
  }

  // Prefer explicit heading construction when the markdown is a heading and
  // we are replacing an entire text block. This avoids literal "##" text.
  if (!usedPreservedTextblock && analysis.coversWholeParent) {
    const headingNode = parseHeadingMarkdown(view.state.schema, markdown, parser);
    if (headingNode) {
      replaceFrom = analysis.parentStart;
      replaceTo = analysis.parentEnd;
      replacement = headingNode;
      usedExplicitHeading = true;
    }
  }

  if (!usedPreservedTextblock && !usedExplicitHeading && parsedFragment && parsedFragment.childCount > 0) {
    // If the parser returns a single paragraph but we are not replacing the entire
    // textblock, treat it as inline content so markdown like *italic* parses correctly.
    const unwrappedParagraph = !analysis.coversWholeParent ? unwrapSingleParagraph(parsedFragment) : null;
    const parsedFragmentForReplace = unwrappedParagraph ?? parsedFragment;

    const hasBlockNodes = fragmentHasBlockNodes(parsedFragmentForReplace);
    if (hasBlockNodes) {
      if (analysis.coversWholeParent) {
        // We can safely insert block nodes when replacing an entire textblock.
        replaceFrom = analysis.parentStart;
        replaceTo = analysis.parentEnd;
        replacement = parsedFragmentForReplace;
      } else if (structuralSafe) {
        // Structural markdown that spans multiple aligned textblocks should
        // replace the full block nodes, not insert literal "##" text.
        const $from = docBefore.resolve(effectiveRange.from);
        const fromBlockStart = $from.start($from.depth) - 1;
        const $to = docBefore.resolve(effectiveRange.to);
        const toBlockStart = $to.start($to.depth) - 1;
        const toBlockEnd = toBlockStart + $to.parent.nodeSize;
        replaceFrom = Math.max(0, fromBlockStart);
        replaceTo = Math.max(replaceFrom, toBlockEnd);
        replacement = parsedFragmentForReplace;
      }
    } else {
      // Inline-only suggestions can be inserted directly; unwrap a single paragraph.
      replacement = parsedFragmentForReplace;
    }
  }

  if (structural.structural && !usedPreservedTextblock && !usedExplicitHeading) {
    const structuralHasParsedBlocks = Boolean(parsedFragment && parsedFragment.childCount > 0 && fragmentHasBlockNodes(parsedFragment));
    if (!structuralHasParsedBlocks) {
      console.warn('[marks] Rejecting structural replace accept because markdown could not be safely parsed.');
      return { ok: false };
    }
  }

  try {
    tr = tr.replaceWith(replaceFrom, replaceTo, replacement);
  } catch (error) {
    console.warn('[marks] Markdown replacement failed; refusing unsafe plain-text fallback.', error);
    return { ok: false };
  }

  const appliedRange: MarkRange = {
    from: replaceFrom,
    to: replaceFrom + getReplacementSize(replacement),
  };
  tr = addAuthoredMarkToTransaction(view.state, tr, appliedRange, by);
  return { ok: true, tr, appliedRange };
}

function applyMarkdownInsert(
  view: EditorView,
  tr: Transaction,
  range: MarkRange,
  markdown: string,
  by: string,
  parser: MarkdownParser | undefined
): MarkdownApplyResult {
  const parsedFragment = parseMarkdownFragment(parser, markdown);
  const docBefore = tr.doc;
  const analysis = analyzeTextblockRange(docBefore, range);

  const defaultRange: MarkRange = { from: range.from, to: range.to };

  if (!parsedFragment || parsedFragment.childCount === 0) {
    if (isStructuralMarkdown(markdown, parser)) {
      console.warn('[marks] Rejecting structural insert accept because markdown could not be parsed.');
      return { ok: false };
    }
    tr = addAuthoredMarkToTransaction(view.state, tr, defaultRange, by);
    return { ok: true, tr, appliedRange: defaultRange };
  }

  const structural = isStructuralMarkdown(markdown, parser);
  const inlineCandidate = !structural ? unwrapSingleParagraph(parsedFragment) : null;
  const parsedFragmentForInsert = inlineCandidate ?? parsedFragment;
  const hasBlockNodes = fragmentHasBlockNodes(parsedFragmentForInsert);
  if (hasBlockNodes && analysis.coversWholeParent) {
    try {
      tr = tr.replaceWith(analysis.parentStart, analysis.parentEnd, parsedFragmentForInsert);
      const appliedRange: MarkRange = {
        from: analysis.parentStart,
        to: analysis.parentStart + getReplacementSize(parsedFragmentForInsert),
      };
      tr = addAuthoredMarkToTransaction(view.state, tr, appliedRange, by);
      return { ok: true, tr, appliedRange };
    } catch (error) {
      console.warn('[marks] Markdown insert upgrade failed; refusing unsafe plain-text fallback.', error);
      return { ok: false };
    }
  }

  if (hasBlockNodes) {
    const splitReplacement = buildTextblockSplitReplacement(docBefore, range, analysis, parsedFragmentForInsert);
    if (!splitReplacement) {
      console.warn('[marks] Rejecting structural insert accept because insertion point is not block-safe.');
      return { ok: false };
    }

    try {
      tr = tr.replaceWith(splitReplacement.replaceFrom, splitReplacement.replaceTo, splitReplacement.replacement);
      tr = addAuthoredMarkToTransaction(view.state, tr, splitReplacement.appliedRange, by);
      return { ok: true, tr, appliedRange: splitReplacement.appliedRange };
    } catch (error) {
      console.warn('[marks] Structural insert replacement failed; refusing unsafe plain-text fallback.', error);
      return { ok: false };
    }
  }

  let appliedRange: MarkRange = defaultRange;

  // If the parsed markdown is inline-only, attempt to replace the literal markdown
  // with parsed inline content (e.g., convert *italic* into emphasis marks).
  if (!hasBlockNodes) {
    const replacement = buildReplacementContent(
      docBefore,
      range,
      markdown,
      parser,
      (text) => view.state.schema.text(text)
    );
    if (replacement.usedParsed && replacement.authoredInline) {
      try {
        tr = tr.replaceWith(range.from, range.to, replacement.content);
        appliedRange = { from: range.from, to: range.from + replacement.size };
      } catch (error) {
        console.warn('[marks] Inline markdown insert replacement failed; falling back to authored mark only.', error);
      }
    }
  }

  tr = addAuthoredMarkToTransaction(view.state, tr, appliedRange, by);
  return { ok: true, tr, appliedRange };
}

export function accept(view: EditorView, markId: string, parser?: MarkdownParser): boolean {
  const effectiveParser = resolveMarkdownParser(parser);
  const marks = getMarks(view.state);
  const mark = marks.find(item => item.id === markId);
  if (!mark) return false;

  const metadata = getMarkMetadata(view.state);
  let tr = view.state.tr;
  const ranges = resolveActionRangesDescending(view.state.doc, mark);
  if (ranges.length === 0) return false;
  let applied = false;

  switch (mark.kind) {
    case 'insert': {
      const markType = getMarkTypeForKind(view.state, 'insert');
      if (!markType) return false;
      for (const range of ranges) {
        tr = tr.removeMark(range.from, range.to, markType);
        const data = mark.data as InsertData | undefined;
        const content = data?.content ?? getTextForRange(view.state.doc, range);
        const result = applyMarkdownInsert(view, tr, range, content, mark.by, effectiveParser);
        if (!result.ok) return false;
        tr = result.tr;
      }
      applied = true;
      break;
    }
    case 'delete': {
      for (const range of ranges) {
        tr = tr.delete(range.from, range.to);
      }
      applied = true;
      break;
    }
    case 'replace': {
      const data = mark.data as ReplaceData | undefined;
      if (ranges.length !== 1) return false;
      const range = ranges[0];
      const markType = getMarkTypeForKind(view.state, 'replace');
      if (markType) {
        // Ensure the accepted suggestion mark clears even when the replacement content is a no-op.
        const attrs = buildSuggestionAttrs(mark.id, 'replace', mark.by, metadata[mark.id]);
        tr = tr.removeMark(range.from, range.to, markType.create(attrs));
      }
      const replacementContent =
        (typeof data?.content === 'string' && data.content.trim().length > 0)
          ? data.content
          : (typeof mark.content === 'string' && mark.content.trim().length > 0)
            ? mark.content
            : getTextForRange(view.state.doc, range);
      const existingText = getTextForRange(view.state.doc, range);
      if (existingText === replacementContent) {
        // A no-op accept should only clear the suggestion mark and preserve any
        // nested comments/review marks already anchored inside the range.
        applied = true;
        break;
      }
      const structural = resolveStructuralReplaceRange(
        view.state.doc,
        range,
        replacementContent,
        effectiveParser,
      );
      if (structural.structural && !structural.safe) {
        console.warn('[marks] Rejecting structural replace accept that is not block-aligned.', {
          reason: structural.reason,
          range,
          markdownPreview: replacementContent.slice(0, 80),
        });
        return false;
      }
      const effectiveRange = structural.range;
      const result = applyMarkdownReplace(
        view,
        tr,
        effectiveRange,
        replacementContent,
        mark.by,
        effectiveParser,
      );
      if (!result.ok) return false;
      tr = result.tr;
      applied = true;
      break;
    }
    default:
      return false;
  }

  if (!applied) return false;
  const updatedMetadata = removeMetadataEntries(metadata, [markId]);
  finalizeMarkTransaction(view, tr, updatedMetadata);
  markResolvedMarkIds([markId], Date.now(), RESOLVED_MARK_TOMBSTONE_TTL_MS, 'deleted');
  emitMarkEvent('suggestion.accepted', { markId, kind: mark.kind, by: mark.by });
  return true;
}

export function reject(view: EditorView, markId: string): boolean {
  const marks = getMarks(view.state);
  const mark = marks.find(item => item.id === markId);
  if (!mark) return false;

  const metadata = getMarkMetadata(view.state);
  let tr = view.state.tr;
  const ranges = resolveActionRangesDescending(view.state.doc, mark);
  if (ranges.length === 0) return false;

  switch (mark.kind) {
    case 'insert':
      for (const range of ranges) {
        tr = tr.delete(range.from, range.to);
      }
      break;
    case 'delete': {
      const markType = getMarkTypeForKind(view.state, 'delete');
      if (!markType) return false;
      for (const range of ranges) {
        tr = tr.removeMark(range.from, range.to, markType);
      }
      break;
    }
    case 'replace': {
      const markType = getMarkTypeForKind(view.state, 'replace');
      if (!markType) return false;
      for (const range of ranges) {
        tr = tr.removeMark(range.from, range.to, markType);
      }
      break;
    }
    default:
      return false;
  }

  const updatedMetadata = removeMetadataEntries(metadata, [markId]);
  finalizeMarkTransaction(view, tr, updatedMetadata);
  markResolvedMarkIds([markId], Date.now(), RESOLVED_MARK_TOMBSTONE_TTL_MS, 'deleted');
  emitMarkEvent('suggestion.rejected', { markId, kind: mark.kind, by: mark.by });
  return true;
}

export function acceptAll(view: EditorView, parser?: MarkdownParser): number {
  const effectiveParser = resolveMarkdownParser(parser);
  let acceptedCount = 0;
  const maxPasses = 4;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const pending = getPendingSuggestions(getMarks(view.state));
    if (pending.length === 0) break;

    // Recompute ordering from the current document each pass so ranges stay stable.
    const sortedIds = [...pending]
      .sort((a, b) => {
        const aRanges = resolveActionRanges(view.state.doc, a);
        const bRanges = resolveActionRanges(view.state.doc, b);
        const aMax = aRanges.length ? aRanges[aRanges.length - 1].from : -1;
        const bMax = bRanges.length ? bRanges[bRanges.length - 1].from : -1;
        return bMax - aMax;
      })
      .map((mark) => mark.id);

    let acceptedInPass = 0;
    for (const markId of sortedIds) {
      if (accept(view, markId, effectiveParser)) {
        acceptedCount += 1;
        acceptedInPass += 1;
      }
    }

    if (acceptedInPass === 0) break;
  }

  return acceptedCount;
}

export function rejectAll(view: EditorView): number {
  const marks = getPendingSuggestions(getMarks(view.state));
  if (marks.length === 0) return 0;

  const metadata = getMarkMetadata(view.state);
  let tr = view.state.tr;
  const removedIds: string[] = [];

  const sorted = [...marks].sort((a, b) => {
    const aRanges = resolveActionRanges(view.state.doc, a);
    const bRanges = resolveActionRanges(view.state.doc, b);
    const aMax = aRanges.length ? aRanges[aRanges.length - 1].from : -1;
    const bMax = bRanges.length ? bRanges[bRanges.length - 1].from : -1;
    return bMax - aMax;
  });

  for (const mark of sorted) {
    const ranges = resolveActionRangesDescending(view.state.doc, mark);
    if (ranges.length === 0) continue;

    switch (mark.kind) {
      case 'insert':
        for (const range of ranges) {
          const from = tr.mapping.map(range.from);
          const to = tr.mapping.map(range.to);
          tr = tr.delete(from, to);
        }
        break;
      case 'delete': {
        const markType = getMarkTypeForKind(view.state, 'delete');
        for (const range of ranges) {
          const from = tr.mapping.map(range.from);
          const to = tr.mapping.map(range.to);
          if (markType) {
            tr = tr.removeMark(from, to, markType);
          }
        }
        break;
      }
      case 'replace': {
        const markType = getMarkTypeForKind(view.state, 'replace');
        for (const range of ranges) {
          const from = tr.mapping.map(range.from);
          const to = tr.mapping.map(range.to);
          if (markType) {
            tr = tr.removeMark(from, to, markType);
          }
        }
        break;
      }
    }

    removedIds.push(mark.id);
  }

  if (removedIds.length > 0) {
    const updatedMetadata = removeMetadataEntries(metadata, removedIds);
    finalizeMarkTransaction(view, tr, updatedMetadata);
    markResolvedMarkIds(removedIds, Date.now(), RESOLVED_MARK_TOMBSTONE_TTL_MS, 'deleted');
  }

  return removedIds.length;
}

export function deleteMark(view: EditorView, markId: string): boolean {
  const marks = getMarks(view.state);
  const mark = marks.find(item => item.id === markId);
  if (!mark) return false;

  const markType = getMarkTypeForKind(view.state, mark.kind);
  if (!markType) return false;

  const ranges = resolveActionRangesDescending(view.state.doc, mark);
  if (ranges.length === 0) return false;

  let tr = view.state.tr;
  for (const range of ranges) {
    tr = tr.removeMark(range.from, range.to, markType);
  }
  const metadata = removeMetadataEntries(getMarkMetadata(view.state), [markId]);
  finalizeMarkTransaction(view, tr, metadata);
  markResolvedMarkIds([markId], Date.now(), RESOLVED_MARK_TOMBSTONE_TTL_MS, 'deleted');
  return true;
}

// Authored marks (authorship tracking)
export function addAuthoredMark(view: EditorView, by: string, range: MarkRange, quote?: string): Mark {
  const markType = getMarkTypeForKind(view.state, 'authored');
  const actualQuote = quote ?? view.state.doc.textBetween(range.from, range.to, '\n', '\n');
  const authored: Mark = {
    id: `authored:${by}:${range.from}-${range.to}`,
    kind: 'authored',
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(actualQuote),
    data: {},
  };

  if (!markType) return authored;

  let tr = view.state.tr;
  tr = tr.removeMark(range.from, range.to, markType);
  tr = tr.addMark(range.from, range.to, markType.create({ by }));
  view.dispatch(tr);
  return authored;
}

export function setAuthoredMark(view: EditorView, by: string, range: MarkRange): Mark {
  return addAuthoredMark(view, by, range);
}

export function getAuthorshipStats(view: EditorView): {
  humanPercent: number;
  aiPercent: number;
  humanChars: number;
  aiChars: number;
} {
  const marks = getMarks(view.state);
  const docLength = view.state.doc.textContent.length;
  return calculateAuthorshipStats(marks, docLength);
}

export function coalesceMarks(view: EditorView): void {
  const metadata = getMarkMetadata(view.state);
  finalizeMarkTransaction(view, view.state.tr, metadata);
}

export function updateMarksAfterEdit(_view: EditorView, _editFrom: number, _editTo: number, _newLength: number): void {
  // Inline marks move with content; no manual remapping needed.
}

// ============================================================================
// Resolvers
// ============================================================================

export function resolveMarks(doc: ProseMirrorNode, marks: Mark[]): ResolvedMark[] {
  return marks.map(mark => {
    const ranges = collectAnchorRanges(doc, mark);
    const effectiveRanges = ranges.length > 0
      ? ranges
      : (mark.range ? [mark.range] : []);
    return {
      ...mark,
      resolvedRange: effectiveRanges[0] ?? null,
      resolvedRanges: effectiveRanges.length ? effectiveRanges : undefined,
    };
  });
}

// ============================================================================
// Decorations
// ============================================================================

const STYLES = {
  flagged: 'border-left: 3px solid #FCA5A5; padding-left: 4px; background-color: rgba(252, 165, 165, 0.1);',

  comment: 'background-color: rgba(252, 211, 77, 0.3); border-bottom: 2px solid #FCD34D;',
  comment_active: 'background-color: rgba(252, 211, 77, 0.5); border-bottom: 2px solid #FBBF24;',
  comment_resolved: 'background-color: rgba(156, 163, 175, 0.15); border-bottom: 1px dashed #9CA3AF;',
  compose_anchor: 'background-color: rgba(252, 211, 77, 0.22); border-bottom: 2px dashed #F59E0B;',

  insert: 'background-color: rgba(34, 197, 94, 0.25); border-bottom: 2px solid #22C55E;',
  delete: 'background-color: rgba(239, 68, 68, 0.2); text-decoration: line-through; color: #666;',
};

function normalizeComposeAnchorRange(range: MarkRange | null, doc: ProseMirrorNode): MarkRange | null {
  if (!range) return null;
  const minPos = 0;
  const maxPos = doc.content.size;
  const from = Math.max(minPos, Math.min(range.from, maxPos));
  const to = Math.max(minPos, Math.min(range.to, maxPos));
  if (to <= from) return null;
  return { from, to };
}

function createDecorations(
  state: EditorState,
  marks: Mark[],
  activeMarkId: string | null,
  composeAnchorRange: MarkRange | null
): DecorationSet {
  const decorations: Decoration[] = [];
  const resolved = resolveMarks(state.doc, marks);
  const primaryReplaceMarkIds = new Set<string>();
  const overlappingReplaceGroups = new Map<string, Mark[]>();

  const safeComposeRange = normalizeComposeAnchorRange(composeAnchorRange, state.doc);
  if (safeComposeRange) {
    decorations.push(
      Decoration.inline(safeComposeRange.from, safeComposeRange.to, {
        class: 'mark-compose-anchor',
        style: STYLES.compose_anchor,
      })
    );
  }

  for (const mark of resolved) {
    if (mark.kind !== 'replace') continue;
    const data = mark.data as ReplaceData | undefined;
    if (data?.status !== 'pending') continue;
    const ranges = mark.resolvedRanges ?? (mark.resolvedRange ? [mark.resolvedRange] : []);
    if (ranges.length === 0) continue;
    const key = ranges.map((range) => `${range.from}:${range.to}`).join('|');
    const group = overlappingReplaceGroups.get(key) ?? [];
    group.push(mark);
    overlappingReplaceGroups.set(key, group);
  }

  for (const group of overlappingReplaceGroups.values()) {
    group.sort((a, b) => {
      const atDiff = Date.parse(b.at) - Date.parse(a.at);
      if (atDiff !== 0) return atDiff;
      return b.id.localeCompare(a.id);
    });
    const primary = group[0];
    if (primary) primaryReplaceMarkIds.add(primary.id);
  }

  for (const mark of resolved) {
    const ranges = mark.resolvedRanges ?? (mark.resolvedRange ? [mark.resolvedRange] : []);
    if (ranges.length === 0) continue;
    const isActive = mark.id === activeMarkId;

    let style = '';
    let cssClass = '';

    let replacementContent: string | null = null;

    switch (mark.kind) {
      case 'authored': {
        style = getAuthoredDecorationStyle(mark.by);
        cssClass = 'mark-authored';
        break;
      }

      case 'approved':
      case 'flagged':
        continue;

      case 'comment': {
        const data = mark.data as CommentData;
        if (data?.resolved) continue;
        style = isActive ? STYLES.comment_active : STYLES.comment;
        cssClass = `mark-comment ${isActive ? 'mark-active' : ''}`;
        break;
      }

      case 'insert': {
        const data = mark.data as InsertData;
        if (data?.status === 'pending') {
          style = STYLES.insert;
          cssClass = 'mark-insert';
        }
        break;
      }

      case 'delete': {
        const data = mark.data as DeleteData;
        if (data?.status === 'pending') {
          style = STYLES.delete;
          cssClass = 'mark-delete';
        }
        break;
      }

      case 'replace': {
        const data = mark.data as ReplaceData;
        if (data?.status === 'pending') {
          if (!primaryReplaceMarkIds.has(mark.id)) {
            continue;
          }
          style = STYLES.delete;
          cssClass = 'mark-replace mark-delete';
          replacementContent = data.content ?? '';
        }
        break;
      }
    }

    if (style) {
      // Add glow class for newly-created marks (within last 2 seconds)
      const GLOW_DURATION_MS = 2000;
      const markAge = Date.now() - new Date(mark.at).getTime();
      const glowClass = markAge < GLOW_DURATION_MS ? 'proof-mark-new' : '';

      for (const { from, to } of ranges) {
        decorations.push(
          Decoration.inline(from, to, {
            class: [cssClass, glowClass].filter(Boolean).join(' '),
            style,
            'data-mark-id': mark.id,
            'data-mark-kind': mark.kind,
          })
        );
      }

      if (mark.kind === 'replace' && replacementContent !== null) {
        const widgetPos = ranges.reduce((maxPos, range) => Math.max(maxPos, range.to), 0);
        decorations.push(
          Decoration.widget(
            widgetPos,
            () => {
              const span = document.createElement('span');
              span.className = ['mark-replace-insert', 'mark-insert', glowClass].filter(Boolean).join(' ');
              span.style.cssText = STYLES.insert;
              span.setAttribute('data-mark-id', mark.id);
              span.setAttribute('data-mark-kind', 'replace');
              span.textContent = replacementContent ?? '';
              return span;
            },
            { side: 1, key: `replace-insert-${mark.id}` }
          )
        );
      }
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

// ============================================================================
// Plugin
// ============================================================================

// Inject glow animation and refresh transition CSS
let glowStylesInjected = false;
function injectGlowStyles(): void {
  if (glowStylesInjected) return;
  glowStylesInjected = true;

  const style = document.createElement('style');
  style.id = 'proof-mark-glow-styles';
  style.textContent = `
    /* Glow animation for newly-created suggestion marks */
    @keyframes proof-change-glow {
      0% { box-shadow: 0 0 8px rgba(34, 197, 94, 0.6); background-color: rgba(34, 197, 94, 0.4); }
      100% { box-shadow: none; background-color: rgba(34, 197, 94, 0.25); }
    }
    .proof-mark-new { animation: proof-change-glow 2s ease-out forwards; }

    /* Delete glow */
    .mark-delete.proof-mark-new {
      animation-name: proof-delete-glow;
    }
    @keyframes proof-delete-glow {
      0% { box-shadow: 0 0 8px rgba(239, 68, 68, 0.6); }
      100% { box-shadow: none; }
    }

    /* Refresh transition animations */
    .proof-refreshing { opacity: 0.3; transition: opacity 200ms ease-out; }
    .proof-refreshed { opacity: 1; transition: opacity 300ms ease-in; }

    /* External change toast notification */
    .proof-external-change-toast {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 10000;
      background: white;
      color: #1a1a1a;
      border-radius: 10px;
      padding: 12px 16px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 340px;
      animation: proof-toast-slide-in 250ms ease-out;
    }
    .proof-share-welcome-toast {
      max-width: min(420px, calc(100vw - 24px));
    }
    @media (prefers-color-scheme: dark) {
      .proof-external-change-toast {
        background: #2a2a2e;
        color: #e8e8e8;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.08);
      }
    }
    @keyframes proof-toast-slide-in {
      from { transform: translateY(-12px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    @keyframes proof-toast-slide-in-centered {
      from { transform: translate(-50%, -12px); opacity: 0; }
      to { transform: translate(-50%, 0); opacity: 1; }
    }
    .proof-toast-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .proof-toast-content--welcome {
      position: relative;
      padding-right: 20px;
    }
    .proof-toast-message {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.3;
    }
    .proof-toast-submessage {
      font-size: 12px;
      color: #4b5563;
      line-height: 1.35;
    }
    @media (prefers-color-scheme: dark) {
      .proof-toast-submessage { color: #cbd5f5; }
    }
    .proof-toast-close {
      position: absolute;
      top: -2px;
      right: -4px;
      border: none;
      background: transparent;
      color: inherit;
      opacity: 0.55;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 6px;
      font-family: inherit;
      transition: opacity 150ms, background 150ms;
    }
    .proof-toast-close:hover {
      opacity: 0.9;
      background: rgba(0, 0, 0, 0.06);
    }
    .proof-toast-close:active {
      opacity: 1;
    }
    @media (max-width: 760px) {
      .proof-share-welcome-toast {
        width: calc(100vw - 16px);
        max-width: calc(100vw - 16px);
        border-radius: 12px;
        padding: 10px 12px;
        animation: proof-toast-slide-in-centered 250ms ease-out;
      }
      .proof-share-welcome-toast .proof-toast-content--welcome {
        padding-right: 24px;
      }
      .proof-share-welcome-toast .proof-toast-message {
        font-size: 12px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .proof-share-welcome-toast .proof-toast-close {
        top: -1px;
        right: -2px;
      }
    }
    .proof-toast-actions {
      display: flex;
      gap: 6px;
    }
    .proof-toast-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
      font-weight: 500;
      font-family: inherit;
      text-decoration: none;
      transition: opacity 150ms;
    }
    .proof-toast-primary {
      background: #111827;
      color: #fff;
    }
    .proof-toast-secondary {
      background: transparent;
      color: #111827;
      border: 1px solid rgba(17, 24, 39, 0.2);
    }
    @media (prefers-color-scheme: dark) {
      .proof-toast-primary {
        background: #f8fafc;
        color: #111827;
      }
      .proof-toast-secondary {
        color: #e2e8f0;
        border-color: rgba(226, 232, 240, 0.4);
      }
    }
    .proof-toast-review {
      background: #007AFF;
      color: white;
    }
    .proof-toast-accept-all {
      background: #34C759;
      color: white;
    }
    .proof-toast-reject-all {
      background: transparent;
      color: #FF3B30;
      border: 1px solid rgba(255, 59, 48, 0.3);
    }
    .proof-toast-btn:hover { opacity: 0.85; }
    .proof-toast-btn:active { opacity: 0.7; }

    /* Refresh banner */
    .proof-refresh-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      margin: 0 0 8px 0;
      background: linear-gradient(135deg, #f0f4ff, #e8f0fe);
      color: #1a1a1a;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      border-radius: 8px;
      border: 1px solid rgba(0, 122, 255, 0.15);
      animation: proof-banner-slide-down 250ms ease-out;
    }
    @media (prefers-color-scheme: dark) {
      .proof-refresh-banner {
        background: linear-gradient(135deg, #1e2333, #252a3a);
        color: #e2e8f0;
        border-color: rgba(100, 140, 255, 0.2);
      }
    }
    @keyframes proof-banner-slide-down {
      from { transform: translateY(-8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .proof-refresh-banner-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .proof-refresh-banner-title {
      font-weight: 600;
      font-size: 13px;
    }
    .proof-refresh-banner-summary {
      font-size: 12px;
      color: #555;
      font-weight: 400;
    }
    @media (prefers-color-scheme: dark) {
      .proof-refresh-banner-summary { color: #a0aec0; }
    }
    .proof-refresh-banner-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }
    .proof-refresh-banner-btn {
      border: none;
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
      font-weight: 500;
      font-family: inherit;
      background: transparent;
      color: inherit;
      transition: opacity 150ms;
    }
    .proof-refresh-revert {
      background: #007AFF;
      color: white;
    }
    .proof-refresh-dismiss {
      font-size: 18px;
      padding: 2px 8px;
      color: #999;
    }
    .proof-refresh-banner-btn:hover { opacity: 0.85; }
    .proof-refresh-banner-btn:active { opacity: 0.7; }
  `;
  document.head.appendChild(style);
}

export const marksPlugin = $prose(() => {
  // Inject glow styles when the plugin is created
  injectGlowStyles();

  return new Plugin<MarksPluginState>({
    key: marksPluginKey,

    state: {
      init(_config, state): MarksPluginState {
        return {
          metadata: normalizeMetadata({}, state.doc),
          activeMarkId: null,
          composeAnchorRange: null,
        };
      },

      apply(tr, value): MarksPluginState {
        const meta = tr.getMeta(marksPluginKey);
        let nextState = value;

        if (meta) {
          switch (meta.type) {
            case 'SET_METADATA':
              nextState = { ...value, metadata: normalizeMetadata(meta.metadata, tr.doc) };
              break;
            case 'SET_ACTIVE':
              nextState = { ...value, activeMarkId: meta.markId };
              break;
            case 'SET_COMPOSE_ANCHOR':
              nextState = { ...value, composeAnchorRange: normalizeComposeAnchorRange(meta.range ?? null, tr.doc) };
              break;
          }
        }

        if (tr.docChanged) {
          const currentComposeRange = nextState.composeAnchorRange ?? null;
          const mappedComposeRange = nextState.composeAnchorRange
            ? normalizeComposeAnchorRange({
              from: tr.mapping.map(nextState.composeAnchorRange.from, -1),
              to: tr.mapping.map(nextState.composeAnchorRange.to, 1),
            }, tr.doc)
            : null;
          const composeRangeChanged = (() => {
            if (!currentComposeRange && !mappedComposeRange) return false;
            if (!currentComposeRange || !mappedComposeRange) return true;
            return currentComposeRange.from !== mappedComposeRange.from || currentComposeRange.to !== mappedComposeRange.to;
          })();
          if (composeRangeChanged) {
            nextState = { ...nextState, composeAnchorRange: mappedComposeRange };
          }
          const normalized = normalizeMetadata(nextState.metadata, tr.doc);
          if (normalized !== nextState.metadata) {
            nextState = { ...nextState, metadata: normalized };
          }
        }

        return nextState;
      },
    },

    props: {
      decorations(state) {
        const pluginState = marksPluginKey.getState(state);
        if (!pluginState) return DecorationSet.empty;
        return createDecorations(
          state,
          collectMarks(state),
          pluginState.activeMarkId,
          pluginState.composeAnchorRange ?? null
        );
      },
    },
  });
});

// ============================================================================
// Export
// ============================================================================

export const marksPlugins = [marksCtx, marksPlugin];

export type {
  Mark,
  MarkKind,
  MarkRange,
  CommentData,
  InsertData,
  DeleteData,
  ReplaceData,
  StoredMark,
} from '../../formats/marks.js';

export {
  extractMarks,
  embedMarks,
  hasMarks,
  getMarksByKind,
  getPendingSuggestions,
  getUnresolvedComments,
  getAuthoredMarks,
  getHumanAuthored,
  getAIAuthored,
  getActiveMarks,
  getOrphanedMarks,
  findMark,
  isHuman,
  isAI,
  getActorName,
  createAuthored,
  coalesceAuthoredMarks,
  calculateAuthorshipStats,
  resolveQuote,
} from '../../formats/marks.js';
