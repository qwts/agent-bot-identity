// The daemon's agent-comms relay for cold turns. A cold turn has nobody to
// approve a tool call, so the soul cannot run agent-comms itself: the daemon
// reads the soul's inbox as the soul, hands each message to a turn, sends the
// turn's answer back as the reply, and acks the message.
import { execFile } from 'node:child_process';
import process from 'node:process';

import { minimalChildEnv } from './child-env.mjs';

// The address a reply goes to: a principal by name, a soul by account/agent.
export function senderAddress(from) {
  if (typeof from?.principal === 'string') return from.principal;
  if (typeof from?.agentId === 'string') return from.account ? `${from.account}/${from.agentId}` : from.agentId;
  throw new Error('message has no sender address');
}

// Reply refusals that no retry can fix: the conversation hit the broker's
// reply-depth limit, or the sender is gone. The message is acked unanswered.
export const FINAL_REPLY_ERRORS = new Set(['reply-depth-exceeded', 'unknown-recipient']);

// Runs `agent-comms` as one soul: in its worktree, presenting only that
// soul's binding (never one the caller inherited), resolving to the parsed
// JSON result. The daemon relay and the reach-back MCP server (#146) share it,
// so both speak to the broker as the soul and nobody else. The broker client
// resolves from PATH, so it gets the child-env boundary (#785): the reach
// server would otherwise hand it a desktop harness's whole environment. The
// broker's own location settings are paths and a label, and cross by name.
const COMMS_CONFIG = ['AGENT_COMMS_SHARED_DIR', 'AGENT_COMMS_SERVICE_LABEL', 'AGENT_COMMS_BROKER_STATE_DIR'];

export function agentCommsAsSoul({ env = process.env, run = execFile } = {}) {
  return ({ agentId, binding }, args) => new Promise((resolve, reject) => {
    const config = Object.fromEntries(COMMS_CONFIG.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]));
    const { AGENT_BOT_BINDING: _inherited, ...hostEnv } = { ...minimalChildEnv(env), ...config };
    // The daemon's own mailbox reads are not deliveries: agent-comms reports
    // what `inbox read` printed to this daemon (agent-comms#100), and a read
    // made for the relay or the delivered route must not come back as one.
    const soulEnv = { ...hostEnv, ...(binding.file ? { AGENT_BOT_BINDING: binding.file } : {}), AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId, AGENT_COMMS_NO_DELIVERY_REPORT: '1' };
    run('agent-comms', args, { cwd: binding.worktree, env: soulEnv, timeout: 30_000 }, (error, stdout = '', stderr = '') => {
      let result = null;
      try { result = JSON.parse(String(stdout)); } catch {}
      if (!error && result && result.ok !== false) return resolve(result);
      const detail = result?.error?.message ?? (String(stderr).trim().split('\n').pop() || error?.message || 'no result');
      reject(Object.assign(new Error(`agent-comms ${args[0]} failed: ${detail}`), { code: result?.error?.code ?? null }));
    });
  });
}

/**
 * Returns { read, reply, ack, brief, report }, each running `agent-comms` as the soul in
 * its worktree with its binding, and resolving to the parsed JSON result.
 */
export function createCommsRelay({ env = process.env, run = execFile } = {}) {
  const asSoul = agentCommsAsSoul({ env, run });
  return {
    read: async (soul) => (await asSoul(soul, ['inbox', 'read'])).messages ?? [],
    reply: (soul, { to, replyTo, body, correlation = null }) => asSoul(soul, [
      'send', to, '--body', body, '--reply-to', replyTo, ...(correlation ? ['--correlation', correlation] : []),
    ]),
    brief: async (soul, messageId) => {
      try { return await asSoul(soul, ['task', 'brief', messageId]); }
      catch (error) {
        if (error.code === 'unknown-command' || /unknown (?:task )?(?:subcommand|command)/i.test(error.message)) return null;
        throw error;
      }
    },
    report: (soul, { taskId, invocationId, phase, outcome }) => asSoul(soul, [
      'task', 'invocation', taskId, '--id', invocationId, '--phase', phase,
      ...(outcome ? ['--outcome', outcome] : []),
    ]),
    ack: (soul, ids) => asSoul(soul, ['inbox', 'ack', ...ids]),
  };
}
