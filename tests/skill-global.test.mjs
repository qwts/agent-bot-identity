import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditFile } from '../agent-principals.mjs';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { globalRecordPath, globalSkillTarget, loadGlobalSkill, unloadGlobalSkill } from '../skill-workspace.mjs';
import { main } from '../cli/soul-skill.mjs';

const put = (file, bytes, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); if (mode) chmodSync(file, mode); };
const skill = '---\nname: demo\ndescription: A global load fixture\n---\nAlways here.\n';
const REASON = 'every session on this host signs commits through it';

function fixture(t) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'skill-global-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const options = { home, env, stateDir: env.AGENT_BOT_STATE_HOME, file: env.AGENT_BOT_POPULATION_PATH, now: () => new Date('2026-10-10T01:02:03.004Z') };
  const soul = path.join(home, 'souls/example.soul');
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent' });
  put(path.join(soul, '.soul-state/agent-id'), `${id}\n`);
  upsertSoul({ id, name: 'example', status: 'active', soulDir: soul, spacePath: path.join(home, 'space'), roles: ['test'], harness: 'claude', app: 'test-agent' }, { file: options.file });
  put(path.join(soul, 'skills/demo/SKILL.md'), skill);
  put(path.join(soul, 'skills/demo/scripts/run'), '#!/bin/sh\nexit 0\n', 0o755);
  mkdirSync(path.join(home, '.claude'));
  const destination = path.join(home, '.claude/skills/demo');
  const gates = [], asks = [];
  const run = async (argv, { markers = [], approve = true, stdin = '{}', self = id, extraEnv = {}, gate = {} } = {}) => {
    const out = [], err = [];
    const code = await main(argv, { ...options, env: { ...env, ...extraEnv },
      markers: () => markers, readStdin: () => stdin,
      assertSoulTarget: target => { if (target !== self) throw new Error('a soul may load skills only for itself'); },
      ownerGate: async (action, input) => { gates.push({ action, principal: input.principal }); if (!approve) throw new Error('the owner said no'); return { method: 'presence' }; },
      askOwner: async action => { asks.push(action); if (!approve) throw new Error('the owner said no'); return { method: 'presence' }; },
      ...gate, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
    const text = out.join('');
    return { code, err: err.join(''), json: text ? JSON.parse(text) : null };
  };
  const receipts = () => { try { return readFileSync(auditFile({ env, home }), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.event === 'skill-global'); } catch { return []; } };
  return { home, env, soul, id, destination, gates, asks, run, receipts };
}

test('the owner loads a skill globally after the gate, with the reason recorded, and unloads it', async t => {
  const f = fixture(t);
  const loaded = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json']);
  assert.equal(loaded.code, 0, loaded.err);
  assert.equal(f.gates.length, 1);
  assert.match(f.gates[0].action, new RegExp(`soul skill load demo --soul ${f.id} --global .* because: ${REASON}`));
  assert.deepEqual(f.asks, []);
  assert.deepEqual({ ...loaded.json, notCaptured: undefined }, { name: 'demo', harness: 'claude', global: true, destination: f.destination, files: 2, reason: REASON, authorization: 'presence', notCaptured: undefined });
  assert.equal(readFileSync(path.join(f.destination, 'SKILL.md'), 'utf8'), skill);
  assert.ok(lstatSync(path.join(f.destination, 'scripts/run')).mode & 0o100, 'executable bit kept');
  const record = JSON.parse(readFileSync(globalRecordPath('claude', 'demo', { env: f.env, home: f.home }), 'utf8'));
  assert.equal(record.reason, REASON);
  assert.equal(record.agentId, f.id);
  assert.ok(!record.destination.startsWith(f.soul) && !globalRecordPath('claude', 'demo', { env: f.env, home: f.home }).startsWith(f.soul), 'the record is the owner\'s, outside the soul');
  assert.equal(record.destination, f.destination);
  assert.deepEqual(Object.keys(record.files).sort(), ['SKILL.md', 'scripts/run']);
  assert.deepEqual(f.receipts().map(r => [r.operation, r.agentId]), [['load', f.id]]);

  const unloaded = await f.run(['unload', 'demo', '--soul', f.id, '--global', '--json']);
  assert.equal(unloaded.code, 0, unloaded.err);
  assert.equal(unloaded.json.removed, true);
  assert.equal(existsSync(f.destination), false);
  assert.equal(existsSync(globalRecordPath('claude', 'demo', { env: f.env, home: f.home })), false);
  assert.equal(f.gates.length, 2, 'the owner approves the unload too');
  assert.match(f.gates[1].action, new RegExp(`soul skill unload demo --soul ${f.id} --global \\(removes ${f.destination}\\)`));
  assert.deepEqual(f.receipts().map(r => r.operation), ['load', 'unload']);
});

test('a refused owner gate writes nothing', async t => {
  const f = fixture(t);
  const result = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'], { approve: false });
  assert.equal(result.code, 1);
  assert.equal(result.json.error.code, 'skill-global-owner-not-approved');
  assert.equal(existsSync(path.join(f.home, '.claude/skills')), false);
  assert.equal(existsSync(globalRecordPath('claude', 'demo', { env: f.env, home: f.home })), false);
  assert.deepEqual(f.receipts(), []);
});

test('a soul asking for itself still needs the owner, and cannot present the principal or target another soul', async t => {
  const f = fixture(t);
  const soul = { markers: ['Agent ID'] };
  const own = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'], soul);
  assert.equal(own.code, 0, own.err);
  assert.equal(f.asks.length, 1, 'the owner was asked');
  assert.equal(f.gates.length, 0);
  assert.equal((await f.run(['unload', 'demo', '--soul', f.id, '--global', '--json'], soul)).code, 0);
  assert.equal(f.asks.length, 2, 'a soul\'s unload asks the owner too');
  assert.match(f.asks[1], /soul skill unload demo .* --global \(removes /);

  const refused = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'], { ...soul, approve: false });
  assert.equal(f.asks.length, 3);
  assert.equal(refused.json.error.code, 'skill-global-owner-not-approved');
  assert.equal(existsSync(f.destination), false);

  const principal = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--principal-stdin', '--json'], soul);
  assert.equal(principal.json.error.code, 'skill-global-principal-not-accepted');
  const other = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'], { ...soul, self: 'agent_00000000-0000-4000-8000-000000000000' });
  assert.equal(other.code, 1);
  assert.equal(f.asks.length, 3, 'no prompt for a refused request');
});

test('global load refuses before asking: no reason, an unsupported harness, or something already there', async t => {
  const f = fixture(t);
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--json'])).json.error.code, 'skill-global-reason-required');
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', 'two\u0007lines', '--json'])).json.error.code, 'skill-global-reason-invalid');
  for (const harness of ['gemini', 'codex']) {
    assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--harness', harness, '--json'])).json.error.code, 'skill-global-unsupported');
  }
  put(path.join(f.destination, 'SKILL.md'), 'the owner\'s own skill\n');
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'])).json.error.code, 'skill-load-exists');
  assert.equal(readFileSync(path.join(f.destination, 'SKILL.md'), 'utf8'), 'the owner\'s own skill\n');
  assert.equal((await f.run(['unload', 'demo', '--soul', f.id, '--global', '--json'])).json.error.code, 'skill-not-loaded');
  assert.equal(existsSync(f.destination), true, 'a folder this soul did not place stays');
  assert.equal(f.gates.length, 0);
  // --global takes no --workspace, and only load takes --reason.
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--workspace', 'repo'])).code, 2);
  assert.equal((await f.run(['unload', 'demo', '--soul', f.id, '--global', '--reason', REASON])).code, 2);
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--workspace', 'repo', '--reason', REASON])).code, 2);
});

test('global unload keeps a copy that was changed', async t => {
  const f = fixture(t);
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON])).code, 0);
  chmodSync(path.join(f.destination, 'scripts/run'), 0o644);
  const result = await f.run(['unload', 'demo', '--soul', f.id, '--global', '--json']);
  assert.equal(result.json.error.code, 'skill-load-modified');
  assert.equal(existsSync(f.destination), true);
  assert.equal(existsSync(globalRecordPath('claude', 'demo', { env: f.env, home: f.home })), true);
});

test('the Claude target follows an absolute CLAUDE_CONFIG_DIR and refuses unsafe or missing folders', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'claude-config');
  mkdirSync(config);
  assert.equal(globalSkillTarget('demo', 'claude', { env: { CLAUDE_CONFIG_DIR: config }, home: f.home }).destination, path.join(config, 'skills/demo'));
  assert.throws(() => globalSkillTarget('demo', 'claude', { env: { CLAUDE_CONFIG_DIR: 'relative' }, home: f.home }), { code: 'skill-global-config-invalid' });
  assert.throws(() => globalSkillTarget('demo', 'claude', { env: { CLAUDE_CONFIG_DIR: path.join(f.home, 'absent') }, home: f.home }), { code: 'skill-global-harness-missing' });
  // A linked config folder (dotfiles) is followed; a linked skills folder is not.
  const linked = path.join(f.home, 'linked-config');
  symlinkSync(config, linked);
  assert.equal(globalSkillTarget('demo', 'claude', { env: { CLAUDE_CONFIG_DIR: linked }, home: f.home }).destination, path.join(config, 'skills/demo'));
  symlinkSync(path.join(f.home, 'elsewhere'), path.join(config, 'skills'));
  assert.throws(() => globalSkillTarget('demo', 'claude', { env: { CLAUDE_CONFIG_DIR: config }, home: f.home }), { code: 'skill-path-unsafe' });
  const loaded = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'], { extraEnv: { CLAUDE_CONFIG_DIR: config } });
  assert.equal(loaded.json.error.code, 'skill-path-unsafe');
  assert.equal(f.gates.length, 0);
});

test('global unload removes nothing without the owner\'s record for this soul, whatever the soul writes', async t => {
  const f = fixture(t);
  // The owner's hand-placed skill, and a record forged in the soul's own state.
  const owned = path.join(f.home, '.claude/skills/owners-skill');
  put(path.join(owned, 'SKILL.md'), 'owner wrote this\n');
  const bytes = readFileSync(path.join(owned, 'SKILL.md'));
  const forged = { schemaVersion: 1, name: 'owners-skill', harness: 'claude', agentId: f.id, destination: owned, reason: 'x',
    files: { 'SKILL.md': { mode: '100644', size: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } } };
  put(path.join(f.soul, '.soul-state/skill-globals/claude/owners-skill.json'), JSON.stringify(forged));
  const result = await f.run(['unload', 'owners-skill', '--soul', f.id, '--global', '--json'], { markers: ['AGENT_BOT_ID'] });
  assert.equal(result.json.error.code, 'skill-not-loaded');
  assert.equal(readFileSync(path.join(owned, 'SKILL.md'), 'utf8'), 'owner wrote this\n');

  // Another soul's global load is not this soul's to unload.
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON])).code, 0);
  const record = globalRecordPath('claude', 'demo', { env: f.env, home: f.home });
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), agentId: 'agent_00000000-0000-4000-8000-000000000000' }));
  assert.equal((await f.run(['unload', 'demo', '--soul', f.id, '--global', '--json'])).json.error.code, 'skill-not-loaded');
  assert.equal(existsSync(f.destination), true);
  assert.deepEqual(f.receipts().map(r => r.operation), ['load']);
});

test('a soul\'s own global load asks through keyd only: no signed challenge, no administrator dialog', async t => {
  const f = fixture(t);
  const asked = [];
  const unavailable = async summary => { asked.push(summary); throw Object.assign(new Error('keyd is not running'), { code: 'presence-unavailable' }); };
  const result = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'],
    { markers: ['AGENT_BOT_ID'], gate: { askOwner: undefined, presence: unavailable } });
  assert.equal(asked.length, 1, 'keyd was asked');
  assert.equal(result.json.error.code, 'skill-global-owner-not-approved');
  assert.match(result.json.error.message, /no administrator-dialog fallback/);
  assert.equal(existsSync(f.destination), false);
  const approved = await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON, '--json'],
    { markers: ['AGENT_BOT_ID'], gate: { askOwner: undefined, presence: async () => ({ method: 'presence' }) } });
  assert.equal(approved.code, 0, approved.err);
});

// A soul shares the owner's account: it can relocate the owner's state through
// the environment, or write the owner-side record itself. Either way its
// unload reaches the owner first, and a refusal deletes nothing.
test('a soul\'s global unload needs the owner even with a record it forged', async t => {
  const f = fixture(t);
  const owned = path.join(f.home, '.claude/skills/owners-skill');
  put(path.join(owned, 'SKILL.md'), 'owner wrote this\n');
  const bytes = readFileSync(path.join(owned, 'SKILL.md'));
  const forge = file => put(file, JSON.stringify({ schemaVersion: 1, name: 'owners-skill', harness: 'claude', agentId: f.id, destination: owned, reason: 'x',
    files: { 'SKILL.md': { mode: '100644', size: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } } }));
  const soul = { markers: ['AGENT_BOT_ID'], approve: false };

  // The environment points the owner's state at a folder the soul owns: ignored.
  const mine = path.join(f.home, 'soul-tmp');
  forge(path.join(mine, 'skill-globals/claude/owners-skill.json'));
  const steered = await f.run(['unload', 'owners-skill', '--soul', f.id, '--global', '--json'], { ...soul, extraEnv: { AGENT_BOT_INTERACTION_HOME: mine, XDG_STATE_HOME: mine } });
  assert.equal(steered.json.error.code, 'skill-not-loaded');
  assert.equal(existsSync(owned), true);

  // The record written straight into the owner's state: the owner is asked, says no.
  forge(globalRecordPath('claude', 'owners-skill', { env: f.env, home: f.home }));
  const direct = await f.run(['unload', 'owners-skill', '--soul', f.id, '--global', '--json'], soul);
  assert.equal(direct.json.error.code, 'skill-global-owner-not-approved');
  assert.equal(f.asks.length, 1, 'the owner was asked');
  assert.equal(readFileSync(path.join(owned, 'SKILL.md'), 'utf8'), 'owner wrote this\n');
  assert.equal(existsSync(globalRecordPath('claude', 'owners-skill', { env: f.env, home: f.home })), true);
  assert.deepEqual(f.receipts().map(r => [r.operation, r.decision]), [['unload', 'refused']]);
});

test('an unload that looks like the owner\'s still needs the owner: a no keeps the skill and is receipted', async t => {
  const f = fixture(t);
  // A soul writes a record naming itself into the owner's state, clears its
  // markers and runs unload from a neutral folder.
  const owned = path.join(f.home, '.claude/skills/owners-skill');
  put(path.join(owned, 'SKILL.md'), 'owner wrote this\n');
  const bytes = readFileSync(path.join(owned, 'SKILL.md'));
  const record = globalRecordPath('claude', 'owners-skill', { env: f.env, home: f.home });
  put(record, JSON.stringify({ schemaVersion: 1, name: 'owners-skill', harness: 'claude', agentId: f.id, destination: owned, reason: 'x',
    files: { 'SKILL.md': { mode: '100644', size: bytes.length, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } } }));
  const result = await f.run(['unload', 'owners-skill', '--soul', f.id, '--global', '--json'], { markers: [], approve: false });
  assert.equal(result.code, 1);
  assert.equal(result.json.error.code, 'skill-global-owner-not-approved');
  assert.equal(f.gates.length, 1, 'the owner was asked');
  assert.match(f.gates[0].action, /removes .*owners-skill/);
  assert.equal(readFileSync(path.join(owned, 'SKILL.md'), 'utf8'), 'owner wrote this\n');
  assert.equal(existsSync(record), true);
  assert.deepEqual(f.receipts().map(r => [r.operation, r.decision]), [['unload', 'refused']]);
});

test('global unload needs the owner gate from every caller of the library', async t => {
  const f = fixture(t);
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON])).code, 0);
  for (const authorize of [undefined, null, 'yes']) {
    await assert.rejects(unloadGlobalSkill('demo', f.id, { env: f.env, home: f.home, file: f.env.AGENT_BOT_POPULATION_PATH, authorize }), { code: 'skill-global-owner-required' });
  }
  assert.equal(existsSync(f.destination), true);
  assert.deepEqual(f.receipts().map(r => r.operation), ['load']);
});

test('global records and receipts ignore relocated state for the owner too', async t => {
  const f = fixture(t);
  const elsewhere = path.join(f.home, 'elsewhere');
  const extraEnv = { AGENT_BOT_INTERACTION_HOME: elsewhere, XDG_STATE_HOME: elsewhere };
  assert.equal((await f.run(['load', 'demo', '--soul', f.id, '--global', '--reason', REASON], { extraEnv })).code, 0);
  assert.equal(existsSync(globalRecordPath('claude', 'demo', { env: f.env, home: f.home })), true, 'the record is in the owner\'s state');
  assert.equal(existsSync(elsewhere), false, 'nothing went to the relocated folder');
  // A record forged in the relocated folder is never read, so an owner's unload of it finds nothing.
  const owned = path.join(f.home, '.claude/skills/owners-skill');
  put(path.join(owned, 'SKILL.md'), 'owner wrote this\n');
  put(path.join(elsewhere, 'skill-globals/claude/owners-skill.json'), JSON.stringify({ name: 'owners-skill', harness: 'claude', agentId: f.id, destination: owned, files: {} }));
  const forged = await f.run(['unload', 'owners-skill', '--soul', f.id, '--global', '--json'], { extraEnv });
  assert.equal(forged.json.error.code, 'skill-not-loaded');
  assert.equal(existsSync(owned), true);
  assert.equal((await f.run(['unload', 'demo', '--soul', f.id, '--global'], { extraEnv })).code, 0);
  assert.deepEqual(f.receipts().map(r => r.operation), ['load', 'unload']);
  // The library applies it too, not only the CLI.
  await loadGlobalSkill('demo', f.id, { env: { ...f.env, ...extraEnv }, home: f.home, file: f.env.AGENT_BOT_POPULATION_PATH, reason: REASON, authorize: async () => ({ method: 'presence' }) });
  assert.equal(existsSync(globalRecordPath('claude', 'demo', { env: f.env, home: f.home })), true);
  assert.equal(existsSync(path.join(elsewhere, 'skill-globals/claude/demo.json')), false);
});
