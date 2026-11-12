// Server-mode fetch failures name their cause and an unused proxy (#1373).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  describeFetchFailure, fetchFailureCause, nodeHonorsEnvProxy, proxyHint, redactProxyUrl,
} from '../identity/fetch-diagnosis.mjs';
import { pinServerKey, ServerSession } from '../identity/server-client.mjs';

// What Node's fetch throws when no response arrived.
const failed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
const URL_ = 'https://agents.true-line.ai/v0/whoami';
const NODE24 = { version: '24.1.0', execArgv: [] };

test('the cause is named: DNS, refused, route, timeout, reset, TLS', () => {
  assert.equal(fetchFailureCause(failed({ code: 'ENOTFOUND' })), 'DNS lookup failed (ENOTFOUND)');
  assert.equal(fetchFailureCause(failed({ code: 'EAI_AGAIN' })), 'DNS lookup failed (EAI_AGAIN)');
  assert.equal(fetchFailureCause(failed({ code: 'ECONNREFUSED' })), 'connection refused (ECONNREFUSED)');
  assert.equal(fetchFailureCause(failed({ code: 'ENETUNREACH' })), 'no route to the host (ENETUNREACH)');
  assert.equal(fetchFailureCause(failed({ code: 'UND_ERR_CONNECT_TIMEOUT' })), 'timed out (UND_ERR_CONNECT_TIMEOUT)');
  assert.equal(fetchFailureCause(failed({ code: 'ECONNRESET' })), 'connection reset (ECONNRESET)');
  assert.equal(fetchFailureCause(failed({ code: 'CERT_HAS_EXPIRED' })), 'TLS failed (CERT_HAS_EXPIRED)');
  assert.equal(fetchFailureCause(failed({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })), 'TLS failed (SELF_SIGNED_CERT_IN_CHAIN)');
  assert.equal(fetchFailureCause(failed({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })), 'TLS failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)');
  // Happy-eyeballs: the attempts are inside an AggregateError.
  assert.equal(fetchFailureCause(failed({ errors: [{ code: 'ECONNREFUSED' }, { code: 'ENETUNREACH' }] })), 'connection refused (ECONNREFUSED)');
  assert.equal(fetchFailureCause(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timed out');
  assert.equal(fetchFailureCause(failed({ code: 'ESOMETHINGNEW' })), 'ESOMETHINGNEW');
  assert.equal(fetchFailureCause(failed(undefined)), 'network error');
  // A code is shown only when it looks like one.
  assert.equal(fetchFailureCause(failed({ code: 'https://user:secret@host/' })), 'network error');
});

test('a proxy URL is shown without credentials, path or query', () => {
  assert.equal(redactProxyUrl('http://user:s3cret@proxy.corp:3128/path?token=abc'), 'http://proxy.corp:3128');
  assert.equal(redactProxyUrl('user:s3cret@proxy.corp:3128'), 'http://proxy.corp:3128');
  assert.equal(redactProxyUrl('proxy.corp:3128'), 'http://proxy.corp:3128');
  assert.equal(redactProxyUrl('http://[bad'), 'a proxy');
});

test('a set but unused proxy is named with the switch, never with its credentials', () => {
  const error = failed({ code: 'ENOTFOUND' });
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const hint = proxyHint({ url: URL_, error, env: { [name]: 'http://user:s3cret@proxy.corp:3128' }, ...NODE24 });
    assert.equal(hint, `${name} is set (http://proxy.corp:3128) but this process is not using it; set NODE_USE_ENV_PROXY=1 and retry`);
    assert.ok(!hint.includes('s3cret') && !hint.includes('user'));
  }
  // HTTPS_PROXY is the one an https request uses.
  assert.match(proxyHint({ url: URL_, error, env: { HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }, ...NODE24 }), /^HTTPS_PROXY is set \(http:\/\/b:2\)/);
  // A Node that cannot read the variables at all.
  assert.equal(
    proxyHint({ url: URL_, error, env: { HTTPS_PROXY: 'http://proxy.corp:3128' }, version: '20.19.0', execArgv: [] }),
    'HTTPS_PROXY is set (http://proxy.corp:3128) but Node 20.19.0 cannot use it; run with Node 22.21 or later, or 24, and NODE_USE_ENV_PROXY=1',
  );
  assert.match(
    proxyHint({ url: URL_, error, env: { HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }, version: '20.19.0', execArgv: [] }),
    /Node 20\.19\.0 cannot use it/,
  );
});

test('no proxy sentence when a proxy is not the likely cause', () => {
  const error = failed({ code: 'ENOTFOUND' });
  const env = { HTTPS_PROXY: 'http://proxy.corp:3128' };
  assert.equal(proxyHint({ url: URL_, error, env: {}, ...NODE24 }), null);
  assert.equal(proxyHint({ url: URL_, error, env: { HTTPS_PROXY: ' ' }, ...NODE24 }), null);
  // The switch is on: Node is using the proxy.
  assert.equal(proxyHint({ url: URL_, error, env: { ...env, NODE_USE_ENV_PROXY: '1' }, ...NODE24 }), null);
  assert.equal(proxyHint({ url: URL_, error, env, version: '24.5.0', execArgv: ['--use-env-proxy'] }), null);
  assert.equal(proxyHint({ url: URL_, error, env: { ...env, NODE_OPTIONS: '--use-env-proxy' }, version: '24.5.0', execArgv: [] }), null);
  // The host is exempt.
  for (const no of ['agents.true-line.ai', '.true-line.ai', 'true-line.ai', '*', 'example.com, *.true-line.ai']) {
    assert.equal(proxyHint({ url: URL_, error, env: { ...env, NO_PROXY: no }, ...NODE24 }), null, no);
  }
  assert.notEqual(proxyHint({ url: URL_, error, env: { ...env, no_proxy: 'example.com' }, ...NODE24 }), null);
  // A connection was made: TLS and resets are not a missing proxy.
  assert.equal(proxyHint({ url: URL_, error: failed({ code: 'CERT_HAS_EXPIRED' }), env, ...NODE24 }), null);
  assert.equal(proxyHint({ url: URL_, error: failed({ code: 'ECONNRESET' }), env, ...NODE24 }), null);
  // HTTPS_PROXY does not apply to a plain http request.
  assert.equal(proxyHint({ url: 'http://localhost:1/x', error, env, ...NODE24 }), null);
});

test('which Node versions read proxy variables', () => {
  for (const v of ['24.0.0', '24.19.0', '25.1.0', '22.21.0', '22.22.1']) assert.equal(nodeHonorsEnvProxy(v), true, v);
  for (const v of ['20.19.0', '22.20.0', '23.11.0', '18.20.0']) assert.equal(nodeHonorsEnvProxy(v), false, v);
});

test('describeFetchFailure joins the cause and the proxy sentence', () => {
  assert.equal(
    describeFetchFailure(failed({ code: 'ENOTFOUND' }), { url: URL_, env: { HTTPS_PROXY: 'http://u:p@proxy.corp:3128' }, ...NODE24 }),
    'DNS lookup failed (ENOTFOUND); HTTPS_PROXY is set (http://proxy.corp:3128) but this process is not using it; set NODE_USE_ENV_PROXY=1 and retry',
  );
  assert.equal(describeFetchFailure(failed({ code: 'ECONNREFUSED' }), { url: URL_, env: {} }), 'connection refused (ECONNREFUSED)');
});

function scratchEnv(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fetch-diagnosis-'));
  return { dir, env: { HOME: dir, XDG_STATE_HOME: path.join(dir, 'state'), XDG_CONFIG_HOME: path.join(dir, 'config'), ...extra } };
}

test('enrollment requests say why they failed instead of a bare fetch failed', async () => {
  const { dir, env } = scratchEnv({ HTTPS_PROXY: 'http://user:s3cret@proxy.corp:3128' });
  try {
    const fetchImpl = async () => { throw failed({ code: 'ENOTFOUND' }); };
    await assert.rejects(
      pinServerKey('https://agents.true-line.ai', { env, home: dir }, { fetchImpl }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /^fetch failed: DNS lookup failed \(ENOTFOUND\); HTTPS_PROXY is set \(http:\/\/proxy\.corp:3128\) but /);
        assert.ok(!error.message.includes('s3cret'));
        assert.equal(error.cause.code, 'ENOTFOUND'); // callers that read the code still can
        return true;
      },
    );
    // Without proxy variables the cause alone is named.
    await assert.rejects(
      pinServerKey('https://agents.true-line.ai', { env: { HOME: dir }, home: dir }, { fetchImpl: async () => { throw failed({ code: 'CERT_HAS_EXPIRED' }); } }),
      { message: 'fetch failed: TLS failed (CERT_HAS_EXPIRED)' },
    );
    // Anything that is not Node's connection failure passes through untouched.
    const other = new Error('boom');
    await assert.rejects(pinServerKey('https://agents.true-line.ai', { env, home: dir }, { fetchImpl: async () => { throw other; } }), (error) => error === other);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session request names the cause and keeps its never-sent classification', async () => {
  const { dir, env } = scratchEnv({ https_proxy: 'http://user:s3cret@proxy.corp:3128' });
  try {
    const session = new ServerSession({ base: 'https://agents.true-line.ai', env, home: dir, fetchImpl: async () => { throw failed({ code: 'ECONNREFUSED' }); } });
    await assert.rejects(session.send('https://agents.true-line.ai/v0/whoami', {}), (error) => {
      assert.equal(error.code, 'credential-unavailable');
      assert.match(error.message, /the identity service is unreachable: connection refused \(ECONNREFUSED\); https_proxy is set \(http:\/\/proxy\.corp:3128\) but /);
      assert.ok(!error.message.includes('s3cret'));
      assert.equal(error.neverSent, true);
      return true;
    });
    const reset = new ServerSession({ base: 'https://agents.true-line.ai', env, home: dir, fetchImpl: async () => { throw failed({ code: 'ECONNRESET' }); } });
    await assert.rejects(reset.send('https://agents.true-line.ai/v0/whoami', {}), (error) => {
      assert.match(error.message, /unreachable: connection reset \(ECONNRESET\)$/);
      assert.equal(error.neverSent, false);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
