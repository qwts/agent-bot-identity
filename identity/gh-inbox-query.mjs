#!/usr/bin/env node

import {
  mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const APP_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const INBOX_QUALIFIERS = ['author', 'reviewed-by', 'review-requested'];
const REPOSITORY_CACHE_TTL_MS = 10 * 60 * 1000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validRepositories(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const repositories = [...new Set(values)];
  return repositories.every((value) => typeof value === 'string' && REPOSITORY.test(value))
    ? repositories.sort()
    : null;
}

function cachePath(slug, { home, env }) {
  const root = env.XDG_CACHE_HOME || join(home, '.cache');
  return join(root, 'agent-bot', 'github-installations', `${slug}-repositories.json`);
}

function readRepositoryCache(path, slug) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const repositories = validRepositories(value.repositories);
    if (value.schema_version !== 1 || value.slug !== slug || !repositories) return null;
    const fetchedAt = Date.parse(value.fetched_at);
    if (!Number.isFinite(fetchedAt)) return null;
    return { fetchedAt, repositories };
  } catch {
    return null;
  }
}

function writeRepositoryCache(path, slug, repositories, now) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const payload = {
    schema_version: 1,
    slug,
    fetched_at: new Date(now).toISOString(),
    repositories,
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function installedRepositoryScope({
  slug,
  token,
  home = homedir(),
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  if (typeof slug !== 'string' || !APP_SLUG.test(slug)) {
    throw new Error('invalid Codex desktop GitHub App slug');
  }
  const path = cachePath(slug, { home, env });
  const cached = readRepositoryCache(path, slug);
  if (cached && now - cached.fetchedAt < REPOSITORY_CACHE_TTL_MS) {
    return cached.repositories;
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Codex desktop repository discovery requires its App token');
  }

  try {
    const repositories = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await fetchImpl(
        `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'agent-bot-identity',
          },
          signal: AbortSignal.timeout(4_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.repositories)) throw new Error('GitHub returned no repository list');
      repositories.push(...body.repositories.map((repo) => repo?.full_name));
      if (body.repositories.length < 100) break;
      if (page === 10) throw new Error('GitHub installation has more than 1,000 repositories');
    }
    const validated = validRepositories(repositories);
    if (!validated) throw new Error('GitHub returned an invalid or empty repository list');
    writeRepositoryCache(path, slug, validated, now);
    return validated;
  } catch (error) {
    // Repository names are secret-free and change rarely. A stale validated
    // cache is safer than broadening to global search when GitHub is transiently
    // unavailable; with no cache, fail closed and leave the native request unsent.
    if (cached) return cached.repositories;
    throw new Error(`could not discover installed repositories: ${error.message}`);
  }
}

export function broadenPullRequestInboxSearchArgument(argument, repositories) {
  const prefix = 'searchQuery=';
  if (!argument.startsWith(prefix)) return argument;
  let search = argument.slice(prefix.length);
  if (!/(^|\s)is:pr(?=\s|$)/.test(search)) return argument;
  const scope = validRepositories(repositories);
  if (!scope) throw new Error('Codex desktop Pull Requests search has no repository scope');

  for (const qualifier of INBOX_QUALIFIERS) {
    const me = new RegExp(`(^|\\s)${escapeRegExp(qualifier)}:@me(?=\\s|$)`);
    if (!me.test(search)) continue;
    // GitHub's GraphQL search accepts repeated repo qualifiers as a union, but
    // not several App identity qualifiers. Replace only the identity predicate
    // with the App installation's repositories; native state/sort filters stay.
    const qualifiers = scope.map((repository) => `repo:${repository}`).join(' ');
    search = search.replace(me, (_match, boundary) => `${boundary}${qualifiers}`);
    break;
  }
  return `${prefix}${search}`;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    throw new Error('gh-inbox-query requires a searchQuery argument and App slug');
  }
  const repositories = await installedRepositoryScope({
    slug: argv[1],
    token: process.env.GH_TOKEN,
  });
  process.stdout.write(broadenPullRequestInboxSearchArgument(argv[0], repositories));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`gh-inbox-query: ${error.message}\n`);
    process.exit(1);
  });
}
