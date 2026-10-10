import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RUNTIME_CATALOG, RUNTIME_CATALOG_VERSION, SHA256_HEX, catalogReleaseHash } from '../runtime-catalog.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
// Rebuild every object with its keys in reverse order.
const reversed = (value) => {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversed(value[key])]));
  return value;
};

test('the catalog release hash is a stable digest of the bundled catalog (#617)', () => {
  const hash = catalogReleaseHash();
  assert.match(hash, SHA256_HEX);
  assert.equal(catalogReleaseHash(), hash);
  assert.equal(catalogReleaseHash({ catalog: clone(RUNTIME_CATALOG) }), hash);
  assert.equal(catalogReleaseHash({ catalog: reversed(RUNTIME_CATALOG) }), hash, 'key order must not matter');
});

test('the catalog release hash is SHA-256 over canonical JSON of { catalog, version } (#617)', () => {
  const catalog = { node: [{ version: '1.2.3', sources: { 'linux-x64': { url: 'https://e.test/n', sha256: 'a'.repeat(64), bin: 'bin' } } }] };
  const expected = createHash('sha256')
    .update('{"catalog":{"node":[{"sources":{"linux-x64":{"bin":"bin","sha256":"' + 'a'.repeat(64) + '","url":"https://e.test/n"}},"version":"1.2.3"}]},"version":1}')
    .digest('hex');
  assert.equal(catalogReleaseHash({ catalog, version: 1 }), expected);
});

test('any change to a pin, URL, digest, pin order or the schema version changes the release hash (#617)', () => {
  const base = catalogReleaseHash();
  const edits = [
    (c) => { c.node[0].version = '0.0.1'; },
    (c) => { c.node[0].sources['linux-x64'].url += '?x'; },
    (c) => { c.node[0].sources['linux-x64'].sha256 = '0'.repeat(64); },
    (c) => { c.node[0].sources['linux-x64'].bin = '.'; },
    (c) => { c.node.reverse(); },
    (c) => { c.python.pop(); },
    (c) => { delete c.go; },
  ];
  for (const edit of edits) {
    const catalog = clone(RUNTIME_CATALOG);
    edit(catalog);
    assert.notEqual(catalogReleaseHash({ catalog }), base, edit.toString());
  }
  assert.notEqual(catalogReleaseHash({ version: RUNTIME_CATALOG_VERSION + 1 }), base);
});
