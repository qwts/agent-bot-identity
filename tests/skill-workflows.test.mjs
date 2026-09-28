// Representative workflow and output-contract tests for the agent-bot skill
// (ENG-0055 release-gate check 5). The shared cli-skill-gate runs them
// against the packaged executable through CLI_SKILL_GATE_EXECUTABLE; `npm
// test` runs them against this checkout's launcher. Every probe is offline and
// read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXECUTABLE = process.env.CLI_SKILL_GATE_EXECUTABLE || fileURLToPath(new URL('../agent-bot', import.meta.url));
const SOURCE_SKILL = fileURLToPath(new URL('../skills/agent-bot/SKILL.md', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const run = (...args) => spawnSync(EXECUTABLE, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 10_000,
});

test('--version prints the bare release version and nothing else', () => {
  const r = run('--version');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${VERSION}\n`);
  assert.equal(r.stderr, '');
});

test('skill path reports the bundled skill and its source commit', () => {
  const r = run('skill', 'path');
  assert.equal(r.status, 0, r.stderr);
  const [bundle, commitLine] = r.stdout.trimEnd().split('\n');
  assert.match(commitLine, /^commit ([0-9a-f]{40}|unknown)$/);
  assert.equal(readFileSync(join(bundle, 'SKILL.md'), 'utf8'), readFileSync(SOURCE_SKILL, 'utf8'));

  const json = run('skill', 'path', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { path: bundle, commit: commitLine.slice('commit '.length) });
});

test('every command the skill classifies is one the CLI documents', () => {
  const skill = readFileSync(SOURCE_SKILL, 'utf8');
  const section = skill.slice(skill.indexOf('## Know the side effects'), skill.indexOf('## Verify the outcome'));
  // The Commands column of each table row.
  const table = section.split('\n').filter((line) => /^\| (read-only|local-write|remote-write|destructive) \|/.test(line))
    .map((line) => line.split('|')[2]).join(' ');
  const commands = [...table.matchAll(/`([a-z-]+)(?: [a-z-]+)*`/g)].map((m) => m[1]).filter((c) => !c.startsWith('-'));
  assert.ok(commands.length >= 10, 'the side-effect table lists the commands');
  const help = run('--help');
  assert.equal(help.status, 0, help.stderr);
  for (const command of commands) assert.match(help.stdout, new RegExp(`^ {2}${command} `, 'm'), command);
});

test('the publish preview the skill requires is available offline', () => {
  const r = run('signed-commit', '--help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--dry-run/);
  const doctor = run('doctor', '--help');
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /--json/);
});

test('an unknown command fails on stderr with a non-zero exit and no stdout', () => {
  const r = run('no-such-command');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'agent-bot: unknown command: no-such-command\n');
});

test('a missing bundle is reported, not invented', () => {
  assert.ok(existsSync(SOURCE_SKILL));
  const r = run('skill', 'list');
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
});
