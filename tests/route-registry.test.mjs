// The daemon's route registry (route-registry.mjs, #1392; HQ plan Stage 0
// row 8). Each route source registers its routes with an auth class per
// route, and the daemon checks the class and dispatches through it.
// tests/daemon-route-auth.test.mjs keeps docs/daemon-api.md's table equal to
// the handlers' cases. This file keeps the registry equal to the same table,
// pins the bearer-free and binding-refusal sets the daemon had before the
// registry, and checks requests near the route boundaries answer as they did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { createRouteRegistry, ROUTE_AUTH } from '../route-registry.mjs';

const root = path.join(import.meta.dirname, '..');
const ID = 'agent_13921392-1392-4392-8392-139213921392';

function routeTable() {
  const doc = readFileSync(path.join(root, 'docs', 'daemon-api.md'), 'utf8');
  const section = doc.slice(doc.indexOf('# Route authorization'));
  return Object.fromEntries([...section.matchAll(/^\| `([A-Z]+ \/[^`]+)` \| ([a-z-]+) \|/gm)].map((match) => [match[1], match[2]]));
}

async function daemon(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'route-registry-'));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json') };
  upsertSoul({ id: ID, name: 'route-registry', status: 'active', spacePath: home }, { file: env.AGENT_BOT_POPULATION_PATH });
  const asked = [];
  const refuse = (action) => {
    asked.push(action);
    throw Object.assign(new Error('the owner declined'), { code: 'owner-credential-required' });
  };
  const server = createDaemonServer({ env, home, config: {},
    ownerGate: async (action) => refuse(action),
    settingGate: async (action) => refuse(action),
    revisionPrincipal: async () => refuse('revision principal') });
  server.dream = { control: () => ({ status: 'paused' }), status: () => ({}), history: () => ({}) };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const call = async (method, pathname, { bearer = true, headers = {}, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method,
      headers: { ...(bearer ? { authorization: `Bearer ${server.token}` } : {}), 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
    return { status: res.status, body: await res.json() };
  };
  const receipts = (event) => {
    let text = '';
    try { text = readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8'); } catch { /* none yet */ }
    return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter((row) => row.event === event)
      .map((row) => [row.operation, row.decision]);
  };
  return { server, call, receipts, asked };
}

const noop = async () => true;

test('a declaration needs a known auth class and only the fields it allows', () => {
  assert.deepEqual(ROUTE_AUTH, ['owner', 'owner-credential', 'bearer', 'binding', 'principal']);
  const invalid = [
    { 'GET /v0/x': {} },
    { 'GET /v0/x': { auth: 'admin' } },
    { 'GET /v0/x': { auth: 'bearer', bearer: false } },
    { 'GET /v0/x': { auth: 'binding', bearer: true } },
    { 'GET /v0/x': { auth: 'binding', bearerFree: true } },
    { 'GET /v0/x': { auth: 'bearer', receipt: 'owner-route' } },
    { 'POST /v0/x': { auth: 'owner', receipt: 'Not An Event' } },
    { 'POST /v0/x/{action}': { auth: 'owner' } },
    { 'POST /v0/x/{action}': { auth: 'owner', actions: [] } },
    { 'POST /v0/x/{action}': { auth: 'owner', actions: ['Bad'] } },
    { 'POST /v0/x': { auth: 'owner', actions: ['a'] } },
    { 'POST /v0/{action}/{action}': { auth: 'owner', actions: ['a'] } },
    { 'get /v0/x': { auth: 'bearer' } },
    { '/v0/x': { auth: 'bearer' } },
    { 'GET /v0/x?y': { auth: 'bearer' } },
    {},
  ];
  for (const routes of invalid) {
    assert.throws(() => createRouteRegistry().register({ module: 'm', routes, handle: noop }),
      (error) => error.code === 'route-registry-invalid', JSON.stringify(routes));
  }
  for (const registration of [
    { routes: { 'GET /v0/x': { auth: 'bearer' } }, handle: noop },
    { module: 'Bad Name', routes: { 'GET /v0/x': { auth: 'bearer' } }, handle: noop },
    { module: 'm', routes: { 'GET /v0/x': { auth: 'bearer' } } },
    { module: 'm', routes: { 'GET /v0/x': { auth: 'bearer' } }, handle: noop, extra: 1 },
    { module: 'm', routes: { 'GET /v0/x': { auth: 'bearer' } }, handle: noop, prefix: 'v0' },
    { module: 'm', routes: { 'GET /v0/x': { auth: 'bearer' } }, handle: noop, prefix: '/' },
  ]) {
    assert.throws(() => createRouteRegistry().register(registration), (error) => error.code === 'route-registry-invalid');
  }
});

test('a route belongs to one source, and a prefix to the source that claims it', () => {
  const routes = createRouteRegistry();
  routes.register({ module: 'a', routes: { 'GET /v0/x': { auth: 'bearer' } }, handle: noop });
  assert.throws(() => routes.register({ module: 'a', routes: { 'GET /v0/y': { auth: 'bearer' } }, handle: noop }), /already registered/);
  assert.throws(() => routes.register({ module: 'b', routes: { 'GET /v0/x': { auth: 'owner' } }, handle: noop }), /already registered by a/);
  routes.register({ module: 'p', prefix: '/v1/', routes: { 'GET /v1/x': { auth: 'principal' } }, handle: noop });
  assert.throws(() => routes.register({ module: 'c', routes: { 'GET /v1/y': { auth: 'bearer' } }, handle: noop }), /under p's prefix/);
  assert.throws(() => routes.register({ module: 'd', prefix: '/v1', routes: { 'GET /v1': { auth: 'bearer' } }, handle: noop }), /overlaps p/);
  assert.throws(() => routes.register({ module: 'e', prefix: '/v0', routes: { 'GET /v0/q': { auth: 'bearer' } }, handle: noop }), /overlaps a/);
  assert.throws(() => routes.register({ module: 'f', prefix: '/v2', routes: { 'GET /v0/q': { auth: 'bearer' } }, handle: noop }), /outside its prefix/);
  routes.close();
  assert.throws(() => routes.register({ module: 'g', routes: { 'GET /v0/g': { auth: 'bearer' } }, handle: noop }), /closed/);
  assert.deepEqual(routes.table(), { 'GET /v0/x': 'bearer', 'GET /v1/x': 'principal' });
});

test('match: literal routes first, then templates; {id} is one segment, {action} what the declaration allows', () => {
  const routes = createRouteRegistry();
  routes.register({ module: 'a', routes: {
    'POST /v0/jobs/{id}/cancel': { auth: 'bearer' },
    'POST /v0/jobs/{action}': { auth: 'owner', actions: ['start', 'run-now'], receipt: 'job-control' },
    'POST /v0/apps/{action}': { auth: 'owner', actions: /^[a-z-]+$/ },
    'GET /v0/jobs/list': { auth: 'bearer' },
    'GET /v0/jobs/{id}': { auth: 'bearer' },
    'POST /v0/bind': { auth: 'binding' },
    'POST /v0/vouch': { auth: 'binding', bearer: false },
  }, handle: noop });
  const at = (method, pathname) => routes.match(method, pathname)?.route ?? null;
  assert.equal(at('POST', '/v0/jobs/abc/cancel'), 'POST /v0/jobs/{id}/cancel');
  assert.equal(at('POST', '/v0/jobs/a/b/cancel'), null);
  assert.equal(at('POST', '/v0/jobs/run-now'), 'POST /v0/jobs/{action}');
  assert.equal(at('POST', '/v0/jobs/stop'), null);
  assert.equal(at('POST', '/v0/apps/anything-else'), 'POST /v0/apps/{action}');
  assert.equal(at('POST', '/v0/apps/Upper'), null);
  assert.equal(at('GET', '/v0/jobs/list'), 'GET /v0/jobs/list');
  assert.equal(at('GET', '/v0/jobs/other'), 'GET /v0/jobs/{id}');
  assert.equal(at('DELETE', '/v0/jobs/other'), null);
  assert.equal(routes.match('POST', '/v0/jobs/start').receipt, 'job-control');
  assert.equal(routes.match('POST', '/v0/bind').bearer, true, 'a binding route takes the bearer unless it says otherwise');
  assert.equal(routes.match('POST', '/v0/vouch').bearer, false);
});

test('dispatch: a prefix claims every path under it, a source answers only its routes, false falls through', async () => {
  const calls = [];
  const routes = createRouteRegistry();
  routes.register({ module: 'v1', prefix: '/v1/', routes: { 'GET /v1/x': { auth: 'principal' } },
    handle: async (route) => { calls.push(['v1', route]); } });
  routes.register({ module: 'apps', prefix: '/v0/apps', routes: { 'GET /v0/apps': { auth: 'bearer' } },
    handle: async (route) => { calls.push(['apps', route]); return true; } });
  routes.register({ module: 'core', routes: { 'GET /v0/a': { auth: 'bearer' }, 'GET /v0/b': { auth: 'bearer' } },
    handle: async (route) => { calls.push(['core', route]); return route === 'GET /v0/a'; } });
  const go = (method, pathname) => routes.dispatch({ method }, {}, new URL(`http://127.0.0.1${pathname}`));
  assert.equal(await go('GET', '/v1/unknown'), true);
  assert.equal(await go('GET', '/v1'), false, '/v1/ claims only paths below it');
  assert.equal(await go('POST', '/v0/apps/x/y'), true);
  assert.equal(await go('GET', '/v0/apps'), true);
  assert.equal(await go('GET', '/v0/appsx'), false, '/v0/apps claims itself and the paths below it, not a longer name');
  assert.equal(await go('GET', '/v0/a'), true);
  assert.equal(await go('GET', '/v0/b'), false, 'a source answering false has not handled it');
  assert.equal(await go('GET', '/v0/c'), false);
  assert.deepEqual(calls, [['v1', 'GET /v1/unknown'], ['apps', 'POST /v0/apps/x/y'], ['apps', 'GET /v0/apps'],
    ['core', 'GET /v0/a'], ['core', 'GET /v0/b']]);
});

test("the daemon's registry holds exactly the route authorization table in docs/daemon-api.md", async (t) => {
  const { server } = await daemon(t);
  const table = routeTable();
  assert.ok(Object.keys(table).length > 50, 'the table was found');
  assert.deepEqual(Object.fromEntries(Object.entries(server.routes.table()).sort()), Object.fromEntries(Object.entries(table).sort()));
  assert.throws(() => server.routes.register({ module: 'late', routes: { 'GET /v0/late': { auth: 'bearer' } }, handle: noop }), /closed/);
});

// The sets the daemon wrote out by hand before the registry, kept here so a
// change to either is a reviewed change to this list.
test('the bearer-free routes and the binding refusals are the ones the daemon had before the registry', async (t) => {
  const { server } = await daemon(t);
  const entries = server.routes.entries();
  assert.deepEqual(entries.filter((entry) => !entry.bearer).map((entry) => entry.route).sort(), [
    'DELETE /v0/binding', 'GET /v0/binding', 'POST /v0/asides/delivered', 'POST /v0/binding/app', 'POST /v0/credential',
    'POST /v0/events/ack', 'POST /v0/events/wait', 'POST /v0/grants/request', 'POST /v0/grants/spend', 'POST /v0/inbox/take',
    'POST /v0/keyd/grant', 'POST /v0/machine', 'POST /v0/spawn', 'POST /v0/team/start', 'POST /v0/vouch',
  ]);
  const refused = entries.filter((entry) => ['owner', 'owner-credential'].includes(entry.auth))
    .map((entry) => [entry.route, entry.receipt ?? 'owner-route']).sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(refused, [
    ['POST /v0/approvals/decide', 'owner-route'],
    ['POST /v0/identity/apps/{action}', 'owner-route'],
    ['POST /v0/sandbox', 'owner-route'],
    ['POST /v0/sandbox/override', 'owner-route'],
    ['POST /v0/soul/computer-use', 'owner-route'],
    ['POST /v0/soul/dream/{action}', 'dream-control'],
    ['POST /v0/soul/resume', 'owner-route'],
    ['POST /v0/soul/revisions/adopt', 'soul-revision'],
    ['POST /v0/soul/revisions/approve', 'soul-revision'],
    ['POST /v0/soul/revisions/edit', 'soul-revision'],
    ['POST /v0/soul/revisions/reject', 'soul-revision'],
    ['POST /v1/proposals/{id}/decision', 'owner-route'],
  ]);
});

// Requests at the edges of the route table answer exactly as they did when
// the daemon assembled its routes by hand (checked against main before the
// registry): unknown paths, unknown actions, prefixes, the bearer-free list
// and the refusal receipts.
test('requests at the edges of the route table answer as before the registry', async (t) => {
  const { call, receipts, asked } = await daemon(t);
  const unknown = { error: 'unknown route' };
  const tokenError = { error: 'missing or invalid daemon token' };
  const bindingError = { error: 'missing or invalid agent binding' };

  assert.deepEqual(await call('GET', '/v0/nope', { bearer: false }), { status: 401, body: tokenError });
  assert.deepEqual(await call('GET', '/v0/nope'), { status: 404, body: unknown });
  assert.deepEqual(await call('DELETE', '/v0/soul/dream'), { status: 404, body: unknown });
  assert.deepEqual(await call('GET', '/v1'), { status: 404, body: unknown });
  assert.deepEqual(await call('GET', '/v0/identity/appsx'), { status: 404, body: unknown });
  assert.deepEqual(await call('GET', '/v0/identity/apps/frobnicate'),
    { status: 404, body: { error: 'Unknown App route.', code: 'identity-app-not-found' } });
  assert.deepEqual(await call('DELETE', '/v0/identity/apps'),
    { status: 404, body: { error: 'Unknown App route.', code: 'identity-app-not-found' } });
  assert.deepEqual(await call('GET', '/v1/nope'), { status: 400, body: { error: 'invalid transport principal' } },
    'the /v1 handler answers every /v1/ path');

  // Bearer-free binding routes reach their binding check without a bearer;
  // bind and the notices routes still take the bearer.
  for (const route of ['POST /v0/credential', 'POST /v0/machine', 'GET /v0/binding', 'POST /v0/asides/delivered']) {
    const [method, pathname] = route.split(' ');
    assert.deepEqual(await call(method, pathname, { bearer: false }), { status: 401, body: bindingError }, route);
  }
  assert.notDeepEqual((await call('POST', '/v0/vouch', { bearer: false })).body, tokenError, 'vouch is bearer-free');
  for (const pathname of ['/v0/bind', '/v0/notices/take', '/v0/register', '/v0/soul/pause']) {
    assert.deepEqual(await call('POST', pathname, { bearer: false }), { status: 401, body: tokenError }, pathname);
  }

  // A soul binding on an owner route is refused before the bearer, and
  // receipted under the route's event; an unknown App action is still in
  // the family, an unknown dream action is not.
  const bound = { bearer: false, headers: { 'x-agent-binding': 'anything' } };
  for (const [method, pathname] of [['POST', '/v0/identity/apps/frobnicate'], ['POST', '/v1/proposals/p/decision'],
    ['POST', '/v0/soul/revisions/approve'], ['POST', '/v0/soul/dream/pause'], ['POST', '/v0/sandbox']]) {
    const res = await call(method, pathname, bound);
    assert.equal(res.status, 403, pathname);
    assert.equal(res.body.code, 'owner-credential-required', pathname);
  }
  assert.deepEqual(receipts('owner-route'), [
    ['POST /v0/identity/apps/{action}', 'owner-credential-required'],
    ['POST /v1/proposals/{id}/decision', 'owner-credential-required'],
    ['POST /v0/sandbox', 'owner-credential-required'],
  ]);
  assert.deepEqual(receipts('soul-revision'), [['approve', 'owner-credential-required']]);
  assert.deepEqual(receipts('dream-control'), [['pause', 'owner-credential-required']]);
  assert.deepEqual(await call('POST', '/v0/soul/dream/frobnicate', { headers: { 'x-agent-binding': 'anything' } }),
    { status: 404, body: unknown });
  assert.deepEqual(await call('POST', '/v0/soul/dream/frobnicate', bound), { status: 401, body: tokenError });
  assert.deepEqual(asked, [], 'nothing here reached the owner');
});
