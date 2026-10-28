// Enforcement profile, protected-claim refusal and the legacy-local-custody
// switch (#1184; Soul Agent Platform 0.4 §4, R8, T21). The daemon names the
// profile actually in force on its health route and on every audit receipt,
// refuses any claim stronger than that, and mints nothing with an App key
// held on this host unless the owner opted in before the removal date.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ENFORCEMENT_PROFILES,
  LEGACY_LOCAL_CUSTODY_REMOVE_BY,
  appendAuditReceipt,
  assertProfileClaim,
  auditFile,
  enforcementProfile,
  legacyLocalCustody,
  normalizeProfile,
} from '../identity-format.mjs';
import { assertLegacyLocalCustody, mint } from '../mint-token.mjs';
import { createDaemonServer, runDaemon } from '../agent-daemon.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const BEFORE = () => new Date('2026-10-28T00:00:00.000Z');
const AFTER = () => new Date(Date.parse(LEGACY_LOCAL_CUSTODY_REMOVE_BY) + 1000);

function scratch(settings = null) {
  const root = mkdtempSync(path.join(tmpdir(), 'enforcement-profile-'));
  roots.push(root);
  const env = {
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_CONFIG: path.join(root, 'config.json'),
  };
  if (settings) writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({ settings }));
  return { root, env };
}

const receipts = (env) => readFileSync(auditFile({ env, home: '/nonexistent' }), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('with no opt-in the profile in force is managed cooperative, never protected', () => {
  const { env } = scratch();
  assert.deepEqual(legacyLocalCustody({ env, home: '/nonexistent', now: BEFORE }), { enabled: false, source: null, expired: false });
  assert.deepEqual(enforcementProfile({ env, home: '/nonexistent', now: BEFORE }), { profile: 'managed cooperative', reason: 'members-share-trust-domain' });
  assert.equal(Object.values(ENFORCEMENT_PROFILES).includes(enforcementProfile({ env, home: '/nonexistent' }).profile), true);
});

test('legacy local custody is opt-in by environment or config, reads standalone unenforced, and expires on the removal date', () => {
  for (const [settings, extra, source] of [[null, { AGENT_BOT_LEGACY_LOCAL_CUSTODY: '1' }, 'env'], [{ legacyLocalCustody: true }, {}, 'config']]) {
    const { env } = scratch(settings);
    Object.assign(env, extra);
    assert.deepEqual(legacyLocalCustody({ env, home: '/nonexistent', now: BEFORE }), { enabled: true, source, expired: false });
    assert.equal(enforcementProfile({ env, home: '/nonexistent', now: BEFORE }).profile, 'standalone unenforced');
    assert.deepEqual(legacyLocalCustody({ env, home: '/nonexistent', now: AFTER }), { enabled: false, source, expired: true });
    assert.equal(enforcementProfile({ env, home: '/nonexistent', now: AFTER }).profile, 'managed cooperative');
  }
  // Only an explicit true opts in; a malformed config is no opt-in.
  const { env } = scratch({ legacyLocalCustody: 'yes' });
  assert.equal(legacyLocalCustody({ env, home: '/nonexistent', now: BEFORE }).enabled, false);
  writeFileSync(env.AGENT_BOT_CONFIG, '{not json');
  assert.equal(legacyLocalCustody({ env, home: '/nonexistent', now: BEFORE }).enabled, false);
});

test('a claim stronger than the profile in force is refused with profile-insufficient (T21)', () => {
  const { env } = scratch();
  const opts = { env, home: '/nonexistent', now: BEFORE };
  assert.equal(normalizeProfile('Managed-Protected'), 'managed protected');
  assert.equal(normalizeProfile('cooperative'), 'managed cooperative');
  assert.equal(normalizeProfile('unprotected'), null);
  for (const claim of ['managed protected', 'protected', 'PROTECTED', 'something-else']) {
    assert.throws(() => assertProfileClaim(claim, opts), (error) => error.code === 'profile-insufficient' && error.statusCode === 403);
  }
  assert.equal(assertProfileClaim('managed cooperative', opts), 'managed cooperative');
  assert.equal(assertProfileClaim('standalone', opts), 'managed cooperative');
  // Under legacy custody even a cooperative claim reads stronger than reality.
  const legacy = { env: { ...env, AGENT_BOT_LEGACY_LOCAL_CUSTODY: '1' }, home: '/nonexistent', now: BEFORE };
  assert.throws(() => assertProfileClaim('managed cooperative', legacy), (error) => error.code === 'profile-insufficient' && error.actual === 'standalone unenforced');
});

test('every receipt names the profile it was written under', () => {
  const { env } = scratch();
  const written = appendAuditReceipt({ event: 'credential-mint', decision: 'granted' }, { env, home: '/nonexistent', now: BEFORE });
  assert.equal(written.profile, 'managed cooperative');
  appendAuditReceipt({ event: 'credential-mint', decision: 'granted' }, { env: { ...env, AGENT_BOT_LEGACY_LOCAL_CUSTODY: 'true' }, home: '/nonexistent', now: BEFORE });
  assert.deepEqual(receipts(env).map((row) => row.profile), ['managed cooperative', 'standalone unenforced']);
});

test('with legacy custody off nothing mints from an App key on this host, even one in the environment', async () => {
  const { env } = scratch();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const local = { ...env, GH_APP_ID: '1', GH_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), HOME: '/nonexistent' };
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no network in this test'); };
  try {
    await assert.rejects(mint({ env: local }), (error) => error.code === 'legacy-local-custody-off' && /legacy local custody is off/.test(error.message));
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, 0, 'refused before any request');
  assert.doesNotThrow(() => assertLegacyLocalCustody({ env: { ...local, AGENT_BOT_LEGACY_LOCAL_CUSTODY: '1' }, now: BEFORE }));
  assert.throws(() => assertLegacyLocalCustody({ env: { ...local, AGENT_BOT_LEGACY_LOCAL_CUSTODY: '1' }, now: AFTER }),
    (error) => error.code === 'legacy-local-custody-off' && /was removed on 2027-01-31/.test(error.message));
});

async function withServer(env, run) {
  const server = createDaemonServer({ env, home: '/nonexistent', config: { features: { 'github-identity': true } }, now: BEFORE });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  const call = (pathname, headers = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { authorization: `Bearer ${server.token}`, ...headers } });
  try { await run(call); } finally { await new Promise((resolve) => { server.close(resolve); }); }
}

test('the daemon reports its profile on /v0/health and refuses a stronger Agent-Bot-Profile claim', async () => {
  const { env } = scratch();
  await withServer(env, async (call) => {
    const health = await (await call('/v0/health')).json();
    assert.deepEqual(health.profile, { profile: 'managed cooperative', reason: 'members-share-trust-domain' });
    const ok = await call('/v0/health', { 'agent-bot-profile': 'managed cooperative' });
    assert.equal(ok.status, 200);
    const refused = await call('/v0/health', { 'agent-bot-profile': 'managed protected' });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), {
      error: 'the managed protected profile cannot be claimed here: the profile in force is managed cooperative',
      code: 'profile-insufficient', profile: 'managed cooperative',
    });
    // The refusal comes before authentication too, and leaves a receipt.
    const anonymous = await fetch(refused.url, { headers: { 'agent-bot-profile': 'protected' } });
    assert.equal(anonymous.status, 403);
  });
  const rows = receipts(env).filter((row) => row.event === 'profile-claim');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.decision === 'refused' && row.reason === 'profile-insufficient' && row.profile === 'managed cooperative'));
});

test('a daemon whose settings require the protected profile refuses to start', async () => {
  const { env } = scratch({ requireProfile: 'managed protected' });
  await assert.rejects(runDaemon({ env, home: '/nonexistent', port: '0', now: BEFORE }), (error) => error.code === 'profile-insufficient');
  await assert.rejects(runDaemon({ env: { ...env, AGENT_BOT_REQUIRE_PROFILE: 'protected' }, home: '/nonexistent', config: {}, port: '0', now: BEFORE }),
    (error) => error.code === 'profile-insufficient');
});
