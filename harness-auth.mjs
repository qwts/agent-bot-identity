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
import { soulHomePath } from './soul-home.mjs';

const run = promisify(execFile);
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** How to run a harness's auth CLI in a soul home: its installed copy, else PATH. */
export function authCommand(row, home, { node = process.execPath } = {}) {
  const auth = row.signIn;
  if (!auth) throw new Error(`harness '${row.harness}' has no sign-in support`);
  const script = home ? path.join(home, 'node_modules', ...auth.package.split('/'), auth.script) : null;
  return script && existsSync(script) ? { command: node, args: [script] } : { command: auth.command, args: [] };
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
  try { output = (await runImpl(command, [...args, ...row.signIn.status], { ...options, timeout: 30_000 })).stdout; }
  catch (error) { output = error.stdout ?? ''; }
  let loggedIn = false;
  try { loggedIn = JSON.parse(String(output)).loggedIn === true; } catch { /* unreadable status is signed out */ }
  return { harness, loggedIn };
}

async function main(argv) {
  const [sub, action, harness, flag, agentId] = argv;
  if (sub !== 'auth' || !harness || flag !== '--soul' || !agentId) {
    throw new Error('usage: agent-bot harness auth status|login HARNESS --soul AGENT_ID');
  }
  const home = soulHomePath(agentId);
  const result = await harnessAuth(action, harness, { home: existsSync(home) ? home : null });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ error: { code: 'harness-auth-failed', message: error.message } })}\n`);
    process.exitCode = 1;
  });
}
