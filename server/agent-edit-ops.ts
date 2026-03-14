import {
  applyPostMutationCleanup,
  buildAnchorRetrySteps,
  type AnchorMatchMode,
  type AnchorResolveSuccess,
  type AnchorTarget,
  isAgentEditAnchorV2Enabled,
  isAuthoredSpanRemapEnabled,
  isFailClosedDuplicateHandlingEnabled,
  isStructuralCleanupEnabled,
  resolveAnchorTarget,
} from './anchor-resolver.js';
import {
  expandRangeToIncludeFullyWrappedAuthoredSpan,
  moveIndexPastTrailingAuthoredSpans,
} from './proof-span-strip.js';

export type AgentEditTarget = AnchorTarget;

export type AgentEditOperation =
  | { op: 'append'; section: string; content: string }
  | { op: 'replace'; search?: string; target?: AgentEditTarget; content: string }
  | { op: 'insert'; after?: string; target?: AgentEditTarget; content: string };

export type AgentEditOperationMetadata = {
  opIndex: number;
  selectedIndex: number;
  candidateCount: number;
  mode: AnchorMatchMode;
  remapUsed: boolean;
};

export type AgentEditApplyResult =
  | {
    ok: true;
    markdown: string;
    metadata: AgentEditOperationMetadata[];
    structuralCleanupApplied: boolean;
    authoredWrapperCleanupApplied: boolean;
  }
  | {
    ok: false;
    code: 'ANCHOR_NOT_FOUND' | 'ANCHOR_AMBIGUOUS';
    message: string;
    opIndex: number;
    details: {
      candidateCount: number;
      mode: AnchorMatchMode;
      remapUsed: boolean;
      selectedIndex: number | null;
    };
    nextSteps: string[];
  };

type AgentEditApplyFailure = Extract<AgentEditApplyResult, { ok: false }>;

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

function isWithinFencedCodeBlock(markdown: string, index: number): boolean {
  const src = normalizeNewlines(markdown);
  const upto = Math.max(0, Math.min(index, src.length));
  const lines = src.slice(0, upto).split('\n');
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
    }
  }
  return inFence;
}

function contentLooksInline(content: string): boolean {
  const normalized = normalizeNewlines(content).trim();
  if (!normalized) return false;
  if (normalized.includes('```') || normalized.includes('~~~')) return false;
  if (/\n\s*\n/.test(normalized)) return false;
  if (/^\s*#{1,6}\s+/.test(normalized)) return false;
  if (/^\s*[-*+]\s+/.test(normalized)) return false;
  if (/^\s*\d+\.\s+/.test(normalized)) return false;
  if (/^\s*>/.test(normalized)) return false;
  return true;
}

function looksLikeInlineMarkdownFormatting(content: string): boolean {
  if (/(^|[^\\])`[^`\n]+`/.test(content)) return true;
  if (/(^|[^\\])\*\*[^*\n]+?\*\*/.test(content)) return true;
  if (/(^|[^\\])\*[^*\n]+?\*(?!\*)/.test(content)) return true;
  if (/(^|[^\\])~~[^~\n]+?~~/.test(content)) return true;
  return false;
}

function maybeWrapAuthored(content: string, by: string | undefined, allow: boolean): string {
  if (!allow) return content;
  if (!by || !by.trim()) return content;
  const normalized = content;
  if (/data-proof\s*=\s*("|')authored(")?/i.test(normalized)) return content;
  if (!contentLooksInline(normalized)) return content;
  if (looksLikeInlineMarkdownFormatting(normalized)) return content;
  return `<span data-proof="authored" data-by="${by.trim()}">${normalized}</span>`;
}

function computeLineOffsets(src: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

function normalizeHeadingLabel(value: string): string {
  const collapsed = normalizeNewlines(value).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!collapsed) return '';
  return collapsed.replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');
}

function findSectionBoundaryIndex(lines: string[], offsets: number[], headingLineIndex: number): number {
  const line = lines[headingLineIndex] ?? '';
  const m = line.match(/^(#{1,6})\s+/);
  if (!m) return offsets[headingLineIndex] ?? 0;
  const level = m[1].length;
  for (let j = headingLineIndex + 1; j < lines.length; j += 1) {
    const m2 = lines[j].match(/^(#{1,6})\s+/);
    if (!m2) continue;
    const nextLevel = m2[1].length;
    if (nextLevel <= level) return offsets[j] ?? 0;
  }
  const lastOffset = offsets[offsets.length - 1];
  return typeof lastOffset === 'number' ? lastOffset + (lines[lines.length - 1] ?? '').length : 0;
}

function findHeadingAppendIndex(src: string, section: string): number | null {
  const lines = src.split('\n');
  const offsets = computeLineOffsets(src);

  const needle = section.trim();
  if (!needle) return null;

  let fallbackHeadingLineIndex: number | null = null;
  const normalizedNeedle = normalizeHeadingLabel(needle);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.*?)(\s+#*\s*)?$/);
    if (!m) continue;
    const title = (m[2] || '').trim();
    if (title === needle) return findSectionBoundaryIndex(lines, offsets, i);
    if (fallbackHeadingLineIndex === null && normalizedNeedle && normalizeHeadingLabel(title) === normalizedNeedle) {
      fallbackHeadingLineIndex = i;
    }
  }

  if (fallbackHeadingLineIndex !== null) {
    return findSectionBoundaryIndex(lines, offsets, fallbackHeadingLineIndex);
  }

  return null;
}

function spliceAt(src: string, index: number, insert: string): string {
  return `${src.slice(0, index)}${insert}${src.slice(index)}`;
}

function ensureLeadingBreak(insert: string, beforeChar: string | null): string {
  if (!insert || !beforeChar || beforeChar === '\n') return insert;
  return `\n${insert}`;
}

function ensureTrailingBreak(insert: string, afterChar: string | null): string {
  if (!insert || !afterChar || afterChar === '\n') return insert;
  return `${insert}\n`;
}

function buildImplicitLegacyTarget(
  anchor: string,
  anchorV2Enabled: boolean,
): AgentEditTarget {
  return {
    anchor,
    mode: anchorV2Enabled ? 'normalized' : 'exact',
    occurrence: 'first',
  };
}

function resolveTextAnchor(
  source: string,
  opIndex: number,
  target: AgentEditTarget,
  options: {
    anchorV2Enabled: boolean;
    failClosedDuplicates: boolean;
    authoredSpanRemapEnabled: boolean;
  },
): AnchorResolveSuccess | AgentEditApplyFailure {
  const resolved = resolveAnchorTarget(source, target, {
    defaultMode: target.mode,
    failClosedDuplicates: options.anchorV2Enabled ? options.failClosedDuplicates : false,
    stripAuthoredSpans: options.anchorV2Enabled ? options.authoredSpanRemapEnabled : false,
  });

  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      message: resolved.message,
      opIndex,
      details: {
        candidateCount: resolved.candidateCount,
        mode: resolved.mode,
        remapUsed: resolved.remapUsed,
        selectedIndex: null,
      },
      nextSteps: buildAnchorRetrySteps(resolved.code),
    };
  }

  return resolved;
}

export function applyAgentEditOperations(
  markdown: string,
  operations: AgentEditOperation[],
  options?: {
    by?: string;
    anchorV2Enabled?: boolean;
    failClosedDuplicates?: boolean;
    structuralCleanupEnabled?: boolean;
    authoredSpanRemapEnabled?: boolean;
  },
): AgentEditApplyResult {
  let src = normalizeNewlines(markdown ?? '');
  const by = options?.by;

  const anchorV2Enabled = options?.anchorV2Enabled ?? isAgentEditAnchorV2Enabled();
  const failClosedDuplicates = options?.failClosedDuplicates ?? isFailClosedDuplicateHandlingEnabled();
  const structuralCleanupEnabled = options?.structuralCleanupEnabled ?? isStructuralCleanupEnabled();
  const authoredSpanRemapEnabled = options?.authoredSpanRemapEnabled ?? isAuthoredSpanRemapEnabled();

  const metadata: AgentEditOperationMetadata[] = [];
  const structuralCleanupOffsets: number[] = [];

  for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
    const operation = operations[opIndex];
    if (operation.op === 'append') {
      const idx = findHeadingAppendIndex(src, operation.section);
      if (idx === null) {
        const safeContent = operation.content ?? '';
        const block = `\n\n## ${operation.section.trim()}\n\n${safeContent.trim()}\n`;
        src = `${src.replace(/\s+$/g, '')}${block}`;
        continue;
      }
      const allowWrap = !isWithinFencedCodeBlock(src, idx);
      const content = maybeWrapAuthored(operation.content ?? '', by, allowWrap);
      src = spliceAt(src, idx, `\n\n${content.trim()}\n`);
      continue;
    }

    if (operation.op === 'replace') {
      const anchor = operation.target
        ?? buildImplicitLegacyTarget(operation.search ?? '', anchorV2Enabled);
      const resolved = resolveTextAnchor(src, opIndex, anchor, {
        anchorV2Enabled,
        failClosedDuplicates,
        authoredSpanRemapEnabled,
      });
      if (!resolved.ok) return resolved;

      const rawRangeStart = Math.min(resolved.selection.sourceStart, resolved.selection.sourceEnd);
      const rawRangeEnd = Math.max(resolved.selection.sourceStart, resolved.selection.sourceEnd);
      const expandedRange = expandRangeToIncludeFullyWrappedAuthoredSpan(src, rawRangeStart, rawRangeEnd);
      const rangeStart = expandedRange.start;
      const rangeEnd = expandedRange.end;
      const allowWrap = !isWithinFencedCodeBlock(src, rangeStart);
      const content = maybeWrapAuthored(operation.content ?? '', by, allowWrap);
      src = `${src.slice(0, rangeStart)}${content}${src.slice(rangeEnd)}`;
      if (operation.content === '') {
        structuralCleanupOffsets.push(Math.min(rangeStart, src.length));
      }
      metadata.push({
        opIndex,
        selectedIndex: resolved.selectedIndex,
        candidateCount: resolved.candidateCount,
        mode: resolved.mode,
        remapUsed: resolved.remapUsed,
      });
      continue;
    }

    if (operation.op === 'insert') {
      const anchor = operation.target
        ?? buildImplicitLegacyTarget(operation.after ?? '', anchorV2Enabled);
      const resolved = resolveTextAnchor(src, opIndex, anchor, {
        anchorV2Enabled,
        failClosedDuplicates,
        authoredSpanRemapEnabled,
      });
      if (!resolved.ok) return resolved;

      const resolvedInsertAt = Math.max(resolved.selection.sourceStart, resolved.selection.sourceEnd);
      const insertAt = moveIndexPastTrailingAuthoredSpans(src, resolvedInsertAt);
      const allowWrap = !isWithinFencedCodeBlock(src, insertAt);
      const content = maybeWrapAuthored(operation.content ?? '', by, allowWrap);

      const beforeChar = insertAt > 0 ? src[insertAt - 1] : null;
      const afterChar = insertAt < src.length ? src[insertAt] : null;
      let insertion = content;
      if (afterChar === '\n') {
        insertion = `\n\n${content.trim()}\n`;
      } else {
        insertion = ensureLeadingBreak(insertion, beforeChar);
        insertion = ensureTrailingBreak(insertion, afterChar);
      }

      src = spliceAt(src, insertAt, insertion);
      metadata.push({
        opIndex,
        selectedIndex: resolved.selectedIndex,
        candidateCount: resolved.candidateCount,
        mode: resolved.mode,
        remapUsed: resolved.remapUsed,
      });
    }
  }

  const cleanup = applyPostMutationCleanup(src, {
    structuralCleanupEnabled,
    structuralCleanupOffsets,
  });
  return {
    ok: true,
    markdown: cleanup.markdown,
    metadata,
    structuralCleanupApplied: cleanup.structuralCleanupApplied,
    authoredWrapperCleanupApplied: cleanup.authoredWrapperCleanupApplied,
  };
}
