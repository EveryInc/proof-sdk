import type { DocumentRow } from './db.js';
import type { DocumentOpType } from './document-ops.js';
import { isValidMutationBaseToken } from './collab.js';

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

export type BasePrecondition = {
  baseToken: string | null;
  baseRevision: number | null;
  baseUpdatedAt: string | null;
};

export function readBasePrecondition(value: unknown): BasePrecondition {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const baseToken = typeof payload.baseToken === 'string' && payload.baseToken.trim()
    ? payload.baseToken.trim()
    : null;
  const baseRevision = Number.isInteger(payload.baseRevision) ? Number(payload.baseRevision) : null;
  const baseUpdatedAt = typeof payload.baseUpdatedAt === 'string' && payload.baseUpdatedAt.trim()
    ? payload.baseUpdatedAt.trim()
    : null;
  return {
    baseToken,
    baseRevision: baseRevision !== null && baseRevision > 0 ? baseRevision : null,
    baseUpdatedAt,
  };
}

type ValidatedPrecondition =
  | {
      ok: true;
      mode: 'none' | 'token' | 'revision' | 'updatedAt';
      baseToken?: string;
      baseRevision?: number;
      baseUpdatedAt?: string;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
    };

function validateTokenPrecondition(
  precondition: BasePrecondition,
  currentBaseToken: string | null | undefined,
): ValidatedPrecondition | null {
  if (precondition.baseToken === null) return null;
  if (precondition.baseRevision !== null || precondition.baseUpdatedAt !== null) {
    return {
      ok: false,
      status: 409,
      code: 'CONFLICTING_BASE',
      error: 'baseToken cannot be combined with baseRevision or baseUpdatedAt',
    };
  }
  if (!isValidMutationBaseToken(precondition.baseToken)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_BASE_TOKEN',
      error: 'baseToken must be an mt1 token',
    };
  }
  if (!currentBaseToken) {
    return {
      ok: false,
      status: 409,
      code: 'AUTHORITATIVE_BASE_UNAVAILABLE',
      error: 'Authoritative mutation base is unavailable; retry with latest state',
    };
  }
  if (precondition.baseToken !== currentBaseToken) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseToken',
    };
  }
  return { ok: true, mode: 'token', baseToken: precondition.baseToken };
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
  currentBaseToken?: string | null,
): ValidatedPrecondition {
  const precondition = readBasePrecondition(payload);
  const tokenResult = validateTokenPrecondition(precondition, currentBaseToken);
  if (tokenResult) return tokenResult;
  if (!isPreconditionRequiredForOps(stage, opType)) {
    return precondition.baseRevision !== null
      ? { ok: true, mode: 'revision', baseRevision: precondition.baseRevision }
      : precondition.baseUpdatedAt !== null
        ? { ok: true, mode: 'updatedAt', baseUpdatedAt: precondition.baseUpdatedAt }
        : { ok: true, mode: 'none' };
  }
  if (isRevisionOnlyPrecondition(stage)) {
    if (precondition.baseRevision === null) {
      return {
        ok: false,
        status: 409,
        code: 'BASE_REVISION_REQUIRED',
        error: 'baseRevision is required for this mutation',
      };
    }
    if (precondition.baseRevision !== doc.revision) {
      return {
        ok: false,
        status: 409,
        code: 'STALE_BASE',
        error: 'Document changed since baseRevision',
      };
    }
    return { ok: true, mode: 'revision', baseRevision: precondition.baseRevision };
  }

  if (precondition.baseRevision === null && precondition.baseUpdatedAt === null) {
    return {
      ok: false,
      status: 409,
      code: 'MISSING_BASE',
      error: 'baseRevision or baseUpdatedAt is required for this mutation',
    };
  }
  if (precondition.baseRevision !== null && precondition.baseRevision !== doc.revision) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseRevision',
    };
  }
  if (precondition.baseUpdatedAt !== null && precondition.baseUpdatedAt !== doc.updated_at) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseUpdatedAt',
    };
  }
  return precondition.baseRevision !== null
    ? { ok: true, mode: 'revision', baseRevision: precondition.baseRevision }
    : { ok: true, mode: 'updatedAt', baseUpdatedAt: precondition.baseUpdatedAt as string };
}

export function validateEditPrecondition(
  stage: MutationContractStage,
  doc: Pick<DocumentRow, 'revision' | 'updated_at'>,
  payload: unknown,
  currentBaseToken?: string | null,
): ValidatedPrecondition {
  const precondition = readBasePrecondition(payload);
  const tokenResult = validateTokenPrecondition(precondition, currentBaseToken);
  if (tokenResult) return tokenResult;
  if (isRevisionOnlyPrecondition(stage)) {
    if (precondition.baseRevision === null) {
      return {
        ok: false,
        status: 409,
        code: 'BASE_REVISION_REQUIRED',
        error: 'baseRevision is required for edits',
      };
    }
    if (precondition.baseRevision !== doc.revision) {
      return {
        ok: false,
        status: 409,
        code: 'STALE_BASE',
        error: 'Document changed since baseRevision',
      };
    }
    return { ok: true, mode: 'revision', baseRevision: precondition.baseRevision };
  }

  if (precondition.baseRevision === null && precondition.baseUpdatedAt === null) {
    return {
      ok: false,
      status: 409,
      code: 'MISSING_BASE',
      error: 'baseRevision or baseUpdatedAt is required for edits',
    };
  }

  if (precondition.baseRevision !== null) {
    if (precondition.baseRevision !== doc.revision) {
      return {
        ok: false,
        status: 409,
        code: 'STALE_BASE',
        error: 'Document changed since baseRevision',
      };
    }
    return { ok: true, mode: 'revision', baseRevision: precondition.baseRevision };
  }

  if (precondition.baseUpdatedAt !== null && precondition.baseUpdatedAt !== doc.updated_at) {
    return {
      ok: false,
      status: 409,
      code: 'STALE_BASE',
      error: 'Document changed since baseUpdatedAt',
    };
  }
  return { ok: true, mode: 'updatedAt', baseUpdatedAt: precondition.baseUpdatedAt ?? doc.updated_at };
}
