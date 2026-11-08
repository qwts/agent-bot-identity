// The SOP org resolver (HQ plan §2.4, C3; #1388): the pinned org and SOP
// sources a selection names, resolved to exact commits and read there. It
// parses agent-sop.toml and org.json, runs bounded git reads, caches
// reference documents, reads workflows, and keeps the persona and last-good
// records. It imports only node built-ins and shared files, as the org module
// must. Which selection a soul's session uses is sop-selection.mjs; the
// `agent-bot sop` command and the policy activation state are sop.mjs,
// which re-exports the names it exported before this split.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import { stateDirectory } from './state-paths.mjs';

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
const PERSONA_RECORD_FIELDS = ['schemaVersion', 'recordedAt', 'configPath', 'selection', 'org', 'sop', 'persona'];
const LAST_GOOD_FIELDS = ['schemaVersion', 'updatedAt', 'org', 'sop'];

// git show would run a configured textconv. cat-file prints the raw blob.
export const SOP_GIT_COMMANDS = Object.freeze(['ls-remote', 'init', 'remote', 'config', 'fetch', 'cat-file']);

const GIT_SAFETY = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.quotePath=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'submodule.recurse=false',
  '-c', 'protocol.file.allow=always',
]);

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
  if (at === 0 || at === value.length - 1) fail('config-invalid', `${label} must be owner/name@ref`);
  const repo = at < 0 ? value : value.slice(0, at);
  const ref = at < 0 ? 'HEAD' : value.slice(at + 1);
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
    // profile org.json names (organization.profile, #190). A Markdown file at
    // the fetched commit is the catalog or skill SKILL.md read by skill.mjs.
    const profile = fetched !== undefined && isRelativePath(fetched) && !/[\u0000-\u001f\u007f]/.test(fetched) && fetched.endsWith('.json');
    const fetchedMarkdown = fetched !== undefined && isRelativePath(fetched) && !/[\u0000-\u001f\u007f]/.test(fetched) && fetched.endsWith('.md');
    const pinnedWorkflow = Boolean(doc && /^workflows\/[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/.test(doc));
    const permitted = (mode === 'blob' && (spec === 'FETCH_HEAD:org.json' || spec === `FETCH_HEAD:${PERSONA_FILE}` || spec === `FETCH_HEAD:${POLICY_FILE}` || profile || fetchedMarkdown))
      || (mode === '-p' && pinned && !doc)
      || (mode === 'blob' && pinned && doc && isRelativePath(doc) && !/[\u0000-\u001f\u007f]/.test(doc) && (doc.endsWith('.md') || pinnedWorkflow));
    if (!permitted) fail('git-refused', 'refusing to read any file other than org.json, persona.toml, policy-hooks.json, the organization profile JSON or pinned SOP Markdown/workflows/trees');
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
  // SOP refs in legacy manifests are provenance baselines, not a ceiling on
  // live governance. Capability and other source refs remain immutable pins.
  if (!(where === 'sources.sop' && entry.ref === undefined)
    && (typeof entry.ref !== 'string' || !COMMIT_SHA.test(entry.ref))) {
    errors.push(`${where}.ref must be a 40-hex commit`);
  }
  if (!isRelativePath(entry.entry)) errors.push(`${where}.entry must be a relative path`);
  if (typeof entry.summary !== 'string' || entry.summary.trim() === '') {
    errors.push(`${where}.summary must be a non-empty string`);
  }
  if (errors.length !== before) return null;
  return {
    repository: entry.repo,
    ref: entry.ref ?? 'HEAD',
    commit: entry.ref ?? null,
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
export function readRepoFile(repo, commit, file, { runGit = defaultRunGit, remoteUrl = githubRemote, makeTemp, required = true } = {}) {
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
  // Resolve once per operation, then read every document at that exact SHA.
  // An explicit user selection (including a historical SHA) remains binding.
  const sopSpec = config.repos.sop ?? { repo: pins.sources.sop.repository, ref: 'HEAD' };
  const sopCommit = resolveRepoRef(sopSpec, { runGit, remoteUrl });
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

// --- persona mapping record ---------------------------------------------------
// The pack decides which souls run in their own macOS account (ADR-0274
// decision 3; GeniusBar#66). The sandbox and the daemon's launch path read
// that decision offline, so `agent-bot sop persona` resolves the user's SOP
// online once, reads persona.toml at its commit and records the text here,
// pinned to the commit. The user's selection decides, never a soul's own
// agent-sop.toml: a soul must not choose the account it runs as.

export function personaRecordFile(options = {}) { return join(sopState(options), 'sop-persona.json'); }
export function sopLastGoodFile(options = {}) { return join(sopState(options), 'sop-last-good.json'); }

export function recordSopLastGood(report, options = {}) {
  const sop = report?.repositories?.sop;
  if (!sop || !OWNER_NAME.test(sop.repository ?? '') || !COMMIT_SHA.test(sop.commit ?? '')) return null;
  const org = report?.repositories?.org;
  const record = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    org: org && OWNER_NAME.test(org.repository ?? '') && COMMIT_SHA.test(org.commit ?? '')
      ? { repository: org.repository, commit: org.commit, ref: org.ref ?? 'HEAD' }
      : null,
    sop: { repository: sop.repository, commit: sop.commit, ref: sop.ref ?? 'HEAD' },
  };
  writePrivateJson(sopLastGoodFile(options), record, options);
  return record;
}

export function readSopLastGood(options = {}) {
  const file = sopLastGoodFile(options);
  try {
    if (lstatSync(file).isSymbolicLink()) return null;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(record) || record.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Object.keys(record).every((k) => LAST_GOOD_FIELDS.includes(k))) return null;
    if (!isObject(record.sop) || !OWNER_NAME.test(record.sop.repository ?? '') || !COMMIT_SHA.test(record.sop.commit ?? '')) return null;
    if (record.org !== null && (!isObject(record.org) || !OWNER_NAME.test(record.org.repository ?? '') || !COMMIT_SHA.test(record.org.commit ?? ''))) return null;
    if (typeof record.updatedAt !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

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
  // The selection the record was made from (#613), as the config spells it:
  // `owner/name@ref` for org, and for sop only when the config names one
  // (else org.json routes it, and `null` says so).
  const { org, sop } = report.repositories;
  const record = {
    schemaVersion: SCHEMA_VERSION,
    recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    configPath,
    selection: { org: `${org.repository}@${org.ref}`, sop: sop.selected === 'config' ? `${sop.repository}@${sop.ref}` : null },
    org: { repository: report.repositories.org.repository, commit: report.repositories.org.commit },
    sop: { repository, commit },
    persona,
  };
  writePrivateJson(personaRecordFile(options), record, options);
  return { inEffect: true, ...record };
}

const specRepository = (value) => value.slice(0, value.lastIndexOf('@')).toLowerCase();
const recordedSpec = (value) => typeof value === 'string' && value.lastIndexOf('@') > 0
  && value.lastIndexOf('@') < value.length - 1 && OWNER_NAME.test(value.slice(0, value.lastIndexOf('@')));

// Strict selection (#613, owner decision 2026-10-09): a record is current
// only for the exact selection it was made from: the same config file, the
// same org and sop `owner/name@ref` (repository names compare without case,
// refs exactly), and, where a ref is a 40-hex pin, that very commit. A record
// from before selections were kept never matches. Offline, a branch or tag
// that moved upstream is not detectable; the next `sop persona` picks it up.
// Returns why the record does not match, or null.
function personaRecordMismatch(record, config, configPath) {
  if (record.selection === undefined) return 'was recorded before agent-bot kept the selection it was made from';
  if (record.configPath !== configPath) return `was recorded from ${record.configPath}, not ${configPath}`;
  const spell = (spec) => (spec ? `${spec.repo}@${spec.ref}` : null);
  const sameSpec = (recorded, spec) => {
    if (recorded === null || spec === null) return recorded === spec;
    const at = recorded.lastIndexOf('@');
    return recorded.slice(0, at).toLowerCase() === spec.repo.toLowerCase() && recorded.slice(at + 1) === spec.ref;
  };
  const pinMatches = (spec, commit) => !spec || !COMMIT_SHA.test(spec.ref.toLowerCase()) || spec.ref.toLowerCase() === commit;
  if (!sameSpec(record.selection.org, config.repos.org)) return `is for org ${record.selection.org}, not ${spell(config.repos.org)}`;
  if (!sameSpec(record.selection.sop, config.repos.sop)) {
    return `is for sop ${record.selection.sop ?? 'from org.json'}, not ${spell(config.repos.sop) ?? 'from org.json'}`;
  }
  if (!pinMatches(config.repos.org, record.org.commit)) return `is for org commit ${record.org.commit}, not the pinned ${config.repos.org.ref}`;
  if (!pinMatches(config.repos.sop, record.sop.commit)) return `is for sop commit ${record.sop.commit}, not the pinned ${config.repos.sop.ref}`;
  return null;
}

// Offline: what the record says about the SOP the user's config selects now.
// Never throws and never runs git: a sandbox status or a launch must not
// wait on the network or fail for a missing pack. `state` is one of
//   none        no user SOP config, so no pack decides anything
//   unrecorded  a config, but `agent-bot sop persona` has not run
//   stale       the record is not for the selection the config makes now
//               (`text` is the stale record's persona.toml, or null, and
//               `digest` the record file's sha256, which an owner's approval
//               of that very record names)
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
    let raw;
    try {
      if (lstatSync(file).isSymbolicLink()) fail('persona-invalid', 'SOP persona record must not be a symlink');
      raw = readFileSync(file, 'utf8');
      record = JSON.parse(raw);
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
      && (record.selection === undefined || (isObject(record.selection)
        && Object.keys(record.selection).every((key) => ['org', 'sop'].includes(key))
        && recordedSpec(record.selection.org) && (record.selection.sop === null || recordedSpec(record.selection.sop))))
      && (record.persona === null || typeof record.persona === 'string')
      // The selection names the repositories the record's commits are for.
      && (record.selection === undefined || (specRepository(record.selection.org) === record.org.repository.toLowerCase()
        && (record.selection.sop === null || specRepository(record.selection.sop) === record.sop.repository.toLowerCase())));
    if (!sane) fail('persona-invalid', `invalid SOP persona record at ${file}; ${refresh}`);
    const pinned = { repository: record.sop.repository, commit: record.sop.commit, recordedAt: record.recordedAt };
    const stale = personaRecordMismatch(record, config, configPath);
    if (stale) {
      // `legacy`: the record predates kept selections (doctor's hint, #613).
      return { state: 'stale', ...pinned, legacy: record.selection === undefined, text: record.persona, digest: createHash('sha256').update(raw).digest('hex'),
        message: `the recorded persona mapping ${stale}; run \`agent-bot sop persona\` to record the selected SOP's mapping` };
    }
    if (record.persona === null) return { state: 'absent', ...pinned, message: `${record.sop.repository}@${record.sop.commit} has no ${PERSONA_FILE}` };
    return { state: 'recorded', ...pinned, text: record.persona };
  } catch (error) {
    return { state: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

export const POLICY_FILE = 'policy-hooks.json';

function trustNotice(report) {
  if (!report.trust?.required) return '';
  const { repo, accepted, reason } = report.trust;
  return `Trust decision: ${oneLine(reason)} (${repo}@${report.repositories.sop.commit}). ${accepted ? 'Accepted for reference documentation.' : `Documents withheld; accept with agent-bot sop trust ${repo}${report.soul ? ` --soul ${report.soul.agentId}` : ''}.`}\n`;
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

export function cachedDocuments(repo, commit, options = {}) {
  const parent = join(sopState(options), 'sop-cache');
  const recordPin = () => {
    try {
      if (options.report) recordSopLastGood(options.report, options);
      else recordSopLastGood({ repositories: { sop: { repository: repo, commit, ref: commit } } }, options);
    } catch {
      // Best-effort record so read-only SOP cache use never fails on state write.
    }
  };
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
  const cacheComplete = existsSync(cache) && (!options.includeWorkflows || existsSync(join(cache, 'workflows')));
  if (cacheComplete) {
    recordPin();
    return cache;
  }
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
    mkdirSync(join(docsDir, 'workflows'), { mode: 0o700 });
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
        else if (['100644', '100755'].includes(mode) && (name.endsWith('.md') || /^workflows\/[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/.test(path))) {
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
    if (existsSync(cache) && options.includeWorkflows && !existsSync(join(cache, 'workflows'))) {
      function thawExisting(dir) {
        if (!existsSync(dir)) return;
        chmodSync(dir, 0o700);
        for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) thawExisting(join(dir, entry.name));
      }
      thawExisting(cache);
      rmSync(cache, { recursive: true, force: true });
    }
    try { renameSync(docsDir, cache); chmodSync(cache, 0o555); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    recordPin();
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

// Read workflows/*.toml from a resolved SOP commit without modifying the local
// sop-cache or sop-last-good.json (used by `agent-bot workflow --remote`).
export function readRemoteSopWorkflows(repo, commit, options = {}) {
  if (!COMMIT_SHA.test(commit)) fail('documents-unreadable', 'remote workflows are read at a resolved commit');
  const dir = (options.makeTemp ?? (() => mkdtempSync(join(tmpdir(), 'agent-bot-sop-wf-'))))();
  const runGit = options.runGit ?? defaultRunGit;
  const run = (args) => {
    const result = callGit(runGit, [...GIT_SAFETY, ...args]);
    if (result.status !== 0) fail('documents-unreadable', `could not read ${repo}@${commit}: ${brief(result.stderr) || 'git failed'}`);
    return result.stdout;
  };
  try {
    run(['init', '--quiet', dir]);
    run(['-C', dir, 'fetch', '--depth', '1', '--no-tags', (options.remoteUrl ?? githubRemote)(repo), commit]);
    const commitText = run(['-C', dir, 'cat-file', '-p', commit]);
    const rootTree = /^tree ([0-9a-f]{40})$/m.exec(commitText)?.[1];
    if (!rootTree) fail('documents-unreadable', 'resolved SOP object is not a commit');
    const rootText = run(['-C', dir, 'cat-file', '-p', rootTree]);
    let workflowsTree = null;
    for (const line of rootText.split('\n').filter(Boolean)) {
      const entry = /^(\d{6}) (blob|tree) ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (entry && entry[2] === 'tree' && entry[4] === 'workflows') {
        workflowsTree = entry[3];
        break;
      }
    }
    if (!workflowsTree) return new Map();
    const wfText = run(['-C', dir, 'cat-file', '-p', workflowsTree]);
    const out = new Map();
    let count = 0;
    for (const line of wfText.split('\n').filter(Boolean)) {
      if (++count > 256) fail('documents-unreadable', 'SOP workflows tree has too many entries');
      const entry = /^(\d{6}) (blob|tree) ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (!entry) continue;
      const [, mode, type, , fileName] = entry;
      if (mode === '120000') fail('path-unsafe', `symlink in SOP repository: workflows/${fileName}`);
      if (type === 'blob' && ['100644', '100755'].includes(mode) && /^[A-Za-z0-9][A-Za-z0-9_-]*\.toml$/.test(fileName)) {
        const name = fileName.slice(0, -5);
        const relPath = `workflows/${fileName}`;
        const text = run(['-C', dir, 'cat-file', 'blob', `${commit}:${relPath}`]);
        if (Buffer.byteLength(text, 'utf8') > ORG_JSON_LIMIT) {
          fail('documents-unreadable', `${relPath} exceeds 1 MiB`);
        }
        out.set(name, { name, path: relPath, commit, text });
      }
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseStringArrayContent(raw, lineNo, label = 'sop') {
  const items = raw.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,]+/g) ?? [];
  const values = items.map((item) => safePath(parseValue(item, lineNo)));
  let rest = raw.trim();
  for (let i = 0; i < items.length; i += 1) {
    if (!rest.startsWith(items[i])) fail('workflow-invalid', `invalid workflow ${label} array`);
    rest = rest.slice(items[i].length).trim();
    if (rest && !rest.startsWith(',')) fail('workflow-invalid', 'workflow paths must be comma separated');
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
  }
  if (rest) fail('workflow-invalid', `invalid workflow ${label} array`);
  return values;
}

const WORKFLOW_MODES = Object.freeze(['read-only', 'local-write', 'remote-write']);
const WORKFLOW_ROOT_KEYS = Object.freeze(['schema_version', 'name', 'summary', 'sop']);
const WORKFLOW_STEP_KEYS = Object.freeze(['id', 'mode', 'description', 'gate']);

export function parseWorkflowToml(text, expectedName = null) {
  if (typeof text !== 'string') fail('workflow-invalid', 'workflow TOML must be text');
  if (text.includes('\0')) fail('workflow-invalid', 'NUL bytes are not supported in workflow TOML');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(stripComment);

  const root = {};
  const steps = [];
  let currentStep = null;
  let seenRootKeys = new Set();
  let seenStepKeys = null;
  let seenStepIds = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;

    if (trimmed === '[[steps]]') {
      if (currentStep) {
        for (const req of ['id', 'mode', 'description']) {
          if (!Object.hasOwn(currentStep, req)) fail('workflow-invalid', `workflow [[steps]] requires ${req}`);
        }
      }
      currentStep = {};
      seenStepKeys = new Set();
      steps.push(currentStep);
      continue;
    }

    if (trimmed.startsWith('[')) {
      fail('workflow-invalid', `line ${lineNo}: unsupported table header ${trimmed}; only [[steps]] is supported`);
    }

    const eq = trimmed.indexOf('=');
    if (eq <= 0) fail('workflow-invalid', `line ${lineNo}: expected key = value in workflow TOML`);
    const key = trimmed.slice(0, eq).trim();
    let rhs = trimmed.slice(eq + 1).trim();

    if (currentStep) {
      if (!WORKFLOW_STEP_KEYS.includes(key)) {
        fail('workflow-invalid', `line ${lineNo}: unsupported step key ${key}`);
      }
      if (seenStepKeys.has(key)) fail('workflow-invalid', `line ${lineNo}: duplicate step key ${key}`);
      seenStepKeys.add(key);
      const val = parseValue(rhs, lineNo);
      if (typeof val !== 'string' || val.trim() === '') {
        fail('workflow-invalid', `line ${lineNo}: step ${key} must be a non-empty string`);
      }
      if (key === 'id') {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(val)) {
          fail('workflow-invalid', `line ${lineNo}: step id must be an identifier`);
        }
        if (seenStepIds.has(val)) fail('workflow-invalid', `line ${lineNo}: duplicate step id ${val}`);
        seenStepIds.add(val);
      }
      if (key === 'mode' && !WORKFLOW_MODES.includes(val)) {
        fail('workflow-invalid', `line ${lineNo}: step mode must be one of ${WORKFLOW_MODES.join(', ')}`);
      }
      currentStep[key] = val;
      continue;
    }

    if (!WORKFLOW_ROOT_KEYS.includes(key)) {
      fail('workflow-invalid', `line ${lineNo}: unsupported workflow key ${key}`);
    }
    if (seenRootKeys.has(key)) fail('workflow-invalid', `line ${lineNo}: duplicate workflow key ${key}`);
    seenRootKeys.add(key);

    if (key === 'sop') {
      if (!rhs.startsWith('[')) fail('workflow-invalid', `line ${lineNo}: sop must be an array of paths`);
      while (!rhs.endsWith(']') && i + 1 < lines.length) {
        i += 1;
        rhs = `${rhs}\n${lines[i].trim()}`;
      }
      if (!rhs.endsWith(']')) fail('workflow-invalid', `line ${lineNo}: unterminated sop array`);
      root.sop = parseStringArrayContent(rhs.slice(1, -1), lineNo, 'sop');
    } else {
      const val = parseValue(rhs, lineNo);
      if (key === 'schema_version') {
        if (val !== 1) fail('workflow-invalid', `line ${lineNo}: workflow schema_version must be 1`);
        root.schemaVersion = 1;
      } else if (key === 'name') {
        if (typeof val !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(val)) {
          fail('workflow-invalid', `line ${lineNo}: workflow name must be a simple identifier`);
        }
        if (expectedName && val !== expectedName) {
          fail('workflow-invalid', `line ${lineNo}: workflow name ${val} does not match file name ${expectedName}`);
        }
        root.name = val;
      } else if (key === 'summary') {
        if (typeof val !== 'string' || val.trim() === '') {
          fail('workflow-invalid', `line ${lineNo}: workflow summary must be a non-empty string`);
        }
        root.summary = val;
      }
    }
  }

  if (currentStep) {
    for (const req of ['id', 'mode', 'description']) {
      if (!Object.hasOwn(currentStep, req)) fail('workflow-invalid', `workflow [[steps]] requires ${req}`);
    }
  }
  if (!Array.isArray(root.sop)) {
    fail('workflow-invalid', 'workflow TOML requires sop = ["path.md", ...]');
  }
  if (root.schemaVersion !== undefined) {
    if (!root.name) fail('workflow-invalid', 'workflow TOML with schema_version = 1 requires name');
    if (!root.summary) fail('workflow-invalid', 'workflow TOML with schema_version = 1 requires summary');
  }
  return {
    schemaVersion: root.schemaVersion ?? 1,
    name: root.name ?? expectedName ?? null,
    summary: root.summary ?? null,
    sop: root.sop,
    steps,
  };
}

function workflowPaths(report, name) {
  if (!name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) fail('path-unsafe', 'workflow must be a simple name');
  if (!report.soul) fail('workflow-invalid', '--workflow requires a current soul or --soul ID');
  const root = join(report.soul.directory, 'workflows');
  const file = containedPath(root, `${name}.toml`);
  const parsed = parseWorkflowToml(readFileSync(file, 'utf8'), name);
  return new Set(parsed.sop);
}

export function listSopDocuments(report, options = {}) {
  const filter = workflowPaths(report, options.workflow);
  const docs = new Map();
  if (report.inEffect && !(report.trust?.required && !report.trust.accepted)) {
    const { repository, commit } = report.repositories.sop;
    const cache = cachedDocuments(repository, commit, { ...options, report });
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

// Shared with the soul selection and the command (sop-selection.mjs, sop.mjs).
// sop.mjs does not re-export these.
export { COMMIT_SHA, OWNER_NAME, SCHEMA_VERSION, fail, isObject, oneLine, readConfigText, resolveSelection, safePath, sopState, trustNotice };
