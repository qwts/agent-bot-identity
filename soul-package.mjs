#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ACP_SPAWN_REGISTRY } from './acp-registry.mjs';
import { RUNTIME_NAMES, normalizeHarnessInstall, normalizeRuntimeDeclaration } from './runtime-catalog.mjs';
import { buildHarnessFiles, envProblem, PERMISSION_RULE } from './soul-builder.mjs';
import { GENERATED_HARNESS_PATHS, GENERATED_HARNESS_MARKER, PACKAGE_IGNORE_LIST, PRIOR_PACKAGE_IGNORE_LISTS, isGeneratedPath } from './soul-harness-contract.mjs';
export { GENERATED_HARNESS_PATHS, GENERATED_HARNESS_MARKER, PACKAGE_IGNORE_LIST, PRIOR_PACKAGE_IGNORE_LISTS };

/** The current format-2 ignore list, or one an earlier release wrote (read, never guessed at). */
export function isSupportedIgnoreList(ignore) {
  const given = canonicalJson(ignore);
  return [PACKAGE_IGNORE_LIST, ...PRIOR_PACKAGE_IGNORE_LISTS].some((known) => canonicalJson(known) === given);
}

export function expectedGeneratedFiles(packageEntries) {
  return buildHarnessFiles(packageEntries);
}

const REVISION = /^sha256:[a-f0-9]{64}$(?![\s\S])/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

// JSON.stringify supplies scalar encoding; object keys sort by UTF-16 code units.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('soul.json numbers must be finite');
  return JSON.stringify(value);
}

// Where a soul's secrets live, by name only (#383). soul.json is packaged,
// exported and hashed into revisions, so it may never hold key material:
// only the closed set of keys below is accepted, and the App is a slug.
// `keyd` is agent-bot-keyd's Keychain, which only that signed binary reads
// (#397).
export const CREDENTIAL_STORES = Object.freeze(['keychain', 'file', 'keyd', 'pass-cli']);
const APP_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;
export function validateCredentialsDeclaration(credentials) {
  if (!object(credentials)) throw new Error('soul.json credentials must be an object');
  const extra = Object.keys(credentials).filter((key) => key !== 'github');
  if (extra.length) throw new Error(`soul.json credentials accepts only github (found ${extra.join(', ')})`);
  if (credentials.github === undefined) return credentials;
  const github = credentials.github;
  if (!object(github)) throw new Error('soul.json credentials.github must be an object');
  const unknown = Object.keys(github).filter((key) => key !== 'app' && key !== 'store');
  if (unknown.length) throw new Error(`soul.json credentials.github accepts only app and store (found ${unknown.join(', ')}); secrets never go in soul.json`);
  if (typeof github.app !== 'string' || !APP_SLUG.test(github.app)) throw new Error('soul.json credentials.github.app must be a GitHub App slug');
  if (github.store !== undefined && !CREDENTIAL_STORES.includes(github.store)) {
    throw new Error(`soul.json credentials.github.store must be one of ${CREDENTIAL_STORES.join(', ')}`);
  }
  return credentials;
}

// What a soul needs provisioned per soul (#583 slice 3, ADR-0583 decision 6;
// ADR-0322): `runtimes.node|python|go`, each a version or range resolved
// through the pin catalog, or an object pinning exact `sources` per platform
// (definition: they change the revision and are reviewed with it). Any
// other key or shape fails, so a typo never silently drops a pin.
export function validateRuntimesDeclaration(runtimes) {
  if (!object(runtimes)) throw new Error('soul.json runtimes must be an object');
  for (const [name, value] of Object.entries(runtimes)) {
    if (!RUNTIME_NAMES.includes(name)) throw new Error(`soul.json runtimes.${name} is not a runtime agent-bot provisions (${RUNTIME_NAMES.join(', ')})`);
    normalizeRuntimeDeclaration(name, value, `soul.json runtimes.${name}`);
  }
  return runtimes;
}

// Harness settings are a closed declaration; unrelated manifest extensions stay
// opaque. Keep failures path-specific, including overrides that no adapter renders.
// `install` (a pinned non-npm download, ADR-0322 decision 3) is only ever per
// harness and never for one whose adapter is an npm pin (ADR-0276).
const HARNESS_NAMES = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'devin', 'muse', 'kiro'];
function validateHarnessSettings(settings, path, harness = null) {
  if (!object(settings)) throw new Error(`${path} must be an object`);
  for (const [key, value] of Object.entries(settings)) {
    const field = `${path}.${key}`;
    if (key === 'install') {
      if (!harness) throw new Error(`${field} is only accepted under harnesses.<name>`);
      if (ACP_SPAWN_REGISTRY[harness]?.adapter) throw new Error(`${field}: ${harness} is an npm harness, pinned in package.json (ADR-0276)`);
      normalizeHarnessInstall(value, field, { defaultBin: ACP_SPAWN_REGISTRY[harness]?.command ?? null });
    } else if (key === 'model') {
      if (!nonempty(value)) throw new Error(`${field} must be a nonempty string`);
    } else if (key === 'reasoningEffort') {
      if (!['low', 'medium', 'high'].includes(value)) throw new Error(`${field} must be low, medium or high`);
    } else if (key === 'permissionMode') {
      if (!['safe', 'autopilot'].includes(value)) throw new Error(`${field} must be safe or autopilot`);
    } else if (key === 'env') {
      if (!object(value)) throw new Error(`${field} must be an object of NAME: "value" strings`);
      for (const [name, entry] of Object.entries(value)) {
        const problem = envProblem(name, entry);
        if (problem) throw new Error(`${field}.${name} ${problem}`);
      }
    } else if (key === 'permissions') {
      if (!object(value)) throw new Error(`${field} must be an object with allow and/or deny rule lists`);
      for (const [effect, rules] of Object.entries(value)) {
        if (!['allow', 'deny'].includes(effect)) throw new Error(`${field}.${effect} is an unknown permissions list (use allow or deny)`);
        if (!Array.isArray(rules)) throw new Error(`${field}.${effect} must be an array of rules`);
        rules.forEach((rule, index) => {
          if (!nonempty(rule) || !PERMISSION_RULE.test(rule)) throw new Error(`${field}.${effect}[${index}] must be a Tool or Tool(pattern) rule`);
          if (rules.indexOf(rule) !== index) throw new Error(`${field}.${effect}[${index}] duplicates ${JSON.stringify(rule)}`);
        });
      }
    } else throw new Error(`${field} is an unknown harness setting`);
  }
}

// Skill directory names: the Agent Skills name grammar, bounded at 64.
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
const skillName = (value) => typeof value === 'string' && value.length <= SKILL_NAME_MAX && SKILL_NAME.test(value);

// A soul switches a skill off without deleting it (GeniusBar#64): the
// `skills/<name>/` directory stays in the package and only the rendering
// stops. A name no directory matches is allowed, so the declaration can
// precede the skill; `soul profile` reports it.
export function validateSkillsDeclaration(skills) {
  if (!object(skills)) throw new Error('soul.json skills must be an object');
  for (const key of Object.keys(skills)) {
    if (key !== 'disabled') throw new Error(`soul.json skills.${key} is an unknown skills setting`);
  }
  const disabled = skills.disabled;
  if (!Array.isArray(disabled) || disabled.some((name) => !skillName(name)) || new Set(disabled).size !== disabled.length) {
    throw new Error('soul.json skills.disabled must be an array of unique skill names');
  }
  return skills;
}

export function validateAppearanceDeclaration(appearance) {
  if (!object(appearance)) throw new Error('soul.json appearance must be an object');
  for (const key of Object.keys(appearance)) {
    if (key !== 'hue') throw new Error(`soul.json appearance.${key} is an unknown appearance setting`);
  }
  if (!Number.isInteger(appearance.hue) || appearance.hue < 0 || appearance.hue > 359) {
    throw new Error('soul.json appearance.hue must be an integer from 0 to 359');
  }
  return appearance;
}

function validateManifest(manifest) {
  if (!object(manifest)) throw new Error('soul.json must be an object');
  if (![1, 2].includes(manifest.formatVersion)) throw new Error('unsupported soul.json formatVersion (expected 1 or 2)');
  if (manifest.formatVersion === 2 && !isSupportedIgnoreList(manifest.ignore)) {
    throw new Error('soul.json formatVersion 2 requires the exact supported ignore list');
  }
  for (const key of ['name', 'description', 'displaySeed']) {
    if (!nonempty(manifest[key])) throw new Error(`soul.json ${key} must be a nonempty string`);
  }
  if (!Array.isArray(manifest.preferredHarnesses) || manifest.preferredHarnesses.some((h) => !nonempty(h)) ||
      new Set(manifest.preferredHarnesses).size !== manifest.preferredHarnesses.length) {
    throw new Error('soul.json preferredHarnesses must be an array of unique nonempty strings');
  }
  // agent-comms is part of every soul; `comms: false` opts a soul's managed
  // launches out of the teammate tools. Absent means on.
  if (manifest.comms !== undefined && typeof manifest.comms !== 'boolean') throw new Error('soul.json comms must be a boolean');
  if (manifest.credentials !== undefined) validateCredentialsDeclaration(manifest.credentials);
  if (manifest.appearance !== undefined) validateAppearanceDeclaration(manifest.appearance);
  if (manifest.skills !== undefined) validateSkillsDeclaration(manifest.skills);
  if (manifest.runtimes !== undefined) validateRuntimesDeclaration(manifest.runtimes);
  if (manifest.harness !== undefined) validateHarnessSettings(manifest.harness, 'soul.json harness');
  if (manifest.harnesses !== undefined) {
    if (!object(manifest.harnesses)) throw new Error('soul.json harnesses must be an object');
    for (const [name, settings] of Object.entries(manifest.harnesses)) {
      if (!HARNESS_NAMES.includes(name)) throw new Error(`soul.json harnesses.${name} is an unknown harness`);
      validateHarnessSettings(settings, `soul.json harnesses.${name}`, name);
      if (settings.install?.kind === 'uv-tool' && manifest.runtimes?.python === undefined) {
        throw new Error(`soul.json harnesses.${name}.install is a uv tool, which needs runtimes.python`);
      }
    }
  }
  if (typeof manifest.revision !== 'string' || !REVISION.test(manifest.revision)) throw new Error('soul.json revision must be sha256:<64 lowercase hex digits>');
  if (manifest.parentRevision !== null && (typeof manifest.parentRevision !== 'string' || !REVISION.test(manifest.parentRevision))) {
    throw new Error('soul.json parentRevision must be null or sha256:<64 lowercase hex digits>');
  }
}

function utf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} must be UTF-8`); }
}

// A YAML block scalar: the indented lines after a `|` (literal) or `>`
// (folded) header, dedented by the first line's indent, with clip, strip
// (`-`), or keep (`+`) chomping.
function blockScalar(tail, style, chomp) {
  const lines = (tail.match(/^(?:\r?\n(?:[ \t]+[^\r\n]*|[ \t]*(?=\r?\n|$)))*/)?.[0] ?? '').split(/\r?\n/).slice(1);
  const indent = lines.find((line) => line.trim())?.match(/^[ \t]*/)[0].length ?? 0;
  const body = lines.map((line) => line.slice(indent));
  let text = style === '|'
    ? body.join('\n')
    : body.reduce((out, line, i) => {
      if (i === 0) return line;
      if (line === '') return `${out}\n`;
      if (body[i - 1] === '') return `${out}${line}`;
      if (/^[ \t]/.test(line) || /^[ \t]/.test(body[i - 1])) return `${out}\n${line}`;
      return `${out} ${line}`;
    }, '');
  const content = text.replace(/\n*$/, '');
  if (chomp === '-') return content;
  if (chomp === '+') return `${text}\n`;
  return content ? `${content}\n` : '';
}

// Required Agent Skills fields are YAML strings. Other front matter is opaque.
export function skillField(front, key) {
  const matches = [...front.matchAll(new RegExp(`^${key}:[ \\t]*(.*)$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`SKILL.md needs one ${key} field`);
  let value = matches[0][1].trim();
  const block = value.match(/^([>|])([-+]?)[1-9]?([-+]?)(?:[ \t]+#.*)?$/);
  let quoted;
  if (block) {
    value = blockScalar(front.slice(matches[0].index + matches[0][0].length), block[1], block[2] || block[3]);
  } else if ((quoted = value.match(/^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?$/))) {
    try { value = JSON.parse(quoted[1]); } catch { throw new Error(`invalid quoted skill ${key}`); }
  } else if ((quoted = value.match(/^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/))) {
    value = quoted[1].replaceAll("''", "'");
  } else if (/^["']/.test(value)) {
    throw new Error(`invalid quoted skill ${key}`);
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
    if (/^(?:null|true|false|~|[\d.+-]+)$/i.test(value) || /^[\[\]{}&*!]/.test(value)) throw new Error(`skill ${key} must be a string`);
  }
  if (!nonempty(value)) throw new Error(`skill ${key} must be a nonempty string`);
  return value;
}

function validateSkill(bytes, directory) {
  const text = utf8(bytes, 'SKILL.md');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!front) throw new Error(`${directory}/SKILL.md needs YAML front matter`);
  const name = skillField(front, 'name');
  if (!skillName(name) || name !== directory) {
    throw new Error(`skill name must match directory ${directory} and use lowercase letters, digits and single hyphens (1–64 characters)`);
  }
  if (skillField(front, 'description').length > 1024) throw new Error('skill description exceeds 1024 characters');
}

export function readSoulPackageEntries(packagePath, { expectedGeneratedFiles: buildExpected = expectedGeneratedFiles } = {}) {
  const root = resolve(packagePath);
  if (!lstatSync(root).isDirectory()) throw new Error('package must be a directory, not a symlink or archive');
  const manifestPath = join(root, 'soul.json');
  if (!existsSync(manifestPath)) throw new Error('missing required file: soul.json');
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink()) throw new Error('unsupported package entry: soul.json');
  if (!manifestStat.isFile()) throw new Error('missing required file: soul.json');
  const manifest = JSON.parse(utf8(readFileSync(manifestPath), 'soul.json'));
  validateManifest(manifest);
  // Inventory consumers must reject nonfinite JSON numbers before copying.
  canonicalJson(manifest);
  const ignoresState = manifest.formatVersion === 2;
  const entries = [];
  const names = new Set();
  function walk(directory, prefix = '', expected = new Map()) {
    let skipped = false;
    for (const rawName of readdirSync(directory, { encoding: 'buffer' })) {
      const name = utf8(rawName, 'path');
      if (/[\\\x00-\x1f\x7f]/.test(name)) throw new Error('package paths cannot contain backslashes or control characters');
      const path = `${prefix}${name.normalize('NFC')}`;
      if (names.has(path)) throw new Error(`normalized path collision: ${path}`);
      names.add(path);
      // Do not stat or descend into working state: it can contain links/FIFOs.
      if (ignoresState && PACKAGE_IGNORE_LIST.directories.includes(`${path}/`)) continue;
      const physical = join(directory, name);
      const stat = lstatSync(physical);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`unsupported package entry: ${path}`);
      if (stat.isDirectory()) {
        const index = entries.length;
        entries.push({ path, mode: '040000', bytes: Buffer.alloc(0) });
        const omitted = walk(physical, `${path}/`, expected);
        // Generated-only container directories must not change the revision.
        // Preserve genuinely empty directories and containers of authored files.
        if (omitted && entries.length === index + 1) entries.splice(index, 1);
        skipped ||= omitted;
      } else {
        const bytes = readFileSync(physical);
        if (ignoresState && isGeneratedPath(path) && expected.get(path)?.equals(bytes)) {
          skipped = true;
          continue;
        }
        entries.push({ path, mode: stat.mode & 0o111 ? '100755' : '100644', bytes });
      }
    }
    return skipped;
  }
  walk(root);
  if (ignoresState) {
    // Derive expected output from source content before filtering candidates.
    // Exclude generated containers too, so existing output cannot feed its build.
    const packageEntries = entries.filter((entry) => !isGeneratedPath(entry.path) &&
      !(entry.mode === '040000' && isGeneratedPath(`${entry.path}/`)));
    packageEntries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const expected = buildExpected(packageEntries);
    entries.length = 0;
    names.clear();
    walk(root, '', expected);
  }
  const files = new Map(entries.filter((entry) => entry.mode !== '040000').map((entry) => [entry.path, entry]));
  for (const required of ['soul.json', 'AGENTS.md']) if (!files.has(required)) throw new Error(`missing required file: ${required}`);
  utf8(files.get('AGENTS.md').bytes, 'AGENTS.md');
  const skills = entries.find((entry) => entry.path === 'skills');
  if (skills && skills.mode !== '040000') throw new Error('skills must be a directory');
  for (const entry of entries.filter((entry) => /^skills\/[^/]+$/.test(entry.path) && entry.mode === '040000')) {
    const skill = files.get(`${entry.path}/SKILL.md`);
    if (!skill) throw new Error(`missing required file: ${entry.path}/SKILL.md`);
    validateSkill(skill.bytes, entry.path.slice('skills/'.length));
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { manifest, entries };
}

// Netstrings make every boundary unambiguous, including arbitrary binary files.
function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes, Buffer.from(',')]);
}

// `options.manifest` hashes the package as if soul.json held that manifest,
// so an edit can be hashed before it is published.
export function canonicalPackageBytes(packagePath, options) {
  const read = readSoulPackageEntries(packagePath, options);
  const { entries } = read;
  const manifest = options?.manifest ?? read.manifest;
  const { revision, parentRevision, ...content } = manifest;
  entries.find((entry) => entry.path === 'soul.json').bytes = Buffer.from(canonicalJson(content));
  return Buffer.concat([
    Buffer.from(`agent-bot-soul-package-v${manifest.formatVersion}\0`), frame(manifest.parentRevision ?? ''),
    ...entries.flatMap(({ path, mode, bytes }) => [frame(path), frame(mode), frame(bytes)]),
  ]);
}

export function computePackageRevision(packagePath, options) {
  return `sha256:${createHash('sha256').update(canonicalPackageBytes(packagePath, options)).digest('hex')}`;
}

// A soul directory's comms setting from its soul.json: false only when the
// manifest says so, true otherwise, null when there is no readable manifest.
export function soulCommsSetting(directory) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(directory, 'soul.json'), 'utf8')); }
  catch { return null; }
  if (!object(manifest)) return null;
  return manifest.comms !== false;
}

// Rewrites a soul directory's soul.json `comms` (absent means on, so `true`
// removes the key) as an edit of its current revision: the old revision
// becomes the parent and the revision is recomputed. The final manifest is
// hashed off-path and published with one atomic rename. Returns null when
// the setting already holds, else the previous manifest text to restore on
// a later failure.
export function writeSoulComms(directory, comms) {
  if (typeof comms !== 'boolean') throw new Error('comms must be a boolean');
  const file = join(directory, 'soul.json');
  const before = readFileSync(file, 'utf8');
  const manifest = JSON.parse(before);
  if (!object(manifest)) throw new Error('soul.json must be an object');
  if ((manifest.comms !== false) === comms) return null;
  const { comms: _previous, ...rest } = manifest;
  publishManifestEdit(directory, file, { ...rest, ...(comms ? {} : { comms: false }), parentRevision: manifest.revision ?? null });
  return before;
}

function publishManifestEdit(directory, file, next) {
  const final = { ...next, revision: computePackageRevision(directory, { manifest: next }) };
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(final, null, 2)}\n`, { flag: 'wx', mode: statSync(file).mode & 0o777 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// A soul directory's credentials.github declaration, or null (#383).
export function soulCredentialsDeclaration(directory) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(directory, 'soul.json'), 'utf8')); }
  catch { return null; }
  if (!object(manifest) || manifest.credentials === undefined) return null;
  return validateCredentialsDeclaration(manifest.credentials).github ?? null;
}

// Declares where a soul's GitHub App credential lives, as an edit of its
// current revision (see writeSoulComms). Returns null when it already holds,
// else the previous manifest text to restore on a later failure.
export function writeSoulCredentialsDeclaration(directory, github) {
  validateCredentialsDeclaration({ github });
  const file = join(directory, 'soul.json');
  const before = readFileSync(file, 'utf8');
  const manifest = JSON.parse(before);
  if (!object(manifest)) throw new Error('soul.json must be an object');
  const credentials = { ...(manifest.credentials ?? {}), github: { app: github.app, ...(github.store ? { store: github.store } : {}) } };
  if (canonicalJson(credentials) === canonicalJson(manifest.credentials ?? null)) return null;
  publishManifestEdit(directory, file, { ...manifest, credentials, parentRevision: manifest.revision ?? null });
  return before;
}

export function validateSoulPackage(packagePath) {
  const { manifest } = readSoulPackageEntries(packagePath);
  const revision = computePackageRevision(packagePath);
  if (revision !== manifest.revision) throw new Error(`revision mismatch: expected ${revision}, found ${manifest.revision}`);
  return { formatVersion: manifest.formatVersion, revision, parentRevision: manifest.parentRevision };
}

function main(args) {
  if (args.length !== 2 || args[0] !== 'validate' || args[1].startsWith('-')) throw new Error('usage: agent-bot soul pack validate PATH');
  process.stdout.write(`${JSON.stringify(validateSoulPackage(args[1]))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`agent-bot soul pack: ${error.message}\n`); process.exitCode = 1; }
}
