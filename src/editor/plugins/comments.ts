/**
 * Comments Plugin for Milkdown
 *
 * Manages document comments with:
 * - Semantic selectors for targeting content
 * - Decoration-based highlighting
 * - Full CRUD operations exposed for agents
 *
 * Agent-native: All operations are exposed via atomic tools.
 */

import { $ctx } from '@milkdown/kit/utils';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import { getTextForRange, resolvePatternRange, resolveQuoteRange } from '../utils/text-range';

import type { Comment, CommentReply, CommentSelector } from '../../formats/provenance-sidecar';
import {
  createComment,
  createReply,
} from '../../formats/provenance-sidecar';

// ============================================================================
// Types
// ============================================================================

export interface CommentState {
  comments: Comment[];
  activeCommentId: string | null;
}

export interface ResolvedComment extends Comment {
  /** Resolved document position - may be null if selector couldn't resolve */
  resolvedRange: { from: number; to: number } | null;
}

// ============================================================================
// Plugin Key and Context
// ============================================================================

export const commentsPluginKey = new PluginKey<CommentState>('comments');

export const commentsCtx = $ctx<CommentState, 'comments'>(
  { comments: [], activeCommentId: null },
  'comments'
);

// ============================================================================
// Selector Resolution
// ============================================================================

/**
 * Resolve a comment selector to document positions
 */
export function resolveSelector(
  doc: ProseMirrorNode,
  selector: CommentSelector
): { from: number; to: number } | null {
  // Try position-based range first (most reliable)
  if (selector.range) {
    const { from, to } = selector.range;
    if (from >= 0 && to <= doc.content.size && from < to) {
      return { from, to };
    }
  }

  // Try quote-based matching
  if (selector.quote) {
    const range = findQuoteInDoc(doc, selector.quote);
    if (range) return range;
  }

  // Try pattern-based matching
  if (selector.pattern) {
    const range = findPatternInDoc(doc, selector.pattern);
    if (range) return range;
  }

  // Try anchor-based resolution
  if (selector.anchor?.heading) {
    const range = findAnchorInDoc(doc, selector.anchor);
    if (range) return range;
  }

  return null;
}

/**
 * Find exact quote text in document
 */
function findQuoteInDoc(
  doc: ProseMirrorNode,
  quote: string
): { from: number; to: number } | null {
  return resolveQuoteRange(doc, quote);
}

/**
 * Find pattern (regex) in document
 */
function findPatternInDoc(
  doc: ProseMirrorNode,
  pattern: string
): { from: number; to: number } | null {
  return resolvePatternRange(doc, pattern);
}

/**
 * Find anchor (heading) in document
 */
function findAnchorInDoc(
  doc: ProseMirrorNode,
  anchor: { heading?: string; offset?: number }
): { from: number; to: number } | null {
  if (!anchor.heading) return null;

  let headingPos: number | null = null;

  doc.descendants((node, pos) => {
    if (headingPos !== null) return false;

    if (node.type.name === 'heading') {
      const headingText = node.textContent.toLowerCase();
      if (headingText.includes(anchor.heading!.toLowerCase())) {
        headingPos = pos + node.nodeSize;
        return false;
      }
    }
    return true;
  });

  if (headingPos === null) return null;

  const offset = anchor.offset || 0;
  const from = Math.min(headingPos + offset, doc.content.size);
  const to = Math.min(from + 10, doc.content.size); // Default small range

  return { from, to };
}

// ============================================================================
// Comment Operations
// ============================================================================

/**
 * Get all comments with resolved positions
 */
export function getResolvedComments(
  state: EditorState,
  comments: Comment[]
): ResolvedComment[] {
  return comments.map(comment => ({
    ...comment,
    resolvedRange: resolveSelector(state.doc, comment.selector)
  }));
}

/**
 * Get comments from plugin state
 */
export function getComments(state: EditorState): Comment[] {
  const pluginState = commentsPluginKey.getState(state);
  return pluginState?.comments ?? [];
}

/**
 * Get active comment ID
 */
export function getActiveCommentId(state: EditorState): string | null {
  const pluginState = commentsPluginKey.getState(state);
  return pluginState?.activeCommentId ?? null;
}

/**
 * Set comments in plugin state
 */
export function setComments(view: EditorView, comments: Comment[]): void {
  const tr = view.state.tr.setMeta(commentsPluginKey, {
    type: 'SET_COMMENTS',
    comments
  });
  view.dispatch(tr);
}

/**
 * Add a new comment
 */
export function addComment(
  view: EditorView,
  selector: CommentSelector,
  text: string,
  author: string
): Comment {
  const comment = createComment(selector, text, author);
  const currentComments = getComments(view.state);
  const newComments = [...currentComments, comment];
  setComments(view, newComments);

  // Emit event for agent integration
  emitCommentCreated(comment, newComments);

  return comment;
}

/**
 * Add a comment at the current selection
 */
export function addCommentAtSelection(
  view: EditorView,
  text: string,
  author: string
): Comment | null {
  let { from, to } = view.state.selection;

  if (from === to) {
    const $pos = view.state.doc.resolve(from);
    from = $pos.start($pos.depth);
    to = $pos.end($pos.depth);
  }

  if (from >= to) {
    return null;
  }

  // Get the selected text for the quote selector
  const quote = getTextForRange(view.state.doc, { from, to });

  const selector: CommentSelector = {
    quote,
    range: { from, to }
  };

  return addComment(view, selector, text, author);
}

/**
 * Reply to a comment
 */
export function replyToComment(
  view: EditorView,
  commentId: string,
  text: string,
  author: string
): CommentReply | null {
  const comments = getComments(view.state);
  const comment = comments.find(c => c.id === commentId);

  if (!comment) return null;

  const reply = createReply(text, author);
  const updatedComment = { ...comment, replies: [...comment.replies, reply] };
  const updatedComments = comments.map(c =>
    c.id === commentId ? updatedComment : c
  );

  setComments(view, updatedComments);

  // Emit event for agent integration
  emitCommentReplied(updatedComment, reply, updatedComments);

  return reply;
}

/**
 * Resolve a comment
 */
export function resolveComment(view: EditorView, commentId: string): boolean {
  const comments = getComments(view.state);
  const comment = comments.find(c => c.id === commentId);

  if (!comment) return false;

  const updatedComments = comments.map(c =>
    c.id === commentId ? { ...c, resolved: true } : c
  );

  setComments(view, updatedComments);
  return true;
}

/**
 * Unresolve a comment
 */
export function unresolveComment(view: EditorView, commentId: string): boolean {
  const comments = getComments(view.state);
  const comment = comments.find(c => c.id === commentId);

  if (!comment) return false;

  const updatedComments = comments.map(c =>
    c.id === commentId ? { ...c, resolved: false } : c
  );

  setComments(view, updatedComments);
  return true;
}

/**
 * Delete a comment
 */
export function deleteComment(view: EditorView, commentId: string): boolean {
  const comments = getComments(view.state);
  const initialLength = comments.length;
  const updatedComments = comments.filter(c => c.id !== commentId);

  if (updatedComments.length === initialLength) return false;

  setComments(view, updatedComments);
  return true;
}

/**
 * Get unresolved comments
 */
export function getUnresolvedComments(state: EditorState): Comment[] {
  return getComments(state).filter(c => !c.resolved);
}

/**
 * Set active comment (for highlighting in sidebar)
 */
export function setActiveComment(view: EditorView, commentId: string | null): void {
  const tr = view.state.tr.setMeta(commentsPluginKey, {
    type: 'SET_ACTIVE',
    commentId
  });
  view.dispatch(tr);
}

// ============================================================================
// Decorations
// ============================================================================

function injectCommentHighlightStyles(): void {
  if (document.getElementById('proof-comment-highlight-styles')) return;
  const style = document.createElement('style');
  style.id = 'proof-comment-highlight-styles';
  style.textContent = `
    .comment-highlight { background-color: rgba(255, 220, 100, 0.3); border-bottom: 2px solid rgb(255, 180, 0); }
    .comment-active { background-color: rgba(255, 180, 0, 0.5); border-bottom: 2px solid rgb(255, 140, 0); }
  `;
  document.head.appendChild(style);
}

/**
 * Create decorations for comments
 */
function createCommentDecorations(
  state: EditorState,
  comments: Comment[],
  activeCommentId: string | null
): DecorationSet {
  const decorations: Decoration[] = [];

  for (const comment of comments) {
    if (comment.resolved) continue; // Don't highlight resolved comments

    const range = resolveSelector(state.doc, comment.selector);
    if (!range) continue;

    const isActive = comment.id === activeCommentId;

    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: `comment-highlight ${isActive ? 'comment-active' : ''}`,
        'data-comment-id': comment.id
      })
    );
  }

  return DecorationSet.create(state.doc, decorations);
}

// ============================================================================
// Plugin
// ============================================================================

export const commentsPlugin = $prose(() => {
  injectCommentHighlightStyles();
  return new Plugin<CommentState>({
    key: commentsPluginKey,

    state: {
      init(): CommentState {
        return { comments: [], activeCommentId: null };
      },

      apply(tr, value): CommentState {
        const meta = tr.getMeta(commentsPluginKey);

        if (meta) {
          switch (meta.type) {
            case 'SET_COMMENTS':
              return { ...value, comments: meta.comments };
            case 'SET_ACTIVE':
              return { ...value, activeCommentId: meta.commentId };
          }
        }

        // If document changed, we might need to update resolved positions
        // but we keep the comments themselves
        return value;
      }
    },

    props: {
      decorations(state) {
        const pluginState = commentsPluginKey.getState(state);
        if (!pluginState) return DecorationSet.empty;

        return createCommentDecorations(
          state,
          pluginState.comments,
          pluginState.activeCommentId
        );
      }
    }
  });
});

// ============================================================================
// Agent Trigger Support
// ============================================================================

/**
 * Pattern to detect @proof mentions
 */
const PROOF_MENTION_PATTERN = /@proof\b/i;

/**
 * Check if text contains @proof mention
 */
export function hasProofMention(text: string): boolean {
  return PROOF_MENTION_PATTERN.test(text);
}

/**
 * Comment event callbacks for agent integration
 */
export interface CommentEventCallbacks {
  onCommentCreated?: (comment: Comment, allComments: Comment[]) => void;
  onCommentReplied?: (comment: Comment, reply: CommentReply, allComments: Comment[]) => void;
  onProofMentioned?: (comment: Comment, allComments: Comment[]) => void;
}

let commentEventCallbacks: CommentEventCallbacks = {};

/**
 * Set callbacks for comment events (used by agent trigger service)
 */
export function setCommentEventCallbacks(callbacks: CommentEventCallbacks): void {
  commentEventCallbacks = callbacks;
}

/**
 * Emit comment created event
 */
function emitCommentCreated(comment: Comment, allComments: Comment[]): void {
  commentEventCallbacks.onCommentCreated?.(comment, allComments);

  // Check for @proof mention
  if (hasProofMention(comment.text)) {
    commentEventCallbacks.onProofMentioned?.(comment, allComments);
  }
}

/**
 * Emit comment replied event
 */
function emitCommentReplied(comment: Comment, reply: CommentReply, allComments: Comment[]): void {
  commentEventCallbacks.onCommentReplied?.(comment, reply, allComments);

  // Check for @proof mention in reply
  if (hasProofMention(reply.text)) {
    commentEventCallbacks.onProofMentioned?.(comment, allComments);
  }
}

// ============================================================================
// Export all
// ============================================================================

export const commentsPlugins = [commentsCtx, commentsPlugin];
