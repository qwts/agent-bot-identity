#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const APP_LOGIN = /^app\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?)$/;

function validAvatarUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'avatars.githubusercontent.com'
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

export function cachedBotAvatarUrl(slug, home = process.env.HOME) {
  if (!APP_LOGIN.test(`app/${slug}`) || typeof home !== 'string' || home.length === 0) {
    return '';
  }
  const configDir = join(home, '.config', slug);
  try {
    const cached = readFileSync(join(configDir, 'bot-avatar-url'), 'utf8').trim();
    if (validAvatarUrl(cached)) return cached;
  } catch {
    /* older setup; try the numeric App ID below */
  }
  try {
    const appId = readFileSync(join(configDir, 'app-id'), 'utf8').trim();
    return /^(?:[1-9][0-9]*)$/.test(appId)
      ? `https://avatars.githubusercontent.com/in/${appId}?v=4`
      : '';
  } catch {
    return '';
  }
}

export function enrichGhPrViewJson(value, lookupAvatarUrl) {
  let changed = false;
  const cache = new Map();

  function avatarFor(slug) {
    if (!cache.has(slug)) cache.set(slug, lookupAvatarUrl(slug));
    return cache.get(slug);
  }

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const match = typeof node.login === 'string' ? APP_LOGIN.exec(node.login) : null;
    if (match && !validAvatarUrl(node.avatarUrl)) {
      const avatarUrl = avatarFor(match[1]);
      if (validAvatarUrl(avatarUrl)) {
        node.avatarUrl = avatarUrl;
        changed = true;
      }
    }
    for (const child of Object.values(node)) visit(child);
  }

  visit(value);
  return { changed, value };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) throw new Error('gh-pr-view-json does not accept arguments');
  const raw = readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(raw);
    return 0;
  }

  // setup-worktree caches the bot profile URL; numeric App IDs supply a local
  // fallback. Keep this transform bounded: Codex applies a five-second deadline
  // to PR detail requests, so a secondary API call can make a successful
  // response fail.
  const result = enrichGhPrViewJson(payload, cachedBotAvatarUrl);

  process.stdout.write(result.changed ? `${JSON.stringify(result.value)}\n` : raw);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`gh-pr-view-json: ${error.message}\n`);
    process.exitCode = 1;
  }
}
