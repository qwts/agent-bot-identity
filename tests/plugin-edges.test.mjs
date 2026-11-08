// Where each runtime file goes in the HQ split, and no new plugin -> plugin
// imports (#1390; agent-bot-daemon plan docs/daemon-plugin-split.md, §9
// Stage 0 row 6).
//
// The columns. `destinations.files` in governance/runtime-modules.json gives
// every runtime file a `target` and a `domain`, and an optional `note`:
//
// - target: where the code goes, in the plan's vocabulary (§2.1, §3.1,
//   Appendix A). It names a destination, not a repository: soul-runtime/* is
//   agent-bot-souls (package and render code goes to soul-package), comms is
//   agent-comms, identity is agent-bot-identity's plugin and Soul-side tools,
//   daemon is HQ core in agent-bot-daemon, daemon/sdk is @agent-bot/sdk.
// - domain: the trust domain the code runs in (Appendix A's Domain column).
//
// The allowed names are frozen below and described in `destinations.targets`
// and `destinations.domains`, so a typo fails here and a new name is a
// reviewed change to this test.
//
// How they were filled. Appendix A, the audit's per-file table at
// agent-bot-identity 959daf9, is the source. Files added since are mapped by
// §2.1's rules and carry a note. Where the appendix and the platform
// (true-line/agent-bot-platform at main) differ, the platform wins:
//
// - identity code that runs in HQ goes to `daemon`: HQ identity authority is
//   HQ core, not a plugin (PDR-0027). The appendix wrote `identity` and
//   deferred to §2.1, which says the same.
// - code that runs in the Soul never goes to `daemon`: HQ runs outside every
//   Soul, and the agent-bot CLI members run, the harness hooks and the member
//   surfaces are agent-bot-identity's (repository catalog, PDR-0027). The
//   appendix wrote `daemon` for agent-hook, agent-mcp, daemon-mcp and skill.
// - the owner's commands go to `daemon`: they are the HQ CLI, which the
//   catalog gives agent-bot-daemon. The appendix wrote `identity (owner
//   command)` and `soul-runtime (owner command)`.
// - a re-export shim goes where the file it re-exports goes.
//
// Plugin -> plugin edge. §3.4 rule 1: plugins import only @agent-bot/sdk,
// never the daemon and never each other. The plugins are the three that
// consume hq-plugin-contract (platform seams): `identity`, `comms` and
// `soul-runtime` (core, hq and entry-point are one plugin, whose core both
// other parts use). The identity service is counted with them: it is a
// separate program that HQ reaches only over its hardened link (§4.7), so
// code bound for it may not import plugin code, and plugin code may not
// import it. An edge is a static or literal dynamic import between two
// runtime files (tests/helpers/module-graph.mjs) whose targets belong to two
// different ones of those four. Imports of daemon/sdk, of daemon and by
// daemon, and anything touching a `deprecated` file, are not plugin ->
// plugin edges. (Plugins reaching the host are §2.2's host services; HQ core
// importing a plugin is the strangler until §9 rows 25 to 27.)
//
// The baseline. Today's plugin -> plugin edges are listed in BASELINE, each
// with the §9 row or plan section that removes it. A new edge fails, and so
// does a listed edge that no longer exists, so the list only shrinks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { edgeKey, moduleEdges } from './helpers/module-graph.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAP = JSON.parse(readFileSync(new URL('../governance/runtime-modules.json', import.meta.url), 'utf8'));

const TARGETS = [
  'daemon',
  'daemon/sdk',
  'identity',
  'identity service',
  'comms',
  'soul-runtime/core',
  'soul-runtime/hq',
  'soul-runtime/entry-point',
  'deprecated',
];
const DOMAINS = ['HQ', 'Soul', 'HQ + Soul', 'identity service', 'owner client', 'removed'];

// The target -> separately shipped component, for the targets that are one.
const COMPONENT = {
  identity: 'identity',
  comms: 'comms',
  'soul-runtime/core': 'soul-runtime',
  'soul-runtime/hq': 'soul-runtime',
  'soul-runtime/entry-point': 'soul-runtime',
  'identity service': 'identity service',
};

const ROW_3B = '§9 row 3, part 3b (#1384), waiting on the owner: supersede the #645 decision of 2026-10-09 so soul-runtime registers the declarations (§2.4 C1 remedy 1), or mint from the grant (remedy 2, §9 rows 17 and 18)';
const ROW_9 = "§9 row 9: the MCP registry stamps reach-mcp's server entry and rules; §2.2 lists wake-plane -> daemon-mcp as a plugin reaching the host, which becomes a host service";
const ROW_18 = '§9 row 18: HQ resolves credential references and no App key or App store stays on the host, so local key custody goes';
const ROW_24 = '§9 row 24: the comms modules move into agent-comms; §2.2 names the host service, event or broker message kind that replaces this import';
const ROW_24_WAKE = '§9 row 24: the comms modules move into agent-comms; wake decisions are the local broker\'s (§4.8)';
const ROW_25 = '§9 row 25: soul and comms code leaves agent-bot-identity; a member surface asks HQ through a broker query instead (§4.2, PDR-0027)';

const BASELINE = {
  'agent-hook.mjs -> agent-population.mjs': ROW_25,
  'agent-hook.mjs -> confinement.mjs': ROW_25,
  'cold-wake-settings.mjs -> wake-webhook-store.mjs': ROW_24,
  'cold-wake.mjs -> comms-relay.mjs': ROW_24,
  'daemon-mcp.mjs -> agent-population.mjs': ROW_25,
  'daemon-mcp.mjs -> comms-relay.mjs': ROW_25,
  'daemon-mcp.mjs -> reach-contract.mjs': ROW_25,
  'daemon-mcp.mjs -> soul-asides.mjs': ROW_25,
  'daemon-mcp.mjs -> soul-threads.mjs': ROW_25,
  'identity/ensure-private-key.mjs -> identity/resolve-agent.mjs': ROW_18,
  'identity/gh-pr-view-json.mjs -> identity/identity-app-store.mjs': ROW_18,
  'identity/soul-credentials.mjs -> soul-app-declarations.mjs': ROW_3B,
  'owner-action.mjs -> owner-principal.mjs': ROW_24,
  'session-bind.mjs -> wake-resume.mjs': ROW_25,
  'soul-build.mjs -> reach-contract.mjs': ROW_24,
  'soul-builder.mjs -> reach-contract.mjs': ROW_24,
  'soul-fork.mjs -> comms-membership.mjs': ROW_24,
  'soul-join.mjs -> comms-membership.mjs': ROW_24,
  'soul-remove.mjs -> comms-membership.mjs': ROW_24,
  'start.mjs -> agent-population.mjs': ROW_25,
  'start.mjs -> comms-client.mjs': ROW_25,
  'start.mjs -> setup-worktree.mjs': ROW_25,
  'start.mjs -> soul-join.mjs': ROW_25,
  'start.mjs -> soul-worktrees.mjs': ROW_25,
  'wake-plane.mjs -> daemon-mcp.mjs': ROW_9,
  'wake-plane.mjs -> wake-dispatch.mjs': ROW_24_WAKE,
};

// Structural errors in `destinations`: every file in `files` has exactly one
// destination with known names, and nothing else is listed.
function validateDestinations(map) {
  const errors = [];
  const destinations = map.destinations ?? {};
  const listed = destinations.files ?? {};
  const targets = Object.keys(destinations.targets ?? {});
  const domains = Object.keys(destinations.domains ?? {});
  if (JSON.stringify(targets) !== JSON.stringify(TARGETS)) errors.push(`destinations.targets must describe exactly ${TARGETS.join(', ')}`);
  if (JSON.stringify(domains) !== JSON.stringify(DOMAINS)) errors.push(`destinations.domains must describe exactly ${DOMAINS.join(', ')}`);
  for (const [name, text] of [...Object.entries(destinations.targets ?? {}), ...Object.entries(destinations.domains ?? {})]) {
    if (typeof text !== 'string' || !text.trim()) errors.push(`${name}: needs a description`);
  }
  for (const file of Object.keys(map.files ?? {})) {
    if (!Object.hasOwn(listed, file)) errors.push(`${file}: no destination (give it a target and a domain)`);
  }
  for (const [file, entry] of Object.entries(listed)) {
    if (!Object.hasOwn(map.files ?? {}, file)) errors.push(`${file}: destination for a file the map does not assign`);
    const extra = Object.keys(entry ?? {}).filter((key) => !['target', 'domain', 'note'].includes(key));
    if (extra.length) errors.push(`${file}: unknown destination field ${extra.join(', ')}`);
    if (!TARGETS.includes(entry?.target)) errors.push(`${file}: unknown target ${entry?.target}`);
    if (!DOMAINS.includes(entry?.domain)) errors.push(`${file}: unknown domain ${entry?.domain}`);
    if (entry && 'note' in entry && (typeof entry.note !== 'string' || !entry.note.trim())) errors.push(`${file}: an empty note`);
    // HQ runs outside every Soul (repository catalog), and what is removed
    // runs nowhere.
    if (entry?.target === 'daemon' && !['HQ', 'owner client'].includes(entry.domain)) errors.push(`${file}: daemon code runs in HQ or as the owner's client, not ${entry.domain}`);
    if ((entry?.target === 'deprecated') !== (entry?.domain === 'removed')) errors.push(`${file}: deprecated and removed go together`);
  }
  return errors;
}

// Edges between files bound for two different separately shipped
// components (see the header).
function pluginEdges(map, edges) {
  const component = (file) => COMPONENT[map.destinations.files[file]?.target];
  return edges.filter(({ from, to }) => {
    const source = component(from);
    const target = component(to);
    return source !== undefined && target !== undefined && source !== target;
  });
}

function runtimeEdges() {
  return moduleEdges(ROOT, Object.keys(MAP.files));
}

test('every runtime file has one destination, with a known target and domain', () => {
  assert.deepEqual(validateDestinations(MAP), []);
});

test('destinations are sorted by file so a new file has one place to go', () => {
  const files = Object.keys(MAP.destinations.files);
  assert.deepEqual(files, [...files].sort());
});

test('a re-export shim goes where the file it re-exports goes', () => {
  const differ = Object.entries(MAP.shims ?? {})
    .filter(([old, moved]) => JSON.stringify(MAP.destinations.files[old]) !== JSON.stringify({
      target: MAP.destinations.files[moved]?.target,
      domain: MAP.destinations.files[moved]?.domain,
    }))
    .map(([old, moved]) => `${old} -> ${moved}`);
  assert.deepEqual(differ, []);
});

test('no plugin -> plugin import beyond the recorded baseline', () => {
  const now = pluginEdges(MAP, runtimeEdges()).map(edgeKey);
  const added = now.filter((key) => !Object.hasOwn(BASELINE, key));
  const stale = Object.keys(BASELINE).filter((key) => !now.includes(key));
  assert.deepEqual(added, [], 'new plugin -> plugin imports: go through @agent-bot/sdk, a host service or an event (plan §3.4)');
  assert.deepEqual(stale, [], 'these plugin -> plugin imports are gone: remove them from BASELINE');
});

test('each baseline edge is sorted and names the plan row or section that removes it', () => {
  const keys = Object.keys(BASELINE);
  assert.deepEqual(keys, [...keys].sort());
  for (const [key, reason] of Object.entries(BASELINE)) assert.match(reason, /§\d/u, key);
});

function sampleMap(files) {
  return {
    files: Object.fromEntries(Object.keys(files).map((file) => [file, 'soul'])),
    destinations: {
      targets: Object.fromEntries(TARGETS.map((name) => [name, 'described'])),
      domains: Object.fromEntries(DOMAINS.map((name) => [name, 'described'])),
      files,
    },
  };
}

test('pluginEdges counts imports between plugins and the identity service, nothing else', () => {
  const map = sampleMap({
    'id.mjs': { target: 'identity', domain: 'Soul' },
    'core.mjs': { target: 'soul-runtime/core', domain: 'HQ + Soul' },
    'hq.mjs': { target: 'soul-runtime/hq', domain: 'HQ' },
    'entry.mjs': { target: 'soul-runtime/entry-point', domain: 'Soul' },
    'comms.mjs': { target: 'comms', domain: 'HQ' },
    'svc.mjs': { target: 'identity service', domain: 'identity service' },
    'sdk.mjs': { target: 'daemon/sdk', domain: 'HQ + Soul' },
    'hq-core.mjs': { target: 'daemon', domain: 'HQ' },
    'old.mjs': { target: 'deprecated', domain: 'removed' },
  });
  const edges = [
    { from: 'id.mjs', to: 'core.mjs' }, // identity -> soul-runtime: counted
    { from: 'hq.mjs', to: 'comms.mjs' }, // soul-runtime -> comms: counted
    { from: 'svc.mjs', to: 'core.mjs' }, // identity service -> soul-runtime: counted
    { from: 'id.mjs', to: 'svc.mjs' }, // identity -> identity service: counted
    { from: 'hq.mjs', to: 'core.mjs' }, // within soul-runtime
    { from: 'entry.mjs', to: 'hq.mjs' }, // within soul-runtime
    { from: 'id.mjs', to: 'sdk.mjs' }, // to the SDK
    { from: 'comms.mjs', to: 'hq-core.mjs' }, // a plugin reaching the host
    { from: 'hq-core.mjs', to: 'id.mjs' }, // HQ core composing a plugin
    { from: 'old.mjs', to: 'comms.mjs' }, // deprecated code
  ];
  assert.deepEqual(pluginEdges(map, edges).map(edgeKey), [
    'id.mjs -> core.mjs',
    'hq.mjs -> comms.mjs',
    'svc.mjs -> core.mjs',
    'id.mjs -> svc.mjs',
  ]);
});

test('validateDestinations rejects a missing file, a typo and a mismatched pair', () => {
  const ok = sampleMap({ 'a.mjs': { target: 'identity', domain: 'Soul' } });
  assert.deepEqual(validateDestinations(ok), []);

  const missing = sampleMap({});
  missing.files['new.mjs'] = 'soul';
  assert.deepEqual(validateDestinations(missing), ['new.mjs: no destination (give it a target and a domain)']);

  const stray = sampleMap({ 'a.mjs': { target: 'identity', domain: 'Soul' } });
  delete stray.files['a.mjs'];
  assert.deepEqual(validateDestinations(stray), ['a.mjs: destination for a file the map does not assign']);

  assert.deepEqual(validateDestinations(sampleMap({ 'a.mjs': { target: 'soul-runtime/hqq', domain: 'HQ' } })), ['a.mjs: unknown target soul-runtime/hqq']);
  assert.deepEqual(validateDestinations(sampleMap({ 'a.mjs': { target: 'comms', domain: 'hq' } })), ['a.mjs: unknown domain hq']);
  assert.deepEqual(validateDestinations(sampleMap({ 'a.mjs': { target: 'comms', domain: 'HQ', owner: 'x' } })), ['a.mjs: unknown destination field owner']);
  assert.deepEqual(validateDestinations(sampleMap({ 'a.mjs': { target: 'comms', domain: 'HQ', note: ' ' } })), ['a.mjs: an empty note']);
  assert.deepEqual(validateDestinations(sampleMap({ 'a.mjs': { target: 'daemon', domain: 'Soul' } })), ['a.mjs: daemon code runs in HQ or as the owner\'s client, not Soul']);
  assert.deepEqual(validateDestinations(sampleMap({ 'a.mjs': { target: 'deprecated', domain: 'HQ' } })), ['a.mjs: deprecated and removed go together']);
  assert.deepEqual(validateDestinations(sampleMap({ 'a.mjs': { target: 'comms', domain: 'removed' } })), ['a.mjs: deprecated and removed go together']);

  const renamed = sampleMap({});
  renamed.destinations.targets = { ...renamed.destinations.targets, plugin: 'new' };
  assert.deepEqual(validateDestinations(renamed), [`destinations.targets must describe exactly ${TARGETS.join(', ')}`]);
});
