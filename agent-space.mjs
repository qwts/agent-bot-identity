#!/usr/bin/env node

// Durable per-soul storage keyed by a transcript-bound Agent ID. Agent Spaces
// live under XDG data, outside bot territory, and survive worktree teardown,
// context compaction, and identity finalization.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { currentAgentId, validateAgentId } from './agent-identity.mjs';

const SCHEMA_VERSION = 1;
const MARKER_NAME = 'space.json';

export function spacesHome({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_SPACES_HOME) return path.resolve(env.AGENT_BOT_SPACES_HOME);
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
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error('space marker has an invalid createdAt');
  }
  // Return only the public schema. A hand-edited marker must not smuggle
  // arbitrary or secret material into `space show` or doctor output.
  return { schemaVersion: SCHEMA_VERSION, agentId, createdAt: record.createdAt };
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
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const id = validateAgentId(agentId);
  const spacesRoot = spacesHome({ env, home });
  const root = spacePath(id, { env, home });
  ensurePrivateDirectory(spacesRoot);

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
  { env = process.env, home = homedir() } = {},
) {
  const id = validateAgentId(agentId);
  const root = spacePath(id, { env, home });
  if (!existsSync(markerPath(root))) {
    return { status: 'missing', id, path: root, directoryPresent: existsSync(root) };
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

function parseCli(argv) {
  const [command = 'path', ...tokens] = argv.slice(2);
  const positional = [];
  let json = false;
  for (const token of tokens) {
    if (token === '--json') json = true;
    else if (token.startsWith('-')) throw new Error(`unknown option: ${token}`);
    else positional.push(token);
  }
  if (positional.length > 1) throw new Error(`${command} accepts at most one Agent ID`);
  return { command, agentId: positional[0] ?? null, json };
}

function resolveTargetId(args) {
  if (args.agentId) return validateAgentId(args.agentId);
  const current = currentAgentId();
  if (!current) throw new Error('no Agent ID in this context; pass agent_<uuid> explicitly');
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
    default:
      throw new Error('usage: agent-bot space <init|path|show> [agent-id] [--json]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-space: ${error.message}\n`);
    process.exit(1);
  });
}
