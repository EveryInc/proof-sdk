const authoredProofAttrRegex = /data-proof\s*=\s*(?:"authored"|'authored'|authored)/i;
const anyProofAttrRegex = /data-proof\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i;

type ProofReplacementMark = {
  kind?: unknown;
  quote?: unknown;
};

type AuthoredSpanBounds = {
  openStart: number;
  contentStart: number;
  contentEnd: number;
  closeEnd: number;
};

type ProofRange = {
  id: string;
  start: number;
  end: number;
};

type StripStackEntry = {
  isProof: boolean;
  proofId: string | null;
  contentStart: number;
};

function isAuthoredProofSpan(tag: string): boolean {
  return authoredProofAttrRegex.test(tag);
}

function isAnyProofSpan(tag: string): boolean {
  return anyProofAttrRegex.test(tag);
}

function extractProofSpanId(tag: string): string | null {
  const match = tag.match(/data-id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const id = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

function hasActiveSuppression(stack: Array<{ suppressContent: boolean }>): boolean {
  return stack.some((entry) => entry.suppressContent);
}

function collectStrippedProofData(
  markdown: string,
  shouldStrip: (tag: string) => boolean,
): { stripped: string; proofRanges: ProofRange[] } {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const stack: StripStackEntry[] = [];
  const proofRanges: ProofRange[] = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];
    result += markdown.slice(lastIndex, index);
    lastIndex = index + tag.length;

    if (tag.startsWith('</')) {
      if (stack.length === 0) {
        result += tag;
        continue;
      }
      const entry = stack.pop();
      if (!entry) continue;
      if (entry.isProof) {
        if (entry.proofId && result.length >= entry.contentStart) {
          proofRanges.push({
            id: entry.proofId,
            start: entry.contentStart,
            end: result.length,
          });
        }
      } else {
        result += tag;
      }
      continue;
    }

    const isProof = shouldStrip(tag);
    if (isProof) {
      stack.push({
        isProof: true,
        proofId: extractProofSpanId(tag),
        contentStart: result.length,
      });
      continue;
    }

    result += tag;
    stack.push({
      isProof: false,
      proofId: null,
      contentStart: result.length,
    });
  }

  result += markdown.slice(lastIndex);
  return { stripped: result, proofRanges };
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  if (sorted.length === 0) return [];

  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0] }];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function isGapFullyCovered(
  coverage: Array<{ start: number; end: number }>,
  start: number,
  end: number,
): boolean {
  if (end <= start) return true;
  let cursor = start;
  for (const range of coverage) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) return false;
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) return true;
  }
  return false;
}

function buildReplacementGroups(
  proofRanges: ProofRange[],
  replacementsById: Record<string, string>,
): Array<{ start: number; end: number; replacement: string }> {
  const replacementIds = Object.keys(replacementsById);
  if (replacementIds.length === 0 || proofRanges.length === 0) return [];

  const rangesById = new Map<string, ProofRange[]>();
  for (const range of proofRanges) {
    if (!(range.id in replacementsById) || range.end <= range.start) continue;
    const existing = rangesById.get(range.id);
    if (existing) {
      existing.push(range);
    } else {
      rangesById.set(range.id, [range]);
    }
  }

  const coverage = mergeRanges(proofRanges.map(({ start, end }) => ({ start, end })));
  const groups: Array<{ start: number; end: number; replacement: string }> = [];

  for (const [id, ranges] of rangesById.entries()) {
    const replacement = replacementsById[id];
    if (typeof replacement !== 'string') continue;
    const sorted = [...ranges].sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let currentStart = sorted[0]?.start ?? -1;
    let currentEnd = sorted[0]?.end ?? -1;

    for (let index = 1; index < sorted.length; index += 1) {
      const next = sorted[index];
      if (next.start <= currentEnd || isGapFullyCovered(coverage, currentEnd, next.start)) {
        currentEnd = Math.max(currentEnd, next.end);
        continue;
      }
      if (currentEnd > currentStart) {
        groups.push({ start: currentStart, end: currentEnd, replacement });
      }
      currentStart = next.start;
      currentEnd = next.end;
    }

    if (currentEnd > currentStart) {
      groups.push({ start: currentStart, end: currentEnd, replacement });
    }
  }

  groups.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const selected: Array<{ start: number; end: number; replacement: string }> = [];
  for (const group of groups) {
    const previous = selected[selected.length - 1];
    if (previous && group.start >= previous.start && group.end <= previous.end) {
      continue;
    }
    selected.push(group);
  }
  return selected;
}

function applyReplacementGroups(
  stripped: string,
  groups: Array<{ start: number; end: number; replacement: string }>,
): string {
  if (groups.length === 0) return stripped;
  let result = '';
  let cursor = 0;
  for (const group of groups) {
    if (group.start < cursor) continue;
    result += stripped.slice(cursor, group.start);
    result += group.replacement;
    cursor = group.end;
  }
  result += stripped.slice(cursor);
  return result;
}

function stripProofSpanTagsInternal(
  markdown: string,
  shouldStrip: (tag: string) => boolean,
  replacementsById?: Record<string, string>,
): string {
  if (replacementsById) {
    const { stripped, proofRanges } = collectStrippedProofData(markdown, shouldStrip);
    return applyReplacementGroups(stripped, buildReplacementGroups(proofRanges, replacementsById));
  }

  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const proofStack: Array<{ isProof: boolean; suppressContent: boolean }> = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];

    if (!hasActiveSuppression(proofStack)) {
      result += markdown.slice(lastIndex, index);
    }
    lastIndex = index + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (proofStack.length === 0) {
        if (!hasActiveSuppression(proofStack)) {
          result += tag;
        }
        continue;
      }
      const entry = proofStack.pop();
      if (entry && !entry.isProof && !hasActiveSuppression(proofStack)) {
        result += tag;
      }
      continue;
    }

    const isProof = shouldStrip(tag);
    const replacementId = isProof ? extractProofSpanId(tag) : null;
    const replacement = replacementId ? replacementsById?.[replacementId] : null;
    const suppressContent = Boolean(isProof && typeof replacement === 'string');
    proofStack.push({ isProof, suppressContent });
    if (suppressContent) {
      result += replacement;
    }
    if (!isProof) {
      if (!hasActiveSuppression(proofStack.slice(0, -1))) {
        result += tag;
      }
    }
  }

  if (!hasActiveSuppression(proofStack)) {
    result += markdown.slice(lastIndex);
  }
  return result;
}

/**
 * Strip Proof-authored `<span data-proof="authored" ...>` HTML tags from markdown,
 * leaving the inner text content intact. Non-Proof `<span>` tags are preserved.
 *
 * Used by:
 * - Agent snapshot endpoint (block markdown)
 * - Agent edit operations (anchor/search matching)
 * - Share text/markdown content negotiation
 */
export function stripProofSpanTags(markdown: string): string {
  return stripProofSpanTagsInternal(markdown, isAuthoredProofSpan);
}

/**
 * Strip all Proof `<span data-proof="...">` wrappers from markdown while preserving
 * their inner text. Non-Proof spans remain intact.
 */
export function stripAllProofSpanTags(markdown: string): string {
  return stripProofSpanTagsInternal(markdown, isAnyProofSpan);
}

export function stripAllProofSpanTagsWithReplacements(
  markdown: string,
  replacementsById: Record<string, string>,
): string {
  return stripProofSpanTagsInternal(markdown, isAnyProofSpan, replacementsById);
}

export function buildProofSpanReplacementMap<T extends ProofReplacementMark>(
  marks: Record<string, T>,
): Record<string, string> {
  const replacements: Record<string, string> = {};
  for (const [id, mark] of Object.entries(marks)) {
    if (typeof mark?.quote !== 'string' || mark.quote.trim().length === 0) continue;
    if (
      mark.kind === 'comment'
      || mark.kind === 'insert'
      || mark.kind === 'delete'
      || mark.kind === 'replace'
      || mark.kind === 'approved'
      || mark.kind === 'flagged'
    ) {
      replacements[id] = mark.quote;
    }
  }
  return replacements;
}

/**
 * Build a mapping from stripped-text indices back to original-text indices.
 * Returns an array where strippedToOriginal[i] is the index in the original
 * string corresponding to position i in the stripped string.
 */
export function buildStrippedIndexMap(markdown: string): { stripped: string; map: number[] } {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const proofStack: boolean[] = [];
  const resultChars: string[] = [];
  const indexMap: number[] = [];
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const matchIndex = match.index ?? -1;
    if (matchIndex < 0) continue;
    const tag = match[0];

    // Copy characters between last tag and this tag
    for (let i = lastIndex; i < matchIndex; i++) {
      resultChars.push(markdown[i]);
      indexMap.push(i);
    }
    lastIndex = matchIndex + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (proofStack.length === 0) {
        // Non-proof closing tag — keep it
        for (let i = matchIndex; i < matchIndex + tag.length; i++) {
          resultChars.push(markdown[i]);
          indexMap.push(i);
        }
        continue;
      }
      const isProof = proofStack.pop();
      if (!isProof) {
        for (let i = matchIndex; i < matchIndex + tag.length; i++) {
          resultChars.push(markdown[i]);
          indexMap.push(i);
        }
      }
      // Proof closing tags are stripped (not added to result)
      continue;
    }

    const isProof = isAuthoredProofSpan(tag);
    proofStack.push(isProof);
    if (!isProof) {
      for (let i = matchIndex; i < matchIndex + tag.length; i++) {
        resultChars.push(markdown[i]);
        indexMap.push(i);
      }
    }
    // Proof opening tags are stripped (not added to result)
  }

  // Copy remaining characters after last tag
  for (let i = lastIndex; i < markdown.length; i++) {
    resultChars.push(markdown[i]);
    indexMap.push(i);
  }

  return { stripped: resultChars.join(''), map: indexMap };
}

export function listAuthoredProofSpanBounds(markdown: string): AuthoredSpanBounds[] {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const stack: Array<{ authored: boolean; openStart: number; contentStart: number }> = [];
  const spans: AuthoredSpanBounds[] = [];

  for (const match of markdown.matchAll(spanTagRegex)) {
    const matchIndex = match.index ?? -1;
    if (matchIndex < 0) continue;
    const tag = match[0];

    if (tag.startsWith('</')) {
      const entry = stack.pop();
      if (!entry?.authored) continue;
      spans.push({
        openStart: entry.openStart,
        contentStart: entry.contentStart,
        contentEnd: matchIndex,
        closeEnd: matchIndex + tag.length,
      });
      continue;
    }

    stack.push({
      authored: isAuthoredProofSpan(tag),
      openStart: matchIndex,
      contentStart: matchIndex + tag.length,
    });
  }

  return spans;
}

export function expandRangeToIncludeFullyWrappedAuthoredSpan(
  markdown: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let nextStart = start;
  let nextEnd = end;

  for (const span of listAuthoredProofSpanBounds(markdown)) {
    if (nextStart === span.contentStart && nextEnd === span.contentEnd) {
      nextStart = span.openStart;
      nextEnd = span.closeEnd;
      break;
    }
  }

  return { start: nextStart, end: nextEnd };
}

export function moveIndexPastTrailingAuthoredSpans(markdown: string, index: number): number {
  let nextIndex = index;

  while (true) {
    let advanced = false;
    let bestCloseEnd = nextIndex;

    for (const span of listAuthoredProofSpanBounds(markdown)) {
      if (span.contentEnd === nextIndex && span.closeEnd > bestCloseEnd) {
        bestCloseEnd = span.closeEnd;
        advanced = true;
      }
    }

    if (!advanced) return nextIndex;
    nextIndex = bestCloseEnd;
  }
}
