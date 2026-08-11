import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_USAGE } from '../bootstrap.mjs';
import { helpText } from '../cli/output.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL = join(ROOT, 'skills', 'agent-bot');
const PLAYBOOK_OPERATIONS = 'https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-bot-operations.md';

test('official skill is a progressive router over focused references', () => {
  const main = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const frontmatter = main.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
  assert.match(frontmatter, /^name: agent-bot$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.match(frontmatter, /fresh-clone/u);
  assert.match(frontmatter, /install agent bot identities/u);
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
  assert.match(main, /\.\/agent-bot bootstrap/u);
  assert.doesNotMatch(main, /installed `agent-bot` CLI as the only runtime entrypoint/u);
  assert.match(main, /complete configured identity roster/u);
  assert.match(operations, /install agent bot identities/u);
  assert.match(operations, /\.\/agent-bot bootstrap --config <path>/u);
  assert.match(operations, /agent-bot bootstrap --worktree-only/u);
  assert.match(operations, /playbook-engineering\/blob\/main\/docs\/reference\/agent-bot-operations\.md/u);
  assert.match(operations, /agent-bot secret get/u);
  assert.match(operations, /--reason <text>/u);
  assert.match(operations, /does not replace or call\n`ensure-private-key`/u);
  assert.match(publish, /agent-bot signed-commit --dry-run/u);
  assert.match(publish, /force-with-lease/u);
  assert.match(publish, /Verified/u);
});

test('Agent Space guidance links the canonical contract and keeps operations local', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const identities = readFileSync(join(SKILL, 'references', 'execution-identities.md'), 'utf8');
  const contract = /ENG-0172-agent-space-is-durable-per-soul-storage\.md/u;
  assert.match(agents, contract);
  assert.match(identities, contract);
  assert.match(identities, /agent-bot space ensure/u);
  assert.match(identities, /agent-bot population list/u);
});

test('canonical agent guidance defines organization-wide cold-start intent', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const coldStart = agents.match(/### Cold-start intent\n([\s\S]*?)\n### Layout/u)?.[1] ?? '';
  assert.match(coldStart, /install agent bot identities/u);
  assert.match(coldStart, /organization-wide bootstrap request/u);
  assert.match(coldStart, /\.\/agent-bot bootstrap/u);
  assert.match(coldStart, /--machine-only/u);
  assert.match(coldStart, /complete configured App roster/u);
  assert.match(coldStart, /organization-owned\s+harness skills\/tooling/u);
  assert.match(coldStart, /Never fall back to a human\s+GitHub login/u);
  assert.ok(coldStart.includes(PLAYBOOK_OPERATIONS));
  assert.doesNotMatch(coldStart, /(?:~\/Code|\/Users\/|PLAYBOOK_HOME|playbook-home)/u);
});

test('README presents the source cold start before installed and manual setup', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const coldStart = readme.indexOf('## Cold start:');
  const stableCli = readme.indexOf('## Stable CLI');
  const manualApps = readme.indexOf('### 1. Create a GitHub App');
  assert.ok(coldStart >= 0 && coldStart < stableCli && stableCli < manualApps);
  assert.match(readme, /\.\/agent-bot bootstrap --config \/path\/to\/config\.json --with-gh-shim --machine-only/u);
  assert.match(readme, /agent-bot bootstrap --worktree-only/u);
  assert.match(readme, /every expected App row\s+and requested harness tool is ready/u);
  assert.ok(readme.includes(PLAYBOOK_OPERATIONS));
  assert.doesNotMatch(readme, /(?:~\/Code\/playbook-engineering|\/Users\/[^\s]+\/Code\/playbook-engineering)/u);
});

test('CLI help documents source and installed bootstrap entrypoints', () => {
  for (const output of [BOOTSTRAP_USAGE, helpText()]) {
    assert.match(output, /\.\/agent-bot bootstrap/u);
    assert.match(output, /agent-bot bootstrap/u);
  }
  assert.match(helpText(), /\.\/agent-bot bootstrap \[--config <path>\] \[options\]/u);
  assert.match(BOOTSTRAP_USAGE, /never discovers organization policy/u);
});
