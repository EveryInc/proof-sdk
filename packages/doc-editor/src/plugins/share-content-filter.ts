import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { ReplaceStep, ReplaceAroundStep } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import { ySyncPluginKey } from 'y-prosemirror';

type ShareContentFilterState = {
  enabled: boolean;
};

const shareContentFilterKey = new PluginKey<ShareContentFilterState>('share-content-filter');
export const SHARE_CONTENT_FILTER_ALLOW_META = 'proof.share.allowContentMutation';

/**
 * When enabled, blocks text-editing transactions while allowing mark changes.
 * This lets web viewers select text and add comments/flags/suggestions
 * without being able to edit the prose content itself.
 *
 * Allowed: AddMarkStep, RemoveMarkStep (comments, flags, etc.)
 * Blocked: ReplaceStep, ReplaceAroundStep (typing, paste, delete)
 */
export function enableShareContentFilter(view: EditorView): void {
  const tr = view.state.tr.setMeta(shareContentFilterKey, { enabled: true });
  view.dispatch(tr);
}

export function disableShareContentFilter(view: EditorView): void {
  const tr = view.state.tr.setMeta(shareContentFilterKey, { enabled: false });
  view.dispatch(tr);
}

export const shareContentFilterPlugin = $prose(() => {
  return new Plugin<ShareContentFilterState>({
    key: shareContentFilterKey,
    state: {
      init: () => ({ enabled: false }),
      apply(tr, value) {
        const meta = tr.getMeta(shareContentFilterKey) as ShareContentFilterState | undefined;
        if (meta && typeof meta.enabled === 'boolean') {
          return { enabled: meta.enabled };
        }
        return value;
      }
    },
    filterTransaction(tr, state) {
      const pluginState = shareContentFilterKey.getState(state);
      if (!pluginState?.enabled) return true;
      if (tr.getMeta(SHARE_CONTENT_FILTER_ALLOW_META) === true) return true;
      const rawMeta = (tr as unknown as { meta?: Record<string, unknown> }).meta;
      if (rawMeta) {
        for (const key of Object.keys(rawMeta)) {
          if (key.startsWith('y-sync')) return true;
        }
      }
      const ySyncMeta = tr.getMeta(ySyncPluginKey);
      if (ySyncMeta !== undefined) return true;
      if (tr.steps.length === 0) return true;
      for (const step of tr.steps) {
        if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
          return false;
        }
      }
      return true;
    },
  });
});
