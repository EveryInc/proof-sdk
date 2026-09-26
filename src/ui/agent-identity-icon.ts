export const AGENT_FACE_VARIANTS = [
  'blue',
  'lime',
  'mint',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
] as const;

export type AgentFamily = (typeof AGENT_FACE_VARIANTS)[number];
export type AgentFaceVariant = AgentFamily;

type AgentIdentityInput = {
  id?: unknown;
  name?: unknown;
  skill?: unknown;
  actor?: unknown;
  avatar?: unknown;
};

type AgentFacePalette = {
  variant: AgentFaceVariant;
  accent: string;
  ring: string;
  shadow: string;
};

type AgentFaceMarkupOptions = {
  family?: AgentFamily;
  input?: AgentIdentityInput;
  size?: number;
  className?: string;
  title?: string;
};

type AgentFaceElementOptions = AgentFaceMarkupOptions & {
  wrapperClassName?: string;
};

const FACE_PALETTES: Record<AgentFaceVariant, AgentFacePalette> = {
  blue: { variant: 'blue', accent: '#2F80FF', ring: 'rgba(47,128,255,0.18)', shadow: 'rgba(47,128,255,0.22)' },
  lime: { variant: 'lime', accent: '#A3C600', ring: 'rgba(163,198,0,0.18)', shadow: 'rgba(163,198,0,0.22)' },
  mint: { variant: 'mint', accent: '#3DC79A', ring: 'rgba(61,199,154,0.18)', shadow: 'rgba(61,199,154,0.22)' },
  orange: { variant: 'orange', accent: '#FF8A3D', ring: 'rgba(255,138,61,0.18)', shadow: 'rgba(255,138,61,0.22)' },
  pink: { variant: 'pink', accent: '#F45CAB', ring: 'rgba(244,92,171,0.18)', shadow: 'rgba(244,92,171,0.22)' },
  purple: { variant: 'purple', accent: '#8B6BFF', ring: 'rgba(139,107,255,0.18)', shadow: 'rgba(139,107,255,0.22)' },
  red: { variant: 'red', accent: '#F15B5B', ring: 'rgba(241,91,91,0.18)', shadow: 'rgba(241,91,91,0.22)' },
  yellow: { variant: 'yellow', accent: '#E4B90A', ring: 'rgba(228,185,10,0.18)', shadow: 'rgba(228,185,10,0.22)' },
};

const FACE_ASSET_URLS: Record<AgentFaceVariant, string> = {
  blue: new URL('./assets/agent-icons/blue.png', import.meta.url).href,
  lime: new URL('./assets/agent-icons/lime.png', import.meta.url).href,
  mint: new URL('./assets/agent-icons/mint.png', import.meta.url).href,
  orange: new URL('./assets/agent-icons/orange.png', import.meta.url).href,
  pink: new URL('./assets/agent-icons/pink.png', import.meta.url).href,
  purple: new URL('./assets/agent-icons/purple.png', import.meta.url).href,
  red: new URL('./assets/agent-icons/red.png', import.meta.url).href,
  yellow: new URL('./assets/agent-icons/yellow.png', import.meta.url).href,
};

const runtimeAgentFaceAssignments = new Map<string, AgentFaceVariant>();
const VOLATILE_AGENT_ID_PREFIXES = ['session-'];

const AI_MARKERS = [
  'ai:',
  'agent',
  'assistant',
  'claude',
  'chatgpt',
  'openai',
  'gemini',
  'google',
  'cursor',
  'gpt',
  'codex',
];

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentityKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collectSignals(input: AgentIdentityInput): string[] {
  return [
    normalizeString(input.id),
    normalizeString(input.name),
    normalizeString(input.skill),
    normalizeString(input.actor),
    normalizeString(input.avatar),
  ].filter(Boolean);
}

function hashIdentityKey(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolvePreferredVariant(key: string): AgentFaceVariant {
  const normalizedKey = normalizeIdentityKey(key);
  const index = hashIdentityKey(normalizedKey) % AGENT_FACE_VARIANTS.length;
  return AGENT_FACE_VARIANTS[index] ?? 'purple';
}

function assignRuntimeVariant(key: string): AgentFaceVariant {
  const normalizedKey = normalizeIdentityKey(key);
  const existing = runtimeAgentFaceAssignments.get(normalizedKey);
  if (existing) return existing;

  const variant = resolvePreferredVariant(normalizedKey);
  runtimeAgentFaceAssignments.set(normalizedKey, variant);
  return variant;
}

function resolveVariantFromAvatar(value: string): AgentFaceVariant | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  for (const variant of AGENT_FACE_VARIANTS) {
    if (lower.includes(`/agent-icons/${variant}.`) || lower.includes(`${variant}.svg`) || lower.includes(`${variant}.png`)) {
      return variant;
    }
  }
  return null;
}

function resolveAgentIdentityKey(input: AgentIdentityInput): string | null {
  const actor = normalizeString(input.actor);
  if (actor) {
    const normalizedActor = actor.toLowerCase().startsWith('ai:')
      ? actor.slice(3)
      : actor;
    const key = normalizeIdentityKey(normalizedActor);
    if (key) return key;
  }

  const skill = normalizeIdentityKey(normalizeString(input.skill));
  if (skill) return skill;

  const id = normalizeString(input.id);
  if (id) {
    const normalizedId = normalizeIdentityKey(id);
    const isVolatileId = VOLATILE_AGENT_ID_PREFIXES.some((prefix) => normalizedId.startsWith(prefix));
    if (!isVolatileId) return normalizedId;
  }

  const name = normalizeIdentityKey(normalizeString(input.name));
  if (name) return name;

  return null;
}

export function resolveAgentFamily(input: AgentIdentityInput): AgentFamily {
  const avatarVariant = resolveVariantFromAvatar(normalizeString(input.avatar));
  if (avatarVariant) return avatarVariant;

  const assignmentKey = resolveAgentIdentityKey(input);
  if (assignmentKey) return assignRuntimeVariant(assignmentKey);

  return 'purple';
}

export function assignDistinctAgentFamilies(agentIds: Iterable<string>): Map<string, AgentFamily> {
  const normalizedIds = Array.from(new Set(
    Array.from(agentIds)
      .map((agentId) => normalizeString(agentId))
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));

  const assignments = new Map<string, AgentFamily>();
  const used = new Set<AgentFamily>();

  for (const agentId of normalizedIds) {
    const preferred = resolvePreferredVariant(agentId);
    let choice = preferred;
    if (used.has(choice)) {
      const startIndex = AGENT_FACE_VARIANTS.indexOf(preferred);
      for (let offset = 1; offset < AGENT_FACE_VARIANTS.length; offset += 1) {
        const candidate = AGENT_FACE_VARIANTS[(startIndex + offset) % AGENT_FACE_VARIANTS.length] ?? preferred;
        if (!used.has(candidate)) {
          choice = candidate;
          break;
        }
      }
    }
    assignments.set(agentId, choice);
    used.add(choice);
  }

  return assignments;
}

export function isAgentIdentity(input: AgentIdentityInput): boolean {
  if (resolveVariantFromAvatar(normalizeString(input.avatar))) return true;
  const signal = collectSignals(input).join(' ').toLowerCase();
  return AI_MARKERS.some((marker) => signal.includes(marker));
}

export function getAgentFaceVariant(family: AgentFamily): AgentFaceVariant {
  return family;
}

export function getAgentFacePalette(family: AgentFamily): AgentFacePalette {
  return FACE_PALETTES[getAgentFaceVariant(family)];
}

export function getAgentFaceAssetUrl(family: AgentFamily): string {
  return FACE_ASSET_URLS[getAgentFaceVariant(family)];
}

export function createAgentFaceSvgMarkup(options: AgentFaceMarkupOptions = {}): string {
  const family = options.family ?? resolveAgentFamily(options.input ?? {});
  const variant = getAgentFaceVariant(family);
  const palette = getAgentFacePalette(family);
  const size = options.size ?? 20;
  const imgClass = options.className?.trim() ? ` class="${escapeHtml(options.className.trim())}"` : '';
  const label = options.title?.trim();
  const a11y = label
    ? ` role="img" aria-label="${escapeHtml(label)}"`
    : ' aria-hidden="true"';

  return `
    <img src="${escapeHtml(getAgentFaceAssetUrl(family))}" width="${size}" height="${size}"${imgClass} data-agent-family="${variant}" data-agent-variant="${variant}" data-agent-accent="${palette.accent}"${a11y} />
  `.trim();
}

function injectAgentFaceStyles(): void {
  if (document.getElementById('proof-agent-face-styles')) return;
  const style = document.createElement('style');
  style.id = 'proof-agent-face-styles';
  style.textContent = `
    .proof-agent-face { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; border-radius: 999px; }
    .proof-agent-face img { display: block; border-radius: 999px; }
    .proof-agent-face[data-agent-family="blue"] img { box-shadow: 0 0 0 1px rgba(47,128,255,0.18); }
    .proof-agent-face[data-agent-family="lime"] img { box-shadow: 0 0 0 1px rgba(163,198,0,0.18); }
    .proof-agent-face[data-agent-family="mint"] img { box-shadow: 0 0 0 1px rgba(61,199,154,0.18); }
    .proof-agent-face[data-agent-family="orange"] img { box-shadow: 0 0 0 1px rgba(255,138,61,0.18); }
    .proof-agent-face[data-agent-family="pink"] img { box-shadow: 0 0 0 1px rgba(244,92,171,0.18); }
    .proof-agent-face[data-agent-family="purple"] img { box-shadow: 0 0 0 1px rgba(139,107,255,0.18); }
    .proof-agent-face[data-agent-family="red"] img { box-shadow: 0 0 0 1px rgba(241,91,91,0.18); }
    .proof-agent-face[data-agent-family="yellow"] img { box-shadow: 0 0 0 1px rgba(228,185,10,0.18); }
  `;
  document.head.appendChild(style);
}

export function createAgentFaceElement(options: AgentFaceElementOptions = {}): HTMLSpanElement {
  injectAgentFaceStyles();
  const family = options.family ?? resolveAgentFamily(options.input ?? {});
  const variant = getAgentFaceVariant(family);
  const size = options.size ?? 20;
  const wrapper = document.createElement('span');
  const wrapperClassName = options.wrapperClassName?.trim();
  wrapper.className = ['proof-agent-face', wrapperClassName].filter(Boolean).join(' ');
  wrapper.dataset.agentFamily = variant;
  wrapper.dataset.agentVariant = variant;

  const img = document.createElement('img');
  img.src = getAgentFaceAssetUrl(family);
  img.alt = options.title?.trim() ?? '';
  img.width = size;
  img.height = size;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.className = options.className?.trim() ?? '';
  img.dataset.agentFamily = variant;
  img.dataset.agentVariant = variant;
  if (!options.title?.trim()) {
    img.setAttribute('aria-hidden', 'true');
  }

  wrapper.appendChild(img);
  return wrapper;
}

export function resetAgentFaceAssignmentsForTests(): void {
  runtimeAgentFaceAssignments.clear();
}
