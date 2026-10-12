// Runs `run` as a daemon launched with this env and home: the owner-decision
// trust store is always the daemon's own, resolved from process.env and the
// home directory, so tests set them (XDG_STATE_HOME and HOME) for the call
// and restore them after.
import process from 'node:process';

// The path overrides are cleared for the call, so the daemon's state
// directory, census and comms pairing also resolve under this
// XDG_STATE_HOME. With `now` (milliseconds), Date.now answers it for the call.
const OVERRIDES = ['AGENT_BOT_STATE_HOME', 'QWTS_AGENT_STATE_HOME', 'AGENT_BOT_POPULATION_PATH', 'AGENT_BOT_COMMS_DAEMON_PATH'];
export function asDaemon({ env, home, now }, run) {
  const keys = ['XDG_STATE_HOME', 'HOME', ...OVERRIDES];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of OVERRIDES) delete process.env[key];
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME; process.env.HOME = home;
  const realNow = Date.now;
  if (now !== undefined) Date.now = () => now;
  try { return run(); } finally {
    Date.now = realNow;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

// The same for an async `run`: the daemon's env and clock hold until its
// promise settles.
export async function asDaemonAsync({ env, home, now }, run) {
  const keys = ['XDG_STATE_HOME', 'HOME', ...OVERRIDES];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of OVERRIDES) delete process.env[key];
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME; process.env.HOME = home;
  const realNow = Date.now;
  if (now !== undefined) Date.now = () => now;
  try { return await run(); } finally {
    Date.now = realNow;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
