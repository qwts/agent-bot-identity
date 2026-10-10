import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { upsertSoul } from '../agent-population.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import { getInvocation, readEvents } from '../agent-jobs.mjs';
import { authorizeSouls, bindTransport, enrollPrincipal, setOperations } from '../agent-principals.mjs';
import { stateDirectory } from '../agent-identity.mjs';
import { turnSandboxProblem } from '../sandbox.mjs';
import { coldTurnExecutor, createTurnRegistry } from '../wake-plane.mjs';

// The owner's decision on #613 (2026-10-09): the persona policy is checked
// strictly at the start of every turn, once per turn. The registry is wired
// here as runDaemon wires it, over a real recorded SOP persona mapping.
const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const COMMIT = 'a'.repeat(40);

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'persona-turn-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'),
    AGENT_BOT_CONFIG: path.join(home, 'config', 'config.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json') };
  upsertSoul({ id: ID, name: 'fixture-fern-11', displayName: 'Fixture', spacePath: path.join(home, 'space'), status: 'active', parentId: null, appSlug: null },
    { file: env.AGENT_BOT_POPULATION_PATH });
  const config = path.join(home, '.config', 'agent-sop', 'config.toml');
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, 'schema_version = 1\n[repos]\norg = "local/org@main"\nsop = "local/sop@main"\n');
  const record = path.join(stateDirectory({ env, home }), 'sop-persona.json');
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ schemaVersion: 1, recordedAt: '2026-10-09T00:00:00.000Z', configPath: config,
    selection: { org: 'local/org@main', sop: 'local/sop@main' },
    org: { repository: 'local/org', commit: COMMIT }, sop: { repository: 'local/sop', commit: COMMIT },
    persona: 'schema_version = 1\n[persona]\nsandbox = "unrestricted"\n' }));
  const checks = [];
  const turns = createTurnRegistry({ policy: (check) => {
    checks.push(check);
    const problem = turnSandboxProblem(check.agentId, { env, home, owner: 'owner', acceptStale: check.ownerVerified });
    if (problem) throw problem;
  } });
  return { env, home, config, record, turns, checks };
}

test('the persona policy is checked strictly once at the start of every turn, so a selection change refuses the next turn (#613)', async (t) => {
  const f = fixture(t);
  const ran = [];
  const executor = async ({ invocation }) => { ran.push(invocation.agentId); return { ok: true }; };
  const invocation = { agentId: ID, harness: 'claude' };
  assert.deepEqual(await f.turns.run({ invocation, kind: 'wake' }, executor), { ok: true });
  // The owner moves the SOP to another ref: the record no longer matches.
  writeFileSync(f.config, 'schema_version = 1\n[repos]\norg = "local/org@main"\nsop = "local/sop@release"\n');
  await assert.rejects(f.turns.run({ invocation, kind: 'wake' }, executor),
    (error) => error.code === 'persona-policy-stale' && /is for sop local\/sop@main, not local\/sop@release.*agent-bot sop persona/.test(error.message));
  assert.deepEqual(ran, [ID], 'the refused turn never reached the executor');
  assert.deepEqual(f.checks, [{ agentId: ID, kind: 'wake', ownerVerified: null }, { agentId: ID, kind: 'wake', ownerVerified: null }], 'one check per turn');
  // Refreshed (the record now names the new selection), the next turn runs.
  const body = JSON.parse(readFileSync(f.record, 'utf8'));
  writeFileSync(f.record, JSON.stringify({ ...body, selection: { org: 'local/org@main', sop: 'local/sop@release' } }));
  await f.turns.run({ invocation, kind: 'wake' }, executor);
  assert.deepEqual(ran, [ID, ID]);
});

test('an agent-initiated cold wake on a legacy persona record is refused before its harness runs (#613)', async (t) => {
  const f = fixture(t);
  const { selection: _legacy, ...legacy } = JSON.parse(readFileSync(f.record, 'utf8'));
  writeFileSync(f.record, JSON.stringify(legacy));
  let prompted = 0;
  const wake = coldTurnExecutor({ turns: f.turns, executorFor: () => async () => { prompted += 1; return {}; } });
  await assert.rejects(wake({ invocation: { agentId: ID, harness: 'claude', invocationId: null }, message: 'hi', attachments: [], env: {} }),
    (error) => error.code === 'persona-policy-stale' && /recorded before agent-bot kept the selection/.test(error.message));
  assert.equal(prompted, 0);
  // Only a launch the owner verified carries past that stale record, and only into its own turn.
  const { digest } = turnSandboxProblem(ID, { env: f.env, home: f.home, owner: 'owner' });
  await assert.rejects(f.turns.run({ invocation: { agentId: ID }, kind: 'launch' }, async () => { prompted += 1; }, { ownerVerified: 'f'.repeat(64) }),
    { code: 'persona-policy-stale' });
  await f.turns.run({ invocation: { agentId: ID }, kind: 'launch' }, async () => { prompted += 1; }, { ownerVerified: digest });
  assert.equal(prompted, 1);
  await assert.rejects(f.turns.run({ invocation: { agentId: ID }, kind: 'wake' }, async () => { prompted += 1; }), { code: 'persona-policy-stale' });
  assert.equal(prompted, 1);
});

// Interactive turns (a principal's /v1 message) only `track`, so the
// interaction service asks the same policy through `check` first (#613).
let turnCount = 0;
async function interactiveTurn(f, { verifyOwner = null } = {}) {
  turnCount += 1;
  const options = { file: f.env.AGENT_BOT_PRINCIPALS_PATH, env: f.env, home: f.home };
  const enrolled = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(enrolled.principalId, { transport: 'web', providerId: `owner-subject-${turnCount}` }, options);
  authorizeSouls(enrolled.principalId, [ID], options);
  const principal = setOperations(enrolled.principalId, ['message', 'observe'], options);
  const ran = [];
  const asked = [];
  const interaction = createInteractionService({ env: f.env, home: f.home, config: {}, turns: f.turns, log: () => {},
    executor: async ({ invocation }) => { ran.push(invocation.invocationId); },
    ...(verifyOwner ? { verifyOwner: async (action, details) => { asked.push({ action, details }); return verifyOwner(action, details); } } : {}) });
  const { session } = interaction.createOrContinueSession({ principal, transport: 'web', agentId: ID });
  const { invocation } = interaction.submitMessage({ principal, transport: 'web', sessionId: session.sessionId, message: 'hi', idempotencyKey: `turn-${turnCount}` });
  const storeOptions = { env: f.env, home: f.home };
  let settled;
  for (let tries = 0; tries < 200; tries += 1) {
    settled = getInvocation(invocation.invocationId, storeOptions);
    if (['completed', 'failed', 'cancelled'].includes(settled.status)) break;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return { status: settled.status, ran, asked, events: readEvents(invocation.invocationId, {}, storeOptions) };
}

test('an interactive principal turn is checked against the persona policy before its executor runs (#613)', async (t) => {
  const f = fixture(t);
  const fine = await interactiveTurn(f);
  assert.equal(fine.status, 'completed');
  assert.deepEqual(f.checks, [{ agentId: ID, kind: 'interactive', ownerVerified: null }]);
  // Unavailable (not merely stale) is refused without asking anyone.
  writeFileSync(f.record, '{ not json');
  const broken = await interactiveTurn(f, { verifyOwner: () => ({ method: 'presence' }) });
  assert.equal(broken.status, 'failed');
  assert.deepEqual(broken.ran, []);
  assert.deepEqual(broken.asked, []);
  const refused = broken.events.find((event) => event.type === 'turn-refused');
  assert.equal(refused.data.code, 'persona-policy-unavailable');
  assert.match(refused.data.action, /agent-bot sop persona/);
});

test('a principal turn on a legacy persona record asks the owner, runs once verified, and is refused when declined (#613)', async (t) => {
  const f = fixture(t);
  const { selection: _legacy, ...legacy } = JSON.parse(readFileSync(f.record, 'utf8'));
  writeFileSync(f.record, JSON.stringify(legacy));
  const { digest } = turnSandboxProblem(ID, { env: f.env, home: f.home, owner: 'owner' });
  const approved = await interactiveTurn(f, { verifyOwner: () => ({ method: 'presence' }) });
  assert.equal(approved.status, 'completed');
  assert.equal(approved.ran.length, 1);
  assert.equal(approved.asked.length, 1);
  assert.match(approved.asked[0].action, /SOP persona record is stale \(local\/sop@a{40}\)/);
  const receipt = approved.events.find((event) => event.type === 'owner-verified');
  assert.deepEqual(receipt.data, { code: 'persona-policy-stale', method: 'presence', source: { repository: 'local/sop', commit: COMMIT }, digest });
  assert.deepEqual(f.checks.map((check) => check.ownerVerified), [null, digest], 'the re-check is bound to the record the owner was shown');

  const declined = await interactiveTurn(f, { verifyOwner: () => { throw new Error('owner declined'); } });
  assert.equal(declined.status, 'failed');
  assert.deepEqual(declined.ran, []);
  assert.equal(declined.events.some((event) => event.type === 'owner-verified'), false);
  assert.equal(declined.events.find((event) => event.type === 'turn-refused').data.code, 'persona-policy-stale');

  // Nobody to ask is a refusal, never a pass.
  const unwired = await interactiveTurn(f);
  assert.equal(unwired.status, 'failed');
  assert.deepEqual(unwired.ran, []);
});

test('a principal turn whose policy cannot be evaluated at all is still recorded as refused (#613)', async (t) => {
  const f = fixture(t);
  // The runtime config turned unreadable after startup: the check throws without a code.
  f.turns = createTurnRegistry({ policy: (check) => { f.checks.push(check); throw new Error('config.json is not valid JSON'); } });
  const broken = await interactiveTurn(f, { verifyOwner: () => ({ method: 'presence' }) });
  assert.equal(broken.status, 'failed');
  assert.deepEqual(broken.ran, []);
  assert.deepEqual(broken.asked, [], 'an unevaluated policy is refused, not offered to the owner');
  const refused = broken.events.find((event) => event.type === 'turn-refused');
  assert.equal(refused.data.code, 'persona-policy-unavailable');
  assert.match(refused.data.action, /agent-bot doctor/);
});

test('an event-store failure after the owner verifies is not relabeled as a policy refusal (#613)', async (t) => {
  const f = fixture(t);
  const { selection: _legacy, ...legacy } = JSON.parse(readFileSync(f.record, 'utf8'));
  writeFileSync(f.record, JSON.stringify(legacy));
  const options = { file: f.env.AGENT_BOT_PRINCIPALS_PATH, env: f.env, home: f.home };
  const enrolled = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(enrolled.principalId, { transport: 'web', providerId: 'owner-subject-store' }, options);
  authorizeSouls(enrolled.principalId, [ID], options);
  const principal = setOperations(enrolled.principalId, ['message', 'observe'], options);
  const events = path.join(f.env.AGENT_BOT_INTERACTION_HOME, 'events');
  const logs = [];
  const ran = [];
  // Verified, but the event log turns corrupt before `owner-verified` is written: a codeless store error.
  const interaction = createInteractionService({ env: f.env, home: f.home, config: {}, turns: f.turns, log: (line) => logs.push(line),
    executor: async ({ invocation }) => { ran.push(invocation.invocationId); },
    verifyOwner: async () => {
      for (const name of readdirSync(events)) appendFileSync(path.join(events, name), 'not json\n');
      return { method: 'presence' };
    } });
  const { session } = interaction.createOrContinueSession({ principal, transport: 'web', agentId: ID });
  const { invocation } = interaction.submitMessage({ principal, transport: 'web', sessionId: session.sessionId, message: 'hi', idempotencyKey: 'turn-store' });
  const storeOptions = { env: f.env, home: f.home };
  let settled;
  for (let tries = 0; tries < 200; tries += 1) {
    settled = getInvocation(invocation.invocationId, storeOptions);
    if (settled.status === 'failed') break;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.equal(settled.status, 'failed');
  assert.deepEqual(ran, []);
  const failure = logs.find((line) => line.includes(`invocation ${invocation.invocationId} failed`));
  assert.match(failure, /event log is corrupt/);
  assert.doesNotMatch(failure, /persona policy could not be checked/);
  const file = path.join(events, `${invocation.invocationId}.jsonl`);
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((line) => line !== 'not json').join('\n'));
  assert.equal(readEvents(invocation.invocationId, {}, storeOptions).some((event) => event.data?.code === 'persona-policy-unavailable'), false);
});
