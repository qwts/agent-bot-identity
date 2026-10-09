#!/usr/bin/env node
// Per-soul runtimes and harness installs (#583 slice 3, ADR-0583 decision
// 6; #322, ADR-0322). A soul declares `runtimes.node|python|go` and
// `harnesses.<h>.install` in its soul.json; this module resolves them
// through the pin catalog (runtime-catalog.mjs), provisions them under
// `<soul>/.soul-state/runtimes/` and builds the PATH and env a launch
// routes through. Nothing is installed on the host: only verified archives
// are shared, in `~/.cache/agent-bot/downloads/<sha256>`.
//
//   .soul-state/runtimes/<runtime>/<version>/        one install, stamped
//   .soul-state/runtimes/<runtime>/last-install.json the last attempt
//   .soul-state/runtimes/harnesses/<name>/<version>/ a harness install: an
//   archive or uv tool declared here, or the npm ACP adapter soul-home.mjs
//   installs from the package's pins (#583 slice 8)
//   .soul-state/runtimes/uv/cache, go/gopath, node/npm-cache: the caches
//   a routed launch keeps out of the host's HOME
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ACP_SPAWN_REGISTRY } from './acp-registry.mjs';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { PROVIDER_NAMES, RUNTIME_NAMES, harnessInstallSource, hostPlatform, newestPin, normalizeHarnessInstall, normalizeRuntimeDeclaration, resolveCatalogPin, supportedMajors } from './runtime-catalog.mjs';

export const RUNTIMES_SCHEMA_VERSION = 1;
// Stable failure codes (ADR-0322 decision 5): each names the declared
// runtime or harness, the cause, and the command that would fix it.
export const RUNTIME_ERROR_CODES = Object.freeze(['runtime-download-failed', 'runtime-checksum-mismatch', 'runtime-unsupported-platform', 'runtime-install-failed']);
export const INSTALL_STAMP = '.agent-bot-install.json';
const LAST_INSTALL = 'last-install.json';
const STATE = '.soul-state';
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const ORDER = Object.freeze(['node', 'uv', 'python', 'go']);
const USAGE = 'usage: agent-bot soul runtimes <agentId|name> [--json] | soul runtimes install <agentId|name> [--json] [--runtime NAME] [--principal-stdin]';
const run = promisify(execFile);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim() ? value : null;

function fail(code, message, { runtime = null, action = null } = {}) {
  throw Object.assign(new Error(message), { code, runtime, action });
}

export function runtimesRoot(soulDir) {
  return path.join(soulDir, STATE, 'runtimes');
}

/** Where verified archives are shared: AGENT_BOT_CACHE_HOME, else XDG, else ~/.cache. */
export function downloadCacheDir({ env = process.env, home = env.HOME ?? homedir() } = {}) {
  const base = env.AGENT_BOT_CACHE_HOME ? path.resolve(env.AGENT_BOT_CACHE_HOME)
    : env.XDG_CACHE_HOME ? path.join(path.resolve(env.XDG_CACHE_HOME), 'agent-bot') : path.join(home, '.cache', 'agent-bot');
  return path.join(base, 'downloads');
}

function readJson(file, limit = 64 * 1024) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > limit) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return object(parsed) ? parsed : null;
  } catch { return null; }
}

export function readSoulManifest(soulDir) {
  return readJson(path.join(soulDir, 'soul.json'));
}

/**
 * The manifest's declarations, normalized, with what could not be read as
 * `invalid[]` (a descriptor reports it; a launch refuses on it).
 */
export function declaredRuntimes(manifest, { registry = ACP_SPAWN_REGISTRY } = {}) {
  const runtimes = {}, harnesses = {}, invalid = [];
  if (manifest?.runtimes !== undefined) {
    if (!object(manifest.runtimes)) invalid.push({ path: 'runtimes', message: 'soul.json runtimes must be an object' });
    else {
      for (const [name, value] of Object.entries(manifest.runtimes)) {
        try { runtimes[name] = normalizeRuntimeDeclaration(name, value, `soul.json runtimes.${name}`); }
        catch (error) { invalid.push({ path: `runtimes.${name}`, message: error.message }); }
      }
    }
  }
  if (object(manifest?.harnesses)) {
    for (const [name, settings] of Object.entries(manifest.harnesses)) {
      if (!object(settings) || settings.install === undefined) continue;
      try {
        if (registry[name]?.adapter) throw new Error(`soul.json harnesses.${name}.install: ${name} is an npm harness, pinned in package.json (ADR-0276)`);
        harnesses[name] = normalizeHarnessInstall(settings.install, `soul.json harnesses.${name}.install`, { defaultBin: registry[name]?.command ?? null });
      } catch (error) { invalid.push({ path: `harnesses.${name}.install`, message: error.message }); }
    }
  }
  return { runtimes, harnesses, invalid };
}

/** Whether a soul directory's manifest declares a download for this harness. */
export function harnessInstallDeclared(soulDir, harness) {
  if (!soulDir || !harness) return false;
  return Object.hasOwn(declaredRuntimes(readSoulManifest(soulDir)).harnesses, harness);
}

// Windows archives carry `name.exe`; the declaration names the executable
// without it on every platform.
function hasExecutable(directory, name) {
  return [name, `${name}.exe`].some((file) => {
    try { return statSync(path.join(directory, file)).isFile(); } catch { return false; }
  });
}

function readStamp(directory) {
  const stamp = readJson(path.join(directory, INSTALL_STAMP), 16 * 1024);
  return stamp && typeof stamp.version === 'string' && typeof stamp.bin === 'string' ? stamp : null;
}
// The stamp reader and the staging publish, for the npm adapter installs
// soul-home.mjs lays out the same way (#583 slice 8).
export { readStamp as readInstallStamp, publish as publishInstall };

function lastInstall(directory) {
  const record = readJson(path.join(directory, LAST_INSTALL), 16 * 1024);
  return record && typeof record.status === 'string' ? record : null;
}

const installCommand = (agentId, runtime = null) => `agent-bot soul runtimes install ${agentId}${runtime ? ` --runtime ${runtime}` : ''}`;

// What a declared runtime resolves to on this platform: the package's own
// sources when it ships them (they are definition, reviewed as a revision),
// else the catalog pin for its range; `unsupported` with the reason when
// neither covers the host.
function resolveRuntime(name, declaration, { platform, catalog }) {
  const row = { name, declared: declaration.version, version: null, source: null, archive: null, via: declaration.via, status: null, reason: null };
  if (declaration.sources) {
    row.version = declaration.version;
    row.source = 'package';
    row.archive = declaration.sources[platform] ?? null;
    if (!row.archive) { row.status = 'unsupported'; row.reason = `the package's sources for ${name} ${declaration.version} do not cover ${platform ?? 'this platform'}`; }
    return row;
  }
  const pin = resolveCatalogPin(name, declaration.version, { catalog });
  if (!pin) {
    row.status = 'unsupported';
    row.reason = `no catalog pin for ${name} ${declaration.version} in agent-bot (${supportedMajors(name, { catalog }).map((major) => `"${major}"`).join(', ') || 'none'}); declare a supported major, or exact sources`;
    return row;
  }
  row.version = pin.version;
  row.source = 'catalog';
  if (pin.sources) {
    row.archive = pin.sources[platform] ?? null;
    if (!row.archive) { row.status = 'unsupported'; row.reason = `${name} ${pin.version} has no download for ${platform ?? 'this platform'}`; }
  } else if (!platform) { row.status = 'unsupported'; row.reason = `${name} ${pin.version} has no download for this platform`; }
  return row;
}

/**
 * The soul's runtimes as they stand: declared, resolved, installed. Pure
 * reads; `platform` and `catalog` are injectable so a descriptor can be
 * computed for another host. Every row has every key.
 */
export function inspectSoulRuntimes(soulDir, { manifest = readSoulManifest(soulDir), platform = hostPlatform(), catalog, env = process.env, home = env.HOME ?? homedir(), registry = ACP_SPAWN_REGISTRY } = {}) {
  const root = runtimesRoot(soulDir);
  const declared = declaredRuntimes(manifest, { registry });
  const result = { schemaVersion: RUNTIMES_SCHEMA_VERSION, platform, root, cache: downloadCacheDir({ env, home }), runtimes: [], harnesses: [], invalid: declared.invalid, ready: true };
  const needsUv = Object.hasOwn(declared.runtimes, 'python') || Object.values(declared.harnesses).some((install) => install.kind === 'uv-tool');
  const requiredBy = [...(Object.hasOwn(declared.runtimes, 'python') ? ['python'] : []),
    ...Object.entries(declared.harnesses).filter(([, install]) => install.kind === 'uv-tool').map(([name]) => name)];
  const rows = Object.entries(declared.runtimes).map(([name, declaration]) => ({ ...resolveRuntime(name, declaration, { platform, catalog }), requiredBy: [] }));
  if (needsUv) {
    const pin = newestPin('uv', { catalog });
    const uvRow = { name: 'uv', declared: null, requiredBy, version: pin?.version ?? null, source: pin ? 'catalog' : null, archive: pin?.sources?.[platform] ?? null, via: null, status: null, reason: null };
    if (!uvRow.archive) { uvRow.status = 'unsupported'; uvRow.reason = `uv${pin ? ` ${pin.version}` : ''} has no download for ${platform ?? 'this platform'}`; }
    rows.push(uvRow);
  }
  rows.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
  for (const row of rows) {
    const directory = row.version ? path.join(root, row.name, row.version) : null;
    const stamp = directory ? readStamp(directory) : null;
    const executable = row.name === 'python' ? (platform?.startsWith('win32-') ? 'python' : 'python3') : row.name;
    const installed = stamp && hasExecutable(path.join(directory, stamp.bin), executable);
    const last = lastInstall(path.join(root, row.name));
    const entry = { name: row.name, declared: row.declared, requiredBy: row.requiredBy, version: row.version, source: row.source,
      status: row.status ?? (installed ? 'installed' : 'missing'), reason: row.reason, path: installed ? directory : null, bin: installed ? stamp.bin : null,
      lastError: !installed && last?.status === 'failed' && last.version === row.version ? { code: last.code ?? 'runtime-install-failed', message: last.message ?? '', at: last.at ?? null } : null,
      archive: row.archive, via: row.via };
    if (entry.status !== 'installed') result.ready = false;
    result.runtimes.push(entry);
  }
  for (const [name, install] of Object.entries(declared.harnesses)) {
    const directory = path.join(root, 'harnesses', name, install.version);
    const stamp = readStamp(directory);
    const installed = stamp && !existsSync(`${directory}.installing`) && hasExecutable(path.join(directory, stamp.bin), install.bin);
    const archive = install.kind === 'archive' ? harnessInstallSource(install, platform) : null;
    const last = lastInstall(path.join(root, 'harnesses', name));
    const entry = { name, kind: install.kind, package: install.kind === 'uv-tool' ? install.package : null, version: install.version, executable: install.bin,
      status: install.kind === 'archive' && !archive ? 'unsupported' : installed ? 'installed' : 'missing',
      reason: install.kind === 'archive' && !archive ? `${name} ${install.version} has no sha256 for ${platform ?? 'this platform'}` : null,
      path: installed ? directory : null, bin: installed ? stamp.bin : null,
      lastError: !installed && last?.status === 'failed' && last.version === install.version ? { code: last.code ?? 'runtime-install-failed', message: last.message ?? '', at: last.at ?? null } : null,
      archive };
    if (entry.status !== 'installed') result.ready = false;
    result.harnesses.push(entry);
  }
  if (result.invalid.length) result.ready = false;
  return result;
}

// Where an override points: a directory as given, an executable's directory.
function overrideDir(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try { return statSync(value).isDirectory() ? value : path.dirname(value); } catch { return null; }
}

/**
 * The env a launch adds for this soul (ADR-0322 decision 4 order: the
 * per-agent override, the soul's install, the host's bundled node, PATH).
 * Returns `{ env, routing, missing }`: `env` is the patch (PATH first, then
 * the runtime-specific variables, never HOME), `routing` says per runtime
 * where it comes from, `missing` names declared runtimes a launch must
 * install first. Pure over an inspection.
 */
export function runtimeLaunchEnv(inspection, { env = process.env, overrides = {}, harness = null, node = process.execPath } = {}) {
  const root = inspection.root;
  const bins = [], patch = {}, routing = {}, missing = [];
  const byName = Object.fromEntries(inspection.runtimes.map((row) => [row.name, row]));
  for (const name of ORDER) {
    const row = byName[name];
    const override = overrideDir(overrides[name]);
    if (override) { bins.push(override); routing[name] = { source: 'override', version: null, bin: override }; continue; }
    if (!row) continue;
    if (row.status !== 'installed') { routing[name] = { source: row.status, version: row.version, bin: null }; missing.push(name); continue; }
    const bin = path.join(row.path, row.bin);
    bins.push(bin);
    routing[name] = { source: 'soul', version: row.version, bin };
    if (name === 'node') patch.npm_config_cache = path.join(root, 'node', 'npm-cache');
    if (name === 'go') {
      patch.GOROOT = row.path;
      patch.GOPATH = path.join(root, 'go', 'gopath');
      patch.GOMODCACHE = path.join(root, 'go', 'gopath', 'pkg', 'mod');
      patch.GOCACHE = path.join(root, 'go', 'cache');
    }
    if (name === 'python') { patch.UV_PYTHON_INSTALL_DIR = row.path; patch.UV_PYTHON_PREFERENCE = 'only-managed'; }
    if (name === 'uv') {
      patch.UV_CACHE_DIR = path.join(root, 'uv', 'cache');
      const tool = inspection.harnesses.find((entry) => entry.name === harness && entry.kind === 'uv-tool' && entry.status === 'installed');
      patch.UV_TOOL_DIR = tool ? path.join(tool.path, 'tools') : path.join(root, 'uv', 'tools');
      patch.UV_TOOL_BIN_DIR = tool ? path.join(tool.path, 'bin') : path.join(root, 'uv', 'tools', 'bin');
    }
  }
  if (!byName.node && !overrides.node && typeof node === 'string' && path.isAbsolute(node)) {
    bins.push(path.dirname(node));
    routing.node = { source: 'host-bundled', version: null, bin: path.dirname(node) };
  }
  for (const name of RUNTIME_NAMES) routing[name] ??= { source: 'host', version: null, bin: null };
  for (const entry of inspection.harnesses) {
    if (entry.status === 'installed') { const bin = path.join(entry.path, entry.bin); bins.unshift(bin); routing[`harness:${entry.name}`] = { source: 'soul', version: entry.version, bin }; }
    else { routing[`harness:${entry.name}`] = { source: entry.status, version: entry.version, bin: null }; if (entry.name === harness) missing.push(`harness:${entry.name}`); }
  }
  if (bins.length) {
    const rest = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir && !bins.includes(dir));
    patch.PATH = [...new Set([...bins, ...rest])].join(path.delimiter);
  }
  return { env: patch, routing, missing };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function bodyStream(body) {
  if (Buffer.isBuffer(body) || typeof body === 'string') return Readable.from([Buffer.from(body)]);
  if (body && typeof body.getReader === 'function') return Readable.fromWeb(body);
  return body;
}

/**
 * The verified archive for a source, from the shared cache or downloaded
 * into it. A cached file that no longer hashes is dropped and fetched
 * again; a download that hashes wrong is removed and fails
 * `runtime-checksum-mismatch`, so only verified bytes are ever shared.
 */
export async function fetchArchive({ url, sha256 }, { cache, fetchFn = globalThis.fetch, label, action = null, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const file = path.join(cache, sha256);
  if (existsSync(file)) {
    if (await hashFile(file) === sha256) return { file, reused: true };
    rmSync(file, { force: true });
  }
  let response;
  try { response = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { fail('runtime-download-failed', `${label}: could not download ${url} (${error.cause?.message ?? error.message}); check the network and retry`, { runtime: label, action }); }
  if (!response || response.ok === false || !response.body) {
    fail('runtime-download-failed', `${label}: ${url} answered ${response?.status ?? 'nothing'}; check the network and retry`, { runtime: label, action });
  }
  const partial = path.join(cache, `.partial-${sha256}-${randomUUID()}`);
  const hash = createHash('sha256');
  try {
    // Node 20 can reject an already-errored body before an output stream's
    // async open completes. Create the private file before the pipeline so
    // that a late open cannot recreate it after failure cleanup.
    await pipeline(bodyStream(response.body), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } }),
      createWriteStream(partial, { fd: openSync(partial, 'wx', 0o600), autoClose: true }));
  } catch (error) {
    rmSync(partial, { force: true });
    fail('runtime-download-failed', `${label}: download of ${url} failed (${error.message}); check the network and retry`, { runtime: label, action });
  }
  const digest = hash.digest('hex');
  if (digest !== sha256) {
    rmSync(partial, { force: true });
    fail('runtime-checksum-mismatch', `${label}: ${url} hashed sha256:${digest}, expected sha256:${sha256}; the download is corrupt or tampered and was discarded`, { runtime: label, action });
  }
  renameSync(partial, file);
  return { file, reused: false };
}

function stripSingleDirectory(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) return path.join(directory, entries[0].name);
  return directory;
}

function recordLastInstall(directory, record) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, LAST_INSTALL);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

function publish(staging, payload, target) {
  try { renameSync(payload, target); }
  catch (error) {
    // Another install of the same version finished first: theirs stands.
    if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code) || !readStamp(target)) throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// An archive install: verified download, extraction into an exclusive
// `.installing-<uuid>` beside the target, the stamp, then one rename. A
// failure removes only the staging; whatever was installed before stays.
async function installArchive({ name, version, archive, kind, executable = null }, target, { cache, fetchFn, runImpl, label, action, now, platform }) {
  const { file } = await fetchArchive(archive, { cache, fetchFn, label, action });
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = path.join(path.dirname(target), `.installing-${randomUUID()}`);
  const extract = path.join(staging, 'extract');
  mkdirSync(extract, { recursive: true, mode: 0o700 });
  try {
    try { await runImpl('tar', ['-xf', file, '-C', extract], { timeout: INSTALL_TIMEOUT_MS }); }
    catch (error) { fail('runtime-install-failed', `${label}: could not extract ${path.basename(archive.url)} (${String(error.stderr ?? error.message).trim().split('\n').pop()})`, { runtime: label, action }); }
    const payload = stripSingleDirectory(extract);
    const binDir = path.join(payload, archive.bin);
    if (!existsSync(binDir) || (executable && !hasExecutable(binDir, executable))) {
      fail('runtime-install-failed', `${label}: the archive has no ${executable ? `${archive.bin === '.' ? '' : `${archive.bin}/`}${executable}` : `${archive.bin} directory`}`, { runtime: label, action });
    }
    writeFileSync(path.join(payload, INSTALL_STAMP), `${JSON.stringify({ schemaVersion: RUNTIMES_SCHEMA_VERSION, name, kind, version, platform, url: archive.url, sha256: archive.sha256, bin: archive.bin, installedAt: now().toISOString() })}\n`, { mode: 0o600 });
    publish(staging, payload, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// uv installs the pinned CPython itself (python-build-standalone, verified
// by uv) into an exclusive staging directory, never into ~/.local/bin.
async function installPython({ version }, target, uvBin, { root, runImpl, label, action, now, platform }) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = path.join(path.dirname(target), `.installing-${randomUUID()}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const env = { ...process.env, UV_CACHE_DIR: path.join(root, 'uv', 'cache'), UV_PYTHON_INSTALL_DIR: staging, UV_NO_PROGRESS: '1' };
    try { await runImpl(uvBin, ['python', 'install', version, '--install-dir', staging, '--no-bin'], { env, timeout: INSTALL_TIMEOUT_MS }); }
    catch (error) { fail('runtime-install-failed', `${label}: uv could not install python ${version} (${String(error.stderr ?? error.message).trim().split('\n').pop()}); check the network and retry`, { runtime: label, action }); }
    const dirs = readdirSync(staging, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('cpython-'));
    if (dirs.length !== 1) fail('runtime-install-failed', `${label}: uv installed ${dirs.length} interpreters, expected one`, { runtime: label, action });
    const bin = existsSync(path.join(staging, dirs[0].name, 'bin')) ? path.join(dirs[0].name, 'bin') : dirs[0].name;
    writeFileSync(path.join(staging, INSTALL_STAMP), `${JSON.stringify({ schemaVersion: RUNTIMES_SCHEMA_VERSION, name: 'python', kind: 'uv-python', version, platform, url: null, sha256: null, bin, installedAt: now().toISOString() })}\n`, { mode: 0o600 });
    publish(staging, staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// A uv tool's venv carries absolute paths, so it is installed in place
// with an `.installing` marker beside it: a marked directory is incomplete
// and is redone; other versions are never touched.
async function installUvTool({ name, install }, target, uvBin, { root, pythonDir, runImpl, label, action, now, platform }) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const marker = `${target}.installing`;
  if (existsSync(marker)) rmSync(target, { recursive: true, force: true });
  writeFileSync(marker, `${now().toISOString()}\n`, { mode: 0o600 });
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const env = { ...process.env, UV_CACHE_DIR: path.join(root, 'uv', 'cache'), UV_TOOL_DIR: path.join(target, 'tools'), UV_TOOL_BIN_DIR: path.join(target, 'bin'),
      UV_PYTHON_INSTALL_DIR: pythonDir, UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_PROGRESS: '1' };
    try { await runImpl(uvBin, ['tool', 'install', `${install.package}==${install.version}`], { env, timeout: INSTALL_TIMEOUT_MS }); }
    catch (error) { fail('runtime-install-failed', `${label}: uv could not install ${install.package}==${install.version} (${String(error.stderr ?? error.message).trim().split('\n').pop()}); check the network and retry`, { runtime: label, action }); }
    if (!hasExecutable(path.join(target, 'bin'), install.bin)) fail('runtime-install-failed', `${label}: ${install.package} installed no ${install.bin} executable`, { runtime: label, action });
    writeFileSync(path.join(target, INSTALL_STAMP), `${JSON.stringify({ schemaVersion: RUNTIMES_SCHEMA_VERSION, name, kind: 'uv-tool', version: install.version, platform, url: null, sha256: null, bin: 'bin', installedAt: now().toISOString() })}\n`, { mode: 0o600 });
    rmSync(marker, { force: true });
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    rmSync(marker, { force: true });
    throw error;
  }
}

const installing = new Map();

/**
 * Installs what the soul declares and does not have: runtimes first (uv
 * before python), then harness installs. `only` limits to one runtime or
 * harness name. Stops at the first failure with a coded error and records
 * it beside the runtime for the descriptor. Returns the inspection after,
 * with `installed[]` and `skipped[]`.
 */
export async function installSoulRuntimes(soulDir, { only = null, agentId = null, env = process.env, home = env.HOME ?? homedir(), platform = hostPlatform(), catalog,
  fetchFn = globalThis.fetch, runImpl = run, now = () => new Date(), log = () => {}, registry = ACP_SPAWN_REGISTRY } = {}) {
  if (!existsSync(path.join(soulDir, STATE))) fail('soul-state-missing', `${soulDir} has no .soul-state yet; launch the soul once first`);
  const root = runtimesRoot(soulDir);
  const cache = downloadCacheDir({ env, home });
  const inspect = () => inspectSoulRuntimes(soulDir, { platform, catalog, env, home, registry });
  let state = inspect();
  const who = agentId ?? path.basename(soulDir);
  const invalid = state.invalid.find((entry) => !only || entry.path.includes(only));
  if (invalid) fail('runtime-install-failed', `${who}: ${invalid.message}`, { runtime: invalid.path, action: `fix soul.json ${invalid.path} in a revision` });
  const installed = [], skipped = [];
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const guard = async (target, work) => {
    while (installing.has(target)) await installing.get(target).catch(() => {});
    const pending = work();
    installing.set(target, pending);
    try { await pending; } finally { installing.delete(target); }
  };
  const attempt = async (record, dir, work) => {
    try {
      await work();
      recordLastInstall(dir, { version: record.version, status: 'ok', at: now().toISOString() });
    } catch (error) {
      if (RUNTIME_ERROR_CODES.includes(error.code)) recordLastInstall(dir, { version: record.version, status: 'failed', code: error.code, message: error.message, at: now().toISOString() });
      throw error;
    }
  };
  for (const row of state.runtimes) {
    const wanted = !only || only === row.name || (row.name === 'uv' && row.requiredBy.includes(only));
    if (!wanted) continue;
    const action = installCommand(who, row.name === 'uv' ? null : row.name);
    if (row.status === 'installed') { skipped.push(row.name); continue; }
    if (row.status === 'unsupported') fail('runtime-unsupported-platform', `${who}: ${row.reason}`, { runtime: row.name, action: `declare runtimes.${row.name} sources for ${platform ?? 'this platform'} in a revision` });
    const target = path.join(root, row.name, row.version);
    log(`installing ${row.name} ${row.version} into ${target}`);
    await guard(target, () => attempt(row, path.join(root, row.name), async () => {
      if (row.name === 'python') {
        const uv = inspect().runtimes.find((entry) => entry.name === 'uv');
        if (!uv || uv.status !== 'installed') fail('runtime-install-failed', `${who}: uv is not installed, so python cannot be`, { runtime: 'python', action });
        await installPython(row, target, path.join(uv.path, uv.bin, 'uv'), { root, runImpl, label: `${who} python`, action, now, platform });
      } else {
        await installArchive({ name: row.name, version: row.version, archive: row.archive, kind: 'archive', executable: row.name === 'uv' ? 'uv' : null }, target,
          { cache, fetchFn, runImpl, label: `${who} ${row.name}`, action, now, platform });
      }
    }));
    installed.push(row.name);
  }
  state = inspect();
  for (const entry of state.harnesses) {
    if (only && only !== entry.name) continue;
    const action = installCommand(who, entry.name);
    if (entry.status === 'installed') { skipped.push(entry.name); continue; }
    if (entry.status === 'unsupported') fail('runtime-unsupported-platform', `${who}: ${entry.reason}`, { runtime: entry.name, action: `declare harnesses.${entry.name}.install.sha256 for ${platform ?? 'this platform'} in a revision` });
    const target = path.join(root, 'harnesses', entry.name, entry.version);
    log(`installing harness ${entry.name} ${entry.version} into ${target}`);
    await guard(target, () => attempt(entry, path.join(root, 'harnesses', entry.name), async () => {
      if (entry.kind === 'archive') {
        await installArchive({ name: entry.name, version: entry.version, archive: entry.archive, kind: 'archive', executable: entry.executable }, target,
          { cache, fetchFn, runImpl, label: `${who} ${entry.name}`, action, now, platform });
      } else {
        const current = inspect();
        const uv = current.runtimes.find((row) => row.name === 'uv');
        const python = current.runtimes.find((row) => row.name === 'python');
        if (!uv || uv.status !== 'installed') fail('runtime-install-failed', `${who}: uv is not installed, so ${entry.name} cannot be`, { runtime: entry.name, action });
        await installUvTool({ name: entry.name, install: { package: entry.package, version: entry.version, bin: entry.executable } }, target, path.join(uv.path, uv.bin, 'uv'),
          { root, pythonDir: python?.path ?? path.join(root, 'python', 'uv-managed'), runImpl, label: `${who} ${entry.name}`, action, now, platform });
      }
    }));
    installed.push(entry.name);
  }
  return { ...inspect(), installed, skipped };
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

const strip = ({ archive: _archive, ...rest }) => rest;
const report = (soul, soulDir, state) => ({ schemaVersion: RUNTIMES_SCHEMA_VERSION, agentId: soul.id, soulDir, platform: state.platform, root: state.root, cache: state.cache,
  runtimes: state.runtimes.map(strip), harnesses: state.harnesses.map(strip), invalid: state.invalid, ready: state.ready,
  ...(state.installed ? { installed: state.installed, skipped: state.skipped } : {}) });

/** The status of a soul's runtimes by Agent ID or name (read-only). */
export function soulRuntimesStatus(id, { env = process.env, home = env.HOME ?? homedir(), ...rest } = {}) {
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  return report(soul, soulDir, inspectSoulRuntimes(soulDir, { env, home, platform: rest.platform, catalog: rest.catalog }));
}

/** Installs a soul's missing runtimes and harness installs; the daemon calls it at launch. */
export async function provisionSoulRuntimes(id, { env = process.env, home = env.HOME ?? homedir(), only = null, ...rest } = {}) {
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  return report(soul, soulDir, await installSoulRuntimes(soulDir, { ...rest, only, agentId: soul.id, env, home }));
}

/** The names a launch of this soul still has to install, or [] (never throws). */
export function pendingSoulRuntimes(id, options = {}) {
  try {
    const state = soulRuntimesStatus(id, options);
    return [...state.runtimes.filter((row) => row.status !== 'installed').map((row) => row.name),
      ...state.harnesses.filter((row) => row.status !== 'installed').map((row) => `harness:${row.name}`),
      ...state.invalid.map((entry) => entry.path)];
  } catch { return []; }
}

/** The env patch a soul's turn gets, refusing unavailable declarations. */
export function soulRuntimeEnv(id, { env = process.env, home = env.HOME ?? homedir(), harness = null, overrides = {}, node = process.execPath, ...rest } = {}) {
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  if (!existsSync(soulDir)) return runtimeLaunchEnv({ root: runtimesRoot(soulDir), runtimes: [], harnesses: [] }, { env, overrides, harness, node }).env;
  const manifest = readSoulManifest(soulDir);
  if (!manifest && existsSync(path.join(soulDir, 'soul.json'))) {
    fail('runtime-install-failed', `${soul.id}: soul.json cannot be read as an object`, { runtime: 'soul.json', action: 'repair soul.json in a revision' });
  }
  const inspection = inspectSoulRuntimes(soulDir, { ...rest, env, home, manifest });
  const invalid = inspection.invalid[0];
  if (invalid) fail('runtime-install-failed', `${soul.id}: ${invalid.message}`, { runtime: invalid.path, action: `fix soul.json ${invalid.path} in a revision` });
  const routed = runtimeLaunchEnv(inspection, { env, overrides, harness, node });
  for (const name of routed.missing) {
    const isHarness = name.startsWith('harness:');
    const label = isHarness ? name.slice('harness:'.length) : name;
    const row = (isHarness ? inspection.harnesses : inspection.runtimes).find((entry) => entry.name === label);
    if (row.status === 'unsupported') {
      fail('runtime-unsupported-platform', `${soul.id}: ${row.reason}`, { runtime: name, action: `fix soul.json ${isHarness ? 'harnesses' : 'runtimes'}.${label} for ${inspection.platform ?? 'this platform'} in a revision` });
    }
    fail('runtime-install-failed', `${soul.id}: declared ${name} ${row.version} is not installed; refusing host fallback`, { runtime: name, action: installCommand(soul.id, label === 'uv' ? null : label) });
  }
  return routed.env;
}

export function formatRuntimes(result) {
  const lines = [`agentId: ${result.agentId}`, `soulDir: ${result.soulDir}`, `platform: ${result.platform ?? 'unsupported'}`, `ready: ${result.ready}`, ''];
  for (const row of result.runtimes) {
    lines.push(`${row.name}: ${row.status}${row.version ? ` ${row.version}` : ''}${row.declared ? ` (declared ${row.declared}, ${row.source})` : row.requiredBy.length ? ` (for ${row.requiredBy.join(', ')})` : ''}${row.path ? ` ${row.path}` : ''}${row.reason ? ` - ${row.reason}` : ''}${row.lastError ? ` - last install: ${row.lastError.code}` : ''}`);
  }
  for (const row of result.harnesses) {
    lines.push(`harness ${row.name}: ${row.status} ${row.version} (${row.kind}${row.package ? ` ${row.package}` : ''})${row.path ? ` ${row.path}` : ''}${row.reason ? ` - ${row.reason}` : ''}${row.lastError ? ` - last install: ${row.lastError.code}` : ''}`);
  }
  for (const entry of result.invalid) lines.push(`invalid ${entry.path}: ${entry.message}`);
  if (!result.runtimes.length && !result.harnesses.length && !result.invalid.length) lines.push('nothing declared');
  if (result.installed) lines.push('', `installed: ${result.installed.join(', ') || '-'}`, `skipped: ${result.skipped.join(', ') || '-'}`);
  return `${lines.join('\n')}\n`;
}

export async function soulRuntimesCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), ...rest } = {}) {
  let install = false, id = null, json = false, presented = false, only = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'install' && !install && id === null) install = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--runtime' && only === null && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('-')) { only = argv[i + 1]; i += 1; }
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id || (!install && (presented || only !== null))) throw new Error(USAGE);
  if (only !== null && !RUNTIME_NAMES.includes(only) && !PROVIDER_NAMES.includes(only) && !Object.hasOwn(ACP_SPAWN_REGISTRY, only)) throw new Error(`--runtime must be one of ${[...RUNTIME_NAMES, ...Object.keys(ACP_SPAWN_REGISTRY)].join(', ')}`);
  const options = { env, home, now, ...rest };
  if (!install) {
    const result = soulRuntimesStatus(id, options);
    write(json ? `${JSON.stringify(result)}\n` : formatRuntimes(result));
    return result;
  }
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const soul = resolveSoul(id, options);
  await gate(`install ${soul.id}'s declared runtimes${only ? ` (${only})` : ''} into its soul folder`, { principal, env, cwd });
  const result = await provisionSoulRuntimes(soul.id, { ...options, only });
  appendAuditReceipt({ event: 'soul-runtimes', agentId: soul.id, operation: 'install', decision: result.installed.length ? 'installed' : 'up-to-date',
    detail: `installed: ${result.installed.join(', ') || '-'}` }, { env, home, now });
  write(json ? `${JSON.stringify(result)}\n` : formatRuntimes(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulRuntimesCommand(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'soul-runtimes-failed', message: error.message, runtime: error.runtime ?? null, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul runtimes: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
