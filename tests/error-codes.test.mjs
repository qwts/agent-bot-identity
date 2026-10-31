// The diagnostic error-code registry (ADR-0983): versioned and add-only.
// Codes are never removed, renumbered or re-kinded; a retired one is marked
// `deprecated`. Where git can see the base branch the registry is compared
// with it; everywhere, numbering must be contiguous so a removal shows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LAUNCH_CODES, LAUNCH_REFUSALS } from '../daemon-launch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PATH = 'governance/error-codes.json';
const REGISTRY = JSON.parse(readFileSync(new URL(`../${PATH}`, import.meta.url), 'utf8'));
const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KEYS = new Set(['n', 'code', 'component', 'kind', 'registered', 'summary', 'deprecated']);

test('the registry has a known schema and well-formed, uniquely numbered entries', () => {
  assert.deepEqual(Object.keys(REGISTRY).sort(), ['codes', 'description', 'schema_version']);
  assert.equal(REGISTRY.schema_version, 1);
  const seen = new Set();
  REGISTRY.codes.forEach((entry, index) => {
    assert.deepEqual(Object.keys(entry).filter((key) => !KEYS.has(key)), [], entry.code);
    assert.equal(entry.n, index + 1, `${entry.code}: numbering is contiguous and in order`);
    assert.match(entry.code, CODE);
    assert.ok(entry.code.length <= 64, entry.code);
    assert.equal(seen.has(entry.code), false, `${entry.code} is registered once`);
    seen.add(entry.code);
    assert.match(entry.component, CODE);
    assert.ok(['refusal', 'failure'].includes(entry.kind), entry.code);
    assert.match(entry.registered, /^\d+\.\d+\.\d+$/);
    assert.ok(typeof entry.summary === 'string' && entry.summary.length > 0 && entry.summary.length <= 200, entry.code);
    if ('deprecated' in entry) assert.equal(entry.deprecated, true, entry.code);
  });
});

test('every launch code the daemon emits is registered', () => {
  const registered = new Set(REGISTRY.codes.map((entry) => entry.code));
  assert.deepEqual([...LAUNCH_CODES].filter((code) => !registered.has(code)), []);
});

function baseRegistry() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const ref of ['origin/main', 'main']) {
    try {
      const base = git(['merge-base', 'HEAD', ref]).trim();
      return JSON.parse(git(['show', `${base}:${PATH}`]));
    } catch { /* no such ref, or the registry is new there */ }
  }
  return null;
}

test('the registry only grows relative to the base branch', (t) => {
  const base = baseRegistry();
  if (!base) { t.skip('base branch registry not available (shallow checkout or first version)'); return; }
  const now = new Map(REGISTRY.codes.map((entry) => [entry.code, entry]));
  for (const old of base.codes) {
    const entry = now.get(old.code);
    assert.ok(entry, `${old.code} was removed`);
    for (const key of ['n', 'component', 'kind', 'registered']) assert.equal(entry[key], old[key], `${old.code}.${key} changed`);
    if (old.deprecated) assert.equal(entry.deprecated, true, `${old.code} was un-deprecated`);
  }
  assert.ok(REGISTRY.schema_version >= base.schema_version);
});

test('a launch code is an expected refusal exactly when the registry says so', () => {
  const kinds = new Map(REGISTRY.codes.map((entry) => [entry.code, entry.kind]));
  for (const code of LAUNCH_CODES) {
    assert.equal(LAUNCH_REFUSALS.has(code) ? 'refusal' : 'failure', kinds.get(code), code);
  }
});

// #1209: no dead entries — every registered code is either referenced by
// shipped runtime source or explicitly reserved here with a reason. The
// registry is add-only, so a retired-in-code code is reserved, not deleted.
const RESERVED = new Map([
  // code: reason it is registered but not referenced in runtime source
]);
test('every registered code is used by runtime source or explicitly reserved', () => {
  const map = JSON.parse(readFileSync(new URL('../governance/runtime-modules.json', import.meta.url), 'utf8'));
  const files = [...Object.keys(map.files ?? {}), ...Object.keys(map.shims ?? {})];
  const sources = files.map((file) => {
    try { return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'); } catch { return ''; }
  }).join('\n');
  // A code is "used" only when it appears as a quoted literal — 'code',
  // "code" or `code` — never as a substring of a longer name.
  const quotedIn = (text, code) => text.includes(`'${code}'`) || text.includes(`"${code}"`) || text.includes(`\`${code}\``);
  assert.equal(quotedIn("'device-revoked'", 'device'), false, 'a prefix match is not a use');
  assert.equal(quotedIn('"device-revoked"', 'device-revoked'), true);
  const dead = REGISTRY.codes
    .filter((entry) => !quotedIn(sources, entry.code))
    .filter((entry) => !RESERVED.has(entry.code));
  assert.deepEqual(
    dead.map((entry) => `${entry.code} (n=${entry.n})`),
    [],
    `registered codes with no runtime reference and no reserved reason: ${dead.map((e) => e.code).join(', ') || 'none'}`,
  );
});

// A code emitted on the MCP, machine or daemon surfaces that is not in the
// registry passes the registry->source direction unnoticed (#1266 found
// doctor-unavailable only in review). Scan every emitted literal both ways.
const EMITTED_FILES = ['agent-mcp.mjs', 'machine-client.mjs', 'cli/machine.mjs', 'agent-daemon.mjs'];
const EMITTED_PATTERN = /(?:mcpError|mcError)\('([a-z][a-z0-9-]+)'|code: '([a-z][a-z0-9-]+)'/g;

test('every stable code the MCP, machine and daemon surfaces emit is registered', () => {
  const registered = new Set(REGISTRY.codes.map((entry) => entry.code));
  for (const file of EMITTED_FILES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const emitted = [...source.matchAll(EMITTED_PATTERN)].map((m) => m[1] ?? m[2]);
    const missing = [...new Set(emitted)].filter((code) => !registered.has(code));
    assert.deepEqual(missing, [], `${file} emits unregistered codes`);
  }
});
