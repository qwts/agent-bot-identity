import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpacesHome } from './agent-space.mjs';
import { inspectSoulSpace } from './soul-memory.mjs';
import { readSoulEnvironment } from './soul-env.mjs';
import { duplicateSoulDirs, listSouls, orphanSoulDirs, populationFile } from './agent-population.mjs';
import { inspectSpacesCutover } from './spaces-cutover.mjs';
import { apiBase, gateStatus, isGateEnabled, loadConfig, rosterScope, slugForHarness, unmanagedAuthors } from './config.mjs';
import { preGateConfigStatus } from './config-migration.mjs';
import { inspectAppCredentials } from './credential-reconciler.mjs';
import { appKeyStores } from './soul-credentials.mjs';
import { configuredAccountIdentity, accountName, detectHarness, HARNESSES } from './detect-harness.mjs';
import { inspectClaudeWorktreeAdapter } from './sync-hooks.mjs';
import { GIT_HOOK_NAMES } from './git-hooks.mjs';
import { CANONICAL_EVENTS, DIALECTS, vendorEvent } from './hook-dialects.mjs';
import { daemonStatus } from './agent-daemon.mjs';
import { readBindToken, readBinding } from './agent-binding.mjs';
import { readAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { isSoulBound } from './git-credential-bot.mjs';
import { inspectSupervisor, supervisorSkipLoad } from './daemon-supervisor.mjs';
import { embeddingAppBundle, homebrewRuntimeRoot, inspectExecutableLink, installationPaths, isManagedExecutable } from './install.mjs';
import { inspectConfiguredCodexDesktopGh, inspectShellGhShim } from './install-gh-shim.mjs';
import {
  OrganizationProfileError,
  profileAppSlugs,
  profileStatusForSlug,
  runtimeProfileInfo,
} from './organization-profile.mjs';
import {
  AGENT_ID_KEYS,
  PIN_KEYS,
  pinnedSlug,
  readGitConfig,
  resolveAgentSlug,
  territoryHarness,
} from './resolve-agent.mjs';
import { credentialHelperCommand } from './setup-worktree.mjs';
import { BUILTIN_SECRET_PROVIDERS } from './secret.mjs';
import { createSecretProviderRegistry, probeSecretStore } from './secret-store.mjs';

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
// Identifies this runtime's own manifest, so version skew never compares against
// an unrelated project that happens to be the working directory.
const AGENT_BOT_PACKAGE_NAME = 'agent-bot-identity';

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
  const slugs = new Set([...profileAppSlugs(config), ...Object.keys(config.identityApps ?? {}), ...Object.values(config.apps ?? {}), ...explicit]);
  for (const { key } of HARNESSES) {
    const slug = slugForHarness(key, config);
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

function featureGatesCheck({ home, env, config }) {
  let preGate = { needed: false };
  try { preGate = preGateConfigStatus({ home, env }); } catch { /* the gate report still stands */ }
  if (preGate.needed) {
    return readinessCheck({
      id: 'config.feature_gates',
      status: 'warning',
      code: 'feature-gates-pre-gate-config',
      message: 'config predates feature gates but its souls use GitHub Apps; github-identity and persona-accounts are off until the daemon next starts (#361)',
      action: 'run: agent-bot daemon install (or restart the daemon) to keep both add-ons on',
      evidence: { gates: gateStatus(config) },
    });
  }
  return readinessCheck({
    id: 'config.feature_gates',
    status: 'ready',
    message: 'feature gates resolved from user config or default off',
    evidence: { gates: gateStatus(config) },
  });
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
      // Context injection is a separate capability from event coverage: a
      // dialect can wire every event and still have no way to hand a hook's
      // text to the model, which is what a SessionStart instruction needs.
      // The note is the row's own words for the gap, so a report says why
      // instead of only reporting an empty list.
      contextEvents: Object.keys(row.contextChannel ?? {}),
      contextNote: row.contextNote ?? null,
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
  // A space inside its soul folder (ADR-0583 decision 8) is where it belongs,
  // whatever the spaces root is.
  const contained = (soul) => typeof soul.soulDir === 'string' && pathIsInside(join(soul.soulDir, '.soul-state'), soul.spacePath);
  const mismatches = souls.filter((soul) => !contained(soul) && !pathIsInside(inspection.resolvedRoot, soul.spacePath));
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

// Active souls that no checkout references (#192). A census row records the
// checkout setup-worktree pinned the soul to; a soul whose checkout is gone,
// is pinned to another soul, or was never recorded is orphaned unless a
// setup records a checkout for it. A warning, not a failure: the machine
// still works, but the operator can now see what to retire instead of
// diffing the census against every pin by hand.
function checkoutHolds(soul, { git, env, worktree }) {
  if (!worktree) return 'unrecorded';
  for (const key of AGENT_ID_KEYS) {
    try {
      const value = (git(['config', '--worktree', '--get', key], { cwd: worktree, env: readinessGitEnv(env) }) ?? '').trim();
      if (value === soul.id) return 'held';
      if (value) return 'repinned';
    } catch (error) {
      if (error?.status === 1) continue; // unset for this key
      // No such directory, or a directory that is no longer a repository.
      if (error?.code === 'ENOENT' || error?.status === 128) return 'gone';
      return 'unverified';
    }
  }
  return 'unpinned';
}

// #228 state introspection. Everything here is advisory: `sectionStatus` fails
// a section only on 'failed', and doctor exits non-zero on `report.ready`, so a
// 'warning' reports state without changing bootstrap behaviour or a CI gate.

// Which App each recorded checkout is bound to, from the census alone. The
// census already records appSlug per soul, so this costs no git call per
// checkout — the existing souls.referenced check already spends those, and
// doubling them would make doctor unusable on a large census.
function worktreeBindingSummaryCheck({ home, env, roster }) {
  let souls;
  try {
    souls = listSouls({ file: populationFile({ home, env }) })
      .filter((soul) => soul.status === 'active');
  } catch {
    return null; // spaces.home already reports an unreadable census
  }
  if (souls.length === 0) {
    return readinessCheck({
      id: 'worktree.binding_summary',
      status: 'not_applicable',
      message: 'no active souls in the census, so no checkout bindings to summarize',
      evidence: { active: 0, by_app: {}, not_in_roster: [] },
    });
  }
  // Count checkouts, not souls: a soul may hold several linked worktrees.
  // A null appSlug is a soul with no GitHub App (#280). Those checkouts are
  // counted in without_app and are not compared with the roster.
  const byApp = new Map();
  let checkoutCount = 0;
  let withoutApp = 0;
  for (const soul of souls) {
    const worktrees = Array.isArray(soul.worktrees) && soul.worktrees.length > 0
      ? soul.worktrees
      : [null];
    for (const _worktree of worktrees) {
      checkoutCount += 1;
      if (!soul.appSlug) {
        withoutApp += 1;
        continue;
      }
      byApp.set(soul.appSlug, (byApp.get(soul.appSlug) ?? 0) + 1);
    }
  }
  // Same rule as the current-worktree check: an empty roster is an unconfigured
  // machine, not a machine where every App is acceptable. Souls with no App
  // are not an unconfigured roster.
  const known = roster ?? [];
  const evidence = {
    active: souls.length,
    checkouts: checkoutCount,
    by_app: Object.fromEntries([...byApp.entries()].sort(([a], [b]) => a.localeCompare(b))),
    without_app: withoutApp,
    not_in_roster: known.length === 0 ? [] : [...byApp.keys()].filter((slug) => !known.includes(slug)).sort(),
    roster_configured: known.length > 0,
  };
  if (byApp.size === 0) {
    return readinessCheck({
      id: 'worktree.binding_summary',
      status: 'ready',
      message: `${checkoutCount} checkout(s) have no GitHub App`,
      evidence,
    });
  }
  if (known.length === 0) {
    return readinessCheck({
      id: 'worktree.binding_summary',
      status: 'warning',
      code: 'worktree-binding-no-roster',
      message: `${checkoutCount} checkout(s) are bound, but no App roster is configured to verify them against`,
      action: 'configure the App mapping, then bind each checkout with: agent-bot setup-worktree',
      evidence,
    });
  }
  if (evidence.not_in_roster.length === 0) {
    const message = withoutApp > 0
      ? `${checkoutCount - withoutApp} checkout(s) are bound to a rostered App; ${withoutApp} have no GitHub App`
      : `every checkout is bound to a rostered App (${checkoutCount})`;
    return readinessCheck({
      id: 'worktree.binding_summary',
      status: 'ready',
      message,
      evidence,
    });
  }
  return readinessCheck({
    id: 'worktree.binding_summary',
    status: 'warning',
    code: 'worktree-binding-foreign-app',
    message: `checkouts are bound to Apps outside the configured roster: ${evidence.not_in_roster.join(', ')}`,
    action: 'bind each checkout explicitly with: agent-bot setup-worktree',
    evidence,
  });
}

// Read checkout configuration without command-scope injection or repository
// overrides. Keep the controls used to isolate global and system config.
function readinessGitEnv(env) {
  const probeEnv = { ...env };
  for (const key of Object.keys(probeEnv)) {
    if (key === 'GIT_CONFIG_GLOBAL' || key === 'GIT_CONFIG_NOSYSTEM') continue;
    if (/^GIT_CONFIG(?:_|$)/.test(key)
      || /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES)$/.test(key)) {
      delete probeEnv[key];
    }
  }
  return probeEnv;
}

// The current worktree in full detail. This one may fail: an App outside the
// roster is a real misconfiguration of the worktree being diagnosed, not a
// machine-wide observation, and a diagnostic that quietly tolerated it would
// misreport what this session can actually act as.
function currentWorktreeBindingCheck({ cwd, env, git, roster, isSoulBoundImpl, readBindingImpl }) {
  // Read the pin through the injected git, exactly as the other worktree probes
  // do. `pinnedSlug` cannot be used here: it forwards no env to its subprocess.
  const probeEnv = readinessGitEnv(env);
  let slug = null;
  let readable = true;
  for (const key of PIN_KEYS) {
    for (const args of [['config', '--worktree', '--get', key], ['config', '--get', key]]) {
      try {
        const value = (git(args, { cwd, env: probeEnv }) ?? '').trim();
        if (value) {
          slug = value;
          break;
        }
      } catch (error) {
        // status 1 is "unset"; anything else means this is not a usable worktree.
        if (error?.status !== 1) {
          readable = false;
          break;
        }
      }
    }
    if (slug || !readable) break;
  }
  if (!readable) {
    return readinessCheck({
      id: 'worktree.binding',
      status: 'not_applicable',
      message: 'the current directory is not a readable Git worktree',
    });
  }
  if (!slug) {
    return readinessCheck({
      id: 'worktree.binding',
      status: 'warning',
      code: 'worktree-binding-absent',
      message: 'the current worktree is not bound to an App, so identity-bound capabilities will refuse it',
      action: 'bind this worktree with: agent-bot setup-worktree',
      evidence: { worktree: cwd, app_slug: null },
    });
  }
  // An empty roster means no App is configured, not that every App is allowed.
  // Treating absence as allow-all would make this failure unreachable on an
  // account with no mappings — exactly when a pin has nothing to reconcile with.
  const known = roster ?? [];
  if (known.length === 0) {
    return readinessCheck({
      id: 'worktree.binding',
      status: 'warning',
      code: 'worktree-binding-no-roster',
      message: `the current worktree is bound to ${slug}, but no App roster is configured to verify it against`,
      action: 'configure the App mapping, then bind again with: agent-bot setup-worktree',
      evidence: { worktree: cwd, app_slug: slug, roster: known },
    });
  }
  const inRoster = known.includes(slug);
  if (inRoster && isSoulBoundImpl({ env, cwd })) {
    let usable = false;
    try { usable = Boolean(readBindingImpl({ env, cwd })); } catch { /* unreadable is unusable */ }
    if (!usable) {
      return readinessCheck({
        id: 'worktree.binding',
        status: 'warning',
        code: 'worktree-binding-unusable',
        message: `the current worktree is bound to ${slug}, but this session has no live daemon binding for it, so gh will refuse to run`,
        action: 'check in as that soul (agent-bot join --name NAME --harness HARNESS) or re-bind this checkout to the session soul with: agent-bot setup-worktree',
        evidence: { worktree: cwd, app_slug: slug, roster: known, session_soul: env.AGENT_BOT_ID || env.QWTS_AGENT_ID || null },
      });
    }
  }
  return readinessCheck({
    id: 'worktree.binding',
    status: inRoster ? 'ready' : 'failed',
    code: inRoster ? null : 'worktree-binding-not-in-roster',
    message: inRoster
      ? `the current worktree is bound to ${slug}`
      : `the current worktree is bound to ${slug}, which is not in the configured roster`,
    action: inRoster ? null : 'reconcile the App mapping, then bind again with: agent-bot setup-worktree',
    evidence: { worktree: cwd, app_slug: slug, roster: known },
  });
}

// git copies config.worktree into each worktree it adds (#648), so a linked
// worktree can carry a soul's pin that no soul ever set up there. Setup leaves
// a bind token in the worktree's own git dir, and binding replaces it with
// agent-binding.json; a pin with neither, for that soul, most likely arrived
// by copy. Reported, never repaired: removing a pin is the owner's call.
export function worktreePinOriginCheck({ gitDir, agentId,
  readToken = readBindToken, readBindingImpl = readBinding } = {}) {
  let local = false;
  let unreadable = false;
  for (const read of [() => readToken(gitDir), () => readBindingImpl({ env: {}, gitDir })]) {
    try {
      if (read()?.agentId === agentId) local = true;
    } catch {
      unreadable = true;
    }
  }
  if (local) {
    return readinessCheck({
      id: 'worktree.pin_origin',
      status: 'ready',
      message: `the Agent ID pin was set up in this worktree`,
      evidence: { agent_id: agentId },
    });
  }
  return readinessCheck({
    id: 'worktree.pin_origin',
    status: 'warning',
    code: unreadable ? 'worktree-pin-origin-unreadable' : 'worktree-pin-inherited',
    message: unreadable
      ? `the Agent ID pin ${agentId} could not be matched to setup or binding state in this worktree`
      : `this worktree is pinned to ${agentId}, but holds no setup or binding state for it: git worktree add copies a pin from the checkout it was added from`,
    action: `if ${agentId} set up this worktree, run agent-bot setup-worktree as that soul; otherwise this checkout is not that soul's: remove the agentBot.*, [bot] user.* and agent-bot credential.helper entries from git config --worktree, or recreate the worktree with agent-bot setup-worktree --name`,
    evidence: { agent_id: agentId },
  });
}

// The App a checkout acts as against the App the soul's identity record names
// (#107 rollout). For a bound soul the daemon mints the recorded App and the
// helper refuses any other, so a mismatch is a soul that cannot use its door
// once in-process mints close. Diagnosis only: reconciling the two belongs to
// #107's migration contract, never to doctor or to manual owner chores.
export function appRecordCheck({ agentId, slug, config = {}, readIdentity } = {}) {
  let recorded = null;
  try { recorded = readIdentity(agentId)?.github?.appSlug ?? null; } catch { return null; }
  if (!recorded || !slug) return null;
  if (recorded === slug) {
    return readinessCheck({
      id: 'worktree.app_record',
      status: 'ready',
      message: `the soul's identity record names ${slug}`,
      evidence: { agent_id: agentId, app_slug: slug },
    });
  }
  const managed = Boolean(config.identityApps?.[slug]?.store);
  return readinessCheck({
    id: 'worktree.app_record',
    status: 'warning',
    code: 'soul-app-record-mismatch',
    message: `this checkout acts as ${slug}, but the identity record of ${agentId} names ${recorded}; the daemon mints the recorded App for a bound soul and refuses any other`,
    // Diagnosis only: how such a record is reconciled is #107's migration
    // contract, not a chore doctor hands the owner.
    action: `nothing to do yet: the explicit ${slug} keeps working until #107 closes in-process mints, and it must be reconciled with the record before then (#107 migration contract)${managed ? '' : `; ${slug} is not a managed App on this machine`}`,
    evidence: { agent_id: agentId, app_slug: slug, recorded_app_slug: recorded, managed },
  });
}

// Which key store each App's key is recorded in, and whether a legacy
// ~/.config/<slug>/private-key.pem remains (#110). Records and lstat only: no
// store is read and the key file is never opened, so this names stores and
// slugs, never key material. A remaining legacy file is a warning, not a
// failure: migration is the owner's explicit step.
function keyStoreCheck({ roster, home, env, config, inspect }) {
  if (roster.length === 0) {
    return readinessCheck({
      id: 'credential.key_store',
      status: 'not_applicable',
      message: 'no configured App to report a key store for',
    });
  }
  // One unreadable record (a malformed soul.json, an odd slug) reports that
  // App alone as unreadable; the other Apps still show.
  const apps = roster.map((slug) => {
    try {
      const row = inspect(slug, { home, env, config });
      return {
        app_slug: slug,
        stores: [...new Set(row.stores.map((entry) => entry.store))].sort(),
        legacy_key_file: row.legacyKeyFile === true,
      };
    } catch {
      return { app_slug: slug, stores: [], legacy_key_file: null, unreadable: true };
    }
  });
  const summary = apps.map((app) => `${app.app_slug}: ${app.unreadable ? 'records unreadable'
    : app.stores.join(', ') || 'no store recorded'}`).join('; ');
  const legacy = apps.filter((app) => app.legacy_key_file).map((app) => app.app_slug);
  const unreadable = apps.filter((app) => app.unreadable).map((app) => app.app_slug);
  if (legacy.length > 0) {
    return readinessCheck({
      id: 'credential.key_store',
      status: 'warning',
      code: 'legacy-key-file-present',
      message: `App key stores (${summary}); a legacy ~/.config/<slug>/private-key.pem remains for ${legacy.join(', ')}; migrate with: agent-bot identity migrate-credentials --all --dry-run`,
      action: 'run: agent-bot identity migrate-credentials --all --dry-run, then without --dry-run',
      evidence: { apps },
    });
  }
  if (unreadable.length > 0) {
    return readinessCheck({
      id: 'credential.key_store',
      status: 'warning',
      code: 'key-store-probe-failed',
      message: `App key stores (${summary}); check soul.json credentials and identityApps stores for ${unreadable.join(', ')}`,
      action: 'check the soul census and soul.json credentials for the unreadable Apps, then rerun doctor',
      evidence: { apps },
    });
  }
  return readinessCheck({
    id: 'credential.key_store',
    status: 'ready',
    message: `App key stores (${summary}); no legacy key file`,
    evidence: { apps },
  });
}

// Secure-store reachability, from the provider's own session probe. Never reads
// a field, so this creates no audit entry and puts no secret in the report.
function secureStoreCheck({ probe }) {
  let results;
  try {
    results = probe();
  } catch (error) {
    return readinessCheck({
      id: 'securestore.session',
      status: 'warning',
      code: 'securestore-probe-failed',
      message: 'the secure store could not be probed',
      action: 'check the provider executable, then rerun doctor',
      evidence: { providers: [], code: error?.code ?? 'PROVIDER_FAILED' },
    });
  }
  if (!Array.isArray(results) || results.length === 0) {
    return readinessCheck({
      id: 'securestore.session',
      status: 'not_applicable',
      message: 'no configured secure store reports session state',
    });
  }
  const evidence = { providers: results };
  if (results.every((entry) => entry.available && entry.session)) {
    return readinessCheck({
      id: 'securestore.session',
      status: 'ready',
      message: `every configured secure store has a live session (${results.length})`,
      evidence,
    });
  }
  // A provider that never answered is a different problem from one that answered
  // "no session", and the recovery differs. Grouping them would send an operator
  // to log in again when the real fault is a timeout or a missing executable.
  const unreachable = results.filter((entry) => !entry.available);
  const unsessioned = results.filter((entry) => entry.available && !entry.session);
  if (unreachable.length > 0) {
    return readinessCheck({
      id: 'securestore.session',
      status: 'warning',
      code: 'securestore-provider-unavailable',
      message: `secure store provider(s) did not answer: ${unreachable.map((e) => `${e.id} (${e.code ?? 'unavailable'})`).join(', ')}`,
      action: 'check the provider executable and connectivity, then rerun doctor; logging in will not help an unreachable provider',
      evidence,
    });
  }
  return readinessCheck({
    id: 'securestore.session',
    status: 'warning',
    code: 'securestore-no-session',
    message: `secure store has no live session: ${unsessioned.map((e) => e.id).join(', ')}`,
    action: 'log the provider in, then rerun doctor; a bound action needing a secret will fail until then',
    evidence,
  });
}

// Inbox reachability, presence only (#299). Reports what is configured and
// whether a harness has the MCP server wired; it never reads the bearer, and
// it makes no network call by default — a diagnostic that blocks on an
// unreachable third party is worse than one that reports the configuration
// it can see. The host is reported so a DNS/TLS/refused failure can be told
// apart from a bad URL without ever echoing the bearer.
function inboxHostForDoctor(inboxUrl) {
  try {
    const parsed = new URL(inboxUrl);
    return /^https?:$/.test(parsed.protocol) ? parsed.host || null : null;
  } catch {
    return null;
  }
}

function inboxConfigurationCheck({ env, harnesses }) {
  const url = typeof env.GH_APP_HOOK_INBOX_URL === 'string' ? env.GH_APP_HOOK_INBOX_URL : null;
  // Only an agent-bot entry counts as wired. A harness with some unrelated MCP
  // server configured has not wired the inbox.
  const wired = Array.isArray(harnesses)
    ? harnesses.filter((entry) => entry?.mcp === 'agent-bot')
    : [];
  const evidence = {
    url_configured: Boolean(url),
    host: url ? inboxHostForDoctor(url) : null,
    // Named for what it is, and deliberately free of the words the leak guard
    // screens for: this reports presence, never a value.
    credential_configured: typeof env.GH_APP_HOOK_INBOX_TOKEN === 'string' && env.GH_APP_HOOK_INBOX_TOKEN.length > 0,
    harnesses_wired: wired.map((entry) => entry.harness),
  };
  if (!url && wired.length === 0) {
    return readinessCheck({
      id: 'inbox.configuration',
      status: 'not_applicable',
      message: 'no gh-app-hook inbox is configured and no harness wires its MCP server',
      evidence,
    });
  }
  if (url && evidence.host === null) {
    return readinessCheck({
      id: 'inbox.configuration',
      status: 'warning',
      code: 'inbox-url-invalid',
      message: 'the inbox URL is set but is not a valid http(s) URL',
      action: 'fix GH_APP_HOOK_INBOX_URL, then rerun doctor',
      evidence,
    });
  }
  if (url && evidence.credential_configured && wired.length > 0) return readinessCheck({
    id: 'inbox.configuration',
    status: 'ready',
    message: `the inbox is configured and wired into ${wired.length} harness(es)`,
    evidence,
  });
  return readinessCheck({
    id: 'inbox.configuration',
    status: 'warning',
    code: 'inbox-incompletely-configured',
    message: !url
      ? 'a harness wires the inbox MCP server but no inbox URL is configured'
      : 'the inbox is configured but no harness wires its MCP server, or the bearer is absent',
    action: 'see docs/gh-app-hook.md (the gh-app-hook deployment procedure) for provisioning and harness wiring',
    evidence,
  });
}

// The opt-in network half of the inbox section (#318), run only for
// `doctor --probe-inbox`. Advisory like the configuration check: an
// unreachable broker is a warning, so the probe never turns a ready machine
// into a failed one. Any HTTP answer below 500 proves the broker is there;
// a 401/403 is the expected answer to a request that carries no bearer.
const INBOX_PROBE_FIX = 'check GH_APP_HOOK_INBOX_URL, DNS, TLS and the broker status, then rerun doctor --probe-inbox';

async function inboxReachabilityCheck({ env, probe }) {
  const url = typeof env.GH_APP_HOOK_INBOX_URL === 'string' && env.GH_APP_HOOK_INBOX_URL !== ''
    ? env.GH_APP_HOOK_INBOX_URL
    : null;
  if (!url || inboxHostForDoctor(url) === null) {
    return readinessCheck({
      id: 'inbox.reachability',
      status: 'not_applicable',
      code: 'inbox-probe-skipped',
      message: url
        ? 'inbox probe skipped: the inbox URL is not a valid http(s) URL'
        : 'inbox probe skipped: no gh-app-hook inbox URL is configured',
      evidence: { probed: false },
    });
  }
  let result;
  try {
    result = await probe(url);
  } catch {
    result = { outcome: 'network', host: inboxHostForDoctor(url), error_code: null };
  }
  const host = result.host ?? inboxHostForDoctor(url);
  const evidence = {
    probed: true,
    host,
    outcome: result.outcome,
    http_status: result.http_status ?? null,
    error_code: result.error_code ?? null,
  };
  if (result.outcome === 'http' && evidence.http_status < 500) {
    const expected = evidence.http_status === 401 || evidence.http_status === 403
      ? ', expected without a bearer'
      : '';
    return readinessCheck({
      id: 'inbox.reachability',
      status: 'ready',
      message: `inbox broker ${host} is reachable (HTTP ${evidence.http_status}${expected})`,
      evidence,
    });
  }
  const failures = {
    http: `inbox broker ${host} is reachable but failing (HTTP ${evidence.http_status})`,
    dns: `inbox broker ${host} did not resolve (DNS ${evidence.error_code})`,
    tls: `inbox broker ${host} failed the TLS handshake (${evidence.error_code})`,
    refused: `inbox broker ${host} refused the connection`,
    timeout: `inbox broker ${host} did not answer in time`,
  };
  return readinessCheck({
    id: 'inbox.reachability',
    status: 'warning',
    code: `inbox-probe-${result.outcome === 'http' ? 'http-error' : result.outcome}`,
    message: failures[result.outcome]
      ?? `inbox broker ${host} is unreachable (${evidence.error_code ?? 'network error'})`,
    action: INBOX_PROBE_FIX,
    evidence,
  });
}

// Installed CLI version beside a source checkout's, when doctor runs from one.
// Skew is normal mid-release, so this is never a failure. The two version
// lookups are injected separately: resolving where the installed runtime lives
// is a different question from comparing versions, and only the former knows
// about Homebrew's layout.
function versionSkewCheck({ home, cwd, exists, readVersion, installedVersion }) {
  let installed = null;
  try {
    installed = installedVersion({ home });
  } catch {
    installed = null; // installedCliCheck owns install failures
  }
  // Only a manifest that is actually this runtime counts. Accepting any
  // package.json found in the cwd would compare the installed agent-bot against
  // whatever project doctor happened to be run from and report bogus skew.
  let checkout = null;
  let checkoutPath = null;
  for (const candidate of [cwd, ROOT]) {
    const manifest = join(candidate, 'package.json');
    if (!exists(manifest)) continue;
    let name;
    try {
      name = JSON.parse(readFileSync(manifest, 'utf8')).name;
    } catch {
      continue;
    }
    if (name !== AGENT_BOT_PACKAGE_NAME) continue;
    const version = readVersion(manifest);
    if (version) {
      checkout = version;
      checkoutPath = candidate;
      break;
    }
  }
  if (!checkout) {
    return readinessCheck({
      id: 'runtime.version_skew',
      status: 'not_applicable',
      message: 'no source checkout manifest was found to compare against the installed CLI',
      evidence: { installed_version: installed, checkout_version: null },
    });
  }
  const evidence = {
    installed_version: installed,
    checkout_version: checkout,
    checkout_path: checkoutPath,
  };
  if (installed === null) {
    return readinessCheck({
      id: 'runtime.version_skew',
      status: 'not_applicable',
      message: 'the installed runtime version could not be read, so skew is unknown',
      evidence,
    });
  }
  if (installed === checkout) return readinessCheck({
    id: 'runtime.version_skew',
    status: 'ready',
    message: `the installed CLI and the source checkout are both ${installed}`,
    evidence,
  });
  return readinessCheck({
    id: 'runtime.version_skew',
    status: 'warning',
    code: 'runtime-version-skew',
    message: `the installed CLI is ${installed} but the source checkout is ${checkout}; a checkout deliberately refuses to replace a foreign Homebrew install`,
    action: 'install the release with: brew upgrade agent-bot',
    evidence,
  });
}

// #228 default dependencies. Each is injectable so the checks stay testable
// without a live provider, a real Homebrew prefix, or a harness config on disk.

function defaultProbeSecretStore() {
  return probeSecretStore({ registry: createSecretProviderRegistry(BUILTIN_SECRET_PROVIDERS) });
}

// The MCP server's dedicated proton-pass session, probed where it lives. The
// server harness MCP configs point at (`agent-bot mcp`, #247) keeps a
// dedicated pass-cli session directory under the
// agent-bot state root so an interactive logout cannot tear the server's
// session down — which also means the interactive session says nothing about
// the launcher's. Probing only the ambient session reports ready while the
// harness's agent-bot MCP server dies at spawn with an opaque
// "Connection closed". A genuine absence (ENOENT) is the only input that means
// "no dedicated launcher session directory on this machine" — anything else
// the directory stat reports is a machine with a launcher session doctor
// cannot see, which is exactly the outage this check exists to name, so it
// surfaces as an inspection anomaly instead of a silent not_applicable. The
// probe itself reads session state only — never a field.
function launcherSessionContexts({ home, env, statFile = statSync } = {}) {
  const base = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(home, '.local', 'state');
  const dir = join(base, 'agent-bot', 'proton-pass');
  let info;
  try {
    info = statFile(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { contexts: [], inspection: null };
    return { contexts: [], inspection: { session_dir: dir, code: error?.code ?? 'PROVIDER_FAILED' } };
  }
  // A regular file at the session directory path is a broken launcher session
  // directory, not an absent one: the launcher cannot use it either.
  if (typeof info?.isDirectory !== 'function' || !info.isDirectory()) {
    return { contexts: [], inspection: { session_dir: dir, code: 'launcher-session-not-a-directory' } };
  }
  return { contexts: [{ id: 'proton-pass', session_dir: dir }], inspection: null };
}

function defaultProbeSessionContext(context) {
  return probeSecretStore({
    registry: createSecretProviderRegistry(BUILTIN_SECRET_PROVIDERS),
    env: { ...process.env, PROTON_PASS_SESSION_DIR: context.session_dir },
  });
}

// The recovery command is copy-paste shell, so the session directory must
// appear as a POSIX single-quoted literal: a HOME or XDG_STATE_HOME carrying
// $(), backticks, or quotes must not rewrite the command the operator runs.
function shellQuoteLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// The launcher's session directory is invisible to the ambient probe, so it
// gets its own advisory check rather than a second verdict inside
// securestore.session: an operator reading "secure store has a live session"
// must not have to wonder which session that verdict covers. Recovery differs
// per failure class, exactly as in secureStoreCheck: an unreachable provider
// must not be reported as a login problem.
function secureStoreLauncherSessionCheck({ discovery, probeSessionContext }) {
  if (discovery.inspection) {
    return readinessCheck({
      id: 'securestore.launcher_session',
      status: 'warning',
      code: 'securestore-launcher-unreadable',
      message: `the dedicated MCP launcher session directory could not be inspected: ${discovery.inspection.session_dir} (${discovery.inspection.code})`,
      action: 'check the session directory path and permissions, then rerun doctor',
      evidence: { contexts: [], inspection: discovery.inspection },
    });
  }
  const contexts = discovery.contexts;
  if (!Array.isArray(contexts) || contexts.length === 0) {
    return readinessCheck({
      id: 'securestore.launcher_session',
      status: 'not_applicable',
      message: 'no dedicated MCP launcher session directory on this machine',
    });
  }
  let results;
  try {
    results = contexts.map((context) => {
      const entries = probeSessionContext(context);
      const entry = Array.isArray(entries)
        ? entries.find((candidate) => candidate.id === context.id)
        : null;
      return {
        id: context.id,
        session_dir: context.session_dir,
        available: entry?.available === true,
        session: entry?.session === true,
        code: entry?.code ?? (entry?.available === true && entry?.session !== true
          ? 'PROVIDER_NO_SESSION' : null),
      };
    });
  } catch (error) {
    return readinessCheck({
      id: 'securestore.launcher_session',
      status: 'warning',
      code: 'securestore-probe-failed',
      message: 'the launcher secure store session could not be probed',
      action: 'check the provider executable, then rerun doctor',
      evidence: { contexts: [], code: error?.code ?? 'PROVIDER_FAILED' },
    });
  }
  // Presence, a directory, and codes only — never provider output, so the
  // report stays secret-free exactly like securestore.session.
  const evidence = { contexts: results };
  if (results.every((entry) => entry.available && entry.session)) {
    return readinessCheck({
      id: 'securestore.launcher_session',
      status: 'ready',
      message: `every dedicated MCP launcher session is live (${results.length})`,
      evidence,
    });
  }
  const unreachable = results.filter((entry) => !entry.available);
  if (unreachable.length > 0) {
    return readinessCheck({
      id: 'securestore.launcher_session',
      status: 'warning',
      code: 'securestore-provider-unavailable',
      message: `launcher secure store session(s) did not answer: ${
        unreachable.map((entry) => `${entry.id} (${entry.code ?? 'unavailable'})`).join(', ')}`,
      action: 'check the provider executable and connectivity, then rerun doctor; logging in will not help an unreachable provider',
      evidence,
    });
  }
  const dirs = results
    .filter((entry) => entry.available && !entry.session)
    .map((entry) => entry.session_dir);
  return readinessCheck({
    id: 'securestore.launcher_session',
    status: 'warning',
    code: 'securestore-launcher-no-session',
    message: `dedicated MCP launcher session(s) have no live login: ${dirs.join(', ')}`,
    action: dirs.length === 1
      ? `log the launcher session in, then rerun doctor: PROTON_PASS_SESSION_DIR=${shellQuoteLiteral(dirs[0])} PROTON_PASS_PERSONAL_ACCESS_TOKEN='<pat from the authorized store>' pass-cli login`
      : 'log each launcher session directory above in, then rerun doctor: PROTON_PASS_SESSION_DIR=\'<dir above>\' PROTON_PASS_PERSONAL_ACCESS_TOKEN=\'<pat from the authorized store>\' pass-cli login',
    evidence,
  });
}

function readManifestVersion(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

// Only a Homebrew install has a versioned runtime root to read, and the managed
// entrypoint is a symlink at ~/.local/bin rather than the keg path itself — so
// resolve the link before looking for the runtime root. A bootstrap install has
// no versioned runtime at all, so skew is unknowable and reported as such rather
// than guessed at from a checkout elsewhere on the machine.
function installedCliVersion({ home, readlink = readlinkSync, readVersion = readManifestVersion }) {
  const executable = installationPaths(home).executable;
  let resolved = executable;
  try {
    const target = readlink(executable);
    if (target) resolved = resolve(dirname(executable), target);
  } catch {
    resolved = executable;
  }
  const runtimeRoot = homebrewRuntimeRoot(resolved);
  if (!runtimeRoot) return null;
  return readVersion(join(runtimeRoot, 'package.json'));
}

// Harness config locations that may wire an MCP server, with the key each
// harness actually uses. HARNESSES enumerates hook dialects and does not
// include opencode, so it cannot be reused here. `agentBotPattern` matches the
// server name; an unrelated MCP server in the same file must not read as
// agent-bot wiring, or a configured inbox would report ready with agent-bot
// absent.
const MCP_CONFIG_LOCATIONS = [
  { harness: 'opencode', key: /"mcp"\s*:/, agent: /agent-bot/, paths: ['.config/opencode/opencode.jsonc', '.config/opencode/opencode.json'] },
  { harness: 'claude', key: /"mcpServers"\s*:/, agent: /agent-bot/, paths: ['.claude.json', '.claude/settings.json', '.mcp.json'] },
  { harness: 'claude', key: /"mcp"\s*:/, agent: /agent-bot/, paths: ['.claude.json', '.claude/settings.json', '.mcp.json'] },
  { harness: 'codex', key: /^\s*\[mcp_servers\./m, agent: /agent-bot/, paths: ['.codex/config.toml'] },
  { harness: 'codex', key: /"mcpServers"\s*:/, agent: /agent-bot/, paths: ['.codex/mcp.json'] },
  { harness: 'cursor', key: /"mcpServers"\s*:/, agent: /agent-bot/, paths: ['.cursor/mcp.json'] },
  // Qwen Code loads MCP servers from `mcpServers` in settings.json, at user
  // scope ~/.qwen/settings.json and project scope .qwen/settings.json.
  { harness: 'qwen', key: /"mcpServers"\s*:/, agent: /agent-bot/, paths: ['.qwen/settings.json'] },
];

// Reports which harnesses wire the agent-bot MCP server specifically. A file
// that configures some other MCP server yields no entry: this check answers
// "is agent-bot wired here", not "does this harness use MCP at all".
// Harness MCP configuration is not only user-level: `.mcp.json` and
// `opencode.json`/`opencode.jsonc` are commonly project-scoped, committed
// alongside the repository that needs them. Scanning only `home` would report
// a false negative for exactly the checkouts that are wired, so project
// locations are scanned too. A path that does not exist is not reported, which
// keeps the failure direction a false negative rather than a claim of wiring
// that is absent.
const PROJECT_MCP_CONFIG_LOCATIONS = [
  { harness: 'claude', key: /"mcpServers"\s*:/, agent: /agent-bot/, paths: ['.mcp.json'] },
  { harness: 'claude', key: /"mcp"\s*:/, agent: /agent-bot/, paths: ['.mcp.json'] },
  { harness: 'opencode', key: /"mcp"\s*:/, agent: /agent-bot/, paths: ['opencode.jsonc', 'opencode.json', '.opencode/opencode.json'] },
  { harness: 'codex', key: /^\s*\[mcp_servers\./m, agent: /agent-bot/, paths: ['.codex/config.toml'] },
  { harness: 'qwen', key: /"mcpServers"\s*:/, agent: /agent-bot/, paths: ['.qwen/settings.json'] },
];

// The inbox server is `agent-bot mcp`. A soul package renders a server named
// agent-reach (older packages named it agent-bot), which runs `reach-mcp`
// (soul-builder.mjs) and has no take_inbox: a file with only that entry has
// not wired the inbox (#247). The shapes harnesses document: `"args": ["mcp"]`,
// opencode's `"command": ["agent-bot", "mcp"]`, and codex's `args = ["mcp"]`.
const INBOX_SERVER = /\[\s*"mcp"\s*\]|"agent-bot"\s*,\s*"mcp"\s*\]/;

function harnessWiresAgentBot({ home, cwd, locations }) {
  const found = [];
  const seen = new Set();
  for (const { harness, key, agent, paths } of locations) {
    if (seen.has(harness)) continue;
    const roots = [{ base: home, paths }];
    if (cwd) roots.push({ base: cwd, paths: PROJECT_MCP_CONFIG_LOCATIONS.find((e) => e.harness === harness)?.paths ?? paths });
    for (const { base, paths: candidates } of roots) {
      for (const relative of candidates) {
        let contents;
        try {
          contents = readFileSync(join(base, relative), 'utf8');
        } catch {
          continue;
        }
        if (!key.test(contents) || !agent.test(contents) || !INBOX_SERVER.test(contents)) continue;
        found.push({ harness, mcp: 'agent-bot', scope: base === home ? 'user' : 'project' });
        seen.add(harness);
        break;
      }
      if (seen.has(harness)) break;
    }
  }
  return found;
}

export function harnessMcpWiring(options) {
  return harnessWiresAgentBot({ locations: MCP_CONFIG_LOCATIONS, ...options });
}

function defaultListHarnessMcpServers({ home, cwd }) {
  return harnessWiresAgentBot({ home, cwd, locations: MCP_CONFIG_LOCATIONS });
}

function unreferencedSoulsCheck({ home, env, git }) {
  let souls;
  try {
    souls = listSouls({ file: populationFile({ home, env }) })
      .filter((soul) => soul.status === 'active');
  } catch {
    return null; // spaces.home already reports an unreadable census
  }
  const unreferenced = [];
  const unverified = [];
  for (const soul of souls) {
    const verdicts = soul.worktrees.map((worktree) => checkoutHolds(soul, { git, env, worktree }));
    if (verdicts.includes('held')) continue;
    (verdicts.includes('unverified') ? unverified : unreferenced).push(soul.id);
  }
  if (unreferenced.length === 0 && unverified.length === 0) {
    return readinessCheck({
      id: 'souls.referenced',
      status: 'ready',
      message: souls.length === 0
        ? 'no active souls in the census'
        : `every active soul is pinned to a checkout (${souls.length})`,
      evidence: { active: souls.length },
    });
  }
  const shown = unreferenced.slice(0, 5).join(', ')
    + (unreferenced.length > 5 ? `, and ${unreferenced.length - 5} more` : '');
  return readinessCheck({
    id: 'souls.referenced',
    status: 'warning',
    code: unreferenced.length > 0 ? 'souls-unreferenced' : 'souls-unverified',
    message: unreferenced.length > 0
      ? `${unreferenced.length} active soul(s) have no verified pin in their recorded checkouts: ${shown}`
      : `${unverified.length} active soul(s) could not be checked against their recorded checkouts`,
    action: unreferenced.length > 0
      ? 'run agent-bot setup-worktree in a checkout that should keep one; verify other checkouts and active sessions before considering retirement'
      : 'rerun doctor; if this persists, inspect Git and system load',
    evidence: { active: souls.length, unreferenced, unverified },
  });
}

// A copied soul folder carries the soul's marker (#80). agent-bot only runs
// the soul from its registered folder; this names the copies to remove.
// Reported only when there is something to report.
function duplicateSoulDirsCheck({ home, env, config }) {
  let duplicates;
  try { duplicates = duplicateSoulDirs({ home, env, config, file: populationFile({ home, env }) }); }
  catch { return null; } // spaces.home already reports an unreadable census
  if (duplicates.length === 0) return null;
  const shown = duplicates.slice(0, 5).map(({ agentId, soulDir, copies }) =>
    `${agentId} (${soulDir ? `its folder ${soulDir}; copies ${copies.join(', ')}` : `no registered folder among ${copies.join(', ')}`})`).join('; ')
    + (duplicates.length > 5 ? `; and ${duplicates.length - 5} more` : '');
  return readinessCheck({
    id: 'souls.folders',
    // A warning: the soul still runs from its own folder, and no copy is used.
    status: 'warning',
    code: 'soul-folder-duplicate',
    message: `${duplicates.length} soul(s) are claimed by more than one folder: ${shown}`,
    action: 'keep each soul\'s own folder, move the copies out of the souls folder or delete them, then rerun doctor',
    evidence: { duplicates },
  });
}

// Each active soul's environment (#583 slice 6): the readiness problems
// `soul env` reports, through the same descriptor, as one finding per soul
// naming the problem codes. An error-severity problem fails the check, a
// warning warns, and the action is the first problem's own fix. Doctor
// never provisions or rebuilds anything here; the descriptor is read-only.
function soulEnvironmentChecks({ home, env, config }) {
  let souls;
  try { souls = listSouls({ file: populationFile({ home, env }) }).filter((soul) => soul.status === 'active' && typeof soul.soulDir === 'string'); }
  catch { return []; } // spaces.home already reports an unreadable census
  return souls.map((soul) => {
    const label = `${soul.displayName ?? soul.name ?? soul.id} (${soul.id})`;
    let described;
    try { described = readSoulEnvironment(soul.id, { home, env, config }); }
    catch (error) {
      return readinessCheck({
        id: 'souls.environment',
        status: 'warning',
        code: 'soul-env-unreadable',
        message: `soul ${label}: its environment could not be described (${error.code ?? 'error'})`,
        action: `inspect it with: agent-bot soul env ${soul.id}`,
        evidence: { agentId: soul.id, soulDir: soul.soulDir, ready: null, problems: [], errors: [] },
      });
    }
    const problems = described.readiness.problems;
    const errors = problems.filter((problem) => problem.severity === 'error');
    // The fix to name first: an error's own command, then a warning's.
    const first = errors.find((problem) => problem.action) ?? errors[0] ?? problems.find((problem) => problem.action) ?? problems[0] ?? null;
    return readinessCheck({
      id: 'souls.environment',
      status: errors.length > 0 ? 'failed' : problems.length > 0 ? 'warning' : 'ready',
      code: errors.length > 0 ? 'soul-env-not-ready' : problems.length > 0 ? 'soul-env-warnings' : null,
      message: problems.length === 0
        ? `soul ${label}: environment ready`
        : `soul ${label}: ${errors.length > 0 ? `${errors.length} environment problem(s), ${problems.length - errors.length} warning(s)` : `${problems.length} environment warning(s)`}: ${problems.map((problem) => problem.code).join(', ')}`,
      action: first ? (first.action ?? `see: agent-bot soul env ${soul.id}`) : null,
      evidence: { agentId: soul.id, soulDir: described.root.soulDir, ready: described.readiness.ready,
        problems: problems.map((problem) => problem.code), errors: errors.map((problem) => problem.code) },
    });
  });
}

// A soul folder whose soul is retired or unknown here (#419): left by a
// launch that failed before rollback existed, or by a retirement that kept
// the folder. Reported only when there is something to report.
function orphanSoulDirsCheck({ home, env, config }) {
  let orphans;
  try { orphans = orphanSoulDirs({ home, env, config, file: populationFile({ home, env }) }); }
  catch { return null; } // spaces.home already reports an unreadable census
  if (orphans.length === 0) return null;
  const shown = orphans.slice(0, 5).map(({ agentId, path, status }) => `${path} (${agentId}, ${status})`).join('; ')
    + (orphans.length > 5 ? `; and ${orphans.length - 5} more` : '');
  return readinessCheck({
    id: 'souls.orphans',
    // A warning: nothing runs from these folders, but a folder holds its name.
    status: 'warning',
    code: 'soul-folder-orphan',
    message: `${orphans.length} soul folder(s) belong to no active soul: ${shown}`,
    action: 'run `agent-bot soul remove <agentId>` for each to archive its folder, then rerun doctor',
    evidence: { orphans },
  });
}

// The allowlist the committed hooks apply, and where it came from (#675).
// A malformed config is reported, not guessed around: the hooks refuse then.
function unmanagedEvidence(env, home) {
  try {
    const { authors, source } = unmanagedAuthors({ env, home });
    return { unmanaged_authors: authors, unmanaged_authors_source: source };
  } catch {
    return { unmanaged_authors: [], unmanaged_authors_source: 'invalid-config' };
  }
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
    const evidence = { class: 'uninstalled', ...unmanagedEvidence(env, home) };
    // Nothing selected is a valid policy, not a fault: every human-attributed
    // publish is refused (#675). Say so and how to choose otherwise.
    const none = evidence.unmanaged_authors_source === 'none';
    return readinessCheck({
      id: 'identity.class',
      status: 'warning',
      code: 'identity-uninstalled',
      message: none
        ? 'uninstalled or ephemeral session with no explicit unmanaged-author policy: committed hooks refuse every human-attributed commit and GitHub write'
        : 'uninstalled or ephemeral session: committed hooks refuse human-attributed commits and GitHub writes unless the actor is an unmanaged allowlisted author',
      action: none
        ? 'on a host you will keep, run the source checkout bootstrap; to let named humans publish as themselves, select settings.unmanaged_authors in the organization profile, settings.unmanagedAuthors in the agent-bot config, or set AGENT_BOT_UNMANAGED_AUTHORS'
        : 'on a host you will keep, run the source checkout bootstrap',
      evidence,
    });
  }
}

function installedCliCheck({ home, lstat, readlink, statFile }) {
  const paths = installationPaths(home);
  let stat;
  let link;
  const evidence = { path: paths.executable };
  try {
    stat = optionalLstat(paths.executable, lstat);
    if (stat?.isSymbolicLink()) {
      evidence.target = readlink(paths.executable);
      evidence.resolved_target = resolve(dirname(paths.executable), evidence.target);
      link = inspectExecutableLink(paths.executable, stat, { readlink: () => evidence.target, statFile });
    }
  } catch (error) {
    return readinessCheck({
      id: 'runtime.installed_cli',
      status: 'failed',
      code: 'installed-cli-unreadable',
      message: 'the installed agent-bot entrypoint could not be inspected',
      action: 'repair the entrypoint target or permissions, then run the source checkout bootstrap with --machine-only',
      evidence: { ...evidence, error_code: error.code ?? null },
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
  if (link?.dangling) {
    return readinessCheck({
      id: 'runtime.installed_cli',
      status: 'failed',
      code: 'installed-cli-dangling',
      message: `the installed agent-bot symlink target is missing: ${link.target}`,
      action: 'run the source checkout bootstrap with --machine-only to preserve the dangling link in a unique backup and install this checkout',
      evidence,
    });
  }
  if (!isManagedExecutable(paths.executable, stat, SOURCE_ENTRYPOINT, () => link.target)) {
    return readinessCheck({
      id: 'runtime.installed_cli',
      status: 'failed',
      code: 'installed-cli-unmanaged',
      message: `the installed agent-bot entrypoint is not managed by this checkout${link ? ` (target: ${link.target})` : ''}`,
      action: 'move the foreign entrypoint aside, then run the source checkout bootstrap',
      evidence,
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
    configured = git(['config', '--global', '--get', 'core.hooksPath'], { cwd, env: readinessGitEnv(env) });
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
  const affected = rows.filter((row) => row.status !== 'verified' || row.stale);
  const warning = affected.length > 0;
  return readinessCheck({
    id: 'hooks.coverage',
    status: warning ? 'warning' : 'ready',
    code: warning ? 'hook-coverage-unverified' : null,
    message: warning
      ? `harness hook dialect review needed: ${affected.map((row) => `${row.key} (${row.status}${row.stale ? ', stale' : ''})`).join(', ')}`
      : 'harness hook coverage is current',
    action: warning ? 'update agent-bot, then run: agent-bot bootstrap --machine-only; remaining stale or unverified dialects need runtime maintainer verification' : null,
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

function runtimeSkillCheck({ home, lstat, readlink, access, embeddedRoot = null, app = null }) {
  const executable = installationPaths(home).executable;
  // An app-embedded runtime carries its skill bundle in place (#428).
  let runtimeRoot = embeddedRoot;
  try {
    const stat = runtimeRoot ? null : optionalLstat(executable, lstat);
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
      action: app
        ? `reinstall ${basename(app, '.app')} from its latest release; its skill bundle is incomplete`
        : 'restore the checkout from the reviewed release, then rerun bootstrap',
      ...(app ? { evidence: { install: 'app' } } : {}),
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
  env = readinessGitEnv(env);
  const githubIdentityEnabled = isGateEnabled('github-identity', { env, home, config });
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
  const primary = resolve(gitDir) === resolve(commonDir);
  // Every subprocess in this probe — including the pin reads inside
  // resolve-agent.mjs — must run through the injected runner with the caller's
  // sanitized env, so ambient Git overrides cannot answer for the worktree.
  const run = (args, { cwd: probeCwd = cwd } = {}) => git(args, { cwd: probeCwd, env });
  const probe = gitProbe(git, cwd, env);
  let slug = null;
  let slugFailed = false;
  try {
    // Stated identity only (ENG-0339): GH_AGENT_APP, the pin, the account.
    // Harness detection does not make a checkout a bot's, so it is not what
    // doctor verifies.
    slug = resolveAgentSlug({ env, cwd, config, git: run, detect: false });
  } catch (error) {
    slugFailed = true;
  }
  // A primary checkout with no stated bot identity is the human's own (the
  // owner's account, delegate mode): nothing to verify, by design. With one
  // — an agent account, GH_AGENT_APP, or a pin — it is verified exactly like
  // a linked worktree: every checkout in an agent account is bot work.
  if (primary && !slug && !slugFailed) {
    return {
      status: 'not_applicable',
      checks: [readinessCheck({
        id: 'worktree.kind',
        status: 'warning',
        code: 'primary-checkout',
        message: 'primary checkout with no bot identity — human persona (by design)',
      })],
    };
  }

  const checks = [readinessCheck({
    id: 'worktree.kind',
    status: 'ready',
    message: primary ? 'primary checkout' : 'linked worktree',
  })];
  const noAppAddon = !githubIdentityEnabled && !slug && !slugFailed;
  try {
    if (slugFailed) resolveAgentSlug({ env, cwd, config, git: run, detect: false });
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
  if (!slug && !noAppAddon) {
    if (!slugFailed) {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'failed',
        code: 'worktree-app-missing',
        message: 'no App identity resolves for this checkout',
        action: 'run: agent-bot setup-worktree <app-slug>',
      }));
    }
  } else if (slug) {
    let pin = null;
    let pinError = null;
    try {
      pin = pinnedSlug(cwd, { git: run });
    } catch (error) {
      pinError = safeGitErrorCode(error);
    }
    // Layout only (ENG-0339): which harness's `.<tool>/worktrees` directory
    // the checkout sits in, reported as evidence, never used to decide.
    const worktree_layout = territoryHarness(cwd);
    if (pinError) {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'failed',
        code: 'worktree-pin-unreadable',
        message: 'the worktree App pin could not be read',
        action: 'rerun doctor; if this persists, repair the worktree App pin',
        evidence: { app_slug: slug, worktree_layout, git_error: pinError },
      }));
    } else if (pin !== slug) {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'failed',
        code: pin ? 'worktree-app-mismatch' : 'worktree-app-unpinned',
        message: 'worktree App identity is not pinned to the resolved App',
        action: 'run: agent-bot setup-worktree',
        evidence: { app_slug: slug, worktree_layout },
      }));
    } else {
      checks.push(readinessCheck({
        id: 'worktree.app',
        status: 'ready',
        message: `App identity ${slug}`,
        evidence: { app_slug: slug, worktree_layout },
      }));
    }
  }

  if (noAppAddon) {
    // This checkout intentionally has no GitHub attribution, signing policy,
    // hooks, remote rewrite, or App credential helper.
  } else {
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
  }

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
      if (!primary) checks.push(worktreePinOriginCheck({ gitDir: resolve(gitDir), agentId }));
      const appRecord = appRecordCheck({ agentId, slug, config,
        readIdentity: (id) => readAgentIdentity(id, { stateDir: stateDirectory({ env, home }) }) });
      if (appRecord) checks.push(appRecord);
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

  if (!noAppAddon) {
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
  }

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

// An app-embedded runtime (#428): GeniusBar installs no ~/.local/bin
// entrypoint, git hooks or organization config by design, so those checks do
// not apply there, and a missing shell PATH entry only needs its menu item.
function embeddedRuntimeCheck(app) {
  return readinessCheck({
    id: 'runtime.installed_cli',
    status: 'ready',
    message: `agent-bot runs inside ${basename(app)} (${app})`,
    evidence: { install: 'app', app },
  });
}

// The app supervises the daemon under `<bundle id>.agent-bot` (GeniusBar's
// bridge sets AGENT_BOT_SERVICE_LABEL so), which a shell running the app's
// agent-bot does not inherit; read the bundle id to find that unit.
function appServiceEnv(app, env) {
  if (env.AGENT_BOT_SERVICE_LABEL) return env;
  try {
    const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8');
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9_][A-Za-z0-9_.-]*)<\/string>/.exec(plist)?.[1];
    return id ? { ...env, AGENT_BOT_SERVICE_LABEL: `${id}.agent-bot` } : env;
  } catch {
    return env;
  }
}

function notUsedByApp(check, app, message) {
  if (check.status !== 'failed') return check;
  return readinessCheck({ id: check.id, status: 'not_applicable', code: check.code,
    message: `${message} (not used by ${basename(app, '.app')})`, evidence: { install: 'app' } });
}

// GeniusBar installs no user-level identity hook: the souls it runs carry
// their own identity, so a missing hook is not an "ephemeral session" there and
// the source-checkout bootstrap is the wrong advice.
function appIdentityClassCheck(check, app) {
  if (check.status === 'ready') return check;
  const name = basename(app, '.app');
  return readinessCheck({ id: check.id, status: 'not_applicable', code: check.code,
    message: `no user-level identity hook (not used by ${name}; the souls it runs carry their own identity)`,
    evidence: { class: 'app', install: 'app' } });
}

// The app owns its daemon's launchd unit and environment; `agent-bot install`
// from a shell would install a second, differently labelled service.
function appServiceAction(check, app) {
  if (check.status !== 'failed') return check;
  const name = basename(app, '.app');
  return readinessCheck({ ...check,
    action: `open ${name} and choose Set up; it installs and restarts its own services` });
}

function appShellPathCheck(check, app) {
  if (check.status !== 'failed') return check;
  return readinessCheck({ id: check.id, status: 'warning', code: check.code,
    message: `agent-bot is not on PATH for your shells; souls ${basename(app, '.app')} runs do not need it`,
    action: `in ${basename(app, '.app')}, choose Command-line tools… to add agent-bot to your PATH`,
    evidence: { install: 'app' } });
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
  statFile = statSync,
  readlink = readlinkSync,
  exists = existsSync,
  access = accessSync,
  load = loadConfig,
  inspectCredentials = inspectAppCredentials,
  inspectKeyStores = appKeyStores,
  inspectSpace = inspectSoulSpace,
  inspectDaemonSupervisor = inspectSupervisor,
  inspectCutover = inspectSpacesCutover,
  inspectShellGh = inspectShellGhShim,
  inspectCodexDesktopGh = inspectConfiguredCodexDesktopGh,
  probeDaemon = daemonStatus,
  isSoulBoundImpl = isSoulBound,
  readBindingImpl = readBinding,
  probeSecretStore = defaultProbeSecretStore,
  readPackageVersion = readManifestVersion,
  installedCliVersion: resolveInstalledVersion = installedCliVersion,
  listHarnessMcpServers = defaultListHarnessMcpServers,
  probeSessionContext = defaultProbeSessionContext,
  // Off unless doctor --probe-inbox passes a probe: the default run makes no
  // network call to the inbox.
  probeInbox = null,
  embeddingApp = embeddingAppBundle(ROOT),
} = {}) {
  const machineChecks = [];
  const app = embeddingApp;
  let config = {};
  let configValid = true;
  let mappings = [];
  let roster = [...new Set(explicitApps)].sort();

  if (scope !== 'worktree') {
    machineChecks.push(nodeCheck(nodeVersion));
    machineChecks.push(gitCheck({ cwd, env, git }));
    machineChecks.push(app ? embeddedRuntimeCheck(app) : installedCliCheck({ home, lstat, readlink, statFile }));
    const identityClass = identityClassCheck({ home, env, access });
    machineChecks.push(app ? appIdentityClassCheck(identityClass, app) : identityClass);
    const shellPath = shellPathCheck({ home, env, spawn });
    machineChecks.push(app ? appShellPathCheck(shellPath, app) : shellPath);
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
        const runtimeConfig = configCheck({
          config,
          detectedHarness: detectHarness(env),
          mappings,
        });
        machineChecks.push(app && runtimeConfig.code === 'config-missing'
          ? notUsedByApp(runtimeConfig, app, 'no organization runtime config is installed')
          : runtimeConfig);
      }
      if (Object.keys(config).length > 0) {
        machineChecks.push(organizationProfileCheck(config));
      }
      machineChecks.push(featureGatesCheck({ home, env, config }));
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
    const account = accountName(env);
    if (app && configValid && Object.keys(config).length === 0) {
      machineChecks.push(readinessCheck({
        id: 'account.app',
        status: 'not_applicable',
        message: `no organization config, so no account-level bot identity (not used by ${basename(app, '.app')})`,
        evidence: { account, install: 'app' },
      }));
    } else if (!configValid || Object.keys(config).length === 0) {
      machineChecks.push(readinessCheck({
        id: 'account.app',
        status: 'failed',
        code: 'account-config-unavailable',
        message: 'account identity cannot be classified without a valid runtime config',
        action: 'restore the organization runtime config/profile, then rerun doctor',
        evidence: { account },
      }));
    } else {
      const identity = configuredAccountIdentity(config, account);
      const harness = identity?.harness ?? null;
      const slug = identity?.slug ?? null;
      machineChecks.push(readinessCheck({
        id: 'account.app',
        status: slug ? 'ready' : 'not_applicable',
        message: slug
          ? `account ${account} resolves to App ${slug}`
          : 'no configured App matches the OS account — no account-level bot identity',
        evidence: { account, harness, app_slug: slug },
      }));
    }
    const hooks = hooksCheck({ home, cwd, env, git, access });
    machineChecks.push(app ? notUsedByApp(hooks, app, 'agent-bot git hooks are not installed') : hooks);
    const serviceEnv = app ? appServiceEnv(app, env) : env;
    const supervisor = supervisorCheck({ home, env: serviceEnv, inspect: inspectDaemonSupervisor });
    machineChecks.push(app ? appServiceAction(supervisor, app) : supervisor);
    const daemonHealth = await daemonHealthCheck({
      home,
      env: serviceEnv,
      probe: probeDaemon,
      skipLoad: supervisorSkipLoad(serviceEnv),
    });
    machineChecks.push(app ? appServiceAction(daemonHealth, app) : daemonHealth);
    machineChecks.push(spacesRootCheck({ home, env, config }));
    machineChecks.push(spacesHomeCheck({ home, env, config, inspectCutover }));
    const unreferencedSouls = unreferencedSoulsCheck({ home, env, git });
    if (unreferencedSouls) machineChecks.push(unreferencedSouls);
    const soulFolders = duplicateSoulDirsCheck({ home, env, config });
    if (soulFolders) machineChecks.push(soulFolders);
    const orphanFolders = orphanSoulDirsCheck({ home, env, config });
    if (orphanFolders) machineChecks.push(orphanFolders);
    machineChecks.push(...soulEnvironmentChecks({ home, env, config }));
    const bindingSummary = worktreeBindingSummaryCheck({ home, env, roster });
    if (bindingSummary) machineChecks.push(bindingSummary);
    if (configValid) machineChecks.push(keyStoreCheck({ roster, home, env, config, inspect: inspectKeyStores }));
    machineChecks.push(secureStoreCheck({ probe: probeSecretStore }));
    machineChecks.push(secureStoreLauncherSessionCheck({
      discovery: launcherSessionContexts({ home, env, statFile }),
      probeSessionContext,
    }));
    machineChecks.push(inboxConfigurationCheck({
      env,
      harnesses: listHarnessMcpServers({ home, cwd }),
    }));
    if (probeInbox) machineChecks.push(await inboxReachabilityCheck({ env, probe: probeInbox }));
    machineChecks.push(versionSkewCheck({
      home,
      cwd,
      exists,
      readVersion: readPackageVersion,
      installedVersion: (options) => resolveInstalledVersion({ ...options, readVersion: readPackageVersion }),
    }));
    const coverage = coverageCheck(now);
    // Hook dialect coverage concerns the agent-bot hooks the app never installs.
    machineChecks.push(app && coverage.status === 'warning'
      ? notUsedByApp({ ...coverage, status: 'failed' }, app, 'harness hook dialects are reviewed for installed hooks only')
      : coverage);
    if (configValid) {
      machineChecks.push(readinessCheck({
        id: 'hooks.claude_worktree',
        ...inspectClaudeWorktreeAdapter({ home, env, config }),
      }));
    }
    machineChecks.push(ghShimCheck({ home, required: expectedGhShim, inspect: inspectShellGh }));
    machineChecks.push(codexDesktopGhCheck({ home, inspect: inspectCodexDesktopGh }));
    machineChecks.push(runtimeSkillCheck({ home, lstat, readlink, access, embeddedRoot: app ? ROOT : null, app }));
  } else {
    try {
      config = load({ home, env });
      // The worktree section verifies the current checkout's App against the
      // configured roster, so the roster has to be resolved here too. Skipping it
      // leaves roster empty, which would silently accept any App as in-roster.
      roster = configuredAppSlugs(config, explicitApps);
      if (roster.some((slug) => typeof slug !== 'string' || !APP_SLUG_RE.test(slug))) {
        configValid = false;
        roster = [];
      }
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
          home, env, config,
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
    // Appended, not prepended: the existing worktree checks own their ordering,
    // and firstActionableFailure already scans every check in the section. The
    // status is recomputed from the complete list because this check can fail,
    // and a section that reports `ready` while holding a `failed` check would
    // leave report.ready true and doctor exiting 0 on an identity failure.
    const bindingCheck = currentWorktreeBindingCheck({
      cwd, env, git, roster: configValid ? roster : [],
      isSoulBoundImpl, readBindingImpl,
    });
    const bindingChecks = [...worktree.checks, bindingCheck];
    worktree = {
      status: worktree.status === 'not_applicable'
        ? 'not_applicable'
        : sectionStatus(bindingChecks),
      checks: bindingChecks,
    };
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
