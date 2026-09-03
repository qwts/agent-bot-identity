import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { accountSlug, helperSlug, resolveSlug, worktreeSlug } from '../worktree-token.mjs';

const TOOL = fileURLToPath(new URL('../worktree-token.mjs', import.meta.url));
const cfg = { prefix: 'you' };

const root = mkdtempSync(join(tmpdir(), 'worktree-token-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('extracts the slug baked into the credential-helper line', () => {
  const helpers = '\n!node /Users/x/Code/agent-bot-identity/git-credential-bot.mjs qwts-codex-agent';
  assert.equal(helperSlug(helpers), 'qwts-codex-agent');
  assert.equal(helperSlug("!'/Users/x/.local/bin/agent-bot' credential qwts-codex-agent"), 'qwts-codex-agent');
});

test('the last bot helper line wins when several exist', () => {
  const helpers = '!node /x/git-credential-bot.mjs you-claude-agent\n!node /x/git-credential-bot.mjs you-codex-agent';
  assert.equal(helperSlug(helpers), 'you-codex-agent');
});

test('no helper means no helper signal', () => {
  assert.equal(helperSlug(''), null);
  assert.equal(helperSlug('osxkeychain\n!gh auth git-credential'), null);
  assert.equal(worktreeSlug('', null), null);
});

test('a pinned identity outranks the helper line', () => {
  const helpers = '!node /x/git-credential-bot.mjs qwts-codex-agent';
  assert.equal(worktreeSlug(helpers, 'you-claude-agent'), 'you-claude-agent');
});

// ENG-0339: the pin is an explicit override, so it counts on its own — with
// or without the helper line, wherever the checkout sits.
test('a pin alone is a stated bot identity', () => {
  assert.equal(worktreeSlug('', 'you-claude-agent'), 'you-claude-agent');
  assert.equal(worktreeSlug('osxkeychain', 'you-claude-agent'), 'you-claude-agent');
});

test('resolution order: the shared resolver, then the pin, then the helper line', () => {
  const helpers = '!node /x/git-credential-bot.mjs you-codex-agent';
  assert.equal(resolveSlug({ selected: 'you-cursor-agent', pinned: 'you-claude-agent', helperLines: helpers }), 'you-cursor-agent');
  assert.equal(resolveSlug({ pinned: 'you-claude-agent', helperLines: helpers }), 'you-claude-agent');
  assert.equal(resolveSlug({ helperLines: helpers }), 'you-codex-agent');
  assert.equal(resolveSlug({}), null);
});

// Shell and JS must agree on what an agent account is: the exact roster slug,
// not a `*-*-agent` glob.
test('accountSlug classifies the account by exact roster match', () => {
  assert.equal(accountSlug({ AGENT_BOT_ACCOUNT: 'you-goose-agent' }, cfg), 'you-goose-agent');
  assert.equal(accountSlug({ AGENT_BOT_ACCOUNT: 'user' }, cfg), null);
  assert.equal(accountSlug({ AGENT_BOT_ACCOUNT: 'you-mystery-agent' }, cfg), null);
  assert.equal(accountSlug({ AGENT_BOT_ACCOUNT: 'special-bot' }, { apps: { warp: 'special-bot' } }), 'special-bot');
  assert.equal(accountSlug({ AGENT_BOT_ACCOUNT: 'you-goose-agent' }, {}), null, 'inert without config');
});

function checkout(name, { pin = null, layout = '' } = {}) {
  const dir = join(root, layout, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--quiet', dir]);
  if (pin) execFileSync('git', ['config', 'agentBot.app', pin], { cwd: dir });
  return dir;
}

function run(mode, cwd, extra = {}) {
  const globalConfig = join(root, 'empty.gitconfig');
  writeFileSync(globalConfig, '');
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(cfg));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CODEX|CLAUDE|AI_AGENT|CURSOR|COPILOT|DEVIN|WINDSURF|MUSE|GH_AGENT_APP|AGENT_BOT_)/.test(key)) delete env[key];
  }
  return execFileSync(process.execPath, [TOOL, mode], {
    cwd,
    encoding: 'utf8',
    env: {
      ...env,
      HOME: root,
      AGENT_BOT_CONFIG: configPath,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: '/dev/null',
      ...extra,
    },
  }).trim();
}

// Acceptance (ENG-0339): the account is the fallback input, and it reaches
// the token tool — so a PRIMARY checkout in an agent account resolves.
test('--slug resolves a primary checkout in an agent account with no pin', () => {
  const primary = checkout('account-primary');
  assert.equal(run('--slug', primary, { AGENT_BOT_ACCOUNT: 'you-codex-agent' }), 'you-codex-agent');
  assert.equal(run('--account-slug', primary, { AGENT_BOT_ACCOUNT: 'you-codex-agent' }), 'you-codex-agent');
});

test('--slug is empty for an unpinned checkout in the owner account, even under a harness', () => {
  const primary = checkout('owner-primary');
  assert.equal(run('--slug', primary, { AGENT_BOT_ACCOUNT: 'user', CLAUDECODE: '1' }), '');
  assert.equal(run('--account-slug', primary, { AGENT_BOT_ACCOUNT: 'user' }), '');
  const linked = checkout('owner-layout', { layout: '.codex/worktrees/session' });
  assert.equal(run('--slug', linked, { AGENT_BOT_ACCOUNT: 'user' }), '', 'the directory is not a signal');
});

test('GH_AGENT_APP and the pin are stated identities in any checkout', () => {
  const primary = checkout('launcher-primary');
  assert.equal(run('--slug', primary, { AGENT_BOT_ACCOUNT: 'user', GH_AGENT_APP: 'you-claude-agent' }), 'you-claude-agent');
  const pinned = checkout('pinned-primary', { pin: 'you-claude-fable-agent' });
  assert.equal(run('--slug', pinned, { AGENT_BOT_ACCOUNT: 'user' }), 'you-claude-fable-agent');
  assert.equal(
    run('--slug', pinned, { AGENT_BOT_ACCOUNT: 'you-codex-agent' }),
    'you-claude-fable-agent',
    'the pin outranks the account',
  );
  assert.equal(
    run('--slug', pinned, { AGENT_BOT_ACCOUNT: 'you-codex-agent', GH_AGENT_APP: 'you-cursor-agent' }),
    'you-cursor-agent',
    'GH_AGENT_APP outranks the pin and the account',
  );
});

test('--agent-slug reports the agent process, which is not the same question', () => {
  const primary = checkout('agent-process');
  assert.equal(run('--agent-slug', primary, { AGENT_BOT_ACCOUNT: 'user', CLAUDECODE: '1' }), 'you-claude-agent');
  assert.equal(run('--agent-slug', primary, { AGENT_BOT_ACCOUNT: 'user' }), '');
});
