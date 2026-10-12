import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { upsertSoul, soulDirectory } from '../agent-population.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { adoptSoulPackage, editSoulRevision, revisionCommand, revisionHistory, revisionPackagePath } from '../soul-revisions.mjs';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'revision-apply-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, 'Example.soul');
  mkdirSync(directory);
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Example', description: 'Test',
    displaySeed: 'example', preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null,
    future: { keep: true } };
  writeFileSync(join(directory, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'AGENTS.md'), 'Original instructions\n');
  writeFileSync(join(directory, 'removed'), 'Remove me');
  writeFileSync(join(directory, 'run'), '#!/bin/sh\necho old\n');
  chmodSync(join(directory, 'run'), 0o755);
  manifest.revision = computePackageRevision(directory);
  writeFileSync(join(directory, 'soul.json'), JSON.stringify(manifest));
  const env = { PATH: process.env.PATH, HOME: home, AGENT_BOT_CONFIG: join(home, 'no-config'),
    AGENT_BOT_POPULATION_PATH: join(home, 'population.json'), AGENT_BOT_STATE_HOME: join(home, 'state'),
    AGENT_BOT_SOULS_HOME: home };
  const options = { env, home, cwd: home, stateDir: env.AGENT_BOT_STATE_HOME };
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: computePackageRevision(directory) });
  adoptSoulPackage(id, directory, options);
  mkdirSync(join(directory, '.soul-state'));
  writeFileSync(join(directory, '.soul-state', 'agent-id'), `${id}\n`);
  writeFileSync(join(directory, '.soul-state', 'session'), 'Live session');
  mkdirSync(join(directory, 'worktrees'));
  symlinkSync(join(home, 'missing-checkout'), join(directory, 'worktrees', 'checkout'));
  upsertSoul({ id, name: 'example', status: 'active', soulDir: directory, spacePath: join(home, 'space') },
    { file: env.AGENT_BOT_POPULATION_PATH });
  assert.equal(soulDirectory(id, options), directory);
  const copy = join(home, 'copy.soul');
  cpSync(directory, copy, { recursive: true, verbatimSymlinks: true });
  const authorization = { method: 'presence', via: 'agent-bot-keyd' };
  return { home, directory, copy, id, options, authorization, initial: manifest.revision };
}

function tree(directory) {
  const result = {};
  function walk(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const path = prefix + name, file = join(folder, name), stat = lstatSync(file);
      result[path] = { ino: stat.ino, mode: stat.mode, content: stat.isSymbolicLink() ? readlinkSync(file)
        : stat.isFile() ? readFileSync(file).toString('base64') : null };
      if (stat.isDirectory()) walk(file, `${path}/`);
    }
  }
  walk(directory);
  return result;
}

// The history mirror (#583 slice 5) appends a line under `.soul-state/runs`
// for every recorded revision; everything else in the folder must stay.
const definition = (snapshot) => Object.fromEntries(Object.entries(snapshot).filter(([path]) => !path.startsWith('.soul-state/runs')));
const mirrored = (f) => readFileSync(join(f.directory, '.soul-state', 'runs', 'revisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

const editArgs = (f, path = f.copy) => ['edit', f.id, path, 'Customize instructions', '--apply', '--json'];
const editOptions = (f) => ({ ...f.options, presence: async () => f.authorization });

test('--apply writes the recorded copy, removes missing paths, keeps execute bits and working state', async (t) => {
  const f = fixture(t), before = tree(f.directory);
  writeFileSync(join(f.copy, 'AGENTS.md'), 'Customized\n');
  rmSync(join(f.copy, 'removed'));
  mkdirSync(join(f.copy, 'extra'));
  writeFileSync(join(f.copy, 'extra', 'data'), Buffer.from([0, 255, 1]));
  writeFileSync(join(f.copy, 'run'), '#!/bin/sh\necho new\n');
  chmodSync(join(f.copy, 'extra', 'data'), 0o755);
  const copyBefore = tree(f.copy);
  const record = await revisionCommand(editArgs(f), editOptions(f));
  assert.equal(record.applied, true);
  assert.deepEqual(record.authorization, f.authorization);
  assert.deepEqual(record.changed, ['AGENTS.md', 'extra', 'extra/data', 'removed', 'run', 'soul.json']);
  assert.equal(readFileSync(join(f.directory, 'AGENTS.md'), 'utf8'), 'Customized\n');
  assert.equal(existsSync(join(f.directory, 'removed')), false);
  assert.deepEqual(readFileSync(join(f.directory, 'extra', 'data')), Buffer.from([0, 255, 1]));
  for (const file of ['run', 'extra/data']) assert.equal(lstatSync(join(f.directory, file)).mode & 0o777, 0o755);
  const manifest = JSON.parse(readFileSync(join(f.directory, 'soul.json')));
  assert.equal(manifest.revision, record.revision);
  assert.equal(manifest.parentRevision, f.initial);
  assert.deepEqual(manifest.future, { keep: true });
  assert.equal(validateSoulPackage(f.directory).revision, record.revision);
  const after = tree(f.directory);
  for (const path of Object.keys(before).filter((path) => /^(\.soul-state|worktrees)/.test(path))) {
    assert.deepEqual(after[path], before[path]);
  }
  assert.notEqual(after['AGENTS.md'].ino, before['AGENTS.md'].ino, 'modified files are replaced atomically');
  assert.deepEqual(tree(f.copy), copyBefore, 'private source copy is not rewritten');
  const stored = revisionPackagePath(f.id, record.revision, f.options);
  assert.equal(readFileSync(join(stored, 'AGENTS.md'), 'utf8'), 'Customized\n');
});

test('--apply saves appearance and recomputes the package revision', async (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(join(f.copy, 'soul.json')));
  writeFileSync(join(f.copy, 'soul.json'), JSON.stringify({ ...manifest, appearance: { hue: 359 } }));
  const record = await revisionCommand(editArgs(f), editOptions(f));
  assert.equal(record.applied, true);
  assert.notEqual(record.revision, f.initial);
  assert.equal(record.parentRevision, f.initial);
  assert.deepEqual(record.changed, ['soul.json']);
  for (const directory of [f.directory, revisionPackagePath(f.id, record.revision, f.options)]) {
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'soul.json'))).appearance, { hue: 359 });
    assert.equal(validateSoulPackage(directory).revision, record.revision);
  }
});

test('--apply refuses invalid appearance before publishing a snapshot, history, or files', async (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(join(f.copy, 'soul.json')));
  const before = tree(f.directory);
  const history = revisionHistory(f.id, f.options);
  const root = join(f.options.stateDir, 'soul-revisions', f.id);
  const stored = tree(root);
  for (const appearance of [null, {}, { hue: -1 }, { hue: 360 }, { hue: 1.5 }, { hue: '120' }, { hue: 120, extra: true }]) {
    writeFileSync(join(f.copy, 'soul.json'), JSON.stringify({ ...manifest, appearance }));
    await assert.rejects(revisionCommand(editArgs(f), editOptions(f)), /soul\.json appearance/);
    assert.deepEqual(tree(f.directory), before);
    assert.deepEqual(revisionHistory(f.id, f.options), history);
    assert.deepEqual(tree(root), stored);
  }
});

test('--apply with the soul directory as input only replaces soul.json revision fields', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'AGENTS.md'), 'Already edited\n');
  const before = tree(f.directory);
  const oldManifest = JSON.parse(readFileSync(join(f.directory, 'soul.json')));
  const record = await revisionCommand(editArgs(f, f.directory), editOptions(f));
  assert.deepEqual(record.changed, ['soul.json']);
  const after = tree(f.directory);
  for (const path of Object.keys(before).filter((path) => path !== 'soul.json')) assert.deepEqual(after[path], before[path]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'soul.json'))), {
    ...oldManifest, revision: record.revision, parentRevision: f.initial,
  });
  assert.equal(validateSoulPackage(f.directory).revision, record.revision);
});

test('without --apply, edit only records a revision and leaves both folders unchanged', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.copy, 'AGENTS.md'), 'Record only');
  const before = tree(f.directory), copyBefore = tree(f.copy);
  const record = await revisionCommand(editArgs(f).filter((arg) => arg !== '--apply'), editOptions(f));
  assert.equal(record.applied, undefined);
  assert.equal(record.changed, undefined);
  assert.deepEqual(definition(tree(f.directory)), definition(before));
  assert.deepEqual(tree(f.copy), copyBefore);
  assert.deepEqual(mirrored(f).at(-1), { id: record.revision, parent: f.initial, reason: 'Customize instructions', at: mirrored(f).at(-1).at }, 'the revision is mirrored into the soul');
});

for (const failure of ['owner refusal', 'stale parent', 'source symlink', 'destination symlink', 'destination dangling symlink', 'source parent symlink']) {
  test(`${failure} refuses --apply without changing the soul folder`, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.copy, 'AGENTS.md'), 'Must not apply');
    let source = f.copy;
    if (failure === 'source symlink') symlinkSync(join(f.home, 'absent'), join(f.copy, 'link'));
    if (failure.startsWith('destination ')) symlinkSync(failure.includes('dangling') ? join(f.home, 'absent') : f.copy,
      join(f.directory, 'link'));
    if (failure === 'source parent symlink') {
      symlinkSync(f.home, join(f.home, 'alias'));
      source = join(f.home, 'alias', 'copy.soul');
    }
    const before = tree(f.directory);
    const options = editOptions(f);
    if (failure === 'owner refusal') options.presence = async () => { throw new Error('owner denied'); };
    if (failure === 'stale parent') options.expectedParent = `sha256:${'f'.repeat(64)}`;
    await assert.rejects(revisionCommand(editArgs(f, source), options), /denied|stale|unsupported|symlink/);
    assert.deepEqual(tree(f.directory), before);
    assert.equal(revisionHistory(f.id, f.options).length, 1);
  });
}

test('--apply replaces directory/file conflicts and records mode-only changes', async (t) => {
  const f = fixture(t);
  rmSync(join(f.copy, 'removed'));
  mkdirSync(join(f.copy, 'removed'));
  writeFileSync(join(f.copy, 'removed', 'child'), 'New child');
  chmodSync(join(f.copy, 'run'), 0o644);
  let record = await revisionCommand(editArgs(f), editOptions(f));
  assert.deepEqual(record.changed, ['removed', 'removed/child', 'run', 'soul.json']);
  assert.equal(lstatSync(join(f.directory, 'run')).mode & 0o111, 0);
  rmSync(join(f.copy, 'removed'), { recursive: true });
  writeFileSync(join(f.copy, 'removed'), 'Now a file');
  record = await revisionCommand(editArgs(f), editOptions(f));
  assert.deepEqual(record.changed, ['removed', 'removed/child', 'soul.json']);
  assert.equal(readFileSync(join(f.directory, 'removed'), 'utf8'), 'Now a file');
  assert.equal(validateSoulPackage(f.directory).revision, record.revision);
});

test('--apply holds the revision lock while recording, and releases it after publication', async (t) => {
  const f = fixture(t);
  const lock = join(f.options.stateDir, 'soul-revisions', f.id, '.lock');
  let checked = false, published = false;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.startsWith(f.directory + '/')) {
      assert.ok(existsSync(join(lock, 'owner')), 'publication stays locked');
      published = true;
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await editSoulRevision(f.id, f.copy, { ...f.options, apply: true, reason: 'Lock check', now: () => {
    assert.ok(existsSync(join(lock, 'owner')));
    checked = true;
    return new Date();
  } });
  assert.ok(checked && published);
  assert.equal(existsSync(lock), false);
});

test('the stable CLI accepts --apply --json and --principal-stdin before enforcing owner proof', (t) => {
  const f = fixture(t), before = tree(f.directory);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../agent-bot.mjs', import.meta.url)),
    'soul', 'revision', ...editArgs(f), '--principal-stdin'], {
    env: f.options.env, cwd: f.home, encoding: 'utf8',
    input: JSON.stringify({ principal: 'principal_12345678-1234-4123-8123-123456789abc', secret: 'test-only',
      brokerUid: process.getuid(), mode: 'group' }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /broker in this account cannot vouch/);
  assert.deepEqual(tree(f.directory), before);
});

test('--apply is accepted only by edit', async (t) => {
  const f = fixture(t);
  await assert.rejects(revisionCommand(['history', f.id, '--apply'], f.options), /usage/);
});


test('a head moved after recording refuses application without touching the folder', async (t) => {
  const f = fixture(t), before = tree(f.directory);
  const root = join(f.options.stateDir, 'soul-revisions', f.id);
  const link = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    const result = link(from, to);
    if (to === join(root, '0000000001.json')) {
      // Simulate a writer that bypassed the lock; even this must not apply a stale head.
      writeFileSync(join(root, '0000000002.json'), JSON.stringify({
        ...revisionHistory(f.id, f.options)[0], reason: 'External head change',
      }));
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(editSoulRevision(f.id, f.copy, { ...f.options, apply: true, reason: 'Stale apply' }),
    /stale apply: recorded head moved/);
  assert.deepEqual(definition(tree(f.directory)), definition(before), 'only the mirror of the recorded revision was written');
  assert.equal(existsSync(join(root, '.lock')), false);
});

test('application uses recorded bytes even when the private copy changes after snapshotting', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.copy, 'AGENTS.md'), 'Reviewed bytes');
  const record = await editSoulRevision(f.id, f.copy, { ...f.options, apply: true, reason: 'Use snapshot', now: () => {
    writeFileSync(join(f.copy, 'AGENTS.md'), 'Later unreviewed bytes');
    return new Date();
  } });
  assert.equal(readFileSync(join(f.directory, 'AGENTS.md'), 'utf8'), 'Reviewed bytes');
  assert.equal(validateSoulPackage(f.directory).revision, record.revision);
});


test('record-only edit records under the shared revision lock without applying files', async (t) => {
  const f = fixture(t), journal = join(f.options.stateDir, 'soul-revisions', f.id);
  writeFileSync(join(f.copy, 'AGENTS.md'), 'Record-only change');
  const original = fs.linkSync;
  let observed = false;
  try {
    fs.linkSync = (...args) => {
      if (args[1].startsWith(journal)) { observed = true; assert(existsSync(join(journal, '.lock', 'owner'))); }
      return original(...args);
    };
    syncBuiltinESMExports();
    const result = await editSoulRevision(f.id, f.copy, { ...f.options, reason: 'Record', apply: false, expectedParent: f.initial });
    assert.equal(result.parentRevision, f.initial); assert(observed);
  } finally { fs.linkSync = original; syncBuiltinESMExports(); }
  assert(!existsSync(join(journal, '.lock')));
  assert.equal(readFileSync(join(f.directory, 'AGENTS.md'), 'utf8'), 'Original instructions\n');
});

const posix = { skip: process.platform === 'win32' ? 'requires POSIX directory fsync' : false };
test('snapshot and journal sync failures never acknowledge or begin working-file application', posix, async (t) => {
  for (const boundary of ['object-file', 'journal-file', 'journal-directory']) await t.test(boundary, async (t) => {
    const f = fixture(t), before = definition(tree(f.directory));
    const journal = join(f.options.stateDir, 'soul-revisions', f.id);
    const mirror = join(f.directory, '.soul-state', 'runs', 'revisions.jsonl');
    const mirrorBefore = existsSync(mirror) ? readFileSync(mirror) : null;
    writeFileSync(join(f.copy, 'AGENTS.md'), 'Must not apply');
    const original = { open: fs.openSync, close: fs.closeSync, sync: fs.fsyncSync, link: fs.linkSync };
    const paths = new Map(); let published = false, injected = false;
    try {
      fs.openSync = (file, ...args) => { const fd = original.open(file, ...args); paths.set(fd, String(file)); return fd; };
      fs.closeSync = (fd) => { paths.delete(fd); return original.close(fd); };
      fs.linkSync = (...args) => { const result = original.link(...args); if (args[1].startsWith(journal)) published = true; return result; };
      fs.fsyncSync = (fd) => {
        const file = paths.get(fd) ?? '';
        const fails = boundary === 'object-file' ? file.includes('/package.soul/')
          : boundary === 'journal-file' ? file.startsWith(`${journal}/.`) && file.endsWith('.tmp')
            : published && file === journal;
        if (fails) { injected = true; throw Object.assign(new Error('injected sync failure'), { code: 'EIO' }); }
        return original.sync(fd);
      };
      syncBuiltinESMExports();
      // Before the journal: the raw error. The journal record itself never
      // reached its name: refused. Linked but not synced: uncertain (#1010).
      await assert.rejects(editSoulRevision(f.id, f.copy, { ...f.options, reason: 'No ack', apply: true }), {
        code: { 'object-file': 'EIO', 'journal-file': 'revision-storage-failed', 'journal-directory': 'revision-publication-uncertain' }[boundary] });
    } finally {
      fs.openSync = original.open; fs.closeSync = original.close; fs.fsyncSync = original.sync; fs.linkSync = original.link; syncBuiltinESMExports();
    }
    assert(injected); assert.deepEqual(definition(tree(f.directory)), before);
    assert.deepEqual(existsSync(mirror) ? readFileSync(mirror) : null, mirrorBefore);
    assert(!existsSync(join(journal, '.lock')));
    assert.equal(revisionHistory(f.id, f.options).length, boundary === 'journal-directory' ? 2 : 1);
    // Complete published-but-uncertain JSON is retained; no partial record and no mirror/apply acknowledgment.
    for (const name of readdirSync(journal).filter(name => /^\d{10}\.json$/.test(name))) JSON.parse(readFileSync(join(journal, name), 'utf8'));
    assert(!readdirSync(journal).some(name => name.endsWith('.tmp')));
  });
});

// The agent-comms#77 APFS lab: the hard link that publishes a journal record
// can fail with ENOSPC after the record's data was written and synced
// (#1010). A link that left no final name is a clean refusal; one whose name
// may exist is uncertain. Neither mirrors history or applies files.
test('ENOSPC at the journal link step refuses cleanly or reports uncertainty, never success', posix, async (t) => {
  for (const variant of ['no-name', 'name-created']) await t.test(variant, async (t) => {
    const f = fixture(t), before = definition(tree(f.directory));
    const journal = join(f.options.stateDir, 'soul-revisions', f.id);
    const mirror = join(f.directory, '.soul-state', 'runs', 'revisions.jsonl');
    const mirrorBefore = existsSync(mirror) ? readFileSync(mirror) : null;
    writeFileSync(join(f.copy, 'AGENTS.md'), 'Must not apply');
    const original = fs.linkSync;
    let injected = false;
    try {
      fs.linkSync = (from, to) => {
        if (String(to).startsWith(`${journal}/`) && /\/\d{10}\.json$/.test(String(to))) {
          injected = true;
          if (variant === 'name-created') original(from, to);
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return original(from, to);
      };
      syncBuiltinESMExports();
      await assert.rejects(editSoulRevision(f.id, f.copy, { ...f.options, reason: 'No space', apply: true }), (error) => {
        assert.equal(error.code, variant === 'no-name' ? 'revision-storage-failed' : 'revision-publication-uncertain');
        assert.equal(error.cause?.code, 'ENOSPC');
        assert.match(error.message, variant === 'no-name' ? /not published \(ENOSPC\); nothing was recorded/ : /may have been published/);
        return true;
      });
    } finally { fs.linkSync = original; syncBuiltinESMExports(); }
    assert(injected);
    assert.deepEqual(definition(tree(f.directory)), before, 'no working file applied');
    assert.deepEqual(existsSync(mirror) ? readFileSync(mirror) : null, mirrorBefore, 'no history mirror');
    assert(!existsSync(join(journal, '.lock')));
    assert(!readdirSync(journal).some((name) => name.endsWith('.tmp')));
    assert.equal(revisionHistory(f.id, f.options).length, variant === 'no-name' ? 1 : 2);
    if (variant === 'no-name') {
      // Nothing half-published: once space returns, the same edit records at
      // the same position.
      const record = await editSoulRevision(f.id, f.copy, { ...f.options, reason: 'Space returned', apply: true });
      assert.equal(revisionHistory(f.id, f.options).at(-1).revision, record.revision);
      assert.equal(readFileSync(join(f.directory, 'AGENTS.md'), 'utf8'), 'Must not apply');
    }
  });
});

test('independent apply and record-only writers with one expected head have exactly one winner', async (t) => {
  const f = fixture(t), second = join(f.home, 'second.soul'); cpSync(f.copy, second, { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(f.copy, 'AGENTS.md'), 'Applying candidate');
  writeFileSync(join(second, 'AGENTS.md'), 'Record-only candidate');
  const script = `import { editSoulRevision } from './soul-revisions.mjs';
    const x=JSON.parse(process.argv[1]);
    try { const result=await editSoulRevision(x.id,x.input,{...x.options,apply:x.apply,expectedParent:x.expectedParent,reason:'Concurrent'}); console.log(JSON.stringify(result)); }
    catch(e) { console.error(e.message); process.exitCode=1; }`;
  const run = (input, apply) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ id: f.id, input, apply, options: f.options, expectedParent: f.initial })],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), error;
    const exited = new Promise(done => child.once('close', done));
    const timer = setTimeout(() => { error = 'child exceeded 15-second deadline'; child.kill('SIGKILL'); }, 15_000);
    const collect = (previous, chunk) => {
      const combined = Buffer.concat([previous, chunk]);
      if (combined.length > 16 * 1024) { error = 'child exceeded bounded output'; child.kill('SIGKILL'); }
      return combined.subarray(0, 16 * 1024);
    };
    child.stdout.on('data', x => { stdout = collect(stdout, x); });
    child.stderr.on('data', x => { stderr = collect(stderr, x); });
    child.on('error', e => { error = e.message; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: stdout.toString(), stderr: stderr.toString(), apply, error }); });
    t.after(async () => {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
  });
  const results = await Promise.all([run(f.copy, true), run(second, false)]);
  assert(results.every(x => x.error === undefined), JSON.stringify(results));
  const winners = results.filter(x => x.code === 0), losers = results.filter(x => x.code !== 0);
  assert.equal(winners.length, 1, JSON.stringify(results)); assert.equal(losers.length, 1); assert.match(losers[0].stderr, /stale/);
  const winner=JSON.parse(winners[0].stdout), history=revisionHistory(f.id, f.options);
  assert.equal(history.length, 2); assert.equal(history[1].parentRevision, f.initial); assert.equal(history[1].revision, winner.revision);
  assert.equal(readFileSync(join(f.directory, 'AGENTS.md'), 'utf8'), winners[0].apply ? 'Applying candidate' : 'Original instructions\n');
});
