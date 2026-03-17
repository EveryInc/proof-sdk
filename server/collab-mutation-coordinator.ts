import { getDocumentBySlug, type DocumentRow } from './db.js';
import { mutateCanonicalDocument } from './canonical-document.js';
import {
  getLoadedCollabFragmentTextHash,
  getLoadedCollabMarkdownForVerification,
  getLoadedCollabMarkdownFromFragment,
  getRecentCollabSessionLeaseCount,
  queueProjectionRepair,
  stripEphemeralCollabSpans,
  verifyCanonicalDocumentInLoadedCollab,
  verifyAuthoritativeMutationBaseStable,
  type CollabApplyVerificationResult,
  type MutationBaseSource,
} from './collab.js';

function parseEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMarkdownForVerification(markdown: string): string {
  return stripEphemeralCollabSpans(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/g, '');
}

async function verifyLoadedCollabMarkdownStable(
  slug: string,
  expectedMarkdown: string,
  stabilityMs: number,
  stabilitySampleMs: number,
): Promise<boolean> {
  if (stabilityMs <= 0) return true;
  const expectedSanitized = normalizeMarkdownForVerification(expectedMarkdown);
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, stabilitySampleMs);
  while (Date.now() <= deadline) {
    const currentSample = await getLoadedCollabMarkdownForVerification(slug);
    const current = currentSample.markdown;
    if (current === null) return true;
    const sanitizedCurrent = normalizeMarkdownForVerification(current);
    if (sanitizedCurrent !== expectedSanitized) {
      const derived = await getLoadedCollabMarkdownFromFragment(slug);
      const sanitizedDerived = derived === null ? null : normalizeMarkdownForVerification(derived);
      if (sanitizedDerived === null || sanitizedDerived !== expectedSanitized) return false;
    }
    await sleep(sampleMs);
  }
  return true;
}

async function verifyLoadedCollabFragmentStable(
  slug: string,
  expectedFragmentTextHash: string,
  stabilityMs: number,
  stabilitySampleMs: number,
): Promise<boolean> {
  if (stabilityMs <= 0) return true;
  const deadline = Date.now() + stabilityMs;
  const sampleMs = Math.max(25, stabilitySampleMs);
  while (Date.now() <= deadline) {
    const current = await getLoadedCollabFragmentTextHash(slug);
    if (current !== null && current !== expectedFragmentTextHash) return false;
    await sleep(sampleMs);
  }
  return true;
}

export function isSingleWriterEditEnabled(): boolean {
  return parseEnabled(process.env.COLLAB_SINGLE_WRITER_EDIT);
}

export type SingleWriterMutationPrecondition =
  | { mode: 'token'; value: string }
  | { mode: 'updatedAt'; value: string }
  | { mode: 'revision'; value: number }
  | { mode: 'none' };

export type SingleWriterMutationRequest = {
  slug: string;
  markdown: string;
  marks: Record<string, unknown>;
  source: string;
  timeoutMs: number;
  stabilityMs?: number;
  stabilitySampleMs?: number;
  precondition?: SingleWriterMutationPrecondition;
  strictLiveDoc?: boolean;
  activeCollabClients?: number;
  guardPathologicalGrowth?: boolean;
};

export type SingleWriterMutationPolicyResult = {
  reason: string;
  renderConfirmed: boolean;
  queueProjectionRepair: boolean;
};

export type SingleWriterMutationFailureCode =
  | 'missing_document'
  | 'stale_base'
  | 'live_doc_unavailable'
  | 'persisted_yjs_corrupt'
  | 'persisted_yjs_diverged'
  | 'sync_pending'
  | 'apply_failed';

export type SingleWriterMutationFailure = {
  ok: false;
  code: SingleWriterMutationFailureCode;
  reason: string;
  latestUpdatedAt?: string | null;
  latestRevision?: number | null;
  document?: DocumentRow;
  verification?: CollabApplyVerificationResult;
  policy?: SingleWriterMutationPolicyResult;
};

export type SingleWriterMutationSuccess = {
  ok: true;
  document: DocumentRow;
  verification: CollabApplyVerificationResult;
  policy: SingleWriterMutationPolicyResult;
  commitId: string;
};

export type SingleWriterMutationResult =
  | SingleWriterMutationSuccess
  | SingleWriterMutationFailure;

const mutationQueues = new Map<string, Promise<void>>();

function preconditionMatches(doc: DocumentRow, precondition: SingleWriterMutationPrecondition): boolean {
  if (precondition.mode === 'none') return true;
  if (precondition.mode === 'token') return true;
  if (precondition.mode === 'updatedAt') return doc.updated_at === precondition.value;
  return doc.revision === precondition.value;
}

function evaluateSingleWriterConvergencePolicy(input: {
  reason?: string;
  collabConfirmed: boolean;
  markdownConfirmed: boolean;
  fragmentConfirmed: boolean;
  authoritativeConfirmed: boolean;
  authoritativeReason?: string;
  authoritativeSource: MutationBaseSource | null;
  activeCollabClients: number;
  strictLiveDoc: boolean;
}): SingleWriterMutationPolicyResult {
  const reason = input.reason ?? 'sync_timeout';
  if (reason === 'no_live_doc' && input.strictLiveDoc && input.activeCollabClients > 0) {
    return {
      reason: 'live_doc_unavailable',
      renderConfirmed: false,
      queueProjectionRepair: false,
    };
  }

  if (!input.authoritativeConfirmed) {
    return {
      reason: input.authoritativeReason ?? 'authoritative_read_mismatch',
      renderConfirmed: false,
      queueProjectionRepair: false,
    };
  }

  if (input.collabConfirmed || (
    reason === 'no_live_doc'
    && !input.strictLiveDoc
    && input.activeCollabClients === 0
  )) {
    return {
      reason,
      renderConfirmed: true,
      queueProjectionRepair: input.authoritativeSource === 'live_yjs' || input.authoritativeSource === 'persisted_yjs',
    };
  }

  return {
    reason,
    renderConfirmed: false,
    queueProjectionRepair: false,
  };
}

function shouldQueueProjectionRepairAfterMutation(
  slug: string,
  activeCollabClients: number,
): boolean {
  if (activeCollabClients > 0) return false;
  const doc = getDocumentBySlug(slug);
  const accessEpoch = typeof doc?.access_epoch === 'number' ? doc.access_epoch : null;
  return getRecentCollabSessionLeaseCount(slug, accessEpoch) === 0;
}

async function withSlugQueue<T>(slug: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(slug) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueues.set(slug, previous.catch(() => undefined).then(() => current));

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (mutationQueues.get(slug) === current) {
      mutationQueues.delete(slug);
    }
  }
}

export async function applySingleWriterMutation(
  request: SingleWriterMutationRequest,
): Promise<SingleWriterMutationResult> {
  const {
    slug,
    markdown,
    marks,
    source,
    timeoutMs,
    stabilityMs = 0,
    stabilitySampleMs = 100,
    precondition = { mode: 'none' },
    strictLiveDoc = true,
    activeCollabClients = 0,
    guardPathologicalGrowth = true,
  } = request;

  return withSlugQueue(slug, async () => {
    const doc = getDocumentBySlug(slug);
    if (!doc) {
      return {
        ok: false,
        code: 'missing_document',
        reason: 'missing_document',
      } satisfies SingleWriterMutationFailure;
    }

    if (!preconditionMatches(doc, precondition)) {
      return {
        ok: false,
        code: 'stale_base',
        reason: 'stale_base',
        latestUpdatedAt: doc.updated_at,
        latestRevision: doc.revision,
      } satisfies SingleWriterMutationFailure;
    }

    const mutation = await mutateCanonicalDocument({
      slug,
      nextMarkdown: markdown,
      nextMarks: marks,
      source,
      baseToken: precondition.mode === 'token' ? precondition.value : undefined,
      baseRevision: precondition.mode === 'revision' ? precondition.value : undefined,
      baseUpdatedAt: precondition.mode === 'updatedAt' ? precondition.value : undefined,
      strictLiveDoc,
      guardPathologicalGrowth,
    });

    if (!mutation.ok) {
      const latest = getDocumentBySlug(slug);
      const common = {
        latestUpdatedAt: latest?.updated_at ?? null,
        latestRevision: latest?.revision ?? null,
        document: latest,
      };
      if (mutation.code === 'NOT_FOUND') {
        return {
          ok: false,
          code: 'missing_document',
          reason: 'missing_document',
          ...common,
        } satisfies SingleWriterMutationFailure;
      }
      if (mutation.code === 'STALE_BASE') {
        return {
          ok: false,
          code: 'stale_base',
          reason: 'stale_base',
          ...common,
        } satisfies SingleWriterMutationFailure;
      }
      if (mutation.code === 'LIVE_DOC_UNAVAILABLE') {
        return {
          ok: false,
          code: 'live_doc_unavailable',
          reason: 'live_doc_unavailable',
          ...common,
        } satisfies SingleWriterMutationFailure;
      }
      if (mutation.code === 'PERSISTED_YJS_CORRUPT') {
        return {
          ok: false,
          code: 'persisted_yjs_corrupt',
          reason: mutation.code,
          ...common,
        } satisfies SingleWriterMutationFailure;
      }
      if (mutation.code === 'PERSISTED_YJS_DIVERGED') {
        return {
          ok: false,
          code: 'persisted_yjs_diverged',
          reason: mutation.code,
          ...common,
        } satisfies SingleWriterMutationFailure;
      }
      return {
        ok: false,
        code: 'apply_failed',
        reason: mutation.code || 'apply_failed',
        ...common,
      } satisfies SingleWriterMutationFailure;
    }

    const verification = await verifyCanonicalDocumentInLoadedCollab(slug, {
      markdown,
      marks,
      source,
    }, timeoutMs);

    let reason = verification.reason;
    let markdownConfirmed = verification.markdownConfirmed;
    let fragmentConfirmed = verification.fragmentConfirmed;
    let liveFragmentTextHash = verification.liveFragmentTextHash;
    let authoritative = await verifyAuthoritativeMutationBaseStable(slug, markdown, marks, {
      liveRequired: activeCollabClients > 0,
      stabilityMs,
      sampleMs: stabilitySampleMs,
    });
    let policy = evaluateSingleWriterConvergencePolicy({
      reason,
      collabConfirmed: verification.confirmed,
      markdownConfirmed,
      fragmentConfirmed,
      authoritativeConfirmed: authoritative.confirmed,
      authoritativeReason: authoritative.reason,
      authoritativeSource: authoritative.source,
      activeCollabClients,
      strictLiveDoc,
    });

    if (policy.renderConfirmed && stabilityMs > 0) {
      if (markdownConfirmed) {
        const stable = await verifyLoadedCollabMarkdownStable(
          slug,
          markdown,
          stabilityMs,
          stabilitySampleMs,
        );
        if (!stable) {
          markdownConfirmed = false;
          reason = 'stability_regressed';
        }
      }
      if (fragmentConfirmed && verification.expectedFragmentTextHash) {
        const stableFragment = await verifyLoadedCollabFragmentStable(
          slug,
          verification.expectedFragmentTextHash,
          stabilityMs,
          stabilitySampleMs,
        );
        if (!stableFragment) {
          fragmentConfirmed = false;
          reason = 'fragment_stability_regressed';
          liveFragmentTextHash = await getLoadedCollabFragmentTextHash(slug);
        }
      }
      policy = evaluateSingleWriterConvergencePolicy({
        reason,
        collabConfirmed: verification.confirmed && markdownConfirmed && fragmentConfirmed,
        markdownConfirmed,
        fragmentConfirmed,
        authoritativeConfirmed: authoritative.confirmed,
        authoritativeReason: authoritative.reason,
        authoritativeSource: authoritative.source,
        activeCollabClients,
        strictLiveDoc,
      });
    }

    const stabilizedVerification: CollabApplyVerificationResult = {
      ...verification,
      reason,
      confirmed: policy.renderConfirmed,
      markdownConfirmed,
      fragmentConfirmed,
      liveFragmentTextHash,
    };

    if (policy.queueProjectionRepair && shouldQueueProjectionRepairAfterMutation(slug, activeCollabClients)) {
      queueProjectionRepair(slug, reason ?? 'markdown_mismatch');
    }

    const updated = getDocumentBySlug(slug);
    if (!updated) {
      return {
        ok: false,
        code: 'missing_document',
        reason: 'missing_document',
        verification: stabilizedVerification,
        policy,
      } satisfies SingleWriterMutationFailure;
    }

    if (!policy.renderConfirmed) {
      const code: SingleWriterMutationFailureCode = policy.reason === 'live_doc_unavailable'
        ? 'live_doc_unavailable'
        : 'sync_pending';
      return {
        ok: false,
        code,
        reason: policy.reason,
        latestUpdatedAt: updated.updated_at,
        latestRevision: updated.revision,
        document: updated,
        verification: stabilizedVerification,
        policy,
      } satisfies SingleWriterMutationFailure;
    }

    return {
      ok: true,
      document: updated,
      verification: stabilizedVerification,
      policy,
      commitId: `${updated.slug}:${updated.revision}:${updated.y_state_version}`,
    } satisfies SingleWriterMutationSuccess;
  });
}
