// Shared root for CLI and desktop hosts (ADR-0332 decision 5).
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, soulsRootSetting } from './config.mjs';

export function soulsHome({ env = process.env, home = homedir(), config } = {}) {
  if (env.AGENT_BOT_SOULS_HOME) return { root: path.resolve(env.AGENT_BOT_SOULS_HOME), source: 'environment' };
  const configured = soulsRootSetting(config === undefined ? loadConfig({ env, home }) : config);
  if (configured) return { root: path.resolve(configured), source: 'setting' };
  return { root: path.join(home, '.agent-bot', 'souls'), source: 'default' };
}
