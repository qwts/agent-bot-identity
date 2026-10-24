// Every runtime module that imports node:child_process, and why each process
// it starts gets the env it does (#785). A process that runs agent-controlled
// or third-party code from the daemon gets the child-env boundary
// (child-env.mjs, directly or via composeTurnEnv / soulEnvironment); the rest
// are listed with the reason they keep their env. Every code reference to an
// imported binding counts, aliases included, however it is called or passed
// (`run = execFile`, `promisify(execFile)`, `[execFile]`); any other way of
// naming child_process fails outright. A new importing module, or a new
// reference in a listed one, fails here until it is classified. The hook source a module writes as a template is data, not a
// launch here.
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
  'agent-hook.mjs': [4, 'filtered: spawn hooks and their agent-comms join get minimalChildEnv; policy hooks run in the harness\'s own hook process and env; git'],
  'soul-home.mjs': [2, 'filtered: npm ci under minimalChildEnv (soulInstallEnv); git init with PATH only'],
  'soul-runtimes.mjs': [1, 'filtered: uv under minimalChildEnv; tar is an OS tool'],
  'soul-env-export.mjs': [1, 'filtered: git under minimalChildEnv'],
  'sandbox-export.mjs': [1, 'filtered: /usr/bin/tar under minimalChildEnv'],
  'skill-workspace.mjs': [2, 'filtered: git with PATH only'],
  'readiness.mjs': [3, 'filtered: zsh probe with HOME and a fixed PATH; git; caller context: doctor\'s gh auth status in the caller\'s session, through any gh shim'],
  // Harness-side: runs inside the harness, whose env the agent already holds.
  'muse-acp.mjs': [1, 'harness-side: muse inherits the adapter\'s turn env, already filtered, plus the provider grants it needs'],
  // Caller context: the caller already holds the env it passes.
  'cli/identity.mjs': [2, 'caller context: runs the caller\'s command with the caller\'s own env plus identity; git'],
  'soul-join.mjs': [3, 'caller context: git for the owner\'s soul join; membership dispatch is classified in windows-git-shell'],
  'identity/uninstalled-identity-hook.mjs': [3, 'caller context: git config and gh in the user\'s session'],
  // First-party agent-bot code.
  'agent-daemon.mjs': [3, 'first-party: the daemon re-executing its own module; the login shell probe for PATH; git'],
  'bootstrap.mjs': [2, 'first-party: the installed agent-bot, through validated Node launcher metadata on Windows'],
  'install.mjs': [3, 'first-party: the installed agent-bot; git'],
  'identity/install-gh-shim.mjs': [1, 'owner-run: zsh-profile via ensureBlock, from the owner\'s install'],
  'cli/dispatch.mjs': [2, 'first-party: agent-bot subcommands'],
  'claude-worktree-create.mjs': [2, 'first-party: setup-worktree; git'],
  'identity/daemon-client.mjs': [1, 'first-party: identity-entry.mjs under the caller\'s own env, the env the operation would see in-process (identityOp, #645)'],
  // Owner-run tools, opened by the owner's own command.
  'skill.mjs': [2, 'owner-run: gh api; git'],
  'identity/secret-providers/pass-cli.mjs': [1, 'owner-run: pass-cli'],
  'identity/secret-providers/proton-pass.mjs': [1, 'owner-run: proton-pass'],
  'identity/owner-statement.mjs': [1, 'owner-run: ssh-keygen'],
  'shell-path.mjs': [1, 'owner-run: zsh-profile writing the owner\'s profile'],
  'agent-web.mjs': [1, 'browser open'],
  'identity/identity-apps.mjs': [1, 'browser open'],
  // OS tools.
  'daemon-supervisor.mjs': [1, 'OS tool: launchctl/systemctl/schtasks'],
  'keyd-supervisor.mjs': [1, 'OS tool: launchctl'],
  'identity/owner-approval.mjs': [1, 'OS tool: osascript'],
  'identity/owner-presence.mjs': [2, 'OS tool: codesign, then the verified keyd binary'],
  'detect-harness.mjs': [1, 'OS tool: ps'],
  'process-ownership.mjs': [1, 'OS tool: ps'],
  'sandbox.mjs': [1, 'OS tool: sandbox probes'],
  'comms-client.mjs': [1, 'OS tool: id'],
  'comms-windows.mjs': [2, 'OS tool: powershell for the pipe relay, under legacyPowerShellEnv'],
  'identity/soul-credentials.mjs': [2, 'OS tool: security, or powershell for the file store ACL'],
  'windows-account-custody.mjs': [1, 'OS tool: Windows account commands'],
  'windows-install-path.mjs': [1, 'OS tool: a fixed native directory-handle lookup in the installer caller\'s environment'],
  'windows-git-shell.mjs': [3, 'git --exec-path selects its shipped shell; CLI dispatch retains the supplied caller env or the soulEnvironment filtered by comms-membership, adding only Git utilities to PATH'],
  // git.
  'identity/agent-binding.mjs': [2, 'git'],
  'identity/agent-identity.mjs': [1, 'git'],
  'agent-mcp.mjs': [1, 'git'],
  'confinement.mjs': [1, 'git'],
  'identity/inbox-take.mjs': [1, 'git'],
  'metrics.mjs': [1, 'git'],
  'identity/resolve-agent.mjs': [1, 'git'],
  'setup-worktree.mjs': [2, 'git'],
  'session-bind.mjs': [3, 'git; first-party: the installed agent-bot under the caller\'s own env'],
  'identity/signed-commit.mjs': [1, 'git'],
  'sop.mjs': [1, 'git'],
  'soul-coauthor.mjs': [1, 'git'],
  'wake-listen.mjs': [1, 'git'],
  'identity/worktree-token.mjs': [1, 'git'],
  // Build tooling, never shipped to a soul.
  'scripts/changelog.mjs': [1, 'build tooling: git'],
  'scripts/windows-supervisor-acceptance.mjs': [1, 'owner-run disposable native acceptance: real OS task tools and staged first-party engines only'],
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

// The source as code alone: comments, string, template and regex literal
// contents blanked, template `${}` expressions kept. A string naming the
// child_process module stays, so its imports still read.
export function codeOnly(source) {
  let out = '';
  let last = '';
  const braces = [];
  const word = () => /([A-Za-z_$][\w$]*)\s*$/.exec(out)?.[1];
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; out += ' '; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      const body = source.slice(i + 1, j);
      out += /^(?:node:)?child_process$/.test(body) ? `${ch}${body}${ch}` : `${ch}${ch}`;
      i = j + 1; last = ch; continue;
    }
    if (ch === '`' || (ch === '}' && braces.at(-1) === 0)) {
      if (ch === '}') braces.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
      if (source[j] === '$') { out += '`${'; braces.push(0); i = j + 2; last = '{'; continue; }
      out += '``'; i = j + 1; last = '`'; continue;
    }
    if (ch === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || ['return', 'typeof', 'case', 'in', 'of', 'yield', 'await'].includes(word()))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j++;
      }
      j++;
      while (/[a-z]/.test(source[j] ?? '')) j++;
      out += '/(?:)/'; i = j; last = '/'; continue;
    }
    if (braces.length && ch === '{') braces[braces.length - 1]++;
    if (braces.length && ch === '}') braces[braces.length - 1]--;
    out += ch;
    if (!/\s/.test(ch)) last = ch;
    i++;
  }
  return out;
}

const escape = (name) => name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

// References to the module's child_process bindings, aliases included, in
// code outside the import. null when child_process is named any other way
// (a namespace or dynamic import, require), so such a use cannot hide.
export function childProcessUses(source) {
  const code = codeOnly(source);
  const locals = [...code.matchAll(IMPORT)].flatMap((match) => match[1].split(',')
    .map((spec) => spec.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const rest = code.replace(IMPORT, '');
  if (/child_process/.test(rest)) return null;
  return locals.reduce((total, name) => total
    + (rest.match(new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`, 'g')) ?? []).length, 0);
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

test('every reference counts, however it is passed; comments, strings and templates do not', () => {
  const cp = (body, names = 'execFile') => `import { ${names} } from 'node:child_process';\n${body}`;
  assert.equal(childProcessUses(cp("start('x');", 'spawn as start')), 1);
  assert.equal(childProcessUses(cp("start('x');", 'spawn as $start')), 0);
  assert.equal(childProcessUses(cp("$start('x');", 'spawn as $start')), 1);
  assert.equal(childProcessUses(cp('const run = promisify(execFile);\nfunction f({ run = execFile } = {}) {}')), 2);
  assert.equal(childProcessUses(cp('register(execFile, options);\nconst all = [execFile];\nconst r = injected ?? execFile;')), 3);
  assert.equal(childProcessUses(cp('const t = `${execFile}`;')), 1);
  assert.equal(childProcessUses(cp("// execFile('x')\nconst s = 'POST /v0/execFile';\n/* execFile(y) */\nconst t = `execFile`;\nconst r = /execFile/;\nchild.execFile;")), 0);
  assert.equal(childProcessUses("const cp = await import('node:child_process');"), null);
  assert.equal(childProcessUses(cp("execFile();\nconst cp = await import('node:child_process');")), null);
  assert.equal(childProcessUses(cp("execFile();\nconst cp = require('child_process');")), null);
  assert.equal(childProcessUses("const hook = `import { spawnSync } from 'node:child_process';`;"), 0);
});
