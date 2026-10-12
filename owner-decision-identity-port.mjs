// The owner-decision final-entry identity port (agent-comms#77, C2): disabled,
// no route. The host builds it from identity's published readAgentIdentity
// (identity-host.mjs) in strict custody mode, and passes it into soul's
// locked final-entry core. It is synchronous and read-only: no process
// launch and no await, so it can run while the domain locks are held.
import path from 'node:path';
import { readAgentIdentity } from './identity-host.mjs';

export const OWNER_DECISION_IDENTITY_PORT_KIND = 'owner-decision-identity-read-v1';

export function createOwnerDecisionIdentityPort({ stateDir } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('an absolute identity state directory is required');
  return Object.freeze({
    kind: OWNER_DECISION_IDENTITY_PORT_KIND,
    read: (id) => readAgentIdentity(id, { stateDir, custody: 'strict' }),
  });
}
