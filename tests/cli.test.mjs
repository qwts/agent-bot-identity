import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentBotArgs } from '../cli/parse.mjs';
import { formatMintGrant } from '../cli/mint-output.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('../agent-bot', import.meta.url));

test('stable CLI exposes version and documented commands', () => {
  const version = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^0\.2\.0\n$/);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const command of [
    'setup-worktree', 'mint-token', 'doctor', 'identity', 'space', 'population', 'install', 'update',
    'install-gh-shim', 'ensure-private-key',
    'signed-commit', 'secret',
  ]) assert.match(help.stdout, new RegExp(command));
});

test('portable launcher finds an nvm Node with a desktop-app PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-launcher-'));
  const node = join(home, '.nvm', 'versions', 'node', 'v-test', 'bin', 'node');
  const hooks = join(home, 'hooks');
  const childPath = join(home, 'child-path');
  mkdirSync(dirname(node), { recursive: true });
  symlinkSync(process.execPath, node);

  const run = spawnSync(LAUNCHER, ['--version'], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^0\.2\.0\n$/);

  const noPath = spawnSync(LAUNCHER, ['--version'], {
    encoding: 'utf8',
    env: { AGENT_BOT_NODE: process.execPath, HOME: home },
  });
  assert.equal(noPath.status, 0, noPath.stderr);
  assert.match(noPath.stdout, /^0\.2\.0\n$/);

  // Finding Node only for the CLI is insufficient: post-checkout and other
  // dispatched shell hooks invoke `node` again from the inherited PATH.
  mkdirSync(join(hooks, 'pre-command'), { recursive: true });
  writeFileSync(
    join(hooks, 'pre-command', '10-record-node'),
    `#!/bin/sh\ncommand -v node >"${childPath}"\n`,
    { mode: 0o755 },
  );
  const child = spawnSync(LAUNCHER, ['agent-hook', '--dialect', 'cursor', '--event', 'pre-command'], {
    encoding: 'utf8',
    env: { AGENT_BOT_HOOKS_DIR: hooks, HOME: home, PATH: '/usr/bin:/bin' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(childPath, 'utf8').trim(), node);
});

test('update failures identify the invoked command', () => {
  const run = spawnSync(process.execPath, [CLI, 'update', '--unknown'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^update: unknown option: --unknown\n$/);
});

test('CLI parsing rejects unknown commands and malformed hook dispatch', () => {
  assert.throws(() => parseAgentBotArgs(['unknown']), /unknown command/);
  assert.throws(() => parseAgentBotArgs(['hook']), /requires a hook name/);
  assert.deepEqual(parseAgentBotArgs(['identity', 'current']), {
    kind: 'command', command: 'identity', args: ['current'],
  });
  assert.deepEqual(parseAgentBotArgs(['update']), {
    kind: 'command', command: 'update', args: [],
  });
  assert.deepEqual(parseAgentBotArgs(['secret', 'get', '--provider', 'proton-pass']), {
    kind: 'command', command: 'secret', args: ['get', '--provider', 'proton-pass'],
  });
});

test('mint-token JSON contract is stable and stdout-only secret bearing', () => {
  const output = formatMintGrant({
    token: 'test-token-value',
    expires_at: '2026-08-01T20:00:00Z',
    installation_id: 42,
  }, { json: true });
  assert.deepEqual(JSON.parse(output), {
    schema_version: 1,
    token: 'test-token-value',
    expires_at: '2026-08-01T20:00:00Z',
    installation_id: 42,
  });
});
