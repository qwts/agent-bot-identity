// Principal launches arrive on the authenticated account watch. The journal
// stores only correlation and outcomes, never principal data or credentials.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { HARNESS_SESSION_EVENT } from './executor-contract.mjs';
import { HARNESS_KEY_PATTERN } from './acp-registry.mjs';

export function createLaunchHandler({ file, identities, spawnPackage, lookupBinding, executorFor, turnTimeoutMs = 30 * 60_000 }) {
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
    try {
      if (event.account !== account) throw new Error('launch account does not match paired daemon');
      if (typeof event.harness !== 'string' || !HARNESS_KEY_PATTERN.test(event.harness)) throw new Error('invalid launch harness');
      const targets = [event.soul, event.package].filter((value) => value !== undefined);
      if (targets.length !== 1 || typeof targets[0] !== 'string' || !targets[0]) {
        throw new Error('launch requires exactly one soul or package');
      }
      if (event.name !== undefined && (typeof event.name !== 'string' || !event.name || event.name.length > 100 || /[\u0000-\u001f\u007f]/.test(event.name))) throw new Error('invalid launch name');
      const identity = event.soul ? await identities(event.soul) : await spawnPackage(event);
      if (!identity?.github?.appSlug) throw new Error('launching a soul without a GitHub App identity is unsupported (#297)');
      if (!executorFor) throw new Error('daemon ACP executor is disabled');
      const binding = await lookupBinding(identity.id);
      if (!binding?.worktree || !binding?.file) throw new Error('soul binding is unavailable');
      const executor = executorFor({ agentId: identity.id, harness: event.harness, cwd: binding.worktree,
        env: { AGENT_BOT_BINDING: binding.file, AGENT_BOT_ID: identity.id, QWTS_AGENT_ID: identity.id } });
      // An ACP session binding is the readiness boundary. A returned promise
      // alone is not evidence that the harness spawned successfully.
      await new Promise((resolve, reject) => {
        let started = false;
        Promise.resolve().then(() => executor({
          invocation: { agentId: identity.id, harness: event.harness, cwd: binding.worktree },
          message: { text: 'You were launched by a principal. Join agent-comms as usual, read your inbox, and handle incoming work.' },
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
    } catch (error) {
      Object.assign(row, { status: 'failed', agentId: null, detail: error.message });
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
