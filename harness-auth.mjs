// Harness sign-in for a soul (ADR-0276): an embedded host asks whether the
// harness a soul runs on is signed in, and starts its own sign-in, without
// a terminal. The harness's CLI comes from the soul's home when it was
// installed there, else from PATH. Credentials stay in the harness's own
// store; this module only reports `loggedIn` and the evidence behind it:
// `status` is signed-in, signed-out or unknown, with a `reason` when unknown.
//
// usage: agent-bot harness auth status|login HARNESS --soul AGENT_ID
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { isAgentId } from './agent-identity.mjs';
import { ACP_SPAWN_REGISTRY, harnessProcessEnv, resolveSpawn, whichOnPath } from './acp-registry.mjs';
import { populationFile, recordHarnessAuth } from './agent-population.mjs';
import { soulToolHomeEnv } from './soul-env-migrate.mjs';
import { soulHomePath } from './soul-home.mjs';
import { soulRuntimeEnv } from './soul-runtimes.mjs';
import { composeTurnEnv } from './turn-env.mjs';

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

// The probe and login run the harness as its turn would (#536): the
// turn's env with the row's strip and set applied, the Node first on that
// PATH (a soul's declared runtime before the host's), and the host's Node
// only as a last PATH entry for a bare launchd PATH.
export async function harnessAuth(action, harness, { home, env = process.env, node = null,
  registry = ACP_SPAWN_REGISTRY, runImpl = run } = {}) {
  if (!['status', 'login'].includes(action)) throw new Error('usage: agent-bot harness auth status|login HARNESS --soul AGENT_ID');
  const row = resolveSpawn(registry, harness);
  const runtime = node ?? whichOnPath('node', env) ?? process.execPath;
  const { command, args } = authCommand(row, home, { node: runtime });
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const fallback = path.dirname(process.execPath);
  const childEnv = harnessProcessEnv(row, { ...env, PATH: (dirs.includes(fallback) ? dirs : [...dirs, fallback]).join(path.delimiter) });
  const options = { cwd: home ?? undefined, env: childEnv };
  if (action === 'login') {
    try { await runImpl(command, [...args, ...row.signIn.login], { ...options, timeout: LOGIN_TIMEOUT_MS }); }
    catch (error) { throw new Error(`${harness} sign-in did not finish: ${String(error.message ?? error).split('\n')[0]}`); }
  }
  let output;
  let failure = null;
  try { output = (await runImpl(command, [...args, ...row.signIn.status], { ...options, timeout: 30_000 })).stdout; }
  catch (error) { failure = error; output = error.stdout ?? ''; }
  return { harness, ...signInEvidence(row.signIn, output, failure) };
}

const unknown = (reason) => ({ loggedIn: false, status: 'unknown', reason });
const verdict = (signedIn) => ({ loggedIn: signedIn, status: signedIn ? 'signed-in' : 'signed-out' });

// What a status probe proves (#536). `signed-out` needs positive evidence
// from the harness; a CLI that is missing, timed out, was interrupted, or
// printed something this reader does not recognise is `unknown`, never
// signed in. `loggedIn` stays the boolean older callers read, so it is false
// for both. `signIn` is the registry row's reader (`read`, `signedOut`).
export function signInEvidence(signIn, output, failure = null) {
  const { read, signedOut = null } = signIn;
  if (failure?.code === 'ENOENT') return unknown('status-command-missing');
  // execFile marks the child it killed at the timeout; any other signal is
  // an interruption, not a timeout.
  if (failure?.killed) return unknown('status-timeout');
  if (failure?.signal) return unknown('status-interrupted');
  if (read === 'exit-code') {
    if (failure === null) return verdict(true);
    // A non-zero exit is signed out only with the harness's own words for
    // it: Codex exits 1 both for "Not logged in" and for an unreadable
    // auth.json, and 2 for a usage error.
    const text = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
    return Number.isInteger(failure.code) && signedOut?.test(text) ? verdict(false) : unknown('status-failed');
  }
  if (read === 'json') {
    // Claude prints its JSON on a non-zero exit too.
    try {
      const value = JSON.parse(String(output));
      if (typeof value?.loggedIn === 'boolean') return verdict(value.loggedIn);
    } catch { /* fall through */ }
    return unknown('status-unreadable');
  }
  if (failure) return unknown('status-failed');
  // OpenCode decorates its provider count with terminal colours.
  const plain = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (read.loggedIn.test(plain)) return verdict(true);
  if (read.signedOut?.test(plain)) return verdict(false);
  return unknown('status-unreadable');
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
export function harnessAuthNotice(harness, status, agentId = null) {
  const name = HARNESS_NAMES[harness] ?? 'harness';
  const message = `I couldn't answer this: my ${name} sign-in ${status === 'expired' ? 'has expired' : 'is missing'}. My owner needs to sign me in again before I can work on it.`;
  if (!isAgentId(agentId) || !ACP_SPAWN_REGISTRY[harness]?.signIn) return message;
  return `${message} They can sign in with \`agent-bot harness auth login ${harness} --soul ${agentId}\`.`;
}

function clearRecorded(agentId, harness) {
  try {
    const file = populationFile();
    recordHarnessAuth(agentId, null, { file, only: harness });
  } catch { /* no census row to clear */ }
}

// The environment `harness auth --soul` runs with: the soul's turn
// environment (composeTurnEnv) without its provider secret, so status and
// login read and write the store the soul launches with. A soul whose
// harness store is routed into its tool home signs in there, not to the
// host's store (#536, #583). The provider secret stays with the daemon: a
// status here does not count an OpenCode provider variable.
export function soulAuthEnv(agentId, harness, { env = process.env, runtimeEnvFor = null, toolHomeEnvFor = null } = {}) {
  return composeTurnEnv({ agentId, harness, baseEnv: env, runtimeEnvFor, toolHomeEnvFor }).turnEnv;
}

async function main(argv) {
  const [sub, action, harness, flag, agentId] = argv;
  if (sub !== 'auth' || !harness || flag !== '--soul' || !agentId) {
    throw new Error('usage: agent-bot harness auth status|login HARNESS --soul AGENT_ID');
  }
  const home = soulHomePath(agentId);
  const env = soulAuthEnv(agentId, harness, {
    runtimeEnvFor: ({ agentId: id, harness: name, env: turnEnv }) => soulRuntimeEnv(id, { env: turnEnv, harness: name }),
    toolHomeEnvFor: ({ agentId: id, harness: name }) => soulToolHomeEnv(id, { harness: name }),
  });
  const result = await harnessAuth(action, harness, { home: existsSync(home) ? home : null, env });
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
