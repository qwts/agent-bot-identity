import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  broadenPullRequestInboxSearchArgument,
  installedRepositoryScope,
} from '../gh-inbox-query.mjs';

const repositories = ['example/overlook', 'example/image-trail'];

for (const qualifier of ['author', 'reviewed-by', 'review-requested']) {
  test(`removes only the ${qualifier}:@me identity predicate`, () => {
    const original = `searchQuery=is:pr is:merged ${qualifier}:@me sort:updated-desc`;
    const expanded = broadenPullRequestInboxSearchArgument(original, repositories);
    assert.equal(
      expanded,
      'searchQuery=is:pr is:merged repo:example/image-trail repo:example/overlook sort:updated-desc',
    );
    assert.equal(broadenPullRequestInboxSearchArgument(expanded, repositories), expanded);
  });
}

test('leaves non-inbox and non-PR search arguments byte-for-byte unchanged', () => {
  for (const argument of [
    'query={viewer{login}}',
    'searchQuery=is:issue author:@me sort:updated-desc',
    'searchQuery=is:pr assignee:@me sort:updated-desc',
  ]) {
    assert.equal(broadenPullRequestInboxSearchArgument(argument, repositories), argument);
  }
});

test('requires repository scope before removing an identity predicate', () => {
  assert.throws(
    () => broadenPullRequestInboxSearchArgument('searchQuery=is:pr author:@me', []),
    /no repository scope/,
  );
});

test('discovers, validates, and privately caches installation repositories', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gh-inbox-cache-'));
  const calls = [];
  const now = Date.parse('2026-08-07T00:00:00.000Z');
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    return {
      ok: true,
      json: async () => ({
        repositories: [
          { full_name: 'example/overlook' },
          { full_name: 'example/image-trail' },
        ],
      }),
    };
  };
  const options = {
    slug: 'qwts-codex-agent', token: 'installation-secret', home, env: {}, fetchImpl, now,
  };

  assert.deepEqual(await installedRepositoryScope(options), [
    'example/image-trail', 'example/overlook',
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'Bearer installation-secret');

  const path = join(
    home, '.cache', 'agent-bot', 'github-installations',
    'qwts-codex-agent-repositories.json',
  );
  const cached = readFileSync(path, 'utf8');
  assert.doesNotMatch(cached, /installation-secret/);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  assert.deepEqual(await installedRepositoryScope({
    ...options,
    token: '',
    fetchImpl: async () => { throw new Error('cache should win'); },
    now: now + 60_000,
  }), ['example/image-trail', 'example/overlook']);
  assert.deepEqual(await installedRepositoryScope({
    ...options,
    fetchImpl: async () => { throw new Error('offline'); },
    now: now + 11 * 60_000,
  }), ['example/image-trail', 'example/overlook']);
});

test('repository discovery fails closed without a valid response or cache', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gh-inbox-cache-'));
  await assert.rejects(
    installedRepositoryScope({
      slug: 'qwts-codex-agent',
      token: 'installation-secret',
      home,
      env: {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ repositories: [] }) }),
    }),
    /invalid or empty repository list/,
  );
});
