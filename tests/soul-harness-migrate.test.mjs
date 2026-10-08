import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { initAgentSpace } from '../agent-space.mjs';
import { planSoulClean } from '../soul-env-clean.mjs';
import { HARNESSES_STEP_ID, migrateHarnessesIntoRuntimes, soulEnvMigrateCommand } from '../soul-env-migrate.mjs';
import { readSoulEnvironment } from '../soul-env.mjs';
import { readMigrationJournal, readMigrationStep } from '../soul-migration-journal.mjs';
import { PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { INSTALL_STAMP } from '../soul-runtimes.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date('2026-10-08T10:00:00Z');
const CODEX = '@agentclientprotocol/codex-acp';
const CLAUDE = '@zed-industries/claude-code-acp';
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const lines = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };

// A joined soul under a scratch HOME (never the real one): identity on
// codex, a census row, a package with no adapter pin, and the legacy
// `.soul-state/harnesses` install a release before slice 8 made.
function fixture(t, { legacy = true, running = false, harness = 'codex' } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-harness-migrate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const file = env.AGENT_BOT_POPULATION_PATH;
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy.soul');
  mintAgentIdentity({ stateDir: stateDirectory({ env, home }), idFactory: () => ID, harness, appSlug: null, useGithub: false });
  const space = initAgentSpace(ID, { env, home }).path;
  upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: space, status: 'active', parentId: null, appSlug: null }, { file });
  put(path.join(dir, 'soul.json'), JSON.stringify({ formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'Harness migrate tests', displaySeed: 'billy',
    preferredHarnesses: ['codex'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null }));
  put(path.join(dir, 'AGENTS.md'), '# Billy\n');
  put(path.join(dir, '.soul-state', 'agent-id'), `${ID}\n`);
  mkdirSync(path.join(dir, '.soul-state', 'space'));
  const legacyDir = path.join(dir, '.soul-state', 'harnesses');
  if (legacy) legacyInstall(legacyDir, { package: CODEX, version: '2.0.0', bin: 'codex-acp' });
  const gates = [];
  const options = { env, home, cwd: home, file, config: {}, now: () => NOW,
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; },
    running: async () => running };
  return { home, env, dir, file, legacy: legacyDir, target: path.join(dir, '.soul-state', 'runtimes', 'harnesses', 'codex', '2.0.0'), options, gates,
    receipts: () => lines(auditFile({ env, home })) };
}

// What `npm ci` of the pinned adapter leaves: the manifest and lock the
// install wrote, the package, its binary, a dependency.
function legacyInstall(dir, { package: pkg, version, bin }) {
  put(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { [pkg]: version } }));
  put(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, requires: true, packages: { '': { dependencies: { [pkg]: version } }, [`node_modules/${pkg}`]: { version } } }));
  put(path.join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version }));
  put(path.join(dir, 'node_modules', pkg, 'index.js'), 'module.exports = 1;\n');
  put(path.join(dir, 'node_modules', 'shared', 'package.json'), '{"name":"shared","version":"1.0.0"}');
  put(path.join(dir, 'node_modules', '.bin', bin), '#!/bin/sh\nexec node ../index.js\n');
}

function snapshot(root) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { entries.push([path.relative(root, file), 'link']); continue; }
      const stat = statSync(file);
      entries.push([path.relative(root, file), stat.mode, stat.mtimeMs, entry.isFile() ? readFileSync(file).toString('base64') : null]);
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return entries;
}

test('--harnesses-into-runtimes --plan reads only: the step as it stands, no gate, no journal, no receipt', async (t) => {
  const f = fixture(t);
  const before = snapshot(f.home);
  let out = '';
  const planned = await soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--plan', '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), planned);
  assert.deepEqual(Object.keys(planned), ['schemaVersion', 'agentId', 'soulDir', 'operation', 'decision', 'steps', 'root']);
  assert.deepEqual([planned.schemaVersion, planned.agentId, planned.soulDir, planned.operation, planned.decision, planned.root],
    [1, ID, f.dir, HARNESSES_STEP_ID, 'planned', path.join(f.dir, '.soul-state', 'runtimes', 'harnesses')]);
  assert.deepEqual(planned.steps, [{ id: HARNESSES_STEP_ID, status: 'pending', from: f.legacy, to: path.join(f.dir, '.soul-state', 'runtimes', 'harnesses'), at: NOW.toISOString(), note: 'not started' }]);
  assert.deepEqual(snapshot(f.home), before, 'a plan changes nothing');
  assert.deepEqual(f.gates, []);
  assert.deepEqual(f.receipts(), []);
  assert.deepEqual(readMigrationJournal(f.dir), []);
  let human = '';
  await soulEnvMigrateCommand(['billy', '--harnesses-into-runtimes', '--plan'], { ...f.options, write: (value) => { human += value; } });
  assert.match(human, /operation: harnesses-into-runtimes\ndecision: planned\n\nharnesses-into-runtimes: pending - not started\n  from: .*\.soul-state\/harnesses\n  to: .*\.soul-state\/runtimes\/harnesses\n$/);
  // Nothing to move: the plan says so.
  const clean = fixture(t, { legacy: false });
  const nothing = await soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--plan', '--json'], { ...clean.options, write: () => {} });
  assert.deepEqual([nothing.decision, nothing.steps[0].status, nothing.steps[0].note], ['planned', 'skipped', 'nothing to migrate']);
  for (const args of [[ID, '--harnesses-into-runtimes', '--harness', 'codex'], [ID, '--harnesses-into-runtimes', '--plan', '--principal-stdin'], [ID, '--harnesses-into-runtimes', '--complete']]) {
    await assert.rejects(soulEnvMigrateCommand(args, { ...f.options, write: () => {} }), /usage: agent-bot soul env migrate .*--harnesses-into-runtimes \[--plan\]/);
  }
});

test('--harnesses-into-runtimes moves the legacy install under the runtimes with a stamp, journals and receipts it, and a rerun is skipped', async (t) => {
  const f = fixture(t);
  const descriptorBefore = readSoulEnvironment(ID, f.options);
  assert.deepEqual(descriptorBefore.migration.steps.map((step) => [step.id, step.status]), [[HARNESSES_STEP_ID, 'pending']]);
  assert.deepEqual(descriptorBefore.harnesses.installed.map((row) => row.location), ['.soul-state/harnesses']);
  const before = snapshot(f.legacy);
  let out = '';
  const result = await soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--json'], { ...f.options, write: (value) => { out += value; } });
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual([result.operation, result.decision, result.root], [HARNESSES_STEP_ID, 'migrated', path.join(f.dir, '.soul-state', 'runtimes', 'harnesses')]);
  const [step] = result.steps;
  assert.deepEqual(step, { id: HARNESSES_STEP_ID, status: 'done', from: f.legacy, to: f.target, at: NOW.toISOString(), note: `moved to ${f.target}`, harness: 'codex', version: '2.0.0', code: null });
  assert.deepEqual(f.gates, [[`move ${ID}'s codex adapter install under its runtimes`, null]]);
  // The whole install moved, byte for byte, plus the stamp; nothing is left behind and no staging remains.
  assert.equal(existsSync(f.legacy), false);
  const stamp = JSON.parse(readFileSync(path.join(f.target, INSTALL_STAMP), 'utf8'));
  assert.deepEqual(stamp, { schemaVersion: 1, name: 'codex', kind: 'npm', package: CODEX, version: '2.0.0', platform: null, url: null, sha256: null, bin: 'node_modules/.bin', installedAt: NOW.toISOString() });
  assert.equal(statSync(path.join(f.target, INSTALL_STAMP)).mode & 0o777, 0o600);
  rmSync(path.join(f.target, INSTALL_STAMP));
  assert.deepEqual(snapshot(f.target), before);
  assert.deepEqual(readdirSync(path.dirname(f.target)), ['2.0.0']);
  put(path.join(f.target, INSTALL_STAMP), JSON.stringify(stamp));
  // The journal keeps its format and the descriptor reflects it: the install launches from the runtimes, the step is done.
  assert.deepEqual(readMigrationJournal(f.dir), [{ id: HARNESSES_STEP_ID, status: 'done', from: f.legacy, to: f.target, at: NOW.toISOString(), note: `moved to ${f.target}` }]);
  assert.deepEqual(f.receipts().map((receipt) => [receipt.event, receipt.operation, receipt.decision, receipt.detail]), [['soul-env-migrate', HARNESSES_STEP_ID, 'migrated', `done: moved to ${f.target}`]]);
  const described = readSoulEnvironment(ID, f.options);
  assert.deepEqual(described.harnesses.installed, [{ name: 'codex', kind: 'npm', package: CODEX, version: '2.0.0', location: '.soul-state/runtimes/harnesses/codex/2.0.0',
    bin: path.join(f.target, 'node_modules', '.bin', 'codex-acp'), status: 'ok' }]);
  assert.equal(described.harnesses.launchable, true);
  assert.deepEqual(described.migration, { status: 'none', journal: '.soul-state/migration.json', steps: [{ id: HARNESSES_STEP_ID, status: 'done', from: f.legacy, to: f.target, at: NOW.toISOString(), note: `moved to ${f.target}` }] });
  // A migrated install is never a clean candidate; a staging an interrupted install left beside it still is.
  mkdirSync(path.join(path.dirname(f.target), '.installing-00000000-0000-4000-8000-000000000000'));
  const plan = planSoulClean(f.dir, { components: ['runtimes'], now: () => NOW });
  assert.deepEqual(plan.removable.map((row) => row.relative), ['.soul-state/runtimes/harnesses/codex/.installing-00000000-0000-4000-8000-000000000000']);
  assert.ok(!plan.kept.some((row) => row.relative.startsWith('.soul-state/runtimes/harnesses/codex/2.0.0')));
  // Idempotent: nothing left to move is skipped, recorded as such, still gated and receipted like the adoption.
  const again = await soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([again.decision, again.steps[0].status, again.steps[0].note], ['skipped', 'skipped', 'nothing to migrate']);
  assert.equal(readMigrationStep(f.dir, HARNESSES_STEP_ID).status, 'skipped');
  assert.equal(readSoulEnvironment(ID, f.options).migration.status, 'none');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'migrate', 'billy', '--harnesses-into-runtimes', '--plan', '--json'], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual([JSON.parse(cli.stdout).operation, JSON.parse(cli.stdout).decision, JSON.parse(cli.stdout).steps[0].status], [HARNESSES_STEP_ID, 'planned', 'skipped']);
});

test('a legacy install the runtimes already hold is redundant and removed; the provisioned install stands', async (t) => {
  const f = fixture(t);
  put(path.join(f.target, INSTALL_STAMP), JSON.stringify({ name: 'codex', kind: 'npm', package: CODEX, version: '2.0.0', bin: 'node_modules/.bin' }));
  put(path.join(f.target, 'node_modules', '.bin', 'codex-acp'), 'theirs\n');
  const before = snapshot(f.target);
  const result = await soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([result.decision, result.steps[0].status, result.steps[0].note], ['migrated', 'done', 'already provisioned under runtimes; legacy install removed']);
  assert.equal(existsSync(f.legacy), false);
  assert.deepEqual(snapshot(f.target), before, 'the provisioned install is untouched');
});

test('a legacy directory with no runnable adapter is refused with a stable code and left where it is', async (t) => {
  // No adapter package at all.
  const empty = fixture(t, { legacy: false });
  put(path.join(empty.legacy, 'node_modules', 'shared', 'package.json'), '{"name":"shared","version":"1.0.0"}');
  const before = snapshot(empty.legacy);
  await assert.rejects(soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--json'], { ...empty.options, write: () => {} }), (error) => {
    assert.equal(error.code, 'harness-migrate-source-invalid');
    assert.match(error.message, /holds no ACP adapter package/);
    return true;
  });
  assert.deepEqual(snapshot(empty.legacy), before);
  assert.equal(existsSync(path.join(empty.dir, '.soul-state', 'runtimes')), false);
  assert.equal(readMigrationStep(empty.dir, HARNESSES_STEP_ID).status, 'failed');
  assert.match(readMigrationStep(empty.dir, HARNESSES_STEP_ID).note, /^harness-migrate-source-invalid: /);
  assert.deepEqual(empty.receipts().map((receipt) => [receipt.operation, receipt.decision]), [[HARNESSES_STEP_ID, 'failed']]);
  assert.equal(empty.gates.length, 1);
  assert.deepEqual(readSoulEnvironment(ID, empty.options).migration.steps.map((step) => [step.id, step.status]), [[HARNESSES_STEP_ID, 'failed']]);
  assert.equal((await soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--plan', '--json'], { ...empty.options, write: () => {} })).steps[0].note, 'failed last time; run again');
  // The package without its binary.
  const noBin = fixture(t);
  rmSync(path.join(noBin.legacy, 'node_modules', '.bin', 'codex-acp'));
  await assert.rejects(soulEnvMigrateCommand([ID, '--harnesses-into-runtimes'], { ...noBin.options, write: () => {} }), (error) => error.code === 'harness-migrate-source-invalid' && /without node_modules\/\.bin\/codex-acp/.test(error.message));
  assert.ok(existsSync(path.join(noBin.legacy, 'node_modules', CODEX, 'package.json')));
  // A version that is not a plain name never becomes a directory.
  const traversal = fixture(t);
  put(path.join(traversal.legacy, 'node_modules', CODEX, 'package.json'), JSON.stringify({ name: CODEX, version: '../x' }));
  const kept = snapshot(traversal.legacy);
  await assert.rejects(soulEnvMigrateCommand([ID, '--harnesses-into-runtimes'], { ...traversal.options, write: () => {} }), (error) => error.code === 'harness-migrate-source-invalid' && /with an unusable version \("\.\.\/x"\)/.test(error.message));
  assert.deepEqual(snapshot(traversal.legacy), kept);
  assert.equal(existsSync(path.join(traversal.dir, '.soul-state', 'runtimes')), false);
  assert.equal(existsSync(path.join(traversal.dir, '.soul-state', 'x')), false);
  // Two adapters and a recorded harness that is neither: nothing decides.
  const two = fixture(t, { harness: 'muse' });
  legacyInstall(two.legacy, { package: CLAUDE, version: '0.16.2', bin: 'claude-code-acp' });
  await assert.rejects(soulEnvMigrateCommand([ID, '--harnesses-into-runtimes'], { ...two.options, write: () => {} }), (error) => error.code === 'harness-migrate-source-invalid' && /adapters for claude, codex and the soul runs muse/.test(error.message));
  assert.ok(existsSync(two.legacy));
  // The recorded harness decides between two; without a record, the single adapter found does.
  const recorded = fixture(t);
  legacyInstall(recorded.legacy, { package: CLAUDE, version: '0.16.2', bin: 'claude-code-acp' });
  const picked = migrateHarnessesIntoRuntimes(recorded.dir, { harness: 'codex', now: () => NOW });
  assert.deepEqual([picked.status, picked.harness, picked.version, picked.to], ['done', 'codex', '2.0.0', recorded.target]);
  const single = fixture(t);
  const found = migrateHarnessesIntoRuntimes(single.dir, { harness: null, now: () => NOW });
  assert.deepEqual([found.status, found.harness], ['done', 'codex']);
  // The runtimes root cannot be made: the install stays where the soul launches it from.
  const blocked = fixture(t);
  put(path.join(blocked.dir, '.soul-state', 'runtimes', 'harnesses', 'codex'), 'a file in the way');
  const intact = snapshot(blocked.legacy);
  const failed = migrateHarnessesIntoRuntimes(blocked.dir, { harness: 'codex', now: () => NOW });
  assert.deepEqual([failed.status, failed.code], ['failed', 'harness-migrate-verify-failed']);
  assert.deepEqual(snapshot(blocked.legacy), intact);
});

test('the move is refused while the soul runs, before the gate, and the plan still reads', async (t) => {
  const busy = fixture(t, { running: true });
  await assert.rejects(soulEnvMigrateCommand([ID, '--harnesses-into-runtimes'], { ...busy.options, write: () => {} }), (error) => {
    assert.deepEqual([error.code, error.action], ['soul-running', `agent-bot soul stop ${ID}`]);
    return true;
  });
  assert.deepEqual(busy.gates, []);
  assert.deepEqual(busy.receipts(), []);
  assert.ok(existsSync(path.join(busy.legacy, 'node_modules', '.bin', 'codex-acp')));
  assert.equal(readMigrationStep(busy.dir, HARNESSES_STEP_ID), null);
  assert.equal((await soulEnvMigrateCommand([ID, '--harnesses-into-runtimes', '--plan', '--json'], { ...busy.options, write: () => {} })).decision, 'planned');
  // A soul that starts running while the owner is asked is refused after the gate too.
  const late = fixture(t);
  let asked = false;
  await assert.rejects(soulEnvMigrateCommand([ID, '--harnesses-into-runtimes'], { ...late.options, running: async () => asked, gate: async () => { asked = true; return { method: 'consent' }; }, write: () => {} }),
    (error) => error.code === 'soul-running');
  assert.ok(existsSync(late.legacy));
});
