/**
 * Mention detection for comment and reply text.
 *
 * Detects @-mentions in plain text and returns structured match data.
 * Uses the same `@proof` pattern from `src/agent/trigger-service.ts` for
 * consistency, but also captures arbitrary `@username` mentions.
 */

export interface MentionMatch {
  /** The target username/identifier (without the leading `@`). */
  target: string;
  /** The full matched text including the `@` prefix. */
  text: string;
  /** Character index of the `@` in the source string. */
  index: number;
}

const MENTION_PATTERN = /@(\w+)\b/g;

/**
 * Scan `text` for @-mentions and return all matches.
 *
 * The regex is intentionally simple (`/@(\w+)\b/g`) — it matches
 * `@proof`, `@alice`, `@agent_1`, etc.
 */
export function detectMentions(text: string): MentionMatch[] {
  const matches: MentionMatch[] = [];
  const pattern = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags);
  for (const match of text.matchAll(pattern)) {
    if (typeof match.index === 'number' && match[1]) {
      matches.push({
        target: match[1],
        text: match[0],
        index: match.index,
      });
    }
  }
  return matches;
}
