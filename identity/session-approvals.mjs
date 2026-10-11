// Daemon-lifetime grants. A binding is a lease: clearing or replacing it
// invalidates even approvals that were still waiting when the session ended.
export function createSessionGrants() {
  const sessions = new Map();
  return {
    clear(agentId) { sessions.delete(agentId); },
    bind(agentId, harnessSessionId) {
      let session = sessions.get(agentId);
      if (!session || session.harnessSessionId !== harnessSessionId) {
        session = { harnessSessionId, tools: new Set() };
        sessions.set(agentId, session);
      }
      const current = () => sessions.get(agentId) === session;
      return {
        has: (toolName) => current() && session.tools.has(toolName),
        add(toolName) { if (current()) session.tools.add(toolName); },
      };
    },
  };
}

export function validateApprovalScope(scope = 'once', decision = 'approve') {
  if (!['once', 'session'].includes(scope) || (decision !== 'approve' && scope !== 'once')) {
    throw Object.assign(new Error('scope must be once or session (session requires approve)'), { statusCode: 400 });
  }
  return scope;
}
