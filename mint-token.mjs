#!/usr/bin/env node
// Mints a short-lived GitHub App installation token for an agent bot identity.
// Prints the token to stdout for use as GH_TOKEN. Zero-dependency.
//
// App selection (first match wins):
//   --app <slug>             — read ~/.config/<slug>/{app-id,private-key.pem}
//   GH_AGENT_APP=<slug>      — same lookup, set once per launcher environment
//   git config agentBot.app  — the checkout's pin, so a token is minted for
//                              the agent the commits are authored as
//   account + config.json    — an agent account IS its harness's App (ENG-0339)
//   harness + config.json    — auto-detect mapped through prefix/apps
//   GH_APP_ID + GH_APP_PRIVATE_KEY or GH_APP_PRIVATE_KEY_PATH — CI/overrides
// Env:  GH_APP_INSTALLATION_ID — only needed when the App has >1 installation
// Flag: --json — print the documented secret-bearing stdout object:
//   { schema_version: 1, token, expires_at, installation_id }

import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { loadConfig, apiBase } from './config.mjs';
import { formatMintGrant } from './cli/mint-output.mjs';

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

export function appConfig({
  argv = process.argv,
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  config,
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
    config: config ?? loadConfig({ env }),
  });
  if (slug) {
    const dir = join(home, '.config', slug);
    try {
      return {
        slug,
        appId: readFileSync(join(dir, 'app-id'), 'utf8').trim(),
        privateKeyPem: readFileSync(join(dir, 'private-key.pem'), 'utf8'),
      };
    } catch {
      throw new Error(`no app config for "${slug}" — expected ${dir}/app-id and ${dir}/private-key.pem`);
    }
  }
  throw new Error(
    'pass --app <slug>, set GH_AGENT_APP, configure ~/.config/agent-bot/config.json, or set GH_APP_ID with GH_APP_PRIVATE_KEY or GH_APP_PRIVATE_KEY_PATH',
  );
}

async function gh(base, method, path, jwt) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-bot-identity',
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${body.message ?? 'unknown error'}`);
  }
  return body;
}

// Programmatic entry point (used by git-credential-bot.mjs): mint a token
// for a slug, or for whatever appConfig() resolves when slug is omitted.
export async function mint({ slug, env = process.env } = {}) {
  const config = loadConfig({ env });
  const argv = slug ? ['node', 'mint-token.mjs', '--app', slug] : process.argv;
  const { appId, privateKeyPem } = appConfig({ argv, env, config });
  const base = apiBase(config);
  const jwt = buildAppJwt(appId, privateKeyPem, Math.floor(Date.now() / 1000));

  let installationId = env.GH_APP_INSTALLATION_ID;
  if (!installationId) {
    const installations = await gh(base, 'GET', '/app/installations', jwt);
    const pick = config.owner
      ? installations.find((i) => i.account?.login?.toLowerCase() === config.owner.toLowerCase())
      : installations.length === 1
        ? installations[0]
        : null;
    if (!pick) {
      throw new Error(
        installations.length === 0
          ? 'the App is not installed on any account — the key is valid, but creation is not installation: open the App page -> Install App and install it on the account whose repos agents work in (in a managed org this may require admin approval)'
          : `the App is installed on ${installations.length} accounts — set "owner" in the config (or GH_APP_INSTALLATION_ID) to pick one`,
      );
    }
    installationId = pick.id;
  }

  const grant = await gh(base, 'POST', `/app/installations/${installationId}/access_tokens`, jwt);
  return { token: grant.token, expires_at: grant.expires_at, installation_id: Number(installationId) };
}

async function main() {
  const grant = await mint();
  process.stdout.write(formatMintGrant(grant, { json: process.argv.includes('--json') }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`mint-token: ${err.message}`);
    process.exit(1);
  });
}
