import {
  addComment,
  addCommentAtSelection,
  commentsPlugin,
  commentsPluginKey,
  commentsPlugins,
  deleteComment,
  getActiveCommentId,
  getComments,
  getResolvedComments,
  getUnresolvedComments as getUnresolvedCommentsImpl,
  hasProofMention,
  replyToComment,
  resolveComment,
  resolveSelector,
  setActiveComment,
  setCommentEventCallbacks,
  setComments,
  unresolveComment,
  type CommentEventCallbacks,
  type CommentState,
  type ResolvedComment,
} from '../../../../src/editor/plugins/comments.js';

export {
  addComment,
  addCommentAtSelection,
  commentsPlugin,
  commentsPluginKey,
  commentsPlugins,
  deleteComment,
  getActiveCommentId,
  getComments,
  getResolvedComments,
  hasProofMention,
  replyToComment,
  resolveComment,
  resolveSelector,
  setActiveComment,
  setCommentEventCallbacks,
  setComments,
  unresolveComment,
};

export type {
  CommentEventCallbacks,
  CommentState,
  ResolvedComment,
};

export const getUnresolvedPluginComments = getUnresolvedCommentsImpl;
