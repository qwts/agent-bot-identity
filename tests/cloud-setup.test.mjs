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

const READY_CHECKS = [
  { id: 'config.profile', status: 'ready' },
  { id: 'config.feature_gates', status: 'ready' },
  { id: 'runtime.installed_cli', status: 'ready' },
];
// A fresh host before enrollment: every App's credential check waits, and so
// does the gh shim, which bootstrap installs only once credentials are ready.
const PENDING = {
  ready: false,
  machine: {
    checks: [...READY_CHECKS, { id: 'shim.gh', status: 'failed', code: 'gh-shim-missing' }],
    apps: [{ slug: 'acme-claude-agent', credential: { id: 'credential.local', status: 'failed', code: 'provider-unavailable' }, live_mint: { id: 'credential.live_mint', status: 'skipped' } }],
  },
};

// A release-shaped archive: the real install.sh beside a bundle whose
// agent-bot only records what it was asked. `cloud` and `bootstrap` answer as
// the case needs.
function fakeDist(t, { cloud = true, bootstrapExit = 0, readiness = null, corrupt = false } = {}) {
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
  "cloud install-hooks") echo "added SessionStart hook" ;;
  "bootstrap "*) cat "$(dirname "$0")/../readiness.json"; exit ${bootstrapExit} ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(src, 'bundle', 'bin', 'agent-comms'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The readiness check runs on the bundled Node, so the stand-in is a real one.
  writeFileSync(join(src, 'bundle', 'node', 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(src, 'bundle', 'readiness.json'), JSON.stringify(readiness ?? { ready: true, machine: { checks: READY_CHECKS, apps: [] } }));
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

test('a profile is applied with github-identity on; only the checks that wait for enrollment may fail (#1430 review)', (t) => {
  const profile = join(mkdtempSync(join(tmpdir(), 'cloud-setup-profile-')), 'org.json');
  writeFileSync(profile, '{}');
  const pending = fakeDist(t, { bootstrapExit: 1, readiness: PENDING });
  const r = setup(pending, ['--profile', profile]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /credentials and the gh shim follow enrollment/);
  assert.ok(pending.calls().includes(`1|bootstrap --profile ${profile} --features github-identity --with-gh-shim --machine-only --json`));

  const ready = fakeDist(t);
  assert.match(setup(ready, ['--profile', profile]).stdout, /machine readiness passes/);

  const refused = {
    'a failed runtime install, profile applied or not': { ...PENDING, machine: { ...PENDING.machine, checks: [...PENDING.machine.checks, { id: 'bootstrap.runtime', status: 'failed', code: 'runtime-install-failed', message: 'bootstrap could not install the managed CLI and hooks' }] } },
    'a profile that did not apply': { ...PENDING, machine: { ...PENDING.machine, checks: PENDING.machine.checks.filter((c) => c.id !== 'config.profile') } },
    'the github-identity gate off': { ...PENDING, machine: { ...PENDING.machine, checks: PENDING.machine.checks.map((c) => (c.id === 'config.feature_gates' ? { ...c, status: 'warning' } : c)) } },
    'a credential failure that enrollment does not fix': { ...PENDING, machine: { ...PENDING.machine, apps: [{ slug: 'acme-claude-agent', credential: { id: 'credential.local', status: 'failed', code: 'app-key-mismatch' } }] } },
    'a shim that failed to install': { ...PENDING, machine: { ...PENDING.machine, checks: [...READY_CHECKS, { id: 'bootstrap.gh_shim', status: 'failed', code: 'gh-shim-install-failed' }] } },
    'no readiness at all': {},
  };
  for (const [name, readiness] of Object.entries(refused)) {
    const box = fakeDist(t, { bootstrapExit: 1, readiness });
    const failed = setup(box, ['--profile', profile]);
    assert.equal(failed.status, 1, name);
    assert.match(failed.stderr, /bootstrap failed beyond the credential checks that wait for enrollment/, name);
    assert.ok(!box.calls().includes('|cloud install-hooks'), `${name}: nothing past a failed bootstrap`);
  }
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
