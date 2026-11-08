// Where a soul's Agent Space is (#1386). agent-space.mjs's command line and
// soul-memory.mjs both resolve a soul's space this way, so it sits below both
// of them, which keeps them out of an import cycle (HQ plan §2.4, C2).
// soul-memory.mjs re-exports it.
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { validateAgentId } from './identity-format.mjs';
import { populationFile, showSoul } from './agent-population.mjs';
import { spacePath } from './agent-space-root.mjs';

/**
 * Where a soul's Agent Space is: the census `spacePath` when the census
 * knows the soul (authoritative, decision 8), else the spaces root path
 * `initAgentSpace` would use. Never creates anything.
 */
export function soulSpacePath(agentId, { env = process.env, home = env.HOME ?? homedir(), ...rest } = {}) {
  const id = validateAgentId(agentId);
  const file = rest.file ?? populationFile({ env, home });
  try {
    const recorded = showSoul(id, { file }).spacePath;
    if (typeof recorded === 'string' && path.isAbsolute(recorded)) return recorded;
  } catch { /* unknown to the census: the default root */ }
  return spacePath(id, { env, home, ...rest });
}
