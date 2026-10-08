#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { mintAgentIdentity, retireAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { packageManifest, populationFile, recordSoulDisplayName, registerSoulDir, retireIdentityWithPopulation, showSoul, upsertIdentitySoul } from './agent-population.mjs';
import { initSoulSpace } from './agent-space.mjs';
import { isGateEnabled, loadConfig } from './config.mjs';
import { computePackageRevision, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST,
  readSoulPackageEntries, validateSoulPackage } from './soul-package.mjs';
import { adoptSoulPackage, discardRevisionStaging, editSoulRevision, prepareRevisionEdit, revisionPackagePath } from './soul-revisions.mjs';
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

/** The name an instance calls its template, for a message: `templateName`, else the ` - <template>` suffix of its name, else null. */
export function knownTemplateName(manifest) {
  if (typeof manifest?.templateName === 'string') return manifest.templateName;
  const parts = typeof manifest?.name === 'string' ? manifest.name.split(' - ') : [];
  return parts.length > 1 ? parts.at(-1) : null;
}

/** The names a template answers to: its current name, then the ones it declares it went by (`previousNames`). */
export function templateNames(manifest) {
  const previous = Array.isArray(manifest?.previousNames) ? manifest.previousNames : [];
  return [...new Set([manifest?.name, ...previous].filter((name) => typeof name === 'string' && name.trim()))];
}

/**
 * The name an instance knew its template by, if it came from a template
 * with one of `names`: its recorded `templateName`, or, for a manifest
 * written before the field existed, the ` - <template>` suffix a spawn
 * gives the instance name. Null when none of the names fits.
 */
export function instanceTemplateName(manifest, names) {
  if (typeof manifest?.templateName === 'string') return names.includes(manifest.templateName) ? manifest.templateName : null;
  if (typeof manifest?.name !== 'string') return null;
  return [...names].sort((a, b) => b.length - a.length).find((name) => manifest.name.endsWith(` - ${name}`)) ?? null;
}

/**
 * Whether the template owns the instance's name: `nameSource` says so, or,
 * before the field, the name is the `<template> - <template>` pair a spawn
 * under the template's own name produces. A name the owner chose is never
 * owned. `{ owned, templateName }`, templateName null when no name fits.
 */
export function templateOwnedName(manifest, names) {
  const templateName = instanceTemplateName(manifest, names);
  if (templateName === null || manifest.nameSource === 'user') return { owned: false, templateName };
  if (manifest.nameSource === 'template') return { owned: true, templateName };
  return { owned: manifest.name === `${templateName} - ${templateName}`, templateName };
}

/**
 * The template an instance manifest came from: the package at `from` when
 * given (validated, whatever its name), else the bundled package whose
 * name or `previousNames` the instance's template name matches. Null when
 * none does. `{ package, manifest, names, templateName }`, templateName
 * being the name the instance knew the template by (null with an unrelated
 * `from`).
 */
export function resolveInstanceTemplate(manifest, { from = null, env = process.env } = {}) {
  const candidates = from !== null ? [resolve(from)] : bundledSouls({ env });
  for (const candidate of candidates) {
    let template;
    try { template = JSON.parse(readFileSync(join(candidate, 'soul.json'), 'utf8')); } catch { if (from !== null) throw new Error(`${candidate} is not a soul package`); continue; }
    const names = templateNames(template);
    const templateName = instanceTemplateName(manifest, names);
    if (from === null && templateName === null) continue;
    validateSoulPackage(candidate);
    return { package: candidate, manifest: template, names, templateName };
  }
  return null;
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
export async function spawnSoulTemplate(templatePath, { name, role = null, harness = null, parentId = null, appSlug = null, ...options } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('--name must be a nonempty string');
  // The instance's role (#535): soul.json `role`, as `population list` reads it (60 chars).
  if (role !== null && (typeof role !== 'string' || !role.trim() || role.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(role))) {
    throw new Error('--role must be 1 to 60 printable characters');
  }
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
    // Provenance (GeniusBar#287): which template, under which name, and
    // whether the owner kept that name or chose one, so a later template
    // rename (`soul env migrate --template-name`) can tell the two apart.
    // A template's own `previousNames` and `maintained` describe the
    // template; the instance does not carry them.
    const { previousNames: _previousNames, maintained: _maintained, ...definition } = template;
    const manifest = { ...definition, formatVersion: 2, ignore: PACKAGE_IGNORE_LIST,
      name: displayName, ...(role === null ? {} : { role: role.trim() }), template: false, templateRevision: template.revision,
      templateName: template.name, nameSource: name === template.name ? 'template' : 'user', parentRevision: null };
    const manifestPath = join(directory, 'soul.json');
    const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    save();
    manifest.revision = computePackageRevision(directory);
    save();
    identity = mintAgentIdentity({ ...options, stateDir, appSlug, packagePath: directory,
      parentId, harness, useGithub: Boolean(appSlug) && isGateEnabled('github-identity', options) });
    // The soul's life starts inside its folder (ADR-0583 decisions 8 and 9):
    // the marker, the Agent Space as a directory, and the history mirror
    // from the genesis revision on.
    const state = join(directory, '.soul-state');
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, 'agent-id'), `${identity.id}\n`, { flag: 'wx', mode: 0o600 });
    const space = initSoulSpace(identity.id, directory, revisionOptions);
    revisionOptions.soulDir = directory;
    adoptSoulPackage(identity.id, directory, { ...revisionOptions, reason: 'Spawn template instance' });
    // The seed is hashed into revisions, so deriving it from the Agent ID
    // must happen after genesis. Record this initialization, never rewrite birth.
    manifest.displaySeed = identity.id;
    save();
    const initialized = await editSoulRevision(identity.id, directory,
      { ...revisionOptions, reason: 'Initialize display seed from instance identity' });
    writeFileSync(manifestPath, readFileSync(join(revisionPackagePath(identity.id, initialized.revision, revisionOptions), 'soul.json')));
    upsertIdentitySoul(identity.id, space.path, { file, stateDir, ...(options.now ? { now: options.now } : {}) });
    registered = true;
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

/**
 * What `soul env migrate --template-name` would do to the soul at `soulDir`
 * (read-only): `{ status: 'pending' | 'skipped', note, from, to,
 * templateName: { from, to }, template }`. Pending only for a non-template
 * instance whose bundled template now goes by another name while the
 * template owns the instance's name (`templateOwnedName`); a name the owner
 * chose, an instance of no bundled template, and a name already current
 * are skipped with the reason.
 */
export function planTemplateRename(soulDir, { env = process.env } = {}) {
  const skipped = (note, extra = {}) => ({ status: 'skipped', note, from: null, to: null, templateName: { from: null, to: null }, template: null, ...extra });
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(soulDir, 'soul.json'), 'utf8')); }
  catch (error) { throw Object.assign(new Error(`${soulDir}/soul.json cannot be read (${error.code ?? error.message})`), { code: 'soul-manifest-unreadable' }); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw Object.assign(new Error(`${soulDir}/soul.json is not an object`), { code: 'soul-manifest-unreadable' });
  const from = typeof manifest.name === 'string' ? manifest.name : null;
  if (manifest.template === true) return skipped('a template keeps its own name', { from });
  if (typeof manifest.templateRevision !== 'string') return skipped('not spawned from a template', { from });
  const found = resolveInstanceTemplate(manifest, { env });
  if (!found) return skipped(`no bundled template is named ${knownTemplateName(manifest) ?? 'as the instance'} or went by that name`, { from });
  const template = { name: found.manifest.name, package: found.package, revision: found.manifest.revision ?? null };
  const { owned, templateName } = templateOwnedName(manifest, found.names);
  if (!owned) return skipped('the name was chosen by the owner', { from, templateName: { from: templateName, to: templateName }, template });
  const to = `${template.name} - ${template.name}`;
  if (from === to) return skipped('already named by the template', { from, to, templateName: { from: templateName, to: template.name }, template });
  return { status: 'pending', note: null, from, to, templateName: { from: templateName, to: template.name }, template };
}

/**
 * Renames the instance `id` at `soulDir` as a pending plan says: one
 * package revision through the host edit path (`revision prepare`, the
 * manifest's `name`, `templateName` and `nameSource` changed in the
 * staging, `revision edit --apply`), then the census display name when it
 * was the template's. The Agent ID, the folder, `.soul-state` and every
 * other file stay as they are. Returns the plan with `status: 'done'`,
 * `revision`, `parentRevision` and `displayName: { from, to }`.
 */
export async function renameFromTemplate(id, soulDir, plan, { file = populationFile(), ...options } = {}) {
  if (plan.status !== 'pending') throw new Error('nothing to rename');
  const revisionOptions = { ...options, file, soulDir };
  const staged = prepareRevisionEdit(id, revisionOptions);
  let edited;
  try {
    const manifestPath = join(staged.staging, 'soul.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: plan.to, templateName: plan.templateName.to, nameSource: 'template' }, null, 2)}\n`);
    edited = await editSoulRevision(id, staged.staging, { ...revisionOptions, apply: true, reason: `Rename from template ${plan.templateName.from} to ${plan.templateName.to}` });
  } finally { try { discardRevisionStaging(staged.staging); } catch { /* temp under the soul; harmless */ } }
  // The census name is the template's old name only when the owner kept
  // it at launch (the daemon records the launch name); any other name is
  // theirs and stays.
  const soul = showSoul(id, { file });
  const shown = typeof soul.displayName === 'string' ? soul.displayName : null;
  const displayName = { from: shown, to: shown };
  if (shown !== null && (shown === plan.templateName.from || shown === plan.from)) {
    recordSoulDisplayName(id, plan.templateName.to, { file });
    displayName.to = plan.templateName.to;
  }
  return { ...plan, status: 'done', note: `renamed from ${plan.from} to ${plan.to}`, revision: edited.revision, parentRevision: edited.parentRevision, displayName };
}

export async function templateSpawnCommand(args) {
  const [templatePath, ...flags] = args;
  const options = {};
  const usage = 'usage: agent-bot soul spawn TEMPLATE_PATH --name NAME [--harness H] [--role ROLE]';
  if (!templatePath || templatePath.startsWith('-')) throw new Error(usage);
  for (let i = 0; i < flags.length; i += 2) {
    const key = { '--name': 'name', '--harness': 'harness', '--role': 'role' }[flags[i]];
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
