#!/usr/bin/env node

// `agent-bot soul remove <agentId|name> [--scope soul|team] [--plan] [--json]
// [--principal-stdin]` (#420, GeniusBar #283): take a soul out of this
// account. Nothing is deleted. The soul stops waking, leaves agent-comms, is
// retired in its identity record and the census (a tombstone; there is no
// un-retire, #46), and its folder moves to `<souls root>/.archive/`. Owner
// only, and never while the soul runs. A retired soul can be removed again,
// which finishes a cleanup a failed launch or an earlier remove left undone
// (#419).
//
// Scope says what happens to the souls it leads. `soul` (the default) retires
// the one soul and lets its direct children stand on their own (their census
// `parentId` is cleared); deeper descendants keep their own parent. `team`
// retires every active descendant too, deepest first. `--plan` prints what a
// scope would touch without touching anything, so a host can show the exact
// names and counts before asking; the executor runs the same plan.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { readAgentIdentity, stateDirectory, validateAgentId } from './agent-identity.mjs';
import {
  archiveSoulDirs, listSouls, populationFile, retireIdentityWithPopulation, setSoulParent, showSoul, showSoulByName, soulDirectory, soulShownName,
} from './agent-population.mjs';
import { leaveLaunchedSoul } from './comms-membership.mjs';
import { daemonStatus } from './daemon-status.mjs';
import { readColdWakeSettings, setColdWake, wakeSetting } from './cold-wake-settings.mjs';
import { assertOwnerAction } from './owner-action.mjs';
import { soulRunning } from './soul-comms.mjs';

const USAGE = 'usage: agent-bot soul remove <agentId|name> [--scope soul|team] [--plan] [--json] [--principal-stdin]';

export const REMOVE_SCOPES = Object.freeze(['soul', 'team']);
export const PLAN_SCHEMA_VERSION = 1;
// What this engine can do, for a host that must not infer it (GeniusBar
// #283): a dry run, a whole-team archive, children made independent. Neither
// restoring an archived soul nor deleting one exists here, and a host must
// not promise them.
export const REMOVE_CAPABILITIES = Object.freeze({ plan: true, team: true, independent: true, restore: false, delete: false });

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
}

function parseArgs(argv) {
  const options = { json: false, plan: false, presented: false, scope: 'soul' };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--plan') options.plan = true;
    else if (arg === '--principal-stdin') options.presented = true;
    else if (arg === '--scope' || arg.startsWith('--scope=')) {
      const value = arg === '--scope' ? argv[++index] : arg.slice('--scope='.length);
      if (!REMOVE_SCOPES.includes(value)) throw new Error(`--scope must be one of ${REMOVE_SCOPES.join(', ')}\n${USAGE}`);
      options.scope = value;
    } else positional.push(arg);
  }
  const [target, ...rest] = positional;
  if (!target || rest.length) throw new Error(USAGE);
  return { ...options, target };
}

async function describeSoul(soul, { file, env, home, stateDir, depth, running }) {
  let directory = null;
  try { directory = soulDirectory(soul.id, { file, env, home }); } catch { /* no soul directory */ }
  let harness = null;
  try { harness = readAgentIdentity(soul.id, { stateDir }).harness ?? null; } catch { /* no identity record here */ }
  return {
    agentId: soul.id, name: soul.name, displayName: soulShownName(soul, directory), status: soul.status, harness,
    parentId: soul.parentId, running: await running(soul.id), depth,
  };
}

// The plan both `--plan` and the executor use, from the census alone: the
// soul and every descendant to any depth (through retired parents too, and
// whether or not a soul is awake), each sorted into `archived`, `independent`
// (its parentId will be cleared) or `unchanged`. Counts are these lists'
// lengths; nothing else is implied. `running(id)` answers true, false or null
// (the daemon could not be asked); it never changes what the plan decides.
export async function removalPlan(id, {
  scope = 'soul',
  file = populationFile(),
  env = process.env,
  home = homedir(),
  stateDir = stateDirectory({ env, home }),
  running = async () => null,
} = {}) {
  if (!REMOVE_SCOPES.includes(scope)) throw new Error(`scope must be one of ${REMOVE_SCOPES.join(', ')}`);
  const target = validateAgentId(id);
  const souls = listSouls({ file });
  const root = souls.find((soul) => soul.id === target);
  if (!root) throw new Error(`no population record for ${target}`);
  const children = new Map();
  for (const soul of souls) {
    if (soul.parentId === null) continue;
    if (!children.has(soul.parentId)) children.set(soul.parentId, []);
    children.get(soul.parentId).push(soul);
  }
  // Breadth first, so depth is the distance from the soul; a row seen twice
  // (a cycle in a hand-edited census) is walked once.
  const seen = new Set([target]);
  const rows = [{ soul: root, depth: 0 }];
  for (let index = 0; index < rows.length; index += 1) {
    for (const child of children.get(rows[index].soul.id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      rows.push({ soul: child, depth: rows[index].depth + 1 });
    }
  }
  const archived = [];
  const independent = [];
  const unchanged = [];
  for (const { soul, depth } of rows) {
    const entry = await describeSoul(soul, { file, env, home, stateDir, depth, running });
    const retired = soul.status === 'retired';
    if (depth === 0) archived.push(entry);
    else if (scope === 'team') (retired ? unchanged : archived).push(entry);
    else if (depth === 1 && !retired) independent.push(entry);
    else unchanged.push(entry);
  }
  return { schemaVersion: PLAN_SCHEMA_VERSION, scope, agentId: target, capabilities: { ...REMOVE_CAPABILITIES }, archived, independent, unchanged };
}

function label(entry) {
  return entry.displayName === entry.name ? entry.name : `${entry.displayName} (${entry.name})`;
}

function planText(plan) {
  const line = (entry) => {
    const facts = [entry.status, entry.running === null ? 'running unknown' : entry.running ? 'running' : 'not running'];
    if (entry.harness) facts.push(entry.harness);
    return `  ${'  '.repeat(entry.depth)}${label(entry)} ${entry.agentId}: ${facts.join(', ')}\n`;
  };
  const section = (title, entries) => (entries.length ? `${title} (${entries.length}):\n${entries.map(line).join('')}` : `${title}: none\n`);
  return `plan for soul remove ${plan.agentId} --scope ${plan.scope} (nothing changed)\n`
    + section('archived', plan.archived) + section('independent', plan.independent) + section('unchanged', plan.unchanged)
    + `restore: ${plan.capabilities.restore ? 'supported' : 'not supported'}; delete: ${plan.capabilities.delete ? 'supported' : 'not supported'}\n`;
}

export async function soulRemoveCommand(argv, {
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  now = () => new Date(),
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd }),
  status = undefined,
  leave = (soul) => leaveLaunchedSoul(soul, { env }),
  archive = (id, options) => archiveSoulDirs(id, options),
} = {}) {
  const { json, plan: dryRun, presented, scope, target } = parseArgs(argv);
  const file = populationFile({ env, home });
  const stateDir = stateDirectory({ env, home });
  const soul = resolveSoul(target, file);
  // One daemon snapshot answers `running` for every soul in the plan; a
  // daemon that cannot be asked leaves the answer null rather than guessed.
  let snapshot = null;
  const running = async (id) => {
    snapshot ??= (status ?? daemonStatus)({ env, home }).then((daemon) => daemon ?? null, () => null);
    const daemon = await snapshot;
    return daemon === null ? null : soulRunning(id, { status: async () => daemon, env, home });
  };
  const plan = await removalPlan(soul.id, { scope, file, env, home, stateDir, running });
  if (dryRun) {
    write(json ? `${JSON.stringify(plan)}\n` : planText(plan));
    return plan;
  }

  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  // The same check the single remove always made, now over every soul the
  // plan archives: a running soul anywhere in it refuses the whole remove.
  const refuseRunning = async () => {
    for (const entry of plan.archived) {
      if (!await soulRunning(entry.agentId, { ...(status ? { status } : {}), env, home })) continue;
      const what = entry.agentId === soul.id ? 'it' : `${soul.id}'s team`;
      throw Object.assign(new Error(`${entry.agentId} is running; stop it before removing ${what}`), { code: 'soul-running', agentId: entry.agentId });
    }
  };
  await refuseRunning();
  await gate(`soul remove ${soul.id}${scope === 'soul' ? '' : ` --scope ${scope}`}`, { principal });
  // The owner may take a while to approve; a soul may have started since.
  await refuseRunning();

  // Deepest first, so no soul is retired while a soul it leads still runs
  // under it; the soul asked for comes last.
  const order = [...plan.archived].sort((left, right) => right.depth - left.depth || left.agentId.localeCompare(right.agentId));
  const effects = { scope, archived: [], independent: [], notArchived: order.map(({ agentId, name, displayName }) => ({ agentId, name, displayName })) };
  // Each step is safe to repeat, so a remove that stops part way can be rerun.
  const removeOne = async (entry, { independent = [], detail = null } = {}) => {
    const record = showSoul(entry.agentId, { file });
    let directory = null;
    try { directory = soulDirectory(record.id, { file, env, home }); } catch { /* no soul directory */ }
    const result = { agentId: record.id, name: soulShownName(record, directory), handle: record.name, wake: 'off', comms: 'left', retired: true, archived: [] };
    if (wakeSetting(readColdWakeSettings({ env, home })[record.id]) !== null) setColdWake(record.id, false, { env, home, now });
    // Leave while the soul is still active: the hub sees it go as itself.
    try { await leave({ agentId: record.id }); }
    catch (error) { result.comms = `not left: ${error.message}`; }
    if (record.status !== 'retired') {
      retireIdentityWithPopulation(record.id, { file, stateDir, now });
    }
    // The souls it led stand on their own once it is retired (scope `soul`).
    for (const child of independent) {
      setSoulParent(child.agentId, null, { file });
      appendAuditReceipt({ event: 'soul-reparent', agentId: child.agentId, decision: 'independent', detail: `former parent ${record.id}` }, { env, home, now });
      effects.independent.push({ agentId: child.agentId, name: child.name, displayName: child.displayName, formerParentId: record.id });
    }
    // The soul is retired by now, so a folder that will not move names the
    // step and what to do: this error is what GeniusBar shows (#531, GeniusBar#196).
    try { result.archived = archive(record.id, { env, home, now, file }); }
    catch (error) {
      throw Object.assign(new Error(`${record.id} is retired, but its folder could not be moved into the souls folder's .archive: ${error.message}; `
        + 'close whatever holds the folder open (or move it there by hand), then run soul remove again'), { code: 'soul-archive-failed', cause: error });
    }
    appendAuditReceipt({ event: 'soul-remove', agentId: record.id, decision: result.comms === 'left' ? 'removed' : 'removed:comms-pending', detail }, { env, home, now });
    effects.archived.push(result);
    effects.notArchived = effects.notArchived.filter(({ agentId }) => agentId !== record.id);
    return result;
  };

  let own = null;
  try {
    for (const entry of order) {
      const self = entry.agentId === soul.id;
      const result = await removeOne(entry, { independent: self ? plan.independent : [], detail: self ? null : `with the team of ${soul.id}` });
      if (self) own = result;
    }
  } catch (error) {
    // Partial progress stays visible: which souls were archived, which were not.
    if (plan.archived.length > 1) {
      error.message += `; archived so far: ${effects.archived.map(({ agentId }) => agentId).join(', ') || 'none'}`
        + `; not archived: ${effects.notArchived.map(({ agentId }) => agentId).join(', ')}`;
    }
    throw Object.assign(error, { plan, effects });
  }
  const result = { ...own, plan, effects };
  const describe = (one) => `${one.agentId} removed: wake off, ${one.comms === 'left' ? 'left agent-comms' : `agent-comms ${one.comms}`}, retired, `
    + `${one.archived.length ? `folder archived to ${one.archived.map(({ to }) => to).join(', ')}` : 'no folder to archive'}\n`;
  write(json ? `${JSON.stringify(result)}\n`
    : effects.archived.map(describe).join('')
      + effects.independent.map(({ agentId, formerParentId }) => `${agentId} now independent (was led by ${formerParentId})\n`).join(''));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulRemoveCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({
        error: { code: error.code ?? 'soul-remove-failed', message: error.message },
        ...(error.plan ? { plan: error.plan } : {}), ...(error.effects ? { effects: error.effects } : {}),
      })}\n`);
    }
    process.stderr.write(`agent-bot soul remove: ${error.message}\n`);
    process.exitCode = 1;
  });
}
