// The App records soul-credentials.mjs reads (#1386): App slugs and
// App-scoped store targets, the public App metadata, and a managed App's
// credential read from the stores it is handed. identity-app-store.mjs reads
// soul-credentials.mjs for its stores, so these readers sit below both, which
// keeps the two out of an import cycle (HQ plan §2.4). identity-app-store.mjs
// re-exports every name it exported before.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { stateDirectory } from '../state-paths.mjs';
import { loadConfig } from '../config.mjs';

export const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export function validAppSlug(slug) { return typeof slug === 'string' && APP_SLUG.test(slug); }
export function appStoreTarget(slug, options = {}) {
  if (!validAppSlug(slug)) throw new Error('invalid App slug');
  return { appScoped: true, slug, soulDir: path.join(stateDirectory(options), 'identity-apps', slug) };
}
// `stores` is required here: identity-app-store.mjs's readManagedAppCredential
// defaults it to credentialStores(), and soul-credentials.mjs always passes it.
export function readManagedAppCredential(slug, { env = process.env, home = homedir(), config = loadConfig({ env, home }), stores } = {}) {
  const declaration = config.identityApps?.[slug];
  if (!declaration?.store) return null; // metadata alone does not declare a managed key
  // An App-level keyd key (#110) is never readable here; callers that can
  // mint through keyd check the record first (resolveAppCredential). Others
  // fail closed on this code instead of falling through to an older key.
  if (declaration.store === 'keyd') throw Object.assign(new Error(`the ${slug} App key is held by agent-bot-keyd`), { code: 'managed-app-keyd-held' });
  if (!['file', 'keychain'].includes(declaration.store)) throw new Error('unsupported App credential store');
  const credential = stores[declaration.store].read(appStoreTarget(slug, { env, home }));
  if (!credential) throw new Error('managed App credential is missing; reconnect the App');
  if (declaration.id && declaration.id !== credential.appId) throw new Error('managed App issuer does not match its record');
  return credential;
}
// Public metadata is App-scoped, even when several souls hold its key.
export const APP_METADATA_FILES = Object.freeze({
  'app-id': 'id', 'bot-uid': 'botUid', 'bot-avatar-url': 'botAvatarUrl',
});
export function metadataValue(field, value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (field === 'id') return /^(?:[0-9]+|Iv[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)$/.test(text) ? text : null;
  if (field === 'botUid') return /^[1-9][0-9]*$/.test(text) ? text : null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && !url.username && !url.password ? text : null;
  } catch { return null; }
}
export function readAppMetadata(slug, { env = process.env, home = homedir(), config = loadConfig({ env, home }), legacy = true } = {}) {
  if (!validAppSlug(slug)) throw new Error('invalid App slug');
  const record = config.identityApps?.[slug] ?? {};
  const metadata = {};
  for (const [file, field] of Object.entries(APP_METADATA_FILES)) {
    if (record[field] != null) {
      const value = metadataValue(field, record[field]);
      if (!value) throw new Error(`invalid App metadata: ${field}`);
      metadata[field] = value;
    } else if (legacy) {
      try {
        const value = metadataValue(field, readFileSync(path.join(home, '.config', slug, file), 'utf8'));
        if (value) metadata[field] = value;
      } catch { /* absent or unreadable legacy metadata is not a cache */ }
    }
  }
  return metadata;
}
