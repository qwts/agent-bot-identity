// #617 slice 3: the daemon's three turn starts (a /v1 turn, a cold wake and
// a package launch) share one acpExecutorFor factory, so they spawn the
// harness adapter on the same soul-declared Node and env, and a refused
// runtime lookup spawns nothing on any of them. These fixtures drive the
// real ACP engine end to end and record every spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnChild } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAcpExecutor } from '../acp-engine.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { acpExecutorFor, coldTurnExecutor } from '../wake-plane.mjs';

const ID = 'agent_61761761-6176-4176-8176-617617617617';
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const POLICY = { version: 1, rules: [], fallback: 'deny' };

// A soul home with its adapter installed and a declared Node (a shim that
// runs this Node, so the fixture agent answers), and a factory built the
// way agent-daemon.mjs builds its one configuredExecutorFor.
function soul(t, { runtimeEnvFor } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'launch-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(FIXTURE, path.join(home, 'node_modules', '.bin', 'fake-acp'));
  const soulBin = path.join(root, 'runtimes', 'node', 'bin');
  mkdirSync(soulBin, { recursive: true });
  const soulNode = path.join(soulBin, 'node');
  writeFileSync(soulNode, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  chmodSync(soulNode, 0o755);
  // The host's PATH has no `node` at all: only the soul's runtime supplies one.
  const baseEnv = { HOME: home, PATH: '/usr/bin:/bin' };
  const registry = { claude: { harness: 'claude', enabled: true, soulBin: 'fake-acp', command: '/nonexistent/claude', args: [], stripEnv: [] } };
  const spawns = [];
  const runtimeAsks = [];
  const factory = acpExecutorFor({ identities: () => ({}), policy: POLICY, baseEnv,
    runtimeEnvFor: (args) => {
      runtimeAsks.push(args.agentId);
      return runtimeEnvFor ? runtimeEnvFor(args) : { PATH: `${soulBin}${path.delimiter}${args.env.PATH}` };
    },
    createExecutor: (options) => createAcpExecutor({ ...options, registry,
      spawn: (command, args, spawnOptions) => {
        spawns.push({ command: [command, ...args], env: spawnOptions.env });
        return spawnChild(command, args, spawnOptions);
      } }) });
  return { home, soulNode, soulBin, factory, spawns, runtimeAsks };
}

function port(home) {
  return { invocation: { agentId: ID, harness: 'claude', cwd: home }, message: 'ping', attachments: [],
    appendEvent: () => ({}), addArtifact: () => ({}), signal: new AbortController().signal,
    requestApproval: async () => ({ decision: 'deny' }) };
}

function launcher(t, s) {
  const root = mkdtempSync(path.join(tmpdir(), 'launch-parity-journal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reports = [];
  const handler = createLaunchHandler({ file: path.join(root, 'launch-requests.json'),
    identities: () => ({ id: ID, harness: 'claude' }),
    spawnPackage: () => { throw new Error('unexpected package spawn'); },
    lookupBinding: () => ({ worktree: s.home, file: path.join(s.home, 'binding.json') }),
    provisionHome: () => null,
    executorFor: s.factory });
  const launch = (requestId) => handler({ event: 'launch', requestId, principal: 'p1', account: 'worker', soul: ID, harness: 'claude' },
    { account: 'worker', report: async (result) => { reports.push(result); } });
  return { launch, reports };
}

test('a /v1 turn, a cold wake and a launch spawn the adapter on the soul\'s declared Node with one env (#617)', async (t) => {
  const s = soul(t);
  const { launch, reports } = launcher(t, s);

  await s.factory({ agentId: ID, harness: 'claude', cwd: s.home, env: {} })(port(s.home));
  const coldEvents = [];
  await coldTurnExecutor({ executorFor: s.factory, onEvent: (type) => coldEvents.push(type) })({ invocation: { agentId: ID, harness: 'claude', cwd: s.home }, message: 'ping', attachments: [], env: {} });
  await launch('r1');

  assert.ok(coldEvents.includes('harness-session') && coldEvents.includes('update'), `the cold turn ran on the soul's Node: ${coldEvents}`);
  assert.equal(reports[0].status, 'launched', JSON.stringify(reports[0]));
  assert.equal(s.spawns.length, 3);
  const adapter = realpathSync(FIXTURE);
  for (const spawned of s.spawns) {
    assert.deepEqual(spawned.command, [s.soulNode, adapter], 'the installed adapter runs on the soul\'s Node, never the daemon\'s');
    assert.equal(spawned.env.PATH.split(path.delimiter)[0], s.soulBin);
  }
  // Same env on every path, save the launch's binding file.
  const { AGENT_BOT_BINDING, ...launchEnv } = s.spawns[2].env;
  assert.equal(AGENT_BOT_BINDING, path.join(s.home, 'binding.json'));
  assert.deepEqual(s.spawns[1].env, s.spawns[0].env);
  assert.deepEqual(launchEnv, s.spawns[0].env);
  assert.deepEqual([s.spawns[0].env.AGENT_BOT_ID, s.spawns[0].env.QWTS_AGENT_ID], [ID, ID]);
  assert.deepEqual(s.runtimeAsks, [ID, ID, ID], 'each turn reads the soul\'s runtime declaration afresh');
});

test('a refused runtime lookup spawns nothing on any path and falls back to no host Node (#617)', async (t) => {
  const refusal = () => Object.assign(new Error('soul declares node 24.21.0, which is not installed; refusing host fallback'),
    { code: 'runtime-install-failed', runtime: 'node' });
  const s = soul(t, { runtimeEnvFor: () => { throw refusal(); } });
  const { launch, reports } = launcher(t, s);

  assert.throws(() => s.factory({ agentId: ID, harness: 'claude', cwd: s.home, env: {} }), { code: 'runtime-install-failed' });
  await assert.rejects(coldTurnExecutor({ executorFor: s.factory })({ invocation: { agentId: ID, harness: 'claude', cwd: s.home }, message: 'ping', attachments: [], env: {} }),
    { code: 'runtime-install-failed' });
  await launch('r1');

  assert.equal(reports[0].status, 'failed');
  assert.match(reports[0].detail ?? reports[0].error ?? JSON.stringify(reports[0]), /refusing host fallback/);
  assert.deepEqual(s.spawns, [], 'no harness process starts on the host\'s Node');
  assert.deepEqual(s.runtimeAsks, [ID, ID, ID]);
});
