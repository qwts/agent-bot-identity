#!/usr/bin/env node

// Durable per-soul storage keyed by a transcript-bound Agent ID. Agent Spaces
// live under ~/.agent-space, outside bot territory, and survive worktree
// teardown, context compaction, and identity finalization.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { currentAgentId, validateAgentId, withLock } from './agent-identity.mjs';
import {
  buildSpacePack,
  downloadPackFromGist,
  gistHandoffPointer,
  packFileName,
  parseGistReference,
  parsePack,
  serializePack,
  uploadPackToGist,
} from './agent-space-pack.mjs';
import { loadConfig, spacesRootSetting } from './config.mjs';
import { territoryHarness } from './resolve-agent.mjs';

const SCHEMA_VERSION = 1;
const MARKER_NAME = 'space.json';
// Optional suitcase-handoff pointer recorded after a gist export. Pointer
// only — never pack contents, never credentials.
const HANDOFF_PATTERN = /^gist:[A-Za-z0-9]{1,64}$/;

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

// Names the pre-amendment ENG-0172 tree for the one-time cutover only.
// XDG_DATA_HOME is not a resolution input.
export function legacySpacesHome({ env = process.env, home = homedir() } = {}) {
  const dataHome = env.XDG_DATA_HOME
    ? path.resolve(env.XDG_DATA_HOME)
    : path.join(home, '.local', 'share');
  return path.join(dataHome, 'agent-bot', 'spaces');
}

export function spacePath(agentId, options = {}) {
  return path.join(spacesHome(options), validateAgentId(agentId));
}

function markerPath(root) {
  return path.join(root, MARKER_NAME);
}

function readMarker(root) {
  let raw;
  try {
    raw = readFileSync(markerPath(root), 'utf8');
  } catch {
    throw new Error('space marker could not be read');
  }
  return parseMarkerText(raw);
}

function parseMarkerText(raw) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    // JSON parser messages may quote input. Never reflect marker contents.
    throw new Error('space marker is not valid JSON');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('space marker must be an object');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('space marker has an unsupported schemaVersion');
  }
  let agentId;
  try {
    agentId = validateAgentId(record.agentId);
  } catch {
    throw new Error('space marker has an invalid Agent ID');
  }
  let createdAt;
  try {
    createdAt = new Date(record.createdAt).toISOString();
  } catch {
    throw new Error('space marker has an invalid createdAt');
  }
  if (createdAt !== record.createdAt) throw new Error('space marker has an invalid createdAt');
  let handoff = null;
  if (record.handoff !== undefined && record.handoff !== null) {
    if (typeof record.handoff !== 'string' || !HANDOFF_PATTERN.test(record.handoff)) {
      throw new Error('space marker has an invalid handoff pointer');
    }
    handoff = record.handoff;
  }
  // Return only the public schema. A hand-edited marker must not smuggle
  // arbitrary or secret material into `space show` or doctor output.
  return {
    schemaVersion: SCHEMA_VERSION,
    agentId,
    createdAt,
    ...(handoff ? { handoff } : {}),
  };
}

function ensurePrivateDirectory(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* POSIX modes are best-effort on other platforms. */
  }
}

function writeMarker(root, marker) {
  const target = markerPath(root);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function initAgentSpace(
  agentId,
  { env = process.env, home = homedir(), config, now = () => new Date() } = {},
) {
  const id = validateAgentId(agentId);
  const spacesRoot = spacesHome({ env, home, config });
  const root = path.join(spacesRoot, id);
  ensurePrivateDirectory(spacesRoot);

  return withLock(path.join(spacesRoot, `.${id}.lock`), `Agent Space ${id}`, () => {
    if (existsSync(markerPath(root))) {
      const marker = readMarker(root);
      if (marker.agentId !== id) {
        throw new Error(`agent space at ${root} is bound to ${marker.agentId}, not ${id}`);
      }
      return { id, path: root, created: false, marker };
    }
    if (existsSync(root)) {
      throw new Error(
        `agent space path ${root} already exists without ${MARKER_NAME}; refusing to claim it`,
      );
    }

    ensurePrivateDirectory(root);
    const marker = {
      schemaVersion: SCHEMA_VERSION,
      agentId: id,
      createdAt: now().toISOString(),
    };
    writeMarker(root, marker);
    return { id, path: root, created: true, marker };
  });
}

export function showAgentSpace(agentId, options = {}) {
  const id = validateAgentId(agentId);
  const root = spacePath(id, options);
  if (!existsSync(markerPath(root))) throw new Error(`no agent space for ${id} at ${root}`);
  const marker = readMarker(root);
  if (marker.agentId !== id) {
    throw new Error(`agent space at ${root} is bound to ${marker.agentId}, not ${id}`);
  }
  return { id, path: root, marker };
}

// Read-only diagnosis for doctor. It intentionally suppresses parse errors and
// arbitrary marker fields because either may contain secret material.
export function inspectAgentSpace(
  agentId,
  { env = process.env, home = homedir(), config } = {},
) {
  const id = validateAgentId(agentId);
  const root = spacePath(id, { env, home, config });
  if (!existsSync(markerPath(root))) {
    let directoryPresent = false;
    try {
      directoryPresent = statSync(root).isDirectory();
    } catch {
      /* A missing, unreadable, or non-directory path is not an unmarked directory. */
    }
    return { status: 'missing', id, path: root, directoryPresent };
  }
  let marker;
  try {
    marker = readMarker(root);
  } catch {
    return { status: 'invalid', id, path: root };
  }
  if (marker.agentId !== id) {
    return { status: 'mismatch', id, path: root, boundTo: marker.agentId };
  }
  return { status: 'ok', id, path: root };
}

// Record the optional gist handoff pointer in the space marker. Pointer only:
// the marker never carries pack contents or credentials.
export function recordSpaceHandoff(
  agentId,
  handoff,
  { env = process.env, home = homedir(), config } = {},
) {
  const id = validateAgentId(agentId);
  if (typeof handoff !== 'string' || !HANDOFF_PATTERN.test(handoff)) {
    throw new Error('handoff pointer must look like gist:<id>');
  }
  const spacesRoot = spacesHome({ env, home, config });
  const root = path.join(spacesRoot, id);
  return withLock(path.join(spacesRoot, `.${id}.lock`), `Agent Space ${id}`, () => {
    if (!existsSync(markerPath(root))) throw new Error(`no agent space for ${id} at ${root}`);
    const marker = readMarker(root);
    if (marker.agentId !== id) {
      throw new Error(`agent space at ${root} is bound to ${marker.agentId}, not ${id}`);
    }
    const next = { ...marker, handoff };
    writeMarker(root, next);
    return next;
  });
}

// Restore a validated pack into the spaces root. The pack's own marker is
// validated before anything touches disk, files are staged into a private
// sibling directory, and the staged tree replaces the space atomically —
// never a half-restored space, and never clobbering without --force.
export function importAgentSpacePack(
  pack,
  {
    force = false,
    env = process.env,
    home = homedir(),
    config,
    // Injection seam for tests only: proving the backup/restore path needs a
    // rename that fails on demand, which the filesystem cannot simulate.
    rename = renameSync,
  } = {},
) {
  const id = validateAgentId(pack.agentId);
  const markerEntry = pack.entries.find((entry) => entry.path === MARKER_NAME);
  if (!markerEntry) throw new Error(`pack does not contain a ${MARKER_NAME} space marker`);
  const marker = parseMarkerText(Buffer.from(markerEntry.data, 'base64').toString('utf8'));
  if (marker.agentId !== id) {
    throw new Error(`pack marker is bound to ${marker.agentId}, not ${id}`);
  }
  const spacesRoot = spacesHome({ env, home, config });
  ensurePrivateDirectory(spacesRoot);
  return withLock(path.join(spacesRoot, `.${id}.lock`), `Agent Space ${id}`, () => {
    const root = path.join(spacesRoot, id);
    if (existsSync(root) && !force) {
      throw new Error(`agent space for ${id} already exists at ${root}; pass --force to replace it`);
    }
    const staging = `${root}.${process.pid}.${randomUUID()}.import`;
    try {
      ensurePrivateDirectory(staging);
      for (const entry of pack.entries) {
        const target = path.join(staging, entry.path);
        mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, Buffer.from(entry.data, 'base64'), {
          flag: 'wx',
          mode: 0o600,
        });
      }
      const staged = readMarker(staging);
      if (staged.agentId !== id) {
        throw new Error(`pack marker is bound to ${staged.agentId}, not ${id}`);
      }
      // Replacement must be recoverable: never delete the existing space
      // before its successor is in place. Move it aside on the same
      // filesystem, promote the staged tree, and only then discard the
      // backup — a failure between the renames restores the original.
      const backup = `${root}.${process.pid}.${randomUUID()}.replaced`;
      let backedUp = false;
      if (existsSync(root)) {
        rename(root, backup);
        backedUp = true;
      }
      try {
        rename(staging, root);
      } catch (error) {
        if (backedUp) {
          try {
            rename(backup, root);
          } catch {
            throw new Error(
              `import failed and the original space could not be restored automatically; ` +
                `it is preserved at ${backup}: ${error.message}`,
            );
          }
        }
        throw error;
      }
      if (backedUp) rmSync(backup, { recursive: true, force: true });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return { id, path: root, marker, entries: pack.entries.length };
  });
}

// Remove a retired soul's space directory. Explicit destruction only: the
// marker must exist and bind to the id, or nothing is deleted.
export function deleteAgentSpace(
  agentId,
  { env = process.env, home = homedir(), config } = {},
) {
  const id = validateAgentId(agentId);
  const spacesRoot = spacesHome({ env, home, config });
  const root = path.join(spacesRoot, id);
  return withLock(path.join(spacesRoot, `.${id}.lock`), `Agent Space ${id}`, () => {
    if (!existsSync(markerPath(root))) {
      throw new Error(`refusing to delete ${root}: it is not a marked agent space for ${id}`);
    }
    const marker = readMarker(root);
    if (marker.agentId !== id) {
      throw new Error(`agent space at ${root} is bound to ${marker.agentId}, not ${id}`);
    }
    rmSync(root, { recursive: true, force: true });
    return { id, path: root };
  });
}

const COMMAND_FLAGS = new Map([
  ['init', ['json']],
  ['ensure', ['json']],
  ['path', ['json']],
  ['show', ['json']],
  ['export', ['json', 'gist', 'out']],
  ['import', ['json', 'force']],
  ['retire', ['json', 'delete-space']],
]);

function parseCli(argv) {
  const [command = 'path', ...tokens] = argv.slice(2);
  const allowed = COMMAND_FLAGS.get(command) ?? ['json'];
  const positional = [];
  const options = { json: false, gist: false, force: false, deleteSpace: false, out: null };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const name = token.startsWith('--') ? token.slice(2) : null;
    if (!name || !allowed.includes(name)) throw new Error(`unknown option: ${token}`);
    if (name === 'out') {
      const value = tokens[++index];
      if (!value || value.startsWith('-')) throw new Error('--out requires a path');
      options.out = value;
    } else if (name === 'json') {
      options.json = true;
    } else if (name === 'gist') {
      options.gist = true;
    } else if (name === 'force') {
      options.force = true;
    } else {
      options.deleteSpace = true;
    }
  }
  if (command === 'ensure' && positional.length > 0) {
    throw new Error('space ensure does not accept an Agent ID; it resolves the current context');
  }
  if (command === 'import') {
    if (positional.length !== 1) {
      throw new Error('space import requires exactly one pack path or gist reference');
    }
    return { command, source: positional[0], agentId: null, ...options };
  }
  if (command === 'retire' && positional.length !== 1) {
    throw new Error('space retire requires exactly one Agent ID');
  }
  if (positional.length > 1) throw new Error(`${command} accepts at most one Agent ID`);
  if (options.gist && options.out) throw new Error('choose --gist or --out, not both');
  return { command, agentId: positional[0] ?? null, source: null, ...options };
}

function resolveTargetId(args) {
  if (args.agentId) {
    try {
      return validateAgentId(args.agentId);
    } catch {
      throw new Error('invalid Agent ID in this context');
    }
  }
  let current;
  try {
    current = currentAgentId();
  } catch {
    throw new Error('invalid Agent ID in this context');
  }
  if (!current) throw new Error('no Agent ID in this context; pass agent_<uuid> explicitly');
  return current;
}

function resolveEnsureId() {
  if (!territoryHarness(process.cwd())) {
    throw new Error('space ensure requires bot territory; refusing to create from a human primary checkout');
  }
  let current;
  try {
    current = currentAgentId();
  } catch {
    throw new Error('invalid Agent ID in this context');
  }
  if (!current) throw new Error('no Agent ID in this context');
  return current;
}

function spaceJson(space, { includeCreated = false } = {}) {
  return {
    agentId: space.id,
    path: space.path,
    ...(includeCreated ? { created: space.created } : {}),
    ...space.marker,
  };
}

async function main() {
  const args = parseCli(process.argv);
  switch (args.command) {
    case 'init': {
      const id = resolveTargetId(args);
      const space = initAgentSpace(id);
      if (args.json) process.stdout.write(`${JSON.stringify(spaceJson(space, { includeCreated: true }), null, 2)}\n`);
      else process.stdout.write(`${space.path}\n`);
      break;
    }
    case 'ensure': {
      const space = initAgentSpace(resolveEnsureId());
      if (args.json) {
        process.stdout.write(`${JSON.stringify(spaceJson(space, { includeCreated: true }), null, 2)}\n`);
      } else {
        process.stderr.write(`agent-space: ${space.created ? 'created' : 'ready'} for ${space.id}\n`);
        process.stdout.write(`${space.path}\n`);
      }
      break;
    }
    case 'path': {
      const id = resolveTargetId(args);
      const root = spacePath(id);
      if (args.json) process.stdout.write(`${JSON.stringify({ agentId: id, path: root }, null, 2)}\n`);
      else process.stdout.write(`${root}\n`);
      break;
    }
    case 'show': {
      const id = resolveTargetId(args);
      const space = showAgentSpace(id);
      process.stdout.write(`${JSON.stringify(spaceJson(space), null, 2)}\n`);
      break;
    }
    case 'export': {
      const id = resolveTargetId(args);
      const space = showAgentSpace(id);
      const { pack, excluded } = buildSpacePack(space.path, id);
      for (const relative of excluded) {
        process.stderr.write(`agent-space: excluded regenerable cache file ${relative}\n`);
      }
      if (args.gist) {
        const gist = await uploadPackToGist(pack);
        const handoff = gistHandoffPointer(gist.id);
        recordSpaceHandoff(id, handoff);
        if (args.json) {
          process.stdout.write(`${JSON.stringify({
            agentId: id,
            handoff,
            url: gist.url,
            contentHash: pack.contentHash,
            entries: pack.entries.length,
            excluded,
          }, null, 2)}\n`);
        } else {
          process.stderr.write(`agent-space: uploaded secret-free pack for ${id}\n`);
          process.stdout.write(`${handoff}\n`);
        }
        break;
      }
      const out = path.resolve(args.out ?? packFileName(id));
      try {
        writeFileSync(out, serializePack(pack), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error(`output pack already exists at ${out}; choose another --out path`);
        }
        throw error;
      }
      if (args.json) {
        process.stdout.write(`${JSON.stringify({
          agentId: id,
          out,
          contentHash: pack.contentHash,
          entries: pack.entries.length,
          excluded,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`${out}\n`);
      }
      break;
    }
    case 'import': {
      const gistId = args.source.startsWith('gist:') || /^https?:\/\//.test(args.source)
        ? parseGistReference(args.source)
        : null;
      let pack;
      if (gistId) {
        pack = await downloadPackFromGist(gistId);
      } else {
        let raw;
        try {
          raw = readFileSync(args.source, 'utf8');
        } catch (error) {
          throw new Error(`could not read pack at ${args.source} (${error.code ?? 'unreadable'})`);
        }
        pack = parsePack(raw);
      }
      const restored = importAgentSpacePack(pack, { force: args.force });
      if (args.json) {
        process.stdout.write(`${JSON.stringify({
          agentId: restored.id,
          path: restored.path,
          entries: restored.entries,
          restored: true,
        }, null, 2)}\n`);
      } else {
        process.stderr.write(`agent-space: restored ${restored.id}\n`);
        process.stdout.write(`${restored.path}\n`);
      }
      break;
    }
    case 'retire': {
      // Retirement is an explicit operator command (issue #46). Nothing in
      // setup-worktree or identity finalize may reach this path: finalize
      // seals provenance, it must never delete a soul's drive.
      let id;
      try {
        id = validateAgentId(args.agentId);
      } catch {
        throw new Error('invalid Agent ID in this context');
      }
      // Loaded on demand like identity finalize: the census is only needed
      // for lifecycle commands, and it fails closed on unknown ids.
      const { retireIdentityWithPopulation, showSoul } = await import('./agent-population.mjs');
      showSoul(id); // throws "no population record for <id>" — fail closed
      const root = spacePath(id);
      let deletable = false;
      if (args.deleteSpace) {
        const inspection = inspectAgentSpace(id);
        if (inspection.status === 'ok') {
          deletable = true;
        } else if (!(inspection.status === 'missing' && !inspection.directoryPresent)) {
          throw new Error(
            `refusing to delete ${root}: it is not a valid agent space for ${id}; resolve it manually`,
          );
        }
      }
      // Retire both stores under the lifecycle lock: the identity record is
      // the authority reuse paths consult, so marking it retired is what
      // keeps a stale worktree pin from resurrecting the soul via setup.
      const { soul: updated } = retireIdentityWithPopulation(id);
      if (!updated) throw new Error(`no population record for ${id}`);
      let spaceDeleted = false;
      if (deletable) {
        deleteAgentSpace(id);
        spaceDeleted = true;
      }
      if (args.json) {
        process.stdout.write(`${JSON.stringify({
          agentId: id,
          status: updated.status,
          spacePath: root,
          spaceDeleted,
        }, null, 2)}\n`);
      } else {
        const disposition = spaceDeleted ? 'space deleted' : `space kept at ${root}`;
        process.stdout.write(`retired ${id} (${disposition})\n`);
      }
      break;
    }
    default:
      throw new Error(
        'usage: agent-bot space <init|path|show> [agent-id] [--json]\n' +
          '       agent-bot space ensure [--json]\n' +
          '       agent-bot space export [agent-id] [--out <path>] [--gist] [--json]\n' +
          '       agent-bot space import <pack|gist:id|gist-url> [--force] [--json]\n' +
          '       agent-bot space retire <agent-id> [--delete-space] [--json]',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-space: ${error.message}\n`);
    process.exit(1);
  });
}
