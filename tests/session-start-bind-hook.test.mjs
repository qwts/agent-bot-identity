import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent-hooks', 'session-start', '15-bind-session');

// A stand-in agent-bot that records how it was called, so the hook's own
// decision is what the test sees (#1275).
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bind-session-hook-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'calls');
  writeFileSync(join(bin, 'agent-bot'), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(join(bin, 'agent-bot'), 0o755);
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const run = () => spawnSync(HOOK, [], {
    cwd: repo, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, GIT_CONFIG_NOSYSTEM: '1', AGENT_HOOK_SESSION_ID: 's-1' },
  });
  return { repo, log, run };
}

test('the session-start bind hook is silent outside a soul worktree', () => {
  const { log, run } = fixture();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(log), false);
});

test('the session-start bind hook binds a pinned worktree, legacy pin included', () => {
  for (const key of ['agentBot.agentId', 'qwts.agentId']) {
    const { repo, log, run } = fixture();
    execFileSync('git', ['config', key, 'agent_11111111-1111-4111-8111-111111111111'], { cwd: repo });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, 'utf8'), 'session bind\n', key);
  }
});
