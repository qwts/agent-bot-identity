import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CANONICAL_EVENTS, DIALECTS, isBlocking, vendorEvent } from '../hook-dialects.mjs';
import { MANAGED_MARKER, renderConfig, syncHooks } from '../sync-hooks.mjs';

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
    hooks: [{ type: 'command', command: 'agent-bot claude-worktree-create', timeout: 180 }],
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
