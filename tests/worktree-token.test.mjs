import { test } from 'node:test';
import assert from 'node:assert/strict';

import { worktreeSlug, pathSlug, resolveSlug, configuredRootSlug } from '../worktree-token.mjs';

const cfg = { prefix: 'you' };

test('extracts the slug baked into the credential-helper line', () => {
  const helpers = '\n!node /Users/x/Code/agent-bot-identity/git-credential-bot.mjs qwts-codex-agent';
  assert.equal(worktreeSlug(helpers, null), 'qwts-codex-agent');
});

test('a pinned identity outranks the helper line', () => {
  const helpers = '!node /x/git-credential-bot.mjs qwts-codex-agent';
  assert.equal(worktreeSlug(helpers, 'you-claude-agent'), 'you-claude-agent');
});

test('no helper means human context', () => {
  assert.equal(worktreeSlug('', null), null);
  assert.equal(worktreeSlug('osxkeychain\n!gh auth git-credential', null), null);
});

test('a pin without the helper marker never makes bot territory', () => {
  // A stray agentBot.app in a human clone must not cause a mint.
  assert.equal(worktreeSlug('', 'you-claude-agent'), null);
  assert.equal(worktreeSlug('osxkeychain', 'you-claude-agent'), null);
});

test('the directory dictates the App even with no config at all (ENG-0045 d1)', () => {
  // Sandboxed harnesses may never manage to write the worktree config —
  // the path alone must resolve the bot.
  const HOME = '/Users/u';
  assert.equal(pathSlug(`${HOME}/.codex/worktrees/5243/test-repo`, cfg), 'you-codex-agent');
  assert.equal(pathSlug(`${HOME}/.claude/worktrees/agent-bot-identity/x`, cfg), 'you-claude-agent');
  assert.equal(pathSlug(`${HOME}/.cursor/worktrees/a/b`, cfg), 'you-cursor-agent');
  assert.equal(pathSlug(`${HOME}/.vscode/worktrees/a/b`, cfg), 'you-vscode-agent');
});

test('territory is the .<tool>/worktrees segment, at any root (ENG-0045 d1)', () => {
  // A boot volume too small for agent worktrees relocates them to an external
  // drive. That is a fact about the hardware; the work is still the bot's.
  // Anchoring the rule to $HOME demoted every worktree on such a machine to
  // human territory, where the shim refused to run and the agent fell back to
  // the human's credentials — the exact outcome ENG-0045 exists to prevent.
  assert.equal(pathSlug('/Volumes/added_storage/Code/.claude/worktrees/overlook/x', cfg), 'you-claude-agent');
  assert.equal(pathSlug('/Volumes/big/.codex/worktrees/1/r', cfg), 'you-codex-agent');
  assert.equal(pathSlug('/srv/agents/.vscode/worktrees/a/b', cfg), 'you-vscode-agent');
});

test('paths outside .<tool>/worktrees are never territory', () => {
  const HOME = '/Users/u';
  assert.equal(pathSlug(`${HOME}/Code/test-repo`, cfg), null); // primary checkout
  assert.equal(pathSlug(`${HOME}/.config/agent-bot`, cfg), null); // dotdir, not worktrees
  assert.equal(pathSlug(`${HOME}/.unknowntool/worktrees/x/r`, cfg), null); // no matching App
  assert.equal(pathSlug('/tmp/worktrees/x', cfg), null); // no dot-tool segment
  assert.equal(pathSlug('/Volumes/d/claude/worktrees/x/r', cfg), null); // undotted, not a tool dir
  assert.equal(pathSlug('/Volumes/d/.claude/worktrees', cfg), null); // the container, not a worktree
  assert.equal(pathSlug(null, cfg), null);
});

test('a configured relocation root is territory even without the segment', () => {
  // AGENT_WORKTREE_ROOT and the desktop preference accept any directory, and
  // both creators then build <root>/<repo>/<name>. Those worktrees are Claude's
  // by configuration though the path never says so — and the path rule exists
  // precisely for when setup-worktree could not persist the helper line.
  const HOME = '/Users/u';
  assert.equal(configuredRootSlug('/override/test-repo/name', '/override', HOME, cfg), 'you-claude-agent');
  assert.equal(configuredRootSlug('/wt', '/wt', HOME, cfg), 'you-claude-agent'); // the root itself
  assert.equal(configuredRootSlug('/overridefoo/r/n', '/override', HOME, cfg), null); // prefix, not a path boundary
  assert.equal(configuredRootSlug(`${HOME}/Code/r`, '/override', HOME, cfg), null);
  // A root that broad is a misconfiguration, never a claim on human clones.
  assert.equal(configuredRootSlug(`${HOME}/Code/r`, HOME, HOME, cfg), null);
  assert.equal(configuredRootSlug('/anything/at/all', '/', HOME, cfg), null);
  assert.equal(configuredRootSlug('/override/r/n', null, HOME, cfg), null);
});

test('resolution order: pin picks WHICH bot, only inside territory', () => {
  const HOME = '/Users/u';
  const inTerritory = { toplevel: `${HOME}/.codex/worktrees/1/r`, helperLines: '', config: cfg };
  assert.equal(resolveSlug({ ...inTerritory, pinned: null }), 'you-codex-agent');
  assert.equal(resolveSlug({ ...inTerritory, pinned: 'you-claude-agent' }), 'you-claude-agent');
  // pin + no territory signal = human, still
  assert.equal(
    resolveSlug({
      pinned: 'you-claude-agent',
      toplevel: `${HOME}/Code/r`,
      helperLines: '',
      config: cfg,
    }),
    null,
  );
  // helper line still marks configured worktrees outside the path pattern
  assert.equal(
    resolveSlug({
      pinned: null,
      toplevel: `${HOME}/somewhere/r`,
      helperLines: '!node /x/git-credential-bot.mjs qwts-vscode-agent',
      config: cfg,
    }),
    'qwts-vscode-agent',
  );
});

test('the last bot helper line wins when several exist', () => {
  const helpers = '!node /a/git-credential-bot.mjs old-slug\n!node /b/git-credential-bot.mjs new-slug';
  assert.equal(worktreeSlug(helpers, null), 'new-slug');
});
