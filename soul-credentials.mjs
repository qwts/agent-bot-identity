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
// - file (elsewhere, or by choice): `<soul>/.soul-state/credentials/`,
//   directory 0700, one file per App, 0600. `.soul-state/` is never packaged,
//   exported or hashed into a revision.
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

import { createPrivateKey, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, constants, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { currentAgentId, stateDirectory, validateAgentId } from './agent-identity.mjs';
import { listSouls, populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { assertOwnerAction, soulMarkers } from './owner-gate.mjs';
import { CREDENTIAL_STORES, soulCredentialsDeclaration, writeSoulCredentialsDeclaration } from './soul-package.mjs';
import { editSoulRevision, revisionHistory } from './soul-revisions.mjs';

const APP_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;
const SECURITY = '/usr/bin/security';
// `security` exits 44 when no item matches.
const KEYCHAIN_NOT_FOUND = 44;

function slugOrThrow(slug) {
  if (typeof slug !== 'string' || !APP_SLUG.test(slug)) throw new Error('invalid GitHub App slug');
  return slug;
}

export function defaultCredentialStore(platform = process.platform) {
  return platform === 'darwin' ? 'keychain' : 'file';
}

export function keychainItem(agentId, slug) {
  return { service: `agent-bot.soul.${validateAgentId(agentId)}`, account: `github-app/${slugOrThrow(slug)}` };
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
function encode({ appId, privateKeyPem }) {
  return Buffer.from(JSON.stringify({ appId: String(appId), privateKeyPem })).toString('base64');
}
function decode(text) {
  let value;
  try { value = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8')); }
  catch { throw new Error('stored credential is malformed'); }
  if (!value || typeof value.appId !== 'string' || !/^\d+$/.test(value.appId) || typeof value.privateKeyPem !== 'string') {
    throw new Error('stored credential is malformed');
  }
  return { appId: value.appId, privateKeyPem: value.privateKeyPem };
}

// `security` is injectable (tests use a fake): AGENT_BOT_SECURITY_BIN is read
// only by the daemon-side processes that already hold the owner's account.
function securityBinary(env) {
  return env.AGENT_BOT_SECURITY_BIN || SECURITY;
}

export function keychainStore({ env = process.env, run = spawnSync } = {}) {
  const bin = securityBinary(env);
  const call = (args, input) => run(bin, args, { input, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
  return {
    kind: 'keychain',
    read({ agentId, slug }) {
      const { service, account } = keychainItem(agentId, slug);
      const result = call(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (result.error) throw new Error('the keychain could not be read (security did not start)');
      if (result.status === KEYCHAIN_NOT_FOUND) return null;
      if (result.status !== 0) throw new Error(`the keychain could not be read (security exited ${result.status})`);
      return decode(result.stdout);
    },
    write({ agentId, slug }, credential) {
      const { service, account } = keychainItem(agentId, slug);
      // -U updates an existing item in place. Nothing secret is on argv.
      const line = `add-generic-password -U -s "${service}" -a "${account}" -l "agent-bot ${account}" -D "agent-bot soul credential" -w "${encode(credential)}"\n`;
      const result = call(['-i'], line);
      if (result.error || result.status !== 0) throw new Error(`the keychain item could not be written (security exited ${result.status ?? 'without starting'})`);
    },
  };
}

// The file store refuses anything but a private regular file in a private
// directory owned by this user: a planted link or a loosened mode is not a
// credential.
function assertPrivate(stat, kind, uid) {
  if (stat.uid !== uid) throw new Error(`soul credential ${kind} is not owned by this user`);
  if (stat.mode & 0o077) throw new Error(`soul credential ${kind} is readable by others; expected ${kind === 'directory' ? '0700' : '0600'}`);
}

export function fileStore({ uid = process.getuid() } = {}) {
  const fileFor = (soulDir, slug) => path.join(credentialsDirectory(soulDir), `github-app-${slugOrThrow(slug)}.json`);
  return {
    kind: 'file',
    read({ soulDir, slug }) {
      const directory = credentialsDirectory(soulDir);
      let stat;
      try { stat = lstatSync(directory); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!stat.isDirectory()) throw new Error('soul credential directory is not a directory');
      assertPrivate(stat, 'directory', uid);
      let fd;
      try { fd = openSync(fileFor(soulDir, slug), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('soul credential file could not be opened'); }
      try {
        const fileStat = fstatSync(fd);
        if (!fileStat.isFile()) throw new Error('soul credential file is not a regular file');
        assertPrivate(fileStat, 'file', uid);
        return decode(readFileSync(fd, 'utf8'));
      } finally { closeSync(fd); }
    },
    write({ soulDir, slug }, credential) {
      const state = path.join(soulDir, '.soul-state');
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const directory = credentialsDirectory(soulDir);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== uid) throw new Error('soul credential directory is not a private directory');
      chmodSync(directory, 0o700);
      const target = fileFor(soulDir, slug);
      const temporary = path.join(directory, `.${process.pid}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, encode(credential), { flag: 'wx', mode: 0o600 });
        renameSync(temporary, target);
      } finally { rmSync(temporary, { force: true }); }
    },
  };
}

export function credentialStores(options = {}) {
  return { keychain: keychainStore(options), file: fileStore(options) };
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
function declaringSouls(slug, { agentId, env, home, cwd }) {
  const file = populationFile({ env, home });
  const ids = [];
  const own = agentId ?? (() => { try { return currentAgentId({ env, cwd }); } catch { return null; } })();
  if (own) ids.push(own);
  try { for (const record of listSouls({ file })) if (!ids.includes(record.id)) ids.push(record.id); }
  catch { /* No census: only the caller's own soul can declare. */ }
  const found = [];
  for (const id of ids) {
    let soulDir;
    try { soulDir = soulDirectory(id, { file, env, home }); } catch { continue; }
    const declaration = soulCredentialsDeclaration(soulDir);
    if (declaration?.app === slug) found.push({ agentId: id, soulDir, declaration });
  }
  return found;
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

function readLegacy(slug, home) {
  const dir = legacyCredentialDirectory(slug, home);
  return {
    appId: readFileSync(path.join(dir, 'app-id'), 'utf8').trim(),
    privateKeyPem: readFileSync(path.join(dir, 'private-key.pem'), 'utf8'),
  };
}

// Mint-time resolution: the declaring soul's store first, then the legacy
// ~/.config/<slug> folder with a one-time notice. A store that holds a
// credential but cannot be read is an error, not a reason to fall back.
export function resolveAppCredential(slug, {
  agentId = null,
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  stores,
  platform = process.platform,
  warn = (text) => process.stderr.write(text),
} = {}) {
  slugOrThrow(slug);
  const storeOptions = { stores: stores ?? credentialStores({ env }), platform };
  for (const soul of declaringSouls(slug, { agentId, env, home, cwd })) {
    const credential = readSoulCredential(soul, storeOptions);
    if (credential) return { slug, ...credential, source: storeFor(soul.declaration, storeOptions.stores, platform).kind, agentId: soul.agentId };
  }
  let legacy;
  try { legacy = readLegacy(slug, home); }
  catch {
    const dir = legacyCredentialDirectory(slug, home);
    throw new Error(`no app config for "${slug}" — no soul key store holds it and ${dir}/app-id and ${dir}/private-key.pem are missing`);
  }
  legacyNotice(slug, { env, home, warn });
  return { slug, ...legacy, source: 'legacy', agentId: null };
}

// --- agent-bot identity migrate-credentials ---------------------------------

const USAGE = 'usage: agent-bot identity migrate-credentials [--soul AGENT_ID|NAME | --all] [--dry-run] [--json] [--principal-stdin]';

function parseArgs(argv) {
  const options = { soul: null, all: false, dryRun: false, json: false, principal: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--principal-stdin') options.principal = true;
    else if (arg === '--soul' && argv[index + 1] && !argv[index + 1].startsWith('--')) options.soul = argv[++index];
    else throw new Error(USAGE);
  }
  if (options.all === Boolean(options.soul)) throw new Error(USAGE);
  return options;
}

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
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

const same = (left, right) => left && right && left.appId === right.appId && left.privateKeyPem === right.privateKeyPem;

// Copies each soul's legacy App key into its own store, reads it back,
// verifies it live, and reports which legacy key files nothing needs any
// more. It never deletes a legacy file. Owner only, never from a soul.
export async function migrateCredentialsCommand(argv, {
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  platform = process.platform,
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  markers = soulMarkers,
  gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd }),
  stores = credentialStores({ env }),
  verify = (credential) => verifyAppCredential(credential, { env }),
  revisions = { history: revisionHistory, edit: editSoulRevision },
  now = () => new Date(),
} = {}) {
  const options = parseArgs(argv);
  // A soul is refused before anything is read, dry run included: listing
  // which stores hold which keys is already the owner's business.
  const found = markers({ env, cwd });
  if (found.length) {
    throw Object.assign(new Error(`identity migrate-credentials is owner only; this caller has a soul's ${found.join(', ')}`), { code: 'owner-only' });
  }
  let principal = null;
  if (options.principal) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const file = populationFile({ env, home });
  const souls = options.all ? listSouls({ file }).filter((soul) => soul.status !== 'retired') : [resolveSoul(options.soul, file)];
  const authorization = options.dryRun ? null
    : await gate(`identity migrate-credentials ${options.all ? '--all' : souls[0].id}`, { principal });
  const stateDir = stateDirectory({ env, home });
  const results = [];
  for (const soul of souls) {
    const row = { agentId: soul.id, name: soul.name ?? null, app: null, store: null, status: null, detail: null };
    results.push(row);
    let soulDir;
    try { soulDir = soulDirectory(soul.id, { file, env, home }); }
    catch { Object.assign(row, { status: 'skipped', detail: 'no soul directory' }); continue; }
    let declared;
    try { declared = soulCredentialsDeclaration(soulDir); }
    catch (error) { Object.assign(row, { status: 'failed', detail: error.message }); continue; }
    const declaration = declared ?? (soul.appSlug ? { app: soul.appSlug, store: defaultCredentialStore(platform) } : null);
    if (!declaration) { Object.assign(row, { status: 'skipped', detail: 'no GitHub App' }); continue; }
    row.app = declaration.app;
    row.store = declaration.store ?? defaultCredentialStore(platform);
    const target = { agentId: soul.id, soulDir, declaration };
    try {
      const stored = readSoulCredential(target, { stores, platform });
      let legacy = null;
      try { legacy = readLegacy(declaration.app, home); } catch { /* reported below */ }
      if (stored && (!legacy || same(stored, legacy))) {
        Object.assign(row, { status: 'already-migrated' });
        continue;
      }
      if (!legacy) { Object.assign(row, { status: 'skipped', detail: `no legacy key in ~/.config/${declaration.app}` }); continue; }
      if (options.dryRun) { Object.assign(row, { status: 'would-migrate' }); continue; }
      writeSoulCredential(target, legacy, { stores, platform });
      const back = readSoulCredential(target, { stores, platform });
      if (!same(back, legacy)) throw new Error('the store did not return what was written');
      await verify(back);
      if (!declared) {
        // Record where the key now lives. A soul with a revision chain
        // records it as an owner edit, like `soul comms`.
        const previous = writeSoulCredentialsDeclaration(soulDir, { app: declaration.app, store: row.store });
        try {
          if (previous !== null && revisions.history(soul.id, { stateDir }).length) {
            await revisions.edit(soul.id, soulDir, { reason: 'declare per-soul credentials', stateDir,
              ...(authorization?.method ? { authorization } : {}) });
          }
        } catch (error) {
          writeFileSync(path.join(soulDir, 'soul.json'), previous);
          throw error;
        }
      }
      Object.assign(row, { status: 'migrated' });
    } catch (error) {
      Object.assign(row, { status: 'failed', detail: error.message });
    }
  }
  // A legacy key is removable once every soul that declares or uses its App
  // holds the key in its own store. The folder keeps bot-uid and other
  // public metadata other commands still read, so only the key file is named.
  const bySlug = new Map();
  for (const row of results.filter((entry) => entry.app)) {
    const list = bySlug.get(row.app) ?? [];
    list.push(row);
    bySlug.set(row.app, list);
  }
  const removable = [];
  for (const [slug, rows] of bySlug) {
    const keyFile = path.join(legacyCredentialDirectory(slug, home), 'private-key.pem');
    let exists = true;
    try { lstatSync(keyFile); } catch { exists = false; }
    if (exists && rows.every((entry) => ['migrated', 'already-migrated'].includes(entry.status))) removable.push(keyFile);
  }
  if (!options.dryRun) {
    for (const row of results.filter((entry) => entry.status === 'migrated' || entry.status === 'failed')) {
      appendAuditReceipt({ event: 'credential-migrate', agentId: row.agentId, operation: `github-app ${row.store}`,
        decision: row.status }, { env, home, now });
    }
  }
  const report = { schemaVersion: 1, dryRun: options.dryRun, souls: results, removableLegacyKeys: removable, deleted: [] };
  if (options.json) write(`${JSON.stringify(report)}\n`);
  else {
    for (const row of results) {
      write(`${row.agentId} ${row.app ?? '-'} ${row.store ?? '-'} ${row.status}${row.detail ? ` (${row.detail})` : ''}\n`);
    }
    if (removable.length) write(`legacy key files nothing needs any more (not deleted):\n${removable.map((entry) => `  ${entry}\n`).join('')}`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateCredentialsCommand(process.argv.slice(2)).then((report) => {
    if (report.souls.some((row) => row.status === 'failed')) process.exitCode = 1;
  }).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'migrate-credentials-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot identity migrate-credentials: ${error.message}\n`);
    process.exitCode = 1;
  });
}
