#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Shared with soul-builder: only exact build output is ignored; the marker is
// informational and cannot authenticate generated content. Prefixes are root-relative.
export const GENERATED_HARNESS_PATHS = Object.freeze([
  '.claude/', '.codex/', '.cursor/', '.opencode/', '.devin/', '.gemini/',
  '.github/copilot-instructions.md', 'CLAUDE.md', 'GEMINI.md',
]);
export const GENERATED_HARNESS_MARKER = '<!-- agent-bot soul-builder: generated -->';
// Format 2's fixed contract. Generated paths are eligible only for exact-byte
// matching against expectedGeneratedFiles, never for marker-based ignoring.
export const PACKAGE_IGNORE_LIST = Object.freeze({
  directories: Object.freeze(['worktrees/', '.soul-state/']),
  generatedPaths: GENERATED_HARNESS_PATHS,
  generatedMarker: GENERATED_HARNESS_MARKER,
});

export function expectedGeneratedFiles(packageEntries) {
  // #342 will derive soul-builder output from package content (AGENTS.md,
  // skills, policy). Until then, nothing at generated paths is ignored.
  return new Map();
}

function isGeneratedPath(path) {
  return GENERATED_HARNESS_PATHS.some((candidate) => candidate.endsWith('/')
    ? path.startsWith(candidate) : path === candidate);
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

function validateManifest(manifest) {
  if (!object(manifest)) throw new Error('soul.json must be an object');
  if (![1, 2].includes(manifest.formatVersion)) throw new Error('unsupported soul.json formatVersion (expected 1 or 2)');
  if (manifest.formatVersion === 2 && canonicalJson(manifest.ignore) !== canonicalJson(PACKAGE_IGNORE_LIST)) {
    throw new Error('soul.json formatVersion 2 requires the exact supported ignore list');
  }
  for (const key of ['name', 'description', 'displaySeed']) {
    if (!nonempty(manifest[key])) throw new Error(`soul.json ${key} must be a nonempty string`);
  }
  if (!Array.isArray(manifest.preferredHarnesses) || manifest.preferredHarnesses.some((h) => !nonempty(h)) ||
      new Set(manifest.preferredHarnesses).size !== manifest.preferredHarnesses.length) {
    throw new Error('soul.json preferredHarnesses must be an array of unique nonempty strings');
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
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name !== directory) {
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

export function canonicalPackageBytes(packagePath, options) {
  const { manifest, entries } = readSoulPackageEntries(packagePath, options);
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
