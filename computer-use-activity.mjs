// Each daemon owns a registry. Overlapping turns share the first start time.
export function createComputerUseActivity({ now = () => new Date() } = {}) {
  const active = new Map();
  return {
    start(agentId, tool, turn = agentId) {
      const existing = active.get(agentId);
      if (existing) {
        existing.turns.add(turn);
        return null;
      }
      const record = { agentId, tool, since: now().toISOString() };
      active.set(agentId, { record, turns: new Set([turn]) });
      return { ...record };
    },
    stop(agentId, turn = agentId) {
      const entry = active.get(agentId);
      if (!entry || !entry.turns.delete(turn) || entry.turns.size) return null;
      active.delete(agentId);
      return { ...entry.record };
    },
    list() {
      return [...active.values()].map(({ record }) => ({ ...record }));
    },
  };
}
