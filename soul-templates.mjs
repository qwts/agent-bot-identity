#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { mintAgentIdentity, retireAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { packageManifest, populationFile, registerSoulDir, retireIdentityWithPopulation, upsertIdentitySoul } from './agent-population.mjs';
import { initAgentSpace } from './agent-space.mjs';
import { loadConfig } from './config.mjs';
import { computePackageRevision, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST,
  readSoulPackageEntries, validateSoulPackage } from './soul-package.mjs';
import { adoptSoulPackage, editSoulRevision, revisionPackagePath } from './soul-revisions.mjs';
import { soulsHome } from './souls-root.mjs';

/** The Starter shipped by this install, shared by join, start_soul and listing. */
export function bundledStarter({ env = process.env, root = dirname(fileURLToPath(import.meta.url)) } = {}) {
  if (env.AGENT_BOT_STARTER_TEMPLATE) return resolve(env.AGENT_BOT_STARTER_TEMPLATE);
  // GeniusBar: Resources/components/agent-bot beside Resources/souls.
  // Homebrew and source installs normally ship no Starter.
  const candidate = resolve(root, '..', '..', 'souls', 'starter.soul');
  return existsSync(join(candidate, 'soul.json')) ? candidate : null;
}

/**
 * Every soul package the install ships, Starter first (GeniusBar#73): the
 * other `*.soul` directories beside it whose soul.json says `template: true`.
 * Starter stays the default for join and start_soul; listing shows them all.
 */
export function bundledSouls({ env = process.env, root = dirname(fileURLToPath(import.meta.url)) } = {}) {
  const starter = bundledStarter({ env, root });
  const souls = starter ? [starter] : [];
  // An explicit Starter override replaces the bundle lookup entirely.
  if (env.AGENT_BOT_STARTER_TEMPLATE) return souls;
  const bundle = starter ? dirname(starter) : resolve(root, '..', '..', 'souls');
  let children;
  try { children = readdirSync(bundle, { withFileTypes: true }); } catch { return souls; }
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory() || !child.name.endsWith('.soul')) continue;
    const directory = join(bundle, child.name);
    if (souls.includes(directory)) continue;
    try {
      if (JSON.parse(readFileSync(join(directory, 'soul.json'), 'utf8')).template === true) souls.push(directory);
    } catch { /* not a readable package; the validator reports it if a path names it */ }
  }
  return souls;
}

// Local package data only: no census, identity, credential or SOP lookup.
export function listSoulTemplates({ env = process.env, home = homedir() } = {}) {
  const config = loadConfig({ env, home });
  const { root } = soulsHome({ env, home, config });
  const templates = [];
  const errors = [];
  const seen = new Set();
  const add = (candidate, source) => {
    let directory = resolve(candidate);
    try {
      // Canonicalize parent-directory aliases, but do not make a linked package
      // acceptable to the validator (which deliberately refuses symlinks).
      if (seen.has(directory)) return;
      seen.add(directory);
      const canonical = realpathSync(directory);
      if (canonical !== directory && seen.has(canonical)) return;
      seen.add(canonical);
      if (source === 'souls-root') {
        try { lstatSync(join(directory, '.soul-state', 'agent-id')); return; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      validateSoulPackage(directory);
      if (source === 'souls-root' && JSON.parse(readFileSync(join(directory, 'soul.json'), 'utf8')).template !== true) return;
      const manifest = packageManifest(directory);
      const preferredHarnesses = manifest.preferredHarnesses ?? [];
      directory = canonical;
      templates.push({ name: manifest.name ?? '', description: manifest.description ?? '',
        preferredHarnesses, defaultHarness: preferredHarnesses[0] ?? null,
        package: directory, revision: manifest.revision ?? null, source });
    } catch (error) { errors.push({ package: directory, message: error.message }); }
  };
  const configured = config.teams?.template;
  if (configured !== undefined) {
    if (typeof configured === 'string' && isAbsolute(configured)) add(configured, 'config');
    else errors.push({ package: typeof configured === 'string' ? configured : null,
      message: 'teams.template must be an absolute package path' });
  }
  for (const bundled of bundledSouls({ env })) add(bundled, 'bundled');
  try {
    for (const child of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.isDirectory() && child.name.endsWith('.soul')) add(join(root, child.name), 'souls-root');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push({ package: root, message: error.message });
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return { templates, soulsRoot: root, errors };
}

export function templateListCommand(args, options) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    throw new Error('usage: agent-bot soul templates [--json]');
  }
  return listSoulTemplates(options);
}

export function soulDisplayFilename(displayName) {
  return displayName.replace(/[/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '-').replace(/[. ]+$/, '') + '.soul';
}

function workingPath(path) {
  return [...PACKAGE_IGNORE_LIST.directories, ...GENERATED_HARNESS_PATHS].some((candidate) =>
    candidate.endsWith('/') ? path === candidate.slice(0, -1) || path.startsWith(candidate) : path === candidate);
}

// Mechanism shared by CLI and authenticated daemon package launches. No
// template code runs; the package is validated before a directory or ID exists.
export async function spawnSoulTemplate(templatePath, { name, harness = null, parentId = null, ...options } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('--name must be a nonempty string');
  if (harness !== null && (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness))) {
    throw new Error('invalid harness');
  }
  validateSoulPackage(templatePath);
  const { manifest: template, entries } = readSoulPackageEntries(templatePath);
  const displayName = `${name} - ${template.name}`;
  const { root } = soulsHome(options);
  const directory = join(root, soulDisplayFilename(displayName));
  const stateDir = options.stateDir ?? stateDirectory(options);
  const file = options.file ?? populationFile(options);
  const revisionOptions = { stateDir, ...(options.now ? { now: options.now } : {}) };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Exclusive mkdir also refuses dangling symlinks and concurrent spawns.
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`soul directory already exists: ${directory}`);
    throw error;
  }
  let identity;
  let registered = false;
  try {
    for (const { path, mode, bytes } of entries) {
      if (workingPath(path)) continue;
      const target = join(directory, path);
      if (mode === '040000') mkdirSync(target, { recursive: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: 'wx' });
        chmodSync(target, mode === '100755' ? 0o755 : 0o644);
      }
    }
    const manifest = { ...template, formatVersion: 2, ignore: PACKAGE_IGNORE_LIST,
      name: displayName, template: false, templateRevision: template.revision, parentRevision: null };
    const manifestPath = join(directory, 'soul.json');
    const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    save();
    manifest.revision = computePackageRevision(directory);
    save();
    identity = mintAgentIdentity({ ...options, stateDir, appSlug: null, packagePath: directory,
      parentId, harness, useGithub: false });
    adoptSoulPackage(identity.id, directory, { ...revisionOptions, reason: 'Spawn template instance' });
    // The seed is hashed into revisions, so deriving it from the Agent ID
    // must happen after genesis. Record this initialization, never rewrite birth.
    manifest.displaySeed = identity.id;
    save();
    const initialized = await editSoulRevision(identity.id, directory,
      { ...revisionOptions, reason: 'Initialize display seed from instance identity' });
    writeFileSync(manifestPath, readFileSync(join(revisionPackagePath(identity.id, initialized.revision, revisionOptions), 'soul.json')));
    const space = initAgentSpace(identity.id, options);
    upsertIdentitySoul(identity.id, space.path, { file, ...revisionOptions });
    registered = true;
    const state = join(directory, '.soul-state');
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, 'agent-id'), `${identity.id}\n`, { flag: 'wx', mode: 0o600 });
    registerSoulDir(identity.id, directory, { file });
    return { ...identity, soulDir: directory, displayName, revision: initialized.revision };
  } catch (error) {
    // Keep failed allocations as retired provenance, never as active souls.
    try {
      if (identity) {
        if (registered) retireIdentityWithPopulation(identity.id, { file, ...revisionOptions });
        else retireAgentIdentity(identity.id, revisionOptions);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
    throw error;
  }
}

export async function templateSpawnCommand(args) {
  const [templatePath, ...flags] = args;
  const options = {};
  const usage = 'usage: agent-bot soul spawn TEMPLATE_PATH --name NAME [--harness H]';
  if (!templatePath || templatePath.startsWith('-')) throw new Error(usage);
  for (let i = 0; i < flags.length; i += 2) {
    const key = { '--name': 'name', '--harness': 'harness' }[flags[i]];
    if (!key || options[key] !== undefined || !flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error(usage);
    options[key] = flags[i + 1];
  }
  if (options.name === undefined) throw new Error(usage);
  return spawnSoulTemplate(templatePath, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const listing = process.argv[2] === '--list';
  try {
    if (listing) {
      const args = process.argv.slice(3);
      const result = templateListCommand(args);
      if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
      else {
        for (const row of result.templates) process.stdout.write(`${row.name} — ${row.description} (${row.defaultHarness ?? 'none'}, ${row.source})\n`);
        for (const error of result.errors) process.stderr.write(`agent-bot soul templates: ${error.package}: ${error.message}\n`);
      }
    } else {
      const args = process.argv.slice(process.argv[2] === '--spawn' ? 3 : 2);
      process.stdout.write(`${JSON.stringify(await templateSpawnCommand(args))}\n`);
    }
  } catch (error) { process.stderr.write(`agent-bot soul ${listing ? 'templates' : 'spawn'}: ${error.message}\n`); process.exitCode = 1; }
}
