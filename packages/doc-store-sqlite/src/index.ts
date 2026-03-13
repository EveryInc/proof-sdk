import {
  ackDocumentEvents,
  createDocument,
  createDocumentAccessToken,
  getDocument,
  getDocumentBySlug,
  listDocumentEvents,
  resolveDocumentAccessRole,
  updateDocument,
  updateDocumentTitle,
} from './store.js';
export type {
  DocumentAccessToken,
  DocumentEventRow,
  DocumentRow,
  ShareRole,
  ShareState,
} from './types.js';

export interface SqliteDocumentStore {
  createDocument: typeof createDocument;
  createDocumentAccessToken: typeof createDocumentAccessToken;
  getDocument: typeof getDocument;
  getDocumentBySlug: typeof getDocumentBySlug;
  updateDocument: typeof updateDocument;
  updateDocumentTitle: typeof updateDocumentTitle;
  resolveDocumentAccessRole: typeof resolveDocumentAccessRole;
  listDocumentEvents: typeof listDocumentEvents;
  ackDocumentEvents: typeof ackDocumentEvents;
}

export function createSqliteDocumentStore(): SqliteDocumentStore {
  return {
    createDocument,
    createDocumentAccessToken,
    getDocument,
    getDocumentBySlug,
    updateDocument,
    updateDocumentTitle,
    resolveDocumentAccessRole,
    listDocumentEvents,
    ackDocumentEvents,
  };
}

export {
  ackDocumentEvents,
  createDocument,
  createDocumentAccessToken,
  getDocument,
  getDocumentBySlug,
  listDocumentEvents,
  resolveDocumentAccessRole,
  updateDocument,
  updateDocumentTitle,
};
