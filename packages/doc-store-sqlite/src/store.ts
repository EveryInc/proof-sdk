import {
  ackDocumentEvents as ackDocumentEventsImpl,
  createDocument as createDocumentImpl,
  createDocumentAccessToken as createDocumentAccessTokenImpl,
  getDocument as getDocumentImpl,
  getDocumentBySlug as getDocumentBySlugImpl,
  listDocumentEvents as listDocumentEventsImpl,
  resolveDocumentAccessRole as resolveDocumentAccessRoleImpl,
  updateDocument as updateDocumentImpl,
  updateDocumentTitle as updateDocumentTitleImpl,
} from '../../../server/db.js';
import type {
  DocumentAccessToken,
  DocumentEventRow,
  DocumentRow,
  ShareRole,
} from './types.js';

export function createDocument(
  slug: string,
  markdown: string,
  marks: Record<string, unknown>,
  title?: string,
  ownerId?: string,
  ownerSecret?: string,
): DocumentRow {
  return createDocumentImpl(slug, markdown, marks, title, ownerId, ownerSecret) as DocumentRow;
}

export function getDocument(slug: string): DocumentRow | undefined {
  return getDocumentImpl(slug) as DocumentRow | undefined;
}

export function getDocumentBySlug(slug: string): DocumentRow | undefined {
  return getDocumentBySlugImpl(slug) as DocumentRow | undefined;
}

export function updateDocument(
  slug: string,
  markdown: string,
  marks?: Record<string, unknown>,
  yStateVersion?: number,
): boolean {
  return updateDocumentImpl(slug, markdown, marks, yStateVersion);
}

export function updateDocumentTitle(slug: string, title: string | null): boolean {
  return updateDocumentTitleImpl(slug, title);
}

export function listDocumentEvents(
  slug: string,
  afterId: number,
  limit: number = 100,
): DocumentEventRow[] {
  return listDocumentEventsImpl(slug, afterId, limit) as DocumentEventRow[];
}

export function ackDocumentEvents(slug: string, upToId: number, ackedBy: string): number {
  return ackDocumentEventsImpl(slug, upToId, ackedBy);
}

export function createDocumentAccessToken(
  slug: string,
  role: ShareRole,
  providedSecret?: string,
): DocumentAccessToken {
  return createDocumentAccessTokenImpl(slug, role, providedSecret) as DocumentAccessToken;
}

export function resolveDocumentAccessRole(slug: string, presentedSecret: string): ShareRole | null {
  return resolveDocumentAccessRoleImpl(slug, presentedSecret) as ShareRole | null;
}
