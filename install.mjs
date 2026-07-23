#!/usr/bin/env node
// One-time machine setup: point git's global core.hooksPath at this clone's
// hooks/ directory so every `git worktree add` (from any tool) configures the
// bot identity automatically.
//
//   node install.mjs
//
// Refuses to clobber an existing, different core.hooksPath — that would
// silently disable whatever hooks the machine already relies on; the error
// tells you what was found so you can chain or decide deliberately.

import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), 'hooks');

let existing = '';
try {
  existing = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
} catch {
  /* unset */
}

if (existing && existing !== hooksDir) {
  console.error(
    `core.hooksPath is already set to:\n  ${existing}\n` +
      `Not overwriting it. Either remove that setting, or add a call to\n` +
      `  ${join(hooksDir, 'post-checkout')}\n` +
      `from your existing post-checkout hook.`,
  );
  process.exit(1);
}

chmodSync(join(hooksDir, 'post-checkout'), 0o755);
execFileSync('git', ['config', '--global', 'core.hooksPath', hooksDir]);
console.log(`core.hooksPath -> ${hooksDir}`);
console.log('Next: create your GitHub App(s), store keys under ~/.config/<slug>/, and write ~/.config/agent-bot/config.json — see README.md.');
