export type AnchorMatchMode = 'exact' | 'normalized' | 'contextual';
export type AnchorOccurrence = 'first' | 'last' | number;

export type AnchorTarget = {
  anchor: string;
  mode?: AnchorMatchMode;
  occurrence?: AnchorOccurrence;
  contextBefore?: string;
  contextAfter?: string;
};

type LogicalRange = {
  logicalStart: number;
  logicalEnd: number;
};

type LogicalView = {
  logical: string;
  logicalBoundaryToSource: number[];
  remapUsed: boolean;
};

export type AnchorResolverOptions = {
  defaultMode?: AnchorMatchMode;
  failClosedDuplicates?: boolean;
  stripAuthoredSpans?: boolean;
  contextWindowChars?: number;
};

export type AnchorResolveSuccess = {
  ok: true;
  mode: AnchorMatchMode;
  candidateCount: number;
  selectedIndex: number;
  remapUsed: boolean;
  selection: {
    logicalStart: number;
    logicalEnd: number;
    sourceStart: number;
    sourceEnd: number;
  };
};

export type AnchorResolveFailure = {
  ok: false;
  code: 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS';
  mode: AnchorMatchMode;
  candidateCount: number;
  remapUsed: boolean;
  message: string;
};

export type AnchorResolveResult = AnchorResolveSuccess | AnchorResolveFailure;

const DEFAULT_CONTEXT_WINDOW = 240;
const AUTHORED_SPAN_ATTR_REGEX = /data-proof\s*=\s*(?:"authored"|'authored'|authored)/i;

function parseEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isHostedProofEnvironment(): boolean {
  const env = (process.env.PROOF_ENV || process.env.NODE_ENV || '').trim().toLowerCase();
  return env === 'production' || env === 'staging';
}

export function isAgentEditAnchorV2Enabled(): boolean {
  return parseEnabled(process.env.AGENT_EDIT_ANCHOR_V2_ENABLED, true);
}

export function isFailClosedDuplicateHandlingEnabled(): boolean {
  return parseEnabled(process.env.AGENT_EDIT_FAIL_CLOSED_DUPLICATES, true);
}

export function isStructuralCleanupEnabled(): boolean {
  return parseEnabled(process.env.EDIT_STRUCTURAL_CLEANUP_ENABLED, isHostedProofEnvironment());
}

export function isAuthoredSpanRemapEnabled(): boolean {
  return parseEnabled(process.env.EDIT_AUTHORED_SPAN_REMAP_ENABLED, true);
}

function appendSourceText(
  source: string,
  start: number,
  end: number,
  logicalChars: string[],
  boundaries: number[],
): void {
  for (let i = start; i < end; i += 1) {
    if (boundaries[logicalChars.length] === undefined) boundaries[logicalChars.length] = i;
    logicalChars.push(source[i]);
    if (boundaries[logicalChars.length] === undefined) boundaries[logicalChars.length] = i + 1;
  }
}

function buildLogicalView(source: string, stripAuthoredSpans: boolean): LogicalView {
  if (!stripAuthoredSpans) {
    const boundaries = new Array<number>(source.length + 1);
    for (let i = 0; i <= source.length; i += 1) boundaries[i] = i;
    return { logical: source, logicalBoundaryToSource: boundaries, remapUsed: false };
  }

  const logicalChars: string[] = [];
  const boundaries: number[] = [];
  const authoredStack: boolean[] = [];
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  let remapUsed = false;
  let lastIndex = 0;

  for (const match of source.matchAll(spanTagRegex)) {
    const idx = match.index ?? -1;
    if (idx < 0) continue;
    const tag = match[0] ?? '';

    appendSourceText(source, lastIndex, idx, logicalChars, boundaries);
    lastIndex = idx + tag.length;

    if (tag.startsWith('</')) {
      if (authoredStack.length === 0) {
        appendSourceText(source, idx, lastIndex, logicalChars, boundaries);
        continue;
      }
      const authored = authoredStack.pop();
      if (!authored) appendSourceText(source, idx, lastIndex, logicalChars, boundaries);
      else remapUsed = true;
      continue;
    }

    const isAuthored = AUTHORED_SPAN_ATTR_REGEX.test(tag);
    authoredStack.push(isAuthored);
    if (isAuthored) {
      remapUsed = true;
      continue;
    }
    appendSourceText(source, idx, lastIndex, logicalChars, boundaries);
  }

  appendSourceText(source, lastIndex, source.length, logicalChars, boundaries);
  if (boundaries[logicalChars.length] === undefined) boundaries[logicalChars.length] = source.length;
  if (boundaries[0] === undefined) boundaries[0] = source.length;

  return {
    logical: logicalChars.join(''),
    logicalBoundaryToSource: boundaries,
    remapUsed,
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildNormalizedIndex(source: string): { text: string; starts: number[]; ends: number[] } {
  const textChars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (textChars.length > 0 && textChars[textChars.length - 1] !== ' ') {
        textChars.push(' ');
        starts.push(i);
        ends.push(j);
      }
      i = j;
      continue;
    }
    textChars.push(char);
    starts.push(i);
    ends.push(i + 1);
    i += 1;
  }
  while (textChars[0] === ' ') {
    textChars.shift();
    starts.shift();
    ends.shift();
  }
  while (textChars[textChars.length - 1] === ' ') {
    textChars.pop();
    starts.pop();
    ends.pop();
  }
  return { text: textChars.join(''), starts, ends };
}

function findAllExact(haystack: string, needle: string): LogicalRange[] {
  if (!needle) return [];
  const ranges: LogicalRange[] = [];
  let index = 0;
  while (index <= haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next < 0) break;
    ranges.push({ logicalStart: next, logicalEnd: next + needle.length });
    index = next + 1;
  }
  return ranges;
}

function findAllNormalized(haystack: string, needle: string): LogicalRange[] {
  const indexedHaystack = buildNormalizedIndex(haystack);
  const normalizedNeedle = collapseWhitespace(needle);
  if (!indexedHaystack.text || !normalizedNeedle) return [];

  const ranges: LogicalRange[] = [];
  let index = 0;
  while (index <= indexedHaystack.text.length) {
    const next = indexedHaystack.text.indexOf(normalizedNeedle, index);
    if (next < 0) break;
    const start = indexedHaystack.starts[next];
    const end = indexedHaystack.ends[next + normalizedNeedle.length - 1];
    if (typeof start === 'number' && typeof end === 'number') {
      ranges.push({ logicalStart: start, logicalEnd: end });
    }
    index = next + 1;
  }
  return ranges;
}

function filterContextualCandidates(
  logical: string,
  candidates: LogicalRange[],
  contextBefore: string,
  contextAfter: string,
  windowChars: number,
): LogicalRange[] {
  if (!contextBefore && !contextAfter) return candidates;
  return candidates.filter((candidate) => {
    if (contextBefore) {
      const beforeStart = Math.max(0, candidate.logicalStart - (contextBefore.length + windowChars));
      if (!logical.slice(beforeStart, candidate.logicalStart).includes(contextBefore)) return false;
    }
    if (contextAfter) {
      const afterEnd = Math.min(logical.length, candidate.logicalEnd + contextAfter.length + windowChars);
      if (!logical.slice(candidate.logicalEnd, afterEnd).includes(contextAfter)) return false;
    }
    return true;
  });
}

function pickCandidateIndex(
  occurrence: AnchorOccurrence | undefined,
  candidateCount: number,
  failClosedDuplicates: boolean,
): { code: 'ok'; selectedIndex: number } | { code: 'not_found' } | { code: 'ambiguous' } {
  if (candidateCount <= 0) return { code: 'not_found' };
  if (occurrence !== undefined) {
    if (occurrence === 'first') return { code: 'ok', selectedIndex: 0 };
    if (occurrence === 'last') return { code: 'ok', selectedIndex: candidateCount - 1 };
    if (Number.isInteger(occurrence) && occurrence >= 0 && occurrence < candidateCount) {
      return { code: 'ok', selectedIndex: occurrence };
    }
    return { code: 'not_found' };
  }
  if (candidateCount === 1 || !failClosedDuplicates) return { code: 'ok', selectedIndex: 0 };
  return { code: 'ambiguous' };
}

function toSourceBoundary(view: LogicalView, logicalBoundary: number, sourceLength: number): number {
  const boundary = view.logicalBoundaryToSource[logicalBoundary];
  if (typeof boundary === 'number') return boundary;
  if (logicalBoundary <= 0) return 0;
  const fallback = view.logicalBoundaryToSource[view.logicalBoundaryToSource.length - 1];
  return typeof fallback === 'number' ? fallback : sourceLength;
}

export function resolveAnchorTarget(
  source: string,
  target: AnchorTarget,
  options: AnchorResolverOptions = {},
): AnchorResolveResult {
  const mode = target.mode ?? options.defaultMode ?? 'exact';
  const failClosedDuplicates = options.failClosedDuplicates ?? true;
  const view = buildLogicalView(source, options.stripAuthoredSpans ?? false);
  const anchor = String(target.anchor ?? '');

  if (!anchor) {
    return { ok: false, code: 'ANCHOR_NOT_FOUND', mode, candidateCount: 0, remapUsed: view.remapUsed, message: 'Anchor target is empty' };
  }

  let candidates = mode === 'normalized'
    ? findAllNormalized(view.logical, anchor)
    : findAllExact(view.logical, anchor);

  const contextBefore = typeof target.contextBefore === 'string' ? target.contextBefore : '';
  const contextAfter = typeof target.contextAfter === 'string' ? target.contextAfter : '';
  if (mode === 'contextual' || contextBefore || contextAfter) {
    candidates = filterContextualCandidates(
      view.logical,
      candidates,
      contextBefore,
      contextAfter,
      options.contextWindowChars ?? DEFAULT_CONTEXT_WINDOW,
    );
  }

  const picked = pickCandidateIndex(target.occurrence, candidates.length, failClosedDuplicates);
  if (picked.code === 'not_found') {
    return {
      ok: false,
      code: 'ANCHOR_NOT_FOUND',
      mode,
      candidateCount: candidates.length,
      remapUsed: view.remapUsed,
      message: 'Anchor target not found for requested occurrence',
    };
  }
  if (picked.code === 'ambiguous') {
    return {
      ok: false,
      code: 'ANCHOR_AMBIGUOUS',
      mode,
      candidateCount: candidates.length,
      remapUsed: view.remapUsed,
      message: 'Anchor target is ambiguous',
    };
  }

  const selected = candidates[picked.selectedIndex];
  return {
    ok: true,
    mode,
    candidateCount: candidates.length,
    selectedIndex: picked.selectedIndex,
    remapUsed: view.remapUsed,
    selection: {
      logicalStart: selected.logicalStart,
      logicalEnd: selected.logicalEnd,
      sourceStart: Math.max(0, Math.min(source.length, toSourceBoundary(view, selected.logicalStart, source.length))),
      sourceEnd: Math.max(0, Math.min(source.length, toSourceBoundary(view, selected.logicalEnd, source.length))),
    },
  };
}

function trimContextSnippet(value: string): string {
  return value.replace(/^\s+|\s+$/g, '');
}

export function stabilizeAnchorTarget(
  source: string,
  target: AnchorTarget,
  resolved: AnchorResolveSuccess,
  options: {
    stripAuthoredSpans?: boolean;
    contextWindowChars?: number;
  } = {},
): AnchorTarget {
  const view = buildLogicalView(source, options.stripAuthoredSpans ?? false);
  const anchor = view.logical.slice(resolved.selection.logicalStart, resolved.selection.logicalEnd) || String(target.anchor ?? '');
  const windowChars = options.contextWindowChars ?? DEFAULT_CONTEXT_WINDOW;
  const before = trimContextSnippet(view.logical.slice(Math.max(0, resolved.selection.logicalStart - Math.min(windowChars, 120)), resolved.selection.logicalStart));
  const after = trimContextSnippet(view.logical.slice(resolved.selection.logicalEnd, Math.min(view.logical.length, resolved.selection.logicalEnd + Math.min(windowChars, 120))));
  return {
    anchor,
    mode: resolved.mode,
    ...(before ? { contextBefore: before } : {}),
    ...(after ? { contextAfter: after } : {}),
  };
}

export function buildAnchorRetrySteps(code: 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS'): string[] {
  if (code === 'ANCHOR_AMBIGUOUS') {
    return [
      'Provide target.occurrence as "first", "last", or a 0-based number.',
      'Or supply target.contextBefore/target.contextAfter to disambiguate duplicates.',
      'Retry with latest state from /api/agent/:slug/state.',
    ];
  }
  return [
    'Refresh document state from /api/agent/:slug/state and retry.',
    'Use target.mode="normalized" for whitespace or blank-line variants.',
    'Provide contextual anchors with target.contextBefore/contextAfter if needed.',
  ];
}

export function removeEmptyAuthoredSpanWrappers(markdown: string): { markdown: string; changed: boolean } {
  let next = markdown;
  let changed = false;
  for (let i = 0; i < 4; i += 1) {
    const cleaned = next.replace(
      /<span\b[^>]*data-proof\s*=\s*(?:"authored"|'authored'|authored)[^>]*>\s*<\/span>/gi,
      '',
    );
    if (cleaned === next) break;
    changed = true;
    next = cleaned;
  }
  return { markdown: next, changed };
}

function findLineIndexAtOffset(markdown: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, markdown.length));
  let lineIndex = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (markdown.charCodeAt(i) === 10) lineIndex += 1;
  }
  return lineIndex;
}

export function cleanupEmptyListShells(
  markdown: string,
  options: {
    touchedOffsets?: number[];
  } = {},
): { markdown: string; changed: boolean } {
  const lines = markdown.split('\n');
  const touchedLineIndexes = new Set(
    (options.touchedOffsets ?? []).map((offset) => findLineIndexAtOffset(markdown, offset)),
  );
  const kept: string[] = [];
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (touchedLineIndexes.has(i) && /^\s*(?:[-*+]\s*|\d+[.)]\s*)$/.test(line)) {
      changed = true;
      continue;
    }
    kept.push(line);
  }

  return { markdown: kept.join('\n'), changed };
}

export function applyPostMutationCleanup(
  markdown: string,
  options: {
    structuralCleanupEnabled?: boolean;
    structuralCleanupOffsets?: number[];
  } = {},
): {
  markdown: string;
  structuralCleanupApplied: boolean;
  authoredWrapperCleanupApplied: boolean;
} {
  const authoredCleanup = removeEmptyAuthoredSpanWrappers(markdown);
  let next = authoredCleanup.markdown;
  let structuralCleanupApplied = false;

  if (options.structuralCleanupEnabled) {
    const listCleanup = cleanupEmptyListShells(next, {
      touchedOffsets: options.structuralCleanupOffsets,
    });
    next = listCleanup.markdown;
    structuralCleanupApplied = listCleanup.changed;
  }

  return {
    markdown: next,
    structuralCleanupApplied,
    authoredWrapperCleanupApplied: authoredCleanup.changed,
  };
}
