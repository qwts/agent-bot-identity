import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgentIdentity } from '../agent-identity.mjs';
import { listSouls, showSoul, soulDirectory } from '../agent-population.mjs';
import { computePackageRevision, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { editSoulRevision, revisionHistory, revisionPackagePath } from '../soul-revisions.mjs';
import { soulDisplayFilename, spawnSoulTemplate, templateSpawnCommand } from '../soul-templates.mjs';
import { createSoulHomes } from '../soul-home.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { HARNESS_SESSION_EVENT } from '../executor-contract.mjs';

function fixture(t, formatVersion = 2) {
  const home = mkdtempSync(join(tmpdir(), 'soul-templates-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const template = join(home, 'Principal SW Engineer.soul');
  const options = { home, config: {}, env: { HOME: home, AGENT_BOT_SOULS_HOME: join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: join(home, 'spaces'), AGENT_BOT_STATE_HOME: join(home, 'identities'),
    AGENT_BOT_POPULATION_PATH: join(home, 'population.json') },
    stateDir: join(home, 'identities'), file: join(home, 'population.json') };
  mkdirSync(template);
  const manifest = { formatVersion, ...(formatVersion === 2 ? { ignore: PACKAGE_IGNORE_LIST } : {}),
    name: 'Principal SW Engineer', description: 'Engineering template', displaySeed: 'template', template: true,
    preferredHarnesses: ['codex'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, future: { kept: true } };
  writeFileSync(join(template, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(join(template, 'AGENTS.md'), 'Engineering instructions\n');
  mkdirSync(join(template, 'empty'));
  writeFileSync(join(template, 'run'), '#!/bin/sh\n');
  chmodSync(join(template, 'run'), 0o755);
  writeFileSync(join(template, 'unknown.bin'), Buffer.from([0, 255, 17]));
  for (const candidate of GENERATED_HARNESS_PATHS) {
    const file = candidate.endsWith('/') ? `${candidate}generated.txt` : candidate;
    mkdirSync(join(template, file, '..'), { recursive: true });
    writeFileSync(join(template, file), 'generated output');
  }
  mkdirSync(join(template, '.soul-state'));
  writeFileSync(join(template, '.soul-state', 'agent-id'), 'template-marker');
  if (formatVersion === 2) symlinkSync('/missing/worktree', join(template, 'worktrees'));
  else {
    mkdirSync(join(template, 'worktrees'));
    writeFileSync(join(template, 'worktrees', 'checkout.txt'), 'working state');
  }
  manifest.revision = computePackageRevision(template);
  writeFileSync(join(template, 'soul.json'), JSON.stringify(manifest));
  return { home, template, options, manifest };
}
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

for (const formatVersion of [1, 2]) test(`format ${formatVersion}: independent instances preserve template and exclude working files`, async (t) => {
  const f = fixture(t, formatVersion);
  const before = readFileSync(join(f.template, 'soul.json'));
  const templateRevision = computePackageRevision(f.template);
  const billy = await spawnSoulTemplate(f.template, { ...f.options, name: 'Billy', harness: 'codex' });
  const shiela = await spawnSoulTemplate(f.template, { ...f.options, name: 'Shiela' });
  assert.notEqual(billy.id, shiela.id);
  assert.notEqual(billy.revision, shiela.revision);
  assert.notEqual(billy.genesis.revision, shiela.genesis.revision);
  assert.equal(billy.genesis.parentSoul, null);
  assert.equal(billy.soulDir, join(f.home, 'souls', 'Billy - Principal SW Engineer.soul'));
  assert.equal(shiela.soulDir, join(f.home, 'souls', 'Shiela - Principal SW Engineer.soul'));
  for (const soul of [billy, shiela]) {
    const manifest = json(join(soul.soulDir, 'soul.json'));
    assert.equal(manifest.displaySeed, soul.id);
    assert.equal(manifest.name, soul.displayName);
    assert.equal(manifest.template, false);
    assert.equal(manifest.templateRevision, templateRevision);
    assert.deepEqual(manifest.future, { kept: true });
    assert.equal(manifest.formatVersion, 2);
    assert.equal(validateSoulPackage(soul.soulDir).revision, soul.revision);
    assert.equal(soulDirectory(soul.id, f.options), soul.soulDir);
    assert.equal(showSoul(soul.id, f.options).soulDir, soul.soulDir);
    assert.match(showSoul(soul.id, f.options).name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(readFileSync(join(soul.soulDir, '.soul-state', 'agent-id'), 'utf8').trim(), soul.id);
    assert.deepEqual(readdirSync(join(soul.soulDir, '.soul-state')), ['agent-id']);
    assert.equal(existsSync(join(soul.soulDir, 'worktrees')), false);
    for (const file of GENERATED_HARNESS_PATHS) assert.equal(existsSync(join(soul.soulDir, file)), false, file);
    assert.deepEqual(readFileSync(join(soul.soulDir, 'unknown.bin')), Buffer.from([0, 255, 17]));
    assert.ok(existsSync(join(soul.soulDir, 'empty')));
    const history = revisionHistory(soul.id, f.options);
    assert.deepEqual(history.map((r) => r.revision), [soul.genesis.revision, soul.revision]);
    assert.deepEqual(history.map((r) => r.parentRevision), [null, soul.genesis.revision]);
    assert.equal(readAgentIdentity(soul.id, f.options).genesis.revision, history[0].revision);
  }
  assert.deepEqual(readFileSync(join(f.template, 'soul.json')), before);
  assert.equal(computePackageRevision(f.template), templateRevision);
  assert.equal(readFileSync(join(f.template, 'AGENTS.md'), 'utf8'), 'Engineering instructions\n');
  assert.equal(listSouls(f.options).length, 2);
});

test('filename sanitization preserves case, spaces and Unicode, replaces invalid characters and trims suffix', async (t) => {
  const f = fixture(t);
  const name = 'Billy/Ops: v2?';
  const soul = await spawnSoulTemplate(f.template, { ...f.options, name });
  assert.equal(soul.displayName, `${name} - Principal SW Engineer`);
  assert.equal(soul.soulDir, join(f.home, 'souls', 'Billy-Ops- v2- - Principal SW Engineer.soul'));
  assert.equal(soulDisplayFilename('É Billy/\\:*?"<>|\u0000\u001f\u007f.  '), 'É Billy------------.soul');
  assert.equal(soulDisplayFilename('Billy - Engineer...  '), 'Billy - Engineer.soul');
});

test('existing directories, sanitization collisions and dangling links refuse without allocating identities', async (t) => {
  const f = fixture(t);
  const first = await spawnSoulTemplate(f.template, { ...f.options, name: 'Billy/Ops' });
  const before = readFileSync(join(first.soulDir, 'soul.json'));
  await assert.rejects(spawnSoulTemplate(f.template, { ...f.options, name: 'Billy/Ops' }), /already exists/);
  await assert.rejects(spawnSoulTemplate(f.template, { ...f.options, name: 'Billy:Ops' }), /already exists/);
  symlinkSync('/does/not/exist', join(f.home, 'souls', 'Shiela - Principal SW Engineer.soul'));
  await assert.rejects(spawnSoulTemplate(f.template, { ...f.options, name: 'Shiela' }), /already exists/);
  assert.equal(readdirSync(f.options.stateDir).filter((name) => name.endsWith('.json')).length, 1);
  assert.deepEqual(readFileSync(join(first.soulDir, 'soul.json')), before);
});

test('instance AGENTS.md edit appends only its own history', async (t) => {
  const f = fixture(t);
  const billy = await spawnSoulTemplate(f.template, { ...f.options, name: 'Billy' });
  const shiela = await spawnSoulTemplate(f.template, { ...f.options, name: 'Shiela' });
  const siblingHistory = revisionHistory(shiela.id, f.options);
  const templateBefore = computePackageRevision(f.template);
  writeFileSync(join(billy.soulDir, 'AGENTS.md'), 'Focus on operational reliability.\n');
  const edited = await editSoulRevision(billy.id, billy.soulDir, { ...f.options, reason: 'Tailor Billy focus' });
  assert.equal(edited.parentRevision, billy.revision);
  assert.equal(revisionHistory(billy.id, f.options).length, 3);
  assert.equal(readFileSync(join(revisionPackagePath(billy.id, edited.revision, f.options), 'AGENTS.md'), 'utf8'), 'Focus on operational reliability.\n');
  assert.equal(readAgentIdentity(billy.id, f.options).id, billy.id);
  assert.deepEqual(revisionHistory(shiela.id, f.options), siblingHistory);
  assert.equal(computePackageRevision(shiela.soulDir), shiela.revision);
  assert.equal(computePackageRevision(f.template), templateBefore);
  assert.equal(readFileSync(join(f.template, 'AGENTS.md'), 'utf8'), 'Engineering instructions\n');
});

test('ordinary unmarked packages work, invalid input does not mint, and CLI wires --name and --harness', async (t) => {
  const f = fixture(t);
  const manifest = { ...f.manifest };
  delete manifest.template;
  writeFileSync(join(f.template, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(f.template);
  writeFileSync(join(f.template, 'soul.json'), JSON.stringify(manifest));
  for (const args of [[], [f.template], [f.template, '--name'], [f.template, '--name', 'Billy', '--extra', 'x'],
    [f.template, '--name', 'Billy', '--name', 'Other']]) await assert.rejects(templateSpawnCommand(args), /usage/);
  await assert.rejects(spawnSoulTemplate(f.template, { ...f.options, name: ' ' }), /nonempty/);
  await assert.rejects(spawnSoulTemplate(f.template, { ...f.options, name: 'Billy', harness: '../bad' }), /harness/);
  const result = spawnSync(process.execPath, [new URL('../agent-bot.mjs', import.meta.url).pathname,
    'soul', 'spawn', f.template, '--name', 'Billy', '--harness', 'codex'],
  { env: { ...process.env, ...f.options.env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const soul = JSON.parse(result.stdout);
  assert.equal(soul.harness, 'codex');
  assert.equal(soulDirectory(soul.id, f.options), soul.soulDir);
  writeFileSync(join(f.template, 'AGENTS.md'), 'unsealed edit');
  await assert.rejects(spawnSoulTemplate(f.template, { ...f.options, name: 'Shiela' }), /revision mismatch/);
  assert.equal(listSouls(f.options).length, 1);
});

test('named daemon launch provisions the initialized instance rather than the template', async (t) => {
  const f = fixture(t);
  let binding;
  const homes = createSoulHomes({ ...f.options, bindings: {
    findAgent: () => binding,
    bind: (input) => { binding = { ...input, file: join(input.gitDir, 'agent-binding.json') }; },
  }, install: async () => {} });
  const reports = [];
  let spawned;
  const launch = createLaunchHandler({ file: join(f.home, 'launch.json'),
    spawnPackage: async ({ package: packagePath, name, harness }) => {
      spawned = await spawnSoulTemplate(packagePath, { ...f.options, name, harness });
      return spawned;
    }, identities: () => { throw new Error('unexpected existing soul'); },
    lookupBinding: () => null, provisionHome: homes,
    executorFor: ({ cwd }) => async ({ appendEvent }) => {
      assert.equal(cwd, join(spawned.soulDir, '.soul-state', 'home'));
      const manifest = json(join(cwd, 'soul.json'));
      assert.equal(manifest.name, 'Billy - Principal SW Engineer');
      assert.equal(manifest.displaySeed, spawned.id);
      assert.equal(manifest.revision, spawned.revision);
      appendEvent(HARNESS_SESSION_EVENT, {});
    },
  });
  await launch({ requestId: 'named-spawn', account: 'worker', package: f.template, name: 'Billy', harness: 'codex' },
    { account: 'worker', report: async (row) => { reports.push(row); } });
  assert.deepEqual(reports, [{ requestId: 'named-spawn', status: 'launched', agentId: spawned.id }]);
  assert.equal(json(join(f.template, 'soul.json')).name, 'Principal SW Engineer');
});

test('failed instance initialization retires its identity and removes the incomplete directory', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'spaces'), 'cannot create a space beneath a file');
  await assert.rejects(spawnSoulTemplate(f.template, { ...f.options, name: 'Billy' }));
  assert.deepEqual(readdirSync(join(f.home, 'souls')), []);
  const identityFile = readdirSync(f.options.stateDir).find((name) => name.endsWith('.json'));
  assert.equal(json(join(f.options.stateDir, identityFile)).status, 'retired');
  assert.equal(listSouls(f.options).length, 0);
  assert.equal(validateSoulPackage(f.template).revision, f.manifest.revision);
});
