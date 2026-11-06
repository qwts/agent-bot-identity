// Direct contract tests for the action ledger (#1201): corrupt entries read
// as nothing, writes are atomic across processes, terminal states are
// monotonic, and a credential-shaped field is refused rather than written.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { actionsArchiveDir, actionsDir, listActions, MAX_SETTLED_ACTIONS, readAction, transition, writeAction } from '../identity/action-ledger.mjs';

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

test('settled actions are compacted into actions-archive while preserving latest per harness, non-terminal entries, and readAction lookup (#1368)', () => {
  const dir = scratch();
  // Write an early settled record for a rarely-used harness; compaction must never drop it from active actionsDir.
  writeAction(dir, {
    operation_id: 'op_rare',
    task_id: 't_rare',
    kind: 'github_installation_token',
    harness: 'trueline-rare-agent',
    repo: 'o/r',
    state: 'succeeded',
    issuance_id: 'iss_rare',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  // Write a non-terminal unknown record; compaction must never archive it.
  writeAction(dir, {
    operation_id: 'op_pending_unknown',
    task_id: 't_unk',
    kind: 'github_installation_token',
    harness: 'trueline-codex-agent',
    repo: 'o/r',
    state: 'unknown',
    created_at: '2026-01-01T00:00:01.000Z',
  });

  for (let i = 0; i < 320; i += 1) {
    const ts = new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString();
    writeAction(dir, {
      operation_id: `op_bulk_${i}`,
      task_id: 't_bulk',
      kind: 'github_installation_token',
      harness: 'trueline-codex-agent',
      repo: 'o/r',
      state: 'succeeded',
      issuance_id: `iss_${i}`,
      created_at: ts,
    });
  }

  const activeFiles = readdirSync(actionsDir(dir)).filter((f) => f.endsWith('.json'));
  const archivedFiles = readdirSync(actionsArchiveDir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(activeFiles.length <= MAX_SETTLED_ACTIONS + 50, `active files bounded (${activeFiles.length})`);
  assert.ok(archivedFiles.length >= 100, `older settled files archived (${archivedFiles.length})`);

  const activeList = listActions(dir);
  assert.ok(activeList.some((r) => r.operation_id === 'op_rare'), 'latest record for rare harness stays active');
  assert.ok(activeList.some((r) => r.operation_id === 'op_pending_unknown'), 'non-terminal unknown record stays active');
  assert.ok(activeList.some((r) => r.operation_id === 'op_bulk_319'), 'newest settled record stays active');
  assert.deepEqual(listActions(dir, { state: 'unknown' }).map((r) => r.operation_id), ['op_pending_unknown']);

  // Archived operations remain readable via readAction and still enforce terminal monotonicity.
  const earliest = readAction(dir, 'op_bulk_0');
  assert.equal(earliest?.state, 'succeeded');
  assert.equal(earliest?.issuance_id, 'iss_0');
  assert.throws(() => writeAction(dir, { operation_id: 'op_bulk_0', task_id: 't_bulk', state: 'prepared' }), /cannot become/);

  // >250 non-terminal records are never archived and do not lose entries.
  const nonTerminalDir = scratch();
  for (let i = 0; i < 260; i++) {
    writeAction(nonTerminalDir, {
      operation_id: `op_nt_${i}`,
      task_id: 't_nt',
      state: 'unknown',
      created_at: new Date(Date.parse('2026-04-01T00:00:00.000Z') + i * 1000).toISOString(),
    });
  }
  assert.equal(listActions(nonTerminalDir, { state: 'unknown' }).length, 260);
  assert.equal(listActions(nonTerminalDir, { state: 'unknown' }).length, 260);
});
