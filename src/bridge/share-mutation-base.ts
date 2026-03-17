import { canonicalizeStoredMarks } from '../formats/marks.js';

function stableSortValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => stableSortValue(entry));
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = stableSortValue(entryValue);
  }
  return sorted;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableSortValue(value));
}

export function stripEphemeralCollabSpansForMutationBase(markdown: string): string {
  if (!markdown || markdown.indexOf('<span') === -1) return markdown;

  const cursorSpanPattern = /<span\b[^>]*(?:ProseMirror-yjs-cursor|proof-collab-cursor|proof-agent-cursor|data-proof-cursor|data-agent-cursor)[^>]*>[\s\S]*?<\/span>/gi;
  let sanitized = markdown;
  let previous = '';
  while (sanitized !== previous) {
    previous = sanitized;
    sanitized = sanitized.replace(cursorSpanPattern, '');
  }

  return sanitized.replace(/\u2060/g, '');
}

export function normalizeShareMutationBaseMarkdown(markdown: string | null | undefined): string {
  return stripEphemeralCollabSpansForMutationBase(markdown ?? '').replace(/\r\n/g, '\n');
}

export function normalizeShareMutationBaseMarks(marks: Record<string, unknown>): Record<string, unknown> {
  try {
    return canonicalizeStoredMarks(marks) as Record<string, unknown>;
  } catch {
    return marks;
  }
}

async function sha256Hex(input: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildShareMutationBaseToken(args: {
  markdown: string;
  marks: Record<string, unknown>;
  accessEpoch: number;
}): Promise<string | null> {
  const hash = await sha256Hex(stableStringify({
    schemaVersion: 'mt1',
    markdown: normalizeShareMutationBaseMarkdown(args.markdown),
    marks: normalizeShareMutationBaseMarks(args.marks),
    accessEpoch: Math.max(0, Math.trunc(args.accessEpoch)),
  }));
  return hash ? `mt1:${hash}` : null;
}
