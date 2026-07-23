#!/usr/bin/env node
// Mints a short-lived GitHub App installation token for a bot identity.
// Prints the token to stdout for use as GH_TOKEN. Zero-dependency.
//
// Identity selection (first match wins): --app <slug>, GH_AGENT_APP, or
// harness auto-detection mapped through ~/.config/agent-bot/config.json.
// Credentials come from ~/.config/<slug>/{app-id,private-key.pem}, or an
// explicit GH_APP_ID + GH_APP_PRIVATE_KEY_PATH pair (CI).
//
// Installation selection: GH_APP_INSTALLATION_ID, else the config `owner`
// account, else the App's single installation.
//
// Flag: --json — print { token, expires_at, installation_id }

import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { loadConfig, apiBase, resolveSlug } from './config.mjs';

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

export function appCredentials({ argv = process.argv, env = process.env, home = homedir(), config } = {}) {
  const slug = resolveSlug({ argv, env, config });
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
  if (env.GH_APP_ID && env.GH_APP_PRIVATE_KEY_PATH) {
    return { slug: null, appId: env.GH_APP_ID, privateKeyPem: readFileSync(env.GH_APP_PRIVATE_KEY_PATH, 'utf8') };
  }
  throw new Error(
    'no identity resolved — pass --app <slug>, set GH_AGENT_APP, configure ~/.config/agent-bot/config.json, or set GH_APP_ID and GH_APP_PRIVATE_KEY_PATH',
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

export async function mint({ slug, env = process.env } = {}) {
  const config = loadConfig({ env });
  const argv = slug ? ['node', 'mint-token.mjs', '--app', slug] : process.argv;
  const { appId, privateKeyPem } = appCredentials({ argv, env, config });
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
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(grant)}\n`);
  } else {
    process.stdout.write(`${grant.token}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`mint-token: ${err.message}`);
    process.exit(1);
  });
}
