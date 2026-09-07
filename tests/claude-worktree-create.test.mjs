import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { readAgentIdentity } from '../agent-identity.mjs';
import { CLAUDE_WORKTREE_CREATE_COMMAND } from '../hook-dialects.mjs';
import { installExecutable } from '../install.mjs';
import { organizationProfileToConfig } from '../organization-profile.mjs';
import { ensureClaudeWorktreeAdapter } from '../sync-hooks.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';
import { startMockGitHubApp } from './helpers/mock-github-app.mjs';

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

test('concurrent installed and governed Claude adapters share only the same bound session (#193)', async (t) => {
  const home = join(root, 'installed adapter home');
  const repo = join(home, 'Code', 'sample');
  const bin = join(home, 'bin');
  const app = 'fixture-model-persona';
  const stateDir = join(home, 'state');
  const populationPath = join(home, 'population.json');
  mkdirSync(repo, { recursive: true });
  mkdirSync(bin);
  const github = startMockGitHubApp(home);
  t.after(() => github.stop());
  const config = {
    ...organizationProfileToConfig({
      schema_version: 1,
      organization: 'test-owner',
      account_owner: 'fixture',
      minimum_runtime_interface_version: 1,
      defaults: { claude: 'fixture-claude-agent' },
      identities: [
        { slug: 'fixture-claude-agent', harness: 'claude', status: 'active' },
        { slug: app, harness: 'claude', status: 'active', models: ['model'] },
      ],
    }),
    scope: { apps: [app] },
    owner: 'test-owner',
    settings: { daemonPreference: 'off' },
  };
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), JSON.stringify(config));
  mkdirSync(join(home, '.config', app));
  writeFileSync(join(home, '.config', app, 'app-id'), '12345\n');
  writeFileSync(join(home, '.config', app, 'private-key.pem'), github.privateKeyPem, { mode: 0o600 });
  writeFileSync(join(home, '.config', app, 'bot-uid'), '700001\n');
  writeFileSync(join(home, '.config', app, 'bot-avatar-url'), 'https://avatars.example/u/700001\n');
  writeFileSync(join(bin, 'pass-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const env = hermeticGitEnv({}, {
    HOME: home,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GITHUB_API_URL: github.apiBase,
    AGENT_BOT_BIN: join(home, '.local', 'bin', 'agent-bot'),
    AGENT_BOT_ACCOUNT: app,
    AGENT_BOT_STATE_HOME: stateDir,
    AGENT_BOT_SPACES_HOME: join(home, 'spaces'),
    AGENT_BOT_POPULATION_PATH: populationPath,
  });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# sample\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '--quiet', '-m', 'init');

  installExecutable({ home });
  await ensureClaudeWorktreeAdapter({ home, env, config });
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const commands = settings.hooks.WorktreeCreate.flatMap((entry) => entry.hooks)
    .filter((hook) => hook.type === 'command');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, CLAUDE_WORKTREE_CREATE_COMMAND);
  const sessionId = 'installed-claude-session-193';
  const governed = JSON.parse(readFileSync(join(AGENT_BOT, '.claude', 'settings.json'), 'utf8'))
    .hooks.WorktreeCreate[0].hooks[0].command;
  const invoke = (command, payload, overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd: repo, env: { ...env, ...overrides }, timeout: 30_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
  const payload = { cwd: repo, name: 'topic-193', session_id: sessionId };
  const results = await Promise.all([invoke(governed, payload), invoke(commands[0].command, payload)]);
  const printed = results[0].stdout.trim();
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${printed}\n`);
  }

  assert.equal(printed, join(home, '.claude', 'worktrees', 'sample', 'topic-193'));
  assert.equal(git(printed, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/topic-193');
  assert.equal(git(printed, 'config', '--worktree', '--get', 'agentBot.app'), app);
  const agentId = git(printed, 'config', '--worktree', '--get', 'agentBot.agentId');
  assert.match(agentId, /^agent_/);
  const transcript = { provider: 'claude', id: sessionId, sha256: null };
  assert.deepEqual(readAgentIdentity(agentId, { stateDir }).transcript, transcript);
  const population = JSON.parse(readFileSync(populationPath, 'utf8'));
  assert.equal(population.souls[agentId].appSlug, app);
  assert.deepEqual(population.souls[agentId].transcriptLocator, { provider: 'claude', id: sessionId });
  assert.equal(population.souls[agentId].worktree, realpathSync(printed));
  assert.deepEqual(Object.keys(population.souls), [agentId]);
  assert.deepEqual(readdirSync(stateDir).filter((name) => /^agent_.*\.json$/.test(name)), [`${agentId}.json`]);
  const rejected = await invoke(governed, { ...payload, session_id: 'different-session' });
  assert.equal(rejected.code, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /refusing to reuse an existing path/);
  const unrelated = join(dirname(printed), 'unrelated');
  mkdirSync(unrelated);
  const conflict = await invoke(commands[0].command, { ...payload, name: 'unrelated' });
  assert.equal(conflict.code, 1);
  assert.equal(conflict.stdout, '');
  assert.match(conflict.stderr, /refusing to reuse an existing path/);
  const wrongApp = await invoke(`"$AGENT_BOT_BIN" claude-worktree-create`, payload, { GH_AGENT_APP: 'other-app' });
  assert.equal(wrongApp.code, 1);
  assert.match(wrongApp.stderr, /refusing to reuse an existing path/);
  assert.equal(readFileSync(populationPath, 'utf8'), JSON.stringify(population, null, 2) + '\n');
  assert.equal(git(printed, 'config', '--worktree', '--get', 'agentBot.agentId'), agentId);
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
