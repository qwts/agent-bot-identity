#!/usr/bin/env node
// Self-diagnosis for the whole identity chain. Run it on any machine — ideally
// from inside the worktree that misbehaves — and read the FAIL lines:
//
//   node src/doctor.mjs
//
// Checks, in dependency order: runtime, hook installation, config, per-App
// credentials with a LIVE mint against GitHub, bot-user resolution (with the
// enterprise authenticated fallback), and the state of the current repo /
// worktree. Exit code 1 if anything configured is broken.

import process from 'node:process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, apiBase, slugForHarness, resolveSlug } from './config.mjs';
import { detectHarness, HARNESSES } from './detect-harness.mjs';
import { mint } from './mint-token.mjs';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
let failures = 0;

function ok(msg) {
  process.stdout.write(`  ok    ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`  warn  ${msg}\n`);
}
function fail(msg, fix) {
  failures += 1;
  process.stdout.write(`  FAIL  ${msg}\n        fix: ${fix}\n`);
}
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function main() {
  process.stdout.write('agent-bot doctor\n\n-- runtime --\n');
  ok(`node ${process.version}`);
  try {
    ok(git('--version'));
  } catch {
    fail('git not found on PATH', 'install git / fix PATH for the environment that runs hooks');
  }

  process.stdout.write('\n-- hook installation --\n');
  let hooksPath = '';
  try {
    hooksPath = git('config', '--global', '--get', 'core.hooksPath');
  } catch {
    /* unset */
  }
  if (!hooksPath) {
    fail('core.hooksPath is not set globally', 'run: node install.mjs (from this clone)');
  } else if (hooksPath !== HOOKS_DIR) {
    warn(`core.hooksPath -> ${hooksPath} (not this clone's hooks/; fine only if that copy is current)`);
  } else {
    ok(`core.hooksPath -> ${hooksPath}`);
  }
  try {
    accessSync(join(HOOKS_DIR, 'post-checkout'), constants.X_OK);
    ok('post-checkout hook is executable');
  } catch {
    fail('hooks/post-checkout is not executable', `run: chmod +x ${join(HOOKS_DIR, 'post-checkout')}`);
  }

  process.stdout.write('\n-- config --\n');
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(err.message, 'fix the JSON — plain double quotes, quoted keys, no trailing commas');
    process.stdout.write(`\n${failures} problem(s) found\n`);
    process.exitCode = 1;
    return;
  }
  if (Object.keys(config).length === 0) {
    fail(
      'no config at ~/.config/agent-bot/config.json (tool is inert without it)',
      'write it — e.g. { "prefix": "you" } or { "apps": { "claude": "<app-slug>" } }; see README',
    );
  } else {
    ok(`config loaded: ${JSON.stringify(config)}`);
  }
  ok(`api base: ${apiBase(config)}`);
  const slugs = new Map();
  for (const { key } of HARNESSES) {
    const slug = slugForHarness(key, config);
    if (slug) slugs.set(key, slug);
  }
  if (slugs.size === 0 && Object.keys(config).length > 0) {
    fail('config resolves no harness to any slug', 'set "prefix" or an "apps" map in the config');
  }
  for (const [key, slug] of slugs) process.stdout.write(`        ${key} -> ${slug}\n`);
  const here = detectHarness();
  const hereSlug = resolveSlug({ argv: [], env: process.env, config });
  if (here) ok(`current environment detects harness "${here}"${hereSlug ? ` -> ${hereSlug}` : ''}`);
  else warn('no harness detected in the current environment (a bare terminal is a deliberate no-op)');

  process.stdout.write('\n-- per-App credentials (live) --\n');
  for (const [, slug] of slugs) {
    const dir = join(homedir(), '.config', slug);
    try {
      readFileSync(join(dir, 'app-id'), 'utf8');
      readFileSync(join(dir, 'private-key.pem'), 'utf8');
    } catch {
      fail(`[${slug}] missing key material`, `create ${dir}/app-id and ${dir}/private-key.pem (README step 2)`);
      continue;
    }
    try {
      const grant = await mint({ slug });
      ok(`[${slug}] mint ok (installation ${grant.installation_id}, expires ${grant.expires_at})`);
    } catch (err) {
      fail(`[${slug}] mint failed: ${err.message}`, '401 = app-id/key mismatch or revoked key; "could not pick an installation" = set "owner" in the config; not installed = install the App on the account');
    }
  }

  process.stdout.write('\n-- current repo --\n');
  try {
    const gitDir = git('rev-parse', '--absolute-git-dir');
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    if (gitDir === common) {
      warn('primary checkout — the hook never touches these (by design)');
    } else {
      ok('linked worktree');
      let name = '';
      try {
        name = git('config', '--worktree', 'user.name');
      } catch {
        /* not configured */
      }
      if (name) ok(`configured as ${name}`);
      else
        fail(
          'worktree not configured (created before install, or no identity resolved at creation)',
          'run: node src/setup-worktree.mjs <app-slug>   (from this worktree)',
        );
      try {
        const origin = git('remote', 'get-url', 'origin');
        if (/^(ssh:\/\/)?git@/.test(origin)) {
          fail(`origin is SSH (${origin}) — pushes would authenticate as the human`, 'run setup-worktree (it rewrites to HTTPS) or set the remote to https://');
        } else ok(`origin ${origin}`);
      } catch {
        warn('no origin remote');
      }
    }
  } catch {
    warn('not inside a git repository — repo checks skipped');
  }

  process.stdout.write(failures ? `\n${failures} problem(s) found\n` : '\nall checks passed\n');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`doctor: ${err.message}`);
  process.exit(1);
});
