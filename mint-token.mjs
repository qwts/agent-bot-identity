#!/usr/bin/env node
// Mints a short-lived GitHub App installation token for an agent bot identity.
// Prints the token to stdout for use as GH_TOKEN. Zero-dependency.
//
// App selection (first match wins):
//   --app <slug>             — the App/soul key store, else the legacy
//                              ~/.config/<slug>/{app-id,private-key.pem}
//   GH_AGENT_APP=<slug>      — same lookup, set once per launcher environment
//   git config agentBot.app  — the checkout's pin, so a token is minted for
//                              the agent the commits are authored as
//   account + config.json    — an agent account IS its harness's App (ENG-0339)
//   harness + config.json    — auto-detect mapped through prefix/apps
//   GH_APP_ID + GH_APP_PRIVATE_KEY or GH_APP_PRIVATE_KEY_PATH — CI/overrides
// Installation: an App installed on one account mints there. When an App is
//   installed on several accounts, config "owner" (the account an App is
//   installed on — not the roster's governance owner) or
//   GH_APP_INSTALLATION_ID picks one.
// Flag: --json — print the documented secret-bearing stdout object:
//   { schema_version: 1, token, expires_at, installation_id }
// Arguments are checked before anything is minted (#213): --help prints the
// usage and mints nothing, and an option this command does not know is an
// error, so a mistyped flag never releases a credential by accident.

import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { resolveAppCredential } from './soul-credentials.mjs';
import { loadConfig, apiBase } from './config.mjs';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// App JWTs are capped at 10 minutes by GitHub; 9 minutes with a 60-second
// backdate absorbs clock drift between this machine and GitHub.
export function buildAppJwt(appId, privateKeyPem, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(createPrivateKey(privateKeyPem));
  return `${signingInput}.${b64url(signature)}`;
}

export const MINT_USAGE = `usage: agent-bot mint-token [--app <slug>] [--permissions <name>=<level>[,...]] [--json]

Mints a short-lived GitHub App installation token and prints it to stdout.

Options:
  --app <slug>    Mint for this App (else GH_AGENT_APP, the checkout's pin,
                  the agent account, or the detected harness)
  --permissions <name>=<level>[,<name>=<level>...]
                  Ask for only these permissions (level read, write or admin),
                  each at or below what the installation grants; the mint is
                  refused before any request when one is not granted
  --json          Print { schema_version, token, expires_at, installation_id }
  -h, --help      Show this help and mint nothing
`;

// GitHub's permission levels, lowest first; a request may not exceed the grant.
const LEVELS = ['read', 'write', 'admin'];
const PERMISSION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** `--permissions` as a name → level map, or an error naming the bad entry. */
export function parsePermissions(spec) {
  const permissions = {};
  for (const entry of String(spec).split(',')) {
    const [name, level, ...rest] = entry.split('=');
    if (!name || !level || rest.length > 0 || !PERMISSION_NAME.test(name) || !LEVELS.includes(level)) {
      throw new Error(`--permissions entries are <name>=<read|write|admin>, got "${entry}"`);
    }
    if (name in permissions) throw new Error(`--permissions names ${name} twice`);
    permissions[name] = level;
  }
  return permissions;
}

/**
 * The permissions the installation grant does not cover, as
 * `name: wanted (granted: level|none)` lines; empty when the request fits.
 */
export function ungrantedPermissions(requested, granted = {}) {
  return Object.entries(requested)
    .filter(([name, level]) => !(name in granted) || LEVELS.indexOf(granted[name]) < LEVELS.indexOf(level))
    .map(([name, level]) => `${name}: ${level} (granted: ${granted[name] ?? 'none'})`);
}

/**
 * The command line, checked before a mint: `{ app, json, help, permissions }`.
 * Any other option is an error, and `--app` needs a slug.
 */
export function parseMintArgs(argv = process.argv.slice(2)) {
  const options = { app: null, json: false, help: false, permissions: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--app') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--app requires a slug, e.g. --app yourname-claude-agent');
      if (options.app !== null) throw new Error('--app may be passed only once');
      options.app = value;
      index += 1;
    } else if (arg === '--permissions') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--permissions requires <name>=<level>[,...], e.g. --permissions contents=read,pull_requests=write');
      if (options.permissions !== null) throw new Error('--permissions may be passed only once');
      options.permissions = parsePermissions(value);
      index += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

export function appConfig({
  argv = process.argv,
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  config,
  agentId = null,
  resolveCredential = resolveAppCredential,
} = {}) {
  const flag = argv.indexOf('--app');
  if (flag !== -1 && !argv[flag + 1]) {
    throw new Error('--app requires a slug, e.g. --app yourname-claude-agent');
  }
  const explicitSlug = flag !== -1 ? argv[flag + 1] : null;
  if (!explicitSlug && !env.GH_AGENT_APP && env.GH_APP_ID && env.GH_APP_PRIVATE_KEY) {
    return { appId: env.GH_APP_ID, privateKeyPem: env.GH_APP_PRIVATE_KEY, slug: null };
  }
  if (!explicitSlug && !env.GH_AGENT_APP && env.GH_APP_ID && env.GH_APP_PRIVATE_KEY_PATH) {
    return {
      appId: env.GH_APP_ID,
      privateKeyPem: readFileSync(env.GH_APP_PRIVATE_KEY_PATH, 'utf8'),
      slug: null,
    };
  }
  // One resolver for every consumer (ENG-0079): --app, then GH_AGENT_APP, then
  // the checkout's pin, then the account, then harness detection. Explicit
  // inputs are taken at face value wherever the process runs — the directory
  // a checkout sits in is not an identity input and never vetoes one
  // (ENG-0339 supersedes ENG-0045). `doctor` depends on --app to mint every
  // configured App in turn from whatever checkout it happens to run in.
  const slug = resolveAgentSlug({
    explicit: explicitSlug,
    env,
    cwd,
    config: config ?? loadConfig({ env, home }),
  });
  if (slug) {
    // The declaring soul's own key store first, then the legacy
    // ~/.config/<slug> folder with a one-time notice (#383).
    const { appId, privateKeyPem, source, agentId: owner } = resolveCredential(slug, { agentId, env, home, cwd, config });
    // agent-bot-keyd holds this soul's key and never returns it (#397).
    if (source === 'keyd') return { slug, appId: null, privateKeyPem: null, keyd: { agentId: owner } };
    return { slug, appId, privateKeyPem };
  }
  throw new Error(
    'pass --app <slug>, set GH_AGENT_APP, configure ~/.config/agent-bot/config.json, or set GH_APP_ID with GH_APP_PRIVATE_KEY or GH_APP_PRIVATE_KEY_PATH',
  );
}

// Which of appConfig()'s selectors chose the App, as a fixed receipt reason
// code (#107). It follows appConfig()'s order; the checkout pin, the account
// and harness detection are reported together as `ambient-app`.
export function selectionReason({ argv = process.argv, env = process.env } = {}) {
  if (argv.indexOf('--app') !== -1) return 'explicit-app';
  if (env.GH_AGENT_APP) return 'env-app';
  if (env.GH_APP_ID && (env.GH_APP_PRIVATE_KEY || env.GH_APP_PRIVATE_KEY_PATH)) return 'env-credential';
  return 'ambient-app';
}

async function gh(base, method, path, jwt, payload = null) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-bot-identity',
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${body.message ?? 'unknown error'}`);
  }
  return body;
}

// Pick the installation to mint against. An App installed on exactly one
// account has exactly one place it can mint, so `owner` is not consulted.
// `owner` is the account an App is installed on, not the roster's governance
// owner (profile.account_owner): a private App can only be installed on the
// account that owns it, so an App owned by an organization the governance
// owner controls is installed on that organization while the person keeps
// governing the roster (#194). `owner` earns its keep only when an App is
// installed on several accounts, and then it must name one of them.
export function pickInstallation(installations, owner) {
  if (installations.length === 0) {
    throw new Error(
      'the App is not installed on any account — the key is valid, but creation is not installation: open the App page -> Install App and install it on the account whose repos agents work in (in a managed org this may require admin approval)',
    );
  }
  if (installations.length === 1) return installations[0];
  const accounts = installations.map((i) => i.account?.login).filter(Boolean).join(', ');
  if (!owner) {
    throw new Error(
      `the App is installed on ${installations.length} accounts (${accounts}) — set "owner" in the config (or GH_APP_INSTALLATION_ID) to pick one`,
    );
  }
  const wanted = String(owner).toLowerCase();
  const pick = installations.find((i) => i.account?.login?.toLowerCase() === wanted);
  if (!pick) {
    throw new Error(
      `owner "${owner}" matched none of the App's installations — the App is installed on: ${accounts}; set "owner" to one of them (or GH_APP_INSTALLATION_ID)`,
    );
  }
  return pick;
}

// Programmatic entry point (used by git-credential-bot.mjs): mint a token
// for a slug, or for whatever appConfig() resolves when slug is omitted.
// `agentId` names the soul the daemon is minting for, so its store is read
// first; without one the caller's own Agent ID (if any) is used.
//
// A soul whose key agent-bot-keyd holds mints through keyd: `viaKeyd` is
// the daemon's in-process grant (keyd-client.mjs mintViaKeyd); anywhere
// else the caller asks the daemon on its own binding.
//
// `permissions` (#213) asks GitHub for a token with only those permissions,
// each at or below the installation's grant; a request the grant does not
// cover is refused before the token request, naming what was wanted and what
// is granted. Without it the token carries the whole grant, as before. A key
// held by keyd mints through the daemon, which issues the soul's full grant,
// so `permissions` is refused there rather than silently ignored.
//
// `selected` (#107), when given, is told which App was chosen and why, as
// soon as it is resolved and before anything is minted, so a caller can
// receipt the attempt whatever its outcome. It is never given key material.
export async function mint({ slug, env = process.env, agentId = null, viaKeyd = null, permissions = null, selected = null } = {}) {
  const config = loadConfig({ env });
  const argv = slug ? ['node', 'mint-token.mjs', '--app', slug] : process.argv;
  const resolved = appConfig({ argv, env, config, agentId });
  if (selected) selected({ appSlug: resolved.slug, reason: selectionReason({ argv, env }) });
  if (resolved.keyd) {
    if (permissions) throw new Error(`the ${resolved.slug} key is held by agent-bot-keyd, which mints the soul's full grant through the daemon; --permissions is not available for it`);
    if (viaKeyd) return viaKeyd({ agentId: resolved.keyd.agentId, app: resolved.slug, config });
    const { mintThroughDaemon } = await import('./keyd-client.mjs');
    return mintThroughDaemon({ slug: resolved.slug, env });
  }
  const { appId, privateKeyPem } = resolved;
  const base = apiBase(config);
  const jwt = buildAppJwt(appId, privateKeyPem, Math.floor(Date.now() / 1000));

  let installationId = env.GH_APP_INSTALLATION_ID;
  let installation = null;
  if (!installationId) {
    const installations = await gh(base, 'GET', '/app/installations', jwt);
    installation = pickInstallation(installations, config.owner);
    installationId = installation.id;
  }
  if (permissions) {
    // The grant comes with the listing; a pinned installation id is read on its own.
    if (!installation) installation = await gh(base, 'GET', `/app/installations/${installationId}`, jwt);
    const granted = installation.permissions && typeof installation.permissions === 'object' ? installation.permissions : {};
    const missing = ungrantedPermissions(permissions, granted);
    if (missing.length > 0) {
      throw new Error(`the installation on ${installation.account?.login ?? installationId} does not grant ${missing.join('; ')} — ask for less, or widen the App's installation on github.com`);
    }
  }

  const grant = await gh(base, 'POST', `/app/installations/${installationId}/access_tokens`, jwt, permissions ? { permissions } : null);
  return { token: grant.token, expires_at: grant.expires_at, installation_id: Number(installationId) };
}

// The command line lives in cli/mint-token.mjs; output formatting is a cli
// concern (#645). Run directly, this file only points there and mints nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error('mint-token: run agent-bot mint-token');
  process.exit(1);
}
