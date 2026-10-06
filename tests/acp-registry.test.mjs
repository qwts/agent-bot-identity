import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ACP_SPAWN_REGISTRY, defaultHarnessFor, onPath, spawnCommand, validateSpawnRow } from '../acp-registry.mjs';

test('every sign-in row declares complete commands and a status reader', () => {
  const rows = Object.values(ACP_SPAWN_REGISTRY).filter((row) => row.signIn);
  assert.deepEqual(rows.map((row) => row.harness).sort(), ['claude', 'codex', 'opencode']);
  for (const row of rows) {
    assert.doesNotThrow(() => validateSpawnRow(row));
    assert.ok(Object.isFrozen(row.signIn));
    for (const field of ['command', 'status', 'login', 'read']) {
      assert.throws(() => validateSpawnRow({ ...row, signIn: { ...row.signIn, [field]: undefined } }), /signIn/);
    }
  }
  for (const signIn of [{}, { ...ACP_SPAWN_REGISTRY.claude.signIn, read: 'unknown' },
    { ...ACP_SPAWN_REGISTRY.claude.signIn, script: undefined },
    { ...ACP_SPAWN_REGISTRY.codex.signIn, status: [] },
    { ...ACP_SPAWN_REGISTRY.opencode.signIn, read: { loggedIn: 'credentials' } }]) {
    assert.throws(() => validateSpawnRow({ ...ACP_SPAWN_REGISTRY.claude, signIn }), /signIn/);
  }
});

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

test('a checkout without the row binary falls back to the soul\'s own harness directory (#417)', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const row = ACP_SPAWN_REGISTRY.claude;
  const checkout = path.join(root, 'repo');
  const harnesses = path.join(root, 'harnesses');
  mkdirSync(checkout);
  mkdirSync(path.join(harnesses, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(path.join(harnesses, 'node_modules', 'adapter'));
  writeFileSync(path.join(harnesses, 'node_modules', 'adapter', 'cli.js'), '');
  symlinkSync('../adapter/cli.js', path.join(harnesses, 'node_modules', '.bin', row.soulBin));
  // Without it, an adapter row refuses rather than reach for npx (#418).
  assert.throws(() => spawnCommand(row, checkout, { node: '/app/node' }), /needs its ACP adapter @zed-industries\/claude-code-acp/);
  assert.deepEqual(spawnCommand(row, checkout, { node: '/app/node', dirs: [harnesses] }),
    { command: '/app/node', args: [realpathSync(path.join(harnesses, 'node_modules', 'adapter', 'cli.js'))] });
  // A row with no soul binary keeps its registry command.
  assert.deepEqual(spawnCommand(ACP_SPAWN_REGISTRY.opencode, checkout, { dirs: [harnesses] }), { command: 'opencode', args: ['acp'] });
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

test('the codex row opens the workspace-write sandbox to the network so the soul reaches agent-comms', () => {
  // Codex's workspace-write sandbox blocks network by default, and the broker
  // socket counts as network; the resume lane passes the same setting as a
  // -c flag (wake-resume.mjs), the ACP lane through codex-acp's CODEX_CONFIG.
  const row = ACP_SPAWN_REGISTRY.codex;
  assert.equal(row.sessionMode, 'workspace-write');
  assert.deepEqual(JSON.parse(row.setEnv.CODEX_CONFIG), { sandbox_workspace_write: { network_access: true } });
  assert.doesNotThrow(() => validateSpawnRow(row));
});
