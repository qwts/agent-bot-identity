import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
// The owner's own account: no roster slug, so the account contributes nothing.
const OWNER = 'user';

test('the pin refines what detection resolved', () => {
  const pinned = repo('pinned', 'you-claude-fable-agent');
  assert.equal(pinnedSlug(pinned), 'you-claude-fable-agent');
  assert.equal(resolveAgentSlug({ env: CLAUDE, cwd: pinned, config: cfg, account: OWNER }), 'you-claude-fable-agent');
});

// ENG-0339 supersedes ENG-0045: the directory a checkout sits in is layout,
// not an identity input. A `.codex/worktrees` path neither repairs nor vetoes
// a pin, a launcher identity, or an explicit App.
test('the worktree directory is layout only: pin and launcher identity stand in any layout', () => {
  const worktree = repo('.codex/worktrees/session/repo', 'you-claude-agent');
  assert.equal(territoryHarness(worktree), 'codex', 'the layout is still readable as advice');
  assert.equal(resolveAgentSlug({ env: CLAUDE, cwd: worktree, config: cfg, account: OWNER }), 'you-claude-agent');
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-claude-agent' }, cwd: worktree, config: cfg, account: OWNER }),
    'you-claude-agent',
  );
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-cursor-agent' }, cwd: worktree, config: cfg, account: OWNER }),
    'you-cursor-agent',
    'GH_AGENT_APP outranks the pin, and the directory has no say',
  );
});

test('an explicit App never throws on a directory mismatch', () => {
  const worktree = repo('.codex/worktrees/model/repo', 'you-codex-sol-agent');
  assert.equal(resolveAgentSlug({ env: {}, cwd: worktree, config: cfg, account: OWNER }), 'you-codex-sol-agent');
  assert.equal(resolveAgentSlug({ explicit: 'you-claude-agent', cwd: worktree, config: cfg }), 'you-claude-agent');
  assert.equal(resolveAgentSlug({ explicit: 'custom-agent', cwd: worktree, config: cfg }), 'custom-agent');
  for (const harness of ['claude', 'codex', 'cursor', 'muse', 'vscode', 'goose']) {
    const layout = repo(`.${harness}/worktrees/owner/repo`, 'you-claude-agent');
    assert.equal(
      resolveAgentSlug({ explicit: 'you-cursor-agent', env: { GH_AGENT_APP: 'you-codex-agent' }, cwd: layout, config: cfg }),
      'you-cursor-agent',
      `--app is taken at face value under .${harness}/worktrees`,
    );
  }
});

// Meta Muse's App slug follows the {account}-{harness}-agent pattern like
// every other harness, so no apps-map override is involved.
test('a Muse pin and a Muse account both bind the Muse App by the slug pattern', () => {
  const config = { prefix: 'qwts' };
  const worktree = repo('.muse/worktrees/agent-bot-identity/session', 'qwts-muse-agent');
  assert.equal(territoryHarness(worktree), 'muse');
  assert.equal(
    resolveAgentSlug({ env: { MUSE_AGENT: '1' }, cwd: worktree, config, account: OWNER }),
    'qwts-muse-agent',
  );
  const plain = repo('muse-account');
  assert.equal(
    resolveAgentSlug({ env: { CLAUDECODE: '1' }, cwd: plain, config, account: 'qwts-muse-agent' }),
    'qwts-muse-agent',
    'the account outranks a foreign harness marker',
  );
});

test('Claude launcher identities and explicit model Apps are honored as stated', () => {
  const worktree = repo('.claude/worktrees/model/repo', 'you-claude-fable-agent');
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-claude-opus-agent' }, cwd: worktree, config: cfg, account: OWNER }),
    'you-claude-opus-agent',
  );
  assert.equal(
    resolveAgentSlug({ explicit: 'you-claude-sonnet-agent', cwd: worktree, config: cfg }),
    'you-claude-sonnet-agent',
  );
});

test('a custom configured App mapping names the account and the harness alike', () => {
  const config = { apps: { codex: 'special-bot' } };
  const pinned = repo('.codex/worktrees/custom/repo', 'you-claude-agent');
  assert.equal(
    resolveAgentSlug({ env: { CLAUDECODE: '1' }, cwd: pinned, config, account: OWNER }),
    'you-claude-agent',
    'the pin still outranks detection',
  );
  const plain = repo('custom-account');
  assert.equal(
    resolveAgentSlug({ env: {}, cwd: plain, config, account: 'special-bot' }),
    'special-bot',
    'an account named by the apps map is that App, exactly as the roster says',
  );
  assert.equal(
    resolveAgentSlug({ env: { CODEX_SANDBOX: 'seatbelt' }, cwd: plain, config, account: OWNER }),
    'special-bot',
  );
});

test('detection stands when nothing is pinned', () => {
  const plain = repo('plain');
  assert.equal(pinnedSlug(plain), null);
  assert.equal(resolveAgentSlug({ env: CLAUDE, cwd: plain, config: cfg, account: OWNER }), 'you-claude-agent');
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
      () => resolveAgentSlug({ cwd: root, config, account: OWNER, ...options }),
      /selected App is retired/,
    );
  }
  assert.equal(resolveAgentSlug({ explicit: 'example-codex-agent', config }), 'example-codex-agent');
});

test('a directory that is not a repository resolves quietly rather than throwing', () => {
  assert.equal(pinnedSlug(root), null);
  assert.equal(
    resolveAgentSlug({ env: {}, cwd: root, config: cfg, account: OWNER }),
    null,
    'no harness, no pin, no account — not an error',
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
    () => resolveAgentSlug({ env: CLAUDE, cwd: broken, config: cfg, account: OWNER }),
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
    ['../setup-worktree.mjs', '../mint-token.mjs', '../ensure-private-key.mjs', '../agent-identity.mjs', '../worktree-token.mjs', '../signed-commit.mjs', '../agent-space-pack.mjs'].map(async (path) => ({
      path,
      text: await import('node:fs').then((fs) =>
        fs.readFileSync(new URL(path, import.meta.url), 'utf8'),
      ),
    })),
  );
  for (const { path, text } of sources) {
    assert.match(text, /resolve-agent\.mjs/, `${path} resolves identity through the shared order`);
    assert.doesNotMatch(text, /detectHarness\(/, `${path} does not call detection directly`);
    // ENG-0339: there is no directory question left to ask. A call site that
    // still passed the retired `worktree:` flag would be asking it.
    for (const call of text.match(/resolveAgentSlug\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
      assert.doesNotMatch(call, /worktree:/, `${path} no longer consults the directory`);
    }
  }
});

test('a session scratchpad is an ordinary directory: launcher and marker identities stand (#26 retired)', () => {
  const pad = join(root, 'claude-502/p/f3fe0864-f97d-4393-a9ef-8dac1cf89a27/scratchpad');
  mkdirSync(pad, { recursive: true });
  assert.equal(territoryHarness(pad), null);
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-codex-agent' }, cwd: pad, config: cfg, account: OWNER }),
    'you-codex-agent',
  );
  assert.equal(
    resolveAgentSlug({ env: { CODEX_SANDBOX: '1' }, cwd: pad, config: cfg, account: OWNER }),
    'you-codex-agent',
  );
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-claude-fable-agent' }, cwd: pad, config: cfg, account: OWNER }),
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
    resolveAgentSlug({ env: CLAUDE, cwd: plain, config: cfg, account: OWNER }),
    'you-claude-agent',
  );
  assert.equal(resolveAgentSlug({ env: {}, cwd: plain, config: cfg, account: OWNER }), null);
});

test('AGENT_BOT_ACCOUNT names the account for the JS resolver, the same seam the shell hooks use', () => {
  const plain = repo('account-env');
  assert.equal(
    resolveAgentSlug({ env: { AGENT_BOT_ACCOUNT: 'you-goose-agent' }, cwd: plain, config: cfg }),
    'you-goose-agent',
  );
  assert.equal(
    resolveAgentSlug({ env: { AGENT_BOT_ACCOUNT: 'you-goose-agent', CLAUDECODE: '1' }, cwd: plain, config: cfg }),
    'you-goose-agent',
  );
  assert.equal(
    resolveAgentSlug({ env: { AGENT_BOT_ACCOUNT: 'you-mystery-agent' }, cwd: plain, config: cfg }),
    null,
    'a name that merely looks like a slug is not on the roster — no glob, exact match only',
  );
});

// Implicit actors — the gh shim, token minting, hook-driven setup — act only
// on a STATED identity: explicit, launcher, pin, or account. Harness detection
// alone does not make a checkout in the owner's account a bot's (delegate).
test('detect: false stops at the account, so a delegate in the owner account resolves to nothing', () => {
  const plain = repo('delegate');
  assert.equal(resolveAgentSlug({ env: CLAUDE, cwd: plain, config: cfg, account: OWNER, detect: false }), null);
  assert.equal(
    resolveAgentSlug({ env: CLAUDE, cwd: plain, config: cfg, account: 'you-goose-agent', detect: false }),
    'you-goose-agent',
  );
  assert.equal(
    resolveAgentSlug({ env: { ...CLAUDE, GH_AGENT_APP: 'you-codex-agent' }, cwd: plain, config: cfg, account: OWNER, detect: false }),
    'you-codex-agent',
  );
  const pinned = repo('delegate-pinned', 'you-claude-fable-agent');
  assert.equal(resolveAgentSlug({ env: {}, cwd: pinned, config: cfg, account: OWNER, detect: false }), 'you-claude-fable-agent');
});

// A `.goose/worktrees` path is goose's layout, nothing more: in the owner's
// account it resolves like any other directory, and in the goose account the
// account — not the path — names the App.
test('new-harness worktree directories are layout, not identity', () => {
  const worktree = repo('.goose/worktrees/session/repo');
  assert.equal(territoryHarness(worktree), 'goose');
  assert.equal(resolveAgentSlug({ env: {}, cwd: worktree, config: cfg, account: OWNER }), null);
  assert.equal(resolveAgentSlug({ env: CLAUDE, cwd: worktree, config: cfg, account: OWNER }), 'you-claude-agent');
  assert.equal(
    resolveAgentSlug({ env: { GH_AGENT_APP: 'you-claude-agent' }, cwd: worktree, config: cfg, account: OWNER }),
    'you-claude-agent',
  );
  for (const env of [{}, CLAUDE, { GH_AGENT_APP: '' }]) {
    assert.equal(
      resolveAgentSlug({ env, cwd: worktree, config: cfg, account: 'you-goose-agent' }),
      'you-goose-agent',
    );
  }
});
