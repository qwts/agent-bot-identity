import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  agentHookFastPath, ensureExecutablePath, installAgentBot, installAgentHook, installExecutable,
  installHookWrappers, installationPaths,
} from '../install.mjs';
import { installGhShim } from '../install-gh-shim.mjs';
import { GIT_HOOK_NAMES } from '../git-hooks.mjs';

const HAS_ZSH = spawnSync('zsh', ['-c', ':'], { stdio: 'ignore' }).status === 0;

// PATH registration had no coverage at all, which is how it shipped writing only
// .zprofile: zsh reads that for login shells alone, so every harness — which
// spawns non-login, non-interactive shells reading .zshenv — found no agent-bot
// and reported the runtime missing while the symlink was present.
test('PATH is registered for harness shells as well as login shells', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-path-'));
  const first = ensureExecutablePath({ home });

  assert.equal(first.updated, true);
  assert.equal(first.zshenv.updated, true);
  // .zshenv is the file every zsh reads, so it is the one a harness depends on.
  assert.match(readFileSync(join(home, '.zshenv'), 'utf8'), /^export PATH="\$HOME\/\.local\/bin:\$PATH"/m);
  // .zprofile keeps its own line: appended after Homebrew's shellenv, it is what
  // puts our directory first for a login shell.
  assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /# agent-bot installed commands$/m);

  const second = ensureExecutablePath({ home });
  assert.equal(second.updated, false);
  assert.equal(second.zshenv.updated, false);
  assert.equal(readFileSync(join(home, '.zshenv'), 'utf8').match(/agent-bot CLI/g).length, 1);
});

// The two installers write to the same files. The gh shim's .zshenv marker is
// the loose substring `.config/agent-bot/bin`, which the CLI's .zprofile line
// also contains — a shared marker would make one installer believe the other had
// already run.
test('the two installers do not mistake each other for themselves', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-markers-'));
  ensureExecutablePath({ home });
  installGhShim({ home });

  const zshenv = readFileSync(join(home, '.zshenv'), 'utf8');
  assert.match(zshenv, /agent-bot CLI/);
  assert.match(zshenv, /agent-bot gh shim/);
  assert.equal(zshenv.split('\n').filter((line) => line.includes('.local/bin')).length, 1);

  assert.equal(ensureExecutablePath({ home }).zshenv.updated, false);
  assert.equal(installGhShim({ home }).zshenv.updated, false);
});

// With ZDOTDIR exported — the XDG-style ~/.config/zsh layout — zsh reads
// $ZDOTDIR/.zshenv and never looks at $HOME/.zshenv. Registering the home copy
// there writes to a file nothing reads, which looks identical to having fixed
// nothing.
test('registration follows ZDOTDIR when zsh reads its startup files elsewhere', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-zdotdir-'));
  const zdotdir = join(home, '.config', 'zsh');
  ensureExecutablePath({ home, env: { ZDOTDIR: zdotdir } });

  // Created even though it did not exist: it is still where zsh will look.
  assert.match(readFileSync(join(zdotdir, '.zshenv'), 'utf8'), /agent-bot CLI/);
  assert.match(readFileSync(join(zdotdir, '.zprofile'), 'utf8'), /# agent-bot installed commands$/m);
  assert.throws(() => readFileSync(join(home, '.zshenv'), 'utf8'), /ENOENT/);

  // The gh shim installer writes the same two files and must agree.
  installGhShim({ home, env: { ZDOTDIR: zdotdir } });
  assert.match(readFileSync(join(zdotdir, '.zshenv'), 'utf8'), /agent-bot gh shim/);
  assert.throws(() => readFileSync(join(home, '.zshenv'), 'utf8'), /ENOENT/);
});

// Upgrading from the .zprofile-only install writes .zshenv while .zprofile is
// already registered. Reporting only .zprofile made that look like a no-op, so
// the installer printed nothing about a file it had just changed.
test('an upgrade reports that something changed', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-upgrade-'));
  writeFileSync(
    join(home, '.zprofile'),
    'export PATH="$HOME/.config/agent-bot/bin:$HOME/.local/bin:$PATH"  # agent-bot installed commands\n',
  );

  const upgrade = ensureExecutablePath({ home, env: {} });
  assert.equal(upgrade.zprofile.updated, false, 'the existing line is left alone');
  assert.equal(upgrade.zshenv.updated, true, 'the missing one is added');
  assert.equal(upgrade.updated, true, 'and the caller is told the run changed something');
});

// The test that would have prevented the bug. The existing zsh integration test
// resolves `gh`, never `agent-bot`, which is exactly why this slipped through.
test('a non-login, non-interactive zsh finds agent-bot after install', { skip: !HAS_ZSH }, () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-zsh-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  ensureExecutablePath({ home, env: {} });

  // A bare PATH, so .zshenv is the only thing that can put the directory back.
  const resolved = execFileSync('zsh', ['-c', 'command -v agent-bot'], {
    encoding: 'utf8',
    env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
  }).trim();
  assert.equal(resolved, join(home, '.local', 'bin', 'agent-bot'));
});

// Same shell, but with zsh reading its startup files from ZDOTDIR — the case a
// home-only registration silently misses.
test('a ZDOTDIR zsh finds agent-bot after install', { skip: !HAS_ZSH }, () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-zsh-xdg-'));
  const zdotdir = join(home, '.config', 'zsh');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  ensureExecutablePath({ home, env: { ZDOTDIR: zdotdir } });

  const resolved = execFileSync('zsh', ['-c', 'command -v agent-bot'], {
    encoding: 'utf8',
    env: { HOME: home, ZDOTDIR: zdotdir, PATH: '/usr/bin:/bin' },
  }).trim();
  assert.equal(resolved, join(home, '.local', 'bin', 'agent-bot'));
});

test('installExecutable creates an idempotent ~/.local/bin/agent-bot symlink', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const entrypoint = join(root, 'agent-bot.mjs');
  writeFileSync(entrypoint, '#!/usr/bin/env node\n');
  const installed = installExecutable({ home, entrypoint });
  assert.equal(readlinkSync(installed), entrypoint);
  assert.equal(installExecutable({ home, entrypoint }), installed);
});

test('installExecutable refuses a foreign executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'), 'foreign\n');
  assert.throws(() => installExecutable({ home, chmod: () => {} }), /not an agent-bot symlink/);
});

test('hook wrappers dispatch through the stable executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-hooks-'));
  const source = mkdtempSync(join(tmpdir(), 'agent-bot-source-'));
  for (const name of GIT_HOOK_NAMES) writeFileSync(join(source, name), '#!/bin/sh\n');
  writeFileSync(join(source, 'chain-hook'), '#!/bin/sh\n');
  const hooks = installHookWrappers({ home, sourceHooks: source });
  assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /agent-bot.*hook pre-commit/);
});

test('the agent-hook fast path skips Node until an executable hook exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-fast-hook-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-bot-fast-repo-'));
  const hooks = join(repo, 'agent-hooks', 'pre-command');
  const calls = join(home, 'calls');
  const runner = join(home, 'runner');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$*" >"${calls}"\n`, { mode: 0o755 });
  const fast = installAgentHook({ home });
  const env = {
    ...process.env,
    AGENT_BOT_BIN: runner,
    AGENT_BOT_HOOKS_DIR: join(repo, 'agent-hooks'),
    HOME: home,
  };

  assert.equal(spawnSync(fast, ['--dialect', 'claude', '--event', 'pre-command'], { env }).status, 0);
  assert.throws(() => readFileSync(calls), /ENOENT/);

  writeFileSync(join(hooks, '50-live'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(spawnSync(fast, ['--dialect', 'claude', '--event', 'pre-command'], { env }).status, 0);
  assert.equal(readFileSync(calls, 'utf8').trim(), 'agent-hook --dialect claude --event pre-command');
});

test('the agent-hook fast path falls back to toolkit hooks in a consumer repo', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-fast-fallback-home-'));
  const toolkit = mkdtempSync(join(tmpdir(), 'agent-bot-fast-fallback-toolkit-'));
  const consumer = mkdtempSync(join(tmpdir(), 'agent-bot-fast-fallback-consumer-'));
  const calls = join(home, 'calls');
  const runner = join(toolkit, 'agent-bot.mjs');
  const hook = join(toolkit, 'agent-hooks', 'pre-push', '50-policy');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(toolkit, 'agent-hooks', 'pre-push'), { recursive: true });
  writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$*" >"${calls}"\n`, { mode: 0o755 });
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  symlinkSync(runner, join(home, '.local', 'bin', 'agent-bot'));
  execFileSync('git', ['init', '--quiet'], { cwd: consumer });
  const fast = installAgentHook({ home });
  const env = { ...process.env, HOME: home };
  delete env.AGENT_BOT_BIN;
  delete env.AGENT_BOT_HOOKS_DIR;

  const run = spawnSync(fast, ['--dialect', 'git', '--event', 'pre-push'], {
    cwd: consumer,
    env,
  });
  assert.equal(run.status, 0);
  assert.equal(readFileSync(calls, 'utf8').trim(), 'agent-hook --dialect git --event pre-push');
});

test('the installed fast path is the managed POSIX implementation', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-fast-install-'));
  const path = installAgentHook({ home });
  assert.equal(readFileSync(path, 'utf8'), agentHookFastPath());
});

test('installer chains displaced hooks and replaces legacy agent-bot hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const values = new Map([['core.hooksPath', '/custom/husky-hooks']]);
  const run = (args) => {
    const key = args.at(-1);
    if (args.includes('--get')) {
      if (!values.has(key)) {
        const error = new Error('unset');
        error.status = 1;
        throw error;
      }
      return values.get(key);
    }
    values.set(args.at(-2), args.at(-1));
    return '';
  };
  const result = installAgentBot({
    home,
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
  });
  assert.equal(result.chainedHooksPath, '/custom/husky-hooks');
  assert.equal(values.get('agentBot.chainedHooksPath'), '/custom/husky-hooks');
  assert.equal(values.get('core.hooksPath'), result.hooksPath);

  values.set('core.hooksPath', '/repo/playbook-engineering/tools/agent-bot/hooks');
  values.delete('agentBot.chainedHooksPath');
  values.delete('qwts.chainedHooksPath');
  const migrated = installAgentBot({
    home,
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
  });
  assert.equal(migrated.chainedHooksPath, null);
});
