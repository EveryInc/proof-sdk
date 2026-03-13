import {
  buildStrippedIndexMap,
  expandRangeToIncludeFullyWrappedAuthoredSpan,
  moveIndexPastTrailingAuthoredSpans,
} from './proof-span-strip.js';

export type AgentEditOperation =
  | { op: 'append'; section: string; content: string }
  | { op: 'replace'; search: string; content: string }
  | { op: 'insert'; after: string; content: string };

export type AgentEditApplyResult =
  | { ok: true; markdown: string }
  | { ok: false; code: 'ANCHOR_NOT_FOUND'; message: string; opIndex: number };

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
  if (/\n\s*\n/.test(normalized)) return false; // blank line => multi-paragraph / blocky
  if (/^\s*#{1,6}\s+/.test(normalized)) return false;
  if (/^\s*[-*+]\s+/.test(normalized)) return false;
  if (/^\s*\d+\.\s+/.test(normalized)) return false;
  if (/^\s*>/.test(normalized)) return false;
  return true;
}

function looksLikeInlineMarkdownFormatting(content: string): boolean {
  // Keep authored HTML wrappers away from inline markdown tokens so we don't
  // interfere with markdown parser round-tripping.
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
  // Keep as a single inline HTML wrapper so remarkProofMarks can parse it into a proofAuthored mark.
  return `<span data-proof="authored" data-by="${by.trim()}">${normalized}</span>`;
}

function computeLineOffsets(src: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10 /* \n */) offsets.push(i + 1);
  }
  return offsets;
}

function normalizeHeadingLabel(value: string): string {
  const collapsed = normalizeNewlines(value).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!collapsed) return '';
  // Allow section matching to ignore leading ordinal prefixes like:
  // "4. Title", "4) Title", or "4.1 Title".
  return collapsed.replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');
}

function findSectionBoundaryIndex(lines: string[], offsets: number[], headingLineIndex: number): number {
  const line = lines[headingLineIndex] ?? '';
  const m = line.match(/^(#{1,6})\s+/);
  if (!m) return offsets[headingLineIndex] ?? 0;
  const level = m[1].length;
  for (let j = headingLineIndex + 1; j < lines.length; j++) {
    const m2 = lines[j].match(/^(#{1,6})\s+/);
    if (!m2) continue;
    const nextLevel = m2[1].length;
    if (nextLevel <= level) {
      return offsets[j] ?? 0;
    }
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.*?)(\s+#*\s*)?$/);
    if (!m) continue;
    const title = (m[2] || '').trim();
    if (title === needle) {
      return findSectionBoundaryIndex(lines, offsets, i);
    }
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
  if (!insert) return insert;
  if (!beforeChar) return insert;
  if (beforeChar === '\n') return insert;
  return `\n${insert}`;
}

function ensureTrailingBreak(insert: string, afterChar: string | null): string {
  if (!insert) return insert;
  if (!afterChar) return insert;
  if (afterChar === '\n') return insert;
  return `${insert}\n`;
}

function resolveReplaceRange(
  markdown: string,
  search: string,
): { start: number; end: number } | null {
  if (!search) return null;

  const directIdx = markdown.indexOf(search);
  if (directIdx >= 0) {
    return expandRangeToIncludeFullyWrappedAuthoredSpan(markdown, directIdx, directIdx + search.length);
  }

  const { stripped, map } = buildStrippedIndexMap(markdown);
  const strippedIdx = stripped.indexOf(search);
  if (strippedIdx < 0) return null;

  const origStart = map[strippedIdx] ?? -1;
  const origEnd = map[strippedIdx + search.length - 1];
  if (origStart < 0 || origEnd === undefined) return null;
  return expandRangeToIncludeFullyWrappedAuthoredSpan(markdown, origStart, origEnd + 1);
}

function resolveInsertAfterIndex(markdown: string, after: string): number {
  if (!after) return -1;

  const directIdx = markdown.indexOf(after);
  if (directIdx >= 0) {
    return moveIndexPastTrailingAuthoredSpans(markdown, directIdx + after.length);
  }

  const { stripped, map } = buildStrippedIndexMap(markdown);
  const strippedIdx = stripped.indexOf(after);
  if (strippedIdx < 0) return -1;

  const origEnd = map[strippedIdx + after.length - 1];
  if (origEnd === undefined) return -1;
  return moveIndexPastTrailingAuthoredSpans(markdown, origEnd + 1);
}

export function applyAgentEditOperations(
  markdown: string,
  operations: AgentEditOperation[],
  options?: { by?: string },
): AgentEditApplyResult {
  let src = normalizeNewlines(markdown ?? '');
  const by = options?.by;

  for (let opIndex = 0; opIndex < operations.length; opIndex++) {
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
      const insertion = `\n\n${content.trim()}\n`;
      src = spliceAt(src, idx, insertion);
      continue;
    }

    if (operation.op === 'replace') {
      const search = operation.search ?? '';
      const range = resolveReplaceRange(src, search);
      if (!range) {
        return {
          ok: false,
          code: 'ANCHOR_NOT_FOUND',
          message: `replace anchor not found: ${JSON.stringify(search)}`,
          opIndex,
        };
      }
      const allowWrap = !isWithinFencedCodeBlock(src, range.start);
      const content = maybeWrapAuthored(operation.content ?? '', by, allowWrap);
      src = `${src.slice(0, range.start)}${content}${src.slice(range.end)}`;
      continue;
    }

    if (operation.op === 'insert') {
      const after = operation.after ?? '';
      const insertAt = resolveInsertAfterIndex(src, after);

      if (insertAt < 0) {
        return {
          ok: false,
          code: 'ANCHOR_NOT_FOUND',
          message: `insert anchor not found: ${JSON.stringify(after)}`,
          opIndex,
        };
      }
      const allowWrap = !isWithinFencedCodeBlock(src, insertAt);
      const content = maybeWrapAuthored(operation.content ?? '', by, allowWrap);

      // Heuristic: if inserting after a heading line, insert on the next line with spacing.
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
      continue;
    }
  }

  return { ok: true, markdown: src };
}
