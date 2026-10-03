import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskReporter } from '../task-turns.mjs';

const invocation = { invocationId: 'invocation_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agentId: 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId: 'task_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

test('restart closes open task turns as interrupted, once; failed reports remain recoverable', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'task-turns-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'daemon', 'task-turns.jsonl');
  const reports = [];
  await createTaskReporter({ file, report: async (entry) => reports.push(entry) }).started(invocation);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const logs = [];
  await createTaskReporter({ file, report: async () => { throw new Error('offline'); } }).recover({ log: (line) => logs.push(line) });
  assert.equal(logs.length, 1);
  const restarted = createTaskReporter({ file, report: async (entry) => reports.push(entry) });
  await restarted.recover();
  await restarted.recover();
  assert.deepEqual(reports.map(({ phase, outcome }) => [phase, outcome]), [['started', undefined], ['ended', 'interrupted']]);
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).phase), ['started', 'ended']);
});

test('compaction drops finished history and retains every open turn', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'task-turns-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'task-turns.jsonl');
  const reports = [];
  const reporter = createTaskReporter({ file, report: async (entry) => reports.push(entry) });
  await reporter.started(invocation);
  for (let i = 0; i < 140; i += 1) {
    const finished = { ...invocation, invocationId: `invocation_finished-${i}` };
    await reporter.started(finished);
    await reporter.ended(finished, 'completed');
  }
  assert.ok(readFileSync(file, 'utf8').trim().split('\n').length <= 256);
  reports.length = 0;
  await reporter.recover();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].invocationId, invocation.invocationId);
  assert.equal(reports[0].outcome, 'interrupted');
});
