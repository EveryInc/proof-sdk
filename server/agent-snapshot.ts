import { createHash } from 'crypto';
import type { DocumentRow, DocumentBlockRow } from './db.js';
import { getDocumentBySlug, listLiveDocumentBlocks } from './db.js';
import {
  type AuthoritativeMutationBase,
  getCanonicalReadableDocument,
  isCanonicalReadMutationReady,
  resolveAuthoritativeMutationBase,
} from './collab.js';
import { recoverCanonicalDocumentIfNeeded } from './canonical-document.js';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeSingleNode,
  summarizeParseError,
} from './milkdown-headless.js';
import { stripAllProofSpanTags } from './proof-span-strip.js';
import { getActiveCollabClientCount } from './ws.js';

export type AgentSnapshotResult = {
  status: number;
  body: Record<string, unknown>;
};

type SnapshotOptions = {
  revision?: number | null;
  includeTextPreview?: boolean;
};

type BlockDescriptor = {
  ordinal: number;
  nodeType: string;
  attrs: Record<string, unknown>;
  markdown: string;
  markdownHash: string;
  textPreview: string;
};

type SnapshotDocument = DocumentRow & {
  read_source?: 'projection' | 'canonical_row' | 'yjs_fallback';
};

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function buildTextPreview(text: string, limit: number = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

async function buildBlockDescriptors(markdown: string): Promise<BlockDescriptor[]> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown ?? '');
  if (!parsed.doc) {
    throw new Error(`Failed to parse snapshot markdown: ${summarizeParseError(parsed.error)}`);
  }
  const doc = parsed.doc;
  const blocks: BlockDescriptor[] = [];

  for (let i = 0; i < doc.childCount; i += 1) {
    const node = doc.child(i);
    const blockMarkdown = await serializeSingleNode(node);
    blocks.push({
      ordinal: i + 1,
      nodeType: node.type.name,
      attrs: node.attrs ?? {},
      markdown: blockMarkdown,
      markdownHash: hashMarkdown(blockMarkdown),
      textPreview: buildTextPreview(node.textContent),
    });
  }

  return blocks;
}

function needsBlockRebuild(blocks: BlockDescriptor[], stored: DocumentBlockRow[]): boolean {
  if (!stored.length) return true;
  if (stored.length !== blocks.length) return true;
  const byOrdinal = new Map<number, DocumentBlockRow>();
  for (const row of stored) {
    byOrdinal.set(row.ordinal, row);
  }
  for (const block of blocks) {
    const row = byOrdinal.get(block.ordinal);
    if (!row) return true;
    if (row.node_type !== block.nodeType) return true;
    if (row.markdown_hash !== block.markdownHash) return true;
  }
  return false;
}

async function buildSnapshotPayload(
  document: SnapshotDocument,
  includeTextPreview: boolean,
  mutationBase?: AuthoritativeMutationBase | null,
): Promise<Record<string, unknown>> {
  const mutationReady = !('mutation_ready' in document)
    || isCanonicalReadMutationReady(document as { mutation_ready?: boolean });
  const projectionFresh = 'projection_fresh' in document ? document.projection_fresh : true;
  const repairPending = 'repair_pending' in document ? document.repair_pending : !projectionFresh;
  const blocks = await buildBlockDescriptors(document.markdown);
  if (!document.doc_id) {
    throw new Error('Document is missing doc_id; cannot build snapshot.');
  }

  // Snapshot reads must stay read-only. Rebuilding document_blocks here turns a GET
  // into a write path and can contend with live collab persistence under load.
  const storedBlocks = listLiveDocumentBlocks(document.doc_id);
  const storedBlocksAreCurrent = !needsBlockRebuild(blocks, storedBlocks);

  const byOrdinal = new Map<number, DocumentBlockRow>();
  for (const row of storedBlocks) {
    byOrdinal.set(row.ordinal, row);
  }

  const snapshotBlocks = blocks.map((block, index) => {
    const row = byOrdinal.get(block.ordinal);
    const currentRow = storedBlocksAreCurrent ? row : undefined;
    const stableBlockId = storedBlocksAreCurrent && row
      ? row.block_id
      : `snapshot:${document.doc_id}:${mutationReady ? document.revision : 'fallback'}:b${index + 1}`;
    const payload: Record<string, unknown> = {
      ref: `b${index + 1}`,
      id: stableBlockId,
      type: block.nodeType,
      markdown: stripAllProofSpanTags(block.markdown),
    };

    if (block.nodeType === 'heading') {
      const level = typeof block.attrs.level === 'number' ? block.attrs.level : null;
      if (level) payload.level = level;
    }

    if (includeTextPreview) {
      payload.textPreview = currentRow?.text_preview ?? block.textPreview;
    }

    return payload;
  });

  return {
    success: true,
    slug: document.slug,
    revision: mutationReady ? document.revision : null,
    readSource: document.read_source ?? 'projection',
    projectionFresh,
    repairPending,
    mutationReady,
    ...(mutationBase
      ? {
          mutationBase: {
            token: mutationBase.token,
            source: mutationBase.source,
            schemaVersion: mutationBase.schemaVersion,
          },
        }
      : {}),
    generatedAt: new Date().toISOString(),
    blocks: snapshotBlocks,
    _links: (mutationReady || Boolean(mutationBase))
      ? {
        editV2: { method: 'POST', href: `/api/agent/${document.slug}/edit/v2` },
      }
      : {},
    ...(repairPending
      ? {
        warning: {
          code: 'PROJECTION_STALE',
          error: 'Snapshot is serving canonical Yjs fallback content while projection repair catches up.',
        },
      }
      : {}),
  };
}

async function resolveSnapshotMutationBase(slug: string): Promise<AuthoritativeMutationBase | null> {
  const activeCollabClients = getActiveCollabClientCount(slug);
  const resolved = await resolveAuthoritativeMutationBase(slug, {
    liveRequired: activeCollabClients > 0,
  });
  return resolved.ok ? resolved.base : null;
}

export async function buildAgentSnapshot(slug: string, options: SnapshotOptions = {}): Promise<AgentSnapshotResult> {
  const doc = await recoverCanonicalDocumentIfNeeded(slug, 'snapshot')
    ?? await getCanonicalReadableDocument(slug, 'snapshot')
    ?? getDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found', code: 'NOT_FOUND' } };
  }
  if (doc.share_state === 'REVOKED') {
    return { status: 403, body: { success: false, error: 'Document access revoked', code: 'FORBIDDEN' } };
  }

  const includeTextPreview = options.includeTextPreview !== false;
  const requestedRevision = typeof options.revision === 'number' ? options.revision : null;
  const mutationBase = await resolveSnapshotMutationBase(slug);
  const mutationReady = !('mutation_ready' in doc)
    || isCanonicalReadMutationReady(doc as { mutation_ready?: boolean });

  if (requestedRevision !== null && !mutationReady) {
    const snapshot = await buildSnapshotPayload(doc, includeTextPreview, mutationBase);
    return {
      status: 409,
      body: {
        success: false,
        code: 'PROJECTION_STALE',
        error: 'Requested revision is unavailable while projection repair catches up',
        revision: null,
        snapshot,
      },
    };
  }

  if (requestedRevision !== null && requestedRevision !== doc.revision) {
    const snapshot = await buildSnapshotPayload(doc, includeTextPreview, mutationBase);
    return {
      status: 409,
      body: {
        success: false,
        code: 'REVISION_NOT_FOUND',
        error: 'Requested revision is not available',
        revision: doc.revision,
        snapshot,
      },
    };
  }

  const payload = await buildSnapshotPayload(doc, includeTextPreview, mutationBase);
  return { status: 200, body: payload };
}
