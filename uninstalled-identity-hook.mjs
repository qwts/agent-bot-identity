#!/usr/bin/env node

// Explicit uninstalled / ephemeral identity-hook mode (ENG-0128 amendment).
// Generated adapters call the installed agent-hook when it exists. When it
// does not, they run the shell this module emits — not `exit 0`. Absence of
// the binary is not a license to commit, push, or write to GitHub as the
// human. An unmanaged session may publish only when the actor is in
// AGENT_BOT_UNMANAGED_AUTHORS. Reads and uncommitted working-tree edits stay
// allowed.
//
// The fallback is self-contained so a fleet clone (playbook, photos, …) that
// has the generated adapter but not this file still enforces the same policy.

import process from 'node:process';
import { spawnSync } from 'node:child_process';
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
    if (ch === "&") {
      if (text[i + 1] === "&") i += 1;
      if (current.trim()) segments.push(current);
      current = "";
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

function commandEnvAssignments(argv) {
  const assigned = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "command" || arg === "exec" || arg === "env") {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-") && arg.includes("=") && !arg.includes("/")) {
      const eq = arg.indexOf("=");
      assigned[arg.slice(0, eq)] = arg.slice(eq + 1);
      i += 1;
      continue;
    }
    break;
  }
  return assigned;
}

function parseAuthorIdent(raw) {
  const text = String(raw || "").trim();
  const lt = text.lastIndexOf(" <");
  if (lt > 0 && text.endsWith(">")) {
    return { name: text.slice(0, lt).trim(), email: text.slice(lt + 2, -1).trim() };
  }
  if (text.includes("@") && !text.includes(" ")) return { name: "", email: text };
  return { name: text, email: "" };
}

function gitCommitAuthorOverride(argv) {
  let i = skipEnvAndWrappers(argv);
  const bin = argv[i] ?? "";
  if (bin !== "git" && !bin.endsWith("/git")) return "";
  i += 1;
  const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  let seenCommit = false;
  let author = "";
  while (i < argv.length) {
    const arg = argv[i];
    if (!seenCommit) {
      if (arg === "commit") {
        seenCommit = true;
        i += 1;
        continue;
      }
      if (arg === "push") return "";
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
      return "";
    }
    if (arg === "--author" && argv[i + 1] !== undefined) {
      author = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg.startsWith("--author=")) {
      author = arg.slice("--author=".length);
      i += 1;
      continue;
    }
    i += 1;
  }
  return seenCommit ? author : "";
}

function gitCommitReusesAuthor(argv) {
  let i = skipEnvAndWrappers(argv);
  const bin = argv[i] ?? "";
  if (bin !== "git" && !bin.endsWith("/git")) return false;
  i += 1;
  const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  let seenCommit = false;
  let reuses = false;
  let reset = false;
  let hasAuthor = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (!seenCommit) {
      if (arg === "commit") {
        seenCommit = true;
        i += 1;
        continue;
      }
      if (arg === "push") return false;
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
      return false;
    }
    if (arg === "--amend" || arg === "-C" || arg === "--reuse-message" || arg === "-c" || arg === "--reedit-message") {
      reuses = true;
    }
    if (arg.startsWith("--reuse-message=") || arg.startsWith("--reedit-message=")) reuses = true;
    if (arg === "--reset-author") reset = true;
    if (arg === "--author" || arg.startsWith("--author=")) hasAuthor = true;
    if (
      (arg === "-C" || arg === "--reuse-message" || arg === "-c" || arg === "--reedit-message" || arg === "--author")
      && argv[i + 1] !== undefined
    ) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return seenCommit && reuses && !reset && !hasAuthor;
}

function extractDollarParen(text, start) {
  let depth = 1;
  let quote = null;
  const single = "\u0027";
  const double = "\u0022";
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === single || ch === double) {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start, i), end: i };
    }
  }
  return null;
}

function commandSubstitutions(command) {
  const text = String(command || "");
  const found = [];
  let quote = null;
  const single = "\u0027";
  const double = "\u0022";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === single) {
      if (ch === single) quote = null;
      continue;
    }
    if (ch === double && quote === double) {
      quote = null;
      continue;
    }
    if (!quote && (ch === single || ch === double)) {
      quote = ch;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      const inner = extractDollarParen(text, i + 2);
      if (inner) {
        found.push(inner.value);
        i = inner.end;
      }
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        found.push(text.slice(i + 1, end));
        i = end;
      }
    }
  }
  return found;
}

function gitPublishSubcommand(argv) {
  let i = skipEnvAndWrappers(argv);
  const bin = argv[i] ?? "";
  if (bin !== "git" && !bin.endsWith("/git")) return "";
  i += 1;
  const takesValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "commit" || arg === "push") return arg;
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
    return arg === "commit" || arg === "push" ? arg : "";
  }
  return "";
}

function isGitPublishArgv(argv) {
  const sub = gitPublishSubcommand(argv);
  return sub === "commit" || sub === "push";
}

export function parseUnmanagedAuthors(env = {}) {
  const raw = env.AGENT_BOT_UNMANAGED_AUTHORS;
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function identMatches(value, authors) {
  if (!value || !authors.length) return false;
  const lower = String(value).trim().toLowerCase();
  if (authors.includes(lower)) return true;
  const at = lower.indexOf("@");
  return at > 0 && authors.includes(lower.slice(0, at));
}

function resolveGitAuthor(env = {}) {
  const name = env.GIT_AUTHOR_NAME || "";
  const email = env.GIT_AUTHOR_EMAIL || "";
  if (name || email) return { name, email };
  try {
    const nameRun = spawnSync("git", ["config", "--get", "user.name"], {
      encoding: "utf8",
      timeout: 2000,
      env,
    });
    const emailRun = spawnSync("git", ["config", "--get", "user.email"], {
      encoding: "utf8",
      timeout: 2000,
      env,
    });
    return {
      name: (nameRun.stdout || "").trim(),
      email: (emailRun.stdout || "").trim(),
    };
  } catch {
    return { name: "", email: "" };
  }
}

function resolveGhLogin(env = {}) {
  try {
    const run = spawnSync("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf8",
      timeout: 4000,
      env,
    });
    if (run.status === 0) return (run.stdout || "").trim().toLowerCase();
  } catch {}
  return "";
}

function isUnmanagedGitAuthor(env, authors, command) {
  const argv = tokenizeCommand(command);
  if (gitCommitReusesAuthor(argv)) return false;
  const merged = Object.assign({}, env, commandEnvAssignments(argv));
  const override = gitCommitAuthorOverride(argv);
  const ident = override ? parseAuthorIdent(override) : resolveGitAuthor(merged);
  return identMatches(ident.name, authors) || identMatches(ident.email, authors);
}

function isUnmanagedGhActor(env, authors) {
  return authors.includes(resolveGhLogin(env));
}

function unmanagedPublishAllowed(command, env, authors, depth) {
  if (!authors.length) return false;
  if (depth == null) depth = 0;
  if (depth > 8) return false;
  for (const segment of commandSegments(command)) {
    const argv = tokenizeCommand(segment);
    const gitSub = gitPublishSubcommand(argv);
    if (gitSub === "commit" && !isUnmanagedGitAuthor(env, authors, segment)) return false;
    if (gitSub === "push" && !isUnmanagedGhActor(env, authors)) return false;
    if (isGhWriteArgv(argv) && !isUnmanagedGhActor(env, authors)) return false;
    const nested = shellPayload(argv);
    if (nested && isHumanAttributedPublish(nested, depth + 1)
      && !unmanagedPublishAllowed(nested, env, authors, depth + 1)) {
      return false;
    }
  }
  for (const nested of commandSubstitutions(command)) {
    if (isHumanAttributedPublish(nested, depth + 1)
      && !unmanagedPublishAllowed(nested, env, authors, depth + 1)) {
      return false;
    }
  }
  return isHumanAttributedPublish(command);
}

function ghApiWrites(rest) {
  if (rest.includes("graphql")) return true;
  let method = "";
  let hasParams = false;
  for (let j = 0; j < rest.length; j += 1) {
    const arg = rest[j];
    if ((arg === "-X" || arg === "--method") && rest[j + 1]) {
      method = String(rest[j + 1]).toUpperCase();
      j += 1;
      continue;
    }
    if (arg.startsWith("--method=")) {
      method = arg.slice("--method=".length).toUpperCase();
      continue;
    }
    if (arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field" || arg === "--input") {
      hasParams = true;
      continue;
    }
    if (
      arg.startsWith("-f")
      || arg.startsWith("-F")
      || arg.startsWith("--raw-field=")
      || arg.startsWith("--field=")
      || arg.startsWith("--input=")
    ) {
      hasParams = true;
    }
  }
  if (method === "GET" || method === "HEAD") return false;
  if (method) return true;
  return hasParams;
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
  const sub = argv[i + 1] || "";
  if (!cmd) return false;
  if (cmd === "api") return ghApiWrites(argv.slice(i + 1));
  const readSubs = {
    pr: ["view", "list", "status", "diff", "checks", "checkout"],
    issue: ["view", "list", "status"],
    repo: ["view", "list"],
    release: ["view", "list", "download"],
    gist: ["view", "list"],
    run: ["list", "view", "watch"],
    workflow: ["list", "view"],
    search: ["issues", "prs", "repos", "commits", "code"],
    auth: ["status"],
    config: ["get", "list"],
    alias: ["list"],
    cache: ["list"],
    label: ["list"],
    project: ["list", "view"],
    org: ["list"],
    ruleset: ["list", "view"],
    secret: ["list"],
    variable: ["list"],
    attestation: ["download", "verify"],
    browse: [""],
    help: [""],
    status: [""],
  };
  const allowed = readSubs[cmd];
  if (!allowed) return true;
  return !allowed.includes(sub);
}

function shellPayload(argv) {
  let i = skipEnvAndWrappers(argv);
  const base = (argv[i] ?? "").split("/").pop();
  if (base !== "sh" && base !== "bash" && base !== "zsh" && base !== "dash" && base !== "ksh") {
    return null;
  }
  i += 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-c" && argv[i + 1] !== undefined) return argv[i + 1];
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c") && argv[i + 1] !== undefined) {
      return argv[i + 1];
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return null;
}

export function isHumanAttributedPublish(command, depth) {
  if (depth == null) depth = 0;
  if (depth > 8) return true;
  for (const segment of commandSegments(command)) {
    const argv = tokenizeCommand(segment);
    if (isGitPublishArgv(argv) || isGhWriteArgv(argv)) return true;
    const nested = shellPayload(argv);
    if (nested && isHumanAttributedPublish(nested, depth + 1)) return true;
  }
  for (const nested of commandSubstitutions(command)) {
    if (isHumanAttributedPublish(nested, depth + 1)) return true;
  }
  return false;
}

export function uninstalledDecision({ event, command = "", env = {} }) {
  const authors = parseUnmanagedAuthors(env);
  if (event === "pre-commit") {
    if (authors.length && isUnmanagedGitAuthor(env, authors, command)) {
      return { decision: "allow", reason: "" };
    }
    return { decision: "deny", reason: UNINSTALLED_REASON };
  }
  if (event === "pre-push") {
    if (authors.length && isUnmanagedGhActor(env, authors)) {
      return { decision: "allow", reason: "" };
    }
    return { decision: "deny", reason: UNINSTALLED_REASON };
  }
  if (event === "pre-command" && isHumanAttributedPublish(command)) {
    if (unmanagedPublishAllowed(command, env, authors)) {
      return { decision: "allow", reason: "" };
    }
    return { decision: "deny", reason: UNINSTALLED_REASON };
  }
  return { decision: "allow", reason: "" };
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
  commandEnvAssignments,
  parseAuthorIdent,
  gitCommitAuthorOverride,
  gitCommitReusesAuthor,
  extractDollarParen,
  commandSubstitutions,
  gitPublishSubcommand,
  isGitPublishArgv,
  parseUnmanagedAuthors,
  identMatches,
  resolveGitAuthor,
  resolveGhLogin,
  isUnmanagedGitAuthor,
  isUnmanagedGhActor,
  ghApiWrites,
  isGhWriteArgv,
  shellPayload,
  isHumanAttributedPublish,
  unmanagedPublishAllowed,
  uninstalledDecision,
].map((fn) => fn.toString()).join('\n');

function eventDecisionFallback(allow, deny, event) {
  const program = `import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const UNINSTALLED_REASON = ${JSON.stringify(UNINSTALLED_REASON)};
${DETECT_SOURCE}
const allow = ${JSON.stringify(allow)};
const deny = ${JSON.stringify(deny)};
let raw = "";
try { if (!process.stdin.isTTY) raw = readFileSync(0, "utf8"); } catch {}
let payload = {};
try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch {}
if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
const verdict = uninstalledDecision({
  event: ${JSON.stringify(event)},
  command: extractCommand(payload, process.env),
  env: process.env,
});
const encoded = verdict.decision === "deny" ? deny : allow;
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
  if (event === 'pre-commit' || event === 'pre-push' || event === 'pre-command') {
    return eventDecisionFallback(allow, deny, event);
  }
  return emitShellDecision(allow);
}

export function decideUninstalledHook({ dialectKey, event, payload = {}, env = process.env }) {
  const { decision, reason } = uninstalledDecision({
    event,
    command: extractCommand(payload, env),
    env,
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
