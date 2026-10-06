import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { legacyAppFolderStatus, readAppMetadata } from '../identity-app-store.mjs';
import { registerSoulDir, upsertSoul } from '../agent-population.mjs';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { appConfig } from '../mint-token.mjs';
import { confinementCheck, setConfinementMode } from '../confinement.mjs';
import { normalizeEnvelope } from '../hook-dialects.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, readSoulPackageEntries, soulCredentialsDeclaration,
  validateCredentialsDeclaration, validateSoulPackage } from '../soul-package.mjs';
import { adoptSoulPackage, editSoulRevision, revisionPackagePath } from '../soul-revisions.mjs';
import { spawnSoulTemplate } from '../soul-templates.mjs';
import { credentialStores, fileStore, keychainItem, keychainStore, migrateCredentialsCommand,
  resolveAppCredential } from '../soul-credentials.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_SECURITY = path.join(ROOT, 'tests', 'fixtures', 'fake-security.mjs');
const id = 'agent_44444444-4444-4444-8444-444444444444';
const SLUG = 'you-claude-agent';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
// Any of these in an output means key material leaked.
const LEAKS = ['BEGIN RSA PRIVATE KEY', PEM.split('\n')[1], Buffer.from(JSON.stringify({ appId: '12345', privateKeyPem: PEM })).toString('base64').slice(0, 40)];
const assertNoSecret = (text, label) => { for (const leak of LEAKS) assert.ok(!text.includes(leak), `${label} leaked key material`); };

// A hermetic HOME: census, souls, state, a fake keychain, and a legacy
// ~/.config/<slug> folder. Nothing here touches the real HOME or Keychain.
function fixture(t, { declare = { app: SLUG, store: 'keychain' }, legacy = true } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'soul-credentials-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: path.join(home, 'tmp'),
    AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_CONFIG: path.join(home, 'config.json'),
    AGENT_BOT_SECURITY_BIN: FAKE_SECURITY, FAKE_KEYCHAIN: path.join(home, 'keychain.json'),
    FAKE_KEYCHAIN_LOG: path.join(home, 'keychain.log') };
  writeFileSync(env.AGENT_BOT_CONFIG, '{}');
  const opts = { env, home, cwd: home, file: env.AGENT_BOT_POPULATION_PATH, config: {} };
  const soul = path.join(env.AGENT_BOT_SOULS_HOME, 'Ted.soul');
  mkdirSync(path.join(soul, '.soul-state'), { recursive: true });
  writeFileSync(path.join(soul, '.soul-state', 'agent-id'), id);
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Ted', description: 'Test soul', displaySeed: 'ted',
    preferredHarnesses: [], ...(declare ? { credentials: { github: declare } } : {}), revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(soul, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(soul, 'AGENTS.md'), 'Instructions\n');
  manifest.revision = computePackageRevision(soul);
  writeFileSync(path.join(soul, 'soul.json'), JSON.stringify(manifest));
  upsertSoul({ id, name: 'ted', status: 'active', appSlug: SLUG, spacePath: path.join(home, 'space') }, opts);
  registerSoulDir(id, soul, opts);
  if (legacy) {
    const dir = path.join(home, '.config', SLUG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'app-id'), '12345\n');
    writeFileSync(path.join(dir, 'private-key.pem'), PEM, { mode: 0o600 });
    writeFileSync(path.join(dir, 'bot-uid'), '42\n');
    writeFileSync(path.join(dir, 'bot-avatar-url'), 'https://avatars.githubusercontent.com/u/42?v=4\n');
  }
  const stores = credentialStores({ env });
  return { home, env, opts, soul, stores };
}

test('soul.json credentials name a store and an App, never a secret', () => {
  assert.doesNotThrow(() => validateCredentialsDeclaration({ github: { app: SLUG, store: 'keychain' } }));
  assert.doesNotThrow(() => validateCredentialsDeclaration({ github: { app: SLUG } }));
  assert.throws(() => validateCredentialsDeclaration({ github: { app: SLUG, privateKey: PEM } }), /secrets never go in soul.json/);
  assert.throws(() => validateCredentialsDeclaration({ github: { app: SLUG, store: 'clipboard' } }), /store must be one of/);
  assert.throws(() => validateCredentialsDeclaration({ github: { app: '-----BEGIN' } }), /GitHub App slug/);
  assert.throws(() => validateCredentialsDeclaration({ openai: { key: 'sk-x' } }), /accepts only github/);
  assert.throws(() => validateCredentialsDeclaration('keychain'), /must be an object/);
});

test('a template credentials declaration is carried into every spawned soul; its key store is not', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-credentials-template-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { home, config: {}, env: { HOME: home, AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_STATE_HOME: path.join(home, 'identities'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') },
  stateDir: path.join(home, 'identities'), file: path.join(home, 'population.json') };
  const template = path.join(home, 'Engineer.soul');
  mkdirSync(path.join(template, '.soul-state', 'credentials'), { recursive: true });
  writeFileSync(path.join(template, '.soul-state', 'credentials', `github-app-${SLUG}.json`), 'template key');
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Engineer', description: 'Template', displaySeed: 'template',
    template: true, preferredHarnesses: ['codex'], credentials: { github: { app: SLUG, store: 'file' } },
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(template, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(template, 'AGENTS.md'), 'Instructions\n');
  manifest.revision = computePackageRevision(template);
  writeFileSync(path.join(template, 'soul.json'), JSON.stringify(manifest));
  const spawned = await spawnSoulTemplate(template, { ...options, name: 'Bill' });
  assert.deepEqual(soulCredentialsDeclaration(spawned.soulDir), { app: SLUG, store: 'file' });
  assert.equal(existsSync(path.join(spawned.soulDir, '.soul-state', 'credentials')), false);
  assert.doesNotThrow(() => validateSoulPackage(spawned.soulDir));
});

test('keychain store round-trips through security -i with nothing secret on argv', (t) => {
  const { env, home } = fixture(t);
  const store = keychainStore({ env });
  assert.equal(store.read({ agentId: id, slug: SLUG }), null);
  store.write({ agentId: id, slug: SLUG }, { appId: '12345', privateKeyPem: PEM });
  assert.deepEqual(store.read({ agentId: id, slug: SLUG }), { appId: '12345', privateKeyPem: PEM });
  const items = JSON.parse(readFileSync(env.FAKE_KEYCHAIN, 'utf8'));
  assert.deepEqual(Object.keys(items), [`agent-bot.soul.${id}\u0000github-app/${SLUG}`]);
  assert.deepEqual(keychainItem(id, SLUG), { service: `agent-bot.soul.${id}`, account: `github-app/${SLUG}` });
  assertNoSecret(readFileSync(path.join(home, 'keychain.log'), 'utf8'), 'security argv');
});

test('file store round-trips under a 0700 directory with 0600 files and refuses loosened modes', (t) => {
  const { soul } = fixture(t);
  const store = fileStore();
  assert.equal(store.read({ soulDir: soul, slug: SLUG }), null);
  store.write({ soulDir: soul, slug: SLUG }, { appId: '12345', privateKeyPem: PEM });
  const dir = path.join(soul, '.soul-state', 'credentials');
  const file = path.join(dir, `github-app-${SLUG}.json`);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.read({ soulDir: soul, slug: SLUG }), { appId: '12345', privateKeyPem: PEM });
  chmodSync(file, 0o644);
  assert.throws(() => store.read({ soulDir: soul, slug: SLUG }), /readable by others/);
  chmodSync(file, 0o600);
  chmodSync(dir, 0o755);
  assert.throws(() => store.read({ soulDir: soul, slug: SLUG }), /readable by others/);
});

test('mint resolution reads the soul store first, then legacy with a one-time notice', (t) => {
  const { env, home, stores, soul } = fixture(t);
  const notes = [];
  const warn = (text) => notes.push(text);
  const legacy = resolveAppCredential(SLUG, { agentId: id, env, home, cwd: home, stores, warn });
  assert.equal(legacy.source, 'legacy');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /deprecated/);
  assertNoSecret(notes[0], 'deprecation notice');
  resolveAppCredential(SLUG, { agentId: id, env, home, cwd: home, stores, warn });
  assert.equal(notes.length, 1, 'the notice is shown once');
  // A different key in the soul store wins over the legacy folder.
  const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherPem = other.export({ type: 'pkcs1', format: 'pem' });
  stores.keychain.write({ agentId: id, slug: SLUG }, { appId: '777', privateKeyPem: otherPem });
  const fromStore = resolveAppCredential(SLUG, { agentId: id, env, home, cwd: home, stores, warn });
  assert.equal(fromStore.source, 'keychain');
  assert.equal(fromStore.appId, '777');
  // appConfig (the mint path) takes the same order without being told the soul:
  // the census names which soul declares the App.
  const config = appConfig({ argv: ['node', 'mint-token.mjs', '--app', SLUG], env: { ...env, AGENT_BOT_ID: undefined }, home, cwd: home, config: {},
    resolveCredential: (slug, options) => resolveAppCredential(slug, { ...options, stores, warn }) });
  assert.equal(config.appId, '777');
  // No store and no legacy folder is an error naming paths, not keys.
  rmSync(path.join(home, '.config', SLUG), { recursive: true });
  rmSync(env.FAKE_KEYCHAIN);
  assert.throws(() => resolveAppCredential(SLUG, { agentId: id, env, home, cwd: home, stores, warn }), /no soul key store holds it/);
  assert.ok(soul);
});

test('pack, revisions and template spawn never include .soul-state/credentials', async (t) => {
  const { soul, opts, stores } = fixture(t, { declare: { app: SLUG, store: 'file' } });
  const before = computePackageRevision(soul);
  stores.file.write({ soulDir: soul, slug: SLUG }, { appId: '12345', privateKeyPem: PEM });
  assert.equal(computePackageRevision(soul), before);
  const { entries } = readSoulPackageEntries(soul);
  assert.ok(entries.every((entry) => !entry.path.startsWith('.soul-state')));
  for (const entry of entries) assertNoSecret(entry.bytes.toString('utf8'), entry.path);
  const stateDir = opts.env.AGENT_BOT_STATE_HOME;
  mintAgentIdentity({ ...opts, stateDir, idFactory: () => id, useGithub: false });
  adoptSoulPackage(id, soul, { ...opts, stateDir });
  const edited = await editSoulRevision(id, soul, { ...opts, stateDir, reason: 'test' });
  const snapshot = revisionPackagePath(id, edited.revision, { ...opts, stateDir });
  assert.equal(existsSync(path.join(snapshot, '.soul-state')), false);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [readFileSync(path.join(dir, entry.name), 'utf8')]);
  for (const text of walk(snapshot)) assertNoSecret(text, 'revision snapshot');
});

const ownerGate = async () => ({ method: 'consent' });

test('migrate-credentials is refused from a soul, dry run included', async (t) => {
  const { env, home, stores } = fixture(t);
  for (const argv of [['--all'], ['--all', '--dry-run'], ['--soul', id, '--json']]) {
    await assert.rejects(migrateCredentialsCommand(argv, { env: { ...env, AGENT_BOT_ID: id }, home, cwd: home, stores,
      gate: ownerGate, verify: async () => true, write: () => {} }), /owner only; this caller has a soul's Agent ID/);
  }
  assert.equal(existsSync(env.FAKE_KEYCHAIN), false, 'nothing was written');
});

test('migrate-credentials copies into the store, verifies, reports removable keys and deletes nothing', async (t) => {
  const { env, home, stores, soul } = fixture(t, { declare: null });
  const out = [];
  const common = { env, home, cwd: home, stores, platform: 'darwin', markers: () => [], write: (text) => out.push(text) };
  const dry = await migrateCredentialsCommand(['--all', '--dry-run', '--json'], { ...common,
    gate: async () => { throw new Error('a dry run needs no approval'); }, verify: async () => { throw new Error('not in a dry run'); } });
  assert.equal(dry.souls[0].status, 'would-migrate');
  assert.deepEqual(dry.apps[0].metadata, { status: 'would-migrate', fields: ['id', 'botUid', 'botAvatarUrl'] });
  assert.equal(dry.apps[0].legacyFolderRemovable, false);
  assert.equal(loadConfig({ env, home }).identityApps, undefined);
  assert.equal(existsSync(env.FAKE_KEYCHAIN), false);
  const verified = [];
  const gated = [];
  const report = await migrateCredentialsCommand(['--soul', 'ted', '--json'], { ...common,
    gate: async (action) => { gated.push(action); return { method: 'consent' }; },
    verify: async (credential) => { verified.push(credential.appId); return true; } });
  assert.deepEqual(gated, [`identity migrate-credentials ${id}`]);
  assert.deepEqual(verified, ['12345']);
  assert.equal(report.souls[0].status, 'migrated');
  assert.equal(report.souls[0].store, 'keychain');
  assert.deepEqual(report.removableLegacyKeys, [path.join(home, '.config', SLUG, 'private-key.pem')]);
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(report.apps[0].metadata, { status: 'migrated', fields: ['id', 'botUid', 'botAvatarUrl'] });
  assert.equal(report.apps[0].legacyFolderRemovable, true);
  assert.deepEqual(report.apps[0].remainingFiles, []);
  assert.match(report.apps[0].removalCommand, /^rm -rf -- /);
  assert.deepEqual(loadConfig({ env, home }).identityApps[SLUG], { id: '12345', botUid: '42', botAvatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4' });
  assert.equal(readFileSync(path.join(home, '.config', SLUG, 'private-key.pem'), 'utf8'), PEM, 'the legacy key is untouched');
  assert.deepEqual(soulCredentialsDeclaration(soul), { app: SLUG, store: 'keychain' });
  assert.doesNotThrow(() => validateSoulPackage(soul));
  assert.deepEqual(stores.keychain.read({ agentId: id, slug: SLUG }), { appId: '12345', privateKeyPem: PEM });
  const again = await migrateCredentialsCommand(['--all', '--json'], { ...common, gate: ownerGate, verify: async () => true });
  assert.equal(again.souls[0].status, 'already-migrated');
  // Nothing printed, audited, or recorded in the census carries the key.
  assertNoSecret(out.join(''), 'stdout');
  assertNoSecret(readFileSync(env.AGENT_BOT_POPULATION_PATH, 'utf8'), 'census');
  const audit = readFileSync(auditFile({ env, home }), 'utf8');
  assert.match(audit, /"event":"credential-migrate"/);
  assertNoSecret(audit, 'audit');
});

test('a failed live check reports the soul as failed and keeps the legacy key', async (t) => {
  const { env, home, stores } = fixture(t);
  const report = await migrateCredentialsCommand(['--all', '--json'], { env, home, cwd: home, stores, platform: 'darwin',
    markers: () => [], write: () => {}, gate: ownerGate, verify: async () => { throw new Error('GitHub refused the stored key (GET /app -> 401)'); } });
  assert.equal(report.souls[0].status, 'failed');
  assert.deepEqual(report.removableLegacyKeys, []);
  assert.equal(legacyAppFolderStatus(SLUG, { env, home, stores }).legacyFolderRemovable, false);
  assert.ok(existsSync(path.join(home, '.config', SLUG, 'private-key.pem')));
});

test('the CLI refuses a soul and prints no key material', (t) => {
  const { env, home } = fixture(t);
  const run = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'identity', 'migrate-credentials', '--all', '--json'],
    { env: { ...env, AGENT_BOT_ID: id }, cwd: home, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /"code":"owner-only"/);
  assertNoSecret(run.stdout + run.stderr, 'CLI output');
});

function guard(t) {
  const f = fixture(t);
  const envelope = (payload, harness = 'claude') => normalizeEnvelope({ dialectKey: harness, event: 'pre-tool-use', payload: { cwd: f.home, ...payload } });
  const check = (payload, harness) => confinementCheck(envelope(payload, harness), { ...f.opts, binding: { agentId: id } });
  return { ...f, check };
}

test('confinement denies a soul its key store, the legacy folder and secret-store CLIs in every tool', async (t) => {
  const { soul, home, check, opts } = guard(t);
  const denied = (result) => assert.equal(result.decision, 'deny', JSON.stringify(result));
  const allowed = (result) => assert.equal(result.decision, 'allow', JSON.stringify(result));
  const keyFile = path.join(soul, '.soul-state', 'credentials', `github-app-${SLUG}.json`);
  denied(check({ tool_name: 'Read', tool_input: { file_path: keyFile } }));
  denied(check({ tool_name: 'Write', tool_input: { file_path: keyFile } }));
  denied(check({ tool_name: 'Grep', tool_input: { pattern: 'x', path: path.join(soul, '.soul-state', 'credentials') } }));
  denied(check({ tool_name: 'Read', tool_input: { file_path: path.join(home, '.config', SLUG, 'private-key.pem') } }));
  denied(check({ tool_name: 'Read', tool_input: { file_path: path.join(home, '.config', SLUG, 'app-id') } }));
  denied(check({ tool_name: 'Bash', tool_input: { command: `security find-generic-password -s agent-bot.soul.${id} -w` } }));
  denied(check({ tool_name: 'Bash', tool_input: { command: 'cd /tmp && /usr/bin/security dump-keychain' } }));
  denied(check({ tool_name: 'Bash', tool_input: { command: 'pass-cli item view --vault x' } }));
  denied(check({ tool_name: 'Bash', tool_input: { command: `cat ~/.config/${SLUG}/private-key.pem` } }));
  denied(check({ tool_name: 'Bash', tool_input: { command: 'tar czf /tmp/x.tgz .soul-state/credentials' } }));
  denied(check({ tool_name: 'exec_command', tool_input: { cmd: 'env FOO=1 security list-keychains' } }, 'codex'));
  // The daemon's grant key and agent-bot-keyd's sockets (#397).
  const state = path.join(opts.env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'agent-bot');
  denied(check({ tool_name: 'Read', tool_input: { file_path: path.join(state, 'vouch-key.pem') } }));
  denied(check({ tool_name: 'Read', tool_input: { file_path: path.join(state, 'keyd', 'audit.jsonl') } }));
  denied(check({ tool_name: 'Bash', tool_input: { command: `nc -U ${path.join(state, 'keyd', 'owner.sock')}` } }));
  denied(check({ tool_name: 'Bash', tool_input: { command: 'cat ~/.local/state/agent-bot/vouch-key.pem' } }));
  allowed(check({ tool_name: 'Bash', tool_input: { command: 'cargo test -p keyd' } }));
  allowed(check({ tool_name: 'Bash', tool_input: { command: 'git commit -m "security fix"' } }));
  allowed(check({ tool_name: 'Bash', tool_input: { command: 'grep -r security docs' } }));
  allowed(check({ tool_name: 'Read', tool_input: { file_path: path.join(soul, 'AGENTS.md') } }));
  // Mode off turns the write guard off, never the credential guard.
  await setConfinementMode(id, 'off', { ...opts, gate: ownerGate });
  denied(check({ tool_name: 'Bash', tool_input: { command: 'security find-generic-password -w' } }));
  // The owner (no soul marker) is not a soul and is not guarded.
  const env = { ...opts.env };
  const owner = confinementCheck(normalizeEnvelope({ dialectKey: 'claude', event: 'pre-tool-use',
    payload: { cwd: home, tool_name: 'Bash', tool_input: { command: 'security find-generic-password -w' } } }), { ...opts, env, binding: null });
  allowed(owner);
});

test('metadata migration handles previously migrated keys, then all readers survive owner removal', async (t) => {
  const { env, home, stores, soul } = fixture(t);
  stores.keychain.write({ agentId: id, slug: SLUG }, { appId: '12345', privateKeyPem: PEM });
  const before = readFileSync(path.join(soul, 'soul.json'), 'utf8');
  const report = await migrateCredentialsCommand(['--all', '--json'], { env, home, cwd: home, stores,
    markers: () => [], gate: ownerGate, verify: async () => true, write: () => {} });
  assert.equal(report.souls[0].status, 'already-migrated');
  assert.equal(report.apps[0].metadata.status, 'migrated');
  assert.equal(report.apps[0].legacyFolderRemovable, true);
  assert.equal(readFileSync(path.join(soul, 'soul.json'), 'utf8'), before);
  assert.equal(legacyAppFolderStatus(SLUG, { env, home, stores }).legacyFolderRemovable, true);
  rmSync(path.join(home, '.config', SLUG), { recursive: true }); // owner action, test only
  assert.equal(readAppMetadata(SLUG, { env, home }).botUid, '42');
  const credential = resolveAppCredential(SLUG, { env, home, stores, cwd: home });
  assert.equal(credential.source, 'keychain');
  assert.equal(credential.appId, '12345');
  assert.ok(credential.privateKeyPem === PEM);
});

test('one selected soul cannot make a shared legacy folder removable for an unmigrated soul', async (t) => {
  const { env, home, stores, opts } = fixture(t);
  upsertSoul({ id: 'agent_55555555-5555-4555-8555-555555555555', name: 'other', status: 'active', appSlug: SLUG, spacePath: path.join(home, 'other-space') }, opts);
  const report = await migrateCredentialsCommand(['--soul', 'ted', '--json'], { env, home, cwd: home, stores,
    markers: () => [], gate: ownerGate, verify: async () => true, write: () => {} });
  assert.equal(report.souls[0].status, 'migrated');
  assert.equal(report.apps[0].legacyFolderRemovable, false);
  assert.deepEqual(report.apps[0].remainingFiles, ['private-key.pem']);
  assert.deepEqual(report.removableLegacyKeys, []);
  assert.equal(report.apps[0].removalCommand, null);
});

test('migration reports unknown remaining files and never deletes them', async (t) => {
  const { env, home, stores } = fixture(t);
  writeFileSync(path.join(home, '.config', SLUG, 'owner-notes.txt'), 'keep');
  const report = await migrateCredentialsCommand(['--all'], { env, home, cwd: home, stores,
    markers: () => [], gate: ownerGate, verify: async () => true, write: () => {} });
  assert.equal(report.apps[0].legacyFolderRemovable, false);
  assert.deepEqual(report.apps[0].remainingFiles, ['owner-notes.txt']);
  assert.equal(readFileSync(path.join(home, '.config', SLUG, 'owner-notes.txt'), 'utf8'), 'keep');
});
