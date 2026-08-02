import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pinnedSlug, resolveAgentSlug, territoryHarness } from '../resolve-agent.mjs';

const root = mkdtempSync(join(tmpdir(), 'resolve-agent-'));
after(() => rmSync(root, { recursive: true, force: true }));

const cfg = { prefix: 'you' };

function repo(name, pin) {
  const dir = join(root, name);
  execFileSync('git', ['init', '--quiet', dir]);
  if (pin) execFileSync('git', ['config', 'agentBot.app', pin], { cwd: dir });
  return dir;
}

const CLAUDE = { CLAUDECODE: '1' };

test('the pin refines what detection resolved', () => {
  const pinned = repo('pinned', 'you-claude-fable-agent');
  assert.equal(pinnedSlug(pinned), 'you-claude-fable-agent');
  assert.equal(resolveAgentSlug({ env: CLAUDE, cwd: pinned, config: cfg }), 'you-claude-fable-agent');
});

test('worktree territory repairs conflicting launcher and pin identities', () => {
  const worktree = repo('.codex/worktrees/session/repo', 'you-claude-agent');
  assert.equal(territoryHarness(worktree), 'codex');
  for (const env of [
    { CLAUDECODE: '1' },
    { GH_AGENT_APP: 'you-claude-agent' },
    { CLAUDECODE: '1', GH_AGENT_APP: 'you-claude-agent' },
  ]) {
    assert.equal(resolveAgentSlug({ env, cwd: worktree, config: cfg, worktree: true }), 'you-codex-agent');
  }
});

test('every supported worktree territory owns conflicting pins', () => {
  for (const harness of ['claude', 'codex', 'cursor', 'vscode']) {
    const worktree = repo(`.${harness}/worktrees/owner/repo`, 'you-claude-agent');
    assert.equal(resolveAgentSlug({ env: { GH_AGENT_APP: 'you-claude-agent' }, cwd: worktree, config: cfg, worktree: true }), `you-${harness}-agent`);
  }
});

test('worktree territory preserves a same-harness model pin and rejects cross-harness explicit Apps', () => {
  const worktree = repo('.codex/worktrees/model/repo', 'you-codex-sol-agent');
  assert.equal(resolveAgentSlug({ env: {}, cwd: worktree, config: cfg, worktree: true }), 'you-codex-sol-agent');
  assert.throws(
    () => resolveAgentSlug({ explicit: 'you-claude-agent', cwd: worktree, config: cfg, worktree: true }),
    /conflicts with codex worktree territory/,
  );
  assert.throws(
    () => resolveAgentSlug({ explicit: 'custom-agent', cwd: worktree, config: cfg, worktree: true }),
    /conflicts with codex worktree territory/,
  );
});

test('Claude territory accepts Claude Apps and favors a compatible launcher over a pin', () => {
  const worktree = repo('.claude/worktrees/model/repo', 'you-claude-fable-agent');
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-claude-opus-agent' }, cwd: worktree, config: cfg, worktree: true }),
    'you-claude-opus-agent',
  );
  assert.equal(
    resolveAgentSlug({ explicit: 'you-claude-sonnet-agent', cwd: worktree, config: cfg, worktree: true }),
    'you-claude-sonnet-agent',
  );
});

test('worktree territory respects a custom configured App mapping', () => {
  const worktree = repo('.codex/worktrees/custom/repo', 'you-claude-agent');
  assert.equal(
    resolveAgentSlug({ env: { CLAUDECODE: '1' }, cwd: worktree, config: { apps: { codex: 'special-bot' } }, worktree: true }),
    'special-bot',
  );
});

test('detection stands when nothing is pinned', () => {
  const plain = repo('plain');
  assert.equal(pinnedSlug(plain), null);
  assert.equal(resolveAgentSlug({ env: CLAUDE, cwd: plain, config: cfg }), 'you-claude-agent');
});

test('an explicit slug outranks the environment, which outranks the pin', () => {
  const pinned = repo('order', 'you-claude-fable-agent');
  assert.equal(
    resolveAgentSlug({
      explicit: 'you-cursor-agent',
      env: { ...CLAUDE, GH_AGENT_APP: 'you-codex-agent' },
      cwd: pinned,
      config: cfg,
    }),
    'you-cursor-agent',
  );
  assert.equal(
    resolveAgentSlug({
      env: { ...CLAUDE, GH_AGENT_APP: 'you-codex-agent' },
      cwd: pinned,
      config: cfg,
    }),
    'you-codex-agent',
  );
});

test('a directory that is not a repository resolves quietly rather than throwing', () => {
  assert.equal(pinnedSlug(root), null);
  assert.equal(
    resolveAgentSlug({ env: {}, cwd: root, config: cfg }),
    null,
    'no harness, no pin, no identity — not an error',
  );
});

test('an unreadable pin fails closed instead of falling through to the harness', () => {
  // A config git cannot parse means the pin could not be checked. Falling back
  // would mint for the harness while the worktree commits as whichever agent
  // someone pinned — the split identity this resolver exists to prevent.
  const broken = repo('broken');
  appendFileSync(join(broken, '.git', 'config'), '\n[agentBot\napp = you-claude-fable-agent\n');
  assert.throws(() => pinnedSlug(broken), /agentBot\.app/);
  assert.throws(
    () => resolveAgentSlug({ env: CLAUDE, cwd: broken, config: cfg }),
    /unverifiable pin is not an absent one/,
  );
});

test('an explicit slug or environment still wins without consulting git at all', () => {
  const broken = join(root, 'broken');
  assert.equal(
    resolveAgentSlug({ explicit: 'you-cursor-agent', env: CLAUDE, cwd: broken, config: cfg }),
    'you-cursor-agent',
  );
  assert.equal(
    resolveAgentSlug({
      env: { ...CLAUDE, GH_AGENT_APP: 'you-codex-agent' },
      cwd: broken,
      config: cfg,
    }),
    'you-codex-agent',
    'a launcher that states the identity outright never needs the pin read to succeed',
  );
});

test('scope precedence is git\'s, not ours: the worktree pin outranks a global default', () => {
  // Two values across scopes is normal, not ambiguous — `git config --get`
  // resolves it the way every other git consumer does, and this resolver must
  // not invent a second opinion about precedence.
  const scoped = repo('scoped');
  execFileSync('git', ['config', '--local', 'agentBot.app', 'you-claude-agent'], { cwd: scoped });
  execFileSync('git', ['config', '--add', '--local', 'agentBot.app', 'you-claude-fable-agent'], {
    cwd: scoped,
  });
  assert.equal(pinnedSlug(scoped), 'you-claude-fable-agent', 'the most specific value wins, as git says');
});

test('a directory that does not exist is the caller\'s bug, not a missing pin', () => {
  assert.throws(() => pinnedSlug(join(root, 'no-such-dir')), /directory that does not exist/);
});

test('every consumer that mints or commits shares this resolver', async () => {
  // The bug this file exists to prevent: a pinned worktree that commits as its
  // pinned agent and opens its PR as the harness, because the minters resolved
  // identity their own way. Import-level check, so a future consumer that
  // rolls its own chain shows up here rather than in production attribution.
  const sources = await Promise.all(
    ['../setup-worktree.mjs', '../mint-token.mjs'].map(async (path) => ({
      path,
      text: await import('node:fs').then((fs) =>
        fs.readFileSync(new URL(path, import.meta.url), 'utf8'),
      ),
    })),
  );
  for (const { path, text } of sources) {
    assert.match(text, /resolve-agent\.mjs/, `${path} resolves identity through the shared order`);
    assert.doesNotMatch(text, /detectHarness\(/, `${path} does not call detection directly`);
  }
});
