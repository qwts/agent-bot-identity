import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAgentBotArgs } from '../cli/parse.mjs';
import { formatMintGrant } from '../cli/mint-output.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

test('stable CLI exposes version and documented commands', () => {
  const version = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^0\.2\.0\n$/);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const command of [
    'setup-worktree', 'mint-token', 'doctor', 'identity', 'install',
    'install-gh-shim', 'ensure-private-key',
  ]) assert.match(help.stdout, new RegExp(command));
});

test('CLI parsing rejects unknown commands and malformed hook dispatch', () => {
  assert.throws(() => parseAgentBotArgs(['unknown']), /unknown command/);
  assert.throws(() => parseAgentBotArgs(['hook']), /requires a hook name/);
  assert.deepEqual(parseAgentBotArgs(['identity', 'current']), {
    kind: 'command', command: 'identity', args: ['current'],
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
