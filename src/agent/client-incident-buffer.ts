export type ClientIncidentEvent = {
  type: string;
  level?: 'info' | 'warn' | 'error';
  message?: string | null;
  data?: Record<string, unknown>;
  timestamp?: string;
};

const MAX_CLIENT_INCIDENT_EVENTS = 200;
const EVENTS_KEY = '__PROOF_SDK_CLIENT_INCIDENT_EVENTS__';

type InstrumentedWindow = Window & {
  [EVENTS_KEY]?: ClientIncidentEvent[];
};

function getEventsStore(): ClientIncidentEvent[] {
  if (typeof window === 'undefined') return [];
  const instrumentedWindow = window as InstrumentedWindow;
  if (!Array.isArray(instrumentedWindow[EVENTS_KEY])) {
    instrumentedWindow[EVENTS_KEY] = [];
  }
  return instrumentedWindow[EVENTS_KEY]!;
}

export function recordClientIncidentEvent(event: ClientIncidentEvent): void {
  if (typeof window === 'undefined') return;
  const trimmedType = event.type.trim();
  if (!trimmedType) return;

  const events = getEventsStore();
  events.push({
    type: trimmedType,
    level: event.level ?? 'info',
    message: event.message ?? null,
    data: event.data ?? {},
    timestamp: event.timestamp ?? new Date().toISOString(),
  });

  if (events.length > MAX_CLIENT_INCIDENT_EVENTS) {
    events.splice(0, events.length - MAX_CLIENT_INCIDENT_EVENTS);
  }
}

export function getClientIncidentEvents(limit: number = 50): ClientIncidentEvent[] {
  const events = getEventsStore();
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
  if (normalizedLimit === 0) return [];
  return events.slice(-normalizedLimit);
}

export function clearClientIncidentEvents(): void {
  const events = getEventsStore();
  events.splice(0, events.length);
}
