import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { MarkType, Slice, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

import { marksPluginKey } from './marks';
import { getCurrentActor } from '../actor';

type PendingRange = { from: number; to: number; by: string };

const authoredTrackerKey = new PluginKey('authored-tracker');

function getAuthoredMarkType(state: { schema: { marks: Record<string, MarkType> } }): MarkType | null {
  return state.schema.marks.proofAuthored ?? null;
}

function sliceHasAuthoredMarks(slice: Slice, markType: MarkType): boolean {
  let found = false;

  const visit = (node: ProseMirrorNode) => {
    if (found) return;
    if (node.isText && node.marks.some(mark => mark.type === markType)) {
      found = true;
      return;
    }
    if (node.content && node.content.size > 0) {
      node.content.forEach(visit);
    }
  };

  slice.content.forEach(visit);
  return found;
}

function mergeRanges(ranges: PendingRange[]): PendingRange[] {
  if (ranges.length <= 1) return ranges;

  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: PendingRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (last.by === current.by && current.from <= last.to + 2) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

export const authoredTrackerPlugin = $prose(() => {
  let pendingHumanRanges: PendingRange[] = [];

  return new Plugin({
    key: authoredTrackerKey,

    props: {
      handleTextInput(view, from, _to, text) {
        const markType = getAuthoredMarkType(view.state);
        if (!markType || !text) return false;

        const actor = getCurrentActor();
        pendingHumanRanges.push({ from, to: from + text.length, by: actor });
        return false;
      },

      handlePaste(view, _event, slice) {
        const markType = getAuthoredMarkType(view.state);
        if (!markType) return false;

        if (sliceHasAuthoredMarks(slice, markType)) {
          return false;
        }

        const { from } = view.state.selection;
        let tr = view.state.tr.replaceSelection(slice);
        const docSize = tr.doc.content.size;
        const insertFrom = Math.max(0, Math.min(tr.mapping.map(from, -1), docSize));
        const insertTo = Math.max(insertFrom, Math.min(insertFrom + slice.size, docSize));

        if (insertTo > insertFrom) {
          tr = tr.removeMark(insertFrom, insertTo, markType);
          tr = tr.addMark(insertFrom, insertTo, markType.create({ by: 'unknown:pasted' }));
        }

        tr = tr.setMeta(marksPluginKey, { type: 'INTERNAL' });
        view.dispatch(tr);
        return true;
      },
    },

    appendTransaction(transactions, _oldState, newState) {
      if (pendingHumanRanges.length === 0) return null;

      const markType = getAuthoredMarkType(newState);
      if (!markType) {
        pendingHumanRanges = [];
        return null;
      }

      const docChanged = transactions.some(tr => tr.docChanged);
      const skipAuthored = transactions.some(tr => tr.getMeta('ai-authored') || tr.getMeta('document-load'));

      if (!docChanged || skipAuthored) {
        pendingHumanRanges = [];
        return null;
      }

      let tr = newState.tr;
      const merged = mergeRanges(pendingHumanRanges);
      const docSize = newState.doc.content.size;

      for (const range of merged) {
        const from = Math.max(0, Math.min(range.from, docSize));
        const to = Math.max(from, Math.min(range.to, docSize));
        if (to <= from) continue;

        tr = tr.removeMark(from, to, markType);
        tr = tr.addMark(from, to, markType.create({ by: range.by }));
      }

      pendingHumanRanges = [];

      if (tr.steps.length === 0) return null;
      return tr.setMeta(marksPluginKey, { type: 'INTERNAL' });
    },
  });
});

export default authoredTrackerPlugin;
