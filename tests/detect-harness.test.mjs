import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HARNESSES, detectAgentHarness, detectHarness } from '../detect-harness.mjs';

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
  // Devin Desktop's ambient markers come from the IDE extension host, not from
  // an agent — measured, not assumed. See the WINDSURF_*/ACP_BACKEND dump.
  assert.equal(detectAgentHarness({ WINDSURF_IDE_TYPE: 'windsurf' }, cfg), null);
  assert.equal(detectAgentHarness({ ACP_BACKEND: 'windsurf' }, cfg), null);
});

// `vscode` is the fallback for "a human in an editor terminal". Every other
// harness forks or embeds VS Code, so a row appended after it could never match.
test('the vscode row stays last so no harness is shadowed by it', () => {
  assert.equal(HARNESSES.at(-1).key, 'vscode');
});

// Measured from a live Cursor agent session: CURSOR_AGENT=1 marks the agent,
// while CURSOR_TRACE_ID/CURSOR_LAYOUT mark a human's editor.
test('a Cursor agent session is an agent; a Cursor editor terminal is not', () => {
  assert.equal(detectHarness({ CURSOR_AGENT: '1' }), 'cursor');
  assert.equal(detectAgentHarness({ CURSOR_AGENT: '1' }, cfg), 'you-cursor-agent');
  assert.equal(detectAgentHarness({ CURSOR_TRACE_ID: 'x', CURSOR_LAYOUT: 'y' }, cfg), null);
});

// Measured from a live Copilot agent session. AI_AGENT=github_copilot_vscode_agent
// contains the substring "vscode", so an ordering slip here silently attributes
// Copilot's commits to the vscode App.
test('Copilot is not mistaken for VS Code despite "vscode" inside AI_AGENT', () => {
  const env = { COPILOT_AGENT: '1', AI_AGENT: 'github_copilot_vscode_agent', TERM_PROGRAM: 'vscode' };
  assert.equal(detectHarness(env), 'copilot');
  assert.equal(detectAgentHarness(env, cfg), 'you-copilot-agent');
  assert.equal(detectAgentHarness({ AI_AGENT: 'github_copilot_vscode_agent' }, cfg), 'you-copilot-agent');
});

// The rule: agent detection keys on <NAME>_AGENT markers only. A human terminal
// never carries one, so every harness must be reachable by its own marker and by
// nothing ambient.
test('every harness is an agent via its own <NAME>_AGENT marker alone', () => {
  assert.equal(detectAgentHarness({ CLAUDECODE: '1' }, cfg), 'you-claude-agent');
  assert.equal(detectAgentHarness({ CURSOR_AGENT: '1' }, cfg), 'you-cursor-agent');
  assert.equal(detectAgentHarness({ COPILOT_AGENT: '1' }, cfg), 'you-copilot-agent');
  assert.equal(detectAgentHarness({ DEVIN_AGENT: '1' }, cfg), 'you-devin-agent');
  assert.equal(detectAgentHarness({ MUSE_AGENT: '1' }, cfg), 'you-muse-agent');
});

// Meta Muse is keyed `muse` (its territory is .muse/worktrees/, matching its
// ~/.muse config home). MUSE_RELEASE_INFO is set for any terminal the app
// opens — it marks the editor, not an agent. Broad detection may key on it;
// agent attribution may only key on MUSE_AGENT.
test('a Muse agent session is an agent keyed muse; a Muse editor terminal is not', () => {
  assert.equal(detectHarness({ MUSE_RELEASE_INFO: '0.9.1' }), 'muse');
  assert.equal(detectHarness({ AI_AGENT: 'meta_muse' }), 'muse');
  assert.equal(detectHarness({ MUSE_AGENT: '1' }), 'muse');
  assert.equal(detectAgentHarness({ MUSE_RELEASE_INFO: '0.9.1' }, cfg), null);
  assert.equal(detectAgentHarness({ MUSE_AGENT: '1' }, cfg), 'you-muse-agent');
});

test('Devin is detected from its Codeium-era markers but keyed devin', () => {
  assert.equal(detectHarness({ WINDSURF_IDE_TYPE: 'windsurf' }), 'devin');
  assert.equal(detectHarness({ ACP_BACKEND: 'windsurf', VSCODE_PID: '1' }), 'devin');
  assert.equal(
    detectHarness({ __CFBundleIdentifier: 'com.exafunction.windsurf' }),
    'devin',
  );
  assert.equal(detectAgentHarness({ AI_AGENT: 'devin-agent' }, cfg), 'you-devin-agent');
});

test('a plain VS Code terminal still resolves to vscode, not to a forked harness', () => {
  assert.equal(detectHarness({ TERM_PROGRAM: 'vscode', VSCODE_PID: '9' }), 'vscode');
  assert.equal(
    detectHarness({ __CFBundleIdentifier: 'com.microsoft.VSCode' }),
    'vscode',
  );
});
