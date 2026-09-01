import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pinnedSlug, resolveAgentSlug, territoryHarness } from '../resolve-agent.mjs';
import { organizationProfileToConfig } from '../organization-profile.mjs';

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

// Meta Muse's territory segment is the harness key (`.muse/worktrees/`), and
// its App slug follows the {account}-{harness}-agent pattern like every other
// harness, so no apps-map override is involved.
test('Meta Muse territory binds its App by the slug pattern', () => {
  const config = { prefix: 'qwts' };
  const worktree = repo('.muse/worktrees/agent-bot-identity/session', 'qwts-muse-agent');
  assert.equal(territoryHarness(worktree), 'muse');
  assert.equal(
    resolveAgentSlug({ env: { MUSE_AGENT: '1' }, cwd: worktree, config, worktree: true }),
    'qwts-muse-agent',
  );
  // Territory repairs a foreign launcher identity, same as every harness.
  assert.equal(
    resolveAgentSlug({ env: { CLAUDECODE: '1' }, cwd: worktree, config, worktree: true }),
    'qwts-muse-agent',
  );
});

test('every supported worktree territory owns conflicting pins', () => {
  for (const harness of ['claude', 'codex', 'cursor', 'muse', 'vscode']) {
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

test('retired profile identities fail closed for explicit, launcher, and pinned resolution', () => {
  const config = organizationProfileToConfig({
    schema_version: 1,
    organization: 'example-engineering',
    account_owner: 'example',
    minimum_runtime_interface_version: 1,
    defaults: { codex: 'example-codex-agent' },
    identities: [
      { slug: 'example-codex-agent', harness: 'codex', status: 'active' },
      { slug: 'example-old-codex-agent', harness: 'codex', status: 'retired' },
    ],
  });
  const pinned = repo('retired', 'example-old-codex-agent');
  for (const options of [
    { explicit: 'example-old-codex-agent', env: {} },
    { env: { GH_AGENT_APP: 'example-old-codex-agent' } },
    { env: {}, cwd: pinned },
  ]) {
    assert.throws(
      () => resolveAgentSlug({ cwd: root, config, ...options }),
      /selected App is retired/,
    );
  }
  assert.equal(resolveAgentSlug({ explicit: 'example-codex-agent', config }), 'example-codex-agent');
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
    ['../setup-worktree.mjs', '../mint-token.mjs', '../ensure-private-key.mjs', '../agent-identity.mjs'].map(async (path) => ({
      path,
      text: await import('node:fs').then((fs) =>
        fs.readFileSync(new URL(path, import.meta.url), 'utf8'),
      ),
    })),
  );
  for (const { path, text } of sources) {
    assert.match(text, /resolve-agent\.mjs/, `${path} resolves identity through the shared order`);
    assert.doesNotMatch(text, /detectHarness\(/, `${path} does not call detection directly`);
    // The shared policy from #20: every inferred resolution asks the territory
    // question. A call site is either explicit-exempt (worktree: !explicit) or
    // always inferred (worktree: true) — never a bare resolveAgentSlug().
    for (const call of text.match(/resolveAgentSlug\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
      assert.match(call, /worktree:/, `${path} passes worktree at every resolveAgentSlug call site`);
    }
  }
});

import { mkdirSync } from 'node:fs';

test('a Claude scratchpad is claude territory that repairs foreign launcher identity (#26)', () => {
  // Codex review on #27: without this, an inherited CODEX_*/GH_AGENT_APP
  // marker selected the foreign bot and outranked the scratchpad's own slug.
  const pad = join(root, 'claude-502/p/f3fe0864-f97d-4393-a9ef-8dac1cf89a27/scratchpad');
  mkdirSync(pad, { recursive: true });
  assert.equal(territoryHarness(pad), 'claude');
  // A foreign launcher identity cannot mint from Claude's scratchpad...
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-codex-agent' }, cwd: pad, config: cfg, worktree: true }),
    'you-claude-agent',
  );
  // ...an ambient foreign harness marker cannot either...
  assert.equal(
    resolveAgentSlug({ env: { CODEX_SANDBOX: '1' }, cwd: pad, config: cfg, worktree: true }),
    'you-claude-agent',
  );
  // ...while a claude-owned launcher identity (model-variant App) is honored.
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-claude-fable-agent' }, cwd: pad, config: cfg, worktree: true }),
    'you-claude-fable-agent',
  );
});

// ENG-0339: the account is the persona, so its input sits below the pin and
// above environment detection in the fallback layer.
test('an agent account outranks harness detection but not the pin', () => {
  const plain = repo('account-plain');
  assert.equal(
    resolveAgentSlug({ env: CLAUDE, cwd: plain, config: cfg, account: 'you-goose-agent' }),
    'you-goose-agent',
  );
  assert.equal(
    resolveAgentSlug({ env: {}, cwd: plain, config: cfg, account: 'you-goose-agent' }),
    'you-goose-agent',
  );
  const pinned = repo('account-pinned', 'you-claude-fable-agent');
  assert.equal(
    resolveAgentSlug({ env: {}, cwd: pinned, config: cfg, account: 'you-goose-agent' }),
    'you-claude-fable-agent',
  );
});

test('the owner account resolves through detection exactly as before', () => {
  const plain = repo('account-owner');
  assert.equal(
    resolveAgentSlug({ env: CLAUDE, cwd: plain, config: cfg, account: 'user' }),
    'you-claude-agent',
  );
  assert.equal(resolveAgentSlug({ env: {}, cwd: plain, config: cfg, account: 'user' }), null);
});
