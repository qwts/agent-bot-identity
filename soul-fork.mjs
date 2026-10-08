#!/usr/bin/env node

// `agent-bot soul fork <copy-path> --name N [--harness H] [--json] [--principal-stdin]`
// (GeniusBar #83, "Make it a new soul"): a Finder copy of a soul's folder
// carries the original's `.soul-state/agent-id`, so `soul locate` calls it a
// `copy` and nothing may launch it (#80). Fork turns the copy itself into a
// new soul: its own Agent ID, identity, genesis revision and census row, in
// the same folder, so `soul locate` then reports it `installed`. The
// original's folder, identity and agent-comms membership are never touched.
//
// The copy's working state is the original's, not its package: the marker,
// the soul's HOME (harness sign-ins included) and its git worktrees, whose
// admin directories belong to the original. It moves to
// `<souls root>/.archive/<UTC stamp>-<folder>-state/` before the new soul is
// minted. A credentials declaration names the original's GitHub App, so the
// fork drops it. Owner only. A fork that fails after minting rolls back like
// a failed launch (#419): it leaves agent-comms, the new soul is retired, and
// the folder is archived, never deleted.
//
// The daemon's package launch of a copy (#432) is the same fork, authorized
// by the launch instead of the owner gate and with `join: null`: the launch
// joins and starts the new soul itself, as it does a template instance, and
// the original is never relaunched or renamed.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { leaveLaunchedSoul } from './agent-daemon.mjs';
import { mintAgentIdentity, readAgentIdentity, retireAgentIdentity, stateDirectory, validateAgentId } from './agent-identity.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { archiveSoulDirs, locateSoulDir, populationFile, recordSoulDisplayName, registerSoulDir,
  retireIdentityWithPopulation, upsertIdentitySoul } from './agent-population.mjs';
import { initSoulSpace } from './agent-space.mjs';
import { loadConfig } from './config.mjs';
import { assertOwnerAction } from './owner-gate.mjs';
import { joinComms, joinSoul } from './soul-join.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, readSoulPackageEntries, validateSoulPackage } from './soul-package.mjs';
import { adoptSoulPackage, editSoulRevision, revisionPackagePath } from './soul-revisions.mjs';
import { soulsHome } from './souls-root.mjs';

const USAGE = 'usage: agent-bot soul fork <copy-path> --name NAME [--harness H] [--role ROLE] [--json] [--principal-stdin]';
const NAME_MAX = 128;

export function parseForkArgs(argv) {
  const options = { json: false, principalStdin: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--principal-stdin') options.principalStdin = true;
    else if (arg === '--name' || arg === '--harness' || arg === '--role') {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (options[key] !== undefined || value === undefined || value.startsWith('--')) throw new Error(USAGE);
      options[key] = value;
      i++;
    } else if (arg.startsWith('--')) throw new Error(USAGE);
    else positional.push(arg);
  }
  if (positional.length !== 1 || options.name === undefined) throw new Error(USAGE);
  return { ...options, copy: path.resolve(positional[0]) };
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`--name must be 1 to ${NAME_MAX} printable characters`);
  }
  return name;
}

// The template part of an instance's name ("Bill - Starter" → "Starter").
function templateName(manifestName) {
  const at = manifestName.lastIndexOf(' - ');
  return at === -1 ? manifestName : manifestName.slice(at + 3);
}

function stamp(now) {
  return now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function move(from, to) {
  mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try { renameSync(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

// The original's working state, out of the copy before it becomes a soul.
function archiveWorkingState(copy, archive, now) {
  let target = path.join(archive, `${stamp(now)}-${path.basename(copy)}-state`);
  for (let n = 2; existsSync(target); n += 1) target = path.join(archive, `${stamp(now)}-${n}-${path.basename(copy)}-state`);
  const moved = [];
  for (const directory of PACKAGE_IGNORE_LIST.directories.map((entry) => entry.replace(/\/$/, ''))) {
    const from = path.join(copy, directory);
    if (!existsSync(from)) continue;
    move(from, path.join(target, directory));
    moved.push(directory);
  }
  return moved.length ? target : null;
}

function archiveFolder(folder, archive, now) {
  let to = path.join(archive, `${stamp(now)}-${path.basename(folder)}`);
  for (let n = 2; existsSync(to); n += 1) to = path.join(archive, `${stamp(now)}-${n}-${path.basename(folder)}`);
  move(folder, to);
  return { from: folder, to };
}

export async function forkSoul({
  copy, name, role = null, harness = undefined, principal = null, parentId = null,
  env = process.env, home = homedir(), cwd = process.cwd(), config, now = () => new Date(),
  gate = (action, { principal: presented }) => assertOwnerAction(action, { principal: presented, env, cwd }),
  join = joinSoul,
  comms = joinComms,
  leave = (soul) => leaveLaunchedSoul(soul, { env }),
} = {}) {
  validName(name);
  // The fork's role (#535): soul.json `role`, as `population list` reads it (60 chars).
  if (role !== null && (typeof role !== 'string' || !role.trim() || role.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(role))) {
    throw new Error('--role must be 1 to 60 printable characters');
  }
  if (harness !== undefined && (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness))) throw new Error('--harness must be a harness key');
  if (parentId !== null) validateAgentId(parentId);
  const loaded = config === undefined ? loadConfig({ env, home }) : config;
  const options = { env, home, config: loaded };
  const stateDir = stateDirectory(options);
  const file = populationFile(options);
  const folder = path.resolve(copy);

  // Everything that can refuse runs before the owner is asked or anything changes.
  const locate = () => locateSoulDir(folder, { ...options, file });
  const refuse = (found) => {
    if (found.status === 'copy') return;
    const reason = {
      installed: `${folder} is the folder of soul ${found.agentId} itself; only a copy of a soul's folder can be forked`,
      package: `${folder} is a soul package, not a copy of a soul; launch it, or run agent-bot soul spawn, to start a new soul from it`,
    }[found.status] ?? found.message ?? `${folder} cannot be forked (${found.status})`;
    throw Object.assign(new Error(reason), { code: `soul-fork-${found.status}` });
  };
  const located = locate();
  refuse(located);
  const original = located.agentId;
  validateSoulPackage(folder);
  const { manifest } = readSoulPackageEntries(folder);
  const runs = harness ?? readAgentIdentity(original, { stateDir }).harness ?? manifest.preferredHarnesses?.[0];
  if (typeof runs !== 'string' || !HARNESS_KEY_PATTERN.test(runs)) throw new Error(`soul ${original} has no harness to copy; name one with --harness`);

  const authorization = await gate(`soul fork ${original} ${name}`, { principal });
  // The owner may take a while to answer; the folder may have changed since.
  const confirmed = locate();
  refuse(confirmed);
  if (confirmed.agentId !== original) throw new Error(`${folder} changed while the owner was asked; nothing was forked`);

  const archive = path.join(soulsHome(options).root, '.archive');
  const result = { agentId: null, forkedFrom: original, name, soulDir: folder, harness: runs, address: null,
    state: null, ...(authorization?.method ? { authorization: authorization.method } : {}) };
  let identity = null;
  let registered = false;
  let joined = false;
  try {
    result.state = archiveWorkingState(folder, archive, now);
    const { credentials: _original, displaySeed, ...kept } = manifest;
    const next = { ...kept, formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, displaySeed,
      name: `${name} - ${templateName(manifest.name)}`, ...(role === null ? {} : { role: role.trim() }), template: false,
      templateRevision: manifest.templateRevision ?? manifest.revision, parentRevision: null };
    const manifestPath = path.join(folder, 'soul.json');
    const save = () => writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
    save();
    next.revision = computePackageRevision(folder);
    save();
    identity = mintAgentIdentity({ ...options, stateDir, now, appSlug: null, packagePath: folder, harness: runs, parentId, useGithub: false });
    result.agentId = identity.id;
    // The fork's life starts inside its folder (ADR-0583 decisions 8 and 9),
    // like a spawn's: marker, Agent Space directory, history mirror.
    const state = path.join(folder, '.soul-state');
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(path.join(state, 'agent-id'), `${identity.id}\n`, { flag: 'wx', mode: 0o600 });
    const space = initSoulSpace(identity.id, folder, { now });
    const revisionOptions = { stateDir, now, soulDir: folder };
    adoptSoulPackage(identity.id, folder, { ...revisionOptions, reason: `Fork of ${original}` });
    // The seed is hashed into revisions, so it changes after genesis, as a spawn's does.
    next.displaySeed = identity.id;
    save();
    const initialized = await editSoulRevision(identity.id, folder,
      { ...revisionOptions, reason: 'Initialize display seed from forked identity' });
    writeFileSync(manifestPath, readFileSync(path.join(revisionPackagePath(identity.id, initialized.revision, revisionOptions), 'soul.json')));
    upsertIdentitySoul(identity.id, space.path, { file, stateDir, now });
    registered = true;
    registerSoulDir(identity.id, folder, { file });
    recordSoulDisplayName(identity.id, name, { file });
    // agent-comms, as `agent-bot join` registers a soul: its own workspace
    // checkout in its folder, pinned, recorded, then `agent-comms join`.
    // A launch (`join: null`) joins the soul itself from its home.
    if (join !== null) {
      const joinedSoul = await join({ name, harness: runs, soul: identity.id, ownWorkspace: true, env, home, config: loaded,
        comms: (soul, commsOptions) => {
          joined = true; // a join that fails after the hub records it still needs a leave
          return comms(soul, commsOptions);
        } });
      result.address = joinedSoul.address;
    }
  } catch (error) {
    const rollback = { left: !joined, retired: false, archived: [] };
    try {
      if (joined) { try { rollback.left = await leave({ agentId: identity.id }); } catch { /* reported below */ } }
      if (identity) {
        if (registered) retireIdentityWithPopulation(identity.id, { file, stateDir, now });
        else retireAgentIdentity(identity.id, { stateDir, now });
        rollback.retired = true;
        rollback.archived = archiveSoulDirs(identity.id, { ...options, file, now });
      }
      if (existsSync(folder)) rollback.archived.push(archiveFolder(folder, archive, now));
    } catch { /* the fork's own error is the one reported */ }
    appendAuditReceipt({ event: 'soul-fork', agentId: identity?.id ?? null, decision: 'rolled-back',
      detail: `from ${original}` }, { env, home, now });
    throw Object.assign(error, { rollback });
  }
  appendAuditReceipt({ event: 'soul-fork', agentId: result.agentId, decision: 'forked', detail: `from ${original}` }, { env, home, now });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = process.argv.includes('--json');
  try {
    const { copy, name, harness, principalStdin } = parseForkArgs(process.argv.slice(2));
    let principal = null;
    if (principalStdin) {
      try { principal = JSON.parse(readFileSync(0, 'utf8')); }
      catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
    }
    const result = await forkSoul({ copy, name, harness, principal });
    process.stdout.write(json ? `${JSON.stringify(result)}\n`
      : `${result.soulDir} is now soul ${result.agentId} (${name}), forked from ${result.forkedFrom}; joined agent-comms as ${result.address}\n`
        + `${result.state ? `  the original's working state from the copy: ${result.state}\n` : ''}`);
  } catch (error) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'soul-fork-failed', message: error.message,
        ...(error.rollback ? { rollback: error.rollback } : {}) } })}\n`);
    }
    process.stderr.write(`agent-bot soul fork: ${error.message}\n`);
    process.exitCode = 1;
  }
}
