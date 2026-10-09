// A soul starts its own team (#377): new full souls, each with its own soul
// directory, identity, and inbox, that the census records under the soul
// that started them. They are not harness subagents. The reach server's
// `start_soul` tool asks the daemon; every rule lives here, in the daemon,
// so no tool, prompt, or harness can widen it.
//
//   - The caller is the binding that authenticated the request. It can only
//     start souls as itself (the default) or as independent root souls with
//     no parent at all (`parent: "none"`, GeniusBar#261); the request cannot
//     name another soul as parent.
//   - A parent may have at most `maxChildren` active children, and a team
//     may nest at most `maxDepth` levels below its root soul. An independent
//     start is counted against the caller's cap and depth all the same.
//   - The harness must be enabled in the ACP registry and launchable on this
//     host.
//   - A requested `model` is validated before anything is minted: a printable
//     model id, and one the caller's own harness has listed as available when
//     the new soul runs on that same harness and the list is known. It is
//     carried in the launch event and persisted by `recordLaunchSettings`,
//     never replaced by the harness default. A requested `provider` must be
//     an id the harness knows (`providerIds`) and the one the template's
//     soul.json gives that harness (else the harness's built-in provider):
//     the engine selects providers from the template, so a different one is
//     refused with the fix, never substituted.
//   - The launch itself is the daemon's principal launch path (#295), with
//     the caller recorded as parent (or none); comms default on as for any
//     launch.
//   - Every attempt, refused or not, leaves an audit receipt naming the
//     caller and the decision, never the name, template path, or brief.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ACP_SPAWN_REGISTRY, HARNESS_KEY_PATTERN, executableFile, onPath } from './acp-registry.mjs';
import { LAUNCH_NAME_MAX } from './daemon-launch.mjs';
import { validateModelId } from './soul-model.mjs';
import { PROVIDERS, declaredProviders, providerIds } from './soul-providers.mjs';
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
 * can: an enabled registry row whose command is an executable file on PATH
 * (or at its absolute path), or
 * whose ACP adapter installs into the soul home (soulBin) and runs on the
 * bundled Node. A refusal names the missing command and how to install it
 * (#418), with a stable code a launcher can act on without reading the
 * message (#536): `harness-unknown`, `harness-disabled` or
 * `harness-tool-missing`.
 */
export function harnessLaunchRefusal(harness, { registry = ACP_SPAWN_REGISTRY, env = process.env, declared = false } = {}) {
  const row = registry[harness];
  if (!row) return { code: 'harness-unknown', message: 'agent-bot has no such harness' };
  if (row.enabled !== true) return { code: 'harness-disabled', message: 'it is disabled in agent-bot' };
  // `declared`: the soul's soul.json pins a download for this harness (#583
  // slice 3), which the launch installs into the soul before it starts.
  if (row.soulBin || declared || onPath(row.command, env) || executableFile(row.command)) return null;
  if (path.isAbsolute(row.command)) return { code: 'harness-tool-missing', message: `\`${row.command}\` is not an executable file on this host` };
  return { code: 'harness-tool-missing',
    message: `the \`${row.command}\` command is not on this host's PATH (${(env.PATH ?? '').split(path.delimiter).filter(Boolean).join(', ') || 'empty'})`
      + (row.installHint ? `; ${row.installHint}` : '') };
}

/** The refusal's message alone (see harnessLaunchRefusal), or null. */
export function harnessLaunchProblem(harness, options = {}) {
  return harnessLaunchRefusal(harness, options)?.message ?? null;
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
 * The provider id a template's soul.json declares for a harness
 * (`harnesses.<harness>.provider.id`), or null when it declares none or the
 * manifest cannot be read: a bad template fails later, at the launch's own
 * package validation, with its own message.
 */
export function templateProviderId(packagePath, harness) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(packagePath, 'soul.json'), 'utf8'));
    return declaredProviders(manifest).providers[harness]?.id ?? null;
  } catch { return null; }
}

/**
 * The provider a soul on `harness` effectively runs on: the one its template
 * declares, else the harness's built-in provider (`default` in PROVIDERS),
 * else null for a harness without selectable providers.
 */
export function effectiveProvider(harness, declared = null) {
  if (declared) return declared;
  const ids = PROVIDERS[harness]?.ids ?? {};
  return Object.keys(ids).find((id) => ids[id].default === true) ?? null;
}

const describeModels = (list) => list.map((entry) => entry.modelId).join(', ');

/**
 * `souls()` lists active census rows ({ id, parentId }); `identities(id)`
 * reads an identity ({ harness }); `launch(event)` runs the daemon's launch
 * handler and resolves { status, agentId, detail }; `receipt(...)` writes
 * the audit line; `models(id)` reads a soul's model setting ({ available })
 * as `soulModel` does, or null; `templateProvider(package, harness)` reads
 * the template's declared provider id for the harness, or null.
 */
export function createTeamStarter({
  souls, identities, launch, receipt, limits = TEAM_DEFAULTS, launchable = (harness) => harnessLaunchProblem(harness) ?? true,
  template = () => null, account = process.env.USER ?? 'unknown', models = () => null, templateProvider = templateProviderId,
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

  // `parent`: absent or the caller itself starts a teammate under the
  // caller; null or "none" starts an independent root soul with no parent
  // (GeniusBar#261). Any other value names another soul, which is refused.
  const parentOf = (caller, parent) => {
    if (parent === undefined || parent === 'self' || parent === caller) return caller;
    if (parent === null || parent === 'none') return null;
    throw new TeamStartError('a soul can only start souls as itself or with no parent', { statusCode: 403, decision: 'refused: not self' });
  };

  // The model the new soul runs, validated before anything is minted: a
  // printable model id, and when the new soul runs on the caller's own
  // harness and that harness has listed its models to the caller, one of
  // them. Returns undefined when none was requested (the harness default).
  const modelOf = (caller, harness, callerHarness, model) => {
    if (model === undefined || model === null) return undefined;
    try { validateModelId(model); }
    catch (error) { throw new TeamStartError(`model: ${error.message}`, { decision: 'refused: model' }); }
    const available = harness === callerHarness ? models(caller)?.available : null;
    if (Array.isArray(available) && available.length && !available.some((entry) => entry?.modelId === model)) {
      throw new TeamStartError(`model '${model}' is not one the ${harness} harness listed as available (${describeModels(available)}); `
        + 'pass one of those ids, or omit model for the harness default', { decision: 'refused: model' });
    }
    return model;
  };

  // The provider the new soul's harness talks to. The engine selects it from
  // the template's soul.json (`harnesses.<harness>.provider`, #583 slice 4),
  // so a request may only confirm that selection: an unknown id, a harness
  // without providers, or a different id than the template's is refused
  // with the fix, never replaced. Returns the effective provider id.
  const providerOf = (harness, packagePath, provider) => {
    const effective = effectiveProvider(harness, templateProvider(packagePath, harness));
    if (provider === undefined || provider === null) return effective;
    if (typeof provider !== 'string' || !provider.trim()) throw new TeamStartError('provider must be a provider id', { decision: 'refused: provider' });
    const ids = providerIds(harness);
    if (!ids.length) {
      throw new TeamStartError(`harness '${harness}' has no selectable providers; omit provider, or start on one of ${Object.keys(PROVIDERS).join(', ')}`,
        { decision: 'refused: provider' });
    }
    if (!ids.includes(provider)) {
      throw new TeamStartError(`provider '${provider}' is not one the ${harness} harness knows (${ids.join(', ')})`, { decision: 'refused: provider' });
    }
    if (provider !== effective) {
      throw new TeamStartError(`provider '${provider}' is not selectable at launch: the ${harness} harness takes its provider from the soul template's `
        + `soul.json (harnesses.${harness}.provider), and ${packagePath} gives ${effective ?? 'none'}; pass a template that declares `
        + `provider '${provider}' (with its credential), or omit provider to run on ${effective ?? 'the harness default'}`, { decision: 'refused: provider' });
    }
    return provider;
  };

  const attempt = async (caller, request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TeamStartError('request must be an object');
    const { name, harness: requestedHarness = null, template: requestedTemplate = null, parent: requestedParent, model: requestedModel,
      provider: requestedProvider } = request;
    const parent = parentOf(caller, requestedParent);
    if (typeof name !== 'string' || !name.trim() || name.length > LAUNCH_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new TeamStartError(`name must be 1-${LAUNCH_NAME_MAX} printable characters`);
    }
    const callerHarness = identities(caller)?.harness ?? null;
    const harness = requestedHarness ?? callerHarness;
    if (typeof harness !== 'string' || !HARNESS_KEY_PATTERN.test(harness)) {
      throw new TeamStartError('name a harness: the caller has none recorded', { decision: 'refused: harness' });
    }
    // launchable() answers true, or false or the reason it cannot (#418).
    const ready = launchable(harness);
    if (ready !== true) {
      throw new TeamStartError(`harness '${harness}' is not launchable on this host${typeof ready === 'string' ? `: ${ready}` : ''}`,
        { decision: 'refused: harness' });
    }
    const model = modelOf(caller, harness, callerHarness, requestedModel);
    const packagePath = requestedTemplate ?? await template();
    if (typeof packagePath !== 'string' || !path.isAbsolute(packagePath)) {
      throw new TeamStartError(requestedTemplate === null
        ? 'no default soul template on this host: pass template as an absolute path'
        : 'template must be an absolute path', { decision: 'refused: template' });
    }
    const provider = providerOf(harness, packagePath, requestedProvider);
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
    // The event carries `model` only when one was asked for, so the launch
    // persists it (recordLaunchSettings) and the harness runs it; an absent
    // model leaves the harness default, as a launch without one does.
    const outcome = await launch({
      requestId: `team_${randomUUID()}`, account, package: packagePath, harness, name: name.trim(), parent,
      ...(model === undefined ? {} : { model }),
    });
    if (outcome?.status !== 'launched' || !outcome.agentId) {
      throw new TeamStartError(outcome?.detail ?? 'launch failed', { statusCode: 502, decision: 'failed' });
    }
    return { agentId: outcome.agentId, name: name.trim(), harness, model: model ?? null, provider, parent, startedBy: caller };
  };

  return function start(caller, request) {
    const run = queue.then(async () => {
      try {
        const result = await attempt(caller, request);
        // The receipt names the caller as ever; an independent start says so,
        // since the census will not show the new soul under the caller.
        receipt({ agentId: caller, decision: 'launched', ...(result.parent === null ? { detail: 'independent soul, no parent' } : {}) });
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
