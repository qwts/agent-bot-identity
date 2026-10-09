import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { showSoul, upsertSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { initAgentSpace, initSoulSpace, inspectAgentSpace, spacePath } from '../agent-space.mjs';
import { recordSoulSession } from '../metrics.mjs';
import { readSoulEnvironment } from '../soul-env.mjs';
import { soulEnvMigrateCommand } from '../soul-env-migrate.mjs';
import { appendSoulTurn, createSoulHistory, registeredSoulDir, revisionRecord, turnRecord } from '../soul-history.mjs';
import { ensureSoulDirectory } from '../soul-home.mjs';
import { SPACE_STEP_ID, copySpaceTree, ensureSoulSpace, inspectSoulSpace, migrateSpaceIntoSoul, soulSpacePath, spaceMigrateCommand, verifySpaceTree } from '../soul-memory.mjs';
import { readMigrationJournal, readMigrationStep, recordMigrationStep } from '../soul-migration-journal.mjs';
import { PACKAGE_IGNORE_LIST, computePackageRevision } from '../soul-package.mjs';
import { adoptSoulPackage, promoteSpaceContent } from '../soul-revisions.mjs';
import { createTurnRegistry } from '../wake-plane.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const OTHER = 'agent_12345678-1234-4234-8234-123456789def';
const SECRET = 'NEVER-RETURN-THIS-SPACE-CONTENT';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'agent-space.mjs');
const NOW = new Date('2026-10-07T10:00:00Z');
const OLD = new Date('2026-01-02T03:04:05Z');
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const state = (dir) => path.join(dir, '.soul-state');
const lines = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const turns = (dir) => lines(path.join(state(dir), 'runs', 'turns.jsonl'));
const component = (result, id) => result.components.find((entry) => entry.id === id);
const revisions = (dir) => lines(path.join(state(dir), 'runs', 'revisions.jsonl'));

// One soul with its Agent Space outside the folder, as every soul spawned
// before #583 slice 5 has it: a marked space under the spaces root, the
// census naming it, `.soul-state/space` a link to it. The space holds a
// nested file, an executable, a symlink and old mtimes so the copy has
// something to preserve, and a secret so the tests can prove nothing of
// its contents leaks into output, journal or receipts.
function fixture(t, { external = true, link = true, running = false } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-memory-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const file = env.AGENT_BOT_POPULATION_PATH;
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy.soul');
  mintAgentIdentity({ stateDir: stateDirectory({ env, home }), idFactory: () => ID, harness: 'codex', appSlug: null, useGithub: false });
  let space = spacePath(ID, { env, home });
  if (external) {
    space = initAgentSpace(ID, { env, home }).path;
    put(path.join(space, 'notes', 'today.md'), `# Today\n${SECRET}\n`);
    put(path.join(space, 'bin', 'run'), '#!/bin/sh\necho hi\n');
    chmodSync(path.join(space, 'bin', 'run'), 0o755);
    symlinkSync('notes/today.md', path.join(space, 'latest'));
    for (const relative of ['notes/today.md', 'bin/run', 'notes', 'bin']) utimesSync(path.join(space, relative), OLD, OLD);
  }
  upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: space, status: 'active', parentId: null, appSlug: null }, { file });
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'Memory tests', displaySeed: 'billy', preferredHarnesses: ['codex'],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  put(path.join(dir, 'AGENTS.md'), '# Billy\n');
  manifest.revision = computePackageRevision(dir);
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  put(path.join(state(dir), 'agent-id'), `${ID}\n`);
  if (external && link) symlinkSync(space, path.join(state(dir), 'space'), 'dir');
  const gates = [];
  const logs = [];
  const options = { env, home, cwd: home, file, config: {}, now: () => NOW,
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; },
    running: async () => running };
  return { home, env, dir, file, space, target: path.join(state(dir), 'space'), options, gates, logs,
    stateDir: stateDirectory({ env, home }),
    receipts: () => lines(auditFile({ env, home })),
    journalText: () => { try { return readFileSync(path.join(state(dir), 'migration.json'), 'utf8'); } catch { return ''; } },
    staging: () => readdirSync(state(dir)).filter((name) => name.startsWith('space.migrating-') || name.startsWith('space.link-')) };
}

// The copy must be the source: same files, bytes, modes, mtimes and links.
function assertSameTree(source, copy) {
  const check = verifySpaceTree(source, copy);
  assert.equal(check.ok, true, check.reason);
  for (const relative of ['notes/today.md', 'bin/run']) {
    assert.equal(readFileSync(path.join(copy, relative), 'utf8'), readFileSync(path.join(source, relative), 'utf8'));
    assert.equal(statSync(path.join(copy, relative)).mode & 0o777, statSync(path.join(source, relative)).mode & 0o777);
    assert.equal(statSync(path.join(copy, relative)).mtimeMs, OLD.getTime());
  }
  assert.equal(lstatSync(path.join(copy, 'latest')).isSymbolicLink(), true);
  assert.equal(readlinkSync(path.join(copy, 'latest')), 'notes/today.md');
  assert.equal(statSync(path.join(copy, 'notes')).mtimeMs, OLD.getTime());
}

test('soul env migrate --space-into-soul copies, verifies, switches, updates the census and retires the source', async (t) => {
  const f = fixture(t);
  let out = '';
  const result = await soulEnvMigrateCommand([ID, '--space-into-soul', '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'agentId', 'soulDir', 'operation', 'decision', 'steps', 'root']);
  assert.deepEqual([result.schemaVersion, result.agentId, result.soulDir, result.operation, result.decision, result.root], [1, ID, f.dir, SPACE_STEP_ID, 'migrated', f.target]);
  const [step] = result.steps;
  const retired = `${f.space}.retired-2026-10-07`;
  assert.deepEqual([step.id, step.status, step.from, step.to, step.source, step.retired, step.staging, step.aside], [SPACE_STEP_ID, 'done', f.space, f.target, f.space, retired, null, null]);
  assert.deepEqual([step.copied.files, step.copied.links, step.copied.skipped], [3, ['latest'], []]);
  assert.match(step.note, /copied 3 file\(s\), 1 link\(s\); source retired to /);
  // The link is gone; a real directory with the marker and the same tree is in its place.
  assert.equal(lstatSync(f.target).isDirectory(), true);
  assert.equal(JSON.parse(readFileSync(path.join(f.target, 'space.json'), 'utf8')).agentId, ID);
  assertSameTree(retired, f.target);
  // The source is retired beside where it was, never deleted; the census follows the directory.
  assert.equal(existsSync(f.space), false);
  assert.equal(readFileSync(path.join(retired, 'notes', 'today.md'), 'utf8'), `# Today\n${SECRET}\n`);
  assert.equal(showSoul(ID, { file: f.file }).spacePath, f.target);
  assert.deepEqual(f.staging(), [], 'no staging or aside is left behind');
  // The journal holds the finished step with its paths; the reduced view is what `soul env` publishes.
  const recorded = readMigrationStep(f.dir, SPACE_STEP_ID);
  assert.deepEqual([recorded.status, recorded.source, recorded.retired, recorded.to, recorded.at], ['done', f.space, retired, f.target, NOW.toISOString()]);
  assert.deepEqual(readMigrationJournal(f.dir).map((entry) => [entry.id, entry.status, entry.from, entry.to]), [[SPACE_STEP_ID, 'done', f.space, f.target]]);
  assert.deepEqual(f.gates, [[`move ${ID}'s Agent Space into its soul folder`, null]]);
  // One receipt naming the operation and counts; no contents anywhere.
  const receipts = f.receipts();
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].event, receipts[0].agentId, receipts[0].operation, receipts[0].decision], ['soul-env-migrate', ID, SPACE_STEP_ID, 'migrated']);
  assert.match(receipts[0].detail, /^3 file\(s\), 1 link\(s\) from /);
  for (const text of [out, f.journalText(), readFileSync(auditFile(f.options), 'utf8')]) assert.equal(text.includes(SECRET), false);
  // The descriptor now sees the memory inside and no migration pending.
  const env = readSoulEnvironment(ID, f.options);
  const memory = component(env, 'memory');
  assert.deepEqual([memory.location, memory.contained, memory.spacePath, memory.status], ['inside', true, f.target, 'ok']);
  assert.equal(env.readiness.problems.some((problem) => problem.code === 'memory-not-contained'), false);
  assert.deepEqual(env.migration.steps.map((entry) => [entry.id, entry.status]), [[SPACE_STEP_ID, 'done']]);
  assert.equal(env.migration.status, 'none');
});

test('a rerun of a contained soul is skipped, still gated, and receipted as such', async (t) => {
  const f = fixture(t);
  await soulEnvMigrateCommand([ID, '--space-into-soul'], { ...f.options, write: () => {} });
  let out = '';
  const rerun = await soulEnvMigrateCommand(['billy', '--space-into-soul', '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.equal(rerun.decision, 'skipped');
  assert.deepEqual([rerun.steps[0].status, rerun.steps[0].note, rerun.steps[0].from, rerun.steps[0].to], ['skipped', 'already inside', f.target, f.target]);
  assert.equal(f.gates.length, 2);
  assert.deepEqual(f.receipts().map((receipt) => receipt.decision), ['migrated', 'skipped']);
  assert.equal(readdirSync(path.dirname(f.space)).filter((name) => name.startsWith('agent_')).length, 1, 'the retired source is untouched');
  assert.equal(out.includes(SECRET), false);
});

test('the migration resumes from each interrupted phase', async (t) => {
  // copying: a partial staging is thrown away and copied again.
  {
    const f = fixture(t);
    const staging = path.join(state(f.dir), 'space.migrating-partial');
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(path.join(staging, 'space.json'), readFileSync(path.join(f.space, 'space.json')));
    recordMigrationStep(f.dir, { id: SPACE_STEP_ID, status: 'copying', from: f.space, to: f.target, at: OLD.toISOString(), note: null, source: f.space, staging, aside: null, retired: null, copied: null });
    const step = migrateSpaceIntoSoul(f.dir, { agentId: ID, file: f.file, now: () => NOW });
    assert.equal(step.status, 'done');
    assert.equal(existsSync(staging), false);
    assert.equal(lstatSync(f.target).isDirectory(), true);
    assertSameTree(step.retired, f.target);
    assert.equal(showSoul(ID, { file: f.file }).spacePath, f.target);
    assert.deepEqual(f.staging(), []);
  }
  // verifying: a complete staging is verified and used as it is.
  {
    const f = fixture(t);
    const staging = path.join(state(f.dir), 'space.migrating-complete');
    copySpaceTree(f.space, staging);
    const inode = statSync(staging).ino;
    recordMigrationStep(f.dir, { id: SPACE_STEP_ID, status: 'verifying', from: f.space, to: f.target, at: OLD.toISOString(), note: null, source: f.space, staging, aside: null, retired: null, copied: null });
    const step = migrateSpaceIntoSoul(f.dir, { agentId: ID, file: f.file, now: () => NOW });
    assert.equal(step.status, 'done');
    assert.equal(statSync(f.target).ino, inode, 'the verified staging became the space');
    assert.deepEqual([step.copied.files, step.copied.links], [3, ['latest']]);
    assert.match(step.note, /^copied 3 file\(s\), 1 link\(s\); source retired to /);
    assert.equal(existsSync(step.retired), true);
    assert.equal(showSoul(ID, { file: f.file }).spacePath, f.target);
  }
  // switching, link moved aside and the staging not yet renamed.
  {
    const f = fixture(t);
    const staging = path.join(state(f.dir), 'space.migrating-switch');
    const aside = path.join(state(f.dir), 'space.link-switch');
    copySpaceTree(f.space, staging);
    renameSync(f.target, aside);
    recordMigrationStep(f.dir, { id: SPACE_STEP_ID, status: 'switching', from: f.space, to: f.target, at: OLD.toISOString(), note: null, source: f.space, staging, aside, retired: null, copied: null });
    const step = migrateSpaceIntoSoul(f.dir, { agentId: ID, file: f.file, now: () => NOW });
    assert.equal(step.status, 'done');
    assert.equal(lstatSync(f.target).isDirectory(), true);
    assert.deepEqual(f.staging(), [], 'the aside link and the staging are gone');
    assertSameTree(step.retired, f.target);
    assert.equal(showSoul(ID, { file: f.file }).spacePath, f.target);
  }
  // switching, the directory already in place but census and source not yet handled.
  {
    const f = fixture(t);
    rmSync(f.target);
    copySpaceTree(f.space, f.target);
    recordMigrationStep(f.dir, { id: SPACE_STEP_ID, status: 'switching', from: f.space, to: f.target, at: OLD.toISOString(), note: null, source: f.space, staging: null, aside: null, retired: null, copied: { files: 3, bytes: 1, links: ['latest'], skipped: [] } });
    assert.equal(showSoul(ID, { file: f.file }).spacePath, f.space);
    const step = migrateSpaceIntoSoul(f.dir, { agentId: ID, file: f.file, now: () => NOW });
    assert.deepEqual([step.status, step.retired], ['done', `${f.space}.retired-2026-10-07`]);
    assert.equal(existsSync(f.space), false);
    assert.equal(existsSync(step.retired), true);
    assert.equal(showSoul(ID, { file: f.file }).spacePath, f.target);
    assert.equal(migrateSpaceIntoSoul(f.dir, { agentId: ID, file: f.file, now: () => NOW }).status, 'skipped');
  }
});

test('a copy that does not verify leaves the link intact and removes the staging', async (t) => {
  const f = fixture(t);
  const copyFileSync = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, destination, ...rest) => {
    copyFileSync(source, destination, ...rest);
    if (source.endsWith('today.md')) fs.writeFileSync(destination, 'not what was there\n');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(soulEnvMigrateCommand([ID, '--space-into-soul'], { ...f.options, write: () => {} }), (error) => {
    assert.equal(error.code, 'space-migrate-verify-failed');
    assert.match(error.message, /did not verify \(notes\/today.md differs between the source and the copy\)/);
    return true;
  });
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(lstatSync(f.target).isSymbolicLink(), true);
  assert.equal(readlinkSync(f.target), f.space);
  assert.equal(existsSync(f.space), true);
  assert.deepEqual(f.staging(), []);
  assert.equal(showSoul(ID, { file: f.file }).spacePath, f.space);
  assert.deepEqual([readMigrationStep(f.dir, SPACE_STEP_ID).status, readMigrationStep(f.dir, SPACE_STEP_ID).staging], ['failed', null]);
  assert.deepEqual(f.receipts().map((receipt) => [receipt.operation, receipt.decision]), [[SPACE_STEP_ID, 'failed']]);
  assert.equal(f.receipts()[0].detail.includes(SECRET), false);
  // The next run starts over and succeeds.
  assert.equal((await soulEnvMigrateCommand([ID, '--space-into-soul'], { ...f.options, write: () => {} })).decision, 'migrated');
});

test('a running soul, a refusing gate, a dangling link and a bad flag mix are refused without moving anything', async (t) => {
  const busy = fixture(t, { running: true });
  await assert.rejects(soulEnvMigrateCommand([ID, '--space-into-soul'], { ...busy.options, write: () => {} }), (error) => {
    assert.deepEqual([error.code, error.action], ['space-migrate-busy', `agent-bot soul stop ${ID}`]);
    return true;
  });
  assert.deepEqual(busy.gates, [], 'nothing is asked of the owner for a soul that cannot be moved');
  assert.equal(readlinkSync(busy.target), busy.space);
  assert.equal(readMigrationStep(busy.dir, SPACE_STEP_ID), null);
  assert.deepEqual(busy.receipts(), []);

  const refused = fixture(t);
  await assert.rejects(soulEnvMigrateCommand([ID, '--space-into-soul'], { ...refused.options, write: () => {},
    gate: async () => { throw Object.assign(new Error('owner only'), { code: 'owner-required' }); } }), /owner only/);
  assert.equal(readlinkSync(refused.target), refused.space);
  assert.equal(showSoul(ID, { file: refused.file }).spacePath, refused.space);
  assert.equal(readMigrationStep(refused.dir, SPACE_STEP_ID), null);
  assert.deepEqual(refused.staging(), []);
  assert.deepEqual(refused.receipts(), []);

  const dangling = fixture(t);
  rmSync(dangling.space, { recursive: true });
  await assert.rejects(soulEnvMigrateCommand([ID, '--space-into-soul'], { ...dangling.options, write: () => {} }), (error) => {
    assert.equal(error.code, 'space-migrate-source-missing');
    return true;
  });
  assert.equal(lstatSync(dangling.target).isSymbolicLink(), true);
  assert.deepEqual(dangling.receipts().map((receipt) => receipt.decision), ['failed']);

  await assert.rejects(soulEnvMigrateCommand([ID, '--space-into-soul', '--harness', 'codex'], { ...refused.options, write: () => {} }), /usage: agent-bot soul env migrate/);
  await assert.rejects(soulEnvMigrateCommand([ID, '--space-into-soul', '--adopt-host-signin'], { ...refused.options, write: () => {} }), /usage: agent-bot soul env migrate/);
});

test('a linked soul reports memory-not-contained with the migrate command as its action', (t) => {
  const f = fixture(t);
  const env = readSoulEnvironment(ID, f.options);
  const memory = component(env, 'memory');
  assert.deepEqual([memory.location, memory.contained, memory.target], ['linked', false, f.space]);
  const problem = env.readiness.problems.find((entry) => entry.code === 'memory-not-contained');
  assert.deepEqual([problem.severity, problem.component, problem.action], ['warning', 'memory', spaceMigrateCommand(ID)]);
  assert.match(problem.message, /outside the soul/);
  assert.equal(problem.message.includes(SECRET), false);
  assert.deepEqual(env.migration.steps.map((entry) => [entry.id, entry.status, entry.from, entry.to]), [[SPACE_STEP_ID, 'pending', f.space, f.target]]);
  assert.equal(env.migration.status, 'pending');
});

test('a new soul starts with its Agent Space inside; an existing external space keeps its link', (t) => {
  const fresh = fixture(t, { external: false });
  assert.equal(existsSync(fresh.target), false);
  assert.equal(ensureSoulDirectory(ID, null, fresh.options), fresh.dir);
  assert.equal(lstatSync(fresh.target).isDirectory(), true);
  assert.equal(JSON.parse(readFileSync(path.join(fresh.target, 'space.json'), 'utf8')).agentId, ID);
  assert.equal(showSoul(ID, { file: fresh.file }).spacePath, fresh.target);
  assert.equal(existsSync(fresh.env.AGENT_BOT_SPACES_HOME), false, 'nothing is created under the spaces root');
  assert.equal(ensureSoulDirectory(ID, null, fresh.options), fresh.dir, 'idempotent');

  const legacy = fixture(t, { link: false });
  ensureSoulDirectory(ID, null, legacy.options);
  assert.equal(lstatSync(legacy.target).isSymbolicLink(), true);
  assert.equal(readlinkSync(legacy.target), legacy.space);
  assert.equal(showSoul(ID, { file: legacy.file }).spacePath, legacy.space);
});

test('initSoulSpace marks the directory, is idempotent, claims only an empty directory and refuses another soul\'s', (t) => {
  const f = fixture(t, { external: false });
  const first = initSoulSpace(ID, f.dir, { now: () => NOW });
  assert.deepEqual([first.id, first.path, first.created, first.marker], [ID, f.target, true, { schemaVersion: 1, agentId: ID, createdAt: NOW.toISOString() }]);
  assert.equal(statSync(f.target).mode & 0o777, 0o700);
  assert.equal(initSoulSpace(ID, f.dir).created, false);
  assert.throws(() => initSoulSpace(OTHER, f.dir), /bound to agent_12345678-1234-4234-8234-123456789abc, not/);
  const other = path.join(f.home, 'Other.soul');
  mkdirSync(path.join(state(other), 'space'), { recursive: true });
  assert.equal(initSoulSpace(OTHER, other).created, true, 'an empty directory is claimed');
  const taken = path.join(f.home, 'Taken.soul');
  put(path.join(state(taken), 'space', 'stray'), '');
  assert.throws(() => initSoulSpace(OTHER, taken), /already exists without space.json/);
  assert.throws(() => initSoulSpace(ID, 'relative/path'), /absolute/);
});

test('every reader of the Agent Space resolves through the census, not the spaces root alone', async (t) => {
  const f = fixture(t);
  assert.equal(soulSpacePath(ID, f.options), f.space);
  assert.equal(soulSpacePath(OTHER, f.options), spacePath(OTHER, f.options), 'a soul the census does not know gets the default root');
  assert.deepEqual([inspectSoulSpace(ID, f.options).status, inspectSoulSpace(ID, f.options).path], ['ok', f.space]);
  await soulEnvMigrateCommand([ID, '--space-into-soul'], { ...f.options, write: () => {} });
  assert.equal(soulSpacePath(ID, f.options), f.target);
  assert.deepEqual([inspectSoulSpace(ID, f.options).status, inspectSoulSpace(ID, f.options).path], ['ok', f.target]);
  assert.notEqual(inspectAgentSpace(ID, f.options).status, 'ok', 'the spaces root alone no longer finds it');
  // Ensuring (bind, join, setup-worktree) hands back the contained space and creates nothing under the root.
  const ensured = ensureSoulSpace(ID, f.options);
  assert.deepEqual([ensured.id, ensured.path, ensured.created, ensured.marker.agentId], [ID, f.target, false, ID]);
  assert.deepEqual(readdirSync(f.env.AGENT_BOT_SPACES_HOME).filter((name) => !name.includes('.retired-')), []);
  const made = ensureSoulSpace(OTHER, f.options);
  assert.deepEqual([made.path, made.created], [spacePath(OTHER, f.options), true], 'a soul without a space gets one under the root');
  // The CLI's path and show answer with the census path.
  const env = { ...process.env, ...f.env };
  delete env.AGENT_BOT_ID; delete env.QWTS_AGENT_ID;
  const shown = spawnSync(process.execPath, [CLI, 'path', ID], { encoding: 'utf8', env });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout.trim(), f.target);
  const show = spawnSync(process.execPath, [CLI, 'show', ID, '--json'], { encoding: 'utf8', env });
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).path, f.target);
  // Promotion reads the file from the contained space.
  const revisionOptions = { env: f.env, home: f.home, stateDir: f.stateDir, file: f.file, now: () => NOW };
  adoptSoulPackage(ID, f.dir, revisionOptions);
  put(path.join(f.target, 'ideas', 'next.md'), 'promote me\n');
  const promoted = await promoteSpaceContent(ID, 'ideas/next.md', 'notes/next.md', { reason: 'Keep the idea', ...revisionOptions });
  assert.match(promoted.reason, new RegExp(`promoted from Agent Space ${ID}/ideas/next.md`));  // Something else at the census path is refused, not replaced by a root space.
  rmSync(f.target, { recursive: true });
  writeFileSync(f.target, 'in the way');
  assert.throws(() => ensureSoulSpace(ID, f.options), /is not agent_12345678-1234-4234-8234-123456789abc's Agent Space \(missing\); refusing/);
  assert.equal(existsSync(spacePath(ID, f.options)), false);
});

test('the history mirror appends a line per turn, session and revision, facts only', async (t) => {
  const f = fixture(t, { external: false });
  ensureSoulDirectory(ID, null, f.options);
  let tick = 0;
  const now = () => new Date(NOW.getTime() + (tick += 1000));
  const history = createSoulHistory({ env: f.env, home: f.home, file: f.file, log: (line) => f.logs.push(line) });
  const registry = createTurnRegistry({ history, now });
  const invocation = { agentId: ID, invocationId: 'inv-1', harness: 'codex', cwd: f.dir };
  assert.equal(await registry.run({ invocation }, async () => 'done'), 'done');
  await assert.rejects(registry.run({ invocation: { ...invocation, invocationId: 'inv-2' }, kind: 'wake' }, async () => { throw new Error(`prompt was ${SECRET}`); }), /prompt was/);
  await assert.rejects(registry.run({ invocation: { ...invocation, invocationId: 'inv-3', taskId: 'task-9' }, kind: 'wake', signal: AbortSignal.abort() }, async () => 'never'), { name: 'AbortError' });
  await registry.run({ invocation: { ...invocation, invocationId: null, harness: null }, kind: 'launch' }, async () => null);
  recordSoulSession({ agentId: ID, provider: 'claude', sessionId: 'sess-11111111', env: f.env, home: f.home, now, history });
  const written = turns(f.dir);
  assert.deepEqual(written.map((line) => [line.id, line.kind, line.harness, line.outcome]), [
    ['inv-1', 'turn', 'codex', 'ok'], ['inv-2', 'wake', 'codex', 'failed'], ['inv-3', 'task', 'codex', 'cancelled'], [null, 'launch', null, 'ok'], ['sess-11111111', 'session', 'claude', null]]);
  for (const line of written) assert.deepEqual(Object.keys(line), ['id', 'kind', 'startedAt', 'endedAt', 'harness', 'outcome']);
  assert.ok(written[0].startedAt < written[0].endedAt);
  assert.equal(readFileSync(path.join(state(f.dir), 'runs', 'turns.jsonl'), 'utf8').includes(SECRET), false);
  assert.equal(statSync(path.join(state(f.dir), 'runs')).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(state(f.dir), 'runs', 'turns.jsonl')).mode & 0o777, 0o600);
  assert.deepEqual(f.logs, []);
  // A revision is mirrored by the journal, through the census folder.
  const revisionOptions = { env: f.env, home: f.home, stateDir: f.stateDir, file: f.file, now };
  const adopted = adoptSoulPackage(ID, f.dir, revisionOptions);
  const mirrored = revisions(f.dir);
  assert.equal(mirrored.length, 1);
  assert.deepEqual(mirrored[0], { id: adopted.revision, parent: null, reason: 'Adopt starting package', at: mirrored[0].at });
  assert.equal(statSync(path.join(state(f.dir), 'runs', 'revisions.jsonl')).mode & 0o777, 0o600);
  // The descriptor counts what the mirror holds.
  const described = component(readSoulEnvironment(ID, f.options), 'history');
  assert.deepEqual([described.mirror, described.mirrored, described.turns, described.revisions], ['.soul-state/runs', true, 5, 1]);
  // Records are normalised: unknown kinds and outcomes do not leak through; control characters are stripped.
  assert.deepEqual(turnRecord({ id: 'x\u0000y', kind: 'weird', outcome: 'maybe', harness: 'h' }), { id: 'x y', kind: 'turn', startedAt: null, endedAt: null, harness: 'h', outcome: null });
  assert.deepEqual(revisionRecord({ revision: 'r1', parentRevision: 'r0', reason: 'why', at: 't' }), { id: 'r1', parent: 'r0', reason: 'why', at: 't' });
});

test('the history mirror is best effort: an unwritable mirror or a soul without a folder never fails the turn', async (t) => {
  const f = fixture(t, { external: false });
  ensureSoulDirectory(ID, null, f.options);
  writeFileSync(path.join(state(f.dir), 'runs'), 'in the way');
  const history = createSoulHistory({ env: f.env, home: f.home, file: f.file, log: (line) => f.logs.push(line) });
  const registry = createTurnRegistry({ history, now: () => NOW });
  assert.equal(await registry.run({ invocation: { agentId: ID, invocationId: 'inv-1' } }, async () => 'still done'), 'still done');
  // ENOTDIR or EEXIST, by platform: a file where the directory must be.
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], new RegExp(`^history mirror: turn for ${ID} not written \\((ENOTDIR|EEXIST)\\)$`));
  assert.throws(() => appendSoulTurn(f.dir, { id: 'inv-1' }), /ENOTDIR|EEXIST/);
  // A soul the census knows without a folder, or a folder without .soul-state, writes nothing and says nothing.
  upsertSoul({ id: OTHER, name: 'other', displayName: 'Other', spacePath: path.join(f.home, 'elsewhere'), status: 'active', parentId: null, appSlug: null }, { file: f.file });
  assert.equal(registeredSoulDir(OTHER, { file: f.file }), null);
  assert.equal(history.turn(OTHER, { id: 'inv-2' }), false);
  const bare = path.join(f.home, 'Bare.soul');
  mkdirSync(bare);
  assert.equal(appendSoulTurn(bare, { id: 'inv-3' }), false);
  assert.equal(existsSync(path.join(bare, '.soul-state')), false);
  assert.equal(f.logs.length, 1);
  // The revision journal logs through its own option and still records.
  rmSync(path.join(state(f.dir), 'runs'));
  mkdirSync(path.join(state(f.dir), 'runs'), { mode: 0o700 });
  mkdirSync(path.join(state(f.dir), 'runs', 'revisions.jsonl'));
  const logs = [];
  const adopted = adoptSoulPackage(ID, f.dir, { env: f.env, home: f.home, stateDir: f.stateDir, file: f.file, now: () => NOW, log: (line) => logs.push(line) });
  assert.match(adopted.revision, /^sha256:/);
  assert.deepEqual(logs, [`soul revisions: history mirror for ${ID} not written (EISDIR)`]);
  const described = component(readSoulEnvironment(ID, f.options), 'history');
  assert.deepEqual([described.mirrored, described.turns, described.revisions], [false, 0, null]);
});

test('at the default root ensure settles under the init lock and still refuses what is not the soul\'s space', (t) => {
  const f = fixture(t);
  const root = spacePath(OTHER, f.options);
  // A concurrent creator's directory before its marker: unmarked, so refused
  // here; once marked under the lock, the same call hands it back.
  mkdirSync(root, { recursive: true });
  assert.throws(() => ensureSoulSpace(OTHER, f.options), /already exists without .*refusing to claim it/);
  rmSync(root, { recursive: true });
  const made = ensureSoulSpace(OTHER, f.options);
  assert.deepEqual([made.path, made.created], [root, true]);
  const again = ensureSoulSpace(OTHER, f.options);
  assert.deepEqual([again.path, again.created, again.marker.agentId], [root, false, OTHER]);
  rmSync(root, { recursive: true });
  writeFileSync(root, 'in the way');
  assert.throws(() => ensureSoulSpace(OTHER, f.options), /refusing to claim it/);
});
