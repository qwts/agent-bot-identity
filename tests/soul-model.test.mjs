import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSoulModels, recordSoulModels, setSoulModel, soulModel, soulModelCommand, soulModelFile } from '../soul-model.mjs';
import { populationFile, upsertSoul, withRoles, listSouls } from '../agent-population.mjs';
import { appendAuditReceipt, auditFile } from '../agent-principals.mjs';
import { assertOwnerAction } from '../owner-action.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const available = [{ modelId: 'provider/model', name: 'Model', description: 'A model' }, { modelId: 'default', name: 'Default' }];
const at = '2026-10-05T00:00:00.000Z';
const empty = { model: null, available: null, listedAt: null };

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-model-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'), GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const file = populationFile({ env, home });
  upsertSoul({ id: ID, name: 'bill', displayName: 'Bill - Starter', status: 'active',
    spacePath: path.join(home, 'space'), transcriptLocator: { provider: 'claude', id: 'session-test' }, lastSeen: at }, { file });
  const out = [], gates = [];
  const opts = { env, home, cwd: home, write: (text) => out.push(text), now: () => new Date(at),
    gate: async (action, input) => { gates.push({ action, ...input }); return { method: 'consent' }; } };
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { env, cwd: home, encoding: 'utf8' });
  return { env, home, file, out, gates, opts, invoke };
}

const receipts = (opts) => readFileSync(auditFile(opts), 'utf8').trim().split('\n').map(JSON.parse);

test('model settings and cache round-trip atomically with private permissions and receipts only for owner changes', (t) => {
  const { opts } = fixture(t);
  assert.deepEqual(readSoulModels(opts), {});
  assert.deepEqual(soulModel(ID, opts), empty);
  assert.equal(soulModelFile({ env: {}, home: opts.home }), path.join(opts.home, '.local', 'state', 'agent-bot', 'soul-models.json'));
  recordSoulModels(ID, { availableModels: available, currentModelId: 'default' }, opts);
  assert.equal(existsSync(auditFile(opts)), false);
  assert.deepEqual(soulModel(ID, opts), { model: null, available, listedAt: at });
  setSoulModel(ID, 'provider/model', opts);
  setSoulModel(OTHER, 'other-model', opts);
  const before = receipts(opts);
  recordSoulModels(ID, { availableModels: [], currentModelId: 'default' }, { ...opts, now: () => new Date('2026-10-06T00:00:00.000Z') });
  assert.deepEqual(receipts(opts), before);
  assert.deepEqual(soulModel(ID, opts), { model: 'provider/model', available: [], listedAt: '2026-10-06T00:00:00.000Z' });
  setSoulModel(ID, null, opts);
  assert.equal(soulModel(ID, opts).model, null);
  assert.equal(soulModel(OTHER, opts).model, 'other-model');
  assert.deepEqual(soulModel(ID, opts).available, []);
  assert.deepEqual(JSON.parse(readFileSync(soulModelFile(opts))), { schemaVersion: 1, settings: readSoulModels(opts) });
  assert.equal(statSync(soulModelFile(opts)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(soulModelFile(opts))).filter((name) => /\.tmp$|\.lock$/.test(name)), []);
  assert.deepEqual(before[0], { at, event: 'soul-model', agentId: ID, operation: 'set', decision: 'provider/model' });
  assert.deepEqual(receipts(opts).at(-1), { at, event: 'soul-model', agentId: ID, operation: 'clear', decision: 'default' });
});

test('valid 120-character models audit without truncation; invalid values and corrupt settings fail closed', (t) => {
  const { opts } = fixture(t);
  for (const model of ['', ' ', 'x'.repeat(121), 'a\nb', 'a\x00b', 'a\x7fb', 'a\x85b', 'a\u202eb', true, 12, {}, undefined]) {
    assert.throws(() => setSoulModel(ID, model, opts), /modelId must be/);
  }
  assert.throws(() => setSoulModel('../bad', 'model', opts), /Agent ID/i);
  assert.throws(() => soulModel('../bad', opts), /Agent ID/i);
  assert.equal(existsSync(soulModelFile(opts)), false);
  const model = 'x'.repeat(120);
  setSoulModel(ID, model, opts);
  assert.equal(receipts(opts)[0].decision, `${'x'.repeat(39)}…`);
  assert.equal(receipts(opts)[0].detail, `model: ${model}`);
  assert.throws(() => appendAuditReceipt({ event: 'other', decision: model }, opts), /40 characters/);
  for (const content of ['broken', JSON.stringify({ settings: [] }), JSON.stringify({ settings: { [ID]: { ...empty, model: false } } }),
    JSON.stringify({ settings: { invalid: empty } }), JSON.stringify({ settings: { [ID]: { ...empty, listedAt: 'yesterday' } } })]) {
    writeFileSync(soulModelFile(opts), content);
    assert.throws(() => readSoulModels(opts), /settings could not be read/);
  }
});

test('CLI resolves names, shows harness/cache, and gates set and clear with the presented principal', async (t) => {
  const f = fixture(t);
  await soulModelCommand([ID], f.opts);
  assert.equal(f.out.pop(), 'model: default\n');
  await soulModelCommand(['bill', 'show', '--json'], f.opts);
  assert.deepEqual(JSON.parse(f.out.pop()), { agentId: ID, ...empty, harness: 'claude' });
  assert.equal(f.gates.length, 0);
  const principal = { principal: 'test-owner', secret: 'synthetic-test-value' };
  await soulModelCommand(['Bill - Starter', 'set', 'provider/model', '--json', '--principal-stdin'], {
    ...f.opts, readStdin: () => JSON.stringify(principal),
  });
  assert.equal(JSON.parse(f.out.pop()).model, 'provider/model');
  assert.equal(f.gates[0].action, `set ${ID} model to provider/model`);
  assert.deepEqual(f.gates[0].principal, principal);
  recordSoulModels(ID, { availableModels: available, currentModelId: 'default' }, f.opts);
  for (const args of [[ID], ['bill', 'show'], ['Bill - Starter', 'show']]) {
    const result = f.invoke('soul', 'model', ...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { agentId: ID, model: 'provider/model', available, listedAt: at, harness: 'claude' });
  }
  await soulModelCommand([ID, 'clear'], f.opts);
  assert.equal(f.out.pop(), 'model: default\n');
  assert.equal(f.gates[1].action, `reset ${ID} to its harness's default model`);
});

test('gate refusal and invalid CLI arguments write neither settings nor receipts', async (t) => {
  const f = fixture(t);
  for (const action of [['set', 'chosen'], ['clear']]) {
    await assert.rejects(soulModelCommand([ID, ...action], { ...f.opts, gate: async () => { throw new Error('cancelled'); } }), /cancelled/);
  }
  const env = { ...f.env, AGENT_BOT_ID: ID };
  const gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd: f.home, detect: false,
    consent: () => assert.fail('must not open a dialog'), verifyPrincipal: () => assert.fail('must not consult a broker') });
  await assert.rejects(soulModelCommand([ID, 'set', 'chosen'], { ...f.opts, env, gate }), /owner only/);
  for (const args of [[], [ID, 'set'], [ID, 'clear', 'extra'], [ID, 'show', '--principal-stdin'], [ID, '--json', '--json'], [ID, 'other']]) {
    await assert.rejects(soulModelCommand(args, { ...f.opts, gate: () => assert.fail('invalid args reached gate') }), /usage/);
  }
  assert.equal(existsSync(soulModelFile(f.opts)), false);
  assert.equal(existsSync(auditFile(f.opts)), false);
});

test('CLI JSON errors have stable codes on stdout and exit 1', (t) => {
  const f = fixture(t);
  for (const args of [['missing'], [ID, 'set'], [ID, 'set', ''], [ID, '--json']]) {
    const result = f.invoke('soul', 'model', ...args, '--json');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).error.code, 'soul-model-failed');
  }
});

test('population CLI and HTTP derive model without modifying census records', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.file, 'utf8');
  assert.equal(withRoles(listSouls({ file: f.file }), f.opts)[0].model, null);
  setSoulModel(ID, 'chosen', f.opts);
  for (const args of [['list', '--json'], ['show', ID]]) {
    const result = f.invoke('population', ...args);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal((Array.isArray(value) ? value[0] : value).model, 'chosen');
  }
  const server = createDaemonServer({ env: f.env, home: f.home, config: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v0/population`, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).souls[0].model, 'chosen');
  } finally { await new Promise((resolve) => server.close(resolve)); }
  setSoulModel(ID, null, f.opts);
  assert.equal(withRoles(listSouls({ file: f.file }), f.opts)[0].model, null);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
