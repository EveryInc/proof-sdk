function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export type ExplicitAgentIdentityResolution =
  | { kind: 'missing' }
  | { kind: 'invalid'; rawId: string }
  | {
    kind: 'ok';
    id: string;
    name: string;
    color?: string;
    avatar?: string;
  };

export function normalizeAgentScopedId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith('human:')) return null;

  if (!trimmed.includes(':')) return `ai:${trimmed}`;
  if (normalized.startsWith('ai:') || normalized.startsWith('agent:')) return trimmed;
  return null;
}

export function isAgentScopedId(raw: unknown): boolean {
  return normalizeAgentScopedId(raw) !== null;
}

export function deriveAgentNameFromId(id: string): string {
  const normalized = normalizeAgentScopedId(id) ?? id.trim();
  const base = normalized.replace(/^(ai:|agent:)/i, '').trim();
  if (!base) return normalized;

  return base
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');
}

export function resolveExplicitAgentIdentity(
  body: Record<string, unknown>,
  headerAgentId?: unknown,
): ExplicitAgentIdentityResolution {
  const agent = isRecord(body.agent) ? body.agent : null;
  const rawId = firstNonEmptyString(headerAgentId, body.agentId, agent?.id);
  if (!rawId) return { kind: 'missing' };

  const id = normalizeAgentScopedId(rawId);
  if (!id) return { kind: 'invalid', rawId };

  return {
    kind: 'ok',
    id,
    name: firstNonEmptyString(body.name, agent?.name) ?? deriveAgentNameFromId(id),
    color: firstNonEmptyString(body.color, agent?.color) ?? undefined,
    avatar: firstNonEmptyString(body.avatar, agent?.avatar) ?? undefined,
  };
}
