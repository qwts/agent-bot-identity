// Disabled daemon owner-decision journal admission (#1007). Storage tests run
// only on Darwin, where the O_EXLOCK journal lock exists; schema and error
// mapping tests run everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { DAEMON_JOURNAL_FILES, decodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import {
  DAEMON_JOURNAL_LIMIT, acquireDaemonJournalLock, createDaemonJournalStore, initializeDaemonJournal, journalError,
  validateDaemonAdmission,
} from '../identity/owner-decision-journal-store.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/journal-budget-v1.json', import.meta.url), 'utf8'));
const darwin = { skip: process.platform !== 'darwin' && 'the journal lock is Darwin-only' };
const namespaceDigest = 'a'.repeat(64);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (reason, code = 'storage-failed') => ({ reason, code });

function request(requestId = '11111111-1111-4111-8111-111111111111', overrides = {}) {
  const template = fixture.administrativeRecords.find(({ id }) => id === 'acceptance-daemon').record;
  const action = Buffer.from(canonicalJson({
    v: 1, requestId, principal: template.principal, account: template.account, soul: template.soul,
    operation: template.operation, parameters: { proposalId: '00000000-0000-4000-8000-000000000003' },
  }));
  const acceptance = { ...template, requestId, namespaceDigest, payloadDigest: sha256(action), acceptedAt: 1_800_000_000, ...overrides };
  return { action, acceptance: Buffer.from(canonicalJson(acceptance)), requestId };
}

function freshRoot(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-journal-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'journal');
  initializeDaemonJournal(root);
  return root;
}
const requestsOf = (root) => path.join(root, 'requests');

test('admission validates the daemon acceptance record against the exact original action bytes', () => {
  const good = request();
  assert.equal(validateDaemonAdmission(good.action, good.acceptance, namespaceDigest).record.requestId, good.requestId);
  const bad = [
    [good.action, request(undefined, { reservationBytes: 262144 }).acceptance], // the broker's reservation
    [good.action, request(undefined, { namespaceDigest: 'b'.repeat(64) }).acceptance],
    [good.action, request(undefined, { payloadDigest: 'f'.repeat(64) }).acceptance],
    [good.action, request(undefined, { operation: 'revision.reject' }).acceptance],
    [good.action, request(undefined, { daemonEpoch: 0 }).acceptance],
    [good.action, request(undefined, { kind: 'authorization' }).acceptance],
    [good.action, request(undefined, { extra: true }).acceptance],
    [good.action, Buffer.from(` ${good.acceptance}`)],
    [Buffer.from(`${good.action}\n`), good.acceptance],
    [request('22222222-2222-4222-8222-222222222222').action, good.acceptance],
  ];
  for (const [action, acceptance] of bad) {
    assert.throws(() => validateDaemonAdmission(action, acceptance, namespaceDigest), refused('invalid-owner-journal-record', 'bad-request'));
  }
  assert.throws(() => validateDaemonAdmission(good.action, good.acceptance, 'b'.repeat(64)), { code: 'bad-request' });
});

test('internal journal reasons map only to the public non-authorizing codes', () => {
  assert.equal(journalError('owner-journal-capacity').code, 'journal-capacity');
  assert.equal(journalError('owner-journal-conflict').code, 'conflict');
  for (const reason of ['owner-journal-busy', 'owner-journal-corrupt', 'owner-journal-io', 'owner-journal-flush',
    'owner-journal-orphan', 'owner-journal-unsupported-phase', 'owner-journal-scratch-pending',
    'owner-journal-reopen-required', 'anything-else']) {
    assert.equal(journalError(reason).code, 'storage-failed');
  }
  assert.equal(journalError('owner-journal-platform-unsupported').code, 'owner-decision-unsupported');
  assert.equal(journalError('owner-journal-io').message, 'owner decision journal refused');
});

test('admission creates exactly the 15 fixed files at their EOFs and publishes action then acceptance', darwin, (t) => {
  const root = freshRoot(t), store = createDaemonJournalStore({ root, namespaceDigest }), input = request();
  const result = store.admit(input.action, input.acceptance);
  const name = requestDirectoryName({ namespaceDigest, requestId: input.requestId });
  assert.deepEqual(result, { state: 'admitted', requestId: input.requestId, directory: name,
    authorizationSupported: false, physicalAllocationSupported: false, physicalFlushGuaranteed: false });
  const dir = path.join(requestsOf(root), name);
  assert.equal(fs.statSync(dir).mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...DAEMON_JOURNAL_FILES].sort());
  for (const file of DAEMON_JOURNAL_FILES) {
    const info = fs.lstatSync(path.join(dir, file)), slot = file.replace(/\.record$/u, '');
    assert.equal(info.mode & 0o7777, 0o600); assert.equal(info.nlink, 1);
    if (slot === 'scratch') { assert.equal(info.size, 33024); continue; }
    const decoded = decodeDaemonJournalFrame(fs.readFileSync(path.join(dir, file)), { namespaceDigest, requestId: input.requestId, slot });
    if (slot === 'original-action') assert.deepEqual(decoded.payload, input.action);
    else if (slot === 'acceptance-context') assert.deepEqual(decoded.payload, input.acceptance);
    else assert.equal(decoded.kind, 'empty');
  }
  assert.equal(store.count(), 1);
});

test('a repeated namespace/request never starts a fresh admission', darwin, (t) => {
  const root = freshRoot(t), store = createDaemonJournalStore({ root, namespaceDigest }), input = request();
  store.admit(input.action, input.acceptance);
  const changed = request(input.requestId, { acceptedAt: 1_800_000_001 });
  assert.throws(() => createDaemonJournalStore({ root, namespaceDigest }).admit(changed.action, changed.acceptance),
    refused('owner-journal-conflict', 'conflict'));
  assert.equal(createDaemonJournalStore({ root, namespaceDigest }).count(), 1);
  // The same request ID under another enrolled namespace is a different directory.
  const other = createDaemonJournalStore({ root, namespaceDigest: 'b'.repeat(64) });
  const elsewhere = request(input.requestId, { namespaceDigest: 'b'.repeat(64) });
  other.admit(elsewhere.action, elsewhere.acceptance);
  assert.equal(other.count(), 2);
});

test('an interruption at any admission step leaves a charged orphan that is never fresh again', darwin, (t) => {
  const root = freshRoot(t);
  // Every point before acceptance-context's trailer is visible is an orphan.
  const points = ['request:directory-created', 'request:directory-flushed', 'initialize:presence.record:created',
    'initialize:scratch.record:zeroed', 'request:files-flushed', 'original-action:body-written',
    'original-action:trailer-written', 'acceptance-context:body-written', 'acceptance-context:body-flushed'];
  points.forEach((point, index) => {
    const requestId = `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`, input = request(requestId);
    const crashing = createDaemonJournalStore({ root, namespaceDigest, fault: (at) => { if (at === point) throw new Error('crash'); } });
    assert.throws(() => crashing.admit(input.action, input.acceptance), refused('owner-journal-io'));
    // This instance stays refused; a reopened store charges the orphan and refuses its key.
    assert.throws(() => crashing.count(), refused('owner-journal-reopen-required'));
    const reopened = createDaemonJournalStore({ root, namespaceDigest });
    assert.equal(reopened.count(), index + 1, point);
    assert.throws(() => reopened.admit(input.action, input.acceptance), refused('owner-journal-orphan'));
    assert.throws(() => createDaemonJournalStore({ root, namespaceDigest }).recover(requestId), refused('owner-journal-orphan'));
  });
});

test('storage faults refuse as storage-failed and retain the charged prefix', darwin, (t) => {
  const root = freshRoot(t);
  const faults = [
    ['owner-journal-flush', (io) => ({ ...io, fsyncSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } })],
    ['owner-journal-io', (io) => ({ ...io, writeSync: (fd, bytes, offset, length, position) => io.writeSync(fd, bytes, offset, Math.max(0, length - 1), position) })],
    ['owner-journal-io', (io) => ({ ...io, writeSync: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } })],
  ];
  faults.forEach(([reason, wrap], index) => {
    const input = request(`${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const store = createDaemonJournalStore({ root, namespaceDigest, io: wrap({ ...fs }) });
    assert.throws(() => store.admit(input.action, input.acceptance), (error) => error.code === 'storage-failed' && [reason, 'owner-journal-io'].includes(error.reason));
    assert.equal(createDaemonJournalStore({ root, namespaceDigest }).count(), index + 1);
  });
});

test('the 4096-request limit counts orphans across namespaces and refuses with journal-capacity', darwin, (t) => {
  const root = freshRoot(t);
  for (let index = 0; index < DAEMON_JOURNAL_LIMIT - 1; index++) {
    fs.mkdirSync(path.join(requestsOf(root), createHash('sha256').update(String(index)).digest('hex')), { mode: 0o700 });
  }
  const store = createDaemonJournalStore({ root, namespaceDigest });
  const last = request('ffffffff-0000-4000-8000-000000000000');
  store.admit(last.action, last.acceptance);
  assert.equal(store.count(), DAEMON_JOURNAL_LIMIT);
  const over = request('ffffffff-1111-4111-8111-111111111111', { namespaceDigest: 'c'.repeat(64) });
  assert.throws(() => createDaemonJournalStore({ root, namespaceDigest: 'c'.repeat(64) }).admit(over.action, over.acceptance),
    refused('owner-journal-capacity', 'journal-capacity'));
  assert.equal(fs.readdirSync(requestsOf(root)).length, DAEMON_JOURNAL_LIMIT);
  // Refusing at capacity does not poison the store for reads.
  assert.equal(store.count(), DAEMON_JOURNAL_LIMIT);
});

test('a request container past the limit refuses without listing it whole', darwin, (t) => {
  const root = freshRoot(t);
  for (let index = 0; index <= DAEMON_JOURNAL_LIMIT; index++) {
    fs.mkdirSync(path.join(requestsOf(root), createHash('sha256').update(String(index)).digest('hex')), { mode: 0o700 });
  }
  let read = 0;
  const io = { ...fs, readdirSync: () => assert.fail('the request container is never read whole'),
    opendirSync: (dir) => { const handle = fs.opendirSync(dir); return { readSync: () => { read++; return handle.readSync(); }, closeSync: () => handle.closeSync() }; } };
  const store = createDaemonJournalStore({ root, namespaceDigest, io }), input = request();
  assert.throws(() => store.admit(input.action, input.acceptance), refused('owner-journal-corrupt'));
  assert.equal(read, DAEMON_JOURNAL_LIMIT + 1);
  assert.throws(() => createDaemonJournalStore({ root, namespaceDigest, io }).count(), refused('owner-journal-corrupt'));
  assert.equal(fs.readdirSync(requestsOf(root)).length, DAEMON_JOURNAL_LIMIT + 1);
});

test('an unknown entry refuses every write and stays for inspection', darwin, (t) => {
  const root = freshRoot(t), input = request();
  fs.writeFileSync(path.join(requestsOf(root), 'stray'), '');
  assert.throws(() => createDaemonJournalStore({ root, namespaceDigest }).admit(input.action, input.acceptance), refused('owner-journal-corrupt'));
  assert.deepEqual(fs.readdirSync(requestsOf(root)), ['stray']);
});

test('the journal lock is a fixed inode: contention refuses, a missing lock is never recreated', darwin, (t) => {
  const root = freshRoot(t), input = request();
  const held = acquireDaemonJournalLock(root);
  try {
    assert.throws(() => createDaemonJournalStore({ root, namespaceDigest }).admit(input.action, input.acceptance), refused('owner-journal-busy'));
  } finally { fs.closeSync(held); }
  assert.equal(fs.readdirSync(requestsOf(root)).length, 0);
  fs.rmSync(path.join(root, '.journal-lock'));
  assert.throws(() => createDaemonJournalStore({ root, namespaceDigest }).admit(input.action, input.acceptance), refused('owner-journal-io'));
  assert.equal(fs.existsSync(path.join(root, '.journal-lock')), false);
  assert.throws(() => initializeDaemonJournal(root), { code: 'storage-failed' });
});

test('a killed lock holder releases the lock without any stale reclaim', darwin, async (t) => {
  const root = freshRoot(t), input = request();
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireDaemonJournalLock } from ${JSON.stringify(new URL('../identity/owner-decision-journal-store.mjs', import.meta.url).href)};
    acquireDaemonJournalLock(${JSON.stringify(root)}); process.stdout.write('held\\n'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  assert.throws(() => createDaemonJournalStore({ root, namespaceDigest }).admit(input.action, input.acceptance), refused('owner-journal-busy'));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));
  assert.equal(createDaemonJournalStore({ root, namespaceDigest }).admit(input.action, input.acceptance).state, 'admitted');
});
