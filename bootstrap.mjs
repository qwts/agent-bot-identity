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
import { loadConfig, scopeConfigToApps } from './config.mjs';
import { reconcileAppCredentials } from './credential-reconciler.mjs';
import { installAgentBot, installationPaths, isManagedExecutable } from './install.mjs';
import { installGhShim } from './install-gh-shim.mjs';
import {
  OrganizationProfileError,
  organizationProfileToConfig,
  readOrganizationProfile,
} from './organization-profile.mjs';
import {
  buildReadinessReport,
  collectReadiness,
  configuredAppSlugs,
  readinessCheck,
  renderReadinessJson,
  renderReadinessReport,
  requireReadinessSchema,
} from './readiness.mjs';

export { configuredAppSlugs };

export const BOOTSTRAP_USAGE = `usage:
  ./agent-bot bootstrap [options]  (source checkout)
  agent-bot bootstrap [options]    (installed CLI)

Options:
  --profile <path|->
                    Apply a versioned organization profile from a file or stdin
  --config <path>   Install an explicit secret-free config file; never discovers organization policy
  --app <slug>      Restore one App credential (repeatable)
  --scope-app <slug>
                    Scope this account's roster to the App (repeatable; with --profile)
  --with-gh-shim    Install the managed fail-closed gh shim
  --machine-only    Install and verify machine state; do not bind this worktree
  --worktree-only   Bind and verify this linked worktree; do not mutate machine setup
  --json            Emit readiness schema JSON only
  --require-schema-version <n>
                    Require at least readiness schema version n
  -h, --help        Show this help
`;

const SOURCE_ENTRYPOINT = fileURLToPath(new URL('./agent-bot', import.meta.url));

export function parseBootstrapArgs(argv = process.argv.slice(2)) {
  const options = {
    apps: [],
    configPath: null,
    profilePath: null,
    help: false,
    json: false,
    phase: 'all',
    requireSchemaVersion: null,
    scopeApps: [],
    withGhShim: false,
  };
  let selectedPhase = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === '--profile'
      || arg === '--config'
      || arg === '--app'
      || arg === '--scope-app'
      || arg === '--require-schema-version'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--profile') {
        if (options.profilePath) throw new Error('--profile may be passed only once');
        options.profilePath = value;
      } else if (arg === '--config') {
        if (options.configPath) throw new Error('--config may be passed only once');
        options.configPath = value;
      } else if (arg === '--app') {
        options.apps.push(value);
      } else if (arg === '--scope-app') {
        options.scopeApps.push(value);
      } else {
        if (options.requireSchemaVersion !== null) {
          throw new Error('--require-schema-version may be passed only once');
        }
        options.requireSchemaVersion = Number(value);
      }
      index += 1;
    } else if (arg === '--with-gh-shim') {
      options.withGhShim = true;
    } else if (arg === '--json') {
      options.json = true;
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
  if (options.profilePath && options.configPath) {
    throw new Error('--profile conflicts with --config');
  }
  if (options.scopeApps.length > 0 && !options.profilePath) {
    throw new Error('--scope-app requires --profile');
  }
  if (
    options.phase === 'worktree'
    && (options.profilePath || options.configPath || options.apps.length > 0 || options.withGhShim)
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

function publishBootstrapConfig({
  config,
  sourceDescription,
  conflictCode = null,
  home = homedir(),
  env = process.env,
  lstat = lstatSync,
  mkdir = mkdirSync,
  rename = renameSync,
  remove = rmSync,
  write = writeFileSync,
} = {}) {
  const destination = bootstrapConfigPath(home);
  const existing = optionalLstat(destination, lstat);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      if (conflictCode) {
        throw new OrganizationProfileError(
          conflictCode,
          'installed runtime config conflicts with the organization profile',
        );
      }
      throw new Error(`${destination} exists and is not a regular agent-bot config file`);
    }
    const current = loadConfig({ home, env: { ...env, AGENT_BOT_CONFIG: destination } });
    if (!isDeepStrictEqual(current, config)) {
      if (conflictCode) {
        throw new OrganizationProfileError(
          conflictCode,
          'installed runtime config conflicts with the organization profile',
        );
      }
      throw new Error(
        `${destination} conflicts with ${sourceDescription}; move it aside or reconcile it explicitly`,
      );
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

export function installBootstrapConfig({
  sourcePath,
  home = homedir(),
  env = process.env,
  ...dependencies
} = {}) {
  const destination = bootstrapConfigPath(home);
  if (!sourcePath) {
    return { config: loadConfig({ home, env }), path: destination, updated: false };
  }
  const source = resolve(sourcePath);
  const config = loadConfig({ home, env: { ...env, AGENT_BOT_CONFIG: source } });
  return publishBootstrapConfig({
    config,
    sourceDescription: source,
    home,
    env,
    ...dependencies,
  });
}

export function installBootstrapProfile({
  sourcePath,
  scopeApps = [],
  home = homedir(),
  env = process.env,
  read,
  stdin,
  ...dependencies
} = {}) {
  const profile = readOrganizationProfile({ sourcePath, read, stdin });
  const config = scopeConfigToApps(organizationProfileToConfig(profile), scopeApps);
  const result = publishBootstrapConfig({
    config,
    sourceDescription: 'organization profile',
    conflictCode: 'profile-config-conflict',
    home,
    env,
    ...dependencies,
  });
  return { ...result, profile };
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
  execFileSync(executable, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function safeProfileFailure(error) {
  const code = error instanceof OrganizationProfileError
    ? error.code
    : 'profile-apply-failed';
  const messages = {
    'profile-read-failed': 'bootstrap could not read the organization profile',
    'profile-invalid': 'bootstrap rejected an invalid or incomplete organization profile',
    'profile-schema-unsupported': 'bootstrap does not support the organization profile schema version',
    'profile-runtime-incompatible': 'the organization profile requires a newer runtime interface',
    'profile-config-conflict': 'the organization profile conflicts with the installed runtime config',
    'profile-app-retired': 'bootstrap rejected a roster scope naming an App the organization profile retires',
    'profile-app-unknown': 'bootstrap rejected a roster scope naming an App the organization profile does not list',
  };
  return {
    code: Object.hasOwn(messages, code) ? code : 'profile-apply-failed',
    message: messages[code] ?? 'bootstrap could not apply the organization profile',
  };
}

export async function bootstrap(options, {
  home = homedir(),
  env = process.env,
  installConfig = installBootstrapConfig,
  installProfile = installBootstrapProfile,
  installRuntime = installAgentBot,
  installShim = installGhShim,
  reconcileCredentials = reconcileAppCredentials,
  verifyInstalled = assertInstalledRuntime,
  run = runInstalled,
  collect = collectReadiness,
} = {}) {
  if (options.help) {
    return { help: true, phase: options.phase };
  }

  const scope = options.phase === 'machine'
    ? 'machine'
    : options.phase === 'worktree'
      ? 'worktree'
      : 'all';
  try {
    requireReadinessSchema(options.requireSchemaVersion);
  } catch {
    const check = readinessCheck({
      id: 'runtime.readiness_schema',
      status: 'failed',
      code: 'readiness-schema-unsupported',
      message: 'the installed readiness schema does not satisfy the requested minimum',
      action: 'update agent-bot to a runtime with the required readiness schema',
    });
    return buildReadinessReport({
      command: 'bootstrap',
      scope,
      machineChecks: scope === 'worktree' ? [] : [check],
      worktreeStatus: scope === 'worktree' ? 'not_ready' : 'not_requested',
      worktreeChecks: scope === 'worktree' ? [check] : [],
    });
  }

  let executable = installationPaths(home).executable;
  let config = null;
  let credentialResults = null;
  let credentialSlugs = null;
  let operationFailure = null;
  let reachedCredentialPhase = false;

  const fail = (failureScope, id, code, message, action, evidence = {}) => {
    operationFailure = {
      scope: failureScope,
      check: readinessCheck({ id, status: 'failed', code, message, action, evidence }),
    };
  };

  if (options.phase !== 'worktree') {
    try {
      const configResult = options.profilePath
        ? installProfile({ sourcePath: options.profilePath, scopeApps: options.scopeApps, home, env })
        : installConfig({ sourcePath: options.configPath, home, env });
      config = configResult.config;
    } catch (error) {
      if (options.profilePath) {
        const profileFailure = safeProfileFailure(error);
        fail(
          'machine',
          'bootstrap.profile',
          profileFailure.code,
          profileFailure.message,
          profileFailure.code === 'profile-runtime-incompatible'
            ? 'update agent-bot to a compatible runtime, then retry bootstrap'
            : profileFailure.code === 'profile-config-conflict'
              ? 'reconcile or move aside the installed runtime config, then retry bootstrap'
              : 'obtain a complete compatible secret-free organization profile, then retry bootstrap',
        );
      } else {
        fail(
          'machine',
          'bootstrap.config',
          'config-apply-failed',
          'bootstrap could not apply the secret-free runtime config',
          'resolve the config conflict or permissions, then retry bootstrap',
        );
      }
    }

    if (!operationFailure) {
      try {
        credentialSlugs = configuredAppSlugs(config, options.apps);
      } catch {
        fail(
          'machine',
          'bootstrap.credentials',
          'profile-app-retired',
          'bootstrap rejected an explicitly selected retired App',
          'remove the retired --app selection, then retry bootstrap',
        );
      }
    }

    if (!operationFailure) {
      try {
        const installed = await installRuntime({ home, env });
        executable = installed.executable;
      } catch (error) {
        // The installer's own message names the file and the failed
        // operation; without it the report cannot be acted on.
        fail(
          'machine',
          'bootstrap.runtime',
          'runtime-install-failed',
          'bootstrap could not install the managed CLI and hooks',
          'move conflicting installed files aside or repair permissions, then retry bootstrap',
          {
            error: error?.message ?? String(error),
            error_code: error?.code ?? null,
          },
        );
      }
    }

    if (!operationFailure) {
      reachedCredentialPhase = true;
      try {
        credentialResults = await reconcileCredentials({
          slugs: credentialSlugs,
          home,
        });
      } catch (error) {
        credentialResults = Array.isArray(error?.results) ? error.results : null;
        if (!credentialResults) {
          fail(
            'machine',
            'bootstrap.credentials',
            'credential-reconciliation-failed',
            'bootstrap could not reconcile the configured App credentials',
            'run doctor for secret-free credential diagnostics, then retry bootstrap',
          );
        }
      }
    }

    const credentialsFailed = credentialResults?.some((result) =>
      result.local.status === 'failed' || result.live.status === 'failed');
    if (!operationFailure && !credentialsFailed && options.withGhShim) {
      try {
        installShim({ home, env });
      } catch {
        fail(
          'machine',
          'bootstrap.gh_shim',
          'gh-shim-install-failed',
          'bootstrap could not install the managed fail-closed gh shim',
          'repair the shim target or permissions, then retry bootstrap',
        );
      }
    }
  } else {
    try {
      verifyInstalled({ executable });
    } catch {
      fail(
        'worktree',
        'bootstrap.runtime',
        'installed-runtime-required',
        'worktree-only bootstrap requires the managed runtime to be installed first',
        'run bootstrap without --worktree-only before binding the worktree',
      );
    }
  }

  const credentialsFailed = credentialResults?.some((result) =>
    result.local.status === 'failed' || result.live.status === 'failed');
  if (!operationFailure && !credentialsFailed && options.phase !== 'machine') {
    try {
      run(executable, ['setup-worktree'], { env });
    } catch {
      fail(
        'worktree',
        'bootstrap.worktree',
        'worktree-setup-failed',
        'bootstrap could not bind the current linked worktree identity',
        'run doctor and repair the first reported worktree failure, then retry bootstrap',
      );
    }
  }

  try {
    const report = await collect({
      command: 'bootstrap',
      scope,
      explicitApps: options.apps,
      home,
      env,
      expectedGhShim: options.withGhShim,
      appResults: credentialResults,
      operationFailure,
      verifyApps: options.phase === 'worktree'
        || credentialResults !== null
        || (reachedCredentialPhase && !operationFailure),
    });
    if (scope !== 'machine' && report.worktree.status === 'not_applicable') {
      const check = readinessCheck({
        id: 'bootstrap.worktree',
        status: 'failed',
        code: 'linked-worktree-required',
        message: 'bootstrap cannot bind bot identity in a primary checkout or outside a repository',
        action: 'create or enter a linked agent worktree, then retry bootstrap',
      });
      return buildReadinessReport({
        command: 'bootstrap',
        scope,
        machineChecks: report.machine.checks,
        apps: report.machine.apps,
        worktreeStatus: 'not_ready',
        worktreeChecks: [check, ...report.worktree.checks],
      });
    }
    return report;
  } catch {
    const check = readinessCheck({
      id: 'bootstrap.verification',
      status: 'failed',
      code: 'readiness-collection-failed',
      message: 'bootstrap completed its ordered operations but readiness could not be collected safely',
      action: 'run agent-bot doctor separately and repair its first reported failure',
    });
    return buildReadinessReport({
      command: 'bootstrap',
      scope,
      machineChecks: scope === 'worktree' ? [] : [check],
      worktreeStatus: scope === 'worktree' ? 'not_ready' : 'not_requested',
      worktreeChecks: scope === 'worktree' ? [check] : [],
    });
  }
}

export async function main(
  argv = process.argv.slice(2),
  { output = process.stdout, runBootstrap = bootstrap } = {},
) {
  const options = parseBootstrapArgs(argv);
  if (options.help) {
    output.write(BOOTSTRAP_USAGE);
    return { help: true };
  }
  const report = await runBootstrap(options);
  output.write(options.json ? renderReadinessJson(report) : renderReadinessReport(report));
  process.exitCode = report.ready ? 0 : 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`bootstrap: ${error.message}\n`);
    process.exit(1);
  });
}
