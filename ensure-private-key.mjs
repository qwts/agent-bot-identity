#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentSlug } from './resolve-agent.mjs';

export const AGENT_IDENTITIES_VAULT = 'Agent Identities';

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
  } catch (error) {
    throw new Error(`pass-cli item view returned non-JSON: ${error.message}`);
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
const ISSUER_BACKUP = '.app-id.agent-bot-backup';
const KEY_BACKUP = '.private-key.pem.agent-bot-backup';

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

export const PROVIDER_SESSION_REQUIRED = 'provider-session-required';
export const PROVIDER_LOCKED = 'provider-locked';
export const PROVIDER_UNAVAILABLE = 'provider-unavailable';
export const STORE_UNAVAILABLE_CODES = Object.freeze([
  PROVIDER_SESSION_REQUIRED,
  PROVIDER_LOCKED,
  PROVIDER_UNAVAILABLE,
]);

const PASS_CLI_FAILURE_CODES = new Set([
  ...STORE_UNAVAILABLE_CODES,
  'missing-item',
  'ambiguous-item',
  'provider-failure',
]);

function passCliText(error) {
  return `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
}

// Classify a pass-cli failure without splicing provider output into the
// operator action. Locked / missing sessions are a store gate, not an item
// defect — they must not be reported as missing-issuer or a generic restore.
export function classifyPassCliFailure(error) {
  if (error?.code && PASS_CLI_FAILURE_CODES.has(error.code)) {
    return { code: error.code };
  }
  if (error?.code === 'ENOENT') {
    return { code: PROVIDER_UNAVAILABLE };
  }
  const text = passCliText(error);
  if (/no session|authenticated client|not logged in|unauthenticated/i.test(text)) {
    return { code: PROVIDER_SESSION_REQUIRED };
  }
  if (/session is locked|session locked|unlock the (?:current )?session|requires.*unlock/i.test(text)) {
    return { code: PROVIDER_LOCKED };
  }
  if (/not found|no item/i.test(text)) {
    return { code: 'missing-item' };
  }
  if (/ambiguous|multiple/i.test(text)) {
    return { code: 'ambiguous-item' };
  }
  return { code: 'provider-failure' };
}

function passCliFailure(error) {
  const { code } = classifyPassCliFailure(error);
  const detail = {
    [PROVIDER_UNAVAILABLE]: 'was not found',
    [PROVIDER_SESSION_REQUIRED]: 'has no session',
    [PROVIDER_LOCKED]: 'session is locked',
    'missing-item': 'item not found',
    'ambiguous-item': 'item selection is ambiguous',
    'provider-failure': 'provider command failed',
  }[code];
  const wrapped = new Error(`pass-cli ${detail}`);
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}

function runPass(args) {
  try {
    return execFileSync('pass-cli', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw passCliFailure(error);
  }
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

export function createProtonPassCredentialProvider({ run = runPass, write = writeFileSync } = {}) {
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
          AGENT_IDENTITIES_VAULT,
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

function credentialTransactionPaths(directory) {
  return {
    journal: join(directory, TRANSACTION_FILE),
    issuerBackup: join(directory, ISSUER_BACKUP),
    keyBackup: join(directory, KEY_BACKUP),
  };
}

export function recoverCredentialTransaction({
  slug,
  directory,
  exists = existsSync,
  read = readFileSync,
  rename = renameSync,
  remove = rmSync,
} = {}) {
  const paths = credentialTransactionPaths(directory);
  if (!exists(paths.journal)) {
    // The journal is removed only after both new files are published. Backups
    // left after that point are obsolete residue from a completed transaction.
    remove(paths.issuerBackup, { force: true });
    remove(paths.keyBackup, { force: true });
    return false;
  }
  let record;
  try {
    record = JSON.parse(read(paths.journal, 'utf8'));
  } catch (error) {
    throw preparationError(
      'credential-transaction-invalid',
      slug,
      'the credential transaction marker is invalid; inspect the App directory before retrying',
      error,
    );
  }
  if (
    record?.version !== 1
    || typeof record.issuerExisted !== 'boolean'
    || typeof record.keyExisted !== 'boolean'
  ) {
    throw preparationError(
      'credential-transaction-invalid',
      slug,
      'the credential transaction marker is invalid; inspect the App directory before retrying',
    );
  }
  const issuer = join(directory, 'app-id');
  const key = join(directory, 'private-key.pem');
  try {
    if (record.issuerExisted) {
      if (exists(paths.issuerBackup)) rename(paths.issuerBackup, issuer);
    } else {
      remove(issuer, { force: true });
    }
    if (record.keyExisted) {
      if (exists(paths.keyBackup)) rename(paths.keyBackup, key);
    } else {
      remove(key, { force: true });
    }
    remove(paths.journal, { force: true });
    remove(paths.issuerBackup, { force: true });
    remove(paths.keyBackup, { force: true });
  } catch (error) {
    throw preparationError(
      'credential-transaction-recovery-failed',
      slug,
      'the previous credential publication could not be rolled back; repair file permissions and retry',
      error,
    );
  }
  return true;
}

// Both halves of an App's credentials come from one `item view`. A mint needs
// the key *and* the issuer, so provisioning only one of them leaves the App
// unusable — restore whichever is missing on the same trip.
export function ensurePrivateKey({
  slug,
  force = false,
  home = homedir(),
  run = runPass,
  exists = existsSync,
  mkdir = mkdirSync,
  write = writeFileSync,
  read = readFileSync,
  remove = rmSync,
  chmod = chmodSync,
  rename = renameSync,
  validateKey = validatePrivateKey,
  provider,
} = {}) {
  const path = privateKeyPath(slug, home);
  const idPath = appIdPath(slug, home);
  const directory = dirname(path);
  recoverCredentialTransaction({ slug, directory, exists, read, rename, remove });
  let needKey = force || !exists(path);
  let needId = force || !exists(idPath);
  if (!needId) {
    let current;
    try {
      current = read(idPath, 'utf8');
    } catch (error) {
      throw preparationError('unreadable-issuer', slug, 'the existing app-id file cannot be read', error);
    }
    needId = !validateIssuer(current);
  }
  if (!needKey) {
    let current;
    try {
      current = read(path, 'utf8');
    } catch (error) {
      throw preparationError('unreadable-private-key', slug, 'the existing private key cannot be read', error);
    }
    needKey = !validateKey(current);
  }
  if (!needKey && !needId) {
    return {
      path,
      downloaded: false,
      idPath,
      appIdWritten: false,
      localStatus: 'ready',
      restored: [],
    };
  }

  mkdir(directory, { recursive: true });
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const issuerTemporary = needId ? `${idPath}.${suffix}` : null;
  const keyTemporary = needKey ? `${path}.${suffix}` : null;
  const activeProvider = provider ?? createProtonPassCredentialProvider({ run, write });
  try {
    activeProvider.restore({
      slug,
      issuerDestination: issuerTemporary,
      privateKeyDestination: keyTemporary,
    });
    if (issuerTemporary) {
      const issuer = validateIssuer(read(issuerTemporary, 'utf8'));
      if (!issuer) {
        throw preparationError(
          'malformed-issuer',
          slug,
          'the restored App ID/client ID is malformed; replace it in the credential provider',
        );
      }
      write(issuerTemporary, `${issuer}\n`, { mode: 0o600 });
      chmod(issuerTemporary, 0o600);
    }
    if (keyTemporary) {
      const key = read(keyTemporary, 'utf8');
      if (!validateKey(key)) {
        throw preparationError(
          'malformed-private-key',
          slug,
          'the restored private key is malformed; replace the provider attachment or "Private Key" field',
        );
      }
      chmod(keyTemporary, 0o600);
    }
    const transaction = credentialTransactionPaths(directory);
    const issuerExisted = issuerTemporary ? exists(idPath) : false;
    const keyExisted = keyTemporary ? exists(path) : false;
    write(transaction.journal, `${JSON.stringify({
      version: 1,
      issuerExisted,
      keyExisted,
    })}\n`, { flag: 'wx', mode: 0o600 });
    if (issuerTemporary && issuerExisted) rename(idPath, transaction.issuerBackup);
    if (keyTemporary && keyExisted) rename(path, transaction.keyBackup);
    if (issuerTemporary) rename(issuerTemporary, idPath);
    if (keyTemporary) rename(keyTemporary, path);
    remove(transaction.journal, { force: true });
    remove(transaction.issuerBackup, { force: true });
    remove(transaction.keyBackup, { force: true });
  } catch (error) {
    if (issuerTemporary) remove(issuerTemporary, { force: true });
    if (keyTemporary) remove(keyTemporary, { force: true });
    try {
      recoverCredentialTransaction({ slug, directory, exists, read, rename, remove });
    } catch (recoveryError) {
      throw recoveryError;
    }
    if (error instanceof CredentialPreparationError) throw error;
    throw preparationError(
      'provider-failure',
      slug,
      'the credential provider could not restore the requested credential files',
      error,
    );
  }
  const restored = [needId ? 'app-id' : null, needKey ? 'private-key' : null].filter(Boolean);
  return {
    path,
    downloaded: needKey,
    idPath,
    appIdWritten: needId,
    localStatus: 'restored',
    restored,
  };
}

export function main(argv = process.argv.slice(2)) {
  const { force, explicit } = parseCliArgs(argv);
  // Territory-aware unless --app states the App outright — the shared policy
  // set by appConfig in mint-token.mjs (#20): inherited defaults (GH_AGENT_APP,
  // the pin) are corrected inside bot territory, explicit requests are honored.
  const slug = resolveAgentSlug({ explicit, worktree: !explicit });
  if (!slug) throw new Error('no App resolves; pass --app, set GH_AGENT_APP, or configure a pin');
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
