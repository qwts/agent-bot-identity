// Disabled daemon owner-decision journal recovery (#1007): the recovery flush
// before any duplicate acknowledgement, and strict refusal of every graph that
// is not an exact committed admission prefix. Darwin-only, like the lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/journal-budget-v1.json', import.meta.url), 'utf8'));
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };
const namespaceDigest = 'a'.repeat(64);
const hash = (bytes) => createHash('sha256').update(bytes).digest();
const refused = (reason, code = 'storage-failed') => ({ reason, code });

function request(requestId = '11111111-1111-4111-8111-111111111111', overrides = {}) {
  const template = fixture.administrativeRecords.find(({ id }) => id === 'acceptance-daemon').record;
  const action = Buffer.from(canonicalJson({
    v: 1, requestId, principal: template.principal, account: template.account, soul: template.soul,
    operation: template.operation, parameters: {},
  }));
  const acceptance = { ...template, requestId, namespaceDigest, payloadDigest: hash(action).toString('hex'), acceptedAt: 1_800_000_000, ...overrides };
  return { action, acceptance: Buffer.from(canonicalJson(acceptance)), requestId };
}

// An admitted request in a fresh store, and helpers to reach its files.
function admitted(t, input = request()) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-journal-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  createDaemonJournalStore({ root, namespaceDigest }).admit(input.action, input.acceptance);
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId: input.requestId }));
  const file = (slot) => path.join(dir, `${slot}.record`);
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
  return { root, dir, file, snapshot, input };
}
const reopen = (root, options = {}) => createDaemonJournalStore({ root, namespaceDigest, ...options });

test('recover reports absent only when the directory does not exist and writes nothing', darwin, (t) => {
  const { root, snapshot, input } = admitted(t);
  const before = snapshot();
  assert.deepEqual(reopen(root).recover('22222222-2222-4222-8222-222222222222'), { state: 'absent', requestId: '22222222-2222-4222-8222-222222222222' });
  assert.deepEqual(createDaemonJournalStore({ root, namespaceDigest: 'b'.repeat(64) }).recover(input.requestId), { state: 'absent', requestId: input.requestId });
  const recovered = reopen(root).recover(input.requestId);
  assert.equal(recovered.recovered, true); assert.equal(recovered.authorizationSupported, false); assert.equal(recovered.physicalFlushGuaranteed, false);
  assert.deepEqual(snapshot(), before);
  assert.throws(() => reopen(root).recover('not-a-request'), refused('invalid-owner-journal-record', 'bad-request'));
});

test('an exact duplicate is acknowledged only after its recovery flush and never writes again', darwin, (t) => {
  const { root, snapshot, input } = admitted(t);
  const before = snapshot(), seen = [];
  const result = reopen(root, { fault: (at) => seen.push(at) }).admit(input.action, input.acceptance);
  assert.equal(result.duplicate, true); assert.equal(result.state, 'admitted');
  assert.deepEqual(seen, ['recovery:original-action:flushed', 'recovery:acceptance-context:flushed', 'recovery:directories-flushed']);
  assert.deepEqual(snapshot(), before);
  // A crash or flush failure inside recovery acknowledges nothing.
  for (const point of seen) {
    assert.throws(() => reopen(root, { fault: (at) => { if (at === point) throw new Error('crash'); } }).admit(input.action, input.acceptance),
      refused('owner-journal-io'));
  }
  const failingFlush = { ...fs, fsyncSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
  assert.throws(() => reopen(root, { io: failingFlush }).admit(input.action, input.acceptance), refused('owner-journal-flush'));
  assert.throws(() => reopen(root, { io: failingFlush }).recover(input.requestId), refused('owner-journal-flush'));
  assert.deepEqual(snapshot(), before);
});

test('a visible acceptance trailer from before a crash is settled only through the recovery flush', darwin, (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-journal-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal'), input = request();
  initializeDaemonJournal(root);
  const crashing = reopen(root, { fault: (at) => { if (at === 'acceptance-context:trailer-written') throw new Error('crash'); } });
  assert.throws(() => crashing.admit(input.action, input.acceptance), refused('owner-journal-io'));
  const seen = [];
  assert.equal(reopen(root, { fault: (at) => seen.push(at) }).admit(input.action, input.acceptance).duplicate, true);
  assert(seen.includes('recovery:acceptance-context:flushed'));
});

// Writes a committed frame for `slot` with an arbitrary producer role and
// recomputed checksums, as a same-account writer could.
function forgedFrame(payload, { requestId, slot, cap, role }) {
  const frame = encodeDaemonJournalFrame(payload, { namespaceDigest, requestId, slot });
  const context = hash(Buffer.from(canonicalJson({ namespaceDigest, requestId, role, slot, v: 1 })));
  context.copy(frame, 32); context.copy(frame, cap + 128 + 64);
  hash(Buffer.concat([Buffer.from('owner-journal-frame-v1\n'), frame.subarray(0, cap + 128)])).copy(frame, cap + 128 + 32);
  return frame;
}

test('strict graph refusal: every damaged, foreign or unsupported graph refuses and nothing is recreated', darwin, async (t) => {
  const cases = [
    ['a committed later phase', ({ file, input }) => fs.writeFileSync(file('preparation'),
      encodeDaemonJournalFrame(Buffer.from('{}'), { namespaceDigest, requestId: input.requestId, slot: 'preparation' })), 'owner-journal-unsupported-phase'],
    ['a partial later phase', ({ file, input }) => {
      const frame = encodeDaemonJournalFrame(Buffer.from('{}'), { namespaceDigest, requestId: input.requestId, slot: 'entered' });
      frame.fill(0, 4096 + 128); fs.writeFileSync(file('entered'), frame);
    }, 'owner-journal-unsupported-phase'],
    ['nonzero scratch', ({ file }) => { const fd = fs.openSync(file('scratch'), 'r+'); fs.writeSync(fd, Buffer.from([1]), 0, 1, 100); fs.closeSync(fd); }, 'owner-journal-scratch-pending'],
    ['a flipped action bit', ({ file }) => { const bytes = fs.readFileSync(file('original-action')); bytes[200] ^= 1; fs.writeFileSync(file('original-action'), bytes); }, 'owner-journal-corrupt'],
    ['a broker-role acceptance frame with valid checksums', ({ file, input }) => fs.writeFileSync(file('acceptance-context'),
      forgedFrame(input.acceptance, { requestId: input.requestId, slot: 'acceptance-context', cap: 4096, role: 'broker' })), 'owner-journal-corrupt'],
    ['another request\'s acceptance-context', ({ file }) => {
      const other = request('33333333-3333-4333-8333-333333333333');
      fs.writeFileSync(file('acceptance-context'), encodeDaemonJournalFrame(other.acceptance, { namespaceDigest, requestId: other.requestId, slot: 'acceptance-context' }));
    }, 'owner-journal-corrupt'],
    ['an extra file', ({ dir }) => fs.writeFileSync(path.join(dir, 'extra.record'), ''), 'owner-journal-corrupt'],
    ['a missing file', ({ file }) => fs.rmSync(file('receipt')), 'owner-journal-orphan'],
    ['a symlinked slot', ({ file, root }) => { fs.renameSync(file('presence'), path.join(root, '..', 'moved')); fs.symlinkSync(path.join(root, '..', 'moved'), file('presence')); }, 'owner-journal-io'],
    ['a hard-linked slot', ({ file, root }) => fs.linkSync(file('completed'), path.join(root, '..', 'second-link')), 'owner-journal-corrupt'],
    ['a truncated slot', ({ file }) => fs.truncateSync(file('successful-check'), 10), 'owner-journal-corrupt'],
    ['a widened mode', ({ file }) => fs.chmodSync(file('linked-authoritative-event'), 0o644), 'owner-journal-corrupt'],
  ];
  for (const [name, damage, reason] of cases) {
    await t.test(name, (tt) => {
      const journal = admitted(tt);
      damage(journal);
      const before = journal.snapshot();
      assert.throws(() => reopen(journal.root).recover(journal.input.requestId), refused(reason), name);
      assert.throws(() => reopen(journal.root).admit(journal.input.action, journal.input.acceptance), refused(reason), name);
      assert.deepEqual(journal.snapshot(), before, `${name}: retained as found`);
      // A refused graph poisons only that instance's writes; the count still charges it.
      assert.equal(reopen(journal.root).count(), 1);
    });
  }
});

test('a committed or damaged entered slot is effect-uncertain, never refused, applied or retried', darwin, async (t) => {
  const enteredFrame = (input) => encodeDaemonJournalFrame(Buffer.from('{}'), { namespaceDigest, requestId: input.requestId, slot: 'entered' });
  const cases = [
    ['committed entered with empty completed', ({ file, input }) => fs.writeFileSync(file('entered'), enteredFrame(input))],
    ['committed entered and an unvalidated completed', ({ file, input }) => {
      fs.writeFileSync(file('entered'), enteredFrame(input));
      fs.writeFileSync(file('completed'), encodeDaemonJournalFrame(Buffer.from('{}'), { namespaceDigest, requestId: input.requestId, slot: 'completed' }));
    }],
    ['a damaged entered frame', ({ file, input }) => { const frame = enteredFrame(input); frame[300] ^= 1; fs.writeFileSync(file('entered'), frame); }],
  ];
  for (const [name, damage] of cases) {
    await t.test(name, (tt) => {
      const journal = admitted(tt);
      damage(journal);
      const before = journal.snapshot(), seen = [];
      const recovered = reopen(journal.root, { fault: (at) => seen.push(at) }).recover(journal.input.requestId);
      assert.equal(recovered.state, 'indeterminate');
      assert.deepEqual(recovered.outcome, { code: 'effect-uncertain', effectDigest: null });
      assert.equal(recovered.authorizationSupported, false);
      // The nonzero entered bytes are flushed before anything is reported.
      assert(seen.includes('recovery:entered:flushed'));
      const duplicate = reopen(journal.root).admit(journal.input.action, journal.input.acceptance);
      assert.equal(duplicate.state, 'indeterminate'); assert.equal(duplicate.duplicate, true);
      assert.deepEqual(journal.snapshot(), before);
    });
  }
  // A body without its trailer is a partial entered write: no effect can have started.
  const partial = admitted(t);
  const frame = enteredFrame(partial.input); frame.fill(0, 4096 + 128); fs.writeFileSync(partial.file('entered'), frame);
  assert.throws(() => reopen(partial.root).recover(partial.input.requestId), refused('owner-journal-unsupported-phase'));
});

test('a request directory past its 15 files refuses without listing it whole', darwin, (t) => {
  const journal = admitted(t);
  for (let index = 0; index < 100; index++) fs.writeFileSync(path.join(journal.dir, `extra-${index}`), '');
  let read = 0;
  const io = { ...fs, readdirSync: () => assert.fail('directories are never read whole'),
    opendirSync: (dir) => { const handle = fs.opendirSync(dir); return { readSync: () => { read++; return handle.readSync(); }, closeSync: () => handle.closeSync() }; } };
  assert.throws(() => reopen(journal.root, { io }).recover(journal.input.requestId), refused('owner-journal-corrupt'));
  // Two reads for the one-entry request container, then 16 stopping the request directory.
  assert.equal(read, 2 + 16);
});
