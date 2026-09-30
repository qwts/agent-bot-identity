import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HARNESSES, accountName, detectAgentHarness, detectHarness } from '../detect-harness.mjs';

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
  assert.equal(detectAgentHarness({ QWEN_CODE: '1' }, cfg), 'you-qwen-agent');
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

// Measured from a live Qwen Code 0.24.6 session: QWEN_CODE=1 plus a
// QWEN_CODE_* family (CLI, SESSION_ID, PROJECT_DIR, MODEL), with AI_AGENT
// unset. Qwen Code is a terminal CLI agent rather than an editor, so
// QWEN_CODE=1 is the CLAUDECODE=1 analogue and both resolvers may key on it.
// QWEN_CODE_AGENT_ID is exported but EMPTY at top level: an existence test
// would attribute every session and a non-empty test would attribute none, so
// neither is used and the rest of the family stays ambient.
test('a Qwen Code session is an agent keyed qwen; its ambient family is not', () => {
  assert.equal(detectHarness({ QWEN_CODE: '1' }), 'qwen');
  assert.equal(detectHarness({ AI_AGENT: 'qwen-code' }), 'qwen');
  assert.equal(detectAgentHarness({ QWEN_CODE: '1' }, cfg), 'you-qwen-agent');
  assert.equal(detectAgentHarness({ QWEN_CODE_AGENT_ID: '' }, cfg), null);
  assert.equal(
    detectAgentHarness({ QWEN_CODE_SESSION_ID: 'x', QWEN_CODE_PROJECT_DIR: '/tmp' }, cfg),
    null,
  );
});

// The ordering invariant that matters for a CLI harness a contributor may run
// inside an editor terminal: the qwen row sits above the vscode fallback, so
// TERM_PROGRAM/VSCODE_* from the surrounding editor cannot claim the session.
test('Qwen Code inside a VS Code terminal is qwen, not vscode', () => {
  assert.equal(
    detectHarness({ QWEN_CODE: '1', TERM_PROGRAM: 'vscode', VSCODE_CWD: '/tmp' }),
    'qwen',
  );
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

// ENG-0339: the macOS account short name is a detection input. An agent
// account is named by its harness's App slug, so the name alone resolves the
// persona — including harnesses that have no env matcher at all.
test('an agent account resolves its harness by name alone', async () => {
  const { accountHarness } = await import('../detect-harness.mjs');
  assert.equal(accountHarness(cfg, 'you-goose-agent'), 'goose');
  assert.equal(accountHarness(cfg, 'you-claude-agent'), 'claude');
  assert.equal(accountHarness({ apps: { warp: 'custom-warp-bot' } }, 'custom-warp-bot'), 'warp');
});

test('the owner account, unknown names, and no config yield no account harness', async () => {
  const { accountHarness } = await import('../detect-harness.mjs');
  assert.equal(accountHarness(cfg, 'user'), null); // delegate mode — human persona
  assert.equal(accountHarness(cfg, 'you-goose'), null); // not slug-shaped
  assert.equal(accountHarness(cfg, 'you-mystery-agent'), null); // not a rostered harness
  assert.equal(accountHarness({}, 'you-goose-agent'), null); // inert without config
  assert.equal(accountHarness(cfg, null), null);
});

test('agent-process detection treats an agent account as that persona', () => {
  // In an agent account even a bare human terminal is the persona — the
  // account, not the directory, is bot territory — and so is any other
  // harness launched there.
  assert.equal(detectAgentHarness({ PATH: '/usr/bin' }, cfg, 'you-goose-agent'), 'you-goose-agent');
  assert.equal(detectAgentHarness({ CLAUDECODE: '1' }, cfg, 'you-goose-agent'), 'you-goose-agent');
  // GH_AGENT_APP stays above the account input.
  assert.equal(detectAgentHarness({ GH_AGENT_APP: 'custom-bot' }, cfg, 'you-goose-agent'), 'custom-bot');
  // The owner's account leaves the marker chain unchanged.
  assert.equal(detectAgentHarness({ CLAUDECODE: '1' }, cfg, 'user'), 'you-claude-agent');
  assert.equal(detectAgentHarness({ PATH: '/usr/bin' }, cfg, 'user'), null);
});

// ENG-0339: AGENT_BOT_ACCOUNT names the account for JS exactly as it does for
// the shell hooks and the gh shim, so a launcher or a test can state the
// account without changing who is logged in.
test('AGENT_BOT_ACCOUNT overrides the OS account name for JS consumers', () => {
  assert.equal(accountName({ AGENT_BOT_ACCOUNT: 'you-goose-agent' }), 'you-goose-agent');
  assert.equal(accountName({ AGENT_BOT_ACCOUNT: '  you-goose-agent \n' }), 'you-goose-agent');
  assert.equal(typeof accountName({}), 'string');
  assert.equal(accountName({ AGENT_BOT_ACCOUNT: '' }), accountName({}));
  assert.equal(detectAgentHarness({ AGENT_BOT_ACCOUNT: 'you-goose-agent' }, cfg), 'you-goose-agent');
});
