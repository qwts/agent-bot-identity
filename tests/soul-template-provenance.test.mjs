// Template provenance, the template rename migration and the maintained
// files refresh (GeniusBar#287). Everything runs under one temp HOME per
// fixture: a bundled template (AGENT_BOT_STARTER_TEMPLATE), the souls
// root, the census, the state and the audit file. Nothing touches the real
// HOME or any secret store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentIdentity } from '../agent-identity.mjs';
import { recordSoulDisplayName, showSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { readSoulEnvironment } from '../soul-env.mjs';
import { TEMPLATE_NAME_STEP_ID, MIGRATION_OPERATIONS, soulEnvMigrateCommand } from '../soul-env-migrate.mjs';
import { readMigrationJournal, readMigrationStep } from '../soul-migration-journal.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateMaintainedDeclaration, validateSoulPackage } from '../soul-package.mjs';
import { editSoulRevision, revisionHistory } from '../soul-revisions.mjs';
import { maintainedPath, planTemplateRefresh, soulTemplateRefreshCommand } from '../soul-template-refresh.mjs';
import { instanceTemplateName, planTemplateRename, resolveInstanceTemplate, spawnSoulTemplate, templateNames, templateOwnedName } from '../soul-templates.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date('2026-10-07T10:00:00Z');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const SKILL = (text) => `---\nname: app-guide\ndescription: ${text}\n---\n# App guide\n${text}\n`;

// Rewrites a package's soul.json with the given fields and a recomputed
// revision, as a release that renames or updates a bundled template would.
function seal(directory, patch = {}) {
  const manifest = { ...json(path.join(directory, 'soul.json')), ...patch };
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete manifest[key];
  manifest.revision = `sha256:${'0'.repeat(64)}`;
  writeFileSync(path.join(directory, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(directory);
  writeFileSync(path.join(directory, 'soul.json'), JSON.stringify(manifest));
  return manifest;
}

// Every regular file under a directory with its bytes (base64), for
// byte-identical comparisons; `skip` names relative paths left out.
function files(directory, skip = []) {
  const result = {};
  function walk(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const relative = prefix + name, file = path.join(folder, name), stat = lstatSync(file);
      if (skip.includes(relative)) continue;
      if (stat.isDirectory()) walk(file, `${relative}/`);
      else if (stat.isFile()) result[relative] = `${stat.mode & 0o777}:${readFileSync(file).toString('base64')}`;
    }
  }
  walk(directory);
  return result;
}

function fixture(t, { maintained = ['docs/guide/', 'skills/'] } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-template-provenance-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const template = path.join(home, 'bundle', 'starter.soul');
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_CONFIG: path.join(home, 'no-config'),
    AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_STATE_HOME: path.join(home, 'identities'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'),
    AGENT_BOT_STARTER_TEMPLATE: template };
  put(path.join(template, 'soul.json'), JSON.stringify({ formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Starter', description: 'The first companion',
    displaySeed: 'starter', template: true, preferredHarnesses: ['codex'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null,
    ...(maintained ? { maintained } : {}) }));
  put(path.join(template, 'AGENTS.md'), 'Starter instructions\n');
  put(path.join(template, 'docs', 'guide', 'intro.md'), '# Intro v1\n');
  put(path.join(template, 'docs', 'guide', 'old.md'), '# Old chapter\n');
  put(path.join(template, 'docs', 'other.md'), 'Not maintained v1\n');
  put(path.join(template, 'skills', 'app-guide', 'SKILL.md'), SKILL('v1'));
  seal(template);
  const gates = [];
  const options = { env, home, cwd: home, config: {}, file: env.AGENT_BOT_POPULATION_PATH, stateDir: env.AGENT_BOT_STATE_HOME, now: () => NOW,
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; } };
  const receipts = () => { try { return readFileSync(auditFile({ env, home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; } };
  // The life an instance accumulates: memory in its space, turn history, a
  // tool home, and an AGENTS.md the owner tailored and recorded.
  const live = async (soul, { displayName = null, agents = null } = {}) => {
    put(path.join(soul.soulDir, '.soul-state', 'space', 'notes', 'today.md'), `# Today\nremember ${soul.id}\n`);
    put(path.join(soul.soulDir, '.soul-state', 'runs', 'turns.jsonl'), '{"id":"turn-1","kind":"turn"}\n');
    put(path.join(soul.soulDir, '.soul-state', 'tools', 'codex', 'auth.json'), '{"OPENAI_API_KEY":"never-printed"}');
    if (displayName !== null) recordSoulDisplayName(soul.id, displayName, { file: options.file });
    if (agents !== null) {
      writeFileSync(path.join(soul.soulDir, 'AGENTS.md'), agents);
      await editSoulRevision(soul.id, soul.soulDir, { ...options, soulDir: soul.soulDir, reason: 'Tailor focus' });
    }
    return soul;
  };
  // A manifest written before the provenance fields existed.
  const legacy = (soul) => { seal(soul.soulDir, { templateName: undefined, nameSource: undefined }); return soul; };
  return { home, env, template, options, gates, receipts, live, legacy };
}

const stateFiles = (soulDir) => files(path.join(soulDir, '.soul-state'), ['migration.json', 'runs/revisions.jsonl']);

test('a spawn records the template\'s name and whether the owner kept it; previousNames and maintained stay with the template', async (t) => {
  const f = fixture(t);
  seal(f.template, { previousNames: ['Seed'] });
  const kept = await spawnSoulTemplate(f.template, { ...f.options, name: 'Starter' });
  const chosen = await spawnSoulTemplate(f.template, { ...f.options, name: 'Bob' });
  const keptManifest = json(path.join(kept.soulDir, 'soul.json'));
  assert.deepEqual([keptManifest.name, keptManifest.templateName, keptManifest.nameSource, keptManifest.template], ['Starter - Starter', 'Starter', 'template', false]);
  assert.equal(Object.hasOwn(keptManifest, 'previousNames'), false);
  assert.equal(Object.hasOwn(keptManifest, 'maintained'), false);
  const chosenManifest = json(path.join(chosen.soulDir, 'soul.json'));
  assert.deepEqual([chosenManifest.name, chosenManifest.templateName, chosenManifest.nameSource], ['Bob - Starter', 'Starter', 'user']);
  for (const soul of [kept, chosen]) assert.equal(validateSoulPackage(soul.soulDir).revision, soul.revision);
  // The helpers behind the migration and the refresh.
  assert.deepEqual(templateNames(json(path.join(f.template, 'soul.json'))), ['Starter', 'Seed']);
  assert.deepEqual(templateOwnedName(keptManifest, ['Genius', 'Starter']), { owned: true, templateName: 'Starter' });
  assert.deepEqual(templateOwnedName(chosenManifest, ['Genius', 'Starter']), { owned: false, templateName: 'Starter' });
  assert.deepEqual(templateOwnedName(keptManifest, ['Other']), { owned: false, templateName: null });
  assert.equal(instanceTemplateName({ name: 'Starter - Starter' }, ['Genius', 'Starter']), 'Starter');
  assert.equal(instanceTemplateName({ name: 'Bob - Starter' }, ['Starter']), 'Starter');
  assert.equal(instanceTemplateName({ name: 'Bob' }, ['Starter']), null);
  assert.deepEqual(templateOwnedName({ name: 'Starter - Starter' }, ['Starter']), { owned: true, templateName: 'Starter' });
  assert.deepEqual(templateOwnedName({ name: 'Bob - Starter' }, ['Starter']), { owned: false, templateName: 'Starter' });
  assert.equal(resolveInstanceTemplate(keptManifest, { env: f.env }).package, f.template);
  assert.equal(resolveInstanceTemplate({ name: 'Nobody - Other', templateName: 'Other' }, { env: f.env }), null);
});

test('soul.json validates the provenance fields and the maintained prefixes; manifests without them stay valid', (t) => {
  const f = fixture(t);
  const refuse = (patch, message) => {
    const before = readFileSync(path.join(f.template, 'soul.json'));
    writeFileSync(path.join(f.template, 'soul.json'), JSON.stringify({ ...JSON.parse(before), ...patch }));
    assert.throws(() => computePackageRevision(f.template), message, JSON.stringify(patch));
    writeFileSync(path.join(f.template, 'soul.json'), before);
  };
  refuse({ nameSource: 'nope' }, /nameSource must be one of template, user/);
  refuse({ templateName: ' ' }, /templateName must be a nonempty string/);
  refuse({ previousNames: ['Seed', 'Seed'] }, /previousNames must be an array of unique nonempty strings/);
  refuse({ previousNames: 'Seed' }, /previousNames must be an array/);
  refuse({ maintained: 'docs/' }, /maintained must be an array/);
  refuse({ maintained: ['docs/', 'docs/'] }, /maintained must be an array of unique/);
  for (const bad of ['../x', '/abs/', 'docs/../x', 'docs//guide', './docs', 'C:/x', 'a\\b', '']) refuse({ maintained: [bad] }, /relative path without traversal|unique nonempty/);
  for (const bad of ['soul.json', '.soul-state/', '.soul-state/space/', 'worktrees/']) refuse({ maintained: [bad] }, /may not name the manifest or working state/);
  assert.deepEqual(validateMaintainedDeclaration(['docs/guide/', 'skills/', 'README.md']), ['docs/guide/', 'skills/', 'README.md']);
  assert.equal(validateSoulPackage(f.template).revision, json(path.join(f.template, 'soul.json')).revision);
  seal(f.template, { maintained: undefined, templateName: undefined, nameSource: undefined, previousNames: undefined });
  assert.equal(validateSoulPackage(f.template).revision, json(path.join(f.template, 'soul.json')).revision);
  // Prefix semantics: a trailing slash is the directory and everything in it, a bare path one file.
  assert.deepEqual(['docs/guide', 'docs/guide/a.md', 'docs/guide/sub/b.md', 'docs/guidebook.md', 'docs', 'README.md', 'README.md.bak'].map((p) => maintainedPath(p, ['docs/guide/', 'README.md'])),
    [true, true, true, false, false, true, false]);
});

test('soul env migrate --template-name renames an instance that kept its template\'s name, leaves a chosen name alone, and touches nothing else (GeniusBar#287)', async (t) => {
  const f = fixture(t);
  const kept = await f.live(await spawnSoulTemplate(f.template, { ...f.options, name: 'Starter' }), { displayName: 'Starter', agents: 'Starter instructions\nFocus on the owner\'s calendar.\n' });
  const chosen = await f.live(await spawnSoulTemplate(f.template, { ...f.options, name: 'Bob' }), { displayName: 'Bob' });
  const templateRevision = json(path.join(kept.soulDir, 'soul.json')).templateRevision;
  // The release renames the template and remembers what it was called.
  const genius = seal(f.template, { name: 'Genius', previousNames: ['Starter'] });
  const before = { state: stateFiles(kept.soulDir), package: files(kept.soulDir, ['.soul-state', 'soul.json']), history: revisionHistory(kept.id, f.options), manifest: readFileSync(path.join(kept.soulDir, 'soul.json')) };
  assert.equal(revisionHistory(kept.id, f.options).length, 3, 'genesis, seed, tailored');

  // --plan reads only: no gate, no journal, no revision, nothing written.
  let out = '';
  const write = (value) => { out += value; };
  const planned = await soulEnvMigrateCommand([kept.id, '--template-name', '--plan', '--json'], { ...f.options, write });
  assert.deepEqual(JSON.parse(out), planned);
  assert.deepEqual(Object.keys(planned), ['schemaVersion', 'agentId', 'soulDir', 'operation', 'decision', 'steps', 'root']);
  assert.deepEqual([planned.schemaVersion, planned.agentId, planned.soulDir, planned.operation, planned.decision, planned.root], [1, kept.id, kept.soulDir, TEMPLATE_NAME_STEP_ID, 'planned', kept.soulDir]);
  assert.deepEqual([planned.steps[0].id, planned.steps[0].status, planned.steps[0].from, planned.steps[0].to, planned.steps[0].templateName, planned.steps[0].displayName],
    [TEMPLATE_NAME_STEP_ID, 'pending', 'Starter - Starter', 'Genius - Genius', { from: 'Starter', to: 'Genius' }, { from: 'Starter', to: 'Starter' }]);
  assert.deepEqual(planned.steps[0].template, { name: 'Genius', package: f.template, revision: genius.revision });
  assert.deepEqual(f.gates, []);
  assert.equal(existsSync(path.join(kept.soulDir, '.soul-state', 'migration.json')), false);
  assert.deepEqual(readFileSync(path.join(kept.soulDir, 'soul.json')), before.manifest);
  assert.deepEqual(revisionHistory(kept.id, f.options), before.history);
  assert.deepEqual(f.receipts(), []);

  // The rename: one revision, the census display name, nothing else.
  out = '';
  const result = await soulEnvMigrateCommand(['Starter', '--template-name', '--json', '--principal-stdin'], { ...f.options, write, readStdin: () => '{"principalId":"p1"}' });
  assert.deepEqual(JSON.parse(out), result);
  assert.equal(result.decision, 'renamed');
  const [step] = result.steps;
  assert.deepEqual([step.id, step.status, step.from, step.to, step.at, step.templateName, step.displayName], [TEMPLATE_NAME_STEP_ID, 'done', 'Starter - Starter', 'Genius - Genius', NOW.toISOString(), { from: 'Starter', to: 'Genius' }, { from: 'Starter', to: 'Genius' }]);
  assert.equal(step.note, 'renamed from Starter - Starter to Genius - Genius');
  assert.deepEqual(f.gates, [[`rename ${kept.id} from template name Starter to Genius`, { principalId: 'p1' }]]);
  const manifest = json(path.join(kept.soulDir, 'soul.json'));
  assert.deepEqual([manifest.name, manifest.templateName, manifest.nameSource, manifest.templateRevision, manifest.template, manifest.displaySeed], ['Genius - Genius', 'Genius', 'template', templateRevision, false, kept.id]);
  assert.equal(manifest.revision, step.revision);
  assert.equal(validateSoulPackage(kept.soulDir).revision, step.revision);
  const history = revisionHistory(kept.id, f.options);
  assert.equal(history.length, 4);
  assert.deepEqual([history[3].revision, history[3].parentRevision, history[3].reason, history[3].author], [step.revision, before.history[2].revision, 'Rename from template Starter to Genius', 'user']);
  assert.equal(step.parentRevision, before.history[2].revision);
  // The same soul: Agent ID, folder, marker, identity, memory, turns, tool home, AGENTS.md, every other file.
  assert.equal(showSoul(kept.id, f.options).displayName, 'Genius');
  assert.equal(showSoul(kept.id, f.options).soulDir, kept.soulDir);
  assert.equal(path.basename(kept.soulDir), 'Starter - Starter.soul');
  assert.equal(readFileSync(path.join(kept.soulDir, '.soul-state', 'agent-id'), 'utf8').trim(), kept.id);
  assert.equal(readAgentIdentity(kept.id, f.options).id, kept.id);
  assert.deepEqual(stateFiles(kept.soulDir), before.state);
  assert.deepEqual(files(kept.soulDir, ['.soul-state', 'soul.json']), before.package);
  assert.equal(readFileSync(path.join(kept.soulDir, 'AGENTS.md'), 'utf8'), 'Starter instructions\nFocus on the owner\'s calendar.\n');
  assert.equal(readdirSync(path.join(kept.soulDir, '.soul-state', 'tmp')).length, 0, 'the staging is gone');
  // The history mirror and the journal gained exactly this step.
  const mirrored = readFileSync(path.join(kept.soulDir, '.soul-state', 'runs', 'revisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual([mirrored.length, mirrored.at(-1).id, mirrored.at(-1).reason], [4, step.revision, 'Rename from template Starter to Genius']);
  assert.deepEqual(readMigrationJournal(kept.soulDir), [{ id: TEMPLATE_NAME_STEP_ID, status: 'done', from: 'Starter - Starter', to: 'Genius - Genius', at: NOW.toISOString(), note: step.note }]);
  assert.equal(readMigrationStep(kept.soulDir, TEMPLATE_NAME_STEP_ID).revision, step.revision);
  const receipts = f.receipts().filter((receipt) => receipt.event === 'soul-env-migrate');
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].agentId, receipts[0].operation, receipts[0].decision], [kept.id, TEMPLATE_NAME_STEP_ID, 'renamed']);
  assert.equal(receipts[0].detail, `Starter - Starter -> Genius - Genius (revision ${step.revision}); display name Starter -> Genius`);
  assert.ok(!out.includes('never-printed') && !JSON.stringify(receipts).includes('never-printed'));
  // The descriptor shows the identity under its new names and the step done.
  const descriptor = readSoulEnvironment(kept.id, f.options);
  assert.deepEqual([descriptor.identity.displayName, descriptor.identity.revision], ['Genius', step.revision]);
  assert.deepEqual(descriptor.migration.steps.filter((entry) => entry.id === TEMPLATE_NAME_STEP_ID).map((entry) => entry.status), ['done']);
  assert.ok(descriptor.engine.capabilities.includes('template-name') && descriptor.engine.capabilities.includes('template-refresh'));

  // A second run changes nothing: skipped, still gated, receipted.
  out = '';
  const again = await soulEnvMigrateCommand([kept.id, '--template-name'], { ...f.options, write });
  assert.deepEqual([again.decision, again.steps[0].status, again.steps[0].note, again.steps[0].from, again.steps[0].to], ['skipped', 'skipped', 'already named by the template', 'Genius - Genius', 'Genius - Genius']);
  assert.match(out, new RegExp(`^agentId: ${kept.id}\\nsoulDir: .*\\noperation: template-name\\ndecision: skipped\\n\\ntemplate-name: skipped - already named by the template\\n  from: Genius - Genius\\n  to: Genius - Genius\\n  displayName: Genius -> Genius\\n$`));
  assert.equal(revisionHistory(kept.id, f.options).length, 4);
  assert.equal(json(path.join(kept.soulDir, 'soul.json')).revision, step.revision);
  assert.equal(showSoul(kept.id, f.options).displayName, 'Genius');
  assert.equal(f.receipts().at(-1).decision, 'skipped');

  // A name the owner chose is never changed.
  const chosenBefore = { manifest: readFileSync(path.join(chosen.soulDir, 'soul.json')), history: revisionHistory(chosen.id, f.options) };
  const skipped = await soulEnvMigrateCommand([chosen.id, '--template-name', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([skipped.decision, skipped.steps[0].status, skipped.steps[0].note, skipped.steps[0].from, skipped.steps[0].to, skipped.steps[0].templateName],
    ['skipped', 'skipped', 'the name was chosen by the owner', 'Bob - Starter', null, { from: 'Starter', to: 'Starter' }]);
  assert.deepEqual(readFileSync(path.join(chosen.soulDir, 'soul.json')), chosenBefore.manifest);
  assert.deepEqual(revisionHistory(chosen.id, f.options), chosenBefore.history);
  assert.equal(showSoul(chosen.id, f.options).displayName, 'Bob');
  assert.deepEqual(readMigrationJournal(chosen.soulDir).map((entry) => [entry.id, entry.status]), [[TEMPLATE_NAME_STEP_ID, 'skipped']]);
  assert.ok(MIGRATION_OPERATIONS.includes(TEMPLATE_NAME_STEP_ID));

  // Usage: --plan and --harness belong to one operation each; a plan presents no principal.
  for (const args of [[kept.id, '--plan'], [kept.id, '--template-name', '--harness', 'codex'], [kept.id, '--adopt-host-signin', '--plan'], [kept.id, '--template-name', '--plan', '--principal-stdin'], [kept.id, '--template-name', '--template-name']]) {
    await assert.rejects(soulEnvMigrateCommand(args, { ...f.options, write: () => {} }), /usage: agent-bot soul env migrate/, args.join(' '));
  }
  // The stable CLI: a coded failure prints JSON and exits 1; the help names both commands.
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'migrate', 'nobody', '--template-name', '--json'], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).error.code, 'soul-not-found');
  const help = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', '--help'], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /--space-into-soul \| --template-name \[--plan\]/);
  assert.match(help.stdout, /soul template refresh <agentId\|name> \[--from TEMPLATE_PATH\] \[--plan\]/);
});

test('before the provenance fields, the <template> - <template> pair is the template\'s name and anything else is the owner\'s; a refused gate changes nothing', async (t) => {
  const f = fixture(t);
  const kept = f.legacy(await f.live(await spawnSoulTemplate(f.template, { ...f.options, name: 'Starter' }), { displayName: 'Starter' }));
  const chosen = f.legacy(await f.live(await spawnSoulTemplate(f.template, { ...f.options, name: 'Bob' }), { displayName: 'Bob' }));
  // A CLI spawn records no census display name; its own home, since the folder name is the template's.
  const g = fixture(t);
  const bare = g.legacy(await g.live(await spawnSoulTemplate(g.template, { ...g.options, name: 'Starter' })));
  for (const soul of [kept, chosen, bare]) {
    const manifest = json(path.join(soul.soulDir, 'soul.json'));
    assert.equal(Object.hasOwn(manifest, 'templateName') || Object.hasOwn(manifest, 'nameSource'), false);
  }
  seal(f.template, { name: 'Genius', previousNames: ['Starter'] });
  seal(g.template, { name: 'Genius', previousNames: ['Starter'] });
  assert.deepEqual([planTemplateRename(kept.soulDir, { env: f.env }).status, planTemplateRename(chosen.soulDir, { env: f.env }).status], ['pending', 'skipped']);
  // Nothing without the owner: the gate refusing leaves the manifest, the history and the journal as they were.
  const before = { manifest: readFileSync(path.join(kept.soulDir, 'soul.json')), history: revisionHistory(kept.id, f.options) };
  await assert.rejects(soulEnvMigrateCommand([kept.id, '--template-name'], { ...f.options, write: () => {}, gate: async () => { throw Object.assign(new Error('owner only'), { code: 'owner-required' }); } }), /owner only/);
  assert.deepEqual(readFileSync(path.join(kept.soulDir, 'soul.json')), before.manifest);
  assert.deepEqual(revisionHistory(kept.id, f.options), before.history);
  assert.equal(existsSync(path.join(kept.soulDir, '.soul-state', 'migration.json')), false);
  assert.deepEqual(f.receipts(), []);

  const renamed = await soulEnvMigrateCommand([kept.id, '--template-name', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([renamed.decision, renamed.steps[0].from, renamed.steps[0].to, renamed.steps[0].templateName], ['renamed', 'Starter - Starter', 'Genius - Genius', { from: 'Starter', to: 'Genius' }]);
  const manifest = json(path.join(kept.soulDir, 'soul.json'));
  assert.deepEqual([manifest.name, manifest.templateName, manifest.nameSource], ['Genius - Genius', 'Genius', 'template']);
  assert.equal(showSoul(kept.id, f.options).displayName, 'Genius');
  assert.equal(validateSoulPackage(kept.soulDir).revision, manifest.revision);
  const skipped = await soulEnvMigrateCommand([chosen.id, '--template-name', '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([skipped.decision, skipped.steps[0].note, json(path.join(chosen.soulDir, 'soul.json')).name, showSoul(chosen.id, f.options).displayName], ['skipped', 'the name was chosen by the owner', 'Bob - Starter', 'Bob']);
  // Without a census display name the manifest name is what shows; it is renamed and no display name is invented.
  const plain = await soulEnvMigrateCommand([bare.id, '--template-name', '--json'], { ...g.options, write: () => {} });
  assert.deepEqual([plain.decision, plain.steps[0].displayName, showSoul(bare.id, g.options).displayName ?? null], ['renamed', { from: null, to: null }, null]);
  assert.equal(json(path.join(bare.soulDir, 'soul.json')).name, 'Genius - Genius');
  // An instance of no bundled template, and a template itself, are skipped with the reason.
  seal(f.template, { name: 'Other', previousNames: undefined });
  assert.match(planTemplateRename(chosen.soulDir, { env: f.env }).note, /no bundled template is named Starter/);
  const asTemplate = seal(chosen.soulDir, { template: true });
  assert.equal(asTemplate.template, true);
  assert.equal(planTemplateRename(chosen.soulDir, { env: f.env }).note, 'a template keeps its own name');
  seal(chosen.soulDir, { template: false, templateRevision: undefined });
  assert.equal(planTemplateRename(chosen.soulDir, { env: f.env }).note, 'not spawned from a template');
});

test('soul template refresh replaces only the maintained paths in one revision, keeps the owner\'s edits and the life, and writes nothing when nothing differs', async (t) => {
  const f = fixture(t);
  const soul = await f.live(await spawnSoulTemplate(f.template, { ...f.options, name: 'Starter' }), { displayName: 'Starter', agents: 'Starter instructions\nMy focus.\n' });
  // A file the owner put under a maintained prefix belongs to the template's area and goes with a refresh.
  put(path.join(soul.soulDir, 'docs', 'guide', 'user-notes.md'), 'mine\n');
  const first = json(path.join(soul.soulDir, 'soul.json')).templateRevision;
  // The release updates the guide and a skill, and also its AGENTS.md and an unmaintained doc, which no instance takes.
  put(path.join(f.template, 'docs', 'guide', 'intro.md'), '# Intro v2\n');
  put(path.join(f.template, 'docs', 'guide', 'new.md'), '# New chapter\n');
  rmSync(path.join(f.template, 'docs', 'guide', 'old.md'));
  put(path.join(f.template, 'skills', 'app-guide', 'SKILL.md'), SKILL('v2'));
  put(path.join(f.template, 'AGENTS.md'), 'Starter instructions v2\n');
  put(path.join(f.template, 'docs', 'other.md'), 'Not maintained v2\n');
  const updated = seal(f.template);
  assert.notEqual(updated.revision, first);
  const before = { state: stateFiles(soul.soulDir), history: revisionHistory(soul.id, f.options), manifest: readFileSync(path.join(soul.soulDir, 'soul.json')) };

  let out = '';
  const write = (value) => { out += value; };
  const plan = await soulTemplateRefreshCommand(['refresh', soul.id, '--plan', '--json'], { ...f.options, write });
  assert.deepEqual(JSON.parse(out), plan);
  assert.deepEqual(Object.keys(plan), ['schemaVersion', 'soul', 'template', 'templateRevision', 'maintained', 'added', 'changed', 'removed', 'applied']);
  assert.deepEqual(plan, { schemaVersion: 1, soul: { agentId: soul.id, soulDir: soul.soulDir, revision: json(path.join(soul.soulDir, 'soul.json')).revision },
    template: { name: 'Starter', package: f.template, revision: updated.revision }, templateRevision: first, maintained: ['docs/guide/', 'skills/'],
    added: ['docs/guide/new.md'], changed: ['docs/guide/intro.md', 'skills/app-guide/SKILL.md'], removed: ['docs/guide/old.md', 'docs/guide/user-notes.md'], applied: false });
  assert.deepEqual(f.gates, []);
  assert.deepEqual(readFileSync(path.join(soul.soulDir, 'soul.json')), before.manifest);
  assert.deepEqual(revisionHistory(soul.id, f.options), before.history);
  assert.equal(readFileSync(path.join(soul.soulDir, 'docs', 'guide', 'intro.md'), 'utf8'), '# Intro v1\n');

  out = '';
  const result = await soulTemplateRefreshCommand(['refresh', 'Starter', '--json', '--principal-stdin'], { ...f.options, write, readStdin: () => '{"principalId":"p1"}' });
  assert.deepEqual(JSON.parse(out), result);
  const manifest = json(path.join(soul.soulDir, 'soul.json'));
  assert.deepEqual(result, { ...plan, soul: { ...plan.soul, revision: manifest.revision }, templateRevision: updated.revision, applied: true });
  assert.deepEqual(f.gates, [[`refresh ${soul.id}'s maintained files from template Starter`, { principalId: 'p1' }]]);
  // Exactly the maintained paths follow the template.
  assert.equal(readFileSync(path.join(soul.soulDir, 'docs', 'guide', 'intro.md'), 'utf8'), '# Intro v2\n');
  assert.equal(readFileSync(path.join(soul.soulDir, 'docs', 'guide', 'new.md'), 'utf8'), '# New chapter\n');
  assert.equal(existsSync(path.join(soul.soulDir, 'docs', 'guide', 'old.md')), false);
  assert.equal(existsSync(path.join(soul.soulDir, 'docs', 'guide', 'user-notes.md')), false);
  assert.equal(readFileSync(path.join(soul.soulDir, 'skills', 'app-guide', 'SKILL.md'), 'utf8'), SKILL('v2'));
  // Nothing outside them: the owner's AGENTS.md, the unmaintained doc, the memory, the turns, the tool home, the marker.
  assert.equal(readFileSync(path.join(soul.soulDir, 'AGENTS.md'), 'utf8'), 'Starter instructions\nMy focus.\n');
  assert.equal(readFileSync(path.join(soul.soulDir, 'docs', 'other.md'), 'utf8'), 'Not maintained v1\n');
  assert.deepEqual(stateFiles(soul.soulDir), before.state);
  assert.equal(existsSync(path.join(soul.soulDir, '.soul-state', 'migration.json')), false, 'a refresh is a revision, not a migration step');
  assert.equal(readFileSync(path.join(soul.soulDir, '.soul-state', 'agent-id'), 'utf8').trim(), soul.id);
  assert.equal(showSoul(soul.id, f.options).soulDir, soul.soulDir);
  assert.equal(showSoul(soul.id, f.options).displayName, 'Starter');
  assert.equal(readdirSync(path.join(soul.soulDir, '.soul-state', 'tmp')).length, 0, 'the staging is gone');
  // One revision, provenance updated, the package valid.
  assert.deepEqual([manifest.templateRevision, manifest.templateName, manifest.nameSource, manifest.name, manifest.template], [updated.revision, 'Starter', 'template', 'Starter - Starter', false]);
  assert.equal(validateSoulPackage(soul.soulDir).revision, manifest.revision);
  const history = revisionHistory(soul.id, f.options);
  assert.equal(history.length, before.history.length + 1);
  assert.deepEqual([history.at(-1).revision, history.at(-1).parentRevision, history.at(-1).reason], [manifest.revision, before.history.at(-1).revision, `Refresh maintained files from template Starter ${updated.revision}`]);
  const mirrored = readFileSync(path.join(soul.soulDir, '.soul-state', 'runs', 'revisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual([mirrored.length, mirrored.at(-1).id], [history.length, manifest.revision]);
  const receipts = f.receipts().filter((receipt) => receipt.event === 'soul-template-refresh');
  assert.deepEqual([receipts.length, receipts[0].agentId, receipts[0].operation, receipts[0].decision], [1, soul.id, 'refresh', 'applied']);
  assert.equal(receipts[0].detail, `Starter ${updated.revision}: 1 added, 2 changed, 2 removed; revision ${manifest.revision}`);
  assert.ok(!out.includes('never-printed') && !JSON.stringify(receipts).includes('never-printed'));

  // A second run finds nothing to do: no revision, still gated, receipted as skipped.
  out = '';
  const again = await soulTemplateRefreshCommand(['refresh', soul.id], { ...f.options, write });
  assert.deepEqual([again.applied, again.added, again.changed, again.removed, again.templateRevision], [false, [], [], [], updated.revision]);
  assert.match(out, new RegExp(`^agentId: ${soul.id}\\nsoulDir: .*\\ntemplate: Starter \\(.*\\)\\ntemplateRevision: ${updated.revision}\\nmaintained: docs/guide/, skills/\\napplied: false\\n\\nno maintained file differs\\n$`));
  assert.equal(revisionHistory(soul.id, f.options).length, history.length);
  assert.equal(json(path.join(soul.soulDir, 'soul.json')).revision, manifest.revision);
  assert.equal(f.receipts().at(-1).decision, 'skipped');
  assert.equal(f.gates.length, 2);

  // A refused gate writes nothing.
  put(path.join(f.template, 'docs', 'guide', 'intro.md'), '# Intro v3\n');
  seal(f.template);
  const sealed = readFileSync(path.join(soul.soulDir, 'soul.json'));
  await assert.rejects(soulTemplateRefreshCommand(['refresh', soul.id], { ...f.options, write: () => {}, gate: async () => { throw Object.assign(new Error('owner only'), { code: 'owner-required' }); } }), /owner only/);
  assert.deepEqual(readFileSync(path.join(soul.soulDir, 'soul.json')), sealed);
  assert.equal(readFileSync(path.join(soul.soulDir, 'docs', 'guide', 'intro.md'), 'utf8'), '# Intro v2\n');
  assert.equal(revisionHistory(soul.id, f.options).length, history.length);
});

test('soul template refresh resolves a renamed template, takes --from, and refuses a template without maintained paths, a template itself, and an unknown template', async (t) => {
  const f = fixture(t);
  const soul = await f.live(await spawnSoulTemplate(f.template, { ...f.options, name: 'Starter' }));
  const legacy = f.legacy(await f.live(await spawnSoulTemplate(f.template, { ...f.options, name: 'Bob' })));
  // The bundled template was renamed: its previousNames still find the instance's template.
  put(path.join(f.template, 'docs', 'guide', 'intro.md'), '# Intro v2\n');
  const genius = seal(f.template, { name: 'Genius', previousNames: ['Starter'] });
  const plan = planTemplateRefresh(soul.soulDir, { env: f.env });
  assert.deepEqual([plan.template.name, plan.added, plan.changed, plan.removed, plan.applied], ['Genius', [], ['docs/guide/intro.md'], [], true]);
  // A manifest from before the fields resolves by its name's suffix and gains templateName on refresh.
  const result = await soulTemplateRefreshCommand(['refresh', legacy.id, '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([result.applied, result.template.name, result.templateRevision], [true, 'Genius', genius.revision]);
  const manifest = json(path.join(legacy.soulDir, 'soul.json'));
  assert.deepEqual([manifest.name, manifest.templateName, Object.hasOwn(manifest, 'nameSource'), manifest.templateRevision], ['Bob - Starter', 'Genius', false, genius.revision]);
  assert.equal(readFileSync(path.join(legacy.soulDir, 'docs', 'guide', 'intro.md'), 'utf8'), '# Intro v2\n');

  // --from names the template explicitly, whatever the bundle holds.
  const elsewhere = path.join(f.home, 'elsewhere', 'guide.soul');
  mkdirSync(path.dirname(elsewhere), { recursive: true });
  spawnSync('cp', ['-R', f.template, elsewhere]);
  put(path.join(elsewhere, 'docs', 'guide', 'intro.md'), '# Intro from elsewhere\n');
  const other = seal(elsewhere, { name: 'Other', previousNames: undefined });
  const fromResult = await soulTemplateRefreshCommand(['refresh', soul.id, '--from', elsewhere, '--json'], { ...f.options, write: () => {} });
  assert.deepEqual([fromResult.applied, fromResult.template, fromResult.changed], [true, { name: 'Other', package: elsewhere, revision: other.revision }, ['docs/guide/intro.md']]);
  assert.equal(readFileSync(path.join(soul.soulDir, 'docs', 'guide', 'intro.md'), 'utf8'), '# Intro from elsewhere\n');
  assert.deepEqual([json(path.join(soul.soulDir, 'soul.json')).templateRevision, json(path.join(soul.soulDir, 'soul.json')).templateName], [other.revision, 'Starter']);

  // Refusals, coded, before the gate.
  const gates = f.gates.length;
  const code = (promise, expected) => assert.rejects(promise, (error) => error.code === expected || assert.fail(`${error.code}: ${error.message}`));
  seal(elsewhere, { maintained: undefined });
  await code(soulTemplateRefreshCommand(['refresh', soul.id, '--from', elsewhere], { ...f.options, write: () => {} }), 'template-not-maintained');
  seal(f.template, { name: 'Unrelated', previousNames: undefined });
  await code(soulTemplateRefreshCommand(['refresh', soul.id], { ...f.options, write: () => {} }), 'template-not-found');
  await assert.rejects(soulTemplateRefreshCommand(['refresh', soul.id], { ...f.options, write: () => {} }), (error) => /--from TEMPLATE_PATH/.test(error.action));
  seal(soul.soulDir, { template: true });
  await code(soulTemplateRefreshCommand(['refresh', soul.id, '--from', f.template], { ...f.options, write: () => {} }), 'soul-is-template');
  await code(soulTemplateRefreshCommand(['refresh', 'nobody'], { ...f.options, write: () => {} }), 'soul-not-found');
  await code(soulTemplateRefreshCommand(['refresh', soul.id, '--from', path.join(f.home, 'missing.soul')], { ...f.options, write: () => {} }), 'soul-is-template');
  seal(soul.soulDir, { template: false });
  await assert.rejects(soulTemplateRefreshCommand(['refresh', soul.id, '--from', path.join(f.home, 'missing.soul')], { ...f.options, write: () => {} }), /is not a soul package/);
  rmSync(path.join(soul.soulDir, '.soul-state'), { recursive: true });
  await code(soulTemplateRefreshCommand(['refresh', soul.id], { ...f.options, write: () => {} }), 'soul-state-missing');
  assert.equal(f.gates.length, gates, 'nothing reached the gate');
  for (const args of [[], ['refresh'], ['list', soul.id], ['refresh', soul.id, '--from'], ['refresh', soul.id, '--plan', '--principal-stdin'], ['refresh', soul.id, 'extra'], ['refresh', soul.id, '--nope']]) {
    await assert.rejects(soulTemplateRefreshCommand(args, { ...f.options, write: () => {} }), /usage: agent-bot soul template refresh/, args.join(' '));
  }
  // The stable CLI: a coded failure prints JSON and exits 1.
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'template', 'refresh', 'nobody', '--json'], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).error.code, 'soul-not-found');
  const plain = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'template', 'refresh', 'nobody'], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /^agent-bot soul template refresh: soul-not-found: Soul not found\./);
});
