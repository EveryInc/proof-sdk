/**
 * Batch Executor for Atomic Operations
 *
 * Executes multiple operations in a single ProseMirror transaction.
 * Operations share context (cursor, selection) and are either all
 * committed or all rolled back.
 */

import type { EditorView } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import type { Node } from '@milkdown/kit/prose/model';
import {
  resolveSelector,
  resolveSelectorRange,
  hasHeading,
  extractHeadingFromText,
  type SelectorRange,
} from '../../../src/editor/utils/selectors.js';
import { setAgentCursor, setAgentSelection } from '../../../src/editor/plugins/agent-cursor.js';
import { captureEvent } from '../../../src/analytics/telemetry.js';

export interface BatchOperation {
  op: 'select' | 'goto' | 'insert' | 'replace' | 'delete' | 'save';
  selector?: string;
  text?: string;
  at?: string;
  from?: number;
  to?: number;
  skipIfHeadingExists?: boolean;
  skipIfContentExists?: boolean;
}

export interface BatchOperationResult {
  op: string;
  success: boolean;
  error?: string;
  from?: number;
  to?: number;
  offset?: number;
  skipped?: boolean;
  reason?: string;
}

export interface BatchResult {
  success: boolean;
  results: BatchOperationResult[];
  error?: string;
}

interface BatchContext {
  tr: Transaction;
  selection: SelectorRange | null;
  cursor: number;
  saveAfter: boolean;
}

type Parser = (text: string) => Node;

export function executeBatch(
  view: EditorView,
  parser: Parser,
  operations: BatchOperation[]
): BatchResult {
  const results: BatchOperationResult[] = [];

  const ctx: BatchContext = {
    tr: view.state.tr,
    selection: null,
    cursor: view.state.selection.from,
    saveAfter: false,
  };

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const result = executeOperation(ctx, view, parser, op);
    results.push(result);

    if (!result.success && !result.skipped) {
      return {
        success: false,
        error: `Operation ${i + 1} (${op.op}) failed: ${result.error}`,
        results,
      };
    }
  }

  if (ctx.tr.docChanged) {
    view.dispatch(ctx.tr);
  }

  if (ctx.saveAfter) {
    captureEvent('document_save_requested', {
      source: 'batch_executor',
      save_supported: false,
      operations_count: operations.length,
    });
  }

  return {
    success: true,
    results,
  };
}

function executeOperation(
  ctx: BatchContext,
  view: EditorView,
  parser: Parser,
  op: BatchOperation
): BatchOperationResult {
  switch (op.op) {
    case 'goto':
      return executeGoto(ctx, view, op);
    case 'select':
      return executeSelect(ctx, view, op);
    case 'insert':
      return executeInsert(ctx, parser, op);
    case 'replace':
      return executeReplace(ctx, parser, op);
    case 'delete':
      return executeDelete(ctx, op);
    case 'save':
      return executeSave(ctx);
    default:
      return { op: op.op, success: false, error: `Unknown operation: ${op.op}` };
  }
}

function executeGoto(
  ctx: BatchContext,
  view: EditorView,
  op: BatchOperation
): BatchOperationResult {
  const selector = op.selector || 'cursor';
  const position = resolveSelector(ctx.tr.doc, selector, {
    cursor: ctx.cursor,
    selection: ctx.selection,
  });

  if (position === null) {
    return { op: 'goto', success: false, error: `Could not resolve selector: ${selector}` };
  }

  ctx.cursor = position;
  setAgentCursor(view, position);

  return { op: 'goto', success: true, offset: position };
}

function executeSelect(
  ctx: BatchContext,
  view: EditorView,
  op: BatchOperation
): BatchOperationResult {
  let range: SelectorRange | null = null;

  if (op.selector) {
    range = resolveSelectorRange(ctx.tr.doc, op.selector, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  }

  if (!range && op.from !== undefined && op.to !== undefined) {
    range = { from: op.from, to: op.to };
  }

  if (!range) {
    return {
      op: 'select',
      success: false,
      error: `Could not resolve selection: ${op.selector || 'no selector'}`,
    };
  }

  const docSize = ctx.tr.doc.content.size;
  range.from = Math.max(0, Math.min(range.from, docSize));
  range.to = Math.max(0, Math.min(range.to, docSize));

  ctx.selection = range;
  ctx.cursor = range.from;
  setAgentSelection(view, range.from, range.to);

  return { op: 'select', success: true, from: range.from, to: range.to };
}

function executeInsert(
  ctx: BatchContext,
  parser: Parser,
  op: BatchOperation
): BatchOperationResult {
  const text = op.text || '';

  if (op.skipIfHeadingExists) {
    const heading = extractHeadingFromText(text);
    if (heading && hasHeading(ctx.tr.doc, heading)) {
      return {
        op: 'insert',
        success: true,
        skipped: true,
        reason: 'Heading already exists',
      };
    }
  }

  let insertPos: number | null = null;

  if (op.at) {
    insertPos = resolveSelector(ctx.tr.doc, op.at, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  } else if (ctx.selection) {
    insertPos = ctx.selection.to;
  } else {
    insertPos = ctx.cursor;
  }

  if (insertPos === null) {
    return { op: 'insert', success: false, error: 'Could not resolve insert position' };
  }

  const docSize = ctx.tr.doc.content.size;
  insertPos = Math.max(0, Math.min(insertPos, docSize));

  const newContent = parser(text);
  ctx.tr = ctx.tr.insert(insertPos, newContent.content);

  const insertedSize = newContent.content.size;
  ctx.cursor = insertPos + insertedSize;
  ctx.selection = { from: insertPos, to: ctx.cursor };

  return { op: 'insert', success: true, offset: insertPos };
}

function executeReplace(
  ctx: BatchContext,
  parser: Parser,
  op: BatchOperation
): BatchOperationResult {
  const text = op.text || '';

  let range: SelectorRange | null = null;

  if (op.selector) {
    range = resolveSelectorRange(ctx.tr.doc, op.selector, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  } else if (ctx.selection) {
    range = ctx.selection;
  }

  if (!range) {
    return {
      op: 'replace',
      success: false,
      error: 'No selection or selector provided for replace',
    };
  }

  const docSize = ctx.tr.doc.content.size;
  range.from = Math.max(0, Math.min(range.from, docSize));
  range.to = Math.max(0, Math.min(range.to, docSize));

  const newContent = parser(text);
  ctx.tr = ctx.tr.replaceWith(range.from, range.to, newContent.content);

  const newSize = newContent.content.size;
  ctx.selection = { from: range.from, to: range.from + newSize };
  ctx.cursor = ctx.selection.to;

  return { op: 'replace', success: true, from: range.from, to: ctx.selection.to };
}

function executeDelete(ctx: BatchContext, op: BatchOperation): BatchOperationResult {
  let range: SelectorRange | null = null;

  if (op.selector) {
    range = resolveSelectorRange(ctx.tr.doc, op.selector, {
      cursor: ctx.cursor,
      selection: ctx.selection,
    });
  } else if (ctx.selection) {
    range = ctx.selection;
  }

  if (!range) {
    return {
      op: 'delete',
      success: false,
      error: 'No selection or selector provided for delete',
    };
  }

  const docSize = ctx.tr.doc.content.size;
  range.from = Math.max(0, Math.min(range.from, docSize));
  range.to = Math.max(0, Math.min(range.to, docSize));

  ctx.tr = ctx.tr.delete(range.from, range.to);
  ctx.selection = null;
  ctx.cursor = range.from;

  return { op: 'delete', success: true, from: range.from, to: range.to };
}

function executeSave(ctx: BatchContext): BatchOperationResult {
  ctx.saveAfter = true;
  return { op: 'save', success: true };
}
