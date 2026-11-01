#!/usr/bin/env node
// Git credential helper that mints a GitHub App installation token on demand,
// so `git push` in an agent worktree authenticates as the bot with no
// pre-minted GH_TOKEN. Wired per worktree by setup-worktree.mjs as:
//
//   [credential]
//     helper =                                        ; reset inherited helpers
//     helper = !node <this file> <app-slug>
//
// Git appends the operation (get/store/erase) after the configured args and
// writes a key=value request on stdin. Only `get` matters: tokens live one
// hour, so there is nothing to store or erase. On any mint failure the helper
// exits non-zero and the push fails loudly — it never falls back to the
// human's stored login.

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mint } from './mint-token.mjs';
import { isGateEnabled, loadConfig, githubHost, soulOwnsAppSlug } from '../config.mjs';
import { boundRepository } from './inbox-take.mjs';
import { presenceOrConsent, soulMarkers } from './owner-gate.mjs';
import { readBinding } from './agent-binding.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { currentAgentId, readAgentIdentity } from './agent-identity.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { appendAuditReceipt } from './identity-format.mjs';

// Harness detection alone still leaves an unpinned owner as a delegate.
// Broken identity markers count too: they must never enable local key reads.
export function isSoulBound({ env = process.env, cwd = process.cwd() } = {}) {
  return soulMarkers({ env, cwd, detect: false }).length > 0;
}

// Shared by git and worktree-token (including the gh shim's explicit App
// path). Only the daemon may read a soul's key store. Its binding chooses the
// App; the requested slug is checked against the response, never sent as
// authority to the daemon.
export async function mintCredential({
  slug,
  permissions = null,
  operation = null,
  env = process.env,
  cwd = process.cwd(),
  soulBound = isSoulBound({ env, cwd }),
  mintImpl = mint,
  readBindingImpl = readBinding,
  clientFactory = async (options) => (await import('./daemon-client.mjs')).daemonClient(options),
} = {}) {
  if (!soulBound) return mintImpl({ slug, env });

  let binding;
  try { binding = readBindingImpl({ env, cwd }); } catch {
    throw new Error('cannot request a credential from the daemon: soul binding is unreadable');
  }
  if (!binding) throw new Error("a soul-bound caller needs a live daemon binding to obtain GitHub credentials — run 'agent-bot join --name NAME --harness HARNESS [--soul AGENT_ID]' from the soul's workspace or a linked worktree, bind with the local 'agent-bot mcp' bind tool, then 'agent-bot setup-worktree'; see docs/joining.md");
  let grant;
  try {
    const client = await clientFactory({ env, home: env.HOME, cwd });
    const crossAppOptions = (operation && (slug || permissions))
      ? { ...(slug ? { app: slug } : {}), ...(permissions ? { permissions } : {}), reason: operation }
      : null;
    grant = crossAppOptions
      ? await client.credential(binding.secret, crossAppOptions)
      : await client.credential(binding.secret);
  } catch (error) {
    // The daemon's own refusal (a soul without an App, the add-on off) is
    // worth repeating. Transport and parse errors are not: they may carry
    // paths or response bodies, never the generic line below.
    const refused = /^daemon POST \/v0\/credential failed: (.+)$/s.exec(error?.message ?? '');
    if (refused && !/^HTTP \d+$/.test(refused[1])) {
      throw new Error(`the agent-bot daemon refused a GitHub credential: ${refused[1]}`);
    }
    throw new Error('the agent-bot daemon could not provide a GitHub credential; check that the daemon is running and the soul binding is valid');
  }
  if (!grant || grant.agentId !== binding.agentId || (slug && grant.appSlug !== slug)) {
    throw new Error('daemon credential identity does not match the caller; refusing identity crossover');
  }
  if (typeof grant.token !== 'string' || !grant.token || !Number.isFinite(Date.parse(grant.expires_at))) {
    throw new Error('daemon returned an invalid GitHub credential');
  }
  return {
    token: grant.token, expires_at: grant.expires_at, installation_id: grant.installation_id,
    // The identity service's reference for this one-operation credential.
    credential_ref: grant.credential_ref ?? null, task_id: grant.task_id ?? null, operation_id: grant.operation_id ?? null,
  };
}

// The mints that still run in the caller's process — `agent-bot mint-token`,
// signed-commit and the gist handoff (#775). In a bound checkout the soul's
// own App comes from the daemon on its binding, never from a key this process
// can read. Another App, a GH_AGENT_APP override or narrowed permissions is
// the owner's call for any caller with a soul marker, bound or not (a soul
// checkout keeps its pins when its binding is gone): it goes through the owner gate
// (Touch ID, else the administrator dialog), leaves a receipt either way, and
// a decline or a headless run refuses. A caller with no marker mints as
// before. `delegate` marks the owner's own delegate surface, the Codex
// desktop app's Pull Requests UI (#107): with no marker it still mints
// locally with no gate, and leaves the secret-free receipt every mint owes.
export async function mintForCaller({
  slug = null,
  permissions = null,
  env = process.env,
  cwd = process.cwd(),
  operation = 'mint-token',
  delegate = false,
  selected = null,
  mintImpl = mint,
  readBindingImpl = readBinding,
  currentAgentIdImpl = currentAgentId,
  resolveSlugImpl = resolveAgentSlug,
  readIdentityImpl = (agentId) => readAgentIdentity(agentId, { stateDir: stateDirectory({ env, home: env.HOME }) }),
  approve = presenceOrConsent,
  receipt = (fields) => appendAuditReceipt(fields, { env, home: env.HOME }),
  clientFactory,
} = {}) {
  let binding;
  try { binding = readBindingImpl({ env, cwd }); } catch {
    throw new Error('cannot mint a GitHub token: the soul binding in this checkout is unreadable');
  }
  // The soul markers isSoulBound() reads. A marker that cannot be read is
  // still a soul with no App of its own here, so every request asks the
  // owner. With no Agent ID, a stated App (GH_AGENT_APP or the checkout's
  // pin) is the caller's own App.
  let soul = binding?.agentId ?? null;
  let marked = Boolean(binding);
  let own = null;
  let identityRecord = null;
  let cfg = {};
  try { cfg = loadConfig({ env }); } catch { /* ignore */ }
  if (!binding) {
    try { soul = currentAgentIdImpl({ env, cwd }); marked = soul !== null; } catch { marked = true; }
  }
  if (soul) {
    try { identityRecord = readIdentityImpl(soul); own = identityRecord?.github?.appSlug ?? null; } catch { /* no record: no App of its own */ }
    if (identityRecord) {
      try {
        const checkoutOwn = resolveSlugImpl({
          env: { ...env, AGENT_BOT_ID: soul, GH_AGENT_APP: '' },
          cwd,
          config: cfg,
          detect: false,
        });
        if (checkoutOwn && soulOwnsAppSlug(identityRecord, checkoutOwn, cfg, { env })) {
          own = checkoutOwn;
        }
      } catch { /* keep identityRecord's appSlug */ }
    }
  } else if (!marked) {
    try { own = resolveSlugImpl({ env, cwd, detect: false }); marked = own !== null; } catch { marked = true; }
  }
  if (!marked && !delegate) return mintImpl({ slug, env, permissions, selected });
  if (!marked) {
    // Best effort, as for mint-token's operator receipt: a receipt that
    // cannot be written warns and never changes whether a token is released.
    const note = (decision, reason) => {
      try {
        receipt({ event: 'credential-mint', agentId: null, operation, decision, appSlug: slug ?? null, reason });
      } catch (error) {
        console.error(`agent-bot: could not write the mint receipt: ${error.message}`);
      }
    };
    let grant;
    try { grant = await mintImpl({ slug, env, permissions, selected }); } catch (error) {
      note('failed', 'mint-failed');
      throw error;
    }
    note('granted', 'owner-delegate-surface');
    return grant;
  }

  const wanted = slug ?? env.GH_AGENT_APP ?? own;
  if (!wanted) throw new Error('this soul has no GitHub App; name one with --app to ask the owner for its token');
  const isOwnApp = wanted === own || Boolean(identityRecord && soulOwnsAppSlug(identityRecord, wanted, cfg, { env }));
  if (isOwnApp && !permissions && (!env.GH_AGENT_APP || env.GH_AGENT_APP === wanted)) {
    if (!binding) {
      if (soul) {
        throw new Error(
          "a soul-bound caller needs a live daemon binding to obtain GitHub credentials — run 'agent-bot join --name NAME --harness HARNESS [--soul AGENT_ID]' from the soul's workspace or a linked worktree, bind with the local 'agent-bot mcp' bind tool, then 'agent-bot setup-worktree'; see docs/joining.md",
        );
      }
      const localSlug = slug ?? (wanted !== (identityRecord?.github?.appSlug ?? own) ? wanted : null);
      return mintImpl({ slug: localSlug, env, selected });
    }
    if (selected) selected({ appSlug: wanted, reason: 'bound-soul-own-app' });
    return mintCredential({
      slug: wanted, env, cwd, soulBound: true, readBindingImpl: () => binding,
      ...(clientFactory ? { clientFactory } : {}),
    });
  }
  if (!binding && soul) {
    throw new Error(
      "a soul-bound caller needs a live daemon binding to obtain GitHub credentials — run 'agent-bot join --name NAME --harness HARNESS [--soul AGENT_ID]' from the soul's workspace or a linked worktree, bind with the local 'agent-bot mcp' bind tool, then 'agent-bot setup-worktree'; see docs/joining.md",
    );
  }

  const scope = permissions
    ? ` limited to ${Object.entries(permissions).map(([name, level]) => `${name}=${level}`).join(', ')}`
    : '';
  let repoLabel = env.AGENT_BOT_SERVER_REPO ?? 'this checkout';
  try {
    repoLabel = boundRepository(cwd);
  } catch { /* keep fallback */ }
  const caller = soul
    ? `${soul}${own ? ` (own App: ${own}[bot])` : ''}`
    : (own ?? 'an unreadable soul');
  const action = `mint a GitHub App token for another application (${wanted}[bot]${scope}) in ${repoLabel} for ${operation}, requested from a checkout stated as ${caller}`;
  const record = (decision, reason) => receipt({
    event: 'credential-mint', agentId: soul, operation, decision, appSlug: wanted, reason,
  });
  let proof;
  try { proof = await approve(action, { env }); } catch (error) {
    record('denied', 'owner-gate-refused');
    throw error;
  }
  record('approved', `owner-${proof?.method ?? 'approved'}`);
  if (binding && !clientFactory) {
    if (selected) selected({ appSlug: wanted, reason: 'owner-approved' });
    return mintCredential({
      slug: wanted, permissions, operation, env, cwd, soulBound: true, readBindingImpl: () => binding,
    });
  }
  return mintImpl({
    slug: wanted, env, permissions,
    selected: selected ? (chosen) => selected({ ...chosen, reason: 'owner-approved' }) : null,
  });
}

export function parseCredentialRequest(text) {
  const request = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) request[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return request;
}

async function main() {
  const [slug, operation] = process.argv.slice(2);
  if (!slug) throw new Error('usage: git-credential-bot.mjs <app-slug> <get|store|erase>');
  if (operation !== 'get') return;
  if (!isGateEnabled('github-identity')) throw new Error('github-identity add-on is off');

  const request = parseCredentialRequest(readFileSync(0, 'utf8'));
  const host = githubHost(loadConfig());
  // Stay silent for anything that is not GitHub-over-HTTPS; git moves on.
  if (request.protocol !== 'https' || request.host !== host) return;

  const { token } = await mintCredential({ slug });
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
}

// Run directly, from here or through the shim at its old path (#645, step 6).
if (process.argv[1] && [import.meta.url, new URL('../git-credential-bot.mjs', import.meta.url).href]
  .includes(pathToFileURL(process.argv[1]).href)) {
  main().catch((err) => {
    console.error(`git-credential-bot: ${err.message}`);
    process.exit(1);
  });
}
