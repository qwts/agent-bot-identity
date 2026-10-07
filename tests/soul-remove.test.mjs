import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditFile } from '../agent-principals.mjs';
import { populationFile, registerSoulDir, showSoul, upsertSoul } from '../agent-population.mjs';
import { readColdWakeSettings, setColdWake } from '../cold-wake-settings.mjs';
import { soulRemoveCommand } from '../soul-remove.mjs';

const id = 'agent_66666666-6666-4666-8666-666666666666';

function fixture(t, { running = false, leave = async () => true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-remove-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls') };
  const file = populationFile({ env, home });
  upsertSoul({ id, name: 'r8scout', status: 'active', spacePath: path.join(home, 'space') }, { file });
  const folder = path.join(env.AGENT_BOT_SOULS_HOME, 'R8Scout - Starter.soul');
  mkdirSync(path.join(folder, '.soul-state'), { recursive: true });
  writeFileSync(path.join(folder, '.soul-state', 'agent-id'), `${id}\n`);
  writeFileSync(path.join(folder, 'soul.json'), '{"name":"R8Scout - Starter"}\n');
  registerSoulDir(id, folder, { file });
  const gates = [];
  const left = [];
  const out = [];
  const options = {
    env, home, cwd: home, now: () => new Date('2026-10-03T22:30:00.000Z'),
    write: (text) => out.push(text),
    gate: async (action) => { gates.push(action); return { method: 'test' }; },
    status: async () => ({ running: true, busy: running ? [id] : [], warmPool: {} }),
    leave: async (soul) => { left.push(soul); return leave(soul); },
  };
  return { home, env, file, folder, gates, left, out, options };
}

test('remove turns wake off, leaves agent-comms, retires the soul and archives its folder', async (t) => {
  const f = fixture(t);
  setColdWake(id, true, { env: f.env, home: f.home });
  const result = await soulRemoveCommand(['r8scout', '--json'], f.options);
  assert.deepEqual(f.gates, [`soul remove ${id}`]);
  assert.deepEqual(f.left, [{ agentId: id }]);
  assert.equal(readColdWakeSettings({ env: f.env, home: f.home })[id], false);
  assert.equal(showSoul(id, { file: f.file }).status, 'retired');
  assert.equal(existsSync(f.folder), false);
  const archived = path.join(f.env.AGENT_BOT_SOULS_HOME, '.archive', '20261003T223000Z-R8Scout - Starter.soul');
  assert.equal(readFileSync(path.join(archived, 'soul.json'), 'utf8'), '{"name":"R8Scout - Starter"}\n');
  assert.deepEqual(result, { agentId: id, name: 'R8Scout - Starter', handle: 'r8scout', wake: 'off', comms: 'left', retired: true,
    archived: [{ from: f.folder, to: archived }] });
  assert.deepEqual(JSON.parse(f.out.join('')), result);
  const receipts = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.filter(({ event }) => event === 'soul-remove').map(({ agentId, decision }) => ({ agentId, decision })),
    [{ agentId: id, decision: 'removed' }]);
});

test('remove is refused while the soul runs, before the owner is asked', async (t) => {
  const f = fixture(t, { running: true });
  await assert.rejects(soulRemoveCommand([id], f.options), (error) => error.code === 'soul-running');
  assert.deepEqual(f.gates, []);
  assert.equal(showSoul(id, { file: f.file }).status, 'active');
  assert.equal(existsSync(f.folder), true);
});

test('a refused owner gate changes nothing', async (t) => {
  const f = fixture(t);
  const gate = async () => { throw new Error('owner approval was denied'); };
  await assert.rejects(soulRemoveCommand([id], { ...f.options, gate }), /denied/);
  assert.deepEqual(f.left, []);
  assert.equal(showSoul(id, { file: f.file }).status, 'active');
  assert.equal(existsSync(f.folder), true);
});

// A failed launch (#419) or a remove whose leave failed leaves a retired soul
// with a folder or a membership: removing it again finishes the job.
test('removing a retired soul finishes the cleanup, and a failed leave is reported', async (t) => {
  const f = fixture(t, { leave: async () => { throw new Error('leaving agent-comms failed: no broker'); } });
  upsertSoul({ id, name: 'r8scout', status: 'retired', spacePath: path.join(f.home, 'space') }, { file: f.file });
  const result = await soulRemoveCommand([id], f.options);
  assert.equal(result.comms, 'not left: leaving agent-comms failed: no broker');
  assert.equal(result.archived.length, 1);
  assert.equal(existsSync(f.folder), false);
  assert.match(f.out.join(''), /agent-comms not left: .*no broker.*folder archived to/);
  const again = await soulRemoveCommand([id, '--json'], { ...f.options, leave: async () => true });
  assert.deepEqual(again.archived, []);
  assert.equal(again.comms, 'left');
});

test('remove needs exactly one soul', async (t) => {
  const f = fixture(t);
  await assert.rejects(soulRemoveCommand([], f.options), /usage: agent-bot soul remove/);
  await assert.rejects(soulRemoveCommand([id, 'extra'], f.options), /usage: agent-bot soul remove/);
  await assert.rejects(soulRemoveCommand(['nobody'], f.options), /no population record/);
  assert.deepEqual(f.gates, []);
});

test('a folder that will not move after the owner gate names the step and what to do (#531)', async (t) => {
  const f = fixture(t);
  const archive = () => { throw Object.assign(new Error(`EPERM: operation not permitted, rename '${f.folder}' -> '${f.folder}.archived'`), { code: 'EPERM' }); };
  await assert.rejects(soulRemoveCommand([id, '--json'], { ...f.options, archive }), (error) => {
    assert.equal(error.code, 'soul-archive-failed');
    assert.equal(error.message, `${id} is retired, but its folder could not be moved into the souls folder's .archive: `
      + `EPERM: operation not permitted, rename '${f.folder}' -> '${f.folder}.archived'; `
      + 'close whatever holds the folder open (or move it there by hand), then run soul remove again');
    return true;
  });
  assert.equal(f.gates.length, 1);
  assert.equal(showSoul(id, { file: f.file }).status, 'retired', 'the retirement stands');
  assert.ok(existsSync(f.folder), 'the folder stays where it was');
  // The rerun finishes the cleanup.
  const result = await soulRemoveCommand([id, '--json'], f.options);
  assert.equal(result.archived.length, 1);
  assert.ok(!existsSync(f.folder));
});
