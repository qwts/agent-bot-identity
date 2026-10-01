import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isGateEnabled } from '../config.mjs';
import {
  mintAgentIdentity,
  readAgentIdentity,
  stateDirectory,
  validateIdentity,
} from '../agent-identity.mjs';
import { displayName, listSouls, upsertIdentitySoul, upsertSoul } from '../agent-population.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { acpExecutorFor, createWakePlane } from '../wake-plane.mjs';
import { buildGhShim } from '../gh-shim.mjs';
import { collectReadiness } from '../readiness.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IDENTITY_CLI = path.join(ROOT, 'agent-identity.mjs');
const SETUP_CLI = path.join(ROOT, 'setup-worktree.mjs');
const TOKEN_CLI = path.join(ROOT, 'worktree-token.mjs');
const ENSURE_SCRIPT = path.join(ROOT, 'scripts', 'ensure-identity.sh');
const SOURCE_ENTRY = fileURLToPath(new URL('../agent-bot', import.meta.url));

const DROP = new Set([
  'GH_AGENT_APP',
  'AGENT_BOT_CONFIG',
  'AGENT_BOT_DAEMON_PREFERENCE',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CURSOR_CONVERSATION_ID',
  'AGENT_BOT_TRANSCRIPT_ID',
  'QWTS_AGENT_TRANSCRIPT_ID',
  'AGENT_BOT_TRANSCRIPT_PROVIDER',
  'QWTS_AGENT_TRANSCRIPT_PROVIDER',
  'AGENT_BOT_ID',
  'QWTS_AGENT_ID',
  'AGENT_BOT_PARENT_ID',
  'QWTS_AGENT_PARENT_ID',
  'AGENT_BOT_TEAM',
  'QWTS_AGENT_TEAM',
  'AGENT_BOT_SQUAD',
  'QWTS_AGENT_SQUAD',
  'AGENT_BOT_BINDING',
  'AGENT_BOT_HOME',
  'PLAYBOOK_HOME',
]);

function scratch(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'github-identity-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function isolatedEnv(root, overrides = {}) {
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const gitconfig = path.join(root, 'gitconfig');
  if (!existsSync(gitconfig)) writeFileSync(gitconfig, '');
  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!DROP.has(key)) base[key] = value;
  }
  const features = overrides.features;
  delete overrides.features;
  const configDir = path.join(home, '.config', 'agent-bot');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(features ? { features } : {}));
  return hermeticGitEnv(base, {
    HOME: home,
    USER: 'gate-test',
    LOGNAME: 'gate-test',
    XDG_STATE_HOME: path.join(root, 'xdg'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    AGENT_BOT_STATE_HOME: path.join(root, 'identities'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...overrides,
  });
}

function initRepo(root, env) {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  return repo;
}

function git(repo, env, args) {
  return spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
}

function runNode(script, args, { cwd, env }) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
}

test('github-identity is config-only and defaults off', (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root);
  assert.equal(isGateEnabled('github-identity', { env, home: env.HOME }), false);
  assert.equal(isGateEnabled('persona-accounts', { env, home: env.HOME }), false);
  writeFileSync(path.join(env.HOME, '.config', 'agent-bot', 'config.json'), JSON.stringify({ features: { 'github-identity': true } }));
  assert.equal(isGateEnabled('github-identity', { env, home: env.HOME }), true);
});

test('an identity may omit github, and a present github stays credential-free', (t) => {
  const stateDir = path.join(scratch(t), 'identities');
  const plain = mintAgentIdentity({ useGithub: false, harness: 'codex', stateDir, env: {} });
  assert.equal(Object.hasOwn(plain, 'github'), false);
  assert.deepEqual(validateIdentity(plain), []);
  assert.equal(plain.team, null);

  const kept = mintAgentIdentity({
    useGithub: true,
    appSlug: 'you-codex-agent',
    botUid: '308462948',
    harness: 'codex',
    stateDir,
    env: {},
    idFactory: () => 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(kept.github.appSlug, 'you-codex-agent');
  assert.equal(kept.github.actor, 'you-codex-agent[bot]');
  assert.equal(kept.github.credentialProvider, 'worktree-token');
  assert.equal('token' in kept.github, false);
  assert.equal('privateKey' in kept.github, false);

  assert.ok(validateIdentity({ ...plain, github: null }).some((error) => /github must be an object/.test(error)));
  assert.ok(validateIdentity({ ...plain, github: {} }).some((error) => /appSlug/.test(error)));
  assert.ok(validateIdentity({
    ...plain,
    github: { appSlug: 'you-codex-agent', credentialProvider: 'worktree-token', token: 'secret' },
  }).some((error) => /credentials/.test(error)));
  assert.throws(
    () => mintAgentIdentity({ useGithub: true, stateDir, env: {}, idFactory: () => 'agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    /appSlug is required/,
  );
});

test('identity ensure with the gate off pins a soul and writes no github field', (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root);
  const repo = initRepo(root, env);
  const ensured = runNode(IDENTITY_CLI, ['ensure', '--json', '--harness', 'codex'], { cwd: repo, env });
  assert.equal(ensured.status, 0, ensured.stderr);
  const record = JSON.parse(ensured.stdout);
  assert.equal(Object.hasOwn(record, 'github'), false);
  assert.match(record.id, /^agent_[0-9a-f-]{36}$/);
  assert.equal(git(repo, env, ['config', '--worktree', '--get', 'agentBot.agentId']).stdout.trim(), record.id);
  assert.equal(Object.hasOwn(readAgentIdentity(record.id, { stateDir: stateDirectory({ env }) }), 'github'), false);
});

test('identity ensure with the gate on and no App still fails closed', (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root, { features: { 'github-identity': true } });
  const repo = initRepo(root, env);
  const ensured = runNode(IDENTITY_CLI, ['ensure', '--json'], { cwd: repo, env });
  assert.notEqual(ensured.status, 0);
  assert.match(ensured.stderr, /no GitHub App identity resolves in this context/);
});

test('identity spawn with the gate off and no App mints a soul', (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root);
  const repo = initRepo(root, env);
  const spawned = runNode(IDENTITY_CLI, ['spawn', '--json', '--harness', 'codex'], { cwd: repo, env });
  assert.equal(spawned.status, 0, spawned.stderr);
  const record = JSON.parse(spawned.stdout);
  assert.equal(Object.hasOwn(record, 'github'), false);
  assert.equal(record.harness, 'codex');
});

test('setup-worktree with the gate off binds a soul and leaves git identity to the user', (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root);
  const repo = initRepo(root, env);
  const setup = runNode(SETUP_CLI, [], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /worktree configured as agent_/);
  assert.doesNotMatch(setup.stdout, /\[bot\]/);
  const id = git(repo, env, ['config', '--worktree', '--get', 'agentBot.agentId']).stdout.trim();
  assert.match(id, /^agent_/);
  assert.notEqual(git(repo, env, ['config', '--worktree', '--get', 'user.name']).status, 0);
  assert.notEqual(git(repo, env, ['config', '--worktree', '--get', 'agentBot.app']).status, 0);
  const identity = readAgentIdentity(id, { stateDir: stateDirectory({ env }) });
  assert.equal(Object.hasOwn(identity, 'github'), false);
  assert.equal(listSouls({ file: env.AGENT_BOT_POPULATION_PATH }).find((soul) => soul.id === id).appSlug, null);
  const gitDir = git(repo, env, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  assert.equal(existsSync(path.join(gitDir, 'agent-bind-token.json')), true);
});

test('setup-worktree with the gate on and no App still leaves the checkout alone', (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root, { features: { 'github-identity': true } });
  const repo = initRepo(root, env);
  const setup = runNode(SETUP_CLI, [], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(git(repo, env, ['config', '--worktree', '--get', 'agentBot.agentId']).status, 1);
});

test('the census accepts a soul with no App and still rejects a bad slug', (t) => {
  const root = scratch(t);
  const stateDir = path.join(root, 'identities');
  const file = path.join(root, 'population.json');
  const identity = mintAgentIdentity({ useGithub: false, harness: 'codex', stateDir, env: {} });
  const soul = upsertIdentitySoul(identity.id, path.join(root, 'space'), {
    file,
    stateDir,
    worktree: path.join(root, 'worktree'),
  });
  assert.equal(soul.appSlug, null);
  assert.equal(listSouls({ file })[0].appSlug, null);
  assert.throws(() => upsertSoul({ ...soul, appSlug: '' }, { file: path.join(root, 'other.json') }), /appSlug/);
  assert.throws(
    () => upsertSoul({ ...soul, appSlug: 'not a slug' }, { file: path.join(root, 'bad.json') }),
    /appSlug must be a GitHub App slug/,
  );
});

function doctorOptions(home) {
  return {
    command: 'doctor',
    scope: 'machine',
    home,
    env: { HOME: home },
    cwd: home,
    git: (args) => {
      if (args[0] === '--version') return 'git version 2.50.1';
      throw Object.assign(new Error('unexpected git call'), { status: 1 });
    },
    lstat: () => ({ isSymbolicLink: () => true }),
    readlink: () => SOURCE_ENTRY,
    access: () => {},
    exists: () => false,
    spawn: () => ({ status: 0, stdout: '' }),
    load: () => ({ apps: { claude: 'org-claude-agent', codex: 'org-codex-agent' } }),
    inspectShellGh: () => ({ status: 'missing', code: 'gh-shim-missing', evidence: {} }),
    inspectDaemonSupervisor: () => ({ supported: true, applied: true, loaded: true, platform: 'darwin', kind: 'launchd' }),
    probeDaemon: async () => ({ running: true }),
    verifyApps: false,
    appResults: { results: [] },
    probeSecretStore: () => [],
    listHarnessMcpServers: () => [],
  };
}

test('doctor counts checkouts that have no GitHub App and does not throw', async (t) => {
  const home = scratch(t);
  const id = 'agent_11111111-1111-4111-8111-111111111111';
  const census = path.join(home, '.local', 'state', 'agent-bot', 'population.json');
  mkdirSync(path.dirname(census), { recursive: true });
  writeFileSync(census, `${JSON.stringify({
    schemaVersion: 1,
    souls: {
      [id]: {
        id,
        name: displayName(id),
        appSlug: null,
        parentId: null,
        status: 'active',
        spacePath: path.join(home, '.agent-space', id),
        worktree: path.join(home, 'checkout'),
        transcriptLocator: null,
        lastSeen: '2026-08-16T00:00:00.000Z',
      },
    },
  }, null, 2)}\n`);
  const report = await collectReadiness(doctorOptions(home));
  const check = report.machine.checks.find((entry) => entry.id === 'worktree.binding_summary');
  assert.equal(check.status, 'ready');
  assert.equal(check.evidence.without_app, check.evidence.checkouts);
  assert.deepEqual(check.evidence.by_app, {});
  assert.match(check.message, /have no GitHub App/);
});

test('an empty census summary does not invent a without_app count', async (t) => {
  const report = await collectReadiness(doctorOptions(scratch(t)));
  const check = report.machine.checks.find((entry) => entry.id === 'worktree.binding_summary');
  assert.equal(check.status, 'not_applicable');
  assert.equal(Object.hasOwn(check.evidence, 'without_app'), false);
});

test('the gh shim has no environment gate and installer skips when config gate is off', async (t) => {
  assert.doesNotMatch(buildGhShim(), /AGENT_BOT_FEATURE_GATE/);
  const root = scratch(t);
  const shim = path.join(root, 'gh');
  writeFileSync(shim, buildGhShim());
  chmodSync(shim, 0o755);
  const { installGhShim } = await import('../install-gh-shim.mjs');
  assert.deepEqual(installGhShim({ home: root, env: isolatedEnv(root) }), { skipped: true, reason: 'github-identity is off' });

  const token = spawnSync(process.execPath, [TOKEN_CLI, '--slug'], {
    encoding: 'utf8',
    env: isolatedEnv(root),
  });
  assert.equal(token.status, 1);
  assert.match(token.stderr, /github-identity is off — refusing GitHub credentials/);
});

test('ensure-identity accepts a pinned soul that has no App', (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root);
  const repo = initRepo(root, env);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const stub = path.join(bin, 'agent-bot');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const id = 'agent_12121212-1212-4212-8212-121212121212';
  execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: repo, env });
  execFileSync('git', ['config', '--worktree', 'agentBot.agentId', id], { cwd: repo, env });
  const result = spawnSync(ENSURE_SCRIPT, [], {
    cwd: repo,
    env: { ...env, PATH: `${bin}:${env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`==> agent identity: ${id} \\(no GitHub App\\)`));
  assert.equal(git(repo, env, ['config', '--worktree', '--get', 'agentBot.app']).status, 1);
});

test('with github-identity off, bind, spawn, comms join, vouch, and wake need no App', async (t) => {
  const root = scratch(t);
  const env = isolatedEnv(root);
  const repo = initRepo(root, env);
  const setup = runNode(SETUP_CLI, [], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const agentId = git(repo, env, ['config', '--worktree', '--get', 'agentBot.agentId']).stdout.trim();
  const stateDir = stateDirectory({ env });
  assert.equal(Object.hasOwn(readAgentIdentity(agentId, { stateDir }), 'github'), false);
  assert.equal(listSouls({ file: env.AGENT_BOT_POPULATION_PATH }).find((soul) => soul.id === agentId).appSlug, null);
  const gitDir = git(repo, env, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const token = JSON.parse(readFileSync(path.join(gitDir, 'agent-bind-token.json'), 'utf8'));

  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const joinLog = path.join(root, 'join.json');
  writeFileSync(
    path.join(bin, 'agent-comms'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(joinLog)}, JSON.stringify({ argv: process.argv.slice(2), id: process.env.QWTS_AGENT_ID, binding: process.env.AGENT_BOT_BINDING }));\n`,
    { mode: 0o755 },
  );
  env.PATH = `${bin}:${env.PATH}`;

  const server = createDaemonServer({ env, home: env.HOME, config: {} });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const port = server.address().port;
  const call = (pathname, { method = 'GET', body, token: bearer = server.token, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const boundResponse = await call('/v0/bind', {
    method: 'POST',
    body: { gitDir, token: token.token, transcript: { provider: 'custom', id: 'thread-plain' } },
  });
  assert.equal(boundResponse.status, 200, await boundResponse.clone().text());
  const bound = await boundResponse.json();
  assert.equal(bound.agentId, agentId);
  assert.equal(bound.soul.appSlug, null);
  const boundIdentity = readAgentIdentity(agentId, { stateDir });
  assert.equal(Object.hasOwn(boundIdentity, 'github'), false);
  assert.equal(boundIdentity.transcript.id, 'thread-plain');

  const spawnedResponse = await call('/v0/spawn', {
    method: 'POST',
    headers: { 'x-agent-binding': bound.secret },
    body: { name: 'worker', harness: 'codex' },
  });
  assert.equal(spawnedResponse.status, 200, await spawnedResponse.clone().text());
  const spawned = await spawnedResponse.json();
  assert.equal(spawned.parent, agentId);
  assert.equal(spawned.warning, undefined);
  assert.equal(Object.hasOwn(readAgentIdentity(spawned.agentId, { stateDir }), 'github'), false);
  assert.deepEqual(JSON.parse(readFileSync(joinLog, 'utf8')).argv, ['join', '--name', 'worker', '--harness', 'codex']);

  const vouchedResponse = await call('/v0/vouch', {
    method: 'POST',
    token: null,
    headers: { 'x-agent-binding': bound.secret },
    body: { aud: 'agent-comms' },
  });
  assert.equal(vouchedResponse.status, 200, await vouchedResponse.clone().text());
  assert.equal((await vouchedResponse.json()).agentId, agentId);

  const credential = await call('/v0/credential', {
    method: 'POST',
    headers: { 'x-agent-binding': bound.secret },
    body: {},
  });
  assert.equal(credential.status, 409);
  assert.match((await credential.json()).error, /no GitHub App/);

  const frames = [];
  server.warmPool.add(agentId, {
    writable: true,
    destroyed: false,
    write(value) { frames.push(value); },
  });
  const reports = [];
  const onWake = createWakePlane({
    pool: server.warmPool,
    settings: {},
    lookupSoul: (id) => server.bindings.findAgent(id),
    identities: (id) => readAgentIdentity(id, { stateDir }),
    receipt: () => {},
  });
  await onWake(
    { event: 'wake', agentId, count: 1, cursor: 1, messageIds: ['m1'] },
    { report: async (fields) => reports.push(fields) },
  );
  assert.equal(reports[0].outcome, 'warm');
  assert.equal(frames.length, 1);

  const factory = acpExecutorFor({
    identities: (id) => readAgentIdentity(id, { stateDir }),
    policy: { version: 1, rules: [], fallback: 'deny' },
    baseEnv: env,
  });
  assert.throws(
    () => factory({ agentId, harness: 'codex', cwd: repo, env: {} }),
    /no github identity/,
  );
});
