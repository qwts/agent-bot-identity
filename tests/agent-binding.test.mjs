import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  bindTokenPath,
  consumeBindToken,
  createBindingRegistry,
  mintBindToken,
  readBindToken,
} from '../agent-binding.mjs';

const AGENT_ID = 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchGitDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-binding-'));
  roots.push(root);
  return { root, gitDir: root, worktree: path.join(root, 'worktree') };
}

test('mint writes a private single-use token bound to its worktree', () => {
  const { gitDir, worktree } = scratchGitDir();
  const record = mintBindToken({
    gitDir,
    worktree,
    agentId: AGENT_ID,
    now: () => new Date('2026-08-12T10:00:00.000Z'),
  });
  assert.match(record.token, /^[0-9a-f]{64}$/);
  assert.equal(record.agentId, AGENT_ID);
  assert.equal(record.worktree, worktree);
  assert.equal(record.mintedAt, '2026-08-12T10:00:00.000Z');
  const mode = statSync(bindTokenPath(gitDir)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(readBindToken(gitDir), record);
});

test('re-minting replaces the token — a fresh proof of place, same identity', () => {
  const { gitDir, worktree } = scratchGitDir();
  const first = mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
  const second = mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
  assert.notEqual(first.token, second.token);
  assert.equal(readBindToken(gitDir).token, second.token);
});

test('mint refuses relative paths and invalid Agent IDs', () => {
  const { gitDir } = scratchGitDir();
  assert.throws(
    () => mintBindToken({ gitDir: 'relative/.git', worktree: '/w', agentId: AGENT_ID }),
    /gitDir must be an absolute path/,
  );
  assert.throws(
    () => mintBindToken({ gitDir, worktree: 'relative', agentId: AGENT_ID }),
    /worktree must be an absolute path/,
  );
  assert.throws(
    () => mintBindToken({ gitDir, worktree: '/w', agentId: 'agent_nope' }),
    /invalid Agent ID/,
  );
});

test('readBindToken returns null when nothing is minted', () => {
  const { gitDir } = scratchGitDir();
  assert.equal(readBindToken(gitDir), null);
});

test('readBindToken refuses tampered files without reflecting their contents', () => {
  const { gitDir } = scratchGitDir();
  writeFileSync(bindTokenPath(gitDir), 'secret-looking garbage {\n', 'utf8');
  assert.throws(() => readBindToken(gitDir), (error) => {
    assert.equal(error.message, 'bind token file is not valid JSON');
    return true;
  });
  writeFileSync(bindTokenPath(gitDir), `${JSON.stringify({ schemaVersion: 1, token: 'short' })}\n`, 'utf8');
  assert.throws(() => readBindToken(gitDir), /unsupported shape/);
});

test('consume verifies the presented token against the file, then removes it', () => {
  const { gitDir, worktree } = scratchGitDir();
  const record = mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
  const consumed = consumeBindToken({ gitDir, token: record.token });
  assert.equal(consumed.agentId, AGENT_ID);
  assert.equal(consumed.worktree, worktree);
  assert.equal(existsSync(bindTokenPath(gitDir)), false);
});

test('a consumed token cannot be replayed — there is nothing left to present', () => {
  const { gitDir, worktree } = scratchGitDir();
  const record = mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
  consumeBindToken({ gitDir, token: record.token });
  assert.throws(
    () => consumeBindToken({ gitDir, token: record.token }),
    /no bind token is minted for this worktree/,
  );
});

test('a wrong token is refused and the minted token survives', () => {
  const { gitDir, worktree } = scratchGitDir();
  mintBindToken({ gitDir, worktree, agentId: AGENT_ID });
  assert.throws(
    () => consumeBindToken({ gitDir, token: 'f'.repeat(64) }),
    /does not match the minted token/,
  );
  assert.notEqual(readBindToken(gitDir), null);
});

test('a token lifted into another git dir proves nothing', () => {
  const first = scratchGitDir();
  const second = scratchGitDir();
  const record = mintBindToken({ gitDir: first.gitDir, worktree: first.worktree, agentId: AGENT_ID });
  // The thief presents the stolen token against a worktree that minted its
  // own: the file comparison fails.
  mintBindToken({ gitDir: second.gitDir, worktree: second.worktree, agentId: AGENT_ID });
  assert.throws(
    () => consumeBindToken({ gitDir: second.gitDir, token: record.token }),
    /does not match the minted token/,
  );
});

test('registry binds, resolves, and releases without ever exposing the map', () => {
  const registry = createBindingRegistry({ now: () => new Date('2026-08-12T11:00:00.000Z') });
  const secret = registry.bind({
    agentId: AGENT_ID,
    worktree: '/w',
    transcript: { provider: 'claude', id: 'session-1' },
    harness: 'claude',
  });
  assert.match(secret, /^[0-9a-f]{64}$/);
  const binding = registry.resolve(secret);
  assert.equal(binding.agentId, AGENT_ID);
  assert.equal(binding.transcript.id, 'session-1');
  assert.equal(binding.boundAt, '2026-08-12T11:00:00.000Z');
  assert.equal(registry.resolve('f'.repeat(64)), null);
  assert.equal(registry.resolve(undefined), null);
  assert.equal(registry.release(secret), true);
  assert.equal(registry.resolve(secret), null);
  assert.equal(registry.size(), 0);
});

test('registry refuses to grow without bound', () => {
  const registry = createBindingRegistry();
  for (let i = 0; i < 256; i++) {
    registry.bind({ agentId: AGENT_ID, worktree: '/w' });
  }
  assert.throws(
    () => registry.bind({ agentId: AGENT_ID, worktree: '/w' }),
    /too many live bindings/,
  );
});

test('abandoned bindings age out — the cap counts conversations, not history', () => {
  let clock = new Date('2026-08-12T08:00:00.000Z');
  const registry = createBindingRegistry({ now: () => clock });
  const secrets = [];
  for (let i = 0; i < 256; i++) {
    secrets.push(registry.bind({ agentId: AGENT_ID, worktree: '/w' }));
  }
  assert.throws(() => registry.bind({ agentId: AGENT_ID, worktree: '/w' }), /too many live bindings/);

  // A day later the abandoned bindings no longer hold the slots hostage…
  clock = new Date('2026-08-13T08:00:00.001Z');
  const fresh = registry.bind({ agentId: AGENT_ID, worktree: '/w' });
  assert.equal(registry.size(), 1);
  assert.equal(registry.resolve(fresh).agentId, AGENT_ID);
  // …and an expired secret no longer resolves.
  assert.equal(registry.resolve(secrets[0]), null);
});
