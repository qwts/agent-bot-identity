// The owner-decision revision-journal port (agent-comms#77, C2): the exact
// bytes of one revision-journal record, read under strict custody of its
// fixed ancestry and of the record itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOwnerDecisionRevisionPort, REVISION_RECORD_MAX_BYTES } from '../owner-decision-revision-port.mjs';

const soul = 'agent_00000000-0000-4000-8000-000000000001';
const refused = { code: 'owner-decision-revision-read' };

function revisions(t) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-revision-port-')));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const agentDir = path.join(stateDir, 'soul-revisions', soul);
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const file = (seq) => path.join(agentDir, `${String(seq).padStart(10, '0')}.json`);
  // chmod after writing: the process umask would mask a group-write mode.
  const write = (seq, bytes = Buffer.from('{"schemaVersion":1,"kind":"revision"}\n'), mode = 0o600) => {
    fs.writeFileSync(file(seq), bytes, { mode: 0o600 }); fs.chmodSync(file(seq), mode); return bytes;
  };
  return { stateDir, agentDir, file, write, port: createOwnerDecisionRevisionPort({ stateDir }) };
}

test('it reads the exact bytes of one owned record', (t) => {
  const r = revisions(t), bytes = r.write(3);
  assert(r.port.read(soul, 3).equals(bytes));
  const max = r.write(4, Buffer.alloc(REVISION_RECORD_MAX_BYTES, 0x20));
  assert.equal(r.port.read(soul, 4).length, max.length);
  assert.throws(() => createOwnerDecisionRevisionPort({ stateDir: 'relative' }));
});

test('a malformed request, a missing record, or one outside the bounds refuses', (t) => {
  const r = revisions(t);
  r.write(0);
  for (const [agentId, seq] of [['agent_nope', 0], [soul, -1], [soul, 1.5], [soul, 10_000_000_000], [soul, 9]]) assert.throws(() => r.port.read(agentId, seq), refused);
  // Neither the agent ID nor the sequence can name another file.
  fs.writeFileSync(path.join(r.stateDir, '0000000000.json'), '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(r.stateDir, 'soul-revisions', '0000000000.json'), '{}\n', { mode: 0o600 });
  for (const agentId of ['..', '.', '../soul-revisions', `${soul}/..`]) assert.throws(() => r.port.read(agentId, 0), refused, agentId);
  for (const seq of ['0', '0000000000', [0]]) assert.throws(() => r.port.read(soul, seq), refused, String(seq));
  fs.writeFileSync(path.join(r.agentDir, '000000001.5.json'), '{}\n', { mode: 0o600 });
  assert.throws(() => r.port.read(soul, 1.5), refused);
  r.write(1, Buffer.alloc(0));
  r.write(2, Buffer.alloc(REVISION_RECORD_MAX_BYTES + 1, 0x20));
  assert.throws(() => r.port.read(soul, 1), refused);
  assert.throws(() => r.port.read(soul, 2), refused);
});

test('the record must be one owned, single-link regular file with no group or world write', (t) => {
  const r = revisions(t);
  r.write(0, undefined, 0o620);
  assert.throws(() => r.port.read(soul, 0), refused);
  r.write(1);
  fs.linkSync(r.file(1), path.join(r.agentDir, 'twin'));
  assert.throws(() => r.port.read(soul, 1), refused);
  const target = path.join(r.stateDir, 'elsewhere.json');
  fs.writeFileSync(target, '{}\n', { mode: 0o600 });
  fs.symlinkSync(target, r.file(2));
  assert.throws(() => r.port.read(soul, 2), refused);
  fs.mkdirSync(r.file(3), { mode: 0o700 });
  assert.throws(() => r.port.read(soul, 3), refused);
});

test('every directory in the fixed ancestry must be a real owned directory with no group or world write', async (t) => {
  await t.test('a group-writable agent directory', (tt) => {
    const r = revisions(tt);
    r.write(0);
    fs.chmodSync(r.agentDir, 0o770);
    assert.throws(() => r.port.read(soul, 0), refused);
  });
  await t.test('a world-writable soul-revisions directory', (tt) => {
    const r = revisions(tt);
    r.write(0);
    fs.chmodSync(path.join(r.stateDir, 'soul-revisions'), 0o703);
    assert.throws(() => r.port.read(soul, 0), refused);
  });
  await t.test('a group-writable state directory', (tt) => {
    const r = revisions(tt);
    r.write(0);
    fs.chmodSync(r.stateDir, 0o770);
    assert.throws(() => r.port.read(soul, 0), refused);
  });
  await t.test('a symlinked agent directory', (tt) => {
    const r = revisions(tt);
    const real = path.join(r.stateDir, 'real-agent');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.writeFileSync(path.join(real, '0000000000.json'), '{}\n', { mode: 0o600 });
    fs.rmSync(r.agentDir, { recursive: true });
    fs.symlinkSync(real, r.agentDir);
    assert.throws(() => r.port.read(soul, 0), refused);
  });
});

// The open file must be the one the name pointed to, before and after the
// read: a swap during the read refuses. (The port uses the CJS fs object, so
// patching it here sees every call it makes.)
test('a record swapped under the name, before the open or during the read, refuses', async (t) => {
  const swap = (r, seq) => {
    const other = path.join(r.stateDir, 'other.json');
    fs.writeFileSync(other, '{"schemaVersion":1,"kind":"decision"}\n', { mode: 0o600 });
    fs.renameSync(other, r.file(seq));
  };
  const patched = (tt, name, wrap) => {
    const original = fs[name];
    fs[name] = wrap(original);
    tt.after(() => { fs[name] = original; });
  };
  await t.test('between the name check and the open', (tt) => {
    const r = revisions(tt);
    r.write(0);
    let once = false;
    patched(tt, 'openSync', (original) => (...args) => { if (!once) { once = true; swap(r, 0); } return original(...args); });
    assert.throws(() => r.port.read(soul, 0), refused);
  });
  await t.test('during the read, the original kept alive by another link', (tt) => {
    const r = revisions(tt);
    r.write(0);
    let once = false;
    patched(tt, 'readSync', (original) => (...args) => {
      const n = original(...args);
      if (!once) { once = true; fs.linkSync(r.file(0), path.join(r.stateDir, 'kept.json')); swap(r, 0); }
      return n;
    });
    assert.throws(() => r.port.read(soul, 0), refused);
  });
  await t.test('rewritten in place during the read', (tt) => {
    const r = revisions(tt);
    r.write(0);
    let once = false;
    patched(tt, 'readSync', (original) => (...args) => {
      const n = original(...args);
      if (!once) { once = true; fs.utimesSync(r.file(0), new Date(0), new Date(0)); }
      return n;
    });
    assert.throws(() => r.port.read(soul, 0), refused);
  });
  await t.test('grown during the read', (tt) => {
    const r = revisions(tt);
    r.write(0);
    let once = false;
    // Grown with its mtime put back, so only the size shows it.
    fs.utimesSync(r.file(0), 1000, 1000);
    patched(tt, 'readSync', (original) => (...args) => {
      const n = original(...args);
      if (!once) { once = true; fs.appendFileSync(r.file(0), 'x'); fs.utimesSync(r.file(0), 1000, 1000); }
      return n;
    });
    assert.throws(() => r.port.read(soul, 0), refused);
  });
  await t.test('during the read', (tt) => {
    const r = revisions(tt);
    r.write(0);
    let once = false;
    patched(tt, 'readSync', (original) => (...args) => { const n = original(...args); if (!once) { once = true; swap(r, 0); } return n; });
    assert.throws(() => r.port.read(soul, 0), refused);
  });
});
