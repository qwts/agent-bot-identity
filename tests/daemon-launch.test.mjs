import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLaunchHandler, LAUNCH_NAME_MAX } from '../daemon-launch.mjs';
import { HARNESS_SESSION_EVENT } from '../executor-contract.mjs';
import { mintAgentIdentity, readAgentIdentity } from '../agent-identity.mjs';
import { displayName, upsertSoul } from '../agent-population.mjs';
import { soulPromptIdentity } from '../agent-daemon.mjs';

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
    provisionHome: () => null,
    executorFor: (args) => { calls.push(args); return async (input) => {
      assert.equal(JSON.parse(readFileSync(file))[0].status, 'pending');
      assert.deepEqual(await input.requestApproval(), { decision: 'deny' });
      assert.match(input.message, /Join agent-comms/);
      input.appendEvent(HARNESS_SESSION_EVENT, {});
    }; }, ...overrides };
  const ports = { account: 'worker', report: async (result) => { reports.push(result); } };
  return { root, options, ports, reports, calls, handler: createLaunchHandler(options) };
}

test('launch uses named harness and bound soul environment; duplicates never execute twice', async (t) => {
  const lookups = [];
  const f = fixture(t, { lookupBinding: (id, options) => {
    lookups.push({ id, ...options });
    return { worktree: '/work', file: '/private/binding' };
  } });
  await Promise.all([f.handler(event, f.ports), f.handler(event, f.ports)]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(lookups, [{ id: agentId, harness: 'claude' }], 'the launch override reaches harness provisioning');
  assert.deepEqual(f.calls[0], { agentId, harness: 'claude', cwd: '/work',
    env: { AGENT_BOT_BINDING: '/private/binding', AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId } });
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId });
  assert.equal(statSync(f.options.file).mode & 0o777, 0o600);
  await createLaunchHandler(f.options)(event, f.ports);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reports.length, 2);
});

test('the journal lists launched souls for the managed backfill, not failed ones (#409)', async (t) => {
  const f = fixture(t);
  await f.handler(event, f.ports);
  const failing = createLaunchHandler({ ...f.options, executorFor: () => async () => { throw new Error('no session'); } });
  await failing({ ...event, requestId: 'r2' }, f.ports);
  assert.deepEqual(createLaunchHandler(f.options).launched(), [agentId]);
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

test('launches a soul without a GitHub App (#297)', async (t) => {
  const f = fixture(t, { identities: () => ({ id: agentId, harness: 'claude' }) });
  await f.handler(event, f.ports);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId });
});

test('binds a soul home when the soul has no live binding', async (t) => {
  const homes = [];
  const f = fixture(t, { lookupBinding: () => null,
    provisionHome: (soul) => { homes.push(soul); return { worktree: '/home/soul', file: '/home/soul/.git/agent-binding.json' }; } });
  await f.handler(event, f.ports);
  assert.deepEqual(homes, [{ agentId, harness: 'claude', packagePath: null }]);
  assert.equal(f.calls[0].cwd, '/home/soul');
  assert.equal(f.reports[0].status, 'launched');
});

const spawnedId = 'agent_22222222-2222-4222-8222-222222222222';
const packageEvent = { ...event, soul: undefined, package: '/pkg' };

test('launch turns name the soul and its parent from the latest population record', async (t) => {
  for (const parent of [agentId, null]) {
    let message;
    const f = fixture(t, {
      spawnPackage: () => ({ id: spawnedId }),
      executorFor: () => async (input) => { message = input.message; input.appendEvent(HARNESS_SESSION_EVENT, {}); },
    });
    const env = { AGENT_BOT_POPULATION_PATH: path.join(f.root, 'population.json') };
    const seed = (id, name, parentId) => upsertSoul({ id, name: 'generated-handle', displayName: name,
      parentId, status: 'active', spacePath: '/private/space' }, { file: env.AGENT_BOT_POPULATION_PATH });
    seed(agentId, 'VMTwo', null);
    seed(spawnedId, 'Old name', parent);
    const handler = createLaunchHandler({ ...f.options,
      recordLaunch: () => seed(spawnedId, 'VMThree', parent),
      identityFor: (id) => soulPromptIdentity(id, { env }),
    });
    await handler(packageEvent, { ...f.ports, parent });
    assert.equal(f.reports[0].status, 'launched');
    assert.ok(message.startsWith(`You are VMThree (agent id ${spawnedId}). `));
    assert.ok(message.includes(parent
      ? `Your parent is VMTwo (agent id ${agentId}).`
      : 'You have no parent agent.'));
    assert.ok(message.endsWith(parent
      ? `You were started by ${agentId}, another agent soul, as part of its team. Join agent-comms as usual, read your inbox, and handle incoming work; your parent will brief you there.`
      : 'You were launched by a principal. Join agent-comms as usual, read your inbox, and handle incoming work.'));
    assert.ok(!message.includes('/private/'));
  }
});

test('launch identity falls back to the short Agent ID display name', async (t) => {
  let message;
  const f = fixture(t, { executorFor: () => async (input) => {
    message = input.message;
    input.appendEvent(HARNESS_SESSION_EVENT, {});
  } });
  await f.handler(event, f.ports);
  assert.equal(f.reports[0].status, 'launched');
  assert.ok(message.startsWith(`You are ${displayName(agentId)} (agent id ${agentId}). You have no parent agent.`));
});

test('a package launch spawns a soul, homes it with the package, and starts it', async (t) => {
  const homes = [];
  const f = fixture(t, { spawnPackage: (input) => {
    assert.equal(input.package, '/pkg');
    assert.equal(input.name, 'Helper');
    assert.equal(input.harness, 'claude');
    return { id: spawnedId };
  },
    lookupBinding: () => null,
    provisionHome: (soul) => { homes.push(soul); return { worktree: '/home/new', file: '/home/new/.git/agent-binding.json' }; } });
  await f.handler(packageEvent, f.ports);
  assert.deepEqual(homes, [{ agentId: spawnedId, harness: 'claude', packagePath: '/pkg' }]);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId: spawnedId });
});

test('a package launch of an installed soul\'s own folder relaunches that soul, never spawns (#80)', async (t) => {
  const f = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status: 'installed', agentId, soulDir: pkg, copies: [] }),
    provisionHome: () => { throw new Error('unexpected provision'); } });
  await f.handler(packageEvent, f.ports);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId });
  assert.equal(f.calls[0].agentId, agentId);
});

test('a package launch of a copied soul folder is refused before anything is minted (#80)', async (t) => {
  for (const status of ['copy', 'duplicate', 'unregistered']) {
    const f = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status, agentId, message: `${pkg} is a ${status}` }) });
    await f.handler(packageEvent, f.ports);
    assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'failed', agentId: null, detail: `/pkg is a ${status}` });
    assert.equal(f.calls.length, 0);
  }
});

// #432: a copy of a soul's folder carries its marker. Launching it must make
// a new soul and never rename the one it was copied from.
test('a package launch of a copied soul folder forks it into a new soul, named by the launch (#432)', async (t) => {
  const forks = [];
  const joins = [];
  const f = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status: 'copy', agentId, soulDir: '/souls/Bill.soul', message: `${pkg} is a copy` }),
    forkCopy: (input) => { forks.push(input); return { id: spawnedId }; },
    identities: () => { throw new Error('the original soul is never consulted'); },
    lookupBinding: () => null,
    provisionHome: (soul) => ({ worktree: '/home/new', file: `/home/new/${soul.agentId}` }),
    joinSoul: async (soul) => { joins.push(soul); } });
  await f.handler(packageEvent, f.ports);
  assert.equal(forks.length, 1);
  assert.deepEqual([forks[0].package, forks[0].name, forks[0].harness, forks[0].parent], ['/pkg', 'Helper', 'claude', undefined]);
  assert.equal(joins.length, 1);
  assert.equal(joins[0].agentId, spawnedId);
  assert.equal(joins[0].name, 'Helper');
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId: spawnedId });
  assert.equal(f.calls[0].agentId, spawnedId);
});

test('a forked copy that cannot start is rolled back like any spawned soul (#432)', async (t) => {
  const discarded = [];
  const f = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status: 'copy', agentId, message: `${pkg} is a copy` }),
    forkCopy: () => ({ id: spawnedId }), lookupBinding: () => null, provisionHome: () => ({ worktree: '/home/new', file: '/b' }),
    discard: (id, rollback) => { discarded.push([id, rollback]); }, executorFor: () => async () => {} });
  await f.handler(packageEvent, f.ports);
  assert.equal(f.reports[0].status, 'failed');
  assert.deepEqual(discarded, [[spawnedId, { binding: { worktree: '/home/new', file: '/b' }, joined: false }]]);
});

test('a team start never forks a copy: a soul cannot rewrite another soul\'s copied folder as its teammate (#432)', async (t) => {
  const f = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status: 'copy', agentId, message: `${pkg} is a copy` }),
    forkCopy: () => { throw new Error('unexpected fork'); }, spawnPackage: () => { throw new Error('unexpected spawn'); } });
  await f.handler(packageEvent, { ...f.ports, parent: agentId });
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'failed', agentId: null, detail: '/pkg is a copy' });
  assert.equal(f.calls.length, 0);
});

test('a copied soul folder launched without a name is refused before anything is minted (#432)', async (t) => {
  const f = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status: 'copy', agentId, message: `${pkg} is a copy` }),
    forkCopy: () => { throw new Error('unexpected fork'); } });
  await f.handler({ ...packageEvent, name: undefined }, f.ports);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'failed', agentId: null,
    detail: `/pkg is a copy of soul ${agentId}'s folder; name the launch to start it as a new soul` });
  assert.equal(f.calls.length, 0);
});

test('a package launch of an installed soul\'s folder keeps that soul\'s name; only a soul launch renames (#432)', async (t) => {
  const joins = [];
  const installed = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status: 'installed', agentId, soulDir: pkg, copies: [] }),
    joinSoul: async (soul) => { joins.push(soul.name); } });
  await installed.handler(packageEvent, installed.ports);
  const bySoul = fixture(t, { joinSoul: async (soul) => { joins.push(soul.name); } });
  await bySoul.handler(event, bySoul.ports);
  assert.deepEqual(joins, [null, 'Helper']);
  assert.deepEqual(installed.reports[0], { requestId: 'r1', status: 'launched', agentId });
});

test('a package with no soul marker still spawns a new soul (#80)', async (t) => {
  const f = fixture(t, { locatePackage: (pkg) => ({ path: pkg, status: 'package' }),
    spawnPackage: () => ({ id: spawnedId }), lookupBinding: () => null,
    provisionHome: (soul) => ({ worktree: '/home/new', file: `/home/new/${soul.packagePath}` }) });
  await f.handler(packageEvent, f.ports);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId: spawnedId });
});

test('a team start passes its parent to the spawn, the join, and the first turn; never with an existing soul (#377)', async (t) => {
  const parent = 'agent_33333333-3333-4333-8333-333333333333';
  const seen = {};
  const f = fixture(t, {
    spawnPackage: (input) => { seen.spawn = input.parent; return { id: spawnedId }; },
    joinSoul: async (soul) => { seen.join = soul.parent; },
    executorFor: () => async (input) => { seen.message = input.message; input.appendEvent(HARNESS_SESSION_EVENT, {}); },
  });
  await f.handler(packageEvent, { ...f.ports, parent });
  assert.equal(f.reports[0].status, 'launched');
  assert.equal(seen.spawn, parent);
  assert.equal(seen.join, parent);
  assert.match(seen.message, new RegExp(`started by ${parent}`));

  // An event cannot name its own parent; only the daemon's caller can.
  const forged = fixture(t, { spawnPackage: (input) => { seen.forged = input.parent; return { id: spawnedId }; }, joinSoul: async () => {} });
  await forged.handler({ ...packageEvent, requestId: 'r2', parent }, forged.ports);
  assert.equal(forged.reports[0].status, 'launched');
  assert.equal(seen.forged, undefined);

  const existing = fixture(t);
  await existing.handler(event, { ...existing.ports, parent });
  assert.equal(existing.calls.length, 0);
  assert.match(existing.reports[0].detail, /new soul/);
});

test('a launch with no harness uses the default it resolves, and fails clearly without one', async (t) => {
  const asked = [];
  const f = fixture(t, { defaultHarness: (target) => { asked.push(target); return 'claude'; } });
  await f.handler({ ...event, harness: undefined }, f.ports);
  assert.deepEqual(asked, [{ soul: agentId }]);
  assert.equal(f.calls[0].harness, 'claude');
  assert.equal(f.reports[0].status, 'launched');
  const g = fixture(t);
  await g.handler({ ...event, harness: undefined }, g.ports);
  assert.match(g.reports[0].detail, /no harness for this launch/);
});

test('a launched soul is made reachable; a failed one is not', async (t) => {
  const reachable = [];
  const f = fixture(t, { onLaunched: (id) => { reachable.push(id); } });
  await f.handler(event, f.ports);
  assert.deepEqual(reachable, [agentId]);
  const g = fixture(t, { onLaunched: (id) => { reachable.push(id); }, executorFor: () => async () => {} });
  await g.handler(event, g.ports);
  assert.deepEqual(reachable, [agentId]);
});

test('a package launch that cannot start retires the soul it spawned', async (t) => {
  const retired = [];
  const f = fixture(t, { spawnPackage: () => ({ id: spawnedId }), lookupBinding: () => null,
    provisionHome: () => ({ worktree: '/home/new', file: '/b' }), discard: (id) => { retired.push(id); },
    executorFor: () => async () => {} });
  await f.handler(packageEvent, f.ports);
  assert.equal(f.reports[0].status, 'failed');
  assert.deepEqual(retired, [spawnedId]);
});

// #419: the rollback hears how far the launch got, so it leaves agent-comms
// only after a join was attempted, and has the binding to leave as itself.
test('a failed launch hands discard the binding and whether it joined', async (t) => {
  const discarded = [];
  const discard = (id, rollback) => { discarded.push([id, rollback]); };
  const binding = { worktree: '/home/new', file: '/b' };
  const base = { spawnPackage: () => ({ id: spawnedId }), lookupBinding: () => null, provisionHome: () => binding, discard };
  const joined = fixture(t, { ...base, joinSoul: async () => {}, executorFor: () => async () => {} });
  await joined.handler(packageEvent, joined.ports);
  const refused = fixture(t, { ...base, joinSoul: async () => { throw new Error('joining agent-comms failed: no'); } });
  await refused.handler({ ...packageEvent, requestId: 'r2' }, refused.ports);
  const unbound = fixture(t, { ...base, provisionHome: () => null });
  await unbound.handler({ ...packageEvent, requestId: 'r3' }, unbound.ports);
  assert.deepEqual(discarded, [
    [spawnedId, { binding, joined: true }],
    [spawnedId, { binding, joined: true }],
    [spawnedId, { binding: null, joined: false }],
  ]);
});

test('a package launch with the executor off mints nothing', async (t) => {
  let spawns = 0;
  const f = fixture(t, { executorFor: null, spawnPackage: () => { spawns += 1; return { id: spawnedId }; } });
  await f.handler(packageEvent, f.ports);
  assert.match(f.reports[0].detail, /executor is disabled/);
  assert.equal(spawns, 0);
});

for (const [name, overrides, input, reason] of [
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
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId: identity.id });
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

test('joins the soul to agent-comms before its first turn, and fails the launch when joining fails', async (t) => {
  const order = [];
  const joined = fixture(t, { joinSoul: async (soul) => { order.push(['join', soul]); } });
  const run = joined.options.executorFor;
  const handler = createLaunchHandler({ ...joined.options, executorFor: (args) => { order.push(['turn']); return run(args); } });
  await handler(event, joined.ports);
  assert.deepEqual(order, [['join', { agentId, harness: 'claude', name: 'Helper', binding: { worktree: '/work', file: '/private/binding' } }], ['turn']]);
  assert.equal(joined.reports[0].status, 'launched');

  const refused = fixture(t, { joinSoul: async () => { throw new Error('joining agent-comms failed: broker-unreachable'); } });
  await refused.handler(event, refused.ports);
  assert.equal(refused.calls.length, 0);
  assert.deepEqual(refused.reports[0], { requestId: 'r1', status: 'failed', agentId: null, detail: 'joining agent-comms failed: broker-unreachable' });
});

test('a launch records the soul as managed with its comms setting before the first turn', async (t) => {
  const order = [];
  const f = fixture(t, {
    recordLaunch: (launch) => { order.push(['record', launch]); },
    executorFor: () => async (input) => { order.push(['turn']); input.appendEvent(HARNESS_SESSION_EVENT, {}); },
  });
  await f.handler(event, f.ports);
  assert.deepEqual(order, [
    ['record', { agentId, package: null, binding: { worktree: '/work', file: '/private/binding' } }],
    ['turn'],
  ]);
  assert.equal(f.reports[0].status, 'launched');
});

test('a launch whose comms setting cannot be recorded never starts', async (t) => {
  const f = fixture(t, { recordLaunch: () => { throw new Error('no population record; cannot record comms off'); } });
  await f.handler(event, f.ports);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'failed', agentId: null, detail: 'no population record; cannot record comms off' });
});

test('comms is read from soul.json at launch only: later edits wait for the next launch', async (t) => {
  const { upsertSoul, recordSoulLaunch, showSoul } = await import('../agent-population.mjs');
  const { launchCommsSetting } = await import('../daemon-launch.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'launch-comms-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soulDir = path.join(root, 'Bill.soul');
  mkdirSync(soulDir);
  const population = path.join(root, 'population.json');
  upsertSoul({ id: agentId, status: 'active', spacePath: path.join(root, 'space'), lastSeen: '2026-10-03T00:00:00.000Z' }, { file: population });
  assert.equal(showSoul(agentId, { file: population }).comms, true, 'default on');
  assert.equal(showSoul(agentId, { file: population }).managed, false);

  assert.equal(launchCommsSetting({ soulDir }), true, 'no soul.json means on');
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify({ comms: false }));
  const handler = createLaunchHandler({
    file: path.join(root, 'launch-requests.json'),
    identities: () => ({ id: agentId, harness: 'claude' }),
    spawnPackage: () => { throw new Error('unexpected spawn'); },
    lookupBinding: () => ({ worktree: '/work', file: '/private/binding' }),
    provisionHome: () => null,
    recordLaunch: ({ agentId: id }) => recordSoulLaunch(id, { comms: launchCommsSetting({ soulDir }) }, { file: population }),
    executorFor: () => async (input) => { input.appendEvent(HARNESS_SESSION_EVENT, {}); },
  });
  await handler(event, { account: 'worker', report: async () => {} });
  assert.deepEqual([showSoul(agentId, { file: population }).managed, showSoul(agentId, { file: population }).comms], [true, false]);

  // The soul is running: switching soul.json back on changes nothing yet.
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify({ comms: true }));
  assert.equal(showSoul(agentId, { file: population }).comms, false);
  await handler({ ...event, requestId: 'r2' }, { account: 'worker', report: async () => {} });
  assert.equal(showSoul(agentId, { file: population }).comms, true, 'the next launch picks it up');
});

test('a launch can choose comms before start; an invalid choice never starts (#381)', async (t) => {
  const records = [];
  const f = fixture(t, { recordLaunch: (launch) => { records.push(launch); } });
  await f.handler({ ...event, comms: false }, f.ports);
  assert.deepEqual(records[0], { agentId, package: null, binding: { worktree: '/work', file: '/private/binding' },
    comms: false, principal: 'p1' });
  assert.equal(f.reports[0].status, 'launched');

  const g = fixture(t, { recordLaunch: () => { throw new Error('unexpected record'); } });
  await g.handler({ ...event, requestId: 'r2', comms: 'off' }, g.ports);
  assert.equal(g.calls.length, 0);
  assert.deepEqual(g.reports[0], { requestId: 'r2', status: 'failed', agentId: null, detail: 'invalid launch comms' });
});

test('launch persists the selected model after census recording and before the first turn', async (t) => {
  const { recordLaunchSettings } = await import('../agent-daemon.mjs');
  const { populationFile, upsertSoul, showSoul } = await import('../agent-population.mjs');
  const { soulModel, setSoulModel } = await import('../soul-model.mjs');
  const { auditFile } = await import('../agent-principals.mjs');
  const f = fixture(t);
  const env = { HOME: f.root, XDG_STATE_HOME: path.join(f.root, 'state'), AGENT_BOT_INTERACTION_HOME: path.join(f.root, 'interaction') };
  const options = { env, home: f.root, config: {}, now: () => new Date('2026-10-05T00:00:00.000Z') };
  const population = populationFile(options);
  upsertSoul({ id: agentId, status: 'active', spacePath: path.join(f.root, 'space'), lastSeen: '2026-10-05T00:00:00.000Z' }, { file: population });
  const seen = [];
  const handler = createLaunchHandler({ ...f.options,
    recordLaunch: (launch) => recordLaunchSettings(launch, options),
    executorFor: () => {
      assert.equal(showSoul(agentId, { file: population }).managed, true);
      seen.push(soulModel(agentId, options).model);
      return async (input) => input.appendEvent(HARNESS_SESSION_EVENT, {});
    },
  });
  await handler({ ...event, model: 'chosen' }, f.ports);
  assert.equal(f.reports[0].status, 'launched');
  assert.deepEqual(seen, ['chosen']);
  const receipt = JSON.parse(readFileSync(auditFile(options), 'utf8').trim());
  assert.deepEqual(receipt, { at: '2026-10-05T00:00:00.000Z', event: 'soul-model', agentId, operation: 'set', decision: 'chosen' });
  const before = readFileSync(auditFile(options), 'utf8');
  await handler({ ...event, requestId: 'no-model' }, f.ports);
  assert.deepEqual(seen, ['chosen', 'chosen']);
  assert.equal(readFileSync(auditFile(options), 'utf8'), before);
  setSoulModel(spawnedId, 'original', options);
  await assert.rejects(recordLaunchSettings({ agentId: spawnedId, model: 'new', comms: false }, options), /no population record/);
  assert.equal(soulModel(spawnedId, options).model, 'original');
});

test('invalid launch model is refused before provisioning or starting', async (t) => {
  for (const model of [null, '', ' ', false, 42, 'x'.repeat(121), 'bad\nmodel', 'bad\x85model']) {
    const f = fixture(t, { spawnPackage: () => assert.fail('invalid model must not mint'),
      recordLaunch: () => assert.fail('invalid model must not record') });
    await f.handler({ ...packageEvent, model }, f.ports);
    assert.equal(f.reports[0].status, 'failed');
    assert.match(f.reports[0].detail, /modelId/);
    assert.equal(f.calls.length, 0);
  }
});

test('launch brief is validated before minting, recording or starting', async (t) => {
  for (const brief of [null, 42, false, [], {}, ' ', '\n\t', 'x'.repeat(4001), 'a\rb', '\0x', 'x\x7f', 'x\x85', '\x1fx']) {
    const f = fixture(t, { spawnPackage: () => assert.fail('must not mint'),
      recordLaunch: () => assert.fail('must not record') });
    await f.handler({ ...packageEvent, brief }, f.ports);
    assert.equal(f.reports[0].detail, 'invalid launch brief');
    assert.equal(f.calls.length, 0);
  }
});

test('brief renders after identity, records before the turn, survives upsert/relaunch, and clears explicitly', async (t) => {
  const { recordLaunchSettings } = await import('../agent-daemon.mjs');
  const { populationFile, showSoul } = await import('../agent-population.mjs');
  const f = fixture(t);
  const options = { home: f.root, env: { HOME: f.root, XDG_STATE_HOME: path.join(f.root, 'state') }, config: {} };
  const file = populationFile(options);
  const row = { id: agentId, status: 'active', spacePath: path.join(f.root, 'space') };
  upsertSoul(row, { file });
  const messages = [];
  const handler = createLaunchHandler({ ...f.options,
    recordLaunch: (launch) => recordLaunchSettings(launch, options),
    executorFor: () => async (input) => {
      messages.push(input.message);
      const brief = showSoul(agentId, { file }).brief;
      if (brief) assert.ok(input.message.includes(`Your brief from the person who launched you:\n${brief}`));
      input.appendEvent(HARNESS_SESSION_EVENT, {});
    },
  });
  await handler({ ...event, brief: '  Review the code.\n\tReport findings.  ' }, f.ports);
  const brief = 'Review the code.\n\tReport findings.';
  assert.equal(showSoul(agentId, { file }).brief, brief);
  const { spawnSync } = await import('node:child_process');
  const shown = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'agent-bot.mjs'), 'soul', 'show', agentId, '--json'],
    { encoding: 'utf8', env: { HOME: f.root, PATH: process.env.PATH, AGENT_BOT_POPULATION_PATH: file } });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).brief, brief);
  assert.match(messages[0], /You have no parent agent\. \n\nYour brief from the person who launched you:\nReview/);
  upsertSoul({ ...row, status: 'active' }, { file });
  assert.equal(showSoul(agentId, { file }).brief, brief);
  await handler({ ...event, requestId: 'relaunch' }, f.ports);
  assert.equal(messages[1], messages[0]);
  await handler({ ...event, requestId: 'clear', brief: '' }, f.ports);
  assert.equal(showSoul(agentId, { file }).brief, '');
  assert.doesNotMatch(messages[2], /Your brief/);
  await handler({ ...event, requestId: 'after-clear' }, f.ports);
  assert.doesNotMatch(messages[3], /Your brief/);
  assert.ok(f.reports.every((row) => row.status === 'launched'));
  assert.doesNotMatch(readFileSync(f.options.file, 'utf8'), /Review the code/);
});

test('brief accepts both length boundaries and trims before recording', async (t) => {
  for (const brief of ['x', 'x'.repeat(4000), '\t x \n', '']) {
    const f = fixture(t, { recordLaunch: (launch) => { assert.equal(launch.brief, brief.trim()); } });
    await f.handler({ ...event, brief }, f.ports);
    assert.equal(f.reports[0].status, 'launched');
  }
});

test('a harness the daemon cannot start is refused before a package spawn mints (#531)', async (t) => {
  const spawns = [];
  const f = fixture(t, {
    spawnPackage: (request) => { spawns.push(request); return { id: agentId }; },
    harnessProblem: (harness) => (harness === 'kiro' ? 'agent-bot has no such harness' : harness === 'muse' ? 'it is disabled in agent-bot' : null),
  });
  await f.handler(event, f.ports);
  assert.equal(f.reports[0].status, 'launched', 'a harness without a problem launches as before');
  await f.handler({ ...event, requestId: 'r-kiro', soul: undefined, package: '/pkg', harness: 'kiro' }, f.ports);
  assert.deepEqual(f.reports[1], { requestId: 'r-kiro', status: 'failed', agentId: null,
    detail: 'cannot launch on harness kiro: agent-bot has no such harness; a harness agent-bot cannot start joins from its own session with `agent-bot join`' });
  await f.handler({ ...event, requestId: 'r-muse', harness: 'muse' }, f.ports);
  assert.deepEqual(f.reports[2], { requestId: 'r-muse', status: 'failed', agentId: null, detail: 'cannot launch on harness muse: it is disabled in agent-bot' });
  assert.deepEqual(spawns, [], 'nothing minted');
  assert.equal(f.calls.length, 1, 'no executor for a refused launch');
});

test('a rollback that fails part way is named beside the launch failure (#531)', async (t) => {
  const spawnedId = 'agent_22222222-2222-4222-8222-222222222222';
  const f = fixture(t, {
    spawnPackage: () => ({ id: spawnedId }),
    executorFor: () => async () => { throw new Error('no ACP drive entry for harness \'kiro\''); },
    discard: async () => { throw new Error('ENOTEMPTY: directory not empty, rename \'/souls/Kiro.soul\' -> \'/souls/.archive/Kiro.soul\''); },
  });
  await f.handler({ ...event, requestId: 'r-roll', soul: undefined, package: '/pkg' }, f.ports);
  assert.deepEqual(f.reports[0], { requestId: 'r-roll', status: 'failed', agentId: null,
    detail: 'no ACP drive entry for harness \'kiro\' (rollback failed: ENOTEMPTY: directory not empty, rename \'/souls/Kiro.soul\' -> \'/souls/.archive/Kiro.soul\')' });
  assert.equal(JSON.parse(readFileSync(f.options.file))[0].detail, f.reports[0].detail, 'the journal keeps it too');
});

test('launch progress is reported stage by stage, best effort, and kept in the journal (#536)', async (t) => {
  const stages = [];
  const f = fixture(t, { joinSoul: async () => 'addr' });
  await f.handler(event, { ...f.ports, progress: async ({ requestId, stage }) => { stages.push(`${requestId}:${stage}`); } });
  assert.deepEqual(stages, ['r1:checking', 'r1:account', 'r1:joining', 'r1:harness']);
  assert.equal(f.reports[0].status, 'launched');
  assert.equal(JSON.parse(readFileSync(f.options.file))[0].stage, 'harness');
  // A refused launch stops at its checks, and the journal says so.
  const refusing = createLaunchHandler({ ...f.options, harnessProblem: () => 'agent-bot has no such harness' });
  const seen = [];
  await refusing({ ...event, requestId: 'r3', harness: 'kiro' }, { ...f.ports, progress: async ({ stage }) => { seen.push(stage); } });
  assert.deepEqual(seen, ['checking']);
  assert.equal(JSON.parse(readFileSync(f.options.file)).find((r) => r.requestId === 'r3').stage, 'checking');
  // A broker without the op, or none at all, never fails a launch.
  const g = fixture(t);
  await g.handler(event, { ...g.ports, progress: async () => { throw new Error('unknown op'); } });
  assert.equal(g.reports[0].status, 'launched');
  const h = fixture(t);
  await h.handler(event, h.ports);
  assert.equal(h.reports[0].status, 'launched');
});
