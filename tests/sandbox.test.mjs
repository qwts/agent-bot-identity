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
import { stateDirectory } from '../agent-identity.mjs';
import { loadConfig } from '../config.mjs';
import {
  DEFAULT_SANDBOX_ACCOUNT, formatSandboxStatus, launchSandbox, loadPersona, parsePersonaMapping, probeSandboxAccount, readSandboxStatus, resolveSandbox,
  sandboxAccountStatus, sandboxCommand, sandboxLaunchProblem, sandboxPlan, setSandboxAccount, setSandboxEnabled, setSandboxOverride, turnSandboxProblem, validateSandboxAccount,
} from '../sandbox.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const OTHER = 'agent_12345678-1234-4234-8234-123456789def';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SENTINEL = 'NEVER-RETURN-THIS-SECRET';
// What every resolution carries with no SOP config at all.
const NO_SOP = { decides: false, state: 'none', message: 'No SOP is in effect.' };

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
  assert.deepEqual(JSON.parse(out), { agentId: ID, name: 'Fixture', override: 'unrestricted', sandboxed: false, runsAs: 'owner', source: 'override', sop: NO_SOP });
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
  assert.deepEqual(await override.json(), { schemaVersion: 1, agentId: ID, name: 'Fixture', override: 'unrestricted', sandboxed: false, runsAs: userInfo().username, source: 'override', sop: NO_SOP });
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
  assert.deepEqual(launchSandbox(ID, options), { resolution: 'unrestricted', override: 'inherit', source: 'global', account: 'owner', self: 'owner', sop: NO_SOP });
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

// --- the SOP pack's persona mapping (GeniusBar#66, ADR-0274 decision 3) ----
// The record `agent-bot sop persona` writes is placed directly: these tests
// never run git. The user's SOP config names the repositories the record is for.
const COMMIT = 'a'.repeat(40);
function pack(f, persona, { org = 'local/org', sop = 'local/sop', record = true } = {}) {
  const config = path.join(f.home, '.config', 'agent-sop', 'config.toml');
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, `schema_version = 1\n[repos]\norg = "${org}@main"\nsop = "${sop}@main"\n`);
  const file = path.join(stateDirectory(f.options), 'sop-persona.json');
  mkdirSync(path.dirname(file), { recursive: true });
  if (record === false) return file;
  const body = record === true ? { schemaVersion: 1, recordedAt: '2026-10-07T00:00:00.000Z', configPath: config,
    selection: { org: 'local/org@main', sop: 'local/sop@main' },
    org: { repository: 'local/org', commit: COMMIT }, sop: { repository: 'local/sop', commit: COMMIT }, persona } : record;
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}
const MAPPING = `schema_version = 1
[persona]
sandbox = "unrestricted"
account = "pack-agent"
[soul.fixture]
sandbox = "sandboxed"
account = "gb-fixture"
[role.auditor]
sandbox = "sandboxed"
`;

test('persona.toml parses the documented subset and refuses anything else', () => {
  const mapping = parsePersonaMapping(MAPPING);
  assert.deepEqual(mapping, { schemaVersion: 1, default: { sandbox: 'unrestricted', account: 'pack-agent' }, rules: [
    { match: 'soul', value: 'fixture', sandbox: 'sandboxed', account: 'gb-fixture' },
    { match: 'role', value: 'auditor', sandbox: 'sandboxed', account: null },
  ] });
  assert.deepEqual(parsePersonaMapping('schema_version = 1\n'), { schemaVersion: 1, default: { sandbox: null, account: null }, rules: [] });
  const invalid = (text, pattern) => assert.throws(() => parsePersonaMapping(text), (error) => error.code === 'persona-invalid' && pattern.test(error.message));
  invalid('schema_version = 2\n', /schema_version must be the integer 1/);
  invalid('schema_version = 1\n[team.x]\nsandbox = "sandboxed"\n', /unsupported table \[team\.x\]/);
  invalid('schema_version = 1\n[soul.x]\n', /needs sandbox/);
  invalid('schema_version = 1\n[soul.x]\nsandbox = "maybe"\n', /sandboxed or unrestricted/);
  invalid('schema_version = 1\n[soul.x]\nsandbox = "sandboxed"\naccount = "Bad Name"\n', /persona\.toml: \[soul\.x\] sandbox account must be a short macOS account name/);
  invalid('schema_version = 1\n[soul.x]\nsandbox = "sandboxed"\nshell = "zsh"\n', /unsupported key shell/);
  invalid('schema_version = 1\n[soul.x]\nsandbox = true\n', /booleans are not supported/);
  invalid('schema_version = 1\n[soul.a.b]\nsandbox = "sandboxed"\n', /unsupported table/);
});

test('a pack decision wins over the user override and the global switch, and an override on that soul is refused', async (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': true }, sandbox: { account: 'bots' } } });
  pack(f, MAPPING);
  // The switch is on and the override says unrestricted: the pack still sandboxes Fixture, as gb-fixture.
  writeFileSync(f.file, JSON.stringify({ ...JSON.parse(readFileSync(f.file, 'utf8')), souls: { [ID]: { ...JSON.parse(readFileSync(f.file, 'utf8')).souls[ID], sandbox: 'unrestricted' } } }));
  const persona = loadPersona(f.options);
  assert.equal(persona.state, 'ok');
  const fixtureSoul = resolveSandbox(showSoul(ID, { file: f.file }), { enabled: true, provider: 'standard_macos_account', account: 'bots' }, { owner: 'owner', persona });
  assert.deepEqual(fixtureSoul, { agentId: ID, name: 'Fixture', override: 'unrestricted', sandboxed: true, runsAs: 'gb-fixture', source: 'sop',
    sop: { decides: true, state: 'ok', repository: 'local/sop', commit: COMMIT, rule: 'soul:fixture', sandbox: 'sandboxed', account: 'gb-fixture' } });
  // The pack's default (unrestricted) beats the global switch for an unmatched soul; a sandboxed default would use the pack's account.
  upsertSoul({ id: OTHER, name: 'other-oak-22', displayName: 'Other', spacePath: path.join(f.home, 'space2'), status: 'active', parentId: null, appSlug: null, sandbox: 'sandboxed' }, { file: f.file });
  const other = resolveSandbox(showSoul(OTHER, { file: f.file }), { enabled: true, provider: 'standard_macos_account', account: 'bots' }, { owner: 'owner', persona });
  assert.equal(other.sandboxed, false);
  assert.equal(other.source, 'sop');
  assert.equal(other.sop.rule, 'default');
  // Overrides: refused for a pack-decided soul, naming the pack; inherit always clears.
  assert.throws(() => setSandboxOverride(ID, 'sandboxed', f.options), (error) => error.code === 'usage' && /local\/sop@a{40} \(soul:fixture\); change persona\.toml/.test(error.message));
  assert.equal(setSandboxOverride(ID, 'inherit', f.options).override, 'inherit');
  assert.equal(showSoul(ID, { file: f.file }).sandbox, undefined);
  // launchSandbox resolves the same way and probes the pack's account.
  const m = machine({ exists: false });
  const launched = launchSandbox(ID, { ...f.options, platform: 'darwin', exec: m.exec, fileExists: m.fileExists, owner: 'owner' });
  assert.equal(launched.resolution, 'sandboxed');
  assert.equal(launched.source, 'sop');
  assert.equal(launched.account, 'gb-fixture');
  assert.equal(launched.sop.rule, 'soul:fixture');
  assert.match(sandboxLaunchProblem(launched).message, /sandboxed as gb-fixture, which is missing/);
  assert.ok(m.calls.some(([file, , account]) => file === '/usr/bin/id' && account === 'gb-fixture'));
  // CLI: resolve names the source and rule; the override write is refused before the gate.
  const gated = [];
  let out = '';
  const run = (argv) => { out = ''; return sandboxCommand(argv, { ...f.options, platform: 'darwin', exec: m.exec, owner: 'owner', gate: async (action) => { gated.push(action); }, write: (text) => { out += text; } }); };
  await run(['resolve', 'Fixture']);
  assert.equal(out, `${ID} runs as gb-fixture (sandboxed, sop soul:fixture)\n`);
  await assert.rejects(run(['override', 'Fixture', 'unrestricted']), { code: 'usage' });
  assert.deepEqual(gated, []);
  await run(['override', 'Other', 'inherit', '--json']);
  assert.deepEqual(gated, [`sandbox override ${OTHER} inherit`]);
  assert.equal(JSON.parse(out).source, 'sop');
});

test('with the add-on gate off a pack decision to sandbox is reported and refuses the launch, never auto-enabling the gate (#613)', async (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': false } } });
  pack(f, MAPPING);
  const status = readSandboxStatus({ ...f.options, platform: 'darwin', ...machine(), owner: 'owner' });
  assert.equal(status.sop.state, 'ok');
  assert.equal(status.sop.decides, true);
  assert.deepEqual(status.sop.rules.map((rule) => `${rule.match}:${rule.value}`), ['soul:fixture', 'role:auditor']);
  assert.deepEqual(status.sop.default, { sandbox: 'unrestricted', account: 'pack-agent' });
  const [soul] = status.souls;
  assert.equal(soul.sandboxed, false);
  assert.equal(soul.runsAs, 'owner');
  assert.equal(soul.source, 'sop');
  assert.deepEqual(soul.sop, { decides: true, state: 'ok', repository: 'local/sop', commit: COMMIT, rule: 'soul:fixture', sandbox: 'sandboxed', account: 'gb-fixture' });
  assert.match(soul.reason, /features\.persona-accounts is off/);
  const text = formatSandboxStatus(status);
  assert.match(text, /^sandbox off \(standard_macos_account\)\naccount: geniusbar-agent ready\n  exists yes.*\nsop: persona mapping from local\/sop@a{40}: 2 rules, default unrestricted\n/);
  assert.match(text, new RegExp(`  ${ID} Fixture: inherit, runs as owner \\(sop soul:fixture\\)\n    the SOP decides sandboxed as gb-fixture`));
  assert.equal(soul.refused.code, 'persona-policy-requires-addon');
  const launched = launchSandbox(ID, { ...f.options, platform: 'darwin', exec: () => { throw new Error('no probe'); }, owner: 'owner' });
  assert.match(launched.reason, /persona-accounts is off.*launches are refused/);
  const refused = sandboxLaunchProblem(launched);
  assert.equal(refused.code, 'persona-policy-requires-addon');
  assert.match(refused.message, /\(local\/sop@a{12}\); the owner turns persona accounts on with `agent-bot sandbox on`/);
  assert.deepEqual(refused.source, { repository: 'local/sop', commit: COMMIT });
  assert.equal(loadConfig(f.options).features['persona-accounts'], false, 'the gate is never turned on');
});

test('no SOP or no persona.toml leaves the user setting; an unrecorded, stale, unreadable or invalid policy refuses the launch (#613)', (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': true } } });
  const options = { ...f.options, platform: 'darwin', ...machine(), owner: 'owner' };
  const status = (state, pattern) => {
    const read = readSandboxStatus(options);
    assert.equal(read.sop.state, state);
    assert.equal(read.sop.decides, false);
    assert.match(read.sop.message, pattern);
    assert.deepEqual(read.sop.rules, []);
    const [soul] = read.souls;
    assert.equal(soul.sop.state, state);
    return soul;
  };
  const falls = (state, pattern) => {
    const soul = status(state, pattern);
    assert.equal(soul.source, 'global');
    assert.equal(soul.sandboxed, true, 'the user setting applies');
    assert.equal(soul.refused, undefined);
    const launched = launchSandbox(ID, options);
    assert.equal(launched.resolution, 'sandboxed');
    assert.equal(launched.source, 'global');
    assert.equal(launched.sop.state, state);
    assert.equal(launched.refused, undefined);
  };
  const refuses = (state, pattern, code) => {
    const soul = status(state, pattern);
    assert.equal(soul.refused.code, code);
    assert.match(soul.reason, /launches are refused$/);
    let probed = false;
    const launched = launchSandbox(ID, { ...options, exec: () => { probed = true; throw new Error('no probe on a refusal'); } });
    assert.equal(probed, false, 'a refusal probes no account');
    const refused = sandboxLaunchProblem(launched);
    assert.equal(refused.code, code);
    assert.ok(refused.message.length <= 512);
    assert.match(refused.message, /agent-bot sop persona/);
    return refused;
  };
  pack(f, null, { record: false });
  refuses('unrecorded', /run `agent-bot sop persona`/, 'persona-policy-unavailable');
  pack(f, null);
  falls('absent', /has no persona\.toml/);
  pack(f, MAPPING, { org: 'elsewhere/org' });
  assert.deepEqual(refuses('stale', /is for org local\/org@main, not elsewhere\/org@main/, 'persona-policy-stale').source, { repository: 'local/sop', commit: COMMIT });
  pack(f, null, { record: '{not json' });
  refuses('error', /JSON/, 'persona-policy-unavailable');
  // A soul override set while the pack cannot decide does not launch it either.
  setSandboxOverride(ID, 'unrestricted', f.options);
  assert.equal(sandboxLaunchProblem(launchSandbox(ID, options)).code, 'persona-policy-unavailable');
  setSandboxOverride(ID, 'inherit', f.options);
  pack(f, null, { record: { schemaVersion: 1, extra: true } });
  refuses('error', /invalid SOP persona record/, 'persona-policy-unavailable');
  pack(f, 'schema_version = 1\n[soul.fixture]\nsandbox = "sandboxed"\naccount = "Not Valid!"\n');
  refuses('invalid', /persona\.toml: \[soul\.fixture\] sandbox account must be a short macOS account name.*launches are refused until the pack is fixed/, 'persona-policy-unavailable');
  writeFileSync(path.join(f.home, '.config', 'agent-sop', 'config.toml'), 'schema_version = true\n');
  refuses('error', /booleans are not supported/, 'persona-policy-unavailable');
});

test('a record is current only for the exact selection it was made from: ref, pin and config path (#613)', (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': true } } });
  const config = path.join(f.home, '.config', 'agent-sop', 'config.toml');
  const file = pack(f, MAPPING);
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const record = (fields) => writeFileSync(file, JSON.stringify({ ...body, ...fields }));
  const select = (text) => writeFileSync(config, `schema_version = 1\n[repos]\n${text}`);
  const state = () => loadPersona(f.options);
  assert.equal(state().state, 'ok');
  // Repository names compare without case; refs compare exactly.
  select('org = "Local/Org@main"\nsop = "local/sop@main"\n');
  assert.equal(state().state, 'ok');
  select('org = "local/org@release"\nsop = "local/sop@main"\n');
  assert.match(state().message, /is for org local\/org@main, not local\/org@release/);
  select('org = "local/org@main"\nsop = "local/sop@v2"\n');
  assert.equal(state().state, 'stale');
  // A selection routed by org.json (no repos.sop) is its own selection.
  select('org = "local/org@main"\n');
  assert.match(state().message, /is for sop local\/sop@main, not from org\.json/);
  record({ selection: { org: 'local/org@main', sop: null } });
  assert.equal(state().state, 'ok');
  // A 40-hex pin must be the recorded commit, offline: no git runs here.
  const other = 'b'.repeat(40);
  select(`org = "local/org@main"\nsop = "local/sop@${COMMIT}"\n`);
  record({ selection: { org: 'local/org@main', sop: `local/sop@${COMMIT}` } });
  assert.equal(state().state, 'ok', 'a valid selected pin launches offline');
  select(`org = "local/org@main"\nsop = "local/sop@${other}"\n`);
  record({ selection: { org: 'local/org@main', sop: `local/sop@${other}` } });
  assert.match(state().message, new RegExp(`is for sop commit ${COMMIT}, not the pinned ${other}`));
  // Another config file, and a record from before selections were kept.
  select('org = "local/org@main"\nsop = "local/sop@main"\n');
  record({ selection: { org: 'local/org@main', sop: 'local/sop@main' }, configPath: path.join(f.home, 'elsewhere.toml') });
  assert.match(state().message, /was recorded from .*elsewhere\.toml/);
  const { selection: _legacy, ...legacy } = body;
  writeFileSync(file, JSON.stringify(legacy));
  const stale = state();
  assert.equal(stale.state, 'stale');
  assert.match(stale.message, /recorded before agent-bot kept the selection.*run `agent-bot sop persona`/);
  // A malformed selection is an unreadable record, not a stale one.
  record({ selection: { org: 'no-ref', sop: null } });
  assert.equal(state().state, 'error');
  // The selection must name the repositories the record's commits are for.
  record({ selection: { org: 'other/org@main', sop: 'local/sop@main' } });
  select('org = "other/org@main"\nsop = "local/sop@main"\n');
  assert.equal(state().state, 'error', 'a record whose org is not the one its selection names is not current');
  record({ selection: { org: 'local/org@main', sop: 'other/sop@main' } });
  select('org = "local/org@main"\nsop = "other/sop@main"\n');
  assert.equal(state().state, 'error');
  select('org = "local/org@main"\nsop = "local/sop@main"\n');
  // Owner-verified, that very stale record's own mapping decides, never the user setting.
  writeFileSync(file, JSON.stringify(legacy));
  const { digest } = state();
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(loadPersona({ ...f.options, acceptStale: 'f'.repeat(64) }).state, 'stale', 'an approval of another record does not carry');
  const verified = loadPersona({ ...f.options, acceptStale: digest });
  assert.deepEqual([verified.state, verified.stale, verified.decides], ['ok', true, true]);
  const launched = launchSandbox(ID, { ...f.options, platform: 'darwin', ...machine(), owner: 'owner', acceptStale: digest });
  assert.deepEqual([launched.resolution, launched.account, launched.sop.rule, launched.sop.stale, launched.refused], ['sandboxed', 'gb-fixture', 'soul:fixture', true, undefined]);
  // The record changes while the owner is asked: the approval no longer matches it.
  writeFileSync(file, JSON.stringify({ ...legacy, persona: 'schema_version = 1\n[persona]\nsandbox = "unrestricted"\n' }));
  const changed = launchSandbox(ID, { ...f.options, platform: 'darwin', ...machine(), owner: 'owner', acceptStale: digest });
  assert.equal(changed.refused.code, 'persona-policy-stale');
  writeFileSync(file, JSON.stringify({ ...legacy, persona: null }));
  assert.equal(loadPersona({ ...f.options, acceptStale: state().digest }).state, 'absent');
});

test('every turn re-reads the persona policy: a record gone stale refuses the next turn unless the owner verified it (#613)', (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': true } } });
  const file = pack(f, 'schema_version = 1\n[persona]\nsandbox = "unrestricted"\n');
  const options = { ...f.options, owner: 'owner' };
  assert.equal(turnSandboxProblem(ID, options), null);
  const { selection: _legacy, ...legacy } = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(legacy));
  const refused = turnSandboxProblem(ID, options);
  assert.equal(refused.code, 'persona-policy-stale');
  assert.match(refused.message, /\(local\/sop@a{12}\); run `agent-bot sop persona`/);
  assert.equal(turnSandboxProblem(ID, { ...options, acceptStale: refused.digest }), null, 'a launch the owner verified runs its turn');
  // The pack now puts the soul in another account: this daemon's next turn is refused.
  pack(f, MAPPING);
  assert.equal(turnSandboxProblem(ID, options).code, 'sandbox-other-account');
  assert.equal(turnSandboxProblem(ID, { ...options, owner: 'gb-fixture' }), null, 'the account\'s own daemon runs it');
  pack(f, null, { record: '{not json' });
  assert.equal(turnSandboxProblem(ID, options).code, 'persona-policy-unavailable');
});

test('rules match by name before role, role from the soul\'s soul.json, and a new soul by its launch name and role', (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': true } } });
  const soulDir = path.join(f.home, 'souls', 'auditor.soul');
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify({ name: 'Audit Owl', role: 'Auditor' }));
  // No launch name: the soul.json name (Audit Owl) is what the name rule sees, before the census handle.
  upsertSoul({ id: OTHER, name: 'audit-owl-07', spacePath: path.join(f.home, 'space2'), status: 'active', parentId: null, appSlug: null, soulDir }, { file: f.file });
  pack(f, `schema_version = 1\n[persona]\naccount = "pack-agent"\n[soul.audit-owl]\nsandbox = "unrestricted"\n[role.auditor]\nsandbox = "sandboxed"\n[soul.fixture]\nsandbox = "sandboxed"\n`);
  const status = readSandboxStatus({ ...f.options, platform: 'darwin', ...machine(), owner: 'owner' });
  const by = Object.fromEntries(status.souls.map((soul) => [soul.agentId, soul]));
  assert.equal(by[OTHER].sop.rule, 'soul:audit-owl', 'the name rule wins over the role rule');
  assert.equal(by[OTHER].sandboxed, false);
  assert.equal(by[ID].sop.rule, 'soul:fixture');
  assert.equal(by[ID].runsAs, 'pack-agent', 'a rule without an account uses the pack default');
  // Drop the name rule: the role decides.
  pack(f, `schema_version = 1\n[role.auditor]\nsandbox = "sandboxed"\naccount = "gb-audit"\n`);
  const roled = resolveSandbox(showSoul(OTHER, { file: f.file }), { enabled: true, provider: 'standard_macos_account', account: 'bots' }, { owner: 'owner', persona: loadPersona(f.options) });
  assert.deepEqual([roled.source, roled.sop.rule, roled.runsAs], ['sop', 'role:auditor', 'gb-audit']);
  // A soul the launch makes has no census row: the launch's name and role match.
  const exec = () => { throw new Error('no probe for an unrestricted launch'); };
  const m = machine();
  const fresh = launchSandbox(null, { ...f.options, platform: 'darwin', exec: m.exec, fileExists: m.fileExists, owner: 'owner', name: 'New Helper', role: 'Auditor' });
  assert.deepEqual([fresh.resolution, fresh.source, fresh.sop.rule, fresh.account], ['sandboxed', 'sop', 'role:auditor', 'gb-audit']);
  const unmatched = launchSandbox(null, { ...f.options, platform: 'darwin', exec, owner: 'owner', name: 'New Helper' });
  assert.deepEqual([unmatched.resolution, unmatched.source, unmatched.sop.decides], ['sandboxed', 'global', false]);
  setSandboxEnabled(false, f.options);
  assert.equal(launchSandbox(null, { ...f.options, platform: 'darwin', exec, owner: 'owner', name: 'New Helper' }).resolution, 'unrestricted');
});

test('status --json and the daemon routes carry the pack decision, and the override route refuses a pack-decided soul', async (t) => {
  const f = fixture(t, { config: { features: { 'persona-accounts': true } } });
  pack(f, MAPPING);
  let out = '';
  const status = await sandboxCommand(['status', '--json'], { ...f.options, platform: 'darwin', ...machine(), owner: 'owner', write: (text) => { out += text; } });
  const printed = JSON.parse(out);
  assert.equal(printed.sop.state, 'ok');
  assert.equal(printed.sop.commit, COMMIT);
  assert.equal(printed.sop.recordedAt, '2026-10-07T00:00:00.000Z');
  assert.equal(printed.souls[0].source, 'sop');
  assert.equal(printed.souls[0].runsAs, 'gb-fixture');
  assert.equal(status.souls[0].sop.rule, 'soul:fixture');
  assert.ok(!out.includes(SENTINEL));

  const server = createDaemonServer({ ...f.options, config: {}, token: 'sandbox-test-token-at-least-32-characters',
    settingGate: async () => ({ method: 'principal', principal: 'principal_1' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer sandbox-test-token-at-least-32-characters', 'content-type': 'application/json' };
  const body = await (await fetch(`${base}/v0/sandbox`, { headers })).json();
  assert.equal(body.schemaVersion, 1);
  assert.deepEqual({ state: body.sop.state, decides: body.sop.decides, repository: body.sop.repository, rules: body.sop.rules.length }, { state: 'ok', decides: true, repository: 'local/sop', rules: 2 });
  assert.deepEqual(body.souls[0].sop, { decides: true, state: 'ok', repository: 'local/sop', commit: COMMIT, rule: 'soul:fixture', sandbox: 'sandboxed', account: 'gb-fixture' });
  const refused = await fetch(`${base}/v0/sandbox/override`, { method: 'POST', headers, body: JSON.stringify({ agentId: ID, override: 'unrestricted' }) });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /local\/sop@/);
  assert.equal(showSoul(ID, { file: f.file }).sandbox, undefined);
  const cleared = await fetch(`${base}/v0/sandbox/override`, { method: 'POST', headers, body: JSON.stringify({ agentId: ID, override: 'inherit' }) });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).source, 'sop');
});
