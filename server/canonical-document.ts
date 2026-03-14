import { createHash, randomUUID } from 'crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as ProseMirrorNode, Schema } from '@milkdown/prose/model';
import {
  addDocumentEvent,
  appendYUpdate,
  createDocument,
  getDb,
  getDocumentBySlug,
  getDocumentProjectionBySlug,
  getLatestYSnapshot,
  getLatestYStateVersion,
  getYUpdatesAtOrAfter,
  getYUpdatesAfter,
  replaceDocumentProjection,
  rebuildDocumentBlocks,
  OversizedYjsUpdateError,
  saveYSnapshot,
  type DocumentRow,
} from './db.js';
import {
  maybeFastQuarantineProjectionPathology,
  cloneAuthoritativeDocState,
  detectPathologicalProjectionRepeat,
  evaluateProjectionSafety,
  getCanonicalReadableDocument,
  getCollabQuarantineGateStatus,
  getRecentCollabSessionLeaseCount,
  getLoadedCollabFragmentTextHash,
  getCollabRuntime,
  invalidateCollabDocument,
  isIntegrityWarningQuarantineReason,
  isValidMutationBaseToken,
  isCanonicalReadMutationReady,
  loadCanonicalYDoc,
  noteDocumentIntegrityWarning,
  queueProjectionRepair,
  quarantineOversizedYjsUpdate,
  registerCanonicalYDocPersistence,
  resolveAuthoritativeMutationBase,
  stripEphemeralCollabSpans,
  type CanonicalReadableDocument,
} from './collab.js';
import { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback, serializeMarkdown } from './milkdown-headless.js';
import {
  buildProofSpanReplacementMap,
  stripAllProofSpanTagsWithReplacements,
} from './proof-span-strip.js';
import {
  extractAuthoredMarksFromDoc,
  synchronizeAuthoredMarks,
} from './proof-authored-mark-sync.js';
import { estimateTopLevelBlockCount, summarizeDocumentIntegrity } from './document-integrity.js';
import { recordProjectionRepair } from './metrics.js';
import { isHostedRewriteEnvironment } from './rewrite-policy.js';
import { refreshSnapshotForSlug } from './snapshot.js';
import { pauseDocumentAndPropagate } from './share-state.js';
import { getActiveCollabClientBreakdown, getActiveCollabClientCount } from './ws.js';

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
  baseToken?: string | null;
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

type CanonicalRepairOptions = {
  enforceProjectionGuard?: boolean;
  allowAuthoritativeGrowth?: boolean;
  clearIntegrityQuarantine?: boolean;
};

export type CanonicalRouteResult = {
  status: number;
  body: Record<string, unknown>;
};

const RUNAWAY_BLOCK_GUARD_MAX_TOP_LEVEL_BLOCKS = 10_000;
const RUNAWAY_BLOCK_GUARD_BASELINE_MIN_TOP_LEVEL_BLOCKS = 2_000;
const RUNAWAY_BLOCK_GUARD_GROWTH_MULTIPLIER = 2;
const HOSTED_LIVE_DOC_GRACE_MS = parsePositiveInt(process.env.HOSTED_LIVE_DOC_GRACE_MS, 1500);
const HOSTED_LIVE_DOC_GRACE_POLL_MS = parsePositiveInt(process.env.HOSTED_LIVE_DOC_GRACE_POLL_MS, 100);

type RunawayCanonicalWriteGuardResult = {
  blocked: true;
  reason: 'top_level_blocks_exceeded' | 'top_level_block_growth_exceeded';
  baselineChars: number;
  candidateChars: number;
  baselineTopLevelBlocks: number;
  candidateTopLevelBlocks: number;
} | {
  blocked: false;
};

function evaluateRunawayCanonicalWriteGuard(
  baselineMarkdown: string,
  candidateMarkdown: string,
): RunawayCanonicalWriteGuardResult {
  const baselineTopLevelBlocks = estimateTopLevelBlockCount(baselineMarkdown);
  const candidateTopLevelBlocks = estimateTopLevelBlockCount(candidateMarkdown);
  if (candidateTopLevelBlocks > RUNAWAY_BLOCK_GUARD_MAX_TOP_LEVEL_BLOCKS) {
    return {
      blocked: true,
      reason: 'top_level_blocks_exceeded',
      baselineChars: baselineMarkdown.length,
      candidateChars: candidateMarkdown.length,
      baselineTopLevelBlocks,
      candidateTopLevelBlocks,
    };
  }
  if (
    baselineTopLevelBlocks >= RUNAWAY_BLOCK_GUARD_BASELINE_MIN_TOP_LEVEL_BLOCKS
    && candidateTopLevelBlocks >= (baselineTopLevelBlocks * RUNAWAY_BLOCK_GUARD_GROWTH_MULTIPLIER)
  ) {
    return {
      blocked: true,
      reason: 'top_level_block_growth_exceeded',
      baselineChars: baselineMarkdown.length,
      candidateChars: candidateMarkdown.length,
      baselineTopLevelBlocks,
      candidateTopLevelBlocks,
    };
  }
  return { blocked: false };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function isOnDemandProjectionRepairEnabled(): boolean {
  return parseBooleanFlag(process.env.COLLAB_ON_DEMAND_PROJECTION_REPAIR_ENABLED, false);
}

type ProjectionRecoverySource = 'state' | 'snapshot' | 'share' | 'mutation' | 'edit_v2' | 'unknown';

function shouldRepairPendingProjection(doc: Record<string, unknown> | null | undefined): boolean {
  if (!doc) return false;
  if ('repair_pending' in doc && doc.repair_pending === true) return true;
  return 'projection_fresh' in doc && doc.projection_fresh === false;
}

function shouldDeferOnDemandProjectionRepair(
  slug: string,
  source: ProjectionRecoverySource,
): boolean {
  if (!slug) return false;
  const activeCollabClients = getActiveCollabClientCount(slug);
  const accessEpoch = (() => {
    const doc = getDocumentBySlug(slug);
    return typeof doc?.access_epoch === 'number' ? doc.access_epoch : null;
  })();
  const recentLeases = getRecentCollabSessionLeaseCount(slug, accessEpoch);
  if (activeCollabClients > 0 || recentLeases > 0) {
    recordProjectionRepair('skipped', `on_demand_${source}:live_collab_present`);
    return true;
  }
  return false;
}

async function waitForHostedLiveLeaseMaterialization(
  slug: string,
): Promise<ReturnType<typeof getActiveCollabClientBreakdown>> {
  let breakdown = getActiveCollabClientBreakdown(slug);
  if (breakdown.total === 0 || breakdown.anyEpochCount > 0) return breakdown;

  const deadline = Date.now() + HOSTED_LIVE_DOC_GRACE_MS;
  while (Date.now() < deadline) {
    await delay(HOSTED_LIVE_DOC_GRACE_POLL_MS);
    breakdown = getActiveCollabClientBreakdown(slug);
    if (breakdown.total === 0 || breakdown.anyEpochCount > 0) {
      return breakdown;
    }
  }
  return breakdown;
}

function toCanonicalReadSource(source: ProjectionRecoverySource): 'state' | 'snapshot' | 'share' | 'unknown' {
  if (source === 'snapshot' || source === 'share' || source === 'state') return source;
  return 'state';
}

function isRecoveryMutationReady(doc: Record<string, unknown>): boolean {
  if (!('mutation_ready' in doc)) return true;
  return isCanonicalReadMutationReady(doc);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneYDocWithHistory(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}

function stableSortValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => stableSortValue(entry));
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = stableSortValue(entryValue);
  }
  return sorted;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value));
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
  const updates = snapshot
    ? getYUpdatesAtOrAfter(doc.slug, snapshot.version)
    : getYUpdatesAfter(doc.slug, 0);
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
    // Use the original doc's state vector (not a clone's) so that delta computation
    // correctly identifies only the new operations. Cloning creates a fresh client ID
    // which causes encodeStateAsUpdate to treat all content as new inserts, leading to
    // content duplication when the delta is applied on top of the original snapshot.
    stateVector: Y.encodeStateVector(ydoc),
    yStateVersion: getLatestYStateVersion(doc.slug),
  };
}

type PersistedCanonicalMutationPreview = {
  markdown: string;
  marks: Record<string, unknown>;
  markdownMatches: boolean;
  marksMatch: boolean;
  safety: ReturnType<typeof evaluateProjectionSafety>;
};

function previewPersistedCanonicalMutation(
  previewDoc: Y.Doc,
  expectedMarkdown: string,
  expectedMarks: Record<string, unknown>,
): PersistedCanonicalMutationPreview {
  const markdown = stripEphemeralCollabSpans(previewDoc.getText('markdown').toString());
  const marks = encodeMarksMap(previewDoc.getMap('marks'));
  return {
    markdown,
    marks,
    markdownMatches: markdown === expectedMarkdown,
    marksMatch: stableStringify(marks) === stableStringify(expectedMarks),
    safety: evaluateProjectionSafety(expectedMarkdown, markdown, previewDoc),
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

function canonicalTransactionOrigin(source: string): string {
  const normalized = typeof source === 'string' && source.trim() ? source.trim() : 'unknown';
  return `canonical-${normalized}`;
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
  healthReason: string | null = null,
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
      health,
      health_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_slug) DO UPDATE SET
      revision = excluded.revision,
      y_state_version = excluded.y_state_version,
      markdown = excluded.markdown,
      marks_json = excluded.marks_json,
      plain_text = excluded.plain_text,
      updated_at = excluded.updated_at,
      health = excluded.health,
      health_reason = excluded.health_reason
  `).run(
    slug,
    revision,
    yStateVersion,
    markdown,
    JSON.stringify(marks),
    normalizeProjectionPlainText(markdown),
    updatedAt,
    health,
    health === 'quarantined' ? healthReason : null,
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

  const baseToken = typeof args.baseToken === 'string' && args.baseToken.trim()
    ? args.baseToken.trim()
    : null;
  if (baseToken && (typeof args.baseRevision === 'number' || (typeof args.baseUpdatedAt === 'string' && args.baseUpdatedAt.trim()))) {
    return {
      ok: false,
      status: 409,
      code: 'CONFLICTING_BASE',
      error: 'baseToken cannot be combined with baseRevision or baseUpdatedAt',
    };
  }
  if (baseToken && !isValidMutationBaseToken(baseToken)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_BASE_TOKEN',
      error: 'baseToken must be an mt1 token',
    };
  }

  if (!baseToken && typeof args.baseRevision === 'number' && doc.revision !== args.baseRevision) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseRevision',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }
  if (!baseToken && typeof args.baseUpdatedAt === 'string' && args.baseUpdatedAt.trim() && doc.updated_at !== args.baseUpdatedAt) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseUpdatedAt',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }

  const sanitizedMarkdown = stripEphemeralCollabSpans(args.nextMarkdown ?? '');
  const hasExplicitNextMarks = args.nextMarks !== undefined;
  const nextMarks = hasExplicitNextMarks ? args.nextMarks : {};
  const collabRuntimeEnabled = getCollabRuntime().enabled;
  let collabClientBreakdown = getActiveCollabClientBreakdown(args.slug);
  const hostedRuntime = isHostedRewriteEnvironment();
  const strictLiveDocRequested = args.strictLiveDoc !== false;
  if (
    strictLiveDocRequested
    && collabRuntimeEnabled
    && hostedRuntime
    && collabClientBreakdown.total > 0
    && collabClientBreakdown.anyEpochCount === 0
  ) {
    collabClientBreakdown = await waitForHostedLiveLeaseMaterialization(args.slug);
  }
  let activeCollabClients = strictLiveDocRequested
    ? collabClientBreakdown.total
    : collabClientBreakdown.anyEpochCount;
  if (strictLiveDocRequested && activeCollabClients > 0 && !collabRuntimeEnabled) {
    return {
      ok: false,
      status: 409,
      code: 'LIVE_DOC_UNAVAILABLE',
      error: 'Live canonical document is unavailable on this hosted replica; retry after refreshing state',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }
  const hostedRemoteLiveLease = collabRuntimeEnabled
    && hostedRuntime
    && collabClientBreakdown.total > 0
    && collabClientBreakdown.anyEpochCount === 0;
  if (strictLiveDocRequested && hostedRemoteLiveLease) {
    return {
      ok: false,
      status: 409,
      code: 'LIVE_DOC_UNAVAILABLE',
      error: 'Live canonical document is unavailable on this hosted replica; retry after refreshing state',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }
  let liveRequired = strictLiveDocRequested && activeCollabClients > 0;
  const shouldBumpAccessEpoch = collabRuntimeEnabled
    && strictLiveDocRequested
    && activeCollabClients === 0;
  let initialBaseResolution = await resolveAuthoritativeMutationBase(args.slug, {
    liveRequired,
    preferProjection: false,
  });
  if (!initialBaseResolution.ok && liveRequired && hostedRuntime) {
    collabClientBreakdown = await waitForHostedLiveLeaseMaterialization(args.slug);
    activeCollabClients = strictLiveDocRequested
      ? collabClientBreakdown.total
      : collabClientBreakdown.anyEpochCount;
    liveRequired = strictLiveDocRequested && activeCollabClients > 0;
    initialBaseResolution = await resolveAuthoritativeMutationBase(args.slug, {
      liveRequired,
      preferProjection: false,
    });
  }
  if (!initialBaseResolution.ok) {
    return initialBaseResolution.reason === 'missing_document'
      ? { ok: false, status: 404, code: 'NOT_FOUND', error: 'Document not found' }
      : {
          ok: false,
          status: 409,
          code: 'LIVE_DOC_UNAVAILABLE',
          error: 'Live canonical document is unavailable; retry after refreshing state',
          retryWithState: `/api/agent/${args.slug}/state`,
        };
  }
  if (baseToken && initialBaseResolution.base.token !== baseToken) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseToken',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }
  let handle = await loadCanonicalYDoc(args.slug, { liveRequired });
  if (!handle && liveRequired && hostedRuntime) {
    collabClientBreakdown = await waitForHostedLiveLeaseMaterialization(args.slug);
    activeCollabClients = strictLiveDocRequested
      ? collabClientBreakdown.total
      : collabClientBreakdown.anyEpochCount;
    liveRequired = strictLiveDocRequested && activeCollabClients > 0;
    handle = await loadCanonicalYDoc(args.slug, { liveRequired });
  }
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
  const authoritativeNextMarkdown = stripEphemeralCollabSpans(await serializeMarkdown(parsedNext.doc));

  let authoritativeMarkdown = stripEphemeralCollabSpans(initialBaseResolution.base.markdown);
  let authoritativeMarks = stripAuthoredMarks(initialBaseResolution.base.marks);
  const persistedState = await buildPersistedCanonicalState(doc);
  const ydoc = handle.ydoc;
  const currentMutationBase = initialBaseResolution.base;
  if (baseToken && currentMutationBase.token !== baseToken) {
    await handle.cleanup?.();
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseToken',
      retryWithState: `/api/agent/${args.slug}/state`,
    };
  }
  const nextMarksBase = hasExplicitNextMarks ? nextMarks : authoritativeMarks;
  const authoredMarks = extractAuthoredMarksFromDoc(parsedNext.doc as ProseMirrorNode, parser.schema as Schema);
  const effectiveNextMarks = synchronizeAuthoredMarks(nextMarksBase, authoredMarks);

  try {
    if (liveRequired && currentMutationBase.source !== 'live_yjs') {
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
        buildProofSpanReplacementMap(authoritativeMarks as any),
      );
      const guardCandidateMarkdown = stripAllProofSpanTagsWithReplacements(
        authoritativeNextMarkdown,
        buildProofSpanReplacementMap(effectiveNextMarks as any),
      );
      const runawayGuard = evaluateRunawayCanonicalWriteGuard(guardBaselineMarkdown, guardCandidateMarkdown);
      if (runawayGuard.blocked) {
        pauseDocumentAndPropagate(args.slug, args.source);
        console.error('[canonical] blocked runaway canonical write and paused document', {
          slug: args.slug,
          source: args.source,
          reason: runawayGuard.reason,
          baselineChars: runawayGuard.baselineChars,
          candidateChars: runawayGuard.candidateChars,
          baselineTopLevelBlocks: runawayGuard.baselineTopLevelBlocks,
          candidateTopLevelBlocks: runawayGuard.candidateTopLevelBlocks,
        });
        return {
          ok: false,
          status: 422,
          code: 'PATHOLOGICAL_GROWTH_BLOCKED',
          error: 'Mutation blocked by runaway canonical write guard; document paused for containment',
        };
      }
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

      // Structural duplication guard: block mutations that introduce both
      // new repeated headings and repeated section signatures combined with
      // significant block count growth. This catches replayed section blow-up
      // without rejecting legitimate large documents that intentionally reuse
      // headings like "Notes" with different bodies.
      const baselineIntegrity = summarizeDocumentIntegrity(guardBaselineMarkdown);
      const candidateIntegrity = summarizeDocumentIntegrity(guardCandidateMarkdown);
      if (
        candidateIntegrity.repeatedHeadings.length > 0
        && candidateIntegrity.repeatedSectionSignatures.length > 0
      ) {
        const baselineRepeatedSet = new Set(baselineIntegrity.repeatedHeadings);
        const newRepeatedHeadings = candidateIntegrity.repeatedHeadings.filter(
          (h) => !baselineRepeatedSet.has(h),
        );
        const baselineRepeatedSectionSet = new Set(baselineIntegrity.repeatedSectionSignatures);
        const newRepeatedSectionSignatures = candidateIntegrity.repeatedSectionSignatures.filter(
          (signature) => !baselineRepeatedSectionSet.has(signature),
        );
        if (
          newRepeatedHeadings.length > 0
          && newRepeatedSectionSignatures.length > 0
          && candidateIntegrity.topLevelBlockCount > baselineIntegrity.topLevelBlockCount + 50
        ) {
          console.error('[canonical] blocked structural heading duplication', {
            slug: args.slug,
            source: args.source,
            newRepeatedHeadings,
            newRepeatedSectionSignatures,
            baselineBlocks: baselineIntegrity.topLevelBlockCount,
            candidateBlocks: candidateIntegrity.topLevelBlockCount,
          });
          return {
            ok: false,
            status: 422,
            code: 'PATHOLOGICAL_GROWTH_BLOCKED',
            error: 'Mutation blocked by structural heading duplication guard',
          };
        }
      }
    }

    const persistedCandidateDoc = cloneYDocWithHistory(persistedState.ydoc);
    persistedCandidateDoc.transact(() => {
      replaceYXmlFragment(persistedCandidateDoc.getXmlFragment('prosemirror'), parsedNext.doc);
      applyYTextDiff(persistedCandidateDoc.getText('markdown'), authoritativeNextMarkdown);
      applyMarksMapDiff(persistedCandidateDoc.getMap('marks'), effectiveNextMarks);
    }, canonicalTransactionOrigin(args.source));

    const deltaUpdate = Y.encodeStateAsUpdate(
      persistedCandidateDoc,
      Y.encodeStateVector(persistedState.ydoc),
    );
    if (deltaUpdate.byteLength > 0) {
      const persistedPreview = previewPersistedCanonicalMutation(
        persistedCandidateDoc,
        authoritativeNextMarkdown,
        effectiveNextMarks,
      );
      if (!(persistedPreview.markdownMatches && persistedPreview.marksMatch)) {
        const previewDetails = {
          source: args.source,
          liveSource: handle.source,
          mutationBaseSource: currentMutationBase.source,
          expectedChars: authoritativeNextMarkdown.length,
          previewChars: persistedPreview.markdown.length,
          markdownMatches: persistedPreview.markdownMatches,
          marksMatch: persistedPreview.marksMatch,
          guardReason: persistedPreview.safety.reason ?? null,
          safetyDetails: persistedPreview.safety.details ?? null,
        };
        console.warn('[canonical] blocked unsafe persisted Yjs append from canonical mutation preview', {
          slug: args.slug,
          ...previewDetails,
        });
        if (!persistedPreview.safety.safe) {
          maybeFastQuarantineProjectionPathology(args.slug, {
            source: 'persist',
            guardReason: persistedPreview.safety.reason ?? 'unsafe_projection',
            details: persistedPreview.safety.details,
            extras: {
              sourceActor: args.source,
              stage: 'canonical_mutation_preview',
              expectedChars: authoritativeNextMarkdown.length,
              previewChars: persistedPreview.markdown.length,
              liveSource: handle.source,
              mutationBaseSource: currentMutationBase.source,
            },
          });
        } else {
          queueProjectionRepair(args.slug, 'canonical_mutation_persist_preview_mismatch');
          invalidateCollabDocument(args.slug);
        }
        return {
          ok: false,
          status: 409,
          code: 'PERSISTED_YJS_DIVERGED',
          error: 'Persisted collaborative state diverged from the canonical mutation; durable append was blocked for safety',
          retryWithState: `/api/agent/${args.slug}/state`,
        };
      }
    }
    const compactionInterval = parsePositiveInt(process.env.COLLAB_COMPACTION_EVERY, 100);
    const now = new Date().toISOString();
    let nextRevision = doc.revision + 1;
    let nextYStateVersion = Math.max(doc.y_state_version, persistedState.yStateVersion);

    ydoc.transact(() => {
      replaceYXmlFragment(ydoc.getXmlFragment('prosemirror'), parsedNext.doc);
      applyYTextDiff(ydoc.getText('markdown'), authoritativeNextMarkdown);
      applyMarksMapDiff(ydoc.getMap('marks'), effectiveNextMarks);
    }, canonicalTransactionOrigin(args.source));

    const tx = getDb().transaction(() => {
      if (deltaUpdate.byteLength > 0) {
        nextYStateVersion = appendYUpdate(args.slug, deltaUpdate, args.source);
        const latestSnapshot = getLatestYSnapshot(args.slug);
        const updatesSinceSnapshot = latestSnapshot ? (nextYStateVersion - latestSnapshot.version) : nextYStateVersion;
        if (updatesSinceSnapshot >= compactionInterval) {
          getDb().prepare(`
            INSERT OR REPLACE INTO document_y_snapshots (document_slug, version, snapshot_blob, created_at)
            VALUES (?, ?, ?, ?)
          `).run(args.slug, nextYStateVersion, Buffer.from(Y.encodeStateAsUpdate(persistedCandidateDoc)), now);
        }
      }

      const marksJson = JSON.stringify(effectiveNextMarks);
      const accessEpochDelta = shouldBumpAccessEpoch ? 1 : 0;
      const result = getDb().prepare(`
        UPDATE documents
        SET markdown = ?, marks = ?, updated_at = ?, revision = revision + 1, y_state_version = ?,
            access_epoch = access_epoch + ?
        WHERE slug = ? AND revision = ? AND share_state IN ('ACTIVE', 'PAUSED')
      `).run(authoritativeNextMarkdown, marksJson, now, nextYStateVersion, accessEpochDelta, args.slug, doc.revision);
      if (result.changes === 0) {
        throw new Error('STALE_BASE');
      }
      persistCanonicalProjectionRow(args.slug, authoritativeNextMarkdown, effectiveNextMarks, nextRevision, nextYStateVersion, now);
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
    if (liveMarkdown !== authoritativeNextMarkdown || (liveFragmentHash !== null && liveFragmentHash !== expectedFragmentHash)) {
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

    await rebuildDocumentBlocks(updated, authoritativeNextMarkdown, updated.revision);
    noteDocumentIntegrityWarning(args.slug, {
      actor: args.source,
      revision: updated.revision,
      integrity: summarizeDocumentIntegrity(updated.markdown),
      source: args.source,
    });
    refreshSnapshotForSlug(args.slug);

    return {
      ok: true,
      document: updated,
      yStateVersion: updated.y_state_version,
      activeCollabClients,
    };
  } catch (error) {
    if (error instanceof OversizedYjsUpdateError) {
      quarantineOversizedYjsUpdate(args.slug, {
        bytes: error.bytes,
        limitBytes: error.limitBytes,
        source: 'canonical_mutation',
        sourceActor: error.sourceActor,
      });
      invalidateCollabDocument(args.slug);
      return {
        ok: false,
        status: 500,
        code: 'CANONICAL_PERSIST_FAILED',
        error: 'Oversized Yjs update blocked during canonical mutation',
      };
    }
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

export async function recoverCanonicalDocumentIfNeeded(
  slug: string,
  source: ProjectionRecoverySource = 'unknown',
): Promise<CanonicalReadableDocument | DocumentRow | undefined> {
  const readSource = toCanonicalReadSource(source);
  const current = await getCanonicalReadableDocument(slug, readSource) ?? getDocumentBySlug(slug);
  if (!current || !shouldRepairPendingProjection(current as unknown as Record<string, unknown>)) {
    return current;
  }
  if (getCollabQuarantineGateStatus(slug).active) {
    return current;
  }

  const reason = `on_demand_${source}`;
  if (!isOnDemandProjectionRepairEnabled()) {
    return current;
  }
  if (shouldDeferOnDemandProjectionRepair(slug, source)) {
    return current;
  }

  const repair = await repairCanonicalProjection(slug, { enforceProjectionGuard: true });
  if (repair.ok) {
    recordProjectionRepair('success', reason);
    const repairedProjection = getDocumentProjectionBySlug(slug);
    if (
      repairedProjection
      && repairedProjection.health === 'healthy'
      && repairedProjection.y_state_version === repair.document.y_state_version
    ) {
      return {
        ...repair.document,
        markdown: repairedProjection.markdown,
        marks: repairedProjection.marks_json,
        plain_text: repairedProjection.plain_text,
        projection_health: repairedProjection.health,
        projection_revision: repairedProjection.revision,
        projection_y_state_version: repairedProjection.y_state_version,
        projection_updated_at: repairedProjection.updated_at,
        projection_fresh: true,
        mutation_ready: true,
        repair_pending: false,
        read_source: 'projection',
      };
    }
    return await getCanonicalReadableDocument(slug, readSource) ?? repair.document;
  }

  recordProjectionRepair('failure', `${reason}:${repair.code}`);
  queueProjectionRepair(slug, reason);
  const fallback = await getCanonicalReadableDocument(slug, readSource) ?? getDocumentBySlug(slug);
  if (
    fallback
    && shouldRepairPendingProjection(fallback as unknown as Record<string, unknown>)
    && isRecoveryMutationReady(fallback as unknown as Record<string, unknown>)
  ) {
    return fallback;
  }
  return current;
}

export async function executeCanonicalRewrite(
  slug: string,
  body: Record<string, unknown>,
  options?: { idempotencyKey?: string; idempotencyRoute?: string },
): Promise<CanonicalRouteResult> {
  const doc = getDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { status: 404, body: { success: false, error: 'Document not found', code: 'NOT_FOUND' } };
  }

  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'ai:unknown';
  const baseToken = typeof body.baseToken === 'string' ? body.baseToken.trim() : '';
  const hasBaseToken = body.baseToken !== undefined;
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
  if (hasBaseToken && !baseToken) {
    return { status: 400, body: { success: false, error: 'Invalid baseToken', code: 'INVALID_BASE_TOKEN' } };
  }
  if (baseToken && (hasBaseRevision || hasBaseUpdatedAt)) {
    return {
      status: 409,
      body: {
        success: false,
        error: 'baseToken cannot be combined with baseRevision or baseUpdatedAt',
        code: 'CONFLICTING_BASE',
      },
    };
  }

  const hasDirectContent = typeof body.content === 'string';
  const hasChanges = Array.isArray(body.changes);
  if (!hasDirectContent && !hasChanges) {
    return { status: 400, body: { success: false, error: 'Missing content parameter' } };
  }
  if (hasDirectContent && hasChanges) {
    return { status: 400, body: { success: false, error: 'Provide either content or changes, not both' } };
  }
  if (!baseToken && !hasBaseRevision) {
    return {
      status: 400,
      body: {
        success: false,
        error: 'rewrite.apply requires baseToken or baseRevision (or expectedRevision)',
      },
    };
  }

  const authoritativeBase = await resolveAuthoritativeMutationBase(slug, { liveRequired: false });
  const currentMarkdown = authoritativeBase.ok ? authoritativeBase.base.markdown : (doc.markdown ?? '');
  let nextMarkdown = hasDirectContent ? String(body.content) : currentMarkdown;
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

  const currentMarks = authoritativeBase.ok ? authoritativeBase.base.marks : parseMarks(doc.marks);
  const nextMarks = hasDirectContent ? stripAuthoredMarks(currentMarks) : currentMarks;
  const mutation = await mutateCanonicalDocument({
    slug,
    nextMarkdown,
    nextMarks,
    source: `rewrite:${by}`,
    ...(baseToken
      ? { baseToken }
      : {
          baseRevision,
          baseUpdatedAt: hasBaseUpdatedAt ? baseUpdatedAt : undefined,
        }),
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
  }, by, options?.idempotencyKey, options?.idempotencyRoute);
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

export async function repairCanonicalProjection(
  slug: string,
  options?: CanonicalRepairOptions,
): Promise<CanonicalRepairResult> {
  const doc = getDocumentBySlug(slug);
  if (!doc || doc.share_state === 'DELETED') {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Document not found' };
  }

  let handle: Awaited<ReturnType<typeof loadCanonicalYDoc>>;
  try {
    handle = await loadCanonicalYDoc(slug, { liveRequired: false });
  } catch (error) {
    return {
      ok: false,
      status: 409,
      code: 'CANONICAL_DOC_INVALID',
      error: error instanceof Error ? error.message : 'Failed to load canonical Yjs state',
    };
  }
  if (!handle) {
    return { ok: false, status: 409, code: 'LIVE_DOC_UNAVAILABLE', error: 'Canonical document is unavailable' };
  }

  try {
    const projectionBeforeRepair = getDocumentProjectionBySlug(slug);
    const preservedIntegrityReason = (
      projectionBeforeRepair?.health === 'quarantined'
      && isIntegrityWarningQuarantineReason(projectionBeforeRepair.health_reason)
      && options?.clearIntegrityQuarantine !== true
    )
      ? projectionBeforeRepair.health_reason
      : null;
    const derived = await deriveProjectionFromCanonicalDoc(handle.ydoc);
    const enforceProjectionGuard = options?.enforceProjectionGuard !== false;
    if (enforceProjectionGuard) {
      const safety = evaluateProjectionSafety(stripEphemeralCollabSpans(doc.markdown ?? ''), derived.markdown, handle.ydoc);
      if (!safety.safe) {
        const allowGrowth =
          options?.allowAuthoritativeGrowth === true
          && (safety.reason === 'max_chars_exceeded' || safety.reason === 'growth_multiplier_exceeded');
        if (allowGrowth) {
          // Explicit owner/operator repair may need to rebuild a short stale row from a large
          // authoritative Yjs snapshot. Keep replay/drift guards on, but allow this recovery lane.
        } else {
        console.error('[canonical] projection repair blocked by guardrail', {
          slug,
          reason: safety.reason,
          details: safety.details,
        });
        return {
          ok: false,
          status: 409,
          code: 'REPAIR_GUARD_BLOCKED',
          error: 'Projection repair blocked by guardrail',
        };
        }
      }
    }
    const yStateVersion = getLatestYStateVersion(slug);
    const replaced = replaceDocumentProjection(slug, derived.markdown, derived.marks, yStateVersion);
    if (!replaced) {
      return { ok: false, status: 500, code: 'REPAIR_RELOAD_FAILED', error: 'Projection missing after projection repair' };
    }
    persistCanonicalProjectionRow(
      slug,
      derived.markdown,
      derived.marks,
      doc.revision,
      yStateVersion,
      doc.updated_at,
      preservedIntegrityReason ? 'quarantined' : 'healthy',
      preservedIntegrityReason,
    );
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
  const repair = await repairCanonicalProjection(slug, {
    enforceProjectionGuard: true,
    allowAuthoritativeGrowth: true,
  });
  if (!repair.ok) return repair;

  const sourceDoc = repair.document;
  const handle = await loadCanonicalYDoc(slug, { liveRequired: false });
  if (!handle) {
    return {
      ok: false,
      status: 409,
      code: 'LIVE_DOC_UNAVAILABLE',
      error: 'Canonical document is unavailable',
    };
  }
  const cloneSlug = `${slug}-repair-${randomUUID().slice(0, 8)}`;
  const ownerSecret = randomUUID();
  try {
    const authoritativeDoc = cloneAuthoritativeDocState(handle.ydoc);
    const authoritativeSnapshot = Y.encodeStateAsUpdate(authoritativeDoc);
    const clone = createDocument(
      cloneSlug,
      repair.markdown,
      parseMarks(sourceDoc.marks),
      sourceDoc.title ? `${sourceDoc.title} (Recovered)` : 'Recovered document',
      actor,
      ownerSecret,
    );

    const nextYStateVersion = authoritativeSnapshot.byteLength > 0 ? 1 : 0;
    if (authoritativeSnapshot.byteLength > 0) {
      saveYSnapshot(cloneSlug, nextYStateVersion, authoritativeSnapshot);
    }
    getDb().prepare(`
      UPDATE documents
      SET markdown = ?, marks = ?, y_state_version = ?
      WHERE slug = ? AND share_state IN ('ACTIVE', 'PAUSED')
    `).run(repair.markdown, JSON.stringify(parseMarks(sourceDoc.marks)), nextYStateVersion, cloneSlug);
    persistCanonicalProjectionRow(
      cloneSlug,
      repair.markdown,
      parseMarks(sourceDoc.marks),
      clone.revision,
      nextYStateVersion,
      clone.updated_at,
      'healthy',
    );
    const updatedClone = getDocumentBySlug(cloneSlug);
    if (!updatedClone) {
      return {
        ok: false,
        status: 500,
        code: 'CLONE_RELOAD_FAILED',
        error: 'Recovered clone missing after binary clone write',
      };
    }
    await rebuildDocumentBlocks(updatedClone, repair.markdown, updatedClone.revision);
    refreshSnapshotForSlug(cloneSlug);
    return {
      ok: true,
      document: updatedClone,
      markdown: updatedClone.markdown,
      yStateVersion: updatedClone.y_state_version,
      cloneSlug: updatedClone.slug,
      ownerSecret,
    };
  } finally {
    await handle.cleanup?.();
  }
}
