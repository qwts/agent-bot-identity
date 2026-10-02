import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLaunchHandler, LAUNCH_NAME_MAX } from '../daemon-launch.mjs';
import { HARNESS_SESSION_EVENT } from '../executor-contract.mjs';
import { mintAgentIdentity, readAgentIdentity } from '../agent-identity.mjs';

const agentId = 'agent_11111111-1111-4111-8111-111111111111';
const event = { event: 'launch', requestId: 'r1', principal: 'p1', account: 'worker', soul: agentId, harness: 'claude', name: 'Helper' };
function fixture(t, overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'daemon-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reports = [];
  const calls = [];
  const file = path.join(root, 'launch-requests.json');
  const options = { file, identities: () => ({ id: agentId, github: { appSlug: 'test-app' }, harness: 'muse' }),
    spawnPackage: () => { throw new Error('unexpected spawn'); },
    lookupBinding: () => ({ worktree: '/work', file: '/private/binding' }),
    executorFor: (args) => { calls.push(args); return async (input) => {
      assert.equal(JSON.parse(readFileSync(file))[0].status, 'pending');
      assert.deepEqual(await input.requestApproval(), { decision: 'deny' });
      assert.match(input.message.text, /Join agent-comms/);
      input.appendEvent(HARNESS_SESSION_EVENT, {});
    }; }, ...overrides };
  const ports = { account: 'worker', report: async (result) => { reports.push(result); } };
  return { root, options, ports, reports, calls, handler: createLaunchHandler(options) };
}

test('launch uses named harness and bound soul environment; duplicates never execute twice', async (t) => {
  const f = fixture(t);
  await Promise.all([f.handler(event, f.ports), f.handler(event, f.ports)]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { agentId, harness: 'claude', cwd: '/work',
    env: { AGENT_BOT_BINDING: '/private/binding', AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId } });
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId });
  assert.equal(statSync(f.options.file).mode & 0o777, 0o600);
  await createLaunchHandler(f.options)(event, f.ports);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reports.length, 2);
});

test('waits for session readiness and reports async spawn errors as failed', async (t) => {
  let rejectStart;
  const f = fixture(t, { executorFor: () => () => new Promise((_, reject) => { rejectStart = reject; }) });
  const pending = f.handler(event, f.ports);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reports.length, 0);
  rejectStart(new Error('spawn unavailable'));
  await pending;
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'failed', agentId: null, detail: 'spawn unavailable' });
});

for (const [name, overrides, input, reason] of [
  ['App-less soul', { identities: () => ({ id: agentId }) }, {}, /without a GitHub App/],
  ['missing binding', { lookupBinding: () => null }, {}, /binding is unavailable/],
  ['disabled executor', { executorFor: null }, {}, /executor is disabled/],
  ['unknown soul', { identities: () => { throw new Error('unknown soul'); } }, {}, /unknown soul/],
  ['wrong account', {}, { account: 'other' }, /account/],
  ['bad harness', {}, { harness: '../shell' }, /harness/],
  ['two targets', {}, { package: '/soul' }, /exactly one/],
  ['no target', {}, { soul: undefined }, /exactly one/],
  ['malformed extra target', {}, { package: {} }, /exactly one/],
  ['bad name', {}, { name: '\n' }, /name/],
  ['blank name', {}, { name: '   ' }, /name/],
  ['name over the broker bound', {}, { name: 'n'.repeat(129) }, /name/],
  ['sync executor failure', { executorFor: () => { throw new Error('unsupported harness'); } }, {}, /unsupported harness/],
  ['no session', { executorFor: () => async () => {} }, {}, /before session creation/],
]) test(`launch fails closed: ${name}`, async (t) => {
  const f = fixture(t, overrides);
  await f.handler({ ...event, ...input }, f.ports);
  assert.equal(f.reports[0].status, 'failed');
  assert.equal(f.reports[0].agentId, null);
  assert.match(f.reports[0].detail, reason);
});

test('accepts any name the broker accepts, up to its 128-character bound', async (t) => {
  const f = fixture(t);
  await f.handler({ ...event, name: 'n'.repeat(LAUNCH_NAME_MAX) }, f.ports);
  assert.equal(LAUNCH_NAME_MAX, 128);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId });
});

test('restart fails accepted unfinished requests, reports once, never replays', async (t) => {
  const f = fixture(t);
  writeFileSync(f.options.file, JSON.stringify([{ requestId: 'r1', status: 'pending', agentId: null }]));
  const handler = createLaunchHandler(f.options);
  await handler.recover(f.ports);
  assert.match(f.reports[0].detail, /restarted/);
  await handler.recover(f.ports);
  assert.equal(f.reports.length, 1);
  await handler(event, f.ports);
  assert.equal(f.calls.length, 0);
});

test('report failure retries persisted result on reconnect and restart without execution', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.handler(event, { ...f.ports, report: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(JSON.parse(readFileSync(f.options.file))[0].status, 'launched');
  await createLaunchHandler(f.options).recover(f.ports);
  assert.equal(f.reports[0].status, 'launched');
  assert.equal(f.calls.length, 1);
});

test('corrupt journal and invalid request IDs fail closed', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.handler({ ...event, requestId: null }, f.ports), /requestId/);
  writeFileSync(f.options.file, 'bad');
  assert.throws(() => createLaunchHandler(f.options), /unreadable/);
  writeFileSync(f.options.file, '{}');
  assert.throws(() => createLaunchHandler(f.options), /invalid/);
});

test('package mint uses genesis IDs, no inferred App authority, and is not repeated', async (t) => {
  const f = fixture(t);
  const packagePath = path.join(f.root, 'test.soul');
  mkdirSync(packagePath);
  writeFileSync(path.join(packagePath, 'soul.json'), JSON.stringify({ formatVersion: 1,
    name: 'Test', description: 'Test', displaySeed: 'test', preferredHarnesses: [],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null }));
  writeFileSync(path.join(packagePath, 'AGENTS.md'), 'Test instructions');
  let identity;
  let spawns = 0;
  const stateDir = path.join(f.root, 'identities');
  const handler = createLaunchHandler({ ...f.options, spawnPackage: (request) => {
    spawns++;
    identity = mintAgentIdentity({ packagePath: request.package, harness: request.harness, useGithub: false, stateDir });
    return identity;
  } });
  const request = { ...event, soul: undefined, package: packagePath };
  await handler(request, f.ports);
  assert.ok(readAgentIdentity(identity.id, { stateDir }).genesis);
  assert.match(f.reports[0].detail, /#297/);
  await handler(request, f.ports);
  assert.equal(spawns, 1);
});

test('package launch seam can supply a prepared soul to the same executor', async (t) => {
  const f = fixture(t, { spawnPackage: () => ({ id: agentId, github: { appSlug: 'test-app' } }) });
  await f.handler({ ...event, soul: undefined, package: '/approved.soul' }, f.ports);
  assert.equal(f.reports[0].status, 'launched');
});

test('launch drives the real ACP executor through session creation', async (t) => {
  const { createAcpExecutor } = await import('../acp-engine.mjs');
  const { fileURLToPath } = await import('node:url');
  const f = fixture(t);
  let turn;
  const handler = createLaunchHandler({ ...f.options,
    lookupBinding: () => ({ worktree: f.root, file: path.join(f.root, 'binding') }),
    executorFor: ({ harness, cwd, env }) => {
      const execute = createAcpExecutor({ harness, cwd, env: { ...process.env, ...env },
        identity: { app: 'test-app', agentId }, policy: { version: 1, rules: [], fallback: 'deny' },
        registry: { claude: { harness: 'claude', enabled: true, command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))], stripEnv: [] } } });
      return (input) => { turn = execute(input); return turn; };
    },
  });
  await handler(event, f.ports);
  assert.equal(f.reports[0].status, 'launched');
  await turn;
});


test('journal write failure prevents all launch side effects', async (t) => {
  const f = fixture(t);
  mkdirSync(f.options.file);
  await assert.rejects(f.handler(event, f.ports));
  assert.equal(f.calls.length, 0);
  assert.equal(f.reports.length, 0);
});
