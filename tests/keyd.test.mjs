import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureAgentIdentity, retireAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { mintBindToken } from '../agent-binding.mjs';
import { auditFile } from '../agent-principals.mjs';
import { registerSoulDir, upsertSoul } from '../agent-population.mjs';
import { createDaemonServer } from '../agent-daemon.mjs';
import {
  KEYD_GRANT_META, appKeydAvailability, daemonGrantPublicKey, importAppIntoKeyd, importIntoKeyd, keydMcpServerEntry, keydPaths, keydPolicyRules,
  keydRequest, keydStatus, mintViaKeyd, readKeydRecord, removeAppFromKeyd, signKeydGrant,
} from '../keyd-client.mjs';
import { installKeyd, uninstallKeyd } from '../keyd-supervisor.mjs';
import { appConfig, mint } from '../mint-token.mjs';
import { credentialStores, resolveAppCredential } from '../soul-credentials.mjs';
import { migrateCredentialsCommand } from '../soul-credential-migration.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, soulCredentialsDeclaration } from '../soul-package.mjs';
import { acpExecutorFor, withReachRules } from '../wake-plane.mjs';
import { vouchStateDir } from '../vouch.mjs';

const AGENT = 'agent_55555555-5555-4555-8555-555555555555';
const SLUG = 'you-codex-agent';
const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = rsa.export({ type: 'pkcs1', format: 'pem' });
const LEAKS = ['BEGIN RSA PRIVATE KEY', PEM.split('\n')[1]];
const assertNoSecret = (text, label) => { for (const leak of LEAKS) assert.ok(!text.includes(leak), `${label} leaked key material`); };

// A hermetic HOME with one soul whose soul.json declares `store`, its
// identity, census row and a legacy key folder. Nothing touches the real
// HOME, Keychain or launchd.
function fixture(t, { store = 'keyd' } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'keyd-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'xdg'),
    AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json'),
    AGENT_BOT_SECURITY_BIN: '/nonexistent/security', AGENT_BOT_SUPERVISOR_SKIP_LOAD: '1',
  };
  writeFileSync(env.AGENT_BOT_CONFIG, '{}');
  const file = env.AGENT_BOT_POPULATION_PATH;
  const soul = path.join(env.AGENT_BOT_SOULS_HOME, 'Ted.soul');
  mkdirSync(path.join(soul, '.soul-state'), { recursive: true });
  writeFileSync(path.join(soul, '.soul-state', 'agent-id'), AGENT);
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Ted', description: 'Test soul', displaySeed: 'ted',
    preferredHarnesses: [], credentials: { github: { app: SLUG, store } }, revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(soul, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(soul, 'AGENTS.md'), 'Instructions\n');
  manifest.revision = computePackageRevision(soul);
  writeFileSync(path.join(soul, 'soul.json'), JSON.stringify(manifest));
  upsertSoul({ id: AGENT, name: 'ted', status: 'active', appSlug: SLUG, spacePath: path.join(home, 'space') }, { file });
  registerSoulDir(AGENT, soul, { file });
  const legacy = path.join(home, '.config', SLUG);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, 'app-id'), '12345\n');
  writeFileSync(path.join(legacy, 'private-key.pem'), PEM, { mode: 0o600 });
  return { home, env, soul, file };
}

function decodeGrant(grant) {
  const [version, segment, signature] = grant.split('.');
  assert.equal(version, 'v1');
  return { segment, signature, payload: JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) };
}

function assertDaemonSigned(grant, env, home) {
  const raw = Buffer.from(daemonGrantPublicKey({ env, home }), 'base64');
  assert.equal(raw.length, 32);
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  const { segment, signature, payload } = decodeGrant(grant);
  assert.ok(verify(null, Buffer.from(segment), key, Buffer.from(signature, 'base64url')), 'signed by the pinned daemon key');
  return payload;
}

test('a grant carries exactly the fields keyd accepts, for 60 seconds, signed by the vouch key', (t) => {
  const { env, home } = fixture(t);
  const { privateKey } = generateKeyPairSync('ed25519');
  const at = new Date('2026-10-03T12:00:00Z');
  const grant = signKeydGrant({ agentId: AGENT, app: SLUG, tool: 'git_credential', apiBase: 'https://api.github.com',
    installationId: '42', owner: 'you', host: 'github.com' }, privateKey, () => at);
  const { payload } = decodeGrant(grant);
  assert.deepEqual(Object.keys(payload).sort(),
    ['agentId', 'apiBase', 'app', 'aud', 'exp', 'host', 'iat', 'installationId', 'nonce', 'owner', 'tool', 'v']);
  assert.equal(payload.aud, 'agent-bot-keyd');
  assert.equal(payload.exp - payload.iat, 60);
  assert.equal(payload.installationId, 42);
  assert.match(payload.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  assert.notEqual(decodeGrant(signKeydGrant({ agentId: AGENT, app: SLUG, tool: 'credential', apiBase: 'https://x' }, privateKey)).payload.nonce, payload.nonce);
  assert.throws(() => signKeydGrant({ agentId: AGENT, app: SLUG, tool: 'read_key', apiBase: 'https://x' }, privateKey), /unknown keyd tool/);
  // The pinned key is the daemon's own vouch key, created once.
  assert.equal(daemonGrantPublicKey({ env, home }), daemonGrantPublicKey({ env, home }));
  assert.equal(statSync(vouchStateDir({ env, home })).isDirectory(), true);
});

// The bytes keyd checks (#594): the signature covers the payload segment as
// sent, the nonce is 18 random bytes, and absent targets are explicit nulls.
test('a grant signs its payload segment, with an 18-byte nonce and null for absent targets', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const grant = signKeydGrant({ agentId: AGENT, app: SLUG, tool: 'credential', apiBase: 'https://api.github.com', installationId: '' },
    privateKey, () => new Date('2026-10-03T12:00:00.900Z'));
  const { segment, signature, payload } = decodeGrant(grant);
  assert.equal(grant.split('.').length, 3);
  assert.ok(verify(null, Buffer.from(segment), publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(Buffer.from(payload.nonce, 'base64url').length, 18);
  assert.deepEqual([payload.v, payload.installationId, payload.owner, payload.host], [1, null, null, null]);
  assert.equal(payload.iat, Date.parse('2026-10-03T12:00:00Z') / 1000, 'whole seconds, rounded down');
});

test('the daemon mints for a keyd soul by calling credential with its own grant', async (t) => {
  const { env, home } = fixture(t);
  const calls = [];
  const request = async (socket, method, params) => {
    calls.push({ socket, method, params });
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: { app: SLUG, token: 'ghs_keyd', expires_at: '2026-10-03T13:00:00Z', installation_id: 7 }, isError: false };
  };
  const minted = await mintViaKeyd({ agentId: AGENT, app: SLUG, env, home, config: { apiBase: 'https://api.github.com', owner: 'you' }, request });
  assert.deepEqual(minted, { token: 'ghs_keyd', expires_at: '2026-10-03T13:00:00Z', installation_id: 7 });
  assert.equal(calls[0].socket, keydPaths({ env, home }).socket);
  assert.equal(calls[0].method, 'tools/call');
  assert.equal(calls[0].params.name, 'credential');
  const payload = assertDaemonSigned(calls[0].params._meta[KEYD_GRANT_META], env, home);
  assert.deepEqual([payload.agentId, payload.app, payload.tool, payload.owner, payload.host], [AGENT, SLUG, 'credential', 'you', 'github.com']);
  await assert.rejects(mintViaKeyd({ agentId: AGENT, app: SLUG, env, home, config: {},
    request: async () => ({ content: [{ type: 'text', text: 'no key is held for this soul' }], isError: true }) }), /no key is held/);
});

test('keydRequest speaks newline-delimited JSON-RPC and reports keyd refusals and absence', async (t) => {
  const dir = mkdtempSync(path.join('/tmp', 'kdc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, 's');
  const server = net.createServer((connection) => {
    connection.on('data', (chunk) => {
      const message = JSON.parse(String(chunk).trim());
      const reply = message.method === 'owner/status'
        ? { jsonrpc: '2.0', id: message.id, result: { pinned: true, version: '0.1.0' } }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'the owner did not approve' } };
      connection.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => server.close());
  assert.deepEqual(await keydRequest(socket, 'owner/status'), { pinned: true, version: '0.1.0' });
  await assert.rejects(keydRequest(socket, 'owner/import', {}), /the owner did not approve/);
  await assert.rejects(keydRequest(path.join(dir, 'missing'), 'owner/status'), { code: 'keyd-unavailable' });

  // A keyd that hangs up mid-answer settles the call instead of leaving it pending.
  const halfSocket = path.join(dir, 'half');
  const half = net.createServer((connection) => { connection.on('data', () => connection.end('{"jsonrpc":"2.0"')); });
  await new Promise((resolve) => half.listen(halfSocket, resolve));
  t.after(() => half.close());
  await assert.rejects(keydRequest(halfSocket, 'owner/status', {}, { timeoutMs: 60_000 }), { code: 'keyd-unavailable', message: /closed the connection/ });
});

test('the owner import sends every key at once with the daemon key to pin', async (t) => {
  const { env, home } = fixture(t);
  const seen = [];
  await importIntoKeyd([{ agentId: AGENT, app: SLUG, appId: '12345', privateKeyPem: PEM }], {
    env, home, request: async (socket, method, params, options) => { seen.push({ socket, method, params, options }); return { stored: 1 }; },
  });
  assert.equal(seen[0].socket, keydPaths({ env, home }).ownerSocket);
  assert.equal(seen[0].method, 'owner/import');
  assert.equal(seen[0].params.items.length, 1);
  assert.equal(seen[0].params.daemonKey, daemonGrantPublicKey({ env, home }));
  assert.ok(seen[0].options.timeoutMs >= 120_000, 'long enough for a person to answer');
});

test('install writes a launchd unit for keyd serve and a record; uninstall removes both', (t) => {
  const { env, home } = fixture(t);
  const bin = path.join(home, 'agent-bot-keyd');
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const loads = [];
  const exec = (args) => loads.push(args);
  assert.throws(() => installKeyd({ bin, env, home, platform: 'linux', exec }), /only on macOS/);
  assert.throws(() => installKeyd({ bin: 'agent-bot-keyd', env, home, platform: 'darwin', exec }), /absolute path/);
  const first = installKeyd({ bin, env: { ...env, AGENT_BOT_KEYD_SERVICE_LABEL: 'app.geniusbar.keyd' }, home, platform: 'darwin', exec });
  assert.equal(first.label, 'app.geniusbar.keyd');
  assert.equal(first.changed, true);
  const unit = readFileSync(first.unitPath, 'utf8');
  assert.match(unit, /<string>app\.geniusbar\.keyd<\/string>/);
  assert.match(unit, new RegExp(`<string>${bin.replaceAll('.', '\\.')}</string>\\s*<string>serve</string>\\s*<string>--state-dir</string>`));
  assert.deepEqual(loads, [], 'AGENT_BOT_SUPERVISOR_SKIP_LOAD keeps launchctl out of tests');
  assert.deepEqual(readKeydRecord({ env, home }), { bin, label: 'app.geniusbar.keyd' });
  assert.equal(statSync(keydPaths({ env, home }).record).mode & 0o777, 0o600);
  assert.equal(statSync(keydPaths({ env, home }).dir).mode & 0o777, 0o700);
  assert.equal(installKeyd({ bin, env: { ...env, AGENT_BOT_KEYD_SERVICE_LABEL: 'app.geniusbar.keyd' }, home, platform: 'darwin', exec }).changed, false);
  assert.throws(() => installKeyd({ bin, env: { ...env, AGENT_BOT_KEYD_SERVICE_LABEL: '../x' }, home, platform: 'darwin', exec }), /must use letters/);
  const removed = uninstallKeyd({ env: { ...env, AGENT_BOT_KEYD_SERVICE_LABEL: 'app.geniusbar.keyd' }, home, platform: 'darwin', exec });
  assert.equal(removed.unloaded, true);
  assert.equal(existsSync(first.unitPath), false);
  assert.equal(readKeydRecord({ env, home }), null);
});

test('a unit that fails to load leaves no install record behind', (t) => {
  const { env, home } = fixture(t);
  const bin = path.join(home, 'agent-bot-keyd');
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const loading = { ...env, AGENT_BOT_SUPERVISOR_SKIP_LOAD: '' };
  const exec = (args) => { if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5: Input/output error'); };
  assert.throws(() => installKeyd({ bin, env: loading, home, platform: 'darwin', exec }), /Bootstrap failed/);
  assert.equal(readKeydRecord({ env, home }), null, 'no record, so the daemon injects no relay');
});

test('uninstall removes the unit under the label install saved', (t) => {
  const { env, home } = fixture(t);
  const bin = path.join(home, 'agent-bot-keyd');
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const custom = installKeyd({ bin, env: { ...env, AGENT_BOT_KEYD_SERVICE_LABEL: 'app.geniusbar.keyd' }, home, platform: 'darwin', exec: () => {} });
  const removed = uninstallKeyd({ env, home, platform: 'darwin', exec: () => {} });
  assert.equal(removed.label, 'app.geniusbar.keyd');
  assert.equal(removed.unloaded, true);
  assert.equal(existsSync(custom.unitPath), false);
  assert.equal(readKeydRecord({ env, home }), null);
});

test('a bound keyd soul\'s mint through the daemon keeps the installation id', async (t) => {
  const { env, home } = fixture(t);
  const file = path.join(home, 'agent-binding.json');
  writeFileSync(file, JSON.stringify({ v: 1, agentId: AGENT, parent: null, account: 'acct', daemon: 'http://127.0.0.1:4242/', secret: 'a'.repeat(43) }), { mode: 0o600 });
  const fetchImpl = async () => new Response(JSON.stringify({ appSlug: SLUG, token: 'ghs_x', expires_at: '2026-10-03T09:00:00Z', installation_id: 77 }), { status: 200 });
  const grant = await (await import('../keyd-client.mjs')).mintThroughDaemon({ slug: SLUG, env: { ...env, AGENT_BOT_BINDING: file }, fetchImpl });
  assert.deepEqual(grant, { token: 'ghs_x', expires_at: '2026-10-03T09:00:00Z', installation_id: 77 });
});

test('status says whether keyd answers and whether the daemon key is pinned', async (t) => {
  const { env, home } = fixture(t);
  assert.deepEqual(await keydStatus({ env, home, request: async () => ({ pinned: true, version: '0.1.0' }) }),
    { running: true, bin: null, pinned: true, version: '0.1.0' });
  assert.equal((await keydStatus({ env, home, request: async () => { throw new Error('down'); } })).running, false);
});

test('a keyd soul resolves to keyd with no key, and mint goes through keyd', async (t) => {
  const { env, home } = fixture(t);
  const stores = credentialStores({ env });
  const resolved = resolveAppCredential(SLUG, { agentId: AGENT, env, home, cwd: home, stores, warn: () => assert.fail('no legacy notice') });
  assert.deepEqual(resolved, { slug: SLUG, appId: null, privateKeyPem: null, source: 'keyd', agentId: AGENT });
  assert.throws(() => stores.keyd.read({ agentId: AGENT, slug: SLUG }), /held by agent-bot-keyd/);
  const config = appConfig({ argv: ['node', 'mint-token.mjs', '--app', SLUG], env, home, cwd: home, config: {} });
  assert.deepEqual(config.keyd, { agentId: AGENT });
  assert.equal(config.privateKeyPem, null);
  const asked = [];
  const minted = await mint({ slug: SLUG, env, agentId: AGENT, viaKeyd: async (soul) => { asked.push(soul); return { token: 'ghs_k' }; } });
  assert.equal(minted.token, 'ghs_k');
  assert.deepEqual([asked[0].agentId, asked[0].app], [AGENT, SLUG]);
  // Outside the daemon, with no binding, there is no key to fall back to.
  await assert.rejects(mint({ slug: SLUG, env: { ...env, AGENT_BOT_BINDING: path.join(home, 'none.json') }, agentId: AGENT }), /held by agent-bot-keyd/);
});

test('migrate-credentials --to keyd imports every key in one owner call and only then declares keyd', async (t) => {
  const { env, home, soul } = fixture(t, { store: 'file' });
  const out = [];
  const imports = [];
  const common = { env, home, cwd: home, platform: 'darwin', markers: () => [], write: (text) => out.push(text),
    gate: async () => ({ method: 'consent' }), verify: async () => true };
  const dry = await migrateCredentialsCommand(['--all', '--to', 'keyd', '--dry-run', '--json'], { ...common,
    keyd: { importKeys: async () => assert.fail('a dry run imports nothing') } });
  assert.equal(dry.souls[0].status, 'would-migrate');
  assert.equal(dry.souls[0].detail, 'from legacy');

  const refused = await migrateCredentialsCommand(['--all', '--to', 'keyd', '--json'], { ...common,
    keyd: { importKeys: async () => { throw new Error('the owner did not approve'); } } });
  assert.equal(refused.souls[0].status, 'failed');
  assert.deepEqual(soulCredentialsDeclaration(soul), { app: SLUG, store: 'file' }, 'soul.json is unchanged when keyd refuses');

  const report = await migrateCredentialsCommand(['--all', '--to', 'keyd', '--json'], { ...common,
    keyd: { importKeys: async (items) => { imports.push(items); return { stored: items.length }; } } });
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].map(({ agentId, app, appId }) => [agentId, app, appId]), [[AGENT, SLUG, '12345']]);
  assert.equal(report.souls[0].status, 'migrated');
  assert.equal(report.souls[0].store, 'keyd');
  assert.deepEqual(soulCredentialsDeclaration(soul), { app: SLUG, store: 'keyd' });
  assert.ok(existsSync(path.join(home, '.config', SLUG, 'private-key.pem')), 'the old copy stays');

  const again = await migrateCredentialsCommand(['--all', '--to', 'keyd', '--json'], { ...common,
    keyd: { importKeys: async () => assert.fail('nothing left to import') } });
  assert.equal(again.souls[0].status, 'already-migrated');
  // A plain migrate leaves a keyd soul alone instead of reading its key.
  const plain = await migrateCredentialsCommand(['--all', '--json'], { ...common, stores: credentialStores({ env }) });
  assert.equal(plain.souls[0].status, 'already-migrated');
  assertNoSecret(out.join(''), 'stdout');
  assertNoSecret(readFileSync(auditFile({ env, home }), 'utf8'), 'audit');
});

test('turns of a keyd soul get the keyd relay and its allow rules; others do not', (t) => {
  const { env } = fixture(t);
  assert.deepEqual(keydPolicyRules().map((rule) => rule.tool), ['mcp__agent-bot-keyd__credential', 'mcp__agent-bot-keyd__git_credential']);
  const keydRules = (policy) => policy.rules.filter((rule) => rule.tool.includes('keyd')).length;
  assert.equal(keydRules(withReachRules({ version: 1, rules: [], fallback: 'deny' })), 0, 'no keyd allow without the relay');
  assert.equal(keydRules(withReachRules({ version: 1, rules: [], fallback: 'deny' }, { keyd: true })), 2);
  const entry = keydMcpServerEntry({ bin: '/Applications/GeniusBar.app/Contents/MacOS/agent-bot-keyd', binding: '/w/.git/agent-binding.json', env });
  assert.deepEqual(entry.args, ['mcp']);
  assert.deepEqual(entry.env.map((v) => v.name), ['AGENT_BOT_BINDING', 'HOME', 'XDG_STATE_HOME']);
  const servers = (keydFor, appSlug = SLUG) => {
    let captured = null;
    const factory = acpExecutorFor({
      identities: () => ({ github: appSlug ? { appSlug } : null }),
      policy: { version: 1, rules: [], fallback: 'deny' },
      baseEnv: env,
      keydFor,
      createExecutor: ({ mcpServers, policy }) => { captured = { mcpServers, policy }; return () => {}; },
    });
    factory({ agentId: AGENT, harness: 'claude', cwd: '/w', env: { AGENT_BOT_BINDING: '/w/.git/agent-binding.json' } });
    const names = captured.mcpServers({ invocation: {} }).map((server) => server.name);
    // The keyd allow rules follow the relay: a soul without it must not
    // inherit an allow for those tool names from another MCP server.
    assert.equal(keydRules(captured.policy), names.includes('agent-bot-keyd') ? 2 : 0, `policy for ${names}`);
    return names;
  };
  assert.deepEqual(servers(() => '/k/agent-bot-keyd'), ['agent-reach', 'agent-bot-keyd']);
  assert.deepEqual(servers(() => null), ['agent-reach']);
  assert.deepEqual(servers(() => { throw new Error('no census'); }), ['agent-reach']);
  assert.deepEqual(servers(() => '/k/agent-bot-keyd', null), ['agent-reach'], 'no App, no keyd');
});

test('the daemon grants keyd calls only to a bound keyd soul, and receipts each answer', async (t) => {
  const { env, home, soul } = fixture(t);
  const worktree = path.join(home, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  const gitDir = path.join(worktree, '.git');
  ensureAgentIdentity({
    gate: () => true, appSlug: SLUG, botUid: '308462948', harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-keyd' }, stateDir: stateDirectory({ env, home }),
    idFactory: () => AGENT, now: () => new Date('2026-10-03T08:00:00.000Z'),
  });
  const record = mintBindToken({ gitDir, worktree, agentId: AGENT });
  const keydCalls = [];
  const server = createDaemonServer({
    env, home, config: { features: { 'github-identity': true }, apiBase: 'https://api.github.com' },
    mintImpl: async ({ slug, agentId, viaKeyd }) => viaKeyd({ agentId, app: slug }),
    keydCall: async (socket, method, params) => {
      keydCalls.push(params);
      return { structuredContent: { token: 'ghs_from_keyd', expires_at: '2026-10-03T09:00:00Z', installation_id: 9 } };
    },
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const port = server.address().port;
  const call = (pathname, { body, headers = {}, bearer = true } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { ...(bearer ? { authorization: `Bearer ${server.token}` } : {}), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const bound = await (await call('/v0/bind', { body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-keyd' } } })).json();
  const asSoul = { 'x-agent-binding': bound.secret };

  assert.equal((await call('/v0/keyd/grant', { body: { tool: 'credential' }, bearer: false })).status, 401);
  assert.equal((await call('/v0/keyd/grant', { body: { tool: 'read_key' }, headers: asSoul, bearer: false })).status, 400);
  const granted = await call('/v0/keyd/grant', { body: { tool: 'git_credential' }, headers: asSoul, bearer: false });
  assert.equal(granted.status, 200, await granted.clone().text());
  const payload = assertDaemonSigned((await granted.json()).grant, env, home);
  assert.deepEqual([payload.agentId, payload.app, payload.tool, payload.host], [AGENT, SLUG, 'git_credential', 'github.com']);

  // The daemon's own broker route mints a keyd soul's token through keyd.
  const credential = await call('/v0/credential', { headers: asSoul, bearer: false });
  assert.equal(credential.status, 200);
  const minted = await credential.json();
  assert.equal(minted.token, 'ghs_from_keyd');
  assert.equal(minted.installation_id, 9, 'keyd\'s installation id reaches the caller');
  assert.equal(keydCalls.length, 1);
  assert.equal(assertDaemonSigned(keydCalls[0]._meta[KEYD_GRANT_META], env, home).tool, 'credential');

  // A soul whose key is not in keyd gets no grant.
  const manifest = JSON.parse(readFileSync(path.join(soul, 'soul.json'), 'utf8'));
  manifest.credentials.github.store = 'keychain';
  writeFileSync(path.join(soul, 'soul.json'), JSON.stringify(manifest));
  const refused = await call('/v0/keyd/grant', { body: { tool: 'credential' }, headers: asSoul, bearer: false });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /does not hold this soul's key/);

  const receipts = readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).filter((receipt) => receipt.event === 'credential-grant');
  assert.deepEqual(receipts.map((receipt) => receipt.decision), ['denied', 'denied', 'granted', 'denied']);
  assert.doesNotMatch(JSON.stringify(receipts), /v1\.|ghs_/);
});

// #775: the daemon mints in its own process, which has no worktree binding,
// with the real mint() — no fake mintImpl — so a binding check moved into
// mint() would show here. A retired soul's binding then mints nothing.
test('the daemon mints a bound keyd soul\'s token with the real mint(), and refuses it once retired', async (t) => {
  const { env, home } = fixture(t);
  const worktree = path.join(home, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  const gitDir = path.join(worktree, '.git');
  const stateDir = stateDirectory({ env, home });
  ensureAgentIdentity({
    gate: () => true, appSlug: SLUG, botUid: '308462948', harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-real-mint' }, stateDir,
    idFactory: () => AGENT, now: () => new Date('2026-10-03T08:00:00.000Z'),
  });
  const record = mintBindToken({ gitDir, worktree, agentId: AGENT });
  let keydCalls = 0;
  const server = createDaemonServer({
    env, home, config: { features: { 'github-identity': true }, apiBase: 'https://api.github.com' },
    keydCall: async () => {
      keydCalls += 1;
      return { structuredContent: { token: 'ghs_real_mint', expires_at: '2026-10-03T09:00:00Z', installation_id: 9 } };
    },
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const port = server.address().port;
  const call = (pathname, { body, headers = {}, bearer = true } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { ...(bearer ? { authorization: `Bearer ${server.token}` } : {}), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const bound = await (await call('/v0/bind', { body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-real-mint' } } })).json();
  const asSoul = { 'x-agent-binding': bound.secret };

  const granted = await call('/v0/credential', { headers: asSoul, bearer: false });
  assert.equal(granted.status, 200, await granted.clone().text());
  assert.equal((await granted.json()).token, 'ghs_real_mint');
  assert.equal(keydCalls, 1);

  retireAgentIdentity(AGENT, { stateDir });
  const retired = await call('/v0/credential', { headers: asSoul, bearer: false });
  assert.equal(retired.status, 409);
  assert.match((await retired.json()).error, /retired/);
  assert.equal(keydCalls, 1, 'a retired soul reaches no key');
  const receipts = readFileSync(auditFile({ env, home }), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).filter((receipt) => receipt.event === 'credential-mint');
  assert.deepEqual(receipts.map((receipt) => [receipt.decision, receipt.reason]), [['granted', 'bound-soul-own-app'], ['denied', 'soul-retired']]);
  assert.doesNotMatch(JSON.stringify(receipts), /ghs_/);
});

// App-level keys (#110 slice 2).
test('an App-scope grant adds keyScope app; a soul grant keeps its 12 keys; another scope is refused', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const base = { agentId: AGENT, app: SLUG, tool: 'credential', apiBase: 'https://api.github.com' };
  const app = decodeGrant(signKeydGrant({ ...base, keyScope: 'app' }, privateKey)).payload;
  assert.equal(app.keyScope, 'app');
  assert.equal(Object.keys(app).length, 13);
  for (const keyScope of [undefined, null, 'soul']) {
    assert.equal(Object.hasOwn(decodeGrant(signKeydGrant({ ...base, keyScope }, privateKey)).payload, 'keyScope'), false);
  }
  assert.throws(() => signKeydGrant({ ...base, keyScope: 'org' }, privateKey), /unknown keyd key scope/);
});

test('keyd is verified for App keys only when it runs, is pinned and knows owner/app-status', async (t) => {
  const { env, home } = fixture(t);
  const keyd = (answers) => async (socket, method, params) => {
    assert.equal(socket, keydPaths({ env, home }).ownerSocket);
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    if (method === 'owner/app-status') assert.deepEqual(params, { app: SLUG });
    return answer;
  };
  const refused = (rpcCode) => Object.assign(new Error('refused'), { code: 'keyd-refused', rpcCode });
  assert.deepEqual(await appKeydAvailability(SLUG, { env, home, request: keyd({ 'owner/status': { pinned: true }, 'owner/app-status': { pinned: true, held: false } }) }),
    { available: true, held: false });
  assert.deepEqual(await appKeydAvailability(SLUG, { env, home, request: keyd({ 'owner/status': { pinned: true }, 'owner/app-status': { pinned: true, held: true } }) }),
    { available: true, held: true });
  assert.deepEqual(await appKeydAvailability(SLUG, { env, home, request: keyd({ 'owner/status': new Error('down') }) }),
    { available: false, reason: 'agent-bot-keyd is not installed' });
  assert.deepEqual(await appKeydAvailability(SLUG, { env, home, request: keyd({ 'owner/status': { pinned: false } }) }),
    { available: false, reason: "agent-bot-keyd has not pinned this daemon's key yet" });
  const older = await appKeydAvailability(SLUG, { env, home, request: keyd({ 'owner/status': { pinned: true }, 'owner/app-status': refused(-32601) }) });
  assert.equal(older.available, false); assert.match(older.reason, /predates App-level keys \(#110\)/);
  assert.equal((await appKeydAvailability(SLUG, { env, home, request: keyd({ 'owner/status': { pinned: true }, 'owner/app-status': refused(-32000) }) })).available, false);
  const calls = [];
  await importAppIntoKeyd([{ app: SLUG, appId: '12345', privateKeyPem: PEM }], { env, home, request: async (...args) => { calls.push(args); return { stored: 1 }; } });
  assert.deepEqual([calls[0][0], calls[0][1]], [keydPaths({ env, home }).ownerSocket, 'owner/app-import']);
  assert.equal(calls[0][2].daemonKey, daemonGrantPublicKey({ env, home }));
  await removeAppFromKeyd(SLUG, { env, home, request: async (...args) => { calls.push(args); return { removed: true }; } });
  assert.deepEqual(calls[1].slice(0, 3), [keydPaths({ env, home }).ownerSocket, 'owner/app-remove', { app: SLUG }]);
});

test('a soul whose App keyd holds App-level mints with an App-scope grant naming the soul', async (t) => {
  const { env, home } = fixture(t, { store: 'file' });
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({ features: { 'github-identity': true }, apiBase: 'https://api.github.com',
    identityApps: { [SLUG]: { id: '12345', store: 'keyd', keyFingerprint: 'SHA256:x' } } }));
  const resolved = resolveAppCredential(SLUG, { agentId: AGENT, env, home, cwd: home, warn: () => assert.fail('no legacy notice') });
  assert.deepEqual(resolved, { slug: SLUG, appId: '12345', privateKeyPem: null, source: 'keyd', keyScope: 'app', agentId: AGENT });
  assert.deepEqual(appConfig({ argv: ['node', 'mint-token.mjs', '--app', SLUG], env, home, cwd: home, agentId: AGENT }).keyd, { agentId: AGENT, keyScope: 'app' });
  // A soul whose own soul.json says keyd still mints with its own key.
  const own = fixture(t);
  writeFileSync(own.env.AGENT_BOT_CONFIG, JSON.stringify({ identityApps: { [SLUG]: { id: '12345', store: 'keyd' } } }));
  assert.equal(resolveAppCredential(SLUG, { agentId: AGENT, env: own.env, home: own.home, cwd: own.home }).keyScope, undefined);

  // The daemon's /v0/credential, through the real mint(), with a fake keyd.
  const worktree = path.join(home, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  const gitDir = path.join(worktree, '.git');
  ensureAgentIdentity({
    gate: () => true, appSlug: SLUG, botUid: '308462948', harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-app-key' }, stateDir: stateDirectory({ env, home }),
    idFactory: () => AGENT, now: () => new Date('2026-10-09T08:00:00.000Z'),
  });
  const record = mintBindToken({ gitDir, worktree, agentId: AGENT });
  const grants = [];
  const server = createDaemonServer({
    env, home, config: { features: { 'github-identity': true }, apiBase: 'https://api.github.com' },
    keydCall: async (socket, method, params) => {
      grants.push(assertDaemonSigned(params._meta[KEYD_GRANT_META], env, home));
      return { structuredContent: { token: 'ghs_app_level', expires_at: '2026-10-09T09:00:00Z', installation_id: 9 } };
    },
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const port = server.address().port;
  const call = (pathname, { body, headers = {}, bearer = true } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { ...(bearer ? { authorization: `Bearer ${server.token}` } : {}), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const bound = await (await call('/v0/bind', { body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-app-key' } } })).json();
  const granted = await call('/v0/credential', { headers: { 'x-agent-binding': bound.secret }, bearer: false });
  assert.equal(granted.status, 200, await granted.clone().text());
  assert.equal((await granted.json()).token, 'ghs_app_level');
  assert.equal(grants.length, 1);
  assert.deepEqual([grants[0].keyScope, grants[0].agentId, grants[0].app, grants[0].tool], ['app', AGENT, SLUG, 'credential']);
});

test('agent-bot --help lists the keyd command and its actions', async () => {
  const { helpText } = await import('../cli/output.mjs');
  assert.match(helpText(), /^ {2}keyd {2,}.*install --bin PATH \| uninstall \| status/m);
});

test('keyd-client.mjs run directly points at agent-bot keyd and does nothing (#645)', () => {
  let failure = null;
  try {
    execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'keyd-client.mjs'), 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { failure = error; }
  assert.ok(failure, 'the client library must refuse to act as the command line');
  assert.match(failure.stderr, /run agent-bot keyd/);
  assert.equal(failure.stdout, '');
});
