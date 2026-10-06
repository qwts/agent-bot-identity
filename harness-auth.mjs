// Harness sign-in for a soul (ADR-0276): an embedded host asks whether the
// harness a soul runs on is signed in, and starts its own sign-in, without
// a terminal. The harness's CLI comes from the soul's home when it was
// installed there, else from PATH. Credentials stay in the harness's own
// store; this module only reports `loggedIn`.
//
// usage: agent-bot harness auth status|login HARNESS --soul AGENT_ID
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ACP_SPAWN_REGISTRY, resolveSpawn } from './acp-registry.mjs';
import { populationFile, recordHarnessAuth } from './agent-population.mjs';
import { soulHomePath } from './soul-home.mjs';

const run = promisify(execFile);
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** How to run a harness's auth CLI in a soul home: its installed copy, else PATH. */
export function authCommand(row, home, { node = process.execPath } = {}) {
  const auth = row.signIn;
  if (!auth) throw new Error(`harness '${row.harness}' has no sign-in support`);
  const script = home && auth.package ? path.join(home, 'node_modules', ...auth.package.split('/'), auth.script) : null;
  if (script && existsSync(script)) return { command: node, args: [script] };
  const bin = home && !auth.package ? path.join(home, 'node_modules', '.bin', auth.command) : null;
  return { command: bin && existsSync(bin) ? bin : auth.command, args: [] };
}

export async function harnessAuth(action, harness, { home, env = process.env, node = process.execPath,
  registry = ACP_SPAWN_REGISTRY, runImpl = run } = {}) {
  if (!['status', 'login'].includes(action)) throw new Error('usage: agent-bot harness auth status|login HARNESS --soul AGENT_ID');
  const row = resolveSpawn(registry, harness);
  const { command, args } = authCommand(row, home, { node });
  const childEnv = { ...env, PATH: [path.dirname(node), env.PATH].filter(Boolean).join(path.delimiter) };
  for (const name of row.stripEnv) delete childEnv[name];
  const options = { cwd: home ?? undefined, env: childEnv };
  if (action === 'login') {
    try { await runImpl(command, [...args, ...row.signIn.login], { ...options, timeout: LOGIN_TIMEOUT_MS }); }
    catch (error) { throw new Error(`${harness} sign-in did not finish: ${String(error.message ?? error).split('\n')[0]}`); }
  }
  let output;
  let succeeded = false;
  try {
    output = (await runImpl(command, [...args, ...row.signIn.status], { ...options, timeout: 30_000 })).stdout;
    succeeded = true;
  }
  catch (error) { output = error.stdout ?? ''; }
  let loggedIn = false;
  const read = row.signIn.read;
  if (read === 'exit-code') loggedIn = succeeded;
  else if (read === 'json') {
    try { loggedIn = JSON.parse(String(output)).loggedIn === true; } catch { /* unreadable status is signed out */ }
  } else if (succeeded) {
    // OpenCode decorates its provider count with terminal colours.
    const plain = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    loggedIn = read.loggedIn.test(plain);
  }
  return { harness, loggedIn };
}

// A daemon turn that failed because its harness is signed out (#84): Claude's
// "Not logged in · Please run /login" or an ACP "Authentication required",
// an expired OAuth access token, or a Codex refresh token that can no longer
// be used. `expired` when the harness said so, else `signed-out`; null for
// any other failure. Only the error text is read, never stored.
const EXPIRED = /(?:access|oauth|auth)[ _-]?token (?:has |is )?expired|token (?:has )?expired|refresh[ _-]?token\b[^\n]{0,80}\b(?:expired|invalid|revoked|already (?:been )?used|reused)|could not be refreshed|session (?:has )?expired|sign-?in (?:has )?expired/i;
const SIGNED_OUT = /not logged in|please run \/login|authentication required|auth_required|not authenticated|unauthenticated|invalid api key|(?:claude|codex|opencode|grok)(?: auth)? login\b/i;

export function harnessAuthFailure(error) {
  if (HARNESS_AUTH.has(error?.harnessAuth)) return error.harnessAuth;
  const text = String(error?.message ?? error ?? '');
  if (EXPIRED.test(text)) return 'expired';
  if (SIGNED_OUT.test(text)) return 'signed-out';
  return null;
}

const HARNESS_AUTH = new Set(['signed-out', 'expired']);
const HARNESS_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', grok: 'Grok' };

// The short reply a sender gets instead of silence (like #408's policy
// notice): which sign-in, never the harness's own error text.
export function harnessAuthNotice(harness, status) {
  const name = HARNESS_NAMES[harness] ?? 'harness';
  return `I couldn't answer this: my ${name} sign-in ${status === 'expired' ? 'has expired' : 'is missing'}. My owner needs to sign me in again before I can work on it.`;
}

function clearRecorded(agentId, harness) {
  try {
    const file = populationFile();
    recordHarnessAuth(agentId, null, { file, only: harness });
  } catch { /* no census row to clear */ }
}

async function main(argv) {
  const [sub, action, harness, flag, agentId] = argv;
  if (sub !== 'auth' || !harness || flag !== '--soul' || !agentId) {
    throw new Error('usage: agent-bot harness auth status|login HARNESS --soul AGENT_ID');
  }
  const home = soulHomePath(agentId);
  const result = await harnessAuth(action, harness, { home: existsSync(home) ? home : null });
  // A signed-in harness clears the failure a turn recorded for it (#84).
  if (result.loggedIn) clearRecorded(agentId, harness);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ error: { code: 'harness-auth-failed', message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
