import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertLoopbackHost, createDaemonServer, runDaemon } from '../agent-daemon.mjs';
import {
  PAIRING_CODE_TTL_MS,
  UI_CSRF_HEADER,
  WEB_SESSION_TTL_MS,
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

function seedSoul(env, { id = AGENT_ID, status = 'active' } = {}) {
  const spacePath = path.join(path.dirname(env.AGENT_BOT_POPULATION_PATH), 'spaces', id);
  mkdirSync(spacePath, { recursive: true });
  return upsertSoul({
    id,
    appSlug: 'you-codex-agent',
    parentId: null,
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
async function withServer(env, run, { executor } = {}) {
  const clock = { value: new Date('2026-08-12T09:00:00.000Z') };
  const server = createDaemonServer({
    env,
    home: '/nonexistent',
    config: {},
    executor,
    now: () => clock.value,
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
