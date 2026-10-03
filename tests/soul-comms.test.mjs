import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerSoulDir, setSoulComms, showSoul, upsertSoul } from '../agent-population.mjs';
import { computePackageRevision, validateSoulPackage, writeSoulComms } from '../soul-package.mjs';
import { soulCommsCommand, soulRunning } from '../soul-comms.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';

function fixture(t, { comms } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-comms-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_SOULS_HOME: path.join(home, 'souls') };
  const file = env.AGENT_BOT_POPULATION_PATH;
  const soulDir = path.join(home, 'souls', 'Bill.soul');
  mkdirSync(path.join(soulDir, '.soul-state'), { recursive: true });
  writeFileSync(path.join(soulDir, '.soul-state', 'agent-id'), `${ID}\n`);
  const manifest = { formatVersion: 1, name: 'bill', description: 'Test soul', displaySeed: 'bill',
    preferredHarnesses: [], ...(comms === undefined ? {} : { comms }), revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(soulDir, 'AGENTS.md'), 'Instructions');
  manifest.revision = computePackageRevision(soulDir);
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify(manifest));
  upsertSoul({ id: ID, name: 'bill', status: 'active', spacePath: path.join(home, 'space'), lastSeen: '2026-10-03T00:00:00.000Z',
    managed: true }, { file });
  registerSoulDir(ID, soulDir, { file });
  const out = [];
  const gates = [];
  const options = { env, home, write: (text) => out.push(text),
    gate: async (action, { principal }) => { gates.push({ action, principal }); return { method: 'consent' }; },
    status: async () => ({ running: true, warmPool: {}, busy: [] }),
    revisions: { history: () => [], edit: async () => { throw new Error('unexpected edit'); } } };
  return { home, env, file, soulDir, out, gates, options };
}
const manifestOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'soul.json'), 'utf8'));

test('writeSoulComms edits soul.json as a new revision and is a no-op when unchanged', (t) => {
  const { soulDir } = fixture(t);
  const before = manifestOf(soulDir);
  assert.equal(writeSoulComms(soulDir, true), null, 'absent already means on');
  assert.notEqual(writeSoulComms(soulDir, false), null);
  const off = manifestOf(soulDir);
  assert.equal(off.comms, false);
  assert.equal(off.parentRevision, before.revision);
  assert.equal(validateSoulPackage(soulDir).revision, off.revision);
  writeSoulComms(soulDir, true);
  const on = manifestOf(soulDir);
  assert.equal('comms' in on, false, 'on removes the key: absent means on');
  assert.equal(validateSoulPackage(soulDir).revision, on.revision);
  assert.throws(() => writeSoulComms(soulDir, 'off'), /comms must be a boolean/);
});

test('show reports managed, comms and running by Agent ID or name, without the owner gate', async (t) => {
  const f = fixture(t, { comms: false });
  const shown = await soulCommsCommand([ID, 'show', '--json'], f.options);
  assert.deepEqual(shown, { agentId: ID, name: 'bill', managed: true, comms: false, running: false });
  assert.deepEqual(JSON.parse(f.out[0]), shown);
  await soulCommsCommand(['bill'], f.options);
  assert.equal(f.out[1], `${ID} managed comms off\n`);
  assert.equal(f.gates.length, 0);
});

test('off and on change soul.json and the census row turns read, behind the owner gate', async (t) => {
  const f = fixture(t);
  const result = await soulCommsCommand([ID, 'off', '--json'], f.options);
  assert.equal(result.comms, false);
  assert.deepEqual(f.gates, [{ action: `soul comms ${ID} off`, principal: null }]);
  assert.equal(manifestOf(f.soulDir).comms, false);
  assert.equal(showSoul(ID, { file: f.file }).comms, false);
  assert.equal(showSoul(ID, { file: f.file }).managed, true, 'managed is left as it is');
  await soulCommsCommand([ID, 'on'], f.options);
  assert.equal(showSoul(ID, { file: f.file }).comms, true);
  assert.equal('comms' in manifestOf(f.soulDir), false);
});

test('a running soul keeps its setting: the change is refused before the gate', async (t) => {
  for (const status of [async () => ({ running: true, warmPool: { [ID]: 1 }, busy: [] }),
    async () => ({ running: true, warmPool: {}, busy: [ID] })]) {
    const f = fixture(t);
    await assert.rejects(soulCommsCommand([ID, 'off'], { ...f.options, status }), /is running; stop it/);
    assert.equal(f.gates.length, 0);
    assert.equal('comms' in manifestOf(f.soulDir), false);
    assert.equal(showSoul(ID, { file: f.file }).comms, true);
  }
});

test('an owner refusal changes nothing', async (t) => {
  const f = fixture(t);
  await assert.rejects(soulCommsCommand([ID, 'off'], { ...f.options, gate: async () => { throw new Error('owner only'); } }), /owner only/);
  assert.equal('comms' in manifestOf(f.soulDir), false);
});

test('a soul with a revision chain records the change as an owner edit; a failed edit restores soul.json', async (t) => {
  const f = fixture(t);
  const edits = [];
  await soulCommsCommand([ID, 'off', '--principal-stdin'], { ...f.options, readStdin: () => '{"principal":"owner"}',
    revisions: { history: () => [{ revision: 'x' }], edit: async (id, dir, options) => { edits.push({ id, dir, reason: options.reason, authorization: options.authorization }); } } });
  assert.deepEqual(f.gates[0].principal, { principal: 'owner' });
  assert.deepEqual(edits, [{ id: ID, dir: f.soulDir, reason: 'comms off', authorization: { method: 'consent' } }]);

  const g = fixture(t);
  const before = readFileSync(path.join(g.soulDir, 'soul.json'), 'utf8');
  await assert.rejects(soulCommsCommand([ID, 'off'], { ...g.options,
    revisions: { history: () => [{}], edit: async () => { throw new Error('stale edit'); } } }), /stale edit/);
  assert.equal(readFileSync(path.join(g.soulDir, 'soul.json'), 'utf8'), before);
  assert.equal(showSoul(ID, { file: g.file }).comms, true);
});

test('usage errors and unknown souls fail clearly', async (t) => {
  const f = fixture(t);
  await assert.rejects(soulCommsCommand([], f.options), /usage: agent-bot soul comms/);
  await assert.rejects(soulCommsCommand([ID, 'maybe'], f.options), /usage/);
  await assert.rejects(soulCommsCommand([ID, 'show', '--principal-stdin'], f.options), /usage/);
  await assert.rejects(soulCommsCommand(['nobody'], f.options), /no population record with that name/);
});

test('soulRunning: no daemon means not running', async () => {
  assert.equal(await soulRunning(ID, { status: async () => ({ running: false }) }), false);
  assert.equal(await soulRunning(ID, { status: async () => ({ running: true, warmPool: { [ID]: 2 } }) }), true);
});

test('setSoulComms needs a row only to turn comms off', (t) => {
  const f = fixture(t);
  const other = 'agent_22222222-2222-4222-8222-222222222222';
  assert.equal(setSoulComms(other, true, { file: f.file }), null);
  assert.throws(() => setSoulComms(other, false, { file: f.file }), /cannot record comms off/);
  assert.throws(() => setSoulComms(ID, 'no', { file: f.file }), /comms must be a boolean/);
});
