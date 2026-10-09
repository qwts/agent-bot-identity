import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { upsertSoul } from '../agent-population.mjs';
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
    AGENT_BOT_CONFIG: path.join(home, 'config', 'config.json') };
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
