// The daemon's status as callers outside the host see it (#645 step 3b):
// whether it runs, what its health probe reports, and agent-comms status.
// Moved out of the agent-daemon process host so soul modules can ask
// without importing it; agent-daemon.mjs re-exports daemonStatus.

import { homedir } from 'node:os';
import process from 'node:process';

import { readCommsStatus } from './comms-client.mjs';
import {
  daemonBaseUrl as baseUrl, daemonStateFile, HEALTH_TIMEOUT_MS, probeDaemonHealth as probeHealth, readDaemonState as readStateFile,
} from './daemon-client.mjs';

export async function daemonStatus({
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const file = daemonStateFile({ env, home });
  let state;
  try {
    state = readStateFile(file);
  } catch (error) {
    return { running: false, computerUse: [], reason: error.message, comms: readCommsStatus({ env, home }) };
  }
  if (!state) return { running: false, computerUse: [], reason: 'no daemon state file', comms: readCommsStatus({ env, home }) };
  const health = await probeHealth(state, { fetchImpl, timeoutMs });
  if (health) {
    return {
      running: true,
      pid: state.pid,
      port: state.port,
      startedAt: state.startedAt,
      warmPool: health.warmPool ?? {},
      busy: Array.isArray(health.busy) ? health.busy : [],
      souls: Array.isArray(health.souls) ? health.souls : [],
      computerUse: Array.isArray(health.computerUse) ? health.computerUse : [],
      comms: await probeComms(state, { env, home, fetchImpl, timeoutMs }),
    };
  }
  return {
    running: false,
    computerUse: [],
    reason: 'daemon state file is stale (health probe failed)',
    stale: state,
    comms: readCommsStatus({ env, home }),
  };
}

async function probeComms(state, { env, home, fetchImpl, timeoutMs }) {
  try {
    const res = await fetchImpl(`${baseUrl(state)}/v0/comms/status`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return readCommsStatus({ env, home });
    const body = await res.json().catch(() => ({}));
    if (!body || typeof body.comms !== 'object') return readCommsStatus({ env, home });
    return body.comms;
  } catch {
    return readCommsStatus({ env, home });
  }
}
