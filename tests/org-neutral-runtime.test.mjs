// The runtime is open source (#752): an organization's own values (its
// people, Apps, repositories, hosts and signing team) come from its
// organization profile or config, never from shipped code. This scans the
// executable lines of shipped runtime files for the one organization this
// runtime grew up in. Comments and examples are provenance, not policy
// (docs/product-policy-conformance.md), so they are not scanned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Same split as tests/module-boundaries.test.mjs, plus the shell hooks every
// install runs (not their READMEs).
const NOT_RUNTIME = /^(?:tests|scripts|tools|skills|docs|web)\/|\.md$/u;

const ORGANIZATION_VALUES = [
  { name: 'the qwts owner account', pattern: /\bai9d\b/u },
  { name: "GeniusBar's Developer ID team", pattern: /Z5DM34QS5U/u },
  { name: 'a qwts organization repository', pattern: /\bqwts-agent-(?:org|sop)\b/u },
  { name: 'a qwts host', pattern: /\bqwts\.org\b/u },
  { name: 'a qwts App slug', pattern: /\bqwts-[a-z]+-agent\b/u },
];

// Values still compiled in, each with the change that removes it. An entry
// may outlive its value: the removing PR need not edit this test, and a new
// file or a new value never matches here.
const STILL_COMPILED = {
  // Unmanaged-author fallback until organization profiles carry the list
  // (#675; removal held in #713).
  'config.mjs': ['the qwts owner account'],
  'sync-hooks.mjs': ['the qwts owner account'],
  'hooks/agent-context': ['the qwts owner account'],
};

function runtimeFiles() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.mjs', 'hooks', 'agent-hooks'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && !NOT_RUNTIME.test(file))
    .sort();
}

function isComment(file, line) {
  const text = line.trim();
  if (file.endsWith('.mjs')) return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');
  return text.startsWith('#');
}

function organizationValues(file, source) {
  const found = [];
  source.split('\n').forEach((line, index) => {
    if (isComment(file, line)) return;
    for (const { name, pattern } of ORGANIZATION_VALUES) {
      if (pattern.test(line)) found.push({ file, line: index + 1, name });
    }
  });
  return found;
}

test('shipped runtime code compiles in no organization-specific values (#752)', () => {
  const files = runtimeFiles();
  assert.ok(files.includes('config.mjs') && files.includes('hooks/agent-context'), 'runtime file listing is empty or wrong');
  const unexpected = files
    .flatMap((file) => organizationValues(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')))
    .filter(({ file, name }) => !STILL_COMPILED[file]?.includes(name));
  assert.deepEqual(unexpected, [], 'move these into the organization profile or config');
});

test('the scan catches executable lines and skips comments', () => {
  assert.deepEqual(organizationValues('x.mjs', "// 'qwts-claude-agent'\nconst app = 'qwts-claude-agent';"),
    [{ file: 'x.mjs', line: 2, name: 'a qwts App slug' }]);
  assert.deepEqual(organizationValues('hooks/x', '# ai9d\nprintf ai9d'),
    [{ file: 'hooks/x', line: 2, name: 'the qwts owner account' }]);
  assert.deepEqual(organizationValues('x.mjs', ' * Z5DM34QS5U\nconst team = "Z5DM34QS5U";'),
    [{ file: 'x.mjs', line: 2, name: "GeniusBar's Developer ID team" }]);
  assert.deepEqual(organizationValues('x.mjs', "const url = 'https://gh-app-hook.qwts.org/x';"),
    [{ file: 'x.mjs', line: 1, name: 'a qwts host' }]);
});
