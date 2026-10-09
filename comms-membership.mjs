// agent-comms membership for a launched soul (#645 step 3b): joining and
// leaving the hub as the soul itself. Moved out of the agent-daemon process
// host so soul modules can call it; agent-daemon.mjs re-exports both.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';

import { soulEnvironment } from './shell-path.mjs';

/**
 * Joins a launched soul to agent-comms as itself, with the soul's binding and
 * the environment its harness gets, before its first turn (R4). Resolves to
 * the soul's address; a failed join fails the launch with agent-comms' own
 * message.
 */
export function joinLaunchedSoul({ agentId, harness, name, binding, parent = null }, { env = process.env, run = execFile } = {}) {
  const args = ['join', '--harness', harness, ...(name ? ['--name', name] : []), ...(parent ? ['--parent', parent] : [])];
  const soulEnv = { ...soulEnvironment(env), AGENT_BOT_BINDING: binding.file, AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId };
  return new Promise((resolve, reject) => {
    run('agent-comms', args, { cwd: binding.worktree, env: soulEnv, timeout: 30_000 }, (error, stdout = '', stderr = '') => {
      let result = null;
      try { result = JSON.parse(String(stdout)); } catch {}
      if (!error && result?.ok === true) return resolve(result.address ?? null);
      const detail = result?.error?.message ?? (String(stderr).trim().split('\n').pop() || error?.message || 'no result');
      reject(new Error(`joining agent-comms failed: ${detail}`));
    });
  });
}

/**
 * Takes a soul out of agent-comms as itself (#419), the reverse of
 * joinLaunchedSoul. With the daemon's binding the request is vouched; without
 * one (`soul remove` from the CLI) it names the soul by ID, as an unbound
 * session would. A soul the hub never joined, or one that already left,
 * counts as left. Resolves to true, or rejects with agent-comms' message.
 */
export function leaveLaunchedSoul({ agentId, binding = null }, { env = process.env, run = execFile, cwd = tmpdir() } = {}) {
  const { AGENT_BOT_BINDING: _binding, ...rest } = soulEnvironment(env);
  const soulEnv = { ...rest, ...(binding?.file ? { AGENT_BOT_BINDING: binding.file } : {}), AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId };
  const where = binding?.worktree && existsSync(binding.worktree) ? binding.worktree : cwd;
  return new Promise((resolve, reject) => {
    run('agent-comms', ['leave'], { cwd: where, env: soulEnv, timeout: 30_000 }, (error, stdout = '', stderr = '') => {
      let result = null;
      try { result = JSON.parse(String(stdout)); } catch {}
      if (!error && result?.ok === true) return resolve(true);
      if (result?.error?.code === 'not-joined') return resolve(true);
      const detail = result?.error?.message ?? (String(stderr).trim().split('\n').pop() || error?.message || 'no result');
      reject(new Error(`leaving agent-comms failed: ${detail}`));
    });
  });
}
