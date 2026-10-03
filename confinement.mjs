// Cooperative write guardrail (ADR-0332 decision 7), never an OS sandbox.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { currentAgentId, stateDirectory, validateAgentId, withLock } from './agent-identity.mjs';
import { populationFile, showSoul, soulDirectory } from './agent-population.mjs';
import { revisionHistory, revisionPackagePath } from './soul-revisions.mjs';
import { assertOwnerAction } from './owner-gate.mjs';
import { readBinding } from './agent-binding.mjs';
import { supportsContext, vendorEvent } from './hook-dialects.mjs';

const MODES = ['off', 'warn', 'deny'];
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('confinement data could not be read'); }
}
const settingsFile = (opts) => path.join(opts.stateDir ?? stateDirectory(opts), 'confinement.json');

export function confinementMode(agentId, opts = {}) {
  const settings = readJson(settingsFile(opts), {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid confinement settings');
  const mode = settings[validateAgentId(agentId)] ?? 'warn';
  if (!MODES.includes(mode)) throw new Error('invalid confinement mode');
  return mode;
}

// Resolve existing components before '..', including links. For missing
// components, retain the suffix under the nearest existing real ancestor.
// Dangling links and non-ENOENT errors are errors, not grants.
function canonicalPath(value, cwd = process.cwd()) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('invalid write path');
  const absolute = path.isAbsolute(value) ? value : `${cwd}${path.sep}${value}`;
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    if (!part || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    let exists = true;
    try { lstatSync(next); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    current = exists ? realpathSync(next) : next;
  }
  return current;
}
function contains(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

// The shared-temp fallback is granted only while each component we create is
// a real directory owned by this user (or not there yet): a symlink planted in
// a shared temp directory must not turn its target into soul territory.
function tmpFallback(id, env, uid) {
  const base = path.join(env.TMPDIR ?? tmpdir(), 'agent-bot');
  for (const component of [base, path.join(base, id)]) {
    let stat;
    try { stat = lstatSync(component); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (!stat.isDirectory() || stat.uid !== uid) return null;
  }
  return canonicalPath(path.join(base, id));
}

// A soul's identity comes from its binding, so a file tool may never rewrite
// one, even inside a checkout that is otherwise the soul's territory.
function isBindingFile(target, env) {
  if (path.basename(target) === 'agent-binding.json') return true;
  if (path.basename(path.dirname(target)) === 'agent-bindings') return true;
  if (!env.AGENT_BOT_BINDING) return false;
  try { return canonicalPath(env.AGENT_BOT_BINDING) === target; } catch { return true; }
}

export function allowedRoots(agentId, opts = {}) {
  const id = validateAgentId(agentId);
  const soul = soulDirectory(id, opts);
  const roots = [realpathSync(soul)];
  const env = opts.env ?? process.env;
  const fallback = tmpFallback(id, env, opts.uid ?? process.getuid());
  if (fallback) roots.push(fallback);
  const census = showSoul(id, { file: opts.file ?? populationFile(opts) });
  const recordedCheckouts = new Set();
  for (const checkout of [...(census.worktrees ?? []), census.worktree].filter(Boolean)) {
    try { recordedCheckouts.add(realpathSync(checkout)); } catch { /* Unavailable checkouts grant nothing. */ }
  }
  const worktrees = path.join(soul, 'worktrees');
  let entries = [];
  try {
    // The container itself must not redirect discovery outside the soul.
    if (lstatSync(worktrees).isDirectory()) entries = readdirSync(worktrees);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    const file = path.join(worktrees, entry);
    try {
      const stat = lstatSync(file);
      if (stat.isDirectory()) roots.push(realpathSync(file));
      else if (stat.isSymbolicLink()) {
        const target = realpathSync(file);
        if (recordedCheckouts.has(target) || (fallback && contains(fallback, target))) roots.push(target);
      }
    } catch { /* Dangling or unavailable entries grant nothing. */ }
  }
  const binding = opts.binding === undefined ? readBinding({ env, cwd: opts.cwd }) : opts.binding;
  if (binding?.agentId === id) {
    const checkout = opts.boundCheckout ?? execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: opts.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const root = realpathSync(checkout);
    if (binding.worktree == null) roots.push(root);
    else {
      try {
        if (realpathSync(binding.worktree) === root) roots.push(root);
      } catch { /* A missing recorded worktree cannot authorize this checkout. */ }
    }
  }
  const revisionOpts = { ...opts, stateDir: opts.stateDir ?? stateDirectory(opts) };
  const head = revisionHistory(id, revisionOpts).at(-1);
  const policy = head
    ? readJson(path.join(revisionPackagePath(id, head.revision, revisionOpts), 'policy.json'), {}) : {};
  const grants = policy?.confinement?.writablePaths ?? [];
  if (!Array.isArray(grants)) throw new Error('confinement.writablePaths must be an array');
  for (const grant of grants) {
    if (typeof grant !== 'string' || !path.isAbsolute(grant) || grant.startsWith('~')) throw new Error('confinement.writablePaths must contain absolute paths');
    roots.push(canonicalPath(grant));
  }
  return [...new Set(roots)];
}

export function checkWrite(agentId, targetPath, opts = {}) {
  const roots = allowedRoots(agentId, opts);
  const target = canonicalPath(targetPath, opts.cwd);
  if (isBindingFile(target, opts.env ?? process.env)) return { inside: false, path: target, roots };
  return { inside: roots.some((root) => contains(root, target)), path: target, roots };
}

// Only recognized file tools. No command parsing, MCP inspection or reads.
export function confinementCheck(envelope, opts = {}) {
  const allow = { decision: 'allow' };
  const preTool = vendorEvent(envelope.harness, 'pre-tool-use');
  // The generated adapters may invoke both events for the same file tool.
  // Prefer the generic event, and use the file event for legacy dialects.
  if (envelope.event !== (preTool ? 'pre-tool-use' : 'pre-file-write')) return allow;
  if (preTool && !/^(Write|Edit|MultiEdit|NotebookEdit|create|edit|create_file|edit_file|write_file|replace_string_in_file|multi_replace_string_in_file)$/i.test(envelope.tool_name ?? '')) return allow;
  let mode = 'warn';
  try {
    const agentId = opts.binding?.agentId ?? currentAgentId({ env: opts.env ?? process.env, cwd: envelope.cwd ?? opts.cwd });
    if (!agentId) return allow;
    mode = confinementMode(agentId, opts);
    if (mode === 'off') return allow;
    if (!envelope.file_path) throw new Error('file tool has no path');
    const result = checkWrite(agentId, envelope.file_path, { ...opts, cwd: envelope.cwd ?? opts.cwd });
    if (result.inside) return allow;
    if (mode === 'deny') return { decision: 'deny', reason: `write outside soul territory: ${result.path}` };
    const log = path.join(soulDirectory(agentId, opts), '.soul-state', 'confinement.log');
    mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    const fd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), agentId, harness: envelope.harness, tool: envelope.tool_name, path: result.path, roots: result.roots })}\n`);
    } finally { closeSync(fd); }
    return supportsContext(envelope.harness, envelope.event)
      ? { ...allow, context: `Confinement warning: write outside soul territory: ${result.path}` } : allow;
  } catch {
    // Never reflect parser errors, file contents, or credentials to a model.
    return mode === 'deny' ? { decision: 'deny', reason: 'confinement check failed; write refused' } : allow;
  }
}

export async function setConfinementMode(agentId, mode, opts = {}) {
  const id = validateAgentId(agentId);
  if (!MODES.includes(mode)) throw new Error('confinement mode must be off, warn or deny');
  const gate = opts.gate ?? assertOwnerAction;
  await gate(`soul confinement ${id} ${mode}`, { env: opts.env, cwd: opts.cwd, principal: opts.principal });
  const file = settingsFile(opts);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  withLock(`${file}.lock`, 'confinement settings', () => {
    const settings = readJson(file, {});
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid confinement settings');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ ...settings, [id]: mode }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, file);
    } finally { rmSync(temp, { force: true }); }
  });
  return { agentId: id, mode };
}

export function confinementReport(agentId, opts = {}) {
  const id = validateAgentId(agentId);
  const log = path.join(soulDirectory(id, opts), '.soul-state', 'confinement.log');
  let text;
  try { text = readFileSync(log, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
  const counts = new Map();
  let total = 0;
  let invalid = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { invalid++; continue; }
    if (row.agentId !== id || typeof row.path !== 'string' || !path.isAbsolute(row.path)) { invalid++; continue; }
    const prefix = path.dirname(row.path);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    total++;
  }
  return { agentId: id, total, invalid, prefixes: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, count]) => ({ prefix, count })) };
}

export async function confinementCommand(argv, opts = {}) {
  const [command, id, ...args] = argv;
  const write = opts.write ?? ((text) => process.stdout.write(text));
  if (command === 'confinement-report' && (args.length === 0 || (args.length === 1 && args[0] === '--json'))) {
    const report = confinementReport(id, opts);
    write(args[0] === '--json' ? `${JSON.stringify(report)}\n` : `${id}: ${report.total} outside writes, ${report.invalid} invalid records\n${report.prefixes.map(({ prefix, count }) => `${count}\t${prefix}\n`).join('')}`);
    return report;
  }
  if (command !== 'confinement' || !MODES.includes(args[0]) || args.length > 2 || (args[1] && args[1] !== '--principal-stdin')) throw new Error('usage: agent-bot soul confinement AGENT_ID off|warn|deny [--principal-stdin] | soul confinement-report AGENT_ID [--json]');
  let principal = null;
  if (args[1]) {
    try { principal = JSON.parse((opts.readStdin ?? (() => readFileSync(0, 'utf8')))()); }
    catch { throw new Error('--principal-stdin needs a principal credential as JSON'); }
  }
  const result = await setConfinementMode(id, args[0], { ...opts, principal });
  write(`${id} confinement ${result.mode}\n`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) confinementCommand(process.argv.slice(2)).catch((error) => { process.stderr.write(`agent-bot soul confinement: ${error.message}\n`); process.exitCode = 1; });
