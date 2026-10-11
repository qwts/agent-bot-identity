// Run under no-exec.mjs by owner-challenge-route.test.mjs: a daemon built
// with createDaemonServer's own defaults (no ownerGate, no attester) decides
// one waiting tool request with no statement, and prints the route's answer.
import process from 'node:process';
import { createDaemonServer } from '../../agent-daemon.mjs';

const env = { ...process.env };
// TEST_DAEMON_HOME, when set, is the daemon's home and env.HOME another.
const server = createDaemonServer({ env, home: env.TEST_DAEMON_HOME ?? env.HOME, config: {} });
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
const waiting = server.interaction.requestTurnApproval({ agentId: env.TEST_AGENT_ID, operation: { permission: { toolName: 'Bash', input: { command: 'git push' } } }, summary: 'push', tool: 'Bash' });
waiting.catch(() => {});
const [row] = (await (await fetch(`${base}/v0/approvals`, { headers })).json()).proposals;
const response = await fetch(`${base}/v0/approvals/decide`, {
  method: 'POST', headers, body: JSON.stringify({ proposalId: row.proposalId, decision: 'approve', digest: row.operationDigest }),
});
const body = await response.json();
for (const open of server.interaction.listProposalsForOwner().proposals) {
  server.interaction.decideProposalAsOwner({ proposalId: open.proposalId, decision: 'deny', digest: open.operationDigest });
}
await new Promise((resolve) => { server.close(resolve); });
process.stdout.write(`${JSON.stringify({ status: response.status, code: body.code ?? null, error: body.error ?? null, challenges: body.challenges?.length ?? 0 })}\n`);
process.exit(0);
