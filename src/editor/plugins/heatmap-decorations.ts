/**
 * Heat Map Decorations Plugin for Milkdown
 *
 * Visualizes authorship using a continuous colored bar in the left gutter.
 *
 * PERFORMANCE DESIGN:
 * - Segments are calculated relative to DOCUMENT position (not viewport)
 * - On scroll, we just update a CSS transform (GPU accelerated)
 * - Full recalculation only happens on document changes
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import {
  getMarkColor,
  isHuman,
  isAI,
  isSystem,
  type CommentData,
  type DeleteData,
  type InsertData,
  type Mark,
  type MarkKind,
  type ReplaceData,
} from '../../formats/marks.js';
import { resolveAuthoredBlockColor } from './authorship-color';
import { getMarks, marksPluginKey, resolveMarks } from './marks';
import { isMobileTouch } from './mobile-detect';

export type HeatMapMode = 'hidden' | 'subtle' | 'background' | 'full';

export interface HeatMapState {
  mode: HeatMapMode;
}

// Heat map context - stores current mode
export const heatmapCtx = $ctx<HeatMapState, 'heatmap'>({
  mode: 'background'
}, 'heatmap');

const heatmapPluginKey = new PluginKey('heatmap');

type GutterColorResolver = (from: number, to: number) => string | null;

type ResolvedMarkRange = {
  mark: Mark;
  from: number;
  to: number;
};

const DEFAULT_GUTTER_COLOR = '#E5E7EB';

/**
 * Gutter status - determines final color
 * - 'flagged': needs attention (dusty rose) - overrides authorship
 * - 'comment': has discussion (soft gold) - overrides authorship
 * - 'normal': show authorship color (human=mint, AI=lavender)
 */
type GutterStatus = 'flagged' | 'comment' | 'normal';

/**
 * Cached segment data - positions relative to document top
 */
interface CachedSegment {
  docTop: number;      // Position relative to document top (stable)
  height: number;      // Height of the segment
  color: string;       // Color for this segment
}

interface ViewportSegment {
  top: number;         // Position relative to the visible viewport
  height: number;      // Height of the segment
  color: string;       // Color for this segment
}

function resolveGutterMarks(doc: ProseMirrorNode, marks: Mark[]): ResolvedMarkRange[] {
  return resolveMarks(doc, marks).flatMap(mark => {
    const ranges = mark.resolvedRanges ?? (mark.resolvedRange ? [mark.resolvedRange] : []);
    return ranges.map(range => ({ mark, from: range.from, to: range.to }));
  });
}

function groupMarksByKind(marks: ResolvedMarkRange[]): Map<MarkKind, ResolvedMarkRange[]> {
  const map = new Map<MarkKind, ResolvedMarkRange[]>();
  for (const item of marks) {
    const group = map.get(item.mark.kind) ?? [];
    group.push(item);
    map.set(item.mark.kind, group);
  }
  return map;
}

function isActiveMark(mark: Mark): boolean {
  switch (mark.kind) {
    case 'comment': {
      const data = mark.data as CommentData | undefined;
      return !data?.resolved;
    }
    case 'insert': {
      const data = mark.data as InsertData | undefined;
      return data?.status === 'pending';
    }
    case 'delete': {
      const data = mark.data as DeleteData | undefined;
      return data?.status === 'pending';
    }
    case 'replace': {
      const data = mark.data as ReplaceData | undefined;
      return data?.status === 'pending';
    }
    default:
      return true;
  }
}

function blockIntersectsMark(blockFrom: number, blockTo: number, mark: ResolvedMarkRange): boolean {
  return mark.to > blockFrom && mark.from < blockTo;
}

function getAuthoredBlockColor(
  blockFrom: number,
  blockTo: number,
  blockTextLength: number,
  marksByKind: Map<MarkKind, ResolvedMarkRange[]>
): string | null {
  const authored = marksByKind.get('authored') ?? [];

  let human = 0;
  let ai = 0;
  let system = 0;
  let explicitHuman = 0;
  let explicitAI = 0;

  for (const mark of authored) {
    if (!blockIntersectsMark(blockFrom, blockTo, mark)) continue;
    const overlap = Math.max(0, Math.min(blockTo, mark.to) - Math.max(blockFrom, mark.from));
    if (overlap <= 0) continue;
    if (isHuman(mark.mark.by)) {
      human += overlap;
      explicitHuman += overlap;
    } else if (isAI(mark.mark.by)) {
      ai += overlap;
      explicitAI += overlap;
    } else if (isSystem(mark.mark.by)) {
      system += overlap;
    }
  }

  const unmarked = Math.max(0, blockTextLength - (human + ai + system));
  ai += unmarked;
  return resolveAuthoredBlockColor({ human, ai, system, explicitHuman, explicitAI });
}

/**
 * Determine the gutter status for a block
 * Priority: flagged > comment > normal
 * Flagged and comment override authorship colors entirely
 */
function getBlockStatus(
  blockFrom: number,
  blockTo: number,
  marksByKind: Map<MarkKind, ResolvedMarkRange[]>
): GutterStatus {
  // Check for flagged marks (highest priority)
  const flaggedMarks = marksByKind.get('flagged');
  if (flaggedMarks && flaggedMarks.length > 0) {
    const hasFlagged = flaggedMarks.some(mark => blockIntersectsMark(blockFrom, blockTo, mark));
    if (hasFlagged) return 'flagged';
  }

  // Check for unresolved comments
  const commentMarks = marksByKind.get('comment');
  if (commentMarks && commentMarks.length > 0) {
    const hasActiveComment = commentMarks.some(mark => {
      if (!blockIntersectsMark(blockFrom, blockTo, mark)) return false;
      // Only show comment color for unresolved comments
      return isActiveMark(mark.mark);
    });
    if (hasActiveComment) return 'comment';
  }

  return 'normal';
}

/**
 * Get the gutter color for a block
 *
 * 4 colors total:
 * - Human (soft mint) - human-authored content
 * - AI (soft lavender) - AI-authored content
 * - Mixed (purple) - block contains both human and AI authored text
 * - System (blue) - system-authored content
 * - Flagged (dusty rose) - needs attention, overrides authorship
 * - Comment (soft gold) - has discussion, overrides authorship
 */
function getBlockColor(
  doc: ProseMirrorNode,
  blockFrom: number,
  blockTo: number,
  marksByKind: Map<MarkKind, ResolvedMarkRange[]>
): string | null {
  const status = getBlockStatus(blockFrom, blockTo, marksByKind);

  // Flagged and comment override authorship - universal colors
  if (status === 'flagged') {
    return getMarkColor('flagged');
  }
  if (status === 'comment') {
    return getMarkColor('comment');
  }

  // Normal status - show authorship color
  const blockTextLength = doc.textBetween(blockFrom, blockTo, '\n', '\n').length;
  const authoredColor = getAuthoredBlockColor(blockFrom, blockTo, blockTextLength, marksByKind);
  if (authoredColor) return authoredColor;

  return DEFAULT_GUTTER_COLOR;
}

/**
 * Collect all content blocks with their positions and colors
 */
function collectBlocks(doc: ProseMirrorNode, resolveColor: GutterColorResolver): Array<{ from: number; to: number; color: string }> {
  // If document has no text content at all, return empty (no gutter)
  if (!doc.textContent.trim()) {
    return [];
  }

  const blocks: Array<{ from: number; to: number; color: string }> = [];
  const visited = new Set<number>();

  doc.descendants((node, pos) => {
    if (!node.isTextblock || visited.has(pos)) return true;

    visited.add(pos);
    const from = pos;
    const to = pos + node.nodeSize;
    const color = resolveColor(from, to);
    if (color) {
      blocks.push({ from, to, color });
    }
    return true;
  });

  return blocks;
}

/**
 * Find the DOM element for a block position
 */
function findBlockElement(view: EditorView, block: { from: number; to: number }): HTMLElement | null {
  try {
    const insidePos = Math.min(block.from + 1, block.to - 1);
    const domAtPos = view.domAtPos(insidePos);
    let domNode: Node | null = domAtPos.node;

    if (domNode.nodeType === Node.TEXT_NODE) {
      domNode = domNode.parentElement;
    }

    const milkdownEl = view.dom;

    while (domNode && domNode !== milkdownEl) {
      if (domNode instanceof HTMLElement) {
        const tagName = domNode.tagName.toUpperCase();

        if (tagName === 'PRE') break;
        if (tagName === 'CODE') {
          const parent = domNode.parentElement;
          if (parent?.tagName.toUpperCase() === 'PRE') {
            domNode = parent;
            break;
          }
        }
        if (tagName === 'P' || tagName === 'H1' || tagName === 'H2' ||
            tagName === 'H3' || tagName === 'H4' || tagName === 'H5' || tagName === 'H6' ||
            tagName === 'LI' || tagName === 'BLOCKQUOTE' || tagName === 'DIV') {
          break;
        }

        const display = window.getComputedStyle(domNode).display;
        if (display === 'block' || display === 'list-item') {
          break;
        }
      }
      domNode = domNode.parentNode;
    }

    if (domNode instanceof HTMLElement && domNode !== milkdownEl) {
      return domNode;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Calculate segment positions relative to document top
 * This is the expensive operation - only do it when document changes
 */
function calculateSegments(
  view: EditorView,
  marksByKind: Map<MarkKind, ResolvedMarkRange[]>,
  mode: HeatMapMode
): CachedSegment[] {
  if (mode === 'hidden') return [];

  const resolveColor = (from: number, to: number) => (
    getBlockColor(view.state.doc, from, to, marksByKind)
  );

  const blocks = collectBlocks(view.state.doc, resolveColor);
  if (blocks.length === 0) return [];

  // Get the document's top position (reference point)
  const editorRect = view.dom.getBoundingClientRect();
  const docTop = editorRect.top + window.scrollY; // Document-relative top

  const segments: CachedSegment[] = [];

  for (const block of blocks) {
    const element = findBlockElement(view, block);
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    // Calculate position relative to document (not viewport)
    const relativeTop = rect.top + window.scrollY - docTop;
    const height = rect.height;
    const color = block.color;

    segments.push({ docTop: relativeTop, height, color });
  }

  // Sort by position
  segments.sort((a, b) => a.docTop - b.docTop);

  return segments;
}

function calculateViewportSegments(
  view: EditorView,
  marksByKind: Map<MarkKind, ResolvedMarkRange[]>,
  mode: HeatMapMode
): ViewportSegment[] {
  if (mode === 'hidden') return [];

  const resolveColor = (from: number, to: number) => (
    getBlockColor(view.state.doc, from, to, marksByKind)
  );

  const blocks = collectBlocks(view.state.doc, resolveColor);
  if (blocks.length === 0) return [];

  const segments: ViewportSegment[] = [];
  for (const block of blocks) {
    const element = findBlockElement(view, block);
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    segments.push({ top: rect.top, height: rect.height, color: block.color });
  }

  segments.sort((a, b) => a.top - b.top);

  const deduped: ViewportSegment[] = [];
  for (const segment of segments) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(last.top - segment.top) > 0.5 || Math.abs(last.height - segment.height) > 0.5 || last.color !== segment.color) {
      deduped.push(segment);
    }
  }

  return deduped;
}

function buildViewportGutterDOM(gutterEl: HTMLElement, segments: ViewportSegment[]): void {
  gutterEl.innerHTML = '';

  if (segments.length === 0) {
    return;
  }

  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

  const firstSeg = segments[0];
  if (firstSeg.top > 0) {
    const div = document.createElement('div');
    div.className = 'gutter-segment';
    div.style.position = 'absolute';
    div.style.top = '0px';
    div.style.left = '0px';
    div.style.right = '0px';
    div.style.height = `${Math.min(viewportHeight, firstSeg.top)}px`;
    div.style.backgroundColor = firstSeg.color;
    gutterEl.appendChild(div);
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];
    const segTop = Math.max(0, seg.top);
    const segBottom = nextSeg ? nextSeg.top : Math.min(viewportHeight, seg.top + seg.height);

    if (segBottom <= 0 || segTop >= viewportHeight) continue;

    const div = document.createElement('div');
    div.className = 'gutter-segment';
    div.style.position = 'absolute';
    div.style.top = `${segTop}px`;
    div.style.left = '0px';
    div.style.right = '0px';
    div.style.height = `${Math.max(1, Math.min(viewportHeight, segBottom) - segTop)}px`;
    div.style.backgroundColor = seg.color;
    gutterEl.appendChild(div);
  }

  const lastSeg = segments[segments.length - 1];
  const lastBottom = lastSeg.top + lastSeg.height;
  if (lastBottom < viewportHeight) {
    const div = document.createElement('div');
    div.className = 'gutter-segment';
    div.style.position = 'absolute';
    div.style.top = `${Math.max(0, lastBottom)}px`;
    div.style.left = '0px';
    div.style.right = '0px';
    div.style.height = `${Math.max(1, viewportHeight - Math.max(0, lastBottom))}px`;
    div.style.backgroundColor = lastSeg.color;
    gutterEl.appendChild(div);
  }
}

/**
 * Render the gutter segments into DOM
 * Creates DOM elements positioned relative to a container that will be transformed
 */
function buildGutterDOM(gutterEl: HTMLElement, segments: CachedSegment[]): void {
  gutterEl.innerHTML = '';

  // Empty document - no gutter at all
  if (segments.length === 0) {
    return;
  }

  // First segment: from top to first block (use first block's color)
  const firstSeg = segments[0];
  if (firstSeg.docTop > 0) {
    const div = document.createElement('div');
    div.className = 'gutter-segment';
    div.style.position = 'absolute';
    div.style.top = '0px';
    div.style.left = '0px';
    div.style.right = '0px';
    div.style.height = `${firstSeg.docTop}px`;
    div.style.backgroundColor = firstSeg.color;
    gutterEl.appendChild(div);
  }

  // Content segments - each extends to the next block (gap filling with current color)
  // Last segment stops at its own bottom (doesn't extend past content)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];

    // For last segment, just use its own height. For others, extend to next block.
    const segBottom = nextSeg ? nextSeg.docTop : (seg.docTop + seg.height);

    const div = document.createElement('div');
    div.className = 'gutter-segment';
    div.style.position = 'absolute';
    div.style.top = `${seg.docTop}px`;
    div.style.left = '0px';
    div.style.right = '0px';
    div.style.height = `${Math.max(1, segBottom - seg.docTop)}px`;
    div.style.backgroundColor = seg.color;
    gutterEl.appendChild(div);
  }
}

/**
 * Update gutter position on scroll (fast - just CSS transform)
 */
function updateGutterScroll(gutterEl: HTMLElement, scrollY: number): void {
  gutterEl.style.transform = `translateY(${-scrollY}px)`;
}

function syncGutterViewportFrame(gutterEl: HTMLElement, directViewportRender: boolean): void {
  if (!directViewportRender) {
    gutterEl.style.top = '0px';
    gutterEl.style.left = '0px';
    gutterEl.style.bottom = '0';
    gutterEl.style.height = '';
    return;
  }

  const vv = window.visualViewport;
  const offsetTop = vv?.offsetTop ?? 0;
  const offsetLeft = vv?.offsetLeft ?? 0;
  const viewportHeight = vv?.height ?? window.innerHeight;

  gutterEl.style.top = `${Math.max(0, offsetTop)}px`;
  gutterEl.style.left = `${Math.max(0, offsetLeft)}px`;
  gutterEl.style.bottom = 'auto';
  gutterEl.style.height = `${Math.max(0, viewportHeight)}px`;
}

export const heatmapPlugin = $prose((ctx) => {
  return new Plugin({
    key: heatmapPluginKey,

    view(editorView) {
      const useDirectViewportRender = isMobileTouch();
      // Temporary prod hotfix: the mobile direct-render path recalculates viewport segments on scroll,
      // which is too expensive on long docs and can make scrolling feel laggy. Hide the gutter on
      // mobile until we have a performant viewport-aware implementation.
      const disableMobileGutter = useDirectViewportRender;

      // Cached data (desktop path only)
      let cachedSegments: CachedSegment[] = [];
      let needsRebuild = true;
      let renderRafId: number | null = null;

      // Get or create gutter container
      const gutterEl = document.getElementById('provenance-gutter');
      if (!gutterEl) return { update() {}, destroy() {} };

      gutterEl.style.position = 'fixed';
      gutterEl.style.overflow = 'hidden';
      gutterEl.style.display = disableMobileGutter ? 'none' : '';
      gutterEl.style.willChange = useDirectViewportRender ? 'auto' : 'transform';
      syncGutterViewportFrame(gutterEl, useDirectViewportRender);

      if (disableMobileGutter) {
        gutterEl.innerHTML = '';
        return {
          update() {
            gutterEl.style.display = 'none';
            gutterEl.innerHTML = '';
          },
          destroy() {
            gutterEl.style.display = '';
            gutterEl.innerHTML = '';
          },
        };
      }

      // Create inner container for segments
      let innerContainer = gutterEl.querySelector('.gutter-inner') as HTMLElement;
      if (!innerContainer) {
        innerContainer = document.createElement('div');
        innerContainer.className = 'gutter-inner';
        innerContainer.style.position = 'absolute';
        innerContainer.style.top = '0';
        innerContainer.style.left = '0';
        innerContainer.style.right = '0';
        gutterEl.appendChild(innerContainer);
      }
      innerContainer.style.willChange = useDirectViewportRender ? 'auto' : 'transform';

      const getMarksByKind = () => {
        const marksState = marksPluginKey.getState(editorView.state);
        if (!marksState) return null;
        const allMarks = getMarks(editorView.state);
        const resolvedMarks = resolveGutterMarks(editorView.state.doc, allMarks);
        return groupMarksByKind(resolvedMarks);
      };

      const renderDirectViewport = () => {
        syncGutterViewportFrame(gutterEl, true);
        const heatmapState = ctx.get(heatmapCtx.key);
        const marksByKind = getMarksByKind();
        if (!marksByKind) return;
        const viewportSegments = calculateViewportSegments(editorView, marksByKind, heatmapState.mode);
        buildViewportGutterDOM(innerContainer, viewportSegments);
        innerContainer.style.transform = '';
        needsRebuild = false;
      };

      const rebuildGutter = () => {
        if (useDirectViewportRender) {
          renderDirectViewport();
          return;
        }

        const heatmapState = ctx.get(heatmapCtx.key);
        const marksByKind = getMarksByKind();
        if (!marksByKind) return;

        cachedSegments = calculateSegments(editorView, marksByKind, heatmapState.mode);
        buildGutterDOM(innerContainer, cachedSegments);
        needsRebuild = false;
      };

      const updateScroll = () => {
        if (useDirectViewportRender) return;

        syncGutterViewportFrame(gutterEl, false);
        const editorRect = editorView.dom.getBoundingClientRect();
        const scrollOffset = -editorRect.top;
        updateGutterScroll(innerContainer, scrollOffset);
      };

      const runRender = (forceRebuild: boolean = false) => {
        if (forceRebuild) needsRebuild = true;
        if (useDirectViewportRender) {
          renderDirectViewport();
          return;
        }
        if (needsRebuild) {
          rebuildGutter();
        }
        updateScroll();
      };

      const scheduleRender = (forceRebuild: boolean = false) => {
        if (forceRebuild) needsRebuild = true;
        if (renderRafId !== null) return;
        renderRafId = requestAnimationFrame(() => {
          renderRafId = null;
          runRender();
        });
      };

      // Initial build
      runRender(true);

      // Scroll polling (desktop: fast transform updates; mobile: direct viewport re-render)
      let scrollPollId: number | null = null;
      let lastEditorTop: number | null = null;
      let lastViewportOffsetTop: number | null = null;
      let lastViewportHeight: number | null = null;

      const pollScroll = () => {
        const editorRect = editorView.dom.getBoundingClientRect();
        const currentTop = editorRect.top;
        const vv = window.visualViewport;
        const currentViewportOffsetTop = vv?.offsetTop ?? 0;
        const currentViewportHeight = vv?.height ?? window.innerHeight;

        if (useDirectViewportRender) {
          if (
            lastEditorTop === null
            || Math.abs(currentTop - lastEditorTop) > 0.5
            || lastViewportOffsetTop === null
            || Math.abs(currentViewportOffsetTop - lastViewportOffsetTop) > 0.5
            || lastViewportHeight === null
            || Math.abs(currentViewportHeight - lastViewportHeight) > 0.5
          ) {
            scheduleRender(true);
          }
        } else if (lastEditorTop !== null && Math.abs(currentTop - lastEditorTop) > 0.5) {
          updateScroll();
        }

        lastEditorTop = currentTop;
        lastViewportOffsetTop = currentViewportOffsetTop;
        lastViewportHeight = currentViewportHeight;
        scrollPollId = requestAnimationFrame(pollScroll);
      };

      scrollPollId = requestAnimationFrame(pollScroll);

      // Resize / visual viewport handlers
      let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
      const onResize = () => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          scheduleRender(true);
        }, 100);
      };
      const onViewportChange = () => {
        scheduleRender(true);
      };
      window.addEventListener('resize', onResize);
      window.visualViewport?.addEventListener('resize', onViewportChange);
      window.visualViewport?.addEventListener('scroll', onViewportChange);

      return {
        update() {
          scheduleRender(true);
        },
        destroy() {
          if (scrollPollId !== null) cancelAnimationFrame(scrollPollId);
          if (renderRafId !== null) cancelAnimationFrame(renderRafId);
          if (resizeTimeout !== null) clearTimeout(resizeTimeout);
          window.removeEventListener('resize', onResize);
          window.visualViewport?.removeEventListener('resize', onViewportChange);
          window.visualViewport?.removeEventListener('scroll', onViewportChange);
        },
      };
    },
  });
});

export default heatmapPlugin;
