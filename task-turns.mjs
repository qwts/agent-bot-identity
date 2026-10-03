// Execution facts only: this journal never changes a task claim. Open turns
// survive a daemon crash and are closed at the broker before new dispatch.
import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function createTaskReporter({ file, report, now = () => new Date() }) {
  function entries() {
    try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function append(invocation, phase) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const entry = { invocationId: invocation.invocationId, agentId: invocation.agentId, taskId: invocation.taskId, phase, at: now().toISOString() };
    const fd = openSync(file, 'a', 0o600);
    try { fchmodSync(fd, 0o600); writeFileSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  function compact() {
    const records = entries();
    if (records.length <= 256) return;
    const ended = new Set(records.filter((entry) => entry.phase === 'ended').map((entry) => entry.invocationId));
    const open = records.filter((entry) => !ended.has(entry.invocationId));
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, open.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  }
  return {
    async started(invocation) {
      append(invocation, 'started');
      await report({ ...invocation, phase: 'started' });
    },
    async ended(invocation, outcome) {
      await report({ ...invocation, phase: 'ended', outcome });
      append(invocation, 'ended');
      compact();
    },
    async recover({ log = () => {} } = {}) {
      const records = entries();
      const ended = new Set(records.filter((entry) => entry.phase === 'ended').map((entry) => entry.invocationId));
      const open = new Map(records.filter((entry) => entry.phase === 'started' && !ended.has(entry.invocationId)).map((entry) => [entry.invocationId, entry]));
      for (const entry of open.values()) {
        try { await this.ended(entry, 'interrupted'); }
        catch (error) { log(`task invocation ${entry.invocationId} recovery failed: ${error?.message ?? String(error)}`); }
      }
      compact();
    },
  };
}
