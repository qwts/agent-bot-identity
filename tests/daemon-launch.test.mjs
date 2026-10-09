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
import { sandboxPlan } from '../sandbox.mjs';
import { computePackageRevision } from '../soul-package.mjs';


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

test('a package launch carries a trimmed role to the spawn; a bad role or a role on a relaunch never starts (#535)', async (t) => {
  const seen = [];
  const f = fixture(t, { spawnPackage: (input) => { seen.push(input.role); return { id: spawnedId }; },
    lookupBinding: () => null, provisionHome: () => ({ worktree: '/home/new', file: '/home/new/.git/agent-binding.json' }) });
  await f.handler({ ...packageEvent, role: '  Researcher  ' }, f.ports);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId: spawnedId });
  assert.deepEqual(seen, ['Researcher']);
  await f.handler({ ...packageEvent, requestId: 'r2' }, f.ports);
  assert.equal(Object.hasOwn(f.calls.at(-1) ?? {}, 'role'), false);
  assert.deepEqual(seen, ['Researcher', undefined]);

  const g = fixture(t, { spawnPackage: () => { throw new Error('unexpected spawn'); } });
  for (const [requestId, role] of [['r3', 'x'.repeat(61)], ['r4', '  '], ['r5', 'a\nb'], ['r6', 7]]) {
    await g.handler({ ...packageEvent, requestId, role }, g.ports);
    assert.deepEqual(g.reports.at(-1), { requestId, status: 'failed', agentId: null, detail: 'invalid launch role' });
  }
  await g.handler({ ...event, requestId: 'r7', role: 'Researcher' }, g.ports);
  assert.equal(g.reports.at(-1).status, 'failed');
  assert.match(g.reports.at(-1).detail, /a launch role names a new soul/);
  assert.equal(g.calls.length, 0);
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

  // Without `souls` to check it against, an event's own parent is dropped;
  // only the daemon's caller can name one (a principal's goes through the census check below).
  const forged = fixture(t, { spawnPackage: (input) => { seen.forged = input.parent; return { id: spawnedId }; }, joinSoul: async () => {} });
  await forged.handler({ ...packageEvent, requestId: 'r2', parent }, forged.ports);
  assert.equal(forged.reports[0].status, 'launched');
  assert.equal(seen.forged, undefined);

  const existing = fixture(t);
  await existing.handler(event, { ...existing.ports, parent });
  assert.equal(existing.calls.length, 0);
  assert.match(existing.reports[0].detail, /new soul/);
});

test('a principal launch names the new soul\'s parent, checked against the active census; a relaunch keeps its recorded parent (GeniusBar#261)', async (t) => {
  const parent = 'agent_33333333-3333-4333-8333-333333333333';
  const other = 'agent_44444444-4444-4444-8444-444444444444';
  const gone = 'agent_55555555-5555-4555-8555-555555555555';
  const census = [{ id: parent, parentId: null }, { id: other, parentId: null }, { id: agentId, parentId: null }];
  const make = (rows = census, extra = {}) => {
    const seen = {};
    const receipts = [];
    const f = fixture(t, { souls: () => rows, receipt: (line) => receipts.push(line),
      spawnPackage: (input) => { seen.request = input; return { id: spawnedId }; },
      joinSoul: async (soul) => { seen.join = soul.parent; },
      executorFor: () => async (input) => { seen.message = input.message; input.appendEvent(HARNESS_SESSION_EVENT, {}); }, ...extra });
    return { ...f, seen, receipts };
  };
  // Absent and null both start an independent soul, as every launch did before.
  for (const fields of [{}, { parent: null }]) {
    const f = make();
    await f.handler({ ...packageEvent, ...fields }, f.ports);
    assert.equal(f.reports[0].status, 'launched');
    assert.equal(Object.hasOwn(f.seen.request, 'parent'), false);
    assert.equal(f.seen.join, undefined);
    assert.match(f.seen.message, /You have no parent agent\. You were launched by a principal/);
    assert.deepEqual(f.receipts, []);
  }
  // A valid parent reaches the spawn, the join and the first turn, with the receipt a team start leaves.
  const ok = make();
  await ok.handler({ ...packageEvent, parent }, ok.ports);
  assert.equal(ok.reports[0].status, 'launched');
  assert.equal(ok.seen.request.parent, parent);
  assert.equal(ok.seen.join, parent);
  assert.match(ok.seen.message, new RegExp(`Your parent is .*${parent}.*started by ${parent}, another agent soul, as part of its team`));
  assert.deepEqual(ok.receipts, [{ parent, decision: 'launched' }]);
  // A refusal is the launch's failed result; nothing is minted, and a parent that could be named gets the refusal receipt.
  for (const [target, requested, reason, receipts] of [
    [packageEvent, gone, /is not an active soul in this account's census/, [{ parent: gone, decision: 'refused: parent' }]],
    [packageEvent, 'none', /invalid launch parent/, []],
    [packageEvent, 42, /invalid launch parent/, []],
    [event, agentId, /cannot be its own parent/, []],
    [event, parent, /cannot change its parent to .* names no parent/, [{ parent, decision: 'refused: parent' }]],
  ]) {
    const f = make();
    await f.handler({ ...target, parent: requested }, f.ports);
    assert.equal(f.reports[0].status, 'failed', String(requested));
    assert.match(f.reports[0].detail, reason);
    assert.equal(f.seen.request, undefined);
    assert.equal(f.seen.message, undefined);
    assert.deepEqual(f.receipts, receipts);
  }
  // A relaunch names the parent its census row records: accepted as is, never rebound, no receipt.
  const teamed = [{ id: parent, parentId: null }, { id: other, parentId: null }, { id: agentId, parentId: parent }];
  const same = make(teamed);
  await same.handler({ ...event, parent }, same.ports);
  assert.equal(same.reports[0].status, 'launched');
  assert.equal(same.seen.request, undefined);
  assert.match(same.seen.message, /launched by a principal/);
  assert.equal(same.seen.join, undefined);
  assert.deepEqual(same.receipts, []);
  for (const [requested, reason] of [[other, /cannot change its parent to .* names agent_3333/], [null, /cannot make it independent/]]) {
    const f = make(teamed);
    await f.handler({ ...event, parent: requested }, f.ports);
    assert.equal(f.reports[0].status, 'failed');
    assert.match(f.reports[0].detail, reason);
    assert.equal(f.seen.message, undefined);
  }
  // A launch that fails after its parent was accepted leaves the failed receipt on that parent.
  const broken = make(census, { executorFor: () => async () => { throw new Error('harness exploded'); } });
  await broken.handler({ ...packageEvent, parent }, broken.ports);
  assert.equal(broken.reports[0].status, 'failed');
  assert.match(broken.reports[0].detail, /harness exploded/);
  assert.deepEqual(broken.receipts, [{ parent, decision: 'failed' }]);
  // A team start's caller still wins over anything the event says, with no principal receipt.
  const team = make();
  await team.handler({ ...packageEvent, parent: gone }, { ...team.ports, parent });
  assert.equal(team.reports[0].status, 'launched');
  assert.equal(team.seen.request.parent, parent);
  assert.deepEqual(team.receipts, []);
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
    identity = mintAgentIdentity({ packageRevision: computePackageRevision(request.package), harness: request.harness, useGithub: false, stateDir });
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

test('a declared runtime missing from the soul is installed at launch as its own stage, and a failed install is a coded failure (#583 slice 3)', async (t) => {
  const installs = [];
  const f = fixture(t, { joinSoul: async () => 'addr', runtimes: { pending: async ({ agentId: id, harness }) => (harness === 'claude' ? ['node'] : []), install: async (args) => { installs.push(args); } } });
  const stages = [];
  await f.handler(event, { ...f.ports, progress: async ({ stage }) => { stages.push(stage); } });
  assert.deepEqual(stages, ['checking', 'account', 'runtimes', 'joining', 'harness']);
  assert.deepEqual(installs, [{ agentId, harness: 'claude' }]);
  assert.equal(f.reports[0].status, 'launched');
  // Nothing pending: no stage is reported and nothing is installed.
  const g = fixture(t, { joinSoul: async () => 'addr', runtimes: { pending: async () => [], install: async () => { throw new Error('unexpected install'); } } });
  const quiet = [];
  await g.handler({ ...event, requestId: 'r2' }, { ...g.ports, progress: async ({ stage }) => { quiet.push(stage); } });
  assert.deepEqual(quiet, ['checking', 'account', 'joining', 'harness']);
  // The install's coded error reaches the result and the journal; the harness never starts.
  const error = Object.assign(new Error('node 24.21.0 for Billy.soul hashed sha256:abc, expected sha256:def'), { code: 'runtime-checksum-mismatch' });
  const h = fixture(t, { joinSoul: async () => { throw new Error('joined before its runtimes'); }, runtimes: { pending: async () => ['node'], install: async () => { throw error; } } });
  await h.handler({ ...event, requestId: 'r3' }, h.ports);
  assert.deepEqual(h.reports[0], { requestId: 'r3', status: 'failed', agentId: null, detail: `runtime-checksum-mismatch: ${error.message}`, code: 'runtime-checksum-mismatch' });
  assert.equal(JSON.parse(readFileSync(h.options.file)).find((row) => row.requestId === 'r3').code, 'runtime-checksum-mismatch');
  assert.deepEqual(h.calls, [], 'no turn ran');
});

// Sandbox resolution at launch (#376). `sandboxFor` stands in for
// sandbox.mjs's launchSandbox; the steps are the real plan for the checks.
const READY = { supported: true, exists: true, standard: true, home: { path: '/Users/geniusbar-agent', exists: true }, devTools: true, paired: true, fleet: true, harnessSignIn: 'unknown' };
const MISSING = { supported: true, exists: false, standard: null, home: null, devTools: true, paired: false, fleet: false, harnessSignIn: 'unknown' };
const sandboxed = ({ status, checks, self = 'geniusbar-agent' }) => ({ resolution: 'sandboxed', override: 'sandboxed', source: 'override', account: 'geniusbar-agent', self,
  status, steps: sandboxPlan({ account: 'geniusbar-agent', owner: 'owner', checks }) });
const journal = (f, requestId = 'r1') => JSON.parse(readFileSync(f.options.file)).find((row) => row.requestId === requestId);

test('without a sandbox resolver a launch is unchanged and its journal has no sandbox (#376)', async (t) => {
  const f = fixture(t);
  await f.handler(event, f.ports);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId });
  assert.equal('sandbox' in journal(f), false);
});

test('an unrestricted soul launches as before and the journal says it runs as the owner (#376)', async (t) => {
  const asked = [];
  const f = fixture(t, { sandboxFor: (query) => { asked.push(query); return { resolution: 'unrestricted', override: 'inherit', source: 'global', account: 'owner', self: 'owner' }; } });
  await f.handler(event, f.ports);
  assert.deepEqual(asked, [{ agentId, name: 'Helper' }], 'the launch name reaches the resolver for the pack\'s name rules');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.reports[0], { requestId: 'r1', status: 'launched', agentId, sandbox: { resolution: 'unrestricted', account: 'owner' } });
  assert.deepEqual(journal(f).sandbox, { resolution: 'unrestricted', account: 'owner' });
});

test('a sandboxed soul with a ready account launches from the daemon running in that account (#376)', async (t) => {
  const stages = [];
  const f = fixture(t, { sandboxFor: () => sandboxed({ status: 'ready', checks: READY }) });
  await f.handler(event, { ...f.ports, progress: async ({ stage }) => { stages.push(stage); } });
  assert.deepEqual(stages, ['checking', 'account', 'harness']);
  assert.equal(f.reports[0].status, 'launched');
  assert.deepEqual(journal(f).sandbox, { resolution: 'sandboxed', account: 'geniusbar-agent' });
});

test('a sandbox account whose only step left is the join takes the launch that joins it (#376)', async (t) => {
  const f = fixture(t, { sandboxFor: () => sandboxed({ status: 'creating', checks: { ...READY, fleet: false } }) });
  await f.handler(event, f.ports);
  assert.equal(f.reports[0].status, 'launched');
});

test('a sandboxed soul the owner\'s daemon cannot run as another account fails at account, saying so (#376)', async (t) => {
  const stages = [];
  const f = fixture(t, { sandboxFor: () => sandboxed({ status: 'ready', checks: READY, self: 'owner' }) });
  await f.handler(event, { ...f.ports, progress: async ({ stage }) => { stages.push(stage); } });
  assert.deepEqual(stages, ['checking', 'account']);
  assert.equal(f.calls.length, 0, 'no harness starts as the owner instead');
  assert.equal(f.reports[0].status, 'failed');
  assert.equal(f.reports[0].code, 'sandbox-other-account');
  assert.match(f.reports[0].detail, /^sandbox-other-account: this soul runs sandboxed as geniusbar-agent, and this daemon runs as owner/);
  assert.deepEqual(f.reports[0].sandbox, { resolution: 'sandboxed', account: 'geniusbar-agent' });
  assert.equal(journal(f).stage, 'account');
});

test('a sandboxed launch whose account is missing fails at account with the owner\'s steps, minting nothing (#376)', async (t) => {
  const stages = [];
  let spawned = 0;
  const f = fixture(t, { sandboxFor: ({ agentId: id }) => { assert.equal(id, null, 'a new soul has no override yet'); return sandboxed({ status: 'missing', checks: MISSING }); },
    spawnPackage: () => { spawned += 1; return { id: spawnedId }; }, discard: () => { throw new Error('nothing to discard'); } });
  await f.handler(packageEvent, { ...f.ports, progress: async ({ stage }) => { stages.push(stage); } });
  assert.deepEqual(stages, ['checking', 'account']);
  assert.equal(spawned, 0);
  assert.equal(f.calls.length, 0);
  const [report] = f.reports;
  assert.equal(report.status, 'failed');
  assert.equal(report.agentId, null);
  assert.equal(report.code, 'sandbox-not-ready');
  assert.equal(report.detail, 'sandbox-not-ready: this soul runs sandboxed as geniusbar-agent, which is missing. '
    + 'Next: Create the standard account geniusbar-agent (owner-admin): sudo sysadminctl -addUser geniusbar-agent -fullName "GeniusBar Agent" -password -. '
    + 'Then: standard-account, broker-group, pair, harness-sign-in. `agent-bot sandbox plan` prints every step\'s commands.');
  assert.ok(report.detail.length <= 512, 'fits the broker\'s launch detail');
  const row = journal(f);
  assert.equal(row.stage, 'account');
  assert.equal(row.code, 'sandbox-not-ready');
  assert.deepEqual(row.sandbox, { resolution: 'sandboxed', account: 'geniusbar-agent' });
});

for (const [code, refused] of [
  ['persona-policy-unavailable', { reason: 'invalid SOP persona record at /p', action: 'fix the SOP config or record, then run `agent-bot sop persona`' }],
  ['persona-policy-stale', { reason: 'the recorded persona mapping is for o/sop, not the SOP the config selects', action: 'run `agent-bot sop persona`', source: { repository: 'o/sop', commit: 'a'.repeat(40) } }],
  ['persona-policy-requires-addon', { reason: 'the SOP decides sandboxed as gb-x, but features.persona-accounts is off', action: 'the owner turns persona accounts on with `agent-bot sandbox on`' }],
]) test(`a configured persona policy that refuses (${code}) fails at account before any mint, binding or harness (#613)`, async (t) => {
  const stages = [];
  let spawned = 0;
  // The user setting (unrestricted here) is what a fallback would have run.
  const f = fixture(t, { sandboxFor: () => ({ resolution: 'unrestricted', override: 'inherit', source: 'global', account: 'owner', self: 'owner', refused: { code, ...refused } }),
    spawnPackage: () => { spawned += 1; return { id: spawnedId }; }, discard: () => { throw new Error('nothing to discard'); } });
  await f.handler(packageEvent, { ...f.ports, progress: async ({ stage }) => { stages.push(stage); } });
  assert.deepEqual(stages, ['checking', 'account']);
  assert.equal(spawned, 0, 'no identity is minted');
  assert.equal(f.calls.length, 0, 'no harness runs');
  const [report] = f.reports;
  assert.equal(report.status, 'failed');
  assert.equal(report.code, code);
  assert.ok(report.detail.startsWith(`${code}: ${refused.reason}`));
  assert.ok(report.detail.length <= 512);
  assert.equal(journal(f).code, code);
});

test('a persona refusal with an oversized reason and source still reports within the broker detail limit, prefix included (#613)', async (t) => {
  const { sandboxLaunchProblem } = await import('../sandbox.mjs');
  const refused = { code: 'persona-policy-unavailable', reason: `invalid SOP persona record at /${'x'.repeat(2000)}`,
    action: 'fix the SOP config or record, then run `agent-bot sop persona`', source: { repository: `${'o'.repeat(60)}/${'r'.repeat(200)}`, commit: 'a'.repeat(40) } };
  const sandbox = { resolution: 'unrestricted', override: 'inherit', source: 'global', account: 'owner', self: 'owner', refused };
  assert.ok(`${refused.code}: ${sandboxLaunchProblem(sandbox).message}`.length <= 512);
  const f = fixture(t, { sandboxFor: () => sandbox });
  await f.handler(event, f.ports);
  const [report] = f.reports;
  assert.equal(report.status, 'failed');
  assert.equal(report.code, 'persona-policy-unavailable');
  assert.ok(report.detail.length <= 512, `detail is ${report.detail.length} characters`);
  assert.match(report.detail, /^persona-policy-unavailable: invalid SOP persona record at \/x+…/);
});

test('a sandboxed launch with an account still being set up names the step that is not done (#376)', async (t) => {
  const f = fixture(t, { sandboxFor: () => sandboxed({ status: 'creating', checks: { ...READY, standard: false, paired: false, fleet: false } }) });
  await f.handler(event, f.ports);
  assert.equal(f.reports[0].code, 'sandbox-not-ready');
  assert.match(f.reports[0].detail, /which is creating\. Next: geniusbar-agent has no admin rights \(owner-admin\): sudo dseditgroup -o edit -d geniusbar-agent -t user admin\. Then: broker-group, pair, harness-sign-in\./);
});

test('a sandboxed launch off macOS fails at account rather than running unsandboxed (#376)', async (t) => {
  const f = fixture(t, { sandboxFor: () => ({ ...sandboxed({ status: 'unsupported', checks: { supported: false } }), steps: [] }) });
  await f.handler(event, f.ports);
  assert.equal(f.calls.length, 0);
  assert.equal(f.reports[0].code, 'sandbox-not-ready');
  assert.match(f.reports[0].detail, /persona accounts need macOS/);
});

test('a routable harness gets its tool home made at launch as its own stage before the soul joins, and an unwritable one is a coded failure (#583 slice 2)', async (t) => {
  const prepared = [];
  const f = fixture(t, { joinSoul: async () => 'addr', toolHomes: { pending: async ({ harness }) => (harness === 'claude' ? ['tool-home:claude'] : []), prepare: async (args) => { prepared.push(args); } } });
  const stages = [];
  await f.handler(event, { ...f.ports, progress: async ({ stage }) => { stages.push(stage); } });
  assert.deepEqual(stages, ['checking', 'account', 'tool-home', 'joining', 'harness']);
  assert.deepEqual(prepared, [{ agentId, harness: 'claude' }]);
  assert.equal(f.reports[0].status, 'launched');
  // An unroutable harness has nothing pending and no stage.
  const g = fixture(t, { joinSoul: async () => 'addr', toolHomes: { pending: async () => [], prepare: async () => { throw new Error('unexpected prepare'); } } });
  const quiet = [];
  await g.handler({ ...event, requestId: 'r2', harness: 'muse' }, { ...g.ports, progress: async ({ stage }) => { quiet.push(stage); } });
  assert.deepEqual(quiet, ['checking', 'account', 'joining', 'harness']);
  const error = Object.assign(new Error('claude\'s tool home /souls/x/.soul-state/tools/claude cannot be created (EACCES); fix the soul folder\'s permissions'), { code: 'tool-home-unwritable' });
  const h = fixture(t, { joinSoul: async () => { throw new Error('joined without its tool home'); }, toolHomes: { pending: async () => ['tool-home:claude'], prepare: async () => { throw error; } } });
  await h.handler({ ...event, requestId: 'r3' }, h.ports);
  assert.deepEqual(h.reports[0], { requestId: 'r3', status: 'failed', agentId: null, detail: `tool-home-unwritable: ${error.message}`, code: 'tool-home-unwritable' });
  assert.equal(JSON.parse(readFileSync(h.options.file)).find((row) => row.requestId === 'r3').stage, 'tool-home');
  assert.deepEqual(h.calls, [], 'no turn ran');
});

test('a declared provider secret is checked at launch as its own stage before the soul joins, and a missing one is a coded failure naming the command (#583 slice 4)', async (t) => {
  const checks = [];
  const f = fixture(t, { joinSoul: async () => 'addr', providers: { pending: async ({ harness }) => (harness === 'claude' ? ['claude:anthropic'] : []), check: async (args) => { checks.push(args); } } });
  const stages = [];
  await f.handler(event, { ...f.ports, progress: async ({ stage }) => { stages.push(stage); } });
  assert.deepEqual(stages, ['checking', 'account', 'provider', 'joining', 'harness']);
  assert.deepEqual(checks, [{ agentId, harness: 'claude' }]);
  assert.equal(f.reports[0].status, 'launched');
  const g = fixture(t, { joinSoul: async () => 'addr', providers: { pending: async () => [], check: async () => { throw new Error('unexpected check'); } } });
  const quiet = [];
  await g.handler({ ...event, requestId: 'r2' }, { ...g.ports, progress: async ({ stage }) => { quiet.push(stage); } });
  assert.deepEqual(quiet, ['checking', 'account', 'joining', 'harness']);
  const error = Object.assign(new Error('claude\'s provider anthropic needs the secret "anthropic-key" (ANTHROPIC_API_KEY), which is not stored for this soul'),
    { code: 'provider-secret-missing', action: `agent-bot soul secret ${agentId} set anthropic-key` });
  const h = fixture(t, { joinSoul: async () => { throw new Error('joined without its secret'); }, providers: { pending: async () => ['claude:anthropic'], check: async () => { throw error; } } });
  await h.handler({ ...event, requestId: 'r3' }, h.ports);
  assert.deepEqual(h.reports[0], { requestId: 'r3', status: 'failed', agentId: null, detail: `provider-secret-missing: ${error.message}`, code: 'provider-secret-missing' });
  assert.equal(JSON.parse(readFileSync(h.options.file)).find((row) => row.requestId === 'r3').code, 'provider-secret-missing');
  assert.deepEqual(h.calls, [], 'no turn ran');
});
