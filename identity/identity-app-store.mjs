// App-scoped use of the #395 stores, for Apps created before a soul exists.
// Config contains public App metadata and the declaration; keys stay in Keychain/state.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { withLock } from '../file-lock.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { loadConfig } from '../config.mjs';
import { credentialStores, legacyKeyRemovable } from './soul-credentials.mjs';
import { APP_METADATA_FILES, metadataValue, readAppMetadata, readManagedAppCredential as readStoredManagedAppCredential, validAppSlug } from './app-records.mjs';

export { APP_METADATA_FILES, APP_SLUG, appStoreTarget, readAppMetadata, validAppSlug } from './app-records.mjs';

// The managed App credential, with the stores defaulting to this host's.
export function readManagedAppCredential(slug, { env = process.env, home = homedir(), config = loadConfig({ env, home }), stores = credentialStores({ env }) } = {}) {
  return readStoredManagedAppCredential(slug, { env, home, config, stores });
}
export function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
export function updateAppConfig(update, { env = process.env, home = homedir(), rollback = null } = {}) {
  const file = env.AGENT_BOT_CONFIG ?? path.join(home, '.config', 'agent-bot', 'config.json');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withLock(`${file}.lock`, 'App configuration', () => {
    const config = loadConfig({ env, home });
    const result = update(config);
    try { atomicJson(file, config); } catch (error) { rollback?.(); throw error; }
    return result;
  });
}
// One create, connect or rotate-key per App at a time (#110). keyd's import
// happens outside the config lock (it waits for the owner), so the whole
// operation holds this one: a second refuses rather than racing it. A lock
// older than the owner's keyd timeout plus margin is a crashed holder's.
const APP_OPERATION_STALE_MS = 10 * 60_000;
export async function withAppOperationLock(slug, options, operation) {
  if (!validAppSlug(slug)) throw new Error('invalid App slug');
  const lock = path.join(stateDirectory(options), 'identity-apps', `${slug}.operation.lock`);
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const take = () => { try { mkdirSync(lock, { mode: 0o700 }); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; } };
  if (!take()) {
    let stale = false;
    try { stale = Date.now() - lstatSync(lock).mtimeMs > APP_OPERATION_STALE_MS; } catch { stale = true; }
    if (stale) rmSync(lock, { recursive: true, force: true });
    if (!stale || !take()) return null;
  }
  try { return { value: await operation() }; } finally { rmSync(lock, { recursive: true, force: true }); }
}
export const MINT_CODES = ['credential-mismatch', 'app-not-installed', 'ambiguous-installation', 'live-verification-failed'];
const cacheFile = (options) => path.join(stateDirectory(options), 'identity-apps', 'doctor.json');
export function readAppDoctorCache(options = {}) {
  try { return JSON.parse(readFileSync(cacheFile(options), 'utf8')); } catch { return {}; }
}
// Allow-list fields: never persist upstream error messages or arbitrary evidence.
export function cacheAppDoctorRows(report, options = {}) {
  const cache = readAppDoctorCache(options);
  for (const row of report.machine?.apps ?? []) {
    if (!validAppSlug(row.slug) || !['ready', 'failed'].includes(row.live_mint?.status)) continue;
    cache[row.slug] = { status: row.live_mint.status, code: MINT_CODES.includes(row.live_mint.code) ? row.live_mint.code : null, checkedAt: new Date().toISOString() };
  }
  if (Object.keys(cache).length) atomicJson(cacheFile(options), cache);
}
// Drop one App's cached doctor status (identity app remove).
export function forgetAppDoctorRow(slug, options = {}) {
  if (!validAppSlug(slug)) throw new Error('invalid App slug');
  const cache = readAppDoctorCache(options);
  if (!Object.hasOwn(cache, slug)) return false;
  delete cache[slug];
  atomicJson(cacheFile(options), cache);
  return true;
}

export function writeAppMetadata(slug, metadata, options = {}) {
  if (!validAppSlug(slug)) throw new Error('invalid App slug');
  const values = {};
  for (const field of Object.values(APP_METADATA_FILES)) {
    if (metadata[field] == null) continue;
    const value = metadataValue(field, metadata[field]);
    if (!value) throw new Error(`invalid App metadata: ${field}`);
    values[field] = value;
  }
  return updateAppConfig((config) => {
    config.identityApps ??= {};
    config.identityApps[slug] = { ...config.identityApps[slug], ...values };
    return values;
  }, options);
}
export function migrateAppMetadata(slug, { dryRun = false, ...options } = {}) {
  const copy = (config) => {
    const current = readAppMetadata(slug, { ...options, config, legacy: false });
    const resolved = readAppMetadata(slug, { ...options, config });
    const fields = Object.keys(resolved).filter((field) => current[field] == null);
    if (!dryRun && fields.length) {
      config.identityApps ??= {};
      config.identityApps[slug] = { ...config.identityApps[slug], ...resolved };
    }
    return { status: dryRun && fields.length ? 'would-migrate' : fields.length ? 'migrated' : 'already-migrated', fields };
  };
  if (dryRun) return copy(loadConfig(options));
  return updateAppConfig(copy, options);
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
// Remaining files are blockers, not a directory listing: known redundant
// copies may still exist until the owner executes the printed command.
export function legacyAppFolderStatus(slug, { env = process.env, home = homedir(), config = loadConfig({ env, home }), keyRemovable, stores } = {}) {
  if (!validAppSlug(slug)) throw new Error('invalid App slug');
  const legacyFolder = path.join(home, '.config', slug);
  const result = { legacyFolder, legacyFolderExists: false, legacyFolderRemovable: false, remainingFiles: [], removalCommand: null };
  let names;
  try {
    const stat = lstatSync(legacyFolder);
    result.legacyFolderExists = true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
    names = readdirSync(legacyFolder).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') { result.legacyFolderExists = true; result.remainingFiles = ['<unreadable-folder>']; }
    return result;
  }
  const metadata = readAppMetadata(slug, { env, home, config, legacy: false });
  for (const name of names) {
    const stat = lstatSync(path.join(legacyFolder, name));
    if (!stat.isFile() || stat.isSymbolicLink()) { result.remainingFiles.push(name); continue; }
    const field = APP_METADATA_FILES[name];
    if (field && metadata[field]) {
      try { if (metadataValue(field, readFileSync(path.join(legacyFolder, name), 'utf8')) === metadata[field]) continue; }
      catch { /* unreadable files block removal */ }
    }
    if (name === 'private-key.pem' && (keyRemovable ?? legacyKeyRemovable(slug, { env, home, config, stores }))) continue;
    result.remainingFiles.push(name);
  }
  result.legacyFolderRemovable = result.remainingFiles.length === 0;
  if (result.legacyFolderRemovable) result.removalCommand = `rm -rf -- ${shellQuote(legacyFolder)}`;
  return result;
}
