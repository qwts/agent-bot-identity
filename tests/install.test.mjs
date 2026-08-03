import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installAgentBot, installExecutable, installHookWrappers, installationPaths,
} from '../install.mjs';
import { ensureExecutablePath } from '../shell-path.mjs';

test('PATH registration follows zprofile setup and migrates legacy zshenv lines', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-path-'));
  writeFileSync(join(home, '.zshenv'), [
    'export KEEP_ENV=1',
    'export PATH="$HOME/.config/agent-bot/bin:$PATH"  # agent-bot gh shim (ENG-0045)',
    'export PATH="$HOME/.local/bin:$PATH"  # agent-bot CLI',
    '',
  ].join('\n'));
  writeFileSync(join(home, '.zprofile'), [
    'export PATH="$HOME/.config/agent-bot/bin:$HOME/.local/bin:$PATH"  # agent-bot installed commands',
    'eval "$(brew shellenv)"',
    'export KEEP_PROFILE=1',
    '',
  ].join('\n'));

  const first = ensureExecutablePath({ home });
  assert.deepEqual(first.migrated, [join(home, '.zshenv')]);
  assert.equal(readFileSync(join(home, '.zshenv'), 'utf8'), 'export KEEP_ENV=1\n');
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), [
    'eval "$(brew shellenv)"',
    'export KEEP_PROFILE=1',
    'export PATH="$HOME/.local/bin:$PATH"  # agent-bot installed commands',
    '',
  ].join('\n'));

  const second = ensureExecutablePath({ home });
  assert.equal(second.updated, false);
  assert.deepEqual(second.migrated, []);
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
