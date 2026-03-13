/**
 * Proof Mark Schemas
 *
 * Anchors for suggestions, comments, review marks, and authored marks.
 * Serialized as inline HTML spans with data-proof attributes.
 */

import { $markSchema, $markAttr } from '@milkdown/kit/utils';
import type { Attrs } from '@milkdown/kit/prose/model';

type ProofSuggestionKind = 'insert' | 'delete' | 'replace';

type ProofNode = {
  type?: string;
  proof?: string;
  attrs?: Record<string, string | null | undefined>;
  children?: unknown[];
};

function normalizeSuggestionKind(kind: string | null | undefined): ProofSuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function parseCommonAttrs(dom: HTMLElement): { id: string | null; by: string } {
  return {
    id: dom.getAttribute('data-id'),
    by: dom.getAttribute('data-by') || 'unknown',
  };
}

function parseBooleanAttr(value: string | null): boolean | null {
  if (value === null) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function buildCommonDomAttrs(mark: { attrs: { id?: string | null; by?: string | null } }): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (mark.attrs.id) attrs['data-id'] = mark.attrs.id;
  if (mark.attrs.by) attrs['data-by'] = mark.attrs.by;
  return attrs;
}

function serializeProofMark(
  state: { withMark: (mark: unknown, type: string, value?: string, props?: Record<string, unknown>) => void },
  mark: { attrs: Record<string, string | null | undefined> },
  proof: string,
  attrs: Record<string, string | null | undefined>
): void {
  state.withMark(mark, 'proofMark', undefined, { proof, attrs });
}

// Suggestion mark
export const proofSuggestionAttr = $markAttr('proofSuggestion', () => ({
  id: {},
  kind: {},
  by: {},
}));

export const proofSuggestionSchema = $markSchema('proofSuggestion', (ctx) => ({
  attrs: {
    id: { default: null },
    kind: { default: 'replace' },
    by: { default: 'unknown' },
    content: { default: null },
    status: { default: null },
    createdAt: { default: null },
    runId: { default: null },
    focusAreaId: { default: null },
    focusAreaName: { default: null },
    agentId: { default: null },
    proposalId: { default: null },
    provisional: { default: null },
    orchestrator: { default: null },
    debugAutoFixedQuotes: { default: null },
    debugAutoFixedQuotesReason: { default: null },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="suggestion"]',
      getAttrs: (dom: HTMLElement): Attrs => {
        const attrs = parseCommonAttrs(dom);
        const provisional = parseBooleanAttr(dom.getAttribute('data-provisional'));
        const orchestrator = parseBooleanAttr(dom.getAttribute('data-orchestrator'));
        const debugAutoFixedQuotes = parseBooleanAttr(dom.getAttribute('data-debug-autofixed-quotes'));
        return {
          ...attrs,
          kind: normalizeSuggestionKind(dom.getAttribute('data-kind')),
          content: dom.getAttribute('data-content'),
          status: dom.getAttribute('data-status'),
          createdAt: dom.getAttribute('data-created-at'),
          runId: dom.getAttribute('data-run-id'),
          focusAreaId: dom.getAttribute('data-focus-area-id'),
          focusAreaName: dom.getAttribute('data-focus-area-name'),
          agentId: dom.getAttribute('data-agent-id'),
          proposalId: dom.getAttribute('data-proposal-id'),
          provisional: provisional ?? null,
          orchestrator: orchestrator ?? null,
          debugAutoFixedQuotes: debugAutoFixedQuotes ?? null,
          debugAutoFixedQuotesReason: dom.getAttribute('data-debug-autofixed-quotes-reason'),
        };
      },
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofSuggestionAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-proof': 'suggestion',
      'data-kind': normalizeSuggestionKind(mark.attrs.kind),
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    if (mark.attrs.content) domAttrs['data-content'] = String(mark.attrs.content);
    if (mark.attrs.status) domAttrs['data-status'] = String(mark.attrs.status);
    if (mark.attrs.createdAt) domAttrs['data-created-at'] = String(mark.attrs.createdAt);
    if (mark.attrs.runId) domAttrs['data-run-id'] = String(mark.attrs.runId);
    if (mark.attrs.focusAreaId) domAttrs['data-focus-area-id'] = String(mark.attrs.focusAreaId);
    if (mark.attrs.focusAreaName) domAttrs['data-focus-area-name'] = String(mark.attrs.focusAreaName);
    if (mark.attrs.agentId) domAttrs['data-agent-id'] = String(mark.attrs.agentId);
    if (mark.attrs.proposalId) domAttrs['data-proposal-id'] = String(mark.attrs.proposalId);
    if (typeof mark.attrs.provisional === 'boolean') {
      domAttrs['data-provisional'] = String(mark.attrs.provisional);
    }
    if (typeof mark.attrs.orchestrator === 'boolean') {
      domAttrs['data-orchestrator'] = String(mark.attrs.orchestrator);
    }
    if (typeof mark.attrs.debugAutoFixedQuotes === 'boolean') {
      domAttrs['data-debug-autofixed-quotes'] = String(mark.attrs.debugAutoFixedQuotes);
    }
    if (mark.attrs.debugAutoFixedQuotesReason) {
      domAttrs['data-debug-autofixed-quotes-reason'] = String(mark.attrs.debugAutoFixedQuotesReason);
    }
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'suggestion',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      const provisional = parseBooleanAttr(attrs.provisional ?? null);
      const orchestrator = parseBooleanAttr(attrs.orchestrator ?? null);
      state.openMark(markType, {
        id: attrs.id ?? null,
        kind: normalizeSuggestionKind(attrs.kind),
        by: attrs.by ?? 'unknown',
        content: attrs.content ?? null,
        status: attrs.status ?? null,
        createdAt: attrs.createdAt ?? null,
        runId: attrs.runId ?? null,
        focusAreaId: attrs.focusAreaId ?? null,
        focusAreaName: attrs.focusAreaName ?? null,
        agentId: attrs.agentId ?? null,
        proposalId: attrs.proposalId ?? null,
        provisional: provisional ?? null,
        orchestrator: orchestrator ?? null,
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofSuggestion',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'suggestion', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
        kind: normalizeSuggestionKind(mark.attrs.kind),
      });
    },
  },
}));

// Comment mark
export const proofCommentAttr = $markAttr('proofComment', () => ({
  id: {},
  by: {},
}));

export const proofCommentSchema = $markSchema('proofComment', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="comment"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofCommentAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-proof': 'comment',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'comment',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofComment',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'comment', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
  },
}));

// Flagged mark
export const proofFlaggedAttr = $markAttr('proofFlagged', () => ({
  id: {},
  by: {},
}));

export const proofFlaggedSchema = $markSchema('proofFlagged', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="flagged"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofFlaggedAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-proof': 'flagged',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'flagged',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofFlagged',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'flagged', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
  },
}));

// Approved mark
export const proofApprovedAttr = $markAttr('proofApproved', () => ({
  id: {},
  by: {},
}));

export const proofApprovedSchema = $markSchema('proofApproved', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="approved"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofApprovedAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-proof': 'approved',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'approved',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofApproved',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'approved', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
  },
}));

// Authored mark
export const proofAuthoredAttr = $markAttr('proofAuthored', () => ({
  by: {},
  id: {},
}));

export const proofAuthoredSchema = $markSchema('proofAuthored', (ctx) => ({
  attrs: {
    by: { default: 'human:unknown' },
    id: { default: null },
  },
  inclusive: true,
  excludes: 'proofAuthored',
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="authored"]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        by: dom.getAttribute('data-by') || 'human:unknown',
        id: dom.getAttribute('data-proof-id') || dom.getAttribute('data-id') || null,
      }),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofAuthoredAttr.key)(mark);
    return [
      'span',
      {
        'data-proof': 'authored',
        'data-by': mark.attrs.by,
        'data-proof-id': mark.attrs.id ?? null,
        ...attrs,
      },
      0,
    ];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'authored',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        by: attrs.by ?? 'human:unknown',
        id: attrs.id ?? null,
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofAuthored',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'authored', {
        by: mark.attrs.by ?? null,
        id: mark.attrs.id ?? null,
      });
    },
  },
}));

export const proofMarkPlugins = [
  proofSuggestionAttr,
  proofSuggestionSchema,
  proofCommentAttr,
  proofCommentSchema,
  proofFlaggedAttr,
  proofFlaggedSchema,
  proofApprovedAttr,
  proofApprovedSchema,
  proofAuthoredAttr,
  proofAuthoredSchema,
];
