import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SETUP = join(REPO, 'scripts', 'cloud', 'setup.sh');
const PLATFORM = `linux-${arch() === 'arm64' ? 'arm64' : 'x64'}`;

// A release-shaped archive: the real install.sh beside a bundle whose
// agent-bot only records what it was asked. `cloud` and `bootstrap` answer as
// the case needs.
function fakeDist(t, { cloud = true, bootstrapExit = 0, bootstrapOutput = '', corrupt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, 'src');
  mkdirSync(join(src, 'bundle', 'bin'), { recursive: true });
  mkdirSync(join(src, 'bundle', 'node', 'bin'), { recursive: true });
  mkdirSync(join(src, 'bundle', 'lib', 'agent-comms', 'bin'), { recursive: true });
  cpSync(join(REPO, 'scripts', 'linux-bundle', 'install.sh'), join(src, 'install.sh'));
  cpSync(join(REPO, 'scripts', 'linux-bundle', 'lib'), join(src, 'lib'), { recursive: true });
  cpSync(join(REPO, 'scripts', 'linux-bundle', 'systemd'), join(src, 'systemd'), { recursive: true });
  writeFileSync(join(src, 'bundle', 'bin', 'agent-bot'), `#!/bin/sh
printf '%s|%s\\n' "\${AGENT_BOT_SUPERVISOR_SKIP_LOAD:-}" "$*" >> "$HOME/calls.log"
case "$1 $2" in
  "--version "*) echo 0.0.0-test ;;
  "cloud --help") ${cloud ? 'exit 0' : 'exit 1'} ;;
  "cloud install-hooks") echo "added SessionStart and SessionEnd hooks" ;;
  "bootstrap "*) printf '%s\\n' ${JSON.stringify(bootstrapOutput)}; exit ${bootstrapExit} ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(src, 'bundle', 'bin', 'agent-comms'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(src, 'bundle', 'node', 'bin', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(src, 'bundle', 'lib', 'agent-comms', 'bin', 'agent-comms.mjs'), '');
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const name = `agent-bot-${PLATFORM}-v0.0.0.tar.gz`;
  execFileSync('tar', ['-czf', join(dist, name), '-C', src, '.']);
  const sum = corrupt ? '0'.repeat(64) : createHash('sha256').update(readFileSync(join(dist, name))).digest('hex');
  writeFileSync(join(dist, 'SHA256SUMS'), `${sum}  ${name}\n`);
  const home = join(root, 'home');
  mkdirSync(home);
  return { dist, home, calls: () => (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n') : []) };
}

function setup(box, args = []) {
  return spawnSync('sh', [SETUP, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: box.home, AGENT_BOT_SETUP_DIST: box.dist, TMPDIR: tmpdir() },
  });
}

test('setup installs the bundle for this user and registers the session hooks', (t) => {
  const box = fakeDist(t);
  const r = setup(box);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(box.home, '.local', 'bin', 'agent-bot')), 'the wrapper is installed');
  assert.ok(box.calls().includes('|cloud install-hooks'));
  assert.ok(!box.calls().some((c) => c.includes('bootstrap')), 'no profile, no bootstrap');
  assert.match(r.stdout, /Set AGENT_BOT_SERVER on the environment/);
  // Again: the install replaces its own wrapper and nothing fails.
  assert.equal(setup(box).status, 0);
});

test('a profile is applied with the systemd load skipped; failed credential checks before enrollment are fine, a failed profile is not', (t) => {
  const profile = join(mkdtempSync(join(tmpdir(), 'cloud-setup-profile-')), 'org.json');
  writeFileSync(profile, '{}');
  const ready = fakeDist(t, { bootstrapExit: 1, bootstrapOutput: '  ok    organization profile acme schema v1\n  FAIL  [acme-claude-agent] not enrolled' });
  const r = setup(ready, ['--profile', profile]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /credential checks wait for enrollment/);
  assert.ok(ready.calls().includes(`1|bootstrap --profile ${profile} --with-gh-shim --machine-only`));

  const broken = fakeDist(t, { bootstrapExit: 1, bootstrapOutput: '  FAIL  organization profile is not compatible' });
  const failed = setup(broken, ['--profile', profile]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /did not apply the organization profile/);
  assert.ok(!broken.calls().includes('|cloud install-hooks'), 'nothing past a failed profile');

  assert.match(setup(ready, ['--profile', 'http://example.invalid/p.json']).stderr, /must be https/);
});

test('a bundle without the cloud command, a checksum mismatch and bad flags are refused', (t) => {
  const old = fakeDist(t, { cloud: false });
  const r = setup(old);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no `cloud` command; install a newer --version, or build one with --from-checkout/);
  assert.equal(setup(old, ['--no-hooks']).status, 0, '--no-hooks installs without registering hooks');

  const corrupt = fakeDist(t, { corrupt: true });
  const c = setup(corrupt);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /does not match its SHA256SUMS entry/);
  assert.ok(!existsSync(join(corrupt.home, '.local', 'bin', 'agent-bot')), 'nothing is installed from an unverified archive');

  assert.match(setup(old, ['--version', 'v1', '--from-checkout', '.']).stderr, /cannot be combined/);
  assert.match(setup(old, ['--sideways']).stderr, /unknown option: --sideways/);
  assert.match(setup(old, ['--help']).stdout, /sh scripts\/cloud\/setup\.sh/);
});
