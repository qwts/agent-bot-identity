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
  async function coldWake(event) {
    const { agentId, count, cursor, messageIds } = event ?? {};
    const currentSettings = typeof settings === 'function' ? await settings() : settings;
    if (currentSettings?.[agentId] !== true) return { outcome: 'waiting', detail: 'cold wake is disabled' };
    if (active.has(agentId)) {
      active.get(agentId).ids.push(...(Array.isArray(messageIds) ? messageIds : []));
      return { outcome: 'cold', detail: 'merged into the active turn' };
    }
    const flight = { ids: Array.isArray(messageIds) ? [...messageIds] : [], done: Promise.resolve() };
    active.set(agentId, flight);
    let binding;
    let identity;
    try {
      binding = await lookupBinding(agentId);
      if (!binding?.worktree || !binding?.file) throw new Error('soul binding is unavailable');
      identity = await identities(agentId);
      if (!identity?.harness) throw new Error('soul harness identity is unavailable');
    } catch (error) {
      active.delete(agentId);
      receipt({ event: 'cold-wake', agentId, decision: 'failed' });
      return { outcome: 'failed', detail: error?.message || 'cold wake failed' };
    }
    const prompt = `There are ${Number.isSafeInteger(count) ? count : flight.ids.length} agent-comms messages waiting (IDs: ${flight.ids.join(', ')}). Read them with agent-comms inbox --full, act, and ack.`;
    // The wake is reported `cold` once the turn starts (#259 req 3); the
    // turn itself runs on, and wakes that arrive meanwhile merge into it.
    let turn;
    try {
      turn = Promise.resolve(executor({
        invocation: { agentId, harness: identity.harness, cwd: binding.worktree, cursor },
        message: { text: prompt },
        attachments: [],
        env: { AGENT_BOT_BINDING: binding.file },
      }));
    } catch (error) {
      turn = Promise.reject(error);
    }
    flight.done = turn.then(
      () => receipt({ event: 'cold-wake', agentId, decision: 'finished' }),
      () => receipt({ event: 'cold-wake', agentId, decision: 'failed' }),
    ).finally(() => active.delete(agentId));
    receipt({ event: 'cold-wake', agentId, decision: 'started' });
    return { outcome: 'cold', detail: 'turn started' };
  }
  // Resolves when every turn in flight has ended (tests and shutdown).
  coldWake.idle = () => Promise.all([...active.values()].map((flight) => flight.done));
  return coldWake;
}
