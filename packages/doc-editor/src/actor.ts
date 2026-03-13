const DEFAULT_ACTOR = 'human:user';

let currentActor = DEFAULT_ACTOR;

export function normalizeActor(actor?: string): string {
  if (!actor) return DEFAULT_ACTOR;
  const trimmed = actor.trim();
  if (!trimmed) return DEFAULT_ACTOR;
  if (trimmed.startsWith('human:') || trimmed.startsWith('ai:')) return trimmed;
  return `human:${trimmed}`;
}

export function setCurrentActor(actor?: string): string {
  currentActor = normalizeActor(actor);
  return currentActor;
}

export function getCurrentActor(): string {
  return currentActor;
}
