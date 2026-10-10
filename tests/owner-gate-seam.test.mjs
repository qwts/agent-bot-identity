// owner-gate.mjs takes its principal check and census as injected
// dependencies (#645). Unwired, a presented principal refuses before any
// consent; owner-action.mjs wires both for soul-level and host commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gate from '../owner-gate.mjs';
import * as action from '../owner-action.mjs';
import { verifyPrincipalOwner } from '../owner-principal.mjs';
import { identityAppOperation } from '../identity-apps.mjs';
import { migrateCredentialsCommand } from '../soul-credential-migration.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ID = 'agent_11111111-1111-4111-8111-111111111111';
const PRINCIPAL = { principal: 'principal_11111111-1111-4111-8111-111111111111', secret: 'synthetic-test-value', brokerUid: 501, mode: 'group' };
const clean = () => {
  const home = mkdtempSync(join(tmpdir(), 'owner-seam-'));
  return { env: { HOME: home, AGENT_BOT_CONFIG: join(home, 'config.json') }, cwd: home };
};
const recorder = () => {
  const calls = [];
  return { calls, consent: async (...args) => { calls.push(['consent', ...args]); return { method: 'consent' }; },
    verify: async (credential) => { calls.push(['verify', credential.principal]); return { method: 'principal', principal: credential.principal }; } };
};

test('unwired, a presented principal refuses and nobody is asked', async () => {
  const { env, cwd } = clean();
  const r = recorder();
  await assert.rejects(gate.assertOwnerAction('soul remove x', { env, cwd, principal: PRINCIPAL, consent: r.consent, markers: () => [] }),
    (error) => error.code === 'owner-credential-required' && !error.message.includes(PRINCIPAL.secret));
  await assert.rejects(gate.confirmOwnerPresence('approve tool', { env, principal: PRINCIPAL, consent: r.consent }),
    (error) => error.code === 'owner-credential-required');
  assert.deepEqual(r.calls, []);
});

test('soul markers refuse before the broker or consent, wired or not', async () => {
  for (const assertOwner of [gate.assertOwnerAction, action.assertOwnerAction]) {
    const r = recorder();
    await assert.rejects(assertOwner('soul remove x', { principal: PRINCIPAL, markers: () => ['Agent ID'], verifyPrincipal: r.verify, consent: r.consent }),
      /owner only; this caller has a soul's Agent ID/);
    assert.deepEqual(r.calls, []);
  }
});

test('wired, a principal is verified by the broker check and the daemon still asks presence', async () => {
  const r = recorder();
  const result = await action.confirmOwnerPresence('approve tool', { principal: PRINCIPAL, verifyPrincipal: r.verify, consent: r.consent });
  assert.deepEqual(r.calls.map(([kind]) => kind), ['verify', 'consent']);
  assert.deepEqual(result, { method: 'consent', principal: PRINCIPAL.principal });
  // owner-action supplies the comms verifier when the caller does not.
  assert.equal(action.verifyPrincipalOwner, verifyPrincipalOwner);
});

test('the wired verifier keeps broker errors redacted', async () => {
  const clientFactory = () => ({ request: async () => { throw new Error(`broker said ${PRINCIPAL.secret}`); } });
  await assert.rejects(verifyPrincipalOwner(PRINCIPAL, { env: {}, paths: { socket: '/nonexistent' }, clientFactory, uid: 0 }),
    (error) => error.code === 'owner-credential-required' && !error.message.includes(PRINCIPAL.secret));
});

test('prompts name each soul only through the wired census, byte for byte', () => {
  const souls = [{ id: ID, name: 'bill', displayName: 'Bill - Starter' }];
  assert.equal(gate.ownerActionSummary(`soul remove ${ID}`, {}), `remove ${ID} from this Mac (its folders are archived, not deleted)`);
  assert.equal(gate.ownerActionSummary(`soul remove ${ID}`, { listSouls: () => souls }), `remove Bill - Starter (${ID}) from this Mac (its folders are archived, not deleted)`);
  assert.equal(action.ownerActionSummary(`soul remove ${ID}`, { souls }), gate.ownerActionSummary(`soul remove ${ID}`, { souls }));
});

test('identity library invocations without the wiring refuse a presented principal', async () => {
  const { env, cwd } = clean();
  await assert.rejects(identityAppOperation('addon', { name: 'github-identity', enabled: true, principal: PRINCIPAL }, { env, home: cwd, cwd }),
    (error) => error.code === 'identity-app-owner-required');
  await assert.rejects(migrateCredentialsCommand(['--all', '--principal-stdin'], { env, home: cwd, cwd, markers: () => [], readStdin: () => JSON.stringify(PRINCIPAL), write: () => {} }),
    (error) => error.code === 'owner-credential-required');
});

test('the identity entry files point at agent-bot when run directly', () => {
  for (const [file, hint] of [['identity-apps.mjs', /run agent-bot identity apps/], ['soul-credentials.mjs', /run agent-bot identity migrate-credentials/]]) {
    let failure = null;
    try { execFileSync(process.execPath, [join(ROOT, file), 'addon', 'github-identity', 'on'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { failure = error; }
    assert.ok(failure, `${file} must refuse`);
    assert.match(failure.stderr, hint);
    assert.equal(failure.stdout, '');
  }
});
