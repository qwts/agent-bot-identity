// The secret-shape registry (#1202): receipts, logs and diagnostics must
// never contain these values. The same file drives the sweep — every shape
// is planted into the inputs of every writer reachable in-process and the
// files it writes are checked afterwards.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { mintBindToken } from '../agent-binding.mjs';
import { ensureAgentIdentity } from '../agent-identity.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { diagnosticEvent } from '../diagnostics.mjs';
import { redactDiagnostic, REDACTED } from '../diagnostic-redact.mjs';
import { brokeredProviderEnv, dropProviderKey, fetchProviderKey, startInferenceProxy, stopInferenceProxy } from '../identity/provider-key.mjs';
import { ServerSession, enroll, mintViaServer, reconcilePendingCredentials } from '../identity/server-client.mjs';
// The signed fake identity service is shared with the server-client suite
// (#1202); importing it runs that suite's tests as well.
import { BASE, fakeServer, sandbox, sleep } from './helpers/fake-identity-server.mjs';

const REGISTRY = JSON.parse(readFileSync(new URL('../governance/redaction-patterns.json', import.meta.url), 'utf8'));

const SAMPLES = {
  'github-installation-token': ['ghs_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9StUv', 'ghs_short'],
  'github-oauth-token': ['gho_Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed', 'gho_x'],
  'github-user-token': ['ghu_Qw9Er8Ty7Ui6Op5As4Df3Gh2Jk1Lz0x', 'ghu_x'],
  'github-personal-token': ['ghp_Mn8Bv7Cx6Za5Sd4Fg3Hj2Kl1Po0Iu9', 'ghp_x'],
  'github-fine-grained-token': ['github_pat_11Ab2Cd3_Ef4Gh5Ij6Kl7Mn8Op9', 'github_pat_x'],
  'provider-api-key': ['sk-Pr0v1d3r-K3y_C4n4ry98Zb7Xw6Vq', 'sk-x'],
  'inference-proxy-token': [`abp_${'a1'.repeat(24)}`, 'abp_tooshort'],
  jwt: [`eyJ${'Aa'.repeat(12)}.${'Bb'.repeat(12)}.${'Cc'.repeat(12)}`, 'eyJhbGc.x.y'],
  'bearer-credential': [`Bearer ${'Dd3.'.repeat(8)}`, 'Bearer x'],
};

test('the shipped runtime copy of the registry cannot drift from the governance document', async () => {
  const { REDACTION_PATTERNS } = await import('../identity/redaction-patterns.mjs');
  assert.deepEqual(REDACTION_PATTERNS, REGISTRY.patterns, 'identity/redaction-patterns.mjs must mirror governance/redaction-patterns.json');
  assert.ok(Object.isFrozen(REDACTION_PATTERNS) && REDACTION_PATTERNS.every((row) => Object.isFrozen(row)), 'the shipped list is immutable');
});

test('the registry is schema-clean and RE2-safe', () => {
  assert.deepEqual(Object.keys(REGISTRY).sort(), ['description', 'patterns', 'schema_version']);
  assert.equal(REGISTRY.schema_version, 1);
  const ids = new Set();
  for (const pattern of REGISTRY.patterns) {
    assert.deepEqual(Object.keys(pattern).sort(), ['id', 'regex']);
    assert.match(pattern.id, /^[a-z0-9-]+$/, 'the Go side wants plain ids');
    assert.ok(!ids.has(pattern.id), `duplicate id ${pattern.id}`);
    ids.add(pattern.id);
    // RE2 has no lookarounds or backrefs; the decoded regex must not use them.
    assert.doesNotMatch(pattern.regex, /\(\?[=!<]/, `lookaround in ${pattern.id}`);
    assert.doesNotMatch(pattern.regex, /\\[1-9]/, `backreference in ${pattern.id}`);
    assert.doesNotThrow(() => new RegExp(pattern.regex), pattern.id);
    const [positive, negative] = SAMPLES[pattern.id];
    assert.match(positive, new RegExp(pattern.regex), `${pattern.id} positive`);
    assert.doesNotMatch(negative, new RegExp(pattern.regex), `${pattern.id} negative`);
    // Every pattern starts at a word boundary, so ordinary identifiers that
    // merely contain a prefix (task-…, mask-…, debearer …) never match.
    assert.ok(pattern.regex.startsWith('\\b'), `${pattern.id} starts at a word boundary`);
  }
  for (const benign of ['task-0123456789abcdefghij', 'mask-0123456789abcdefghij', 'xghs_0123456789abcdefghij', 'notabearer 0123456789abcdefghij']) {
    assert.ok(!REGISTRY.patterns.some((p) => new RegExp(p.regex).test(benign)), `${benign} is not a secret`);
  }
  assert.deepEqual(new Set(REGISTRY.patterns.map((p) => p.id)), new Set(Object.keys(SAMPLES)), 'a sample pair per pattern');
});

test('the diagnostic redactor catches every registered shape', () => {
  for (const { id } of REGISTRY.patterns) {
    const [sample] = SAMPLES[id];
    const out = redactDiagnostic(`leaked: ${sample} end`, { env: {}, home: '/nonexistent' });
    assert.ok(!out.includes(sample), `${id} survives redaction`);
    assert.ok(out.includes(REDACTED), id);
  }
});

// ---- the sweep ----

const roots = [];
const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';

after(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratchEnv() {
  const root = mkdtempSync(path.join(tmpdir(), 'redaction-sweep-'));
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

function mintWorktreeToken(env, root) {
  const identity = ensureAgentIdentity({
    gate: () => true,
    appSlug: 'you-codex-agent',
    botUid: '308462948',
    harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-sweep' },
    stateDir: stateDirectory({ env, home: '/nonexistent' }),
    idFactory: () => AGENT_ID,
    now: () => new Date('2026-08-12T08:00:00.000Z'),
  });
  const worktree = path.join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  execFileSync('git', ['init', '-q', worktree]);
  const gitDir = path.join(worktree, '.git');
  const record = mintBindToken({ gitDir, worktree, agentId: identity.id });
  return { identity, gitDir, record };
}

function* everyFile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* everyFile(file);
    else if (entry.isFile()) yield file;
  }
}

test('no writer reachable in-process lets a secret shape reach a file (#1202)', async () => {
  const { root, env } = scratchEnv();
  env.AGENT_BOT_SERVER = 'https://agent-bot.test';
  env.AGENT_BOT_SERVER_STATE = path.join(root, 'server');
  env.AGENT_BOT_SOUL_TOKENS = 'v2';
  mkdirSync(env.AGENT_BOT_SERVER_STATE, { recursive: true });
  writeFileSync(path.join(env.AGENT_BOT_SERVER_STATE, 'device.json'), JSON.stringify({ device_id: 'dev_1', server: env.AGENT_BOT_SERVER }));
  writeFileSync(path.join(env.AGENT_BOT_SERVER_STATE, 'soul-token-issuer.json'), JSON.stringify({ issuer: 'https://agent-bot.test' }));
  const { gitDir, record } = mintWorktreeToken(env, root);

  // Every registered shape, planted where a secret legitimately flows.
  const CANARY = Object.fromEntries(REGISTRY.patterns.map((p) => [p.id, SAMPLES[p.id][0]]));

  // 1. /v0/credential and /v0/vouch (v1 and v2) through the real daemon.
  let mode = 'mint';
  const server = createDaemonServer({
    env, home: '/nonexistent', config: { features: { 'github-identity': true } },
    mintImpl: async () => {
      if (mode === 'deny') {
        throw Object.assign(
          new Error(`upstream said no: ${CANARY['github-oauth-token']} ${CANARY['github-user-token']} ${CANARY['github-personal-token']} ${CANARY['github-fine-grained-token']} ${CANARY['bearer-credential']}`),
          { code: 'credential-unavailable' });
      }
      return { token: CANARY['github-installation-token'], expires_at: '2027-01-01T00:00:00Z', issuance_id: 'iss_c1' };
    },
    soulTokenImpl: async () => {
      if (mode === 'vouch-deny') throw Object.assign(new Error(`signed answer: ${CANARY['bearer-credential']}`), { code: 'credential-unavailable' });
      return { token: CANARY.jwt, issuance_id: 'iss_s1', claims: { v: 2, iss: 'https://agent-bot.test', sub: AGENT_ID, exp: 1_760_000_300 } };
    },
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    const call = (pathname, { method = 'GET', body, token = server.token, headers = {} } = {}) =>
      fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const bound = await (await call('/v0/bind', { method: 'POST', body: { gitDir, token: record.token, transcript: { provider: 'codex', id: 'thread-sweep' } } })).json();
    const binding = { 'x-agent-binding': bound.secret };
    assert.equal((await call('/v0/credential', { method: 'POST', body: {}, headers: binding })).status, 200);
    mode = 'deny';
    assert.equal((await call('/v0/credential', { method: 'POST', body: {}, headers: binding })).status, 503);
    mode = 'vouch';
    assert.equal((await call('/v0/vouch', { method: 'POST', token: null, body: { aud: 'agent-comms' }, headers: binding })).status, 200);
    mode = 'vouch-deny';
    assert.equal((await call('/v0/vouch', { method: 'POST', token: null, body: { aud: 'agent-comms' }, headers: binding })).status, 503);
    mode = 'mint';
    // v1 signing path under the same receipts: the opt-in flips off.
    env.AGENT_BOT_SOUL_TOKENS = 'v1';
    assert.equal((await call('/v0/vouch', { method: 'POST', token: null, body: { aud: 'agent-comms' }, headers: binding })).status, 200);
    env.AGENT_BOT_SOUL_TOKENS = 'v2';
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 2. Server-client mint + reconcile through the signed fake service:
  //    operation records and ledger files land under its state dir.
  const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'redaction-sweep-server-'));
  roots.push(sandboxRoot);
  const senv = { AGENT_BOT_SERVER_STATE: path.join(sandboxRoot, 'server'), AGENT_BOT_CONFIG: path.join(sandboxRoot, 'none.json'), HOME: sandboxRoot, AGENT_BOT_SERVER: BASE };
  const srv = fakeServer();
  await enroll({ base: BASE, env: senv, harnesses: ['grok'], fetchImpl: srv.fetch, sleep });
  srv.outcomeUnknown = true;
  await assert.rejects(
    mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env: senv, fetchImpl: srv.fetch, operationId: 'op_sweep' }),
    (error) => error.code === 'outcome-unknown');
  srv.outcomeUnknown = false;
  await reconcilePendingCredentials({ base: BASE, env: senv, fetchImpl: srv.fetch });
  srv.unknownResolved = true;
  await reconcilePendingCredentials({ base: BASE, env: senv, fetchImpl: srv.fetch });
  // A replayed issuance whose token is a canary: the ledger records the
  // operation, never the credential.
  srv.ops.set('op_sweep2', { issuance_id: 'iss_c', task_id: 'task_sweep', operation_id: 'op_sweep2', repo: 'o/r', token: CANARY['github-personal-token'] });
  const minted = await mintViaServer({ base: BASE, harness: 'grok', repo: 'o/r', env: senv, fetchImpl: srv.fetch, operationId: 'op_sweep2', taskId: 'task_sweep' });
  assert.equal(minted.token, CANARY['github-personal-token']);

  // 3. The action ledger itself: real writes from the flow above live under
  //    the sandbox state dir; nothing secret-shaped may appear in them.

  // 4. Provider-key fetch/use: the canary key is held in memory and the proxy
  //    issues its real abp_ token; receipts must keep both out.
  dropProviderKey();
  const session = Object.create(ServerSession.prototype);
  session.call = async (_method, route) => ({
    provider: 'openai', key: CANARY['provider-api-key'], key_id: 'pk_1', expires_at: '2099-01-01T00:00:00Z',
    issuance_id: 'iss_pk1', task_id: 'daemon-start',
    operation_id: new URL(route, 'https://x.test').searchParams.get('operation_id'),
  });
  await fetchProviderKey({ provider: 'openai', env, home: '/nonexistent', session });
  // The upstream answers canary text and a canary cookie — it never reaches a
  // file, and the proxy drops set-cookie on the way back anyway.
  const upstream = async () => new Response(`data: ${CANARY['github-user-token']}\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': `session=${CANARY['github-oauth-token']}` },
  });
  const origin = await startInferenceProxy({
    port: 0, upstreams: { openai: 'https://api.test/v1' }, env, home: '/nonexistent',
    fetchImpl: upstream, maxBodyBytes: 64,
  });
  try {
    const envPatch = brokeredProviderEnv({
      providerId: 'openai', envKey: 'OPENAI_API_KEY', baseUrl: `${origin}/v0/inference/openai`,
      agentId: null, harness: 'opencode', env, home: '/nonexistent',
    });
    const token = envPatch.env.OPENAI_API_KEY;
    assert.match(token, /^abp_[0-9a-f]{48}$/, 'the proxy issued a registered-shape token');
    // A forwarded request: the abp_ token is the Authorization bearer, and the
    // query and body carry registry-shaped canaries.
    const proxied = await fetch(`${origin}/v0/inference/openai/chat/completions?key=${CANARY['provider-api-key']}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: `{"q":"${CANARY['bearer-credential']}"}`,
    });
    assert.equal(proxied.status, 200);
    assert.match(await proxied.text(), /data:/);
    // too-large and key-not-held write their own per-request receipts.
    const big = await fetch(`${origin}/v0/inference/openai/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: CANARY.jwt,
    });
    assert.equal(big.status, 413, 'a body over the cap is refused');
    dropProviderKey();
    const noKey = await fetch(`${origin}/v0/inference/openai/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}',
    });
    assert.equal(noKey.status, 503, 'the key is no longer held');
  } finally {
    await stopInferenceProxy();
  }

  // The three proxy request receipts actually landed before the scan.
  const auditRows = readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const uses = auditRows.filter((row) => row.event === 'provider-key-use').map((row) => row.detail);
  for (const code of ['200', '413', '503']) {
    assert.ok(uses.some((d) => d.endsWith(`-> ${code}`)), `a -> ${code} proxy receipt was written`);
  }

  // 5. Diagnostics: canary-bearing detail is redacted before it lands.
  diagnosticEvent({
    agentId: AGENT_ID, level: 'error', kind: 'sweep',
    detail: `failed with ${CANARY['provider-api-key']} ${CANARY.jwt} ${CANARY['bearer-credential']}`,
  }, { component: 'sweep', version: '0.0.0', env, home: '/nonexistent' });

  // Scan every file under both state roots. Git object payloads are opaque
  // compression, not writer output.
  const regexes = REGISTRY.patterns.map((pattern) => ({ id: pattern.id, regex: new RegExp(pattern.regex, 'g') }));
  const leaks = [];
  for (const file of [...everyFile(root), ...everyFile(sandboxRoot)]) {
    if (file.includes(`${path.sep}.git${path.sep}objects${path.sep}`) || statSync(file).size > 1_000_000) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const { id, regex } of regexes) {
      regex.lastIndex = 0;
      if (regex.test(text)) leaks.push(`${id} in ${path.relative(root.startsWith(sandboxRoot) ? sandboxRoot : root, file)} (${file})`);
    }
  }
  assert.deepEqual(leaks, [], 'no registered secret shape in any written file');
});
