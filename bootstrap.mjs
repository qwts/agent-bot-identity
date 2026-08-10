#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig, slugForHarness } from './config.mjs';
import { HARNESSES } from './detect-harness.mjs';
import { reconcileAppCredentials } from './credential-reconciler.mjs';
import { installAgentBot, installationPaths, isManagedExecutable } from './install.mjs';
import { installGhShim } from './install-gh-shim.mjs';

export const BOOTSTRAP_USAGE = `usage: agent-bot bootstrap [options]

Options:
  --config <path>   Install an explicit secret-free config file
  --app <slug>      Restore one App credential (repeatable)
  --with-gh-shim    Install the managed fail-closed gh shim
  --machine-only    Install and verify machine state; do not bind this worktree
  --worktree-only   Bind and verify this linked worktree; do not mutate machine setup
  -h, --help        Show this help
`;

const SOURCE_ENTRYPOINT = fileURLToPath(new URL('./agent-bot', import.meta.url));

export function parseBootstrapArgs(argv = process.argv.slice(2)) {
  const options = {
    apps: [],
    configPath: null,
    help: false,
    phase: 'all',
    withGhShim: false,
  };
  let selectedPhase = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config' || arg === '--app') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--config') {
        if (options.configPath) throw new Error('--config may be passed only once');
        options.configPath = value;
      } else {
        options.apps.push(value);
      }
      index += 1;
    } else if (arg === '--with-gh-shim') {
      options.withGhShim = true;
    } else if (arg === '--machine-only' || arg === '--worktree-only') {
      if (selectedPhase) throw new Error(`${arg} conflicts with ${selectedPhase}`);
      selectedPhase = arg;
      options.phase = arg === '--machine-only' ? 'machine' : 'worktree';
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (
    options.phase === 'worktree'
    && (options.configPath || options.apps.length > 0 || options.withGhShim)
  ) {
    throw new Error('--worktree-only does not accept machine setup options');
  }
  return options;
}

function optionalLstat(path, lstat = lstatSync) {
  try {
    return lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function bootstrapConfigPath(home = homedir()) {
  return join(home, '.config', 'agent-bot', 'config.json');
}

export function installBootstrapConfig({
  sourcePath,
  home = homedir(),
  env = process.env,
  lstat = lstatSync,
  mkdir = mkdirSync,
  rename = renameSync,
  remove = rmSync,
  write = writeFileSync,
} = {}) {
  const destination = bootstrapConfigPath(home);
  if (!sourcePath) {
    return { config: loadConfig({ home, env }), path: destination, updated: false };
  }
  const source = resolve(sourcePath);
  const config = loadConfig({ home, env: { ...env, AGENT_BOT_CONFIG: source } });
  const existing = optionalLstat(destination, lstat);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`${destination} exists and is not a regular agent-bot config file`);
    }
    const current = loadConfig({ home, env: { ...env, AGENT_BOT_CONFIG: destination } });
    if (!isDeepStrictEqual(current, config)) {
      throw new Error(`${destination} conflicts with ${source}; move it aside or reconcile it explicitly`);
    }
    return { config: current, path: destination, updated: false };
  }

  mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    write(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    rename(temporary, destination);
  } catch (error) {
    remove(temporary, { force: true });
    throw error;
  }
  return { config, path: destination, updated: true };
}

export function configuredAppSlugs(config, explicit = []) {
  const slugs = new Set(explicit);
  for (const { key } of HARNESSES) {
    const slug = slugForHarness(key, config);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

export function assertInstalledRuntime({
  executable,
  entrypoint = SOURCE_ENTRYPOINT,
  lstat = lstatSync,
  readlink = readlinkSync,
} = {}) {
  const stat = optionalLstat(executable, lstat);
  if (!isManagedExecutable(executable, stat, entrypoint, readlink)) {
    throw new Error(
      `agent-bot is not installed from this checkout at ${executable}; run bootstrap without --worktree-only first`,
    );
  }
  return executable;
}

function runInstalled(executable, args, { env = process.env } = {}) {
  execFileSync(executable, args, { env, stdio: 'inherit' });
}

export async function bootstrap(options, {
  home = homedir(),
  env = process.env,
  installConfig = installBootstrapConfig,
  installRuntime = installAgentBot,
  installShim = installGhShim,
  reconcileCredentials = reconcileAppCredentials,
  verifyInstalled = assertInstalledRuntime,
  run = runInstalled,
  output = process.stdout,
} = {}) {
  if (options.help) {
    output.write(BOOTSTRAP_USAGE);
    return { help: true, phase: options.phase };
  }

  let executable = installationPaths(home).executable;
  let config = null;
  const credentials = [];

  if (options.phase !== 'worktree') {
    const configResult = installConfig({ sourcePath: options.configPath, home, env });
    config = configResult.config;
    if (options.configPath) {
      output.write(
        `${configResult.updated ? 'config installed' : 'config already current'} -> ${configResult.path}\n`,
      );
    }

    const installed = installRuntime({ home });
    executable = installed.executable;
    output.write(`agent-bot installed -> ${executable}\n`);

    const reconciled = await reconcileCredentials({
      slugs: configuredAppSlugs(config, options.apps),
      home,
    });
    for (const result of reconciled) {
      credentials.push(result);
      const restored = result.local.restored.length > 0
        ? ` (restored ${result.local.restored.join(', ')})`
        : '';
      output.write(`credential ready -> ${result.slug}${restored}\n`);
    }

    if (options.withGhShim) {
      const shim = installShim({ home, env });
      output.write(`gh shim installed -> ${shim.shimPath}\n`);
    }
  } else {
    verifyInstalled({ executable });
  }

  if (options.phase !== 'machine') {
    run(executable, ['setup-worktree'], { env });
  }
  const doctorArgs = ['doctor'];
  if (options.phase === 'machine') doctorArgs.push('--machine-only');
  for (const slug of options.apps) doctorArgs.push('--app', slug);
  run(executable, doctorArgs, { env });
  return { config, credentials, executable, phase: options.phase };
}

export function main(argv = process.argv.slice(2)) {
  return bootstrap(parseBootstrapArgs(argv));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`bootstrap: ${error.message}\n`);
    process.exit(1);
  });
}
