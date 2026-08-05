import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL = join(ROOT, 'skills', 'agent-bot');

test('official skill is a progressive router over focused references', () => {
  const main = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const frontmatter = main.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
  assert.match(frontmatter, /^name: agent-bot$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.equal(frontmatter.split('\n').filter((line) => /^[a-z_]+:/u.test(line)).length, 2);
  for (const reference of ['operations.md', 'verified-publish.md', 'execution-identities.md']) {
    assert.match(main, new RegExp(`references/${reference.replace('.', '\\.')}`));
    assert.match(readFileSync(join(SKILL, 'references', reference), 'utf8'), /agent-bot/u);
  }
});

test('skill delegates executable behavior to the stable runtime', () => {
  const main = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const operations = readFileSync(join(SKILL, 'references', 'operations.md'), 'utf8');
  const publish = readFileSync(join(SKILL, 'references', 'verified-publish.md'), 'utf8');
  assert.match(main, /password\/API-key retrieval/u);
  assert.match(operations, /agent-bot secret get/u);
  assert.match(operations, /--reason <text>/u);
  assert.match(operations, /does not replace or call\n`ensure-private-key`/u);
  assert.match(publish, /agent-bot signed-commit --dry-run/u);
  assert.match(publish, /force-with-lease/u);
  assert.match(publish, /Verified/u);
});
