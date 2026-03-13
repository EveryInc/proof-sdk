import type { EditorView } from '@milkdown/kit/prose/view';

const AGENT_CURSOR_META_KEY = 'agentCursor$';

type AgentCursorMeta = {
  cursorPos: number | null;
  selectionFrom: number | null;
  selectionTo: number | null;
  isAnimating: boolean;
  agentLabel?: string | null;
  agentKind?: string | null;
  lastUpdated: number | null;
};

function dispatchAgentCursorMeta(view: EditorView, meta: AgentCursorMeta): void {
  view.dispatch(view.state.tr.setMeta(AGENT_CURSOR_META_KEY, meta));
}

function scrollIntoView(view: EditorView, pos: number): void {
  const node = view.nodeDOM(pos);
  if (node instanceof Element) {
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export function setAgentCursor(view: EditorView, pos: number): void {
  const docSize = view.state.doc.content.size;
  const clampedPos = Math.max(0, Math.min(pos, docSize));
  dispatchAgentCursorMeta(view, {
    cursorPos: clampedPos,
    selectionFrom: null,
    selectionTo: null,
    isAnimating: true,
    lastUpdated: Date.now(),
  });
  scrollIntoView(view, clampedPos);
}

export function setAgentSelection(view: EditorView, from: number, to: number): void {
  const docSize = view.state.doc.content.size;
  const clampedFrom = Math.max(0, Math.min(from, docSize));
  const clampedTo = Math.max(0, Math.min(to, docSize));
  dispatchAgentCursorMeta(view, {
    cursorPos: clampedTo,
    selectionFrom: Math.min(clampedFrom, clampedTo),
    selectionTo: Math.max(clampedFrom, clampedTo),
    isAnimating: true,
    lastUpdated: Date.now(),
  });
  scrollIntoView(view, clampedFrom);
}
