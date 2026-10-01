import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_EVENTS,
  DIALECTS,
  budgetMs,
  contextNote,
  encodeContext,
  encodeDecision,
  envelopeEnv,
  isBlocking,
  normalizeEnvelope,
  supportsContext,
  vendorEvent,
} from '../hook-dialects.mjs';
import { hookCoverage } from '../doctor.mjs';

// A deny that is encoded exactly like the dialect's allow response is a guard
// which silently passed.
function readsAsAllow(dialectKey, event, { stdout, exitCode }) {
  const allow = encodeDecision({ dialectKey, event, decision: 'allow' });
  return exitCode === allow.exitCode && stdout === allow.stdout;
}

test('a denial is never encoded as an allow, in any dialect, on any event', () => {
  for (const { key } of DIALECTS) {
    for (const event of CANONICAL_EVENTS) {
      if (!vendorEvent(key, event)) continue;
      const encoded = encodeDecision({ dialectKey: key, event, decision: 'deny', reason: 'nope' });
      assert.equal(readsAsAllow(key, event, encoded), false, `${key}/${event} encoded a deny as an allow`);
    }
  }
});

test('an allow uses the dialect-specific neutral response', () => {
  for (const { key } of DIALECTS) {
    for (const event of CANONICAL_EVENTS) {
      if (!vendorEvent(key, event)) continue;
      assert.deepEqual(
        encodeDecision({ dialectKey: key, event, decision: 'allow' }),
        { stdout: key === 'cursor' ? '{}' : '', stderr: '', exitCode: 0 },
      );
    }
  }
});

// Devin Desktop and git have no stdout channel at all — exit code is everything
// they can say. `ask` has to go somewhere, and on a blocking event the only
// safe direction is closed.
test('ask degrades toward deny on exit-code-only dialects, never toward allow', () => {
  const blocking = encodeDecision({
    dialectKey: 'devin-desktop', event: 'pre-command', decision: 'ask', reason: 'unsure',
  });
  assert.equal(blocking.exitCode, 2);

  const advisory = encodeDecision({
    dialectKey: 'devin-desktop', event: 'post-tool-use', decision: 'ask', reason: 'unsure',
  });
  assert.equal(advisory.exitCode, 0);
});

test('each dialect denies in its own vendor shape', () => {
  const deny = (key, event) => encodeDecision({ dialectKey: key, event, decision: 'deny', reason: 'r' });

  assert.deepEqual(JSON.parse(deny('claude', 'pre-command').stdout).hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'r',
  });
  assert.equal(JSON.parse(deny('cursor', 'pre-command').stdout).permission, 'deny');
  assert.equal(JSON.parse(deny('copilot', 'pre-command').stdout).permissionDecision, 'deny');
  assert.equal(deny('devin-desktop', 'pre-command').exitCode, 2);
  assert.equal(deny('git', 'pre-commit').exitCode, 2);
});

// Codex caps SessionEnd at ~3s. Copilot's preToolUse fails OPEN on a vendor
// timeout, so our clock must always fire first — both are the same mechanism.
test('the runner budgets strictly inside the vendor timeout cap', () => {
  assert.ok(budgetMs('codex', 'session-end', 10000) <= 2500);
  assert.ok(budgetMs('copilot', 'pre-tool-use', 60000) < 30000);
  assert.equal(budgetMs('claude', 'pre-command', 10000), 10000, 'an uncapped dialect is untouched');
  assert.ok(budgetMs('codex', 'session-end', 100) <= 100, 'a smaller request is never inflated');
});

test('nativeFailMode and timeoutFailMode stay separate fields', () => {
  // Collapsing these is how a guard stops guarding under load: Copilot fails
  // closed on a hook error but open on a hook timeout.
  const copilot = DIALECTS.find((d) => d.key === 'copilot');
  assert.equal(copilot.nativeFailMode, 'closed');
  assert.equal(copilot.timeoutFailMode, 'open');
  for (const d of DIALECTS) {
    assert.ok(d.nativeFailMode, `${d.key} declares no nativeFailMode`);
    assert.ok(d.timeoutFailMode, `${d.key} declares no timeoutFailMode`);
  }
});

test('a fail-open dialect declares the flag that reaches fail-closed', () => {
  const cursor = DIALECTS.find((d) => d.key === 'cursor');
  assert.equal(cursor.nativeFailMode, 'open');
  assert.deepEqual(cursor.requiresFlag, { failClosed: true });
});

test('every row carries evidence and a verification date', () => {
  for (const d of DIALECTS) {
    assert.ok(Array.isArray(d.evidence) && d.evidence.length > 0, `${d.key} has no evidence`);
    assert.match(d.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${d.key} has no verifiedOn`);
    assert.ok(['verified', 'unverified'].includes(d.status), `${d.key} has an odd status`);
  }
});

test('canonical event names match no vendor spelling', () => {
  for (const event of CANONICAL_EVENTS) {
    assert.match(event, /^[a-z][a-z-]*$/, `${event} is not kebab-case`);
  }
  // If canonical names looked like a vendor's, a vendor rename would silently
  // make one name mean two things.
  for (const d of DIALECTS) {
    for (const [canonical, spec] of Object.entries(d.events)) {
      const vendor = typeof spec === 'string' ? spec : spec.event;
      if (d.key === 'git') continue; // git's spelling IS the canonical one
      assert.notEqual(vendor, canonical, `${d.key} maps ${canonical} to itself`);
    }
  }
});

test('a declared gap is null, not a silent no-op', () => {
  assert.equal(vendorEvent('devin-desktop', 'prompt-submit'), null);
  assert.equal(vendorEvent('git', 'pre-tool-use'), null);
  assert.ok(vendorEvent('claude', 'pre-command'));
});

test('the git layer covers exactly the two events no harness can be trusted for', () => {
  const git = DIALECTS.find((d) => d.key === 'git');
  assert.deepEqual(Object.keys(git.events).sort(), ['pre-commit', 'pre-push']);
  assert.ok(isBlocking('pre-commit') && isBlocking('pre-push'));
});

test('Devin CLI is served by the claude row, so no .devin file is ever written', () => {
  const claude = DIALECTS.find((d) => d.key === 'claude');
  assert.ok(claude.alsoServes.includes('devin-cli'));
  assert.equal(DIALECTS.some((d) => (d.file ?? '').startsWith('.devin/')), false);
});

test('the legacy row declares itself and how it retires', () => {
  const desktop = DIALECTS.find((d) => d.key === 'devin-desktop');
  assert.equal(desktop.legacy, true);
  assert.ok(desktop.retirementSignal);
  assert.equal(DIALECTS.filter((d) => d.legacy).length, 1);
});

// Session id is the field every vendor names differently.
test('the envelope normalizes each dialect session id into one field', () => {
  const cases = [
    ['claude', { session_id: 'a' }],
    ['cursor', { conversation_id: 'a' }],
    ['devin-desktop', { trajectory_id: 'a' }],
    ['copilot', { sessionId: 'a' }],
  ];
  for (const [key, payload] of cases) {
    const envelope = normalizeEnvelope({ dialectKey: key, event: 'session-start', payload });
    assert.equal(envelope.session_id, 'a', `${key} session id not normalized`);
  }
});

test('a shell command is found wherever the dialect hides it', () => {
  const shapes = [
    { tool_input: { command: 'git push --force' } },
    { toolArgs: { command: 'git push --force' } },
    { tool_info: { command_line: 'git push --force' } },
  ];
  for (const payload of shapes) {
    const envelope = normalizeEnvelope({ dialectKey: 'claude', event: 'pre-command', payload });
    assert.equal(envelope.command, 'git push --force');
  }
});

test('an unmodelled payload yields nulls and keeps raw, rather than throwing', () => {
  const payload = { something_new: { nested: 1 } };
  const envelope = normalizeEnvelope({ dialectKey: 'cursor', event: 'pre-command', payload });
  assert.equal(envelope.command, null);
  assert.equal(envelope.session_id, null);
  assert.deepEqual(envelope.raw, payload, 'raw must survive verbatim for hooks to dig');
});

// Model coverage is partial by nature — Codex and Cursor document a model
// field, Windsurf sends model_name, Claude Code sends none. A consumer must
// therefore treat it as optional, which is exactly what the null does.
test('the model is normalized where a dialect sends one, and null where none does', () => {
  const cases = [
    [{ model: 'gpt-5-codex' }, 'gpt-5-codex'],
    [{ model_id: 'kimi-k3' }, 'kimi-k3'],
    [{ model_name: 'claude-opus-5' }, 'claude-opus-5'],
    [{ session_id: 'x' }, null],
  ];
  for (const [payload, expected] of cases) {
    const envelope = normalizeEnvelope({ dialectKey: 'cursor', event: 'session-start', payload });
    assert.equal(envelope.model, expected);
  }
  // Cursor sends both; the human-readable name wins over the id.
  assert.equal(
    normalizeEnvelope({
      dialectKey: 'cursor',
      event: 'session-start',
      payload: { model: 'kimi-k3', model_id: 'moonshot/kimi-k3' },
    }).model,
    'kimi-k3',
  );
  assert.equal(
    envelopeEnv(normalizeEnvelope({
      dialectKey: 'codex', event: 'session-start', payload: { model: 'gpt-5-codex' },
    })).AGENT_HOOK_MODEL,
    'gpt-5-codex',
  );
});

test('the env mirror omits absent fields instead of exporting empty strings', () => {
  const env = envelopeEnv(normalizeEnvelope({
    dialectKey: 'claude', event: 'pre-command', payload: { tool_input: { command: 'ls' } },
  }));
  assert.equal(env.AGENT_HOOK_TOOL_COMMAND, 'ls');
  assert.equal(env.AGENT_HOOK_BLOCKING, '1');
  assert.equal('AGENT_HOOK_TOOL_PATH' in env, false);
});

test('doctor exposes declared gaps, unverified rows, and stale evidence', () => {
  const current = hookCoverage(new Date('2026-08-04T00:00:00Z'));
  assert.equal(current.find((row) => row.key === 'claude').covered, 8);
  assert.equal(current.find((row) => row.key === 'devin-desktop').covered, 5);
  assert.equal(current.find((row) => row.key === 'cursor').status, 'unverified');
  assert.equal(current.some((row) => row.stale), false);

  // Context is reported next to event coverage, because a dialect can wire every
  // event and still have nowhere to put a SessionStart instruction.
  assert.deepEqual(current.find((row) => row.key === 'claude').contextEvents, ['session-start']);
  assert.equal(current.find((row) => row.key === 'claude').contextNote, null);
  assert.deepEqual(current.find((row) => row.key === 'cursor').contextEvents, []);
  assert.match(current.find((row) => row.key === 'cursor').contextNote, /no context field/);

  const stale = hookCoverage(new Date('2027-01-01T00:00:00Z'));
  assert.equal(stale.every((row) => row.stale), true);
});

// --- context injection -------------------------------------------------------------

// Context is advisory text for the model and a separate axis from the permission
// answer: a hook that injects can only ever add to a session, never deny it. A
// dialect with no channel returns null — a declared gap the runner reports —
// rather than an encoding that silently drops what the hook said.
test("context rides the dialect's own envelope, and is never a verdict", () => {
  const encoded = encodeContext({
    dialectKey: 'claude', event: 'session-start', contexts: ['arm it'],
  });
  assert.deepEqual(JSON.parse(encoded.stdout), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'arm it' },
  });
  assert.equal(encoded.exitCode, 0);
  assert.equal(encoded.stderr, '');
  assert.equal(encoded.stdout.includes('permissionDecision'), false, 'context invents no verdict field');

  // Every hook that spoke arrives, in order, in one injection.
  assert.equal(
    JSON.parse(encodeContext({
      dialectKey: 'claude', event: 'session-start', contexts: ['first', 'second'],
    }).stdout).hookSpecificOutput.additionalContext,
    'first\n\nsecond',
  );

  assert.deepEqual(
    encodeContext({ dialectKey: 'claude', event: 'session-start', contexts: ['', '   ', null, 7] }),
    encodeDecision({ dialectKey: 'claude', event: 'session-start', decision: 'allow' }),
    'nothing to say is the neutral allow, not an empty additionalContext',
  );

  // Codex already speaks the claude-json stdout channel for decisions, so the
  // same envelope carries its context too.
  assert.deepEqual(
    JSON.parse(encodeContext({ dialectKey: 'codex', event: 'session-start', contexts: ['arm it'] }).stdout),
    JSON.parse(encoded.stdout),
  );
});

test('a dialect with no context channel declares the gap rather than dropping the text', () => {
  assert.equal(supportsContext('claude', 'session-start'), true);
  assert.equal(contextNote('claude'), null);
  for (const { key } of DIALECTS) {
    if (supportsContext(key, 'session-start')) continue;
    assert.equal(
      encodeContext({ dialectKey: key, event: 'session-start', contexts: ['x'] }),
      null,
      `${key} encodes context it has no channel for`,
    );
    assert.ok(contextNote(key), `${key} has no context channel and nothing says why`);
  }
  // Cursor wires session-start for decisions; the gap is on the context axis,
  // not in event coverage — which is why the two are tracked separately.
  assert.equal(vendorEvent('cursor', 'session-start').event, 'sessionStart');
  assert.equal(supportsContext('cursor', 'session-start'), false);
  assert.match(contextNote('cursor'), /no context field is documented/);
  // SessionStart is the only modelled event: it is the one place a hook needs to
  // say something standing instead of answering about an action.
  assert.equal(supportsContext('claude', 'pre-command'), false);
  assert.equal(encodeContext({ dialectKey: 'claude', event: 'pre-command', contexts: ['x'] }), null);
});
