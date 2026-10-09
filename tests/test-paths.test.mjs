// A file URL's `.pathname` is percent-encoded: a checkout under a directory
// with a space (every "<name> - Genius.soul" worktree) turns into `%20` and
// the path no longer exists (#653). Tests derive filesystem paths from
// import.meta.url with fileURLToPath instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = fileURLToPath(new URL('.', import.meta.url));
const PATHNAME_OF_MODULE_URL = /import\.meta\.url\s*\)\s*\.pathname/u;

function testSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testSources(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

test('tests never take a filesystem path from a module URL\'s pathname', () => {
  const offenders = testSources(TESTS)
    .filter((file) => PATHNAME_OF_MODULE_URL.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(TESTS.length));
  assert.deepEqual(offenders, [], 'use fileURLToPath(new URL(..., import.meta.url)) so paths with spaces resolve');
});

test('the guard recognizes the percent-encoding pattern it forbids', () => {
  // Assembled so this file does not contain the pattern it scans for.
  const forbidden = ["new URL('../agent-bot.mjs', import.meta.url)", '.pathname'].join('');
  assert.match(forbidden, PATHNAME_OF_MODULE_URL);
  assert.doesNotMatch("fileURLToPath(new URL('../agent-bot.mjs', import.meta.url))", PATHNAME_OF_MODULE_URL);
  assert.doesNotMatch("new URL(request.url, 'http://127.0.0.1').pathname", PATHNAME_OF_MODULE_URL);
});
