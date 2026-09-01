import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAgentSpace, resolveSpacesHome } from './agent-space.mjs';
import { listSouls, populationFile } from './agent-population.mjs';
import { inspectSpacesCutover } from './spaces-cutover.mjs';
import { apiBase, loadConfig, rosterScope, slugForHarness } from './config.mjs';
import { inspectAppCredentials } from './credential-reconciler.mjs';
import { detectHarness, HARNESSES } from './detect-harness.mjs';
import { GIT_HOOK_NAMES } from './git-hooks.mjs';
import { CANONICAL_EVENTS, DIALECTS, vendorEvent } from './hook-dialects.mjs';
import { daemonStatus } from './agent-daemon.mjs';
import { inspectSupervisor, supervisorSkipLoad } from './daemon-supervisor.mjs';
import { homebrewRuntimeRoot, installationPaths, isManagedExecutable } from './install.mjs';
import { inspectConfiguredCodexDesktopGh, inspectShellGhShim } from './install-gh-shim.mjs';
import {
  OrganizationProfileError,
  profileAppSlugs,
  profileStatusForSlug,
  runtimeProfileInfo,
} from './organization-profile.mjs';
import {
  AGENT_ID_KEYS,
  pinnedSlug,
  readGitConfig,
  resolveAgentSlug,
  territoryHarness,
} from './resolve-agent.mjs';
import { credentialHelperCommand } from './setup-worktree.mjs';
import { parseUnmanagedAuthors } from './uninstalled-identity-hook.mjs';

export const READINESS_SCHEMA_VERSION = 1;
const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ENTRYPOINT = join(ROOT, 'agent-bot');
const SKILL_FILES = [
  'skills/agent-bot/SKILL.md',
  'skills/agent-bot/references/operations.md',
  'skills/agent-bot/references/verified-publish.md',
  'skills/agent-bot/references/execution-identities.md',
  'skills/agent-bot/references/storage-surfaces.md',
];
const APP_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export function readinessCheck({
  id,
  status,
  code = null,
  message,
  action = null,
  evidence = {},
}) {
  return { id, status, code, message, action, evidence };
}

export function configuredAppSlugs(config, explicit = []) {
  if (explicit.some((slug) => profileStatusForSlug(slug, config) === 'retired')) {
    throw new OrganizationProfileError(
      'profile-app-retired',
      'an explicitly selected App is retired by the installed organization profile',
    );
  }
  // A scoped account's roster is exactly its scope: harness mappings and
  // the rest of the profile roster belong to other accounts' homes. An
  // explicit App outside the scope, or a scoped App the profile has since
  // retired, fails closed rather than widening the roster.
  const scope = rosterScope(config);
  if (scope) {
    if (explicit.some((slug) => !scope.includes(slug))) {
      throw new OrganizationProfileError(
        'app-out-of-scope',
        'an explicitly selected App is outside this account\'s roster scope',
      );
    }
    if (scope.some((slug) => profileStatusForSlug(slug, config) === 'retired')) {
      throw new OrganizationProfileError(
        'profile-app-retired',
        'a scoped App is retired by the installed organization profile',
      );
    }
    return scope;
  }
  const slugs = new Set([...profileAppSlugs(config), ...explicit]);
  for (const { key } of HARNESSES) {
    const slug = slugForHarness(key, config);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

function organizationProfileCheck(config) {
  const info = runtimeProfileInfo(config);
  if (!info) {
    return readinessCheck({
      id: 'config.profile',
      status: 'warning',
      code: 'profile-not-installed',
      message: 'runtime config was not projected from a versioned organization profile',
      action: 'run bootstrap with: --profile <path>',
      evidence: { source: 'runtime-config' },
    });
  }
  return readinessCheck({
    id: 'config.profile',
    status: 'ready',
    message: `organization profile ${info.organization} schema v${info.schemaVersion}`,
    evidence: {
      source: 'organization-profile',
      organization: info.organization,
      account_owner: info.accountOwner,
      profile_schema_version: info.schemaVersion,
      runtime_interface_version: info.minimumRuntimeInterfaceVersion,
      active_apps: info.active.length,
      retired_apps: info.retired.length,
    },
  });
}

export function hookCoverage(today = new Date()) {
  return DIALECTS.map((row) => {
    const events = row.key === 'git'
      ? ['pre-commit', 'pre-push']
      : CANONICAL_EVENTS.filter((event) => !['pre-commit', 'pre-push'].includes(event));
    const covered = events.filter((event) => vendorEvent(row.key, event)).length;
    const verified = new Date(`${row.verifiedOn}T00:00:00Z`);
    const ageDays = Math.floor((today.getTime() - verified.getTime()) / 86_400_000);
    return {
      key: row.key,
      label: [row.key, ...(row.alsoServes ?? [])].join(' + '),
      covered,
      total: events.length,
      status: row.status,
      verifiedOn: row.verifiedOn,
      stale: ageDays > 90,
    };
  });
}

function runGit(args, { cwd = process.cwd(), env = process.env } = {}) {
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/[\r\n]+$/, '');
}

function optionalLstat(path, lstat = lstatSync) {
  try {
    return lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function nodeCheck(nodeVersion = process.version) {
  const major = Number(/^v(\d+)/.exec(nodeVersion)?.[1]);
  if (Number.isInteger(major) && major >= 20) {
    return readinessCheck({
      id: 'runtime.node',
      status: 'ready',
      message: `node ${nodeVersion}`,
      evidence: { version: nodeVersion, minimum_major: 20 },
    });
  }
  return readinessCheck({
    id: 'runtime.node',
    status: 'failed',
    code: 'node-version-unsupported',
    message: `node ${nodeVersion} is unsupported`,
    action: 'install Node 20 or newer, then retry',
    evidence: { version: nodeVersion, minimum_major: 20 },
  });
}

function gitCheck({ cwd, env, git }) {
  try {
    const version = git(['--version'], { cwd, env });
    return readinessCheck({
      id: 'runtime.git',
      status: 'ready',
      message: version,
      evidence: { version },
    });
  } catch {
    return readinessCheck({
      id: 'runtime.git',
      status: 'failed',
      code: 'git-not-found',
      message: 'git not found on PATH',
      action: 'install Git or repair PATH for the environment that runs agent-bot',
    });
  }
}

function supervisorCheck({ home, env, inspect }) {
  const info = inspect({ home, env });
  if (!info.supported) {
    return readinessCheck({
      id: 'daemon.supervisor',
      status: 'warning',
      code: 'supervisor-unsupported',
      message: `no user-level supervisor on ${info.platform}; start the daemon with: agent-bot daemon start`,
      evidence: { platform: info.platform, supported: false },
    });
  }
  if (!info.applied || !info.loaded) {
    return readinessCheck({
      id: 'daemon.supervisor',
      status: 'failed',
      code: info.applied ? 'supervisor-not-loaded' : 'supervisor-not-applied',
      message: info.applied
        ? 'the identity daemon supervisor unit is present but not loaded'
        : 'the identity daemon supervisor is not installed',
      action: 'run: agent-bot install',
      evidence: {
        platform: info.platform,
        kind: info.kind,
        applied: info.applied,
        loaded: info.loaded,
      },
    });
  }
  return readinessCheck({
    id: 'daemon.supervisor',
    status: 'ready',
    message: `identity daemon supervisor loaded (${info.kind})`,
    evidence: {
      platform: info.platform,
      kind: info.kind,
      applied: true,
      loaded: true,
    },
  });
}

async function daemonHealthCheck({ home, env, probe, skipLoad }) {
  const status = await probe({ home, env });
  if (status.running) {
    return readinessCheck({
      id: 'daemon.health',
      status: 'ready',
      message: `identity daemon running (pid ${status.pid}, port ${status.port})`,
      evidence: {
        running: true,
        pid: status.pid,
        port: status.port,
        started_at: status.startedAt,
      },
    });
  }
  if (skipLoad) {
    return readinessCheck({
      id: 'daemon.health',
      status: 'warning',
      code: 'daemon-load-skipped',
      message: 'supervisor unit written; OS load skipped in this environment',
      evidence: { running: false },
    });
  }
  return readinessCheck({
    id: 'daemon.health',
    status: 'failed',
    code: 'daemon-not-running',
    message: 'identity daemon is not running',
    action: 'run: agent-bot install',
    evidence: { running: false },
  });
}

function pathIsInside(root, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const from = resolve(root);
  const target = resolve(candidate);
  return target === from || target.startsWith(`${from}/`) || target.startsWith(`${from}\\`);
}

function spacesRootCheck({ home, env, config }) {
  const resolution = resolveSpacesHome({ home, env, config });
  return readinessCheck({
    id: 'spaces.root',
    status: 'ready',
    message: `Agent Space root ${resolution.root}`,
    evidence: { root: resolution.root, source: resolution.source },
  });
}

function spacesHomeCheck({ home, env, config, inspectCutover = inspectSpacesCutover }) {
  let inspection;
  try {
    inspection = inspectCutover({ home, env, config });
  } catch {
    return readinessCheck({
      id: 'spaces.home',
      status: 'failed',
      code: 'spaces-cutover-unreadable',
      message: 'the Agent Space cutover record could not be read',
      action: 'inspect spaces-cutover.json and repair it manually; doctor will not modify it',
    });
  }
  if (inspection.conflict) {
    return readinessCheck({
      id: 'spaces.home',
      status: 'failed',
      code: 'spaces-cutover-conflict',
      message: 'legacy and default Agent Space roots both hold spaces',
      action: 'set AGENT_BOT_SPACES_HOME or settings.spacesRoot to the root you want to keep',
      evidence: { conflict: true },
    });
  }
  const file = populationFile({ home, env });
  let souls = [];
  try {
    souls = listSouls({ file }).filter((soul) => soul.status !== 'retired');
  } catch {
    return readinessCheck({
      id: 'spaces.home',
      status: 'failed',
      code: 'spaces-census-unreadable',
      message: 'the population census could not be read',
      action: 'inspect population.json and repair it manually; doctor will not modify it',
    });
  }
  const mismatches = souls.filter((soul) => !pathIsInside(inspection.resolvedRoot, soul.spacePath));
  if (mismatches.length) {
    return readinessCheck({
      id: 'spaces.home',
      status: 'failed',
      code: 'spaces-census-mismatch',
      message: 'population census space paths are not under the resolved Agent Space root',
      action: inspection.override
        ? 'choose a root explicitly; changing an override does not migrate spaces'
        : 'run: agent-bot update',
      evidence: { mismatched: mismatches.length },
    });
  }
  return readinessCheck({
    id: 'spaces.home',
    status: 'ready',
    message: 'Agent Space home agrees with the census',
    evidence: { root: inspection.resolvedRoot, source: inspection.source },
  });
}

function identityClassCheck({ home, env, access }) {
  const hook = env.AGENT_BOT_HOOK_BIN || installationPaths(home).agentHook;
  try {
    access(hook, constants.X_OK);
    return readinessCheck({
      id: 'identity.class',
      status: 'ready',
      message: 'durable host: installed identity hook is present',
      evidence: { class: 'durable' },
    });
  } catch {
    return readinessCheck({
      id: 'identity.class',
      status: 'warning',
      code: 'identity-uninstalled',
      message: 'uninstalled or ephemeral session: committed hooks refuse human-attributed commits and GitHub writes unless the actor is an unmanaged allowlisted author',
      action: 'on a host you will keep, run the source checkout bootstrap',
      evidence: {
        class: 'uninstalled',
        unmanaged_authors: parseUnmanagedAuthors({
          AGENT_BOT_UNMANAGED_AUTHORS: env.AGENT_BOT_UNMANAGED_AUTHORS === undefined
            ? 'ai9d'
            : env.AGENT_BOT_UNMANAGED_AUTHORS,
        }),
      },
    });
  }
}

function installedCliCheck({ home, lstat, readlink }) {
  const paths = installationPaths(home);
  let stat;
  try {
    stat = optionalLstat(paths.executable, lstat);
  } catch {
    return readinessCheck({
      id: 'runtime.installed_cli',
      status: 'failed',
      code: 'installed-cli-unreadable',
      message: 'the installed agent-bot entrypoint could not be inspected',
      action: 'run: agent-bot bootstrap --machine-only',
    });
  }
  if (!stat) {
    return readinessCheck({
      id: 'runtime.installed_cli',
      status: 'failed',
      code: 'installed-cli-missing',
      message: 'agent-bot is not installed',
      action: 'run the source checkout bootstrap with --machine-only',
    });
  }
  if (!isManagedExecutable(paths.executable, stat, SOURCE_ENTRYPOINT, readlink)) {
    return readinessCheck({
      id: 'runtime.installed_cli',
      status: 'failed',
      code: 'installed-cli-unmanaged',
      message: 'the installed agent-bot entrypoint is not managed by this checkout',
      action: 'move the foreign entrypoint aside, then run the source checkout bootstrap',
    });
  }
  return readinessCheck({
    id: 'runtime.installed_cli',
    status: 'ready',
    message: `agent-bot -> ${paths.executable}`,
    evidence: { managed: true },
  });
}

function shellPathCheck({ home, env, spawn }) {
  const probeEnv = { HOME: home, PATH: '/usr/bin:/bin' };
  if (env.ZDOTDIR) probeEnv.ZDOTDIR = env.ZDOTDIR;
  const probe = spawn('zsh', ['-c', 'command -v agent-bot'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: probeEnv,
  });
  if (probe.error?.code === 'ENOENT') {
    return readinessCheck({
      id: 'runtime.harness_path',
      status: 'warning',
      code: 'zsh-not-found',
      message: 'zsh not present — harness PATH probe skipped',
    });
  }
  const resolved = (probe.stdout ?? '').trim().split('\n').pop()?.trim();
  if (probe.status === 0 && resolved) {
    return readinessCheck({
      id: 'runtime.harness_path',
      status: 'ready',
      message: `harness shells resolve agent-bot -> ${resolved}`,
      evidence: { resolves: true },
    });
  }
  return readinessCheck({
    id: 'runtime.harness_path',
    status: 'failed',
    code: 'harness-path-missing',
    message: 'agent-bot is not on PATH for non-login harness shells',
    action: 'run: agent-bot bootstrap --machine-only',
  });
}

function configCheck({ config, detectedHarness, mappings }) {
  if (Object.keys(config).length === 0) {
    return readinessCheck({
      id: 'config.runtime',
      status: 'failed',
      code: 'config-missing',
      message: 'no agent-bot config is installed; the runtime is inert',
      action: 'run bootstrap with the organization secret-free config/profile',
      evidence: { source: 'runtime-config', harness: detectedHarness, mappings },
    });
  }
  if (mappings.length === 0) {
    return readinessCheck({
      id: 'config.runtime',
      status: 'failed',
      code: 'config-roster-empty',
      message: 'config resolves no harness to an App slug',
      action: 'set a prefix or harness App mappings in the config and retry',
      evidence: { source: 'runtime-config', harness: detectedHarness, mappings },
    });
  }
  const scope = rosterScope(config);
  return readinessCheck({
    id: 'config.runtime',
    status: 'ready',
    message: `config loaded (${mappings.length} harness mapping${mappings.length === 1 ? '' : 's'}`
      + (scope ? `, roster scoped to ${scope.length} App${scope.length === 1 ? '' : 's'})` : ')'),
    evidence: {
      source: 'runtime-config',
      harness: detectedHarness,
      mappings,
      api_base: safeApiBase(config),
      ...(scope ? { scope } : {}),
    },
  });
}

function safeApiBase(config) {
  try {
    const parsed = new URL(apiBase(config));
    return parsed.origin;
  } catch {
    return null;
  }
}

function failedConfigCheck() {
  return readinessCheck({
    id: 'config.runtime',
    status: 'failed',
    code: 'config-invalid',
    message: 'agent-bot config is present but invalid or unreadable',
    action: 'repair the secret-free runtime config, then retry',
    evidence: { source: 'runtime-config', mappings: [] },
  });
}

function hooksCheck({ home, cwd, env, git, access }) {
  const paths = installationPaths(home);
  let configured = '';
  try {
    configured = git(['config', '--global', '--get', 'core.hooksPath'], { cwd, env });
  } catch {
    /* unset */
  }
  if (configured !== paths.hooksDir) {
    return readinessCheck({
      id: 'hooks.installation',
      status: 'failed',
      code: configured ? 'hooks-path-mismatch' : 'hooks-path-missing',
      message: configured
        ? 'global core.hooksPath does not select the installed agent-bot hooks'
        : 'global core.hooksPath is not configured',
      action: 'run: agent-bot bootstrap --machine-only',
    });
  }
  try {
    for (const name of GIT_HOOK_NAMES) access(join(paths.hooksDir, name), constants.X_OK);
    access(paths.agentHook, constants.X_OK);
  } catch {
    return readinessCheck({
      id: 'hooks.installation',
      status: 'failed',
      code: 'hooks-incomplete',
      message: 'one or more installed agent-bot hook entrypoints are missing or not executable',
      action: 'run: agent-bot bootstrap --machine-only',
    });
  }
  return readinessCheck({
    id: 'hooks.installation',
    status: 'ready',
    message: 'installed Git hooks and agent-hook fast path are ready',
    evidence: { hook_count: GIT_HOOK_NAMES.length },
  });
}

function coverageCheck(now) {
  const rows = hookCoverage(now);
  const warning = rows.some((row) => row.status !== 'verified' || row.stale);
  return readinessCheck({
    id: 'hooks.coverage',
    status: warning ? 'warning' : 'ready',
    code: warning ? 'hook-coverage-unverified' : null,
    message: warning
      ? 'one or more harness hook dialects are unverified or stale'
      : 'harness hook coverage is current',
    evidence: { dialects: rows },
  });
}

function ghShimCheck({ home, required, inspect }) {
  const result = inspect({ home });
  if (result.status === 'ready') {
    return readinessCheck({
      id: 'shim.gh',
      status: 'ready',
      message: 'managed fail-closed gh shim is installed',
      evidence: { ...result.evidence, installed: true, required },
    });
  }
  return readinessCheck({
    id: 'shim.gh',
    status: required || result.status !== 'missing' ? 'failed' : 'warning',
    code: result.code,
    message: result.status === 'missing'
      ? `gh shim is not installed${required ? '' : ' (optional)'}`
      : `managed gh shell shim is ${result.status}`,
    action: required || result.status !== 'missing' ? 'run: agent-bot install-gh-shim' : null,
    evidence: { ...result.evidence, installed: false, required },
  });
}

function codexDesktopGhCheck({ home, inspect }) {
  const result = inspect({ home });
  if (result.status === 'ready') {
    return readinessCheck({
      id: 'shim.gh_codex_desktop',
      status: 'ready',
      message: 'Codex desktop gh interposition is ready',
      evidence: result.evidence,
    });
  }
  if (result.status === 'unconfigured') {
    return readinessCheck({
      id: 'shim.gh_codex_desktop',
      status: 'warning',
      code: result.code,
      message: 'Codex desktop gh interposition is not configured (optional)',
      evidence: result.evidence,
    });
  }
  const messages = {
    missing: 'the configured Codex desktop gh path is missing',
    replaced: 'the configured Codex desktop gh interposer was replaced',
    recursive: 'the configured Codex desktop gh backup chain is recursive',
    'legacy-backup': 'the configured Codex desktop gh interposer still uses legacy gh.bak',
    'legacy-ambiguous': 'the configured Codex desktop gh path has an unowned legacy gh.bak',
    unrecoverable: 'the configured Codex desktop gh interposer is unrecoverable',
  };
  return readinessCheck({
    id: 'shim.gh_codex_desktop',
    status: 'failed',
    code: result.code,
    message: messages[result.status] ?? 'Codex desktop gh interposition is invalid',
    action: result.status === 'unrecoverable'
      ? 'restore the stock gh path manually, then explicitly reinstall the desktop interposer'
      : 'run: agent-bot install-gh-shim --codex-desktop-gh <configured-gh-path>',
    evidence: result.evidence,
  });
}

function runtimeSkillCheck({ home, lstat, readlink, access }) {
  const executable = installationPaths(home).executable;
  let runtimeRoot = null;
  try {
    const stat = optionalLstat(executable, lstat);
    if (stat?.isSymbolicLink()) {
      const target = resolve(dirname(executable), readlink(executable));
      runtimeRoot = homebrewRuntimeRoot(target) ?? dirname(target);
    }
  } catch {
    /* reported as an incomplete installed bundle below */
  }
  try {
    if (!runtimeRoot) throw new Error('installed runtime root unavailable');
    for (const relative of SKILL_FILES) access(join(runtimeRoot, relative), constants.R_OK);
  } catch {
    return readinessCheck({
      id: 'skill.runtime',
      status: 'failed',
      code: 'runtime-skill-incomplete',
      message: 'the runtime-owned agent-bot skill bundle is incomplete',
      action: 'restore the checkout from the reviewed release, then rerun bootstrap',
    });
  }
  return readinessCheck({
    id: 'skill.runtime',
    status: 'ready',
    message: 'runtime-owned agent-bot skill bundle is ready',
    evidence: { file_count: SKILL_FILES.length },
  });
}

function appCheck(id, source) {
  const status = source.status === 'ready' || source.status === 'restored'
    ? 'ready'
    : source.status === 'failed'
      ? 'failed'
      : 'skipped';
  const evidence = { ...(source.evidence ?? {}) };
  if (source.restored) evidence.restored = [...source.restored];
  if (Number.isSafeInteger(source.installationId) && source.installationId > 0) {
    evidence.installation_id = source.installationId;
  }
  if (
    typeof source.expiresAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(source.expiresAt)
  ) {
    evidence.expires_at = source.expiresAt;
  }
  return readinessCheck({
    id,
    status,
    code: source.code ?? (status === 'skipped' ? 'local-roster-incomplete' : null),
    message: status === 'ready'
      ? (id === 'credential.local'
        ? source.status === 'restored'
          ? 'local credential was restored and validated'
          : 'local credential is valid'
        : 'live App mint succeeded')
      : status === 'failed'
        ? (id === 'credential.local'
          ? (source.code === 'provider-session-required' || source.code === 'provider-locked'
            ? 'secret store is locked or has no session'
            : source.code === 'provider-unavailable'
              ? 'secret store CLI is not installed'
              : 'local credential is incomplete or malformed')
          : 'live App mint failed')
        : source.code === 'verification-not-run'
          ? 'live App mint was not run after an earlier bootstrap failure'
          : 'live App mint skipped because the local roster is incomplete',
    action: source.action ?? null,
    evidence,
  });
}

function appReports(results) {
  return [...results]
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map((result) => ({
      slug: result.slug,
      credential: appCheck('credential.local', result.local),
      live_mint: appCheck('credential.live_mint', result.live),
    }));
}

function resultRosterMatches(results, roster) {
  if (!Array.isArray(results)) return false;
  const resultSlugs = results.map((result) => result?.slug);
  if (resultSlugs.some((slug) => typeof slug !== 'string' || !APP_SLUG_RE.test(slug))) return false;
  const normalized = [...new Set(resultSlugs)].sort();
  return normalized.length === results.length
    && normalized.length === roster.length
    && normalized.every((slug, index) => slug === roster[index]);
}

// Reduce a failed git invocation to a secret-free code: an exit status, an
// errno name (EAGAIN, ENOMEM, ENOENT — the transient spawn failures parallel
// load produces), or a signal name. Never stderr, messages, or paths.
function safeGitErrorCode(error) {
  const cause = error?.cause ?? error;
  if (Number.isInteger(cause?.status)) return `exit-${cause.status}`;
  if (typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(cause.code)) return cause.code;
  if (typeof cause?.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(cause.signal)) return cause.signal;
  return 'unknown';
}

// A probe distinguishes three answers the old getGit collapsed into one:
// a value, a deterministic absence (the exit statuses git documents for
// "not set" / "no such remote"), and an abnormal failure — which returns a
// safe error code so the dependent check can fail closed *and* say why.
function gitProbe(git, cwd, env) {
  return (args, { absentStatuses = [1] } = {}) => {
    try {
      return { value: git(args, { cwd, env }), error: null };
    } catch (error) {
      if (absentStatuses.includes(error?.status)) return { value: null, error: null };
      return { value: null, error: safeGitErrorCode(error) };
    }
  };
}

function unreadableCheck(id, code, gitError) {
  return readinessCheck({
    id,
    status: 'failed',
    code,
    message: 'a Git probe for this check failed abnormally; the state could not be verified',
    action: 'rerun doctor; if this persists, inspect Git and system load',
    evidence: { git_error: gitError },
  });
}

export function credentialHelperSequenceReady(helpers, expectedHelper) {
  if (!expectedHelper || helpers.length !== 2 || helpers[0] !== '') return false;
  return helpers[1].replaceAll('\\', '/') === expectedHelper.replaceAll('\\', '/');
}

function isSshRemote(value) {
  return /^(?:ssh:\/\/)?[^/@\s]+@[^:/\s]+[:/]/.test(value ?? '');
}

function isHttpsRemote(value) {
  return /^https:\/\//i.test(value ?? '');
}

function worktreeChecks({ cwd, env, home, config, git, inspectSpace }) {
  let gitDir;
  let commonDir;
  try {
    gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd, env });
    commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env });
  } catch {
    return {
      status: 'not_applicable',
      checks: [readinessCheck({
        id: 'worktree.kind',
        status: 'warning',
        code: 'not-a-repository',
        message: 'not inside a Git repository — worktree checks skipped',
      })],
    };
  }
  if (resolve(gitDir) === resolve(commonDir)) {
    return {
      status: 'not_applicable',
      checks: [readinessCheck({
        id: 'worktree.kind',
        status: 'warning',
        code: 'primary-checkout',
        message: 'primary checkout — bot identity is not applied (by design)',
      })],
    };
  }

  const checks = [readinessCheck({
    id: 'worktree.kind',
    status: 'ready',
    message: 'linked worktree',
  })];
  // Every subprocess in this probe — including the pin reads inside
  // resolve-agent.mjs — must run through the injected runner with the caller's
  // env. Mixing in ambient process.env lets a host's injected GIT_CONFIG_*
  // pairs or global config answer for the worktree being probed.
  const run = (args, { cwd: probeCwd = cwd } = {}) => git(args, { cwd: probeCwd, env });
  const probe = gitProbe(git, cwd, env);
  let slug = null;
  let slugFailed = false;
  try {
    slug = resolveAgentSlug({ env, cwd, config, worktree: true, git: run });
  } catch (error) {
    slugFailed = true;
    checks.push(readinessCheck({
      id: 'worktree.app',
      status: 'failed',
      code: 'worktree-app-unreadable',
      message: 'the worktree App identity could not be resolved safely',
      action: 'repair the worktree App pin, then run: agent-bot setup-worktree',
      evidence: { git_error: safeGitErrorCode(error) },
    }));
  }
  if (!slug) {
    if (!slugFailed) {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'failed',
        code: 'worktree-app-missing',
        message: 'linked worktree has no resolved App identity',
        action: 'run: agent-bot setup-worktree <app-slug>',
      }));
    }
  } else {
    let pin = null;
    let pinError = null;
    try {
      pin = pinnedSlug(cwd, { git: run });
    } catch (error) {
      pinError = safeGitErrorCode(error);
    }
    const territory = territoryHarness(cwd);
    if (pinError) {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'failed',
        code: 'worktree-pin-unreadable',
        message: 'the worktree App pin could not be read',
        action: 'rerun doctor; if this persists, repair the worktree App pin',
        evidence: { app_slug: slug, territory, git_error: pinError },
      }));
    } else if (pin !== slug) {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'failed',
        code: pin ? 'worktree-app-mismatch' : 'worktree-app-unpinned',
        message: 'worktree App identity is not pinned to the resolved App',
        action: 'run: agent-bot setup-worktree',
        evidence: { app_slug: slug, territory },
      }));
    } else {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'ready',
        message: `App identity ${slug}`,
        evidence: { app_slug: slug, territory },
      }));
    }
  }

  const name = probe(['config', '--worktree', '--get', 'user.name']);
  const email = probe(['config', '--worktree', '--get', 'user.email']);
  const attributionError = name.error ?? email.error;
  const escapedSlug = slug?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identityReady = !attributionError
    && slug
    && name.value === `${slug}[bot]`
    && new RegExp(`^\\d+\\+${escapedSlug}\\[bot\\]@users\\.noreply\\.`).test(email.value ?? '');
  checks.push(attributionError
    ? unreadableCheck('worktree.attribution', 'worktree-attribution-unreadable', attributionError)
    : readinessCheck({
      id: 'worktree.attribution',
      status: identityReady ? 'ready' : 'failed',
      code: identityReady ? null : 'worktree-attribution-mismatch',
      message: identityReady ? `configured as ${name.value}` : 'worktree bot author or email is missing or mismatched',
      action: identityReady ? null : 'run: agent-bot setup-worktree',
      evidence: identityReady ? { app_slug: slug } : {},
    }));

  let agentId = null;
  let agentIdError = null;
  try {
    agentId = readGitConfig(cwd, AGENT_ID_KEYS, { git: run });
  } catch (error) {
    agentIdError = safeGitErrorCode(error);
  }
  if (agentIdError) {
    checks.push(unreadableCheck('worktree.agent_id', 'agent-id-unreadable', agentIdError));
  } else if (!agentId) {
    checks.push(readinessCheck({
      id: 'worktree.agent_id',
      status: 'failed',
      code: 'agent-id-missing',
      message: 'no Agent ID is pinned to the worktree',
      action: 'run: agent-bot setup-worktree',
    }));
  } else {
    let space;
    try {
      space = inspectSpace(agentId, { env, home, config });
      checks.push(readinessCheck({
        id: 'worktree.agent_id',
        status: 'ready',
        message: `Agent ID ${agentId}`,
        evidence: { agent_id: agentId },
      }));
    } catch {
      checks.push(readinessCheck({
        id: 'worktree.agent_id',
        status: 'failed',
        code: 'agent-id-invalid',
        message: 'pinned Agent ID is invalid',
        action: 'run setup-worktree to bind a valid execution identity',
      }));
    }
    if (space) {
      if (space.status === 'ok') {
        checks.push(readinessCheck({
          id: 'worktree.agent_space',
          status: 'ready',
          message: `Agent Space ${space.path}`,
          evidence: { agent_id: agentId },
        }));
      } else if (space.status === 'missing') {
        checks.push(readinessCheck({
          id: 'worktree.agent_space',
          status: 'failed',
          code: 'agent-space-missing',
          message: `no Agent Space marker for ${agentId} at ${space.path}`,
          action: space.directoryPresent
            ? 'move the unmarked directory aside, then run: agent-bot space init'
            : 'run: agent-bot space init   (or re-run: agent-bot setup-worktree)',
        }));
      } else if (space.status === 'mismatch') {
        checks.push(readinessCheck({
          id: 'worktree.agent_space',
          status: 'failed',
          code: 'agent-space-mismatch',
          message: `Agent Space at ${space.path} is bound to ${space.boundTo}, not ${agentId}`,
          action: 'inspect the space and resolve the ownership conflict; doctor will not rebind it',
        }));
      } else {
        checks.push(readinessCheck({
          id: 'worktree.agent_space',
          status: 'failed',
          code: 'agent-space-invalid',
          message: `Agent Space marker for ${agentId} at ${space.path} is invalid`,
          action: 'inspect space.json and repair it manually; doctor will not modify it',
        }));
      }
    }
  }

  // `git remote get-url` exits 2 for a remote that does not exist; that is the
  // deterministic "no origin" answer, not an abnormal failure.
  const fetchUrls = probe(['remote', 'get-url', '--all', 'origin'], { absentStatuses: [1, 2] });
  const pushUrls = probe(['remote', 'get-url', '--push', '--all', 'origin'], { absentStatuses: [1, 2] });
  const remoteError = fetchUrls.error ?? pushUrls.error;
  const urls = [fetchUrls.value, pushUrls.value].filter(Boolean).flatMap((value) => value.split('\n'));
  const remoteReady = urls.length > 0 && urls.every(isHttpsRemote);
  const hasSsh = urls.some(isSshRemote);
  checks.push(remoteError
    ? unreadableCheck('worktree.remote', 'worktree-remote-unreadable', remoteError)
    : readinessCheck({
      id: 'worktree.remote',
      status: urls.length === 0 ? 'warning' : remoteReady ? 'ready' : 'failed',
      code: urls.length === 0 ? 'origin-missing' : remoteReady ? null : hasSsh ? 'origin-ssh' : 'origin-not-https',
      message: urls.length === 0
        ? 'no origin remote'
        : remoteReady
          ? 'origin fetch and push URLs use HTTPS'
          : hasSsh
            ? 'origin has an SSH URL that could authenticate as the human'
            : 'origin fetch or push URL is not HTTPS',
      action: remoteReady || urls.length === 0 ? null : 'run setup-worktree to rewrite origin URLs to HTTPS',
      evidence: { url_count: urls.length },
    }));

  const signing = probe(['config', '--worktree', '--get', 'commit.gpgsign']);
  checks.push(signing.error
    ? unreadableCheck('worktree.signing', 'worktree-signing-unreadable', signing.error)
    : readinessCheck({
      id: 'worktree.signing',
      status: signing.value === 'false' ? 'ready' : 'failed',
      code: signing.value === 'false' ? null : 'worktree-signing-enabled',
      message: signing.value === 'false' ? 'human commit signing is disabled' : 'human commit signing is not disabled',
      action: signing.value === 'false' ? null : 'run: agent-bot setup-worktree',
    }));

  const expectedHooks = installationPaths(home).hooksDir.replaceAll('\\', '/');
  const hooksProbe = probe(['config', '--worktree', '--path', '--get', 'core.hooksPath']);
  const worktreeHooks = hooksProbe.value?.replaceAll('\\', '/');
  checks.push(hooksProbe.error
    ? unreadableCheck('worktree.hooks', 'worktree-hooks-unreadable', hooksProbe.error)
    : readinessCheck({
      id: 'worktree.hooks',
      status: worktreeHooks === expectedHooks ? 'ready' : 'failed',
      code: worktreeHooks === expectedHooks ? null : 'worktree-hooks-mismatch',
      message: worktreeHooks === expectedHooks ? 'worktree uses installed agent-bot hooks' : 'worktree hooks path is missing or mismatched',
      action: worktreeHooks === expectedHooks ? null : 'run: agent-bot setup-worktree',
    }));

  const helpersProbe = probe(['config', '--worktree', '--get-all', 'credential.helper']);
  const helpers = helpersProbe.value?.split('\n') ?? [];
  const expectedHelper = slug
    ? credentialHelperCommand(installationPaths(home).executable, slug, { subcommand: 'credential' })
    : null;
  const helperReady = credentialHelperSequenceReady(helpers, expectedHelper);
  checks.push(helpersProbe.error
    ? unreadableCheck('worktree.credential_helper', 'credential-helper-unreadable', helpersProbe.error)
    : readinessCheck({
      id: 'worktree.credential_helper',
      status: helperReady ? 'ready' : 'failed',
      code: helperReady ? null : 'credential-helper-mismatch',
      message: helperReady
        ? 'credential helper reset is followed by the worktree App helper'
        : 'credential helper reset/App binding is missing, reordered, or contains fallback helpers',
      action: helperReady ? null : 'run: agent-bot setup-worktree',
    }));

  return {
    status: checks.some((check) => check.status === 'failed') ? 'not_ready' : 'ready',
    checks,
  };
}

function sectionStatus(checks, apps = []) {
  const failed = checks.some((check) => check.status === 'failed')
    || apps.some((app) => app.credential.status === 'failed' || app.live_mint.status === 'failed');
  return failed ? 'not_ready' : 'ready';
}

function firstActionableFailure(report) {
  const candidates = [
    ...report.machine.checks.map((check) => ({ scope: 'machine', check })),
    ...report.machine.apps.flatMap((app) => [
      { scope: 'machine', app_slug: app.slug, check: app.credential },
      { scope: 'machine', app_slug: app.slug, check: app.live_mint },
    ]),
    ...report.worktree.checks.map((check) => ({ scope: 'worktree', check })),
  ];
  const found = candidates.find(({ check }) => check.status === 'failed' && check.action)
    ?? candidates.find(({ check }) => check.status === 'failed');
  if (!found) return null;
  return {
    scope: found.scope,
    check_id: found.check.id,
    app_slug: found.app_slug ?? null,
    code: found.check.code,
    message: found.check.message,
    action: found.check.action,
  };
}

export function buildReadinessReport({
  command,
  scope,
  machineChecks = [],
  apps = [],
  worktreeStatus = 'not_requested',
  worktreeChecks: currentWorktreeChecks = [],
} = {}) {
  const machine = scope === 'worktree'
    ? { status: 'not_requested', checks: [], apps: [] }
    : { status: sectionStatus(machineChecks, apps), checks: machineChecks, apps };
  const worktree = scope === 'machine'
    ? { status: 'not_requested', checks: [] }
    : { status: worktreeStatus, checks: currentWorktreeChecks };
  const report = {
    schema_version: READINESS_SCHEMA_VERSION,
    command,
    scope,
    ready: machine.status !== 'not_ready' && worktree.status !== 'not_ready',
    machine,
    worktree,
    first_actionable_failure: null,
  };
  report.first_actionable_failure = firstActionableFailure(report);
  return report;
}

export async function collectReadiness({
  command = 'doctor',
  scope = 'all',
  explicitApps = [],
  home = homedir(),
  env = process.env,
  cwd = process.cwd(),
  expectedGhShim = false,
  appResults = null,
  operationFailure = null,
  verifyApps = true,
  nodeVersion = process.version,
  now = new Date(),
  git = runGit,
  spawn = spawnSync,
  lstat = lstatSync,
  readlink = readlinkSync,
  exists = existsSync,
  access = accessSync,
  load = loadConfig,
  inspectCredentials = inspectAppCredentials,
  inspectSpace = inspectAgentSpace,
  inspectDaemonSupervisor = inspectSupervisor,
  inspectCutover = inspectSpacesCutover,
  inspectShellGh = inspectShellGhShim,
  inspectCodexDesktopGh = inspectConfiguredCodexDesktopGh,
  probeDaemon = daemonStatus,
} = {}) {
  const machineChecks = [];
  let config = {};
  let configValid = true;
  let mappings = [];
  let roster = [...new Set(explicitApps)].sort();

  if (scope !== 'worktree') {
    machineChecks.push(nodeCheck(nodeVersion));
    machineChecks.push(gitCheck({ cwd, env, git }));
    machineChecks.push(installedCliCheck({ home, lstat, readlink }));
    machineChecks.push(identityClassCheck({ home, env, access }));
    machineChecks.push(shellPathCheck({ home, env, spawn }));
    try {
      config = load({ home, env });
      mappings = HARNESSES
        .map(({ key }) => ({ harness: key, slug: slugForHarness(key, config) }))
        .filter(({ slug }) => slug);
      roster = configuredAppSlugs(config, explicitApps);
      if (roster.some((slug) => typeof slug !== 'string' || !APP_SLUG_RE.test(slug))) {
        configValid = false;
        roster = [];
        machineChecks.push(readinessCheck({
          id: 'config.runtime',
          status: 'failed',
          code: 'config-app-slug-invalid',
          message: 'config or explicit options contain an invalid App slug',
          action: 'replace invalid App mappings with GitHub App slugs, then retry',
          evidence: { source: 'runtime-config', mappings: [] },
        }));
      } else {
        machineChecks.push(configCheck({
          config,
          detectedHarness: detectHarness(env),
          mappings,
        }));
      }
      if (Object.keys(config).length > 0) {
        machineChecks.push(organizationProfileCheck(config));
      }
    } catch (error) {
      configValid = false;
      machineChecks.push(error?.code === 'profile-app-retired'
        ? readinessCheck({
          id: 'credential.roster',
          status: 'failed',
          code: 'profile-app-retired',
          message: 'an explicitly selected App is retired by the installed organization profile',
          action: 'remove the retired --app selection, then retry',
        })
        : failedConfigCheck());
    }
    machineChecks.push(hooksCheck({ home, cwd, env, git, access }));
    machineChecks.push(supervisorCheck({ home, env, inspect: inspectDaemonSupervisor }));
    machineChecks.push(await daemonHealthCheck({
      home,
      env,
      probe: probeDaemon,
      skipLoad: supervisorSkipLoad(env),
    }));
    machineChecks.push(spacesRootCheck({ home, env, config }));
    machineChecks.push(spacesHomeCheck({ home, env, config, inspectCutover }));
    machineChecks.push(coverageCheck(now));
    machineChecks.push(ghShimCheck({ home, required: expectedGhShim, inspect: inspectShellGh }));
    machineChecks.push(codexDesktopGhCheck({ home, inspect: inspectCodexDesktopGh }));
    machineChecks.push(runtimeSkillCheck({ home, lstat, readlink, access }));
  } else {
    try {
      config = load({ home, env });
    } catch {
      configValid = false;
    }
  }

  if (operationFailure?.scope === 'machine') machineChecks.unshift(operationFailure.check);

  let apps = [];
  if (scope !== 'worktree') {
    const resultsProvided = appResults !== null;
    let results = appResults;
    if (results && !resultRosterMatches(results, roster)) {
      results = null;
      machineChecks.push(readinessCheck({
        id: 'credential.roster',
        status: 'failed',
        code: 'credential-roster-incomplete',
        message: 'credential verification did not cover the complete configured App roster',
        action: 'rerun bootstrap so every configured App is reconciled in one roster',
      }));
    }
    if (!results && configValid && !resultsProvided) {
      try {
        results = await inspectCredentials({
          slugs: roster,
          home,
          ...(verifyApps ? {} : { verify: null }),
        });
      } catch {
        machineChecks.push(readinessCheck({
          id: 'credential.roster',
          status: 'failed',
          code: 'credential-probe-failed',
          message: 'the App credential roster could not be inspected safely',
          action: 'repair the config or local credential permissions, then retry',
        }));
      }
    }
    if (results) apps = appReports(results);
  }

  let worktree = { status: 'not_requested', checks: [] };
  if (scope !== 'machine') {
    worktree = worktreeChecks({ cwd, env, home, config, git, inspectSpace });
    if (operationFailure?.scope === 'worktree') {
      worktree = {
        status: 'not_ready',
        checks: [operationFailure.check, ...worktree.checks],
      };
    } else if (!configValid && worktree.status !== 'not_applicable') {
      worktree = {
        status: 'not_ready',
        checks: [readinessCheck({
          id: 'worktree.config',
          status: 'failed',
          code: 'config-invalid',
          message: 'worktree identity cannot be verified while config is invalid',
          action: 'repair the runtime config, then rerun doctor',
        }), ...worktree.checks],
      };
    }
  }

  return buildReadinessReport({
    command,
    scope,
    machineChecks,
    apps,
    worktreeStatus: worktree.status,
    worktreeChecks: worktree.checks,
  });
}

function renderCheck(check, appSlug = null) {
  const label = check.status === 'ready' ? 'ok   '
    : check.status === 'warning' ? 'warn '
      : check.status === 'failed' ? 'FAIL '
        : 'skip ';
  const subject = appSlug ? `[${appSlug}] ` : '';
  return `  ${label} ${subject}${check.message}\n`;
}

export function renderReadinessReport(report) {
  let output = `agent-bot ${report.command === 'doctor' ? 'doctor' : 'bootstrap readiness'}\n`;
  if (report.machine.status !== 'not_requested') {
    output += '\n-- machine --\n';
    for (const check of report.machine.checks) output += renderCheck(check);
    if (report.machine.apps.length > 0) {
      output += '\n-- per-App credentials (live) --\n';
      for (const app of report.machine.apps) {
        output += renderCheck(app.credential, app.slug);
        output += renderCheck(app.live_mint, app.slug);
      }
    }
  }
  if (report.worktree.status !== 'not_requested') {
    output += '\n-- current repo --\n';
    for (const check of report.worktree.checks) output += renderCheck(check);
  }
  const failureCount = [
    ...report.machine.checks,
    ...report.machine.apps.flatMap((app) => [app.credential, app.live_mint]),
    ...report.worktree.checks,
  ].filter((check) => check.status === 'failed').length;
  if (report.first_actionable_failure?.action) {
    output += `\n        fix: ${report.first_actionable_failure.action}\n`;
  }
  output += report.ready ? '\nall checks passed\n' : `\n${failureCount} problem(s) found\n`;
  return output;
}

export function renderReadinessJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function requireReadinessSchema(minimum) {
  if (minimum === null || minimum === undefined) return;
  if (!Number.isInteger(minimum) || minimum < 1) {
    throw new Error('--require-schema-version requires a positive integer');
  }
  if (READINESS_SCHEMA_VERSION < minimum) {
    throw new Error(
      `readiness schema ${READINESS_SCHEMA_VERSION} does not satisfy required version ${minimum}`,
    );
  }
}
