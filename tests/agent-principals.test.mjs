import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendAuditReceipt,
  applyAuthorizationChanges,
  assertAuthorized,
  auditFile,
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  getPrincipal,
  listPrincipals,
  principalsFile,
  resolvePrincipal,
  revokePrincipal,
  setDefaultSoul,
  setOperations,
} from '../agent-principals.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const SOUL_A = 'agent_11111111-1111-4111-8111-111111111111';
const SOUL_B = 'agent_22222222-2222-4222-8222-222222222222';
const NOW = () => new Date('2026-08-12T08:00:00.000Z');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-principals-'));
  roots.push(root);
  const options = {
    file: path.join(root, 'principals.json'),
    env: { AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction') },
    home: '/nonexistent',
    now: NOW,
  };
  return { root, options };
}

function enrolled(options, label = 'owner-phone') {
  return enrollPrincipal({ label }, options);
}

test('principals file follows explicit override, XDG state, then home default', () => {
  assert.equal(
    principalsFile({ env: { AGENT_BOT_PRINCIPALS_PATH: '/tmp/p.json' } }),
    '/tmp/p.json',
  );
  assert.equal(
    principalsFile({ env: { XDG_STATE_HOME: '/tmp/state' }, home: '/home/test' }),
    '/tmp/state/agent-bot/principals.json',
  );
  assert.equal(
    principalsFile({ env: {}, home: '/home/test' }),
    '/home/test/.local/state/agent-bot/principals.json',
  );
});

test('enrollment starts deny-by-default and the store stays private', () => {
  const { options } = scratch();
  const principal = enrolled(options);
  assert.match(principal.principalId, /^principal_[0-9a-f-]{36}$/);
  assert.equal(principal.status, 'active');
  assert.deepEqual(principal.bindings, []);
  assert.deepEqual(principal.authorizations, { souls: [], operations: [] });
  assert.equal(principal.defaultSoul, null);
  assert.equal(statSync(options.file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(options.file)).mode & 0o777, 0o700);
  // Even a fully enrolled principal is refused everything until allowed.
  assert.throws(
    () => assertAuthorized({ principal, agentId: SOUL_A, operation: 'message' }),
    /not authorized/,
  );
});

test('resolution matches only the immutable (transport, providerId) binding', () => {
  const { options } = scratch();
  const principal = enrolled(options);
  bindTransport(principal.principalId, { transport: 'telegram', providerId: '308462948' }, options);

  const hit = resolvePrincipal({ transport: 'telegram', providerId: '308462948' }, options);
  assert.equal(hit.principalId, principal.principalId);

  // A spoofed or renamed handle is irrelevant: display names and usernames
  // are not part of the model, so only a different providerId is a different
  // identity — and an unknown one resolves to nothing.
  assert.equal(resolvePrincipal({ transport: 'telegram', providerId: '999999999' }, options), null);
  assert.equal(resolvePrincipal({ transport: 'web', providerId: '308462948' }, options), null);
});

test('binding the same transport identity twice is refused', () => {
  const { options } = scratch();
  const first = enrolled(options, 'first');
  const second = enrolled(options, 'second');
  bindTransport(first.principalId, { transport: 'telegram', providerId: '42' }, options);
  assert.throws(
    () => bindTransport(second.principalId, { transport: 'telegram', providerId: '42' }, options),
    /already bound/,
  );
  assert.throws(
    () => bindTransport(first.principalId, { transport: 'telegram', providerId: '42' }, options),
    /already bound/,
  );
});

test('malformed transports and provider IDs are rejected with stable errors', () => {
  const { options } = scratch();
  const principal = enrolled(options);
  for (const providerId of ['', 'has space', 'tab\tseparated', 'x'.repeat(129), 42, null, 'café']) {
    assert.throws(
      () => bindTransport(principal.principalId, { transport: 'telegram', providerId }, options),
      /providerId must be a normalized provider identifier/,
    );
    assert.throws(
      () => resolvePrincipal({ transport: 'telegram', providerId }, options),
      /providerId must be a normalized provider identifier/,
    );
  }
  for (const transport of ['', 'Telegram', 'has space', '-web', 'x'.repeat(33)]) {
    assert.throws(
      () => bindTransport(principal.principalId, { transport, providerId: '42' }, options),
      /transport must be a short lowercase slug/,
    );
  }
});

test('authorization requires exact soul and operation membership', () => {
  const { options } = scratch();
  let principal = enrolled(options);
  principal = authorizeSouls(principal.principalId, [SOUL_A], options);
  principal = setOperations(principal.principalId, ['message', 'observe'], options);

  assert.equal(assertAuthorized({ principal, agentId: SOUL_A, operation: 'message' }), true);
  assert.throws(
    () => assertAuthorized({ principal, agentId: SOUL_B, operation: 'message' }),
    /not authorized/,
  );
  assert.throws(
    () => assertAuthorized({ principal, agentId: SOUL_A, operation: 'cancel' }),
    /not authorized/,
  );
  assert.throws(
    () => setOperations(principal.principalId, ['message', 'shutdown'], options),
    /subset of the interaction operations/,
  );
});

test('wildcard soul access exists only when explicitly configured alone', () => {
  const { options } = scratch();
  let principal = enrolled(options);
  assert.throws(
    () => authorizeSouls(principal.principalId, ['*', SOUL_A], options),
    /wildcard soul access/,
  );
  principal = authorizeSouls(principal.principalId, ['*'], options);
  principal = setOperations(principal.principalId, ['message'], options);
  assert.equal(assertAuthorized({ principal, agentId: SOUL_B, operation: 'message' }), true);
});

test('revocation closes every door and mutations on revoked principals fail', () => {
  const { options } = scratch();
  let principal = enrolled(options);
  bindTransport(principal.principalId, { transport: 'web', providerId: 'subject-1' }, options);
  principal = authorizeSouls(principal.principalId, [SOUL_A], options);
  principal = setOperations(principal.principalId, ['message'], options);

  principal = revokePrincipal(principal.principalId, options);
  assert.equal(principal.status, 'revoked');
  assert.equal(resolvePrincipal({ transport: 'web', providerId: 'subject-1' }, options), null);
  assert.throws(
    () => assertAuthorized({ principal, agentId: SOUL_A, operation: 'message' }),
    /not authorized/,
  );
  assert.throws(
    () => bindTransport(principal.principalId, { transport: 'cli', providerId: 'local' }, options),
    /revoked/,
  );
  assert.throws(() => authorizeSouls(principal.principalId, [SOUL_B], options), /revoked/);
});

test('default soul must be authorized and narrowing souls clears a stale default', () => {
  const { options } = scratch();
  let principal = enrolled(options);
  assert.throws(
    () => setDefaultSoul(principal.principalId, SOUL_A, options),
    /must already be authorized/,
  );
  principal = authorizeSouls(principal.principalId, [SOUL_A, SOUL_B], options);
  principal = setDefaultSoul(principal.principalId, SOUL_A, options);
  assert.equal(principal.defaultSoul, SOUL_A);
  principal = authorizeSouls(principal.principalId, [SOUL_B], options);
  assert.equal(principal.defaultSoul, null);
});

test('audit receipts are append-only, whitelisted, and secret-free', () => {
  const { options } = scratch();
  let principal = enrolled(options);
  bindTransport(principal.principalId, { transport: 'telegram', providerId: '308462948' }, options);
  principal = authorizeSouls(principal.principalId, [SOUL_A], options);
  setOperations(principal.principalId, ['message'], options);
  setDefaultSoul(principal.principalId, SOUL_A, options);
  revokePrincipal(principal.principalId, options);
  appendAuditReceipt(
    { event: 'denied-request', transport: 'telegram', decision: 'denied' },
    { env: options.env, home: options.home, now: NOW },
  );

  const file = auditFile({ env: options.env, home: options.home });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => line.event),
    ['enroll', 'bind', 'allow-souls', 'allow-operations', 'set-default-soul', 'revoke', 'denied-request'],
  );
  const allowedKeys = new Set(['at', 'event', 'principalId', 'transport', 'agentId', 'operation', 'decision']);
  for (const line of lines) {
    for (const key of Object.keys(line)) assert.equal(allowedKeys.has(key), true, key);
  }
  // Provider IDs, labels, and store contents never reach the audit log.
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes('308462948'), false);
  assert.equal(raw.includes('owner-phone'), false);
});

test('duplicate enrollment of the same principal ID is refused', () => {
  const { options } = scratch();
  const idFactory = () => 'principal_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  enrollPrincipal({ label: 'one' }, { ...options, idFactory });
  assert.throws(() => enrollPrincipal({ label: 'two' }, { ...options, idFactory }), /already enrolled/);
  assert.equal(listPrincipals(options).length, 1);
});

test('authorization changes are all-or-nothing: a partially invalid request mutates nothing', () => {
  const { options } = scratch();
  const principal = enrolled(options);
  authorizeSouls(principal.principalId, [SOUL_A], options);
  setOperations(principal.principalId, ['message'], options);
  const before = readFileSync(options.file, 'utf8');

  // The souls facet is valid on its own; the later operations element is
  // not. The whole request must be refused with the store byte-identical.
  assert.throws(
    () => applyAuthorizationChanges(principal.principalId, {
      souls: [SOUL_A, SOUL_B],
      operations: ['message', 'not-an-operation'],
    }, options),
    /subset of the interaction operations/,
  );
  assert.equal(readFileSync(options.file, 'utf8'), before);

  // A default soul outside the soul list AS REQUESTED fails the same way.
  assert.throws(
    () => applyAuthorizationChanges(principal.principalId, {
      souls: [SOUL_A],
      defaultSoul: SOUL_B,
    }, options),
    /default soul must already be authorized/,
  );
  assert.equal(readFileSync(options.file, 'utf8'), before);

  // An empty request is refused before any store access.
  assert.throws(
    () => applyAuthorizationChanges(principal.principalId, {}, options),
    /at least one authorization change/,
  );
  assert.equal(readFileSync(options.file, 'utf8'), before);

  // A fully valid request commits every facet in one mutation, including a
  // default that only becomes legal through this same request.
  const updated = applyAuthorizationChanges(principal.principalId, {
    souls: [SOUL_A, SOUL_B],
    operations: ['message', 'observe'],
    defaultSoul: SOUL_B,
  }, options);
  assert.deepEqual(updated.authorizations.souls, [SOUL_A, SOUL_B]);
  assert.deepEqual(updated.authorizations.operations, ['message', 'observe']);
  assert.equal(updated.defaultSoul, SOUL_B);

  // Narrowing souls in the same call clears a now-unreachable stored default.
  const narrowed = applyAuthorizationChanges(principal.principalId, { souls: [SOUL_A] }, options);
  assert.equal(narrowed.defaultSoul, null);
});

test('the principal allow CLI is atomic: a rejected request leaves the store unchanged', () => {
  const { root, options } = scratch();
  const env = {
    ...process.env,
    AGENT_BOT_PRINCIPALS_PATH: options.file,
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
  };
  const run = (...args) => spawnSync(process.execPath, [CLI, 'principal', ...args], { encoding: 'utf8', env });
  const principal = JSON.parse(run('enroll', '--label', 'owner').stdout);
  assert.equal(run('allow', principal.principalId, '--soul', SOUL_A, '--operation', 'message').status, 0);
  const before = readFileSync(options.file, 'utf8');

  const rejected = run(
    'allow', principal.principalId,
    '--soul', SOUL_B, '--operation', 'message', '--operation', 'bogus-operation',
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /subset of the interaction operations/);
  assert.equal(readFileSync(options.file, 'utf8'), before);
});

test('the principal CLI enrolls, binds, allows, and lists without tokens', () => {
  const { root, options } = scratch();
  const env = {
    ...process.env,
    AGENT_BOT_PRINCIPALS_PATH: options.file,
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
  };
  const run = (...args) => spawnSync(process.execPath, [CLI, 'principal', ...args], { encoding: 'utf8', env });

  const enroll = run('enroll', '--label', 'owner');
  assert.equal(enroll.status, 0, enroll.stderr);
  const principal = JSON.parse(enroll.stdout);

  const bind = run('bind', principal.principalId, '--transport', 'telegram', '--provider-id', '42');
  assert.equal(bind.status, 0, bind.stderr);

  const allow = run('allow', principal.principalId, '--soul', SOUL_A, '--operation', 'message');
  assert.equal(allow.status, 0, allow.stderr);
  const allowed = JSON.parse(allow.stdout);
  assert.deepEqual(allowed.authorizations, { souls: [SOUL_A], operations: ['message'] });

  const list = run('list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(principal.principalId));

  const show = run('show', principal.principalId);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).label, 'owner');

  const revoke = run('revoke', principal.principalId);
  assert.equal(revoke.status, 0, revoke.stderr);
  assert.equal(JSON.parse(revoke.stdout).status, 'revoked');

  const empty = run('allow', principal.principalId);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /at least one authorization change/);
});

test('getPrincipal answers unknown IDs with a stable error', () => {
  const { options } = scratch();
  assert.throws(
    () => getPrincipal('principal_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', options),
    /unknown principal/,
  );
  assert.throws(() => getPrincipal('not-a-principal', options), /invalid principal ID/);
});
