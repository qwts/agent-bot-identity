// Principal launches arrive on the authenticated account watch. The journal
// stores only correlation and outcomes, never principal data or credentials.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { HARNESS_SESSION_EVENT } from './executor-contract.mjs';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';
import { soulCommsSetting } from './soul-package.mjs';

// A launch's comms setting: the soul's own soul.json (a spawned instance
// carries its template's), else the launched package's, else on.
export function launchCommsSetting({ soulDir = null, packagePath = null } = {}) {
  return (soulDir && soulCommsSetting(soulDir)) ?? (packagePath && soulCommsSetting(packagePath)) ?? true;
}

/** Longest display name the broker accepts on a launch request. */
export const LAUNCH_NAME_MAX = 128;

// `provisionHome` binds a soul that has no live binding (#297); `discard`
// retires a soul this request spawned when its first start fails, so a
// failed package launch leaves no active identity behind. `joinSoul` joins
// the soul to agent-comms as itself before its first turn: the broker takes
// `launched` only from a joined soul, and a harness not yet signed in (a
// fresh install) cannot run the turn that would join it. `recordLaunch`
// records, before the first turn, that the daemon manages this soul and the
// comms setting its soul.json has now; the setting holds until the next
// launch, so a running soul's comms cannot be switched off under it. A
// launch that names `comms` writes it to the soul's soul.json first.
export function createLaunchHandler({ file, identities, spawnPackage, lookupBinding, provisionHome, discard = () => {}, onLaunched = () => {}, defaultHarness = () => null,
  joinSoul = null, recordLaunch = null, executorFor, turnTimeoutMs = 30 * 60_000 }) {
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
  const handle = async (event, { report, account }) => {
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
    try {
      if (event.account !== account) throw new Error('launch account does not match paired daemon');
      const targets = [event.soul, event.package].filter((value) => value !== undefined);
      if (targets.length !== 1 || typeof targets[0] !== 'string' || !targets[0]) {
        throw new Error('launch requires exactly one soul or package');
      }
      // ADR-0276 order: the launch's own harness, else the soul's default,
      // else a registry harness found on PATH.
      const harness = event.harness ?? await defaultHarness(event.soul ? { soul: event.soul } : { package: event.package });
      if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) {
        throw new Error(event.harness === undefined ? 'no harness for this launch: name one, or install a harness' : 'invalid launch harness');
      }
      // Same bound as agent-comms' broker launch contract (lib/broker/launch.mjs).
      if (event.name !== undefined && (typeof event.name !== 'string' || !event.name.trim() || event.name.length > LAUNCH_NAME_MAX || /[\u0000-\u001f\u007f]/.test(event.name))) throw new Error('invalid launch name');
      // Optional, chosen before start (#381): the soul's comms setting for
      // this and later launches. Absent keeps what its soul.json says.
      if (event.comms !== undefined && typeof event.comms !== 'boolean') throw new Error('invalid launch comms');
      // Every check that can fail without starting runs before a package spawn mints.
      if (!executorFor) throw new Error('daemon ACP executor is disabled');
      const identity = event.soul ? await identities(event.soul) : await spawnPackage({ ...event, harness });
      if (!event.soul) spawned = identity?.id ?? null;
      const binding = await lookupBinding(identity.id)
        ?? await provisionHome({ agentId: identity.id, harness, packagePath: event.package ?? null });
      if (!binding?.worktree || !binding?.file) throw new Error('soul binding is unavailable');
      if (joinSoul) await joinSoul({ agentId: identity.id, harness, name: event.name ?? null, binding });
      if (recordLaunch) await recordLaunch({ agentId: identity.id, package: event.package ?? null, binding,
        ...(event.comms === undefined ? {} : { comms: event.comms, principal: event.principal ?? null }) });
      const executor = executorFor({ agentId: identity.id, harness, cwd: binding.worktree,
        env: { AGENT_BOT_BINDING: binding.file, AGENT_BOT_ID: identity.id, QWTS_AGENT_ID: identity.id } });
      // An ACP session binding is the readiness boundary. A returned promise
      // alone is not evidence that the harness spawned successfully.
      await new Promise((resolve, reject) => {
        let started = false;
        Promise.resolve().then(() => executor({
          invocation: { agentId: identity.id, harness, cwd: binding.worktree },
          message: 'You were launched by a principal. Join agent-comms as usual, read your inbox, and handle incoming work.',
          attachments: [], signal: AbortSignal.timeout(turnTimeoutMs),
          appendEvent: (type, data) => {
            if (type === HARNESS_SESSION_EVENT) { started = true; resolve(); }
            return { type, data };
          },
          addArtifact: () => { throw new Error('a launch turn has no artifact store'); },
          requestApproval: async () => ({ decision: 'deny' }),
        })).then(() => { if (!started) reject(new Error('harness ended before session creation')); }, reject);
      });
      Object.assign(row, { status: 'launched', agentId: identity.id });
      try { await onLaunched(identity.id); } catch { /* the soul runs; only later wakes are affected */ }
    } catch (error) {
      Object.assign(row, { status: 'failed', agentId: null, detail: error.message });
      if (spawned) { try { await discard(spawned); } catch { /* the failure is already reported */ } }
    }
    save(); // Persist outcome before network I/O; retry only the report.
    await reportRow(row, report);
  };
  handle.recover = async ({ report }) => {
    for (const row of requests.values()) {
      if (row.status !== 'pending' && !row.reported) await reportRow(row, report);
    }
  };
  return handle;
}
