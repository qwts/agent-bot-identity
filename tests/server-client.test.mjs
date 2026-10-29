import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ServerSession, agentBotServerSetting, enroll, fetchSoulTokenIssuer, jwkThumbprint, loadDevice, logout, main, mintViaServer, onDeviceRevoked, reconcilePendingCredentials, taskIdFor,
  parseServerArgs, serverHarness, serverUrl, signatureMessage, statePaths, validateServerUrl,
} from '../identity/server-client.mjs';
import { parseConfig } from '../config.mjs';
import { mint } from '../mint-token.mjs';
import { readAction } from '../identity/action-ledger.mjs';

import { BASE, fakeServer, sandbox, sleep } from './helpers/fake-identity-server.mjs';


// A fake agent-bot server that checks the wire format the Go server enforces.

test('server mode is off unless AGENT_BOT_SERVER or settings.agentBotServer is set', () => {
  const env = sandbox();
  assert.equal(serverUrl({ env, config: {} }), null);
  assert.equal(serverUrl({ env: { ...env, AGENT_BOT_SERVER: 'https://x.test/' }, config: {} }), 'https://x.test');
  assert.equal(agentBotServerSetting({ settings: { agentBotServer: 'https://y.test' } }), 'https://y.test');
  assert.equal(serverUrl({ env, config: { settings: { agentBotServer: 'https://y.test' } } }), 'https://y.test');
  assert.equal(validateServerUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.throws(() => validateServerUrl('http://evil.test'), /https/);
  assert.throws(() => parseConfig('{"settings":{"agentBotServer":"http://evil.test"}}'), /agentBotServer/);
  assert.doesNotThrow(() => parseConfig('{"settings":{"agentBotServer":"https://agent-bot-gold.vercel.app"}}'));
  for (const bad of ['https://u:p@x.test', 'https://x.test/?a=1', 'https://x.test/#f']) {
    assert.throws(() => parseConfig(JSON.stringify({ settings: { agentBotServer: bad } })), /no credentials/);
    assert.throws(() => validateServerUrl(bad), /no credentials/);
  }
});

test('argument parsing and harness names', () => {
  assert.deepEqual(parseServerArgs(['enroll', '--harness', 'claude-code', '--tag', 'ci']).harnesses, ['claude']);
  assert.throws(() => parseServerArgs(['enroll', '--bogus']), /unknown option/);
  assert.throws(() => parseServerArgs(['nope']), /unknown server command/);
  assert.equal(serverHarness('grok'), 'grok');
});

test('device-grant enrollment stores a 0600 P-256 key, pins the server key and records management', async () => {
  const env = sandbox();
  const srv = fakeServer({ approveAfter: 2 });
  let prompt;
  const dev = await enroll({ base: BASE, env, harnesses: ['grok'], deviceName: 'box', fetchImpl: srv.fetch, sleep, onPrompt: (p) => { prompt = p; } });
  assert.equal(prompt.user_code, 'ABCD-EFGH');
  assert.equal(dev.device_id, 'dev_1');
  assert.equal(dev.management, 'managed');
  assert.equal(dev.method, 'device_code');
  assert.deepEqual(dev.harnesses, ['grok']);
  const paths = statePaths({ env });
  if (process.platform !== 'win32') {
    assert.equal(statSync(paths.key).mode & 0o777, 0o600);
    assert.equal(statSync(paths.device).mode & 0o777, 0o600);
    assert.equal(statSync(paths.dir).mode & 0o777, 0o700);
  }
  assert.match(readFileSync(paths.key, 'utf8'), /BEGIN PRIVATE KEY/);
  assert.equal(JSON.parse(readFileSync(paths.serverKey, 'utf8')).kid, 'kid1');
  await assert.rejects(enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep }), /already enrolled/);
});

test('enrollment token enrolls a cloud VM without a browser', async () => {
  const env = { ...sandbox(), AGENT_BOT_ENROLL_TOKEN: 'abe_good' };
  const srv = fakeServer();
  const dev = await enroll({ base: BASE, env, fetchImpl: srv.fetch, sleep });
  assert.equal(dev.method, 'enrollment_token');
  assert.equal(dev.ephemeral, true);
  assert.equal(dev.platform, 'cloud-vm');
  assert.ok(!srv.calls.includes('/oauth/device_authorization'));
  await assert.rejects(enroll({ base: BASE, env: { ...sandbox(), AGENT_BOT_ENROLL_TOKEN: 'bad' }, fetchImpl: srv.fetch, sleep }), /invalid_grant/);
});

test('session re-mints the DPoP token before expiry and after a 401, with a fresh ephemeral key', async () => {
  const env = sandbox();
  const srv = fakeServer({ tokenTtl: 900 });
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  await session.whoami();
  const first = session.token.value;
  await session.whoami();
  assert.equal(session.token.value, first, 'cached while fresh');
  session.token.refreshAt = Date.now() - 1; // simulate sleep past the refresh margin
  await session.whoami();
  assert.notEqual(session.token.value, first);
  srv.expireNext = true;
  const before = srv.issued;
  await session.whoami();
  assert.equal(srv.issued, before + 1, 'one re-mint after 401');
  assert.equal(srv.seenEk.size, srv.issued);
});

test('installation tokens come from the server; responses must carry a valid pinned signature', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const minted = await mintViaServer({ base: BASE, harness: 'grok', repo: 'true-line/agent-bot', env, fetchImpl: srv.fetch });
  assert.equal(minted.token, 'ghs_op1');
  assert.equal(minted.source, 'agent-bot-server');
  assert.match(minted.git_author, /qwts-grok-agent/);
  // credential/v1: one credential per task and operation, with the profile in force.
  assert.equal(srv.lastCredential.kind, 'github_installation_token');
  assert.equal(srv.lastCredential.profile, 'managed cooperative');
  assert.match(srv.lastCredential.operation_id, /^op_[0-9a-f-]{36}$/);
  assert.equal(srv.lastCredential.task_id, `adhoc.${srv.lastCredential.operation_id}`);
  assert.deepEqual([minted.issuance_id, minted.task_id, minted.operation_id], ['iss_1', srv.lastCredential.task_id, srv.lastCredential.operation_id]);
  await assert.rejects(mintViaServer({ base: BASE, harness: 'codex', repo: 'a/b', env, fetchImpl: srv.fetch }), /403/);
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: null, env, fetchImpl: srv.fetch }), /owner\/name/);

  const evil = fakeServer({ tamper: true });
  evil.devices = srv.devices; // same devices, but a different (unpinned) signing key
  await assert.rejects(new ServerSession({ base: BASE, env, fetchImpl: evil.fetch }).whoami(), /signature is invalid/);
});

test('a slug the device scope names is asked for as itself, and server error descriptions reach the caller', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_REPO: 'true-line/agent-bot' };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['trueline-grokbot-agent'], fetchImpl: srv.fetch, sleep });
  const realFetch = globalThis.fetch;
  globalThis.fetch = srv.fetch;
  try {
    const { mint } = await import('../identity/mint-token.mjs');
    const grant = await mint({ slug: 'trueline-grokbot-agent', env });
    assert.equal(srv.lastCredential.harness, 'trueline-grokbot-agent', 'the slug in the device scope is sent as-is');
    assert.equal(grant.issuance_id, 'iss_1');
  } finally { globalThis.fetch = realFetch; }
  // A refusal's description is kept: "no app for harness" must not read as a bare 400.
  srv.describeError = { error: 'invalid_request', error_description: 'no app for harness "grok"; see list_harness_apps' };
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch }), /400 invalid_request \(no app for harness "grok"; see list_harness_apps\)/);
});

test('every mint is its own operation; a token is never reused, and a mismatched echo is refused', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const a = await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 'task.1' });
  const b = await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 'task.1' });
  assert.notEqual(a.operation_id, b.operation_id);
  assert.notEqual(a.token, b.token);
  assert.deepEqual([a.task_id, b.task_id], ['task.1', 'task.1']);
  // The daemon never sends a used operation again: the ledger refuses it locally.
  const sent = srv.calls.length;
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 'task.1', operationId: a.operation_id }),
    (error) => error.code === 'operation-conflict' && /already used \(succeeded\)/.test(error.message));
  assert.equal(srv.calls.length, sent, 'nothing was sent for a reused operation');
  // At the wire, the service replays an operation's own issuance and refuses a different request under it.
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  const replay = await session.credential({ harness: 'grok', repo: 'o/r', taskId: 'task.1', operationId: a.operation_id, profile: 'managed cooperative' });
  assert.deepEqual([replay.issuance_id, replay.replayed], [a.issuance_id, true]);
  await assert.rejects(session.credential({ harness: 'grok', repo: 'o/other', taskId: 'task.1', operationId: a.operation_id, profile: 'managed cooperative' }),
    (error) => error.code === 'operation-conflict');
  srv.badEcho = true;
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch }), /does not match the requested task and operation/);
  assert.equal(taskIdFor({ env: { AGENT_BOT_TASK_ID: 'turn.42' }, operationId: 'op_x' }), 'turn.42');
  assert.match(taskIdFor({ env: {}, agentId: 'agent_11111111-1111-4111-8111-111111111111', transcript: { provider: 'codex', id: 't/1' }, operationId: 'op_x' }),
    /^agent_11111111-1111-4111-8111-111111111111\.[0-9a-f]{16}$/);
});

test('credential-unavailable while the identity service is down, unsigned 5xx or a signed 503; nothing is issued', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  await session.whoami(); // a session token is held
  for (const mode of ['down', 'unsigned5xx', 'signedUnavailable']) {
    srv[mode] = true;
    await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, session }),
      (error) => error.code === 'credential-unavailable' && !/ghs_/.test(error.message), mode);
    srv[mode] = false;
  }
  assert.equal(srv.ops.size, 0, 'nothing was issued during the outage');
  // A fresh process during an outage fails the same way at the token endpoint.
  srv.down = true;
  await assert.rejects(new ServerSession({ base: BASE, env, fetchImpl: srv.fetch }).whoami(), (error) => error.code === 'credential-unavailable');
  srv.down = false;
  assert.equal((await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, session })).token, 'ghs_op1', 'works again once the service is back');
});

test('device-revoked drops cached tokens at once, persists, and requires re-enrollment', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  const dev = await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  await session.whoami();
  assert.ok(session.token, 'a session token is cached');
  let dropped = 0;
  const unlisten = onDeviceRevoked(() => { dropped += 1; });
  srv.revokedDevice = dev.device_id;
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, session }), (error) => error.code === 'device-revoked' && /re-enroll/.test(error.message));
  assert.equal(session.token, null, 'the cached session token was dropped');
  assert.equal(dropped, 1, 'in-memory credentials were told to drop');
  assert.ok(loadDevice({ env }).revoked_at, 'revocation is recorded');
  // Every later attempt, in any process, refuses without asking the network.
  const before = srv.calls.length;
  await assert.rejects(new ServerSession({ base: BASE, env, fetchImpl: srv.fetch }).whoami(), (error) => error.code === 'device-revoked');
  assert.equal(srv.calls.length, before);
  // The token endpoint's revocation answer maps the same way.
  const env2 = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv2 = fakeServer();
  await enroll({ base: BASE, env: env2, harnesses: ['grok'], fetchImpl: srv2.fetch, sleep });
  srv2.devices.clear();
  const revokedFetch = async (url, init) => (new URL(url).pathname === '/oauth/token'
    ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'device_revoked' }), { status: 400 })
    : srv2.fetch(url, init));
  await assert.rejects(new ServerSession({ base: BASE, env: env2, fetchImpl: revokedFetch }).whoami(), (error) => error.code === 'device-revoked');
  assert.ok(loadDevice({ env: env2 }).revoked_at);
  unlisten();
  // Re-enrollment replaces the revoked record.
  const again = await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep, force: true });
  assert.equal(loadDevice({ env }).revoked_at, undefined);
  assert.notEqual(again.device_id, dev.device_id);
});

test('T06: a mint whose answer was lost is looked up and replayed, never minted twice', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  srv.dropAfterMint = true; // the service mints, then the connection resets
  const minted = await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 'task.t06' });
  assert.equal(srv.minted, 1, 'exactly one credential was minted upstream');
  assert.equal(srv.lookups, 1, 'the outcome was looked up before anything was re-sent');
  assert.deepEqual([minted.token, minted.issuance_id, minted.replayed], ['ghs_op1', 'iss_1', true]);
  const action = readAction(statePaths({ env }).dir, minted.operation_id);
  assert.deepEqual([action.state, action.issuance_id, action.reconciled], ['succeeded', 'iss_1', true]);
  assert.doesNotMatch(JSON.stringify(action), /ghs_/, 'the ledger never holds a credential');
});

test('T06: an unknown upstream outcome stays unknown, is not retried, and settles by lookup later', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  srv.outcomeUnknown = true;
  let operationId;
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, operationId: 'op_t06-unknown' }),
    (error) => { operationId = error.operationId; return error.code === 'outcome-unknown' && /not retried/.test(error.message); });
  assert.equal(operationId, 'op_t06-unknown');
  srv.outcomeUnknown = false;
  const dir = statePaths({ env }).dir;
  assert.equal(readAction(dir, operationId).state, 'unknown');
  assert.equal(srv.minted ?? 0, 0, 'nothing was minted or re-sent');
  // Still unknown upstream: reconciliation leaves it unknown and sends nothing new.
  assert.deepEqual(await reconcilePendingCredentials({ base: BASE, env, fetchImpl: srv.fetch }), [{ operation_id: operationId, state: 'unknown', code: 'outcome-unknown' }]);
  // Once the service reports none (its hold passed), the action settles as rejected.
  srv.unknownResolved = true;
  assert.deepEqual(await reconcilePendingCredentials({ base: BASE, env, fetchImpl: srv.fetch }), [{ operation_id: operationId, state: 'rejected', code: 'credential-unavailable' }]);
  assert.equal(srv.minted ?? 0, 0);
  // A plain refusal (signed 503 credential_unavailable) is rejected outright, with no lookup.
  srv.signedUnavailable = true;
  const lookups = srv.lookups;
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch }), (error) => error.code === 'credential-unavailable');
  assert.equal(srv.lookups, lookups);
});

test('T06: a new operation for the same task, harness and repo waits on an unknown one, and goes ahead once it settles', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  srv.outcomeUnknown = true;
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 'task.w', operationId: 'op_first' }), (e) => e.code === 'outcome-unknown');
  srv.outcomeUnknown = false;
  const posts = () => srv.calls.filter((p) => p === '/api/daemon/credentials').length;
  const before = posts();
  // Still unknown upstream: a fresh operation is refused, and nothing is sent for it.
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 'task.w' }), (e) => e.code === 'outcome-unknown' && /op_first/.test(e.message));
  assert.equal(posts(), before, 'no second mint while the first is unknown');
  // A different repository is a different request and is not held up.
  assert.ok((await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/other', env, fetchImpl: srv.fetch, taskId: 'task.w' })).token);
  // Once the service reports none, the old one settles as rejected and the new one goes ahead.
  srv.unknownResolved = true;
  const next = await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 'task.w' });
  assert.ok(next.token);
  assert.equal(readAction(statePaths({ env }).dir, 'op_first').state, 'rejected');
});

test('T06: an issued operation whose credential expired settles as rejected, never an endless unknown', async () => {
  for (const how of ['lookup-expiry', 'replay-conflict']) {
    const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
    const srv = fakeServer();
    await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
    srv.dropAfterMint = true;
    const fetchImpl = srv.fetch;
    // The lookup says issued; either it carries a past expiry, or the replay gets operation_conflict.
    if (how === 'lookup-expiry') srv.lookupExpiresAt = '2000-01-01T00:00:00Z';
    else srv.conflictOnReplay = true;
    await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl, operationId: `op_${how}` }),
      (error) => error.code === 'credential-unavailable' && /expired/.test(error.message), how);
    const action = readAction(statePaths({ env }).dir, `op_${how}`);
    assert.deepEqual([action.state, action.reason], ['rejected', how === 'lookup-expiry' ? 'reconciled-expired' : 'reconciled-conflict'], how);
    assert.equal(srv.minted, 1, `${how}: nothing new was minted`);
    // Reconcile has nothing left to do.
    assert.deepEqual(await reconcilePendingCredentials({ base: BASE, env, fetchImpl }), []);
  }
});

test('soul token v2 comes from the identity service, echoes the request, and replays by operation', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  const dev = await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  const fields = { agentId: 'agent_x', parent: 'agent_p', account: 'worker', taskId: 'soul-vouch', operationId: 'op_soul1', profile: 'managed cooperative' };
  const out = await session.soulToken(fields);
  const [h, p, sig] = out.token.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).typ, 'soul+jwt');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'ES256');
  assert.ok(sig.length > 0);
  assert.deepEqual(out.claims, JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), 'claims mirror the token payload');
  assert.equal(out.claims.v, 2);
  assert.equal(out.claims.sub, 'agent_x');
  assert.equal(out.claims.device, dev.device_id, 'the token is bound to this enrolled device');
  assert.equal(out.claims.exp - out.claims.iat, 300, 'five minutes');
  assert.equal(srv.lastSoulToken.audience, 'agent-comms');
  assert.equal(srv.lastSoulToken.presenter_jkt, undefined, 'no presenter proof requested');
  const replay = await session.soulToken({ ...fields });
  assert.equal(replay.replayed, true);
  assert.equal(replay.token, out.token, 'the same operation replays the same issuance');
});

test('a mismatched soul-token answer is refused; bound-elsewhere and signing-outage keep stable codes', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  const fields = { agentId: 'agent_x', account: 'worker', taskId: 'soul-vouch', operationId: 'op_s1' };
  srv.badSoulEcho = true;
  await assert.rejects(session.soulToken(fields), /does not match/);
  srv.badSoulEcho = false;
  srv.soulDevice = 'dev_other';
  await assert.rejects(session.soulToken({ ...fields, operationId: 'op_s2' }), /does not match/, 'a token for another device is refused');
  srv.soulDevice = null;
  srv.soulLife = 600;
  await assert.rejects(session.soulToken({ ...fields, operationId: 'op_s3' }), /does not match/, 'a longer-lived token is refused');
  srv.soulLife = null;
  srv.boundElsewhere = true;
  await assert.rejects(session.soulToken({ ...fields, operationId: 'op_s4' }), (error) => error.code === 'soul-bound-elsewhere');
  srv.boundElsewhere = false;
  srv.soulSigningDown = true;
  await assert.rejects(session.soulToken({ ...fields, operationId: 'op_s5' }), (error) => error.code === 'credential-unavailable');
  srv.soulSigningDown = false;
});

test('soul token v2: parent, issuance echo, nbf and issuer claims are checked (#1196)', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  const fields = { agentId: 'agent_x', parent: 'agent_p', account: 'worker', taskId: 'soul-vouch', profile: 'managed cooperative' };
  for (const [name, patch] of [
    ['a different parent', { parent: 'agent_other' }],
    ['an nbf after iat', { nbf: 1_760_000_001 }],
    ['a non-https issuer', { iss: 'http://agent-bot.test' }],
    ['an issuer with a path', { iss: 'https://agent-bot.test/x' }],
    ['a trailing-slash issuer', { iss: 'https://agent-bot.test/' }],
  ]) {
    srv.soulClaimsPatch = patch;
    await assert.rejects(
      session.soulToken({ ...fields, operationId: `op_${name.replaceAll(' ', '_')}` }),
      /does not match/, `${name} is refused`);
    srv.soulClaimsPatch = null;
  }
  // The top-level issuance_id must echo the claim's.
  srv.soulEchoPatch = { issuance_id: 'iss_forged' };
  await assert.rejects(session.soulToken({ ...fields, operationId: 'op_iss' }), /does not match/);
  srv.soulEchoPatch = null;
  // A missing-issuer claim set is refused too.
  srv.soulClaimsPatch = { iss: undefined };
  await assert.rejects(session.soulToken({ ...fields, operationId: 'op_noiss' }), /does not match/);
  srv.soulClaimsPatch = null;
});

test('the soul-token issuer comes from the service JWKS, never the deployment URL', async () => {
  const jwks = { issuer: 'https://agents.true-line.ai', keys: [] };
  const okFetch = async (url) => {
    assert.equal(url, 'https://agent-bot-gold.vercel.app/.well-known/agent-bot/soul-keys.json');
    return { ok: true, text: async () => JSON.stringify(jwks) };
  };
  assert.equal(
    await fetchSoulTokenIssuer({ base: 'https://agent-bot-gold.vercel.app', fetchImpl: okFetch }),
    'https://agents.true-line.ai');
  for (const [name, impl] of [
    ['a 503', async () => ({ ok: false, status: 503, text: async () => '' })],
    ['a fetch error', async () => { throw new Error('ECONNREFUSED'); }],
    ['a non-JSON body', async () => ({ ok: true, text: async () => 'not json' })],
    ['a foreign issuer', async () => ({ ok: true, text: async () => JSON.stringify({ issuer: 'http://plain.test' }) })],
    ['a path-bearing issuer', async () => ({ ok: true, text: async () => JSON.stringify({ issuer: 'https://x.test/p' }) })],
  ]) {
    await assert.rejects(fetchSoulTokenIssuer({ base: 'https://agent-bot-gold.vercel.app', fetchImpl: impl }),
      (error) => error.code === 'credential-unavailable', name);
  }
  await assert.rejects(fetchSoulTokenIssuer({ base: 'http://127.0.0.1:8787' }),
    (error) => error.code === 'credential-unavailable', 'http bases are refused outright');
});

test('revoked device surfaces invalid_grant with a re-enroll hint; logout wipes local state', async () => {
  const env = sandbox();
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  srv.devices.clear();
  await assert.rejects(new ServerSession({ base: BASE, env, fetchImpl: srv.fetch }).whoami(), /re-enroll/);
  logout({ env });
  assert.equal(loadDevice({ env }), null);
  assert.ok(!existsSync(statePaths({ env }).key));
});

test('CLI: enroll, status --json, logout', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, GROK_AGENT: '1' };
  const srv = fakeServer();
  const out = []; const err = [];
  const io = { env, fetchImpl: srv.fetch, sleep, out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } };
  assert.equal(await main(['enroll', '--json'], io), 0);
  assert.deepEqual(JSON.parse(out.pop()).harnesses, ['grok'], 'GROK_AGENT=1 picks the grok harness');
  assert.match(err.join(''), /ABCD-EFGH/);
  assert.equal(await main(['status', '--json'], io), 0);
  const st = JSON.parse(out.pop());
  assert.equal(st.ok, true);
  assert.equal(st.remote.management, 'managed');
  assert.equal(await main(['logout'], io), 0);
  assert.equal(await main(['status', '--json'], { ...io, env: { ...env, AGENT_BOT_SERVER: '' , AGENT_BOT_CONFIG: env.AGENT_BOT_CONFIG } }), 1);
  assert.match(err.pop(), /server mode is off/);
});

test('mint() in server mode never reads a local App key and refuses --permissions', async () => {
  const { mint } = await import('../mint-token.mjs');
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok', AGENT_BOT_SERVER_REPO: 'a/b' };
  await assert.rejects(mint({ env, permissions: { contents: 'read' } }), /not available in server mode/);
  await assert.rejects(mint({ env }), /not enrolled/);
});

test('AGENT_BOT_SERVER_HARNESS is normalized like --harness', async () => {
  const { ambientHarness } = await import('../identity/server-client.mjs');
  assert.equal(ambientHarness({ AGENT_BOT_SERVER_HARNESS: 'claude-code' }), 'claude');
});

test('a failed first signed check keeps the enrollment and marks it unverified', async () => {
  const env = sandbox();
  const srv = fakeServer({ tamper: true });
  const dev = await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  assert.equal(dev.verified, false);
  assert.match(dev.verify_error, /signature/);
  assert.equal(loadDevice({ env }).device_id, dev.device_id);
});

// Issuance lookup edge cases (#1204).
test('issuance lookup: a weird operation id is encoded safely, and unsigned or tampered answers are refused', async () => {
  const env = sandbox();
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  const out = await session.issuance('../weird op');
  assert.equal(out.state, 'none', 'the encoded id round-trips instead of throwing');
  srv.unsignedIssuances = true;
  await assert.rejects(session.issuance('op_x'), /signature|signed/, 'an unsigned answer is refused');
  const tamperSrv = fakeServer({ tamper: true });
  const env2 = sandbox();
  await enroll({ base: BASE, env: env2, harnesses: ['grok'], fetchImpl: tamperSrv.fetch, sleep });
  await assert.rejects(new ServerSession({ base: BASE, env: env2, fetchImpl: tamperSrv.fetch }).issuance('op_x'), /signature/);
});

test('issuance lookup: a signed but unparseable JSON answer is refused', async () => {
  const env = sandbox();
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  srv.garbageLookup = true;
  await assert.rejects(session.issuance('op_x'), /credential-unavailable|not JSON/);
});

test('issuance lookup: none settles a pending unknown as rejected; unknown stays unknown and is not retried', async () => {
  const env = sandbox();
  const srv = fakeServer();
  srv.outcomeUnknown = true;
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const op = 'op_settle';
  await assert.rejects(
    mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, operationId: op }),
    (error) => error.code === 'outcome-unknown');
  const stateDir = env.AGENT_BOT_SERVER_STATE;
  assert.equal(readAction(stateDir, op).state, 'unknown');
  // While the service still reports unknown, reconcile changes nothing and mints nothing.
  await reconcilePendingCredentials({ base: BASE, env, fetchImpl: srv.fetch });
  assert.equal(readAction(stateDir, op).state, 'unknown');
  const mints = srv.minted ?? 0;
  assert.equal(mints, 0, 'a pending unknown is never retried as a new mint');
  // Once the service reports none, the operation settles rejected.
  srv.unknownResolved = true;
  await reconcilePendingCredentials({ base: BASE, env, fetchImpl: srv.fetch });
  const settled = readAction(stateDir, op);
  assert.deepEqual([settled.state, settled.reason, settled.reconciled], ['rejected', 'reconciled-none', true]);
});

// Credential races (#1207).
test('revocation racing an in-flight mint: the late caller gets device-revoked and no token is cached afterwards', async () => {
  const env = sandbox();
  const srv = fakeServer();
  srv.holdCredentials = 60;
  srv.revokeOnConcurrentMint = true;
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  const opA = 'op_race_a';
  const first = session.credential({ harness: 'grok', repo: 'o/r', taskId: 't1', operationId: opA }).then((out) => ({ ok: true, out }), (error) => ({ ok: false, error }));
  await new Promise((r) => setTimeout(r, 30));
  const second = await session.credential({ harness: 'grok', repo: 'o/r', taskId: 't2', operationId: 'op_race_b' }).then((out) => ({ ok: true, out }), (error) => ({ ok: false, error }));
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'device-revoked');
  const done = await first;
  // The in-flight mint either issued before the revocation landed or failed
  // with the revoked code — never an unsettled caller.
  assert.ok(done.ok === false ? done.error.code === 'device-revoked' : typeof done.out.issuance_id === 'string');
  await assert.rejects(session.call('GET', '/api/daemon/whoami'), /device-revoked|revoked/, 'no cached access token survives the revocation');
  assert.equal(session.token, null, 'the cached access token is dropped');
  const calls = srv.lookups;
  // The revocation is persisted: a brand-new session over the same state
  // refuses locally on its first token request instead of asking the service.
  const fresh = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  await assert.rejects(fresh.accessToken(), (error) => error.code === 'device-revoked', 'a fresh session refuses a persisted revocation without a request');
  assert.equal(srv.lookups, calls, 'no network call was needed');
});

test('two callers racing one operation_id settle on one issuance, never two', async () => {
  const env = sandbox();
  const srv = fakeServer();
  srv.holdCredentials = 40;
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const session = new ServerSession({ base: BASE, env, fetchImpl: srv.fetch });
  const call = () => session.credential({ harness: 'grok', repo: 'o/r', taskId: 't1', operationId: 'op_same' }).then((out) => ({ ok: true, out }), (error) => ({ ok: false, error }));
  const [a, b] = await Promise.all([call(), call()]);
  const outcomes = [a, b];
  const issued = outcomes.filter((o) => o.ok).map((o) => o.out.issuance_id);
  const refused = outcomes.filter((o) => !o.ok).map((o) => o.error.code ?? o.error.message);
  // Exactly the allowed outcomes: both callers see the one issuance, or one
  // sees it and the loser is refused operation-conflict — never
  // device-revoked (nothing revoked) and never a second mint.
  assert.ok(issued.length >= 1, 'at least one caller got the credential');
  if (issued.length === 2) assert.equal(issued[0], issued[1], 'a replay returns the same issuance');
  for (const code of refused) assert.equal(code, 'operation-conflict', `only operation-conflict may refuse (got ${code})`);
  assert.equal(srv.minted, 1, 'the service minted exactly once');
});

test('a new operation for the same task waits on an unknown one, then settles', async () => {
  const env = sandbox();
  const srv = fakeServer();
  srv.outcomeUnknown = true;
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  await assert.rejects(
    mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 't1', operationId: 'op_a' }),
    (error) => error.code === 'outcome-unknown');
  const pending = mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 't1', operationId: 'op_b', sleep })
    .then((out) => ({ ok: true, out }), (error) => ({ ok: false, error }));
  // While op_a is unknown the task mints nothing else: no credential request
  // for op_b ever reaches the service — the caller is refused, not queued.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(srv.minted ?? 0, 0, 'nothing minted while the task outcome is unknown');
  assert.ok(!(srv.credentialOps ?? []).includes('op_b'), 'no credentials request went out for op_b');
  const second = await pending;
  assert.equal(second.ok, false, 'op_b is refused while the task outcome is unknown');
  assert.equal(second.error.code, 'outcome-unknown');
  // Once op_a settles, the same operation proceeds and mints exactly once.
  srv.unknownResolved = true;
  srv.outcomeUnknown = false; // the service is healthy again once the task settles
  await reconcilePendingCredentials({ base: BASE, env, fetchImpl: srv.fetch });
  const retry = await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env, fetchImpl: srv.fetch, taskId: 't1', operationId: 'op_b' });
  assert.match(retry.issuance_id, /^iss_/, 'op_b issued after the task settled');
  assert.ok((srv.credentialOps ?? []).includes('op_b'), 'op_b minted once the unknown operation settled');
  assert.equal(srv.minted, 1, 'one mint total: op_b after settle, never op_a twice');
});

// #1210: a response signed by a key other than the pinned one is refused —
// a server-key rotation requires re-enrollment; nothing is re-pinned.
test('a response signed by a different keypair is refused and the pin never moves (#1210)', async () => {
  const env = sandbox();
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], enrollToken: 'abe_good', fetchImpl: srv.fetch, sleep });
  const pinFile = join(env.AGENT_BOT_SERVER_STATE, 'server-key.json');
  assert.ok(existsSync(pinFile), 'enroll pinned a key');
  const before = readFileSync(pinFile);
  const evil = fakeServer();
  evil.devices = srv.devices; // the same enrolled device, but a different signing key
  const session = new ServerSession({ base: BASE, env, fetchImpl: evil.fetch });
  await assert.rejects(session.call('GET', '/api/daemon/whoami'), /signature/, 'a foreign-key signature is refused');
  assert.deepEqual(readFileSync(pinFile), before, 'the pinned key file is byte-identical — nothing re-pinned');
});

test('an explicit repo overrides the caller checkout in server-mode mint', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  const minted = await mint({ slug: 'qwts-grok-agent', env, fetchImpl: srv.fetch, repo: 'ov/erride', taskId: 'task_r', operationId: 'op_r' });
  assert.equal(minted.repo, 'ov/erride', 'the explicit repo wins over cwd resolution');
});

test('an explicit null repo fails closed in server mode instead of reading cwd', async () => {
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE, AGENT_BOT_SERVER_HARNESS: 'grok' };
  const srv = fakeServer();
  await enroll({ base: BASE, env, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  // The suite's own cwd is a checkout with an origin: a silent fallback
  // would mint; an explicit null must reach the server-mode refusal.
  await assert.rejects(
    mint({ slug: 'qwts-grok-agent', env, fetchImpl: srv.fetch, repo: null, taskId: 'task_n', operationId: 'op_n' }),
    /owner\/name/,
  );
});
test('notices: take/peek/ack/release through the signed session, filters and the take_inbox shim', async () => {
  const { createServerNotices, parseNoticesArgs, noticeQuery, harnessForApp, main: noticesMain } = await import('../identity/server-notices.mjs');
  const { createInboxTaker } = await import('../identity/inbox-take.mjs');
  const env = { ...sandbox(), AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env, enrollToken: 'abe_good', fetchImpl: srv.fetch, sleep });
  srv.notices = [
    { id: 'd1', kind: 'mention', repo: 'a/b', type: ['discussion', 'comment'], number: 1 },
    { id: 'd2', kind: 'issues.opened', repo: 'a/b', type: ['issue'], number: 2 },
    { id: 'd3', kind: 'pull_request.opened', repo: 'a/c', type: ['pr'], number: 3 },
  ];
  const n = createServerNotices({ env, fetchImpl: srv.fetch });
  assert.equal(n.enabled(), true);
  const t = await n.take({ count: 5, type: 'discussions' });
  assert.deepEqual(t.notices.map((x) => x.id), ['d1']);
  assert.equal(t.notices[0].lease, 'lease_1');
  assert.deepEqual(srv.noticeBodies.at(-1).body, { count: 5, type: 'discussions' });
  assert.equal((await n.peek({ repo: 'a/b' })).visible, 1);
  assert.equal(srv.noticeBodies.at(-1).method, 'GET');
  assert.deepEqual((await n.release({ ids: ['lease_1'] })).released, ['lease_1']);
  // A released notice leases again; ack then removes it.
  const retaken = await n.take({ count: 1 });
  assert.deepEqual((await n.ack({ ids: retaken.notices[0].lease })).acked, [retaken.notices[0].lease]);
  await assert.rejects(() => n.ack({ ids: [] }), /1\.\.100/);
  assert.throws(() => noticeQuery({ count: 99 }), /1\.\.50/);
  assert.deepEqual(noticeQuery({ type: ['pr', 'issue'], kind: 'mention' }), { type: 'pr,issue', kind: 'mention' });
  assert.deepEqual(parseNoticesArgs(['take', '--count', '5', '--type', 'discussion', '--type', 'pr']), { sub: 'take', ids: [], json: false, count: '5', type: 'discussion,pr' });
  assert.throws(() => parseNoticesArgs(['bogus']), /unknown notices command/);
  // A device may enroll App slugs themselves (the server keys Apps by slug):
  // a scope match uses the slug, else the slug's harness family, else refuse.
  assert.equal(harnessForApp('grok', { harnesses: ['grok', 'x'] }), 'grok');
  assert.equal(harnessForApp('qwts-claude-agent', { harnesses: ['qwts-devin-agent', 'qwts-claude-agent'] }, { env: {}, config: {} }), 'qwts-claude-agent');
  assert.equal(harnessForApp('qwts-codex-agent', { harnesses: ['codex', 'claude'] }, { env: {}, config: { apps: { codex: 'qwts-codex-agent' } } }), 'codex');
  assert.throws(
    () => harnessForApp('qwts-zebra-agent', { harnesses: ['a', 'b'] }, { env: {}, config: {} }),
    (error) => error.code === 'notices-no-harness',
  );
  // take_inbox shim: one notice for the repo, acked, legacy { event } shape
  const take = createInboxTaker({ env, serverNotices: n, readBearer: () => { throw new Error('bearer must not be read'); } });
  const r = await take({ app: 'grok', repo: 'a/c' });
  assert.equal(r.event.id, 'd3');
  assert.equal(r.event.lease, undefined);
  assert.ok(!srv.notices.some((x) => x.id === 'd3'), 'shim acks what it returns');
  assert.deepEqual(await take({ app: 'grok', repo: 'a/c' }), { event: null });
  // CLI
  let out = '';
  assert.equal(await noticesMain(['take', '--json'], { env, fetchImpl: srv.fetch, out: { write: (x) => { out += x; } }, err: { write: () => {} } }), 0);
  assert.deepEqual(JSON.parse(out).notices.map((x) => x.id), ['d2']);
});
