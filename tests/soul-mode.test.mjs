import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOUL_MODES, readSoulModes, setSoulMode, soulMode, soulModeCommand, soulModeFile } from '../soul-mode.mjs';
import { coldWakeFile } from '../cold-wake-settings.mjs';
import { populationFile, upsertSoul, withRoles, listSouls } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { assertOwnerAction, ownerActionSummary } from '../owner-action.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-mode-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'), GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const file = populationFile({ env, home });
  upsertSoul({ id: ID, name: 'bill', displayName: 'Bill - Starter', status: 'active',
    spacePath: path.join(home, 'space'), lastSeen: '2026-10-05T00:00:00.000Z' }, { file });
  const out = [];
  const gates = [];
  const opts = { env, home, cwd: home, write: (text) => out.push(text), now: () => new Date('2026-10-05T00:00:00.000Z'),
    gate: async (action, input) => { gates.push({ action, ...input }); return { method: 'consent' }; } };
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { env, cwd: home, encoding: 'utf8' });
  return { env, home, file, out, gates, opts, invoke };
}

test('soul modes default to safe and round-trip beside cold wake with private atomic writes', (t) => {
  const { opts } = fixture(t);
  assert.deepEqual(SOUL_MODES, ['safe', 'autopilot']);
  assert.deepEqual(readSoulModes(opts), {});
  assert.equal(soulMode(ID, opts), 'safe');
  assert.equal(path.dirname(soulModeFile(opts)), path.dirname(coldWakeFile(opts)));
  assert.equal(path.basename(soulModeFile(opts)), 'soul-modes.json');
  assert.equal(soulModeFile({ env: {}, home: opts.home }), path.join(opts.home, '.local', 'state', 'agent-bot', 'soul-modes.json'));
  assert.equal(setSoulMode(ID, 'autopilot', opts), 'autopilot');
  setSoulMode(OTHER, 'safe', opts);
  assert.deepEqual(readSoulModes(opts), { [ID]: 'autopilot', [OTHER]: 'safe' });
  assert.equal(soulMode(ID, opts), 'autopilot');
  assert.equal(statSync(soulModeFile(opts)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(soulModeFile(opts))).schemaVersion, 1);
  assert.deepEqual(readdirSync(path.dirname(soulModeFile(opts))).filter((name) => name.endsWith('.tmp')), []);
  const rows = readFileSync(auditFile(opts), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0], { at: '2026-10-05T00:00:00.000Z', event: 'soul-mode', agentId: ID, operation: 'set', decision: 'autopilot' });
});

test('invalid modes and agent ids are refused without writing; corrupt stored settings fail closed', (t) => {
  const { opts } = fixture(t);
  for (const mode of ['auto', '', null, true]) assert.throws(() => setSoulMode(ID, mode, opts), /soul mode must be/);
  assert.throws(() => setSoulMode('../invalid', 'safe', opts), /Agent ID/i);
  assert.throws(() => soulMode('../invalid', opts), /Agent ID/i);
  assert.equal(existsSync(soulModeFile(opts)), false);
  setSoulMode(ID, 'safe', opts);
  for (const content of ['not json', JSON.stringify({ settings: { [ID]: 'auto' } }), JSON.stringify({ settings: { invalid: 'safe' } })]) {
    writeFileSync(soulModeFile(opts), content);
    assert.throws(() => readSoulModes(opts), /settings could not be read/);
  }
});

test('CLI shows and sets plain or JSON modes; names and presented principals reach the owner gate', async (t) => {
  const f = fixture(t);
  await soulModeCommand([ID], f.opts);
  assert.equal(f.out.pop(), 'mode: safe\n');
  await soulModeCommand(['bill', 'show', '--json'], f.opts);
  assert.deepEqual(JSON.parse(f.out.pop()), { agentId: ID, mode: 'safe' });
  assert.equal(f.gates.length, 0);
  const principal = { principal: 'test-owner', secret: 'synthetic-test-value' };
  await soulModeCommand(['Bill - Starter', 'autopilot', '--json', '--principal-stdin'], {
    ...f.opts, readStdin: () => JSON.stringify(principal),
  });
  assert.deepEqual(JSON.parse(f.out.pop()), { agentId: ID, mode: 'autopilot' });
  assert.equal(f.gates[0].action, `switch ${ID} to Auto-Pilot`);
  assert.equal(ownerActionSummary(f.gates[0].action, { env: f.env }), `switch Bill - Starter (${ID}) to Auto-Pilot`);
  assert.deepEqual(f.gates[0].principal, principal);
  await soulModeCommand([ID, 'safe'], f.opts);
  assert.equal(f.out.pop(), 'mode: safe\n');
  assert.match(f.gates[1].action, /to Safe$/);
  for (const args of [[ID], ['bill', 'show'], ['Bill - Starter', 'show']]) {
    const result = f.invoke('soul', 'mode', ...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { agentId: ID, mode: 'safe' });
  }
  assert.equal(f.invoke('soul', 'mode', ID).stdout, 'mode: safe\n');
});

test('refused owner gate or invalid CLI arguments write neither settings nor receipts', async (t) => {
  const f = fixture(t);
  await assert.rejects(soulModeCommand([ID, 'autopilot'], { ...f.opts, gate: async () => { throw new Error('cancelled'); } }), /cancelled/);
  const env = { ...f.env, AGENT_BOT_ID: ID };
  const gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd: f.home, detect: false,
    consent: () => assert.fail('must not open a dialog'), verifyPrincipal: () => assert.fail('must not consult a broker') });
  await assert.rejects(soulModeCommand([ID, 'autopilot'], { ...f.opts, env, gate }), /owner only/);
  for (const args of [[ID, 'auto'], [ID, 'show', '--principal-stdin'], [ID, '--json', '--json'], [ID, 'safe', 'extra']]) {
    await assert.rejects(soulModeCommand(args, { ...f.opts, gate: () => assert.fail('invalid arguments must not reach gate') }), /usage/);
  }
  assert.equal(existsSync(soulModeFile(f.opts)), false);
  assert.equal(existsSync(auditFile(f.opts)), false);
});

test('CLI JSON failures use stdout, a stable code and exit 1', (t) => {
  const f = fixture(t);
  for (const args of [['missing'], [ID, 'auto'], [ID, '--json']]) {
    const result = f.invoke('soul', 'mode', ...args, '--json');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).error.code, 'soul-mode-failed');
  }
  setSoulMode(ID, 'safe', f.opts);
  writeFileSync(soulModeFile(f.opts), 'broken json');
  const result = f.invoke('soul', 'mode', ID, '--json');
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).error.message, /settings could not be read/);
});

test('population CLI and HTTP derive mode on read without persisting it in the census', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.file, 'utf8');
  assert.equal(withRoles(listSouls({ file: f.file }), f.opts)[0].mode, 'safe');
  setSoulMode(ID, 'autopilot', f.opts);
  for (const args of [['list', '--json'], ['show', ID, '--json']]) {
    const result = f.invoke('population', ...args);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal((Array.isArray(value) ? value[0] : value).mode, 'autopilot');
    assert.equal((Array.isArray(value) ? value[0] : value).comms, true);
  }
  const server = createDaemonServer({ env: f.env, home: f.home, config: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v0/population`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).souls[0].mode, 'autopilot');
  } finally { await new Promise((resolve) => server.close(resolve)); }
  setSoulMode(ID, 'safe', f.opts);
  assert.equal(withRoles(listSouls({ file: f.file }), f.opts)[0].mode, 'safe');
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
