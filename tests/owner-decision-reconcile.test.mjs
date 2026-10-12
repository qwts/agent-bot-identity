// The owner-local, record-only owner-decision reconciliation (agent-comms#77,
// C2). Each test builds a real soul and revision journal and an owner-decision
// request that entered and published its linked event (slot 13) but crashed
// before slot 10, all in the scratch daemon's own state, then reconciles it as
// the daemon, with an injected owner ceremony.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import { adoptSoulPackage, decideSoulProposal, editSoulRevision, proposeSoulRevision, revisionJournalRoot } from '../soul-revisions.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { loadOrCreateVouchKey, vouchStateDir } from '../identity/vouch.mjs';
import { createOwnerDecisionTrustWriter, ownerDecisionTrustRoot } from '../identity/owner-decision-trust.mjs';
import { createDaemonJournalStore, initializeDaemonJournal, ownerDecisionJournalRoot } from '../identity/owner-decision-journal-store.mjs';
import { decodeDaemonJournalFrame, encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { challengeFor, completedRecordFor, enteredRecordFor } from '../identity/owner-decision-evidence.mjs';
import { createOwnerDecisionReconciler } from '../owner-decision-reconcile.mjs';
import { withCurrentObservation } from './helpers/owner-decision-trust-v1.mjs';
import { asDaemon } from './helpers/owner-decision-daemon-env.mjs';

const darwin = { skip: process.platform !== 'darwin' && 'the journal and trust locks are Darwin-only' };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url), 'utf8'));
const byId = (id) => evidence.records.find((record) => record.id === id).record;
const template = byId('approve-preparation');
const namespaceDigest = 'a'.repeat(64);
const AT = 2_000_000_010, NOW = 2_000_000_020_000;
const requestId = '11111111-1111-4111-8111-111111111111';
const rawKey = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;

// The soul's package directory, with a fresh revision each change. An edit's
// package names its parent, as the stored snapshot will.
function writePackage(dir, text, parentRevision = null) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test', preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision };
  fs.writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), text);
  manifest.revision = computePackageRevision(dir);
  fs.writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  return manifest.revision;
}

// A request for `operation` that entered and published slot 13 but not slot
// 10. `apply` makes an edit applying (not record-only); `noLinked` leaves
// slot 13 empty. A cold-wake request (the wake-on fixture) has no linked
// event of its own; slot 13 then holds unrelated bytes. `adoptDigest`
// signs an adopt for a package digest other than the one stored.
async function crashed(t, operation, { apply = false, noLinked = false, adoptDigest = null } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-reconcile-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(base, 'xdg') }, home = base;
  loadOrCreateVouchKey(vouchStateDir({ env }));
  const trust = { root: ownerDecisionTrustRoot({ env, home }), env, home };
  const trustWriter = withCurrentObservation(createOwnerDecisionTrustWriter({ ...trust, now: () => 1_999_999_000, legacyPresenceKey: null }), trust);
  trustWriter.enrollNamespace({ namespaceDigest });
  trustWriter.enrollKeys({ receiptKey: rawKey(), presenceKey: rawKey(), brokerUid: process.getuid() + 1 });

  // A real soul and revision journal in the daemon's own state directory.
  const stateDir = stateDirectory({ env, home }), packagePath = path.join(base, 'example.soul');
  const options = { env: { ...env, HOME: home }, home, stateDir, now: () => new Date('2026-10-12T12:00:00Z') };
  const firstRevision = writePackage(packagePath, 'Initial\n');
  const identity = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: firstRevision });
  const soul = identity.id;
  const files = () => fs.readdirSync(revisionJournalRoot(soul, { stateDir })).filter((n) => /^\d{10}\.json$/.test(n)).sort();
  const seqOf = (predicate) => files().map((n, i) => [i, JSON.parse(fs.readFileSync(path.join(revisionJournalRoot(soul, { stateDir }), n)))]).filter(([, r]) => predicate(r)).at(-1)?.[0];
  let parameters, expected, stage = null, apply_, base_ = template;
  if (operation === 'cold-wake.set') {
    parameters = { mode: 'on' };
    base_ = byId('wake-on-preparation');
    ({ expected, stage } = base_);
  } else if (operation === 'revision.adopt') {
    parameters = { stagingId: '00000000-0000-4000-8000-000000000004', packageDigest: adoptDigest ?? firstRevision.slice(7), expectedRevision: null, reason: 'Adopt' };
    expected = { kind: 'revision', head: null, proposal: null, destination: null };
    stage = { stagingId: parameters.stagingId, kind: 'package', contentDigest: parameters.packageDigest, expiresAt: 2_000_000_100 };
  } else {
    adoptSoulPackage(soul, packagePath, options);
    const head = { seq: seqOf((r) => r.kind === 'revision'), revision: firstRevision };
    if (operation === 'revision.edit') {
      const next = writePackage(packagePath, 'Edited\n', firstRevision);
      parameters = { stagingId: '00000000-0000-4000-8000-000000000004', packageDigest: next.slice(7), expectedRevision: firstRevision, reason: 'Edit', apply };
      expected = { kind: 'revision', head, proposal: null, destination: apply ? { rootDigest: 'd'.repeat(64), beforeInventoryDigest: 'e'.repeat(64) } : null };
      stage = { stagingId: parameters.stagingId, kind: 'package', contentDigest: parameters.packageDigest, expiresAt: 2_000_000_100 };
    } else {
      writePackage(packagePath, 'Proposed\n');
      const proposed = proposeSoulRevision(soul, packagePath, { ...options, reason: 'Improve' });
      const proposal = { proposalId: proposed.proposalId, seq: seqOf((r) => r.kind === 'proposal'), revision: proposed.revision, parentRevision: firstRevision };
      parameters = { proposalId: proposed.proposalId, expectedRevision: firstRevision, reason: 'Decided' };
      expected = { kind: 'revision', head, proposal, destination: null };
    }
  }
  apply_ = apply;
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal: template.principal, account: template.account, soul, operation, parameters }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal: template.principal, account: template.account, soul, operation,
    payloadDigest: sha256(action), namespaceDigest, acceptedAt: 2_000_000_000, daemonKey: template.daemonKey, daemonEpoch: 1, watchId: template.watchId,
    reservationBytes: 524288 };
  const preparation = { ...base_, requestId, soul, operation, payloadDigest: acceptance.payloadDigest, stage, expected, acceptedAt: 2_000_000_000,
    preparedAt: 2_000_000_000, exp: Math.min(2_000_000_180, stage?.expiresAt ?? Infinity) };
  const preparationBytes = Buffer.from(canonicalJson(preparation)), preparationDigest = sha256(preparationBytes);
  const receipt = Buffer.from('d1.payload.signature'), receiptDigest = sha256(receipt);

  // The daemon's own journal, holding the request through entry.
  const journalRoot = ownerDecisionJournalRoot({ env, home });
  initializeDaemonJournal(journalRoot);
  const open = (o = {}) => createDaemonJournalStore({ root: journalRoot, namespaceDigest, ...o });
  open().admit(action, Buffer.from(canonicalJson(acceptance)));
  const dir = path.join(journalRoot, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest, requestId, slot }));
  const read = (slot) => fs.readFileSync(path.join(dir, `${slot}.record`));
  const payload = (slot) => decodeDaemonJournalFrame(read(slot), { namespaceDigest, requestId, slot }).payload;
  write('preparation', preparationBytes);
  write('prepared-challenge', challengeFor(preparation, action));
  write('presence', Buffer.from('p1.payload.signature'));
  write('receipt', receipt);
  write('successful-check', Buffer.from(canonicalJson({ requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, daemonKey: acceptance.daemonKey,
    daemonEpoch: 1, watchId: acceptance.watchId, state: 'released', mayApply: true, exp: 2_000_000_060 })));
  const actionValue = JSON.parse(action);
  write('entered', Buffer.from(canonicalJson(enteredRecordFor({ preparation, preparationDigest, receiptDigest, action: actionValue, at: AT }))));

  // The effect step: the owner-decision revision record, under the soul's lock.
  const linkage = { requestId, payloadDigest: acceptance.payloadDigest, receiptDigest, effectId: preparation.effectId, preparationDigest };
  let record;
  if (!apply_ && operation !== 'cold-wake.set') {
    if (operation === 'revision.adopt') record = adoptSoulPackage(soul, packagePath, { ...options, ownerDecision: linkage });
    else if (operation === 'revision.edit') record = await editSoulRevision(soul, packagePath, { ...options, reason: 'Edit', ownerDecision: linkage });
    else record = decideSoulProposal(soul, parameters.proposalId, operation === 'revision.approve' ? 'approve' : 'reject', { ...options, reason: 'Decided', ownerDecision: linkage });
  }
  const recordFile = record && path.join(revisionJournalRoot(soul, { stateDir }), `${String(record.journalSeq).padStart(10, '0')}.json`);
  if (!noLinked) write('linked-authoritative-event', record ? fs.readFileSync(recordFile) : Buffer.from('{"not":"linked"}\n'));

  // The store's write, called directly (the reconciler checks most of what
  // it refuses first), with the journal record as the linked-event reader.
  const journalRecord = (seq) => fs.readFileSync(path.join(revisionJournalRoot(soul, { stateDir }), `${String(seq).padStart(10, '0')}.json`));
  const direct = (overrides = {}) => open().reconcileRecordOnlyCompletion(requestId, { journalSeq: record?.journalSeq ?? 0, readLinkedEvent: journalRecord,
    at: 2_000_000_015, auditId: '44444444-4444-4444-8444-444444444444', preimage: { v: 1, head: null, proposal: null, working: null }, ...overrides });
  const reconcile = (ceremony = () => ({ method: 'consent' })) => asDaemon({ env, home, now: NOW }, () => createOwnerDecisionReconciler({ ceremony })({ requestId }));
  const recover = () => open().recover(requestId);
  return { soul, stateDir, options, record, recordFile, write, read, payload, reconcile, direct, recover, open, preparation, trust, action: actionValue, entered: enteredRecordFor({ preparation,
    preparationDigest, receiptDigest, action: actionValue, at: AT }) };
}
const SLOTS = ['completed', 'terminal-pair', 'linked-authoritative-event'];
const snapshot = (c) => SLOTS.map((slot) => sha256(c.read(slot)));
function unchanged(c, run, expected) {
  const before = snapshot(c);
  assert.throws(run, expected);
  assert.deepEqual(snapshot(c), before);
}

test('each record-only operation reconciles: completed (slot 10), then the terminal pair', darwin, async (t) => {
  for (const operation of ['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit']) {
    await t.test(operation, async (tt) => {
      const c = await crashed(tt, operation);
      assert.deepEqual(c.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
      const done = c.reconcile();
      assert.equal(done.state, 'applied'); assert.equal(done.reconciled, 'completed');
      const completed = JSON.parse(c.payload('completed'));
      assert.equal(completed.phase, 'completed');
      assert.equal(completed.detail.journalSeq, c.record.journalSeq);
      assert.equal(completed.detail.journalRecordDigest, sha256(fs.readFileSync(c.recordFile)));
      assert.equal(completed.detail.working, null);
      const pair = JSON.parse(c.payload('terminal-pair'));
      assert.equal(pair.record.finding, 'applied');
      assert.equal(pair.record.basisDigest, sha256(c.payload('completed')));
      assert.match(pair.record.auditId, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
      assert.equal(pair.record.at, Math.floor(NOW / 1000));
      assert.deepEqual(c.recover().outcome, { code: 'applied', effectDigest: sha256(c.payload('completed')) });
    });
  }
});

test('an applying edit, a cold-wake request or no linked event is never reconciled', darwin, async (t) => {
  await t.test('an applying edit', async (tt) => {
    const c = await crashed(tt, 'revision.edit', { apply: true });
    unchanged(c, () => c.reconcile(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('a cold-wake request', async (tt) => {
    const c = await crashed(tt, 'cold-wake.set');
    unchanged(c, () => c.reconcile(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('no linked event', async (tt) => {
    const c = await crashed(tt, 'revision.approve', { noLinked: true });
    unchanged(c, () => c.reconcile(), { reason: 'owner-journal-transition-refused' });
  });
});

test('a linked event that is not in the revision journal, or not this request\'s, refuses', darwin, async (t) => {
  await t.test('slot 13 no longer matches the journal record', async (tt) => {
    const c = await crashed(tt, 'revision.approve');
    fs.chmodSync(c.recordFile, 0o600);
    fs.writeFileSync(c.recordFile, fs.readFileSync(c.recordFile, 'utf8').replace('"Decided"', '"Changed"'));
    unchanged(c, () => c.reconcile(), { reason: 'linked-event-missing' });
  });
  await t.test('slot 13 holds a record of another request', async (tt) => {
    const c = await crashed(tt, 'revision.approve');
    // The same journal record, with its linkage pointing elsewhere, both in the journal and slot 13.
    const changed = Buffer.from(fs.readFileSync(c.recordFile, 'utf8').replace(c.preparation.effectId, '33333333-3333-4333-8333-333333333333'));
    fs.chmodSync(c.recordFile, 0o600);
    fs.writeFileSync(c.recordFile, changed);
    c.write('linked-authoritative-event', changed);
    unchanged(c, () => c.reconcile(), { reason: 'owner-journal-linked-event-refused' });
  });
});

test('a non-empty slot 10 is a conflict and nothing is overwritten', darwin, async (t) => {
  const c = await crashed(t, 'revision.approve');
  c.write('completed', Buffer.from('{}'));
  let asked = false;
  unchanged(c, () => c.reconcile(() => { asked = true; }), { reason: 'owner-journal-conflict' });
  assert.equal(asked, false);
});

test('a refused ceremony writes nothing', darwin, async (t) => {
  const c = await crashed(t, 'revision.approve');
  unchanged(c, () => c.reconcile(() => { throw new Error('owner declined'); }), { reason: 'ceremony-refused' });
  assert.deepEqual(c.recover().outcome, { code: 'effect-uncertain', effectDigest: null });
});

test('a tampered stored package refuses', darwin, async (t) => {
  for (const operation of ['revision.approve', 'revision.adopt', 'revision.edit']) {
    await t.test(operation, async (tt) => {
      const c = await crashed(tt, operation);
      const objects = path.join(revisionJournalRoot(c.soul, { stateDir: c.stateDir }), 'objects', `${c.entered.detail.afterRevision.slice(7)}.soul`);
      const file = path.join(objects, 'AGENTS.md');
      fs.chmodSync(objects, 0o700); fs.chmodSync(file, 0o600);
      fs.writeFileSync(file, 'Tampered\n');
      unchanged(c, () => c.reconcile(), { reason: 'package-invalid' });
    });
  }
});

test('a crash between slot 10 and the pair is safe: applied, and a retry writes only the pair', darwin, async (t) => {
  const c = await crashed(t, 'revision.approve');
  // The first reconciliation stops right after slot 10 is durable.
  const first = c.open({ fault: (at) => { if (at === 'completed:trailer-flushed') throw new Error('crash'); } });
  const port = (seq) => fs.readFileSync(path.join(revisionJournalRoot(c.soul, { stateDir: c.stateDir }), `${String(seq).padStart(10, '0')}.json`));
  assert.throws(() => first.reconcileRecordOnlyCompletion(requestId, { journalSeq: c.record.journalSeq, readLinkedEvent: port, at: 2_000_000_015,
    auditId: '44444444-4444-4444-8444-444444444444', preimage: { v: 1, head: null, proposal: null, working: null } }));
  const completedBefore = c.read('completed');
  assert.equal(c.recover().state, 'applied');
  assert(c.read('terminal-pair').every((byte) => byte === 0));
  const retried = c.reconcile();
  assert.equal(retried.reconciled, 'pair');
  assert.deepEqual(c.read('completed'), completedBefore);
  assert.equal(JSON.parse(c.payload('terminal-pair')).record.basisDigest, sha256(c.payload('completed')));
  // Once the pair exists, a further reconciliation is a conflict, before any
  // ceremony.
  let asked = false;
  unchanged(c, () => c.reconcile(() => { asked = true; }), { reason: 'owner-journal-conflict' });
  assert.equal(asked, false);
});

test('a completed cold-wake request without its pair is not offered', darwin, async (t) => {
  const c = await crashed(t, 'cold-wake.set', { noLinked: true });
  c.write('completed', Buffer.from(canonicalJson(completedRecordFor({ entered: c.entered, action: c.action, at: AT + 1 }))));
  assert.equal(c.recover().state, 'applied');
  let asked = false;
  unchanged(c, () => c.reconcile(() => { asked = true; }), { reason: 'owner-journal-conflict' });
  assert.equal(asked, false);
});

test('the reconciler refuses a malformed request ID and an unreadable trust store', darwin, async (t) => {
  const c = await crashed(t, 'revision.approve');
  assert.throws(() => asDaemon({ env: c.trust.env, home: c.trust.home, now: NOW },
    () => createOwnerDecisionReconciler({ ceremony: () => {} })({ requestId: 'not-a-request' })), { reason: 'invalid-owner-journal-record' });
  fs.rmSync(path.join(c.trust.root, 'namespace.json'));
  unchanged(c, () => c.reconcile(), { reason: 'trust-unavailable' });
});

// The store's write refuses on its own, whatever the reconciler checked first.
test('the store write refuses bad input, a filled slot, and a linked event that is not exactly this request\'s', darwin, async (t) => {
  await t.test('malformed input', async (tt) => {
    const c = await crashed(tt, 'revision.approve');
    for (const bad of [{ journalSeq: -1 }, { journalSeq: 1.5 }, { readLinkedEvent: null }, { at: -1 }, { auditId: 'audit' }, { preimage: null }]) {
      unchanged(c, () => c.direct(bad), { reason: 'invalid-owner-journal-record' });
    }
    unchanged(c, () => c.direct({ preimage: { v: 1, pad: 'x'.repeat(4096) } }), { reason: 'invalid-owner-journal-record' });
    assert.throws(() => c.open().reconcileRecordOnlyCompletion('not-a-request', { journalSeq: 0, readLinkedEvent: () => null, at: 0,
      auditId: '44444444-4444-4444-8444-444444444444', preimage: {} }), { reason: 'invalid-owner-journal-record' });
  });
  await t.test('a filled terminal pair or completed slot', async (tt) => {
    const c = await crashed(tt, 'revision.approve');
    c.write('terminal-pair', Buffer.from('{}'));
    unchanged(c, () => c.direct(), { reason: 'owner-journal-conflict' });
    const d = await crashed(tt, 'revision.approve');
    d.write('completed', Buffer.from('{}'));
    unchanged(d, () => d.direct(), { reason: 'owner-journal-conflict' });
  });
  await t.test('no linked event', async (tt) => {
    const c = await crashed(tt, 'revision.approve', { noLinked: true });
    unchanged(c, () => c.direct(), { reason: 'owner-journal-transition-refused' });
  });
  await t.test('the reader returns other bytes than slot 13', async (tt) => {
    const c = await crashed(tt, 'revision.approve');
    unchanged(c, () => c.direct({ readLinkedEvent: () => Buffer.from('{}\n') }), { reason: 'owner-journal-linked-event-refused' });
  });
  await t.test('slot 13 and the reader agree on bytes that are not this request\'s event', async (tt) => {
    const c = await crashed(tt, 'revision.approve');
    const other = Buffer.from('{"kind":"note"}\n');
    c.write('linked-authoritative-event', other);
    unchanged(c, () => c.direct({ readLinkedEvent: () => other }), { reason: 'owner-journal-linked-event-refused' });
  });
  await t.test('a linked adopt whose revision is not the entered after-revision', async (tt) => {
    const c = await crashed(tt, 'revision.adopt', { adoptDigest: 'f'.repeat(64) });
    unchanged(c, () => c.direct(), { reason: 'owner-journal-linked-event-refused' });
  });
  await t.test('a completion time before entry', async (tt) => {
    const c = await crashed(tt, 'revision.approve');
    unchanged(c, () => c.direct({ at: AT - 1 }), { reason: 'invalid-owner-journal-record' });
  });
});
