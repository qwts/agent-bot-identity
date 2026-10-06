// A soul starts its own team (#377): new full souls, each with its own soul
// directory, identity, and inbox, that the census records under the soul
// that started them. They are not harness subagents. The reach server's
// `start_soul` tool asks the daemon; every rule lives here, in the daemon,
// so no tool, prompt, or harness can widen it.
//
//   - The caller is the binding that authenticated the request. It can only
//     start souls as itself; the request cannot name another parent.
//   - A parent may have at most `maxChildren` active children, and a team
//     may nest at most `maxDepth` levels below its root soul.
//   - The harness must be enabled in the ACP registry and launchable on this
//     host.
//   - The launch itself is the daemon's principal launch path (#295), with
//     the caller recorded as parent; comms default on as for any launch.
//   - Every attempt, refused or not, leaves an audit receipt naming the
//     caller and the decision, never the name, template path, or brief.

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ACP_SPAWN_REGISTRY, HARNESS_KEY_PATTERN, onPath } from './acp-registry.mjs';
import { LAUNCH_NAME_MAX } from './daemon-launch.mjs';
import { bundledStarter } from './soul-templates.mjs';

export const TEAM_DEFAULTS = Object.freeze({ maxChildren: 5, maxDepth: 2 });
// A parent chain longer than this is corrupt; refuse rather than walk it.
const MAX_CHAIN = 64;

export class TeamStartError extends Error {
  constructor(message, { statusCode = 400, decision = 'refused: invalid request' } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.decision = decision;
  }
}

/**
 * Team limits from the user config (`"teams": { "maxChildren": N,
 * "maxDepth": N }`), each a small positive integer, else the defaults.
 */
export function teamLimits(config = {}) {
  const teams = config?.teams ?? {};
  const pick = (key) => {
    const value = teams[key];
    return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : TEAM_DEFAULTS[key];
  };
  return { maxChildren: pick('maxChildren'), maxDepth: pick('maxDepth') };
}

/**
 * Why the daemon cannot start a soul on this harness here, or null when it
 * can: an enabled registry row whose command is on PATH (or absolute), or
 * whose ACP adapter installs into the soul home (soulBin) and runs on the
 * bundled Node. A refusal names the missing command and how to install it
 * (#418).
 */
export function harnessLaunchProblem(harness, { registry = ACP_SPAWN_REGISTRY, env = process.env } = {}) {
  const row = registry[harness];
  if (!row) return 'agent-bot has no such harness';
  if (row.enabled !== true) return 'it is disabled in agent-bot';
  if (row.soulBin || onPath(row.command, env) || path.isAbsolute(row.command)) return null;
  return `the \`${row.command}\` command is not on this host's PATH (${(env.PATH ?? '').split(path.delimiter).filter(Boolean).join(', ') || 'empty'})`
    + (row.installHint ? `; ${row.installHint}` : '');
}

/** Whether the daemon can start a soul on this harness (see harnessLaunchProblem). */
export function harnessLaunchable(harness, options = {}) {
  return harnessLaunchProblem(harness, options) === null;
}

/**
 * The template a new teammate starts from when the caller names none: the
 * owner's configured default (`"teams": { "template": PATH }`), else the
 * Starter this install ships (the same one `agent-bot join` uses). Null when
 * there is none.
 */
export async function defaultTeamTemplate({ config = {}, env = process.env,
  starter = () => bundledStarter({ env }) } = {}) {
  const configured = config?.teams?.template;
  if (typeof configured === 'string' && path.isAbsolute(configured)) return configured;
  return starter();
}

/**
 * `souls()` lists active census rows ({ id, parentId }); `identities(id)`
 * reads an identity ({ harness }); `launch(event)` runs the daemon's launch
 * handler and resolves { status, agentId, detail }; `receipt(...)` writes
 * the audit line.
 */
export function createTeamStarter({
  souls, identities, launch, receipt, limits = TEAM_DEFAULTS, launchable = (harness) => harnessLaunchProblem(harness) ?? true,
  template = () => null, account = process.env.USER ?? 'unknown',
}) {
  // Starts run one at a time, so two concurrent requests cannot both pass
  // the child cap before either child is recorded.
  let queue = Promise.resolve();

  const depthOf = (agentId, rows) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    let depth = 0;
    let current = byId.get(agentId)?.parentId ?? null;
    while (current) {
      depth += 1;
      if (depth > MAX_CHAIN) throw new TeamStartError('team parent chain is too long', { decision: 'refused: depth' });
      current = byId.get(current)?.parentId ?? null;
    }
    return depth;
  };

  const attempt = async (caller, request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TeamStartError('request must be an object');
    const { name, harness: requestedHarness = null, template: requestedTemplate = null, parent } = request;
    if (parent !== undefined && parent !== null && parent !== caller) {
      throw new TeamStartError('a soul can only start souls as itself', { statusCode: 403, decision: 'refused: not self' });
    }
    if (typeof name !== 'string' || !name.trim() || name.length > LAUNCH_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new TeamStartError(`name must be 1-${LAUNCH_NAME_MAX} printable characters`);
    }
    const harness = requestedHarness ?? identities(caller)?.harness ?? null;
    if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) {
      throw new TeamStartError('name a harness: the caller has none recorded', { decision: 'refused: harness' });
    }
    // launchable() answers true, or false or the reason it cannot (#418).
    const ready = launchable(harness);
    if (ready !== true) {
      throw new TeamStartError(`harness '${harness}' is not launchable on this host${typeof ready === 'string' ? `: ${ready}` : ''}`,
        { decision: 'refused: harness' });
    }
    const packagePath = requestedTemplate ?? await template();
    if (typeof packagePath !== 'string' || !path.isAbsolute(packagePath)) {
      throw new TeamStartError(requestedTemplate === null
        ? 'no default soul template on this host: pass template as an absolute path'
        : 'template must be an absolute path', { decision: 'refused: template' });
    }
    const rows = souls();
    const children = rows.filter((row) => row.parentId === caller).length;
    if (children >= limits.maxChildren) {
      throw new TeamStartError(`you already have ${children} active teammates you started (limit ${limits.maxChildren})`,
        { statusCode: 429, decision: 'refused: child cap' });
    }
    if (depthOf(caller, rows) + 1 > limits.maxDepth) {
      throw new TeamStartError(`a team nests at most ${limits.maxDepth} levels below its root soul`,
        { statusCode: 403, decision: 'refused: depth' });
    }
    const outcome = await launch({
      requestId: `team_${randomUUID()}`, account, package: packagePath, harness, name: name.trim(), parent: caller,
    });
    if (outcome?.status !== 'launched' || !outcome.agentId) {
      throw new TeamStartError(outcome?.detail ?? 'launch failed', { statusCode: 502, decision: 'failed' });
    }
    return { agentId: outcome.agentId, name: name.trim(), harness, parent: caller };
  };

  return function start(caller, request) {
    const run = queue.then(async () => {
      try {
        const result = await attempt(caller, request);
        receipt({ agentId: caller, decision: 'launched' });
        return result;
      } catch (error) {
        receipt({ agentId: caller, decision: error instanceof TeamStartError ? error.decision : 'failed' });
        throw error instanceof TeamStartError ? error : new TeamStartError(error.message, { statusCode: 502, decision: 'failed' });
      }
    });
    queue = run.catch(() => {});
    return run;
  };
}
