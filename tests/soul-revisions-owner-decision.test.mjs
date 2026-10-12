// Owner-decision revision records (agent-comms#77, owner decision: keep
// schemaVersion 1): approve, reject, adopt and edit can carry the request
// linkage as an optional top-level `ownerDecision` with
// `authorization: {method: "owner-decision"}`. The records verify as the
// linked authoritative event, and the existing readers parse them unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import {
  adoptSoulPackage, createRevisionAppender, decideSoulProposal, editSoulRevision, listSoulProposals, proposeSoulRevision, revisionHistory,
  revisionJournalRoot,
} from '../soul-revisions.mjs';
import { verifyLinkedEvent } from '../identity/owner-decision-linked-event.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const linkage = (n = 1) => ({ requestId: `11111111-1111-4111-8111-11111111111${n}`, payloadDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64),
  effectId: `22222222-2222-4222-8222-22222222222${n}`, preparationDigest: 'c'.repeat(64) });

function fixture(t, { adopt = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-owner-decision-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = join(root, 'example.soul');
  mkdirSync(packagePath);
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test', preferredHarnesses: [],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Initial instructions\n');
  manifest.revision = computePackageRevision(packagePath);
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  const options = { env: { HOME: root }, home: root, stateDir: join(root, 'state'), now: () => new Date('2026-10-12T12:00:00Z') };
  const identity = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: computePackageRevision(packagePath) });
  const f = { root, packagePath, options, id: identity.id };
  if (adopt) adoptSoulPackage(f.id, packagePath, options);
  return f;
}
const journal = (f) => revisionJournalRoot(f.id, f.options);
const files = (f) => readdirSync(journal(f)).filter((name) => /^\d{10}\.json$/.test(name)).sort();
const lastBytes = (f) => readFileSync(join(journal(f), files(f).at(-1)));
const change = (f, text) => writeFileSync(join(f.packagePath, 'AGENTS.md'), text);
const propose = (f) => { change(f, `Proposed ${Math.random()}\n`); return proposeSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'Improve instructions' }); };

// The exact bytes the writer published verify as the linked event for that
// operation, with the linkage and its digest.
function verified(f, operation, link, proposalId) {
  const bytes = lastBytes(f);
  const event = verifyLinkedEvent(bytes, { operation, journalBytes: bytes, journalRecordDigest: sha256(bytes), linkage: link, proposalId });
  assert.equal(event.schemaVersion, 1);
  assert.deepEqual(event.authorization, { method: 'owner-decision' });
  assert.deepEqual(event.ownerDecision, link);
  return event;
}

test('approve, reject, adopt and edit records carry the linkage and verify as the linked event', async (t) => {
  await t.test('adopt', (tt) => {
    const f = fixture(tt, { adopt: false }), link = linkage(1);
    adoptSoulPackage(f.id, f.packagePath, { ...f.options, ownerDecision: link });
    verified(f, 'revision.adopt', link);
  });
  await t.test('edit', async (tt) => {
    const f = fixture(tt), link = linkage(2);
    change(f, 'Edited\n');
    await editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'Owner edit', ownerDecision: link });
    verified(f, 'revision.edit', link);
  });
  await t.test('approve', (tt) => {
    const f = fixture(tt), link = linkage(3), proposal = propose(f);
    decideSoulProposal(f.id, proposal.proposalId, 'approve', { ...f.options, reason: 'Reviewed', ownerDecision: link });
    const event = verified(f, 'revision.approve', link, proposal.proposalId);
    assert.equal(event.kind, 'revision'); assert.equal(event.approvedBy, 'user');
  });
  await t.test('reject', (tt) => {
    const f = fixture(tt), link = linkage(4), proposal = propose(f);
    decideSoulProposal(f.id, proposal.proposalId, 'reject', { ...f.options, reason: 'No', ownerDecision: link });
    assert.equal(verified(f, 'revision.reject', link, proposal.proposalId).kind, 'decision');
  });
});

test('the existing readers parse owner-decision records unchanged', (t) => {
  const f = fixture(t), approved = propose(f), rejected = propose(f);
  decideSoulProposal(f.id, approved.proposalId, 'approve', { ...f.options, reason: 'Yes', ownerDecision: linkage(5) });
  decideSoulProposal(f.id, rejected.proposalId, 'reject', { ...f.options, reason: 'No', ownerDecision: linkage(6) });
  // History, head and proposal status come out exactly as for any record.
  const history = revisionHistory(f.id, f.options);
  assert.equal(history.length, 2);
  assert.equal(history.at(-1).revision, approved.revision);
  assert.equal(history.at(-1).parentRevision, history[0].revision);
  const statuses = Object.fromEntries(listSoulProposals(f.id, f.options).map((p) => [p.proposalId, p.status]));
  assert.deepEqual(statuses, { [approved.proposalId]: 'approved', [rejected.proposalId]: 'rejected' });
  // An old reader that only knows the documented fields: every record is
  // still schemaVersion 1 JSON with kind and at, and the new field is extra.
  for (const name of files(f)) {
    const record = JSON.parse(readFileSync(join(journal(f), name), 'utf8'));
    assert.equal(record.schemaVersion, 1); assert.equal(typeof record.kind, 'string'); assert.equal(typeof record.at, 'string');
  }
  // Later ordinary edits still chain onto the owner-decision head.
  change(f, 'After\n');
  return editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'Later edit' }).then((edited) => {
    assert.equal(edited.parentRevision, approved.revision);
    assert.equal('ownerDecision' in JSON.parse(lastBytes(f)), false);
  });
});

test('a malformed or misplaced linkage refuses and writes nothing', async (t) => {
  const f = fixture(t);
  const refuses = async (run) => {
    const before = files(f).length;
    await assert.rejects(async () => run());
    assert.equal(files(f).length, before);
  };
  const { effectId, ...missing } = linkage(); void effectId;
  for (const bad of [null, [], 'x', missing, { ...missing, effectID: linkage().effectId }, Object.assign(Object.create({ effectId: linkage().effectId }), missing, { other: 1 }), { ...linkage(), extra: 1 }, { ...linkage(), requestId: 'nope' }, { ...linkage(), effectId: 'nope' },
    { ...linkage(), payloadDigest: 'A'.repeat(64) }, { ...linkage(), receiptDigest: 'b' }, { ...linkage(), preparationDigest: 7 }]) {
    change(f, `Edit ${Math.random()}\n`);
    await refuses(() => editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'x', ownerDecision: bad }));
  }
  // Never alongside another authorization, and never on other writers.
  change(f, 'Both\n');
  await refuses(() => editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'x', ownerDecision: linkage(), authorization: { method: 'consent' } }));
  await refuses(() => proposeSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'x', ownerDecision: linkage() }));
  const appended = revisionHistory(f.id, f.options).at(-1);
  await refuses(() => createRevisionAppender(f.packagePath, { ...f.options, reason: 'x', ownerDecision: linkage() })(
    { agentId: f.id, revision: computePackageRevision(f.packagePath) }));
  assert.equal(revisionHistory(f.id, f.options).at(-1).revision, appended.revision);
});

test('an owner-decision record too large for its journal slot refuses before writing', (t) => {
  const f = fixture(t);
  change(f, 'Large\n');
  const proposal = proposeSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'r'.repeat(17000) });
  const before = files(f).length;
  assert.throws(() => decideSoulProposal(f.id, proposal.proposalId, 'approve', { ...f.options, reason: 'Yes', ownerDecision: linkage() }),
    { code: 'owner-decision-linked-event-too-large' });
  assert.equal(files(f).length, before);
  // The same approval without the linkage (the local ceremony) still works.
  decideSoulProposal(f.id, proposal.proposalId, 'approve', { ...f.options, reason: 'Yes' });
  assert.equal(files(f).length, before + 1);
});

test('records without a linkage are byte-for-byte what they were', (t) => {
  const f = fixture(t), proposal = propose(f);
  decideSoulProposal(f.id, proposal.proposalId, 'approve', { ...f.options, reason: 'Yes', authorization: { method: 'consent' } });
  const record = JSON.parse(lastBytes(f));
  assert.deepEqual(Object.keys(record), ['schemaVersion', 'kind', 'revision', 'parentRevision', 'author', 'reason', 'proposalId', 'approval',
    'approvedBy', 'approvalReason', 'authorization', 'at']);
  assert.deepEqual(record.authorization, { method: 'consent' });
});
