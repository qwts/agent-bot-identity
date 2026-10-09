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
import { fakePassCli } from './fixtures/fake-pass-cli.mjs';
import { runPass } from '../secret-providers/pass-cli.mjs';
import { ensurePrivateKey } from '../ensure-private-key.mjs';
import { inspectLocalAppCredential } from '../credential-reconciler.mjs';
import { appKeyStores, credentialStores, passCliItem, passCliStore, fileStore, keychainItem, keychainStore, migrateCredentialsCommand,
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

// Windows (GeniusBar ADR-0046 decision 3): a DPAPI stand-in in spawnSync's
// shape. Protect reverses the bytes and Unprotect reverses them back, so a
// round trip proves the seam carries the bytes faithfully with no real
// cryptography; the script arrives on stdin, as the real one must. A
// `protect` or `unprotect` answer replaces the stand-in's own.
function fakePowershell(calls, { protect = null, unprotect = null } = {}) {
  return (file, args, options) => {
    calls.push({ file, args, input: options.input, stdio: options.stdio });
    const protecting = /\$hex = '([0-9a-f]*)'/.exec(options.input);
    if (protecting) return protect ?? { status: 0, stdout: Buffer.from(protecting[1], 'hex').reverse().toString('base64'), stderr: '' };
    const unprotecting = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(options.input);
    if (unprotecting) return unprotect ?? { status: 0, stdout: Buffer.from(unprotecting[1], 'base64').reverse().toString('hex').toUpperCase(), stderr: '' };
    return { status: 1, stdout: '', stderr: 'no such script' };
  };
}

test('on win32 the file store keeps a DPAPI-protected .dpapi file and feeds PowerShell on stdin, never argv', (t) => {
  const { soul, env } = fixture(t);
  const calls = [];
  const store = fileStore({ platform: 'win32', run: fakePowershell(calls) });
  const target = { soulDir: soul, slug: SLUG };
  assert.equal(store.read(target), null);
  store.write(target, { appId: '12345', privateKeyPem: PEM });
  const file = path.join(soul, '.soul-state', 'credentials', `github-app-${SLUG}.dpapi`);
  assert.equal(existsSync(path.join(soul, '.soul-state', 'credentials', `github-app-${SLUG}.json`)), false);
  const stored = readFileSync(file, 'utf8');
  assert.match(stored, /^[A-Za-z0-9+/]+=*\n$/);
  assertNoSecret(stored, 'the .dpapi file');
  assert.deepEqual(store.read(target), { appId: '12345', privateKeyPem: PEM });
  assert.equal(calls.length, 2);
  const hex = Buffer.from(JSON.stringify({ appId: '12345', privateKeyPem: PEM })).toString('hex');
  for (const call of calls) {
    assert.equal(call.file, 'powershell.exe');
    assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
    assert.deepEqual(call.stdio, ['pipe', 'pipe', 'pipe']);
    assertNoSecret(call.args.join(' '), 'powershell argv');
    assert.match(call.input, /ProtectedData\]::(?:Protect|Unprotect)\([^\n]*'CurrentUser'\)/);
    assert.ok(call.input.endsWith('\n\n'), 'the script ends in a blank line so its last statement runs');
  }
  assert.ok(calls[0].input.includes(`$hex = '${hex}'`), 'the credential travels as hex inside the script');
  assert.ok(calls[1].input.includes(`FromBase64String('${stored.trim()}')`));
  // The same store through credentialStores, so every reader of a `file`
  // declaration gets it, and a webhook secret rides along.
  const stores = credentialStores({ env, platform: 'win32', run: fakePowershell(calls) });
  stores.file.write(target, { appId: '12345', privateKeyPem: PEM, webhookSecret: 'hook' });
  assert.deepEqual(stores.file.read(target), { appId: '12345', privateKeyPem: PEM, webhookSecret: 'hook' });
  assert.equal(store.delete(target), true);
  assert.equal(existsSync(file), false);
  assert.equal(store.delete(target), false);
  assert.equal(store.read(target), null);
});

test('on win32 a refused or wrong-shaped DPAPI answer is a typed error that quotes no bytes', (t) => {
  const { soul } = fixture(t);
  const target = { soulDir: soul, slug: SLUG };
  const credential = { appId: '12345', privateKeyPem: PEM };
  const file = path.join(soul, '.soul-state', 'credentials', `github-app-${SLUG}.dpapi`);
  const denied = fileStore({ platform: 'win32', run: fakePowershell([], { protect: { status: 1, stdout: '', stderr: 'Protect failed' } }) });
  assert.throws(() => denied.write(target, credential), { code: 'dpapi-protect-failed' });
  assert.equal(existsSync(file), false, 'nothing is written without a protected value');
  const silent = fileStore({ platform: 'win32', run: fakePowershell([], { protect: { status: 0, stdout: '', stderr: '' } }) });
  assert.throws(() => silent.write(target, credential), { code: 'dpapi-protect-failed' });
  const good = fileStore({ platform: 'win32', run: fakePowershell([]) });
  good.write(target, credential);
  // Another account's file, or another machine's: Unprotect refuses, and the
  // error says so without PowerShell's words.
  const locked = fileStore({ platform: 'win32', run: fakePowershell([], { unprotect: { status: 1, stdout: '', stderr: 'Key not valid for use in specified state.' } }) });
  assert.throws(() => locked.read(target), (error) => error.code === 'dpapi-unprotect-failed' && !error.message.includes('Key not valid'));
  const garbled = fileStore({ platform: 'win32', run: fakePowershell([], { unprotect: { status: 0, stdout: 'not hex at all', stderr: '' } }) });
  assert.throws(() => garbled.read(target), { code: 'dpapi-malformed' });
  const foreign = fileStore({ platform: 'win32', run: fakePowershell([], { unprotect: { status: 0, stdout: Buffer.from('{"nope":1}').toString('hex'), stderr: '' } }) });
  assert.throws(() => foreign.read(target), /stored credential is malformed/);
  // A tampered file never reaches PowerShell.
  const calls = [];
  writeFileSync(file, "not base64 '; Remove-Item\n");
  assert.throws(() => fileStore({ platform: 'win32', run: fakePowershell(calls) }).read(target), /stored credential is malformed/);
  assert.deepEqual(calls, []);
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

function passFixture(t, options = {}) {
  const f = fixture(t, { declare: { app: SLUG, store: 'file' }, ...options });
  const pass = fakePassCli();
  f.stores['pass-cli'] = passCliStore({ env: f.env, cwd: f.home, passRun: pass.run });
  return { ...f, pass };
}

test('pass-cli store names one item per soul/App and round-trips/deletes with no secret argv', (t) => {
  const f = passFixture(t);
  const target = { agentId: id, slug: SLUG };
  const store = f.stores['pass-cli'];
  const credential = { appId: '12345', privateKeyPem: PEM, webhookSecret: 'fake-webhook-secret' };
  assert.equal(passCliItem(id, SLUG), `agent-bot.soul.${id}/github-app/${SLUG}`);
  assert.throws(() => store.read(target), { code: 'missing-item' });
  assert.equal(store.write(target, credential), undefined);
  assert.deepEqual(store.read(target), credential);
  store.write(target, credential);
  assert.equal(f.pass.items.size, 1);
  assert.throws(() => store.write(target, { ...credential, appId: '999' }), { code: 'credential-conflict' });
  assert.deepEqual(store.read(target), credential);
  const other = { agentId: id.replace('44444444-', '55555555-'), slug: SLUG };
  store.write(other, credential);
  assert.equal(f.pass.items.size, 2);
  store.delete(target);
  assert.equal(f.pass.items.size, 1);
  assert.throws(() => store.read(target), { code: 'missing-item' });
  assert.deepEqual(store.read(other), credential);
  assertNoSecret(JSON.stringify(f.pass.calls), 'pass-cli argv');
  assert.ok(!JSON.stringify(f.pass.calls).includes(credential.webhookSecret));
  assert.equal(existsSync(f.env.FAKE_KEYCHAIN), false);
});

test('pass-cli refuses soul-marked read/write/delete before any provider call', (t) => {
  const f = passFixture(t);
  for (const marker of ['AGENT_BOT_ID', 'QWTS_AGENT_ID', 'AGENT_BOT_BINDING', 'GH_AGENT_APP']) {
    const store = passCliStore({ env: { ...f.env, [marker]: id }, cwd: f.home,
      passRun: () => assert.fail('soul must not reach pass-cli') });
    for (const method of ['read', 'write', 'delete']) {
      assert.throws(() => store[method]({ agentId: id, slug: SLUG }, { appId: '12345', privateKeyPem: PEM }), { code: 'owner-only' });
    }
  }
});

test('pass-cli errors never expose provider output, thrown causes, or malformed values', (t) => {
  const f = passFixture(t);
  const target = { agentId: id, slug: SLUG };
  for (const code of ['ENOENT', 'ETIMEDOUT', 'unrecognized']) {
    const injected = () => { throw Object.assign(new Error(PEM), { code, stdout: PEM, stderr: PEM, cause: new Error(PEM) }); };
    for (const run of [() => runPass([], { run: injected, env: f.env }), injected]) {
      const store = passCliStore({ env: f.env, cwd: f.home, passRun: run });
      for (const method of ['read', 'write', 'delete']) {
        assert.throws(() => store[method](target, { appId: '12345', privateKeyPem: PEM }), (error) => {
          assertNoSecret(`${error.stack} ${JSON.stringify(error)}`, 'thrown error');
          assert.equal(error.cause, undefined);
          if (code === 'ENOENT') assert.equal(error.code, 'provider-unavailable');
          return true;
        });
      }
    }
  }
  f.stores['pass-cli'].write(target, { appId: '12345', privateKeyPem: PEM });
  const item = [...f.pass.items.values()][0];
  item.content.note = PEM;
  assert.throws(() => f.stores['pass-cli'].read(target), (error) => {
    assertNoSecret(error.stack, 'malformed credential'); return true;
  });
  const malformed = passCliStore({ env: f.env, cwd: f.home, passRun: () => PEM });
  assert.throws(() => malformed.read(target), (error) => {
    assertNoSecret(error.stack, 'malformed provider JSON'); return true;
  });
});

test('pass-cli refuses ambiguous titles and mismatched provider item identity', (t) => {
  const f = passFixture(t);
  const target = { agentId: id, slug: SLUG };
  f.stores['pass-cli'].write(target, { appId: '12345', privateKeyPem: PEM });
  const item = [...f.pass.items.values()][0];
  f.pass.items.set('duplicate', { ...item, id: 'duplicate' });
  assert.throws(() => f.stores['pass-cli'].read(target), { code: 'ambiguous-item' });
  assert.throws(() => f.stores['pass-cli'].delete(target), { code: 'ambiguous-item' });
  f.pass.items.delete('duplicate');
  const store = passCliStore({ env: f.env, cwd: f.home, passRun: (args, options) => {
    const value = f.pass.run(args, options);
    return args[1] === 'view' ? JSON.stringify({ item: { ...item, id: 'wrong-item' } }) : value;
  } });
  assert.throws(() => store.read(target), /malformed credential data/);
});

test('migration into pass-cli retains file source, declares after readback, and is used by mint/preparation/reconciler', async (t) => {
  const f = passFixture(t, { legacy: false });
  const credential = { appId: '12345', privateKeyPem: PEM, webhookSecret: 'fake-webhook-secret' };
  f.stores.file.write({ soulDir: f.soul, slug: SLUG }, credential);
  const out = [];
  const verified = [];
  const options = { ...f.opts, stores: f.stores, markers: () => [], gate: ownerGate,
    verify: async (value) => { verified.push(value.appId); }, write: (text) => out.push(text) };
  const dry = await migrateCredentialsCommand(['--all', '--to', 'pass-cli', '--dry-run', '--json'], options);
  assert.equal(dry.souls[0].status, 'would-migrate');
  assert.equal(f.pass.calls.length, 0);
  assert.equal(verified.length, 0);
  const report = await migrateCredentialsCommand(['--all', '--to', 'pass-cli', '--json'], options);
  assert.equal(report.souls[0].status, 'migrated');
  assert.equal(report.souls[0].store, 'pass-cli');
  assert.deepEqual(soulCredentialsDeclaration(f.soul), { app: SLUG, store: 'pass-cli' });
  assert.deepEqual(f.stores.file.read({ soulDir: f.soul, slug: SLUG }), credential);
  assert.deepEqual(report.deleted, []);
  assert.equal(resolveAppCredential(SLUG, { ...f.opts, stores: f.stores }).source, 'pass-cli');
  const prepared = ensurePrivateKey({ slug: SLUG, env: f.env, home: f.home, stores: f.stores,
    provider: { restore: () => assert.fail('a stored credential must not restore') } });
  assert.equal(prepared.localStatus, 'ready');
  assert.equal(prepared.path, `pass-cli:Agent Identities/${passCliItem(id, SLUG)}`);
  assert.equal(inspectLocalAppCredential({ slug: SLUG, ...f.opts, stores: f.stores }).status, 'ready');
  const again = await migrateCredentialsCommand(['--all', '--to', 'pass-cli'], options);
  assert.equal(again.souls[0].status, 'already-migrated');
  assert.equal(f.pass.items.size, 1);
  assertNoSecret(out.join(''), 'migration stdout');
  assertNoSecret(readFileSync(auditFile(f.opts), 'utf8'), 'migration audit');
  assertNoSecret(readFileSync(path.join(f.soul, 'soul.json'), 'utf8'), 'declaration');
  f.stores['pass-cli'].delete({ agentId: id, slug: SLUG });
  assert.throws(() => resolveAppCredential(SLUG, { ...f.opts, stores: f.stores }), { code: 'missing-item' });
  assert.throws(() => ensurePrivateKey({ slug: SLUG, env: f.env, home: f.home, stores: f.stores }), { code: 'missing-item' });
  assert.equal(inspectLocalAppCredential({ slug: SLUG, ...f.opts, stores: f.stores }).status, 'failed');
});

test('pass-cli migration refuses a soul caller, even in dry-run', async (t) => {
  const f = passFixture(t);
  await assert.rejects(() => migrateCredentialsCommand(['--all', '--to', 'pass-cli', '--dry-run'], {
    ...f.opts, env: { ...f.env, AGENT_BOT_ID: id }, stores: f.stores,
    gate: () => assert.fail('soul cannot request approval'), write: () => assert.fail('no output'),
  }), { code: 'owner-only' });
  assert.equal(f.pass.calls.length, 0);
});

test('failed pass-cli migration keeps the declaration and redacts verifier/provider secrets', async (t) => {
  for (const failure of ['verify', 'write', 'readback']) {
    const f = passFixture(t);
    const output = [];
    const store = f.stores['pass-cli'];
    if (failure === 'write') store.write = () => { throw new Error(PEM); };
    if (failure === 'readback') store.read = () => ({ appId: '000', privateKeyPem: PEM });
    const report = await migrateCredentialsCommand(['--all', '--to', 'pass-cli', '--json'], {
      ...f.opts, stores: f.stores, markers: () => [], gate: ownerGate,
      verify: async () => { if (failure === 'verify') throw new Error(PEM); }, write: (text) => output.push(text),
    });
    assert.equal(report.souls[0].status, 'failed');
    assert.equal(soulCredentialsDeclaration(f.soul).store, 'file');
    assertNoSecret(output.join(''), 'failed migration');
    assert.ok(existsSync(path.join(f.home, '.config', SLUG, 'private-key.pem')));
  }
});

// #110: doctor's key-store report reads records and stats the legacy key file;
// it never reads a store or opens the key.
test('appKeyStores names recorded stores and a remaining legacy key file without reading either', (t) => {
  const f = fixture(t);
  const keyFile = path.join(f.home, '.config', SLUG, 'private-key.pem');
  chmodSync(keyFile, 0o000); // an open would fail; lstat still sees the file
  const report = appKeyStores(SLUG, { env: f.env, home: f.home, config: {} });
  assert.deepEqual(report, { slug: SLUG, stores: [{ source: 'soul', store: 'keychain', agentId: id }], legacyKeyFile: true });
  assert.equal(existsSync(f.env.FAKE_KEYCHAIN_LOG), false, 'no Keychain call');
  assertNoSecret(JSON.stringify(report), 'key store report');
  rmSync(keyFile);
  const managed = appKeyStores(SLUG, { env: f.env, home: f.home, config: { identityApps: { [SLUG]: { id: '12345', store: 'pass-cli' } } } });
  assert.equal(managed.legacyKeyFile, false);
  assert.deepEqual(managed.stores.map((entry) => `${entry.source}:${entry.store}`), ['managed-app:pass-cli', 'soul:keychain']);
});

test('appKeyStores reports keyd and platform-default declarations and Apps with no record', (t) => {
  const keyd = fixture(t, { declare: { app: SLUG, store: 'keyd' }, legacy: false });
  assert.deepEqual(appKeyStores(SLUG, { env: keyd.env, home: keyd.home, config: {} }).stores.map((entry) => entry.store), ['keyd']);
  const bare = fixture(t, { declare: { app: SLUG }, legacy: false });
  assert.deepEqual(appKeyStores(SLUG, { env: bare.env, home: bare.home, config: {}, platform: 'linux' }).stores.map((entry) => entry.store), ['file']);
  assert.deepEqual(appKeyStores('other-app', { env: bare.env, home: bare.home, config: {} }), { slug: 'other-app', stores: [], legacyKeyFile: false });
});
