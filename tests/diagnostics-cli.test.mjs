import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnostics, diagnosticsDirectory } from '../diagnostics.mjs';
import { buildExport, EXPORT_FORMAT, main } from '../diagnostics-cli.mjs';

const AGENT = 'agent_0f554a21-0b41-884e-b9ed-fd1d10fa5a4a';
const CANARY = 'ghs_CANARYcanary0123456789abcdefABCDEF';
const NOW = new Date('2026-10-11T12:00:00Z');

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-diag-cli-'));
  const env = { XDG_STATE_HOME: join(home, '.local', 'state') };
  let clock = new Date('2026-10-11T11:00:00Z');
  const diagnostics = createDiagnostics({ component: 'daemon', version: '0.10.64', env, home, now: () => clock });
  const at = (iso) => { clock = new Date(iso); };
  return { home, env, diagnostics, at, run: (argv, extra = {}) => {
    let out = '';
    let err = '';
    const code = main(argv, { env, home, cwd: home, now: () => NOW, writeOut: (s) => { out += s; }, writeErr: (s) => { err += s; }, ...extra });
    return { code, out, err };
  } };
}

test('preview prints the bundle to stdout, writes nothing, and keeps stdout machine-readable', () => {
  const f = fixture();
  f.diagnostics.record({ event: 'launch', stage: 'sign-in', outcome: 'refused', code: 'harness-signed-out', agentId: AGENT, durationMs: 40 });
  f.diagnostics.record({ event: 'launch', stage: 'harness', outcome: 'ok', agentId: AGENT });
  const { code, out, err } = f.run(['export', '--preview']);
  assert.equal(code, 0);
  const bundle = JSON.parse(out);
  assert.equal(bundle.format, EXPORT_FORMAT);
  assert.equal(bundle.v, 1);
  assert.equal(bundle.window.until, NOW.toISOString());
  assert.equal(bundle.window.since, '2026-10-10T12:00:00.000Z', 'the default window is the last day');
  assert.deepEqual(bundle.summary, {
    events: 2, omitted: 0, outcomes: { refused: 1, ok: 1 }, codes: { 'harness-signed-out': 1 }, components: { daemon: 2 },
  });
  assert.match(err, /nothing was written or sent/);
  assert.equal(out.includes(AGENT), false, 'agents are hashed');
});

test('--since bounds the window and bad arguments are usage errors', () => {
  const f = fixture();
  f.at('2026-10-11T09:00:00Z');
  f.diagnostics.record({ event: 'early' });
  f.at('2026-10-11T11:30:00Z');
  f.diagnostics.record({ event: 'late' });
  const events = (argv) => JSON.parse(f.run(argv).out).events.map((e) => e.event);
  assert.deepEqual(events(['export', '--preview', '--since', '-PT1H']), ['late']);
  assert.deepEqual(events(['export', '--preview', '--since', '2026-10-11T08:00:00Z']), ['early', 'late']);
  for (const argv of [['export'], ['export', '--preview', '--output', 'x.json'], ['export', '--since', 'yesterday', '--preview'], ['show'], ['export', '--preview', '--preview'], ['export', '--upload', 'x']]) {
    assert.equal(f.run(argv).code, 2, argv.join(' '));
  }
});

test('--output writes a new owner-only file and never replaces one', () => {
  const f = fixture();
  f.diagnostics.record({ event: 'launch', outcome: 'failed' });
  const first = f.run(['export', '--output', 'bundle.json']);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out, '');
  const file = join(f.home, 'bundle.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).summary.events, 1);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(join(f.home, 'taken.json'), 'keep');
  const again = f.run(['export', '--output', 'taken.json']);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
  assert.equal(readFileSync(join(f.home, 'taken.json'), 'utf8'), 'keep');
});

test('a tampered store is re-checked: unknown fields dropped, detail redacted again, bad lines skipped', () => {
  const f = fixture();
  f.diagnostics.record({ event: 'launch' });
  appendFileSync(join(diagnosticsDirectory({ env: f.env, home: f.home }), 'events.jsonl'), [
    JSON.stringify({ v: 1, at: '2026-10-11T11:10:00.000Z', component: 'daemon', event: 'planted', detail: `${CANARY} in ${f.home}/x`, prompt: 'SECRET-PROMPT', agent: AGENT, durationMs: 1.5 }),
    JSON.stringify({ v: 1, at: 'not-a-time', component: 'daemon', event: 'bad' }),
    '{"v":1,',
  ].join('\n') + '\n');
  const bundle = buildExport({ sinceMs: Date.parse('2026-10-11T00:00:00Z'), env: f.env, home: f.home, now: () => NOW });
  assert.deepEqual(bundle.events.map((e) => e.event), ['launch', 'planted']);
  const planted = bundle.events[1];
  assert.deepEqual(Object.keys(planted), ['v', 'at', 'component', 'event', 'detail']);
  const text = JSON.stringify(bundle);
  for (const leak of [CANARY, f.home, 'SECRET-PROMPT', AGENT]) assert.equal(text.includes(leak), false, leak);
});

test('an empty or missing store exports an empty bundle', () => {
  const f = fixture();
  const { code, out } = f.run(['export', '--preview']);
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).summary.events, 0);
  assert.equal(existsSync(join(f.home, 'bundle.json')), false);
});

test('the reported window never reaches past retention, and tallies have no prototype', () => {
  const f = fixture();
  f.diagnostics.record({ event: 'launch', outcome: 'failed', code: 'tool-home-unwritable' });
  const bundle = JSON.parse(f.run(['export', '--preview', '--since', '2026-01-01T00:00:00Z']).out);
  assert.equal(bundle.window.since, '2026-10-04T12:00:00.000Z', 'the 7-day floor, not the requested start');
  assert.equal(bundle.summary.events, 1);
  const codes = buildExport({ sinceMs: 0, env: f.env, home: f.home, now: () => NOW }).summary.codes;
  assert.equal(Object.getPrototypeOf(codes), null);
});
