import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { CANONICAL_EVENTS, DIALECTS, encodeDecision, vendorEvent } from '../hook-dialects.mjs';
import { renderConfig } from '../sync-hooks.mjs';
import {
  UNINSTALLED_REASON,
  adapterFallback,
  isHumanAttributedPublish,
  uninstalledDecision,
} from '../uninstalled-identity-hook.mjs';

const DENY = [
  'git commit -m "wip"',
  'git -C /tmp commit --amend --no-edit',
  'GIT_EDITOR=true git commit',
  'command git push origin HEAD',
  'git status && git push',
  'gh pr create --title x --body y',
  'gh -R qwts/playbook-engineering pr merge 1',
  'gh issue create --title x',
  'gh api graphql -f query=mutation',
  'gh api repos/qwts/x/pulls -X POST',
  'gh repo create example',
];

const ALLOW = [
  'git status',
  'git diff',
  'git add README.md',
  'git log --grep=commit',
  'git commit-tree HEAD^{tree}',
  'gh pr view 122',
  'gh pr list',
  'gh issue view 1',
  'gh api user',
  'gh api repos/qwts/x --method GET',
  'node --test tests/uninstalled-identity-hook.test.mjs',
  'printf "hello" > /tmp/notes.md',
];

function coldEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    AGENT_BOT_HOOK_BIN: join(home, 'no-such-hook'),
    ...extra,
  };
}

function runGenerated(dialectKey, event, { payload = {}, env = {}, home } = {}) {
  const row = DIALECTS.find((candidate) => candidate.key === dialectKey);
  const config = JSON.parse(renderConfig(row));
  const mapped = vendorEvent(dialectKey, event);
  const entry = config.hooks[mapped.event].find((candidate) => (
    JSON.stringify(candidate).includes(`${dialectKey} --event ${event}`)
  ));
  const command = entry.command ?? entry.bash ?? entry.hooks?.[0]?.command;
  return spawnSync('sh', ['-c', command], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: coldEnv(home, env),
  });
}

test('publish commands are denied and reads or uncommitted edits are allowed', () => {
  for (const command of DENY) {
    assert.equal(isHumanAttributedPublish(command), true, `should deny: ${command}`);
  }
  for (const command of ALLOW) {
    assert.equal(isHumanAttributedPublish(command), false, `should allow: ${command}`);
  }
});

test('uninstalled decisions deny only commit, push, and pre-command publishes', () => {
  assert.deepEqual(uninstalledDecision({ event: 'pre-commit' }), {
    decision: 'deny',
    reason: UNINSTALLED_REASON,
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-push' }), {
    decision: 'deny',
    reason: UNINSTALLED_REASON,
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-command', command: 'git commit -m x' }), {
    decision: 'deny',
    reason: UNINSTALLED_REASON,
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-command', command: 'git status' }), {
    decision: 'allow',
    reason: '',
  });
  assert.deepEqual(uninstalledDecision({ event: 'pre-file-write', command: 'git commit -m x' }), {
    decision: 'allow',
    reason: '',
  });
  assert.deepEqual(uninstalledDecision({ event: 'session-start' }), {
    decision: 'allow',
    reason: '',
  });
});

test('generated adapters on a cold home deny publish and allow file edits, in every dialect', () => {
  const home = mkdtempSync(join(tmpdir(), 'uninstalled-hook-'));
  try {
    for (const row of DIALECTS.filter((candidate) => candidate.file)) {
      const deny = runGenerated(row.key, 'pre-command', {
        home,
        payload: { command: 'git commit -m incident' },
      });
      const expectedDeny = encodeDecision({
        dialectKey: row.key,
        event: 'pre-command',
        decision: 'deny',
        reason: UNINSTALLED_REASON,
      });
      assert.equal(deny.status, expectedDeny.exitCode, `${row.key} deny exit`);
      if (expectedDeny.stdout) {
        assert.equal(deny.stdout, expectedDeny.stdout, `${row.key} deny stdout`);
      }

      const allow = runGenerated(row.key, 'pre-command', {
        home,
        payload: { tool_input: { command: 'git status' } },
      });
      const expectedAllow = encodeDecision({
        dialectKey: row.key,
        event: 'pre-command',
        decision: 'allow',
      });
      assert.equal(allow.status, expectedAllow.exitCode, `${row.key} allow exit`);
      assert.equal(allow.stdout, expectedAllow.stdout, `${row.key} allow stdout`);
    }

    const cursorWrite = runGenerated('cursor', 'pre-file-write', {
      home,
      payload: { tool_input: { path: 'README.md' } },
    });
    assert.equal(cursorWrite.status, 0);
    assert.equal(cursorWrite.stdout, '{}');

    const gitCommit = spawnSync('sh', ['-c', adapterFallback('git', 'pre-commit')], {
      encoding: 'utf8',
      env: coldEnv(home),
    });
    assert.equal(gitCommit.status, 2);
    assert.match(gitCommit.stderr, /uninstalled identity/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installed agent-hook still wins over uninstalled mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'installed-hook-'));
  try {
    const hook = join(home, 'agent-hook');
    writeFileSync(hook, '#!/bin/sh\nprintf %s installed-ran\nexit 0\n', { mode: 0o755 });
    chmodSync(hook, 0o755);
    const result = runGenerated('cursor', 'pre-command', {
      home,
      payload: { command: 'git commit -m x' },
      env: { AGENT_BOT_HOOK_BIN: hook },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'installed-ran');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Cursor allow fallback prints {} so failClosed does not treat silence as deny', () => {
  for (const event of CANONICAL_EVENTS.filter((name) => name !== 'pre-command' && name !== 'pre-commit' && name !== 'pre-push')) {
    const fallback = adapterFallback('cursor', event);
    assert.match(fallback, /printf '%s' '\{\}'/);
  }
});
