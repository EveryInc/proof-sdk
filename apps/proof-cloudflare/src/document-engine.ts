/**
 * DO-native document engine for marks CRUD.
 *
 * Simplified from server/document-engine.ts. In the DO, state is colocated
 * and access is serialized — no need for optimistic concurrency, tombstones,
 * or collab invalidation.
 */

import * as Y from "yjs";
import type { DocumentEventType } from "./event-types.js";
import { detectMentions } from "./mention-detection.js";
import { stripProofSpanTags } from "./proof-span-strip.js";

// ---------------------------------------------------------------------------
// Mark types (subset of src/formats/marks.ts)
// ---------------------------------------------------------------------------

export interface StoredMark {
  kind: string;
  by: string;
  createdAt: string;
  quote?: string;
  text?: string;
  content?: string;
  status?: string;
  resolved?: boolean;
  range?: { from: number; to: number };
  startRel?: string;
  endRel?: string;
  threadId?: string;
  thread?: Array<{ by: string; text: string; at: string }>;
  replies?: Array<{ by: string; text: string; at: string }>;
  [key: string]: unknown;
}

export type MarksMap = Record<string, StoredMark>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateMarkId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Read marks from the Y.Doc's "marks" map.
 */
export function readMarksFromYDoc(doc: Y.Doc): MarksMap {
  const marksMap = doc.getMap("marks");
  if (marksMap.size === 0) return {};
  return marksMap.toJSON() as MarksMap;
}

/**
 * Write marks to the Y.Doc's "marks" map.
 */
export function writeMarksToYDoc(doc: Y.Doc, marks: MarksMap): void {
  const marksMap = doc.getMap("marks");
  // Clear and rebuild
  for (const key of Array.from(marksMap.keys())) {
    if (!(key in marks)) {
      marksMap.delete(key);
    }
  }
  for (const [key, value] of Object.entries(marks)) {
    marksMap.set(key, value);
  }
}

/**
 * Find a quote anchor in the markdown text.
 * Strips proof span tags before searching so quotes match the visible text.
 * Returns the character offset in the stripped text, or -1 if not found.
 */
function findQuoteInMarkdown(markdown: string, quote: string): number {
  if (!quote) return -1;
  // Strip proof spans to match against visible text
  const stripped = stripProofSpanTags(markdown);
  const idx = stripped.indexOf(quote);
  if (idx !== -1) return idx;
  // Try with whitespace normalization
  const normalized = stripped.replace(/\s+/g, " ");
  const normalizedQuote = quote.replace(/\s+/g, " ");
  return normalized.indexOf(normalizedQuote);
}

// ---------------------------------------------------------------------------
// Mark operations
// ---------------------------------------------------------------------------

export interface MarkOperationResult {
  success: boolean;
  markId?: string;
  marks: MarksMap;
  markdown: string;
  error?: string;
  errorCode?: string;
  statusCode?: number;
  eventType?: DocumentEventType;
  eventData?: Record<string, unknown>;
}

/**
 * Add a comment mark to the document.
 */
export function addComment(
  doc: Y.Doc,
  input: { by: string; text: string; quote?: string },
): MarkOperationResult {
  const markdown = doc.getText("markdown").toString();
  const marks = readMarksFromYDoc(doc);
  const markId = generateMarkId();
  const quote = input.quote ?? "";

  if (quote && findQuoteInMarkdown(markdown, quote) === -1) {
    return {
      success: false,
      marks,
      markdown,
      error: "Anchor text not found in document",
      errorCode: "ANCHOR_NOT_FOUND",
      statusCode: 409,
    };
  }

  const offset = quote ? findQuoteInMarkdown(markdown, quote) : 0;

  marks[markId] = {
    kind: "comment",
    by: input.by,
    createdAt: now(),
    quote,
    text: input.text,
    threadId: markId,
    thread: [],
    replies: [],
    resolved: false,
    startRel: `char:${offset}`,
    endRel: `char:${offset + quote.length}`,
  };

  writeMarksToYDoc(doc, marks);

  return {
    success: true,
    markId,
    marks,
    markdown,
    eventType: "comment.added" as DocumentEventType,
    eventData: { markId, by: input.by, quote, text: input.text },
  };
}

/**
 * Add a suggestion mark (insert, delete, or replace).
 */
export function addSuggestion(
  doc: Y.Doc,
  kind: "insert" | "delete" | "replace",
  input: { by: string; quote: string; content?: string },
): MarkOperationResult {
  const markdown = doc.getText("markdown").toString();
  const marks = readMarksFromYDoc(doc);
  const markId = generateMarkId();

  if (!input.quote) {
    return {
      success: false,
      marks,
      markdown,
      error: "quote is required",
      statusCode: 400,
    };
  }

  if (findQuoteInMarkdown(markdown, input.quote) === -1) {
    return {
      success: false,
      marks,
      markdown,
      error: "Anchor text not found in document",
      errorCode: "ANCHOR_NOT_FOUND",
      statusCode: 409,
    };
  }

  const offset = findQuoteInMarkdown(markdown, input.quote);

  marks[markId] = {
    kind,
    by: input.by,
    createdAt: now(),
    quote: input.quote,
    content: input.content ?? "",
    status: "pending",
    startRel: `char:${offset}`,
    endRel: `char:${offset + input.quote.length}`,
  };

  writeMarksToYDoc(doc, marks);

  const eventType = `suggestion.${kind}.added` as DocumentEventType;

  return {
    success: true,
    markId,
    marks,
    markdown,
    eventType,
    eventData: { markId, by: input.by, quote: input.quote, content: input.content },
  };
}

/**
 * Accept a suggestion — modifies the markdown text.
 */
export function acceptSuggestion(
  doc: Y.Doc,
  input: { markId: string; by?: string },
): MarkOperationResult {
  const markdownText = doc.getText("markdown");
  const markdown = markdownText.toString();
  const marks = readMarksFromYDoc(doc);

  const mark = marks[input.markId];
  if (!mark) {
    return {
      success: false,
      marks,
      markdown,
      error: "Mark not found",
      statusCode: 404,
    };
  }

  // Idempotent — already accepted
  if (mark.status === "accepted") {
    return { success: true, markId: input.markId, marks, markdown };
  }

  mark.status = "accepted";

  // Apply the suggestion to the markdown text.
  // Work with stripped text (no proof spans) for clean replacement,
  // then use that as the new canonical markdown.
  const quote = mark.quote ?? "";
  const content = mark.content ?? "";
  const strippedMarkdown = stripProofSpanTags(markdown);
  const idx = strippedMarkdown.indexOf(quote);

  if (idx !== -1 && quote) {
    let newMarkdown: string;
    if (mark.kind === "insert") {
      newMarkdown = strippedMarkdown.slice(0, idx + quote.length) + content + strippedMarkdown.slice(idx + quote.length);
    } else if (mark.kind === "delete") {
      newMarkdown = strippedMarkdown.slice(0, idx) + strippedMarkdown.slice(idx + quote.length);
    } else {
      // replace
      newMarkdown = strippedMarkdown.slice(0, idx) + content + strippedMarkdown.slice(idx + quote.length);
    }

    // Apply diff to Y.Text
    doc.transact(() => {
      const oldLen = markdownText.length;
      if (oldLen > 0) markdownText.delete(0, oldLen);
      markdownText.insert(0, newMarkdown);
    }, "cf-accept-suggestion");

    writeMarksToYDoc(doc, marks);

    return {
      success: true,
      markId: input.markId,
      marks,
      markdown: newMarkdown,
      eventType: "suggestion.accepted" as DocumentEventType,
      eventData: { markId: input.markId, status: "accepted", by: input.by ?? "unknown" },
    };
  }

  // Quote not found — still accept the status change but warn
  writeMarksToYDoc(doc, marks);
  return {
    success: true,
    markId: input.markId,
    marks,
    markdown,
    eventType: "suggestion.accepted" as DocumentEventType,
    eventData: { markId: input.markId, status: "accepted", by: input.by ?? "unknown" },
  };
}

/**
 * Reject a suggestion — markdown unchanged, just status update.
 */
export function rejectSuggestion(
  doc: Y.Doc,
  input: { markId: string; by?: string },
): MarkOperationResult {
  const markdown = doc.getText("markdown").toString();
  const marks = readMarksFromYDoc(doc);

  const mark = marks[input.markId];
  if (!mark) {
    return {
      success: false,
      marks,
      markdown,
      error: "Mark not found",
      statusCode: 404,
    };
  }

  if (mark.status === "rejected") {
    return { success: true, markId: input.markId, marks, markdown };
  }

  mark.status = "rejected";
  writeMarksToYDoc(doc, marks);

  return {
    success: true,
    markId: input.markId,
    marks,
    markdown,
    eventType: "suggestion.rejected" as DocumentEventType,
    eventData: { markId: input.markId, status: "rejected", by: input.by ?? "unknown" },
  };
}

/**
 * Reply to a comment thread.
 */
export function replyComment(
  doc: Y.Doc,
  input: { markId: string; by: string; text: string },
): MarkOperationResult {
  const markdown = doc.getText("markdown").toString();
  const marks = readMarksFromYDoc(doc);

  const mark = marks[input.markId];
  if (!mark) {
    return {
      success: false,
      marks,
      markdown,
      error: "Mark not found",
      statusCode: 404,
    };
  }

  const reply = { by: input.by, text: input.text, at: now() };
  if (!mark.thread) mark.thread = [];
  if (!mark.replies) mark.replies = [];
  mark.thread.push(reply);
  mark.replies.push(reply);

  writeMarksToYDoc(doc, marks);

  return {
    success: true,
    markId: input.markId,
    marks,
    markdown,
    eventType: "comment.replied" as DocumentEventType,
    eventData: { markId: input.markId, by: input.by, text: input.text },
  };
}

/**
 * Resolve a comment.
 */
export function resolveComment(
  doc: Y.Doc,
  input: { markId: string; by?: string },
): MarkOperationResult {
  const markdown = doc.getText("markdown").toString();
  const marks = readMarksFromYDoc(doc);

  const mark = marks[input.markId];
  if (!mark) {
    return {
      success: false,
      marks,
      markdown,
      error: "Mark not found",
      statusCode: 404,
    };
  }

  mark.resolved = true;
  writeMarksToYDoc(doc, marks);

  return {
    success: true,
    markId: input.markId,
    marks,
    markdown,
    eventType: "comment.resolved" as DocumentEventType,
    eventData: { markId: input.markId, by: input.by ?? "unknown" },
  };
}

/**
 * Unresolve a comment.
 */
export function unresolveComment(
  doc: Y.Doc,
  input: { markId: string; by?: string },
): MarkOperationResult {
  const markdown = doc.getText("markdown").toString();
  const marks = readMarksFromYDoc(doc);

  const mark = marks[input.markId];
  if (!mark) {
    return {
      success: false,
      marks,
      markdown,
      error: "Mark not found",
      statusCode: 404,
    };
  }

  mark.resolved = false;
  writeMarksToYDoc(doc, marks);

  return {
    success: true,
    markId: input.markId,
    marks,
    markdown,
    eventType: "comment.unresolved" as DocumentEventType,
    eventData: { markId: input.markId, by: input.by ?? "unknown" },
  };
}
