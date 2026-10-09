// The owner's presence through agent-bot-keyd (#416): Touch ID where the
// Mac has it, otherwise the login password, never an administrator account.
//
// keyd, the signed native helper GeniusBar ships (#397), asks the person at
// the Mac with its own LocalAuthentication prompt and, only on approval,
// signs an assertion of the exact action with its presence key:
//
//   p1.<base64url(payload)>.<base64url(Ed25519 signature of the payload segment)>
//   payload: { v: 1, aud: 'agent-bot-owner', kind: 'presence',
//              action: hex(sha256(action)), nonce, iat, exp }
//
// The nonce is ours, so an assertion answers this one request. The key is
// pinned from the code-signed keyd binary (`agent-bot-keyd presence-key`),
// never from the socket: a process in this account can stand up a socket
// that answers anything, but it cannot sign with keyd's key, whose seed only
// keyd's code reads from the Keychain.
//
// `unavailable` (code 'presence-unavailable') means nobody could be asked
// through keyd: no keyd, no Developer ID signature, no GUI session, no login
// password. The owner gate then falls back to its administrator dialog.
// Every other failure is the owner's answer or a bad assertion, and the gate
// refuses without asking again.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ANY_DEVELOPER_ID, DEFAULT_KEYD_IDENTIFIER, DEFAULT_KEYD_TEAM_ID, keydSigner } from './config.mjs';
import { keydPaths, keydRequest, readKeydRecord } from './keyd-client.mjs';

export const PRESENCE_AUDIENCE = 'agent-bot-owner';
export const PRESENCE_UNAVAILABLE_RPC = -32001;
// A person at the Mac may take a while; keyd itself gives up at 120 s.
const OWNER_TIMEOUT_MS = 150_000;
const MAX_LIFETIME_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;
// The code-signing requirement checked before agent-bot runs a keyd binary
// to learn its presence key: a Developer ID Application signature from the
// configured team, on the configured identifier (#594). `keydSigner` in
// config.mjs resolves both; ANY_DEVELOPER_ID drops that part of the check.
export function developerIdRequirement({ teamId = DEFAULT_KEYD_TEAM_ID, identifier = DEFAULT_KEYD_IDENTIFIER } = {}) {
  let requirement = 'anchor apple generic';
  if (identifier !== ANY_DEVELOPER_ID) requirement += ` and identifier "${identifier}"`;
  requirement += ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  if (teamId !== ANY_DEVELOPER_ID) requirement += ` and certificate leaf[subject.OU] = "${teamId}"`;
  return requirement;
}

export const DEVELOPER_ID_REQUIREMENT = developerIdRequirement();

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'presence-unavailable' });
}

function rawKey(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(text)) return null;
  return Buffer.from(text, 'base64').length === 32 ? text : null;
}

// `home` follows the caller's env, so a gate given a scratch HOME stays in it.
export function presencePinPath({ env = process.env, home = env.HOME || homedir() } = {}) {
  return path.join(keydPaths({ env, home }).dir, 'presence.pub');
}

function codesignVerify(bin, requirement) {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, bin],
    { stdio: ['ignore', 'ignore', 'pipe'] });
}

function runPresenceKey(bin) {
  return execFileSync(bin, ['presence-key'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
}

// keyd's presence key, base64 of the raw Ed25519 public key, or null when
// no signed keyd is installed. Pinned on first use, from the binary.
export function pinnedPresenceKey({
  env = process.env,
  home = env.HOME || homedir(),
  record = readKeydRecord({ env, home }),
  verifyBinary = codesignVerify,
  run = runPresenceKey,
  signer = keydSigner,
} = {}) {
  const file = presencePinPath({ env, home });
  try {
    const pinned = rawKey(readFileSync(file, 'utf8').trim());
    if (pinned) return pinned;
  } catch { /* not pinned yet */ }
  if (!record?.bin) return null;
  // A malformed signer setting pins nothing, like an unsigned binary.
  try { verifyBinary(record.bin, developerIdRequirement(signer({ env, home }))); } catch { return null; }
  let key;
  try { key = rawKey(String(run(record.bin)).trim()); } catch { return null; }
  if (!key) return null;
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; a corrupt pin being
  // replaced keeps whatever mode it had, so set it explicitly.
  chmodSync(file, 0o600);
  return key;
}

export function actionDigest(action) {
  return createHash('sha256').update(action, 'utf8').digest('hex');
}

// Throws unless `token` is keyd's signature of this action and nonce, fresh.
export function verifyPresence(token, { key, action, nonce, now = Date.now() }) {
  const invalid = () => Object.assign(new Error('agent-bot-keyd answered with an assertion that does not verify'), { code: 'presence-invalid' });
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== 'p1') throw invalid();
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key, 'base64').toString('base64url') }, format: 'jwk' });
  if (!verify(null, Buffer.from(parts[1]), publicKey, Buffer.from(parts[2], 'base64url'))) throw invalid();
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw invalid(); }
  const seconds = Math.floor(now / 1000);
  if (payload?.v !== 1 || payload.aud !== PRESENCE_AUDIENCE || payload.kind !== 'presence'
    || payload.action !== actionDigest(action) || payload.nonce !== nonce
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
    || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_LIFETIME_SECONDS
    || seconds + CLOCK_SKEW_SECONDS < payload.iat || seconds > payload.exp + CLOCK_SKEW_SECONDS) throw invalid();
  return payload;
}

// Asks the owner through keyd to approve `action`, one line naming the soul
// and the change. Returns the authorization to record.
export async function keydPresence(action, {
  env = process.env,
  home = env.HOME || homedir(),
  pinned = pinnedPresenceKey,
  request = keydRequest,
  now = () => Date.now(),
  nonce = () => randomBytes(18).toString('base64url'),
} = {}) {
  const key = pinned({ env, home });
  if (!key) throw unavailable('agent-bot-keyd is not set up for owner approval here');
  const sent = nonce();
  let result;
  try {
    result = await request(keydPaths({ env, home }).ownerSocket, 'owner/presence', { action, nonce: sent }, { timeoutMs: OWNER_TIMEOUT_MS });
  } catch (error) {
    if (error.code === 'keyd-unavailable' || error.rpcCode === PRESENCE_UNAVAILABLE_RPC) throw unavailable(error.message);
    throw Object.assign(new Error(`the owner did not approve (${error.message})`), { code: 'owner-declined' });
  }
  verifyPresence(result?.assertion, { key, action, nonce: sent, now: now() });
  return { method: 'presence', via: 'agent-bot-keyd' };
}
