import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentBotArgs } from '../cli/parse.mjs';
import { helpText } from '../cli/output.mjs';
import { bindingStatusLines } from '../setup-worktree.mjs';
import { findTranscript, parseSessionBindArgs, sessionBind } from '../session-bind.mjs';

test('session bind is a public CLI command with help text', () => {
  assert.deepEqual(parseAgentBotArgs(['session', 'bind']).command, 'session');
  assert.match(helpText(), /session +Bind this worktree/);
});

test('setup output names worktree and live session binding separately', () => {
  const live = 'live session binding: not established by setup-worktree — run `agent-bot session bind` (add --transcript-id <session-id> where the harness exposes none) or MCP bind';
  assert.deepEqual(bindingStatusLines({ worktreeBindingPresent: false }), [
    'worktree binding: bind token minted (not a live session binding)',
    live,
  ]);
  assert.deepEqual(bindingStatusLines({ worktreeBindingPresent: true }), ['worktree binding: present', live]);
});

test('session bind parses its bounded arguments', () => {
  assert.deepEqual(parseSessionBindArgs(['bind', '--transcript-id', 's1', '--provider', 'codex', '--json']), {
    help: false, json: true, transcriptId: 's1', provider: 'codex', parentAgentId: null,
  });
  assert.throws(() => parseSessionBindArgs(['bind', '--wat']), /unknown option/);
  assert.throws(() => parseSessionBindArgs(['status']), /usage: agent-bot session bind/);
});

test('session bind validates an existing binding without exposing its secret', async () => {
  const secret = 'a'.repeat(43);
  const result = await sessionBind({
    cwd: '/worktree', env: {},
    readBindingImpl: () => ({ agentId: 'agent_11111111-1111-4111-8111-111111111111', secret }),
    clientFactory: async () => ({
      binding: async (presented) => {
        assert.equal(presented, secret);
        return { agentId: 'agent_11111111-1111-4111-8111-111111111111', worktree: '/worktree' };
      },
    }),
  });
  assert.equal(result.status, 'live');
  assert.equal(result.alreadyBound, true);
  assert.doesNotMatch(JSON.stringify(result), /a{20,}/);
});

test('session bind surrenders the minted token and never returns the new secret', async () => {
  const secret = 'b'.repeat(43);
  let request;
  const result = await sessionBind({
    cwd: '/worktree', env: {}, transcriptId: 'session-1', provider: 'custom',
    gitDirImpl: () => '/worktree/.git/worktrees/x',
    readBindingImpl: () => null,
    readBindTokenImpl: (gitDir) => {
      assert.equal(gitDir, '/worktree/.git/worktrees/x');
      return { token: 'f'.repeat(64) };
    },
    resolveSlugImpl: () => null,
    clientFactory: async () => ({
      bind: async (body) => {
        request = body;
        return { agentId: 'agent_11111111-1111-4111-8111-111111111111', worktree: '/worktree', secret };
      },
    }),
  });
  assert.equal(request.token, 'f'.repeat(64));
  assert.deepEqual(request.transcript, { provider: 'custom', id: 'session-1' });
  assert.equal(result.status, 'live');
  assert.doesNotMatch(JSON.stringify(result), /b{20,}/);
});

test('session bind refuses without a transcript when no binding exists', async () => {
  await assert.rejects(
    sessionBind({ cwd: '/worktree', env: {}, readBindingImpl: () => null }),
    /--transcript-id is required: no session id was found.*QWEN_CODE_SESSION_ID.*devin list --format json/,
  );
});

// #1275: a new session binds with no flag where the harness names itself.
test('findTranscript reads the harness environment, then the hook payload, then one listed Devin session', async () => {
  const noList = () => assert.fail('no session list when an id is in view');
  assert.deepEqual(await findTranscript({ env: { QWEN_CODE_SESSION_ID: 'q-1' }, listDevinSessionsImpl: noList }), { provider: 'qwen', id: 'q-1' });
  assert.deepEqual(await findTranscript({ env: { CLAUDE_SESSION_ID: 'c-1', AGENT_HOOK_SESSION_ID: 'h-1' }, listDevinSessionsImpl: noList }), { provider: 'claude', id: 'c-1' });
  // A hook payload's id names the session; the harness marker names the provider.
  assert.deepEqual(await findTranscript({ env: { AGENT_HOOK_SESSION_ID: 'h-1', AGENT_HOOK_HARNESS: 'claude', AI_AGENT: 'devin_1_agent' }, listDevinSessionsImpl: noList }), { provider: 'devin', id: 'h-1' });
  assert.deepEqual(await findTranscript({ env: { AGENT_HOOK_SESSION_ID: 'h-2', AGENT_HOOK_HARNESS: 'qwen' }, listDevinSessionsImpl: noList }), { provider: 'qwen', id: 'h-2' });
  const devin = { AI_AGENT: 'devin_1_agent' };
  let listedIn = null;
  assert.deepEqual(await findTranscript({ env: devin, cwd: '/wt', listDevinSessionsImpl: async (cwd) => { listedIn = cwd; return ['shine-cotton']; } }), { provider: 'devin', id: 'shine-cotton' });
  assert.equal(listedIn, '/wt');
  // Two sessions in the worktree, none, or a failed list: ambiguous, nothing found.
  for (const listed of [['a', 'b'], [], null]) {
    assert.equal(await findTranscript({ env: devin, listDevinSessionsImpl: async () => listed }), null);
  }
  assert.equal(await findTranscript({ env: {}, listDevinSessionsImpl: noList }), null);
});

test('session bind with no flag binds the discovered session, and --provider still overrides', async () => {
  const requests = [];
  const bindWith = (overrides) => sessionBind({
    cwd: '/worktree', env: { QWEN_CODE_SESSION_ID: 'q-1' },
    gitDirImpl: () => '/worktree/.git/worktrees/x',
    readBindingImpl: () => null,
    readBindTokenImpl: () => ({ token: 'f'.repeat(64) }),
    resolveSlugImpl: () => null,
    clientFactory: async () => ({
      bind: async (body) => { requests.push(body.transcript); return { agentId: 'agent_11111111-1111-4111-8111-111111111111', secret: 'e'.repeat(43) }; },
    }),
    ...overrides,
  });
  await bindWith({});
  await bindWith({ provider: 'qwen-desktop' });
  assert.deepEqual(requests, [{ provider: 'qwen', id: 'q-1' }, { provider: 'qwen-desktop', id: 'q-1' }]);
});

test('session bind reconciles a differently selected App on an existing binding, like MCP bind', async () => {
  const secret = 'c'.repeat(43);
  const repins = [];
  let reconciledWith;
  const result = await sessionBind({
    cwd: '/worktree', env: {},
    readBindingImpl: () => ({ agentId: 'agent_11111111-1111-4111-8111-111111111111', secret }),
    resolveSlugImpl: () => 'qwts-other-agent',
    repinImpl: (cwd, key, value) => repins.push([cwd, key, value]),
    clientFactory: async () => ({
      binding: async () => ({ agentId: 'agent_11111111-1111-4111-8111-111111111111', worktree: '/worktree' }),
      reconcileApp: async (presented, app) => {
        assert.equal(presented, secret);
        reconciledWith = app;
        return { app: { status: 'reconciled', claimed: 'qwts-other-agent' } };
      },
    }),
  });
  assert.equal(reconciledWith, 'qwts-other-agent');
  assert.equal(result.alreadyBound, true);
  assert.equal(result.app.status, 'reconciled');
  assert.match(result.app.next, /setup-worktree/);
  assert.deepEqual(repins, [['/worktree', 'agentBot.app', 'qwts-other-agent']]);
  assert.doesNotMatch(JSON.stringify(result), /c{20,}/);
});

test('session bind on an existing binding survives a failed reconcile (record unchanged)', async () => {
  const result = await sessionBind({
    cwd: '/worktree', env: {},
    readBindingImpl: () => ({ agentId: 'agent_11111111-1111-4111-8111-111111111111', secret: 'd'.repeat(43) }),
    resolveSlugImpl: () => 'qwts-other-agent',
    repinImpl: () => assert.fail('no repin without reconciliation'),
    clientFactory: async () => ({
      binding: async () => ({ agentId: 'agent_11111111-1111-4111-8111-111111111111', worktree: '/worktree' }),
      reconcileApp: async () => { throw new Error('daemon busy'); },
    }),
  });
  assert.equal(result.status, 'live');
  assert.equal(result.app, undefined);
});
