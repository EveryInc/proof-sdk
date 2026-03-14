import { randomUUID } from 'node:crypto';
import { getStoredIdempotencyRecord, storeIdempotencyResult } from './db.js';
import { traceServerIncident } from './incident-tracing.js';

const DEFAULT_PENDING_LEASE_MS = parsePositiveInt(process.env.PROOF_IDEMPOTENCY_PENDING_LEASE_MS, 30_000);

type PendingReservation = {
  requestHash: string;
  ownerToken: string;
  leaseExpiresAtMs: number;
};

const pendingReservations = new Map<string, PendingReservation>();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function reservationKey(documentSlug: string, route: string, idempotencyKey: string): string {
  return `${documentSlug}::${route}::${idempotencyKey}`;
}

function getPendingReservation(
  documentSlug: string,
  route: string,
  idempotencyKey: string,
): PendingReservation | null {
  const key = reservationKey(documentSlug, route, idempotencyKey);
  const entry = pendingReservations.get(key);
  if (!entry) return null;
  if (entry.leaseExpiresAtMs > Date.now()) return entry;
  pendingReservations.delete(key);
  return null;
}

export type MutationReservation = {
  documentSlug: string;
  route: string;
  idempotencyKey: string;
  requestHash: string;
  ownerToken: string;
};

export type MutationIdempotencyBeginResult =
  | { kind: 'execute'; reservation: MutationReservation }
  | { kind: 'replay'; statusCode: number; response: Record<string, unknown> }
  | { kind: 'mismatch' }
  | { kind: 'in_progress'; retryAfterSeconds: number }
  | { kind: 'result_unknown' };

export async function beginMutationReservation(args: {
  documentSlug: string;
  route: string;
  idempotencyKey: string;
  requestHash: string;
  mutationRoute: string;
  subsystem: string;
  slug: string;
  retryWithState?: string;
  leaseMs?: number;
  waitTimeoutMs?: number;
  waitPollMs?: number;
}): Promise<MutationIdempotencyBeginResult> {
  const {
    documentSlug,
    route,
    idempotencyKey,
    requestHash,
    mutationRoute,
    subsystem,
    slug,
    leaseMs = DEFAULT_PENDING_LEASE_MS,
  } = args;

  const stored = getStoredIdempotencyRecord(documentSlug, route, idempotencyKey);
  if (stored) {
    if (stored.requestHash && stored.requestHash !== requestHash) {
      return { kind: 'mismatch' };
    }
    return {
      kind: 'replay',
      statusCode: 200,
      response: stored.response,
    };
  }

  const pending = getPendingReservation(documentSlug, route, idempotencyKey);
  if (pending) {
    if (pending.requestHash !== requestHash) return { kind: 'mismatch' };
    return {
      kind: 'in_progress',
      retryAfterSeconds: Math.max(1, Math.ceil((pending.leaseExpiresAtMs - Date.now()) / 1000)),
    };
  }

  const reservation: MutationReservation = {
    documentSlug,
    route,
    idempotencyKey,
    requestHash,
    ownerToken: randomUUID(),
  };
  pendingReservations.set(
    reservationKey(documentSlug, route, idempotencyKey),
    {
      requestHash,
      ownerToken: reservation.ownerToken,
      leaseExpiresAtMs: Date.now() + leaseMs,
    },
  );

  traceServerIncident({
    slug,
    subsystem,
    level: 'info',
    eventType: 'mutation_idempotency.reserved',
    message: 'Reserved mutation idempotency key before execution',
    data: {
      route: mutationRoute,
      idempotencyKey,
    },
  });

  return { kind: 'execute', reservation };
}

export function completeMutationReservation(
  reservation: MutationReservation | null,
  response: Record<string, unknown>,
  statusCode: number,
  options?: { tombstoneRevision?: number | null; mutationRoute?: string; subsystem?: string; slug?: string },
): void {
  if (!reservation) return;
  const key = reservationKey(reservation.documentSlug, reservation.route, reservation.idempotencyKey);
  const pending = getPendingReservation(reservation.documentSlug, reservation.route, reservation.idempotencyKey);
  if (!pending || pending.ownerToken !== reservation.ownerToken) return;
  pendingReservations.delete(key);
  storeIdempotencyResult(
    reservation.documentSlug,
    reservation.route,
    reservation.idempotencyKey,
    response,
    reservation.requestHash,
    {
      statusCode,
      tombstoneRevision: options?.tombstoneRevision ?? null,
    },
  );
  if (options?.mutationRoute && options?.subsystem && options?.slug) {
    traceServerIncident({
      slug: options.slug,
      subsystem: options.subsystem,
      level: 'info',
      eventType: 'mutation_idempotency.completed',
      message: 'Completed mutation idempotency reservation with replayable response',
      data: {
        route: options.mutationRoute,
        idempotencyKey: reservation.idempotencyKey,
        statusCode,
      },
    });
  }
}

export function releaseMutationReservation(
  reservation: MutationReservation | null,
  options?: { mutationRoute?: string; subsystem?: string; slug?: string; reason?: string },
): void {
  if (!reservation) return;
  const key = reservationKey(reservation.documentSlug, reservation.route, reservation.idempotencyKey);
  const pending = getPendingReservation(reservation.documentSlug, reservation.route, reservation.idempotencyKey);
  if (!pending || pending.ownerToken !== reservation.ownerToken) return;
  pendingReservations.delete(key);
  if (options?.mutationRoute && options?.subsystem && options?.slug) {
    traceServerIncident({
      slug: options.slug,
      subsystem: options.subsystem,
      level: 'info',
      eventType: 'mutation_idempotency.released',
      message: 'Released pending mutation idempotency reservation without durable success',
      data: {
        route: options.mutationRoute,
        idempotencyKey: reservation.idempotencyKey,
        reason: options.reason ?? 'request_failed_before_commit',
      },
    });
  }
}
