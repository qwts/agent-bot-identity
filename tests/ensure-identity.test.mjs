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

// PATH alone is not enough: harness startup runs in a non-login shell, and any
// shell other than zsh gets no registration at all. Without this rung the script
// reports the runtime missing while the symlink is present.
test('scripts/ensure-identity.sh falls back to the installed location', () => {
  const body = readFileSync(script, 'utf8');
  assert.match(body, /installed_agent_bot="\$HOME\/\.local\/bin\/agent-bot"/);
  assert.match(body, /elif \[\[ -x "\$installed_agent_bot" \]\]; then/);
  // Ordering matters — PATH first, so an explicitly chosen agent-bot still wins.
  assert.ok(body.indexOf('command -v agent-bot') < body.indexOf('-x "$installed_agent_bot"'));
});
