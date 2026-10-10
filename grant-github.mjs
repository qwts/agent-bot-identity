// The act behind a delegation grant (#108): the owner's narrow GitHub token
// performs the one write the owner approved, as the owner's own account.
//
// The token is a fine-grained one with Issues and Pull requests write
// (owner decision on #108). It lives in one pass-cli note the daemon reads
// fresh for each spend, titled `<namespace>.human/<login>-github-token` in
// the host's vault (credential-names.mjs). The login is the host's
// AGENT_BOT_HUMAN_LOGIN; there is no default account.
//
// `prepare` runs before the grant is spent: it reads the note and asks
// GitHub who the token is. A missing login or note, an unreadable store, or
// a token for another account refuses with a stable code and leaves the
// grant approved, so the owner can store the token and the soul spend the
// same grant. `perform` is the write alone.
//
// The token never leaves this module: it is held in a closure, never
// returned, and every message is built from codes and HTTP statuses, never
// from what pass-cli or GitHub sent back.
import process from 'node:process';

import { credentialNamespace, humanTokenItem, itemTitle } from './credential-names.mjs';
import { createPassCredentialStore } from './secret-providers/pass-cli-credentials.mjs';

export const HUMAN_LOGIN_VARIABLE = 'AGENT_BOT_HUMAN_LOGIN';
// The granted writes this module performs. Anything else refuses before the
// grant is spent.
export const GRANT_ACTS = Object.freeze(['issue-comment', 'issue-state', 'review-request']);
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_TIMEOUT_MS = 15_000;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function grantError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function humanLogin(env = process.env) {
  const login = env[HUMAN_LOGIN_VARIABLE];
  if (typeof login !== 'string' || !LOGIN.test(login)) {
    throw grantError('human-login-unconfigured',
      `the daemon has no human account; set ${HUMAN_LOGIN_VARIABLE} to the owner's GitHub login and rerun \`agent-bot daemon install\``);
  }
  return login;
}

export function humanTokenTitle(login, env = process.env) {
  return itemTitle(humanTokenItem(login, { namespace: credentialNamespace(env) }));
}

// The token, or a refusal that names the note and nothing read from it.
export function readHumanToken({ env = process.env, login, store = null } = {}) {
  const title = humanTokenTitle(login, env);
  let value;
  try {
    value = (store ?? createPassCredentialStore({ env })).read(title);
  } catch (error) {
    if (error?.code === 'missing-item') {
      throw grantError('human-token-missing',
        `the human GitHub token is not stored; add a pass-cli note titled ${title} holding a fine-grained token with Issues and Pull requests write, then spend the grant again`);
    }
    throw grantError('human-token-unavailable',
      `the daemon could not read the pass-cli note ${title}${typeof error?.code === 'string' ? ` (${error.code})` : ''}; check \`pass-cli\` is signed in for the daemon's account, then spend the grant again`);
  }
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) {
    throw grantError('human-token-missing', `the pass-cli note ${title} is empty; store the token in it, then spend the grant again`);
  }
  return token;
}

async function github({ fetchImpl, apiUrl, timeoutMs, token }, method, route, body = undefined) {
  let response;
  try {
    response = await fetchImpl(new URL(route, apiUrl), {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'agent-bot-delegation-grant',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw grantError('github-unreachable', 'GitHub did not answer');
  }
  if (!response.ok) {
    throw grantError(`github-http-${response.status}`, `GitHub answered ${response.status}`);
  }
  try { return await response.json(); } catch { return null; }
}

export function createGrantActor({
  env = process.env,
  store = null,
  fetchImpl = globalThis.fetch,
  apiUrl = GITHUB_API,
  timeoutMs = GITHUB_TIMEOUT_MS,
} = {}) {
  async function prepare(operation) {
    if (!GRANT_ACTS.includes(operation.operation)) {
      throw grantError('grant-unsupported', `${operation.operation} grants are not performed by this daemon; nothing was spent`);
    }
    const login = humanLogin(env);
    const call = { fetchImpl, apiUrl, timeoutMs, token: readHumanToken({ env, login, store }) };
    let user;
    try {
      user = await github(call, 'GET', '/user');
    } catch (error) {
      throw grantError('human-check-failed', `the human token could not be checked (${error.code}); nothing was spent`);
    }
    const account = typeof user?.login === 'string' && LOGIN.test(user.login) ? user.login : null;
    if (!account || account.toLowerCase() !== login.toLowerCase()) {
      throw grantError('human-login-mismatch', `the stored token is not ${login}'s; replace it, then spend the grant again`);
    }
    return { account, act: () => act(call, operation) };
  }

  async function act(call, operation) {
    const [owner, name] = operation.repo.split('/');
    const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    if (operation.operation === 'issue-comment') {
      await github(call, 'POST', `${repo}/issues/${operation.number}/comments`, { body: operation.body });
      return;
    }
    if (operation.operation === 'issue-state') {
      await github(call, 'PATCH', `${repo}/issues/${operation.number}`, { state: operation.state });
      return;
    }
    await github(call, 'POST', `${repo}/pulls/${operation.number}/requested_reviewers`, { reviewers: operation.reviewers });
  }

  // The ledger hands `perform` what `prepare` returned.
  async function perform(_operation, context) {
    await context.act();
  }

  return { prepare, perform };
}
