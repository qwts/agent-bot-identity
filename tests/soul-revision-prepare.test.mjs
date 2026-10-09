import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { soulDirectory, upsertSoul } from '../agent-population.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { classifyPath, GENERATED_HARNESS_MARKER, GENERATED_HARNESS_PATHS } from '../soul-env-contract.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { adoptSoulPackage, discardRevisionStaging, prepareRevisionEdit, revisionCommand, revisionHistory } from '../soul-revisions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A launched format-2 soul with working state, a built harness folder, an
// authored MCP file the builder merges, and a soul-shipped tool in bin/.
function fixture(t) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'revision-prepare-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The folder carries the soul's registered name exactly: a case-insensitive
  // disk (macOS) would also find `Example.soul` by name, Linux CI would not.
  const directory = join(home, 'souls', 'example.soul');
  mkdirSync(directory, { recursive: true });
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Example', description: 'Test',
    displaySeed: 'example', preferredHarnesses: ['claude'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(join(directory, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'AGENTS.md'), 'Original instructions\n');
  mkdirSync(join(directory, 'skills', 'hello'), { recursive: true });
  writeFileSync(join(directory, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nhi\n');
  mkdirSync(join(directory, 'bin'));
  writeFileSync(join(directory, 'bin', 'run'), '#!/bin/sh\necho old\n');
  chmodSync(join(directory, 'bin', 'run'), 0o755);
  writeFileSync(join(directory, 'policy.json'), '{"mode":"ask"}\n');
  writeFileSync(join(directory, 'data.bin'), Buffer.from([0, 255, 1]));
  // An authored MCP file at a generated path: the builder merges it, so the
  // package keeps it and prepare must stage it (classified generated).
  writeFileSync(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'my-server' } } }));
  manifest.revision = computePackageRevision(directory);
  writeFileSync(join(directory, 'soul.json'), JSON.stringify(manifest));
  buildSoulDirectory(directory);
  manifest.revision = computePackageRevision(directory);
  writeFileSync(join(directory, 'soul.json'), JSON.stringify(manifest));
  assert.equal(validateSoulPackage(directory).revision, manifest.revision, 'merged output does not change the revision');
  const env = { PATH: process.env.PATH, HOME: home, AGENT_BOT_CONFIG: join(home, 'no-config'),
    AGENT_BOT_POPULATION_PATH: join(home, 'population.json'), AGENT_BOT_STATE_HOME: join(home, 'state'),
    AGENT_BOT_SOULS_HOME: join(home, 'souls') };
  const options = { env, home, cwd: home, stateDir: env.AGENT_BOT_STATE_HOME, file: env.AGENT_BOT_POPULATION_PATH };
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: computePackageRevision(directory) });
  adoptSoulPackage(id, directory, options);
  mkdirSync(join(directory, '.soul-state'), { mode: 0o700 });
  writeFileSync(join(directory, '.soul-state', 'agent-id'), `${id}\n`);
  writeFileSync(join(directory, '.soul-state', 'session'), 'Live session');
  mkdirSync(join(directory, '.soul-state', 'home'));
  writeFileSync(join(directory, '.soul-state', 'home', 'AGENTS.md'), 'Home copy\n');
  symlinkSync(join(home, 'space'), join(directory, '.soul-state', 'space'));
  mkdirSync(join(directory, 'worktrees'));
  symlinkSync(join(home, 'missing-checkout'), join(directory, 'worktrees', 'checkout'));
  upsertSoul({ id, name: 'example', displayName: 'Example', status: 'active', soulDir: directory, spacePath: join(home, 'space') },
    { file: env.AGENT_BOT_POPULATION_PATH });
  assert.equal(soulDirectory(id, options), directory);
  return { home, directory, id, options, initial: manifest.revision };
}

function tree(directory) {
  const result = {};
  function walk(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const path = prefix + name, file = join(folder, name), stat = lstatSync(file);
      result[path] = { mode: stat.mode & 0o777, content: stat.isSymbolicLink() ? readlinkSync(file)
        : stat.isFile() ? readFileSync(file).toString('base64') : null };
      if (stat.isDirectory()) walk(file, `${path}/`);
    }
  }
  walk(directory);
  return result;
}

test('prepare stages the definition under .soul-state/tmp, excludes working state and exact generated output, keeps the merged MCP file', (t) => {
  const f = fixture(t), before = tree(f.directory);
  const now = () => new Date('2026-10-07T12:00:00Z');
  const result = prepareRevisionEdit('example', { ...f.options, now });
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'agentId', 'soulDir', 'staging', 'revision', 'parentRevision', 'files', 'excluded', 'expiresAt']);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.agentId, f.id);
  assert.equal(result.soulDir, f.directory);
  assert.match(result.staging, new RegExp(`^${f.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.soul-state/tmp/revision-[0-9a-f-]{36}$`));
  assert.equal(lstatSync(result.staging).mode & 0o777, 0o700);
  assert.equal(result.revision, f.initial);
  assert.equal(result.parentRevision, null);
  assert.equal(result.expiresAt, '2026-10-08T12:00:00.000Z');
  const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ['.mcp.json', 'AGENTS.md', 'bin/run', 'data.bin', 'policy.json', 'skills/hello/SKILL.md', 'soul.json']);
  assert.deepEqual(byPath['AGENTS.md'], { path: 'AGENTS.md', classification: 'definition', kind: 'context', editable: true, text: true, size: 22, mode: '100644' });
  assert.deepEqual(byPath['soul.json'], { ...byPath['soul.json'], classification: 'definition', kind: 'soul', editable: false, text: true, mode: '100644' });
  assert.deepEqual(byPath['bin/run'], { path: 'bin/run', classification: 'definition', kind: null, editable: false, text: true, size: 19, mode: '100755' });
  assert.deepEqual(byPath['skills/hello/SKILL.md'], { ...byPath['skills/hello/SKILL.md'], classification: 'definition', kind: 'skill', editable: true, text: true });
  assert.deepEqual(byPath['data.bin'], { path: 'data.bin', classification: 'definition', kind: null, editable: true, text: false, size: 3, mode: '100644' });
  assert.deepEqual(byPath['.mcp.json'], { ...byPath['.mcp.json'], classification: 'generated', kind: null, editable: false, text: true });
  assert.deepEqual(byPath['policy.json'].editable, true);
  assert.deepEqual(result.excluded.workingState, ['worktrees', '.soul-state']);
  assert.ok(result.excluded.generated.includes('CLAUDE.md'));
  assert.ok(result.excluded.generated.includes('.claude/skills/hello/SKILL.md'));
  assert.ok(!result.excluded.generated.includes('.mcp.json'), 'the merged file was staged, not excluded');
  const staged = tree(result.staging);
  assert.deepEqual(Object.keys(staged).filter((path) => !staged[path].content === false || staged[path].content !== null).sort(),
    Object.keys(byPath).sort(), 'exactly the listed files are staged');
  assert.equal(staged['bin/run'].mode, 0o755, 'execute bits are preserved');
  assert.equal(staged['AGENTS.md'].mode, 0o644);
  assert.equal(readFileSync(join(result.staging, '.mcp.json'), 'utf8'), readFileSync(join(f.directory, '.mcp.json'), 'utf8'));
  assert.ok(!existsSync(join(result.staging, 'CLAUDE.md')));
  assert.ok(!existsSync(join(result.staging, '.soul-state')));
  assert.ok(!existsSync(join(result.staging, 'worktrees')));
  const after = tree(f.directory);
  for (const path of Object.keys(before)) assert.deepEqual(after[path], before[path], `${path} unchanged`);
  const added = Object.keys(after).filter((path) => !(path in before));
  assert.ok(added.every((path) => path.startsWith('.soul-state/tmp')), `only staging was added: ${added.join(', ')}`);
  assert.equal(revisionHistory(f.id, f.options).length, 1, 'prepare records nothing');
  const second = prepareRevisionEdit(f.id, { ...f.options, now });
  assert.notEqual(second.staging, result.staging, 'each prepare makes a fresh staging directory');
});

test('a prepared staging round-trips through soul revision edit --apply', async (t) => {
  const f = fixture(t);
  const prepared = prepareRevisionEdit(f.id, f.options);
  writeFileSync(join(prepared.staging, 'AGENTS.md'), 'Customized by the host\n');
  writeFileSync(join(prepared.staging, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello warmly\n---\nhi there\n');
  const authorization = { method: 'presence', via: 'agent-bot-keyd' };
  const record = await revisionCommand(['edit', f.id, prepared.staging, 'Customize instructions', '--apply', '--json'],
    { ...f.options, presence: async () => authorization });
  assert.equal(record.applied, true);
  assert.equal(record.parentRevision, prepared.revision);
  const edited = ['AGENTS.md', 'skills/hello/SKILL.md', 'soul.json'];
  assert.deepEqual(record.changed.filter((path) => edited.includes(path)), edited);
  // As with any copy-based edit, apply removes the exact generated output
  // the staging left out; it is reconstructible, and the builder makes it
  // again (the home is rebuilt on each launch).
  const generatedOrParent = (path) => classifyPath(path) === 'generated' || GENERATED_HARNESS_PATHS.some((candidate) => candidate.startsWith(`${path}/`));
  assert.ok(record.changed.every((path) => edited.includes(path) || generatedOrParent(path)), record.changed.join(', '));
  assert.ok(!existsSync(join(f.directory, 'CLAUDE.md')));
  assert.equal(readFileSync(join(f.directory, 'AGENTS.md'), 'utf8'), 'Customized by the host\n');
  assert.equal(readFileSync(join(f.directory, 'bin', 'run'), 'utf8'), '#!/bin/sh\necho old\n');
  assert.equal(lstatSync(join(f.directory, 'bin', 'run')).mode & 0o777, 0o755);
  assert.equal(JSON.parse(readFileSync(join(f.directory, '.mcp.json'), 'utf8')).mcpServers.mine.command, 'my-server', 'the merged MCP file survives');
  buildSoulDirectory(f.directory);
  assert.equal(readFileSync(join(f.directory, 'CLAUDE.md'), 'utf8').split('\n')[0], GENERATED_HARNESS_MARKER, 'the builder regenerates its output');
  assert.equal(validateSoulPackage(f.directory).revision, record.revision, 'regenerated output does not change the revision');
  assert.equal(readFileSync(join(f.directory, '.soul-state', 'home', 'AGENTS.md'), 'utf8'), 'Home copy\n');
  assert.equal(readlinkSync(join(f.directory, '.soul-state', 'space')), join(f.home, 'space'));
  assert.equal(readFileSync(join(f.directory, '.soul-state', 'session'), 'utf8'), 'Live session');
  assert.equal(readlinkSync(join(f.directory, 'worktrees', 'checkout')), join(f.home, 'missing-checkout'));
  assert.equal(validateSoulPackage(f.directory).revision, record.revision);
  assert.equal(revisionHistory(f.id, f.options).length, 2);
  assert.equal(prepareRevisionEdit(f.id, f.options).revision, record.revision, 'the next prepare sees the new head');
  assert.deepEqual(discardRevisionStaging(prepared.staging), { discarded: prepared.staging });
  assert.ok(!existsSync(prepared.staging));
});

test('--discard removes only a revision staging under a soul\'s .soul-state/tmp', (t) => {
  const f = fixture(t);
  const prepared = prepareRevisionEdit(f.id, f.options);
  const outside = mkdtempSync(join(f.home, 'revision-'));
  writeFileSync(join(outside, 'keep'), 'x');
  for (const [path, code] of [[outside, 'staging-not-temp'], [f.directory, 'staging-not-temp'],
    [join(f.directory, '.soul-state', 'home'), 'staging-not-temp'], [join(f.directory, 'worktrees'), 'staging-not-temp'],
    [join(f.directory, '.soul-state', 'tmp', 'missing-revision-00000000-0000-4000-8000-000000000000'), 'staging-missing']]) {
    assert.throws(() => discardRevisionStaging(path), (error) => error.code === code, path);
  }
  const named = join(f.directory, '.soul-state', 'tmp', 'revision-00000000-0000-4000-8000-000000000000');
  mkdirSync(named);
  writeFileSync(join(named, 'file'), 'x');
  assert.throws(() => discardRevisionStaging(join(f.home, 'souls', '..', 'souls', 'example.soul', '.soul-state', 'tmp', '..', 'home')), (error) => error.code === 'staging-not-temp');
  const unmarked = join(f.home, 'souls', 'Other.soul', '.soul-state', 'tmp', 'revision-00000000-0000-4000-8000-000000000000');
  mkdirSync(unmarked, { recursive: true });
  assert.throws(() => discardRevisionStaging(unmarked), (error) => error.code === 'staging-not-temp', 'a folder with no marker is not a soul');
  assert.ok(existsSync(join(outside, 'keep')) && existsSync(named) && existsSync(unmarked));
  assert.deepEqual(discardRevisionStaging(named), { discarded: named });
  assert.deepEqual(discardRevisionStaging(prepared.staging), { discarded: prepared.staging });
  assert.ok(!existsSync(named) && !existsSync(prepared.staging));
  assert.ok(existsSync(join(f.directory, '.soul-state', 'tmp')), 'the tmp directory itself stays');
});

test('a failed prepare removes its staging; --dest stages elsewhere; a soul without .soul-state needs --dest', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'skills', 'hello', 'SKILL.md'), 'no front matter\n');
  assert.throws(() => prepareRevisionEdit(f.id, f.options), /SKILL\.md/);
  assert.deepEqual(readdirSync(join(f.directory, '.soul-state', 'tmp')), [], 'the staging directory is removed on error');
  writeFileSync(join(f.directory, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nhi\n');
  const dest = join(f.home, 'elsewhere', 'staging');
  const result = prepareRevisionEdit(f.id, { ...f.options, dest });
  assert.equal(result.staging, dest);
  assert.ok(existsSync(join(dest, 'AGENTS.md')));
  assert.throws(() => prepareRevisionEdit(f.id, { ...f.options, dest }), /EEXIST/, 'a destination something else owns is never reused');
  rmSync(join(f.directory, '.soul-state'), { recursive: true, force: true });
  // Without a marker the registered folder is not trusted; it is found again
  // only as the default folder of that name, and prepare does not create a
  // .soul-state there to stage in.
  assert.throws(() => prepareRevisionEdit('example', f.options), (error) => error.code === 'soul-state-missing');
  assert.ok(!existsSync(join(f.directory, '.soul-state')));
  assert.throws(() => prepareRevisionEdit('nobody', f.options), (error) => error.code === 'soul-not-found');
});

test('the stable CLI accepts prepare by name with --json and --dest, and --discard; usage errors stay usage errors', (t) => {
  const f = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'agent-bot.mjs'), 'soul', 'revision', ...args],
    { cwd: f.home, env: f.options.env, encoding: 'utf8', timeout: 20000 });
  const prepared = run('prepare', 'example', '--json');
  assert.equal(prepared.status, 0, prepared.stderr);
  const result = JSON.parse(prepared.stdout);
  assert.equal(result.agentId, f.id);
  assert.ok(existsSync(join(result.staging, 'AGENTS.md')));
  const dest = join(f.home, 'dest');
  const elsewhere = run('prepare', f.id, '--dest', dest);
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.equal(JSON.parse(elsewhere.stdout).staging, dest);
  const discarded = run('prepare', '--discard', result.staging, '--json');
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.deepEqual(JSON.parse(discarded.stdout), { discarded: result.staging });
  assert.ok(!existsSync(result.staging));
  for (const args of [['prepare'], ['prepare', '--discard'], ['prepare', '--discard', dest, 'extra'], ['prepare', 'example', '--dest'],
    ['prepare', 'example', '--apply'], ['prepare', 'example', 'extra'], ['prepare', 'example', '--dest', dest, '--dest', dest]]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /usage: soul revision/, args.join(' '));
  }
  const refused = run('prepare', '--discard', dest);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /staging-not-temp/);
  assert.ok(existsSync(join(dest, 'AGENTS.md')));
});
