import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'scripts',
  'ensure-identity.sh',
);

test('scripts/ensure-identity.sh exists and is executable', () => {
  accessSync(script, constants.F_OK | constants.X_OK);
  const body = readFileSync(script, 'utf8');
  assert.match(body, /^#!\/usr\/bin\/env bash/m);
  assert.match(body, /setup-worktree\.mjs/);
  assert.match(body, /agentBot\.agentId/);
});
