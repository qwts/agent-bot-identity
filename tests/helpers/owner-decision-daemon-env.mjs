// Runs `run` as a daemon launched with this env and home: the owner-decision
// trust store is always the daemon's own, resolved from process.env and the
// home directory, so tests set them (XDG_STATE_HOME and HOME) for the call
// and restore them after.
import process from 'node:process';

// The state-directory overrides are cleared for the call, so the daemon's
// state directory also resolves under this XDG_STATE_HOME.
export function asDaemon({ env, home }, run) {
  const keys = ['XDG_STATE_HOME', 'HOME', 'AGENT_BOT_STATE_HOME', 'QWTS_AGENT_STATE_HOME'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.AGENT_BOT_STATE_HOME; delete process.env.QWTS_AGENT_STATE_HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME; process.env.HOME = home;
  try { return run(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
