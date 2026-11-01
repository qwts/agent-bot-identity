#!/usr/bin/env node

// Sanctioned CLI path to a live session binding for harnesses without
// MCP `bind` (#1170). It performs the same surrender as the MCP tool:
// read this worktree's single-use bind token, exchange it at the daemon,
// and report only the resulting identity. The binding secret stays in
// the private git dir (written by the daemon) and is never printed.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { discoverTranscript, readBinding, readBindToken, resolveAgentSlug } from './identity-cli.mjs';
import { daemonClient } from './daemon-client.mjs';
import { detectAgentHarness, detectHarness } from './detect-harness.mjs';

export const SESSION_BIND_USAGE = `usage: agent-bot session bind [--transcript-id ID] [--provider NAME] [--parent-agent-id ID] [--json]

Establish (or verify) this worktree's live session binding without MCP.
With an existing binding this validates it at the daemon and needs no
transcript id. Without one, the conversation is named by --transcript-id,
else by the harness: CODEX_THREAD_ID, CLAUDE_SESSION_ID,
CURSOR_CONVERSATION_ID, QWEN_CODE_SESSION_ID, a lifecycle hook's session
id, or Devin's session list when it names exactly one session for this
worktree.
`;

const NO_TRANSCRIPT = '--transcript-id is required: no session id was found for this conversation '
  + '(run `agent-bot session bind --transcript-id <session-id>` in a plain shell, '
  + 'Qwen Code exports QWEN_CODE_SESSION_ID; for Devin, run `devin list --format json` in the directory '
  + 'the session started in), or bind with the MCP bind tool';

// Devin exports no session id, so its list is the only witness: the ids it
// shows for exactly this worktree, the same lookup a resume wake uses.
async function listDevinSessions(cwd, env) {
  const { RESUME_HARNESSES } = await import('./wake-resume.mjs');
  const row = RESUME_HARNESSES.devin;
  try {
    const stdout = execFileSync(row.command, row.listArgs, {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    });
    return row.sessionsIn(stdout, cwd);
  } catch {
    return null;
  }
}

// Where this conversation's id comes from when no flag names it (#1275):
// the harness's own environment, then the lifecycle hook payload's session
// id, then (Devin only) a session list naming exactly one session for this
// worktree. More than one listed session is ambiguous and finds nothing.
export async function findTranscript({ env = process.env, cwd = process.cwd(), listDevinSessionsImpl = listDevinSessions } = {}) {
  const native = discoverTranscript(env);
  if (native) return native;
  const harness = detectHarness(env);
  if (env.AGENT_HOOK_SESSION_ID) {
    return { provider: harness ?? env.AGENT_HOOK_HARNESS ?? 'custom', id: env.AGENT_HOOK_SESSION_ID };
  }
  if (harness === 'devin') {
    const ids = await listDevinSessionsImpl(cwd, env);
    if (Array.isArray(ids) && ids.length === 1) return { provider: 'devin', id: ids[0] };
  }
  return null;
}

export function parseSessionBindArgs(argv = []) {
  const options = { help: false, json: false, transcriptId: null, provider: null, parentAgentId: null };
  if (argv.length === 0 || argv[0] !== 'bind') throw new Error(SESSION_BIND_USAGE.trimEnd());
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--transcript-id' || arg === '--provider' || arg === '--parent-agent-id') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--transcript-id') options.transcriptId = value;
      if (arg === '--provider') options.provider = value;
      if (arg === '--parent-agent-id') options.parentAgentId = value;
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function gitDirFor(cwd) {
  return execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function claimedApp(env, cwd) {
  try { return resolveAgentSlug({ env, cwd, detect: false }); } catch { return null; }
}

function repin(cwd, key, value) {
  execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd });
  execFileSync('git', ['config', '--worktree', key, value], { cwd });
}

export async function sessionBind({
  cwd = process.cwd(),
  env = process.env,
  transcriptId = null,
  provider = null,
  parentAgentId = null,
  clientFactory = async (options) => daemonClient(options),
  readBindingImpl = readBinding,
  readBindTokenImpl = readBindToken,
  gitDirImpl = gitDirFor,
  resolveSlugImpl = claimedApp,
  repinImpl = repin,
  findTranscriptImpl = findTranscript,
} = {}) {
  const client = await clientFactory({ env, home: env.HOME, cwd });

  let existing = null;
  try {
    existing = readBindingImpl({ env, cwd });
  } catch {
    throw new Error('the soul binding in this checkout is unreadable — run `agent-bot doctor`, then `agent-bot setup-worktree` if it is corrupt');
  }
  if (existing) {
    // Already bound: validate at the daemon (no secret leaves this process),
    // then reconcile a differently selected App exactly as MCP bind does —
    // a binding outlives its session, so a session run as another App
    // reconciles here as a first bind would (#107). Without this the daemon
    // keeps minting the previously recorded App and the newly selected slug
    // is refused as an identity crossover. When a restarted daemon rejects
    // the stale binding secret (403) and `setup-worktree` has minted a fresh
    // bind token, fall through to surrender that token (#1179).
    let binding = null;
    try {
      binding = await client.binding(existing.secret);
    } catch (error) {
      if (error?.statusCode !== 403) throw error;
      let hasFreshToken = false;
      try { hasFreshToken = Boolean(readBindTokenImpl(gitDirImpl(cwd))); } catch { hasFreshToken = false; }
      if (!hasFreshToken) {
        throw new Error(
          'the daemon rejected this worktree\'s existing binding (it may have restarted) — '
          + 'run `agent-bot setup-worktree` to mint a fresh bind token, then re-run `agent-bot session bind`',
        );
      }
    }
    if (binding) {
      const result = {
        status: 'live',
        alreadyBound: true,
        agentId: binding.agentId,
        worktree: binding.worktree ?? cwd,
      };
      const claimed = resolveSlugImpl(env, cwd);
      if (claimed && typeof client.reconcileApp === 'function') {
        let app = null;
        try { ({ app = null } = await client.reconcileApp(existing.secret, claimed)); } catch { /* record unchanged */ }
        if (app) {
          result.app = app.status === 'reconciled'
            ? (repinImpl(cwd, 'agentBot.app', app.claimed),
              { ...app, next: 'run agent-bot setup-worktree in this checkout to commit as the reconciled App' })
            : app;
        }
      }
      return result;
    }
  }

  let transcript = transcriptId
    ? { provider: provider ?? detectAgentHarness(env) ?? 'custom', id: transcriptId }
    : await findTranscriptImpl({ env, cwd });
  if (!transcript) throw new Error(NO_TRANSCRIPT);
  if (provider) transcript = { ...transcript, provider };
  const gitDir = gitDirImpl(cwd);
  const record = readBindTokenImpl(gitDir);
  if (!record) {
    throw new Error('no bind token is minted for this worktree — run `agent-bot setup-worktree` first');
  }
  const result = await client.bind({
    gitDir,
    token: record.token,
    transcript,
    parentId: parentAgentId,
    app: resolveSlugImpl(env, cwd),
    expectedAgentId: env.AGENT_BOT_ID ?? env.QWTS_AGENT_ID ?? null,
  });
  // The daemon may repin attribution; mirror the MCP tool's follow-up.
  if (result.repinRequired) repinImpl(cwd, 'agentBot.agentId', result.agentId);
  if (result.app?.status === 'reconciled') repinImpl(cwd, 'agentBot.app', result.app.claimed);
  const { secret, ...safe } = result;
  return { status: 'live', alreadyBound: false, ...safe };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSessionBindArgs(argv);
  if (options.help) {
    process.stdout.write(SESSION_BIND_USAGE);
    return;
  }
  const result = await sessionBind(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, command: 'session bind', ...result })}\n`);
  } else if (result.alreadyBound) {
    process.stdout.write(`live session binding: present (agent ${result.agentId})\n`);
  } else {
    process.stdout.write(`live session binding: established (agent ${result.agentId})\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`session bind: ${error.message}\n`);
    process.exit(1);
  });
}
