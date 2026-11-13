#!/usr/bin/env node

// Explicit uninstalled / ephemeral identity-hook mode (ENG-0128 amendment).
// The policy itself lives in uninstalled-policy.mjs; sync-hooks embeds that
// module as the co-located policy file the generated harness adapters run
// when the installed agent-hook is absent. This module is the in-process
// decision path and the direct CLI entry.

import process from "node:process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { unmanagedAuthors } from "../config.mjs";
import { encodeDecision } from "../hook-dialects.mjs";
import { extractCommand, uninstalledDecision } from "./uninstalled-policy.mjs";

export {
  UNINSTALLED_OPAQUE_REASON,
  UNINSTALLED_REASON,
  isHumanAttributedPublish,
  parseUnmanagedAuthors,
  snapshotUnmanagedAuthors,
  uninstalledDecision,
  unmanagedAuthorList,
} from "./uninstalled-policy.mjs";

// In process the shared resolver decides directly; a config it refuses grants
// nothing. The config is located from the supplied env exactly as the
// generated fallback locates it, never from this process's home: without
// AGENT_BOT_CONFIG or HOME there is no config to read.
function sharedUnmanagedAuthors(env) {
  if (env.AGENT_BOT_UNMANAGED_AUTHORS === undefined && env.AGENT_BOT_CONFIG === undefined && !env.HOME) return [];
  try {
    return unmanagedAuthors(env.HOME ? { env, home: env.HOME } : { env }).authors;
  } catch {
    return [];
  }
}

export function decideUninstalledHook({ dialectKey, event, payload = {}, env = process.env }) {
  const { decision, reason } = uninstalledDecision({
    event,
    command: extractCommand(payload, env),
    env,
    authors: sharedUnmanagedAuthors(env),
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

// Run directly, from here or through the shim at its old path (#645, step 6).
if (process.argv[1] && [import.meta.url, new URL('../uninstalled-identity-hook.mjs', import.meta.url).href]
  .includes(pathToFileURL(process.argv[1]).href)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`uninstalled-identity-hook: ${error.message}\n`);
    process.exitCode = 1;
  }
}
