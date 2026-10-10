// Owner-signed statements (ADR-0753, #753): a decision the owner signs with a
// key no agent can read, which any agent, CI job or subagent can check offline
// against the keys pinned here.
//
//   s1.<base64url(payload JSON)>.<base64url(signature)>
//   payload: { v: 1, aud: 'agent-bot-owner-statement', kind, alg, key,
//              text, scope, action, nonce, iat, exp }
//
// The signature covers the ASCII bytes of the payload segment. `alg` is
// `ed25519` (raw Ed25519, the keyd store) or `sshsig` (an SSH signature with
// namespace `agent-bot-owner-statement`, the ssh store). `key` is the
// fingerprint of the signing key, `SHA256:` and unpadded base64 of the SHA-256
// of its SSH wire blob, as `ssh-keygen -l` prints it; a raw keyd key is
// fingerprinted as the ssh-ed25519 blob it encodes to.
//
// Pins live in <state>/owner/keys.json (0600). Enrolling and removing a pin
// needs the owner gate (keyd presence or the administrator dialog) and a
// signature from the new key; a statement never changes the pins, so the
// fallback cannot bootstrap itself. Verification reads only those pins: no
// network, no daemon, no secret.
//
// This slice ships the format, the verifier (Ed25519 and SSHSIG, including
// FIDO `sk-ssh-ed25519@openssh.com` keys and their presence flags), the pins
// and the ssh store. The keyd store's `owner/sign` RPC, the challenge
// fallback in the owner gate and pins from the organization profile follow.

import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { withLock } from './agent-identity.mjs';
import { vouchStateDir } from './vouch.mjs';

export const STATEMENT_AUDIENCE = 'agent-bot-owner-statement';
export const SSHSIG_NAMESPACE = 'agent-bot-owner-statement';
export const MAX_OWNER_KEYS = 4;
export const MAX_TEXT_BYTES = 500;
export const STATEMENT_LIFETIME = Object.freeze({ default: 7 * 86_400, max: 30 * 86_400 });
export const CHALLENGE_LIFETIME = Object.freeze({ default: 600, max: 900 });
const CLOCK_SKEW_SECONDS = 30;
// The most `owner verify` reads from a file or stdin: a pasted thread with one
// block in it, never a device or an endless stream.
export const MAX_INPUT_BYTES = 1024 * 1024;
const BEGIN = '-----BEGIN AGENT-BOT OWNER STATEMENT-----';
const END = '-----END AGENT-BOT OWNER STATEMENT-----';
const PAYLOAD_FIELDS = ['action', 'aud', 'alg', 'exp', 'iat', 'key', 'kind', 'nonce', 'scope', 'text', 'v'].sort();
const SSH_ED25519 = 'ssh-ed25519';
const SK_ED25519 = 'sk-ssh-ed25519@openssh.com';
const SK_USER_PRESENT = 0x01;
const SK_USER_VERIFIED = 0x04;
const SK_EXTENSION_DATA = 0x80;
// Control characters, line and paragraph separators, and bidirectional
// marks and overrides: anything that could make the text read differently
// from what was signed.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function statementError(code, message) {
  return Object.assign(new Error(message), { code });
}

const invalid = (message) => statementError('statement-invalid', message);

export function ownerKeysPath({ env = process.env, home = env.HOME || homedir() } = {}) {
  return path.join(vouchStateDir({ env, home }), 'owner', 'keys.json');
}

// --- SSH wire format -------------------------------------------------------

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function reader(buffer, what) {
  let offset = 0;
  const need = (count) => {
    if (offset + count > buffer.length) throw invalid(`${what} is truncated`);
  };
  return {
    bytes(count) { need(count); const out = buffer.subarray(offset, offset + count); offset += count; return out; },
    u32() { need(4); const out = buffer.readUInt32BE(offset); offset += 4; return out; },
    byte() { need(1); return buffer[offset++]; },
    string() { return this.bytes(this.u32()); },
    end() { if (offset !== buffer.length) throw invalid(`${what} has trailing bytes`); },
  };
}

// An OpenSSH public key line, `type base64 [comment]`, as an Ed25519 key
// this verifier accepts: plain `ssh-ed25519` or a FIDO `sk-ssh-ed25519`.
export function parseSshPublicKey(line) {
  const fields = typeof line === 'string' ? line.trim().split(/\s+/) : [];
  if (fields.length < 2 || ![SSH_ED25519, SK_ED25519].includes(fields[0])) {
    throw statementError('owner-key-unsupported', 'only ssh-ed25519 and sk-ssh-ed25519@openssh.com public keys are supported');
  }
  const blob = Buffer.from(fields[1], 'base64');
  if (blob.toString('base64') !== fields[1]) throw statementError('owner-key-unsupported', 'the public key is not valid base64');
  const r = reader(blob, 'the public key');
  let type;
  let raw;
  let application = null;
  try {
    type = r.string().toString('utf8');
    raw = r.string();
    if (type === SK_ED25519) application = r.string();
    r.end();
  } catch {
    throw statementError('owner-key-unsupported', 'the public key blob is malformed');
  }
  if (type !== fields[0] || raw.length !== 32) throw statementError('owner-key-unsupported', 'the public key blob is malformed');
  return { type, raw, application, blob, line: `${type} ${fields[1]}` };
}

export function sshFingerprint(blob) {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`;
}

// A raw Ed25519 key (base64 of 32 bytes, as keyd reports keys) as the
// ssh-ed25519 public key line it encodes to.
export function ed25519KeyLine(rawBase64) {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) throw statementError('owner-key-unsupported', 'an Ed25519 public key is 32 bytes');
  return `${SSH_ED25519} ${Buffer.concat([sshString(SSH_ED25519), sshString(raw)]).toString('base64')}`;
}

function ed25519Verify(data, signature, raw) {
  if (signature.length !== 64) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  return verify(null, data, key, signature);
}

// Verifies an SSHSIG blob (OpenSSH PROTOCOL.sshsig) over `message` for the
// pinned key. A FIDO signature must carry the user-presence flag, and the
// user-verified flag when the key was pinned with `verifyRequired`.
export function verifySshsig(blob, message, pin) {
  const key = parseSshPublicKey(pin.publicKey);
  const r = reader(blob, 'the SSH signature');
  if (r.bytes(6).toString('latin1') !== 'SSHSIG' || r.u32() !== 1) throw invalid('the SSH signature is not an SSHSIG version 1 blob');
  const signer = r.string();
  const namespace = r.string();
  const reserved = r.string();
  const hashAlgorithm = r.string().toString('utf8');
  const signature = r.string();
  r.end();
  if (!signer.equals(key.blob)) throw invalid('the SSH signature names another key than the pinned one');
  if (namespace.toString('utf8') !== SSHSIG_NAMESPACE) throw invalid(`the SSH signature namespace is not ${SSHSIG_NAMESPACE}`);
  if (!['sha256', 'sha512'].includes(hashAlgorithm)) throw invalid('the SSH signature hash is not sha256 or sha512');
  const signed = Buffer.concat([Buffer.from('SSHSIG'), sshString(namespace), sshString(reserved), sshString(hashAlgorithm),
    sshString(createHash(hashAlgorithm).update(message).digest())]);
  const s = reader(signature, 'the SSH signature');
  if (s.string().toString('utf8') !== key.type) throw invalid('the SSH signature type does not match the pinned key');
  const bytes = s.string();
  let data = signed;
  if (key.type === SK_ED25519) {
    const flags = s.byte();
    const counter = s.bytes(4);
    if (flags & SK_EXTENSION_DATA) throw invalid('security key signatures with extension data are not supported');
    if (!(flags & SK_USER_PRESENT)) throw invalid('the security key signature lacks the user-presence flag');
    if (pin.verifyRequired && !(flags & SK_USER_VERIFIED)) throw invalid('the security key signature lacks the user-verified flag this key was pinned with');
    data = Buffer.concat([createHash('sha256').update(key.application).digest(), Buffer.from([flags]), counter,
      createHash('sha256').update(signed).digest()]);
  }
  s.end();
  if (!ed25519Verify(data, bytes, key.raw)) throw invalid('the SSH signature does not verify');
}

// The unarmored SSHSIG blob from `ssh-keygen -Y sign` output.
export function dearmorSshsig(text) {
  const match = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/u.exec(String(text));
  if (!match) throw invalid('ssh-keygen did not produce an SSH signature');
  return Buffer.from(match[1].replace(/\s+/gu, ''), 'base64');
}

// --- Payload ---------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function textProblem(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'the text is empty';
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return `the text is longer than ${MAX_TEXT_BYTES} bytes`;
  if (UNSAFE_TEXT.test(text)) return 'the text has a control, line-break or bidirectional character';
  return null;
}

function scopeProblem(scope, kind) {
  if (!isPlainObject(scope)) return 'the scope is not an object';
  const keys = Object.keys(scope).sort().join(',');
  const shapes = kind === 'statement' ? ['number,repo'] : ['host', 'host,number,repo'];
  if (!shapes.includes(keys)) return `a ${kind} scope must be ${shapes.map((shape) => `{ ${shape.replaceAll(',', ', ')} }`).join(' or ')}`;
  if ('repo' in scope && !(typeof scope.repo === 'string' && REPO.test(scope.repo))) return 'the scope repo is not owner/name';
  if ('number' in scope && !(Number.isSafeInteger(scope.number) && scope.number > 0)) return 'the scope number is not a positive integer';
  if ('host' in scope && !(typeof scope.host === 'string' && HOST.test(scope.host))) return 'the scope host is not a host name';
  return null;
}

// Every structural rule of ADR-0753 section 1 and the lifetime limits of
// section 7, without the signature or the clock. Returns the first problem.
export function payloadProblem(payload) {
  if (!isPlainObject(payload)) return 'the payload is not an object';
  if (Object.keys(payload).sort().join(',') !== PAYLOAD_FIELDS.join(',')) return 'the payload has missing or unknown fields';
  if (payload.v !== 1) return 'the payload version is not 1';
  if (payload.aud !== STATEMENT_AUDIENCE) return `the payload audience is not ${STATEMENT_AUDIENCE}`;
  if (!['statement', 'challenge'].includes(payload.kind)) return 'the payload kind is not statement or challenge';
  if (!['ed25519', 'sshsig'].includes(payload.alg)) return 'the payload alg is not ed25519 or sshsig';
  if (typeof payload.key !== 'string' || !FINGERPRINT.test(payload.key)) return 'the payload key is not a SHA256 fingerprint';
  const text = textProblem(payload.text);
  if (text) return text;
  const scope = scopeProblem(payload.scope, payload.kind);
  if (scope) return scope;
  if (payload.kind === 'statement' ? payload.action !== null : !(typeof payload.action === 'string' && /^[0-9a-f]{64}$/u.test(payload.action))) {
    return payload.kind === 'statement' ? 'a statement has no action' : 'a challenge action is a sha256 hex digest';
  }
  if (typeof payload.nonce !== 'string' || !NONCE.test(payload.nonce)) return 'the nonce is not 16 to 64 base64url characters';
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return 'iat and exp are whole Unix seconds';
  const limit = payload.kind === 'statement' ? STATEMENT_LIFETIME.max : CHALLENGE_LIFETIME.max;
  if (payload.exp <= payload.iat || payload.exp - payload.iat > limit) return `a ${payload.kind} lasts more than 0 and at most ${limit} seconds`;
  return null;
}

export function encodePayload(payload) {
  const problem = payloadProblem(payload);
  if (problem) throw invalid(problem);
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function armorStatement(token) {
  return `${BEGIN}\n${token}\n${END}\n`;
}

// The one token in `input`: the single armored block, or a bare token.
export function extractToken(input) {
  const text = String(input ?? '');
  const blocks = [...text.matchAll(/-----BEGIN AGENT-BOT OWNER STATEMENT-----([\s\S]*?)-----END AGENT-BOT OWNER STATEMENT-----/gu)];
  if (blocks.length > 1) throw invalid('the input holds more than one statement block; verify one at a time');
  const token = blocks.length === 1 ? blocks[0][1].replace(/\s+/gu, '') : text.trim();
  if (!/^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw invalid('no owner statement was found');
  return token;
}

function base64url(segment, what) {
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw invalid(`the ${what} is not canonical base64url`);
  return bytes;
}

// --- Pins ------------------------------------------------------------------

function pinProblem(pin) {
  if (!isPlainObject(pin)) return 'a pin is not an object';
  if (typeof pin.name !== 'string' || !KEY_NAME.test(pin.name)) return 'a pin name is invalid';
  if (!['keyd', 'ssh'].includes(pin.store)) return `pin ${pin.name} has an unknown store`;
  if (pin.alg !== (pin.store === 'keyd' ? 'ed25519' : 'sshsig')) return `pin ${pin.name} has the wrong alg for its store`;
  let key;
  try { key = parseSshPublicKey(pin.publicKey); } catch { return `pin ${pin.name} has an unsupported public key`; }
  if (pin.store === 'keyd' && key.type !== SSH_ED25519) return `pin ${pin.name} is a keyd pin with a security-key type`;
  if (pin.fingerprint !== sshFingerprint(key.blob)) return `pin ${pin.name} has a fingerprint that does not match its key`;
  if (typeof pin.verifyRequired !== 'boolean' || typeof pin.softwareKey !== 'boolean') return `pin ${pin.name} has invalid flags`;
  if (pin.softwareKey !== (pin.store === 'ssh' && key.type === SSH_ED25519)) return `pin ${pin.name} has a softwareKey flag that does not match its key`;
  if (typeof pin.pinnedAt !== 'string' || Number.isNaN(Date.parse(pin.pinnedAt))) return `pin ${pin.name} has no pinnedAt time`;
  return null;
}

// The pinned owner keys. A missing file is no keys; a malformed one throws,
// so a damaged pin file never reads as "nothing to check against".
export function readOwnerKeys({ env = process.env, home = env.HOME || homedir(), file = ownerKeysPath({ env, home }) } = {}) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw statementError('owner-keys-invalid', `cannot read ${file}: ${error.message}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw statementError('owner-keys-invalid', `${file} is not JSON`); }
  if (!isPlainObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.keys) || Object.keys(parsed).sort().join(',') !== 'keys,v') {
    throw statementError('owner-keys-invalid', `${file} is not a version 1 owner key file`);
  }
  if (parsed.keys.length > MAX_OWNER_KEYS) throw statementError('owner-keys-invalid', `${file} pins more than ${MAX_OWNER_KEYS} keys`);
  const names = new Set();
  const prints = new Set();
  for (const pin of parsed.keys) {
    const problem = pinProblem(pin);
    if (problem) throw statementError('owner-keys-invalid', `${file}: ${problem}`);
    if (names.has(pin.name) || prints.has(pin.fingerprint)) throw statementError('owner-keys-invalid', `${file} pins ${pin.name} twice`);
    names.add(pin.name);
    prints.add(pin.fingerprint);
  }
  return parsed.keys;
}

export function writeOwnerKeys(keys, { env = process.env, home = env.HOME || homedir(), file = ownerKeysPath({ env, home }) } = {}) {
  for (const pin of keys) {
    const problem = pinProblem(pin);
    if (problem) throw statementError('owner-keys-invalid', problem);
  }
  if (keys.length > MAX_OWNER_KEYS) throw statementError('owner-keys-full', `at most ${MAX_OWNER_KEYS} owner keys can be pinned`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, keys }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

// Re-reads the pins under the store's lock, applies `mutation` (which
// returns the new list or throws) and writes the result. Callers ask the
// owner before this, never while holding the lock.
export function mutateOwnerKeys(mutation, { env = process.env, home = env.HOME || homedir(), file = ownerKeysPath({ env, home }) } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  return withLock(`${file}.lock`, 'owner key store', () => {
    const next = mutation(readOwnerKeys({ file }));
    writeOwnerKeys(next, { file });
    return next;
  });
}

function enrolmentConflict(keys, name, fingerprint) {
  const conflict = keys.find((pin) => pin.name === name || pin.fingerprint === fingerprint);
  if (conflict) {
    return statementError('owner-key-exists', conflict.fingerprint === fingerprint ? `this key is already pinned as ${conflict.name}` : `a key named ${name} is already pinned; remove it first`);
  }
  return keys.length >= MAX_OWNER_KEYS ? statementError('owner-keys-full', `${MAX_OWNER_KEYS} owner keys are already pinned; remove one first`) : null;
}

// --- Verify ----------------------------------------------------------------

// Verifies `input` (an armored block or a bare token) against `keys`.
// Returns `{ payload, pin }` or throws one of `statement-invalid`,
// `statement-unknown-key`, `statement-expired` or `statement-scope-mismatch`.
// The signature is checked before the clock and the scope, so an expired or
// out-of-scope answer is only ever given about an authentic statement.
export function verifyStatement(input, { keys, now = Date.now(), repo = null, issue = null } = {}) {
  const token = extractToken(input);
  const [, segment, signatureSegment] = token.split('.');
  let payload;
  try { payload = JSON.parse(base64url(segment, 'payload').toString('utf8')); } catch (error) {
    throw error.code ? error : invalid('the payload is not JSON');
  }
  const problem = payloadProblem(payload);
  if (problem) throw invalid(problem);
  const pin = keys.find((candidate) => candidate.fingerprint === payload.key);
  if (!pin) throw statementError('statement-unknown-key', `no owner key with fingerprint ${payload.key} is pinned here`);
  if (pin.alg !== payload.alg) throw invalid(`key ${pin.name} signs ${pin.alg}, not ${payload.alg}`);
  const signature = base64url(signatureSegment, 'signature');
  const message = Buffer.from(segment, 'ascii');
  if (payload.alg === 'sshsig') verifySshsig(signature, message, pin);
  else if (!ed25519Verify(message, signature, parseSshPublicKey(pin.publicKey).raw)) throw invalid('the signature does not verify');
  const seconds = Math.floor(now / 1000);
  if (payload.iat > seconds + CLOCK_SKEW_SECONDS) throw invalid('the statement was issued in the future');
  if (seconds > payload.exp + CLOCK_SKEW_SECONDS) {
    throw statementError('statement-expired', `the statement expired at ${new Date(payload.exp * 1000).toISOString()}`);
  }
  if (repo !== null || issue !== null) {
    const scope = payload.scope;
    if (String(scope.repo ?? '').toLowerCase() !== String(repo ?? '').toLowerCase() || scope.number !== issue) {
      throw statementError('statement-scope-mismatch', `the statement is scoped to ${describeScope(scope)}, not ${repo}#${issue}`);
    }
  }
  return { payload, pin };
}

export function describeScope(scope) {
  const target = scope.repo ? `${scope.repo}#${scope.number}` : null;
  return [scope.host ? `host ${scope.host}` : null, target].filter(Boolean).join(', ');
}

// --- Sign (ssh store) ------------------------------------------------------

// Agent processes, by the `<NAME>_AGENT`-shaped markers detect-harness.mjs
// keys on. The ssh store has no trusted display (ADR-0753 section 5), so it
// signs only where no agent is running the terminal.
export function harnessMarkers(env = process.env) {
  const named = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT', 'CURSOR_AGENT', 'COPILOT_AGENT', 'DEVIN_AGENT',
    'WINDSURF_AGENT', 'MUSE_AGENT', 'QWEN_CODE'].filter((name) => typeof env[name] === 'string' && env[name] !== '');
  return [...named, ...Object.keys(env).filter((name) => name.startsWith('CODEX_')).sort()];
}

// The public half of an ssh key file, from the `.pub` beside it.
export function sshKeyFor(keyPath) {
  const pub = `${keyPath}.pub`;
  if (!existsSync(pub)) throw statementError('owner-key-unsupported', `${pub} is missing; ssh-keygen writes it beside the key`);
  return parseSshPublicKey(readFileSync(pub, 'utf8'));
}

function runSshKeygen(args) {
  // Inherit the terminal: a security key asks for a touch or a PIN there.
  execFileSync('ssh-keygen', args, { stdio: ['inherit', 'ignore', 'inherit'] });
}

// Signs `segment` with the ssh key at `keyPath` and returns the SSHSIG blob.
export function sshSign(segment, keyPath, { run = runSshKeygen } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-bot-owner-sign-'));
  try {
    const file = path.join(dir, 'payload');
    writeFileSync(file, segment, { mode: 0o600 });
    try { run(['-Y', 'sign', '-n', SSHSIG_NAMESPACE, '-f', keyPath, file]); } catch (error) {
      throw statementError('owner-sign-failed', `ssh-keygen could not sign: ${error.message}`);
    }
    return dearmorSshsig(readFileSync(`${file}.sig`, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function newNonce() {
  return randomBytes(18).toString('base64url');
}

export function localHost() {
  const name = hostname().replace(/\.local$/u, '');
  return HOST.test(name) ? name : 'localhost';
}

export function parseLifetime(text, { max }) {
  const match = /^([1-9][0-9]*)([mhd])$/u.exec(String(text));
  if (!match) throw statementError('owner-usage', '--expires takes a whole number of minutes, hours or days, such as 7d');
  const seconds = Number(match[1]) * { m: 60, h: 3600, d: 86_400 }[match[2]];
  if (seconds > max) throw statementError('owner-usage', `--expires is at most ${max / 86_400} days`);
  return seconds;
}

// Builds, signs and returns the token for a statement or a challenge.
export function signPayload(fields, { keyPath, sign = sshSign, now = Date.now() } = {}) {
  const key = sshKeyFor(keyPath);
  const iat = Math.floor(now / 1000);
  const payload = {
    v: 1, aud: STATEMENT_AUDIENCE, alg: 'sshsig', key: sshFingerprint(key.blob), nonce: newNonce(), iat, ...fields,
    exp: iat + fields.lifetime,
  };
  delete payload.lifetime;
  const segment = encodePayload(payload);
  return { token: `s1.${segment}.${sign(segment, keyPath).toString('base64url')}`, payload, key };
}

// --- Command ---------------------------------------------------------------

export const OWNER_USAGE = 'usage: agent-bot owner verify <token|file|-> [--repo OWNER/NAME --issue N] [--json] | owner sign "<text>" --repo OWNER/NAME --issue N --key PATH [--expires 7d] | owner enroll --store ssh --key PATH [--name NAME] [--verify-required] [--allow-software-key] | owner keys [--json] | owner remove NAME';

const usage = (message) => statementError('owner-usage', `${message}\n${OWNER_USAGE}`);

function noGate() {
  throw statementError('owner-credential-required', 'no owner gate is wired for this command');
}

function scopeFlags(values, { required }) {
  const repo = values.repo ?? null;
  const issue = values.issue ?? null;
  if ((repo === null) !== (issue === null)) throw usage('--repo and --issue go together');
  if (repo === null) {
    if (required) throw usage('--repo and --issue are required');
    return null;
  }
  if (!REPO.test(repo)) throw usage('--repo is OWNER/NAME');
  if (!/^[1-9][0-9]*$/u.test(issue) || !Number.isSafeInteger(Number(issue))) throw usage('--issue is a positive issue or PR number');
  return { repo, number: Number(issue) };
}

function tooLarge() {
  return invalid(`the input is larger than ${MAX_INPUT_BYTES} bytes`);
}

// Reads at most MAX_INPUT_BYTES from an open descriptor.
function readBounded(fd) {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let count;
    try { count = readSync(fd, buffer, 0, buffer.length, null); } catch (error) {
      if (error.code === 'EAGAIN') continue;
      if (error.code === 'EOF') break;
      throw error;
    }
    if (count === 0) break;
    total += count;
    if (total > MAX_INPUT_BYTES) throw tooLarge();
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A statement file: a regular file, not a symlink, a FIFO or a device, and
// no larger than MAX_INPUT_BYTES.
export function readStatementFile(file) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    throw invalid(`cannot open ${file}: ${error.code === 'ELOOP' ? 'it is a symbolic link' : error.message}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw invalid(`${file} is not a regular file`);
    if (stat.size > MAX_INPUT_BYTES) throw tooLarge();
    return readBounded(fd);
  } finally {
    closeSync(fd);
  }
}

function verifyInput(source, { readStdin, readFile }) {
  if (source === '-') return readStdin();
  if (!source.startsWith('s1.') && !source.includes(BEGIN) && existsSync(source)) return readFile(source);
  return source;
}

// `agent-bot owner`: verify, sign, enroll, keys, remove (ADR-0753).
// verify needs nothing but the pins. sign refuses a soul or an agent process.
// enroll and remove go through `gate` (owner-action.mjs's assertOwnerAction,
// wired by cli/owner.mjs) and leave an `owner-key` receipt either way.
export async function ownerCommand(argv, {
  env = process.env,
  home = env.HOME || homedir(),
  cwd = process.cwd(),
  now = () => Date.now(),
  write = (text) => process.stdout.write(text),
  writeErr = (text) => process.stderr.write(text),
  readStdin = () => readBounded(0),
  readFile = readStatementFile,
  gate = noGate,
  markers = () => [],
  receipt = () => {},
  sign = sshSign,
  host = localHost,
} = {}) {
  const [command, ...rest] = argv;
  const { parseArgs } = await import('node:util');
  // A pasted armored block starts with dashes but is an argument, not a flag.
  const blocks = rest.filter((arg) => arg.startsWith('-----BEGIN '));
  const parse = (options) => {
    let parsed;
    try { parsed = parseArgs({ args: rest.filter((arg) => !blocks.includes(arg)), options, allowPositionals: true, strict: true }); } catch (error) { throw usage(error.message); }
    return { ...parsed, positionals: [...blocks, ...parsed.positionals] };
  };
  const store = { env, home };
  const json = (value) => write(`${JSON.stringify(value, null, 2)}\n`);
  switch (command) {
    case 'verify': {
      const { values, positionals } = parse({ repo: { type: 'string' }, issue: { type: 'string' }, json: { type: 'boolean' } });
      if (positionals.length !== 1) throw usage('owner verify takes one token, file or -');
      const scope = scopeFlags(values, { required: false });
      try {
        const { payload, pin } = verifyStatement(verifyInput(positionals[0], { readStdin, readFile }), {
          keys: readOwnerKeys(store), now: now(), repo: scope?.repo ?? null, issue: scope?.number ?? null,
        });
        const result = { ok: true, kind: payload.kind, text: payload.text, scope: payload.scope, key: pin.name,
          fingerprint: pin.fingerprint, issuedAt: new Date(payload.iat * 1000).toISOString(), expiresAt: new Date(payload.exp * 1000).toISOString() };
        if (values.json) json(result);
        else write(`verified owner ${payload.kind} (key ${pin.name}), ${describeScope(payload.scope)}, expires ${result.expiresAt}:\n${payload.text}\n`);
        return result;
      } catch (error) {
        if (!values.json || !error.code) throw error;
        json({ ok: false, code: error.code, message: error.message });
        return { ok: false, code: error.code };
      }
    }
    case 'sign': {
      const { values, positionals } = parse({ repo: { type: 'string' }, issue: { type: 'string' }, key: { type: 'string' },
        expires: { type: 'string' }, challenge: { type: 'string' } });
      if (values.challenge !== undefined) throw usage('owner sign --challenge comes with the challenge fallback, which is not built yet (#753)');
      if (positionals.length !== 1) throw usage('owner sign takes the statement text as one argument');
      if (!values.key) throw usage('owner sign needs --key PATH, the ssh key to sign with');
      const scope = scopeFlags(values, { required: true });
      const problem = textProblem(positionals[0]);
      if (problem) throw usage(problem);
      const found = [...markers({ env, cwd }), ...harnessMarkers(env)];
      if (found.length) {
        throw statementError('owner-credential-required',
          `owner sign runs only where no agent runs; this caller has ${found.join(', ')}. The ssh store cannot show you what it signs, so sign on a machine or terminal no agent controls.`);
      }
      const lifetime = values.expires ? parseLifetime(values.expires, { max: STATEMENT_LIFETIME.max }) : STATEMENT_LIFETIME.default;
      const at = now();
      writeErr(`Signing as the owner, for ${scope.repo}#${scope.number}, until ${new Date((Math.floor(at / 1000) + lifetime) * 1000).toISOString()}:\n  ${positionals[0]}\nTouch your security key or enter its PIN if asked.\n`);
      const { token } = signPayload({ kind: 'statement', text: positionals[0], scope, action: null, lifetime },
        { keyPath: values.key, sign, now: at });
      write(armorStatement(token));
      return { token };
    }
    case 'enroll': {
      const { values, positionals } = parse({ store: { type: 'string' }, key: { type: 'string' }, name: { type: 'string' },
        'verify-required': { type: 'boolean' }, 'allow-software-key': { type: 'boolean' } });
      if (positionals.length) throw usage('owner enroll takes no positional arguments');
      if (values.store === 'keyd') {
        throw statementError('owner-store-unavailable', 'the keyd store needs keyd\'s owner/sign RPC, which is not built yet (#753); enrol an ssh security key with --store ssh');
      }
      if (values.store !== 'ssh') throw usage('owner enroll needs --store ssh');
      if (!values.key) throw usage('owner enroll needs --key PATH, the ssh key to pin');
      const name = values.name ?? 'ssh';
      if (!KEY_NAME.test(name)) throw usage('--name is 1 to 32 lowercase letters, digits and dashes');
      const key = sshKeyFor(values.key);
      const softwareKey = key.type === SSH_ED25519;
      const fingerprint = sshFingerprint(key.blob);
      const action = `owner enroll ${name} ${fingerprint}`;
      const record = (decision, detail) => {
        try { receipt({ event: 'owner-key', operation: 'enroll', decision, detail }, { env, home }); } catch { /* the outcome stands without its receipt */ }
      };
      const refuse = (error) => {
        record('refused', `${name} ${fingerprint}: ${error.code}`);
        throw error;
      };
      if (softwareKey && !values['allow-software-key']) {
        refuse(statementError('owner-key-software',
          `${values.key} is a plain ssh-ed25519 key, readable by any agent in your account. Use a security key (sk-ssh-ed25519), or pass --allow-software-key to pin it anyway.`));
      }
      if (softwareKey && values['verify-required']) refuse(usage('--verify-required applies only to a security key'));
      // Checked now so a doomed enrolment asks nobody, and again under the
      // lock when the pin is written.
      const early = enrolmentConflict(readOwnerKeys(store), name, fingerprint);
      if (early) refuse(early);
      try {
        await gate(action, { env, cwd });
      } catch (error) {
        record('refused', `${name} ${fingerprint}: ${error.code ?? 'owner-not-verified'}`);
        throw error;
      }
      const pin = { name, store: 'ssh', alg: 'sshsig', publicKey: key.line, fingerprint, verifyRequired: Boolean(values['verify-required']),
        softwareKey, pinnedAt: new Date(now()).toISOString() };
      try {
        // Possession: the new key signs a challenge for this enrolment, and
        // the pin is written only if that verifies under the pin itself.
        writeErr(`Proving you hold ${name} (${fingerprint}): touch the security key or enter its PIN if asked.\n`);
        const { token } = signPayload({ kind: 'challenge', text: `Enrol owner key ${name} (${fingerprint}) on ${host()}`,
          scope: { host: host() }, action: createHash('sha256').update(action, 'utf8').digest('hex'), lifetime: CHALLENGE_LIFETIME.default },
        { keyPath: values.key, sign, now: now() });
        verifyStatement(token, { keys: [pin], now: now() });
        mutateOwnerKeys((keys) => {
          const conflict = enrolmentConflict(keys, name, fingerprint);
          if (conflict) throw conflict;
          return [...keys, pin];
        }, store);
      } catch (error) {
        record('failed', `${name} ${fingerprint}: ${error.code ?? 'error'}`);
        throw error;
      }
      record('approved', `${name} ${fingerprint}`);
      write(`pinned owner key ${name} (${fingerprint}) in ${ownerKeysPath(store)}\n`);
      writeErr('The ssh store has no trusted display: run `agent-bot owner sign` only on a machine or terminal where no agent runs in your account.\n');
      if (softwareKey) writeErr('This is a software key: any process that can read the key file can sign as you. A security key is stronger.\n');
      return pin;
    }
    case 'keys': {
      const { values, positionals } = parse({ json: { type: 'boolean' } });
      if (positionals.length) throw usage('owner keys takes no arguments');
      const keys = readOwnerKeys(store);
      if (values.json) json(keys);
      else write(keys.length ? keys.map((pin) => `${pin.name}\t${pin.store}\t${pin.fingerprint}\t${pin.pinnedAt}\n`).join('') : 'no owner keys are pinned\n');
      return keys;
    }
    case 'remove': {
      const { positionals } = parse({});
      if (positionals.length !== 1) throw usage('owner remove takes one key name');
      const record = (decision, detail) => {
        try { receipt({ event: 'owner-key', operation: 'remove', decision, detail }, { env, home }); } catch { /* the outcome stands without its receipt */ }
      };
      const missing = () => statementError('owner-key-missing', `no owner key named ${positionals[0]} is pinned`);
      const pin = KEY_NAME.test(positionals[0]) ? readOwnerKeys(store).find((candidate) => candidate.name === positionals[0]) : null;
      if (!pin) {
        record('refused', `${positionals[0].slice(0, 32)}: owner-key-missing`);
        throw missing();
      }
      try {
        await gate(`owner remove ${pin.name} ${pin.fingerprint}`, { env, cwd });
      } catch (error) {
        record('refused', `${pin.name} ${pin.fingerprint}: ${error.code ?? 'owner-not-verified'}`);
        throw error;
      }
      try {
        // The owner approved removing this key, by fingerprint: a key
        // re-pinned under the same name meanwhile is not it.
        mutateOwnerKeys((keys) => {
          if (!keys.some((candidate) => candidate.fingerprint === pin.fingerprint)) throw missing();
          return keys.filter((candidate) => candidate.fingerprint !== pin.fingerprint);
        }, store);
      } catch (error) {
        record('failed', `${pin.name} ${pin.fingerprint}: ${error.code ?? 'error'}`);
        throw error;
      }
      record('approved', `${pin.name} ${pin.fingerprint}`);
      write(`removed owner key ${pin.name} (${pin.fingerprint})\n`);
      return pin;
    }
    default:
      throw usage(command ? `unknown owner subcommand ${command}` : 'owner needs a subcommand');
  }
}
