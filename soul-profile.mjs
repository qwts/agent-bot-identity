#!/usr/bin/env node
// Read-only, deliberately narrower than the package/revision inventory: a
// profile must never walk working state or open a credential store.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { readAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { validateAppearanceDeclaration, validateCredentialsDeclaration, validateSkillsDeclaration } from './soul-package.mjs';
import { listSopDocuments, resolveSop } from './sop.mjs';

const MAX_BYTES = 256 * 1024;
const MAX_FILES = 500;
const HOME_PREFIX = '.soul-state/home/';
const USAGE = 'usage: agent-bot soul profile <agentId|name> [--json] [--file RELATIVE_PATH]';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = (value) => typeof value === 'string' && value.trim() ? value : null;
const cleanLine = (value) => String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length <= 4096 && !/^[A-Za-z]:/.test(relative)
    && !/[\\\x00-\x1f\x7f]/.test(relative)
    && relative.split('/').every((part) => part && part !== '.' && part !== '..');
}

// Negative filter applies even inside allowed skill directories. No token,
// key, auth, credential, environment or runtime containers are inventoried.
function privatePart(part) {
  return /^(?:\.git|node_modules|\.soul-state|worktrees|\.ssh|\.aws|\.env.*)$/i.test(part)
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?|keys?|private|auth|oauth|passwords?|sessions?|history)(?:[._-]|$)/i.test(part)
    || /\.(?:pem|key|p12|pfx|keychain(?:-db)?|db|sqlite(?:3)?)$/i.test(part)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(part);
}

function kindOf(relative) {
  const local = relative.startsWith(HOME_PREFIX) ? relative.slice(HOME_PREFIX.length) : relative;
  if (!safeRelative(local) || local.split('/').some(privatePart)) return null;
  if (['soul.json', 'soul.md', 'SOUL.md'].includes(local)) return 'soul';
  if (local === 'AGENTS.md') return 'context';
  if (['CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'].includes(local)) return 'generated';
  if (local.startsWith('skills/')) return 'skill';
  if (/^\.(?:claude|codex|cursor|opencode|devin|gemini)\/skills\//.test(local)) return 'generated';
  if (/^\.claude\/settings(?:\.[a-zA-Z0-9_-]+)*\.json$/.test(local)
    || /^\.(?:codex|cursor|opencode|devin|gemini)\/[^/]+\.(?:json|toml|yaml|yml)$/.test(local)) return 'harness-settings';
  if (/^\.codex\/[^/]+\.md$/.test(local)) return 'context';
  return null;
}

// Recheck every component for both listing and reads. O_NOFOLLOW also closes
// a final-component replacement race; hardlinks and special files are denied.
function safeStat(root, relative = '') {
  if (relative && !safeRelative(relative)) throw new Error('unsafe path');
  let current = root;
  let stat = lstatSync(current);
  if (!stat.isDirectory()) throw new Error('not a regular directory');
  const parts = relative ? relative.split('/') : [];
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    stat = lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new Error('unsafe path component');
  }
  if (stat.isFile() && stat.nlink !== 1) throw new Error('hardlinked file');
  return stat;
}

function readBytes(root, relative, limit) {
  const stat = safeStat(root, relative);
  if (!stat.isFile()) throw new Error('not a regular file');
  const fd = openSync(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('file changed');
    const bytes = Buffer.alloc(Math.min(opened.size, limit) + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null))) length += count;
    return { bytes: bytes.subarray(0, length), size: opened.size, modifiedAt: opened.mtime.toISOString() };
  } finally { closeSync(fd); }
}

function utf8(bytes, partial = false) {
  if (bytes.includes(0)) throw new Error('binary file');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: partial });
}

function inventory(root, errors) {
  const files = [];
  let visited = 0, truncated = false;
  function add(relative) {
    if (!kindOf(relative)) return;
    if (files.length >= MAX_FILES) { truncated = true; return; }
    try {
      const sample = readBytes(root, relative, 8192);
      let isText = true;
      try { utf8(sample.bytes, sample.size > sample.bytes.length); } catch { isText = false; }
      files.push({ path: relative, kind: kindOf(relative), size: sample.size, modifiedAt: sample.modifiedAt, text: isText });
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ area: 'files', message: `Skipped unreadable or unsafe file: ${relative}` });
    }
  }
  function walk(relative) {
    if (files.length >= MAX_FILES || ++visited > 2000 || relative.split('/').length > 32) { truncated = true; return; }
    try {
      if (!safeStat(root, relative).isDirectory()) return;
      for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (privatePart(entry.name)) continue;
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else add(child);
        if (truncated) break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ area: 'files', message: `Skipped unreadable or unsafe directory: ${relative}` });
    }
  }
  for (const prefix of ['', HOME_PREFIX]) {
    try {
      const dir = prefix ? prefix.slice(0, -1) : '';
      if (safeStat(root, dir).isDirectory()) {
        // Use actual names: on case-insensitive filesystems probing soul.md
        // and SOUL.md separately would list the same file twice.
        for (const file of readdirSync(path.join(root, dir)).sort()) add(prefix + file);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push({ area: 'files', message: 'Instruction directory unavailable or unsafe.' });
    }
    add(`${prefix}.github/copilot-instructions.md`);
    // Walk only skills. Harness roots are inspected one level deep so logs,
    // sessions, caches and unknown subdirectories can never be traversed.
    walk(`${prefix}skills`);
    for (const harness of ['.claude', '.codex', '.cursor', '.opencode', '.devin', '.gemini']) {
      const dir = prefix + harness;
      try {
        if (safeStat(root, dir).isDirectory()) {
          for (const entry of readdirSync(path.join(root, dir)).sort()) add(`${dir}/${entry}`);
          walk(`${dir}/skills`);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') errors.push({ area: 'files', message: `Skipped unreadable or unsafe directory: ${dir}` });
      }
    }
  }
  if (truncated) errors.push({ area: 'files', message: 'File inventory truncated (maximum 500 files, 2000 directories, depth 32).' });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function resolveSoul(id, options) {
  const file = populationFile(options);
  try { return typeof id === 'string' && id.startsWith('agent_') ? showSoul(id, { file }) : showSoulByName(id, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}

function readProfile(id, { env = process.env, home = env.HOME ?? homedir() } = {}) {
  const options = { env, home };
  const soul = resolveSoul(id, options);
  const errors = [];
  const profile = { name: soul.name ?? null, displayName: soul.displayName ?? null, description: null,
    harness: null, package: null, revision: null, template: null, appearance: null, skillsDisabled: [], parentId: soul.parentId ?? null, status: soul.status ?? null };
  const result = { agentId: soul.id, profile, files: [], skills: [], credentials: [], sop: { resolved: null, override: null }, errors };
  try { profile.harness = text(readAgentIdentity(soul.id, { stateDir: stateDirectory(options) }).harness); }
  catch { errors.push({ area: 'profile', message: 'Execution identity unavailable; harness may be unknown.' }); }
  let root;
  try {
    root = soulDirectory(soul.id, { ...options, readOnly: true });
    safeStat(root);
  } catch {
    errors.push({ area: 'files', message: 'Soul directory unavailable or unsafe.' });
    return { result, root: null };
  }
  result.files = inventory(root, errors);
  let manifest = null;
  try {
    const { bytes, size } = readBytes(root, 'soul.json', MAX_BYTES);
    if (size > MAX_BYTES || bytes.length > MAX_BYTES) throw new Error('manifest too large');
    manifest = JSON.parse(utf8(bytes));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid manifest');
    profile.package = root;
    profile.displayName ??= text(manifest.name);
    profile.description = text(manifest.description);
    profile.revision = text(manifest.revision);
    profile.template = typeof manifest.template === 'boolean' ? manifest.template : null;
    // A preferred harness is not proof of the harness actually running.
  } catch { errors.push({ area: 'profile', message: 'Package manifest unavailable or invalid.' }); }
  if (manifest?.appearance !== undefined) {
    try { profile.appearance = { hue: validateAppearanceDeclaration(manifest.appearance).hue }; }
    catch { errors.push({ area: 'profile', message: 'Invalid appearance declaration.' }); }
  }
  if (manifest?.credentials !== undefined) {
    try {
      const declaration = validateCredentialsDeclaration(manifest.credentials).github;
      if (declaration) result.credentials.push({ name: declaration.app, provider: 'github', status: 'declared' });
    } catch { errors.push({ area: 'credentials', message: 'Invalid credential declaration.' }); }
  }
  // The declaration as written, so a UI can round-trip it; an invalid one is
  // reported and switches nothing off. SOP skills are never subject to it.
  if (manifest?.skills !== undefined) {
    try { profile.skillsDisabled = [...validateSkillsDeclaration(manifest.skills).disabled]; }
    catch { errors.push({ area: 'skills', message: 'Invalid skills declaration.' }); }
  }
  const disabled = new Set(profile.skillsDisabled);
  result.skills = result.files.filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.path))
    .map((file) => ({ name: file.path.split('/')[1], source: 'soul', path: file.path, commit: null, enabled: !disabled.has(file.path.split('/')[1]) }));
  for (const name of profile.skillsDisabled) {
    if (!result.skills.some((skill) => skill.name === name)) errors.push({ area: 'skills', message: `skills.disabled names a skill the package does not have: ${name}` });
  }

  // Discover the override independently of remote resolution. Workflows are
  // their relative TOML paths; this does not read or execute their contents.
  let override = false;
  try { override = safeStat(root, 'agent-sop.toml').isFile(); } catch { /* optional */ }
  try { override ||= safeStat(root, 'sop').isDirectory(); } catch { /* optional */ }
  const workflows = [];
  try {
    if (safeStat(root, 'workflows').isDirectory()) {
      for (const entry of readdirSync(path.join(root, 'workflows')).sort()) {
        if (/^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/.test(entry) && safeStat(root, `workflows/${entry}`).isFile()) workflows.push(`workflows/${entry}`);
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') errors.push({ area: 'sop', message: 'Workflow inventory unavailable.' }); }
  if (override || workflows.length) result.sop.override = { path: override ? (safeExists(root, 'agent-sop.toml') ? 'agent-sop.toml' : 'sop') : 'workflows', workflows };
  try {
    const offline = () => { throw new Error('SOP resolution requires online organization pins; unavailable in a read-only profile.'); };
    const report = resolveSop({ ...options, soul: soul.id, soulDirectory: () => root,
      runGit: offline, readOrgText: offline,
      readFile: (file) => {
        const base = file === path.join(root, 'agent-sop.toml') ? root : path.join(home, '.config', 'agent-sop');
        const relative = path.basename(file);
        const { bytes, size } = readBytes(base, relative, MAX_BYTES);
        if (size > MAX_BYTES || bytes.length > MAX_BYTES) throw new Error('SOP configuration too large');
        return utf8(bytes);
      } });
    // Today configured selections need org.json from GitHub; the resolver can
    // answer "none" offline. Do not fabricate pins from a stale docs cache.
    if (report.inEffect) result.sop.resolved = { source: report.repositories.sop.repository, commit: report.repositories.sop.commit };
    const documents = listSopDocuments(report, { ...options, offline: true, runGit: offline });
    for (const doc of documents) {
      const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(doc.path);
      if (!match || doc.path.split('/').some(privatePart)) continue;
      const relative = doc.source === 'soul' ? `sop/${doc.path}` : doc.path;
      if (doc.source === 'soul' && !safeExists(root, relative)) continue;
      result.skills.push({ name: match[1], source: 'sop', path: relative, commit: doc.commit ?? null, enabled: true });
    }
  } catch { errors.push({ area: 'sop', message: 'SOP selection and skills unavailable offline (configuration or organization pins could not be resolved).' }); }
  return { result, root };
}

function safeExists(root, relative) {
  try { return safeStat(root, relative).isFile(); } catch { return false; }
}

export function readSoulProfile(id, options = {}) { return readProfile(id, options).result; }

export function readSoulProfileFile(id, relativePath, { maxBytes = MAX_BYTES, ...options } = {}) {
  const { result, root } = readProfile(id, options);
  const entry = result.files.find((file) => file.path === relativePath);
  if (!root || !safeRelative(relativePath) || !entry) fail('soul-profile-file-denied', 'File is not in the profile inventory.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('maxBytes must be a nonnegative integer');
  const limit = Math.min(maxBytes, MAX_BYTES);
  if (entry.size > limit) fail('soul-profile-file-too-large', 'Profile file exceeds the byte limit (at most 256 KiB).');
  let read;
  try { read = readBytes(root, relativePath, limit); }
  catch { fail('soul-profile-file-denied', 'File is no longer safely readable.'); }
  if (read.size > limit || read.bytes.length > limit) fail('soul-profile-file-too-large', 'Profile file exceeds the byte limit (at most 256 KiB).');
  let contents;
  try { contents = utf8(read.bytes); }
  catch { fail('soul-profile-file-denied', 'Profile file is not UTF-8 text.'); }
  return { agentId: result.agentId, path: relativePath, size: read.bytes.length, contents };
}

export function formatSoulProfile(result) {
  const lines = [`agentId: ${result.agentId}`, ...Object.entries(result.profile).map(([key, value]) => `${key}: ${cleanLine(value && typeof value === 'object' ? JSON.stringify(value) : value)}`),
    '', `files (${result.files.length})`, ...result.files.map((file) => `${cleanLine(file.path)} (${file.kind}, ${file.size} bytes)`),
    '', `skills (${result.skills.length})`, ...result.skills.map((skill) => `${cleanLine(skill.name)} (${skill.source}${skill.enabled ? '' : ', disabled'}) ${cleanLine(skill.path)} commit: ${cleanLine(skill.commit)}`),
    '', `credentials (${result.credentials.length})`, ...result.credentials.map((credential) => `${cleanLine(credential.name)} (${credential.provider}): ${credential.status}`),
    '', 'sop', `resolved: ${result.sop.resolved ? cleanLine(`${result.sop.resolved.source}@${result.sop.resolved.commit}`) : '-'}`,
    `override: ${cleanLine(result.sop.override?.path)}`, ...(result.sop.override?.workflows ?? []).map(cleanLine)];
  if (result.errors.length) lines.push('', 'errors', ...result.errors.map((error) => `${error.area}: ${cleanLine(error.message)}`));
  return `${lines.join('\n')}\n`;
}

export function soulProfileCommand(argv, { write = (value) => process.stdout.write(value), ...options } = {}) {
  let id = null, file = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--file' && file === null && argv[i + 1] && !argv[i + 1].startsWith('--')) file = argv[++i];
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id) throw new Error(USAGE);
  const result = file === null ? readSoulProfile(id, options) : readSoulProfileFile(id, file, options);
  write(json ? `${JSON.stringify(result)}\n` : file === null ? formatSoulProfile(result) : result.contents);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { soulProfileCommand(process.argv.slice(2)); }
  catch (error) {
    const failure = { code: error.code ?? 'soul-profile-failed', message: error.message };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul profile: ${failure.code}: ${failure.message}\n`);
    process.exitCode = 1;
  }
}
