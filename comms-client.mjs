// Daemon broker client for agent-comms (agent-bot-identity#255).
//
// Speaks the agent-comms wire protocol v1: NDJSON over the broker's Unix
// socket, one JSON request line `{ v: 1, id, op, auth?, ...args }` per
// connection, one JSON reply line `{ v: 1, id, ok, result | error }` — or, for
// `account-watch`, one `{ event, ... }` line per wake until either side
// closes. Framing and custody checks mirror the reference client
// (agent-comms lib/wire.mjs, lib/client.mjs, lib/paths.mjs, lib/custody.mjs).
// This module never imports from that checkout and never reads agent-comms'
// own credential file: the daemon authenticates as its own credential kind,
// `auth: { daemon: <account>, secret }` (ADR-0008 decisions 4 and 7).
//
// Pairing (`agent-bot daemon pair-comms [--broker <account>]`) writes a
// kernel-stamped proof file holding `sha256(secret)` into the shared pairing
// directory, sends `daemon-pair-request`, prints the owner-approval code, and
// persists `{ account, secret, brokerUid, mode, pairedAt }` at
// `~/.local/state/agent-bot/comms-daemon.json` (0600). The background account
// watch (`createCommsSupervisor`, started by `runDaemon` when a credential
// exists) keeps `account-watch` open with capped exponential backoff (1 s to
// 30 s), emits each wake to an injectable in-process handler, and answers
// through `reportCommsWake` (`wake-report`).
//
// Sibling seam: the daemon's Ed25519 vouch key (ADR-0008 decision 3) is owned
// by the vouch issue. `ensureDaemonKeyPair` below only stewards the key file
// at its ADR path so pairing can send the SPKI public key, and every function
// that needs the key accepts an injected provider instead.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  openSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { loadOrCreateVouchKey, vouchStateDir } from './vouch.mjs';
import {
  createWindowsCommsTransport,
  createWindowsTransportCustody,
  assertWindowsBrokerCustody,
  isWindowsBrokerKey,
  isWindowsSid,
  readWindowsBrokerPin,
} from './comms-windows.mjs';

export const COMMS_PROTOCOL_VERSION = 1;
export const COMMS_MAX_LINE_BYTES = 128 * 1024;
export const COMMS_REQUEST_TIMEOUT_MS = 10_000;
export const COMMS_WATCH_MIN_BACKOFF_MS = 1_000;
export const COMMS_WATCH_MAX_BACKOFF_MS = 30_000;
export const COMMS_OUTCOMES = ['warm', 'cold', 'waiting', 'failed'];

export class CommsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommsError(code, message);
}

// --- paths ---

export function commsPaths({ env = process.env, home = homedir() } = {}) {
  const shared = env.AGENT_COMMS_SHARED_DIR || '/Users/Shared/Public/agent-comms';
  const stateHome = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return {
    shared,
    socket: path.join(shared, 'broker.sock'),
    serviceLabel: env.AGENT_COMMS_SERVICE_LABEL || 'dev.qwts.agent-comms.broker',
    brokerState: path.resolve(env.AGENT_COMMS_BROKER_STATE_DIR || path.join(stateHome, 'agent-comms-broker')),
    // Group brokers use a sticky 1777 proof directory; private brokers use
    // 0700. In both modes the kernel stamps the proof owner.
    proofs: path.join(shared, 'pairing'),
  };
}

function stateHome({ env = process.env, home = homedir() } = {}) {
  return env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
}

export function commsCredentialFile({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_COMMS_DAEMON_PATH) return path.resolve(env.AGENT_BOT_COMMS_DAEMON_PATH);
  return path.join(stateHome({ env, home }), 'agent-bot', 'comms-daemon.json');
}

// ADR-0008 decision 3: the per-account Ed25519 pair lives here. Owned by the
// vouch issue; this module only reads or lazily creates the file.
export function daemonVouchKeyFile({ env = process.env, home = homedir() } = {}) {
  return path.join(stateHome({ env, home }), 'agent-bot', 'vouch-key.pem');
}

// --- credential at rest (0600) ---

function checkCredentialShape(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.account !== 'string' || value.account === ''
    || typeof value.secret !== 'string' || value.secret === ''
    || !(Number.isInteger(value.brokerUid) || isWindowsSid(value.brokerUid))
    || (value.brokerKey !== undefined && !isWindowsBrokerKey(value.brokerKey))
    || (value.mode !== undefined && !['single-account', 'group'].includes(value.mode))
    || typeof value.pairedAt !== 'string'
  ) {
    fail('unpaired', 'the saved comms credential is unreadable; pair again');
  }
  return value;
}

export function loadCommsCredential({ env = process.env, home = homedir(), platform = process.platform,
  windowsCustody = null } = {}) {
  const file = commsCredentialFile({ env, home });
  let raw;
  if (platform === 'win32') {
    try {
      lstatSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      fail('unpaired', 'the saved comms credential could not be read; pair again');
    }
  }
  try {
    if (platform === 'win32') {
      const custody = windowsCustody ?? createWindowsTransportCustody();
      const sid = custody.currentSid();
      custody.assertOwnedDirectory(path.dirname(file), sid);
      custody.assertOwnedFile(file, sid);
    }
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('unpaired', 'the saved comms credential could not be read; pair again');
  }
  try {
    return checkCredentialShape(JSON.parse(raw));
  } catch (error) {
    if (error instanceof CommsError) throw error;
    fail('unpaired', 'the saved comms credential is unreadable; pair again');
  }
}

export function saveCommsCredential(credential, { env = process.env, home = homedir(), platform = process.platform,
  windowsCustody = null } = {}) {
  const file = commsCredentialFile({ env, home });
  checkCredentialShape({ ...credential, pairedAt: credential.pairedAt ?? new Date().toISOString() });
  const shaped = {
    account: credential.account,
    secret: credential.secret,
    brokerUid: credential.brokerUid,
    ...(credential.brokerKey === undefined ? {} : { brokerKey: credential.brokerKey }),
    mode: credential.mode ?? 'group',
    pairedAt: credential.pairedAt ?? new Date().toISOString(),
  };
  if (platform === 'win32') {
    const custody = windowsCustody ?? createWindowsTransportCustody();
    let sid;
    try { sid = custody.currentSid(); } catch {
      fail('unpaired', 'the Windows account SID could not be verified');
    }
    if (shaped.brokerUid !== sid || shaped.mode !== 'single-account' || !shaped.brokerKey) {
      fail('broker-untrusted', 'Windows comms credentials require this account, a pinned broker key, and single-account mode');
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      custody.assertOwnedDirectory(path.dirname(file), sid);
    } catch {
      fail('broker-untrusted', 'the Windows comms credential directory is not owned by this account');
    }
  } else {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  // A unique exclusive temp per call: two pairings in one process (or one
  // PID reused) never write through each other's half-finished file.
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    if (platform === 'win32') {
      const custody = windowsCustody ?? createWindowsTransportCustody();
      const sid = custody.currentSid();
      writeFileSync(temporary, '', { mode: 0o600, flag: 'wx' });
      try {
        custody.restrictPrivateFile(temporary, sid);
      } catch {
        fail('unpaired', 'the Windows comms credential could not be secured');
      }
      const fd = openSync(temporary, 'r+');
      try {
        writeFileSync(fd, `${JSON.stringify(shaped, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
    } else {
      writeFileSync(temporary, `${JSON.stringify(shaped, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(temporary, 0o600);
    }
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return shaped;
}

// File-level pairing state for `daemon status`: never contacts the broker.
export function commsFileStatus({ env = process.env, home = homedir() } = {}) {
  let credential = null;
  try {
    credential = loadCommsCredential({ env, home });
  } catch (error) {
    return { paired: false, error: error.message };
  }
  if (!credential) return { paired: false };
  return { paired: true, account: credential.account, pairedAt: credential.pairedAt };
}

// --- custody (mirrors agent-comms lib/custody.mjs) ---

const STICKY = 0o1000;

function statPath(file, code, message) {
  try {
    return lstatSync(file);
  } catch {
    fail(code, message ?? `${file} does not exist`);
  }
  return null;
}

export function assertCommsAncestors(dir, ownerUid) {
  let current;
  try {
    current = realpathSync(path.dirname(dir));
  } catch {
    fail('broker-untrusted', `${path.dirname(dir)} does not exist`);
  }
  for (;;) {
    const info = statPath(current, 'broker-untrusted');
    if (!info.isDirectory()) fail('broker-untrusted', `${current} is not a directory`);
    if (info.uid !== 0 && info.uid !== ownerUid) {
      fail('broker-untrusted', `${current} is owned by uid ${info.uid}, neither root nor the broker account`);
    }
    if ((info.mode & 0o022) !== 0 && (info.mode & STICKY) === 0) {
      fail('broker-untrusted', `${current} is writable by others and not sticky`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function assertCommsOwnedDir(dir, ownerUid, { mode = null } = {}) {
  const info = statPath(dir, 'broker-untrusted');
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('broker-untrusted', `${dir} is not a real directory`);
  }
  if (info.uid !== ownerUid) {
    fail('broker-untrusted', `${dir} is owned by uid ${info.uid}, not the broker account ${ownerUid}`);
  }
  if (mode !== null && (info.mode & 0o7777) !== mode) {
    fail('broker-untrusted', `${dir} has mode ${(info.mode & 0o7777).toString(8)}, expected ${mode.toString(8)}`);
  }
  return info;
}

export function assertCommsBrokerSocket(file, ownerUid) {
  const info = statPath(file, 'broker-unreachable', `no broker socket at ${file}; is the broker running?`);
  if (!info.isSocket() || info.uid !== ownerUid) {
    fail('broker-untrusted', `${file} is not the broker account's socket`);
  }
}

// Refuse a broker unless its directory, ancestors, and socket belong to the
// pinned broker account. Pairing pins this account for a private broker, or
// the named --broker account for group mode. Later calls use the saved mode
// and uid; credentials predating single-account mode remain group mode.
export function checkBrokerCustody(paths, brokerUid, mode = 'group', {
  platform = process.platform, windowsCustody = null,
} = {}) {
  if (platform === 'win32') {
    if (mode !== 'single-account') fail('platform-not-implemented', 'group broker mode is not supported on Windows');
    if (!isWindowsSid(brokerUid)) fail('broker-untrusted', 'no broker account SID is pinned for this client');
    try {
      assertWindowsBrokerCustody({
        brokerStateDir: paths.brokerState,
        brokerUid,
        mode,
        custody: windowsCustody ?? createWindowsTransportCustody(),
      });
    } catch (error) {
      if (error?.code === 'platform-not-implemented') throw new CommsError(error.code, error.message);
      fail('broker-untrusted', 'the Windows broker identity is not owned by this account');
    }
    return;
  }
  if (!['single-account', 'group'].includes(mode)) {
    fail('broker-untrusted', 'unknown broker mode');
  }
  if (!Number.isInteger(brokerUid)) {
    fail('broker-untrusted', 'no broker account is pinned for this client');
  }
  statPath(paths.socket, 'broker-unreachable', `no broker socket at ${paths.socket}; is the broker running?`);
  if (mode === 'single-account') {
    if (brokerUid !== process.getuid()) fail('broker-untrusted', 'the private broker must belong to this account');
    assertPrivateBrokerCustody(paths, brokerUid);
    return;
  }
  assertCommsAncestors(paths.shared, brokerUid);
  const dir = assertCommsOwnedDir(paths.shared, brokerUid);
  if ((dir.mode & 0o022) !== 0) {
    fail('broker-untrusted', `${paths.shared} is writable by accounts other than the broker's`);
  }
  assertCommsBrokerSocket(paths.socket, brokerUid);
}

// agent-comms ADR-0059: one account owns the entire private rendezvous.
export function assertPrivateBrokerCustody(paths, ownerUid) {
  assertCommsAncestors(paths.shared, ownerUid);
  assertCommsOwnedDir(paths.shared, ownerUid, { mode: 0o700 });
  assertCommsOwnedDir(paths.proofs, ownerUid, { mode: 0o700 });
  assertCommsBrokerSocket(paths.socket, ownerUid);
  if ((statPath(paths.socket, 'broker-unreachable').mode & 0o7777) !== 0o600) {
    fail('broker-untrusted', `${paths.socket} is not a private 0600 socket`);
  }
}

// --- wire framing (mirrors agent-comms lib/wire.mjs) ---

// The limit applies to every line and to whatever is buffered, newline or
// not, so no peer can make this client hold or parse more than one bounded
// line. The first violation stops the reader; the caller drops the socket.
export function commsLineReader(socket, onLine, onError) {
  let buffer = '';
  let stopped = false;
  const stop = (message) => {
    stopped = true;
    buffer = '';
    onError(new CommsError('bad-response', message));
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (stopped) return;
    buffer += chunk;
    let newline;
    while (!stopped && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > COMMS_MAX_LINE_BYTES) {
        stop('line exceeds the protocol limit');
        return;
      }
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        stop('line is not JSON');
        return;
      }
      onLine(value);
    }
    if (!stopped && Buffer.byteLength(buffer) > COMMS_MAX_LINE_BYTES) {
      stop('line exceeds the protocol limit');
    }
  });
}

export const writeCommsLine = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);

function sleepMs(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

function clientOptions(paths, pair, { platform = process.platform, windowsCustody = null,
  windowsCreateConnection = null } = {}) {
  return {
    socketPath: paths.socket,
    brokerUid: pair.brokerUid,
    brokerKey: pair.brokerKey,
    mode: pair.mode ?? 'group',
    serviceLabel: paths.serviceLabel,
    brokerStateDir: paths.brokerState,
    platform,
    windowsCustody,
    windowsCreateConnection,
  };
}

// Capped exponential backoff for the account watch: 1 s, 2 s, 4 s, … to 30 s.
export function nextCommsBackoffMs(currentMs) {
  return Math.min(
    (Number.isInteger(currentMs) && currentMs > 0 ? currentMs : COMMS_WATCH_MIN_BACKOFF_MS) * 2,
    COMMS_WATCH_MAX_BACKOFF_MS,
  );
}

function openCommsConnection(socketPath, fields, { onEvent, signal, timeoutMs = COMMS_REQUEST_TIMEOUT_MS,
  connectionFactory = net.createConnection } = {}) {
  if (!onEvent && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    fail('usage', 'request timeout must be a positive integer of at most 2147483647 milliseconds');
  }
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      socket?.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish();
    if (!onEvent) {
      // A deadline, not an idle timeout: partial replies cannot extend it.
      timer = setTimeout(
        () => finish(new CommsError('broker-timeout', `broker request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    if (settled) return;
    try {
      socket = connectionFactory(socketPath);
    } catch (error) {
      finish(error);
      return;
    }
    socket.on('connect', () => writeCommsLine(socket, { v: COMMS_PROTOCOL_VERSION, ...fields }));
    socket.on('error', (error) => {
      const code = ['broker-untrusted', 'broker-timeout', 'bad-response'].includes(error?.code)
        ? error.code
        : 'broker-unreachable';
      finish(new CommsError(code, code === 'broker-unreachable'
        ? `cannot reach the broker: ${error.code ?? error.message}`
        : error.message));
    });
    socket.on('close', () => finish(new CommsError('broker-unreachable', 'the broker closed the connection')));
    commsLineReader(socket, (line) => {
      if (settled) return;
      if (onEvent && line?.event) {
        onEvent(line);
        return;
      }
      if (line?.ok !== true) {
        finish(new CommsError(line?.error?.code ?? 'internal', line?.error?.message ?? 'request failed'));
      } else if (!onEvent) {
        finish(null, line);
      }
      // A bare `{ ok: true }` on a stream carries no event; the watch stays
      // open for the event lines that follow.
    }, finish);
  });
}

function newRequestId() {
  return randomBytes(8).toString('hex');
}

export class CommsClient {
  constructor({ socketPath, brokerUid, brokerKey, mode = 'group', timeoutMs = COMMS_REQUEST_TIMEOUT_MS,
    serviceLabel = 'dev.qwts.agent-comms.broker', brokerStateDir = null,
    platform = process.platform, windowsCustody = null, windowsCreateConnection = null,
    handshakeTimeoutMs = COMMS_REQUEST_TIMEOUT_MS } = {}) {
    if (typeof socketPath !== 'string' || socketPath === '') fail('usage', 'a broker socket path is required');
    this.socketPath = socketPath;
    this.brokerUid = brokerUid;
    this.brokerKey = brokerKey;
    this.mode = mode;
    this.timeoutMs = timeoutMs;
    this.platform = platform;
    this.serviceLabel = serviceLabel;
    this.brokerStateDir = brokerStateDir;
    this.windowsCustody = windowsCustody;
    this.windowsCreateConnection = windowsCreateConnection;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
  }

  checkCustody(paths = commsPaths()) {
    if (this.platform === 'win32') {
      const effectivePaths = this.brokerStateDir ? { ...paths, brokerState: this.brokerStateDir } : paths;
      checkBrokerCustody(effectivePaths, this.brokerUid, this.mode, {
        platform: this.platform,
        windowsCustody: this.windowsCustody,
      });
      if (!isWindowsBrokerKey(this.brokerKey)) {
        fail('broker-untrusted', 'the saved broker identity is not trusted; pair again');
      }
      return;
    }
    checkBrokerCustody(paths, this.brokerUid, this.mode);
  }

  connectionFactory(paths) {
    if (this.platform !== 'win32') return net.createConnection;
    const custody = this.windowsCustody ?? createWindowsTransportCustody();
    const brokerStateDir = this.brokerStateDir ?? paths.brokerState;
    return () => createWindowsCommsTransport({
      label: this.serviceLabel,
      brokerStateDir,
      brokerUid: this.brokerUid,
      brokerKey: this.brokerKey,
      custody,
      createConnection: this.windowsCreateConnection ?? net.createConnection,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
    });
  }

  // One request line, one reply line. Resolves with `result`; refuses with
  // the broker's `{ code, message }` otherwise. `fields` is `{ op, auth?,
  // ...args }`; `v` and `id` are stamped here.
  async request(fields, { paths = commsPaths(), timeoutMs = this.timeoutMs } = {}) {
    this.checkCustody(paths);
    // The broker answers `{ ok: true, ...result }`: the result's fields sit
    // beside `ok`, not under a `result` key.
    const { ok: _ok, v: _v, id: _id, ...result } = await openCommsConnection(
      this.socketPath, { id: newRequestId(), ...fields }, { timeoutMs, connectionFactory: this.connectionFactory(paths) });
    return result;
  }

  // One request line, then one `onEvent` call per `{ event, ... }` line until
  // the broker closes or `signal` aborts. A broker `{ ok: false }` reply ends
  // the stream with its error; resolving means the watch was aborted.
  async stream(fields, onEvent, { paths = commsPaths(), signal } = {}) {
    if (typeof onEvent !== 'function') fail('usage', 'a watch event handler is required');
    this.checkCustody(paths);
    await openCommsConnection(this.socketPath, { id: newRequestId(), ...fields }, {
      onEvent, signal, connectionFactory: this.connectionFactory(paths),
    });
  }
}

export function uidOfAccount(account) {
  try {
    return Number(execFileSync('/usr/bin/id', ['-u', account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return fail('usage', `no account named ${account} on this machine`);
  }
}

// --- daemon vouch key seam (ADR-0008 decision 3) ---
//
// The vouch key is vouch.mjs's (#254): pairing only needs its SPKI public
// half, and every caller accepts an injected `keyPairProvider` returning a
// PEM string instead. vouch.mjs owns custody: it creates the key with `wx`
// (a racing creator loads the winner, never replaces it), refuses anything
// but an Ed25519 key in a regular file owned by this account, and tightens
// an existing key to 0600.

export function ensureDaemonKeyPair({ env = process.env, home = homedir() } = {}) {
  const key = loadOrCreateVouchKey(vouchStateDir({ env, home }));
  return { path: key.file, publicKeyPem: key.publicKeyPem.toString() };
}

// The daemon pairs as its own credential kind (ADR-0008 decision 4): the same
// kernel-stamped proof file as an account pairing, plus its SPKI public key.
// The owner approves it by code on the admin socket, exactly like an account.
export async function pairDaemonComms({
  env = process.env,
  home = homedir(),
  brokerAccount,
  account = userInfo().username,
  publicKey = null,
  keyPairProvider = null,
  paths = commsPaths({ env, home }),
  clientFactory = (options) => new CommsClient(options),
  uidOfImpl = uidOfAccount,
  now = () => new Date(),
  platform = process.platform,
  windowsCustody = null,
  windowsCreateConnection = null,
} = {}) {
  if (typeof account !== 'string' || account === '') fail('usage', 'a daemon account name is required');
  // Same selection rule as agent-comms: naming an account opts into group
  // mode. Persist it for reconnects; never infer mode from agent-bot gates.
  const mode = brokerAccount ? 'group' : 'single-account';
  let brokerUid;
  let brokerKey;
  if (platform === 'win32') {
    if (brokerAccount) fail('platform-not-implemented', 'group broker mode is not supported on Windows');
    if (!env.AGENT_COMMS_SHARED_DIR) {
      fail('usage', 'AGENT_COMMS_SHARED_DIR must match the Windows broker host configuration');
    }
    const custody = windowsCustody ?? createWindowsTransportCustody();
    try {
      brokerUid = custody.currentSid();
      if (!isWindowsSid(brokerUid)) throw new Error('sid');
      custody.assertOwnedDirectory(paths.shared, brokerUid);
      custody.assertOwnedDirectory(paths.proofs, brokerUid);
    } catch {
      fail('broker-untrusted', 'the Windows broker directories are not owned by this account');
    }
    brokerKey = readWindowsBrokerPin({ brokerStateDir: paths.brokerState, brokerUid, custody });
  } else {
    brokerUid = brokerAccount ? uidOfImpl(brokerAccount) : process.getuid();
    checkBrokerCustody(paths, brokerUid, mode);
    assertCommsOwnedDir(paths.proofs, brokerUid, { mode: mode === 'group' ? 0o1777 : 0o700 });
  }
  const resolvedPublicKey = publicKey ?? (keyPairProvider
    ? await keyPairProvider({ env, home })
    : ensureDaemonKeyPair({ env, home }).publicKeyPem);
  if (typeof resolvedPublicKey !== 'string' || !resolvedPublicKey.includes('BEGIN PUBLIC KEY')) {
    fail('usage', 'a daemon SPKI public key (PEM) is required for pairing');
  }
  const secret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256').update(secret).digest('hex');
  const proof = `${randomBytes(16).toString('hex')}.proof`;
  const proofFile = path.join(paths.proofs, proof);
  try {
    if (platform === 'win32') {
      const custody = windowsCustody ?? createWindowsTransportCustody();
      // Restrict the empty file before writing its proof material. The
      // broker runs as this same account in Windows single-account mode.
      writeFileSync(proofFile, '', { flag: 'wx' });
      custody.restrictPrivateFile(proofFile, brokerUid);
      writeFileSync(proofFile, secretHash);
    } else {
      // The create mode passes through the umask; group brokers must be able
      // to read the proof, so set 0644 explicitly.
      writeFileSync(proofFile, secretHash, { mode: 0o644, flag: 'wx' });
      chmodSync(proofFile, 0o644);
    }
    const client = clientFactory(clientOptions(paths, { brokerUid, brokerKey, mode }, {
      platform, windowsCustody, windowsCreateConnection,
    }));
    const result = await client.request(
      { op: 'daemon-pair-request', account, secretHash, proof, publicKey: resolvedPublicKey },
      { paths },
    );
    saveCommsCredential({ account, secret, brokerUid, brokerKey, mode, pairedAt: now().toISOString() }, {
      env, home, platform, windowsCustody,
    });
    return { account, brokerUid, code: result?.code, state: result?.state };
  } finally {
    rmSync(proofFile, { force: true });
  }
}

function resolvePairCredential(credential, { env, home, platform = process.platform, windowsCustody = null }) {
  if (credential) return checkCredentialShape(credential);
  const loaded = loadCommsCredential({ env, home, platform, windowsCustody });
  if (!loaded) fail('unpaired', 'this daemon is not paired; run `agent-bot daemon pair-comms [--broker ACCOUNT]`');
  return loaded;
}

function checkWakeReport({ agentId, messageIds, outcome, detail }) {
  if (typeof agentId !== 'string' || agentId === '') fail('usage', 'a soul Agent ID is required to report a wake');
  if (!Array.isArray(messageIds) || messageIds.length === 0
    || messageIds.some((id) => typeof id !== 'string' || id === '')) {
    fail('usage', 'at least one message ID is required to report a wake');
  }
  if (!COMMS_OUTCOMES.includes(outcome)) {
    fail('usage', `wake outcome must be one of ${COMMS_OUTCOMES.join(', ')}`);
  }
  if (detail !== undefined && typeof detail !== 'string') fail('usage', 'wake detail must be a string');
}

// Answer one daemon wake (ADR-0008 decision 7): `wake-report { agentId,
// messageIds, outcome, detail }`, authenticated as the paired daemon.
export async function reportCommsWake(
  { agentId, messageIds, outcome, detail = '' },
  {
    credential = null,
    env = process.env,
    home = homedir(),
    paths = commsPaths({ env, home }),
    clientFactory = (options) => new CommsClient(options),
    platform = process.platform,
    windowsCustody = null,
    windowsCreateConnection = null,
  } = {},
) {
  checkWakeReport({ agentId, messageIds, outcome, detail });
  const pair = resolvePairCredential(credential, { env, home, platform, windowsCustody });
  const client = clientFactory(clientOptions(paths, pair, { platform, windowsCustody, windowsCreateConnection }));
  return client.request({
    op: 'wake-report',
    auth: { daemon: pair.account, secret: pair.secret },
    agentId,
    messageIds,
    outcome,
    detail,
  }, { paths });
}

// Launch results use a fresh connection authenticated with the daemon pair.
export async function reportCommsLaunch(
  { requestId, status, agentId = null, detail, code },
  { credential = null, env = process.env, home = homedir(), paths = commsPaths({ env, home }),
    clientFactory = (options) => new CommsClient(options), platform = process.platform,
    windowsCustody = null, windowsCreateConnection = null } = {},
) {
  if (typeof requestId !== 'string' || !requestId
    || !['launched', 'failed'].includes(status)
    || (status === 'launched' && (typeof agentId !== 'string' || !agentId))
    || (status === 'failed' && agentId !== null)
    || (detail !== undefined && typeof detail !== 'string')
    || (code !== undefined && (typeof code !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(code)))) fail('usage', 'invalid launch result');
  const pair = resolvePairCredential(credential, { env, home, platform, windowsCustody });
  const client = clientFactory(clientOptions(paths, pair, { platform, windowsCustody, windowsCreateConnection }));
  return client.request({ op: 'launch-result', auth: { daemon: pair.account, secret: pair.secret },
    requestId, status, agentId, ...(detail === undefined ? {} : { detail }), ...(code === undefined ? {} : { code }) }, { paths });
}

// Progress on a pending launch (`launch-progress`, agent-comms 0.3.12,
// qwts/agent-bot-identity#536): the stage the launch handler is passing, in
// the order it passes them. The broker keeps the latest and shows it in
// `launch-status`; a broker without the op refuses, and callers treat that
// as best effort.
export const LAUNCH_STAGES = Object.freeze([
  'checking', 'account', 'runtimes', 'tool-home', 'provider', 'sign-in', 'joining', 'harness', 'session',
]);
export async function reportCommsLaunchProgress(
  { requestId, stage },
  { credential = null, env = process.env, home = homedir(), paths = commsPaths({ env, home }),
    clientFactory = (options) => new CommsClient(options), platform = process.platform,
    windowsCustody = null, windowsCreateConnection = null } = {},
) {
  if (typeof requestId !== 'string' || !requestId || !LAUNCH_STAGES.includes(stage)) fail('usage', 'invalid launch progress');
  const pair = resolvePairCredential(credential, { env, home, platform, windowsCustody });
  const client = clientFactory(clientOptions(paths, pair, { platform, windowsCustody, windowsCreateConnection }));
  return client.request({ op: 'launch-progress', auth: { daemon: pair.account, secret: pair.secret }, requestId, stage }, { paths });
}

function checkWakeEvent(event) {
  if (!event || typeof event !== 'object'
    || typeof event.agentId !== 'string' || event.agentId === ''
    || !Array.isArray(event.messageIds) || event.messageIds.length === 0) {
    fail('bad-response', 'the broker sent a malformed wake event');
  }
  return event;
}

// The account-wide wake stream (ADR-0008 decision 7). Keeps `account-watch`
// open with `auth: { daemon: <account>, secret }`, reconnecting with capped
// exponential backoff (1 s to 30 s). Every wake goes to the in-process
// `onWake` handler — inject the sibling's warm-pool/cold-wake decision there;
// the default records the wake and answers `waiting`, because cold wake is
// off unless the owner turns it on per soul (ADR-0008 decision 9).
export function createCommsSupervisor({
  env = process.env,
  home = homedir(),
  credential = null,
  paths = commsPaths({ env, home }),
  clientFactory = (options) => new CommsClient(options),
  onWake = null,
  onLaunch = null,
  sleepImpl = sleepMs,
  now = () => new Date(),
  platform = process.platform,
  windowsCustody = null,
  windowsCreateConnection = null,
} = {}) {
  const state = {
    connected: false,
    lastWakeAt: null,
    lastWake: null,
    lastError: null,
    reconnects: 0,
  };
  let stopped = false;
  let backoffMs = COMMS_WATCH_MIN_BACKOFF_MS;
  const stopController = new AbortController();

  const windowsOptions = { platform, windowsCustody, windowsCreateConnection };
  const reportFor = (pair) => (fields) => reportCommsWake(fields, {
    credential: pair, env, home, paths, clientFactory, ...windowsOptions,
  });

  const launchPorts = (pair) => ({ account: pair.account,
    report: (fields) => reportCommsLaunch(fields, {
      credential: pair, env, home, paths, clientFactory, ...windowsOptions,
    }),
    progress: (fields) => reportCommsLaunchProgress(fields, {
      credential: pair, env, home, paths, clientFactory, ...windowsOptions,
    }) });

  const handleWake = onWake ?? (async (wake, { report }) => {
    await report({ agentId: wake.agentId, messageIds: wake.messageIds, outcome: 'waiting', detail: 'cold wake is not enabled' });
  });

  function noteError(error) {
    state.lastError = error?.code && error?.message
      ? `${error.code}: ${error.message}`
      : String(error?.message ?? error);
  }

  async function watchOnce(pair, signal) {
    const client = clientFactory(clientOptions(paths, pair, windowsOptions));
    await client.stream(
      { op: 'account-watch', auth: { daemon: pair.account, secret: pair.secret } },
      (event) => {
        if (event?.event === 'ready' || event?.ok === true) {
          state.connected = true;
          state.lastError = null;
          backoffMs = COMMS_WATCH_MIN_BACKOFF_MS;
          Promise.resolve().then(() => onLaunch?.recover?.(launchPorts(pair))).catch(noteError);
          return;
        }
        if (event?.event === 'launch') {
          Promise.resolve().then(() => onLaunch
            ? onLaunch(event, launchPorts(pair))
            : launchPorts(pair).report({ requestId: event.requestId, status: 'failed', agentId: null,
              detail: 'daemon launch handler is unavailable' })).catch(noteError);
          return;
        }
        if (event?.event !== 'wake') return;
        let wake;
        try {
          wake = checkWakeEvent(event);
        } catch (error) {
          noteError(error);
          return;
        }
        state.lastWakeAt = now().toISOString();
        state.lastWake = {
          agentId: wake.agentId,
          count: wake.count ?? wake.messageIds.length,
          cursor: wake.cursor ?? null,
          messageIds: wake.messageIds,
        };
        Promise.resolve()
          .then(() => handleWake(wake, { report: reportFor(pair) }))
          .catch(noteError);
      },
      { paths, signal },
    );
  }

  async function supervise() {
    while (!stopped) {
      let pair = credential;
      if (!pair) {
        try {
          pair = loadCommsCredential({ env, home, platform, windowsCustody });
        } catch (error) {
          noteError(error);
        }
      }
      if (!pair) {
        state.lastError = state.lastError?.startsWith('unpaired:')
          ? state.lastError
          : 'unpaired: this daemon is not paired; run `agent-bot daemon pair-comms [--broker ACCOUNT]`';
        await sleepImpl(backoffMs, stopController.signal);
        backoffMs = nextCommsBackoffMs(backoffMs);
        continue;
      }
      try {
        await watchOnce(pair, stopController.signal);
      } catch (error) {
        if (!stopped) noteError(error);
      }
      state.connected = false;
      if (stopped) break;
      state.reconnects += 1;
      await sleepImpl(backoffMs, stopController.signal);
      backoffMs = nextCommsBackoffMs(backoffMs);
    }
  }

  return {
    getState() {
      return { ...state };
    },
    report(fields) {
      const pair = credential ?? loadCommsCredential({ env, home });
      if (!pair) fail('unpaired', 'this daemon is not paired; run `agent-bot daemon pair-comms [--broker ACCOUNT]`');
      return reportFor(pair)(fields);
    },
    start() {
      supervise().catch(noteError);
    },
    stop() {
      stopped = true;
      stopController.abort();
    },
  };
}

// Live-plus-file comms state for `daemon status` and `GET /v0/comms/status`.
export function readCommsStatus({ env = process.env, home = homedir(), live = null } = {}) {
  return {
    ...commsFileStatus({ env, home }),
    ...(live ?? { connected: false, lastWakeAt: null, lastWake: null, lastError: null, reconnects: 0 }),
  };
}
