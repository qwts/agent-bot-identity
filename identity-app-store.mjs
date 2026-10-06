// App-scoped use of the #395 stores, for Apps created before a soul exists.
// Config contains only the declaration; credentials stay in Keychain/state.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { stateDirectory, withLock } from './agent-identity.mjs';
import { loadConfig } from './config.mjs';
import { credentialStores } from './soul-credentials.mjs';

export const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export function validAppSlug(slug) { return typeof slug === 'string' && APP_SLUG.test(slug); }
export function appStoreTarget(slug, options = {}) {
  if (!validAppSlug(slug)) throw new Error('invalid App slug');
  return { appScoped: true, slug, soulDir: path.join(stateDirectory(options), 'identity-apps', slug) };
}
export function readManagedAppCredential(slug, { env = process.env, home = homedir(), config = loadConfig({ env, home }), stores = credentialStores({ env }) } = {}) {
  const declaration = config.identityApps?.[slug];
  if (!declaration) return null;
  if (!['file', 'keychain'].includes(declaration.store)) throw new Error('unsupported App credential store');
  const credential = stores[declaration.store].read(appStoreTarget(slug, { env, home }));
  if (!credential) throw new Error('managed App credential is missing; reconnect the App');
  return credential;
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
