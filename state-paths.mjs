// Where agent-bot keeps per-account state. Pure path resolution with no
// imports from other modules, so every module can name a state root without
// crossing into the module that writes it (#645).
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Agent identities, bindings and records (agent-identity.mjs).
export function stateDirectory({ env = process.env, home = homedir() } = {}) {
  // AGENT_BOT_STATE_HOME is the standalone name; QWTS_AGENT_STATE_HOME remains
  // accepted so playbook-engineering launchers keep working against this clone.
  const override = env.AGENT_BOT_STATE_HOME ?? env.QWTS_AGENT_STATE_HOME;
  if (override) return path.resolve(override);
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'agent-identities');
}

// Operational interaction state (sessions, jobs, events, audit) lives in one
// home so retention, backup, and inspection have a single root.
export function interactionHome({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_INTERACTION_HOME) return path.resolve(env.AGENT_BOT_INTERACTION_HOME);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'interaction');
}
