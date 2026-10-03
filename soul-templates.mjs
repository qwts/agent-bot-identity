#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { mintAgentIdentity, retireAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { populationFile, registerSoulDir, retireIdentityWithPopulation, upsertIdentitySoul } from './agent-population.mjs';
import { initAgentSpace } from './agent-space.mjs';
import { computePackageRevision, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST,
  readSoulPackageEntries, validateSoulPackage } from './soul-package.mjs';
import { adoptSoulPackage, editSoulRevision, revisionPackagePath } from './soul-revisions.mjs';
import { soulsHome } from './souls-root.mjs';

export function soulDisplayFilename(displayName) {
  return displayName.replace(/[/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '-').replace(/[. ]+$/, '') + '.soul';
}

function workingPath(path) {
  return [...PACKAGE_IGNORE_LIST.directories, ...GENERATED_HARNESS_PATHS].some((candidate) =>
    candidate.endsWith('/') ? path === candidate.slice(0, -1) || path.startsWith(candidate) : path === candidate);
}

// Mechanism shared by CLI and authenticated daemon package launches. No
// template code runs; the package is validated before a directory or ID exists.
export async function spawnSoulTemplate(templatePath, { name, harness = null, ...options } = {}) {
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
      parentId: null, harness, useGithub: false });
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
  try { process.stdout.write(`${JSON.stringify(await templateSpawnCommand(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`agent-bot soul spawn: ${error.message}\n`); process.exitCode = 1; }
}
