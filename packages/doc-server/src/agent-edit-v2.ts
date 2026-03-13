import { createHash, randomUUID } from 'crypto';
import type { Node as ProseMirrorNode, Schema } from '@milkdown/prose/model';
import {
  addDocumentEvent,
  bumpDocumentAccessEpoch,
  getDocumentBySlug,
  listLiveDocumentBlocks,
  rebuildDocumentBlocks,
  type DocumentBlockRow,
} from './db.js';
import { deriveProjectionFromCanonicalDoc, mutateCanonicalDocument } from './canonical-document-shared.js';
import { buildAgentSnapshot } from './agent-snapshot.js';
import {
  acquireRewriteLock,
  applyCanonicalDocumentToCollabWithVerification,
  getCanonicalReadableDocumentSync,
  getLoadedCollabMarkdown,
  invalidateCollabDocument,
  invalidateCollabDocumentAndWait,
  isCanonicalReadMutationReady,
  loadCanonicalYDoc,
  stripEphemeralCollabSpans,
} from './collab-shared.js';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeMarkdown,
  serializeSingleNode,
  summarizeParseError,
  type HeadlessMilkdownParser,
} from './milkdown-headless.js';
import { getActiveCollabClientCount } from './ws.js';
import { canonicalizeStoredMarks, type StoredMark } from '@proof/core/marks';
import { refreshSnapshotForSlug } from './snapshot.js';

export type AgentEditV2Result = {
  status: number;
  body: Record<string, unknown>;
};

type ReplaceBlockOp = { op: 'replace_block'; ref: string; block: { markdown: string } };

type InsertAfterOp = { op: 'insert_after'; ref: string; blocks: Array<{ markdown: string }> };

type InsertBeforeOp = { op: 'insert_before'; ref: string; blocks: Array<{ markdown: string }> };

type DeleteBlockOp = { op: 'delete_block'; ref: string };

type ReplaceRangeOp = {
  op: 'replace_range';
  fromRef: string;
  toRef: string;
  blocks: Array<{ markdown: string }>;
};

type FindReplaceOp = {
  op: 'find_replace_in_block';
  ref: string;
  find: string;
  replace: string;
  occurrence?: 'first' | 'all';
};

type AgentEditV2Operation =
  | ReplaceBlockOp
  | InsertAfterOp
  | InsertBeforeOp
  | DeleteBlockOp
  | ReplaceRangeOp
  | FindReplaceOp;

type BlockState = {
  id: string;
  createdRevision: number;
  node: ProseMirrorNode;
};

type BlockDescriptor = {
  ordinal: number;
  nodeType: string;
  attrs: Record<string, unknown>;
  markdown: string;
  markdownHash: string;
  textPreview: string;
};

type ReferencedSnapshotRef = {
  ref: string;
  opIndex: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function projectionStaleEditResult(): AgentEditV2Result {
  return {
    status: 409,
    body: {
      success: false,
      code: 'PROJECTION_STALE',
      error: 'Document projection is stale; retry after repair completes',
    },
  };
}

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function buildTextPreview(text: string, limit: number = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

async function buildBlockDescriptorsFromDoc(doc: ProseMirrorNode): Promise<BlockDescriptor[]> {
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

function blockDescriptorMatches(left: BlockDescriptor | undefined, right: BlockDescriptor | undefined): boolean {
  if (!left || !right) return false;
  return left.nodeType === right.nodeType && left.markdownHash === right.markdownHash;
}

function collectReferencedSnapshotRefs(operations: AgentEditV2Operation[]): ReferencedSnapshotRef[] {
  const refs: ReferencedSnapshotRef[] = [];

  for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
    const op = operations[opIndex];
    if (
      op.op === 'replace_block'
      || op.op === 'insert_after'
      || op.op === 'insert_before'
      || op.op === 'delete_block'
      || op.op === 'find_replace_in_block'
    ) {
      refs.push({ ref: op.ref, opIndex });
      continue;
    }
    if (op.op === 'replace_range') {
      refs.push({ ref: op.fromRef, opIndex });
      refs.push({ ref: op.toRef, opIndex });
    }
  }

  return refs;
}

function findLiveRefDrift(
  persistedBlocks: BlockDescriptor[],
  liveBlocks: BlockDescriptor[],
  operations: AgentEditV2Operation[],
): ReferencedSnapshotRef | null {
  for (const ref of collectReferencedSnapshotRefs(operations)) {
    const idx = parseRef(ref.ref);
    if (idx === null) continue;
    if (!blockDescriptorMatches(persistedBlocks[idx], liveBlocks[idx])) {
      return ref;
    }
  }
  return null;
}

function parseRef(ref: string): number | null {
  const match = ref.match(/^b(\d+)$/i);
  if (!match) return null;
  const idx = Number.parseInt(match[1], 10);
  if (!Number.isFinite(idx) || idx < 1) return null;
  return idx - 1;
}

function replaceFirst(source: string, find: string, replace: string): string | null {
  const idx = source.indexOf(find);
  if (idx < 0) return null;
  return `${source.slice(0, idx)}${replace}${source.slice(idx + find.length)}`;
}

async function parseSingleBlockMarkdown(
  parser: HeadlessMilkdownParser,
  markdown: string,
): Promise<{ node: ProseMirrorNode } | { error: string }> {
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown ?? '');
  if (!parsed.doc) {
    return { error: summarizeParseError(parsed.error) };
  }
  if (parsed.doc.childCount !== 1) {
    return { error: 'Expected block markdown to parse into a single top-level node' };
  }
  return { node: parsed.doc.child(0) };
}

async function buildSnapshot(slug: string): Promise<Record<string, unknown> | null> {
  try {
    const snapshot = await buildAgentSnapshot(slug);
    if (snapshot.status >= 200 && snapshot.status < 300) {
      return snapshot.body;
    }
    if (snapshot.body && typeof snapshot.body === 'object') return snapshot.body as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function normalizeOperations(
  raw: unknown[],
): { operations: AgentEditV2Operation[]; insertCount: number } | { error: string; opIndex: number } {
  const operations: AgentEditV2Operation[] = [];
  let insertCount = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const op = raw[i];
    if (!isRecord(op) || typeof op.op !== 'string') {
      return { error: 'Invalid operation payload', opIndex: i };
    }

    const kind = op.op;
    if (kind === 'replace_block') {
      if (typeof op.ref !== 'string' || !isRecord(op.block) || typeof op.block.markdown !== 'string') {
        return { error: 'replace_block requires ref + block.markdown', opIndex: i };
      }
      operations.push({ op: 'replace_block', ref: op.ref, block: { markdown: op.block.markdown } });
      insertCount += 1;
      continue;
    }
    if (kind === 'insert_after') {
      if (typeof op.ref !== 'string' || !Array.isArray(op.blocks)) {
        return { error: 'insert_after requires ref + blocks', opIndex: i };
      }
      const blocks = op.blocks.map((block) => (isRecord(block) ? block.markdown : null));
      if (blocks.some((markdown) => typeof markdown !== 'string')) {
        return { error: 'insert_after blocks must include markdown', opIndex: i };
      }
      operations.push({
        op: 'insert_after',
        ref: op.ref,
        blocks: blocks.map((markdown) => ({ markdown: markdown as string })),
      });
      insertCount += blocks.length;
      continue;
    }
    if (kind === 'insert_before') {
      if (typeof op.ref !== 'string' || !Array.isArray(op.blocks)) {
        return { error: 'insert_before requires ref + blocks', opIndex: i };
      }
      const blocks = op.blocks.map((block) => (isRecord(block) ? block.markdown : null));
      if (blocks.some((markdown) => typeof markdown !== 'string')) {
        return { error: 'insert_before blocks must include markdown', opIndex: i };
      }
      operations.push({
        op: 'insert_before',
        ref: op.ref,
        blocks: blocks.map((markdown) => ({ markdown: markdown as string })),
      });
      insertCount += blocks.length;
      continue;
    }
    if (kind === 'delete_block') {
      if (typeof op.ref !== 'string') {
        return { error: 'delete_block requires ref', opIndex: i };
      }
      operations.push({ op: 'delete_block', ref: op.ref });
      continue;
    }
    if (kind === 'replace_range') {
      if (typeof op.fromRef !== 'string' || typeof op.toRef !== 'string' || !Array.isArray(op.blocks)) {
        return { error: 'replace_range requires fromRef + toRef + blocks', opIndex: i };
      }
      const blocks = op.blocks.map((block) => (isRecord(block) ? block.markdown : null));
      if (blocks.some((markdown) => typeof markdown !== 'string')) {
        return { error: 'replace_range blocks must include markdown', opIndex: i };
      }
      operations.push({
        op: 'replace_range',
        fromRef: op.fromRef,
        toRef: op.toRef,
        blocks: blocks.map((markdown) => ({ markdown: markdown as string })),
      });
      insertCount += blocks.length;
      continue;
    }
    if (kind === 'find_replace_in_block') {
      if (typeof op.ref !== 'string' || typeof op.find !== 'string' || typeof op.replace !== 'string') {
        return { error: 'find_replace_in_block requires ref + find + replace', opIndex: i };
      }
      const occurrence = typeof op.occurrence === 'string' ? op.occurrence : 'first';
      if (occurrence !== 'first' && occurrence !== 'all') {
        return { error: 'find_replace_in_block occurrence must be first or all', opIndex: i };
      }
      operations.push({
        op: 'find_replace_in_block',
        ref: op.ref,
        find: op.find,
        replace: op.replace,
        occurrence,
      });
      continue;
    }

    return { error: `Unknown op: ${JSON.stringify(kind)}`, opIndex: i };
  }

  return { operations, insertCount };
}

async function applyOperations(
  parser: HeadlessMilkdownParser,
  blocks: BlockState[],
  operations: AgentEditV2Operation[],
  nextRevision: number,
): Promise<{ ok: true; blocks: BlockState[] } | { ok: false; code: string; message: string; opIndex: number } > {
  for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
    const op = operations[opIndex];
    if (op.op === 'replace_block') {
      const idx = parseRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) {
        return { ok: false, code: 'INVALID_REF', message: 'Invalid ref', opIndex };
      }
      const parsed = await parseSingleBlockMarkdown(parser, op.block.markdown);
      if ('error' in parsed) {
        return { ok: false, code: 'INVALID_BLOCK_MARKDOWN', message: parsed.error, opIndex };
      }
      blocks.splice(idx, 1, { id: randomUUID(), createdRevision: nextRevision, node: parsed.node });
      continue;
    }

    if (op.op === 'insert_after') {
      const idx = parseRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) {
        return { ok: false, code: 'INVALID_REF', message: 'Invalid ref', opIndex };
      }
      const inserts: BlockState[] = [];
      for (const block of op.blocks) {
        const parsed = await parseSingleBlockMarkdown(parser, block.markdown);
        if ('error' in parsed) {
          return { ok: false, code: 'INVALID_BLOCK_MARKDOWN', message: parsed.error, opIndex };
        }
        inserts.push({ id: randomUUID(), createdRevision: nextRevision, node: parsed.node });
      }
      blocks.splice(idx + 1, 0, ...inserts);
      continue;
    }

    if (op.op === 'insert_before') {
      const idx = parseRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) {
        return { ok: false, code: 'INVALID_REF', message: 'Invalid ref', opIndex };
      }
      const inserts: BlockState[] = [];
      for (const block of op.blocks) {
        const parsed = await parseSingleBlockMarkdown(parser, block.markdown);
        if ('error' in parsed) {
          return { ok: false, code: 'INVALID_BLOCK_MARKDOWN', message: parsed.error, opIndex };
        }
        inserts.push({ id: randomUUID(), createdRevision: nextRevision, node: parsed.node });
      }
      blocks.splice(idx, 0, ...inserts);
      continue;
    }

    if (op.op === 'delete_block') {
      const idx = parseRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) {
        return { ok: false, code: 'INVALID_REF', message: 'Invalid ref', opIndex };
      }
      blocks.splice(idx, 1);
      continue;
    }

    if (op.op === 'replace_range') {
      const fromIdx = parseRef(op.fromRef);
      const toIdx = parseRef(op.toRef);
      if (fromIdx === null || toIdx === null || fromIdx < 0 || toIdx < 0 || fromIdx >= blocks.length || toIdx >= blocks.length) {
        return { ok: false, code: 'INVALID_REF', message: 'Invalid range ref', opIndex };
      }
      if (fromIdx > toIdx) {
        return { ok: false, code: 'INVALID_RANGE', message: 'fromRef must be before toRef', opIndex };
      }
      const inserts: BlockState[] = [];
      for (const block of op.blocks) {
        const parsed = await parseSingleBlockMarkdown(parser, block.markdown);
        if ('error' in parsed) {
          return { ok: false, code: 'INVALID_BLOCK_MARKDOWN', message: parsed.error, opIndex };
        }
        inserts.push({ id: randomUUID(), createdRevision: nextRevision, node: parsed.node });
      }
      blocks.splice(fromIdx, toIdx - fromIdx + 1, ...inserts);
      continue;
    }

    if (op.op === 'find_replace_in_block') {
      if (!op.find) {
        return { ok: false, code: 'INVALID_OPERATIONS', message: 'find must be non-empty', opIndex };
      }
      const idx = parseRef(op.ref);
      if (idx === null || idx < 0 || idx >= blocks.length) {
        return { ok: false, code: 'INVALID_REF', message: 'Invalid ref', opIndex };
      }
      const current = blocks[idx];
      const markdown = await serializeSingleNode(current.node);
      let replaced: string | null = null;
      if (op.occurrence === 'all') {
        if (!markdown.includes(op.find)) {
          return { ok: false, code: 'FIND_TARGET_NOT_FOUND', message: 'find target not found', opIndex };
        }
        replaced = markdown.split(op.find).join(op.replace);
      } else {
        replaced = replaceFirst(markdown, op.find, op.replace);
        if (replaced === null) {
          return { ok: false, code: 'FIND_TARGET_NOT_FOUND', message: 'find target not found', opIndex };
        }
      }
      const parsed = await parseSingleBlockMarkdown(parser, replaced);
      if ('error' in parsed) {
        return { ok: false, code: 'INVALID_BLOCK_MARKDOWN', message: parsed.error, opIndex };
      }
      blocks.splice(idx, 1, { ...current, node: parsed.node });
      continue;
    }
  }

  return { ok: true, blocks };
}

function parseCanonicalMarks(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return canonicalizeStoredMarks(parsed as Record<string, StoredMark>);
    }
  } catch {
    // ignore malformed marks payload
  }
  return {};
}

const EDIT_V2_COLLAB_TIMEOUT_MS = parsePositiveInt(process.env.AGENT_EDIT_V2_COLLAB_TIMEOUT_MS, 3000);
const EDIT_V2_COLLAB_STABILITY_MS = parsePositiveInt(process.env.AGENT_EDIT_V2_COLLAB_STABILITY_MS, 2500);
const EDIT_V2_COLLAB_STABILITY_SAMPLE_MS = parsePositiveInt(process.env.AGENT_EDIT_V2_COLLAB_STABILITY_SAMPLE_MS, 100);
const EDIT_V2_BARRIER_TIMEOUT_MS = parsePositiveInt(process.env.AGENT_EDIT_V2_BARRIER_TIMEOUT_MS, 5000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyLoadedCollabMarkdownStable(
  slug: string,
  expectedMarkdown: string,
  stabilityMs: number,
): Promise<boolean> {
  if (stabilityMs <= 0) return true;
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, EDIT_V2_COLLAB_STABILITY_SAMPLE_MS);
  while (Date.now() <= deadline) {
    const current = getLoadedCollabMarkdown(slug);
    if (current === null) return true;
    if (current !== expectedMarkdown) return false;
    await sleep(sampleMs);
  }
  return true;
}

async function prepareEditV2CollabBarrier(slug: string): Promise<void> {
  acquireRewriteLock(slug);
  bumpDocumentAccessEpoch(slug);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      invalidateCollabDocumentAndWait(slug),
      new Promise<void>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`edit.v2 collab barrier timed out after ${EDIT_V2_BARRIER_TIMEOUT_MS}ms`)), EDIT_V2_BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function finalizeAgentEditV2Response(
  slug: string,
  by: string,
  markdown: string,
  marks: Record<string, unknown>,
  revision: number,
): Promise<AgentEditV2Result> {
  let collabResult = await applyCanonicalDocumentToCollabWithVerification(slug, {
    markdown,
    marks,
    source: by,
  }, EDIT_V2_COLLAB_TIMEOUT_MS);

  if (collabResult.confirmed) {
    const stable = await verifyLoadedCollabMarkdownStable(slug, markdown, EDIT_V2_COLLAB_STABILITY_MS);
    if (!stable) {
      collabResult = {
        ...collabResult,
        confirmed: false,
        reason: 'stability_regressed',
      };
    }
  }

  if (!collabResult.confirmed) {
    try {
      await prepareEditV2CollabBarrier(slug);
      const refreshed = getDocumentBySlug(slug);
      if (!refreshed) {
        collabResult = {
          ...collabResult,
          confirmed: false,
          reason: 'missing_document',
        };
      } else {
        const refreshedMarks = parseCanonicalMarks(refreshed.marks);
        collabResult = await applyCanonicalDocumentToCollabWithVerification(slug, {
          markdown: refreshed.markdown,
          marks: refreshedMarks,
          source: `${by}-fallback`,
        }, EDIT_V2_COLLAB_TIMEOUT_MS);
        if (collabResult.confirmed) {
          const stable = await verifyLoadedCollabMarkdownStable(slug, refreshed.markdown, EDIT_V2_COLLAB_STABILITY_MS);
          if (!stable) {
            collabResult = {
              ...collabResult,
              confirmed: false,
              reason: 'stability_regressed',
            };
          }
        }
      }
    } catch (error) {
      console.warn('[agent-edit-v2] Failed to apply collab barrier fallback after verification drift', { slug, error });
      collabResult = {
        ...collabResult,
        confirmed: false,
        reason: 'fallback_barrier_failed',
      };
    }
    if (!collabResult.confirmed) {
      invalidateCollabDocument(slug);
    }
  }

  const snapshot = await buildSnapshot(slug);
  const status = collabResult.confirmed ? 200 : 202;

  return {
    status,
    body: {
      success: true,
      slug,
      revision,
      collab: {
        status: collabResult.confirmed ? 'confirmed' : 'pending',
        reason: collabResult.confirmed ? undefined : collabResult.reason ?? 'sync_timeout',
        yStateVersion: collabResult.yStateVersion,
      },
      snapshot,
    },
  };
}
export async function applyAgentEditV2(
  slug: string,
  body: unknown,
): Promise<AgentEditV2Result> {
  const payload = isRecord(body) ? body : {};
  const operationsRaw = Array.isArray(payload.operations) ? payload.operations : [];
  const baseRevision = typeof payload.baseRevision === 'number' ? payload.baseRevision : null;
  const by = typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : 'ai:unknown';

  if (!Number.isInteger(baseRevision) || baseRevision === null || baseRevision < 1) {
    return { status: 400, body: { success: false, code: 'INVALID_REQUEST', error: 'baseRevision is required' } };
  }

  if (operationsRaw.length === 0) {
    return { status: 400, body: { success: false, code: 'INVALID_OPERATIONS', error: 'operations must be a non-empty array' } };
  }
  if (operationsRaw.length > 100) {
    return { status: 400, body: { success: false, code: 'OP_LIMIT_EXCEEDED', error: 'Too many operations' } };
  }

  const normalized = normalizeOperations(operationsRaw as unknown[]);
  if ('error' in normalized) {
    return {
      status: 400,
      body: { success: false, code: 'INVALID_OPERATIONS', error: normalized.error, opIndex: normalized.opIndex },
    };
  }

  if (normalized.insertCount > 500) {
    return { status: 400, body: { success: false, code: 'REQUEST_TOO_LARGE', error: 'Too many blocks inserted' } };
  }

  for (let i = 0; i < normalized.operations.length; i += 1) {
    const op = normalized.operations[i];
    if (op.op === 'replace_block') {
      const bytes = Buffer.byteLength(op.block.markdown ?? '', 'utf8');
      if (bytes > 50_000) {
        return { status: 400, body: { success: false, code: 'REQUEST_TOO_LARGE', error: 'Block markdown too large', opIndex: i } };
      }
    }
    if (op.op === 'insert_after' || op.op === 'insert_before' || op.op === 'replace_range') {
      for (const block of op.blocks) {
        const bytes = Buffer.byteLength(block.markdown ?? '', 'utf8');
        if (bytes > 50_000) {
          return { status: 400, body: { success: false, code: 'REQUEST_TOO_LARGE', error: 'Block markdown too large', opIndex: i } };
        }
      }
    }
  }

  const doc = getCanonicalReadableDocumentSync(slug, 'state') ?? getDocumentBySlug(slug);
  if (!doc) {
    return { status: 404, body: { success: false, code: 'NOT_FOUND', error: 'Document not found' } };
  }
  if (!isCanonicalReadMutationReady(doc)) {
    return projectionStaleEditResult();
  }

  if (doc.revision !== baseRevision) {
    const snapshot = await buildSnapshot(slug);
    return {
      status: 409,
      body: {
        success: false,
        code: 'STALE_REVISION',
        error: 'Document changed since baseRevision',
        ...(snapshot ? { snapshot } : {}),
      },
    };
  }

  const parser = await getHeadlessMilkdownParser();
  const activeCollabClients = getActiveCollabClientCount(slug);
  let authoritativeMarkdown = stripEphemeralCollabSpans(doc.markdown ?? '');
  let authoritativeMarks = parseCanonicalMarks(doc.marks);
  let liveHandle: Awaited<ReturnType<typeof loadCanonicalYDoc>> | null = null;
  if (activeCollabClients > 0) {
    liveHandle = await loadCanonicalYDoc(slug, { liveRequired: true });
    if (liveHandle) {
      const derived = await deriveProjectionFromCanonicalDoc(liveHandle.ydoc);
      authoritativeMarkdown = stripEphemeralCollabSpans(derived.markdown);
      authoritativeMarks = derived.marks as Record<string, unknown>;
    }
  }

  let baseDoc: ProseMirrorNode;
  const parsedBase = parseMarkdownWithHtmlFallback(parser, authoritativeMarkdown);
  if (!parsedBase.doc) {
    await liveHandle?.cleanup?.();
    return {
      status: 500,
      body: {
        success: false,
        code: 'INTERNAL_EDIT_APPLY_FAILED',
        error: summarizeParseError(parsedBase.error),
      },
    };
  }
  baseDoc = parsedBase.doc;

  if (!doc.doc_id) {
    await liveHandle?.cleanup?.();
    return { status: 500, body: { success: false, code: 'INTERNAL_ERROR', error: 'Document is missing doc_id' } };
  }

  const blocks: BlockState[] = [];
  const usingLiveAuthoritativeBase = authoritativeMarkdown !== stripEphemeralCollabSpans(doc.markdown ?? '');
  if (usingLiveAuthoritativeBase) {
    const persistedBase = parseMarkdownWithHtmlFallback(parser, stripEphemeralCollabSpans(doc.markdown ?? ''));
    if (!persistedBase.doc) {
      await liveHandle?.cleanup?.();
      return {
        status: 500,
        body: {
          success: false,
          code: 'INTERNAL_EDIT_APPLY_FAILED',
          error: summarizeParseError(persistedBase.error),
        },
      };
    }

    const [persistedDescriptors, liveDescriptors] = await Promise.all([
      buildBlockDescriptorsFromDoc(persistedBase.doc),
      buildBlockDescriptorsFromDoc(baseDoc),
    ]);
    const driftedRef = findLiveRefDrift(persistedDescriptors, liveDescriptors, normalized.operations);
    if (driftedRef) {
      const snapshot = await buildSnapshot(slug);
      await liveHandle?.cleanup?.();
      return {
        status: 409,
        body: {
          success: false,
          code: 'FRAGMENT_DIVERGENCE',
          error: `Live block at ${driftedRef.ref} no longer matches the base snapshot; refresh state before retrying`,
          opIndex: driftedRef.opIndex,
          retryWithState: `/api/agent/${slug}/state`,
          ...(snapshot ? { snapshot } : {}),
        },
      };
    }
  }

  if (!usingLiveAuthoritativeBase) {
    let storedBlocks = listLiveDocumentBlocks(doc.doc_id);
    const descriptors = await buildBlockDescriptorsFromDoc(baseDoc);
    if (needsBlockRebuild(descriptors, storedBlocks)) {
      storedBlocks = await rebuildDocumentBlocks(doc, doc.markdown, doc.revision);
    }

    const byOrdinal = new Map<number, DocumentBlockRow>();
    for (const row of storedBlocks) {
      byOrdinal.set(row.ordinal, row);
    }

    for (let i = 0; i < baseDoc.childCount; i += 1) {
      const row = byOrdinal.get(i + 1);
      if (!row) {
        await liveHandle?.cleanup?.();
        return { status: 500, body: { success: false, code: 'INTERNAL_ERROR', error: 'Missing block mapping' } };
      }
      blocks.push({
        id: row.block_id,
        createdRevision: row.created_revision,
        node: baseDoc.child(i),
      });
    }
  } else {
    for (let i = 0; i < baseDoc.childCount; i += 1) {
      blocks.push({
        id: `live:${i + 1}`,
        createdRevision: doc.revision,
        node: baseDoc.child(i),
      });
    }
  }

  const nextRevision = doc.revision + 1;
  const applied = await applyOperations(parser, blocks, normalized.operations, nextRevision);
  if (!applied.ok) {
    const snapshot = await buildSnapshot(slug);
    await liveHandle?.cleanup?.();
    return {
      status: 400,
      body: {
        success: false,
        code: applied.code,
        error: applied.message,
        opIndex: applied.opIndex,
        ...(snapshot ? { snapshot } : {}),
      },
    };
  }

  let nextDoc: ProseMirrorNode;
  try {
    nextDoc = (parser.schema as Schema).topNodeType.create(null, applied.blocks.map((block) => block.node));
  } catch (error) {
    await liveHandle?.cleanup?.();
    return {
      status: 500,
      body: {
        success: false,
        code: 'INTERNAL_EDIT_APPLY_FAILED',
        error: error instanceof Error ? error.message : 'Failed to build document',
      },
    };
  }

  const nextMarkdown = await serializeMarkdown(nextDoc);
  const marks = authoritativeMarks;
  if (nextMarkdown === doc.markdown) {
    await liveHandle?.cleanup?.();
    return finalizeAgentEditV2Response(slug, by, doc.markdown, marks, doc.revision);
  }
  const mutation = await mutateCanonicalDocument({
    slug,
    nextMarkdown,
    nextMarks: marks,
    source: by,
    baseRevision,
    strictLiveDoc: true,
    guardPathologicalGrowth: true,
  });

  if (!mutation.ok) {
    const snapshot = await buildSnapshot(slug);
    await liveHandle?.cleanup?.();
    return {
      status: mutation.status,
      body: {
        success: false,
        code: mutation.code,
        error: mutation.error,
        ...(mutation.retryWithState ? { retryWithState: mutation.retryWithState } : {}),
        ...(snapshot ? { snapshot } : {}),
      },
    };
  }

  addDocumentEvent(slug, 'agent.edit.v2', { by, operations: normalized.operations }, by);
  refreshSnapshotForSlug(slug);
  await liveHandle?.cleanup?.();
  return finalizeAgentEditV2Response(slug, by, nextMarkdown, marks, mutation.document.revision);
}
