/**
 * Legacy provenance format (.prov.json / embedded PROVENANCE blocks)
 *
 * This file is retained for best-effort migration and comment helpers.
 * New documents should use inline PROOF spans and marks metadata only.
 */

export type AttestationLevel = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

export type TextOrigin =
  | 'human.written'
  | 'human.edited'
  | 'ai.generated'
  | 'ai.edited'
  | 'mixed';

/**
 * A provenance span - stores only offsets
 * Line numbers are calculated on-demand
 */
export interface ProvenanceSpan {
  spanId: string;
  startOffset: number;
  endOffset: number;
  origin: TextOrigin;
  attestation: AttestationLevel;
  authorId: string;
  createdAt: string;  // ISO date
  attestedAt?: string;
}

export interface AttentionData {
  totalDwellTime: number;  // milliseconds
  viewCount: number;
  selectionCount: number;
  editCount: number;
  lastInteraction?: string;  // ISO date
}

export type AttentionEventType = 'dwell' | 'view' | 'selection' | 'edit';

export interface AttentionEvent {
  type: AttentionEventType;
  spanId: string;
  sentenceIndex: number;
  timestamp: string;  // ISO date
  durationMs?: number;
  editType?: string;
}

export interface ProvenanceMetadata {
  humanPercent: number;
  aiPercent: number;
  attestationCoverage: Record<AttestationLevel, number>;
}

// ============================================================================
// Comments
// ============================================================================

/**
 * Selector for targeting content in the document.
 * Supports multiple resolution strategies:
 * - quote: Exact text match
 * - range: Position-based (from/to offsets)
 * - pattern: Regex pattern for flexible matching
 * - anchor: Near a heading or semantic marker
 */
export interface CommentSelector {
  /** Exact text to match (preferred for semantic resolution) */
  quote?: string;
  /** Position-based range (resolved at save time) */
  range?: {
    from: number;
    to: number;
  };
  /** Regex pattern for flexible matching */
  pattern?: string;
  /** Anchor near a heading or marker */
  anchor?: {
    heading?: string;
    offset?: number;  // Characters after anchor
  };
}

/**
 * A reply to a comment
 */
export interface CommentReply {
  id: string;
  text: string;
  author: string;
  createdAt: string;  // ISO date
}

/**
 * A comment attached to a document selection
 */
export interface Comment {
  id: string;
  selector: CommentSelector;
  text: string;
  author: string;
  createdAt: string;  // ISO date
  resolved: boolean;
  replies: CommentReply[];
}

export interface ProvenanceData {
  version: string;
  documentId: string;
  created: string;
  modified: string;
  spans: ProvenanceSpan[];  // Changed from Record to array for ordering
  attention: Record<string, AttentionData>;
  events: AttentionEvent[];
  metadata: ProvenanceMetadata;
  comments: Comment[];  // Comments attached to document
}

// ============================================================================
// Legacy format migration
// ============================================================================

interface LegacySpan {
  spanId: string;
  start: { line: number; ch: number };
  end: { line: number; ch: number };
  startOffset?: number;
  endOffset?: number;
  origin: TextOrigin;
  attestation: AttestationLevel;
  authorId: string;
  createdAt: string;
  attestedAt?: string;
}

interface LegacyProvenanceData {
  version: string;
  documentId: string;
  created: string;
  modified: string;
  spans: Record<string, LegacySpan>;
  attention: Record<string, AttentionData>;
  events: AttentionEvent[];
  metadata: ProvenanceMetadata;
}

/**
 * Migrate legacy provenance format (v1.0.0) to new format (v2.0.0)
 */
export function migrateLegacyProvenance(legacy: LegacyProvenanceData): ProvenanceData {
  const spans: ProvenanceSpan[] = Object.values(legacy.spans)
    .filter(s => s.startOffset !== undefined && s.endOffset !== undefined)
    .map(s => ({
      spanId: s.spanId,
      startOffset: s.startOffset!,
      endOffset: s.endOffset!,
      origin: s.origin,
      attestation: s.attestation,
      authorId: s.authorId,
      createdAt: s.createdAt,
      attestedAt: s.attestedAt,
    }))
    .sort((a, b) => a.startOffset - b.startOffset);

  return {
    version: '2.1.0',
    documentId: legacy.documentId,
    created: legacy.created,
    modified: legacy.modified,
    spans,
    attention: legacy.attention,
    events: legacy.events,
    metadata: legacy.metadata,
    comments: [],
  };
}

/**
 * Check if provenance data is legacy format
 */
export function isLegacyFormat(data: unknown): data is LegacyProvenanceData {
  if (!data || typeof data !== 'object') return false;
  const d = data as { version?: string; spans?: unknown };
  return d.version === '1.0.0' && !!d.spans && !Array.isArray(d.spans);
}

// ============================================================================
// Embedded provenance (in-markdown storage)
// ============================================================================

/**
 * Regex to extract embedded provenance from markdown content.
 * Matches: <!-- PROVENANCE\n{json}\n-->
 */
const EMBEDDED_PROVENANCE_REGEX = /\n?<!-- PROVENANCE\n([\s\S]*?)\n-->\s*$/;

const TRAILING_ARTIFACT_LINE_REGEX = /^(?:#\s*[=-]{10,}\s*|\\[=-]{10,}\s*)$/;
const MIN_TRAILING_ARTIFACT_LINES = 3;

function stripTrailingSerializationArtifacts(markdown: string): string {
  const lines = markdown.split('\n');
  let end = lines.length;

  while (end > 0 && lines[end - 1].trim() === '') {
    end -= 1;
  }

  let artifactLines = 0;
  let cursor = end - 1;
  while (cursor >= 0) {
    const trimmed = lines[cursor].trim();
    if (!trimmed) {
      cursor -= 1;
      continue;
    }
    if (!TRAILING_ARTIFACT_LINE_REGEX.test(trimmed)) break;
    artifactLines += 1;
    cursor -= 1;
  }

  if (artifactLines < MIN_TRAILING_ARTIFACT_LINES) return markdown;

  const trimmedLines = lines.slice(0, cursor + 1);
  while (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1].trim() === '') {
    trimmedLines.pop();
  }

  if (trimmedLines.length > 0 && /^#\s+/.test(trimmedLines[trimmedLines.length - 1])) {
    trimmedLines[trimmedLines.length - 1] = trimmedLines[trimmedLines.length - 1].replace(/^#\s+/, '');
  }

  return trimmedLines.join('\n');
}

/**
 * Extract provenance data embedded in markdown content.
 * Returns the markdown content (without provenance block) and the provenance data.
 */
export function extractEmbeddedProvenance(markdown: string): {
  content: string;
  provenance: ProvenanceData | null;
} {
  const match = markdown.match(EMBEDDED_PROVENANCE_REGEX);

  if (!match) {
    return { content: stripTrailingSerializationArtifacts(markdown), provenance: null };
  }

  // Remove the provenance block from content
  let content = markdown.replace(EMBEDDED_PROVENANCE_REGEX, '');

  // Also remove the buffer comment if present
  content = content.replace(/\n?<!-- PROOF:END -->\s*$/, '');
  content = stripTrailingSerializationArtifacts(content);

  try {
    const jsonStr = match[1];
    const parsed = JSON.parse(jsonStr);

    // Handle legacy format migration
    if (isLegacyFormat(parsed)) {
      return { content, provenance: migrateLegacyProvenance(parsed) };
    }

    return { content, provenance: parsed as ProvenanceData };
  } catch (error) {
    console.warn('Failed to parse embedded provenance:', error);
    return { content, provenance: null };
  }
}

// ============================================================================
// Comment helpers
// ============================================================================

let commentIdCounter = 0;

/**
 * Generate a unique comment ID
 */
export function generateCommentId(): string {
  return `comment_${Date.now()}_${++commentIdCounter}`;
}

/**
 * Generate a unique reply ID
 */
export function generateReplyId(): string {
  return `reply_${Date.now()}_${++commentIdCounter}`;
}

/**
 * Create a new comment
 */
export function createComment(
  selector: CommentSelector,
  text: string,
  author: string
): Comment {
  return {
    id: generateCommentId(),
    selector,
    text,
    author,
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: []
  };
}

/**
 * Create a reply to a comment
 */
export function createReply(text: string, author: string): CommentReply {
  return {
    id: generateReplyId(),
    text,
    author,
    createdAt: new Date().toISOString()
  };
}

/**
 * Add a comment to provenance data
 */
export function addComment(
  provenance: ProvenanceData,
  comment: Comment
): ProvenanceData {
  return {
    ...provenance,
    modified: new Date().toISOString(),
    comments: [...provenance.comments, comment]
  };
}

/**
 * Add a reply to a comment
 */
export function addReplyToComment(
  provenance: ProvenanceData,
  commentId: string,
  reply: CommentReply
): ProvenanceData {
  return {
    ...provenance,
    modified: new Date().toISOString(),
    comments: provenance.comments.map(c =>
      c.id === commentId
        ? { ...c, replies: [...c.replies, reply] }
        : c
    )
  };
}

/**
 * Resolve or unresolve a comment
 */
export function setCommentResolved(
  provenance: ProvenanceData,
  commentId: string,
  resolved: boolean
): ProvenanceData {
  return {
    ...provenance,
    modified: new Date().toISOString(),
    comments: provenance.comments.map(c =>
      c.id === commentId
        ? { ...c, resolved }
        : c
    )
  };
}

/**
 * Delete a comment
 */
export function deleteComment(
  provenance: ProvenanceData,
  commentId: string
): ProvenanceData {
  return {
    ...provenance,
    modified: new Date().toISOString(),
    comments: provenance.comments.filter(c => c.id !== commentId)
  };
}

/**
 * Get all unresolved comments
 */
export function getUnresolvedComments(provenance: ProvenanceData): Comment[] {
  return provenance.comments.filter(c => !c.resolved);
}

/**
 * Ensure provenance data has comments array (for migration from older versions)
 */
export function ensureCommentsArray(provenance: ProvenanceData): ProvenanceData {
  if (!provenance.comments) {
    return {
      ...provenance,
      comments: []
    };
  }
  return provenance;
}
