import type { Node as ProseMirrorNode, Schema } from '@milkdown/kit/prose/model';

function createExplicitBlankParagraphPlaceholder(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `fallback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `PROOF_EMPTY_PARAGRAPH_${uuid}`;
}

const EXPLICIT_BLANK_PARAGRAPH_PLACEHOLDER = createExplicitBlankParagraphPlaceholder();

type FencedCodeBlockState = {
  marker: '`' | '~';
  length: number;
};

function getFenceOpening(line: string): FencedCodeBlockState | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const fence = match[1];
  return {
    marker: fence[0] as '`' | '~',
    length: fence.length,
  };
}

function closesFence(line: string, fence: FencedCodeBlockState): boolean {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
  if (!match) return false;
  const markerRun = match[1];
  return markerRun[0] === fence.marker && markerRun.length >= fence.length;
}

function replaceStandaloneBlankParagraphLines(markdown: string): string {
  const lines = markdown.split('\n');
  let activeFence: FencedCodeBlockState | null = null;

  return lines.map((line) => {
    if (activeFence) {
      if (closesFence(line, activeFence)) {
        activeFence = null;
      }
      return line;
    }

    const nextFence = getFenceOpening(line);
    if (nextFence) {
      activeFence = nextFence;
      return line;
    }

    return /^\s*<br\s*\/?>\s*$/i.test(line) ? EXPLICIT_BLANK_PARAGRAPH_PLACEHOLDER : line;
  }).join('\n');
}

function expandBlankLineRun(blankLineCount: number): string[] {
  if (blankLineCount < 2) return Array.from({ length: blankLineCount }, () => '');
  const blankParagraphs = Math.max(1, Math.floor(blankLineCount / 2));
  return ['', ...Array.from({ length: blankParagraphs }, () => ['<br />', '']).flat()];
}

export function restoreStandaloneBlankParagraphLines(markdown: string): string {
  const lines = markdown.split('\n');
  const restored: string[] = [];
  let activeFence: FencedCodeBlockState | null = null;
  let pendingBlankLineCount = 0;

  const flushPendingBlankLines = (): void => {
    if (pendingBlankLineCount <= 0) return;
    restored.push(...expandBlankLineRun(pendingBlankLineCount));
    pendingBlankLineCount = 0;
  };

  for (const line of lines) {
    if (activeFence) {
      if (closesFence(line, activeFence)) {
        activeFence = null;
      }
      flushPendingBlankLines();
      restored.push(line);
      continue;
    }

    const nextFence = getFenceOpening(line);
    if (nextFence) {
      flushPendingBlankLines();
      activeFence = nextFence;
      restored.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      pendingBlankLineCount += 1;
      continue;
    }

    flushPendingBlankLines();
    restored.push(line);
  }

  flushPendingBlankLines();
  return restored.join('\n');
}

function isPlaceholderParagraph(node: ProseMirrorNode, schema: Schema): boolean {
  return node.type === schema.nodes.paragraph
    && node.childCount === 1
    && node.firstChild?.isText === true
    && node.textContent === EXPLICIT_BLANK_PARAGRAPH_PLACEHOLDER;
}

export function prepareMarkdownForEditorLoad(markdown: string): string {
  return replaceStandaloneBlankParagraphLines(markdown);
}

export function restoreExplicitBlankParagraphPlaceholders(
  node: ProseMirrorNode,
  schema: Schema,
): ProseMirrorNode {
  if (isPlaceholderParagraph(node, schema)) {
    return schema.nodes.paragraph.create();
  }

  if (node.childCount === 0) return node;

  const nextChildren: ProseMirrorNode[] = [];
  let changed = false;
  node.forEach((child) => {
    const nextChild = restoreExplicitBlankParagraphPlaceholders(child, schema);
    if (nextChild !== child) changed = true;
    nextChildren.push(nextChild);
  });

  return changed ? node.type.create(node.attrs, nextChildren, node.marks) : node;
}

export function parseMarkdownPreservingExplicitBlankParagraphs(options: {
  markdown: string;
  parser: (markdown: string) => ProseMirrorNode;
  schema: Schema;
}): ProseMirrorNode {
  const prepared = prepareMarkdownForEditorLoad(options.markdown);
  const parsed = options.parser(prepared);
  return restoreExplicitBlankParagraphPlaceholders(parsed, options.schema);
}

export function __unsafeGetExplicitBlankParagraphPlaceholderForTests(): string {
  return EXPLICIT_BLANK_PARAGRAPH_PLACEHOLDER;
}
