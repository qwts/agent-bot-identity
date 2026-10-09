// `agent-bot soul skill dream` (#603): a client of the daemon's owner-gated
// dream routes. It never schedules or executes maintenance itself; the daemon
// is the sole scheduler and verifies the owner for every control.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { validateAgentId } from '../agent-identity.mjs';
import { daemonClient } from '../daemon-client.mjs';
import { soulMarkers } from '../owner-gate.mjs';
import { parseDreamSchedule } from '../skill-dream-scheduler.mjs';

export const DREAM_USAGE = `usage: agent-bot soul skill dream --soul ID|NAME --schedule PT<N>H [--json] [--principal-stdin]
       agent-bot soul skill dream --soul ID|NAME --run-now|--pause|--unschedule [--json] [--principal-stdin]
       agent-bot soul skill dream --soul ID|NAME --cancel RUN_ID [--json] [--principal-stdin]
       agent-bot soul skill dream --soul ID|NAME --status [--json]
       agent-bot soul skill dream --soul ID|NAME --history [--after-revision N] [--limit N] [--json]

Dream runs bounded maintenance turns for one soul from the running daemon. The
schedule is elapsed time, PT1H to PT720H, first due one interval after
registration. Controls need the owner (presence or --principal-stdin); a soul
cannot authorize them. Nothing is scheduled unless you register it.
Execution status reports whether a turn ran, not what it maintained:
maintenance coverage stays unverified, and an input receipt records only what
was prepared for the turn.
`;

const ACTIONS = { '--schedule': 'register', '--run-now': 'run-now', '--pause': 'pause', '--unschedule': 'unschedule',
  '--cancel': 'cancel', '--status': 'status', '--history': 'history' };
const VALUED = new Set(['--soul', '--schedule', '--cancel', '--after-revision', '--limit']);
const SWITCHES = new Set(['--run-now', '--pause', '--unschedule', '--status', '--history', '--json', '--principal-stdin']);
const RUN_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const COUNT = /^(0|[1-9]\d{0,8})$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function parseDreamArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(flags, arg) || !VALUED.has(arg) && !SWITCHES.has(arg)) return null;
    if (SWITCHES.has(arg)) { flags[arg] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) return null;
    flags[arg] = value;
  }
  const actions = Object.keys(ACTIONS).filter(flag => Object.hasOwn(flags, flag));
  if (!flags['--soul'] || actions.length !== 1) return null;
  const action = ACTIONS[actions[0]], control = !['status', 'history'].includes(action);
  if (!control && flags['--principal-stdin']) return null;
  if (action !== 'history' && (flags['--after-revision'] !== undefined || flags['--limit'] !== undefined)) return null;
  if (action === 'cancel' && !RUN_ID.test(flags['--cancel'])) return null;
  if (action === 'register') { try { parseDreamSchedule(flags['--schedule']); } catch { return null; } }
  if (flags['--after-revision'] !== undefined && !COUNT.test(flags['--after-revision'])) return null;
  if (flags['--limit'] !== undefined && (!COUNT.test(flags['--limit']) || flags['--limit'] === '0')) return null;
  return { action, control, soul: flags['--soul'], schedule: flags['--schedule'] ?? null, runId: flags['--cancel'] ?? null,
    afterRevision: flags['--after-revision'] === undefined ? undefined : Number(flags['--after-revision']),
    limit: flags['--limit'] === undefined ? undefined : Number(flags['--limit']),
    json: Boolean(flags['--json']), presented: Boolean(flags['--principal-stdin']) };
}

// Only this soul's rows: other souls' registrations, runs and receipts are
// not disclosed through a per-soul command.
function soulStatus(status, agentId) {
  const flights = (status.flights ?? []).filter(run => run.agentId === agentId);
  const registration = (status.registrations ?? []).find(row => row.agentId === agentId) ?? null;
  const runs = new Set([...flights.map(run => run.runId), ...(registration?.lastRun ? [registration.lastRun.runId] : [])]);
  return { schemaVersion: 1, agentId, available: status.available === true, executorConfigured: status.executorConfigured === true,
    fault: status.fault ?? null, maintenanceCoverage: 'unverified', registration, flights,
    inputReceipts: (status.inputReceipts ?? []).filter(receipt => runs.has(receipt.runId)) };
}
const eventSoul = event => event?.registration?.agentId ?? event?.run?.agentId ?? null;

export async function soulDreamCommand(argv, {
  readStdin = () => readFileSync(0, 'utf8'),
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  client = daemonClient({ env, home, cwd }),
  markers = () => soulMarkers({ env, cwd, detect: false }),
} = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { stdout.write(DREAM_USAGE); return 0; }
  const parsed = parseDreamArgs(argv);
  if (!parsed) { stderr.write(DREAM_USAGE); return 2; }
  try {
    let principal = null;
    if (parsed.presented) {
      try { principal = JSON.parse(readStdin()); }
      catch { fail('dream-principal-invalid', '--principal-stdin needs the principal credential as JSON on stdin'); }
    }
    const { populationFile, showSoul, showSoulByName } = await import('../agent-population.mjs');
    const file = populationFile({ env, home });
    let soul;
    try { soul = showSoul(validateAgentId(parsed.soul), { file }); }
    catch (error) {
      if (/^agent_/.test(parsed.soul)) throw error;
      soul = showSoulByName(parsed.soul, { file });
    }
    if (parsed.control) {
      // The daemon cannot inspect the calling process's soul markers.
      const found = markers();
      if (found.length) fail('owner-credential-required', `dream controls are owner only; this caller has a soul's ${found.join(', ')}`);
    }
    // No in-process fallback: a second scheduler would bypass the daemon's
    // lease, overlap and recovery rules.
    if (!await client.available()) fail('dream-daemon-unavailable', 'the agent-bot daemon is not running; dream maintenance runs only in the daemon');
    let result, ok = true;
    if (parsed.action === 'status') result = soulStatus(await client.dreamStatus(), soul.id);
    else if (parsed.action === 'history') {
      const page = await client.dreamHistory({ afterRevision: parsed.afterRevision, limit: parsed.limit });
      const records = (page.records ?? []).map(record => ({ revision: record.revision, events: (record.events ?? []).filter(event => eventSoul(event) === soul.id) }))
        .filter(record => record.events.length);
      result = { schemaVersion: 1, agentId: soul.id, maintenanceCoverage: 'unverified', records, nextRevision: page.nextRevision, remaining: page.remaining };
    } else {
      let body = { agentId: soul.id };
      if (parsed.action === 'register') body.schedule = parsed.schedule;
      if (parsed.action === 'cancel') {
        // The route names only the run; confirm it is this soul's first.
        const run = soulStatus(await client.dreamStatus(), soul.id).flights.find(item => item.runId === parsed.runId);
        if (!run) fail('dream-run-not-found', 'no unsettled dream run with that ID belongs to this soul');
        body = { runId: parsed.runId };
      }
      const response = await client.dreamControl(parsed.action, body, { principal });
      result = { schemaVersion: 1, agentId: soul.id, action: parsed.action, maintenanceCoverage: 'unverified', result: response.result ?? null };
      if (parsed.action === 'run-now') ok = response.result?.status === 'started';
      if (parsed.action === 'cancel') ok = response.result?.requested === true;
    }
    stdout.write(`${JSON.stringify(result, null, parsed.json ? 0 : 2)}\n`);
    return ok ? 0 : 1;
  } catch (error) {
    const failure = { code: typeof error.code === 'string' ? error.code : 'dream-failed', message: error.message };
    if (parsed.json) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill dream: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
