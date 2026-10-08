#!/usr/bin/env node
// `agent-bot soul template refresh`: the maintained files of a template
// instance brought up to the bundled template (GeniusBar#287). A template
// declares `maintained` path prefixes in its soul.json (its app guide, its
// skills); a refresh replaces exactly those paths in the instance from the
// template and records `templateRevision`, in one package revision through
// the host edit path (`revision prepare`, `revision edit --apply`). The
// owner's AGENTS.md edits, the soul's memory, history and every other
// file are not read differently from any other revision edit and are
// never written. Owner action, like `revision edit`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDirectory } from './agent-identity.mjs';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { readSoulPackageEntries, validateMaintainedDeclaration } from './soul-package.mjs';
import { discardRevisionStaging, editSoulRevision, prepareRevisionEdit } from './soul-revisions.mjs';
import { knownTemplateName, resolveInstanceTemplate } from './soul-templates.mjs';

export const REFRESH_SCHEMA_VERSION = 1;
const USAGE = 'usage: agent-bot soul template refresh <agentId|name> [--from TEMPLATE_PATH] [--plan] [--json] [--principal-stdin]';
const STATE = '.soul-state';

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, action });
}

/** Whether a package path falls under one of the maintained prefixes (a trailing slash names a directory and everything in it; a bare path names one file). */
export function maintainedPath(entryPath, maintained) {
  return maintained.some((prefix) => (prefix.endsWith('/') ? entryPath === prefix.slice(0, -1) || entryPath.startsWith(prefix) : entryPath === prefix));
}

function resolveSoul(id, options) {
  const file = options.file ?? populationFile(options);
  try { return typeof id === 'string' && id.startsWith('agent_') ? showSoul(id, { file }) : showSoulByName(id, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}

function soulRoot(soul, options) {
  const registered = typeof soul.soulDir === 'string' && existsSync(soul.soulDir) ? soul.soulDir : null;
  return registered ?? soulDirectory(soul.id, { ...options, readOnly: true });
}

/**
 * What a refresh of the instance at `soulDir` would change (read-only):
 * `{ template: { name, package, revision }, templateRevision, maintained,
 * added, changed, removed, applied, entries }` where the lists name files
 * under the maintained prefixes that the template adds, changes or no
 * longer has, and `applied` says whether a run would write a revision (a
 * file differs, or the recorded templateRevision is behind). Refuses with
 * `soul-is-template` for a template, `template-not-found` when no bundled
 * template matches and none is given, `template-not-maintained` when the
 * template declares no maintained paths.
 */
export function planTemplateRefresh(soulDir, { from = null, env = process.env } = {}) {
  const { manifest, entries } = readSoulPackageEntries(soulDir);
  if (manifest.template === true) fail('soul-is-template', `${soulDir} is a template, not an instance; refresh an instance spawned from it`);
  const found = resolveInstanceTemplate(manifest, { from, env });
  if (!found) {
    fail('template-not-found', `no bundled template is named ${knownTemplateName(manifest) ?? 'as the instance'} or went by that name`,
      { action: 'agent-bot soul template refresh <soul> --from TEMPLATE_PATH' });
  }
  if (!Array.isArray(found.manifest.maintained) || found.manifest.maintained.length === 0) {
    fail('template-not-maintained', `${found.manifest.name} declares no maintained paths (soul.json "maintained"); nothing to refresh`);
  }
  const maintained = validateMaintainedDeclaration(found.manifest.maintained);
  const template = { name: found.manifest.name, package: found.package, revision: found.manifest.revision };
  const { entries: templateEntries } = readSoulPackageEntries(found.package);
  const before = new Map(entries.filter((entry) => maintainedPath(entry.path, maintained)).map((entry) => [entry.path, entry]));
  const after = new Map(templateEntries.filter((entry) => maintainedPath(entry.path, maintained)).map((entry) => [entry.path, entry]));
  const file = (entry) => entry.mode !== '040000';
  const added = [...after.values()].filter((entry) => file(entry) && !before.has(entry.path)).map((entry) => entry.path);
  const removed = [...before.values()].filter((entry) => file(entry) && !after.has(entry.path)).map((entry) => entry.path);
  const changed = [...after.values()].filter((entry) => file(entry) && before.has(entry.path)
    && (before.get(entry.path).mode !== entry.mode || !before.get(entry.path).bytes.equals(entry.bytes))).map((entry) => entry.path);
  const current = typeof manifest.templateRevision === 'string' ? manifest.templateRevision : null;
  const applied = added.length + changed.length + removed.length > 0 || current !== template.revision;
  return { template, templateName: typeof manifest.templateName === 'string' ? manifest.templateName : null, templateRevision: current,
    maintained, added, changed, removed, applied, entries: { before, after } };
}

/**
 * Applies a plan with `applied: true` to the instance `id`: one revision
 * (reason `Refresh maintained files from template <name> <revision>`) that
 * replaces the maintained paths with the template's and records the
 * template's revision as `templateRevision` (and its name as
 * `templateName` when the instance had none). Returns the revision record.
 */
export async function refreshFromTemplate(id, soulDir, plan, { file = populationFile(), ...options } = {}) {
  if (!plan.applied) throw new Error('nothing to refresh');
  const revisionOptions = { ...options, file, soulDir };
  const staged = prepareRevisionEdit(id, revisionOptions);
  try {
    const staging = staged.staging;
    // Everything under the maintained prefixes goes, deepest first, then
    // the template's entries come in with their modes.
    for (const entry of [...plan.entries.before.values()].sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
      rmSync(path.join(staging, entry.path), { recursive: true, force: true });
    }
    for (const entry of [...plan.entries.after.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const target = path.join(staging, entry.path);
      if (entry.mode === '040000') { mkdirSync(target, { recursive: true }); continue; }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.bytes);
      chmodSync(target, entry.mode === '100755' ? 0o755 : 0o644);
    }
    const manifestPath = path.join(staging, 'soul.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, templateRevision: plan.template.revision,
      ...(typeof manifest.templateName === 'string' ? {} : { templateName: plan.template.name }) }, null, 2)}\n`);
    return await editSoulRevision(id, staging, { ...revisionOptions, apply: true,
      reason: `Refresh maintained files from template ${plan.template.name} ${plan.template.revision}` });
  } finally { try { discardRevisionStaging(staged.staging); } catch { /* temp under the soul; harmless */ } }
}

export function formatRefresh(result) {
  const lines = [`agentId: ${result.soul.agentId}`, `soulDir: ${result.soul.soulDir}`, `template: ${result.template.name} (${result.template.package})`,
    `templateRevision: ${result.templateRevision}`, `maintained: ${result.maintained.join(', ')}`, `applied: ${result.applied}`, ''];
  for (const [label, paths] of [['added', result.added], ['changed', result.changed], ['removed', result.removed]]) {
    for (const entry of paths) lines.push(`${label}: ${entry}`);
  }
  if (!result.added.length && !result.changed.length && !result.removed.length) lines.push('no maintained file differs');
  return `${lines.join('\n')}\n`;
}

export async function soulTemplateRefreshCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), ...rest } = {}) {
  let id = null, from = null, plan = false, json = false, presented = false;
  const [command, ...args] = argv;
  if (command !== 'refresh') throw new Error(USAGE);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--plan' && !plan) plan = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented && !plan) presented = true;
    else if (arg === '--from' && from === null && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) { from = args[i + 1]; i += 1; }
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id || (plan && presented)) throw new Error(USAGE);
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const options = { env, home, now, ...rest };
  const file = options.file ?? populationFile(options);
  const soul = resolveSoul(id, { ...options, file });
  const soulDir = soulRoot(soul, { ...options, file });
  if (!existsSync(path.join(soulDir, STATE))) fail('soul-state-missing', `${soulDir} has no .soul-state yet; spawn or launch the soul first`);
  const planned = planTemplateRefresh(soulDir, { from, env });
  const { entries: _entries, ...report } = planned;
  let revision = report.templateRevision;
  let applied = false;
  if (!plan) {
    const authorization = await gate(`refresh ${soul.id}'s maintained files from template ${planned.template.name}`, { principal, env, cwd });
    if (planned.applied) {
      try {
        const edited = await refreshFromTemplate(soul.id, soulDir, planned, { ...options, file, stateDir: options.stateDir ?? stateDirectory(options), ...(authorization?.method ? { authorization } : {}) });
        revision = planned.template.revision;
        applied = true;
        appendAuditReceipt({ event: 'soul-template-refresh', agentId: soul.id, operation: 'refresh', decision: 'applied',
          detail: `${planned.template.name} ${planned.template.revision}: ${planned.added.length} added, ${planned.changed.length} changed, ${planned.removed.length} removed; revision ${edited.revision}` }, { env, home, now });
      } catch (error) {
        appendAuditReceipt({ event: 'soul-template-refresh', agentId: soul.id, operation: 'refresh', decision: 'failed', detail: `${error.code ?? 'error'}: ${error.message}` }, { env, home, now });
        throw error;
      }
    } else {
      appendAuditReceipt({ event: 'soul-template-refresh', agentId: soul.id, operation: 'refresh', decision: 'skipped',
        detail: `${planned.template.name} ${planned.template.revision}: no maintained file differs` }, { env, home, now });
    }
  }
  const current = JSON.parse(readFileSync(path.join(soulDir, 'soul.json'), 'utf8'));
  const result = { schemaVersion: REFRESH_SCHEMA_VERSION, soul: { agentId: soul.id, soulDir, revision: typeof current.revision === 'string' ? current.revision : null },
    template: report.template, templateRevision: revision, maintained: report.maintained,
    added: report.added, changed: report.changed, removed: report.removed, applied };
  write(json ? `${JSON.stringify(result)}\n` : formatRefresh(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulTemplateRefreshCommand(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'soul-template-refresh-failed', message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul template refresh: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
