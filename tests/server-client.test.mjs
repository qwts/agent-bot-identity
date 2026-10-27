import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ServerSession, agentBotServerSetting, enroll, jwkThumbprint, loadDevice, logout, main, mintViaServer,
  parseServerArgs, serverHarness, serverUrl, signatureMessage, statePaths, validateServerUrl,
} from '../identity/server-client.mjs';
import { parseConfig } from '../config.mjs';

const BASE = 'https://agent-bot.test';

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
function fakeServer({ approveAfter = 1, tokenTtl = 900, tamper = false } = {}) {
  const sign = crypto.generateKeyPairSync('ed25519');
  const x = sign.publicKey.export({ format: 'jwk' }).x;
  const s = { devices: new Map(), tokens: new Map(), seenEk: new Set(), polls: 0, calls: [], issued: 0 };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const signed = (status, body, jti) => {
    const buf = Buffer.from(JSON.stringify(body));
    const sig = crypto.sign(null, Buffer.from(signatureMessage(status, tamper ? Buffer.from('x') : buf, jti)), sign.privateKey).toString('base64url');
    return new Response(buf, { status, headers: { 'agent-bot-signature': sig, 'agent-bot-request-jti': jti, 'agent-bot-key-id': 'kid1' } });
  };
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const f = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    s.calls.push(u.pathname);
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
      if (u.pathname === '/api/daemon/whoami') return signed(200, { device: { id: t.device, management: 'managed' } }, proof.payload.jti);
      if (u.pathname === '/api/daemon/installation-token') {
        const body = JSON.parse(init.body);
        if (!s.devices.get(t.device).harnesses.includes(body.harness)) return signed(403, { error: 'not scoped' }, proof.payload.jti);
        return signed(200, { token: 'ghs_fake', expires_at: '2026-10-27T23:00:00Z', repo: body.repo, git_author: 'qwts-grok-agent[bot] <1+qwts-grok-agent[bot]@users.noreply.github.com>' }, proof.payload.jti);
      }
    }
    return json(404, { error: 'not found' });
  };
  return s;
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-server-'));
  return { AGENT_BOT_SERVER_STATE: join(dir, 'server'), AGENT_BOT_CONFIG: join(dir, 'none.json'), HOME: dir };
}
const sleep = async () => {};

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
  assert.equal(minted.token, 'ghs_fake');
  assert.equal(minted.source, 'agent-bot-server');
  assert.match(minted.git_author, /qwts-grok-agent/);
  await assert.rejects(mintViaServer({ base: BASE, harness: 'codex', repo: 'a/b', env, fetchImpl: srv.fetch }), /403/);
  await assert.rejects(mintViaServer({ base: BASE, harness: 'grok', repo: null, env, fetchImpl: srv.fetch }), /owner\/name/);

  const evil = fakeServer({ tamper: true });
  evil.devices = srv.devices; // same devices, but a different (unpinned) signing key
  await assert.rejects(new ServerSession({ base: BASE, env, fetchImpl: evil.fetch }).whoami(), /signature is invalid/);
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
