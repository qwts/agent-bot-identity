// `agent-bot soul fork` (GeniusBar #83): a Finder copy of a soul's folder
// becomes a new soul in place, the original untouched; a failure rolls back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentIdentity } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { listSouls, locateSoulDir, recordSoulDisplayName, showSoul } from '../agent-population.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { HARNESS_SESSION_EVENT } from '../executor-contract.mjs';
import { ownerActionSummary } from '../owner-action.mjs';
import { forkSoul, parseForkArgs } from '../soul-fork.mjs';
import { createSoulHomes } from '../soul-home.mjs';
import { joinSoul } from '../soul-join.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { spawnSoulTemplate } from '../soul-templates.mjs';

const FAKE_COMMS = fileURLToPath(new URL('./fixtures/fake-agent-comms.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

// A scratch account with a fake agent-comms on PATH, and Bill, a Starter
// soul joined there, whose folder the owner has copied in Finder.
async function account(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'soul-fork-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'agent-comms'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_COMMS}" "$@"\n`);
  chmodSync(path.join(bin, 'agent-comms'), 0o755);
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    AGENT_BOT_STATE_HOME: path.join(root, 'identities'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_SOULS_HOME: path.join(root, 'souls'),
    AGENT_BOT_DAEMON_PREFERENCE: 'off',
    FAKE_COMMS_BROKER: path.join(root, 'broker.json'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GH_AGENT_APP: '',
  };
  for (const key of ['QWTS_AGENT_ID', 'AGENT_BOT_ID', 'AGENT_BOT_BINDING', 'AGENT_BOT_STARTER_TEMPLATE', 'AGENT_BOT_TOOL_PATH']) delete env[key];
  const template = path.join(root, 'Starter.soul');
  mkdirSync(template);
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Starter', description: 'Starter', displaySeed: 'starter',
    template: true, preferredHarnesses: ['claude'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(template, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(template, 'AGENTS.md'), 'Starter instructions\n');
  manifest.revision = computePackageRevision(template);
  writeFileSync(path.join(template, 'soul.json'), JSON.stringify(manifest));
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  const options = { env, home: root, config: {} };
  const bill = await joinSoul({ name: 'Bill', harness: 'claude', template, cwd: outside, ...options });
  // The soul's HOME holds its harness sign-ins: a copy must never carry them over.
  mkdirSync(path.join(bill.soulDir, '.soul-state', 'home'), { recursive: true });
  writeFileSync(path.join(bill.soulDir, '.soul-state', 'home', 'login.json'), '{"token":"bill"}\n');
  const copy = path.join(env.AGENT_BOT_SOULS_HOME, 'Bill - Starter copy.soul');
  cpSync(bill.soulDir, copy, { recursive: true, verbatimSymlinks: true });
  const gates = [];
  const left = [];
  const fork = (extra = {}) => forkSoul({ copy, name: 'Ted', ...options, now: () => new Date('2026-10-04T04:00:00.000Z'),
    gate: async (action) => { gates.push(action); return { method: 'test' }; },
    leave: async (soul) => { left.push(soul); return true; }, ...extra });
  return { root, env, options, bill, copy, gates, left, fork,
    broker: () => JSON.parse(readFileSync(env.FAKE_COMMS_BROKER, 'utf8')),
    snapshot: () => snapshot(bill.soulDir) };
}

function snapshot(dir) {
  const out = {};
  const walk = (at, prefix) => {
    for (const name of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${prefix}${name.name}`;
      if (name.isDirectory()) walk(path.join(at, name.name), `${rel}/`);
      else if (name.isFile()) out[rel] = readFileSync(path.join(at, name.name), 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

test('fork gives a Finder copy its own identity in place; the original is untouched', async (t) => {
  const a = await account(t);
  const file = a.env.AGENT_BOT_POPULATION_PATH;
  assert.equal(locateSoulDir(a.copy, { ...a.options, file }).status, 'copy');
  const before = a.snapshot();
  const originalIdentity = readAgentIdentity(a.bill.agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME });

  const result = await a.fork();

  assert.deepEqual(a.gates, [`soul fork ${a.bill.agentId} Ted`]);
  assert.notEqual(result.agentId, a.bill.agentId);
  assert.equal(result.forkedFrom, a.bill.agentId);
  assert.equal(result.soulDir, a.copy);
  assert.equal(result.harness, 'claude');
  assert.equal(result.address, `test/${result.agentId}`);
  // `soul locate` now calls the copy installed, as the new soul's own folder.
  const located = locateSoulDir(a.copy, { ...a.options, file });
  assert.equal(located.status, 'installed');
  assert.equal(located.agentId, result.agentId);
  assert.equal(located.name, 'Ted');
  assert.equal(readFileSync(path.join(a.copy, '.soul-state', 'agent-id'), 'utf8'), `${result.agentId}\n`);
  // Its own identity, genesis and package revision, with no GitHub App.
  const identity = readAgentIdentity(result.agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME });
  assert.equal(identity.status, 'active');
  assert.equal(identity.github ?? null, null);
  const manifest = JSON.parse(readFileSync(path.join(a.copy, 'soul.json'), 'utf8'));
  assert.equal(manifest.name, 'Ted - Starter');
  assert.equal(manifest.displaySeed, result.agentId);
  assert.equal(manifest.template, false);
  assert.equal(validateSoulPackage(a.copy).revision, manifest.revision);
  // In the census and agent-comms under its own name.
  const soul = showSoul(result.agentId, { file });
  assert.equal(soul.status, 'active');
  assert.equal(soul.displayName, 'Ted');
  assert.equal(soul.soulDir, a.copy);
  assert.equal(soul.lastSightedAt, undefined, 'a fork is not a sighting (#109)');
  assert.deepEqual(a.broker().joined[result.agentId], { name: 'Ted', harness: 'claude' });
  // The original's working state left the copy for the archive, sign-ins included.
  assert.equal(result.state, path.join(a.env.AGENT_BOT_SOULS_HOME, '.archive', '20261004T040000Z-Bill - Starter copy.soul-state'));
  assert.equal(readFileSync(path.join(result.state, '.soul-state', 'home', 'login.json'), 'utf8'), '{"token":"bill"}\n');
  assert.equal(existsSync(path.join(a.copy, '.soul-state', 'home', 'login.json')), false);
  // The original: same files, same identity, same census row and membership.
  assert.deepEqual(a.snapshot(), before);
  assert.deepEqual(readAgentIdentity(a.bill.agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME }), originalIdentity);
  assert.equal(showSoul(a.bill.agentId, { file }).status, 'active');
  assert.equal(locateSoulDir(a.bill.soulDir, { ...a.options, file }).status, 'installed');
  assert.deepEqual(a.broker().joined[a.bill.agentId], { name: 'Bill', harness: 'claude' });
  const receipts = readFileSync(auditFile({ env: a.env, home: a.root }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.filter(({ event }) => event === 'soul-fork').map(({ agentId, decision, detail }) => ({ agentId, decision, detail })),
    [{ agentId: result.agentId, decision: 'forked', detail: `from ${a.bill.agentId}` }]);
});

test('a failed agent-comms join rolls the fork back: left, retired, folder archived; the original untouched', async (t) => {
  const a = await account(t);
  const file = a.env.AGENT_BOT_POPULATION_PATH;
  const before = a.snapshot();
  const comms = async () => { throw new Error('agent-comms join failed: no broker'); };
  const error = await a.fork({ comms }).then(() => null, (failure) => failure);
  assert.match(error?.message ?? '', /no broker/);
  const forked = error.rollback.archived.find(({ from }) => from === a.copy);
  assert.ok(forked, 'the copy is archived');
  assert.equal(existsSync(a.copy), false);
  assert.equal(readFileSync(path.join(forked.to, 'AGENTS.md'), 'utf8'), 'Starter instructions\n');
  assert.equal(error.rollback.retired, true);
  assert.equal(a.left.length, 1);
  const retiredId = a.left[0].agentId;
  assert.notEqual(retiredId, a.bill.agentId);
  assert.equal(showSoul(retiredId, { file }).status, 'retired');
  assert.deepEqual(a.snapshot(), before);
  assert.equal(showSoul(a.bill.agentId, { file }).status, 'active');
  const receipts = readFileSync(auditFile({ env: a.env, home: a.root }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.filter(({ event }) => event === 'soul-fork').map(({ decision }) => decision), ['rolled-back']);
});

test('fork can set the fork\'s role in its manifest; a bad role is refused before anything changes (#535)', async (t) => {
  const f = await account(t);
  for (const role of ['', '  ', 'x'.repeat(61), 'a\nb', 7]) {
    await assert.rejects(f.fork({ role, gate: async () => assert.fail('asked') }), /--role must be 1 to 60 printable characters/);
  }
  const ted = await f.fork({ role: '  Researcher  ' });
  assert.equal(JSON.parse(readFileSync(path.join(ted.soulDir, 'soul.json'), 'utf8')).role, 'Researcher');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path.join(f.bill.soulDir, 'soul.json'), 'utf8')), 'role'), false);
});

test('fork refuses an installed soul, a package, or a refused owner, before changing anything', async (t) => {
  const a = await account(t);
  const file = a.env.AGENT_BOT_POPULATION_PATH;
  await assert.rejects(forkSoul({ copy: a.bill.soulDir, name: 'Ted', ...a.options, gate: async () => assert.fail('asked') }),
    (error) => error.code === 'soul-fork-installed');
  const pkg = path.join(a.root, 'Starter.soul');
  await assert.rejects(forkSoul({ copy: pkg, name: 'Ted', ...a.options, gate: async () => assert.fail('asked') }),
    (error) => error.code === 'soul-fork-package' && /soul spawn/.test(error.message));
  await assert.rejects(a.fork({ name: '' }), /--name/);
  const before = snapshot(a.copy);
  await assert.rejects(a.fork({ gate: async () => { throw new Error('owner approval was denied'); } }), /denied/);
  assert.deepEqual(snapshot(a.copy), before);
  assert.equal(locateSoulDir(a.copy, { ...a.options, file }).status, 'copy');
  assert.equal(existsSync(path.join(a.env.AGENT_BOT_SOULS_HOME, '.archive')), false);
});

test('soul fork parses its flags, the owner prompt names the change, and the CLI dispatches it', async (t) => {
  assert.deepEqual(parseForkArgs(['x.soul', '--name', 'Ted', '--json']),
    { json: true, principalStdin: false, name: 'Ted', copy: path.resolve('x.soul') });
  assert.equal(parseForkArgs(['x.soul', '--name', 'Ted', '--harness', 'codex', '--principal-stdin']).harness, 'codex');
  for (const bad of [[], ['x.soul'], ['x.soul', '--name'], ['a', 'b', '--name', 'T'], ['x.soul', '--name', 'T', '--bogus']]) {
    assert.throws(() => parseForkArgs(bad), /usage: agent-bot soul fork/);
  }
  const id = 'agent_66666666-6666-4666-8666-666666666666';
  assert.equal(ownerActionSummary(`soul fork ${id} Ted Two`, { souls: [{ id, name: 'bill', displayName: 'Bill' }] }),
    `make a copy of Bill (${id}) a new soul named Ted Two`);
  const a = await account(t);
  let out = '';
  try { execFileSync(process.execPath, [CLI, 'soul', 'fork', a.root, '--json'], { env: a.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { out = error.stderr; }
  assert.match(out, /usage: agent-bot soul fork/);
});

// #432: the daemon's package launch, wired as agent-daemon wires it. A copy
// of a soul's folder is forked into a new soul with agent-comms left to the
// launch; an installed folder relaunches its soul; a template spawns an
// instance. Nothing a launch does renames an existing soul or a template.
function launcher(a) {
  const file = a.env.AGENT_BOT_POPULATION_PATH;
  const stateDir = a.env.AGENT_BOT_STATE_HOME;
  const bound = new Map();
  const bindings = {
    findAgent: (agentId) => bound.get(agentId) ?? null,
    bind: ({ agentId, worktree, gitDir, harness }) => { bound.set(agentId, { agentId, worktree, gitDir, harness, file: path.join(gitDir, 'agent-binding.json') }); },
  };
  const homes = createSoulHomes({ ...a.options, stateDir, bindings, install: async () => {} });
  const joins = [];
  const reports = [];
  const handler = createLaunchHandler({ file: path.join(a.root, 'launch-requests.json'),
    identities: (agentId) => readAgentIdentity(agentId, { stateDir }),
    spawnPackage: ({ package: template, name, harness }) => spawnSoulTemplate(template, { ...a.options, name, harness, stateDir, file }),
    locatePackage: (pkg) => locateSoulDir(pkg, { ...a.options, file }),
    forkCopy: async ({ package: copy, name, harness, parent = null }) => {
      const forked = await forkSoul({ copy, name, harness, parentId: parent, ...a.options,
        now: () => new Date('2026-10-04T04:00:00.000Z'), gate: async () => ({ method: 'launch' }), join: null });
      return { id: forked.agentId, ...forked };
    },
    lookupBinding: () => null,
    provisionHome: (soul) => homes(soul),
    joinSoul: async (soul) => {
      joins.push(soul);
      if (soul.name) recordSoulDisplayName(soul.agentId, soul.name, { file });
    },
    executorFor: () => async ({ appendEvent }) => { appendEvent(HARNESS_SESSION_EVENT, {}); },
  });
  const launch = async (requestId, request) => {
    await handler({ requestId, account: 'worker', harness: 'claude', ...request }, { account: 'worker', report: async (row) => { reports.push(row); } });
    return reports.at(-1);
  };
  return { launch, joins, reports, file };
}

test('a package launch of a Finder copy makes it a new soul; the original keeps its folder, name and identity (#432)', async (t) => {
  const a = await account(t);
  const { launch, joins, file } = launcher(a);
  const before = a.snapshot();
  const originalIdentity = readAgentIdentity(a.bill.agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME });

  const row = await launch('copy', { package: a.copy, name: 'Ted' });

  assert.equal(row.status, 'launched', row.detail);
  assert.notEqual(row.agentId, a.bill.agentId);
  // Two souls now, the new one in the copy's folder, named by the launch.
  assert.deepEqual(listSouls({ status: 'active', file }).map((soul) => soul.id).sort(), [a.bill.agentId, row.agentId].sort());
  const ted = showSoul(row.agentId, { file });
  assert.equal(ted.displayName, 'Ted');
  assert.equal(ted.soulDir, a.copy);
  assert.equal(readFileSync(path.join(a.copy, '.soul-state', 'agent-id'), 'utf8'), `${row.agentId}\n`);
  assert.deepEqual([locateSoulDir(a.copy, { ...a.options, file }).status, locateSoulDir(a.copy, { ...a.options, file }).agentId], ['installed', row.agentId]);
  assert.equal(JSON.parse(readFileSync(path.join(a.copy, 'soul.json'), 'utf8')).name, 'Ted - Starter');
  // The launch joined and started it from a home inside its own folder.
  assert.equal(joins.length, 1);
  assert.deepEqual([joins[0].agentId, joins[0].name], [row.agentId, 'Ted']);
  assert.equal(joins[0].binding.worktree, path.join(a.copy, '.soul-state', 'home'));
  assert.equal(JSON.parse(readFileSync(path.join(joins[0].binding.worktree, 'soul.json'), 'utf8')).name, 'Ted - Starter');
  // The original: same files, identity, name, folder and agent-comms membership.
  assert.deepEqual(a.snapshot(), before);
  assert.deepEqual(readAgentIdentity(a.bill.agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME }), originalIdentity);
  const bill = showSoul(a.bill.agentId, { file });
  assert.deepEqual([bill.status, bill.displayName, bill.soulDir], ['active', 'Bill', a.bill.soulDir]);
  assert.deepEqual(a.broker().joined[a.bill.agentId], { name: 'Bill', harness: 'claude' });
  assert.equal(locateSoulDir(a.bill.soulDir, { ...a.options, file }).agentId, a.bill.agentId);
  const receipts = readFileSync(auditFile({ env: a.env, home: a.root }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.filter(({ event }) => event === 'soul-fork').map(({ agentId, decision }) => ({ agentId, decision })),
    [{ agentId: row.agentId, decision: 'forked' }]);
});

test('a package launch of an installed soul\'s own folder relaunches it under its own name (#432)', async (t) => {
  const a = await account(t);
  const { launch, joins, file } = launcher(a);
  const row = await launch('own', { package: a.bill.soulDir, name: 'Zed' });
  assert.deepEqual(row, { requestId: 'own', status: 'launched', agentId: a.bill.agentId });
  assert.equal(joins[0].name, null);
  assert.equal(showSoul(a.bill.agentId, { file }).displayName, 'Bill');
  assert.equal(listSouls({ status: 'active', file }).length, 1);
});

test('a package launch of a template spawns a named instance each time and never renames the template (#432)', async (t) => {
  const a = await account(t);
  const { launch, file } = launcher(a);
  const template = path.join(a.root, 'Starter.soul');
  const before = readFileSync(path.join(template, 'soul.json'), 'utf8');
  const ted = await launch('ted', { package: template, name: 'Ted' });
  const ann = await launch('ann', { package: template, name: 'Ann' });
  assert.equal(ted.status, 'launched', ted.detail);
  assert.equal(ann.status, 'launched', ann.detail);
  assert.equal(new Set([a.bill.agentId, ted.agentId, ann.agentId]).size, 3);
  assert.equal(readFileSync(path.join(template, 'soul.json'), 'utf8'), before);
  assert.deepEqual(listSouls({ status: 'active', file }).map((soul) => soul.displayName).sort(), ['Ann', 'Bill', 'Ted']);
  assert.equal(showSoul(a.bill.agentId, { file }).displayName, 'Bill');
});

test('a package launch of a copy without a name is refused before anything changes (#432)', async (t) => {
  const a = await account(t);
  const { launch, joins, file } = launcher(a);
  const before = snapshot(a.copy);
  const row = await launch('unnamed', { package: a.copy });
  assert.equal(row.status, 'failed');
  assert.match(row.detail, /is a copy of soul .*; name the launch to start it as a new soul/);
  assert.deepEqual(snapshot(a.copy), before);
  assert.equal(locateSoulDir(a.copy, { ...a.options, file }).status, 'copy');
  assert.equal(joins.length, 0);
  assert.equal(listSouls({ status: 'active', file }).length, 1);
  assert.equal(existsSync(path.join(a.env.AGENT_BOT_SOULS_HOME, '.archive')), false);
});
