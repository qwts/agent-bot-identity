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
import { locateSoulDir, showSoul } from '../agent-population.mjs';
import { ownerActionSummary } from '../owner-gate.mjs';
import { forkSoul, parseForkArgs } from '../soul-fork.mjs';
import { joinSoul } from '../soul-join.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';

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
