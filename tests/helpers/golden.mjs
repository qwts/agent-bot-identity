// Shared by the golden surface tests (#1379): golden files, and running the
// real agent-bot entry point sealed and fenced.
//
// A golden changes only on purpose. To accept a change, regenerate with
//   AGENT_BOT_UPDATE_GOLDEN=1 node --test tests/golden-*.test.mjs
// and commit the diff in tests/golden/surface/ with the change that caused it.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = path.join(import.meta.dirname, '..', '..');
const GOLDEN_DIR = path.join(ROOT, 'tests', 'golden', 'surface');
const UPDATE = process.env.AGENT_BOT_UPDATE_GOLDEN === '1';
const GUARD = pathToFileURL(path.join(import.meta.dirname, 'golden-guard.mjs')).href;

export function golden(name, actual) {
  const file = path.join(GOLDEN_DIR, name);
  const text = typeof actual === 'string' ? actual : `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  let expected;
  try {
    expected = readFileSync(file, 'utf8');
  } catch {
    assert.fail(`missing golden ${name}; regenerate with AGENT_BOT_UPDATE_GOLDEN=1`);
  }
  assert.equal(text, expected, `${name} changed; if intended, regenerate with AGENT_BOT_UPDATE_GOLDEN=1 and commit the diff`);
}

export function readGolden(name) {
  return readFileSync(path.join(GOLDEN_DIR, name), 'utf8');
}

/**
 * A sealed box: a fresh HOME and temporary directory, and an environment with
 * no inherited agent-bot, QWTS or harness variables, so nothing on this
 * machine can change the output. Every run is fenced by golden-guard.mjs, so
 * nothing here can touch this machine either: no program but node starts, no
 * connection leaves the box, and no write lands outside it. `refused` lists
 * what the fence stopped during that run. `extraEnv` may be a function of the
 * box's path, for settings that name files inside it.
 */
export function sealedBox(extraEnv = {}) {
  const box = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-bot-golden-')));
  const home = path.join(box, 'home');
  mkdirSync(home);
  const logs = path.join(box, 'guard');
  mkdirSync(logs);
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: box, LANG: 'C', NO_COLOR: '1',
    AGENT_COMMS_SHARED_DIR: path.join(box, 'comms'),
    GOLDEN_GUARD_BOX: box, NODE_OPTIONS: `--import=${GUARD}`,
    ...(typeof extraEnv === 'function' ? extraEnv(box) : extraEnv),
  };
  let runs = 0;
  // Machine paths never reach a golden.
  const scrub = (text) => text.replaceAll(home, '<home>').replaceAll(box, '<box>');
  return {
    box,
    home,
    scrub,
    run(args) {
      const log = path.join(logs, `${runs += 1}.jsonl`);
      writeFileSync(log, '');
      return new Promise((resolve) => {
        execFile(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), ...args],
          { cwd: home, env: { ...env, GOLDEN_GUARD_LOG: log }, encoding: 'utf8', timeout: 30_000 },
          (error, stdout, stderr) => {
            const refused = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
            const status = error ? (typeof error.code === 'number' ? error.code : null) : 0;
            resolve({ status, stdout: scrub(stdout), stderr: scrub(stderr), refused });
          });
      });
    },
    // Every path under HOME with its size: enough to see that a run wrote nothing.
    homeTree() {
      const out = [];
      const walk = (dir, rel) => {
        for (const entry of readdirSync(dir).sort()) {
          const full = path.join(dir, entry);
          const stat = statSync(full);
          out.push(`${path.join(rel, entry)}${stat.isDirectory() ? '/' : ` ${stat.size}`}`);
          if (stat.isDirectory()) walk(full, path.join(rel, entry));
        }
      };
      walk(home, '');
      return out;
    },
    cleanup() {
      rmSync(box, { recursive: true, force: true });
    },
  };
}

/** One command in a box of its own; `home` is what it left in HOME. */
export async function cli(args) {
  const box = sealedBox();
  try {
    const result = await box.run(args);
    return { ...result, home: box.homeTree() };
  } finally {
    box.cleanup();
  }
}

/** Runs `task` over `items`, at most `limit` at a time, keeping their order. */
export async function inPool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A command's result as a golden section: what a person would see. */
export function transcript(args, { status, stdout, stderr }) {
  const block = (text) => (text === '' ? '' : text.endsWith('\n') ? text : `${text}\n[no newline at end]\n`);
  return `$ agent-bot ${args.join(' ')}\nexit: ${status}\nstdout:\n${block(stdout)}stderr:\n${block(stderr)}`;
}
