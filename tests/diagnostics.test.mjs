import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDiagnostics, diagnosticEvent, diagnosticsDirectory, hashAgentId, readDiagnostics,
} from '../diagnostics.mjs';
import { formatTraceparent, parseTraceparent, startSpan } from '../traceparent.mjs';

const AGENT = 'agent_0f554a21-0b41-884e-b9ed-fd1d10fa5a4a';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-diag-'));
  const env = { XDG_STATE_HOME: join(home, '.local', 'state') };
  return { home, env, dir: diagnosticsDirectory({ env, home }) };
}

test('the store sits beside the identity state and is owner-only', () => {
  const f = fixture();
  assert.equal(f.dir, join(f.home, '.local', 'state', 'agent-bot', 'diagnostics'));
  const diagnostics = createDiagnostics({ component: 'daemon', version: '0.10.64', env: f.env, home: f.home });
  assert.equal(diagnostics.record({ event: 'launch', stage: 'account', outcome: 'ok' }), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.dir, 'events.jsonl')).mode & 0o777, 0o600);
  }
  const [event] = readDiagnostics({ env: f.env, home: f.home });
  assert.equal(event.v, 1);
  assert.equal(event.component, 'daemon');
  assert.equal(event.version, '0.10.64');
  assert.match(event.id, /^[0-9a-f]{16}$/);
});

test('only allowlisted, well-formed fields are kept; the agent is hashed and detail redacted', () => {
  const f = fixture();
  const canary = 'ghs_CANARYcanary0123456789abcdefABCDEF';
  const event = diagnosticEvent({
    event: 'launch', stage: 'sign-in', outcome: 'refused', code: 'harness-signed-out', durationMs: 12.6,
    traceId: TRACE, spanId: SPAN, parentSpanId: 'not-hex', agentId: AGENT,
    detail: `token ${canary} at ${f.home}/.claude/x`, prompt: 'SECRET-PROMPT', env: { GH_TOKEN: canary }, message: 'SECRET-BODY',
  }, { component: 'daemon', env: f.env, home: f.home, now: () => new Date('2026-10-11T00:00:00Z') });
  assert.deepEqual(Object.keys(event), ['v', 'at', 'id', 'component', 'event', 'stage', 'outcome', 'code', 'durationMs', 'traceId', 'spanId', 'agent', 'detail']);
  assert.equal(event.durationMs, 13);
  assert.equal(event.agent, hashAgentId(AGENT));
  assert.match(event.agent, /^[0-9a-f]{16}$/);
  const text = JSON.stringify(event);
  for (const leak of [canary, AGENT, f.home, 'SECRET-PROMPT', 'SECRET-BODY']) assert.equal(text.includes(leak), false, leak);
  assert.equal(diagnosticEvent({ event: 'Bad Name' }, { component: 'daemon' }), null);
  const loose = diagnosticEvent({ event: 'x', outcome: 'maybe', code: 'has space', durationMs: -1, stage: 7 }, { component: 'cli' });
  assert.deepEqual(Object.keys(loose), ['v', 'at', 'id', 'component', 'event']);
  assert.equal(hashAgentId('agent_not-valid'), null);
});

test('the live file rotates into one previous generation, bounding the store', () => {
  const f = fixture();
  const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home, maxFileBytes: 2000 });
  for (let i = 0; i < 200; i += 1) assert.equal(diagnostics.record({ event: 'tick', code: `n${i}` }), true);
  assert.deepEqual(readdirSync(f.dir).sort(), ['events.1.jsonl', 'events.jsonl']);
  for (const file of readdirSync(f.dir)) assert.ok(statSync(join(f.dir, file)).size <= 2000, file);
  const events = readDiagnostics({ env: f.env, home: f.home });
  assert.equal(events.at(-1).code, 'n199');
  assert.ok(events.length < 200, 'older generations were discarded');
});

test('events older than retention are deleted at the next write and skipped on read', () => {
  const f = fixture();
  let clock = new Date('2026-10-01T00:00:00Z');
  const now = () => clock;
  const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home, now, maxFileBytes: 400 });
  for (let i = 0; i < 5; i += 1) diagnostics.record({ event: 'old' });
  assert.ok(readdirSync(f.dir).includes('events.1.jsonl'));
  const old = new Date('2026-10-01T00:00:00Z');
  utimesSync(join(f.dir, 'events.1.jsonl'), old, old);
  clock = new Date('2026-10-09T00:00:00Z');
  assert.deepEqual(readDiagnostics({ env: f.env, home: f.home, now }), [], 'nothing older than 7 days is read');
  diagnostics.record({ event: 'new' });
  assert.equal(readdirSync(f.dir).includes('events.1.jsonl'), false);
  assert.deepEqual(readDiagnostics({ env: f.env, home: f.home, now }).map((e) => e.event), ['new']);
  assert.deepEqual(readDiagnostics({ env: f.env, home: f.home, now, since: Date.parse('2026-10-10T00:00:00Z') }), []);
});

test('a failed write never throws, is counted, and is recorded on the next success', () => {
  const f = fixture();
  mkdirSync(join(f.home, '.local', 'state', 'agent-bot'), { recursive: true });
  writeFileSync(f.dir, 'not a directory');
  const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home });
  assert.equal(diagnostics.record({ event: 'launch' }), false);
  assert.equal(diagnostics.record({ event: 'launch' }), false);
  assert.equal(diagnostics.dropped(), 2);
  const other = fixture();
  const healthy = createDiagnostics({ component: 'daemon', env: other.env, home: other.home });
  healthy.record({ event: 'BAD NAME' });
  assert.equal(healthy.dropped(), 1);
  healthy.record({ event: 'launch' });
  assert.equal(healthy.dropped(), 0);
  const events = readDiagnostics({ env: other.env, home: other.home });
  assert.deepEqual(events.map((e) => [e.event, e.code]), [['diagnostics-dropped', 'diagnostics-dropped'], ['launch', undefined]]);
  assert.equal(events[0].detail, '1 event(s) were not recorded');
});

test('a symlink at the log path is refused, not followed', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  mkdirSync(f.dir, { recursive: true });
  const target = join(f.home, 'elsewhere.txt');
  writeFileSync(target, '');
  symlinkSync(target, join(f.dir, 'events.jsonl'));
  const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home });
  assert.equal(diagnostics.record({ event: 'launch' }), false);
  assert.equal(readFileSync(target, 'utf8'), '');
});

test('malformed stored lines and other schema versions are skipped on read', () => {
  const f = fixture();
  mkdirSync(f.dir, { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(f.dir, 'events.jsonl'), `not json\n${JSON.stringify({ v: 2, at, event: 'x' })}\n${JSON.stringify({ v: 1, at, component: 'cli', event: 'kept' })}\n`);
  assert.deepEqual(readDiagnostics({ env: f.env, home: f.home }).map((e) => e.event), ['kept']);
});

test('traceparent parses only valid W3C values and links child spans', () => {
  const valid = `00-${TRACE}-${SPAN}-01`;
  assert.deepEqual(parseTraceparent(valid), { traceId: TRACE, spanId: SPAN, flags: '01' });
  for (const bad of [
    `ff-${TRACE}-${SPAN}-01`, `00-${'0'.repeat(32)}-${SPAN}-01`, `00-${TRACE}-${'0'.repeat(16)}-01`,
    `00-${TRACE.toUpperCase()}-${SPAN}-01`, `00-${TRACE}-${SPAN}-01-extra`, 'garbage', null, 42,
  ]) assert.equal(parseTraceparent(bad), null, String(bad));
  assert.deepEqual(parseTraceparent(`01-${TRACE}-${SPAN}-00-future`), { traceId: TRACE, spanId: SPAN, flags: '00' });

  const child = startSpan(valid);
  assert.equal(child.traceId, TRACE);
  assert.equal(child.parentSpanId, SPAN);
  assert.notEqual(child.spanId, SPAN);
  assert.equal(child.traceparent, formatTraceparent(child));
  assert.deepEqual(parseTraceparent(child.traceparent).traceId, TRACE);
  const grandchild = startSpan(child);
  assert.equal(grandchild.parentSpanId, child.spanId);
  const root = startSpan('00-forged-or-broken');
  assert.notEqual(root.traceId, TRACE);
  assert.equal(root.parentSpanId, null);
  assert.match(root.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});
