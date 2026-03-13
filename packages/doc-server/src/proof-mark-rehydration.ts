import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { canonicalizeStoredMarks, normalizeQuote, type StoredMark } from '@proof/core/marks';
import {
  applyRemoteMarks,
  accept as acceptMark,
  getMarkMetadataWithQuotes,
  getMarks,
  marksPluginKey,
  reject as rejectMark,
} from '@proof/editor/plugins/marks';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeMarkdown,
} from './milkdown-headless.js';
import {
  buildProofSpanReplacementMap,
  listAuthoredProofSpanBounds,
  stripAllProofSpanTags,
  stripAllProofSpanTagsWithReplacements,
} from './proof-span-strip.js';
import {
  extractAuthoredMarksFromMarkdown,
  synchronizeAuthoredMarks,
} from './proof-authored-mark-sync.js';

type RehydrationMode = 'repair' | 'accept' | 'reject';

type RequiredHydrationReason = 'authored' | 'comment' | 'suggestion' | 'review';

export type ProofMarkRehydrationFailureCode =
  | 'MARKDOWN_PARSE_FAILED'
  | 'MARK_NOT_HYDRATED'
  | 'REQUIRED_MARKS_MISSING'
  | 'STRUCTURED_MUTATION_FAILED';

export type ProofMarkRehydrationFailure = {
  ok: false;
  code: ProofMarkRehydrationFailureCode;
  error: string;
  strippedMarkdown: string;
  hydratedMarkIds: string[];
  missingRequiredMarkIds: string[];
};

export type ProofMarkRehydrationSuccess = {
  ok: true;
  markdown: string;
  marks: Record<string, StoredMark>;
  strippedMarkdown: string;
  repairedStrippedMarkdown: string;
  hydratedMarkIds: string[];
  missingRequiredMarkIds: string[];
};

export type ProofMarkRehydrationResult = ProofMarkRehydrationSuccess | ProofMarkRehydrationFailure;

type HeadlessView = Pick<EditorView, 'state' | 'dispatch'>;

function hasValidRange(value: unknown): value is { from: number; to: number } {
  if (!value || typeof value !== 'object') return false;
  const range = value as { from?: unknown; to?: unknown };
  return (
    typeof range.from === 'number'
    && Number.isFinite(range.from)
    && typeof range.to === 'number'
    && Number.isFinite(range.to)
    && range.to > range.from
  );
}

function hasRelativeAnchor(mark: StoredMark): boolean {
  return typeof mark.startRel === 'string'
    && mark.startRel.startsWith('char:')
    && typeof mark.endRel === 'string'
    && mark.endRel.startsWith('char:');
}

function hasAnchorCandidate(mark: StoredMark): boolean {
  return hasRelativeAnchor(mark)
    || hasValidRange(mark.range)
    || (typeof mark.quote === 'string' && mark.quote.trim().length > 0);
}

function requiredHydrationReason(mark: StoredMark): RequiredHydrationReason | null {
  switch (mark.kind) {
    case 'authored':
      return hasAnchorCandidate(mark) ? 'authored' : null;
    case 'comment':
      return (
        !mark.resolved
        && hasAnchorCandidate(mark)
        && typeof mark.text === 'string'
        && mark.text.trim().length > 0
      )
        ? 'comment'
        : null;
    case 'insert':
    case 'delete':
    case 'replace':
      return mark.status === 'accepted' || mark.status === 'rejected'
        ? null
        : hasAnchorCandidate(mark)
          ? 'suggestion'
          : null;
    case 'approved':
    case 'flagged':
      return hasAnchorCandidate(mark) ? 'review' : null;
    default:
      return null;
  }
}

function createMarksStatePlugin(): Plugin {
  return new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null, composeAnchorRange: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey) as
          | { type?: string; metadata?: Record<string, StoredMark>; markId?: string | null; range?: unknown }
          | undefined;
        if (meta?.type === 'SET_METADATA') {
          return {
            ...value,
            metadata: meta.metadata ?? {},
          };
        }
        if (meta?.type === 'SET_ACTIVE') {
          return {
            ...value,
            activeMarkId: meta.markId ?? null,
          };
        }
        if (meta?.type === 'SET_COMPOSE_ANCHOR') {
          return {
            ...value,
            composeAnchorRange: meta.range ?? null,
          };
        }
        return value;
      },
    },
  });
}

function createHeadlessView(state: EditorState): { view: HeadlessView; getState: () => EditorState } {
  let currentState = state;
  const view: HeadlessView = {
    get state() {
      return currentState;
    },
    dispatch(tr) {
      currentState = currentState.apply(tr);
    },
  };
  return {
    view,
    getState: () => currentState,
  };
}

function extractDataBy(tag: string): string | null {
  const match = tag.match(/data-by\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const by = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  return typeof by === 'string' && by.trim().length > 0 ? by.trim() : null;
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

function authoredFingerprint(mark: StoredMark): string | null {
  const by = typeof mark.by === 'string' && mark.by.trim().length > 0 ? mark.by.trim() : '';
  const quote = typeof mark.quote === 'string' ? normalizeQuote(mark.quote) : '';
  if (!by || !quote) return null;
  return `${by}::${quote}`;
}

function buildSerializedAuthoredRequirementIds(fingerprint: string, count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [`serialized-authored:${fingerprint}`];
  return Array.from({ length: count }, (_, index) => `serialized-authored:${fingerprint}#${index + 1}`);
}

function buildSerializedAuthoredFingerprintCounts(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const span of listAuthoredProofSpanBounds(markdown)) {
    const openTag = markdown.slice(span.openStart, span.contentStart);
    const by = extractDataBy(openTag);
    if (!by) continue;
    const inner = markdown.slice(span.contentStart, span.contentEnd);
    const quote = normalizeQuote(stripHtmlTags(stripAllProofSpanTags(inner)));
    if (!quote) continue;
    const key = `${by}::${quote}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function collectRequiredHydrationIds(marks: Record<string, StoredMark>, markdown: string): string[] {
  const serializedAuthoredCounts = buildSerializedAuthoredFingerprintCounts(markdown);
  const requiredIds: string[] = [];

  for (const [id, mark] of Object.entries(marks)) {
    const reason = requiredHydrationReason(mark);
    if (reason === null) continue;
    if (reason !== 'authored') {
      requiredIds.push(id);
      continue;
    }

    const fingerprint = authoredFingerprint(mark);
    if (!fingerprint) continue;
    const remaining = serializedAuthoredCounts.get(fingerprint) ?? 0;
    if (remaining <= 0) continue;
    serializedAuthoredCounts.set(fingerprint, remaining - 1);
    requiredIds.push(id);
  }

  for (const [fingerprint, count] of serializedAuthoredCounts.entries()) {
    requiredIds.push(...buildSerializedAuthoredRequirementIds(fingerprint, count));
  }

  return requiredIds.sort();
}

function collectHydratedMarkIds(state: EditorState): string[] {
  return getMarks(state)
    .map((mark) => mark.id)
    .sort();
}

function buildMissingRequiredMarkIds(requiredIds: string[], hydratedIds: string[]): string[] {
  const hydrated = new Set(hydratedIds);
  return requiredIds.filter((id) => !hydrated.has(id));
}

async function buildRehydratedState(markdown: string, marks: Record<string, StoredMark>): Promise<{
  strippedMarkdown: string;
  state: EditorState;
  view: HeadlessView;
  parseMarkdown: (markdown: string) => unknown;
  requiredIds: string[];
  hydratedIds: string[];
  missingRequiredIds: string[];
} | ProofMarkRehydrationFailure> {
  const serializedAuthoredMarks = await extractAuthoredMarksFromMarkdown(markdown ?? '');
  const effectiveMarks = serializedAuthoredMarks
    ? synchronizeAuthoredMarks(marks, serializedAuthoredMarks, { preserveExistingAnchors: true })
    : marks;
  const strippedMarkdown = stripAllProofSpanTagsWithReplacements(
    markdown ?? '',
    buildProofSpanReplacementMap(effectiveMarks),
  );
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, strippedMarkdown);
  if (!parsed.doc) {
    return {
      ok: false,
      code: 'MARKDOWN_PARSE_FAILED',
      error: 'Failed to parse markdown after stripping Proof spans',
      strippedMarkdown,
      hydratedMarkIds: [],
      missingRequiredMarkIds: [],
    };
  }

  const state = EditorState.create({
    schema: parser.schema,
    doc: parsed.doc,
    plugins: [createMarksStatePlugin()],
  });
  const { view, getState } = createHeadlessView(state);
  applyRemoteMarks(view as EditorView, effectiveMarks, { hydrateAnchors: true });

  const hydratedState = getState();
  const requiredIds = collectRequiredHydrationIds(effectiveMarks, markdown ?? '');
  const hydratedIds = collectHydratedMarkIds(hydratedState);
  const missingRequiredIds = buildMissingRequiredMarkIds(requiredIds, hydratedIds);

  return {
    strippedMarkdown,
    state: hydratedState,
    view,
    parseMarkdown: parser.parseMarkdown,
    requiredIds,
    hydratedIds,
    missingRequiredIds,
  };
}

function missingMarkFailure(
  code: ProofMarkRehydrationFailureCode,
  error: string,
  strippedMarkdown: string,
  hydratedMarkIds: string[],
  missingRequiredMarkIds: string[],
): ProofMarkRehydrationFailure {
  return {
    ok: false,
    code,
    error,
    strippedMarkdown,
    hydratedMarkIds,
    missingRequiredMarkIds,
  };
}

async function finalizeRehydratedState(
  strippedMarkdown: string,
  state: EditorState,
): Promise<ProofMarkRehydrationSuccess> {
  const repairedMarkdown = await serializeMarkdown(state.doc);
  const repairedMarks = canonicalizeStoredMarks(getMarkMetadataWithQuotes(state));
  const hydratedMarkIds = collectHydratedMarkIds(state);
  const missingRequiredMarkIds = buildMissingRequiredMarkIds(
    collectRequiredHydrationIds(repairedMarks, repairedMarkdown),
    hydratedMarkIds,
  );

  return {
    ok: true,
    markdown: repairedMarkdown,
    marks: repairedMarks,
    strippedMarkdown,
    repairedStrippedMarkdown: stripAllProofSpanTags(repairedMarkdown),
    hydratedMarkIds,
    missingRequiredMarkIds,
  };
}

export async function rehydrateProofMarksMarkdown(
  markdown: string,
  marks: Record<string, StoredMark>,
): Promise<ProofMarkRehydrationResult> {
  const canonicalMarks = canonicalizeStoredMarks(marks);
  const rehydrated = await buildRehydratedState(markdown, canonicalMarks);
  if ('ok' in rehydrated && rehydrated.ok === false) {
    return rehydrated;
  }
  if (rehydrated.missingRequiredIds.length > 0) {
    return missingMarkFailure(
      'REQUIRED_MARKS_MISSING',
      'One or more stored Proof marks could not be rehydrated safely',
      rehydrated.strippedMarkdown,
      rehydrated.hydratedIds,
      rehydrated.missingRequiredIds,
    );
  }
  return finalizeRehydratedState(rehydrated.strippedMarkdown, rehydrated.state);
}

export async function finalizeSuggestionThroughRehydration(args: {
  markdown: string;
  marks: Record<string, StoredMark>;
  markId: string;
  action: Exclude<RehydrationMode, 'repair'>;
}): Promise<ProofMarkRehydrationResult> {
  const canonicalMarks = canonicalizeStoredMarks(args.marks);
  const rehydrated = await buildRehydratedState(args.markdown, canonicalMarks);
  if ('ok' in rehydrated && rehydrated.ok === false) {
    return rehydrated;
  }
  if (!rehydrated.hydratedIds.includes(args.markId)) {
    return missingMarkFailure(
      'MARK_NOT_HYDRATED',
      'Target Proof mark could not be rehydrated from stored anchors',
      rehydrated.strippedMarkdown,
      rehydrated.hydratedIds,
      rehydrated.missingRequiredIds,
    );
  }
  if (rehydrated.missingRequiredIds.length > 0) {
    return missingMarkFailure(
      'REQUIRED_MARKS_MISSING',
      'One or more stored Proof marks could not be rehydrated safely',
      rehydrated.strippedMarkdown,
      rehydrated.hydratedIds,
      rehydrated.missingRequiredIds,
    );
  }

  const didApply = args.action === 'accept'
    ? acceptMark(rehydrated.view as EditorView, args.markId, rehydrated.parseMarkdown as never)
    : rejectMark(rehydrated.view as EditorView, args.markId);
  if (!didApply) {
    return missingMarkFailure(
      'STRUCTURED_MUTATION_FAILED',
      `Structured ${args.action} failed after mark rehydration`,
      rehydrated.strippedMarkdown,
      rehydrated.hydratedIds,
      rehydrated.missingRequiredIds,
    );
  }

  return finalizeRehydratedState(rehydrated.strippedMarkdown, rehydrated.view.state);
}
