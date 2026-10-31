// Shared server-mode status and doctor readiness for host surfaces (#1295):
// the MCP server_status/doctor tools and the web client's machine view read
// the same shapes. Doctor runs as a subprocess with --no-verify-apps so a
// read surface can never mint an installation token or write the advisory
// doctor cache.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { loadDevice, serverUrl } from './identity-host.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function serverStatusReport({ env = process.env, home = homedir(), cwd = null } = {}) {
  const config = (() => { try { return loadConfig({ home, env }); } catch { return {}; } })();
  const base = serverUrl({ env, config });
  const device = loadDevice({ env, home });
  // The repo a checkout would mint for is only knowable beside a checkout;
  // surfaces with no worktree (the web client) leave it null.
  let repo = null;
  if (cwd) {
    try {
      const remote = git(cwd, 'remote', 'get-url', 'origin');
      const m = remote.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
      if (m) repo = `${m[1]}/${m[2]}`;
    } catch { repo = null; }
  }
  return {
    server_mode: Boolean(base),
    base: base ?? null,
    enrolled: Boolean(device),
    device_id: device?.device_id ?? null,
    device_name: device?.device_name ?? null,
    approved_harnesses: device?.harnesses ?? [],
    repo,
  };
}

const DOCTOR_ARGS = ['--json', '--no-verify-apps'];
const DOCTOR_FILE = (root) => join(root, 'doctor.mjs');

// doctor exits non-zero when the machine is not ready but still prints the
// JSON report — stdout of the failed spawn is still the report.
function doctorUnavailable(error) {
  return Object.assign(new Error(`doctor failed: ${error?.message ?? 'unknown'} [doctor-unavailable]`), { code: 'doctor-unavailable' });
}

function parseDoctorReport(out) {
  if (typeof out !== 'string') throw doctorUnavailable(new Error('no report'));
  let report;
  try {
    report = JSON.parse(out);
  } catch (error) {
    throw Object.assign(new Error(`doctor failed: unreadable report (${error?.message ?? 'unknown'}) [doctor-unavailable]`), { code: 'doctor-unavailable' });
  }
  return {
    ready: report.ready ?? null,
    first_actionable_failure: report.first_actionable_failure ?? null,
    machine: report.machine ?? null,
    worktree: report.worktree ?? null,
  };
}

// Sync variant for the MCP server process — blocking there stalls no one
// but that agent's own stdio loop.
export function doctorReport({ env = process.env, cwd = process.cwd(), root = dirname(fileURLToPath(import.meta.url)), execFile = execFileSync, timeoutMs = 30000 } = {}) {
  let out;
  try {
    out = execFile(process.execPath, [DOCTOR_FILE(root), ...DOCTOR_ARGS],
      { env, cwd, encoding: 'utf8', timeout: timeoutMs });
  } catch (error) {
    if (typeof error?.stdout !== 'string') throw doctorUnavailable(error);
    out = error.stdout;
  }
  return parseDoctorReport(out);
}

// Async variant for surfaces inside the daemon's HTTP loop (#1297): a sync
// spawn would freeze every in-flight credential and binding request.
export async function doctorReportAsync({ env = process.env, cwd = process.cwd(), root = dirname(fileURLToPath(import.meta.url)), execFileAsync = promisify(execFile), timeoutMs = 30000 } = {}) {
  let out;
  try {
    const result = await execFileAsync(process.execPath, [DOCTOR_FILE(root), ...DOCTOR_ARGS],
      { env, cwd, encoding: 'utf8', timeout: timeoutMs });
    out = result.stdout;
  } catch (error) {
    if (typeof error?.stdout !== 'string') throw doctorUnavailable(error);
    out = error.stdout;
  }
  return parseDoctorReport(out);
}
