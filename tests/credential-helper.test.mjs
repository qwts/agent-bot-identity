import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCredentialRequest } from '../git-credential-bot.mjs';

test('parses git credential key=value request lines', () => {
  const request = parseCredentialRequest('protocol=https\nhost=github.com\npath=example/photos.git\n\n');
  assert.deepEqual(request, { protocol: 'https', host: 'github.com', path: 'example/photos.git' });
});

test('keeps = signs inside values intact', () => {
  const request = parseCredentialRequest('password=abc=def\n');
  assert.equal(request.password, 'abc=def');
});

test('ignores blank and malformed lines', () => {
  const request = parseCredentialRequest('\n=nokey\nhost=github.com\n');
  assert.deepEqual(request, { host: 'github.com' });
});
