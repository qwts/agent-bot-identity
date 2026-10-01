import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { attachWakeEndpoint, WarmPool } from '../agent-wake.mjs';

const ID = 'agent_33333333-3333-4333-8333-333333333333';

async function fixture({ pingIntervalMs = 30_000 } = {}) {
  const server = createServer();
  const pool = attachWakeEndpoint(server, {
    lookupBinding: (secret) => secret === 'valid' ? { agentId: ID } : null,
    pingIntervalMs,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(server.address().port, '127.0.0.1');
  await once(socket, 'connect');
  return { server, socket, pool, close: () => { socket.destroy(); server.close(); } };
}

function maskedFrame(opcode, text = '') {
  const payload = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x80 | opcode; frame[1] = 0x80 | payload.length; mask.copy(frame, 2);
  for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i & 3];
  return frame;
}

async function handshake(socket, secret = 'valid') {
  socket.write(`GET /v0/wake HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-agent-binding: ${secret}\r\n\r\n`);
}

test('WarmPool add, send count, has, list, and remove', () => {
  const pool = new WarmPool();
  const a = { writable: true, destroyed: false, frames: [], write(value) { this.frames.push(value); } };
  pool.add(ID, a);
  assert.equal(pool.has(ID), true);
  assert.deepEqual(pool.list(), { [ID]: 1 });
  assert.equal(pool.send(ID, { event: 'wake' }), 1);
  assert.equal(a.frames.length, 1);
  pool.remove(ID, a);
  assert.equal(pool.has(ID), false);
});

test('wake endpoint authenticates, handshakes, sends ready, parses masked frames, and removes closed sockets', async () => {
  const f = await fixture();
  try {
    let data = '';
    f.socket.on('data', (chunk) => { data += chunk.toString('latin1'); });
    await handshake(f.socket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(data, /101 Switching Protocols/);
    assert.ok(data.includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='));
    assert.equal(f.pool.has(ID), true);
    assert.match(data, /"event":"ready","agentId":"agent_33333333-3333-4333-8333-333333333333"/);
    assert.equal(f.pool.send(ID, { event: 'wake', id: 'one' }), 1);
    f.socket.write(maskedFrame(0x1, 'hello'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closed = once(f.socket, 'close');
    f.socket.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(f.pool.has(ID), false);
  } finally { await f.close(); }
});

test('wake endpoint refuses a bad binding with HTTP 401 before upgrade', async () => {
  const f = await fixture();
  try {
    let data = '';
    f.socket.on('data', (chunk) => { data += chunk.toString(); });
    await handshake(f.socket, 'wrong');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(data, /401 Unauthorized/);
    assert.doesNotMatch(data, /101 Switching Protocols/);
    assert.equal(f.pool.list()[ID], undefined);
  } finally { await f.close(); }
});

test('wake listener responds to server ping and is removed after two missed pong intervals', async () => {
  const f = await fixture({ pingIntervalMs: 100 });
  try {
    let frames = Buffer.alloc(0);
    f.socket.on('data', (chunk) => { frames = Buffer.concat([frames, chunk]); });
    await handshake(f.socket);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Reply to each unmasked server ping with a masked pong.
    f.socket.on('data', (chunk) => {
      const pongOffset = chunk.indexOf(Buffer.from([0x89, 0x00]));
      if (pongOffset >= 0) f.socket.write(maskedFrame(0xa));
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(f.pool.has(ID), true);
    // Stop pong replies and wait for two missed intervals.
    f.socket.removeAllListeners('data');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(f.pool.has(ID), false);
  } finally { await f.close(); }
});

test('a client that hangs up leaves no half-open socket on the daemon', async () => {
  const f = await fixture();
  try {
    await handshake(f.socket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.pool.has(ID), true);
    f.socket.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.pool.has(ID), false);
    // server.close() only completes once the daemon's side is gone too.
    await new Promise((resolve) => { f.server.close(resolve); });
  } finally {
    f.socket.destroy();
  }
});

test('an unmasked frame is refused and nothing more is buffered from that peer', async () => {
  const f = await fixture();
  try {
    let data = Buffer.alloc(0);
    f.socket.on('data', (chunk) => { data = Buffer.concat([data, chunk]); });
    await handshake(f.socket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // An unmasked text frame header that promises a payload it never sends.
    f.socket.write(Buffer.from([0x81, 0x7e, 0xff, 0x00]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Close frame with 1002 (protocol error) from the daemon.
    assert.ok(data.includes(Buffer.from([0x88, 0x02, 0x03, 0xea])));
    // Bytes after the refusal are not read into the daemon's heap.
    f.socket.write(Buffer.alloc(128 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.pool.has(ID), false);
  } finally {
    f.close();
  }
});

test('a socket error on a refused handshake does not crash the daemon', async () => {
  const server = createServer();
  attachWakeEndpoint(server, { lookupBinding: () => null });
  let upgraded;
  server.prependListener('upgrade', (req, socket) => { upgraded = socket; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(server.address().port, '127.0.0.1');
  try {
    await once(socket, 'connect');
    await handshake(socket, 'wrong');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // With no listener this would be an uncaught 'error' and a process exit.
    upgraded.emit('error', Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' }));
    assert.equal(upgraded.destroyed, true);
  } finally {
    socket.destroy();
    server.close();
  }
});
