import { getMarkColor } from '../formats/marks.js';
import {
  getAuthoredDecorationStyle,
  resolveAuthoredBlockColor,
} from '../editor/plugins/authorship-color.js';

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

test('returns mixed when a block contains both explicit human and AI authorship', () => {
  const color = resolveAuthoredBlockColor({
    human: 7,
    ai: 134,
    system: 0,
    explicitHuman: 7,
    explicitAI: 127,
  });

  assertEqual(color, getMarkColor('mixed'));
});

test('does not mark a block as mixed when AI coverage only comes from unmarked fallback text', () => {
  const color = resolveAuthoredBlockColor({
    human: 7,
    ai: 40,
    system: 0,
    explicitHuman: 7,
    explicitAI: 0,
  });

  assertEqual(color, getMarkColor('ai'));
});

test('preserves system override over mixed authorship', () => {
  const color = resolveAuthoredBlockColor({
    human: 7,
    ai: 134,
    system: 12,
    explicitHuman: 7,
    explicitAI: 127,
  });

  assertEqual(color, getMarkColor('system'));
});

test('returns mint inline tint for human-authored spans', () => {
  const style = getAuthoredDecorationStyle('human:user');
  assertEqual(
    style,
    'box-shadow: inset 0 -0.38em rgba(110, 231, 183, 0.28); border-radius: 2px;'
  );
});

test('returns lavender inline tint for AI-authored spans', () => {
  const style = getAuthoredDecorationStyle('ai:test');
  assertEqual(
    style,
    'box-shadow: inset 0 -0.38em rgba(165, 180, 252, 0.24); border-radius: 2px;'
  );
});

test('returns no inline tint for unknown actors', () => {
  const style = getAuthoredDecorationStyle('someone:else');
  assertEqual(style, '');
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
