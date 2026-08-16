// One-time Agent Space root cutover (#105 / ENG-0172 amendment).
//
// install/update/bootstrap are the only movers. When no override is set, the
// legacy XDG tree holds soul directories, and ~/.agent-space holds none, this
// module copies those spaces, rewrites census spacePath values, then records
// completion. A partial move is a failure: the legacy tree stays authoritative
// and an in-progress marker keeps a partial destination from counting as
// populated. Doctor never calls this module to move.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import { isAgentId } from './agent-identity.mjs';
import { populationFile, relocateSoulSpaces } from './agent-population.mjs';
import {
  inspectAgentSpace,
  legacySpacesHome,
  resolveSpacesHome,
} from './agent-space.mjs';

const SCHEMA_VERSION = 1;
const RECORD_NAME = 'spaces-cutover.json';
const IN_PROGRESS_NAME = 'spaces-cutover.in-progress';

export function cutoverStatePaths({ env = process.env, home = homedir() } = {}) {
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  const directory = path.join(stateHome, 'agent-bot');
  return {
    directory,
    recordPath: path.join(directory, RECORD_NAME),
    inProgressPath: path.join(directory, IN_PROGRESS_NAME),
  };
}

export function defaultSpacesHome({ home = homedir() } = {}) {
  return path.join(home, '.agent-space');
}

function soulDirectories(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && isAgentId(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function rootHoldsSpaces(root) {
  return soulDirectories(root).length > 0;
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function readCompletedRecord(recordPath) {
  let raw;
  try {
    raw = readFileSync(recordPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Agent Space cutover record could not be read');
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error('Agent Space cutover record is not valid JSON');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Agent Space cutover record must be an object');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Agent Space cutover record has an unsupported schemaVersion');
  }
  if (
    typeof record.from !== 'string'
    || typeof record.to !== 'string'
    || !path.isAbsolute(record.from)
    || !path.isAbsolute(record.to)
    || !Number.isSafeInteger(record.moved)
    || record.moved < 0
  ) {
    throw new Error('Agent Space cutover record is invalid');
  }
  return record;
}

function writeJsonFile(target, value) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeIfPresent(target) {
  rmSync(target, { force: true });
}

function readStagedIds(inProgressPath) {
  let raw;
  try {
    raw = readFileSync(inProgressPath, 'utf8');
  } catch {
    return null;
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Array.isArray(record.ids)) {
    return null;
  }
  const ids = record.ids.filter((id) => isAgentId(id));
  return ids.length === record.ids.length ? ids : null;
}

function discardPartialDestination(dest, stagedIds) {
  let entries;
  try {
    entries = readdirSync(dest, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const staged = new Set(stagedIds);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.tmp-') || staged.has(entry.name)) {
      rmSync(path.join(dest, entry.name), { recursive: true, force: true });
    }
  }
}

function copySoulDirectory(fromRoot, toRoot, id) {
  const source = path.join(fromRoot, id);
  const staging = path.join(toRoot, `.tmp-${id}`);
  const destination = path.join(toRoot, id);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(toRoot, { recursive: true, mode: 0o700 });
  cpSync(source, staging, { recursive: true, dereference: false });
  rmSync(destination, { recursive: true, force: true });
  renameSync(staging, destination);
}

function verifyCopiedSoul(id, { env, home, dest }) {
  const inspection = inspectAgentSpace(id, {
    env: { ...env, AGENT_BOT_SPACES_HOME: dest },
    home,
    config: {},
  });
  if (inspection.status !== 'ok') {
    throw new Error(
      `Agent Space cutover failed: space ${id} did not verify at the destination; the legacy root is unchanged`,
    );
  }
}

function report({ applied, reason = null, from, to, moved = 0 }) {
  return { applied, reason, from, to, moved };
}

export function inspectSpacesCutover({
  env = process.env,
  home = homedir(),
  config,
} = {}) {
  const resolution = resolveSpacesHome({ env, home, config });
  const destRoot = defaultSpacesHome({ home });
  const legacyRoot = legacySpacesHome({ env, home });
  const paths = cutoverStatePaths({ env, home });
  const completed = readCompletedRecord(paths.recordPath);
  const inProgress = existsSync(paths.inProgressPath);
  const legacyPopulated = rootHoldsSpaces(legacyRoot);
  const destPopulated = inProgress ? false : rootHoldsSpaces(destRoot);
  return {
    override: resolution.source !== 'default',
    source: resolution.source,
    resolvedRoot: resolution.root,
    destRoot,
    legacyRoot,
    completed: Boolean(completed),
    inProgress,
    legacyPopulated,
    destPopulated,
    conflict: !completed && !inProgress && legacyPopulated && destPopulated,
  };
}

export function ensureSpacesCutover({
  env = process.env,
  home = homedir(),
  config,
  now = () => new Date(),
} = {}) {
  const resolution = resolveSpacesHome({ env, home, config });
  const dest = defaultSpacesHome({ home });
  const legacy = legacySpacesHome({ env, home });
  const paths = cutoverStatePaths({ env, home });

  if (resolution.source !== 'default') {
    return report({ applied: false, reason: 'override', from: legacy, to: dest });
  }

  const completed = readCompletedRecord(paths.recordPath);
  if (completed) {
    removeIfPresent(paths.inProgressPath);
    return report({
      applied: false,
      reason: 'already-completed',
      from: completed.from,
      to: completed.to,
      moved: completed.moved,
    });
  }

  if (samePath(legacy, dest)) {
    return report({ applied: false, reason: 'nothing-to-move', from: legacy, to: dest });
  }

  const inProgress = existsSync(paths.inProgressPath);
  const ids = soulDirectories(legacy);
  if (inProgress) {
    const destIds = new Set(soulDirectories(dest));
    const staged = readStagedIds(paths.inProgressPath)
      ?? ids.filter((id) => destIds.has(id));
    discardPartialDestination(dest, staged);
  } else if (rootHoldsSpaces(legacy) && rootHoldsSpaces(dest)) {
    throw new Error(
      'Agent Space cutover refused: both the legacy root and ~/.agent-space hold spaces; set AGENT_BOT_SPACES_HOME or settings.spacesRoot to the root you want to keep',
    );
  }

  if (ids.length === 0) {
    return report({ applied: false, reason: 'nothing-to-move', from: legacy, to: dest });
  }

  writeJsonFile(paths.inProgressPath, {
    from: legacy,
    to: dest,
    ids,
    startedAt: now().toISOString(),
  });

  try {
    for (const id of ids) {
      copySoulDirectory(legacy, dest, id);
    }
    for (const id of ids) {
      verifyCopiedSoul(id, { env, home, dest });
    }
    relocateSoulSpaces(legacy, dest, { file: populationFile({ env, home }) });
    writeJsonFile(paths.recordPath, {
      schemaVersion: SCHEMA_VERSION,
      from: legacy,
      to: dest,
      moved: ids.length,
      completedAt: now().toISOString(),
    });
  } catch (error) {
    // Leave the in-progress marker so a retry treats dest as not populated.
    throw error;
  }

  for (const id of ids) {
    rmSync(path.join(legacy, id), { recursive: true, force: true });
  }
  removeIfPresent(paths.inProgressPath);
  return report({ applied: true, from: legacy, to: dest, moved: ids.length });
}
