import { createHash } from 'crypto';

function normalizeHeadingText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+#+\s*$/g, '')
    .toLowerCase();
}

export function extractHeadingSequence(markdown: string): string[] {
  const headings: string[] = [];
  const regex = /^(#{1,6})\s+(.+?)\s*$/gm;
  for (const match of markdown.matchAll(regex)) {
    const level = match[1]?.length ?? 0;
    const rawText = match[2] ?? '';
    const normalized = normalizeHeadingText(rawText);
    if (!normalized) continue;
    headings.push(`${level}:${normalized}`);
  }
  return headings;
}

export function estimateTopLevelBlockCount(markdown: string): number {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .length;
}

export function summarizeDocumentIntegrity(markdown: string): {
  topLevelBlockCount: number;
  headingSequenceHash: string;
  repeatedHeadings: string[];
} {
  const headingSequence = extractHeadingSequence(markdown);
  const headingCounts = new Map<string, number>();
  for (const heading of headingSequence) {
    headingCounts.set(heading, (headingCounts.get(heading) ?? 0) + 1);
  }
  const repeatedHeadings = Array.from(headingCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([heading]) => heading)
    .sort()
    .slice(0, 10);

  return {
    topLevelBlockCount: estimateTopLevelBlockCount(markdown),
    headingSequenceHash: createHash('sha256').update(headingSequence.join('\n')).digest('hex').slice(0, 16),
    repeatedHeadings,
  };
}
