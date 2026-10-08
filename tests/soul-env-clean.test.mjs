import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { showSoul, upsertSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { initAgentSpace } from '../agent-space.mjs';
import { CLEAN_COMPONENTS, CLEAN_JOURNAL, CLEAN_RETENTIONS, applySoulClean, planSoulClean, readCleanJournal, soulEnvCleanCommand } from '../soul-env-clean.mjs';
import { CLASSIFICATIONS, RETENTION, classifyPath, retentionOf } from '../soul-env-contract.mjs';
import { ENV_CAPABILITIES, readSoulEnvironment } from '../soul-env.mjs';
import { COMPLETE_OPERATION, MIGRATION_OPERATIONS, soulEnvMigrateCommand } from '../soul-env-migrate.mjs';
import { SPACE_STEP_ID, copySpaceTree } from '../soul-memory.mjs';
import { readMigrationJournal, readMigrationStep, recordMigrationStep } from '../soul-migration-journal.mjs';
import { PACKAGE_IGNORE_LIST, computePackageRevision } from '../soul-package.mjs';
import { INSTALL_STAMP } from '../soul-runtimes.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const SECRET = 'NEVER-PRINT-THIS-DURABLE-CONTENT';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date('2026-10-07T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const state = (dir) => path.join(dir, '.soul-state');
const lines = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const component = (result, id) => result.components.find((entry) => entry.id === id);

// Every path a clean must never touch, with what it holds, so the tests
// can prove the bytes are still there afterwards.
const DURABLE = Object.freeze({
  'soul.json': null, 'AGENTS.md': `# Billy\n${SECRET}\n`, 'skills/hello/SKILL.md': '---\nname: hello\ndescription: hi\n---\nhi\n',
  'CLAUDE.md': '<!-- agent-bot soul-builder: generated -->\n# Billy\n',
  'worktrees/workspace/.git/HEAD': 'ref: refs/heads/main\n', 'worktrees/workspace/uncommitted.txt': `work in progress ${SECRET}\n`,
  '.soul-state/agent-id': `${ID}\n`, '.soul-state/home/AGENTS.md': '# Billy\n', '.soul-state/home/.codex/sessions/rollout.jsonl': `{"turn":"${SECRET}"}\n`,
  '.soul-state/tools/codex/auth.json': `{"OPENAI_API_KEY":"${SECRET}"}`, '.soul-state/credentials/github-app-billy.json': SECRET,
  '.soul-state/runs/turns.jsonl': '{"id":"inv-1"}\n', '.soul-state/runtimes/node/24.0.0/bin/node': '#!/bin/sh\n',
  [`.soul-state/runtimes/node/24.0.0/${INSTALL_STAMP}`]: JSON.stringify({ name: 'node', version: '24.0.0', bin: 'bin' }),
  '.soul-state/runtimes/node/last-install.json': JSON.stringify({ version: '24.0.0', status: 'ok', at: NOW.toISOString() }),
  '.soul-state/runtimes/go/gopath/bin/tool': '#!/bin/sh\n',
});
// What a clean removes: the cache, temporary files past their window,
// runtime caches, and the staging an interrupted install left.
const REMOVABLE = Object.freeze({
  '.soul-state/cache/index.db': 'cached bytes', '.soul-state/cache/nested/deep/file.bin': 'more cached bytes',
  '.soul-state/tmp/scratch.txt': 'scratch', '.soul-state/tmp/revision-00000000-0000-4000-8000-000000000000/AGENTS.md': '# expired staging\n',
  '.soul-state/runtimes/node/npm-cache/_cacache/index': 'npm cache', '.soul-state/runtimes/go/cache/00/x': 'go build cache',
  '.soul-state/runtimes/node/.installing-11111111-1111-4111-8111-111111111111/extract/node': 'half an install',
  '.soul-state/runtimes/harnesses/opencode/.installing-22222222-2222-4222-8222-222222222222/extract/opencode': 'half a harness',
});
const FRESH_STAGING = '.soul-state/tmp/revision-ffffffff-ffff-4fff-8fff-ffffffffffff';

// One soul under a scratch HOME with its Agent Space outside and linked
// (as before slice 5), every durable component present with content, and
// the reconstructible and disposable ones populated. Nothing here touches
// the real HOME, a keychain or login items.
function fixture(t, { running = false, link = true } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-env-clean-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const file = env.AGENT_BOT_POPULATION_PATH;
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy.soul');
  mintAgentIdentity({ stateDir: stateDirectory({ env, home }), idFactory: () => ID, harness: 'codex', appSlug: null, useGithub: false });
  const space = initAgentSpace(ID, { env, home }).path;
  put(path.join(space, 'notes', 'today.md'), `# Today\n${SECRET}\n`);
  upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: space, status: 'active', parentId: null, appSlug: null }, { file });
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'Clean tests', displaySeed: 'billy', preferredHarnesses: ['codex'],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, runtimes: { node: '24' } };
  for (const [relative, contents] of Object.entries(DURABLE)) if (contents !== null) put(path.join(dir, relative), contents);
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(dir);
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  if (link) symlinkSync(space, path.join(state(dir), 'space'), 'dir');
  for (const [relative, contents] of Object.entries(REMOVABLE)) put(path.join(dir, relative), contents);
  // An expired revision staging (past its 24-hour window) and a fresh one.
  utimesSync(path.join(dir, '.soul-state', 'tmp', 'revision-00000000-0000-4000-8000-000000000000'), new Date(NOW.getTime() - 25 * HOUR), new Date(NOW.getTime() - 25 * HOUR));
  put(path.join(dir, FRESH_STAGING, 'AGENTS.md'), '# edit in progress\n');
  utimesSync(path.join(dir, FRESH_STAGING), new Date(NOW.getTime() - HOUR), new Date(NOW.getTime() - HOUR));
  const gates = [];
  const options = { env, home, cwd: home, file, config: {}, now: () => NOW,
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; },
    running: async () => running };
  return { home, env, dir, file, space, target: path.join(state(dir), 'space'), options, gates,
    receipts: () => lines(auditFile({ env, home })) };
}

// Every file, link and directory under a root with modes, mtimes and bytes.
function snapshot(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { entries.push([path.relative(root, file), 'link', readlinkSync(file)]); continue; }
      const stat = statSync(file);
      entries.push([path.relative(root, file), stat.mode, stat.mtimeMs, entry.isFile() ? readFileSync(file).toString('base64') : null]);
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return entries;
}

function assertDurableIntact(f) {
  for (const [relative, contents] of Object.entries(DURABLE)) {
    assert.ok(existsSync(path.join(f.dir, relative)), `${relative} is still there`);
    if (contents !== null) assert.equal(readFileSync(path.join(f.dir, relative), 'utf8'), contents, relative);
  }
  assert.ok(existsSync(path.join(f.dir, FRESH_STAGING, 'AGENTS.md')), 'a revision staging within its window stays');
  assert.equal(readFileSync(path.join(f.space, 'notes', 'today.md'), 'utf8'), `# Today\n${SECRET}\n`, 'the linked space is untouched');
}

test('the contract says which retentions a clean may remove, and the capabilities name the slice', () => {
  assert.deepEqual(CLEAN_RETENTIONS, ['reconstructible', 'disposable']);
  assert.deepEqual(RETENTION, ['durable', 'reconstructible', 'disposable']);
  assert.deepEqual(CLEAN_COMPONENTS, ['cache', 'temp', 'runtimes']);
  assert.deepEqual(MIGRATION_OPERATIONS, ['adopt-host-signin', 'space-into-soul', 'template-name', 'complete']);
  assert.equal(COMPLETE_OPERATION, 'complete');
  assert.ok(ENV_CAPABILITIES.includes('env-clean') && ENV_CAPABILITIES.includes('migrate-complete'));
  // Every durable class is out of reach by construction.
  for (const classification of CLASSIFICATIONS) {
    const retention = retentionOf(classification);
    if (['definition', 'workspace', 'private-home', 'memory', 'history'].includes(classification)) assert.equal(retention, 'durable', classification);
  }
  for (const relative of Object.keys(REMOVABLE)) assert.ok(CLEAN_RETENTIONS.includes(retentionOf(classifyPath(relative))), relative);
  // Generated output and an installed runtime are reconstructible but are
  // rebuilt by their own commands: a clean leaves them too (tested below).
  for (const relative of Object.keys(DURABLE)) {
    const reconstructible = relative === 'CLAUDE.md' || relative.startsWith('.soul-state/runtimes/');
    assert.equal(retentionOf(classifyPath(relative)), reconstructible ? 'reconstructible' : 'durable', relative);
  }
});

test('soul env clean --plan lists what would go with sizes, reads only, and is the same plan twice', async (t) => {
  const f = fixture(t);
  const before = snapshot(f.home);
  let out = '';
  const plan = await soulEnvCleanCommand([ID, '--plan', '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), plan);
  assert.deepEqual(Object.keys(plan), ['schemaVersion', 'agentId', 'soulDir', 'applied', 'decision', 'components', 'removable', 'removed', 'failed', 'kept', 'files', 'bytes', 'journal']);
  assert.deepEqual([plan.schemaVersion, plan.agentId, plan.soulDir, plan.applied, plan.decision, plan.components, plan.removed, plan.failed, plan.journal],
    [1, ID, f.dir, false, 'planned', ['cache', 'temp', 'runtimes'], [], [], CLEAN_JOURNAL]);
  assert.deepEqual(plan.removable.map((row) => [row.component, row.relative, row.classification, row.retention, row.kind, row.files, row.bytes]), [
    ['cache', '.soul-state/cache/index.db', 'cache', 'reconstructible', 'cache-entry', 1, 12],
    ['cache', '.soul-state/cache/nested', 'cache', 'reconstructible', 'cache-entry', 1, 17],
    ['temp', '.soul-state/tmp/revision-00000000-0000-4000-8000-000000000000', 'temp', 'disposable', 'revision-staging', 1, 18],
    ['temp', '.soul-state/tmp/scratch.txt', 'temp', 'disposable', 'temp-entry', 1, 7],
    ['runtimes', '.soul-state/runtimes/node/npm-cache', 'runtime', 'reconstructible', 'runtime-cache', 1, 9],
    ['runtimes', '.soul-state/runtimes/go/cache', 'runtime', 'reconstructible', 'runtime-cache', 1, 14],
    ['runtimes', '.soul-state/runtimes/node/.installing-11111111-1111-4111-8111-111111111111', 'runtime', 'reconstructible', 'install-staging', 1, 15],
    ['runtimes', '.soul-state/runtimes/harnesses/opencode/.installing-22222222-2222-4222-8222-222222222222', 'runtime', 'reconstructible', 'install-staging', 1, 14],
  ]);
  for (const row of plan.removable) assert.equal(row.path, path.join(f.dir, row.relative));
  assert.deepEqual([plan.files, plan.bytes], [8, 106]);
  assert.deepEqual(plan.kept.map((row) => [row.relative, row.kind, row.retention]), [[FRESH_STAGING, 'revision-staging', 'disposable']]);
  assert.match(plan.kept[0].reason, /within its 24-hour window/);
  for (const row of [...plan.removable, ...plan.kept]) assert.ok(CLEAN_RETENTIONS.includes(row.retention) || row.reason, row.relative);
  // Read-only: nothing gated, written, journaled or receipted; the plan is byte-identical on a rerun.
  assert.deepEqual(snapshot(f.home), before);
  assert.deepEqual(f.gates, []);
  assert.deepEqual(f.receipts(), []);
  assert.equal(readCleanJournal(f.dir), null);
  let again = '';
  await soulEnvCleanCommand(['billy', '--plan', '--json'], { ...f.options, write: (value) => { again += value; } });
  assert.equal(again, out);
  assert.deepEqual(snapshot(f.home), before);
  let human = '';
  await soulEnvCleanCommand(['Billy', '--plan'], { ...f.options, write: (value) => { human += value; } });
  assert.match(human, /^agentId: agent_/);
  assert.match(human, /would remove \(8\)/);
  assert.match(human, /kept \(1\)/);
  assert.match(human, /total: 8 file\(s\), 106 byte\(s\)/);
  assert.equal(human.includes(SECRET), false);
  assert.deepEqual(planSoulClean(f.dir, { now: () => NOW }).removable.map((row) => row.relative), plan.removable.map((row) => row.relative));
});

test('soul env clean removes only reconstructible and disposable paths, journals the run, and is idempotent', async (t) => {
  const f = fixture(t);
  const descriptorBefore = readSoulEnvironment(ID, f.options);
  assert.ok(component(descriptorBefore, 'cache').present && component(descriptorBefore, 'temp').entries.length === 3);
  let out = '';
  const result = await soulEnvCleanCommand([ID, '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual([result.applied, result.decision, result.files, result.bytes, result.failed], [true, 'cleaned', 8, 106, []]);
  assert.deepEqual(result.removed.map((row) => row.relative), result.removable.map((row) => row.relative));
  for (const relative of Object.keys(REMOVABLE)) assert.equal(existsSync(path.join(f.dir, relative)), false, `${relative} is gone`);
  assertDurableIntact(f);
  // The roots stay as directories for the next cache write.
  for (const relative of ['.soul-state/cache', '.soul-state/tmp', '.soul-state/runtimes/node', '.soul-state/runtimes/go/gopath']) assert.ok(lstatSync(path.join(f.dir, relative)).isDirectory(), relative);
  assert.deepEqual(f.gates, [[`clean ${ID}'s reconstructible environment (cache, temp, runtimes)`, null]]);
  const journal = readCleanJournal(f.dir);
  assert.deepEqual([journal.schemaVersion, journal.agentId, journal.at, journal.files, journal.bytes, journal.failed], [1, ID, NOW.toISOString(), 8, 106, []]);
  assert.deepEqual(journal.removed.map((row) => row.relative), result.removed.map((row) => row.relative));
  assert.deepEqual(Object.keys(journal.removed[0]), ['relative', 'classification', 'kind', 'files', 'bytes']);
  assert.equal(statSync(path.join(f.dir, CLEAN_JOURNAL)).mode & 0o777, 0o600);
  const receipts = f.receipts();
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].event, receipts[0].agentId, receipts[0].operation, receipts[0].decision], ['soul-env-clean', ID, 'clean', 'cleaned']);
  assert.match(receipts[0].detail, /^8 path\(s\), 8 file\(s\), 106 byte\(s\) removed: \.soul-state\/cache\/index\.db, /);
  for (const text of [out, readFileSync(path.join(f.dir, CLEAN_JOURNAL), 'utf8'), readFileSync(auditFile(f.options), 'utf8')]) assert.equal(text.includes(SECRET), false);
  // The descriptor is still complete, the memory still linked (durable, untouched), the temp entries down to the kept staging.
  const descriptor = readSoulEnvironment(ID, f.options);
  assert.deepEqual(descriptor.errors, []);
  assert.deepEqual([component(descriptor, 'memory').location, component(descriptor, 'memory').contained], ['linked', false]);
  assert.deepEqual(component(descriptor, 'temp').entries.map((row) => row.name), [path.basename(FRESH_STAGING)]);
  assert.equal(descriptor.retention.durable.includes('history'), true);
  // Nothing left to remove: a rerun is `nothing`, still gated, still receipted.
  const rerun = await soulEnvCleanCommand([ID, '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([rerun.decision, rerun.removed, rerun.files, rerun.bytes], ['nothing', [], 0, 0]);
  assert.equal(f.gates.length, 2);
  assert.deepEqual(f.receipts().map((receipt) => receipt.decision), ['cleaned', 'nothing']);
  assertDurableIntact(f);
});

test('a clean never removes a durable path, even when asked, and never follows a link', async (t) => {
  const f = fixture(t);
  const before = snapshot(f.home);
  for (const component of ['memory', 'home', 'history', 'workspaces', 'credentials', 'tool-state', 'manifest', 'generated', 'nope']) {
    await assert.rejects(soulEnvCleanCommand([ID, '--component', component, '--json'], { ...f.options, write: () => {} }), (error) => {
      assert.equal(error.code, 'clean-component-durable');
      assert.match(error.action, /shows each component's retention/);
      return true;
    });
  }
  assert.deepEqual(snapshot(f.home), before, 'a refused request changes nothing');
  assert.deepEqual(f.gates, []);
  // The apply checks the contract per path once more: a durable row smuggled into a plan is refused.
  const plan = planSoulClean(f.dir, { now: () => NOW });
  const smuggled = { ...plan, removable: [{ component: 'memory', path: path.join(f.dir, '.soul-state', 'runs'), relative: '.soul-state/runs', classification: 'history', retention: 'durable', kind: 'x', files: 1, bytes: 1 }] };
  assert.throws(() => applySoulClean(f.dir, smuggled, { agentId: ID, now: () => NOW }), (error) => error.code === 'clean-component-durable');
  const outside = { ...plan, removable: [{ component: 'cache', path: f.space, relative: '.soul-state/cache/x', classification: 'cache', retention: 'reconstructible', kind: 'x', files: 1, bytes: 1 }] };
  assert.throws(() => applySoulClean(f.dir, outside, { agentId: ID, now: () => NOW }), (error) => error.code === 'clean-component-durable');
  assert.deepEqual(snapshot(f.home), before);
  // A cache root that is a link to durable state is kept, and what it points at is never descended.
  rmSync(path.join(f.dir, '.soul-state', 'cache'), { recursive: true });
  symlinkSync(path.join(f.dir, '.soul-state', 'runs'), path.join(f.dir, '.soul-state', 'cache'), 'dir');
  const linked = await soulEnvCleanCommand([ID, '--component', 'cache', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([linked.decision, linked.removable, linked.removed], ['nothing', [], []]);
  assert.deepEqual(linked.kept.map((row) => [row.relative, row.kind]), [['.soul-state/cache', 'link']]);
  assert.match(linked.kept[0].reason, /never followed/);
  assert.equal(readFileSync(path.join(f.dir, '.soul-state', 'runs', 'turns.jsonl'), 'utf8'), '{"id":"inv-1"}\n');
  assertDurableIntact(f);
  // `--component cache` alone leaves temp and the runtime caches alone.
  rmSync(path.join(f.dir, '.soul-state', 'cache'));
  put(path.join(f.dir, '.soul-state', 'cache', 'index.db'), 'cached bytes');
  const only = await soulEnvCleanCommand([ID, '--component', 'cache', '--component', 'cache', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([only.components, only.removed.map((row) => row.relative)], [['cache'], ['.soul-state/cache/index.db']]);
  assert.ok(existsSync(path.join(f.dir, '.soul-state', 'tmp', 'scratch.txt')));
  assert.ok(existsSync(path.join(f.dir, '.soul-state', 'runtimes', 'node', 'npm-cache')));
});

test('a running soul, a refusing gate, a space move under way and bad flags are refused without removing anything', async (t) => {
  const busy = fixture(t, { running: true });
  const before = snapshot(busy.home);
  await assert.rejects(soulEnvCleanCommand([ID], { ...busy.options, write: () => {} }), (error) => {
    assert.deepEqual([error.code, error.action], ['soul-running', `agent-bot soul stop ${ID}`]);
    return true;
  });
  assert.deepEqual(busy.gates, [], 'nothing is asked of the owner for a soul that cannot be cleaned');
  assert.deepEqual(snapshot(busy.home), before);
  assert.deepEqual(busy.receipts(), []);
  // The plan still reads while the soul runs.
  assert.equal((await soulEnvCleanCommand([ID, '--plan', '--json'], { ...busy.options, write: () => {} })).decision, 'planned');

  const refused = fixture(t);
  const untouched = snapshot(refused.home);
  await assert.rejects(soulEnvCleanCommand([ID, '--principal-stdin'], { ...refused.options, write: () => {}, readStdin: () => '{"id":"p"}',
    gate: async () => { throw Object.assign(new Error('owner only'), { code: 'owner-required' }); } }), /owner only/);
  assert.deepEqual(snapshot(refused.home), untouched);
  assert.equal(readCleanJournal(refused.dir), null);
  // A soul that starts between the gate and the removal is refused too.
  let asked = 0;
  await assert.rejects(soulEnvCleanCommand([ID], { ...refused.options, write: () => {}, running: async () => asked++ > 0 }), (error) => error.code === 'soul-running');
  assert.deepEqual(snapshot(refused.home), untouched);

  // A space move under way: its staging is reported kept, and the clean goes on with the rest.
  const staging = path.join(state(refused.dir), 'space.migrating-partial');
  mkdirSync(staging, { mode: 0o700 });
  recordMigrationStep(refused.dir, { id: SPACE_STEP_ID, status: 'copying', from: refused.space, to: refused.target, at: NOW.toISOString(), note: null, source: refused.space, staging, aside: null, retired: null, copied: null });
  const plan = await soulEnvCleanCommand([ID, '--plan', '--json'], { ...refused.options, write: () => {} });
  assert.deepEqual(plan.kept.map((row) => [row.relative, row.kind, row.retention]), [[FRESH_STAGING, 'revision-staging', 'disposable'], ['.soul-state/space.migrating-partial', 'space-staging', 'durable']]);
  assert.match(plan.kept[1].reason, /migrate --complete finishes it/);
  assert.ok(existsSync(staging));

  for (const args of [[], ['--json'], [ID, '--nope'], [ID, 'other'], [ID, '--plan', '--principal-stdin'], [ID, '--component'], [ID, '--json', '--json']]) {
    await assert.rejects(soulEnvCleanCommand(args, { ...refused.options, write: () => {} }), /usage: agent-bot soul env clean/);
  }
  await assert.rejects(soulEnvCleanCommand(['nobody'], { ...refused.options, write: () => {} }), (error) => error.code === 'soul-not-found');
  await assert.rejects(soulEnvCleanCommand([ID, '--principal-stdin'], { ...refused.options, write: () => {}, readStdin: () => 'not json' }), /principal credential as JSON/);
  const bare = fixture(t);
  rmSync(state(bare.dir), { recursive: true, force: true });
  await assert.rejects(soulEnvCleanCommand([ID], { ...bare.options, write: () => {} }), (error) => error.code === 'soul-state-missing');
});

test('the CLI prints the clean schema and coded errors with --json', (t) => {
  const f = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'clean', ...args], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  const plan = run('billy', '--plan', '--json');
  assert.equal(plan.status, 0, plan.stderr);
  const parsed = JSON.parse(plan.stdout);
  // The CLI runs on the real clock, so only the clock-independent rows are asserted.
  assert.deepEqual([parsed.schemaVersion, parsed.agentId, parsed.applied, parsed.decision], [1, ID, false, 'planned']);
  assert.ok(parsed.removable.some((row) => row.relative === '.soul-state/cache/index.db' && row.bytes === 12));
  const unknown = run('nobody', '--json');
  assert.equal(unknown.status, 1);
  assert.deepEqual(JSON.parse(unknown.stdout), { error: { code: 'soul-not-found', message: 'Soul not found.', action: null } });
  const durable = run('billy', '--component', 'memory', '--json');
  assert.equal(durable.status, 1);
  assert.equal(JSON.parse(durable.stdout).error.code, 'clean-component-durable');
  const usage = run('billy', '--plan', '--principal-stdin');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: agent-bot soul env clean/);
  const help = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /agent-bot soul env clean <agentId\|name> \[--plan\] \[--component cache\|temp\|runtimes\] \[--json\] \[--principal-stdin\]/);
  assert.match(help.stdout, /--template-name \[--plan\] \| --complete \[--plan\]/);
});

test('soul env migrate --complete resumes an interrupted space move from the journal, adopts a pending sign-in, and marks the journal done', async (t) => {
  const f = fixture(t);
  // An interrupted copy: the journal says `copying`, a partial staging is on disk.
  const staging = path.join(state(f.dir), 'space.migrating-partial');
  mkdirSync(staging, { mode: 0o700 });
  writeFileSync(path.join(staging, 'space.json'), readFileSync(path.join(f.space, 'space.json')));
  recordMigrationStep(f.dir, { id: SPACE_STEP_ID, status: 'copying', from: f.space, to: f.target, at: '2026-01-02T03:04:05.000Z', note: null, source: f.space, staging, aside: null, retired: null, copied: null });
  // A host codex sign-in the soul lacks: the descriptor lists its adoption pending.
  put(path.join(f.home, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"host-sign-in"}');
  rmSync(path.join(f.dir, '.soul-state', 'tools', 'codex', 'auth.json'));
  const options = { ...f.options, platform: 'linux' };
  const pending = readSoulEnvironment(ID, options);
  assert.deepEqual(pending.migration.steps.map((step) => [step.id, step.status]), [[SPACE_STEP_ID, 'copying'], ['adopt-host-signin:codex', 'pending']]);
  assert.equal(pending.migration.status, 'pending');

  // --plan reads only and is byte-identical on a rerun.
  const before = snapshot(f.home);
  let out = '';
  const planned = await soulEnvMigrateCommand([ID, '--complete', '--plan', '--json'], { ...options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), planned);
  assert.deepEqual(Object.keys(planned), ['schemaVersion', 'agentId', 'soulDir', 'operation', 'decision', 'steps', 'root']);
  assert.deepEqual([planned.schemaVersion, planned.agentId, planned.soulDir, planned.operation, planned.decision, planned.root], [1, ID, f.dir, 'complete', 'planned', f.dir]);
  assert.deepEqual(planned.steps.map((step) => [step.id, step.status, step.from, step.to, step.note]), [
    [SPACE_STEP_ID, 'copying', f.space, f.target, 'interrupted while copying; resumed'],
    ['adopt-host-signin:codex', 'pending', path.join(f.home, '.codex'), path.join(f.dir, '.soul-state', 'tools', 'codex'), 'not started']]);
  assert.deepEqual(snapshot(f.home), before);
  assert.deepEqual(f.gates, []);
  assert.deepEqual(f.receipts(), []);
  let again = '';
  await soulEnvMigrateCommand(['billy', '--complete', '--plan', '--json'], { ...options, write: (value) => { again += value; } });
  assert.equal(again, out);

  out = '';
  const result = await soulEnvMigrateCommand([ID, '--complete', '--json'], { ...options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual([result.operation, result.decision, result.root], ['complete', 'completed', f.dir]);
  assert.deepEqual(result.steps.map((step) => [step.id, step.status]), [[SPACE_STEP_ID, 'done'], ['adopt-host-signin:codex', 'done']]);
  const [space, adopt] = result.steps;
  assert.deepEqual([space.source, space.to, space.retired, space.staging, space.copied.files], [f.space, f.target, `${f.space}.retired-2026-10-07`, null, 2]);
  assert.match(space.note, /^copied 2 file\(s\), 0 link\(s\); source retired to /);
  assert.deepEqual(adopt.files.map((file) => [file.path, file.status]), [['auth.json', 'copied']]);
  // The partial staging was dropped and copied again; the directory is in place, the census follows, the source is retired.
  assert.equal(existsSync(staging), false);
  assert.equal(lstatSync(f.target).isDirectory(), true);
  assert.equal(readFileSync(path.join(f.target, 'notes', 'today.md'), 'utf8'), `# Today\n${SECRET}\n`);
  assert.equal(showSoul(ID, { file: f.file }).spacePath, f.target);
  assert.ok(existsSync(space.retired));
  assert.equal(statSync(path.join(f.dir, '.soul-state', 'tools', 'codex', 'auth.json')).mode & 0o777, 0o600);
  assert.deepEqual(f.gates, [[`complete ${ID}'s pending migration (${SPACE_STEP_ID}, adopt-host-signin:codex)`, null]]);
  // The journal keeps its format: one record per step, both final.
  assert.deepEqual(readMigrationJournal(f.dir).map((step) => [step.id, step.status, step.from, step.to]), [[SPACE_STEP_ID, 'done', f.space, f.target], ['adopt-host-signin:codex', 'done', path.join(f.home, '.codex'), path.join(f.dir, '.soul-state', 'tools', 'codex')]]);
  assert.equal(readMigrationStep(f.dir, SPACE_STEP_ID).at, NOW.toISOString());
  const receipts = f.receipts();
  assert.deepEqual(receipts.map((receipt) => [receipt.event, receipt.operation, receipt.decision]), [['soul-env-migrate', 'complete', 'completed']]);
  assert.equal(receipts[0].detail, 'space-into-soul: done; adopt-host-signin:codex: done');
  for (const text of [out, readFileSync(path.join(state(f.dir), 'migration.json'), 'utf8'), readFileSync(auditFile(f.options), 'utf8')]) {
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes('host-sign-in'), false);
  }
  // The descriptor's migration block reflects it.
  const done = readSoulEnvironment(ID, options);
  assert.deepEqual([component(done, 'memory').location, component(done, 'memory').contained, component(done, 'memory').spacePath], ['inside', true, f.target]);
  assert.deepEqual(done.migration.steps.map((step) => [step.id, step.status]), [[SPACE_STEP_ID, 'done'], ['adopt-host-signin:codex', 'done']]);
  assert.equal(done.migration.status, 'none');
  assert.equal(done.readiness.problems.some((problem) => ['memory-not-contained', 'tool-signin-missing'].includes(problem.code)), false);
  // Idempotent: nothing pending is skipped with no steps, no gate and no receipt.
  out = '';
  const rerun = await soulEnvMigrateCommand([ID, '--complete', '--json'], { ...options, write: (value) => { out += value; } });
  assert.deepEqual([rerun.decision, rerun.steps], ['skipped', []]);
  assert.equal(f.gates.length, 1);
  assert.equal(f.receipts().length, 1);
  let human = '';
  await soulEnvMigrateCommand([ID, '--complete'], { ...options, write: (value) => { human += value; } });
  assert.match(human, /operation: complete\ndecision: skipped\n\nnothing pending\n$/);
});

test('--complete keeps a deferred step pending, reports a step that cannot run as failed, and is refused while the soul runs', async (t) => {
  const f = fixture(t);
  // A legacy harness install: listed, noted, never recorded.
  put(path.join(f.dir, '.soul-state', 'harnesses', 'node_modules', '@agentclientprotocol', 'codex-acp', 'package.json'), '{"version":"2.0.0"}');
  // The linked space's source is gone: its step fails with the sibling's code, in the result, not as a crash.
  rmSync(f.space, { recursive: true });
  const result = await soulEnvMigrateCommand([ID, '--complete', '--json'], { ...f.options, write: () => {} });
  assert.equal(result.decision, 'failed');
  assert.deepEqual(result.steps.map((step) => [step.id, step.status]), [[SPACE_STEP_ID, 'failed'], ['harnesses-into-runtimes', 'pending']]);
  assert.match(result.steps[0].note, /^space-migrate-source-missing: /);
  assert.match(result.steps[1].note, /not migrated by this release/);
  assert.equal(f.gates.length, 1);
  assert.equal(readMigrationStep(f.dir, 'harnesses-into-runtimes'), null, 'a deferred step is never recorded');
  assert.equal(lstatSync(f.target).isSymbolicLink(), true, 'the link is left as it was');
  assert.deepEqual(f.receipts().map((receipt) => [receipt.operation, receipt.decision]), [['complete', 'failed']]);
  const described = readSoulEnvironment(ID, f.options);
  assert.deepEqual(described.migration.steps.map((step) => [step.id, step.status]), [[SPACE_STEP_ID, 'pending'], ['harnesses-into-runtimes', 'pending']]);
  // Only the deferred step left: nothing runnable, nothing gated.
  rmSync(f.target);
  mkdirSync(f.target);
  const deferred = await soulEnvMigrateCommand([ID, '--complete', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([deferred.decision, deferred.steps.map((step) => step.id)], ['skipped', ['harnesses-into-runtimes']]);
  assert.equal(f.gates.length, 1);

  const busy = fixture(t, { running: true });
  await assert.rejects(soulEnvMigrateCommand([ID, '--complete'], { ...busy.options, write: () => {} }), (error) => {
    assert.deepEqual([error.code, error.action], ['soul-running', `agent-bot soul stop ${ID}`]);
    return true;
  });
  assert.deepEqual(busy.gates, []);
  assert.equal(readlinkSync(busy.target), busy.space);
  assert.deepEqual(busy.receipts(), []);
  assert.equal((await soulEnvMigrateCommand([ID, '--complete', '--plan', '--json'], { ...busy.options, write: () => {} })).decision, 'planned', 'the plan still reads');
  for (const args of [[ID, '--complete', '--harness', 'codex'], [ID, '--complete', '--space-into-soul'], [ID, '--complete', '--plan', '--principal-stdin'], [ID, '--complete', '--complete']]) {
    await assert.rejects(soulEnvMigrateCommand(args, { ...busy.options, write: () => {} }), /usage: agent-bot soul env migrate/);
  }
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'migrate', 'billy', '--complete', '--plan', '--json'], { cwd: busy.home, env: busy.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual([JSON.parse(cli.stdout).operation, JSON.parse(cli.stdout).decision], ['complete', 'planned']);
});

test('a verified staging of an interrupted move is used as it is by --complete', async (t) => {
  const f = fixture(t);
  const staging = path.join(state(f.dir), 'space.migrating-complete');
  copySpaceTree(f.space, staging);
  const inode = statSync(staging).ino;
  recordMigrationStep(f.dir, { id: SPACE_STEP_ID, status: 'verifying', from: f.space, to: f.target, at: '2026-01-02T03:04:05.000Z', note: null, source: f.space, staging, aside: null, retired: null, copied: null });
  const result = await soulEnvMigrateCommand([ID, '--complete', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([result.decision, result.steps[0].id, result.steps[0].status], ['completed', SPACE_STEP_ID, 'done']);
  assert.equal(statSync(f.target).ino, inode, 'the verified staging became the space');
  assert.equal(showSoul(ID, { file: f.file }).spacePath, f.target);
  assert.equal(readSoulEnvironment(ID, f.options).migration.status, 'none');
});
