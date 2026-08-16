#!/usr/bin/env node

// Explicit uninstalled / ephemeral identity-hook mode (ENG-0128 amendment).
// Generated adapters call the installed agent-hook when it exists. When it
// does not, they run the shell this module emits — not `exit 0`. Absence of
// the binary is not a license to commit, push, or write to GitHub as the
// human. Reads and uncommitted working-tree edits stay allowed.
//
// The fallback is self-contained so a fleet clone (playbook, photos, …) that
// has the generated adapter but not this file still enforces the same policy.

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { encodeDecision } from './hook-dialects.mjs';

export const UNINSTALLED_REASON = 'uninstalled identity: refuse human-attributed commit or GitHub write; finish durable bootstrap to publish as the bot';

function extractCommand(payload, env = {}) {
  if (typeof env.AGENT_HOOK_TOOL_COMMAND === "string" && env.AGENT_HOOK_TOOL_COMMAND) {
    return env.AGENT_HOOK_TOOL_COMMAND;
  }
  if (!payload || typeof payload !== "object") return "";
  return payload.command
    || payload.tool_input?.command
    || payload.toolArgs?.command
    || payload.tool_info?.command_line
    || payload.tool_input?.cmd
    || "";
}

function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  const single = "\u0027";
  const double = "\u0022";
  for (const ch of String(command || "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === single || ch === double) {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandSegments(command) {
  const text = String(command || "");
  const segments = [];
  let current = "";
  let quote = null;
  const single = "\u0027";
  const double = "\u0022";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === single || ch === double) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      if (current.trim()) segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&" && text[i + 1] === "&") {
      if (current.trim()) segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (text[i + 1] === "|") i += 1;
      if (current.trim()) segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current);
  return segments;
}

function skipEnvAndWrappers(argv) {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "command" || arg === "exec" || arg === "env") {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-") && arg.includes("=") && !arg.includes("/")) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function isGitPublishArgv(argv) {
  let i = skipEnvAndWrappers(argv);
  const bin = argv[i] ?? "";
  if (bin !== "git" && !bin.endsWith("/git")) return false;
  i += 1;
  const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "commit" || arg === "push") return true;
    if (takesValue.has(arg)) {
      i += 2;
      continue;
    }
    if (
      arg.startsWith("--git-dir=")
      || arg.startsWith("--work-tree=")
      || arg.startsWith("--namespace=")
      || arg.startsWith("--config-env=")
    ) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    return arg === "commit" || arg === "push";
  }
  return false;
}

function isGhWriteArgv(argv) {
  let i = skipEnvAndWrappers(argv);
  const bin = argv[i] ?? "";
  if (bin !== "gh" && !bin.endsWith("/gh")) return false;
  i += 1;
  const takesValue = new Set(["-R", "--repo", "--hostname"]);
  while (i < argv.length && argv[i].startsWith("-")) {
    if (takesValue.has(argv[i])) i += 2;
    else i += 1;
  }
  const cmd = argv[i];
  const sub = argv[i + 1];
  if (cmd === "pr") {
    return new Set([
      "create", "edit", "merge", "ready", "review", "comment", "close", "reopen", "lock", "unlock",
    ]).has(sub);
  }
  if (cmd === "issue") {
    return new Set([
      "create", "edit", "comment", "close", "delete", "pin", "unpin", "transfer", "develop", "reopen",
    ]).has(sub);
  }
  if (cmd === "api") {
    const rest = argv.slice(i + 1);
    if (rest.includes("graphql")) return true;
    for (let j = 0; j < rest.length; j += 1) {
      if ((rest[j] === "-X" || rest[j] === "--method") && rest[j + 1]) {
        const method = String(rest[j + 1]).toUpperCase();
        return method !== "GET" && method !== "HEAD";
      }
    }
    return false;
  }
  if (cmd === "repo") return new Set(["create", "delete", "edit", "sync", "archive", "rename"]).has(sub);
  if (cmd === "release") return new Set(["create", "delete", "edit", "upload"]).has(sub);
  if (cmd === "gist") return new Set(["create", "edit", "delete"]).has(sub);
  return false;
}

export function isHumanAttributedPublish(command) {
  for (const segment of commandSegments(command)) {
    const argv = tokenizeCommand(segment);
    if (isGitPublishArgv(argv) || isGhWriteArgv(argv)) return true;
  }
  return false;
}

export function uninstalledDecision({ event, command = '' }) {
  if (event === 'pre-commit' || event === 'pre-push') {
    return { decision: 'deny', reason: UNINSTALLED_REASON };
  }
  if (event === 'pre-command' && isHumanAttributedPublish(command)) {
    return { decision: 'deny', reason: UNINSTALLED_REASON };
  }
  return { decision: 'allow', reason: '' };
}

function shQuote(value) {
  return `'${String(value).replaceAll('\'', `'\\''`)}'`;
}

function emitShellDecision({ stdout, stderr, exitCode }) {
  const parts = [];
  if (stdout) parts.push(`printf '%s' ${shQuote(stdout)}`);
  if (stderr) parts.push(`printf '%s\\n' ${shQuote(stderr)} >&2`);
  parts.push(`exit ${exitCode}`);
  return parts.join('; ');
}

const DETECT_SOURCE = [
  extractCommand,
  tokenizeCommand,
  commandSegments,
  skipEnvAndWrappers,
  isGitPublishArgv,
  isGhWriteArgv,
  isHumanAttributedPublish,
].map((fn) => fn.toString()).join('\n');

function preCommandFallback(allow, deny) {
  const program = `import { readFileSync } from "node:fs";
${DETECT_SOURCE}
const allow = ${JSON.stringify(allow)};
const deny = ${JSON.stringify(deny)};
let raw = "";
try { if (!process.stdin.isTTY) raw = readFileSync(0, "utf8"); } catch {}
let payload = {};
try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch {}
if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
const encoded = isHumanAttributedPublish(extractCommand(payload, process.env)) ? deny : allow;
if (encoded.stdout) process.stdout.write(encoded.stdout);
if (encoded.stderr) process.stderr.write(encoded.stderr + "\\n");
process.exit(encoded.exitCode);
`;
  if (program.includes("'")) {
    throw new Error("uninstalled fallback must stay single-quote-free so adapters can wrap it");
  }
  return `node --input-type=module -e ${shQuote(program)}`;
}

export function adapterFallback(dialectKey, event) {
  const allow = encodeDecision({ dialectKey, event, decision: 'allow' });
  const deny = encodeDecision({
    dialectKey,
    event,
    decision: 'deny',
    reason: UNINSTALLED_REASON,
  });
  if (event === 'pre-commit' || event === 'pre-push') return emitShellDecision(deny);
  if (event !== 'pre-command') return emitShellDecision(allow);
  return preCommandFallback(allow, deny);
}

export function decideUninstalledHook({ dialectKey, event, payload = {}, env = process.env }) {
  const { decision, reason } = uninstalledDecision({
    event,
    command: extractCommand(payload, env),
  });
  return encodeDecision({ dialectKey, event, decision, reason });
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let dialectKey = null;
  let event = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dialect' || arg === '--event') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--dialect') dialectKey = value;
      else event = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!dialectKey || !event) throw new Error('--dialect and --event are required');
  let raw = '';
  try {
    if (!process.stdin.isTTY) raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const encoded = decideUninstalledHook({ dialectKey, event, payload, env });
  if (encoded.stdout) process.stdout.write(encoded.stdout);
  if (encoded.stderr) process.stderr.write(`${encoded.stderr}\n`);
  return encoded.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`uninstalled-identity-hook: ${error.message}\n`);
    process.exitCode = 1;
  }
}
