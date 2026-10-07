import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertSoul, showSoul } from '../agent-population.mjs';
import { createDaemonServer, daemonClient } from '../agent-daemon.mjs';
import { auditFile } from '../agent-principals.mjs';
import {
  DEFAULT_SANDBOX_ACCOUNT, launchSandbox, probeSandboxAccount, readSandboxStatus, resolveSandbox, sandboxAccountStatus, sandboxCommand,
  sandboxLaunchProblem, sandboxPlan, setSandboxAccount, setSandboxEnabled, setSandboxOverride, validateSandboxAccount,
} from '../sandbox.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const OTHER = 'agent_12345678-1234-4234-8234-123456789def';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SENTINEL = 'NEVER-RETURN-THIS-SECRET';

function fixture(t, { config = null } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sandbox-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'),
    AGENT_BOT_CONFIG: path.join(home, 'config', 'config.json') };
  if (config) { mkdirSync(path.dirname(env.AGENT_BOT_CONFIG), { recursive: true }); writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify(config)); }
  const file = env.AGENT_BOT_POPULATION_PATH;
  upsertSoul({ id: ID, name: 'fixture-fern-11', displayName: 'Fixture', spacePath: path.join(home, 'space'), status: 'active', parentId: null, appSlug: null }, { file });
  return { home, env, file, options: { env, home } };
}

// A machine where the account exists, is standard, has a home, is paired and has a joined soul.
function machine(overrides = {}) {
  const facts = { exists: true, standard: true, home: '/Users/geniusbar-agent', devTools: true, paired: true, fleet: true, ...overrides };
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const argv = args.join(' ');
    if (file === '/usr/bin/id') { if (facts.exists) return '503\n'; throw Object.assign(new Error('no such user'), { status: 1 }); }
    if (file === '/usr/bin/dsmemberutil') return facts.standard ? 'user is not a member of the group\n' : 'user is a member of the group\n';
    if (file === '/usr/bin/dscl') return `NFSHomeDirectory: ${facts.home}\n`;
    if (file === '/usr/bin/xcode-select') { if (facts.devTools) return '/Library/Developer/CommandLineTools\n'; throw new Error('not installed'); }
    if (file === 'agent-comms' && argv === 'account pairings') {
      return JSON.stringify({ ok: true, pairings: [{ account: 'owner', uid: 501, state: 'approved', secret: SENTINEL },
        ...(facts.paired ? [{ account: 'geniusbar-agent', uid: 503, state: 'approved' }] : [{ account: 'geniusbar-agent', uid: 503, state: 'pending' }])] });
    }
    if (file === 'agent-comms' && argv === 'census') {
      return JSON.stringify({ ok: true, souls: facts.fleet ? [{ account: 'geniusbar-agent', agentId: OTHER, presence: 'joined' }] : [{ account: 'owner', agentId: OTHER, presence: 'joined' }] });
    }
    throw new Error(`unexpected command ${file} ${argv}`);
  };
  return { exec, calls, fileExists: (p) => p === facts.home };
}

test('status is missing, creating or ready from the probes, and unsupported off macOS', (t) => {
  const f = fixture(t);
  const ready = probeSandboxAccount('geniusbar-agent', { platform: 'darwin', ...machine() });
  assert.equal(sandboxAccountStatus(ready), 'ready');
  assert.deepEqual(ready, { supported: true, exists: true, standard: true, home: { path: '/Users/geniusbar-agent', exists: true }, devTools: true, paired: true, fleet: true, harnessSignIn: 'unknown' });
  assert.equal(sandboxAccountStatus(probeSandboxAccount('geniusbar-agent', { platform: 'darwin', ...machine({ exists: false }) })), 'missing');
  assert.equal(sandboxAccountStatus(probeSandboxAccount('geniusbar-agent', { platform: 'darwin', ...machine({ paired: false }) })), 'creating');
  assert.equal(sandboxAccountStatus(probeSandboxAccount('geniusbar-agent', { platform: 'darwin', ...machine({ standard: false }) })), 'creating');
  const linux = probeSandboxAccount('geniusbar-agent', { platform: 'linux', exec: () => { throw new Error('never'); } });
  assert.equal(sandboxAccountStatus(linux), 'unsupported');
  // A missing account never asks dsmemberutil or dscl about it.
  const missing = machine({ exists: false });
  probeSandboxAccount('geniusbar-agent', { platform: 'darwin', ...missing });
  assert.ok(!missing.calls.some(([file]) => file === '/usr/bin/dsmemberutil' || file === '/usr/bin/dscl'));
  void f;
});

test('the plan is the owner\'s steps with done flags, and never runs anything', () => {
  const steps = sandboxPlan({ account: 'geniusbar-agent', owner: 'owner', checks: probeSandboxAccount('geniusbar-agent', { platform: 'darwin', ...machine({ exists: false }) }) });
  assert.deepEqual(steps.map((step) => step.id), ['create-account', 'standard-account', 'dev-tools', 'broker-group', 'pair', 'harness-sign-in', 'join']);
  assert.equal(steps[0].done, false);
  assert.equal(steps[0].run, 'owner-admin');
  assert.match(steps[0].commands[0], /^sudo sysadminctl -addUser geniusbar-agent /);
  assert.equal(steps[2].done, true);
  assert.equal(steps[4].commands[0], 'agent-comms account pair --broker owner');
  assert.equal(steps[5].done, null);
  for (const step of steps) assert.ok(['owner-admin', 'owner', 'account'].includes(step.run));
});

test('the switch and account write the config atomically and validate the name', (t) => {
  const f = fixture(t, { config: { owner: 'someone', features: { 'github-identity': true } } });
  assert.deepEqual(setSandboxEnabled(true, f.options), { enabled: true, provider: 'standard_macos_account', account: DEFAULT_SANDBOX_ACCOUNT });
  const written = JSON.parse(readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8'));
  assert.deepEqual(written.features, { 'github-identity': true, 'persona-accounts': true });
  assert.equal(written.owner, 'someone');
  assert.equal(setSandboxAccount('bots', f.options).account, 'bots');
  assert.deepEqual(JSON.parse(readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8')).sandbox, { provider: 'standard_macos_account', account: 'bots' });
  assert.equal(setSandboxEnabled(false, f.options).enabled, false);
  assert.throws(() => setSandboxAccount('Bad Name', f.options), { code: 'invalid-account' });
  assert.throws(() => validateSandboxAccount('../etc'), { code: 'invalid-account' });
  assert.throws(() => setSandboxEnabled('yes', f.options), { code: 'usage' });
  // A config that does not exist yet is created private.
  const g = fixture(t);
  setSandboxEnabled(true, g.options);
  assert.equal(statSync(g.env.AGENT_BOT_CONFIG).mode & 0o777, 0o600);
});

test('a soul\'s override lives in the census and resolution follows it, else the switch', (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': true } } });
  const settings = { enabled: true, provider: 'standard_macos_account', account: 'geniusbar-agent' };
  const inherit = resolveSandbox(showSoul(ID, { file: f.file }), settings, { owner: 'owner' });
  assert.deepEqual(inherit, { agentId: ID, name: 'Fixture', override: 'inherit', sandboxed: true, runsAs: 'geniusbar-agent', source: 'global' });
  assert.equal(showSoul(ID, { file: f.file }).sandbox, undefined);
  const off = setSandboxOverride('Fixture', 'unrestricted', f.options);
  assert.equal(off.sandboxed, false);
  assert.equal(off.source, 'override');
  assert.equal(showSoul(ID, { file: f.file }).sandbox, 'unrestricted');
  assert.equal(resolveSandbox(showSoul(ID, { file: f.file }), { ...settings, enabled: false }, { owner: 'owner' }).runsAs, 'owner');
  assert.equal(resolveSandbox({ ...showSoul(ID, { file: f.file }), sandbox: 'sandboxed' }, { ...settings, enabled: false }, { owner: 'owner' }).runsAs, 'geniusbar-agent');
  setSandboxOverride(ID, 'inherit', f.options);
  assert.equal(showSoul(ID, { file: f.file }).sandbox, undefined);
  assert.throws(() => setSandboxOverride(ID, 'always', f.options), { code: 'usage' });
  assert.throws(() => setSandboxOverride(OTHER, 'sandboxed', f.options), /no population record/);
});

test('status, plan and resolve print secret-free JSON; writes go through the owner gate', async (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': false } } });
  const m = machine({ paired: false });
  const gated = [];
  const gate = async (action, { principal }) => { gated.push([action, principal]); return { method: 'principal', principal: 'principal_1' }; };
  let out = '';
  const write = (text) => { out += text; };
  const run = (argv, extra = {}) => { out = ''; return sandboxCommand(argv, { ...f.options, platform: 'darwin', exec: m.exec, owner: 'owner', gate, write, ...extra }); };
  const status = await run(['status', '--json']);
  assert.equal(status.status, 'creating');
  assert.equal(status.enabled, false);
  assert.equal(status.souls[0].runsAs, 'owner');
  assert.ok(!out.includes(SENTINEL));
  assert.deepEqual(JSON.parse(out).checks.paired, false);
  await run(['status']);
  assert.match(out, /^sandbox off \(standard_macos_account\)\naccount: geniusbar-agent creating\n/);
  const plan = await run(['plan', '--json']);
  assert.equal(plan.steps.find((step) => step.id === 'pair').done, false);
  assert.ok(!out.includes(SENTINEL));
  assert.equal(gated.length, 0);

  await run(['on', '--json']);
  assert.deepEqual(gated, [['sandbox on', null]]);
  assert.equal(JSON.parse(out).enabled, true);
  await run(['account', 'bots', '--principal-stdin', '--json'], { readStdin: () => JSON.stringify({ principal: 'principal_1', secret: SENTINEL }) });
  assert.equal(gated[1][0], 'sandbox account bots');
  assert.equal(gated[1][1].secret, SENTINEL);
  assert.ok(!out.includes(SENTINEL));
  await run(['override', 'Fixture', 'unrestricted', '--json']);
  assert.equal(gated[2][0], `sandbox override ${ID} unrestricted`);
  assert.deepEqual(JSON.parse(out), { agentId: ID, name: 'Fixture', override: 'unrestricted', sandboxed: false, runsAs: 'owner', source: 'override' });
  const resolved = await run(['resolve', ID, '--json']);
  assert.equal(resolved.runsAs, 'owner');
  await run(['override', ID, '--json']);
  assert.equal(JSON.parse(out).override, 'unrestricted');
  await assert.rejects(run(['account', 'Bad Name']), { code: 'invalid-account' });
  await assert.rejects(run(['status', '--principal-stdin']), /usage:/);
  await assert.rejects(run(['nonsense']), /usage:/);
  assert.equal(gated.length, 3);
});

test('the agent-bot CLI dispatches sandbox and reports failures with a code', (t) => {
  const f = fixture(t);
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'sandbox', ...args], {
    cwd: f.home, env: { ...f.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  const resolve = cli('resolve', 'Fixture', '--json');
  assert.equal(resolve.status, 0, resolve.stderr);
  assert.equal(JSON.parse(resolve.stdout).agentId, ID);
  const unknown = cli('resolve', 'nobody', '--json');
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'sandbox-failed');
  const usage = cli('bogus');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: agent-bot sandbox/);
});

test('daemon routes read status, set the switch and account through the setting gate, and record overrides', async (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': false } } });
  const gated = [];
  const server = createDaemonServer({ ...f.options, config: {}, token: 'sandbox-test-token-at-least-32-characters',
    settingGate: async (action, { principal }) => { gated.push([action, principal]); return { method: 'principal', principal: 'principal_1' }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer sandbox-test-token-at-least-32-characters', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/v0/sandbox`)).status, 401);
  const status = await fetch(`${base}/v0/sandbox`, { headers });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.enabled, false);
  assert.ok(['missing', 'creating', 'ready', 'unsupported'].includes(body.status));
  assert.equal(body.souls[0].agentId, ID);

  const set = await fetch(`${base}/v0/sandbox`, { method: 'POST', headers, body: JSON.stringify({ enabled: true, account: 'bots', principal: { principal: 'principal_1', secret: SENTINEL } }) });
  assert.equal(set.status, 200);
  const after = await set.json();
  assert.equal(after.enabled, true);
  assert.equal(after.account, 'bots');
  assert.ok(!JSON.stringify(after).includes(SENTINEL));
  assert.equal(gated[0][0], 'sandbox on, sandbox account bots');
  assert.equal((await fetch(`${base}/v0/sandbox`, { method: 'POST', headers, body: JSON.stringify({ enabled: 'yes' }) })).status, 400);
  assert.equal((await fetch(`${base}/v0/sandbox`, { method: 'POST', headers, body: JSON.stringify({ account: 'Bad Name' }) })).status, 400);
  assert.equal((await fetch(`${base}/v0/sandbox`, { method: 'POST', headers, body: JSON.stringify({}) })).status, 400);

  const override = await fetch(`${base}/v0/sandbox/override`, { method: 'POST', headers, body: JSON.stringify({ agentId: ID, override: 'unrestricted' }) });
  assert.equal(override.status, 200);
  assert.deepEqual(await override.json(), { schemaVersion: 1, agentId: ID, name: 'Fixture', override: 'unrestricted', sandboxed: false, runsAs: userInfo().username, source: 'override' });
  assert.equal(gated[1][0], `sandbox override ${ID} unrestricted`);
  assert.equal((await fetch(`${base}/v0/sandbox/override`, { method: 'POST', headers, body: JSON.stringify({ agentId: OTHER, override: 'sandboxed' }) })).status, 404);
  assert.equal((await fetch(`${base}/v0/sandbox/override`, { method: 'POST', headers, body: JSON.stringify({ agentId: ID, override: 'always' }) })).status, 400);

  writeFileSync(f.env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port: server.address().port,
    token: 'sandbox-test-token-at-least-32-characters', pid: process.pid, startedAt: new Date().toISOString() }));
  const client = daemonClient(f.options);
  assert.equal((await client.sandboxStatus()).souls[0].override, 'unrestricted');
  assert.equal((await client.setSandboxOverride({ agentId: ID, override: 'inherit' })).override, 'inherit');
  assert.equal((await client.setSandbox({ enabled: false })).enabled, false);
  const audit = readFileSync(auditFile(f.options), 'utf8');
  assert.match(audit, /"event":"sandbox"/);
  assert.ok(!audit.includes(SENTINEL));
});

test('launchSandbox resolves a soul for the daemon and probes only a sandboxed one (#376)', (t) => {
  const f = fixture(t);
  const m = machine({ exists: false });
  const options = { ...f.options, platform: 'darwin', exec: m.exec, fileExists: m.fileExists, owner: 'owner' };
  assert.deepEqual(launchSandbox(ID, options), { resolution: 'unrestricted', override: 'inherit', source: 'global', account: 'owner', self: 'owner' });
  assert.deepEqual(m.calls, [], 'an unrestricted launch runs no probe');
  // A soul this launch will make has no census row: the global switch decides.
  setSandboxEnabled(true, f.options);
  const fresh = launchSandbox(null, options);
  assert.equal(fresh.resolution, 'sandboxed');
  assert.equal(fresh.source, 'global');
  assert.equal(fresh.account, DEFAULT_SANDBOX_ACCOUNT);
  assert.equal(fresh.status, 'missing');
  assert.equal(fresh.steps[0].id, 'create-account');
  assert.equal(launchSandbox(OTHER, options).resolution, 'sandboxed', 'a soul missing from the census follows the switch');
  // An override wins over the switch either way.
  setSandboxOverride(ID, 'unrestricted', f.options);
  assert.equal(launchSandbox(ID, options).resolution, 'unrestricted');
  setSandboxEnabled(false, f.options);
  setSandboxOverride(ID, 'sandboxed', f.options);
  const forced = launchSandbox(ID, options);
  assert.deepEqual({ resolution: forced.resolution, source: forced.source, account: forced.account }, { resolution: 'sandboxed', source: 'override', account: DEFAULT_SANDBOX_ACCOUNT });
  assert.equal(sandboxLaunchProblem(forced).code, 'sandbox-not-ready');
  assert.doesNotMatch(JSON.stringify(forced), new RegExp(SENTINEL));
});

test('launchSandbox fails closed on an unreadable census rather than launching unrestricted (#376)', (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': false } } });
  writeFileSync(f.file, '{not json');
  assert.throws(() => launchSandbox(ID, { ...f.options, platform: 'darwin', ...machine() }), /population store/);
});

test('sandboxLaunchProblem lets a ready account run in its own daemon and fits the broker detail (#376)', () => {
  const long = 'a'.repeat(31);
  const plan = (checks) => sandboxPlan({ account: long, owner: 'owner', checks });
  const base = { resolution: 'sandboxed', account: long, self: long };
  const ready = { supported: true, exists: true, standard: true, home: { path: `/Users/${long}`, exists: true }, devTools: true, paired: true, fleet: true, harnessSignIn: 'unknown' };
  assert.equal(sandboxLaunchProblem(null), null);
  assert.equal(sandboxLaunchProblem({ resolution: 'unrestricted', account: 'owner', self: 'owner' }), null);
  assert.equal(sandboxLaunchProblem({ ...base, status: 'ready', steps: plan(ready) }), null);
  assert.equal(sandboxLaunchProblem({ ...base, self: 'owner', status: 'ready', steps: plan(ready) }).code, 'sandbox-other-account');
  const missing = { supported: true, exists: false, standard: null, home: null, devTools: false, paired: false, fleet: false, harnessSignIn: 'unknown' };
  const error = sandboxLaunchProblem({ ...base, status: 'missing', steps: plan(missing) });
  assert.equal(error.code, 'sandbox-not-ready');
  assert.ok(`sandbox-not-ready: ${error.message}`.length <= 512, 'the longest account name still fits the broker detail');
  assert.match(error.message, /Then: standard-account, dev-tools, broker-group, pair, harness-sign-in\./);
});
