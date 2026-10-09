// ADR-0274 journey evidence. Only the harness and broker are local scripted
// fixtures; identity, bind, authenticated chat, ACP execution and wake are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonServer } from '../agent-daemon.mjs';
import { readAgentIdentity } from '../agent-identity.mjs';
import { authorizeSouls, bindTransport, enrollPrincipal, setOperations } from '../agent-principals.mjs';
import { getInvocation, readEvents } from '../agent-jobs.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { acpExecutorFor, coldTurnExecutor } from '../wake-plane.mjs';
import { createColdWaker } from '../cold-wake.mjs';
import { gateStatus, loadConfig } from '../config.mjs';
import { joinSoul } from '../soul-join.mjs';
import { installSoulHarnesses } from '../soul-home.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { createRunGit, recordSopPersona, resolveSop } from '../sop.mjs';
import { organizationProfileToConfig, RUNTIME_PROFILE_INTERFACE_VERSION } from '../organization-profile.mjs';
import { loadPersona, resolveSandbox } from '../sandbox.mjs';

const FAKE_COMMS = fileURLToPath(new URL('./fixtures/fake-agent-comms.mjs', import.meta.url));
const FAKE_ACP = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

function account(t) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'product-policy-')));
  const originalEnv = process.env;
  t.after(() => { process.env = originalEnv; rmSync(home, { recursive: true, force: true }); });
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'agent-comms'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_COMMS}" "$@"\n`, { mode: 0o755 });
  // Explicit allowlist: no inherited bot binding, GitHub credential, SOP
  // selection, add-on switch or harness marker can make this journey pass.
  const env = {
    USER: 'fixture-owner', AGENT_BOT_ACCOUNT: 'fixture-owner',
    HOME: home, PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_STATE_HOME: path.join(home, 'identities'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_DAEMON_PREFERENCE: 'off', FAKE_COMMS_BROKER: path.join(home, 'broker.json'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  // Shared readers can invoke git without an explicit env argument too.
  process.env = { ...env, ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}) };
  return { home, env };
}

function template(home) {
  const root = path.join(home, 'Starter.soul');
  mkdirSync(root);
  const manifest = { formatVersion: 2, name: 'Starter', description: 'Fixture', displaySeed: 'starter',
    preferredHarnesses: ['claude'], template: true, ignore: PACKAGE_IGNORE_LIST, parentRevision: null, revision: `sha256:${'0'.repeat(64)}` };
  writeFileSync(path.join(root, 'AGENTS.md'), 'Fixture instructions\n');
  writeFileSync(path.join(root, 'soul.json'), JSON.stringify(manifest));
  const dependencies = { '@zed-industries/claude-code-acp': '0.16.2' };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, dependencies }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3,
    packages: { '': { dependencies }, 'node_modules/@zed-industries/claude-code-acp': { version: '0.16.2' } } }));
  manifest.revision = computePackageRevision(root);
  writeFileSync(path.join(root, 'soul.json'), JSON.stringify(manifest));
  return root;
}

// A secret-free local repository stands for the selected qwts org and SOP.
// These are fixture policy choices, not a downloaded copy of the live roster.
function selectedPack(a, enabled) {
  const repo = path.join(a.home, 'policy');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
    { env: a.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  const profile = { schema_version: 1, organization: 'qwts', account_owner: 'qwts',
    minimum_runtime_interface_version: RUNTIME_PROFILE_INTERFACE_VERSION,
    defaults: { claude: 'qwts-claude-agent', codex: 'qwts-codex-agent' },
    identities: ['claude', 'codex'].map(harness => ({ slug: `qwts-${harness}-agent`, harness, status: 'active' })) };
  writeFileSync(path.join(repo, 'profile.json'), JSON.stringify(profile));
  writeFileSync(path.join(repo, 'guide.md'), 'Fixture policy reference.\n');
  writeFileSync(path.join(repo, 'persona.toml'), 'schema_version = 1\n[persona]\nsandbox = "unrestricted"\n[role.reviewer]\nsandbox = "sandboxed"\naccount = "qwts-reviewer"\n');
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'); return git('rev-parse', 'HEAD'); };
  const sopCommit = commit();
  writeFileSync(path.join(repo, 'org.json'), JSON.stringify({ schema_version: 1,
    organization: { id: 'qwts', account: 'qwts', profile: 'profile.json' },
    sources: { sop: { repo: 'qwts/qwts-agent-sop', ref: sopCommit, entry: 'guide.md', summary: 'Fixture SOP' } }, capabilities: {} }));
  const orgCommit = commit();
  const configDir = path.join(a.home, '.config');
  mkdirSync(path.join(configDir, 'agent-sop'), { recursive: true });
  writeFileSync(path.join(configDir, 'agent-sop', 'config.toml'), `schema_version = 1\n[repos]\norg = "qwts/qwts-agent-org@${orgCommit}"\n`);
  const options = { ...a, cwd: a.home, currentAgentId: () => null, readBinding: () => null,
    remoteUrl: repository => { assert.ok(['qwts/qwts-agent-org', 'qwts/qwts-agent-sop'].includes(repository)); return repo; },
    runGit: createRunGit({ allowProtocols: 'file' }) };
  const selected = resolveSop(options);
  assert.deepEqual([selected.repositories.sop.selected, selected.repositories.sop.commit], ['org.json', sopCommit]);
  // Profile projection is the bootstrap seam; selecting an SOP does not
  // implicitly install its profile or enable a capability.
  const config = organizationProfileToConfig(JSON.parse(git('show', `${orgCommit}:profile.json`)));
  assert.ok(Object.values(gateStatus(config)).every(gate => !gate.enabled));
  if (enabled) config.features = { 'github-identity': true, 'persona-accounts': true };
  mkdirSync(path.join(configDir, 'agent-bot'), { recursive: true });
  writeFileSync(path.join(configDir, 'agent-bot', 'config.json'), JSON.stringify(config));
  const recorded = recordSopPersona(options);
  assert.equal(recorded.sop.commit, sopCommit);
  // Destroy the remote: subsequent policy evaluation and both journeys must
  // use the immutable local record, without fetching or calling a real app.
  rmSync(repo, { recursive: true });
  const persona = loadPersona(a);
  assert.equal(persona.state, 'ok');
  assert.equal(persona.commit, sopCommit);
  if (enabled) {
    const reviewer = resolveSandbox({ id: 'agent_12345678-1234-4234-8234-123456789abc', name: 'fixture', sandbox: 'unrestricted' },
      { enabled: true, account: 'unused' }, { owner: 'qwts', persona, role: 'reviewer' });
    assert.equal(reviewer.source, 'sop');
    assert.equal(reviewer.runsAs, 'qwts-reviewer');
  }
  a.env.CLAUDECODE = '1';
}

for (const mode of ['zero SOP and zero add-ons', 'selected qwts fixture with gates off', 'selected qwts fixture with gates explicitly on']) {
  test(`${mode}: fresh soul binds, chats through ACP and wakes with the same binding (#611)`, async (t) => {
    const a = account(t);
    const enabled = mode.endsWith('explicitly on');
    if (mode.startsWith('selected')) selectedPack(a, enabled);
    const options = { ...a, cwd: a.home };
    const config = loadConfig(options);
    const expectedGates = Object.fromEntries(['github-identity', 'persona-accounts'].map(name => [name, { enabled, source: enabled ? 'user-config' : 'default' }]));
    assert.deepEqual(gateStatus(config), expectedGates);
    if (mode.startsWith('zero')) assert.equal(resolveSop({ ...options, currentAgentId: () => null, readBinding: () => null,
      runGit: () => assert.fail('zero SOP must not fetch governance') }).inEffect, false);
    const identities = id => readAgentIdentity(id, { stateDir: a.env.AGENT_BOT_STATE_HOME });
    const executions = [];
    const factory = acpExecutorFor({ identities, baseEnv: a.env, interactionStore: a,
      policy: { version: 1, rules: [], fallback: 'deny' },
      createExecutor: opts => {
        executions.push(opts);
        return createAcpExecutor({ ...opts, registry: { claude: { harness: 'claude', enabled: true,
          command: process.execPath, args: [FAKE_ACP], stripEnv: [] } } });
      },
    });
    const server = createDaemonServer({ ...a, config,
      mintImpl: () => assert.fail('ordinary chat must not mint GitHub credentials'),
      keydCall: () => assert.fail('ordinary chat must not need keyd credentials'),
      executor: input => {
        const binding = server.bindings.findAgent(input.invocation.agentId);
        return factory({ agentId: input.invocation.agentId, harness: 'claude', cwd: binding.worktree,
          env: { AGENT_BOT_BINDING: binding.file } })(input);
      },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, body, token = server.token) => {
      const response = await fetch(`${url}${route}`, { method: 'POST', headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json',
      }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    let consents = 0;
    const joined = await joinSoul({ ...options, config, name: 'fixture', harness: 'claude', template: template(a.home), wake: 'acp',
      gate: async () => { consents++; return { method: 'fixture-consent' }; },
      daemon: { bind: async body => {
        const result = await call('/v0/bind', body);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body;
      } },
      installHarness: (id, source, opts) => installSoulHarnesses(id, source, { ...opts, install: async dir => {
        mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude-code-acp'), '');
      } }),
    });
    assert.equal(consents, 1);
    assert.equal(joined.bind, 'bound');
    assert.equal(identities(joined.agentId).github?.appSlug ?? null, enabled ? 'qwts-claude-agent' : null);
    const binding = server.bindings.findAgent(joined.agentId);
    assert.equal(binding.worktree, joined.worktree);
    const principalOptions = { ...a, file: a.env.AGENT_BOT_PRINCIPALS_PATH };
    const principal = enrollPrincipal({ label: 'fixture owner' }, principalOptions);
    const requester = { transport: 'web', providerId: 'fixture-owner' };
    bindTransport(principal.principalId, requester, principalOptions);
    authorizeSouls(principal.principalId, [joined.agentId], principalOptions);
    setOperations(principal.principalId, ['message', 'observe', 'cancel'], principalOptions);
    assert.equal((await call('/v1/sessions', { ...requester, agentId: joined.agentId }, null)).status, 401);
    assert.equal((await call('/v1/sessions', { ...requester, providerId: 'stranger', agentId: joined.agentId })).status, 403);
    const created = await call('/v1/sessions', { ...requester, agentId: joined.agentId });
    assert.equal(created.status, 200);
    const submitted = await call(`/v1/sessions/${created.body.session.sessionId}/messages`, { ...requester, message: 'hello fixture', idempotencyKey: 'first' });
    assert.equal(submitted.status, 200);
    const id = submitted.body.invocation.invocationId;
    const deadline = Date.now() + 8_000;
    while (!['completed', 'failed'].includes(getInvocation(id, a).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getInvocation(id, a).status, 'completed', JSON.stringify(getInvocation(id, a)));
    assert.ok(readEvents(id, {}, a).some(event => event.data?.content?.text === 'pong: hello fixture'));
    const receipts = [], wakeEvents = [];
    const coldWake = createColdWaker({
      executor: coldTurnExecutor({ executorFor: factory, onEvent: type => wakeEvents.push(type) }),
      settings: JSON.parse(readFileSync(path.join(a.env.XDG_STATE_HOME, 'agent-bot', 'cold-wake.json'))).settings,
      lookupBinding: id => server.bindings.findAgent(id), identities, receipt: item => receipts.push(item),
    });
    assert.equal((await coldWake({ agentId: joined.agentId, count: 1, messageIds: ['msg_fixture'] })).outcome, 'cold');
    await coldWake.idle();
    assert.equal(executions.length, 2, 'both user chat and cold wake spawned the scripted ACP harness');
    assert.ok(wakeEvents.includes('update'));
    assert.ok(!receipts.some(receipt => receipt.decision === 'failed'), JSON.stringify(receipts));
    for (const execution of executions) {
      assert.equal(execution.identity.agentId, joined.agentId);
      assert.equal(execution.cwd, joined.worktree);
      assert.equal(execution.env.AGENT_BOT_BINDING, binding.file);
    }
    assert.deepEqual(gateStatus(loadConfig(options)), expectedGates, 'bind, chat and wake did not enable add-ons');
  });
}
