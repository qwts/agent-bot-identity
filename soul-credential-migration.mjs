// `agent-bot identity migrate-credentials` (#383, #397): copies each soul's
// App key into its own store, then declares that store in soul.json as a
// revision edit. The stores and their reads are identity's
// (soul-credentials.mjs); the declaration and its revision are the soul's,
// so the command lives here and identity never imports the census or the
// revision chain for it (#645). The command line is
// cli/migrate-credentials.mjs, which wires the owner gate's principal check
// and census (owner-action.mjs).

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { stateDirectory, validateAgentId } from './agent-identity.mjs';
import { listSouls, populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { loadConfig } from './config.mjs';
import { appStoreTarget, legacyAppFolderStatus, migrateAppMetadata, readManagedAppCredential } from './identity-app-store.mjs';
import { NAMESPACE_VARIABLE, credentialNamespace, itemTitle, managedAppItem, soulAppItem, soulSecretItem } from './credential-names.mjs';
import { profileAppSlugs } from './organization-profile.mjs';
import { assertOwnerAction, soulMarkers } from './owner-gate.mjs';
import {
  credentialStores,
  defaultCredentialStore,
  legacyCredentialDirectory,
  legacyKeyRemovable,
  readLegacyCredential,
  readSoulCredential,
  readSoulSecret,
  verifyAppCredential,
  writeSoulCredential,
  writeSoulSecret,
} from './soul-credentials.mjs';
import { declaredProviders } from './soul-providers.mjs';
import { readSoulManifest } from './soul-runtimes.mjs';
import { soulCredentialsDeclaration, writeSoulCredentialsDeclaration } from './soul-package.mjs';
import { editSoulRevision, revisionHistory } from './soul-revisions.mjs';

const USAGE = 'usage: agent-bot identity migrate-credentials [--soul AGENT_ID|NAME | --all] [--to keyd|pass-cli | --from-namespace OLD] [--dry-run] [--json] [--principal-stdin]';

function parseArgs(argv) {
  const options = { soul: null, all: false, dryRun: false, json: false, principal: false, to: null, fromNamespace: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--principal-stdin') options.principal = true;
    else if (arg === '--soul' && argv[index + 1] && !argv[index + 1].startsWith('--')) options.soul = argv[++index];
    else if (arg === '--to' && ['keyd', 'pass-cli'].includes(argv[index + 1])) options.to = argv[++index];
    else if (arg === '--from-namespace' && argv[index + 1] !== undefined && options.fromNamespace === null) options.fromNamespace = argv[++index];
    else throw new Error(USAGE);
  }
  if (options.all === Boolean(options.soul)) throw new Error(USAGE);
  if (options.fromNamespace !== null && options.to) throw new Error(USAGE);
  return options;
}

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
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
  assertOwner = assertOwnerAction,
  gate = (action, { principal }) => assertOwner(action, { principal, env, cwd }),
  stores = credentialStores({ env }),
  verify = (credential) => verifyAppCredential(credential, { env }),
  revisions = { history: revisionHistory, edit: editSoulRevision },
  now = () => new Date(),
  keyd = null,
} = {}) {
  const options = parseArgs(argv);
  // The old namespace is checked like the host's own, before any store call;
  // copying a namespace onto itself is a mistake, not a no-op.
  let names = null;
  if (options.fromNamespace !== null) {
    if (options.fromNamespace === '') throw Object.assign(new Error(`usage: --from-namespace needs the old ${NAMESPACE_VARIABLE} value`), { code: 'usage' });
    names = { from: credentialNamespace({ [NAMESPACE_VARIABLE]: options.fromNamespace }), to: credentialNamespace(env) };
    if (names.from === names.to) {
      throw Object.assign(new Error(`usage: --from-namespace ${names.from} is already this host's credential namespace`), { code: 'usage' });
    }
  }
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
    : await gate(`identity migrate-credentials ${options.all ? '--all' : souls[0].id}${options.to ? ` --to ${options.to}` : ''}${names ? ` --from-namespace ${names.from}` : ''}`, { principal });
  if (names) {
    return migrateFromNamespace(souls, { file, env, home, platform, stores, verify, options, names, now, write,
      sourceStores: credentialStores({ env: { ...env, [NAMESPACE_VARIABLE]: names.from } }) });
  }
  const stateDir = stateDirectory({ env, home });
  const declare = async (soul, soulDir, github) => {
    // Record where the key now lives. A soul with a revision chain records
    // it as an owner edit, like `soul comms`.
    const previous = writeSoulCredentialsDeclaration(soulDir, github);
    try {
      if (previous !== null && revisions.history(soul.id, { stateDir }).length) {
        await revisions.edit(soul.id, soulDir, { reason: 'declare per-soul credentials', stateDir,
          ...(authorization?.method ? { authorization } : {}) });
      }
    } catch (error) {
      writeFileSync(path.join(soulDir, 'soul.json'), previous);
      throw error;
    }
  };
  if (options.to === 'pass-cli') {
    return finishMigration(await migrateToPassCli(souls, { file, env, home, platform, stores, verify, options, declare }),
      { options, env, home, now, write, stores });
  }
  if (options.to === 'keyd') {
    const client = keyd ?? await import('./keyd-client.mjs').then((module) => ({
      importKeys: (items) => module.importIntoKeyd(items, { env, home }),
    }));
    return finishMigration(await migrateToKeyd(souls, { file, env, home, platform, stores, verify, options, client, declare }),
      { options, env, home, now, write, stores });
  }
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
    if (row.store === 'keyd') { Object.assign(row, { status: 'already-migrated' }); continue; }
    const target = { agentId: soul.id, soulDir, declaration };
    try {
      let stored;
      try { stored = readSoulCredential(target, { stores, platform }); }
      catch (error) {
        if (row.store !== 'pass-cli' || error.code !== 'missing-item') throw error;
      }
      let legacy = null;
      legacy = readManagedAppCredential(declaration.app, { env, home, stores });
      if (!legacy) { try { legacy = readLegacyCredential(declaration.app, home, env); } catch { /* reported below */ } }
      if (stored && (!legacy || same(stored, legacy))) {
        if (!options.dryRun) await verify(stored);
        Object.assign(row, { status: 'already-migrated' });
        continue;
      }
      if (!legacy) { Object.assign(row, { status: 'skipped', detail: `no legacy key in ~/.config/${declaration.app}` }); continue; }
      if (options.dryRun) { Object.assign(row, { status: 'would-migrate' }); continue; }
      await verify(legacy);
      writeSoulCredential(target, legacy, { stores, platform });
      const back = readSoulCredential(target, { stores, platform });
      if (!same(back, legacy)) throw new Error('the store did not return what was written');
      if (!declared) await declare(soul, soulDir, { app: declaration.app, store: row.store });
      Object.assign(row, { status: 'migrated' });
    } catch (error) {
      Object.assign(row, { status: 'failed', detail: row.store === 'pass-cli' ? 'could not verify or store the soul credential in pass-cli; the source was kept' : error.message });
    }
  }
  return finishMigration(results, { options, env, home, now, write, stores });
}

// Explicit destination migration preserves the source and publishes the new
// declaration only after verification/readback. A missing destination is
// expected here; normal reads fail closed on missing pass-cli items.
async function migrateToPassCli(souls, { file, env, home, platform, stores, verify, options, declare }) {
  const results = [];
  for (const soul of souls) {
    const row = { agentId: soul.id, name: soul.name ?? null, app: null, store: 'pass-cli', status: null, detail: null };
    results.push(row);
    let soulDir;
    try { soulDir = soulDirectory(soul.id, { file, env, home }); }
    catch { Object.assign(row, { status: 'skipped', detail: 'no soul directory' }); continue; }
    try {
      const declaration = soulCredentialsDeclaration(soulDir)
        ?? (soul.appSlug ? { app: soul.appSlug, store: defaultCredentialStore(platform) } : null);
      if (!declaration) { Object.assign(row, { status: 'skipped', detail: 'no GitHub App' }); continue; }
      row.app = declaration.app;
      if (declaration.store === 'keyd') throw new Error('keyd-held');
      const source = { agentId: soul.id, soulDir, declaration };
      const destination = { ...source, declaration: { app: row.app, store: 'pass-cli' } };
      let credential;
      try { credential = readSoulCredential(source, { stores, platform }); }
      catch (error) {
        if (declaration.store !== 'pass-cli' || error.code !== 'missing-item') throw error;
      }
      let origin = declaration.store ?? defaultCredentialStore(platform);
      if (!credential) {
        credential = readManagedAppCredential(row.app, { env, home, stores });
        origin = credential ? 'managed-app' : 'legacy';
        credential ??= readLegacyCredential(row.app, home, env);
      }
      if (origin === 'pass-cli') {
        if (!options.dryRun) await verify(credential);
        Object.assign(row, { status: 'already-migrated' });
        continue;
      }
      if (options.dryRun) { Object.assign(row, { status: 'would-migrate', detail: `from ${origin}` }); continue; }
      await verify(credential);
      writeSoulCredential(destination, credential, { stores, platform });
      const back = readSoulCredential(destination, { stores, platform });
      if (!same(back, credential) || back.webhookSecret !== credential.webhookSecret) throw new Error('readback failed');
      await declare(soul, soulDir, destination.declaration);
      Object.assign(row, { status: 'migrated', detail: `the ${origin} copy was kept` });
    } catch {
      // Neither provider nor verifier errors may reflect the credential.
      Object.assign(row, { status: 'failed', detail: 'could not verify, store, or declare the soul credential in pass-cli; the source was kept' });
    }
  }
  return results;
}

// --to keyd: each soul's key, from its current store or the legacy folder,
// is checked live and handed to agent-bot-keyd in one owner import, so the
// owner answers one Touch ID or password prompt for all of them. keyd pins
// this daemon's grant key on the first import. Only then does soul.json say
// `store: keyd`. The old copies are left where they were and reported.
async function migrateToKeyd(souls, { file, env, home, platform, stores, verify, options, client, declare }) {
  const results = [];
  const moving = [];
  for (const soul of souls) {
    const row = { agentId: soul.id, name: soul.name ?? null, app: null, store: 'keyd', status: null, detail: null };
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
    if (declaration.store === 'keyd') { Object.assign(row, { status: 'already-migrated' }); continue; }
    try {
      const from = declaration.store ?? defaultCredentialStore(platform);
      let credential = readSoulCredential({ agentId: soul.id, soulDir, declaration }, { stores, platform });
      let origin = from;
      if (!credential) {
        try {
          credential = readManagedAppCredential(declaration.app, { env, home, stores });
          origin = credential ? 'managed-app' : 'legacy';
          credential ??= readLegacyCredential(declaration.app, home, env);
        }
        catch { Object.assign(row, { status: 'skipped', detail: `no key in the ${from} store or ~/.config/${declaration.app}` }); continue; }
      }
      if (options.dryRun) { Object.assign(row, { status: 'would-migrate', detail: `from ${origin}` }); continue; }
      await verify(credential);
      moving.push({ soul, soulDir, row, origin, credential });
    } catch (error) {
      Object.assign(row, { status: 'failed', detail: error.message });
    }
  }
  if (!moving.length) return results;
  try {
    await client.importKeys(moving.map(({ soul, row, credential }) => ({
      agentId: soul.id, app: row.app, appId: credential.appId, privateKeyPem: credential.privateKeyPem,
    })));
  } catch (error) {
    for (const { row } of moving) Object.assign(row, { status: 'failed', detail: error.message });
    return results;
  }
  for (const { soul, soulDir, row, origin } of moving) {
    try {
      await declare(soul, soulDir, { app: row.app, store: 'keyd' });
      Object.assign(row, { status: 'migrated', detail: `the ${origin} copy was kept` });
    } catch (error) {
      Object.assign(row, { status: 'failed', detail: `keyd holds the key, but soul.json was not updated: ${error.message}` });
    }
  }
  return results;
}

function finishMigration(results, { options, env, home, now, write, stores }) {
  const bySlug = new Map();
  for (const row of results.filter((entry) => entry.app)) {
    const list = bySlug.get(row.app) ?? [];
    list.push(row);
    bySlug.set(row.app, list);
  }
  if (options.all) {
    const config = loadConfig({ env, home });
    for (const slug of new Set([...Object.keys(config.identityApps ?? {}), ...Object.values(config.apps ?? {}), ...profileAppSlugs(config)])) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
    }
  }
  const removable = [];
  const apps = [];
  for (const [slug, rows] of bySlug) {
    let metadata;
    try { metadata = migrateAppMetadata(slug, { env, home, dryRun: options.dryRun }); }
    catch { metadata = { status: 'failed', fields: [] }; }
    const keyRemovable = !options.dryRun
      && rows.every((entry) => ['migrated', 'already-migrated'].includes(entry.status))
      && legacyKeyRemovable(slug, { env, home, stores });
    let folder;
    try { folder = legacyAppFolderStatus(slug, { env, home, stores, keyRemovable }); }
    catch { folder = { legacyFolderRemovable: false, remainingFiles: ['<unreadable-metadata>'], removalCommand: null }; }
    apps.push({ slug, metadata, ...folder });
    const keyFile = path.join(legacyCredentialDirectory(slug, home), 'private-key.pem');
    try { if (keyRemovable && lstatSync(keyFile).isFile()) removable.push(keyFile); } catch { /* no legacy key */ }
  }
  if (!options.dryRun) {
    for (const row of results.filter((entry) => entry.status === 'migrated' || entry.status === 'failed')) {
      appendAuditReceipt({ event: 'credential-migrate', agentId: row.agentId, operation: `github-app ${row.store}`,
        decision: row.status }, { env, home, now });
    }
  }
  const report = { schemaVersion: 1, dryRun: options.dryRun, souls: results, apps, removableLegacyKeys: removable, deleted: [] };
  if (options.json) write(`${JSON.stringify(report)}\n`);
  else {
    for (const row of results) {
      write(`${row.agentId} ${row.app ?? '-'} ${row.store ?? '-'} ${row.status}${row.detail ? ` (${row.detail})` : ''}\n`);
    }
    for (const app of apps) {
      write(`${app.slug} metadata ${app.metadata.status}: ${app.metadata.fields.join(', ') || '-'}; legacyFolderRemovable: ${app.legacyFolderRemovable}; remaining: ${app.remainingFiles.join(', ') || '-'}\n`);
      if (app.removalCommand) write(`owner may remove (not deleted): ${app.removalCommand}\n`);
    }
    if (removable.length) write(`legacy key files nothing needs any more (not deleted):\n${removable.map((entry) => `  ${entry}\n`).join('')}`);
  }
  return report;
}

// --from-namespace OLD (#676): copies what a host stored under its old
// credential namespace into the one its environment resolves now. Only the
// Keychain and pass-cli name items by namespace; a file or keyd store is
// skipped. Each copy is read back from the new name and compared before it
// counts, a different value already there is never overwritten, and the old
// items are never deleted. The store kind does not change, so soul.json is
// not edited. Output names items, never values.
async function migrateFromNamespace(souls, { file, env, home, platform, stores, sourceStores, verify, options, names, now, write }) {
  const NAMESPACED = ['keychain', 'pass-cli'];
  const absent = (read) => {
    try { return read(); } catch (error) { if (error.code === 'missing-item') return null; throw error; }
  };
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  // One item: read the old, compare with the new, copy, read back.
  const copy = async (row, { read, writeTo, check = async () => {} }) => {
    if (!NAMESPACED.includes(row.store)) { Object.assign(row, { status: 'skipped', detail: `the ${row.store} store is not named by namespace` }); return; }
    try {
      const old = absent(() => read(sourceStores));
      if (old === null || old === undefined) { Object.assign(row, { status: 'skipped', detail: `nothing stored under ${names.from}` }); return; }
      const current = absent(() => read(stores));
      if (current !== null && current !== undefined) {
        Object.assign(row, equal(current, old) ? { status: 'already-migrated' }
          : { status: 'failed', detail: `${names.to} already holds a different value; nothing was overwritten` });
        return;
      }
      if (options.dryRun) { Object.assign(row, { status: 'would-migrate' }); return; }
      await check(old);
      writeTo(stores, old);
      if (!equal(absent(() => read(stores)), old)) throw new Error('readback');
      Object.assign(row, { status: 'migrated', detail: `the ${names.from} copy was kept` });
    } catch {
      // Neither provider nor verifier errors may reflect the credential.
      Object.assign(row, { status: 'failed', detail: `could not verify, copy or read back the credential; the ${names.from} copy was kept` });
    }
  };
  const title = (item) => itemTitle(item);
  const results = [];
  for (const soul of souls) {
    let soulDir;
    try { soulDir = soulDirectory(soul.id, { file, env, home }); }
    catch { results.push({ kind: 'github-app', agentId: soul.id, name: soul.name ?? null, status: 'skipped', detail: 'no soul directory' }); continue; }
    let declaration;
    let secrets = {};
    try {
      declaration = soulCredentialsDeclaration(soulDir) ?? (soul.appSlug ? { app: soul.appSlug } : null);
      secrets = declaredProviders(readSoulManifest(soulDir)).secrets;
    } catch (error) {
      results.push({ kind: 'github-app', agentId: soul.id, name: soul.name ?? null, status: 'failed', detail: error.message });
      continue;
    }
    if (declaration) {
      const target = { agentId: soul.id, soulDir, declaration };
      const row = { kind: 'github-app', agentId: soul.id, name: soul.name ?? null, app: declaration.app,
        store: declaration.store ?? defaultCredentialStore(platform),
        from: title(soulAppItem(soul.id, declaration.app, { namespace: names.from })),
        to: title(soulAppItem(soul.id, declaration.app, { namespace: names.to })), status: null, detail: null };
      results.push(row);
      await copy(row, {
        read: (set) => readSoulCredential(target, { stores: set, platform }),
        writeTo: (set, credential) => writeSoulCredential(target, credential, { stores: set, platform }),
        check: verify,
      });
    }
    for (const [secret, secretDeclaration] of Object.entries(secrets)) {
      const target = { agentId: soul.id, soulDir, name: secret, declaration: secretDeclaration };
      const row = { kind: 'secret', agentId: soul.id, name: soul.name ?? null, secret,
        store: secretDeclaration.store ?? defaultCredentialStore(platform),
        from: title(soulSecretItem(soul.id, secret, { namespace: names.from })),
        to: title(soulSecretItem(soul.id, secret, { namespace: names.to })), status: null, detail: null };
      results.push(row);
      await copy(row, {
        read: (set) => readSoulSecret(target, { stores: set, platform }),
        writeTo: (set, value) => writeSoulSecret(target, value, { stores: set, platform }),
      });
    }
  }
  // A managed App's key (identity apps) belongs to no soul, so only --all
  // copies it.
  const apps = [];
  if (options.all) {
    const config = loadConfig({ env, home });
    for (const [slug, declaration] of Object.entries(config.identityApps ?? {})) {
      if (!declaration?.store) continue;
      const row = { kind: 'managed-app', app: slug, store: declaration.store,
        from: title(managedAppItem(slug, { namespace: names.from })), to: title(managedAppItem(slug, { namespace: names.to })),
        status: null, detail: null };
      apps.push(row);
      const target = appStoreTarget(slug, { env, home });
      await copy(row, {
        read: (set) => set[declaration.store].read(target),
        writeTo: (set, credential) => set[declaration.store].write(target, credential),
        check: verify,
      });
    }
  }
  if (!options.dryRun) {
    for (const row of [...results, ...apps].filter((entry) => entry.status === 'migrated' || entry.status === 'failed')) {
      appendAuditReceipt({ event: 'credential-migrate', agentId: row.agentId ?? null,
        operation: `${row.kind} ${row.store} namespace-copy`, decision: row.status,
        detail: `namespace ${names.from} -> ${names.to}`, ...(row.app ? { appSlug: row.app } : {}) }, { env, home, now });
    }
  }
  const report = { schemaVersion: 1, dryRun: options.dryRun, fromNamespace: names.from, namespace: names.to, souls: results, apps, deleted: [] };
  if (options.json) write(`${JSON.stringify(report)}\n`);
  else {
    for (const row of [...results, ...apps]) {
      const subject = row.kind === 'managed-app' ? row.app : `${row.agentId} ${row.kind === 'secret' ? `secret ${row.secret}` : row.app ?? '-'}`;
      write(`${subject} ${row.store ?? '-'} ${row.status}${row.from ? ` (${row.from} -> ${row.to})` : ''}${row.detail ? ` (${row.detail})` : ''}\n`);
    }
    write(`nothing was deleted; the ${names.from} items stay until the owner removes them\n`);
  }
  return report;
}
