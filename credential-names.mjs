// The names credentials are stored under (#676). Every Keychain item and
// pass-cli note a credential store reads, writes, deletes or names in a
// diagnostic is built here. Today's names are the defaults and stay
// byte-for-byte what earlier releases wrote:
//
// - a soul's App key: service `agent-bot.soul.<agentId>`, account
//   `github-app/<slug>`
// - a soul's provider secret: the same service, account `secret/<name>`
// - a managed App's key: service `agent-bot.app.<slug>`, account
//   `github-app/<slug>`
// - a keyd-held managed App's webhook secret (#110): service
//   `agent-bot.app.<slug>.webhook`, account `github-app/<slug>`; the file
//   store's `github-app-<slug>.webhook.json` (`.webhook.dpapi` on Windows)
// - the gh-app-hook inbox bearer the daemon presents for take_inbox (#229):
//   service `agent-bot.inbox`, account `gh-app-hook-inbox-token`
// - the owner's narrow GitHub token for delegation grants (#108): service
//   `agent-bot.human`, account `<login>-github-token`
// - pass-cli: one note in the `Agent Identities` vault, titled
//   `<service>/<account>`
//
// A host owns its names (ADR-0274 decision 7): the daemon's service unit
// sets AGENT_BOT_CREDENTIAL_NAMESPACE for the `agent-bot` prefix and
// AGENT_BOT_CREDENTIAL_VAULT for the pass-cli vault. A store reads only the
// names its own environment resolves; a miss there never falls back to the
// defaults or to another host's names. A malformed value refuses with
// `usage` when a store is built, before any store call.
//
// keyd's `agent-bot.keyd.*` items are named by keyd itself (#594).
import process from 'node:process';
import { validateAgentId } from './agent-identity.mjs';

export const CREDENTIAL_NAMESPACE = 'agent-bot';
export const CREDENTIAL_VAULT = 'Agent Identities';
export const NAMESPACE_VARIABLE = 'AGENT_BOT_CREDENTIAL_NAMESPACE';
export const VAULT_VARIABLE = 'AGENT_BOT_CREDENTIAL_VAULT';

// The namespace is one token of a Keychain service and the first part of a
// pass-cli title, so it has no `/`, quote or space. A vault name may hold
// inner spaces, as the default does.
const NAMESPACE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const VAULT = /^[A-Za-z0-9_](?:[A-Za-z0-9_ .-]{0,62}[A-Za-z0-9_.-])?$/;

function hostName(env, variable, pattern, fallback, rule) {
  const value = env[variable];
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw Object.assign(new Error(`usage: ${variable} must ${rule}`), { code: 'usage' });
  }
  return value;
}

export function credentialNamespace(env = process.env) {
  return hostName(env, NAMESPACE_VARIABLE, NAMESPACE, CREDENTIAL_NAMESPACE,
    'be at most 64 letters, digits, dots, underscores or hyphens and start with a letter, digit or underscore');
}

export function credentialVault(env = process.env) {
  return hostName(env, VAULT_VARIABLE, VAULT, CREDENTIAL_VAULT,
    'be at most 64 letters, digits, spaces, dots, underscores or hyphens, start with a letter, digit or underscore and not end with a space');
}

const APP_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;

export function slugOrThrow(slug) {
  if (typeof slug !== 'string' || !APP_SLUG.test(slug)) throw new Error('invalid GitHub App slug');
  return slug;
}

// The store kinds a credential may be declared in, by name only (#383):
// soul.json's `credentials.github.store` and a managed App's `store`. `keyd`
// is agent-bot-keyd's Keychain, which only that signed binary reads (#397).
// soul-package.mjs validates declarations against this list (#645).
export const CREDENTIAL_STORES = Object.freeze(['keychain', 'file', 'keyd', 'pass-cli']);

// A provider secret's name (#583 slice 4): the `secret/<name>` account and
// the file store's `secret-<name>` file. soul-providers.mjs re-exports it.
export const SECRET_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function secretNameOrThrow(value, label = 'secret name') {
  if (typeof value !== 'string' || !SECRET_NAME.test(value)) throw new Error(`${label} must use lowercase letters, digits and single hyphens (1-64 characters)`);
  return value;
}

// Each builder takes the namespace a store resolved from its own
// environment; without one it resolves this process's.
export function soulAppItem(agentId, slug, { namespace = credentialNamespace() } = {}) {
  return { service: `${namespace}.soul.${validateAgentId(agentId)}`, account: `github-app/${slugOrThrow(slug)}` };
}

// `name` is a secret name its caller already validated (secretNameOrThrow).
export function soulSecretItem(agentId, name, { namespace = credentialNamespace() } = {}) {
  if (typeof name !== 'string' || !name || name.includes('/')) throw new Error('invalid secret name');
  return { service: `${namespace}.soul.${validateAgentId(agentId)}`, account: `secret/${name}` };
}

export function managedAppItem(slug, { namespace = credentialNamespace() } = {}) {
  return { service: `${namespace}.app.${slugOrThrow(slug)}`, account: `github-app/${slug}` };
}

// A managed App whose key agent-bot-keyd holds (#110) keeps its manifest
// webhook secret beside it, never in the key item: a key item always holds a
// key. A slug has no `.`, so this service never meets another App's.
export function managedAppWebhookItem(slug, { namespace = credentialNamespace() } = {}) {
  return { service: `${namespace}.app.${slugOrThrow(slug)}.webhook`, account: `github-app/${slug}` };
}
export function managedAppWebhookFile(slug, extension = 'json') {
  return `github-app-${slugOrThrow(slug)}.webhook.${extension}`;
}

// One fleet-wide value, not per App or soul (docs/gh-app-hook.md): only the
// daemon reads it, so no caller holds it.
export function inboxBearerItem() {
  return { service: `${CREDENTIAL_NAMESPACE}.inbox`, account: 'gh-app-hook-inbox-token' };
}

// A pass-cli note joins the Keychain service and account into one title.
export function itemTitle({ service, account }) {
  return `${service}/${account}`;
}

// The human account's narrow GitHub token for delegation grants (#108): a
// fine-grained token with Issues and Pull requests write, which only the
// daemon reads to perform an owner-approved grant. Service
// `<namespace>.human`, account `<login>-github-token`.
export function humanTokenItem(login, { namespace = credentialNamespace() } = {}) {
  if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new Error('invalid GitHub login');
  return { service: `${namespace}.human`, account: `${login}-github-token` };
}
