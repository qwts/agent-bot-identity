// Retire and finalize across the census and the identity record (#645, F6;
// owner decision on revert, option 1). Soul writes its census row first and
// identity's record last; if the identity write fails, soul puts its own row
// back. Identity has no revert: no caller can hand it an earlier record to
// restore, so a forged record cannot un-retire a soul or swap its App.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { identityOp } from '../daemon-client.mjs';
import { IDENTITY_OPS, runIdentityOp } from '../identity-entry.mjs';
import { mintAgentIdentity, readAgentIdentity } from '../agent-identity.mjs';
import {
  finalizeIdentityWithPopulation,
  retireIdentityWithPopulation,
  showSoul,
  upsertSoul,
} from '../agent-population.mjs';

const NOW = '2026-10-11T12:00:00.000Z';
const LATER = '2026-10-11T13:00:00.000Z';

function fixture(t, { transcript = true, appSlug = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'identity-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const file = path.join(root, 'population.json');
  const identity = mintAgentIdentity({
    appSlug, useGithub: appSlug != null, stateDir,
    transcript: transcript ? { provider: 'claude', id: `s-${randomUUID()}` } : null,
    now: () => new Date(NOW),
  });
  upsertSoul({ id: identity.id, appSlug, parentId: null, status: 'active', spacePath: path.join(root, 'space'),
    transcriptLocator: null, lastSeen: NOW }, { file });
  return { root, stateDir, file, identity, recordFile: path.join(stateDir, `${identity.id}.json`) };
}

const later = () => new Date(LATER);

test('retire and finalize write the census row, then the identity record', (t) => {
  const { stateDir, file, identity } = fixture(t);
  const finalized = finalizeIdentityWithPopulation(identity.id, { file, stateDir, now: later });
  assert.equal(finalized.status, 'finalized');
  assert.equal(showSoul(identity.id, { file }).status, 'finalized');
  const retired = retireIdentityWithPopulation(identity.id, { file, stateDir, now: later });
  assert.equal(retired.identity.status, 'retired');
  assert.equal(retired.soul.status, 'retired');
  assert.deepEqual(readAgentIdentity(identity.id, { stateDir }), retired.identity);
});

test('a census step that fails leaves the identity record untouched', (t) => {
  const { stateDir, file, identity } = fixture(t);
  const before = readAgentIdentity(identity.id, { stateDir });
  const census = readFileSync(file, 'utf8');
  writeFileSync(file, JSON.stringify({ schemaVersion: 999, souls: {} }));
  assert.throws(() => retireIdentityWithPopulation(identity.id, { file, stateDir, now: later }), /future schemaVersion/);
  assert.throws(() => finalizeIdentityWithPopulation(identity.id, { file, stateDir, now: later }), /future schemaVersion/);
  assert.deepEqual(readAgentIdentity(identity.id, { stateDir }), before);
  writeFileSync(file, census);
  assert.equal(finalizeIdentityWithPopulation(identity.id, { file, stateDir, now: later }).status, 'finalized');
});

test('an identity write that fails puts the census row back', (t) => {
  // Finalize: identity refuses a soul with no transcript, after the census step.
  const noTranscript = fixture(t, { transcript: false });
  const row = showSoul(noTranscript.identity.id, { file: noTranscript.file });
  assert.throws(() => finalizeIdentityWithPopulation(noTranscript.identity.id,
    { file: noTranscript.file, stateDir: noTranscript.stateDir, now: later }), /no transcript to finalize/);
  assert.deepEqual(showSoul(noTranscript.identity.id, { file: noTranscript.file }), row);

  // Retire: the identity record cannot be read, after the census step.
  const unreadable = fixture(t);
  const before = showSoul(unreadable.identity.id, { file: unreadable.file });
  writeFileSync(unreadable.recordFile, '{ not json');
  assert.throws(() => retireIdentityWithPopulation(unreadable.identity.id,
    { file: unreadable.file, stateDir: unreadable.stateDir, now: later }));
  assert.deepEqual(showSoul(unreadable.identity.id, { file: unreadable.file }), before);
});

test('finalize never rewrites a census tombstone, even for a moment', (t) => {
  const { stateDir, file, identity } = fixture(t);
  retireIdentityWithPopulation(identity.id, { file, stateDir, now: later });
  const tombstone = showSoul(identity.id, { file });
  assert.throws(() => finalizeIdentityWithPopulation(identity.id, { file, stateDir, now: later }),
    /is retired and cannot be finalized/);
  assert.deepEqual(showSoul(identity.id, { file }), tombstone);
  assert.equal(readAgentIdentity(identity.id, { stateDir }).status, 'retired');
});

test('retire and finalize return only the record they wrote', (t) => {
  const { stateDir, identity } = fixture(t);
  const finalized = identityOp('finalize', { id: identity.id, stateDir, now: NOW });
  assert.equal(finalized.status, 'finalized');
  assert.equal(finalized.previous, undefined);
  const retired = identityOp('retire', { id: identity.id, stateDir, now: NOW });
  assert.deepEqual(readAgentIdentity(identity.id, { stateDir }), retired);
});

test('no identity operation takes an earlier record to restore', (t) => {
  const { stateDir, identity } = fixture(t, { appSlug: 'qwts-claude-agent' });
  const original = readAgentIdentity(identity.id, { stateDir });
  const retired = identityOp('retire', { id: identity.id, stateDir, now: NOW });
  // A forged earlier record: the same soul, active again, as another App.
  const forged = { ...original, status: 'active', github: { ...original.github, appSlug: 'someone-else' } };
  assert.equal(Object.hasOwn(IDENTITY_OPS, 'revert'), false);
  assert.throws(() => identityOp('revert', { id: identity.id, previous: forged, written: retired, stateDir }),
    { code: 'unknown-op' });
  for (const op of Object.keys(IDENTITY_OPS)) {
    for (const key of ['previous', 'record', 'written']) {
      assert.throws(() => runIdentityOp(op, { id: identity.id, stateDir, [key]: forged }), { code: 'invalid-input' },
        `${op} must refuse ${key}`);
    }
  }
  const after = readAgentIdentity(identity.id, { stateDir });
  assert.equal(after.status, 'retired');
  assert.equal(after.github.appSlug, 'qwts-claude-agent');
});
