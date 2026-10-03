// The daemon's agent-comms relay for cold turns. A cold turn has nobody to
// approve a tool call, so the soul cannot run agent-comms itself: the daemon
// reads the soul's inbox as the soul, hands each message to a turn, sends the
// turn's answer back as the reply, and acks the message.
import { execFile } from 'node:child_process';

// The address a reply goes to: a principal by name, a soul by account/agent.
export function senderAddress(from) {
  if (typeof from?.principal === 'string') return from.principal;
  if (typeof from?.agentId === 'string') return from.account ? `${from.account}/${from.agentId}` : from.agentId;
  throw new Error('message has no sender address');
}

// Reply refusals that no retry can fix: the conversation hit the broker's
// reply-depth limit, or the sender is gone. The message is acked unanswered.
export const FINAL_REPLY_ERRORS = new Set(['reply-depth-exceeded', 'unknown-recipient']);

/**
 * Returns { read, reply, ack, brief, report }, each running `agent-comms` as the soul in
 * its worktree with its binding, and resolving to the parsed JSON result.
 */
export function createCommsRelay({ env = process.env, run = execFile } = {}) {
  const asSoul = ({ agentId, binding }, args) => new Promise((resolve, reject) => {
    // Only the soul's own binding is presented, never one the daemon inherited.
    const { AGENT_BOT_BINDING: _inherited, ...hostEnv } = env;
    const soulEnv = { ...hostEnv, ...(binding.file ? { AGENT_BOT_BINDING: binding.file } : {}), AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId };
    run('agent-comms', args, { cwd: binding.worktree, env: soulEnv, timeout: 30_000 }, (error, stdout = '', stderr = '') => {
      let result = null;
      try { result = JSON.parse(String(stdout)); } catch {}
      if (!error && result && result.ok !== false) return resolve(result);
      const detail = result?.error?.message ?? (String(stderr).trim().split('\n').pop() || error?.message || 'no result');
      reject(Object.assign(new Error(`agent-comms ${args[0]} failed: ${detail}`), { code: result?.error?.code ?? null }));
    });
  });
  return {
    read: async (soul) => (await asSoul(soul, ['inbox', 'read'])).messages ?? [],
    reply: (soul, { to, replyTo, body }) => asSoul(soul, ['send', to, '--body', body, '--reply-to', replyTo]),
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
