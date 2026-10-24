#!/usr/bin/env node

// Sanctioned CLI path to a live session binding for harnesses without
// MCP `bind` (#1170). It performs the same surrender as the MCP tool:
// read this worktree's single-use bind token, exchange it at the daemon,
// and report only the resulting identity. The binding secret stays in
// the private git dir (written by the daemon) and is never printed.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { readBinding, readBindToken, resolveAgentSlug } from './identity-cli.mjs';
import { daemonClient } from './daemon-client.mjs';
import { detectAgentHarness } from './detect-harness.mjs';

export const SESSION_BIND_USAGE = `usage: agent-bot session bind [--transcript-id ID] [--provider NAME] [--parent-agent-id ID] [--json]

Establish (or verify) this worktree's live session binding without MCP.
With an existing binding this validates it at the daemon and needs no
transcript id. Without one, --transcript-id identifies this conversation
to its harness, exactly as the MCP bind tool requires.
`;

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
} = {}) {
  const client = await clientFactory({ env, home: env.HOME, cwd });

  let existing = null;
  try {
    existing = readBindingImpl({ env, cwd });
  } catch {
    throw new Error('the soul binding in this checkout is unreadable — run `agent-bot doctor`, then `agent-bot setup-worktree` if it is corrupt');
  }
  if (existing) {
    // Already bound: validate at the daemon (no secret leaves this process).
    const binding = await client.binding(existing.secret);
    return {
      status: 'live',
      alreadyBound: true,
      agentId: binding.agentId,
      worktree: binding.worktree ?? cwd,
    };
  }

  if (!transcriptId) {
    throw new Error('--transcript-id is required when no live session binding exists yet (or bind with the MCP bind tool)');
  }
  const gitDir = gitDirImpl(cwd);
  const record = readBindTokenImpl(gitDir);
  if (!record) {
    throw new Error('no bind token is minted for this worktree — run `agent-bot setup-worktree` first');
  }
  const result = await client.bind({
    gitDir,
    token: record.token,
    transcript: { provider: provider ?? detectAgentHarness(env) ?? 'custom', id: transcriptId },
    parentId: parentAgentId,
    app: resolveSlugImpl(env, cwd),
  });
  // The daemon may repin attribution; mirror the MCP tool's follow-up.
  if (result.repinRequired) {
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd });
    execFileSync('git', ['config', '--worktree', 'agentBot.agentId', result.agentId], { cwd });
  }
  if (result.app?.status === 'reconciled') {
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd });
    execFileSync('git', ['config', '--worktree', 'agentBot.app', result.app.claimed], { cwd });
  }
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
