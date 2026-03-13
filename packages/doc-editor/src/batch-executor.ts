import {
  executeBatch as executeBatchImpl,
  type BatchOperation,
  type BatchOperationResult,
  type BatchResult,
} from '../../../src/editor/batch-executor.js';

export type {
  BatchOperation,
  BatchOperationResult,
  BatchResult,
};

export const executeBatch = executeBatchImpl;
