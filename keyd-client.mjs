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
//     changing anything. So does `owner/presence`, the owner gate's proof
//     (owner-presence.mjs, #416).
//
// `agent-bot keyd install|uninstall|status` (supervising keyd under launchd)
// lives in keyd-supervisor.mjs.
//
// Without keyd (Homebrew, Linux) keys stay in the #395 stores.

import { randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
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
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; socket.destroy(); reject(error); };
    socket.setTimeout(timeoutMs, () => fail(Object.assign(new Error('agent-bot-keyd did not answer in time'), { code: 'keyd-timeout' })));
    socket.on('error', (error) => fail(Object.assign(new Error('agent-bot-keyd is not running'), { code: 'keyd-unavailable', cause: error.code })));
    socket.on('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`));
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      settled = true;
      socket.end();
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); } catch { reject(new Error('agent-bot-keyd answered malformed JSON')); return; }
      if (message.error) {
        reject(Object.assign(new Error(String(message.error.message ?? 'agent-bot-keyd refused')),
          { code: 'keyd-refused', rpcCode: Number.isInteger(message.error.code) ? message.error.code : null }));
      } else {
        resolve(message.result);
      }
    });
    // A keyd that crashes or hangs up before a full line would otherwise
    // leave this pending forever: socket timeouts stop once it closes.
    socket.on('close', () => {
      if (!settled) fail(Object.assign(new Error('agent-bot-keyd closed the connection without an answer'), { code: 'keyd-unavailable' }));
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

// `keyScope: 'app'` (#110) asks keyd to mint with the App-level key for
// `app` instead of the soul's own. A soul grant leaves the field out, so its
// 12 payload keys are what every keyd, old or new, accepts.
export function signKeydGrant({ agentId, app, tool, apiBase, installationId = null, owner = null, host = null, keyScope = null }, privateKey, now = () => new Date()) {
  if (!KEYD_TOOL_NAMES.includes(tool)) throw new Error(`unknown keyd tool: ${tool}`);
  if (keyScope !== null && keyScope !== 'soul' && keyScope !== 'app') throw new Error(`unknown keyd key scope: ${keyScope}`);
  const iat = Math.floor(now().getTime() / 1000);
  const payload = {
    v: 1, aud: KEYD_AUDIENCE, agentId, app, tool, iat, exp: iat + GRANT_TTL_SECONDS,
    nonce: randomBytes(18).toString('base64url'), apiBase,
    installationId: installationId === null || installationId === undefined || installationId === '' ? null : Number(installationId),
    owner: owner ?? null, host: host ?? null,
    ...(keyScope === 'app' ? { keyScope } : {}),
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

// The daemon's own mint for a keyd soul, or for a soul whose App keyd holds
// App-level (`keyScope: 'app'`, #110): sign a grant, call `credential`.
export async function mintViaKeyd({ agentId, app, keyScope = null, env = process.env, home = homedir(), config, now = () => new Date(), request = keydRequest } = {}) {
  if (!agentId) throw new Error(`the ${app} key is held by agent-bot-keyd; only a bound soul can get a token for it, through the daemon`);
  const grant = signKeydGrant({ agentId, app, tool: 'credential', keyScope, ...(await grantTarget({ env, config })) }, vouchKey({ env, home }).privateKey, now);
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
  const installationId = Number(body.installation_id);
  return { token: body.token, expires_at: body.expires_at, installation_id: Number.isSafeInteger(installationId) && installationId > 0 ? installationId : null };
}

// The owner's import (migrate-credentials --to keyd): every key in one call,
// so keyd asks once. The daemon key goes along every time; keyd pins it on
// the first import and refuses a different one.
export async function importIntoKeyd(items, { env = process.env, home = homedir(), request = keydRequest } = {}) {
  return request(keydPaths({ env, home }).ownerSocket, 'owner/import', {
    items, daemonKey: daemonGrantPublicKey({ env, home }),
  }, { timeoutMs: OWNER_TIMEOUT_MS });
}

// App-level keys (#110): one key per App, shared by every soul acting as it.
// Same single consent and daemon-key pin as importIntoKeyd.
export async function importAppIntoKeyd(items, { env = process.env, home = homedir(), request = keydRequest } = {}) {
  return request(keydPaths({ env, home }).ownerSocket, 'owner/app-import', {
    items, daemonKey: daemonGrantPublicKey({ env, home }),
  }, { timeoutMs: OWNER_TIMEOUT_MS });
}

// A keyd from before #110 answers the App-level methods with this.
export const KEYD_METHOD_NOT_FOUND = -32601;

// Whether keyd can take a new App-level key for `app`, asking nothing of the
// owner: keyd answers (`running`), the owner has pinned this daemon's key
// (`pinned`), and it knows `owner/app-status`. `{ available: true, held }`,
// or `{ available: false, reason }` in words the owner reads in the App
// command's output.
export async function appKeydAvailability(app, { env = process.env, home = homedir(), request = keydRequest } = {}) {
  const status = await keydStatus({ env, home, request });
  if (!status.running) return { available: false, reason: status.bin ? 'agent-bot-keyd is not running' : 'agent-bot-keyd is not installed' };
  if (!status.pinned) return { available: false, reason: "agent-bot-keyd has not pinned this daemon's key yet" };
  try {
    const held = await request(keydPaths({ env, home }).ownerSocket, 'owner/app-status', { app }, { timeoutMs: 5_000 });
    if (typeof held?.held !== 'boolean') return { available: false, reason: 'agent-bot-keyd gave no App-level key status' };
    if (held.pinned !== true) return { available: false, reason: "agent-bot-keyd has not pinned this daemon's key yet" };
    return { available: true, held: held.held };
  } catch (error) {
    if (error?.rpcCode === KEYD_METHOD_NOT_FOUND) return { available: false, reason: 'this agent-bot-keyd predates App-level keys (#110); update GeniusBar to keep App keys in keyd' };
    return { available: false, reason: 'agent-bot-keyd could not report App-level key status' };
  }
}

export function readKeydRecord({ env = process.env, home = homedir() } = {}) {
  try {
    const record = JSON.parse(readFileSync(keydPaths({ env, home }).record, 'utf8'));
    return typeof record?.bin === 'string' && path.isAbsolute(record.bin) ? record : null;
  } catch { return null; }
}

// The harness-side entry for an ACP session: keyd's own relay, which reads
// the soul's binding and never a key.
// `forward` names the soul's routed tool-home variables (#583 slice 2),
// which are not secret; HOME and XDG_STATE_HOME always travel as they are.
export function keydMcpServerEntry({ bin, binding = null, env = process.env, forward = [] } = {}) {
  const vars = [];
  if (binding) vars.push({ name: 'AGENT_BOT_BINDING', value: binding });
  const names = ['HOME', 'XDG_STATE_HOME', ...new Set(forward)].filter((name, index, all) => /^[A-Z][A-Z0-9_]*$/.test(name) && all.indexOf(name) === index);
  for (const name of names) {
    if (typeof env[name] === 'string' && env[name] !== '') vars.push({ name, value: env[name] });
  }
  return { name: KEYD_SERVER_NAME, command: bin, args: ['mcp'], env: vars };
}

export function keydPolicyRules() {
  return KEYD_TOOL_NAMES.map((tool) => ({ tool: `mcp__${KEYD_SERVER_NAME}__${tool}`, outcome: 'allow' }));
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

// Supervising keyd under launchd (`agent-bot keyd install|uninstall|status`)
// is the host's job: keyd-supervisor.mjs (#645). Run directly, this file only
// points there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('keyd-client: run agent-bot keyd\n');
  process.exitCode = 1;
}
