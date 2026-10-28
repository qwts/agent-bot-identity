// Direct contract tests for the action ledger (#1201): corrupt entries read
// as nothing, writes are atomic across processes, terminal states are
// monotonic, and a credential-shaped field is refused rather than written.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { actionsDir, listActions, readAction, transition, writeAction } from '../identity/action-ledger.mjs';

const roots = [];
after(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'action-ledger-'));
  roots.push(dir);
  return dir;
};

test('a corrupt entry reads as no action; the module trusts the well-formed JSON it writes itself', () => {
  const dir = scratch();
  assert.equal(readAction(dir, 'op_1'), null, 'missing file');
  mkdirSync(actionsDir(dir), { recursive: true });
  writeFileSync(path.join(actionsDir(dir), 'op_2.json'), 'not json{{{');
  assert.equal(readAction(dir, 'op_2'), null, 'garbage JSON reads as nothing');
  writeFileSync(path.join(actionsDir(dir), 'op_3.json'), JSON.stringify([1, 2]));
  // Shape is not validated: parseable-but-foreign JSON comes back as read.
  assert.deepEqual(readAction(dir, 'op_3'), [1, 2], 'a foreign but parseable entry is returned verbatim');
  assert.equal(readAction(dir, '../escape'), null, 'a malformed id reads as nothing — the id check is swallowed by the null contract');
  assert.equal(readAction(dir, 'has space'), null);
});

test('a record outside the field allowlist is refused, however the credential is named', () => {
  const dir = scratch();
  const base = { operation_id: 'op_1', task_id: 't', state: 'prepared' };
  for (const field of ['access_token', 'Token', 'secret', 'credential', 'credentials', 'private_key', 'authorization', 'result', 'session']) {
    assert.throws(() => writeAction(dir, { ...base, [field]: 'x' }),
      /only identifiers and states/, field);
  }
  // A nested object or array is refused too — no place for a token to hide
  // (under an allowed key, so the scalar check is the one that fires).
  assert.throws(() => writeAction(dir, { ...base, reason: { token: 'x' } }), /scalars only/);
  assert.throws(() => writeAction(dir, { ...base, repo: ['o/r'] }), /scalars only/);
  // A credential-shaped value is refused even under an innocent key.
  for (const canary of ['ghs_aBcDeFgHiJkLmNoPqRsTuVwX', 'sk-abcdefghijklmnop', 'Bearer abcdefgh12345678ijkl']) {
    assert.throws(() => writeAction(dir, { ...base, reason: canary }),
      /credential-shaped/, canary);
  }
  // Every field the real callers write is accepted.
  const written = writeAction(dir, { operation_id: 'op_1', task_id: 't', kind: 'github_installation_token', harness: 'grok', repo: 'o/r', state: 'prepared', created_at: '2026-01-01T00:00:00Z' });
  assert.equal(written.state, 'prepared');
  transition(dir, 'op_1', 'succeeded', { issuance_id: 'iss_1', replayed: true, reconciled: true, reason: null });
  const stored = readAction(dir, 'op_1');
  for (const field of Object.keys(stored)) {
    assert.ok(['operation_id', 'task_id', 'kind', 'harness', 'repo', 'state', 'reason', 'issuance_id', 'replayed', 'reconciled', 'created_at', 'updated_at'].includes(field), field);
  }
});

test('terminal states are monotonic — nothing moves out of succeeded or rejected', () => {
  const dir = scratch();
  writeAction(dir, { operation_id: 'op_1', task_id: 't', state: 'prepared' });
  transition(dir, 'op_1', 'submitted');
  transition(dir, 'op_1', 'succeeded', { issuance_id: 'iss_1' });
  assert.throws(() => transition(dir, 'op_1', 'unknown'), /succeeded/);
  assert.throws(() => writeAction(dir, { operation_id: 'op_1', task_id: 't', state: 'prepared' }), /cannot become/);
  writeAction(dir, { operation_id: 'op_2', task_id: 't', state: 'rejected' });
  assert.throws(() => transition(dir, 'op_2', 'submitted'), /rejected/);
  // An idempotent settle (rejected -> rejected) stays allowed.
  transition(dir, 'op_2', 'rejected', { reason: 'reconciled-none' });
  assert.equal(readAction(dir, 'op_2').reason, 'reconciled-none');
  transition(dir, 'op_1', 'succeeded', { issuance_id: 'iss_1' });
  assert.throws(() => transition(dir, 'missing_op', 'submitted'), /no action recorded/);
});

test('two writers in separate processes lose no record', () => {
  const dir = scratch();
  const script = `import('${path.join(import.meta.dirname, '..', 'identity', 'action-ledger.mjs')}').then((m) => {
    const dir = process.argv[1]; const tag = process.argv[2];
    for (let i = 0; i < 25; i += 1) m.writeAction(dir, { operation_id: \`op_\${tag}_\${i}\`, task_id: 't', state: 'prepared' });
  })`;
  for (const tag of ['a', 'b']) {
    execFileSync(process.execPath, ['-e', script, dir, tag]);
  }
  assert.equal(listActions(dir).length, 50, 'every record from both processes survived');
});

test('interleaved writes in one process lose no record', async () => {
  const dir = scratch();
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    Promise.resolve().then(() => writeAction(dir, { operation_id: `op_${i}`, task_id: 't', state: 'prepared' }))));
  assert.equal(listActions(dir).length, 25);
});

test('a torn write beside the real file corrupts nothing', () => {
  const dir = scratch();
  writeAction(dir, { operation_id: 'op_1', task_id: 't', state: 'prepared' });
  writeAction(dir, { operation_id: 'op_2', task_id: 't', state: 'prepared' });
  // A torn rename from a dead process: a .tmp file with truncated content.
  writeFileSync(path.join(actionsDir(dir), 'op_3.json.99999.tmp'), '{"operation_id":"op_3","stat');
  writeFileSync(path.join(actionsDir(dir), 'op_4.json.tmp'), '{');
  assert.deepEqual(listActions(dir).map((r) => r.operation_id).sort(), ['op_1', 'op_2'], 'stray tmp files are not records');
  assert.equal(readAction(dir, 'op_1').state, 'prepared');
  // A write that wins the rename still lands complete.
  writeAction(dir, { operation_id: 'op_3', task_id: 't', state: 'prepared' });
  assert.equal(readAction(dir, 'op_3').state, 'prepared');
});
