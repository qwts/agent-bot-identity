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
import { appendAuditReceipt } from './agent-principals.mjs';
import { ANY_DEVELOPER_ID, DEFAULT_KEYD_IDENTIFIER, keydSigner } from './config.mjs';
import { keydPaths, keydRequest, readKeydRecord } from './keyd-client.mjs';
import { requireOwnerApproval } from './owner-approval.mjs';

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
export function developerIdRequirement({ teamId, identifier = DEFAULT_KEYD_IDENTIFIER }) {
  let requirement = 'anchor apple generic';
  if (identifier !== ANY_DEVELOPER_ID) requirement += ` and identifier "${identifier}"`;
  requirement += ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  if (teamId !== ANY_DEVELOPER_ID) requirement += ` and certificate leaf[subject.OU] = "${teamId}"`;
  return requirement;
}

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

// The signer a pin was taken under, kept beside it so a later pin under
// another signer is seen (#594). Pins from before #594 have none.
export function presenceSignerPath({ env = process.env, home = env.HOME || homedir() } = {}) {
  return path.join(keydPaths({ env, home }).dir, 'presence.signer');
}

function readPinnedSigner(file) {
  try {
    const signer = JSON.parse(readFileSync(file, 'utf8'));
    return typeof signer?.teamId === 'string' && typeof signer?.identifier === 'string' ? signer : null;
  } catch { return null; }
}

function signerWords({ teamId, identifier }) {
  const team = teamId === ANY_DEVELOPER_ID ? 'any Developer ID team' : `Developer ID team ${teamId}`;
  return identifier === ANY_DEVELOPER_ID ? `${team}, any identifier` : `${team} as ${identifier}`;
}

// Loosening who may sign keyd is the owner's call (#594): any Developer ID,
// or another signer than the pin was taken under. keyd cannot vouch for
// itself here, since its key is what is being pinned, so the owner answers
// the administrator dialog.
function approveSigner(signer, { previous }) {
  const change = previous ? ` instead of ${signerWords(previous)}` : '';
  requireOwnerApproval({
    prompt: `agent-bot wants to trust a keyd signed by ${signerWords(signer)}${change} for owner approvals. Approve only if you asked for this.`,
    outcome: 'no keyd key was pinned',
  });
}

function signerUnverified(error) {
  return Object.assign(new Error(`the keyd signer was not approved by the owner: ${error.message}`),
    { code: 'keyd-signer-unverified', cause: error });
}

function codesignVerify(bin, requirement) {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, bin],
    { stdio: ['ignore', 'ignore', 'pipe'] });
}

function runPresenceKey(bin) {
  return execFileSync(bin, ['presence-key'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
}

// keyd's presence key, base64 of the raw Ed25519 public key, or null when
// no signed keyd is installed or no keyd Team ID is configured. Pinned on
// first use, from the binary. A pin under a loosened signer needs the
// owner's approval and leaves a receipt; without it this throws
// `keyd-signer-unverified` and pins nothing.
export function pinnedPresenceKey({
  env = process.env,
  home = env.HOME || homedir(),
  record = readKeydRecord({ env, home }),
  verifyBinary = codesignVerify,
  run = runPresenceKey,
  signer = keydSigner,
  approve = approveSigner,
  receipt = appendAuditReceipt,
} = {}) {
  const file = presencePinPath({ env, home });
  try {
    const pinned = rawKey(readFileSync(file, 'utf8').trim());
    if (pinned) return pinned;
  } catch { /* not pinned yet */ }
  if (!record?.bin) return null;
  // A malformed signer setting pins nothing, like an unsigned binary, and so
  // does a missing Team ID.
  let wanted;
  try { wanted = signer({ env, home }); } catch { return null; }
  if (!wanted.teamId) return null;
  try { verifyBinary(record.bin, developerIdRequirement(wanted)); } catch { return null; }
  const signerFile = presenceSignerPath({ env, home });
  const previous = readPinnedSigner(signerFile);
  const changed = previous && (previous.teamId !== wanted.teamId || previous.identifier !== wanted.identifier);
  if (wanted.teamId === ANY_DEVELOPER_ID || wanted.identifier === ANY_DEVELOPER_ID || changed) {
    const detail = `${signerWords(wanted)}${changed ? ` (was ${signerWords(previous)})` : ''}`;
    const record_ = (decision) => receipt({ event: 'keyd-signer', operation: 'pin-presence-key', decision, detail }, { env, home });
    try {
      approve(wanted, { previous: changed ? previous : null });
    } catch (error) {
      try { record_('refused'); } catch { /* the refusal stands without its receipt */ }
      throw signerUnverified(error);
    }
    record_('approved');
  }
  let key;
  try { key = rawKey(String(run(record.bin)).trim()); } catch { return null; }
  if (!key) return null;
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; a corrupt pin being
  // replaced keeps whatever mode it had, so set it explicitly.
  chmodSync(file, 0o600);
  writeFileSync(signerFile, `${JSON.stringify({ teamId: wanted.teamId, identifier: wanted.identifier })}\n`, { mode: 0o600 });
  chmodSync(signerFile, 0o600);
  return key;
}

export function actionDigest(action) {
  return createHash('sha256').update(action, 'utf8').digest('hex');
}

// The payload of a `<prefix>.<payload>.<signature>` token keyd signed with
// `key`, fresh at `now`; throws `invalid()` otherwise.
function openSigned(token, { prefix, kind, key, nonce, now, invalid }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== prefix) throw invalid();
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key, 'base64').toString('base64url') }, format: 'jwk' });
  if (!verify(null, Buffer.from(parts[1]), publicKey, Buffer.from(parts[2], 'base64url'))) throw invalid();
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw invalid(); }
  const seconds = Math.floor(now / 1000);
  if (payload?.v !== 1 || payload.aud !== PRESENCE_AUDIENCE || payload.kind !== kind || payload.nonce !== nonce
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
    || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_LIFETIME_SECONDS
    || seconds + CLOCK_SKEW_SECONDS < payload.iat || seconds > payload.exp + CLOCK_SKEW_SECONDS) throw invalid();
  return payload;
}

// Throws unless `token` is keyd's signature of this action and nonce, fresh.
export function verifyPresence(token, { key, action, nonce, now = Date.now() }) {
  const invalid = () => Object.assign(new Error('agent-bot-keyd answered with an assertion that does not verify'), { code: 'presence-invalid' });
  const payload = openSigned(token, { prefix: 'p1', kind: 'presence', key, nonce, now, invalid });
  if (payload.action !== actionDigest(action)) throw invalid();
  return payload;
}

// The digest keyd records for the owner's statement keys (#753): sha256 of
// one line per pin, in order, as keyd/src/pins.rs writes it. The fingerprint
// stands for the key; owner-statement.mjs refuses a pin whose fingerprint
// does not match its key.
export function pinSetDigest(pins) {
  const lines = pins.map((pin) => `${pin.store} ${pin.alg} ${pin.fingerprint} ${pin.verifyRequired ? 1 : 0} ${pin.softwareKey ? 1 : 0} ${pin.name}\n`);
  return createHash('sha256').update(`agent-bot owner pins v1\n${lines.join('')}`, 'utf8').digest('hex');
}

// Throws unless `token` is keyd's signed record of the owner's keys for this
// nonce, fresh: `owner/pins-attest` or `owner/pins-status`. Returns
// { digest, generation }; digest is null, at generation 0, before the owner
// has approved any key set through keyd.
export function verifyPinsAttestation(token, { key, nonce, now = Date.now() }) {
  const invalid = () => Object.assign(new Error('agent-bot-keyd answered with an owner key record that does not verify'), { code: 'pins-invalid' });
  const payload = openSigned(token, { prefix: 'k1', kind: 'pins', key, nonce, now, invalid });
  const { digest, generation } = payload;
  if (!Number.isSafeInteger(generation) || generation < 0) throw invalid();
  if (digest === null ? generation !== 0 : (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || generation === 0)) throw invalid();
  return { digest, generation };
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
