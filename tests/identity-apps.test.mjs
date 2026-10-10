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
import { identityAppSouls } from '../identity-app-souls.mjs';
import { appStoreTarget, cacheAppDoctorRows, readManagedAppCredential } from '../identity-app-store.mjs';
import { credentialStores, resolveAppCredential } from '../soul-credentials.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import { resolveAgentSlug } from '../resolve-agent.mjs';
import { main as doctorMain } from '../doctor.mjs';
import { assignAgentApp, mintAgentIdentity, readAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { populationFile, upsertSoul } from '../agent-population.mjs';
import { configuredAppSlugs, buildReadinessReport, renderReadinessJson, readinessCheck } from '../readiness.mjs';
import { inspectAppCredentials, inspectLocalAppCredential } from '../credential-reconciler.mjs';
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
  // A fake keyd (#110) that is not there: no test here reaches a socket.
  const keyd = { availability: async () => ({ available: false, reason: 'agent-bot-keyd is not installed' }), importApp: async () => assert.fail('keyd is not there'), removeApp: async () => assert.fail('keyd is not there') };
  const options = { env, home, cwd: home, platform, gate: async () => ({ method: 'test' }), stores: credentialStores({ env }), souls: identityAppSouls, keyd };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { env, home, keyFile, newKeyFile, options };
}
async function github(t, f) {
  const calls = [];
  let rejectMint = false, rejectApp = false, conversions = 0, reportedSlug = 'fixture-app', reportedId = 123;
  const rows = [{ id: 7, account: { login: 'fixture-org' }, repository_selection: 'selected', permissions: { pull_requests: 'write', contents: 'write', metadata: 'read' } }];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if ((rejectMint && req.url.includes('access_tokens')) || (rejectApp && req.url === '/app')) {
      res.writeHead(401); res.end(JSON.stringify({ message: 'ghs_fixture_should_never_escape' })); return;
    }
    if (req.url.startsWith('/app-manifests/')) {
      conversions++; res.end(JSON.stringify({ id: 123, slug: 'fixture-app', pem: KEY, webhook_secret: 'fixture-webhook-value' }));
    } else if (req.url === '/app') res.end(JSON.stringify({ id: reportedId, slug: reportedSlug }));
    else if (req.url === '/users/fixture-app%5Bbot%5D') res.end(JSON.stringify({ id: 456, avatar_url: 'https://avatars.githubusercontent.com/u/456?v=4' }));
    else if (req.url.startsWith('/app/installations?')) res.end(JSON.stringify(rows));
    else if (req.url === '/app/installations/7/access_tokens') res.end(JSON.stringify({ token: 'ghs_fake_installation', expires_at: '2030-01-01T00:00:00Z' }));
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = loadConfig(f.options); config.apiBase = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  return { calls, rejectMint: () => { rejectMint = true; }, rejectApp: () => { rejectApp = true; }, conversions: () => conversions,
    appIdentity: (slug, id) => { reportedSlug = slug; reportedId = id; } };
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

test('without the census port, an App operation that needs a soul is refused, not answered as soulless', async (t) => {
  const f = fixture(t);
  const { souls, ...unwired } = f.options;
  assert.equal(souls, identityAppSouls);
  assert.throws(() => listIdentityApps(unwired), { code: 'identity-app-census' });
});

test('gate off lists nothing without touching store or network; mutations fail closed', async (t) => {
  const f = fixture(t, { gate: false });
  assert.deepEqual(listIdentityApps(f.options), { schemaVersion: 1, addons: { 'github-identity': false }, apps: [] });
  await assert.rejects(connect(f), { code: 'identity-app-disabled' });
});
for (const platform of ['linux', 'darwin']) test(`connect uses ${platform === 'darwin' ? 'fake Keychain' : 'private file'} store and list is offline`, async (t) => {
  const f = fixture(t, { platform }), api = await github(t, f);
  const result = await connect(f); noSecrets(result);
  const kind = platform === 'darwin' ? 'keychain' : 'file';
  assert.deepEqual(result, { id: '123', slug: 'fixture-app', installUrl: 'https://github.com/apps/fixture-app/installations/new',
    store: kind, storeReason: `agent-bot-keyd is not installed; the key is kept in the ${kind} store instead.` });
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].botUid, '456');
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].botAvatarUrl, 'https://avatars.githubusercontent.com/u/456?v=4');
  const before = api.calls.length;
  const listed = listIdentityApps(f.options); noSecrets(listed);
  const { keyFingerprint, keyUpdatedAt } = loadConfig(f.options).identityApps['fixture-app'];
  assert.match(keyFingerprint, /^SHA256:[A-Za-z0-9+/=]+$/); assert.match(keyUpdatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.deepEqual(listed.apps[0], { slug: 'fixture-app', botLogin: 'fixture-app[bot]', issuerPresent: true, keyPresent: true,
    key: { fingerprint: keyFingerprint, updatedAt: keyUpdatedAt },
    installations: [{ id: 7, account: 'fixture-org', repositorySelection: 'selected', permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' } }], harnesses: [], souls: [], liveMint: { status: 'unknown' } });
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
  assert.deepEqual(Object.keys(result), ['id', 'slug', 'installUrl', 'store', 'storeReason']);
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
  const row = listIdentityApps(f.options).apps[0]; noSecrets(row);
  assert.notEqual(row.key.fingerprint, oldFingerprint, 'the list reports the replacement key');
  assert.equal(row.key.fingerprint, loadConfig(f.options).identityApps['fixture-app'].keyFingerprint);
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
test('list keeps each installation grant, prints it, and tells a cache from before apart (#213)', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  let output = '';
  await identityAppsCommand(['apps', 'list'], { ...f.options, write: (value) => { output += value; } }); noSecrets(output);
  assert.equal(output, 'fixture-app (fixture-app[bot]) issuer:true key:true mint:unknown installed:fixture-org(selected; contents:write,metadata:read,pull_requests:write)\n');
  // A cache row written before the grant was kept lists permissions: null and prints no grant.
  const config = loadConfig(f.options);
  config.identityApps['fixture-app'].installations = [{ id: 7, account: 'fixture-org', repositorySelection: 'selected' }];
  writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  assert.deepEqual(listIdentityApps(f.options).apps[0].installations, [{ id: 7, account: 'fixture-org', repositorySelection: 'selected', permissions: null }]);
  output = '';
  await identityAppsCommand(['apps', 'list'], { ...f.options, write: (value) => { output += value; } });
  assert.equal(output, 'fixture-app (fixture-app[bot]) issuer:true key:true mint:unknown installed:fixture-org(selected)\n');
  // A grant GitHub spells wrongly is refused like any other invalid installation metadata.
  config.identityApps['fixture-app'].installations = [{ id: 7, account: 'fixture-org', repositorySelection: 'selected', permissions: { contents: 'owner' } }];
  writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  assert.throws(() => listIdentityApps(f.options), { code: 'identity-app-github' });
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

test('connect upgrades metadata-only records without discarding public App fields', async (t) => {
  const f = fixture(t); await github(t, f);
  const config = loadConfig(f.options);
  config.identityApps = { 'fixture-app': { id: '123', botUid: '456', botAvatarUrl: 'https://avatars.githubusercontent.com/u/456?v=4' } };
  writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  await connect(f);
  const record = loadConfig(f.options).identityApps['fixture-app'];
  assert.equal(record.store, 'file'); assert.equal(record.botUid, '456');
  assert.equal(existsSync(path.join(f.home, '.config', 'fixture-app')), false);
});

test('manifest retains the one-time key when the public bot profile is temporarily unavailable', async (t) => {
  const f = fixture(t); await github(t, f);
  const flow = await identityAppOperation('create', { manifest: true }, { ...f.options,
    fetchImpl: (url, options) => url.includes('/users/') ? Promise.resolve({ ok: false, status: 503 }) : fetch(url, options) });
  t.after(flow.cancel);
  const { manifest, state } = await page(flow); await callback(manifest, state);
  const result = await flow.completion;
  assert.equal(result.metadataPending, true); noSecrets(result);
  assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === KEY);
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].id, '123');
});

// --- remove and the add-on switch (GeniusBar#67) -----------------------------

const keychainItems = (f) => { try { return Object.keys(JSON.parse(readFileSync(f.env.FAKE_KEYCHAIN, 'utf8'))); } catch { return []; } };
for (const platform of ['linux', 'darwin']) test(`remove forgets a ${platform === 'darwin' ? 'Keychain' : 'file'}-stored App and names only what it removed`, async (t) => {
  const f = fixture(t, { platform }); await github(t, f); await connect(f);
  cacheAppDoctorRows({ machine: { apps: [{ slug: 'fixture-app', live_mint: { status: 'ready' } }] } }, f.options);
  const log = path.join(f.home, 'security.log'); f.env.FAKE_KEYCHAIN_LOG = log;
  const result = await identityAppOperation('remove', { slug: 'fixture-app' }, f.options);
  noSecrets(result);
  const name = platform === 'darwin' ? 'agent-bot.app.fixture-app/github-app/fixture-app'
    : path.join(appStoreTarget('fixture-app', f.options).soulDir, '.soul-state/credentials/github-app-fixture-app.json');
  assert.deepEqual(result, { slug: 'fixture-app', id: '123', removed: { storeItem: { store: platform === 'darwin' ? 'keychain' : 'file', name, existed: true }, configRecord: true } });
  assert.equal(loadConfig(f.options).identityApps, undefined);
  assert.equal(loadConfig(f.options).features['github-identity'], true, 'other config is kept');
  assert.equal(readManagedAppCredential('fixture-app', f.options), null);
  assert.equal(existsSync(appStoreTarget('fixture-app', f.options).soulDir), false, 'empty App store directories are removed');
  assert.deepEqual(keychainItems(f), []);
  const doctor = JSON.parse(readFileSync(path.join(stateDirectory(f.options), 'identity-apps', 'doctor.json'), 'utf8'));
  assert.equal(doctor['fixture-app'], undefined);
  assert.deepEqual(listIdentityApps(f.options).apps, []);
  if (platform === 'darwin') assert.ok(!/-----BEGIN|privateKeyPem/.test(readFileSync(log, 'utf8')), 'no key material on security argv');
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, f.options), { code: 'identity-app-not-found', statusCode: 404 });
});
test('remove refuses while a harness or live soul points at the App, naming them; retired souls do not block', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  await identityAppOperation('assign', { slug: 'fixture-app', harness: 'codex' }, f.options);
  mintAgentIdentity({ ...f.options, stateDir: stateDirectory(f.options), idFactory: () => ID, harness: 'codex', useGithub: false });
  upsertSoul({ id: ID, name: 'fixture-soul', status: 'active', appSlug: null, spacePath: path.join(f.home, 'space') }, { file: populationFile(f.options) });
  await identityAppOperation('assign', { slug: 'fixture-app', soul: ID }, f.options);
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, f.options), (error) => {
    assert.equal(error.code, 'identity-app-assigned');
    assert.match(error.message, /harness codex/); assert.match(error.message, new RegExp(`soul ${ID}`));
    return true;
  });
  assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === KEY, 'refusal leaves the key');
  // Point the harness elsewhere: the soul still blocks.
  const config = loadConfig(f.options); config.apps.codex = 'other-app'; writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, f.options), (error) => !/harness/.test(error.message) && error.code === 'identity-app-assigned');
  // A prefix-pattern mapping counts like an explicit override.
  upsertSoul({ id: ID, name: 'fixture-soul', status: 'retired', appSlug: 'fixture-app', spacePath: path.join(f.home, 'space') }, { file: populationFile(f.options) });
  const prefixed = loadConfig(f.options); prefixed.prefix = 'fixture'; prefixed.apps = { claude: 'fixture-app' }; writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(prefixed));
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, f.options), (error) => /harness claude/.test(error.message) && !/soul/.test(error.message));
  delete prefixed.apps; writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(prefixed));
  noSecrets(await identityAppOperation('remove', { slug: 'fixture-app' }, f.options));
});
test('remove keeps the key when the config write fails and removes metadata-only records', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const failing = { ...f.options, stores: { ...f.options.stores, file: { ...f.options.stores.file, delete: () => { throw new Error('ghs_fake_only'); } } } };
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, failing), (error) => { noSecrets(error.message); return error.code === 'identity-app-store'; });
  assert.ok(loadConfig(f.options).identityApps['fixture-app'], 'record kept when the store refuses');
  // A config that cannot be written restores the deleted item: the stub
  // deletes for real, then turns the config path into a directory so the
  // atomic rename fails.
  const saved = readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8');
  const blocked = { ...f.options, stores: { ...f.options.stores, file: { ...f.options.stores.file, delete: (target) => {
    f.options.stores.file.delete(target); rmSync(f.env.AGENT_BOT_CONFIG); mkdirSync(f.env.AGENT_BOT_CONFIG);
  } } } };
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, blocked));
  rmSync(f.env.AGENT_BOT_CONFIG, { recursive: true }); writeFileSync(f.env.AGENT_BOT_CONFIG, saved);
  assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === KEY, 'rollback restored the key');
  const config = loadConfig(f.options);
  config.identityApps['meta-only'] = { id: '999', botUid: '5' }; writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  assert.deepEqual(await identityAppOperation('remove', { slug: '999' }, f.options), { slug: 'meta-only', id: '999', removed: { storeItem: null, configRecord: true } }, 'an App ID names its record');
  assert.ok(loadConfig(f.options).identityApps['fixture-app'], 'other Apps are untouched');
});
test('remove and addon are owner gated, refused from a soul, and validated before the gate', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const labels = [];
  const gated = { ...f.options, gate: async (label) => { labels.push(label); throw new Error('ghs_fake_only'); } };
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, gated), { code: 'identity-app-owner-required' });
  await assert.rejects(identityAppOperation('addon', { name: 'github-identity', enabled: false }, gated), { code: 'identity-app-owner-required' });
  assert.deepEqual(labels, ['identity app remove fixture-app', 'identity addon github-identity off']);
  await assert.rejects(identityAppOperation('remove', { slug: 'Bad Slug' }, gated), { code: 'identity-app-invalid' });
  await assert.rejects(identityAppOperation('addon', { name: 'persona-accounts', enabled: true }, gated), { code: 'identity-app-invalid' });
  await assert.rejects(identityAppOperation('addon', { name: 'github-identity', enabled: 'yes' }, gated), { code: 'identity-app-invalid' });
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app', force: true }, gated), { code: 'identity-app-invalid' });
  assert.equal(labels.length, 2, 'invalid requests never reach the owner');
  // The real gate: a soul's Agent ID refuses before any prompt.
  const soul = { ...f.options, gate: undefined, env: { ...f.env, AGENT_BOT_ID: ID } };
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, soul), { code: 'identity-app-owner-required' });
  await assert.rejects(identityAppOperation('addon', { name: 'github-identity', enabled: false }, soul), { code: 'identity-app-owner-required' });
  assert.ok(loadConfig(f.options).identityApps['fixture-app']); assert.equal(loadConfig(f.options).features['github-identity'], true);
});
test('addon switches github-identity on and off, even while off, and list reports it', async (t) => {
  const f = fixture(t, { gate: false });
  assert.deepEqual(await identityAppOperation('addon', { name: 'github-identity', enabled: true }, f.options), { addon: 'github-identity', enabled: true, changed: true });
  assert.equal(loadConfig(f.options).features['github-identity'], true);
  assert.deepEqual(listIdentityApps(f.options).addons, { 'github-identity': true });
  assert.deepEqual(await identityAppOperation('addon', { name: 'github-identity', enabled: true }, f.options), { addon: 'github-identity', enabled: true, changed: false });
  let output = '';
  const result = await identityAppsCommand(['addon', 'github-identity', 'off', '--json'], { ...f.options, write: (value) => { output += value; } });
  assert.deepEqual(result, { addon: 'github-identity', enabled: false, changed: true });
  assert.deepEqual(JSON.parse(output), result);
  assert.equal(loadConfig(f.options).features['github-identity'], false);
  assert.deepEqual(listIdentityApps(f.options), { schemaVersion: 1, addons: { 'github-identity': false }, apps: [] });
  for (const argv of [['addon', 'github-identity'], ['addon', 'github-identity', 'maybe'], ['addon', 'github-identity', 'on', 'off'], ['addon', 'persona-accounts', 'on'], ['addon', 'github-identity', 'on', '--id', '1']]) {
    await assert.rejects(identityAppsCommand(argv, f.options), { code: 'identity-app-invalid' });
  }
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, f.options), { code: 'identity-app-disabled' });
});
test('CLI remove and addon route through agent-bot and print safe JSON', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  let output = '';
  await identityAppsCommand(['app', 'remove', 'fixture-app', '--json'], { ...f.options, write: (value) => { output += value; } });
  noSecrets(output); assert.equal(JSON.parse(output).slug, 'fixture-app');
  await assert.rejects(identityAppsCommand(['app', 'remove', '--json'], f.options), { code: 'identity-app-invalid' });
  await assert.rejects(identityAppsCommand(['app', 'remove', 'a', 'b'], f.options), { code: 'identity-app-invalid' });
  // Through the real entry point a soul caller is refused with a JSON error.
  const child = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'identity', 'addon', 'github-identity', 'off', '--json'], { env: { ...f.env, AGENT_BOT_ID: ID }, cwd: f.home, encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).error.code, 'identity-app-owner-required');
  assert.equal(loadConfig(f.options).features['github-identity'], true);
});
test('daemon remove and addon routes need the bearer and the owner, and return public results', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  let allow = false, approvals = 0;
  const server = createDaemonServer({ env: f.env, home: f.home, token: 'fixture-daemon-auth', settingGate: async () => { approvals++; if (!allow) throw new Error('ghs_fake_only'); return { method: 'test' }; } });
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/v0/identity/apps`;
  const headers = { authorization: 'Bearer fixture-daemon-auth', 'content-type': 'application/json' };
  const post = async (action, body, h = headers) => {
    const res = await fetch(`${base}/${action}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    const result = await res.json(); noSecrets(result); return { status: res.status, result };
  };
  for (const route of ['remove', 'addon']) assert.equal((await post(route, {}, { 'content-type': 'application/json' })).status, 401);
  assert.equal((await post('remove', { slug: 'fixture-app' })).status, 403);
  assert.equal((await post('addon', { name: 'github-identity', enabled: false })).status, 403);
  assert.equal(approvals, 2);
  allow = true;
  const listed = await (await fetch(base, { headers })).json();
  assert.deepEqual(listed.addons, { 'github-identity': true });
  const removed = await post('remove', { slug: 'fixture-app' });
  assert.equal(removed.status, 200); assert.equal(removed.result.slug, 'fixture-app'); assert.equal(removed.result.removed.configRecord, true);
  assert.equal((await post('remove', { slug: 'fixture-app' })).status, 404);
  const off = await post('addon', { name: 'github-identity', enabled: false });
  assert.equal(off.status, 200); assert.deepEqual(off.result, { addon: 'github-identity', enabled: false, changed: true });
  const on = await post('addon', { name: 'github-identity', enabled: true });
  assert.deepEqual(on.result, { addon: 'github-identity', enabled: true, changed: true });
  assert.equal((await post('addon', { name: 'github-identity' })).status, 400);
});

// App-level keys in agent-bot-keyd (#110 slice 2). `keyd` is a fake of the
// owner channel: availability (status, pin, owner/app-status) and
// owner/app-import. No test reaches a real keyd or daemon.
function fakeKeyd({ available = true, held = false, pins = false, reason = 'agent-bot-keyd is not running', importError = null, removeError = null } = {}) {
  const imports = [], removals = [];
  return {
    imports, removals,
    // Holds what it imported, or `held` before any import.
    availability: async (app) => { assert.equal(app, 'fixture-app'); return available ? { available: true, held: held || imports.length > removals.length, ...(pins && imports.length === 0 ? { pins: true } : {}) } : { available: false, reason }; },
    importApp: async (items) => { if (importError) throw importError; const pinned = pins && imports.length === 0; imports.push(items); return { stored: items.length, pinned }; },
    removeApp: async (app) => { if (removeError) throw removeError; removals.push(app); return { removed: true }; },
  };
}
const fileItem = (f) => path.join(appStoreTarget('fixture-app', f.options).soulDir, '.soul-state/credentials/github-app-fixture-app.json');
for (const platform of ['linux', 'darwin']) test(`explicit App key migration from ${platform === 'darwin' ? 'Keychain' : 'file'} preserves source, metadata and a separate webhook secret`, async (t) => {
  const f = fixture(t, { platform }), api = await github(t, f);
  await connect(f);
  const record = loadConfig(f.options).identityApps['fixture-app'];
  const sourceStore = f.options.stores[record.store];
  sourceStore.write(appStoreTarget('fixture-app', f.options), { appId: '123', privateKeyPem: KEY, webhookSecret: 'source-webhook-value' });
  assert.deepEqual(readManagedAppCredential('fixture-app', f.options), { appId: '123', privateKeyPem: KEY, webhookSecret: 'source-webhook-value' });
  const webhookStore = f.options.stores[platform === 'darwin' ? 'keychain' : 'file'];
  if (platform === 'darwin') webhookStore.writeSecret(webhookTarget(f), 'source-webhook-value');
  const keyd = f.options.keyd = fakeKeyd();
  const gateLabels = [];
  f.options.gate = async (label) => { gateLabels.push(label); return { method: 'test' }; };
  let output = '';
  const result = await identityAppsCommand(['app', 'migrate-key', 'fixture-app', '--to', 'keyd', '--json'], { ...f.options, write: (value) => { output += value; } });
  noSecrets(result); noSecrets(output);
  assert.equal(output, `${JSON.stringify(result)}\n`);
  assert.deepEqual(gateLabels, ['identity app migrate-key fixture-app']);
  assert.equal(result.status, 'migrated');
  assert.equal(result.from, record.store);
  assert.equal(result.store, 'keyd');
  assert.equal(result.webhookSecretKept, true);
  assert.equal(api.calls.filter((call) => call === 'GET /app').length, 2, 'connect and migration each verified the App');
  assert.equal(keyd.imports.length, 1);
  assert.deepEqual(Object.keys(keyd.imports[0][0]), ['app', 'appId', 'privateKeyPem']);
  assert.equal(keyd.imports[0][0].webhookSecret, undefined, 'webhook secret never enters the keyd key item');
  assert.equal(keyd.imports[0][0].privateKeyPem, KEY);
  assert.deepEqual(sourceStore.read(appStoreTarget('fixture-app', f.options)), { appId: '123', privateKeyPem: KEY, webhookSecret: 'source-webhook-value' });
  assert.equal(webhookStore.readSecret(webhookTarget(f)), 'source-webhook-value');
  if (platform === 'linux') {
    assert.equal(existsSync(webhookFile(f)), true);
    assert.doesNotMatch(readFileSync(webhookFile(f), 'utf8'), /BEGIN RSA PRIVATE KEY/);
  }
  const after = loadConfig(f.options).identityApps['fixture-app'];
  assert.deepEqual(after, { ...record, store: 'keyd' }, 'migration changes only the store declaration');
  assert.deepEqual(await identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options),
    { id: '123', slug: 'fixture-app', store: 'keyd', status: 'already-migrated' });
  assert.equal(keyd.imports.length, 1, 'idempotent invocation never replaces the held key');
});
test('App migration dry-run and unavailable/unpinned keyd leave source and config untouched', async (t) => {
  const f = fixture(t), api = await github(t, f);
  await connect(f);
  const before = readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8');
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  const keyd = f.options.keyd = fakeKeyd();
  const callsBefore = api.calls.length;
  const planned = await identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd', dryRun: true }, f.options);
  assert.deepEqual(planned, { id: '123', slug: 'fixture-app', from: 'file', to: 'keyd', status: 'would-migrate' });
  assert.equal(api.calls.length, callsBefore, 'dry run does not call GitHub');
  assert.equal(keyd.imports.length, 0);
  assert.equal(readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8'), before);
  assert.deepEqual(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)), source);

  f.options.keyd = fakeKeyd({ available: false, reason: "agent-bot-keyd has not pinned this daemon's key yet" });
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), (error) =>
    error.code === 'identity-app-keyd-unavailable' && /has not pinned this daemon/.test(error.message));
  assert.equal(readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8'), before);
  assert.deepEqual(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)), source);
});
test('App migration refuses conflicting existing webhook secret without replacing either copy', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const source = f.options.stores.file;
  source.write(appStoreTarget('fixture-app', f.options), { appId: '123', privateKeyPem: KEY, webhookSecret: 'source-webhook-value' });
  source.writeSecret(webhookTarget(f), 'existing-webhook-value');
  const keyd = f.options.keyd = fakeKeyd();
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-conflict' });
  assert.equal(keyd.imports.length, 0);
  assert.equal(source.readSecret(webhookTarget(f)), 'existing-webhook-value');
  assert.equal(source.read(appStoreTarget('fixture-app', f.options)).webhookSecret, 'source-webhook-value');
});
test('App migration never overwrites a pre-existing unrecorded keyd key or imports a mismatched GitHub identity/fingerprint', async (t) => {
  const f = fixture(t), api = await github(t, f);
  await connect(f);
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  const orphan = f.options.keyd = fakeKeyd({ held: true });
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-keyd-held' });
  assert.equal(orphan.imports.length, 0);
  f.options.keyd = fakeKeyd();
  api.appIdentity('another-app', 123);
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-mismatch' });
  assert.equal(f.options.keyd.imports.length, 0);
  api.appIdentity('fixture-app', 123);
  const config = loadConfig(f.options); config.identityApps['fixture-app'].keyFingerprint = 'SHA256:different';
  writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-conflict' });
  assert.equal(f.options.keyd.imports.length, 0);
  assert.deepEqual(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)), source);
});
test('App migration reports config conflict after import as explicit partial state and preserves source', async (t) => {
  const f = fixture(t), api = await github(t, f);
  await connect(f);
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  const keyd = fakeKeyd();
  f.options.keyd = { ...keyd, importApp: async (items) => {
    const config = loadConfig(f.options); config.identityApps['fixture-app'].keyFingerprint = 'SHA256:external-change';
    writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
    return keyd.importApp(items);
  } };
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), (error) =>
    error.code === 'identity-app-migration-partial' && /accepted App fixture-app's key/.test(error.message) && !/BEGIN|fixture-key/.test(error.message));
  assert.equal(keyd.imports.length, 1);
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'file');
  assert.equal(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)).privateKeyPem, source.privateKeyPem);
  assert.ok(api.calls.includes('GET /app'));
});
test('App migration rechecks add-on eligibility after GitHub verification and before importing', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  const originalFetch = fetch;
  f.options.fetchImpl = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith('/app')) {
      const config = loadConfig(f.options); config.features['github-identity'] = false;
      writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
    }
    return response;
  };
  const keyd = f.options.keyd = fakeKeyd();
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-disabled' });
  assert.equal(keyd.imports.length, 0);
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'file');
  assert.deepEqual(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)), source);
});
test('App migration holds the per-App operation lock while keyd consent is pending', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  let release, entered;
  const waiting = new Promise((yes) => { entered = yes; });
  const consent = new Promise((yes) => { release = yes; });
  const keyd = fakeKeyd();
  f.options.keyd = { ...keyd, importApp: async (items) => { entered(); await consent; return keyd.importApp(items); } };
  const first = identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options);
  await waiting;
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-busy' });
  release(); assert.equal((await first).status, 'migrated');
  assert.equal(keyd.imports.length, 1);
});
test('App keyd import refusal is redacted, fails closed, and never downgrades or changes the source', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const before = readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8');
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  f.options.keyd = fakeKeyd({ importError: new Error(`refused ${KEY}`) });
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), (error) => {
    noSecrets(error.message); return error.code === 'identity-app-keyd-refused';
  });
  assert.equal(readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8'), before);
  assert.deepEqual(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)), source);
});
test('App migration treats a lost keyd import acknowledgement as partial when keyd now holds the key', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  const keyd = fakeKeyd();
  f.options.keyd = { ...keyd, importApp: async (items) => { keyd.imports.push(items); throw new Error('response lost'); } };
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-migration-partial' });
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'file');
  assert.equal(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)).privateKeyPem, source.privateKeyPem);
});
test('App migration probes a generic keyd error before calling it a clean refusal', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  const keyd = fakeKeyd();
  f.options.keyd = { ...keyd, importApp: async (items) => {
    keyd.imports.push(items);
    throw Object.assign(new Error('readback receipt unavailable'), { rpcCode: -32000 });
  } };
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), (error) =>
    error.code === 'identity-app-migration-partial' && /may hold App fixture-app's key/.test(error.message) && !/readback receipt/.test(error.message));
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'file');
  assert.equal(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)).privateKeyPem, source.privateKeyPem);
});
test('App migration detects a webhook secret changed during keyd consent and preserves both current copies', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const source = f.options.stores.file;
  source.write(appStoreTarget('fixture-app', f.options), { appId: '123', privateKeyPem: KEY, webhookSecret: 'source-webhook-value' });
  source.writeSecret(webhookTarget(f), 'source-webhook-value');
  const keyd = fakeKeyd();
  f.options.keyd = { ...keyd, importApp: async (items) => {
    source.writeSecret(webhookTarget(f), 'changed-during-consent');
    return keyd.importApp(items);
  } };
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), (error) =>
    error.code === 'identity-app-migration-partial' && /accepted App fixture-app's key/.test(error.message) && !/changed-during-consent|source-webhook-value/.test(error.message));
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'file');
  assert.equal(source.read(appStoreTarget('fixture-app', f.options)).webhookSecret, 'source-webhook-value');
  assert.equal(source.readSecret(webhookTarget(f)), 'changed-during-consent');
});
test('App migration rechecks eligibility when keyd consent returns before writing config', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const source = f.options.stores.file.read(appStoreTarget('fixture-app', f.options));
  const keyd = fakeKeyd();
  f.options.keyd = { ...keyd, importApp: async (items) => {
    const config = loadConfig(f.options); config.features['github-identity'] = false;
    writeFileSync(f.env.AGENT_BOT_CONFIG, JSON.stringify(config));
    return keyd.importApp(items);
  } };
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-migration-partial' });
  assert.equal(loadConfig(f.options).features['github-identity'], false);
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'file');
  assert.equal(f.options.stores.file.read(appStoreTarget('fixture-app', f.options)).privateKeyPem, source.privateKeyPem);
});
test('App migration config-write failure rolls back only the copied webhook item and reports keyd partial state', async (t) => {
  const f = fixture(t); await github(t, f);
  await connect(f);
  const savedConfig = readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8');
  const recordBefore = loadConfig(f.options).identityApps['fixture-app'];
  f.options.stores.file.write(appStoreTarget('fixture-app', f.options), { appId: '123', privateKeyPem: KEY, webhookSecret: 'source-webhook-value' });
  const file = f.options.stores.file;
  f.options.stores = { ...f.options.stores, file: { ...file, writeSecret: (target, value) => {
    file.writeSecret(target, value); rmSync(f.env.AGENT_BOT_CONFIG); mkdirSync(f.env.AGENT_BOT_CONFIG);
  } } };
  const keyd = f.options.keyd = fakeKeyd();
  await assert.rejects(identityAppOperation('migrate-key', { slug: 'fixture-app', to: 'keyd' }, f.options), { code: 'identity-app-migration-partial' });
  rmSync(f.env.AGENT_BOT_CONFIG, { recursive: true }); writeFileSync(f.env.AGENT_BOT_CONFIG, savedConfig);
  assert.equal(keyd.imports.length, 1);
  assert.equal(file.readSecret(webhookTarget(f)), null, 'the newly copied webhook item was rolled back');
  assert.deepEqual(file.read(appStoreTarget('fixture-app', f.options)), { appId: '123', privateKeyPem: KEY, webhookSecret: 'source-webhook-value' });
});
test('with keyd verified, connect keeps the key in keyd, records store keyd, and mints with an App-scope grant', async (t) => {
  const f = fixture(t); await github(t, f);
  const keyd = f.options.keyd = fakeKeyd();
  const result = await connect(f); noSecrets(result);
  assert.deepEqual(result, { id: '123', slug: 'fixture-app', installUrl: 'https://github.com/apps/fixture-app/installations/new', store: 'keyd' });
  assert.equal(keyd.imports.length, 1);
  assert.deepEqual(Object.keys(keyd.imports[0][0]), ['app', 'appId', 'privateKeyPem']);
  assert.deepEqual([keyd.imports[0][0].app, keyd.imports[0][0].appId], ['fixture-app', '123']);
  assert.ok(keyd.imports[0][0].privateKeyPem === KEY, 'keyd was given the connected key');
  const record = loadConfig(f.options).identityApps['fixture-app'];
  assert.equal(record.store, 'keyd'); assert.match(record.keyFingerprint, /^SHA256:/);
  assert.equal(existsSync(fileItem(f)), false, 'no readable copy is written');
  const resolved = resolveAppCredential('fixture-app', { ...f.options, agentId: ID });
  assert.deepEqual(resolved, { slug: 'fixture-app', appId: '123', privateKeyPem: null, source: 'keyd', keyScope: 'app', agentId: ID });
  const row = listIdentityApps(f.options).apps[0];
  assert.deepEqual([row.issuerPresent, row.keyPresent], [true, true]);
  assert.equal(inspectLocalAppCredential({ slug: 'fixture-app', home: f.home, env: f.env, config: loadConfig(f.options), stores: f.options.stores }).status, 'ready',
    'doctor does not call a keyd-held App unreadable');
  await assert.rejects(connect(f), { code: 'identity-app-exists' });
  assert.equal(keyd.imports.length, 1, 'a second connect never writes over the keyd key');
});
test('a keyd with no daemon key pinned takes the first App key and pins the daemon key in the same owner prompt', async (t) => {
  const f = fixture(t); await github(t, f);
  const keyd = f.options.keyd = fakeKeyd({ pins: true });
  const result = await connect(f); noSecrets(result);
  assert.equal(result.store, 'keyd');
  assert.equal(result.daemonKeyPinned, true, 'the result says the import pinned this daemon');
  assert.equal(Object.hasOwn(result, 'storeReason'), false, 'no fallback');
  assert.equal(keyd.imports.length, 1);
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'keyd');
  assert.equal(existsSync(fileItem(f)), false, 'no readable copy is written');

  // Declining keyd's prompt (which names the pin) stores nothing and pins nothing.
  const declined = fixture(t); await github(t, declined);
  declined.options.keyd = fakeKeyd({ pins: true, importError: Object.assign(new Error('the owner declined'), { code: 'keyd-refused', rpcCode: -32000 }) });
  await assert.rejects(connect(declined), { code: 'identity-app-keyd-refused' });
  assert.equal(loadConfig(declined.options).identityApps?.['fixture-app']?.store, undefined);
  assert.equal(existsSync(fileItem(declined)), false);
});
test('with keyd not verified, connect uses the file or Keychain store and says why', async (t) => {
  for (const reason of ['agent-bot-keyd is not running', 'agent-bot-keyd is not installed']) {
    const f = fixture(t); await github(t, f);
    const keyd = f.options.keyd = fakeKeyd({ available: false, reason });
    const result = await connect(f);
    assert.equal(result.store, 'file');
    assert.equal(result.storeReason, `${reason}; the key is kept in the file store instead.`);
    assert.equal(keyd.imports.length, 0);
    assert.ok(readManagedAppCredential('fixture-app', f.options).privateKeyPem === KEY);
  }
});
test('an older keyd (-32601) falls back with its reason; any other keyd refusal stores nothing', async (t) => {
  const older = fixture(t); await github(t, older);
  older.options.keyd = fakeKeyd({ importError: Object.assign(new Error('method not found'), { code: 'keyd-refused', rpcCode: -32601 }) });
  const result = await connect(older);
  assert.equal(result.store, 'file');
  assert.match(result.storeReason, /predates App-level keys \(#110\); the key is kept in the file store instead/);
  assert.equal(loadConfig(older.options).identityApps['fixture-app'].store, 'file');

  const declined = fixture(t); await github(t, declined);
  declined.options.keyd = fakeKeyd({ importError: Object.assign(new Error('the owner declined'), { code: 'keyd-refused', rpcCode: -32000 }) });
  await assert.rejects(connect(declined), (error) => error.code === 'identity-app-keyd-refused' && /owner declined\); nothing was changed/.test(error.message));
  assert.equal(loadConfig(declined.options).identityApps?.['fixture-app']?.store, undefined);
  assert.equal(existsSync(fileItem(declined)), false, 'a keyd refusal is never a silent downgrade');
});
test('existing App keys are untouched: a file-store App rotates in its store, and a key keyd holds unrecorded is never replaced', async (t) => {
  const f = fixture(t); await github(t, f); await connect(f);
  const keyd = f.options.keyd = fakeKeyd();
  const rotated = await identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options);
  assert.equal(rotated.store, 'file');
  assert.match(rotated.storeReason, /already kept in the file store; existing App keys are not moved to agent-bot-keyd/);
  assert.equal(keyd.imports.length, 0);
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'file');

  const fresh = fixture(t); await github(t, fresh);
  const holding = fresh.options.keyd = fakeKeyd({ held: true });
  await assert.rejects(connect(fresh), (error) => error.code === 'identity-app-exists' && /not replaced; nothing was stored/.test(error.message));
  assert.equal(holding.imports.length, 0);
  assert.equal(existsSync(fileItem(fresh)), false);
});
test('a keyd-held App rotates in keyd, and fails rather than leaving keyd when it cannot', async (t) => {
  const f = fixture(t); const api = await github(t, f);
  const keyd = f.options.keyd = fakeKeyd(); await connect(f);
  const oldFingerprint = loadConfig(f.options).identityApps['fixture-app'].keyFingerprint;
  await assert.rejects(identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.keyFile }, f.options), { code: 'identity-app-key-unchanged' });
  f.options.keyd = fakeKeyd({ available: false });
  await assert.rejects(identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options), { code: 'identity-app-keyd-unavailable' });
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].keyFingerprint, oldFingerprint);
  f.options.keyd = keyd;
  const result = await identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options); noSecrets(result);
  assert.equal(result.store, 'keyd'); assert.equal(result.retired, oldFingerprint);
  assert.ok(keyd.imports[1][0].privateKeyPem === NEW_KEY);
  assert.ok(api.calls.includes('POST /app/installations/7/access_tokens'), 'the new key minted before keyd was asked');
  assert.notEqual(loadConfig(f.options).identityApps['fixture-app'].keyFingerprint, oldFingerprint);
});
test('create keeps the one-time key in keyd when verified, and never loses it to a keyd refusal', async (t) => {
  const run = async (keyd) => {
    const f = fixture(t); await github(t, f);
    f.options.keyd = keyd;
    const flow = await identityAppOperation('create', { manifest: true }, f.options);
    t.after(flow.cancel);
    const { manifest, state } = await page(flow);
    assert.equal((await callback(manifest, state)).status, 200);
    return { f, result: await flow.completion };
  };
  const kept = await run(fakeKeyd()); noSecrets(kept.result);
  assert.equal(kept.result.store, 'keyd'); assert.equal(kept.result.webhookSecretKept, true);
  const refused = await run(fakeKeyd({ importError: Object.assign(new Error('the owner declined'), { rpcCode: -32000 }) }));
  assert.equal(refused.result.store, 'file');
  assert.match(refused.result.storeReason, /owner declined\); the key is kept in the file store instead/);
  assert.ok(readManagedAppCredential('fixture-app', refused.f.options).privateKeyPem === KEY);
});
test('one operation per App at a time: a second refuses while the first waits for keyd, and the next one runs', async (t) => {
  const f = fixture(t); await github(t, f);
  let release, entered;
  const inside = new Promise((yes) => { entered = yes; });
  const gate = new Promise((yes) => { release = yes; });
  const keyd = fakeKeyd();
  f.options.keyd = { ...keyd, importApp: async (items) => { entered(); await gate; return keyd.importApp(items); } };
  const first = connect(f);
  await inside;
  await assert.rejects(connect(f), { code: 'identity-app-busy' });
  release(); assert.equal((await first).store, 'keyd');
  f.options.keyd = keyd;
  const rotated = identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options);
  assert.equal((await rotated).store, 'keyd');
  assert.equal(keyd.imports.length, 2);
});
test('readers that cannot mint through keyd fail closed on a keyd-held App', async (t) => {
  const f = fixture(t); await github(t, f);
  f.options.keyd = fakeKeyd(); await connect(f);
  assert.throws(() => readManagedAppCredential('fixture-app', f.options), { code: 'managed-app-keyd-held' });
  const { ensurePrivateKey } = await import('../ensure-private-key.mjs');
  assert.throws(() => ensurePrivateKey({ slug: 'fixture-app', home: f.home, env: f.env, stores: f.options.stores }), (error) => error.code === 'keyd-held');
});

// #110 slice 3: a keyd-held App's webhook secret, and removing keyd-held and
// orphaned App keys. Still fakes only.
async function createInto(t, keyd, platform = 'linux') {
  const f = fixture(t, { platform }); await github(t, f);
  f.options.keyd = keyd;
  const flow = await identityAppOperation('create', { manifest: true }, f.options);
  t.after(flow.cancel);
  const { manifest, state } = await page(flow);
  assert.equal((await callback(manifest, state)).status, 200);
  return { f, result: await flow.completion };
}
const webhookFile = (f) => path.join(appStoreTarget('fixture-app', f.options).soulDir, '.soul-state/credentials/github-app-fixture-app.webhook.json');
const webhookTarget = (f) => ({ ...appStoreTarget('fixture-app', f.options), name: 'webhook' });
for (const platform of ['linux', 'darwin']) test(`create into keyd keeps the webhook secret in its own ${platform === 'darwin' ? 'Keychain item' : 'file'}, and no key item is written`, async (t) => {
  const keyd = fakeKeyd();
  const { f, result } = await createInto(t, keyd, platform); noSecrets(result);
  assert.deepEqual([result.store, result.webhookSecretKept], ['keyd', true]);
  assert.equal(keyd.imports.length, 1);
  const kind = platform === 'darwin' ? 'keychain' : 'file';
  const store = f.options.stores[kind];
  assert.equal(store.readSecret(webhookTarget(f)), 'fixture-webhook-value');
  assert.equal(store.read(appStoreTarget('fixture-app', f.options)), null, 'no key item: keyd holds the key');
  if (platform === 'darwin') {
    const services = JSON.stringify(JSON.parse(readFileSync(f.env.FAKE_KEYCHAIN, 'utf8')));
    assert.match(services, /agent-bot\.app\.fixture-app\.webhook/);
  } else assert.equal(existsSync(webhookFile(f)), true);
  assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'keyd');
  assert.throws(() => readManagedAppCredential('fixture-app', f.options), { code: 'managed-app-keyd-held' });
  // Rotating in keyd leaves the webhook secret where it is.
  await identityAppOperation('rotate-key', { slug: 'fixture-app', keyFile: f.newKeyFile }, f.options);
  assert.equal(store.readSecret(webhookTarget(f)), 'fixture-webhook-value');
});
test('remove sends owner/app-remove for a keyd-held App, then drops its webhook secret and record', async (t) => {
  const keyd = fakeKeyd();
  const { f } = await createInto(t, keyd);
  const result = await identityAppOperation('remove', { slug: 'fixture-app' }, f.options); noSecrets(result);
  assert.deepEqual(result, { slug: 'fixture-app', id: '123', removed: { storeItem: null, configRecord: true, keydKey: true, webhookSecretItem: { store: 'file', name: webhookFile(f), existed: true } } });
  assert.deepEqual(keyd.removals, ['fixture-app']);
  assert.equal(existsSync(webhookFile(f)), false);
  assert.equal(existsSync(appStoreTarget('fixture-app', f.options).soulDir), false, 'empty App store directories are removed');
  assert.equal(loadConfig(f.options).identityApps, undefined);
  // A key keyd no longer holds leaves only the record to drop.
  const gone = fixture(t); await github(t, gone);
  const lost = gone.options.keyd = fakeKeyd(); await connect(gone);
  lost.removals.push('fixture-app');
  const dropped = await identityAppOperation('remove', { slug: 'fixture-app' }, gone.options);
  assert.equal(dropped.removed.keydKey, false); assert.equal(dropped.removed.configRecord, true);
  assert.equal(dropped.removed.webhookSecretItem.existed, false);
  assert.equal(lost.removals.length, 1, 'keyd was not asked to remove a key it does not hold');
});
test('removing a keyd-held App removes nothing when keyd is unavailable, older than #110 or refuses', async (t) => {
  const f = fixture(t); await github(t, f);
  const keyd = f.options.keyd = fakeKeyd(); await connect(f);
  const remove = () => identityAppOperation('remove', { slug: 'fixture-app' }, f.options);
  for (const [fake, code] of [
    [fakeKeyd({ available: false }), 'identity-app-keyd-unavailable'],
    [{ ...keyd, removeApp: async () => { throw Object.assign(new Error('method not found'), { rpcCode: -32601 }); } }, 'identity-app-keyd-unavailable'],
    [{ ...keyd, removeApp: async () => { throw Object.assign(new Error('the owner declined'), { rpcCode: -32000 }); } }, 'identity-app-keyd-refused'],
  ]) {
    f.options.keyd = fake;
    await assert.rejects(remove(), (error) => error.code === code && /nothing was removed/.test(error.message));
    assert.equal(loadConfig(f.options).identityApps['fixture-app'].store, 'keyd');
  }
  assert.equal(keyd.removals.length, 0);
});
test('an orphaned keyd key is removed only when named, after the owner gate and keyd\'s prompt, and the result says so', async (t) => {
  const f = fixture(t);
  const keyd = f.options.keyd = fakeKeyd({ held: true });
  const denied = { ...f.options, gate: async () => { throw new Error('declined'); } };
  await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, denied), { code: 'identity-app-owner-required' });
  assert.equal(keyd.removals.length, 0, 'no owner, no removal');
  const result = await identityAppOperation('remove', { slug: 'fixture-app' }, f.options);
  assert.deepEqual(result, { slug: 'fixture-app', id: null, removed: { storeItem: null, configRecord: false, keydKey: true, orphan: true } });
  assert.deepEqual(keyd.removals, ['fixture-app']);
  for (const fake of [fakeKeyd(), fakeKeyd({ available: false })]) {
    f.options.keyd = fake;
    await assert.rejects(identityAppOperation('remove', { slug: 'fixture-app' }, f.options), { code: 'identity-app-not-found' });
    assert.equal(fake.removals.length, 0);
  }
});
test('assign refuses while a removal waits for keyd, so the removed key leaves no identity behind', async (t) => {
  const keyd = fakeKeyd();
  const { f } = await createInto(t, keyd);
  let release, entered;
  const inside = new Promise((yes) => { entered = yes; });
  const gate = new Promise((yes) => { release = yes; });
  f.options.keyd = { ...keyd, removeApp: async (app) => { entered(); await gate; return keyd.removeApp(app); } };
  const removal = identityAppOperation('remove', { slug: 'fixture-app' }, f.options);
  await inside;
  await assert.rejects(identityAppOperation('assign', { slug: 'fixture-app', harness: 'codex' }, f.options), { code: 'identity-app-busy' });
  release(); assert.equal((await removal).removed.keydKey, true);
  assert.equal(loadConfig(f.options).apps?.codex, undefined);
  await assert.rejects(identityAppOperation('assign', { slug: 'fixture-app', harness: 'codex' }, f.options), { code: 'identity-app-not-found' });
});
test('a keyd create whose config write fails puts the webhook-secret item back as it was', async (t) => {
  const f = fixture(t); await github(t, f);
  const saved = readFileSync(f.env.AGENT_BOT_CONFIG, 'utf8');
  const file = f.options.stores.file;
  // The stub writes for real, then turns the config path into a directory so
  // the atomic rename fails.
  const blocked = { ...f.options, stores: { ...f.options.stores, file: { ...file, writeSecret: (target, value) => {
    file.writeSecret(target, value); rmSync(f.env.AGENT_BOT_CONFIG); mkdirSync(f.env.AGENT_BOT_CONFIG);
  } } } };
  const create = async () => {
    const flow = await identityAppOperation('create', { manifest: true }, { ...blocked, keyd: fakeKeyd() });
    t.after(flow.cancel);
    const { manifest, state } = await page(flow);
    await callback(manifest, state);
    await assert.rejects(flow.completion);
    rmSync(f.env.AGENT_BOT_CONFIG, { recursive: true }); writeFileSync(f.env.AGENT_BOT_CONFIG, saved);
  };
  await create();
  assert.equal(file.readSecret(webhookTarget(f)), null, 'a new item is deleted');
  file.writeSecret(webhookTarget(f), 'older-webhook-value');
  await create();
  assert.equal(file.readSecret(webhookTarget(f)), 'older-webhook-value', 'an older item is restored');
});
test('remove names the Windows .dpapi webhook file', async (t) => {
  const keyd = fakeKeyd();
  const { f } = await createInto(t, keyd);
  const result = await identityAppOperation('remove', { slug: 'fixture-app' }, { ...f.options, platform: 'win32' });
  assert.match(result.removed.webhookSecretItem.name, /github-app-fixture-app\.webhook\.dpapi$/);
});
