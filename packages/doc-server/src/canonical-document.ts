import { createHash, randomUUID } from 'crypto';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as ProseMirrorNode, Schema } from '@milkdown/prose/model';
import {
  addDocumentEvent,
  createDocument,
  getDb,
  getDocumentBySlug,
  getDocumentProjectionBySlug,
  getLatestYSnapshot,
  getLatestYStateVersion,
  getYUpdatesAfter,
  rebuildDocumentBlocks,
  type DocumentRow,
} from './db.js';
import {
  detectPathologicalProjectionRepeat,
  evaluateProjectionSafety,
  getLoadedCollabFragmentTextHash,
  getCollabRuntime,
  invalidateCollabDocument,
  loadCanonicalYDoc,
  registerCanonicalYDocPersistence,
  stripEphemeralCollabSpans,
} from './collab-shared.js';
import { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback, serializeMarkdown } from './milkdown-headless.js';
import {
  buildProofSpanReplacementMap,
  stripAllProofSpanTagsWithReplacements,
} from './proof-span-strip.js';
import {
  extractAuthoredMarksFromDoc,
  synchronizeAuthoredMarks,
} from './proof-authored-mark-sync.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import { getActiveCollabClientCount } from './ws.js';

type PersistedCanonicalState = {
  ydoc: Y.Doc;
  stateVector: Uint8Array;
  yStateVersion: number;
};

type CanonicalMutationArgs = {
  slug: string;
  nextMarkdown: string;
  nextMarks: Record<string, unknown>;
  source: string;
  baseRevision?: number | null;
  baseUpdatedAt?: string | null;
  strictLiveDoc?: boolean;
  guardPathologicalGrowth?: boolean;
};

type CanonicalMutationFailure = {
  ok: false;
  status: number;
  code: string;
  error: string;
  retryWithState?: string;
};

type CanonicalMutationSuccess = {
  ok: true;
  document: DocumentRow;
  yStateVersion: number;
  activeCollabClients: number;
};

export type CanonicalMutationResult = CanonicalMutationSuccess | CanonicalMutationFailure;

export type CanonicalRepairResult =
  | { ok: true; document: DocumentRow; markdown: string; yStateVersion: number }
  | { ok: false; status: number; code: string; error: string };

export type CanonicalRouteResult = {
  status: number;
  body: Record<string, unknown>;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeFragmentPlainText(input: string): string {
  return input
    .replace(/\u2060/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeMarksMap(map: Y.Map<unknown>): Record<string, unknown> {
  const marks: Record<string, unknown> = {};
  map.forEach((value, key) => {
    marks[key] = value;
  });
  return marks;
}

function parseMarks(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed marks payload
  }
  return {};
}

function stripAuthoredMarks(marks: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [markId, mark] of Object.entries(marks)) {
    if (
      mark
      && typeof mark === 'object'
      && !Array.isArray(mark)
      && (mark as { kind?: unknown }).kind === 'authored'
    ) {
      continue;
    }
    filtered[markId] = mark;
  }
  return filtered;
}

function normalizeProjectionPlainText(markdown: string): string {
  return (markdown ?? '')
    .replace(/<\/?(?:p|br|div|li|ul|ol|blockquote|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function applyYTextDiff(target: Y.Text, nextValue: string): void {
  const currentValue = target.toString();
  if (currentValue === nextValue) return;

  let prefix = 0;
  const maxPrefix = Math.min(currentValue.length, nextValue.length);
  while (prefix < maxPrefix && currentValue.charCodeAt(prefix) === nextValue.charCodeAt(prefix)) {
    prefix += 1;
  }

  let currentSuffix = currentValue.length;
  let nextSuffix = nextValue.length;
  while (
    currentSuffix > prefix
    && nextSuffix > prefix
    && currentValue.charCodeAt(currentSuffix - 1) === nextValue.charCodeAt(nextSuffix - 1)
  ) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  const deleteLength = currentSuffix - prefix;
  if (deleteLength > 0) {
    target.delete(prefix, deleteLength);
  }
  if (nextSuffix > prefix) {
    target.insert(prefix, nextValue.slice(prefix, nextSuffix));
  }
}

function applyMarksMapDiff(map: Y.Map<unknown>, next: Record<string, unknown>): void {
  const nextKeys = new Set(Object.keys(next));
  for (const key of Array.from(map.keys())) {
    if (!nextKeys.has(key)) map.delete(key);
  }
  for (const [key, value] of Object.entries(next)) {
    map.set(key, value);
  }
}

function replaceYXmlFragment(fragment: Y.XmlFragment, pmDoc: unknown): void {
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  prosemirrorToYXmlFragment(pmDoc as any, fragment as any);
}

function seedFragmentFromLegacyMarkdownFallback(ydoc: Y.Doc, markdown: string): void {
  const fragment = ydoc.getXmlFragment('prosemirror');
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) {
    fragment.insert(0, [new Y.XmlElement('paragraph')]);
    return;
  }
  const nodes: Y.XmlElement[] = [];
  for (const block of blocks) {
    const headingMatch = block.match(/^(#{1,6})\s+([\s\S]+)$/);
    if (headingMatch) {
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', String(headingMatch[1].length));
      const textNode = new Y.XmlText();
      textNode.insert(0, headingMatch[2]);
      heading.insert(0, [textNode]);
      nodes.push(heading);
      continue;
    }
    const paragraph = new Y.XmlElement('paragraph');
    const textNode = new Y.XmlText();
    textNode.insert(0, block);
    paragraph.insert(0, [textNode]);
    nodes.push(paragraph);
  }
  fragment.insert(0, nodes);
}

async function seedFragmentFromLegacyMarkdown(ydoc: Y.Doc, markdown: string): Promise<void> {
  try {
    const parser = await getHeadlessMilkdownParser();
    const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
    if (parsed.doc) {
      replaceYXmlFragment(ydoc.getXmlFragment('prosemirror'), parsed.doc);
      return;
    }
    console.warn('[canonical] falling back to heuristic legacy fragment seed after markdown parse failure', {
      error: parsed.error instanceof Error ? `${parsed.error.name}: ${parsed.error.message}` : String(parsed.error),
      mode: parsed.mode,
    });
  } catch (error) {
    console.warn('[canonical] falling back to heuristic legacy fragment seed after parser initialization failure', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
  seedFragmentFromLegacyMarkdownFallback(ydoc, markdown);
}

async function buildPersistedCanonicalState(doc: DocumentRow): Promise<PersistedCanonicalState> {
  const ydoc = new Y.Doc();
  const snapshot = getLatestYSnapshot(doc.slug);
  const startSeq = snapshot?.version ?? 0;
  const updates = getYUpdatesAfter(doc.slug, startSeq);
  if (snapshot) {
    Y.applyUpdate(ydoc, snapshot.snapshot);
  } else if (updates.length === 0) {
    const markdown = stripEphemeralCollabSpans(doc.markdown ?? '');
    ydoc.transact(() => {
      ydoc.getText('markdown').insert(0, markdown);
      applyMarksMapDiff(ydoc.getMap('marks'), parseMarks(doc.marks));
    }, 'legacy-baseline');
    await seedFragmentFromLegacyMarkdown(ydoc, markdown);
  }
  for (const update of updates) {
    Y.applyUpdate(ydoc, update.update);
  }
  return {
    ydoc,
    stateVector: Y.encodeStateVector(ydoc),
    yStateVersion: getLatestYStateVersion(doc.slug),
  };
}

function getFragmentTextHashFromDoc(ydoc: Y.Doc, schema: Schema): string | null {
  try {
    const root = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('prosemirror') as any, schema as any) as ProseMirrorNode;
    return hashText(normalizeFragmentPlainText(root?.textContent ?? ''));
  } catch {
    return null;
  }
}

async function computeFragmentTextHashFromMarkdown(markdown: string): Promise<string | null> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
  if (!parsed.doc) return null;
  return hashText(normalizeFragmentPlainText(parsed.doc.textContent ?? ''));
}

function persistCanonicalProjectionRow(
  slug: string,
  markdown: string,
  marks: Record<string, unknown>,
  revision: number,
  yStateVersion: number,
  updatedAt: string,
  health: 'healthy' | 'projection_stale' | 'quarantined' = 'healthy',
): void {
  getDb().prepare(`
    INSERT INTO document_projections (
      document_slug,
      revision,
      y_state_version,
      markdown,
      marks_json,
      plain_text,
      updated_at,
      health
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_slug) DO UPDATE SET
      revision = excluded.revision,
      y_state_version = excluded.y_state_version,
      markdown = excluded.markdown,
      marks_json = excluded.marks_json,
      plain_text = excluded.plain_text,
      updated_at = excluded.updated_at,
      health = excluded.health
  `).run(
    slug,
    revision,
    yStateVersion,
    markdown,
    JSON.stringify(marks),
    normalizeProjectionPlainText(markdown),
    updatedAt,
    health,
  );
}

function replaceFirstOccurrence(source: string, find: string, replace: string): string | null {
  const idx = source.indexOf(find);
  if (idx < 0) return null;
  return `${source.slice(0, idx)}${replace}${source.slice(idx + find.length)}`;
}

export async function deriveProjectionFromCanonicalDoc(
  ydoc: Y.Doc,
): Promise<{ markdown: string; marks: Record<string, unknown> }> {
  const parser = await getHeadlessMilkdownParser();
  const root = yXmlFragmentToProseMirrorRootNode(
    ydoc.getXmlFragment('prosemirror') as any,
    parser.schema as any,
  ) as ProseMirrorNode;
  const markdown = await serializeMarkdown(root);
  return {
    markdown: stripEphemeralCollabSpans(markdown),
    marks: encodeMarksMap(ydoc.getMap('marks')),
  };
}

export async function mutateCanonicalDocument(args: CanonicalMutationArgs): Promise<CanonicalMutationResult> {
  const doc = getDocumentBySlug(args.slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Document not found' };
  }

  if (typeof args.baseRevision === 'number' && doc.revision !== args.baseRevision) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseRevision',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }
  if (typeof args.baseUpdatedAt === 'string' && args.baseUpdatedAt.trim() && doc.updated_at !== args.baseUpdatedAt) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseUpdatedAt',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }

  const sanitizedMarkdown = stripEphemeralCollabSpans(args.nextMarkdown ?? '');
  const nextMarks = args.nextMarks ?? {};
  const activeCollabClients = getActiveCollabClientCount(args.slug);
  const liveRequired = args.strictLiveDoc !== false && activeCollabClients > 0;
  const shouldBumpAccessEpoch = getCollabRuntime().enabled
    && args.strictLiveDoc !== false
    && activeCollabClients === 0;
  const handle = await loadCanonicalYDoc(args.slug, { liveRequired });
  if (!handle) {
    return {
      ok: false,
      status: 409,
      code: 'LIVE_DOC_UNAVAILABLE',
      error: 'Live canonical document is unavailable; retry after refreshing state',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }

  const parser = await getHeadlessMilkdownParser();
  const parsedNext = parseMarkdownWithHtmlFallback(parser, sanitizedMarkdown);
  if (!parsedNext.doc) {
    await handle.cleanup?.();
    return {
      ok: false,
      status: 422,
      code: 'INVALID_MARKDOWN',
      error: 'Failed to parse markdown into the canonical fragment',
    };
  }

  let authoritativeMarkdown = stripEphemeralCollabSpans(doc.markdown ?? '');
  let authoritativeMarks = stripAuthoredMarks(parseMarks(doc.marks));
  const persistedState = await buildPersistedCanonicalState(doc);
  const ydoc = handle.ydoc;

  if (liveRequired && handle.source === 'live') {
    const derivedCurrent = await deriveProjectionFromCanonicalDoc(ydoc);
    authoritativeMarkdown = stripEphemeralCollabSpans(derivedCurrent.markdown);
    authoritativeMarks = stripAuthoredMarks(derivedCurrent.marks);
  }
  const nextMarksBase = Object.keys(nextMarks).length > 0 ? nextMarks : authoritativeMarks;
  const authoredMarks = extractAuthoredMarksFromDoc(parsedNext.doc as ProseMirrorNode, parser.schema as Schema);
  const effectiveNextMarks = synchronizeAuthoredMarks(nextMarksBase, authoredMarks);

  try {
    if (liveRequired) {
      const liveFragmentHash = await getLoadedCollabFragmentTextHash(args.slug);
      const expectedCurrentFragmentHash = await computeFragmentTextHashFromMarkdown(authoritativeMarkdown);
      if (
        (expectedCurrentFragmentHash !== null && liveFragmentHash !== expectedCurrentFragmentHash)
        || (
          expectedCurrentFragmentHash === null
          && liveFragmentHash === null
          && stripEphemeralCollabSpans(ydoc.getText('markdown').toString()) !== authoritativeMarkdown
        )
      ) {
        return {
          ok: false,
          status: 409,
          code: 'FRAGMENT_DIVERGENCE',
          error: 'Live canonical fragment diverged from the stored canonical state; retry with latest state',
          retryWithState: `/api/agent/${args.slug}/state`,
        };
      }
    }

    if (args.guardPathologicalGrowth !== false) {
      const guardBaselineMarkdown = stripAllProofSpanTagsWithReplacements(
        authoritativeMarkdown,
        buildProofSpanReplacementMap(authoritativeMarks),
      );
      const guardCandidateMarkdown = stripAllProofSpanTagsWithReplacements(
        sanitizedMarkdown,
        buildProofSpanReplacementMap(effectiveNextMarks),
      );
      const safety = evaluateProjectionSafety(guardBaselineMarkdown, guardCandidateMarkdown, ydoc);
      if (!safety.safe && (
        safety.reason === 'max_chars_exceeded'
        || safety.reason === 'growth_multiplier_exceeded'
        || safety.reason === 'pathological_repeat'
      )) {
        return {
          ok: false,
          status: 422,
          code: 'PATHOLOGICAL_GROWTH_BLOCKED',
          error: 'Mutation blocked by projection growth guard',
        };
      }
      if (detectPathologicalProjectionRepeat(guardBaselineMarkdown, guardCandidateMarkdown) > 0) {
        return {
          ok: false,
          status: 422,
          code: 'PATHOLOGICAL_GROWTH_BLOCKED',
          error: 'Mutation blocked by repeated-content guard',
        };
      }
    }

    ydoc.transact(() => {
      replaceYXmlFragment(ydoc.getXmlFragment('prosemirror'), parsedNext.doc);
      applyYTextDiff(ydoc.getText('markdown'), sanitizedMarkdown);
      applyMarksMapDiff(ydoc.getMap('marks'), effectiveNextMarks);
    }, args.source);

    const deltaUpdate = Y.encodeStateAsUpdate(ydoc, persistedState.stateVector);
    const compactionInterval = parsePositiveInt(process.env.COLLAB_COMPACTION_EVERY, 100);
    const now = new Date().toISOString();
    let nextRevision = doc.revision + 1;
    let nextYStateVersion = Math.max(doc.y_state_version, persistedState.yStateVersion);

    const tx = getDb().transaction(() => {
      if (deltaUpdate.byteLength > 0) {
        const inserted = getDb().prepare(`
          INSERT INTO document_y_updates (document_slug, update_blob, source_actor, created_at)
          VALUES (?, ?, ?, ?)
        `).run(args.slug, Buffer.from(deltaUpdate), args.source, now);
        nextYStateVersion = Number(inserted.lastInsertRowid);
        const latestSnapshot = getLatestYSnapshot(args.slug);
        const updatesSinceSnapshot = latestSnapshot ? (nextYStateVersion - latestSnapshot.version) : nextYStateVersion;
        if (updatesSinceSnapshot >= compactionInterval) {
          getDb().prepare(`
            INSERT OR REPLACE INTO document_y_snapshots (document_slug, version, snapshot_blob, created_at)
            VALUES (?, ?, ?, ?)
          `).run(args.slug, nextYStateVersion, Buffer.from(Y.encodeStateAsUpdate(ydoc)), now);
        }
      }

      const marksJson = JSON.stringify(effectiveNextMarks);
      const accessEpochDelta = shouldBumpAccessEpoch ? 1 : 0;
      let result;
      if (typeof args.baseRevision === 'number') {
        result = getDb().prepare(`
          UPDATE documents
          SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1, y_state_version = ?,
              access_epoch = access_epoch + ?
          WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')
        `).run(sanitizedMarkdown, marksJson, now, nextYStateVersion, accessEpochDelta, args.slug, args.baseRevision);
      } else if (typeof args.baseUpdatedAt === 'string' && args.baseUpdatedAt.trim()) {
        result = getDb().prepare(`
          UPDATE documents
          SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1, y_state_version = ?,
              access_epoch = access_epoch + ?
          WHERE slug = ? AND updated_at = ? AND share_state IN ('ACTIVE', 'PAUSED')
        `).run(sanitizedMarkdown, marksJson, now, nextYStateVersion, accessEpochDelta, args.slug, args.baseUpdatedAt);
      } else {
        result = getDb().prepare(`
          UPDATE documents
          SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1, y_state_version = ?,
              access_epoch = access_epoch + ?
          WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
        `).run(sanitizedMarkdown, marksJson, now, nextYStateVersion, accessEpochDelta, args.slug);
      }
      if (result.changes === 0) {
        throw new Error('STALE_BASE');
      }
      persistCanonicalProjectionRow(args.slug, sanitizedMarkdown, effectiveNextMarks, nextRevision, nextYStateVersion, now);
    });
    tx();

    const updated = getDocumentBySlug(args.slug);
    if (!updated) {
      throw new Error('UPDATED_DOCUMENT_MISSING');
    }

    registerCanonicalYDocPersistence(args.slug, ydoc, {
      updatedAt: updated.updated_at,
      yStateVersion: updated.y_state_version,
      accessEpoch: typeof updated.access_epoch === 'number' ? updated.access_epoch : null,
    });

    const expectedFragmentHash = hashText(normalizeFragmentPlainText(parsedNext.doc.textContent ?? ''));
    const liveMarkdown = stripEphemeralCollabSpans(ydoc.getText('markdown').toString());
    const liveFragmentHash = getFragmentTextHashFromDoc(ydoc, parser.schema);
    if (liveMarkdown !== sanitizedMarkdown || (liveFragmentHash !== null && liveFragmentHash !== expectedFragmentHash)) {
      getDb().prepare(`
        UPDATE document_projections
        SET health = 'quarantined'
        WHERE document_slug = ?
      `).run(args.slug);
      invalidateCollabDocument(args.slug);
      return {
        ok: false,
        status: 409,
        code: 'FRAGMENT_DIVERGENCE',
        error: 'Canonical fragment verification failed after mutation',
        retryWithState: `/api/agent/${args.slug}/state`,
      };
    }

    await rebuildDocumentBlocks(updated, sanitizedMarkdown, updated.revision);
    refreshSnapshotForSlug(args.slug);

    return {
      ok: true,
      document: updated,
      yStateVersion: updated.y_state_version,
      activeCollabClients,
    };
  } catch (error) {
    invalidateCollabDocument(args.slug);
    if (error instanceof Error && error.message === 'STALE_BASE') {
      return {
        ok: false,
        status: 409,
        code: 'STALE_BASE',
        error: 'Document changed during canonical mutation; retry with latest state',
        retryWithState: `/api/agent/${args.slug}/state`,
      };
    }
    return {
      ok: false,
      status: 500,
      code: 'CANONICAL_PERSIST_FAILED',
      error: error instanceof Error ? error.message : 'Failed to persist canonical mutation',
    };
  } finally {
    await handle.cleanup?.();
  }
}

export async function executeCanonicalRewrite(
  slug: string,
  body: Record<string, unknown>,
): Promise<CanonicalRouteResult> {
  const doc = getDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found', code: 'NOT_FOUND' } };
  }

  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const baseUpdatedAt = typeof body.baseUpdatedAt === 'string' ? body.baseUpdatedAt.trim() : '';
  const hasBaseUpdatedAt = body.baseUpdatedAt !== undefined;
  const hasBaseRevision = body.baseRevision !== undefined || body.expectedRevision !== undefined;
  const baseRevisionRaw = body.baseRevision ?? body.expectedRevision;
  const baseRevision = Number.isInteger(baseRevisionRaw) ? (baseRevisionRaw as number) : null;
  if (body.baseRevision !== undefined && body.expectedRevision !== undefined && body.baseRevision !== body.expectedRevision) {
    return { status: 400, body: { success: false, error: 'Conflicting baseRevision and expectedRevision' } };
  }
  if (hasBaseRevision && (!Number.isInteger(baseRevisionRaw) || (baseRevisionRaw as number) < 1)) {
    return { status: 400, body: { success: false, error: 'Invalid baseRevision' } };
  }
  if (hasBaseUpdatedAt && !baseUpdatedAt) {
    return { status: 400, body: { success: false, error: 'Invalid baseUpdatedAt' } };
  }

  const hasDirectContent = typeof body.content === 'string';
  const hasChanges = Array.isArray(body.changes);
  if (!hasDirectContent && !hasChanges) {
    return { status: 400, body: { success: false, error: 'Missing content parameter' } };
  }
  if (hasDirectContent && hasChanges) {
    return { status: 400, body: { success: false, error: 'Provide either content or changes, not both' } };
  }
  if (!hasBaseRevision) {
    return {
      status: 400,
      body: {
        success: false,
        error: 'rewrite.apply requires baseRevision (or expectedRevision)',
      },
    };
  }

  let nextMarkdown = hasDirectContent ? String(body.content) : (doc.markdown ?? '');
  if (hasDirectContent && !nextMarkdown.trim()) {
    return {
      status: 400,
      body: {
        success: false,
        error: 'rewrite content must not be empty',
        code: 'EMPTY_MARKDOWN',
      },
    };
  }

  if (hasChanges) {
    const changes = body.changes as unknown[];
    for (const change of changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        return { status: 400, body: { success: false, error: 'Invalid changes payload' } };
      }
      const find = typeof (change as { find?: unknown }).find === 'string' ? (change as { find: string }).find : '';
      const replace = typeof (change as { replace?: unknown }).replace === 'string' ? (change as { replace: string }).replace : '';
      if (!find) {
        return { status: 400, body: { success: false, error: 'Each change requires non-empty find string' } };
      }
      const replaced = replaceFirstOccurrence(nextMarkdown, find, replace);
      if (replaced === null) {
        return { status: 409, body: { success: false, error: 'Change target not found in current markdown', find } };
      }
      nextMarkdown = replaced;
    }
  }

  const nextMarks = hasDirectContent ? stripAuthoredMarks(parseMarks(doc.marks)) : parseMarks(doc.marks);
  const mutation = await mutateCanonicalDocument({
    slug,
    nextMarkdown,
    nextMarks,
    source: `rewrite:${by}`,
    baseRevision,
    baseUpdatedAt: hasBaseUpdatedAt ? baseUpdatedAt : undefined,
    strictLiveDoc: false,
    guardPathologicalGrowth: false,
  });
  if (!mutation.ok) {
    return {
      status: mutation.status,
      body: {
        success: false,
        code: mutation.code,
        error: mutation.error,
        ...(mutation.retryWithState ? { retryWithState: mutation.retryWithState } : {}),
      },
    };
  }

  const eventId = addDocumentEvent(slug, 'document.rewritten', {
    by,
    mode: hasDirectContent ? 'content' : 'changes',
  }, by);
  const updated = mutation.document;
  return {
    status: 200,
    body: {
      success: true,
      eventId,
      content: updated.markdown,
      markdown: updated.markdown,
      updatedAt: updated.updated_at,
      shareState: updated.share_state,
      marks: parseMarks(updated.marks),
    },
  };
}

export async function repairCanonicalProjection(slug: string): Promise<CanonicalRepairResult> {
  const doc = getDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Document not found' };
  }

  const handle = await loadCanonicalYDoc(slug, { liveRequired: false });
  if (!handle) {
    return { ok: false, status: 409, code: 'LIVE_DOC_UNAVAILABLE', error: 'Canonical document is unavailable' };
  }

  try {
    const derived = await deriveProjectionFromCanonicalDoc(handle.ydoc);
    const yStateVersion = getLatestYStateVersion(slug);
    getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, y_state_version = ?
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(derived.markdown, JSON.stringify(derived.marks), yStateVersion, slug);
    persistCanonicalProjectionRow(slug, derived.markdown, derived.marks, doc.revision, yStateVersion, doc.updated_at, 'healthy');
    const updated = getDocumentBySlug(slug);
    if (!updated) {
      return { ok: false, status: 500, code: 'REPAIR_RELOAD_FAILED', error: 'Document missing after projection repair' };
    }
    await rebuildDocumentBlocks(updated, derived.markdown, updated.revision);
    refreshSnapshotForSlug(slug);
    return {
      ok: true,
      document: updated,
      markdown: derived.markdown,
      yStateVersion,
    };
  } catch (error) {
    return {
      ok: false,
      status: 409,
      code: 'CANONICAL_DOC_INVALID',
      error: error instanceof Error ? error.message : 'Failed to derive projection from canonical Yjs state',
    };
  } finally {
    await handle.cleanup?.();
  }
}

export async function cloneFromCanonical(slug: string, actor: string = 'system'): Promise<CanonicalRepairResult & { cloneSlug?: string; ownerSecret?: string }> {
  const repair = await repairCanonicalProjection(slug);
  if (!repair.ok) return repair;

  const sourceDoc = repair.document;
  const projection = getDocumentProjectionBySlug(slug);
  const cloneSlug = `${slug}-repair-${randomUUID().slice(0, 8)}`;
  const ownerSecret = randomUUID();
  const clone = createDocument(
    cloneSlug,
    projection?.markdown ?? repair.markdown,
    parseMarks(projection?.marks_json ?? sourceDoc.marks),
    sourceDoc.title ? `${sourceDoc.title} (Recovered)` : 'Recovered document',
    actor,
    ownerSecret,
  );

  return {
    ok: true,
    document: clone,
    markdown: clone.markdown,
    yStateVersion: clone.y_state_version,
    cloneSlug: clone.slug,
    ownerSecret,
  };
}
