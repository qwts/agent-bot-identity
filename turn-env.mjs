// A soul's turn environment (#536, #583): the one composition the daemon's
// executor, the launch's sign-in probe and `agent-bot harness auth --soul`
// share, so each reads the store the harness turn actually uses. Soul
// lifecycle; wake-plane.mjs re-exports it for the daemon host.

import { NEVER_ROUTED } from './soul-tool-homes.mjs';

const TOOL_HOME_FAILURES = Object.freeze(['tool-home-unwritable', 'tool-home-record-invalid']);

// The environment a soul's harness turn runs with, composed once so the
// executor and anything that must see the same store (the launch's
// sign-in probe, #536) cannot drift: `{ turnEnv, mcpEnv, harnessEnv,
// routed, stripped }`.
export function composeTurnEnv({ agentId, harness, env = {}, baseEnv = {}, runtimeEnvFor = null, toolHomeEnvFor = null, providerEnvFor = null }) {
  const turnEnv = { ...baseEnv, ...env, QWTS_AGENT_ID: agentId, AGENT_BOT_ID: agentId };
  // The soul's own runtimes and harness installs first on PATH, with
  // their env (GOROOT, UV_*), never HOME (#583 slice 3). A soul with no
  // folder yet runs with the host's PATH as before.
  // A failed lookup cannot establish that host tools satisfy the soul's
  // declarations. Refuse before creating or resuming a harness.
  if (runtimeEnvFor) Object.assign(turnEnv, runtimeEnvFor({ agentId, harness, env: turnEnv }) ?? {});
  // The harness's native state in the soul's tool home (#583 slice 2),
  // harness-specific variables only: HOME and XDG_STATE_HOME are dropped
  // whatever the port says. A soul with no folder (a lookup that fails
  // without a code) runs on the host store as before; a tool home that
  // cannot be made, or a tool-homes record that cannot be read (#617), is a
  // coded failure of the turn, never a silent fallback.
  const routed = [];
  if (toolHomeEnvFor) {
    let patch = {};
    try { patch = toolHomeEnvFor({ agentId, harness }) ?? {}; } catch (error) { if (TOOL_HOME_FAILURES.includes(error?.code)) throw error; }
    for (const [name, value] of Object.entries(patch)) {
      if (NEVER_ROUTED.includes(name) || typeof value !== 'string') continue;
      turnEnv[name] = value;
      routed.push(name);
    }
  }
  // The provider secret (#583 slice 4) goes to the launched harness and
  // nowhere else: `mcpEnv` is the turn env without it, for the reach
  // server and keyd's relay. A secret the store cannot give fails the
  // turn here (coded `provider-secret-missing`), never silently.
  const provided = providerEnvFor ? providerEnvFor({ agentId, harness }) ?? {} : {};
  const stripped = provided.envKey ? [provided.envKey] : [];
  const mcpEnv = { ...turnEnv };
  for (const name of stripped) delete mcpEnv[name];
  const harnessEnv = { ...turnEnv, ...(provided.env ?? {}) };
  return { turnEnv, mcpEnv, harnessEnv, routed, stripped };
}
