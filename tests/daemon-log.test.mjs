import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDaemonLogCheck, daemonLogMaxBytes, DEFAULT_DAEMON_LOG_MAX_BYTES } from '../daemon-log.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-log-'));
  const logPath = join(dir, 'daemon.log');
  const fd = openSync(logPath, 'a+', 0o644);
  t.after(() => closeSync(fd));
  return { dir, logPath, fd };
}

test('copy/truncate retains one private backup and both append descriptors keep writing to the live inode', (t) => {
  const { fd, logPath } = fixture(t);
  const stdout = openSync(logPath, 'a');
  t.after(() => closeSync(stdout));
  const old = 'first diagnostic line\n';
  writeSync(fd, old);
  writeFileSync(`${logPath}.1`, 'older generation', { mode: 0o644 });
  const inode = fstatSync(fd).ino;
  const check = createDaemonLogCheck({ fd, logPath, env: { AGENT_BOT_DAEMON_LOG_MAX_BYTES: '8' } });
  assert.equal(check(), true);
  assert.equal(readFileSync(`${logPath}.1`, 'utf8'), old);
  assert.equal(readFileSync(logPath, 'utf8'), '');
  assert.equal(fstatSync(fd).size, 0);
  assert.equal(statSync(logPath).ino, inode);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
  assert.equal(statSync(`${logPath}.1`).mode & 0o777, 0o600);
  const backupBefore = statSync(`${logPath}.1`);
  assert.equal(check(), false);
  assert.deepEqual(statSync(`${logPath}.1`), backupBefore);
  writeSync(fd, 'err\n');
  writeSync(stdout, 'out\n');
  assert.equal(readFileSync(logPath, 'utf8'), 'err\nout\n', 'O_APPEND writes start at the new EOF');
  assert.equal(check(), false, 'exactly the cap does not rotate');
  writeSync(stdout, 'next\n');
  assert.equal(check(), true);
  assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'err\nout\nnext\n');
  assert.equal(readFileSync(logPath, 'utf8'), '');
  assert.equal(existsSync(`${logPath}.2`), false);
});

test('invalid log cap environment values fall back to 5 MiB', () => {
  assert.equal(DEFAULT_DAEMON_LOG_MAX_BYTES, 5 * 1024 * 1024);
  for (const value of [undefined, '', 'bad', '0', '-1', '1.5', '1e6', 'Infinity', ' 42 ', '9007199254740992']) {
    assert.equal(daemonLogMaxBytes({ AGENT_BOT_DAEMON_LOG_MAX_BYTES: value }), DEFAULT_DAEMON_LOG_MAX_BYTES, String(value));
  }
  assert.equal(daemonLogMaxBytes({ AGENT_BOT_DAEMON_LOG_MAX_BYTES: '42' }), 42);
});

test('a real pipe descriptor is a no-op without looking up the log path', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-log-pipe-'));
  const fifo = join(dir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  t.after(() => closeSync(fd));
  assert.equal(fstatSync(fd).isFIFO(), true);
  writeSync(fd, 'more than one byte');
  const messages = [];
  const check = createDaemonLogCheck({ fd, logPath: join(dir, 'missing'),
    env: { AGENT_BOT_DAEMON_LOG_MAX_BYTES: '1' }, log: (line) => messages.push(line) });
  assert.equal(check(), false);
  assert.deepEqual(messages, []);
});

test('a descriptor for a different regular file is never truncated', (t) => {
  const { dir, fd, logPath } = fixture(t);
  writeSync(fd, 'keep this redirected output');
  const other = join(dir, 'other.log');
  writeFileSync(other, 'keep the named log too');
  const check = createDaemonLogCheck({ fd, logPath: other, env: { AGENT_BOT_DAEMON_LOG_MAX_BYTES: '1' } });
  assert.equal(check(), false);
  assert.equal(readFileSync(logPath, 'utf8'), 'keep this redirected output');
  assert.equal(readFileSync(other, 'utf8'), 'keep the named log too');
  assert.equal(existsSync(`${other}.1`), false);
});

test('backup failure preserves the live log and reports only once across retries', (t) => {
  const { fd, logPath } = fixture(t);
  writeSync(fd, 'preserve this log');
  mkdirSync(`${logPath}.1`);
  const messages = [];
  const check = createDaemonLogCheck({ fd, logPath, env: { AGENT_BOT_DAEMON_LOG_MAX_BYTES: '1' },
    log: (line) => messages.push(line) });
  assert.equal(check(), false);
  assert.equal(check(), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /log cap check failed/);
  assert.equal(readFileSync(logPath, 'utf8'), 'preserve this log');
});

test('even a failed diagnostic write cannot throw', () => {
  let reports = 0;
  const check = createDaemonLogCheck({ fd: -1, log: () => { reports++; throw new Error('closed stderr'); } });
  assert.equal(check(), false);
  assert.equal(check(), false);
  assert.equal(reports, 1);
});
