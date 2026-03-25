import { getMarkColor, isAI, isHuman, isSystem } from '../../formats/marks.js';

export interface AuthoredBlockColorCounts {
  human: number;
  ai: number;
  system: number;
  explicitHuman: number;
  explicitAI: number;
}

const AUTHORED_DECORATION_STYLES = {
  human: 'box-shadow: inset 0 -0.38em rgba(110, 231, 183, 0.28); border-radius: 2px;',
  ai: 'box-shadow: inset 0 -0.38em rgba(165, 180, 252, 0.24); border-radius: 2px;',
  system: 'box-shadow: inset 0 -0.38em rgba(147, 197, 253, 0.26); border-radius: 2px;',
} as const;

export function resolveAuthoredBlockColor(counts: AuthoredBlockColorCounts): string | null {
  const { human, ai, system, explicitHuman, explicitAI } = counts;

  if (system > 0) return getMarkColor('system');
  if (human === 0 && ai === 0) return null;

  // Keep same-block inline human edits visible even when AI text still dominates.
  if (explicitHuman > 0 && explicitAI > 0) {
    return getMarkColor('mixed');
  }

  return ai >= human ? getMarkColor('ai') : getMarkColor('human');
}

export function getAuthoredDecorationStyle(actor: string): string {
  if (isHuman(actor)) return AUTHORED_DECORATION_STYLES.human;
  if (isAI(actor)) return AUTHORED_DECORATION_STYLES.ai;
  if (isSystem(actor)) return AUTHORED_DECORATION_STYLES.system;
  return '';
}
