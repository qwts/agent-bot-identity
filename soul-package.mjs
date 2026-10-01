#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  if (manifest.formatVersion !== 1) throw new Error('unsupported soul.json formatVersion (expected 1)');
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

// Required Agent Skills fields are YAML strings. Other front matter is opaque.
function skillField(front, key) {
  const matches = [...front.matchAll(new RegExp(`^${key}:[ \\t]*(.*)$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`SKILL.md needs one ${key} field`);
  let value = matches[0][1].trim();
  if (/^[>|][-+]?$/.test(value)) {
    const tail = front.slice(matches[0].index + matches[0][0].length);
    value = (tail.match(/^(?:\r?\n(?:[ \t]+[^\n]*|(?=\r?\n)))*/)?.[0] ?? '').trim();
  } else if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { throw new Error(`invalid quoted skill ${key}`); }
  } else if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error(`invalid quoted skill ${key}`);
    value = value.slice(1, -1).replaceAll("''", "'");
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

function inspectPackage(packagePath) {
  const root = resolve(packagePath);
  if (!lstatSync(root).isDirectory()) throw new Error('package must be a directory, not a symlink or archive');
  const entries = [];
  const names = new Set();
  function walk(directory, prefix = '') {
    for (const rawName of readdirSync(directory, { encoding: 'buffer' })) {
      const name = utf8(rawName, 'path');
      if (/[\\\x00-\x1f\x7f]/.test(name)) throw new Error('package paths cannot contain backslashes or control characters');
      const path = `${prefix}${name.normalize('NFC')}`;
      if (names.has(path)) throw new Error(`normalized path collision: ${path}`);
      names.add(path);
      const physical = join(directory, name);
      const stat = lstatSync(physical);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`unsupported package entry: ${path}`);
      if (stat.isDirectory()) {
        entries.push({ path, mode: '040000', bytes: Buffer.alloc(0) });
        walk(physical, `${path}/`);
      } else {
        entries.push({ path, mode: stat.mode & 0o111 ? '100755' : '100644', bytes: readFileSync(physical) });
      }
    }
  }
  walk(root);
  const files = new Map(entries.filter((entry) => entry.mode !== '040000').map((entry) => [entry.path, entry]));
  for (const required of ['soul.json', 'AGENTS.md']) if (!files.has(required)) throw new Error(`missing required file: ${required}`);
  const manifest = JSON.parse(utf8(files.get('soul.json').bytes, 'soul.json'));
  validateManifest(manifest);
  utf8(files.get('AGENTS.md').bytes, 'AGENTS.md');
  const skills = entries.find((entry) => entry.path === 'skills');
  if (skills && skills.mode !== '040000') throw new Error('skills must be a directory');
  for (const entry of entries.filter((entry) => /^skills\/[^/]+$/.test(entry.path) && entry.mode === '040000')) {
    const skill = files.get(`${entry.path}/SKILL.md`);
    if (!skill) throw new Error(`missing required file: ${entry.path}/SKILL.md`);
    validateSkill(skill.bytes, entry.path.slice('skills/'.length));
  }
  const { revision, parentRevision, ...content } = manifest;
  files.get('soul.json').bytes = Buffer.from(canonicalJson(content));
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { manifest, entries };
}

// Netstrings make every boundary unambiguous, including arbitrary binary files.
function frame(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes, Buffer.from(',')]);
}

export function canonicalPackageBytes(packagePath) {
  const { manifest, entries } = inspectPackage(packagePath);
  return Buffer.concat([
    Buffer.from('agent-bot-soul-package-v1\0'), frame(manifest.parentRevision ?? ''),
    ...entries.flatMap(({ path, mode, bytes }) => [frame(path), frame(mode), frame(bytes)]),
  ]);
}

export function computePackageRevision(packagePath) {
  return `sha256:${createHash('sha256').update(canonicalPackageBytes(packagePath)).digest('hex')}`;
}

export function validateSoulPackage(packagePath) {
  const { manifest } = inspectPackage(packagePath);
  const revision = computePackageRevision(packagePath);
  if (revision !== manifest.revision) throw new Error(`revision mismatch: expected ${revision}, found ${manifest.revision}`);
  return { formatVersion: 1, revision, parentRevision: manifest.parentRevision };
}

function main(args) {
  if (args.length !== 2 || args[0] !== 'validate' || args[1].startsWith('-')) throw new Error('usage: agent-bot soul pack validate PATH');
  process.stdout.write(`${JSON.stringify(validateSoulPackage(args[1]))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`agent-bot soul pack: ${error.message}\n`); process.exitCode = 1; }
}
