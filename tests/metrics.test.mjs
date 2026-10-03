import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { claudeCallFromLine, collectMetrics, main, metricsDirectory, readNewLines, recordSession, recordSoulSession, showMetrics, worktreeSoul } from '../metrics.mjs';

const SESSION = '0f8e0c52-1b7d-4c1e-9d55-3a1f2b6c7d8e';
const OTHER = '9a9a9a9a-0000-4000-8000-000000000000';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-metrics-'));
  const env = { XDG_STATE_HOME: join(home, '.local', 'state') };
  const stateDir = stateDirectory({ env, home });
  const projects = join(home, '.claude', 'projects');
  mkdirSync(join(projects, '-work-a'), { recursive: true });
  mkdirSync(join(projects, '-work-b'), { recursive: true });
  const soul = (sessionId, provider = 'claude') => mintAgentIdentity({
    appSlug: null, useGithub: false, harness: 'claude', transcript: { provider, id: sessionId }, stateDir, home, env,
  });
  return { home, env, stateDir, projects, soul };
}

const call = (id, { at = '2026-10-03T12:00:00.000Z', model = 'claude-opus-5-5', input = 10, read = 1000, created = 5, output = 7, sidechain = false, content = 'SECRET-CONTENT' } = {}) => JSON.stringify({
  type: 'assistant', isSidechain: sidechain, timestamp: at, cwd: '/private/path', sessionId: SESSION,
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: content }],
    usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: created, output_tokens: output },
  },
});

test('a soul is bound only through its recorded session, and only allowlisted fields are kept', () => {
  const f = fixture();
  const bound = f.soul(SESSION);
  const missing = f.soul(OTHER);
  f.soul('ffffffff-0000-4000-8000-000000000001', 'codex');
  const log = join(f.projects, '-work-b', `${SESSION}.jsonl`);
  writeFileSync(log, [
    JSON.stringify({ type: 'user', message: { content: 'SECRET-PROMPT' } }),
    call('msg_1', { at: '2026-10-03T12:00:00.000Z', output: 1 }),
    call('msg_1', { at: '2026-10-03T12:00:00.000Z', output: 9 }),
    call('msg_side', { at: '2026-10-03T12:05:00.000Z', model: 'claude-haiku-4-5', sidechain: true }),
  ].join('\n') + '\n');
  // A log that merely mentions the model or sits in a matching path is not a binding.
  writeFileSync(join(f.projects, '-work-a', 'unrelated.jsonl'), `${call('msg_x', { at: '2026-10-03T13:00:00.000Z' })}\n`);

  const result = collectMetrics({ home: f.home, env: f.env, now: () => new Date('2026-10-03T12:10:00Z') });
  assert.deepEqual(Object.keys(result.souls), [bound.id]);
  assert.deepEqual(result.missing, [{ agentId: missing.id, source: 'claude-session-log' }]);
  assert.deepEqual(result.errors, []);

  const shown = showMetrics({ home: f.home, env: f.env });
  const soul = shown.souls[bound.id];
  const value = (metric) => soul.observations.find((o) => o.metric === metric);
  assert.equal(value('model_reported').value, 'claude-opus-5-5', 'the sidechain call is not this context');
  assert.equal(value('context_used_tokens').value, 1015);
  assert.equal(value('context_used_tokens').method, 'last-call-usage');
  assert.equal(value('context_capacity_tokens').value, 'unknown');
  assert.equal(value('output_tokens').value, 9, 'the latest line of a repeated message wins');
  for (const o of soul.observations) {
    assert.deepEqual(Object.keys(o).filter((k) => !['metric', 'value', 'unit', 'scope', 'source', 'kind', 'method', 'observedAt'].includes(k)), []);
  }
  const stored = readFileSync(join(metricsDirectory({ home: f.home, env: f.env }), 'latest.json'), 'utf8')
    + readFileSync(join(metricsDirectory({ home: f.home, env: f.env }), 'checkpoints.json'), 'utf8');
  for (const leak of ['SECRET-CONTENT', 'SECRET-PROMPT', '/private/path', '-work-b']) assert.equal(stored.includes(leak), false, leak);
  assert.equal(statSync(join(metricsDirectory({ home: f.home, env: f.env }), 'latest.json')).mode & 0o777, 0o600);
});

test('reads are incremental, never pass a partial line, and restart after truncation or rotation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-metrics-lines-'));
  const log = join(dir, 's.jsonl');
  writeFileSync(log, `${call('msg_1')}\n${call('msg_2').slice(0, 40)}`);
  let step = readNewLines(log, null);
  assert.deepEqual(step.calls.map((c) => c.id), ['msg_1']);
  const afterFirst = step.checkpoint.offset;
  assert.equal(afterFirst, Buffer.byteLength(`${call('msg_1')}\n`), 'the partial line is left for later');

  appendFileSync(log, `${call('msg_2').slice(40)}\n`);
  step = readNewLines(log, step.checkpoint);
  assert.deepEqual(step.calls.map((c) => c.id), ['msg_2']);
  step = readNewLines(log, step.checkpoint);
  assert.deepEqual(step.calls, [], 'nothing is read twice');

  writeFileSync(log, `${call('msg_3')}\n`);
  const truncated = readNewLines(log, { ...step.checkpoint, identity: `${statSync(log).dev}:${statSync(log).ino}` });
  assert.deepEqual(truncated.calls.map((c) => c.id), ['msg_3'], 'a shorter file starts again');

  renameSync(log, `${log}.old`);
  writeFileSync(log, `${call('msg_4')}\n${call('msg_5')}\n${call('msg_6')}\n`);
  const rotated = readNewLines(log, truncated.checkpoint);
  assert.deepEqual(rotated.calls.map((c) => c.id), ['msg_4', 'msg_5', 'msg_6'], 'a new file identity starts again');
});

test('a new large source starts at its tail and reports what it skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-metrics-tail-'));
  const log = join(dir, 's.jsonl');
  const lines = Array.from({ length: 20 }, (_, i) => call(`msg_${i}`)).join('\n') + '\n';
  writeFileSync(log, lines);
  const size = Buffer.byteLength(call('msg_0')) + 1;
  const step = readNewLines(log, null, { maxBytes: size * 3 - 5 });
  assert.deepEqual(step.calls.map((c) => c.id), ['msg_18', 'msg_19'], 'the partial first line is dropped');
  assert.equal(step.skippedBytes, Buffer.byteLength(lines) - (size * 3 - 5));
  assert.equal(step.behind, 0);
  assert.equal(readNewLines(log, step.checkpoint, { maxBytes: 10 }).skippedBytes, 0, 'a known source never skips');
});

test('reads are bounded per run and resume where they stopped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-metrics-bound-'));
  const log = join(dir, 's.jsonl');
  const lines = Array.from({ length: 20 }, (_, i) => call(`msg_${i}`)).join('\n') + '\n';
  writeFileSync(log, `${call('msg_0')}\n`);
  const maxBytes = Buffer.byteLength(call('msg_0')) * 3 + 10;
  let checkpoint = readNewLines(log, null, { maxBytes }).checkpoint;
  writeFileSync(log, lines);
  const seen = ['msg_0'];
  for (let i = 0; i < 20 && (checkpoint?.offset ?? 0) < Buffer.byteLength(lines); i += 1) {
    const step = readNewLines(log, checkpoint, { maxBytes });
    assert.ok(step.calls.length <= 3);
    seen.push(...step.calls.map((c) => c.id));
    checkpoint = step.checkpoint;
  }
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, i) => `msg_${i}`));
});

test('malformed lines and values are ignored, not trusted', () => {
  assert.equal(claudeCallFromLine('not json'), null);
  assert.equal(claudeCallFromLine(JSON.stringify({ type: 'assistant', message: { id: 'm' } })), null);
  const odd = claudeCallFromLine(JSON.stringify({ type: 'assistant', timestamp: 'nope', message: { id: 'm', model: 'x'.repeat(500), usage: { input_tokens: -1, output_tokens: 1.5 } } }));
  assert.deepEqual(odd, { id: 'm', model: null, inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: null, at: null });
});

test('one unreadable source is reported and the rest still collect', () => {
  const f = fixture();
  const good = f.soul(SESSION);
  const bad = f.soul(OTHER);
  writeFileSync(join(f.projects, '-work-a', `${SESSION}.jsonl`), `${call('msg_1')}\n`);
  mkdirSync(join(f.projects, '-work-a', `${OTHER}.jsonl.d`));
  writeFileSync(join(f.projects, '-work-b', `${OTHER}.jsonl`), `${call('msg_1')}\n`, { mode: 0o000 });
  const result = collectMetrics({ home: f.home, env: f.env });
  assert.ok(result.souls[good.id]);
  if (process.getuid?.() !== 0) assert.equal(result.errors[0]?.agentId, bad.id);
});

test('the CLI collects and shows, and refuses unknown arguments', () => {
  const f = fixture();
  f.soul(SESSION);
  writeFileSync(join(f.projects, '-work-a', `${SESSION}.jsonl`), `${call('msg_1')}\n`);
  let out = '';
  assert.equal(main(['collect', '--json'], { home: f.home, env: f.env, writeOut: (s) => { out += s; } }), 0);
  assert.equal(Object.keys(JSON.parse(out).souls).length, 1);
  out = '';
  assert.equal(main(['show'], { home: f.home, env: f.env, writeOut: (s) => { out += s; } }), 0);
  assert.match(out, /model claude-opus-5-5 {2}context 1015 tokens/);
  let err = '';
  assert.equal(main(['collect', '--all'], { home: f.home, env: f.env, writeErr: (s) => { err += s; } }), 2);
  assert.match(err, /usage: agent-bot metrics/);
});

test('the session-start hook records a session for the worktree soul, and the collector binds through it', () => {
  const f = fixture();
  const soul = mintAgentIdentity({ appSlug: null, useGithub: false, harness: 'claude', stateDir: f.stateDir, home: f.home, env: f.env });
  const cwd = mkdtempSync(join(tmpdir(), 'agent-bot-metrics-wt-'));
  const pinned = (args) => {
    if (args.join(' ') === 'config --worktree --get agentbot.agentid') return `${soul.id}\n`;
    throw new Error('unset');
  };
  const unpinned = () => { throw new Error('unset'); };
  const env = { ...f.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'agentbot.agentid', GIT_CONFIG_VALUE_0: 'agent_00000000-0000-4000-8000-000000000000' };

  assert.equal(worktreeSoul({ cwd, env, git: pinned }), soul.id);
  assert.equal(recordSession({ provider: 'claude', sessionId: SESSION, cwd, env, home: f.home, git: unpinned }), null, 'no soul, nothing recorded');
  assert.equal(recordSession({ provider: 'codex', sessionId: SESSION, cwd, env, home: f.home, git: pinned }), null, 'only Claude sessions have a collector');
  assert.equal(recordSession({ provider: 'claude', sessionId: '../../etc', cwd, env, home: f.home, git: pinned }), null, 'a session id is never a path');
  for (let i = 0; i < 7; i += 1) {
    recordSession({ provider: 'claude', sessionId: `00000000-0000-4000-8000-00000000000${i}`, cwd, env, home: f.home, git: pinned });
  }
  assert.equal(recordSession({ provider: 'claude', sessionId: SESSION, cwd, env, home: f.home, git: pinned }), soul.id);
  const sessions = JSON.parse(readFileSync(join(metricsDirectory({ home: f.home, env: f.env }), 'sessions.json'), 'utf8'));
  assert.equal(sessions[soul.id].length, 5, 'only the newest few are kept');
  assert.equal(sessions[soul.id][0].sessionId, SESSION);

  writeFileSync(join(f.projects, '-work-a', `${SESSION}.jsonl`), `${call('msg_1', { model: 'claude-sonnet-5-5' })}\n`);
  collectMetrics({ home: f.home, env: f.env });
  const observed = showMetrics({ home: f.home, env: f.env }).souls[soul.id].observations;
  assert.equal(observed.find((o) => o.metric === 'model_reported').value, 'claude-sonnet-5-5');
});

test('a daemon-run soul records its session by agent id, and the collector binds through it', () => {
  const f = fixture();
  const soul = mintAgentIdentity({ appSlug: null, useGithub: false, harness: 'claude', stateDir: f.stateDir, home: f.home, env: f.env });
  assert.equal(recordSoulSession({ agentId: soul.id, provider: 'codex', sessionId: SESSION, env: f.env, home: f.home }), null, 'only Claude sessions have a collector');
  assert.equal(recordSoulSession({ agentId: soul.id, provider: 'claude', sessionId: '../../etc', env: f.env, home: f.home }), null, 'a session id is never a path');
  assert.equal(recordSoulSession({ agentId: 'not-an-agent', provider: 'claude', sessionId: SESSION, env: f.env, home: f.home }), null);
  assert.equal(recordSoulSession({ agentId: soul.id, provider: 'claude', sessionId: SESSION, env: f.env, home: f.home }), soul.id);

  writeFileSync(join(f.projects, '-work-a', `${SESSION}.jsonl`), `${call('msg_1', { model: 'claude-opus-5-5' })}\n`);
  collectMetrics({ home: f.home, env: f.env });
  const observed = showMetrics({ home: f.home, env: f.env }).souls[soul.id].observations;
  assert.equal(observed.find((o) => o.metric === 'model_reported').value, 'claude-opus-5-5');
});

test('record-session never fails the session', () => {
  let err = '';
  const code = main(['record-session'], { env: { AGENT_HOOK_HARNESS: 'claude', AGENT_HOOK_SESSION_ID: SESSION, AGENT_HOOK_CWD: '/nonexistent/dir' }, home: mkdtempSync(join(tmpdir(), 'agent-bot-metrics-rs-')), writeErr: (s) => { err += s; } });
  assert.equal(code, 0);
});
