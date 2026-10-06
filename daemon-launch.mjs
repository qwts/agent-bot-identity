// Principal launches arrive on the authenticated account watch. The journal
// stores only correlation and outcomes, never principal data or credentials.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { HARNESS_SESSION_EVENT } from './executor-contract.mjs';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { validateModelId } from './soul-model.mjs';
import { soulCommsSetting } from './soul-package.mjs';
import { displayName } from './agent-population.mjs';
import { createTurnRegistry } from './wake-plane.mjs';

// A launch's comms setting: the soul's own soul.json (a spawned instance
// carries its template's), else the launched package's, else on.
export function launchCommsSetting({ soulDir = null, packagePath = null } = {}) {
  return (soulDir && soulCommsSetting(soulDir)) ?? (packagePath && soulCommsSetting(packagePath)) ?? true;
}

/** Longest display name the broker accepts on a launch request. */
export const LAUNCH_NAME_MAX = 128;

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
// `parent` (#377) comes only from the daemon's own caller in the second
// argument, never from the event: a soul starting its team passes itself, a
// principal launch passes nothing, and the broker's event cannot name one.
// A broker event's own `parent` field is dropped before anything sees it.
const withoutParent = ({ parent: _ignored, ...fields }) => fields;

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

export function createLaunchHandler({ file, identities, spawnPackage, lookupBinding, provisionHome, discard = () => {}, onLaunched = () => {}, defaultHarness = () => null,
  joinSoul = null, recordLaunch = null, locatePackage = null, forkCopy = null, identityFor = null, executorFor, turnTimeoutMs = 30 * 60_000, turns = createTurnRegistry() }) {
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
    const { requestId, status, agentId, detail } = row;
    await report({ requestId, status, agentId, ...(detail ? { detail } : {}) });
    row.reported = true;
    save();
  };
  const handle = async (event, { report, account, parent = null }) => {
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
    let spawned = null;
    const rollback = { binding: null, joined: false };
    try {
      if (event.account !== account) throw new Error('launch account does not match paired daemon');
      const targets = [event.soul, event.package].filter((value) => value !== undefined);
      if (targets.length !== 1 || typeof targets[0] !== 'string' || !targets[0]) {
        throw new Error('launch requires exactly one soul or package');
      }
      const located = event.package !== undefined && locatePackage ? await locatePackage(event.package) : null;
      const copied = located?.status === 'copy' && forkCopy !== null && parent === null;
      if (located && !LAUNCHABLE.has(located.status) && !copied) throw new Error(located.message ?? `cannot launch ${event.package}`);
      const soul = located?.status === 'installed' ? located.agentId : event.soul;
      const packagePath = soul ? null : event.package;
      // ADR-0276 order: the launch's own harness, else the soul's default,
      // else a registry harness found on PATH.
      const harness = event.harness ?? await defaultHarness(soul ? { soul } : { package: packagePath });
      if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) {
        throw new Error(event.harness === undefined ? 'no harness for this launch: name one, or install a harness' : 'invalid launch harness');
      }
      // Same bound as agent-comms' broker launch contract (lib/broker/launch.mjs).
      if (event.name !== undefined && (typeof event.name !== 'string' || !event.name.trim() || event.name.length > LAUNCH_NAME_MAX || /[\u0000-\u001f\u007f]/.test(event.name))) throw new Error('invalid launch name');
      // Optional, chosen before start (#381): the soul's comms setting for
      // this and later launches. Absent keeps what its soul.json says.
      if (event.model !== undefined) validateModelId(event.model);
      if (event.comms !== undefined && typeof event.comms !== 'boolean') throw new Error('invalid launch comms');
      if (copied && event.name === undefined) {
        throw new Error(`${event.package} is a copy of soul ${located.agentId}'s folder; name the launch to start it as a new soul`);
      }
      // Every check that can fail without starting runs before a package spawn mints.
      if (!executorFor) throw new Error('daemon ACP executor is disabled');
      if (parent !== null && soul) throw new Error('a team member is a new soul, not an existing one');
      const request = { ...withoutParent(event), harness, ...(parent ? { parent } : {}) };
      const identity = soul ? await identities(soul) : copied ? await forkCopy(request) : await spawnPackage(request);
      if (!soul) spawned = identity?.id ?? null;
      const binding = await lookupBinding(identity.id, { harness })
        ?? await provisionHome({ agentId: identity.id, harness, packagePath });
      if (!binding?.worktree || !binding?.file) throw new Error('soul binding is unavailable');
      rollback.binding = binding;
      if (joinSoul) {
        rollback.joined = true; // a join that fails after the broker records it still needs a leave
        // An installed soul relaunched from its folder keeps its name (#432).
        const name = located?.status === 'installed' ? null : event.name ?? null;
        await joinSoul({ agentId: identity.id, harness, name, binding, ...(parent ? { parent } : {}) });
      }
      if (recordLaunch) await recordLaunch({ agentId: identity.id, package: packagePath, binding,
        ...(event.comms === undefined ? {} : { comms: event.comms }),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.comms === undefined && event.model === undefined ? {} : { principal: event.principal ?? null }) });
      // Best effort: the soul launches even if the population cannot be read.
      const lookup = async (id) => { try { return await identityFor?.(id) ?? null; } catch { return null; } };
      const ownIdentity = await lookup(identity.id);
      const parentId = parent ?? ownIdentity?.parent?.agentId ?? identity.parentId ?? null;
      const parentIdentity = parentId ? await lookup(parentId) : null;
      const identityText = `You are ${ownIdentity?.name || displayName(identity.id)} (agent id ${identity.id}). `
        + (parentId
          ? `Your parent is ${parentIdentity?.name || ownIdentity?.parent?.name || displayName(parentId)} (agent id ${parentId}). `
          : 'You have no parent agent. ');
      const executor = executorFor({ agentId: identity.id, harness, cwd: binding.worktree,
        env: { AGENT_BOT_BINDING: binding.file, AGENT_BOT_ID: identity.id, QWTS_AGENT_ID: identity.id } });
      // An ACP session binding is the readiness boundary. A returned promise
      // alone is not evidence that the harness spawned successfully.
      await new Promise((resolve, reject) => {
        let started = false;
        Promise.resolve().then(() => turns.run({
          invocation: { agentId: identity.id, harness, cwd: binding.worktree },
          message: identityText + (parent
            ? `You were started by ${parent}, another agent soul, as part of its team. Join agent-comms as usual, read your inbox, and handle incoming work; your parent will brief you there.`
            : 'You were launched by a principal. Join agent-comms as usual, read your inbox, and handle incoming work.'),
          attachments: [],
          appendEvent: (type, data) => {
            if (type === HARNESS_SESSION_EVENT) { started = true; resolve(); }
            return { type, data };
          },
          addArtifact: () => { throw new Error('a launch turn has no artifact store'); },
          requestApproval: async () => ({ decision: 'deny' }),
        }, executor, { turnTimeoutMs })).then(() => { if (!started) reject(new Error('harness ended before session creation')); }, reject);
      });
      Object.assign(row, { status: 'launched', agentId: identity.id });
      try { await onLaunched(identity.id); } catch { /* the soul runs; only later wakes are affected */ }
    } catch (error) {
      Object.assign(row, { status: 'failed', agentId: null, detail: error.message });
      if (spawned) { try { await discard(spawned, rollback); } catch { /* the failure is already reported */ } }
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
