import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const codeql = readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');

test('lifecycle workflow has governed triggers, actor fields, and draft skipping', () => {
  assert.match(ci, /^  pull_request:\n/m);
  assert.match(ci, /^  push:\n    branches: \[main\]$/m);
  assert.match(ci, /^  workflow_dispatch:\n/m);
  assert.doesNotMatch(ci, /^  merge_group:/m);
  assert.match(ci, /github\.event\.pull_request\.draft == false/);
  assert.match(ci, /CI_POLICY_ACTOR: \$\{\{ github\.actor \}\}/);
  assert.match(ci, /CI_POLICY_TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}/);
  assert.match(ci, /public forks/);
  assert.match(ci, /ci-policy@[0-9a-f]{40}/);
});

test('PR concurrency is scoped and cancels obsolete runs', () => {
  assert.match(ci, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/);
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}/);
});

test('preflight evidence is exact-SHA and falls back to the complete suite', () => {
  assert.match(ci, /event=workflow_dispatch&head_sha=\$TARGET_SHA/);
  assert.match(ci, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(ci, /\.display_title == "CI workflow_dispatch purpose=exact-sha-preflight"/);
  assert.match(ci, /needs\.preflight-evidence\.outputs\.validated != 'true'/);
  assert.match(ci, /name: Complete suite/);
  assert.match(ci, /run: npm test/);
});

test('stable CI gate covers manual, PR, and main fallback lanes', () => {
  assert.match(ci, /name: CI\n/);
  assert.match(ci, /case "\$MODE" in/);
  assert.match(ci, /manual\)/);
  assert.match(ci, /post-merge\)/);
  assert.match(ci, /test "\$CODEQL" = success/);
});

test('advanced CodeQL is callable only through governed CI for both languages', () => {
  assert.match(codeql, /^  workflow_call:$/m);
  assert.doesNotMatch(codeql, /^  (?:pull_request|push|workflow_dispatch|schedule):$/m);
  assert.match(codeql, /language: \[actions, javascript-typescript\]/);
  assert.match(codeql, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(codeql, /github\/codeql-action\/analyze@[0-9a-f]{40}/);
});

test('every third-party action reference is immutable', () => {
  for (const source of [ci, codeql]) {
    for (const match of source.matchAll(/uses:\s+[^\s@]+@([^\s]+)/g)) {
      assert.match(match[1], /^[0-9a-f]{40}$/);
    }
  }
});
