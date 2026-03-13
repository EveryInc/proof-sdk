import type { DocumentRow } from './db.js';
import type { DocumentOpType } from './document-ops.js';

export type MutationContractStage = 'A' | 'B' | 'C';

export function getMutationContractStage(): MutationContractStage {
  const raw = (process.env.PROOF_MUTATION_CONTRACT_STAGE || '').trim().toUpperCase();
  if (raw === 'B' || raw === 'C') return raw;
  return 'A';
}

export function isIdempotencyRequired(stage: MutationContractStage): boolean {
  return stage === 'B' || stage === 'C';
}

export function isRevisionOnlyPrecondition(stage: MutationContractStage): boolean {
  return stage === 'C';
}

type BasePrecondition = {
  baseRevision: number | null;
  baseUpdatedAt: string | null;
};

function readBasePrecondition(value: unknown): BasePrecondition {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const baseRevision = Number.isInteger(payload.baseRevision) ? Number(payload.baseRevision) : null;
  const baseUpdatedAt = typeof payload.baseUpdatedAt === 'string' && payload.baseUpdatedAt.trim()
    ? payload.baseUpdatedAt.trim()
    : null;
  return {
    baseRevision: baseRevision !== null && baseRevision > 0 ? baseRevision : null,
    baseUpdatedAt,
  };
}

function isPreconditionRequiredForOps(stage: MutationContractStage, opType: DocumentOpType): boolean {
  if (stage === 'A') {
    return false;
  }
  return true;
}

export function validateOpPrecondition(
  stage: MutationContractStage,
  opType: DocumentOpType,
  doc: Pick<DocumentRow, 'revision' | 'updated_at'>,
  payload: unknown,
): { ok: true } | { ok: false; code: string; error: string } {
  if (!isPreconditionRequiredForOps(stage, opType)) return { ok: true };
  const precondition = readBasePrecondition(payload);
  if (isRevisionOnlyPrecondition(stage)) {
    if (precondition.baseRevision === null) {
      return {
        ok: false,
        code: 'BASE_REVISION_REQUIRED',
        error: 'baseRevision is required for this mutation',
      };
    }
    if (precondition.baseRevision !== doc.revision) {
      return {
        ok: false,
        code: 'STALE_BASE',
        error: 'Document changed since baseRevision',
      };
    }
    return { ok: true };
  }

  if (precondition.baseRevision === null && precondition.baseUpdatedAt === null) {
    return {
      ok: false,
      code: 'MISSING_BASE',
      error: 'baseRevision or baseUpdatedAt is required for this mutation',
    };
  }
  if (precondition.baseRevision !== null && precondition.baseRevision !== doc.revision) {
    return {
      ok: false,
      code: 'STALE_BASE',
      error: 'Document changed since baseRevision',
    };
  }
  if (precondition.baseUpdatedAt !== null && precondition.baseUpdatedAt !== doc.updated_at) {
    return {
      ok: false,
      code: 'STALE_BASE',
      error: 'Document changed since baseUpdatedAt',
    };
  }
  return { ok: true };
}

export function validateEditPrecondition(
  stage: MutationContractStage,
  doc: Pick<DocumentRow, 'revision' | 'updated_at'>,
  payload: unknown,
): { ok: true; mode: 'revision' | 'updatedAt'; baseRevision?: number; baseUpdatedAt?: string } | { ok: false; code: string; error: string } {
  const precondition = readBasePrecondition(payload);
  if (isRevisionOnlyPrecondition(stage)) {
    if (precondition.baseRevision === null) {
      return {
        ok: false,
        code: 'BASE_REVISION_REQUIRED',
        error: 'baseRevision is required for edits',
      };
    }
    if (precondition.baseRevision !== doc.revision) {
      return {
        ok: false,
        code: 'STALE_BASE',
        error: 'Document changed since baseRevision',
      };
    }
    return { ok: true, mode: 'revision', baseRevision: precondition.baseRevision };
  }

  if (precondition.baseRevision === null && precondition.baseUpdatedAt === null) {
    return {
      ok: false,
      code: 'MISSING_BASE',
      error: 'baseRevision or baseUpdatedAt is required for edits',
    };
  }

  if (precondition.baseRevision !== null) {
    if (precondition.baseRevision !== doc.revision) {
      return {
        ok: false,
        code: 'STALE_BASE',
        error: 'Document changed since baseRevision',
      };
    }
    return { ok: true, mode: 'revision', baseRevision: precondition.baseRevision };
  }

  if (precondition.baseUpdatedAt !== null && precondition.baseUpdatedAt !== doc.updated_at) {
    return {
      ok: false,
      code: 'STALE_BASE',
      error: 'Document changed since baseUpdatedAt',
    };
  }
  return { ok: true, mode: 'updatedAt', baseUpdatedAt: precondition.baseUpdatedAt ?? doc.updated_at };
}
