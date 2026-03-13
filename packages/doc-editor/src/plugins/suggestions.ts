/**
 * Suggestions Plugin for Milkdown
 *
 * Converts edits into proofSuggestion marks + PROOF metadata
 * when suggestions mode is enabled.
 */

import { $ctx, $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { MarkType, Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

import { generateMarkId, type InsertData, type MarkRange } from '@proof/core/marks';
import { getCurrentActor } from '../actor.js';
import { marksPluginKey, getMarkMetadata, buildSuggestionMetadata, getMarks } from './marks.js';

export interface SuggestionState {
  enabled: boolean;
}

export const suggestionsPluginKey = new PluginKey<SuggestionState>('suggestions');
export const suggestionsCtx = $ctx<SuggestionState, 'suggestions'>({ enabled: false }, 'suggestions');

type SuggestionKind = 'insert' | 'delete' | 'replace';

type SliceNode = {
  type?: string;
  text?: string;
  content?: SliceNode[];
};

const COALESCE_WINDOW_MS = 750;
type InsertCoalesceState = { id: string; from: number; to: number; by: string; updatedAt: number };
const lastInsertByActor = new Map<string, InsertCoalesceState>();

function normalizeSuggestionKind(kind: unknown): SuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function isWhitespaceOnly(text: string): boolean {
  return /^[\s\u00A0]+$/.test(text);
}

function getCoalescableInsertCandidate(
  state: EditorState,
  pos: number,
  by: string,
  now: number
): { id: string; range: MarkRange; direction: 'append' | 'prepend' } | null {
  const cached = lastInsertByActor.get(by);
  if (!cached) return null;
  if (now - cached.updatedAt > COALESCE_WINDOW_MS) {
    lastInsertByActor.delete(by);
    return null;
  }

  const marks = getMarks(state);
  const match = marks.find(mark => mark.id === cached.id && mark.kind === 'insert' && mark.by === by);
  if (!match || !match.range) {
    lastInsertByActor.delete(by);
    return null;
  }

  const data = match.data as InsertData | undefined;
  if (data?.status && data.status !== 'pending') {
    lastInsertByActor.delete(by);
    return null;
  }

  if (match.range.to === pos) {
    return { id: match.id, range: match.range, direction: 'append' };
  }

  if (match.range.from === pos) {
    return { id: match.id, range: match.range, direction: 'prepend' };
  }

  return null;
}

function collectSliceText(nodes?: SliceNode[]): { text: string; hasNonText: boolean } {
  let text = '';
  let hasNonText = false;

  if (!nodes) return { text, hasNonText };

  for (const node of nodes) {
    if (node.text) text += node.text;
    if (node.type && node.type !== 'text') hasNonText = true;
    if (node.content) {
      const child = collectSliceText(node.content);
      text += child.text;
      if (child.hasNonText) hasNonText = true;
    }
  }

  return { text, hasNonText };
}

function detectSuggestionKinds(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  suggestionType: MarkType
): { hasInsert: boolean; hasDelete: boolean; hasReplace: boolean } {
  const found = { hasInsert: false, hasDelete: false, hasReplace: false };

  doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type !== suggestionType) continue;
      const kind = normalizeSuggestionKind(mark.attrs.kind);
      if (kind === 'insert') found.hasInsert = true;
      if (kind === 'delete') found.hasDelete = true;
      if (kind === 'replace') found.hasReplace = true;
    }
    return !(found.hasInsert && found.hasDelete && found.hasReplace);
  });

  return found;
}

export function wrapTransactionForSuggestions(
  tr: Transaction,
  state: EditorState,
  enabled: boolean
): Transaction {
  if (!enabled || !tr.docChanged) return tr;
  if (tr.getMeta('y-sync$')) return tr;

  const suggestionType = state.schema.marks.proofSuggestion;
  if (!suggestionType) {
    console.warn('[suggestions] Missing proofSuggestion mark type');
    return tr;
  }

  for (const step of tr.steps) {
    const stepJson = step.toJSON() as { stepType?: string; slice?: { content?: SliceNode[] } };
    if (stepJson.stepType === 'replace' && stepJson.slice?.content) {
      const { hasNonText } = collectSliceText(stepJson.slice.content);
      if (hasNonText) return tr;
    }
  }

  const actor = getCurrentActor();
  let metadata = getMarkMetadata(state);
  let metadataChanged = false;
  const newTr = state.tr;
  let writeOffset = 0;

  for (const step of tr.steps) {
    const stepJson = step.toJSON() as {
      stepType?: string;
      from?: number;
      to?: number;
      slice?: { content?: SliceNode[] };
    };

    if (stepJson.stepType === 'replace') {
      const origFrom = stepJson.from ?? 0;
      const origTo = stepJson.to ?? 0;
      const from = origFrom + writeOffset;
      const to = origTo + writeOffset;
      const slice = stepJson.slice;

      const { text: insertedText } = collectSliceText(slice?.content);
      const deletedText = state.doc.textBetween(origFrom, origTo, '');
      const docSize = newTr.doc.content.size;
      const safeFrom = Math.max(0, Math.min(from, docSize));
      const safeTo = Math.max(safeFrom, Math.min(to, docSize));

      if (deletedText && !insertedText) {
        lastInsertByActor.delete(actor);
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete || existing.hasInsert) {
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;
        } else if (existing.hasReplace) {
          newTr.removeMark(safeFrom, safeTo, suggestionType);
        } else {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.addMark(safeFrom, safeTo, suggestionType.create({ id: suggestionId, kind: 'delete', by: actor }));
          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('delete', actor, null, createdAt),
          };
          metadataChanged = true;
          newTr.setSelection(TextSelection.create(newTr.doc, safeFrom));
        }
      } else if (insertedText && !deletedText) {
        const now = Date.now();
        const whitespaceOnly = isWhitespaceOnly(insertedText);
        const candidate = getCoalescableInsertCandidate(state, safeFrom, actor, now);

        if (candidate) {
          const existingMeta = metadata[candidate.id];
          const existingContent = typeof existingMeta?.content === 'string' ? existingMeta.content : '';
          const updatedContent = candidate.direction === 'append'
            ? `${existingContent}${insertedText}`
            : `${insertedText}${existingContent}`;

          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: candidate.id, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length;

          metadata = whitespaceOnly ? {
            ...metadata,
            [candidate.id]: {
              ...existingMeta,
              content: updatedContent,
            },
          } : {
            ...metadata,
            [candidate.id]: {
              ...existingMeta,
              kind: 'insert',
              by: actor,
              content: updatedContent,
              status: existingMeta?.status ?? 'pending',
              createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
            },
          };
          metadataChanged = true;

          lastInsertByActor.set(actor, {
            id: candidate.id,
            from: candidate.range.from,
            to: candidate.range.to + insertedText.length,
            by: actor,
            updatedAt: now,
          });
        } else {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length;
          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
          lastInsertByActor.set(actor, {
            id: suggestionId,
            from: safeFrom,
            to: safeFrom + insertedText.length,
            by: actor,
            updatedAt: now,
          });
        }
      } else if (deletedText && insertedText) {
        lastInsertByActor.delete(actor);
        const existing = detectSuggestionKinds(newTr.doc, safeFrom, safeTo, suggestionType);

        if (existing.hasDelete) {
          newTr.delete(safeFrom, safeTo);
          writeOffset -= deletedText.length;
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.insertText(insertedText, safeFrom);
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length;
          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
        } else if (existing.hasInsert) {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.replaceWith(safeFrom, safeTo, state.schema.text(insertedText));
          newTr.addMark(
            safeFrom,
            safeFrom + insertedText.length,
            suggestionType.create({ id: suggestionId, kind: 'insert', by: actor })
          );
          writeOffset += insertedText.length - deletedText.length;
          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('insert', actor, insertedText, createdAt),
          };
          metadataChanged = true;
        } else {
          const suggestionId = generateMarkId();
          const createdAt = new Date().toISOString();
          newTr.removeMark(safeFrom, safeTo, suggestionType);
          newTr.addMark(
            safeFrom,
            safeTo,
            suggestionType.create({ id: suggestionId, kind: 'replace', by: actor })
          );
          metadata = {
            ...metadata,
            [suggestionId]: buildSuggestionMetadata('replace', actor, insertedText, createdAt),
          };
          metadataChanged = true;
          newTr.setSelection(TextSelection.create(newTr.doc, safeTo));
        }
      } else {
        try {
          const sizeBefore = newTr.doc.content.size;
          newTr.step(step);
          writeOffset += newTr.doc.content.size - sizeBefore;
        } catch (error) {
          console.warn('[suggestions] Could not apply structural step:', error);
        }
      }
    } else if (
      stepJson.stepType === 'replaceAround'
      || stepJson.stepType === 'addMark'
      || stepJson.stepType === 'removeMark'
    ) {
      try {
        newTr.step(step);
      } catch (error) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, error);
      }
    } else {
      try {
        const result = step.apply(newTr.doc);
        if (result.doc && result.doc !== newTr.doc) {
          const sizeDiff = result.doc.content.size - newTr.doc.content.size;
          newTr.step(step);
          writeOffset += sizeDiff;
        }
      } catch (error) {
        console.warn('[suggestions] Could not apply step:', stepJson.stepType, error);
      }
    }
  }

  if (metadataChanged) {
    newTr.setMeta(marksPluginKey, {
      type: 'SET_METADATA',
      metadata,
    });
  }

  newTr.setMeta('suggestions-wrapped', true);

  return newTr;
}

export function isSuggestionsEnabled(state: EditorState): boolean {
  return suggestionsPluginKey.getState(state)?.enabled ?? false;
}

export function enableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  view.dispatch(view.state.tr.setMeta(suggestionsPluginKey, { enabled: true }));
}

export function disableSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): void {
  view.dispatch(view.state.tr.setMeta(suggestionsPluginKey, { enabled: false }));
}

export function toggleSuggestions(view: { state: EditorState; dispatch: (tr: Transaction) => void }): boolean {
  const enabled = isSuggestionsEnabled(view.state);
  if (enabled) {
    disableSuggestions(view);
  } else {
    enableSuggestions(view);
  }
  return !enabled;
}

export const suggestionsPlugin = $prose(() => new Plugin<SuggestionState>({
  key: suggestionsPluginKey,
  state: {
    init(): SuggestionState {
      return { enabled: false };
    },
    apply(tr, value): SuggestionState {
      const meta = tr.getMeta(suggestionsPluginKey);
      if (meta !== undefined) {
        return { ...value, ...meta };
      }
      return value;
    },
  },
  appendTransaction(_trs, oldState, newState) {
    const wasEnabled = suggestionsPluginKey.getState(oldState)?.enabled ?? false;
    const isEnabled = suggestionsPluginKey.getState(newState)?.enabled ?? false;
    if (wasEnabled !== isEnabled) {
      queueMicrotask(() => {
        (window as any).proof?.bridge?.sendMessage('suggestionsChanged', { enabled: isEnabled });
      });
    }
    return null;
  },
}));

export const suggestionsPlugins = [suggestionsCtx, suggestionsPlugin];
