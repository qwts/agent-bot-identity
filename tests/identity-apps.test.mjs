import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentityAppJobs, identityAppOperation, identityAppsCommand, listIdentityApps } from '../identity-apps.mjs';
import { appStoreTarget, cacheAppDoctorRows, readManagedAppCredential } from '../identity-app-store.mjs';
import { credentialStores, resolveAppCredential } from '../soul-credentials.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { resolveAgentSlug } from '../resolve-agent.mjs';
import { main as doctorMain } from '../doctor.mjs';
import { assignAgentApp, mintAgentIdentity, readAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { populationFile, upsertSoul } from '../agent-population.mjs';
import { configuredAppSlugs, buildReadinessReport, renderReadinessJson, readinessCheck } from '../readiness.mjs';
import { inspectAppCredentials } from '../credential-reconciler.mjs';
import { loadConfig, slugForHarness } from '../config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ID = 'agent_44444444-4444-4444-8444-444444444444';
const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const KEY = pem(), NEW_KEY = pem();
const noSecrets = (value) => assert.ok(!/-----BEGIN|gh[psuor]_|github_pat_|eyJhbGci/.test(JSON.stringify(value)), 'output must be secret-free');
function fixture(t, { gate = true, platform = 'linux' } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'identity-apps-'));
  const env = { HOME: home, PATH: process.env.PATH, AGENT_BOT_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_SECURITY_BIN: path.join(ROOT, 'tests/fixtures/fake-security.mjs'), FAKE_KEYCHAIN: path.join(home, 'keychain.json') };
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({ features: { 'github-identity': gate } }));
  const keyFile = path.join(home, 'incoming.pem'); writeFileSync(keyFile, KEY, { mode: 0o600 });
  const newKeyFile = path.join(home, 'new.pem'); writeFileSync(newKeyFile, NEW_KEY, { mode: 0o600 });
  const options = { env, home, cwd: home, platform, gate: async () => ({ method: 'test' }), stores: credentialStores({ env }) };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { env, home, keyFile, newKeyFile, options };
}
async function github(t, f) {
  const calls = [];
  let rejectMint = false, rejectApp = false, conversions = 0;
  const rows = [{ id: 7, account: { login: 'fixture-org' }, repository_selection: 'selected' }];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if ((rejectMint && req.url.includes('access_tokens')) || (rejectApp && req.url === '/app')) {
      res.writeHead(401); res.end(JSON.stringify({ message: 'ghs_fixture_should_never_escape' })); return;
    }
    if (req.url.startsWith('/app-manifests/')) {
      conversions++; res.end(JSON.stringify({ id: 123, slug: 'fixture-app', pem: KEY, webhook_secret: 'fixture-webhook-value' }));
    } else if (req.url === '/app') res.end(JSON.stringify({ id: 123, slug: 'fixture-app' }));
    else if (req.url.startsWith('/app/installations?')) res.end(JSON.stringify(rows));
    else if (req.url === '/app/installations/7/access_tokens') res.end(JSON.stringify({ token: 'ghs_fake_installation', expires_at: '2030-01-01T00:00:00Z' }));
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = loadConfig(f.options); config.apiBase = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  return { calls, rejectMint: () => { rejectMint = true; }, rejectApp: () => { rejectApp = true; }, conversions: () => conversions };
}
const connect = (f, extra = {}) => identityAppOperation('connect', { id: '123', keyFile: f.keyFile, ...extra }, f.options);
async function page(flow) {
  const response = await fetch(flow.localUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  const value = html.match(/name="manifest" value="([^"]*)"/)[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
  return { html, manifest: JSON.parse(value), state: new URL(flow.localUrl).searchParams.get('state') };
}
async function callback(manifest, state) {
  return fetch(manifest.redirect_url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: 'fixture-code', state }) });
}

test('gate off lists nothing without touching store or network; mutations fail closed', async (t) => {
  const f = fixture(t, { gate: false });
  assert.deepEqual(listIdentityApps(f.options), { schemaVersion: 1, apps: [] });
  await assert.rejects(connect(f), { code: 'identity-app-disabled' });
});
for (const platform of ['linux', 'darwin']) test(`connect uses ${platform === 'darwin' ? 'fake Keychain' : 'private file'} store and list is offline`, async (t) => {
  const f = fixture(t, { platform }), api = await github(t, f);
  const result = await connect(f); noSecrets(result);
  assert.deepEqual(result, { id: '123', slug: 'fixture-app', installUrl: 'https://github.com/apps/fixture-app/installations/new' });
  const before = api.calls.length;
  const listed = listIdentityApps(f.options); noSecrets(listed);
  assert.deepEqual(listed.apps[0], { slug: 'fixture-app', botLogin: 'fixture-app[bot]', issuerPresent: true, keyPresent: true,
    installations: [{ id: 7, account: 'fixture-org', repositorySelection: 'selected' }], harnesses: [], souls: [], liveMint: { status: 'unknown' } });
  assert.equal(api.calls.length, before);
  const resolved = resolveAppCredential('fixture-app', f.options);
  assert.equal(resolved.source, 'managed-app');
  assert.ok(resolved.privateKeyPem === KEY, 'stored key resolves without exposing its value');
  assert.equal(existsSync(path.join(f.home, '.config', 'fixture-app')), false);
  if (platform === 'linux') {
    const target = path.join(appStoreTarget('fixture-app', f.options).soulDir, '.soul-state/credentials/github-app-fixture-app.json');
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(target)).mode & 0o777, 0o700);
  }
  await assert.rejects(connect(f), { code: 'identity-app-exists' });
});
test('owner gate refuses before key read or API access and never reflects its errors', async (t) => {
  const f = fixture(t), api = await github(t, f);
  f.options.gate = async () => { throw new Error('ghs_fake_principal_failure'); };
  await assert.rejects(connect(f), (error) => { noSecrets(error.message); return error.code === 'identity-app-owner-required'; });
  assert.equal(api.calls.length, 0);
});
test('manifest has expected permissions, one state-bound callback, stored webhook and secret-free result', async (t) => {
  const f = fixture(t), api = await github(t, f);
  const flow = await identityAppOperation('create', { manifest: true, org: 'fixture-org', name: 'Fixture App' }, f.options);
  t.after(flow.cancel);
  const { manifest, html, state } = await page(flow);
  assert.match(html, /organizations\/fixture-org\/settings\/apps\/new\?state=/);
  assert.equal(new URL(manifest.redirect_url).hostname, '127.0.0.1');
  assert.deepEqual(manifest.default_permissions, { contents: 'write', pull_requests: 'write', issues: 'write' });
  assert.deepEqual(manifest.hook_attributes, { url: 'https://example.invalid/disabled', active: false });
  assert.equal(manifest.request_oauth_on_install, false);
  assert.equal((await callback(manifest, 'wrong-state')).status, 403);
  assert.equal(api.conversions(), 0);
  assert.equal((await callback(manifest, state)).status, 200);
  const result = await flow.completion; noSecrets(result);
  assert.deepEqual(Object.keys(result), ['id', 'slug', 'installUrl']);
  assert.equal(api.conversions(), 1);
  assert.ok(Boolean(readManagedAppCredential('fixture-app', f.options).webhookSecret));
  await assert.rejects(fetch(manifest.redirect_url));
});
test('manifest accepts GitHub GET callback and ignores a second callback while conversion is pending', async (t) => {
  const f = fixture(t); await github(t, f);
  let release;
  const wait = new Promise((yes) => { release = yes; });
  const flow = await identityAppOperation('create', { manifest: true }, { ...f.options, fetchImpl: async (...args) => { await wait; return fetch(...args); } });
  t.after(flow.cancel);
  const { manifest, state } = await page(flow);
  const url = `${manifest.redirect_url}?${new URLSearchParams({ state, code: 'fixture-code' })}`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 409);
  release(); await flow.completion;
});
test('manifest timeout and cancellation close the listener and provide stable errors', async (t) => {
  const f = fixture(t);
  const flow = await identityAppOperation('create', { manifest: true }, { ...f.options, timeoutMs: 20 });
  await assert.rejects(flow.completion, { code: 'identity-app-timeout' });
  await assert.rejects(fetch(flow.localUrl));
  const cancelled = await identityAppOperation('create', { manifest: true }, f.options);
  cancelled.cancel(); await assert.rejects(cancelled.completion, { code: 'identity-app-cancelled' });
});
test('rotation verifies a live mint before swapping and reports only retired fingerprint', async (t) => {
  const f = fixture(t), api = await github(t, f); await connect(f);
  const oldFingerprint = loadConfig(f.options).identityApps['fixture-app'].keyFingerprint;
  await assert.rejects(identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.keyFile }, f.options), { code: 'identity-app-key-unchanged' });
  const result = await identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options);
  noSecrets(result); assert.equal(result.retired, oldFingerprint);
  assert.ok(api.calls.includes('POST /app/installations/7/access_tokens'));
  assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === NEW_KEY, 'replacement key was stored');
});
test('failed rotation leaves old key intact, hides upstream errors', async (t) => {
  const f = fixture(t), api = await github(t, f); await connect(f); api.rejectMint();
  await assert.rejects(identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options), (error) => { noSecrets(error.message); return error.code === 'identity-app-github'; });
  assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === KEY, 'old key remains usable');
});
test('pass-cli uses explicit provider and always removes staging directory', async (t) => {
  const f = fixture(t); await github(t, f);
  let destination;
  f.options.passProvider = { restore({ slug, privateKeyDestination }) { assert.equal(slug, 'selected-item'); destination = privateKeyDestination; writeFileSync(destination, KEY); } };
  noSecrets(await identityAppOperation('connect', { id: '123', passCli: 'selected-item' }, f.options));
  assert.equal(existsSync(path.dirname(destination)), false);
});
test('harness and soul assignment update shared metadata, census and doctor roster', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  await identityAppOperation('assign', { slug: 'fixture-app', harness: 'codex' }, f.options);
  assert.equal(slugForHarness('codex', loadConfig(f.options)), 'fixture-app');
  mintAgentIdentity({ ...f.options, stateDir: stateDirectory(f.options), idFactory: () => ID, harness: 'codex', useGithub: false });
  upsertSoul({ id: ID, name: 'fixture-soul', status: 'active', appSlug: null, spacePath: path.join(f.home, 'space') }, { file: populationFile(f.options) });
  await identityAppOperation('assign', { slug: 'fixture-app', soul: ID }, f.options);
  assert.equal(readAgentIdentity(ID, { stateDir: stateDirectory(f.options) }).github.appSlug, 'fixture-app');
  const row = listIdentityApps(f.options).apps[0];
  assert.deepEqual(row.harnesses, ['codex']); assert.deepEqual(row.souls, [ID]);
  assert.ok(configuredAppSlugs(loadConfig(f.options)).includes('fixture-app'));
  assert.equal(resolveAgentSlug({ ...f.options, config: loadConfig(f.options), env: { ...f.env, AGENT_BOT_ID: ID }, git: () => '', detect: false }), 'fixture-app');
});
test('doctor checks managed stores and caches only live status; list never mints', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const results = await inspectAppCredentials({ ...f.options, config: loadConfig(f.options), slugs: ['fixture-app'], verify: async () => ({ token: 'ghs_fake_only', installation_id: 7, expires_at: '2030-01-01T00:00:00Z' }) });
  noSecrets(results); assert.equal(results[0].local.status, 'ready'); assert.equal(results[0].live.status, 'ready');
  const report = buildReadinessReport({ command: 'doctor', scope: 'machine', apps: results.map((row) => ({ slug: row.slug, credential: readinessCheck({ id: 'credential.local', status: row.local.status, message: 'local ready' }), live_mint: readinessCheck({ id: 'credential.live_mint', status: row.live.status, message: 'mint ready' }) })) });
  noSecrets(renderReadinessJson(report));
  let rendered = '';
  await doctorMain(['--json'], { collect: async () => report, cache: (value) => cacheAppDoctorRows(value, f.options), output: { write: (value) => { rendered += value; } } });
  assert.equal(JSON.parse(rendered).machine.apps.length, 1); noSecrets(rendered);
  cacheAppDoctorRows({ machine: { apps: [{ slug: 'fixture-app', live_mint: { status: 'ready', evidence: { token: 'ghs_fake_only' } } }] } }, f.options);
  const row = listIdentityApps(f.options).apps[0]; assert.equal(row.liveMint.status, 'ready'); noSecrets(row);
  cacheAppDoctorRows({ machine: { apps: [{ slug: 'fixture-app', live_mint: { status: 'skipped' } }] } }, f.options);
  assert.equal(listIdentityApps(f.options).apps[0].liveMint.status, 'ready');
});
test('CLI routes list, validates arguments and emits safe JSON errors', async (t) => {
  const f = fixture(t, { gate: false });
  const child = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'identity', 'apps', 'list', '--json'], { env: f.env, cwd: f.home, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout).apps, []);
  let output = '';
  await identityAppsCommand(['apps', 'list', '--json'], { ...f.options, write: (value) => { output += value; } }); noSecrets(output);
  await assert.rejects(identityAppsCommand(['app', 'connect', '--bad', 'ghs_fake_only'], f.options), { code: 'identity-app-invalid' });
});
test('jobs poll only secret-free state and forget on shutdown', async (t) => {
  const f = fixture(t); await github(t, f);
  const jobs = createIdentityAppJobs(f.options); t.after(() => jobs.close());
  const start = await jobs.start({ manifest: true }); noSecrets(start);
  const { manifest, state } = await page({ localUrl: start.localUrl });
  await callback(manifest, state);
  for (let i = 0; jobs.get(start.jobId).status === 'pending' && i < 100; i++) await new Promise((yes) => setTimeout(yes, 5));
  const result = jobs.get(start.jobId); assert.equal(result.status, 'complete'); noSecrets(result);
  jobs.close(); assert.throws(() => jobs.get(start.jobId), { code: 'identity-app-job-not-found' });
});
test('daemon App routes use population bearer auth and separate owner authorization', async (t) => {
  const f = fixture(t); await github(t, f);
  let approvals = 0;
  const server = createDaemonServer({ env: f.env, home: f.home, token: 'fixture-daemon-auth', settingGate: async () => { approvals++; throw new Error('ghs_fake_only'); } });
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/v0/identity/apps`)).status, 401);
  for (const route of ['create', 'connect', 'rotate-key', 'assign']) assert.equal((await fetch(`${base}/v0/identity/apps/${route}`, { method: 'POST', body: '{}' })).status, 401);
  const headers = { authorization: 'Bearer fixture-daemon-auth', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/v0/identity/apps`, { headers })).status, 200);
  const denied = await fetch(`${base}/v0/identity/apps/connect`, { method: 'POST', headers, body: JSON.stringify({ id: '123', keyFile: f.keyFile }) });
  assert.equal(denied.status, 403); noSecrets(await denied.json()); assert.equal(approvals, 1);
  const malformed = await fetch(`${base}/v0/identity/apps/create`, { method: 'POST', headers, body: '{ghs_fake_only' });
  assert.equal(malformed.status, 400); noSecrets(await malformed.json());
  assert.equal((await fetch(`${base}/v0/identity/apps/jobs/aaaaaaaa`, { headers })).status, 404);
});

test('legacy key rotates into App store without writing a new key under config', async (t) => {
  const f = fixture(t); await github(t, f);
  const dir = path.join(f.home, '.config', 'fixture-app'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app-id'), '123'); writeFileSync(path.join(dir, 'private-key.pem'), KEY);
  const result = await identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options);
  noSecrets(result);
  assert.ok(readFileSync(path.join(dir, 'private-key.pem'), 'utf8') === KEY, 'legacy file is unchanged');
  assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === NEW_KEY, 'managed store has replacement');
});
test('host spoofing, callback body limit and cross-origin POST do not spend the nonce', async (t) => {
  const f = fixture(t); await github(t, f);
  const flow = await identityAppOperation('create', { manifest: true }, f.options); t.after(flow.cancel);
  const { manifest, state } = await page(flow);
  // Node fetch preserves Host on supported versions; http.request tests the
  // wire header explicitly so browser fetch normalization cannot hide it.
  const { request } = await import('node:http');
  const status = await new Promise((yes, no) => {
    const req = request(flow.localUrl, { headers: { host: 'attacker.invalid' } }, (res) => { res.resume(); yes(res.statusCode); }); req.on('error', no); req.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(manifest.redirect_url, { method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, code: 'fixture-code' }) })).status, 403);
  assert.equal((await fetch(manifest.redirect_url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await callback(manifest, state)).status, 200); await flow.completion;
});
test('conversion completing after timeout cannot persist credentials', async (t) => {
  const f = fixture(t); await github(t, f);
  let release;
  const delayed = new Promise((yes) => { release = yes; });
  const flow = await identityAppOperation('create', { manifest: true }, { ...f.options, timeoutMs: 100, fetchImpl: async (...args) => { await delayed; return fetch(...args); } });
  const { manifest, state } = await page(flow); await callback(manifest, state);
  await assert.rejects(flow.completion, { code: 'identity-app-timeout' });
  release(); await new Promise((yes) => setTimeout(yes, 25));
  assert.equal(loadConfig(f.options).identityApps, undefined);
});
test('App ID mismatch and API failure never publish credentials', async (t) => {
  const f = fixture(t), api = await github(t, f);
  await assert.rejects(connect(f, { id: '456' }), { code: 'identity-app-mismatch' });
  api.rejectApp(); await assert.rejects(connect(f), (error) => { noSecrets(error.message); return error.code === 'identity-app-github'; });
  assert.equal(loadConfig(f.options).identityApps, undefined);
});
test('concurrent rotations detect the stale fingerprint instead of overwriting a newer key', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const results = await Promise.allSettled([1, 2].map(() => identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'identity-app-conflict');
});
test('soul identity assignment rolls back when census synchronization fails', (t) => {
  const f = fixture(t);
  mintAgentIdentity({ stateDir: stateDirectory(f.options), idFactory: () => ID, harness: 'codex', useGithub: false });
  assert.throws(() => assignAgentApp(ID, 'fixture-app', { stateDir: stateDirectory(f.options), afterWrite: () => { throw new Error('fixture failure'); } }));
  assert.equal(readAgentIdentity(ID, { stateDir: stateDirectory(f.options) }).github, undefined);
});
test('keyd declarations are never replaced or shadowed by managed readable keys', async (t) => {
  const f = fixture(t); await github(t, f);
  const dir = path.join(f.home, 'fixture.soul'); mkdirSync(path.join(dir, '.soul-state'), { recursive: true });
  writeFileSync(path.join(dir, '.soul-state', 'agent-id'), ID);
  writeFileSync(path.join(dir, 'soul.json'), JSON.stringify({ credentials: { github: { app: 'fixture-app', store: 'keyd' } } }));
  upsertSoul({ id: ID, name: 'fixture-soul', status: 'active', appSlug: 'fixture-app', soulDir: dir, spacePath: path.join(f.home, 'space') }, { file: populationFile(f.options) });
  await assert.rejects(connect(f), { code: 'identity-app-keyd-held' });
  const resolved = resolveAppCredential('fixture-app', { ...f.options, agentId: ID });
  assert.equal(resolved.source, 'keyd'); assert.equal(resolved.privateKeyPem, null);
  assert.equal(loadConfig(f.options).identityApps, undefined);
});
test('daemon connect, assign, rotate and manifest jobs return only public results', async (t) => {
  const f = fixture(t); await github(t, f);
  const server = createDaemonServer({ env: f.env, home: f.home, token: 'fixture-daemon-auth', settingGate: f.options.gate });
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/v0/identity/apps`;
  const headers = { authorization: 'Bearer fixture-daemon-auth', 'content-type': 'application/json' };
  const post = async (action, body) => {
    const res = await fetch(`${base}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const result = await res.json(); noSecrets(result); return { res, result };
  };
  assert.equal((await post('connect', { id: '123', keyFile: f.keyFile })).res.status, 200);
  assert.equal((await post('assign', { slug: 'fixture-app', harness: 'codex' })).res.status, 200);
  assert.equal((await post('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile })).res.status, 200);
  const { res, result } = await post('create', { manifest: true }); assert.equal(res.status, 202);
  assert.equal((await fetch(`${base}/jobs/${result.jobId}`)).status, 401);
  const pending = await (await fetch(`${base}/jobs/${result.jobId}`, { headers })).json(); noSecrets(pending); assert.equal(pending.status, 'pending');
  const { manifest, state } = await page({ localUrl: result.localUrl }); await callback(manifest, state);
  let job;
  for (let i = 0; i < 100; i++) {
    job = await (await fetch(`${base}/jobs/${result.jobId}`, { headers })).json();
    if (job.status !== 'pending') break;
    await new Promise((yes) => setTimeout(yes, 5));
  }
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'identity-app-exists'); noSecrets(job);
});
test('connect repairs a missing managed credential without allowing silent rotation', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const target = path.join(appStoreTarget('fixture-app', f.options).soulDir, '.soul-state/credentials/github-app-fixture-app.json');
  rmSync(target);
  const missing = listIdentityApps(f.options).apps[0];
  assert.equal(missing.keyPresent, false);
  noSecrets(await connect(f));
  assert.equal(listIdentityApps(f.options).apps[0].keyPresent, true);
  await assert.rejects(connect(f, { keyFile: f.newKeyFile }), { code: 'identity-app-exists' });
  assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === KEY, 'repair preserved the selected key');
});
