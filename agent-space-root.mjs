// Where Agent Spaces live by default: the spaces root and a soul's path
// under it (#1386). agent-space.mjs and soul-space-path.mjs both need this,
// so it sits below both of them, which keeps agent-space.mjs and
// soul-memory.mjs out of an import cycle (HQ plan §2.4, C2). agent-space.mjs
// re-exports every name here.
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { validateAgentId } from './identity-format.mjs';
import { loadConfig, spacesRootSetting } from './config.mjs';

export function resolveSpacesHome({ env = process.env, home = homedir(), config } = {}) {
  if (env.AGENT_BOT_SPACES_HOME) {
    return { root: path.resolve(env.AGENT_BOT_SPACES_HOME), source: 'environment' };
  }
  const loaded = config === undefined ? loadConfig({ home, env }) : config;
  const configured = spacesRootSetting(loaded);
  if (configured) return { root: path.resolve(configured), source: 'setting' };
  return { root: path.join(home, '.agent-space'), source: 'default' };
}

export function spacesHome(options = {}) {
  return resolveSpacesHome(options).root;
}

export function spacePath(agentId, options = {}) {
  return path.join(spacesHome(options), validateAgentId(agentId));
}
