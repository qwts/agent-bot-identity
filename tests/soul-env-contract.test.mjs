import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSIFICATIONS, CLASSIFICATION_RULES, ENV_CONTRACT_VERSION, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST,
  RETENTION, SOUL_LAYOUT, classificationContract, classifyPath, retentionOf } from '../soul-env-contract.mjs';
import * as harnessContract from '../soul-harness-contract.mjs';

test('the classification enum and retention kinds are fixed, frozen and versioned', () => {
  assert.equal(ENV_CONTRACT_VERSION, 1);
  assert.deepEqual([...CLASSIFICATIONS], ['definition', 'generated', 'workspace', 'runtime', 'private-home',
    'memory', 'history', 'cache', 'temp', 'external']);
  assert.deepEqual([...RETENTION], ['durable', 'reconstructible', 'disposable']);
  assert.ok(Object.isFrozen(CLASSIFICATIONS) && Object.isFrozen(RETENTION) && Object.isFrozen(SOUL_LAYOUT) && Object.isFrozen(CLASSIFICATION_RULES));
  assert.deepEqual(classificationContract().enum, [...CLASSIFICATIONS]);
  assert.deepEqual(classificationContract().rules, CLASSIFICATION_RULES.map((rule) => ({ ...rule })));
  assert.throws(() => retentionOf('secret'), /unknown classification/);
});

test('every layout component carries a known classification and its retention; external has none', () => {
  const ids = SOUL_LAYOUT.map((component) => component.id);
  assert.equal(new Set(ids).size, ids.length, 'component ids are unique');
  for (const component of SOUL_LAYOUT) {
    assert.ok(CLASSIFICATIONS.includes(component.classification), component.id);
    assert.equal(component.retention, retentionOf(component.classification), component.id);
    if (component.classification === 'external') assert.equal(component.retention, null);
    else assert.ok(RETENTION.includes(component.retention), component.id);
    if (component.path !== null) assert.equal(classifyPath(component.path), component.classification, component.path);
  }
  // The life of a soul is durable; what a build or an install makes is not.
  assert.equal(retentionOf('memory'), 'durable');
  assert.equal(retentionOf('history'), 'durable');
  assert.equal(retentionOf('private-home'), 'durable');
  assert.equal(retentionOf('generated'), 'reconstructible');
  assert.equal(retentionOf('runtime'), 'reconstructible');
  assert.equal(retentionOf('cache'), 'reconstructible');
  assert.equal(retentionOf('temp'), 'disposable');
});

test('rules are ordered: specific .soul-state children, then private-home, workspaces, generated, default', () => {
  assert.deepEqual(CLASSIFICATION_RULES.map((rule) => rule.classification),
    ['runtime', 'memory', 'history', 'cache', 'temp', 'private-home', 'workspace', 'generated', 'definition']);
  assert.equal(CLASSIFICATION_RULES.at(-1).match, 'default');
  assert.equal(classifyPath('.soul-state/runtimes/development/node/24.11.1/bin/node'), 'runtime');
  assert.equal(classifyPath('.soul-state/space/notes/lesson.md'), 'memory');
  assert.equal(classifyPath('.soul-state/space'), 'memory');
  assert.equal(classifyPath('.soul-state/runs/2026-10-07.jsonl'), 'history');
  assert.equal(classifyPath('.soul-state/cache/npm/x'), 'cache');
  assert.equal(classifyPath('.soul-state/tmp/revision-1'), 'temp');
  assert.equal(classifyPath('.soul-state/home/AGENTS.md'), 'private-home');
  assert.equal(classifyPath('.soul-state/agent-id'), 'private-home');
  assert.equal(classifyPath('.soul-state'), 'private-home');
  assert.equal(classifyPath('worktrees/workspace/src/main.rs'), 'workspace');
  assert.equal(classifyPath('worktrees'), 'workspace');
  assert.equal(classifyPath('CLAUDE.md'), 'generated');
  assert.equal(classifyPath('.claude/skills/hello/SKILL.md'), 'generated');
  assert.equal(classifyPath('.claude'), 'generated');
  assert.equal(classifyPath('.github/hooks/agent-bot-soul.json'), 'generated');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'definition', 'only the named Copilot files are generated');
  assert.equal(classifyPath('.kiro/agents/x.md'), 'generated');
  assert.equal(classifyPath('.kiro/steering/x.md'), 'definition');
  for (const path of ['soul.json', 'AGENTS.md', 'skills/hello/SKILL.md', 'bin/tool', 'package-lock.json', 'policy.json', 'mcp.json', 'anything/else.txt']) {
    assert.equal(classifyPath(path), 'definition', path);
  }
  for (const bad of ['', '/abs', 'a/../b', './a', 'a//b', 'a\\b', 'a\u0000b', 42]) assert.throws(() => classifyPath(bad), /relative path/);
});

test('generated paths and the ignore list come from the harness contract, one source', () => {
  assert.equal(GENERATED_HARNESS_PATHS, harnessContract.GENERATED_HARNESS_PATHS);
  assert.equal(PACKAGE_IGNORE_LIST, harnessContract.PACKAGE_IGNORE_LIST);
  for (const candidate of GENERATED_HARNESS_PATHS) {
    const path = candidate.endsWith('/') ? `${candidate}file` : candidate;
    assert.equal(classifyPath(path), 'generated', path);
  }
  for (const directory of PACKAGE_IGNORE_LIST.directories) {
    assert.notEqual(classifyPath(`${directory}x`), 'definition', directory);
  }
  const generated = SOUL_LAYOUT.find((component) => component.id === 'generated');
  assert.equal(generated.path, null, 'generated output is a set of paths, not one path');
});
