/**
 * Proof Editor
 *
 * A Milkdown-based markdown editor with unified marks tracking.
 *
 * DESIGN:
 * - Marks automatically handle position mapping through edits
 * - Marks survive copy/paste, undo/redo
 * - Inline spans are derived from marks when saving/displaying
 */

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  serializerCtx,
  remarkStringifyOptionsCtx,
  prosePluginsCtx,
} from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { cursor } from '@milkdown/plugin-cursor';
import { clipboard } from '@milkdown/plugin-clipboard';
import { nord } from '@milkdown/theme-nord';
import {
  yCursorPlugin,
  yCursorPluginKey,
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';
import { applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';

import { proofMarkPlugins } from './schema/proof-marks';
import { codeBlockExtPlugins } from './schema/code-block-ext';
import { frontmatterSchema } from './schema/frontmatter';
import { remarkFrontmatterPlugin } from './schema/remark-frontmatter-plugin';
import { authoredTrackerPlugin } from './plugins/authored-tracker';
import { heatmapPlugin, heatmapCtx } from './plugins/heatmap-decorations';
import { marksSyncPlugin } from './plugins/marks-sync';
import {
  agentCursorPlugin,
  agentCursorCtx,
  setAgentCursor,
  setAgentSelection,
  clearAgentCursor,
  getAgentCursorState,
} from './plugins/agent-cursor';
import {
  suggestionsPlugins,
  suggestionsPluginKey,
  enableSuggestions,
  disableSuggestions,
  toggleSuggestions,
  isSuggestionsEnabled,
  wrapTransactionForSuggestions,
} from './plugins/suggestions';
import {
  markPopoverPlugin,
  openCommentComposer,
  captureCommentPopoverDraft,
  restoreCommentPopoverDraft,
  type CommentPopoverDraftSnapshot,
} from './plugins/mark-popover';
import { markSelectionBarPlugin } from './plugins/mark-selection-bar';
import {
  shareContentFilterPlugin,
  enableShareContentFilter,
  disableShareContentFilter,
  SHARE_CONTENT_FILTER_ALLOW_META,
} from './plugins/share-content-filter';
import {
  setShareRuntimeCapabilities,
  resetShareRuntimeCapabilities,
} from './plugins/share-permissions';
import { findHighlightsPlugin, setFindHighlights, clearFindHighlights } from './plugins/find-highlights';
import { arrowCommentPlugin } from './plugins/arrow-comment';
import { markdownLinkClickPlugin } from './plugins/markdown-link-click';
import { mermaidDiagramsPlugin } from './plugins/mermaid-diagrams';
import { taskCheckboxesPlugin } from './plugins/task-checkboxes';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { TextSelection } from '@milkdown/kit/prose/state';
import {
  marksPlugins,
  marksPluginKey,
  getMarks,
  getActiveMarkId,
  getMarkMetadata,
  getMarkMetadataForDisk,
  getMarkMetadataWithQuotes,
  setMarkMetadata,
  applyRemoteMarks,
  setActiveMark,
  approve,
  unapprove,
  flag,
  unflag,
  comment as markComment,
  reply as markReply,
  resolve as markResolve,
  unresolve as markUnresolve,
  suggestInsert,
  suggestDelete,
  suggestReplace,
  debugAnalyzeReplace as debugAnalyzeReplaceMark,
  debugResolveRangeWithValidation as debugResolveRangeWithValidationMark,
  rangeCrossesTableCellBoundary,
  modifySuggestionContent,
  setDefaultMarkdownParser,
  accept as acceptMark,
  reject as rejectMark,
  acceptAll,
  rejectAll,
  deleteMark,
  addAuthoredMark,
  setAuthoredMark,
  getAuthorshipStats,
  coalesceMarks,
  updateMarksAfterEdit,
  type Mark,
  type MarkKind,
  type MarkRange,
  type CommentData,
  type StoredMark,
  mergePendingServerMarks,
  getMarksByKind,
  getPendingSuggestions,
  getUnresolvedComments as getUnresolvedMarkComments,
  findMark,
  resolveMarks,
} from './plugins/marks';
import {
  executeBatch as executeBatchImpl,
  type BatchOperation,
  type BatchResult,
} from './batch-executor';
import { syncAgentSessions } from '../analytics/agent-sessions';
import { initThemePicker, getThemePicker } from '../ui/theme-picker';
import { fileClient } from '../bridge/file-client';
import { shareClient, type CollabSessionInfo, type SharePendingEvent } from '../bridge/share-client';
import { collabClient, type CollabSyncStatus } from '../bridge/collab-client';
import { shouldDeferShareMarksRefresh } from './share-marks-refresh';
import { collabCursorBuilder, collabSelectionBuilder } from './plugins/collab-cursors';
import { isAgentScopedId } from '../shared/agent-identity';
import {
  assignDistinctAgentFamilies,
  createAgentFaceElement,
  getAgentFaceAssetUrl,
  getAgentFacePalette,
  type AgentFamily,
} from '../ui/agent-identity-icon';
import { getViewerName, promptForName } from '../ui/name-prompt';
import {
  initAgentIntegration,
  handleMarksChange as agentHandleMarksChange,
  sweepForActionableItems as agentSweep,
  setAlwaysOnEnabled as agentSetAlwaysOnEnabled,
} from '../agent/editor-integration';
import { initSessionManager, getSessionManager } from '../agent/session-manager';
import { getTriggerService } from '../agent/trigger-service';
import { extractEmbeddedProvenance } from '../formats/provenance-sidecar';
import type { CommentSelector, Comment } from '../formats/provenance-sidecar';
import { normalizeQuote, extractMarks, embedMarks, getThread, migrateProvenanceToMarks, type OrchestratedMarkMeta } from '../formats/marks';
import { proofMarkHandler } from '../formats/remark-proof-marks';
import { remarkProofMarksPlugin } from './schema/remark-proof-marks-plugin';
import { getCurrentActor, setCurrentActor as setCurrentActorValue, normalizeActor } from './actor';
import {
  shouldKeepalivePersistShareContent,
  shouldKeepalivePersistShareMarks,
  shouldUseLocalKeepaliveBaseToken,
} from './share-refresh-persist';
import { keybindingsPlugin, setShowAgentInputCallback, type AgentInputContext } from './plugins/keybindings';
import { tableKeyboardPlugin } from './plugins/table-keyboard';
import { showAgentInputDialog } from '../ui/agent-input-dialog';
import { initContextMenu } from '../ui/context-menu';
import {
  initAgentNavigation,
  navigateToAgent as navigateToAgentInEditor,
  followAgent as followAgentInEditor,
  unfollowAgent as unfollowAgentInEditor,
  getFollowedAgent as getFollowedAgentInEditor,
} from './agent-navigation';
import { captureEvent, initTelemetry } from '../analytics/telemetry';
import { getSkillsRegistry } from '../agent/skills/registry';
import {
  runReview,
  cancelActiveReview,
  debugPlanOnly as debugPlanOnlyReview,
  debugRunSingleFocusArea as debugRunSingleFocusAreaReview,
  debugGetCachedPlan as debugGetCachedPlanReview,
  debugClearPlanCache as debugClearPlanCacheReview,
  type OrchestrationRunOptions,
  type ReviewScope,
} from '../agent/review-executor';
import { setApiKey as setAgentApiKey } from '../agent/config';
import { getAgentStatus, getAgentSessionsSummary, cancelAllAgentSessions } from '../agent/index';
import {
  buildTextIndex,
  getTextForRange,
  mapTextOffsetsToRange,
  resolvePatternRange,
  resolveQuoteRange,
} from './utils/text-range';
import {
  computeLineDiff,
  linesToCharOffsets,
  computeChangeStats,
  classifyChangeMode,
  classifyRewriteMode,
  type LineDiffChange,
  type ChangeStats,
} from './utils/diff';
import { WebHaptics } from 'web-haptics';

import '../agent/external-agent-bridge';

const LEGACY_REST_FALLBACK = false;

// Global proof interface for the web editor runtime
declare global {
  interface Window {
    proof: ProofEditor;
  }
}

type MilkdownPlugin = (ctx: unknown) => unknown;

async function loadPrismPlugin(): Promise<MilkdownPlugin | null> {
  try {
    await import('prismjs');

    await Promise.all([
      import('prismjs/components/prism-markup'),
      import('prismjs/components/prism-css'),
      import('prismjs/components/prism-clike'),
      import('prismjs/components/prism-javascript'),
      import('prismjs/components/prism-typescript'),
      import('prismjs/components/prism-jsx'),
      import('prismjs/components/prism-tsx'),
      import('prismjs/components/prism-ruby'),
      import('prismjs/components/prism-python'),
      import('prismjs/components/prism-go'),
      import('prismjs/components/prism-rust'),
      import('prismjs/components/prism-json'),
      import('prismjs/components/prism-yaml'),
      import('prismjs/components/prism-bash'),
      import('prismjs/components/prism-sql'),
      import('prismjs/components/prism-markdown'),
      import('prismjs/components/prism-mermaid'),
      import('prismjs/components/prism-swift'),
      import('prismjs/components/prism-c'),
      import('prismjs/components/prism-cpp'),
      import('prismjs/components/prism-java'),
      import('prismjs/components/prism-kotlin'),
      import('prismjs/components/prism-php'),
    ]);

    const { prism } = await import('@milkdown/plugin-prism');
    return prism as unknown as MilkdownPlugin;
  } catch (error) {
    console.error('[editor] Failed to initialize Prism syntax highlighting. Continuing without it.', error);
    return null;
  }
}

function resolveSelectorRange(doc: ProseMirrorNode, selector: CommentSelector): MarkRange | null {
  if (selector.range) {
    const size = doc.content.size;
    const from = Math.max(1, Math.min(selector.range.from, size));
    const to = Math.max(from, Math.min(selector.range.to, size));
    if (from < to) {
      return { from, to };
    }
  }

  if (selector.quote) {
    const range = resolveQuoteRange(doc, selector.quote);
    if (range) return range;
  }

  if (selector.pattern) {
    const range = findPatternInDoc(doc, selector.pattern);
    if (range) return range;
  }

  if (selector.anchor?.heading) {
    const range = findAnchorInDoc(doc, selector.anchor);
    if (range) return range;
  }

  return null;
}

// Quote resolution handled via resolveQuoteRange in utils/text-range.

function findPatternInDoc(doc: ProseMirrorNode, pattern: string): MarkRange | null {
  return resolvePatternRange(doc, pattern);
}

function findAnchorInDoc(
  doc: ProseMirrorNode,
  anchor: { heading?: string; offset?: number }
): MarkRange | null {
  if (!anchor.heading) return null;

  let headingPos: number | null = null;
  doc.descendants((node, pos) => {
    if (headingPos !== null) return false;
    if (node.type.name === 'heading') {
      const headingText = node.textContent.toLowerCase();
      if (headingText.includes(anchor.heading!.toLowerCase())) {
        headingPos = pos + node.nodeSize;
        return false;
      }
    }
    return true;
  });

  if (headingPos === null) return null;

  const offset = anchor.offset || 0;
  const from = Math.min(headingPos + offset, doc.content.size);
  const to = Math.min(from + 10, doc.content.size);
  return { from, to };
}

type FindOptions = {
  regex?: boolean;
  caseSensitive?: boolean;
  maxMatches?: number;
  scope?: 'all' | 'selection' | 'visible';
  normalizeWhitespace?: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dry-run position validation: checks all diff positions map correctly
 * before creating any marks. Returns valid=false if any fail.
 */
function validateDiffPositions(
  index: { text: string; positions: Array<number | null> },
  changes: LineDiffChange[],
  oldLines: string[]
): { valid: boolean; failedCount: number } {
  let failedCount = 0;
  for (const change of changes) {
    if (change.type === 'insert') continue; // inserts anchor after preceding line

    const offsets = linesToCharOffsets(oldLines, change.oldLineStart!, change.oldLineEnd!);
    const range = mapTextOffsetsToRange(index, offsets.from, offsets.to);
    if (!range) failedCount++;
  }
  return { valid: failedCount === 0, failedCount };
}

function findMatchesInDoc(
  doc: ProseMirrorNode,
  find: string,
  options: FindOptions = {}
): Array<{ from: number; to: number; match: string }> {
  if (!find) return [];

  const {
    regex = false,
    caseSensitive = false,
    maxMatches = 200,
    normalizeWhitespace = true,
  } = options;

  let source = find;
  if (!regex) {
    if (normalizeWhitespace) {
      const tokens = find.trim().split(/\s+/).filter(Boolean);
      source = tokens.length > 0 ? tokens.map(escapeRegExp).join('\\s+') : '';
    } else {
      source = escapeRegExp(find);
    }
  }

  if (!source) return [];

  // Always enable multiline mode so ^/$ anchors work on line boundaries.
  const flags = caseSensitive ? 'gm' : 'gim';
  let matcher: RegExp;
  try {
    matcher = new RegExp(source, flags);
  } catch {
    return [];
  }

  const index = buildTextIndex(doc);
  if (!index) return [];
  const text = index.text;
  const matches: Array<{ from: number; to: number; match: string }> = [];

  let result: RegExpExecArray | null;
  while ((result = matcher.exec(text)) !== null) {
    if (matches.length >= maxMatches) break;
    const matchText = result[0];
    if (!matchText) {
      matcher.lastIndex += 1;
      continue;
    }

    const startOffset = result.index;
    const endOffset = result.index + matchText.length;
    const mapped = mapTextOffsetsToRange(index, startOffset, endOffset);
    if (mapped) {
      matches.push({ from: mapped.from, to: mapped.to, match: matchText });
    }
  }

  return matches;
}

function migrateLegacyCommentsToMarks(doc: ProseMirrorNode, comments: Comment[]): Mark[] {
  const migrated: Mark[] = [];

  for (const comment of comments) {
    const range = resolveSelectorRange(doc, comment.selector);
    const quoteSource = comment.selector.quote || (range ? doc.textBetween(range.from, range.to, '\n', '\n') : '');
    const quote = normalizeQuote(quoteSource);
    const threadId = comment.id;
    const baseMark: Mark = {
      id: comment.id,
      kind: 'comment',
      by: normalizeActor(comment.author),
      at: comment.createdAt || new Date().toISOString(),
      range: range ?? undefined,
      quote,
      data: {
        text: comment.text,
        thread: threadId,
        resolved: comment.resolved,
      },
    };
    migrated.push(baseMark);

    for (const reply of comment.replies || []) {
      const replyMark: Mark = {
        id: reply.id,
        kind: 'comment',
        by: normalizeActor(reply.author),
        at: reply.createdAt || new Date().toISOString(),
        range: range ?? undefined,
        quote,
        data: {
          text: reply.text,
          thread: threadId,
          resolved: comment.resolved,
        },
      };
      migrated.push(replyMark);
    }
  }

  return migrated;
}

/**
 * Remove authored span wrappers from markdown snapshots returned via the bridge
 * without changing the saved document content.
 */
function stripAuthoredSpanTags(markdown: string): string {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const authoredAttrRegex = /data-proof\s*=\s*(?:"authored"|'authored'|authored)/i;
  const authoredStack: boolean[] = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];

    result += markdown.slice(lastIndex, index);
    lastIndex = index + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (authoredStack.length === 0) {
        result += tag;
        continue;
      }
      const authored = authoredStack.pop();
      if (!authored) {
        result += tag;
      }
      continue;
    }

    const isAuthored = authoredAttrRegex.test(tag);
    authoredStack.push(isAuthored);
    if (!isAuthored) {
      result += tag;
    }
  }

  result += markdown.slice(lastIndex);
  return result;
}

function stripProofSpanTags(markdown: string): string {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const proofAttrRegex = /data-proof\s*=/i;
  const proofStack: boolean[] = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];

    result += markdown.slice(lastIndex, index);
    lastIndex = index + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (proofStack.length === 0) {
        result += tag;
        continue;
      }
      const isProof = proofStack.pop();
      if (!isProof) {
        result += tag;
      }
      continue;
    }

    const isProof = proofAttrRegex.test(tag);
    proofStack.push(isProof);
    if (!isProof) {
      result += tag;
    }
  }

  result += markdown.slice(lastIndex);
  return result;
}

function normalizeMarkdownForComparison(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').trimEnd();
}

function deepEqualValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualValues(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqualValues(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Heuristic markdown detector for bridge safety checks.
 * Conservative by design: if this returns true, content likely carries markdown semantics.
 */
function looksLikeMarkdownSyntax(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|```)|\[[^\]]+\]\([^\)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`/.test(text);
}

function structureSignature(doc: ProseMirrorNode): string {
  const parts: string[] = [];
  doc.descendants((node) => {
    if (node.isText) return true;
    const attrs = Object.keys(node.attrs ?? {})
      .sort()
      .map((key) => `${key}:${String((node.attrs as Record<string, unknown>)[key])}`)
      .join(',');
    parts.push(attrs ? `${node.type.name}[${attrs}]` : node.type.name);
    return true;
  });
  return parts.join('|');
}

export interface EditorFullState {
  /**
   * Markdown serialization of the current document, including embedded mark metadata.
   * Use this for round-tripping content and rewrite payloads.
   */
  content: string;
  /**
   * Plain-text projection of the document for stable offsets and position mapping.
   */
  plainText: string;
  /**
   * Legacy alias for markdown `content` (kept for backward compatibility).
   */
  markdownContent?: string;
  /**
   * Monotonic document revision incremented on every doc-changing transaction.
   */
  revision: number;
  cursor: {
    line: number;
    column: number;
    offset: number;
  };
  selection: {
    hasSelection: boolean;
    from: number;
    to: number;
    text: string;
    fromLine: number;
    toLine: number;
  } | null;
  focusHeading: string | null;
  scroll: {
    visibleFromLine: number;
    visibleToLine: number;
    visibleHeadings: string[];
  };
  activeMark: {
    id: string;
    kind: MarkKind;
    by: string;
    at?: string;
    quote?: string;
    range?: MarkRange | null;
    resolvedRange?: { from: number; to: number } | null;
    data?: Record<string, unknown> | null;
    thread?: Array<{
      id: string;
      by: string;
      at?: string;
      text?: string;
      resolved?: boolean;
    }>;
  } | null;
  structure: {
    sections: Array<{
      heading: string;
      level: number;
      line: number;
      wordCount: number;
    }>;
    totalWords: number;
  };
  authorshipStats: {
    humanPercent: number;
    aiPercent: number;
    humanChars: number;
    aiChars: number;
  } | null;
}

/**
 * Visual layout information for agent-native testing
 * Returns pixel positions of marks and UI elements for overlap detection
 */
export interface VisualLayoutInfo {
  viewport: {
    width: number;
    height: number;
    scrollTop: number;
    scrollLeft: number;
  };
  marks: Array<{
    id: string;
    kind: string;
    textBounds: { top: number; left: number; width: number; height: number } | null;
    gutterBounds: { top: number; left: number; width: number; height: number } | null;
  }>;
  popovers: Array<{
    markId: string;
    bounds: { top: number; left: number; width: number; height: number };
  }>;
  overlaps: Array<{
    element1: { type: string; id?: string };
    element2: { type: string; id?: string };
    overlapArea: number;
  }>;
  gutterAlignments: Array<{
    markId: string;
    textMidY: number;
    gutterMidY: number;
    delta: number;
    aligned: boolean;
  }>;
}

type ShareRuntimeActivationOptions = {
  promptForName?: boolean;
  preserveCurrentDocument?: boolean;
};

export interface ProofEditor {
  editor: Editor | null;
  heatMapMode: 'hidden' | 'subtle' | 'background' | 'full';

  init(): Promise<void>;
  loadDocument(content: string, options?: { allowShareContentMutation?: boolean }): void;
  getContent(): string;
  looksLikeMarkdown(content: string): boolean;
  getMarkdownSnapshot(): { content: string } | null;
  getFullState(): EditorFullState | null;
  setHeatMapMode(mode: string): void;
  setTheme(theme: string): void;
  setCurrentActor(actor: string): void;
  scrollToLine(line: number): void;
  scrollToOffset(offset: number): void;
  navigateToAgent(sessionId: string): void;
  followAgent(sessionId: string): void;
  unfollowAgent(showToast?: boolean): void;
  getFollowedAgent(): string | null;
  isFollowingAgent(sessionId?: string): boolean;

  // Editor operations (for AI agent)
  // author parameter creates an authored mark if specified (e.g., 'ai:claude', 'human:dan')
  insertAt(offset: number, text: string, author?: string): void;
  insertAtCursor(text: string, author?: string): void;
  replaceSelection(text: string, author?: string): void;
  replaceRange(from: number, to: number, text: string, author?: string): void;

  // Agent cursor methods (for AI agent navigation)
  setAgentCursor(position: number, animateOrActor?: boolean | string, actor?: string): void;
  setAgentSelection(from: number, to: number, animateOrActor?: boolean | string, actor?: string): void;
  clearAgentCursor(): void;
  getAgentCursorState(): { cursorPos: number | null; selectionFrom: number | null; selectionTo: number | null } | null;

  // Batch operations (atomic multi-step edits)
  executeBatch(operations: BatchOperation[]): BatchResult;

  // Suggestions (track changes) methods
  enableSuggestions(): void;
  disableSuggestions(): void;
  toggleSuggestions(): boolean;
  isSuggestionsEnabled(): boolean;
  getSuggestions(): Mark[];
  acceptSuggestion(id: string): boolean;
  rejectSuggestion(id: string): boolean;
  acceptAllSuggestions(): number;
  rejectAllSuggestions(): number;

  // Inline comment composer (marks-based)
  beginAddComment(by: string): boolean;

  // === Unified Marks API (new system) ===
  // Reading marks
  getAllMarks(): Mark[];
  getMarksByKind(kind: MarkKind): Mark[];
  getPendingMarkSuggestions(): Mark[];
  getPendingMarkIds(): string[];
  getUnresolvedMarkComments(): Mark[];
  findMarkById(id: string): Mark | undefined;

  // Visual layout (for agent-native testing)
  getVisualLayout(): VisualLayoutInfo;

  // Approvals & Flags
  markApprove(quote: string, by: string): Mark | null;
  markApproveSelector(selector: CommentSelector, by: string): Mark | null;
  markUnapprove(quote: string, by: string): boolean;
  markFlag(quote: string, by: string, note?: string): Mark | null;
  markFlagSelector(selector: CommentSelector, by: string, note?: string): Mark | null;
  markUnflag(quote: string, by: string): boolean;
  markApproveSelection(by: string): Mark | null;
  markFlagSelection(by: string, note?: string): Mark | null;

  // Comments (unified marks style)
  markComment(quote: string, by: string, text: string, meta?: OrchestratedMarkMeta): Mark;
  markCommentSelection(by: string, text: string): Mark | null;
  markCommentSelector(selector: CommentSelector, by: string, text: string, meta?: OrchestratedMarkMeta): Mark | null;
  markReply(markId: string, by: string, text: string): Mark | null;
  markResolve(markId: string): boolean;
  markUnresolve(markId: string): boolean;
  markDeleteThread(markId: string): boolean;

  // Suggestions (unified marks style)
  markSuggestInsert(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null;
  markSuggestDelete(quote: string, by: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null;
  markSuggestReplace(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null;
  markSuggestEdit(
    find: string,
    replace: string,
    by: string,
    options?: FindOptions
  ): { success: boolean; count: number; marks?: Mark[]; error?: string };
  markFind(
    find: string,
    options?: FindOptions
  ): { success: boolean; count: number; matches?: Array<{ from: number; to: number; match: string; line: number; column: number; snippet: string }>; error?: string };
  searchDocument(
    query: string,
    options?: FindOptions
  ): {
    success: boolean;
    count: number;
    matches: Array<{ text: string; position: number; context: string; from: number; to: number }>;
    error?: string;
  };
  markModifySuggestion(markId: string, content: string): boolean;
  markAccept(markId: string): boolean;
  markReject(markId: string): boolean;
  markAcceptAll(): number;
  markRejectAll(): number;

  // Mark management
  markDelete(markId: string): boolean;
  markSetActive(markId: string | null): void;

  // Mark navigation
  navigateToMark(markId: string): boolean;
  navigateToNextComment(): string | null;
  navigateToPrevComment(): string | null;
  navigateToNextSuggestion(): string | null;
  navigateToPrevSuggestion(): string | null;
  resolveActiveComment(): boolean;
  setAlwaysOnEnabled(enabled: boolean): void;
  sweepForActionableItems(triggerOnFirstSweep?: boolean): void;

  // Find functionality
  showFindBar(): void;
  hideFindBar(): void;
  findNext(query: string): boolean;
  findPrev(query: string): boolean;

  // === Share / Marks Metadata ===
  activateShareRuntime(options?: ShareRuntimeActivationOptions): boolean;
  deactivateShareRuntime(): void;
  /**
   * Debug helper for staging QA. Exposes a safe, redacted snapshot of the Yjs state
   * so we can distinguish "ydoc not receiving remote updates" from "editor not applying them".
   */
  debugCollabYDocSummary(): {
    connected: boolean;
    synced: boolean;
    shareSlug: string | null;
    wsBase: string | null;
    prosemirrorLen: number | null;
    prosemirrorPreview: string | null;
    markdownLen: number | null;
    markdownPreview: string | null;
  };
  // Get marks metadata for the current editor state (used by native sync)
  getMarkMetadata(): Record<string, unknown>;
  getMarkMetadataWithQuotes(): Record<string, unknown>;

  // === Authorship (Provenance) ===
  // Get authorship statistics
  getAuthorshipStats(): { humanPercent: number; aiPercent: number; humanChars: number; aiChars: number };
  // Add an authored mark for a range of content
  addAuthoredMark(by: string, range: MarkRange, quote?: string): Mark;
  // Override authored marks for the current selection (or block)
  markAuthoredSelection(by: string): Mark | null;
  // Coalesce adjacent authored marks by the same actor
  coalesceMarks(): void;
  // Update mark positions after a document edit
  updateMarksAfterEdit(editFrom: number, editTo: number, newLength: number): void;

  // === Navigation ===
  // Navigate to a specific mark and highlight it
  navigateToMark(markId: string): boolean;
  // Navigate to comments (cycles through unresolved comments)
  navigateToFirstComment(): string | null;
  navigateToNextComment(): string | null;
  navigateToPrevComment(): string | null;
  // Navigate to suggestions (cycles through pending suggestions)
  navigateToFirstSuggestion(): string | null;
  navigateToNextSuggestion(): string | null;
  navigateToPrevSuggestion(): string | null;
  // Resolve the currently active comment (if any)
  resolveActiveComment(): boolean;
  // Enable/disable always-on processing state
  setAlwaysOnEnabled(enabled: boolean): void;
  // Sweep for actionable items (used by always-on timer)
  sweepForActionableItems(triggerOnFirstSweep?: boolean): void;

  // === Find (Cmd+F) ===
  // Show/hide the find bar
  showFindBar(): void;
  hideFindBar(): void;
  // Find text in document
  find(query: string): { total: number; current: number };
  // Navigate between matches
  findNext(): { total: number; current: number };
  findPrev(): { total: number; current: number };
  // Clear find highlighting
  clearFind(): void;

  // === Skills & Review ===
  // Set API key for agent
  setApiKey(apiKey: string): void;
  // Get available review skills
  getSkills(): Array<{
    id: string;
    name: string;
    description: string;
    icon?: string;
    parallelStrategy: string;
    debugLoop?: string;
    maxAgents?: number;
    batchSize?: number;
    orchestratedVisibleMarks?: boolean;
    promptCharCount: number;
    styleGuideVersion?: string;
    styleGuideCharCount?: number;
  }>;
  // Run a skill-based review
  runSkillReview(skillId: string, scope: 'selection' | 'document'): Promise<void>;
  // Debug: run orchestrator only and return the focus-area plan
  debugPlanOnly(
    skillId: string,
    options?: {
      forceFresh?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown>;
  // Debug: run a single focus area via one sub-agent (no marks)
  debugRunSingleFocusArea(
    skillId: string,
    options?: {
      focusAreaIndex?: number;
      focusAreaId?: string;
      useCachedPlan?: boolean;
      forceFreshPlan?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown>;
  // Debug: inspect/clear cached orchestrator plans
  debugGetCachedPlan(skillId: string): unknown;
  debugClearPlanCache(skillId?: string): void;
  // Debug: run the orchestrator path with explicit orchestration options (creates marks)
  debugRunOrchestrated(
    skillId: string,
    options?: {
      scope?: ReviewScope;
      selection?: { from: number; to: number };
      orchestration?: OrchestrationRunOptions;
      cancelActive?: boolean;
    }
  ): Promise<unknown>;
  // Debug: map plain-text offsets to doc positions and inspect textblocks
  debugMapTextOffsets(from: number, to: number): { range: MarkRange | null; quote: string | null } | null;
  debugDescribeTextblocks(range: { from: number; to: number }): unknown;
  debugTextForRange(range: MarkRange): { range: MarkRange; text: string } | null;
  debugGetParagraphCandidate(minWords?: number): { range: MarkRange; quote: string; line: number } | null;
  debugFindBlockByText(text: string): { range: MarkRange; nodeType: string; line: number } | null;
  debugInspectMarksForText(target: string): {
    found: boolean;
    range?: MarkRange;
    markNames?: string[];
    hasEm?: boolean;
    hasStrong?: boolean;
  } | null;
  debugResolveRangeWithValidation(quote: string, range?: MarkRange): unknown;
  debugAnalyzeReplace(quote: string, content: string, range?: MarkRange): unknown;
  debugQuoteSpansMultipleTableCells(quote: string, range?: MarkRange): boolean;
  // Cancel the currently running review, if any
  cancelReview(): Promise<void>;
  // Stop all in-progress reviews and clear review locks
  stopAllReviews(): Promise<{ cancelledSessions: number; unlocked: boolean; lockCount: number }>;
  // Lock/unlock the editor during orchestrated review runs
  reviewLock(reason?: string): { locked: boolean; lockCount: number; reason?: string };
  reviewUnlock(): { locked: boolean; lockCount: number };
  reviewLockStatus(): { locked: boolean; lockCount: number; reason?: string };
  isReviewLocked(): boolean;
}

class ProofEditorImpl implements ProofEditor {
  editor: Editor | null = null;
  heatMapMode: 'hidden' | 'subtle' | 'background' | 'full' = 'background';
  private isCliMode: boolean = false;
  private isShareMode: boolean = false;
  private shareViewerName: string | null = null;
  private isReadOnly: boolean = false;
  private shareAllowLocalEdits: boolean = true;
  private shareContentFilterEnabled: boolean = false;
  private readOnlyBanner: HTMLElement | null = null;
  private reviewLockCount: number = 0;
  private reviewLockReason: string | null = null;
  private reviewLockBanner: HTMLElement | null = null;
  private reviewInFlight: Promise<unknown> | null = null;
  private lastMarkdown: string = '';
  private suppressMarksSync: boolean = false;
  private collabEnabled: boolean = false;
  private collabCanComment: boolean = false;
  private collabCanEdit: boolean = false;
  private applyingCollabRemote: boolean = false;
  private activeCollabSession: CollabSessionInfo | null = null;
  private collabRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private collabSessionRefreshInFlight: boolean = false;
  private shareOtherViewerCount: number = 0;
  private collabConnectionStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private collabIsSynced: boolean = false;
  private collabUnsyncedChanges: number = 0;
  private collabPendingLocalUpdates: number = 0;
  private collabUnhealthySinceMs: number | null = null;
  private collabLastRecoveryAttemptMs: number = 0;
  private pendingCollabTemplateMarkdown: string | null = null;
  // During session refresh we defer rebinding Milkdown collab until the new provider is synced.
  // This prevents transient empty-doc renders while reconnecting to a fresh Yjs room.
  private pendingCollabRebindOnSync: boolean = false;
  private pendingCollabRebindResetDoc: boolean = false;
  private collabHydrationAttemptSeq: number = 0;
  private collabHydrationRunning: boolean = false;
  private hasCompletedInitialCollabHydration: boolean = false;
  private hasLocalContentEditSinceHydration: boolean = false;
  private lastContentChangeSource: 'local' | 'remote' | 'system' | null = null;
  private pendingProjectionPublish: boolean = false;
  private initialMarksSynced: boolean = false;
  private lastReceivedServerMarks: Record<string, StoredMark> = {};
  private collabTemplateSeedClaimId: string | null = null;
  private collabTemplateClaimCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private collabTemplateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private contentSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  private shareRuntimeActivationInFlight: boolean = false;
  private shareInitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private shareInitRetryCount: number = 0;
  private readonly maxShareInitRetries: number = 5;
  private shareInitAttemptSeq: number = 0;
  // External change state
  private preRefreshRevertContent: string | null = null;
  private preRefreshRevertTimestamp: number = 0;
  private refreshBanner: HTMLElement | null = null;
  private toastElement: HTMLElement | null = null;
  private shareMenuCleanup: (() => void) | null = null;
  private presenceMenuCleanup: (() => void) | null = null;
  private agentMenuCleanup: (() => void) | null = null;
  private shareWelcomeToast: HTMLElement | null = null;
  private shareDocTitle: string = 'Untitled';
  private shareBannerTitleEl: HTMLElement | null = null;
  private shareBannerAvatarsEl: HTMLElement | null = null;
  private shareBannerAgentSlotEl: HTMLElement | null = null;
  private shareBannerSyncDotEl: HTMLElement | null = null;
  private shareBannerSyncLabelEl: HTMLElement | null = null;
  private shareBannerTitleEditing: boolean = false;
  private shareTitlePersistSeq: number = 0;
  private shareLastStatusLabel: string = '';
  private shareStatusTextVisibleUntilMs: number = 0;
  private shareStatusHideTimer: ReturnType<typeof setTimeout> | null = null;
  private shareWsUnsubscribe: (() => void) | null = null;
  private shareEventPollTimer: ReturnType<typeof setTimeout> | null = null;
  private shareEventPollInFlight: boolean = false;
  private shareEventCursor: number = 0;
  private shareLastForcedCollabEventId: number = 0;
  private shareDocumentUpdatedTimer: ReturnType<typeof setTimeout> | null = null;
  private shareMarksRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingShareMarksRefresh: boolean = false;
  private pendingCommentDraftRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCommentDraftSnapshot: CommentPopoverDraftSnapshot | null = null;
  private shareAgentPresenceSummary: string = '';
  private shareAgentActivitySignature: string = '';
  private shareAgentActivityItems: Array<Record<string, any>> = [];
  private shareAgentPresenceFallback = new Map<string, {
    id: string;
    name: string;
    status: string;
    color: string;
    avatar?: string;
    at: string;
  }>();
  private shareAgentPresenceExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private shareAgentPresenceCleanup: (() => void) | null = null;
  private shareAgentPresenceIcons = new Map<string, AgentFamily>();
  private shareAgentAwarenessClientIds = new Map<string, number>();
  private shareAgentAwarenessClocks = new Map<string, number>();
  // Navigation state
  private currentCommentIndex: number = -1;
  private currentSuggestionIndex: number = -1;
  // Find state
  private findQuery: string = '';
  private findMatches: Array<{ from: number; to: number }> = [];
  private currentFindIndex: number = -1;
  private cleanupNavigation: (() => void) | null = null;
  private lastEditorInputActivitySentAt: number = 0;
  private lastLocalTypingAt: number = 0;
  private lifecycleHandlersInstalled: boolean = false;
  private readonly webHaptics = new WebHaptics();
  private readonly collabTemplateClaimStaleMs: number = 3_000;
  private readonly collabTemplateClaimSettleMs: number = 250;
  private readonly collabTemplateRetryMs: number = 450;
  private readonly collabRecoveryDelayMs: number = 4_000;
  private readonly collabRecoveryBackoffMs: number = 5_000;
  private readonly collabTypingRecoveryGraceMs: number = 3_000;
  private readonly shareEventPollMs: number = 1500;
  private readonly shareDocumentUpdatedDebounceMs: number = 600;
  private readonly commentPopoverDraftRestoreDelayMs: number = 120;
  private readonly commentPopoverDraftRestoreMaxAttempts: number = 10;
  private readonly remoteCursorStabilityWindowMs: number = 500;
  // Content/reporting state (used by agent integration + telemetry)
  private initState: 'idle' | 'initializing' | 'ready' = 'idle';
  private revision: number = 0;
  private hasTrackedDocumentOpened: boolean = false;

  constructor() {
    const proofConfig = (window as Window & {
      __PROOF_CONFIG__?: { windowId?: string; documentId?: string };
    }).__PROOF_CONFIG__ ?? {};

    if (!proofConfig.windowId) {
      proofConfig.windowId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    if (!proofConfig.documentId) {
      proofConfig.documentId = document.location.pathname || 'unknown';
    }

    (window as Window & { __PROOF_CONFIG__?: { windowId?: string; documentId?: string } }).__PROOF_CONFIG__ = proofConfig;

    const windowId = proofConfig.windowId;
    const documentId = proofConfig.documentId;

    initTelemetry({ windowId, documentId });

    initSessionManager({
      persistenceKey: `proof-agent-sessions:${windowId ?? 'default'}:${documentId ?? 'unknown'}`,
      onSessionChange: syncAgentSessions,
    });

    this.isCliMode = fileClient.isCliMode();
    this.isShareMode = shareClient.isShareMode();
  }

  async init(): Promise<void> {
    const root = document.getElementById('editor');
    if (!root) {
      console.error('Editor root element not found');
      return;
    }
    this.applyTopChromeForMode();

    const prismPlugin = await loadPrismPlugin();

    // Clear the loading indicator
    root.innerHTML = '';

    let editorBuilder = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
      })
      .config(nord)
      .use(commonmark)
      .use(gfm)
      // Frontmatter must be registered after commonmark so remark-frontmatter
      // claims `---` before commonmark parses it as a thematic break.
      .use(remarkFrontmatterPlugin)
      .use(frontmatterSchema)
      .use(codeBlockExtPlugins)
      .use(history)
      .use(listener)
      .use(collab)
      .use(cursor)
      .use(clipboard);

    if (prismPlugin) {
      editorBuilder = editorBuilder.use(prismPlugin);
    }

    this.editor = await editorBuilder
      // Register proof mark schemas
      .use(proofMarkPlugins)
      // Register remark plugin for proof marks parsing
      .use(remarkProofMarksPlugin)
      // Register contexts
      .use(heatmapCtx)
      .use(agentCursorCtx)
      // Register plugins
      .use(authoredTrackerPlugin)
      .use(heatmapPlugin)
      .use(agentCursorPlugin)
      // Register suggestions plugin
      .use(suggestionsPlugins)
      // Inline mark UI (popover + selection bar)
      .use(markPopoverPlugin)
      .use(markSelectionBarPlugin)
      .use(arrowCommentPlugin)
      .use(findHighlightsPlugin)
      .use(shareContentFilterPlugin)
      .use(taskCheckboxesPlugin)
      .use(mermaidDiagramsPlugin)
      .use(markdownLinkClickPlugin)
      // Register unified marks plugin
      .use(marksPlugins)
      // Register keybindings plugin for agent shortcuts
      .use(keybindingsPlugin)
      // Allow Backspace to delete empty table rows
      .use(tableKeyboardPlugin)
      .use(marksSyncPlugin((actionMarks, view, actionMetadata) => {
        this.handleMarksChange(actionMarks, view, actionMetadata);
      }))
      .config((ctx) => {
        // Note: remarkProofMarks is now registered via .use(remarkProofMarksPlugin)
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({
          ...prev,
          handlers: {
            ...(prev.handlers ?? {}),
            proofMark: proofMarkHandler,
          },
        }));

        // Set up listener for content changes
        ctx.get(listenerCtx).updated((_ctx, doc, prevDoc) => {
          if (prevDoc && doc.eq(prevDoc)) return;
          this.scheduleContentSync();
        });

        // Initialize heatmap context
        ctx.set(heatmapCtx.key, { mode: this.heatMapMode });
      })
      .create();

    this.editor.action((ctx) => {
      const parser = ctx.get(parserCtx);
      setDefaultMarkdownParser(parser);
    });

    const view = this.editor.ctx.get(editorViewCtx);
    (window as any).__editorView = view;
    this.updateEditableState(view);
    this.cleanupNavigation = initAgentNavigation(view);

    this.installLifecycleHandlers();

    // Add cursor tracking
    this.setupCursorTracking();

    // Set up suggestions interceptor to wrap transactions for track changes.
    // This uses dispatchTransaction decorator to intercept edits BEFORE they're applied,
    // which is necessary for proper deletion tracking (converting deletes to deletion marks).
    this.setupSuggestionsInterceptor();

    // Initialize agent integration for @proof mentions
    this.initAgentIntegration();

    // Theme picker only applies to regular editor mode.
    if (!this.isShareMode) {
      initThemePicker();
    }

    // If in CLI mode, load the file from the API
    if (this.isCliMode) {
      await this.initFromCli();
    }

    // If in share mode, load from share server
    if (this.isShareMode) {
      await this.initFromShare();
    }
  }

  private installLifecycleHandlers(): void {
    if (this.lifecycleHandlersInstalled) return;
    this.lifecycleHandlersInstalled = true;

    window.addEventListener('beforeunload', () => {
      if (this.isShareMode) {
        this.flushShareMarks({ keepalive: true, persistContent: true });
        collabClient.flushPendingLocalStateForUnload();
      }
      this.clearPendingCommentDraftRestore();
      if (this.collabRefreshTimer) {
        clearInterval(this.collabRefreshTimer);
        this.collabRefreshTimer = null;
      }
      this.resetPendingCollabTemplateState(true);
      this.resetShareMarksSyncState();
      this.disconnectCollabService();
      collabClient.disconnect();
      if (this.shareWsUnsubscribe) {
        this.shareWsUnsubscribe();
        this.shareWsUnsubscribe = null;
      }
      this.stopShareEventPoll();
      shareClient.disconnect();
      this.cleanupNavigation?.();
    });

    window.addEventListener('pagehide', () => {
      if (this.isShareMode) {
        this.flushShareMarks({ keepalive: true, persistContent: true });
        collabClient.flushPendingLocalStateForUnload();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.isShareMode) {
        this.flushShareMarks({ keepalive: true, persistContent: true });
        collabClient.flushPendingLocalStateForUnload();
      }
    });
  }

  private async initFromCli(): Promise<void> {
    try {
      // Fetch configuration first
      const config = await fileClient.fetchConfig();
      if (config) {
        this.isReadOnly = config.readOnly;
        fileClient.setInitialTitle();

        // Show read-only indicator if applicable
        if (this.isReadOnly) {
          this.showReadOnlyBanner();
        }
      }

      // Load the file
      const fileData = await fileClient.loadFile();
      if (fileData) {
        this.loadDocument(fileData.content);
      }
    } catch (error) {
      console.error('Failed to initialize from CLI:', error);
      this.showErrorBanner((error as Error).message);
    }
  }

  private async initFromShare(options?: ShareRuntimeActivationOptions): Promise<void> {
    const attemptSeq = ++this.shareInitAttemptSeq;
    this.resetPendingCollabTemplateState(true);
    this.collabHydrationAttemptSeq += 1;
    this.collabHydrationRunning = false;
    this.resetShareMarksSyncState();
    try {
      const preserveCurrentDocument = options?.preserveCurrentDocument === true;
      const contextResponse = await shareClient.fetchOpenContext();
      if (this.isShareRequestError(contextResponse)) {
        throw new Error(contextResponse.error.message);
      }
      const context = contextResponse && 'doc' in contextResponse
        ? contextResponse
        : null;
      const wantsNamePrompt = options?.promptForName ?? true;
      const canActInDocument = Boolean(context?.capabilities?.canComment || context?.capabilities?.canEdit);
      const existingViewerName = getViewerName();
      this.shareViewerName = existingViewerName ?? this.shareViewerName ?? this.deriveDefaultShareViewerName();
      setCurrentActorValue(`human:${this.shareViewerName || 'Anonymous'}`);
      shareClient.setViewerName(this.shareViewerName || 'Anonymous');
      collabClient.setLocalUser(
        { name: this.shareViewerName || 'Anonymous' },
        shareClient.getSlug() ?? undefined
      );
      if (wantsNamePrompt && canActInDocument && !existingViewerName) {
        void promptForName()
          .then((name) => {
            const resolvedName = typeof name === 'string' && name.trim().length > 0
              ? name.trim()
              : this.deriveDefaultShareViewerName();
            this.shareViewerName = resolvedName;
            setCurrentActorValue(`human:${resolvedName}`);
            shareClient.setViewerName(resolvedName);
            collabClient.setLocalUser(
              { name: resolvedName },
              shareClient.getSlug() ?? undefined
            );
          })
          .catch((error) => {
            console.warn('[share] name prompt failed', error);
          });
      }

      const doc = context?.doc ?? await shareClient.fetchDocument();
      if (!doc) {
        this.showErrorBanner('Document not found or has been unshared.', {
          retryLabel: 'Retry',
          onRetry: () => {
            this.resetShareInitRetryState();
            void this.initFromShare(options);
          },
        });
        return;
      }

      // Set title
      document.title = doc.title ? `${doc.title} - Proof` : 'Shared Document - Proof';
      this.shareDocTitle = typeof doc.title === 'string' && doc.title.trim().length > 0
        ? doc.title.trim()
        : 'Untitled';

      let collabTemplateMarkdown: string | null = null;

	      if (!preserveCurrentDocument) {
	        collabTemplateMarkdown = this.normalizeMarkdownForCollab(doc.markdown);
	        this.lastMarkdown = this.normalizeMarkdownForRuntime(doc.markdown);
	      } else {
	        collabTemplateMarkdown = this.captureCollabTemplateFromCurrentDocument();
	      }
	      if (collabTemplateMarkdown !== null && collabTemplateMarkdown.trim().length === 0) {
	        collabTemplateMarkdown = null;
	      }

      this.showShareBanner(doc.viewers ?? 0);
      this.ensureShareWebSocketConnection();

      // Prefer collab runtime path when available.
      const collabSession = context
        ? { session: context.session, capabilities: context.capabilities }
        : await shareClient.fetchCollabSession();
      if (this.isShareRequestError(collabSession)) {
        throw new Error(collabSession.error.message);
      }
      const shareCapabilities = context?.capabilities
        ?? (collabSession && 'capabilities' in collabSession ? collabSession.capabilities : null);
      this.collabCanComment = Boolean(shareCapabilities?.canComment);
      this.showShareWelcomeToastOnce(shareCapabilities);

      if (collabSession && 'session' in collabSession && collabSession.session) {
        if (this.collabRefreshTimer) {
          clearInterval(this.collabRefreshTimer);
          this.collabRefreshTimer = null;
        }
        const initialMarks = (context?.doc?.marks && typeof context.doc.marks === 'object' && !Array.isArray(context.doc.marks))
          ? { ...(context.doc.marks as Record<string, StoredMark>) }
          : {};
        this.collabEnabled = true;
        this.collabCanComment = Boolean(collabSession.capabilities.canComment);
        this.collabCanEdit = Boolean(collabSession.capabilities.canEdit);
        this.activeCollabSession = collabSession.session;
        this.collabConnectionStatus = 'connecting';
        this.collabIsSynced = false;
        this.collabUnsyncedChanges = 0;
        this.collabPendingLocalUpdates = 0;
        this.resetProjectionPublishState();
        if (Object.keys(initialMarks).length > 0) {
          this.lastReceivedServerMarks = initialMarks;
          this.initialMarksSynced = true;
        }
        this.updateShareEditGate();

        collabClient.onMarks((marks) => {
          const incomingMarks = (marks && typeof marks === 'object' && !Array.isArray(marks))
            ? (marks as Record<string, StoredMark>)
            : {};
          // Hocuspocus can emit a transient empty marks payload before initial sync
          // and occasionally while local updates are still in flight. If we already
          // have server marks, avoid clobbering them with that empty map.
          if (
            Object.keys(incomingMarks).length === 0
            && Object.keys(this.lastReceivedServerMarks).length > 0
            && (
              !this.collabIsSynced
              || this.collabUnsyncedChanges > 0
            )
          ) {
            return;
          }

          let mergedIncomingMarks = mergePendingServerMarks(this.lastReceivedServerMarks, incomingMarks);
          if (this.editor) {
            try {
              this.editor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                mergedIncomingMarks = mergePendingServerMarks(getMarkMetadata(view.state), incomingMarks);
              });
            } catch (error) {
              console.warn('[collab.onMarks] Failed to merge incoming marks with local state:', error);
            }
          }

          this.lastReceivedServerMarks = { ...mergedIncomingMarks };
          this.initialMarksSynced = true;
          if (Object.keys(mergedIncomingMarks).length > 0 && !this.isEditorDocStructurallyEmpty()) {
            this.applyLatestCollabMarksToEditor();
          }
        });
        collabClient.onPresence((count) => {
          const otherCount = Math.max(0, count - 1);
          this.shareOtherViewerCount = otherCount;
          this.updateShareBannerTitleDisplay();
          this.updateShareBannerPresenceDisplay();
        });
        collabClient.onSyncStatus((status) => {
          this.updateCollabHealthWindow(status);
          this.collabConnectionStatus = status.connectionStatus;
          this.collabIsSynced = status.isSynced;
          this.collabUnsyncedChanges = status.unsyncedChanges;
          this.collabPendingLocalUpdates = status.pendingLocalUpdates;
          this.updateShareEditGate();
          if (status.connectionStatus === 'disconnected' && collabClient.terminalCloseReason === 'permission-denied') {
            void this.refreshCollabSessionAndReconnect(false);
          }
          if (status.connectionStatus === 'connected' && status.isSynced) {
            if (this.pendingCollabRebindOnSync) {
              const shouldResetDoc = this.pendingCollabRebindResetDoc;
              this.pendingCollabRebindOnSync = false;
              this.pendingCollabRebindResetDoc = false;
              if (shouldResetDoc) {
                this.connectCollabService(true);
              } else {
                this.connectCollabService();
              }
            }
            this.ensureCollabCursorsInstalled();
            this.applyPendingCollabTemplate();
            this.kickCollabHydration();
            this.applyLatestCollabMarksToEditor();
            setTimeout(() => this.applyLatestCollabMarksToEditor(), 150);
            this.installShareAgentPresenceObservers();
            this.clearErrorBanner();
            this.resetShareInitRetryState();
            if (status.unsyncedChanges === 0) {
              this.flushPendingProjectionMarkdown();
            }
          }
          this.updateShareBannerSyncDisplay();
        });
        collabClient.onDocumentUpdated(() => {
          if (!this.collabEnabled) return;
          if (this.collabUnsyncedChanges > 0) return;
          if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;
          void this.refreshCollabSessionAfterDocumentUpdated();
        });
        this.resetPendingCollabTemplateState(false);
        this.pendingCollabTemplateMarkdown = this.shouldAllowCollabTemplateSeed(collabSession.session)
          ? collabTemplateMarkdown
          : null;
        // Defer the Milkdown<->Yjs binding until the provider has completed its
        // initial room sync. Binding against a reset local editor before sync can
        // generate self-inflicted local updates that keep the client stuck syncing.
        this.pendingCollabRebindOnSync = true;
        this.pendingCollabRebindResetDoc = true;
        this.updateShareEditGate();
        collabClient.connect(collabSession.session);
        this.startCollabRefreshLoop();
      } else {
        this.collabEnabled = false;
        this.collabCanComment = false;
        this.collabCanEdit = false;
        this.activeCollabSession = null;
        this.collabConnectionStatus = 'disconnected';
        this.collabIsSynced = false;
        this.collabUnsyncedChanges = 0;
        this.collabPendingLocalUpdates = 0;
        this.resetProjectionPublishState();
        this.updateShareEditGate();
        if (!preserveCurrentDocument) {
          const contentWithMarks = embedMarks(doc.markdown, doc.marks as Record<string, StoredMark>);
          this.loadDocument(contentWithMarks);
          if (doc.marks && Object.keys(doc.marks).length > 0) {
            this.applyExternalMarks(doc.marks as Record<string, StoredMark>);
          }
          const initialMarks = doc.marks
            ? { ...(doc.marks as Record<string, StoredMark>) }
            : {};
          this.lastReceivedServerMarks = initialMarks;
          this.initialMarksSynced = true;
        }
        this.showErrorBanner('Live collaboration is currently unavailable for this shared document.');
        return;
      }

      console.log('[initFromShare] Loaded shared document:', shareClient.getSlug());
      if (attemptSeq !== this.shareInitAttemptSeq) return;
      this.clearErrorBanner();
      this.resetShareInitRetryState();
    } catch (error) {
      if (attemptSeq !== this.shareInitAttemptSeq) return;
      console.error('[initFromShare] Failed:', error);
      const message = this.getErrorMessage(error);
      if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) {
        this.clearErrorBanner();
        this.resetShareInitRetryState();
        return;
      }
      if (!this.shouldRetryShareInitError(error)) {
        this.resetShareInitRetryState();
        this.showErrorBanner(message, {
          retryLabel: 'Retry',
          onRetry: () => {
            this.resetShareInitRetryState();
            void this.initFromShare(options);
          },
        });
        return;
      }

      if (this.shareInitRetryCount >= this.maxShareInitRetries) {
        this.resetShareInitRetryState();
        this.showErrorBanner(`Unable to connect to live collaboration. ${message}`, {
          retryLabel: 'Retry now',
          onRetry: () => {
            this.resetShareInitRetryState();
            void this.initFromShare(options);
          },
        });
        return;
      }

      this.shareInitRetryCount += 1;
      const delayMs = Math.min(1000 * (2 ** (this.shareInitRetryCount - 1)), 8000);
      this.showErrorBanner(`Load failed. Retrying in ${Math.round(delayMs / 1000)}s...`, {
        retryLabel: 'Retry now',
        onRetry: () => {
          this.resetShareInitRetryState();
          void this.initFromShare(options);
        },
      });
      if (this.shareInitRetryTimer) {
        clearTimeout(this.shareInitRetryTimer);
      }
      this.shareInitRetryTimer = setTimeout(() => {
        this.shareInitRetryTimer = null;
        if (attemptSeq !== this.shareInitAttemptSeq) return;
        void this.initFromShare(options);
      }, delayMs);
    }
  }

  private deriveDefaultShareViewerName(): string {
    const actor = getCurrentActor();
    if (actor.startsWith('human:')) {
      const name = actor.slice('human:'.length).trim();
      if (name.length > 0) return name;
    }
    return 'Anonymous';
  }

  activateShareRuntime(options?: ShareRuntimeActivationOptions): boolean {
    if (this.shareRuntimeActivationInFlight) return false;
    const hasShareConfig = shareClient.refreshRuntimeConfig();
    this.isShareMode = hasShareConfig;
    if (!hasShareConfig) return false;
    this.collabCanComment = false;
    this.collabCanEdit = false;
    setShareRuntimeCapabilities({ canComment: false, canEdit: false });

    this.shareRuntimeActivationInFlight = true;
    void this.initFromShare(options)
      .finally(() => {
        this.shareRuntimeActivationInFlight = false;
      });
    return true;
  }

  deactivateShareRuntime(): void {
    this.isShareMode = false;
    this.collabEnabled = false;
    this.collabCanComment = false;
    this.collabCanEdit = false;
    this.activeCollabSession = null;
    this.collabIsSynced = false;
    this.collabConnectionStatus = 'disconnected';
    this.collabUnsyncedChanges = 0;
    this.collabPendingLocalUpdates = 0;
    this.collabUnhealthySinceMs = null;
    this.collabLastRecoveryAttemptMs = 0;
    this.collabSessionRefreshInFlight = false;
    this.resetPendingCollabTemplateState(true);
    this.resetShareMarksSyncState();
    this.resetProjectionPublishState();
    this.applyingCollabRemote = false;
    this.resetShareInitRetryState();
    this.clearErrorBanner();
    if (this.shareDocumentUpdatedTimer) {
      clearTimeout(this.shareDocumentUpdatedTimer);
      this.shareDocumentUpdatedTimer = null;
    }
    if (this.shareMarksRefreshTimer) {
      clearTimeout(this.shareMarksRefreshTimer);
      this.shareMarksRefreshTimer = null;
    }
    this.pendingShareMarksRefresh = false;
    this.clearPendingCommentDraftRestore();
    if (this.shareWsUnsubscribe) {
      this.shareWsUnsubscribe();
      this.shareWsUnsubscribe = null;
    }
    this.stopShareEventPoll();
    shareClient.disconnect();
    resetShareRuntimeCapabilities();
	    if (this.collabRefreshTimer) {
	      clearInterval(this.collabRefreshTimer);
	      this.collabRefreshTimer = null;
	    }
	    this.uninstallShareAgentPresenceObservers();
	    this.disconnectCollabService();
	    collabClient.disconnect();
	    this.uninstallShareContentFilter();
	    this.clearShareBanner();
	  }

  debugCollabYDocSummary(): {
    connected: boolean;
    synced: boolean;
    shareSlug: string | null;
    wsBase: string | null;
    prosemirrorLen: number | null;
    prosemirrorPreview: string | null;
    markdownLen: number | null;
    markdownPreview: string | null;
  } {
    const shareSlug = shareClient.getSlug();
    const connected = collabClient.isConnected();
    const synced = this.collabIsSynced;
    const ydoc = collabClient.getYDoc();

    const wsBase = (() => {
      const active = (this.activeCollabSession && typeof this.activeCollabSession.collabWsUrl === 'string')
        ? this.activeCollabSession.collabWsUrl
        : null;
      if (!active) return null;
      try {
        const url = new URL(active);
        url.searchParams.delete('slug');
        return url.toString().replace(/\?$/, '');
      } catch {
        return active.replace(/\?slug=.*$/, '');
      }
    })();

    if (!ydoc) {
      return {
        connected,
        synced,
        shareSlug,
        wsBase,
        prosemirrorLen: null,
        prosemirrorPreview: null,
        markdownLen: null,
        markdownPreview: null,
      };
    }

    let prosemirrorLen: number | null = null;
    let prosemirrorPreview: string | null = null;
    try {
      const frag = (ydoc as any).getXmlFragment?.('prosemirror');
      if (frag && typeof frag.length === 'number') {
        prosemirrorLen = frag.length;
        prosemirrorPreview = String(frag).slice(0, 300);
      }
    } catch {
      // ignore
    }

    let markdownLen: number | null = null;
    let markdownPreview: string | null = null;
    try {
      const raw = ydoc.getText('markdown').toString();
      markdownLen = raw.length;
      markdownPreview = raw.slice(0, 200);
    } catch {
      // ignore
    }

    return {
      connected,
      synced,
      shareSlug,
      wsBase,
      prosemirrorLen,
      prosemirrorPreview,
      markdownLen,
      markdownPreview,
    };
  }

  private resetPendingCollabTemplateState(clearPendingTemplate: boolean): void {
    if (clearPendingTemplate) {
      this.pendingCollabTemplateMarkdown = null;
    }
    this.collabTemplateSeedClaimId = null;
    if (this.collabTemplateClaimCheckTimer) {
      clearTimeout(this.collabTemplateClaimCheckTimer);
      this.collabTemplateClaimCheckTimer = null;
    }
    if (this.collabTemplateRetryTimer) {
      clearTimeout(this.collabTemplateRetryTimer);
      this.collabTemplateRetryTimer = null;
    }
    this.updateShareEditGate();
  }

  private resetShareMarksSyncState(): void {
    this.initialMarksSynced = false;
    this.lastReceivedServerMarks = {};
  }

  private parseCollabTemplateClaim(value: unknown): { id: string; ts: number } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as { id?: unknown; ts?: unknown };
    if (typeof record.id !== 'string' || record.id.length === 0) return null;
    if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return null;
    return { id: record.id, ts: record.ts };
  }

  private isEditorDocStructurallyEmpty(): boolean {
    if (!this.editor) return true;
    let isEmpty = true;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      if (doc.childCount !== 1) {
        isEmpty = false;
        return;
      }
      const firstChild = doc.firstChild;
      if (!firstChild) {
        isEmpty = true;
        return;
      }
      isEmpty = firstChild.type.name === 'paragraph'
        && firstChild.content.size === 0
        && firstChild.textContent.length === 0;
    });
    return isEmpty;
  }

  private isYjsFragmentStructurallyEmpty(fragment: unknown): boolean {
    if (!fragment) return true;
    const anyFragment = fragment as any;
    const len = anyFragment.length;
    if (typeof len !== 'number') return false;
    if (len === 0) return true;
    if (len !== 1) return false;

    let first: any = null;
    if (typeof anyFragment.get === 'function') {
      first = anyFragment.get(0);
    } else if (typeof anyFragment.toArray === 'function') {
      first = anyFragment.toArray()[0];
    }
    if (!first) return true;
    if (first.nodeName !== 'paragraph') return false;
    try {
      if (String(first) === '<paragraph></paragraph>') return true;
    } catch {
      // ignore
    }
    if (typeof first.length === 'number') {
      return first.length === 0;
    }
    return false;
  }

  private normalizeCollabHydrationText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private getEditorHydrationText(): string | null {
    if (!this.editor) return null;
    let text: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      text = this.normalizeCollabHydrationText(
        view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n'),
      );
    });
    return text;
  }

  private getYjsFragmentHydrationText(fragment: unknown): string | null {
    if (!this.editor || !fragment) return null;
    let text: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      try {
        const root = yXmlFragmentToProseMirrorRootNode(
          fragment as any,
          view.state.schema as any,
        ) as ProseMirrorNode;
        text = this.normalizeCollabHydrationText(
          root.textBetween(0, root.content.size, '\n', '\n'),
        );
      } catch {
        text = null;
      }
    });
    return text;
  }

  private isCollabHydratedForEditing(): boolean {
    if (!this.editor) return false;
    const ydoc = collabClient.getYDoc() as any;
    if (!ydoc || typeof ydoc.getXmlFragment !== 'function') return true;
    let fragment: unknown;
    try {
      fragment = ydoc.getXmlFragment('prosemirror');
    } catch {
      return true;
    }
    if (this.isYjsFragmentStructurallyEmpty(fragment)) return true;
    const fragmentText = this.getYjsFragmentHydrationText(fragment);
    if (fragmentText === null) {
      return !this.isEditorDocStructurallyEmpty();
    }
    const editorText = this.getEditorHydrationText();
    if (editorText === null) return false;
    return editorText === fragmentText;
  }

  private kickCollabHydration(): void {
    if (!this.isShareMode || !this.collabEnabled) return;
    if (!this.editor) return;
    if (this.collabHydrationRunning) return;

    this.collabHydrationRunning = true;
    const attemptSeq = ++this.collabHydrationAttemptSeq;
    const maxAttempts = 60;

    const finish = () => {
      if (attemptSeq === this.collabHydrationAttemptSeq) {
        this.collabHydrationRunning = false;
      }
    };

    const attempt = (count: number) => {
      if (attemptSeq !== this.collabHydrationAttemptSeq) return;
      if (!this.editor || !this.collabEnabled) {
        finish();
        return;
      }

      if (this.isCollabHydratedForEditing()) {
        finish();
        this.markInitialCollabHydrationComplete();
        this.updateShareEditGate();
        this.scheduleContentSync();
        return;
      }

      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        try {
          const ystate = (ySyncPluginKey.getState(view.state) as any) ?? null;
          const binding = ystate?.binding;
          if (binding && typeof binding._forceRerender === 'function') {
            binding._forceRerender();
          }
        } catch {
          // ignore; hydration is best-effort
        }
      });

      if (count >= maxAttempts) {
        finish();
        this.markInitialCollabHydrationComplete();
        this.updateShareEditGate();
        return;
      }
      requestAnimationFrame(() => attempt(count + 1));
    };

    attempt(0);
  }

  private schedulePendingCollabTemplateRetry(): void {
    if (!this.pendingCollabTemplateMarkdown || this.collabTemplateRetryTimer) return;
    this.collabTemplateRetryTimer = setTimeout(() => {
      this.collabTemplateRetryTimer = null;
      this.applyPendingCollabTemplate();
    }, this.collabTemplateRetryMs);
  }

  private shouldAllowCollabTemplateSeed(session: { snapshotVersion: number } | null | undefined): boolean {
    return Boolean(
      this.collabCanEdit
      && session
      && Number.isFinite(session.snapshotVersion)
      && session.snapshotVersion === 0,
    );
  }

  private captureCollabTemplateFromCurrentDocument(): string | null {
    if (!this.editor) return null;
    let markdown: string | null = null;
    this.editor.action((ctx) => {
      try {
        const view = ctx.get(editorViewCtx);
        const serializer = ctx.get(serializerCtx);
        markdown = this.normalizeMarkdownForCollab(serializer(view.state.doc));
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn('[share] failed to capture local collab template', details);
      }
    });
    return markdown;
  }

  private connectCollabService(resetEditorDoc = false): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx);
      const ydoc = collabClient.getYDoc();
      if (!ydoc) {
        collabService.disconnect();
        return;
      }
      const view = ctx.get(editorViewCtx);
      collabService.mergeOptions({
        yCursorOpts: {
          cursorBuilder: collabCursorBuilder,
          selectionBuilder: collabSelectionBuilder,
        },
      });
      collabService.disconnect();
      // Important: do not connect with awareness attached yet. The yCursor plugin can
      // evaluate awareness states before y-sync has built its mapping, which can throw
      // (nodeSize on undefined). We'll install the cursor plugin after y-sync is ready.
      try {
        (collabService as any).setAwareness(null);
      } catch {
        // ignore
      }
      if (resetEditorDoc) {
        try {
          const parser = ctx.get(parserCtx);
          const emptyDoc = parser('');
          const resetTr = view.state.tr
            .replaceWith(0, view.state.doc.content.size, emptyDoc.content)
            .setMeta('document-load', true)
            .setMeta(SHARE_CONTENT_FILTER_ALLOW_META, true);
          view.dispatch(resetTr);
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          console.warn('[share] failed to reset editor before collab connect', details);
        }
      }
      collabService.bindDoc(ydoc);
      collabService.connect();
      this.installCollabCursorsWhenReady(view, ctx, collabService);
    });
  }

  private ensureCollabCursorsInstalled(): void {
    if (!this.editor || !this.collabEnabled) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const collabService = ctx.get(collabServiceCtx);
      this.installCollabCursorsWhenReady(view, ctx, collabService);
    });
  }

  private installCollabCursorsWhenReady(view: EditorView, ctx: any, collabService: any): void {
    const awareness = collabClient.getAwareness();
    if (!awareness) return;

    const hasCursorPlugin = () =>
      view.state.plugins.some((plugin) => (plugin as any)?.spec?.key === yCursorPluginKey);

    const maxAttempts = 120;
    const attemptInstall = (attempt: number) => {
      if (!this.editor || !this.collabEnabled) return;
      if (hasCursorPlugin()) return;

      let mappingReady = false;
      try {
        const ystate = (ySyncPluginKey.getState(view.state) as any) ?? null;
        const mapping = ystate?.binding?.mapping as Map<any, any> | null;
        // In y-prosemirror, `binding.mapping` is a Map from Yjs types to ProseMirror nodes.
        // The cursor plugin can crash if awareness is attached before this mapping is populated.
        if (mapping && typeof (mapping as any).size === 'number' && (mapping as any).size > 0) mappingReady = true;
      } catch {
        // ignore and retry
      }

      if (!mappingReady) {
        if (attempt < maxAttempts) requestAnimationFrame(() => attemptInstall(attempt + 1));
        return;
      }

      try {
        collabService.setAwareness(awareness);
      } catch {
        // ignore; cursor plugin can still work with direct awareness reference
      }

      try {
        const cursorPlugin = yCursorPlugin(
          awareness as any,
          {
            cursorBuilder: collabCursorBuilder as any,
            selectionBuilder: collabSelectionBuilder as any,
          } as any,
          undefined
        );

        const nextPlugins = view.state.plugins.concat(cursorPlugin);
        ctx.set(prosePluginsCtx, nextPlugins);
        view.updateState(view.state.reconfigure({ plugins: nextPlugins }));
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn('[share] failed to install yCursor plugin', details);
      }
    };

    attemptInstall(0);
  }

  private applyPendingCollabTemplate(): void {
    const templateMarkdown = this.pendingCollabTemplateMarkdown;
    if (!templateMarkdown || templateMarkdown.length === 0 || !this.editor) return;
    if (!this.shouldAllowCollabTemplateSeed(this.activeCollabSession)) {
      this.resetPendingCollabTemplateState(true);
      return;
    }
    if (!this.collabCanEdit) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    const ydoc = collabClient.getYDoc();
    if (!ydoc) return;

    const fragment = ydoc.getXmlFragment('prosemirror');
    // If the server already has a non-empty Yjs prosemirror fragment, we should never
    // keep trying to "seed" a template. Doing so can deadlock edit gating and, worse,
    // cause early local edits to overwrite remote content.
    if (!this.isYjsFragmentStructurallyEmpty(fragment)) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    if (!this.isEditorDocStructurallyEmpty()) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    const seedMap = ydoc.getMap<unknown>('collabInit');
    // Sometimes we can observe the "seeded" bit before the prosemirror fragment arrives
    // (or after a refresh while the fragment is still empty). Only treat it as seeded if
    // the fragment actually contains content.
    const fragmentStructurallyEmpty = this.isYjsFragmentStructurallyEmpty(fragment);
    if (seedMap.get('pmTemplateSeeded') === true && !fragmentStructurallyEmpty) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    if (!this.collabTemplateSeedClaimId) {
      this.collabTemplateSeedClaimId = `seed-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    const claimId = this.collabTemplateSeedClaimId;
    const now = Date.now();
    const existingClaim = this.parseCollabTemplateClaim(seedMap.get('pmTemplateSeedClaim'));

    if (!existingClaim || (now - existingClaim.ts) > this.collabTemplateClaimStaleMs) {
      ydoc.transact(() => {
        if (seedMap.get('pmTemplateSeeded') === true) return;
        const latestClaim = this.parseCollabTemplateClaim(seedMap.get('pmTemplateSeedClaim'));
        const transactionNow = Date.now();
        if (!latestClaim || (transactionNow - latestClaim.ts) > this.collabTemplateClaimStaleMs) {
          seedMap.set('pmTemplateSeedClaim', { id: claimId, ts: transactionNow });
        }
      }, 'local-template-seed-claim');
    }

    if (this.collabTemplateClaimCheckTimer) return;
    this.collabTemplateClaimCheckTimer = setTimeout(() => {
      this.collabTemplateClaimCheckTimer = null;

      const latestTemplate = this.pendingCollabTemplateMarkdown;
      if (!latestTemplate || !this.editor) return;

      const currentDoc = collabClient.getYDoc();
      if (!currentDoc) return;
      const currentSeedMap = currentDoc.getMap<unknown>('collabInit');

      if (currentSeedMap.get('pmTemplateSeeded') === true || !this.isEditorDocStructurallyEmpty()) {
        this.resetPendingCollabTemplateState(true);
        return;
      }

      const liveClaim = this.parseCollabTemplateClaim(currentSeedMap.get('pmTemplateSeedClaim'));
      if (!liveClaim || liveClaim.id !== this.collabTemplateSeedClaimId) {
        this.schedulePendingCollabTemplateRetry();
        return;
      }

      this.editor.action((ctx) => {
        try {
          const collabService = ctx.get(collabServiceCtx);
          collabService.applyTemplate(latestTemplate, (yDocNode) => {
            if (yDocNode.childCount === 0) return true;
            if (yDocNode.childCount !== 1) return false;
            const firstChild = yDocNode.firstChild;
            if (!firstChild) return true;
            return firstChild.type.name === 'paragraph' && firstChild.textContent.length === 0;
          });
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          console.warn('[share] failed to apply pending collab template', details);
        }
      });

      if (!this.isEditorDocStructurallyEmpty()) {
        currentDoc.transact(() => {
          currentSeedMap.set('pmTemplateSeeded', true);
          currentSeedMap.set('pmTemplateSeededAt', Date.now());
          currentSeedMap.delete('pmTemplateSeedClaim');
        }, 'local-template-seeded');
        this.resetPendingCollabTemplateState(true);
        return;
      }

      this.schedulePendingCollabTemplateRetry();
    }, this.collabTemplateClaimSettleMs);
  }

  private disconnectCollabService(): void {
    if (!this.editor) return;
    this.pendingCollabRebindOnSync = false;
    this.pendingCollabRebindResetDoc = false;
    this.editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx);
      collabService.disconnect();
    });
  }

  private startCollabRefreshLoop(): void {
    if (this.collabRefreshTimer) {
      clearInterval(this.collabRefreshTimer);
      this.collabRefreshTimer = null;
    }
    this.collabRefreshTimer = setInterval(async () => {
      if (!this.collabEnabled || !this.activeCollabSession) return;
      await this.maybeRecoverStalledCollab();
      const expiresAt = this.activeCollabSession.expiresAt;
      if (!expiresAt) return;
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresAtMs)) return;
      const now = Date.now();
      if ((expiresAtMs - now) > 60_000) return;
      if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;
      if (this.shouldDeferExpiringCollabRefresh(now)) return;
      await this.refreshCollabSessionAndReconnect(this.shouldPreservePendingLocalCollabState());
    }, 2_000);
  }

  private shouldPreservePendingLocalCollabState(): boolean {
    return this.collabCanEdit
      && (this.collabUnsyncedChanges > 0 || this.collabPendingLocalUpdates > 0);
  }

  private shouldDeferExpiringCollabRefresh(now: number): boolean {
    if (!this.collabCanEdit) return false;
    if (this.shouldPreservePendingLocalCollabState()) return true;
    if (this.pendingProjectionPublish) return true;
    if (this.contentSyncTimeout !== null) return true;
    return (now - this.lastLocalTypingAt) < this.collabTypingRecoveryGraceMs;
  }

  private updateCollabHealthWindow(status: CollabSyncStatus): void {
    const healthy = status.connectionStatus === 'connected'
      && status.isSynced
      && (this.collabCanEdit || status.unsyncedChanges === 0);
    if (healthy) {
      this.collabUnhealthySinceMs = null;
      this.collabLastRecoveryAttemptMs = 0;
      return;
    }
    if (this.collabUnhealthySinceMs === null) {
      this.collabUnhealthySinceMs = Date.now();
    }
  }

  private async maybeRecoverStalledCollab(): Promise<void> {
    if (!this.collabEnabled || !this.activeCollabSession) return;
    if (this.collabUnhealthySinceMs === null) return;
    const now = Date.now();
    if (
      this.collabUnsyncedChanges > 0
      && (now - this.lastLocalTypingAt) < this.collabTypingRecoveryGraceMs
    ) {
      return;
    }
    if ((now - this.collabUnhealthySinceMs) < this.collabRecoveryDelayMs) return;
    if ((now - this.collabLastRecoveryAttemptMs) < this.collabRecoveryBackoffMs) return;
    this.collabLastRecoveryAttemptMs = now;
    this.collabUnhealthySinceMs = now;
    await this.refreshCollabSessionAndReconnect(false);
  }

  private teardownCollabRuntimeAfterTerminalRefreshFailure(): void {
    this.clearPendingCommentDraftRestore();
    if (this.collabRefreshTimer) {
      clearInterval(this.collabRefreshTimer);
      this.collabRefreshTimer = null;
    }
    this.collabUnhealthySinceMs = null;
    this.collabLastRecoveryAttemptMs = 0;
    this.disconnectCollabService();
    collabClient.disconnect();
  }

  private captureCommentPopoverDraftSnapshot(): CommentPopoverDraftSnapshot | null {
    if (!this.editor) return null;
    let snapshot: CommentPopoverDraftSnapshot | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      snapshot = captureCommentPopoverDraft(view);
    });
    return snapshot;
  }

  private clearPendingCommentDraftRestore(): void {
    if (this.pendingCommentDraftRestoreTimer) {
      clearTimeout(this.pendingCommentDraftRestoreTimer);
      this.pendingCommentDraftRestoreTimer = null;
    }
    this.pendingCommentDraftSnapshot = null;
  }

  private restoreCommentPopoverDraftWithRetry(snapshot: CommentPopoverDraftSnapshot): void {
    this.clearPendingCommentDraftRestore();
    this.pendingCommentDraftSnapshot = snapshot;
    let attempts = 0;
    const tryRestore = () => {
      const pendingSnapshot = this.pendingCommentDraftSnapshot;
      if (!pendingSnapshot) return;
      if (!this.editor || !this.isShareMode || !this.collabEnabled) {
        this.clearPendingCommentDraftRestore();
        return;
      }
      let restored = false;
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        restored = restoreCommentPopoverDraft(view, pendingSnapshot);
      });
      if (restored) {
        this.clearPendingCommentDraftRestore();
        return;
      }
      attempts += 1;
      if (attempts >= this.commentPopoverDraftRestoreMaxAttempts) {
        this.clearPendingCommentDraftRestore();
        return;
      }
      this.pendingCommentDraftRestoreTimer = setTimeout(tryRestore, this.commentPopoverDraftRestoreDelayMs);
    };
    tryRestore();
  }

  private async refreshCollabSessionAfterDocumentUpdated(): Promise<void> {
    const draftSnapshot = this.captureCommentPopoverDraftSnapshot();
    await this.refreshCollabSessionAndReconnect(false);
    if (draftSnapshot) {
      this.restoreCommentPopoverDraftWithRetry(draftSnapshot);
    }
  }

  private async refreshCollabSessionAndReconnect(preserveLocalState: boolean): Promise<void> {
    if (!this.collabEnabled || !this.activeCollabSession) return;
    if (this.collabSessionRefreshInFlight) return;
    this.collabSessionRefreshInFlight = true;
    this.pendingCollabRebindOnSync = false;
    try {
      const refreshed = await shareClient.refreshCollabSession();
      if (this.isShareRequestError(refreshed)) {
        console.warn('[share] collab session refresh failed', refreshed.error);
        if (refreshed.error.status === 401 || refreshed.error.status === 403 || refreshed.error.status === 404 || refreshed.error.status === 410) {
          this.teardownCollabRuntimeAfterTerminalRefreshFailure();
          this.collabEnabled = false;
          this.collabCanComment = false;
          this.collabCanEdit = false;
          this.collabConnectionStatus = 'disconnected';
          this.collabIsSynced = false;
          this.collabUnsyncedChanges = 0;
          this.collabPendingLocalUpdates = 0;
          this.activeCollabSession = null;
          this.resetProjectionPublishState();
          this.updateShareEditGate();
          if (refreshed.error.status === 404 || refreshed.error.status === 410) {
            this.showErrorBanner('Document not found or has been unshared.');
          } else {
            this.showReadOnlyBanner();
          }
        }
        return;
      }
      if (refreshed && 'collabAvailable' in refreshed && refreshed.collabAvailable === false) {
        this.collabEnabled = false;
        this.collabCanComment = false;
        this.collabCanEdit = false;
        this.collabConnectionStatus = 'disconnected';
        this.collabIsSynced = false;
        this.collabUnsyncedChanges = 0;
        this.collabPendingLocalUpdates = 0;
        this.activeCollabSession = null;
        this.resetProjectionPublishState();
        this.updateShareEditGate();
        this.showReadOnlyBanner();
        return;
      }
      if (!refreshed || !('session' in refreshed) || !refreshed.session) return;
      const canEditBefore = this.collabCanEdit;
      this.activeCollabSession = refreshed.session;
      this.collabCanComment = Boolean(refreshed.capabilities.canComment);
      this.collabCanEdit = Boolean(refreshed.capabilities.canEdit);
      this.resetShareMarksSyncState();
      const shouldPreserveLocalState = preserveLocalState && this.shouldPreservePendingLocalCollabState();
      let reconnectTemplate: string | null = null;
      if (shouldPreserveLocalState) {
        if (this.lastMarkdown.trim().length > 0) {
          reconnectTemplate = this.normalizeMarkdownForCollab(this.lastMarkdown);
        }
      } else {
        try {
          const latest = await shareClient.fetchDocument();
          if (!this.isShareRequestError(latest) && latest && typeof latest.markdown === 'string' && latest.markdown.trim().length > 0) {
            reconnectTemplate = this.normalizeMarkdownForCollab(latest.markdown);
          }
        } catch {
          // best-effort; reconnect against the live room without replaying stale local projection.
        }
      }
      if (!this.shouldAllowCollabTemplateSeed(refreshed.session)) {
        reconnectTemplate = null;
      }
      this.pendingCollabRebindOnSync = true;
      this.pendingCollabRebindResetDoc = !shouldPreserveLocalState || !this.collabCanEdit;
      this.resetProjectionPublishState();
      collabClient.reconnectWithSession(refreshed.session, { preserveLocalState: shouldPreserveLocalState });
      this.resetPendingCollabTemplateState(false);
      this.pendingCollabTemplateMarkdown = this.shouldAllowCollabTemplateSeed(refreshed.session)
        ? reconnectTemplate
        : null;
      this.updateShareEditGate();
      if (canEditBefore !== this.collabCanEdit) {
        this.updateShareEditGate();
      }
    } catch (error) {
      this.pendingCollabRebindOnSync = false;
      this.pendingCollabRebindResetDoc = false;
      console.warn('[share] failed to refresh collab session', error);
    } finally {
      this.collabSessionRefreshInFlight = false;
    }
  }

  /**
   * In share mode, allow text selection (for commenting) but block content edits.
   * Uses a ProseMirror filterTransaction plugin to reject doc-modifying transactions.
   */
  private installShareContentFilter(): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enableShareContentFilter(view);
    });
  }

  private uninstallShareContentFilter(): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      disableShareContentFilter(view);
    });
  }

  private setShareContentFilterEnabled(enabled: boolean): void {
    if (!this.editor) return;
    if (enabled === this.shareContentFilterEnabled) return;
    this.shareContentFilterEnabled = enabled;
    if (enabled) {
      this.installShareContentFilter();
      return;
    }
    this.uninstallShareContentFilter();
  }

  private updateShareEditGate(): void {
    if (!this.isShareMode) return;
    const awaitingTemplateSeed = Boolean(this.pendingCollabTemplateMarkdown && this.pendingCollabTemplateMarkdown.length > 0);
    const baseAllowLocalEdits = this.collabEnabled
      && this.collabCanEdit
      && this.collabConnectionStatus === 'connected'
      && this.collabIsSynced
      && !awaitingTemplateSeed;
    const hydrated = !baseAllowLocalEdits ? true : this.isCollabHydratedForEditing();
    if (baseAllowLocalEdits && !hydrated) {
      // Prevent "type into blank doc" races that can overwrite remote Yjs state.
      this.kickCollabHydration();
    }
    const allowLocalEdits = baseAllowLocalEdits && hydrated;
    this.shareAllowLocalEdits = allowLocalEdits;
    // Only block content mutations for true view-only sessions.
    // Avoid using filterTransaction as a temporary "sync lock", since it can deadlock hydration.
    this.setShareContentFilterEnabled(this.collabEnabled && !this.collabCanEdit);
    setShareRuntimeCapabilities({
      canComment: this.collabCanComment,
      canEdit: this.collabCanEdit,
    });
    this.updateEditableState();
    this.updateShareBannerTitleDisplay();
  }

  private ensureShareWebSocketConnection(): void {
    if (!this.isShareMode) return;
    if (!this.shareWsUnsubscribe) {
      this.shareWsUnsubscribe = shareClient.onMessage((message) => {
        this.handleShareWebSocketMessage(message);
      });
    }
    shareClient.connectWebSocket();
    this.startShareEventPoll();
  }

  private handleShareWebSocketMessage(message: Record<string, unknown>): void {
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'viewers.updated') {
      const count = typeof message.count === 'number'
        ? message.count
        : (Array.isArray(message.viewers) ? message.viewers.length : 0);
      if (Number.isFinite(count)) {
        this.shareOtherViewerCount = Math.max(0, Math.floor(count) - 1);
        this.updateShareBannerTitleDisplay();
      }
      return;
    }
    if (type === 'document.title.updated') {
      if (typeof message.title === 'string') {
        this.applyShareTitle(message.title);
      }
      return;
    }
    if (type === 'document.updated') {
      if (typeof message.title === 'string') {
        this.applyShareTitle(message.title);
      }
      if (!this.collabEnabled) {
        this.scheduleShareDocumentUpdatedRefresh();
      }
      return;
    }
    if (type === 'agent.presence') {
      const id = typeof message.id === 'string' ? message.id.trim() : '';
      if (!id || !isAgentScopedId(id)) return;
      const status = typeof message.status === 'string' && message.status.trim() ? message.status.trim() : 'idle';
      if (status === 'disconnected') {
        this.shareAgentPresenceFallback.delete(id);
      } else {
        this.shareAgentPresenceFallback.set(id, {
          id,
          name: typeof message.name === 'string' && message.name.trim() ? message.name.trim() : id,
          status,
          color: typeof message.color === 'string' && /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(message.color)
            ? message.color
            : '#6366f1',
          avatar: typeof message.avatar === 'string' && message.avatar.trim() ? message.avatar.trim() : undefined,
          at: typeof message.timestamp === 'string' && message.timestamp.trim()
            ? message.timestamp.trim()
            : new Date().toISOString(),
        });
      }
      this.updateShareBannerAgentControlDisplay();
      this.updateShareBannerPresenceDisplay();
    }
  }

  private shouldForceCollabRefreshFromPendingEvent(event: SharePendingEvent): boolean {
    return event.type === 'document.updated'
      || event.type === 'agent.edit'
      || event.type === 'agent.edit.v2'
      || event.type === 'document.rewritten';
  }

  private shouldSkipForcedCollabRefreshFromPendingEvent(): boolean {
    // When the live room is already healthy, agent/document updates should arrive
    // through Yjs. Rebinding from canonical state here can erase a fresh local edit
    // that has propagated live but has not durably persisted yet.
    return this.collabEnabled
      && this.collabConnectionStatus === 'connected'
      && this.collabIsSynced;
  }

  private isMarksPendingShareEvent(event: SharePendingEvent): boolean {
    return event.type.startsWith('comment.')
      || event.type.startsWith('suggestion.');
  }

  private handlePendingShareEvent(event: SharePendingEvent): void {
    if (this.isMarksPendingShareEvent(event)) {
      this.scheduleShareMarksRefresh();
      return;
    }
    if (!this.shouldForceCollabRefreshFromPendingEvent(event)) return;
    if (event.id <= this.shareLastForcedCollabEventId) return;
    this.shareLastForcedCollabEventId = event.id;
    if (this.shouldSkipForcedCollabRefreshFromPendingEvent()) return;
    this.scheduleShareDocumentUpdatedRefresh(true);
  }

  private startShareEventPoll(): void {
    if (!this.isShareMode) return;
    if (this.shareEventPollTimer) return;
    const tick = async (): Promise<void> => {
      this.shareEventPollTimer = null;
      if (!this.isShareMode) return;
      if (this.shareEventPollInFlight) {
        this.shareEventPollTimer = setTimeout(() => { void tick(); }, this.shareEventPollMs);
        return;
      }
      this.shareEventPollInFlight = true;
      try {
        const payload = await shareClient.fetchPendingEvents(this.shareEventCursor, { limit: 100 });
        if (!this.isShareRequestError(payload) && payload) {
          for (const event of payload.events) {
            this.handlePendingShareEvent(event);
          }
          if (typeof payload.cursor === 'number' && Number.isFinite(payload.cursor)) {
            this.shareEventCursor = Math.max(this.shareEventCursor, Math.trunc(payload.cursor));
          }
        }
      } catch {
        // best-effort fallback for cross-instance refresh signals
      } finally {
        this.shareEventPollInFlight = false;
        if (this.isShareMode) {
          this.shareEventPollTimer = setTimeout(() => { void tick(); }, this.shareEventPollMs);
        }
      }
    };
    this.shareEventPollTimer = setTimeout(() => { void tick(); }, this.shareEventPollMs);
  }

  private stopShareEventPoll(): void {
    if (this.shareEventPollTimer) {
      clearTimeout(this.shareEventPollTimer);
      this.shareEventPollTimer = null;
    }
    this.shareEventPollInFlight = false;
    this.shareEventCursor = 0;
    this.shareLastForcedCollabEventId = 0;
  }

  private scheduleShareDocumentUpdatedRefresh(forceCollabRefresh: boolean = false): void {
    if (this.shareDocumentUpdatedTimer) return;
    this.shareDocumentUpdatedTimer = setTimeout(() => {
      this.shareDocumentUpdatedTimer = null;
      if (!this.isShareMode) return;
      if (this.collabEnabled) {
        if (this.collabUnsyncedChanges > 0) return;
        if (!forceCollabRefresh && this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;
        void this.refreshCollabSessionAfterDocumentUpdated();
        return;
      }
      void shareClient.fetchDocument()
        .then((doc) => {
          if (!doc) return;
          this.applyShareTitle(doc.title);
          if (typeof doc.viewers === 'number') {
            this.shareOtherViewerCount = Math.max(0, Math.floor(doc.viewers) - 1);
            this.updateShareBannerTitleDisplay();
          }
        })
        .catch(() => {
          // best-effort refresh
        });
    }, this.shareDocumentUpdatedDebounceMs);
  }

  private scheduleShareMarksRefresh(): void {
    this.pendingShareMarksRefresh = true;
    if (this.shareMarksRefreshTimer) {
      clearTimeout(this.shareMarksRefreshTimer);
      this.shareMarksRefreshTimer = null;
    }
    this.shareMarksRefreshTimer = setTimeout(() => {
      this.shareMarksRefreshTimer = null;
      if (!this.pendingShareMarksRefresh) return;
      if (!this.isShareMode || !this.collabEnabled) {
        this.pendingShareMarksRefresh = false;
        return;
      }
      if (shouldDeferShareMarksRefresh({
        collabCanEdit: this.collabCanEdit,
        collabUnsyncedChanges: this.collabUnsyncedChanges,
        collabPendingLocalUpdates: this.collabPendingLocalUpdates,
      })) {
        this.scheduleShareMarksRefresh();
        return;
      }
      this.pendingShareMarksRefresh = false;
      void shareClient.fetchOpenContext()
        .then((context) => {
          if (!context || this.isShareRequestError(context) || !('doc' in context)) return;
          const serverMarks = (context.doc?.marks && typeof context.doc.marks === 'object' && !Array.isArray(context.doc.marks))
            ? context.doc.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.applyAuthoritativeShareMarks(serverMarks);
        })
        .catch(() => {
          // best-effort refresh for server-originated mark updates
        });
    }, this.shareDocumentUpdatedDebounceMs);
  }

  private getViewerText(otherViewerCount: number): string {
    if (otherViewerCount === 1) return '1 viewer';
    return `${otherViewerCount} viewers`;
  }

  private getShareSyncStatus(): { label: string; color: string } {
    if (!this.collabEnabled) {
      return { label: 'Live sync unavailable', color: '#ef4444' };
    }
    if (this.collabConnectionStatus === 'connected') {
      if (!this.collabIsSynced) {
        return { label: 'Syncing...', color: '#f59e0b' };
      }
      if (this.collabUnsyncedChanges > 0) {
        return { label: 'Saving...', color: '#f59e0b' };
      }
      return { label: 'Saved', color: '#34d399' };
    }
    if (this.collabConnectionStatus === 'connecting') {
      return { label: 'Connecting...', color: '#f59e0b' };
    }
    if (collabClient.terminalCloseReason === 'unshared') {
      return { label: 'Document is no longer shared', color: '#ef4444' };
    }
    if (collabClient.terminalCloseReason === 'permission-denied') {
      return { label: 'Access revoked', color: '#ef4444' };
    }
    if (this.collabUnsyncedChanges > 0) {
      return { label: 'Offline - unsaved changes', color: '#ef4444' };
    }
    return { label: 'Offline - reconnecting', color: '#ef4444' };
  }

  private ensureShareStatusPulseStyle(): void {
    const styleId = 'share-status-pulse-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes shareStatusPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }
    `;
    document.head.appendChild(style);
  }

  private getSyncStatusTextLabel(label: string): string {
    const map: Record<string, string> = {
      'Saved': 'Saved',
      'Saving...': 'Saving',
      'Syncing...': 'Syncing',
      'Connecting...': 'Connecting',
      'Offline - reconnecting': 'Offline',
      'Offline - unsaved changes': 'Unsaved',
      'Access revoked': 'Revoked',
      'Document is no longer shared': 'Unshared',
      'Live sync unavailable': 'No sync',
    };
    return map[label] ?? 'Saved';
  }

  private shouldShowStatusText(statusLabel: string): boolean {
    const normalized = statusLabel.trim() || 'Saved';
    const now = Date.now();

    if (normalized !== this.shareLastStatusLabel) {
      this.shareLastStatusLabel = normalized;
      this.shareStatusTextVisibleUntilMs = now + 3_500;
      if (this.shareStatusHideTimer) {
        clearTimeout(this.shareStatusHideTimer);
        this.shareStatusHideTimer = null;
      }
      this.shareStatusHideTimer = setTimeout(() => {
        this.shareStatusHideTimer = null;
        const label = document.querySelector('#share-banner .share-pill-status-inline .status-label') as HTMLElement | null;
        if (label) label.style.display = 'none';
      }, 3_550);
      return true;
    }

    return now < this.shareStatusTextVisibleUntilMs;
  }

  private getHumanCollaboratorAvatars(): Array<{ name: string; color: string; initial: string }> {
    const avatars: Array<{ name: string; color: string; initial: string }> = [];
    const awareness = collabClient.getAwareness();
    if (!awareness) return avatars;
    const states = awareness.getStates?.();
    if (!states) return avatars;
    const myClientId = awareness.clientID;
    const seen = new Set<string>();
    states.forEach((state: any, clientId: number) => {
      if (clientId === myClientId) return;
      const user = state?.user;
      if (!user || typeof user.name !== 'string') return;
      if (typeof user.avatar === 'string' && user.avatar.trim().length > 0) return;
      const name = user.name.trim() || 'Anonymous';
      const dedupe = name.toLowerCase();
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const color = (typeof user.color === 'string' && /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(user.color))
        ? user.color
        : '#6b7280';
      avatars.push({
        name,
        color,
        initial: name.charAt(0).toUpperCase(),
      });
    });
    return avatars;
  }

  private ensureShareAgentPresenceIcons(agentIds: Iterable<string>): void {
    const activeIds = Array.from(new Set(
      Array.from(agentIds)
        .map((agentId) => agentId.trim())
        .filter(Boolean),
    ));
    if (activeIds.length === 0) return;

    const nextAssignments = assignDistinctAgentFamilies(activeIds);
    for (const agentId of activeIds) {
      const family = nextAssignments.get(agentId);
      if (family) this.shareAgentPresenceIcons.set(agentId, family);
    }
  }

  private syncShareAgentPresenceIcons(agentIds: Iterable<string>): void {
    const activeIds = new Set(Array.from(agentIds));
    for (const agentId of Array.from(this.shareAgentPresenceIcons.keys())) {
      if (!activeIds.has(agentId)) this.shareAgentPresenceIcons.delete(agentId);
    }
    this.ensureShareAgentPresenceIcons(activeIds);
  }

  private getAgentPresenceVariant(agentId: string): AgentFamily {
    const existing = this.shareAgentPresenceIcons.get(agentId);
    if (existing) return existing;
    this.ensureShareAgentPresenceIcons([agentId]);
    return this.shareAgentPresenceIcons.get(agentId) ?? 'purple';
  }

  private getAgentPresenceColor(agentId: string): string {
    return getAgentFacePalette(this.getAgentPresenceVariant(agentId)).accent;
  }

  private getAgentPresenceAvatar(agentId: string): string {
    return getAgentFaceAssetUrl(this.getAgentPresenceVariant(agentId));
  }

  private getConnectedAgentEntries(): Array<{
    id: string;
    name: string;
    status: string;
    color: string;
    avatar?: string;
    at: string;
  }> {
    return this.collectConnectedAgentEntries().entries;
  }

  private collectConnectedAgentEntries(): {
    entries: Array<{
      id: string;
      name: string;
      status: string;
      color: string;
      avatar?: string;
      at: string;
    }>;
    nextExpiryAtMs: number | null;
  } {
    const ydoc: any = collabClient.getYDoc();
    if (!ydoc || typeof ydoc.getMap !== 'function') {
      return { entries: [], nextExpiryAtMs: null };
    }

    const nowMs = Date.now();
    const ttlMs = 60_000;
    let nextExpiryAtMs: number | null = null;
    const entries: Array<{
      id: string;
      name: string;
      status: string;
      color: string;
      avatar?: string;
      at: string;
    }> = [];

    const pushEntry = (
      id: string,
      name: string,
      status: string,
      avatar: string | undefined,
      atRaw: string,
    ) => {
      const at = atRaw.trim();
      if (!at) return;
      const atMs = Date.parse(at);
      if (!Number.isFinite(atMs)) return;
      if ((nowMs - atMs) > ttlMs) return;
      const expiryAtMs = atMs + ttlMs;
      if (nextExpiryAtMs === null || expiryAtMs < nextExpiryAtMs) {
        nextExpiryAtMs = expiryAtMs;
      }
      entries.push({
        id,
        name,
        status,
        color: this.getAgentPresenceColor(id),
        avatar,
        at: at,
      });
    };

    try {
      const presenceMap = ydoc.getMap('agentPresence');
      presenceMap.forEach((value: any) => {
        if (!value || typeof value !== 'object') return;
        const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
        if (!id || !isAgentScopedId(id)) return;
        const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
        const status = typeof value.status === 'string' && value.status.trim() ? value.status.trim() : 'idle';
        const avatar = typeof value.avatar === 'string' && value.avatar.trim() ? value.avatar.trim() : undefined;
        const at = typeof value.at === 'string' ? value.at : '';
        pushEntry(id, name, status, avatar, at);
      });
    } catch {
      return { entries: [], nextExpiryAtMs: null };
    }

    for (const fallback of this.shareAgentPresenceFallback.values()) {
      if (!isAgentScopedId(fallback.id)) continue;
      if (entries.some((entry) => entry.id === fallback.id)) continue;
      pushEntry(fallback.id, fallback.name, fallback.status, fallback.avatar, fallback.at);
    }

    entries.sort((a, b) => {
      const aActive = a.status !== 'idle';
      const bActive = b.status !== 'idle';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return Date.parse(b.at) - Date.parse(a.at);
    });

    this.syncShareAgentPresenceIcons(entries.map((entry) => entry.id));
    for (const entry of entries) {
      entry.color = this.getAgentPresenceColor(entry.id);
      entry.avatar = this.getAgentPresenceAvatar(entry.id);
    }

    return { entries, nextExpiryAtMs };
  }

  private clearShareAgentPresenceExpiryTimer(): void {
    if (!this.shareAgentPresenceExpiryTimer) return;
    clearTimeout(this.shareAgentPresenceExpiryTimer);
    this.shareAgentPresenceExpiryTimer = null;
  }

  private scheduleShareAgentPresenceExpiryRefresh(nextExpiryAtMs: number | null): void {
    this.clearShareAgentPresenceExpiryTimer();
    if (nextExpiryAtMs === null) return;
    const delayMs = Math.max(50, Math.ceil(nextExpiryAtMs - Date.now()) + 25);
    this.shareAgentPresenceExpiryTimer = setTimeout(() => {
      this.shareAgentPresenceExpiryTimer = null;
      if (!this.isShareMode) return;
      this.updateShareBannerAgentControlDisplay();
    }, delayMs);
  }

  private ensureShareBannerResponsiveCSS(): void {
    if (document.getElementById('proof-share-banner-responsive-css')) return;
    const style = document.createElement('style');
    style.id = 'proof-share-banner-responsive-css';
    style.textContent = `
      @keyframes proof-agent-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.40), 0 0 0 0.5px rgba(0,0,0,0.08); }
        50% { box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.00), 0 0 0 0.5px rgba(0,0,0,0.08); }
      }
      #share-banner .share-pill-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #share-banner .share-pill-human-avatars {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
      }
      #share-banner .share-pill-agent-trigger .agent-btn-label {
        white-space: nowrap;
      }
      #share-banner .share-pill-agent-trigger.has-agents {
        padding: 0 4px;
      }
      #share-banner .share-pill-status-inline {
        display:inline-flex;
        align-items:center;
        gap:6px;
        flex-shrink:0;
      }
      #share-banner .share-pill-status-inline .status-label {
        color:#6b7280;
        font-size:11px;
        font-weight:500;
        line-height:1;
      }
      #share-banner .share-pill-status-sep {
        width:1px;
        height:14px;
        background:rgba(0,0,0,0.10);
        flex-shrink:0;
      }
      #share-banner .proof-avatar-tooltip {
        position:absolute;
        top:calc(100% + 6px);
        left:50%;
        transform:translateX(-50%);
        background:#1a1a1a;
        color:#fff;
        font-size:11px;
        font-weight:500;
        padding:4px 8px;
        border-radius:6px;
        white-space:nowrap;
        pointer-events:none;
        opacity:0;
        transition:opacity 0.12s ease;
        z-index:1000;
        line-height:1.3;
      }
      #share-banner .proof-avatar-tooltip::before {
        content:'';
        position:absolute;
        bottom:100%;
        left:50%;
        transform:translateX(-50%);
        border:4px solid transparent;
        border-bottom-color:#1a1a1a;
      }
      #share-banner .proof-avatar-wrap:hover .proof-avatar-tooltip {
        opacity:1;
      }
      #share-banner .share-pill-agent-btn.menu-open .proof-avatar-tooltip {
        display:none !important;
      }
      @media (max-width: 480px) {
        #share-banner {
          left: 12px !important;
          right: 12px !important;
          transform: none !important;
          min-width: unset !important;
          max-width: unset !important;
          padding: 8px 10px 8px 14px !important;
          gap: 8px !important;
          top: 16px !important;
        }
        #share-banner .share-pill-sep {
          display: none !important;
        }
        #share-banner .share-pill-title {
          flex: 1 1 auto !important;
          min-width: 0 !important;
        }
        #share-banner .share-pill-human-avatars {
          display: none !important;
        }
        #share-banner .share-pill-agent-trigger {
          padding: 0 10px !important;
        }
        #share-banner .share-pill-agent-trigger.has-agents {
          padding: 0 2px !important;
        }
        #share-banner .share-pill-agent-trigger .agent-btn-label {
          font-size: 11px !important;
        }
        #share-banner .share-pill-status-inline .status-label {
          display:none !important;
        }
        #share-banner .share-pill-status-sep {
          display:none !important;
        }
        #share-banner .proof-avatar-tooltip {
          display:none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  private updateShareBannerPresenceDisplay(): void {
    const container = this.shareBannerAvatarsEl;
    if (!container) return;
    const avatars = this.getHumanCollaboratorAvatars();
    container.className = 'share-pill-human-avatars';
    container.style.cssText = 'display:none;align-items:center;flex-shrink:0;padding-left:4px;position:relative;';
    container.replaceChildren();

    if (avatars.length === 0) {
      container.removeAttribute('role');
      container.removeAttribute('tabindex');
      container.removeAttribute('aria-label');
      container.onclick = null;
      container.onkeydown = null;
      return;
    }
    container.style.display = 'inline-flex';
    container.style.cursor = 'pointer';
    container.setAttribute('role', 'button');
    container.setAttribute('tabindex', '0');
    container.setAttribute('aria-label', `${avatars.length} collaborator${avatars.length === 1 ? '' : 's'}`);

    for (let i = 0; i < Math.min(avatars.length, 5); i++) {
      const avatar = avatars[i];
      const wrap = document.createElement('span');
      wrap.className = 'proof-avatar-wrap';
      wrap.style.cssText = `display:inline-flex;align-items:center;justify-content:center;margin-left:${i > 0 ? '-6px' : '0'};z-index:${5 - i};position:relative;`;
      const circle = document.createElement('span');
      circle.textContent = avatar.initial;
      circle.style.cssText = `
        width:24px;height:24px;border-radius:50%;
        background:${avatar.color};color:#fff;
        font-size:11px;font-weight:600;
        display:inline-flex;align-items:center;justify-content:center;
        border:2px solid #fff;
        box-shadow:0 0 0 0.5px rgba(0,0,0,0.08);
      `;
      const tooltip = document.createElement('span');
      tooltip.className = 'proof-avatar-tooltip';
      const tooltipName = document.createElement('span');
      tooltipName.style.cssText = 'display:block;font-weight:600';
      tooltipName.textContent = avatar.name;
      const tooltipType = document.createElement('span');
      tooltipType.style.cssText = 'display:block;font-size:10px;opacity:0.7;margin-top:1px';
      tooltipType.textContent = 'Collaborator';
      tooltip.append(tooltipName, tooltipType);
      wrap.appendChild(circle);
      wrap.appendChild(tooltip);
      container.appendChild(wrap);
    }
    if (avatars.length > 5) {
      const overflow = document.createElement('span');
      overflow.textContent = `+${avatars.length - 5}`;
      overflow.style.cssText = `
        width:24px;height:24px;border-radius:50%;
        background:#e5e7eb;color:#4b5563;
        font-size:10px;font-weight:600;
        display:inline-flex;align-items:center;justify-content:center;
        border:2px solid #fff;margin-left:-6px;
      `;
      container.appendChild(overflow);
    }

    const openPresenceMenu = () => {
      this.closeShareMenu();
      this.closeAgentMenu();
      if (this.presenceMenuCleanup) {
        this.closePresenceMenu();
        return;
      }

      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.style.cssText = `
        position:absolute;top:calc(100% + 8px);right:0;min-width:190px;
        background:rgba(17,24,39,0.96);border:1px solid rgba(255,255,255,0.12);
        border-radius:12px;padding:8px;z-index:1002;
        box-shadow:0 16px 40px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      `;

      const header = document.createElement('div');
      header.textContent = 'Collaborators';
      header.style.cssText = 'padding:4px 8px 8px 8px;color:rgba(255,255,255,0.70);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;';
      menu.appendChild(header);

      for (const avatar of avatars.slice(0, 10)) {
        const row = document.createElement('div');
        row.setAttribute('role', 'menuitem');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;';
        const dot = document.createElement('span');
        dot.style.cssText = `width:18px;height:18px;border-radius:50%;background:${avatar.color};color:#fff;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;`;
        dot.textContent = avatar.initial;
        const name = document.createElement('span');
        name.textContent = avatar.name;
        name.style.cssText = 'color:rgba(255,255,255,0.92);font-size:12px;font-weight:500;';
        row.append(dot, name);
        menu.appendChild(row);
      }

      container.appendChild(menu);
      this.clampMenuToViewport(menu);

      const onDocMouseDown = (ev: MouseEvent) => {
        if (!(ev.target instanceof Node)) return;
        if (container.contains(ev.target)) return;
        cleanup();
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup();
      };
      const cleanup = () => {
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (menu.isConnected) menu.remove();
        if (this.presenceMenuCleanup === cleanup) this.presenceMenuCleanup = null;
      };
      this.presenceMenuCleanup = cleanup;
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    };

    container.onclick = openPresenceMenu;
    container.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      openPresenceMenu();
    };
  }

  private setupTitleEditing(titleEl: HTMLElement): void {
    if (!this.collabCanEdit) {
      titleEl.style.cursor = '';
      titleEl.removeAttribute('role');
      titleEl.removeAttribute('tabindex');
      if (titleEl.contentEditable === 'true') {
        this.shareBannerTitleEditing = false;
        titleEl.contentEditable = 'false';
      }
      return;
    }
    titleEl.style.cursor = 'text';
    titleEl.setAttribute('role', 'button');
    titleEl.setAttribute('tabindex', '0');
    if (titleEl.dataset.titleEditBound === 'true') return;
    titleEl.dataset.titleEditBound = 'true';

    const startEdit = () => {
      if (!this.collabCanEdit) return;
      if (titleEl.contentEditable === 'true') return;
      this.shareBannerTitleEditing = true;
      titleEl.contentEditable = 'true';
      titleEl.style.outline = 'none';
      titleEl.style.borderBottom = '1px solid rgba(0,0,0,0.15)';
      titleEl.style.color = '#111827';
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    titleEl.addEventListener('click', startEdit);
    titleEl.addEventListener('keydown', (event) => {
      if (titleEl.contentEditable !== 'true' && event.key !== 'Enter' && event.key !== ' ') return;
      if (titleEl.contentEditable !== 'true') {
        event.preventDefault();
        startEdit();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        titleEl.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.shareBannerTitleEditing = false;
        titleEl.contentEditable = 'false';
        titleEl.style.borderBottom = '';
        titleEl.style.color = '#374151';
        titleEl.textContent = this.shareDocTitle || 'Untitled';
      }
    });

    titleEl.addEventListener('blur', () => {
      void this.commitShareBannerTitleEdit(titleEl);
    });
  }

  private async commitShareBannerTitleEdit(titleEl: HTMLElement): Promise<void> {
    if (!this.shareBannerTitleEditing) return;
    this.shareBannerTitleEditing = false;
    titleEl.contentEditable = 'false';
    titleEl.style.borderBottom = '';
    titleEl.style.color = '#374151';

    const previousTitle = this.shareDocTitle || 'Untitled';
    const nextTitle = titleEl.textContent?.trim() || '';
    if (!nextTitle) {
      titleEl.textContent = previousTitle;
      return;
    }
    if (nextTitle === previousTitle) return;

    const persistSeq = ++this.shareTitlePersistSeq;
    const persistSlug = shareClient.getSlug();
    this.applyShareTitle(nextTitle);
    const result = await shareClient.updateTitle(nextTitle);
    if (persistSeq !== this.shareTitlePersistSeq || persistSlug !== shareClient.getSlug()) return;
    if (result === true) return;
    console.warn('[share] failed to persist header title edit', result);
    this.applyShareTitle(previousTitle);
  }

  private applyShareTitle(title: string | null | undefined): void {
    if (this.shareBannerTitleEditing) return;
    const normalized = typeof title === 'string' ? title.trim() : '';
    const nextTitle = normalized.length > 0 ? normalized : 'Untitled';
    this.shareDocTitle = nextTitle;
    document.title = `${nextTitle} - Proof`;
    this.updateShareBannerTitleDisplay();
  }

  private updateShareBannerTitleDisplay(): void {
    if (!this.shareBannerTitleEl || this.shareBannerTitleEditing) return;
    this.setupTitleEditing(this.shareBannerTitleEl);
    const label = this.shareDocTitle || 'Untitled';
    this.shareBannerTitleEl.textContent = label;
    this.shareBannerTitleEl.title = `${label} — ${this.getViewerText(this.shareOtherViewerCount)}`;
  }

  private updateShareBannerAgentControlDisplay(): void {
    if (!this.shareBannerAgentSlotEl) {
      this.clearShareAgentPresenceExpiryTimer();
      return;
    }
    const { entries: agents, nextExpiryAtMs } = this.collectConnectedAgentEntries();
    this.scheduleShareAgentPresenceExpiryRefresh(nextExpiryAtMs);
    const nextState = agents.length > 0 ? 'connected' : 'empty';
    const signature = agents.map((agent) => `${agent.id}:${agent.status}:${agent.at}`).join('|');
    if (
      this.shareBannerAgentSlotEl.dataset.agentState === nextState
      && this.shareBannerAgentSlotEl.dataset.agentSignature === signature
      && this.shareBannerAgentSlotEl.firstElementChild
    ) return;
    this.closeAgentMenu();
    this.shareBannerAgentSlotEl.dataset.agentState = nextState;
    this.shareBannerAgentSlotEl.dataset.agentSignature = signature;
    this.shareBannerAgentSlotEl.replaceChildren(this.createAgentMenuButton(agents));
  }

  private updateShareBannerSyncDisplay(): void {
    if (!this.shareBannerSyncDotEl || !this.shareBannerSyncLabelEl) return;
    const syncStatus = this.getShareSyncStatus();
    const shouldPulse = this.collabConnectionStatus === 'connecting'
      || (this.collabConnectionStatus === 'connected' && (!this.collabIsSynced || this.collabUnsyncedChanges > 0));

    this.shareBannerSyncDotEl.style.background = syncStatus.color;
    if (shouldPulse) {
      this.ensureShareStatusPulseStyle();
      this.shareBannerSyncDotEl.style.animation = 'shareStatusPulse 1.2s ease-in-out infinite';
    } else {
      this.shareBannerSyncDotEl.style.animation = '';
    }

    const statusText = this.getSyncStatusTextLabel(syncStatus.label);
    this.shareBannerSyncLabelEl.textContent = statusText;
    this.shareBannerSyncLabelEl.style.display = this.shouldShowStatusText(statusText) ? '' : 'none';
  }

  private renderShareBannerContent(banner: HTMLElement, otherViewerCount: number): void {
    this.ensureShareBannerResponsiveCSS();
    this.shareOtherViewerCount = otherViewerCount;
    if (
      this.shareBannerTitleEl
      && this.shareBannerAvatarsEl
      && this.shareBannerAgentSlotEl
      && this.shareBannerSyncDotEl
      && this.shareBannerSyncLabelEl
      && banner.contains(this.shareBannerTitleEl)
    ) {
      this.updateShareBannerTitleDisplay();
      this.updateShareBannerPresenceDisplay();
      this.updateShareBannerAgentControlDisplay();
      this.updateShareBannerSyncDisplay();
      this.scheduleBannerLayoutUpdate();
      return;
    }

    this.closeShareMenu();
    this.closePresenceMenu();
    this.closeAgentMenu();

    const wordmark = document.createElement('a');
    wordmark.textContent = 'Proof';
    wordmark.href = 'https://www.proofeditor.ai';
    wordmark.target = '_blank';
    wordmark.rel = 'noopener';
    wordmark.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 8px;border-radius:10px;font-weight:600;color:#333;font-size:13px;letter-spacing:-0.2px;flex-shrink:0;text-decoration:none;';

    const separator = document.createElement('span');
    separator.className = 'share-pill-sep';
    separator.style.cssText = 'width:1px;height:16px;background:rgba(0,0,0,0.1);flex-shrink:0';

    const title = document.createElement('span');
    title.className = 'share-pill-title';
    title.style.cssText = 'font-weight:500;color:#374151;font-size:13px;flex:1 1 auto;min-width:0;';
    this.shareBannerTitleEl = title;
    this.updateShareBannerTitleDisplay();
    this.setupTitleEditing(title);

    const avatars = document.createElement('span');
    this.shareBannerAvatarsEl = avatars;
    this.updateShareBannerPresenceDisplay();

    const agentSlot = document.createElement('span');
    agentSlot.className = 'share-pill-agent-slot';
    agentSlot.style.cssText = 'display:inline-flex;align-items:center;flex-shrink:0;';
    this.shareBannerAgentSlotEl = agentSlot;
    this.updateShareBannerAgentControlDisplay();

    const syncStatusSep = document.createElement('span');
    syncStatusSep.className = 'share-pill-status-sep';
    const syncStatusInline = document.createElement('span');
    syncStatusInline.className = 'share-pill-status-inline';
    const syncDot = document.createElement('span');
    syncDot.style.cssText = 'width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0;';
    const syncLabel = document.createElement('span');
    syncLabel.className = 'status-label';
    this.shareBannerSyncDotEl = syncDot;
    this.shareBannerSyncLabelEl = syncLabel;
    syncStatusInline.append(syncDot, syncLabel);
    this.updateShareBannerSyncDisplay();

    const shareBtn = this.createShareMenuButton();

    banner.replaceChildren(wordmark, separator, title, syncStatusSep, syncStatusInline, avatars, agentSlot, shareBtn);
    this.scheduleBannerLayoutUpdate();
  }

  private uninstallShareAgentPresenceObservers(): void {
    this.clearShareAgentPresenceExpiryTimer();
    if (this.shareAgentPresenceCleanup) {
      this.shareAgentPresenceCleanup();
      this.shareAgentPresenceCleanup = null;
    }
    try {
      const awareness: any = collabClient.getAwareness();
      if (awareness) {
        const clientIds = Array.from(this.shareAgentAwarenessClientIds.values());
        if (clientIds.length) removeAwarenessStates(awareness, clientIds as any, 'agent-cursor-cleanup');
      }
    } catch {
      // ignore
    }
    this.shareAgentAwarenessClientIds.clear();
    this.shareAgentAwarenessClocks.clear();
    this.shareAgentPresenceFallback.clear();
    this.shareAgentPresenceIcons.clear();
    this.shareAgentPresenceSummary = '';
    this.shareAgentActivitySignature = '';
    this.shareAgentActivityItems = [];
  }

  private installShareAgentPresenceObservers(): void {
    if (!this.isShareMode || !this.collabEnabled) return;
    if (this.shareAgentPresenceCleanup) return;

    const ydoc: any = collabClient.getYDoc();
    if (!ydoc || typeof ydoc.getMap !== 'function' || typeof ydoc.getArray !== 'function') return;

    const presenceMap: any = ydoc.getMap('agentPresence');
    const activityArr: any = ydoc.getArray('agentActivity');
    const cursorMap: any = ydoc.getMap('agentCursors');

    const refreshCursors = () => {
      if (!this.editor) return;
      const awareness: any = collabClient.getAwareness();
      if (!awareness) return;

      const hints: any[] = [];
      try {
        cursorMap.forEach((value: any) => hints.push(value));
      } catch {
        // ignore
      }

      const activeAgentIds = new Set<string>();
      for (const hint of hints) {
        const agentId = typeof hint?.id === 'string' ? hint.id.trim() : '';
        if (agentId && isAgentScopedId(agentId)) activeAgentIds.add(agentId);
      }
      this.ensureShareAgentPresenceIcons(activeAgentIds);

      const existingAgentIds = new Set<string>(this.shareAgentAwarenessClientIds.keys());
      for (const agentId of existingAgentIds) {
        if (activeAgentIds.has(agentId)) continue;
        const clientId = this.shareAgentAwarenessClientIds.get(agentId);
        if (typeof clientId === 'number') {
          try { removeAwarenessStates(awareness, [clientId] as any, 'agent-cursor-expired'); } catch { /* ignore */ }
        }
        this.shareAgentAwarenessClientIds.delete(agentId);
        this.shareAgentAwarenessClocks.delete(agentId);
      }

      if (hints.length === 0) return;

      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const ystate = (ySyncPluginKey.getState(view.state) as any) ?? null;
        const binding = ystate?.binding ?? null;
        const type = binding?.type ?? null;
        const mapping = binding?.mapping ?? null;
        if (!type || !mapping) return;

        const states = awareness.getStates?.() as Map<number, any> | undefined;
        const usedClientIds = new Set<number>();
        if (states && typeof states.keys === 'function') {
          for (const id of states.keys()) usedClientIds.add(id);
        }
        if (typeof awareness.clientID === 'number') usedClientIds.add(awareness.clientID);

        const allocateClientId = (agentId: string): number => {
          const existing = this.shareAgentAwarenessClientIds.get(agentId);
          if (typeof existing === 'number') return existing;

          // Deterministic-ish client id in a high range; bump if it collides.
          let hash = 0;
          for (let i = 0; i < agentId.length; i++) {
            hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
          }
          let candidate = 1_000_000_000 + (Math.abs(hash) % 1_000_000_000);
          while (usedClientIds.has(candidate)) {
            candidate = (candidate + 1) % 2_147_483_647;
            if (candidate < 1_000_000_000) candidate = 1_000_000_000;
          }

          usedClientIds.add(candidate);
          this.shareAgentAwarenessClientIds.set(agentId, candidate);
          return candidate;
        };

        for (const hint of hints) {
          const agentId = typeof hint?.id === 'string' ? hint.id.trim() : '';
          if (!agentId || !isAgentScopedId(agentId)) continue;

          const quote = typeof hint?.quote === 'string' && hint.quote.trim() ? hint.quote.trim() : null;
          const name = typeof hint?.name === 'string' && hint.name.trim() ? hint.name.trim() : agentId;
          const color = this.getAgentPresenceColor(agentId);
          const avatar = this.getAgentPresenceAvatar(agentId);

          let from = view.state.doc.content.size;
          let to = from;
          if (quote) {
            const resolved = resolveQuoteRange(view.state.doc, quote);
            if (resolved) {
              from = resolved.from;
              to = resolved.to;
            }
          }

          let anchorRel: any;
          let headRel: any;
          try {
            anchorRel = absolutePositionToRelativePosition(from, type, mapping);
            headRel = absolutePositionToRelativePosition(to, type, mapping);
          } catch {
            continue;
          }

          const clientId = allocateClientId(agentId);
          const clock = (this.shareAgentAwarenessClocks.get(agentId) ?? 0) + 1;
          this.shareAgentAwarenessClocks.set(agentId, clock);

          const state = {
            user: { name, color, avatar },
            cursor: { anchor: anchorRel, head: headRel },
          };

          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, 1);
          encoding.writeVarUint(enc, clientId);
          encoding.writeVarUint(enc, clock);
          encoding.writeVarString(enc, JSON.stringify(state));
          const update = encoding.toUint8Array(enc);

          try {
            applyAwarenessUpdate(awareness, update, 'agent-cursor');
          } catch {
            // ignore
          }
        }
      });
    };

    const refresh = () => {
      const nowMs = Date.now();
      const ttlMs = 60_000;
      const entries: any[] = [];
      try {
        presenceMap.forEach((value: any) => entries.push(value));
      } catch {
        // ignore
      }

      const fresh = entries.filter((e) => {
        if (!e || typeof e !== 'object') return false;
        const at = (e as any).at;
        if (typeof at !== 'string' || !at.trim()) return true;
        const parsed = Date.parse(at);
        if (!Number.isFinite(parsed)) return true;
        return (nowMs - parsed) <= ttlMs;
      });

      const active = fresh.filter((e) => e && typeof e === 'object' && typeof e.status === 'string' && e.status !== 'idle');
      const chosen = (active.length > 0 ? active : fresh).slice(0, 3);
      const summary = chosen.length > 0
        ? `Agents: ${chosen.map((e) => {
          const name = (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : (typeof e.id === 'string' ? e.id : 'agent');
          const status = (typeof e.status === 'string' && e.status.trim()) ? e.status.trim() : 'idle';
          return `${name} (${status})`;
        }).join(', ')}`
        : '';

      let activity: any[] = [];
      try {
        activity = typeof activityArr.toArray === 'function' ? activityArr.toArray() : [];
      } catch {
        activity = [];
      }
      const items = activity
        .filter((v) => v && typeof v === 'object' && !Array.isArray(v))
        .slice(-50) as Array<Record<string, any>>;

      const activitySignature = items
        .map((item) => `${String(item.type ?? '')}:${String(item.id ?? '')}:${String(item.status ?? '')}:${String(item.at ?? '')}`)
        .join('|');
      const summaryChanged = summary !== this.shareAgentPresenceSummary;
      const activityChanged = activitySignature !== this.shareAgentActivitySignature;

      this.shareAgentPresenceSummary = summary;
      this.shareAgentActivitySignature = activitySignature;
      this.shareAgentActivityItems = items;

      if (summaryChanged || activityChanged) {
        this.updateShareBannerPresenceDisplay();
        this.updateShareBannerAgentControlDisplay();
      }
    };

    try {
      presenceMap.observe(refresh);
      activityArr.observe(refresh);
      cursorMap.observe(refreshCursors);
    } catch {
      // ignore observer install failures
    }
    this.shareAgentPresenceCleanup = () => {
      try { presenceMap.unobserve(refresh); } catch { /* ignore */ }
      try { activityArr.unobserve(refresh); } catch { /* ignore */ }
      try { cursorMap.unobserve(refreshCursors); } catch { /* ignore */ }
    };

    refresh();
    refreshCursors();
  }

  private openShareActivityModal(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:1100;
      background:rgba(0,0,0,0.55);
      display:flex;align-items:flex-start;justify-content:center;
      padding:48px 16px;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      width:min(720px, 100%);
      background:rgba(17,24,39,0.98);
      border:1px solid rgba(255,255,255,0.12);
      border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,0.45);
      color:rgba(255,255,255,0.92);
      overflow:hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.10)';
    const title = document.createElement('div');
    title.textContent = 'Activity';
    title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:0.02em';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText = 'border:0;background:rgba(255,255,255,0.10);color:white;padding:6px 10px;border-radius:999px;font-size:12px;cursor:pointer';
    header.append(title, close);

    const body = document.createElement('div');
    body.style.cssText = 'max-height:60vh;overflow:auto;padding:10px 16px 16px 16px';

    const items = this.shareAgentActivityItems.slice(-50).reverse();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No activity yet.';
      empty.style.cssText = 'padding:14px 0;color:rgba(255,255,255,0.70);font-size:12px;line-height:1.35';
      body.appendChild(empty);
    } else {
      for (const item of items) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:12px;line-height:1.35';
        const when = typeof item.at === 'string' ? item.at : '';
        const who = typeof item.name === 'string' ? item.name : (typeof item.id === 'string' ? item.id : 'agent');
        const status = typeof item.status === 'string' ? item.status : (typeof item.type === 'string' ? item.type : '');
        const details = typeof item.details === 'string' ? item.details : '';
        row.textContent = `${when}  ${who}  ${status}${details ? ` — ${details}` : ''}`;
        body.appendChild(row);
      }
    }

    panel.append(header, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const cleanup = () => {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cleanup();
    };
    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) cleanup();
    });
    close.onclick = cleanup;
  }

  private openAgentHelpModal(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:1100;
      background:rgba(0,0,0,0.55);
      display:flex;align-items:flex-start;justify-content:center;
      padding:48px 16px;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      width:min(560px, 100%);
      background:rgba(17,24,39,0.98);
      border:1px solid rgba(255,255,255,0.12);
      border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,0.45);
      color:rgba(255,255,255,0.92);
      overflow:hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.10)';
    const title = document.createElement('div');
    title.textContent = 'Use an agent collaborator in this doc';
    title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:0.02em';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText = 'border:0;background:rgba(255,255,255,0.10);color:white;padding:6px 10px;border-radius:999px;font-size:12px;cursor:pointer';
    header.append(title, close);

    const body = document.createElement('div');
    body.style.cssText = 'padding:14px 16px 16px 16px;color:rgba(255,255,255,0.86);font-size:12px;line-height:1.5;';
    body.innerHTML = `
      <p style="margin:0 0 10px 0;">Agent collaborators can suggest and edit with the same permissions as the link you share.</p>
      <p style="margin:0 0 8px 0;"><strong>How to connect:</strong></p>
      <ol style="margin:0 0 10px 18px;padding:0;">
        <li>Copy the agent invite link.</li>
        <li>Paste it into your AI tool (for example, ChatGPT or Claude).</li>
        <li>The agent appears here when connected.</li>
      </ol>
      <p style="margin:0;color:rgba(255,255,255,0.72);">Disconnect removes live presence from this doc, but does not revoke the link.</p>
    `;

    panel.append(header, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const cleanup = () => {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cleanup();
    };
    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) cleanup();
    });
    close.onclick = cleanup;
  }

  private closeShareMenu(): void {
    if (!this.shareMenuCleanup) return;
    const cleanup = this.shareMenuCleanup;
    this.shareMenuCleanup = null;
    cleanup();
  }

  private closePresenceMenu(): void {
    if (!this.presenceMenuCleanup) return;
    const cleanup = this.presenceMenuCleanup;
    this.presenceMenuCleanup = null;
    cleanup();
  }

  private closeAgentMenu(): void {
    if (!this.agentMenuCleanup) return;
    const cleanup = this.agentMenuCleanup;
    this.agentMenuCleanup = null;
    cleanup();
  }

  private clampMenuToViewport(menu: HTMLElement): void {
    const margin = 12;
    const rect = menu.getBoundingClientRect();
    let shift = 0;
    if (rect.left < margin) {
      shift = margin - rect.left;
    } else if (rect.right > (window.innerWidth - margin)) {
      shift = (window.innerWidth - margin) - rect.right;
    }
    if (shift !== 0) {
      menu.style.transform = `translateX(${Math.round(shift)}px)`;
    }
  }

  private getCanonicalShareUrl(): string {
    try {
      const url = new URL(window.location.href);
      // Keep tokenized URLs intact. Share links are designed to be copy-pastable.
      url.pathname = url.pathname.replace(/\/+$/, '');
      return url.toString();
    } catch {
      return window.location.href;
    }
  }

  private copyWithPromptFallback(text: string, promptLabel = 'Copy link:'): boolean {
    try {
      window.prompt(promptLabel, text);
      return true;
    } catch {
      return false;
    }
  }

  private triggerHaptic(pattern: 'light' | 'medium' | 'success' | 'selection' = 'light'): void {
    void this.webHaptics.trigger(pattern);
  }

  private async copyLinkWithFallback(url: string): Promise<boolean> {
    const copied = await this.copyTextToClipboard(url);
    if (copied) {
      this.triggerHaptic('success');
      return true;
    }
    const prompted = this.copyWithPromptFallback(url);
    if (prompted) this.triggerHaptic('medium');
    return prompted;
  }

  private extractShareSlugFromUrl(shareUrl: string): string | null {
    try {
      const url = new URL(shareUrl);
      const match = url.pathname.match(/\/d\/([^/?#]+)/);
      if (!match?.[1]) return null;
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  private extractShareTokenFromUrl(shareUrl: string): string | null {
    try {
      const url = new URL(shareUrl);
      const token = url.searchParams.get('token');
      if (!token || !token.trim()) return null;
      return token.trim();
    } catch {
      return null;
    }
  }

  private getAgentInviteMessage(): string {
    const shareUrl = this.getCanonicalShareUrl();
    const slug = shareClient.getSlug() || this.extractShareSlugFromUrl(shareUrl);
    const token = this.extractShareTokenFromUrl(shareUrl);
    const origin = (() => {
      try {
        return new URL(shareUrl).origin;
      } catch {
        return window.location.origin;
      }
    })();

    if (!slug) {
      return [
        'Collaborate with me on this Proof doc.',
        '',
        `Doc: ${shareUrl}`,
      ].join('\n');
    }

    const encodedSlug = encodeURIComponent(slug);
    const presenceUrl = `${origin}/api/agent/${encodedSlug}/presence`;
    const stateUrl = `${origin}/api/agent/${encodedSlug}/state`;
    const opsUrl = `${origin}/api/agent/${encodedSlug}/ops`;
    const editUrl = `${origin}/api/agent/${encodedSlug}/edit`;

    return [
      'Collaborate with me on this Proof doc.',
      '',
      `Doc: ${shareUrl}`,
      '',
      'Auth for each API request:',
      `- x-share-token: ${token || '<token-from-doc-url>'}`,
      '- X-Agent-Id: <your-agent-id>',
      '- (Use the token from the Doc URL query param: ?token=...)',
      '',
      'Start here:',
      '1) Read current document state with your identity header:',
      `   GET ${stateUrl}`,
      '   header: X-Agent-Id: <your-agent-id>',
      '2) Optionally set your friendly name in presence:',
      `   POST ${presenceUrl}`,
      '   body: {"agentId":"<your-agent-id>","name":"<your-name>","status":"active"}',
      '3) If edits/comments are useful based on state, apply them with:',
      `   POST ${opsUrl}`,
      `   or POST ${editUrl}`,
      '4) Then reply briefly with what you changed or suggest next steps.',
    ].join('\n');
  }

  private async copyAgentInviteWithFallback(): Promise<boolean> {
    const message = this.getAgentInviteMessage();
    const copied = await this.copyTextToClipboard(message);
    if (copied) {
      this.triggerHaptic('success');
      return true;
    }
    const prompted = this.copyWithPromptFallback(message, 'Copy agent invite:');
    if (prompted) this.triggerHaptic('medium');
    return prompted;
  }

  private showShareWelcomeToastOnce(capabilities?: { canComment: boolean; canEdit: boolean } | null): void {
    const slug = shareClient.getSlug();
    if (!slug) return;

    try {
      const key = `proof_share_welcome_${slug}`;
      if (sessionStorage.getItem(key) === '1') return;
      sessionStorage.setItem(key, '1');
    } catch {
      // sessionStorage best-effort
    }

    if (this.shareWelcomeToast) {
      this.shareWelcomeToast.remove();
      this.shareWelcomeToast = null;
    }

    const message = capabilities?.canEdit
      ? 'This document was shared with you. You can edit it, and your changes are saved automatically.'
      : capabilities?.canComment
        ? 'This document was shared with you. You can leave comments.'
        : 'This document was shared with you for viewing.';

    const toast = document.createElement('div');
    toast.className = 'proof-external-change-toast proof-share-welcome-toast';
    toast.innerHTML = `
      <div class="proof-toast-content">
        <span class="proof-toast-message">${message}</span>
      </div>
    `;

    document.body.appendChild(toast);
    this.shareWelcomeToast = toast;
    this.positionShareWelcomeToast(toast);
    requestAnimationFrame(() => {
      if (this.shareWelcomeToast !== toast) return;
      this.positionShareWelcomeToast(toast);
    });

    setTimeout(() => {
      if (this.shareWelcomeToast !== toast) return;
      toast.remove();
      this.shareWelcomeToast = null;
    }, 5000);
  }

  private positionShareWelcomeToast(toast: HTMLElement): void {
    const banner = document.getElementById('share-banner');
    const isMobile = window.innerWidth <= 480;
    const pageMargin = isMobile ? 12 : 12;
    let top = 12;
    if (banner) {
      const rect = banner.getBoundingClientRect();
      top = Math.max(12, Math.round(rect.bottom + 10));
    }

    if (isMobile) {
      toast.style.top = 'auto';
      toast.style.bottom = `${pageMargin}px`;
      toast.style.left = `${pageMargin}px`;
      toast.style.right = `${pageMargin}px`;
      toast.style.maxWidth = 'none';
    } else {
      toast.style.top = `${top}px`;
      toast.style.bottom = '';
      toast.style.left = '';
      toast.style.right = `${pageMargin}px`;
      toast.style.maxWidth = '340px';
    }
  }

  private createShareMenuButton(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'share-pill-share-btn';
    container.style.cssText = 'position:relative;display:inline-flex;align-items:center';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Share options');
    btn.style.cssText = `
      display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;min-width:44px;padding:0 16px;background:#111;
      border:none;border-radius:22px;color:#fff;font-size:13px;font-weight:600;
      cursor:pointer;transition:background 0.15s;flex-shrink:0;font-family:inherit;
    `;

    const label = document.createElement('span');
    label.textContent = 'Share';
    const caret = document.createElement('span');
    caret.textContent = '▾';
    caret.style.cssText = 'font-size:10px;opacity:0.7';
    btn.append(label, caret);

    btn.onmouseenter = () => {
      btn.style.background = '#333';
    };
    btn.onmouseleave = () => {
      btn.style.background = '#111';
    };

    const openMenu = () => {
      this.closeAgentMenu();
      this.closePresenceMenu();
      if (this.shareMenuCleanup) {
        this.closeShareMenu();
        return;
      }

      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.style.cssText = `
        position:absolute;top:calc(100% + 8px);right:0;min-width:240px;
        background:rgba(17,24,39,0.96);border:1px solid rgba(255,255,255,0.12);
        border-radius:12px;padding:6px;z-index:1002;
        box-shadow:0 16px 40px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      `;

      const addItem = (title: string, onSelect: (itemLabel: HTMLSpanElement) => Promise<boolean> | boolean, opts?: { subtle?: boolean; disabled?: boolean }) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.style.cssText = `
          width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
          padding:10px 12px;min-height:44px;border-radius:10px;border:0;background:transparent;
          color:${opts?.subtle ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.92)'};
          font-size:12px;font-weight:${opts?.subtle ? '500' : '600'};cursor:pointer;text-align:left;
        `;
        item.onmouseenter = () => { if (!opts?.disabled) item.style.background = 'rgba(255,255,255,0.08)'; };
        item.onmouseleave = () => { item.style.background = 'transparent'; };
        if (opts?.disabled) {
          item.disabled = true;
          item.style.opacity = '0.55';
          item.style.cursor = 'default';
        }

        const left = document.createElement('span');
        left.textContent = title;
        const right = document.createElement('span');
        right.textContent = '';
        right.style.cssText = 'font-weight:600;opacity:0.9';

        item.append(left, right);
        item.onclick = async () => {
          if (opts?.disabled) return;
          const ok = await onSelect(left);
          right.textContent = ok ? 'Copied' : 'Failed';
          if (ok) {
            setTimeout(() => cleanup(), 700);
          } else {
            setTimeout(() => { right.textContent = ''; }, 1200);
          }
        };

        menu.appendChild(item);
      };

      const addActionItem = (title: string, onSelect: () => void, opts?: { subtle?: boolean; disabled?: boolean }) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.style.cssText = `
          width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
          padding:10px 12px;min-height:44px;border-radius:10px;border:0;background:transparent;
          color:${opts?.subtle ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.92)'};
          font-size:12px;font-weight:${opts?.subtle ? '500' : '600'};cursor:pointer;text-align:left;
        `;
        item.onmouseenter = () => { if (!opts?.disabled) item.style.background = 'rgba(255,255,255,0.08)'; };
        item.onmouseleave = () => { item.style.background = 'transparent'; };
        if (opts?.disabled) {
          item.disabled = true;
          item.style.opacity = '0.55';
          item.style.cursor = 'default';
        }

        const left = document.createElement('span');
        left.textContent = title;
        const right = document.createElement('span');
        right.textContent = '›';
        right.style.cssText = 'font-weight:700;opacity:0.8';
        item.append(left, right);
        item.onclick = () => {
          if (opts?.disabled) return;
          onSelect();
          cleanup();
        };
        menu.appendChild(item);
      };

      const addDivider = () => {
        const hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:6px 6px';
        menu.appendChild(hr);
      };

      addItem('Copy link', async () => this.copyLinkWithFallback(this.getCanonicalShareUrl()));
      addDivider();
      addActionItem('View activity', () => this.openShareActivityModal());

      container.appendChild(menu);
      this.clampMenuToViewport(menu);

      const onDocMouseDown = (ev: MouseEvent) => {
        if (!(ev.target instanceof Node)) return;
        if (container.contains(ev.target)) return;
        cleanup();
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup();
      };

      const cleanup = () => {
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (menu.isConnected) menu.remove();
        if (this.shareMenuCleanup === cleanup) {
          this.shareMenuCleanup = null;
        }
      };

      this.shareMenuCleanup = cleanup;
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    };

    btn.onclick = () => {
      this.triggerHaptic('selection');
      openMenu();
    };

    container.appendChild(btn);
    return container;
  }

  private createAgentMenuButton(
    seedAgents?: Array<{
      id: string;
      name: string;
      status: string;
      color: string;
      avatar?: string;
      at: string;
    }>,
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'share-pill-agent-btn';
    container.style.cssText = 'position:relative;display:inline-flex;align-items:center';
    const agents = seedAgents ?? this.getConnectedAgentEntries();
    const hasAgents = agents.length > 0;

    const buildAgentFace = (
      agent: {
        id: string;
        name: string;
        avatar?: string;
      },
      options: {
        size: number;
        title: string;
        zIndex?: number;
        marginLeft?: number;
      },
    ): HTMLSpanElement => {
      const family = this.getAgentPresenceVariant(agent.id);
      const palette = getAgentFacePalette(family);
      const face = createAgentFaceElement({
        family,
        size: options.size,
        title: options.title,
        wrapperClassName: 'share-pill-agent-face',
        className: 'share-pill-agent-face__svg',
      });
      face.dataset.agentFamily = family;
      face.style.animation = 'proof-agent-pulse 2s ease-in-out infinite';
      face.style.filter = 'drop-shadow(0 1px 1px rgba(15,23,42,0.10))';
      face.style.borderRadius = '999px';
      face.style.boxShadow = `0 0 0 1px ${palette.accent}22`;
      face.style.position = 'relative';
      face.style.zIndex = String(options.zIndex ?? 1);
      if (typeof options.marginLeft === 'number') {
        face.style.marginLeft = `${options.marginLeft}px`;
      }
      return face;
    };

    const buildAgentStack = (
      items: Array<{
        id: string;
        name: string;
        avatar?: string;
      }>,
    ): { element: HTMLSpanElement; tooltipLabel: string; tooltipSubtext: string } => {
      const stack = document.createElement('span');
      stack.style.cssText = 'display:inline-flex;align-items:center;justify-content:flex-start;position:relative;height:26px;';

      if (items.length === 1) {
        stack.style.width = '26px';
        stack.appendChild(buildAgentFace(items[0], {
          size: 26,
          title: `${items[0].name} icon`,
          zIndex: 2,
        }));
        return {
          element: stack,
          tooltipLabel: items[0].name,
          tooltipSubtext: 'agent collaborator',
        };
      }

      const visible = items.slice(0, 2);
      const faceSize = 23;
      const overlap = -7;
      const chipGap = 5;
      const overflowCount = Math.max(0, items.length - 2);
      const stackWidth = faceSize + (visible.length - 1) * (faceSize + overlap) + (overflowCount > 0 ? 24 + chipGap : 0);
      stack.style.width = `${stackWidth}px`;

      visible.forEach((agent, index) => {
        stack.appendChild(buildAgentFace(agent, {
          size: faceSize,
          title: `${agent.name} icon`,
          zIndex: visible.length - index + 1,
          marginLeft: index === 0 ? 0 : overlap,
        }));
      });

      if (overflowCount > 0) {
        const chip = document.createElement('span');
        chip.textContent = `+${overflowCount}`;
        chip.className = 'share-pill-agent-overflow';
        chip.style.cssText = `
          margin-left:${chipGap}px;
          min-width:24px;height:18px;padding:0 6px;border-radius:999px;
          background:rgba(17,24,39,0.92);color:#fff;font-size:10px;font-weight:700;line-height:1;
          display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;
          box-shadow:0 1px 4px rgba(0,0,0,0.22);
          font-variant-numeric: tabular-nums;
        `;
        stack.appendChild(chip);
      }

      return {
        element: stack,
        tooltipLabel: `${items.length} agent collaborators`,
        tooltipSubtext: 'Click to manage',
      };
    };

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-pill-agent-trigger';
    if (hasAgents) {
      btn.classList.add('has-agents');
      btn.setAttribute('aria-label', `${agents.length} agent collaborator${agents.length === 1 ? '' : 's'}. Open actions`);
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.style.cssText = `
        display:inline-flex;align-items:center;justify-content:center;gap:0;min-height:44px;min-width:44px;padding:0 4px;
        background:transparent;border:0;border-radius:18px;color:#111827;cursor:pointer;
        transition:background 0.15s;flex-shrink:0;font-family:inherit;
      `;

      const wrap = document.createElement('span');
      wrap.className = 'proof-avatar-wrap';
      wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;position:relative;';
      const stack = buildAgentStack(agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
      })));
      wrap.appendChild(stack.element);
      const tooltip = document.createElement('span');
      tooltip.className = 'proof-avatar-tooltip';
      const tooltipName = document.createElement('span');
      tooltipName.style.cssText = 'display:block;font-weight:600';
      tooltipName.textContent = stack.tooltipLabel;
      const tooltipType = document.createElement('span');
      tooltipType.style.cssText = 'display:block;font-size:10px;opacity:0.7;margin-top:1px';
      tooltipType.textContent = stack.tooltipSubtext;
      tooltip.append(tooltipName, tooltipType);
      wrap.appendChild(tooltip);
      wrap.dataset.agentCount = String(agents.length);

      btn.appendChild(wrap);
      btn.onmouseenter = () => {
        btn.style.background = 'rgba(17,24,39,0.06)';
      };
      btn.onmouseleave = () => {
        btn.style.background = 'transparent';
      };
    } else {
      btn.setAttribute('aria-label', 'Add agent');
      btn.style.cssText = `
        display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;min-width:44px;padding:0 12px;
        background:rgba(255,255,255,0.7);border:1px solid rgba(17,24,39,0.10);border-radius:22px;color:#111827;
        font-size:12px;font-weight:500;cursor:pointer;transition:background 0.15s,border-color 0.15s;flex-shrink:0;font-family:inherit;
      `;

      const icon = document.createElement('span');
      icon.textContent = '+';
      icon.style.cssText = 'font-size:12px;line-height:1;color:#6b7280;';
      btn.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'agent-btn-label';
      label.textContent = 'Add agent';
      label.style.cssText = 'font-size:12px;font-weight:600;line-height:1;';
      btn.appendChild(label);

      btn.onmouseenter = () => {
        btn.style.background = '#fff';
        btn.style.borderColor = 'rgba(17,24,39,0.20)';
      };
      btn.onmouseleave = () => {
        btn.style.background = 'rgba(255,255,255,0.7)';
        btn.style.borderColor = 'rgba(17,24,39,0.10)';
      };
    }

    const openMenu = () => {
      this.closeShareMenu();
      this.closePresenceMenu();
      if (this.agentMenuCleanup) {
        this.closeAgentMenu();
        return;
      }
      container.classList.add('menu-open');
      btn.setAttribute('aria-expanded', 'true');

      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.style.cssText = `
        position:absolute;top:calc(100% + 8px);right:0;min-width:280px;max-width:min(360px, calc(100vw - 24px));
        background:rgba(17,24,39,0.96);border:1px solid rgba(255,255,255,0.12);
        border-radius:12px;padding:8px;z-index:1002;
        box-shadow:0 16px 40px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      `;

      const addDivider = () => {
        const hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:8px 6px';
        menu.appendChild(hr);
      };

      const addMenuButton = (
        title: string,
        onSelect: () => Promise<boolean> | boolean,
        options?: {
          subtle?: boolean;
          destructive?: boolean;
          disabled?: boolean;
          successText?: string;
          failureText?: string;
        },
      ) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.style.cssText = `
          width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
          padding:10px 12px;min-height:44px;border-radius:10px;border:0;background:transparent;
          color:${options?.destructive ? '#fca5a5' : (options?.subtle ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.92)')};
          font-size:12px;font-weight:${options?.subtle ? '500' : '600'};cursor:pointer;text-align:left;
        `;
        item.onmouseenter = () => { if (!options?.disabled) item.style.background = 'rgba(255,255,255,0.08)'; };
        item.onmouseleave = () => { item.style.background = 'transparent'; };
        if (options?.disabled) {
          item.disabled = true;
          item.style.opacity = '0.55';
          item.style.cursor = 'default';
        }

        const left = document.createElement('span');
        left.textContent = title;
        const right = document.createElement('span');
        right.style.cssText = 'font-weight:600;opacity:0.85';
        item.append(left, right);
        item.onclick = async () => {
          if (options?.disabled) return;
          const ok = await onSelect();
          right.textContent = ok ? (options?.successText ?? 'Done') : (options?.failureText ?? 'Failed');
          if (ok) {
            setTimeout(() => cleanup(), 400);
          } else {
            setTimeout(() => { right.textContent = ''; }, 1200);
          }
        };
        menu.appendChild(item);
      };

      const agentsNow = this.getConnectedAgentEntries();
      if (agentsNow.length === 0) {
        const header = document.createElement('div');
        header.textContent = 'Add an agent';
        header.style.cssText = 'padding:8px 12px 4px;color:#fff;font-size:13px;font-weight:700;';
        const body = document.createElement('div');
        body.textContent = 'Invite an agent collaborator to edit, suggest, and review this doc.';
        body.style.cssText = 'padding:0 12px 8px;color:rgba(255,255,255,0.78);font-size:12px;line-height:1.35;';
        menu.append(header, body);
        addMenuButton('Copy agent invite link', async () => this.copyAgentInviteWithFallback(), {
          successText: 'Copied',
        });
        addDivider();
        addMenuButton('How agent access works', async () => {
          this.openAgentHelpModal();
          return true;
        }, { subtle: true, successText: 'Done' });
      } else {
        const header = document.createElement('div');
        header.textContent = `Agent collaborators (${agentsNow.length})`;
        header.style.cssText = 'padding:8px 12px 6px;color:rgba(255,255,255,0.85);font-size:11px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;';
        menu.appendChild(header);
        for (const agent of agentsNow.slice(0, 6)) {
          const row = document.createElement('div');
          row.dataset.agentRow = agent.id;
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;min-height:44px;border-radius:10px;background:rgba(255,255,255,0.04);margin-bottom:4px;';
          const left = document.createElement('div');
          left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';
          const family = this.getAgentPresenceVariant(agent.id);
          const face = createAgentFaceElement({
            family,
            size: 18,
            title: `${agent.name} icon`,
            wrapperClassName: 'share-menu-agent-face',
            className: 'share-menu-agent-face__svg',
          });
          face.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.16))';
          const dot = document.createElement('span');
          dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${agent.status === 'idle' ? '#6b7280' : '#10b981'};display:inline-block;flex-shrink:0`;
          const name = document.createElement('span');
          name.textContent = agent.name;
          name.style.cssText = 'color:#fff;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          left.append(face, dot, name);

          const right = document.createElement('div');
          right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';

          if (this.collabCanEdit) {
            const disconnect = document.createElement('button');
            disconnect.type = 'button';
            disconnect.setAttribute('aria-label', `Disconnect ${agent.name}`);
            disconnect.textContent = 'Disconnect';
            disconnect.style.cssText = `
              border:0;background:transparent;color:#fca5a5;font-size:11px;font-weight:600;
              padding:3px 0;cursor:pointer;border-radius:6px;
            `;
            disconnect.onmouseenter = () => { disconnect.style.color = '#fecaca'; };
            disconnect.onmouseleave = () => { disconnect.style.color = '#fca5a5'; };
            disconnect.onclick = async (event) => {
              event.stopPropagation();
              disconnect.disabled = true;
              disconnect.textContent = '...';
              const result = await shareClient.disconnectAgentPresence(agent.id);
              if (result && typeof result === 'object' && 'error' in result) {
                disconnect.disabled = false;
                disconnect.textContent = 'Retry';
                return;
              }
              const ok = result === true;
              if (!ok) {
                disconnect.disabled = false;
                disconnect.textContent = 'Retry';
                return;
              }
              row.remove();
              this.updateShareBannerPresenceDisplay();
              this.updateShareBannerAgentControlDisplay();
              if (!menu.querySelector('[data-agent-row]')) cleanup();
            };
            right.appendChild(disconnect);
          }

          row.append(left, right);
          menu.appendChild(row);
        }
        addDivider();
        addMenuButton('Copy agent invite link', async () => this.copyAgentInviteWithFallback(), {
          successText: 'Copied',
        });
      }

      container.appendChild(menu);
      this.clampMenuToViewport(menu);
      const onDocMouseDown = (ev: MouseEvent) => {
        if (!(ev.target instanceof Node)) return;
        if (container.contains(ev.target)) return;
        cleanup();
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup();
      };
      const cleanup = () => {
        container.classList.remove('menu-open');
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (menu.isConnected) menu.remove();
        if (this.agentMenuCleanup === cleanup) this.agentMenuCleanup = null;
      };
      this.agentMenuCleanup = cleanup;
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    };

    btn.onclick = () => {
      this.triggerHaptic('selection');
      openMenu();
    };
    container.appendChild(btn);
    return container;
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for environments where Clipboard API is unavailable.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        return copied;
      } catch {
        return false;
      }
    }
  }

  private showShareBanner(viewers: number): void {
    this.clearShareBanner();
    const banner = document.createElement('div');
    banner.id = 'share-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(255,255,255,0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      color: #374151;
      border: 1px solid rgba(0,0,0,0.06);
      border-radius: 28px;
      padding: 10px 12px 10px 22px;
      font-size: 13px;
      font-weight: 400;
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: calc(100vw - 24px);
      box-sizing: border-box;
      box-shadow: 0 6px 24px rgba(0,0,0,0.06), 0 0 0 0.5px rgba(0,0,0,0.03);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-width: min(480px, calc(100vw - 24px));
    `;
    this.shareOtherViewerCount = Math.max(0, viewers);
    this.renderShareBannerContent(banner, this.shareOtherViewerCount);
    document.body.appendChild(banner);
    this.scheduleBannerLayoutUpdate();
  }

  private clearShareBanner(): void {
    this.clearShareAgentPresenceExpiryTimer();
    this.closeShareMenu();
    this.closePresenceMenu();
    this.closeAgentMenu();
    this.shareBannerTitleEditing = false;
    this.shareBannerTitleEl = null;
    this.shareBannerAvatarsEl = null;
    this.shareBannerAgentSlotEl = null;
    this.shareBannerSyncDotEl = null;
    this.shareBannerSyncLabelEl = null;
    if (this.shareStatusHideTimer) {
      clearTimeout(this.shareStatusHideTimer);
      this.shareStatusHideTimer = null;
    }
    if (this.shareDocumentUpdatedTimer) {
      clearTimeout(this.shareDocumentUpdatedTimer);
      this.shareDocumentUpdatedTimer = null;
    }
    if (this.shareMarksRefreshTimer) {
      clearTimeout(this.shareMarksRefreshTimer);
      this.shareMarksRefreshTimer = null;
    }
    this.pendingShareMarksRefresh = false;
    const existing = document.getElementById('share-banner');
    if (!existing) return;
    existing.remove();
    this.scheduleBannerLayoutUpdate();
  }

  applyExternalMarks(marks: Record<string, StoredMark>): void {
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Use applyRemoteMarks to create ProseMirror anchors for new marks
      // (using the `quote` field) and merge metadata for existing marks.
      applyRemoteMarks(view, marks, { hydrateAnchors: this.collabCanEdit });
    });
  }

  private applyLatestCollabMarksToEditor(): void {
    if (!this.isShareMode || !this.collabEnabled || !this.editor) return;
    if (Object.keys(this.lastReceivedServerMarks).length === 0) return;
    if (this.isEditorDocStructurallyEmpty()) return;

    this.applyingCollabRemote = true;
    this.suppressMarksSync = true;
    try {
      this.applyExternalMarks(this.lastReceivedServerMarks);
    } finally {
      this.suppressMarksSync = false;
      this.applyingCollabRemote = false;
    }
  }

  private resetProjectionPublishState(): void {
    this.hasCompletedInitialCollabHydration = !this.isShareMode || !this.collabEnabled;
    this.hasLocalContentEditSinceHydration = false;
    this.lastContentChangeSource = null;
    this.pendingProjectionPublish = false;
  }

  private recordContentChangeSource(source: 'local' | 'remote' | 'system'): void {
    if (!this.isShareMode || !this.collabEnabled) return;
    this.lastContentChangeSource = source;
    if (!this.hasCompletedInitialCollabHydration) return;
    if (source === 'remote') {
      this.hasLocalContentEditSinceHydration = false;
      this.pendingProjectionPublish = false;
      return;
    }
    if (source !== 'local') return;
    this.hasLocalContentEditSinceHydration = true;
  }

  private markInitialCollabHydrationComplete(): void {
    this.hasCompletedInitialCollabHydration = true;
  }

  private shouldPublishProjectionMarkdown(
    source: 'content-sync' | 'direct-content' | 'marks-change' | 'marks-flush',
  ): boolean {
    if (!this.collabEnabled || !this.collabCanEdit) return false;
    if (this.isShareMode) return false;
    if (!this.hasCompletedInitialCollabHydration) return false;
    if (source === 'marks-change' || source === 'marks-flush') return false;
    if (source === 'content-sync' && this.lastContentChangeSource !== 'local') return false;
    return this.hasLocalContentEditSinceHydration;
  }

  private canPublishProjectionMarkdownNow(): boolean {
    if (!this.collabEnabled || !this.collabCanEdit) return false;
    if (!this.isShareMode) return true;
    return this.collabConnectionStatus === 'connected'
      && this.collabIsSynced
      && this.collabUnsyncedChanges === 0;
  }

  private publishProjectionMarkdown(
    view: import('@milkdown/kit/prose/view').EditorView,
    markdown: string,
    source: 'content-sync' | 'direct-content' | 'marks-change' | 'marks-flush',
  ): void {
    if (!this.shouldPublishProjectionMarkdown(source)) return;
    if (!this.canPublishProjectionMarkdownNow()) {
      this.pendingProjectionPublish = true;
      return;
    }
    collabClient.setProjectionMarkdown(this.normalizeMarkdownForCollab(markdown));
    this.pendingProjectionPublish = false;
  }

  private flushPendingProjectionMarkdown(): void {
    if (!this.pendingProjectionPublish || !this.editor || !this.canPublishProjectionMarkdownNow()) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const serializer = ctx.get(serializerCtx);
      const markdown = this.normalizeMarkdownForRuntime(serializer(view.state.doc));
      if (!markdown) return;
      this.lastMarkdown = markdown;
      collabClient.setProjectionMarkdown(this.normalizeMarkdownForCollab(markdown));
      this.pendingProjectionPublish = false;
    });
  }

  private flushShareMarks(_options?: { keepalive?: boolean; persistContent?: boolean }): void {
    if (!this.isShareMode || !this.editor || this.suppressMarksSync) return;
    if (!this.initialMarksSynced) return;
    this.editor.action((ctx) => {
      try {
        const view = ctx.get(editorViewCtx);
        const localMetadata = getMarkMetadataWithQuotes(view.state);
        const metadata = mergePendingServerMarks(localMetadata, this.lastReceivedServerMarks);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;
        const serializer = ctx.get(serializerCtx);
        const markdown = this.normalizeMarkdownForRuntime(serializer(view.state.doc));
        const shouldPersistContent = shouldKeepalivePersistShareContent({
          keepalive: Boolean(_options?.keepalive),
          persistContent: _options?.persistContent,
          collabEnabled: this.collabEnabled,
          collabCanEdit: this.collabCanEdit,
          hasCompletedInitialCollabHydration: this.hasCompletedInitialCollabHydration,
          hasLocalContentEditSinceHydration: this.hasLocalContentEditSinceHydration,
          collabConnectionStatus: this.collabConnectionStatus,
          collabIsSynced: this.collabIsSynced,
          collabUnsyncedChanges: this.collabUnsyncedChanges,
          collabPendingLocalUpdates: this.collabPendingLocalUpdates,
          markdown,
        });
        const shouldPersistMarks = shouldKeepalivePersistShareMarks({
          keepalive: Boolean(_options?.keepalive),
          collabEnabled: this.collabEnabled,
          collabCanEdit: this.collabCanEdit,
          hasCompletedInitialCollabHydration: this.hasCompletedInitialCollabHydration,
          hasLocalContentEditSinceHydration: this.hasLocalContentEditSinceHydration,
          collabUnsyncedChanges: this.collabUnsyncedChanges,
          collabPendingLocalUpdates: this.collabPendingLocalUpdates,
        });
        if (this.collabEnabled && this.collabCanEdit) {
          this.publishProjectionMarkdown(view, markdown, 'marks-flush');
          collabClient.setMarksMetadata(metadata);
        }
        if (shouldPersistContent) {
          const allowLocalKeepaliveBaseToken = shouldUseLocalKeepaliveBaseToken({
            keepalive: Boolean(_options?.keepalive),
            collabEnabled: this.collabEnabled,
            collabCanEdit: this.collabCanEdit,
            hasCompletedInitialCollabHydration: this.hasCompletedInitialCollabHydration,
            collabIsSynced: this.collabIsSynced,
            collabUnsyncedChanges: this.collabUnsyncedChanges,
            collabPendingLocalUpdates: this.collabPendingLocalUpdates,
          });
          void shareClient.pushUpdate(markdown, metadata, getCurrentActor(), {
            keepalive: Boolean(_options?.keepalive),
            allowLocalKeepaliveBaseToken,
          });
          return;
        }
        if (!shouldPersistMarks) {
          return;
        }
        if (!this.collabEnabled || !this.collabCanEdit || LEGACY_REST_FALLBACK) {
          void shareClient.pushMarks(metadata, getCurrentActor(), { keepalive: Boolean(_options?.keepalive) });
        }
      } catch (error) {
        console.error('[flushShareMarks] Failed to push marks via collab runtime:', error);
      }
    });
  }

  private showReadOnlyBanner(): void {
    if (this.readOnlyBanner) return;

    const banner = document.createElement('div');
    banner.id = 'readonly-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: #f59e0b;
      color: white;
      padding: 8px 16px;
      text-align: center;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
    `;
    banner.textContent = 'Read-only mode — changes will not be saved';
    document.body.appendChild(banner);

    this.readOnlyBanner = banner;
    this.updateEditableState();
    this.scheduleBannerLayoutUpdate();
  }

  private scheduleBannerLayoutUpdate(): void {
    requestAnimationFrame(() => this.updateBannerLayout());
  }

  private applyTopChromeForMode(): void {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) {
      if (this.isShareMode) {
        toolbar.style.display = 'none';
        toolbar.setAttribute('aria-hidden', 'true');
      } else {
        toolbar.style.display = '';
        toolbar.removeAttribute('aria-hidden');
      }
    }

    if (this.isShareMode) {
      document.documentElement.style.background = '#fff';
      document.body.style.background = '#fff';
    }
  }

  private updateBannerLayout(): void {
    const editor = document.getElementById('editor');
    if (!editor) return;

    const banners: HTMLElement[] = [];
    const shareBanner = document.getElementById('share-banner');
    if (shareBanner) banners.push(shareBanner);
    if (this.readOnlyBanner) banners.push(this.readOnlyBanner);
    if (this.reviewLockBanner) banners.push(this.reviewLockBanner);

    if (banners.length === 0) {
      editor.style.paddingTop = '';
      return;
    }

    let offset = shareBanner ? 18 : 0;
    for (const banner of banners) {
      banner.style.top = `${offset}px`;
      const height = banner.offsetHeight || banner.getBoundingClientRect().height;
      offset += height;
    }

    const extraSpacing = 32;
    editor.style.paddingTop = `${Math.ceil(offset + extraSpacing)}px`;
  }

  private updateEditableState(viewOverride?: EditorView): void {
    const isEditable = !this.isReadOnly
      && this.reviewLockCount === 0
      && (!this.isShareMode || this.shareAllowLocalEdits);

    const applyEditableState = (view: EditorView) => {
      view.setProps({
        editable: () => isEditable,
      });
    };

    if (viewOverride) {
      applyEditableState(viewOverride);
      return;
    }

    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      applyEditableState(view);
    });
  }

  private ensureReviewLockBanner(): void {
    if (!this.reviewLockBanner) {
      const banner = document.createElement('div');
      banner.id = 'review-lock-banner';
      banner.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: #2563eb;
        color: white;
        padding: 8px 16px;
        text-align: center;
        font-size: 14px;
        font-weight: 600;
        z-index: 1000;
      `;
      document.body.appendChild(banner);
      this.reviewLockBanner = banner;
    }

    this.updateReviewLockBannerText();
    this.scheduleBannerLayoutUpdate();
  }

  private updateReviewLockBannerText(): void {
    if (!this.reviewLockBanner) return;
    const suffix = this.reviewLockReason ? ` — ${this.reviewLockReason}` : '';
    this.reviewLockBanner.textContent = `Review running — editing is temporarily locked${suffix}`;
  }

  private removeReviewLockBanner(): void {
    if (!this.reviewLockBanner) return;
    this.reviewLockBanner.remove();
    this.reviewLockBanner = null;
    this.scheduleBannerLayoutUpdate();
  }

  private getReviewLockState(): { locked: boolean; lockCount: number; reason?: string } {
    return {
      locked: this.reviewLockCount > 0,
      lockCount: this.reviewLockCount,
      reason: this.reviewLockReason ?? undefined,
    };
  }

  private showErrorBanner(
    message: string,
    options?: { retryLabel?: string; onRetry?: () => void },
  ): void {
    this.clearErrorBanner();
    const banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: #ef4444;
      color: white;
      padding: 8px 16px;
      text-align: center;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      flex-wrap: wrap;
    `;
    const text = document.createElement('span');
    text.textContent = `Error: ${message}`;
    banner.appendChild(text);

    if (options?.onRetry) {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.textContent = options.retryLabel ?? 'Retry';
      retryButton.style.cssText = `
        border: 1px solid rgba(255,255,255,0.45);
        background: rgba(255,255,255,0.12);
        color: white;
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      `;
      retryButton.onclick = () => options.onRetry?.();
      banner.appendChild(retryButton);
    }

    document.body.prepend(banner);
    this.scheduleBannerLayoutUpdate();
  }

  private clearErrorBanner(): void {
    const banner = document.getElementById('error-banner');
    if (!banner) return;
    banner.remove();
    this.scheduleBannerLayoutUpdate();
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
    if (error && typeof error === 'object') {
      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
        return maybeMessage.trim();
      }
    }
    return 'Load failed';
  }

  private isShareRequestError(value: unknown): value is {
    error: { status: number; code: string; message: string };
  } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as { error?: unknown };
    if (!payload.error || typeof payload.error !== 'object' || Array.isArray(payload.error)) return false;
    const err = payload.error as { status?: unknown; code?: unknown; message?: unknown };
    return typeof err.status === 'number'
      && typeof err.code === 'string'
      && typeof err.message === 'string';
  }

  private shouldRetryShareInitError(error: unknown): boolean {
    const message = this.getErrorMessage(error).toLowerCase();
    if (message.includes('not found') || message.includes('unshared')) return false;
    if (message.includes('upgrade required')) return false;
    return (
      message.includes('load failed')
      || message.includes('failed to fetch')
      || message.includes('network')
      || message.includes('timed out')
      || message.includes('live collaboration is currently unavailable')
    );
  }

  private resetShareInitRetryState(): void {
    this.shareInitRetryCount = 0;
    if (this.shareInitRetryTimer) {
      clearTimeout(this.shareInitRetryTimer);
      this.shareInitRetryTimer = null;
    }
  }

  private setupCursorTracking(): void {
    if (!this.editor) return;

    let cursorTimeout: ReturnType<typeof setTimeout> | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const dom = view.dom;

      const reportCursor = () => {
        if (cursorTimeout) clearTimeout(cursorTimeout);
        cursorTimeout = setTimeout(() => {
          void view.state.selection.from;
        }, 50);
      };

      const reportKeyboardActivity = (event: KeyboardEvent) => {
        // Ignore modifier-only key events; they aren't meaningful typing activity.
        if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
          reportCursor();
          return;
        }
        this.reportEditorInputActivity('keyboard');
        reportCursor();
      };

      const reportInputActivity = () => {
        this.reportEditorInputActivity('input');
      };

      dom.addEventListener('keyup', reportKeyboardActivity);
      dom.addEventListener('beforeinput', reportInputActivity);
      dom.addEventListener('paste', reportInputActivity);
      dom.addEventListener('drop', reportInputActivity);
      dom.addEventListener('compositionend', reportInputActivity);
      dom.addEventListener('mouseup', reportCursor);
    });
  }

  private reportEditorInputActivity(source: 'keyboard' | 'input'): void {
    const now = Date.now();
    this.lastLocalTypingAt = now;
    if (now - this.lastEditorInputActivitySentAt < 500) return;
    this.lastEditorInputActivitySentAt = now;
    void source;
  }

  private noteLocalContentMutation(): void {
    this.lastLocalTypingAt = Date.now();
  }

  private isYjsChangeOriginTransaction(transaction: any): boolean {
    const ySyncMeta = transaction?.getMeta?.(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
    if (ySyncMeta?.isChangeOrigin === true) return true;

    const rawMeta = (transaction as { meta?: Record<string, unknown> } | null)?.meta;
    if (!rawMeta || typeof rawMeta !== 'object') return false;

    for (const [key, value] of Object.entries(rawMeta)) {
      if (!key.startsWith('y-sync')) continue;
      if (value === true) return true;
      if (value && typeof value === 'object' && (value as { isChangeOrigin?: boolean }).isChangeOrigin === true) {
        return true;
      }
    }
    return false;
  }

  private stabilizeCursorAfterRemoteYjsTransaction(
    view: EditorView,
    sourceTransaction: any,
    beforeSelectionFrom: number,
    beforeSelectionEmpty: boolean,
    dispatchBase: (transaction: any) => void,
  ): void {
    if (!this.isShareMode || !this.collabEnabled) return;
    if (!beforeSelectionEmpty || !view.state.selection.empty) return;
    if (!view.hasFocus()) return;

    if (!this.isYjsChangeOriginTransaction(sourceTransaction)) return;

    if ((Date.now() - this.lastLocalTypingAt) > this.remoteCursorStabilityWindowMs) return;

    let mappedCursor = beforeSelectionFrom;
    const mapping = sourceTransaction?.mapping;
    if (mapping && typeof mapping.map === 'function') {
      try {
        mappedCursor = mapping.map(beforeSelectionFrom, 1);
      } catch {
        mappedCursor = beforeSelectionFrom;
      }
    }

    const docSize = view.state.doc.content.size;
    const targetPos = Math.max(0, Math.min(mappedCursor, docSize));
    const currentPos = view.state.selection.from;
    if (targetPos <= currentPos) return;

    try {
      // @ts-expect-error - TextSelection is available at runtime
      const TextSelection = view.state.selection.constructor;
      const $target = view.state.doc.resolve(targetPos);
      const stabilizedSelection = TextSelection.near($target, 1);
      const stabilizeTr = view.state.tr
        .setSelection(stabilizedSelection)
        .setMeta('addToHistory', false);
      dispatchBase(stabilizeTr);
    } catch {
      // Ignore selection stabilization failures; never break the primary transaction.
    }
  }

  /**
   * Set up the suggestions interceptor to convert edits to tracked changes
   * when suggestion mode is enabled.
   */
  private setupSuggestionsInterceptor(): void {
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Store the original dispatchTransaction
      const originalDispatch = view.dispatch.bind(view);

      // Override dispatchTransaction to intercept edits
      (view as any).dispatch = (tr: any) => {
        const dispatchWithRevision = (transaction: any) => {
          originalDispatch(transaction);
          if (transaction?.docChanged) {
            this.revision += 1;
          }
        };
        const beforeSelectionFrom = view.state.selection.from;
        const beforeSelectionEmpty = view.state.selection.empty;
        const isRemoteContentChange = Boolean(tr?.docChanged) && this.isYjsChangeOriginTransaction(tr);
        const isMarksOnlyChange = tr?.getMeta?.(marksPluginKey) !== undefined;
        const isDocumentLoad = tr?.getMeta?.('document-load') !== undefined;
        const isLocalContentChange = Boolean(tr?.docChanged)
          && !isRemoteContentChange
          && !isMarksOnlyChange
          && !isDocumentLoad;

        // Check if suggestions are enabled
        const pluginState = suggestionsPluginKey.getState(view.state);
        const suggestionsEnabled = pluginState?.enabled ?? false;

        if (isRemoteContentChange) {
          this.recordContentChangeSource('remote');
        } else if (isLocalContentChange) {
          this.noteLocalContentMutation();
          this.recordContentChangeSource('local');
        } else if (tr?.docChanged) {
          this.recordContentChangeSource('system');
        }

        if (suggestionsEnabled && tr.docChanged) {
          // Don't intercept meta transactions (like enabling/disabling suggestions)
          if (tr.getMeta(suggestionsPluginKey) !== undefined) {
            dispatchWithRevision(tr);
            return;
          }

          // Don't intercept marks operations (accept/reject suggestions)
          // These are internal operations that should not be converted to suggestions
          if (tr.getMeta(marksPluginKey) !== undefined) {
            dispatchWithRevision(tr);
            return;
          }

          // Don't intercept document load transactions
          if (tr.getMeta('document-load') !== undefined) {
            dispatchWithRevision(tr);
            return;
          }

          // Don't intercept Yjs-origin collaborative transactions.
          if (this.isYjsChangeOriginTransaction(tr)) {
            originalDispatch(tr);
            return;
          }

          // Don't intercept undo/redo transactions (from history plugin)
          if (tr.getMeta('history$') !== undefined || tr.getMeta('addToHistory') === false) {
            dispatchWithRevision(tr);
            return;
          }

          // Wrap the transaction to convert edits to suggestions
          const wrappedTr = wrapTransactionForSuggestions(tr, view.state, true);
          dispatchWithRevision(wrappedTr);
        } else {
          dispatchWithRevision(tr);
        }

        this.stabilizeCursorAfterRemoteYjsTransaction(
          view,
          tr,
          beforeSelectionFrom,
          beforeSelectionEmpty,
          originalDispatch,
        );
      };

      console.log('[setupSuggestionsInterceptor] Suggestions interceptor installed');
    });
  }

  private posToLineCol(doc: import('@milkdown/kit/prose/model').Node, pos: number): { line: number; col: number } {
    let line = 0;
    let col = pos;

    doc.nodesBetween(0, pos, (node, nodePos) => {
      if (node.isBlock && nodePos < pos) {
        line++;
        col = pos - nodePos - 1;
      }
      return true;
    });

    return { line: Math.max(0, line - 1), col };
  }

  private scheduleContentSync(): void {
    if (!this.editor) return;
    if (this.contentSyncTimeout) {
      clearTimeout(this.contentSyncTimeout);
    }

    this.contentSyncTimeout = setTimeout(() => {
      this.editor?.action((innerCtx) => {
        const view = innerCtx.get(editorViewCtx);
        let markdown: string | null = null;

        try {
          const serializer = innerCtx.get(serializerCtx);
          markdown = this.normalizeMarkdownForRuntime(serializer(view.state.doc));
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
          console.error('[scheduleContentSync] Failed to serialize document', details);
        }

        if (!markdown || markdown === this.lastMarkdown) return;

        try {
          this.lastMarkdown = markdown;
          this.sendDocumentSnapshot(view, markdown);
          if (this.collabEnabled && this.collabCanEdit && this.shouldPublishProjectionMarkdown('content-sync')) {
            this.publishProjectionMarkdown(view, markdown, 'content-sync');
            const metadata = getMarkMetadataWithQuotes(view.state);
            collabClient.setMarksMetadata(metadata);
          }
          getTriggerService().updateDocumentContent(
            view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
          );
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
          console.error('[scheduleContentSync] Failed to send document snapshot', details);
        }
      });
    }, 150);
  }

  /**
   * Initialize the agent integration for @proof mentions.
   * This sets up the agent with the API key and wires it to the editor.
   */
  private initAgentIntegration(): void {
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Initialize agent with the editor view
      initAgentIntegration(view);

      // Set up the keybindings callback to show the input dialog
      setShowAgentInputCallback((context, callbacks) => {
        showAgentInputDialog(context, callbacks);
      });

      // Initialize context menu with right-click support
      const cleanupContextMenu = initContextMenu(view);

      // Listen for agent invocation events from keybindings and context menu
      const handleAgentInvocation = (event: CustomEvent<{
        prompt: string;
        context: AgentInputContext;
        showDialog?: boolean;
      }>) => {
        const { prompt, context, showDialog } = event.detail;
        captureEvent('agent_ui_invoked', {
          show_dialog: Boolean(showDialog),
          prompt_chars: prompt?.length ?? 0,
          has_selection: Boolean(context.selection?.trim()),
        });

        if (showDialog) {
          // Show dialog first
          showAgentInputDialog(context, {
            onSubmit: async (userPrompt: string) => {
              this.invokeAgentOnSelection(view, userPrompt, context);
            },
            onCancel: () => {},
          });
        } else if (prompt) {
          // Direct invocation with prompt
          this.invokeAgentOnSelection(view, prompt, context);
        }
      };

      window.addEventListener('proof:invoke-agent', handleAgentInvocation as EventListener);

      console.log('[Editor] Agent integration initialized with keybindings and context menu');
    });
  }

  /**
   * Invoke the agent on a selection with the given prompt
   */
  private invokeAgentOnSelection(
    view: import('@milkdown/kit/prose/view').EditorView,
    prompt: string,
    context: AgentInputContext
  ): void {
    console.log('[Editor] Invoking agent on selection:', { prompt, context });

    // Import and use the agent session manager (will be created in Phase 1)
    // For now, create a comment with the request for @proof to handle
    const selectedText = context.selection;
    const actor = getCurrentActor();
    captureEvent('agent_manual_request', {
      prompt_chars: prompt.length,
      has_selection: Boolean(selectedText.trim()),
    });

    if (selectedText.trim()) {
      // Create a comment with @proof mention to trigger the agent
      markComment(view, selectedText, actor, `@proof ${prompt}`, context.range);
      captureEvent('agent_manual_request_queued', {
        trigger_type: 'comment',
      });
    } else {
      // No selection - just log for now
      console.log('[Editor] No selection for agent invocation');
      captureEvent('agent_manual_request_dropped', { reason: 'empty_selection' });
    }
  }

  private handleContentChange(markdown: string): void {
    if (!this.editor) return;

    const canonicalMarkdown = this.normalizeMarkdownForRuntime(markdown);
    this.lastMarkdown = canonicalMarkdown;
    this.recordContentChangeSource('local');
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      this.sendDocumentSnapshot(view, canonicalMarkdown);
      if (this.shouldPublishProjectionMarkdown('direct-content')) {
        this.publishProjectionMarkdown(view, canonicalMarkdown, 'direct-content');
        const metadata = getMarkMetadataWithQuotes(view.state);
        collabClient.setMarksMetadata(metadata);
      }
      getTriggerService().updateDocumentContent(
        view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
      );
    });
  }

  private handleMarksChange(
    actionMarks: Mark[],
    view: import('@milkdown/kit/prose/view').EditorView,
    actionMetadata?: Record<string, StoredMark>
  ): void {
    if (this.suppressMarksSync) return;
    // Authored-only edits can trigger marks callbacks with no actionable marks.
    // Skipping avoids pushing stale markdown snapshots during fast typing.
    if (actionMarks.length === 0) return;

    let markdown = this.serializeMarkdown(view);
    if (!markdown) {
      markdown = this.lastMarkdown;
    }
    if (!markdown) return;

    this.lastMarkdown = markdown;
    this.sendDocumentSnapshot(view, markdown, actionMarks);

    const metadata = mergePendingServerMarks(
      actionMetadata ?? getMarkMetadataWithQuotes(view.state),
      this.lastReceivedServerMarks,
    );
    this.lastReceivedServerMarks = { ...metadata };
    this.initialMarksSynced = true;

    if (this.collabEnabled && this.collabCanEdit) {
      collabClient.setMarksMetadata(metadata);
    }

    // In share mode, push marks-only updates immediately for reliability.
    if (this.isShareMode) {
      this.flushShareMarks();
    }

    // Pass marks changes to agent integration for @proof detection
    agentHandleMarksChange(actionMarks, view);
  }

  private serializeMarkdown(view: import('@milkdown/kit/prose/view').EditorView): string | null {
    if (!this.editor) return null;
    try {
      const serializer = this.editor.ctx.get(serializerCtx);
      return this.normalizeMarkdownForRuntime(serializer(view.state.doc));
    } catch (error) {
      const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
      console.error('[serializeMarkdown] Failed to serialize document', details);
      return null;
    }
  }

  private normalizeMarkdownForRuntime(markdown: string): string {
    // Shared/collab runtime treats authored highlights as derived UI state.
    // Keep suggestion/comment proof spans intact while removing authored wrappers.
    if (this.isShareMode || this.collabEnabled) {
      return stripAuthoredSpanTags(markdown);
    }
    return markdown;
  }

  private normalizeMarkdownForCollab(markdown: string): string {
    // Collab transport stays span-free to prevent span reparse drift/duplication.
    // Marks are carried separately in metadata.
    return stripProofSpanTags(this.normalizeMarkdownForRuntime(markdown));
  }

  private sendDocumentSnapshot(
    view: import('@milkdown/kit/prose/view').EditorView,
    markdown: string,
    actionMarksOverride?: Mark[]
  ): void {
    const metadata = getMarkMetadataForDisk(view.state);
    const contentWithMarks = embedMarks(markdown, metadata);
    if (this.isCliMode) {
      fileClient.debouncedSave(contentWithMarks);
    }
    void actionMarksOverride;
  }

  private emitDocumentSnapshotNow(): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let markdown: string | null = null;
      try {
        const serializer = ctx.get(serializerCtx);
        markdown = serializer(view.state.doc);
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
        console.error('[emitDocumentSnapshotNow] Failed to serialize document', details);
        return;
      }

      if (!markdown) return;
      const canonicalMarkdown = this.normalizeMarkdownForRuntime(markdown);
      this.lastMarkdown = canonicalMarkdown;
      this.sendDocumentSnapshot(view, canonicalMarkdown);
    });
  }

  /**
   * Load a document and apply embedded marks metadata.
   */
  loadDocument(content: string, options?: { allowShareContentMutation?: boolean }): void {
    if (!this.editor) {
      console.error('[loadDocument] Editor not initialized');
      return;
    }

    const { content: provenanceStripped, provenance } = extractEmbeddedProvenance(content);
    const { content: cleanContent, marks: embeddedMetadata, legacyMarks = [] } = extractMarks(provenanceStripped);

    if (!this.hasTrackedDocumentOpened) {
      this.hasTrackedDocumentOpened = true;
      captureEvent('document_opened', {
        content_chars: cleanContent.length,
        embedded_marks_count: Object.keys(embeddedMetadata).length,
        legacy_marks_count: legacyMarks.length,
        has_provenance: Boolean(provenance),
      });
    }

    this.lastMarkdown = cleanContent;
    this.suppressMarksSync = true;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);

      const buildLegacyMetadata = (mark: Mark): StoredMark => {
        const base: StoredMark = {
          kind: mark.kind,
          by: mark.by,
          createdAt: mark.at,
        };
        if (mark.range) {
          base.range = { from: mark.range.from, to: mark.range.to };
        }

        if (mark.kind === 'comment') {
          const data = mark.data as CommentData | undefined;
          base.text = data?.text ?? '';
          base.threadId = data?.thread ?? mark.id;
          base.thread = data?.replies ?? [];
          base.resolved = Boolean(data?.resolved);
        } else if (mark.kind === 'insert') {
          const data = mark.data as { content?: string; status?: 'pending' | 'accepted' | 'rejected' } | undefined;
          base.content = data?.content ?? '';
          base.status = data?.status ?? 'pending';
        } else if (mark.kind === 'delete') {
          const data = mark.data as { status?: 'pending' | 'accepted' | 'rejected' } | undefined;
          base.status = data?.status ?? 'pending';
        } else if (mark.kind === 'replace') {
          const data = mark.data as { content?: string; status?: 'pending' | 'accepted' | 'rejected' } | undefined;
          base.content = data?.content ?? '';
          base.status = data?.status ?? 'pending';
        } else if (mark.kind === 'flagged') {
          base.note = (mark.data as { note?: string } | undefined)?.note;
        }

        return base;
      };

      const applyLegacyMarks = (
        legacy: Mark[],
        baseMetadata: Record<string, StoredMark>
      ): Record<string, StoredMark> => {
        if (!legacy.length) return baseMetadata;

        const metadata = { ...baseMetadata };
        const commentThreads = new Map<string, Mark[]>();
        const suggestionMarkType = view.state.schema.marks.proofSuggestion;
        const commentMarkType = view.state.schema.marks.proofComment;
        const flaggedMarkType = view.state.schema.marks.proofFlagged;
        const approvedMarkType = view.state.schema.marks.proofApproved;
        const authoredMarkType = view.state.schema.marks.proofAuthored;

        let markTr = view.state.tr;

        for (const mark of legacy) {
          if (mark.kind === 'comment') {
            const data = mark.data as CommentData | undefined;
            const threadId = data?.thread ?? mark.id;
            const thread = commentThreads.get(threadId) ?? [];
            thread.push(mark);
            commentThreads.set(threadId, thread);
            continue;
          }

          if (!mark.range) continue;

          if (mark.kind === 'authored' && authoredMarkType) {
            markTr = markTr.addMark(mark.range.from, mark.range.to, authoredMarkType.create({ by: mark.by }));
            continue;
          }

          if (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace') {
            if (!suggestionMarkType) continue;
            markTr = markTr.addMark(mark.range.from, mark.range.to, suggestionMarkType.create({
              id: mark.id,
              kind: mark.kind,
              by: mark.by,
            }));
            metadata[mark.id] = buildLegacyMetadata(mark);
            continue;
          }

          if (mark.kind === 'flagged' && flaggedMarkType) {
            markTr = markTr.addMark(mark.range.from, mark.range.to, flaggedMarkType.create({ id: mark.id, by: mark.by }));
            metadata[mark.id] = buildLegacyMetadata(mark);
            continue;
          }

          if (mark.kind === 'approved' && approvedMarkType) {
            markTr = markTr.addMark(mark.range.from, mark.range.to, approvedMarkType.create({ id: mark.id, by: mark.by }));
            metadata[mark.id] = buildLegacyMetadata(mark);
            continue;
          }
        }

        for (const [threadId, threadMarks] of commentThreads.entries()) {
          const sorted = [...threadMarks].sort((a, b) => a.at.localeCompare(b.at));
          const anchor = sorted.find(entry => entry.range) ?? sorted[0];
          if (!anchor || !anchor.range || !commentMarkType) continue;

          markTr = markTr.addMark(anchor.range.from, anchor.range.to, commentMarkType.create({ id: anchor.id, by: anchor.by }));

          const replies = sorted.filter(entry => entry.id !== anchor.id).map(entry => ({
            by: entry.by,
            text: (entry.data as CommentData | undefined)?.text ?? '',
            at: entry.at,
          }));

          metadata[anchor.id] = {
            ...buildLegacyMetadata(anchor),
            threadId,
            thread: replies,
            resolved: Boolean((anchor.data as CommentData | undefined)?.resolved),
          };
        }

        if (markTr.steps.length > 0) {
          view.dispatch(markTr);
        }

        return metadata;
      };

      // Parse the markdown content into a ProseMirror document
      const newDoc = parser(cleanContent);

      // Replace the entire document (mark as document-load to skip human authorship tracking)
      let tr = view.state.tr
        .replaceWith(0, view.state.doc.content.size, newDoc.content)
        .setMeta('document-load', true);
      if (options?.allowShareContentMutation) {
        tr = tr.setMeta(SHARE_CONTENT_FILTER_ALLOW_META, true);
      }
      view.dispatch(tr);

      const authoredMarkType = view.state.schema.marks.proofAuthored;
      let hasAuthoredMarks = false;
      if (authoredMarkType) {
        newDoc.descendants((node) => {
          if (!node.isText) return true;
          if (node.marks.some(mark => mark.type === authoredMarkType)) {
            hasAuthoredMarks = true;
            return false;
          }
          return true;
        });
      }

      let markMetadata = embeddedMetadata;
      let combinedLegacyMarks = legacyMarks ?? [];
      if (provenance?.spans?.length && !hasAuthoredMarks) {
        combinedLegacyMarks = combinedLegacyMarks.concat(
          migrateProvenanceToMarks({ spans: provenance.spans }, cleanContent)
        );
      }

      if (combinedLegacyMarks.length > 0) {
        markMetadata = applyLegacyMarks(combinedLegacyMarks, markMetadata);
      }
      setMarkMetadata(view, markMetadata);

      // Trigger heatmap refresh
      const heatmapTr = view.state.tr.setMeta('heatmapUpdate', true);
      view.dispatch(heatmapTr);

    });
    this.suppressMarksSync = false;
  }

  getContent(): string {
    const root = document.getElementById('editor');
    return root?.textContent || '';
  }

  looksLikeMarkdown(content: string): boolean {
    return looksLikeMarkdownSyntax(content);
  }

  getMarkdownSnapshot(): { content: string } | null {
    if (!this.editor) return null;

    let snapshot: { content: string } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let markdown: string | null = null;

      try {
        const serializer = ctx.get(serializerCtx);
        markdown = serializer(view.state.doc);
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error('[getMarkdownSnapshot] Failed to serialize document', details);
        return;
      }

      if (!markdown) return;

      const metadata = getMarkMetadataForDisk(view.state);
      const contentWithMarks = embedMarks(markdown, metadata);

      this.lastMarkdown = markdown;
      snapshot = {
        content: contentWithMarks,
      };
    });

    return snapshot;
  }

  /**
   * Get the full editor state including cursor, selection, scroll position, and structure.
   * This is the main method for AI agents to understand the current document state.
   */
  getFullState(): EditorFullState | null {
    if (!this.editor) return null;

    let result: EditorFullState | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const { from, to } = view.state.selection;

      // Plain-text projection for stable offsets and mapping logic.
      const plainText = doc.textBetween(0, doc.content.size, '\n', '\n');

      // Also capture markdown for safe round-tripping in tooling workflows.
      let markdownContent: string | undefined;
      try {
        const serializer = ctx.get(serializerCtx);
        const markdown = serializer(doc);
        if (markdown) {
          const metadata = getMarkMetadata(view.state);
          markdownContent = embedMarks(markdown, metadata);
          markdownContent = stripAuthoredSpanTags(markdownContent);
          this.lastMarkdown = markdown;
        }
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error('[getFullState] Failed to serialize markdown snapshot', details);
      }

      // Calculate cursor position
      const cursorOffset = from;
      const { line: cursorLine, col: cursorCol } = this.offsetToLineCol(doc, from);

      // Get selection info
      let selection: EditorFullState['selection'] = null;
      if (from !== to) {
        const selectedText = getTextForRange(doc, { from, to });
        const { line: fromLine } = this.offsetToLineCol(doc, from);
        const { line: toLine } = this.offsetToLineCol(doc, to);
        selection = {
          hasSelection: true,
          from,
          to,
          text: selectedText,
          fromLine,
          toLine,
        };
      }

      // Get scroll/visibility info
      const scroll = this.getVisibleRange(view);

      // Get document structure
      const structure = this.extractStructure(doc);

      const authorshipStats = getAuthorshipStats(view);

      const safeMarkdown = markdownContent ?? plainText;
      result = {
        content: safeMarkdown,
        plainText,
        markdownContent: safeMarkdown,
        revision: this.revision,
        cursor: {
          line: cursorLine,
          column: cursorCol,
          offset: cursorOffset,
        },
        selection,
        focusHeading: null,
        scroll,
        activeMark: null,
        structure,
        authorshipStats,
      };

      if (structure.sections.length > 0) {
        const focusSection = structure.sections
          .filter(section => section.line <= cursorLine)
          .sort((a, b) => a.line - b.line)
          .pop();
        result.focusHeading = focusSection?.heading ?? null;
      }

      const activeMarkId = getActiveMarkId(view.state);
      if (activeMarkId) {
        const marks = getMarks(view.state);
        const active = marks.find(mark => mark.id === activeMarkId);
        if (active) {
          const [resolved] = resolveMarks(doc, [active]);
          const activeMark: EditorFullState['activeMark'] = {
            id: active.id,
            kind: active.kind,
            by: active.by,
            at: active.at,
            quote: active.quote,
            range: active.range ?? null,
            resolvedRange: resolved?.resolvedRange ?? null,
            data: (active.data as Record<string, unknown> | undefined) ?? null,
          };

          if (active.kind === 'comment') {
            const commentData = active.data as CommentData | undefined;
            const threadId = commentData?.thread;
            if (threadId) {
              const thread = getThread(marks, threadId).map(entry => {
                const entryData = entry.data as CommentData | undefined;
                return {
                  id: entry.id,
                  by: entry.by,
                  at: entry.at,
                  text: entryData?.text,
                  resolved: entryData?.resolved,
                };
              });
              activeMark.thread = thread;
            }
          }

          result.activeMark = activeMark;
        }
      }
    });

    return result;
  }

  /**
   * Convert document offset to line and column
   */
  private offsetToLineCol(doc: import('@milkdown/kit/prose/model').Node, offset: number): { line: number; col: number } {
    let line = 0;
    let lastBlockStart = 0;

    doc.nodesBetween(0, Math.min(offset, doc.content.size), (node, pos) => {
      if (node.isBlock && pos < offset) {
        line++;
        lastBlockStart = pos + 1;
      }
      return true;
    });

    return {
      line: Math.max(0, line),
      col: offset - lastBlockStart,
    };
  }

  /**
   * Get the visible range of the document based on scroll position
   */
  private getVisibleRange(view: import('@milkdown/kit/prose/view').EditorView): EditorFullState['scroll'] {
    const editorRect = view.dom.getBoundingClientRect();
    const doc = view.state.doc;

    // Find first visible line
    let visibleFromLine = 0;
    let visibleToLine = 0;
    const visibleHeadings: string[] = [];

    let currentLine = 0;
    doc.descendants((node, pos) => {
      if (node.isBlock) {
        try {
          const coords = view.coordsAtPos(pos);
          if (coords) {
            // Check if this block is in the visible viewport
            if (coords.top >= editorRect.top && coords.top <= editorRect.bottom) {
              if (visibleFromLine === 0) {
                visibleFromLine = currentLine;
              }
              visibleToLine = currentLine;

              // Check if it's a heading
              if (node.type.name.startsWith('heading') || node.type.name === 'heading') {
                visibleHeadings.push(node.textContent);
              }
            }
          }
        } catch {
          // Ignore coordinate errors
        }
        currentLine++;
      }
      return true;
    });

    return {
      visibleFromLine,
      visibleToLine,
      visibleHeadings,
    };
  }

  /**
   * Extract document structure (headings and sections)
   */
  private extractStructure(doc: import('@milkdown/kit/prose/model').Node): EditorFullState['structure'] {
    const sections: EditorFullState['structure']['sections'] = [];
    let currentLine = 0;
    let totalWords = 0;

    doc.descendants((node, _pos) => {
      if (node.isBlock) {
        const text = node.textContent;
        const words = text.split(/\s+/).filter(w => w.length > 0).length;
        totalWords += words;

        // Check if heading
        if (node.type.name === 'heading') {
          const level = node.attrs.level || 1;
          sections.push({
            heading: text,
            level,
            line: currentLine,
            wordCount: words,
          });
        }
        currentLine++;
      }
      return true;
    });

    return { sections, totalWords };
  }

  // =====================
  // Editor Operations
  // =====================

  /**
   * Insert text at a specific offset position
   * @param offset - Position to insert at
   * @param text - Text to insert
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  insertAt(offset: number, text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[insertAt] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const docSizeBefore = view.state.doc.content.size;
      const clampedOffset = Math.max(0, Math.min(offset, docSizeBefore));

      // Parse the text as markdown and insert
      const newContent = parser(text);
      let tr = view.state.tr.insert(clampedOffset, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = docSizeAfter - docSizeBefore;

      // Create authored mark for the inserted content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from: clampedOffset, to: clampedOffset + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[insertAt] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[insertAt] Inserted text at offset:', clampedOffset, 'actualLength:', actualInsertedLength);
    });
  }

  /**
   * Insert text at the current cursor position
   * @param text - Text to insert
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  insertAtCursor(text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[insertAtCursor] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const { from } = view.state.selection;
      const docSizeBefore = view.state.doc.content.size;

      // Parse the text as markdown and insert
      const newContent = parser(text);
      let tr = view.state.tr.insert(from, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = docSizeAfter - docSizeBefore;

      // Create authored mark for the inserted content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from, to: from + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[insertAtCursor] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[insertAtCursor] Inserted text at cursor:', from, 'actualLength:', actualInsertedLength);
    });
  }

  /**
   * Replace the current selection with new text
   * @param text - Replacement text
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  replaceSelection(text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[replaceSelection] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const { from, to } = view.state.selection;
      const docSizeBefore = view.state.doc.content.size;
      const selectionLength = to - from;

      // Parse the text as markdown and replace
      const newContent = parser(text);
      let tr = view.state.tr.replaceWith(from, to, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      // Net change = newLength - selectionLength, so newLength = netChange + selectionLength
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = (docSizeAfter - docSizeBefore) + selectionLength;

      // Create authored mark for the replacement content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from, to: from + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[replaceSelection] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[replaceSelection] Replaced selection from', from, 'to', to, 'actualLength:', actualInsertedLength);
    });
  }

  /**
   * Replace text in a specific range
   * @param from - Start position
   * @param to - End position
   * @param text - Replacement text
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  replaceRange(from: number, to: number, text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[replaceRange] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const docSizeBefore = view.state.doc.content.size;
      const clampedFrom = Math.max(0, Math.min(from, docSizeBefore));
      const clampedTo = Math.max(0, Math.min(to, docSizeBefore));
      const rangeLength = clampedTo - clampedFrom;

      // Parse the text as markdown and replace
      const newContent = parser(text);
      let tr = view.state.tr.replaceWith(clampedFrom, clampedTo, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      // Net change = newLength - rangeLength, so newLength = netChange + rangeLength
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = (docSizeAfter - docSizeBefore) + rangeLength;

      // Create authored mark for the replacement content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from: clampedFrom, to: clampedFrom + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[replaceRange] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[replaceRange] Replaced range from', clampedFrom, 'to', clampedTo, 'actualLength:', actualInsertedLength);
    });
  }

  setHeatMapMode(mode: string): void {
    const validModes = ['hidden', 'subtle', 'background', 'full'] as const;
    if (!validModes.includes(mode as typeof validModes[number])) return;

    this.heatMapMode = mode as typeof validModes[number];

    if (this.editor) {
      this.editor.action((ctx) => {
        ctx.set(heatmapCtx.key, { mode: this.heatMapMode });

        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.setMeta('heatmapUpdate', true);
        view.dispatch(tr);
      });
    }
  }

  setTheme(theme: string): void {
    const themePicker = getThemePicker();
    if (themePicker) {
      themePicker.setTheme(theme as 'default' | 'whitey');
    }

    if (this.editor) {
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.setMeta('heatmapUpdate', true);
        view.dispatch(tr);
      });
    }

    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }

  setCurrentActor(actor: string): void {
    const normalized = setCurrentActorValue(actor);
    console.log('[setCurrentActor] Current actor set to', normalized);
  }

  scrollToLine(line: number): void {
    console.log('[scrollToLine] Called with line:', line);
    if (!this.editor) {
      console.log('[scrollToLine] No editor');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let currentLine = 0;
      let targetPos = 0;
      let found = false;

      // Find the position at the start of the target line
      view.state.doc.descendants((node, pos) => {
        if (node.isBlock) {
          if (currentLine === line) {
            targetPos = pos;
            found = true;
            return false; // Stop traversal
          }
          currentLine++;
        }
        return true;
      });

      console.log('[scrollToLine] Found:', found, 'targetPos:', targetPos, 'totalBlocks:', currentLine);

      if (!found) {
        console.log('[scrollToLine] Line not found');
        return;
      }

      // Get DOM element at position and scroll into view
      try {
        const domResult = view.domAtPos(targetPos);
        let el = domResult.node;

        // Find block element
        while (el && !(el instanceof HTMLElement && el.tagName.match(/^(P|H[1-6]|LI|PRE|BLOCKQUOTE)$/i))) {
          el = el.parentNode as Node;
        }

        if (el instanceof HTMLElement) {
          console.log('[scrollToLine] Scrolling to element:', el.tagName);
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (e) {
        console.error('[scrollToLine] Error:', e);
      }
    });
  }

  scrollToOffset(offset: number): void {
    console.log('[scrollToOffset] Called with offset:', offset);
    if (!this.editor) {
      console.log('[scrollToOffset] No editor');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Clamp offset to valid range
      const clampedOffset = Math.max(0, Math.min(offset, view.state.doc.content.size));

      try {
        const domResult = view.domAtPos(clampedOffset);
        let el = domResult.node;

        // Find block element
        while (el && !(el instanceof HTMLElement && el.tagName.match(/^(P|H[1-6]|LI|PRE|BLOCKQUOTE|DIV)$/i))) {
          el = el.parentNode as Node;
        }

        if (el instanceof HTMLElement) {
          console.log('[scrollToOffset] Scrolling to element:', el.tagName);
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (e) {
        console.error('[scrollToOffset] Error:', e);
      }
    });
  }

  navigateToAgent(sessionId: string): void {
    navigateToAgentInEditor(sessionId);
  }

  followAgent(sessionId: string): void {
    followAgentInEditor(sessionId);
  }

  unfollowAgent(showToast: boolean = false): void {
    unfollowAgentInEditor(showToast);
  }

  getFollowedAgent(): string | null {
    return getFollowedAgentInEditor();
  }

  isFollowingAgent(sessionId?: string): boolean {
    const followed = getFollowedAgentInEditor();
    if (!followed) return false;
    if (!sessionId) return true;
    return followed === sessionId;
  }

  // =====================
  // Agent Cursor Methods
  // =====================

  /**
   * Set the agent cursor to a specific position in the document.
   * The cursor is visible to the user and animates when it moves.
   */
  setAgentCursor(position: number, animateOrActor?: boolean | string, actor?: string): void {
    if (!this.editor) {
      console.warn('[setAgentCursor] Editor not initialized');
      return;
    }

    const resolvedActor = typeof animateOrActor === 'string' ? animateOrActor : actor;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      setAgentCursor(view, position, resolvedActor);
      console.log('[setAgentCursor] Set agent cursor to position:', position);
    });
  }

  /**
   * Set the agent selection range.
   * The selection is visible to the user as a highlighted region.
   */
  setAgentSelection(from: number, to: number, animateOrActor?: boolean | string, actor?: string): void {
    if (!this.editor) {
      console.warn('[setAgentSelection] Editor not initialized');
      return;
    }

    const resolvedActor = typeof animateOrActor === 'string' ? animateOrActor : actor;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      setAgentSelection(view, from, to, resolvedActor);
      console.log('[setAgentSelection] Set agent selection from', from, 'to', to);
    });
  }

  /**
   * Clear the agent cursor and selection.
   */
  clearAgentCursor(): void {
    if (!this.editor) {
      console.warn('[clearAgentCursor] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      clearAgentCursor(view);
      console.log('[clearAgentCursor] Cleared agent cursor');
    });
  }

  /**
   * Get the current agent cursor state.
   */
  getAgentCursorState(): { cursorPos: number | null; selectionFrom: number | null; selectionTo: number | null } | null {
    if (!this.editor) {
      console.warn('[getAgentCursorState] Editor not initialized');
      return null;
    }

    let result: { cursorPos: number | null; selectionFrom: number | null; selectionTo: number | null } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const state = getAgentCursorState(view);
      if (state) {
        result = {
          cursorPos: state.cursorPos,
          selectionFrom: state.selectionFrom,
          selectionTo: state.selectionTo,
        };
      }
    });

    return result;
  }

  // =====================
  // Batch Operations
  // =====================

  /**
   * Execute multiple operations atomically in a single transaction.
   *
   * Operations are executed sequentially and share context:
   * - 'select' stores a selection that subsequent operations can use
   * - 'goto' moves the agent cursor (visible to user)
   * - 'replace' uses the stored selection or resolves its own selector
   *
   * If any operation fails, the entire batch is rolled back.
   */
  executeBatch(operations: BatchOperation[]): BatchResult {
    if (!this.editor) {
      console.warn('[executeBatch] Editor not initialized');
      return { success: false, error: 'Editor not initialized', results: [] };
    }

    let result: BatchResult = { success: false, error: 'Unknown error', results: [] };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      result = executeBatchImpl(view, parser, operations);

      // Trigger heatmap refresh if document changed
      if (result.success) {
        const heatmapTr = view.state.tr.setMeta('heatmapUpdate', true);
        view.dispatch(heatmapTr);
      }
    });

    console.log('[executeBatch] Result:', result);
    return result;
  }

  // =====================
  // Suggestions (Track Changes)
  // =====================

  /**
   * Enable suggestion mode (track changes)
   */
  enableSuggestions(): void {
    if (!this.editor) {
      console.warn('[enableSuggestions] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enableSuggestions(view);
      console.log('[enableSuggestions] Suggestions enabled');
    });
  }

  /**
   * Disable suggestion mode
   */
  disableSuggestions(): void {
    if (!this.editor) {
      console.warn('[disableSuggestions] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      disableSuggestions(view);
      console.log('[disableSuggestions] Suggestions disabled');
    });
  }

  /**
   * Toggle suggestion mode
   */
  toggleSuggestions(): boolean {
    if (!this.editor) {
      console.warn('[toggleSuggestions] Editor not initialized');
      return false;
    }

    let enabled = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enabled = toggleSuggestions(view);
      console.log('[toggleSuggestions] Suggestions:', enabled ? 'enabled' : 'disabled');
    });
    return enabled;
  }

  /**
   * Check if suggestions are enabled
   */
  isSuggestionsEnabled(): boolean {
    if (!this.editor) return false;

    let enabled = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enabled = isSuggestionsEnabled(view.state);
    });
    return enabled;
  }

  /**
   * Get all pending suggestions
   */
  getSuggestions(): Mark[] {
    if (!this.editor) return [];

    let suggestions: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      suggestions = getPendingSuggestions(getMarks(view.state));
    });
    return suggestions;
  }

  /**
   * Accept a suggestion by ID
   */
  acceptSuggestion(id: string): boolean {
    return this.markAccept(String(id));
  }

  /**
   * Reject a suggestion by ID
   */
  rejectSuggestion(id: string): boolean {
    return this.markReject(String(id));
  }

  /**
   * Accept all pending suggestions
   */
  acceptAllSuggestions(): number {
    return this.markAcceptAll();
  }

  /**
   * Reject all pending suggestions
   */
  rejectAllSuggestions(): number {
    return this.markRejectAll();
  }

  /**
   * Open the inline comment composer for the current selection.
   */
  beginAddComment(by: string): boolean {
    if (!this.editor) {
      console.warn('[beginAddComment] Editor not initialized');
      return false;
    }

    let opened = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      openCommentComposer(view, range, normalizeActor(by));
      opened = true;
    });

    return opened;
  }

  // =====================
  // Unified Marks API (new system)
  // =====================

  /**
   * Get all marks in the document
   */
  getAllMarks(): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      marks = getMarks(view.state);
    });
    return marks;
  }

  /**
   * Debug helper: validate that stored mark ranges still match their quotes.
   */
  validateMarkAnchors(): {
    totalMarks: number;
    checkedMarks: number;
    mismatches: Array<{
      id: string;
      kind: string;
      by: string;
      range: MarkRange;
      quoteSnippet: string;
      actualSnippet: string;
    }>;
  } {
    if (!this.editor) {
      return { totalMarks: 0, checkedMarks: 0, mismatches: [] };
    }

    let result: {
      totalMarks: number;
      checkedMarks: number;
      mismatches: Array<{
        id: string;
        kind: string;
        by: string;
        range: MarkRange;
        quoteSnippet: string;
        actualSnippet: string;
      }>;
    } = { totalMarks: 0, checkedMarks: 0, mismatches: [] };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const marks = getMarks(view.state);
      const mismatches: Array<{
        id: string;
        kind: string;
        by: string;
        range: MarkRange;
        quoteSnippet: string;
        actualSnippet: string;
      }> = [];

      let checkedMarks = 0;
      for (const mark of marks) {
        if (!mark.range) continue;
        checkedMarks += 1;
        const actual = getTextForRange(view.state.doc, mark.range);
        const expectedNormalized = normalizeQuote(mark.quote ?? '');
        const actualNormalized = normalizeQuote(actual);
        if (expectedNormalized && actualNormalized !== expectedNormalized) {
          mismatches.push({
            id: mark.id,
            kind: mark.kind,
            by: mark.by,
            range: mark.range,
            quoteSnippet: expectedNormalized.slice(0, 120),
            actualSnippet: actualNormalized.slice(0, 120),
          });
        }
      }

      result = {
        totalMarks: marks.length,
        checkedMarks,
        mismatches,
      };
    });

    return result;
  }

  /**
   * Get marks filtered by kind
   */
  getMarksByKind(kind: MarkKind): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      marks = getMarksByKind(allMarks, kind);
    });
    return marks;
  }

  /**
   * Get pending suggestions (insert, delete, replace with status=pending)
   */
  getPendingMarkSuggestions(): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      marks = getPendingSuggestions(allMarks);
    });
    return marks;
  }

  /**
   * Get IDs of pending suggestions (for state snapshots)
   */
  getPendingMarkIds(): string[] {
    return this.getPendingMarkSuggestions().map(m => m.id);
  }

  /**
   * Get unresolved comments (marks-based)
   */
  getUnresolvedMarkComments(): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      marks = getUnresolvedMarkComments(allMarks);
    });
    return marks;
  }

  /**
   * Find a mark by ID
   */
  findMarkById(id: string): Mark | undefined {
    if (!this.editor) return undefined;

    let mark: Mark | undefined;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      mark = findMark(allMarks, id);
    });
    return mark;
  }

  /**
   * Get visual layout information for agent-native testing.
   * Returns pixel positions of marks, popovers, and detects overlaps.
   */
  getVisualLayout(): VisualLayoutInfo {
    const result: VisualLayoutInfo = {
      viewport: { width: 0, height: 0, scrollTop: 0, scrollLeft: 0 },
      marks: [],
      popovers: [],
      overlaps: [],
      gutterAlignments: []
    };

    if (!this.editor) return result;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const editorDom = view.dom;

      // Viewport info
      result.viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollTop: window.scrollY || document.documentElement.scrollTop,
        scrollLeft: window.scrollX || document.documentElement.scrollLeft
      };

      // Get all marks with their positions
      const allMarks = getMarks(view.state);

      for (const mark of allMarks) {
        const markInfo: VisualLayoutInfo['marks'][0] = {
          id: mark.id,
          kind: mark.kind,
          textBounds: null,
          gutterBounds: null
        };

        // Get text bounds from the mark's range
        if (mark.range && mark.range.from !== undefined && mark.range.to !== undefined) {
          try {
            const startCoords = view.coordsAtPos(mark.range.from);
            const endCoords = view.coordsAtPos(mark.range.to);
            if (startCoords && endCoords) {
              markInfo.textBounds = {
                top: Math.min(startCoords.top, endCoords.top),
                left: startCoords.left,
                width: Math.abs(endCoords.right - startCoords.left),
                height: Math.abs(endCoords.bottom - startCoords.top)
              };
            }
          } catch {
            // Position may be invalid
          }
        }

        // Find gutter element for this mark
        const gutterEl = document.querySelector(`[data-mark-id="${mark.id}"]`);
        if (gutterEl) {
          const rect = gutterEl.getBoundingClientRect();
          markInfo.gutterBounds = {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          };
        }

        result.marks.push(markInfo);

        // Check gutter alignment
        if (markInfo.textBounds && markInfo.gutterBounds) {
          const textMidY = markInfo.textBounds.top + markInfo.textBounds.height / 2;
          const gutterMidY = markInfo.gutterBounds.top + markInfo.gutterBounds.height / 2;
          const delta = Math.abs(textMidY - gutterMidY);
          result.gutterAlignments.push({
            markId: mark.id,
            textMidY,
            gutterMidY,
            delta,
            aligned: delta < 20 // Within 20px is considered aligned
          });
        }
      }

      // Find popovers
      const popovers = document.querySelectorAll('[data-popover-mark-id]');
      popovers.forEach((popover) => {
        const markId = popover.getAttribute('data-popover-mark-id');
        if (markId) {
          const rect = popover.getBoundingClientRect();
          result.popovers.push({
            markId,
            bounds: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height
            }
          });
        }
      });

      // Also check for any visible popovers by class
      const visiblePopovers = document.querySelectorAll('.mark-popover, .suggestion-popover, .comment-popover');
      visiblePopovers.forEach((popover) => {
        const markId = popover.getAttribute('data-mark-id') || popover.getAttribute('data-popover-mark-id');
        // Only add if not already added
        if (markId && !result.popovers.find(p => p.markId === markId)) {
          const rect = popover.getBoundingClientRect();
          result.popovers.push({
            markId,
            bounds: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height
            }
          });
        }
      });

      // Detect overlaps between popovers and other elements
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');

      for (const popover of result.popovers) {
        // Check overlap with headings
        headings.forEach((heading) => {
          const rect = heading.getBoundingClientRect();
          const overlap = this.calculateOverlap(popover.bounds, {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          });
          if (overlap > 0) {
            result.overlaps.push({
              element1: { type: 'popover', id: popover.markId },
              element2: { type: 'heading' },
              overlapArea: overlap
            });
          }
        });

        // Check overlap with other popovers
        for (const other of result.popovers) {
          if (other.markId !== popover.markId) {
            const overlap = this.calculateOverlap(popover.bounds, other.bounds);
            if (overlap > 0) {
              // Avoid duplicate entries
              const exists = result.overlaps.find(o =>
                (o.element1.id === popover.markId && o.element2.id === other.markId) ||
                (o.element1.id === other.markId && o.element2.id === popover.markId)
              );
              if (!exists) {
                result.overlaps.push({
                  element1: { type: 'popover', id: popover.markId },
                  element2: { type: 'popover', id: other.markId },
                  overlapArea: overlap
                });
              }
            }
          }
        }
      }
    });

    return result;
  }

  /**
   * Calculate overlap area between two rectangles
   */
  private calculateOverlap(
    r1: { top: number; left: number; width: number; height: number },
    r2: { top: number; left: number; width: number; height: number }
  ): number {
    const xOverlap = Math.max(0, Math.min(r1.left + r1.width, r2.left + r2.width) - Math.max(r1.left, r2.left));
    const yOverlap = Math.max(0, Math.min(r1.top + r1.height, r2.top + r2.height) - Math.max(r1.top, r2.top));
    return xOverlap * yOverlap;
  }

  private getSelectionRangeOrBlock(view: EditorView): MarkRange | null {
    let { from, to } = view.state.selection;
    const doc = view.state.doc;

    if (from === to) {
      const $pos = doc.resolve(from);
      from = $pos.start($pos.depth);
      to = $pos.end($pos.depth);
    }

    if (from >= to) return null;
    return { from, to };
  }

  private filterMatchesByScope(
    view: EditorView,
    matches: Array<{ from: number; to: number; match: string }>,
    scope?: FindOptions['scope']
  ): Array<{ from: number; to: number; match: string }> {
    if (!scope || scope === 'all') return matches;

    if (scope === 'selection') {
      const { from, to } = view.state.selection;
      if (from === to) return [];
      return matches.filter(match => match.from >= from && match.to <= to);
    }

    if (scope === 'visible') {
      const visible = this.getVisibleRange(view);
      return matches.filter(match => {
        const { line } = this.offsetToLineCol(view.state.doc, match.from);
        return line >= visible.visibleFromLine && line <= visible.visibleToLine;
      });
    }

    return matches;
  }

  private quoteForRange(view: EditorView, range: MarkRange): string {
    return view.state.doc.textBetween(range.from, range.to, '\n', '\n');
  }

  /**
   * Mark content as approved
   */
  markApprove(quote: string, by: string): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      mark = approve(view, quote, by);
      if (mark) {
        console.log('[markApprove] Created approval:', mark.id);
      } else {
        console.log('[markApprove] Removed approval for selection');
      }
    });
    return mark;
  }

  /**
   * Mark content as approved using a selector.
   */
  markApproveSelector(selector: CommentSelector, by: string): Mark | null {
    if (!this.editor) {
      console.warn('[markApproveSelector] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = resolveSelectorRange(view.state.doc, selector);
      if (!range) {
        throw new Error('Selector did not resolve');
      }
      const quote = this.quoteForRange(view, range);
      mark = approve(view, quote, by, range);
      if (mark) {
        console.log('[markApproveSelector] Created approval:', mark.id);
      } else {
        console.log('[markApproveSelector] Removed approval for selection');
      }
    });
    return mark;
  }

  /**
   * Mark current selection (or block) as approved
   */
  markApproveSelection(by: string): Mark | null {
    if (!this.editor) {
      console.warn('[markApproveSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      const quote = this.quoteForRange(view, range);
      mark = approve(view, quote, by, range);
      if (mark) {
        console.log('[markApproveSelection] Created approval:', mark.id);
      } else {
        console.log('[markApproveSelection] Removed approval for selection');
      }
    });
    return mark;
  }

  /**
   * Remove an approval mark
   */
  markUnapprove(quote: string, by: string): boolean {
    if (!this.editor) {
      console.warn('[markUnapprove] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      success = unapprove(view, quote, by);
      console.log('[markUnapprove] Removed approval:', success);
    });
    return success;
  }

  /**
   * Flag content for attention
   */
  markFlag(quote: string, by: string, note?: string): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      mark = flag(view, quote, by, note);
      if (mark) {
        console.log('[markFlag] Created flag:', mark.id);
      } else {
        console.log('[markFlag] Removed flag for selection');
      }
    });
    return mark;
  }

  /**
   * Flag content using a selector.
   */
  markFlagSelector(selector: CommentSelector, by: string, note?: string): Mark | null {
    if (!this.editor) {
      console.warn('[markFlagSelector] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = resolveSelectorRange(view.state.doc, selector);
      if (!range) {
        throw new Error('Selector did not resolve');
      }
      const quote = this.quoteForRange(view, range);
      mark = flag(view, quote, by, note, range);
      if (mark) {
        console.log('[markFlagSelector] Created flag:', mark.id);
      } else {
        console.log('[markFlagSelector] Removed flag for selection');
      }
    });
    return mark;
  }

  /**
   * Flag current selection (or block) for attention
   */
  markFlagSelection(by: string, note?: string): Mark | null {
    if (!this.editor) {
      console.warn('[markFlagSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      const quote = this.quoteForRange(view, range);
      mark = flag(view, quote, by, note, range);
      if (mark) {
        console.log('[markFlagSelection] Created flag:', mark.id);
      } else {
        console.log('[markFlagSelection] Removed flag for selection');
      }
    });
    return mark;
  }

  /**
   * Remove a flag mark
   */
  markUnflag(quote: string, by: string): boolean {
    if (!this.editor) {
      console.warn('[markUnflag] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      success = unflag(view, quote, by);
      console.log('[markUnflag] Removed flag:', success);
    });
    return success;
  }

  /**
   * Add a comment mark
   */
  markComment(quote: string, by: string, text: string, meta?: OrchestratedMarkMeta): Mark {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const matches = findMatchesInDoc(view.state.doc, quote, {
        regex: false,
        caseSensitive: true,
        maxMatches: 1,
        normalizeWhitespace: true,
      });
      const range = matches[0] ? { from: matches[0].from, to: matches[0].to } : undefined;
      mark = markComment(view, quote, by, text, range, meta);
      console.log('[markComment] Created comment:', mark.id);
      captureEvent('mark_created', { mark_kind: 'comment', source: 'quote' });
    });
    return mark!;
  }

  /**
   * Add a comment mark on the current selection (or block).
   */
  markCommentSelection(by: string, text: string): Mark | null {
    if (!this.editor) {
      console.warn('[markCommentSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      const quote = this.quoteForRange(view, range);
      mark = markComment(view, quote, by, text, range);
      console.log('[markCommentSelection] Created comment:', mark.id);
      captureEvent('mark_created', { mark_kind: 'comment', source: 'selection' });
    });
    return mark;
  }

  /**
   * Add a comment mark using a selector (range/quote/pattern/anchor).
   */
  markCommentSelector(selector: CommentSelector, by: string, text: string, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      console.warn('[markCommentSelector] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = resolveSelectorRange(view.state.doc, selector);
      const quoteSource = selector.quote || (range ? view.state.doc.textBetween(range.from, range.to, '\n', '\n') : '');
      const quote = normalizeQuote(quoteSource);
      if (!quote && !range) return;
      mark = markComment(view, quote, by, text, range ?? undefined, meta);
      console.log('[markCommentSelector] Created comment:', mark.id);
      captureEvent('mark_created', { mark_kind: 'comment', source: 'selector' });
    });
    return mark;
  }

  /**
   * Reply to a comment
   */
  markReply(markId: string, by: string, text: string): Mark | null {
    if (!this.editor) {
      console.warn('[markReply] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      mark = markReply(view, markId, by, text);
      if (mark) {
        console.log('[markReply] Created reply:', mark.id);
      }
    });
    return mark;
  }

  /**
   * Resolve a comment thread
   */
  markResolve(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markResolve] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (this.isShareMode) this.suppressMarksSync = true;
      try {
        success = markResolve(view, markId);
      } finally {
        if (this.isShareMode) this.suppressMarksSync = false;
      }
      console.log('[markResolve] Resolved:', success);
      if (success) {
        if (this.isShareMode) {
          const actor = getCurrentActor();
          const metadata = getMarkMetadataWithQuotes(view.state);
          this.lastReceivedServerMarks = { ...metadata };
          this.initialMarksSynced = true;

          void shareClient.resolveComment(markId, actor).then((result) => {
            if (!result || 'error' in result || result.success !== true) return;
            const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
              ? result.marks as Record<string, StoredMark>
              : null;
            if (!serverMarks) return;
            this.lastReceivedServerMarks = mergePendingServerMarks(this.lastReceivedServerMarks, serverMarks);
            this.initialMarksSynced = true;
            if (this.editor) {
              this.editor.action((innerCtx) => {
                const innerView = innerCtx.get(editorViewCtx);
                const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);
                setMarkMetadata(innerView, mergedMetadata);
              });
            }
          }).catch((error) => {
            console.error('[markResolve] Failed to resolve comment via share mutation:', error);
          });
        }
        captureEvent('mark_resolved', { mark_kind: 'comment' });
      }
    });
    return success;
  }

  /**
   * Unresolve a comment thread
   */
  markUnresolve(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markUnresolve] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (this.isShareMode) this.suppressMarksSync = true;
      try {
        success = markUnresolve(view, markId);
      } finally {
        if (this.isShareMode) this.suppressMarksSync = false;
      }
      console.log('[markUnresolve] Unresolved:', success);
      if (success && this.isShareMode) {
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;

        const actor = getCurrentActor();
        void shareClient.unresolveComment(markId, actor).then((result) => {
          if (!result || 'error' in result || result.success !== true) return;
          const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
            ? result.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.lastReceivedServerMarks = mergePendingServerMarks(this.lastReceivedServerMarks, serverMarks);
          this.initialMarksSynced = true;
          if (this.editor) {
            this.editor.action((innerCtx) => {
              const innerView = innerCtx.get(editorViewCtx);
              const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);
              setMarkMetadata(innerView, mergedMetadata);
            });
          }
        }).catch((error) => {
          console.error('[markUnresolve] Failed to unresolve comment via share mutation:', error);
        });
      }
    });
    return success;
  }

  /**
   * Delete a comment thread by mark ID
   */
  markDeleteThread(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markDeleteThread] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      success = deleteMark(view, markId);
    });
    return success;
  }

  /**
   * Suggest an insertion
   * Returns null if the quote cannot be found in the document
   */
  markSuggestInsert(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Validate quote exists in document
      if (!range) {
        const resolved = resolveQuoteRange(view.state.doc, quote);
        if (!resolved) {
          console.warn('[markSuggestInsert] Quote not found in document:', quote);
          return;
        }
      }

      mark = suggestInsert(view, quote, by, content, range, meta);
      if (mark) {
        console.log('[markSuggestInsert] Created suggestion:', mark.id);
        captureEvent('mark_created', { mark_kind: 'insert' });
      } else {
        console.warn('[markSuggestInsert] Suggestion was rejected by safety checks.');
      }
    });
    return mark;
  }

  /**
   * Suggest a deletion
   * Returns null if the quote cannot be found in the document
   */
  markSuggestDelete(quote: string, by: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Validate quote exists in document
      if (!range) {
        const resolved = resolveQuoteRange(view.state.doc, quote);
        if (!resolved) {
          console.warn('[markSuggestDelete] Quote not found in document:', quote);
          return;
        }
      }

      mark = suggestDelete(view, quote, by, range, meta);
      if (mark) {
        console.log('[markSuggestDelete] Created suggestion:', mark.id);
        captureEvent('mark_created', { mark_kind: 'delete' });
      } else {
        console.warn('[markSuggestDelete] Suggestion was rejected by safety checks.');
      }
    });
    return mark;
  }

  /**
   * Suggest a replacement
   * Returns null if the quote cannot be found in the document
   */
  markSuggestReplace(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);

      // Validate quote exists in document
      if (!range) {
        const resolved = resolveQuoteRange(view.state.doc, quote);
        if (!resolved) {
          console.warn('[markSuggestReplace] Quote not found in document:', quote);
          return;
        }
      }

      mark = suggestReplace(view, quote, by, content, range, meta, parser);
      if (mark) {
        console.log('[markSuggestReplace] Created suggestion:', mark.id);
        captureEvent('mark_created', { mark_kind: 'replace' });
      } else {
        console.warn('[markSuggestReplace] Suggestion was rejected by safety checks.');
      }
    });
    return mark;
  }

  /**
   * Find and suggest replacements across the document.
   */
  markSuggestEdit(
    find: string,
    replace: string,
    by: string,
    options?: FindOptions
  ): { success: boolean; count: number; marks?: Mark[]; error?: string } {
    if (!this.editor) {
      return { success: false, count: 0, error: 'Editor not initialized' };
    }

    let result: { success: boolean; count: number; marks?: Mark[]; error?: string } = {
      success: false,
      count: 0,
    };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const scope = options?.scope ?? 'all';
      if (scope === 'selection' && view.state.selection.from === view.state.selection.to) {
        result = { success: false, count: 0, error: 'No selection' };
        return;
      }

      const matches = findMatchesInDoc(view.state.doc, find, options);
      const scopedMatches = this.filterMatchesByScope(view, matches, scope);
      if (scopedMatches.length === 0) {
        result = { success: false, count: 0, error: 'No matches' };
        return;
      }

      const marks: Mark[] = [];
      for (const match of scopedMatches) {
        const mark = suggestReplace(
          view,
          match.match,
          by,
          replace,
          { from: match.from, to: match.to },
          undefined,
          parser
        );
        if (mark) {
          marks.push(mark);
        } else {
          console.warn('[markSuggestEdit] Skipped unsafe replacement for match:', match.match);
        }
      }

      if (marks.length === 0) {
        result = { success: false, count: 0, error: 'No safe matches' };
        return;
      }

      captureEvent('mark_created', {
        mark_kind: 'replace',
        source: 'bulk_edit',
        count: marks.length,
      });
      result = { success: true, count: marks.length, marks };
    });

    return result;
  }

  /**
   * Rewrite the document: diff new content against current, create suggestions for each change.
   * Returns the list of created marks.
   */
  rewriteDocument(
    newContent: string,
    by: string,
    options?: { allowShareContentMutation?: boolean }
  ): {
    success: boolean;
    marks: Mark[];
    mode?: 'highlights' | 'refresh';
    stats?: ChangeStats;
    attemptedChanges?: number;
    createdSuggestions?: number;
    error?: string;
    reason?: string;
  } {
    if (!this.editor) {
      return { success: false, marks: [], error: 'Editor not initialized' };
    }

    const allowShareContentMutation = Boolean(options?.allowShareContentMutation);
    const rewriteMeta = allowShareContentMutation
      ? ({ allowShareContentMutation: true } as OrchestratedMarkMeta)
      : undefined;

    let result: {
      success: boolean;
      marks: Mark[];
      mode?: 'highlights' | 'refresh';
      stats?: ChangeStats;
      attemptedChanges?: number;
      createdSuggestions?: number;
      error?: string;
      reason?: string;
    } = {
      success: false,
      marks: [],
    };
    let deferredRefresh: { content: string; stats: ChangeStats; reason: string } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const { content: provenanceStripped } = extractEmbeddedProvenance(newContent);
      const { content: canonicalizedContent } = extractMarks(provenanceStripped);
      const incomingMarkdownForCompare = normalizeMarkdownForComparison(stripProofSpanTags(canonicalizedContent));

      // Get plain text content with block boundaries preserved (same as getFullState)
      const doc = view.state.doc;
      const oldContent = doc.textBetween(0, doc.content.size, '\n', '\n');
      const currentStructure = structureSignature(doc);
      let currentMarkdownForCompare: string | null = null;
      try {
        const serializer = ctx.get(serializerCtx);
        const serialized = serializer(doc);
        if (serialized) {
          currentMarkdownForCompare = normalizeMarkdownForComparison(stripProofSpanTags(serialized));
        }
      } catch (error) {
        console.warn('[rewriteDocument] Failed to serialize current markdown for comparison:', error);
      }

      if (!oldContent) {
        result = { success: false, marks: [], error: 'Empty document' };
        return;
      }

      // Build text index for mapping character offsets to ProseMirror positions
      const textIndex = buildTextIndex(doc);
      if (!textIndex) {
        result = { success: false, marks: [], error: 'Failed to build text index' };
        return;
      }

      // Normalize incoming markdown to the same textBetween representation.
      let newText = canonicalizedContent;
      let incomingStructure: string | null = null;
      try {
        const newDoc = parser(canonicalizedContent);
        if (newDoc) {
          newText = newDoc.textBetween(0, newDoc.content.size, '\n', '\n');
          incomingStructure = structureSignature(newDoc);
        }
      } catch (parseErr) {
        console.warn('[rewriteDocument] Parser failed, using raw content:', parseErr);
      }

      // Line-based diff on plain text
      const oldLines = oldContent.split('\n');
      const newLines = newText.split('\n');
      const changes = computeLineDiff(oldLines, newLines);

      if (changes.length === 0) {
        const markdownStructureChanged = currentMarkdownForCompare !== null
          && incomingMarkdownForCompare !== currentMarkdownForCompare;
        const parsedStructureChanged = incomingStructure !== null
          && incomingStructure !== currentStructure;
        if (markdownStructureChanged || parsedStructureChanged) {
          deferredRefresh = {
            content: canonicalizedContent,
            stats: computeChangeStats(changes, oldLines, newLines),
            reason: 'structural_markdown_change',
          };
          result = {
            success: true,
            mode: 'refresh',
            marks: [],
            attemptedChanges: 0,
            createdSuggestions: 0,
            reason: deferredRefresh.reason,
          };
          return;
        }

        result = {
          success: true,
          mode: 'highlights',
          marks: [],
          attemptedChanges: 0,
          createdSuggestions: 0,
        };
        return;
      }

      const stats = computeChangeStats(changes, oldLines, newLines);
      let mode = classifyRewriteMode(stats);

      // Dry-run validation before any mark creation.
      if (mode === 'highlights') {
        const validation = validateDiffPositions(textIndex, changes, oldLines);
        if (!validation.valid) {
          mode = 'refresh';
          deferredRefresh = {
            content: canonicalizedContent,
            stats,
            reason: `position_validation_failed:${validation.failedCount}`,
          };
          result = {
            success: true,
            mode,
            marks: [],
            stats,
            attemptedChanges: changes.length,
            createdSuggestions: 0,
            reason: deferredRefresh.reason,
          };
          return;
        }
      }

      if (mode === 'refresh') {
        deferredRefresh = {
          content: canonicalizedContent,
          stats,
          reason: 'rewrite_mode_refresh',
        };
        result = {
          success: true,
          mode,
          marks: [],
          stats,
          attemptedChanges: changes.length,
          createdSuggestions: 0,
          reason: deferredRefresh.reason,
        };
        return;
      }

      // Apply changes as suggestions (reverse order so positions don't shift)
      // Use explicit ProseMirror ranges (via textIndex) instead of quote-based
      // text search so that structural changes (headings, paragraph breaks)
      // land on proper block boundaries.
      const marks: Mark[] = [];
      for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        let mark: Mark | null = null;

        try {
          if (change.type === 'replace' || change.type === 'delete') {
            const offsets = linesToCharOffsets(oldLines, change.oldLineStart!, change.oldLineEnd!);
            const range = mapTextOffsetsToRange(textIndex, offsets.from, offsets.to);
            if (!range) continue;

            const quote = oldContent.slice(offsets.from, offsets.to);

            if (change.type === 'replace') {
              mark = suggestReplace(view, quote, by, change.newText!, range, undefined, parser);
            } else {
              mark = suggestDelete(view, quote, by, range);
            }
          } else if (change.type === 'insert') {
            if (change.oldLineStart !== undefined && change.oldLineStart > 0) {
              // Anchor after the preceding line
              let anchorIdx = change.oldLineStart - 1;
              let anchorOffsets = linesToCharOffsets(oldLines, anchorIdx, anchorIdx + 1);
              let anchorRange = mapTextOffsetsToRange(textIndex, anchorOffsets.from, anchorOffsets.to);

              // If anchor line is empty (from==to), walk backward to find a non-empty line
              if (!anchorRange) {
                let found = false;
                for (let k = anchorIdx - 1; k >= 0; k--) {
                  const fallbackOffsets = linesToCharOffsets(oldLines, k, k + 1);
                  const fallbackRange = mapTextOffsetsToRange(textIndex, fallbackOffsets.from, fallbackOffsets.to);
                  if (fallbackRange) {
                    anchorIdx = k;
                    anchorOffsets = fallbackOffsets;
                    anchorRange = fallbackRange;
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 }, rewriteMeta);
                }
              }

              if (!mark && anchorRange) {
                const anchorQuote = oldContent.slice(anchorOffsets.from, anchorOffsets.to);
                mark = suggestInsert(view, anchorQuote, by, '\n' + change.newText!, anchorRange, rewriteMeta);
              }
            } else {
              // Insert at document start
              mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 }, rewriteMeta);
            }
          }
        } catch (e) {
          console.warn('[rewriteDocument] Failed to create suggestion for change:', change.type, e);
        }

        if (mark) {
          marks.push(mark);
        }
      }

      // Guard against partial application for large rewrites.
      const attemptedChanges = changes.length;
      const createdSuggestions = marks.length;
      const coverageRatio = attemptedChanges > 0 ? (createdSuggestions / attemptedChanges) : 1;
      const lowCoverage = attemptedChanges >= 6 && coverageRatio < 0.7;

      if (lowCoverage) {
        const reason = `low_coverage:${createdSuggestions}/${attemptedChanges}`;
        console.warn('[rewriteDocument] Escalating to refresh due to low suggestion coverage:', {
          attemptedChanges,
          createdSuggestions,
          coverageRatio,
        });
        deferredRefresh = {
          content: canonicalizedContent,
          stats,
          reason,
        };
        result = {
          success: true,
          mode: 'refresh',
          marks: [],
          stats,
          attemptedChanges,
          createdSuggestions,
          reason,
        };
        return;
      }

      result = {
        success: true,
        mode: 'highlights',
        marks,
        stats,
        attemptedChanges,
        createdSuggestions,
      };
    });

    if (deferredRefresh) {
      this.loadDocument(deferredRefresh.content, { allowShareContentMutation });
      this.markAllAsAuthored(by);
      // Refresh-mode rewrites bypass listener-based sync; emit a snapshot explicitly
      // so native state/share sync receive the new content.
      this.emitDocumentSnapshotNow();
    }

    return result;
  }

  /**
   * Handle an external file change detected by the file watcher.
   * Canonicalizes disk content, diffs against editor state, and either
   * applies highlights (scattered edits) or refreshes (full rewrite).
   * Applies an external file change from a non-web editor integration.
   */
  handleExternalChange(diskContent: string, providedBy?: string | null): void {
    if (!this.editor) {
      console.error('[handleExternalChange] Editor not initialized');
      return;
    }

    // 1. Canonicalize disk content (strip provenance spans and marks metadata)
    const { content: provenanceStripped } = extractEmbeddedProvenance(diskContent);
    const { content: canonicalized } = extractMarks(provenanceStripped);

    // Use provided by (from provenance queue), fall back to regex scan, then generic
    let by: string;
    if (providedBy) {
      by = providedBy;
    } else {
      const agentMatch = diskContent.match(/data-by="ai:([^"]+)"/);
      by = agentMatch ? `ai:${agentMatch[1]}` : 'ai:external-agent';
    }

    // When providedBy is set, the change came from the provenance queue
    // (known agent edit) — skip the toast since presence + highlights are enough.
    const isProvenanceTracked = !!providedBy;
    this.applyExternalHighlights(canonicalized, by, isProvenanceTracked);
  }

  /**
   * Mark the entire document as authored by the given agent.
   * Used for offline provenance: Write entries (kind: "full").
   */
  markAllAsAuthored(by: string): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const authoredMarkType = view.state.schema.marks.proofAuthored;
      if (!authoredMarkType) return;
      const tr = view.state.tr.addMark(
        0, view.state.doc.content.size,
        authoredMarkType.create({ by })
      );
      view.dispatch(tr);
    });
  }

  /**
   * Mark specific line ranges as authored by the given agent.
   * Used for offline provenance: Edit entries (kind: "partial") with hash-verified hunks.
   */
  markHunksAsAuthored(by: string, hunks: Array<{start_line: number, end_line: number, lines: string[]}>): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const authoredMarkType = view.state.schema.marks.proofAuthored;
      if (!authoredMarkType) return;

      // Build line-number → ProseMirror position index
      const doc = view.state.doc;
      const linePositions: Array<{from: number, to: number}> = [];
      doc.descendants((node, pos) => {
        if (node.isBlock && node.isTextblock) {
          linePositions.push({ from: pos, to: pos + node.nodeSize });
        }
      });

      let tr = view.state.tr;
      for (const hunk of hunks) {
        const startIdx = hunk.start_line - 1;
        const endIdx = hunk.end_line - 1;
        if (startIdx < 0 || endIdx >= linePositions.length) continue;

        const from = linePositions[startIdx].from;
        const to = linePositions[endIdx].to;
        tr = tr.addMark(from, to, authoredMarkType.create({ by }));
      }

      if (tr.docChanged) {
        view.dispatch(tr);
      }
    });
  }

  /**
   * Try to apply external changes as individual suggestion marks (highlights mode).
   * Falls back to refresh mode if changes are too extensive or positions fail validation.
   *
   * Lock lifecycle: this method locks the editor and is responsible for unlocking.
   * In highlights mode, unlock happens synchronously before return.
   * In refresh mode, unlock is deferred to applyRefresh's animation completion.
   *
   * Lock lifecycle ends within each path after work completes.
   */
  private applyExternalHighlights(
    canonicalizedContent: string,
    by: string,
    skipToast: boolean = false
  ): void {
    if (!this.editor) {
      return;
    }

    this.reviewLock('Applying external changes...');

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);

      // 1. Snapshot current doc
      const doc = view.state.doc;
      const oldText = doc.textBetween(0, doc.content.size, '\n', '\n');
      const textIndex = buildTextIndex(doc);

      if (!textIndex) {
        console.warn('[applyExternalHighlights] buildTextIndex failed, falling back to refresh');
        // applyRefresh owns lock from here and sends its own callback
        this.applyRefresh(canonicalizedContent, by);
        return;
      }

      // 2. Normalize disk content to match doc.textBetween() format.
      // Markdown uses \n\n between paragraphs, but textBetween uses single \n
      // between block nodes. Parse through ProseMirror to get the same representation.
      let newText = canonicalizedContent;
      try {
        const newDoc = parser(canonicalizedContent);
        if (newDoc) {
          newText = newDoc.textBetween(0, newDoc.content.size, '\n', '\n');
        }
      } catch (parseErr) {
        console.warn('[applyExternalHighlights] Parser failed, using raw content:', parseErr);
      }

      // 3. Diff
      const oldLines = oldText.split('\n');
      const newLines = newText.split('\n');
      const changes = computeLineDiff(oldLines, newLines);

      if (changes.length === 0) {
        this.reviewUnlock();
        return;
      }

      // 4. Classify mode
      const stats = computeChangeStats(changes, oldLines, newLines);
      let mode = classifyChangeMode(stats);

      // 5. Dry-run validation (only for highlights mode)
      if (mode === 'highlights') {
        const validation = validateDiffPositions(textIndex, changes, oldLines);
        if (!validation.valid) {
          console.warn(`[applyExternalHighlights] ${validation.failedCount} positions failed validation, escalating to refresh`);
          mode = 'refresh';
        }
      }

      if (mode === 'refresh') {
        // applyRefresh owns lock from here and sends its own callback
        this.applyRefresh(canonicalizedContent, by, stats);
        return;
      }

      // 6. Apply suggestions in reverse order (positions don't shift)
      const marks: Mark[] = [];
      for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        let mark: Mark | null = null;

        try {
          if (change.type === 'replace' || change.type === 'delete') {
            const offsets = linesToCharOffsets(oldLines, change.oldLineStart!, change.oldLineEnd!);
            const range = mapTextOffsetsToRange(textIndex, offsets.from, offsets.to);
            if (!range) continue;

            // Use actual text at the range as quote (cross-check in resolveRangeWithValidation)
            const quote = oldText.slice(offsets.from, offsets.to);

            if (change.type === 'replace') {
              mark = suggestReplace(view, quote, by, change.newText!, range, undefined, parser);
            } else {
              mark = suggestDelete(view, quote, by, range);
            }
          } else if (change.type === 'insert') {
            if (change.oldLineStart !== undefined && change.oldLineStart > 0) {
              // Anchor after the preceding line
              let anchorIdx = change.oldLineStart - 1;
              let anchorOffsets = linesToCharOffsets(oldLines, anchorIdx, anchorIdx + 1);
              let anchorRange = mapTextOffsetsToRange(textIndex, anchorOffsets.from, anchorOffsets.to);

              // If anchor line is empty (from==to), walk backward to find a non-empty line
              if (!anchorRange) {
                let found = false;
                for (let k = anchorIdx - 1; k >= 0; k--) {
                  const fallbackOffsets = linesToCharOffsets(oldLines, k, k + 1);
                  const fallbackRange = mapTextOffsetsToRange(textIndex, fallbackOffsets.from, fallbackOffsets.to);
                  if (fallbackRange) {
                    anchorIdx = k;
                    anchorOffsets = fallbackOffsets;
                    anchorRange = fallbackRange;
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  // No non-empty line before this — insert at document start
                  mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 });
                }
              }

              if (!mark && anchorRange) {
                const anchorQuote = oldText.slice(anchorOffsets.from, anchorOffsets.to);
                mark = suggestInsert(view, anchorQuote, by, '\n' + change.newText!, anchorRange);
              }
            } else {
              // Insert at document start
              mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 });
            }
          }
        } catch (e) {
          console.warn('[applyExternalHighlights] Failed to create suggestion:', change.type, e);
        }

        if (mark) marks.push(mark);
      }

      // 7. Show toast notification (skip for provenance-tracked changes —
      //    presence indicator + green highlights + sidebar count are enough)
      if (!skipToast) {
        this.showExternalChangeToast(by, marks.length);
      }

      // 8. Force glow decoration rebuild after glow expires
      setTimeout(() => {
        if (this.editor) {
          this.editor.action((ctx) => {
            const v = ctx.get(editorViewCtx);
            v.dispatch(v.state.tr);
          });
        }
      }, 2100);

      // 9. Unlock after highlights are applied.
      this.reviewUnlock();
    });
  }

  /**
   * Apply a full refresh: load new content with fade animation and provenance carry-forward.
   *
   * This method takes ownership of the review lock (caller must have locked).
   * Unlock happens after the async animation completes (~500ms).
   */
  private applyRefresh(
    canonicalizedContent: string,
    by: string,
    stats?: ChangeStats
  ): void {
    if (!this.isReviewLocked()) this.reviewLock('Refreshing document...');

    // 1. Snapshot provenance before reload
    let provenanceSnapshot: Array<{ text: string; by: string }> = [];
    if (this.editor) {
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        provenanceSnapshot = this.snapshotProvenance(view);
      });
    }

    // 2. Store content for revert
    this.preRefreshRevertContent = this.lastMarkdown;
    this.preRefreshRevertTimestamp = Date.now();

    // 3. Fade out animation
    this.triggerRefreshFadeOut();

    // 4. After fade out, load new content
    setTimeout(() => {
      this.loadDocument(canonicalizedContent);

      // 5. Re-apply provenance to unchanged ranges
      if (this.editor && provenanceSnapshot.length > 0) {
        this.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          this.restoreProvenance(view, provenanceSnapshot, by);
        });
      }

      // 6. Fade in animation
      this.triggerRefreshFadeIn();

      // 7. Unlock after fade and show the banner
      setTimeout(() => {
        this.reviewUnlock();
        this.showRefreshBanner(by, stats);
      }, 300);
    }, 200);
  }

  /**
   * Snapshot proofAuthored marks before loadDocument destroys them.
   */
  private snapshotProvenance(view: EditorView): Array<{ text: string; by: string }> {
    const snapshot: Array<{ text: string; by: string }> = [];
    const doc = view.state.doc;
    doc.descendants((node, _pos) => {
      if (!node.isText) return;
      const authoredMark = node.marks.find(m => m.type.name === 'proofAuthored');
      if (authoredMark) {
        snapshot.push({
          text: node.text || '',
          by: authoredMark.attrs.by || 'human',
        });
      }
    });
    return snapshot;
  }

  /**
   * Restore provenance marks to unchanged text ranges after loadDocument.
   * New/changed text is attributed to the external agent.
   */
  private restoreProvenance(
    view: EditorView,
    snapshot: Array<{ text: string; by: string }>,
    agentBy: string
  ): void {
    const authoredMarkType = view.state.schema.marks.proofAuthored;
    if (!authoredMarkType) return;

    let tr = view.state.tr;
    const doc = view.state.doc;

    // Use an array (not Map) to preserve per-occurrence attribution for duplicate text
    const entries = [...snapshot];

    // Walk new doc and restore provenance where text matches, consuming entries
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const existingAuthored = node.marks.find(m => m.type.name === 'proofAuthored');
      if (existingAuthored) return; // already has provenance

      const idx = entries.findIndex(e => e.text === node.text);
      if (idx !== -1) {
        // Unchanged text — restore original provenance, consume the entry
        const entry = entries.splice(idx, 1)[0];
        tr = tr.addMark(pos, pos + node.nodeSize, authoredMarkType.create({ by: entry.by }));
      }
      // New/changed text without provenance can be attributed to agent
      // but we leave that to the authored-tracker plugin to handle naturally
    });

    if (tr.docChanged || tr.steps.length > 0) {
      view.dispatch(tr);
    }
  }

  /**
   * Trigger fade-out CSS class for refresh transition.
   */
  private triggerRefreshFadeOut(): void {
    const editor = document.querySelector('.milkdown') as HTMLElement;
    if (editor) {
      editor.classList.add('proof-refreshing');
      editor.classList.remove('proof-refreshed');
    }
  }

  /**
   * Trigger fade-in CSS class for refresh transition.
   */
  private triggerRefreshFadeIn(): void {
    const editor = document.querySelector('.milkdown') as HTMLElement;
    if (editor) {
      editor.classList.remove('proof-refreshing');
      editor.classList.add('proof-refreshed');
      // Clean up class after animation
      setTimeout(() => editor.classList.remove('proof-refreshed'), 400);
    }
  }

  /**
   * Show a toast notification for highlights mode changes.
   */
  private showExternalChangeToast(by: string, markCount: number): void {
    // Remove existing toast
    this.removeExternalChangeToast();

    const agentName = by.startsWith('ai:') ? by.slice(3).replace(/-/g, ' ') : 'External agent';
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);

    const toast = document.createElement('div');
    toast.className = 'proof-external-change-toast';
    toast.innerHTML = `
      <div class="proof-toast-content">
        <span class="proof-toast-message">${displayName} updated ${markCount} section${markCount !== 1 ? 's' : ''}</span>
        <div class="proof-toast-actions">
          <button class="proof-toast-btn proof-toast-review">Review</button>
          <button class="proof-toast-btn proof-toast-accept-all">Accept All</button>
          <button class="proof-toast-btn proof-toast-reject-all">Reject All</button>
        </div>
      </div>
    `;

    // Review button — scroll to first suggestion
    toast.querySelector('.proof-toast-review')?.addEventListener('click', () => {
      this.navigateToFirstSuggestion();
      this.removeExternalChangeToast();
    });

    // Accept All
    toast.querySelector('.proof-toast-accept-all')?.addEventListener('click', () => {
      this.markAcceptAll();
      this.removeExternalChangeToast();
    });

    // Reject All
    toast.querySelector('.proof-toast-reject-all')?.addEventListener('click', () => {
      this.markRejectAll();
      this.removeExternalChangeToast();
    });

    document.body.appendChild(toast);
    this.toastElement = toast;

    // Auto-dismiss after 10 seconds
    setTimeout(() => this.removeExternalChangeToast(), 10000);
  }

  private removeExternalChangeToast(): void {
    if (this.toastElement) {
      this.toastElement.remove();
      this.toastElement = null;
    }
  }

  /**
   * Show refresh banner with revert option.
   */
  private showRefreshBanner(by: string, stats?: ChangeStats): void {
    this.removeRefreshBanner();

    const agentName = by.startsWith('ai:') ? by.slice(3).replace(/-/g, ' ') : 'External agent';
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);

    // Build a human-readable summary of what changed
    let summary = '';
    if (stats) {
      const parts: string[] = [];
      if (stats.replacedLines > 0) parts.push(`${stats.replacedLines} modified`);
      if (stats.insertedLines > 0) parts.push(`${stats.insertedLines} added`);
      if (stats.deletedLines > 0) parts.push(`${stats.deletedLines} removed`);
      if (parts.length > 0) {
        summary = parts.join(', ') + ` line${stats.changedLines !== 1 ? 's' : ''}`;
      } else {
        summary = `${stats.changedLines} line${stats.changedLines !== 1 ? 's' : ''} changed`;
      }
    }

    const banner = document.createElement('div');
    banner.className = 'proof-refresh-banner';

    const REVERT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
    const canRevert = this.preRefreshRevertContent !== null &&
      (Date.now() - this.preRefreshRevertTimestamp) < REVERT_WINDOW_MS;

    banner.innerHTML = `
      <div class="proof-refresh-banner-info">
        <span class="proof-refresh-banner-title">${displayName} rewrote this document</span>
        ${summary ? `<span class="proof-refresh-banner-summary">${summary}</span>` : ''}
      </div>
      <div class="proof-refresh-banner-actions">
        ${canRevert ? '<button class="proof-refresh-banner-btn proof-refresh-revert">Undo rewrite</button>' : ''}
        <button class="proof-refresh-banner-btn proof-refresh-dismiss">&times;</button>
      </div>
    `;

    if (canRevert) {
      banner.querySelector('.proof-refresh-revert')?.addEventListener('click', () => {
        this.revertRefresh();
        this.removeRefreshBanner();
      });
    }

    banner.querySelector('.proof-refresh-dismiss')?.addEventListener('click', () => {
      this.removeRefreshBanner();
    });

    const editorEl = document.getElementById('editor');
    if (editorEl) {
      editorEl.insertBefore(banner, editorEl.firstChild);
    } else {
      document.body.appendChild(banner);
    }
    this.refreshBanner = banner;

    // Auto-hide after 60 seconds
    setTimeout(() => this.removeRefreshBanner(), 60000);
  }

  private removeRefreshBanner(): void {
    if (this.refreshBanner) {
      this.refreshBanner.remove();
      this.refreshBanner = null;
    }
  }

  /**
   * Revert a refresh by loading the pre-refresh content.
   */
  private revertRefresh(): void {
    const REVERT_WINDOW_MS = 60 * 60 * 1000;
    if (!this.preRefreshRevertContent) return;
    if ((Date.now() - this.preRefreshRevertTimestamp) > REVERT_WINDOW_MS) {
      console.warn('[revertRefresh] Revert window expired');
      return;
    }

    this.loadDocument(this.preRefreshRevertContent);
    this.preRefreshRevertContent = null;

  }

  /**
   * Find matches in the document (no edits).
   */
  markFind(
    find: string,
    options?: FindOptions
  ): { success: boolean; count: number; matches?: Array<{ from: number; to: number; match: string; line: number; column: number; snippet: string }>; error?: string } {
    if (!this.editor) {
      return { success: false, count: 0, error: 'Editor not initialized' };
    }

    let result: { success: boolean; count: number; matches?: Array<{ from: number; to: number; match: string; line: number; column: number; snippet: string }>; error?: string } = {
      success: false,
      count: 0,
    };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const scope = options?.scope ?? 'all';
      if (scope === 'selection' && view.state.selection.from === view.state.selection.to) {
        result = { success: false, count: 0, error: 'No selection' };
        return;
      }

      const matches = findMatchesInDoc(view.state.doc, find, options);
      const scopedMatches = this.filterMatchesByScope(view, matches, scope);
      if (scopedMatches.length === 0) {
        result = { success: false, count: 0, error: 'No matches' };
        return;
      }

      const summaries = scopedMatches.map(match => {
        const { line, col } = this.offsetToLineCol(view.state.doc, match.from);
        const snippetFrom = Math.max(0, match.from - 40);
        const snippetTo = Math.min(view.state.doc.content.size, match.to + 40);
        const snippet = view.state.doc.textBetween(snippetFrom, snippetTo, '\n', '\n');
        return {
          from: match.from,
          to: match.to,
          match: match.match,
          line,
          column: col,
          snippet,
        };
      });

      result = { success: true, count: summaries.length, matches: summaries };
    });

    return result;
  }

  searchDocument(
    query: string,
    options: FindOptions = {}
  ): {
    success: boolean;
    count: number;
    matches: Array<{ text: string; position: number; context: string; from: number; to: number }>;
    error?: string;
  } {
    if (!this.editor) {
      return { success: false, count: 0, matches: [], error: 'Editor not initialized' };
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return { success: false, count: 0, matches: [], error: 'Empty query' };
    }

    let result: {
      success: boolean;
      count: number;
      matches: Array<{ text: string; position: number; context: string; from: number; to: number }>;
      error?: string;
    } = {
      success: false,
      count: 0,
      matches: [],
    };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const docSize = view.state.doc.content.size;
      const matches = findMatchesInDoc(view.state.doc, trimmedQuery, options);

      if (matches.length === 0) {
        result = { success: false, count: 0, matches: [], error: 'No matches' };
        return;
      }

      const summaries = matches.map((match) => {
        const contextFrom = Math.max(0, match.from - 60);
        const contextTo = Math.min(docSize, match.to + 60);
        const context = view.state.doc.textBetween(contextFrom, contextTo, '\n', '\n');
        return {
          text: match.match,
          position: match.from,
          context,
          from: match.from,
          to: match.to,
        };
      });

      result = { success: true, count: summaries.length, matches: summaries };
    });

    return result;
  }

  /**
   * Modify a suggestion's content before accepting
   */
  markModifySuggestion(markId: string, content: string): boolean {
    if (!this.editor) {
      console.warn('[markModifySuggestion] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      success = modifySuggestionContent(view, markId, content);
      console.log('[markModifySuggestion] Modified:', success);
    });
    return success;
  }

  /**
   * Accept a suggestion and apply the change
   */
  markAccept(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markAccept] Editor not initialized');
      return false;
    }

    if (this.isShareMode) {
      let canAccept = false;
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        canAccept = getPendingSuggestions(getMarks(view.state)).some((mark) => mark.id === markId);
      });
      if (!canAccept) {
        console.warn('[markAccept] Suggestion not pending in share mode:', markId);
        return false;
      }

      const actor = getCurrentActor();
      void shareClient.acceptSuggestion(markId, actor).then((result) => {
        if (!result || 'error' in result || result.success !== true) return;
        const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
          ? result.marks as Record<string, StoredMark>
          : null;
        if (!serverMarks) return;
        this.lastReceivedServerMarks = { ...serverMarks };
        this.initialMarksSynced = true;
        if (this.editor) {
          this.editor.action((innerCtx) => {
            const innerView = innerCtx.get(editorViewCtx);
            applyRemoteMarks(innerView, serverMarks, { hydrateAnchors: this.collabCanEdit });
            const stats = getAuthorshipStats(innerView);
            this.bridge.authorshipStatsUpdated(stats);
          });
        }
        captureEvent('suggestion_accepted', { count: 1 });
      }).catch((error) => {
        console.error('[markAccept] Failed to persist suggestion acceptance via share mutation:', error);
      });
      return true;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      success = acceptMark(view, markId, parser);
      console.log('[markAccept] Accepted:', success);
      if (success && this.isShareMode) {
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;

        const actor = getCurrentActor();
        void shareClient.acceptSuggestion(markId, actor).then((result) => {
          if (!result || 'error' in result || result.success !== true) return;
          const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
            ? result.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.lastReceivedServerMarks = { ...serverMarks };
          this.initialMarksSynced = true;
          if (this.editor) {
            this.editor.action((innerCtx) => {
              const innerView = innerCtx.get(editorViewCtx);
              const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);
              setMarkMetadata(innerView, mergedMetadata);
            });
          }
        }).catch((error) => {
          console.error('[markAccept] Failed to persist suggestion acceptance via share mutation:', error);
        });
      }
      if (success) {
        captureEvent('suggestion_accepted', { count: 1 });
        const stats = getAuthorshipStats(view);
        this.bridge.authorshipStatsUpdated(stats);
      }
    });

    return success;
  }

  /**
   * Reject a suggestion without changing the document
   */
  markReject(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markReject] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      success = rejectMark(view, markId);
      console.log('[markReject] Rejected:', success);
      if (success && this.isShareMode) {
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;

        const actor = getCurrentActor();
        void shareClient.rejectSuggestion(markId, actor).then((result) => {
          if (!result || 'error' in result || result.success !== true) return;
          const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
            ? result.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.lastReceivedServerMarks = { ...serverMarks };
          this.initialMarksSynced = true;
          if (this.editor) {
            this.editor.action((innerCtx) => {
              const innerView = innerCtx.get(editorViewCtx);
              const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);
              setMarkMetadata(innerView, mergedMetadata);
            });
          }
        }).catch((error) => {
          console.error('[markReject] Failed to persist suggestion rejection via share mutation:', error);
        });
      }
      if (success) {
        captureEvent('suggestion_rejected', { count: 1 });
      }
    });
    return success;
  }

  /**
   * Accept all pending suggestions
   */
  markAcceptAll(): number {
    if (!this.editor) {
      console.warn('[markAcceptAll] Editor not initialized');
      return 0;
    }

    if (this.isShareMode) {
      let acceptedIds: string[] = [];
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        acceptedIds = getPendingSuggestions(getMarks(view.state)).map((mark) => mark.id);
      });
      if (acceptedIds.length === 0) return 0;

      const actor = getCurrentActor();
      void (async () => {
        let latestServerMarks: Record<string, StoredMark> | null = null;
        let acceptedCount = 0;
        for (const suggestionId of acceptedIds) {
          const result = await shareClient.acceptSuggestion(suggestionId, actor);
          if (!result || 'error' in result || result.success !== true) continue;
          const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
            ? result.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) continue;
          latestServerMarks = serverMarks;
          acceptedCount += 1;
        }
        if (!latestServerMarks) return;
        this.lastReceivedServerMarks = { ...latestServerMarks };
        this.initialMarksSynced = true;
        if (this.editor) {
          this.editor.action((innerCtx) => {
            const innerView = innerCtx.get(editorViewCtx);
            applyRemoteMarks(innerView, latestServerMarks!, { hydrateAnchors: this.collabCanEdit });
            const stats = getAuthorshipStats(innerView);
            this.bridge.authorshipStatsUpdated(stats);
          });
        }
        if (acceptedCount > 0) {
          captureEvent('suggestion_accepted', { count: acceptedCount });
        }
      })().catch((error) => {
        console.error('[markAcceptAll] Failed to persist suggestion acceptance via share mutation:', error);
      });
      return acceptedIds.length;
    }

    let count = 0;
    let acceptedIds: string[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      acceptedIds = getPendingSuggestions(getMarks(view.state)).map((mark) => mark.id);
      count = acceptAll(view, parser);
      console.log('[markAcceptAll] Accepted:', count);
      if (count > 0 && this.isShareMode && acceptedIds.length > 0) {
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;

        const actor = getCurrentActor();
        void (async () => {
          let latestServerMarks: Record<string, StoredMark> | null = null;
          for (const suggestionId of acceptedIds) {
            const result = await shareClient.acceptSuggestion(suggestionId, actor);
            if (!result || 'error' in result || result.success !== true) continue;
            const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
              ? result.marks as Record<string, StoredMark>
              : null;
            if (!serverMarks) continue;
            latestServerMarks = serverMarks;
          }
          if (!latestServerMarks) return;
          this.lastReceivedServerMarks = { ...latestServerMarks };
          this.initialMarksSynced = true;
          if (this.editor) {
            this.editor.action((innerCtx) => {
              const innerView = innerCtx.get(editorViewCtx);
              applyRemoteMarks(innerView, latestServerMarks!, { hydrateAnchors: this.collabCanEdit });
            });
          }
        })().catch((error) => {
          console.error('[markAcceptAll] Failed to persist suggestion acceptance via share mutation:', error);
        });
      }
      if (count > 0) {
        captureEvent('suggestion_accepted', { count });
        const stats = getAuthorshipStats(view);
        this.bridge.authorshipStatsUpdated(stats);
      }
    });

    return count;
  }

  /**
   * Reject all pending suggestions
   */
  markRejectAll(): number {
    if (!this.editor) {
      console.warn('[markRejectAll] Editor not initialized');
      return 0;
    }

    let count = 0;
    let rejectedIds: string[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      rejectedIds = getPendingSuggestions(getMarks(view.state)).map((mark) => mark.id);
      count = rejectAll(view);
      console.log('[markRejectAll] Rejected:', count);
      if (count > 0 && this.isShareMode && rejectedIds.length > 0) {
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;

        const actor = getCurrentActor();
        void (async () => {
          let latestServerMarks: Record<string, StoredMark> | null = null;
          for (const suggestionId of rejectedIds) {
            const result = await shareClient.rejectSuggestion(suggestionId, actor);
            if (!result || 'error' in result || result.success !== true) continue;
            const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
              ? result.marks as Record<string, StoredMark>
              : null;
            if (!serverMarks) continue;
            latestServerMarks = serverMarks;
          }
          if (!latestServerMarks) return;
          this.lastReceivedServerMarks = { ...latestServerMarks };
          this.initialMarksSynced = true;
          if (this.editor) {
            this.editor.action((innerCtx) => {
              const innerView = innerCtx.get(editorViewCtx);
              const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), latestServerMarks!);
              setMarkMetadata(innerView, mergedMetadata);
            });
          }
        })().catch((error) => {
          console.error('[markRejectAll] Failed to persist suggestion rejection via share mutation:', error);
        });
      }
      if (count > 0) {
        captureEvent('suggestion_rejected', { count });
        const stats = getAuthorshipStats(view);
        this.bridge.authorshipStatsUpdated(stats);
      }
    });
    return count;
  }

  /**
   * Delete a mark by ID
   */
  markDelete(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markDelete] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      success = deleteMark(view, markId);
      console.log('[markDelete] Deleted:', success);
    });
    return success;
  }

  /**
   * Set the active mark for highlighting
   */
  markSetActive(markId: string | null): void {
    if (!this.editor) {
      console.warn('[markSetActive] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      setActiveMark(view, markId);
      console.log('[markSetActive] Set active mark:', markId);
    });
  }

  // =====================
  // Authorship (Provenance)
  // =====================

  /**
   * Get authorship statistics for the current document
   * Returns percentage and character count for human vs AI authored content
   */
  getMarkMetadata(): Record<string, unknown> {
    if (!this.editor) return {};
    let metadata: Record<string, unknown> = {};
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      metadata = getMarkMetadata(view.state) as Record<string, unknown>;
    });
    return metadata;
  }

  getMarkMetadataWithQuotes(): Record<string, unknown> {
    if (!this.editor) return {};
    let metadata: Record<string, unknown> = {};
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      metadata = getMarkMetadataWithQuotes(view.state) as Record<string, unknown>;
    });
    return metadata;
  }

  getAuthorshipStats(): { humanPercent: number; aiPercent: number; humanChars: number; aiChars: number } {
    if (!this.editor) {
      return { humanPercent: 0, aiPercent: 0, humanChars: 0, aiChars: 0 };
    }

    let stats = { humanPercent: 0, aiPercent: 0, humanChars: 0, aiChars: 0 };
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      stats = getAuthorshipStats(view);
      console.log('[getAuthorshipStats] Stats:', stats);
    });
    return stats;
  }

  /**
   * Add an authored mark for a range of content
   * Used when AI inserts content via MCP or human types
   */
  addAuthoredMark(by: string, range: MarkRange, quote?: string): Mark {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      mark = addAuthoredMark(view, by, range, quote);
      console.log('[addAuthoredMark] Created authored mark:', mark.id);
    });
    return mark!;
  }

  /**
   * Override authored marks for the current selection (or block)
   */
  markAuthoredSelection(by: string): Mark | null {
    if (!this.editor) {
      console.warn('[markAuthoredSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      mark = setAuthoredMark(view, by, range);
      if (mark) {
        console.log('[markAuthoredSelection] Created authored mark:', mark.id);
      }
    });
    return mark;
  }

  /**
   * Coalesce adjacent authored marks by the same actor
   * Call this periodically (e.g., on save) to reduce mark count
   */
  coalesceMarks(): void {
    if (!this.editor) {
      console.warn('[coalesceMarks] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      coalesceMarks(view);
      console.log('[coalesceMarks] Coalesced marks');
    });
  }

  /**
   * Update mark positions after a document edit
   * This keeps ranges in sync when the document changes
   */
  updateMarksAfterEdit(editFrom: number, editTo: number, newLength: number): void {
    if (!this.editor) {
      console.warn('[updateMarksAfterEdit] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      updateMarksAfterEdit(view, editFrom, editTo, newLength);
      console.log('[updateMarksAfterEdit] Updated marks after edit:', editFrom, editTo, newLength);
    });
  }

  // === Navigation Methods ===

  /**
   * Navigate to a specific mark by ID
   * Scrolls to the mark position and sets it as active (opens popover)
   */
  navigateToMark(markId: string): boolean {
    if (!this.editor) {
      console.warn('[navigateToMark] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const marks = getMarks(view.state);
      const mark = marks.find(m => m.id === markId);

      if (!mark || !mark.range) {
        console.warn('[navigateToMark] Mark not found:', markId);
        return;
      }

      // Set as active mark (this opens the popover)
      setActiveMark(view, markId);

      // Scroll to the mark position
      const pos = mark.range.from;
      const coords = view.coordsAtPos(pos);
      if (coords) {
        const editorRect = view.dom.getBoundingClientRect();
        const scrollTop = view.dom.scrollTop;
        const targetY = coords.top - editorRect.top + scrollTop - (editorRect.height / 3);
        view.dom.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
      }

      console.log('[navigateToMark] Navigated to mark:', markId, 'at position:', pos);
      success = true;
    });

    return success;
  }

  /**
   * Navigate to the first unresolved comment
   */
  navigateToFirstComment(): string | null {
    this.currentCommentIndex = -1;
    return this.navigateToNextComment();
  }

  /**
   * Navigate to the next unresolved comment
   */
  navigateToNextComment(): string | null {
    if (!this.editor) {
      console.warn('[navigateToNextComment] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      const comments = getUnresolvedMarkComments(allMarks);

      if (comments.length === 0) {
        console.log('[navigateToNextComment] No unresolved comments');
        this.currentCommentIndex = -1;
        return;
      }

      // Sort by position
      const sortedComments = [...comments].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentCommentIndex = (this.currentCommentIndex + 1) % sortedComments.length;
      const mark = sortedComments[this.currentCommentIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Navigate to the previous unresolved comment
   */
  navigateToPrevComment(): string | null {
    if (!this.editor) {
      console.warn('[navigateToPrevComment] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      const comments = getUnresolvedMarkComments(allMarks);

      if (comments.length === 0) {
        console.log('[navigateToPrevComment] No unresolved comments');
        this.currentCommentIndex = -1;
        return;
      }

      // Sort by position
      const sortedComments = [...comments].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentCommentIndex = this.currentCommentIndex <= 0
        ? sortedComments.length - 1
        : this.currentCommentIndex - 1;
      const mark = sortedComments[this.currentCommentIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Navigate to the first pending suggestion
   */
  navigateToFirstSuggestion(): string | null {
    this.currentSuggestionIndex = -1;
    return this.navigateToNextSuggestion();
  }

  /**
   * Navigate to the next pending suggestion
   */
  navigateToNextSuggestion(): string | null {
    if (!this.editor) {
      console.warn('[navigateToNextSuggestion] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const suggestions = getPendingSuggestions(getMarks(view.state));

      if (suggestions.length === 0) {
        console.log('[navigateToNextSuggestion] No pending suggestions');
        this.currentSuggestionIndex = -1;
        return;
      }

      // Sort by position
      const sortedSuggestions = [...suggestions].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentSuggestionIndex = (this.currentSuggestionIndex + 1) % sortedSuggestions.length;
      const mark = sortedSuggestions[this.currentSuggestionIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Navigate to the previous pending suggestion
   */
  navigateToPrevSuggestion(): string | null {
    if (!this.editor) {
      console.warn('[navigateToPrevSuggestion] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const suggestions = getPendingSuggestions(getMarks(view.state));

      if (suggestions.length === 0) {
        console.log('[navigateToPrevSuggestion] No pending suggestions');
        this.currentSuggestionIndex = -1;
        return;
      }

      // Sort by position
      const sortedSuggestions = [...suggestions].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentSuggestionIndex = this.currentSuggestionIndex <= 0
        ? sortedSuggestions.length - 1
        : this.currentSuggestionIndex - 1;
      const mark = sortedSuggestions[this.currentSuggestionIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Resolve the currently active comment (if any)
   * Returns true if a comment was resolved, false if no active comment or not a comment.
   */
  resolveActiveComment(): boolean {
    if (!this.editor) {
      console.warn('[resolveActiveComment] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const activeId = getActiveMarkId(view.state);
      if (!activeId) return;

      const marks = getMarks(view.state);
      const mark = marks.find(m => m.id === activeId);
      if (!mark || mark.kind !== 'comment') return;

      success = markResolve(view, activeId);
      if (success) {
        setActiveMark(view, null);
      }
    });
    return success;
  }

  /**
   * Sweep the document for actionable items (called by always-on timer).
   * Finds unresolved comments needing agent response and triggers the agent.
   */
  sweepForActionableItems(triggerOnFirstSweep = false): void {
    captureEvent('agent_sweep_requested', { trigger_on_first_sweep: triggerOnFirstSweep });
    agentSweep(triggerOnFirstSweep);
  }

  setAlwaysOnEnabled(enabled: boolean): void {
    agentSetAlwaysOnEnabled(enabled);
  }

  // === Find Methods (Cmd+F) ===

  /**
   * Show the find UI.
   */
  showFindBar(): void {
    // The web app uses the toolbar find UI directly.
  }

  /**
   * Hide the find bar
   */
  hideFindBar(): void {
    this.clearFind();
  }

  /**
   * Find text in document, returns match info
   */
  find(query: string): { total: number; current: number } {
    if (!this.editor || !query || query.trim().length === 0) {
      this.findMatches = [];
      this.findQuery = '';
      this.currentFindIndex = -1;
      if (this.editor) {
        this.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          clearFindHighlights(view);
        });
      }
      return { total: 0, current: 0 };
    }

    this.findQuery = query;
    this.findMatches = [];
    this.currentFindIndex = -1;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const matches = findMatchesInDoc(view.state.doc, query, {
        regex: false,
        caseSensitive: false,
        normalizeWhitespace: false,
        maxMatches: 1000,
      });
      this.findMatches = matches.map((match) => ({ from: match.from, to: match.to }));
      if (this.findMatches.length === 0) {
        clearFindHighlights(view);
      }
    });

    // Navigate to first match if any
    if (this.findMatches.length > 0) {
      return this.findNext();
    }

    return { total: 0, current: 0 };
  }

  /**
   * Navigate to next match
   */
  findNext(): { total: number; current: number } {
    if (this.findMatches.length === 0) {
      return { total: 0, current: 0 };
    }

    this.currentFindIndex = (this.currentFindIndex + 1) % this.findMatches.length;
    this.highlightCurrentMatch();

    return { total: this.findMatches.length, current: this.currentFindIndex + 1 };
  }

  /**
   * Navigate to previous match
   */
  findPrev(): { total: number; current: number } {
    if (this.findMatches.length === 0) {
      return { total: 0, current: 0 };
    }

    this.currentFindIndex = this.currentFindIndex <= 0
      ? this.findMatches.length - 1
      : this.currentFindIndex - 1;
    this.highlightCurrentMatch();

    return { total: this.findMatches.length, current: this.currentFindIndex + 1 };
  }

  /**
   * Clear find highlighting
   */
  clearFind(): void {
    this.findQuery = '';
    this.findMatches = [];
    this.currentFindIndex = -1;
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      clearFindHighlights(view);
    });
  }

  // =====================
  // Skills & Review
  // =====================

  /**
   * Set the API key for the embedded agent
   */
  setApiKey(apiKey: string): void {
    setAgentApiKey(apiKey);
    console.log('[proof] API key configured');
    captureEvent('agent_api_key_configured', { configured: Boolean(apiKey.trim()) });
  }

  /**
   * Get available review skills
   */
  getSkills(): Array<{
    id: string;
    name: string;
    description: string;
    icon?: string;
    parallelStrategy: string;
    maxAgents?: number;
    batchSize?: number;
    orchestratedVisibleMarks?: boolean;
    promptCharCount: number;
    styleGuideVersion?: string;
    styleGuideCharCount?: number;
  }> {
    const registry = getSkillsRegistry();
    return registry.getAllSkills().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      icon: skill.icon,
      parallelStrategy: skill.parallelStrategy,
      debugLoop: skill.debugLoop,
      maxAgents: skill.maxAgents,
      batchSize: skill.batchSize,
      orchestratedVisibleMarks: skill.orchestratedVisibleMarks,
      promptCharCount: skill.prompt.length,
      styleGuideVersion: skill.styleGuideVersion,
      styleGuideCharCount: skill.styleGuideCharCount,
    }));
  }

  reviewLock(reason?: string): { locked: boolean; lockCount: number; reason?: string } {
    if (reason) {
      this.reviewLockReason = reason;
    }

    this.reviewLockCount += 1;
    this.ensureReviewLockBanner();
    this.updateEditableState();
    this.scheduleBannerLayoutUpdate();

    return this.getReviewLockState();
  }

  reviewUnlock(): { locked: boolean; lockCount: number } {
    if (this.reviewLockCount > 0) {
      this.reviewLockCount -= 1;
    }

    if (this.reviewLockCount === 0) {
      this.reviewLockReason = null;
      this.removeReviewLockBanner();
    } else {
      this.updateReviewLockBannerText();
      this.scheduleBannerLayoutUpdate();
    }

    this.updateEditableState();
    const { locked, lockCount } = this.getReviewLockState();
    return { locked, lockCount };
  }

  reviewLockStatus(): { locked: boolean; lockCount: number; reason?: string } {
    return this.getReviewLockState();
  }

  isReviewLocked(): boolean {
    return this.reviewLockCount > 0;
  }

  /**
   * Run a skill-based review
   */
  async runSkillReview(skillId: string, scope: 'selection' | 'document'): Promise<void> {
    if (!this.editor) {
      console.error('[proof] Cannot run skill review: editor not initialized');
      captureEvent('review_run_rejected', { reason: 'editor_not_initialized', skill_id: skillId, scope });
      return;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill: ${skillId}`);
      captureEvent('review_run_rejected', { reason: 'unknown_skill', skill_id: skillId, scope });
      return;
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring request for ${skillId}`);
      captureEvent('review_run_rejected', { reason: 'review_in_flight', skill_id: skill.id, scope });
      return;
    }

    console.log(`[proof] Running skill review: ${skill.name} (${scope})`);
    const startedAt = Date.now();
    let runSucceeded = false;
    let runError: string | undefined;
    captureEvent('review_run_started', {
      skill_id: skill.id,
      scope,
    });

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from, to } = view.state.selection;
      const hasSelection = from !== to;

      // Use selection if available and scope is 'selection', otherwise review whole doc
      const selection = scope === 'selection' && hasSelection ? { from, to } : undefined;

      const reviewPromise = runReview(view, skill, scope, selection);
      try {
        await reviewPromise;
        runSucceeded = true;
        console.log(`[proof] Skill review completed: ${skill.name}`);
      } catch (error) {
        runError = error instanceof Error ? error.name : 'unknown_error';
        console.error(`[proof] Skill review failed: ${skill.name}`, error);
      }
    });

    this.reviewInFlight = actionPromise;
    try {
      await actionPromise;
      captureEvent('review_run_completed', {
        skill_id: skill.id,
        scope,
        success: runSucceeded,
        duration_ms: Date.now() - startedAt,
        error_type: runError ?? 'none',
      });
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  /**
   * Debug helper: run the orchestrator only and return its focus-area plan.
   * This does not create marks or lock the document.
   */
  async debugPlanOnly(
    skillId: string,
    options?: {
      forceFresh?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown> {
    if (!this.editor) {
      console.error('[proof] Cannot run plan-only debug: editor not initialized');
      return null;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill for plan-only debug: ${skillId}`);
      return null;
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring plan-only request for ${skillId}`);
      return null;
    }

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      return debugPlanOnlyReview(view, skill, options);
    });

    this.reviewInFlight = actionPromise;
    try {
      const result = await actionPromise;
      console.log('[proof] Plan-only debug result:', result);
      return result;
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  /**
   * Debug helper: run exactly one focus area via a single sub-agent.
   * This returns proposals and rejection reasons, but does not create marks.
   */
  async debugRunSingleFocusArea(
    skillId: string,
    options?: {
      focusAreaIndex?: number;
      focusAreaId?: string;
      useCachedPlan?: boolean;
      forceFreshPlan?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown> {
    if (!this.editor) {
      console.error('[proof] Cannot run single focus-area debug: editor not initialized');
      return null;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill for single focus-area debug: ${skillId}`);
      return null;
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring single focus-area request for ${skillId}`);
      return null;
    }

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      return debugRunSingleFocusAreaReview(view, skill, options);
    });

    this.reviewInFlight = actionPromise;
    try {
      const result = await actionPromise;
      console.log('[proof] Single focus-area debug result:', result);
      return result;
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  debugGetCachedPlan(skillId: string): unknown {
    return debugGetCachedPlanReview(skillId);
  }

  debugClearPlanCache(skillId?: string): void {
    debugClearPlanCacheReview(skillId);
  }

  /**
   * Debug helper: run the full orchestrator path with explicit orchestration
   * options (for example, focusAreaIds) so the run matches real behavior.
   */
  async debugRunOrchestrated(
    skillId: string,
    options?: {
      scope?: ReviewScope;
      selection?: { from: number; to: number };
      orchestration?: OrchestrationRunOptions;
      cancelActive?: boolean;
    }
  ): Promise<unknown> {
    if (!this.editor) {
      console.error('[proof] Cannot run orchestrated debug: editor not initialized');
      return null;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill for orchestrated debug: ${skillId}`);
      return null;
    }

    if (options?.cancelActive) {
      try {
        await cancelActiveReview();
      } catch (error) {
        console.warn('[proof] Failed to cancel active review before orchestrated debug:', error);
      } finally {
        this.reviewInFlight = null;
      }
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring orchestrated debug request for ${skillId}`);
      return null;
    }

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      const scope: ReviewScope = options?.scope ?? 'document';
      const selection = scope === 'selection' ? options?.selection : undefined;
      return runReview(view, skill, scope, selection, options?.orchestration);
    });

    this.reviewInFlight = actionPromise;
    try {
      const result = await actionPromise;
      console.log('[proof] Orchestrated debug result:', result);
      return result;
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  /**
   * Debug helper: map plain-text offsets to a doc range + quote using the
   * same text index utilities as the orchestrator.
   */
  debugMapTextOffsets(from: number, to: number): { range: MarkRange | null; quote: string | null } | null {
    if (!this.editor) {
      console.error('[proof] Cannot map text offsets: editor not initialized');
      return null;
    }

    let result: { range: MarkRange | null; quote: string | null } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      const safeFrom = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
      const safeTo = Number.isFinite(to) ? Math.max(safeFrom, Math.floor(to)) : safeFrom;

      const index = buildTextIndex(doc);
      const mapped = mapTextOffsetsToRange(index, safeFrom, safeTo);
      if (!mapped) {
        result = { range: null, quote: null };
        return;
      }

      const clampedFrom = Math.max(0, Math.min(mapped.from, docSize));
      const clampedTo = Math.max(clampedFrom, Math.min(mapped.to, docSize));
      const clampedRange: MarkRange = { from: clampedFrom, to: clampedTo };
      const quote = getTextForRange(doc, clampedRange);
      result = { range: clampedRange, quote };
    });

    return result;
  }

  /**
   * Debug helper: describe textblock boundaries intersecting a given doc range.
   * Useful for diagnosing structural safety checks.
   */
  debugDescribeTextblocks(range: { from: number; to: number }): unknown {
    if (!this.editor) {
      console.error('[proof] Cannot describe textblocks: editor not initialized');
      return null;
    }

    let result: unknown = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      const safeFrom = Number.isFinite(range?.from) ? Math.max(0, Math.floor(range.from)) : 0;
      const safeTo = Number.isFinite(range?.to) ? Math.max(safeFrom, Math.floor(range.to)) : safeFrom;
      const clampedFrom = Math.max(0, Math.min(safeFrom, docSize));
      const clampedTo = Math.max(clampedFrom, Math.min(safeTo, docSize));

      const slices: Array<{
        from: number;
        to: number;
        text: string;
        leadingWhitespace: number;
        trailingWhitespace: number;
        fullyCovered: boolean;
      }> = [];

      doc.nodesBetween(clampedFrom, clampedTo, (node, pos) => {
        if (!node.isTextblock) return;
        const from = pos + 1;
        const to = pos + node.content.size;
        if (clampedTo <= from || clampedFrom >= to) return;
        const text = doc.textBetween(from, to, '\n', '\n');
        const leadingWhitespace = text.match(/^\s+/)?.[0].length ?? 0;
        const trailingWhitespace = text.match(/\s+$/)?.[0].length ?? 0;
        const fullyCovered = clampedFrom <= from && clampedTo >= to;
        slices.push({ from, to, text, leadingWhitespace, trailingWhitespace, fullyCovered });
      });

      result = {
        docSize,
        range: { from: clampedFrom, to: clampedTo },
        slices,
      };
    });

    return result;
  }

  debugTextForRange(range: MarkRange): { range: MarkRange; text: string } | null {
    if (!this.editor) {
      console.error('[proof] Cannot read text for range: editor not initialized');
      return null;
    }
    const safeRange: MarkRange = {
      from: Math.max(0, Math.floor(range?.from ?? 0)),
      to: Math.max(0, Math.floor(range?.to ?? 0)),
    };
    if (safeRange.to < safeRange.from) {
      safeRange.to = safeRange.from;
    }

    let result: { range: MarkRange; text: string } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      const clamped: MarkRange = {
        from: Math.max(0, Math.min(safeRange.from, docSize)),
        to: Math.max(0, Math.min(safeRange.to, docSize)),
      };
      if (clamped.to < clamped.from) {
        clamped.to = clamped.from;
      }
      const text = doc.textBetween(clamped.from, clamped.to, '\n', '\n');
      result = { range: clamped, text };
    });
    return result;
  }

  debugGetParagraphCandidate(minWords: number = 8): { range: MarkRange; quote: string; line: number } | null {
    if (!this.editor) {
      console.error('[proof] Cannot get paragraph candidate: editor not initialized');
      return null;
    }

    let candidate: { range: MarkRange; quote: string; line: number } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      let currentLine = 0;

      doc.descendants((node, pos) => {
        if (!node.isBlock) return true;

        if (!candidate && node.type.name === 'paragraph') {
          const words = node.textContent.split(/\s+/).filter(w => w.length > 0);
          if (words.length >= Math.max(1, Math.floor(minWords))) {
            const from = Math.max(0, Math.min(pos + 1, docSize));
            const to = Math.max(from, Math.min(pos + node.content.size + 1, docSize));
            candidate = {
              range: { from, to },
              quote: node.textContent,
              line: currentLine,
            };
            return false;
          }
        }

        currentLine += 1;
        return true;
      });
    });

    return candidate;
  }

  debugFindBlockByText(text: string): { range: MarkRange; nodeType: string; line: number } | null {
    if (!this.editor) {
      console.error('[proof] Cannot find block by text: editor not initialized');
      return null;
    }

    const target = String(text ?? '').trim();
    if (!target) return null;

    let match: { range: MarkRange; nodeType: string; line: number } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      let currentLine = 0;

      doc.descendants((node, pos) => {
        if (!node.isBlock) return true;

        if (!match && node.textContent.trim() === target) {
          const from = Math.max(0, Math.min(pos + 1, docSize));
          const to = Math.max(from, Math.min(pos + node.content.size + 1, docSize));
          match = {
            range: { from, to },
            nodeType: node.type.name,
            line: currentLine,
          };
          return false;
        }

        currentLine += 1;
        return true;
      });
    });

    return match;
  }

  debugInspectMarksForText(target: string): {
    found: boolean;
    range?: MarkRange;
    markNames?: string[];
    hasEm?: boolean;
    hasStrong?: boolean;
  } | null {
    if (!this.editor) {
      console.error('[proof] Cannot inspect marks: editor not initialized');
      return null;
    }

    const needle = String(target ?? '').trim();
    if (!needle) return null;

    let result: {
      found: boolean;
      range?: MarkRange;
      markNames?: string[];
      hasEm?: boolean;
      hasStrong?: boolean;
    } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const index = buildTextIndex(doc);
      if (!index) {
        result = { found: false };
        return;
      }

      const start = index.text.indexOf(needle);
      if (start === -1) {
        result = { found: false };
        return;
      }

      const end = start + needle.length;
      const mapped = mapTextOffsetsToRange(index, start, end);
      if (!mapped) {
        result = { found: false };
        return;
      }

      const range: MarkRange = { from: mapped.from, to: mapped.to };
      const markNames = new Set<string>();

      doc.nodesBetween(range.from, range.to, (node) => {
        if (!node.isText) return;
        for (const mark of node.marks) {
          markNames.add(mark.type.name);
        }
      });

      const names = Array.from(markNames);
      result = {
        found: true,
        range,
        markNames: names,
        hasEm: markNames.has('em') || markNames.has('italic') || markNames.has('emphasis'),
        hasStrong: markNames.has('strong'),
      };
    });

    return result;
  }

  debugResolveRangeWithValidation(quote: string, range?: MarkRange): unknown {
    if (!this.editor) {
      console.error('[proof] Cannot resolve range: editor not initialized');
      return null;
    }

    let result: unknown = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      result = debugResolveRangeWithValidationMark(view.state.doc, quote, range);
    });
    return result;
  }

  debugAnalyzeReplace(quote: string, content: string, range?: MarkRange): unknown {
    if (!this.editor) {
      console.error('[proof] Cannot analyze replace: editor not initialized');
      return null;
    }

    let result: unknown = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      result = debugAnalyzeReplaceMark(view, quote, content, range, parser);
    });
    return result;
  }

  debugQuoteSpansMultipleTableCells(quote: string, range?: MarkRange): boolean {
    if (!this.editor) {
      console.error('[proof] Cannot check table-cell boundary: editor not initialized');
      return false;
    }

    let spansMultipleCells = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const resolvedRange = range ?? resolveQuoteRange(view.state.doc, quote);
      if (!resolvedRange) {
        spansMultipleCells = false;
        return;
      }
      spansMultipleCells = rangeCrossesTableCellBoundary(view.state.doc, resolvedRange);
    });

    return spansMultipleCells;
  }

  async cancelReview(): Promise<void> {
    captureEvent('review_cancel_requested', {});
    let cancelled = false;
    try {
      await cancelActiveReview();
      cancelled = true;
    } catch (error) {
      console.error('[proof] Failed to cancel review:', error);
    } finally {
      this.reviewInFlight = null;
      captureEvent('review_cancel_completed', { success: cancelled });
    }
  }

  async stopAllReviews(): Promise<{ cancelledSessions: number; unlocked: boolean; lockCount: number }> {
    captureEvent('review_stop_all_requested', {});
    let cancelledSessions = 0;

    try {
      await cancelActiveReview();
    } catch (error) {
      console.error('[proof] Failed to cancel active review executor:', error);
    }

    try {
      const result = await cancelAllAgentSessions();
      cancelledSessions = Number(result?.count ?? 0) || 0;
    } catch (error) {
      console.error('[proof] Failed to cancel agent sessions:', error);
    } finally {
      // Ensure the UI can launch a fresh review even if a prior promise is hung.
      this.reviewInFlight = null;
    }

    // Force-clear review locks that can get stuck during provider outages.
    let lockState = this.reviewLockStatus();
    let unlockAttempts = 0;
    const maxUnlockAttempts = 12;
    while (lockState.locked && unlockAttempts < maxUnlockAttempts) {
      this.reviewUnlock();
      unlockAttempts += 1;
      lockState = this.reviewLockStatus();
    }

    if (lockState.locked) {
      console.warn(
        `[proof] stopAllReviews: review lock still held after ${unlockAttempts} unlock attempts (lockCount=${lockState.lockCount}).`
      );
    } else {
      console.log(
        `[proof] stopAllReviews: cancelledSessions=${cancelledSessions} unlockAttempts=${unlockAttempts}.`
      );
    }

    captureEvent('review_stop_all_completed', {
      cancelled_sessions: cancelledSessions,
      unlocked: !lockState.locked,
      lock_count: lockState.lockCount,
      unlock_attempts: unlockAttempts,
    });

    return {
      cancelledSessions,
      unlocked: !lockState.locked,
      lockCount: lockState.lockCount,
    };
  }

  /**
   * Helper: Highlight and scroll to current match
   */
  private highlightCurrentMatch(): void {
    if (!this.editor || this.currentFindIndex < 0 || this.currentFindIndex >= this.findMatches.length) {
      return;
    }

    const match = this.findMatches[this.currentFindIndex];

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const docSize = view.state.doc.content.size;
      const from = Math.max(0, Math.min(match.from, docSize));
      const to = Math.max(from, Math.min(match.to, docSize));
      const selection = TextSelection.create(view.state.doc, from, to);
      const tr = view.state.tr.setSelection(selection);
      view.dispatch(tr);
      setFindHighlights(view, this.findMatches, this.currentFindIndex);

      this.scrollFindMatchIntoView(view, from);

      console.log('[find] Highlighted match', this.currentFindIndex + 1, 'of', this.findMatches.length);
    });
  }

  private getFindScrollParent(view: EditorView): HTMLElement | null {
    const dom = view.dom as HTMLElement;
    let current: HTMLElement | null =
      (dom.closest('#editor') as HTMLElement)
      || (dom.closest('#editor-container') as HTMLElement)
      || (dom.closest('.editor') as HTMLElement)
      || (dom.closest('#app') as HTMLElement)
      || dom.parentElement;

    while (current) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
          && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }

    return document.scrollingElement as HTMLElement | null;
  }

  private scrollFindMatchIntoView(view: EditorView, pos: number): void {
    const docSize = view.state.doc.content.size;
    const clampedPos = Math.max(0, Math.min(pos, docSize));
    const coords = view.coordsAtPos(clampedPos);
    if (!coords) return;

    const scrollParent = this.getFindScrollParent(view);
    if (!scrollParent) return;

    const scrollingElement = document.scrollingElement as HTMLElement | null;
    const isDocumentScroll = scrollingElement !== null && scrollParent === scrollingElement;
    const viewportHeight = isDocumentScroll ? window.innerHeight : scrollParent.clientHeight;
    const currentScrollTop = isDocumentScroll ? window.scrollY : scrollParent.scrollTop;
    const relativeTop = isDocumentScroll
      ? coords.top
      : coords.top - scrollParent.getBoundingClientRect().top;
    const targetY = currentScrollTop + relativeTop - (viewportHeight / 3);
    const maxScrollTop = isDocumentScroll
      ? Math.max(0, (scrollingElement?.scrollHeight ?? 0) - window.innerHeight)
      : Math.max(0, scrollParent.scrollHeight - scrollParent.clientHeight);
    const top = Math.max(0, Math.min(targetY, maxScrollTop));

    if (isDocumentScroll) {
      window.scrollTo({ top, behavior: 'auto' });
    } else {
      scrollParent.scrollTo({ top, behavior: 'auto' });
    }
  }

  // =====================
  // Input Simulation (Agent-Native Testing)
  // =====================

  /**
   * Set cursor to a specific document position
   * @param position - Document offset position
   * @returns true if successful
   */
  setCursor(position: number): boolean {
    if (!this.editor) {
      console.warn('[setCursor] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const docSize = view.state.doc.content.size;
      const clampedPos = Math.max(0, Math.min(position, docSize));

      try {
        // @ts-expect-error - TextSelection is available
        const TextSelection = view.state.selection.constructor;
        const $pos = view.state.doc.resolve(clampedPos);
        const selection = TextSelection.near($pos);
        const tr = view.state.tr.setSelection(selection);
        view.dispatch(tr);
        view.focus();
        success = true;
        console.log('[setCursor] Set cursor to position:', clampedPos);
      } catch (e) {
        console.error('[setCursor] Error:', e);
      }
    });
    return success;
  }

  /**
   * Set cursor after a specific quote in the document
   * @param quote - Text to find
   * @returns Position after the quote, or null if not found
   */
  setCursorAfterQuote(quote: string): number | null {
    if (!this.editor) {
      console.warn('[setCursorAfterQuote] Editor not initialized');
      return null;
    }

    let resultPos: number | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = resolveQuoteRange(view.state.doc, quote);

      if (range) {
        resultPos = range.to;
        // @ts-expect-error - TextSelection is available
        const TextSelection = view.state.selection.constructor;
        const $pos = view.state.doc.resolve(range.to);
        const selection = TextSelection.near($pos);
        const tr = view.state.tr.setSelection(selection);
        view.dispatch(tr);
        view.focus();
        console.log('[setCursorAfterQuote] Set cursor after:', quote, 'at position:', range.to);
      } else {
        console.warn('[setCursorAfterQuote] Quote not found:', quote);
      }
    });
    return resultPos;
  }

  /**
   * Simulate a keypress in the editor
   * Supports: Enter, Backspace, Delete, Tab, Escape, ArrowUp/Down/Left/Right
   * @param key - Key name to simulate
   * @returns true if the key was handled
   */
  simulateKeypress(key: string): boolean {
    if (!this.editor) {
      console.warn('[simulateKeypress] Editor not initialized');
      return false;
    }

    let handled = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to } = state.selection;

      let tr = state.tr;

      switch (key.toLowerCase()) {
        case 'enter':
        case 'return': {
          // Insert a newline/paragraph break
          // Check if we're in a code block or just need a hard break
          const $from = state.doc.resolve(from);
          const parent = $from.parent;

          if (parent.type.name === 'code_block') {
            // In code block, just insert newline
            tr = tr.insertText('\n', from, to);
          } else {
            // Split the block (create new paragraph)
            const canSplit = tr.doc.resolve(from).parent.type.spec.content?.includes('block');
            if (canSplit || tr.doc.resolve(from).depth > 0) {
              tr = tr.split(from);
            } else {
              // Fallback: insert hard break
              const hardBreak = state.schema.nodes.hard_break;
              if (hardBreak) {
                tr = tr.replaceSelectionWith(hardBreak.create());
              } else {
                tr = tr.insertText('\n', from, to);
              }
            }
          }
          handled = true;
          break;
        }

        case 'backspace': {
          if (from === to && from > 0) {
            // Delete character before cursor
            tr = tr.delete(from - 1, from);
            handled = true;
          } else if (from !== to) {
            // Delete selection
            tr = tr.delete(from, to);
            handled = true;
          }
          break;
        }

        case 'delete': {
          const docSize = state.doc.content.size;
          if (from === to && to < docSize) {
            // Delete character after cursor
            tr = tr.delete(from, from + 1);
            handled = true;
          } else if (from !== to) {
            // Delete selection
            tr = tr.delete(from, to);
            handled = true;
          }
          break;
        }

        case 'tab': {
          // Insert tab character or spaces
          tr = tr.insertText('  ', from, to); // 2 spaces
          handled = true;
          break;
        }

        case 'arrowleft': {
          if (from > 0) {
            // @ts-expect-error - TextSelection is available
            const TextSelection = state.selection.constructor;
            const $pos = state.doc.resolve(from - 1);
            tr = tr.setSelection(TextSelection.near($pos));
            handled = true;
          }
          break;
        }

        case 'arrowright': {
          const docSize = state.doc.content.size;
          if (to < docSize) {
            // @ts-expect-error - TextSelection is available
            const TextSelection = state.selection.constructor;
            const $pos = state.doc.resolve(to + 1);
            tr = tr.setSelection(TextSelection.near($pos));
            handled = true;
          }
          break;
        }

        default:
          console.warn('[simulateKeypress] Unknown key:', key);
          break;
      }

      if (handled && tr.docChanged || tr.selectionSet) {
        view.dispatch(tr);
        console.log('[simulateKeypress] Handled key:', key);
      }
    });

    return handled;
  }

  /**
   * Type text at the current cursor position
   * @param text - Text to insert
   * @returns true if successful
   */
  simulateTyping(text: string): boolean {
    if (!this.editor) {
      console.warn('[simulateTyping] Editor not initialized');
      return false;
    }

    if (!text) return false;

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to } = state.selection;

      const tr = state.tr.insertText(text, from, to);
      view.dispatch(tr);
      success = true;
      console.log('[simulateTyping] Typed:', text);
    });

    return success;
  }

  /**
   * Get current cursor position
   * @returns Current cursor position info
   */
  getCursorPosition(): { from: number; to: number; isCollapsed: boolean } | null {
    if (!this.editor) {
      console.warn('[getCursorPosition] Editor not initialized');
      return null;
    }

    let result: { from: number; to: number; isCollapsed: boolean } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from, to } = view.state.selection;
      result = { from, to, isCollapsed: from === to };
    });

    return result;
  }
}

// Initialize global proof instance
window.proof = new ProofEditorImpl();
const externalAgentHooks = (window as any).__proofExternalAgentHooks;
if (externalAgentHooks && typeof externalAgentHooks === 'object') {
  Object.assign(window.proof, externalAgentHooks);
}

// Minimal browser-agent hook. Only exposed on share pages (/d/:slug).
if (window.location?.pathname?.startsWith('/d/')) {
  (window as any).__PROOF_EDITOR__ = {
    getMarkdown: () => (window.proof.getMarkdownSnapshot()?.content ?? ''),
    insertMarkdown: (markdown: string) => window.proof.insertAtCursor(markdown, 'ai:browser-agent'),
    replaceSelection: (markdown: string) => window.proof.replaceSelection(markdown, 'ai:browser-agent'),
    focus: () => {
      try {
        const el = document.querySelector('#editor .ProseMirror') as HTMLElement | null;
        el?.focus();
      } catch {
        // ignore focus failures
      }
    },
  };
}

// Expose freeform prompt for sidebar
(window as any).sendAgentPrompt = (prompt: string) => {
  // Refresh document content before triggering so the agent sees current state
  try {
    const impl = window.proof as ProofEditorImpl;
    if (impl?.editor) {
      const view = impl.editor.ctx.get(editorViewCtx);
      if (view?.state?.doc) {
        getTriggerService().updateDocumentContent(
          view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
        );
      }
    }
  } catch (e) {
    console.warn('[sendAgentPrompt] Could not refresh doc content:', e);
  }
  getTriggerService().handleFreeformPrompt(prompt);
};

// Expose agent status and debug helpers for the web runtime
(window as any).getAgentStatus = getAgentStatus;
(window as any).getAgentSessionsSummary = getAgentSessionsSummary;
(window as any).cancelAllAgentSessions = cancelAllAgentSessions;
(window as any).validateMarkAnchors = () => window.proof.validateMarkAnchors();
(window as any).debugPlanOnly = (skillId: string, options?: unknown) => window.proof.debugPlanOnly(skillId, options);
(window as any).debugRunSingleFocusArea = (skillId: string, options?: unknown) =>
  window.proof.debugRunSingleFocusArea(skillId, options);
(window as any).debugGetCachedPlan = (skillId: string) => window.proof.debugGetCachedPlan(skillId);
(window as any).debugClearPlanCache = (skillId?: string) => window.proof.debugClearPlanCache(skillId);
(window as any).debugRunOrchestrated = (skillId: string, options?: unknown) =>
  window.proof.debugRunOrchestrated(skillId, options);
(window as any).debugMapTextOffsets = (from: number, to: number) => window.proof.debugMapTextOffsets(from, to);
(window as any).debugDescribeTextblocks = (from: number, to: number) =>
  window.proof.debugDescribeTextblocks({ from, to });
(window as any).debugTextForRange = (from: number, to: number) =>
  window.proof.debugTextForRange({ from, to });
(window as any).debugGetParagraphCandidate = (minWords?: number) =>
  window.proof.debugGetParagraphCandidate(minWords);
(window as any).debugFindBlockByText = (text: string) => window.proof.debugFindBlockByText(text);
(window as any).debugInspectMarksForText = (text: string) => window.proof.debugInspectMarksForText(text);
(window as any).debugResolveRangeWithValidation = (quote: string, range?: MarkRange) =>
  window.proof.debugResolveRangeWithValidation(quote, range);
(window as any).debugAnalyzeReplace = (quote: string, content: string, range?: MarkRange) =>
  window.proof.debugAnalyzeReplace(quote, content, range);

// Comment navigation shortcuts for devtools/testing hooks
(window as any).navigateNextComment = () => window.proof.navigateToNextComment();
(window as any).navigatePrevComment = () => window.proof.navigateToPrevComment();
(window as any).resolveActiveComment = () => window.proof.resolveActiveComment();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[INIT] DOMContentLoaded - calling init()');
    window.proof.init();
  });
} else {
  console.log('[INIT] DOM ready - calling init() immediately');
  window.proof.init();
}

export default window.proof;
