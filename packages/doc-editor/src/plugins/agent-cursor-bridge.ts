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

function getExistingAgentCursorMeta(view: EditorView): Pick<AgentCursorMeta, 'agentLabel' | 'agentKind'> {
  for (const plugin of view.state.plugins) {
    const candidate = plugin as {
      key?: string;
      getState?: (state: typeof view.state) => AgentCursorMeta | null | undefined;
    };
    if (candidate.key !== AGENT_CURSOR_META_KEY || typeof candidate.getState !== 'function') continue;
    const existing = candidate.getState(view.state);
    return {
      agentLabel: existing?.agentLabel ?? null,
      agentKind: existing?.agentKind ?? null,
    };
  }

  return {
    agentLabel: null,
    agentKind: null,
  };
}

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
  const existing = getExistingAgentCursorMeta(view);
  dispatchAgentCursorMeta(view, {
    cursorPos: clampedPos,
    selectionFrom: null,
    selectionTo: null,
    isAnimating: true,
    agentLabel: existing.agentLabel,
    agentKind: existing.agentKind,
    lastUpdated: Date.now(),
  });
  scrollIntoView(view, clampedPos);
}

export function setAgentSelection(view: EditorView, from: number, to: number): void {
  const docSize = view.state.doc.content.size;
  const clampedFrom = Math.max(0, Math.min(from, docSize));
  const clampedTo = Math.max(0, Math.min(to, docSize));
  const existing = getExistingAgentCursorMeta(view);
  dispatchAgentCursorMeta(view, {
    cursorPos: clampedTo,
    selectionFrom: Math.min(clampedFrom, clampedTo),
    selectionTo: Math.max(clampedFrom, clampedTo),
    isAnimating: true,
    agentLabel: existing.agentLabel,
    agentKind: existing.agentKind,
    lastUpdated: Date.now(),
  });
  scrollIntoView(view, clampedFrom);
}
