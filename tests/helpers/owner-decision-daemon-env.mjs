// Runs `run` as a daemon launched with this env and home: the owner-decision
// trust store is always the daemon's own, resolved from process.env and the
// home directory, so tests set them (XDG_STATE_HOME and HOME) for the call
// and restore them after.
import process from 'node:process';

export function asDaemon({ env, home }, run) {
  const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, HOME: process.env.HOME };
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME; process.env.HOME = home;
  try { return run(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
