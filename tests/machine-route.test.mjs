// POST /v0/machine route coverage (#1254): the daemon fills attribution
// from the binding, refuses caller-stated mismatches, and binds replies
// to the request nonce. A fake agent-machine answers over a unix socket
// at the derived machineSocketPath inside a temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createDaemonServer } from '../agent-daemon.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { PROOF_HEADER, signBindingProof } from '../binding-proof.mjs';
import { machineSocketPath, pinDaemonPub } from '../machine-client.mjs';

const AGENT = 'agent_77777777-7777-4777-8777-777777777777';

async function daemon(t, { sessionId = 'ses_route1' } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'machine-route-'));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json') };
  upsertSoul({ id: AGENT, name: 'machine-route', status: 'active', spacePath: home }, { file: env.AGENT_BOT_POPULATION_PATH });
  const server = createDaemonServer({ env, home, config: {},
    ownerGate: async () => {}, settingGate: async () => {}, revisionPrincipal: async () => {} });
  const worktree = path.join(home, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  // Fake agent-machine at the socket path the daemon derives from HOME.
  const sockPath = machineSocketPath({ home });
  mkdirSync(path.dirname(sockPath), { recursive: true });
  const keypair = generateKeyPairSync('ed25519');
  const daemonPub = Buffer.from(keypair.publicKey.export({ format: 'jwk' }).x, 'base64url');
  writeFileSync(path.join(home, '.config', 'agent-machine', 'daemon.pub'), daemonPub);
  pinDaemonPub({ env, home });
  const received = [];
  const replies = [];
  const fake = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      received.push(req);
      const res = replies.shift() ?? { ok: true, state: 'ready', request_nonce: req.nonce };
      res.timestamp = Math.floor(Date.now() / 1000);
      res.nonce = 'REPLYNONCE0000000001';
      const body = res.body !== undefined ? JSON.stringify(res.body) : '';
      const payload = [String(res.ok), res.diagnostic ?? '', res.message ?? '', res.state ?? '', body, String(res.timestamp), res.nonce, res.request_nonce ?? ''].join('\n');
      res.signature = edSign(null, Buffer.from(payload), keypair.privateKey).toString('base64');
      conn.end(`${JSON.stringify(res)}\n`);
    });
  });
  await new Promise((resolve) => fake.listen(sockPath, resolve));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  server.bindings.rewrite(`http://127.0.0.1:${port}/`);
  const binding = server.bindings.bind({ agentId: AGENT, worktree, gitDir: path.join(worktree, '.git'), harness: 'codex', sessionId });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const call = (body, { proof = true } = {}) => fetch(`http://127.0.0.1:${port}/v0/machine`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      ...(proof ? { [PROOF_HEADER]: signBindingProof({ secret: binding, method: 'POST', path: '/v0/machine', authority: `127.0.0.1:${port}` }) } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { env, home, server, binding, received, replies, call };
}

const onPosix = process.platform !== 'win32' ? test : test.skip;

onPosix('POST /v0/machine: an unbound caller is refused before any socket call', async (t) => {
  const f = await daemon(t);
  const res = await f.call({ verb: 'status' }, { proof: false });
  assert.equal(res.status, 401);
  assert.equal(f.received.length, 0);
});

onPosix('POST /v0/machine: unknown body keys refuse with 400', async (t) => {
  const f = await daemon(t);
  const res = await f.call({ verb: 'status', bogus: true });
  assert.equal(res.status, 400);
  assert.equal(f.received.length, 0);
});

onPosix('POST /v0/machine: stated derived fields must match the binding', async (t) => {
  const f = await daemon(t);
  for (const field of [{ soul: 'agent_other' }, { harness: 'other' }, { session_id: 'other' }]) {
    const res = await f.call({ verb: 'status', ...field });
    assert.equal(res.status, 409, JSON.stringify(field));
    assert.match(JSON.stringify(res.body), /derived-field-mismatch/);
  }
  assert.equal(f.received.length, 0);
  const ok = await f.call({ verb: 'status', soul: AGENT, harness: 'codex', session_id: 'ses_route1' });
  assert.equal(ok.status, 200);
  assert.equal(f.received.length, 1);
});

onPosix('POST /v0/machine: the daemon fills soul, harness and session_id from the binding', async (t) => {
  const f = await daemon(t);
  const res = await f.call({ verb: 'plan', name: 'codex' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const sent = f.received[0];
  assert.equal(sent.verb, 'plan');
  assert.equal(sent.name, 'codex');
  assert.equal(sent.soul, AGENT);
  assert.equal(sent.harness, 'codex');
  assert.equal(sent.session_id, 'ses_route1');
  assert.ok(sent.signature && sent.public_key && sent.nonce);
});

onPosix('POST /v0/machine: session_id is omitted when the binding has none', async (t) => {
  const f = await daemon(t, { sessionId: null });
  const res = await f.call({ verb: 'status' });
  assert.equal(res.status, 200);
  assert.equal(f.received[0].session_id, undefined);
  assert.equal(f.received[0].soul, AGENT);
});

onPosix('POST /v0/machine: a reply signed for another nonce fails closed', async (t) => {
  const f = await daemon(t);
  f.replies.push({ ok: true, state: 'ready', request_nonce: 'STOLEN_NONCE_00000001' });
  const res = await f.call({ verb: 'status' });
  assert.notEqual(res.status, 200);
  assert.match(JSON.stringify(res.body), /machine-reply-unbound/);
});
