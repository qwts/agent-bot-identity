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
  nativeHookEntry,
  confinementEvents,
  scansCommand,
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
  assert.equal(current.find((row) => row.key === 'opencode').covered, 6);
  assert.equal(current.some((row) => row.stale), false);

  // Context is reported next to event coverage, because a dialect can wire every
  // event and still have nowhere to put a SessionStart instruction.
  assert.deepEqual(current.find((row) => row.key === 'claude').contextEvents, ['session-start', 'pre-tool-use']);
  assert.equal(current.find((row) => row.key === 'claude').contextNote, null);
  assert.deepEqual(current.find((row) => row.key === 'cursor').contextEvents, []);
  assert.match(current.find((row) => row.key === 'cursor').contextNote, /no context field/);

  const stale = hookCoverage(new Date('2027-04-01T00:00:00Z'));
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

// --- OpenCode (#378) -----------------------------------------------------------------

// The payload is the plugin hook's own input and output, merged, plus the
// plugin's directory — the shapes in packages/plugin/src/index.ts at
// OpenCode 1.18.34 (anomalyco/opencode@aec0b9a6).
const OPENCODE_DIR = '/work/soul';

test('opencode maps its plugin hooks onto the canonical events, and declares what it cannot', () => {
  assert.deepEqual(vendorEvent('opencode', 'pre-tool-use'), { event: 'tool.execute.before', matcher: null });
  assert.deepEqual(vendorEvent('opencode', 'pre-command'), { event: 'tool.execute.before', matcher: '^bash$' });
  assert.deepEqual(
    vendorEvent('opencode', 'pre-file-write'),
    { event: 'tool.execute.before', matcher: '^(write|edit|apply_patch)$' },
  );
  assert.deepEqual(vendorEvent('opencode', 'post-tool-use'), { event: 'tool.execute.after', matcher: null });
  assert.deepEqual(vendorEvent('opencode', 'prompt-submit'), { event: 'chat.message', matcher: null });
  assert.deepEqual(vendorEvent('opencode', 'session-start'), { event: 'event', matcher: '^session\\.created$' });
  // Neither session.deleted nor session.idle is the end of a session.
  for (const event of ['session-end', 'agent-stop', 'spawn', 'pre-commit', 'pre-push']) {
    assert.equal(vendorEvent('opencode', event), null, event);
  }
  assert.ok(new RegExp(vendorEvent('opencode', 'pre-command').matcher).test('bash'));
  assert.equal(new RegExp(vendorEvent('opencode', 'pre-command').matcher).test('bash_extra'), false);
  // OpenCode loads `{plugin,plugins}/*.{ts,js}` under `.opencode/`; the docs
  // name `plugins/`, and the generated plugin must sit where it is loaded.
  const row = DIALECTS.find((candidate) => candidate.key === 'opencode');
  assert.equal(row.pluginFile, '.opencode/plugins/agent-bot-soul.js');
  assert.match(row.pluginFile, /^\.opencode\/plugins?\/[^/]+\.(?:ts|js)$/);
  assert.equal(row.file, null, 'no config file for sync-hooks or the builder to write');
  // The adapter is a plugin, never a config entry another writer could emit.
  assert.throws(() => nativeHookEntry('opencode', 'pre-command', 'true'), /generated plugin/);
  assert.equal(supportsContext('opencode', 'session-start'), false);
});

test('opencode tool payloads translate into the common envelope', () => {
  const bash = normalizeEnvelope({
    dialectKey: 'opencode', event: 'pre-command',
    payload: { tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'git push', description: 'd' }, directory: OPENCODE_DIR },
  });
  assert.equal(bash.harness, 'opencode');
  assert.equal(bash.vendor_event, 'tool.execute.before');
  assert.equal(bash.session_id, 'ses_1');
  assert.equal(bash.tool_name, 'bash');
  assert.equal(bash.command, 'git push');
  assert.equal(bash.cwd, OPENCODE_DIR);
  assert.equal(bash.file_path, null);
  assert.equal(bash.blocking, true);
  assert.equal(bash.raw.callID, 'call_1');

  const write = normalizeEnvelope({
    dialectKey: 'opencode', event: 'pre-tool-use',
    payload: { tool: 'write', sessionID: 'ses_1', callID: 'c', args: { filePath: '/work/soul/a.txt', content: 'x' }, directory: OPENCODE_DIR },
  });
  assert.equal(write.file_path, '/work/soul/a.txt');
  assert.equal(write.command, null);
  assert.equal(envelopeEnv(write).AGENT_HOOK_TOOL_PATH, '/work/soul/a.txt');

  // after carries the args on input and the result on output.
  const after = normalizeEnvelope({
    dialectKey: 'opencode', event: 'post-tool-use',
    payload: { tool: 'edit', sessionID: 'ses_1', callID: 'c', args: { filePath: 'b.txt' }, title: 't', output: 'ok', metadata: {} },
  });
  assert.equal(after.file_path, 'b.txt');
  assert.equal(after.blocking, false);

  // Another harness's keys are not this row's: a declared list replaces them.
  const foreign = normalizeEnvelope({
    dialectKey: 'opencode', event: 'pre-command',
    payload: { tool_name: 'Bash', session_id: 's', tool_input: { command: 'git push' }, cwd: '/elsewhere' },
  });
  assert.deepEqual(
    [foreign.tool_name, foreign.session_id, foreign.command, foreign.cwd],
    [null, null, null, null],
  );
});

test('opencode bash runs where its workdir says, resolved the way OpenCode resolves it', () => {
  const cwd = (args, directory = OPENCODE_DIR, tool = 'bash') => normalizeEnvelope({
    dialectKey: 'opencode', event: 'pre-command', payload: { tool, args, directory },
  }).cwd;
  assert.equal(cwd({ command: 'ls', workdir: '/other/repo' }), '/other/repo');
  assert.equal(cwd({ command: 'ls', workdir: '/other/repo/../x' }), '/other/x');
  assert.equal(cwd({ command: 'ls', workdir: 'sub/dir' }), '/work/soul/sub/dir');
  assert.equal(cwd({ command: 'ls', workdir: '../sibling' }), '/work/sibling');
  assert.equal(cwd({ command: 'ls' }), OPENCODE_DIR);
  assert.equal(cwd({ command: 'ls', workdir: '' }), OPENCODE_DIR);
  // A relative workdir with no absolute base cannot be placed: never a relative cwd.
  assert.equal(cwd({ command: 'ls', workdir: 'sub' }, null), null);
  assert.equal(cwd({ command: 'ls', workdir: 'sub' }, 'rel'), 'rel');
  // Only the shell tool has a workdir; a file tool's path resolves from directory.
  assert.equal(cwd({ filePath: 'a', workdir: '/other' }, OPENCODE_DIR, 'write'), OPENCODE_DIR);
});

test('opencode chat and bus payloads translate too', () => {
  const chat = normalizeEnvelope({
    dialectKey: 'opencode', event: 'prompt-submit',
    payload: {
      sessionID: 'ses_2', agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-x' }, messageID: 'm',
      message: { id: 'm', role: 'user' },
      parts: [
        { type: 'text', text: 'fix the bug' },
        { type: 'file', url: 'file:///a' },
        { type: 'text', text: 'Called the Read tool', synthetic: true },
        { type: 'text', text: 'and add a test' },
      ],
      directory: OPENCODE_DIR,
    },
  });
  assert.equal(chat.vendor_event, 'chat.message');
  assert.equal(chat.session_id, 'ses_2');
  assert.equal(chat.model, 'claude-x');
  assert.equal(chat.prompt, 'fix the bug\nand add a test');
  assert.equal(chat.blocking, true);
  assert.equal(normalizeEnvelope({ dialectKey: 'opencode', event: 'prompt-submit', payload: { parts: 'x' } }).prompt, null);

  const created = normalizeEnvelope({
    dialectKey: 'opencode', event: 'session-start',
    payload: { event: { id: 'e', type: 'session.created', properties: { sessionID: 'ses_3', info: { id: 'ses_3' } } }, directory: OPENCODE_DIR },
  });
  assert.equal(created.session_id, 'ses_3');
  assert.equal(created.cwd, OPENCODE_DIR);
  assert.equal(created.blocking, false);
  // The SDK's own type carries the id only on info.
  const sdk = normalizeEnvelope({
    dialectKey: 'opencode', event: 'session-start',
    payload: { event: { type: 'session.created', properties: { info: { id: 'ses_4', parentID: 'ses_3' } } } },
  });
  assert.equal(sdk.session_id, 'ses_4');
});

test('the opencode shell call is command-scanned on the generic event, and file tools confined on both', () => {
  const env = (event, tool, harness = 'opencode') => ({ event, harness, tool_name: tool });
  assert.equal(scansCommand(env('pre-command', 'bash')), true);
  assert.equal(scansCommand(env('pre-tool-use', 'bash')), true);
  assert.equal(scansCommand(env('pre-tool-use', 'write')), false);
  assert.equal(scansCommand(env('post-tool-use', 'bash')), false);
  // Other dialects keep scanning on pre-command only.
  assert.equal(scansCommand(env('pre-tool-use', 'Bash', 'claude')), false);
  assert.equal(scansCommand(env('pre-command', 'Bash', 'claude')), true);
  assert.deepEqual(confinementEvents('opencode'), ['pre-tool-use', 'pre-file-write']);
  assert.deepEqual(confinementEvents('claude'), ['pre-tool-use']);
  assert.deepEqual(confinementEvents('devin-desktop'), ['pre-file-write']);
});

// The plugin reads the exit code, so a verdict must be unmistakable there:
// a deny is exit 2 with the reason on stderr, and OpenCode has no ask.
test('opencode answers in exit codes, and an ask on a blocking event closes', () => {
  assert.deepEqual(
    encodeDecision({ dialectKey: 'opencode', event: 'pre-tool-use', decision: 'deny', reason: 'no' }),
    { stdout: '', stderr: 'no', exitCode: 2 },
  );
  for (const event of ['pre-tool-use', 'pre-command', 'pre-file-write', 'prompt-submit']) {
    assert.equal(encodeDecision({ dialectKey: 'opencode', event, decision: 'ask', reason: 'r' }).exitCode, 2, event);
  }
  assert.equal(encodeDecision({ dialectKey: 'opencode', event: 'post-tool-use', decision: 'ask' }).exitCode, 0);
  assert.equal(budgetMs('opencode', 'pre-command', 10000), 10000);
});

// Qwen Code v0.24.6 (QwenLM/qwen-code@753bd075): Claude-shaped hooks in
// `.qwen/settings.json`, matched on the runtime tool id (#378).
const QWEN_DIR = '/work/soul';

test('qwen maps Claude-shaped events, with plain matchers on its runtime tool ids', () => {
  assert.deepEqual(vendorEvent('qwen', 'pre-tool-use'), { event: 'PreToolUse', matcher: null });
  assert.deepEqual(vendorEvent('qwen', 'pre-command'), { event: 'PreToolUse', matcher: 'run_shell_command' });
  assert.deepEqual(vendorEvent('qwen', 'pre-file-write'), { event: 'PreToolUse', matcher: 'write_file|edit|notebook_edit' });
  assert.deepEqual(vendorEvent('qwen', 'prompt-submit'), { event: 'UserPromptSubmit', matcher: null });
  assert.deepEqual(vendorEvent('qwen', 'agent-stop'), { event: 'Stop', matcher: null });
  for (const event of ['session-start', 'session-end', 'post-tool-use']) assert.ok(vendorEvent('qwen', event), event);
  for (const event of ['spawn', 'pre-commit', 'pre-push']) assert.equal(vendorEvent('qwen', event), null, event);
  // Qwen reads a matcher starting with `^` or `(` as a regex, otherwise a
  // plain `|` list compared exactly, so neither may be an anchored regex.
  for (const event of ['pre-command', 'pre-file-write']) assert.doesNotMatch(vendorEvent('qwen', event).matcher, /^[\^(]/);
  const row = DIALECTS.find((candidate) => candidate.key === 'qwen');
  assert.equal(row.file, '.qwen/settings.json');
  // No user-level adapter: sync-hooks only writes rows with a homeFile.
  assert.equal(row.homeFile, undefined);
  assert.deepEqual(nativeHookEntry('qwen', 'pre-command', 'run'), {
    vendorEvent: 'PreToolUse',
    entry: { matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'run', timeout: 60, shell: 'bash' }] },
  });
  assert.equal(supportsContext('qwen', 'session-start'), true);
  assert.equal(supportsContext('qwen', 'pre-tool-use'), false);
});

test('qwen payloads translate through the generic fields, and the shell runs in its directory', () => {
  const bash = normalizeEnvelope({
    dialectKey: 'qwen', event: 'pre-tool-use',
    payload: { session_id: 'q1', cwd: QWEN_DIR, hook_event_name: 'PreToolUse', tool_name: 'run_shell_command',
      tool_input: { command: 'git push', is_background: false }, tool_use_id: 't1' },
  });
  assert.deepEqual([bash.harness, bash.vendor_event, bash.session_id, bash.tool_name, bash.command, bash.cwd, bash.blocking],
    ['qwen', 'PreToolUse', 'q1', 'run_shell_command', 'git push', QWEN_DIR, true]);
  const cwd = (tool_input, tool_name = 'run_shell_command') => normalizeEnvelope({
    dialectKey: 'qwen', event: 'pre-command', payload: { cwd: QWEN_DIR, tool_name, tool_input },
  }).cwd;
  assert.equal(cwd({ command: 'ls', directory: '/other/repo' }), '/other/repo');
  assert.equal(cwd({ command: 'ls' }), QWEN_DIR);
  assert.equal(cwd({ file_path: '/a', directory: '/other' }, 'write_file'), QWEN_DIR);
  const write = normalizeEnvelope({
    dialectKey: 'qwen', event: 'pre-tool-use', payload: { cwd: QWEN_DIR, tool_name: 'write_file', tool_input: { file_path: '/work/soul/a.txt', content: 'x' } },
  });
  assert.equal(write.file_path, '/work/soul/a.txt');
  const notebook = normalizeEnvelope({
    dialectKey: 'qwen', event: 'pre-tool-use', payload: { cwd: QWEN_DIR, tool_name: 'notebook_edit', tool_input: { notebook_path: '/work/soul/n.ipynb' } },
  });
  assert.equal(notebook.file_path, '/work/soul/n.ipynb');
  const prompt = normalizeEnvelope({ dialectKey: 'qwen', event: 'prompt-submit', payload: { session_id: 'q1', cwd: QWEN_DIR, prompt: 'fix it' } });
  assert.deepEqual([prompt.prompt, prompt.blocking], ['fix it', true]);
  const start = normalizeEnvelope({ dialectKey: 'qwen', event: 'session-start', payload: { session_id: 'q2', cwd: QWEN_DIR, source: 'startup', model: 'qwen3-coder' } });
  assert.deepEqual([start.session_id, start.model, start.blocking], ['q2', 'qwen3-coder', false]);
});

test('qwen scans its shell on the generic event and confines file tools there', () => {
  const env = (event, tool) => ({ event, harness: 'qwen', tool_name: tool });
  assert.equal(scansCommand(env('pre-tool-use', 'run_shell_command')), true);
  assert.equal(scansCommand(env('pre-command', 'run_shell_command')), true);
  assert.equal(scansCommand(env('pre-tool-use', 'write_file')), false);
  assert.deepEqual(confinementEvents('qwen'), ['pre-tool-use']);
});

// Qwen honours a JSON permissionDecision on PreToolUse only; exit 2 blocks a
// tool call, a prompt and a stop alike, so it is the one channel used.
test('qwen answers in exit codes, an ask on a blocking event closes, and the runner answers inside its timer', () => {
  for (const event of ['pre-tool-use', 'pre-command', 'pre-file-write', 'prompt-submit', 'agent-stop']) {
    assert.deepEqual(encodeDecision({ dialectKey: 'qwen', event, decision: 'deny', reason: 'no' }), { stdout: '', stderr: 'no', exitCode: 2 }, event);
    assert.equal(encodeDecision({ dialectKey: 'qwen', event, decision: 'ask', reason: 'r' }).exitCode, 2, event);
  }
  assert.equal(encodeDecision({ dialectKey: 'qwen', event: 'post-tool-use', decision: 'ask' }).exitCode, 0);
  assert.deepEqual(encodeDecision({ dialectKey: 'qwen', event: 'pre-tool-use', decision: 'allow' }), { stdout: '', stderr: '', exitCode: 0 });
  assert.deepEqual(JSON.parse(encodeContext({ dialectKey: 'qwen', event: 'session-start', contexts: ['arm'] }).stdout),
    { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'arm' } });
  // Qwen fails open on its own timeout, so the runner's budget stays under it.
  const row = DIALECTS.find((candidate) => candidate.key === 'qwen');
  assert.deepEqual([row.nativeFailMode, row.timeoutFailMode], ['open', 'open']);
  assert.ok(budgetMs('qwen', 'pre-tool-use', 120000) < 60000);
  assert.equal(hookCoverage(new Date('2026-10-11T00:00:00Z')).find((entry) => entry.key === 'qwen').covered, 8);
});
