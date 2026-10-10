// Every runtime module that imports node:child_process, and why each process
// it starts gets the env it does (#785). A process that runs agent-controlled
// or third-party code from the daemon gets the child-env boundary
// (child-env.mjs, directly or via composeTurnEnv / soulEnvironment); the rest
// are listed with the reason they keep their env. Each imported binding,
// aliases included, is counted where code uses it: called, passed, or taken
// as a default runner (`run = execFile`, `promisify(execFile)`). A new
// importing module, or a new use in a listed one, fails here until it is
// classified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;

// module → [uses of child_process bindings, reason].
const LAUNCH_PATHS = {
  // Filtered: the boundary applies.
  'acp-engine.mjs': [1, 'filtered: harness turn env from composeTurnEnv via harnessProcessEnv'],
  'wake-resume.mjs': [1, 'filtered: harness turn env from composeTurnEnv'],
  'harness-auth.mjs': [1, 'filtered: the turn env from composeTurnEnv, on the daemon and the CLI path'],
  'comms-relay.mjs': [2, 'filtered: agent-comms under minimalChildEnv plus the broker location'],
  'comms-membership.mjs': [2, 'filtered: agent-comms join and leave under soulEnvironment'],
  'agent-hook.mjs': [4, 'filtered: spawn hooks and their agent-comms join get minimalChildEnv; policy hooks run in the harness\'s own hook process and env; git'],
  'soul-home.mjs': [2, 'filtered: npm ci under minimalChildEnv (soulInstallEnv); git init with PATH only'],
  'soul-runtimes.mjs': [1, 'filtered: uv under minimalChildEnv; tar is an OS tool'],
  'soul-env-export.mjs': [1, 'filtered: git under minimalChildEnv'],
  'sandbox-export.mjs': [1, 'filtered: /usr/bin/tar under minimalChildEnv'],
  'skill-workspace.mjs': [2, 'filtered: git with PATH only'],
  'readiness.mjs': [2, 'filtered: zsh probe with HOME and a fixed PATH; git'],
  // Harness-side: runs inside the harness, whose env the agent already holds.
  'muse-acp.mjs': [1, 'harness-side: muse inherits the adapter\'s turn env, already filtered, plus the provider grants it needs'],
  // Caller context: the caller already holds the env it passes.
  'cli/identity.mjs': [2, 'caller context: runs the caller\'s command with the caller\'s own env plus identity; git'],
  'soul-join.mjs': [4, 'caller context: the owner\'s `soul join` runs agent-comms join; git'],
  'uninstalled-identity-hook.mjs': [6, 'caller context: git config and gh in the user\'s session, here and in the hook it writes'],
  // First-party agent-bot code.
  'agent-daemon.mjs': [3, 'first-party: the daemon re-executing its own module; the login shell probe for PATH; git'],
  'bootstrap.mjs': [1, 'first-party: the installed agent-bot'],
  'install.mjs': [3, 'first-party: the installed agent-bot; git'],
  'install-gh-shim.mjs': [1, 'owner-run: zsh-profile via ensureBlock, from the owner\'s install'],
  'cli/dispatch.mjs': [2, 'first-party: agent-bot subcommands'],
  'claude-worktree-create.mjs': [2, 'first-party: setup-worktree; git'],
  // Owner-run tools, opened by the owner's own command.
  'skill.mjs': [2, 'owner-run: gh api; git'],
  'secret-providers/pass-cli.mjs': [1, 'owner-run: pass-cli'],
  'secret-providers/proton-pass.mjs': [1, 'owner-run: proton-pass'],
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
  'sandbox.mjs': [1, 'OS tool: sandbox probes'],
  'comms-client.mjs': [1, 'OS tool: id'],
  'comms-windows.mjs': [2, 'OS tool: powershell for the pipe relay, under legacyPowerShellEnv'],
  'soul-credentials.mjs': [2, 'OS tool: security, or powershell for the file store ACL'],
  'windows-account-custody.mjs': [1, 'OS tool: Windows account commands'],
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

// Uses of the module's child_process bindings outside the import and
// comments. null when it names child_process without an import this reads
// (a namespace import, require, or dynamic import), so it cannot hide.
export function childProcessUses(source) {
  const locals = [...source.matchAll(IMPORT)].flatMap((match) => match[1].split(',')
    .map((spec) => spec.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const code = source.replace(IMPORT, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  if (locals.length === 0) return /child_process/.test(code) ? null : 0;
  return locals.reduce((total, name) => total + (code.match(new RegExp(
    `(?<![\\w.$/'"\`-])${name}(?=\\s*\\()|=\\s*${name}\\b|\\(\\s*${name}\\s*\\)`, 'g')) ?? []).length, 0);
}

test('every child_process import is classified, with each use counted, and every classified module exists (#785)', () => {
  const found = {};
  for (const rel of runtimeModules()) {
    const uses = childProcessUses(readFileSync(path.join(root, rel), 'utf8'));
    if (uses !== 0) found[rel] = uses;
  }
  const expected = Object.fromEntries(Object.entries(LAUNCH_PATHS).map(([rel, [uses]]) => [rel, uses]));
  assert.deepEqual(found, expected);
});

test('aliases, default runners and wrappers count; comments and prose do not', () => {
  assert.equal(childProcessUses("import { spawn as start } from 'node:child_process';\nstart('x');"), 1);
  assert.equal(childProcessUses("import { execFile } from 'node:child_process';\nconst run = promisify(execFile);\nfunction f({ run = execFile } = {}) {}"), 2);
  assert.equal(childProcessUses("import { spawn } from 'node:child_process';\n// spawn('x')\nconst s = 'POST /v0/spawn';\n/* spawn(y) */"), 0);
  assert.equal(childProcessUses("const cp = await import('node:child_process');"), null);
});
