#!/usr/bin/env node

// Generate the thin vendor adapters for the vendor-neutral agent-hook runner.
// A generated entry is identified only by MANAGED_MARKER; every foreign entry,
// every unrelated top-level setting, and the existing hook event key order
// survive regeneration.

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
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { accountName, configuredAccountIdentity } from './detect-harness.mjs';
import { loadConfig } from './config.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CANONICAL_EVENTS, CLAUDE_WORKTREE_CREATE_COMMAND, DIALECTS, isBlocking, vendorEvent } from './hook-dialects.mjs';
import { adapterFallback } from './uninstalled-identity-hook.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const MANAGED_MARKER = 'agent-bot agent-hook';

function command(dialectKey, event) {
  return `export AGENT_BOT_UNMANAGED_AUTHORS="\${AGENT_BOT_UNMANAGED_AUTHORS-ai9d}"; H="\${AGENT_BOT_HOOK_BIN:-\$HOME/.local/share/agent-bot/agent-hook}"; [ -x "$H" ] && exec "$H" --dialect ${dialectKey} --event ${event}; ${adapterFallback(dialectKey, event)} # ${MANAGED_MARKER}`;
}

function timeoutSeconds(dialectKey, event) {
  const row = DIALECTS.find((candidate) => candidate.key === dialectKey);
  const cap = row.timeoutCapMs?.[event] ?? row.timeoutCapMs?.default;
  return cap ? Math.ceil(cap / 1000) : 60;
}

function hookEntry(row, event) {
  const mapped = vendorEvent(row.key, event);
  const run = command(row.key, event);
  if (row.format === 'claude') {
    return {
      vendorEvent: mapped.event,
      entry: {
        ...(mapped.matcher ? { matcher: mapped.matcher } : {}),
        hooks: [{
          type: 'command',
          command: run,
          timeout: timeoutSeconds(row.key, event),
        }],
      },
    };
  }
  if (row.format === 'cursor') {
    return {
      vendorEvent: mapped.event,
      entry: {
        command: run,
        ...(isBlocking(event) ? row.requiresFlag : {}),
      },
    };
  }
  if (row.format === 'copilot') {
    return {
      vendorEvent: mapped.event,
      entry: {
        type: 'command',
        bash: run,
        ...(mapped.matcher ? { matcher: mapped.matcher } : {}),
        timeoutSec: timeoutSeconds(row.key, event),
      },
    };
  }
  if (row.format === 'windsurf') {
    return {
      vendorEvent: mapped.event,
      entry: { command: run, show_output: false },
    };
  }
  throw new Error(`unsupported hook format: ${row.format}`);
}

function isManaged(value) {
  const encoded = JSON.stringify(value);
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

export function renderConfig(row, current = '{}') {
  const config = parseConfig(row.file, current);
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) throw new Error(`${row.file}: hooks.${event} must be an array`);
    // Keep the key even when every current entry is managed. Deleting it here
    // would re-append the generated event at the end and reshuffle foreign
    // keys (WorktreeCreate, agent-guard) relative to SessionStart / PreToolUse.
    hooks[event] = entries.filter((entry) => !isManaged(entry));
  }
  for (const event of CANONICAL_EVENTS) {
    if (!vendorEvent(row.key, event)) continue;
    const generated = hookEntry(row, event);
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

export function syncHooks({ root = ROOT, check = false } = {}) {
  const drift = [];
  for (const row of DIALECTS.filter((candidate) => candidate.file)) {
    const path = join(root, row.file);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '{}';
    const desired = renderConfig(row, current);
    if (current === desired) continue;
    drift.push(row.file);
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, desired);
    }
  }
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
