// Principal launches arrive on the authenticated account watch. The journal
// stores only correlation and outcomes, never principal data or credentials.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { HARNESS_SESSION_EVENT } from './executor-contract.mjs';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { validateModelId } from './soul-model.mjs';
import { soulCommsSetting } from './soul-package.mjs';
import { assertSoulUnpaused, displayName, normalizeLaunchBrief } from './agent-population.mjs';
import { createTurnRegistry } from './turn-registry.mjs';
import { sandboxLaunchProblem } from './sandbox.mjs';

// A launch's comms setting: the soul's own soul.json (a spawned instance
// carries its template's), else the launched package's, else on.
export function launchCommsSetting({ soulDir = null, packagePath = null } = {}) {
  return (soulDir && soulCommsSetting(soulDir)) ?? (packagePath && soulCommsSetting(packagePath)) ?? true;
}

/** Longest display name the broker accepts on a launch request. */
export const LAUNCH_NAME_MAX = 128;
// Same bound as agent-population's ROLE_MAX, which `population list` applies on read.
export const LAUNCH_ROLE_MAX = 60;

// `provisionHome` binds a soul that has no live binding (#297); `discard`
// rolls back a soul this request spawned when its first start fails, so a
// failed package launch leaves no active identity, folder or agent-comms
// membership behind (#419). It gets `{ binding, joined }`: what this request
// got as far as. `joinSoul` joins
// the soul to agent-comms as itself before its first turn: the broker takes
// `launched` only from a joined soul, and a harness not yet signed in (a
// fresh install) cannot run the turn that would join it. `recordLaunch`
// records, before the first turn, that the daemon manages this soul and the
// comms setting its soul.json has now; the setting holds until the next
// launch, so a running soul's comms cannot be switched off under it. A
// launch that names `comms` writes it to the soul's soul.json first.
//
// `parent` (#377) comes from the daemon's own caller in the second argument
// when a soul starts its team: it passes itself, and the event cannot
// override that. A principal launch passes nothing there; its event may
// name `parent` (GeniusBar#261), honoured only when the daemon supplies
// `souls` (active census rows `{ id, parentId }`) to check it against:
// `null` or absent starts an independent soul, an agent id must be an
// active soul in this account's census and not the launched soul itself,
// and a relaunch keeps the parent its census row records (a different one
// is refused, never rewritten quietly). A handler without `souls` drops the
// event's field as before. The event's `parent` never reaches the spawn
// request as such; the resolved value does.
const withoutParent = ({ parent: _ignored, ...fields }) => fields;
const AGENT_ID = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function resolveLaunchParent(parent, { soul = null, souls }) {
  if (parent === undefined) return null; // the default: a relaunch keeps whatever its census row records
  if (parent === null) {
    if (soul && souls().find((row) => row.id === soul)?.parentId) {
      throw new Error(`relaunching ${soul} cannot make it independent: its census row names a parent; launch it with that parent, or omit parent`);
    }
    return null;
  }
  if (typeof parent !== 'string' || !AGENT_ID.test(parent)) throw new Error('invalid launch parent: null or an agent id');
  if (parent === soul) throw new Error('a soul cannot be its own parent');
  const rows = souls();
  if (!rows.some((row) => row.id === parent)) throw new Error(`launch parent ${parent} is not an active soul in this account's census`);
  if (soul) {
    const recorded = rows.find((row) => row.id === soul)?.parentId ?? null;
    if (recorded !== parent) {
      throw new Error(`relaunching ${soul} cannot change its parent to ${parent}: its census row names ${recorded ?? 'no parent'}; launch it with that, or omit parent`);
    }
    // The same parent as recorded: the relaunch keeps it; nothing to rebind.
    return null;
  }
  return parent;
}

// `locatePackage` says what a package path is (#80). A folder that is an
// installed soul's own launches that soul, never a new one, and under its
// own name: the launch's name is for a soul the launch makes, so it never
// renames an existing one (#432). A copy of a soul's folder carries that
// soul's marker; with `forkCopy` (the `soul fork` mechanism) the launch
// makes the copy a new soul, named by the launch, and the original is never
// touched. Only a principal's launch may: the fork rewrites the copy in
// place and archives its working state, which `soul fork` keeps owner only,
// and a soul starting its team (#377) chooses its own template path. Without
// the port, a name, or a principal, a copy is refused with its reason, as a
// marker naming no active soul here always is.
const LAUNCHABLE = new Set(['package', 'installed']);

// Failure codes a launch keeps in the journal and prefixes to its detail, so
// a client that reads only the broker's detail still sees which one it was.
const LAUNCH_CODES = new Set(['soul-paused', 'sandbox-not-ready', 'sandbox-other-account',
  'persona-policy-unavailable', 'persona-policy-stale', 'persona-policy-requires-addon',
  'runtime-download-failed', 'runtime-checksum-mismatch', 'runtime-unsupported-platform', 'runtime-install-failed',
  'tool-home-unwritable', 'tool-home-record-invalid',
  'provider-secret-missing', 'provider-secret-unreadable', 'provider-declaration-invalid',
  'harness-signed-out', 'harness-unknown', 'harness-disabled', 'harness-tool-missing']);

// `runtimes` (#583 slice 3): `pending({ agentId, harness })` names what the
// soul declares and lacks; `install` provisions it into the soul folder.
// The `runtimes` stage is reported only when there is something to install,
// and a failure is the coded runtime error with the command that fixes it.
//
// `toolHomes` (#583 slice 2): `pending({ agentId, harness })` names the
// tool home a routable harness gets (`tool-home:<harness>`); `prepare`
// creates `.soul-state/tools/<harness>` so the harness starts into its own
// store, and fails `tool-home-unwritable` (reported at the `tool-home`
// stage) when it cannot, before the soul joins. An unroutable harness has
// nothing pending and no stage.
//
// `providers` (#583 slice 4): `pending({ agentId, harness })` names the
// provider the launched harness declares with a secret; `check` reads that
// secret back from the soul's store and fails with `provider-secret-
// missing` (naming `agent-bot soul secret <id> set <name>`) before the
// soul joins. The `provider` stage is reported only when there is one to
// check. The value itself never reaches this handler or its journal.

// `signIn` (#536): `check({ agentId, harness })` probes the harness's
// sign-in with the environment its turn will get, returning `{ status,
// reason? }` (harness-auth.mjs evidence), or null for a harness with no
// status reader. The `sign-in` stage is reported only when there is a
// reader, and the journal keeps the evidence. Only positive `signed-out`
// refuses, and only for an existing soul: `agent-bot harness auth login
// HARNESS --soul ID` signs in to the same store, routed or not. A new soul
// continues: its ID is discarded on rollback, so the command could not be
// run, and a routed new soul's tool home starts empty, so a refusal would
// block every first launch. Its first turn raises the #84 sign-in notice.
// `unknown` continues and is never readiness; the harness-session event
// still is. A probe that throws is `unknown`.

// `sandboxFor` (#376) says what the soul gets, `sandboxed` or
// `unrestricted`, and the account it runs as, from `launchSandbox` in
// sandbox.mjs. Without it a launch is what it always was. A sandboxed soul
// whose account is not ready fails at the `account` stage with the owner's
// next step, before a package spawn mints anything; one this daemon's own
// account cannot run fails there too (see `sandboxLaunchProblem`). The
// journal row keeps `sandbox: { resolution, account }`, and the report
// carries it beside the unchanged `launched`/`failed` fields.
//
// `verifyOwner` (#613, owner decision 2026-10-09): the owner has the final
// say, so a principal's launch refused only because the recorded persona
// policy is stale (`persona-policy-stale`) asks the owner to verify, by
// Touch ID or the dialog, instead of refusing. It gets `(action, { soul,
// package, source })` and returns the gate's proof, or throws when the owner
// declines or cannot be asked. Approved, the launch is decided by the stale
// record's own mapping (sandboxFor with `acceptStale`, never the user
// setting in its place), bound to the digest of the record the owner was
// shown, so a record that changes meanwhile is refused again. Its turn
// carries the approval, and the journal row keeps the receipt
// `ownerVerified: { code, method, source, digest }`, saved at once. Declined, it
// fails `persona-policy-stale` before anything is minted. A team start (the
// daemon's own caller, an agent) and a handler without `verifyOwner` are
// refused as before: nothing wired is a refusal, never a pass.

export function createLaunchHandler({ file, identities, spawnPackage, lookupBinding, provisionHome, discard = () => {}, onLaunched = () => {}, defaultHarness = () => null,
  isPaused = () => false, joinSoul = null, recordLaunch = null, locatePackage = null, forkCopy = null, identityFor = null, harnessProblem = null, sandboxFor = null, runtimes = null, toolHomes = null, providers = null, signIn = null,
  souls = null, receipt = () => {}, verifyOwner = null, executorFor, turnTimeoutMs = 30 * 60_000, turns = createTurnRegistry() }) {
  let rows = [];
  try { rows = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('launch journal is unreadable'); }
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.requestId !== 'string'
    || !['pending', 'launched', 'failed'].includes(row.status))) throw new Error('launch journal is invalid');
  const requests = new Map(rows.map((row) => [row.requestId, row]));
  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify([...requests.values()]), { mode: 0o600, flush: true });
    renameSync(temp, file);
  };
  for (const row of requests.values()) {
    if (row.status === 'pending') Object.assign(row, { status: 'failed', agentId: null,
      detail: 'daemon restarted before launch completed', reported: false });
  }
  if (rows.length) save();
  const reportRow = async (row, report) => {
    const { requestId, status, agentId, detail, code, sandbox } = row;
    await report({ requestId, status, agentId, ...(detail ? { detail } : {}), ...(code ? { code } : {}), ...(sandbox ? { sandbox } : {}) });
    row.reported = true;
    save();
  };
  const handle = async (event, { report, progress = null, account, parent: callerParent = null }) => {
    const { requestId } = event;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) throw new Error('invalid launch requestId');
    const prior = requests.get(requestId);
    if (prior) {
      if (prior.status !== 'pending') await reportRow(prior, report);
      return;
    }
    const row = { requestId, status: 'pending', agentId: null, reported: false };
    requests.set(requestId, row);
    save(); // Accept durably before minting an identity or starting a process.
    // Progress is best effort (#536): a broker without `launch-progress`, or
    // one that is away, never fails a launch. The journal keeps the stage so
    // a failure shows where it stopped.
    const step = async (stage) => {
      row.stage = stage;
      if (!progress) return;
      try { await progress({ requestId, stage }); } catch { /* best effort */ }
    };
    let spawned = null;
    const rollback = { binding: null, joined: false };
    // The parent the launch records: the daemon's caller (a team start), else
    // what a principal's event names once checked. `carried` is a parent the
    // event named for a new soul, so the outcome leaves a `team-start`
    // receipt on that parent as a team start's does. Receipts are best
    // effort here: an audit line that cannot be written never turns a
    // running soul into a failed launch.
    let parent = callerParent;
    let carried = null;
    const note = (of, decision) => { try { receipt({ parent: of, decision }); } catch { /* the launch result is what the principal sees */ } };
    try {
      await step('checking');
      if (event.account !== account) throw new Error('launch account does not match paired daemon');
      const targets = [event.soul, event.package].filter((value) => value !== undefined);
      if (targets.length !== 1 || typeof targets[0] !== 'string' || !targets[0]) {
        throw new Error('launch requires exactly one soul or package');
      }
      const located = event.package !== undefined && locatePackage ? await locatePackage(event.package) : null;
      const copied = located?.status === 'copy' && forkCopy !== null && callerParent === null;
      if (located && !LAUNCHABLE.has(located.status) && !copied) throw new Error(located.message ?? `cannot launch ${event.package}`);
      const soul = located?.status === 'installed' ? located.agentId : event.soul;
      if (soul) assertSoulUnpaused(isPaused(soul));
      const packagePath = soul ? null : event.package;
      if (callerParent === null && souls !== null && event.parent !== undefined) {
        const named = typeof event.parent === 'string' && AGENT_ID.test(event.parent) && event.parent !== soul ? event.parent : null;
        try { parent = resolveLaunchParent(event.parent, { soul: soul ?? null, souls }); }
        catch (error) { if (named) note(named, 'refused: parent'); throw error; }
        carried = parent;
      }
      // ADR-0276 order: the launch's own harness, else the soul's default,
      // else a registry harness found on PATH.
      const harness = event.harness ?? await defaultHarness(soul ? { soul } : { package: packagePath });
      if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) {
        throw new Error(event.harness === undefined ? 'no harness for this launch: name one, or install a harness' : 'invalid launch harness');
      }
      // A harness the daemon cannot start is refused here, before a package
      // spawn mints a soul and joins it to the hub (#531, GeniusBar#196): a launch
      // that fails later rolls back, and a rollback that fails part way
      // leaves a dead companion in the roster.
      // The port answers `{ code, message }` (harnessLaunchRefusal), or a
      // bare message from an older port, which stays uncoded.
      const problem = harnessProblem ? await harnessProblem(harness, { soul: soul ?? null, package: packagePath ?? null }) : null;
      if (problem) {
        const { code = null, message = problem } = typeof problem === 'string' ? {} : problem;
        throw Object.assign(new Error(`cannot launch on harness ${harness}: ${message}`
          + (code === 'harness-unknown' ? '; a harness agent-bot cannot start joins from its own session with `agent-bot join`' : '')), code ? { code } : {});
      }
      // Same bound as agent-comms' broker launch contract (lib/broker/launch.mjs).
      if (event.name !== undefined && (typeof event.name !== 'string' || !event.name.trim() || event.name.length > LAUNCH_NAME_MAX || /[\u0000-\u001f\u007f]/.test(event.name))) throw new Error('invalid launch name');
      // A short role for a new soul (#535), written into its manifest where
      // `population list` reads it; an existing soul keeps the role its
      // soul.json carries, so a relaunch cannot carry one.
      if (event.role !== undefined) {
        if (typeof event.role !== 'string' || !event.role.trim() || event.role.trim().length > LAUNCH_ROLE_MAX || /[\u0000-\u001f\u007f]/.test(event.role)) throw new Error('invalid launch role');
        if (soul) throw new Error(`a launch role names a new soul; ${soul} keeps the role in its soul.json`);
      }
      // Optional, chosen before start (#381): the soul's comms setting for
      // this and later launches. Absent keeps what its soul.json says.
      const brief = event.brief === undefined ? undefined : normalizeLaunchBrief(event.brief);
      if (event.model !== undefined) validateModelId(event.model);
      if (event.comms !== undefined && typeof event.comms !== 'boolean') throw new Error('invalid launch comms');
      if (copied && event.name === undefined) {
        throw new Error(`${event.package} is a copy of soul ${located.agentId}'s folder; name the launch to start it as a new soul`);
      }
      // Every check that can fail without starting runs before a package spawn mints.
      if (!executorFor) throw new Error('daemon ACP executor is disabled');
      if (parent !== null && soul) throw new Error('a team member is a new soul, not an existing one');
      // The soul's sandbox resolution: the SOP pack's persona mapping (by
      // the soul's name or role, so a soul this launch makes is matched by
      // the launch's), else an existing soul's override, else the switch.
      const sandboxRequest = { agentId: soul ?? null, ...(event.name === undefined ? {} : { name: event.name }), ...(event.role === undefined ? {} : { role: event.role.trim() }) };
      let sandbox = sandboxFor ? await sandboxFor(sandboxRequest) : null;
      let ownerVerified = null;
      if (sandbox) {
        let refused = sandboxLaunchProblem(sandbox);
        if (refused?.code === 'persona-policy-stale' && refused.digest && callerParent === null && verifyOwner) {
          await step('account');
          const source = refused.source ? `${refused.source.repository}@${refused.source.commit}` : null;
          const target = soul ?? (event.name === undefined ? packagePath : `${event.name} from ${packagePath}`);
          let proof;
          try {
            proof = await verifyOwner(`launch ${target} although its SOP persona record is stale${source ? ` (${source})` : ''}`,
              { soul: soul ?? null, package: packagePath, source: refused.source });
          } catch (error) {
            const why = String(error?.message ?? error).slice(0, 160);
            throw Object.assign(new Error(`the owner did not verify launching on a stale persona policy (${why}); ${refused.action}`), { code: refused.code });
          }
          ownerVerified = refused.digest;
          row.ownerVerified = { code: refused.code, method: typeof proof?.method === 'string' ? proof.method : 'owner', source: refused.source, digest: refused.digest };
          save(); // the receipt is durable before anything the approval allows
          sandbox = await sandboxFor({ ...sandboxRequest, acceptStale: refused.digest });
          refused = sandboxLaunchProblem(sandbox);
        }
        row.sandbox = { resolution: sandbox.resolution, account: sandbox.account };
        if (refused) { await step('account'); throw refused; }
      }
      const request = { ...withoutParent(event), harness, ...(event.role === undefined ? {} : { role: event.role.trim() }), ...(parent ? { parent } : {}) };
      const identity = soul ? await identities(soul) : copied ? await forkCopy(request) : await spawnPackage(request);
      if (!soul) spawned = identity?.id ?? null;
      await step('account');
      const binding = await lookupBinding(identity.id, { harness })
        ?? await provisionHome({ agentId: identity.id, harness, packagePath });
      if (!binding?.worktree || !binding?.file) throw new Error('soul binding is unavailable');
      rollback.binding = binding;
      if (runtimes) {
        const pending = await runtimes.pending({ agentId: identity.id, harness });
        if (pending.length) { await step('runtimes'); await runtimes.install({ agentId: identity.id, harness }); }
      }
      if (toolHomes) {
        const pending = await toolHomes.pending({ agentId: identity.id, harness });
        if (pending.length) { await step('tool-home'); await toolHomes.prepare({ agentId: identity.id, harness }); }
      }
      if (providers) {
        const pending = await providers.pending({ agentId: identity.id, harness });
        if (pending.length) { await step('provider'); await providers.check({ agentId: identity.id, harness }); }
      }
      if (signIn) {
        let evidence;
        try { evidence = await signIn.check({ agentId: identity.id, harness }); }
        catch { evidence = { status: 'unknown', reason: 'status-failed' }; }
        if (evidence) {
          await step('sign-in');
          row.signIn = { status: evidence.status, ...(evidence.reason ? { reason: evidence.reason } : {}) };
          if (evidence.status === 'signed-out' && soul) {
            throw Object.assign(new Error(`${harness} is signed out for this soul; sign it in with \`agent-bot harness auth login ${harness} --soul ${identity.id}\` and launch again`), { code: 'harness-signed-out' });
          }
        }
      }
      if (joinSoul) {
        await step('joining');
        rollback.joined = true; // a join that fails after the broker records it still needs a leave
        // An installed soul relaunched from its folder keeps its name (#432).
        const name = located?.status === 'installed' ? null : event.name ?? null;
        await joinSoul({ agentId: identity.id, harness, name, binding, ...(parent ? { parent } : {}) });
      }
      const recorded = recordLaunch ? await recordLaunch({ agentId: identity.id, package: packagePath, binding,
        ...(event.comms === undefined ? {} : { comms: event.comms }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(brief === undefined ? {} : { brief }),
        ...(event.comms === undefined && event.model === undefined ? {} : { principal: event.principal ?? null }) }) : null;
      const launchBrief = brief ?? recorded?.brief;
      // Best effort: the soul launches even if the population cannot be read.
      const lookup = async (id) => { try { return await identityFor?.(id) ?? null; } catch { return null; } };
      const ownIdentity = await lookup(identity.id);
      const parentId = parent ?? ownIdentity?.parent?.agentId ?? identity.parentId ?? null;
      const parentIdentity = parentId ? await lookup(parentId) : null;
      const identityText = `You are ${ownIdentity?.name || displayName(identity.id)} (agent id ${identity.id}). `
        + (parentId
          ? `Your parent is ${parentIdentity?.name || ownIdentity?.parent?.name || displayName(parentId)} (agent id ${parentId}). `
          : 'You have no parent agent. ');
      assertSoulUnpaused(isPaused(identity.id));
      await step('harness');
      const executor = executorFor({ agentId: identity.id, harness, cwd: binding.worktree,
        env: { AGENT_BOT_BINDING: binding.file, AGENT_BOT_ID: identity.id, QWTS_AGENT_ID: identity.id } });
      // An ACP session binding is the readiness boundary. A returned promise
      // alone is not evidence that the harness spawned successfully.
      await new Promise((resolve, reject) => {
        let started = false;
        Promise.resolve().then(() => turns.run({
          kind: 'launch',
          invocation: { agentId: identity.id, harness, cwd: binding.worktree },
          message: identityText + (launchBrief ? `\n\nYour brief from the person who launched you:\n${launchBrief}\n\n` : '') + (parent
            ? `You were started by ${parent}, another agent soul, as part of its team. Join agent-comms as usual, read your inbox, and handle incoming work; your parent will brief you there.`
            : 'You were launched by a principal. Join agent-comms as usual, read your inbox, and handle incoming work.'),
          attachments: [],
          appendEvent: (type, data) => {
            if (type === HARNESS_SESSION_EVENT) { started = true; resolve(); }
            return { type, data };
          },
          addArtifact: () => { throw new Error('a launch turn has no artifact store'); },
          requestApproval: async () => ({ decision: 'deny' }),
        }, executor, { turnTimeoutMs, ownerVerified })).then(() => { if (!started) reject(new Error('harness ended before session creation')); }, reject);
      });
      Object.assign(row, { status: 'launched', agentId: identity.id });
      if (carried) note(carried, 'launched');
      try { await onLaunched(identity.id); } catch { /* the soul runs; only later wakes are affected */ }
    } catch (error) {
      if (carried && row.status === 'pending') note(carried, 'failed');
      // The broker's launch-result wire carries detail, so retain the code
      // there too; local callers and the journal also get a structured code.
      const coded = LAUNCH_CODES.has(error.code);
      Object.assign(row, { status: 'failed', agentId: null, detail: coded ? `${error.code}: ${error.message}` : error.message,
        ...(coded ? { code: error.code } : {}) });
      // The launch failure is what the principal sees; a rollback that fails
      // part way is named beside it, so a companion that stays has a reason.
      if (spawned) { try { await discard(spawned, rollback); } catch (rollbackError) { row.detail = `${row.detail} (rollback failed: ${rollbackError.message})`; } }
    }
    save(); // Persist outcome before network I/O; retry only the report.
    await reportRow(row, report);
  };
  // Every soul this daemon has launched, for the managed backfill (#409).
  handle.launched = () => [...requests.values()]
    .filter((row) => row.status === 'launched' && typeof row.agentId === 'string')
    .map((row) => row.agentId);
  handle.recover = async ({ report }) => {
    for (const row of requests.values()) {
      if (row.status !== 'pending' && !row.reported) await reportRow(row, report);
    }
  };
  return handle;
}
