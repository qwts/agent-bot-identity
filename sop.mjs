#!/usr/bin/env node
// agent-bot sop — resolve per-soul SOP selections and read reference documents.
//
// ENG-0355 as amended 2026-09-16 (qwts-agent-org docs/config.md): the file is
// schema_version = 1 and a [repos] table. repos.org is required, repos.sop and
// repos.comms are optional, and each value is owner/name@ref. A branch or tag
// is resolved to a commit with git ls-remote. A 40-hex ref is already a
// commit: ls-remote does not advertise non-tip commits, so it is not looked
// up again. org.json is fetched at the org commit and reported. Its pins are
// already commits (ENG-0282); they are not resolved or applied. Capability
// entry files are not read. The organization profile is read at the org
// commit only for `bootstrap --repair` (#190). SOP Markdown is read on
// demand. Nothing is cloned, checked out, or executed.
//
// agentsop.ai was not reachable from this implementation. The keys above are
// the ones ENG-0355 and docs/config.md name. An unknown key is an error.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { currentAgentId, stateDirectory, withLock } from './agent-identity.mjs';
import { soulDirectory } from './agent-population.mjs';
import { readBinding } from './agent-binding.mjs';
import process from 'node:process';
import { assertOwnerAction } from './owner-action.mjs';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const ORG_JSON_LIMIT = 1024 * 1024;
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA_ANY_CASE = /^[0-9a-fA-F]{40}$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO_KEYS = ['org', 'sop', 'comms'];
const PIN_FIELDS = ['repo', 'ref', 'entry', 'summary'];
const ORG_FIELDS = ['schema_version', 'organization', 'sources', 'capabilities'];
const ORGANIZATION_FIELDS = ['id', 'account', 'profile'];
// The SOP pack's persona mapping (ADR-0274 decision 3), at the SOP
// repository's root. agent-bot sandbox parses it; this file reads, records
// and reports it.
export const PERSONA_FILE = 'persona.toml';
const PERSONA_RECORD_FIELDS = ['schemaVersion', 'recordedAt', 'configPath', 'org', 'sop', 'persona'];

// git show would run a configured textconv. cat-file prints the raw blob.
export const SOP_GIT_COMMANDS = Object.freeze(['ls-remote', 'init', 'remote', 'config', 'fetch', 'cat-file']);

const GIT_SAFETY = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.quotePath=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'submodule.recurse=false',
  '-c', 'protocol.file.allow=always',
]);

export const USAGE = `usage: agent-bot sop [--json] [--config <path>] [--soul ID]
       agent-bot sop list [--soul ID] [--workflow NAME] [--json]
       agent-bot sop show PATH [--soul ID] [--workflow NAME]
       agent-bot sop trust REPO [--soul ID]
       agent-bot sop persona [--json]

Resolve the soul's agent-sop.toml, then ~/.config/agent-sop/config.toml
(ENG-0355), then no SOP. The soul's sop/ documents override repository
Markdown at the same path. workflows/NAME.toml lists sop = ["path.md"].
Foreign soul selections require explicit trust of the resolved repo + commit.
Fetched documents are cached read-only and never executed or applied;
reference documentation does not override harness or user instructions.
With no config file, report that no SOP is in effect and exit 0.
persona resolves the user's SOP, reads persona.toml at its commit (the
pack's persona mapping: which souls run in their own macOS account) and
records it for offline use by agent-bot sandbox and the daemon's launch.
`;

export class SopError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SopError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SopError(code, message);
}

export function configPathFor(home = homedir()) {
  return join(home, '.config', 'agent-sop', 'config.toml');
}

export function githubRemote(repo) {
  return `https://github.com/${repo}.git`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseBasicString(raw, lineNo) {
  if (raw.startsWith('"""')) fail('config-unsupported', `line ${lineNo}: multiline strings are not supported`);
  let out = '';
  for (let i = 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      if (raw.slice(i + 1).trim() !== '') fail('config-unsupported', `line ${lineNo}: trailing characters after a string`);
      return out;
    }
    if (ch === '\\') {
      const next = raw[i + 1];
      const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
      if (Object.hasOwn(simple, next)) {
        out += simple[next];
        i += 1;
        continue;
      }
      if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('config-unsupported', `line ${lineNo}: bad \\u escape`);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 5;
        continue;
      }
      fail('config-unsupported', `line ${lineNo}: unsupported string escape \\${next ?? ''}`);
    }
    out += ch;
  }
  fail('config-unsupported', `line ${lineNo}: unterminated string`);
}

function parseLiteralString(raw, lineNo) {
  if (raw.startsWith("'''")) fail('config-unsupported', `line ${lineNo}: multiline strings are not supported`);
  const end = raw.indexOf("'", 1);
  if (end < 0) fail('config-unsupported', `line ${lineNo}: unterminated string`);
  if (raw.slice(end + 1).trim() !== '') fail('config-unsupported', `line ${lineNo}: trailing characters after a string`);
  return raw.slice(1, end);
}

function parseValue(raw, lineNo) {
  if (raw.startsWith('"')) return parseBasicString(raw, lineNo);
  if (raw.startsWith("'")) return parseLiteralString(raw, lineNo);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    fail('config-unsupported', `line ${lineNo}: arrays and inline tables are not supported`);
  }
  if (raw === 'true' || raw === 'false') fail('config-unsupported', `line ${lineNo}: booleans are not supported`);
  if (/^(0|[1-9][0-9]*)$/.test(raw)) return Number(raw);
  fail('config-unsupported', `line ${lineNo}: unsupported value (strings and integers only)`);
}

// The subset this file uses: comments, [table], integers, and quoted strings.
// Anything else fails closed so a future key cannot be skipped silently.
export function parseTomlSubset(text) {
  if (typeof text !== 'string') fail('config-invalid', 'config must be text');
  if (text.includes('\0')) fail('config-unsupported', 'NUL bytes are not supported');
  const source = text.replace(/^\uFEFF/, '');
  const root = {};
  const tables = {};
  let table = null;
  const seen = new Set();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const trimmed = stripComment(lines[index]).trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('[')) {
      // [table] and [table.sub] headers, kept flat as "table.sub".
      if (!/^\[[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\]$/.test(trimmed)) {
        fail('config-unsupported', `line ${lineNo}: only [table] headers are supported`);
      }
      table = trimmed.slice(1, -1);
      if (Object.hasOwn(tables, table)) fail('config-invalid', `line ${lineNo}: duplicate table [${table}]`);
      tables[table] = {};
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) fail('config-unsupported', `line ${lineNo}: expected key = value`);
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      fail('config-unsupported', `line ${lineNo}: unsupported key ${key}`);
    }
    const path = table ? `${table}.${key}` : key;
    if (seen.has(path)) fail('config-invalid', `line ${lineNo}: duplicate key ${path}`);
    seen.add(path);
    const value = parseValue(raw, lineNo);
    if (table) tables[table][key] = value;
    else root[key] = value;
  }
  return { root, tables };
}

function isSafeRef(ref) {
  if (ref === 'HEAD' || SHA_ANY_CASE.test(ref)) return true;
  if (ref.length === 0 || ref.length > 255) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{') || ref.includes('\\')) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) return false;
  return ref.split('/').every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.endsWith('.')
    && !segment.endsWith('.lock')
  ));
}

function parseRepoRef(value, label) {
  if (typeof value !== 'string') fail('config-invalid', `${label} must be owner/name@ref`);
  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) fail('config-invalid', `${label} must be owner/name@ref`);
  const repo = value.slice(0, at);
  const ref = value.slice(at + 1);
  if (!OWNER_NAME.test(repo) || !isSafeRef(ref)) fail('config-invalid', `${label} must be owner/name@ref`);
  // ls-remote does not resolve an abbreviated commit, and a short hex string
  // must not be mistaken for one. It is not looked up as a branch either.
  if (/^[0-9a-fA-F]{7,39}$/.test(ref)) {
    fail('config-invalid', `${label} must be a branch, a tag, or a 40-hex commit`);
  }
  return { repo, ref };
}

export function loadSopConfig(text) {
  const { root, tables } = parseTomlSubset(text);
  for (const key of Object.keys(root)) {
    if (key !== 'schema_version') {
      fail('config-invalid', `unsupported key ${key}; this file allows schema_version and [repos] only`);
    }
  }
  if (root.schema_version !== SCHEMA_VERSION) {
    fail('config-invalid', `schema_version must be the integer 1 (got ${JSON.stringify(root.schema_version)})`);
  }
  for (const name of Object.keys(tables)) {
    if (name !== 'repos') fail('config-invalid', `unsupported table [${name}]`);
  }
  const repos = tables.repos;
  if (!repos) fail('config-invalid', 'missing [repos] table');
  for (const key of Object.keys(repos)) {
    if (!REPO_KEYS.includes(key)) fail('config-invalid', `unsupported repos.${key}; expected org, sop, and comms`);
  }
  if (!Object.hasOwn(repos, 'org')) fail('config-invalid', 'repos.org is required');
  return {
    schemaVersion: SCHEMA_VERSION,
    repos: {
      org: parseRepoRef(repos.org, 'repos.org'),
      sop: Object.hasOwn(repos, 'sop') ? parseRepoRef(repos.sop, 'repos.sop') : null,
      comms: Object.hasOwn(repos, 'comms') ? parseRepoRef(repos.comms, 'repos.comms') : null,
    },
  };
}

export function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-c' || arg === '-C') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}

export function assertSopGitCommand(args) {
  const sub = gitSubcommand(args);
  if (!SOP_GIT_COMMANDS.includes(sub)) {
    fail('git-refused', `refusing git ${sub || '(none)'}: this command resolves refs and reads org.json, and does not clone, check out, or execute fetched content`);
  }
  if (sub === 'config' && (args.includes('--global') || args.includes('--system'))) {
    fail('git-refused', 'refusing to change git config outside the temporary read');
  }
  if (['config', 'fetch', 'cat-file', 'remote'].includes(sub) && !args.includes('-C')) {
    fail('git-refused', `refusing unscoped git ${sub}`);
  }
  if (sub === 'cat-file') {
    const spec = args.at(-1);
    const mode = args[args.indexOf('cat-file') + 1];
    const pinned = /^([0-9a-f]{40})(?::(.*))?$/.exec(spec ?? '');
    const doc = pinned?.[2];
    const fetched = /^FETCH_HEAD:(.*)$/.exec(spec ?? '')?.[1];
    // A JSON file beside org.json at the fetched commit is the organization
    // profile org.json names (organization.profile, #190).
    const profile = fetched !== undefined && isRelativePath(fetched) && !/[\u0000-\u001f\u007f]/.test(fetched) && fetched.endsWith('.json');
    const permitted = (mode === 'blob' && (spec === 'FETCH_HEAD:org.json' || spec === `FETCH_HEAD:${PERSONA_FILE}` || profile))
      || (mode === '-p' && pinned && !doc)
      || (mode === 'blob' && pinned && doc && isRelativePath(doc) && !/[\u0000-\u001f\u007f]/.test(doc) && doc.endsWith('.md'));
    if (!permitted) fail('git-refused', 'refusing to read any file other than org.json, persona.toml, the organization profile JSON or pinned SOP Markdown/trees');
  }
}

function callGit(runGit, args) {
  assertSopGitCommand(args);
  let result;
  try {
    result = runGit(args);
  } catch (error) {
    fail('git-failed', error instanceof Error ? error.message : String(error));
  }
  if (!result || typeof result !== 'object') fail('git-failed', 'git runner returned no result');
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error ?? null,
  };
}

// Git runs hermetically: no ambient GIT_* overrides (GIT_CONFIG_COUNT pairs,
// GIT_DIR and friends), no system or global config (so no url.*.insteadOf
// rewrite or helper), and only the transports this read needs (https; never
// ext:: or other command transports).
export function sopGitEnv(base = process.env, { allowProtocols = 'https' } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: allowProtocols,
    GIT_TERMINAL_PROMPT: '0',
  });
}

export function createRunGit({ env = process.env, allowProtocols = 'https' } = {}) {
  const gitEnv = sopGitEnv(env, { allowProtocols });
  return function runGit(args) {
    const result = spawnSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: gitEnv,
      timeout: 60_000,
      maxBuffer: ORG_JSON_LIMIT,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr || (result.error ? result.error.message : ''),
      error: result.error ?? null,
    };
  };
}

export const defaultRunGit = createRunGit();

function brief(text) {
  const line = String(text ?? '').split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function queriesFor(ref) {
  if (ref === 'HEAD') return ['HEAD'];
  if (ref.startsWith('refs/tags/')) return [ref, `${ref}^{}`];
  if (ref.startsWith('refs/')) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
}

function parseLsRemote(stdout) {
  const entries = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) fail('ref-unresolved', 'git ls-remote returned an unreadable line');
    const sha = line.slice(0, tab).toLowerCase();
    const name = line.slice(tab + 1).trim();
    if (!COMMIT_SHA.test(sha) || name === '') fail('ref-unresolved', 'git ls-remote returned an unreadable line');
    entries.push({ sha, name });
  }
  return entries;
}

function findExact(entries, name) {
  const hits = entries.filter((entry) => entry.name === name);
  if (new Set(hits.map((hit) => hit.sha)).size > 1) fail('ref-unresolved', `ambiguous ref ${name}`);
  return hits[0]?.sha ?? null;
}

function pickCommit(ref, entries) {
  if (ref === 'HEAD' || ref.startsWith('refs/heads/')) return findExact(entries, ref);
  if (ref.startsWith('refs/')) return findExact(entries, `${ref}^{}`) ?? findExact(entries, ref);
  return findExact(entries, `refs/heads/${ref}`)
    ?? findExact(entries, `refs/tags/${ref}^{}`)
    ?? findExact(entries, `refs/tags/${ref}`);
}

function resolveRepoRef(spec, { runGit, remoteUrl }) {
  if (SHA_ANY_CASE.test(spec.ref)) return spec.ref.toLowerCase();
  const url = remoteUrl(spec.repo);
  const result = callGit(runGit, [...GIT_SAFETY, 'ls-remote', url, ...queriesFor(spec.ref)]);
  if (result.status !== 0) {
    fail('ref-unresolved', `could not resolve ${spec.repo}@${spec.ref}: ${brief(result.stderr) || 'git ls-remote failed'}`);
  }
  const commit = pickCommit(spec.ref, parseLsRemote(result.stdout));
  if (!commit) fail('ref-unresolved', `no commit for ${spec.repo}@${spec.ref}`);
  return commit;
}

// JSON.parse keeps the last of two equal keys. Walk the raw text so a pin
// pasted twice cannot silently replace the first. Same approach as the org
// repository's validator.
function duplicateKeys(raw) {
  const found = [];
  const stack = [];
  let pending = null;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      pending = JSON.parse(raw.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '{') stack.push({ keys: new Set(), key: null });
    else if (ch === '[') stack.push({ keys: null, key: null });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ':') {
      const frame = stack.at(-1);
      if (frame?.keys && pending !== null) {
        frame.key = pending;
        const dotted = stack.filter((item) => item.keys).map((item) => item.key).join('.');
        if (frame.keys.has(pending)) found.push(dotted);
        frame.keys.add(pending);
      }
    }
    if (ch === '{' || ch === '[' || ch === '}' || ch === ']' || ch === ':' || ch === ',') pending = null;
    i += 1;
  }
  return found;
}

function isRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function readPin(entry, where, errors) {
  if (!isObject(entry)) {
    errors.push(`${where} must be an object with repo, ref, entry, and summary`);
    return null;
  }
  const before = errors.length;
  for (const field of Object.keys(entry)) {
    if (!PIN_FIELDS.includes(field)) errors.push(`${where} has unknown field ${JSON.stringify(field)}`);
  }
  if (typeof entry.repo !== 'string' || !OWNER_NAME.test(entry.repo)) {
    errors.push(`${where}.repo must be owner/name`);
  }
  if (typeof entry.ref !== 'string' || !COMMIT_SHA.test(entry.ref)) {
    errors.push(`${where}.ref must be a 40-hex commit`);
  }
  if (!isRelativePath(entry.entry)) errors.push(`${where}.entry must be a relative path`);
  if (typeof entry.summary !== 'string' || entry.summary.trim() === '') {
    errors.push(`${where}.summary must be a non-empty string`);
  }
  if (errors.length !== before) return null;
  return {
    repository: entry.repo,
    ref: entry.ref,
    commit: entry.ref,
    entry: entry.entry,
    summary: entry.summary,
  };
}

export function parseOrgPins(text) {
  if (typeof text !== 'string') fail('org-json-invalid', 'org.json must be text');
  if (Buffer.byteLength(text) > ORG_JSON_LIMIT) {
    fail('org-json-unreadable', 'org.json exceeds 1 MiB; this command only reads that file');
  }
  const raw = text.replace(/^\uFEFF/, '');
  let org;
  try {
    org = JSON.parse(raw);
  } catch (error) {
    fail('org-json-invalid', `org.json is not valid JSON (${error.message})`);
  }
  const errors = duplicateKeys(raw).map((dotted) => `duplicate key ${dotted}`);
  if (!isObject(org)) errors.push('org.json must be a JSON object');
  else {
    for (const key of Object.keys(org)) {
      if (!ORG_FIELDS.includes(key)) errors.push(`unknown field ${JSON.stringify(key)}`);
    }
    if (org.schema_version !== SCHEMA_VERSION) {
      errors.push(`schema_version must be 1 (got ${JSON.stringify(org.schema_version)})`);
    }
    const organization = org.organization;
    if (!isObject(organization)) errors.push('organization must be an object with id, account, and profile');
    else {
      for (const field of Object.keys(organization)) {
        if (!ORGANIZATION_FIELDS.includes(field)) errors.push(`organization has unknown field ${JSON.stringify(field)}`);
      }
      if (typeof organization.id !== 'string' || organization.id.trim() === '') errors.push('organization.id must be a non-empty string');
      if (typeof organization.account !== 'string' || organization.account.trim() === '') {
        errors.push('organization.account must be a non-empty string');
      }
      if (!isRelativePath(organization.profile)) errors.push('organization.profile must be a relative path');
    }
    if (!isObject(org.sources)) errors.push('sources must be an object');
    else if (!Object.hasOwn(org.sources, 'sop')) errors.push('sources.sop is required');
    if (!isObject(org.capabilities)) errors.push('capabilities must be an object');
  }
  const sources = {};
  const capabilities = {};
  if (isObject(org?.sources)) {
    for (const name of Object.keys(org.sources).sort()) {
      if (!KEBAB.test(name)) errors.push(`sources key ${JSON.stringify(name)} is not kebab-case`);
      const pin = readPin(org.sources[name], `sources.${name}`, errors);
      if (pin) sources[name] = pin;
    }
  }
  if (isObject(org?.capabilities)) {
    for (const name of Object.keys(org.capabilities).sort()) {
      if (!KEBAB.test(name)) errors.push(`capabilities key ${JSON.stringify(name)} is not kebab-case`);
      const pin = readPin(org.capabilities[name], `capabilities.${name}`, errors);
      if (pin) capabilities[name] = pin;
    }
  }
  if (errors.length > 0) fail('org-json-invalid', `org.json: ${errors.join('; ')}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    organization: {
      id: org.organization.id,
      account: org.organization.account,
      profile: org.organization.profile,
    },
    sources,
    capabilities,
  };
}

// One file at a pinned commit, through a temporary blobless read: org.json
// (which must exist) or persona.toml (null when the commit has none).
function readRepoFile(repo, commit, file, { runGit, remoteUrl, makeTemp, required = true }) {
  if (!COMMIT_SHA.test(commit)) fail('org-json-unreadable', `${file} is read at a resolved commit`);
  const dir = (makeTemp ?? (() => mkdtempSync(join(tmpdir(), 'agent-bot-sop-'))))();
  const url = remoteUrl(repo);
  try {
    const init = callGit(runGit, [...GIT_SAFETY, 'init', '--quiet', dir]);
    if (init.status !== 0) fail('org-json-unreadable', `could not prepare a temporary read of ${repo}: ${brief(init.stderr) || 'git init failed'}`);
    for (const args of [
      [...GIT_SAFETY, '-C', dir, 'remote', 'add', 'origin', url],
      [...GIT_SAFETY, '-C', dir, 'config', 'remote.origin.promisor', 'true'],
      [...GIT_SAFETY, '-C', dir, 'config', 'remote.origin.partialclonefilter', 'blob:none'],
    ]) {
      const step = callGit(runGit, args);
      if (step.status !== 0) fail('org-json-unreadable', `could not prepare a temporary read of ${repo}: ${brief(step.stderr) || 'git failed'}`);
    }
    const fetched = callGit(runGit, [
      ...GIT_SAFETY, '-C', dir, 'fetch', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', commit,
    ]);
    if (fetched.status !== 0) {
      fail('org-json-unreadable', `could not fetch ${repo}@${commit}: ${brief(fetched.stderr) || 'git fetch failed'}`);
    }
    const blob = callGit(runGit, [...GIT_SAFETY, '-C', dir, 'cat-file', 'blob', `FETCH_HEAD:${file}`]);
    if (blob.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      fail('org-json-unreadable', `${file} exceeds 1 MiB; this command only reads that file`);
    }
    if (blob.status !== 0) {
      if (!required) return null;
      fail('org-json-unreadable', `${file} is not in ${repo}@${commit}`);
    }
    return blob.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readOrgJson(repo, commit, options) {
  return readRepoFile(repo, commit, 'org.json', options);
}

function readConfigText(path, readFile) {
  try {
    return readFile(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('config-unreadable', `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function repoRecord(spec, commit, selected) {
  return { repository: spec.repo, ref: spec.ref, commit, selected };
}

function resolveSelection(options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const runGit = options.runGit ?? defaultRunGit;
  const remoteUrl = options.remoteUrl ?? githubRemote;
  const text = Object.hasOwn(options, 'configText') ? options.configText : readConfigText(configPath, readFile);
  if (text === null) {
    if (options.missingConfig === 'error') fail('config-unreadable', `could not read ${configPath}: no such file`);
    return { inEffect: false, message: 'No SOP is in effect.', configPath };
  }
  const config = loadSopConfig(text);
  const orgCommit = resolveRepoRef(config.repos.org, { runGit, remoteUrl });
  const orgText = options.readOrgText
    ? options.readOrgText(config.repos.org.repo, orgCommit)
    : readOrgJson(config.repos.org.repo, orgCommit, { runGit, remoteUrl, makeTemp: options.makeTemp });
  const pins = parseOrgPins(orgText);
  const sopSpec = config.repos.sop ?? { repo: pins.sources.sop.repository, ref: pins.sources.sop.ref };
  const sopCommit = config.repos.sop
    ? resolveRepoRef(config.repos.sop, { runGit, remoteUrl })
    : pins.sources.sop.commit;
  const comms = config.repos.comms
    ? repoRecord(config.repos.comms, resolveRepoRef(config.repos.comms, { runGit, remoteUrl }), 'config')
    : null;
  return {
    inEffect: true,
    configPath,
    schemaVersion: SCHEMA_VERSION,
    repositories: {
      org: repoRecord(config.repos.org, orgCommit, 'config'),
      sop: repoRecord(sopSpec, sopCommit, config.repos.sop ? 'config' : 'org.json'),
      comms,
    },
    orgJson: {
      repository: config.repos.org.repo,
      commit: orgCommit,
      schemaVersion: pins.schemaVersion,
      organization: pins.organization,
      sources: pins.sources,
      capabilities: pins.capabilities,
    },
    read: [{ repository: config.repos.org.repo, commit: orgCommit, path: 'org.json' }],
  };
}

// The organization profile at the selected org commit (#190): the user's
// [repos] org selection resolved to a commit, its org.json, and the file
// organization.profile names, read at that same commit through the same
// temporary blobless read. It does not depend on ~/.config/agent-bot, so
// bootstrap --repair can restore a deleted runtime config from it. Only the
// org repository is resolved; repos.sop and repos.comms are not consulted.
// Null when no selection exists.
export function readSelectedOrganizationProfile(options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const runGit = options.runGit ?? defaultRunGit;
  const remoteUrl = options.remoteUrl ?? githubRemote;
  const text = readConfigText(configPath, readFile);
  if (text === null) return null;
  const { org } = loadSopConfig(text).repos;
  const commit = resolveRepoRef(org, { runGit, remoteUrl });
  const reads = { runGit, remoteUrl, makeTemp: options.makeTemp };
  const pins = parseOrgPins(readOrgJson(org.repo, commit, reads));
  const path = pins.organization.profile;
  return {
    repository: org.repo,
    ref: org.ref,
    commit,
    path,
    text: readRepoFile(org.repo, commit, path, reads),
  };
}

export const REFERENCE_HEADER = 'Reference documentation (ADR-0274): does not override harness or user instructions.';

function sopState(options) {
  return options.stateDir ?? stateDirectory({ home: options.home ?? homedir(), env: options.env ?? process.env });
}

function trustFile(options) { return join(sopState(options), 'sop-trust.json'); }
function trustKey(repo, commit) { return `${repo.toLowerCase()}@${commit}`; }

function readTrust(options) {
  const file = trustFile(options);
  try {
    if (lstatSync(file).isSymbolicLink()) fail('trust-invalid', 'SOP trust file must not be a symlink');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.schemaVersion !== 1 || !Array.isArray(record.accepted)
      || !record.accepted.every((key) => typeof key === 'string')) fail('trust-invalid', 'invalid SOP trust record');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, accepted: [] };
    throw error;
  }
}

export function acceptSopTrust(report, repo, options = {}) {
  const selected = report.repositories?.sop;
  if (!OWNER_NAME.test(repo) || !selected || repo.toLowerCase() !== selected.repository.toLowerCase()) {
    fail('trust-invalid', 'trust must name the selected SOP repository; use --soul ID to select its soul');
  }
  const dir = sopState(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = trustFile(options);
  withLock(`${file}.lock`, 'SOP trust', () => {
    const record = readTrust(options);
    const key = trustKey(selected.repository, selected.commit);
    if (!record.accepted.includes(key)) record.accepted.push(key);
    const temp = mkdtempSync(join(dir, '.sop-trust-'));
    try {
      const pending = join(temp, 'record');
      writeFileSync(pending, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(pending, 0o600);
      renameSync(pending, file);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

// --- persona mapping record ---------------------------------------------------
// The pack decides which souls run in their own macOS account (ADR-0274
// decision 3; GeniusBar#66). The sandbox and the daemon's launch path read
// that decision offline, so `agent-bot sop persona` resolves the user's SOP
// online once, reads persona.toml at its commit and records the text here,
// pinned to the commit. The user's selection decides, never a soul's own
// agent-sop.toml: a soul must not choose the account it runs as.

export function personaRecordFile(options = {}) { return join(sopState(options), 'sop-persona.json'); }

function writePrivateJson(file, value, options) {
  const dir = sopState(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(dir, '.sop-persona-'));
  try {
    const pending = join(temp, 'record');
    writeFileSync(pending, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(pending, 0o600);
    renameSync(pending, file);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

// Online: resolve the user's SOP (only that selection), read persona.toml at
// the SOP commit and record it. Returns the record. `readPersonaText(repo,
// commit)` is injectable for tests; it answers null for a commit without the file.
export function recordSopPersona(options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const userText = Object.hasOwn(options, 'configText') ? options.configText : readConfigText(configPath, readFile);
  const report = resolveSelection({ ...options, configText: userText, configPath, missingConfig: 'absent' });
  if (!report.inEffect) {
    try { rmSync(personaRecordFile(options), { force: true }); } catch { /* nothing recorded */ }
    return { inEffect: false, message: report.message, configPath };
  }
  const { repository, commit } = report.repositories.sop;
  const runGit = options.runGit ?? defaultRunGit;
  const remoteUrl = options.remoteUrl ?? githubRemote;
  const persona = options.readPersonaText
    ? options.readPersonaText(repository, commit)
    : readRepoFile(repository, commit, PERSONA_FILE, { runGit, remoteUrl, makeTemp: options.makeTemp, required: false });
  if (persona !== null && (typeof persona !== 'string' || persona.includes('\0') || Buffer.byteLength(persona) > ORG_JSON_LIMIT)) {
    fail('persona-unreadable', `${PERSONA_FILE} in ${repository}@${commit} must be text of at most 1 MiB`);
  }
  const record = {
    schemaVersion: SCHEMA_VERSION,
    recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    configPath,
    org: { repository: report.repositories.org.repository, commit: report.repositories.org.commit },
    sop: { repository, commit },
    persona,
  };
  writePrivateJson(personaRecordFile(options), record, options);
  return { inEffect: true, ...record };
}

// Offline: what the record says about the SOP the user's config selects now.
// Never throws and never runs git: a sandbox status or a launch must not
// wait on the network or fail for a missing pack. `state` is one of
//   none        no user SOP config, so no pack decides anything
//   unrecorded  a config, but `agent-bot sop persona` has not run
//   stale       the record is for another org or SOP repository than the config names
//   absent      the SOP commit has no persona.toml
//   error       the config or the record could not be read
//   recorded    `text` is the pack's persona.toml at `commit`
export function readSopPersonaRecord(options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const file = personaRecordFile(options);
  const refresh = 'run `agent-bot sop persona` to record it';
  try {
    const userText = readConfigText(configPath, readFile);
    if (userText === null) return { state: 'none', message: 'No SOP is in effect.' };
    const config = loadSopConfig(userText);
    let record;
    try {
      if (lstatSync(file).isSymbolicLink()) fail('persona-invalid', 'SOP persona record must not be a symlink');
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { state: 'unrecorded', message: `the SOP's persona mapping is not recorded; ${refresh}` };
      throw error;
    }
    const sane = isObject(record) && record.schemaVersion === SCHEMA_VERSION
      && Object.keys(record).every((key) => PERSONA_RECORD_FIELDS.includes(key))
      && isObject(record.org) && isObject(record.sop)
      && OWNER_NAME.test(record.org.repository ?? '') && COMMIT_SHA.test(record.org.commit ?? '')
      && OWNER_NAME.test(record.sop.repository ?? '') && COMMIT_SHA.test(record.sop.commit ?? '')
      && typeof record.recordedAt === 'string'
      && (record.persona === null || typeof record.persona === 'string');
    if (!sane) fail('persona-invalid', `invalid SOP persona record at ${file}; ${refresh}`);
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    const stale = !same(record.org.repository, config.repos.org.repo)
      || (config.repos.sop && !same(record.sop.repository, config.repos.sop.repo));
    const pinned = { repository: record.sop.repository, commit: record.sop.commit, recordedAt: record.recordedAt };
    if (stale) return { state: 'stale', ...pinned, message: `the recorded persona mapping is for ${record.sop.repository}, not the SOP the config selects; ${refresh}` };
    if (record.persona === null) return { state: 'absent', ...pinned, message: `${record.sop.repository}@${record.sop.commit} has no ${PERSONA_FILE}` };
    return { state: 'recorded', ...pinned, text: record.persona };
  } catch (error) {
    return { state: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function trustNotice(report) {
  if (!report.trust?.required) return '';
  const { repo, accepted, reason } = report.trust;
  return `Trust decision: ${oneLine(reason)} (${repo}@${report.repositories.sop.commit}). ${accepted ? 'Accepted for reference documentation.' : `Documents withheld; accept with agent-bot sop trust ${repo}${report.soul ? ` --soul ${report.soul.agentId}` : ''}.`}\n`;
}

export function resolveSop(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  let current = null;
  if (!options.soul) {
    try { current = (options.currentAgentId ?? currentAgentId)({ env, cwd: options.cwd ?? process.cwd() }); }
    catch (error) { if (error.status !== 128) throw error; }
  }
  const identity = options.soul ?? current
    ?? (options.readBinding ?? readBinding)({ env, cwd: options.cwd ?? process.cwd() })?.agentId;
  const soulDir = identity ? (options.soulDirectory ?? soulDirectory)(identity, { home, env, ...options.populationOptions }) : null;
  const userPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const soulPath = soulDir ? join(soulDir, 'agent-sop.toml') : null;
  const soulText = soulPath ? readConfigText(soulPath, readFile) : null;
  const userText = Object.hasOwn(options, 'configText') ? options.configText : readConfigText(userPath, readFile);
  const source = soulText !== null ? 'soul' : userText !== null ? 'user' : 'none';
  const report = resolveSelection({ ...options, configText: soulText ?? userText, configPath: soulText !== null ? soulPath : userPath });
  report.selection = { source, path: source === 'none' ? null : report.configPath };
  if (soulDir) report.soul = { agentId: identity, directory: soulDir };
  if (source === 'soul') {
    // Resolve the user's effective SOP too: it can be selected through org.json.
    const user = userText === null ? null : resolveSelection({ ...options, configText: userText, configPath: userPath });
    const foreign = !user
      || user.repositories.org.repository.toLowerCase() !== report.repositories.org.repository.toLowerCase()
      || user.repositories.sop.repository.toLowerCase() !== report.repositories.sop.repository.toLowerCase();
    if (foreign) {
      const { repository: repo, commit } = report.repositories.sop;
      report.trust = {
        required: true,
        reason: user ? 'Soul selects a different organization or SOP repository from the user' : 'Soul selects an SOP repository without a user selection',
        repo,
        accepted: readTrust(options).accepted.includes(trustKey(repo, commit)),
      };
    }
  }
  return report;
}

function safePath(path) {
  if (!isRelativePath(path) || /[\u0000-\u001f\u007f]/.test(path)) fail('path-unsafe', `unsafe relative document path: ${JSON.stringify(path)}`);
  return path;
}

function containedPath(root, path) {
  safePath(path);
  if (lstatSync(root).isSymbolicLink()) fail('path-unsafe', 'document root must not be a symlink');
  const file = join(root, path);
  const rel = relative(realpathSync(root), realpathSync(file));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) fail('path-unsafe', `symlink escapes document root: ${path}`);
  return file;
}

function walkDocuments(root, source, commit) {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) fail('path-unsafe', 'document root must not be a symlink');
  const docs = [];
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      safePath(path);
      const file = containedPath(root, path);
      // Directory links can introduce cycles; refuse them, even within the root.
      if (entry.isSymbolicLink()) {
        if (lstatSync(realpathSync(file)).isDirectory()) fail('path-unsafe', `symlink directory: ${path}`);
        if (source === 'sop') fail('path-unsafe', `symlink in SOP cache: ${path}`);
      }
      if (entry.isDirectory()) walk(file, `${path}/`);
      else if (path.endsWith('.md')) {
        if (!lstatSync(realpathSync(file)).isFile()) fail('path-unsafe', `not a document file: ${path}`);
        docs.push({ path, source, ...(commit ? { commit } : {}) });
      }
    }
  }
  walk(root);
  return docs;
}

function cachedDocuments(repo, commit, options) {
  const parent = join(sopState(options), 'sop-cache');
  if (options.offline) {
    const cache = join(parent, commit);
    if (!existsSync(cache)) fail('documents-unavailable-offline', 'Pinned SOP documents are not cached locally');
    if (!lstatSync(parent).isDirectory() || !lstatSync(cache).isDirectory()) fail('path-unsafe', 'SOP cache must be regular directories');
    return cache;
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink()) fail('path-unsafe', 'SOP cache must not be a symlink');
  chmodSync(parent, 0o700);
  const cache = join(parent, commit);
  if (existsSync(cache)) return cache;
  const staging = mkdtempSync(join(parent, '.read-'));
  const gitDir = join(staging, 'git');
  const docsDir = join(staging, 'documents');
  const runGit = options.runGit ?? defaultRunGit;
  const run = (args) => {
    const result = callGit(runGit, [...GIT_SAFETY, ...args]);
    if (result.status !== 0) fail('documents-unreadable', `could not read ${repo}@${commit}: ${brief(result.stderr) || 'git failed'}`);
    return result.stdout;
  };
  try {
    run(['init', '--quiet', gitDir]);
    run(['-C', gitDir, 'fetch', '--depth', '1', '--no-tags', (options.remoteUrl ?? githubRemote)(repo), commit]);
    const commitText = run(['-C', gitDir, 'cat-file', '-p', commit]);
    const tree = /^tree ([0-9a-f]{40})$/m.exec(commitText)?.[1];
    if (!tree) fail('documents-unreadable', 'resolved SOP object is not a commit');
    mkdirSync(docsDir, { mode: 0o700 });
    let count = 0;
    function readTree(sha, prefix = '', depth = 0) {
      if (depth > 64) fail('documents-unreadable', 'SOP tree is too deep');
      const treeText = run(['-C', gitDir, 'cat-file', '-p', sha]);
      for (const line of treeText.split('\n').filter(Boolean)) {
        if (++count > 10000) fail('documents-unreadable', 'SOP tree has too many entries');
        const entry = /^(\d{6}) (blob|tree) ([0-9a-f]{40})\t(.+)$/.exec(line);
        if (!entry || entry[4].startsWith('"') || entry[4].includes('/')) fail('path-unsafe', 'unsupported SOP tree path');
        const [, mode, type, oid, name] = entry;
        const path = safePath(prefix + name);
        if (mode === '120000') fail('path-unsafe', `symlink in SOP repository: ${path}`);
        if (type === 'tree') readTree(oid, `${path}/`, depth + 1);
        else if (['100644', '100755'].includes(mode) && name.endsWith('.md')) {
          const text = run(['-C', gitDir, 'cat-file', 'blob', `${commit}:${path}`]);
          const file = join(docsDir, path);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, text, { mode: 0o444, flag: 'wx' });
          chmodSync(file, 0o444);
        }
      }
    }
    readTree(tree);
    function freeze(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) freeze(join(dir, entry.name));
      chmodSync(dir, 0o555);
    }
    freeze(docsDir);
    // macOS needs write permission on the moved directory to update its parent.
    chmodSync(docsDir, 0o700);
    try { renameSync(docsDir, cache); chmodSync(cache, 0o555); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    return cache;
  } finally {
    // A losing concurrent builder must make its own staging tree removable.
    function thaw(dir) {
      if (!existsSync(dir)) return;
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) thaw(join(dir, entry.name));
    }
    thaw(docsDir);
    rmSync(staging, { recursive: true, force: true });
  }
}

function workflowPaths(report, name) {
  if (!name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) fail('path-unsafe', 'workflow must be a simple name');
  if (!report.soul) fail('workflow-invalid', '--workflow requires a current soul or --soul ID');
  const root = join(report.soul.directory, 'workflows');
  const file = containedPath(root, `${name}.toml`);
  const text = readFileSync(file, 'utf8');
  // Deliberately small TOML schema: one top-level sop array of quoted paths.
  const content = text.split(/\r?\n/).map(stripComment).join('\n').trim();
  const match = /^sop\s*=\s*\[([\s\S]*)\]\s*$/.exec(content);
  if (!match) fail('workflow-invalid', 'workflow TOML requires sop = ["path.md", ...] only');
  const items = match[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,]+/g) ?? [];
  const paths = items.map((item) => safePath(parseValue(item, 1)));
  // Reparse the separators, rather than silently accepting missing commas.
  let rest = match[1].trim();
  for (let i = 0; i < items.length; i++) {
    if (!rest.startsWith(items[i])) fail('workflow-invalid', 'invalid workflow sop array');
    rest = rest.slice(items[i].length).trim();
    if (rest && !rest.startsWith(',')) fail('workflow-invalid', 'workflow paths must be comma separated');
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
  }
  if (rest) fail('workflow-invalid', 'invalid workflow sop array');
  return new Set(paths);
}

export function listSopDocuments(report, options = {}) {
  const filter = workflowPaths(report, options.workflow);
  const docs = new Map();
  if (report.inEffect && !(report.trust?.required && !report.trust.accepted)) {
    const { repository, commit } = report.repositories.sop;
    const cache = cachedDocuments(repository, commit, options);
    for (const doc of walkDocuments(cache, 'sop', commit)) docs.set(doc.path, doc);
  }
  if (report.soul) {
    for (const doc of walkDocuments(join(report.soul.directory, 'sop'), 'soul')) docs.set(doc.path, doc);
  }
  return [...docs.values()].filter((doc) => !filter || filter.has(doc.path)).sort((a, b) => a.path.localeCompare(b.path));
}

export function showSopDocument(report, path, options = {}) {
  safePath(path);
  const filter = workflowPaths(report, options.workflow);
  if (filter && !filter.has(path)) fail('workflow-refused', `document ${path} is outside workflow ${options.workflow}'s SOP list`);
  const documents = options.documents ?? listSopDocuments(report, options);
  const doc = documents.find((entry) => entry.path === path);
  if (!doc) {
    if (report.trust?.required && !report.trust.accepted) fail('trust-required', trustNotice(report).trim());
    fail('document-missing', `SOP document not found: ${path}`);
  }
  const root = doc.source === 'soul' ? join(report.soul.directory, 'sop') : join(sopState(options), 'sop-cache', doc.commit);
  return readFileSync(containedPath(root, path), 'utf8');
}

// org.json values are untrusted: fold line breaks and drop C0/C1 controls
// and DEL so a value cannot move the cursor or restyle the terminal.
function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function appendRepo(lines, role, repo) {
  lines.push(`${role}:`);
  if (!repo) {
    lines.push('  none');
    return;
  }
  lines.push(`  repository: ${repo.repository}`);
  lines.push(`  ref: ${repo.ref}`);
  lines.push(`  commit: ${repo.commit}`);
  lines.push(`  selected: ${repo.selected}`);
}

export function formatSopReport(report) {
  if (!report.inEffect) return `${report.message ?? 'No SOP is in effect.'}\n${trustNotice(report)}`;
  const lines = ['SOP in effect', ''];
  if (report.soul) {
    lines.push(`soul: ${report.soul.agentId}`, `selection: ${report.selection.source} (${oneLine(report.selection.path)})`, '');
  }
  for (const role of ['org', 'sop', 'comms']) {
    appendRepo(lines, role, report.repositories[role]);
    lines.push('');
  }
  const pinned = report.orgJson;
  lines.push(`org.json at ${pinned.repository}@${pinned.commit} (reported, not applied):`);
  lines.push(`  organization: ${oneLine(pinned.organization.id)}`);
  lines.push(`  account: ${oneLine(pinned.organization.account)}`);
  lines.push(`  profile: ${oneLine(pinned.organization.profile)}`);
  for (const [name, source] of Object.entries(pinned.sources)) {
    lines.push(`  source ${name}: ${source.repository}@${source.commit}`);
    lines.push(`    entry: ${oneLine(source.entry)}`);
    lines.push(`    summary: ${oneLine(source.summary)}`);
  }
  const capabilities = Object.entries(pinned.capabilities);
  if (capabilities.length === 0) lines.push('  capabilities: none');
  for (const [name, capability] of capabilities) {
    lines.push(`  capability ${name}: ${capability.repository}@${capability.commit}`);
    lines.push(`    entry: ${oneLine(capability.entry)}`);
    lines.push(`    summary: ${oneLine(capability.summary)}`);
  }
  return `${lines.join('\n')}\n${trustNotice(report)}`;
}

export function formatPersonaRecord(result) {
  if (!result.inEffect) return `${result.message ?? 'No SOP is in effect.'} Nothing recorded.\n`;
  const lines = [`SOP ${result.sop.repository}@${result.sop.commit}`];
  if (result.mapping) {
    const { rules, default: fallback } = result.mapping;
    lines.push(`persona mapping recorded: ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}, default ${fallback.sandbox ?? 'user setting'}${fallback.account ? ` (account ${fallback.account})` : ''}`);
    for (const rule of rules) lines.push(`  ${rule.match}:${rule.value}: ${rule.sandbox}${rule.account ? ` as ${rule.account}` : ''}`);
    lines.push('agent-bot sandbox status shows what each soul gets.');
  } else if (result.error) {
    lines.push(`persona mapping recorded, but invalid: ${oneLine(result.error.message)}`, 'Launches are refused until the pack is fixed (#613).');
  } else {
    lines.push(`no ${PERSONA_FILE} at this commit: the user's sandbox setting applies.`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseSopArgs(argv) {
  const parsed = { help: false, json: false, configPath: null, soul: null, workflow: null, command: 'report', target: null };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { ...parsed, help: true };
  let i = 0;
  if (['list', 'show', 'trust', 'persona'].includes(argv[0])) {
    parsed.command = argv[i++];
    if (['show', 'trust'].includes(parsed.command)) {
      parsed.target = argv[i++];
      if (!parsed.target || parsed.target.startsWith('-')) fail('usage', `${parsed.command} requires a path or repository`);
    }
  }
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json' && !parsed.json) { parsed.json = true; continue; }
    const key = { '--config': 'configPath', '--soul': 'soul', '--workflow': 'workflow' }[arg];
    if (key && !parsed[key] && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      parsed[key] = argv[++i];
      continue;
    }
    fail('usage', `unexpected arguments: ${arg}`);
  }
  if (parsed.workflow && !['list', 'show'].includes(parsed.command)) fail('usage', '--workflow requires list or show');
  if (parsed.json && ['show', 'trust'].includes(parsed.command)) fail('usage', '--json requires report, list or persona');
  if (parsed.command === 'persona' && (parsed.soul || parsed.configPath)) fail('usage', 'persona reads the user\'s SOP selection only');
  return parsed;
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const writeOut = deps.writeStdout ?? ((text) => { process.stdout.write(text); });
  const writeErr = deps.writeStderr ?? ((text) => { process.stderr.write(text); });
  let parsed;
  try {
    parsed = parseSopArgs(argv);
  } catch (error) {
    writeErr(`agent-bot sop: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    writeOut(USAGE);
    return 0;
  }
  if (parsed.command === 'persona') {
    // The pack's persona mapping, read online and recorded for the sandbox
    // (ADR-0274 decision 3). The parser lives beside the sandbox, which
    // owns account names; it is imported here on demand to keep sop.mjs
    // free of that dependency.
    return import('./sandbox.mjs').then(({ parsePersonaMapping }) => {
      const record = recordSopPersona(deps);
      const result = { ...record, persona: undefined, mapping: null, error: null };
      if (record.inEffect && record.persona !== null) {
        try { result.mapping = parsePersonaMapping(record.persona); }
        catch (error) { result.error = { code: error.code ?? 'persona-invalid', message: error.message }; }
      }
      writeOut(parsed.json ? `${JSON.stringify(result)}\n` : formatPersonaRecord(result));
      return result.error ? 1 : 0;
    }, (error) => {
      writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    });
  }
  try {
    const options = {
      ...deps,
      soul: parsed.soul ?? deps.soul,
      configPath: parsed.configPath ?? deps.configPath,
      missingConfig: parsed.configPath ? 'error' : 'absent',
    };
    const report = resolveSop(options);
    if (parsed.command === 'trust') {
      // Trusting another org's SOP is the owner's decision (ADR-0332
      // decision 9): a soul must not accept its own selection.
      const assertOwner = deps.assertOwner ?? ((action) => assertOwnerAction(action));
      return Promise.resolve()
        .then(() => assertOwner(`trusting SOP repository ${parsed.target}`))
        .then(() => {
          acceptSopTrust(report, parsed.target, options);
          writeOut(`Trusted ${report.repositories.sop.repository}@${report.repositories.sop.commit} for reference documentation.\n`);
          return 0;
        }, (error) => {
          writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        });
    }
    if (parsed.command === 'report') {
      writeOut(parsed.json ? `${JSON.stringify(report)}\n` : formatSopReport(report));
    } else {
      if (parsed.command === 'show') safePath(parsed.target);
      const documents = listSopDocuments(report, { ...options, workflow: parsed.workflow });
      if (parsed.command === 'list') {
        writeOut(parsed.json ? `${JSON.stringify({ ...report, documents })}\n`
          : `${trustNotice(report)}${documents.map((doc) => `${oneLine(doc.path)} (${doc.source}${doc.commit ? ` @ ${doc.commit}` : ''})`).join('\n')}${documents.length ? '\n' : ''}`);
      } else {
        const content = showSopDocument(report, parsed.target, { ...options, workflow: parsed.workflow, documents });
        writeOut(`${REFERENCE_HEADER}\n${content}`);
      }
    }
    return 0;
  } catch (error) {
    writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  Promise.resolve(main()).then((code) => { process.exitCode = code; });
}
