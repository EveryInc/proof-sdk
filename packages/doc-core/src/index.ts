export * from '../../../src/formats/marks.js';
// Explicit re-export of provenance-sidecar to avoid name collisions with marks.js:
// marks.js owns the bare createComment, getUnresolvedComments, and CommentReply
// names in the new marks-based API. The provenance-sidecar versions are still
// re-exported here under Sidecar-prefixed aliases so legacy sidecar consumers
// keep a working path.
export type {
  AttestationLevel,
  TextOrigin,
  ProvenanceSpan,
  AttentionData,
  AttentionEventType,
  AttentionEvent,
  ProvenanceMetadata,
  CommentSelector,
  Comment,
  ProvenanceData,
  CommentReply as SidecarCommentReply,
} from '../../../src/formats/provenance-sidecar.js';
export {
  migrateLegacyProvenance,
  isLegacyFormat,
  extractEmbeddedProvenance,
  generateCommentId,
  generateReplyId,
  createReply,
  addComment,
  addReplyToComment,
  setCommentResolved,
  deleteComment,
  ensureCommentsArray,
  createComment as createSidecarComment,
  getUnresolvedComments as getUnresolvedSidecarComments,
} from '../../../src/formats/provenance-sidecar.js';
export * from '../../../src/formats/remark-proof-marks.js';
export * from '../../../src/shared/agent-identity.js';
