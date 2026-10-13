// The owner's agent-comms principal credential, checked against the broker
// (agent-comms ADR-0003). It lives with comms because the check is a comms
// request; owner-gate.mjs takes it as an injected verifier, and
// owner-action.mjs wires it for the commands that accept a principal (#645).
import process from 'node:process';
import { CommsClient, commsPaths } from './comms-client.mjs';
import { isAgentId, ownerCredentialRequired } from './identity-format.mjs';

const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/;

// Targeted commands check the broker's current target grant. A credential
// with no target proves nothing about the owner: the broker's health request
// accepts any principal it knows, so it is refused before the broker is
// asked (#1063, owner decision 2026-10-12). Those actions take presence until
// scoped broker owner grants cover them.
export async function verifyPrincipalOwner(credential, {
  env = process.env,
  paths = commsPaths({ env }),
  clientFactory = (options) => new CommsClient(options),
  uid = process.getuid(),
  target = undefined,
} = {}) {
  if (!credential || typeof credential !== 'object' || !PRINCIPAL.test(credential.principal ?? '')
    || typeof credential.secret !== 'string' || !credential.secret
    || !Number.isInteger(credential.brokerUid) || credential.brokerUid < 0) {
    throw new Error('the presented principal credential is invalid');
  }
  if ((credential.mode ?? 'group') !== 'group' || credential.brokerUid === uid) {
    throw new Error('a broker in this account cannot vouch for the owner; approve with the consent dialog instead');
  }
  if (target === undefined) {
    throw ownerCredentialRequired('a principal credential authorizes only targeted owner actions; approve this one with presence');
  }
  const principal = credential.principal;
  const auth = { principal, secret: credential.secret };
  // Snapshot before any asynchronous request. Target comes from the command,
  // never the credential JSON, action display text, or caller's OS account.
  const agentId = target?.agentId;
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || Object.keys(target).length !== 1 || !isAgentId(agentId)) {
    throw ownerCredentialRequired('the owner action target is invalid');
  }
  const client = clientFactory({ socketPath: paths.socket, brokerUid: credential.brokerUid, mode: 'group' });
  try {
    const result = await client.request({ op: 'principal-target-check', agentId, auth }, { paths });
    if (result?.principal !== principal || result.agentId !== agentId
      || (result.account !== null && (typeof result.account !== 'string' || !ACCOUNT.test(result.account)))) {
      throw new Error('target check response does not match');
    }
  } catch {
    // A broker/transport error can reflect the credential. Never relay it.
    throw ownerCredentialRequired('the broker did not accept the owner principal');
  }
  return { method: 'principal', principal };
}
