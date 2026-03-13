export * from './batch-executor.js';
export * from './plugins/marks.js';
export * from './plugins/suggestions.js';
export {
  addComment,
  addCommentAtSelection,
  commentsCtx,
  commentsPlugin,
  commentsPluginKey,
  commentsPlugins,
  deleteComment,
  getActiveCommentId,
  getComments,
  getResolvedComments,
  getUnresolvedComments,
  getUnresolvedPluginComments,
  hasProofMention,
  replyToComment,
  resolveComment,
  resolveSelector,
  setActiveComment,
  setCommentEventCallbacks,
  setComments,
  unresolveComment,
} from './plugins/comments.js';
export type {
  CommentEventCallbacks,
  CommentState,
  ResolvedComment,
} from './plugins/comments.js';
