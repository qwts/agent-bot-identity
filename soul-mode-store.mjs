// The soul mode settings file, its readers and the bounded settings-file
// reader, with nothing that changes them (#1384). The census reads every
// soul's mode through this module, so it never loads the owner gate that
// `soul mode` changes go through; that gate import is what tied soul's census
// into identity's credential cycle (C1). soul-mode.mjs re-exports all of it.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { validateAgentId } from './identity-format.mjs';

export const SOUL_MODES = Object.freeze(['safe', 'autopilot']);

export function soulModeFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'soul-modes.json');
}

export function readSoulModes(options = {}) {
  try {
    const settings = JSON.parse(readFileSync(soulModeFile(options), 'utf8'))?.settings ?? {};
    if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid settings');
    for (const [id, mode] of Object.entries(settings)) {
      validateAgentId(id);
      if (!SOUL_MODES.includes(mode)) throw new Error('invalid mode');
    }
    return settings;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('soul mode settings could not be read');
  }
}

export function soulMode(agentId, options = {}) {
  return readSoulModes(options)[validateAgentId(agentId)] ?? 'safe';
}

// The repo may be an untrusted clone: only a small regular file is read, never
// a symlink (a link to /dev/zero would stall the daemon). The file is opened
// once without following a link or blocking, and checked and read through
// that descriptor, so it cannot be swapped between the check and the read.
const SETTINGS_FILE_MAX = 64 * 1024;
export const readSettingsText = (file) => {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= SETTINGS_FILE_MAX ? readFileSync(fd, 'utf8') : null;
  } catch { return null; } finally { closeSync(fd); }
};
