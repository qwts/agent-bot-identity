// The owner's agent-comms principal credential, checked against the broker
// (agent-comms ADR-0003). It lives with comms because the check is a comms
// request; owner-gate.mjs takes it as an injected verifier, and
// owner-action.mjs wires it for the commands that accept a principal (#645).
import process from 'node:process';
import { CommsClient, commsPaths } from './comms-client.mjs';
import { ownerCredentialRequired } from './owner-gate.mjs';

const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  } catch {
    // A broker/transport error can reflect the credential. Never relay it.
    throw ownerCredentialRequired('the broker did not accept the owner principal');
  }
  return { method: 'principal', principal: credential.principal };
}
