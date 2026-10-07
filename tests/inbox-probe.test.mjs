import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { classifyProbeError, probeInboxReachability } from '../inbox-probe.mjs';

// #318: the doctor inbox probe against real loopback sockets, as in
// take-inbox-rebind.test.mjs, so each outcome is the one Node actually raises.

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test('an HTTP answer is reported with its status, and the request carries no secret', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(403).end();
  });
  const port = await listen(server);
  try {
    const result = await probeInboxReachability(`http://user:url-secret@127.0.0.1:${port}/base?key=query-secret#frag`);
    assert.deepEqual(result, { host: `127.0.0.1:${port}`, outcome: 'http', http_status: 403 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'HEAD');
    assert.equal(seen[0].url, '/inbox');
    assert.equal(seen[0].headers.authorization, undefined);
    assert.doesNotMatch(JSON.stringify(seen[0].headers), /secret/);
  } finally {
    await close(server);
  }
});

test('a 5xx is still an HTTP outcome, with the status kept', async () => {
  const server = createServer((req, res) => res.writeHead(502).end());
  const port = await listen(server);
  try {
    const result = await probeInboxReachability(`http://127.0.0.1:${port}`);
    assert.equal(result.outcome, 'http');
    assert.equal(result.http_status, 502);
  } finally {
    await close(server);
  }
});

test('a closed port is reported as refused', async () => {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  const result = await probeInboxReachability(`http://127.0.0.1:${port}`);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.error_code, 'ECONNREFUSED');
  assert.equal(result.host, `127.0.0.1:${port}`);
});

test('an unresolvable host is reported as dns', async () => {
  const result = await probeInboxReachability('https://agent-bot-probe.invalid');
  assert.equal(result.outcome, 'dns', JSON.stringify(result));
  assert.equal(result.host, 'agent-bot-probe.invalid');
});

test('a listener that never answers is reported as timeout within the bound', async () => {
  const server = createServer(() => { /* never respond */ });
  const port = await listen(server);
  try {
    const started = Date.now();
    const result = await probeInboxReachability(`http://127.0.0.1:${port}`, { timeoutMs: 100 });
    assert.equal(result.outcome, 'timeout');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await close(server);
  }
});

test('an https probe of a plain-text listener is reported as tls', async () => {
  // A non-TLS peer fails the handshake the same way a broken certificate
  // endpoint does, without the test needing a certificate.
  const server = createTcpServer((socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  const port = await listen(server);
  try {
    const result = await probeInboxReachability(`https://127.0.0.1:${port}`);
    assert.equal(result.outcome, 'tls', JSON.stringify(result));
  } finally {
    server.close();
  }
});

test('error codes classify into distinct outcomes', () => {
  assert.equal(classifyProbeError({ code: 'EAI_AGAIN' }), 'dns');
  assert.equal(classifyProbeError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'tls');
  assert.equal(classifyProbeError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }), 'tls');
  assert.equal(classifyProbeError({ code: 'ECONNREFUSED' }), 'refused');
  assert.equal(classifyProbeError({ code: 'EHOSTUNREACH' }), 'network');
});

test('a URL that is not http(s) is never requested', async () => {
  assert.deepEqual(await probeInboxReachability('ftp://inbox.example.invalid'), { outcome: 'invalid-url', host: null });
  assert.deepEqual(await probeInboxReachability('not a url'), { outcome: 'invalid-url', host: null });
});
