import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAgentId } from './agent-identity.mjs';
import { duplicateSoulDirs, locateSoulDir, soulDirectory } from './agent-population.mjs';
import { soulsHome } from './souls-root.mjs';

const USAGE = 'usage: agent-bot soul dir AGENT_ID | soul locate PATH';

export function soulDirInfo(agentId, options = {}) {
  const id = validateAgentId(agentId);
  const { root, source } = soulsHome(options);
  const soulDir = soulDirectory(id, options);
  // Copies of this soul's folder are reported, never used (#80).
  const copies = duplicateSoulDirs(options).find((entry) => entry.agentId === id)?.copies ?? [];
  return { agentId: id, soulDir, home: path.join(soulDir, '.soul-state', 'home'), soulsRoot: root, source, copies };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [first, second, ...rest] = process.argv.slice(2);
    if (first === 'locate') {
      if (!second || rest.length) throw new Error(USAGE);
      process.stdout.write(`${JSON.stringify(locateSoulDir(second))}\n`);
    } else {
      if (!first || second !== undefined) throw new Error(USAGE);
      process.stdout.write(`${JSON.stringify(soulDirInfo(first))}\n`);
    }
  } catch (error) {
    process.stderr.write(`soul ${process.argv[2] === 'locate' ? 'locate' : 'dir'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
