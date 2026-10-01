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

const SCHEMA_VERSION = 1;
const TOKEN_FILE = 'agent-bind-token.json';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// A workstation runs a handful of concurrent conversations, not thousands; a
// hard cap keeps a misbehaving client from growing daemon memory unbounded.
const MAX_LIVE_BINDINGS = 256;
const MAX_BINDING_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

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

export function createBindingRegistry({ now = () => new Date(), file, account = process.env.USER ?? 'unknown' } = {}) {
  const loaded = file ? readPrivate(file) ?? {} : {};
  if (typeof loaded !== 'object' || Array.isArray(loaded)) throw fail('invalid binding store');
  for (const [key, entry] of Object.entries(loaded)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !entry || typeof entry !== 'object'
      || typeof entry.gitDir !== 'string' || !path.isAbsolute(entry.gitDir)
      || typeof entry.worktree !== 'string' || !path.isAbsolute(entry.worktree)
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
    if (!entry.gitDir) return;
    try {
      const existing = readBinding({ env: {}, gitDir: entry.gitDir });
      if (existing && hash(existing.secret) === key) {
        assertPrivateGitDir(entry.gitDir, entry.worktree);
        rmSync(path.join(entry.gitDir, 'agent-binding.json'), { force: true });
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
  return {
    rewrite(url) {
      daemon = url;
      expire();
      // Runs at daemon startup: one bad worktree must not stop the daemon,
      // so a binding whose file is gone, foreign, or moved is pruned.
      for (const [key, entry] of bindings) {
        try {
          const existing = readBinding({ env: {}, gitDir: entry.gitDir });
          if (!existing || hash(existing.secret) !== key) { bindings.delete(key); continue; }
          assertPrivateGitDir(entry.gitDir, entry.worktree);
          atomicWrite(path.join(entry.gitDir, 'agent-binding.json'), { ...existing, daemon });
        } catch {
          bindings.delete(key);
        }
      }
      save();
    },
    bind({ agentId, worktree, gitDir, parent = null, app = null, transcript = null, harness = null }) {
      expire();
      if (bindings.size >= MAX_LIVE_BINDINGS) throw fail('too many live bindings', 429);
      const secret = randomBytes(32).toString('base64url');
      const createdAt = now().toISOString();
      const entry = { agentId: validateAgentId(agentId), parent, gitDir, app, worktree, transcript, harness, createdAt, lastUsedAt: createdAt, boundAt: createdAt };
      if (file && (!gitDir || !path.isAbsolute(gitDir) || !daemon)) throw fail('binding requires a private git dir and daemon URL');
      if (file) assertPrivateGitDir(gitDir, worktree);
      bindings.set(hash(secret), entry);
      save();
      if (gitDir) atomicWrite(path.join(gitDir, 'agent-binding.json'), { v: 1, agentId, parent, account, daemon, secret });
      return secret;
    },
    resolve(secret) {
      expire();
      if (typeof secret !== 'string') return null;
      const entry = bindings.get(hash(secret));
      if (!entry) return null;
      // Idle expiry is measured in days, so persisting the clock about once a
      // minute is enough and spares a disk write on every request.
      const previous = Date.parse(entry.lastUsedAt);
      entry.lastUsedAt = now().toISOString();
      if (now().getTime() - previous >= 60_000) save();
      return { ...entry };
    },
    release(secret) {
      if (typeof secret !== 'string') return false;
      const key = hash(secret);
      const entry = bindings.get(key);
      if (!entry) return false;
      remove(key, entry);
      save();
      return true;
    },
    size() { return bindings.size; },
  };
}

export async function revokeBinding({ env = process.env, cwd = process.cwd(), fetchImpl = fetch } = {}) {
  const binding = readBinding({ env, cwd });
  if (!binding) throw new Error('no binding exists');
  const response = await fetchImpl(`${binding.daemon}/v0/binding`, {
    method: 'DELETE', headers: { 'x-agent-binding': binding.secret }, signal: AbortSignal.timeout(5000),
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
