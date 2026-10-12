// No owner-decision custody reader can be blocked by a FIFO at the path it
// opens (agent-comms#77): each opens non-blocking and refuses anything but a
// regular file. A blocking open would hang the whole process, so each read
// runs in a child process killed after a short timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { canonicalJson } from '../canonical-json.mjs';
import { mintAgentIdentity } from '../identity/agent-identity.mjs';
import { loadOrCreateVouchKey, vouchKeyPath, vouchStateDir } from '../identity/vouch.mjs';
import { createOwnerDecisionTrustWriter } from '../identity/owner-decision-trust.mjs';
import { createDaemonJournalStore, initializeDaemonJournal } from '../identity/owner-decision-journal-store.mjs';
import { requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { presencePinPath } from '../identity/owner-presence.mjs';
import { commsCredentialFile } from '../comms-client.mjs';
import { withCurrentObservation } from './helpers/owner-decision-trust-v1.mjs';

const darwin = { skip: process.platform !== 'darwin' && 'the trust and journal locks are Darwin-only', timeout: 20000 };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mkfifo = (file) => assert.equal(spawnSync('mkfifo', [file]).status, 0);
const module = (name) => JSON.stringify(new URL(`../identity/${name}`, import.meta.url).href);

function scratch(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-fifo-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
// Replaces `file` with a FIFO, runs `body` in a child, and always removes the
// FIFO afterwards (nothing left behind). Returns whether the child hung and
// what it printed (the error message, or "read").
function fifoAt(file, body) {
  fs.rmSync(file, { force: true });
  mkfifo(file);
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `try { ${body}; console.log('read'); } catch (error) { console.log('refused'); }`],
      { timeout: 5000, encoding: 'utf8' });
    return { hung: child.signal === 'SIGTERM' || child.error?.code === 'ETIMEDOUT', out: child.stdout.trim() };
  } finally {
    fs.rmSync(file, { force: true });
    assert.equal(fs.existsSync(file), false);
  }
}
const refusesAtOnce = (result) => { assert.equal(result.hung, false, 'the read blocked on a FIFO'); assert.equal(result.out, 'refused'); };

test('the vouch key read', { timeout: 20000 }, (t) => {
  const base = scratch(t), env = { XDG_STATE_HOME: path.join(base, 'state') };
  loadOrCreateVouchKey(vouchStateDir({ env }));
  refusesAtOnce(fifoAt(vouchKeyPath(vouchStateDir({ env })),
    `const { vouchDaemonKey } = await import(${module('vouch.mjs')}); vouchDaemonKey({ env: ${JSON.stringify(env)} })`));
});

test('the strict identity read', { timeout: 20000 }, (t) => {
  const base = scratch(t), stateDir = path.join(base, 'identity'), soul = 'agent_00000000-0000-4000-8000-000000000001';
  fs.mkdirSync(stateDir, { mode: 0o700 });
  mintAgentIdentity({ useGithub: false, gate: () => false, appSlug: null, harness: 'codex', transcript: { provider: 'codex', id: 't' },
    stateDir, idFactory: () => soul, now: () => new Date('2026-10-12T00:00:00.000Z') });
  refusesAtOnce(fifoAt(path.join(stateDir, `${soul}.json`),
    `const { readAgentIdentity } = await import(${module('agent-identity.mjs')}); readAgentIdentity(${JSON.stringify(soul)}, { stateDir: ${JSON.stringify(stateDir)}, custody: 'strict' })`));
});

test('the trust store reads', darwin, (t) => {
  const base = scratch(t), env = { XDG_STATE_HOME: path.join(base, 'state') }, root = path.join(base, 'trust');
  loadOrCreateVouchKey(vouchStateDir({ env }));
  createOwnerDecisionTrustWriter({ root, env, home: base, legacyPresenceKey: null }).enrollNamespace({ namespaceDigest: 'a'.repeat(64) });
  refusesAtOnce(fifoAt(path.join(root, 'namespace.json'),
    `const { readOwnerDecisionNamespace } = await import(${module('owner-decision-trust.mjs')}); readOwnerDecisionNamespace({ root: ${JSON.stringify(root)} })`));
});

test('the journal slot reads', darwin, (t) => {
  const base = scratch(t), root = path.join(base, 'journal'), namespaceDigest = 'a'.repeat(64);
  initializeDaemonJournal(root);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal: 'principal_00000000-0000-4000-8000-000000000002', account: 'qwts',
    soul: 'agent_00000000-0000-4000-8000-000000000001', operation: 'revision.reject', parameters: { proposalId: '00000000-0000-4000-8000-000000000003', expectedRevision: `sha256:${'a'.repeat(64)}`, reason: 'No' } }));
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal: 'principal_00000000-0000-4000-8000-000000000002', account: 'qwts',
    soul: 'agent_00000000-0000-4000-8000-000000000001', operation: 'revision.reject', payloadDigest: sha256(action), namespaceDigest, acceptedAt: 2_000_000_000,
    daemonKey: 'c'.repeat(64), daemonEpoch: 1, watchId: '11111111-1111-4111-8111-111111111111', reservationBytes: 524288 };
  createDaemonJournalStore({ root, namespaceDigest }).admit(action, Buffer.from(canonicalJson(acceptance)));
  const dir = path.join(root, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  refusesAtOnce(fifoAt(path.join(dir, 'preparation.record'),
    `const { createDaemonJournalStore } = await import(${module('owner-decision-journal-store.mjs')}); createDaemonJournalStore({ root: ${JSON.stringify(root)}, namespaceDigest: ${JSON.stringify(namespaceDigest)} }).recover(${JSON.stringify(requestId)})`));
});

test('the versioned trust writer\'s vouch identity read', darwin, (t) => {
  const base = scratch(t), env = { XDG_STATE_HOME: path.join(base, 'state') }, root = path.join(base, 'trust');
  loadOrCreateVouchKey(vouchStateDir({ env }));
  createOwnerDecisionTrustWriter({ root, env, home: base, legacyPresenceKey: null }).enrollNamespace({ namespaceDigest: 'a'.repeat(64) });
  refusesAtOnce(fifoAt(vouchKeyPath(vouchStateDir({ env })), `const { generateKeyPairSync } = await import('node:crypto');
const key = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
const { createOwnerDecisionTrustWriter } = await import(${module('owner-decision-trust.mjs')});
createOwnerDecisionTrustWriter({ root: ${JSON.stringify(root)}, env: ${JSON.stringify(env)}, home: ${JSON.stringify(base)}, legacyPresenceKey: null })
  .enrollKeysV1({ receiptKey: key(), presenceKey: key(), brokerUid: ${process.getuid() + 1}, expectedObservationDigest: 'a'.repeat(64) })`));
});

test('keyd\'s presence pin cache: a FIFO is no pin, never a hang', darwin, (t) => {
  const base = scratch(t), env = { XDG_STATE_HOME: path.join(base, 'state') }, root = path.join(base, 'trust');
  loadOrCreateVouchKey(vouchStateDir({ env }));
  createOwnerDecisionTrustWriter({ root, env, home: base, legacyPresenceKey: null }).enrollNamespace({ namespaceDigest: 'a'.repeat(64) });
  const cache = presencePinPath({ env, home: base });
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  // Readiness reads the cache as a deny-list; with a FIFO there it reads no
  // pin and goes on (here to no active key), at once.
  refusesAtOnce(fifoAt(cache, `const { readOwnerDecisionTrust } = await import(${module('owner-decision-trust.mjs')});
readOwnerDecisionTrust({ root: ${JSON.stringify(root)}, env: ${JSON.stringify(env)}, home: ${JSON.stringify(base)} })`));
});

test('the comms pairing credential read', { timeout: 20000 }, (t) => {
  const base = scratch(t), env = { XDG_STATE_HOME: path.join(base, 'state') };
  const file = commsCredentialFile({ env, home: base });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  refusesAtOnce(fifoAt(file, `const { loadCommsCredential } = await import(${JSON.stringify(new URL('../comms-client.mjs', import.meta.url).href)});
loadCommsCredential({ env: ${JSON.stringify(env)}, home: ${JSON.stringify(base)} })`));
});

test('the soul census read', { timeout: 20000 }, (t) => {
  const base = scratch(t), file = path.join(base, 'population.json');
  refusesAtOnce(fifoAt(file, `const { listSouls } = await import(${JSON.stringify(new URL('../agent-population.mjs', import.meta.url).href)});
listSouls({ file: ${JSON.stringify(file)} })`));
});

// The audit append opens non-blocking, but a FIFO with an active reader still
// opens. The descriptor is checked before any byte is written, so the reader
// gets nothing and the append refuses.
test('the trust audit append: a FIFO with an active reader swapped in gets no bytes', darwin, async (t) => {
  const base = scratch(t), env = { XDG_STATE_HOME: path.join(base, 'state') }, root = path.join(base, 'trust');
  loadOrCreateVouchKey(vouchStateDir({ env }));
  const fifo = path.join(base, 'swap.fifo'), received = path.join(base, 'received');
  mkfifo(fifo);
  fs.writeFileSync(received, '');
  // The reader opens the FIFO non-blocking and copies whatever arrives.
  const reader = spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';
const fd = fs.openSync(${JSON.stringify(fifo)}, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK), buffer = Buffer.alloc(65536);
console.log('ready');
for (;;) {
  try { const n = fs.readSync(fd, buffer); if (n > 0) fs.appendFileSync(${JSON.stringify(received)}, buffer.subarray(0, n)); }
  catch (error) { if (error.code !== 'EAGAIN') throw error; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const audit = path.join(root, 'audit.jsonl');
  try {
    await new Promise((resolve, reject) => {
      reader.stdout.once('data', resolve); reader.once('exit', () => reject(new Error('reader exited')));
    });
    // Swap the live FIFO in at the audit path right before the append.
    const writer = createOwnerDecisionTrustWriter({ root, env, home: base, legacyPresenceKey: null,
      fault: (at) => { if (at === 'namespace:published') fs.renameSync(fifo, audit); } });
    assert.throws(() => writer.enrollNamespace({ namespaceDigest: 'a'.repeat(64) }), { reason: 'owner-trust-custody' });
    assert.equal(fs.lstatSync(audit).isFIFO(), true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.readFileSync(received).length, 0, 'audit bytes reached the FIFO reader');
  } finally {
    reader.kill('SIGKILL');
    await new Promise((resolve) => { if (reader.exitCode !== null || reader.signalCode !== null) resolve(); else reader.once('exit', resolve); });
    fs.rmSync(fifo, { force: true }); fs.rmSync(audit, { force: true });
    assert.equal(fs.existsSync(audit) || fs.existsSync(fifo), false);
  }
});

// The same descriptor check refuses an existing audit file that changes
// between the open and the write: made group-writable, given a second link,
// or replaced at the name. (A file owned by another uid can't be made here
// without privilege, so the uid condition has no test of its own.)
test('the trust audit append refuses a changed audit file before writing', darwin, async (t) => {
  const cases = {
    'group-writable': (audit) => fs.chmodSync(audit, 0o620),
    'a second link': (audit) => fs.linkSync(audit, `${audit}.link`),
    'another file at the name': (audit) => { fs.renameSync(audit, `${audit}.moved`); fs.writeFileSync(audit, '', { mode: 0o600 }); },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, (tt) => {
      const base = scratch(tt), env = { XDG_STATE_HOME: path.join(base, 'state') }, root = path.join(base, 'trust');
      loadOrCreateVouchKey(vouchStateDir({ env }));
      const audit = path.join(root, 'audit.jsonl');
      let armed = false;
      const io = { ...fs, openSync(file, ...rest) {
        const fd = fs.openSync(file, ...rest);
        // Only the append's open (O_APPEND), not the store's earlier reads.
        if (armed && file === audit && (rest[0] & fs.constants.O_APPEND)) { armed = false; change(audit); }
        return fd;
      } };
      const trust = { root, env, home: base, legacyPresenceKey: null };
      const writer = withCurrentObservation(createOwnerDecisionTrustWriter({ ...trust, io }), trust);
      writer.enrollNamespace({ namespaceDigest: 'a'.repeat(64) });
      const before = fs.readFileSync(audit);
      armed = true;
      const key = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
      assert.throws(() => writer.enrollKeys({ receiptKey: key(), presenceKey: key(), brokerUid: process.getuid() + 1 }), { reason: 'owner-trust-custody' });
      assert.equal(armed, false, 'the audit append was not reached');
      // Nothing was appended to the file the append opened.
      const opened = name === 'another file at the name' ? `${audit}.moved` : audit;
      assert.deepEqual(fs.readFileSync(opened), before);
    });
  }
});
