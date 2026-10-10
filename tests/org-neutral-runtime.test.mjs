// The runtime is open source (#752): an organization's own values (its
// people, Apps, repositories, hosts and signing team) come from its
// organization profile or config, never from shipped code. This scans the
// executable code of shipped runtime files for the one organization this
// runtime grew up in. Comments and examples are provenance, not policy
// (docs/product-policy-conformance.md), so comments are stripped first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Same split as tests/module-boundaries.test.mjs, plus the shell launchers
// and hooks every install runs (not their READMEs).
const NOT_RUNTIME = /^(?:tests|scripts|tools|skills|docs|web)\/|\.md$/u;
const SHELL_ENTRY_POINTS = ['agent-bot', 'claude-worktree-create', 'hooks', 'agent-hooks'];

const ORGANIZATION_VALUES = [
  { name: 'the qwts owner account', pattern: /\bai9d\b/gu },
  { name: "GeniusBar's Developer ID team", pattern: /Z5DM34QS5U/gu },
  { name: 'a qwts organization repository', pattern: /\bqwts-agent-(?:org|sop)\b/gu },
  { name: 'a qwts host', pattern: /\bqwts\.org\b/gu },
  // The App slug alphabet executor-contract.mjs accepts.
  { name: 'a qwts App slug', pattern: /\bqwts-[a-z0-9][a-z0-9-]*-agent\b/gu },
];

// Values still compiled in, each the exact expression the removing change
// deletes. An entry may outlive its expression, so the removing PR need not
// edit this test; any other use of the value, in these files or elsewhere,
// fails.
const STILL_COMPILED = [
  // Unmanaged-author fallback until organization profiles carry the list
  // (#675; removal held in #713).
  { file: 'config.mjs', name: 'the qwts owner account', expression: "LEGACY_UNMANAGED_AUTHORS = Object.freeze(['ai9d']);" },
  { file: 'sync-hooks.mjs', name: 'the qwts owner account', expression: '${AGENT_BOT_UNMANAGED_AUTHORS-ai9d}' },
  { file: 'hooks/agent-context', name: 'the qwts owner account', expression: "printf '%s' ai9d" },
];

function runtimeFiles() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.mjs', ...SHELL_ENTRY_POINTS], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && !NOT_RUNTIME.test(file))
    .sort();
}

// JavaScript with comments blanked and everything else kept, string and
// template contents included. A quote or comment marker inside a string does
// not start anything. Line breaks survive, so line numbers do too.
function javascriptCode(source) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'line-comment') {
      if (c === '\n') { state = 'code'; out += c; }
      continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && next === '/') { state = 'code'; i += 1; out += '  '; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line-comment'; i += 1; continue; }
      if (c === '/' && next === '*') { state = 'block-comment'; i += 1; out += '  '; continue; }
      if (c === "'" || c === '"' || c === '`') state = c;
      out += c;
      continue;
    }
    // Inside a string: an escape keeps the next character, the matching
    // quote ends it, and a line break ends an unterminated ' or " string.
    out += c;
    if (c === '\\' && next !== undefined) { out += next; i += 1; continue; }
    if (c === state || (c === '\n' && state !== '`')) state = 'code';
  }
  return out;
}

// Shell with comments blanked: `#` starts one at the start of a word outside
// quotes, as sh reads it.
function shellCode(source) {
  return source.split('\n').map((line) => {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quote) {
        if (c === '\\' && quote === '"') i += 1;
        else if (c === quote) quote = null;
      } else if (c === '\\') {
        i += 1;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === '#' && (i === 0 || /\s/u.test(line[i - 1]))) {
        return line.slice(0, i);
      }
    }
    return line;
  }).join('\n');
}

function organizationValues(file, source) {
  const code = file.endsWith('.mjs') ? javascriptCode(source) : shellCode(source);
  const found = [];
  code.split('\n').forEach((line, index) => {
    for (const { name, pattern } of ORGANIZATION_VALUES) {
      const count = line.match(pattern)?.length ?? 0;
      if (count === 0) continue;
      const allowed = STILL_COMPILED.find((entry) => entry.file === file && entry.name === name && line.includes(entry.expression));
      // Only the one occurrence inside the allowed expression is exempt.
      if (!allowed || count > 1) found.push({ file, line: index + 1, name });
    }
  });
  return found;
}

test('shipped runtime code compiles in no organization-specific values (#752)', () => {
  const files = runtimeFiles();
  for (const file of ['config.mjs', 'hooks/agent-context', 'agent-bot', 'claude-worktree-create']) {
    assert.ok(files.includes(file), `runtime file listing misses ${file}`);
  }
  const unexpected = files.flatMap((file) => organizationValues(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')));
  assert.deepEqual(unexpected, [], 'move these into the organization profile or config');
});

test('the scan reads code and skips comments', () => {
  const app = (line) => [{ file: 'x.mjs', line, name: 'a qwts App slug' }];
  assert.deepEqual(organizationValues('x.mjs', "// 'qwts-claude-agent'\nconst app = 'qwts-claude-agent';"), app(2));
  assert.deepEqual(organizationValues('x.mjs', "/* provenance */ const app = 'qwts-code-review-agent';"), app(1));
  assert.deepEqual(organizationValues('x.mjs', "/*\n * qwts-claude-agent\n */\nconst n = 2\n  * 'qwts-x2-agent'.length;"), app(5));
  assert.deepEqual(organizationValues('x.mjs', "const url = 'https://x.test/'; const app = 'qwts-claude-agent'; // note"), app(1));
  assert.deepEqual(organizationValues('x.mjs', "const s = '/* not a comment'; const app = 'qwts-claude-agent';"), app(1));
  assert.deepEqual(organizationValues('x.mjs', 'const t = `a\n// not a comment qwts-claude-agent`;'), app(2));
  assert.deepEqual(organizationValues('x.mjs', "const url = 'https://gh-app-hook.qwts.org/x';"),
    [{ file: 'x.mjs', line: 1, name: 'a qwts host' }]);
  assert.deepEqual(organizationValues('x.mjs', '/**\n * Z5DM34QS5U\n */\nconst team = "Z5DM34QS5U";'),
    [{ file: 'x.mjs', line: 4, name: "GeniusBar's Developer ID team" }]);
  assert.deepEqual(organizationValues('x.mjs', "const repo = 'qwts-agent-org';"),
    [{ file: 'x.mjs', line: 1, name: 'a qwts organization repository' }]);
  const owner = (file, line) => [{ file, line, name: 'the qwts owner account' }];
  assert.deepEqual(organizationValues('hooks/x', '# ai9d\nprintf ai9d'), owner('hooks/x', 2));
  assert.deepEqual(organizationValues('hooks/x', 'echo "# ai9d"  # ai9d'), owner('hooks/x', 1));
  assert.deepEqual(organizationValues('hooks/x', 'echo ok # ai9d'), []);
});

test('a still-compiled value is exempt only as its exact expression', () => {
  assert.deepEqual(organizationValues('hooks/agent-context', "    printf '%s' ai9d"), []);
  assert.deepEqual(organizationValues('config.mjs', "export const LEGACY_UNMANAGED_AUTHORS = Object.freeze(['ai9d']);"), []);
  const owner = (file, line) => [{ file, line, name: 'the qwts owner account' }];
  assert.deepEqual(organizationValues('hooks/agent-context', "[ \"$USER\" = ai9d ] && exit 0"), owner('hooks/agent-context', 1));
  assert.deepEqual(organizationValues('config.mjs', "if (login === 'ai9d') return true;"), owner('config.mjs', 1));
  assert.deepEqual(organizationValues('hooks/agent-context', "printf '%s' ai9d; echo ai9d"), owner('hooks/agent-context', 1));
  assert.deepEqual(organizationValues('sync-hooks.mjs', "const a = 'qwts-claude-agent';"),
    [{ file: 'sync-hooks.mjs', line: 1, name: 'a qwts App slug' }]);
});
