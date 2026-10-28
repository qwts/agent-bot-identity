// The e2e runner (#1206) driven against the signed fake identity service.
// Importing the server-client suite's helpers also runs its tests here —
// that reuse is deliberate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { run } from '../scripts/e2e-server.mjs';
import { BASE, fakeServer, sandbox, sleep } from './helpers/fake-identity-server.mjs';

const ENROLL_TOKEN = 'abe_good';

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function drive({ flags, ...opts } = {}) {
  const srv = fakeServer();
  Object.assign(srv, { legacyDisabled: true }, flags ?? {});
  const rows = [];
  const out = await run({
    base: BASE, env: sandbox(), fetchImpl: srv.fetch,
    enrollToken: ENROLL_TOKEN, harness: 'grok', repo: 'o/r',
    emit: (row) => rows.push(row),
    ...opts,
  });
  return { srv, rows, out };
}

const byName = (rows, name) => rows.find((r) => r.scenario === name);

test('the runner exercises enroll through soul-token against a live service', async () => {
  const { rows, out } = await drive({ includeRevoke: true });
  assert.equal(out.failed, 0, JSON.stringify(rows.filter((r) => r.result === 'failed')));
  for (const name of ['enroll', 'mint-readback', 'replay-same-op', 'conflict-new-params', 'provider-key', 'legacy-route-disabled', 'soul-token', 'revoke']) {
    assert.equal(byName(rows, name)?.result, 'passed', `${name}: ${byName(rows, name)?.detail}`);
  }
  const mint = byName(rows, 'mint-readback');
  assert.ok(mint.issuance_id && mint.operation_id);
  assert.equal(byName(rows, 'replay-same-op').issuance_id, mint.issuance_id);
  assert.equal(byName(rows, 'github-5xx').result, 'skipped');
});

test('provider_key_not_configured is a skip without --require, a failure with it', async () => {
  assert.equal(byName((await drive({ flags: { providerMissing: true } })).rows, 'provider-key').result, 'skipped');
  assert.equal(byName((await drive({ flags: { providerMissing: true }, requireDevice: true })).rows, 'provider-key').result, 'failed');
});

test('a signing outage skips soul-token without --require, fails with it', async () => {
  assert.equal(byName((await drive({ flags: { soulSigningDown: true } })).rows, 'soul-token').result, 'skipped');
  assert.equal(byName((await drive({ flags: { soulSigningDown: true }, requireDevice: true })).rows, 'soul-token').result, 'failed');
});

test('a JWKS issuer, curve or token alg the contract does not name fails soul-token', async () => {
  for (const flags of [{ jwksIssuer: 'https://other.test' }, { jwksCrv: 'P-384' }, { soulAlg: 'EdDSA' }]) {
    const { rows } = await drive({ flags });
    assert.equal(byName(rows, 'soul-token').result, 'failed', JSON.stringify(flags));
  }
});

test('an enrolled throwaway device is revoked on exit, and --keep-device opts out', async () => {
  const a = await drive();
  assert.ok(a.srv.revokedDevice, 'the fake saw the cleanup revoke');
  assert.deepEqual([byName(a.rows, 'cleanup').result, byName(a.rows, 'cleanup').detail], ['passed', 'revoked']);
  const b = await drive({ keepDevice: true });
  assert.equal(b.srv.revokedDevice, undefined);
  assert.equal(byName(b.rows, 'cleanup').result, 'skipped');
});

test('github-5xx: the mock GitHub drives 503, 502-after-mint and the in-flight guard', async () => {
  const port = await freePort();
  const { rows } = await drive({
    mockGithub: port,
    flags: { githubBase: `http://127.0.0.1:${port}` },
  });
  const row = byName(rows, 'github-5xx');
  assert.equal(row.result, 'passed', row.detail);
  assert.match(row.detail, /503:credential-unavailable\/none/);
  assert.match(row.detail, /502:outcome-unknown\/unknown mints:1 retry:outcome-unknown new-op:operation-conflict extra-mints:0 ok:issued/);
});

test('github-5xx fails when a counted 502 mint answers credential-unavailable', async () => {
  const port = await freePort();
  const { rows } = await drive({
    mockGithub: port,
    flags: { githubBase: `http://127.0.0.1:${port}`, github502Unavailable: true },
  });
  const row = byName(rows, 'github-5xx');
  assert.equal(row.result, 'failed', row.detail);
  assert.match(row.detail, /502:credential-unavailable/, 'the ambiguous mint must not read as retriable');
});

test('github-5xx skips without --mock-github', async () => {
  const { rows } = await drive();
  assert.equal(byName(rows, 'github-5xx').result, 'skipped');
});

test('an outage mint answers credential-unavailable and records nothing issued', async () => {
  const { rows } = await drive();
  const row = byName(rows, 'outage');
  assert.equal(row.result, 'passed', row.detail);
  assert.match(row.detail, /credential-unavailable/);
  assert.doesNotMatch(row.detail, /uncoded/);
});

test('without an enrollment token the device scenarios skip and nothing fails', async () => {
  const { rows, out } = await drive({ enrollToken: null });
  assert.equal(out.failed, 0);
  for (const name of ['enroll', 'mint-readback', 'provider-key', 'soul-token']) {
    assert.equal(byName(rows, name).result, 'skipped', name);
  }
  assert.equal(byName(rows, 'github-5xx').result, 'skipped');
});

test('--require turns a missing enrollment token into an exit-2 style failure', async () => {
  const { out } = await drive({ enrollToken: null, requireDevice: true });
  assert.equal(out.failed, 1);
  assert.equal(out.results[0].scenario, 'enroll');
});

test('no secret shape ever reaches the emitted output', async () => {
  const { rows } = await drive({ includeRevoke: true });
  const text = JSON.stringify(rows);
  for (const shape of [/ghs_/, /sk-[A-Za-z0-9_-]{16,}/, /eyJ[A-Za-z0-9_-]{8,}/, /[Bb]earer [A-Za-z0-9]/, /abp_[0-9a-f]{48}/, /abe_good/]) {
    assert.doesNotMatch(text, shape);
  }
});
