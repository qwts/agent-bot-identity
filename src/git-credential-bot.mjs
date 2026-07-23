#!/usr/bin/env node
// Git credential helper that mints a GitHub App installation token on demand,
// so `git push` in an agent worktree authenticates as the bot with no
// pre-minted GH_TOKEN. Wired per worktree by setup-worktree.mjs as:
//
//   [credential]
//     helper =                                        ; reset inherited helpers
//     helper = !node <this file> <app-slug>
//
// Git appends the operation (get/store/erase) after the configured args and
// writes a key=value request on stdin. Only `get` matters: tokens live one
// hour, so there is nothing to store or erase. On any mint failure the helper
// exits non-zero and the push fails loudly — it never falls back to the
// human's stored login.

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, apiBase } from './config.mjs';
import { mint } from './mint-token.mjs';

export function parseCredentialRequest(text) {
  const request = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) request[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return request;
}

async function main() {
  const [slug, operation] = process.argv.slice(2);
  if (!slug) throw new Error('usage: git-credential-bot.mjs <app-slug> <get|store|erase>');
  if (operation !== 'get') return;

  const host = new URL(apiBase(loadConfig())).host.replace(/^api\./, '');
  const request = parseCredentialRequest(readFileSync(0, 'utf8'));
  // Stay silent for anything that is not our GitHub host over HTTPS; git moves on.
  if (request.protocol !== 'https' || request.host !== host) return;

  const { token } = await mint({ slug });
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`git-credential-bot: ${err.message}`);
    process.exit(1);
  });
}
