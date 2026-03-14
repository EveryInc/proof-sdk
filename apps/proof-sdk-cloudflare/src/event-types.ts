/**
 * Typed event registry for document and agent events.
 *
 * Replaces freeform event type strings with a single const object and
 * derived union type so that typos are caught at compile time.
 */

export const DocumentEventType = {
  // Document lifecycle
  'document.created': 'document.created',
  'document.updated': 'document.updated',
  'document.rewritten': 'document.rewritten',
  'document.deleted': 'document.deleted',
  'document.paused': 'document.paused',
  'document.resumed': 'document.resumed',
  'document.revoked': 'document.revoked',
  'document.title.updated': 'document.title.updated',
  'document.edited': 'document.edited',

  // Agent activity
  'agent.connected': 'agent.connected',
  'agent.presence': 'agent.presence',
  'agent.disconnected': 'agent.disconnected',
  'agent.edit': 'agent.edit',
  'agent.edit.v2': 'agent.edit.v2',

  // Comments
  'comment.added': 'comment.added',
  'comment.replied': 'comment.replied',
  'comment.resolved': 'comment.resolved',
  'comment.unresolved': 'comment.unresolved',

  // Suggestions — add/accept/reject
  'suggestion.insert.added': 'suggestion.insert.added',
  'suggestion.delete.added': 'suggestion.delete.added',
  'suggestion.replace.added': 'suggestion.replace.added',
  'suggestion.accepted': 'suggestion.accepted',
  'suggestion.rejected': 'suggestion.rejected',

  // Mention
  'mention': 'mention',
} as const;

export type DocumentEventType = (typeof DocumentEventType)[keyof typeof DocumentEventType];

/** Runtime type guard for DocumentEventType values. */
export function isDocumentEventType(value: unknown): value is DocumentEventType {
  return typeof value === 'string' && value in DocumentEventType;
}
