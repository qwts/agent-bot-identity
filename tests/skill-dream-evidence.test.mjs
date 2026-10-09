import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { captureDreamInputs } from '../skill-dream-inputs.mjs';
import { DREAM_EVIDENCE_LIMITS, verifyDreamRevisionEvidence } from '../skill-dream-evidence.mjs';
import { adoptSoulPackage, decideSoulProposal, editSoulRevision, proposeSoulRevision,
  revisionJournalRoot, revisionPackagePath } from '../soul-revisions.mjs';

const HASH = `sha256:${'0'.repeat(64)}`;
const SKILL = 'skills/example/SKILL.md';
const CANARY = 'JOURNAL_REASON_CANARY';
const changed = '---\nname: example\ndescription: Example skill\n---\nChanged instructions\n';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dream-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soul = path.join(root, 'example.soul');
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Evidence fixture', description: 'Fixture', displaySeed: 'fixture',
    preferredHarnesses: ['codex'], revision: HASH, parentRevision: null, template: false };
  const put = (name, bytes) => { const file = path.join(soul, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); };
  put('soul.json', JSON.stringify(manifest)); put('AGENTS.md', '# Definition\n'); put('soul.md', 'Current soul\n');
  put(SKILL, '---\nname: example\ndescription: Example skill\n---\nLearned instructions\n');
  manifest.revision = computePackageRevision(soul); put('soul.json', JSON.stringify(manifest));
  const options = { env: { HOME: root }, home: root, stateDir: path.join(root, 'state'), log: () => {},
    now: () => new Date('2026-10-09T12:00:00Z') };
  const identity = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: manifest.revision });
  const start = adoptSoulPackage(identity.id, soul, options).revision;
  // What the run was delivered: bounded inputs from the starting package.
  const packet = captureDreamInputs(revisionPackagePath(identity.id, start, options));
  const delivered = packet.sources.map(({ path: source, digest, truncated }) => ({ path: source, digest, truncated }));
  const journal = revisionJournalRoot(identity.id, options);
  const verify = (overrides = {}) => verifyDreamRevisionEvidence({ agentId: identity.id, startingRevision: start, delivered,
    stateDir: options.stateDir, ...overrides });
  const propose = (reason = `Refine ${CANARY}`) => proposeSoulRevision(identity.id, soul, { ...options, reason });
  return { root, soul, put, options, id: identity.id, start, delivered, journal, verify, propose };
}
const lastEvent = f => {
  for (let index = 0; ; index++) {
    try { readFileSync(path.join(f.journal, `${String(index).padStart(10, '0')}.json`)); }
    catch { return index - 1; }
  }
};
const eventFile = (f, index) => path.join(f.journal, `${String(index).padStart(10, '0')}.json`);
const filler = (f, count) => {
  let index = lastEvent(f) + 1;
  for (let i = 0; i < count; i++, index++) writeFileSync(eventFile(f, index), JSON.stringify({ schemaVersion: 1, kind: 'decision',
    proposalId: '00000000-0000-4000-8000-000000000000', author: 'user', reason: 'filler', at: '2026-10-09T12:00:00.000Z' }) + '\n');
};

test('a pending proposal that changes only delivered sources is verified change evidence, never attribution', t => {
  const f = fixture(t);
  f.put(SKILL, '---\nname: example\ndescription: Example skill\n---\nRefined instructions\n');
  const proposal = f.propose();
  const result = f.verify({ reference: { proposalId: proposal.proposalId },
    runWindow: { startedAt: '2026-10-09T11:00:00.000Z', endedAt: '2026-10-09T13:00:00.000Z' } });
  assert.equal(result.verdict, 'verified-change');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.attribution, 'not-established');
  assert.deepEqual(result.checked.event, { index: 1, kind: 'proposal', proposalId: proposal.proposalId, revision: proposal.revision,
    parentRevision: f.start, author: 'soul', at: '2026-10-09T12:00:00.000Z', status: 'pending' });
  assert.deepEqual(result.checked.objects, { parent: 'verified', candidate: 'verified' });
  assert.deepEqual(result.checked.changedPaths, [{ path: SKILL, change: 'modified' }]);
  assert.equal(result.checked.journalDiffMatches, true);
  assert.deepEqual(result.checked.outsideDelivered, []);
  assert.deepEqual(result.checked.deliveredMatchParent, { matched: ['AGENTS.md', SKILL, 'soul.md'].sort(), mismatched: [], missing: [] });
  assert.deepEqual(result.checked.truncatedChanged, []);
  assert.equal(result.checked.withinRunWindow, true);
  assert.ok(!JSON.stringify(result).includes(CANARY), 'journal reasons never reach the result');

  decideSoulProposal(f.id, proposal.proposalId, 'approve', { ...f.options, reason: `Approved ${CANARY}` });
  assert.equal(f.verify({ reference: { proposalId: proposal.proposalId } }).checked.event.status, 'approved');
  const revision = f.verify({ reference: { revision: proposal.revision } });
  assert.equal(revision.verdict, 'verified-change');
  assert.equal(revision.checked.event.kind, 'revision');
  assert.equal(revision.checked.event.proposalId, proposal.proposalId);
  assert.equal(revision.checked.journalDiffMatches, null, 'revision records carry no diff to cross-check');
  assert.ok(!JSON.stringify(revision).includes(CANARY));
});

test('truncated delivery is reported but does not block; run window and author are enforced', async t => {
  const f = fixture(t);
  f.put(SKILL, changed);
  const proposal = f.propose();
  const delivered = f.delivered.map(row => row.path === SKILL ? { ...row, truncated: true } : row);
  const truncated = f.verify({ delivered, reference: { proposalId: proposal.proposalId } });
  assert.equal(truncated.verdict, 'verified-change');
  assert.deepEqual(truncated.checked.truncatedChanged, [SKILL]);
  const late = f.verify({ reference: { proposalId: proposal.proposalId },
    runWindow: { startedAt: '2026-10-09T12:00:00.001Z', endedAt: '2026-10-09T13:00:00.000Z' } });
  assert.deepEqual([late.verdict, late.checked.withinRunWindow, late.reasons], ['not-verified', false, ['outside-run-window']]);

  f.put('soul.md', 'User edit\n');
  const edit = await editSoulRevision(f.id, f.soul, { ...f.options, reason: 'User edit' });
  const user = f.verify({ startingRevision: edit.parentRevision, reference: { revision: edit.revision } });
  assert.equal(user.verdict, 'not-verified');
  assert.ok(user.reasons.includes('author-not-soul'));
});

test('changes outside delivery, mismatched digests, wrong parents and tampered journals are not verified', t => {
  const f = fixture(t);
  f.put(SKILL, changed); f.put('notes.txt', 'new file\n');
  const proposal = f.propose(), reference = { proposalId: proposal.proposalId };
  const outside = f.verify({ reference });
  assert.deepEqual(outside.reasons, ['change-outside-delivered']);
  assert.deepEqual(outside.checked.outsideDelivered, ['notes.txt']);

  const g = fixture(t);
  g.put(SKILL, changed);
  const second = g.propose(), ref = { proposalId: second.proposalId };
  const wrongDigest = g.delivered.map(row => row.path === SKILL ? { ...row, digest: HASH } : row);
  const mismatch = g.verify({ delivered: wrongDigest, reference: ref });
  assert.deepEqual(mismatch.reasons, ['delivered-digest-mismatch']);
  assert.deepEqual(mismatch.checked.deliveredMatchParent.mismatched, [SKILL]);
  assert.deepEqual(g.verify({ startingRevision: second.revision, reference: ref }).reasons, ['parent-not-start']);

  const file = eventFile(g, 1), event = JSON.parse(readFileSync(file));
  writeFileSync(file, JSON.stringify({ ...event, diff: [{ path: 'AGENTS.md', change: 'modified' }] }) + '\n');
  assert.deepEqual(g.verify({ reference: ref }).reasons, ['journal-diff-mismatch']);
  writeFileSync(file, JSON.stringify({ ...event, at: 'yesterday' }) + '\n');
  assert.deepEqual(g.verify({ reference: ref }), { schemaVersion: 1, reference: ref, checked: null, verdict: 'not-verified',
    reasons: ['event-invalid'], attribution: 'not-established' });
  writeFileSync(file, JSON.stringify(event) + '\n');

  const object = path.join(g.journal, 'objects', `${second.revision.slice(7)}.soul`);
  writeFileSync(path.join(object, SKILL), changed.replace('Changed', 'Tampered'));
  assert.deepEqual(g.verify({ reference: ref }).checked.objects, { parent: 'verified', candidate: 'mismatch' });
  rmSync(object, { recursive: true });
  const missing = g.verify({ reference: ref });
  assert.deepEqual(missing.checked.objects, { parent: 'verified', candidate: 'missing' });
  assert.deepEqual(missing.reasons, ['candidate-object-missing']);
});

test('a bounded scan reports search-incomplete, never absence, beyond its window or at an unsafe record', t => {
  const f = fixture(t);
  f.put(SKILL, changed);
  const proposal = f.propose(), reference = { proposalId: proposal.proposalId };
  const unknown = { proposalId: '11111111-1111-4111-8111-111111111111' };
  assert.deepEqual(f.verify({ reference: unknown }).reasons, ['reference-not-found']);

  filler(f, DREAM_EVIDENCE_LIMITS.events - 2); // records 0..255: the whole journal fits the window
  assert.deepEqual(f.verify({ reference: unknown }).reasons, ['reference-not-found'], 'a whole-journal scan proves absence');
  filler(f, 1); // record 0 falls outside; the proposal (record 1) is the oldest scanned
  assert.equal(f.verify({ reference }).verdict, 'verified-change');
  assert.deepEqual(f.verify({ reference: unknown }).reasons, ['search-incomplete']);
  filler(f, 1);
  assert.deepEqual(f.verify({ reference }).reasons, ['search-incomplete']);

  const big = fixture(t);
  big.put(SKILL, changed);
  const early = big.propose();
  const pad = 'x'.repeat(DREAM_EVIDENCE_LIMITS.eventBytes - 1024);
  for (let index = 2, total = 0; total <= DREAM_EVIDENCE_LIMITS.journalBytes; index++, total += pad.length) {
    writeFileSync(eventFile(big, index), JSON.stringify({ schemaVersion: 1, kind: 'decision', pad }));
  }
  assert.deepEqual(big.verify({ reference: { proposalId: early.proposalId } }).reasons, ['search-incomplete'], 'aggregate journal bytes are bounded');

  for (const unsafe of ['oversized', 'symlink', 'hardlink', 'malformed']) {
    const g = fixture(t);
    g.put(SKILL, changed);
    const p = g.propose(), newest = eventFile(g, 2);
    if (unsafe === 'oversized') writeFileSync(newest, JSON.stringify({ pad: 'x'.repeat(DREAM_EVIDENCE_LIMITS.eventBytes) }));
    if (unsafe === 'symlink') symlinkSync(eventFile(g, 1), newest);
    if (unsafe === 'hardlink') { filler(g, 1); linkSync(newest, path.join(g.root, 'second-link')); }
    if (unsafe === 'malformed') writeFileSync(newest, '{"kind":');
    assert.deepEqual(g.verify({ reference: { proposalId: p.proposalId } }).reasons, ['search-incomplete'], unsafe);
  }
});

test('inputs are strictly validated and a missing journal is unavailable', t => {
  const f = fixture(t);
  const reference = { proposalId: '11111111-1111-4111-8111-111111111111' };
  const many = Array.from({ length: DREAM_EVIDENCE_LIMITS.delivered + 1 }, (_, i) => ({ path: `p${i}`, digest: HASH, truncated: false }));
  for (const overrides of [{ startingRevision: 'sha256:abc' }, { delivered: many }, { delivered: [...f.delivered, f.delivered[0]] },
    { delivered: [{ path: 'a', digest: HASH, truncated: false, extra: 1 }] }, { runWindow: { startedAt: '2026-10-09T13:00:00.000Z', endedAt: '2026-10-09T12:00:00.000Z' } },
    { agentId: '../escape' }]) {
    assert.throws(() => f.verify({ reference, ...overrides }), { code: 'dream-evidence-invalid' });
  }
  for (const bad of [{}, { proposalId: reference.proposalId, revision: HASH }, { proposalId: 'not-a-uuid' }, { revision: 'sha256:x' }, null]) {
    assert.throws(() => f.verify({ reference: bad }), { code: 'dream-evidence-reference' });
  }
  assert.throws(() => f.verify({ reference, stateDir: path.join(f.root, 'elsewhere') }), { code: 'dream-evidence-unavailable' });
});
