// agent-machine client (#1254): the local control-plane client to
// managed-machine's daemon. One signed JSON line out, one signed JSON line
// back over a unix socket (Windows: a named pipe). The wire protocol is
// managed-machine's internal/daemon/protocol.go: requests sign the
// newline-joined verb..nonce fields, responses sign ok..request_nonce.
// The agent-daemon Ed25519 key lives under the identity vouch custody
// (0600 / Windows owned ACL); the agent-machine response key is pinned at
// pair time so a swapped daemon.pub is refused.
import { createHash, randomBytes, sign as edSign, verify as edVerify, createPublicKey } from 'node:crypto';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { loadOrCreateVouchKey, vouchStateDir } from './identity-host.mjs';

const REQUEST_FIELDS = ['verb', 'name', 'option', 'target', 'plan_id', 'soul', 'harness', 'session_id'];
const VERBS = new Set(['status', 'receipts', 'plan', 'apply', 'update']);
const SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

export const AGENT_MACHINE_DIR = (home = homedir()) => path.join(home, '.config', 'agent-machine');
export const machineSocketPath = ({ home = homedir(), platform = process.platform } = {}) =>
  platform === 'win32' ? '\\\\.\\pipe\\agent-machine' : path.join(AGENT_MACHINE_DIR(home), 'daemon.sock');

function mcError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

export function machineStateDir({ env = process.env, home = homedir() } = {}) {
  return path.join(vouchStateDir({ env, home }), 'agent-machine');
}

export function loadOrCreateMachineKey({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const dir = machineStateDir({ env, home });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = loadOrCreateVouchKey(dir, { platform });
  const publicKeyRaw = Buffer.from(createPublicKey(key.privateKey).export({ format: 'jwk' }).x, 'base64url');
  return { publicKeyRaw, sign: (bytes) => edSign(null, bytes, key.privateKey) };
}

export function requestCanonical(r) {
  return Buffer.from(REQUEST_FIELDS.map((f) => r[f] ?? '').join('\n') + '\n' + String(r.timestamp) + '\n' + r.nonce);
}

export function buildRequest({ verb, name, option, target, plan_id, soul, harness, session_id }, signer, { now = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('base64url') } = {}) {
  if (!VERBS.has(verb)) throw mcError('machine-verb-unknown', `verb is not one of ${[...VERBS].join(', ')}`);
  for (const [field, value] of Object.entries({ name, option, target, plan_id })) {
    if (value !== undefined && (typeof value !== 'string' || !SHAPE.test(value))) {
      throw mcError('machine-field-invalid', `${field} fails the wire shape`);
    }
  }
  const request = { verb };
  for (const f of REQUEST_FIELDS.slice(1)) {
    const v = { name, option, target, plan_id, soul, harness, session_id }[f];
    if (v) request[f] = v;
  }
  request.timestamp = now;
  request.nonce = nonce;
  request.public_key = signer.publicKeyRaw.toString('base64');
  request.signature = signer.sign(requestCanonical(request)).toString('base64');
  return request;
}

// The response signature covers the raw bytes of the body value exactly as
// they appear on the line, so find that span in the top-level object without
// re-serializing (escaped <, &, unicode all differ under re-encode).
export function bodySpan(line) {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  const marker = /"body"\s*:/.exec(text);
  if (!marker) return null;
  let i = marker.index + marker[0].length;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const start = i;
  let depth = 0, inString = false, escaped = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') inString = !inString;
    if (inString) continue;
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    } else if (depth === 0 && (c === ',' || c === '}')) break;
  }
  return Buffer.from(text.slice(start, i === start ? start : i), 'utf8');
}

export function responseCanonical(res, bodyRaw) {
  return Buffer.from([
    String(res.ok), res.diagnostic ?? '', res.message ?? '', res.state ?? '',
    bodyRaw ? bodyRaw.toString('utf8') : '',
    String(res.timestamp), res.nonce ?? '', res.request_nonce ?? '',
  ].join('\n'));
}

export function verifyResponse(line, pinnedPublicKeyRaw, { now = Date.now() } = {}) {
  const raw = typeof line === 'string' ? line : line.toString('utf8');
  const res = JSON.parse(raw.trimEnd());
  if (typeof res.signature !== 'string' || typeof res.timestamp !== 'number') {
    throw mcError('machine-reply-invalid', 'the agent-machine reply is unsigned');
  }
  const bodyRaw = bodySpan(raw);
  let ok;
  try {
    const pub = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: pinnedPublicKeyRaw.toString('base64url') } });
    ok = edVerify(null, responseCanonical(res, bodyRaw), pub, Buffer.from(res.signature, 'base64'));
  } catch { ok = false; }
  if (!ok) throw mcError('machine-reply-tampered', 'the agent-machine reply signature does not match the pinned key');
  const skew = Math.abs(now - res.timestamp * 1000);
  if (skew > SKEW_MS) throw mcError('machine-reply-stale', 'the agent-machine reply timestamp is outside the allowed window');
  return { ok: res.ok, state: res.state ?? null, diagnostic: res.diagnostic ?? null, message: res.message ?? null, body: res.body ?? null };
}

export function machineCall({ socketPath, request, timeoutMs = DEFAULT_TIMEOUT_MS, connectImpl = connect } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectImpl(socketPath);
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(mcError('machine-timeout', 'agent-machine did not answer in time')); }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(buf.slice(0, nl));
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(mcError('machine-unreachable', `agent-machine socket failed: ${error.code ?? error.message}`)); });
  });
}

export async function machineRoundTrip({ verb, fields = {}, signer, socketPath, timeoutMs, now } = {}) {
  const request = buildRequest({ verb, ...fields }, signer, now ? { now } : {});
  const line = await machineCall({ socketPath, request, timeoutMs });
  return { request, reply: line };
}

// --- Pairing files (owner-only; see cli machine pair) ---

const PAIRING_CLIENTS = ['terminal', 'agent-daemon'];
const PAIRING_SUFFIXES = ['.pub', '.next', '.confirm', '.revoked'];
const LEGACY_PEER = ['peer.pub', 'peer.next', 'peer.confirm', 'peer.revoked'];

export function pinPath({ env = process.env, home = homedir() } = {}) {
  return path.join(machineStateDir({ env, home }), 'daemon.pub.pin');
}

export function daemonFingerprint(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

export function assertPairingLayout(dir) {
  for (const name of LEGACY_PEER) {
    if (existsSync(path.join(dir, name))) {
      throw mcError('machine-legacy-peers', `${name} exists beside peers/: agent-machine has not run since the pairing layout moved — start it (managed-machine daemon install / restart) before pairing`);
    }
  }
  const peers = path.join(dir, 'peers');
  if (!existsSync(peers)) return;
  const allowed = new Set(PAIRING_CLIENTS.flatMap((c) => PAIRING_SUFFIXES.map((s) => c + s)));
  for (const entry of readdirSync(peers, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isDirectory()) {
      throw mcError('machine-peers-invalid', `peers/${entry.name} is not a client key file — agent-machine would refuse to start`);
    }
  }
}
// Atomic 0600 write: temp file lives in `dir`'s parent area, not inside a
// directory agent-machine refuses unknown names in (peers/).
export function atomicWrite0600(file, content, { tempDir = path.dirname(file) } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(tempDir, `.tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(temp, content, { mode: 0o600 });
  try { renameSync(temp, file); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

export function pinDaemonPub({ env = process.env, home = homedir(), repin = false, now } = {}) {
  const dir = AGENT_MACHINE_DIR(home);
  const pubFile = path.join(dir, 'daemon.pub');
  if (!existsSync(pubFile)) throw mcError('machine-not-running', `${pubFile} does not exist — start agent-machine first (managed-machine daemon install)`);
  const pub = readFileSync(pubFile);
  if (pub.length !== 32) throw mcError('machine-reply-invalid', `${pubFile} is not a raw 32-byte Ed25519 key`);
  const pin = pinPath({ env, home });
  const old = existsSync(pin) ? readFileSync(pin) : null;
  if (old && !old.equals(pub) && !repin) {
    throw mcError('machine-pin-mismatch', `agent-machine's key changed (old ${daemonFingerprint(old)}, new ${daemonFingerprint(pub)}) — re-pair with --repin to accept`);
  }
  const oldFp = old && !old.equals(pub) ? daemonFingerprint(old) : null;
  mkdirSync(path.dirname(pin), { recursive: true, mode: 0o700 });
  atomicWrite0600(pin, pub);
  return { publicKeyRaw: pub, fingerprint: daemonFingerprint(pub), replaced: oldFp };
}

export function writeAgentDaemonPeer({ home = homedir(), publicKeyRaw }) {
  const dir = AGENT_MACHINE_DIR(home);
  assertPairingLayout(dir);
  const peers = path.join(dir, 'peers');
  mkdirSync(peers, { recursive: true, mode: 0o700 });
  atomicWrite0600(path.join(peers, 'agent-daemon.next'), publicKeyRaw, { tempDir: dir });
  atomicWrite0600(path.join(peers, 'agent-daemon.confirm'), createHash('sha256').update(publicKeyRaw).digest('hex'), { tempDir: dir });
}

export function unpairAgentDaemon({ env = process.env, home = homedir() } = {}) {
  const dir = AGENT_MACHINE_DIR(home);
  assertPairingLayout(dir);
  const peers = path.join(dir, 'peers');
  mkdirSync(peers, { recursive: true, mode: 0o700 });
  atomicWrite0600(path.join(peers, 'agent-daemon.revoked'), Buffer.alloc(0), { tempDir: dir });
  rmSync(pinPath({ env, home }), { force: true });
}

export function pairedPublicKey({ env = process.env, home = homedir() } = {}) {
  const pin = pinPath({ env, home });
  if (!existsSync(pin)) throw mcError('machine-not-paired', 'agent-machine is not paired — run agent-bot machine pair');
  const pub = readFileSync(pin);
  const live = path.join(AGENT_MACHINE_DIR(home), 'daemon.pub');
  if (existsSync(live) && !readFileSync(live).equals(pub)) {
    throw mcError('machine-pin-mismatch', 'agent-machine daemon.pub differs from the pinned key — re-pair with --repin');
  }
  return pub;
}
