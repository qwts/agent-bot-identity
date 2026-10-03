import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAgentId } from './agent-identity.mjs';
import { soulDirectory } from './agent-population.mjs';
import { soulsHome } from './souls-root.mjs';

export function soulDirInfo(agentId, options = {}) {
  const id = validateAgentId(agentId);
  const { root, source } = soulsHome(options);
  const soulDir = soulDirectory(id, options);
  return { agentId: id, soulDir, home: path.join(soulDir, '.soul-state', 'home'), soulsRoot: root, source };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: agent-bot soul dir AGENT_ID');
    process.stdout.write(`${JSON.stringify(soulDirInfo(process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`soul dir: ${error.message}\n`);
    process.exitCode = 1;
  }
}
