/**
 * Code Block Schema Extension
 *
 * Extends the default code_block schema to allow proof marks on code blocks.
 * Marks are encoded in the fence meta and restored on parse.
 */

import { $nodeSchema, $nodeAttr } from '@milkdown/kit/utils';
import type { Node as ProseMirrorNode, Mark } from '@milkdown/kit/prose/model';

// Types for encoded proof marks
interface EncodedMark {
  type: string;  // 'proofComment', 'proofAuthored', etc.
  from: number;
  to: number;
  attrs: Record<string, unknown>;
}

// Extended attributes for code block
export const codeBlockAttrExt = $nodeAttr('code_block', () => ({
  pre: {},
  code: {},
}));

/**
 * Extract proof marks from a code block node
 */
function extractProofMarks(node: ProseMirrorNode): EncodedMark[] {
  const marks: EncodedMark[] = [];
  let offset = 0;

  node.forEach((child, childOffset) => {
    if (child.isText && child.marks.length > 0) {
      for (const mark of child.marks) {
        // Only encode proof marks
        if (mark.type.name.startsWith('proof')) {
          marks.push({
            type: mark.type.name,
            from: offset,
            to: offset + child.nodeSize,
            attrs: { ...mark.attrs },
          });
        }
      }
    }
    offset += child.nodeSize;
  });

  // Merge adjacent marks of the same type/attrs
  const merged: EncodedMark[] = [];
  for (const mark of marks) {
    const last = merged[merged.length - 1];
    if (last && last.type === mark.type && last.to === mark.from &&
        JSON.stringify(last.attrs) === JSON.stringify(mark.attrs)) {
      last.to = mark.to;
    } else {
      merged.push(mark);
    }
  }

  return merged;
}

/**
 * Encode marks as base64 JSON for the fence meta
 */
function encodeMarksForMeta(marks: EncodedMark[]): string {
  if (marks.length === 0) return '';
  const json = JSON.stringify(marks);
  // Use base64 to avoid issues with special characters in meta. In Node (headless parser),
  // `btoa`/`atob` may be unavailable, so fall back to Buffer.
  return 'proof:' + base64EncodeUtf8(json);
}

/**
 * Decode marks from fence meta
 */
function decodeMarksFromMeta(meta: string | undefined): EncodedMark[] {
  if (!meta) return [];

  // Look for proof: prefix
  const proofPrefix = 'proof:';
  const proofIndex = meta.indexOf(proofPrefix);
  if (proofIndex === -1) return [];

  // Extract the base64 part (everything after proof: until space or end)
  const start = proofIndex + proofPrefix.length;
  let end = meta.indexOf(' ', start);
  if (end === -1) end = meta.length;
  const base64 = meta.slice(start, end);

  try {
    const json = base64DecodeUtf8(base64);
    return JSON.parse(json) as EncodedMark[];
  } catch (e) {
    console.warn('[code-block-ext] Failed to decode proof marks from meta:', e);
    return [];
  }
}

function base64EncodeUtf8(text: string): string {
  const btoaFn = (globalThis as any).btoa as ((input: string) => string) | undefined;
  if (typeof btoaFn === 'function') return btoaFn(text);

  const BufferImpl = (globalThis as any).Buffer as { from?: (input: string, encoding: string) => { toString: (enc: string) => string } } | undefined;
  if (BufferImpl?.from) return BufferImpl.from(text, 'utf8').toString('base64');

  throw new Error('No base64 encoder available');
}

function base64DecodeUtf8(base64: string): string {
  const atobFn = (globalThis as any).atob as ((input: string) => string) | undefined;
  if (typeof atobFn === 'function') return atobFn(base64);

  const BufferImpl = (globalThis as any).Buffer as { from?: (input: string, encoding: string) => { toString: (enc: string) => string } } | undefined;
  if (BufferImpl?.from) return BufferImpl.from(base64, 'base64').toString('utf8');

  throw new Error('No base64 decoder available');
}

/**
 * Remove proof metadata from meta string (for display purposes)
 */
function stripProofFromMeta(meta: string | undefined): string {
  if (!meta) return '';
  return meta.replace(/\s*proof:[A-Za-z0-9+/=]+\s*/g, '').trim();
}

// Extended code block schema
export const codeBlockSchemaExt = $nodeSchema('code_block', (ctx) => {
  return {
    content: 'text*',
    group: 'block',
    marks: 'proofAuthored proofSuggestion proofComment proofFlagged proofApproved',
    defining: true,
    code: true,
    attrs: {
      language: {
        default: '',
      },
    },
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (dom: HTMLElement) => ({
          language: dom.dataset.language || '',
        }),
      },
    ],
    toDOM: (node) => {
      const attr = ctx.get(codeBlockAttrExt.key)(node);
      const language = node.attrs.language;
      return [
        'pre',
        {
          ...attr.pre,
          'data-language': language || undefined,
        },
        ['code', attr.code, 0],
      ];
    },
    parseMarkdown: {
      match: ({ type }) => type === 'code',
      runner: (state, node, type) => {
        const language = node.lang as string;
        const value = node.value as string;
        const meta = node.meta as string | undefined;

        // Decode any proof marks from meta
        const proofMarks = decodeMarksFromMeta(meta);

        state.openNode(type, { language });

        if (value) {
          if (proofMarks.length === 0) {
            // No marks - simple case
            state.addText(value);
          } else {
            // Apply marks while adding text
            // Build a list of positions where marks start/end
            const events: Array<{ pos: number; type: 'open' | 'close'; mark: EncodedMark }> = [];
            for (const mark of proofMarks) {
              events.push({ pos: mark.from, type: 'open', mark });
              events.push({ pos: mark.to, type: 'close', mark });
            }
            // Sort by position, opens before closes at same position
            events.sort((a, b) => {
              if (a.pos !== b.pos) return a.pos - b.pos;
              return a.type === 'open' ? -1 : 1;
            });

            // Track active marks
            const activeMarks: Map<string, EncodedMark> = new Map();
            let lastPos = 0;

            for (const event of events) {
              // Add text from lastPos to event.pos
              if (event.pos > lastPos && event.pos <= value.length) {
                const text = value.slice(lastPos, event.pos);
                if (text) {
                  state.addText(text);
                }
                lastPos = event.pos;
              }

              // Open or close mark
              const markKey = `${event.mark.type}-${JSON.stringify(event.mark.attrs)}`;
              if (event.type === 'open') {
                const markType = state.schema.marks[event.mark.type];
                if (markType) {
                  state.openMark(markType, event.mark.attrs);
                  activeMarks.set(markKey, event.mark);
                }
              } else {
                const markType = state.schema.marks[event.mark.type];
                if (markType && activeMarks.has(markKey)) {
                  state.closeMark(markType);
                  activeMarks.delete(markKey);
                }
              }
            }

            // Add remaining text
            if (lastPos < value.length) {
              state.addText(value.slice(lastPos));
            }

            // Close any remaining open marks
            for (const [, mark] of activeMarks) {
              const markType = state.schema.marks[mark.type];
              if (markType) {
                state.closeMark(markType);
              }
            }
          }
        }

        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'code_block',
      runner: (state, node) => {
        // Extract proof marks from the code block
        const proofMarks = extractProofMarks(node);
        const encodedMarks = encodeMarksForMeta(proofMarks);

        // Build meta: language first, then proof marks if any
        let meta = node.attrs.language || '';
        if (encodedMarks) {
          meta = meta ? `${meta} ${encodedMarks}` : encodedMarks;
        }

        state.addNode('code', undefined, node.textContent, {
          lang: node.attrs.language || undefined,
          meta: encodedMarks || undefined,
        });
      },
    },
  };
});

export const codeBlockExtPlugins = [codeBlockAttrExt, codeBlockSchemaExt];
