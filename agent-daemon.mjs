#!/usr/bin/env node

// Local loopback daemon v0: one machine trust boundary for soul registration,
// Agent Space ensure/path, and population listing, wrapping the same on-disk
// stores the CLI uses in-process. Binding is fail-closed to loopback — there
// is no LAN mode, and a request that somehow arrives from a non-loopback peer
// is refused before it is routed. A per-start bearer token in the 0600 state
// file keeps other local accounts on a shared machine from driving the daemon
// through the (necessarily shared) loopback interface.
//
//   agent-bot daemon run             — foreground server (supervised launch)
//   agent-bot daemon start           — detach a background `run`, wait healthy
//   agent-bot daemon status [--json] — probe the recorded daemon
//   agent-bot daemon stop            — terminate the recorded daemon
//   agent-bot daemon vouch-key       — print the account Ed25519 public key (SPKI PEM)
//   agent-bot daemon pair-comms [--broker <account>]
//                                    — pair this account's daemon with the
//                                      agent-comms broker (prints the owner
//                                      approval code); status shows the
//                                      pairing and the account-watch link.
//   agent-bot daemon install [--json] — supervise this runtime's daemon (node
//                                      and entry as running now) under
//                                      AGENT_BOT_SERVICE_LABEL; rewritten and
//                                      reloaded only when that changed (#302)
//
// v0 scope per #41: register soul, space ensure, space path, population list.
// No OAuth, no remote sync, no HTTPS — loopback is the boundary (#35).
//
// v1 adds the transport-neutral interaction contract (#55): sessions,
// messages, invocation status, ordered events, cancellation, and artifact
// references, served by agent-interaction.mjs over the durable job store
// (agent-jobs.mjs) with deny-by-default principal authorization
// (agent-principals.mjs). /v0 semantics are unchanged. Requests carry the
// adapter-authenticated (transport, providerId) pair; the daemon resolves it
// to a locally enrolled principal and refuses everything else — nothing on
// this remote surface can enroll a principal or widen an authorization.
//
// /ui/... serves the private web client (#59) from agent-web.mjs: static PWA
// assets plus a cookie-authenticated JSON API over the same interaction
// service. /ui routes never see the bearer token — browser auth is a local
// pairing ceremony — and they change nothing about the loopback boundary:
// the same peer check runs before any /ui routing.
//
// POST /v0/vouch (#254, ADR-0008 decision 3) sits behind that loopback gate
// but not the bearer. The caller presents a binding secret in
// x-agent-binding and receives a five-minute Ed25519 soul token. The signing
// key is created once per account; `daemon vouch-key` prints its SPKI form.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertPrivateGitDir, childBindingPath, consumeBindToken, createBindingRegistry, lookupBinding as lookupRegistryBinding, readBinding, readBindToken } from './agent-binding.mjs';
import { spacePath } from './agent-space.mjs';
import { createSoulHistory } from './soul-history.mjs';
import { ensureSoulSpace, soulSpacePath } from './soul-memory.mjs';
import { archiveSoulDirs, backfillManagedSouls, displayName, listSouls, locateSoulDir, populationFile, recordHarnessAuth, recordSoulSighting, recordSoulDisplayName, recordSoulLaunch, retireIdentityWithPopulation, setSoulComms, setSoulComputerUse, soulComputerUse, setSoulPaused, soulPaused, showSoul, soulDirectory, upsertIdentitySoul, withRoles } from './agent-population.mjs';
import { spawnSoulTemplate } from './soul-templates.mjs';
import {
  bindAgentLineage,
  ensureAgentIdentity,
  mintAgentIdentity,
  readAgentIdentity,
  stateDirectory,
  validateAgentId,
} from './agent-identity.mjs';
import { createInteractionService } from './agent-interaction.mjs';
import { mint } from './mint-token.mjs';
import { KEYD_TOOL_NAMES, grantTarget, keydRequest, mintViaKeyd, readKeydRecord, signKeydGrant } from './keyd-client.mjs';
import { recoverInteractionStore } from './agent-jobs.mjs';
import { boundRepository, createInboxTaker, inboxError } from './inbox-take.mjs';
import { createComputerUseActivity } from './computer-use-activity.mjs';
import { isComputerUse } from './permission-risk.mjs';
import { appendAuditReceipt, assertAuthorized, principalsFile, resolvePrincipal } from './agent-principals.mjs';
import { validateApprovalScope } from './session-approvals.mjs';
import { approvalAction, shown } from './approval-action.mjs';
import { confirmOwnerPresence, ownerCredentialRequired, verifyPrincipalOwner } from './owner-action.mjs';
import { runSpawnHooks } from './agent-hook.mjs';
import { createWebLayer } from './agent-web.mjs';
import { loadOrCreateVouchKey, signSoulToken, vouchStateDir } from './vouch.mjs';
import { PROOF_HEADER, parseBindingProof } from './binding-proof.mjs';
import {
  daemonClient, daemonStateFile, LOOPBACK_HOSTS, probeDaemonHealth as probeHealth,
  readDaemonState as readStateFile, SCHEMA_VERSION,
} from './daemon-client.mjs';
// Re-exported for importers that predate daemon-client.mjs (#645).
export { daemonClient, daemonStateFile };
import { joinLaunchedSoul, leaveLaunchedSoul } from './comms-membership.mjs';
import { daemonStatus } from './daemon-status.mjs';
import { soulEnvironment, userToolDirs } from './shell-path.mjs';
// Re-exported for importers that predate the step-3b moves (#645).
export { daemonStatus, joinLaunchedSoul, leaveLaunchedSoul, soulEnvironment, userToolDirs };
import { createCommsSupervisor, pairDaemonComms, readCommsStatus } from './comms-client.mjs';
import { attachWakeEndpoint } from './agent-wake.mjs';
import { resolveSoulMode } from './soul-mode.mjs';
import { createIdentityAppJobs, identityAppOperation, identityAppFailure, listIdentityApps } from './identity-apps.mjs';
import { readSoulProfile } from './soul-profile.mjs';
import { readSoulEnvironment } from './soul-env.mjs';
import { launchSandbox, readSandboxStatus, turnSandboxProblem, setSandboxAccount, setSandboxEnabled, setSandboxOverride, validateSandboxAccount } from './sandbox.mjs';
import { checkSopLaunchPolicy } from './sop.mjs';
import { soulModel, setSoulModel, recordSoulModels } from './soul-model.mjs';
import { ownerGate as soulSettingOwnerGate, readColdWakeSettings, setColdWake } from './cold-wake-settings.mjs';
import { isGateEnabled, loadConfig } from './config.mjs';
import { createLaunchHandler, launchCommsSetting } from './daemon-launch.mjs';
import { createDaemonLogCheck, daemonLogPath, DAEMON_LOG_CHECK_INTERVAL_MS } from './daemon-log.mjs';
import { createTeamStarter, defaultTeamTemplate, harnessLaunchProblem, harnessLaunchRefusal, teamLimits } from './team-start.mjs';
import { createSoulHomes, installHarnesses, soulBindingForLaunch, soulHomePath, soulNpmHarnessDirs } from './soul-home.mjs';
import { harnessAuth } from './harness-auth.mjs';
import { createWebhookWaker, readWebhook } from './wake-webhook.mjs';
import { ACP_SPAWN_REGISTRY, defaultHarnessFor, onPath } from './acp-registry.mjs';
import { computePackageRevision, soulCredentialsDeclaration, validateSoulPackage, writeSoulComms } from './soul-package.mjs';
import { pendingSoulToolHome, prepareSoulToolHome, soulToolHomeEnv } from './soul-env-migrate.mjs';
import { harnessInstallDeclared, pendingSoulRuntimes, provisionSoulRuntimes, soulRuntimeEnv } from './soul-runtimes.mjs';
import { checkSoulProvider, pendingSoulProvider, soulProviderEnv } from './soul-secrets.mjs';
import { editSoulRevision, listSoulProposals, revisionCommand, revisionHistory } from './soul-revisions.mjs';
import { acpExecutorFor, composeTurnEnv, createWakePlane, createTurnRegistry } from './wake-plane.mjs';
import { recordSoulSession } from './metrics.mjs';
import { createTaskReporter } from './task-turns.mjs';
import { createCommsRelay, senderAddress } from './comms-relay.mjs';
import { recordDeliveredAside } from './soul-asides.mjs';
import { createResumeExecutor, createWakeSessions, resumePath, wakeSessionsFile } from './wake-resume.mjs';
import { migratePreGateConfig } from './config-migration.mjs';
import { createDreamService, dreamControlRequest } from './skill-dream-service.mjs';
import { verifyDreamRevisionEvidence } from './skill-dream-evidence.mjs';

const LOGIN_PATH_MARK = '__agent_bot_login_path__';

/**
 * The PATH the user's login shell builds (its .zshenv and .zprofile), read
 * once when the daemon starts, or null when it cannot be read within the
 * timeout. AGENT_BOT_LOGIN_PATH=0 skips it.
 */
export function loginShellPath({ env = process.env, home = homedir(), run = execFileSync, timeoutMs = 3000 } = {}) {
  if (env.AGENT_BOT_LOGIN_PATH === '0') return null;
  const shell = env.SHELL && path.isAbsolute(env.SHELL) && ['zsh', 'bash', 'sh'].includes(path.basename(env.SHELL))
    ? env.SHELL : '/bin/zsh';
  try {
    const out = String(run(shell, ['-lc', `printf '%s%s' '${LOGIN_PATH_MARK}' "$PATH"`], {
      env: { HOME: home, USER: env.USER ?? '', LOGNAME: env.LOGNAME ?? env.USER ?? '', SHELL: shell,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(env.ZDOTDIR ? { ZDOTDIR: env.ZDOTDIR } : {}), TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, encoding: 'utf8',
    }));
    const at = out.lastIndexOf(LOGIN_PATH_MARK);
    if (at < 0) return null;
    const found = out.slice(at + LOGIN_PATH_MARK.length).trim().split(path.delimiter).filter((dir) => path.isAbsolute(dir));
    return found.length ? found.join(path.delimiter) : null;
  } catch { return null; }
}

/**
 * Rolls back a soul a launch spawned when its first start fails (#419): the
 * agent-comms membership while the soul can still vouch, then the identity
 * and census row, then its folder, archived so a retry can reuse the name.
 * `rollback` is how far the launch got: `{ binding, joined }`. Returns what
 * it did; a leave that fails is reported, not thrown, so the rest still runs.
 */
export async function discardFailedLaunch(agentId, { binding = null, joined = false } = {}, {
  env = process.env, home = homedir(), config, now = () => new Date(), leave = (soul) => leaveLaunchedSoul(soul, { env }),
} = {}) {
  let left = !joined;
  if (joined) { try { left = await leave({ agentId, binding }); } catch { /* reported as left: false; the soul is still retired */ } }
  const file = populationFile({ env, home });
  retireIdentityWithPopulation(agentId, { file, stateDir: stateDirectory({ env, home }), now });
  const archived = archiveSoulDirs(agentId, { env, home, ...(config === undefined ? {} : { config }), now, file });
  return { left, archived };
}

/**
 * A soul an interactive session set up with `setup-worktree` or `agent-bot
 * join` has no daemon binding: its worktree's git config pins the identity
 * instead. The population still records that worktree, so a resume or
 * webhook wake (#323, #334) can run there. A soul with no usable recorded
 * worktree — one made by `soul spawn` and never joined from a checkout —
 * falls back to its own soul directory, which its `.soul-state/agent-id`
 * marker proves is this soul's (#382). Resolves { agentId, worktree,
 * file: null }, or null when the soul is not active or neither place is
 * provably this soul's.
 */
export function recordedWorktree(agentId, { env = process.env, home = homedir() } = {}) {
  let soul;
  const file = populationFile({ env, home });
  try { soul = listSouls({ status: 'active', file }).find((record) => record.id === agentId); }
  catch { return null; }
  if (!soul) return null;
  const worktree = typeof soul.worktree === 'string' && path.isAbsolute(soul.worktree) ? soul.worktree : null;
  if (worktree && pinnedTo(worktree, agentId)) return { agentId, worktree, file: null };
  let directory = null;
  try { directory = soulDirectory(agentId, { env, home, file }); } catch { return null; }
  try {
    if (statSync(directory).isDirectory()
        && readFileSync(path.join(directory, '.soul-state', 'agent-id'), 'utf8').trim() === agentId) {
      return { agentId, worktree: directory, file: null };
    }
  } catch { /* no soul directory, or not this soul's */ }
  return null;
}

// A stale record or a repinned checkout must not run a wake as the wrong
// soul: the worktree's own pin has to name this soul.
function pinnedTo(worktree, agentId) {
  try { if (!statSync(worktree).isDirectory()) return false; } catch { return false; }
  try {
    return execFileSync('git', ['-C', worktree, 'config', '--get', 'agentBot.agentId'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() === agentId;
  } catch { return false; }
}

const MAX_BODY_BYTES = 64 * 1024;
const VOUCH_LIMIT = 60;
const VOUCH_WINDOW_MS = 60_000;
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The daemon never negotiates its bind address. Anything that is not a
// loopback literal is refused before listen(), so a configuration mistake
// cannot quietly open the population and space stores to a network.
export function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`daemon host must be a loopback literal (127.0.0.1 or ::1), not ${JSON.stringify(host)}`);
  }
  return host;
}

export function isLoopbackPeer(remoteAddress) {
  return LOOPBACK_PEERS.has(remoteAddress);
}

function writeStateFile(file, state) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented ?? '', 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop consuming but keep the socket writable so the 413 response can
        // actually reach the client before the connection closes.
        req.removeAllListeners('data');
        req.pause();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  if (raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 });
  }
  return parsed;
}

function requireAgentId(value) {
  try {
    return validateAgentId(value);
  } catch {
    // validateAgentId messages can reflect their input; the daemon answers
    // with a stable, non-reflecting error instead.
    throw Object.assign(new Error('invalid Agent ID'), { statusCode: 400 });
  }
}

// The store modules already keep their error messages secret-free (they never
// quote file contents), so their messages are safe to return verbatim; only
// the status code is decided here.
function operationError(error) {
  if (Number.isSafeInteger(error.statusCode)) return error;
  return Object.assign(new Error(error.message), { statusCode: 409 });
}

export function createDaemonServer({
  env = process.env,
  home = homedir(),
  config,
  token = randomBytes(32).toString('hex'),
  executor,
  turns = createTurnRegistry(),
  taskReporter = null,
  mintImpl = mint,
  // agent-bot-keyd's socket call (#397); tests pass a fake keyd.
  keydCall = keydRequest,
  // take_inbox's broker call (#229): ({ app, repo }) => { event }. The default
  // reads the bearer from pass-cli and the URL from this process's env.
  inboxTake = createInboxTaker({ env }),
  spawnHook = runSpawnHooks,
  now = () => new Date(),
  computerUse = createComputerUseActivity({ now }),
  // #253 replaces this with its persistent lookup. The default reads the
  // in-memory registry and does not change how bindings are stored.
  lookupBinding: lookupBindingOverride = null,
  // Live comms watch state for GET /v0/comms/status. The supervisor is owned
  // by runDaemon; tests and embedding callers pass a stub with getState().
  comms = null,
  // Same mailbox reader as cold wake; tests inject a broker-free relay.
  asideRelay = createCommsRelay({ env: soulEnvironment(env, { home }) }),
  // POST /v0/team/start (#377): (callerAgentId, body) => { agentId, ... }.
  // runDaemon wires it to the launch handler; null refuses the route.
  teamStarter = null,
  // Deciding a soul's tool request asks for the owner's presence (#438):
  // (action, { principal }) => proof, throwing when the owner does not
  // confirm. Tests pass a fake; the default asks keyd, then the dialog.
  ownerGate = (action, { principal }) => confirmOwnerPresence(action, { env, principal }),
  // Settings accept a verified principal instead of presence, like soul mode.
  settingGate = (action, { principal }) => soulSettingOwnerGate(action, { principal, env, cwd: home }),
  revisionPrincipal = (credential) => verifyPrincipalOwner(credential, { env }),
} = {}) {
  const appOptions = { env, home, gate: settingGate };
  const appJobs = createIdentityAppJobs(appOptions);
  // One interaction service per server so in-flight executions and their
  // cancellation controllers live exactly as long as the daemon.
  const interaction = createInteractionService({ env, home, config, executor, taskReporter, now, turns });
  // A decision lets a soul's tool run, so both decide routes ask the owner
  // first (#438): the daemon token proves only a process in this account, and
  // a transport principal only its provider login. The owner is asked about
  // the open proposal by soul and tool; a refusal decides nothing.
  async function confirmDecision({ proposalId, decision, scope = 'once', principal = null, transport = null, credential = null }) {
    if (decision !== 'approve' && decision !== 'deny') {
      throw Object.assign(new Error('decision must be approve or deny'), { statusCode: 400 });
    }
    validateApprovalScope(scope, decision);
    const proposal = interaction.listProposalsForOwner().proposals.find((row) => row.proposalId === proposalId);
    if (!proposal) throw Object.assign(new Error('proposal is no longer open'), { statusCode: 409 });
    if (principal) {
      // A principal that may not approve this soul is refused, and audited,
      // by the decision itself; it never gets to raise a prompt.
      try { assertAuthorized({ principal, agentId: proposal.agentId, operation: 'approve' }); } catch { return; }
    }
    try {
      await ownerGate(approvalAction(shown(proposal, { env, home }), decision, scope), { principal: credential });
    } catch (error) {
      appendAuditReceipt({
        event: 'approval-decision',
        agentId: proposal.agentId,
        operation: 'approve',
        decision: 'owner-refused',
        ...(principal ? { principalId: principal.principalId, transport } : {}),
      }, { env, home, now });
      throw Object.assign(new Error(`the owner did not confirm this decision: ${error.message}`), { statusCode: 403 });
    }
  }
  const bindings = createBindingRegistry({ now, file: path.join(vouchStateDir({ env, home }), 'bindings.json'), account: env.USER ?? process.env.USER ?? 'unknown' });
  const findBinding = lookupBindingOverride
    ?? ((secret) => lookupRegistryBinding(bindings, secret, { now }));
  // Per-binding vouch window. The map stores sha256(secret), never the secret.
  const vouchHits = new Map();
  let vouchKey = null;
  function signingKey() {
    if (!vouchKey) vouchKey = loadOrCreateVouchKey(vouchStateDir({ env, home }));
    return vouchKey.privateKey;
  }
  // Keyed per binding: the proof's key ID, or sha256 of an older client's
  // bare secret. Neither is the secret.
  function allowVouch(presented) {
    const key = typeof presented === 'string'
      ? createHash('sha256').update(presented, 'utf8').digest('hex')
      : parseBindingProof(presented.proof).keyId;
    const atMs = now().getTime();
    const recent = (vouchHits.get(key) ?? []).filter((stamp) => atMs - stamp < VOUCH_WINDOW_MS);
    if (recent.length >= VOUCH_LIMIT) {
      vouchHits.set(key, recent);
      return false;
    }
    recent.push(atMs);
    vouchHits.set(key, recent);
    return true;
  }
  // The private web client (#59) rides the same server and the same loopback
  // peer check; it authenticates browsers with its own pairing-code cookie
  // sessions instead of the bearer token, which never reaches page script.
  const web = createWebLayer({ env, home, config, interaction, daemonToken: token, now });
  let warmPool;
  const server = createServer(async (req, res) => {
    try {
      if (!isLoopbackPeer(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'loopback peers only' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
        await web.handle(req, res, url);
        return;
      }
      // Binding-authenticated and bearer-free (#254). Every other route still
      // requires the per-start bearer below.
      if (req.method === 'POST' && url.pathname === '/v0/vouch') {
        await handleVouchRequest({
          req, res, findBinding, allowVouch, signingKey, env, home, now,
        });
        return;
      }
      const authorization = req.headers.authorization ?? '';
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      // Even an invalid/expired binding marks a soul request. Refuse before
      // bearer auth, parsing the body, or attempting principal verification.
      const revisionAction = req.method === 'POST' && /^\/v0\/soul\/revisions\/(approve|reject|adopt|edit)$/.exec(url.pathname)?.[1];
      if (revisionAction && ('x-agent-binding' in req.headers || PROOF_HEADER in req.headers)) {
        appendAuditReceipt({ event: 'soul-revision', operation: revisionAction, decision: 'owner-credential-required' }, { env, home, now });
        throw ownerCredentialRequired('a soul binding cannot authorize an owner revision action');
      }
      const dreamAction = req.method === 'POST' && /^\/v0\/soul\/dream\/(register|pause|unschedule|run-now|cancel|ack-notice)$/.exec(url.pathname)?.[1];
      if (dreamAction && ('x-agent-binding' in req.headers || PROOF_HEADER in req.headers)) {
        appendAuditReceipt({ event: 'dream-control', operation: dreamAction, decision: 'owner-credential-required' }, { env, home, now });
        throw ownerCredentialRequired('a soul binding cannot authorize dream controls');
      }
      if (!['GET /v0/binding', 'DELETE /v0/binding', 'POST /v0/credential', 'POST /v0/inbox/take', 'POST /v0/keyd/grant', 'POST /v0/spawn', 'POST /v0/team/start', 'POST /v0/asides/delivered'].includes(`${req.method} ${url.pathname}`) && !tokensMatch(token, presented)) {
        sendJson(res, 401, { error: 'missing or invalid daemon token' });
        return;
      }
      if (url.pathname.startsWith('/v1/')) {
        await handleInteractionRequest({ req, res, url, interaction, env, home, confirmDecision });
        return;
      }
      // Same bearer and loopback checks as population; mutations also prove owner.
      if (url.pathname === '/v0/identity/apps' || url.pathname.startsWith('/v0/identity/apps/')) {
        try {
          if (req.method === 'GET' && url.pathname === '/v0/identity/apps') {
            sendJson(res, 200, listIdentityApps(appOptions));
          } else if (req.method === 'GET' && /^\/v0\/identity\/apps\/jobs\/[a-f0-9-]+$/.test(url.pathname)) {
            sendJson(res, 200, appJobs.get(url.pathname.split('/').at(-1)));
          } else if (req.method === 'POST' && /^\/v0\/identity\/apps\/(create|connect|rotate-key|assign|remove|addon)$/.test(url.pathname)) {
            let body;
            try { body = parseJsonBody(await readBody(req)); }
            catch { sendJson(res, 400, { error: 'Invalid App request JSON.', code: 'identity-app-invalid' }); return; }
            const action = url.pathname.split('/').at(-1);
            sendJson(res, action === 'create' ? 202 : 200, action === 'create'
              ? await appJobs.start(body) : await identityAppOperation(action, body, appOptions));
          } else sendJson(res, 404, { error: 'Unknown App route.', code: 'identity-app-not-found' });
        } catch (error) {
          const failure = identityAppFailure(error);
          sendJson(res, error.statusCode ?? 409, { error: failure.message, code: failure.code });
        }
        return;
      }
      const route = `${req.method} ${url.pathname}`;
      if (dreamAction || route === 'GET /v0/soul/dream' || route === 'GET /v0/soul/dream/history') {
        if (!server.dream) throw Object.assign(new Error('Dream service is unavailable.'), { code: 'dream-service-unavailable', statusCode: 503 });
        if (dreamAction) {
          const request = dreamControlRequest(dreamAction, parseJsonBody(await readBody(req)));
          const action = `soul dream ${request.agentId ?? request.runId} ${dreamAction}${request.schedule ? ` ${request.schedule}` : ''}${request.noticeId ? ` ${request.noticeId}` : ''}`;
          try { await settingGate(action, { principal: request.principal }); }
          catch (error) {
            appendAuditReceipt({ event: 'dream-control', agentId: request.agentId ?? null, operation: dreamAction, decision: 'owner-refused' }, { env, home, now });
            throw Object.assign(new Error('The owner did not authorize this dream control.'), { code: error.code ?? 'owner-credential-required', statusCode: 403 });
          }
          appendAuditReceipt({ event: 'dream-control', agentId: request.agentId ?? null, operation: dreamAction, decision: 'authorized' }, { env, home, now });
          // Authorization audit is required before execution. Its later outcome
          // receipt must not turn an applied control into an apparent failure.
          const outcomeAudit = decision => {
            try {
              appendAuditReceipt({ event: 'dream-control-outcome', agentId: request.agentId ?? null, operation: dreamAction, decision }, { env, home, now });
              return {};
            } catch {
              return { audit: { status: 'unconfirmed', code: 'dream-control-audit-unconfirmed' } };
            }
          };
          let result;
          try { result = server.dream.control(request); }
          catch (error) {
            const audit = outcomeAudit('failed'), failure = operationError(error);
            sendJson(res, failure.statusCode, { error: failure.message,
              ...(['soul-paused', 'owner-credential-required', 'owner-consent-unavailable'].includes(error.code)
                || typeof error.code === 'string' && /^dream-[a-z][a-z-]{0,63}$/.test(error.code) ? { code: error.code } : {}), ...audit });
            return;
          }
          // A returned control may defer a run. This is not a maintenance result.
          sendJson(res, result.status === 'started' ? 202 : 200, { schemaVersion: 1, result, ...outcomeAudit('returned') });
        } else if (route.endsWith('/history')) {
          const query = {};
          for (const [key, value] of url.searchParams) {
            if (!['afterRevision', 'limit'].includes(key) || Object.hasOwn(query, key) || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
              throw Object.assign(new Error('Invalid dream history query.'), { code: 'dream-history-query', statusCode: 400 });
            }
            query[key] = Number(value);
          }
          sendJson(res, 200, { schemaVersion: 1, ...server.dream.history(query) });
        } else {
          if (url.search) throw Object.assign(new Error('Dream status accepts no query fields.'), { statusCode: 400 });
          sendJson(res, 200, server.dream.status());
        }
        return;
      }
      switch (route) {
        case 'POST /v0/asides/delivered': {
          const source = requireBinding(req, bindings);
          const body = parseJsonBody(await readBody(req));
          if (!Array.isArray(body.messageIds) || body.messageIds.length < 1 || body.messageIds.length > 200
            || body.messageIds.some((id) => typeof id !== 'string' || !id.trim())
            || new Set(body.messageIds).size !== body.messageIds.length
            || !['inbox-read', 'hook-inject'].includes(body.via)
            || (body.harnessSessionId !== undefined && (typeof body.harnessSessionId !== 'string' || !body.harnessSessionId.trim()))) {
            throw Object.assign(new Error('invalid aside delivery fields'), { statusCode: 400 });
          }
          const binding = { worktree: source.worktree, file: source.spawnedBy
            ? childBindingPath(source.gitDir, source.agentId) : path.join(source.gitDir, 'agent-binding.json') };
          let messages;
          try {
            messages = await asideRelay.read({ agentId: source.agentId, binding });
            if (!Array.isArray(messages)) throw new Error('invalid inbox');
          } catch {
            throw Object.assign(new Error('could not read soul mailbox'), { statusCode: 502 });
          }
          const mailbox = new Map(messages.filter((message) => message && typeof message.id === 'string').map((message) => [message.id, message]));
          const recorded = [];
          const skipped = [];
          for (const id of body.messageIds) {
            const message = mailbox.get(id);
            if (!message) { skipped.push({ id, reason: 'not-in-mailbox' }); continue; }
            if (message.to?.agentId !== source.agentId || message.to?.principal) {
              skipped.push({ id, reason: 'not-addressed-to-soul' }); continue;
            }
            let peer;
            try { peer = senderAddress(message.from); }
            catch { skipped.push({ id, reason: 'invalid-message' }); continue; }
            if (typeof message.body !== 'string') { skipped.push({ id, reason: 'invalid-message' }); continue; }
            const result = recordDeliveredAside(source.agentId, {
              via: body.via, peer, messageId: id, replyTo: message.replyTo, correlation: message.correlation,
              harnessSessionId: body.harnessSessionId, body: message.body,
            }, { env, home, now });
            if (result?.recorded) recorded.push(id);
            else skipped.push({ id, reason: result ? 'already-recorded' : 'record-failed' });
          }
          sendJson(res, 200, { recorded, skipped });
          return;
        }
        case 'GET /v0/health': {
          // `busy`: souls with any daemon turn in flight, beside
          // the warm pool's connected harnesses.
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, status: 'ok', pid: process.pid, warmPool: warmPool.list(),
            busy: server.wakePlane?.busy?.() ?? turns.busy(),
            souls: withRoles(listSouls({ file: populationFile({ env, home }) }), { file: populationFile({ env, home }), env, home }),
            computerUse: computerUse.list().map(({ agentId, since }) => ({ agentId, since })) });
          return;
        }
        case 'POST /v0/space/ensure': {
          const body = parseJsonBody(await readBody(req));
          const id = requireAgentId(body.agentId);
          // The census space when the soul has one (ADR-0583 decision 8); the root only for a soul without.
          const space = ensureSoulSpace(id, { env, home, config, file: populationOverride(env, home) });
          sendJson(res, 200, { agentId: space.id, path: space.path, created: space.created });
          return;
        }
        case 'GET /v0/space/path': {
          // The census path when the census knows the soul (ADR-0583 decision 8).
          const id = requireAgentId(url.searchParams.get('agentId'));
          sendJson(res, 200, { agentId: id, path: soulSpacePath(id, { env, home, config, file: populationOverride(env, home) }) });
          return;
        }
        case 'POST /v0/register': {
          const body = parseJsonBody(await readBody(req));
          const id = requireAgentId(body.agentId);
          if (typeof body.spacePath !== 'string' || !path.isAbsolute(body.spacePath)) {
            throw Object.assign(new Error('spacePath must be an absolute path'), { statusCode: 400 });
          }
          let worktree;
          if (body.worktree !== undefined && body.worktree !== null) {
            if (typeof body.worktree !== 'string' || !path.isAbsolute(body.worktree)) {
              throw Object.assign(new Error('worktree must be an absolute path'), { statusCode: 400 });
            }
            worktree = body.worktree;
          }
          // `sighted` comes from setup-worktree and its hooks, a live
          // session; a join or repair registers without it (#109).
          const soul = upsertIdentitySoul(id, body.spacePath, {
            file: populationOverride(env, home),
            stateDir: stateDirectory({ env, home }),
            worktree,
            sighted: body.sighted === true,
          });
          sendJson(res, 200, { soul });
          return;
        }
        case 'POST /v0/bind': {
          const body = parseJsonBody(await readBody(req));
          sendJson(res, 200, bindWorktreeConversation({ body, bindings, env, home, config, now, presented: presentedCredential(req) }));
          return;
        }
        case 'POST /v0/spawn': {
          const source = requireBinding(req, bindings);
          const body = parseJsonBody(await readBody(req));
          const stateDir = stateDirectory({ env, home });
          const parent = readAgentIdentity(source.agentId, { stateDir });
          const parentApp = parent.github?.appSlug ?? null;
          if ((body.parent && body.parent !== source.agentId)
            || (body.app && body.app !== parentApp)) {
            throw Object.assign(new Error('spawn cannot override parent authority'), { statusCode: 403 });
          }
          const harness = body.harness ?? source.harness ?? parent.harness ?? 'unknown';
          const name = body.name ?? 'child';
          for (const value of [name, harness]) {
            if (typeof value !== 'string' || !value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
              throw Object.assign(new Error('invalid spawn name or harness'), { statusCode: 400 });
            }
          }
          // A parent with no github field stays without one even when the
          // gate is on. The gate off omits github on the child either way.
          const useGithub = isGateEnabled('github-identity', { env, home, config }) && parent.github != null;
          const identity = mintAgentIdentity({
            appSlug: parentApp, botUid: parent.github?.botUid ?? null, harness,
            transcript: body.transcript, parentId: source.agentId,
            packageRevision: body.packagePath == null ? null : computePackageRevision(body.packagePath),
            team: body.team ?? parent.team, squad: body.squad ?? parent.squad,
            type: body.type ?? 'agent', level: body.level, subjects: body.subjects ?? [], stateDir, now,
            useGithub,
          });
          bindings.bind({ agentId: identity.id, parent: source.agentId, spawnedBy: source.bindingHash,
            worktree: source.worktree, gitDir: source.gitDir, app: identity.github?.appSlug ?? null,
            harness, transcript: identity.transcript });
          const result = { agentId: identity.id, parent: source.agentId,
            binding: childBindingPath(source.gitDir, identity.id) };
          let warning;
          try { warning = await spawnHook({ ...result, name: body.name ?? identity.id, harness, cwd: source.worktree, env }); }
          catch { warning = 'spawn hook failed'; }
          sendJson(res, 200, { ...result, ...(warning ? { warning } : {}) });
          return;
        }
        // A soul starts a teammate as itself (#377): the binding is the
        // caller, and the starter enforces the team limits and audits.
        case 'POST /v0/team/start': {
          let source;
          try {
            source = requireBinding(req, bindings);
          } catch (error) {
            appendAuditReceipt({ event: 'team-start', operation: 'start_soul', decision: 'denied' }, { env, home, now });
            throw error;
          }
          if (!teamStarter) throw Object.assign(new Error('this daemon cannot start souls'), { statusCode: 503 });
          const body = parseJsonBody(await readBody(req));
          sendJson(res, 200, await teamStarter(source.agentId, body));
          return;
        }
        case 'GET /v0/binding': {
          const binding = requireBinding(req, bindings);
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, binding });
          return;
        }
        // Explicit revocation invalidates the secret and removes its file.
        case 'DELETE /v0/binding': {
          const presented = presentedCredential(req);
          const released = typeof presented === 'string'
            ? bindings.release(presented)
            : bindings.releaseProof(presented.proof, presented.request);
          if (!released) {
            throw Object.assign(new Error('missing or invalid agent binding'), { statusCode: 401 });
          }
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, released: true });
          return;
        }
        // Tier-1 credential brokering (#90): an App installation token for
        // the bot the caller already IS. Authorization is the live binding —
        // "a bound agent on an enforced connection" — never a request
        // parameter, and never a key-file read in the caller's process. The
        // request names no App and no Agent ID: both derive from the binding.
        // Delegated human authority (tier 2) is deliberately NOT this route —
        // it must never return a credential at all.
        case 'POST /v0/credential': {
          // Drain the (unused) request body so keep-alive connections are left
          // clean; readBody enforces MAX_BODY_BYTES like every other route.
          await readBody(req);
          let binding;
          try {
            binding = requireBinding(req, bindings);
          } catch (error) {
            appendAuditReceipt(
              { event: 'credential-mint', operation: 'tier1-app-token', decision: 'denied', reason: 'no-live-binding' },
              { env, home, now },
            );
            throw error;
          }
          let grant;
          let identity;
          try {
            identity = readAgentIdentity(binding.agentId, {
              stateDir: stateDirectory({ env, home }),
            });
          } catch (error) {
            appendAuditReceipt({
              event: 'credential-mint',
              agentId: binding.agentId,
              operation: 'tier1-app-token',
              decision: 'failed',
              reason: 'identity-unreadable',
            }, { env, home, now });
            throw error;
          }
          // A retired soul's binding proof is not authority to mint (#775):
          // retirement ends its App use even before its bindings are swept.
          if (identity.status === 'retired') {
            appendAuditReceipt({
              event: 'credential-mint',
              agentId: binding.agentId,
              operation: 'tier1-app-token',
              decision: 'denied',
              ...(identity.github?.appSlug ? { appSlug: identity.github.appSlug } : {}),
              reason: 'soul-retired',
            }, { env, home, now });
            throw Object.assign(new Error('this soul is retired'), { statusCode: 409 });
          }
          // The add-on gate decides, not the record: a soul that carries a
          // github field gets no App token while github-identity is off.
          const githubOn = isGateEnabled('github-identity', { env, home, config });
          if (!githubOn || !identity.github?.appSlug) {
            appendAuditReceipt({
              event: 'credential-mint',
              agentId: binding.agentId,
              operation: 'tier1-app-token',
              decision: 'denied',
              ...(identity.github?.appSlug ? { appSlug: identity.github.appSlug } : {}),
              reason: githubOn ? 'no-github-app' : 'github-identity-off',
            }, { env, home, now });
            throw Object.assign(new Error(githubOn ? 'this soul has no GitHub App' : 'the github-identity add-on is off'), { statusCode: 409 });
          }
          try {
            grant = await mintImpl({
              slug: identity.github.appSlug, env, agentId: binding.agentId,
              viaKeyd: (soul) => mintViaKeyd({ ...soul, env, home, now, request: keydCall }),
            });
          } catch (error) {
            // A verified binding whose mint fails must still leave a receipt —
            // the audit stream has to account for every attempt, not only the
            // ones that reached a decision.
            appendAuditReceipt({
              event: 'credential-mint',
              agentId: binding.agentId,
              operation: 'tier1-app-token',
              decision: 'failed',
              appSlug: identity.github.appSlug,
              reason: 'mint-failed',
            }, { env, home, now });
            throw error;
          }
          // The App comes from the bound soul's own record, never the request.
          appendAuditReceipt({
            event: 'credential-mint',
            agentId: binding.agentId,
            operation: 'tier1-app-token',
            decision: 'granted',
            appSlug: identity.github.appSlug,
            reason: 'bound-soul-own-app',
          }, { env, home, now });
          sendJson(res, 200, {
            schemaVersion: SCHEMA_VERSION,
            agentId: binding.agentId,
            appSlug: identity.github.appSlug,
            token: grant.token,
            expires_at: grant.expires_at,
            installation_id: Number.isSafeInteger(grant.installation_id) ? grant.installation_id : null,
          });
          return;
        }
        // take_inbox (#229): the next GitHub event for the App and repository
        // the caller's binding is. The fleet-wide inbox bearer stays in the
        // daemon, read from pass-cli; the App comes from the bound soul's own
        // record and the repository from the bound worktree, never from the
        // request.
        case 'POST /v0/inbox/take': {
          await readBody(req);
          const receipt = (decision, fields = {}) => appendAuditReceipt({
            event: 'inbox-take', operation: 'take', decision, ...fields,
          }, { env, home, now });
          let binding;
          try { binding = requireBinding(req, bindings); }
          catch (error) { receipt('denied', { reason: 'no-live-binding' }); throw error; }
          const agentId = binding.agentId;
          let identity;
          try { identity = readAgentIdentity(agentId, { stateDir: stateDirectory({ env, home }) }); }
          catch (error) { receipt('failed', { agentId, reason: 'identity-unreadable' }); throw error; }
          const appSlug = identity.github?.appSlug;
          if (!appSlug) {
            receipt('denied', { agentId, reason: 'no-github-app' });
            throw inboxError('inbox-no-app', 'take_inbox failed: this soul has no GitHub App', { statusCode: 409 });
          }
          let result;
          try {
            const repo = boundRepository(binding.worktree);
            result = await inboxTake({ app: appSlug, repo });
          } catch (error) {
            receipt('failed', { agentId, appSlug, reason: typeof error.code === 'string' ? error.code : 'take-failed' });
            throw error;
          }
          receipt('taken', { agentId, appSlug, reason: result.event ? 'event' : 'empty' });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, event: result.event ?? null });
          return;
        }
        // agent-bot-keyd grants (#397): a soul's `agent-bot-keyd mcp` relay
        // asks here, on the soul's binding, before each keyd tool call. The
        // daemon keeps the policy — binding, add-on gate, the soul's own App,
        // a keyd-held key — and answers with a one-call grant signed by its
        // account key, which keyd pinned. keyd checks the grant and mints;
        // the key never leaves keyd and the grant is useless after 60s.
        case 'POST /v0/keyd/grant': {
          const body = parseJsonBody(await readBody(req));
          const tool = body?.tool;
          const receipt = (decision, agentId = null) => appendAuditReceipt({
            event: 'credential-grant', ...(agentId ? { agentId } : {}),
            operation: `keyd ${KEYD_TOOL_NAMES.includes(tool) ? tool : 'unknown'}`, decision,
          }, { env, home, now });
          if (!KEYD_TOOL_NAMES.includes(tool)) {
            receipt('denied');
            throw Object.assign(new Error('unknown keyd tool'), { statusCode: 400 });
          }
          let binding;
          try { binding = requireBinding(req, bindings); }
          catch (error) { receipt('denied'); throw error; }
          let identity;
          let declaration;
          try {
            identity = readAgentIdentity(binding.agentId, { stateDir: stateDirectory({ env, home }) });
            declaration = soulCredentialsDeclaration(soulDirectory(binding.agentId, { file: populationFile({ env, home }), env, home }));
          } catch (error) {
            receipt('failed', binding.agentId);
            throw error;
          }
          const githubOn = isGateEnabled('github-identity', { env, home, config });
          const app = identity.github?.appSlug;
          const refusal = !githubOn ? 'the github-identity add-on is off'
            : !app ? 'this soul has no GitHub App'
              : declaration?.app !== app || declaration?.store !== 'keyd' ? "agent-bot-keyd does not hold this soul's key"
                : null;
          if (refusal) {
            receipt('denied', binding.agentId);
            throw Object.assign(new Error(refusal), { statusCode: 409 });
          }
          const signed = signKeydGrant({ agentId: binding.agentId, app, tool, ...(await grantTarget({ env, config })) }, signingKey(), now);
          receipt('granted', binding.agentId);
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, grant: signed });
          return;
        }
        // Comms pairing state (#255): who this daemon is paired as, and whether
        // its account-watch stream to the agent-comms broker is connected.
        case 'GET /v0/comms/status': {
          sendJson(res, 200, {
            schemaVersion: SCHEMA_VERSION,
            comms: readCommsStatus({ env, home, live: comms?.getState() ?? null }),
          });
          return;
        }
        case 'GET /v0/population': {
          const souls = listSouls({
            status: url.searchParams.get('status'),
            app: url.searchParams.get('app'),
            file: populationOverride(env, home),
          });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, souls: withRoles(souls, { file: populationOverride(env, home), env, home }) });
          return;
        }
        case 'GET /v0/soul/revisions': {
          const agentId = requireAgentId(url.searchParams.get('agentId'));
          const proposals = listSoulProposals(agentId, { stateDir: stateDirectory({ env, home }) })
            .filter((proposal) => proposal.status === 'pending')
            .map(({ proposalId, revision, parentRevision, author, reason, diff, requiresUser, status, at }) =>
              ({ proposalId, revision, parentRevision, author, reason, diff, requiresUser, status, at }));
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, agentId, proposals });
          return;
        }
        case 'POST /v0/soul/revisions/approve':
        case 'POST /v0/soul/revisions/reject':
        case 'POST /v0/soul/revisions/adopt':
        case 'POST /v0/soul/revisions/edit': {
          const body = parseJsonBody(await readBody(req));
          const agentId = requireAgentId(body.agentId);
          const target = ['approve', 'reject'].includes(revisionAction) ? body.proposalId : body.packagePath;
          if (typeof target !== 'string' || !target.trim() || typeof body.reason !== 'string' || !body.reason.trim()
            || (body.consent !== undefined && body.consent !== true) || (body.consent && body.principal != null)) {
            throw Object.assign(new Error('provide a target and reason, and either principal or consent: true'), { statusCode: 400 });
          }
          const record = await revisionCommand([revisionAction, agentId, target, body.reason], {
            env, home, now, stateDir: stateDirectory({ env, home }), principal: body.principal ?? null,
            ...(body.expectedParent === undefined ? {} : { expectedParent: body.expectedParent }),
            assertUser: async (_action, { principal }) => {
              if (body.consent) {
                // Reserved host ceremony contract: no client-supplied boolean
                // or assertion grants consent, and this route raises no GUI.
                throw Object.assign(new Error('daemon owner consent is not implemented; use the interactive CLI'), {
                  code: 'owner-consent-unavailable', statusCode: 501,
                });
              }
              if (!principal) throw ownerCredentialRequired();
              return revisionPrincipal(principal);
            },
          });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, agentId, record });
          return;
        }
        case 'GET /v0/sandbox': {
          // Persona account status (#376): account facts, the owner's steps
          // and each soul's resolution. Secret-free by construction.
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ...readSandboxStatus({ env, home }) });
          return;
        }
        case 'POST /v0/sandbox': {
          const body = parseJsonBody(await readBody(req));
          if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 });
          if (body.account !== undefined) {
            try { validateSandboxAccount(body.account); }
            catch (error) { throw Object.assign(new Error(error.message), { statusCode: 400 }); }
          }
          if (body.enabled === undefined && body.account === undefined) throw Object.assign(new Error('provide enabled and/or account'), { statusCode: 400 });
          const action = [body.enabled === undefined ? null : `sandbox ${body.enabled ? 'on' : 'off'}`, body.account === undefined ? null : `sandbox account ${body.account}`].filter(Boolean).join(', ');
          await settingGate(action, { principal: body.principal ?? null });
          if (body.account !== undefined) setSandboxAccount(body.account, { env, home });
          if (body.enabled !== undefined) setSandboxEnabled(body.enabled, { env, home });
          appendAuditReceipt({ event: 'sandbox', operation: 'set', decision: action }, { env, home, now });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ...readSandboxStatus({ env, home }) });
          return;
        }
        case 'POST /v0/sandbox/override': {
          const body = parseJsonBody(await readBody(req));
          const agentId = requireAgentId(body.agentId);
          if (!['inherit', 'sandboxed', 'unrestricted'].includes(body.override)) throw Object.assign(new Error('override must be inherit, sandboxed or unrestricted'), { statusCode: 400 });
          const file = populationFile({ env, home });
          try { showSoul(agentId, { file }); }
          catch { throw Object.assign(new Error('unknown soul'), { statusCode: 404 }); }
          await settingGate(`sandbox override ${agentId} ${body.override}`, { principal: body.principal ?? null });
          const result = setSandboxOverride(agentId, body.override, { env, home });
          appendAuditReceipt({ event: 'sandbox', agentId, operation: 'override', decision: body.override }, { env, home, now });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ...result });
          return;
        }
        case 'GET /v0/soul/profile':
        case 'GET /v0/soul/env': {
          const agentId = url.searchParams.get('agentId');
          if (!agentId) {
            sendJson(res, 400, { error: 'agentId is required' });
            return;
          }
          // Both are read-only census-authenticated reads; env adds the
          // environment descriptor (#583) beside the profile.
          const read = url.pathname.endsWith('/env') ? readSoulEnvironment : readSoulProfile;
          try { sendJson(res, 200, read(agentId, { env, home })); }
          catch (error) {
            if (error.code !== 'soul-not-found') throw error;
            sendJson(res, 404, { error: error.message, code: error.code });
          }
          return;
        }
        case 'POST /v0/soul/computer-use': {
          const body = parseJsonBody(await readBody(req));
          const agentId = requireAgentId(body.agentId);
          if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 });
          const file = populationFile({ env, home });
          try { showSoul(agentId, { file }); }
          catch { throw Object.assign(new Error('unknown soul'), { statusCode: 404 }); }
          await settingGate(`switch ${agentId} computer use ${body.enabled ? 'on' : 'off'}`, { principal: body.principal ?? null });
          setSoulComputerUse(agentId, body.enabled, { file });
          const stopped = !body.enabled && computerUse.list().some((row) => row.agentId === agentId)
            ? (server.wakePlane?.stop?.(agentId) ?? turns.stop(agentId)) : false;
          appendAuditReceipt({ event: 'computer-use', agentId, operation: 'set', decision: body.enabled ? 'on' : 'off' }, { env, home, now });
          sendJson(res, 200, { agentId, computerUse: body.enabled, ...(stopped ? { stopped: true } : {}) });
          return;
        }
        case 'POST /v0/soul/pause':
        case 'POST /v0/soul/resume':
        case 'POST /v0/soul/stop': {
          const action = url.pathname.split('/').at(-1);
          const body = parseJsonBody(await readBody(req));
          const agentId = requireAgentId(body.agentId);
          // Like approvals: the local owner presents the daemon token;
          // adapters additionally identify their enrolled transport principal.
          // Stopping grants no tool permission and needs no presence dialog.
          let principal = null;
          const transport = body.transport ?? 'owner';
          if (body.transport !== undefined || body.providerId !== undefined) {
            try {
              principal = resolvePrincipal({ transport: body.transport, providerId: body.providerId }, { file: principalsFile({ env, home }) });
            } catch {
              throw Object.assign(new Error('invalid transport principal'), { statusCode: 400 });
            }
            try { assertAuthorized({ principal, agentId, operation: 'cancel' }); }
            catch (error) {
              appendAuditReceipt({ event: 'denied-request', agentId, transport, principalId: principal?.principalId ?? null,
                operation: 'cancel', decision: 'denied' }, { env, home, now });
              throw error;
            }
          }
          try { showSoul(agentId, { file: populationFile({ env, home }) }); }
          catch { throw Object.assign(new Error('unknown soul'), { statusCode: 404 }); }
          const stopped = action === 'resume' ? false : (server.wakePlane?.stop?.(agentId) ?? turns.stop(agentId));
          if (action !== 'stop') setSoulPaused(agentId, action === 'pause', { file: populationFile({ env, home }) });
          appendAuditReceipt({ event: action, agentId, transport, principalId: principal?.principalId ?? null,
            operation: 'cancel', decision: action === 'stop' ? (stopped ? 'stopped' : 'idle') : (action === 'pause' ? 'paused' : 'resumed') }, { env, home, now });
          sendJson(res, 200, action === 'stop' ? { agentId, stopped, ...(!stopped ? { reason: 'idle' } : {}) }
            : { agentId, paused: action === 'pause', ...(action === 'pause' ? { stopped } : {}) });
          return;
        }
        // The owner's approvals (#85). Listing needs the daemon token; deciding
        // also needs the owner at the Mac (#438), asked here, not by the caller.
        case 'GET /v0/approvals': {
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ...interaction.listProposalsForOwner() });
          return;
        }
        case 'POST /v0/approvals/decide': {
          const body = parseJsonBody(await readBody(req));
          await confirmDecision({ proposalId: body.proposalId, decision: body.decision, scope: body.scope, credential: body.principal ?? null });
          sendJson(res, 200, interaction.decideProposalAsOwner({
            proposalId: body.proposalId,
            decision: body.decision, scope: body.scope,
            digest: body.digest,
          }));
          return;
        }
        default:
          sendJson(res, 404, { error: 'unknown route' });
      }
    } catch (error) {
      const failure = operationError(error);
      // Dream and inbox codes are fixed identifiers, so clients can act on them.
      sendJson(res, failure.statusCode, { error: failure.message,
        ...(['soul-paused', 'owner-credential-required', 'owner-consent-unavailable'].includes(error.code)
          || typeof error.code === 'string' && /^(dream|inbox)-[a-z][a-z-]{0,63}$/.test(error.code) ? { code: error.code } : {}) });
    }
  });
  server.once('close', () => appJobs.close());
  server.on('listening', () => {
    const address = server.address();
    bindings.rewrite(`http://${address.address === '::1' ? '[::1]' : '127.0.0.1'}:${address.port}`);
  });
  warmPool = attachWakeEndpoint(server, {
    lookupBinding: (secret) => bindings.resolve(secret),
    lookupProof: (req) => {
      const presented = presentedCredential(req);
      return typeof presented === 'string' ? null : bindings.resolveProof(presented.proof, presented.request);
    },
  });
  server.token = token;
  server.warmPool = warmPool;
  server.bindings = bindings;
  server.interaction = interaction;
  return server;
}

// Surrender-and-enforce (#94): the caller presents the bind token that
// setup-worktree minted into the worktree's private git dir, together with
// what only the conversation knows — transcript locator, harness, parent.
// The daemon verifies the token against the file on disk, consumes it, and
// joins the two halves into one identity. The body carries NO Agent ID: who
// is binding is derived entirely from the consumed token record, so no caller
// can bind as a worktree it cannot read.
function bindWorktreeConversation({ body, bindings, env, home, config, now, presented = '' }) {
  // Validate the conversation half BEFORE consuming: a bind rejected for a
  // malformed request must leave the single-use token in place so the caller
  // can retry, while a wrong or replayed token still fails without consuming.
  if (typeof body.gitDir !== 'string' || !path.isAbsolute(body.gitDir)) throw new Error('gitDir must be an absolute path');
  const existing = readBinding({ env: {}, gitDir: body.gitDir });
  if (existing) {
    const binding = bindings.resolve(existing.secret);
    if (binding && binding.gitDir === body.gitDir) {
      // Reuse hands back a live secret, so the caller must prove it can read
      // this git dir, exactly as a first bind does: present the binding it
      // read, or a bind token minted there. A path and the daemon bearer
      // alone must never yield another worktree's secret.
      const pending = readBindToken(body.gitDir);
      const holdsBinding = typeof presented === 'string'
        ? presented !== '' && tokensMatch(existing.secret, presented)
        : bindings.resolveProof(presented.proof, presented.request)?.bindingHash
          === createHash('sha256').update(existing.secret).digest('hex');
      // A matching token proves place without being spent, so a redundant
      // token survives reuse.
      const holdsToken = pending !== null && typeof body.token === 'string' && tokensMatch(pending.token, body.token);
      if (!holdsBinding && !holdsToken) throw Object.assign(new Error('this worktree is already bound; present its binding'), { statusCode: 403 });
      if (!holdsBinding) assertPrivateGitDir(body.gitDir, pending.worktree);
      if (body.parentId && body.parentId !== binding.parent) throw Object.assign(new Error('identity already records a different parent'), { statusCode: 409 });
      // Re-binding is a sighting too (#109): the session is present again,
      // with no step the agent has to remember.
      recordSoulSighting(binding.agentId, { file: populationOverride(env, home), now });
      return { schemaVersion: SCHEMA_VERSION, ...binding, secret: existing.secret, repinRequired: false };
    }
  }
  const transcript = body.transcript;
  if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript)
    || typeof transcript.id !== 'string' || transcript.id === '') {
    throw Object.assign(
      new Error('bind requires a transcript locator ({provider, id})'),
      { statusCode: 400 },
    );
  }
  const locator = { provider: typeof transcript.provider === 'string' && transcript.provider !== '' ? transcript.provider : 'custom', id: transcript.id };
  const parentId = body.parentId === undefined || body.parentId === null
    ? null
    : requireAgentId(body.parentId);
  const stateDir = stateDirectory({ env, home });
  // A syntactically valid parentId can still be a typo or a stale ID from
  // another machine; lineage must only ever point at an identity this
  // workstation can produce. Checked before consuming so a rejected bind
  // leaves the single-use token in place.
  if (parentId !== null) {
    try {
      readAgentIdentity(parentId, { stateDir });
    } catch {
      throw Object.assign(new Error('parent Agent ID is unknown'), { statusCode: 409 });
    }
  }
  const pending = readBindToken(body.gitDir);
  if (pending) assertPrivateGitDir(body.gitDir, pending.worktree);
  const record = consumeBindToken({ gitDir: body.gitDir, token: body.token });
  let pinned;
  try {
    pinned = readAgentIdentity(record.agentId, { stateDir });
  } catch {
    throw Object.assign(new Error('bind token names an unknown Agent ID'), { statusCode: 409 });
  }
  const harness = typeof body.harness === 'string' && body.harness !== '' ? body.harness : pinned.harness;
  // The existing reuse policy decides whether the pinned identity binds this
  // transcript, an earlier identity already owns it, or a fresh one is minted
  // (a later conversation reusing the worktree). parentId only applies on a
  // mint; a reused identity's missing lineage is repaired below.
  // Reuse the pinned soul. GitHub metadata is copied only when the add-on
  // is on AND this soul already has it; a soul without `github` stays that
  // way when the gate is later turned on.
  const useGithub = isGateEnabled('github-identity', { env, home, config }) && pinned.github != null;
  const identity = ensureAgentIdentity({
    currentId: record.agentId,
    appSlug: useGithub ? pinned.github.appSlug : null,
    botUid: useGithub ? pinned.github.botUid : null,
    harness,
    useGithub,
    transcript: locator,
    fields: {
      team: pinned.team,
      squad: pinned.squad,
      type: pinned.type,
      level: pinned.level,
      parentId,
    },
    stateDir,
    now,
  });
  let bound = identity;
  if (parentId && !identity.parentId) {
    bound = bindAgentLineage(identity.id, parentId, { stateDir, now });
  } else if (parentId && identity.parentId !== parentId) {
    throw Object.assign(
      new Error('identity already records a different parent'),
      { statusCode: 409 },
    );
  }
  // Binding is the one moment place and conversation are both in view; the
  // census row picks up the provenance (#91) through the refreshed identity.
  const space = ensureSoulSpace(bound.id, { env, home, config, file: populationOverride(env, home) });
  const soul = upsertIdentitySoul(bound.id, space.path, {
    file: populationOverride(env, home),
    stateDir,
    worktree: record.worktree,
    sighted: true,
  });
  const secret = bindings.bind({
    agentId: bound.id,
    gitDir: body.gitDir,
    parent: bound.parentId ?? null,
    app: bound.github?.appSlug ?? null,
    worktree: record.worktree,
    transcript: locator,
    harness: bound.harness,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    secret,
    agentId: bound.id,
    worktree: record.worktree,
    boundAt: soul.lastSeen,
    // The worktree pin still names the token's original identity when the
    // reuse policy resolved elsewhere; the caller owns repinning because the
    // daemon never reaches into worktrees.
    repinRequired: bound.id !== record.agentId,
    soul,
  };
}

// The daemon address a binding proof must name, normalized exactly as a
// client's `new URL(daemon).host` is (port 80 is omitted, IPv6 bracketed).
function daemonAuthority(req) {
  const address = String(req.socket.localAddress ?? '').replace(/^::ffff:/, '');
  return new URL(`http://${address.includes(':') ? `[${address}]` : address}:${req.socket.localPort}`).host;
}

// What the caller presented for its binding (#270): a proof, which never
// carries the secret, as { proof, request }; otherwise an older client's bare
// secret from `x-agent-binding` (empty when absent).
function presentedCredential(req) {
  const proof = req.headers[PROOF_HEADER];
  if (typeof proof === 'string') {
    const request = { method: req.method, path: new URL(req.url, 'http://127.0.0.1').pathname, authority: daemonAuthority(req) };
    return { proof, request };
  }
  return typeof req.headers['x-agent-binding'] === 'string' ? req.headers['x-agent-binding'] : '';
}

function requireBinding(req, bindings) {
  const presented = presentedCredential(req);
  const binding = typeof presented === 'string'
    ? bindings.resolve(presented)
    : bindings.resolveProof(presented.proof, presented.request);
  if (!binding) {
    throw Object.assign(new Error('missing or invalid agent binding'), { statusCode: 401 });
  }
  return binding;
}

// Until #253 stores parent on the binding, a lookup that does not know the
// field is filled from the identity recorded at bind time. A lookup that
// returns a parent (including an explicit null) wins, so the store can
// disagree with the identity file without this route second-guessing it.
function parentForVouch(binding, { env, home }) {
  if (typeof binding.parent === 'string' && binding.parent.length > 0) return binding.parent;
  if (binding.parentIsSet) return binding.parent ?? null;
  try {
    const record = readAgentIdentity(binding.agentId, { stateDir: stateDirectory({ env, home }) });
    return record.parentId ?? null;
  } catch {
    return null;
  }
}

async function handleVouchRequest({
  req,
  res,
  findBinding,
  allowVouch,
  signingKey,
  env,
  home,
  now,
}) {
  const body = parseJsonBody(await readBody(req));
  if (body.aud !== 'agent-comms') {
    throw Object.assign(new Error('aud must be agent-comms'), { statusCode: 400 });
  }
  const presented = presentedCredential(req);
  const binding = findBinding(presented);
  if (!binding) {
    appendAuditReceipt(
      { event: 'vouch', operation: 'soul-token', decision: 'denied' },
      { env, home, now },
    );
    throw Object.assign(new Error('unbound'), { statusCode: 401 });
  }
  if (!allowVouch(presented)) {
    appendAuditReceipt({
      event: 'vouch',
      agentId: binding.agentId,
      operation: 'soul-token',
      decision: 'rate-limited',
    }, { env, home, now });
    throw Object.assign(new Error('rate limited'), { statusCode: 429 });
  }
  let account;
  try {
    account = userInfo().username;
  } catch {
    account = '';
  }
  if (typeof account !== 'string' || account.length === 0) {
    throw Object.assign(new Error('could not determine the account name'), { statusCode: 500 });
  }
  const parent = parentForVouch(binding, { env, home });
  let token;
  let payload;
  try {
    token = signSoulToken({ account, agentId: binding.agentId, parent }, signingKey(), now);
    payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('could not sign soul token'), { statusCode: 500 });
  }
  appendAuditReceipt({
    event: 'vouch',
    agentId: binding.agentId,
    operation: 'soul-token',
    decision: 'granted',
  }, { env, home, now });
  sendJson(res, 200, {
    token,
    agentId: payload.agentId,
    parent: payload.parent,
    exp: payload.exp,
  });
}

// Versioned /v1 interaction routes (#55). The transport adapter authenticates
// the provider identity and forwards only the normalized (transport,
// providerId) pair — in the body for POSTs, in the query for GETs. The daemon
// resolves that pair to a locally enrolled principal, deny-by-default; the
// interaction service then authorizes each operation before any soul lookup
// or job mutation. Errors are stable and never reflect request contents.
async function handleInteractionRequest({ req, res, url, interaction, env, home, confirmDecision }) {
  const body = req.method === 'POST' ? parseJsonBody(await readBody(req)) : null;
  const transport = body ? body.transport : url.searchParams.get('transport');
  const providerId = body ? body.providerId : url.searchParams.get('providerId');
  let principal;
  try {
    principal = resolvePrincipal({ transport, providerId }, { file: principalsFile({ env, home }) });
  } catch {
    throw Object.assign(new Error('invalid transport principal'), { statusCode: 400 });
  }
  if (!principal) {
    // No principal, no route: the refusal is recorded but indistinguishable
    // from any other authorization failure to the caller.
    appendAuditReceipt({ event: 'denied-request', transport, decision: 'denied' }, { env, home });
    sendJson(res, 403, { error: 'principal is not authorized for this operation' });
    return;
  }
  let match;
  if (req.method === 'POST' && url.pathname === '/v1/sessions') {
    sendJson(res, 200, interaction.createOrContinueSession({
      principal,
      transport,
      agentId: body.agentId,
      sessionId: body.sessionId ?? null,
    }));
    return;
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/))) {
    sendJson(res, 200, interaction.submitMessage({
      principal,
      transport,
      sessionId: match[1],
      message: body.message,
      idempotencyKey: body.idempotencyKey,
      attachments: body.attachments,
      taskId: body.taskId,
    }));
    return;
  }
  if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/souls\/([^/]+)\/asides$/))) {
    const limit = url.searchParams.get('limit');
    sendJson(res, 200, interaction.listAsides({
      principal,
      transport,
      agentId: match[1],
      after: url.searchParams.get('after'),
      ...(limit === null ? {} : { limit: Number(limit) }),
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/proposals') {
    sendJson(res, 200, interaction.listProposals({ principal, transport }));
    return;
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/proposals\/([^/]+)\/decision$/))) {
    await confirmDecision({ proposalId: match[1], decision: body.decision, scope: body.scope, principal, transport });
    sendJson(res, 200, interaction.decideProposal({
      principal,
      transport,
      proposalId: match[1],
      decision: body.decision, scope: body.scope,
      digest: body.digest,
    }));
    return;
  }
  if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)$/))) {
    sendJson(res, 200, interaction.getInvocation({ principal, transport, invocationId: match[1] }));
    return;
  }
  if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)\/events$/))) {
    const after = url.searchParams.get('after');
    sendJson(res, 200, interaction.readEvents({
      principal,
      transport,
      invocationId: match[1],
      afterSeq: after === null ? 0 : Number(after),
    }));
    return;
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)\/cancel$/))) {
    sendJson(res, 200, await interaction.cancelInvocation({ principal, transport, invocationId: match[1] }));
    return;
  }
  if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)\/artifacts$/))) {
    sendJson(res, 200, interaction.listArtifacts({ principal, transport, invocationId: match[1] }));
    return;
  }
  sendJson(res, 404, { error: 'unknown route' });
}

// listSouls/upsertIdentitySoul default populationFile() reads process.env; the
// daemon threads its own env/home through so tests and supervised launches see
// one consistent world, mirroring the space calls above.
function populationOverride(env, home) {
  if (env.AGENT_BOT_POPULATION_PATH) return path.resolve(env.AGENT_BOT_POPULATION_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'population.json');
}

// Records a launch in the census before the first turn (#380). The principal
// may have chosen comms before start (#381): it becomes the soul's own
// setting, recorded as an edit when the soul has a revision chain. The
// revision history cannot be unwritten, so it is appended last; an earlier
// failure restores soul.json and the census comms.
// The daemon's per-turn permission mode, under the settings precedence
// (#379): the owner's pick, then the repo, then the soul package. A loosening
// nobody picked keeps the stricter mode; its code goes to the daemon log, and
// safe mode asks the owner for each tool call.
export function daemonModeFor({ env = process.env, home = homedir(), config, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  return (agentId, { harness = null, cwd = null } = {}) => {
    let soulDir = null;
    try { soulDir = soulDirectory(agentId, { env, home, config, file: populationFile({ env, home }), readOnly: true }); } catch { /* no census row: no package layer */ }
    const resolved = resolveSoulMode(agentId, { harness, cwd, soulDir, env, home });
    if (resolved.code) log(`agent-bot daemon: ${resolved.code}: ${agentId}: the ${resolved.source} declares ${resolved.declared}; running ${resolved.mode} until the owner picks a mode (agent-bot soul mode)`);
    return resolved.mode;
  };
}

export async function recordLaunchComms({ agentId, package: packagePath, comms, brief, principal = null }, {
  env, home, config, revisions = { history: revisionHistory, edit: editSoulRevision },
} = {}) {
  const file = populationFile({ env, home });
  let directory = null;
  try { directory = soulDirectory(agentId, { env, home, config, file }); } catch { /* no census row yet */ }
  let census = null;
  try { census = showSoul(agentId, { file }).comms !== false; } catch { /* no census row yet */ }
  const previous = typeof comms === 'boolean' && directory ? writeSoulComms(directory, comms) : null;
  try {
    const recorded = recordSoulLaunch(agentId, { ...(brief === undefined ? {} : { brief }), comms: typeof comms === 'boolean' ? comms
      : launchCommsSetting({ soulDir: directory, packagePath }) }, { file });
    const stateDir = stateDirectory({ env, home });
    if (previous !== null && revisions.history(agentId, { stateDir }).length) {
      await revisions.edit(agentId, directory, { reason: `comms ${comms ? 'on' : 'off'} at launch`, stateDir,
        ...(principal ? { authorization: { method: 'principal', principal } } : {}) });
    }
    return recorded;
  } catch (error) {
    if (previous !== null) {
      writeFileSync(path.join(directory, 'soul.json'), previous);
      if (census !== null) { try { setSoulComms(agentId, census, { file }); } catch { /* the launch fails either way */ } }
    }
    throw error;
  }
}

// The launch is already authorized by its principal. Persist its model after
// census/comms recording succeeds and before the first executor is created.
export async function recordLaunchSettings(launch, options = {}) {
  const recorded = await recordLaunchComms(launch, options);
  if (launch.model !== undefined) setSoulModel(launch.agentId, launch.model, options);
  return recorded;
}

// Read a fresh census snapshot for each new session or launch. Only public
// names and IDs leave this lookup; no paths, bindings or credentials do.
export function soulPromptIdentity(agentId, { env = process.env, home = homedir() } = {}) {
  const souls = listSouls({ file: populationFile({ env, home }) });
  const soul = souls.find((record) => record.id === agentId);
  if (!soul) return null;
  const named = (id) => {
    const record = souls.find((candidate) => candidate.id === id);
    return { name: record?.displayName || record?.name || displayName(id), agentId: id };
  };
  return { ...named(agentId), parent: soul.parentId ? named(soul.parentId) : null };
}

// Observe policy and mode decisions in interactive and cold ACP turns. Approval
// decisions already have their own receipts. The writer owns detail sanitizing.
export function withPermissionReceipts(executor, {
  env = process.env, home = homedir(), now = () => new Date(),
  computerUse = createComputerUseActivity({ now }),
} = {}) {
  return async (input) => {
    // The contract validates the invocation; a missing agent just tracks nothing.
    const agentId = typeof input.invocation?.agentId === 'string' ? input.invocation.agentId : null;
    const turn = Symbol('computer-use turn');
    let finished = false;
    const receipt = (operation, record) => {
      if (!record) return;
      try {
        appendAuditReceipt({ event: 'computer-use', agentId, operation, detail: record.tool }, { env, home, now });
      } catch { /* activity reporting must not affect the turn */ }
    };
    const stop = () => {
      finished = true;
      if (agentId) receipt('stop', computerUse.stop(agentId, turn));
    };
    input.signal?.addEventListener('abort', stop, { once: true });
    try {
      return await executor({
        ...input,
        computerUseEnabled: () => soulComputerUse(agentId, { file: populationFile({ env, home }) }),
        onPermission: (record) => {
          if (agentId && !finished && !input.signal?.aborted && record.outcome === 'allow' && isComputerUse(record.toolName)) {
            receipt('start', computerUse.start(agentId, record.toolName, turn));
          }
          try {
            if (record.decidedBy === 'computer-use' && record.outcome === 'deny') {
              appendAuditReceipt({ event: 'computer-use', agentId, operation: 'permission', decision: 'off', detail: record.toolName }, { env, home, now });
            }
            if (['policy', 'autopilot', 'risk', 'turn', 'session'].includes(record.decidedBy) && ['allow', 'deny'].includes(record.outcome)) {
              const tool = typeof record.toolName === 'string' ? record.toolName : null;
              let operation = tool && !/[\u0000-\u0020\u007f-\u009f]/.test(tool)
                ? (tool.length > 40 ? `${tool.slice(0, 39)}…` : tool) : null;
              if (operation && record.decidedBy !== 'policy' && `${record.decidedBy}:${tool}`.length <= 40) operation = `${record.decidedBy}:${tool}`;
              appendAuditReceipt({
                event: 'permission', agentId: input.invocation.agentId,
                operation, decision: record.outcome,
                // A contract-valid 200-character tool consumes the entire detail
                // budget; keep its full name rather than clip it for a summary.
                detail: tool?.length === 200 ? tool
                  : [tool, record.summary].filter((value) => typeof value === 'string' && value.length).join(': '),
              }, { env, home, now });
            }
          } catch { /* receipt failures must not change a policy decision */ }
          // Preserve collectors even when the audit store is unavailable.
          return input.onPermission?.(record);
        },
      });
    } finally {
      input.signal?.removeEventListener('abort', stop);
      stop();
    }
  };
}

export async function runDaemon({
  env = process.env,
  home = homedir(),
  config,
  host = env.AGENT_BOT_DAEMON_HOST ?? '127.0.0.1',
  port = env.AGENT_BOT_DAEMON_PORT ?? '0',
  onListening = null,
  now = () => new Date(),
} = {}) {
  assertLoopbackHost(host);
  const requestedPort = Number(port);
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('daemon port must be an integer between 0 and 65535');
  }
  const existing = await daemonStatus({ env, home });
  if (existing.running) {
    throw new Error(`daemon already running (pid ${existing.pid}, port ${existing.port})`);
  }
  const checkLog = createDaemonLogCheck({ env, logPath: daemonLogPath(home) });
  checkLog();
  // Reconcile jobs orphaned by a previous daemon before accepting new work
  // (#56 req 8): executing work becomes failed, never-dispatched queued work
  // becomes failed with its own stable reason, and pending cancellations
  // become cancelled — nothing is silently stranded.
  recoverInteractionStore({ env, home, now });
  // Harness CLIs resolve the same way for every soul turn, launch check and
  // relay (#418).
  const harnessEnv = soulEnvironment(env, { home, loginPath: loginShellPath({ env, home }) });
  // How a soul's turn environment is composed (composeTurnEnv): the
  // executor and the launch's sign-in probe (#536) share these ports.
  const turnEnvPorts = {
    // The soul's provisioned runtimes and harness installs first on its
    // PATH, with their env (#583 slice 3); read per turn from its stamps.
    runtimeEnvFor: ({ agentId, harness, env: turnEnv }) => soulRuntimeEnv(agentId, { env: turnEnv, home, config, file: populationFile({ env, home }), harness }),
    // The harness's native state routed into the soul's tool home (#583
    // slice 2); the executor hands it to the harness, the reach server
    // and keyd's relay alike, since it is a path, not a secret.
    toolHomeEnvFor: ({ agentId, harness }) => soulToolHomeEnv(agentId, { env, home, config, file: populationFile({ env, home }), harness }),
    // The provider secret for the launched harness, read from the soul's
    // store per turn (#583 slice 4); the executor keeps it out of the
    // reach server and keyd's relay.
    providerEnvFor: ({ agentId, harness }) => soulProviderEnv(agentId, { env, home, config, file: populationFile({ env, home }), harness }),
  };
  // The ACP executor is off unless the user config turns it on (#259):
  // `"executor": { "enabled": true, "policy": { ... } }`. Without it /v1
  // keeps its unconfigured error and cold wake reports `waiting`.
  const setup = (config ?? loadConfig({ home, env })).executor;
  const identities = (agentId) => readAgentIdentity(validateAgentId(agentId), { stateDir: stateDirectory({ env, home }) });
  const identityFor = (agentId) => soulPromptIdentity(agentId, { env, home });
  // An embedded host turns the executor on for its own daemon (ADR-0276).
  const configuredExecutorFor = setup?.enabled === true || env.AGENT_BOT_EXECUTOR === '1'
    ? acpExecutorFor({
      identities,
      policy: setup?.policy ?? { version: 1, rules: [], fallback: 'deny' },
      baseEnv: harnessEnv,
      interactionStore: { env, home },
      modeFor: daemonModeFor({ env, home, config }),
      modelFor: (agentId) => soulModel(agentId, { env, home }).model,
      identityFor,
      onModels: (agentId, models) => recordSoulModels(agentId, models, { env, home }),
      // A daemon-run soul's home is not a git worktree, so the session-start
      // hook cannot place its Claude session; the turn's binding does.
      onHarnessSession: ({ agentId, harness, harnessSessionId }) => recordSoulSession({ agentId, provider: harness, sessionId: harnessSessionId, env, home, now, history }),
      // Every turn gets the soul's agent-comms tools unless its launch
      // recorded comms off; the reach server runs agent-comms, which a
      // launchd PATH does not reach.
      commsFor: (agentId) => showSoul(agentId, { file: populationFile({ env, home }) }).comms,
      reachEnv: { PATH: resumePath(harnessEnv, home) },
      // Where a joined soul's npm adapter is (#417, #583 slice 8): its
      // runtimes installs newest first, then the legacy harness directory.
      // A soul with no identity record has no recorded harness: the legacy
      // directory alone, as before slice 8.
      harnessDirsFor: (agentId) => {
        let harness = null;
        try { harness = identities(agentId).harness ?? null; } catch { /* no identity: legacy only */ }
        return soulNpmHarnessDirs(agentId, harness, { env, home, config, file: populationFile({ env, home }) });
      },
      ...turnEnvPorts,
      // Engine diagnostics (a spawn that failed, a nameless permission) go
      // to the daemon's stderr, which the supervisor unit files as a log.
      log: (line) => process.stderr.write(`${line}\n`),
      // A soul whose soul.json says its key is in agent-bot-keyd gets keyd's
      // relay, when this host installed keyd.
      keydFor: (agentId) => {
        const record = readKeydRecord({ env, home });
        if (!record) return null;
        const declaration = soulCredentialsDeclaration(soulDirectory(agentId, { file: populationFile({ env, home }), env, home }));
        return declaration?.store === 'keyd' ? record.bin : null;
      },
    })
    : null;
  const computerUse = createComputerUseActivity({ now });
  const isPaused = (agentId) => soulPaused(agentId, { file: populationFile({ env, home }) });
  // Every turn and harness session is mirrored into the soul's own
  // `.soul-state/runs/` beside the daemon's journals (#583 decision 9).
  const history = createSoulHistory({ env, home, file: populationFile({ env, home }), log: (line) => process.stderr.write(`agent-daemon: ${line}\n`) });
  let dream = null;
  // The persona policy is checked again at the start of every turn (#613).
  const policy = ({ agentId, ownerVerified }) => {
    const problem = turnSandboxProblem(agentId, { env, home, acceptStale: ownerVerified });
    if (problem) throw problem;
  };
  const turns = createTurnRegistry({ isPaused, policy, history, now, onStop: agentId => dream?.stopSoul(agentId) ?? false });
  const executorFor = configuredExecutorFor
    ? (request) => withPermissionReceipts(configuredExecutorFor(request), { env, home, now, computerUse })
    : null;
  const executor = executorFor
    ? (input) => {
      const identity = identities(input.invocation.agentId);
      return executorFor({ agentId: identity.id, harness: identity.harness, cwd: input.invocation.cwd ?? setup?.cwd ?? home, env: {} })(input);
    }
    : undefined;
  // The comms supervisor idles until a pairing credential exists, then keeps
  // the broker's account-watch stream open for this account's wakes (#255).
  // Each wake goes through the wake plane: a warm socket, else the opt-in
  // cold turn, else `waiting` (ADR-0008 decisions 7 to 9).
  let server;
  const onWake = (wake, ports) => server.wakePlane(wake, ports);
  // One provisioner for the daemon's life, so concurrent launches of a new
  // soul share its creation; it installs with this daemon's environment.
  let homes;
  const provisionHome = (soul) => {
    const file = populationFile({ env, home });
    // Older package launches could have an identity and home without a
    // census row. Register that provenance before resolving its directory.
    // The row names the spaces-root path without creating it: the folder
    // provisioned next starts the space inside itself (ADR-0583 decision 8),
    // or links an older space already there.
    if (!listSouls({ file }).some((record) => record.id === soul.agentId)) {
      upsertIdentitySoul(soul.agentId, spacePath(soul.agentId, { env, home, config }), { file, stateDir: stateDirectory({ env, home }), now });
    }
    homes ??= createSoulHomes({ env, home, config, stateDir: stateDirectory({ env, home }), bindings: server.bindings,
      install: (dir, installOptions) => installHarnesses(dir, installOptions) });
    return homes(soul);
  };
  // Whether the launched soul's (or package's) soul.json pins a download for
  // the harness: then its absence from the host PATH is not a problem.
  const launchDeclaresHarnessInstall = (harness, { soul = null, package: packagePath = null } = {}) => {
    try {
      const dir = soul ? soulDirectory(soul, { env, home, config, file: populationFile({ env, home }), readOnly: true }) : packagePath;
      return harnessInstallDeclared(dir, harness);
    } catch { return false; }
  };
  const onLaunch = createLaunchHandler({
    turns, isPaused,
    file: path.join(path.dirname(daemonStateFile({ env, home })), 'launch-requests.json'),
    identities,
    identityFor,
    // A package spawn is a new root soul with no GitHub App (#297). The
    // package is validated before minting, so a bad path mints nothing.
    // A team member (#377) is the same spawn with its parent recorded.
    spawnPackage: async ({ package: packagePath, harness, name, role = null, parent = null }) => {
      if (name !== undefined) return spawnSoulTemplate(packagePath, { name, role, harness, parentId: parent, env, home, config, now,
        stateDir: stateDirectory({ env, home }) });
      validateSoulPackage(packagePath);
      return mintAgentIdentity({ appSlug: null, harness, packageRevision: computePackageRevision(packagePath), useGithub: false, parentId: parent,
        stateDir: stateDirectory({ env, home }), now });
    },
    lookupBinding: (agentId, { harness } = {}) => soulBindingForLaunch(agentId, {
      stateDir: stateDirectory({ env, home }), bindings: server.bindings,
      provision: provisionHome, harness: harness ?? identities(agentId).harness ?? null,
      prepareHarness: async (id, selected, worktree) => {
        const { ensureAcpHarness } = await import('./soul-join.mjs');
        await ensureAcpHarness(id, selected, worktree, { env, options: { env, home, config } });
      },
    }),
    provisionHome: (soul) => provisionHome(soul),
    locatePackage: (packagePath) => locateSoulDir(packagePath, { env, home, config, file: populationFile({ env, home }) }),
    // A copy of a soul's folder becomes a new soul (#432): the `soul fork`
    // mechanism, authorized by this launch rather than the owner gate, and
    // joined below from its home as any launched soul is. The original soul
    // and its folder are never touched. Loaded here, not at the top: the
    // fork imports `agent-bot join`, whose CLI awaits this module.
    forkCopy: async ({ package: copy, name, role = null, harness, parent = null }) => {
      const { forkSoul } = await import('./soul-fork.mjs');
      const forked = await forkSoul({ copy, name, role, harness, parentId: parent, env, home, config, now,
        gate: async () => ({ method: 'launch' }), join: null });
      return { id: forked.agentId, ...forked };
    },
    // ADR-0276: an existing soul's own harness, else a package's preference,
    // else a registry harness on PATH.
    defaultHarness: async ({ soul, package: packagePath }) => {
      if (soul) return identities(soul).harness ?? defaultHarnessFor([], { available: (cmd) => onPath(cmd, env) });
      let preferred = [];
      try { preferred = JSON.parse(readFileSync(path.join(packagePath, 'soul.json'), 'utf8')).preferredHarnesses ?? []; } catch {}
      return defaultHarnessFor(Array.isArray(preferred) ? preferred : [], { available: (cmd) => onPath(cmd, env) });
    },
    // A principal launched this soul to talk to it, so later messages wake it.
    onLaunched: (agentId) => setColdWake(agentId, true, { env, home, now }),
    discard: (agentId, rollback) => discardFailedLaunch(agentId, rollback, { env, home, config, now }),
    // Refused before a spawn mints: the registry row, enabled, and its command on the soul's PATH.
    harnessProblem: (harness, target) => harnessLaunchRefusal(harness, { env: harnessEnv, declared: launchDeclaresHarnessInstall(harness, target) }),
    // What the soul declares and lacks is installed into its folder before
    // it joins (#583 slice 3): runtimes from the pin catalog, non-npm
    // harnesses from their pinned downloads. Nothing lands on the host.
    runtimes: {
      pending: ({ agentId }) => pendingSoulRuntimes(agentId, { env, home, config, file: populationFile({ env, home }) }),
      install: ({ agentId, harness }) => provisionSoulRuntimes(agentId, { env, home, config, file: populationFile({ env, home }), harness,
        log: (line) => process.stderr.write(`soul runtimes: ${line}\n`) }),
    },
    // The launched harness's tool home is made before the soul joins (#583
    // slice 2), so it starts into its own store or fails `tool-home-unwritable`.
    toolHomes: {
      pending: ({ agentId, harness }) => pendingSoulToolHome(agentId, { env, home, config, file: populationFile({ env, home }), harness }),
      prepare: ({ agentId, harness }) => prepareSoulToolHome(agentId, { env, home, config, file: populationFile({ env, home }), harness }),
    },
    // The launched harness's provider secret is checked before the soul
    // joins (#583 slice 4): a missing one fails the launch with the
    // `soul secret set` command, not a harness that cannot authenticate.
    providers: {
      pending: ({ agentId, harness }) => pendingSoulProvider(agentId, { env, home, config, file: populationFile({ env, home }), harness }),
      check: ({ agentId, harness }) => checkSoulProvider(agentId, { env, home, config, file: populationFile({ env, home }), harness }),
    },
    // The launched harness's sign-in, probed with the environment its turn
    // gets (#536): routed tool home, runtimes and provider env included, so
    // an OpenCode provider variable counts as it does for the harness.
    signIn: {
      check: async ({ agentId, harness }) => {
        if (!ACP_SPAWN_REGISTRY[harness]?.signIn) return null;
        const { harnessEnv: probeEnv } = composeTurnEnv({ agentId, harness, baseEnv: harnessEnv, ...turnEnvPorts });
        let soulHome = null;
        try { soulHome = soulHomePath(agentId, { file: populationFile({ env, home }), env, home }); } catch { /* no folder: PATH's CLI */ }
        const evidence = await harnessAuth('status', harness, { home: soulHome && existsSync(soulHome) ? soulHome : null, env: probeEnv });
        return { status: evidence.status, ...(evidence.reason ? { reason: evidence.reason } : {}) };
      },
    },
    // What the soul gets (#376): its override over the global switch, and
    // for a sandboxed one the account's readiness and the owner's steps.
    sandboxFor: ({ agentId, name = null, role = null, acceptStale = null }) => launchSandbox(agentId, { env, home, name, role, acceptStale }),
    // A principal's launch past a stale persona record asks the owner (#613).
    verifyOwner: (action) => confirmOwnerPresence(action, { env }),
    joinSoul: async (soul) => {
      const address = await joinLaunchedSoul(soul, { env });
      // The census shows the launch name; every command shows it too (#429).
      if (soul.name) {
        try { recordSoulDisplayName(soul.agentId, soul.name, { file: populationFile({ env, home }) }); } catch { /* shown by soul.json name */ }
      }
      return address;
    },
    // The comms setting is read here, at launch only; turns read the census.
    recordLaunch: (launch) => recordLaunchSettings(launch, { env, home, config, now }),
    // A principal's launch may name the new soul's parent (GeniusBar#261),
    // checked against the active census; its outcome leaves the receipt a
    // team start leaves, on the parent, with the operation telling them apart.
    souls: () => listSouls({ status: 'active', file: populationFile({ env, home }) }),
    receipt: ({ parent, decision }) => appendAuditReceipt({ event: 'team-start', agentId: parent, operation: 'launch', decision }, { env, home, now }),
    // The owner-activated SOP launch policy (#677), read offline each launch.
    // An owner's launch it refuses asks the owner to verify and override;
    // every outcome leaves a `sop-policy` audit receipt.
    policy: {
      check: ({ harness }) => checkSopLaunchPolicy(harness, { env, home }),
      override: (refusal, { harness }) => confirmOwnerPresence(refusal.ruleId
        ? `launch on ${harness} although SOP policy rule ${refusal.ruleId} denies it`
        : `launch on ${harness} although the active SOP policy is unavailable`, { env }),
      receipt: ({ agentId, decision, detail }) => appendAuditReceipt({ event: 'sop-policy', agentId, operation: 'launch', decision, detail }, { env, home, now }),
    },
    executorFor,
  });
  // Souls launched before 0.10.9 read as unmanaged until marked from the
  // journal (#409). A census that cannot be rewritten leaves them as they are.
  try { backfillManagedSouls(onLaunch.launched(), { file: populationFile({ env, home }) }); } catch { /* shown as unmanaged */ }
  const comms = createCommsSupervisor({ env, home, now, onWake, onLaunch });
  const relay = createCommsRelay({ env: { ...harnessEnv, PATH: resumePath(harnessEnv, home) } });
  const taskReporter = createTaskReporter({
    file: path.join(path.dirname(daemonStateFile({ env, home })), 'task-turns.jsonl'),
    now,
    report: async (invocation) => {
      const binding = server.bindings.findAgent(invocation.agentId) ?? recordedWorktree(invocation.agentId, { env, home });
      if (!binding?.worktree) throw new Error('soul binding is unavailable');
      return relay.report({ agentId: invocation.agentId, binding }, invocation);
    },
  });
  // A soul's teammates go through the same launch handler as a principal's
  // launch; only the parent differs, and only the daemon can set it.
  const userConfig = config ?? loadConfig({ home, env });
  const account = env.USER ?? process.env.USER ?? 'unknown';
  const teamStarter = createTeamStarter({
    souls: () => listSouls({ status: 'active', file: populationFile({ env, home }) }),
    identities: (agentId) => { try { return identities(agentId); } catch { return null; } },
    launch: (event) => new Promise((resolve, reject) => {
      const { parent, ...request } = event;
      onLaunch(request, { account, parent, report: async (row) => resolve(row) }).catch(reject);
    }),
    receipt: ({ agentId, decision, detail = null }) => appendAuditReceipt({ event: 'team-start', agentId, operation: 'start_soul', decision, detail }, { env, home, now }),
    limits: teamLimits(userConfig),
    // The caller's own model listing (recorded from its ACP sessions) checks
    // a requested model for a teammate on the same harness (GeniusBar#261).
    models: (agentId) => { try { return soulModel(agentId, { env, home }); } catch { return null; } },
    launchable: (harness) => harnessLaunchProblem(harness, { env: harnessEnv }) ?? true,
    template: () => defaultTeamTemplate({ config: userConfig, env }),
    account,
  });
  server = createDaemonServer({ env, home, config, now, comms, executor, taskReporter, teamStarter, computerUse, turns, asideRelay: relay });
  dream = createDreamService({ directory: path.join(path.dirname(daemonStateFile({ env, home })), 'dream'),
    turns, executorFor, isPaused, now, approvals: request => server.interaction.requestTurnApproval(request),
    verifyRevisionEvidence: request => verifyDreamRevisionEvidence({ ...request, stateDir: stateDirectory({ env, home }) }),
    lookupSoul: agentId => {
      const options = { env, home, file: populationFile({ env, home }) };
      const row = showSoul(agentId, options), identity = identities(agentId);
      if (row.status !== 'active' || identity.status === 'retired') throw new Error('soul is inactive');
      const directory = soulDirectory(agentId, { ...options, readOnly: true });
      if (!lstatSync(directory).isDirectory() || !lstatSync(path.join(directory, '.soul-state')).isDirectory()) throw new Error('unsafe soul directory');
      const located = locateSoulDir(directory, options);
      if (located.status !== 'installed' || located.agentId !== agentId) throw new Error('soul directory is not authoritative');
      return { directory: realpathSync(directory), harness: identity.harness };
    },
  });
  server.dream = dream;
  await taskReporter.recover({ log: (line) => process.stderr.write(`agent-daemon: ${line}\n`) });
  server.wakePlane = createWakePlane({
    turns, isPaused,
    pool: server.warmPool,
    settings: () => readColdWakeSettings({ env, home }),
    lookupSoul: (agentId) => server.bindings.findAgent(agentId) ?? recordedWorktree(agentId, { env, home }),
    identities,
    executorFor,
    // Resume wake (#323) needs no executor config: it runs only for a soul
    // the owner set to `resume <policy>`.
    resumeExecutor: createResumeExecutor({
      sessions: createWakeSessions({ file: wakeSessionsFile({ env, home }) }),
      baseEnv: harnessEnv,
      home,
      // The soul's declared runtimes and harness installs, and its provider
      // secret, as an ACP turn gets them (#617 slice 3b). Tool-home routing
      // stays off on this lane for now: its recorded sessions live in the
      // host store, and moving CODEX_HOME / the OpenCode XDG bases would
      // strand them (open on #617).
      runtimeEnvFor: turnEnvPorts.runtimeEnvFor,
      providerEnvFor: turnEnvPorts.providerEnvFor,
    }),
    // Webhook wake (#334) runs only for a soul the owner set to `webhook`.
    webhookWaker: createWebhookWaker({ read: (agentId) => readWebhook(agentId, { env, home }) }),
    // The relay runs agent-comms, which a launchd PATH does not reach.
    relay,
    taskReporter,
    // A turn whose harness is signed out (#84) marks the soul in the census
    // until a turn runs again.
    authStatus: {
      failed: (agentId, status) => recordHarnessAuth(agentId, status, { file: populationOverride(env, home), now }),
      cleared: (agentId) => recordHarnessAuth(agentId, null, { file: populationOverride(env, home) }),
    },
    // Receipts carry a soul and a decision, never message IDs or content.
    receipt: ({ event, agentId, decision, outcome, detail = null }) => appendAuditReceipt({ event, agentId, decision: decision ?? outcome, detail }, { env, home, now }),
    // A policy `approval` outcome in a cold turn waits on a proposal the
    // owner can decide (#85: `agent-bot approvals`, GeniusBar's panel).
    approvals: (request) => server.interaction.requestTurnApproval(request),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, resolve);
  });
  const file = daemonStateFile({ env, home });
  const state = {
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    host,
    port: server.address().port,
    token: server.token,
    startedAt: now().toISOString(),
  };
  writeStateFile(file, state);
  comms.start();
  try { dream.start(); } catch { /* service status reports the fault; other daemon services remain available */ }
  const logTimer = setInterval(checkLog, DAEMON_LOG_CHECK_INTERVAL_MS);
  logTimer.unref();
  server.once('close', () => { clearInterval(logTimer); dream.shutdown(); });
  const shutdown = () => {
    clearInterval(logTimer);
    dream.shutdown();
    try {
      comms.stop();
    } catch {
      /* the watch loop is already down */
    }
    try {
      const recorded = readStateFile(file);
      // Another daemon may have replaced a stale record; only remove our own.
      if (recorded && recorded.pid === process.pid) rmSync(file, { force: true });
    } catch {
      /* an unreadable state file is not ours to preserve */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  onListening?.(state, server);
  return { server, state, comms };
}

const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function startDaemon({ env = process.env, home = homedir(), moduleUrl = import.meta.url } = {}) {
  const existing = await daemonStatus({ env, home });
  if (existing.running) return { ...existing, alreadyRunning: true };
  // fileURLToPath, not URL.pathname: a checkout path with spaces stays
  // percent-encoded in the pathname and the child exits module-not-found
  // (and drive letters break on Windows).
  const child = spawn(process.execPath, [fileURLToPath(moduleUrl), 'run'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await daemonStatus({ env, home });
    if (status.running) return { ...status, alreadyRunning: false };
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('daemon did not become healthy within the startup deadline');
}

export async function stopDaemon({ env = process.env, home = homedir(), fetchImpl = fetch } = {}) {
  const file = daemonStateFile({ env, home });
  const state = readStateFile(file);
  if (!state) return { stopped: false, reason: 'no daemon state file' };
  // A recorded PID can be reused by an unrelated process after a crash or
  // reboot. Only the token-authenticated health probe proves the record still
  // names our daemon, so a failed probe removes the stale record and signals
  // nothing.
  if (!(await probeHealth(state, { fetchImpl }))) {
    rmSync(file, { force: true });
    return {
      stopped: false,
      reason: 'recorded daemon did not answer the authenticated health probe; removed stale state',
    };
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      rmSync(file, { force: true });
      return { stopped: false, reason: 'recorded daemon was not running; removed stale state' };
    }
    throw error;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
    } catch {
      rmSync(file, { force: true });
      return { stopped: true, pid: state.pid };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`daemon pid ${state.pid} did not exit within the shutdown deadline`);
}

function brokerFlag(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--broker' || args[index].startsWith('--broker=')) {
      const value = args[index] === '--broker' ? args[index + 1] : args[index].slice('--broker='.length);
      if (!value || value.startsWith('--')) throw new Error('--broker requires an account name');
      return value;
    }
  }
  return null;
}

function formatCommsStatus(comms) {
  if (!comms?.paired) return 'comms: not paired (run `agent-bot daemon pair-comms [--broker <account>]`)';
  return `comms: paired as ${comms.account}, account-watch ${comms.connected ? 'connected' : 'disconnected'}`;
}

// A config from before the feature gates keeps the add-ons it was running
// with (#361). Never fatal: the daemon starts either way.
function reportPreGateMigration() {
  try {
    const result = migratePreGateConfig();
    if (result.migrated) {
      process.stderr.write(`agent-bot: ${result.path} predates feature gates and its souls use GitHub Apps; turned on ${Object.keys(result.features).join(' and ')} to keep that behavior\n`);
    }
  } catch (error) {
    process.stderr.write(`agent-bot: could not check the config for pre-gate add-ons: ${error.message}\n`);
  }
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  switch (command) {
    case 'run': {
      reportPreGateMigration();
      await runDaemon({
        onListening: (state) => {
          process.stderr.write(`agent-bot daemon listening on 127.0.0.1:${state.port} (pid ${state.pid})\n`);
        },
      });
      break;
    }
    case 'start': {
      const status = await startDaemon();
      process.stdout.write(
        status.alreadyRunning
          ? `daemon already running (pid ${status.pid}, port ${status.port})\n`
          : `daemon started (pid ${status.pid}, port ${status.port})\n`,
      );
      break;
    }
    case 'status': {
      const status = await daemonStatus();
      if (json) {
        process.stdout.write(`${JSON.stringify(status, (key, value) => (key === 'stale' ? undefined : value), 2)}\n`);
      } else if (status.running) {
        process.stdout.write(`running (pid ${status.pid}, port ${status.port}, since ${status.startedAt})\n`);
        process.stdout.write(`${formatCommsStatus(status.comms)}\n`);
        const warm = Object.entries(status.warmPool ?? {});
        process.stdout.write(warm.length
          ? `warm pool: ${warm.map(([id, count]) => `${id} (${count})`).join(', ')}\n`
          : 'warm pool: empty\n');
      } else {
        process.stdout.write(`not running: ${status.reason}\n`);
        process.stdout.write(`${formatCommsStatus(status.comms)}\n`);
      }
      if (!status.running) process.exitCode = 1;
      break;
    }
    case 'pair-comms': {
      const broker = brokerFlag(rest);
      const pairing = await pairDaemonComms({ brokerAccount: broker });
      if (json) {
        process.stdout.write(`${JSON.stringify(pairing, null, 2)}\n`);
      } else {
        process.stdout.write(`daemon pairing requested for account '${pairing.account}' (state: ${pairing.state})\n`);
        process.stdout.write(`owner approval code: ${pairing.code}\n`);
        process.stdout.write('the owner approves this code on the broker admin socket, exactly like an account pairing\n');
      }
      break;
    }
    case 'stop': {
      const result = await stopDaemon();
      process.stdout.write(result.stopped ? `daemon stopped (pid ${result.pid})\n` : `${result.reason}\n`);
      break;
    }
    case 'install': {
      const unexpected = rest.filter((arg) => arg !== '--json');
      if (unexpected.length > 0) throw new Error('usage: agent-bot daemon install [--json]');
      reportPreGateMigration();
      const { ensureDaemonSupervisor } = await import('./daemon-supervisor.mjs');
      // This runtime exactly: the node running now and its agent-bot entry.
      const entry = fileURLToPath(new URL('./agent-bot.mjs', import.meta.url));
      const result = await ensureDaemonSupervisor({
        programArguments: [process.execPath, entry, 'daemon', 'run'],
        reloadUnchanged: false,
      });
      if (!result.applied) throw new Error(`no user-level supervisor on ${result.platform}`);
      const summary = { label: result.label, unitPath: result.unitPath, changed: result.refreshed, loaded: result.loaded };
      process.stdout.write(json
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `daemon supervisor ${summary.changed ? 'installed' : 'unchanged'}: ${summary.label} (${summary.unitPath})\n`);
      break;
    }
    case 'disable': {
      const { disableDaemonSupervisor } = await import('./daemon-supervisor.mjs');
      const result = await disableDaemonSupervisor();
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.unloaded) {
        process.stdout.write('daemon supervisor unloaded\n');
      } else {
        process.stdout.write(`${result.reason}\n`);
      }
      break;
    }
    case 'vouch-key': {
      const unexpected = rest.filter((arg) => arg !== '--json');
      if (unexpected.length > 0) throw new Error('usage: agent-bot daemon vouch-key');
      const { publicKeyPem } = loadOrCreateVouchKey(vouchStateDir());
      process.stdout.write(publicKeyPem.endsWith('\n') ? publicKeyPem : `${publicKeyPem}\n`);
      break;
    }
    default:
      throw new Error('usage: agent-bot daemon <run|start|status|stop|install|disable|vouch-key|pair-comms> [--json]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-daemon: ${error.message}\n`);
    process.exit(1);
  });
}
