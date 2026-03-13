/**
 * Unified Marks System
 *
 * Everything is a mark - approvals, flags, comments, and suggestions.
 * One data model, one storage format, one decoration system.
 *
 * Design principles:
 * - Atomic: Each mark is self-contained
 * - Granular: Target specific content precisely
 * - Composable: Different kinds combine for any workflow
 * - Extensible: Add new kinds without changing architecture
 */

// ============================================================================
// Colors (Single Source of Truth)
// ============================================================================

/**
 * Known colors for standard values
 * These are the "blessed" colors that have been designed to work well
 * Palette: Soft Focus - designed for the Proof editor surface
 */
const KNOWN_COLORS: Record<string, string> = {
  // Origin/authorship
  human: '#6EE7B7',  // Soft mint
  ai: '#A5B4FC',     // Soft lavender
  system: '#93C5FD', // Soft sky blue

  // Mark kinds (for future use in sidebar counts)
  approved: '#2DD4BF',   // Teal (distinct from human)
  flagged: '#FCA5A5',    // Dusty rose
  comment: '#FCD34D',    // Soft gold
  insert: '#6EE7B7',     // Soft mint (same as human)
  delete: '#FCA5A5',     // Dusty rose (same as flagged)
  replace: '#FCD34D',    // Soft gold (same as comment)
};

/**
 * Generate a consistent color from a string (for unknown kinds)
 * Uses a simple hash to pick from a palette of distinguishable colors
 */
function generateColor(key: string): string {
  // Palette of distinguishable colors (avoiding the known ones)
  const palette = [
    '#9C27B0',  // Purple
    '#00BCD4',  // Cyan
    '#FF5722',  // Deep Orange
    '#795548',  // Brown
    '#607D8B',  // Blue Grey
    '#E91E63',  // Pink
    '#009688',  // Teal
    '#673AB7',  // Deep Purple
  ];

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  return palette[Math.abs(hash) % palette.length];
}

/**
 * Get color for any key - returns known color or generates consistent one
 */
export function getMarkColor(key: string): string {
  return KNOWN_COLORS[key] || generateColor(key);
}

/**
 * Export known colors for static access (TypeScript type safety)
 */
export const MARK_COLORS = KNOWN_COLORS;

// ============================================================================
// Types
// ============================================================================

/**
 * Built-in mark kinds
 */
export type MarkKind =
  | 'authored'    // Who created this content (replaces provenance)
  | 'approved'    // Content signed off
  | 'flagged'     // Needs attention
  | 'comment'     // Discussion thread
  | 'insert'      // Proposed addition
  | 'delete'      // Proposed removal
  | 'replace';    // Proposed replacement

/**
 * Suggestion status lifecycle
 */
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

/**
 * Orchestration metadata used to tag marks created by sub-agents.
 * These fields are optional and ignored by non-orchestrated flows.
 */
export interface OrchestratedMarkMeta {
  runId?: string;
  focusAreaId?: string;
  focusAreaName?: string;
  agentId?: string;
  proposalId?: string;
  provisional?: boolean;
  orchestrator?: boolean;
  /**
   * Debug metadata for orchestration reconciliation.
   * These fields are optional and safe to ignore in non-debug flows.
   */
  debugAutoFixedQuotes?: boolean;
  debugAutoFixedQuotesReason?: string;
}

/**
 * Data payload for different mark kinds
 */
/**
 * ProseMirror document range for precise positioning
 */
export interface MarkRange {
  from: number;
  to: number;
}

export interface CommentReply {
  by: string;
  text: string;
  at: string;
}

export interface AuthoredData {
  // No additional data needed - authorship is tracked by 'by' field
}

export interface ApprovedData {
  // No additional data needed
}

export interface FlaggedData {
  note?: string;
}

export interface CommentData extends OrchestratedMarkMeta {
  text: string;
  thread: string;  // Thread ID for grouping replies
  resolved: boolean;
  replies?: CommentReply[];
}

export interface InsertData extends OrchestratedMarkMeta {
  content: string;
  status: SuggestionStatus;
}

export interface DeleteData extends OrchestratedMarkMeta {
  status: SuggestionStatus;
}

export interface ReplaceData extends OrchestratedMarkMeta {
  content: string;  // The replacement text
  status: SuggestionStatus;
}

export type MarkData =
  | AuthoredData
  | ApprovedData
  | FlaggedData
  | CommentData
  | InsertData
  | DeleteData
  | ReplaceData;

/**
 * A mark - metadata attached to specific content
 *
 * Position strategy:
 * - range: Primary position (ProseMirror document positions, not plain text offsets)
 * - quote: Fallback for recovery when positions shift
 * - orphaned: True when the referenced content no longer exists
 */
export interface Mark {
  id: string;
  kind: MarkKind;
  by: string;           // Actor: "human:name" or "ai:model"
  at: string;           // ISO timestamp

  // Position (primary: ProseMirror document positions)
  range?: MarkRange;    // { from, to } ProseMirror positions

  // Quote (fallback for recovery)
  quote: string;        // Normalized target content (full text)

  // State
  orphaned?: boolean;   // True if content deleted/moved

  // Kind-specific payload
  data?: MarkData;
}

/**
 * Document with marks
 */
export interface MarksDocument {
  version: number;
  marks: Mark[];
}

export interface StoredMark {
  kind?: MarkKind;
  by?: string;
  createdAt?: string;
  range?: MarkRange;
  /** Relative anchor start (char-offset form: `char:<offset>`). */
  startRel?: string;
  /** Relative anchor end (char-offset form: `char:<offset>`). */
  endRel?: string;
  text?: string;
  thread?: string | CommentReply[];
  threadId?: string;
  replies?: CommentReply[];
  resolved?: boolean;
  content?: string;
  status?: SuggestionStatus;
  note?: string;
  runId?: string;
  focusAreaId?: string;
  focusAreaName?: string;
  agentId?: string;
  proposalId?: string;
  provisional?: boolean;
  orchestrator?: boolean;
  debugAutoFixedQuotes?: boolean;
  debugAutoFixedQuotesReason?: string;
  /** Quote text for remote sync — allows recreating ProseMirror anchors on remote clients */
  quote?: string;
}

export interface MarksMetadataDocument {
  version: number;
  marks: Record<string, StoredMark>;
}

function hasStoredMarkRange(value: unknown): value is MarkRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = value as { from?: unknown; to?: unknown };
  return Number.isInteger(range.from) && Number.isInteger(range.to) && Number(range.from) >= 0 && Number(range.to) >= Number(range.from);
}

function storedMarkString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function authoredStoredMarkFingerprint(stored: StoredMark): string | null {
  const by = storedMarkString(stored.by) ?? 'human:unknown';
  if (hasStoredMarkRange(stored.range)) {
    return `range:${by}:${stored.range.from}-${stored.range.to}`;
  }
  const startRel = storedMarkString(stored.startRel);
  const endRel = storedMarkString(stored.endRel);
  if (startRel && endRel) {
    return `relative:${by}:${startRel}:${endRel}`;
  }
  const quote = storedMarkString(stored.quote);
  if (quote) {
    return `quote:${by}:${normalizeQuote(quote)}`;
  }
  return null;
}

function mergeStoredMarkFallbacks(existing: StoredMark, incoming: StoredMark): StoredMark {
  const merged: StoredMark = { ...existing, ...incoming };
  if (!merged.kind && existing.kind) merged.kind = existing.kind;
  if (!merged.by && existing.by) merged.by = existing.by;
  if (!merged.createdAt && existing.createdAt) merged.createdAt = existing.createdAt;
  if (!merged.range && existing.range) merged.range = existing.range;
  if (!merged.startRel && existing.startRel) merged.startRel = existing.startRel;
  if (!merged.endRel && existing.endRel) merged.endRel = existing.endRel;
  if (!merged.quote && existing.quote) merged.quote = existing.quote;
  return merged;
}

export function canonicalizeStoredMarks<T extends Record<string, unknown>>(metadata: T): T {
  const normalized: Record<string, unknown> = {};
  const authoredFingerprints = new Map<string, string>();

  for (const [id, value] of Object.entries(metadata ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      normalized[id] = value;
      continue;
    }

    const stored = value as StoredMark;
    if (stored.kind !== 'authored') {
      normalized[id] = stored;
      continue;
    }

    const fingerprint = authoredStoredMarkFingerprint(stored);
    const targetId = fingerprint ? (authoredFingerprints.get(fingerprint) ?? id) : id;

    if (fingerprint && !authoredFingerprints.has(fingerprint)) {
      authoredFingerprints.set(fingerprint, targetId);
    }

    const existing = normalized[targetId];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      normalized[targetId] = mergeStoredMarkFallbacks(existing as StoredMark, stored);
      continue;
    }

    normalized[targetId] = stored;
  }

  return normalized as T;
}

// ============================================================================
// Edit Sessions (Layers Foundation)
// ============================================================================

/**
 * Tracks a cluster of edits by the same actor within a short time window.
 * This is the metadata foundation for the future "layers" feature which
 * will answer questions about review depth, iteration count, and staleness.
 */
export interface EditSession {
  id: string;              // Unique session ID
  actor: string;           // "ai:claude-code", "human:dan", etc.
  timestamp: number;       // When this session started (ms since epoch)
  endTimestamp?: number;    // When this session ended (undefined if ongoing)
  changeCount: number;     // How many individual edits in this session
  characterDelta: number;  // Net change in characters
  source: 'file-watcher' | 'api' | 'keyboard' | 'paste';
  parentSessionId?: string; // Links to the session this one refines
  reviewType?: 'creation' | 'active-edit' | 'accept-only';
}

// ============================================================================
// ID Generation
// ============================================================================

let markIdCounter = 0;

export function generateMarkId(): string {
  return `m${Date.now()}_${++markIdCounter}`;
}

export function generateThreadId(): string {
  return `t${Date.now()}_${++markIdCounter}`;
}

// ============================================================================
// Mark Creation Helpers
// ============================================================================

/**
 * Create an authored mark (replaces provenance spans)
 * Used to track who created content at the character level
 */
export function createAuthored(
  by: string,
  range: MarkRange,
  quote?: string
): Mark {
  return {
    id: generateMarkId(),
    kind: 'authored',
    by,
    at: new Date().toISOString(),
    range,
    quote: quote ? normalizeQuote(quote) : ''
  };
}

/**
 * Create an approval mark
 */
export function createApproval(quote: string, by: string, range?: MarkRange): Mark {
  return {
    id: generateMarkId(),
    kind: 'approved',
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(quote)
  };
}

/**
 * Create a flag mark
 */
export function createFlag(quote: string, by: string, note?: string, range?: MarkRange): Mark {
  return {
    id: generateMarkId(),
    kind: 'flagged',
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(quote),
    data: note ? { note } : undefined
  };
}

/**
 * Create a comment mark
 */
export function createComment(
  quote: string,
  by: string,
  text: string,
  threadId?: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta
): Mark {
  return {
    id: generateMarkId(),
    kind: 'comment',
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(quote),
    data: {
      ...(meta ?? {}),
      text,
      thread: threadId || generateThreadId(),
      resolved: false,
      replies: []
    } as CommentData
  };
}

/**
 * Create an insert suggestion mark
 */
export function createInsertSuggestion(
  quote: string,
  by: string,
  content: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta
): Mark {
  return {
    id: generateMarkId(),
    kind: 'insert',
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(quote),
    data: {
      ...(meta ?? {}),
      content,
      status: 'pending'
    } as InsertData
  };
}

/**
 * Create a delete suggestion mark
 */
export function createDeleteSuggestion(
  quote: string,
  by: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta
): Mark {
  return {
    id: generateMarkId(),
    kind: 'delete',
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(quote),
    data: {
      ...(meta ?? {}),
      status: 'pending'
    } as DeleteData
  };
}

/**
 * Create a replace suggestion mark
 */
export function createReplaceSuggestion(
  quote: string,
  by: string,
  content: string,
  range?: MarkRange,
  meta?: OrchestratedMarkMeta
): Mark {
  return {
    id: generateMarkId(),
    kind: 'replace',
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(quote),
    data: {
      ...(meta ?? {}),
      content,
      status: 'pending'
    } as ReplaceData
  };
}

// ============================================================================
// Quote Normalization & Resolution
// ============================================================================

/**
 * Normalize a quote for storage
 * - Normalize whitespace
 */
export function normalizeQuote(text: string): string {
  // Normalize whitespace
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized;
}

/**
 * Find the position of a quote in document text
 * Returns { from, to } or null if not found
 */
export function resolveQuote(
  docText: string,
  quote: string
): { from: number; to: number } | null {
  // Normalize both for matching while tracking original positions
  const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
  if (!normalizedQuote) return null;

  const normalizedDocParts: string[] = [];
  const normalizedDocMap: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < docText.length) {
    const ch = docText[i];
    if (/\s/.test(ch)) {
      const start = i;
      while (i < docText.length && /\s/.test(docText[i])) {
        i += 1;
      }
      const end = i - 1;
      normalizedDocParts.push(' ');
      normalizedDocMap.push({ start, end });
      continue;
    }
    normalizedDocParts.push(ch);
    normalizedDocMap.push({ start: i, end: i });
    i += 1;
  }

  const normalizedDoc = normalizedDocParts.join('');

  // Try exact match first
  let index = normalizedDoc.indexOf(normalizedQuote);

  if (index === -1) {
    // Try prefix match (quote might be truncated in legacy data)
    for (let i = 0; i < normalizedDoc.length; i++) {
      if (normalizedDoc.substring(i).startsWith(normalizedQuote)) {
        index = i;
        break;
      }
    }
  }

  if (index === -1) {
    // Try fuzzy match - find best substring match
    index = fuzzyFindQuote(normalizedDoc, normalizedQuote);
  }

  if (index === -1) {
    return null;
  }

  // Map back to original positions (accounting for whitespace normalization)
  const start = normalizedDocMap[index]?.start;
  const endIndex = index + normalizedQuote.length - 1;
  const end = normalizedDocMap[endIndex]?.end;
  if (start === undefined || end === undefined) return null;
  return { from: start, to: end + 1 };
}

/**
 * Fuzzy find a quote in document text
 * Returns index or -1 if not found
 */
function fuzzyFindQuote(docText: string, quote: string): number {
  // Simple approach: look for the first N characters
  const searchLen = Math.min(30, quote.length);
  const searchStr = quote.substring(0, searchLen);

  const index = docText.indexOf(searchStr);
  return index;
}

// ============================================================================
// Range Resolution (Primary: range, Fallback: quote)
// ============================================================================

/**
 * Resolve a mark's position in the document
 *
 * Strategy:
 * 1. If mark has range, check if content at range matches quote
 * 2. If match -> use range (positions are still valid)
 * 3. If no match or no range -> use quote resolution
 * 4. If quote not found -> mark is orphaned
 */
export function resolveMark(
  docText: string,
  mark: Mark,
  docSize?: number
): { from: number; to: number; orphaned: boolean } | null {
  // Try range first
  if (mark.range) {
    const { from, to } = mark.range;
    const size = docSize ?? docText.length;

    // Check bounds
    if (from >= 0 && to <= size && from < to) {
      return { from, to, orphaned: false };
    }
  }

  // Range didn't work, try quote resolution
  if (mark.quote) {
    const quoteRange = resolveQuote(docText, mark.quote);
    if (quoteRange) {
      return { ...quoteRange, orphaned: false };
    }
  }

  // Neither worked - mark is orphaned
  return null;
}

/**
 * Mark a mark as orphaned (content deleted/moved)
 */
export function orphanMark(marks: Mark[], id: string): Mark[] {
  return marks.map(m => m.id === id ? { ...m, orphaned: true } : m);
}

/**
 * Get all orphaned marks
 */
export function getOrphanedMarks(marks: Mark[]): Mark[] {
  return marks.filter(m => m.orphaned === true);
}

/**
 * Get all non-orphaned marks
 */
export function getActiveMarks(marks: Mark[]): Mark[] {
  return marks.filter(m => m.orphaned !== true);
}

/**
 * Purge orphaned marks (clean up)
 */
export function purgeOrphanedMarks(marks: Mark[]): Mark[] {
  return marks.filter(m => m.orphaned !== true);
}

// ============================================================================
// Authored Marks (Provenance Replacement)
// ============================================================================

/**
 * Get all authored marks
 */
export function getAuthoredMarks(marks: Mark[]): Mark[] {
  return marks.filter(m => m.kind === 'authored' && m.orphaned !== true);
}

/**
 * Get authored marks by actor
 */
export function getAuthoredByActor(marks: Mark[], actor: string): Mark[] {
  return marks.filter(m => m.kind === 'authored' && m.by === actor && m.orphaned !== true);
}

/**
 * Get human-authored marks
 */
export function getHumanAuthored(marks: Mark[]): Mark[] {
  return marks.filter(m => m.kind === 'authored' && isHuman(m.by) && m.orphaned !== true);
}

/**
 * Get AI-authored marks
 */
export function getAIAuthored(marks: Mark[]): Mark[] {
  return marks.filter(m => m.kind === 'authored' && isAI(m.by) && m.orphaned !== true);
}

/**
 * Calculate authorship percentages from marks
 */
export function calculateAuthorshipStats(marks: Mark[], docLength: number): {
  humanPercent: number;
  aiPercent: number;
  humanChars: number;
  aiChars: number;
} {
  const authoredMarks = getAuthoredMarks(marks);

  let humanChars = 0;
  let aiChars = 0;

  for (const mark of authoredMarks) {
    if (!mark.range) continue;
    const chars = mark.range.to - mark.range.from;

    if (isHuman(mark.by)) {
      humanChars += chars;
    }
  }

  const totalChars = Math.max(0, docLength);
  aiChars = Math.max(0, totalChars - humanChars);
  const humanPercent = totalChars > 0 ? Math.round((humanChars / totalChars) * 100) : 0;
  const aiPercent = totalChars > 0 ? Math.round((aiChars / totalChars) * 100) : 0;

  return { humanPercent, aiPercent, humanChars, aiChars };
}

/**
 * Coalesce adjacent authored marks by the same actor
 * This keeps the mark count manageable
 */
export function coalesceAuthoredMarks(marks: Mark[]): Mark[] {
  const nonAuthored = marks.filter(m => m.kind !== 'authored');
  const authored = marks.filter(m => m.kind === 'authored');

  if (authored.length <= 1) return marks;

  // Sort by position
  authored.sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

  const coalesced: Mark[] = [];
  let current = authored[0];

  for (let i = 1; i < authored.length; i++) {
    const next = authored[i];

    // Can coalesce if same actor and adjacent/overlapping
    if (current.by === next.by && current.range && next.range) {
      const gap = next.range.from - current.range.to;

      // Allow small gaps (up to 2 chars for whitespace)
      if (gap <= 2 && gap >= 0) {
        // Merge into current
        current = {
          ...current,
          range: {
            from: current.range.from,
            to: next.range.to
          },
          at: next.at // Use latest timestamp
        };
        continue;
      }
    }

    // Can't coalesce, push current and start new
    coalesced.push(current);
    current = next;
  }

  // Don't forget the last one
  coalesced.push(current);

  return [...nonAuthored, ...coalesced];
}

/**
 * Update authored mark ranges after document edit
 * This is called when the document changes to keep ranges in sync
 */
export function updateMarkRangesAfterEdit(
  marks: Mark[],
  editFrom: number,
  editTo: number,
  newLength: number
): Mark[] {
  const delta = newLength - (editTo - editFrom);

  return marks.map(mark => {
    if (!mark.range) return mark;

    const { from, to } = mark.range;

    // Edit is entirely after this mark - no change
    if (editFrom >= to) {
      return mark;
    }

    // Edit is entirely before this mark - shift by delta
    if (editTo <= from) {
      return {
        ...mark,
        range: { from: from + delta, to: to + delta }
      };
    }

    // Edit overlaps with this mark
    // Case 1: Edit is inside the mark
    if (editFrom >= from && editTo <= to) {
      return {
        ...mark,
        range: { from, to: to + delta }
      };
    }

    // Case 2: Edit spans across mark start
    if (editFrom < from && editTo > from && editTo <= to) {
      return {
        ...mark,
        range: { from: editFrom + newLength, to: to + delta }
      };
    }

    // Case 3: Edit spans across mark end
    if (editFrom >= from && editFrom < to && editTo > to) {
      return {
        ...mark,
        range: { from, to: editFrom }
      };
    }

    // Case 4: Edit completely contains the mark - mark is orphaned
    if (editFrom <= from && editTo >= to) {
      return {
        ...mark,
        orphaned: true
      };
    }

    return mark;
  });
}

// ============================================================================
// Mark Operations
// ============================================================================

/**
 * Get marks by kind
 */
export function getMarksByKind(marks: Mark[], kind: MarkKind): Mark[] {
  return marks.filter(m => m.kind === kind);
}

/**
 * Get marks by actor
 */
export function getMarksByActor(marks: Mark[], actor: string): Mark[] {
  return marks.filter(m => m.by === actor);
}

/**
 * Get pending suggestions
 */
export function getPendingSuggestions(marks: Mark[]): Mark[] {
  return marks.filter(m => {
    if (m.kind === 'insert' || m.kind === 'delete' || m.kind === 'replace') {
      const data = m.data as InsertData | DeleteData | ReplaceData;
      return data?.status === 'pending';
    }
    return false;
  });
}

/**
 * Get unresolved comments
 */
export function getUnresolvedComments(marks: Mark[]): Mark[] {
  return marks.filter(m => {
    if (m.kind === 'comment') {
      const data = m.data as CommentData;
      return !data?.resolved;
    }
    return false;
  });
}

/**
 * Get comments in a thread
 */
export function getThread(marks: Mark[], threadId: string): Mark[] {
  const root = marks.find(m => {
    if (m.kind !== 'comment') return false;
    const data = m.data as CommentData;
    return data?.thread === threadId;
  });

  if (!root) return [];

  const data = root.data as CommentData | undefined;
  const replies = data?.replies ?? [];

  const replyMarks = replies.map((reply, index) => ({
    ...root,
    id: `${root.id}:reply:${index}`,
    by: reply.by,
    at: reply.at,
    range: undefined,
    data: {
      text: reply.text,
      thread: threadId,
      resolved: data?.resolved ?? false,
    } as CommentData,
  }));

  const sortedReplies = [...replyMarks].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()
  );

  return [root, ...sortedReplies];
}

/**
 * Find a mark by ID
 */
export function findMark(marks: Mark[], id: string): Mark | undefined {
  return marks.find(m => m.id === id);
}

/**
 * Update a mark
 */
export function updateMark(marks: Mark[], id: string, updates: Partial<Mark>): Mark[] {
  return marks.map(m => m.id === id ? { ...m, ...updates } : m);
}

/**
 * Remove a mark by ID
 */
export function removeMark(marks: Mark[], id: string): Mark[] {
  return marks.filter(m => m.id !== id);
}

/**
 * Add a mark
 */
export function addMark(marks: Mark[], mark: Mark): Mark[] {
  return [...marks, mark];
}

// ============================================================================
// Suggestion Operations
// ============================================================================

/**
 * Accept a suggestion - update its status
 */
export function acceptSuggestion(marks: Mark[], id: string): Mark[] {
  return marks.map(m => {
    if (m.id === id && (m.kind === 'insert' || m.kind === 'delete' || m.kind === 'replace')) {
      return {
        ...m,
        data: { ...m.data, status: 'accepted' } as InsertData | DeleteData | ReplaceData
      };
    }
    return m;
  });
}

/**
 * Reject a suggestion - update its status
 */
export function rejectSuggestion(marks: Mark[], id: string): Mark[] {
  return marks.map(m => {
    if (m.id === id && (m.kind === 'insert' || m.kind === 'delete' || m.kind === 'replace')) {
      return {
        ...m,
        data: { ...m.data, status: 'rejected' } as InsertData | DeleteData | ReplaceData
      };
    }
    return m;
  });
}

/**
 * Modify a suggestion's content before accepting
 */
export function modifySuggestion(marks: Mark[], id: string, newContent: string): Mark[] {
  return marks.map(m => {
    if (m.id === id && (m.kind === 'insert' || m.kind === 'replace')) {
      return {
        ...m,
        data: { ...m.data, content: newContent } as InsertData | ReplaceData
      };
    }
    return m;
  });
}

// ============================================================================
// Comment Operations
// ============================================================================

/**
 * Resolve a comment thread
 */
export function resolveComment(marks: Mark[], id: string): Mark[] {
  const mark = findMark(marks, id);
  if (!mark || mark.kind !== 'comment') return marks;

  const data = mark.data as CommentData;
  const threadId = data?.thread;

  // Resolve all comments in the thread
  return marks.map(m => {
    if (m.kind === 'comment') {
      const mData = m.data as CommentData;
      if (mData?.thread === threadId) {
        return { ...m, data: { ...mData, resolved: true } };
      }
    }
    return m;
  });
}

/**
 * Unresolve a comment thread
 */
export function unresolveComment(marks: Mark[], id: string): Mark[] {
  const mark = findMark(marks, id);
  if (!mark || mark.kind !== 'comment') return marks;

  const data = mark.data as CommentData;
  const threadId = data?.thread;

  // Unresolve all comments in the thread
  return marks.map(m => {
    if (m.kind === 'comment') {
      const mData = m.data as CommentData;
      if (mData?.thread === threadId) {
        return { ...m, data: { ...mData, resolved: false } };
      }
    }
    return m;
  });
}

// ============================================================================
// Metadata Serialization
// ============================================================================

const MARKS_START_MARKER = '<!-- PROOF';
const MARKS_END_MARKER = '-->';
const MARKS_CLOSE_MARKER = '<!-- PROOF:END -->';
const MARKS_REGEX = /\n?<!-- PROOF\n([\s\S]*?)\n-->\s*(?:<!-- PROOF:END -->\s*)?/g;

/**
 * Extract marks metadata from markdown content
 */
export function extractMarks(markdown: string): {
  content: string;
  marks: Record<string, StoredMark>;
  legacyMarks?: Mark[];
} {
  const matches = [...markdown.matchAll(MARKS_REGEX)];

  if (matches.length === 0) {
    return { content: markdown, marks: {} };
  }

  const lastMatch = matches[matches.length - 1];

  // Remove all marks blocks from content
  const content = markdown.replace(MARKS_REGEX, '').trimEnd();

  try {
    const json = lastMatch[1];
    const data = JSON.parse(json) as MarksMetadataDocument | MarksDocument | { marks?: unknown; version?: unknown };

    const version = typeof (data as { version?: unknown }).version === 'number'
      ? (data as { version?: number }).version
      : undefined;
    const marksPayload = (data as { marks?: unknown }).marks;

    if (Array.isArray(marksPayload)) {
      return { content, marks: {}, legacyMarks: marksPayload as Mark[] };
    }

    if (version !== undefined && version !== 2 && version !== 1) {
      console.warn(`Unknown marks version: ${version}`);
    }

    if (version === 1 && marksPayload && Array.isArray(marksPayload)) {
      return { content, marks: {}, legacyMarks: marksPayload as Mark[] };
    }

    return { content, marks: removeFinalizedSuggestionMetadata((marksPayload as Record<string, StoredMark>) ?? {}) };
  } catch (error) {
    console.warn('Failed to parse marks:', error);
    return { content, marks: {} };
  }
}

export function removeFinalizedSuggestionMetadata(marks: Record<string, StoredMark>): Record<string, StoredMark> {
  const filtered: Record<string, StoredMark> = {};
  for (const [id, mark] of Object.entries(marks)) {
    const status = mark?.status;
    const kind = mark?.kind;
    if ((kind === 'insert' || kind === 'delete' || kind === 'replace') && (status === 'accepted' || status === 'rejected')) {
      continue;
    }
    filtered[id] = mark;
  }
  return filtered;
}

/**
 * Embed marks metadata into markdown content
 */
export function embedMarks(markdown: string, marks: Record<string, StoredMark>): string {
  // Remove existing marks block if present
  let content = markdown.replace(MARKS_REGEX, '').trimEnd();

  const filteredMarks = removeFinalizedSuggestionMetadata(marks ?? {});

  if (Object.keys(filteredMarks).length === 0) {
    return content;
  }

  const doc: MarksMetadataDocument = {
    version: 2,
    marks: filteredMarks
  };

  const json = JSON.stringify(doc, null, 2);

  if (!content.endsWith('\n')) {
    content += '\n';
  }

  return `${content}\n${MARKS_START_MARKER}\n${json}\n${MARKS_END_MARKER}\n\n${MARKS_CLOSE_MARKER}\n`;
}

/**
 * Check if markdown has embedded marks metadata
 */
export function hasMarks(markdown: string): boolean {
  return markdown.includes(MARKS_START_MARKER);
}

// ============================================================================
// Type Guards
// ============================================================================

export function isAuthoredData(data: MarkData | undefined): data is AuthoredData {
  // AuthoredData is empty, so we check the mark kind instead
  return data === undefined || Object.keys(data).length === 0;
}

export function isCommentData(data: MarkData | undefined): data is CommentData {
  return data !== undefined && 'text' in data && 'thread' in data;
}

export function isInsertData(data: MarkData | undefined): data is InsertData {
  return data !== undefined && 'content' in data && 'status' in data;
}

export function isDeleteData(data: MarkData | undefined): data is DeleteData {
  return data !== undefined && 'status' in data && !('content' in data);
}

export function isReplaceData(data: MarkData | undefined): data is ReplaceData {
  return data !== undefined && 'content' in data && 'status' in data;
}

export function isFlaggedData(data: MarkData | undefined): data is FlaggedData {
  return data !== undefined && ('note' in data || Object.keys(data).length === 0);
}

// ============================================================================
// Actor Helpers
// ============================================================================

/**
 * Check if actor is human
 */
export function isHuman(actor: string): boolean {
  return actor.startsWith('human:');
}

/**
 * Check if actor is AI
 */
export function isAI(actor: string): boolean {
  return actor.startsWith('ai:');
}

/**
 * Check if actor is system
 */
export function isSystem(actor: string): boolean {
  return actor.startsWith('system:');
}

/**
 * Get actor display name
 */
export function getActorName(actor: string): string {
  const parts = actor.split(':');
  return parts[1] || actor;
}

// ============================================================================
// Legacy Provenance Migration
// ============================================================================

/**
 * Legacy provenance span structure (from old system)
 */
export interface LegacyProvenanceSpan {
  spanId: string;
  startOffset: number;
  endOffset: number;
  origin: string; // 'human.written' | 'human.edited' | 'ai.generated' | 'ai.edited' | 'mixed'
  authorId?: string;
  createdAt?: string;
}

/**
 * Legacy provenance data structure
 */
export interface LegacyProvenanceData {
  spans: LegacyProvenanceSpan[];
  metadata?: {
    humanPercent?: number;
    aiPercent?: number;
  };
}

/**
 * Convert a legacy origin string to the new actor format
 */
function legacyOriginToActor(origin: string): string | null {
  if (origin.startsWith('human.')) {
    return 'human:migrated';
  }
  return null;
}

/**
 * Migrate legacy provenance spans to authored marks (human-only)
 *
 * @param legacyData - The old provenance data structure
 * @param docText - The document text (for extracting quotes)
 * @returns Array of authored marks
 */
export function migrateProvenanceToMarks(
  legacyData: LegacyProvenanceData,
  docText: string
): Mark[] {
  if (!legacyData.spans || legacyData.spans.length === 0) {
    return [];
  }

  const marks: Mark[] = [];

  for (const span of legacyData.spans) {
    const actor = legacyOriginToActor(span.origin);
    if (!actor) continue;

    const range: MarkRange = {
      from: span.startOffset,
      to: span.endOffset
    };

    const quote = docText.substring(span.startOffset, span.endOffset);

    marks.push({
      id: `migrated_${span.spanId}`,
      kind: 'authored' as MarkKind,
      by: actor,
      at: span.createdAt || new Date().toISOString(),
      range,
      quote: normalizeQuote(quote)
    });
  }

  // Coalesce adjacent marks by the same actor to reduce count
  return coalesceAuthoredMarks(marks);
}

/**
 * Check if marks already contain migrated provenance
 */
export function hasMigratedProvenance(marks: Mark[]): boolean {
  return marks.some(m => m.id.startsWith('migrated_'));
}
