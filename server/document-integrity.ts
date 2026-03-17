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

export type DocumentIntegritySummary = {
  topLevelBlockCount: number;
  headingSequenceHash: string;
  repeatedHeadings: string[];
  repeatedSectionSignatures: string[];
};

type RepeatedStructureInput = Pick<
  DocumentIntegritySummary,
  'topLevelBlockCount' | 'repeatedHeadings' | 'repeatedSectionSignatures'
>;

export function analyzeRepeatedStructureDelta(
  candidate: RepeatedStructureInput,
  baseline: RepeatedStructureInput | null = null,
  options: { blockGrowthThreshold?: number } = {},
): {
  newRepeatedHeadings: string[];
  newRepeatedSectionSignatures: string[];
  hasRepeatedStructuralSignals: boolean;
  introducesRepeatedStructuralSignals: boolean;
  hasMeaningfulBlockGrowth: boolean;
} {
  const blockGrowthThreshold = options.blockGrowthThreshold ?? 50;
  const baselineRepeatedHeadingSet = new Set(baseline?.repeatedHeadings ?? []);
  const baselineRepeatedSectionSignatureSet = new Set(baseline?.repeatedSectionSignatures ?? []);
  const newRepeatedHeadings = candidate.repeatedHeadings.filter(
    (heading) => !baselineRepeatedHeadingSet.has(heading),
  );
  const newRepeatedSectionSignatures = candidate.repeatedSectionSignatures.filter(
    (signature) => !baselineRepeatedSectionSignatureSet.has(signature),
  );

  return {
    newRepeatedHeadings,
    newRepeatedSectionSignatures,
    hasRepeatedStructuralSignals: candidate.repeatedHeadings.length > 0
      && candidate.repeatedSectionSignatures.length > 0,
    introducesRepeatedStructuralSignals: newRepeatedHeadings.length > 0
      && newRepeatedSectionSignatures.length > 0,
    hasMeaningfulBlockGrowth: baseline === null
      || candidate.topLevelBlockCount > baseline.topLevelBlockCount + blockGrowthThreshold,
  };
}

export function summarizeDocumentIntegrity(markdown: string): DocumentIntegritySummary {
  const headingSequence = extractHeadingSequence(markdown);
  const headingCounts = new Map<string, number>();
  const sectionSignatureCounts = new Map<string, number>();
  for (const heading of headingSequence) {
    headingCounts.set(heading, (headingCounts.get(heading) ?? 0) + 1);
  }
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  for (let index = 0; index < blocks.length; index += 1) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/m.exec(blocks[index] ?? '');
    if (!headingMatch) continue;
    const normalizedHeading = normalizeHeadingText(headingMatch[2] ?? '');
    if (!normalizedHeading) continue;
    const nextBlock = blocks[index + 1] ?? '';
    const signature = createHash('sha256')
      .update(`${headingMatch[1]?.length ?? 0}:${normalizedHeading}\n${nextBlock}`)
      .digest('hex')
      .slice(0, 16);
    sectionSignatureCounts.set(signature, (sectionSignatureCounts.get(signature) ?? 0) + 1);
  }
  const repeatedHeadings = Array.from(headingCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([heading]) => heading)
    .sort()
    .slice(0, 10);
  const repeatedSectionSignatures = Array.from(sectionSignatureCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([signature]) => signature)
    .sort()
    .slice(0, 10);

  return {
    topLevelBlockCount: estimateTopLevelBlockCount(markdown),
    headingSequenceHash: createHash('sha256').update(headingSequence.join('\n')).digest('hex').slice(0, 16),
    repeatedHeadings,
    repeatedSectionSignatures,
  };
}
