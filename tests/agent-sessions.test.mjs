import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mintAgentIdentity, readAgentIdentity } from '../agent-identity.mjs';
import {
  endSession, findSessionByTranscript, listSessions, openSession, readSession,
} from '../identity/agent-sessions.mjs';
import { stateDirectory } from '../state-paths.mjs';

const SOUL_A = 'agent_11111111-1111-4111-8111-111111111111';
const SOUL_B = 'agent_22222222-2222-4222-8222-222222222222';
const T1 = { provider: 'codex', id: 'thread-one' };
const T2 = { provider: 'codex', id: 'thread-two' };

const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-sessions-'));
  roots.push(root);
  const env = { XDG_STATE_HOME: path.join(root, 'state') };
  return { root, env, stateDir: stateDirectory({ env, home: '/nonexistent' }) };
}
test.after(() => { for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch {} } });

test('openSession creates the exact record shape under stateDir/sessions, 0600', () => {
  const { stateDir } = fixture();
  const session = openSession({
    soulId: SOUL_A, transcript: T1, harness: 'codex', appSlug: 'you-codex-agent',
    stateDir, now: () => new Date('2026-10-01T00:00:00Z'),
  });
  assert.match(session.session_id, /^ses_[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...session, session_id: '<id>', started_at: '<t>', last_seen: '<t>' },
    {
      session_id: '<id>', soul_id: SOUL_A, transcript: T1, harness: 'codex',
      app_slug: 'you-codex-agent', app_profile: null, device_id: null,
      status: 'live', started_at: '<t>', last_seen: '<t>', ended_at: null,
    },
  );
  const file = path.join(stateDir, 'sessions', `${session.session_id}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readSession(session.session_id, { stateDir }), session);
});

test('openSession is idempotent for the same soul: same session, last_seen refreshed', () => {
  const { stateDir } = fixture();
  let tick = 0;
  const now = () => new Date(1_760_000_000_000 + (tick += 1000));
  const first = openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir, now });
  const again = openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir, now });
  assert.equal(again.session_id, first.session_id);
  assert.ok(Date.parse(again.last_seen) > Date.parse(first.last_seen));
  assert.equal(listSessions(SOUL_A, { stateDir }).length, 1);
});

test('a transcript already a session of another soul is refused 409 transcript-bound-elsewhere', () => {
  const { stateDir } = fixture();
  openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir });
  assert.throws(
    () => openSession({ soulId: SOUL_B, transcript: T1, harness: 'claude', stateDir }),
    (error) => error.statusCode === 409 && error.code === 'transcript-bound-elsewhere',
  );
  assert.equal(findSessionByTranscript(T1, { stateDir }).soul_id, SOUL_A);
  assert.equal(findSessionByTranscript(T2, { stateDir }), null);
});

test('a soul binds many conversations: each transcript gets its own session', () => {
  const { stateDir } = fixture();
  const s1 = openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir });
  const s2 = openSession({ soulId: SOUL_A, transcript: T2, harness: 'codex', stateDir });
  assert.notEqual(s1.session_id, s2.session_id);
  assert.deepEqual(
    listSessions(SOUL_A, { stateDir }).map((s) => s.session_id).sort(),
    [s1.session_id, s2.session_id].sort(),
  );
});

test('endSession closes the record; the transcript still belongs to the soul', () => {
  const { stateDir } = fixture();
  const session = openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir });
  const ended = endSession(session.session_id, { stateDir, now: () => new Date('2026-10-02T00:00:00Z') });
  assert.equal(ended.status, 'ended');
  assert.equal(ended.ended_at, '2026-10-02T00:00:00.000Z');
  assert.throws(
    () => openSession({ soulId: SOUL_B, transcript: T1, harness: 'claude', stateDir }),
    (error) => error.code === 'transcript-bound-elsewhere',
  );
});


test('a contested open refuses and removes the just-written record, never an index orphan', () => {
  const { stateDir } = fixture();
  const held = openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir });
  assert.throws(
    () => openSession({ soulId: SOUL_B, transcript: T1, harness: 'claude', stateDir }),
    (error) => error.code === 'transcript-bound-elsewhere',
  );
  // Exactly the winner's record exists; nothing the loser wrote survives.
  const records = readdirSync(path.join(stateDir, 'sessions')).filter((n) => n.endsWith('.json'));
  assert.deepEqual(records, [`${held.session_id}.json`]);
  assert.equal(findSessionByTranscript(T1, { stateDir }).soul_id, SOUL_A);
});

test('an index whose record is missing reads as bound-unknown, never as unbound', () => {
  const { stateDir } = fixture();
  const held = openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir });
  rmSync(path.join(stateDir, 'sessions', `${held.session_id}.json`));
  const found = findSessionByTranscript(T1, { stateDir });
  assert.equal(found.soul_id, null, 'the claim stands but names no soul');
  assert.equal(found.session_id, held.session_id);
});

test('session state lives in the registry dir, never under the soul directory', () => {
  const { root, stateDir } = fixture();
  const soulDir = path.join(root, 'soul');
  mkdirSync(soulDir);
  openSession({ soulId: SOUL_A, transcript: T1, harness: 'codex', stateDir });
  const written = readdirSync(soulDir);
  assert.deepEqual(written, [], 'nothing is written under the soul directory');
  assert.equal(readdirSync(path.join(stateDir, 'sessions')).some((n) => n.endsWith('.json')), true);
});

test('session records sit beside identity records in the same stateDir', () => {
  const { stateDir } = fixture();
  const identity = mintAgentIdentity({
    appSlug: null, harness: 'codex', transcript: null,
    stateDir, now: () => new Date('2026-10-01T00:00:00Z'), useGithub: false,
  });
  const session = openSession({ soulId: identity.id, transcript: T1, harness: 'codex', stateDir });
  assert.equal(session.soul_id, identity.id);
  assert.equal(readAgentIdentity(identity.id, { stateDir }).id, identity.id);
});
