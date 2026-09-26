import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

export type FindHighlightRange = {
  from: number;
  to: number;
};

type FindHighlightsMeta =
  | {
    type: 'set';
    matches: FindHighlightRange[];
    currentIndex: number;
  }
  | {
    type: 'clear';
  };

type FindHighlightsState = {
  matches: FindHighlightRange[];
  currentIndex: number;
  decorations: DecorationSet;
};

const findHighlightsKey = new PluginKey<FindHighlightsState>('find-highlights');

function normalizeRanges(docSize: number, matches: FindHighlightRange[]): FindHighlightRange[] {
  const normalized: FindHighlightRange[] = [];
  for (const match of matches) {
    const from = Math.max(0, Math.min(match.from, docSize));
    const to = Math.max(from, Math.min(match.to, docSize));
    if (to > from) {
      normalized.push({ from, to });
    }
  }
  return normalized;
}

function buildDecorations(
  state: EditorState,
  matches: FindHighlightRange[],
  currentIndex: number
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const isCurrent = index === currentIndex;
    decorations.push(
      Decoration.inline(match.from, match.to, {
        class: isCurrent ? 'proof-find-match proof-find-match--active' : 'proof-find-match',
      })
    );
  }

  return DecorationSet.create(state.doc, decorations);
}

function createState(
  state: EditorState,
  matches: FindHighlightRange[],
  currentIndex: number
): FindHighlightsState {
  const normalizedMatches = normalizeRanges(state.doc.content.size, matches);
  const clampedIndex = normalizedMatches.length === 0
    ? -1
    : Math.max(0, Math.min(currentIndex, normalizedMatches.length - 1));
  return {
    matches: normalizedMatches,
    currentIndex: clampedIndex,
    decorations: buildDecorations(state, normalizedMatches, clampedIndex),
  };
}

function mapRanges(
  tr: Transaction,
  matches: FindHighlightRange[],
  docSize: number
): FindHighlightRange[] {
  const mapped: FindHighlightRange[] = [];
  for (const match of matches) {
    const fromResult = tr.mapping.mapResult(match.from, 1);
    const toResult = tr.mapping.mapResult(match.to, -1);
    if (fromResult.deleted || toResult.deleted) continue;

    const from = Math.max(0, Math.min(fromResult.pos, docSize));
    const to = Math.max(from, Math.min(toResult.pos, docSize));
    if (to > from) {
      mapped.push({ from, to });
    }
  }
  return mapped;
}

function injectFindHighlightStyles(): void {
  if (document.getElementById('proof-find-highlight-styles')) return;
  const style = document.createElement('style');
  style.id = 'proof-find-highlight-styles';
  style.textContent = `
    .proof-find-match { background-color: rgba(250, 204, 21, 0.5) !important; border-radius: 2px; box-shadow: inset 0 -2px 0 rgba(217, 119, 6, 0.9); }
    .proof-find-match--active { background-color: rgba(34, 211, 238, 0.55) !important; border-radius: 2px; box-shadow: 0 0 0 2px rgba(8, 145, 178, 0.95) !important; text-decoration: underline 2px rgba(8, 145, 178, 0.95); text-underline-offset: 1px; }
  `;
  document.head.appendChild(style);
}

export function setFindHighlights(
  view: EditorView,
  matches: FindHighlightRange[],
  currentIndex: number
): void {
  const tr = view.state.tr.setMeta(findHighlightsKey, {
    type: 'set',
    matches: matches.map((match) => ({ from: match.from, to: match.to })),
    currentIndex,
  } satisfies FindHighlightsMeta);
  view.dispatch(tr);
}

export function clearFindHighlights(view: EditorView): void {
  const tr = view.state.tr.setMeta(findHighlightsKey, { type: 'clear' } satisfies FindHighlightsMeta);
  view.dispatch(tr);
}

export const findHighlightsPlugin = $prose(() => {
  injectFindHighlightStyles();
  return new Plugin<FindHighlightsState>({
    key: findHighlightsKey,
    state: {
      init: (_, state) => createState(state, [], -1),
      apply(tr, pluginState, _oldState, newState) {
        const meta = tr.getMeta(findHighlightsKey) as FindHighlightsMeta | undefined;
        if (meta?.type === 'clear') {
          return createState(newState, [], -1);
        }
        if (meta?.type === 'set') {
          return createState(newState, meta.matches, meta.currentIndex);
        }

        if (tr.docChanged && pluginState.matches.length > 0) {
          const mappedMatches = mapRanges(tr, pluginState.matches, newState.doc.content.size);
          return createState(newState, mappedMatches, pluginState.currentIndex);
        }

        return pluginState;
      },
    },
    props: {
      decorations(state) {
        return findHighlightsKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
});
