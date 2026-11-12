#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureBlock, zshStartupDir } from './shell-path.mjs';
import { enabledFeaturesFromEnv, parseFeatureList, writeEnabledFeaturesToConfig } from './config.mjs';
import { GIT_HOOK_NAMES } from './identity-format.mjs';
import { ensureDaemonSupervisor, NON_SYSTEMD_BROKER_START, NON_SYSTEMD_DAEMON_START } from './daemon-supervisor.mjs';
import { ensureSpacesCutover } from './spaces-cutover.mjs';
import { ensureClaudeWorktreeAdapter, syncHooks } from './sync-hooks.mjs';
import { installGhShim } from './identity-cli.mjs';
import { personaBlockNotice } from './sandbox.mjs';
import { installWindowsLauncher, readWindowsLauncher } from './windows-cli-launcher.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(ROOT, 'agent-bot');
const SOURCE_HOOKS = join(ROOT, 'hooks');

export function installationPaths(home = homedir()) {
  return {
    binDir: join(home, '.local', 'bin'),
    executable: join(home, '.local', 'bin', 'agent-bot'),
    agentHook: join(home, '.local', 'share', 'agent-bot', 'agent-hook'),
    hooksDir: join(home, '.local', 'share', 'agent-bot', 'hooks'),
  };
}

function optionalLstat(path, lstat = lstatSync) {
  try {
    return lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Runtime files may belong to another user: a Homebrew keg under an
// admin-owned prefix ships them already executable (0755, or 0555 for the
// read-only wrapper), and a non-owner chmod fails with EPERM while changing
// nothing. Only chmod when an executable bit is actually missing.
export function ensureExecutableMode(path, { stat = statSync, chmod = chmodSync } = {}) {
  const mode = stat(path).mode & 0o777;
  if ((mode & 0o111) === 0o111) return false;
  try {
    chmod(path, 0o755);
  } catch (error) {
    if (error?.code === 'EPERM') {
      const refused = new Error(
        `${path} is not executable and is owned by another user; fix its mode as that user`,
        { cause: error },
      );
      refused.code = error.code;
      throw refused;
    }
    throw error;
  }
  return true;
}

const HOMEBREW_AGENT_BOT = /^((?:.*\/)?(?:Cellar\/agent-bot\/[^/]+|opt\/agent-bot))\/(?:bin|libexec)\/agent-bot(?:\.mjs)?$/;

export function isHomebrewAgentBotPath(path) {
  return HOMEBREW_AGENT_BOT.test(String(path).replaceAll('\\', '/'));
}

// The keg's bin/agent-bot is a shell wrapper that execs libexec/agent-bot;
// the runtime files (skills included) live beside the latter, not the wrapper.
// The app that embeds this runtime (ADR-0276): GeniusBar ships agent-bot in
// <App>.app/Contents/Resources/components/agent-bot and runs it on its own
// Node, with no ~/.local/bin entrypoint, git hooks or organization config.
// Returns the .app path, or null for a source checkout or Homebrew keg.
export function embeddingAppBundle(path) {
  const match = String(path).replaceAll('\\', '/').match(/^(.*\.app)\/Contents\/Resources\/components\/agent-bot\/?$/);
  return match ? match[1] : null;
}

export function homebrewRuntimeRoot(path) {
  const match = String(path).replaceAll('\\', '/').match(HOMEBREW_AGENT_BOT);
  return match ? join(match[1], 'libexec') : null;
}

// Brew kegs are versioned. The managed ~/.local/bin symlink must point at
// <prefix>/opt/agent-bot/bin/agent-bot so `brew upgrade` + cleanup cannot
// leave hooks pinned to a deleted Cellar path.
export function homebrewStableEntrypoint(entrypoint, exists = existsSync) {
  const normalized = resolve(entrypoint).replaceAll('\\', '/');
  const match = normalized.match(/^(.*)\/Cellar\/agent-bot\/[^/]+\/libexec\/agent-bot$/);
  if (!match) return null;
  const stable = join(match[1], 'opt', 'agent-bot', 'bin', 'agent-bot');
  return exists(stable) ? stable : null;
}

export function managedEntrypoint(entrypoint, exists = existsSync) {
  return homebrewStableEntrypoint(entrypoint, exists) ?? resolve(entrypoint);
}

export function isManagedExecutable(path, stat, entrypoint, readlink = readlinkSync) {
  if (process.platform === 'win32' && stat?.isFile()) {
    return readWindowsLauncher(path)?.entry === join(dirname(resolve(entrypoint)), 'agent-bot.mjs');
  }
  // The Linux bundle's install.sh writes a wrapper file, not a link;
  // isLinuxBundleWrapper checks the type itself without following a link.
  if (!stat?.isSymbolicLink()) {
    return Boolean(stat) && isLinuxBundleWrapper(path, linuxBundleRoot(dirname(resolve(entrypoint))));
  }
  const linked = readlink(path);
  const target = resolve(dirname(path), linked);
  const current = resolve(entrypoint);
  // `agent-bot.mjs` is the pre-launcher install target. Continue recognizing
  // it so `agent-bot update` can migrate an existing installation in place.
  if (target === current || target === join(dirname(current), 'agent-bot.mjs')) return true;
  // A previous Homebrew keg or the stable opt wrapper is ours to replace
  // when this install is also a Homebrew tree. A checkout must still refuse
  // a foreign same-basename symlink.
  if (
    isHomebrewAgentBotPath(linked)
    || isHomebrewAgentBotPath(target)
  ) {
    return isHomebrewAgentBotPath(current);
  }
  return false;
}

// The host app's "Install command-line tools" (GeniusBar#41) writes
// ~/.local/bin/agent-bot as a small wrapper file, not a symlink, that execs
// the shim inside the app (#968). That file is the app's: it is left in place,
// never replaced or removed. Only the exact text the app's
// bridge/cli-tools.mjs writes counts, and only for the app that embeds this
// runtime, so a checkout or Homebrew install still refuses it. The marker
// carries the app's own name, so no host app is named here (#752).
function hostAppCliToolText(app) {
  const name = basename(app, '.app');
  const shim = join(app, 'Contents', 'Resources', 'bin', 'agent-bot');
  return `#!/bin/sh\n# ${name.toLowerCase()}-cli-tool: written by ${name}. "Uninstall command-line tools" removes it.\n`
    + `exec '${shim.replaceAll("'", `'\\''`)}' "$@"\n`;
}

// One descriptor answers every question: the path is opened once without
// following a link (or blocking on a FIFO), and the type, the size bound and
// the text all come from that handle, so a swap between checking and reading
// cannot change what is judged.
const CLI_TOOL_MAX_BYTES = 4096;

function readSmallRegularFile(path, open) {
  let fd;
  try {
    fd = open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size >= CLI_TOOL_MAX_BYTES) return null;
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function isHostAppCliTool(path, app, { open = openSync } = {}) {
  if (!app) return false;
  return readSmallRegularFile(path, open) === hostAppCliToolText(app);
}

// The headless-Linux bundle (scripts/linux-bundle, ADR-0332) ships this runtime
// as <bundle>/lib/agent-bot beside <bundle>/bin/agent-bot, the entry build.mjs
// writes, and its install.sh writes ~/.local/bin/agent-bot as a marked wrapper
// file, not a symlink, that execs that entry on the bundled Node. That wrapper
// is the bundle's: bootstrap leaves it in place, and uninstall.sh removes it.
// Both markers are pinned against build.mjs and lib/common.sh by the tests.
export const LINUX_BUNDLE_ENTRY_MARKER = '# agent-bot-linux-bundle-entry';
export const LINUX_BUNDLE_WRAPPER_MARKER = '# agent-bot-linux-cli-tool';

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Returns <bundle> when runtimeRoot is a Linux bundle's lib/agent-bot, or null
// for a source checkout, Homebrew keg or app-embedded runtime.
export function linuxBundleRoot(runtimeRoot, { read = readFileSync } = {}) {
  const root = resolve(runtimeRoot);
  if (basename(root) !== 'agent-bot' || basename(dirname(root)) !== 'lib') return null;
  const bundle = dirname(dirname(root));
  try {
    const [shebang, marker] = read(join(bundle, 'bin', 'agent-bot'), 'utf8').split('\n', 2);
    return shebang === '#!/bin/sh' && marker === LINUX_BUNDLE_ENTRY_MARKER ? bundle : null;
  } catch {
    return null;
  }
}

// Only a wrapper bound to this bundle counts: the marker is the ownership
// contract every wrapper install shares, and the root and exec lines tie it
// to this runtime, so a wrapper from another bundle install is still foreign.
// The rest of the text is install.sh's to change between releases.
export function isLinuxBundleWrapper(path, bundle, { open = openSync } = {}) {
  if (!bundle) return false;
  const text = readSmallRegularFile(path, open);
  if (text === null) return false;
  const lines = text.split('\n');
  if (lines[0] !== '#!/bin/sh' || lines[1] !== LINUX_BUNDLE_WRAPPER_MARKER) return false;
  const roots = lines.filter((line) => line.startsWith('AGENT_BOT_BUNDLE_ROOT='));
  if (roots.length !== 1) return false;
  const wrapperRoot = roots[0].slice('AGENT_BOT_BUNDLE_ROOT='.length);
  if (!wrapperRoot.startsWith('/') || canonicalPath(wrapperRoot) !== canonicalPath(bundle)) return false;
  const execs = lines.filter((line) => line.startsWith('exec '));
  const target = execs.length === 1 ? execs[0].match(/^exec "([^"]+)" "\$@"$/u)?.[1] : null;
  return Boolean(target) && canonicalPath(target) === canonicalPath(join(bundle, 'bin', 'agent-bot'));
}

export function inspectExecutableLink(path, stat, { readlink = readlinkSync, statFile = statSync } = {}) {
  if (!stat?.isSymbolicLink()) return null;
  const target = readlink(path);
  const resolvedTarget = resolve(dirname(path), target);
  try {
    statFile(resolvedTarget);
    return { target, resolvedTarget, dangling: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { target, resolvedTarget, dangling: true };
  }
}

export function installExecutable({
  home = homedir(),
  entrypoint = ENTRYPOINT,
  platform = process.platform,
  mkdir = mkdirSync,
  lstat = lstatSync,
  readlink = readlinkSync,
  remove = rmSync,
  symlink = symlinkSync,
  chmod = chmodSync,
  statFile = statSync,
  exists = existsSync,
  mkdtemp = mkdtempSync,
  rename = renameSync,
  openFile = openSync,
  embeddingApp = embeddingAppBundle(ROOT),
  linuxBundle = linuxBundleRoot(dirname(resolve(entrypoint))),
} = {}) {
  const paths = installationPaths(home);
  if (platform === 'win32') {
    const stat = optionalLstat(paths.executable, lstat);
    // Older Windows installs used the same managed symlink as POSIX. Migrate
    // only our runtime's link, and never replace an existing companion command.
    if (stat?.isSymbolicLink() && isManagedExecutable(paths.executable, stat, entrypoint, readlink)) {
      if (optionalLstat(paths.executable + '.cmd', lstat)) {
        throw new Error(`${paths.executable}.cmd exists beside the legacy Windows symlink`);
      }
      remove(paths.executable);
    }
    return installWindowsLauncher(paths.executable, { entrypoint });
  }
  const desired = managedEntrypoint(entrypoint, exists);
  mkdir(paths.binDir, { recursive: true });
  const stat = optionalLstat(paths.executable, lstat);
  // The embedding app's wrapper runs this runtime; it stays the CLI.
  if (stat && isHostAppCliTool(paths.executable, embeddingApp, { open: openFile })) return paths.executable;
  ensureExecutableMode(entrypoint, { stat: statFile, chmod });
  // The Linux bundle's install.sh wrapper runs this runtime on the bundled
  // Node; it stays the CLI, so uninstall.sh still finds what it wrote.
  if (stat && isLinuxBundleWrapper(paths.executable, linuxBundle, { open: openFile })) return paths.executable;
  if (stat) {
    const link = inspectExecutableLink(paths.executable, stat, { readlink, statFile });
    if (link?.dangling) {
      const backupDir = mkdtemp(`${paths.executable}.dangling-backup-`);
      rename(paths.executable, join(backupDir, 'agent-bot'));
    } else {
      if (!isManagedExecutable(paths.executable, stat, entrypoint, readlink)) {
        const target = link ? ` (target: ${link.target}; resolved target: ${link.resolvedTarget})` : '';
        throw new Error(`${paths.executable} exists and is not an agent-bot symlink${target}`);
      }
      if (link.target === desired || link.resolvedTarget === resolve(desired)) return paths.executable;
      remove(paths.executable, { force: true });
    }
  }
  symlink(desired, paths.executable);
  return paths.executable;
}

// Two registrations, because they answer different questions.
//
// .zshenv is read by EVERY zsh, including the non-login non-interactive shells
// a harness spawns for its startup scripts. Without it `command -v agent-bot`
// fails there and the runtime looks uninstalled while its symlink is present —
// hooks that fail closed abort, and hooks that fail open vanish silently.
//
// .zprofile is login-only, but it is appended after Homebrew's shellenv, so it
// is what puts our directory *first* for an interactive session. Dropping it
// would reintroduce the ordering bug; dropping .zshenv leaves every harness
// blind. Both, or neither works.
export function ensureExecutablePath({
  home = homedir(),
  env = process.env,
  platform = process.platform,
  read = readFileSync,
  write = writeFileSync,
  rename = renameSync,
  mkdir = mkdirSync,
  chmod = chmodSync,
  stat = statSync,
  execFile = execFileSync,
} = {}) {
  if (platform === 'win32') {
    const directory = installationPaths(home).binDir;
      const script = '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd(); $old=[Environment]::GetEnvironmentVariable("Path","User"); '
      + '$parts=@($old -split ";" | Where-Object { $_ }); $changed=-not ($parts -icontains $p); '
      + 'if($changed){[Environment]::SetEnvironmentVariable("Path",(($parts + $p) -join ";"),"User")}; [Console]::Out.Write($changed.ToString())';
    const output = execFile(join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: directory, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!['True', 'False'].includes(output.trim())) throw new Error('Windows user PATH registration failed');
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      const current = env[pathKey] ?? '';
      if (!current.split(';').some(part => part.toLowerCase() === directory.toLowerCase())) env[pathKey] = `${directory};${current}`;
    return { path: 'HKCU\\Environment\\Path', updated: output.trim() === 'True' };
  }
  const dir = zshStartupDir(home, env);
  // .zshenv keeps the harness-resolution registration; .zprofile keeps the
  // login ordering one. Both are now managed blocks — reordered to put this
  // directory first without the nested-shell duplication `path` arrays avoid —
  // and both absorb the loose export lines older installs appended. The
  // .zprofile body drops the legacy `# agent-bot installed commands` suffix
  // comment; the marker moved into the block delimiters.
  const zshenv = ensureBlock({
    dir,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: 'typeset -U path PATH\npath=("$HOME/.local/bin" $path)\n',
    absorbMarkers: ['# agent-bot CLI'],
    read,
    write,
    rename,
    mkdir,
    chmod,
    stat,
    execFile,
  });
  const zprofile = ensureBlock({
    dir,
    filename: '.zprofile',
    name: 'agent-bot-cli',
    body: 'typeset -U path PATH\npath=("$HOME/.config/agent-bot/bin" "$HOME/.local/bin" $path)\n',
    absorbMarkers: ['# agent-bot installed commands'],
    read,
    write,
    rename,
    mkdir,
    chmod,
    stat,
    execFile,
  });
  // `updated` answers "did this run change anything", which is what the caller
  // prints. Reporting only .zprofile made an upgrade from the old .zprofile-only
  // install look like a no-op while .zshenv was quietly written.
  return {
    path: zprofile.path,
    updated: zshenv.updated || zprofile.updated,
    zshenv,
    zprofile,
  };
}

function hookWrapper(name) {
  return `#!/bin/sh\n# Managed by agent-bot install.\nexec "\${HOME}/.local/bin/agent-bot" hook ${name} "$@"\n`;
}

export function agentHookFastPath() {
  return `#!/bin/sh
# Managed by agent-bot install.
# Always invoke the runner: built-in identity and confinement guards must run
# even when the checkout has no executable project-specific hooks.
RUNNER=\${AGENT_BOT_BIN:-"$HOME/.local/bin/agent-bot"}
if [ ! -x "$RUNNER" ]; then
  printf '%s\\n' "agent-bot: security hook runner is missing or not executable" >&2
  exit 1
fi
exec "$RUNNER" agent-hook "$@"
`;
}

export function installAgentHook({
  home = homedir(),
  mkdir = mkdirSync,
  write = writeFileSync,
  chmod = chmodSync,
} = {}) {
  const path = installationPaths(home).agentHook;
  mkdir(dirname(path), { recursive: true });
  write(path, agentHookFastPath(), { mode: 0o755 });
  chmod(path, 0o755);
  return path;
}

export function installHookWrappers({
  home = homedir(),
  sourceHooks = SOURCE_HOOKS,
  mkdir = mkdirSync,
  list = readdirSync,
  read = readFileSync,
  write = writeFileSync,
  remove = rmSync,
  chmod = chmodSync,
  statFile = statSync,
} = {}) {
  const hooksDir = installationPaths(home).hooksDir;
  mkdir(hooksDir, { recursive: true });
  const available = new Set(list(sourceHooks));
  const missing = GIT_HOOK_NAMES.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`missing source Git hooks: ${missing.join(', ')}`);
  const hooks = [...GIT_HOOK_NAMES];
  for (const name of list(hooksDir)) {
    if (hooks.includes(name)) continue;
    const stale = join(hooksDir, name);
    let body = '';
    try {
      body = read(stale, 'utf8');
    } catch {
      continue;
    }
    if (body.includes('# Managed by agent-bot install.')) remove(stale, { force: true });
  }
  for (const name of hooks) {
    ensureExecutableMode(join(sourceHooks, name), { stat: statFile, chmod });
    // Refresh existing wrappers as well as first installs, just like shims.
    // write's mode only applies on creation; repair old non-executable files.
    const target = join(hooksDir, name);
    write(target, hookWrapper(name), { mode: 0o755 });
    ensureExecutableMode(target, { stat: statFile, chmod });
  }
  return hooksDir;
}

function getGlobal(run, key) {
  try {
    return run(['config', '--global', '--path', '--get', key]) || null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

export function isAgentBotHooksPath(path, home = homedir()) {
  if (!path) return false;
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized === installationPaths(home).hooksDir.replaceAll('\\', '/') ||
    normalized.endsWith('/agent-bot-identity/hooks') ||
    normalized.endsWith('/tools/agent-bot/hooks')
  );
}

export function parseInstallArgs(argv = process.argv.slice(2)) {
  const options = { withGhShim: false, features: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--with-gh-shim') {
      options.withGhShim = true;
    } else if (arg === '--features') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('--features requires a value');
      options.features = parseFeatureList([...options.features, ...parseFeatureList(val)]);
    } else if (arg.startsWith('--features=')) {
      const val = arg.slice('--features='.length);
      if (!val) throw new Error('--features requires a value');
      options.features = parseFeatureList([...options.features, ...parseFeatureList(val)]);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

export async function installAgentBot({
  home = homedir(),
  env = process.env,
  features = [],
  run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  installCli = installExecutable,
  installAgentHooks = installAgentHook,
  installHooks = installHookWrappers,
  installPath = ensureExecutablePath,
  ensureSupervisor = ensureDaemonSupervisor,
  ensureCutover = ensureSpacesCutover,
  installTranscriptAdapter = ensureClaudeWorktreeAdapter,
  installUserHooks = syncHooks,
  installShim = installGhShim,
  embeddingApp = embeddingAppBundle(ROOT),
} = {}) {
  const requestedFeatures = parseFeatureList([...enabledFeaturesFromEnv(env), ...parseFeatureList(features)]);
  const featureConfig = requestedFeatures.length > 0
    ? writeEnabledFeaturesToConfig({ features: requestedFeatures, home, env })
    : null;
  const executable = installCli({ home, embeddingApp });
  const agentHook = installAgentHooks({ home });
  const pathRegistration = installPath({ home });
  const hooksPath = installHooks({ home });
  const previous = getGlobal(run, 'core.hooksPath');
  const canonicalChain = getGlobal(run, 'agentBot.chainedHooksPath');
  const legacyChain = getGlobal(run, 'qwts.chainedHooksPath');
  let chainedHooksPath = isAgentBotHooksPath(canonicalChain, home) ? null : canonicalChain;
  if (!chainedHooksPath && previous && !isAgentBotHooksPath(previous, home)) {
    chainedHooksPath = previous;
  }
  if (!chainedHooksPath && legacyChain && !isAgentBotHooksPath(legacyChain, home)) {
    chainedHooksPath = legacyChain;
  }
  if (chainedHooksPath) {
    run(['config', '--global', 'agentBot.chainedHooksPath', chainedHooksPath]);
  } else if (canonicalChain) {
    try {
      run(['config', '--global', '--unset-all', 'agentBot.chainedHooksPath']);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  run(['config', '--global', 'core.hooksPath', hooksPath]);
  // An app that embeds this runtime supervises its own daemon under its own
  // label; a second unit from here would run a second daemon (#968).
  const supervisor = embeddingApp
    ? { applied: false, reason: 'app-managed', app: embeddingApp }
    : await ensureSupervisor({ home, env, executable,
      ...(process.platform === 'win32' ? { programArguments: [process.execPath, join(ROOT, 'agent-bot.mjs'), 'daemon', 'run'] } : {}),
    });
  const cutover = ensureCutover({ home, env });
  const transcriptAdapter = installTranscriptAdapter({ home, env });
  const userHooks = installUserHooks({ home, env });
  const ghShim = requestedFeatures.includes('github-identity') && typeof installShim === 'function'
    ? installShim({ home, env })
    : null;
  return {
    executable,
    agentHook,
    hooksPath,
    previous,
    chainedHooksPath,
    pathRegistration,
    supervisor,
    cutover,
    transcriptAdapter,
    userHooks,
    ...(featureConfig ? { featureConfig } : {}),
    ...(ghShim ? { ghShim } : {}),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseInstallArgs(argv);
  const result = await installAgentBot({ features: options.features });
  process.stdout.write(`agent-bot -> ${result.executable}\n`);
  process.stdout.write(`core.hooksPath -> ${result.hooksPath}\n`);
  if (result.featureConfig?.enabled?.length) {
    process.stdout.write(`features enabled -> ${result.featureConfig.enabled.join(', ')}\n`);
  }
  if (result.pathRegistration.updated) {
    process.stdout.write(`PATH line appended to ${result.pathRegistration.path}\n`);
  }
  if (result.chainedHooksPath) {
    process.stdout.write(`chained hooks -> ${result.chainedHooksPath}\n`);
  }
  if (result.transcriptAdapter?.updated) {
    process.stdout.write(`Claude WorktreeCreate adapter -> ${result.transcriptAdapter.evidence.path}\n`);
  }
  if (result.supervisor?.systemdUnavailable) {
    process.stdout.write(
      `daemon supervisor -> ${result.supervisor.unitPath} (systemd --user unavailable; started detached daemon${result.supervisor.pid ? ` pid ${result.supervisor.pid}` : ''})\n`,
    );
    process.stdout.write(`headless fallback -> ${NON_SYSTEMD_DAEMON_START}\n`);
    process.stdout.write(`broker fallback   -> ${NON_SYSTEMD_BROKER_START}\n`);
  } else if (result.supervisor?.applied) {
    process.stdout.write(`daemon supervisor -> ${result.supervisor.unitPath}\n`);
  } else if (result.supervisor?.reason === 'unsupported-platform') {
    process.stdout.write(`daemon supervisor skipped (${result.supervisor.platform})\n`);
  } else if (result.supervisor?.reason === 'app-managed') {
    process.stdout.write(`daemon supervisor skipped (managed by ${basename(result.supervisor.app)})\n`);
  }
  if (result.cutover?.applied) {
    process.stdout.write(
      `spaces cutover -> ${result.cutover.from} -> ${result.cutover.to} (${result.cutover.moved} spaces)\n`,
    );
  }
  if (options.withGhShim && !result.ghShim) {
    execFileSync(result.executable, ['install-gh-shim'], { stdio: 'inherit' });
  }
  // An upgrade can be the first release that refuses on an unrecorded SOP
  // persona mapping (#613); name the repair before the first launch fails.
  const personaNotice = personaBlockNotice();
  if (personaNotice) process.stderr.write(`${personaNotice}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`install: ${error.message}\n`);
    process.exit(1);
  });
}
