// Child-process worker for the concurrent submission test: performs one
// submitInvocation against the store selected by AGENT_BOT_INTERACTION_HOME
// so the test exercises the cross-process lock, not in-process serialization.
import { submitInvocation } from '../../agent-jobs.mjs';

const [sessionId, agentId, principalId, transport, idempotencyKey] = process.argv.slice(2);
const { invocation, created } = submitInvocation({
  sessionId,
  agentId,
  principalId,
  transport,
  idempotencyKey,
});
process.stdout.write(`${JSON.stringify({ invocationId: invocation.invocationId, created })}\n`);
