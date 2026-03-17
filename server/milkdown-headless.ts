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

// Reuse the same Milkdown schema plugins + proof span remark plugin as the browser editor so
// markdown replacements can be applied into the Yjs ProseMirror fragment server-side.
import { codeBlockExtPlugins } from '../src/editor/schema/code-block-ext.js';
import { parseMarkdownPreservingExplicitBlankParagraphs } from '../src/editor/explicit-blank-paragraphs.js';
import { frontmatterSchema } from '../src/editor/schema/frontmatter.js';
import { proofMarkPlugins } from '../src/editor/schema/proof-marks.js';
import { remarkProofMarks, proofMarkHandler } from '../src/formats/remark-proof-marks.js';

export type HeadlessMilkdownParser = {
  schema: Schema;
  parseMarkdown: (markdown: string) => ProseMirrorNode;
};

export type MarkdownParseFallbackMode = 'original' | 'strip_html_lines' | 'strip_html_tags' | 'failed';

export type MarkdownParseWithFallbackResult = {
  doc: ProseMirrorNode | null;
  mode: MarkdownParseFallbackMode;
  error: unknown;
};

type HeadlessMilkdown = HeadlessMilkdownParser & {
  serializeMarkdown: (doc: ProseMirrorNode) => string;
  serializeSingleNode: (node: ProseMirrorNode) => string;
};

let enginePromise: Promise<HeadlessMilkdown> | null = null;
let resolvedEngine: HeadlessMilkdown | null = null;
let engineGeneration = 0;
let forcedWarmFailureForTests: Error | null = null;

const INLINE_HTML_TAG_PATTERN = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^>\n]*)?\s*\/?>/g;
const STANDALONE_HTML_LINE_PATTERN = /^[ \t]*(?:<!--[^\n]*-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^>\n]*)?\s*\/?>)[ \t]*$/;
const EXPLICIT_BLANK_PARAGRAPH_LINE_PATTERN = /^[ \t]*<br\s*\/?>[ \t]*$/i;

export function stripStandaloneHtmlLines(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => {
      if (EXPLICIT_BLANK_PARAGRAPH_LINE_PATTERN.test(line)) return true;
      return !STANDALONE_HTML_LINE_PATTERN.test(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function stripInlineHtmlTags(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(INLINE_HTML_TAG_PATTERN, (tag) => (EXPLICIT_BLANK_PARAGRAPH_LINE_PATTERN.test(tag) ? tag : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function summarizeParseError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

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
        doc: parseMarkdownPreservingExplicitBlankParagraphs({
          markdown: candidate.value,
          parser: parser.parseMarkdown,
          schema: parser.schema,
        }),
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

  // These slices are normally injected by Milkdown's init plugin. We only need enough
  // context for schema plugins to materialize their node/mark specs.
  ctx.inject(nodesCtx, []);
  ctx.inject(marksCtx, []);
  ctx.inject(remarkStringifyOptionsCtx, { handlers: {}, encode: [] } as any);

  // Some schema serializers reference the editor view (e.g., paragraph serialization
  // checks if the node is the last block). Provide a minimal stub that we can update
  // per serialization run to avoid ctx lookup errors in headless mode.
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
    // Frontmatter must be registered after commonmark so `---` parses as YAML.
    ...frontmatterSchema,
    ...codeBlockExtPlugins,
    // Some schema nodes reference proof marks (e.g. code_block allows them).
    ...proofMarkPlugins,
  ].flat();

  for (const plugin of plugins) {
    const runner = plugin(ctx);
    if (typeof runner === 'function') {
      // Schema plugins are async but typically complete synchronously.
      await runner();
    }
  }

  const nodes = Object.fromEntries(ctx.get(nodesCtx) as any);
  const marks = Object.fromEntries(ctx.get(marksCtx) as any);
  const schema = new Schema({ nodes, marks });

  // Match the client editor's GFM features (tables, task lists, strikethrough, autolinks, ...),
  // plus proof span parsing so authored/comment/suggestion spans round-trip into marks.
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
  if (resolvedEngine) return resolvedEngine;
  if (!enginePromise) {
    const generation = engineGeneration;
    // If initialization fails once, don't permanently poison the singleton with a rejected promise.
    enginePromise = buildHeadless()
      .then((engine) => {
        if (generation !== engineGeneration) {
          throw new Error('stale_headless_milkdown_initialization');
        }
        resolvedEngine = engine;
        return engine;
      })
      .catch((error) => {
        if (generation === engineGeneration) {
          enginePromise = null;
          resolvedEngine = null;
        }
        throw error;
      });
  }
  return enginePromise;
}

export async function getHeadlessMilkdownParser(): Promise<HeadlessMilkdownParser> {
  const engine = await getHeadlessMilkdown();
  return { schema: engine.schema, parseMarkdown: engine.parseMarkdown };
}

export function getHeadlessMilkdownParserIfReady(): HeadlessMilkdownParser | null {
  if (!resolvedEngine) return null;
  return {
    schema: resolvedEngine.schema,
    parseMarkdown: resolvedEngine.parseMarkdown,
  };
}

export async function warmHeadlessMilkdown(): Promise<void> {
  if (forcedWarmFailureForTests) {
    throw forcedWarmFailureForTests;
  }
  await getHeadlessMilkdown();
}

export function __setWarmHeadlessMilkdownFailureForTests(error: Error | null): void {
  forcedWarmFailureForTests = error;
}

export async function serializeMarkdown(doc: ProseMirrorNode): Promise<string> {
  const engine = await getHeadlessMilkdown();
  return engine.serializeMarkdown(doc);
}

export async function serializeSingleNode(node: ProseMirrorNode): Promise<string> {
  const engine = await getHeadlessMilkdown();
  return engine.serializeSingleNode(node);
}

export function getWarmHeadlessMilkdownParserSync(): HeadlessMilkdownParser | null {
  if (!resolvedEngine) return null;
  return {
    schema: resolvedEngine.schema,
    parseMarkdown: resolvedEngine.parseMarkdown,
  };
}

export function warmHeadlessMilkdownParserInBackground(): void {
  void getHeadlessMilkdown().catch(() => {
    // Best-effort warm-up only.
  });
}

export async function warmHeadlessMilkdownParser(): Promise<void> {
  await getHeadlessMilkdown();
}

export function __unsafeResetHeadlessMilkdownForTests(): void {
  engineGeneration += 1;
  enginePromise = null;
  resolvedEngine = null;
  forcedWarmFailureForTests = null;
}
