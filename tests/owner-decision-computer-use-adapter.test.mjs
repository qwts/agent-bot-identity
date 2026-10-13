// The computer-use owner-decision adapter (agent-comms#250, first phase):
// disabled, no route. Each test builds a complete released
// `soul.computer-use.set` request in scratch state, as the effect-gate tests
// do: a scratch vouch key, trust records with a test native presence signer,
// the request journal at `released`, and a census and identity record for its
// soul. Crash points run the adapter in a child process that kills itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../canonical-json.mjs';
import { applyComputerUseOwnerDecision } from '../owner-decision-computer-use.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { populationFile, showSoul, updateSoulStatus, upsertSoul, sealComputerUseOwnerDecision } from '../agent-population.mjs';
import { commsCredentialFile } from '../comms-client.mjs';
import { auditFile } from '../identity-format.mjs';
import { lockOwnerToken } from '../file-lock.mjs';
import { mintAgentIdentity } from '../identity/agent-identity.mjs';
import { loadOrCreateVouchKey, vouchStateDir } from '../identity/vouch.mjs';
import { createOwnerDecisionTrustWriter, ownerDecisionTrustRoot } from '../identity/owner-decision-trust.mjs';
import { withCurrentObservation } from './helpers/owner-decision-trust-v1.mjs';
import { asDaemon } from './helpers/owner-decision-daemon-env.mjs';
import { createDaemonJournalStore, initializeDaemonJournal, ownerDecisionJournalRoot } from '../identity/owner-decision-journal-store.mjs';
import { encodeDaemonJournalFrame, requestDirectoryName } from '../identity/owner-decision-journal-frame.mjs';
import { challengeFor } from '../identity/owner-decision-evidence.mjs';
import { decodeOwnerDecisionAction } from '../identity/owner-decision-action.mjs';
import { rawEd25519 } from './helpers/ed25519-raw.mjs';

const darwin = { skip: process.platform !== 'darwin' && 'the journal and trust locks are Darwin-only' };
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-decisions/effect-evidence-v1.json', import.meta.url), 'utf8'));
const template = evidence.records.find(({ id }) => id === 'approve-preparation').record;
const OP = 'soul.computer-use.set';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const namespaceDigest = 'a'.repeat(64);
const NOW = 2_000_000_010_000;
const REQUEST = '11111111-1111-4111-8111-111111111111';
const nonceOf = (byte) => Buffer.alloc(32, byte).toString('base64url');
const keyIdOf = (keyPair) => sha256(keyPair.publicKey.export({ type: 'spki', format: 'der' }));

function p1(signer, { actionText, nonce }) {
  const segment = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'presence', action: sha256(Buffer.from(actionText, 'utf8')), nonce,
    iat: 2_000_000_000, exp: 2_000_000_060 })).toString('base64url');
  return `p1.${segment}.${sign(null, Buffer.from(segment), signer.privateKey).toString('base64url')}`;
}
function d1(broker, payload) {
  const segment = Buffer.from(canonicalJson(payload)).toString('base64url');
  return `d1.${segment}.${sign(null, Buffer.from(segment), broker.privateKey).toString('base64url')}`;
}

// A complete released computer-use request. `current` is the census value,
// `expected` the boolean captured at preparation, `desired` the action's.
function released(t, { current = true, expected = current, desired = !expected, requestId = REQUEST, shared } = {}) {
  const base = shared?.base ?? fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-cu-')));
  if (!shared) t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(base, 'xdg') }, home = base;
  const signer = shared?.signer ?? generateKeyPairSync('ed25519'), broker = shared?.broker ?? generateKeyPairSync('ed25519');
  const trustRoot = ownerDecisionTrustRoot({ env, home });
  const trustWriter = (now) => withCurrentObservation(createOwnerDecisionTrustWriter({ root: trustRoot, env, home, now: () => now, legacyPresenceKey: null }),
    { root: trustRoot, env, home });
  if (!shared) {
    loadOrCreateVouchKey(vouchStateDir({ env }));
    trustWriter(1_999_999_000).enrollNamespace({ namespaceDigest });
    trustWriter(1_999_999_000).enrollKeys({ receiptKey: rawEd25519(broker.publicKey), presenceKey: rawEd25519(signer.publicKey), brokerUid: process.getuid() + 1 });
  }
  const { principal, account, soul } = template;
  const action = Buffer.from(canonicalJson({ v: 1, requestId, principal, account, soul, operation: OP, parameters: { enabled: desired } }));
  const { actionText, actionDigest, payloadDigest } = decodeOwnerDecisionAction(action);
  const acceptance = { v: 1, kind: 'acceptance', requestId, principal, account, soul, operation: OP, payloadDigest, namespaceDigest,
    acceptedAt: 2_000_000_000, daemonKey: template.daemonKey, daemonEpoch: 1, watchId: template.watchId, reservationBytes: 524288 };
  const journalRoot = ownerDecisionJournalRoot({ env, home });
  if (!shared) initializeDaemonJournal(journalRoot);
  createDaemonJournalStore({ root: journalRoot, namespaceDigest }).admit(action, Buffer.from(canonicalJson(acceptance)));
  const nonce = shared ? nonceOf(2) : nonceOf(1);
  const preparation = { ...template, v: 2, trustVersion: 1, requestId, operation: OP, payloadDigest, actionDigest, nonce, acceptedAt: 2_000_000_000,
    preparedAt: 2_000_000_000, exp: 2_000_000_180, stage: null, expected: { kind: 'computer-use', enabled: expected } };
  const presence = p1(signer, { actionText, nonce });
  const receipt = Buffer.from(d1(broker, { v: 1, aud: 'agent-comms-owner-decision', brokerKey: keyIdOf(broker), presenceKey: keyIdOf(signer), requestId,
    principal, account, soul, operation: OP, payloadDigest, nonce, presenceDigest: sha256(Buffer.from(presence, 'ascii')), iat: 2_000_000_001, exp: 2_000_000_060 }), 'ascii');
  const check = { requestId, payloadDigest, receiptDigest: sha256(receipt), daemonKey: acceptance.daemonKey, daemonEpoch: 1, watchId: acceptance.watchId,
    state: 'released', mayApply: true, exp: 2_000_000_060 };
  const dir = path.join(journalRoot, 'requests', requestDirectoryName({ namespaceDigest, requestId }));
  const write = (slot, payload) => fs.writeFileSync(path.join(dir, `${slot}.record`), encodeDaemonJournalFrame(payload, { namespaceDigest, requestId, slot }));
  for (const [slot, payload] of [['preparation', Buffer.from(canonicalJson(preparation))], ['prepared-challenge', challengeFor(preparation, action)],
    ['presence', Buffer.from(presence, 'ascii')], ['receipt', receipt], ['successful-check', Buffer.from(canonicalJson(check))]]) write(slot, payload);
  const stateDir = stateDirectory({ env, home }), census = populationFile({ env, home });
  if (!shared) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mintAgentIdentity({ useGithub: false, gate: () => false, appSlug: null, harness: 'codex', transcript: { provider: 'codex', id: 't' },
      stateDir, idFactory: () => soul, now: () => new Date('2026-10-12T00:00:00.000Z') });
    upsertSoul({ id: soul, appSlug: null, parentId: null, status: 'active', spacePath: `/spaces/${soul}`, worktree: null, worktrees: [],
      transcriptLocator: null, lastSeen: '2026-10-12T00:00:00.000Z', computerUse: current }, { file: census });
    const pairing = commsCredentialFile({ env, home });
    fs.mkdirSync(path.dirname(pairing), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pairing, `${JSON.stringify({ account, secret: 'scratch-secret', brokerUid: process.getuid() + 1, mode: 'single-account',
      pairedAt: '2026-10-12T00:00:00.000Z' })}\n`, { mode: 0o600 });
  }
  const daemon = { env, home, now: NOW };
  return {
    base, env, home, signer, broker, soul, census, requestId, presence,
    apply: (presenceToken = presence) => asDaemon(daemon, () => applyComputerUseOwnerDecision({ requestId, presenceToken })),
    recover: () => createDaemonJournalStore({ root: journalRoot, namespaceDigest }).recover(requestId),
    value: () => showSoul(soul, { file: census }).computerUse,
    audits: () => (fs.existsSync(auditFile({ env, home })) ? fs.readFileSync(auditFile({ env, home }), 'utf8').trim().split('\n').map(JSON.parse)
      .filter((row) => row.event === 'computer-use') : []),
  };
}

test('the seam is sealed once, by the adapter, and refuses any second seal', () => {
  assert.throws(() => sealComputerUseOwnerDecision({ read() {}, refuse() {}, enter() {}, complete() {} }), (error) => error.code === 'computer-use-seam-refused');
});

test('disable and enable apply under the lock: written durably, completed record-only, audited once, and the request is spent', darwin, (t) => {
  for (const [current, desired] of [[true, false], [false, true]]) {
    const r = released(t, { current, desired });
    const result = r.apply();
    assert.equal(result.state, 'applied', JSON.stringify(result));
    assert.deepEqual([result.before, result.after, result.written], [current, desired, true]);
    assert.equal(r.value(), desired);
    assert.deepEqual(r.recover().outcome, { code: 'applied', effectDigest: result.completedDigest });
    assert.deepEqual(r.audits().map(({ decision, detail }) => [decision, detail]), [[desired ? 'on' : 'off', 'owner-decision']]);
    // Spent: a second presentation is consumed, and nothing is written again.
    const again = r.apply();
    assert.equal(again.state, 'refused');
    assert.equal(again.reason, 'owner-journal-consumed');
    assert.equal(r.value(), desired);
    assert.equal(r.audits().length, 1);
  }
});

test('a stale value before entry records expected-state-changed, enters nothing and writes nothing', darwin, (t) => {
  const r = released(t, { current: false, expected: true, desired: false });
  const before = fs.readFileSync(r.census);
  const result = r.apply();
  assert.equal(result.state, 'refused');
  assert.equal(result.code, 'expected-state-changed');
  assert.equal(r.recover().state, 'refused');
  assert.equal(r.recover().outcome.code, 'validation-refused');
  assert.deepEqual(fs.readFileSync(r.census), before);
  assert.deepEqual(r.audits(), []);
});

test('an absent or retired soul before entry records target-unavailable', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  updateSoulStatus(r.soul, 'retired', { file: r.census });
  const result = r.apply();
  assert.equal(result.state, 'refused');
  assert.equal(result.code, 'target-unavailable');
  assert.equal(r.recover().state, 'refused');
});

test('a no-op writes nothing but flushes the existing census, reads back under the lock, spends and completes', darwin, (t) => {
  const r = released(t, { current: false, expected: false, desired: false });
  const before = fs.readFileSync(r.census);
  // Which files are opened for reading and flushed during the call.
  const opened = [], original = fs.openSync;
  fs.openSync = (target, flags, ...rest) => { opened.push([String(target), flags]); return original(target, flags, ...rest); };
  syncBuiltinESMExports();
  let result;
  try { result = r.apply(); } finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(result.state, 'applied', JSON.stringify(result));
  assert.deepEqual([result.before, result.after, result.written], [false, false, false]);
  assert.deepEqual(fs.readFileSync(r.census), before, 'nothing was written');
  assert.ok(opened.some(([target, flags]) => target === r.census && flags === 'r'), 'the existing census was opened to flush it');
  assert.ok(opened.some(([target]) => target === path.dirname(r.census)), 'and its directory');
  assert.deepEqual(r.recover().outcome, { code: 'applied', effectDigest: result.completedDigest });
  assert.deepEqual(r.audits(), [], 'a no-op writes no audit line');
  assert.equal(r.apply().reason, 'owner-journal-consumed');
});

test('a gate refusal before entry writes nothing and leaves the request released for a valid presentation', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  const wrong = p1(generateKeyPairSync('ed25519'), { actionText: 'x', nonce: nonceOf(1) });
  const refused = r.apply(wrong);
  assert.equal(refused.state, 'refused');
  assert.equal(r.value(), true);
  assert.equal(r.recover().state, 'released');
  assert.equal(r.apply().state, 'applied');
  assert.equal(r.value(), false);
});

test('an audit failure after completion is not an error and is never retried', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  const audit = auditFile({ env: r.env, home: r.home });
  fs.mkdirSync(path.dirname(path.dirname(audit)), { recursive: true });
  fs.writeFileSync(path.dirname(audit), 'not a directory');
  const result = r.apply();
  assert.equal(result.state, 'applied');
  assert.equal(r.value(), false);
  assert.equal(r.apply().reason, 'owner-journal-consumed');
});

// --- crash points: a child process runs the adapter and kills itself ---

const CHILD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [root, crash, census, requestId, presenceToken] = process.argv.slice(2);
Date.now = () => ${NOW};
const die = () => process.kill(process.pid, 'SIGKILL');
if (crash === 'after-entered') {
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => { if (String(to) === census) die(); return rename(from, to, ...rest); };
}
if (crash === 'after-write') {
  // Every journal read opens completed.record; only its write opens it read-write.
  const open = fs.openSync;
  fs.openSync = (target, flags, ...rest) => {
    if (String(target).endsWith('completed.record') && typeof flags === 'number' && (flags & fs.constants.O_RDWR)) die();
    return open(target, flags, ...rest);
  };
}
syncBuiltinESMExports();
const { applyComputerUseOwnerDecision } = await import(root + '/owner-decision-computer-use.mjs');
console.log(JSON.stringify(applyComputerUseOwnerDecision({ requestId, presenceToken })));
`;

function runChild(r, crash) {
  const script = path.join(r.base, `child-${crash}.mjs`);
  fs.writeFileSync(script, CHILD);
  const env = { PATH: process.env.PATH, HOME: r.home, XDG_STATE_HOME: r.env.XDG_STATE_HOME };
  return spawnSync(process.execPath, [script, ROOT, crash, r.census, r.requestId, r.presence], { env, encoding: 'utf8', timeout: 30_000 });
}

test('crash after entered, before the write: the request is spent and uncertain, the census unchanged, and nothing is retried', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  const child = runChild(r, 'after-entered');
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(r.recover().state, 'indeterminate');
  assert.equal(r.value(), true, 'the write never happened');
  const again = r.apply();
  assert.equal(again.state, 'refused');
  assert.equal(again.reason, 'owner-journal-consumed');
  assert.equal(r.value(), true, 'and is never retried');
});

test('crash after the write, before completion: the census holds the new value, the request stays uncertain, and nothing is retried', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  const child = runChild(r, 'after-write');
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(r.value(), false, 'the durable write landed');
  assert.equal(r.recover().state, 'indeterminate', 'without its completed record');
  assert.equal(r.apply().reason, 'owner-journal-consumed');
});

test('no crash: the child completes normally (control for the crash points)', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  const child = runChild(r, 'none');
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).state, 'applied');
  assert.equal(r.value(), false);
});

// --- concurrency and the lock ---

test('two concurrent presentations of one request: exactly one applies and writes, the other is refused', darwin, async (t) => {
  const r = released(t, { current: true, desired: false });
  const script = path.join(r.base, 'child-concurrent.mjs');
  fs.writeFileSync(script, CHILD);
  const env = { PATH: process.env.PATH, HOME: r.home, XDG_STATE_HOME: r.env.XDG_STATE_HOME };
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ROOT, 'none', r.census, r.requestId, r.presence], { env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(JSON.parse(out)));
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map((result) => result.state).sort(), ['applied', 'refused'], JSON.stringify(results));
  // The loser finds the request consumed, or the trust store busy (it
  // refuses rather than waits); either way nothing of its own is applied.
  assert.ok(['owner-journal-consumed', 'trust-unavailable'].includes(results.find((result) => result.state === 'refused').reason), JSON.stringify(results));
  assert.equal(r.value(), false);
  assert.equal(r.recover().state, 'applied');
  assert.equal(r.audits().length, 1, 'written and audited once');
});

test('a live population-lock holder is never reclaimed: the adapter refuses with nothing entered or written', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  // A stale-looking lock held by this live process.
  const lock = `${r.census}.lock`;
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), lockOwnerToken());
  const then = (Date.now() - 31_000) / 1000;
  fs.utimesSync(lock, then, then);
  assert.throws(() => r.apply(), /timed out waiting for population store/);
  assert.ok(fs.existsSync(lock), 'the live holder keeps its lock');
  assert.equal(r.recover().state, 'released', 'nothing entered');
  assert.equal(r.value(), true, 'nothing written');
  fs.rmSync(lock, { recursive: true, force: true });
  assert.equal(r.apply().state, 'applied', 'once the holder is gone it applies');
});

test('an error after entry is indeterminate: a census read-back that differs leaves the request spent and is not retried', darwin, (t) => {
  const r = released(t, { current: true, desired: false });
  const original = fs.readFileSync, rename = fs.renameSync;
  // The census reads back the old value once it has been replaced.
  fs.readFileSync = (target, ...rest) => {
    const value = original(target, ...rest);
    return String(target) === r.census && typeof value === 'string' ? value.replace('"computerUse": false', '"computerUse": true') : value;
  };
  // Every replacement of the census during the call.
  let writes = 0;
  fs.renameSync = (from, to, ...rest) => { if (String(to) === r.census) writes += 1; return rename(from, to, ...rest); };
  syncBuiltinESMExports();
  let result;
  try { result = r.apply(); } finally { fs.readFileSync = original; fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(writes, 1, 'the census is written once; an error after entry is never retried');
  assert.equal(result.state, 'indeterminate', JSON.stringify(result));
  assert.equal(result.reason, 'population-readback-failed');
  assert.equal(r.recover().state, 'indeterminate');
  assert.equal(r.apply().reason, 'owner-journal-consumed');
  assert.deepEqual(r.audits(), [], 'no audit line for an uncertain effect');
});
