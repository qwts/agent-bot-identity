import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cachedBotAvatarUrl, enrichGhPrViewJson } from '../gh-pr-view-json.mjs';

test('uses the exact cached App avatar URL when setup has recorded it', () => {
  const home = mkdtempSync(join(tmpdir(), 'gh-pr-avatar-'));
  const configDir = join(home, '.config', 'qwts-codex-agent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'bot-avatar-url'),
    'https://avatars.githubusercontent.com/in/424242?v=4\n',
  );

  assert.equal(
    cachedBotAvatarUrl('qwts-codex-agent', home),
    'https://avatars.githubusercontent.com/in/424242?v=4',
  );
  assert.equal(cachedBotAvatarUrl('qwts-codex-agent', join(home, 'missing')), '');
});

test('falls back to a numeric App ID and rejects malformed local metadata', () => {
  const home = mkdtempSync(join(tmpdir(), 'gh-pr-avatar-'));
  const configDir = join(home, '.config', 'qwts-codex-agent');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'app-id'), '424242\n');

  assert.equal(
    cachedBotAvatarUrl('qwts-codex-agent', home),
    'https://avatars.githubusercontent.com/in/424242?v=4',
  );
  writeFileSync(join(configDir, 'bot-avatar-url'), 'https://example.test/untrusted.png\n');
  assert.equal(
    cachedBotAvatarUrl('qwts-codex-agent', home),
    'https://avatars.githubusercontent.com/in/424242?v=4',
  );
  writeFileSync(join(configDir, 'app-id'), '../not-an-id\n');

  assert.equal(cachedBotAvatarUrl('qwts-codex-agent', home), '');
  assert.equal(cachedBotAvatarUrl('../escape', home), '');
});

test('enriches App actors recursively while preserving their app logins', () => {
  const payload = {
    author: { is_bot: true, login: 'app/qwts-codex-agent' },
    comments: [
      { author: { login: 'human-reviewer' } },
      { author: { login: 'app/qwts-codex-agent' } },
    ],
    reviews: [{ author: { login: 'app/qwts-claude-agent' } }],
  };
  const lookups = [];
  const result = enrichGhPrViewJson(payload, (slug) => {
    lookups.push(slug);
    return `https://avatars.githubusercontent.com/${slug}`;
  });

  assert.equal(result.changed, true);
  assert.equal(result.value.author.login, 'app/qwts-codex-agent');
  assert.equal(
    result.value.author.avatarUrl,
    'https://avatars.githubusercontent.com/qwts-codex-agent',
  );
  assert.equal(
    result.value.comments[1].author.avatarUrl,
    result.value.author.avatarUrl,
  );
  assert.equal(
    result.value.reviews[0].author.avatarUrl,
    'https://avatars.githubusercontent.com/qwts-claude-agent',
  );
  assert.deepEqual(lookups, ['qwts-codex-agent', 'qwts-claude-agent']);
  assert.equal('avatarUrl' in result.value.comments[0].author, false);
});

test('preserves existing avatars and ignores failed or malformed App lookups', () => {
  const payload = {
    author: {
      login: 'app/qwts-codex-agent',
      avatarUrl: 'https://avatars.githubusercontent.com/existing',
    },
    comments: [
      { author: { login: 'app/not_valid' } },
      { author: { login: 'app/qwts-claude-agent' } },
    ],
  };
  const result = enrichGhPrViewJson(payload, () => 'http://insecure.example/avatar');

  assert.equal(result.changed, false);
  assert.equal(
    result.value.author.avatarUrl,
    'https://avatars.githubusercontent.com/existing',
  );
  assert.equal('avatarUrl' in result.value.comments[0].author, false);
  assert.equal('avatarUrl' in result.value.comments[1].author, false);
});
