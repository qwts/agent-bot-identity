#!/usr/bin/env node

// agent-bot's side of agent-bot-keyd (#397), the signed native MCP server
// GeniusBar ships to keep souls' GitHub App keys.
//
// keyd holds keys and signs; agent-bot keeps the policy. A soul's key
// lives in a Keychain item keyd created, so the item's access list trusts
// keyd's code signature and nothing else: not `security`, not `node`, not a
// soul. keyd mints only on a grant this daemon signs with its account
// Ed25519 key (the vouch key), which the owner pinned in keyd on the first
// import:
//
//   v1.<base64url(payload)>.<base64url(Ed25519 signature of that segment)>
//   payload: { v: 1, aud: 'agent-bot-keyd', agentId, app, tool, iat, exp,
//              nonce, apiBase, installationId, owner, host }
//
// Grants live 60 seconds and keyd spends each nonce once.
//
//   - A soul's harness runs `agent-bot-keyd mcp`, which asks POST
//     /v0/keyd/grant with the soul's binding proof. The daemon checks the
//     binding, the add-on gate and the soul's App, then signs.
//   - The daemon's own mints (/v0/credential, and so the git credential
//     helper and mint-token of a keyd soul) sign a grant in-process and
//     call keyd's `credential` tool.
//   - Owner operations (import, remove, pin) go to keyd's owner socket.
//     keyd asks the owner itself (Touch ID or the login password) before
//     changing anything.
//
//   agent-bot keyd install --bin PATH [--json]   supervise keyd under launchd
//   agent-bot keyd uninstall [--json]            unload it (its keys stay)
//   agent-bot keyd status [--json]               whether it answers, and the pin
//
// Without keyd (Homebrew, Linux) keys stay in the #395 stores.

import { execFileSync } from 'node:child_process';
import { randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { renderLaunchdPlist, supervisorSkipLoad } from './daemon-supervisor.mjs';
import { loadOrCreateVouchKey, vouchStateDir } from './vouch.mjs';

export const KEYD_SERVER_NAME = 'agent-bot-keyd';
export const KEYD_TOOL_NAMES = Object.freeze(['credential', 'git_credential']);
export const KEYD_AUDIENCE = 'agent-bot-keyd';
export const KEYD_GRANT_META = 'agent-bot/grant';
export const KEYD_LABEL = 'dev.qwts.agent-bot.keyd';
export const KEYD_LABEL_VARIABLE = 'AGENT_BOT_KEYD_SERVICE_LABEL';
const GRANT_TTL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 30_000;
// Owner operations wait for a person at the Mac.
const OWNER_TIMEOUT_MS = 150_000;

export function keydPaths({ env = process.env, home = homedir() } = {}) {
  const dir = path.join(vouchStateDir({ env, home }), 'keyd');
  return {
    dir,
    socket: path.join(dir, 'keyd.sock'),
    ownerSocket: path.join(dir, 'owner.sock'),
    record: path.join(dir, 'keyd.json'),
  };
}

// One JSON-RPC request on a keyd socket; resolves the result, rejects with
// keyd's (secret-free) error message.
export function keydRequest(socketPath, method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const fail = (error) => { socket.destroy(); reject(error); };
    socket.setTimeout(timeoutMs, () => fail(Object.assign(new Error('agent-bot-keyd did not answer in time'), { code: 'keyd-timeout' })));
    socket.on('error', (error) => fail(Object.assign(new Error('agent-bot-keyd is not running'), { code: 'keyd-unavailable', cause: error.code })));
    socket.on('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.end();
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); } catch { reject(new Error('agent-bot-keyd answered malformed JSON')); return; }
      if (message.error) reject(Object.assign(new Error(String(message.error.message ?? 'agent-bot-keyd refused')), { code: 'keyd-refused' }));
      else resolve(message.result);
    });
  });
}

function vouchKey({ env, home }) {
  return loadOrCreateVouchKey(vouchStateDir({ env, home }));
}

// The daemon's grant key as keyd pins it: the raw Ed25519 public key, base64.
export function daemonGrantPublicKey({ env = process.env, home = homedir(), key = vouchKey({ env, home }) } = {}) {
  const { x } = key.publicKey.export({ format: 'jwk' });
  return Buffer.from(x, 'base64url').toString('base64');
}

export function signKeydGrant({ agentId, app, tool, apiBase, installationId = null, owner = null, host = null }, privateKey, now = () => new Date()) {
  if (!KEYD_TOOL_NAMES.includes(tool)) throw new Error(`unknown keyd tool: ${tool}`);
  const iat = Math.floor(now().getTime() / 1000);
  const payload = {
    v: 1, aud: KEYD_AUDIENCE, agentId, app, tool, iat, exp: iat + GRANT_TTL_SECONDS,
    nonce: randomBytes(18).toString('base64url'), apiBase,
    installationId: installationId === null || installationId === undefined || installationId === '' ? null : Number(installationId),
    owner: owner ?? null, host: host ?? null,
  };
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `v1.${segment}.${sign(null, Buffer.from(segment), privateKey).toString('base64url')}`;
}

// What the daemon's config says about where to mint, for a grant.
export async function grantTarget({ env = process.env, config } = {}) {
  const { apiBase, githubHost, loadConfig } = await import('./config.mjs');
  const loaded = config ?? loadConfig({ env });
  return {
    apiBase: apiBase(loaded),
    host: githubHost(loaded),
    owner: loaded.owner ?? null,
    installationId: env.GH_APP_INSTALLATION_ID || null,
  };
}

// The daemon's own mint for a keyd soul: sign a grant, call `credential`.
export async function mintViaKeyd({ agentId, app, env = process.env, home = homedir(), config, now = () => new Date(), request = keydRequest } = {}) {
  const grant = signKeydGrant({ agentId, app, tool: 'credential', ...(await grantTarget({ env, config })) }, vouchKey({ env, home }).privateKey, now);
  const result = await request(keydPaths({ env, home }).socket, 'tools/call', { name: 'credential', arguments: {}, _meta: { [KEYD_GRANT_META]: grant } });
  if (result?.isError || !result?.structuredContent?.token) {
    const reason = result?.content?.[0]?.text ?? 'agent-bot-keyd gave no token';
    throw new Error(`agent-bot-keyd: ${reason}`);
  }
  const { token, expires_at: expiresAt, installation_id: installationId } = result.structuredContent;
  return { token, expires_at: expiresAt, installation_id: installationId };
}

// Outside the daemon (a soul's git credential helper, `mint-token`), a keyd
// soul's token comes from the daemon's /v0/credential on the caller's own
// binding, never from a key.
export async function mintThroughDaemon({ slug, env = process.env, cwd = process.cwd(), fetchImpl = fetch, now = () => new Date() } = {}) {
  const { readBinding } = await import('./agent-binding.mjs');
  const { PROOF_HEADER, signBindingProof } = await import('./binding-proof.mjs');
  const binding = readBinding({ env, cwd });
  if (!binding) throw new Error(`the ${slug} key is held by agent-bot-keyd; only a bound soul can get a token for it, through the daemon`);
  const target = new URL('/v0/credential', binding.daemon);
  const proof = signBindingProof({ secret: binding.secret, method: 'POST', path: target.pathname, authority: target.host, now: now().getTime() });
  const response = await fetchImpl(target.href, {
    method: 'POST', headers: { [PROOF_HEADER]: proof, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`the daemon refused a token: ${typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`}`);
  if (body.appSlug !== slug) throw new Error(`this soul's App is ${body.appSlug}, not ${slug}`);
  return { token: body.token, expires_at: body.expires_at, installation_id: null };
}

// The owner's import (migrate-credentials --to keyd): every key in one call,
// so keyd asks once. The daemon key goes along every time; keyd pins it on
// the first import and refuses a different one.
export async function importIntoKeyd(items, { env = process.env, home = homedir(), request = keydRequest } = {}) {
  return request(keydPaths({ env, home }).ownerSocket, 'owner/import', {
    items, daemonKey: daemonGrantPublicKey({ env, home }),
  }, { timeoutMs: OWNER_TIMEOUT_MS });
}

export function readKeydRecord({ env = process.env, home = homedir() } = {}) {
  try {
    const record = JSON.parse(readFileSync(keydPaths({ env, home }).record, 'utf8'));
    return typeof record?.bin === 'string' && path.isAbsolute(record.bin) ? record : null;
  } catch { return null; }
}

// The harness-side entry for an ACP session: keyd's own relay, which reads
// the soul's binding and never a key.
export function keydMcpServerEntry({ bin, binding = null, env = process.env } = {}) {
  const vars = [];
  if (binding) vars.push({ name: 'AGENT_BOT_BINDING', value: binding });
  for (const name of ['HOME', 'XDG_STATE_HOME']) {
    if (typeof env[name] === 'string' && env[name] !== '') vars.push({ name, value: env[name] });
  }
  return { name: KEYD_SERVER_NAME, command: bin, args: ['mcp'], env: vars };
}

export function keydPolicyRules() {
  return KEYD_TOOL_NAMES.map((tool) => ({ tool: `mcp__${KEYD_SERVER_NAME}__${tool}`, outcome: 'allow' }));
}

export function keydLabel(env = process.env) {
  const label = env[KEYD_LABEL_VARIABLE];
  if (label === undefined || label === '') return KEYD_LABEL;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(label)) throw new Error(`${KEYD_LABEL_VARIABLE} must use letters, digits, dots, underscores or hyphens`);
  return label;
}

function unitPath(label, home) {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

function launchctl(args, env) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
}

// Supervise keyd under launchd from `bin`, the copy a host ships. Rewritten
// and reloaded only when the unit changes, like `daemon install`.
export function installKeyd({ bin, env = process.env, home = homedir(), platform = process.platform, exec = launchctl } = {}) {
  if (platform !== 'darwin') throw new Error('agent-bot-keyd runs only on macOS');
  if (typeof bin !== 'string' || !path.isAbsolute(bin) || !existsSync(bin)) throw new Error('--bin must be the absolute path of an agent-bot-keyd binary');
  const label = keydLabel(env);
  const unit = unitPath(label, home);
  const state = vouchStateDir({ env, home });
  const body = renderLaunchdPlist({ programArguments: [bin, 'serve', '--state-dir', state], label });
  let previous = null;
  try { previous = readFileSync(unit, 'utf8'); } catch { /* first install */ }
  const paths = keydPaths({ env, home });
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.record, `${JSON.stringify({ bin, label })}\n`, { mode: 0o600 });
  const changed = previous !== body;
  if (changed) {
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, body, { mode: 0o644 });
    if (!supervisorSkipLoad(env)) {
      const domain = `gui/${process.getuid()}`;
      try { exec(['bootout', `${domain}/${label}`], env); } catch { /* not loaded yet */ }
      exec(['bootstrap', domain, unit], env);
    }
  }
  return { label, unitPath: unit, bin, changed, loaded: true };
}

export function uninstallKeyd({ env = process.env, home = homedir(), platform = process.platform, exec = launchctl } = {}) {
  if (platform !== 'darwin') return { unloaded: false, reason: 'unsupported-platform' };
  const label = keydLabel(env);
  const unit = unitPath(label, home);
  const present = existsSync(unit);
  if (present && !supervisorSkipLoad(env)) {
    try { exec(['bootout', `gui/${process.getuid()}/${label}`], env); } catch { /* already stopped */ }
  }
  rmSync(unit, { force: true });
  rmSync(keydPaths({ env, home }).record, { force: true });
  return { unloaded: present, label, unitPath: unit };
}

export async function keydStatus({ env = process.env, home = homedir(), request = keydRequest } = {}) {
  const record = readKeydRecord({ env, home });
  try {
    const status = await request(keydPaths({ env, home }).ownerSocket, 'owner/status', {}, { timeoutMs: 5_000 });
    return { running: true, bin: record?.bin ?? null, pinned: Boolean(status?.pinned), version: status?.version ?? null };
  } catch {
    return { running: false, bin: record?.bin ?? null, pinned: null, version: null };
  }
}

const USAGE = 'usage: agent-bot keyd install --bin PATH [--json] | uninstall [--json] | status [--json]';

export async function keydCommand(argv, { env = process.env, home = homedir(), write = (text) => process.stdout.write(text) } = {}) {
  const [action, ...rest] = argv;
  const json = rest.includes('--json');
  const args = rest.filter((arg) => arg !== '--json');
  let result;
  if (action === 'install') {
    if (args.length !== 2 || args[0] !== '--bin') throw new Error(USAGE);
    result = installKeyd({ bin: args[1], env, home });
    if (!json) write(`agent-bot-keyd ${result.changed ? 'installed' : 'unchanged'}: ${result.label} (${result.bin})\n`);
  } else if (action === 'uninstall' && args.length === 0) {
    result = uninstallKeyd({ env, home });
    if (!json) write(result.unloaded ? 'agent-bot-keyd unloaded; its Keychain items stay\n' : 'agent-bot-keyd was not installed\n');
  } else if (action === 'status' && args.length === 0) {
    result = await keydStatus({ env, home });
    if (!json) write(result.running ? `agent-bot-keyd ${result.version} running; daemon key ${result.pinned ? 'pinned' : 'not pinned'}\n` : 'agent-bot-keyd is not running\n');
  } else {
    throw new Error(USAGE);
  }
  if (json) write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  keydCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'keyd-failed', message: error.message } })}\n`);
    process.stderr.write(`agent-bot keyd: ${error.message}\n`);
    process.exitCode = 1;
  });
}
