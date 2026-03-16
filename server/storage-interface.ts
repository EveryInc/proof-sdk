/**
 * Abstract storage interface for per-document operations.
 *
 * This interface captures the subset of `db.ts` functions that agent routes
 * depend on, enabling the same route logic to target both the Node.js SQLite
 * backend (better-sqlite3) and Cloudflare Durable Object SQLite.
 *
 * The existing `db.ts` module is NOT modified; this is a forward-looking
 * extraction for use in alternative deployment targets.
 */

import type { DocumentEventType } from './event-types.js';
import type { ShareRole, ShareState } from './share-types.js';

// ---------------------------------------------------------------------------
// Row types (mirrored from db.ts to avoid coupling to better-sqlite3)
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

/**
 * Per-document storage operations consumed by agent routes.
 *
 * Implementations must be scoped to a single document slug (Cloudflare DO) or
 * accept a slug parameter (Node.js SQLite). The interface uses explicit slug
 * parameters so that a single-slug DO implementation can simply assert or
 * ignore the slug while a multi-document SQLite implementation can dispatch
 * normally.
 */
export interface DocumentStorage {
  // -- Document CRUD -------------------------------------------------------

  /** Fetch a document record by slug. */
  getDocumentBySlug(slug: string): StorageDocumentRow | undefined;

  /**
   * Non-atomic document update. Returns `true` if the row was updated.
   * Marks are optional — when omitted, only markdown is updated.
   */
  updateDocument(
    slug: string,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean;

  /**
   * Atomic update gated on `updated_at` timestamp.
   * Returns `true` if the row matched the precondition and was updated.
   */
  updateDocumentAtomic(
    slug: string,
    expectedUpdatedAt: string,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean;

  /**
   * Atomic update gated on revision number.
   * Returns `true` if the row matched the precondition and was updated.
   */
  updateDocumentAtomicByRevision(
    slug: string,
    expectedRevision: number,
    markdown: string,
    marks?: Record<string, unknown>,
  ): boolean;

  // -- Marks ---------------------------------------------------------------

  /** Read the raw marks JSON string for a document. */
  getMarks(slug: string): string | null;

  /** Overwrite marks for a document. Returns `true` on success. */
  setMarks(slug: string, marks: Record<string, unknown>): boolean;

  // -- Events --------------------------------------------------------------

  /**
   * Write a document-scoped event (written to both `document_events` and
   * the `mutation_outbox`).  Returns the new event row id.
   */
  addDocumentEvent(
    slug: string,
    eventType: DocumentEventType,
    eventData: unknown,
    actor: string,
    idempotencyKey?: string,
  ): number;

  /**
   * Write a global event (written to the general `events` table as well as
   * `document_events` + `mutation_outbox`).
   */
  addEvent(
    slug: string,
    eventType: DocumentEventType,
    eventData: unknown,
    actor: string,
  ): void;

  /**
   * List document events with id > `afterId`, up to `limit` rows.
   * Used by the agent polling endpoint.
   */
  listDocumentEvents(
    slug: string,
    afterId: number,
    limit?: number,
  ): StorageDocumentEventRow[];

  /** Mark events up to `upToId` as acknowledged. Returns rows affected. */
  ackDocumentEvents(slug: string, upToId: number, ackedBy: string): number;

  // -- Idempotency ---------------------------------------------------------

  /** Look up a previously stored idempotency result. */
  getStoredIdempotencyRecord(
    documentSlug: string,
    route: string,
    idempotencyKey: string,
  ): StorageIdempotencyRecord | null;

  /** Persist an idempotency result for future replay. */
  storeIdempotencyResult(
    documentSlug: string,
    route: string,
    idempotencyKey: string,
    response: Record<string, unknown>,
    requestHash?: string | null,
    options?: { statusCode?: number; tombstoneRevision?: number | null },
  ): void;

  // -- Access control (simplified) -----------------------------------------

  /** Resolve the access role for a presented secret. */
  resolveDocumentAccessRole(slug: string, presentedSecret: string): ShareRole | null;
}
