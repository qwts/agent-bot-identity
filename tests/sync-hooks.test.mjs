import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CANONICAL_EVENTS, DIALECTS, isBlocking, vendorEvent } from '../hook-dialects.mjs';
import { MANAGED_MARKER, renderConfig, syncHooks, ensureClaudeWorktreeAdapter, inspectClaudeWorktreeAdapter } from '../sync-hooks.mjs';
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
        JSON.stringify(entry).includes(`${row.key} --event ${event}`)
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

test('generated adapters exec the installed hook or run explicit uninstalled mode', () => {
  for (const row of DIALECTS.filter((candidate) => candidate.file)) {
    const config = JSON.parse(renderConfig(row));
    for (const event of CANONICAL_EVENTS) {
      const mapped = vendorEvent(row.key, event);
      if (!mapped) continue;
      const entry = config.hooks[mapped.event].find((candidate) => (
        JSON.stringify(candidate).includes(`${row.key} --event ${event}`)
      ));
      const command = entry.command ?? entry.bash ?? entry.hooks?.[0]?.command ?? '';
      assert.equal(command.includes('[ -x "$H" ] || exit 0'), false, `${row.key}/${event} still fails open`);
      assert.match(command, /\[ -x "\$H" \] && exec "\$H"/);
      assert.match(command, /export AGENT_BOT_UNMANAGED_AUTHORS="\$\{AGENT_BOT_UNMANAGED_AUTHORS-ai9d\}"/);
      if (event === 'pre-command' || event === 'pre-commit' || event === 'pre-push') {
        assert.match(command, /uninstalledDecision/);
      }
    }
  }
});

test('Cursor blocking events are generated fail-closed', () => {
  const row = DIALECTS.find((candidate) => candidate.key === 'cursor');
  const config = JSON.parse(renderConfig(row));
  for (const event of CANONICAL_EVENTS.filter(isBlocking)) {
    const mapped = vendorEvent(row.key, event);
    if (!mapped) continue;
    const entry = config.hooks[mapped.event].find((candidate) => (
      JSON.stringify(candidate).includes(`--event ${event}`)
    ));
    assert.equal(entry.failClosed, true, `${event} is not fail-closed`);
  }
});

test('--check reports drift without writing and apply repairs it', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-hook-sync-'));
  for (const row of DIALECTS.filter((candidate) => candidate.file)) {
    const path = join(root, row.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n');
  }
  assert.equal(syncHooks({ root, check: true }).length, 5);
  assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf8'), '{}\n');
  assert.equal(syncHooks({ root }).length, 5);
  assert.deepEqual(syncHooks({ root, check: true }), []);
});
