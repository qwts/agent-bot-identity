#!/usr/bin/env node
// Provider secrets for a soul (#583 slice 4, ADR-0583 decision 7).
//
// A soul's `harnesses.<h>.provider` names a model provider, and
// `credentials.secrets.<name>` declares the secret that provider needs. The
// owner stores the value with `agent-bot soul secret <soul> set <name>`:
// the value arrives on stdin only, never on argv, and goes to the declared
// store (keychain, file or pass-cli) under a service/account namespaced by
// soul id and secret name. At launch the daemon reads it back and sets the
// provider's `envKey` in the launched harness's environment and nowhere
// else: not in the reach server, not in keyd's relay, never in a journal,
// a receipt or a log. `status` says `present` or `missing` per declared
// secret and nothing about the value, not even its length.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { credentialStores, defaultCredentialStore, deleteSoulSecret, readSoulSecret, writeSoulSecret } from './soul-credentials.mjs';
import { declaredProviders, secretNameOrThrow, secretSetCommand } from './soul-providers.mjs';
import { readSoulManifest } from './soul-runtimes.mjs';

export const SECRETS_SCHEMA_VERSION = 1;
export const SECRET_ACTIONS = Object.freeze(['set', 'clear', 'status']);
const USAGE = 'usage: agent-bot soul secret <agentId|name> set <name> [--json] [--principal-stdin] | soul secret <agentId|name> clear <name> [--json] [--principal-stdin] | soul secret <agentId|name> status [--json]';
// A secret is one line of printable text; a control character is a pasted
// file or a terminal artefact, not a key.
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, action });
}

function resolveSoul(id, options) {
  const file = options.file ?? populationFile(options);
  try { return typeof id === 'string' && id.startsWith('agent_') ? showSoul(id, { file }) : showSoulByName(id, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}

function soulRoot(soul, options) {
  const registered = typeof soul.soulDir === 'string' && existsSync(soul.soulDir) ? soul.soulDir : null;
  return registered ?? soulDirectory(soul.id, { ...options, readOnly: true });
}

// Reads one declared secret's presence through its store: `present`,
// `missing`, or `unreadable` with the store's redacted reason. The value
// itself never leaves this function.
function presence(target, storeOptions) {
  try { return readSoulSecret(target, storeOptions) === null ? { status: 'missing', reason: null } : { status: 'present', reason: null }; }
  catch (error) { return { status: 'unreadable', reason: `${error.code ?? 'store-failed'}: ${error.message}` }; }
}

/**
 * The providers a soul declares per harness and the secrets they name, each
 * with its store and whether the store holds it. Pure over the manifest
 * except for the store probes; never throws on a bad manifest (that is
 * `invalid[]`).
 */
export function inspectSoulSecrets(soulDir, { agentId, manifest = readSoulManifest(soulDir), stores = credentialStores(), platform = process.platform } = {}) {
  const { providers, secrets, invalid } = declaredProviders(manifest);
  const storeOptions = { stores, platform };
  const usedBy = {};
  for (const [harness, provider] of Object.entries(providers)) {
    if (provider.credential) (usedBy[provider.credential] ??= []).push(harness);
  }
  const secretRows = Object.entries(secrets).map(([name, declaration]) => {
    const store = declaration.store ?? defaultCredentialStore(platform);
    const { status, reason } = presence({ agentId, soulDir, name, declaration }, storeOptions);
    return { name, store, status, reason, usedBy: usedBy[name] ?? [] };
  });
  const byName = Object.fromEntries(secretRows.map((row) => [row.name, row]));
  const providerRows = Object.entries(providers).map(([harness, provider]) => {
    const secret = provider.credential ? byName[provider.credential] ?? null : null;
    const status = !provider.credential ? 'ready'
      : secret === null ? 'unsupported'
        : secret.status === 'present' ? 'ready'
          : secret.status === 'missing' ? 'secret-missing' : 'unsupported';
    const reason = !provider.credential ? null
      : secret === null ? `credentials.secrets.${provider.credential} is not declared`
        : secret.reason;
    return { harness, id: provider.id, name: provider.name, baseUrl: provider.baseUrl, envKey: provider.envKey, wireApi: provider.wireApi,
      credential: provider.credential, store: secret?.store ?? null, status, reason };
  });
  return { providers: providerRows, secrets: secretRows, invalid, ready: !invalid.length && providerRows.every((row) => row.status === 'ready') };
}

const report = (soul, soulDir, state) => ({ schemaVersion: SECRETS_SCHEMA_VERSION, agentId: soul.id, soulDir, ...state });

/** The provider and secret status of a soul by Agent ID or name (read-only). */
export function soulSecretsStatus(id, { env = process.env, home = env.HOME ?? homedir(), stores = credentialStores({ env }), platform = process.platform, ...rest } = {}) {
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  if (!existsSync(soulDir)) return report(soul, soulDir, { providers: [], secrets: [], invalid: [], ready: true });
  return report(soul, soulDir, inspectSoulSecrets(soulDir, { agentId: soul.id, stores, platform }));
}

// The one declared provider a launched harness needs, or null when the
// soul declares none for it. A bad declaration is a coded failure: a launch
// never guesses what the owner meant.
function providerFor(state, harness) {
  const broken = state.invalid.find((entry) => entry.path.startsWith(`harnesses.${harness}.provider`) || entry.path.startsWith('credentials.secrets'));
  if (broken) fail('provider-declaration-invalid', `${broken.path}: ${broken.message}`, { action: 'fix soul.json in a revision (agent-bot soul revision edit)' });
  return state.providers.find((row) => row.harness === harness) ?? null;
}

/**
 * The env patch the launched harness gets for its provider: `{ env:
 * { [envKey]: value }, envKey }`, or `{ env: {}, envKey: null }` when the
 * soul declares no provider for this harness (or no secret for it). A
 * declared secret that is not stored fails with `provider-secret-missing`
 * and the command that stores it; a store that cannot answer fails with
 * `provider-secret-unreadable`.
 */
export function soulProviderEnv(id, { env = process.env, home = env.HOME ?? homedir(), harness = null, stores = credentialStores({ env }), platform = process.platform, ...rest } = {}) {
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  const none = { env: {}, envKey: null, provider: null };
  if (!harness || !existsSync(soulDir)) return none;
  const manifest = readSoulManifest(soulDir);
  if (!manifest) return none;
  const state = inspectSoulSecrets(soulDir, { agentId: soul.id, manifest, stores, platform });
  const provider = providerFor(state, harness);
  if (!provider) return none;
  const summary = { harness, id: provider.id, envKey: provider.envKey, credential: provider.credential };
  if (!provider.credential) return { env: {}, envKey: null, provider: summary };
  const declaration = declaredProviders(manifest).secrets[provider.credential];
  let value;
  try { value = readSoulSecret({ agentId: soul.id, soulDir, name: provider.credential, declaration }, { stores, platform }); }
  catch (error) {
    fail('provider-secret-unreadable', `${harness}'s provider secret "${provider.credential}" could not be read from the ${declaration.store ?? defaultCredentialStore(platform)} store: ${error.message}`,
      { action: secretSetCommand(soul.id, provider.credential) });
  }
  if (value === null) {
    fail('provider-secret-missing', `${harness}'s provider ${provider.id} needs the secret "${provider.credential}" (${provider.envKey}), which is not stored for this soul`,
      { action: secretSetCommand(soul.id, provider.credential) });
  }
  return { env: { [provider.envKey]: value }, envKey: provider.envKey, provider: summary };
}

/** What a launch of this harness has to check (`harness:provider` labels), or [] (never throws). */
export function pendingSoulProvider(id, { harness = null, ...options } = {}) {
  try {
    const state = soulSecretsStatus(id, options);
    const labels = state.providers.filter((row) => row.harness === harness && row.credential).map((row) => `${row.harness}:${row.id}`);
    return [...labels, ...state.invalid.map((entry) => entry.path)];
  } catch { return []; }
}

/** Fails the launch with the coded reason when the harness's provider secret is not usable. */
export function checkSoulProvider(id, options = {}) {
  const { provider } = soulProviderEnv(id, options);
  return provider;
}

export function formatSecrets(result) {
  const lines = [`agentId: ${result.agentId}`, `soulDir: ${result.soulDir}`, `ready: ${result.ready}`, ''];
  for (const row of result.providers) {
    lines.push(`provider ${row.harness}: ${row.id}${row.baseUrl ? ` ${row.baseUrl}` : ''} ${row.envKey}${row.credential ? ` <- ${row.credential}` : ''} ${row.status}${row.reason ? ` - ${row.reason}` : ''}`);
  }
  for (const row of result.secrets) {
    lines.push(`secret ${row.name}: ${row.status} (${row.store})${row.usedBy.length ? ` for ${row.usedBy.join(', ')}` : ''}${row.reason ? ` - ${row.reason}` : ''}`);
  }
  for (const entry of result.invalid) lines.push(`invalid ${entry.path}: ${entry.message}`);
  if (!result.providers.length && !result.secrets.length && !result.invalid.length) lines.push('nothing declared');
  if (result.action) lines.push('', `${result.action}: ${result.name} ${result.status}`);
  return `${lines.join('\n')}\n`;
}

// The value comes on stdin and nowhere else. Without `--principal-stdin`
// stdin is the value; with it stdin is one JSON object `{ principal,
// value }`, since stdin carries one thing. Trailing line ends are the
// shell's, not the secret's.
function secretValue(text) {
  if (typeof text !== 'string') fail('secret-value-invalid', 'the secret value must be a string');
  const value = text.replace(/(?:\r?\n)+$/, '');
  if (!value) fail('secret-value-invalid', 'the secret value on stdin is empty');
  if (CONTROL.test(value)) fail('secret-value-invalid', 'the secret value must be one line of printable text');
  return value;
}

export async function soulSecretCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), stores, platform = process.platform, ...rest } = {}) {
  let id = null, action = null, name = null, json = false, presented = false;
  for (const arg of argv) {
    if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg.startsWith('-')) throw new Error(USAGE);
    else if (id === null) id = arg;
    else if (action === null && SECRET_ACTIONS.includes(arg)) action = arg;
    else if (action !== null && action !== 'status' && name === null) name = arg;
    else throw new Error(USAGE);
  }
  if (!id || !action || (action === 'status') !== (name === null) || (presented && action === 'status')) throw new Error(USAGE);
  const options = { env, home, now, ...rest, ...(stores ? { stores } : {}), platform };
  if (action === 'status') {
    const result = soulSecretsStatus(id, options);
    write(json ? `${JSON.stringify(result)}\n` : formatSecrets(result));
    return result;
  }
  secretNameOrThrow(name);
  // stdin is read once, before anything else could consume it, and the
  // value stays in this scope: it is never echoed, logged or receipted.
  let principal = null, value = null;
  if (action === 'set') {
    if (presented) {
      let parsed;
      try { parsed = JSON.parse(readStdin()); } catch { throw new Error('--principal-stdin needs one JSON object { principal, value } on stdin'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--principal-stdin needs one JSON object { principal, value } on stdin');
      principal = parsed.principal ?? null;
      value = secretValue(parsed.value);
    } else value = secretValue(readStdin());
  } else if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  const manifest = existsSync(soulDir) ? readSoulManifest(soulDir) : null;
  const { secrets, invalid } = declaredProviders(manifest ?? {});
  const broken = invalid.find((entry) => entry.path.startsWith('credentials.secrets'));
  if (broken) fail('provider-declaration-invalid', `${broken.path}: ${broken.message}`);
  if (!Object.hasOwn(secrets, name)) {
    fail('secret-not-declared', `${soul.id} does not declare credentials.secrets.${name} in soul.json`,
      { action: `declare credentials.secrets.${name} in a revision (agent-bot soul revision edit), then ${secretSetCommand(soul.id, name)}` });
  }
  const declaration = secrets[name];
  const store = declaration.store ?? defaultCredentialStore(platform);
  await gate(`${action} ${soul.id}'s provider secret "${name}" in its ${store} store`, { principal, env, cwd });
  const storeOptions = { stores: stores ?? credentialStores({ env, cwd }), platform };
  const target = { agentId: soul.id, soulDir, name, declaration };
  let decision;
  if (action === 'set') { writeSoulSecret(target, value, storeOptions); decision = 'stored'; }
  else decision = deleteSoulSecret(target, storeOptions) ? 'cleared' : 'absent';
  value = null;
  appendAuditReceipt({ event: 'soul-secret', agentId: soul.id, operation: action, decision, detail: `secret: ${name} (${store})` }, { env, home, now });
  const result = { ...report(soul, soulDir, inspectSoulSecrets(soulDir, { agentId: soul.id, stores: storeOptions.stores, platform })),
    action, name, store, status: decision === 'stored' ? 'present' : 'missing' };
  write(json ? `${JSON.stringify(result)}\n` : formatSecrets(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulSecretCommand(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'soul-secret-failed', message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul secret: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
