import type { ShareRole } from './share-types.js';

export type DocumentOpType =
  | 'comment.add'
  | 'comment.reply'
  | 'comment.resolve'
  | 'comment.unresolve'
  | 'suggestion.add'
  | 'suggestion.accept'
  | 'suggestion.reject'
  | 'rewrite.apply';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDocumentOpRequest(body: unknown): { op: DocumentOpType; payload: Record<string, unknown> } | { error: string } {
  const raw = isRecord(body) ? body : {};
  const op = (raw.type ?? raw.op) as DocumentOpType | undefined;
  if (!op) return { error: 'Missing operation type' };

  const payload = (isRecord(raw.payload) ? { ...(raw.payload as Record<string, unknown>) } : { ...raw }) as Record<string, unknown>;
  delete payload.type;
  delete payload.op;
  delete payload.payload;

  return { op, payload };
}

export function resolveDocumentOpRoute(
  opType: DocumentOpType,
  payload: Record<string, unknown>,
): { method: 'POST'; path: string; body: Record<string, unknown> } | null {
  switch (opType) {
    case 'comment.add':
      return { method: 'POST', path: '/marks/comment', body: payload };
    case 'comment.reply':
      return { method: 'POST', path: '/marks/reply', body: payload };
    case 'comment.resolve':
      return { method: 'POST', path: '/marks/resolve', body: payload };
    case 'comment.unresolve':
      return { method: 'POST', path: '/marks/unresolve', body: payload };
    case 'suggestion.accept':
      return { method: 'POST', path: '/marks/accept', body: payload };
    case 'suggestion.reject':
      return { method: 'POST', path: '/marks/reject', body: payload };
    case 'rewrite.apply':
      return { method: 'POST', path: '/rewrite', body: payload };
    case 'suggestion.add': {
      const kind = typeof payload.kind === 'string' ? payload.kind : '';
      if (kind === 'insert') return { method: 'POST', path: '/marks/suggest-insert', body: payload };
      if (kind === 'delete') return { method: 'POST', path: '/marks/suggest-delete', body: payload };
      if (kind === 'replace') return { method: 'POST', path: '/marks/suggest-replace', body: payload };
      return null;
    }
    default:
      return null;
  }
}

export function authorizeDocumentOp(
  type: DocumentOpType,
  accessRole: ShareRole | null,
  ownerAuthorized: boolean,
  shareState: string,
): string | null {
  if (shareState === 'DELETED') return 'Document deleted';
  if (shareState === 'REVOKED' && !ownerAuthorized) return 'Document access has been revoked';

  if (ownerAuthorized || accessRole === 'owner_bot') return null;
  if (shareState !== 'ACTIVE') return 'Document is paused';

  const isEditor = accessRole === 'editor';
  const isCommenter = accessRole === 'commenter';
  switch (type) {
    case 'comment.add':
    case 'comment.reply':
    case 'comment.resolve':
    case 'comment.unresolve':
    case 'suggestion.add':
      if (isEditor || isCommenter) return null;
      return 'Insufficient role for operation';
    case 'suggestion.accept':
    case 'suggestion.reject':
    case 'rewrite.apply':
      if (isEditor) return null;
      return 'Insufficient role for operation';
    default:
      return 'Unsupported operation';
  }
}
