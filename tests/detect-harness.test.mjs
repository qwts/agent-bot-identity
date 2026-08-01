import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectAgentHarness, detectHarness } from '../detect-harness.mjs';

const cfg = { prefix: 'you' };

test('Claude Code is detected from CLAUDECODE', () => {
  assert.equal(detectHarness({ CLAUDECODE: '1' }), 'claude');
});

test('Claude Code is detected from AI_AGENT/entrypoint markers too', () => {
  assert.equal(detectHarness({ AI_AGENT: 'claude-code_2_agent' }), 'claude');
  assert.equal(detectHarness({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'claude');
});

test('Codex is detected from a CODEX_ marker', () => {
  assert.equal(detectHarness({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
});

test('Cursor is detected and beats VS Code despite the shared vscode TERM_PROGRAM', () => {
  assert.equal(
    detectHarness({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.x.cursor' }),
    'cursor',
  );
});

test('VS Code is detected from TERM_PROGRAM when no Cursor marker is present', () => {
  assert.equal(detectHarness({ TERM_PROGRAM: 'vscode' }), 'vscode');
});

test('a bare shell resolves to no harness (stays human)', () => {
  assert.equal(detectHarness({ PATH: '/usr/bin', HOME: '/home/x' }), null);
});

test('a malformed env value never throws', () => {
  assert.doesNotThrow(() => detectHarness({ __CFBundleIdentifier: undefined, AI_AGENT: 123 }));
});

test('agent-process detection maps harness keys through config to slugs', () => {
  assert.equal(detectAgentHarness({ CODEX_SANDBOX: 'seatbelt' }, cfg), 'you-codex-agent');
  assert.equal(detectAgentHarness({ CLAUDECODE: '1' }, cfg), 'you-claude-agent');
  assert.equal(detectAgentHarness({ AI_AGENT: 'cursor-agent' }, cfg), 'you-cursor-agent');
  assert.equal(
    detectAgentHarness({ GH_AGENT_APP: 'you-codex-sol-agent' }, cfg),
    'you-codex-sol-agent',
  );
});

test('agent-process detection returns GH_AGENT_APP as-is for any non-empty value', () => {
  assert.equal(detectAgentHarness({ GH_AGENT_APP: 'custom-bot' }, cfg), 'custom-bot');
  assert.equal(detectAgentHarness({ GH_AGENT_APP: '  pinned-slug  ' }, {}), 'pinned-slug');
});

test('without config, agent-process detection yields null even with harness markers', () => {
  assert.equal(detectAgentHarness({ CLAUDECODE: '1' }, {}), null);
  assert.equal(detectAgentHarness({ CODEX_SANDBOX: 'seatbelt' }, {}), null);
});

test('agent-process detection ignores editor-only terminals', () => {
  assert.equal(detectAgentHarness({ TERM_PROGRAM: 'vscode' }, cfg), null);
  assert.equal(detectAgentHarness({ VSCODE_CWD: '/tmp' }, cfg), null);
  assert.equal(detectAgentHarness({ CURSOR_TRACE_ID: 'human-terminal' }, cfg), null);
});
