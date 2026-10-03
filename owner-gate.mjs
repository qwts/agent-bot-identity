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
//    - the owner's agent-comms principal credential (agent-comms ADR-0003,
//      ADR-0006 decision 8), presented by the caller and checked with one
//      `health` round trip to the broker. It is never loaded from disk here:
//      a gate that read it for the caller would pass every process in the
//      owner's account. The broker must run under another account, because
//      a same-account process can stand up a socket that passes custody
//      checks and answers ok; or
//    - the macOS authorization dialog (owner-approval.mjs, #204), which needs
//      a person to authenticate.
//
// Same-account isolation is cooperative (agent-comms ADR-0003): a process
// that can write the owner's state files can skip this gate entirely. The
// gate makes the supported path require the owner, not the files.

import process from 'node:process';
import { readBinding } from './agent-binding.mjs';
import { currentAgentId } from './agent-identity.mjs';
import { CommsClient, commsPaths } from './comms-client.mjs';
import { requireOwnerApproval } from './owner-approval.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';

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

export async function consentOwner(action, { platform, run } = {}) {
  requireOwnerApproval({ prompt: `agent-bot wants to ${action}. Approve only if you asked for this.`,
    outcome: 'nothing was changed', platform, run });
  return { method: 'consent' };
}

// Returns the authorization to record: `{ method: 'principal', principal }`
// or `{ method: 'consent' }`. Throws when the caller is a soul or unproven.
export async function assertOwnerAction(action, {
  env = process.env,
  cwd = process.cwd(),
  detect = true,
  principal = null,
  markers = soulMarkers,
  verifyPrincipal = verifyPrincipalOwner,
  consent = consentOwner,
} = {}) {
  const found = markers({ env, cwd, detect });
  if (found.length) throw new Error(`${action} is owner only; this caller has a soul's ${found.join(', ')}`);
  return principal ? verifyPrincipal(principal, { env }) : consent(action);
}
