// Module ownership and import boundaries (#645, ADR-0645). Every runtime file
// belongs to exactly one module in governance/runtime-modules.json, and an
// import may cross modules only where that module's `may_import` allows it.
// Today's crossings are recorded in `baseline`: a new one fails, and one that
// disappears must be removed from the baseline, so it only shrinks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareToBaseline,
  computedImports,
  crossingEdges,
  edgeKey,
  exportedNames,
  importSpecifiers,
  maskSource,
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

// The dependency policy ADR-0645 decided, frozen here so that widening it is
// a reviewed change to this test and to a superseding decision record, not a
// one-line edit to the map that the ratchet would then accept.
const ADR_0645_POLICY = {
  shared: [],
  harness: ['shared'],
  org: ['shared'],
  identity: ['harness', 'org', 'shared'],
  comms: ['identity', 'org', 'shared'],
  soul: ['identity', 'harness', 'comms', 'org', 'shared'],
  host: ['identity', 'soul', 'harness', 'comms', 'org', 'shared'],
  cli: ['identity', 'soul', 'harness', 'comms', 'org', 'shared', 'host'],
};

// Files that read, store or hand out a credential. Identity owns credential
// custody, so these must stay identity files, where harness, org and shared
// cannot import them.
const CREDENTIAL_CAPABLE = [
  'ensure-private-key.mjs',
  'identity-app-store.mjs',
  'keyd-client.mjs',
  'mint-token.mjs',
  'secret-providers/pass-cli-credentials.mjs',
  'secret-providers/pass-cli.mjs',
  'secret-providers/proton-pass.mjs',
  'secret-store.mjs',
  'secret.mjs',
  'soul-credentials.mjs',
  'worktree-token.mjs',
];

function cycle(policy) {
  const state = new Map();
  const visit = (module, path) => {
    if (state.get(module) === 'done') return null;
    if (state.get(module) === 'open') return [...path.slice(path.indexOf(module)), module];
    state.set(module, 'open');
    for (const target of policy[module]) {
      const found = visit(target, [...path, module]);
      if (found) return found;
    }
    state.set(module, 'done');
    return null;
  };
  for (const module of Object.keys(policy)) {
    const found = visit(module, []);
    if (found) return found;
  }
  return null;
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
    computed_imports: {},
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

// ADR-0645 step 2 is done: every crossing was routed through an allowed
// module or a listed contract, so the ratchet now holds at zero.
test('the baseline is empty', () => {
  assert.deepEqual(MAP.baseline, []);
});

// F9 step 1 (#645, owner decision D5): host loads identity only through the
// contracts host may import (identity-host.mjs, plus the shared
// identity-format.mjs and daemon-client.mjs), never through another
// identity file. may_import still lists identity for host; this narrows it.
test('host imports identity only through its listed contracts', () => {
  const reached = moduleEdges(ROOT, runtimeFiles())
    .filter(({ from, to }) => MAP.files[from] === 'host' && MAP.files[to] === 'identity')
    .filter(({ to }) => !MAP.contracts?.[to]?.importable_by?.includes('host'))
    .map(({ from, to }) => `${from} -> ${to}`);
  assert.deepEqual(reached, [], 'import these through identity-host.mjs');
});

// ADR-0645 step 6: identity's files move into identity/, and each old path
// stays as a shim that only re-exports its moved file, so callers, the
// installed hooks and GeniusBar keep loading it there (#645).
test('each old identity path is only a re-export shim of its moved file', () => {
  for (const [old, moved] of Object.entries(MAP.shims ?? {})) {
    assert.equal(MAP.files[old], 'identity', `${old}: a shim stays an identity file`);
    assert.equal(MAP.files[moved], 'identity', `${moved}: the moved file is identity's`);
    assert.ok(moved.startsWith('identity/'), `${moved}: moved into identity/`);
    const target = readFileSync(new URL(`../${moved}`, import.meta.url), 'utf8');
    const source = readFileSync(new URL(`../${old}`, import.meta.url), 'utf8').replace(/^#![^\n]*\n/u, '');
    let spec = path.posix.relative(path.posix.dirname(old), moved);
    if (!spec.startsWith('.')) spec = `./${spec}`;
    // A moved file with no exports is a command: its shim only loads it.
    const names = exportedNames(target);
    assert.equal(source, names.length
      ? `// Moved to ${moved} (#645, ADR-0645 step 6). This path keeps working\n`
        + '// for callers that import it here; it re-exports the moved file.\n'
        + `export { ${names.join(', ')} } from '${spec}';\n`
      : `// Moved to ${moved} (#645, ADR-0645 step 6). This path keeps working\n`
        + '// for callers that run it here; it loads the moved file.\n'
        + `import '${spec}';\n`, `${old}: not a plain shim of ${moved}`);
  }
});

// cli reaches identity only through listed contracts (identity-cli.mjs,
// identity-format.mjs and daemon-client.mjs), never through another identity
// file (#645, F13 steps 3 and 4). Files the map assigns to identity, such as
// cli/mint-token.mjs, are identity's own and not checked here.
test('cli imports identity only through its listed contracts', () => {
  const reached = moduleEdges(ROOT, runtimeFiles())
    .filter(({ from, to }) => MAP.files[from] === 'cli' && MAP.files[to] === 'identity')
    .filter(({ to }) => !MAP.contracts?.[to]?.importable_by?.includes('cli'))
    .map(({ from, to }) => `${from} -> ${to}`);
  assert.deepEqual(reached, [], 'import these through identity-cli.mjs');
});


// Non-.mjs assets (#645, F14; owner decision of 2026-10-11): keyd, the
// identity script, the inbox worker config and the git hooks are identity's;
// soul's hook adapter is soul's. A path ending in "/" covers a directory, and
// the longest matching entry wins.
function assetOwner(file) {
  const match = Object.keys(MAP.assets ?? {})
    .filter((key) => (key.endsWith('/') ? file.startsWith(key) : file === key))
    .sort((a, b) => b.length - a.length)[0];
  return match === undefined ? undefined : MAP.assets[match];
}

function trackedFiles(...paths) {
  return execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

test('every identity asset is a tracked path owned by a known module', () => {
  for (const [key, owner] of Object.entries(MAP.assets ?? {})) {
    assert.ok(Object.hasOwn(MAP.modules, owner), `${key}: unknown module ${owner}`);
    assert.ok(trackedFiles(key.endsWith('/') ? key.slice(0, -1) : key).length > 0, `${key}: no tracked file`);
  }
  for (const file of trackedFiles('hooks', 'keyd')) {
    assert.ok(assetOwner(file), `${file}: not assigned in assets`);
  }
});

test("identity's git hooks reach soul only through soul's hook adapter", () => {
  const soulFiles = Object.entries(MAP.files).filter(([, owner]) => owner === 'soul').map(([file]) => file);
  const reached = [];
  for (const hook of trackedFiles('hooks').filter((file) => assetOwner(file) === 'identity')) {
    const source = readFileSync(new URL(`../${hook}`, import.meta.url), 'utf8');
    for (const file of soulFiles) if (source.includes(`../${file}`)) reached.push(`${hook} -> ${file}`);
  }
  assert.deepEqual(reached, [], 'run soul steps through hooks/soul-hook');
});

// A root-level contract that stands in for identity code may hold nothing but
// named re-exports of files inside identity/: no logic, no bare or node:
// specifiers, no dynamic imports. Comments are ignored.
function onlyReexportsIdentity(file, source) {
  const masked = maskSource(source);
  const statements = masked.code.split(';').map((statement) => statement.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((statement) => {
    const match = /^export\s*\{[^}]*\}\s*from\s*"\u0000(\d+)"$/u.exec(statement);
    return Boolean(match) && resolveSpecifier(file, masked.strings[Number(match[1])]).startsWith('identity/');
  });
}

// ADR-0645 step 6 is done when identity's code lives in identity/: every
// identity file outside it is a listed shim, or a published contract (such as
// identity-presence.mjs, whose bytes agent-comms pins) that only re-exports
// files inside identity/.
test('identity code outside identity/ is only shims and re-exporting contracts', () => {
  const stray = Object.entries(MAP.files)
    .filter(([file, owner]) => owner === 'identity' && !file.startsWith('identity/') && !Object.hasOwn(MAP.shims ?? {}, file))
    .filter(([file]) => !MAP.contracts?.[file]
      || !onlyReexportsIdentity(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')))
    .map(([file]) => file);
  assert.deepEqual(stray, [], 'move these into identity/ and leave a shim');
});

test('a re-exporting contract holds only named re-exports from identity/', () => {
  assert.equal(onlyReexportsIdentity('entry.mjs', "// a comment\nexport { a, b } from './identity/x.mjs';\n"), true);
  assert.equal(onlyReexportsIdentity('entry.mjs', "export { a } from './identity/x.mjs';\nexport { b as c } from './identity/y.mjs';"), true);
  for (const source of [
    '',
    "export { a } from './identity/x.mjs';\nexport function b() { return 1; }",
    "export { a } from './identity/x.mjs';\nconst secret = 1;",
    "export { readFileSync } from 'node:fs';",
    "export { a } from 'some-package';",
    "export { a } from './outside.mjs';",
    "export { a } from '../identity/x.mjs';",
    "export * from './identity/x.mjs';",
    "export { a } from './identity/x.mjs';\nawait import('./identity/' + name);",
    "import './identity/x.mjs';",
  ]) {
    assert.equal(onlyReexportsIdentity('entry.mjs', source), false, source);
  }
});

// A contract is a narrow, reviewed exception to may_import: its surface is
// exactly the exports the map lists, so widening it is a map change too.
test('each contract exports exactly the names the map lists', () => {
  for (const [file, contract] of Object.entries(MAP.contracts ?? {})) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(exportedNames(source), [...contract.exports].sort(), `${file}: exports differ from the map's contract`);
  }
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

test('the dependency policy is the one ADR-0645 decided', () => {
  const policy = Object.fromEntries(Object.entries(MAP.modules).map(([name, module]) => [name, module.may_import]));
  assert.deepEqual(policy, ADR_0645_POLICY, 'changing may_import needs a decision superseding ADR-0645; update ADR_0645_POLICY in the same change');
});

test('the dependency policy has no cycles, composition roots included', () => {
  assert.equal(cycle(ADR_0645_POLICY), null);
  assert.deepEqual(cycle({ host: ['cli'], cli: ['host'] }), ['host', 'cli', 'host']);
});

test('credential-capable files are owned by identity', () => {
  const misplaced = CREDENTIAL_CAPABLE.filter((file) => MAP.files[file] !== 'identity');
  assert.deepEqual(misplaced, []);
  for (const module of ['harness', 'org', 'shared']) {
    assert.ok(!ADR_0645_POLICY[module].includes('identity'), `${module} must not reach credential custody`);
  }
});

test('no runtime file imports a computed specifier the map does not list', () => {
  const listed = MAP.computed_imports ?? {};
  const unlisted = runtimeFiles()
    .filter((file) => !Object.hasOwn(listed, file))
    .flatMap((file) => computedImports(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).map((call) => `${file}: ${call}`));
  assert.deepEqual(unlisted, [], 'a computed import hides its target from the boundary check: import a literal path, or list the file in computed_imports with a reason');
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

test('importSpecifiers ignores imports quoted in comments, strings and regexes', () => {
  const source = [
    "// import { x } from './line-comment.mjs';",
    "/* import './block-comment.mjs'; */",
    "const help = \"run: import './in-string.mjs'\";",
    "const shell = `node -e 'import(\\\"./in-template.mjs\\\")'`;",
    'const re = /import \\(\\.\\/in-regex\\.mjs\\)/u;',
    "plugin.import('./method.mjs');",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), []);
  assert.deepEqual(computedImports(source), []);
});

test('a string holding a comment opener does not hide the imports after it', () => {
  const source = [
    "const glob = 'src/*';",
    "import { a } from './after-glob.mjs';",
    "const half = '*/';",
    "import './after-close.mjs';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['./after-close.mjs', './after-glob.mjs']);
});

test('dynamic imports are literal edges or reported as computed, never dropped', () => {
  const source = [
    "await import('./literal.mjs');",
    'await import(`./template-literal.mjs`);',
    "await import('./attributes.json', { with: { type: 'json' } });",
    'const name = "./computed.mjs";',
    'await import(name);',
    'await import(`./${name}.mjs`);',
    "await import('./' + name);",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['./attributes.json', './literal.mjs', './template-literal.mjs']);
  assert.equal(computedImports(source).length, 3);
});

test('escaped, percent-encoded and suffixed specifiers still produce their edge', () => {
  // Each line loads secret-store.mjs under Node ESM; none is a computed import.
  const forms = [
    String.raw`import './secret\x2dstore.mjs';`,
    String.raw`import '.\u002fsecret-store.mjs';`,
    String.raw`import './secret\u{2d}store.mjs';`,
    'await import(`./secret\\x2dstore.mjs`);',
    "import './secret-store.mjs?cache=1';",
    "import './secret%2Dstore.mjs';",
    "import './secret-store.mjs#fragment';",
    "import './sub/../secret-store.mjs';",
    "import './secret\\\r\n-store.mjs';",
    "import './secret\\\n-store.mjs';",
  ];
  for (const form of forms) {
    const sources = { 'a.mjs': form, 'secret-store.mjs': '' };
    assert.deepEqual(moduleEdges('/unused', ['a.mjs', 'secret-store.mjs'], (file) => sources[file]), [{ from: 'a.mjs', to: 'secret-store.mjs' }], form);
    assert.deepEqual(computedImports(form), [], form);
  }
});

test('resolveSpecifier keeps repository-relative POSIX paths', () => {
  assert.equal(resolveSpecifier('cli/dispatch.mjs', '../git-hooks.mjs'), 'git-hooks.mjs');
  assert.equal(resolveSpecifier('agent-bot.mjs', './cli/parse.mjs'), 'cli/parse.mjs');
  assert.equal(resolveSpecifier('cli/dispatch.mjs', '../git%2Dhooks.mjs?v=2#x'), 'git-hooks.mjs');
  assert.equal(resolveSpecifier('a.mjs', './bad%zz.mjs'), 'bad%zz.mjs');
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

  const computed = sampleMap({ computed_imports: { 'a.mjs': ' ', 'z.mjs': 'plugin loader' } });
  assert.deepEqual(validateModuleMap(computed, ['a.mjs', 'b.mjs', 'c.mjs']), [
    'a.mjs: computed import needs a reason',
    'z.mjs: computed import listed for an unassigned file',
  ]);
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

test('a contract admits only the modules it names, and only into that file', () => {
  const map = sampleMap({
    files: { 'a.mjs': 'identity', 'b.mjs': 'soul', 'c.mjs': 'shared', 'd.mjs': 'soul' },
    contracts: { 'd.mjs': { importable_by: ['identity'], exports: ['x'], reason: 'narrow' } },
  });
  const edges = [
    { from: 'a.mjs', to: 'd.mjs' }, // identity -> soul contract: allowed
    { from: 'a.mjs', to: 'b.mjs' }, // identity -> soul internals: crossing
    { from: 'c.mjs', to: 'd.mjs' }, // shared is not named: crossing
  ];
  assert.deepEqual(crossingEdges(map, edges).map(edgeKey), ['a.mjs -> b.mjs', 'c.mjs -> d.mjs']);
});

test('a contract entry is validated', () => {
  const map = sampleMap({
    contracts: {
      'b.mjs': { importable_by: ['soul', 'nope'], exports: [], reason: ' ' },
      'z.mjs': { importable_by: ['identity'], exports: ['x'], reason: 'r' },
    },
  });
  assert.deepEqual(validateModuleMap(map, ['a.mjs', 'b.mjs', 'c.mjs']), [
    'b.mjs: contract must not list its own module',
    'b.mjs: contract names unknown module nope',
    'b.mjs: contract needs its exports listed',
    'b.mjs: contract needs a reason',
    'z.mjs: contract listed for an unassigned file',
  ]);
});

test('exportedNames reads declarations and export lists, not comments', () => {
  const source = [
    '// export function hidden() {}',
    'export const A = 1;',
    'export function b() {}',
    'export async function c() {}',
    'const d = 1; const e = 2;',
    'export { d, e as f };',
  ].join('\n');
  assert.deepEqual(exportedNames(source), ['A', 'b', 'c', 'd', 'f']);
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
