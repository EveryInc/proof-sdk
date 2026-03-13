import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const suggestionsSource = readFileSync(
    path.resolve(process.cwd(), 'packages/doc-editor/src/plugins/suggestions.ts'),
    'utf8',
  );
  const agentCursorBridgeSource = readFileSync(
    path.resolve(process.cwd(), 'packages/doc-editor/src/plugins/agent-cursor-bridge.ts'),
    'utf8',
  );

  assert(
    /stepJson\.stepType === 'replaceAround'[\s\S]*stepJson\.stepType === 'addMark'[\s\S]*stepJson\.stepType === 'removeMark'/.test(suggestionsSource),
    'Expected extracted suggestions plugin to preserve pass-through handling for structural and mark steps',
  );

  assert(
    suggestionsSource.includes("const result = step.apply(newTr.doc);"),
    'Expected extracted suggestions plugin to preserve generic step application fallback',
  );

  assert(
    suggestionsSource.includes("newTr.setMeta('suggestions-wrapped', true);"),
    'Expected extracted suggestions plugin to tag wrapped transactions',
  );

  assert(
    suggestionsSource.includes('newTr.setSelection(TextSelection.create(newTr.doc, safeTo));'),
    'Expected extracted suggestions plugin to preserve replace-selection behavior',
  );

  assert(
    agentCursorBridgeSource.includes('function getExistingAgentCursorMeta(view: EditorView)'),
    'Expected extracted agent cursor bridge to read existing cursor metadata',
  );

  assert(
    agentCursorBridgeSource.includes('agentLabel: existing.agentLabel,')
      && agentCursorBridgeSource.includes('agentKind: existing.agentKind,'),
    'Expected extracted agent cursor bridge to preserve existing label and kind',
  );

  console.log('editor-package-regressions.test.ts passed');
}

run();
