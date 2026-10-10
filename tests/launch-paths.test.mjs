// Every direct child_process call site in the runtime, and why its env is
// what it is (#785). A process that runs agent-controlled or third-party code
// from the daemon gets the child-env boundary (child-env.mjs, directly or via
// composeTurnEnv / soulEnvironment); the rest are listed with the reason they
// keep their env. A new call site, or one that moves between files, fails
// here until it is classified. Injected runners (`run`, `runImpl`) are
// covered by their own module's tests: comms-relay, comms-membership,
// harness-auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\(/;

// module → [matching lines, reason]. Counts include comments that name a call.
const LAUNCH_PATHS = {
  // Filtered: the boundary applies.
  'acp-engine.mjs': [2, 'filtered: harness turn env from composeTurnEnv via harnessProcessEnv'],
  'wake-resume.mjs': [1, 'filtered: harness turn env from composeTurnEnv'],
  'agent-hook.mjs': [4, 'filtered: spawn hooks and their agent-comms join get minimalChildEnv; policy hooks run in the harness\'s own hook process and env; git'],
  'soul-env-export.mjs': [1, 'filtered: git under minimalChildEnv'],
  'sandbox-export.mjs': [1, 'filtered: tar under minimalChildEnv'],
  'soul-home.mjs': [1, 'filtered: git init with PATH only'],
  'skill-workspace.mjs': [2, 'filtered: git with PATH only'],
  'readiness.mjs': [2, 'filtered: zsh probe with HOME and a fixed PATH; git'],
  // Harness-side: runs inside the harness, whose env the agent already holds.
  'muse-acp.mjs': [1, 'harness-side: muse inherits the adapter\'s turn env, already filtered, plus the provider grants it needs'],
  'cli/identity.mjs': [2, 'caller context: runs the caller\'s command with the caller\'s own env plus identity; git'],
  'uninstalled-identity-hook.mjs': [3, 'caller context: git config and gh in the user\'s session'],
  // First-party agent-bot code.
  'agent-daemon.mjs': [2, 'first-party: the daemon re-executing its own module; git'],
  'bootstrap.mjs': [1, 'first-party: the installed agent-bot'],
  'install.mjs': [2, 'first-party: the installed agent-bot; git'],
  'cli/dispatch.mjs': [2, 'first-party: agent-bot subcommands'],
  'claude-worktree-create.mjs': [2, 'first-party: setup-worktree; git'],
  'soul-join.mjs': [4, 'git, and an injected soul spawn function (not child_process)'],
  'acp-registry.mjs': [1, 'comment only'],
  // Owner-run tools, opened by the owner's own command.
  'skill.mjs': [2, 'owner-run: gh api; git'],
  'secret-providers/proton-pass.mjs': [1, 'owner-run: pass-cli'],
  'owner-statement.mjs': [1, 'owner-run: ssh-keygen'],
  'shell-path.mjs': [1, 'owner-run: zsh-profile writing the owner\'s profile'],
  'agent-web.mjs': [1, 'browser open'],
  'identity-apps.mjs': [1, 'browser open'],
  // OS tools.
  'daemon-supervisor.mjs': [1, 'OS tool: launchctl/systemctl/schtasks'],
  'keyd-supervisor.mjs': [1, 'OS tool: launchctl'],
  'owner-approval.mjs': [1, 'OS tool: osascript'],
  'owner-presence.mjs': [2, 'OS tool: codesign, then the verified keyd binary'],
  'process-ownership.mjs': [1, 'OS tool: ps'],
  'sandbox.mjs': [1, 'OS tool: sandbox controls'],
  'comms-client.mjs': [1, 'OS tool: id'],
  // git.
  'agent-binding.mjs': [2, 'git'],
  'agent-identity.mjs': [1, 'git'],
  'agent-mcp.mjs': [1, 'git'],
  'confinement.mjs': [1, 'git'],
  'inbox-take.mjs': [1, 'git'],
  'metrics.mjs': [1, 'git'],
  'resolve-agent.mjs': [1, 'git'],
  'setup-worktree.mjs': [2, 'git'],
  'signed-commit.mjs': [1, 'git'],
  'sop.mjs': [1, 'git'],
  'wake-listen.mjs': [1, 'git'],
  'worktree-token.mjs': [1, 'git'],
  // Build tooling, never shipped to a soul.
  'scripts/changelog.mjs': [1, 'build tooling: git'],
  'scripts/linux-bundle/build.mjs': [2, 'build tooling'],
};

function runtimeModules(dir = root, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || ['node_modules', 'tests', 'dist'].includes(entry.name)) return [];
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return runtimeModules(path.join(dir, entry.name), rel);
    return entry.name.endsWith('.mjs') ? [rel] : [];
  });
}

test('every child_process call site is classified, and every classified one exists (#785)', () => {
  const found = {};
  for (const rel of runtimeModules()) {
    const count = readFileSync(path.join(root, rel), 'utf8').split('\n').filter((line) => CALL.test(line)).length;
    if (count > 0) found[rel] = count;
  }
  const expected = Object.fromEntries(Object.entries(LAUNCH_PATHS).map(([rel, [count]]) => [rel, count]));
  assert.deepEqual(found, expected);
});
