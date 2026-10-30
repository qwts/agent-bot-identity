#!/usr/bin/env node

// Sanctioned agent-bot MCP server (#94): the conversation-side half of the
// surrender-and-enforce binding flow, spoken over newline-delimited JSON-RPC
// on stdio so any MCP-capable harness can mount it with zero dependencies.
//
//   agent-bot mcp
//
// It AUGMENTS the worktree scripts, never replaces them: setup-worktree still
// configures identity, credentials, and hooks, and additionally mints the
// inert bind token this server surrenders. At conversation start the agent
// calls the `bind` tool with what only the conversation knows (transcript
// locator, parent agent); this server reads the token from the worktree it is
// running in, exchanges it at the daemon, and holds the returned binding
// secret from the private git dir. The secret is never logged or returned
// to the conversation; subsequent MCP processes reuse the shared binding.
//
// Git and gh remain the only sanctioned write paths to GitHub; nothing here
// touches commits or the credential boundary.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readBinding, readBindToken, resolveAgentSlug, serverUrl, loadDevice } from './identity-host.mjs';
import { daemonClient } from './daemon-client.mjs';
import { detectAgentHarness } from './detect-harness.mjs';
import { SKILL_REFERENCES, skillReferenceFor } from './skill-for-map.mjs';
import { loadConfig } from './config.mjs';
const PROTOCOL_VERSION = '2025-06-18';

function serverVersion() {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const TOOLS = [
  {
    name: 'bind',
    description:
      'Surrender this worktree\'s bind token and bind the current conversation '
      + 'to its execution identity. Call once at conversation start, before any '
      + 'other agent-bot tool. The transcript id is whatever identifies this '
      + 'conversation to its harness (session id, thread id).',
    inputSchema: {
      type: 'object',
      properties: {
        transcript_id: { type: 'string', description: 'conversation/session identifier from the harness' },
        transcript_provider: { type: 'string', description: 'harness name (claude, codex, cursor, custom)' },
        parent_agent_id: { type: 'string', description: 'spawning agent\'s Agent ID, when this conversation was spawned by a bound agent' },
      },
      required: ['transcript_id'],
    },
  },
  {
    name: 'whoami',
    description: 'Report the identity this connection is bound to, as enforced by the daemon.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'population',
    description: 'List the population census of agent souls in this account.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'filter by lifecycle status (active, finalized, retired)' },
        app: { type: 'string', description: 'filter by GitHub App slug' },
      },
    },
  },
  {
    name: 'space_path',
    description: 'Path of the bound identity\'s Agent Space (requires bind).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'credential',
    description:
      'Check that the identity this connection is bound to can obtain a GitHub '
      + 'credential (requires bind). Returns a credential reference (the identity '
      + 'service issuance ID, task and operation), never the token itself: git '
      + 'and gh in a configured worktree mint their own per operation through the '
      + 'credential helper and the gh shim.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'take_notices',
    description:
      'Lease up to `count` GitHub notices (mentions, review requests, reviews, comments, issue/PR/discussion changes) for this '
      + 'bound soul\'s App from the agent-bot server, oldest first. Each has an `id` and a `lease`; call ack_notices with the '
      + 'leases once handled, or they come back after lease_seconds (`attempts` counts takes). Requires bind and server mode.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      count: { type: 'integer', minimum: 1, maximum: 50, description: 'default 10' },
      type: { type: 'string', description: 'comma list of discussion, issue, pr, review, comment (plural ok)' },
      kind: { type: 'string', description: 'comma list, e.g. mention, review_requested, issues.opened' },
      repo: { type: 'string', description: 'comma list of owner/name' },
      since: { type: 'string', description: 'RFC3339 or unix time' },
      lease_seconds: { type: 'integer', minimum: 10, maximum: 3600, description: 'default 300' },
    } },
  },
  {
    name: 'peek_notices',
    description: 'List visible notices (same filters as take_notices) without leasing them. Requires bind and server mode.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      count: { type: 'integer', minimum: 1, maximum: 50 }, type: { type: 'string' }, kind: { type: 'string' },
      repo: { type: 'string' }, since: { type: 'string' },
    } },
  },
  {
    name: 'ack_notices',
    description: 'Delete handled notices. Pass the `lease` tokens from take_notices (a stale lease is reported, not acked).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['ids'], properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
    } },
  },
  {
    name: 'release_notices',
    description: 'Hand leased notices back to the queue early, unhandled.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['ids'], properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
    } },
  },
  {
    name: 'take_inbox',
    description:
      'DEPRECATED: use take_notices + ack_notices. In server mode this takes one notice for the bound repository and acks it. Take the next subscribed GitHub notice (including mentions, review requests, '
      + 'merges, reviews, issue changes and discussion changes) for the App and '
      + 'repository this bound worktree is. The call returns the event and '
      + 'marks it pulled (the record stays until its push deliveries settle '
      + 'and the TTL expires). A returned event carries a `deliveries` array '
      + 'with the per-subscriber push status (`pending`, `delivered`, or '
      + '`dead`), so a consumer that also receives pushes can skip events '
      + 'already delivered and watch for dead ones. The repository and App '
      + 'come from the binding, not from the caller. Requires bind.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'request_grant',
    description:
      'Ask the owner for one named write as their GitHub account (#108): an '
      + 'issue or pull request comment, closing or reopening one, or a review '
      + 'request. The owner '
      + 'approves this exact operation at a Touch ID prompt, which this call '
      + 'waits on. Returns the approved grant; spend it with spend_grant and '
      + 'the same operation. Approving or merging is never grantable. '
      + 'Requires bind.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'object',
          description: '{ operation: "issue-comment", repo: "owner/name", number, body }, '
            + '{ operation: "issue-state", repo: "owner/name", number, state: "open" | "closed" } or '
            + '{ operation: "review-request", repo: "owner/name", number, reviewers: [logins] }',
        },
      },
      required: ['operation'],
    },
  },
  {
    name: 'spend_grant',
    description:
      'Perform an approved grant once, as the owner\'s account. Pass the '
      + 'grant\'s proposal_id and the operation exactly as requested. A '
      + 'refusal before the write (for example no stored token) leaves the '
      + 'grant approved, so it can be spent again once fixed. Requires bind.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string' },
        operation: { type: 'object' },
      },
      required: ['proposal_id', 'operation'],
    },
  },
];

const TOOL_CLASS = Object.freeze({
  whoami: 'read', population: 'read', space_path: 'read', peek_notices: 'read',
  doctor: 'read', server_status: 'read', guide: 'read',
  bind: 'write', credential: 'write', take_notices: 'write', ack_notices: 'write',
  release_notices: 'write', take_inbox: 'write', request_grant: 'write', spend_grant: 'write',
  machine_status: 'read', machine_receipts: 'read',
  machine_plan: 'write', machine_apply: 'write', machine_update: 'write',
});

function oneLine(text) {
  return text.replace(/\s+/g, ' ').replace(/\.`/g, "'").split('. ')[0].replace(/\.$/, '');
}

// The hidden registry: legacy names stay callable but are no longer listed.
const HIDDEN = new Map(TOOLS.map((tool) => [tool.name, tool]));

const META_TOOLS = [
  {
    name: 'search_tools',
    description: 'Find agent-bot tools by keyword; returns each match\'s name and a one-line description.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', description: 'what you need to do (omit to list every visible tool)' },
    } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'describe_tool',
    description: 'Return a tool\'s input schema and its class (read or write).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string' },
    } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'call_tool',
    description: 'Run a READ agent-bot tool (search_tools/describe_tool to discover names and schemas).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string' },
      arguments: { type: 'object' },
    } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'call_write_tool',
    description: 'Run a WRITE agent-bot tool such as bind, take_notices, or request_grant.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string' },
      arguments: { type: 'object' },
    } },
    annotations: { readOnlyHint: false },
  },
];

// Extra read tools added for the meta-tool surface; their schemas live here so
// describe_tool stays accurate while tools/list shows only the four.
HIDDEN.set('doctor', {
  name: 'doctor',
  description: 'Machine and worktree readiness: overall status, the first failing check and its fix.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
});
HIDDEN.set('server_status', {
  name: 'server_status',
  description: 'Server-mode status: whether enrolled, the device id/name, approved harnesses, and the repo this checkout would mint for.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
});
const MACHINE_FIELDS = {
  name: { type: 'string', description: 'catalog app name' },
  option: { type: 'string', description: 'verb-specific option' },
  target: { type: 'string', description: 'verb-specific target' },
  plan_id: { type: 'string', description: 'plan id an apply refers back to' },
};
HIDDEN.set('machine_status', {
  name: 'machine_status',
  description: 'Agent-machine daemon status through the paired machine client (requires bind and machine pairing).',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
});
HIDDEN.set('machine_receipts', {
  name: 'machine_receipts',
  description: 'Agent-machine operation receipts for this machine.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
});
HIDDEN.set('machine_plan', {
  name: 'machine_plan',
  description: 'Ask agent-machine to plan a catalog operation; returns a plan id to apply.',
  inputSchema: { type: 'object', additionalProperties: false, properties: MACHINE_FIELDS },
});
HIDDEN.set('machine_apply', {
  name: 'machine_apply',
  description: 'Apply an agent-machine plan id.',
  inputSchema: { type: 'object', additionalProperties: false, properties: MACHINE_FIELDS },
});
HIDDEN.set('machine_update', {
  name: 'machine_update',
  description: 'Ask agent-machine to update a catalog app.',
  inputSchema: { type: 'object', additionalProperties: false, properties: MACHINE_FIELDS },
});
HIDDEN.set('guide', {
  name: 'guide',
  description: 'The bundled agent-bot skill text for a subcommand or topic; no topic returns the routing summary.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    topic: { type: 'string', description: 'an agent-bot subcommand or reference name (omit for the routing summary)' },
  } },
});

function mcpError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

function describeEntry(name) {
  const tool = HIDDEN.get(name);
  if (!tool) throw mcpError('unknown-tool', `unknown tool: ${name}`);
  return { name, desc: oneLine(tool.description ?? ''), class: TOOL_CLASS[name] ?? 'write', inputSchema: tool.inputSchema };
}

function searchTools(query) {
  const needle = (query ?? '').toLowerCase().trim();
  const entries = [...HIDDEN.keys()].filter((n) => !META_TOOLS.some((m) => m.name === n)).map((n) => describeEntry(n));
  if (needle === '') return entries.map(({ name, desc }) => ({ name, desc }));
  const words = needle.split(/[^a-z0-9_]+/i).filter(Boolean);
  const scored = entries.map((entry) => {
    const hay = `${entry.name} ${entry.desc}`.toLowerCase();
    const score = words.reduce((sum, w) => sum + (hay.includes(w) ? 1 : 0), 0)
      + (hay.includes(needle) ? 1 : 0)
      + (entry.name.toLowerCase().includes(needle) ? 2 : 0);
    return { entry, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return scored.map(({ entry }) => ({ name: entry.name, desc: entry.desc }));
}

function guideText(state, topic) {
  const root = dirname(fileURLToPath(import.meta.url));
  const skillDir = join(root, 'skills', 'agent-bot');
  if (!topic) {
    const main = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const start = main.indexOf('## Route the request');
    const end = main.indexOf('\n## ', start + 1);
    return { topic: null, reference: 'SKILL.md', text: end === -1 ? main.slice(start) : main.slice(start, end) };
  }
  const file = skillReferenceFor(topic);
  if (!file) {
    throw mcpError('unknown-topic',
      `no bundled reference for '${topic}' — --for knows: ${Object.keys(SKILL_REFERENCES).sort().join(', ')}`);
  }
  return { topic, reference: file, text: readFileSync(join(skillDir, 'references', file), 'utf8') };
}

function serverStatusReport(state) {
  const config = (() => { try { return loadConfig({ home: state.home, env: state.env }); } catch { return {}; } })();
  const base = serverUrl({ env: state.env, config });
  const device = loadDevice({ env: state.env, home: state.home });
  let repo = null;
  try {
    const remote = git(state.cwd, 'remote', 'get-url', 'origin');
    const m = remote.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (m) repo = `${m[1]}/${m[2]}`;
  } catch { repo = null; }
  return {
    server_mode: Boolean(base),
    base: base ?? null,
    enrolled: Boolean(device),
    device_id: device?.device_id ?? null,
    device_name: device?.device_name ?? null,
    approved_harnesses: device?.harnesses ?? [],
    repo,
  };
}

export function createMcpState({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  client = null,
} = {}) {
  return {
    env,
    home,
    cwd,
    client: client ?? daemonClient({ env, home, cwd }),
    // Held in memory for the life of this server process; never serialized.
    secret: null,
    agentId: null,
  };
}

// Stable take_inbox error codes (#299). The MCP tool surface returns only
// the message text to the agent, so the code is embedded as [code] as well
// as carried on error.code for programmatic use.
function inboxError(code, message, { cause = undefined } = {}) {
  return Object.assign(new Error(`${message} [${code}]`), { code, ...(cause === undefined ? {} : { cause }) });
}

// The bearer must never appear in an error, even when a lower layer echoes
// it. Strip it from any detail derived from the request or its failure.
function sanitizeInboxDetail(detail, token) {
  let out = String(detail ?? '');
  if (typeof token === 'string' && token !== '') out = out.split(token).join('[redacted]');
  return out;
}

function describeFetchCause(error) {
  const cause = error?.cause ?? error;
  const code = cause?.code ?? error?.code ?? null;
  const message = sanitizeInboxDetail(cause?.message ?? error?.message ?? 'network error');
  // AbortSignal.timeout rejects with a TimeoutError DOMException; undici
  // surfaces network failures as 'fetch failed' with the real reason in
  // error.cause. Name both so the operator can tell a hang from a refusal.
  if (error?.name === 'TimeoutError' || cause?.name === 'TimeoutError' || code === 'ABORT_ERR' || /timeout|aborted/i.test(message)) {
    return { kind: 'timeout', code: code ?? 'TimeoutError', message };
  }
  return { kind: 'network', code, message };
}

// A daemon failure as text: the MCP surface returns only error.message, so
// an undici cause (ECONNREFUSED behind 'fetch failed') must be in it.
function daemonDetail(error) {
  const cause = describeFetchCause(error);
  return `${cause.code ? `${cause.code}: ` : ''}${cause.message}`;
}

// Restore the in-memory secret from the worktree's binding file after an MCP
// restart (#299). The file is the durable binding; the token was single-use
// and is gone. Throws inbox-not-bound when there is nothing to restore, and
// inbox-daemon-unreachable when the daemon cannot validate it.
async function ensureTakeBinding(state) {
  if (state.secret) {
    try {
      return await state.client.binding(state.secret);
    } catch (error) {
      throw inboxError(
        'inbox-daemon-unreachable',
        `take_inbox failed: the daemon rejected the held binding (${daemonDetail(error)}); run \`agent-bot daemon status\`, then \`agent-bot doctor\`, and re-bind with the bind tool`,
        { cause: error },
      );
    }
  }
  let existing = null;
  try {
    existing = readBinding({ env: state.env, cwd: state.cwd });
  } catch (error) {
    throw inboxError(
      'inbox-daemon-unreachable',
      `take_inbox failed: the worktree binding could not be read (${sanitizeInboxDetail(error?.message ?? 'unknown error')}); run \`agent-bot doctor\`, then \`agent-bot setup-worktree\` if the binding is corrupt`,
      { cause: error },
    );
  }
  if (!existing) {
    throw inboxError(
      'inbox-not-bound',
      'take_inbox failed: not bound — call the bind tool first (a restarted MCP server re-binds automatically when the worktree binding file exists)',
    );
  }
  try {
    const binding = await state.client.binding(existing.secret);
    state.secret = existing.secret;
    state.agentId = binding.agentId;
    return binding;
  } catch (error) {
    throw inboxError(
      'inbox-daemon-unreachable',
      `take_inbox failed: the daemon rejected the worktree binding (${daemonDetail(error)}); run \`agent-bot daemon status\`, then re-bind with the bind tool or \`agent-bot setup-worktree\` for a fresh token`,
      { cause: error },
    );
  }
}

async function takeInbox(state) {
  const binding = await ensureTakeBinding(state);
  if (resolve(binding.worktree) !== resolve(state.cwd)) {
    throw inboxError(
      'inbox-wrong-worktree',
      'take_inbox failed: this server only serves its bound worktree; run the MCP server from the bound worktree',
    );
  }
  // The daemon holds the inbox bearer and names the App and repository from
  // the binding (#229); this process never sees the bearer.
  let result;
  try {
    result = await state.client.takeInbox(state.secret);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('inbox-') && error.detail) {
      throw inboxError(error.code, error.detail, { cause: error });
    }
    throw inboxError(
      'inbox-daemon-unreachable',
      `take_inbox failed: the daemon could not take from the inbox (${daemonDetail(error)}); run \`agent-bot daemon status\`, then \`agent-bot doctor\`, and retry`,
      { cause: error },
    );
  }
  return { event: result?.event ?? null };
}

// The App this session was explicitly run as (GH_AGENT_APP, else the
// checkout's pin), sent with a first bind so the daemon can reconcile the
// soul's record with it (#107). A claim the resolver rejects is not sent.
function claimedApp(state) {
  try { return resolveAgentSlug({ env: state.env, cwd: state.cwd, detect: false }); } catch { return null; }
}

// The daemon reconciled the soul's App with the one this session was run as
// (#107): the pin follows, so setup-worktree in this checkout can refresh the
// credential helper and commit attribution.
function repinApp(state, app) {
  if (app.status !== 'reconciled') return app;
  git(state.cwd, 'config', 'extensions.worktreeConfig', 'true');
  git(state.cwd, 'config', '--worktree', 'agentBot.app', app.claimed);
  return { ...app, next: 'run agent-bot setup-worktree in this checkout to commit as the reconciled App' };
}

async function callTool(state, name, args = {}) {
  switch (name) {
    case 'bind': {
      let existing = null;
      try {
        existing = readBinding({ env: state.env, cwd: state.cwd });
      } catch (error) {
        throw inboxError(
          'inbox-daemon-unreachable',
          `bind failed: the worktree binding could not be read (${sanitizeInboxDetail(error?.message ?? 'unknown error')}); run \`agent-bot doctor\`, then \`agent-bot setup-worktree\` if the binding is corrupt`,
          { cause: error },
        );
      }
      if (existing) {
        try {
          const binding = await state.client.binding(existing.secret);
          state.secret = existing.secret;
          state.agentId = binding.agentId;
          // A binding outlives its session, so a new session run as another
          // App reconciles here as a first bind would (#107). The binding is
          // live either way: a daemon that cannot reconcile leaves it as is.
          const claimed = claimedApp(state);
          if (!claimed) return binding;
          let app = null;
          try { ({ app = null } = await state.client.reconcileApp(existing.secret, claimed)); } catch { /* record unchanged */ }
          return app ? { ...binding, app: repinApp(state, app) } : binding;
        } catch (error) {
          // #1179: if a restarted daemon rejects the stale binding secret (403)
          // and `setup-worktree` has minted a fresh bind token, fall through to
          // surrender that token; otherwise tell the caller how to mint one.
          if (error?.statusCode === 403) {
            let freshToken = null;
            try { freshToken = readBindToken(git(state.cwd, 'rev-parse', '--absolute-git-dir')); } catch { freshToken = null; }
            if (!freshToken) {
              throw inboxError(
                'inbox-not-bound',
                'bind failed: the daemon rejected this worktree\'s existing binding (it may have restarted) — run `agent-bot setup-worktree` to mint a fresh bind token, then retry bind',
                { cause: error },
              );
            }
          } else {
            const cause = describeFetchCause(error);
            const safeMessage = sanitizeInboxDetail(cause.message ?? error?.message ?? 'unknown error');
            const causeCode = cause.code ? `${cause.code}: ` : '';
            throw inboxError(
              'inbox-daemon-unreachable',
              `bind failed: the daemon is unreachable to re-bind this worktree (${causeCode}${safeMessage}); run \`agent-bot daemon status\` and \`agent-bot doctor\`, then retry`,
              { cause: error },
            );
          }
        }
      }
      if (typeof args.transcript_id !== 'string' || args.transcript_id === '') {
        throw new Error('bind requires transcript_id');
      }
      const gitDir = git(state.cwd, 'rev-parse', '--absolute-git-dir');
      const record = readBindToken(gitDir);
      if (!record) {
        throw new Error('no bind token is minted for this worktree — run `agent-bot setup-worktree` first');
      }
      const result = await state.client.bind({
        gitDir,
        token: record.token,
        transcript: {
          provider: args.transcript_provider ?? detectAgentHarness(state.env) ?? 'custom',
          id: args.transcript_id,
        },
        parentId: args.parent_agent_id ?? null,
        app: claimedApp(state),
      });
      state.secret = result.secret;
      state.agentId = result.agentId;
      // The reuse policy may have resolved a different identity than the
      // token's original pin (a later conversation reusing the worktree);
      // repinning here keeps commits and binding attributing identically.
      if (result.repinRequired) {
        git(state.cwd, 'config', 'extensions.worktreeConfig', 'true');
        git(state.cwd, 'config', '--worktree', 'agentBot.agentId', result.agentId);
      }
      if (result.app) result.app = repinApp(state, result.app);
      const { secret, ...safe } = result;
      return safe;
    }
    case 'whoami': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      return state.client.binding(state.secret);
    }
    case 'population': {
      const souls = await state.client.population({
        status: typeof args.status === 'string' ? args.status : null,
        app: typeof args.app === 'string' ? args.app : null,
      });
      return { souls };
    }
    case 'space_path': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      const binding = await state.client.binding(state.secret);
      return state.client.spacePath(binding.agentId);
    }
    case 'credential': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      // Members get credential references only (#1184 goal): a token in a
      // tool result would enter the model's context. git and gh resolve a
      // fresh credential per operation through the helper and the shim.
      const grant = await state.client.credential(state.secret);
      return {
        agentId: grant.agentId, appSlug: grant.appSlug, credential_ref: grant.credential_ref ?? null,
        task_id: grant.task_id ?? null, operation_id: grant.operation_id ?? null, expires_at: grant.expires_at,
        use: 'git and gh in this worktree authenticate as the bot per operation; no token is handed to you',
      };
    }
    case 'take_inbox':
      return takeInbox(state, args);
    case 'take_notices':
    case 'peek_notices':
    case 'ack_notices':
    case 'release_notices': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      try {
        return await state.client.notices(state.secret, name.slice(0, -'_notices'.length), args ?? {});
      } catch (error) {
        throw new Error(`${name} failed: ${daemonDetail(error)}`, { cause: error });
      }
    }
    case 'request_grant':
    case 'spend_grant': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      try {
        return name === 'request_grant'
          ? await state.client.requestGrant(state.secret, args.operation)
          : await state.client.spendGrant(state.secret, args.proposal_id, args.operation);
      } catch (error) {
        // The daemon's sentence and code; neither carries a credential.
        if (typeof error?.code === 'string' && error.detail) throw new Error(`${error.detail} [${error.code}]`);
        throw error;
      }
    }
    case 'doctor': {
      const root = dirname(fileURLToPath(import.meta.url));
      let out = null;
      try {
        out = execFileSync(process.execPath, [join(root, 'doctor.mjs'), '--json', '--no-verify-apps'],
          { env: state.env, cwd: state.cwd, encoding: 'utf8', timeout: 30000 });
      } catch (error) {
        // doctor exits non-zero when the machine is not ready but still prints
        // the JSON report — read it from the failed spawn's stdout.
        out = typeof error?.stdout === 'string' ? error.stdout : null;
        if (out === null) {
          throw mcpError('doctor-unavailable', `doctor failed: ${error?.message ?? 'unknown'}`);
        }
      }
      let report;
      try {
        report = JSON.parse(out);
      } catch (error) {
        throw mcpError('doctor-unavailable', `doctor failed: unreadable report (${error?.message ?? 'unknown'})`);
      }
      return {
        ready: report.ready ?? null,
        first_actionable_failure: report.first_actionable_failure ?? null,
        machine: report.machine ?? null,
        worktree: report.worktree ?? null,
      };
    }
    case 'machine_status':
    case 'machine_receipts':
    case 'machine_plan':
    case 'machine_apply':
    case 'machine_update': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      const verb = name.slice('machine_'.length);
      const { name: appName, option, target, plan_id } = args ?? {};
      try {
        return await state.client.machine(state.secret, {
          verb,
          ...(appName !== undefined ? { name: appName } : {}),
          ...(option !== undefined ? { option } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(plan_id !== undefined ? { plan_id } : {}),
        });
      } catch (error) {
        throw new Error(`${name} failed: ${error.detail ?? error.message}`, { cause: error });
      }
    }
    case 'server_status':
      return serverStatusReport(state);
    case 'guide':
      return guideText(state, typeof args.topic === 'string' ? args.topic : null);
    default:
      throw mcpError('unknown-tool', `unknown tool: ${name}`);
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// One message in, at most one message out. Notifications (no id) return null.
export async function handleMcpMessage(state, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return rpcError(null, -32600, 'invalid request');
  }
  const { id = null, method, params = {} } = message;
  const isNotification = !('id' in message);
  // JSON-RPC: a notification executes but never gets a response — including
  // for known methods, so a ping without an id must not produce an id:null
  // reply the client would treat as an unmatched response.
  const reply = (payload) => (isNotification ? null : payload);
  try {
    switch (method) {
      case 'initialize':
        return reply(rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-bot', version: serverVersion() },
          instructions:
            `agent-bot local MCP v${serverVersion()}. On a server-mode machine git/gh mint tokens `
            + 'through the credential helper and gh shim — never pass-cli or ensure-private-key. '
            + 'Use search_tools to find tools, describe_tool for a schema, call_tool for reads, '
            + 'call_write_tool for writes. Start a conversation with call_write_tool bind '
            + '(or `agent-bot join` first when no bind token exists). Ask guide for more.',
        }));
      case 'ping':
        return reply(rpcResult(id, {}));
      case 'tools/list':
        return reply(rpcResult(id, { tools: META_TOOLS }));
      case 'tools/call': {
        try {
          const name = params.name;
          const args = params.arguments ?? {};
          if (name === 'search_tools') {
            return reply(rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(searchTools(args.query), null, 2) }] }));
          }
          if (name === 'describe_tool') {
            const d = describeEntry(args.name);
            return reply(rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ name: d.name, desc: d.desc, class: d.class, inputSchema: d.inputSchema }, null, 2) }] }));
          }
          if (name === 'call_tool' || name === 'call_write_tool') {
            const target = HIDDEN.get(args.name);
            if (!target) throw mcpError('unknown-tool', `unknown tool: ${args.name}`);
            const cls = TOOL_CLASS[args.name] ?? 'write';
            if (name === 'call_tool' && cls !== 'read') throw mcpError('use-call-write-tool', `${args.name} is a write tool — run it through call_write_tool`);
            if (name === 'call_write_tool' && cls !== 'write') throw mcpError('use-call-tool', `${args.name} is a read tool — run it through call_tool`);
            const result = await callTool(state, args.name, args.arguments ?? {});
            return reply(rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }));
          }
          const result = await callTool(state, name, args);
          return reply(rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }));
        } catch (error) {
          // Tool failures are results, not protocol errors (MCP contract):
          // the agent should read the message and adapt.
          return reply(rpcResult(id, {
            content: [{ type: 'text', text: error.message }],
            isError: true,
          }));
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (error) {
    if (isNotification) return null;
    return rpcError(id, -32603, error.message);
  }
}

export function runMcpServer({ state = createMcpState(), input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  // readline fires 'line' without awaiting the async handler, so 'close' can
  // arrive while the final message — possibly the bind itself — is still in
  // flight. Track every handler and drain the set before releasing, or a bind
  // that completes after EOF would install a secret nobody ever surrenders.
  const inFlight = new Set();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    const task = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
        return;
      }
      const response = await handleMcpMessage(state, message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    })();
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  });
  return new Promise((resolve) => {
    lines.on('close', async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().catch((error) => {
    process.stderr.write(`agent-mcp: ${error.message}\n`);
    process.exit(1);
  });
}
