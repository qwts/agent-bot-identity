#!/usr/bin/env node
// `agent-bot soul env`: the soul's environment descriptor (#583, ADR-0583).
// Strictly read-only. It resolves the soul the way `soul profile` does
// (readOnly census lookup) and never provisions: no ensureSoulDirectory,
// createSoulHomes, initAgentSpace or registerSoulDir. A fresh census row
// with no folder yet reads as a descriptor whose components are absent.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACP_SPAWN_REGISTRY } from './acp-registry.mjs';
import { readAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { duplicateSoulDirs, locateSoulDir, populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';

import { buildSoulDirectory } from './soul-build.mjs';
import { ENV_CONTRACT_VERSION, GENERATED_HARNESS_MARKER, GENERATED_HARNESS_PATHS, RETENTION, SOUL_LAYOUT, classificationContract } from './soul-env-contract.mjs';
import { credentialStores } from './soul-credentials.mjs';
import { inspectToolHomes, readMigrationJournal } from './soul-env-migrate.mjs';
import { REVISIONS_FILE, TURNS_FILE, runsDirectory } from './soul-history.mjs';
import { inspectSoulSpace, spaceMigrateCommand } from './soul-memory.mjs';
import { STEP_FINAL_STATUSES } from './soul-migration-journal.mjs';
import { secretSetCommand } from './soul-providers.mjs';
import { inspectSoulRuntimes, runtimeLaunchEnv } from './soul-runtimes.mjs';
import { inspectSoulSecrets } from './soul-secrets.mjs';
import { adoptCommand, adoptStepId } from './soul-tool-homes.mjs';
import { soulsHome } from './souls-root.mjs';

export const ENV_SCHEMA_VERSION = 1;
// What this engine can do for a host, so a client gates each later slice
// of #583 on the engine it talks to rather than on a version number.
export const ENV_CAPABILITIES = Object.freeze(['env', 'revision-prepare', 'runtimes', 'providers', 'tool-homes', 'memory', 'history', 'template-name', 'template-refresh']);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: agent-bot soul env <agentId|name> [--json] | soul env migrate <agentId|name> --adopt-host-signin [--harness NAME] | --space-into-soul | --template-name [--plan] [--json] [--principal-stdin]';
const LINE_COUNT_MAX_BYTES = 256 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const SMALL_MAX_BYTES = 4 * 1024;
const STATE = '.soul-state';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = (value) => typeof value === 'string' && value.trim() ? value : null;
const cleanLine = (value) => String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function lstat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

// Small regular files only, never through a link: the root may hold
// anything an agent wrote, and a linked manifest could name any file.
function readSmall(file, limit) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return null;
    return readFileSync(fd);
  } catch { return null; } finally { closeSync(fd); }
}

// Lines of an append-only journal, counted in chunks without following a
// link; null when the file is absent, unreadable or past the bound.
function countLines(file) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return error.code === 'ENOENT' ? 0 : null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LINE_COUNT_MAX_BYTES) return null;
    const chunk = Buffer.alloc(64 * 1024);
    let lines = 0, read = 0, last = 0;
    for (;;) {
      read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      for (let i = 0; i < read; i += 1) if (chunk[i] === 10) lines += 1;
      last = chunk[read - 1];
    }
    // A final line without its newline still counts.
    return lines + (last !== 0 && last !== 10 ? 1 : 0);
  } catch { return null; } finally { closeSync(fd); }
}

function readJson(file, limit = MANIFEST_MAX_BYTES) {
  const bytes = readSmall(file, limit);
  if (bytes === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return object(parsed) ? parsed : null;
  } catch { return null; }
}

function listDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => entry.name).sort();
  } catch { return []; }
}

function resolveSoul(id, options) {
  const file = populationFile(options);
  try { return typeof id === 'string' && id.startsWith('agent_') ? showSoul(id, { file }) : showSoulByName(id, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}

function hostStateBase({ env, home }) {
  return env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
}

// A tool the host provides, as the daemon's launch PATH would find it:
// the host's AGENT_BOT_TOOL_PATH first, then this process's PATH.
function hostTool(name, env) {
  const dirs = [env.AGENT_BOT_TOOL_PATH, env.PATH].filter(Boolean).join(path.delimiter).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

function workspaceEntry(directory, name) {
  const file = path.join(directory, name);
  const info = lstat(file);
  const entry = { name, path: file, location: info?.isSymbolicLink() ? 'linked' : 'inside', target: null, repository: null, branch: null };
  if (entry.location === 'linked') {
    try { entry.target = path.resolve(directory, readlinkSync(file)); } catch { /* dangling or unreadable */ }
  }
  const checkout = entry.target ?? file;
  let gitDir = null;
  const git = lstat(path.join(checkout, '.git'));
  if (git?.isDirectory()) { entry.repository = 'own'; gitDir = path.join(checkout, '.git'); }
  else if (git?.isFile()) {
    const pointer = readSmall(path.join(checkout, '.git'), SMALL_MAX_BYTES)?.toString('utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (pointer) { gitDir = path.resolve(checkout, pointer[1]); entry.repository = gitDir; }
  }
  if (gitDir) {
    const head = readSmall(path.join(gitDir, 'HEAD'), SMALL_MAX_BYTES)?.toString('utf8').match(/^ref: refs\/heads\/(.+?)\s*$/m);
    entry.branch = head ? head[1] : null;
  }
  return entry;
}

// `~/.claude`-style registry stores, expanded against the host home: the
// place a harness keeps its sign-in and sessions today, shared by every soul.
function hostStore(row, home) {
  if (typeof row?.store !== 'string') return null;
  return row.store.startsWith('~/') ? path.join(home, row.store.slice(2)) : row.store;
}

function adapterInstall(root, location, row) {
  const pkg = row?.adapter?.package;
  if (!pkg) return null;
  const manifest = readJson(path.join(root, location, 'node_modules', pkg, 'package.json'));
  if (!manifest) return null;
  const bin = row.command ? path.join(root, location, 'node_modules', '.bin', row.command) : null;
  return { kind: 'npm', package: pkg, version: text(manifest.version), location,
    bin: bin && existsSync(bin) ? bin : null, status: 'ok' };
}

export function readSoulEnvironment(id, { env = process.env, home = env.HOME ?? homedir(), config, now = () => new Date(), ...rest } = {}) {
  const options = { env, home, ...(config === undefined ? {} : { config }), ...rest };
  const soul = resolveSoul(id, options);
  const errors = [];
  const stateDir = options.stateDir ?? stateDirectory(options);
  const result = {
    schemaVersion: ENV_SCHEMA_VERSION,
    engine: { version: text(readJson(path.join(ROOT, 'package.json'))?.version), contractVersion: ENV_CONTRACT_VERSION, capabilities: [...ENV_CAPABILITIES] },
    identity: { agentId: soul.id, name: soul.name ?? null, displayName: soul.displayName ?? null, status: soul.status ?? null,
      harness: null, genesis: { revision: null, parentSoul: soul.parentId ?? null }, revision: null, parentRevision: null, template: null, formatVersion: null },
    root: { soulDir: null, soulsRoot: null, source: null, registered: false, marker: null, copies: [], device: null },
    components: [],
    classification: classificationContract(),
    harnesses: { selected: null, declared: [], installed: [], launchable: null },
    runtimes: { declared: {}, installed: [], missing: [], unsupported: [] },
    providers: { declared: [], secrets: [], invalid: [] },
    launch: { supported: null, lane: null, cwd: null, routing: { HOME: 'host', PATH: 'host', TMPDIR: 'host', toolHome: null, runtimes: {}, env: [] }, limitations: [] },
    readiness: { ready: false, problems: [] },
    migration: { status: 'none', journal: `${STATE}/migration.json`, steps: [] },
    retention: Object.fromEntries(RETENTION.map((kind) => [kind, []])),
    errors,
  };
  const problem = (code, severity, component, message, action = null) => result.readiness.problems.push({ code, severity, component, message, action });

  try {
    const identity = readAgentIdentity(soul.id, { stateDir });
    result.identity.harness = text(identity.harness);
    result.identity.genesis.revision = text(identity.genesis?.revision);
    if (identity.genesis?.parentSoul) result.identity.genesis.parentSoul = identity.genesis.parentSoul;
  } catch { errors.push({ area: 'identity', message: 'Execution identity unavailable; harness may be unknown.' }); }

  const { root: soulsRoot, source } = soulsHome(options);
  result.root.soulsRoot = soulsRoot;
  result.root.source = source;
  // The registered folder is the root this descriptor describes, whatever
  // its marker says: a bad marker is a readiness problem, not a reason to
  // look elsewhere. Only an absent folder resolves the way `soul profile`
  // does (a moved folder, or the default name), still without registering.
  let root;
  try {
    const registered = typeof soul.soulDir === 'string' && lstat(soul.soulDir)?.isDirectory() ? soul.soulDir : null;
    root = registered ?? soulDirectory(soul.id, { ...options, readOnly: true });
  } catch (error) { errors.push({ area: 'root', message: `Soul directory unresolvable: ${error.message}` }); }
  if (!root) {
    result.retention = retentionIndex(result.components);
    return result;
  }
  result.root.soulDir = root;
  const located = locateSoulDir(root, options);
  // `package` means no marker: a census row whose folder was never provisioned.
  result.root.marker = located.status === 'invalid' ? 'invalid' : located.status === 'package' ? 'missing' : 'ok';
  result.root.registered = located.status === 'installed';
  try { result.root.copies = duplicateSoulDirs(options).find((entry) => entry.agentId === soul.id)?.copies ?? []; }
  catch { errors.push({ area: 'root', message: 'Could not scan the souls root for copies.' }); }
  const rootStat = lstat(root);
  result.root.device = rootStat?.isDirectory() ? rootStat.dev : null;
  if (located.status === 'invalid') problem('marker-invalid', 'error', 'manifest', located.message);
  else if (located.status === 'unregistered') problem('root-unregistered', 'error', 'manifest', located.message);
  else if (located.status === 'copy' || located.status === 'duplicate') problem('root-duplicate', 'warning', 'manifest', located.message);
  if (result.root.copies.length && !result.readiness.problems.some((p) => p.code === 'root-duplicate')) {
    problem('root-duplicate', 'warning', 'manifest', `${result.root.copies.length} other folder(s) carry this soul's marker: ${result.root.copies.join(', ')}`);
  }

  const manifest = rootStat?.isDirectory() ? readJson(path.join(root, 'soul.json')) : null;
  if (manifest) {
    result.identity.displayName ??= text(manifest.name);
    result.identity.revision = text(manifest.revision);
    result.identity.parentRevision = text(manifest.parentRevision);
    result.identity.template = typeof manifest.template === 'boolean' ? manifest.template : null;
    result.identity.formatVersion = Number.isInteger(manifest.formatVersion) ? manifest.formatVersion : null;
    if (object(manifest.runtimes)) result.runtimes.declared = manifest.runtimes;
  } else if (rootStat?.isDirectory()) errors.push({ area: 'manifest', message: 'Package manifest unavailable or invalid.' });

  const present = (relative) => lstat(path.join(root, relative)) !== null;
  const harnessNames = [...new Set([result.identity.harness, ...(Array.isArray(manifest?.preferredHarnesses) ? manifest.preferredHarnesses : [])]
    .filter((name) => typeof name === 'string' && Object.hasOwn(ACP_SPAWN_REGISTRY, name)))];
  for (const component of SOUL_LAYOUT) {
    const entry = { id: component.id, path: component.path, classification: component.classification,
      present: component.path ? present(component.path) : false, retention: component.retention };
    switch (component.id) {
      case 'skills': entry.entries = entry.present ? listDirectories(path.join(root, 'skills')) : []; break;
      case 'workflows': {
        let names = [];
        try { names = readdirSync(path.join(root, 'workflows')).filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/.test(name)).sort(); } catch { /* absent */ }
        entry.entries = names;
        break;
      }
      case 'generated': {
        entry.paths = [...GENERATED_HARNESS_PATHS];
        entry.marker = GENERATED_HARNESS_MARKER;
        entry.present = GENERATED_HARNESS_PATHS.some((candidate) => present(candidate.endsWith('/') ? candidate.slice(0, -1) : candidate));
        entry.drift = null;
        if (manifest && present('AGENTS.md')) {
          try {
            entry.drift = buildSoulDirectory(root, { check: true }).drift;
            if (entry.drift.length) problem('generated-drift', 'warning', 'generated', `${entry.drift.length} generated file(s) differ from the builder's output: ${entry.drift.join(', ')}`, `agent-bot soul build ${JSON.stringify(root)}`);
          } catch (error) {
            if (/generated path conflict/.test(error.message)) problem('generated-conflict', 'error', 'generated', error.message);
            else errors.push({ area: 'generated', message: `Generated output could not be checked: ${error.message}` });
          }
        }
        break;
      }
      case 'workspaces': {
        entry.entries = [];
        if (entry.present) {
          let names = [];
          try { names = readdirSync(path.join(root, 'worktrees')).sort(); } catch { errors.push({ area: 'workspaces', message: 'Worktrees directory unreadable.' }); }
          for (const name of names) entry.entries.push(workspaceEntry(path.join(root, 'worktrees'), name));
        }
        break;
      }
      case 'home': {
        const homeDir = path.join(root, STATE, 'home');
        entry.git = present(`${STATE}/home/.git`);
        entry.built = present(`${STATE}/home/AGENTS.md`);
        let install = null;
        try { install = JSON.parse(readSmall(path.join(root, STATE, 'home-harness'), SMALL_MAX_BYTES)?.toString('utf8') ?? 'null'); } catch { /* unreadable marker */ }
        entry.harnessInstall = typeof install === 'string' ? install : null;
        result.launch.cwd = homeDir;
        if (!entry.present) problem('home-missing', 'warning', 'home', 'The soul has no private home yet; its first launch creates and binds one.');
        break;
      }
      case 'tool-state': {
        // Per harness the soul names (#583 slice 2): where its native state
        // is routed, and whether a sign-in file exists in the soul's tool
        // home and in the host store. Existence only, never contents.
        entry.entries = inspectToolHomes(root, harnessNames, { env, home, platform: options.platform ?? process.platform }).map((row) => ({
          harness: row.harness, path: row.path, routing: row.routing, containment: row.containment, reason: row.reason,
          hostPath: row.hostPath ?? hostStore(ACP_SPAWN_REGISTRY[row.harness], home), signIn: row.signIn, hostSignIn: row.hostSignIn, note: row.note }));
        for (const row of entry.entries) {
          if (row.containment === 'soul') continue;
          result.launch.limitations.push({ harness: row.harness, message: `${row.harness}'s native state${row.hostPath ? ` (${row.hostPath})` : ''} stays shared on the host with every other soul: ${row.reason ?? 'the launch does not route it'}` });
        }
        break;
      }
      case 'credentials':
        entry.exportable = false;
        entry.declared = text(manifest?.credentials?.github?.app);
        entry.secrets = object(manifest?.credentials?.secrets) ? Object.keys(manifest.credentials.secrets).sort() : [];
        break;
      case 'memory': {
        const link = lstat(path.join(root, STATE, 'space'));
        entry.location = link?.isSymbolicLink() ? 'linked' : link?.isDirectory() ? 'inside' : null;
        entry.target = null;
        if (entry.location === 'linked') {
          try { entry.target = path.resolve(path.join(root, STATE), readlinkSync(path.join(root, STATE, 'space'))); } catch { /* unreadable link */ }
        }
        entry.contained = entry.location === 'inside';
        entry.spacePath = soul.spacePath ?? null;
        // Inspected at the census path (ADR-0583 decision 8), never at the spaces root alone.
        try { entry.status = inspectSoulSpace(soul.id, options).status; }
        catch { entry.status = null; errors.push({ area: 'memory', message: 'Agent Space could not be inspected.' }); }
        if (entry.location === 'linked') {
          result.migration.steps.push({ id: 'space-into-soul', status: 'pending', from: entry.target ?? entry.spacePath, to: path.join(root, STATE, 'space') });
          problem('memory-not-contained', 'warning', 'memory', `The Agent Space is a link to ${entry.target ?? entry.spacePath}, outside the soul; the soul's memory does not travel with its folder until it is moved inside.`, spaceMigrateCommand(soul.id));
        }
        break;
      }
      case 'history': {
        const base = hostStateBase(options);
        entry.external = [
          { what: 'revision journal', path: path.join(stateDir, 'soul-revisions', soul.id) },
          { what: 'wake sessions', path: path.join(base, 'agent-bot', 'wake-sessions.json') },
          { what: 'launch requests', path: path.join(base, 'agent-bot', 'launch-requests.json') },
          { what: 'task turns', path: path.join(base, 'agent-bot', 'task-turns.jsonl') },
        ].map((row) => ({ ...row, present: existsSync(row.path) }));
        entry.confinementLog = present(`${STATE}/confinement.log`);
        // The soul's own mirror (ADR-0583 decision 9): where it is and how
        // many lines each file holds; `null` for a file that cannot be counted.
        const runs = runsDirectory(root);
        entry.mirror = `${STATE}/runs`;
        entry.turns = countLines(path.join(runs, TURNS_FILE));
        entry.revisions = countLines(path.join(runs, REVISIONS_FILE));
        entry.mirrored = (entry.turns ?? 0) > 0 || (entry.revisions ?? 0) > 0;
        break;
      }
      case 'temp': {
        entry.entries = [];
        if (entry.present) {
          let names = [];
          try { names = readdirSync(path.join(root, STATE, 'tmp')).sort(); } catch { /* unreadable */ }
          for (const name of names) {
            const info = lstat(path.join(root, STATE, 'tmp', name));
            entry.entries.push({ name, path: path.join(root, STATE, 'tmp', name), kind: /^revision-/.test(name) ? 'revision-staging' : 'other',
              modifiedAt: info ? info.mtime.toISOString() : null });
          }
        }
        break;
      }
      case 'host-tools':
        entry.present = true;
        entry.entries = [
          { name: 'agent-bot', path: path.join(ROOT, 'agent-bot'), source: 'engine' },
          ...['agent-comms', 'git'].map((name) => ({ name, path: hostTool(name, env), source: 'host' })),
        ];
        break;
      default: break;
    }
    result.components.push(entry);
  }

  // Declared: the package's npm pins for registry adapters (ADR-0276).
  // Installed: where this engine puts them today (the home for launched
  // souls, `.soul-state/harnesses` for joined ones).
  const pins = manifest ? readJson(path.join(root, 'package.json')) : null;
  for (const [name, row] of Object.entries(ACP_SPAWN_REGISTRY)) {
    const pkg = row?.adapter?.package;
    if (!pkg) continue;
    const pin = pins?.dependencies?.[pkg];
    if (typeof pin === 'string') result.harnesses.declared.push({ name, kind: 'npm', package: pkg, version: pin, source: 'package.json' });
    for (const location of [`${STATE}/home`, `${STATE}/harnesses`]) {
      const installed = adapterInstall(root, location, row);
      if (installed) result.harnesses.installed.push({ name, ...installed });
    }
  }
  if (present(`${STATE}/harnesses`)) {
    result.migration.steps.push({ id: 'harnesses-into-runtimes', status: 'pending', from: path.join(root, STATE, 'harnesses'), to: path.join(root, STATE, 'runtimes', 'harnesses') });
  }
  // Declared runtimes and non-npm harness installs against what is
  // provisioned under .soul-state/runtimes (slice 3), read from the install
  // stamps. The descriptor never installs: a launch or `soul runtimes
  // install` does, and the last failed attempt surfaces here with its code.
  const install = `agent-bot soul runtimes install ${soul.id}`;
  let provisioned = null;
  try { provisioned = inspectSoulRuntimes(root, { manifest: manifest ?? {}, env, home }); }
  catch (error) { errors.push({ area: 'runtimes', message: `Runtimes could not be inspected: ${error.message}` }); }
  for (const row of provisioned?.runtimes ?? []) {
    const entry = { name: row.name, version: row.version, declared: row.declared, requiredBy: row.requiredBy };
    if (row.status === 'installed') result.runtimes.installed.push({ ...entry, source: row.source, path: row.path, bin: path.join(row.path, row.bin) });
    else if (row.status === 'unsupported') {
      result.runtimes.unsupported.push({ ...entry, reason: row.reason });
      problem('runtime-unsupported-platform', 'error', 'runtimes', `${row.name}: ${row.reason}`, `declare runtimes.${row.name} sources for ${provisioned.platform ?? 'this platform'} in a revision`);
    } else {
      result.runtimes.missing.push({ ...entry, reason: row.lastError ? `last install failed: ${row.lastError.code}` : 'not provisioned' });
      if (row.lastError) problem(row.lastError.code, 'error', 'runtimes', row.lastError.message, install);
      else problem('runtime-missing', 'warning', 'runtimes', `${row.name} ${row.version} is declared but not installed in the soul; the next launch installs it.`, install);
    }
  }
  for (const entry of provisioned?.harnesses ?? []) {
    result.harnesses.declared.push({ name: entry.name, kind: entry.kind, package: entry.package, version: entry.version, source: 'soul.json' });
    if (entry.status === 'installed') {
      result.harnesses.installed.push({ name: entry.name, kind: entry.kind, package: entry.package, version: entry.version, location: `${STATE}/runtimes/harnesses`,
        bin: path.join(entry.path, entry.bin, entry.executable), status: 'ok' });
    } else if (entry.status === 'unsupported') {
      problem('runtime-unsupported-platform', 'error', 'runtimes', `${entry.name}: ${entry.reason}`, `declare harnesses.${entry.name}.install.sha256 for ${provisioned.platform ?? 'this platform'} in a revision`);
    } else if (entry.lastError) problem(entry.lastError.code, 'error', 'runtimes', entry.lastError.message, install);
  }
  for (const entry of provisioned?.invalid ?? []) problem('runtime-declaration-invalid', 'error', 'manifest', entry.message);
  const selected = result.identity.harness ?? harnessNames[0] ?? null;
  result.harnesses.selected = selected;
  if (selected) {
    const row = ACP_SPAWN_REGISTRY[selected];
    const pinned = result.harnesses.declared.find((entry) => entry.name === selected) ?? null;
    const installed = result.harnesses.installed.some((entry) => entry.name === selected);
    // A harness without an npm adapter (opencode, kiro) and without a
    // declared install runs from the host PATH, which the descriptor
    // reports as not contained, not as missing: the declaration says
    // nothing about where it must come from.
    result.harnesses.launchable = row?.adapter?.package || pinned ? installed : row ? true : false;
    if (pinned && !installed) {
      problem('harness-missing', 'warning', pinned.kind === 'npm' ? 'home' : 'runtimes', pinned.kind === 'npm'
        ? `${selected} is pinned in package.json but not installed in the soul; the next launch installs it into the home.`
        : `${selected} ${pinned.version} is declared in soul.json but not installed in the soul; the next launch installs it.`, pinned.kind === 'npm' ? null : install);
    }
    result.launch.supported = Boolean(row?.enabled);
    result.launch.lane = row?.enabled ? 'acp' : null;
    // The selected harness's tool home (#583 slice 2): its variables are
    // what the launch sets; a routable harness kept on the host store
    // because its sign-in is not in the soul gets the adoption command.
    const tool = result.components.find((component) => component.id === 'tool-state')?.entries.find((entry) => entry.harness === selected) ?? null;
    if (tool) {
      result.launch.routing.toolHome = tool.containment === 'soul' ? 'soul' : 'host';
      result.launch.routing.env = [...new Set([...result.launch.routing.env, ...tool.routing])].sort();
      if (tool.containment === 'shared-host') {
        problem('tool-signin-missing', 'warning', 'tool-state', tool.hostSignIn === 'present'
          ? `${selected}'s sign-in is on the host (${tool.hostPath}) but not in the soul's tool home, so the launch keeps the shared host store; adopt it once to contain this soul`
          : `${selected}'s sign-in may be on the host where no file shows it, and it is not in the soul's tool home, so the launch keeps the shared host store; adopt once to contain this soul (the harness then signs in inside the soul)`,
        adoptCommand(soul.id, selected));
      }
    }
  }
  if (provisioned) {
    const routed = runtimeLaunchEnv(provisioned, { env, harness: selected, node: process.execPath });
    result.launch.routing.runtimes = routed.routing;
    result.launch.routing.env = [...new Set([...result.launch.routing.env, ...Object.keys(routed.env).filter((name) => name !== 'PATH')])].sort();
    result.launch.routing.PATH = Object.values(routed.routing).some((entry) => entry.source === 'soul' || entry.source === 'override') ? 'soul-runtimes'
      : routed.env.PATH ? 'host-bundled' : 'host';
  }
  // Providers per harness and the secrets they name (#583 slice 4): the
  // store is probed for presence only; no value and no length is reported.
  if (manifest) {
    let secrets = null;
    try { secrets = inspectSoulSecrets(root, { agentId: soul.id, manifest, stores: options.stores ?? credentialStores({ env }), platform: options.platform ?? process.platform }); }
    catch (error) { errors.push({ area: 'providers', message: `Providers could not be inspected: ${error.message}` }); }
    if (secrets) {
      result.providers.declared = secrets.providers.map(({ reason: _reason, ...row }) => row);
      result.providers.secrets = secrets.secrets.map(({ reason: _reason, ...row }) => row);
      result.providers.invalid = secrets.invalid;
      for (const entry of secrets.invalid) problem('provider-declaration-invalid', 'error', 'manifest', `${entry.path}: ${entry.message}`);
      for (const row of secrets.providers) {
        if (row.status === 'secret-missing') {
          problem('provider-secret-missing', row.harness === selected ? 'error' : 'warning', 'credentials',
            `${row.harness}'s provider ${row.id} needs the secret "${row.credential}" (${row.envKey}), which is not stored for this soul`, secretSetCommand(soul.id, row.credential));
        } else if (row.status === 'unsupported') {
          problem('provider-secret-unreadable', row.harness === selected ? 'error' : 'warning', 'credentials', `${row.harness}'s provider secret "${row.credential}" cannot be used: ${row.reason}`, secretSetCommand(soul.id, row.credential));
        }
        if (row.harness === selected && row.credential) result.launch.routing.env = [...new Set([...result.launch.routing.env, row.envKey])].sort();
      }
    }
  }

  // What `soul env migrate` recorded in the journal, then the adoptions
  // still to do: a routable harness kept on the host store for its sign-in.
  // A recorded step replaces the inventory's pending entry of the same id:
  // a space move under way is reported in its phase, a finished one as such.
  const recorded = new Set();
  for (const step of readMigrationJournal(root)) {
    recorded.add(step.id);
    result.migration.steps = [...result.migration.steps.filter((entry) => entry.id !== step.id), step];
  }
  for (const tool of result.components.find((component) => component.id === 'tool-state')?.entries ?? []) {
    if (tool.containment === 'shared-host' && !recorded.has(adoptStepId(tool.harness))) {
      result.migration.steps.push({ id: adoptStepId(tool.harness), status: 'pending', from: tool.hostPath, to: path.join(root, STATE, 'tools', tool.harness) });
    }
  }
  result.migration.status = result.migration.steps.some((step) => !STEP_FINAL_STATUSES.includes(step.status)) ? 'pending' : 'none';
  result.readiness.ready = !result.readiness.problems.some((entry) => entry.severity === 'error');
  result.retention = retentionIndex(result.components);
  return result;
}

function retentionIndex(components) {
  const index = Object.fromEntries(RETENTION.map((kind) => [kind, []]));
  for (const component of components) if (component.retention) index[component.retention].push(component.id);
  return index;
}

export function formatSoulEnvironment(result) {
  const lines = [`agentId: ${result.identity.agentId}`, `name: ${cleanLine(result.identity.displayName ?? result.identity.name)}`,
    `harness: ${cleanLine(result.harnesses.selected)}`, `soulDir: ${cleanLine(result.root.soulDir)}`,
    `marker: ${cleanLine(result.root.marker)} registered: ${result.root.registered}`, `ready: ${result.readiness.ready}`,
    '', `components (${result.components.length})`,
    ...result.components.map((component) => `${component.id}: ${component.present ? 'present' : 'absent'} (${component.classification}, ${component.retention ?? 'n/a'})${component.path ? ` ${cleanLine(component.path)}` : ''}`),
    '', `harnesses declared: ${result.harnesses.declared.map((h) => `${h.name}@${h.version}`).join(', ') || '-'}`,
    `harnesses installed: ${result.harnesses.installed.map((h) => `${h.name}@${h.version ?? '?'} (${h.location})`).join(', ') || '-'}`,
    `runtimes declared: ${Object.keys(result.runtimes.declared).join(', ') || '-'}`,
    `runtimes installed: ${result.runtimes.installed.map((r) => `${r.name}@${r.version}`).join(', ') || '-'}`,
    `providers: ${result.providers.declared.map((p) => `${p.harness}=${p.id} (${p.status})`).join(', ') || '-'}`,
    `secrets: ${result.providers.secrets.map((s) => `${s.name} ${s.status} (${s.store})`).join(', ') || '-'}`,
    `migration: ${result.migration.status}${result.migration.steps.length ? ` (${result.migration.steps.map((s) => s.id).join(', ')})` : ''}`];
  if (result.readiness.problems.length) lines.push('', 'problems', ...result.readiness.problems.map((p) => `${p.severity} ${p.code}: ${cleanLine(p.message)}${p.action ? ` -> ${cleanLine(p.action)}` : ''}`));
  if (result.errors.length) lines.push('', 'errors', ...result.errors.map((error) => `${error.area}: ${cleanLine(error.message)}`));
  return `${lines.join('\n')}\n`;
}

export function soulEnvCommand(argv, { write = (value) => process.stdout.write(value), ...options } = {}) {
  let id = null, json = false;
  for (const arg of argv) {
    if (arg === '--json' && !json) json = true;
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id) throw new Error(USAGE);
  const result = readSoulEnvironment(id, options);
  write(json ? `${JSON.stringify(result)}\n` : formatSoulEnvironment(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { soulEnvCommand(process.argv.slice(2)); }
  catch (error) {
    const failure = { code: error.code ?? 'soul-env-failed', message: error.message };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul env: ${failure.code}: ${failure.message}\n`);
    process.exitCode = 1;
  }
}
