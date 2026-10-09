// The turn registry (#645): one place every cold, launch and interactive turn
// runs through, so pause, stop and history see all of them. Soul lifecycle,
// not the wake plane; wake-plane.mjs re-exports it for the daemon host.

import { createSessionGrants } from './session-approvals.mjs';
import { assertSoulUnpaused } from './agent-population.mjs';

// Shared by cold, launch and interactive turns. Keep each controller until
// its executor settles: abort requests cancellation, it does not prove exit.
// A soul may have overlapping interactive sessions; stop reaches every turn.
// `history` (soul-history.mjs) hears every turn run here as one mirror
// line: id, kind, times, harness, outcome; never the message or the reply.
export function createTurnRegistry({ isPaused = () => false, history = null, now = () => new Date() } = {}) {
  const active = new Map();
  const sessionGrants = createSessionGrants();
  const track = (agentId, controller) => {
    const turns = active.get(agentId) ?? new Set();
    active.set(agentId, turns);
    turns.add(controller);
    return () => {
      turns.delete(controller);
      if (!turns.size) active.delete(agentId);
    };
  };
  return {
    track,
    sessionGrants,
    busy: () => [...active.keys()],
    stop(agentId) {
      sessionGrants.clear(agentId);
      let stopped = false;
      for (const controller of active.get(agentId) ?? []) {
        if (!controller.signal.aborted) { controller.abort(); stopped = true; }
      }
      return stopped;
    },
    async run(input, executor, { turnTimeoutMs = 30 * 60_000 } = {}) {
      assertSoulUnpaused(isPaused(input.invocation.agentId));
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(turnTimeoutMs), ...(input.signal ? [input.signal] : [])]);
      const release = track(input.invocation.agentId, controller);
      const startedAt = now().toISOString();
      let outcome = 'ok';
      try {
        signal.throwIfAborted();
        const result = await executor({ ...input, signal, sessionGrants });
        signal.throwIfAborted();
        return result;
      } catch (error) {
        outcome = signal.aborted ? 'cancelled' : 'failed';
        if (signal.aborted) throw new DOMException('turn cancelled', 'AbortError');
        throw error;
      } finally {
        release();
        if (history) {
          const { invocation } = input;
          // A task turn is one whatever lane ran it; otherwise the caller says.
          const kind = invocation.taskId !== undefined && invocation.taskId !== null ? 'task' : input.kind ?? 'turn';
          try { history.turn(invocation.agentId, { id: invocation.invocationId ?? null, kind, startedAt, endedAt: now().toISOString(), harness: invocation.harness ?? null, outcome }); }
          catch { /* the mirror is best effort; the port logs */ }
        }
      }
    },
  };
}
