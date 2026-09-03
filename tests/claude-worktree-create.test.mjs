import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  branchName,
  claudeTranscriptEnvironment,
  desktopConfigPath,
  parseHookInput,
  pickBaseRef,
  validateWorktreeName,
  worktreePath,
  worktreeRoot,
} from '../claude-worktree-create.mjs';

const AGENT_BOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(AGENT_BOT, 'claude-worktree-create.mjs');
const WRAPPER = join(AGENT_BOT, 'claude-worktree-create');
const root = mkdtempSync(join(tmpdir(), 'claude-worktree-create-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('accepts the names Claude Code generates', () => {
  for (const name of ['add-oauth-3f9c1a', 'Fix_Bug.2', 'x']) {
    assert.equal(validateWorktreeName(name), name);
  }
});

test('rejects names that could escape the worktree root or reach git as options', () => {
  for (const name of ['', '.', '..', '../escape', 'a/b', '-b main', 'two words', 'nul\0', 'a..b']) {
    assert.throws(() => validateWorktreeName(name), /invalid worktree name/);
  }
});

test('reads the base repo and name out of the hook payload', () => {
  assert.deepEqual(parseHookInput('{"cwd":"/repo","name":"topic-1a2b","session_id":"s"}'), {
    baseRepo: '/repo',
    name: 'topic-1a2b',
    sessionId: 's',
  });
  assert.throws(() => parseHookInput('not json'), /not valid JSON/);
  assert.throws(() => parseHookInput('{"name":"topic-1a2b"}'), /no cwd/);
  assert.throws(
    () => parseHookInput('{"cwd":"/repo","name":"topic-1a2b"}'),
    /no valid session_id/,
  );
});

test('Claude startup emits only canonical transcript environment names', () => {
  const env = claudeTranscriptEnvironment('session-1', {
    KEEP_ME: 'yes',
    QWTS_AGENT_TRANSCRIPT_PROVIDER: 'legacy',
    QWTS_AGENT_TRANSCRIPT_ID: 'legacy-session',
  });
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.AGENT_BOT_TRANSCRIPT_PROVIDER, 'claude');
  assert.equal(env.AGENT_BOT_TRANSCRIPT_ID, 'session-1');
  assert.equal('QWTS_AGENT_TRANSCRIPT_PROVIDER' in env, false);
  assert.equal('QWTS_AGENT_TRANSCRIPT_ID' in env, false);
});

test('places worktrees in Claude\'s worktree layout, honoring a relocated worktree directory', () => {
  assert.equal(worktreeRoot({ home: '/home/dev', env: {} }), join('/home/dev', '.claude', 'worktrees'));
  assert.equal(
    worktreeRoot({
      home: '/home/dev',
      env: {},
      desktopConfig: JSON.stringify({ preferences: { chillingSlothLocation: { customPath: '/wt' } } }),
    }),
    '/wt',
  );
  assert.equal(worktreeRoot({ home: '/home/dev', env: {}, desktopConfig: 'corrupt' }), join('/home/dev', '.claude', 'worktrees'));
  assert.equal(worktreeRoot({ home: '/home/dev', env: { AGENT_WORKTREE_ROOT: '/override' } }), '/override');
});

test('an override that is relative or tilde-prefixed still yields an absolute root', () => {
  // Claude Code rejects a relative path, so neither override may produce one.
  assert.equal(worktreeRoot({ home: '/home/dev', env: { AGENT_WORKTREE_ROOT: '~/wt' } }), '/home/dev/wt');
  assert.equal(worktreeRoot({ home: '/home/dev', env: { AGENT_WORKTREE_ROOT: 'wt' } }), '/home/dev/wt');
  assert.equal(
    worktreeRoot({
      home: '/home/dev',
      env: {},
      desktopConfig: JSON.stringify({ preferences: { chillingSlothLocation: { customPath: '~/wt' } } }),
    }),
    '/home/dev/wt',
  );
});

test('names the worktree path and branch the way Claude Code does', () => {
  assert.equal(worktreePath('/wt', '/Users/dev/Code/overlook', 'topic-1a2b'), '/wt/overlook/topic-1a2b');
  assert.equal(branchName('topic-1a2b'), 'claude/topic-1a2b');
});

test('sidesteps the collision when the repo itself sits in the worktree root', () => {
  assert.equal(worktreePath('/wt', '/wt/overlook', 'topic-1a2b'), '/wt/overlook-worktrees/topic-1a2b');
});

test('branches fresh from the remote default branch, falling back to HEAD', () => {
  assert.equal(pickBaseRef({ originHead: 'origin/trunk', exists: (r) => r === 'origin/trunk' }), 'origin/trunk');
  assert.equal(pickBaseRef({ originHead: 'origin/gone', exists: (r) => r === 'origin/main' }), 'origin/main');
  assert.equal(pickBaseRef({ exists: (r) => r === 'origin/master' }), 'origin/master');
  assert.equal(pickBaseRef({ exists: () => false }), 'HEAD');
});

test('looks for the relocated-worktree preference where each platform keeps it', () => {
  assert.match(desktopConfigPath('/home/dev', 'darwin', {}), /Library\/Application Support\/Claude/);
  assert.equal(
    desktopConfigPath('/home/dev', 'linux', {}),
    join('/home/dev', '.config', 'Claude', 'claude_desktop_config.json'),
  );
  assert.equal(
    desktopConfigPath('/home/dev', 'win32', { APPDATA: '/appdata' }),
    join('/appdata', 'Claude', 'claude_desktop_config.json'),
  );
});

// End to end: a real repo, the real hook, no harness markers in the
// environment — so detect-harness resolves nothing and the identity step is
// the no-op it is designed to be off a recognized harness.
function runHook(payload, { home }) {
  return execFileSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: home },
  }).trim();
}

function fixture(name) {
  const home = join(root, name);
  const repo = join(home, 'Code', 'sample');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# sample\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'init');
  return { home, repo, git };
}

test('creates the worktree in Claude\'s worktree layout and prints its path', () => {
  const { home, repo, git } = fixture('e2e');

  const printed = runHook({ cwd: repo, name: 'topic-1a2b', session_id: 'session-1' }, { home });

  assert.equal(printed, join(home, '.claude', 'worktrees', 'sample', 'topic-1a2b'));
  // git reports resolved paths; on macOS the temp dir is reached through a symlink.
  assert.ok(git('worktree', 'list', '--porcelain').includes(`worktree ${realpathSync(printed)}`));
  assert.equal(
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: printed, encoding: 'utf8' }).trim(),
    'claude/topic-1a2b',
  );
});

// The wrapper's whole job: the desktop app spawns it with a PATH that need
// not carry an nvm-installed node, under whatever /bin/sh the host has (dash
// on most Linuxes) — so it reads nvm's layout instead of sourcing nvm.sh.
// Each stand-in node reports its own path, which is what the wrapper picked.
const SYSTEM_PATH = '/usr/bin:/bin';
const systemHasNode = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v node'], { env: { PATH: SYSTEM_PATH }, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('the wrapper finds an nvm node with none on PATH and nothing sourced', { skip: systemHasNode }, () => {
  const home = join(root, 'nvm');
  const nvmDir = join(home, '.nvm');
  for (const version of ['v18.0.0', 'v24.18.0']) {
    const bin = join(nvmDir, 'versions', 'node', version, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho ${join(bin, 'node')}\n`, { mode: 0o755 });
  }
  mkdirSync(join(nvmDir, 'alias'), { recursive: true });
  writeFileSync(join(nvmDir, 'alias', 'default'), '18.0.0\n');

  const run = (env) =>
    execFileSync(WRAPPER, { encoding: 'utf8', env: { PATH: SYSTEM_PATH, HOME: home, ...env } }).trim();

  assert.equal(run({}), join(nvmDir, 'versions', 'node', 'v18.0.0', 'bin', 'node'), 'the default alias wins');
  rmSync(join(nvmDir, 'alias', 'default'));
  assert.equal(run({}), join(nvmDir, 'versions', 'node', 'v24.18.0', 'bin', 'node'), 'else the newest installed');
  assert.throws(() => run({ NVM_DIR: join(root, 'absent') }), /no node on PATH/);
});

test('fails loudly rather than reusing a path or a branch', () => {
  const { home, repo } = fixture('collision');
  runHook({ cwd: repo, name: 'topic-1a2b', session_id: 'session-1' }, { home });

  assert.throws(
    () => runHook({ cwd: repo, name: 'topic-1a2b', session_id: 'session-2' }, { home }),
    /refusing to reuse an existing path/,
  );
  assert.throws(
    () => runHook({ cwd: repo, name: 'nul\0', session_id: 'session-2' }, { home }),
    /invalid worktree name/,
  );
});
