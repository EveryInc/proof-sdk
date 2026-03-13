import {
  canonicalizeStoredMarks,
  normalizeQuote,
  type StoredMark,
} from '@proof/core/marks';
import { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback } from './milkdown-headless.js';
import type { Node as ProseMirrorNode, Schema } from '@milkdown/prose/model';
import { buildTextIndex } from '@proof/editor/utils/text-range';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractAuthoredMarksFromDoc(
  doc: ProseMirrorNode,
  _schema: Schema,
): Record<string, StoredMark> {
  const textIndex = buildTextIndex(doc);
  const segments: Array<{ id: string | null; by: string; from: number; to: number }> = [];
  const authoredTypeName = 'proofAuthored';

  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (node.marks.length === 0) return true;
    const from = pos;
    const to = pos + node.nodeSize;
    for (const mark of node.marks) {
      if (mark.type.name !== authoredTypeName) continue;
      const by = typeof mark.attrs.by === 'string' && mark.attrs.by.trim() ? mark.attrs.by.trim() : 'human:unknown';
      const id = typeof mark.attrs.id === 'string' && mark.attrs.id.trim() ? mark.attrs.id.trim() : null;
      const previous = segments[segments.length - 1];
      if (
        previous
        && previous.to === from
        && previous.by === by
        && previous.id === id
      ) {
        previous.to = to;
      } else {
        segments.push({ id, by, from, to });
      }
    }
    return true;
  });

  const authored: Record<string, StoredMark> = {};
  for (const segment of segments) {
    const quote = normalizeQuote(doc.textBetween(segment.from, segment.to, '\n', '\n'));
    const id = segment.id ?? `authored:${segment.by}:${segment.from}-${segment.to}`;
    let startRel: string | undefined;
    let endRel: string | undefined;
    if (textIndex) {
      const startOffset = textIndex.positions.findIndex((pos) => pos >= segment.from);
      let endOffset = -1;
      for (let index = 0; index < textIndex.positions.length; index += 1) {
        const pos = textIndex.positions[index];
        if (typeof pos !== 'number') continue;
        if (pos < segment.to) {
          endOffset = index + 1;
        }
      }
      if (startOffset >= 0 && endOffset > startOffset) {
        startRel = `char:${startOffset}`;
        endRel = `char:${endOffset}`;
      }
    }
    authored[id] = {
      kind: 'authored',
      by: segment.by,
      createdAt: '1970-01-01T00:00:00.000Z',
      range: { from: segment.from, to: segment.to },
      quote,
      ...(startRel ? { startRel } : {}),
      ...(endRel ? { endRel } : {}),
    };
  }

  return canonicalizeStoredMarks(authored);
}

export async function extractAuthoredMarksFromMarkdown(
  markdown: string,
): Promise<Record<string, StoredMark> | null> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown ?? '');
  if (!parsed.doc) return null;
  return extractAuthoredMarksFromDoc(parsed.doc as ProseMirrorNode, parser.schema as Schema);
}

function authoredMarksEquivalent(existing: StoredMark, extracted: StoredMark): boolean {
  if (existing.kind !== 'authored' || extracted.kind !== 'authored') return false;
  const existingBy = typeof existing.by === 'string' ? existing.by.trim() : '';
  const extractedBy = typeof extracted.by === 'string' ? extracted.by.trim() : '';
  if (!existingBy || existingBy !== extractedBy) return false;

  const existingQuote = typeof existing.quote === 'string' ? normalizeQuote(existing.quote) : '';
  const extractedQuote = typeof extracted.quote === 'string' ? normalizeQuote(extracted.quote) : '';
  if (!existingQuote || existingQuote !== extractedQuote) return false;

  if (existing.startRel && extracted.startRel && existing.startRel !== extracted.startRel) return false;
  if (existing.endRel && extracted.endRel && existing.endRel !== extracted.endRel) return false;

  if (existing.range && extracted.range) {
    if (existing.range.from !== extracted.range.from || existing.range.to !== extracted.range.to) return false;
  }

  return true;
}

function authoredFingerprint(mark: StoredMark): string | null {
  if (mark.kind !== 'authored') return null;
  const by = typeof mark.by === 'string' ? mark.by.trim() : '';
  const quote = typeof mark.quote === 'string' ? normalizeQuote(mark.quote) : '';
  if (!by || !quote) return null;
  return `${by}::${quote}`;
}

function authoredOrder(mark: StoredMark): number {
  if (typeof mark.startRel === 'string' && mark.startRel.startsWith('char:')) {
    const parsed = Number.parseInt(mark.startRel.slice(5), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (mark.range && typeof mark.range.from === 'number' && Number.isFinite(mark.range.from)) {
    return mark.range.from;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function synchronizeAuthoredMarks(
  existingMarks: Record<string, unknown>,
  authoredMarks: Record<string, StoredMark>,
  options?: { preserveExistingAnchors?: boolean },
): Record<string, StoredMark> {
  const merged: Record<string, unknown> = {};
  const existingAuthoredEntries = Object.entries(existingMarks)
    .filter(([, mark]) => isRecord(mark) && mark.kind === 'authored')
    .map(([id, mark]) => [id, mark as StoredMark] as const)
    .sort(([, left], [, right]) => authoredOrder(left) - authoredOrder(right));
  const existingAuthoredById = new Map(existingAuthoredEntries);
  const existingAuthoredByFingerprint = new Map<string, Array<readonly [string, StoredMark]>>();
  for (const entry of existingAuthoredEntries) {
    const fingerprint = authoredFingerprint(entry[1]);
    if (!fingerprint) continue;
    const group = existingAuthoredByFingerprint.get(fingerprint);
    if (group) {
      group.push(entry);
    } else {
      existingAuthoredByFingerprint.set(fingerprint, [entry]);
    }
  }
  const extractedAuthoredEntries = Object.entries(authoredMarks)
    .sort(([, left], [, right]) => authoredOrder(left) - authoredOrder(right));
  const usedExistingAuthoredIds = new Set<string>();
  for (const [id, mark] of Object.entries(existingMarks)) {
    if (isRecord(mark) && mark.kind === 'authored') continue;
    merged[id] = mark;
  }
  for (const [id, mark] of extractedAuthoredEntries) {
    const exactExisting = existingAuthoredById.get(id);
    const fingerprint = authoredFingerprint(mark);
    const fingerprintMatches = fingerprint
      ? (existingAuthoredByFingerprint.get(fingerprint) ?? [])
      : [];
    const existingMatch = exactExisting && !usedExistingAuthoredIds.has(id)
      ? [id, exactExisting] as const
      : fingerprintMatches.find(([existingId]) => !usedExistingAuthoredIds.has(existingId))
        ?? existingAuthoredEntries.find(([existingId, existingMark]) => (
          !usedExistingAuthoredIds.has(existingId)
          && authoredMarksEquivalent(existingMark, mark)
        ));
    if (existingMatch) {
      const [existingId, existingMark] = existingMatch;
      usedExistingAuthoredIds.add(existingId);
      merged[existingId] = {
        ...existingMark,
        ...mark,
        createdAt: existingMark.createdAt ?? mark.createdAt,
        range: options?.preserveExistingAnchors
          ? (existingMark.range ?? mark.range)
          : (mark.range ?? existingMark.range),
        startRel: options?.preserveExistingAnchors
          ? (existingMark.startRel ?? mark.startRel)
          : (mark.startRel ?? existingMark.startRel),
        endRel: options?.preserveExistingAnchors
          ? (existingMark.endRel ?? mark.endRel)
          : (mark.endRel ?? existingMark.endRel),
      };
      continue;
    }
    merged[id] = mark;
  }
  return canonicalizeStoredMarks(merged);
}
