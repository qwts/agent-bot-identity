// Module ownership and import boundaries (#645, ADR-0645). Every runtime file
// belongs to exactly one module in governance/runtime-modules.json, and an
// import may cross modules only where that module's `may_import` allows it.
// Today's crossings are recorded in `baseline`: a new one fails, and one that
// disappears must be removed from the baseline, so it only shrinks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compareToBaseline,
  crossingEdges,
  edgeKey,
  importSpecifiers,
  moduleEdges,
  resolveSpecifier,
  validateModuleMap,
} from './helpers/module-graph.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAP = JSON.parse(readFileSync(new URL('../governance/runtime-modules.json', import.meta.url), 'utf8'));

// Shipped runtime code: tracked .mjs files outside the directories no install
// channel ships (Formula, scripts/linux-bundle/build.mjs, GeniusBar's fetch).
const NOT_RUNTIME = /^(?:tests|scripts|tools|skills|docs|web)\//u;

function runtimeFiles() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && !NOT_RUNTIME.test(file))
    .sort();
}

function sampleMap(overrides = {}) {
  return {
    schema_version: 1,
    modules: {
      identity: { summary: 'who', may_import: ['shared'] },
      soul: { summary: 'what', may_import: ['identity', 'shared'] },
      shared: { summary: 'leaf', may_import: [] },
    },
    files: { 'a.mjs': 'identity', 'b.mjs': 'soul', 'c.mjs': 'shared' },
    baseline: [],
    ...overrides,
  };
}

test('every runtime file is owned by exactly one known module', () => {
  assert.deepEqual(validateModuleMap(MAP, runtimeFiles()), []);
});

test('no import crosses a module boundary beyond the recorded baseline', () => {
  const crossings = crossingEdges(MAP, moduleEdges(ROOT, runtimeFiles()));
  const { added, stale, duplicates } = compareToBaseline(crossings, MAP.baseline);
  assert.deepEqual(added, [], 'new cross-module imports: route them through an allowed module, or record a decision superseding ADR-0645 before widening may_import');
  assert.deepEqual(stale, [], 'these crossings are gone: remove them from the baseline in governance/runtime-modules.json');
  assert.deepEqual(duplicates, []);
});

test('the baseline is sorted so reviews see exactly which crossings changed', () => {
  assert.deepEqual(MAP.baseline, [...MAP.baseline].sort());
});

test('knowledge and leaf modules import nothing that can launch, mint or route', () => {
  assert.deepEqual(MAP.modules.shared.may_import, []);
  assert.deepEqual(MAP.modules.harness.may_import, ['shared']);
  for (const module of ['identity', 'harness', 'comms', 'org', 'shared']) {
    assert.ok(!MAP.modules[module].may_import.includes('soul'), `${module} must not depend on soul`);
    assert.ok(!MAP.modules[module].may_import.includes('host'), `${module} must not depend on a process host`);
  }
  for (const module of ['harness', 'org', 'shared']) {
    assert.ok(!MAP.modules[module].may_import.includes('identity'), `${module} must not reach identity`);
  }
});

test('importSpecifiers finds static, re-export, side-effect and literal dynamic imports', () => {
  const source = [
    "import { a } from './a.mjs';",
    'import {',
    '  b,',
    "} from '../b.mjs';",
    "export * from './c.mjs';",
    "import './d.mjs';",
    "const e = await import('./e.mjs');",
    "import { spawn } from 'node:child_process';",
    "const url = 'https://example.com/x';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['../b.mjs', './a.mjs', './c.mjs', './d.mjs', './e.mjs']);
});

test('importSpecifiers ignores imports quoted in comments and computed specifiers', () => {
  const source = [
    "// import { x } from './line-comment.mjs';",
    "/* import './block-comment.mjs'; */",
    'const name = "./computed.mjs";',
    'await import(name);',
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), []);
});

test('resolveSpecifier keeps repository-relative POSIX paths', () => {
  assert.equal(resolveSpecifier('cli/dispatch.mjs', '../git-hooks.mjs'), 'git-hooks.mjs');
  assert.equal(resolveSpecifier('agent-bot.mjs', './cli/parse.mjs'), 'cli/parse.mjs');
});

test('validateModuleMap rejects unowned files, unknown modules and bad rules', () => {
  const unowned = sampleMap();
  assert.deepEqual(validateModuleMap(unowned, ['a.mjs', 'b.mjs', 'c.mjs', 'new.mjs']), ['new.mjs: not assigned to a module']);

  const gone = sampleMap();
  assert.deepEqual(validateModuleMap(gone, ['a.mjs', 'b.mjs']), ['c.mjs: assigned but not a runtime file']);

  const unknownOwner = sampleMap({ files: { 'a.mjs': 'comms', 'b.mjs': 'soul', 'c.mjs': 'shared' } });
  assert.deepEqual(validateModuleMap(unknownOwner, ['a.mjs', 'b.mjs', 'c.mjs']), ['a.mjs: unknown module comms']);

  const badRule = sampleMap();
  badRule.modules.shared.may_import = ['shared', 'ghost'];
  assert.deepEqual(validateModuleMap(badRule, ['a.mjs', 'b.mjs', 'c.mjs']), [
    'shared: may_import must not list itself',
    'shared: may_import names unknown module ghost',
  ]);

  assert.deepEqual(validateModuleMap({ ...sampleMap(), schema_version: 2 }, ['a.mjs', 'b.mjs', 'c.mjs']), ['schema_version must be 1']);
  assert.deepEqual(validateModuleMap({ schema_version: 1 }, []), ['modules must be an object']);

  const strayNote = sampleMap({ notes: { 'z.mjs': 'why' } });
  assert.deepEqual(validateModuleMap(strayNote, ['a.mjs', 'b.mjs', 'c.mjs']), ['z.mjs: note for an unassigned file']);
});

test('crossingEdges flags only imports the importing module does not allow', () => {
  const map = sampleMap();
  const edges = [
    { from: 'b.mjs', to: 'a.mjs' }, // soul -> identity: allowed
    { from: 'a.mjs', to: 'c.mjs' }, // identity -> shared: allowed
    { from: 'a.mjs', to: 'b.mjs' }, // identity -> soul: crossing
    { from: 'c.mjs', to: 'a.mjs' }, // shared -> identity: crossing
  ];
  assert.deepEqual(crossingEdges(map, edges).map(edgeKey), ['a.mjs -> b.mjs', 'c.mjs -> a.mjs']);
});

test('compareToBaseline fails new crossings and stale baseline entries', () => {
  const crossings = [{ from: 'a.mjs', to: 'b.mjs' }, { from: 'c.mjs', to: 'a.mjs' }];
  assert.deepEqual(compareToBaseline(crossings, ['a.mjs -> b.mjs', 'c.mjs -> a.mjs']), { added: [], stale: [], duplicates: [] });
  assert.deepEqual(compareToBaseline(crossings, ['a.mjs -> b.mjs']), { added: ['c.mjs -> a.mjs'], stale: [], duplicates: [] });
  assert.deepEqual(compareToBaseline([], ['a.mjs -> b.mjs']), { added: [], stale: ['a.mjs -> b.mjs'], duplicates: [] });
  assert.deepEqual(compareToBaseline(crossings.slice(0, 1), ['a.mjs -> b.mjs', 'a.mjs -> b.mjs']).duplicates, ['a.mjs -> b.mjs']);
});

test('moduleEdges ignores self-imports and files outside the map', () => {
  const sources = {
    'a.mjs': "import './a.mjs';\nimport './b.mjs';\nimport './web/app.js';",
    'b.mjs': "import data from './data.json' with { type: 'json' };",
  };
  assert.deepEqual(moduleEdges('/unused', ['a.mjs', 'b.mjs'], (file) => sources[file]), [{ from: 'a.mjs', to: 'b.mjs' }]);
});
