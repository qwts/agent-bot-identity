// Cold-machine fixture for hermetic fresh-machine bootstrap coverage.
//
// Builds a temporary HOME with nothing installed — no CLI symlink, no runtime
// config, no hooks, no gh shim, no credential files — plus a controlled PATH:
//
//   - real `git` and `node`, reachable only through explicit symlinks in the
//     fixture bin directory (never the host's version managers or Homebrew);
//   - a scenario-driven fake Proton Pass CLI that serves item JSON and
//     attachment bytes from a per-fixture on-disk store;
//   - guarded stand-ins for executables a hermetic bootstrap must never reach
//     (`security`, `gh`, `npm`, `pass`). A guarded invocation is recorded in a
//     log file so the owning test fails loudly instead of the suite silently
//     touching the host keychain, password store, or GitHub login.
//
// Every environment produced here is also stripped of ambient identity and
// toolchain state (harness markers, GH_*/GITHUB_* overrides, XDG_* roots,
// version-manager homes) and routed through hermeticGitEnv, so no test using
// this fixture can read or write the developer's real keychain, pass store,
// runtime config, or global Git settings.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { hermeticGitEnv } from './hermetic-git.mjs';

// The launcher establishes this same fallback itself; keeping the fixture PATH
// suffix identical means the suite exercises the PATH shape a desktop harness
// actually hands the launcher. The fixture bin dir shadows anything (git,
// security) that also exists under /usr/bin.
const SYSTEM_PATH = '/usr/bin:/bin';

// Ambient state that would let the host answer for the cold machine being
// simulated: harness markers, GitHub identity/API overrides, agent-bot's own
// seams, XDG roots, zsh redirection, and version-manager homes.
const AMBIENT_IDENTITY_RE = new RegExp(
  '^(?:CODEX|CLAUDE|CURSOR|AI_AGENT|QWTS_|AGENT_BOT_|GH_|GITHUB_|XDG_'
  + '|ZDOTDIR$|NVM_DIR$|VOLTA_HOME$|ASDF_|NODENV_)',
);

const FAKE_PASS_CLI = `#!/bin/sh
# Hermetic stand-in for the Proton Pass CLI. Serves deterministic fixtures
# from $COLD_HOME_PASS_STORE and never talks to any real vault.
set -eu
store=\${COLD_HOME_PASS_STORE:?cold-home pass store is not configured}
title=""
attachment=""
output=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --item-title) title=$arg ;;
    --attachment-id) attachment=$arg ;;
    --output) output=$arg ;;
  esac
  prev=$arg
done
case "\${1:-} \${2:-} \${3:-}" in
  "info "*|"info  ")
    echo '{}'
    ;;
  "item view "*)
    if [ -n "$title" ] && [ -f "$store/items/$title.json" ]; then
      cat "$store/items/$title.json"
    else
      echo "pass-cli: item not found" >&2
      exit 1
    fi
    ;;
  "item attachment download")
    cp "$store/attachments/$attachment" "$output"
    ;;
  *)
    echo "pass-cli: unsupported hermetic invocation: $*" >&2
    exit 64
    ;;
esac
`;

function realExecutable(name) {
  const found = execFileSync('/bin/sh', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  }).trim();
  if (!found) throw new Error(`cold-home fixture requires ${name} on the host PATH`);
  return found;
}

function guardedExecutable(name) {
  return `#!/bin/sh
printf '%s %s\\n' ${JSON.stringify(name)} "$*" >> "\${COLD_HOME_GUARD_LOG:?cold-home guard log is not configured}"
echo ${JSON.stringify(`${name}: blocked by the hermetic cold-home fixture`)} >&2
exit 97
`;
}

// Build the controlled executable directory plus the env vars its fakes need.
// Reusable by any test that spawns runtime code which could otherwise resolve
// the host's real pass/security/gh from an inherited PATH.
export function buildControlledPath(root, { node = true } = {}) {
  const bin = join(root, 'hermetic-bin');
  const passStore = join(root, 'pass-store');
  const guardLog = join(root, 'guarded-invocations.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(passStore, 'items'), { recursive: true });
  mkdirSync(join(passStore, 'attachments'), { recursive: true });
  symlinkSync(realExecutable('git'), join(bin, 'git'));
  if (node) symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'pass-cli'), FAKE_PASS_CLI, { mode: 0o755 });
  for (const name of ['security', 'gh', 'npm', 'pass', 'launchctl', 'systemctl']) {
    writeFileSync(join(bin, name), guardedExecutable(name), { mode: 0o755 });
  }
  return {
    bin,
    passStore,
    guardLog,
    envOverrides: {
      PATH: `${bin}:${SYSTEM_PATH}`,
      COLD_HOME_PASS_STORE: passStore,
      COLD_HOME_GUARD_LOG: guardLog,
      // The launcher's trailing system-node prefixes are absolute paths that
      // HOME/PATH isolation cannot reach; empty means "this machine has none".
      AGENT_BOT_SYSTEM_NODE_DIRS: '',
    },
  };
}

// A PATH directory containing only the POSIX utilities the source launcher
// itself needs — deliberately without node — for Node-discovery scenarios.
export function minimalUtilityPath(root) {
  const bin = join(root, 'minimal-bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['basename', 'cat', 'cp', 'dirname', 'ls', 'readlink', 'sort', 'tail']) {
    symlinkSync(realExecutable(name), join(bin, name));
  }
  return bin;
}

export function createColdHome({ prefix = 'agent-bot-cold-', node = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const globalGitConfig = join(root, 'gitconfig');
  const stateDir = join(root, 'state');
  mkdirSync(home, { recursive: true });
  writeFileSync(globalGitConfig, '');
  const controlled = buildControlledPath(root, { node });

  const base = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AMBIENT_IDENTITY_RE.test(key)) base[key] = value;
  }
  const env = hermeticGitEnv(base, {
    ...controlled.envOverrides,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalGitConfig,
    AGENT_BOT_STATE_HOME: stateDir,
    AGENT_BOT_SUPERVISOR_SKIP_LOAD: '1',
  });

  return {
    root,
    home,
    env,
    stateDir,
    globalGitConfig,
    bin: controlled.bin,
    passStore: controlled.passStore,
    guardLog: controlled.guardLog,
  };
}

// Seed one App item into the fake pass store: the issuer as a note line and
// the private key as an attachment, mirroring the two provider surfaces
// ensure-private-key restores from.
export function seedPassItem(fixture, slug, { appId = '12345', privateKeyPem }) {
  const attachmentId = `${slug}-private-key`;
  writeFileSync(join(fixture.passStore, 'items', `${slug}.json`), JSON.stringify({
    shareId: 'share-fixture',
    item: {
      id: `item-${slug}`,
      content: { note: `app-id: ${appId}` },
    },
    attachments: [{ id: attachmentId, name: 'private-key.pem' }],
  }));
  writeFileSync(join(fixture.passStore, 'attachments', attachmentId), privateKeyPem);
}

// Every invocation of a guarded host executable, or '' when the fixture never
// escaped its sandbox. Tests assert this is empty.
export function guardedInvocations(fixture) {
  return existsSync(fixture.guardLog) ? readFileSync(fixture.guardLog, 'utf8') : '';
}

function git(fixture, args, cwd) {
  return execFileSync('git', args, {
    cwd,
    env: fixture.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// A primary checkout with an SSH origin plus one linked worktree laid out in
// harness territory (<root>/.<harness>/worktrees/...), matching how desktop
// harnesses create agent worktrees.
export function createRepoWithLinkedWorktree(fixture, {
  harness = 'codex',
  session = 'session',
  branch = 'topic',
  origin = 'git@github.com:example/repo.git',
} = {}) {
  const repo = join(fixture.root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(fixture, ['init', '--quiet', '--initial-branch=main'], repo);
  git(fixture, ['config', 'user.name', 'Fixture Human'], repo);
  git(fixture, ['config', 'user.email', 'human@example.com'], repo);
  git(fixture, ['remote', 'add', 'origin', origin], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(fixture, ['add', 'README.md'], repo);
  git(fixture, ['commit', '--quiet', '-m', 'initial'], repo);
  const worktree = addLinkedWorktree(fixture, repo, { harness, session, branch });
  return { repo, worktree };
}

export function addLinkedWorktree(fixture, repo, {
  harness = 'codex',
  session = 'session',
  branch = 'topic',
} = {}) {
  const worktree = join(fixture.root, `.${harness}`, 'worktrees', session, basename(repo));
  mkdirSync(join(fixture.root, `.${harness}`, 'worktrees', session), { recursive: true });
  // Suppress hooks for the fixture plumbing itself: once bootstrap has set the
  // global hooksPath, a bare `git worktree add` would run the managed
  // post-checkout hook and bind the worktree before the scenario under test
  // gets the chance to.
  git(fixture, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--quiet', '-b', branch, worktree], repo);
  return worktree;
}
