// A soul's home (#338): a private git worktree inside its soul directory
// that the daemon binds when a launched soul has no live binding, such as
// a soul spawned from a package or one whose binding expired. A package
// spawn starts its home from a copy of the package, so the harness reads
// the soul's AGENTS.md and skills from its working directory, and installs
// only its own harness adapter from the package's pins (ADR-0276, #426).
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { readAgentIdentity, stateDirectory, validateAgentId } from './agent-identity.mjs';
import { populationFile, registerSoulDir, showSoul, soulDirectory } from './agent-population.mjs';

import { buildSoulDirectory } from './soul-build.mjs';
import { ACP_SPAWN_REGISTRY } from './acp-registry.mjs';

const run = promisify(execFile);
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export function legacyHomePath(stateDir, agentId) {
  return path.join(stateDir, 'homes', validateAgentId(agentId));
}

export function soulHomePath(agentId, options = {}) {
  return path.join(soulDirectory(agentId, options), '.soul-state', 'home');
}

/**
 * A joined soul's own harness install (#417): its checkout is someone's
 * repository, so the ACP adapter it wakes with lives here instead, under
 * the soul's private state, never in its shareable package.
 */
export function soulHarnessesPath(agentId, options = {}) {
  return path.join(soulDirectory(agentId, options), '.soul-state', 'harnesses');
}

/**
 * Installs the soul's pinned adapter from `source` (a directory with package.json
 * and package-lock.json, such as the soul's own package or the bundled
 * Starter) into the soul's harness directory. Returns the directory, or
 * null when `source` does not pin this harness's adapter. An omitted harness
 * uses the identity record; the registry names the package, not its pin.
 */
export async function installSoulHarnesses(agentId, source, { install = installHarnesses, harness, ...options } = {}) {
  harness ??= recordedHarness(agentId, options);
  const pinned = pinnedHarness(source, harness);
  if (!pinned) return null;
  const directory = soulHarnessesPath(agentId, options);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writePinnedHarness(directory, pinned);
  await install(directory, { env: options.env });
  return directory;
}

function recordedHarness(agentId, options) {
  const stateDir = options.stateDir ?? stateDirectory(options);
  // Old census-only homes may have no identity file yet.
  if (!existsSync(path.join(stateDir, `${validateAgentId(agentId)}.json`))) return null;
  return readAgentIdentity(agentId, { stateDir }).harness ?? null;
}

// Keep npm ci's exact pins and package locations, including nested versions,
// shared dependencies, platform optional packages and installed peers. No
// resolution/download step is needed to derive this subset of a v3 lockfile.
function pinnedHarness(source, harness) {
  const adapter = ACP_SPAWN_REGISTRY[harness]?.adapter?.package;
  if (!adapter || !source || !existsSync(path.join(source, 'package.json'))
      || !existsSync(path.join(source, 'package-lock.json'))) return null;
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (!manifest.dependencies?.[adapter]) return null;
  const lock = JSON.parse(readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('a soul adapter needs a v3 package-lock.json');
  const dependencies = { [adapter]: manifest.dependencies[adapter] };
  const root = { ...(manifest.name ? { name: manifest.name } : {}),
    ...(manifest.version ? { version: manifest.version } : {}), dependencies };
  const packages = { '': root };
  const parent = (location) => location.slice(0, Math.max(0, location.lastIndexOf('/node_modules/')));
  const resolve = (location, name) => {
    for (;;) {
      const candidate = `${location ? `${location}/` : ''}node_modules/${name}`;
      if (Object.hasOwn(lock.packages, candidate)) return candidate;
      if (!location) return null;
      location = parent(location);
    }
  };
  const pending = [{ location: '', entry: root }];
  while (pending.length) {
    const { location, entry } = pending.pop();
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(entry[kind] ?? {})) {
        const found = resolve(kind === 'peerDependencies' ? parent(location) : location, name);
        if (!found) {
          if (kind === 'optionalDependencies' || Object.hasOwn(entry.optionalDependencies ?? {}, name)
              || (kind === 'peerDependencies' && entry.peerDependenciesMeta?.[name]?.optional)) continue;
          throw new Error(`soul adapter lockfile is missing ${name} required by ${location || adapter}`);
        }
        if (Object.hasOwn(packages, found)) continue;
        const dependency = lock.packages[found];
        if (dependency.link) throw new Error('soul adapter lockfile must not use workspace or linked packages');
        packages[found] = dependency;
        pending.push({ location: found, entry: dependency });
      }
    }
  }
  return { manifest: { ...root, private: true },
    lock: { ...(lock.name ? { name: lock.name } : {}), ...(lock.version ? { version: lock.version } : {}),
      lockfileVersion: 3, requires: true, packages } };
}

function writePinnedHarness(directory, { manifest, lock }) {
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(directory, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

// Preserve live checkout bindings; home launches always provision so a
// migration interrupted after rebinding still finishes cleanup next launch.
export function soulBindingForLaunch(agentId, { stateDir, bindings, provision, harness = null, prepareHarness = null }) {
  const binding = bindings.findAgent(agentId);
  const worktree = binding?.worktree;
  if (worktree && (worktree === legacyHomePath(stateDir, agentId)
      || (path.basename(worktree) === 'home' && path.basename(path.dirname(worktree)) === '.soul-state')
      || !existsSync(worktree))) {
    return provision({ agentId, harness });
  }
  if (worktree && prepareHarness) return Promise.resolve(prepareHarness(agentId, harness, worktree)).then(() => binding);
  return binding;
}

// Claim only an empty/unmarked soul directory, never another soul's state.
export function ensureSoulDirectory(agentId, packagePath = null, options = {}) {
  validateAgentId(agentId);
  const directory = soulDirectory(agentId, options);
  const state = path.join(directory, '.soul-state');
  const marker = path.join(state, 'agent-id');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() !== agentId) {
    throw new Error('soul directory belongs to another Agent ID');
  }
  if (!existsSync(directory)) {
    if (packagePath) cpSync(packagePath, directory, { recursive: true, verbatimSymlinks: true,
      filter: (source) => !['.soul-state', 'worktrees'].includes(path.relative(packagePath, source).split(path.sep)[0]) });
    else mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  // Publish the marker atomically: a concurrent creator must never read it
  // empty and mistake the directory for another soul's.
  const pending = `${marker}.${process.pid}.${randomUUID()}`;
  writeFileSync(pending, `${agentId}\n`, { flag: 'wx', mode: 0o600 });
  try { linkSync(pending, marker); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readFileSync(marker, 'utf8').trim() !== agentId) throw new Error('soul directory belongs to another Agent ID');
  } finally { rmSync(pending, { force: true }); }
  registerSoulDir(agentId, directory, { file: options.file ?? populationFile(options) });
  const link = path.join(state, 'space');
  let present = false;
  try { lstatSync(link); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!present) {
    const soul = showSoul(agentId, { file: options.file ?? populationFile(options) });
    try { symlinkSync(soul.spacePath, link, 'dir'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return directory;
}

/**
 * How to run npm: the host's own copy when it names one in AGENT_BOT_NPM
 * (an npm-cli.js run with this Node), else `npm` from PATH.
 */
export function npmCommand(env = process.env, node = process.execPath) {
  return env.AGENT_BOT_NPM ? { command: node, args: [env.AGENT_BOT_NPM] } : { command: 'npm', args: [] };
}

/**
 * Installs a home's pinned dependencies: `npm ci` from its lockfile, with
 * lifecycle scripts off and no global install. A home without a
 * package.json has nothing to install.
 */
export async function installHarnesses(worktree, { env = process.env, node = process.execPath, runImpl = run } = {}) {
  if (!existsSync(path.join(worktree, 'package.json'))) return false;
  if (!existsSync(path.join(worktree, 'package-lock.json'))) throw new Error('a soul package.json needs a package-lock.json');
  const npm = npmCommand(env, node);
  try {
    await runImpl(npm.command, [...npm.args, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: worktree, timeout: INSTALL_TIMEOUT_MS,
      env: { ...env, PATH: [path.dirname(node), env.PATH].filter(Boolean).join(path.delimiter) },
    });
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error).trim().split('\n').slice(-3).join(' ');
    throw new Error(`installing the soul's harnesses failed: ${detail}`);
  }
  return true;
}

/**
 * Returns `provision({ agentId, harness, packagePath })`, which creates the
 * home when absent, binds it, and returns { worktree, file } like
 * `bindings.findAgent`.
 */
export function createSoulHomes({ stateDir, bindings, install = installHarnesses, rename = renameSync,
  warn = (message) => process.stderr.write(`${message}\n`), ...options }) {
  // One creation per home at a time: a second launch of the same new soul
  // waits for the first instead of racing it through copy and install.
  const creating = new Map();
  async function provisionHarness(worktree, source, harness) {
    const marker = path.join(path.dirname(worktree), 'home-harness');
    const selected = JSON.stringify(harness);
    const managed = existsSync(marker);
    if (managed && readFileSync(marker, 'utf8') === selected) return;
    const pinned = pinnedHarness(source, harness);
    if (!pinned && !managed) return;
    // Invalidate before installing: npm ci may remove the previous install
    // before failing, so even a switch back must retry.
    rmSync(marker, { force: true });
    if (pinned) {
      writePinnedHarness(worktree, pinned);
      await install(worktree, { env: options.env });
    } else if (managed) {
      // Only remove installs this provisioner owns. Legacy homes without a
      // package source keep their existing dependencies during migration.
      rmSync(path.join(worktree, 'node_modules'), { recursive: true, force: true });
    }
    writeFileSync(marker, selected, { mode: 0o600 });
  }
  // An existing home is rebuilt before each launch, so a soul made by an
  // earlier release gains what the builder renders now (the agent-bot MCP
  // entry, #378). The build is deterministic and only touches its own marked
  // files; a conflict (a hand-edited generated file) is reported, never a
  // reason to refuse the launch.
  async function refresh(worktree, source, harness) {
    if (existsSync(path.join(worktree, 'AGENTS.md'))) {
      try { buildSoulDirectory(worktree); }
      catch (error) { warn(`soul home ${worktree} was not rebuilt: ${error.message}`); }
    }
    await provisionHarness(worktree, source, harness);
  }
  async function create(worktree, packagePath, harness) {
    mkdirSync(worktree, { recursive: true, mode: 0o700 });
    try {
      if (packagePath) {
        for (const name of readdirSync(packagePath)) {
          if (['.soul-state', 'worktrees', 'node_modules'].includes(name)) continue;
          cpSync(path.join(packagePath, name), path.join(worktree, name), { recursive: true, verbatimSymlinks: true, force: false });
        }
      }
      if (existsSync(path.join(worktree, 'AGENTS.md'))) buildSoulDirectory(worktree);
      await provisionHarness(worktree, packagePath, harness);
      execFileSync('git', ['init', '-q'], { cwd: worktree, env: { PATH: process.env.PATH }, stdio: 'ignore' });
      appendFileSync(path.join(worktree, '.git', 'info', 'exclude'), 'node_modules/\n');
    } catch (error) {
      // A half-made home is removed, so the next launch starts it afresh.
      rmSync(worktree, { recursive: true, force: true });
      rmSync(path.join(path.dirname(worktree), 'home-harness'), { force: true });
      throw error;
    }
  }
  return async function provision({ agentId, harness = null, packagePath = null }) {
    validateAgentId(agentId);
    harness ??= recordedHarness(agentId, { ...options, stateDir });
    const directory = ensureSoulDirectory(agentId, packagePath, options);
    const worktree = path.join(directory, '.soul-state', 'home');
    while (creating.has(worktree)) await creating.get(worktree).catch(() => {});
    const legacy = legacyHomePath(stateDir, agentId);
    const state = path.dirname(worktree);
    const migratedFrom = path.join(state, 'migrated-from');
    const staging = path.join(state, 'home.migrating');
    if (!existsSync(path.join(worktree, '.git')) && existsSync(path.join(legacy, '.git'))) {
      // Persist intent before the atomic move. On restart the complete new
      // home proves promotion succeeded, even if cleanup was interrupted.
      writeFileSync(migratedFrom, `${legacy}\n`, { mode: 0o600 });
      rmSync(staging, { recursive: true, force: true });
      try { rename(legacy, worktree); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        cpSync(legacy, staging, { recursive: true, verbatimSymlinks: true });
        rename(staging, worktree);
      }
    }
    const made = existsSync(path.join(worktree, '.git'))
      ? refresh(worktree, directory, harness) : create(worktree, directory, harness);
    creating.set(worktree, made);
    try { await made; } finally { creating.delete(worktree); }
    const gitDir = realpathSync(path.join(worktree, '.git'));
    const migrated = existsSync(migratedFrom) && readFileSync(migratedFrom, 'utf8').trim() === legacy;
    const previous = bindings.findAgent(agentId);
    const replacesWorktree = migrated ? legacy : previous?.worktree && !existsSync(previous.worktree) ? previous.worktree : null;
    bindings.bind({ agentId, worktree, gitDir, harness, ...(replacesWorktree ? { replacesWorktree } : {}) });
    const bound = bindings.findAgent(agentId);
    if (!bound?.file) throw new Error('soul home could not be bound');
    // Rebind before removing the old copy. A failed binding can be retried
    // without losing either complete home.
    if (migrated) {
      rmSync(legacy, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
    return bound;
  };
}
