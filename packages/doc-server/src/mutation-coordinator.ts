type JsonObject = Record<string, unknown>;

export type MutationErrorCode =
  | 'MISSING_BASE'
  | 'STALE_BASE'
  | 'REWRITE_BARRIER_FAILED'
  | 'ANCHOR_NOT_FOUND'
  | 'COLLAB_SYNC_FAILED'
  | 'INVALID_OPERATIONS'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR';

export interface MutationAdapterContext {
  route: string;
  slug?: string;
  retryWithState?: string;
}

function parseEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isMutationCoordinatorEnabled(): boolean {
  return parseEnabled(process.env.PROOF_MUTATION_COORDINATOR_ENABLED);
}

function asObject(value: unknown): JsonObject {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value as JsonObject : {};
}

function getMessage(body: JsonObject): string {
  if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  return 'Mutation request failed';
}

function normalizeKnownCode(code: unknown): MutationErrorCode | string | undefined {
  if (typeof code !== 'string' || !code.trim()) return undefined;
  const normalized = code.trim().toUpperCase();
  if (
    normalized === 'MISSING_BASE'
    || normalized === 'STALE_BASE'
    || normalized === 'REWRITE_BARRIER_FAILED'
    || normalized === 'ANCHOR_NOT_FOUND'
    || normalized === 'COLLAB_SYNC_FAILED'
    || normalized === 'INVALID_OPERATIONS'
    || normalized === 'INVALID_REQUEST'
    || normalized === 'INTERNAL_ERROR'
  ) {
    return normalized as MutationErrorCode;
  }
  return normalized;
}

function inferCodeFromBody(status: number, body: JsonObject): MutationErrorCode | string {
  const explicit = normalizeKnownCode(body.code);
  if (explicit) return explicit;

  const error = typeof body.error === 'string' ? body.error.toLowerCase() : '';
  if (error.includes('baseupdatedat is required') || error.includes('missing base')) return 'MISSING_BASE';
  if (error.includes('stale') || error.includes('changed since base') || error.includes('concurrently')) return 'STALE_BASE';
  if (error.includes('barrier') && error.includes('failed')) return 'REWRITE_BARRIER_FAILED';
  if (error.includes('anchor') && error.includes('not found')) return 'ANCHOR_NOT_FOUND';
  if (error.includes('collab') && (error.includes('sync') || error.includes('projection'))) return 'COLLAB_SYNC_FAILED';
  if (error.includes('invalid operation') || error.includes('invalid payload')) return 'INVALID_OPERATIONS';
  if (status >= 400 && status < 500) return 'INVALID_REQUEST';
  return 'INTERNAL_ERROR';
}

function stripCoreFields(body: JsonObject): JsonObject {
  const details: JsonObject = { ...body };
  delete details.success;
  delete details.code;
  delete details.error;
  delete details.message;
  delete details.retryWithState;
  return details;
}

export function adaptMutationResponse(
  status: number,
  bodyLike: unknown,
  context: MutationAdapterContext,
): { status: number; body: JsonObject } {
  const body = asObject(bodyLike);
  if (!isMutationCoordinatorEnabled()) {
    return { status, body };
  }

  const success = status >= 200 && status < 300 && body.success !== false;
  if (success) {
    return {
      status,
      body: {
        success: true,
        route: context.route,
        slug: context.slug,
        data: body,
      },
    };
  }

  const code = inferCodeFromBody(status, body);
  const retryWithState = typeof body.retryWithState === 'string' && body.retryWithState.trim()
    ? body.retryWithState
    : context.retryWithState;
  const details = stripCoreFields(body);
  return {
    status,
    body: {
      success: false,
      code,
      message: getMessage(body),
      retryWithState,
      route: context.route,
      slug: context.slug,
      details,
    },
  };
}
