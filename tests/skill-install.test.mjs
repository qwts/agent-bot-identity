import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { adoptSoulPackage, revisionHistory, revisionPackagePath } from '../soul-revisions.mjs';
import { importSkill, verifySkill } from '../skill-library.mjs';
import { installRecordPath, moveToTrash } from '../skill-install.mjs';
import { main } from '../cli/soul-skill.mjs';

const put = (file, bytes, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); if (mode) chmodSync(file, mode); };
const skill = '---\nname: demo\ndescription: An install fixture\n---\nSee [guide](references/guide.md).\n';
function fixture(t, policy = { mode: 'ask' }) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'skill-install-'));
  t.after(() => { const thaw = dir => { chmodSync(dir, 0o700); for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) thaw(path.join(dir, entry.name)); }; thaw(home); rmSync(home, { recursive: true, force: true }); });
  const env = { HOME: home, AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const options = { home, env, stateDir: env.AGENT_BOT_STATE_HOME, file: env.AGENT_BOT_POPULATION_PATH, now: () => new Date('2026-10-09T12:34:56.789Z') };
  const directory = path.join(home, 'souls/example.soul');
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Example', description: 'Test', displaySeed: 'example', preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  put(path.join(directory, 'soul.json'), JSON.stringify(manifest)); put(path.join(directory, 'AGENTS.md'), 'Original\n');
  put(path.join(directory, 'policy.json'), JSON.stringify(policy));
  manifest.revision = computePackageRevision(directory); put(path.join(directory, 'soul.json'), JSON.stringify(manifest));
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: manifest.revision });
  adoptSoulPackage(id, directory, options);
  put(path.join(directory, '.soul-state/agent-id'), `${id}\n`);
  upsertSoul({ id, name: 'example', status: 'active', soulDir: directory, spacePath: path.join(home, 'space'), roles: ['test'], harness: 'codex', app: 'test-agent' }, { file: options.file });
  const source = path.join(home, 'source');
  put(path.join(source, 'SKILL.md'), skill); put(path.join(source, 'references/guide.md'), 'guide\r\n');
  put(path.join(source, 'scripts/run'), '#!/bin/sh\nexit 0\n', 0o755);
  const imported = importSkill(source, options);
  const gates = [];
  // Owner calls: no soul marker and a stub gate that records each action.
  const owner = { ...options, markers: () => [], assertUser: action => { gates.push(action); } };
  const soul = { ...options, markers: () => ['Agent ID'], assertSoulTarget: target => assert.equal(target, id) };
  const run = async (argv, extra = owner) => {
    const out = [], err = [];
    const code = await main(argv, { ...extra, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
    return { code, out: out.join(''), err: err.join(''), json: out.length ? JSON.parse(out.join('')) : null };
  };
  const tmpEntries = () => readdirSync(path.join(directory, '.soul-state/tmp'));
  return { home, options, directory, id, imported, gates, owner, soul, run, tmpEntries };
}

test('owner install applies skills/<name> with the import-style hash record and no host paths', async t => {
  const f = fixture(t);
  const result = await f.run(['install', f.imported.id, '--soul', f.id, '--json']);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json.outcome, 'applied');
  assert.equal(result.json.destination, 'skills/demo');
  assert.deepEqual(f.gates, [`soul revision edit ${f.id}`]);
  assert.equal(readFileSync(path.join(f.directory, 'skills/demo/SKILL.md'), 'utf8'), skill);
  assert.equal(readFileSync(path.join(f.directory, 'skills/demo/references/guide.md'), 'utf8'), 'guide\r\n');
  assert.ok(lstatSync(path.join(f.directory, 'skills/demo/scripts/run')).mode & 0o100, 'executable bit kept');
  const record = JSON.parse(readFileSync(path.join(f.directory, installRecordPath('demo')), 'utf8'));
  const library = verifySkill(f.imported.id, f.options);
  assert.equal(record.digest, library.actual, 'same canonical digest the library records');
  assert.deepEqual(Object.keys(record.files).sort(), ['SKILL.md', 'references/guide.md', 'scripts/run']);
  assert.equal(record.files['scripts/run'].mode, '100755');
  assert.equal(record.libraryId, f.imported.id);
  assert.equal(record.acceptedDigest, f.imported.accepted);
  assert.equal(record.sourceProvenance.source.kind, 'local');
  assert.doesNotMatch(JSON.stringify(record), new RegExp(f.home));
  const history = revisionHistory(f.id, f.options);
  assert.equal(history.length, 2);
  assert.equal(validateSoulPackage(revisionPackagePath(f.id, history.at(-1).revision, f.options)).revision, history.at(-1).revision);
  assert.deepEqual(f.tmpEntries(), [], 'staging is discarded');
  const again = await f.run(['install', 'demo', '--soul', f.id, '--json']);
  assert.equal(again.code, 1);
  assert.equal(again.json.error.code, 'skill-install-exists');
});

test('install selects by unique library name and refuses an ambiguous one', async t => {
  const f = fixture(t);
  assert.equal((await f.run(['install', 'demo', '--soul', f.id])).code, 0);
  const other = fixture(t);
  importSkill(path.join(other.home, 'source'), other.options);
  const ambiguous = await other.run(['install', 'demo', '--soul', other.id, '--json']);
  assert.equal(ambiguous.json.error.code, 'skill-ambiguous');
  assert.equal(existsSync(path.join(other.directory, 'skills')), false);
  assert.equal((await other.run(['install', 'missing', '--soul', other.id, '--json'])).json.error.code, 'skill-not-found');
});

test('a soul install is a proposal under its policy and leaves the live package alone', async t => {
  for (const [policy, expected] of [[{ mode: 'ask' }, 'pending'], [{ mode: 'never' }, 'rejected'], [{ mode: 'auto', paths: ['**'] }, 'approved']]) {
    const f = fixture(t, policy);
    const result = await f.run(['install', f.imported.id, '--soul', f.id, '--json'], f.soul);
    assert.equal(result.json.outcome, expected);
    assert.equal(result.code, expected === 'rejected' ? 1 : 0);
    assert.equal(existsSync(path.join(f.directory, 'skills/demo')), false);
    assert.deepEqual(f.gates, [], 'no owner gate for a proposal');
    assert.deepEqual(f.tmpEntries(), []);
  }
});

test('uninstall archives the skill and its record inside the soul without deleting', async t => {
  const f = fixture(t);
  await f.run(['install', f.imported.id, '--soul', f.id]);
  const result = await f.run(['uninstall', 'demo', '--soul', f.id, '--json']);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json.archive, 'archive/skills/demo/20261009T123456Z');
  assert.equal(existsSync(path.join(f.directory, 'skills/demo')), false);
  assert.equal(existsSync(path.join(f.directory, installRecordPath('demo'))), false);
  const archived = path.join(f.directory, result.json.archive);
  assert.equal(readFileSync(path.join(archived, 'skill/SKILL.md'), 'utf8'), skill);
  assert.equal(JSON.parse(readFileSync(path.join(archived, 'install.json'), 'utf8')).name, 'demo');
  assert.equal(existsSync(path.join(f.home, '.Trash')), false);
  assert.equal(revisionHistory(f.id, f.options).length, 3);
  assert.equal((await f.run(['uninstall', 'demo', '--soul', f.id, '--json'])).json.error.code, 'skill-not-installed');
});

test('--trash moves the live skill to the OS trash after the owner gate, and only for the owner', async t => {
  const f = fixture(t);
  await f.run(['install', f.imported.id, '--soul', f.id]);
  const refused = await f.run(['uninstall', 'demo', '--soul', f.id, '--trash', '--json'], f.soul);
  assert.equal(refused.json.error.code, 'owner-credential-required');
  const denied = await f.run(['uninstall', 'demo', '--soul', f.id, '--trash', '--json'], { ...f.owner, assertUser: () => { throw Object.assign(new Error('no'), { code: 'owner-credential-required' }); } });
  assert.equal(denied.code, 1);
  assert.ok(existsSync(path.join(f.directory, 'skills/demo/SKILL.md')), 'a refused gate trashes nothing');
  const xdg = path.join(f.home, 'xdg');
  const result = await f.run(['uninstall', 'demo', '--soul', f.id, '--trash', '--json'], { ...f.owner, trashOptions: { platform: 'linux', env: { XDG_DATA_HOME: xdg }, home: f.home } });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json.trashedTo, path.join(xdg, 'Trash/files/demo 20261009T123456Z'));
  assert.equal(readFileSync(path.join(result.json.trashedTo, 'SKILL.md'), 'utf8'), skill);
  assert.match(readFileSync(path.join(xdg, 'Trash/info/demo 20261009T123456Z.trashinfo'), 'utf8'), /^\[Trash Info\]\nPath=.*skills\/demo\nDeletionDate=2026-10-09T12:34:56\n$/);
  assert.equal(existsSync(path.join(f.directory, 'skills/demo')), false);
  assert.equal(existsSync(path.join(f.directory, 'archive')), false);
  assert.equal(existsSync(path.join(f.directory, installRecordPath('demo'))), false);
  assert.equal(revisionHistory(f.id, f.options).length, 3);
});

test('moveToTrash uses ~/.Trash on macOS, picks a free name, and refuses Windows', t => {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'skill-trash-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = () => new Date('2026-10-09T00:00:00Z');
  for (const expected of ['demo 20261009T000000Z', 'demo 20261009T000000Z 1']) {
    put(path.join(home, 'demo/SKILL.md'), 'x');
    assert.equal(moveToTrash(path.join(home, 'demo'), { platform: 'darwin', home, now }), path.join(home, '.Trash', expected));
  }
  put(path.join(home, 'demo/SKILL.md'), 'x');
  assert.throws(() => moveToTrash(path.join(home, 'demo'), { platform: 'win32', home, now }), { code: 'skill-trash-unsupported' });
  assert.ok(existsSync(path.join(home, 'demo/SKILL.md')));
});

test('install and uninstall usage errors exit 2', async t => {
  const f = fixture(t);
  for (const argv of [['install'], ['install', f.imported.id], ['install', f.imported.id, '--soul'], ['install', f.imported.id, '--soul', f.id, '--trash'], ['uninstall', 'demo', '--soul', f.id, '--trash', '--trash']]) {
    assert.equal((await f.run(argv)).code, 2, argv.join(' '));
  }
});
