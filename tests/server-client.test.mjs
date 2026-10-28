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
import { readAction } from '../identity/action-ledger.mjs';

export const BASE = 'https://agent-bot.test';

function decode(jws) {
  const [h, p, s] = jws.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), input: `${h}.${p}`, sig: Buffer.from(s, 'base64url') };
}
function verifyEs256(jws, jwk) {
  const d = decode(jws);
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(d.input), { key, dsaEncoding: 'ieee-p1363' }, d.sig), 'ES256 signature');
  return d;
}

// A fake agent-bot server that checks the wire format the Go server enforces.
export function fakeServer({ approveAfter = 1, tokenTtl = 900, tamper = false } = {}) {
  const sign = crypto.generateKeyPairSync('ed25519');
  const x = sign.publicKey.export({ format: 'jwk' }).x;
  const s = { devices: new Map(), tokens: new Map(), seenEk: new Set(), polls: 0, calls: [], issued: 0 };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const signed = (status, body, jti) => {
    const buf = Buffer.from(JSON.stringify(body));
    const sig = crypto.sign(null, Buffer.from(signatureMessage(status, tamper ? Buffer.from('x') : buf, jti)), sign.privateKey).toString('base64url');
    return new Response(buf, { status, headers: { 'agent-bot-signature': sig, 'agent-bot-request-jti': jti, 'agent-bot-key-id': 'kid1' } });
  };
  s.ops = new Map();
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (s.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (s.unsigned5xx && u.pathname.startsWith('/api/daemon/')) return json(503, { error: 'Service Unavailable' });
    const f = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    s.calls.push(u.pathname);
    assert.equal(init.redirect, 'error', `${u.pathname} must not follow redirects`);
    if (u.pathname === '/.well-known/agent-bot/soul-keys.json') {
      s.soulSign = s.soulSign ?? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const { x: jx, y: jy } = s.soulSign.publicKey.export({ format: 'jwk' });
      return json(200, { issuer: s.jwksIssuer ?? BASE, keys: [{ kty: 'EC', crv: s.jwksCrv ?? 'P-256', x: jx, y: jy, alg: s.jwksAlg ?? 'ES256', use: 'sig', kid: 'sk1' }] });
    }
    if (u.pathname === '/.well-known/agent-bot-server-key') return json(200, { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'kid1', x }] });
    if (u.pathname === '/oauth/device_authorization' || u.pathname === '/oauth/device_enroll') {
      const d = decode(f.proof);
      assert.equal(d.header.typ, 'ab-enroll+jwt');
      assert.equal(d.payload.aud, `${BASE}${u.pathname}`);
      verifyEs256(f.proof, d.header.jwk);
      const id = `dev_${s.devices.size + 1}`;
      if (u.pathname === '/oauth/device_enroll') {
        if (f.enrollment_token !== 'abe_good') return json(400, { error: 'invalid_grant', error_description: 'bad token' });
        s.devices.set(id, { jwk: d.header.jwk, harnesses: ['grok'] });
        return json(200, { device_id: id, ephemeral: true, expires_at: '2026-10-28T00:00:00Z', harnesses: ['grok'], read_only: false });
      }
      s.pending = { id, jwk: d.header.jwk, harnesses: f.harnesses.split(' ') };
      return json(200, { device_code: 'dc1', user_code: 'ABCD-EFGH', verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?user_code=ABCD-EFGH`, expires_in: 600, interval: 5 });
    }
    if (u.pathname === '/oauth/token' && f.grant_type.endsWith('device_code')) {
      s.polls += 1;
      if (s.polls === 1) return json(400, { error: 'slow_down' });
      if (s.polls <= approveAfter) return json(400, { error: 'authorization_pending' });
      s.devices.set(s.pending.id, s.pending);
      return json(200, { token_type: 'N_A', device_id: s.pending.id, harnesses: s.pending.harnesses, read_only: false, jkt: jwkThumbprint(s.pending.jwk) });
    }
    if (u.pathname === '/oauth/token' && f.grant_type.endsWith('jwt-bearer')) {
      const d = decode(f.assertion);
      const dev = s.devices.get(d.payload.iss);
      if (!dev) return json(400, { error: 'invalid_grant', error_description: 'device revoked' });
      verifyEs256(f.assertion, dev.jwk);
      assert.equal(d.payload.aud, `${BASE}/oauth/token`);
      assert.ok(d.payload.exp - d.payload.iat <= 300);
      const ek = d.payload.cnf.jwk;
      assert.notEqual(jwkThumbprint(ek), jwkThumbprint(dev.jwk), 'ephemeral key differs from device key');
      assert.ok(!s.seenEk.has(jwkThumbprint(ek)), 'ephemeral key used once');
      s.seenEk.add(jwkThumbprint(ek));
      const tok = `at_${++s.issued}`;
      s.tokens.set(tok, { ek, device: d.payload.iss });
      return json(200, { access_token: tok, token_type: 'DPoP', expires_in: tokenTtl, device_id: d.payload.iss, management: 'managed' });
    }
    if (u.pathname.startsWith('/api/daemon/')) {
      const tok = (init.headers.authorization ?? '').replace(/^DPoP /, '');
      const proof = decode(init.headers.dpop);
      if (!s.tokens.has(tok) || s.expireNext) { s.expireNext = false; return signed(401, { error: 'expired' }, proof.payload.jti); }
      const t = s.tokens.get(tok);
      verifyEs256(init.headers.dpop, t.ek);
      assert.equal(proof.header.typ, 'dpop+jwt');
      assert.equal(proof.payload.htm, init.method);
      assert.equal(proof.payload.htu, url);
      assert.equal(proof.payload.ath, crypto.createHash('sha256').update(tok).digest('base64url'));
      if (s.revokedDevice === t.device) return signed(401, { error: 'device_revoked' }, proof.payload.jti);
      if (u.pathname === '/api/daemon/whoami') return signed(200, { device: { id: t.device, management: 'managed' } }, proof.payload.jti);
      if (u.pathname === '/api/daemon/device' && init.method === 'DELETE') { s.revokedDevice = t.device; return signed(200, { revoked: true }, proof.payload.jti); }
      if (u.pathname === '/api/daemon/provider-key') {
        if (s.providerMissing) return signed(404, { error: 'provider_key_not_configured' }, proof.payload.jti);
        const op = new URL(url).searchParams.get('operation_id');
        return signed(200, { provider: 'openai', key: 'sk-e2e-fake-key-material', key_id: 'pk_e2e', expires_at: '2099-01-01T00:00:00Z', issuance_id: 'iss_pk_e2e', task_id: null, operation_id: op }, proof.payload.jti);
      }
      if (u.pathname === '/api/daemon/credentials') {
        const body = JSON.parse(init.body);
        s.credentialOps = (s.credentialOps ?? []).concat(body.operation_id);
        s.inFlight = s.inFlight ?? 0;
        if (s.revokeOnConcurrentMint && s.inFlight > 0) { s.revokedDevice = t.device; return signed(401, { error: 'device_revoked' }, proof.payload.jti); }
        s.inFlight += 1;
        if (s.holdCredentials) await new Promise((r) => setTimeout(r, s.holdCredentials));
        s.inFlight -= 1;
        s.lastCredential = body;
        if (s.signedUnavailable) return signed(503, { error: 'credential_unavailable', retryable: true }, proof.payload.jti);
        if (s.describeError && body.harness === 'grok') return signed(400, s.describeError, proof.payload.jti);
        if (!s.devices.get(t.device).harnesses.includes(body.harness)) return signed(403, { error: 'not scoped' }, proof.payload.jti);
        const prior = s.ops.get(body.operation_id);
        if (prior && (prior.task_id !== body.task_id || prior.repo !== body.repo)) return signed(409, { error: 'operation_conflict' }, proof.payload.jti);
        if (s.githubBase && !prior) {
          // Emulates the service's GitHub-App proxy path (true-line/agent-bot#38):
          // a mint is proxied to the configured GitHub base; its 5xx maps to
          // credential_unavailable, a 502 after the mint leaves the outcome
          // unknown, and a task with an unknown mint refuses new operations.
          if (s.unknownOps?.has(body.operation_id)) return signed(503, { error: 'outcome_unknown', retryable: false, operation_id: body.operation_id }, proof.payload.jti);
          if (s.unknownTasks?.has(body.task_id)) return signed(409, { error: 'operation_conflict' }, proof.payload.jti);
          let gh;
          try {
            gh = await fetch(`${s.githubBase}/app/installations/1/access_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          } catch {
            return signed(503, { error: 'credential_unavailable', retryable: true }, proof.payload.jti);
          }
          if (gh.status >= 500) {
            if (gh.status === 502 && s.github502Unavailable) return signed(503, { error: 'credential_unavailable', retryable: true }, proof.payload.jti);
            if (gh.status === 502) {
              s.unknownOps = (s.unknownOps ?? new Set()).add(body.operation_id);
              s.unknownTasks = (s.unknownTasks ?? new Set()).add(body.task_id);
              return signed(503, { error: 'outcome_unknown', retryable: false, operation_id: body.operation_id }, proof.payload.jti);
            }
            return signed(503, { error: 'credential_unavailable', retryable: true }, proof.payload.jti);
          }
          const ghBody = await gh.json().catch(() => ({}));
          const issued = { issuance_id: `iss_${s.ops.size + 1}`, task_id: body.task_id, operation_id: body.operation_id, repo: body.repo, token: ghBody.token ?? `ghs_op${s.ops.size + 1}` };
          s.minted = (s.minted ?? 0) + 1;
          s.ops.set(body.operation_id, issued);
          return signed(201, { ...issued, expires_at: ghBody.expires_at ?? '2026-10-27T23:00:00Z', profile: body.profile, replayed: false, git_author: 'qwts-grok-agent[bot] <1+qwts-grok-agent[bot]@users.noreply.github.com>' }, proof.payload.jti);
        }
        if (s.outcomeUnknown) {
          s.unknownOps = (s.unknownOps ?? new Set()).add(body.operation_id);
          return signed(503, { error: 'outcome_unknown', retryable: false, operation_id: body.operation_id }, proof.payload.jti);
        }
        const issued = prior ?? { issuance_id: `iss_${s.ops.size + 1}`, task_id: body.task_id, operation_id: body.operation_id, repo: body.repo, token: `ghs_op${s.ops.size + 1}` };
        if (!prior) s.minted = (s.minted ?? 0) + 1;
        s.ops.set(body.operation_id, issued);
        if (s.dropAfterMint) { s.dropAfterMint = false; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }
        const echo = s.badEcho ? { ...issued, operation_id: 'op_other' } : issued;
        return signed(prior ? 200 : 201, { ...echo, expires_at: '2026-10-27T23:00:00Z', profile: body.profile, replayed: Boolean(prior), git_author: 'qwts-grok-agent[bot] <1+qwts-grok-agent[bot]@users.noreply.github.com>' }, proof.payload.jti);
      }
      if (u.pathname.startsWith('/api/daemon/issuances/')) {
        const op = decodeURIComponent(u.pathname.split('/').at(-1));
        if (s.unsignedIssuances) return json(200, { operation_id: op, state: 'none' });
        if (s.garbageLookup) {
          const buf = Buffer.from('not json{{{');
          const sig = crypto.sign(null, Buffer.from(signatureMessage(200, buf, proof.payload.jti)), sign.privateKey).toString('base64url');
          return new Response(buf, { status: 200, headers: { 'agent-bot-signature': sig, 'agent-bot-request-jti': proof.payload.jti, 'agent-bot-key-id': 'kid1' } });
        }
        s.lookups = (s.lookups ?? 0) + 1;
        if (s.unknownOps?.has(op)) return signed(200, { operation_id: op, state: s.unknownResolved ? 'none' : 'unknown', expires_at: '2026-10-28T03:00:00Z' }, proof.payload.jti);
        const issued = s.ops.get(op);
        if (issued && s.conflictOnReplay) issued.repo = 'expired/elsewhere'; // the stored token is gone: a replay conflicts
        return signed(200, issued ? { operation_id: op, state: 'issued', issuance_id: issued.issuance_id, task_id: issued.task_id, expires_at: s.lookupExpiresAt ?? '2099-01-01T00:00:00Z' } : { operation_id: op, state: 'none' }, proof.payload.jti);
      }
      if (u.pathname === '/api/daemon/soul-token') {
        const body = JSON.parse(init.body);
        s.lastSoulToken = body;
        if (s.soulSigningDown) return signed(503, { error: 'soul_signing_key_unavailable', retryable: false }, proof.payload.jti);
        if (s.boundElsewhere) return signed(403, { error: 'agent_bound_elsewhere' }, proof.payload.jti);
        s.soulOps = s.soulOps ?? new Map();
        const prior = s.soulOps.get(body.operation_id);
        if (prior && (prior.task_id !== body.task_id || prior.agent_id !== body.agent_id)) return signed(409, { error: 'operation_conflict' }, proof.payload.jti);
        s.soulSign = s.soulSign ?? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const iat = 1_760_000_000;
        const claims = prior?.claims ?? {
          v: 2, iss: BASE, aud: 'agent-comms', sub: body.agent_id, account: body.account, parent: body.parent,
          device: s.soulDevice ?? t.device, task_id: body.task_id, operation_id: body.operation_id,
          issuance_id: `iss_soul${s.soulOps.size + 1}`, iat, nbf: iat, exp: iat + (s.soulLife ?? 300), jti: `sjti_${s.soulOps.size + 1}`,
        };
        const token = prior?.token ?? (() => {
          const input = `${Buffer.from(JSON.stringify({ alg: s.soulAlg ?? 'ES256', typ: 'soul+jwt', kid: 'sk1' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
          return `${input}.${crypto.sign('sha256', Buffer.from(input), { key: s.soulSign.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
        })();
        const issued = prior ?? { agent_id: body.agent_id, task_id: body.task_id, operation_id: body.operation_id, token, claims, issuance_id: claims.issuance_id };
        if (!prior) s.soulOps.set(body.operation_id, issued);
        let echo = s.badSoulEcho ? { ...issued, claims: { ...claims, sub: 'agent_other' }, operation_id: 'op_other' } : issued;
        if (s.soulClaimsPatch) echo = { ...echo, claims: { ...echo.claims, ...s.soulClaimsPatch } };
        if (s.soulEchoPatch) echo = { ...echo, ...s.soulEchoPatch };
        return signed(prior ? 200 : 201, {
          token: echo.token, expires_at: '2026-10-27T23:05:00Z', kid: 'sk1', issuance_id: echo.issuance_id,
          task_id: echo.task_id, operation_id: echo.operation_id, jti: claims.jti, claims: echo.claims, replayed: Boolean(prior),
        }, proof.payload.jti);
      }
      if (u.pathname === '/api/daemon/installation-token') {
        if (s.legacyDisabled) return signed(410, { error: 'legacy_route_disabled' }, proof.payload.jti);
        const body = JSON.parse(init.body);
        if (!s.devices.get(t.device).harnesses.includes(body.harness)) return signed(403, { error: 'not scoped' }, proof.payload.jti);
        return signed(200, { token: 'ghs_fake', expires_at: '2026-10-27T23:00:00Z', repo: body.repo, git_author: 'qwts-grok-agent[bot] <1+qwts-grok-agent[bot]@users.noreply.github.com>' }, proof.payload.jti);
      }
    }
    return json(404, { error: 'not found' });
  };
  return s;
}

export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-server-'));
  return { AGENT_BOT_SERVER_STATE: join(dir, 'server'), AGENT_BOT_CONFIG: join(dir, 'none.json'), HOME: dir };
}
export const sleep = async () => {};

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
