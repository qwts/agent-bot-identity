// Identity's format contract (#645, F1 and F4, owner decision D2): the Agent
// ID, principal and transport formats, the audit receipt writer, the git
// config key names, the owner-credential refusal, tool-call display risk, the
// git hook names and the credential item names. Soul, host, cli and comms
// import these from here instead of identity internals, and the module map
// lists every export under `contracts`. After identity leaves this
// repository, a test keeps this file byte-identical with its copy there
// (ADR-0645, answer 2), so it imports nothing but node built-ins and the
// shared state-paths.mjs. Receipts are the same `audit.jsonl` lines at the
// same path, appended in-process, so they still work while the daemon is down.

import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { interactionHome } from '../state-paths.mjs';

const ID_PATTERN = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL_ID_PATTERN = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSPORT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function isAgentId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function validateAgentId(id) {
  if (!isAgentId(id)) {
    throw new Error(`invalid Agent ID: ${JSON.stringify(id)}`);
  }
  return id;
}

export function validatePrincipalId(value) {
  if (typeof value !== 'string' || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new Error('invalid principal ID');
  }
  return value;
}

export function validateTransport(value) {
  if (typeof value !== 'string' || !TRANSPORT_PATTERN.test(value)) {
    throw new Error('transport must be a short lowercase slug');
  }
  return value;
}

function printableText(name, value, { max = 512 } = {}) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${name} must be printable text no longer than ${max} characters`);
  }
  return value;
}

function agentIdOrThrow(value, name = 'soul') {
  try {
    return validateAgentId(value);
  } catch {
    throw new Error(`${name} must be a valid Agent ID`);
  }
}

function ensurePrivateDirectory(directory) {
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created === undefined) return;
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* POSIX modes are best-effort on other platforms. */
  }
}

// Secret-free audit receipts (#57 req 7, #31). Append-only JSONL under the
// interaction home. Only whitelisted identifier fields are recorded — never
// provider tokens, display names, or message bodies. A credential mint also
// names the App it minted for (`appSlug`) and a fixed reason code for its
// outcome (`reason`, #107); both are optional, so older readers ignore them.
// An inbox take names where its bearer came from (`bearerSource`, #229), as
// one of a fixed set of labels — the bearer itself is never recorded.
const BEARER_SOURCES = new Set(['env', 'pass-cli']);

export function auditFile({ env = process.env, home = homedir() } = {}) {
  return path.join(interactionHome({ env, home }), 'audit.jsonl');
}

// Enforcement profiles (Soul Agent Platform 0.4 §4, R8), strongest first.
// The daemon never claims more than it can show: today members share its
// trust domain, so the best it is is `managed cooperative`; with legacy local
// custody on, App keys sit on the host and it is `standalone unenforced`.
export const ENFORCEMENT_PROFILES = Object.freeze({
  protected: 'managed protected',
  cooperative: 'managed cooperative',
  standalone: 'standalone unenforced',
});
const PROFILE_STRENGTH = [ENFORCEMENT_PROFILES.standalone, ENFORCEMENT_PROFILES.cooperative, ENFORCEMENT_PROFILES.protected];

// Legacy local custody (App keys on the host) is off unless the owner opts
// in, and the opt-in stops working at this instant (stage 3 exit or this
// date, whichever comes first; owner decision 2026-10-27).
export const LEGACY_LOCAL_CUSTODY_REMOVE_BY = '2027-01-31T00:00:00.000Z';

function configSettings({ env, home }) {
  // config.mjs's path, read here without importing it (this file imports
  // only node built-ins and state-paths.mjs). A missing or malformed file is
  // no opt-in.
  try {
    const file = env.AGENT_BOT_CONFIG ?? path.join(home, '.config', 'agent-bot', 'config.json');
    const settings = JSON.parse(readFileSync(file, 'utf8'))?.settings;
    return settings && typeof settings === 'object' ? settings : {};
  } catch {
    return {};
  }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

/**
 * Whether legacy local custody is on: `{ enabled, source, expired }`.
 * `source` is `env` (AGENT_BOT_LEGACY_LOCAL_CUSTODY) or `config`
 * (settings.legacyLocalCustody: true); an opt-in after the removal date is
 * reported `expired` and is not enabled.
 */
export function legacyLocalCustody({ env = process.env, home = homedir(), now = () => new Date() } = {}) {
  let source = null;
  if (TRUE_VALUES.has(String(env.AGENT_BOT_LEGACY_LOCAL_CUSTODY ?? '').trim().toLowerCase())) source = 'env';
  else if (configSettings({ env, home }).legacyLocalCustody === true) source = 'config';
  const expired = source !== null && now().getTime() >= Date.parse(LEGACY_LOCAL_CUSTODY_REMOVE_BY);
  return { enabled: source !== null && !expired, source, expired };
}

/** The enforcement profile in force here: `{ profile, reason }`. */
export function enforcementProfile({ env = process.env, home = homedir(), now = () => new Date() } = {}) {
  if (legacyLocalCustody({ env, home, now }).enabled) {
    return { profile: ENFORCEMENT_PROFILES.standalone, reason: 'legacy-local-custody' };
  }
  return { profile: ENFORCEMENT_PROFILES.cooperative, reason: 'members-share-trust-domain' };
}

/** A profile name in canonical form, or null; `cooperative` etc. are accepted. */
export function normalizeProfile(value) {
  if (typeof value !== 'string') return null;
  const words = value.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  if (words === 'protected' || words === ENFORCEMENT_PROFILES.protected) return ENFORCEMENT_PROFILES.protected;
  if (words === 'cooperative' || words === ENFORCEMENT_PROFILES.cooperative) return ENFORCEMENT_PROFILES.cooperative;
  if (words === 'standalone' || words === ENFORCEMENT_PROFILES.standalone) return ENFORCEMENT_PROFILES.standalone;
  return null;
}

/** The refusal for a claim stronger than the profile in force (0.4 T21). */
export function profileInsufficient(claimed, actual) {
  return Object.assign(
    new Error(`the ${claimed} profile cannot be claimed here: the profile in force is ${actual}`),
    { code: 'profile-insufficient', statusCode: 403, claimed, actual },
  );
}

/**
 * Throws `profile-insufficient` when `claim` names a profile stronger than the
 * one in force, or names no known profile. Returns the profile in force.
 */
export function assertProfileClaim(claim, options = {}) {
  const { profile } = enforcementProfile(options);
  const wanted = normalizeProfile(claim);
  if (wanted === null) throw profileInsufficient(String(claim).slice(0, 40), profile);
  if (PROFILE_STRENGTH.indexOf(wanted) > PROFILE_STRENGTH.indexOf(profile)) throw profileInsufficient(wanted, profile);
  return profile;
}

// Why a receipt's decision went the way it did (#382), one line. A URL is
// never kept: a webhook's URL is a secret, and an error may carry one.
function receiptDetail(value) {
  const line = String(value).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function appendAuditReceipt(
  { event, principalId = null, transport = null, agentId = null, operation = null, decision = null, detail = null, appSlug = null, reason = null, bearerSource = null, issuanceId = null, taskId = null, operationId = null, session_id = null },
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  if (bearerSource !== null && !BEARER_SOURCES.has(bearerSource)) throw new Error('audit receipt bearerSource must be env or pass-cli');
  // A credential's reference, never the credential (0.4 Appendix A): the
  // identity service's issuance record ID and the task and operation it was
  // minted for.
  const reference = (name, value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`audit receipt ${name} must be 1-128 characters of [A-Za-z0-9._:-]`);
    return value;
  };
  const receipt = {
    at: now().toISOString(),
    event: printableText('event', event, { max: 40 }),
    // Every receipt names the enforcement profile it was written under
    // (0.4 R8), so no record reads stronger than what was actually in force.
    profile: enforcementProfile({ env, home, now }).profile,
    ...(principalId === null ? {} : { principalId: validatePrincipalId(principalId) }),
    ...(transport === null ? {} : { transport: validateTransport(transport) }),
    ...(agentId === null ? {} : { agentId: agentIdOrThrow(agentId, 'agentId') }),
    ...(operation === null ? {} : { operation: printableText('operation', operation, { max: 40 }) }),
    ...(decision === null ? {} : { decision: printableText('decision', decision, { max: 40 }) }),
    ...(detail === null ? {} : { detail: receiptDetail(detail) }),
    ...(appSlug === null ? {} : { appSlug: printableText('appSlug', appSlug, { max: 100 }) }),
    ...(reason === null ? {} : { reason: printableText('reason', reason, { max: 40 }) }),
    ...(bearerSource === null ? {} : { bearerSource }),
    ...(issuanceId === null ? {} : { issuanceId: reference('issuanceId', issuanceId) }),
    ...(taskId === null ? {} : { taskId: reference('taskId', taskId) }),
    ...(operationId === null ? {} : { operationId: reference('operationId', operationId) }),
    ...(session_id === null ? {} : { session_id: reference('session_id', session_id) }),
  };
  const file = auditFile({ env, home });
  ensurePrivateDirectory(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

// Git config keys. setup-worktree writes the App pin; a checkout records its
// Agent ID. Prefer the standalone name; accept the playbook-engineering name so
// a migrated machine keeps working.
export const PIN_KEYS = ['agentBot.app', 'qwts.agentApp'];
export const AGENT_ID_KEYS = ['agentBot.agentId', 'qwts.agentId'];

// The refusal every owner-only path throws when no owner credential is shown.
export function ownerCredentialRequired(message = 'an authenticated owner principal or explicit owner consent is required') {
  return Object.assign(new Error(message), { code: 'owner-credential-required', statusCode: 403 });
}

// Display risk only; permission policy remains the authority to execute.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead', 'Task', 'Agent']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'terminal', 'execute', 'shell']);
const COMPUTER_TOOLS = new Set([
  'computer', 'computer_use', 'computer-use', 'screenshot', 'left_click', 'right_click',
  'double_click', 'type', 'key', 'scroll', 'mouse_move', 'left_click_drag', 'open_application',
]);
const DESTRUCTIVE = /\brm\s+-[^\s]*r|\bgit\s+push\b[^\n;]*\s(?:--force(?:-with-lease)?|-f)\b|\bgit\s+reset\b[^\n;]*--hard\b|\bgit\s+clean\b|\bgit\s+branch\b[^\n;]*\s-D\b|\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\b|\bVACUUM\s+FULL\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkill\s+-9\b|\blaunchctl\s+unload\b|\bdefaults\s+write\b|\b(?:chmod|chown)\s+-R\b|>\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|fd\/)|:\(\)\s*\{/i;

function toolSegment(toolName) {
  return toolName.replace(/^mcp__.+?__/, '');
}

export function isComputerUse(toolName) {
  return typeof toolName === 'string' && (
    toolName.startsWith('mcp__computer-use__')
    || toolName.startsWith('mcp__remote-devices__computer_')
    || COMPUTER_TOOLS.has(toolSegment(toolName))
  );
}

export function classifyRisk(input) {
  if (!input || typeof input !== 'object') return 'external';
  const { toolName, summary, operation } = input;
  if (typeof toolName !== 'string' || !toolName) return 'external';
  // A computer-use server can expose read-like names while using the screen.
  if (isComputerUse(toolName)) return 'external';
  const tool = toolSegment(toolName);
  if (READ_TOOLS.has(tool) || (toolName.startsWith('mcp__') && /^(?:get_|list_|read_|search_|fetch_context)/.test(tool))) return 'safe';
  if (WRITE_TOOLS.has(toolName)) return 'safe';
  if (!SHELL_TOOLS.has(toolName)) return 'external';
  let operationText = '';
  try { operationText = typeof operation === 'string' ? operation : JSON.stringify(operation) ?? ''; }
  catch { return 'external'; }
  const text = [typeof summary === 'string' ? summary : '', operationText].join('\n').slice(0, 2000);
  return DESTRUCTIVE.test(text) ? 'destructive' : 'external';
}

// Git hook names installed and exposed by agent-bot. Keep this inventory
// explicit: the sibling chain-hook is an internal dispatcher, never a public
// hook and never copied into the command surface.

export const GIT_HOOK_NAMES = [
  'applypatch-msg',
  'commit-msg',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'p4-prepare-changelist',
  'post-applypatch',
  'post-checkout',
  'post-commit',
  'post-index-change',
  'post-merge',
  'post-rewrite',
  'pre-applypatch',
  'pre-auto-gc',
  'pre-commit',
  'pre-merge-commit',
  'pre-push',
  'pre-rebase',
  'prepare-commit-msg',
  'reference-transaction',
  'sendemail-validate',
];

// Credential item names (#676; formerly credential-names.mjs). Every Keychain
// item and pass-cli note a credential store reads, writes, deletes or names in
// a diagnostic is built here. Today's names are the defaults and stay
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
