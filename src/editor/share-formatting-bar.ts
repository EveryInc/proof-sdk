/**
 * Share-mode formatting bar — right-side vertical rail (desktop) / bottom dock (mobile).
 *
 * Renders heading, bold, italic, link, list, blockquote, and code block buttons
 * using monospace text labels for typographic controls and inline Lucide SVGs
 * for structural controls. All formatting dispatches ProseMirror commands via
 * the existing Milkdown schema — no new command layer.
 */

import { toggleMark, setBlockType, wrapIn } from '@milkdown/kit/prose/commands';
import { wrapInList, liftListItem } from '@milkdown/kit/prose/schema-list';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { MarkType, NodeType } from '@milkdown/kit/prose/model';

// ---------------------------------------------------------------------------
// Lucide SVG icons (MIT license) — inlined to avoid adding a dependency.
// 24×24 viewBox, stroke-based, rendered at 18×18 with stroke-width 1.9.
// ---------------------------------------------------------------------------

const ICON_ATTRS = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

const ICONS: Record<string, string> = {
  link: `<svg ${ICON_ATTRS}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  list: `<svg ${ICON_ATTRS}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  listOrdered: `<svg ${ICON_ATTRS}><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>`,
  quote: `<svg ${ICON_ATTRS}><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z"/></svg>`,
  code: `<svg ${ICON_ATTRS}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
};

// ---------------------------------------------------------------------------
// Button definitions
// ---------------------------------------------------------------------------

interface ButtonDef {
  id: string;
  /** Text label (for typographic controls) or null (for icon controls). */
  label: string | null;
  /** Lucide icon key, or null for text-only buttons. */
  icon: string | null;
  /** Extra inline style applied to the button element. */
  style?: string;
  title: string;
  group: number; // 0 = headings, 1 = inline, 2 = block
}

type SelectionRange = { from: number; to: number };

const BUTTONS: ButtonDef[] = [
  { id: 'h1', label: 'H1', icon: null, title: 'Heading 1', group: 0 },
  { id: 'h2', label: 'H2', icon: null, title: 'Heading 2', group: 0 },
  { id: 'h3', label: 'H3', icon: null, title: 'Heading 3', group: 0 },
  { id: 'bold', label: 'B', icon: null, style: 'font-weight:600', title: 'Bold', group: 1 },
  { id: 'italic', label: 'I', icon: null, style: 'font-style:italic', title: 'Italic', group: 1 },
  { id: 'link', label: null, icon: 'link', title: 'Link', group: 1 },
  { id: 'bullet_list', label: null, icon: 'list', title: 'Bullet list', group: 2 },
  { id: 'ordered_list', label: null, icon: 'listOrdered', title: 'Ordered list', group: 2 },
  { id: 'blockquote', label: null, icon: 'quote', title: 'Blockquote', group: 2 },
  { id: 'code_block', label: null, icon: 'code', title: 'Code block', group: 2 },
];

const CONTEXTUAL_BUTTON_IDS = new Set(['bold', 'italic', 'link']);
const CONTEXTUAL_BAR_ID = 'share-contextual-formatting-bar';
const CONTEXTUAL_BODY_ATTR = 'shareContextualToolbarVisible';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

const TOP_FIXED_OVERLAY_IDS = ['share-banner', 'readonly-banner', 'review-lock-banner', 'error-banner'] as const;

function getTopViewportInset(margin: number): number {
  let inset = margin;
  for (const id of TOP_FIXED_OVERLAY_IDS) {
    const element = document.getElementById(id);
    if (!element) continue;
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= 0) continue;
    inset = Math.max(inset, Math.ceil(rect.bottom + margin));
  }
  return inset;
}

function isDesktopContextualEnabled(): boolean {
  return !window.matchMedia('(max-width: 999px)').matches;
}

function getSelectionRange(view: EditorView): SelectionRange | null {
  const { from, to } = view.state.selection;
  if (from === to) return null;
  return { from, to };
}

function getAnchorBox(view: EditorView, range: SelectionRange) {
  const from = view.coordsAtPos(range.from);
  const to = view.coordsAtPos(range.to);
  return {
    top: Math.min(from.top, to.top),
    bottom: Math.max(from.bottom, to.bottom),
    left: Math.min(from.left, to.left),
    right: Math.max(from.right, to.right),
  };
}

function positionContextualBar(bar: HTMLElement, view: EditorView, range: SelectionRange): void {
  try {
    const anchorBox = getAnchorBox(view, range);
    if (typeof bar.getBoundingClientRect !== 'function') return;
    if (typeof view.dom.getBoundingClientRect !== 'function') return;

    const barRect = bar.getBoundingClientRect();
    const editorRect = view.dom.getBoundingClientRect();
    const margin = 12;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const safeTop = getTopViewportInset(margin);
    const maxTop = Math.max(safeTop, viewportH - barRect.height - margin);
    const center = (anchorBox.left + anchorBox.right) / 2;

    const aboveTop = anchorBox.top - barRect.height - 8;
    const belowTop = anchorBox.bottom + 8;
    const hasRoomAbove = aboveTop >= safeTop;
    const hasRoomBelow = belowTop + barRect.height <= viewportH - margin;
    const top = hasRoomAbove ? aboveTop : (hasRoomBelow ? belowTop : clamp(anchorBox.top, safeTop, maxTop));

    const left = clamp(
      center - barRect.width / 2,
      margin,
      viewportW - barRect.width - margin,
    );

    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;

    if (!editorRect.width || left < editorRect.left || left > editorRect.right) {
      bar.style.left = `${clamp(left, editorRect.left + 4, editorRect.right - barRect.width - 4)}px`;
    }
  } catch {
    // Ignore transient coordinate errors.
  }
}

function createButton(
  def: ButtonDef,
  onCommand: (id: string) => void,
): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = def.title;
  button.setAttribute('aria-label', def.title);
  button.dataset.command = def.id;

  if (def.label) {
    button.textContent = def.label;
    if (def.style) button.style.cssText = def.style;
  } else if (def.icon && ICONS[def.icon]) {
    button.innerHTML = ICONS[def.icon];
  }

  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    onCommand(def.id);
  });

  return button;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function markActive(view: EditorView, type: MarkType): boolean {
  const { from, $from, to, empty } = view.state.selection;
  if (empty) {
    return !!type.isInSet(view.state.storedMarks || $from.marks());
  }
  return view.state.doc.rangeHasMark(from, to, type);
}

function blockActive(view: EditorView, type: NodeType, attrs?: Record<string, unknown>): boolean {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === type) {
      if (!attrs) return true;
      return Object.entries(attrs).every(([k, v]) => node.attrs[k] === v);
    }
  }
  // Check the immediate parent (depth 0 block)
  if ($from.parent.type === type) {
    if (!attrs) return true;
    return Object.entries(attrs).every(([k, v]) => $from.parent.attrs[k] === v);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function toggleHeading(view: EditorView, level: number): void {
  const { $from } = view.state.selection;
  const parent = $from.parent;
  if (parent.type.name === 'heading' && parent.attrs.level === level) {
    setBlockType(view.state.schema.nodes.paragraph)(view.state, view.dispatch);
  } else {
    setBlockType(view.state.schema.nodes.heading, { level })(view.state, view.dispatch);
  }
  view.focus();
}

function toggleList(view: EditorView, listType: 'bullet_list' | 'ordered_list'): void {
  const { state, dispatch } = view;
  const listNodeType = state.schema.nodes[listType];
  const listItemType = state.schema.nodes.list_item;
  if (!listNodeType || !listItemType) return;

  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === listNodeType) {
      liftListItem(listItemType)(state, dispatch);
      view.focus();
      return;
    }
  }
  wrapInList(listNodeType)(state, dispatch);
  view.focus();
}

function handleLink(view: EditorView): void {
  const { state } = view;
  const { from, to } = state.selection;
  const linkType = state.schema.marks.link;
  if (!linkType) return;

  if (markActive(view, linkType)) {
    view.dispatch(state.tr.removeMark(from, to, linkType));
    view.focus();
    return;
  }

  const href = window.prompt('URL:');
  if (!href) { view.focus(); return; }

  view.focus();
  const tr = view.state.tr;
  if (from === to) {
    const linkMark = linkType.create({ href });
    tr.insertText('link', from);
    tr.addMark(from, from + 4, linkMark);
  } else {
    tr.addMark(from, to, linkType.create({ href }));
  }
  view.dispatch(tr);
}

function handleCommand(view: EditorView, id: string): void {
  if (!view.editable) return;

  switch (id) {
    case 'h1': toggleHeading(view, 1); break;
    case 'h2': toggleHeading(view, 2); break;
    case 'h3': toggleHeading(view, 3); break;
    case 'bold': toggleMark(view.state.schema.marks.strong)(view.state, view.dispatch); view.focus(); break;
    case 'italic': toggleMark(view.state.schema.marks.emphasis)(view.state, view.dispatch); view.focus(); break;
    case 'link': handleLink(view); break;
    case 'bullet_list': toggleList(view, 'bullet_list'); break;
    case 'ordered_list': toggleList(view, 'ordered_list'); break;
    case 'blockquote': wrapIn(view.state.schema.nodes.blockquote)(view.state, view.dispatch); view.focus(); break;
    case 'code_block': setBlockType(view.state.schema.nodes.code_block)(view.state, view.dispatch); view.focus(); break;
  }
}

// ---------------------------------------------------------------------------
// Active state updater
// ---------------------------------------------------------------------------

function updateActiveStates(view: EditorView, buttons: Map<string, HTMLElement>): void {
  const { schema } = view.state;

  for (const [id, el] of buttons) {
    let active = false;
    switch (id) {
      case 'h1': active = blockActive(view, schema.nodes.heading, { level: 1 }); break;
      case 'h2': active = blockActive(view, schema.nodes.heading, { level: 2 }); break;
      case 'h3': active = blockActive(view, schema.nodes.heading, { level: 3 }); break;
      case 'bold': active = markActive(view, schema.marks.strong); break;
      case 'italic': active = markActive(view, schema.marks.emphasis); break;
      case 'link': active = markActive(view, schema.marks.link); break;
      case 'bullet_list': active = blockActive(view, schema.nodes.bullet_list); break;
      case 'ordered_list': active = blockActive(view, schema.nodes.ordered_list); break;
      case 'blockquote': active = blockActive(view, schema.nodes.blockquote); break;
      case 'code_block': active = blockActive(view, schema.nodes.code_block); break;
    }
    el.classList.toggle('active', active);
  }
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

export function createShareFormattingBar(
  getView: () => EditorView | null,
): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'share-formatting-bar';

  const buttonEls = new Map<string, HTMLElement>();
  const contextualButtonEls = new Map<string, HTMLElement>();
  let lastGroup = -1;

  const contextualBar = document.createElement('div');
  contextualBar.id = CONTEXTUAL_BAR_ID;

  let rafHandle: number | null = null;
  let lastContextualRange: SelectionRange | null = null;
  let isContextualVisible = false;
  let isEditable = true;

  const setContextualBarVisible = (visible: boolean): void => {
    isContextualVisible = visible;
    contextualBar.classList.toggle('visible', visible);
    contextualBar.style.display = visible ? 'flex' : 'none';
    if (visible) {
      document.body.dataset[CONTEXTUAL_BODY_ATTR] = 'true';
      return;
    }
    if (document.body.dataset[CONTEXTUAL_BODY_ATTR] === 'true') {
      delete document.body.dataset[CONTEXTUAL_BODY_ATTR];
    }
  };

  const hideContextualBar = (): void => {
    lastContextualRange = null;
    setContextualBarVisible(false);
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  };

  const updateActive = () => {
    const view = getView();
    if (!view) return;
    updateActiveStates(view, buttonEls);
    updateActiveStates(view, contextualButtonEls);
  };

  const runCommand = (id: string): void => {
    const view = getView();
    if (!view) return;
    handleCommand(view, id);
    if (id === 'bold' || id === 'italic' || id === 'link') {
      hideContextualBar();
    }
    updateActive();
  };

  const refreshContextualBar = () => {
    if (!isDesktopContextualEnabled()) {
      hideContextualBar();
      return;
    }

    const view = getView();
    if (!view) {
      hideContextualBar();
      return;
    }

    if (!view.editable || !bar.classList.contains('visible') || !isEditable) {
      hideContextualBar();
      return;
    }

    const range = getSelectionRange(view);
    if (!range) {
      hideContextualBar();
      return;
    }

    lastContextualRange = range;
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }

    rafHandle = window.requestAnimationFrame(() => {
      positionContextualBar(contextualBar, view, range);
      setContextualBarVisible(true);
      updateActive();
      rafHandle = null;
    });
  };

  const handleSelectionChange = () => {
    updateActive();
    refreshContextualBar();
  };

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (!target) return;

    const view = getView();
    const editor = view?.dom;
    if (contextualBar.contains(target) || bar.contains(target) || (editor && editor.contains(target))) {
      return;
    }

    hideContextualBar();
  };

  const handleScrollOrResize = () => {
    if (!isContextualVisible || !lastContextualRange) return;
    const view = getView();
    if (!view) return;
    positionContextualBar(contextualBar, view, lastContextualRange);
  };

  for (const def of BUTTONS) {
    if (lastGroup !== -1 && def.group !== lastGroup) {
      const divider = document.createElement('span');
      divider.className = 'fmt-divider';
      divider.setAttribute('aria-hidden', 'true');
      bar.appendChild(divider);
    }
    lastGroup = def.group;

    const btn = createButton(def, runCommand);
    bar.appendChild(btn);
    buttonEls.set(def.id, btn);

    if (CONTEXTUAL_BUTTON_IDS.has(def.id)) {
      const contextualButton = createButton(def, runCommand);
      contextualBar.appendChild(contextualButton);
      contextualButtonEls.set(def.id, contextualButton);
    }
  }

  contextualBar.style.display = 'none';
  document.body.appendChild(contextualBar);

  // Active-state + selection tracking via DOM events (avoids ProseMirror plugin
  // reconfigure which breaks collab state).
  const refresh = () => {
    const view = getView();
    if (view) {
      updateActiveStates(view, buttonEls);
      updateActiveStates(view, contextualButtonEls);
    }
  };
  document.addEventListener('selectionchange', refresh);
  document.addEventListener('keyup', refresh);

  document.addEventListener('selectionchange', handleSelectionChange);
  document.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('scroll', handleScrollOrResize, true);
  window.addEventListener('resize', handleScrollOrResize);

  // Store cleanup handle
  (bar as any).__fmtCleanup = () => {
    document.removeEventListener('selectionchange', handleSelectionChange);
    document.removeEventListener('selectionchange', refresh);
    document.removeEventListener('keyup', refresh);
    document.removeEventListener('pointerdown', handlePointerDown);
    window.removeEventListener('scroll', handleScrollOrResize, true);
    window.removeEventListener('resize', handleScrollOrResize);
    hideContextualBar();
    contextualBar.remove();
    if (document.body.dataset[CONTEXTUAL_BODY_ATTR] === 'true') {
      delete document.body.dataset[CONTEXTUAL_BODY_ATTR];
    }
    if (rafHandle !== null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  };

  (bar as any).__fmtSetEditable = (value: boolean) => {
    isEditable = Boolean(value);
    if (!isEditable) {
      hideContextualBar();
    }
  };

  refresh();

  return bar;
}
