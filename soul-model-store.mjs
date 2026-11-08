// The soul model settings file and its readers, with nothing that changes it
// (#1384). The census reads every soul's model through this module, so the
// census never loads the owner gate that `soul model` changes go through (C1).
// soul-model.mjs re-exports the same names as before, so existing imports
// still work.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { validateAgentId } from './identity-format.mjs';

export function validateModelId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error('modelId must be nonempty printable text no longer than 120 characters');
  }
  return value;
}

export const emptySetting = () => ({ model: null, available: null, listedAt: null });

export function soulModelFile({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'soul-models.json');
}

export function modelList(availableModels) {
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
