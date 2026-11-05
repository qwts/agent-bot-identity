#!/usr/bin/env node
// agent-bot workflow — resolve deterministic workflows across local and remote
// tiers (`soul` -> `sop-cache` -> `bundled`, plus opt-in `--remote`), clearly
// distinguishing what is cached locally in the soul/machine vs. what lives on
// the remote SOP catalog (#1344).

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listSouls, populationFile, showSoul, soulDirectory } from './agent-population.mjs';
import { identityOp } from './daemon-client.mjs';
import { validateAgentId } from './identity-format.mjs';
import { readBinding } from './identity-cli.mjs';
import {
  cachedDocuments,
  configPathFor,
  loadSopConfig,
  parseWorkflowToml,
  readRemoteSopWorkflows,
  readSopLastGood,
  resolveSop,
} from './sop.mjs';
import { stateDirectory } from './state-paths.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_WORKFLOWS_DIR = join(ROOT, 'workflows');
export const WORKFLOW_SOURCES = Object.freeze(['soul', 'sop-cache', 'bundled', 'remote']);
const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const WORKFLOW_USAGE = `usage: agent-bot workflow [--soul ID] [--remote] [--json]
       agent-bot workflow list [--soul ID] [--remote] [--json]
       agent-bot workflow show <name> [--soul ID] [--source soul|sop-cache|remote|bundled] [--json]
       agent-bot workflow sync [--soul ID] [--json]

Resolve deterministic workflows across local and remote tiers:
  1. soul       <soul>/workflows/<name>.toml (durable per-soul override)
  2. sop-cache  <state>/sop-cache/<commit>/workflows/<name>.toml (cached SOP commit)
  3. bundled    workflows/<name>.toml shipped with this agent-bot release

Default ('workflow', 'workflow list', 'workflow show <name>') is offline-first
(read-only, zero network calls) and reports activeSource, shadowedSources,
resolved SOP documents, and ordered deterministic steps.

Options:
  --soul <id|name>     Inspect workflows for a specific soul (defaults to current bound soul)
  --remote             Query the live remote SOP repository and compare against local tiers
  --source <tier>      Read a specific tier in 'show' (soul | sop-cache | remote | bundled)
  --json               Print structured JSON output
  -h, --help           Show this help message
`;

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}

function containedWorkflowFile(root, fileName) {
  if (!existsSync(root)) return null;
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`workflow directory must not be a symlink: ${root}`);
  }
  const file = join(root, fileName);
  if (!existsSync(file)) return null;
  const rel = relative(realpathSync(root), realpathSync(file));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
    throw new Error(`symlink escapes workflow directory: ${fileName}`);
  }
  if (!lstatSync(realpathSync(file)).isFile()) {
    throw new Error(`not a regular workflow file: ${fileName}`);
  }
  return file;
}

function readTierDirectory(dir, source, meta = {}) {
  const entries = new Map();
  if (!dir || !existsSync(dir)) return entries;
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(`workflow directory must not be a symlink: ${dir}`);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.toml')) continue;
    const name = entry.name.slice(0, -5);
    if (!WORKFLOW_NAME.test(name)) continue;
    const file = containedWorkflowFile(dir, entry.name);
    if (!file) continue;
    if (entry.isSymbolicLink() && source === 'sop-cache') {
      throw new Error(`symlink in SOP workflow cache: ${entry.name}`);
    }
    const text = readFileSync(file, 'utf8');
    const parsed = parseWorkflowToml(text, name);
    entries.set(name, {
      name,
      source,
      path: file,
      digest: sha256(text),
      text,
      ...meta,
      workflow: parsed,
    });
  }
  return entries;
}

function resolveSoulContext({ soul, env = process.env, home = homedir(), cwd = process.cwd(), populationOptions = {} } = {}) {
  const popOpts = { env, home, file: populationFile({ env, home }), ...populationOptions };
  let agentId = null;
  if (soul) {
    const souls = listSouls(popOpts).filter((s) => s.status !== 'retired');
    const match = souls.find((s) => s.id === soul || s.name === soul || s.displayName === soul);
    agentId = match ? match.id : validateAgentId(soul);
  } else {
    const fromEnv = env.AGENT_BOT_ID || env.QWTS_AGENT_ID || null;
    if (fromEnv) {
      agentId = validateAgentId(fromEnv);
    } else {
      const binding = readBinding({ env, cwd });
      if (binding?.agentId) {
        agentId = binding.agentId;
      } else {
        try {
          agentId = identityOp('current', { pinOnly: true }, { cwd });
        } catch {
          agentId = null;
        }
      }
    }
  }
  if (!agentId) return null;
  let dir = null;
  let displayName = null;
  try {
    const row = showSoul(agentId, popOpts);
    displayName = row.displayName ?? row.name ?? null;
    dir = row.soulDir ?? soulDirectory(agentId, { ...popOpts, readOnly: true });
  } catch {
    try {
      dir = soulDirectory(agentId, { ...popOpts, readOnly: true });
    } catch {
      dir = null;
    }
  }
  return { id: agentId, name: displayName, directory: dir };
}

function resolveOfflineSopCache({ soulContext, options = {} }) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? stateDirectory({ home, env });
  const cacheRoot = join(stateDir, 'sop-cache');
  const lastGood = readSopLastGood({ ...options, stateDir });

  // Check the active SOP selection (soul config first if present, else user config).
  let activeConfig = null;
  const readFile = options.readFile ?? ((p) => readFileSync(p, 'utf8'));
  for (const cfgPath of [
    soulContext?.directory ? join(soulContext.directory, 'agent-sop.toml') : null,
    options.configPath ?? configPathFor(home),
  ].filter(Boolean)) {
    try {
      activeConfig = loadSopConfig(readFile(cfgPath));
      break;
    } catch {
      // ignore missing config in offline lookup
    }
  }

  const configuredRepo = activeConfig?.repos?.sop?.repo ?? null;
  const configuredOrg = activeConfig?.repos?.org?.repo ?? null;
  const configuredPin = activeConfig?.repos?.sop?.ref && /^[0-9a-fA-F]{40}$/.test(activeConfig.repos.sop.ref)
    ? activeConfig.repos.sop.ref.toLowerCase()
    : null;

  const lastGoodMatchesConfig = Boolean(
    lastGood?.sop?.commit
    && (!configuredRepo || lastGood.sop.repository.toLowerCase() === configuredRepo.toLowerCase())
    && (!configuredOrg || !lastGood.org?.repository || lastGood.org.repository.toLowerCase() === configuredOrg.toLowerCase()),
  );

  const commit = configuredPin ?? (lastGoodMatchesConfig ? lastGood.sop.commit : null);
  const repository = configuredRepo ?? (lastGoodMatchesConfig ? lastGood.sop.repository : null);
  if (!commit) return null;
  const commitDir = join(cacheRoot, commit);
  if (!existsSync(commitDir) || lstatSync(commitDir).isSymbolicLink() || !lstatSync(commitDir).isDirectory()) {
    return { repository, commit, cached: false, directory: null, updatedAt: lastGoodMatchesConfig ? lastGood.updatedAt : null };
  }
  return {
    repository,
    commit,
    cached: true,
    directory: commitDir,
    updatedAt: lastGoodMatchesConfig ? lastGood.updatedAt : null,
  };
}

function computeRemoteStatus({ name, soulMap, cacheMap, bundledMap, remoteMap }) {
  const inSoul = soulMap.get(name);
  const inCache = cacheMap.get(name);
  const inBundled = bundledMap.get(name);
  const inRemote = remoteMap.get(name);

  if (inSoul) {
    return inRemote ? 'soul overrides remote' : 'soul only';
  }
  if (inCache && inRemote) {
    return inCache.digest === inRemote.digest ? 'up-to-date' : 'stale (remote updated)';
  }
  if (inRemote && !inCache) {
    return 'not cached locally';
  }
  if (inCache && !inRemote) {
    return 'removed on remote';
  }
  if (inBundled) {
    return 'bundled only';
  }
  return 'local';
}

export function parseWorkflowArgs(argv) {
  const parsed = {
    help: false,
    json: false,
    remote: false,
    soul: null,
    source: null,
    command: 'list',
    name: null,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      return parsed;
    }
  }
  let i = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    const sub = argv[i++];
    if (!['list', 'show', 'sync'].includes(sub)) {
      throw new Error(`unknown workflow subcommand: ${sub} (expected list, show, or sync)`);
    }
    parsed.command = sub;
    if (sub === 'show') {
      const name = argv[i++];
      if (!name || name.startsWith('-')) {
        throw new Error('workflow show requires a workflow <name>');
      }
      if (!WORKFLOW_NAME.test(name)) {
        throw new Error(`invalid workflow name: ${name}`);
      }
      parsed.name = name;
    }
  }
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--remote') {
      parsed.remote = true;
      continue;
    }
    if (arg === '--soul' || arg === '--source') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--soul') {
        if (parsed.soul !== null) throw new Error('--soul may be passed only once');
        parsed.soul = next;
      } else {
        if (parsed.source !== null) throw new Error('--source may be passed only once');
        if (!WORKFLOW_SOURCES.includes(next)) {
          throw new Error(`--source must be one of ${WORKFLOW_SOURCES.join(', ')}`);
        }
        parsed.source = next;
      }
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (parsed.source && parsed.command !== 'show') {
    throw new Error('--source is only supported with workflow show <name>');
  }
  if (parsed.remote && parsed.command === 'sync') {
    throw new Error('workflow sync always queries remote; omit --remote');
  }
  return parsed;
}

export function collectWorkflows(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stateDir = options.stateDir ?? stateDirectory({ home, env });
  const bundledDir = options.bundledDir ?? BUNDLED_WORKFLOWS_DIR;

  const soulContext = resolveSoulContext({
    soul: options.soul ?? null,
    env,
    home,
    cwd,
    populationOptions: options.populationOptions,
  });

  const soulWorkflowsDir = soulContext?.directory ? join(soulContext.directory, 'workflows') : null;
  const soulMap = readTierDirectory(soulWorkflowsDir, 'soul', {
    soulId: soulContext?.id ?? null,
  });

  const cacheInfo = resolveOfflineSopCache({ soulContext, options: { ...options, home, env, stateDir } });
  const cacheWorkflowsDir = cacheInfo?.cached && cacheInfo.directory ? join(cacheInfo.directory, 'workflows') : null;
  const cacheMap = readTierDirectory(cacheWorkflowsDir, 'sop-cache', {
    repository: cacheInfo?.repository ?? null,
    commit: cacheInfo?.commit ?? null,
  });

  const bundledMap = readTierDirectory(bundledDir, 'bundled');

  let remoteInfo = null;
  const remoteMap = new Map();
  if (options.remote || options.source === 'remote') {
    const report = resolveSop({
      ...options,
      home,
      env,
      cwd,
      stateDir,
      soul: soulContext?.id ?? options.soul ?? null,
      ...(soulContext?.directory ? { soulDirectory: () => soulContext.directory } : {}),
    });
    if (report.inEffect) {
      if (report.trust?.required && !report.trust.accepted) {
        throw new Error(`SOP repository ${report.trust.repo}@${report.repositories.sop.commit} requires owner trust before reading remote workflows`);
      }
      const { repository, commit, ref } = report.repositories.sop;
      const rawMap = readRemoteSopWorkflows(repository, commit, options);
      for (const [name, item] of rawMap.entries()) {
        const parsed = parseWorkflowToml(item.text, name);
        remoteMap.set(name, {
          name,
          source: 'remote',
          path: item.path,
          repository,
          commit,
          digest: sha256(item.text),
          text: item.text,
          workflow: parsed,
        });
      }
      const statusVsCache = !cacheInfo?.commit
        ? 'not cached locally'
        : cacheInfo.commit === commit
          ? 'up-to-date with sop-cache'
          : `differs from sop-cache (${cacheInfo.commit.slice(0, 10)})`;
      remoteInfo = { repository, ref, commit, statusVsCache };
    } else {
      remoteInfo = { inEffect: false, message: report.message ?? 'No SOP is in effect.' };
    }
  }

  return {
    soulContext,
    cacheInfo,
    remoteInfo,
    soulMap,
    cacheMap,
    bundledMap,
    remoteMap,
  };
}

export function listWorkflows(options = {}) {
  const {
    soulContext,
    cacheInfo,
    remoteInfo,
    soulMap,
    cacheMap,
    bundledMap,
    remoteMap,
  } = collectWorkflows(options);

  const allNames = new Set([
    ...soulMap.keys(),
    ...cacheMap.keys(),
    ...bundledMap.keys(),
    ...(options.remote ? remoteMap.keys() : []),
  ]);

  const workflows = [...allNames].sort((a, b) => a.localeCompare(b)).map((name) => {
    const localOrdered = [soulMap.get(name), cacheMap.get(name), bundledMap.get(name)].filter(Boolean);
    const active = localOrdered[0] ?? remoteMap.get(name);
    const activeSource = localOrdered[0] ? localOrdered[0].source : 'remote-only';
    const shadowedSources = localOrdered.slice(1).map((entry) => entry.source);
    const entry = {
      name,
      activeSource,
      shadowedSources,
      summary: active.workflow.summary ?? '',
      sop: active.workflow.sop,
      stepCount: active.workflow.steps.length,
      ...(active.commit ? { commit: active.commit } : {}),
    };
    if (options.remote) {
      entry.statusVsRemote = computeRemoteStatus({ name, soulMap, cacheMap, bundledMap, remoteMap });
      const rem = remoteMap.get(name);
      if (rem) entry.remoteCommit = rem.commit;
    }
    return entry;
  });

  return {
    soul: soulContext ? { id: soulContext.id, name: soulContext.name, directory: soulContext.directory } : null,
    cache: cacheInfo
      ? { repository: cacheInfo.repository, commit: cacheInfo.commit, cached: cacheInfo.cached, updatedAt: cacheInfo.updatedAt }
      : null,
    ...(options.remote ? { remote: remoteInfo } : {}),
    workflows,
  };
}

export function showWorkflow(name, options = {}) {
  if (!WORKFLOW_NAME.test(name)) {
    throw new Error(`invalid workflow name: ${name}`);
  }
  const {
    soulContext,
    cacheInfo,
    remoteInfo,
    soulMap,
    cacheMap,
    bundledMap,
    remoteMap,
  } = collectWorkflows(options);

  const tierLookup = {
    soul: soulMap,
    'sop-cache': cacheMap,
    bundled: bundledMap,
    remote: remoteMap,
  };

  let chosen = null;
  let shadowedSources = [];
  if (options.source) {
    chosen = tierLookup[options.source]?.get(name) ?? null;
    if (!chosen) {
      throw new Error(`workflow ${name} not found in source tier '${options.source}'`);
    }
    const localOrdered = [soulMap.get(name), cacheMap.get(name), bundledMap.get(name)].filter(Boolean);
    shadowedSources = localOrdered.filter((item) => item.source !== options.source).map((item) => item.source);
  } else {
    const localOrdered = [soulMap.get(name), cacheMap.get(name), bundledMap.get(name)].filter(Boolean);
    if (localOrdered.length > 0) {
      chosen = localOrdered[0];
      shadowedSources = localOrdered.slice(1).map((item) => item.source);
    } else if (options.remote && remoteMap.has(name)) {
      chosen = remoteMap.get(name);
    }
  }

  if (!chosen) {
    throw new Error(`workflow not found: ${name}`);
  }

  return {
    name: chosen.name,
    activeSource: chosen.source,
    shadowedSources,
    ...(chosen.repository ? { repository: chosen.repository } : {}),
    ...(chosen.commit ? { commit: chosen.commit } : {}),
    digest: chosen.digest,
    schemaVersion: chosen.workflow.schemaVersion,
    summary: chosen.workflow.summary,
    sop: chosen.workflow.sop,
    steps: chosen.workflow.steps,
    soul: soulContext ? { id: soulContext.id, name: soulContext.name } : null,
    cache: cacheInfo ? { repository: cacheInfo.repository, commit: cacheInfo.commit, cached: cacheInfo.cached } : null,
    ...(options.remote || options.source === 'remote' ? { remote: remoteInfo } : {}),
  };
}

export function syncWorkflows(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const stateDir = options.stateDir ?? stateDirectory({ home, env });
  const soulContext = resolveSoulContext({
    soul: options.soul ?? null,
    env,
    home,
    cwd,
    populationOptions: options.populationOptions,
  });

  const report = resolveSop({
    ...options,
    home,
    env,
    cwd,
    stateDir,
    soul: soulContext?.id ?? options.soul ?? null,
    ...(soulContext?.directory ? { soulDirectory: () => soulContext.directory } : {}),
  });
  if (!report.inEffect) {
    return {
      inEffect: false,
      message: report.message ?? 'No SOP is in effect.',
      synced: false,
      workflows: [],
    };
  }
  if (report.trust?.required && !report.trust.accepted) {
    throw new Error(`SOP repository ${report.trust.repo}@${report.repositories.sop.commit} requires owner trust; run: agent-bot sop trust ${report.trust.repo}`);
  }
  const { repository, commit, ref } = report.repositories.sop;
  const cacheDir = cachedDocuments(repository, commit, { ...options, home, env, stateDir, report, includeWorkflows: true });
  const syncedMap = readTierDirectory(join(cacheDir, 'workflows'), 'sop-cache', { repository, commit });
  return {
    inEffect: true,
    synced: true,
    repository,
    ref,
    commit,
    cacheDir,
    workflows: [...syncedMap.keys()].sort((a, b) => a.localeCompare(b)),
  };
}

export function formatWorkflowList(result, { remote = false } = {}) {
  const lines = [];
  if (result.soul) {
    const label = result.soul.name ? `${oneLine(result.soul.name)} (${result.soul.id})` : result.soul.id;
    lines.push(`SOUL: ${label}`);
  } else {
    lines.push('SOUL: none (unbound checkout)');
  }
  if (result.cache?.commit) {
    lines.push(`CACHE: ${oneLine(result.cache.repository ?? 'sop')} @ ${result.cache.commit.slice(0, 10)}${result.cache.cached ? '' : ' (missing locally)'}`);
  } else {
    lines.push('CACHE: none (run `agent-bot workflow sync` when online)');
  }
  if (remote) {
    if (result.remote?.commit) {
      lines.push(`REMOTE: ${oneLine(result.remote.repository)} @ ${result.remote.commit.slice(0, 10)} (${oneLine(result.remote.statusVsCache)})`);
    } else {
      lines.push(`REMOTE: ${oneLine(result.remote?.message ?? 'none')}`);
    }
  }
  lines.push('');

  if (result.workflows.length === 0) {
    lines.push('No workflows found.');
    return `${lines.join('\n')}\n`;
  }

  const nameWidth = Math.max(4, ...result.workflows.map((w) => w.name.length));
  const sourceWidth = Math.max(13, ...result.workflows.map((w) => w.activeSource.length));
  if (remote) {
    const statusWidth = Math.max(16, ...result.workflows.map((w) => (w.statusVsRemote ?? '').length));
    lines.push(`${'NAME'.padEnd(nameWidth)}  ${'ACTIVE SOURCE'.padEnd(sourceWidth)}  ${'STATUS VS REMOTE'.padEnd(statusWidth)}  SUMMARY`);
    for (const w of result.workflows) {
      lines.push(`${w.name.padEnd(nameWidth)}  ${w.activeSource.padEnd(sourceWidth)}  ${oneLine(w.statusVsRemote ?? '').padEnd(statusWidth)}  ${oneLine(w.summary)}`);
    }
  } else {
    const shadowWidth = Math.max(8, ...result.workflows.map((w) => (w.shadowedSources.join(', ') || 'none').length));
    lines.push(`${'NAME'.padEnd(nameWidth)}  ${'ACTIVE SOURCE'.padEnd(sourceWidth)}  ${'SHADOWED'.padEnd(shadowWidth)}  SUMMARY`);
    for (const w of result.workflows) {
      const shadowed = w.shadowedSources.join(', ') || 'none';
      lines.push(`${w.name.padEnd(nameWidth)}  ${w.activeSource.padEnd(sourceWidth)}  ${shadowed.padEnd(shadowWidth)}  ${oneLine(w.summary)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatWorkflowShow(detail) {
  const lines = [
    `workflow: ${oneLine(detail.name)}`,
    `source:   ${oneLine(detail.activeSource)}${detail.commit ? ` (${ oneLine(detail.repository ?? 'sop')}@${detail.commit.slice(0, 10)})` : ''}`,
    `shadowed: ${detail.shadowedSources.length ? detail.shadowedSources.join(', ') : 'none'}`,
  ];
  if (detail.summary) {
    lines.push(`summary:  ${oneLine(detail.summary)}`);
  }
  lines.push(`sop:      ${detail.sop.length ? detail.sop.map(oneLine).join(', ') : 'none'}`);
  if (detail.steps.length > 0) {
    lines.push('steps:');
    detail.steps.forEach((step, idx) => {
      const gateSuffix = step.gate ? ` [gate: ${oneLine(step.gate)}]` : '';
      lines.push(`  ${idx + 1}. ${oneLine(step.id)} (${oneLine(step.mode)})${gateSuffix} — ${oneLine(step.description)}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

export function formatWorkflowSync(result) {
  if (!result.inEffect) {
    return `${oneLine(result.message ?? 'No SOP is in effect.')}\n`;
  }
  const wfList = result.workflows.length ? result.workflows.join(', ') : 'none';
  return `Synced ${oneLine(result.repository)}@${result.commit.slice(0, 10)} into sop-cache (${result.workflows.length} workflow(s): ${wfList}).\n`;
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const writeOut = deps.writeStdout ?? ((text) => { process.stdout.write(text); });
  const writeErr = deps.writeStderr ?? ((text) => { process.stderr.write(text); });
  let parsed;
  try {
    parsed = parseWorkflowArgs(argv);
  } catch (error) {
    writeErr(`agent-bot workflow: ${error.message}\n${WORKFLOW_USAGE}`);
    return 2;
  }
  if (parsed.help) {
    writeOut(WORKFLOW_USAGE);
    return 0;
  }
  try {
    const options = {
      ...deps,
      soul: parsed.soul ?? deps.soul ?? null,
      remote: parsed.remote,
      source: parsed.source,
    };
    if (parsed.command === 'sync') {
      const result = syncWorkflows(options);
      writeOut(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatWorkflowSync(result));
      return 0;
    }
    if (parsed.command === 'show') {
      const detail = showWorkflow(parsed.name, options);
      writeOut(parsed.json ? `${JSON.stringify(detail, null, 2)}\n` : formatWorkflowShow(detail));
      return 0;
    }
    const listed = listWorkflows(options);
    writeOut(parsed.json ? `${JSON.stringify(listed, null, 2)}\n` : formatWorkflowList(listed, { remote: parsed.remote }));
    return 0;
  } catch (error) {
    writeErr(`agent-bot workflow: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
