// The names credentials are stored under (#676). Every Keychain item and
// pass-cli note a credential store reads, writes, deletes or names in a
// diagnostic is built here, so a host-owned namespace (ADR-0274 decision 7)
// can later change them in one place. Today's names are the defaults and
// stay byte-for-byte what earlier releases wrote:
//
// - a soul's App key: service `agent-bot.soul.<agentId>`, account
//   `github-app/<slug>`
// - a soul's provider secret: the same service, account `secret/<name>`
// - a managed App's key: service `agent-bot.app.<slug>`, account
//   `github-app/<slug>`
// - pass-cli: one note in the `Agent Identities` vault, titled
//   `<service>/<account>`
//
// keyd's `agent-bot.keyd.*` items are named by keyd itself (#594).
import { validateAgentId } from './agent-identity.mjs';

export const CREDENTIAL_NAMESPACE = 'agent-bot';
export const CREDENTIAL_VAULT = 'Agent Identities';

const APP_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;

export function slugOrThrow(slug) {
  if (typeof slug !== 'string' || !APP_SLUG.test(slug)) throw new Error('invalid GitHub App slug');
  return slug;
}

export function soulAppItem(agentId, slug) {
  return { service: `${CREDENTIAL_NAMESPACE}.soul.${validateAgentId(agentId)}`, account: `github-app/${slugOrThrow(slug)}` };
}

// `name` is a secret name its caller already validated (soul-providers).
export function soulSecretItem(agentId, name) {
  if (typeof name !== 'string' || !name || name.includes('/')) throw new Error('invalid secret name');
  return { service: `${CREDENTIAL_NAMESPACE}.soul.${validateAgentId(agentId)}`, account: `secret/${name}` };
}

export function managedAppItem(slug) {
  return { service: `${CREDENTIAL_NAMESPACE}.app.${slugOrThrow(slug)}`, account: `github-app/${slug}` };
}

// A pass-cli note joins the Keychain service and account into one title.
export function itemTitle({ service, account }) {
  return `${service}/${account}`;
}
