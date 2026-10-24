import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentBotArgs } from '../cli/parse.mjs';
import { helpText } from '../cli/output.mjs';
import { bindingStatusLines } from '../setup-worktree.mjs';
import { parseSessionBindArgs, sessionBind } from '../session-bind.mjs';

test('session bind is a public CLI command with help text', () => {
  assert.deepEqual(parseAgentBotArgs(['session', 'bind']).command, 'session');
  assert.match(helpText(), /session +Bind this worktree/);
});

test('setup output names worktree and live session binding separately', () => {
  assert.deepEqual(bindingStatusLines({ worktreeBindingPresent: false }), [
    'worktree binding: bind token minted (not a live session binding)',
    'live session binding: not established by setup-worktree — run `agent-bot session bind --transcript-id <session-id>` or MCP bind',
  ]);
  assert.deepEqual(bindingStatusLines({ worktreeBindingPresent: true }), [
    'worktree binding: present',
    'live session binding: not established by setup-worktree — run `agent-bot session bind --transcript-id <session-id>` or MCP bind',
  ]);
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
    /--transcript-id is required/,
  );
});
