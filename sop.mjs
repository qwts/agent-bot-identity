#!/usr/bin/env node
// agent-bot sop — resolve the SOP named by ~/.config/agent-sop/config.toml.
//
// ENG-0355 as amended 2026-09-16 (qwts-agent-org docs/config.md): the file is
// schema_version = 1 and a [repos] table. repos.org is required, repos.sop and
// repos.comms are optional, and each value is owner/name@ref. A branch or tag
// is resolved to a commit with git ls-remote. A 40-hex ref is already a
// commit: ls-remote does not advertise non-tip commits, so it is not looked
// up again. org.json is fetched at the org commit and reported. Its pins are
// already commits (ENG-0282); they are not resolved or applied. The profile
// path and capability entry files are not read. Nothing is cloned, checked
// out, or executed.
//
// agentsop.ai was not reachable from this implementation. The keys above are
// the ones ENG-0355 and docs/config.md name. An unknown key is an error.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
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

// git show would run a configured textconv. cat-file prints the raw blob.
export const SOP_GIT_COMMANDS = Object.freeze(['ls-remote', 'init', 'remote', 'config', 'fetch', 'cat-file']);

const GIT_SAFETY = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'submodule.recurse=false',
  '-c', 'protocol.file.allow=always',
]);

export const USAGE = `usage: agent-bot sop [--json] [--config <path>]

Read ~/.config/agent-sop/config.toml (ENG-0355 as amended 2026-09-16),
resolve each repository ref to a commit, and report the org, sop, and
comms repositories and what the org repository's org.json pins.

Fetched content is reported, never executed or applied. With no config
file, report that no SOP is in effect and exit 0.
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
      if (!/^\[[A-Za-z0-9_-]+\]$/.test(trimmed)) {
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
    if (spec !== 'FETCH_HEAD:org.json') fail('git-refused', 'refusing to read any file other than org.json');
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

export function defaultRunGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 60_000,
    maxBuffer: ORG_JSON_LIMIT,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
    error: result.error ?? null,
  };
}

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
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\\')) return false;
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

function readOrgJson(repo, commit, { runGit, remoteUrl, makeTemp }) {
  if (!COMMIT_SHA.test(commit)) fail('org-json-unreadable', 'org.json is read at a resolved commit');
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
    const blob = callGit(runGit, [...GIT_SAFETY, '-C', dir, 'cat-file', 'blob', 'FETCH_HEAD:org.json']);
    if (blob.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      fail('org-json-unreadable', 'org.json exceeds 1 MiB; this command only reads that file');
    }
    if (blob.status !== 0) fail('org-json-unreadable', `org.json is not in ${repo}@${commit}`);
    return blob.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

export function resolveSop(options = {}) {
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

function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ');
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
  if (!report.inEffect) return `${report.message ?? 'No SOP is in effect.'}\n`;
  const lines = ['SOP in effect', ''];
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
  return `${lines.join('\n')}\n`;
}

export function parseSopArgs(argv) {
  let json = false;
  let configPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      if (argv.length !== 1) fail('usage', 'unexpected arguments');
      return { help: true, json: false, configPath: null };
    }
    if (arg === '--json') {
      if (json) fail('usage', 'unexpected arguments');
      json = true;
      continue;
    }
    if (arg === '--config') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-') || configPath) fail('usage', '--config requires a path');
      configPath = value;
      i += 1;
      continue;
    }
    fail('usage', `unexpected argument ${arg}`);
  }
  return { help: false, json, configPath };
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
  try {
    const report = resolveSop({
      home: deps.home,
      readFile: deps.readFile,
      runGit: deps.runGit,
      remoteUrl: deps.remoteUrl,
      makeTemp: deps.makeTemp,
      readOrgText: deps.readOrgText,
      configPath: parsed.configPath ?? deps.configPath,
      missingConfig: parsed.configPath ? 'error' : 'absent',
    });
    writeOut(parsed.json ? `${JSON.stringify(report)}\n` : formatSopReport(report));
    return 0;
  } catch (error) {
    writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
