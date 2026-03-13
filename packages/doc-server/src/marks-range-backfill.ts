import { hasMaintenanceRun, listActiveDocuments, recordMaintenanceRun, updateMarks } from './db.js';

const RUN_KEY = 'legacy-mark-range-backfill-v1';

type StoredMarkLike = {
  quote?: unknown;
  range?: unknown;
  [key: string]: unknown;
};

type BackfillStats = {
  docsScanned: number;
  docsUpdated: number;
  marksScanned: number;
  marksBackfilled: number;
  marksSkipped: number;
  parseErrors: number;
};

type CharSpan = { start: number; end: number };

function normalizeMatchChar(ch: string): string {
  if (ch === '\u200B' || ch === '\uFEFF') return '';
  if (/\s/.test(ch)) return ' ';
  switch (ch) {
    case '\u2018':
    case '\u2019':
    case '\u201B':
    case '\u2032':
    case '\u02BC':
      return '\'';
    case '\u201C':
    case '\u201D':
    case '\u2033':
      return '"';
    case '\u2010':
    case '\u2011':
    case '\u2012':
    case '\u2013':
    case '\u2014':
    case '\u2212':
      return '-';
    default:
      return ch;
  }
}

function buildNormalizedIndex(text: string): { text: string; map: CharSpan[] } {
  const chars: string[] = [];
  const map: CharSpan[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const normalized = normalizeMatchChar(text[i]);
    if (!normalized) continue;

    if (normalized === ' ') {
      if (lastWasSpace) {
        const prev = map[map.length - 1];
        if (prev) prev.end = i;
      } else {
        chars.push(' ');
        map.push({ start: i, end: i });
        lastWasSpace = true;
      }
      continue;
    }

    chars.push(normalized);
    map.push({ start: i, end: i });
    lastWasSpace = false;
  }

  return { text: chars.join(''), map };
}

function normalizeForMatch(text: string): string {
  return buildNormalizedIndex(text).text.trim();
}

function hasValidRange(value: unknown): boolean {
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

function findUniqueRange(markdown: string, quote: string): { from: number; to: number } | null {
  // Fast path: exact unique match in raw markdown.
  const exactStart = markdown.indexOf(quote);
  if (exactStart !== -1) {
    const secondExact = markdown.indexOf(quote, exactStart + quote.length);
    if (secondExact === -1) {
      const startOffset = exactStart;
      const endOffset = exactStart + quote.length;
      // ProseMirror positions are typically one-based inside the document.
      return { from: startOffset + 1, to: endOffset + 1 };
    }
  }

  // Fallback: normalized unique match (whitespace + smart punctuation tolerant).
  const normalizedQuote = normalizeForMatch(quote);
  if (!normalizedQuote) return null;

  const normalized = buildNormalizedIndex(markdown);
  const first = normalized.text.indexOf(normalizedQuote);
  if (first === -1) return null;
  const second = normalized.text.indexOf(normalizedQuote, first + normalizedQuote.length);
  if (second !== -1) return null;

  const startRaw = normalized.map[first]?.start;
  const endRawInclusive = normalized.map[first + normalizedQuote.length - 1]?.end;
  if (startRaw === undefined || endRawInclusive === undefined) return null;

  const endRawExclusive = endRawInclusive + 1;
  return { from: startRaw + 1, to: endRawExclusive + 1 };
}

function parseMarks(raw: string): Record<string, StoredMarkLike> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, StoredMarkLike>;
  } catch {
    return null;
  }
}

export function backfillLegacyMarkRanges(): BackfillStats {
  const stats: BackfillStats = {
    docsScanned: 0,
    docsUpdated: 0,
    marksScanned: 0,
    marksBackfilled: 0,
    marksSkipped: 0,
    parseErrors: 0,
  };

  const docs = listActiveDocuments();
  for (const doc of docs) {
    stats.docsScanned += 1;

    const marks = parseMarks(doc.marks);
    if (!marks) {
      stats.parseErrors += 1;
      continue;
    }

    let docChanged = false;

    for (const [id, mark] of Object.entries(marks)) {
      stats.marksScanned += 1;
      if (hasValidRange(mark.range)) {
        continue;
      }

      const quote = typeof mark.quote === 'string' ? mark.quote.trim() : '';
      if (!quote) {
        stats.marksSkipped += 1;
        continue;
      }

      const range = findUniqueRange(doc.markdown, quote);
      if (!range) {
        stats.marksSkipped += 1;
        continue;
      }

      marks[id] = { ...mark, range };
      stats.marksBackfilled += 1;
      docChanged = true;
    }

    if (docChanged) {
      updateMarks(doc.slug, marks as Record<string, unknown>);
      stats.docsUpdated += 1;
    }
  }

  return stats;
}

export function runLegacyMarkRangeBackfillOnce(): void {
  if (process.env.SHARE_SKIP_MARK_RANGE_BACKFILL === '1') {
    console.log('[backfill] Skipping legacy mark range backfill (env override)');
    return;
  }

  if (hasMaintenanceRun(RUN_KEY)) {
    console.log('[backfill] Legacy mark range backfill already completed');
    return;
  }

  const stats = backfillLegacyMarkRanges();
  recordMaintenanceRun(RUN_KEY, stats);
  console.log('[backfill] Legacy mark range backfill complete', stats);
}
