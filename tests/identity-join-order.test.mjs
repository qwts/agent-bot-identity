// A joined soul's App across the census and the identity record (#645, F6;
// owner decision on revert, option 1): soul records the App in the census
// first and identity's initialize-app runs last; if it fails, soul puts back
// its own row. Identity has no revert, so no caller can swap a soul's App by
// handing it an earlier record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { identityOp } from '../daemon-client.mjs';
import { mintAgentIdentity, readAgentIdentity, retireAgentIdentity } from '../agent-identity.mjs';
import { setSoulAppThen, showSoul, updateSoulStatus, upsertSoul } from '../agent-population.mjs';

const NOW = '2026-10-11T12:00:00.000Z';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'identity-join-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const file = path.join(root, 'population.json');
  const identity = mintAgentIdentity({ appSlug: null, useGithub: false, stateDir, now: () => new Date(NOW) });
  upsertSoul({ id: identity.id, appSlug: null, parentId: null, status: 'active', spacePath: path.join(root, 'space'),
    transcriptLocator: null, lastSeen: NOW }, { file });
  const initialize = (appSlug = 'fixture-app') => () => identityOp('initialize-app', { id: identity.id, appSlug, stateDir });
  return { stateDir, file, identity, initialize };
}

test('the census gets the App first, then the identity record', (t) => {
  const { stateDir, file, identity, initialize } = fixture(t);
  const { soul, identity: record } = setSoulAppThen(identity.id, 'fixture-app', { file }, initialize());
  assert.equal(soul.appSlug, 'fixture-app');
  assert.equal(record.github.appSlug, 'fixture-app');
  assert.deepEqual(readAgentIdentity(identity.id, { stateDir }), record);
});

test('a census step that fails leaves the identity record untouched', (t) => {
  const { stateDir, file, identity, initialize } = fixture(t);
  const before = readAgentIdentity(identity.id, { stateDir });
  updateSoulStatus(identity.id, 'retired', { file });
  let called = false;
  assert.throws(() => setSoulAppThen(identity.id, 'fixture-app', { file }, () => { called = true; return initialize()(); }),
    /absent or retired soul/);
  assert.equal(called, false);
  assert.deepEqual(readAgentIdentity(identity.id, { stateDir }), before);
  writeFileSync(file, JSON.stringify({ schemaVersion: 999, souls: {} }));
  assert.throws(() => setSoulAppThen(identity.id, 'fixture-app', { file }, initialize()), /future schemaVersion/);
  assert.deepEqual(readAgentIdentity(identity.id, { stateDir }), before);
});

test('an identity write that fails puts the census App back', (t) => {
  const { stateDir, file, identity, initialize } = fixture(t);
  retireAgentIdentity(identity.id, { stateDir });
  const row = showSoul(identity.id, { file });
  assert.throws(() => setSoulAppThen(identity.id, 'fixture-app', { file }, initialize()), /cannot initialize a retired soul/);
  assert.deepEqual(showSoul(identity.id, { file }), row);
});

test('no caller can swap a soul\'s App through identity', (t) => {
  const { stateDir, file, identity, initialize } = fixture(t);
  setSoulAppThen(identity.id, 'fixture-app', { file }, initialize());
  const assigned = readAgentIdentity(identity.id, { stateDir });
  const forged = { ...assigned, github: { ...assigned.github, appSlug: 'someone-else' } };
  assert.throws(() => identityOp('revert', { id: identity.id, previous: forged, written: assigned, stateDir }), { code: 'unknown-op' });
  assert.throws(() => identityOp('initialize-app', { id: identity.id, appSlug: 'fixture-app', previous: forged, stateDir }),
    { code: 'invalid-input' });
  // initialize-app fills an absent App only; it never replaces one.
  const row = showSoul(identity.id, { file });
  assert.throws(() => setSoulAppThen(identity.id, 'someone-else', { file }, initialize('someone-else')),
    /already has a different GitHub App/);
  assert.equal(readAgentIdentity(identity.id, { stateDir }).github.appSlug, 'fixture-app');
  assert.deepEqual(showSoul(identity.id, { file }), row);
});
