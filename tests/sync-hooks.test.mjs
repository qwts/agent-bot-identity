import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANONICAL_EVENTS, DIALECTS, isBlocking, purposeFor, vendorEvent } from '../hook-dialects.mjs';
import { MANAGED_MARKER, eventsFor, hookAdapterDir, hookHomePath, renderConfig, syncHooks, ensureClaudeWorktreeAdapter, inspectClaudeWorktreeAdapter } from '../sync-hooks.mjs';
import { organizationProfileToConfig } from '../organization-profile.mjs';
import { accountSlug } from '../worktree-token.mjs';

const claudeConfig = { apps: { claude: 'example-claude-agent' } };

function adapterFixture() {
  const home = mkdtempSync(join(tmpdir(), 'claude-adapter-'));
  return { home, env: { HOME: home, AGENT_BOT_ACCOUNT: 'example-claude-agent' }, config: claudeConfig };
}

test('account provisioning installs an idempotent Claude transcript adapter without replacing preferences', () => {
  const options = adapterFixture();
  const path = join(options.home, '.claude', 'settings.json');
  mkdirSync(dirname(path), { recursive: true });
  const existing = { permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'foreign-start' }] }] } };
  writeFileSync(path, JSON.stringify(existing));
  assert.equal(inspectClaudeWorktreeAdapter(options).code, 'claude-worktree-adapter-missing');
  assert.equal(ensureClaudeWorktreeAdapter(options).updated, true);
  const text = readFileSync(path, 'utf8');
  const settings = JSON.parse(text);
  assert.deepEqual(settings.permissions, existing.permissions);
  assert.deepEqual(settings.hooks.SessionStart, existing.hooks.SessionStart);
  assert.equal(settings.hooks.WorktreeCreate.length, 1);
  assert.match(settings.hooks.WorktreeCreate[0].hooks[0].command, /worktree-token --account-slug/);
  assert.equal(inspectClaudeWorktreeAdapter(options).status, 'ready');
  assert.equal(ensureClaudeWorktreeAdapter(options).updated, false);
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('installed Claude adapter preserves explicit App selection behind the account gate', () => {
  const options = adapterFixture();
  ensureClaudeWorktreeAdapter(options);
  const settings = JSON.parse(readFileSync(join(options.home, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.WorktreeCreate[0].hooks[0].command;
  const bin = join(options.home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agent-bot'), '#!/bin/sh\nif [ "$1" = worktree-token ]; then printf "%s" "$AGENT_BOT_ACCOUNT"; else printf "%s" "$GH_AGENT_APP"; fi\n', { mode: 0o755 });
  const run = (env) => execFileSync('sh', ['-c', command], {
    env: { PATH: process.env.PATH, ...options.env, ...env }, encoding: 'utf8',
  });
  assert.equal(run({ GH_AGENT_APP: 'example-claude-model-agent' }), 'example-claude-model-agent');
  assert.equal(run({}), 'example-claude-agent');
  assert.equal(run({ GH_AGENT_APP: '' }), 'example-claude-agent');
  assert.equal(run({ AGENT_BOT_ACCOUNT: '', GH_AGENT_APP: 'example-claude-model-agent' }), '');
});

test('human and other harness accounts do not receive Claude settings, regardless of environment markers', () => {
  for (const account of ['owner', 'example-unknown-agent', 'example-codex-agent']) {
    const options = adapterFixture();
    options.env = { ...options.env, AGENT_BOT_ACCOUNT: account, CLAUDECODE: '1', GH_AGENT_APP: 'example-claude-agent' };
    options.config = { apps: { ...claudeConfig.apps, codex: 'example-codex-agent' } };
    assert.equal(ensureClaudeWorktreeAdapter(options).status, 'not_applicable');
    assert.equal(existsSync(join(options.home, '.claude')), false);
  }
});

test('provisioning refuses invalid, disabled, conflicting, and symlinked Claude settings without changing them', () => {
  for (const text of ['not-json-secret', '[]', '{"hooks":[]}', '{"hooks":{"WorktreeCreate":{}}}', '{"hooks":{"WorktreeCreate":null}}',
    '{"disableAllHooks":true}', '{"hooks":{"WorktreeCreate":[{"hooks":[{"type":"command","command":"foreign-create"}]}]}}']) {
    const options = adapterFixture();
    const path = join(options.home, '.claude', 'settings.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    assert.equal(inspectClaudeWorktreeAdapter(options).status, 'failed');
    assert.throws(() => ensureClaudeWorktreeAdapter(options), (error) => {
      assert.doesNotMatch(error.message, /not-json-secret|foreign-create/);
      return true;
    });
    assert.equal(readFileSync(path, 'utf8'), text);
  }
  const options = adapterFixture();
  mkdirSync(join(options.home, '.claude'));
  const target = join(options.home, 'foreign-settings');
  writeFileSync(target, '{}');
  symlinkSync(target, join(options.home, '.claude', 'settings.json'));
  assert.throws(() => ensureClaudeWorktreeAdapter(options), /regular file/);
  assert.equal(readFileSync(target, 'utf8'), '{}');
});

test('Claude adapter provisioning and its runtime gate agree on scoped model accounts', () => {
  const options = adapterFixture();
  options.config = organizationProfileToConfig({
    schema_version: 1,
    organization: 'example-engineering',
    account_owner: 'example',
    minimum_runtime_interface_version: 1,
    defaults: { claude: 'example-claude-agent' },
    identities: [
      { slug: 'example-claude-agent', harness: 'claude', status: 'active' },
      { slug: 'custom-model-persona', harness: 'claude', status: 'active', models: ['model'] },
      { slug: 'retired-persona', harness: 'claude', status: 'retired' },
    ],
  });
  options.config.scope = { apps: ['custom-model-persona'] };
  options.env.AGENT_BOT_ACCOUNT = 'custom-model-persona';
  assert.equal(accountSlug(options.env, options.config), 'custom-model-persona');
  assert.equal(ensureClaudeWorktreeAdapter(options).status, 'ready');
  for (const account of ['example-claude-agent', 'retired-persona', 'owner']) {
    options.env.AGENT_BOT_ACCOUNT = account;
    assert.equal(accountSlug(options.env, options.config), null);
    assert.equal(inspectClaudeWorktreeAdapter(options).status, 'not_applicable');
  }
});

test('Claude adapter installation follows CLAUDE_CONFIG_DIR', () => {
  const options = adapterFixture();
  options.env.CLAUDE_CONFIG_DIR = join(options.home, 'custom-claude');
  ensureClaudeWorktreeAdapter(options);
  assert.equal(existsSync(join(options.env.CLAUDE_CONFIG_DIR, 'settings.json')), true);
  assert.equal(existsSync(join(options.home, '.claude')), false);
});

test('every supported harness adapter is generated from the dialect table', () => {
  for (const row of DIALECTS.filter((candidate) => candidate.file)) {
    const config = JSON.parse(renderConfig(row));
    for (const event of CANONICAL_EVENTS) {
      const mapped = vendorEvent(row.key, event);
      if (!mapped) continue;
      const entries = config.hooks[mapped.event];
      assert.ok(entries.some((entry) => (
        JSON.stringify(entry).includes(`${row.key} ${purposeFor(event)} ||`)
      )), `${row.key}/${event} is not generated`);
    }
  }
});

test('regeneration replaces only marked entries and preserves foreign configuration', () => {
  const row = DIALECTS.find((candidate) => candidate.key === 'claude');
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign-guard' }] };
  const stale = {
    hooks: [{
      type: 'command',
      command: `old command # ${MANAGED_MARKER}`,
    }],
  };
  const current = JSON.stringify({
    permissions: { allow: ['Bash(git status)'] },
    hooks: { PreToolUse: [foreign, stale] },
  });
  const first = renderConfig(row, current);
  const second = renderConfig(row, first);
  const parsed = JSON.parse(first);

  assert.equal(second, first, 'generation must be idempotent');
  assert.deepEqual(parsed.permissions, { allow: ['Bash(git status)'] });
  assert.deepEqual(parsed.hooks.PreToolUse[0], foreign);
  assert.equal(JSON.stringify(parsed).includes('old command'), false);
});

test('existing hook event key order is preserved when a foreign entry sits mid-file', () => {
  const row = DIALECTS.find((candidate) => candidate.key === 'claude');
  const worktree = {
    // The governed WorktreeCreate hook as .claude/settings.json carries it
    // (ENG-0339): gated on the rostered agent account through the runtime,
    // not on a name glob, and never managed by sync-hooks.
    hooks: [{ type: 'command', command: "B=\"${AGENT_BOT_BIN:-agent-bot}\"; if ! command -v \"$B\" >/dev/null 2>&1; then case \"$(id -un)\" in *-agent) echo \"agent-bot is not installed \u2014 install agent-bot-identity\" >&2; exit 127;; *) exit 0;; esac; fi; [ -n \"$(\"$B\" worktree-token --account-slug 2>/dev/null)\" ] || exit 0; exec \"$B\" claude-worktree-create", timeout: 180 }],
  };
  const guard = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'foreign-guard' }],
  };
  const managed = {
    hooks: [{
      type: 'command',
      command: `stale # ${MANAGED_MARKER}`,
    }],
  };
  const current = JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    hooks: {
      WorktreeCreate: [worktree],
      SessionStart: [managed],
      SessionEnd: [managed],
      UserPromptSubmit: [managed],
      PreToolUse: [guard, managed],
      PostToolUse: [managed],
      Stop: [managed],
    },
  });
  const rendered = renderConfig(row, current);
  const parsed = JSON.parse(rendered);

  assert.deepEqual(Object.keys(parsed), ['$schema', 'hooks']);
  assert.deepEqual(Object.keys(parsed.hooks), [
    'WorktreeCreate',
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
  ]);
  assert.deepEqual(parsed.hooks.WorktreeCreate, [worktree]);
  assert.deepEqual(parsed.hooks.PreToolUse[0], guard);
  assert.equal(renderConfig(row, rendered), rendered, 'generation must stay byte-stable');
});

test('generated entries are one readable line that fails closed without the adapter', () => {
  for (const row of DIALECTS.filter((candidate) => candidate.file)) {
    const config = JSON.parse(renderConfig(row));
    for (const event of CANONICAL_EVENTS) {
      const mapped = vendorEvent(row.key, event);
      if (!mapped) continue;
      const entry = config.hooks[mapped.event].find((candidate) => (
        JSON.stringify(candidate).includes(`${row.key} ${purposeFor(event)} ||`)
      ));
      const command = entry.command ?? entry.bash ?? entry.hooks?.[0]?.command ?? '';
      assert.match(command, /^"\$HOME\/[^"]+\/hook" /, `${row.key}/${event} names the co-located dispatcher`);
      assert.ok(command.length < 200, `${row.key}/${event} stays readable`);
      assert.equal(command.includes('uninstalledDecision'), false, `${row.key}/${event} carries no inline program`);
      // No compiled allowlist rides in the entry: only an operator's env reaches the policy (#675).
      assert.doesNotMatch(command, /export AGENT_BOT_UNMANAGED_AUTHORS|UNMANAGED_AUTHORS-|ai9d/);
      assert.match(command, new RegExp(`\\|\\| exit ${isBlocking(event) ? 2 : 0} # ${MANAGED_MARKER} \\(${event}\\)$`), `${row.key}/${event} guard`);
    }
  }
});

test('a blocking entry refuses when the co-located dispatcher is absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-absent-'));
  try {
    const row = DIALECTS.find((candidate) => candidate.key === 'claude');
    const config = JSON.parse(renderConfig(row, '{}', undefined, { adapterDir: '$HOME/.claude/agent-bot' }));
    const entry = config.hooks.PreToolUse.find((candidate) => candidate.matcher === 'Bash');
    const run = spawnSync('sh', ['-c', entry.hooks[0].command], {
      input: '{}', encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH },
    });
    assert.equal(run.status, 2, 'a missing dispatcher must refuse, not fail open');
    const advisory = config.hooks.SessionStart[0];
    const quiet = spawnSync('sh', ['-c', advisory.hooks[0].command], {
      input: '{}', encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH },
    });
    assert.equal(quiet.status, 0, 'an advisory event stays silent when absent');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('sync writes the co-located dispatcher and policy beside each harness config', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-files-'));
  try {
    syncHooks({ home, env: { HOME: home } });
    for (const row of DIALECTS.filter((candidate) => candidate.homeFile)) {
      const dir = hookAdapterDir(row, home, { HOME: home });
      const dispatcher = readFileSync(join(dir, 'hook'), 'utf8');
      const policy = readFileSync(join(dir, 'uninstalled-policy.mjs'), 'utf8');
      assert.match(dispatcher, /exec "\$R" --dialect "\$1" --event "\$E"/, `${row.key} runs the installed runner`);
      assert.match(dispatcher, /exec node "\$D\/uninstalled-policy\.mjs" "\$1" "\$E"/, `${row.key} falls back to the policy`);
      assert.match(policy, /uninstalledDecision/, `${row.key} policy carries the decision program`);
      assert.ok(statSync(join(dir, 'hook')).mode & 0o111, `${row.key} dispatcher is executable`);
      for (const event of eventsFor(row, true)) {
        if (purposeFor(event) !== event) {
          assert.match(dispatcher, new RegExp(`${purposeFor(event)}\\) E=${event} ;;`), `${row.key} maps ${purposeFor(event)}`);
        }
      }
    }
    // The entry runs the files end to end: uninstalled, a human publish is
    // refused and a read-only command proceeds.
    const row = DIALECTS.find((candidate) => candidate.key === 'claude');
    const settings = JSON.parse(readFileSync(hookHomePath(row, home), 'utf8'));
    const entry = settings.hooks.PreToolUse.find((candidate) => candidate.matcher === 'Bash');
    const run = (command) => spawnSync('sh', ['-c', entry.hooks[0].command], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENT_BOT_HOOK_BIN: join(home, 'no-such'), GIT_AUTHOR_NAME: 'qwts', GIT_AUTHOR_EMAIL: 'qwts@example.com' },
    });
    const deny = run('git commit -m x');
    assert.match(deny.stdout, /"permissionDecision":"deny"/);
    assert.equal(run('ls').status, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('sync refuses a symlinked adapter file', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-link-file-'));
  const outside = mkdtempSync(join(tmpdir(), 'agent-hook-link-file-target-'));
  try {
    const target = join(outside, 'hook');
    writeFileSync(target, '#!/bin/sh\nexit 0\n');
    mkdirSync(join(home, '.claude', 'agent-bot'), { recursive: true });
    symlinkSync(target, join(home, '.claude', 'agent-bot', 'hook'));
    assert.throws(() => syncHooks({ home }), /must be a regular file/);
    assert.equal(readFileSync(target, 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Cursor blocking events are generated fail-closed', () => {
  const row = DIALECTS.find((candidate) => candidate.key === 'cursor');
  const config = JSON.parse(renderConfig(row));
  for (const event of CANONICAL_EVENTS.filter(isBlocking)) {
    const mapped = vendorEvent(row.key, event);
    if (!mapped) continue;
    const entry = config.hooks[mapped.event].find((candidate) => (
      JSON.stringify(candidate).includes(`cursor ${purposeFor(event)} ||`)
    ));
    assert.equal(entry.failClosed, true, `${event} is not fail-closed`);
  }
});

test('--check reports drift without writing and apply repairs it', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-sync-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-hook-repo-'));
  for (const row of DIALECTS.filter((candidate) => candidate.homeFile)) {
    const path = hookHomePath(row, home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n');
  }
  // 6 harness configs + 2 co-located adapter files each + the Codex policy.
  assert.equal(syncHooks({ home, check: true }).length, 19);
  assert.equal(readFileSync(hookHomePath(DIALECTS.find((row) => row.key === 'claude'), home), 'utf8'), '{}\n');
  assert.equal(syncHooks({ home }).length, 19);
  assert.deepEqual(syncHooks({ home, check: true }), []);
  assert.equal(existsSync(join(repo, '.cursor', 'hooks.json')), false);
  assert.equal(existsSync(join(home, '.github', 'hooks', 'agent-bot.json')), false);
  assert.equal(existsSync(join(home, '.copilot', 'hooks', 'agent-bot.json')), true);
});

// #1275: the user-level Qwen file gets SessionStart only and the agent-bot
// MCP server; the person's own settings, hooks and MCP servers survive, and an
// agent-bot server they configured themselves is never replaced.
test('the user-level Qwen adapter carries SessionStart and registers agent-bot mcp, keeping foreign settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-qwen-'));
  const row = DIALECTS.find((candidate) => candidate.key === 'qwen');
  const path = hookHomePath(row, home);
  assert.equal(path, join(home, '.qwen', 'settings.json'));
  mkdirSync(dirname(path), { recursive: true });
  const ownStop = { hooks: [{ type: 'command', command: '/usr/local/bin/my-stop' }] };
  writeFileSync(path, `${JSON.stringify({ model: { name: 'qwen3-coder' }, mcpServers: { other: { command: 'x' } }, hooks: { Stop: [ownStop] } })}\n`);
  syncHooks({ home });
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(settings.model, { name: 'qwen3-coder' });
  assert.deepEqual(settings.mcpServers.other, { command: 'x' });
  assert.deepEqual(settings.mcpServers['agent-bot'], { command: join(home, '.local', 'bin', 'agent-bot'), args: ['mcp'] });
  assert.deepEqual(settings.hooks.Stop, [ownStop]);
  const managed = Object.entries(settings.hooks).filter(([, entries]) => entries.some((entry) => JSON.stringify(entry).includes(MANAGED_MARKER)));
  assert.deepEqual(managed.map(([event]) => event), ['SessionStart']);
  assert.match(JSON.stringify(settings.hooks.SessionStart), /qwen bind-soul \|\| exit 0 # agent-bot agent-hook \(session-start\)/);
  assert.deepEqual(syncHooks({ home, check: true }), []);

  const own = { command: '/opt/agent-bot', args: ['mcp'], trust: false };
  writeFileSync(path, `${JSON.stringify({ ...settings, mcpServers: { 'agent-bot': own } }, null, 2)}\n`);
  assert.deepEqual(syncHooks({ home, check: true }), []);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).mcpServers['agent-bot'], own);
});

// The co-located policy carries the allowlist the shared resolver granted
// for the config bytes at sync time (#675); a config edit is adapter drift.
test('sync embeds the validated allowlist snapshot and reports a config edit as drift', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-snapshot-'));
  const config = join(home, '.config', 'agent-bot', 'config.json');
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ settings: { unmanagedAuthors: ['ai9d'] } }));
  const env = { HOME: home };
  const claudeRow = DIALECTS.find((row) => row.key === 'claude');
  const policyPath = join(hookAdapterDir(claudeRow, home, env), 'uninstalled-policy.mjs');
  syncHooks({ home, env });
  assert.match(readFileSync(policyPath, 'utf8'), /"authors":\["ai9d"\]/);
  assert.deepEqual(syncHooks({ home, env, check: true }), []);
  writeFileSync(config, JSON.stringify({ settings: { unmanagedAuthors: ['ai9d'] }, features: { 'github-identity': 'false' } }));
  assert.ok(syncHooks({ home, env, check: true }).includes(policyPath), 'stale snapshots are reported, not silently trusted');
  syncHooks({ home, env });
  assert.match(readFileSync(policyPath, 'utf8'), /"authors":\[\]/, 'a config the shared resolver refuses snapshots no authors');
});

test('user-level sync keeps a foreign WorktreeCreate hook and does not write the repo', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-hook-repo-'));
  const claude = DIALECTS.find((row) => row.key === 'claude');
  const path = hookHomePath(claude, home);
  mkdirSync(dirname(path), { recursive: true });
  const worktree = { hooks: [{ type: 'command', command: 'foreign-create', timeout: 180 }] };
  writeFileSync(path, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { WorktreeCreate: [worktree] } }));
  syncHooks({ home });
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.deepEqual(settings.hooks.WorktreeCreate, [worktree]);
  assert.ok(settings.hooks.SessionStart.length >= 1);
  assert.equal(existsSync(join(repo, '.cursor', 'hooks.json')), false);
  assert.equal(existsSync(join(repo, '.claude', 'settings.json')), false);
});

test('a relative CLAUDE_CONFIG_DIR stays inside the supplied home', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-relative-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-hook-relative-repo-'));
  syncHooks({ home, env: { CLAUDE_CONFIG_DIR: '.custom-claude' } });
  assert.equal(existsSync(join(home, '.custom-claude', 'settings.json')), true);
  assert.equal(existsSync(join(home, '.custom-claude', 'agent-bot', 'hook')), true);
  assert.equal(existsSync(join(home, '.claude')), false);
  assert.equal(existsSync(join(repo, '.custom-claude', 'settings.json')), false);
  const settings = JSON.parse(readFileSync(join(home, '.custom-claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /"\$HOME\/\.custom-claude\/agent-bot\/hook"/);
});

test('sync refuses a symlinked Claude settings file', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'agent-hook-link-target-'));
  const target = join(outside, 'settings.json');
  writeFileSync(target, '{}\n');
  mkdirSync(join(home, '.claude'));
  symlinkSync(target, join(home, '.claude', 'settings.json'));
  assert.throws(() => syncHooks({ home }), /must be a regular file/);
  assert.equal(readFileSync(target, 'utf8'), '{}\n');
});

test('the CLI does not write adapters into the working directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-cli-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-hook-cli-repo-'));
  const script = fileURLToPath(new URL('../sync-hooks.mjs', import.meta.url));
  execFileSync(process.execPath, [script], { cwd: repo, env: { ...process.env, HOME: home } });
  assert.equal(existsSync(join(repo, '.cursor', 'hooks.json')), false);
  assert.equal(existsSync(join(repo, '.claude', 'settings.json')), false);
  assert.equal(existsSync(join(home, '.cursor', 'hooks.json')), true);
  assert.match(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /destructive_enabled = false/);
});

test('an existing Codex user config is not replaced', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hook-codex-keep-'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'config.toml'), 'approval_policy = "never"\n');
  syncHooks({ home });
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), 'approval_policy = "never"\n');
});
