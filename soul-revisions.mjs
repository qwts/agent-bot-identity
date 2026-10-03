#!/usr/bin/env node

// Local mechanism API: hosts must authenticate user actions before calling the
// user entry points. The CLI uses the owner gate (owner-gate.mjs, #293).
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson, computePackageRevision, readSoulPackageEntries, validateSoulPackage } from './soul-package.mjs';
import { currentAgentId, readAgentIdentity, recordAgentPackageRevision, stateDirectory, validateAgentId, withLock } from './agent-identity.mjs';
import { spacePath } from './agent-space.mjs';
import { assertOwnerAction } from './owner-gate.mjs';

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
  return record;
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
export async function editSoulRevision(id, packagePath, { reason, expectedParent, ...options } = {}) {
  text(reason, 'reason');
  const stored = locked(id, options, (root) => {
    if (expectedParent !== undefined) assertParent(root, expectedParent);
    return snapshot(root, packagePath, requireHead(root).revision);
  });
  await recordAgentPackageRevision(id, stored.packagePath, { ...options,
    appendRevision: createRevisionAppender(stored.packagePath, { ...options, reason }) });
  return revisionHistory(id, options).find((record) => record.revision === stored.revision);
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
      parentRevision: current.revision, author: 'soul', reason, diff, requiresUser,
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
export async function promoteSpaceContent(id, source, destination, { actor = 'soul', reason, resolveSpace = spacePath, ...options } = {}) {
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

export async function revisionCommand(args, { assertSoulTarget = (id) => {
  // The caller must be the bound soul itself; an unbound process is not one.
  if (currentAgentId() !== id) {
    throw new Error('a soul may propose changes only to its own package; bind an Agent ID first');
  }
}, assertUser = (action, { principal }) => assertOwnerAction(action, { principal }),
// The owner's principal credential, when the caller presents one; it is
// passed only to assertUser and never stored.
principal = null, ...options } = {}) {
  const [command, id, ...rest] = args;
  validateAgentId(id);
  const arities = { adopt: 2, edit: 2, propose: 2, approve: 2, reject: 2, list: 0, history: 0, promote: 3 };
  if (!(command in arities) || rest.length !== arities[command]) {
    throw new Error('usage: soul revision adopt|edit|propose ID PATH REASON; approve|reject ID PROPOSAL REASON; list|history ID; promote ID SOURCE DESTINATION REASON; adopt, edit, approve and reject take --principal-stdin');
  }
  if (['adopt', 'edit', 'approve', 'reject'].includes(command)) {
    const authorization = await assertUser(`soul revision ${command} ${id}`, { principal });
    if (authorization?.method) options.authorization = authorization;
  }
  if (['propose', 'promote'].includes(command)) await assertSoulTarget(id);
  if (command === 'adopt') return adoptSoulPackage(id, rest[0], { ...options, reason: rest[1] });
  if (command === 'edit') return editSoulRevision(id, rest[0], { ...options, reason: rest[1] });
  if (command === 'propose') return proposeSoulRevision(id, rest[0], { ...options, reason: rest[1] });
  if (command === 'approve' || command === 'reject') return decideSoulProposal(id, rest[0], command, { ...options, reason: rest[1] });
  if (command === 'list') return listSoulProposals(id, options);
  if (command === 'history') return revisionHistory(id, options);
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
    .catch((error) => { process.stderr.write(`agent-bot soul revision: ${error.message}\n`); process.exitCode = 1; });
}
