import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { ENV_CAPABILITIES, readSoulEnvironment } from '../soul-env.mjs';
import { HISTORY_SCHEMA_VERSION, formatHistory, soulEnvHistoryCommand } from '../soul-env-history.mjs';
import { HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX, HISTORY_READ_MAX_BYTES, appendSoulRevision, appendSoulTurn, readSoulHistory, revisionRecord, turnRecord } from '../soul-history.mjs';
import { PACKAGE_IGNORE_LIST, computePackageRevision } from '../soul-package.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const SECRET = 'NEVER-PRINT-THIS-PROMPT';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const state = (dir) => path.join(dir, '.soul-state');
const runs = (dir) => path.join(state(dir), 'runs');

// Three turns and two revisions as the daemon mirrors them, oldest first
// on disk (the mirror only appends), so newest first is the reverse.
const TURNS = Object.freeze([
  { id: 'turn-1', kind: 'wake', startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:01:00.000Z', harness: 'codex', outcome: 'ok' },
  { id: 'turn-2', kind: 'task', startedAt: '2026-10-02T10:00:00.000Z', endedAt: '2026-10-02T10:05:00.000Z', harness: 'claude', outcome: 'failed' },
  { id: 'turn-3', kind: 'session', startedAt: '2026-10-03T10:00:00.000Z', endedAt: null, harness: 'claude', outcome: null },
]);
const REVISIONS = Object.freeze([
  { id: 'sha256:aaaa', parent: null, reason: 'genesis', at: '2026-10-01T09:00:00.000Z' },
  { id: 'sha256:bbbb', parent: 'sha256:aaaa', reason: 'edited AGENTS.md', at: '2026-10-02T09:00:00.000Z' },
]);

// One soul under a scratch HOME with a mirrored life. Nothing here touches
// the real HOME, a keychain or login items.
function fixture(t, { mirror = true } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-env-history-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const file = env.AGENT_BOT_POPULATION_PATH;
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy.soul');
  mintAgentIdentity({ stateDir: stateDirectory({ env, home }), idFactory: () => ID, harness: 'codex', appSlug: null, useGithub: false });
  // The space inside the soul, as every soul spawned since #583 slice 5 has it.
  mkdirSync(path.join(state(dir), 'space'), { recursive: true });
  upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: path.join(state(dir), 'space'), status: 'active', parentId: null, appSlug: null }, { file });
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'History tests', displaySeed: 'billy', preferredHarnesses: ['codex'],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  put(path.join(dir, 'AGENTS.md'), `# Billy\n${SECRET}\n`);
  manifest.revision = computePackageRevision(dir);
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  put(path.join(state(dir), 'agent-id'), `${ID}\n`);
  if (mirror) {
    // Through the writer the daemon uses, so the fixture is what a life leaves.
    for (const turn of TURNS) appendSoulTurn(dir, turn);
    for (const revision of REVISIONS) appendSoulRevision(dir, { revision: revision.id, parentRevision: revision.parent, reason: revision.reason, at: revision.at });
  }
  const options = { env, home, cwd: home, file, config: {} };
  return { home, env, dir, file, options };
}

const newestFirst = (rows) => [...rows].reverse();

test('readSoulHistory lists the mirror newest first, shaped, with totals and the limit', (t) => {
  const f = fixture(t);
  const result = readSoulHistory(f.dir);
  assert.deepEqual([result.mirror, result.mirrored], [runs(f.dir), true]);
  assert.deepEqual(result.turns, { total: 3, listed: 3, limit: HISTORY_LIMIT_DEFAULT, skipped: 0, truncated: false, records: newestFirst(TURNS).map(turnRecord) });
  assert.deepEqual(result.revisions, { total: 2, listed: 2, limit: HISTORY_LIMIT_DEFAULT, skipped: 0, truncated: false,
    records: newestFirst(REVISIONS).map((row) => revisionRecord({ revision: row.id, parentRevision: row.parent, reason: row.reason, at: row.at })) });
  // The documented shape exactly, every key present.
  assert.deepEqual(Object.keys(result.turns.records[0]), ['id', 'kind', 'startedAt', 'endedAt', 'harness', 'outcome']);
  assert.deepEqual(Object.keys(result.revisions.records[0]), ['id', 'parent', 'reason', 'at']);
  // A limit lists the newest `limit` and still reports the whole count.
  const two = readSoulHistory(f.dir, { limit: 2 });
  assert.deepEqual([two.turns.total, two.turns.listed, two.turns.limit, two.turns.records.map((row) => row.id)], [3, 2, 2, ['turn-3', 'turn-2']]);
  assert.deepEqual([two.revisions.total, two.revisions.listed, two.revisions.records.map((row) => row.id)], [2, 2, ['sha256:bbbb', 'sha256:aaaa']]);
  // Out-of-range limits fall back to the default or the maximum rather than throw.
  assert.equal(readSoulHistory(f.dir, { limit: 0 }).turns.limit, HISTORY_LIMIT_DEFAULT);
  assert.equal(readSoulHistory(f.dir, { limit: 10 ** 6 }).turns.limit, HISTORY_LIMIT_MAX);
  assert.deepEqual([HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX, HISTORY_READ_MAX_BYTES], [50, 500, 16 * 1024 * 1024]);
});

test('a line that is not a JSON object is skipped and counted; an unknown kind or extra key is shaped, never passed through', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(runs(f.dir), 'turns.jsonl'), [JSON.stringify(TURNS[0]), 'not json', '[1,2]', '42', '',
    JSON.stringify({ id: 'turn-x', kind: 'mystery', startedAt: '2026-10-04T10:00:00.000Z', prompt: SECRET, outcome: 'weird' }), ''].join('\n'));
  const result = readSoulHistory(f.dir);
  // Four non-empty lines held something, three of them no record; the blank lines are nothing.
  assert.deepEqual([result.turns.total, result.turns.listed, result.turns.skipped, result.turns.truncated], [6, 2, 3, false]);
  assert.deepEqual(result.turns.records, [
    { id: 'turn-x', kind: 'turn', startedAt: '2026-10-04T10:00:00.000Z', endedAt: null, harness: null, outcome: null },
    turnRecord(TURNS[0]),
  ]);
  assert.ok(!JSON.stringify(result).includes(SECRET), 'a stray field never reaches the listing');
  // The other file is untouched by one file's trouble.
  assert.deepEqual([result.revisions.total, result.revisions.listed, result.revisions.skipped], [2, 2, 0]);
});

test('a mirror file past the window yields its tail, the first partial line dropped, with the whole count', (t) => {
  const f = fixture(t);
  // Enough lines that the file passes the window; each line is distinct so the tail is checkable.
  const line = (i) => JSON.stringify({ id: `turn-${String(i).padStart(7, '0')}`, kind: 'turn', startedAt: null, endedAt: null, harness: 'x'.repeat(40), outcome: 'ok' });
  const bytesPerLine = Buffer.byteLength(`${line(0)}\n`);
  const count = Math.ceil(HISTORY_READ_MAX_BYTES / bytesPerLine) + 10;
  const chunks = [];
  for (let i = 0; i < count; i += 1) chunks.push(`${line(i)}\n`);
  writeFileSync(path.join(runs(f.dir), 'turns.jsonl'), chunks.join(''));
  const result = readSoulHistory(f.dir, { limit: 3 });
  assert.deepEqual([result.turns.total, result.turns.listed, result.turns.truncated, result.turns.skipped], [count, 3, true, 0]);
  assert.deepEqual(result.turns.records.map((row) => row.id), [count - 1, count - 2, count - 3].map((i) => `turn-${String(i).padStart(7, '0')}`));
});

test('no mirror directory, a link in its place, or an unreadable file: mirrored false or null totals, never a throw', (t) => {
  const bare = fixture(t, { mirror: false });
  const none = readSoulHistory(bare.dir);
  assert.deepEqual(none, { mirror: runs(bare.dir), mirrored: false,
    turns: { total: null, listed: 0, limit: HISTORY_LIMIT_DEFAULT, skipped: 0, truncated: false, records: [] },
    revisions: { total: null, listed: 0, limit: HISTORY_LIMIT_DEFAULT, skipped: 0, truncated: false, records: [] } });
  // A mirror with turns only: revisions absent is zero lines, not unknown.
  const partial = fixture(t, { mirror: false });
  appendSoulTurn(partial.dir, TURNS[0]);
  const only = readSoulHistory(partial.dir);
  assert.deepEqual([only.mirrored, only.turns.total, only.revisions.total, only.revisions.listed], [true, 1, 0, 0]);
  // A link where a file should be is never followed: unknown, nothing listed.
  const linked = fixture(t, { mirror: false });
  mkdirSync(runs(linked.dir), { recursive: true });
  put(path.join(linked.home, 'elsewhere.jsonl'), `${JSON.stringify(TURNS[0])}\n`);
  symlinkSync(path.join(linked.home, 'elsewhere.jsonl'), path.join(runs(linked.dir), 'turns.jsonl'));
  const viaLink = readSoulHistory(linked.dir);
  assert.deepEqual([viaLink.mirrored, viaLink.turns.total, viaLink.turns.listed], [true, null, 0]);
});

test('soul env history prints the schema by id or name, honours --limit, refuses bad limits and unknown souls', (t) => {
  const f = fixture(t);
  let out = '';
  const result = soulEnvHistoryCommand([ID, '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'agentId', 'soulDir', 'mirror', 'mirrored', 'turns', 'revisions']);
  assert.deepEqual([result.schemaVersion, result.agentId, result.soulDir, result.mirror, result.mirrored], [HISTORY_SCHEMA_VERSION, ID, f.dir, runs(f.dir), true]);
  assert.deepEqual(result.turns.records.map((row) => row.id), ['turn-3', 'turn-2', 'turn-1']);
  assert.ok(!out.includes(SECRET), 'nothing of the definition is read');
  const byName = soulEnvHistoryCommand(['Billy', '--limit', '2', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([byName.agentId, byName.turns.listed, byName.turns.total, byName.turns.limit, byName.revisions.listed], [ID, 2, 3, 2, 2]);
  assert.equal(soulEnvHistoryCommand(['billy', '--limit', '500'], { ...f.options, write: () => {} }).turns.limit, 500);
  for (const args of [[], ['--json'], [ID, '--limit'], [ID, '--limit', '0'], [ID, '--limit', '501'], [ID, '--limit', 'abc'], [ID, '--limit', '-1'], [ID, '--limit', '1', '--limit', '2'], [ID, '--plan'], [ID, 'other']]) {
    assert.throws(() => soulEnvHistoryCommand(args, { ...f.options, write: () => {} }), /usage: agent-bot soul env history <agentId\|name> \[--json\] \[--limit N\]/, JSON.stringify(args));
  }
  assert.throws(() => soulEnvHistoryCommand(['nobody'], { ...f.options, write: () => {} }), (error) => error.code === 'soul-not-found');
  assert.throws(() => soulEnvHistoryCommand(['agent_00000000-0000-4000-8000-000000000000'], { ...f.options, write: () => {} }), (error) => error.code === 'soul-not-found');
  // A soul whose life has not started lists nothing rather than failing.
  const bare = fixture(t, { mirror: false });
  const none = soulEnvHistoryCommand([ID, '--json'], { ...bare.options, write: () => {} });
  assert.deepEqual([none.mirrored, none.turns.total, none.turns.records, none.revisions.total], [false, null, [], null]);
});

test('the human output is one line per record, newest first, and strips control characters', (t) => {
  const f = fixture(t);
  let out = '';
  soulEnvHistoryCommand(['billy', '--limit', '2'], { ...f.options, write: (value) => { out += value; } });
  assert.equal(out, [
    `agentId: ${ID}`, `soulDir: ${f.dir}`, `mirror: ${runs(f.dir)}`,
    'turns: 2 of 3',
    '2026-10-03T10:00:00.000Z  session  claude  -  turn-3',
    '2026-10-02T10:00:00.000Z  task  claude  failed  turn-2',
    'revisions: 2 of 2',
    '2026-10-02T09:00:00.000Z  sha256:bbbb  (sha256:aaaa)  edited AGENTS.md',
    '2026-10-01T09:00:00.000Z  sha256:aaaa  (-)  genesis',
    '',
  ].join('\n'));
  const bare = fixture(t, { mirror: false });
  let empty = '';
  soulEnvHistoryCommand([ID], { ...bare.options, write: (value) => { empty += value; } });
  assert.equal(empty, [`agentId: ${ID}`, `soulDir: ${bare.dir}`, `mirror: ${runs(bare.dir)}`, 'turns: 0 of -', 'revisions: 0 of -', ''].join('\n'));
  // A time is not stripped by the record shaper; the formatter never lets a control character through.
  const text = formatHistory({ agentId: ID, soulDir: f.dir, mirror: runs(f.dir), turns: { total: 1, listed: 1, records: [{ ...turnRecord(TURNS[0]), startedAt: 'x\u001b[31m\ny' }] }, revisions: { total: 0, listed: 0, records: [] } });
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(text.replaceAll('\n', '')), text);
});

test('the capability env-history is listed by soul env, and the CLI routes the verb with coded errors and help', (t) => {
  const f = fixture(t);
  assert.equal(ENV_CAPABILITIES.at(-1), 'env-history');
  assert.ok(readSoulEnvironment(ID, f.options).engine.capabilities.includes('env-history'));
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', ...args], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  const env = run('billy', '--json');
  assert.equal(env.status, 0, env.stderr);
  assert.ok(JSON.parse(env.stdout).engine.capabilities.includes('env-history'));
  const listed = run('history', 'billy', '--limit', '1', '--json');
  assert.equal(listed.status, 0, listed.stderr);
  const parsed = JSON.parse(listed.stdout);
  assert.deepEqual([parsed.schemaVersion, parsed.agentId, parsed.turns.listed, parsed.turns.total, parsed.turns.records[0].id, parsed.revisions.records[0].id], [1, ID, 1, 3, 'turn-3', 'sha256:bbbb']);
  const unknown = run('history', 'nobody', '--json');
  assert.equal(unknown.status, 1);
  assert.deepEqual(JSON.parse(unknown.stdout), { error: { code: 'soul-not-found', message: 'Soul not found.', action: null } });
  const usage = run('history', 'billy', '--limit', '0');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: agent-bot soul env history/);
  const help = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /agent-bot soul env history <agentId\|name> \[--json\] \[--limit N\]/);
  assert.match(help.stdout, /soul env history lists the soul's history mirror/);
  const top = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.match(top.stdout, /env history <agentId\|name> \[--json\] \[--limit N\]/);
});
