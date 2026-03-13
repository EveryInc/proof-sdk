function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_REWRITE_CHANGES = 1000;

export function validateRewriteApplyPayload(payload: Record<string, unknown>): string | null {
  const hasDirectContent = typeof payload.content === 'string';
  const hasChanges = Array.isArray(payload.changes);
  if (!hasDirectContent && !hasChanges) {
    return 'Missing content parameter';
  }
  if (hasDirectContent && hasChanges) {
    return 'Provide either content or changes, not both';
  }

  if (hasDirectContent) {
    const content = payload.content as string;
    if (!content.trim()) {
      return 'rewrite content must not be empty';
    }
  } else {
    const changes = payload.changes as unknown[];
    if (changes.length > MAX_REWRITE_CHANGES) {
      return `Too many changes; limit is ${MAX_REWRITE_CHANGES}`;
    }
    for (const change of changes) {
      if (!isRecord(change)) {
        return 'Invalid changes payload';
      }
      const find = typeof change.find === 'string' ? change.find : '';
      const replace = typeof change.replace === 'string' ? change.replace : null;
      if (!find || replace === null) {
        return 'Each /rewrite change requires non-empty string fields "find" and "replace".';
      }
    }
  }

  const hasBaseUpdatedAt = payload.baseUpdatedAt !== undefined;
  const baseUpdatedAt = typeof payload.baseUpdatedAt === 'string' ? payload.baseUpdatedAt.trim() : '';
  if (hasBaseUpdatedAt && !baseUpdatedAt) {
    return 'Invalid baseUpdatedAt';
  }

  const hasBaseRevision = payload.baseRevision !== undefined || payload.expectedRevision !== undefined;
  const rawBaseRevision = payload.baseRevision ?? payload.expectedRevision;
  if (
    payload.baseRevision !== undefined
    && payload.expectedRevision !== undefined
    && payload.baseRevision !== payload.expectedRevision
  ) {
    return 'Conflicting baseRevision and expectedRevision';
  }
  if (hasBaseRevision) {
    if (!Number.isInteger(rawBaseRevision) || (rawBaseRevision as number) < 1) {
      return 'Invalid baseRevision';
    }
  }

  if (!hasBaseRevision) {
    return 'rewrite.apply requires baseRevision (or expectedRevision)';
  }

  return null;
}
