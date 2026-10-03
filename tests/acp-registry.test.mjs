import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ACP_SPAWN_REGISTRY, defaultHarnessFor, onPath, spawnCommand, validateSpawnRow } from '../acp-registry.mjs';

test('a soul home that installed the row binary runs it with this Node (ADR-0276)', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-bin-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const row = ACP_SPAWN_REGISTRY.claude;
  // No home copy: it names the adapter, never npx (#418).
  assert.throws(() => spawnCommand(row, home), /needs its ACP adapter @zed-industries\/claude-code-acp@0\.16\.2/);
  assert.throws(() => spawnCommand(ACP_SPAWN_REGISTRY.codex, null), /@agentclientprotocol\/codex-acp@2\.1\.1/);
  const plain = { harness: 'plain', enabled: true, command: 'plain-acp', args: ['acp'], stripEnv: [] };
  assert.deepEqual(spawnCommand(plain, home), { command: 'plain-acp', args: ['acp'] });
  mkdirSync(path.join(home, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(path.join(home, 'node_modules', 'adapter'));
  writeFileSync(path.join(home, 'node_modules', 'adapter', 'cli.js'), '');
  symlinkSync('../adapter/cli.js', path.join(home, 'node_modules', '.bin', row.soulBin));
  assert.deepEqual(spawnCommand(row, home, { node: '/app/node' }),
    { command: '/app/node', args: [realpathSync(path.join(home, 'node_modules', 'adapter', 'cli.js'))] });
  assert.throws(() => validateSpawnRow({ ...row, soulBin: '../x' }), /soulBin/);
});

test('a launch with no harness takes the soul preference, else an enabled harness on PATH (ADR-0276)', () => {
  assert.equal(defaultHarnessFor(['codex', 'claude'], { available: () => false }), 'codex', 'codex is enabled (#384)');
  assert.equal(defaultHarnessFor(['codex', 'claude'], {
    registry: { ...ACP_SPAWN_REGISTRY, codex: { ...ACP_SPAWN_REGISTRY.codex, enabled: false } },
    available: () => false,
  }), 'claude', 'a disabled preference is skipped');
  assert.equal(defaultHarnessFor([], { available: (cmd) => cmd === 'opencode' }), 'opencode');
  assert.equal(defaultHarnessFor([], { available: (cmd) => cmd === 'claude' }), 'claude', 'an adapter row is found by its CLI (#418)');
  assert.equal(defaultHarnessFor(['unknown'], { available: () => false }), null);
  assert.equal(onPath('sh', { PATH: '/bin' }), true);
  assert.equal(onPath('/bin/sh', { PATH: '/bin' }), false);
});
