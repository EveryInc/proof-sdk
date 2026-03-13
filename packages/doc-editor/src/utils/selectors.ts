import type { Node } from '@milkdown/kit/prose/model';

export interface SelectorRange {
  from: number;
  to: number;
}

export function resolveSelector(
  doc: Node,
  selector: string,
  context?: { cursor?: number; selection?: SelectorRange | null }
): number | null {
  switch (selector) {
    case 'start':
      return 0;
    case 'end':
      return doc.content.size;
    case 'cursor':
      return context?.cursor ?? null;
    case 'selection':
      return context?.selection?.from ?? null;
  }

  if (selector.startsWith('heading:')) {
    return findHeadingPosition(doc, selector.slice(8).trim());
  }

  if (selector.startsWith('after:')) {
    return findHeadingEndPosition(doc, selector.slice(6).trim());
  }

  if (selector.startsWith('before:')) {
    return findHeadingPosition(doc, selector.slice(7).trim());
  }

  return null;
}

export function resolveSelectorRange(
  doc: Node,
  selector: string,
  context?: { cursor?: number; selection?: SelectorRange | null }
): SelectorRange | null {
  if (selector === 'all') {
    return { from: 0, to: doc.content.size };
  }

  if (selector === 'selection') {
    return context?.selection ?? null;
  }

  if (selector.startsWith('section:')) {
    return findSectionRange(doc, selector.slice(8).trim());
  }

  if (selector.startsWith('heading:')) {
    return findHeadingRange(doc, selector.slice(8).trim());
  }

  return null;
}

function findHeadingPosition(doc: Node, searchText: string): number | null {
  const normalizedSearch = normalizeHeadingText(searchText);
  let foundPos: number | null = null;

  doc.descendants((node, pos) => {
    if (foundPos !== null) return false;
    if (node.type.name === 'heading') {
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);
      if (
        normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase())
        || headingContent.toLowerCase().includes(searchText.toLowerCase())
      ) {
        foundPos = pos;
        return false;
      }
    }
    return true;
  });

  return foundPos;
}

function findHeadingEndPosition(doc: Node, searchText: string): number | null {
  const normalizedSearch = normalizeHeadingText(searchText);
  let foundPos: number | null = null;

  doc.descendants((node, pos) => {
    if (foundPos !== null) return false;
    if (node.type.name === 'heading') {
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);
      if (
        normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase())
        || headingContent.toLowerCase().includes(searchText.toLowerCase())
      ) {
        foundPos = pos + node.nodeSize;
        return false;
      }
    }
    return true;
  });

  return foundPos;
}

function findHeadingRange(doc: Node, searchText: string): SelectorRange | null {
  const normalizedSearch = normalizeHeadingText(searchText);
  let result: SelectorRange | null = null;

  doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.type.name === 'heading') {
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);
      if (
        normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase())
        || headingContent.toLowerCase().includes(searchText.toLowerCase())
      ) {
        result = { from: pos, to: pos + node.nodeSize };
        return false;
      }
    }
    return true;
  });

  return result;
}

function findSectionRange(doc: Node, searchText: string): SelectorRange | null {
  const normalizedSearch = normalizeHeadingText(searchText);
  let sectionStart: number | null = null;
  let sectionLevel: number | null = null;
  let sectionEnd: number | null = null;

  doc.descendants((node, pos) => {
    if (sectionEnd !== null) return false;
    if (node.type.name === 'heading') {
      const level = node.attrs.level || 1;
      const headingContent = node.textContent;
      const normalizedContent = normalizeHeadingText(headingContent);

      if (sectionStart === null) {
        if (
          normalizedContent.toLowerCase().includes(normalizedSearch.toLowerCase())
          || headingContent.toLowerCase().includes(searchText.toLowerCase())
        ) {
          sectionStart = pos;
          sectionLevel = level;
        }
      } else if (sectionLevel !== null && level <= sectionLevel) {
        sectionEnd = pos;
        return false;
      }
    }
    return true;
  });

  if (sectionStart !== null && sectionEnd === null) {
    sectionEnd = doc.content.size;
  }

  if (sectionStart !== null && sectionEnd !== null) {
    return { from: sectionStart, to: sectionEnd };
  }

  return null;
}

function normalizeHeadingText(text: string): string {
  return text.replace(/^#+\s*/, '').trim();
}

export function hasHeading(doc: Node, headingText: string): boolean {
  const normalizedSearch = normalizeHeadingText(headingText);
  let found = false;

  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'heading') {
      const content = node.textContent;
      if (normalizeHeadingText(content).toLowerCase() === normalizedSearch.toLowerCase()) {
        found = true;
        return false;
      }
    }
    return true;
  });

  return found;
}

export function extractHeadingFromText(text: string): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('#')) return line;
  }
  return null;
}
