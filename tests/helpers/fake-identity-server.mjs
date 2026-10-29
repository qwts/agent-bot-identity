// The fake signed agent-bot server shared by the daemon/identity test
// suites. A non-test module: importing it never registers tests (#1224 CI
// found test files re-registering subtests that were then cancelled).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwkThumbprint, signatureMessage } from '../../identity/server-client.mjs';

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

export const BASE = 'https://agent-bot.test';
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
      assert.equal(d.payload.aud, `${u.origin}${u.pathname}`);
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
      if (!dev || s.revokedDevice === d.payload.iss) return json(400, { error: 'device_revoked', error_description: 'device revoked' });
      verifyEs256(f.assertion, dev.jwk);
      assert.equal(d.payload.aud, `${u.origin}/oauth/token`);
      assert.ok(d.payload.exp - d.payload.iat <= 300);
      const ek = d.payload.cnf.jwk;
      assert.notEqual(jwkThumbprint(ek), jwkThumbprint(dev.jwk), 'ephemeral key differs from device key');
      assert.ok(!s.seenEk.has(jwkThumbprint(ek)), 'ephemeral key used once');
      s.seenEk.add(jwkThumbprint(ek));
      const tok = `at_${++s.issued}`;
      s.tokens.set(tok, { ek, device: d.payload.iss });
      return json(200, { access_token: tok, token_type: 'DPoP', expires_in: tokenTtl, device_id: d.payload.iss, management: 'managed' });
    }
    // SEP-3415 MCP events/poll: same DPoP device auth as /api/daemon/*, but
    // the answers are plain JSON-RPC — never agent-bot-signature'd.
    if (u.pathname === '/v1/events/sse') return s.sseFetch(url, init);
    if (u.pathname === '/mcp') {
      const tok = (init.headers.authorization ?? '').replace(/^DPoP /, '');
      const proof = decode(init.headers.dpop);
      if (s.mcp401NonJson) { s.mcp401NonJson = false; return new Response('forbidden', { status: 401, headers: { 'content-type': 'text/plain' } }); }
      if (s.mcpUnauth || !s.tokens.has(tok)) return json(401, { error: 'unauthenticated' });
      const t = s.tokens.get(tok);
      verifyEs256(init.headers.dpop, t.ek);
      assert.equal(proof.payload.htu, url);
      if (s.mcp5xx) return json(503, { error: 'unavailable' });
      const rpc = JSON.parse(init.body);
      assert.equal(init.headers['mcp-name'], rpc.params?.name);
      const rpcErr = (code, message) => json(200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });
      if (s.mcpRateLimit) return rpcErr(-32025, 'rate limit exceeded');
      const p = rpc.params ?? {};
      const harness = p.arguments?.harness;
      if (!s.devices.get(t.device).harnesses.includes(harness)) return rpcErr(-32024, 'Forbidden: harness not in device scope');
      if (rpc.method === 'events/edgeTicket') {
        s.ticketCalls = (s.ticketCalls ?? 0) + 1;
        if (s.noEdge) return rpcErr(-32026, 'Unsupported: edge push is not configured');
        s.relaySub = s.relaySub ?? 'sub1';
        const enc = (pos) => Buffer.from(`v1.${s.relaySub}.${pos}`).toString('base64url');
        s.tickets = s.tickets ?? new Map();
        if (p.cursor !== null && p.cursor !== undefined) {
          const m = /^v1\.([^.]+)\.(\d+)$/.exec(Buffer.from(String(p.cursor), 'base64url').toString('utf8'));
          if (!m) return rpcErr(-32602, 'malformed cursor');
          if (m[1] !== s.relaySub) return rpcErr(-32602, 'cursor belongs to a different subscription');
        }
        const ticket = `tkt_${s.ticketCalls}`;
        s.tickets.set(ticket, { harness });
        return json(200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ticket, expiresAt: new Date(Date.now() + (s.ticketTtlMs ?? 600000)).toISOString(), cursor: enc((s.relay ?? []).length), truncated: false, ticketMethod: 'GET', websocket: 'wss://events.test/ws', sse: s.sseUrl ?? `${u.origin}/v1/events/sse`, docs: 'https://events.test/docs' } });
      }
      if (rpc.method !== 'events/poll') return rpcErr(-32601, `no such method ${rpc.method}`);
      s.relay = s.relay ?? [];
      s.relaySub = s.relaySub ?? 'sub1';
      const enc = (pos) => Buffer.from(`v1.${s.relaySub}.${pos}`).toString('base64url');
      // Stamp per-event cursors on enqueue order, once.
      s.relay.forEach((ev, i) => { ev.cursor = ev.cursor ?? enc(i + 1); });
      s.cursorLog = (s.cursorLog ?? []).concat(p.cursor ?? null);
      let start = s.relay.length; // cursor null: arm at the head, no events
      if (p.cursor !== null && p.cursor !== undefined) {
        const m = /^v1\.([^.]+)\.(\d+)$/.exec(Buffer.from(String(p.cursor), 'base64url').toString('utf8'));
        if (!m) return rpcErr(-32602, 'malformed cursor');
        if (m[1] !== s.relaySub) return rpcErr(-32602, 'cursor belongs to a different subscription');
        start = Number(m[2]);
      }
      const max = Math.max(Number(p.maxEvents ?? 1), 0);
      const events = s.relay.slice(start, start + max);
      const hasMore = s.relay.length > start + events.length;
      return json(200, { jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', events, cursor: enc(s.relay.length), truncated: Boolean(s.mcpTruncated), hasMore, nextPollMs: s.nextPollMs ?? 10 } });
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
      if (u.pathname === '/api/daemon/notices' || u.pathname.startsWith('/api/daemon/notices/')) {
        s.noticeBodies = s.noticeBodies ?? [];
        s.noticeBodies.push({ method: init.method ?? 'GET', path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : null });
      }
      if (u.pathname === '/api/daemon/notices' && (init.method ?? 'GET') === 'GET') {
        const repo = u.searchParams.get('repo');
        const type = u.searchParams.get('type');
        const visible = (s.notices ?? []).filter((notice) => (!repo || notice.repo === repo)
          && (!type || type.split(',').some((t) => notice.type.includes(t.replace(/s$/, ''))))).length;
        return signed(200, { notices: [], visible }, proof.payload.jti);
      }
      if (u.pathname === '/api/daemon/notices/take') {
        const body = JSON.parse(init.body);
        if (s.signedUnavailable) return signed(503, { error: 'credential_unavailable', retryable: true }, proof.payload.jti);
        s.notices = s.notices ?? [];
        s.leased = s.leased ?? new Map();
        s.issuedLeases = s.issuedLeases ?? new Set();
        s.nextLease = s.nextLease ?? 0;
        // Hold the request until a notice lands or the wait lapses — capped
        // so the suite stays fast while long-poll semantics are exercised.
        const cap = Math.min((body.wait_seconds ?? 0) * 1000, s.noticeHoldCap ?? 250);
        const start = Date.now();
        const matches = (notice) => (!body.repo || notice.repo === body.repo)
          && (!body.type || body.type.split(',').some((t) => notice.type.includes(t.replace(/s$/, ''))));
        while (!s.notices.some(matches) && Date.now() - start < cap) await new Promise((r) => setTimeout(r, 15));
        const take = s.notices.filter(matches).slice(0, body.count ?? 10).map((notice) => {
          s.notices.splice(s.notices.indexOf(notice), 1);
          const lease = `lease_${++s.nextLease}`;
          const leased = { ...notice, lease };
          s.leased.set(lease, leased);
          s.issuedLeases.add(lease);
          return leased;
        });
        return signed(200, { notices: take }, proof.payload.jti);
      }
      if (u.pathname === '/api/daemon/notices/ack' || u.pathname === '/api/daemon/notices/release') {
        const body = JSON.parse(init.body);
        if (s.signedUnavailable) return signed(503, { error: 'credential_unavailable', retryable: true }, proof.payload.jti);
        const done = [];
        const stale = [];
        const missing = [];
        for (const lease of body.ids ?? []) {
          if (s.leased?.has(lease)) {
            if (u.pathname.endsWith('/release')) s.notices.unshift(s.leased.get(lease));
            s.leased.delete(lease);
            done.push(lease);
          } else if (s.issuedLeases?.has(lease)) stale.push(lease);
          else missing.push(lease);
        }
        return signed(200, { [u.pathname.endsWith('/ack') ? 'acked' : 'released']: done, stale, missing }, proof.payload.jti);
      }
      if (u.pathname === '/api/daemon/replies') {
        const body = JSON.parse(init.body);
        if (s.signedUnavailable) return signed(503, { error: 'credential_unavailable', retryable: true }, proof.payload.jti);
        s.replies = s.replies ?? new Map();
        if (s.replyRateLimit) return signed(429, { error: 'rate_limited', retryable: true }, proof.payload.jti);
        if (s.replyStale) return signed(403, { error: 'recipient_stale' }, proof.payload.jti);
        const prior = s.replies.get(body.key);
        if (prior) {
          const same = prior.to === body.to && prior.body === body.body && (prior.correlation ?? null) === (body.correlation ?? null) && (prior.reply_to ?? null) === (body.reply_to ?? null);
          if (!same) return signed(409, { error: 'operation_conflict' }, proof.payload.jti);
          return signed(200, { id: prior.id, replayed: true }, proof.payload.jti);
        }
        const reply = { id: `rep_${s.replies.size + 1}`, to: body.to, key: body.key, body: body.body, correlation: body.correlation ?? null, reply_to: body.reply_to ?? null };
        s.replies.set(body.key, reply);
        return signed(201, { id: reply.id, replayed: false }, proof.payload.jti);
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
  // Scriptable edge SSE: (url, init) -> Response streaming
  // notifications from s.sseScript = [{method, params}]. s.sseStatus fails
  // before the stream; bad tickets -> 401 invalid_ticket; s.sseAbort ends it.
  s.sseFetch = async (url, init = {}) => {
    const tok = (init.headers?.authorization ?? '').replace(/^Bearer /, '');
    if (s.sseStatus && s.sseStatus !== 200) return new Response(JSON.stringify({ error: 'edge unavailable' }), { status: s.sseStatus });
    if (!s.tickets?.has(tok)) return new Response(JSON.stringify({ error: 'invalid_ticket' }), { status: 401, headers: { 'content-type': 'application/json' } });
    s.sseOpened = (s.sseOpened ?? 0) + 1;
    const script = s.sseScript ?? [];
    const stream = new ReadableStream({
      async start(ctl) {
        init.signal?.addEventListener('abort', () => { try { ctl.close(); } catch { /* closed */ } });
        for (const frame of script) {
          const data = JSON.stringify({ jsonrpc: '2.0', method: frame.method, params: frame.params });
          try { ctl.enqueue(Buffer.from(`event: message\ndata: ${data}\n\n`)); } catch { return; }
          await new Promise((r) => { setTimeout(r, frame.delayMs ?? 0); });
        }
        if (!s.sseHold) { try { ctl.close(); } catch { /* closed */ } }
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return s;
}

export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-server-'));
  return { AGENT_BOT_SERVER_STATE: join(dir, 'server'), AGENT_BOT_CONFIG: join(dir, 'none.json'), HOME: dir };
}
export const sleep = async () => {};
