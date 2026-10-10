#!/usr/bin/env node

// Per-soul GitHub App credentials (#383).
//
// A soul's soul.json names where its App credential lives —
// `credentials: { github: { app, store } }` — and never holds it. The
// credential itself sits in the soul's own store:
//
// - keychain (macOS default): a generic password, service
//   `agent-bot.soul.<agentId>`, account `github-app/<slug>`, written and read
//   with the `security` CLI. The secret travels on `security -i`'s stdin,
//   never on a command line another process could read.
// - pass-cli (opt-in): one note in Agent Identities, title
//   `agent-bot.soul.<agentId>/github-app/<slug>`, created via stdin.
//   A host may rename both: `agent-bot` and the vault come from the store's
//   own environment through credential-names.mjs (#676).
// - file (elsewhere, or by choice): `<soul>/.soul-state/credentials/`,
//   directory 0700, one file per App, 0600. `.soul-state/` is never packaged,
//   exported or hashed into a revision. On Windows the same store keeps a
//   `.dpapi` file instead, protected by DPAPI for this account on this
//   machine (docs/windows.md).
//
// Only the daemon and the mint path read a store. Nothing here prints, logs
// or returns key material to a caller: results name the store and App only.
// Confinement (confinement.mjs) denies souls these paths and the `security`
// and `pass-cli` executables, so an agent gets tokens, never keys.
//
// What the Keychain access list can and cannot enforce: an item's trusted
// application list names executables, not scripts. The daemon is a Node
// script, and it reads through /usr/bin/security, so the only executable the
// list could name is `security` itself (the creator, trusted by default) or
// `node` — and trusting `node` trusts every Node script in the account. So
// the item is not locked to the daemon by the Keychain; it is encrypted at
// rest, unreadable while the login keychain is locked, and kept from souls by
// confinement. Locking it to the daemon needs a signed helper (follow-up).
//
// - keyd: that signed helper (#397). GeniusBar ships agent-bot-keyd, which
//   keeps the key in a Keychain item only its own code signature can read.
//   Nothing here ever reads that store: a keyd soul's key never leaves
//   keyd, which mints on a grant the daemon signs (keyd-client.mjs).
//   `migrate-credentials --to keyd` moves keys in. Where there is no keyd
//   (Homebrew, Linux) souls keep using the readable stores above.

import { createPrivateKey, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, constants, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { currentAgentId, stateDirectory } from './agent-identity.mjs';
import { soulMarkers } from './owner-gate.mjs';
import { appDeclarations, appUsers } from './soul-app-declarations.mjs';
import { readManagedAppCredential, readAppMetadata } from './identity-app-store.mjs';
import { loadConfig } from './config.mjs';
import { createPassCredentialStore } from './secret-providers/pass-cli-credentials.mjs';
import { CREDENTIAL_STORES, credentialNamespace, itemTitle, managedAppItem, secretNameOrThrow, slugOrThrow, soulAppItem, soulSecretItem } from './credential-names.mjs';

const SECURITY = '/usr/bin/security';
// `security` exits 44 when no item matches.
const KEYCHAIN_NOT_FOUND = 44;

export function defaultCredentialStore(platform = process.platform) {
  return platform === 'darwin' ? 'keychain' : 'file';
}

// `names` carries a store's resolved `{ namespace }`; see credential-names.mjs.
export function keychainItem(agentId, slug, names) {
  return soulAppItem(agentId, slug, names);
}

// A provider secret (#583 slice 4) sits in the same service, under
// `secret/<name>`: one namespace per soul, one item per declared secret.
export function secretItem(agentId, name, names) {
  return soulSecretItem(agentId, secretNameOrThrow(name), names);
}

// Same service/account namespace as Keychain, joined into one item title.
export function passCliItem(agentId, slug, names) {
  return itemTitle(keychainItem(agentId, slug, names));
}

export function passCliSecretItem(agentId, name, names) {
  return itemTitle(secretItem(agentId, name, names));
}

// A secret is one opaque string; base64 keeps it single-line on `security
// -i` and in a note, as the App credential is.
const encodeSecret = (value) => Buffer.from(String(value), 'utf8').toString('base64');
function decodeSecret(text) {
  const stored = String(text ?? '').trim();
  if (!BASE64.test(stored)) throw new Error('stored secret is malformed');
  return Buffer.from(stored, 'base64').toString('utf8');
}

export function passCliStore({ env = process.env, cwd = process.cwd(), passRun } = {}) {
  const names = { namespace: credentialNamespace(env) };
  const provider = createPassCredentialStore({ env, run: passRun });
  const ownerOnly = () => {
    if (soulMarkers({ env, cwd }).length) {
      throw Object.assign(new Error('soul credential stores are unavailable to a soul caller'), { code: 'owner-only' });
    }
  };
  const item = ({ agentId, slug }) => { ownerOnly(); return passCliItem(agentId, slug, names); };
  const secret = ({ agentId, name }) => { ownerOnly(); return passCliSecretItem(agentId, name, names); };
  // A missing note is an absent secret, not a failure; every other
  // provider failure stays what it was (redacted).
  const absent = (error) => { if (error?.code === 'missing-item') return null; throw error; };
  return {
    kind: 'pass-cli',
    read(target) { return decode(provider.read(item(target))); },
    write(target, credential) { provider.write(item(target), encode(credential)); },
    delete(target) { provider.delete(item(target)); },
    readSecret(target) { try { return decodeSecret(provider.read(secret(target))); } catch (error) { return absent(error); } },
    writeSecret(target, value) {
      const title = secret(target);
      // The note store refuses to replace a different value; a cleared
      // item takes the new one.
      try { provider.delete(title); } catch (error) { absent(error); }
      provider.write(title, encodeSecret(value));
    },
    deleteSecret(target) { try { provider.delete(secret(target)); return true; } catch (error) { absent(error); return false; } },
  };
}

export function credentialsDirectory(soulDir) {
  return path.join(soulDir, '.soul-state', 'credentials');
}

export function legacyCredentialDirectory(slug, home = homedir()) {
  return path.join(home, '.config', slugOrThrow(slug));
}

// The stored value is one opaque token: base64 of {appId, privateKeyPem}.
// base64 needs no quoting on `security -i`'s line, and a PEM's newlines
// would otherwise end the command.
function encode({ appId, privateKeyPem, webhookSecret }) {
  return Buffer.from(JSON.stringify({ appId: String(appId), privateKeyPem, ...(webhookSecret ? { webhookSecret } : {}) })).toString('base64');
}
function decode(text) {
  let value;
  try { value = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8')); }
  catch { throw new Error('stored credential is malformed'); }
  if (!value || typeof value.appId !== 'string' || !/^(?:[0-9]+|Iv[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)$/.test(value.appId) || typeof value.privateKeyPem !== 'string') {
    throw new Error('stored credential is malformed');
  }
  return { appId: value.appId, privateKeyPem: value.privateKeyPem, ...(typeof value.webhookSecret === 'string' ? { webhookSecret: value.webhookSecret } : {}) };
}

// `security` is injectable (tests use a fake): AGENT_BOT_SECURITY_BIN is read
// only by the daemon-side processes that already hold the owner's account.
function securityBinary(env) {
  return env.AGENT_BOT_SECURITY_BIN || SECURITY;
}

export function keychainStore({ env = process.env, run = spawnSync } = {}) {
  const names = { namespace: credentialNamespace(env) };
  const bin = securityBinary(env);
  const call = (args, input) => run(bin, args, { input, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
  // The three `security` calls over one item: the stored text, or null.
  const find = ({ service, account }) => {
    const result = call(['find-generic-password', '-s', service, '-a', account, '-w']);
    if (result.error) throw new Error('the keychain could not be read (security did not start)');
    if (result.status === KEYCHAIN_NOT_FOUND) return null;
    if (result.status !== 0) throw new Error(`the keychain could not be read (security exited ${result.status})`);
    return result.stdout;
  };
  const add = ({ service, account }, text) => {
    // -U updates an existing item in place. Nothing secret is on argv.
    const line = `add-generic-password -U -s "${service}" -a "${account}" -l "agent-bot ${account}" -D "agent-bot soul credential" -w "${text}"\n`;
    const result = call(['-i'], line);
    if (result.error || result.status !== 0) throw new Error(`the keychain item could not be written (security exited ${result.status ?? 'without starting'})`);
  };
  // Removes the item; an absent item is already removed. Returns whether
  // one existed. Only service and account names are on argv.
  const remove = ({ service, account }) => {
    const result = call(['delete-generic-password', '-s', service, '-a', account]);
    if (result.error) throw new Error('the keychain item could not be removed (security did not start)');
    if (result.status === KEYCHAIN_NOT_FOUND) return false;
    if (result.status !== 0) throw new Error(`the keychain item could not be removed (security exited ${result.status})`);
    return true;
  };
  const appItem = ({ agentId, slug, appScoped = false }) => (appScoped
    ? managedAppItem(slug, names)
    : keychainItem(agentId, slug, names));
  return {
    kind: 'keychain',
    read(target) {
      const stored = find(appItem(target));
      return stored === null ? null : decode(stored);
    },
    write(target, credential) { add(appItem(target), encode(credential)); },
    delete(target) { return remove(appItem(target)); },
    readSecret({ agentId, name }) {
      const stored = find(secretItem(agentId, name, names));
      return stored === null ? null : decodeSecret(stored);
    },
    writeSecret({ agentId, name }, value) { add(secretItem(agentId, name, names), encodeSecret(value)); },
    deleteSecret({ agentId, name }) { return remove(secretItem(agentId, name, names)); },
  };
}

// The file store refuses anything but a private regular file in a private
// directory owned by this user: a planted link or a loosened mode is not a
// credential.
function assertPrivate(stat, kind, uid) {
  if (stat.uid !== uid) throw new Error(`soul credential ${kind} is not owned by this user`);
  if (stat.mode & 0o077) throw new Error(`soul credential ${kind} is readable by others; expected ${kind === 'directory' ? '0700' : '0600'}`);
}

export function fileStore({ platform = process.platform, uid, run = spawnSync } = {}) {
  if (platform === 'win32') return dpapiFileStore({ run });
  uid ??= process.getuid();
  const fileFor = (soulDir, slug) => path.join(credentialsDirectory(soulDir), `github-app-${slugOrThrow(slug)}.json`);
  const secretFor = (soulDir, name) => path.join(credentialsDirectory(soulDir), `secret-${secretNameOrThrow(name)}.json`);
  const readPrivate = (soulDir, target) => {
    const directory = credentialsDirectory(soulDir);
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory()) throw new Error('soul credential directory is not a directory');
    assertPrivate(stat, 'directory', uid);
    let fd;
    try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('soul credential file could not be opened'); }
    try {
      const fileStat = fstatSync(fd);
      if (!fileStat.isFile()) throw new Error('soul credential file is not a regular file');
      assertPrivate(fileStat, 'file', uid);
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  };
  const writePrivate = (soulDir, target, text) => {
    const state = path.join(soulDir, '.soul-state');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const directory = credentialsDirectory(soulDir);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== uid) throw new Error('soul credential directory is not a private directory');
    chmodSync(directory, 0o700);
    const temporary = path.join(directory, `.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  };
  // Unlinks the file (never following a link); returns whether one existed.
  const unlink = (target) => {
    try { lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    rmSync(target, { force: true });
    return true;
  };
  return {
    kind: 'file',
    read({ soulDir, slug }) {
      const text = readPrivate(soulDir, fileFor(soulDir, slug));
      return text === null ? null : decode(text);
    },
    write({ soulDir, slug }, credential) { writePrivate(soulDir, fileFor(soulDir, slug), encode(credential)); },
    delete({ soulDir, slug }) { return unlink(fileFor(soulDir, slug)); },
    readSecret({ soulDir, name }) {
      const text = readPrivate(soulDir, secretFor(soulDir, name));
      return text === null ? null : decodeSecret(text);
    },
    writeSecret({ soulDir, name }, value) { writePrivate(soulDir, secretFor(soulDir, name), `${encodeSecret(value)}\n`); },
    deleteSecret({ soulDir, name }) { return unlink(secretFor(soulDir, name)); },
  };
}

// Windows (GeniusBar ADR-0046 decision 3, docs/windows.md): the file store
// keeps `github-app-<slug>.dpapi`, the credential DPAPI-protected in the
// CurrentUser scope, so only this Windows account on this machine decrypts
// it. That, with the profile's own access list, is what 0700, 0600 and the
// owner check are on Unix: a file another account planted does not
// unprotect, and there is no mode to loosen. The script goes to PowerShell
// on stdin with the secret hex-encoded inside it, never on argv, which every
// local process can read; hex also keeps the bytes clear of the console
// code page both ways. Nothing here quotes PowerShell's output in an error,
// since that output is the credential when the call succeeds.
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];
const BASE64 = /^[A-Za-z0-9+/]+=*$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

function dpapiFileStore({ run }) {
  const fileFor = (soulDir, slug) => path.join(credentialsDirectory(soulDir), `github-app-${slugOrThrow(slug)}.dpapi`);
  // One statement per line and a blank line at the end: `-Command -` reads
  // stdin as typed input, so a statement split over lines would not parse
  // and a last line without a newline after it would not run.
  const script = (lines) => ['$ErrorActionPreference = \'Stop\'', 'Add-Type -AssemblyName System.Security', ...lines, '', ''].join('\n');
  const protect = (hex) => script([
    `$hex = '${hex}'`,
    '$bytes = [byte[]]::new($hex.Length / 2)',
    'for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }',
    '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, \'CurrentUser\')',
    '[Console]::Out.Write([Convert]::ToBase64String($protected))',
  ]);
  const unprotect = (base64) => script([
    `$protected = [Convert]::FromBase64String('${base64}')`,
    '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, \'CurrentUser\')',
    '[Console]::Out.Write([BitConverter]::ToString($bytes).Replace(\'-\', \'\'))',
  ]);
  const powershell = (text) => run(POWERSHELL, POWERSHELL_ARGS, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const secretFor = (soulDir, name) => path.join(credentialsDirectory(soulDir), `secret-${secretNameOrThrow(name)}.dpapi`);
  // Reads a protected file back to the base64 it was written from, or null.
  const readProtected = (target) => {
    let stored;
    try { stored = readFileSync(target, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('soul credential file could not be opened'); }
    // The file's bytes go inside a quoted string in the script, so anything
    // but base64 is refused before it reaches PowerShell.
    if (!BASE64.test(stored)) throw new Error('stored credential is malformed');
    const result = powershell(unprotect(stored));
    if (result?.status !== 0) refuse('dpapi-unprotect-failed', 'soul credential could not be unprotected by this Windows account on this machine');
    const hex = String(result.stdout ?? '').trim();
    if (!HEX.test(hex)) refuse('dpapi-malformed', 'DPAPI answered something other than the credential bytes');
    return Buffer.from(hex, 'hex').toString('base64');
  };
  const writeProtected = (soulDir, target, base64Text) => {
    const hex = Buffer.from(base64Text, 'base64').toString('hex');
    const result = powershell(protect(hex));
    // A stopped script exits non-zero; an empty answer is a file holding
    // nothing, which would read as a bad credential later rather than now.
    const base64 = result?.status === 0 ? String(result.stdout ?? '').trim() : '';
    if (!BASE64.test(base64)) refuse('dpapi-protect-failed', 'soul credential could not be protected with DPAPI');
    const directory = credentialsDirectory(soulDir);
    mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${base64}\n`, { flag: 'wx' });
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  };
  const unlink = (target) => {
    try { lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    rmSync(target, { force: true });
    return true;
  };
  return {
    kind: 'file',
    read({ soulDir, slug }) {
      const base64 = readProtected(fileFor(soulDir, slug));
      return base64 === null ? null : decode(base64);
    },
    write({ soulDir, slug }, credential) { writeProtected(soulDir, fileFor(soulDir, slug), encode(credential)); },
    delete({ soulDir, slug }) { return unlink(fileFor(soulDir, slug)); },
    readSecret({ soulDir, name }) {
      const base64 = readProtected(secretFor(soulDir, name));
      return base64 === null ? null : decodeSecret(base64);
    },
    writeSecret({ soulDir, name }, value) { writeProtected(soulDir, secretFor(soulDir, name), encodeSecret(value)); },
    deleteSecret({ soulDir, name }) { return unlink(secretFor(soulDir, name)); },
  };
}

// keyd's store has no read or write here: the key only enters keyd through
// its owner channel and never comes back out. Provider secrets (#583 slice
// 4) are not keyd items at all: the harness needs the value in its
// environment, and keyd never hands a value out.
export function keydStore() {
  const held = () => { throw Object.assign(new Error('this key is held by agent-bot-keyd, which never returns it'), { code: 'keyd-held' }); };
  return { kind: 'keyd', read: held, write: held, readSecret: held, writeSecret: held, deleteSecret: held };
}

function secretStoreFor(declaration, stores, platform) {
  const kind = declaration?.store ?? defaultCredentialStore(platform);
  const store = stores[kind];
  if (!store?.readSecret) throw Object.assign(new Error(`secret store "${kind}" cannot hold a provider secret`), { code: 'secret-store-unsupported' });
  return store;
}

// The three operations over one declared secret (`credentials.secrets.
// <name>`): the value, or null when nothing is stored; the store kind is
// the declaration's or the platform default. Nothing here logs a value.
export function readSoulSecret({ agentId, soulDir, name, declaration }, { stores = credentialStores(), platform = process.platform } = {}) {
  return secretStoreFor(declaration, stores, platform).readSecret({ agentId, soulDir, name });
}

export function writeSoulSecret({ agentId, soulDir, name, declaration }, value, { stores = credentialStores(), platform = process.platform } = {}) {
  secretStoreFor(declaration, stores, platform).writeSecret({ agentId, soulDir, name }, value);
}

export function deleteSoulSecret({ agentId, soulDir, name, declaration }, { stores = credentialStores(), platform = process.platform } = {}) {
  return secretStoreFor(declaration, stores, platform).deleteSecret({ agentId, soulDir, name });
}

export function credentialStores(options = {}) {
  return { keychain: keychainStore(options), file: fileStore(options), 'pass-cli': passCliStore(options), keyd: keydStore() };
}

function storeFor(declaration, stores, platform) {
  const kind = declaration.store ?? defaultCredentialStore(platform);
  if (!CREDENTIAL_STORES.includes(kind)) throw new Error(`unknown credential store: ${kind}`);
  return stores[kind];
}

export function readSoulCredential({ agentId, soulDir, declaration }, { stores = credentialStores(), platform = process.platform } = {}) {
  return storeFor(declaration, stores, platform).read({ agentId, soulDir, slug: declaration.app });
}

export function writeSoulCredential({ agentId, soulDir, declaration }, credential, { stores = credentialStores(), platform = process.platform } = {}) {
  storeFor(declaration, stores, platform).write({ agentId, soulDir, slug: declaration.app }, credential);
}

// The souls whose soul.json declares this App, the caller's own soul first.
function declaringSouls(slug, { agentId, env, home, cwd, readOnly = false, strict = false }) {
  const own = agentId ?? (() => { try { return currentAgentId({ env, cwd }); } catch { return null; } })();
  return appDeclarations(slug, { own, env, home, readOnly, strict });
}

// One deprecation notice per App, on stderr (stdout carries tokens).
function legacyNotice(slug, { env, home, warn }) {
  const marker = path.join(stateDirectory({ env, home }), 'notices', `legacy-credentials-${slug}`);
  try {
    mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
  } catch { return; }
  warn(`agent-bot: the ${slug} App key is read from ~/.config/${slug} (deprecated); the owner can move it into the soul's key store with \`agent-bot identity migrate-credentials\`\n`);
}

// The legacy ~/.config/<slug> key, which migrate-credentials
// (soul-credential-migration.mjs) copies into a soul's own store.
export function readLegacyCredential(slug, home, env = process.env, config) {
  const dir = legacyCredentialDirectory(slug, home);
  return {
    appId: readAppMetadata(slug, { home, env, config }).id ?? (() => { throw new Error('missing App ID'); })(),
    privateKeyPem: readFileSync(path.join(dir, 'private-key.pem'), 'utf8'),
  };
}

// Mint-time resolution: the declaring soul's store first, then the legacy
// ~/.config/<slug> folder with a one-time notice. A store that holds a
// credential but cannot be read is an error, not a reason to fall back. A
// keyd soul resolves to `source: 'keyd'` with no key: its mint goes through
// keyd (mint-token.mjs). So does a managed App whose record says keyd holds
// its App-level key (#110), with `keyScope: 'app'` and the minting soul's
// Agent ID, which keyd still requires and names in its receipt.
export function resolveAppCredential(slug, {
  agentId = null,
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  stores,
  platform = process.platform,
  warn = (text) => process.stderr.write(text),
  readOnly = false,
  config = loadConfig({ env, home }),
} = {}) {
  slugOrThrow(slug);
  const declared = declaringSouls(slug, { agentId, env, home, cwd, readOnly });
  // A signed-helper soul must never acquire a readable key through this API.
  const own = agentId ?? (() => { try { return currentAgentId({ env, cwd }); } catch { return null; } })();
  const held = declared.find((soul) => soul.agentId === own && soul.declaration.store === 'keyd');
  if (held) return { slug, appId: null, privateKeyPem: null, source: 'keyd', agentId: held.agentId };
  const record = config.identityApps?.[slug];
  if (record?.store === 'keyd') return { slug, appId: typeof record.id === 'string' ? record.id : null, privateKeyPem: null, source: 'keyd', keyScope: 'app', agentId: own };
  const managed = readManagedAppCredential(slug, { env, home, config, stores: stores ?? credentialStores({ env }) });
  if (managed) return { slug, ...managed, source: 'managed-app', agentId: null };
  const storeOptions = { stores: stores ?? credentialStores({ env }), platform };
  for (const soul of declared) {
    if (soul.declaration.store === 'keyd') return { slug, appId: null, privateKeyPem: null, source: 'keyd', agentId: soul.agentId };
    const credential = readSoulCredential(soul, storeOptions);
    if (credential) return { slug, ...credential, source: storeFor(soul.declaration, storeOptions.stores, platform).kind, agentId: soul.agentId };
  }
  let legacy;
  try { legacy = readLegacyCredential(slug, home, env, config); }
  catch {
    const dir = legacyCredentialDirectory(slug, home);
    throw new Error(`no app config for "${slug}" — no soul key store holds it and ${dir}/app-id and ${dir}/private-key.pem are missing`);
  }
  if (!readOnly) legacyNotice(slug, { env, home, warn });
  return { slug, ...legacy, source: 'legacy', agentId: null };
}

// A selected migration cannot declare a shared App's key redundant while
// another census soul still depends on the legacy copy. Read-only for doctor.
export function legacyKeyRemovable(slug, { env = process.env, home = homedir(), config = loadConfig({ env, home }), stores = credentialStores({ env }) } = {}) {
  try {
    const managed = readManagedAppCredential(slug, { env, home, config, stores });
    const declared = declaringSouls(slug, { env, home, cwd: home, readOnly: true });
    const users = appUsers(slug, { env, home });
    if (!managed && users.some((id) => !declared.some((entry) => entry.agentId === id))) return false;
    if (!managed && !declared.length) return false;
    for (const soul of declared) {
      // keyd declarations are published only after owner/import readback.
      if (soul.declaration.store === 'keyd') continue;
      const credential = managed ?? readSoulCredential(soul, { stores });
      if (!credential?.appId || !credential.privateKeyPem) return false;
    }
    return true;
  } catch { return false; }
}

// Where an App's key is recorded to live, for doctor (#110). Records only:
// the managed App's config `store` and each declaring soul's `store` (or the
// platform default), never a store read, so a locked store cannot change
// the answer. An unreadable soul.json or unknown store throws, so doctor
// marks the App unreadable. The legacy key file is checked with lstat and
// never opened.
export function appKeyStores(slug, { env = process.env, home = homedir(), config = loadConfig({ env, home }), platform = process.platform } = {}) {
  const stores = [];
  // loadConfig does not validate a managed store; an unknown one makes this
  // App unreadable rather than a kind to print.
  const managed = config.identityApps?.[slug]?.store;
  if (managed !== undefined && managed !== null) {
    if (!CREDENTIAL_STORES.includes(managed)) throw new Error('unknown managed App credential store');
    stores.push({ source: 'managed-app', store: managed, agentId: null });
  }
  for (const soul of declaringSouls(slug, { env, home, cwd: home, readOnly: true, strict: true })) {
    stores.push({ source: 'soul', store: soul.declaration.store ?? defaultCredentialStore(platform), agentId: soul.agentId });
  }
  let legacyKeyFile = true;
  try { lstatSync(path.join(legacyCredentialDirectory(slug, home), 'private-key.pem')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') legacyKeyFile = false; }
  return { slug, stores, legacyKeyFile };
}

// The live check: an App JWT signed with the stored key, sent to GET /app.
// It proves GitHub accepts the key without minting an installation token.
export async function verifyAppCredential({ appId, privateKeyPem }, { env = process.env, fetchImpl = fetch } = {}) {
  const { buildAppJwt } = await import('./mint-token.mjs');
  const { apiBase, loadConfig } = await import('./config.mjs');
  createPrivateKey(privateKeyPem);
  const jwt = buildAppJwt(appId, privateKeyPem, Math.floor(Date.now() / 1000));
  const response = await fetchImpl(`${apiBase(loadConfig({ env }))}/app`, {
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-bot-identity' },
  });
  if (!response.ok) throw new Error(`GitHub refused the stored key (GET /app -> ${response.status})`);
  return true;
}

// `agent-bot identity migrate-credentials` writes soul.json declarations and
// revisions, so its body is soul-credential-migration.mjs and its command
// line cli/migrate-credentials.mjs (#645). Run directly, this file only
// points there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('soul-credentials: run agent-bot identity migrate-credentials\n');
  process.exitCode = 1;
}
