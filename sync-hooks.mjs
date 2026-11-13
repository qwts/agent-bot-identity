#!/usr/bin/env node

// Generate the thin vendor adapters for the vendor-neutral agent-hook runner.
// A generated entry is identified only by MANAGED_MARKER; every foreign entry,
// every unrelated top-level setting, and the existing hook event key order
// survive regeneration.
//
// An entry is one readable line: it runs the co-located dispatcher
// (~/.<harness>/agent-bot/hook) by purpose name and, on a blocking event,
// refuses when the dispatcher is absent (`|| exit 2`). The dispatcher and the
// uninstalled policy it falls back to are generated files beside the harness
// config, so the config stays readable while the policy survives an absent
// runtime (ENG-0128 amendment: self-contained directory, not string). A
// config synced without its folder still refuses blocking events.

import process from 'node:process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { accountName, configuredAccountIdentity } from './detect-harness.mjs';
import { loadConfig, unmanagedAuthorsSnapshot } from './config.mjs';
import { pathToFileURL } from 'node:url';

import { CANONICAL_EVENTS, CLAUDE_WORKTREE_CREATE_COMMAND, DIALECTS, HOOK_PURPOSES, encodeDecision, isBlocking, nativeHookEntry, purposeFor, SOUL_HOOK_MARKER, vendorEvent } from './hook-dialects.mjs';
import { UNINSTALLED_OPAQUE_REASON, UNINSTALLED_REASON } from './identity-cli.mjs';

export const MANAGED_MARKER = 'agent-bot agent-hook';

const POLICY_MODULE = new URL('./identity/uninstalled-policy.mjs', import.meta.url);

// The whole inline surface of an entry: run the co-located dispatcher if it
// exists, otherwise refuse (blocking) or stay silent (advisory). The guard
// must live in the entry itself — a missing command exits 127, and Claude and
// Qwen treat anything but 0/2 as "proceed", so a bare name would fail open.
function command(row, event, adapterDir) {
  const exit = isBlocking(event) ? 2 : 0;
  return `"${adapterDir}/hook" ${row.key} ${purposeFor(event)} || exit ${exit} # ${MANAGED_MARKER} (${event})`;
}

function hookEntry(row, event, adapterDir) {
  return nativeHookEntry(row.key, event, command(row, event, adapterDir));
}

// A soul-declared hook (#378) also runs agent-hook, but it is the soul
// builder's entry, rendered into a soul's own project files: never ours to
// strip, even should one ever land in a file this module writes.
function isManaged(value) {
  const encoded = JSON.stringify(value);
  if (encoded.includes(SOUL_HOOK_MARKER)) return false;
  return encoded.includes(MANAGED_MARKER) || encoded.includes('agent-hook --dialect');
}

function parseConfig(path, text) {
  if (text.trim() === '') return {};
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error.message})`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${path}: root must be an object`);
  }
  if (config.hooks !== undefined && (
    !config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)
  )) {
    throw new Error(`${path}: hooks must be an object`);
  }
  return config;
}

// The canonical events a row wires in its user-level file: a row may limit
// them to its `homeEvents` (Qwen: SessionStart only, #1275).
export function eventsFor(row, home = false) {
  const events = home && row.homeEvents ? row.homeEvents : CANONICAL_EVENTS;
  return events.filter((event) => vendorEvent(row.key, event));
}

// The co-located adapter directory beside the harness config. Claude follows
// CLAUDE_CONFIG_DIR, matching hookHomePath and the WorktreeCreate installer.
export function hookAdapterDir(row, home = homedir(), env = process.env) {
  if (!row.homeAdapterDir) throw new Error(`${row.key} has no user adapter directory`);
  if (row.key === 'claude' && env.CLAUDE_CONFIG_DIR) return join(resolve(home, env.CLAUDE_CONFIG_DIR), 'agent-bot');
  return join(resolve(home), row.homeAdapterDir);
}

// The entry names the dispatcher through $HOME when it lives under the home
// it was generated for, so the config carries no machine-specific path.
function displayAdapterDir(row, home, env) {
  const dir = hookAdapterDir(row, home, env);
  const base = resolve(home);
  if (dir === base || dir.startsWith(base + sep)) return `$HOME/${relative(base, dir).replaceAll('\\', '/')}`;
  return dir.replaceAll('\\', '/');
}

// `home` renders the user-level file, which a row may limit to its
// `homeEvents`. `snapshot` (config.mjs unmanagedAuthorsSnapshot) is kept in
// the signature for callers that render a config and its adapter files
// together; the entries themselves no longer carry it — the co-located
// policy file does (adapterFiles).
export function renderConfig(row, current = '{}', snapshot = undefined, { home = false, adapterDir } = {}) {
  const config = parseConfig(row.file, current);
  const dir = adapterDir ?? displayAdapterDir(row, homedir(), process.env);
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) throw new Error(`${row.file}: hooks.${event} must be an array`);
    // Keep the key even when every current entry is managed. Deleting it here
    // would re-append the generated event at the end and reshuffle foreign
    // keys (WorktreeCreate, agent-guard) relative to SessionStart / PreToolUse.
    hooks[event] = entries.filter((entry) => !isManaged(entry));
  }
  for (const event of eventsFor(row, home)) {
    const generated = hookEntry(row, event, dir);
    hooks[generated.vendorEvent] ??= [];
    hooks[generated.vendorEvent].push(generated.entry);
  }
  for (const [event, entries] of Object.entries(hooks)) {
    if (!entries.length) delete hooks[event];
  }
  const result = { ...config, hooks };
  if (row.format === 'cursor' || row.format === 'copilot') result.version ??= 1;
  return `${JSON.stringify(result, null, 2)}\n`;
}

// The co-located dispatcher: map the purpose the config names back to the
// canonical event, run the installed runner when present, else the policy
// file beside it. Generated, marker-commented, never hand-edited.
export function renderHookDispatcher(row, events) {
  const arms = Object.entries(HOOK_PURPOSES)
    .filter(([event, purpose]) => events.includes(event) && purpose !== event)
    .map(([event, purpose]) => `  ${purpose}) E=${event} ;;`)
    .join('\n');
  return `#!/bin/sh
# agent-bot hook dispatcher — generated by agent-bot sync-hooks; do not edit.
# The harness config names each hook point by purpose; map it back to the
# canonical event, run the installed runner when present, and otherwise the
# co-located uninstalled policy (ENG-0128).
E="$2"
case "$2" in
${arms}
esac
R="\${AGENT_BOT_HOOK_BIN:-\$HOME/.local/share/agent-bot/agent-hook}"
[ -x "\$R" ] && exec "\$R" --dialect "\$1" --event "\$E"
D=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
exec node "\$D/uninstalled-policy.mjs" "\$1" "\$E"
`;
}

// The co-located uninstalled policy: the policy module's text verbatim plus
// this dialect's decision envelopes and the allowlist snapshot. The module
// must stay self-contained (node builtins only) so this file runs standalone.
export function renderUninstalledPolicy(row, events, snapshot = { sha256: null, authors: [] }) {
  const clean = {
    sha256: typeof snapshot?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(snapshot.sha256) ? snapshot.sha256 : null,
    authors: Array.isArray(snapshot?.authors) ? snapshot.authors.filter((author) => typeof author === 'string' && /^[a-z0-9][a-z0-9._@+-]{0,99}$/.test(author)) : [],
  };
  const envelopes = Object.fromEntries(events.map((event) => [event, {
    allow: encodeDecision({ dialectKey: row.key, event, decision: 'allow' }),
    deny: encodeDecision({ dialectKey: row.key, event, decision: 'deny', reason: UNINSTALLED_REASON }),
    denyOpaque: encodeDecision({ dialectKey: row.key, event, decision: 'deny', reason: UNINSTALLED_OPAQUE_REASON }),
  }]));
  // The module's shebang is only valid on line 1; the generated file opens
  // with its own header, so drop it from the embedded text.
  const source = readFileSync(POLICY_MODULE, 'utf8').replace(/^#![^\n]*\n/, '');
  return `// Generated by agent-bot sync-hooks from identity/uninstalled-policy.mjs — do not edit.
// Uninstalled-mode policy (ENG-0128): the dispatcher runs this file when the
// installed agent-hook is absent.
${source}
const ENVELOPES = ${JSON.stringify(envelopes)};
const SNAPSHOT = ${JSON.stringify(clean)};
const event = process.argv[3];
let raw = "";
try { if (!process.stdin.isTTY) raw = readFileSync(0, "utf8"); } catch {}
let payload = {};
try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch {}
if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
const verdict = uninstalledDecision({
  event,
  command: extractCommand(payload, process.env),
  env: process.env,
  authors: unmanagedAuthorList(process.env, SNAPSHOT),
});
const envelopes = ENVELOPES[event];
const encoded = verdict.decision !== "deny" ? envelopes.allow : verdict.reason === UNINSTALLED_OPAQUE_REASON ? envelopes.denyOpaque : envelopes.deny;
if (encoded.stdout) process.stdout.write(encoded.stdout);
if (encoded.stderr) process.stderr.write(encoded.stderr + "\\n");
process.exit(encoded.exitCode);
`;
}

// The files a row's user-level adapter needs beside its config. `snapshot`
// is what the uninstalled policy may grant; without one it grants nothing.
export function adapterFiles(row, snapshot = undefined, { home = homedir(), env = process.env } = {}) {
  const dir = hookAdapterDir(row, home, env);
  const events = eventsFor(row, true);
  return [
    { path: join(dir, 'hook'), text: renderHookDispatcher(row, events), mode: 0o755 },
    { path: join(dir, 'uninstalled-policy.mjs'), text: renderUninstalledPolicy(row, events, snapshot), mode: 0o600 },
  ];
}

// The `agent-bot mcp` server a row registers in its user file (#1275); Qwen
// Code reads `mcpServers` from ~/.qwen/settings.json. The command is the
// stable installed path, since a desktop app need not have ~/.local/bin on
// PATH. An `agent-bot` entry already there is the owner's and is kept.
export function withHomeMcpServer(row, rendered, home = homedir()) {
  if (!row.homeMcpKey) return rendered;
  const config = JSON.parse(rendered);
  const servers = config[row.homeMcpKey];
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new Error(`${row.homeFile}: ${row.homeMcpKey} must be an object`);
  }
  if (servers?.['agent-bot'] !== undefined) return rendered;
  const entry = { command: join(resolve(home), '.local', 'bin', 'agent-bot'), args: ['mcp'] };
  return `${JSON.stringify({ ...config, [row.homeMcpKey]: { ...servers, 'agent-bot': entry } }, null, 2)}\n`;
}

function claudeAdapterPlan({ home = homedir(), env = process.env, config = loadConfig({ home, env }) } = {}) {
  const identity = configuredAccountIdentity(config, accountName(env));
  const path = join(resolve(home, env.CLAUDE_CONFIG_DIR || '.claude'), 'settings.json');
  const evidence = { dialect: 'claude', path, app_slug: identity?.slug ?? null };
  const report = (status, code, message, action = null) => ({ status, code, message, action, evidence });
  if (identity?.harness !== 'claude') {
    return { report: report('not_applicable', null, 'Claude transcript adapter is not required for this account') };
  }
  let settings = {};
  let current = null;
  try {
    for (const [location, directory] of [[dirname(path), true], [path, false]]) {
      let stat;
      try {
        stat = lstatSync(location);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) {
        return { report: report('failed', 'claude-settings-conflict', 'Claude settings must use a regular file and directory', `reconcile ${path}, then run: agent-bot bootstrap --machine-only`) };
      }
    }
    try {
      current = readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== null) settings = parseConfig(path, current);
    if (settings.disableAllHooks === true) {
      return { report: report('failed', 'claude-hooks-disabled', 'Claude hooks are disabled in account settings', `review disableAllHooks in ${path}; agent-bot will not change this policy`) };
    }
    const entries = settings.hooks?.WorktreeCreate === undefined ? [] : settings.hooks.WorktreeCreate;
    if (!Array.isArray(entries)) throw new Error('invalid hook entries');
    const expected = { hooks: [{ type: 'command', command: CLAUDE_WORKTREE_CREATE_COMMAND, timeout: 180 }] };
    if (entries.length && !isDeepStrictEqual(entries, [expected])) {
      return { report: report('failed', 'claude-worktree-adapter-conflict', 'Claude WorktreeCreate has a conflicting or modified adapter', `reconcile WorktreeCreate in ${path}, then run: agent-bot bootstrap --machine-only`) };
    }
    if (entries.length) return { report: report('ready', null, 'Claude WorktreeCreate transcript adapter is installed') };
    const desired = `${JSON.stringify({ ...settings, hooks: { ...settings.hooks, WorktreeCreate: [expected] } }, null, 2)}\n`;
    return {
      current, desired,
      report: report('failed', 'claude-worktree-adapter-missing', 'Claude WorktreeCreate transcript adapter is missing', 'run: agent-bot bootstrap --machine-only'),
    };
  } catch {
    return { report: report('failed', 'claude-settings-unreadable', 'Claude account settings could not be read or parsed safely', `repair ${path}, then run: agent-bot bootstrap --machine-only`) };
  }
}

export function inspectClaudeWorktreeAdapter(options = {}) {
  return claudeAdapterPlan(options).report;
}

export function ensureClaudeWorktreeAdapter(options = {}) {
  const plan = claudeAdapterPlan(options);
  if (!plan.desired) {
    if (plan.report.status === 'failed') throw new Error(`${plan.report.message}; ${plan.report.action}`);
    return { ...plan.report, updated: false };
  }
  const path = plan.report.evidence.path;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, plan.desired, { flag: 'wx', mode: 0o600 });
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== plan.current) throw new Error('Claude settings changed during installation; retry bootstrap');
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ...inspectClaudeWorktreeAdapter(options), updated: true };
}

// User-level path for a dialect. Claude follows CLAUDE_CONFIG_DIR, matching
// the WorktreeCreate installer. Never join this onto a repository root:
// a project file can outrank the user hook.
export function hookHomePath(row, home = homedir(), env = process.env) {
  if (!row.homeFile) throw new Error(`${row.key} has no user hook path`);
  const base = resolve(home);
  if (row.key === 'claude' && env.CLAUDE_CONFIG_DIR) return join(resolve(base, env.CLAUDE_CONFIG_DIR), 'settings.json');
  return join(base, row.homeFile);
}

function assertRegularHookFile(path) {
  const directory = dirname(path);
  if (existsSync(directory)) {
    const parent = lstatSync(directory);
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error(`${directory} must be a regular directory`);
    }
  }
  if (!existsSync(path)) return;
  const file = lstatSync(path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`${path} must be a regular file`);
  }
}

function writeAtomic(path, contents, mode = 0o600) {
  assertRegularHookFile(path);
  mkdirSync(dirname(path), { recursive: true });
  assertRegularHookFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const CODEX_USER_POLICY = `approval_policy = "on-request"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true

[features]
hooks = true

[apps.connector_76869538009648d5b282a4bb21c3d157]
enabled = true
destructive_enabled = false
`;

function ensureCodexUserPolicy(home, check) {
  const path = join(resolve(home), '.codex', 'config.toml');
  if (existsSync(path)) {
    assertRegularHookFile(path);
    return [];
  }
  if (check) return [path];
  writeAtomic(path, CODEX_USER_POLICY);
  return [path];
}

export function syncHooks({ home = homedir(), env = process.env, check = false } = {}) {
  const drift = [];
  const snapshot = unmanagedAuthorsSnapshot({ home, env });
  for (const row of DIALECTS.filter((candidate) => candidate.homeFile)) {
    const path = hookHomePath(row, home, env);
    assertRegularHookFile(path);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '{}';
    const desired = withHomeMcpServer(row, renderConfig(row, current, snapshot, { home: true, adapterDir: displayAdapterDir(row, home, env) }), home);
    if (current !== desired) {
      drift.push(path);
      if (!check) writeAtomic(path, desired);
    }
    for (const file of adapterFiles(row, snapshot, { home, env })) {
      assertRegularHookFile(file.path);
      const currentFile = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
      if (currentFile === file.text) continue;
      drift.push(file.path);
      if (!check) writeAtomic(file.path, file.text, file.mode);
    }
  }
  drift.push(...ensureCodexUserPolicy(home, check));
  return drift;
}

export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const check = argv.includes('--check');
  const drift = syncHooks({ check });
  if (check && drift.length) {
    process.stderr.write(`generated hook adapters are stale: ${drift.join(', ')}\n`);
    return 1;
  }
  if (!check && drift.length) process.stdout.write(`updated ${drift.join(', ')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`sync-hooks: ${error.message}\n`);
    process.exitCode = 1;
  }
}
