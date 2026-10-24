import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stableConfigModulePath } from '../identity/install-gh-shim.mjs';

// #1176: the gh shim records the config module by absolute path. Under
// Homebrew that path is the versioned Cellar directory brew deletes on
// upgrade; the stable opt path must be recorded instead.
test('a Cellar config path is recorded through the stable opt path', () => {
  const cellar = '/opt/homebrew/Cellar/agent-bot/0.12.0/libexec/config.mjs';
  const opt = '/opt/homebrew/opt/agent-bot/libexec/config.mjs';
  assert.equal(stableConfigModulePath(cellar, { exists: (p) => p === opt }), opt);
  // No opt candidate (not a Homebrew install): keep the derived path.
  assert.equal(stableConfigModulePath(cellar, { exists: () => false }), cellar);
  // Non-Cellar layouts are untouched.
  const plain = '/Users/x/.local/share/agent-bot/config.mjs';
  assert.equal(stableConfigModulePath(plain, { exists: () => true }), plain);
  // Intel Homebrew prefix works the same.
  assert.equal(
    stableConfigModulePath('/usr/local/Cellar/agent-bot/0.13.0/libexec/config.mjs', { exists: () => true }),
    '/usr/local/opt/agent-bot/libexec/config.mjs',
  );
});
