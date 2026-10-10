import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { credentialGuard } from '../confinement.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appStoreTarget, legacyAppFolderStatus, migrateAppMetadata, readAppMetadata, readManagedAppCredential, writeAppMetadata } from '../identity-app-store.mjs';
import { loadConfig } from '../config.mjs';
import { botUid } from '../setup-worktree.mjs';
import { cachedBotAvatarUrl } from '../gh-pr-view-json.mjs';
import { appConfig } from '../mint-token.mjs';
import { inspectLocalAppCredential } from '../credential-reconciler.mjs';
import { credentialStores } from '../soul-credentials.mjs';
import { migrateCredentialsCommand } from '../soul-credential-migration.mjs';
import { main as doctor } from '../doctor.mjs';
import { buildReadinessReport, readinessCheck } from '../readiness.mjs';

const slug = 'fixture-app';
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'app-metadata-'));
  const env = { HOME: home, PATH: process.env.PATH };
  const legacy = path.join(home, '.config', slug);
  mkdirSync(legacy, { recursive: true });
  for (const [name, value] of Object.entries({ 'app-id': '123', 'bot-uid': '456', 'bot-avatar-url': 'https://avatars.githubusercontent.com/u/456?v=4' })) {
    writeFileSync(path.join(legacy, name), `${value}\n`);
  }
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env, legacy };
}

test('public metadata prefers the App record, falls back by field and survives legacy removal', async (t) => {
  const f = fixture(t);
  assert.equal(readAppMetadata(slug, f).id, '123');
  writeAppMetadata(slug, { id: '987' }, f);
  assert.equal(readAppMetadata(slug, f).id, '987');
  assert.equal(readAppMetadata(slug, f).botUid, '456');
  assert.equal(readManagedAppCredential(slug, f), null, 'metadata alone must not shadow a soul/legacy key');
  writeAppMetadata(slug, { botUid: '789', botAvatarUrl: 'https://avatars.githubusercontent.com/u/789?v=4' }, f);
  assert.equal(await botUid(slug, 'https://unused.invalid', null, { ...f, fetchImpl: () => assert.fail('network') }), '789');
  assert.equal(cachedBotAvatarUrl(slug, f.home), 'https://avatars.githubusercontent.com/u/789?v=4');
  rmSync(f.legacy, { recursive: true });
  assert.deepEqual(readAppMetadata(slug, f), { id: '987', botUid: '789', botAvatarUrl: 'https://avatars.githubusercontent.com/u/789?v=4' });
  assert.equal(await botUid(slug, 'https://unused.invalid', null, { ...f, fetchImpl: () => assert.fail('network') }), '789');
  assert.equal(legacyAppFolderStatus(slug, f).legacyFolderExists, false);
});

test('mint and read-only credential inspection prefer config issuer with a remaining legacy key', (t) => {
  const f = fixture(t);
  writeAppMetadata(slug, { id: '987' }, f);
  writeFileSync(path.join(f.legacy, 'private-key.pem'), 'fixture-key');
  const credential = appConfig({ ...f, cwd: f.home, argv: ['node', 'mint', '--app', slug] });
  assert.equal(credential.appId, '987');
  assert.ok(credential.privateKeyPem === 'fixture-key');
  rmSync(path.join(f.legacy, 'app-id'));
  assert.equal(inspectLocalAppCredential({ ...f, slug, validateKey: () => true }).status, 'ready');
});

test('removal report blocks unknown files, mismatched metadata and symlinks', (t) => {
  const f = fixture(t);
  migrateAppMetadata(slug, f);
  assert.equal(legacyAppFolderStatus(slug, f).legacyFolderRemovable, true);
  writeFileSync(path.join(f.legacy, 'notes'), 'owner file');
  symlinkSync(path.join(f.legacy, 'notes'), path.join(f.legacy, 'link'));
  writeFileSync(path.join(f.legacy, 'bot-uid'), '999');
  const row = legacyAppFolderStatus(slug, f);
  assert.equal(row.legacyFolderRemovable, false);
  assert.deepEqual(row.remainingFiles, ['bot-uid', 'link', 'notes']);
  assert.equal(row.removalCommand, null);
  assert.equal(readFileSync(path.join(f.legacy, 'notes'), 'utf8'), 'owner file');
});

test('all migration includes configured Apps without souls; doctor emits the same owner command', async (t) => {
  const f = fixture(t);
  const config = path.join(f.home, '.config', 'agent-bot', 'config.json');
  mkdirSync(path.dirname(config));
  writeFileSync(config, JSON.stringify({ apps: { codex: slug } }));
  const report = await migrateCredentialsCommand(['--all', '--json'], { ...f, cwd: f.home, markers: () => [], gate: async () => ({}), write: () => {} });
  assert.equal(report.apps[0].metadata.status, 'migrated');
  assert.equal(report.apps[0].legacyFolderRemovable, true);
  const check = readinessCheck({ id: 'fixture', status: 'ready', message: 'fixture' });
  const readiness = buildReadinessReport({ command: 'doctor', scope: 'machine', apps: [{ slug, credential: check, live_mint: check }] });
  let json = '';
  await doctor(['--json'], { collect: async () => readiness, cache: () => {}, appMetadataOptions: f, output: { write: (text) => { json += text; } } });
  assert.equal(JSON.parse(json).machine.apps[0].legacyFolderRemovable, true);
  assert.equal(JSON.parse(json).machine.apps[0].removalCommand, report.apps[0].removalCommand);
  let text = '';
  await doctor([], { collect: async () => readiness, cache: () => {}, appMetadataOptions: f, output: { write: (value) => { text += value; } } });
  assert.ok(text.includes(report.apps[0].removalCommand));
  assert.equal(readFileSync(path.join(f.legacy, 'app-id'), 'utf8'), '123\n');
  assert.equal(loadConfig(f).identityApps[slug].botUid, '456');
});

test('a locked managed store blocks cleanup and never falls back to a legacy key', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.legacy, 'private-key.pem'), 'fixture-key');
  migrateAppMetadata(slug, f);
  const configPath = path.join(f.home, '.config', 'agent-bot', 'config.json');
  const config = loadConfig(f);
  config.identityApps[slug].store = 'keychain';
  writeFileSync(configPath, JSON.stringify(config));
  const stores = { keychain: { read: () => { throw new Error('locked'); } } };
  assert.throws(() => readManagedAppCredential(slug, { ...f, stores }), /locked/);
  assert.deepEqual(legacyAppFolderStatus(slug, { ...f, stores }).remainingFiles, ['private-key.pem']);
});

test('managed file store and metadata allow offline inspection without legacy files', (t) => {
  const f = fixture(t);
  migrateAppMetadata(slug, f);
  const stores = credentialStores({ env: f.env });
  stores.file.write(appStoreTarget(slug, f), { appId: '123', privateKeyPem: 'fixture-key' });
  const configPath = path.join(f.home, '.config', 'agent-bot', 'config.json');
  const config = loadConfig(f); config.identityApps[slug].store = 'file';
  writeFileSync(configPath, JSON.stringify(config));
  rmSync(f.legacy, { recursive: true });
  assert.equal(inspectLocalAppCredential({ ...f, slug, stores, validateKey: () => true }).status, 'ready');
});

test('execution-identity CLI resolves the UID entirely from the App record', (t) => {
  const f = fixture(t);
  migrateAppMetadata(slug, f);
  const configPath = path.join(f.home, '.config', 'agent-bot', 'config.json');
  const config = loadConfig(f); config.features = { 'github-identity': true };
  writeFileSync(configPath, JSON.stringify(config));
  rmSync(f.legacy, { recursive: true });
  execFileSync('git', ['init', '--quiet', f.home], { env: f.env });
  const result = execFileSync(process.execPath, [fileURLToPath(new URL('../cli/identity.mjs', import.meta.url)),
    'ensure', '--app', slug, '--json'], { cwd: f.home, env: f.env, encoding: 'utf8' });
  assert.equal(JSON.parse(result).github.botUid, '456');
});

test('confinement still protects a known legacy App folder containing only backups', (t) => {
  const f = fixture(t);
  migrateAppMetadata(slug, f);
  for (const name of ['app-id', 'bot-uid', 'bot-avatar-url']) rmSync(path.join(f.legacy, name));
  const backup = path.join(f.legacy, '.private-key.pem.agent-bot-backup');
  writeFileSync(backup, 'fixture');
  assert.equal(credentialGuard({ file_path: backup }, 'agent_44444444-4444-4444-8444-444444444444', f).decision, 'deny');
});
