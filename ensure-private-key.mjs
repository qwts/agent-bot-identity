#!/usr/bin/env node

import process from 'node:process';
import { createPrivateKey, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { appStoreTarget, readAppMetadata, readManagedAppCredential, updateAppConfig } from './identity-app-store.mjs';
import { credentialStores, passCliItem, resolveAppCredential } from './soul-credentials.mjs';
import { CREDENTIAL_VAULT, credentialNamespace, credentialVault, managedAppItem } from './credential-names.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { runPass, classifyPassCliFailure, STORE_UNAVAILABLE_CODES } from './secret-providers/pass-cli.mjs';
export { classifyPassCliFailure, PROVIDER_SESSION_REQUIRED, PROVIDER_LOCKED, PROVIDER_UNAVAILABLE, STORE_UNAVAILABLE_CODES } from './secret-providers/pass-cli.mjs';

export const AGENT_IDENTITIES_VAULT = CREDENTIAL_VAULT;

export class CredentialPreparationError extends Error {
  constructor(code, slug, message) {
    super(`[${slug}] ${message}`);
    this.name = 'CredentialPreparationError';
    this.code = code;
    this.slug = slug;
  }
}

function requireSlug(slug) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug ?? '')) {
    throw new Error(`invalid GitHub App slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

export function privateKeyPath(slug, home = homedir()) {
  return join(home, '.config', requireSlug(slug), 'private-key.pem');
}

export function appIdPath(slug, home = homedir()) {
  return join(home, '.config', requireSlug(slug), 'app-id');
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let force = false;
  let explicit = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--app') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--app requires a slug');
      explicit = next;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (explicit) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      explicit = arg;
    }
  }
  return { force, explicit };
}

function pickString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

export function parsePassItemView(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('pass-cli item view returned non-JSON');
  }
  const item = data?.item && typeof data.item === 'object' ? data.item : data;
  const shareId = pickString(data?.shareId, data?.share_id, item?.shareId, item?.share_id);
  const itemId = pickString(data?.itemId, data?.item_id, item?.id, item?.itemId, item?.item_id);
  const content = item?.content && typeof item.content === 'object' ? item.content : {};
  const note = pickString(content.note, item?.note) ?? '';
  const source = Array.isArray(data?.attachments)
    ? data.attachments
    : Array.isArray(item?.attachments)
      ? item.attachments
      : [];
  if (!shareId || !itemId) throw new Error('pass-cli item view JSON lacked share-id or item-id');
  const attachments = source
    .map((entry) => ({
      id: pickString(entry?.id, entry?.attachmentId, entry?.attachment_id),
      name: pickString(
        entry?.name,
        entry?.fileName,
        entry?.filename,
        entry?.content?.name,
        entry?.content?.fileName,
      ) ?? '',
    }))
    .filter((entry) => entry.id);
  return { shareId, itemId, attachments, fields: collectFields(content), note };
}

// Proton Pass exposes custom fields in two places depending on item type:
// `content.content.Custom.sections[].section_fields[]` (spelled `fields` by
// some CLI builds) for custom items, and a flat `content.extra_fields[]`
// elsewhere. Read every spelling rather than betting on one; a CLI upgrade
// that renames the array must not silently hide credentials.
export function collectFields(content) {
  const entries = [];
  const sections = content?.content?.Custom?.sections;
  if (Array.isArray(sections)) {
    for (const section of sections) {
      if (Array.isArray(section?.fields)) entries.push(...section.fields);
      if (Array.isArray(section?.section_fields)) entries.push(...section.section_fields);
    }
  }
  if (Array.isArray(content?.extra_fields)) entries.push(...content.extra_fields);
  const fields = new Map();
  for (const entry of entries) {
    const name = pickString(entry?.field_name, entry?.fieldName, entry?.name, entry?.label);
    if (!name) continue;
    // Values arrive either bare or wrapped in a typed union: the live CLI
    // prints `content: { Text: ... }` / `content: { Hidden: ... }`.
    const value = pickString(
      typeof entry?.value === 'string' ? entry.value : null,
      entry?.value?.text,
      entry?.value?.content,
      entry?.field_value,
      entry?.data?.value,
      entry?.content?.Text,
      entry?.content?.Hidden,
    );
    if (value === null) continue;
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!fields.has(key)) fields.set(key, value.trim());
  }
  return fields;
}

// GitHub accepts either the numeric App ID or the client ID as the JWT `iss`.
// Anything else would produce an undecodable JWT and a confusing 401 at mint
// time, so reject it here where the message can name the vault item.
//
// Client IDs come in two shapes and both remain valid issuers: the current
// `Iv23liq8jJy0gS7h1nUg` form, and the legacy dotted `Iv1.8a61f9b3a7aba766`
// still shown in GitHub's own API docs.
export function validateIssuer(value) {
  const trimmed = (value ?? '').trim();
  if (/^\d{2,12}$/.test(trimmed)) return trimmed;
  if (/^Iv\d+\.[0-9A-Za-z]{8,}$/.test(trimmed)) return trimmed;
  if (/^Iv[0-9A-Za-z]{6,}$/.test(trimmed)) return trimmed;
  return null;
}

const ISSUER_FIELD_KEYS = ['appid', 'githubappid', 'clientid', 'githubclientid'];
const TRANSACTION_FILE = '.agent-bot-credential-transaction.json';

// Field first, then a `app-id: <value>` line in the note — the note is the only
// place a read-only vault session can be extended without the desktop app.
export function selectIssuer({ fields = new Map(), note = '' } = {}) {
  for (const key of ISSUER_FIELD_KEYS) {
    const found = validateIssuer(fields.get(key));
    if (found) return found;
  }
  for (const line of note.split(/\r?\n/)) {
    const match = line.match(/^\s*(app[-_ ]?id|client[-_ ]?id)\s*[:=]\s*(\S+)\s*$/i);
    if (!match) continue;
    const found = validateIssuer(match[2]);
    if (found) return found;
  }
  return null;
}

// An issuer can also arrive as a plain-text attachment beside the key, which is
// the only way to add one when the vault session is read-only for item fields.
export function selectAppIdAttachment(attachments) {
  const matches = (attachments ?? []).filter((entry) => /^app[-_]?id(\.txt)?$/i.test(entry.name));
  if (matches.length > 1) throw new Error('pass-cli item has ambiguous app-id attachments');
  return matches[0] ?? null;
}

export function selectPrivateKeyAttachment(attachments) {
  const exact = (attachments ?? []).filter((entry) => entry.name === 'private-key.pem');
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error('pass-cli item has ambiguous private-key.pem attachments');
  const pem = (attachments ?? []).filter((entry) => entry.name.toLowerCase().endsWith('.pem'));
  if (pem.length === 1) return pem[0];
  // Zero and many are different failures: many is a conflict that must fail
  // closed even when a field could answer, zero may fall through to the field.
  if (pem.length > 1) throw new Error('pass-cli item has ambiguous private-key.pem attachments');
  throw new Error('pass-cli item has no unambiguous private-key.pem attachment');
}

// A hidden "Private Key" field is the CLI-writable home for the PEM —
// `pass-cli item update --field` can set it, while attachments can only be
// added through the desktop app. The attachment stays preferred so items
// carrying both restore exactly as before; the field is the fallback.
// collectFields trims values, so the trailing newline PEM tooling expects is
// restored here.
export function selectPrivateKeyField(fields) {
  const value = (fields ?? new Map()).get('privatekey');
  if (!value) return null;
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function inspectProtonPassSession({ run = runPass } = {}) {
  try {
    run(['info', '--output', 'json']);
    return { status: 'ready' };
  } catch (error) {
    return { status: 'failed', code: classifyPassCliFailure(error).code };
  }
}

function issuerSourcePresent({ fields, note }) {
  if (ISSUER_FIELD_KEYS.some((key) => fields.has(key))) return true;
  return note.split(/\r?\n/).some((line) =>
    /^\s*(app[-_ ]?id|client[-_ ]?id)\s*[:=]/i.test(line));
}

function preparationError(code, slug, message, cause) {
  const error = new CredentialPreparationError(code, slug, message);
  if (cause) error.cause = cause;
  return error;
}

function throwProviderReadError(error, slug) {
  const { code } = classifyPassCliFailure(error);
  const message = STORE_UNAVAILABLE_CODES.includes(code)
    ? `secret store is unavailable (${code})`
    : `credential provider could not read the App item (${code})`;
  throw preparationError(code, slug, message, error);
}

// The import reads the host's vault (#676), resolved before any pass-cli call.
export function createProtonPassCredentialProvider({ run = runPass, write = writeFileSync, env = process.env } = {}) {
  const vault = credentialVault(env);
  return {
    id: 'proton-pass',
    restore({ slug, issuerDestination, privateKeyDestination }) {
      const session = inspectProtonPassSession({ run });
      if (session.status === 'failed') {
        throwProviderReadError({ code: session.code }, slug);
      }
      let parsed;
      try {
        parsed = parsePassItemView(run([
          'item',
          'view',
          '--vault-name',
          vault,
          '--item-title',
          requireSlug(slug),
          '--output',
          'json',
        ]));
      } catch (error) {
        throwProviderReadError(error, slug);
      }

      const { shareId, itemId, attachments, fields, note } = parsed;
      if (issuerDestination) {
        const issuer = selectIssuer({ fields, note });
        if (issuer) {
          write(issuerDestination, `${issuer}\n`, { mode: 0o600 });
        } else {
          if (issuerSourcePresent({ fields, note })) {
            throw preparationError(
              'malformed-issuer',
              slug,
              'the provider App ID/client ID is malformed; replace it with a GitHub App ID or client ID',
            );
          }
          let attachment;
          try {
            attachment = selectAppIdAttachment(attachments);
          } catch (error) {
            throw preparationError(
              'ambiguous-issuer',
              slug,
              'the provider item has multiple app-id attachments; keep exactly one',
              error,
            );
          }
          if (!attachment) {
            throw preparationError(
              'missing-issuer',
              slug,
              'the provider item has no App ID/client ID; add a field, note line, or app-id attachment',
            );
          }
          run([
            'item', 'attachment', 'download',
            '--share-id', shareId,
            '--item-id', itemId,
            '--attachment-id', attachment.id,
            '--output', issuerDestination,
          ]);
        }
      }

      if (privateKeyDestination) {
        let attachment = null;
        try {
          attachment = selectPrivateKeyAttachment(attachments);
        } catch (error) {
          // Multiple candidates are a real conflict; zero just means the item
          // may hold the key in its "Private Key" field instead. ("has
          // ambiguous", not bare /ambiguous/ — the zero case says
          // "no unambiguous", which that broader match would swallow.)
          if (/has ambiguous/i.test(error.message)) {
            throw preparationError(
              'ambiguous-private-key',
              slug,
              'the provider item has multiple private-key.pem candidates; keep exactly one',
              error,
            );
          }
        }
        if (attachment) {
          run([
            'item', 'attachment', 'download',
            '--share-id', shareId,
            '--item-id', itemId,
            '--attachment-id', attachment.id,
            '--output', privateKeyDestination,
          ]);
        } else {
          const fieldPem = selectPrivateKeyField(fields);
          if (!fieldPem) {
            throw preparationError(
              'missing-private-key',
              slug,
              'the provider item has no private-key.pem attachment or "Private Key" field',
            );
          }
          write(privateKeyDestination, fieldPem, { mode: 0o600 });
        }
      }
      return { provider: 'proton-pass' };
    },
  };
}

export function validatePrivateKey(value) {
  try {
    createPrivateKey(value);
    return true;
  } catch {
    return false;
  }
}

// Old interrupted pair publications need owner inspection. Never replay a
// transaction (or remove its backups) into a deprecated ~/.config/<slug>.
export function recoverCredentialTransaction({ slug, directory, exists = existsSync } = {}) {
  if (exists(join(directory, TRANSACTION_FILE))) {
    throw preparationError('credential-transaction-pending', slug,
      'an interrupted legacy credential publication needs owner inspection; legacy files were kept');
  }
  return false;
}

// Provider downloads are staged privately, then published as one App-scoped
// credential. New restores use a private file store; an existing managed
// Keychain declaration retains its explicitly selected store.
export function ensurePrivateKey({
  slug, force = false, home = homedir(), env = process.env,
  run = runPass, exists = existsSync, write = writeFileSync,
  read = readFileSync, remove = rmSync, validateKey = validatePrivateKey,
  provider, stores = credentialStores({ env }),
} = {}) {
  requireSlug(slug);
  const config = loadConfig({ env, home });
  const idPath = env.AGENT_BOT_CONFIG ?? join(home, '.config', 'agent-bot', 'config.json');
  const legacyPath = privateKeyPath(slug, home);
  recoverCredentialTransaction({ slug, directory: dirname(legacyPath), exists });
  // An App-level keyd key (#110) has nothing to prepare here.
  if (config.identityApps?.[slug]?.store === 'keyd') throw preparationError('keyd-held', slug, 'this App key is held by keyd');
  let stored = readManagedAppCredential(slug, { env, home, config, stores });
  if (!stored) {
    try {
      const resolved = resolveAppCredential(slug, { env, home, cwd: home, config, stores, readOnly: true });
      if (resolved.source === 'keyd') throw preparationError('keyd-held', slug, 'this App key is held by keyd');
      if (resolved.source !== 'legacy') stored = resolved;
    } catch (error) {
      if (!error.message.startsWith('no app config for')) throw error;
    }
  }
  const metadata = readAppMetadata(slug, { env, home, config });
  let appId = stored?.appId ?? metadata.id;
  let key = stored?.privateKeyPem;
  if (!key) {
    try { key = read(legacyPath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw preparationError('unreadable-private-key', slug, 'the existing private key cannot be read', error); }
  }
  const needId = force || !validateIssuer(appId);
  const needKey = force || !key || !validateKey(key);
  const target = appStoreTarget(slug, { env, home });
  const kind = config.identityApps?.[slug]?.store ?? 'file';
  const names = { namespace: credentialNamespace(env) };
  const storedPath = stored?.source === 'pass-cli' ? `pass-cli:${credentialVault(env)}/${passCliItem(stored.agentId, slug, names)}`
    : kind === 'file' ? join(target.soulDir, '.soul-state', 'credentials', `github-app-${slug}.json`) : `keychain:${managedAppItem(slug, names).service}`;
  if (!needKey && !needId) return { path: stored ? storedPath : legacyPath, idPath,
    downloaded: false, appIdWritten: false, localStatus: 'ready', restored: [] };

  const staging = mkdtempSync(join(home, '.agent-bot-credential-'));
  const directory = join(staging, '.soul-state', 'credentials');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const issuerTemporary = needId ? join(directory, `issuer.${suffix}`) : null;
  const keyTemporary = needKey ? join(directory, `key.${suffix}`) : null;
  try {
    (provider ?? createProtonPassCredentialProvider({ run, write, env })).restore({ slug,
      issuerDestination: issuerTemporary, privateKeyDestination: keyTemporary });
    if (needId) {
      appId = validateIssuer(read(issuerTemporary, 'utf8'));
      if (!appId) throw preparationError('malformed-issuer', slug,
        'the restored App ID/client ID is malformed; replace it in the credential provider');
    }
    if (needKey) {
      key = read(keyTemporary, 'utf8');
      if (!validateKey(key)) throw preparationError('malformed-private-key', slug,
        'the restored private key is malformed; replace the provider attachment or "Private Key" field');
    }
    let before;
    updateAppConfig((current) => {
      if (JSON.stringify(current.identityApps?.[slug]) !== JSON.stringify(config.identityApps?.[slug])) {
        throw new Error('App configuration changed during restore');
      }
      before = stores[kind].read(target);
      stores[kind].write(target, { ...stored, appId, privateKeyPem: key });
      current.identityApps ??= {};
      current.identityApps[slug] = { ...current.identityApps[slug], ...metadata, id: appId, store: kind };
      if (needKey) delete current.identityApps[slug].keyFingerprint; // a replaced key invalidates the cached fingerprint
    }, { env, home, rollback: () => { if (before) stores[kind].write(target, before); } });
  } catch (error) {
    if (error instanceof CredentialPreparationError) throw error;
    throw preparationError('provider-failure', slug, 'the credential provider could not restore the requested credential files', error);
  } finally {
    if (issuerTemporary) remove(issuerTemporary, { force: true });
    if (keyTemporary) remove(keyTemporary, { force: true });
    remove(staging, { recursive: true, force: true });
  }
  const restored = [needId ? 'app-id' : null, needKey ? 'private-key' : null].filter(Boolean);
  return { path: storedPath, downloaded: needKey, idPath, appIdWritten: needId, localStatus: 'restored', restored };
}

export function main(argv = process.argv.slice(2)) {
  const { force, explicit } = parseCliArgs(argv);
  // The shared resolver: --app, GH_AGENT_APP, the pin, the account, then
  // harness detection. Explicit inputs win wherever the process runs.
  const slug = resolveAgentSlug({ explicit });
  if (!slug) throw new Error('no App resolves; pass --app, set GH_AGENT_APP, pin the checkout, or run from the harness account');
  const result = ensurePrivateKey({ slug, force });
  process.stdout.write(`${result.downloaded ? 'fetched' : 'already present'} ${result.path}\n`);
  if (result.appIdWritten) process.stdout.write(`fetched ${result.idPath}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ensure-private-key: ${error.message}\n`);
    process.exit(1);
  }
}
