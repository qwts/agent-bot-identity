import path from 'node:path';
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateAgentId } from './agent-identity.mjs';
import { duplicateSoulDirs, locateSoulDir, soulDirectory } from './agent-population.mjs';
import { soulsHome } from './souls-root.mjs';

const USAGE = 'usage: agent-bot soul dir AGENT_ID | soul locate PATH [--json]';

// Host prefill belongs to the locate CLI; directory ownership stays in the census.
// Keep the existing untrusted-manifest bounds and refuse links/devices/FIFOs.
export function locateSoulInfo(directory, options = {}) {
  const located = locateSoulDir(directory, options);
  const fields = { name: null, description: null, preferredHarnesses: [], template: null };
  if (!['package', 'installed', 'copy'].includes(located.status)) return { ...located, ...fields };
  let fd;
  try {
    fd = openSync(path.join(located.path, 'soul.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return { ...located, ...fields };
    const manifest = JSON.parse(readFileSync(fd, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ...located, ...fields };
    const text = (value, max) => typeof value === 'string' && value.trim()
      && value.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(value.trim()) ? value.trim() : null;
    fields.name = text(manifest.name, 128);
    fields.description = text(manifest.description, 512);
    if (Array.isArray(manifest.preferredHarnesses)) {
      fields.preferredHarnesses = [...new Set(manifest.preferredHarnesses.slice(0, 8).map((h) => text(h, 64)).filter(Boolean))];
    }
    fields.template = manifest.template === undefined ? false
      : typeof manifest.template === 'boolean' ? manifest.template : null;
  } catch { /* Missing or invalid manifests must never prevent locating a folder. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return { ...located, ...fields };
}

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
      if (!second || (rest.length && (rest.length !== 1 || rest[0] !== '--json'))) throw new Error(USAGE);
      process.stdout.write(`${JSON.stringify(locateSoulInfo(second))}\n`);
    } else {
      if (!first || second !== undefined) throw new Error(USAGE);
      process.stdout.write(`${JSON.stringify(soulDirInfo(first))}\n`);
    }
  } catch (error) {
    process.stderr.write(`soul ${process.argv[2] === 'locate' ? 'locate' : 'dir'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
