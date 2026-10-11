// Identity's format contract (#645, F1 and F4, owner decision D2): the Agent
// ID, principal and transport formats, the audit receipt writer, the git
// config key names, the owner-credential refusal, tool-call display risk and
// the git hook names. Soul, host, cli and comms import these from here
// instead of identity internals, and the module map lists every export under
// `contracts`. After identity leaves this repository, a test keeps this file
// byte-identical with its copy there (ADR-0645, answer 2), so it imports
// nothing but node built-ins and the shared state-paths.mjs. Receipts are the
// same `audit.jsonl` lines at the same path, appended in-process, so they
// still work while the daemon is down.

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { interactionHome } from './state-paths.mjs';

const ID_PATTERN = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL_ID_PATTERN = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSPORT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function isAgentId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

export function validateAgentId(id) {
  if (!isAgentId(id)) {
    throw new Error(`invalid Agent ID: ${JSON.stringify(id)}`);
  }
  return id;
}

export function validatePrincipalId(value) {
  if (typeof value !== 'string' || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new Error('invalid principal ID');
  }
  return value;
}

export function validateTransport(value) {
  if (typeof value !== 'string' || !TRANSPORT_PATTERN.test(value)) {
    throw new Error('transport must be a short lowercase slug');
  }
  return value;
}

function printableText(name, value, { max = 512 } = {}) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${name} must be printable text no longer than ${max} characters`);
  }
  return value;
}

function agentIdOrThrow(value, name = 'soul') {
  try {
    return validateAgentId(value);
  } catch {
    throw new Error(`${name} must be a valid Agent ID`);
  }
}

function ensurePrivateDirectory(directory) {
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created === undefined) return;
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* POSIX modes are best-effort on other platforms. */
  }
}

// Secret-free audit receipts (#57 req 7, #31). Append-only JSONL under the
// interaction home. Only whitelisted identifier fields are recorded — never
// provider tokens, display names, or message bodies. A credential mint also
// names the App it minted for (`appSlug`) and a fixed reason code for its
// outcome (`reason`, #107); both are optional, so older readers ignore them.
// An inbox take names where its bearer came from (`bearerSource`, #229), as
// one of a fixed set of labels — the bearer itself is never recorded.
const BEARER_SOURCES = new Set(['env', 'pass-cli']);

export function auditFile({ env = process.env, home = homedir() } = {}) {
  return path.join(interactionHome({ env, home }), 'audit.jsonl');
}

// Why a receipt's decision went the way it did (#382), one line. A URL is
// never kept: a webhook's URL is a secret, and an error may carry one.
function receiptDetail(value) {
  const line = String(value).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function appendAuditReceipt(
  { event, principalId = null, transport = null, agentId = null, operation = null, decision = null, detail = null, appSlug = null, reason = null, bearerSource = null },
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  if (bearerSource !== null && !BEARER_SOURCES.has(bearerSource)) throw new Error('audit receipt bearerSource must be env or pass-cli');
  const receipt = {
    at: now().toISOString(),
    event: printableText('event', event, { max: 40 }),
    ...(principalId === null ? {} : { principalId: validatePrincipalId(principalId) }),
    ...(transport === null ? {} : { transport: validateTransport(transport) }),
    ...(agentId === null ? {} : { agentId: agentIdOrThrow(agentId, 'agentId') }),
    ...(operation === null ? {} : { operation: printableText('operation', operation, { max: 40 }) }),
    ...(decision === null ? {} : { decision: printableText('decision', decision, { max: 40 }) }),
    ...(detail === null ? {} : { detail: receiptDetail(detail) }),
    ...(appSlug === null ? {} : { appSlug: printableText('appSlug', appSlug, { max: 100 }) }),
    ...(reason === null ? {} : { reason: printableText('reason', reason, { max: 40 }) }),
    ...(bearerSource === null ? {} : { bearerSource }),
  };
  const file = auditFile({ env, home });
  ensurePrivateDirectory(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

// Git config keys. setup-worktree writes the App pin; a checkout records its
// Agent ID. Prefer the standalone name; accept the playbook-engineering name so
// a migrated machine keeps working.
export const PIN_KEYS = ['agentBot.app', 'qwts.agentApp'];
export const AGENT_ID_KEYS = ['agentBot.agentId', 'qwts.agentId'];

// The refusal every owner-only path throws when no owner credential is shown.
export function ownerCredentialRequired(message = 'an authenticated owner principal or explicit owner consent is required') {
  return Object.assign(new Error(message), { code: 'owner-credential-required', statusCode: 403 });
}

// Display risk only; permission policy remains the authority to execute.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead', 'Task', 'Agent']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'terminal', 'execute', 'shell']);
const COMPUTER_TOOLS = new Set([
  'computer', 'computer_use', 'computer-use', 'screenshot', 'left_click', 'right_click',
  'double_click', 'type', 'key', 'scroll', 'mouse_move', 'left_click_drag', 'open_application',
]);
const DESTRUCTIVE = /\brm\s+-[^\s]*r|\bgit\s+push\b[^\n;]*\s(?:--force(?:-with-lease)?|-f)\b|\bgit\s+reset\b[^\n;]*--hard\b|\bgit\s+clean\b|\bgit\s+branch\b[^\n;]*\s-D\b|\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\b|\bVACUUM\s+FULL\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bkill\s+-9\b|\blaunchctl\s+unload\b|\bdefaults\s+write\b|\b(?:chmod|chown)\s+-R\b|>\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|fd\/)|:\(\)\s*\{/i;

function toolSegment(toolName) {
  return toolName.replace(/^mcp__.+?__/, '');
}

export function isComputerUse(toolName) {
  return typeof toolName === 'string' && (
    toolName.startsWith('mcp__computer-use__')
    || toolName.startsWith('mcp__remote-devices__computer_')
    || COMPUTER_TOOLS.has(toolSegment(toolName))
  );
}

export function classifyRisk(input) {
  if (!input || typeof input !== 'object') return 'external';
  const { toolName, summary, operation } = input;
  if (typeof toolName !== 'string' || !toolName) return 'external';
  // A computer-use server can expose read-like names while using the screen.
  if (isComputerUse(toolName)) return 'external';
  const tool = toolSegment(toolName);
  if (READ_TOOLS.has(tool) || (toolName.startsWith('mcp__') && /^(?:get_|list_|read_|search_|fetch_context)/.test(tool))) return 'safe';
  if (WRITE_TOOLS.has(toolName)) return 'safe';
  if (!SHELL_TOOLS.has(toolName)) return 'external';
  let operationText = '';
  try { operationText = typeof operation === 'string' ? operation : JSON.stringify(operation) ?? ''; }
  catch { return 'external'; }
  const text = [typeof summary === 'string' ? summary : '', operationText].join('\n').slice(0, 2000);
  return DESTRUCTIVE.test(text) ? 'destructive' : 'external';
}

// Git hook names installed and exposed by agent-bot. Keep this inventory
// explicit: the sibling chain-hook is an internal dispatcher, never a public
// hook and never copied into the command surface.

export const GIT_HOOK_NAMES = [
  'applypatch-msg',
  'commit-msg',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'p4-prepare-changelist',
  'post-applypatch',
  'post-checkout',
  'post-commit',
  'post-index-change',
  'post-merge',
  'post-rewrite',
  'pre-applypatch',
  'pre-auto-gc',
  'pre-commit',
  'pre-merge-commit',
  'pre-push',
  'pre-rebase',
  'prepare-commit-msg',
  'reference-transaction',
  'sendemail-validate',
];
