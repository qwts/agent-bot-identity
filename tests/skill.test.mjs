import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_USAGE } from '../bootstrap.mjs';
import { helpText } from '../cli/output.mjs';
import { sourceCommit } from '../skill.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL = join(ROOT, 'skills', 'agent-bot');
const PLAYBOOK_OPERATIONS = 'https://github.com/qwts/agent-sop/blob/main/docs/reference/agent-bot-operations.md';
const runSkill = (...args) => spawnSync(join(ROOT, 'agent-bot'), ['skill', ...args], {
  encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
});

for (const name of ['agent-bot', 'agent-space', 'thread-orders']) {
  test(`skill ${name} prints the exact bundled text and JSON metadata`, () => {
    const path = join(ROOT, 'skills', name, 'SKILL.md');
    const text = readFileSync(path, 'utf8');
    const plain = runSkill(name);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stderr, '');
    assert.equal(plain.stdout, text);
    const json = runSkill(name, '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.equal(json.stderr, '');
    assert.deepEqual(JSON.parse(json.stdout), { name, path, commit: sourceCommit(), text });
  });
}

test('unknown and invalid skill names cannot resolve outside the bundled skills', () => {
  for (const name of ['missing', '../agent-bot', 'agent-bot/../agent-space', '..',
    'agent..bot', '/agent-bot', 'Agent-bot', '1agent', 'a'.repeat(65)]) {
    for (const flags of [[], ['--json']]) {
      const result = runSkill(name, ...flags);
      assert.equal(result.status, 2, name);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `agent-bot skill: no bundled skill named ${name}; bundled: agent-bot, agent-space, thread-orders\n`);
    }
  }
});

test('skill path retains its directory and commit output in both formats', () => {
  const commit = sourceCommit();
  const plain = runSkill('path');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stderr, '');
  assert.equal(plain.stdout, `${SKILL}\ncommit ${commit}\n`);
  const json = runSkill('path', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stderr, '');
  assert.equal(json.stdout, `${JSON.stringify({ path: SKILL, commit })}\n`);
});

test('skill help and usage list both forms and reject extra arguments', () => {
  const help = runSkill('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /agent-bot skill path \[--json\]/u);
  assert.match(help.stdout, /agent-bot skill <name> \[--json\]/u);
  assert.equal(runSkill('-h').stdout, help.stdout);
  for (const args of [[], ['path', '--bogus'], ['agent-space', '--bogus'], ['agent-space', '--json', 'extra']]) {
    const result = runSkill(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.endsWith(help.stdout));
  }
});

test('agent-space front matter parses and its opening distinguishes the store from worktrees', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'agent-space', 'SKILL.md'), 'utf8');
  const header = skill.match(/^---\n([\s\S]*?)\n---\n/u);
  assert.ok(header, 'YAML front matter is delimited');
  // This skill uses only single-line plain YAML scalars; keep the test dependency-free.
  const fields = Object.fromEntries(header[1].split('\n').map((line) => {
    const pair = line.match(/^([a-z]+): ([^\n]+)$/u);
    assert.ok(pair, `plain scalar field: ${line}`);
    assert.doesNotMatch(pair[2], /: |\s#|^[!&*[{>|'"%@`]/u);
    return [pair[1], pair[2]];
  }));
  assert.deepEqual(Object.keys(fields), ['name', 'description']);
  assert.equal(fields.name, 'agent-space');
  assert.ok(fields.description.length > 0);
  const paragraph = skill.slice(header[0].length).split(/\n\s*\n/u)
    .find((block) => block.trim() && !block.trim().startsWith('#'));
  assert.match(paragraph, /~\/\.agent-space\/<agentId>/u);
  assert.match(paragraph, /different surface/u);
  assert.match(paragraph, /<soulDir>\/worktrees\/<name>/u);
  assert.match(paragraph, /ENG-0172-agent-space-is-durable-per-soul-storage\.md/u);
});

test('official skill is a progressive router over focused references', () => {
  const main = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const frontmatter = main.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
  assert.match(frontmatter, /^name: agent-bot$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.match(frontmatter, /fresh-clone/u);
  assert.match(frontmatter, /install agent bot identities/u);
  // name, description, and the ENG-0055 contract under metadata.
  assert.deepEqual(frontmatter.split('\n').filter((line) => /^[a-z_]+:/u.test(line)).map((line) => line.split(':')[0]), ['name', 'description', 'metadata']);
  assert.match(frontmatter, /^ {2}qwts-contract: "1"$/m);
  assert.match(frontmatter, /^ {2}qwts-cli: "agent-bot"$/m);
  for (const reference of ['operations.md', 'verified-publish.md', 'execution-identities.md', 'storage-surfaces.md']) {
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
  assert.match(main, /complete active identity roster/u);
  assert.match(operations, /install agent bot identities/u);
  assert.match(operations, /\.\/agent-bot bootstrap --profile <path\\\|->/u);
  assert.match(operations, /agent-bot bootstrap --worktree-only/u);
  assert.match(operations, /agent-sop\/blob\/main\/docs\/reference\/agent-bot-operations\.md/u);
  assert.match(operations, /agent-bot secret get/u);
  assert.match(operations, /--reason <text>/u);
  assert.match(operations, /does not replace or call\n`ensure-private-key`/u);
  assert.match(publish, /agent-bot signed-commit --dry-run/u);
  assert.match(publish, /force-with-lease/u);
  assert.match(publish, /Verified/u);
  for (const text of [main, publish]) {
    assert.match(text, /Bot-authored commits on a qwts repository are signed/u);
    assert.match(text, /`agent-bot signed-commit` is how/u);
  }
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

test('skill keeps the three-surface storage distinction with a conformance note', () => {
  const main = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const surfaces = readFileSync(join(SKILL, 'references', 'storage-surfaces.md'), 'utf8');
  const contract = /ENG-0172-agent-space-is-durable-per-soul-storage\.md/u;
  const conformance = /<!-- conformance:/u;
  assert.match(main, /Choose the storage surface/u);
  for (const text of [main, surfaces]) {
    assert.match(text, /[Ww]orktree/u);
    assert.match(text, /[Ss]cratchpad/u);
    assert.match(text, /Agent Space/u);
    assert.match(text, conformance);
  }
  assert.match(main, /agent-bot space ensure/u);
  assert.match(main, /agent-bot space path/u);
  assert.match(surfaces, /agent-bot space ensure/u);
  assert.match(surfaces, /agent-bot space path/u);
  assert.match(surfaces, contract);
  assert.doesNotMatch(surfaces, /(?:~\/\.local\/share|\$XDG_DATA_HOME|\/Users\/)/u);
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
  assert.match(readme, /\.\/agent-bot bootstrap --profile \/path\/to\/organization-profile\.json --with-gh-shim --machine-only/u);
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
  assert.match(helpText(), /\.\/agent-bot bootstrap --profile <path\|-> \[options\]/u);
  assert.match(BOOTSTRAP_USAGE, /never discovers organization policy/u);
});


test('skill teaches joining the hub and classifies the command effects (#513)', () => {
  const main = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const section = main.match(/## Joining the hub \(agent-comms\)\n([\s\S]*?)(?=\n## )/u)?.[1] ?? '';
  assert.match(section, /The hub is agent-comms/u);
  assert.match(section, /agent-bot join --name NAME --harness H/u);
  assert.match(section, /needs no\s+GitHub App/u);
  assert.match(section, /reuses the soul already pinned in this checkout/u);
  assert.match(section, /--soul AGENT_ID/u);
  assert.match(section, /--template PATH/u);
  assert.match(section, /soul directory under the souls root/u);
  assert.match(section, /census row/u);
  assert.match(section, /agentBot\.agentId/u);
  assert.match(section, /checkout already pinned to another soul is refused/u);
  assert.match(section, /\[joining\.md\]\(\.\.\/\.\.\/docs\/joining\.md\)/u);
  const rows = main.split('\n').filter((line) => /^\| (read-only|local-write|remote-write|destructive) \|/u.test(line));
  for (const [kind, command] of [
    ['remote-write', 'join'], ['local-write', 'soul spawn'],
    ['read-only', 'approvals list'], ['local-write', 'approvals approve'],
    ['local-write', 'web open'], ['read-only', 'telegram status'],
    ['remote-write', 'telegram run'], ['destructive', 'soul remove'],
  ]) assert.ok(rows.some((row) => row.startsWith(`| ${kind} |`) && row.split('|')[2].includes(`\`${command}\``)), `${command}: ${kind}`);
});
