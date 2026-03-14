/**
 * Headless Milkdown engine for Cloudflare Workers.
 *
 * Provides ProseMirror schema + markdown parser/serializer without a DOM.
 * Ported from server/milkdown-headless.ts with import paths adjusted for
 * the cloudflare app location within the monorepo.
 */

import { Editor, editorViewCtx, marksCtx, nodesCtx, remarkStringifyOptionsCtx } from '@milkdown/core';
import { schema as commonmarkSchema } from '@milkdown/preset-commonmark';
import { schema as gfmSchema } from '@milkdown/preset-gfm';
import { Schema, type Node as ProseMirrorNode } from '@milkdown/prose/model';
import { ParserState, SerializerState } from '@milkdown/transformer';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

// Schema plugins — same as browser editor so markdown round-trips correctly
import { codeBlockExtPlugins } from '../../../src/editor/schema/code-block-ext.js';
import { frontmatterSchema } from '../../../src/editor/schema/frontmatter.js';
import { proofMarkPlugins } from '../../../src/editor/schema/proof-marks.js';
import { remarkProofMarks, proofMarkHandler } from '../../../src/formats/remark-proof-marks.js';

export type HeadlessMilkdownParser = {
  schema: Schema;
  parseMarkdown: (markdown: string) => ProseMirrorNode;
};

type HeadlessMilkdown = HeadlessMilkdownParser & {
  serializeMarkdown: (doc: ProseMirrorNode) => string;
  serializeSingleNode: (node: ProseMirrorNode) => string;
};

let enginePromise: Promise<HeadlessMilkdown> | null = null;

const INLINE_HTML_TAG_PATTERN = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^>\n]*)?\s*\/?>/g;
const STANDALONE_HTML_LINE_PATTERN = /^[ \t]*(?:<!--[^\n]*-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^>\n]*)?\s*\/?>)[ \t]*$/gm;

export function stripStandaloneHtmlLines(markdown: string): string {
  return markdown
    .replace(STANDALONE_HTML_LINE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function stripInlineHtmlTags(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(INLINE_HTML_TAG_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export type MarkdownParseFallbackMode = 'original' | 'strip_html_lines' | 'strip_html_tags' | 'failed';

export type MarkdownParseWithFallbackResult = {
  doc: ProseMirrorNode | null;
  mode: MarkdownParseFallbackMode;
  error: unknown;
};

export function parseMarkdownWithHtmlFallback(
  parser: HeadlessMilkdownParser,
  markdown: string,
): MarkdownParseWithFallbackResult {
  const input = markdown ?? '';
  const candidates: Array<{ mode: Exclude<MarkdownParseFallbackMode, 'failed'>; value: string }> = [];
  candidates.push({ mode: 'original', value: input });

  const withoutHtmlLines = stripStandaloneHtmlLines(input);
  if (withoutHtmlLines !== input) {
    candidates.push({ mode: 'strip_html_lines', value: withoutHtmlLines });
  }

  const withoutHtmlTags = stripInlineHtmlTags(withoutHtmlLines);
  if (withoutHtmlTags !== withoutHtmlLines) {
    candidates.push({ mode: 'strip_html_tags', value: withoutHtmlTags });
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return {
        doc: parser.parseMarkdown(candidate.value),
        mode: candidate.mode,
        error: null,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    doc: null,
    mode: 'failed',
    error: lastError,
  };
}

function createSerializer(schema: Schema): (doc: ProseMirrorNode) => string {
  const processor = unified()
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkStringify, {
      handlers: {
        proofMark: proofMarkHandler,
      },
    });

  return SerializerState.create(schema as any, processor as any) as unknown as (doc: ProseMirrorNode) => string;
}

async function buildHeadless(): Promise<HeadlessMilkdown> {
  const editor = Editor.make();
  const ctx = editor.ctx;

  ctx.inject(nodesCtx, []);
  ctx.inject(marksCtx, []);
  ctx.inject(remarkStringifyOptionsCtx, { handlers: {}, encode: [] } as any);

  let currentDoc: ProseMirrorNode | null = null;
  const editorViewStub = {
    state: {
      get doc() {
        return currentDoc;
      },
    },
  } as any;
  ctx.inject(editorViewCtx, editorViewStub);

  const plugins = [
    ...commonmarkSchema,
    ...gfmSchema,
    ...frontmatterSchema,
    ...codeBlockExtPlugins,
    ...proofMarkPlugins,
  ].flat();

  for (const plugin of plugins) {
    const runner = plugin(ctx);
    if (typeof runner === 'function') {
      await runner();
    }
  }

  const nodes = Object.fromEntries(ctx.get(nodesCtx) as any);
  const marks = Object.fromEntries(ctx.get(marksCtx) as any);
  const schema = new Schema({ nodes, marks });

  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkGfm)
    .use(remarkProofMarks);

  const parseMarkdown = ParserState.create(schema as any, processor as any) as unknown as (markdown: string) => ProseMirrorNode;
  const serializer = createSerializer(schema);
  const serializeMarkdown = (doc: ProseMirrorNode): string => {
    currentDoc = doc;
    return serializer(doc);
  };
  const serializeSingleNode = (node: ProseMirrorNode): string => {
    if (node.type.name === schema.topNodeType.name) {
      return serializeMarkdown(node);
    }
    const wrapper = schema.topNodeType.create(null, [node]);
    return serializeMarkdown(wrapper);
  };

  return { schema, parseMarkdown, serializeMarkdown, serializeSingleNode };
}

async function getHeadlessMilkdown(): Promise<HeadlessMilkdown> {
  if (!enginePromise) {
    enginePromise = buildHeadless().catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

export async function getHeadlessMilkdownParser(): Promise<HeadlessMilkdownParser> {
  const engine = await getHeadlessMilkdown();
  return { schema: engine.schema, parseMarkdown: engine.parseMarkdown };
}

export async function serializeMarkdown(doc: ProseMirrorNode): Promise<string> {
  const engine = await getHeadlessMilkdown();
  return engine.serializeMarkdown(doc);
}

export async function serializeSingleNode(node: ProseMirrorNode): Promise<string> {
  const engine = await getHeadlessMilkdown();
  return engine.serializeSingleNode(node);
}
