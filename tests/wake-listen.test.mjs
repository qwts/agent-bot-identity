import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hermeticGitEnv } from './helpers/hermetic-git.mjs';
import { PROOF_HEADER, bindingKey, checkBindingProof, parseBindingProof } from '../binding-proof.mjs';
import {
  BACKOFF,
  BINDING_ENV,
  BINDING_FILE,
  BINDING_HEADER,
  OPCODE,
  WAKE_PATH,
  backoffDelay,
  bindingPath,
  connectWake,
  frameLine,
  isLoopbackHost,
  listenWake,
  main,
  parseWakeArgs,
  readBinding,
  sessionContext,
  wakeHelpText,
  wakeInstruction,
  wakeUrl,
  websocketAccept,
  wakeProof,
} from '../wake-listen.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listener = path.join(repo, 'wake-listen.mjs');

const root = mkdtempSync(path.join(tmpdir(), 'wake-listen-'));
after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function scratch() {
  seq += 1;
  // realpath, because macOS hands out /var and git answers /private/var, and
  // half these tests compare paths.
  return realpathSync(mkdtempSync(path.join(root, `s${seq}-`)));
}

const AGENT_ID = 'agent_01wake';
const SECRET = 'wake-binding-secret';
const SLUG = 'qwts-qwen-agent';
// Small enough that a reconnect costs nothing, capped so growth is visible.
const FAST = Object.freeze({ initialMs: 5, maxMs: 40, factor: 2 });
const noSleep = async () => {};

function writeBinding(dir, fields = {}, mode = 0o600) {
  const file = path.join(dir, BINDING_FILE);
  writeFileSync(
    file,
    `${JSON.stringify({
      v: 1, agentId: AGENT_ID, daemon: 'http://127.0.0.1:9', secret: SECRET, ...fields,
    })}\n`,
  );
  // writeFileSync's mode is masked by the umask, and the checks under test read
  // the real permission bits.
  chmodSync(file, mode);
  return file;
}

function hermeticGit(args, { cwd }) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: hermeticGitEnv(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Ambient GIT_DIR/GIT_CONFIG_* on a host would change what an in-process git
// call resolves, so the default path is exercised hermetically.
const hermeticReadBinding = (options = {}) => readBinding({ ...options, git: hermeticGit });

const BOUND = Object.freeze({
  path: '/tmp/nowhere/agent-binding.json',
  v: 1,
  agentId: AGENT_ID,
  parent: null,
  account: null,
  daemon: 'http://127.0.0.1:9',
  secret: SECRET,
});

// --- a stub wake plane -----------------------------------------------------------

// A server must not mask what it sends (RFC 6455 5.1), which is the one half
// encodeFrame cannot be reused for.
function serverFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const huge = body.length > 0xffff;
  const wide = !huge && body.length >= 126;
  const header = Buffer.alloc(huge ? 10 : wide ? 4 : 2);
  header[0] = 0x80 | opcode;
  header[1] = huge ? 127 : wide ? 126 : body.length;
  if (wide) header.writeUInt16BE(body.length, 2);
  if (huge) header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

// Keeps the mask bit, because "the client masked this" is precisely what a real
// daemon enforces and what a regression in encodeFrame would silently drop.
function createServerSideParser(onFrame) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 2) return;
        const opcode = pending[0] & 0x0f;
        const masked = (pending[1] & 0x80) !== 0;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < offset + 2) return;
          length = pending.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (pending.length < offset + 8) return;
          length = Number(pending.readBigUInt64BE(offset));
          offset += 8;
        }
        if (masked) offset += 4;
        if (pending.length < offset + length) return;
        const maskKey = masked ? pending.subarray(offset - 4, offset) : null;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        if (maskKey) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= maskKey[index & 3];
          }
        }
        pending = pending.subarray(offset + length);
        onFrame({ opcode, masked, payload });
      }
    },
  };
}

async function startStub({ secret = SECRET, onConnection = null } = {}) {
  const attempts = [];
  const connections = [];
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such route');
  });
  server.on('upgrade', (req, socket, head) => {
    // The client presents a proof (#270), never the secret itself.
    const proof = parseBindingProof(req.headers[PROOF_HEADER]);
    // The port captured at listen: a late reconnect can land after close().
    const authority = `127.0.0.1:${port}`;
    const valid = proof !== null
      && checkBindingProof(proof, bindingKey(secret), { method: req.method, path: req.url, authority });
    attempts.push({ path: req.url, proved: valid, bare: req.headers[BINDING_HEADER] ?? null });
    // Set before a refusal too: the client may reset while the 403 is in flight.
    socket.on('error', () => {});
    if (req.url !== WAKE_PATH || !valid) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${websocketAccept(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    const connection = {
      socket,
      received: [],
      send(value) {
        socket.write(serverFrame(OPCODE.text, Buffer.from(JSON.stringify(value), 'utf8')));
      },
      sendText(text) {
        socket.write(serverFrame(OPCODE.text, Buffer.from(text, 'utf8')));
      },
      ping(payload = '') {
        socket.write(serverFrame(OPCODE.ping, Buffer.from(payload, 'utf8')));
      },
      drop() {
        socket.destroy();
      },
      frame(opcode) {
        return waitFor(() => connection.received.find((frame) => frame.opcode === opcode));
      },
    };
    const parser = createServerSideParser((frame) => connection.received.push(frame));
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', () => {});
    connections.push(connection);
    if (head && head.length > 0) parser.push(head);
    onConnection?.(connection);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    daemon: `http://127.0.0.1:${port}`,
    attempts,
    connections,
    connection: () => waitFor(() => connections[0], { describe: 'a connection' }),
    async stop() {
      for (const connection of connections) connection.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- stream capture --------------------------------------------------------------

async function waitFor(find, { timeoutMs = 5000, describe = 'a condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function textCapture() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
      return true;
    },
  };
}

// Every line this stream produces is parsed, so a frame that arrived as half a
// line — or as pretty-printed JSON — fails here instead of in a harness.
function ndjson() {
  const lines = [];
  const waiters = [];
  let partial = '';
  return {
    lines,
    write(chunk) {
      partial += chunk;
      let index = partial.indexOf('\n');
      while (index >= 0) {
        lines.push(JSON.parse(partial.slice(0, index)));
        partial = partial.slice(index + 1);
        index = partial.indexOf('\n');
        for (const resolve of waiters.splice(0)) resolve();
      }
      return true;
    },
    until(predicate, describe = 'a line') {
      return waitFor(() => lines.find(predicate), { describe });
    },
    count(event) {
      return lines.filter((line) => line.event === event).length;
    },
  };
}

// --- the listener ------------------------------------------------------------------

test('a listener holds the socket and prints one NDJSON line per frame', async () => {
  const stub = await startStub({
    onConnection: (connection) => {
      connection.send({ event: 'ready', agentId: AGENT_ID });
      connection.send({ event: 'wake', messages: 2 });
    },
  });
  const dir = scratch();
  const file = writeBinding(dir, { daemon: stub.daemon });
  const controller = new AbortController();
  const stdout = ndjson();
  const finished = listenWake({
    env: { [BINDING_ENV]: file },
    cwd: dir,
    stdout,
    stderr: textCapture(),
    signal: controller.signal,
    sleep: noSleep,
    backoff: FAST,
  });

  await stdout.until((line) => line.event === 'wake', 'a wake line');
  controller.abort();
  assert.equal(await finished, 0, 'a stopped listener exits 0');

  assert.deepEqual(stdout.lines.slice(0, 3), [
    // The connection is announced before anything that rode in on it, so a
    // harness reading the stream never meets a wake from nowhere.
    { event: 'connected', agentId: AGENT_ID },
    { event: 'ready', agentId: AGENT_ID },
    { event: 'wake', messages: 2 },
  ]);
  assert.deepEqual(stdout.lines.at(-1), { event: 'stopped' });
  assert.deepEqual(stub.attempts, [{ path: WAKE_PATH, proved: true, bare: null }]);
  await stub.stop();
});

test('pings are answered, and every frame the client sends is masked', async () => {
  const stub = await startStub({ onConnection: (connection) => connection.ping('heartbeat') });
  const dir = scratch();
  const file = writeBinding(dir, { daemon: stub.daemon });
  const controller = new AbortController();
  const stdout = ndjson();
  const finished = listenWake({
    env: { [BINDING_ENV]: file },
    cwd: dir,
    stdout,
    stderr: textCapture(),
    signal: controller.signal,
    sleep: noSleep,
    backoff: FAST,
  });

  const connection = await stub.connection();
  // A daemon that health-checks its wake sockets drops an idle session out of
  // the warm pool unless the ping is answered.
  const pong = await connection.frame(OPCODE.pong);
  assert.equal(pong.payload.toString('utf8'), 'heartbeat', 'the pong echoes the ping payload');
  assert.equal(pong.masked, true, 'an unmasked client frame must fail the connection');
  // A ping is not a wake: none of it reaches the harness's stream.
  assert.deepEqual(stdout.lines, [{ event: 'connected', agentId: AGENT_ID }]);

  controller.abort();
  assert.equal(await finished, 0);
  const close = await connection.frame(OPCODE.close);
  assert.equal(close.masked, true);
  assert.equal(
    close.payload.readUInt16BE(0),
    1000,
    'the listener closes politely, so the daemon sees the session leave at once',
  );
  await stub.stop();
});

test('the listener reconnects after the daemon drops the socket', async () => {
  let seen = 0;
  const stub = await startStub({
    onConnection: (connection) => {
      seen += 1;
      if (seen === 1) connection.drop();
      else connection.send({ event: 'wake', messages: 1 });
    },
  });
  const dir = scratch();
  const file = writeBinding(dir, { daemon: stub.daemon });
  const controller = new AbortController();
  const stdout = ndjson();
  const finished = listenWake({
    env: { [BINDING_ENV]: file },
    cwd: dir,
    stdout,
    stderr: textCapture(),
    signal: controller.signal,
    sleep: noSleep,
    backoff: FAST,
  });

  await stdout.until(() => stdout.count('connected') >= 2, 'a second connection');
  await stdout.until((line) => line.event === 'wake', 'a wake after the reconnect');

  assert.equal(stdout.count('disconnected'), 1);
  const [dropped] = stdout.lines.filter((line) => line.event === 'disconnected');
  assert.equal(dropped.retryInMs, FAST.initialMs, 'a connection that was up restarts the backoff');
  assert.ok(dropped.reason.length > 0, 'the reason is what a harness prints when the pool goes cold');

  controller.abort();
  assert.equal(await finished, 0);
  await stub.stop();
});

test('a daemon that refuses the binding grows the delay toward the cap', async () => {
  // The stub only accepts its own secret, so this is the wrong-credential path:
  // a plain HTTP answer where an upgrade was asked for.
  const stub = await startStub({ secret: 'some-other-secret' });
  const dir = scratch();
  const file = writeBinding(dir, { daemon: stub.daemon });
  const controller = new AbortController();
  const stdout = ndjson();
  const finished = listenWake({
    env: { [BINDING_ENV]: file },
    cwd: dir,
    stdout,
    stderr: textCapture(),
    signal: controller.signal,
    sleep: noSleep,
    backoff: FAST,
  });

  await stdout.until(() => stdout.count('disconnected') >= 2, 'two refusals');
  controller.abort();
  assert.equal(await finished, 0);

  const delays = stdout.lines
    .filter((line) => line.event === 'disconnected')
    .map((line) => line.retryInMs);
  assert.deepEqual(delays.slice(0, 2), [FAST.initialMs, FAST.initialMs * FAST.factor]);
  assert.ok(
    delays.every((delay) => delay <= FAST.maxMs),
    'the delay grows toward the cap and stops there',
  );
  assert.match(
    stdout.lines[0].reason,
    /HTTP 403/,
    'a refusal is reported the way the daemon answered it',
  );
  assert.equal(stub.connections.length, 0, 'a refused upgrade never becomes a connection');
  await stub.stop();
});

test('the handshake budget does not kill an established wake socket', async () => {
  const stub = await startStub();
  const controller = new AbortController();
  const texts = [];
  const url = wakeUrl(stub.daemon);
  const connection = await connectWake({
    url,
    headers: { [PROOF_HEADER]: wakeProof(SECRET, url) },
    timeoutMs: 100,
    signal: controller.signal,
    onText: (text) => texts.push(text),
  });
  // Past the handshake budget: the socket belongs to the session now, and a
  // timer left armed would drop every session out of the warm pool shortly
  // after it arrived.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const server = await stub.connection();
  server.send({ event: 'wake' });
  await waitFor(() => texts.length > 0, { describe: 'a frame after the handshake budget' });
  assert.equal(connection.socket.destroyed, false);

  connection.sendClose();
  controller.abort();
  await connection.closed;
  await stub.stop();
});

test('an unbound worktree exits nonzero and says unbound', async () => {
  const dir = scratch();
  const stdout = ndjson();
  const stderr = textCapture();
  const code = await listenWake({
    env: {},
    cwd: dir,
    stdout,
    stderr,
    readBinding: hermeticReadBinding,
    signal: new AbortController().signal,
    sleep: noSleep,
    backoff: FAST,
  });
  assert.equal(code, 1);
  assert.deepEqual(stdout.lines, [], 'nothing is announced before a socket exists');
  assert.match(stderr.text, /^wake: unbound/);
  assert.match(stderr.text, new RegExp(BINDING_ENV), 'the message names the escape hatch');
  assert.match(stderr.text, new RegExp(BINDING_FILE));
});

test('a binding that names a non-loopback daemon is refused before any connection', async () => {
  const stub = await startStub();
  const dir = scratch();
  const file = writeBinding(dir, { daemon: 'http://198.51.100.7:9' });
  const stdout = ndjson();
  const stderr = textCapture();
  // Retrying forever here would mean a corrupt binding spins silently while the
  // one property that makes the secret safe to present is missing.
  const code = await listenWake({
    env: { [BINDING_ENV]: file },
    cwd: dir,
    stdout,
    stderr,
    signal: new AbortController().signal,
    sleep: noSleep,
    backoff: FAST,
  });
  assert.equal(code, 1);
  assert.match(stderr.text, /non-loopback host: 198\.51\.100\.7/);
  assert.deepEqual(stdout.lines, []);
  assert.deepEqual(stub.attempts, [], 'nothing is connected to in order to prove the point');
  await stub.stop();
});

test('the CLI exits nonzero on an unbound worktree, and prints help on request', () => {
  const dir = scratch();
  const env = hermeticGitEnv(process.env, { AGENT_BOT_BINDING: '', HOME: dir });
  const listen = spawnSync(process.execPath, [listener, 'listen'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(listen.status, 1);
  assert.match(listen.stderr, /^wake: unbound/);
  assert.equal(listen.stdout, '');

  const help = spawnSync(process.execPath, [listener, '--help'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /wake listen/);
  assert.match(help.stdout, /session-context/);

  const bogus = spawnSync(process.execPath, [listener, 'bogus'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /usage: agent-bot wake/);
});

// --- reading the binding -----------------------------------------------------------

test('a stated binding wins over the worktree file', () => {
  const dir = scratch();
  const stated = path.join(dir, 'child.json');
  writeFileSync(
    stated,
    JSON.stringify({
      v: 1, agentId: 'agent_child', daemon: 'http://127.0.0.1:9', secret: 'child-secret',
    }),
  );
  chmodSync(stated, 0o600);
  assert.notEqual(stated, writeBinding(dir));
  assert.equal(
    bindingPath({ env: { [BINDING_ENV]: 'child.json' }, cwd: dir, git: hermeticGit }),
    stated,
    'the child is the child, not the parent that spawned it',
  );
  assert.equal(
    readBinding({ env: { [BINDING_ENV]: stated }, cwd: dir, git: hermeticGit }).agentId,
    'agent_child',
  );
});

test('the default binding is read from the git dir', () => {
  const dir = scratch();
  execFileSync('git', ['init', '--quiet', dir], { env: hermeticGitEnv(process.env), stdio: 'ignore' });
  const gitDir = realpathSync(hermeticGit(['rev-parse', '--absolute-git-dir'], { cwd: dir }).trim());
  const file = writeBinding(gitDir);

  assert.equal(realpathSync(bindingPath({ env: {}, cwd: dir, git: hermeticGit })), file);
  const binding = readBinding({ env: {}, cwd: dir, git: hermeticGit });
  assert.equal(binding.agentId, AGENT_ID);
  assert.equal(binding.v, 1);
  assert.equal(binding.parent, null);
  assert.equal(binding.account, null);

  // No git at all is an absent binding, not a fault: this runs in a human's
  // checkout too.
  const outside = scratch();
  assert.equal(bindingPath({ env: {}, cwd: outside, git: hermeticGit }), null);
  assert.equal(readBinding({ env: {}, cwd: outside, git: hermeticGit }), null);
});

test('a binding that is not a private caller-owned file is refused', () => {
  const dir = scratch();

  const loose = writeBinding(dir, {}, 0o644);
  assert.throws(
    () => hermeticReadBinding({ env: { [BINDING_ENV]: loose }, cwd: dir }),
    /is mode 0644; the daemon writes it 0600/,
  );

  const target = writeBinding(dir);
  const link = path.join(dir, 'link.json');
  symlinkSync(target, link);
  assert.throws(
    () => hermeticReadBinding({ env: { [BINDING_ENV]: link }, cwd: dir }),
    /is not a regular file/,
    'following a symlink would present somebody else\'s secret',
  );

  assert.throws(
    () => readBinding({
      env: { [BINDING_ENV]: target }, cwd: dir, git: hermeticGit, uid: process.getuid() + 1,
    }),
    /is owned by uid/,
  );

  assert.equal(
    hermeticReadBinding({ env: { [BINDING_ENV]: path.join(dir, 'missing.json') }, cwd: dir }),
    null,
  );
});

test('an unusable binding is refused without quoting its contents', () => {
  const dir = scratch();
  for (const shape of [
    { v: 2, agentId: AGENT_ID, daemon: 'http://127.0.0.1:9', secret: SECRET },
    { v: 1, agentId: '', daemon: 'http://127.0.0.1:9', secret: SECRET },
    { v: 1, agentId: AGENT_ID, daemon: '', secret: SECRET },
    { v: 1, agentId: AGENT_ID, daemon: 'http://127.0.0.1:9' },
    [],
  ]) {
    const file = writeBinding(dir);
    writeFileSync(file, JSON.stringify(shape));
    chmodSync(file, 0o600);
    assert.throws(
      () => hermeticReadBinding({ env: { [BINDING_ENV]: file }, cwd: dir }),
      /unsupported shape/,
    );
  }

  // A JSON parse error can quote the text it failed on, and this text is a
  // credential.
  const garbage = path.join(dir, 'garbage.json');
  writeFileSync(garbage, `{"v":1,"secret":"${SECRET}",oops}\n`);
  chmodSync(garbage, 0o600);
  assert.throws(
    () => hermeticReadBinding({ env: { [BINDING_ENV]: garbage }, cwd: dir }),
    (error) => {
      assert.equal(error.message.includes(SECRET), false, 'the secret must not reach a log');
      assert.match(error.message, /could not be read/);
      return true;
    },
  );
});

// --- the pure halves ---------------------------------------------------------------

test('the wake URL is loopback http only', () => {
  assert.equal(wakeUrl('http://127.0.0.1:8123'), `http://127.0.0.1:8123${WAKE_PATH}`);
  assert.equal(wakeUrl('http://[::1]:8123'), `http://[::1]:8123${WAKE_PATH}`);
  assert.equal(wakeUrl('http://localhost:8123'), `http://localhost:8123${WAKE_PATH}`);
  assert.throws(() => wakeUrl('https://127.0.0.1:8123'), /must be loopback http, not https:/);
  assert.throws(() => wakeUrl('http://daemon.internal:8123'), /non-loopback host/);
  assert.equal(isLoopbackHost('127.9.9.9'), true);
  assert.equal(isLoopbackHost('128.0.0.1'), false);
  // The RFC 6455 worked example: proof the accept value is the real derivation
  // and not a hash of something else.
  assert.equal(websocketAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('a frame becomes exactly one NDJSON line', () => {
  assert.deepEqual(frameLine('{"event":"wake","messages":1}'), { event: 'wake', messages: 1 });
  assert.deepEqual(
    frameLine('{"event":"wake"}\n{"event":"wake"}'),
    { event: 'frame', text: '{"event":"wake"}\n{"event":"wake"}' },
    'a frame that would break the line protocol is wrapped, not printed raw',
  );
  assert.deepEqual(frameLine('not json'), { event: 'frame', text: 'not json' });
  assert.deepEqual(
    frameLine('[1,2]'),
    { event: 'frame', text: '[1,2]' },
    'a reader meets an object, never a bare array',
  );
  assert.deepEqual(frameLine('null'), { event: 'frame', text: 'null' });
});

test('reconnect backoff is capped', () => {
  assert.equal(backoffDelay(0), BACKOFF.initialMs);
  assert.equal(backoffDelay(1), BACKOFF.initialMs * BACKOFF.factor);
  assert.equal(backoffDelay(64), BACKOFF.maxMs);
  assert.equal(backoffDelay(-1, FAST), FAST.initialMs);
});

test('the command line admits exactly two operations', () => {
  assert.deepEqual(parseWakeArgs([]), { kind: 'help' });
  assert.deepEqual(parseWakeArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseWakeArgs(['listen']), { kind: 'listen', harness: null });
  assert.deepEqual(parseWakeArgs(['session-context', '--harness', 'claude']), {
    kind: 'session-context',
    harness: 'claude',
  });
  assert.match(wakeHelpText(), /wake plane/);
  assert.match(wakeHelpText(), /NDJSON/, 'the help says what the stream is');
  assert.throws(() => parseWakeArgs(['bogus']), /usage: agent-bot wake/);
  assert.throws(() => parseWakeArgs(['listen', '--nope']), /unknown option: --nope/);
  assert.throws(() => parseWakeArgs(['listen', '--harness']), /--harness requires a value/);
});

// --- the SessionStart instruction ---------------------------------------------------

test('the instruction names the watcher the harness actually has', () => {
  const claude = wakeInstruction({ harness: 'claude' });
  assert.match(claude, /agent-bot wake listen/);
  assert.match(claude, /the Monitor tool/, 'Claude Code arms this under Monitor, by name');
  assert.match(claude, /agent-comms inbox --full/);
  assert.match(claude, /ack/);
  assert.match(claude, /background/, 'never in the foreground of a turn');
  assert.match(wakeInstruction({ harness: 'cursor' }), /a background task/);
  assert.match(wakeInstruction({}), /a persistent background task/);
  assert.equal(wakeInstruction({ harness: 'nonsense' }), wakeInstruction({}));
});

test('session start says nothing outside bot territory', () => {
  // A human's own checkout: no stated identity, so nothing is injected — and
  // this hook runs on every session start there is.
  assert.deepEqual(
    sessionContext({ env: {}, cwd: root, resolveSlug: () => null, readBinding: () => BOUND }),
    { context: null, note: null },
  );
  // Detection is off, so a harness that would resolve to a bot says nothing on
  // inference alone.
  const detect = [];
  sessionContext({
    env: {},
    cwd: root,
    resolveSlug: (options) => {
      detect.push(options.detect);
      return null;
    },
    readBinding: () => BOUND,
  });
  assert.deepEqual(detect, [false]);
});

test('session start says nothing without a binding, and never fails the start', () => {
  const resolveSlug = () => SLUG;
  assert.deepEqual(
    sessionContext({ env: {}, cwd: root, resolveSlug, readBinding: () => null }),
    { context: null, note: null },
  );

  const broken = sessionContext({
    env: {},
    cwd: root,
    resolveSlug,
    readBinding: () => {
      throw new Error('the binding at /x is mode 0644');
    },
  });
  assert.equal(broken.context, null);
  assert.match(broken.note, /mode 0644/, 'reported on stderr, not thrown into the session start');

  const unresolved = sessionContext({
    env: {},
    cwd: root,
    resolveSlug: () => {
      throw new Error('no active profile for that App');
    },
    readBinding: () => BOUND,
  });
  assert.equal(unresolved.context, null);
  assert.match(unresolved.note, /no active profile/);
});

test('session start injects the standing instruction inside bot territory', () => {
  const result = sessionContext({
    env: {}, cwd: root, resolveSlug: () => SLUG, readBinding: () => BOUND,
  });
  assert.equal(result.note, null);
  assert.equal(result.slug, SLUG);
  assert.equal(result.agentId, AGENT_ID);
  assert.equal(result.context, wakeInstruction({}));

  // The runner's env mirror words it for the harness that is actually running,
  // so the hook shim needs no arguments.
  assert.match(
    sessionContext({
      env: { AGENT_HOOK_HARNESS: 'claude' },
      cwd: root,
      resolveSlug: () => SLUG,
      readBinding: () => BOUND,
    }).context,
    /the Monitor tool/,
  );
  // An explicit flag still outranks the mirror.
  assert.match(
    sessionContext({
      env: { AGENT_HOOK_HARNESS: 'claude' },
      cwd: root,
      harness: 'cursor',
      resolveSlug: () => SLUG,
      readBinding: () => BOUND,
    }).context,
    /a background task/,
  );
});

test('the session-context command speaks the runner protocol, or stays silent', async () => {
  const stdout = textCapture();
  const stderr = textCapture();
  const code = await main(['session-context', '--harness', 'claude'], {
    stdout, stderr, env: {}, cwd: root, resolveSlug: () => SLUG, readBinding: () => BOUND,
  });
  assert.equal(code, 0);
  const [prefix, payload, ...rest] = stdout.text.split('agent-hook: ');
  assert.deepEqual([prefix, rest], ['', []], 'exactly one line, in the runner protocol');
  const parsed = JSON.parse(payload);
  assert.equal(parsed.decision, 'allow', 'an injection is never a verdict');
  assert.match(parsed.context, /agent-bot wake listen/);
  assert.match(parsed.context, /the Monitor tool/);
  assert.equal(stderr.text, '');

  const quiet = textCapture();
  assert.equal(
    await main(['session-context'], {
      stdout: quiet,
      stderr: textCapture(),
      env: {},
      cwd: root,
      resolveSlug: () => null,
      readBinding: () => BOUND,
    }),
    0,
  );
  assert.equal(quiet.text, '', 'a human session is told nothing');

  const help = textCapture();
  assert.equal(await main(['help'], { stdout: help, stderr: textCapture(), env: {} }), 0);
  assert.match(help.text, /wake listen/);
});

test('a fragmented message is capped as a whole, not frame by frame', async () => {
  const piece = Buffer.alloc(600 * 1024, 0x61);
  const stub = await startStub({
    onConnection: (connection) => {
      // Each frame is under the cap; together they are over it.
      const first = serverFrame(OPCODE.text, piece);
      first[0] &= 0x7f;
      const second = serverFrame(OPCODE.continuation, piece);
      second[0] &= 0x7f;
      connection.socket.write(first);
      connection.socket.write(second);
    },
  });
  const dir = scratch();
  const file = writeBinding(dir, { daemon: stub.daemon });
  const controller = new AbortController();
  const stdout = ndjson();
  const finished = listenWake({
    env: { [BINDING_ENV]: file },
    cwd: dir,
    stdout,
    stderr: textCapture(),
    signal: controller.signal,
    sleep: noSleep,
    backoff: FAST,
  });
  await stdout.until((line) => line.event === 'disconnected', 'the capped disconnect');
  controller.abort();
  assert.equal(await finished, 0);
  const dropped = stdout.lines.find((line) => line.event === 'disconnected');
  assert.match(dropped.reason, /fragmented WebSocket message passed the \d+ byte cap/);
  assert.equal(stdout.lines.some((line) => line.event === 'frame'), false);
  await stub.stop();
});

test('a binding revoked while the listener holds it stops the listener', async () => {
  const reads = [BOUND, null];
  const attempts = [];
  const stdout = ndjson();
  const stderr = textCapture();
  const code = await listenWake({
    env: {},
    cwd: '/tmp',
    stdout,
    stderr,
    readBinding: () => reads.shift() ?? null,
    connect: async ({ headers }) => {
      attempts.push(headers);
      throw new Error('the daemon answered HTTP 403 instead of upgrading');
    },
    signal: new AbortController().signal,
    sleep: noSleep,
    backoff: FAST,
  });
  assert.equal(code, 1);
  assert.equal(attempts.length, 1, 'the revoked binding is never presented again');
  assert.equal(JSON.stringify(attempts).includes(SECRET), false, 'the secret itself is never presented');
  assert.deepEqual(stdout.lines.at(-1), { event: 'unbound' });
  assert.match(stderr.text, /^wake: unbound — the binding was revoked or removed/);
});

test('stopping during a long backoff does not leave its timer holding the process', () => {
  const script = `
    import { listenWake } from ${JSON.stringify(listener)};
    const controller = new AbortController();
    const started = Date.now();
    const code = await listenWake({
      env: {},
      cwd: '/tmp',
      stdout: { write: (text) => { if (text.includes('disconnected')) setTimeout(() => controller.abort(), 10); } },
      stderr: { write() {} },
      readBinding: () => (${JSON.stringify(BOUND)}),
      connect: async () => { throw new Error('refused'); },
      signal: controller.signal,
      backoff: { initialMs: 30000, maxMs: 30000, factor: 2 },
    });
    process.on('exit', () => process.stderr.write(String(Date.now() - started)));
    process.exitCode = code;
  `;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 10_000, 'the process exits promptly, not after the 30 s backoff');
});
