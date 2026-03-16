/**
 * Abstract storage interface for per-document operations.
 *
 * Copied from server/storage-interface.ts with local import paths.
 * This interface enables the same route logic to target both the Node.js
 * SQLite backend and Cloudflare Durable Object SQLite.
 */

import type { DocumentEventType } from './event-types.js';
import type { ShareRole, ShareState } from './share-types.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** Core document record as stored in the `documents` table. */
export interface StorageDocumentRow {
  slug: string;
  doc_id: string | null;
  title: string | null;
  markdown: string;
  marks: string;
  revision: number;
  y_state_version: number;
  share_state: ShareState;
  access_epoch: number;
  active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A single row from the `document_events` table. */
export interface StorageDocumentEventRow {
  id: number;
  document_slug: string;
  document_revision: number | null;
  event_type: string;
  event_data: string;
  actor: string;
  idempotency_key: string | null;
  created_at: string;
  acked_by: string | null;
  acked_at: string | null;
}

/** Stored idempotency lookup result. */
export interface StorageIdempotencyRecord {
  response: Record<string, unknown>;
  requestHash: string | null;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface DocumentStorage {
  getDocumentBySlug(slug: string): StorageDocumentRow | undefined;

  updateDocument(
    slug: string,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean;

  updateDocumentAtomic(
    slug: string,
    expectedUpdatedAt: string,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean;

  updateDocumentAtomicByRevision(
    slug: string,
    expectedRevision: number,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean;

  getMarks(slug: string): string | null;
  setMarks(slug: string, marks: Record<string, unknown>): boolean;

  addDocumentEvent(
    slug: string,
    eventType: DocumentEventType,
    eventData: unknown,
    actor: string,
    idempotencyKey?: string,
  ): number;

  addEvent(
    slug: string,
    eventType: DocumentEventType,
    eventData: unknown,
    actor: string,
  ): void;

  listDocumentEvents(
    slug: string,
    afterId: number,
    limit?: number,
  ): StorageDocumentEventRow[];

  ackDocumentEvents(slug: string, upToId: number, ackedBy: string): number;

  getStoredIdempotencyRecord(
    documentSlug: string,
    route: string,
    idempotencyKey: string,
  ): StorageIdempotencyRecord | null;

  storeIdempotencyResult(
    documentSlug: string,
    route: string,
    idempotencyKey: string,
    response: Record<string, unknown>,
    requestHash?: string | null,
    options?: { statusCode?: number; tombstoneRevision?: number | null },
  ): void;

  resolveDocumentAccessRole(slug: string, presentedSecret: string): ShareRole | null;
}
