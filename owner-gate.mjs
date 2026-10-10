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
//    - an SSH-signed reply to the one-time CLI challenge (`owner-action.mjs`,
//      #753) when presence is unavailable and a local SSH pin is enrolled.
//      This is a user-mediated terminal path, not a daemon decision route; or
//    - the macOS authorization dialog (owner-approval.mjs, #204), which needs
//      a person to authenticate as an administrator. It remains the fallback
//      for enrollment/removal and actions with no enrolled owner keys. A
//      person's "no" through keyd never falls back to it.
//
// Same-account isolation is cooperative (agent-comms ADR-0003): a process
// that can write the owner's state files can skip this gate entirely. The
// gate makes the supported path require the owner, not the files.

import process from 'node:process';
import { readBinding } from './agent-binding.mjs';
import { currentAgentId } from './agent-identity.mjs';
import { requireOwnerApproval } from './owner-approval.mjs';
import { keydPresence } from './owner-presence.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { boundedOwnerSummary } from './owner-text.mjs';

const AGENT_ID = /agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function ownerCredentialRequired(message = 'an authenticated owner principal or explicit owner consent is required') {
  return Object.assign(new Error(message), { code: 'owner-credential-required', statusCode: 403 });
}

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

// A presented principal is checked by a verifier the caller wires in: the
// broker check lives with comms (owner-principal.mjs), and owner-action.mjs
// wires it for soul-level and host commands (#645). Nothing wired is a
// refusal, never a skipped check and never a fall-through to consent.
async function noPrincipalVerifier() {
  throw ownerCredentialRequired('no owner principal verifier is wired for this command');
}

// The action in the owner's words, naming each soul by name and Agent ID:
// what the Touch ID prompt and the administrator dialog show. The gate's
// `action` stays the stable, command-shaped string audits record.
// `listSouls` reads the census; owner-action.mjs wires the population's.
export function ownerActionSummary(action, { souls = null, listSouls = null } = {}) {
  let names = new Map();
  try {
    // The name the census shows (#429): the launch or join name, else the handle.
    names = new Map((souls ?? listSouls?.() ?? []).map((soul) => [soul.id, soul.displayName ?? soul.name]));
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
  } else if (first === 'soul' && second === 'mode' && rest[0] === 'autopilot' && ['repo', 'soul'].includes(rest[1])
    && /^sha256:[0-9a-f]{64}$/.test(rest[2] ?? '') && rest.length > 3) {
    // A repo or soul package asks for autopilot that nobody picked (#379).
    summary = `let ${label(id)} run in Auto-Pilot, as its ${rest[1] === 'repo' ? 'repo' : 'soul package'} asks (${rest.slice(3).join(' ')}, ${rest[2].slice(0, 19)})`;
  } else if (first === 'soul' && second === 'remove' && rest.length === 0) {
    summary = `remove ${label(id)} from this Mac (its folders are archived, not deleted)`;
  } else if (first === 'soul' && second === 'remove' && rest[0] === '--scope' && rest[1] === 'team' && rest.length === 2) {
    summary = `remove ${label(id)} and every soul it leads from this Mac (their folders are archived, not deleted)`;
  } else if (first === 'soul' && second === 'fork' && rest.length > 0) {
    summary = `make a copy of ${label(id)} a new soul named ${rest.join(' ')}`;
  } else if (first === 'soul' && second === 'app' && rest.length === 1) {
    summary = `let ${label(id)} act as the GitHub App ${rest[0]} from now on`;
  } else if (first === 'soul' && second === 'confinement' && rest.length === 1) {
    summary = `set file confinement to ${rest[0]} for ${label(id)}`;
  } else if (first === 'soul' && second === 'revision' && rest.length === 1) {
    summary = `${id} a revision of ${label(rest[0])}`;
  } else if (first === 'soul' && second === 'tool-home' && rest[1] === 'global' && rest.length === 2) {
    summary = `let ${label(id)} use this Mac's shared ${rest[0]} sign-in and sessions instead of its own`;
  } else if (first === 'identity' && second === 'migrate-credentials') {
    const to = rest[0] === '--to' && rest[1] ? ` to ${rest[1] === 'keyd' ? 'agent-bot-keyd' : rest[1]}` : '';
    // #676: a copy under this host's credential names; nothing is moved. A
    // vault name may hold spaces, so it runs to the end of the action.
    const vaultAt = rest.indexOf('--from-vault');
    const namespace = rest[0] === '--from-namespace' && rest[1] && (rest.length === 2 || vaultAt === 2) ? rest[1] : null;
    const vault = vaultAt === (namespace ? 2 : 0) && rest.length > vaultAt + 1 ? rest.slice(vaultAt + 1).join(' ') : null;
    if (namespace && (vault || rest.length === 2) || vault) {
      const from = [namespace ? `the ${namespace} credential names` : null, vault ? `the ${vault} pass-cli vault` : null].filter(Boolean).join(' and ');
      summary = id === '--all' ? `copy every soul's credentials from ${from} to this host's`
        : `copy the credentials of ${label(id)} from ${from} to this host's`;
    } else summary = id === '--all' ? `move every soul's GitHub App key${to}` : `move the GitHub App key of ${label(id)}${to}`;
  }
  summary ??= action.replace(AGENT_ID, label);
  return boundedOwnerSummary(summary);
}

export async function consentOwner(action, { platform, run, summary = action } = {}) {
  requireOwnerApproval({ prompt: `agent-bot wants to ${summary}. Approve only if you asked for this.`,
    outcome: 'nothing was changed', platform, run });
  return { method: 'consent' };
}

// keyd first (Touch ID or the login password). Only an unavailable presence
// check may continue to the signed challenge hook or administrator dialog;
// refusal and invalid challenge replies are final.
export async function presenceOrConsent(action, {
  env = process.env,
  presence = keydPresence,
  consent = consentOwner,
  summarize = ownerActionSummary,
  listSouls = null,
  challenge = null,
} = {}) {
  const summary = summarize(action, { env, listSouls });
  try {
    return await presence(summary, { env });
  } catch (error) {
    if (error.code !== 'presence-unavailable') {
      throw Object.assign(new Error(`${action} was not approved: ${error.message}`), { code: error.code, cause: error });
    }
  }
  if (challenge) {
    const proof = await challenge(action, { summary, env });
    if (proof) return proof;
  }
  return consent(action, { summary });
}

// Deciding a soul's waiting tool request (#438) lets that soul act, so the
// owner's presence is asked every time. A presented principal credential is
// checked as well but never stands in for presence: the daemon token, or a
// principal the daemon already trusts, proves a login, not the owner at the
// Mac. The caller is the daemon, which runs as the owner and carries no soul
// marker; the soul refusal stays with the command that called it.
export async function confirmOwnerPresence(action, {
  env = process.env,
  principal = null,
  verifyPrincipal = noPrincipalVerifier,
  consent = presenceOrConsent,
  listSouls = null,
} = {}) {
  const vouched = principal ? await verifyPrincipal(principal, { env }) : null;
  const proof = await consent(action, { env, listSouls });
  return vouched ? { ...proof, principal: vouched.principal } : proof;
}

// Returns the authorization to record: principal or keyd presence, `{ method:
// 'statement', via: 'ssh', key, fingerprint }` from the wired CLI challenge,
// or `{ method: 'consent' }`. Throws when the caller is a soul or unproven.
export async function assertOwnerAction(action, {
  env = process.env,
  cwd = process.cwd(),
  detect = true,
  principal = null,
  markers = soulMarkers,
  verifyPrincipal = noPrincipalVerifier,
  consent = presenceOrConsent,
  listSouls = null,
} = {}) {
  const found = markers({ env, cwd, detect });
  if (found.length) throw ownerCredentialRequired(`${action} is owner only; this caller has a soul's ${found.join(', ')}`);
  return principal ? verifyPrincipal(principal, { env }) : consent(action, { env, listSouls });
}
