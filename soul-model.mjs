#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from './agent-principals.mjs';
import { validateAgentId, withLock } from './agent-identity.mjs';
import { ownerGate } from './cold-wake-settings.mjs';

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
