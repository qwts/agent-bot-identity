import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { auditCommand } from '../agent-audit.mjs';
import { auditFile, appendAuditReceipt } from '../agent-principals.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const NOW = '2026-10-05T12:00:00.000Z';
const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

function scratch(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-audit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { HOME: home, AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction') }, now: () => new Date(NOW) };
}

function seed(opts, rows) {
  const file = auditFile(opts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

async function listing(args, opts) {
  let output = '';
  const records = await auditCommand(['list', ...args], { ...opts, write: (text) => { output += text; } });
  return { records, output };
}

async function waitFor(probe) {
  const deadline = Date.now() + 3000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error('audit output did not arrive');
    await delay(10);
  }
}

function following(t, opts, args = ['--json']) {
  const stdin = new PassThrough();
  const signals = new EventEmitter();
  const lines = [];
  const done = auditCommand(['tail', ...args], {
    ...opts, stdin, signals, pollIntervalMs: 10, write: (text) => lines.push(text.trimEnd()),
  });
  t.after(async () => { signals.emit('SIGINT'); await done; stdin.destroy(); });
  return { stdin, signals, lines, done };
}

test('list combines agent, event and since filters before limiting, with newest last', async (t) => {
  const opts = scratch(t);
  const rows = [
    { at: '2026-10-03T12:00:00.000Z', event: 'permission', agentId: AGENT_ID },
    { at: '2026-10-04T12:00:00.000Z', event: 'permission', agentId: AGENT_ID, decision: 'allow' },
    { at: '2026-10-04T13:00:00.000Z', event: 'permission', agentId: OTHER_ID },
    { at: '2026-10-04T14:00:00.000Z', event: 'approval-decision', agentId: AGENT_ID },
    { at: NOW, event: 'permission', agentId: AGENT_ID, decision: 'deny' },
  ];
  seed(opts, rows);
  const filters = ['--agent', AGENT_ID, '--event', 'permission'];
  const absolute = await listing(['--json', ...filters, '--since', '2026-10-04T07:00:00-05:00'], opts);
  assert.deepEqual(absolute.records, [rows[1], rows[4]]);
  assert.deepEqual(JSON.parse(absolute.output), { records: absolute.records });
  assert.deepEqual((await listing([...filters, '--since', '-P1D'], opts)).records, absolute.records);
  assert.deepEqual((await listing([...filters, '--since', '-PT24H', '--limit', '1'], opts)).records, [rows[4]]);
  assert.deepEqual((await listing(['--event', 'approval-decision'], opts)).records, [rows[3]]);
  assert.deepEqual((await listing(['--agent', OTHER_ID], opts)).records, [rows[2]]);
});

test('list defaults to 200 records and enforces a maximum of 5000', async (t) => {
  const opts = scratch(t);
  const rows = Array.from({ length: 5205 }, (_, i) => ({
    at: new Date(Date.parse(NOW) + i * 1000).toISOString(), event: 'permission', detail: `record ${i}`,
  }));
  seed(opts, rows);
  const defaults = await listing(['--json'], opts);
  assert.deepEqual(defaults.records, rows.slice(-200));
  const maximum = await listing(['--json', '--limit', '5000'], opts);
  assert.deepEqual(maximum.records, rows.slice(-5000));
  for (const limit of ['5001', '0', '-1', '1.5', 'NaN', 'Infinity']) {
    await assert.rejects(listing(['--limit', limit], opts), /--limit/);
  }
});

test('list skips malformed lines, accepts a final record without newline and keeps plain output on one line', async (t) => {
  const opts = scratch(t);
  const row = { at: NOW, event: 'permission', agentId: AGENT_ID, operation: 'Read', decision: 'allow', detail: 'first\nsecond\tthird' };
  seed(opts, [row]);
  appendFileSync(auditFile(opts), `broken\nnull\n[]\n{}\n${JSON.stringify({ ...row, detail: 'last' })}`);
  const { records, output } = await listing([], opts);
  assert.equal(records.length, 2);
  assert.equal(output.split('\n').filter(Boolean).length, 2);
  assert.match(output, /Read allow first second third\n/);
  assert.equal((await listing(['--event', 'absent'], opts)).output, '');
});

test('missing audit logs are empty and the reader creates no state directories', async (t) => {
  const opts = scratch(t);
  assert.deepEqual(JSON.parse((await listing(['--json'], opts)).output), { records: [] });
  assert.equal(existsSync(opts.env.AGENT_BOT_INTERACTION_HOME), false);
  const fallback = { ...opts, env: { HOME: opts.home } };
  assert.deepEqual((await listing([], fallback)).records, []);
  assert.equal(existsSync(path.join(opts.home, '.local')), false);
});

test('the reader shares the writer interaction-home and XDG state resolution', async (t) => {
  const opts = scratch(t);
  const xdg = { ...opts, env: { HOME: opts.home, XDG_STATE_HOME: path.join(opts.home, 'state') } };
  const row = appendAuditReceipt({ event: 'permission', agentId: AGENT_ID, decision: 'allow' }, xdg);
  assert.deepEqual((await listing(['--json'], xdg)).records, [row]);
  assert.equal(auditFile(xdg), path.join(opts.home, 'state', 'agent-bot', 'interaction', 'audit.jsonl'));
  assert.deepEqual((await listing([], opts)).records, []);
});

test('invalid arguments fail before reading the log', async (t) => {
  const opts = scratch(t);
  for (const argv of [[], ['other'], ['list', 'extra'], ['list', '--agent'], ['list', '--unknown'],
    ['tail', '--since', NOW], ['tail', '--event', 'permission'], ['tail', '--limit', '2'], ['list', '--json', '--json']]) {
    await assert.rejects(auditCommand(argv, { ...opts, write: () => {} }), /usage:/);
  }
  for (const since of ['yesterday', '2026', '-P', '-PT', '-P1M', 'P1D', '2026-99-99']) {
    await assert.rejects(listing(['--since', since], opts), /--since/);
  }
});

test('tail prints all existing agent matches then follows complete JSONL records, including split UTF-8', async (t) => {
  const opts = scratch(t);
  const rows = Array.from({ length: 210 }, (_, i) => ({ at: NOW, event: 'permission', agentId: AGENT_ID, detail: `old ${i}` }));
  seed(opts, [...rows, { at: NOW, event: 'permission', agentId: OTHER_ID }]);
  const tail = following(t, opts, ['--json', '--agent', AGENT_ID]);
  await waitFor(() => tail.lines.length === 210);
  assert.deepEqual(tail.lines.map((line) => JSON.parse(line)), rows);
  const next = { at: NOW, event: 'permission', agentId: AGENT_ID, detail: 'new … record' };
  const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
  const split = bytes.indexOf(Buffer.from('…')) + 1;
  appendFileSync(auditFile(opts), bytes.subarray(0, split));
  await delay(40);
  assert.equal(tail.lines.length, 210);
  appendFileSync(auditFile(opts), bytes.subarray(split));
  appendFileSync(auditFile(opts), `malformed\n${JSON.stringify({ ...next, agentId: OTHER_ID })}\n`);
  await waitFor(() => tail.lines.length === 211);
  assert.deepEqual(JSON.parse(tail.lines[210]), next);
  tail.signals.emit('SIGINT');
  await tail.done;
  assert.equal(tail.signals.listenerCount('SIGINT'), 0);
  assert.equal(tail.stdin.listenerCount('end'), 0);
  assert.equal(tail.stdin.listenerCount('close'), 0);
});

test('tail follows a file created later, handles rotation and truncation, and stops on stdin end', async (t) => {
  const opts = scratch(t);
  const tail = following(t, opts, ['--agent', AGENT_ID]);
  const row = { at: NOW, event: 'permission', agentId: AGENT_ID, operation: 'Read', decision: 'allow', detail: 'one\nline' };
  seed(opts, [row]);
  await waitFor(() => tail.lines.length === 1);
  assert.match(tail.lines[0], /Read allow one line$/);
  renameSync(auditFile(opts), `${auditFile(opts)}.old`);
  seed(opts, [{ ...row, detail: 'rotated' }]);
  await waitFor(() => tail.lines.length === 2);
  writeFileSync(auditFile(opts), '');
  await delay(40);
  appendFileSync(auditFile(opts), `${JSON.stringify({ ...row, detail: 'truncated' })}\n`);
  await waitFor(() => tail.lines.length === 3);
  assert.match(tail.lines[2], /truncated$/);
  tail.stdin.end();
  await tail.done;
  appendFileSync(auditFile(opts), `${JSON.stringify(row)}\n`);
  await delay(40);
  assert.equal(tail.lines.length, 3);
});

test('tail stops on stdin close without leaving a signal listener', async (t) => {
  const opts = scratch(t);
  const tail = following(t, opts);
  tail.stdin.destroy();
  await tail.done;
  assert.equal(tail.signals.listenerCount('SIGINT'), 0);
});

test('audit is dispatched by the CLI, appears in help, and tail exits cleanly on SIGINT', { timeout: 10000 }, async (t) => {
  const opts = scratch(t);
  const row = appendAuditReceipt({ event: 'permission', agentId: AGENT_ID, operation: 'Read', decision: 'allow' }, opts);
  const env = { ...opts.env, PATH: process.env.PATH, XDG_STATE_HOME: path.join(opts.home, 'state') };
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [CLI, 'audit', 'list', '--json'], { env, encoding: 'utf8' })), { records: [row] });
  assert.match(execFileSync(process.execPath, [CLI, '--help'], { env, encoding: 'utf8' }), /audit\s+Read audit receipts/);
  const child = spawn(process.execPath, [CLI, 'audit', 'tail', '--json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  await waitFor(() => output.includes('\n'));
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(output), row);
  assert.equal(errors, '');
  const closed = spawn(process.execPath, [CLI, 'audit', 'tail', '--json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (closed.exitCode === null && closed.signalCode === null) closed.kill('SIGKILL'); });
  const closedExit = new Promise((resolve, reject) => {
    closed.once('error', reject);
    closed.once('exit', (code, signal) => resolve({ code, signal }));
  });
  closed.stdout.resume();
  closed.stderr.resume();
  closed.stdin.end();
  assert.deepEqual(await closedExit, { code: 0, signal: null });
});
