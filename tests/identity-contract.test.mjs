// docs/identity-contract.md is identity's public contract (ADR-0645 step 7).
// These keep it in step with the module map and identity's record entry:
// every identity file listed under `contracts` has a section, and the record
// operations table names exactly the entry's operations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { IDENTITY_OPS } from '../identity-entry.mjs';

const doc = readFileSync(new URL('../docs/identity-contract.md', import.meta.url), 'utf8');
const map = JSON.parse(readFileSync(new URL('../governance/runtime-modules.json', import.meta.url), 'utf8'));

function section(heading) {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the contract has a "${heading}" section`);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

test('every published identity entry in the module map has a section, and no other', () => {
  const listed = Object.keys(map.contracts ?? {}).filter((file) => map.files[file] === 'identity').sort();
  const documented = [...section('Published entries').matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(documented, listed);
});

test('the record operations table names exactly the entry operations', () => {
  const documented = [...section('Record operations').matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]).sort();
  assert.deepEqual(documented, Object.keys(IDENTITY_OPS).sort());
});
