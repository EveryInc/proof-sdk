export * from './marks.js';
export * from './remark-proof-marks.js';
export * from './agent-identity.js';
export {
  addComment,
  addReplyToComment,
  createReply,
  deleteComment,
  ensureCommentsArray,
  extractEmbeddedProvenance,
  generateCommentId,
  generateReplyId,
  isLegacyFormat,
  migrateLegacyProvenance,
  setCommentResolved,
} from './provenance-sidecar.js';
export type {
  AttentionData,
  AttentionEvent,
  AttentionEventType,
  AttestationLevel,
  Comment,
  CommentSelector,
  ProvenanceData,
  ProvenanceMetadata,
  ProvenanceSpan,
  TextOrigin,
} from './provenance-sidecar.js';
export {
  createComment as createLegacyComment,
  getUnresolvedComments as getUnresolvedLegacyComments,
} from './provenance-sidecar.js';
export type { CommentReply as LegacyCommentReply } from './provenance-sidecar.js';
