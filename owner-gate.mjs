// Owner gate for owner-only actions (#293).
//
// Missing soul markers do not make a caller the owner: a soul can unset its
// Agent ID, App and binding and still run in the owner's account. An owner
// action therefore needs both:
//
// 1. No soul marker. An Agent ID, a binding, or an App identity in the
//    environment or the worktree refuses the action, whatever else the caller
//    presents, so a soul's own binding never approves (ADR-0275 decision 4).
// 2. A proof a soul does not hold:
//    - the owner's presence through agent-bot-keyd (owner-presence.mjs,
//      #416): Touch ID where the Mac has it, otherwise the login password,
//      signed by the helper GeniusBar ships. Asked first wherever keyd is
//      installed and a person can be asked; or
//    - the owner's agent-comms principal credential (agent-comms ADR-0003,
//      ADR-0006 decision 8), presented by the caller and checked with one
//      `health` round trip to the broker. It is never loaded from disk here:
//      a gate that read it for the caller would pass every process in the
//      owner's account. The broker must run under another account, because
//      a same-account process can stand up a socket that passes custody
//      checks and answers ok; or
//    - the macOS authorization dialog (owner-approval.mjs, #204), which needs
//      a person to authenticate as an administrator. It is the fallback when
//      keyd cannot ask: no GeniusBar, an unsigned keyd, or no GUI session
//      (ssh, headless). A person's "no" through keyd never falls back to it.
//
// Same-account isolation is cooperative (agent-comms ADR-0003): a process
// that can write the owner's state files can skip this gate entirely. The
// gate makes the supported path require the owner, not the files.

import process from 'node:process';
import { readBinding } from './agent-binding.mjs';
import { currentAgentId } from './agent-identity.mjs';
import { listSouls, populationFile } from './agent-population.mjs';
import { CommsClient, commsPaths } from './comms-client.mjs';
import { requireOwnerApproval } from './owner-approval.mjs';
import { keydPresence } from './owner-presence.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';

const AGENT_ID = /agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const MAX_SUMMARY = 400;
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The soul markers this caller carries. A marker that cannot be read counts,
// so a broken binding or config refuses rather than reading as the owner.
export function soulMarkers({ env = process.env, cwd = process.cwd(), detect = true } = {}) {
  const markers = [];
  const probe = (label, check) => {
    try { if (check()) markers.push(label); } catch { markers.push(`${label} (unreadable)`); }
  };
  probe('Agent ID', () => Boolean(env.AGENT_BOT_ID || env.QWTS_AGENT_ID) || currentAgentId({ env, cwd }) !== null);
  probe('agent binding', () => Boolean(env.AGENT_BOT_BINDING) || readBinding({ env, cwd }) !== null);
  probe('App identity', () => resolveAgentSlug({ env, cwd, detect }) !== null);
  return markers;
}

// One authenticated `health` request as the presented principal. Returns the
// principal ID for the record; the secret never leaves this function.
export async function verifyPrincipalOwner(credential, {
  env = process.env,
  paths = commsPaths({ env }),
  clientFactory = (options) => new CommsClient(options),
  uid = process.getuid(),
} = {}) {
  if (!credential || typeof credential !== 'object' || !PRINCIPAL.test(credential.principal ?? '')
    || typeof credential.secret !== 'string' || !credential.secret
    || !Number.isInteger(credential.brokerUid) || credential.brokerUid < 0) {
    throw new Error('the presented principal credential is invalid');
  }
  if ((credential.mode ?? 'group') !== 'group' || credential.brokerUid === uid) {
    throw new Error('a broker in this account cannot vouch for the owner; approve with the consent dialog instead');
  }
  const client = clientFactory({ socketPath: paths.socket, brokerUid: credential.brokerUid, mode: 'group' });
  try {
    await client.request({ op: 'health', auth: { principal: credential.principal, secret: credential.secret } }, { paths });
  } catch (error) {
    throw new Error(`the broker did not accept the owner principal (${error.code ?? 'error'}: ${error.message})`);
  }
  return { method: 'principal', principal: credential.principal };
}

// The action in the owner's words, naming each soul by name and Agent ID:
// what the Touch ID prompt and the administrator dialog show. The gate's
// `action` stays the stable, command-shaped string audits record.
export function ownerActionSummary(action, { env = process.env, souls = null } = {}) {
  let names = new Map();
  try {
    names = new Map((souls ?? listSouls({ file: populationFile({ env }) })).map((soul) => [soul.id, soul.name]));
  } catch { /* no population: Agent IDs alone */ }
  const label = (id) => (names.get(id) ? `${names.get(id)} (${id})` : id);
  const words = action.split(' ');
  const [first, second, id, ...rest] = words;
  let summary = null;
  if (first === 'soul' && second === 'comms' && ['on', 'off'].includes(rest[0]) && rest.length === 1) {
    summary = `turn agent comms ${rest[0]} for ${label(id)}`;
  } else if (first === 'soul' && second === 'cold-wake' && rest[0] === 'webhook' && rest.length === 1) {
    summary = `let a webhook wake ${label(id)} when messages arrive`;
  } else if (first === 'soul' && second === 'cold-wake' && ['on', 'off'].includes(rest[0]) && rest.length === 1) {
    summary = `turn waking on new messages ${rest[0]} for ${label(id)}`;
  } else if (first === 'soul' && second === 'cold-wake' && rest[0] === 'resume' && rest.length === 2) {
    summary = `let ${label(id)} wake on new messages by resuming its session (${rest[1]})`;
  } else if (first === 'soul' && second === 'confinement' && rest.length === 1) {
    summary = `set file confinement to ${rest[0]} for ${label(id)}`;
  } else if (first === 'soul' && second === 'revision' && rest.length === 1) {
    summary = `${id} a revision of ${label(rest[0])}`;
  } else if (first === 'identity' && second === 'migrate-credentials') {
    const to = rest[0] === '--to' && rest[1] ? ` to ${rest[1] === 'keyd' ? 'agent-bot-keyd' : rest[1]}` : '';
    summary = id === '--all' ? `move every soul's GitHub App key${to}` : `move the GitHub App key of ${label(id)}${to}`;
  }
  summary ??= action.replace(AGENT_ID, label);
  summary = summary.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary;
}

export async function consentOwner(action, { platform, run, summary = action } = {}) {
  requireOwnerApproval({ prompt: `agent-bot wants to ${summary}. Approve only if you asked for this.`,
    outcome: 'nothing was changed', platform, run });
  return { method: 'consent' };
}

// keyd first (Touch ID or the login password); the administrator dialog only
// when keyd cannot ask anyone here. A person's refusal is final.
export async function presenceOrConsent(action, {
  env = process.env,
  presence = keydPresence,
  consent = consentOwner,
  summarize = ownerActionSummary,
} = {}) {
  const summary = summarize(action, { env });
  try {
    return await presence(summary, { env });
  } catch (error) {
    if (error.code !== 'presence-unavailable') throw new Error(`${action} was not approved: ${error.message}`);
  }
  return consent(action, { summary });
}

// Returns the authorization to record: `{ method: 'principal', principal }`,
// `{ method: 'presence', via: 'agent-bot-keyd' }` or `{ method: 'consent' }`.
// Throws when the caller is a soul or unproven.
export async function assertOwnerAction(action, {
  env = process.env,
  cwd = process.cwd(),
  detect = true,
  principal = null,
  markers = soulMarkers,
  verifyPrincipal = verifyPrincipalOwner,
  consent = presenceOrConsent,
} = {}) {
  const found = markers({ env, cwd, detect });
  if (found.length) throw new Error(`${action} is owner only; this caller has a soul's ${found.join(', ')}`);
  return principal ? verifyPrincipal(principal, { env }) : consent(action, { env });
}
