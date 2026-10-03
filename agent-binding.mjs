#!/usr/bin/env node

// Single-use worktree proof becomes a durable, shared soul binding. Only the
// private git dir holds the secret; the daemon registry persists its hash.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, openSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { validateAgentId } from './agent-identity.mjs';
import { PROOF_HEADER, PROOF_WINDOW_MS, bindingKeyId, checkBindingProof, parseBindingProof, signBindingProof } from './binding-proof.mjs';

const SCHEMA_VERSION = 1;
const TOKEN_FILE = 'agent-bind-token.json';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// A workstation runs a handful of concurrent conversations, not thousands; a
// hard cap keeps a misbehaving client from growing daemon memory unbounded.
const MAX_LIVE_BINDINGS = 256;
const MAX_BINDING_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
// Nonces live for two proof windows; a full cache refuses rather than grows.
const MAX_SEEN_NONCES = 10_000;

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function bindTokenPath(gitDir) {
  if (typeof gitDir !== 'string' || !path.isAbsolute(gitDir)) {
    throw fail('gitDir must be an absolute path');
  }
  return path.join(gitDir, TOKEN_FILE);
}

// Minting is cheap, local, and deliberately unrecorded anywhere else: a token
// that is never surrendered never registers anything. Re-minting on a later
// checkout replaces the file — a fresh proof of place, not a fresh identity.
export function mintBindToken({ gitDir, worktree, agentId, now = () => new Date() }) {
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) {
    throw fail('worktree must be an absolute path');
  }
  const record = {
    schemaVersion: SCHEMA_VERSION,
    token: randomBytes(32).toString('hex'),
    agentId: validateAgentId(agentId),
    worktree,
    mintedAt: now().toISOString(),
  };
  writeFileSync(bindTokenPath(gitDir), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return record;
}

export function readBindToken(gitDir) {
  let raw;
  try {
    raw = readFileSync(bindTokenPath(gitDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('bind token could not be read', 409);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Parser messages may quote file contents; never reflect them.
    throw fail('bind token file is not valid JSON', 409);
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schemaVersion !== SCHEMA_VERSION
    || typeof parsed.token !== 'string' || !TOKEN_PATTERN.test(parsed.token)
    || typeof parsed.worktree !== 'string' || !path.isAbsolute(parsed.worktree)
    || typeof parsed.mintedAt !== 'string'
  ) {
    throw fail('bind token file has an unsupported shape', 409);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    token: parsed.token,
    agentId: validateAgentId(parsed.agentId),
    worktree: parsed.worktree,
    mintedAt: parsed.mintedAt,
  };
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented ?? '', 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

// Surrender: the presented token must match the file the worktree holds, and
// the exchange removes the file. Presenting a token proves the caller could
// read the worktree's private git dir; verifying against the file proves the
// claim describes THIS worktree rather than one the token was lifted from;
// deletion makes replay structurally impossible — after a successful consume
// there is no token in existence to steal.
export function consumeBindToken({ gitDir, token }) {
  const record = readBindToken(gitDir);
  if (!record) throw fail('no bind token is minted for this worktree', 403);
  if (typeof token !== 'string' || !tokensMatch(record.token, token)) {
    throw fail('presented bind token does not match the minted token', 403);
  }
  rmSync(bindTokenPath(gitDir), { force: true });
  return record;
}

// The shared reader refuses symlinks, foreign owners, and permissive modes.
function readPrivate(file, uid = process.getuid()) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
      throw fail('untrusted binding file', 409);
    }
    try { return JSON.parse(readFileSync(fd, 'utf8')); }
    catch { throw fail('invalid binding JSON', 409); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('untrusted or unreadable binding file', 409);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function assertPrivateGitDir(gitDir, worktree) {
  if (typeof gitDir !== 'string' || !path.isAbsolute(gitDir)) throw fail('invalid private git dir');
  let actual;
  try {
    actual = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: worktree, env: { PATH: process.env.PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (realpathSync(actual) === realpathSync(gitDir)) return;
  } catch {}
  throw fail('binding path is not the worktree private git dir');
}

function atomicWrite(file, value) {
  const temp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

export function readBinding({ env = process.env, cwd = process.cwd(), gitDir, uid = process.getuid() } = {}) {
  let file = env.AGENT_BOT_BINDING;
  if (!file) {
    if (!gitDir) {
      try { gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { return null; }
    }
    file = path.join(gitDir, 'agent-binding.json');
  }
  const binding = readPrivate(file, uid);
  if (!binding) return null;
  let url;
  try { url = new URL(binding.daemon); } catch { throw fail('invalid binding daemon URL'); }
  if (binding.v !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(binding.secret ?? '')
    || typeof binding.account !== 'string' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw fail('unsupported binding shape');
  }
  validateAgentId(binding.agentId);
  if (binding.parent !== null) validateAgentId(binding.parent);
  return binding;
}

const hash = (secret) => createHash('sha256').update(secret).digest('hex');

export function childBindingPath(gitDir, agentId) {
  return path.join(gitDir, 'agent-bindings', `${validateAgentId(agentId)}.json`);
}

function entryPath(entry) {
  if (!entry.spawnedBy) return path.join(entry.gitDir, 'agent-binding.json');
  const directory = path.join(entry.gitDir, 'agent-bindings');
  if (realpathSync(directory) !== path.join(realpathSync(entry.gitDir), 'agent-bindings')) {
    throw fail('child binding directory must not be a symlink');
  }
  return childBindingPath(entry.gitDir, entry.agentId);
}

export function createBindingRegistry({ now = () => new Date(), file, account = process.env.USER ?? 'unknown' } = {}) {
  const loaded = file ? readPrivate(file) ?? {} : {};
  if (typeof loaded !== 'object' || Array.isArray(loaded)) throw fail('invalid binding store');
  for (const [key, entry] of Object.entries(loaded)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !entry || typeof entry !== 'object'
      || typeof entry.gitDir !== 'string' || !path.isAbsolute(entry.gitDir)
      || typeof entry.worktree !== 'string' || !path.isAbsolute(entry.worktree)
      || (entry.spawnedBy !== undefined && !/^[a-f0-9]{64}$/.test(entry.spawnedBy))
      || !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.lastUsedAt))) {
      throw fail('invalid binding store');
    }
    validateAgentId(entry.agentId);
    if (entry.parent !== null) validateAgentId(entry.parent);
  }
  const bindings = new Map(Object.entries(loaded));
  let daemon;
  function save() {
    if (!file || (bindings.size === 0 && !existsSync(file))) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWrite(file, Object.fromEntries(bindings));
  }
  // Removing the registry entry is what revokes; deleting the file is
  // cleanup, so an unreadable file or a moved worktree never blocks it.
  function remove(key, entry) {
    bindings.delete(key);
    for (const [childKey, child] of bindings) {
      if (child.spawnedBy === key) remove(childKey, child);
    }
    if (!entry.gitDir) return;
    try {
      const existing = readBinding({ env: { AGENT_BOT_BINDING: entryPath(entry) } });
      if (existing && hash(existing.secret) === key) {
        assertPrivateGitDir(entry.gitDir, entry.worktree);
        rmSync(entryPath(entry), { force: true });
      }
    } catch { /* left for the owner; the secret no longer authenticates */ }
  }
  function expire() {
    let removed = false;
    for (const [key, entry] of bindings) {
      if (Date.parse(entry.lastUsedAt) <= now().getTime() - MAX_BINDING_IDLE_MS) { remove(key, entry); removed = true; }
    }
    if (removed) save();
  }
  function touch(key) {
    expire();
    const entry = bindings.get(key);
    if (!entry) return null;
    // Idle expiry is measured in days, so persisting the clock about once a
    // minute is enough and spares a disk write on every request.
    const previous = Date.parse(entry.lastUsedAt);
    entry.lastUsedAt = now().toISOString();
    if (now().getTime() - previous >= 60_000) save();
    return { ...entry, bindingHash: key };
  }
  function releaseKey(key) {
    const entry = bindings.get(key);
    if (!entry) return false;
    remove(key, entry);
    save();
    return true;
  }
  // A proof is accepted once: its nonce is remembered for two windows, which
  // outlives the timestamp check on either side of the daemon's clock.
  const seenNonces = new Map();
  // Spent nonces do not survive a restart, so proofs made before this
  // registry existed are refused outright (#270 review).
  const startedAt = now().getTime();
  function keyForProof(header, { method, path: pathname, authority }) {
    const proof = parseBindingProof(header);
    if (!proof || typeof authority !== 'string') return null;
    const at = now().getTime();
    for (const [nonce, until] of seenNonces) if (until <= at) seenNonces.delete(nonce);
    if (seenNonces.has(proof.nonce) || seenNonces.size >= MAX_SEEN_NONCES) return null;
    for (const key of bindings.keys()) {
      const raw = Buffer.from(key, 'hex');
      if (bindingKeyId(raw) !== proof.keyId) continue;
      if (!checkBindingProof(proof, raw, { method, path: pathname, authority, now: at, notBefore: startedAt })) return null;
      seenNonces.set(proof.nonce, at + 2 * PROOF_WINDOW_MS);
      return key;
    }
    return null;
  }
  return {
    rewrite(url) {
      daemon = url;
      expire();
      // Runs at daemon startup: one bad worktree must not stop the daemon,
      // so a binding whose file is gone, foreign, or moved is pruned.
      for (const [key, entry] of bindings) {
        try {
          const existing = readBinding({ env: { AGENT_BOT_BINDING: entryPath(entry) } });
          if (!existing || hash(existing.secret) !== key) { remove(key, entry); continue; }
          assertPrivateGitDir(entry.gitDir, entry.worktree);
          atomicWrite(entryPath(entry), { ...existing, daemon });
        } catch {
          remove(key, entry);
        }
      }
      save();
    },
    bind({ agentId, worktree, gitDir, parent = null, app = null, transcript = null, harness = null, spawnedBy, replacesWorktree = null }) {
      expire();
      if (spawnedBy) {
        const source = bindings.get(spawnedBy);
        if (!source || source.agentId !== parent || source.gitDir !== gitDir || source.worktree !== worktree) throw fail('invalid spawn parent binding', 403);
      }
      if (bindings.size >= MAX_LIVE_BINDINGS) throw fail('too many live bindings', 429);
      const secret = randomBytes(32).toString('base64url');
      const createdAt = now().toISOString();
      const entry = { ...(spawnedBy ? { spawnedBy } : {}), agentId: validateAgentId(agentId), parent, gitDir, app, worktree, transcript, harness, createdAt, lastUsedAt: createdAt, boundAt: createdAt };
      if (file && (!gitDir || !path.isAbsolute(gitDir) || !daemon)) throw fail('binding requires a private git dir and daemon URL');
      if (file) assertPrivateGitDir(gitDir, worktree);
      bindings.set(hash(secret), entry);
      save();
      try {
        if (gitDir) {
          if (spawnedBy) mkdirSync(path.join(gitDir, 'agent-bindings'), { recursive: true, mode: 0o700 });
          atomicWrite(entryPath(entry), { v: 1, agentId, parent, account, daemon, secret });
        }
      } catch (error) {
        bindings.delete(hash(secret));
        save();
        throw error;
      }
      // A home migration replaces only bindings for the old home; other
      // conversations belonging to this soul keep their own bindings.
      if (replacesWorktree && replacesWorktree !== worktree) {
        for (const [key, previous] of bindings) {
          if (previous.agentId === agentId && previous.worktree === replacesWorktree) remove(key, previous);
        }
        save();
      }
      return secret;
    },
    resolve(secret) {
      if (typeof secret !== 'string') return null;
      return touch(hash(secret));
    },
    // A binding proof (#270) names the binding without carrying its secret.
    // `request` is { method, path, authority }: what the proof must cover.
    resolveProof(header, request) {
      const key = keyForProof(header, request);
      return key ? touch(key) : null;
    },
    release(secret) {
      if (typeof secret !== 'string') return false;
      return releaseKey(hash(secret));
    },
    releaseProof(header, request) {
      const key = keyForProof(header, request);
      return key ? releaseKey(key) : false;
    },
    // The cold path (#259) starts a turn for a soul, not for a secret: the
    // most recently used binding names its worktree and the file the turn
    // presents as AGENT_BOT_BINDING.
    findAgent(agentId) {
      expire();
      let found = null;
      for (const entry of bindings.values()) {
        if (entry.agentId !== agentId) continue;
        if (!found || Date.parse(entry.lastUsedAt) >= Date.parse(found.lastUsedAt)) found = entry;
      }
      if (!found) return null;
      try {
        return { agentId, worktree: found.worktree, gitDir: found.gitDir, file: entryPath(found) };
      } catch {
        return null;
      }
    },
    size() { return bindings.size; },
  };
}

function recordedParent(binding) {
  // An explicit null is "this store knows there is no parent". A missing
  // field means this registry does not record parent at all (#253 does).
  if (Object.prototype.hasOwnProperty.call(binding, 'parent')) return binding.parent ?? null;
  if (Object.prototype.hasOwnProperty.call(binding, 'parentId')) return binding.parentId ?? null;
  return null;
}

// Seam for soul vouching (#254). A hit stamps lastUsedAt on the live object resolve() returned.
// Unknown and idle-expired secrets return null — resolve() already evicts
// abandoned in-memory bindings before answering.
export function lookupBinding(registry, secret, { now = () => new Date() } = {}) {
  if (!registry || typeof registry.resolve !== 'function') return null;
  // `secret` is the bare secret from an older client, or { proof, request }.
  const binding = secret && typeof secret === 'object'
    ? (typeof registry.resolveProof === 'function' ? registry.resolveProof(secret.proof, secret.request) : null)
    : registry.resolve(typeof secret === 'string' ? secret : '');
  if (!binding || typeof binding !== 'object') return null;
  const parentIsSet = Object.prototype.hasOwnProperty.call(binding, 'parent')
    || Object.prototype.hasOwnProperty.call(binding, 'parentId');
  const lastUsedAt = now().toISOString();
  binding.lastUsedAt = lastUsedAt;
  return {
    agentId: binding.agentId,
    parent: recordedParent(binding),
    parentIsSet,
    worktree: binding.worktree ?? null,
    transcript: binding.transcript ?? null,
    harness: binding.harness ?? null,
    boundAt: binding.boundAt ?? null,
    lastUsedAt,
  };
}

export async function revokeBinding({ env = process.env, cwd = process.cwd(), fetchImpl = fetch, now = () => new Date() } = {}) {
  const binding = readBinding({ env, cwd });
  if (!binding) throw new Error('no binding exists');
  const target = new URL('/v0/binding', binding.daemon);
  const proof = signBindingProof({ secret: binding.secret, method: 'DELETE', path: target.pathname, authority: target.host, now: now().getTime() });
  const response = await fetchImpl(target.href, {
    method: 'DELETE', headers: { [PROOF_HEADER]: proof }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`binding revoke failed: HTTP ${response.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).join(' ') !== 'revoke') throw new Error('usage: agent-bot binding revoke');
    await revokeBinding();
    process.stdout.write('binding revoked\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }

}
