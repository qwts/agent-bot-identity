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

// Each builder takes the namespace a store resolved from its own
// environment; without one it resolves this process's.
export function soulAppItem(agentId, slug, { namespace = credentialNamespace() } = {}) {
  return { service: `${namespace}.soul.${validateAgentId(agentId)}`, account: `github-app/${slugOrThrow(slug)}` };
}

// `name` is a secret name its caller already validated (soul-providers).
export function soulSecretItem(agentId, name, { namespace = credentialNamespace() } = {}) {
  if (typeof name !== 'string' || !name || name.includes('/')) throw new Error('invalid secret name');
  return { service: `${namespace}.soul.${validateAgentId(agentId)}`, account: `secret/${name}` };
}

export function managedAppItem(slug, { namespace = credentialNamespace() } = {}) {
  return { service: `${namespace}.app.${slugOrThrow(slug)}`, account: `github-app/${slug}` };
}

// A pass-cli note joins the Keychain service and account into one title.
export function itemTitle({ service, account }) {
  return `${service}/${account}`;
}
