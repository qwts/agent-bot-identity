import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ensureExecutablePath, installAgentBot, installExecutable, installHookWrappers, installationPaths,
} from '../install.mjs';
import { installGhShim } from '../install-gh-shim.mjs';

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

// The test that would have prevented the bug. The existing zsh integration test
// resolves `gh`, never `agent-bot`, which is exactly why this slipped through.
test('a non-login, non-interactive zsh finds agent-bot after install', { skip: !HAS_ZSH }, () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-zsh-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  ensureExecutablePath({ home });

  // A bare PATH, so .zshenv is the only thing that can put the directory back.
  const resolved = execFileSync('zsh', ['-c', 'command -v agent-bot'], {
    encoding: 'utf8',
    env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
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
  assert.throws(() => installExecutable({ home }), /not an agent-bot symlink/);
});

test('hook wrappers dispatch through the stable executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-hooks-'));
  const source = mkdtempSync(join(tmpdir(), 'agent-bot-source-'));
  writeFileSync(join(source, 'pre-commit'), '#!/bin/sh\n');
  writeFileSync(join(source, 'chain-hook'), '#!/bin/sh\n');
  const hooks = installHookWrappers({ home, sourceHooks: source });
  assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /agent-bot.*hook pre-commit/);
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
