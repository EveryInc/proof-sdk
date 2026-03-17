export function canonicalizeVisibleTextBlockSeparators(text: string): string {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+|\n+$/g, '');
}

export function stripMarkdownVisibleText(markdown: string): string {
  let text = markdown ?? '';

  // Replace block-level tags with visible-text block separators, then remove remaining tags.
  text = text.replace(/<\/?(?:p|br|div|li)\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');

  // Convert images/links to their visible text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

  // Strip fenced code blocks but keep inner text.
  text = text.replace(/```([\s\S]*?)```/g, '$1');
  text = text.replace(/~~~([\s\S]*?)~~~/g, '$1');

  // Strip inline code markers.
  text = text.replace(/`([^`]+)`/g, '$1');

  // Strip common emphasis/strike markers.
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/(?<!\w)___([^_]+)___(?!\w)/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(?<!\w)__([^_]+)__(?!\w)/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');

  // Remove markdown line prefixes (headings, lists, blockquotes).
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');
  text = text.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '');
  text = text.replace(/^[ \t]*\[(?: |x|X)\][ \t]+/gm, '');
  text = text.replace(/^[ \t]*([-*_]){3,}[ \t]*$/gm, '');

  // Unescape markdown escapes.
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1');

  return text;
}

type AnchorTargetTextShape = {
  anchor: string;
  contextBefore?: string;
  contextAfter?: string;
};

export function canonicalizeAnchorTargetText<T extends AnchorTargetTextShape>(target: T): T {
  const next: Record<string, unknown> = {
    ...target,
    anchor: canonicalizeVisibleTextBlockSeparators(stripMarkdownVisibleText(String(target.anchor ?? ''))),
  };

  if (typeof target.contextBefore === 'string') {
    const contextBefore = canonicalizeVisibleTextBlockSeparators(stripMarkdownVisibleText(target.contextBefore));
    if (contextBefore) next.contextBefore = contextBefore;
    else delete next.contextBefore;
  }

  if (typeof target.contextAfter === 'string') {
    const contextAfter = canonicalizeVisibleTextBlockSeparators(stripMarkdownVisibleText(target.contextAfter));
    if (contextAfter) next.contextAfter = contextAfter;
    else delete next.contextAfter;
  }

  return next as T;
}
