export * from './editor.js';
export * from './batch-executor.js';
export * from './plugins/marks.js';
export * from './plugins/suggestions.js';
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
