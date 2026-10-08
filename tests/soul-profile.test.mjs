import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertSoul } from '../agent-population.mjs';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { readSoulProfile, readSoulProfileFile, soulProfileCommand } from '../soul-profile.mjs';
import { readSoulEnvironment } from '../soul-env.mjs';
import { createDaemonServer, daemonClient } from '../agent-daemon.mjs';
import { listSopDocuments } from '../sop.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const OTHER = 'agent_12345678-1234-4234-8234-123456789def';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SENTINEL = 'NEVER-RETURN-THIS-SECRET';
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json') };
  const options = { env, home };
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'profile-fixture.soul');
  const file = env.AGENT_BOT_POPULATION_PATH;
  const manifest = { formatVersion: 1, name: 'Fixture Package', description: 'A read-only profile fixture',
    displaySeed: 'profile', preferredHarnesses: ['claude'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null,
    template: false, credentials: { github: { app: 'fixture-app', store: 'file' } } };
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  put(path.join(dir, 'AGENTS.md'), '# Fixture\n');
  put(path.join(dir, 'soul.md'), 'Soul instructions\n');
  put(path.join(dir, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review changes\n---\nRead the diff.\n');
  put(path.join(dir, 'skills', 'review', 'assets', 'image.bin'), Buffer.from([0, 255, 128]));
  manifest.revision = computePackageRevision(dir);
  put(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  buildSoulDirectory(dir);
  put(path.join(dir, '.claude', 'settings.local.json'), '{"permissions":{}}\n');
  put(path.join(dir, '.codex', 'config.toml'), 'model = "fixture"\n');
  put(path.join(dir, '.soul-state', 'agent-id'), ID);
  put(path.join(dir, '.soul-state', 'credentials', 'github-app-fixture-app.json'), SENTINEL);
  put(path.join(dir, '.soul-state', 'home', 'AGENTS.md'), '# Provisioned instructions\n');
  put(path.join(dir, '.soul-state', 'home', '.claude', 'settings.json'), '{}\n');
  for (const denied of ['.env', '.codex/auth.json', '.claude/credentials.json', 'skills/review/.env.local',
    'skills/review/private-key.pem', 'skills/review/secrets/password.txt', 'skills/review/token.json',
    'skills/review/node_modules/index.js', 'skills/review/.git/config', '.soul-state/home/.codex/auth.json']) put(path.join(dir, denied), SENTINEL);
  mintAgentIdentity({ stateDir: stateDirectory(options), idFactory: () => ID,
    harness: 'codex', appSlug: null, useGithub: false });
  upsertSoul({ id: ID, name: 'profile-fixture', displayName: 'Profile Fixture', soulDir: dir, spacePath: path.join(home, 'space'),
    status: 'active', parentId: null, appSlug: null }, { file });
  return { home, env, options, dir, file, manifest };
}

function cli(f, ...args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'profile', ...args], {
    cwd: f.home, env: { ...f.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000,
  });
}

// Reading must not alter file contents, permissions or timestamps (atime is
// intentionally excluded: it is filesystem bookkeeping for any ordinary read).
function snapshot(root) {
  const entries = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), stat = statSync(file);
      entries.push([path.relative(root, file), stat.mode, stat.mtimeMs, entry.isFile() ? readFileSync(file).toString('base64') : null]);
      if (entry.isDirectory()) walk(file);
    }
  }
  walk(root);
  return entries;
}

test('profile has the complete JSON contract, package and generated files, skills and names only', (t) => {
  const f = fixture(t), before = snapshot(f.home);
  const result = readSoulProfile(ID, f.options);
  assert.deepEqual(Object.keys(result), ['agentId', 'profile', 'files', 'skills', 'credentials', 'sop', 'errors']);
  assert.deepEqual(result.profile, { name: 'profile-fixture', displayName: 'Profile Fixture', description: f.manifest.description,
    harness: 'codex', package: f.dir, revision: f.manifest.revision, template: false, appearance: null, skillsDisabled: [], parentId: null, status: 'active' });
  assert.deepEqual(result.credentials, [{ name: 'fixture-app', provider: 'github', status: 'declared' }]);
  assert.deepEqual(result.skills, [{ name: 'review', source: 'soul', path: 'skills/review/SKILL.md', commit: null, enabled: true }]);
  assert.deepEqual(result.sop, { resolved: null, override: null });
  assert.deepEqual(result.errors, []);
  const files = new Map(result.files.map((file) => [file.path, file]));
  for (const [name, kind] of Object.entries({ 'soul.json': 'soul', 'soul.md': 'soul', 'AGENTS.md': 'context',
    'CLAUDE.md': 'generated', 'GEMINI.md': 'generated', '.claude/settings.local.json': 'harness-settings',
    '.codex/config.toml': 'harness-settings', '.claude/skills/review/SKILL.md': 'generated', '.gemini/skills/review/SKILL.md': 'generated',
    'skills/review/SKILL.md': 'skill', '.soul-state/home/AGENTS.md': 'context', '.soul-state/home/.claude/settings.json': 'harness-settings' })) {
    const file = files.get(name);
    assert.ok(file, name);
    assert.deepEqual(Object.keys(file), ['path', 'kind', 'size', 'modifiedAt', 'text']);
    assert.equal(file.kind, kind);
    assert.equal(file.size, statSync(path.join(f.dir, name)).size);
    assert.equal(file.modifiedAt, statSync(path.join(f.dir, name)).mtime.toISOString());
    assert.equal(file.text, true);
  }
  assert.equal(files.get('skills/review/assets/image.bin').text, false);
  assert.ok(!result.files.some((file) => /credentials|auth\.json|private-key|\.env|node_modules|\.git\//.test(file.path)));
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  assert.deepEqual(snapshot(f.home), before);
});

test('profile and CLI expose declared appearance or null without changing the package', (t) => {
  const f = fixture(t);
  assert.equal(JSON.parse(cli(f, ID, '--json').stdout).profile.appearance, null);
  for (const hue of [0, 359]) {
    put(path.join(f.dir, 'soul.json'), JSON.stringify({ ...f.manifest, appearance: { hue } }));
    const before = snapshot(f.home);
    assert.deepEqual(readSoulProfile(ID, f.options).profile.appearance, { hue });
    const result = cli(f, ID, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).profile.appearance, { hue });
    assert.match(cli(f, ID).stdout, new RegExp(`appearance: \\{"hue":${hue}\\}`));
    assert.deepEqual(snapshot(f.home), before);
  }
  for (const appearance of [null, {}, { hue: 360 }, { hue: 1.5 }, { hue: '120' }, { hue: 120, extra: true }]) {
    put(path.join(f.dir, 'soul.json'), JSON.stringify({ ...f.manifest, appearance }));
    const result = readSoulProfile(ID, f.options);
    assert.equal(result.profile.appearance, null);
    assert.ok(result.errors.some((error) => error.area === 'profile' && /appearance/.test(error.message)));
  }
});

test('profile reports skills.disabled as written, flags each skill, and names unknown skills without failing', (t) => {
  const f = fixture(t);
  put(path.join(f.dir, 'skills', 'other', 'SKILL.md'), '---\nname: other\ndescription: Other\n---\nOther.\n');
  put(path.join(f.dir, 'sop', 'skills', 'review', 'SKILL.md'), '# SOP skill\n');
  const soul = (result) => result.skills.filter((skill) => skill.source === 'soul');
  put(path.join(f.dir, 'soul.json'), JSON.stringify({ ...f.manifest, skills: { disabled: ['review', 'later'] } }));
  const before = snapshot(f.home);
  const result = readSoulProfile(ID, f.options);
  assert.deepEqual(result.profile.skillsDisabled, ['review', 'later']);
  assert.deepEqual(soul(result), [
    { name: 'other', source: 'soul', path: 'skills/other/SKILL.md', commit: null, enabled: true },
    { name: 'review', source: 'soul', path: 'skills/review/SKILL.md', commit: null, enabled: false },
  ]);
  // The SOP skill of the same name is not switched off by the declaration.
  assert.deepEqual(result.skills.filter((skill) => skill.source === 'sop'),
    [{ name: 'review', source: 'sop', path: 'sop/skills/review/SKILL.md', commit: null, enabled: true }]);
  assert.deepEqual(result.errors.filter((error) => error.area === 'skills'),
    [{ area: 'skills', message: 'skills.disabled names a skill the package does not have: later' }]);
  const json = cli(f, ID, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).profile.skillsDisabled, ['review', 'later']);
  const plain = cli(f, ID);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^skillsDisabled: \["review","later"\]$/m);
  assert.match(plain.stdout, /^review \(soul, disabled\) skills\/review\/SKILL\.md commit: -$/m);
  assert.match(plain.stdout, /^other \(soul\) skills\/other\/SKILL\.md commit: -$/m);
  assert.match(plain.stdout, /^skills: skills\.disabled names a skill the package does not have: later$/m);
  assert.deepEqual(snapshot(f.home), before);
  // Absent and empty declarations enable everything and report nothing.
  for (const manifest of [f.manifest, { ...f.manifest, skills: { disabled: [] } }]) {
    put(path.join(f.dir, 'soul.json'), JSON.stringify(manifest));
    const enabled = readSoulProfile(ID, f.options);
    assert.deepEqual(enabled.profile.skillsDisabled, []);
    assert.ok(enabled.skills.every((skill) => skill.enabled === true));
    assert.deepEqual(enabled.errors.filter((error) => error.area === 'skills'), []);
  }
  // An invalid declaration switches nothing off and is reported once.
  for (const skills of [null, {}, { disabled: 'review' }, { disabled: ['review', 'review'] }, { disabled: ['Review'] }, { disabled: [], extra: true }]) {
    put(path.join(f.dir, 'soul.json'), JSON.stringify({ ...f.manifest, skills }));
    const invalid = readSoulProfile(ID, f.options);
    assert.deepEqual(invalid.profile.skillsDisabled, []);
    assert.ok(invalid.skills.every((skill) => skill.enabled === true));
    assert.deepEqual(invalid.errors.filter((error) => error.area === 'skills'), [{ area: 'skills', message: 'Invalid skills declaration.' }]);
  }
});

test('handle and display-name resolution match show; unknown and ambiguous souls fail', (t) => {
  const f = fixture(t);
  assert.deepEqual(readSoulProfile('profile-fixture', f.options), readSoulProfile(ID, f.options));
  assert.deepEqual(readSoulProfile('Profile Fixture', f.options), readSoulProfile(ID, f.options));
  for (const target of [OTHER, 'no-such-soul']) assert.throws(() => readSoulProfile(target, f.options), { code: 'soul-not-found' });
  upsertSoul({ id: OTHER, name: 'another', displayName: 'Profile Fixture', spacePath: path.join(f.home, 'other'), status: 'active' }, { file: f.file });
  assert.throws(() => readSoulProfile('Profile Fixture', f.options), /name is shared/);
});

test('CLI supports JSON, plain sections, exact contents, and error exits', (t) => {
  const f = fixture(t);
  const json = cli(f, 'profile-fixture', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), readSoulProfile(ID, f.options));
  const plain = cli(f, ID);
  assert.equal(plain.status, 0, plain.stderr);
  for (const section of ['files', 'skills', 'credentials']) assert.match(plain.stdout, new RegExp(`\\n${section} \\(\\d+\\)`));
  assert.match(plain.stdout, /\nsop\n/);
  const contents = cli(f, ID, '--file', 'AGENTS.md');
  assert.equal(contents.status, 0, contents.stderr);
  assert.equal(contents.stdout, '# Fixture\n');
  const fileJson = cli(f, ID, '--file', 'AGENTS.md', '--json');
  assert.deepEqual(JSON.parse(fileJson.stdout), { agentId: ID, path: 'AGENTS.md', size: 10, contents: '# Fixture\n' });
  const unknown = cli(f, 'no-such-soul', '--json');
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'soul-not-found');
  for (const args of [[], [ID, '--file'], [ID, '--unknown'], [ID, '--json', '--json'], [ID, 'extra']]) {
    assert.throws(() => soulProfileCommand(args, { ...f.options, write: () => {} }), /usage:/);
  }
});

test('file reads deny traversal, secrets, binary, links and special paths; enforce byte limits', (t) => {
  const f = fixture(t);
  rmSync(path.join(f.dir, 'soul.md'));
  symlinkSync(path.join(f.dir, '.soul-state', 'credentials', 'github-app-fixture-app.json'), path.join(f.dir, 'SOUL.md'));
  symlinkSync(path.join(f.dir, '.soul-state'), path.join(f.dir, 'skills', 'escape'));
  linkSync(path.join(f.dir, '.soul-state', 'credentials', 'github-app-fixture-app.json'), path.join(f.dir, 'skills', 'review', 'linked.md'));
  for (const file of ['../soul.json', './AGENTS.md', '/AGENTS.md', 'C:/AGENTS.md', 'skills\\review\\SKILL.md',
    '.soul-state/credentials/github-app-fixture-app.json', '.codex/auth.json', '.env', 'SOUL.md',
    'skills/escape/credentials/github-app-fixture-app.json', 'skills/review/linked.md', 'skills/review/assets/image.bin', 'AGENTS.md\0']) {
    assert.throws(() => readSoulProfileFile(ID, file, f.options), { code: 'soul-profile-file-denied' }, file);
  }
  const result = readSoulProfile(ID, f.options);
  assert.ok(!result.files.some((file) => /SOUL.md|escape|linked/.test(file.path)));
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  assert.throws(() => readSoulProfileFile(ID, 'AGENTS.md', { ...f.options, maxBytes: 9 }), { code: 'soul-profile-file-too-large' });
  rmSync(path.join(f.dir, 'SOUL.md'));
  put(path.join(f.dir, 'soul.md'), 'x'.repeat(256 * 1024));
  assert.equal(readSoulProfileFile(ID, 'soul.md', f.options).size, 256 * 1024);
  put(path.join(f.dir, 'soul.md'), 'x'.repeat(256 * 1024 + 1));
  assert.throws(() => readSoulProfileFile(ID, 'soul.md', { ...f.options, maxBytes: 1024 * 1024 }), { code: 'soul-profile-file-too-large' });
  const tooLarge = cli(f, ID, '--file', 'soul.md', '--json');
  assert.equal(tooLarge.status, 1);
  assert.equal(JSON.parse(tooLarge.stdout).error.code, 'soul-profile-file-too-large');
});

test('moved directory lookup and offline SOP overrides never write or run commands', (t) => {
  const f = fixture(t), moved = path.join(path.dirname(f.dir), 'moved.soul');
  renameSync(f.dir, moved);
  put(path.join(moved, 'agent-sop.toml'), `schema_version = 1\n[repos]\norg = "example/org@${'a'.repeat(40)}"\nsop = "example/sop@${'b'.repeat(40)}"\n`);
  put(path.join(moved, 'workflows', 'review.toml'), 'sop = ["guide.md"]\n');
  put(path.join(moved, 'sop', 'guide.md'), 'Local reference\n');
  // If the reader tries any external helper, there are none on PATH.
  const options = { ...f.options, env: { ...f.env, PATH: '/nonexistent' } };
  const before = snapshot(f.home), result = readSoulProfile(ID, options);
  assert.equal(result.profile.package, moved);
  assert.deepEqual(result.sop, { resolved: null, override: { path: 'agent-sop.toml', workflows: ['workflows/review.toml'] } });
  assert.ok(result.errors.some((error) => error.area === 'sop' && /offline/.test(error.message)));
  assert.deepEqual(result.skills.filter((skill) => skill.source === 'sop'), []);
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(JSON.parse(readFileSync(f.file)).souls[ID].soulDir, f.dir);
});

test('local SOP skills are available offline; cached SOP reads retain pinned commits without writes', (t) => {
  const f = fixture(t);
  put(path.join(f.dir, 'sop', 'skills', 'review-sop', 'SKILL.md'), '# SOP skill\n');
  const before = snapshot(f.home);
  const result = readSoulProfile(ID, f.options);
  assert.deepEqual(result.skills.filter((skill) => skill.source === 'sop'), [
    { name: 'review-sop', source: 'sop', path: 'sop/skills/review-sop/SKILL.md', commit: null, enabled: true },
  ]);
  assert.deepEqual(result.sop, { resolved: null, override: { path: 'sop', workflows: [] } });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(snapshot(f.home), before);
  const commit = 'c'.repeat(40);
  const report = { inEffect: true, repositories: { sop: { repository: 'example/sop', commit } } };
  const options = { ...f.options, offline: true, runGit: () => assert.fail('offline must not run git') };
  assert.throws(() => listSopDocuments(report, options), { code: 'documents-unavailable-offline' });
  assert.deepEqual(snapshot(f.home), before);
  const cache = path.join(stateDirectory(f.options), 'sop-cache', commit);
  put(path.join(cache, 'skills', 'pinned', 'SKILL.md'), '# Pinned skill\n');
  const cachedBefore = snapshot(f.home);
  assert.deepEqual(listSopDocuments(report, options), [{ path: 'skills/pinned/SKILL.md', source: 'sop', commit }]);
  assert.deepEqual(snapshot(f.home), cachedBefore);
});

test('partial profiles retain nulls and arrays; inventory is capped at 500', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 510; i++) put(path.join(f.dir, 'skills', 'review', 'references', `${i}.md`), 'reference');
  const capped = readSoulProfile(ID, f.options);
  assert.equal(capped.files.length, 500);
  assert.ok(capped.errors.some((error) => error.area === 'files' && /truncated/.test(error.message)));
  rmSync(f.dir, { recursive: true });
  const partial = readSoulProfile(ID, f.options);
  assert.equal(partial.profile.package, null);
  assert.equal(partial.profile.revision, null);
  assert.equal(partial.profile.template, null);
  assert.equal(partial.profile.appearance, null);
  assert.deepEqual(partial.files, []);
  assert.deepEqual(partial.skills, []);
  assert.deepEqual(partial.credentials, []);
  assert.deepEqual(partial.sop, { resolved: null, override: null });
  assert.ok(partial.errors.length);
});

test('daemon profile uses population authentication and matches the direct reader and client helper', async (t) => {
  const f = fixture(t);
  const server = createDaemonServer({ ...f.options, config: {}, token: 'profile-test-token-at-least-32-characters' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const route = `/v0/soul/profile?agentId=${ID}`;
  assert.equal((await fetch(base + route)).status, 401);
  const headers = { authorization: 'Bearer profile-test-token-at-least-32-characters' };
  const response = await fetch(base + route, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), readSoulProfile(ID, f.options));
  assert.equal((await fetch(`${base}/v0/soul/profile`, { headers })).status, 400);
  const missing = await fetch(`${base}/v0/soul/profile?agentId=${OTHER}`, { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'soul-not-found');
  put(f.env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port,
    token: 'profile-test-token-at-least-32-characters', pid: process.pid, startedAt: new Date().toISOString() }));
  const client = daemonClient(f.options);
  assert.deepEqual(await client.soulProfile('Profile Fixture'), readSoulProfile(ID, f.options));
});

test('daemon env route sits beside profile: same authentication, the direct descriptor, and a client helper (#583)', async (t) => {
  const f = fixture(t);
  const server = createDaemonServer({ ...f.options, config: {}, token: 'profile-test-token-at-least-32-characters' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const route = `/v0/soul/env?agentId=${ID}`;
  assert.equal((await fetch(base + route)).status, 401);
  const headers = { authorization: 'Bearer profile-test-token-at-least-32-characters' };
  const response = await fetch(base + route, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaVersion, 1);
  assert.deepEqual(body.engine.capabilities, ['env', 'revision-prepare', 'runtimes', 'providers', 'tool-homes', 'memory', 'history', 'template-name', 'template-refresh', 'launch-parent', 'migrate-complete', 'env-clean', 'env-export', 'env-import']);
  assert.deepEqual(body, readSoulEnvironment(ID, f.options));
  assert.ok(!JSON.stringify(body).includes(SENTINEL));
  assert.equal((await fetch(`${base}/v0/soul/env`, { headers })).status, 400);
  const missing = await fetch(`${base}/v0/soul/env?agentId=${OTHER}`, { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'soul-not-found');
  put(f.env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port,
    token: 'profile-test-token-at-least-32-characters', pid: process.pid, startedAt: new Date().toISOString() }));
  const client = daemonClient(f.options);
  assert.deepEqual(await client.soulEnvironment('Profile Fixture'), readSoulEnvironment(ID, f.options));
});
