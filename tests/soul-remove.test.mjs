import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { populationFile, registerSoulDir, setSoulParent, showSoul, upsertSoul } from '../agent-population.mjs';
import { readColdWakeSettings, setColdWake } from '../cold-wake-settings.mjs';
import { REMOVE_CAPABILITIES, removalPlan, soulRemoveCommand } from '../soul-remove.mjs';

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
  // The single-soul fields stay as they were (GeniusBar reads them); the
  // plan and effects follow them (GeniusBar #283).
  const { plan, effects, ...legacy } = result;
  assert.deepEqual(legacy, { agentId: id, name: 'R8Scout - Starter', handle: 'r8scout', wake: 'off', comms: 'left', retired: true,
    archived: [{ from: f.folder, to: archived }] });
  assert.deepEqual(Object.keys(result), ['agentId', 'name', 'handle', 'wake', 'comms', 'retired', 'archived', 'plan', 'effects']);
  assert.equal(plan.scope, 'soul');
  assert.deepEqual(plan.archived.map(({ agentId }) => agentId), [id]);
  assert.deepEqual(effects, { scope: 'soul', archived: [legacy], independent: [], notArchived: [] });
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

// A lead with a nested team (GeniusBar #283): Luna leads Bolt (active, with
// a folder) and Dusk (retired); Bolt leads Sprocket, asleep; Dusk still names
// Ember, active under a retired parent.
const luna = 'agent_11111111-1111-4111-8111-111111111111';
const bolt = 'agent_22222222-2222-4222-8222-222222222222';
const dusk = 'agent_33333333-3333-4333-8333-333333333333';
const sprocket = 'agent_44444444-4444-4444-8444-444444444444';
const ember = 'agent_55555555-5555-4555-8555-555555555555';

function team(t, { busy = [], status = null } = {}) {
  const f = fixture(t);
  const space = path.join(f.home, 'space');
  const stateDir = stateDirectory({ env: f.env, home: f.home });
  mintAgentIdentity({ appSlug: 'qwts-luna', harness: 'claude', stateDir, useGithub: false, idFactory: () => luna });
  upsertSoul({ id: luna, name: 'luna', displayName: 'Luna', status: 'active', spacePath: space }, { file: f.file });
  upsertSoul({ id: bolt, name: 'bolt', displayName: 'Bolt', status: 'active', parentId: luna, spacePath: space }, { file: f.file });
  upsertSoul({ id: dusk, name: 'dusk', status: 'retired', parentId: luna, spacePath: space }, { file: f.file });
  upsertSoul({ id: sprocket, name: 'sprocket', displayName: 'Sprocket', status: 'active', parentId: bolt, spacePath: space }, { file: f.file });
  upsertSoul({ id: ember, name: 'ember', status: 'active', parentId: dusk, spacePath: space }, { file: f.file });
  const folders = {};
  for (const [agentId, name] of [[luna, 'Luna.soul'], [bolt, 'Bolt.soul']]) {
    const folder = path.join(f.env.AGENT_BOT_SOULS_HOME, name);
    mkdirSync(path.join(folder, '.soul-state'), { recursive: true });
    writeFileSync(path.join(folder, '.soul-state', 'agent-id'), `${agentId}\n`);
    registerSoulDir(agentId, folder, { file: f.file });
    folders[agentId] = folder;
  }
  f.options.status = status ?? (async () => ({ running: true, busy, warmPool: {} }));
  return { ...f, folders, stateDir };
}

const ids = (entries) => entries.map(({ agentId }) => agentId);

test('--plan for a standalone soul lists it alone and changes nothing', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.file, 'utf8');
  const plan = await soulRemoveCommand(['r8scout', '--plan', '--json'], f.options);
  assert.deepEqual(plan, {
    schemaVersion: 1, scope: 'soul', agentId: id, capabilities: { plan: true, team: true, independent: true, restore: false, delete: false },
    archived: [{ agentId: id, name: 'r8scout', displayName: 'R8Scout - Starter', status: 'active', harness: null, parentId: null, running: false, depth: 0 }],
    independent: [], unchanged: [],
  });
  assert.deepEqual(JSON.parse(f.out.join('')), plan);
  assert.deepEqual(f.gates, [], 'a plan asks nobody');
  assert.deepEqual(f.left, []);
  assert.equal(readFileSync(f.file, 'utf8'), before, 'the census is untouched');
  assert.ok(existsSync(f.folder));
  assert.equal(showSoul(id, { file: f.file }).status, 'active');
  assert.equal(REMOVE_CAPABILITIES.restore, false);
  assert.equal(REMOVE_CAPABILITIES.delete, false);
});

test('--plan for a lead walks nested, offline and retired-parent descendants, per scope', async (t) => {
  const f = team(t, { busy: [sprocket] });
  const before = readFileSync(f.file, 'utf8');
  const single = await soulRemoveCommand([luna, '--plan', '--json'], f.options);
  assert.deepEqual(single.archived, [{ agentId: luna, name: 'luna', displayName: 'Luna', status: 'active', harness: 'claude', parentId: null, running: false, depth: 0 }]);
  assert.deepEqual(single.independent, [{ agentId: bolt, name: 'bolt', displayName: 'Bolt', status: 'active', harness: null, parentId: luna, running: false, depth: 1 }]);
  assert.deepEqual(single.unchanged, [
    { agentId: dusk, name: 'dusk', displayName: 'dusk', status: 'retired', harness: null, parentId: luna, running: false, depth: 1 },
    { agentId: sprocket, name: 'sprocket', displayName: 'Sprocket', status: 'active', harness: null, parentId: bolt, running: true, depth: 2 },
    { agentId: ember, name: 'ember', displayName: 'ember', status: 'active', harness: null, parentId: dusk, running: false, depth: 2 },
  ]);
  const whole = await soulRemoveCommand([luna, '--plan', '--scope', 'team', '--json'], f.options);
  assert.equal(whole.scope, 'team');
  assert.deepEqual(ids(whole.archived), [luna, bolt, sprocket, ember], 'every active descendant, through the retired parent too');
  assert.deepEqual(whole.independent, []);
  assert.deepEqual(ids(whole.unchanged), [dusk]);
  assert.equal(whole.unchanged[0].status, 'retired');
  // The text form names everyone too.
  f.out.length = 0;
  await soulRemoveCommand(['Luna', '--plan', '--scope=team'], f.options);
  assert.match(f.out.join(''), /nothing changed[\s\S]*archived \(4\):[\s\S]*Sprocket \(sprocket\) agent_4.*running[\s\S]*unchanged \(1\):[\s\S]*dusk agent_3.*retired[\s\S]*restore: not supported; delete: not supported/);
  assert.deepEqual(f.gates, []);
  assert.deepEqual(f.left, []);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.ok(existsSync(f.folders[luna]) && existsSync(f.folders[bolt]));
  // A daemon that cannot be asked leaves `running` null, and the plan stands.
  const quiet = await removalPlan(luna, { scope: 'team', file: f.file, env: f.env, home: f.home, stateDir: f.stateDir, running: async () => null });
  assert.deepEqual(quiet.archived.map(({ running }) => running), [null, null, null, null]);
  assert.deepEqual(ids(quiet.archived), ids(whole.archived));
  await assert.rejects(soulRemoveCommand([luna, '--plan', '--scope', 'fleet'], f.options), /--scope must be one of soul, team/);
});

test('scope soul retires the lead and clears only its direct active children\'s parent', async (t) => {
  const f = team(t);
  const result = await soulRemoveCommand([luna, '--json'], f.options);
  assert.deepEqual(f.gates, [`soul remove ${luna}`]);
  assert.deepEqual(f.left, [{ agentId: luna }]);
  assert.equal(showSoul(luna, { file: f.file }).status, 'retired');
  assert.equal(showSoul(bolt, { file: f.file }).parentId, null, 'the direct child stands on its own');
  assert.equal(showSoul(bolt, { file: f.file }).status, 'active');
  assert.equal(showSoul(dusk, { file: f.file }).parentId, luna, 'a retired child is left as it is');
  assert.equal(showSoul(sprocket, { file: f.file }).parentId, bolt, 'a grandchild keeps its own parent');
  assert.equal(showSoul(ember, { file: f.file }).parentId, dusk);
  assert.ok(!existsSync(f.folders[luna]) && existsSync(f.folders[bolt]));
  assert.deepEqual(result.effects, { scope: 'soul', archived: [{ agentId: luna, name: 'Luna', handle: 'luna', wake: 'off', comms: 'left', retired: true, archived: result.archived }],
    independent: [{ agentId: bolt, name: 'bolt', displayName: 'Bolt', formerParentId: luna }], notArchived: [] });
  assert.deepEqual(ids(result.plan.independent), ids(result.effects.independent), 'declared scope equals effects');
  const receipts = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.filter(({ event }) => event === 'soul-reparent').map(({ agentId, decision, detail }) => ({ agentId, decision, detail })),
    [{ agentId: bolt, decision: 'independent', detail: `former parent ${luna}` }]);
  // Removing the retired lead again finds no team left to touch.
  const again = await soulRemoveCommand([luna, '--plan', '--json'], f.options);
  assert.deepEqual([ids(again.archived), again.independent, ids(again.unchanged)], [[luna], [], [dusk, ember]]);
});

test('scope team archives every active descendant deepest first, with the same steps per soul', async (t) => {
  const f = team(t);
  const result = await soulRemoveCommand([luna, '--scope', 'team'], f.options);
  assert.deepEqual(f.gates, [`soul remove ${luna} --scope team`], 'one owner gate for the whole team');
  assert.deepEqual(f.left.map(({ agentId }) => agentId), [sprocket, ember, bolt, luna], 'deepest first, the lead last');
  for (const agentId of [luna, bolt, sprocket, ember]) assert.equal(showSoul(agentId, { file: f.file }).status, 'retired', agentId);
  assert.equal(showSoul(dusk, { file: f.file }).parentId, luna, 'the retired child is unchanged');
  assert.equal(showSoul(sprocket, { file: f.file }).parentId, bolt, 'nothing becomes independent');
  assert.ok(!existsSync(f.folders[luna]) && !existsSync(f.folders[bolt]));
  assert.ok(existsSync(path.join(f.env.AGENT_BOT_SOULS_HOME, '.archive', '20261003T223000Z-Bolt.soul')));
  // Counts and names match effects: the plan is what ran.
  assert.deepEqual(ids(result.effects.archived), [sprocket, ember, bolt, luna]);
  assert.deepEqual([...ids(result.effects.archived)].sort(), [...ids(result.plan.archived)].sort());
  assert.equal(result.plan.archived.length, 4);
  assert.deepEqual(result.effects.independent, []);
  assert.deepEqual(result.effects.notArchived, []);
  assert.deepEqual(result.effects.archived.map(({ archived }) => archived.length), [0, 0, 1, 1]);
  // The lead's own fields come first, as for a single remove.
  assert.equal(result.agentId, luna);
  assert.equal(result.name, 'Luna');
  assert.equal(readColdWakeSettings({ env: f.env, home: f.home })[sprocket], undefined, 'no wake setting is invented');
  const receipts = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(receipts.filter(({ event }) => event === 'soul-remove').map(({ agentId, detail }) => ({ agentId, detail })), [
    { agentId: sprocket, detail: `with the team of ${luna}` }, { agentId: ember, detail: `with the team of ${luna}` },
    { agentId: bolt, detail: `with the team of ${luna}` }, { agentId: luna, detail: undefined },
  ]);
  assert.match(f.out.join(''), new RegExp(`^${sprocket} removed.*\\n${ember} removed.*\\n${bolt} removed.*Bolt.soul\\n${luna} removed.*Luna.soul\\n$`));
});

test('scope team is refused before anything changes while a descendant runs', async (t) => {
  const f = team(t, { busy: [sprocket] });
  const before = readFileSync(f.file, 'utf8');
  await assert.rejects(soulRemoveCommand([luna, '--scope', 'team'], f.options), (error) => {
    assert.equal(error.code, 'soul-running');
    assert.equal(error.message, `${sprocket} is running; stop it before removing ${luna}'s team`);
    return true;
  });
  assert.deepEqual(f.gates, []);
  assert.deepEqual(f.left, []);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.ok(existsSync(f.folders[luna]) && existsSync(f.folders[bolt]));
  // Scope soul does not archive the grandchild, so it is not in its way.
  const result = await soulRemoveCommand([luna, '--json'], f.options);
  assert.equal(result.retired, true);
});

test('a team remove that fails part way says which souls were archived and which were not', async (t) => {
  const f = team(t);
  const archive = (agentId, options) => {
    if (agentId === bolt) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return f.options.archive ? f.options.archive(agentId, options) : [];
  };
  await assert.rejects(soulRemoveCommand([luna, '--scope', 'team', '--json'], { ...f.options, archive }), (error) => {
    assert.equal(error.code, 'soul-archive-failed');
    assert.match(error.message, new RegExp(`^${bolt} is retired, but its folder could not be moved.*run soul remove again; archived so far: ${sprocket}, ${ember}; not archived: ${bolt}, ${luna}$`));
    assert.deepEqual(ids(error.effects.archived), [sprocket, ember]);
    assert.deepEqual(ids(error.effects.notArchived), [bolt, luna]);
    assert.equal(error.plan.scope, 'team');
    return true;
  });
  assert.equal(showSoul(bolt, { file: f.file }).status, 'retired', 'the retirement stands');
  assert.equal(showSoul(luna, { file: f.file }).status, 'active', 'the lead was not reached');
  assert.ok(existsSync(f.folders[luna]));
});

test('setSoulParent clears or sets a parent under the census lock', (t) => {
  const f = team(t);
  assert.equal(setSoulParent(bolt, null, { file: f.file }).parentId, null);
  assert.equal(showSoul(bolt, { file: f.file }).parentId, null);
  assert.equal(setSoulParent(bolt, luna, { file: f.file }).parentId, luna);
  assert.throws(() => setSoulParent(bolt, bolt, { file: f.file }), /its own parent/);
  assert.throws(() => setSoulParent('agent_99999999-9999-4999-8999-999999999999', null, { file: f.file }), /no population record/);
});
