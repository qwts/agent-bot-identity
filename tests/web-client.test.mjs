import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertLoopbackHost, createDaemonServer, runDaemon } from '../agent-daemon.mjs';
import { doctorReport } from '../server-status.mjs';
import {
  PAIRING_CODE_TTL_MS,
  UI_CSRF_HEADER,
  WEB_SESSION_TTL_MS,
  enrollPromptReport,
  enrollStdoutChunk,
  parseEnrollLine,
  proposalOwnerGate,
  webRootDirectory,
} from '../agent-web.mjs';
import { addArtifact, createSession, operationDigest } from '../agent-jobs.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const AGENT_ID = 'agent_44444444-4444-4444-8444-444444444444';
const OTHER_ID = 'agent_55555555-5555-4555-8555-555555555555';
const WEB_ROOT = webRootDirectory();
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-web-'));
  roots.push(root);
  const env = {
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
  };
  return { root, env };
}

function seedSoul(env, { id = AGENT_ID, status = 'active', parentId = null } = {}) {
  const spacePath = path.join(path.dirname(env.AGENT_BOT_POPULATION_PATH), 'spaces', id);
  mkdirSync(spacePath, { recursive: true });
  return upsertSoul({
    id,
    appSlug: 'you-codex-agent',
    parentId,
    status,
    spacePath,
    transcriptLocator: null,
    lastSeen: '2026-08-12T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
}

function seedPrincipal(env, {
  label = 'owner',
  souls = [AGENT_ID],
  operations = ['message', 'observe', 'cancel', 'approve'],
} = {}) {
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const principal = enrollPrincipal({ label }, options);
  bindTransport(principal.principalId, { transport: 'web', providerId: `sub-${principal.principalId.slice(-12)}` }, options);
  authorizeSouls(principal.principalId, souls, options);
  return setOperations(principal.principalId, operations, options);
}

// Full-stack harness: a real daemon server on 127.0.0.1 with an injectable
// executor and an adjustable clock, plus browser-shaped fetch helpers.
// The owner gate is always a stub here: nothing in this file may reach keyd,
// Touch ID, or the admin dialog.
async function withServer(env, run, { executor, ownerGate = async () => ({ method: 'presence', via: 'test' }), webDeps, home = '/nonexistent' } = {}) {
  const clock = { value: new Date('2026-08-12T09:00:00.000Z') };
  const server = createDaemonServer({
    env,
    home,
    config: {},
    executor,
    ownerGate,
    now: () => clock.value,
    webDeps,
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const bearer = (pathname, { method = 'GET', body, token = server.token } = {}) =>
    fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const ui = (pathname, { method = 'GET', body, cookie, headers = {}, origin = base, csrf = true } = {}) =>
    fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(csrf ? { [UI_CSRF_HEADER]: '1' } : {}),
        ...(origin === null ? {} : { origin }),
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function pairCookie(principalId) {
    const minted = await (await bearer('/ui/pair', { method: 'POST', body: { principalId } })).json();
    const opened = await ui('/ui/session', { method: 'POST', body: { code: minted.code } });
    assert.equal(opened.status, 200);
    const setCookie = opened.headers.getSetCookie()[0];
    return setCookie.split(';')[0];
  }

  try {
    await run({ base, port, server, clock, bearer, ui, pairCookie });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

async function waitFor(probe, { timeoutMs = 5_000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

// --- static assets ----------------------------------------------------------

test('the daemon serves the PWA shell with strict security headers and no bearer token', async () => {
  const { env } = scratch();
  await withServer(env, async ({ base }) => {
    const page = await fetch(`${base}/ui/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'no-cache');

    const expectations = [
      ['/ui/app.js', /^text\/javascript/],
      ['/ui/style.css', /^text\/css/],
      ['/ui/manifest.webmanifest', /^application\/manifest\+json/],
      ['/ui/sw.js', /^text\/javascript/],
      ['/ui/icon.svg', /^image\/svg\+xml/],
    ];
    for (const [asset, type] of expectations) {
      const response = await fetch(`${base}${asset}`);
      assert.equal(response.status, 200, asset);
      assert.match(response.headers.get('content-type'), type);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.headers.get('cache-control'));
    }
    // Installability surface: manifest declares scope, start URL, and icons.
    const manifest = await (await fetch(`${base}/ui/manifest.webmanifest`)).json();
    assert.equal(manifest.scope, '/ui/');
    assert.equal(manifest.start_url, '/ui/');
    assert.ok(manifest.icons.length > 0);
  });
});

test('static traversal attempts are refused before touching the filesystem', async () => {
  const { env } = scratch();
  await withServer(env, async ({ base, port }) => {
    // Encoded traversal that survives URL normalization reaches the static
    // handler and is refused by the asset whitelist.
    for (const hostile of [
      '/ui/..%2fpackage.json',
      '/ui/%2e%2e%2fagent-daemon.mjs',
      '/ui/.hidden',
      '/ui/sub%2fdir.js',
      '/ui/%00index.html',
    ]) {
      const response = await fetch(`${base}${hostile}`);
      assert.equal(response.status, 404, hostile);
      assert.deepEqual(await response.json(), { error: 'unknown asset' });
    }
    // Dot segments the URL parser normalizes leave /ui entirely and land on
    // the bearer-token wall instead — refused either way, nothing served.
    const normalized = await fetch(`${base}/ui/%2e%2e/package.json`);
    assert.equal(normalized.status, 401);
    // A literal `/ui/../secret` request line (no client normalization): the
    // normalized path leaves /ui and lands on the bearer-token wall instead.
    const raw = await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write('GET /ui/../package.json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 (401|404) /);
    assert.doesNotMatch(raw, /"name": "agent-bot-identity"/);
  });
});

test('the service worker never caches the API and the shell has no inline script', () => {
  const swSource = readFileSync(path.join(WEB_ROOT, 'sw.js'), 'utf8');
  // The API guard exists and is used to bypass the cache entirely.
  assert.match(swSource, /function isApiRequest\(url\)/);
  assert.match(swSource, /url\.pathname\.startsWith\('\/ui\/api'\)/);
  assert.match(swSource, /'\/ui\/session'/);
  assert.match(swSource, /isApiRequest\(url\) \|\| event\.request\.method !== 'GET'/);
  // The only cache.put sits behind that guard's early return.
  assert.equal(swSource.match(/cache\.put/g).length, 1);
  assert.ok(swSource.indexOf('isApiRequest(url) ||') < swSource.indexOf('cache.put'));
  // Offline shell communicates unreachability instead of impersonating state.
  assert.match(swSource, /daemon unreachable/);

  const html = readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  // CSP consistency: no inline <script> bodies and no inline event handlers.
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  // No external origins anywhere in the shell (CSP is 'self' only).
  assert.doesNotMatch(html, /https?:\/\//);
});

// --- pairing and cookie sessions ---------------------------------------------

test('pairing codes are minted only with the daemon token, are single use, and expire', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  await withServer(env, async ({ bearer, ui, clock }) => {
    const unauthorized = await bearer('/ui/pair', {
      method: 'POST',
      body: { principalId: principal.principalId },
      token: null,
    });
    assert.equal(unauthorized.status, 401);

    const unknown = await bearer('/ui/pair', {
      method: 'POST',
      body: { principalId: 'principal_99999999-9999-4999-8999-999999999999' },
    });
    assert.equal(unknown.status, 404);

    // Single use: the first exchange wins, the replay is refused.
    const minted = await (await bearer('/ui/pair', { method: 'POST', body: { principalId: principal.principalId } })).json();
    assert.equal(typeof minted.code, 'string');
    const first = await ui('/ui/session', { method: 'POST', body: { code: minted.code } });
    assert.equal(first.status, 200);
    const cookie = first.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/ui/);
    const replay = await ui('/ui/session', { method: 'POST', body: { code: minted.code } });
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { error: 'invalid or expired pairing code' });

    // Expiry: an unredeemed code dies after the pairing TTL.
    const stale = await (await bearer('/ui/pair', { method: 'POST', body: { principalId: principal.principalId } })).json();
    clock.value = new Date(clock.value.getTime() + PAIRING_CODE_TTL_MS + 1_000);
    const late = await ui('/ui/session', { method: 'POST', body: { code: stale.code } });
    assert.equal(late.status, 401);
  });
});

test('cookie sessions authenticate the API, expire, and never expose the bearer token', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  await withServer(env, async ({ ui, pairCookie, clock, server }) => {
    const anonymous = await ui('/ui/api/me');
    assert.equal(anonymous.status, 401);

    const cookie = await pairCookie(principal.principalId);
    // The session cookie is its own secret, unrelated to the daemon token.
    assert.ok(!cookie.includes(server.token));

    const me = await ui('/ui/api/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('cache-control'), 'no-store');
    const body = await me.json();
    assert.equal(body.principal.principalId, principal.principalId);
    assert.deepEqual(body.principal.souls, [AGENT_ID]);
    assert.ok(!JSON.stringify(body).includes(server.token));

    // ~12h expiry, enforced daemon-side.
    clock.value = new Date(clock.value.getTime() + WEB_SESSION_TTL_MS + 1_000);
    const expired = await ui('/ui/api/me', { cookie });
    assert.equal(expired.status, 401);
  });
});

test('state-changing requests require the custom header and a same-origin Origin', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(principal.principalId);

    const noHeader = await ui('/ui/api/sessions', {
      method: 'POST',
      body: { agentId: AGENT_ID },
      cookie,
      csrf: false,
    });
    assert.equal(noHeader.status, 403);
    assert.deepEqual(await noHeader.json(), { error: 'missing UI request header' });

    for (const origin of ['http://evil.example', 'http://127.0.0.1:1', null]) {
      const crossOrigin = await ui('/ui/api/sessions', {
        method: 'POST',
        body: { agentId: AGENT_ID },
        cookie,
        origin,
      });
      assert.equal(crossOrigin.status, 403, String(origin));
      assert.deepEqual(await crossOrigin.json(), { error: 'cross-origin request refused' });
    }
  });
});

test('a reviewed reverse proxy stays same-origin: Origin must name exactly the addressed host', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  await withServer(env, async ({ port, pairCookie }) => {
    const cookie = await pairCookie(principal.principalId);
    const proxied = (headers) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ agentId: AGENT_ID });
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/ui/api/sessions',
        headers: {
          [UI_CSRF_HEADER]: '1',
          cookie,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      });
      request.on('error', reject);
      request.end(body);
    });
    // The browser behind `tailscale serve` addresses the proxy host and its
    // Origin names that same host: same-origin, accepted.
    const sameOrigin = await proxied({ host: 'gateway.ts.example', origin: 'https://gateway.ts.example' });
    assert.equal(sameOrigin.status, 200);
    // A cross-site page proxied the same way still names the attacking site.
    const crossSite = await proxied({ host: 'gateway.ts.example', origin: 'https://evil.example' });
    assert.equal(crossSite.status, 403);
    // Scheme games do not count as origins.
    const fileOrigin = await proxied({ host: 'gateway.ts.example', origin: 'null' });
    assert.equal(fileOrigin.status, 403);
  });
});

// --- authorization and interaction surfaces -----------------------------------

test('population lists only authorized souls and unauthorized targets are refused', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedSoul(env, { id: OTHER_ID });
  const principal = seedPrincipal(env, { souls: [AGENT_ID] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(principal.principalId);
    const { souls } = await (await ui('/ui/api/population', { cookie })).json();
    assert.deepEqual(souls.map((soul) => soul.id), [AGENT_ID]);
    assert.deepEqual(
      Object.keys(souls[0]).sort(),
      ['appSlug', 'id', 'lastSeen', 'parentId', 'spacePath', 'status'],
    );

    const refused = await ui('/ui/api/sessions', {
      method: 'POST',
      body: { agentId: OTHER_ID },
      cookie,
    });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: 'principal is not authorized for this operation' });
  });
});

test('a browser session can converse, watch events across a refresh, and cancel', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = async ({ appendEvent, message, signal }) => {
    appendEvent('progress', { note: `heard: ${message}` });
    appendEvent('progress', { note: 'working' });
    await gate;
    if (signal.aborted) throw new Error('aborted');
    appendEvent('progress', { note: 'done' });
  };
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(principal.principalId);
    const opened = await (await ui('/ui/api/sessions', {
      method: 'POST',
      body: { agentId: AGENT_ID },
      cookie,
    })).json();
    assert.equal(opened.created, true);
    const sessionId = opened.session.sessionId;

    // Continuing the same session id does not fork a new one.
    const continued = await (await ui('/ui/api/sessions', {
      method: 'POST',
      body: { agentId: AGENT_ID, sessionId },
      cookie,
    })).json();
    assert.equal(continued.created, false);

    const submitted = await (await ui(`/ui/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { message: 'hello soul', idempotencyKey: 'web-1' },
      cookie,
    })).json();
    const invocationId = submitted.invocation.invocationId;
    assert.equal(submitted.duplicate, false);

    // Idempotent retry from the browser returns the same invocation.
    const retried = await (await ui(`/ui/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: { message: 'hello soul', idempotencyKey: 'web-1' },
      cookie,
    })).json();
    assert.equal(retried.duplicate, true);
    assert.equal(retried.invocation.invocationId, invocationId);

    // Event projection with a reconnect cursor: a "refresh" (new request, no
    // client memory) resumes from afterSeq without losing or repeating rows.
    const firstPage = await waitFor(async () => {
      const { events } = await (await ui(`/ui/api/invocations/${invocationId}/events?after=0`, { cookie })).json();
      return events.some((event) => event.data.note === 'working') ? events : null;
    });
    const cursor = firstPage.at(-1).seq;
    release();
    const nextPage = await waitFor(async () => {
      const { events } = await (await ui(`/ui/api/invocations/${invocationId}/events?after=${cursor}`, { cookie })).json();
      return events.length > 0 ? events : null;
    });
    assert.ok(nextPage.every((event) => event.seq > cursor));
    assert.ok(nextPage.some((event) => event.data.note === 'done' || event.data.status === 'completed'));

    await waitFor(async () => {
      const { invocation } = await (await ui(`/ui/api/invocations/${invocationId}`, { cookie })).json();
      return invocation.status === 'completed';
    });

    // Jobs listing shows the invocation; cancel on a finished job is honest.
    const { invocations } = await (await ui('/ui/api/invocations', { cookie })).json();
    assert.deepEqual(invocations.map((invocation) => invocation.invocationId), [invocationId]);
    const cancelled = await (await ui(`/ui/api/invocations/${invocationId}/cancel`, {
      method: 'POST',
      body: {},
      cookie,
    })).json();
    assert.equal(cancelled.alreadyFinished, true);
    assert.equal(cancelled.stopped, false);
  }, { executor });
});

test('the web session listing is scoped to the web transport', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(principal.principalId);
    // Another adapter's session for the same principal and soul: it must
    // never surface in the web client, which could not continue it anyway.
    createSession(
      { agentId: AGENT_ID, principalId: principal.principalId, transport: 'telegram' },
      { env, home: '/nonexistent' },
    );
    const { session } = await (await ui('/ui/api/sessions', {
      method: 'POST', body: { agentId: AGENT_ID }, cookie,
    })).json();

    const scoped = await (await ui(`/ui/api/sessions?agentId=${AGENT_ID}`, { cookie })).json();
    assert.deepEqual(scoped.sessions.map((entry) => entry.sessionId), [session.sessionId]);
    assert.ok(scoped.sessions.every((entry) => entry.transport === 'web'));

    const all = await (await ui('/ui/api/sessions', { cookie })).json();
    assert.ok(all.sessions.every((entry) => entry.transport === 'web'));
    assert.equal(all.sessions.length, 1);
  });
});

test('a retried submission reuses its idempotency key; only a new submission mints one', () => {
  const app = readFileSync(path.join(WEB_ROOT, 'app.js'), 'utf8');
  // The policy is a pure function in app.js; exercise the shipped source.
  const match = app.match(/function nextSubmission\([\s\S]*?\n\}/);
  assert.ok(match, 'nextSubmission policy function present in app.js');
  const nextSubmission = new Function(`return ${match[0]}`)();
  let minted = 0;
  const mintKey = () => `key-${(minted += 1)}`;
  const first = nextSubmission(null, 'session_a', 'hello', mintKey);
  assert.equal(first.key, 'key-1');
  // A retry of the same logical submission (the send failed and the user
  // resends the same text in the same session) reuses the exact key, so the
  // daemon's idempotency index collapses it into one invocation.
  const retry = nextSubmission(first, 'session_a', 'hello', mintKey);
  assert.equal(retry, first);
  assert.equal(minted, 1);
  // Only a genuinely new user-initiated submission mints a new key.
  assert.equal(nextSubmission(first, 'session_a', 'different text', mintKey).key, 'key-2');
  assert.equal(nextSubmission(first, 'session_b', 'hello', mintKey).key, 'key-3');
  // And the pending record is dropped only by a successful send, so the key
  // survives every failed attempt in between.
  assert.match(app, /idempotencyKey: pendingSubmission\.key/);
  assert.match(app, /pendingSubmission = null; \/\/ consumed only by a successful submission/);
});

test('another principal cannot observe a foreign invocation through the web API', async () => {
  const { env } = scratch();
  seedSoul(env);
  const owner = seedPrincipal(env);
  const outsider = seedPrincipal(env, { label: 'outsider', souls: [AGENT_ID] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const ownerCookie = await pairCookie(owner.principalId);
    const outsiderCookie = await pairCookie(outsider.principalId);
    const { session } = await (await ui('/ui/api/sessions', {
      method: 'POST', body: { agentId: AGENT_ID }, cookie: ownerCookie,
    })).json();
    const { invocation } = await (await ui(`/ui/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { message: 'private', idempotencyKey: 'owner-1' },
      cookie: ownerCookie,
    })).json();

    for (const pathname of [
      `/ui/api/invocations/${invocation.invocationId}`,
      `/ui/api/invocations/${invocation.invocationId}/events?after=0`,
      `/ui/api/invocations/${invocation.invocationId}/artifacts`,
    ]) {
      const response = await ui(pathname, { cookie: outsiderCookie });
      assert.equal(response.status, 404, pathname);
      assert.deepEqual(await response.json(), { error: 'unknown invocation' });
    }
    // And the outsider's job list stays empty.
    const { invocations } = await (await ui('/ui/api/invocations', { cookie: outsiderCookie })).json();
    assert.deepEqual(invocations, []);
  });
});

// --- approvals -----------------------------------------------------------------

test('approvals are immutable digest-bound proposals; stale or mismatched digests are refused', async () => {
  const { env } = scratch();
  seedSoul(env);
  const approver = seedPrincipal(env);
  const observer = seedPrincipal(env, { label: 'observer', operations: ['message', 'observe'] });
  const operation = { kind: 'deploy', target: 'production', ref: 'v1.2.3' };
  const outcomes = [];
  const executor = async ({ requestApproval, appendEvent }) => {
    const outcome = await requestApproval({ operation, summary: 'Deploy v1.2.3 to production' });
    outcomes.push(outcome);
    if (outcome.decision !== 'approve') throw new Error('operation was not approved');
    appendEvent('deployed', {});
  };
  await withServer(env, async ({ ui, pairCookie, clock }) => {
    const cookie = await pairCookie(approver.principalId);
    const observerCookie = await pairCookie(observer.principalId);
    const { session } = await (await ui('/ui/api/sessions', {
      method: 'POST', body: { agentId: AGENT_ID }, cookie,
    })).json();
    await ui(`/ui/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { message: 'please deploy', idempotencyKey: 'deploy-1' },
      cookie,
    });

    const proposal = await waitFor(async () => {
      const { proposals } = await (await ui('/ui/api/approvals', { cookie })).json();
      return proposals[0] ?? null;
    });
    assert.equal(proposal.operationDigest, operationDigest(operation));
    assert.equal(proposal.summary, 'Deploy v1.2.3 to production');
    assert.equal(proposal.agentId, AGENT_ID);

    // The invocation is parked in waiting-approval while the proposal is open.
    const { invocations } = await (await ui('/ui/api/invocations', { cookie })).json();
    assert.equal(invocations[0].status, 'waiting-approval');

    // A digest that does not match the immutable proposal is refused.
    const forged = createHash('sha256').update('something else').digest('hex');
    const mismatch = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST',
      body: { decision: 'approve', digest: forged },
      cookie,
    });
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), { error: 'operation digest does not match the proposal' });

    // A generic "yes" through the messaging path has no approval pathway:
    // the proposal is still open and the invocation still parked.
    const still = await (await ui('/ui/api/approvals', { cookie })).json();
    assert.equal(still.proposals.length, 1);

    // A principal without the reserved 'approve' operation is refused even
    // with the correct digest.
    const unprivileged = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST',
      body: { decision: 'approve', digest: proposal.operationDigest },
      cookie: observerCookie,
    });
    assert.equal(unprivileged.status, 403);

    // The exact digest from an authorized approver resumes execution.
    const approved = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST',
      body: { decision: 'approve', digest: proposal.operationDigest },
      cookie,
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).proposal.status, 'approved');
    await waitFor(async () => {
      const { invocation } = await (await ui(`/ui/api/invocations/${invocations[0].invocationId}`, { cookie })).json();
      return invocation.status === 'completed';
    });
    assert.deepEqual(outcomes, [{ decision: 'approve' }]);

    // Replaying the decision is refused: the proposal was consumed.
    const replay = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST',
      body: { decision: 'approve', digest: proposal.operationDigest },
      cookie,
    });
    assert.equal(replay.status, 409);
    assert.deepEqual(await replay.json(), { error: 'proposal is no longer open' });

    // Stale proposal: a second run whose proposal expires before the decision.
    await ui(`/ui/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { message: 'deploy again', idempotencyKey: 'deploy-2' },
      cookie,
    });
    const second = await waitFor(async () => {
      const { proposals } = await (await ui('/ui/api/approvals', { cookie })).json();
      return proposals[0] ?? null;
    });
    clock.value = new Date(new Date(second.expiresAt).getTime() + 1_000);
    const stale = await ui(`/ui/api/approvals/${second.proposalId}/decision`, {
      method: 'POST',
      body: { decision: 'approve', digest: second.operationDigest },
      cookie,
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'proposal is no longer open' });
    // And the expired proposal no longer shows as open work.
    const drained = await (await ui('/ui/api/approvals', { cookie })).json();
    assert.deepEqual(drained.proposals, []);
  }, { executor });
});

test('a web approval asks the owner every time; a paired session alone decides nothing (#1060)', async () => {
  const { env } = scratch();
  seedSoul(env);
  const approver = seedPrincipal(env);
  const operation = { kind: 'deploy', target: 'production', ref: 'v9.9.9' };
  const outcomes = [];
  const executor = async ({ requestApproval }) => {
    outcomes.push(await requestApproval({ operation, summary: 'Deploy v9.9.9 to production' }));
  };
  const asked = [];
  let ownerSays = 'no';
  const ownerGate = async (action, options) => {
    asked.push({ action, request: options.request });
    if (ownerSays !== 'yes') throw new Error('the person declined');
    return { method: 'presence', via: 'test' };
  };
  await withServer(env, async ({ ui, pairCookie }) => {
    // Pairing needs only the daemon bearer, which any same-account process
    // can read, so this session must not carry owner authority.
    const cookie = await pairCookie(approver.principalId);
    const { session } = await (await ui('/ui/api/sessions', {
      method: 'POST', body: { agentId: AGENT_ID }, cookie,
    })).json();
    await ui(`/ui/api/sessions/${session.sessionId}/messages`, {
      method: 'POST', body: { message: 'please deploy', idempotencyKey: 'deploy-owner' }, cookie,
    });
    const proposal = await waitFor(async () => {
      const { proposals } = await (await ui('/ui/api/approvals', { cookie })).json();
      return proposals[0] ?? null;
    });

    const refused = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: proposal.operationDigest }, cookie,
    });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /owner did not confirm/);
    assert.deepEqual(asked.map((entry) => entry.request), [proposal.proposalId]);
    const still = await (await ui('/ui/api/approvals', { cookie })).json();
    assert.equal(still.proposals.length, 1, 'a refused owner decides nothing');
    assert.deepEqual(outcomes, []);

    ownerSays = 'yes';
    const approved = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: proposal.operationDigest }, cookie,
    });
    assert.equal(approved.status, 200);
    assert.equal(asked.length, 2, 'the owner is asked again for the next decision');
    await waitFor(async () => outcomes.length === 1);
    assert.deepEqual(outcomes, [{ decision: 'approve' }]);
  }, { executor, ownerGate });
});

// --- artifacts -------------------------------------------------------------------

test('artifact downloads are authorized, bounded, and traversal-proof', async () => {
  const { env, root } = scratch();
  const soul = seedSoul(env);
  const principal = seedPrincipal(env);
  const payload = 'artifact payload bytes\n';
  const digest = createHash('sha256').update(payload).digest('hex');
  const executor = async ({ addArtifact: record, invocation }) => {
    void invocation;
    const directory = path.join(soul.spacePath, 'artifacts');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'report.txt'), payload);
    record({
      name: 'report.txt',
      bytes: Buffer.byteLength(payload),
      sha256: digest,
      spacePath: 'artifacts/report.txt',
    });
  };
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(principal.principalId);
    const { session } = await (await ui('/ui/api/sessions', {
      method: 'POST', body: { agentId: AGENT_ID }, cookie,
    })).json();
    const { invocation } = await (await ui(`/ui/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      body: { message: 'make a report', idempotencyKey: 'art-1' },
      cookie,
    })).json();
    const invocationId = invocation.invocationId;
    await waitFor(async () => {
      const { invocation: current } = await (await ui(`/ui/api/invocations/${invocationId}`, { cookie })).json();
      return current.status === 'completed';
    });

    const { artifacts } = await (await ui(`/ui/api/invocations/${invocationId}/artifacts`, { cookie })).json();
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'report.txt');

    // Authorized download streams the exact recorded bytes.
    const download = await ui(`/ui/api/invocations/${invocationId}/artifacts/report.txt`, { cookie });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.match(download.headers.get('content-disposition'), /attachment; filename="report\.txt"/);
    assert.equal(await download.text(), payload);

    // No cookie, no bytes.
    const anonymous = await ui(`/ui/api/invocations/${invocationId}/artifacts/report.txt`);
    assert.equal(anonymous.status, 401);

    // Hostile names are refused with stable errors before any path math.
    for (const hostile of ['..%2F..%2Fsecret', 'a%2Fb.txt']) {
      const refused = await ui(`/ui/api/invocations/${invocationId}/artifacts/${hostile}`, { cookie });
      assert.equal(refused.status, 400, hostile);
      assert.deepEqual(await refused.json(), { error: 'invalid artifact name' });
    }
    // A dot-segment name is normalized off the artifact route entirely and
    // falls through to an unknown route — refused either way.
    const dotted = await ui(`/ui/api/invocations/${invocationId}/artifacts/%2e%2e`, { cookie });
    assert.equal(dotted.status, 404);
    const missing = await ui(`/ui/api/invocations/${invocationId}/artifacts/other.txt`, { cookie });
    assert.equal(missing.status, 404);

    // A symlink that escapes the soul's Agent Space is refused even though
    // its recorded metadata looks clean.
    const secret = path.join(root, 'outside-secret.txt');
    writeFileSync(secret, 'do not serve this');
    symlinkSync(secret, path.join(soul.spacePath, 'artifacts', 'evil.txt'));
    addArtifact(invocationId, {
      name: 'evil.txt',
      bytes: 17,
      sha256: createHash('sha256').update('do not serve this').digest('hex'),
      spacePath: 'artifacts/evil.txt',
    }, { env, home: '/nonexistent' });
    const escape = await ui(`/ui/api/invocations/${invocationId}/artifacts/evil.txt`, { cookie });
    assert.equal(escape.status, 404);
    assert.deepEqual(await escape.json(), { error: 'artifact is not available' });

    // A file whose bytes were substituted after recording (size intact,
    // content changed) fails sha256 verification and is never served as
    // authentic — the refusal carries none of the tampered content.
    const tamperedPayload = 'artifact PAYLOAD bytes\n'; // same length, new content
    assert.equal(Buffer.byteLength(tamperedPayload), Buffer.byteLength(payload));
    writeFileSync(path.join(soul.spacePath, 'artifacts', 'tampered.txt'), tamperedPayload);
    addArtifact(invocationId, {
      name: 'tampered.txt',
      bytes: Buffer.byteLength(tamperedPayload),
      sha256: digest, // recorded digest of the ORIGINAL payload
      spacePath: 'artifacts/tampered.txt',
    }, { env, home: '/nonexistent' });
    const tampered = await ui(`/ui/api/invocations/${invocationId}/artifacts/tampered.txt`, { cookie });
    assert.equal(tampered.status, 409);
    const tamperedBody = await tampered.text();
    assert.ok(!tamperedBody.includes('PAYLOAD'));
    assert.match(tamperedBody, /does not match its recorded metadata/);

    // Bytes that diverge from the recorded metadata are refused, and the
    // download cap is enforced from metadata before any read.
    writeFileSync(path.join(soul.spacePath, 'artifacts', 'grown.txt'), 'small');
    addArtifact(invocationId, {
      name: 'grown.txt', bytes: 999, sha256: digest, spacePath: 'artifacts/grown.txt',
    }, { env, home: '/nonexistent' });
    const grown = await ui(`/ui/api/invocations/${invocationId}/artifacts/grown.txt`, { cookie });
    assert.equal(grown.status, 409);

    writeFileSync(path.join(soul.spacePath, 'artifacts', 'huge.txt'), 'stub');
    addArtifact(invocationId, {
      name: 'huge.txt', bytes: 64 * 1024 * 1024, sha256: digest, spacePath: 'artifacts/huge.txt',
    }, { env, home: '/nonexistent' });
    const huge = await ui(`/ui/api/invocations/${invocationId}/artifacts/huge.txt`, { cookie });
    assert.equal(huge.status, 413);
  }, { executor });
});

// --- loopback boundary --------------------------------------------------------------

test('the web client changes nothing about the loopback-only boundary', async () => {
  const { env } = scratch();
  // The bind guard is unchanged with /ui routes present.
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'localhost']) {
    assert.throws(() => assertLoopbackHost(host), /loopback literal/);
  }
  // runDaemon still refuses a widened listener before it opens.
  await assert.rejects(
    runDaemon({
      env: { ...env, AGENT_BOT_DAEMON_HOST: '0.0.0.0' },
      home: '/nonexistent',
      config: {},
    }),
    /loopback literal/,
  );
  // And a request that somehow arrives from a non-loopback peer is refused
  // before any /ui routing, exactly like every other route.
  const server = createDaemonServer({ env, home: '/nonexistent', config: {} });
  const [listener] = server.listeners('request');
  for (const pathname of ['/ui/', '/ui/api/me', '/ui/session', '/v0/health']) {
    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: pathname,
      headers: {},
      socket: { remoteAddress: '192.168.1.10' },
    });
    let status = null;
    let body = '';
    const res = {
      headersSent: false,
      writeHead(code) { status = code; },
      end(chunk) { body += chunk ?? ''; },
      destroy() {},
    };
    await listener(req, res);
    assert.equal(status, 403, pathname);
    assert.match(body, /loopback peers only/);
  }
});

// --- CLI ceremony ----------------------------------------------------------------

test('agent-bot web open mints a pairing URL through the local owner ceremony', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  await withServer(env, async ({ port }) => {
    // Simulate the recorded daemon state the CLI reads (0600 in production).
    writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      port,
      token: 'not-the-real-token-so-pairing-must-fail-authentication-checks',
      startedAt: '2026-08-12T09:00:00.000Z',
    }));
    const { webOpen } = await import('../agent-web.mjs');
    // Wrong recorded token: the health probe already fails, so the ceremony
    // refuses fail-closed before minting anything.
    await assert.rejects(
      webOpen({ env, home: '/nonexistent', requestedPrincipal: principal.principalId }),
      /daemon is not running/,
    );
  });

  // With the true token the ceremony yields a fragment URL bound to the
  // requested principal.
  await withServer(env, async ({ port, server }) => {
    writeFileSync(env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      port,
      token: server.token,
      startedAt: '2026-08-12T09:00:00.000Z',
    }));
    const { webOpen } = await import('../agent-web.mjs');
    const opened = await webOpen({ env, home: '/nonexistent', requestedPrincipal: principal.principalId });
    assert.match(opened.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/ui/#[0-9a-f]{64}$`));
    assert.equal(opened.principalId, principal.principalId);
  });
});

// Keep the client honest about its size: this is a solo-operator control
// surface, not a framework app.
test('the frontend stays dependency-free and references no external origins', () => {
  for (const asset of ['app.js', 'style.css', 'sw.js', 'index.html']) {
    const source = readFileSync(path.join(WEB_ROOT, asset), 'utf8');
    assert.doesNotMatch(source, /https?:\/\/(?!localhost|127\.0\.0\.1)/, asset);
    assert.doesNotMatch(source, /\bimport\s+.*\bfrom\s+['"](?!\.)/, asset);
  }
  const app = readFileSync(path.join(WEB_ROOT, 'app.js'), 'utf8');
  // No token-bearing storage: the client never touches persistent browser
  // storage APIs at all.
  assert.doesNotMatch(app, /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

// --- machine view (#1295) ---------------------------------------------------

const SECRET_SHAPE = /token|secret|private|pem|password|ghs_|ghp_|BEGIN/i;
function* walk(value, at = '') {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* walk(v, `${at}.${k}`);
  } else {
    yield [at, value];
  }
}

test('GET /ui/api/machine/server requires an active session and observe on souls ["*"] exactly', async () => {
  const { env } = scratch();
  const doctorCalls = [];
  await withServer(env, async ({ ui, pairCookie, server }) => {
    // No session at all is refused.
    const anon = await ui('/ui/api/machine/server', { csrf: false });
    assert.equal(anon.status, 401);

    // observe on one named soul is not a machine view.
    const narrow = seedPrincipal(env, { label: 'narrow', souls: [AGENT_ID], operations: ['observe'] });
    const narrowCookie = await pairCookie(narrow.principalId);
    const denied = await ui('/ui/api/machine/server', { cookie: narrowCookie });
    assert.equal(denied.status, 403);

    // The vocabulary itself refuses a mixed wildcard: ['*'] can only be exact.
    assert.throws(() => seedPrincipal(env, { label: 'mixed', souls: ['*', AGENT_ID], operations: ['observe'] }), /exactly \['\*'\]/);

    // observe on exactly ['*'] gets the machine view.
    const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe'] });
    const cookie = await pairCookie(full.principalId);
    const res = await ui('/ui/api/machine/server', { cookie });
    if (res.status !== 200) console.error('MACHINE500', await res.clone().text());
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const key of ['server_mode', 'base', 'enrolled', 'device_id', 'device_name', 'approved_harnesses', 'readiness']) {
      assert.ok(key in body, key);
    }
    // Nothing secret-shaped is projected.
    for (const [at, value] of walk(body)) {
      assert.doesNotMatch(String(value), /ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY|BEGIN OPENSSH/, `${at} leaks key material`);
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} names a secret-shaped field`);
    }
    // The readiness probe ran with the never-mint, never-cache flag.
    assert.equal(doctorCalls.length, 1);
    assert.ok(doctorCalls[0].includes('--no-verify-apps'), 'doctor spawn lacks --no-verify-apps');
    assert.ok(doctorCalls[0].includes('--json'));
  }, { webDeps: {
    serverStatus: () => ({ server_mode: true, base: 'https://agents.true-line.ai', enrolled: true, device_id: 'dev-1', device_name: 'studio-mac', approved_harnesses: ['codex'], repo: null }),
    // The real doctorReport path with a spied execFile: asserts the spawn
    // carries --no-verify-apps while returning a canned report, and nothing
    // writes the doctor cache.
    doctor: ({ env: dEnv }) => doctorReport({ env: dEnv, execFile: (file, args) => {
      doctorCalls.push(args);
      return JSON.stringify({ ready: false, first_actionable_failure: { check: 'binding-missing', action: 'run agent-bot join' }, machine: { checks: [{ id: 'binding-missing', status: 'fail', action: 'run agent-bot join' }] }, worktree: null });
    } }),
  } });
  // The doctor subprocess never mints and never leaves an advisory cache.
  assert.ok(!existsSync(path.join(env.XDG_STATE_HOME, 'agent-bot', 'identity-apps', 'doctor.json')));
});


test('machine/server awaits an async doctor without blocking the daemon and dedupes concurrent runs', async () => {
  const { env } = scratch();
  let spawns = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await withServer(env, async ({ ui, pairCookie }) => {
    const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe'] });
    const cookie = await pairCookie(full.principalId);
    // Two concurrent server requests share one doctor run.
    const one = ui('/ui/api/machine/server', { cookie });
    const two = ui('/ui/api/machine/server', { cookie });
    // A concurrent cheap route answers while doctor is still held — the
    // daemon loop is not blocked.
    const me = await (await ui('/ui/api/me', { cookie })).json();
    assert.equal(me.principal.principalId, full.principalId);
    assert.equal(spawns, 1, 'concurrent requests share a single doctor spawn');
    release({ ready: true, machine: { checks: [] }, worktree: null });
    const [r1, r2] = await Promise.all([one, two]);
    assert.equal((await r1.json()).readiness.ready, true);
    assert.equal((await r2.json()).readiness.ready, true);
  }, { webDeps: {
    serverStatus: () => ({ server_mode: false, base: null, enrolled: false, device_id: null, device_name: null, approved_harnesses: [], repo: null }),
    doctor: () => { spawns += 1; return held; },
  } });
});

test('machine/server honours a narrowed principal immediately — the principal is re-read each request', async () => {
  const { env } = scratch();
  await withServer(env, async ({ ui, pairCookie }) => {
    const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe'] });
    const cookie = await pairCookie(full.principalId);
    assert.equal((await ui('/ui/api/machine/server', { cookie })).status, 200);
    // Narrow the souls after the session exists: the very next request 403s.
    authorizeSouls(full.principalId, [AGENT_ID], { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' });
    assert.equal((await ui('/ui/api/machine/server', { cookie })).status, 403);
  }, { webDeps: {
    serverStatus: () => ({ server_mode: false, base: null, enrolled: false, device_id: null, device_name: null, approved_harnesses: [], repo: null }),
    doctor: async () => ({ ready: true, machine: { checks: [] }, worktree: null }),
  } });
});


// --- agent-machine view (#1295) ---------------------------------------------
import { createServer } from 'node:net';
import { generateKeyPairSync, sign as amSign } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { AGENT_MACHINE_DIR, loadOrCreateMachineKey, machineSocketPath, pinDaemonPub } from '../machine-client.mjs';

async function fakeAgentMachine(home, { keypair = generateKeyPairSync('ed25519'), signKey = null, replies = {} } = {}) {
  const dir = AGENT_MACHINE_DIR(home);
  mkdirSync(path.join(dir, 'peers'), { recursive: true });
  const sock = machineSocketPath({ home });
  const daemonPub = Buffer.from(keypair.publicKey.export({ format: 'jwk' }).x, 'base64url');
  writeFileSync(path.join(dir, 'daemon.pub'), daemonPub);
  const received = [];
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      received.push(req);
      const res = replies[req.verb] ?? { ok: true, state: 'ready' };
      res.timestamp = Math.floor(Date.now() / 1000);
      res.nonce = 'REPLYNONCE0000000001';
      res.request_nonce = req.nonce;
      const body = res.body !== undefined ? JSON.stringify(res.body) : '';
      const payload = [String(res.ok), res.diagnostic ?? '', res.message ?? '', res.state ?? '', body, String(res.timestamp), res.nonce, res.request_nonce ?? ''].join('\n');
      res.signature = amSign(null, Buffer.from(payload), signKey ?? keypair.privateKey).toString('base64');
      conn.end(`${JSON.stringify(res)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  server.unref();
  return { received, server, daemonPub, keypair };
}

test('agent-machine view: unpaired shows client_key false and machine-not-paired; tamper stays 200', async () => {
  const { root, env } = scratch();
  const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe'] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const denied = await ui('/ui/api/machine/agent-machine');
    assert.equal(denied.status, 401);
    const cookie = await pairCookie(full.principalId);
    const res = await ui('/ui/api/machine/agent-machine', { cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pairing.client_key, false);
    assert.equal(body.pairing.pin_fingerprint, null);
    assert.equal(body.pairing.pair_command, 'agent-bot machine pair');
    assert.equal(body.status.error, 'machine-not-paired');
    for (const [at, v] of walk(body)) {
      assert.doesNotMatch(String(v), /ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY/, `${at} leaks material`);
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} is secret-shaped`);
    }
  }, { home: root });
});

test('agent-machine view: paired shows status records and receipts; tamper is a section error, not a route failure', async () => {
  const { root, env } = scratch();
  const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe'] });
  const fm = await fakeAgentMachine(root, {
    replies: {
      status: { ok: true, state: 'ready', body: [{ id: 'daemon-ready', ok: true }] },
      receipts: { ok: true, body: [{ plan: 'p-1', command: 'update codex', state: 'applied', account: 'owner', soul: 'agent_x', harness: 'codex', session_id: 'ses_1', outcome: 'ok', at: '2026-08-12T09:00:00Z' }] },
    },
  });
  pinDaemonPub({ env, home: root });
  loadOrCreateMachineKey({ env, home: root });
  // terminal.pub with mode 000: existence-only check must still work.
  writeFileSync(path.join(AGENT_MACHINE_DIR(root), 'peers', 'terminal.pub'), Buffer.alloc(32, 1));
  chmodSync(path.join(AGENT_MACHINE_DIR(root), 'peers', 'terminal.pub'), 0o000);
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(full.principalId);
    const res = await ui('/ui/api/machine/agent-machine', { cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pairing.client_key, true);
    assert.equal(body.pairing.terminal_paired, true);
    assert.equal(body.status.ok, true);
    assert.equal(body.receipts.records[0].command, 'update codex');
    assert.deepEqual(fm.received.map((r) => r.verb).sort(), ['receipts', 'status']);
    assert.equal(fm.received[0].soul, undefined, 'reads carry no soul attribution');
    // Tamper: a reply signed by a different key (same advertised
    // daemon.pub, so the pin still matches) becomes a section error.
    fm.server.close();
    const wrong = generateKeyPairSync('ed25519');
    await fakeAgentMachine(root, { keypair: fm.keypair, signKey: wrong.privateKey });
    const bad = await (await ui('/ui/api/machine/agent-machine', { cookie })).json();
    assert.equal(bad.status.error, 'machine-reply-tampered');
  }, { home: root });
  chmodSync(path.join(AGENT_MACHINE_DIR(root), 'peers', 'terminal.pub'), 0o600);
});

test('agent-machine view: a corrupt client key reports invalid inside the section, still 200', async () => {
  const { root, env } = scratch();
  const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe'] });
  // A key file that fails the custody/shape checks must not throw out of the probe.
  // A symlinked key is refused by the custody read — it must surface as a
  // section value, not a thrown 500.
  const { machineStateDir } = await import('../machine-client.mjs');
  const { vouchKeyPath } = await import('../identity/vouch.mjs');
  const dir = machineStateDir({ env, home: root });
  mkdirSync(dir, { recursive: true });
  const target = path.join(root, 'elsewhere.key');
  writeFileSync(target, 'x');
  symlinkSync(target, vouchKeyPath(dir));
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(full.principalId);
    const res = await ui('/ui/api/machine/agent-machine', { cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pairing.client_key, 'invalid');
    assert.equal(body.pairing.client_key_error, 'key-unreadable');
  }, { home: root });
});
// --- agent-machine writes through immutable proposals (#1295) ---------------

test('machine plan requires approve on souls ["*"]; proposals execute through the approvals route', async () => {
  const { root, env } = scratch();
  const applied = [];
  const fm = await fakeAgentMachine(root, {
    replies: {
      plan: { ok: true, state: 'planned', message: 'p-77' },
      apply: { ok: true, state: 'applied' },
      update: { ok: true, state: 'updated' },
      status: { ok: true, state: 'ready' },
      receipts: { ok: true, body: [] },
    },
  });
  pinDaemonPub({ env, home: root });
  loadOrCreateMachineKey({ env, home: root });
  const writer = seedPrincipal(env, { label: 'writer', souls: ['*'], operations: ['observe', 'approve'] });
  const reader = seedPrincipal(env, { label: 'reader', souls: ['*'], operations: ['observe'] });
  const soulScoped = seedPrincipal(env, { label: 'scoped', souls: [AGENT_ID], operations: ['observe', 'approve'] });
  await withServer(env, async ({ ui, pairCookie, clock }) => {
    const w = await pairCookie(writer.principalId);
    const r = await pairCookie(reader.principalId);
    const s = await pairCookie(soulScoped.principalId);

    // Plan: observe-only and soul-scoped principals are refused.
    assert.equal((await ui('/ui/api/machine/agent-machine/plan', { method: 'POST', body: { name: 'codex' }, cookie: r })).status, 403);
    assert.equal((await ui('/ui/api/machine/agent-machine/plan', { method: 'POST', body: { name: 'codex' }, cookie: s })).status, 403);
    // Unknown body key refused; name required.
    assert.equal((await ui('/ui/api/machine/agent-machine/plan', { method: 'POST', body: { name: 'codex', extra: 1 }, cookie: w })).status, 400);
    assert.equal((await ui('/ui/api/machine/agent-machine/plan', { method: 'POST', body: { option: 'x' }, cookie: w })).status, 400);
    const plan = await (await ui('/ui/api/machine/agent-machine/plan', { method: 'POST', body: { name: 'codex' }, cookie: w })).json();
    assert.equal(plan.plan_id, 'p-77');
    assert.equal(fm.received.at(-1).verb, 'plan');
    assert.equal(fm.received.at(-1).soul, undefined);

    // Proposal creation: soul-scoped refused; apply without plan_id refused.
    assert.equal((await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'apply', plan_id: 'p-77' }, cookie: s })).status, 403);
    assert.equal((await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'apply' }, cookie: w })).status, 400);
    const { proposal } = await (await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'apply', plan_id: 'p-77' }, cookie: w })).json();
    assert.equal(proposal.tool, 'machine.apply');
    assert.equal(proposal.agentId, null);

    // The soul-scoped principal cannot see the machine proposal.
    const scopedList = await (await ui('/ui/api/approvals', { cookie: s })).json();
    assert.equal(scopedList.proposals.length, 0);
    const wList = await (await ui('/ui/api/approvals', { cookie: w })).json();
    assert.equal(wList.proposals[0].proposalId, proposal.proposalId);

    // Status endpoint: open while undecided.
    assert.equal((await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json()).status, 'open');

    // Wrong digest: 409 and agent-machine is never called.
    const calls = fm.received.length;
    const forged = createHash('sha256').update('nope').digest('hex');
    assert.equal((await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: forged }, cookie: w })).status, 409);
    assert.equal(fm.received.length, calls);

    // Correct digest: the signed apply reaches agent-machine with harness
    // 'web-ui' and no soul/session_id; the outcome becomes 'executed'.
    const decided = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: proposal.operationDigest }, cookie: w });
    assert.equal(decided.status, 200);
    await waitFor(async () => (await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json()).status === 'executed');
    const apply = fm.received.at(-1);
    assert.equal(apply.verb, 'apply');
    assert.equal(apply.harness, 'web-ui');
    assert.equal(apply.soul, undefined);
    assert.equal(apply.session_id, undefined);
    assert.equal(apply.plan_id, 'p-77');

    // Deny and expiry never reach agent-machine.
    const { proposal: p2 } = await (await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'update', name: 'codex' }, cookie: w })).json();
    await ui(`/ui/api/approvals/${p2.proposalId}/decision`, {
      method: 'POST', body: { decision: 'deny', digest: p2.operationDigest }, cookie: w });
    assert.equal((await (await ui(`/ui/api/machine/agent-machine/proposals/${p2.proposalId}`, { cookie: w })).json()).status, 'denied');
    const calls2 = fm.received.length;
    assert.equal(fm.received.at(-1).verb, 'apply', 'deny never reached agent-machine');

    // Expiry: advance the clock past the proposal TTL.
    const { proposal: p3 } = await (await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'update', name: 'codex' }, cookie: w })).json();
        clock.value = new Date(clock.value.getTime() + 16 * 60 * 1000);
    await waitFor(async () => (await (await ui(`/ui/api/machine/agent-machine/proposals/${p3.proposalId}`, { cookie: w })).json()).status !== 'open', { timeoutMs: 2000 });
    assert.equal((await (await ui(`/ui/api/machine/agent-machine/proposals/${p3.proposalId}`, { cookie: w })).json()).status, 'expired');
    assert.equal(fm.received.length, calls2);

    // No secret-shaped field or value crosses the write routes.
    const listing = await (await ui('/ui/api/machine/agent-machine/proposals/' + p3.proposalId, { cookie: w })).json();
    for (const [at, v] of walk(listing)) {
      assert.doesNotMatch(String(v), /ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY/, at);
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} is secret-shaped`);
    }
  }, { home: root });
});

test('machine proposal lifecycle: operation visible, no late-expiry overwrite, scope 404', async () => {
  const { root, env } = scratch();
  const fm = await fakeAgentMachine(root, { replies: { apply: { ok: true, state: 'applied' } } });
  pinDaemonPub({ env, home: root });
  loadOrCreateMachineKey({ env, home: root });
  const writer = seedPrincipal(env, { label: 'w', souls: ['*'], operations: ['observe', 'approve'] });
  const clock = { t: Date.parse('2026-08-12T09:00:00Z') };
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    const { proposal } = await (await ui('/ui/api/machine/agent-machine/proposals', {
      method: 'POST', body: { verb: 'apply', name: 'codex', option: 'latest', target: 'prod', plan_id: 'p-1' }, cookie: w })).json();
    // Every digest-covered field is visible to the approver.
    assert.equal(proposal.operation.verb, 'apply');
    assert.equal(proposal.operation.name, 'codex');
    assert.equal(proposal.operation.option, 'latest');
    assert.equal(proposal.operation.target, 'prod');
    assert.equal(proposal.operation.plan_id, 'p-1');
    assert.equal(proposal.operation.harness, 'web-ui');
    // Approve, then advance past the 15-min TTL: outcome stays executed,
    // never rewritten by the (now-cleared) expiry timer.
    const dec = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: proposal.operationDigest }, cookie: w });
    assert.equal(dec.status, 200, JSON.stringify(await dec.json()));
    const outcome = await waitFor(async () => {
      const o = await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json();
      return o.status === 'executed' ? o : (o.status === 'failed' ? o : null);
    }).catch(() => null);
    assert.ok(outcome?.status === 'executed', JSON.stringify(outcome));
    clock.t += 20 * 60 * 1000;
    assert.equal((await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json()).status, 'executed');
    // A non-machine proposal id is a 404, not 'open'.
    assert.equal((await ui('/ui/api/machine/agent-machine/proposals/proposal_deadbeef', { cookie: w })).status, 404);
  }, { home: root, now: () => new Date(clock.t) });
});

test('machine plan/proposal fields are type-checked strings capped at 128; card renders the operation', async () => {
  const { root, env } = scratch();
  const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe', 'approve'] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const cookie = await pairCookie(full.principalId);
    // Non-string fields and >128-char strings fail 400 before anything runs.
    for (const body of [
      { name: 42 }, { name: 'x', option: { a: 1 } }, { name: 'x', target: ['t'] }, { name: 'x'.repeat(129) },
    ]) {
      assert.equal((await ui('/ui/api/machine/agent-machine/plan', { method: 'POST', body, cookie })).status, 400, JSON.stringify(body));
    }
    for (const body of [
      { verb: 'apply', plan_id: 7 }, { verb: 'apply', plan_id: 'p', name: {} }, { verb: 'update', option: 'x'.repeat(129) },
    ]) {
      assert.equal((await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body, cookie })).status, 400, JSON.stringify(body));
    }
    // The Approvals card renders every digest-covered operation field.
    const { proposal } = await (await ui('/ui/api/machine/agent-machine/proposals', {
      method: 'POST', body: { verb: 'update', name: 'example' }, cookie })).json();
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /proposal\.operation/);
assert.deepEqual(proposal.operation, { verb: 'update', harness: 'web-ui', name: 'example' });
  }, { home: root });
});

test('machine pair, pair --repin, and unpair proposals run through the owner gate (#1295)', async () => {
  const { root, env } = scratch();
  const fm = await fakeAgentMachine(root, {
    replies: {
      status: { ok: true, state: 'ready', body: [] },
      receipts: { ok: true, body: [] },
    },
  });
  const writer = seedPrincipal(env, { label: 'writer', souls: ['*'], operations: ['observe', 'approve'] });
  const reader = seedPrincipal(env, { label: 'reader', souls: ['*'], operations: ['observe'] });
  const scoped = seedPrincipal(env, { label: 'scoped', souls: [AGENT_ID], operations: ['observe', 'approve'] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    const r = await pairCookie(reader.principalId);
    const s = await pairCookie(scoped.principalId);

    // Authorization and validation on pair/unpair proposals.
    assert.equal((await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'pair' }, cookie: r })).status, 403);
    assert.equal((await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body: { verb: 'pair' }, cookie: s })).status, 403);
    for (const body of [
      { verb: 'pair', name: 'x' },
      { verb: 'pair', repin: 'yes' },
      { verb: 'unpair', repin: true },
      { verb: 'unpair', name: 'x' },
      { verb: 'update', repin: true },
    ]) {
      assert.equal((await ui('/ui/api/machine/agent-machine/proposals', { method: 'POST', body, cookie: w })).status, 400, JSON.stringify(body));
    }

    // 1. Propose and approve initial pair.
    const { proposal: pPair } = await (await ui('/ui/api/machine/agent-machine/proposals', {
      method: 'POST', body: { verb: 'pair' }, cookie: w })).json();
    assert.equal(pPair.tool, 'machine.pair');
    assert.deepEqual(pPair.operation, { verb: 'pair' });
    assert.equal(pPair.summary, 'agent-machine pair');
    const decPair = await ui(`/ui/api/approvals/${pPair.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: pPair.operationDigest }, cookie: w });
    assert.equal(decPair.status, 200);
    const pairOut = await waitFor(async () => {
      const o = await (await ui(`/ui/api/machine/agent-machine/proposals/${pPair.proposalId}`, { cookie: w })).json();
      return o.status === 'executed' ? o : (o.status === 'failed' ? o : null);
    });
    assert.equal(pairOut.status, 'executed', JSON.stringify(pairOut));
    assert.equal(pairOut.result.paired, true);
    assert.match(pairOut.result.pin_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(pairOut.result.replaced_fingerprint, null);

    // View now reports paired.
    const afterPair = await (await ui('/ui/api/machine/agent-machine', { cookie: w })).json();
    assert.equal(afterPair.pairing.client_key, true);
    assert.equal(afterPair.pairing.pin_fingerprint, pairOut.result.pin_fingerprint);
    assert.ok(afterPair.pairing.agent_daemon_peer.includes('.next'));

    // 2. Rotate daemon.pub: pair without repin fails with machine-pin-mismatch; pair with repin succeeds.
    fm.server.close();
    const rotated = generateKeyPairSync('ed25519');
    await fakeAgentMachine(root, {
      keypair: rotated,
      replies: { status: { ok: true, state: 'ready', body: [] }, receipts: { ok: true, body: [] } },
    });
    const { proposal: pNoRepin } = await (await ui('/ui/api/machine/agent-machine/proposals', {
      method: 'POST', body: { verb: 'pair' }, cookie: w })).json();
    await ui(`/ui/api/approvals/${pNoRepin.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: pNoRepin.operationDigest }, cookie: w });
    const noRepinOut = await waitFor(async () => {
      const o = await (await ui(`/ui/api/machine/agent-machine/proposals/${pNoRepin.proposalId}`, { cookie: w })).json();
      return o.status === 'failed' ? o : null;
    });
    assert.match(noRepinOut.error, /machine-pin-mismatch/);

    const { proposal: pRepin } = await (await ui('/ui/api/machine/agent-machine/proposals', {
      method: 'POST', body: { verb: 'pair', repin: true }, cookie: w })).json();
    assert.deepEqual(pRepin.operation, { verb: 'pair', repin: true });
    assert.equal(pRepin.summary, 'agent-machine pair --repin');
    await ui(`/ui/api/approvals/${pRepin.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: pRepin.operationDigest }, cookie: w });
    const repinOut = await waitFor(async () => {
      const o = await (await ui(`/ui/api/machine/agent-machine/proposals/${pRepin.proposalId}`, { cookie: w })).json();
      return o.status === 'executed' ? o : (o.status === 'failed' ? o : null);
    });
    assert.equal(repinOut.status, 'executed', JSON.stringify(repinOut));
    assert.equal(repinOut.result.replaced_fingerprint, pairOut.result.pin_fingerprint);
    assert.notEqual(repinOut.result.pin_fingerprint, pairOut.result.pin_fingerprint);

    // 3. Propose and approve unpair.
    const { proposal: pUnpair } = await (await ui('/ui/api/machine/agent-machine/proposals', {
      method: 'POST', body: { verb: 'unpair' }, cookie: w })).json();
    assert.equal(pUnpair.tool, 'machine.unpair');
    assert.deepEqual(pUnpair.operation, { verb: 'unpair' });
    await ui(`/ui/api/approvals/${pUnpair.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: pUnpair.operationDigest }, cookie: w });
    const unpairOut = await waitFor(async () => {
      const o = await (await ui(`/ui/api/machine/agent-machine/proposals/${pUnpair.proposalId}`, { cookie: w })).json();
      return o.status === 'executed' ? o : (o.status === 'failed' ? o : null);
    });
    assert.deepEqual(unpairOut.result, { unpaired: true });
    const afterUnpair = await (await ui('/ui/api/machine/agent-machine', { cookie: w })).json();
    assert.equal(afterUnpair.pairing.pin_fingerprint, null);
    assert.ok(afterUnpair.pairing.agent_daemon_peer.includes('.revoked'));

    // No secret-shaped field or value crosses the pair/unpair proposal responses.
    for (const [at, v] of walk([pPair, pairOut, pRepin, repinOut, pUnpair, unpairOut])) {
      assert.doesNotMatch(String(v), /ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY/, at);
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} is secret-shaped`);
    }
  }, { home: root });
});

// --- souls view (#1295) -----------------------------------------------------

test('GET /ui/api/souls: per-soul observe only; sessions/bindings projected without paths or secrets', async () => {
  const { env } = scratch();
  seedSoul(env);
  seedSoul(env, { id: OTHER_ID });
  const scoped = seedPrincipal(env, { label: 'scoped', souls: [AGENT_ID], operations: ['observe'] });
  const full = seedPrincipal(env, { label: 'full', souls: ['*'], operations: ['observe'] });
  // Plant distinctive values that must never appear in the projection.
  const { openSession } = await import('../identity/agent-sessions.mjs');
  const { stateDirectory } = await import('../state-paths.mjs');
  const stateDir = stateDirectory({ env, home: '/nonexistent' });
  openSession({ soulId: AGENT_ID, transcript: { provider: 'codex', id: 'TRANSCRIPT_LOCATOR_SECRET_PATH' }, harness: 'codex', stateDir });
  const bindingsView = [{ agentId: AGENT_ID, harness: 'codex', sessionId: 'ses_bind_1',
    worktree: '/very/secret/abs/path/worktree-1', boundAt: '2026-08-12T08:00:00Z', lastUsedAt: '2026-08-12T09:00:00Z' }];
  await withServer(env, async ({ ui, pairCookie }) => {
    assert.equal((await ui('/ui/api/souls')).status, 401);
    const cookie = await pairCookie(scoped.principalId);
    const scopedView = await (await ui('/ui/api/souls', { cookie })).json();
    assert.equal(scopedView.souls.length, 1);
    assert.equal(scopedView.souls[0].id, AGENT_ID);
    assert.equal(scopedView.souls[0].role, 'lead');
    assert.equal(scopedView.souls[0].sessions.length, 1);
    assert.equal(scopedView.souls[0].bindings.length, 1);
    assert.equal(scopedView.souls[0].bindings[0].worktree, 'worktree-1');
    const all = await (await ui('/ui/api/souls', { cookie: await pairCookie(full.principalId) })).json();
    assert.equal(all.souls.length, 2);
    const flat = JSON.stringify(scopedView);
    for (const leak of ['TRANSCRIPT_LOCATOR_SECRET_PATH', '/very/secret/abs/path', 'secret', 'transcript', '.git']) {
      assert.ok(!flat.includes(leak), `projection leaks ${leak}`);
    }
    // Denied principal gets nothing.
    const none = seedPrincipal(env, { label: 'none', souls: [], operations: [] });
    assert.equal((await ui('/ui/api/souls', { cookie: await pairCookie(none.principalId) })).status, 403);
  }, { webDeps: { soulBindings: () => bindingsView } });
});


test('souls projection: orphan specialists returned; app.js uses the route field names', async () => {
  const { root, env } = scratch();
  seedSoul(env, { id: 'agent_66666666-6666-4666-8666-666666666666', parentId: 'agent_77777777-7777-4777-8777-777777777777' });
  const scoped = seedPrincipal(env, { label: 's', souls: ['agent_66666666-6666-4666-8666-666666666666'], operations: ['observe'] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(scoped.principalId);
    const { souls } = await (await ui('/ui/api/souls', { cookie: w })).json();
    const found = souls.find((s) => s.id === 'agent_66666666-6666-4666-8666-666666666666');
    assert.ok(found, 'a scoped principal sees its specialist soul');
    assert.equal(found.parentId, 'agent_77777777-7777-4777-8777-777777777777');
    assert.equal(found.role, 'specialist');
  }, { home: root });
  // The shipped UI reads the field names the route actually sends, and
  // treats souls whose parent is absent from the collection as roots.
  const app = readFileSync(path.join(WEB_ROOT, 'app.js'), 'utf8');
  assert.match(app, /s\.started_at/);
  assert.match(app, /s\.ended_at/);
  assert.match(app, /!visible\.has\(o\.parentId\)/);
  assert.match(app, /specialist of \$\{orphanOf\}/);
});

// --- settings section (#1295) ------------------------------------------------

test('settings view is machine-observe; proposals edit only the settled keys', async () => {
  const { root, env } = scratch();
  const configFile = path.join(env.XDG_CONFIG_HOME ?? root, 'agent-bot', 'config.json');
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({
    prefix: 'alice', apps: { codex: 'custom' }, owner: 'org',
    settings: { daemonPreference: 'off', unmanagedAuthors: ['ai9d'], spacesRoot: '/abs/path' },
  }, null, 2) + '\n', { mode: 0o640 });
  env.AGENT_BOT_CONFIG = configFile;
  const writer = seedPrincipal(env, { label: 'w', souls: ['*'], operations: ['observe', 'approve'] });
  const scoped = seedPrincipal(env, { label: 's', souls: [AGENT_ID], operations: ['observe', 'approve'] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    const s = await pairCookie(scoped.principalId);
    // GET: observe gate + projection with editable flags.
    assert.equal((await ui('/ui/api/machine/settings', { cookie: s })).status, 403);
    const view = await (await ui('/ui/api/machine/settings', { cookie: w })).json();
    assert.equal(view.path, configFile);           // AGENT_BOT_CONFIG honored
    assert.equal(view.valid, true);
    assert.equal(view.config.settings.daemonPreference.editable, true);
    assert.equal(view.config.settings.spacesRoot.editable, false);
    assert.equal(view.config.settings.unmanagedAuthors.editable, false);
    assert.equal(view.config.features['github-identity'].editable, true);
    assert.equal(view.config.owner, 'org');

    // POST validation: trust-root and unknown keys refused; bad values refused.
    for (const body of [
      { changes: { 'settings.ownerKeys': ['x'] } },
      { changes: { 'settings.spacesRoot': '/x' } },
      { changes: { 'owner': 'x' } },
      { changes: { 'settings.daemonPreference': 'sometimes' } },
      { changes: { 'features.github-identity': 'yes' } },
      { changes: {} },
      { changes: { 'settings.daemonPreference': 'on' }, extra: 1 },
    ]) {
      assert.equal((await ui('/ui/api/machine/settings/proposals', { method: 'POST', body, cookie: w })).status, 400, JSON.stringify(body));
    }
    assert.equal((await ui('/ui/api/machine/settings/proposals', { method: 'POST', body: { changes: { 'settings.daemonPreference': 'prefer' } }, cookie: s })).status, 403);

    // Approved proposal: file updated, other keys + order + mode preserved.
    const { proposal } = await (await ui('/ui/api/machine/settings/proposals', {
      method: 'POST', body: { changes: { 'settings.daemonPreference': 'prefer', 'features.github-identity': true } }, cookie: w })).json();
    assert.equal(proposal.tool, 'machine.settings');
    const decided = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: proposal.operationDigest }, cookie: w });
    assert.equal(decided.status, 200);
    await waitFor(async () => (await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json()).status === 'executed');
    const after = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(after.settings.daemonPreference, 'prefer');
    assert.equal(after.settings.unmanagedAuthors[0], 'ai9d');
    assert.equal(after.settings.spacesRoot, '/abs/path');
    assert.equal(after.features['github-identity'], true);
    assert.equal(Object.keys(after)[0], 'prefix'); // order preserved
    assert.equal(statSync(configFile).mode & 0o777, 0o640); // mode preserved
    // Old path still works.
    assert.equal((await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json()).status, 'executed');

    // Drift: file changes between proposal and approval → settings-drifted, untouched.
    const { proposal: p2 } = await (await ui('/ui/api/machine/settings/proposals', {
      method: 'POST', body: { changes: { 'settings.daemonPreference': 'required' } }, cookie: w })).json();
    appendFileSync(configFile, '');
    writeFileSync(configFile, readFileSync(configFile, 'utf8') + ' ');
    await ui(`/ui/api/approvals/${p2.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: p2.operationDigest }, cookie: w });
    await waitFor(async () => (await (await ui(`/ui/api/machine/agent-machine/proposals/${p2.proposalId}`, { cookie: w })).json()).status === 'failed');
    const outcome = await (await ui(`/ui/api/machine/agent-machine/proposals/${p2.proposalId}`, { cookie: w })).json();
    assert.match(outcome.error, /settings-drifted|changed since/);
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).settings.daemonPreference, 'prefer');

    // Deny: file untouched.
    const { proposal: p3 } = await (await ui('/ui/api/machine/settings/proposals', {
      method: 'POST', body: { changes: { 'settings.daemonPreference': 'required' } }, cookie: w })).json();
    await ui(`/ui/api/approvals/${p3.proposalId}/decision`, {
      method: 'POST', body: { decision: 'deny', digest: p3.operationDigest }, cookie: w });
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).settings.daemonPreference, 'prefer');

    // Absent config + absent directory: the proposal creates both.
    const fresh = path.join(root, 'nowhere', 'agent-bot', 'config.json');
    env.AGENT_BOT_CONFIG = fresh;
    const absent = await (await ui('/ui/api/machine/settings', { cookie: w })).json();
    assert.equal(absent.exists, false);
    const { proposal: p4 } = await (await ui('/ui/api/machine/settings/proposals', {
      method: 'POST', body: { changes: { 'settings.daemonPreference': 'required' } }, cookie: w })).json();
    await ui(`/ui/api/approvals/${p4.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: p4.operationDigest }, cookie: w });
    await waitFor(async () => (await (await ui(`/ui/api/machine/agent-machine/proposals/${p4.proposalId}`, { cookie: w })).json()).status === 'executed');
    assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).settings.daemonPreference, 'required');
    assert.equal(statSync(fresh).mode & 0o777, 0o600);
    assert.equal(Object.keys(JSON.parse(readFileSync(fresh, 'utf8'))).length, 1); // only the changed keys
    env.AGENT_BOT_CONFIG = configFile;

    // Secret walk over the GET projection.
    for (const [at, v] of walk(view)) {
      assert.doesNotMatch(String(v), /ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY/, at);
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} is secret-shaped`);
    }
  }, { home: root });
});

test('settings: prototype keys refused, unset removes key, summary shows values, unknowns counted', async () => {
  const { root, env } = scratch();
  const configFile = path.join(root, '.config', 'agent-bot', 'config.json');
  mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  writeFileSync(configFile, JSON.stringify({
    settings: { daemonPreference: 'prefer', mysteriousKey: 1 },
  }), { mode: 0o600 });
  const writer = seedPrincipal(env, { label: 'w', souls: ['*'], operations: ['observe', 'approve'] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    // GET projection: known keys flagged editable, unknowns counted not echoed.
    const view = await (await ui('/ui/api/machine/settings', { cookie: w })).json();
    assert.equal(view.config.settings.daemonPreference.editable, true);
    assert.equal(view.config.settings.mysteriousKey, undefined);
    assert.equal(view.config.settingsExtra, 1);
    // Prototype keys fail closed before reaching the writer.
    for (const key of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      const res = await ui('/ui/api/machine/settings/proposals', { method: 'POST', body: { changes: { [key]: 'x' } }, cookie: w });
      assert.equal(res.status, 400, `${key} must be refused`);
    }
    // Summary shows old -> new for every change.
    const { proposal: p2 } = await (await ui('/ui/api/machine/settings/proposals', {
      method: 'POST', body: { changes: { 'settings.daemonPreference': 'required' } }, cookie: w })).json();
    assert.match(p2.summary, /daemonPreference.*prefer.*→.*required|daemonPreference: prefer → required/);
    // Approve the unset: daemonPreference goes to null -> key removed, other keys intact.
    const { proposal: p3 } = await (await ui('/ui/api/machine/settings/proposals', {
      method: 'POST', body: { changes: { 'settings.daemonPreference': null } }, cookie: w })).json();
    await ui(`/ui/api/approvals/${p3.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: p3.operationDigest }, cookie: w });
    await waitFor(async () => (await (await ui(`/ui/api/machine/agent-machine/proposals/${p3.proposalId}`, { cookie: w })).json()).status === 'executed');
    const written = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal('daemonPreference' in (written.settings ?? {}), false);
    assert.equal(written.settings.mysteriousKey, 1);
  }, { home: root });
});

// --- server actions (#1295) --------------------------------------------------

test('server reconcile and enroll: gates, pending-approval outcome, drift-free device file', async () => {
  const { root, env } = scratch();
  env.AGENT_BOT_SERVER = 'https://identity.example.test';
  // Plant a device record so enroll reuses its harness list.
  const { statePaths } = await import('../identity/server-client.mjs');
  const deviceFile = statePaths({ env, home: root }).device;
  mkdirSync(path.dirname(deviceFile), { recursive: true, mode: 0o700 });
  writeFileSync(deviceFile, JSON.stringify({
    server: env.AGENT_BOT_SERVER, device_id: 'dev_1', jkt: 'JKT1', method: 'device_code',
    platform: 'test', device_name: 'box', harnesses: ['codex'], read_only: false,
    ephemeral: false, expires_at: null, management: 'managed', server_key_id: 'k1',
    enrolled_at: '2026-01-01T00:00:00Z',
  }, null, 2) + '\n', { mode: 0o600 });
  const writer = seedPrincipal(env, { label: 'w', souls: ['*'], operations: ['observe', 'approve'] });
  const scoped = seedPrincipal(env, { label: 's', souls: [AGENT_ID], operations: ['observe', 'approve'] });
  const spawns = [];
  let finishEnroll = () => {};
  const enrollGate = new Promise((r) => { finishEnroll = r; });
  const spawnFake = async (args, report) => {
    spawns.push(args);
    if (args[0] === 'reconcile') {
      return { stdout: JSON.stringify({ reconciled: [{ operation_id: 'op_1', state: 'issued', reason: 'expired', token: 'ghs_x' }] }) };
    }
    // enroll: emit the prompt line, hold pending until the test releases,
    // then print the record — mirroring the real --json stream.
    report?.({ status: 'pending-approval', user_code: 'ABCD-EFGH',
      verification_uri: 'https://identity.example.test/device',
      expires_at: '2026-08-12T09:15:00Z', thumbprint: 'JKT1' });
    await enrollGate;
    return { stdout: JSON.stringify({ device_id: 'dev_2', harnesses: ['codex'] }) };
  };
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    const s = await pairCookie(scoped.principalId);
    // Gates.
    assert.equal((await ui('/ui/api/machine/server/reconcile', { method: 'POST', body: {}, cookie: s })).status, 403);
    assert.equal((await ui('/ui/api/machine/server/enroll', { method: 'POST', body: {}, cookie: s })).status, 403);
    // Reconcile: counts, no secrets.
    const rec = await (await ui('/ui/api/machine/server/reconcile', { method: 'POST', body: {}, cookie: w })).json();
    assert.equal(rec.reconciled, 1);
    assert.deepEqual(rec.results, [{ operation_id: 'op_1', state: 'issued', reason: 'expired' }]);
    for (const [at, v] of walk(rec)) {
      assert.doesNotMatch(String(v), /ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY/, at);
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} is secret-shaped`);
    }
    // Enroll: proposal → pending-approval with prompt fields → executed.
    const { proposal } = await (await ui('/ui/api/machine/server/enroll', { method: 'POST', body: {}, cookie: w })).json();
    assert.equal(proposal.tool, 'machine.enroll');
    const decided = await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: proposal.operationDigest }, cookie: w });
    assert.equal(decided.status, 200);
    const pending = await waitFor(async () => {
      const out = await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json();
      return out.status === 'pending-approval' ? out : null;
    });
    assert.equal(pending.user_code, 'ABCD-EFGH');
    assert.equal(pending.verification_uri, 'https://identity.example.test/device');
    assert.equal(pending.thumbprint, 'JKT1');
    finishEnroll();
    await waitFor(async () => (await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json()).status === 'executed');
    assert.ok(spawns.some((a) => a[0] === 'enroll' && a.includes('--force')));
    // Deny: spawn never happens.
    spawns.length = 0;
    const { proposal: p2 } = await (await ui('/ui/api/machine/server/enroll', { method: 'POST', body: {}, cookie: w })).json();
    await ui(`/ui/api/approvals/${p2.proposalId}/decision`, {
      method: 'POST', body: { decision: 'deny', digest: p2.operationDigest }, cookie: w });
    assert.equal(spawns.length, 0);
  }, { home: root, webDeps: { spawnServerCli: spawnFake } });
});

test('enroll stdout parser: chunked JSON lines, non-JSON ignored, complete URI wins', () => {
  const seen = [];
  let tail = enrollStdoutChunk('', '{"prompt":{"user_code":"ABCD-EFGH","verification_uri":"https://agents.true-l', (l) => seen.push(l));
  tail = enrollStdoutChunk(tail, 'ine.ai/device","verification_uri_complete":"https://agents.true-line.ai/device?user_code=ABCD-EFGH","expires_in":600,"jkt":"j1"}}\nnot json at all\n{"rec', (l) => seen.push(l));
  enrollStdoutChunk(tail, '"ord":{"device_id":"d1"}}\n', (l) => seen.push(l));
  assert.equal(seen.length, 3);
  assert.equal(parseEnrollLine(seen[1]), null); // the non-JSON line is ignored
  assert.equal(parseEnrollLine('garbage'), null);
  const reported = [];
  enrollPromptReport(parseEnrollLine(seen[0]).prompt, (r) => reported.push(r), () => new Date('2026-08-12T09:00:00Z'));
  assert.equal(reported[0].verification_uri, 'https://agents.true-line.ai/device?user_code=ABCD-EFGH');
  reported.length = 0;
  enrollPromptReport({ user_code: 'WXYZ-1234', verification_uri: 'https://agents.true-line.ai/device' }, (r) => reported.push(r));
  assert.equal(reported[0].verification_uri, 'https://agents.true-line.ai/device?user_code=WXYZ-1234');
});

test('enroll serialization: a second enroll while one is open or running is refused', async () => {
  const { root, env } = scratch();
  env.AGENT_BOT_SERVER = 'https://identity.example.test';
  const { statePaths } = await import('../identity/server-client.mjs');
  const deviceFile = statePaths({ env, home: root }).device;
  mkdirSync(path.dirname(deviceFile), { recursive: true, mode: 0o700 });
  writeFileSync(deviceFile, JSON.stringify({ server: env.AGENT_BOT_SERVER, device_id: 'dev_1', jkt: 'J', method: 'device_code', platform: 't', device_name: 'b', harnesses: ['codex'], read_only: false, ephemeral: false, expires_at: null, management: 'managed', server_key_id: 'k1', enrolled_at: '2026-01-01T00:00:00Z' }) + '\n', { mode: 0o600 });
  const writer = seedPrincipal(env, { label: 'w', souls: ['*'], operations: ['observe', 'approve'] });
  const spawnFake = async () => ({ stdout: '{"record":{"device_id":"d9","harnesses":["codex"]}}\n' });
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    const first = await ui('/ui/api/machine/server/enroll', { method: 'POST', body: {}, cookie: w });
    assert.equal(first.status, 200);
    // An open machine.enroll proposal blocks the second creation with the
    // registered refusal code, and it stays blocked once executing.
    const second = await ui('/ui/api/machine/server/enroll', { method: 'POST', body: {}, cookie: w });
    assert.equal(second.status, 409);
    assert.match((await second.text()), /enroll-in-flight/);
  }, { home: root, webDeps: { spawnServerCli: spawnFake } });
});

test('enroll execution: the final non-prompt record supplies device_id', async () => {
  const { root, env } = scratch();
  env.AGENT_BOT_SERVER = 'https://identity.example.test';
  const { statePaths } = await import('../identity/server-client.mjs');
  const deviceFile = statePaths({ env, home: root }).device;
  mkdirSync(path.dirname(deviceFile), { recursive: true, mode: 0o700 });
  writeFileSync(deviceFile, JSON.stringify({ server: env.AGENT_BOT_SERVER, device_id: 'dev_1', jkt: 'J', method: 'device_code', platform: 't', device_name: 'b', harnesses: ['codex'], read_only: false, ephemeral: false, expires_at: null, management: 'managed', server_key_id: 'k1', enrolled_at: '2026-01-01T00:00:00Z' }) + '\n', { mode: 0o600 });
  const writer = seedPrincipal(env, { label: 'w', souls: ['*'], operations: ['observe', 'approve'] });
  // The real --json stream: a prompt line, a non-JSON line, then the final
  // record — each newline-terminated.
  const stdout = [
    '{"prompt":{"user_code":"ABCD-EFGH","verification_uri":"https://agents.true-line.ai/device","verification_uri_complete":"https://agents.true-line.ai/device?user_code=ABCD-EFGH","expires_in":600,"jkt":"j1"}}',
    'not json at all',
    '{"record":{"device_id":"dev_new","harnesses":["codex","claude"]}}',
    '',
  ].join('\n');
  const spawnFake = async () => ({ stdout });
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    const { proposal } = await (await ui('/ui/api/machine/server/enroll', { method: 'POST', body: {}, cookie: w })).json();
    await ui(`/ui/api/approvals/${proposal.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: proposal.operationDigest }, cookie: w });
    const outcome = await waitFor(async () => {
      const out = await (await ui(`/ui/api/machine/agent-machine/proposals/${proposal.proposalId}`, { cookie: w })).json();
      return out.status === 'executed' || out.status === 'failed' ? out : null;
    });
    assert.equal(outcome.status, 'executed');
    assert.equal(outcome.result.device_id, 'dev_new');
    assert.deepEqual(outcome.result.harnesses, ['codex', 'claude']);
  }, { home: root, webDeps: { spawnServerCli: spawnFake } });
});

// --- catalog + status digest (#1295) -----------------------------------------

test('catalog view verifies server envelope; deliver relays it; digest uploads', async () => {
  const { root, env } = scratch();
  env.AGENT_BOT_SERVER = 'https://identity.example.test';
  // A real signed envelope fixture: ed25519 key, key_id = sha256(pub)[:16].
  const { generateKeyPairSync, createHash: ch } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const keyId = ch('sha256').update(rawPub).digest('hex').slice(0, 16);
  const catBytes = Buffer.from(JSON.stringify({ items: [{ name: 'codex', provider: 'formula', version: '1.2.3' }] }));
  const { sign } = await import('node:crypto');
  const signed = `agent-bot-catalog/1\n${keyId}\n7\n1700000000\n${ch('sha256').update(catBytes).digest('hex')}\n`;
  const sig = sign(null, Buffer.from(signed), privateKey).toString('base64');
  const catalog_key = { public_key: `ed25519:${rawPub.toString('base64')}`, key_id: keyId };
  const floor = { key_id: keyId, min_version: 5 };
  const envelope = { format: 'agent-bot-catalog/1', key_id: keyId, version: 7, issued_at: 1700000000, catalog: catBytes.toString('base64'), sig };
  const fetches = [];
  const fetchImpl = async () => { fetches.push(1); return { catalog_key, floor, envelope, catalog: JSON.parse(catBytes.toString()), catalogBytes: catBytes }; };
  const fm = await fakeAgentMachine(root, {
    replies: { catalog: { ok: true, state: 'accepted' }, status: { ok: true, state: 'ready', body: [{ name: 'codex', state: 'installed' }] } },
  });
  pinDaemonPub({ env, home: root });
  loadOrCreateMachineKey({ env, home: root });
  const writer = seedPrincipal(env, { label: 'w', souls: ['*'], operations: ['observe', 'approve'] });
  const scoped = seedPrincipal(env, { label: 's', souls: [AGENT_ID], operations: ['observe', 'approve'] });
  const uploads = [];
  const digestSession = { call: async (m, route, body) => { uploads.push({ m, route, body }); return { accepted: true, verified: true }; } };
  mkdirSync(path.join(root, '.config', 'agent-machine'), { recursive: true });
  const digestRaw = JSON.stringify({ state: 'ready', applied: 3 });
  writeFileSync(path.join(root, '.config', 'agent-machine', 'status-digest.json'), digestRaw);
  await withServer(env, async ({ ui, pairCookie }) => {
    const w = await pairCookie(writer.principalId);
    const s = await pairCookie(scoped.principalId);
    assert.equal((await ui('/ui/api/machine/catalog', { cookie: s })).status, 403);
    assert.equal((await ui('/ui/api/machine/catalog/deliver', { method: 'POST', body: {}, cookie: s })).status, 403);
    const view = await (await ui('/ui/api/machine/catalog', { cookie: w })).json();
    assert.equal(view.key_id, keyId);
    assert.equal(view.version, 7);
    assert.equal(view.floor_min_version, 5);
    assert.equal(view.items[0].name, 'codex');
    assert.equal(view.items[0].provider, 'formula');
    assert.equal(view.items[0].version, '1.2.3');
    assert.equal(view.items[0].installed, 'installed');
    assert.ok(view.drafts_note.includes('admin console'));
    // 5-min single-flight cache: second GET does not refetch.
    await ui('/ui/api/machine/catalog', { cookie: w });
    assert.equal(fetches.length, 1);
    // Deliver: fake agent-machine receives the exact fetched objects.
    const del = await (await ui('/ui/api/machine/catalog/deliver', { method: 'POST', body: {}, cookie: w })).json();
    assert.equal(del.ok, true);
    const sent = fm.received.at(-1);
    assert.equal(sent.verb, 'catalog');
    assert.deepEqual(sent.catalog_key, catalog_key);
    assert.deepEqual(sent.floor, floor);
    assert.deepEqual(sent.envelope, envelope);
    assert.equal(sent.soul, undefined);
    assert.equal(sent.harness, undefined);
    const view2 = await (await ui('/ui/api/machine/catalog', { cookie: w })).json();
    assert.equal(view2.delivered.outcome, 'accepted');
    // Digest upload fired after the successful catalog/apply path? catalog
    // isn't a write — deliver alone doesn't upload; an apply does (web path).
    for (const [at, v] of walk(view)) {
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} is secret-shaped`);
    }
  }, { home: root, webDeps: { fetchCatalogImpl: fetchImpl }, digestSession });
});

// fetchCatalog verification matrix (identity-side)
test('fetchCatalog: each local-verification failure gets its stable code', async () => {
  const { fetchCatalog } = await import('../identity/server-client.mjs');
  const { generateKeyPairSync, createHash: ch, sign } = await import('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const keyId = ch('sha256').update(rawPub).digest('hex').slice(0, 16);
  const catBytes = Buffer.from('{"items":[]}');
  const mkEnv = (over = {}) => ({
    format: 'agent-bot-catalog/1', key_id: keyId, version: 7, issued_at: 1700000000,
    catalog: catBytes.toString('base64'),
    sig: sign(null, Buffer.from(`agent-bot-catalog/1\n${keyId}\n${over.version ?? 7}\n1700000000\n${ch('sha256').update(Buffer.from((over.catalog ?? catBytes.toString('base64')), 'base64')).digest('hex')}\n`), privateKey).toString('base64'),
    ...over,
  });
  const session = (body) => ({ call: async () => body });
  const good = { catalog_key: { public_key: `ed25519:${rawPub.toString('base64')}`, key_id: keyId }, floor: { key_id: keyId, min_version: 5 }, envelope: mkEnv() };
  const ok = await fetchCatalog({ session: session(good), home: '/x' });
  assert.deepEqual(ok.catalog, { items: [] });
  const cases = [
    [{ catalog_key: { public_key: 'ed25519:AAAA', key_id: keyId }, floor: good.floor, envelope: null }, 'catalog-malformed'],
    [{ ...good, catalog_key: { ...good.catalog_key, key_id: 'beef'.repeat(4) } }, 'catalog-key-mismatch'],
    [{ ...good, floor: { key_id: 'other', min_version: 5 } }, 'catalog-key-mismatch'],
    [{ ...good, envelope: { ...mkEnv(), format: 'x' } }, 'catalog-key-mismatch'],
    [{ ...good, envelope: mkEnv({ version: 3 }) }, 'catalog-below-floor'],
    [{ ...good, envelope: { ...mkEnv(), sig: Buffer.alloc(64).toString('base64') } }, 'catalog-signature-invalid'],
    [{ ...good, envelope: mkEnv({ catalog: Buffer.from('{{{').toString('base64') }) }, 'catalog-malformed'],
  ];
  for (const [body, code] of cases) {
    await assert.rejects(fetchCatalog({ session: session(body), home: '/x' }), (e) => e.code === code, code);
  }
});

// --- soul writes as owner-gated proposals (#1295) ----------------------------

test('soul proposals: per-soul scope, gate stub, revision/cold-wake/remove', async () => {
  const { root, env } = scratch();
  seedSoul(env);
  seedSoul(env, { id: OTHER_ID });
  const approveA = seedPrincipal(env, { label: 'a', souls: [AGENT_ID], operations: ['observe', 'approve'] });
  const approveAll = seedPrincipal(env, { label: 'all', souls: ['*'], operations: ['observe', 'approve'] });
  const observeOnly = seedPrincipal(env, { label: 'o', souls: [AGENT_ID], operations: ['observe'] });
  // A real pending revision on AGENT_ID for the revision verbs.
  const { join } = await import('node:path');
  const { mintAgentIdentity } = await import('../agent-identity.mjs');
  const { adoptSoulPackage, proposeSoulRevision } = await import('../soul-revisions.mjs');
  const { computePackageRevision } = await import('../soul-package.mjs');
  const { stateDirectory } = await import('../state-paths.mjs');
  const stateDir = stateDirectory({ env, home: root });
  const revOpts = { env, home: root, cwd: root, stateDir, now: () => new Date('2026-10-02T12:00:00Z') };
  const packagePath = join(root, 'example.soul');
  mkdirSync(packagePath);
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test',
    preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Initial\n');
  manifest.revision = computePackageRevision(packagePath);
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  const { id: revSoul } = mintAgentIdentity({ ...revOpts, appSlug: 'test-agent', packageRevision: manifest.revision });
  adoptSoulPackage(revSoul, packagePath, { ...revOpts, reason: 'Start' });
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Proposed\n');
  const revProposal = proposeSoulRevision(revSoul, packagePath, { ...revOpts, reason: 'Improve' });
  const ownerRev = seedPrincipal(env, { label: 'r', souls: [revSoul], operations: ['observe', 'approve'] });
  await withServer(env, async ({ ui, pairCookie }) => {
    const a = await pairCookie(approveA.principalId);
    const all = await pairCookie(approveAll.principalId);
    const o = await pairCookie(observeOnly.principalId);
    const r = await pairCookie(ownerRev.principalId);
    // Scope: observe-only cannot create; A-only cannot create for B.
    assert.equal((await ui(`/ui/api/souls/${AGENT_ID}/proposals`, {
      method: 'POST', body: { verb: 'cold-wake', enabled: true }, cookie: o })).status, 403);
    assert.equal((await ui(`/ui/api/souls/${OTHER_ID}/proposals`, {
      method: 'POST', body: { verb: 'cold-wake', enabled: true }, cookie: a })).status, 403);
    // Unknown field and unknown verb are 400.
    for (const body of [{ verb: 'cold-wake', enabled: true, extra: 1 }, { verb: 'soul.delete' }, { verb: 'revision.approve', revision_id: 'x', bonus: 2 }]) {
      assert.equal((await ui(`/ui/api/souls/${AGENT_ID}/proposals`, { method: 'POST', body, cookie: a })).status, 400, JSON.stringify(body));
    }
    // Unknown/decided revision id → 400.
    assert.equal((await ui(`/ui/api/souls/${revSoul}/proposals`, {
      method: 'POST', body: { verb: 'revision.approve', revision_id: 'rev_nonexistent' }, cookie: r })).status, 400);
    // The revisions list is observe-scoped and shows the pending one.
    const revs = await (await ui(`/ui/api/souls/${revSoul}/revisions`, { cookie: r })).json();
    assert.ok(revs.proposals.some((p) => p.proposalId === revProposal.proposalId));
    // Revision approve: proposal → owner approve → revision decided through the stub.
    const { proposal: rp } = await (await ui(`/ui/api/souls/${revSoul}/proposals`, {
      method: 'POST', body: { verb: 'revision.approve', revision_id: revProposal.proposalId }, cookie: r })).json();
    assert.equal(rp.tool, 'soul.revision.approve');
    const decided = await ui(`/ui/api/approvals/${rp.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: rp.operationDigest }, cookie: r });
    assert.equal(decided.status, 200);
    await waitFor(async () => (await (await ui(`/ui/api/proposals/${rp.proposalId}`, { cookie: r })).json()).status === 'executed');
    const { listSoulProposals } = await import('../soul-revisions.mjs');
    const after = listSoulProposals(revSoul, { stateDir }).find((p) => p.proposalId === revProposal.proposalId);
    assert.notEqual(after.status, 'pending');
    // Cold-wake: approve toggles the stored setting.
    const { proposal: cp } = await (await ui(`/ui/api/souls/${AGENT_ID}/proposals`, {
      method: 'POST', body: { verb: 'cold-wake', enabled: true }, cookie: a })).json();
    await ui(`/ui/api/approvals/${cp.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: cp.operationDigest }, cookie: a });
    await waitFor(async () => (await (await ui(`/ui/api/proposals/${cp.proposalId}`, { cookie: a })).json()).status === 'executed');
    const { readColdWakeSnapshot } = await import('../cold-wake-settings.mjs');
    assert.equal(readColdWakeSnapshot(AGENT_ID, { env, home: root }).setting, true);
    // Remove: plan is in the digest-covered operation; approve archives.
    const { proposal: rm } = await (await ui(`/ui/api/souls/${AGENT_ID}/proposals`, {
      method: 'POST', body: { verb: 'remove' }, cookie: a })).json();
    assert.deepEqual(rm.operation.plan.archived, [AGENT_ID]);
    assert.match(rm.summary, /archives 1/);
    await ui(`/ui/api/approvals/${rm.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: rm.operationDigest }, cookie: a });
    await waitFor(async () => (await (await ui(`/ui/api/proposals/${rm.proposalId}`, { cookie: a })).json()).status === 'executed');
    const { listSouls } = await import('../agent-population.mjs');
    const removed = listSouls({ file: env.AGENT_BOT_POPULATION_PATH }).find((s) => s.id === AGENT_ID);
    assert.equal(removed?.status, 'retired', 'the soul is retired by the archived removal');
    // Remove whose plan drifts before approval fails with soul-remove-plan-changed.
    const { proposal: rm2 } = await (await ui(`/ui/api/souls/${OTHER_ID}/proposals`, {
      method: 'POST', body: { verb: 'remove' }, cookie: all })).json();
    seedSoul(env, { id: 'agent_88888888-8888-4888-8888-888888888888', parentId: OTHER_ID });
    await ui(`/ui/api/approvals/${rm2.proposalId}/decision`, {
      method: 'POST', body: { decision: 'approve', digest: rm2.operationDigest }, cookie: all });
    const failed = await waitFor(async () => {
      const out = await (await ui(`/ui/api/proposals/${rm2.proposalId}`, { cookie: all })).json();
      return out.status === 'failed' ? out : null;
    });
    assert.match(failed.error, /plan changed/);
    // Denied removal does nothing.
    const { proposal: rm3 } = await (await ui(`/ui/api/souls/${OTHER_ID}/proposals`, {
      method: 'POST', body: { verb: 'remove' }, cookie: all })).json();
    // The summary names each independent specialist id, not just a count.
    assert.match(rm3.summary, /agent_88888888-8888-4888-8888-888888888888/);
    await ui(`/ui/api/approvals/${rm3.proposalId}/decision`, {
      method: 'POST', body: { decision: 'deny', digest: rm3.operationDigest }, cookie: all });
    await waitFor(async () => (await (await ui(`/ui/api/proposals/${rm3.proposalId}`, { cookie: all })).json()).status === 'denied');
    assert.ok(listSouls({ file: env.AGENT_BOT_POPULATION_PATH }).some((s) => s.id === OTHER_ID));
    // Secret walk over proposal views.
    for (const [at, v] of walk([rp, rm, failed])) {
      assert.doesNotMatch(String(v), /ghs_|ghp_|BEGIN [A-Z ]*PRIVATE KEY/, at);
      assert.doesNotMatch(at, SECRET_SHAPE, `${at} is secret-shaped`);
    }
  }, { home: root });
});

test('proposalOwnerGate refuses any action string but the expected one', async () => {
  const { root, env } = scratch();
  const gate = proposalOwnerGate({ expected: 'soul cold-wake agent_x on',
    proposalId: 'prop_1', principalId: 'principal_x', digest: 'digest_x', env, home: root, now: () => new Date() });
  await assert.rejects(() => gate('soul cold-wake agent_x off', {}), /owner-gate action mismatch/);
  const ok = await gate('soul cold-wake agent_x on', {});
  assert.equal(ok.via, 'ui-proposal:prop_1');
  assert.equal(ok.method, 'consent');
});

test('index.html: unique nav targets, every view-* section once and never nested', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const navTargets = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(navTargets).size, navTargets.length, `dup nav target: ${navTargets}`);
  // Every view-* section appears exactly once, and no section contains another.
  const sections = [...html.matchAll(/<section id="(view-[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(sections).size, sections.length, `dup section: ${sections}`);
  for (const nav of navTargets) assert.ok(sections.includes(`view-${nav}`), `nav ${nav} has no section`);
  const parts = html.split(/<section id="view-[^"]+" hidden>|<\/section>/);
  let depth = 0, maxDepth = 0;
  for (const chunk of html.match(/<section id="view-[^"]+" hidden>|<\/section>/g)) {
    depth += chunk.startsWith('<section') ? 1 : -1;
    maxDepth = Math.max(maxDepth, depth);
    assert.ok(depth >= 0, 'unbalanced </section>');
  }
  assert.equal(maxDepth, 1, 'a view-* section is nested inside another');
});
