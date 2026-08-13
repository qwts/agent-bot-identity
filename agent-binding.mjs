#!/usr/bin/env node

// Worktree bind tokens and live connection bindings (#94).
//
// setup-worktree mints a single-use bind token into the worktree's private
// git dir. The token is a claim of PLACE — "this process runs inside a
// configured bot worktree" — and confers nothing until it is surrendered to
// the daemon, which verifies it against the file on disk, consumes it, and
// exchanges it for a server-held binding. From then on identity is a property
// of the connection: callers present the binding secret, never an Agent ID,
// so no caller can assert another agent's identity in a request payload.
//
// An unvalidated token is inert by design. There is no no-MCP fallback: a
// worktree whose token is never surrendered simply has no live binding, which
// fails closed instead of silently acquiring authority.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { validateAgentId } from './agent-identity.mjs';

const SCHEMA_VERSION = 1;
const TOKEN_FILE = 'agent-bind-token.json';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
// A workstation runs a handful of concurrent conversations, not thousands; a
// hard cap keeps a misbehaving client from growing daemon memory unbounded.
const MAX_LIVE_BINDINGS = 256;
// Bindings whose connection never said goodbye (a killed harness can't call
// release) idle out instead of counting against the cap forever. Idleness,
// not age: every successful resolve refreshes the clock, so a conversation
// that keeps calling bound tools stays bound however long it runs — only a
// binding nothing has touched for a day is treated as abandoned.
const MAX_BINDING_IDLE_MS = 24 * 60 * 60 * 1000;

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

// Live bindings are held only in daemon memory, mirroring the per-start
// bearer token: a daemon restart drops every binding, and re-binding takes a
// fresh mint from the same worktree. Nothing reusable is ever written down.
export function createBindingRegistry({ now = () => new Date() } = {}) {
  // Each entry wraps the binding with its idle clock; lastSeenAt never leaves
  // this map, so callers see the binding record exactly as bound.
  const bindings = new Map();
  function evictIdle() {
    const cutoff = now().getTime() - MAX_BINDING_IDLE_MS;
    for (const [secret, entry] of bindings) {
      if (entry.lastSeenAt <= cutoff) bindings.delete(secret);
    }
  }
  return {
    bind({ agentId, worktree, transcript = null, harness = null }) {
      // The cap must count live conversations, not lifetime binds: sweep
      // abandoned bindings before deciding the registry is full.
      evictIdle();
      if (bindings.size >= MAX_LIVE_BINDINGS) {
        throw fail('too many live bindings', 429);
      }
      const secret = randomBytes(32).toString('hex');
      bindings.set(secret, {
        lastSeenAt: now().getTime(),
        binding: {
          agentId: validateAgentId(agentId),
          worktree,
          transcript,
          harness,
          boundAt: now().toISOString(),
        },
      });
      return secret;
    },
    // Constant-shape lookup: compare against every live secret with a
    // timing-safe primitive instead of keying a hash lookup on the secret.
    resolve(secret) {
      evictIdle();
      let found = null;
      for (const [candidate, entry] of bindings) {
        if (tokensMatch(candidate, secret)) found = entry;
      }
      if (!found) return null;
      // A resolved binding is a live conversation: refresh its idle clock so
      // only untouched bindings ever expire.
      found.lastSeenAt = now().getTime();
      return found.binding;
    },
    release(secret) {
      for (const candidate of bindings.keys()) {
        if (tokensMatch(candidate, secret)) {
          bindings.delete(candidate);
          return true;
        }
      }
      return false;
    },
    size() {
      return bindings.size;
    },
  };
}
