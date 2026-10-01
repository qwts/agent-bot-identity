// Opt-in, per-soul cold wake adapter. The dispatcher owns warm-socket
// selection; this port handles only the cold path and keeps one turn in
// flight per soul. Binding lookup is injected because bindings are owned by
// the daemon's private-git-dir registry: it resolves a soul to its worktree
// and the binding file the turn presents as AGENT_BOT_BINDING.

export function createColdWaker({ executor, settings, lookupBinding, identities, receipt }) {
  if (typeof executor !== 'function') throw new Error('cold waker requires an executor');
  if (typeof lookupBinding !== 'function') throw new Error('cold waker requires lookupBinding');
  if (typeof identities !== 'function') throw new Error('cold waker requires identities');
  if (typeof receipt !== 'function') throw new Error('cold waker requires receipt');
  const active = new Map();
  return async function coldWake(event) {
    const { agentId, count, cursor, messageIds } = event ?? {};
    const currentSettings = typeof settings === 'function' ? await settings() : settings;
    if (currentSettings?.[agentId] !== true) return { outcome: 'waiting', detail: 'cold wake is disabled' };
    if (active.has(agentId)) {
      active.get(agentId).ids.push(...(Array.isArray(messageIds) ? messageIds : []));
      return { outcome: 'cold', detail: 'merged into the active turn' };
    }
    const flight = { ids: Array.isArray(messageIds) ? [...messageIds] : [] };
    active.set(agentId, flight);
    try {
      const binding = await lookupBinding(agentId);
      if (!binding?.worktree || !binding?.file) throw new Error('soul binding is unavailable');
      const identity = await identities(agentId);
      if (!identity?.harness) throw new Error('soul harness identity is unavailable');
      const prompt = `There are ${Number.isSafeInteger(count) ? count : flight.ids.length} agent-comms messages waiting (IDs: ${flight.ids.join(', ')}). Read them with agent-comms inbox --full, act, and ack.`;
      await executor({
        invocation: { agentId, harness: identity.harness, cwd: binding.worktree, cursor },
        message: { text: prompt },
        attachments: [],
        env: { AGENT_BOT_BINDING: binding.file },
      });
      receipt({ event: 'cold-wake', agentId, decision: 'started' });
      return { outcome: 'cold', detail: 'turn started' };
    } catch (error) {
      const detail = error?.message || 'cold wake failed';
      receipt({ event: 'cold-wake', agentId, decision: 'failed' });
      return { outcome: 'failed', detail };
    } finally {
      active.delete(agentId);
    }
  };
}
