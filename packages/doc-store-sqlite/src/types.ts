export type { ShareRole, ShareState } from '@proof/server/share-types';

export interface DocumentRow {
  slug: string;
  doc_id: string | null;
  title: string | null;
  markdown: string;
  marks: string;
  revision: number;
  y_state_version: number;
  share_state: ShareState;
  access_epoch: number;
  live_collab_seen_at: string | null;
  live_collab_access_epoch: number | null;
  active: number;
  owner_id: string | null;
  owner_secret: string | null;
  owner_secret_hash: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DocumentEventRow {
  id: number;
  document_slug: string;
  document_revision: number | null;
  event_type: string;
  event_data: string;
  actor: string;
  idempotency_key: string | null;
  tombstone_revision: number | null;
  created_at: string;
  acked_by: string | null;
  acked_at: string | null;
}

export interface DocumentAccessToken {
  tokenId: string;
  role: ShareRole;
  secret: string;
  createdAt: string;
}
