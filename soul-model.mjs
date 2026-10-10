#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { validateAgentId, withLock } from './agent-identity.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { harnessSettings, tomlStatements } from './soul-builder.mjs';
import { readSettingsText } from './soul-mode.mjs';

export function validateModelId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error('modelId must be nonempty printable text no longer than 120 characters');
  }
  return value;
}

const emptySetting = () => ({ model: null, available: null, listedAt: null });

export function soulModelFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'soul-models.json');
}

function modelList(availableModels) {
  if (!Array.isArray(availableModels)) throw new Error('availableModels must be an array');
  return availableModels.map(({ modelId, name, description }) => {
    validateModelId(modelId);
    if (typeof name !== 'string' || (description !== undefined && typeof description !== 'string')) throw new Error('invalid model description');
    return { modelId, name, ...(description === undefined ? {} : { description }) };
  });
}

export function readSoulModels(options = {}) {
  try {
    const settings = JSON.parse(readFileSync(soulModelFile(options), 'utf8'))?.settings ?? {};
    if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid settings');
    for (const [id, value] of Object.entries(settings)) {
      validateAgentId(id);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid setting');
      if (value.model !== null) validateModelId(value.model);
      if (value.available !== null) modelList(value.available);
      if (value.listedAt !== null && (typeof value.listedAt !== 'string' || new Date(value.listedAt).toISOString() !== value.listedAt)) throw new Error('invalid listedAt');
    }
    return settings;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('soul model settings could not be read');
  }
}

export function soulModel(agentId, options = {}) {
  return readSoulModels(options)[validateAgentId(agentId)] ?? emptySetting();
}

function updateSoulModel(agentId, update, { env, home }) {
  const id = validateAgentId(agentId);
  const file = soulModelFile({ env, home });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withLock(`${file}.lock`, 'soul model settings', () => {
    const settings = readSoulModels({ env, home });
    settings[id] = { ...(settings[id] ?? emptySetting()), ...update };
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, settings }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, file); chmodSync(file, 0o600); }
    finally { rmSync(temp, { force: true }); }
    return settings[id];
  });
}

// A declared model: any nonempty string, as the package contract accepts.
const declaredModel = (value) => (typeof value === 'string' && value.trim() ? value : null);

// The JSON files each harness reads a project model from, highest first.
const JSON_MODEL_FILES = Object.freeze({
  claude: Object.freeze(['.claude/settings.local.json', '.claude/settings.json']),
  gemini: Object.freeze(['.gemini/settings.json']),
  opencode: Object.freeze(['opencode.json']),
});

// Codex's root `model` key: statements before the first table header, with
// the key bare or quoted and the value a basic or literal string.
function codexRootModel(text) {
  let statements;
  try { statements = tomlStatements(text); } catch { return null; }
  for (const statement of statements) {
    if (/^\s*\[/.test(statement)) return null;
    const match = statement.match(/^\s*(?:model|"model"|'model')\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')\s*(?:#.*)?\s*$/);
    if (!match) continue;
    if (match[2] !== undefined) return declaredModel(match[2]);
    try { return declaredModel(JSON.parse(`"${match[1]}"`)); } catch { return null; }
  }
  return null;
}

// The model a repo's own native harness file declares, or null. The repo may
// be an untrusted clone, so files are read as soul-mode reads them.
export function repoModel(directory, harness) {
  if (harness === 'codex') return codexRootModel(readSettingsText(path.join(directory, '.codex', 'config.toml')) ?? '');
  for (const name of JSON_MODEL_FILES[harness] ?? []) {
    let model = null;
    try { model = declaredModel(JSON.parse(readSettingsText(path.join(directory, name)))?.model); } catch { /* declares nothing */ }
    if (model !== null) return model;
  }
  return null;
}

// The model a soul package declares for this harness, or null.
export function packageModel(directory, harness) {
  let manifest = null;
  try { manifest = JSON.parse(readSettingsText(path.join(directory, 'soul.json'))); } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  return declaredModel((harness ? harnessSettings(manifest, harness) : manifest.harness ?? {})?.model);
}

// Native harness effort names are short identifiers, not arbitrary text. Repo
// settings are untrusted, and Codex validates the value against the pinned
// adapter's advertised choices before sending it over ACP.
const declaredEffort = (value) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) ? value : null);
const JSON_EFFORT_FILES = Object.freeze({
  claude: Object.freeze(['.claude/settings.local.json', '.claude/settings.json']),
});

function codexRootEffort(text) {
  let statements;
  try { statements = tomlStatements(text); } catch { return null; }
  for (const statement of statements) {
    if (/^\s*\[/.test(statement)) return null;
    const match = statement.match(/^\s*(?:model_reasoning_effort|"model_reasoning_effort"|'model_reasoning_effort')\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')\s*(?:#.*)?\s*$/);
    if (!match) continue;
    if (match[2] !== undefined) return declaredEffort(match[2]);
    try { return declaredEffort(JSON.parse(`"${match[1]}"`)); } catch { return null; }
  }
  return null;
}

// The repo's native effort declaration, or null. Preserve bounded native
// values such as Codex `xhigh` so a higher repo declaration cannot silently
// fall through to a lower package value; the pinned adapter remains authority
// on whether it supports that value for the selected model.
export function repoReasoningEffort(directory, harness) {
  if (harness === 'codex') return codexRootEffort(readSettingsText(path.join(directory, '.codex', 'config.toml')) ?? '');
  for (const name of JSON_EFFORT_FILES[harness] ?? []) {
    try {
      const effort = declaredEffort(JSON.parse(readSettingsText(path.join(directory, name)))?.effortLevel);
      if (effort !== null) return effort;
    } catch { /* declares nothing */ }
  }
  return null;
}

export function packageReasoningEffort(directory, harness) {
  let manifest = null;
  try { manifest = JSON.parse(readSettingsText(path.join(directory, 'soul.json'))); } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const value = (harness ? harnessSettings(manifest, harness) : manifest.harness ?? {})?.reasoningEffort;
  return ['low', 'medium', 'high'].includes(value) ? value : null;
}

// Effort precedence is the Codex composite owner model pick, then repo, then
// package. There is no separate owner effort picker or stored effort choice.
// No declaration means no ACP mutation, leaving current/default state alone.
export function resolveSoulReasoningEffort({ harness = null, cwd = null, soulDir = null, ownerModel = null } = {}) {
  // The pinned Codex adapter's ModelId format is `base[effort]`; the model
  // picker stores the full advertised ID. Its effort is part of the owner's
  // higher-priority model choice, so a repo/package effort must not overwrite it.
  if (harness === 'codex' && typeof ownerModel === 'string') {
    const match = ownerModel.match(/^[^\[\]\r\n]+\[([A-Za-z][A-Za-z0-9_-]{0,31})\]$/);
    if (match) return { effort: match[1], source: 'pick' };
  }
  const real = (dir) => { try { return realpathSync(dir); } catch { return path.resolve(dir); } };
  const sameDir = Boolean(cwd && soulDir && real(cwd) === real(soulDir));
  const repo = cwd && path.isAbsolute(cwd) && !sameDir ? repoReasoningEffort(cwd, harness) : null;
  if (repo !== null) return { effort: repo, source: 'repo' };
  const declared = soulDir && path.isAbsolute(soulDir) ? packageReasoningEffort(soulDir, harness) : null;
  if (declared !== null) return { effort: declared, source: 'soul' };
  return { effort: null, source: 'default' };
}

// `{ model, source }` for one daemon turn, in the owner's settings order
// (docs/soul-builder.md): the owner's pick, then the repo's own harness file,
// then the soul package, then the harness's default. The repo layer is the
// turn's working directory unless that is the soul's own home, whose native
// files are the package's rendering. `model` is sent as session/set_model on
// every turn, so a resumed native session also follows the order; it is null
// only when no layer names a model.
export function resolveSoulModel(agentId, { harness = null, cwd = null, soulDir = null, env = process.env, home = homedir() } = {}) {
  const pick = soulModel(agentId, { env, home }).model;
  if (pick !== null) return { model: pick, source: 'pick' };
  const real = (dir) => { try { return realpathSync(dir); } catch { return path.resolve(dir); } };
  const sameDir = Boolean(cwd && soulDir && real(cwd) === real(soulDir));
  const repo = cwd && path.isAbsolute(cwd) && !sameDir ? repoModel(cwd, harness) : null;
  if (repo !== null) return { model: repo, source: 'repo' };
  const declared = soulDir && path.isAbsolute(soulDir) ? packageModel(soulDir, harness) : null;
  if (declared !== null) return { model: declared, source: 'soul' };
  return { model: null, source: 'default' };
}

export function setSoulModel(agentId, modelId, { env = process.env, home = homedir(), now = () => new Date() } = {}) {
  const id = validateAgentId(agentId);
  if (modelId !== null) validateModelId(modelId);
  const setting = updateSoulModel(id, { model: modelId }, { env, home });
  // Receipts hold a 40-character decision; a longer model id goes whole in
  // the detail line. Who asked is not recorded: the launch or the gate is.
  const decision = modelId === null ? 'default' : modelId.length <= 40 ? modelId : `${modelId.slice(0, 39)}…`;
  appendAuditReceipt({ event: 'soul-model', agentId: id, operation: modelId === null ? 'clear' : 'set', decision,
    ...(modelId !== null && modelId.length > 40 ? { detail: `model: ${modelId}` } : {}) }, { env, home, now });
  return setting;
}

export function recordSoulModels(agentId, { availableModels }, { env = process.env, home = homedir(), now = () => new Date() } = {}) {
  return updateSoulModel(agentId, { available: modelList(availableModels), listedAt: now().toISOString() }, { env, home });
}

export async function soulModelCommand(argv, {
  gate = ownerGate,
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  env = process.env, home = homedir(), cwd = process.cwd(), now = () => new Date(),
} = {}) {
  const usage = 'usage: agent-bot soul model <agentId|name> [show|set <modelId>|clear] [--json] [--principal-stdin]';
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const [target, action = 'show', ...rest] = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  if (!target || !['show', 'set', 'clear'].includes(action) || rest.length !== (action === 'set' ? 1 : 0)
    || argv.filter((arg) => arg === '--json').length > 1 || argv.filter((arg) => arg === '--principal-stdin').length > 1
    || (action === 'show' && presented)) throw new Error(usage);
  const modelId = action === 'set' ? validateModelId(rest[0]) : null;
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const { populationFile, showSoul, showSoulByName } = await import('./agent-population.mjs');
  const file = populationFile({ env, home });
  let soul;
  try { soul = showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    soul = showSoulByName(target, { file });
  }
  let authorization = null;
  if (action !== 'show') {
    authorization = await gate(modelId === null ? `reset ${soul.id} to its harness's default model` : `set ${soul.id} model to ${modelId}`, { principal, env, cwd });
    setSoulModel(soul.id, modelId, { env, home, now });
  }
  const result = { agentId: soul.id, ...soulModel(soul.id, { env, home }), harness: soul.transcriptLocator?.provider ?? null };
  write(json ? `${JSON.stringify(result)}\n` : `model: ${result.model ?? 'default'}\n`);
  return authorization;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) soulModelCommand(process.argv.slice(2)).catch((error) => {
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: { code: 'soul-model-failed', message: error.message } })}\n`);
  else process.stderr.write(`agent-bot soul model: ${error.message}\n`);
  process.exitCode = 1;
});
