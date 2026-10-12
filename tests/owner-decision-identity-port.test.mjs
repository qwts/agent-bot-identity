// The owner-decision final-entry identity port (agent-comms#77, C2): a strict
// in-process identity read, passed from host into soul's locked core, and the
// uniform refusal for every custody failure or malformed port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { IDENTITY_RECORD_MAX_BYTES, mintAgentIdentity, readAgentIdentity } from '../identity/agent-identity.mjs';
import { OWNER_DECISION_IDENTITY_PORT_KIND, createOwnerDecisionIdentityPort } from '../owner-decision-identity-port.mjs';
import { TARGET_REFUSAL, resolveOwnerDecisionTargetLocked } from '../owner-decision-target.mjs';
import { upsertSoul } from '../agent-population.mjs';

const daemonAccount = 'worker';
const live = 'agent_11111111-1111-4111-8111-111111111111';

function state(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-identity-port-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const stateDir = path.join(base, 'state'), file = path.join(base, 'population.json');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const mint = (id) => mintAgentIdentity({ useGithub: false, gate: () => false, appSlug: null, harness: 'codex',
    transcript: { provider: 'codex', id: 't' }, stateDir, idFactory: () => id, now: () => new Date('2026-10-12T00:00:00.000Z') });
  const census = (id) => upsertSoul({ id, appSlug: null, parentId: null, status: 'active', spacePath: `/spaces/${id}`,
    worktree: null, worktrees: [], transcriptLocator: null, lastSeen: '2026-10-12T00:00:00.000Z' }, { file });
  mint(live); census(live);
  return { base, stateDir, file, record: path.join(stateDir, `${live}.json`) };
}

// Damage applied to the live soul's identity record, each of which the
// strict read refuses (and the default read is not changed by this PR).
const damages = {
  symlink: ({ base, record }) => { fs.renameSync(record, path.join(base, 'moved.json')); fs.symlinkSync(path.join(base, 'moved.json'), record); },
  hardlink: ({ base, record }) => fs.linkSync(record, path.join(base, 'second-link.json')),
  oversize: ({ record }) => { const value = JSON.parse(fs.readFileSync(record, 'utf8')); fs.writeFileSync(record, JSON.stringify(value).padEnd(IDENTITY_RECORD_MAX_BYTES + 1, ' ')); },
  'invalid record': ({ record }) => { const value = JSON.parse(fs.readFileSync(record, 'utf8')); fs.writeFileSync(record, JSON.stringify({ ...value, status: 'unknown' })); },
};
// A record owned by another uid, simulated through the injected stats.
const foreignIo = { ...fs, fstatSync: (fd) => { const info = fs.fstatSync(fd); return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: process.getuid() + 1 }); } };

test('the strict read accepts our own private record and refuses each custody failure', async (t) => {
  {
    const s = state(t);
    assert.equal(readAgentIdentity(live, { stateDir: s.stateDir, custody: 'strict' }).id, live);
    assert.throws(() => readAgentIdentity(live, { stateDir: s.stateDir, custody: 'strict', io: foreignIo }), /owned by this account/);
    assert.throws(() => readAgentIdentity(live, { stateDir: s.stateDir, custody: 'lenient' }), /custody must be/);
  }
  for (const [name, damage] of Object.entries(damages)) {
    await t.test(name, (tt) => {
      const s = state(tt);
      damage(s);
      assert.throws(() => readAgentIdentity(live, { stateDir: s.stateDir, custody: 'strict' }), /could not read Agent ID|is invalid/, name);
    });
  }
  // The default read every existing caller uses is unchanged: it still follows a link.
  const s = state(t);
  damages.symlink(s);
  assert.equal(readAgentIdentity(live, { stateDir: s.stateDir }).id, live);
});

test('the host port is a frozen, synchronous, strict read', (t) => {
  const s = state(t), port = createOwnerDecisionIdentityPort({ stateDir: s.stateDir });
  assert(Object.isFrozen(port));
  assert.deepEqual(Object.keys(port).sort(), ['kind', 'read']);
  assert.equal(port.kind, OWNER_DECISION_IDENTITY_PORT_KIND);
  const record = port.read(live);
  assert.equal(record.id, live); assert.equal(typeof record.then, 'undefined');
  damages.hardlink(s);
  assert.throws(() => port.read(live));
  assert.throws(() => createOwnerDecisionIdentityPort({ stateDir: 'relative' }));
});

test('the locked resolver resolves through the port and refuses uniformly otherwise', async (t) => {
  {
    const s = state(t), identityPort = createOwnerDecisionIdentityPort({ stateDir: s.stateDir });
    assert.deepEqual(resolveOwnerDecisionTargetLocked({ account: daemonAccount, soul: live }, { daemonAccount, file: s.file, identityPort }),
      { state: 'resolved', target: { account: daemonAccount, soul: live } });
    const record = identityPort.read(live);
    const ports = {
      missing: undefined, null: null,
      'not frozen': { kind: OWNER_DECISION_IDENTITY_PORT_KIND, read: () => record },
      'extra key': Object.freeze({ kind: OWNER_DECISION_IDENTITY_PORT_KIND, read: () => record, write: () => {} }),
      'wrong kind': Object.freeze({ kind: 'identity-read', read: () => record }),
      'read not a function': Object.freeze({ kind: OWNER_DECISION_IDENTITY_PORT_KIND, read: record }),
      'asynchronous read': Object.freeze({ kind: OWNER_DECISION_IDENTITY_PORT_KIND, read: async () => record }),
      // A thenable carrying every record field: refused because it is not a
      // synchronous result, even though its fields would classify as live.
      'thenable record': Object.freeze({ kind: OWNER_DECISION_IDENTITY_PORT_KIND, read: () => ({ ...record, then: () => {} }) }),
    };
    for (const [name, identityPort] of Object.entries(ports)) {
      assert.equal(resolveOwnerDecisionTargetLocked({ account: daemonAccount, soul: live }, { daemonAccount, file: s.file, identityPort }), TARGET_REFUSAL, name);
    }
    // A foreign-owned record through an otherwise valid port.
    const foreign = Object.freeze({ kind: OWNER_DECISION_IDENTITY_PORT_KIND, read: (id) => readAgentIdentity(id, { stateDir: s.stateDir, custody: 'strict', io: foreignIo }) });
    assert.equal(resolveOwnerDecisionTargetLocked({ account: daemonAccount, soul: live }, { daemonAccount, file: s.file, identityPort: foreign }), TARGET_REFUSAL);
  }
  for (const [name, damage] of Object.entries(damages)) {
    await t.test(name, (tt) => {
      const s = state(tt), identityPort = createOwnerDecisionIdentityPort({ stateDir: s.stateDir });
      damage(s);
      assert.equal(resolveOwnerDecisionTargetLocked({ account: daemonAccount, soul: live }, { daemonAccount, file: s.file, identityPort }), TARGET_REFUSAL, name);
    });
  }
});
