#!/usr/bin/env node

// Local mechanism API: hosts must authenticate user actions before calling the
// user entry points. The CLI uses the owner gate (owner-gate.mjs, #293).
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, rmdirSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, computePackageRevision, readSoulPackageEntries, validateSoulPackage } from './soul-package.mjs';
import { diffPackageSkills, skillsChanged, skillsCommand } from './skill-manifest.mjs';
import { currentAgentId, readAgentIdentity, recordAgentPackageRevision, stateDirectory, validateAgentId, withLock } from './agent-identity.mjs';
import { appendSoulRevision, registeredSoulDir } from './soul-history.mjs';
import { soulSpacePath } from './soul-memory.mjs';
import { assertOwnerAction, consentOwner, ownerCredentialRequired, presenceOrConsent } from './owner-action.mjs';
import { populationFile, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST, classifyPath } from './soul-env-contract.mjs';
import { kindOf } from './soul-profile.mjs';

const ZERO = `sha256:${'0'.repeat(64)}`;
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
// How the owner proved a user action (#293), recorded beside it when known.
const authorized = (options) => (options.authorization ? { authorization: options.authorization } : {});
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
};
function rootFor(id, options) {
  return join(options.stateDir ?? stateDirectory(), 'soul-revisions', validateAgentId(id));
}
function active(id, options) {
  const identity = readAgentIdentity(id, options);
  if (identity.status === 'retired') throw new Error('retired souls cannot change revisions');
  return identity;
}
function events(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => /^\d{10}\.json$/.test(name)).sort().map((name) => json(join(root, name)));
}
function head(root) {
  return events(root).filter((event) => event.kind === 'revision').at(-1) ?? null;
}
function objectPath(root, revision) {
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) throw new Error('invalid revision');
  return join(root, 'objects', revision.slice(7) + '.soul');
}
function storedPackage(root, revision) {
  const file = objectPath(root, revision);
  if (validateSoulPackage(file).revision !== revision) throw new Error('stored revision hash mismatch');
  return file;
}
function locked(id, options, operation) {
  const root = rootFor(id, options);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return withLock(join(root, '.lock'), 'soul revisions', () => {
    active(id, options);
    return operation(root);
  }, { keepLiveOwners: true });
}
function append(root, event, options) {
  const record = { schemaVersion: 1, ...event, at: (options.now ?? (() => new Date()))().toISOString() };
  const temp = join(root, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    // Publish complete JSON exclusively; no partially written journal records.
    linkSync(temp, join(root, `${String(events(root).length).padStart(10, '0')}.json`));
  } finally { rmSync(temp, { force: true }); }
  if (record.kind === 'revision') mirrorRevision(basename(root), record, options);
  return record;
}
// The soul's own copy of a revision entry under `.soul-state/runs/`
// (#583 decision 9), after the journal has it. Best effort: a folder the
// census does not name, or one that cannot be written, changes nothing
// about the revision; the failure goes to stderr (or `options.log`).
function mirrorRevision(id, record, options) {
  const soulDir = options.soulDir ?? registeredSoulDir(id, options);
  if (!soulDir) return;
  try { appendSoulRevision(soulDir, record); }
  catch (error) { (options.log ?? ((line) => process.stderr.write(`${line}\n`)))(`soul revisions: history mirror for ${id} not written (${error.code ?? error.message})`); }
}
function snapshot(root, source, parentRevision, { preserve = false } = {}) {
  // Use the same package inventory as hashing: never copy working state or
  // follow its links. Inputs must be quiescent; verify the snapshot below.
  const { entries } = readSoulPackageEntries(source);
  mkdirSync(join(root, 'objects'), { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(root, '.package-'));
  const tree = join(temp, 'package.soul');
  try {
    mkdirSync(tree);
    for (const { path, mode, bytes } of entries) {
      const file = join(tree, path);
      if (mode === '040000') mkdirSync(file, { recursive: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        chmodSync(file, mode === '100755' ? 0o755 : 0o644);
      }
    }
    const manifest = json(join(tree, 'soul.json'));
    if (!preserve) manifest.parentRevision = parentRevision;
    manifest.revision = ZERO;
    writeFileSync(join(tree, 'soul.json'), JSON.stringify(manifest));
    manifest.revision = computePackageRevision(tree);
    writeFileSync(join(tree, 'soul.json'), JSON.stringify(manifest) + '\n');
    validateSoulPackage(tree);
    const destination = objectPath(root, manifest.revision);
    if (existsSync(destination)) {
      if (validateSoulPackage(destination).revision !== manifest.revision) throw new Error('stored revision is corrupt');
    } else renameSync(tree, destination);
    return { revision: manifest.revision, parentRevision: manifest.parentRevision, packagePath: destination };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
function requireHead(root) {
  const current = head(root);
  if (!current) throw new Error('adopt a starting package before editing or proposing');
  storedPackage(root, current.revision);
  return current;
}
function assertParent(root, parentRevision) {
  if (requireHead(root).revision !== parentRevision) throw new Error('stale proposal or edit: create a new revision from the current head');
}

// The skills a revision added, removed or changed against its parent (#312),
// reported with the edit or proposal that made it; absent when none did.
function skillReport(root, parentRevision, packagePath) {
  const diff = diffPackageSkills(objectPath(root, parentRevision), packagePath);
  return skillsChanged(diff) ? { skills: diff } : {};
}

export function revisionHistory(id, options = {}) {
  return events(rootFor(id, options)).filter((event) => event.kind === 'revision');
}
export function revisionPackagePath(id, revision, options = {}) {
  return storedPackage(rootFor(id, options), revision);
}
export function adoptSoulPackage(id, packagePath, { reason = 'Adopt starting package', ...options } = {}) {
  text(reason, 'reason');
  return locked(id, options, (root) => {
    if (head(root)) throw new Error('soul already has a revision chain');
    const identity = active(id, options);
    const stored = snapshot(root, packagePath, null, { preserve: true });
    if (identity.genesis && stored.revision !== identity.genesis.revision) throw new Error('starting package must match genesis');
    return append(root, { kind: 'revision', revision: stored.revision, parentRevision: stored.parentRevision,
      author: 'user', reason, ...authorized(options) }, options);
  });
}

// Adapter for #284's appendRevision port. The caller supplies the complete
// prepared package; a hash alone is never sufficient to append history.
export function createRevisionAppender(packagePath, { reason, author = 'user', ...options } = {}) {
  text(reason, 'reason');
  if (author !== 'user') throw new Error('soul changes must use proposeSoulRevision');
  return ({ agentId, revision }) => locked(agentId, options, (root) => {
    const validated = validateSoulPackage(packagePath);
    if (validated.revision !== revision) throw new Error('revision changed before append');
    assertParent(root, validated.parentRevision);
    const stored = snapshot(root, packagePath, validated.parentRevision, { preserve: true });
    return append(root, { kind: 'revision', revision: stored.revision,
      parentRevision: stored.parentRevision, author, reason, ...authorized(options) }, options);
  });
}
export async function editSoulRevision(id, packagePath, { reason, expectedParent, apply = false, ...options } = {}) {
  text(reason, 'reason');
  if (apply) return locked(id, options, (root) => {
    if (expectedParent !== undefined) assertParent(root, expectedParent);
    const directory = resolve(soulDirectory(id, { ...options, readOnly: true }));
    assertApplyPath(resolve(packagePath));
    assertApplyPath(directory);
    const stored = snapshot(root, packagePath, requireHead(root).revision);
    // Preflight the entire destination before recording or touching any file.
    const publish = prepareApply(directory, stored, resolve(packagePath) === directory);
    assertParent(root, stored.parentRevision);
    const record = append(root, { kind: 'revision', revision: stored.revision,
      parentRevision: stored.parentRevision, author: 'user', reason, ...authorized(options) }, options);
    // withLock is synchronous: recording and applying must not cross an await.
    if (requireHead(root).revision !== stored.revision) throw new Error('stale apply: recorded head moved');
    return { ...record, applied: true, changed: publish(), ...skillReport(root, stored.parentRevision, stored.packagePath) };
  });
  const stored = locked(id, options, (root) => {
    if (expectedParent !== undefined) assertParent(root, expectedParent);
    return snapshot(root, packagePath, requireHead(root).revision);
  });
  await recordAgentPackageRevision(id, computePackageRevision(stored.packagePath), { ...options,
    appendRevision: createRevisionAppender(stored.packagePath, { ...options, reason }) });
  return { ...revisionHistory(id, options).find((record) => record.revision === stored.revision),
    ...skillReport(rootFor(id, options), stored.parentRevision, stored.packagePath) };
}

function assertApplyPath(file) {
  const parent = dirname(file);
  if (parent !== file) assertApplyPath(parent);
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error('apply cannot follow symlinks');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const workingState = (path) => /^(?:\.soul-state|worktrees)(?:\/|$)/.test(path);

function prepareApply(directory, stored, inPlace) {
  const right = new Map(readSoulPackageEntries(stored.packagePath).entries.map((entry) => [entry.path, entry]));
  if ([...right.keys()].some(workingState)) throw new Error('apply cannot overwrite working state');
  const left = new Map();
  function walk(folder, prefix = '') {
    for (const name of readdirSync(folder)) {
      const path = prefix + name;
      if (workingState(path)) continue; // Do not even stat working-state links.
      const file = join(folder, name), stat = lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`unsupported apply destination entry: ${path}`);
      }
      const mode = stat.isDirectory() ? '040000' : stat.mode & 0o111 ? '100755' : '100644';
      left.set(path, { path, mode, bytes: stat.isDirectory() ? Buffer.alloc(0) : readFileSync(file) });
      if (stat.isDirectory()) walk(file, `${path}/`);
    }
  }
  if (!lstatSync(directory).isDirectory()) throw new Error('apply destination must be a directory');
  walk(directory);
  if (inPlace) {
    // Preserve all current manifest fields; only the revision pointers change.
    const manifest = JSON.parse(left.get('soul.json').bytes);
    right.set('soul.json', { ...left.get('soul.json'), bytes: Buffer.from(JSON.stringify({ ...manifest,
      revision: stored.revision, parentRevision: stored.parentRevision }) + '\n') });
  }
  const changed = (inPlace ? ['soul.json'] : [...new Set([...left.keys(), ...right.keys()])].sort())
    .filter((path) => {
      const before = left.get(path), after = right.get(path);
      return !before || !after || before.mode !== after.mode || !before.bytes.equals(after.bytes);
    });
  return () => {
    // Remove children first, without recursive deletion or following links.
    for (const path of [...changed].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const before = left.get(path), after = right.get(path);
      if (!before || (after && before.mode === after.mode) ||
          (after && before.mode !== '040000' && after.mode !== '040000')) continue;
      const file = join(directory, path);
      assertApplyPath(file);
      if (before.mode === '040000') rmdirSync(file);
      else rmSync(file);
    }
    // Parents precede children; publish the manifest last.
    const writes = changed.filter((path) => path !== 'soul.json').sort();
    if (changed.includes('soul.json')) writes.push('soul.json');
    for (const path of writes) {
      const entry = right.get(path);
      if (!entry) continue;
      const file = join(directory, path);
      assertApplyPath(file);
      if (entry.mode === '040000') { mkdirSync(file, { recursive: true }); continue; }
      const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, entry.bytes, { flag: 'wx', mode: 0o600 });
        chmodSync(temporary, entry.mode === '100755' ? 0o755 : 0o644);
        renameSync(temporary, file);
      } finally { rmSync(temporary, { force: true }); }
    }
    return changed;
  };
}

function inventory(directory) {
  const result = new Map();
  for (const { path, mode, bytes: raw } of readSoulPackageEntries(directory).entries) {
    if (mode === '040000') result.set(path, 'directory');
    else {
      let bytes = raw;
      if (path === 'soul.json') {
        const { revision, parentRevision, ...content } = JSON.parse(bytes);
        bytes = Buffer.from(canonicalJson(content));
      }
      result.set(path, `${mode}:${bytes.toString('base64')}`);
    }
  }
  return result;
}
export function diffSoulPackages(before, after) {
  computePackageRevision(before);
  computePackageRevision(after);
  const left = inventory(before), right = inventory(after);
  return [...new Set([...left.keys(), ...right.keys()])].sort().filter((path) => left.get(path) !== right.get(path))
    .map((path) => ({ path, change: !left.has(path) ? 'added' : !right.has(path) ? 'removed' : 'modified' }));
}
// Portable v1 glob grammar: * and ? match within a component, ** spans
// components. No negation, braces, character classes, or platform semantics.
function glob(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/') ||
      pattern.split('/').some((part) => part === '..' || part === '.') || /[\\\[\]{}!\x00-\x1f]/.test(pattern)) {
    throw new Error('invalid auto path glob');
  }
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
function policyFor(tree) {
  if (!existsSync(join(tree, 'policy.json'))) return { mode: 'ask', paths: [] };
  const policy = json(join(tree, 'policy.json'));
  if (!policy || !['ask', 'auto', 'never'].includes(policy.mode) ||
      (policy.paths !== undefined && !Array.isArray(policy.paths))) throw new Error('invalid revision policy');
  const paths = policy.paths ?? [];
  paths.forEach(glob);
  return { mode: policy.mode, paths };
}
function needsUser(diff) {
  // Unknown tool/MCP formats cannot safely be proven narrower. Treat every
  // change to their configuration (including removals) as user reviewed.
  // Any `mcp` substring counts, so variants like `mcpServers.json` are caught.
  return diff.some(({ path }) => path === 'bin' || path.startsWith('bin/') || path === 'policy.json' || path === 'soul.json' ||
    /(^|[/._-])tools?([/._-]|$)/i.test(path) || /mcp/i.test(path));
}
export function listSoulProposals(id, options = {}) {
  const records = events(rootFor(id, options));
  return records.filter((event) => event.kind === 'proposal').map((proposal) => {
    const decision = records.find((event) => event.kind !== 'proposal' && event.proposalId === proposal.proposalId);
    return { ...proposal, status: decision ? (decision.kind === 'revision' ? 'approved' : 'rejected') : proposal.status,
      ...(decision ? { decision } : {}) };
  });
}
export function proposeSoulRevision(id, packagePath, { reason, expectedParent, ...options } = {}) {
  text(reason, 'reason');
  return locked(id, options, (root) => {
    const current = requireHead(root);
    if (expectedParent !== undefined) assertParent(root, expectedParent);
    const before = objectPath(root, current.revision);
    const policy = policyFor(before);
    const stored = snapshot(root, packagePath, current.revision);
    const diff = diffSoulPackages(before, stored.packagePath);
    const requiresUser = needsUser(diff);
    const proposal = append(root, { kind: 'proposal', proposalId: randomUUID(), revision: stored.revision,
      parentRevision: current.revision, author: 'soul', reason, diff, requiresUser, ...skillReport(root, current.revision, stored.packagePath),
      status: policy.mode === 'never' ? 'rejected' : 'pending' }, options);
    if (policy.mode === 'auto' && !requiresUser && diff.every(({ path }) => policy.paths.some((pattern) => glob(pattern).test(path)))) {
      append(root, { kind: 'revision', revision: stored.revision, parentRevision: current.revision,
        author: 'soul', reason, proposalId: proposal.proposalId, approval: 'auto' }, options);
    }
    return listSoulProposals(id, options).find((item) => item.proposalId === proposal.proposalId);
  });
}
export function decideSoulProposal(id, proposalId, decision, { reason, ...options } = {}) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject');
  text(reason, 'reason');
  return locked(id, options, (root) => {
    const proposal = listSoulProposals(id, options).find((item) => item.proposalId === proposalId);
    if (!proposal || proposal.status !== 'pending') throw new Error('proposal is not pending');
    if (decision === 'reject') return append(root, { kind: 'decision', proposalId, author: 'user', reason, ...authorized(options) }, options);
    assertParent(root, proposal.parentRevision);
    storedPackage(root, proposal.revision);
    return append(root, { kind: 'revision', revision: proposal.revision, parentRevision: proposal.parentRevision,
      author: 'soul', reason: proposal.reason, proposalId, approval: 'user', approvedBy: 'user', approvalReason: reason,
      ...authorized(options) }, options);
  });
}
function safeRelative(value) {
  text(value, 'relative path');
  if (isAbsolute(value) || /[\\\x00-\x1f]/.test(value) || value.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new Error('promotion paths must be relative without traversal');
  }
  return value;
}
function noLinks(root, path) {
  let current = root;
  for (const part of ['', ...path.split('/')]) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('promotion cannot follow symlinks');
  }
}
export async function promoteSpaceContent(id, source, destination, { actor = 'soul', reason, resolveSpace = soulSpacePath, ...options } = {}) {
  safeRelative(source); safeRelative(destination); text(reason, 'reason');
  if (!['user', 'soul'].includes(actor)) throw new Error('promotion actor must be user or soul');
  const root = rootFor(id, options);
  const current = requireHead(root);
  const space = resolve(resolveSpace(id, options));
  noLinks(space, source);
  const input = join(space, source);
  if (!lstatSync(input).isFile()) throw new Error('promotion source must be a regular file');
  const temp = mkdtempSync(join(root, '.promotion-'));
  const tree = join(temp, 'package.soul');
  try {
    cpSync(objectPath(root, current.revision), tree, { recursive: true });
    noLinks(tree, destination);
    mkdirSync(dirname(join(tree, destination)), { recursive: true });
    writeFileSync(join(tree, destination), readFileSync(input));
    chmodSync(join(tree, destination), lstatSync(input).mode & 0o111 ? 0o755 : 0o644);
    const provenance = `${reason} (promoted from Agent Space ${id}/${relative(space, input)})`;
    // Preserve the exact base across the copy; fail if a concurrent edit won.
    if (requireHead(root).revision !== current.revision) throw new Error('stale promotion');
    return actor === 'user' ? await editSoulRevision(id, tree, { ...options, expectedParent: current.revision, reason: provenance })
      : proposeSoulRevision(id, tree, { ...options, expectedParent: current.revision, reason: provenance });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}


const PREPARE_SCHEMA_VERSION = 1;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const STAGING_NAME = /^revision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
// An Agent ID or a census name, as `soul profile` resolves one.
function resolveSoulId(id, options) {
  if (typeof id === 'string' && id.startsWith('agent_')) return validateAgentId(id);
  const file = options.file ?? populationFile(options);
  try { return showSoulByName(id, { file }).id; }
  catch (error) {
    if (/no population record/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}
// The paths a user edit may touch without a review step: everything in the
// definition except the manifest and the soul's tools (ADR-0275 rule 4,
// the always-reviewed set in docs/soul-revisions.md). Generated output is
// the builder's, working state is never staged.
function editable(path, classification) {
  return classification === 'definition' && path !== 'soul.json' && path !== 'bin' && !path.startsWith('bin/');
}
function isText(bytes) {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
// Every file under a generated path in the root, without following links,
// so `excluded.generated` can name the exact build output the package read
// left out (an authored or merged file at a generated path stays staged).
function generatedFiles(root) {
  const files = [];
  function walk(relative) {
    let entries;
    try { entries = readdirSync(join(root, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  for (const candidate of GENERATED_HARNESS_PATHS) {
    if (candidate.endsWith('/')) walk(candidate.slice(0, -1));
    else {
      let info = null;
      try { info = lstatSync(join(root, candidate)); } catch { /* absent */ }
      if (info?.isFile()) files.push(candidate);
    }
  }
  return files;
}

/**
 * Stages the soul's editable definition for a host (#583, GeniusBar #268):
 * the package entries, as `readSoulPackageEntries` reads them (format-2
 * working state and exact generated output excluded, modes kept), copied
 * into `<soulDir>/.soul-state/tmp/revision-<uuid>/`, which the environment
 * contract classifies as temp. Nothing in the soul changes. The host edits
 * there and finishes with `soul revision edit ID <staging> REASON --apply`.
 * A failure removes the staging directory; a leftover is harmless temp.
 */
export function prepareRevisionEdit(id, { dest = null, now = () => new Date(), ...options } = {}) {
  const agentId = resolveSoulId(id, options);
  const directory = resolve(soulDirectory(agentId, { ...options, readOnly: true }));
  let info = null;
  try { info = lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!info?.isDirectory()) fail('soul-dir-missing', `soul directory is not a directory: ${directory}`);
  let staging;
  if (dest === null) {
    // Only an installed soul (one with `.soul-state/`) gets a default
    // staging place; creating `.soul-state/` here would make a marker-less
    // folder look half-provisioned.
    const state = join(directory, '.soul-state');
    let stateInfo = null;
    try { stateInfo = lstatSync(state); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stateInfo?.isDirectory()) fail('soul-state-missing', 'the soul has no .soul-state directory yet; launch it once, or pass --dest');
    mkdirSync(join(state, 'tmp'), { recursive: true, mode: 0o700 });
    staging = join(state, 'tmp', `revision-${randomUUID()}`);
  } else {
    staging = resolve(text(dest, '--dest'));
    mkdirSync(dirname(staging), { recursive: true, mode: 0o700 });
  }
  // Exclusive: never stage into a directory something else owns.
  mkdirSync(staging, { mode: 0o700 });
  try {
    const { manifest, entries } = readSoulPackageEntries(directory);
    const files = [];
    for (const { path, mode, bytes } of entries) {
      const target = join(staging, path);
      if (mode === '040000') { mkdirSync(target, { recursive: true }); continue; }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
      chmodSync(target, mode === '100755' ? 0o755 : 0o644);
      const classification = classifyPath(path);
      files.push({ path, classification, kind: kindOf(path), editable: editable(path, classification),
        text: isText(bytes), size: bytes.length, mode });
    }
    const staged = new Set(files.map((file) => file.path));
    const ignoresState = manifest.formatVersion === 2;
    const excluded = {
      workingState: ignoresState ? PACKAGE_IGNORE_LIST.directories.map((dir) => dir.slice(0, -1))
        .filter((dir) => { try { lstatSync(join(directory, dir)); return true; } catch { return false; } }) : [],
      generated: ignoresState ? generatedFiles(directory).filter((path) => !staged.has(path)) : [],
    };
    return { schemaVersion: PREPARE_SCHEMA_VERSION, agentId, soulDir: directory, staging,
      revision: typeof manifest.revision === 'string' ? manifest.revision : null,
      parentRevision: typeof manifest.parentRevision === 'string' ? manifest.parentRevision : null,
      files, excluded, expiresAt: new Date(now().getTime() + STAGING_TTL_MS).toISOString() };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Removes one staging directory `prepareRevisionEdit` made. Only a
 * `revision-<uuid>` directory directly under a soul's `.soul-state/tmp/`
 * qualifies (the folder's marker proves it is a soul's), so this can never
 * delete a package, a home, or a `--dest` elsewhere.
 */
export function discardRevisionStaging(stagingPath) {
  const staging = resolve(text(stagingPath, 'staging path'));
  const tmp = dirname(staging), state = dirname(tmp), soul = dirname(state);
  let info = null;
  try { info = lstatSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!info) fail('staging-missing', `no staging directory at ${staging}`);
  if (!info.isDirectory() || !STAGING_NAME.test(basename(staging)) || basename(tmp) !== 'tmp'
      || basename(state) !== '.soul-state' || soul === state || !existsSync(join(state, 'agent-id'))) {
    fail('staging-not-temp', `refusing to remove ${staging}: only a revision-<uuid> directory under a soul's .soul-state/tmp/ is staging`);
  }
  rmSync(staging, { recursive: true, force: true });
  return { discarded: staging };
}

export async function revisionCommand(args, { assertSoulTarget = (id) => {
  // The caller must be the bound soul itself; an unbound process is not one.
  if (currentAgentId() !== id) {
    throw new Error('a soul may propose changes only to its own package; bind an Agent ID first');
  }
}, assertUser = (action, { principal }) => assertOwnerAction(action, {
  principal, env: options.env, cwd: options.cwd,
  consent: (action, context) => presenceOrConsent(action, { ...context, presence,
    consent: (action, context) => {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw ownerCredentialRequired('owner consent requires an interactive terminal; --yes cannot approve');
      }
      return consentOwner(action, context);
    },
  }),
}),
// The owner's principal credential, when the caller presents one; it is
// passed only to assertUser and never stored.
principal = null, presence, ...options } = {}) {
  const apply = args.includes('--apply');
  const [command, id, ...rest] = args.filter((arg) => arg !== '--json' && arg !== '--apply');
  const usage = 'usage: soul revision adopt|edit|propose ID PATH REASON; edit accepts --apply; approve|reject ID PROPOSAL REASON; list|history ID; skills ID [REVISION [SINCE]]; promote ID SOURCE DESTINATION REASON; prepare <agentId|name> [--dest PATH] | prepare --discard STAGING; all accept --json; adopt, edit, approve and reject take --principal-stdin';
  // Staging is temp under the soul, so prepare is not an owner action; the
  // apply that follows it is.
  if (command === 'prepare') {
    if (apply) throw new Error(usage);
    const prepareArgs = [id, ...rest].filter((arg) => arg !== undefined);
    if (prepareArgs[0] === '--discard') {
      if (prepareArgs.length !== 2 || prepareArgs[1].startsWith('-')) throw new Error(usage);
      return discardRevisionStaging(prepareArgs[1]);
    }
    let dest = null;
    for (let i = 1; i < prepareArgs.length; i++) {
      if (prepareArgs[i] === '--dest' && dest === null && prepareArgs[i + 1] && !prepareArgs[i + 1].startsWith('-')) dest = prepareArgs[++i];
      else throw new Error(usage);
    }
    if (!prepareArgs[0] || prepareArgs[0].startsWith('-')) throw new Error(usage);
    return prepareRevisionEdit(prepareArgs[0], { ...options, dest });
  }
  validateAgentId(id);
  const arities = { adopt: 2, edit: 2, propose: 2, approve: 2, reject: 2, list: 0, history: 0, promote: 3, skills: [0, 1, 2] };
  if (!(command in arities) || !(Array.isArray(arities[command]) ? arities[command] : [arities[command]]).includes(rest.length) || (apply && command !== 'edit')) {
    throw new Error(usage);
  }
  if (['adopt', 'edit', 'approve', 'reject'].includes(command)) {
    let authorization;
    try { authorization = await assertUser(`soul revision ${command} ${id}`, { principal }); }
    catch (error) {
      const failure = error.code === 'owner-consent-unavailable' ? error : ownerCredentialRequired(error.message);
      appendAuditReceipt({ event: 'soul-revision', agentId: id, operation: command, decision: failure.code }, options);
      throw failure;
    }
    if (authorization?.method) options.authorization = authorization;
  }
  if (['propose', 'promote'].includes(command)) await assertSoulTarget(id);
  if (command === 'adopt') return adoptSoulPackage(id, rest[0], { ...options, reason: rest[1] });
  if (command === 'edit') return editSoulRevision(id, rest[0], { ...options, apply, reason: rest[1] });
  if (command === 'propose') return proposeSoulRevision(id, rest[0], { ...options, reason: rest[1] });
  if (command === 'approve' || command === 'reject') return decideSoulProposal(id, rest[0], command, { ...options, reason: rest[1] });
  if (command === 'list') return listSoulProposals(id, options);
  if (command === 'history') return revisionHistory(id, options);
  if (command === 'skills') return skillsCommand([id, ...rest], options);
  return promoteSpaceContent(id, rest[0], rest[1], { ...options, reason: rest[2] });
}
// `--principal-stdin` reads the owner's principal credential as JSON from
// stdin (never argv, which every local user can read through ps).
function cliArgs(argv) {
  const args = argv.filter((arg) => arg !== '--principal-stdin');
  if (args.length === argv.length) return { args };
  let principal;
  try { principal = JSON.parse(readFileSync(0, 'utf8')); }
  catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  return { args, principal };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => {
    const { args, principal } = cliArgs(process.argv.slice(2));
    return revisionCommand(args, { principal });
  }).then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => { process.stderr.write(`agent-bot soul revision: ${error.code ? `${error.code}: ` : ''}${error.message}\n`); process.exitCode = 1; });
}
