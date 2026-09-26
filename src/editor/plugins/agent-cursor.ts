/**
 * Agent Cursor Plugin for Milkdown
 *
 * Shows a visible cursor and selection for the AI agent that the user can see.
 * The agent cursor is distinct from the user's cursor (different color/style).
 *
 * DESIGN:
 * - Agent cursor is shown as a vertical bar (like a text cursor) in blue
 * - Agent selection is shown as a highlighted range in light blue
 * - Cursor movement is animated so the user can follow along
 * - Agent cursor/selection is separate from user's cursor/selection
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import {
  createAgentFaceElement,
  type AgentFamily,
  resolveAgentFamily,
} from '../../ui/agent-identity-icon';

export interface ThinkingChainEntry {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'error';
  content?: string;
  toolName?: string;
  timestamp: number;
}

export interface AgentCursorState {
  // Agent cursor position (null = hidden)
  cursorPos: number | null;
  // Agent selection range (null = no selection)
  selectionFrom: number | null;
  selectionTo: number | null;
  // Animation state
  isAnimating: boolean;
  // Agent identity
  agentLabel: string | null;
  agentKind: AgentFamily | null;
  // Last update timestamp
  lastUpdated: number | null;
  // Thinking chain display
  thinkingChain: ThinkingChainEntry[];
  isThinking: boolean;
  currentAction: string | null;
}

// Initial state
const initialState: AgentCursorState = {
  cursorPos: null,
  selectionFrom: null,
  selectionTo: null,
  isAnimating: false,
  agentLabel: null,
  agentKind: null,
  lastUpdated: null,
  thinkingChain: [],
  isThinking: false,
  currentAction: null,
};

// Agent cursor context - stores current state
export const agentCursorCtx = $ctx<AgentCursorState, 'agentCursor'>(
  initialState,
  'agentCursor'
);

const agentCursorPluginKey = new PluginKey<AgentCursorState>('agentCursor');

/**
 * Create the cursor decoration (a widget at the cursor position)
 */
function createCursorDecoration(pos: number, label: string | null, kind: AgentCursorState['agentKind']): Decoration {
  const cursorWidget = document.createElement('span');
  cursorWidget.className = 'agent-cursor';
  cursorWidget.setAttribute('data-agent-cursor', 'true');

  // Create the cursor bar
  const cursorBar = document.createElement('span');
  cursorBar.className = 'agent-cursor-bar';
  cursorWidget.appendChild(cursorBar);

  if (label) {
    const badge = document.createElement('span');
    badge.className = `agent-cursor-badge${kind ? ` agent-cursor-badge--${kind}` : ''}`;

    const icon = createAgentFaceElement({
      family: kind ?? 'purple',
      size: 14,
      title: `${label} icon`,
      wrapperClassName: 'agent-cursor-badge__icon',
      className: 'agent-cursor-badge__icon-svg',
    });

    const text = document.createElement('span');
    text.textContent = label;
    badge.replaceChildren(icon, text);
    cursorWidget.appendChild(badge);
  }

  return Decoration.widget(pos, cursorWidget, {
    key: 'agent-cursor',
    side: 0, // Insert before content at this position
  });
}

/**
 * Create selection decorations (inline highlighting)
 */
function createSelectionDecorations(from: number, to: number): Decoration[] {
  return [
    Decoration.inline(from, to, {
      class: 'agent-selection',
    }),
  ];
}

/**
 * Build decoration set from agent cursor state
 */
function buildDecorations(state: AgentCursorState, doc: import('@milkdown/kit/prose/model').Node): DecorationSet {
  const decorations: Decoration[] = [];
  const docSize = doc.content.size;

  // Add selection decorations if there's an active selection
  if (state.selectionFrom !== null && state.selectionTo !== null) {
    const from = Math.max(0, Math.min(state.selectionFrom, docSize));
    const to = Math.max(0, Math.min(state.selectionTo, docSize));
    if (from < to) {
      decorations.push(...createSelectionDecorations(from, to));
    }
  }

  // Add cursor decoration if cursor is visible
  if (state.cursorPos !== null) {
    const pos = Math.max(0, Math.min(state.cursorPos, docSize));
    decorations.push(createCursorDecoration(pos, state.agentLabel, state.agentKind));
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * Inject CSS styles for agent cursor animation
 */
function injectStyles(): void {
  if (document.getElementById('agent-cursor-styles')) return;

  const style = document.createElement('style');
  style.id = 'agent-cursor-styles';
  style.textContent = `
    @keyframes agentCursorBlink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .agent-cursor { position: relative; width: 0; display: inline-block; pointer-events: none; }
    .agent-cursor-bar { position: absolute; left: 0; top: 0; width: 2px; height: 1.15em; background-color: #2563eb; border-radius: 2px; animation: agentCursorBlink 1.6s ease-in-out infinite; z-index: 100; }
    .agent-selection { background-color: rgba(37, 99, 235, 0.14); border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.18); transition: background-color 0.15s ease-out; }

    @keyframes agentCursorPulse {
      0% { transform: scaleY(1); box-shadow: 0 0 4px rgba(59, 130, 246, 0.5); }
      50% { transform: scaleY(1.1); box-shadow: 0 0 8px rgba(59, 130, 246, 0.8); }
      100% { transform: scaleY(1); box-shadow: 0 0 4px rgba(59, 130, 246, 0.5); }
    }

    .agent-cursor-bar.animating {
      animation: agentCursorPulse 0.3s ease-out !important;
    }

    .agent-cursor-badge {
      position: absolute;
      left: -6px;
      top: -18px;
      transform: translateY(-100%);
      padding: 2px 6px;
      font-size: 10px;
      line-height: 1;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-left: 3px solid #2563eb;
      color: rgba(255, 255, 255, 0.92);
      letter-spacing: 0.2px;
      white-space: nowrap;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
      pointer-events: none;
      z-index: 101;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .agent-cursor-badge--blue { border-left-color: #2F80FF; }
    .agent-cursor-badge--lime { border-left-color: #A3C600; }
    .agent-cursor-badge--mint { border-left-color: #3DC79A; }
    .agent-cursor-badge--orange { border-left-color: #FF8A3D; }
    .agent-cursor-badge--pink { border-left-color: #F45CAB; }
    .agent-cursor-badge--purple { border-left-color: #8B6BFF; }
    .agent-cursor-badge--red { border-left-color: #F15B5B; }
    .agent-cursor-badge--yellow { border-left-color: #E4B90A; }

    .agent-cursor-badge__icon {
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.12));
    }

    /* Thinking chain styles */
    .agent-thinking-panel {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 320px;
      max-height: 300px;
      background: #1f2937;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      z-index: 1000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .agent-thinking-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #111827;
      border-bottom: 1px solid #374151;
    }

    .agent-thinking-title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #f9fafb;
      font-size: 13px;
      font-weight: 500;
    }

    .agent-thinking-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #3b82f6;
      animation: agentThinkingPulse 1.5s ease-in-out infinite;
    }

    @keyframes agentThinkingPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .agent-thinking-cancel {
      background: transparent;
      border: 1px solid #4b5563;
      color: #9ca3af;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .agent-thinking-cancel:hover {
      border-color: #ef4444;
      color: #ef4444;
    }

    .agent-thinking-content {
      max-height: 240px;
      overflow-y: auto;
      padding: 12px;
    }

    .agent-thinking-entry {
      padding: 8px;
      margin-bottom: 8px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
    }

    .agent-thinking-entry--thinking {
      background: #374151;
      color: #d1d5db;
      font-style: italic;
    }

    .agent-thinking-entry--tool_call {
      background: #1e3a5f;
      color: #93c5fd;
    }

    .agent-thinking-entry--tool_result {
      background: #14532d;
      color: #86efac;
    }

    .agent-thinking-entry--text {
      background: #1f2937;
      color: #f9fafb;
    }

    .agent-thinking-entry--error {
      background: #7f1d1d;
      color: #fecaca;
    }

    .agent-thinking-tool-name {
      font-weight: 600;
      margin-bottom: 4px;
    }

    .agent-thinking-time {
      color: #6b7280;
      font-size: 10px;
      margin-top: 4px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Agent cursor plugin
 */
export const agentCursorPlugin = $prose((_ctx) => {
  // Inject styles on plugin creation
  injectStyles();

  return new Plugin<AgentCursorState>({
    key: agentCursorPluginKey,

    state: {
      init() {
        return initialState;
      },

      apply(tr, pluginState) {
        // Check for agent cursor update in transaction metadata
        const newState = tr.getMeta(agentCursorPluginKey);
        if (newState !== undefined) {
          return { ...pluginState, ...newState };
        }

        // Map positions through document changes
        if (tr.docChanged && pluginState.cursorPos !== null) {
          const mappedCursor = tr.mapping.mapResult(pluginState.cursorPos);
          const mappedFrom = pluginState.selectionFrom !== null
            ? tr.mapping.mapResult(pluginState.selectionFrom)
            : null;
          const mappedTo = pluginState.selectionTo !== null
            ? tr.mapping.mapResult(pluginState.selectionTo)
            : null;

          return {
            ...pluginState,
            cursorPos: mappedCursor.deleted ? null : mappedCursor.pos,
            selectionFrom: mappedFrom?.deleted ? null : mappedFrom?.pos ?? null,
            selectionTo: mappedTo?.deleted ? null : mappedTo?.pos ?? null,
          };
        }

        return pluginState;
      },
    },

    props: {
      decorations(state) {
        const pluginState = agentCursorPluginKey.getState(state);
        if (!pluginState) return DecorationSet.empty;
        return buildDecorations(pluginState, state.doc);
      },
    },

    view(_editorView) {
      let clearTimer: ReturnType<typeof setTimeout> | null = null;
      let lastUpdate = 0;

      const scheduleClear = (view: EditorView, delayMs: number) => {
        if (clearTimer) clearTimeout(clearTimer);
        clearTimer = setTimeout(() => {
          const tr = view.state.tr.setMeta(agentCursorPluginKey, {
            cursorPos: null,
            selectionFrom: null,
            selectionTo: null,
            isAnimating: false,
            agentLabel: null,
            agentKind: null,
            lastUpdated: null,
          });
          view.dispatch(tr);
        }, delayMs);
      };

      return {
        update(view) {
          // After update, trigger animation on cursor bar if it moved
          const pluginState = agentCursorPluginKey.getState(view.state);
          if (!pluginState) return;

          if (pluginState.isAnimating) {
            const cursorBar = view.dom.querySelector('.agent-cursor-bar');
            if (cursorBar) {
              cursorBar.classList.add('animating');
              setTimeout(() => cursorBar.classList.remove('animating'), 300);
            }

            // Clear animation flag
            const tr = view.state.tr.setMeta(agentCursorPluginKey, {
              ...pluginState,
              isAnimating: false,
            });
            view.dispatch(tr);
          }

          if (pluginState.cursorPos !== null && pluginState.lastUpdated) {
            if (pluginState.lastUpdated !== lastUpdate) {
              lastUpdate = pluginState.lastUpdated;
              scheduleClear(view, 8000);
            }
          } else if (clearTimer) {
            clearTimeout(clearTimer);
            clearTimer = null;
          }
        },
        destroy() {
          if (clearTimer) clearTimeout(clearTimer);
        },
      };
    },
  });
});

/**
 * Helper functions to control the agent cursor from outside the plugin
 */

/**
 * Set the agent cursor position
 */
function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveAgentLabel(actor?: string, fallback?: AgentCursorState): { label: string | null; kind: AgentCursorState['agentKind'] } {
  if (!actor) {
    return { label: fallback?.agentLabel ?? null, kind: fallback?.agentKind ?? null };
  }

  const normalized = actor.toLowerCase();
  const family = resolveAgentFamily({ actor });
  if (normalized.includes('claude')) {
    const label = normalized.includes('code') ? 'Claude Code' : 'Claude';
    return { label, kind: family };
  }
  if (normalized.includes('chatgpt') || normalized.includes('openai') || normalized.includes('gpt')) {
    return { label: 'ChatGPT', kind: family };
  }
  if (normalized.includes('gemini') || normalized.includes('google')) {
    return { label: 'Gemini', kind: family };
  }
  if (normalized.includes('cursor')) {
    return { label: 'Cursor', kind: family };
  }

  const labelSource = actor.includes(':') ? actor.split(':').slice(1).join(':') : actor;
  const label = titleCase(labelSource.replace(/[-_]+/g, ' ').trim());
  return { label: label || 'AI', kind: family };
}

export function setAgentCursor(view: EditorView, pos: number, actor?: string): void {
  const docSize = view.state.doc.content.size;
  const clampedPos = Math.max(0, Math.min(pos, docSize));
  const existing = agentCursorPluginKey.getState(view.state) ?? initialState;
  const agentInfo = resolveAgentLabel(actor, existing);

  const tr = view.state.tr.setMeta(agentCursorPluginKey, {
    cursorPos: clampedPos,
    selectionFrom: null,
    selectionTo: null,
    isAnimating: true,
    agentLabel: agentInfo.label,
    agentKind: agentInfo.kind,
    lastUpdated: Date.now(),
  });
  view.dispatch(tr);

  // Scroll the cursor into view
  scrollIntoView(view, clampedPos);
}

/**
 * Set the agent selection range
 */
export function setAgentSelection(view: EditorView, from: number, to: number, actor?: string): void {
  const docSize = view.state.doc.content.size;
  const clampedFrom = Math.max(0, Math.min(from, docSize));
  const clampedTo = Math.max(0, Math.min(to, docSize));
  const existing = agentCursorPluginKey.getState(view.state) ?? initialState;
  const agentInfo = resolveAgentLabel(actor, existing);

  const tr = view.state.tr.setMeta(agentCursorPluginKey, {
    cursorPos: clampedTo, // Cursor at end of selection
    selectionFrom: Math.min(clampedFrom, clampedTo),
    selectionTo: Math.max(clampedFrom, clampedTo),
    isAnimating: true,
    agentLabel: agentInfo.label,
    agentKind: agentInfo.kind,
    lastUpdated: Date.now(),
  });
  view.dispatch(tr);

  // Scroll the selection into view
  scrollIntoView(view, clampedFrom);
}

/**
 * Clear the agent cursor and selection
 */
export function clearAgentCursor(view: EditorView): void {
  const tr = view.state.tr.setMeta(agentCursorPluginKey, {
    cursorPos: null,
    selectionFrom: null,
    selectionTo: null,
    isAnimating: false,
    agentLabel: null,
    agentKind: null,
    lastUpdated: null,
  });
  view.dispatch(tr);
}

/**
 * Get current agent cursor state
 */
export function getAgentCursorState(view: EditorView): AgentCursorState | null {
  return agentCursorPluginKey.getState(view.state) ?? null;
}

/**
 * Scroll a position into view smoothly
 */
function scrollIntoView(view: EditorView, pos: number): void {
  try {
    const coords = view.coordsAtPos(pos);
    const editorRect = view.dom.getBoundingClientRect();

    // Check if position is outside visible area
    if (coords.top < editorRect.top || coords.bottom > editorRect.bottom) {
      // Get DOM element at position
      const domAtPos = view.domAtPos(pos);
      let element = domAtPos.node;

      // Find block element
      while (element && !(element instanceof HTMLElement)) {
        element = element.parentNode as Node;
      }

      if (element instanceof HTMLElement) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  } catch (e) {
    // Position might be invalid, ignore
  }
}

// ============================================================================
// Thinking Chain Display
// ============================================================================

let thinkingPanel: HTMLElement | null = null;
let onCancelCallback: (() => void) | null = null;

/**
 * Show the thinking chain panel
 */
export function showThinkingPanel(onCancel?: () => void): void {
  if (thinkingPanel) return;

  onCancelCallback = onCancel || null;

  thinkingPanel = document.createElement('div');
  thinkingPanel.className = 'agent-thinking-panel';
  thinkingPanel.innerHTML = `
    <div class="agent-thinking-header">
      <div class="agent-thinking-title">
        <span class="agent-thinking-indicator"></span>
        <span>Proof is thinking...</span>
      </div>
      <button class="agent-thinking-cancel">Cancel</button>
    </div>
    <div class="agent-thinking-content"></div>
  `;

  const cancelBtn = thinkingPanel.querySelector('.agent-thinking-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      onCancelCallback?.();
      hideThinkingPanel();
    });
  }

  document.body.appendChild(thinkingPanel);
}

/**
 * Hide the thinking chain panel
 */
export function hideThinkingPanel(): void {
  if (thinkingPanel) {
    thinkingPanel.remove();
    thinkingPanel = null;
    onCancelCallback = null;
  }
}

/**
 * Update the thinking chain display
 */
export function updateThinkingChain(entries: ThinkingChainEntry[]): void {
  if (!thinkingPanel) return;

  const content = thinkingPanel.querySelector('.agent-thinking-content');
  if (!content) return;

  // Clear and rebuild content
  content.innerHTML = entries.map(entry => {
    const timeStr = new Date(entry.timestamp).toLocaleTimeString();
    let html = `<div class="agent-thinking-entry agent-thinking-entry--${entry.type}">`;

    switch (entry.type) {
      case 'thinking':
        html += `<div>${escapeHtml(entry.content || '')}</div>`;
        break;
      case 'tool_call':
        html += `<div class="agent-thinking-tool-name">🔧 ${escapeHtml(entry.toolName || '')}</div>`;
        if (entry.content) {
          html += `<div>${escapeHtml(entry.content)}</div>`;
        }
        break;
      case 'tool_result':
        html += `<div class="agent-thinking-tool-name">✓ ${escapeHtml(entry.toolName || '')}</div>`;
        break;
      case 'text':
        html += `<div>${escapeHtml(entry.content || '')}</div>`;
        break;
      case 'error':
        html += `<div>❌ ${escapeHtml(entry.content || 'An error occurred')}</div>`;
        break;
    }

    html += `<div class="agent-thinking-time">${timeStr}</div>`;
    html += `</div>`;
    return html;
  }).join('');

  // Scroll to bottom
  content.scrollTop = content.scrollHeight;
}

/**
 * Update the current action in the header
 */
export function setThinkingAction(action: string | null): void {
  if (!thinkingPanel) return;

  const title = thinkingPanel.querySelector('.agent-thinking-title span:last-child');
  if (title) {
    title.textContent = action || 'Proof is thinking...';
  }
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export default agentCursorPlugin;
