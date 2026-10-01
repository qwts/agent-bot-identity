import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCredentialRequest } from '../git-credential-bot.mjs';
const TOOL = fileURLToPath(new URL('../git-credential-bot.mjs', import.meta.url));

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

test('credential helper refuses to mint when github-identity is off', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'credential-helper-gate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [TOOL, 'you-codex-agent', 'get'], {
    encoding: 'utf8', input: 'protocol=https\nhost=github.com\n',
    env: { ...process.env, HOME: home, AGENT_BOT_CONFIG: join(home, 'missing.json') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /github-identity add-on is off/);
  assert.equal(result.stdout, '');
});
