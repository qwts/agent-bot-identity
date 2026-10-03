// Headless-Linux CLI bundle (ADR-0332 decisions 1 and 2, issue #337).
//
// Two boundaries are tested. The build is tested without a network: a local
// tarball stands in for the pinned Node, so the assembly, the checksum and the
// refusal on a mismatch are all hermetic. install.sh and uninstall.sh are
// executed against a temp HOME with a fake systemctl and a fake ps, because the
// whole point of decision 2 is what the installer does when it finds — or does
// not find — another pair, and that cannot be observed without running it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPlatform,
  commsKeepSet,
  parseArgs,
  readComponents,
  tagCommit,
  verifyCommsSurface,
  writeChecksums,
} from '../scripts/linux-bundle/build.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE = join(REPO, 'scripts', 'linux-bundle');
const INSTALL = join(BUNDLE, 'install.sh');
const UNINSTALL = join(BUNDLE, 'uninstall.sh');

// GeniusBar #41's marker. install.sh must write exactly this, because that is
// the ownership contract the wrappers of all three install paths share.
const WRAPPER_MARKER = '# agent-bot-linux-cli-tool';
const PATH_BEGIN = '# >>> agent-bot PATH >>>';
const PATH_END = '# <<< agent-bot PATH <<<';

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `linux-bundle-${label}-`));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// --------------------------------------------------------------- build inputs

// A tarball shaped exactly like nodejs.org's: one versioned top directory whose
// bin/node is the binary. Nothing here runs it.
function fakeNodeTarball(dir, platform) {
  const version = readComponents().node.version;
  const arch = platform.replace('linux-', '');
  const root = join(dir, `node-v${version}-${platform}`);
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'node'), `#!/bin/sh\necho v${version}-${arch}\n`, { mode: 0o755 });
  writeFileSync(join(root, 'README.md'), '# not the real Node\n');
  const archive = join(dir, `node-v${version}-${platform}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, `node-v${version}-${platform}`]);
  return archive;
}

// A tiny stand-in for the archive install.sh consumes: bundle/bin/*, the pinned
// agent-comms entry the broker unit execs, plus the bundled node. install.sh
// checks exactly these four files and nothing else.
function fakeArchiveSource(dir) {
  const bundle = join(dir, 'bundle');
  const node = readComponents().node.version;
  mkdirSync(join(bundle, 'node', 'bin'), { recursive: true });
  mkdirSync(join(bundle, 'bin'), { recursive: true });
  mkdirSync(join(bundle, 'lib', 'agent-comms', 'bin'), { recursive: true });
  writeFileSync(join(bundle, 'node', 'bin', 'node'), `#!/bin/sh\necho v${node}\n`, { mode: 0o755 });
  writeFileSync(join(bundle, 'bin', 'agent-bot'), '#!/bin/sh\necho "agent-bot $*"\n', { mode: 0o755 });
  writeFileSync(join(bundle, 'bin', 'agent-comms'), '#!/bin/sh\necho "agent-comms $*"\n', { mode: 0o755 });
  writeFileSync(
    join(bundle, 'lib', 'agent-comms', 'bin', 'agent-comms.mjs'),
    `#!/usr/bin/env node\nconsole.log('agent-comms ${node} $*');\n`,
    { mode: 0o755 },
  );
  return bundle;
}

// ------------------------------------------------------------- harness doubles

// systemctl is injected rather than mocked in JS: install.sh reaches it through
// a subprocess, so the seam has to be an executable.
function fakeSystemctl(home, { active = 'inactive', enabled = 'disabled', enableFails = false } = {}) {
  const bin = join(home, 'fakes');
  mkdirSync(bin, { recursive: true });
  const log = join(home, 'systemctl.log');
  const path = join(bin, 'systemctl');
  writeFileSync(path, `#!/bin/sh
printf '%s\\n' "systemctl $*" >> "${log}"
case "$*" in
  *is-active*) printf '%s\\n' "${active}" ;;
  *is-enabled*) printf '%s\\n' "${enabled}" ;;
  *"enable --now"*) [ "${enableFails}" = true ] && exit 1 ;;
esac
exit 0
`);
  chmodSync(path, 0o755);
  return { path, log };
}

function fakePs(home, lines) {
  const bin = join(home, 'fakes');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'ps');
  writeFileSync(path, `#!/bin/sh
cat <<'PROCESSES'
${lines.join('\n')}
PROCESSES
`);
  chmodSync(path, 0o755);
  return path;
}

function runScript(script, { home, cwd, args = [], systemctl, ps, shell = 'sh' }) {
  return spawnSync(shell, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      SHELL: '/bin/bash',
      TMPDIR: join(home, 'tmp'),
      ...(systemctl ? { AGENT_BOT_SYSTEMCTL: systemctl } : {}),
      ...(ps ? { AGENT_BOT_PS: ps } : {}),
    },
  });
}

function systemctlCalls(log) {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

function machine(label, options = {}) {
  const root = tempDir(label);
  const home = join(root, 'home');
  const archive = join(root, 'archive');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, 'tmp'), { recursive: true });
  mkdirSync(archive, { recursive: true });
  fakeArchiveSource(archive);
  const systemctl = fakeSystemctl(root, options);
  const ps = fakePs(root, options.processes ?? []);
  const env = {
    home,
    root,
    archive,
    systemctl: systemctl.path,
    ps,
    log: systemctl.log,
  };
  env.install = (args = []) => runScript(INSTALL, { home, cwd: archive, args, systemctl: env.systemctl, ps: env.ps });
  env.uninstall = (args = []) => runScript(UNINSTALL, { home, cwd: archive, args, systemctl: env.systemctl, ps: env.ps });
  env.read = (relativePath) => readFileSync(join(home, relativePath), 'utf8');
  env.exists = (relativePath) => existsSync(join(home, relativePath));
  env.cleanup = () => rmSync(root, { recursive: true, force: true });
  return env;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// --------------------------------------------------------------------- the pin

test('components.json pins Node by checksum and agent-comms by commit', () => {
  const components = readComponents();
  assert.equal(components.schema_version, 1);
  assert.match(components.node.version, /^\d+\.\d+\.\d+$/u);
  for (const platform of ['linux-x64', 'linux-arm64']) {
    const pin = components.node.tarballs[platform];
    assert.match(pin.sha256, /^[0-9a-f]{64}$/u, `${platform} needs a sha256`);
    assert.match(pin.url, new RegExp(`node-v${components.node.version.replaceAll('.', String.raw`\.`)}-${platform}\\.tar\\.gz$`, 'u'));
  }
  // GeniusBar's pin, coordinate for coordinate. The agent-comms this runtime
  // talks to is the qwts repository, not the unrelated npm package that shares
  // the name, and the commit SHA is the integrity pin.
  assert.equal(components.agent_comms.repo, 'qwts/agent-comms');
  assert.match(components.agent_comms.tag, /^v\d+\.\d+\.\d+$/u);
  assert.match(components.agent_comms.ref, /^[0-9a-f]{40}$/u);
  assert.equal(components.agent_comms.bin, 'bin/agent-comms.mjs');
  // The verbs the runtime actually calls, pinned as the contract the archive is
  // checked against.
  assert.deepEqual(components.agent_comms.required_verbs, ['join', 'inbox', 'send', 'broker']);
});

test('the bundled Node satisfies the engines both halves declare', () => {
  // One runtime serves both halves of the pair, so a Node that either package
  // refuses makes the archive worse than useless. agent-bot's own package.json
  // is read from the tree; agent-comms v0.3.4 declares
  // `^22.22.2 || ^24.15.0 || >=26.0.0`, re-read this when the pin moves.
  const agentBot = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(agentBot.engines.node, '>=20');
  const [major, minor, patch] = readComponents().node.version.split('.').map(Number);
  assert.ok(major >= 20, `agent-bot requires node >=20, the bundle pins ${[major, minor, patch].join('.')}`);
  const agentCommsAllows = (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)))
    || (major === 24 && (minor > 15 || (minor === 15 && patch >= 0)))
    || major >= 26;
  assert.ok(agentCommsAllows, `agent-comms v0.3.4 requires ^22.22.2 || ^24.15.0 || >=26.0.0, the bundle pins ${[major, minor, patch].join('.')}`);
});

test('a pin without an integrity anchor is refused rather than trusted', () => {
  const root = tempDir('pin');
  const file = join(root, 'components.json');
  const components = readComponents();
  delete components.node.tarballs['linux-arm64'].sha256;
  writeFileSync(file, JSON.stringify(components));
  assert.throws(() => readComponents(file), /no sha256 for node linux-arm64/u);

  // A short SHA, a branch or a missing tag cannot be verified before the fetch,
  // so it never reaches the fetch.
  for (const mutate of [
    (pin) => { pin.ref = pin.ref.slice(0, 12); },
    (pin) => { pin.tag = '0.3.2'; },
    (pin) => { delete pin.tag; },
  ]) {
    const broken = readComponents();
    mutate(broken.agent_comms);
    writeFileSync(file, JSON.stringify(broken));
    assert.throws(() => readComponents(file), /must pin agent-comms by repo, release tag and full commit SHA/u);
  }

  const wrongSchema = readComponents();
  wrongSchema.schema_version = 2;
  writeFileSync(file, JSON.stringify(wrongSchema));
  assert.throws(() => readComponents(file), /unsupported components schema_version/u);
  rmSync(root, { recursive: true, force: true });
});

test('build.mjs parses only the documented options', () => {
  const options = parseArgs(['--platform', 'all', '--out', 'dist', '--require-verified']);
  assert.deepEqual(options, {
    platform: 'all', out: 'dist', requireVerified: true, skipComms: false, offline: false, help: false,
  });
  assert.equal(parseArgs(['--platform=linux-arm64']).platform, 'linux-arm64');
  assert.throws(() => parseArgs(['--platform']), /--platform requires a value/u);
  assert.throws(() => parseArgs(['--wat']), /unknown option: --wat/u);
});

// ---------------------------------------------------------- the comms contract

test('the tag must resolve to the pinned commit, and an annotated tag is peeled', () => {
  const commit = 'a'.repeat(40);
  // A lightweight tag is the commit itself.
  assert.equal(tagCommit(`${commit}\trefs/tags/v0.3.2\n`, 'v0.3.2'), commit);
  // An annotated tag lists the tag object first and the commit as `^{}`; the
  // commit is what the pin means, and it is what git must fetch.
  const annotated = `${'b'.repeat(40)}\trefs/tags/v0.3.2\n${commit}\trefs/tags/v0.3.2^{}\n`;
  assert.equal(tagCommit(annotated, 'v0.3.2'), commit);
  // A tag that is not there resolves to nothing, which is never the pinned ref.
  assert.equal(tagCommit(`${'c'.repeat(40)}\trefs/tags/v0.3.1\n`, 'v0.3.2'), null);
  assert.equal(tagCommit('', 'v0.3.2'), null);
});

test('only what agent-comms declares it ships is copied into the archive', () => {
  // The pinned tree's own `files` list, plus the manifest and the licence.
  assert.deepEqual(
    [...commsKeepSet({ files: ['bin/', 'lib/', 'skills/'] })].sort(),
    ['LICENSE', 'LICENSE.md', 'bin', 'lib', 'package.json', 'skills'],
  );
  // A package with no `files` ships its whole tree instead, which the caller
  // then filters; the build treats those two shapes differently.
  assert.equal(commsKeepSet({}), null);
  assert.equal(commsKeepSet({ files: 'bin' }), null);
});

test('the verb check runs the fetched CLI instead of reading its source', () => {
  const root = tempDir('comms-surface');
  const entry = join(root, 'agent-comms.mjs');
  writeFileSync(entry, [
    'console.log("  agent-comms join [--name VALUE]");',
    'console.log("  agent-comms send TO [--body VALUE]");',
    'console.log("  agent-comms inbox read [--limit VALUE]");',
    '',
  ].join('\n'));
  const surface = verifyCommsSurface({ entry, requiredVerbs: ['join', 'inbox', 'send', 'broker'] });
  assert.deepEqual(surface.provided, ['inbox', 'join', 'send']);
  assert.deepEqual(surface.missing, ['broker']);
  assert.equal(surface.help_failed, null);

  // A CLI that cannot even print its help dispatches none of the verbs, and
  // says why instead of failing the build with an opaque spawn error.
  const broken = join(root, 'broken.mjs');
  writeFileSync(broken, 'process.stderr.write("cannot start\\n");\nprocess.exit(3);\n');
  const refused = verifyCommsSurface({ entry: broken, requiredVerbs: ['join'] });
  assert.deepEqual(refused.provided, []);
  assert.deepEqual(refused.missing, ['join']);
  assert.match(refused.help_failed, /cannot start/u);

  // A verb that only appears inside another word is not a dispatched verb.
  const partial = join(root, 'partial.mjs');
  writeFileSync(partial, 'console.log("  agent-comms sender-up --x");\n');
  assert.deepEqual(verifyCommsSurface({ entry: partial, requiredVerbs: ['send'] }).missing, ['send']);
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ the build

test('the assembled archive carries the pinned Node, the runtime tree, and the installers', async () => {
  const root = tempDir('build');
  const nodeTarball = fakeNodeTarball(root, 'linux-x64');
  const out = join(root, 'dist');
  const components = readComponents();
  components.node.tarballs['linux-x64'].sha256 = sha256(nodeTarball);
  const previous = process.env.AGENT_BOT_NODE_TARBALL;
  process.env.AGENT_BOT_NODE_TARBALL = nodeTarball;
  let report;
  try {
    report = await buildPlatform('linux-x64', { components, out, skipComms: true, offline: true });
  } finally {
    if (previous === undefined) delete process.env.AGENT_BOT_NODE_TARBALL;
    else process.env.AGENT_BOT_NODE_TARBALL = previous;
  }

  assert.equal(report.platform, 'linux-x64');
  assert.equal(report.sha256, sha256(join(out, report.archive)));
  assert.equal(report.node.version, components.node.version);

  const listed = execFileSync('tar', ['-tzf', join(out, report.archive)], { encoding: 'utf8' }).split('\n');
  assert.ok(listed.includes('./install.sh'));
  assert.ok(listed.includes('./uninstall.sh'));
  assert.ok(listed.includes('./lib/common.sh'));
  assert.ok(listed.includes('./systemd/agent-bot-daemon.service.in'));
  assert.ok(listed.includes('./systemd/agent-comms-broker.service.in'));
  assert.ok(listed.includes('./components.json'));
  assert.ok(listed.includes('./bundle/node/bin/node'));
  // The runtime tree is the whole checkout minus what the formula also drops,
  // and minus dist/: a build that runs twice must not nest the first archive in
  // the second, or copy its own output directory into itself.
  assert.ok(listed.includes('./bundle/lib/agent-bot/agent-bot.mjs'));
  assert.ok(listed.includes('./bundle/lib/agent-bot/skills/agent-bot/SKILL.md'));
  for (const excluded of ['tests', 'docs', 'scripts', 'tools', 'Formula', 'governance', 'dist']) {
    assert.ok(
      !listed.some((entry) => entry.startsWith(`./bundle/lib/agent-bot/${excluded}/`)),
      `${excluded} must not ship in the bundle`,
    );
  }

  // install.sh and uninstall.sh must be executable inside the archive, or the
  // first thing a headless box does after untarring fails.
  const modes = execFileSync('tar', ['-tvzf', join(out, report.archive)], { encoding: 'utf8' });
  assert.match(modes, /^-rwxr-xr-x.*\s\.\/install\.sh$/mu);
  assert.match(modes, /^-rwxr-xr-x.*\.\/uninstall\.sh$/mu);
  rmSync(root, { recursive: true, force: true });
});

test('a downloaded artifact whose checksum does not match the pin fails the build', async () => {
  const root = tempDir('build-mismatch');
  const nodeTarball = fakeNodeTarball(root, 'linux-x64');
  const components = readComponents();
  // The pin stays the real one; the local override is a different artifact.
  const previous = process.env.AGENT_BOT_NODE_TARBALL;
  process.env.AGENT_BOT_NODE_TARBALL = nodeTarball;
  try {
    await assert.rejects(
      buildPlatform('linux-x64', { components, out: join(root, 'dist'), skipComms: true, offline: true }),
      /checksum mismatch/u,
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_BOT_NODE_TARBALL;
    else process.env.AGENT_BOT_NODE_TARBALL = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('SHA256SUMS covers the set so an x64 archive is never paired with an arm64 checksum', () => {
  const root = tempDir('checksums');
  const out = join(root, 'dist');
  mkdirSync(out, { recursive: true });
  writeChecksums(out, [
    { archive: 'agent-bot-linux-x64-v1.tar.gz', sha256: 'a'.repeat(64) },
    { archive: 'agent-bot-linux-arm64-v1.tar.gz', sha256: 'b'.repeat(64) },
  ]);
  const body = readFileSync(join(out, 'SHA256SUMS'), 'utf8');
  assert.equal(
    body,
    `${'b'.repeat(64)}  agent-bot-linux-arm64-v1.tar.gz\n${'a'.repeat(64)}  agent-bot-linux-x64-v1.tar.gz\n`,
  );
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------- install basics

test('#337: install writes every wrapper with the GeniusBar marker and one PATH block', () => {
  const box = machine('install');
  try {
    writeFileSync(join(box.home, '.profile'), 'export EXISTING=1\n');
    const result = box.install();
    assert.equal(result.status, 0, result.stderr);

    for (const name of ['agent-bot', 'agent-comms', 'node']) {
      const wrapper = join(box.home, '.local', 'bin', name);
      assert.ok(existsSync(wrapper), `${name} wrapper is missing`);
      const body = readFileSync(wrapper, 'utf8');
      assert.ok(body.startsWith('#!/bin/sh\n'), `${name} must be a shell script`);
      assert.ok(body.includes(`${WRAPPER_MARKER}\n`), `${name} must carry the marker line`);
      // The wrapper execs the bundled binary at the path this install chose, so
      // a stale PATH can never pick a different agent-bot than this one wrote.
      const bundled = join(box.home, '.local', 'share', 'agent-bot', 'bundle');
      const entry = name === 'node' ? join(bundled, 'node', 'bin', 'node') : join(bundled, 'bin', name);
      assert.ok(body.includes(`exec "${entry}" "$@"`));
      if (name === 'agent-bot') {
        // agent-bot's launcher resolves Node; the wrapper pins it to the
        // bundled copy so the pair can never straddle two runtimes.
        assert.ok(body.includes('AGENT_BOT_NODE="$AGENT_BOT_BUNDLE_ROOT/node/bin/node"'));
        assert.ok(body.includes('export AGENT_BOT_NODE'));
      }
      assert.ok(body.includes('PATH="$AGENT_BOT_BUNDLE_ROOT/bin:$PATH"'));
      // Running the wrapper must reach the bundled copy, not whatever the
      // caller's PATH would have found.
      const expected = name === 'node' ? `v${readComponents().node.version}` : name;
      assert.equal(execFileSync(wrapper, { encoding: 'utf8' }).trim(), expected);
    }
    assert.equal(execFileSync(join(box.home, '.local', 'bin', 'agent-comms'), { encoding: 'utf8' }).trim(), 'agent-comms');

    const profile = box.read('.profile');
    assert.equal(countOccurrences(profile, PATH_BEGIN), 1);
    assert.equal(countOccurrences(profile, PATH_END), 1);
    assert.match(profile, /export EXISTING=1/u);
    // zsh and sh both get a self-guarding entry, not a bare export.
    assert.match(profile, /\*":[^"]*\.local\/bin:"\*\) ;;/u);

    // One unit per half of the pair, both started.
    const calls = systemctlCalls(box.log);
    assert.ok(calls.includes('systemctl --user enable --now agent-bot-daemon.service'));
    assert.ok(calls.includes('systemctl --user enable --now agent-comms-broker.service'));
    const unit = box.read('.config/systemd/user/agent-bot-daemon.service');
    assert.match(unit, /^ExecStart=\S+\/bundle\/node\/bin\/node \S+\/bundle\/lib\/agent-bot\/agent-bot\.mjs daemon run$/mu);
    assert.doesNotMatch(unit, /@[A-Z_]+@/u);
    assert.match(unit, /AGENT_BOT_TOOL_PATH=\S+\/bundle\/bin/u);

    // The broker unit starts agent-comms the way agent-comms' own service
    // installer does (service-startup.mjs, single-account mode): the pinned
    // entry under the bundled Node, with `broker run --single-account`. Not the
    // bundle's shell launcher, and not a bare `broker`.
    const broker = box.read('.config/systemd/user/agent-comms-broker.service');
    assert.match(
      broker,
      /^ExecStart=\S+\/bundle\/node\/bin\/node \S+\/bundle\/lib\/agent-comms\/bin\/agent-comms\.mjs broker run --single-account$/mu,
    );
    assert.doesNotMatch(broker, /@[A-Z_]+@/u);
  } finally {
    box.cleanup();
  }
});

test('#337: a second install appends nothing to PATH and replaces its own wrappers', () => {
  const box = machine('install-twice');
  try {
    writeFileSync(join(box.home, '.profile'), 'export EXISTING=1\n');
    assert.equal(box.install().status, 0);
    const firstProfile = box.read('.profile');
    const firstWrapper = box.read('.local/bin/agent-bot');

    const again = box.install();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(box.read('.profile'), firstProfile, 'the PATH block must be added once');
    assert.equal(countOccurrences(box.read('.profile'), PATH_BEGIN), 1);
    // Our own marker means the file is ours to rewrite, so an upgrade works
    // without --replace.
    assert.equal(box.read('.local/bin/agent-bot'), firstWrapper);
    assert.match(again.stdout, /already carries the agent-bot PATH block/u);
  } finally {
    box.cleanup();
  }
});

test('#337: a startup file that already puts the wrapper directory on PATH is left alone', () => {
  // All three spellings a person writes it, so the managed block never lands
  // beside an entry the user already made.
  for (const line of [
    'export PATH="$HOME/.local/bin:$PATH"\n',
    'export PATH="$HOME/.local/bin:$PATH"\nexport PATH="$HOME/bin:$PATH"\n',
    'export PATH="/somewhere/else:$PATH"\nPATH="$HOME/.local/bin:$PATH"\n',
  ]) {
    const box = machine('install-hand-path');
    try {
      writeFileSync(join(box.home, '.profile'), line);
      const result = box.install();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(countOccurrences(box.read('.profile'), PATH_BEGIN), 0, `duplicated an entry for ${JSON.stringify(line)}`);
      assert.equal(box.read('.profile'), line);
      assert.match(result.stdout, /left it alone/u);
    } finally {
      box.cleanup();
    }
  }
});

test('#337: zsh registers through .zprofile and .profile is not touched', () => {
  const box = machine('install-zsh');
  try {
    const result = spawnSync('sh', [INSTALL, '--no-services'], {
      cwd: box.archive,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: box.home,
        SHELL: '/usr/local/bin/zsh',
        TMPDIR: join(box.home, 'tmp'),
        AGENT_BOT_SYSTEMCTL: box.systemctl,
        AGENT_BOT_PS: box.ps,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(countOccurrences(box.read('.zprofile'), PATH_BEGIN), 1);
    assert.equal(box.exists('.profile'), false);
  } finally {
    box.cleanup();
  }
});

test('#337: --no-services installs the tree and the wrappers but writes no unit', () => {
  const box = machine('install-no-services');
  try {
    const result = box.install(['--no-services']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(box.home, '.local', 'bin', 'agent-bot')));
    assert.equal(box.exists('.config/systemd/user/agent-bot-daemon.service'), false);
    assert.ok(!systemctlCalls(box.log).some((call) => call.includes('enable --now')));
    assert.match(box.read('.local/share/agent-bot/install-manifest'), /^services=none$/mu);
    assert.doesNotMatch(box.read('.local/share/agent-bot/install-manifest'), /^service=/mu);
  } finally {
    box.cleanup();
  }
});

test('#337: --prefix and --bin-dir move the install without touching the defaults', () => {
  const box = machine('install-prefix');
  try {
    const prefix = join(box.root, 'opt', 'agent-bot');
    const binDir = join(box.root, 'opt', 'bin');
    const result = box.install(['--prefix', prefix, '--bin-dir', binDir, '--no-services']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(prefix, 'bundle', 'bin', 'agent-bot')));
    assert.ok(existsSync(join(binDir, 'agent-bot')));
    assert.equal(box.exists('.local/bin/agent-bot'), false);
    assert.equal(box.exists('.local/share/agent-bot'), false);
    // The PATH block names the directory the wrappers really went to.
    assert.match(box.read('.profile'), new RegExp(binDir.replaceAll('/', String.raw`\/`), 'u'));
  } finally {
    box.cleanup();
  }
});

// ------------------------------------------------- foreign files and --replace

test('#337: a foreign file at a wrapper path is never overwritten without --replace', () => {
  const box = machine('foreign-wrapper');
  try {
    const foreign = '#!/bin/sh\necho "a homebrew agent-bot"\n';
    mkdirSync(join(box.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(box.home, '.local', 'bin', 'agent-bot'), foreign);

    const refused = box.install();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not an agent-bot bundle wrapper/u);
    assert.match(refused.stderr, /--replace/u);
    assert.equal(box.read('.local/bin/agent-bot'), foreign, 'the foreign file must be untouched');
    // It refused before starting anything, so no pair was left half-migrated.
    assert.ok(!systemctlCalls(box.log).some((call) => call.includes('enable --now')));

    const replaced = box.install(['--replace']);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(box.read('.local/bin/agent-bot'), new RegExp(WRAPPER_MARKER, 'u'));
    assert.equal(box.read('.local/bin/agent-bot.before-agent-bot'), foreign);

    const removed = box.uninstall();
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(box.read('.local/bin/agent-bot'), foreign, 'uninstall must put the foreign file back');
    assert.equal(box.exists('.local/bin/agent-bot.before-agent-bot'), false);
  } finally {
    box.cleanup();
  }
});

test('#337: a symlink at a wrapper path is foreign too', () => {
  const box = machine('foreign-symlink');
  try {
    const target = join(box.root, 'checkout', 'agent-bot');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\necho checkout\n', { mode: 0o755 });
    mkdirSync(join(box.home, '.local', 'bin'), { recursive: true });
    const link = join(box.home, '.local', 'bin', 'agent-bot');
    symlinkSync(target, link);

    const refused = box.install();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not an agent-bot bundle wrapper/u);

    assert.equal(box.install(['--replace']).status, 0);
    const uninstalled = box.uninstall();
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    assert.match(box.read('.local/bin/agent-bot'), /echo checkout/u);
  } finally {
    box.cleanup();
  }
});

// -------------------------------------------- decision 2: exactly one pair

test('#337: another install\u2019s pair is refused, and --migrate takes it over', () => {
  const foreignUnit = '[Unit]\nDescription=homebrew agent-bot daemon\n';
  const box = machine('second-pair', {
    active: 'active',
    enabled: 'enabled',
    processes: ['4242 /opt/homebrew/libexec/agent-bot daemon run', '4243 /opt/homebrew/bin/agent-comms broker'],
  });
  try {
    mkdirSync(join(box.home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(box.home, '.config', 'systemd', 'user', 'agent-bot-daemon.service'), foreignUnit);

    const refused = box.install();
    assert.notEqual(refused.status, 0, 'a second pair must never be started beside the first');
    assert.match(refused.stdout, /another install already runs a broker and a daemon/u);
    // The report names what it found and which install it belongs to, so the
    // operator can act on it rather than guess.
    assert.match(refused.stdout, /agent-bot-daemon\.service/u);
    assert.match(refused.stdout, /\/opt\/homebrew\/libexec\/agent-bot daemon run/u);
    assert.match(refused.stdout, /4243 \/opt\/homebrew\/bin\/agent-comms broker/u);
    assert.match(refused.stderr, /--migrate/u);
    // Nothing was changed: no install tree, no wrappers, no PATH block.
    assert.equal(box.exists('.local/share/agent-bot'), false);
    assert.equal(box.exists('.local/bin/agent-bot'), false);
    assert.equal(box.exists('.profile'), false);
    assert.equal(box.read('.config/systemd/user/agent-bot-daemon.service'), foreignUnit);
    assert.ok(!systemctlCalls(box.log).some((call) => call.includes('stop')));

    const migrated = box.install(['--migrate']);
    assert.equal(migrated.status, 0, migrated.stderr);
    const calls = systemctlCalls(box.log);
    // The other pair is stopped and disabled before ours is started.
    assert.ok(calls.indexOf('systemctl --user stop agent-bot-daemon.service') < calls.indexOf('systemctl --user enable --now agent-bot-daemon.service'));
    assert.ok(calls.includes('systemctl --user disable agent-comms-broker.service'));
    // Its unit file is preserved so a failure here can put it back.
    assert.equal(box.read('.local/share/agent-bot/agent-bot-daemon.service.migrated'), foreignUnit);
    assert.match(box.read('.config/systemd/user/agent-bot-daemon.service'), /Linux bundle/u);
  } finally {
    box.cleanup();
  }
});

test('#337: a failed migration puts the other install\u2019s pair back', () => {
  const box = machine('migrate-rollback', { active: 'active', enabled: 'enabled', enableFails: true });
  try {
    mkdirSync(join(box.home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(box.home, '.config', 'systemd', 'user', 'agent-comms-broker.service'), '[Unit]\nDescription=brew broker\n');

    const result = box.install(['--migrate']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not start agent-bot-daemon\.service/u);

    const calls = systemctlCalls(box.log);
    // Ours is disabled again, and the previous pair is enabled and started.
    assert.ok(calls.includes('systemctl --user disable --now agent-bot-daemon.service'));
    assert.ok(calls.includes('systemctl --user enable --now agent-comms-broker.service'));
    assert.match(result.stdout + result.stderr, /rolled back/u);
    // The unit file it took over is preserved so nothing about the other
    // install was destroyed by a run that failed.
    assert.match(box.read('.local/share/agent-bot/agent-comms-broker.service.migrated'), /brew broker/u);
  } finally {
    box.cleanup();
  }
});

test('#337: this install\u2019s own running pair is never mistaken for a second one', () => {
  const box = machine('own-pair');
  try {
    assert.equal(box.install().status, 0);
    // Now the pair this install started is running, and the probe sees it.
    // systemctl and ps are per-run, so the second run can be told the truth.
    const running = fakeSystemctl(box.root, { active: 'active', enabled: 'enabled' });
    const runningPs = fakePs(box.root, [
      `999 ${join(box.home, '.local', 'share', 'agent-bot', 'bundle', 'node', 'bin', 'node')} ${join(box.home, '.local', 'share', 'agent-bot', 'bundle', 'lib', 'agent-bot', 'agent-bot.mjs')} daemon run`,
    ]);
    const again = spawnSync('sh', [INSTALL], {
      cwd: box.archive,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: box.home,
        SHELL: '/bin/bash',
        TMPDIR: join(box.home, 'tmp'),
        AGENT_BOT_SYSTEMCTL: running.path,
        AGENT_BOT_PS: runningPs,
      },
    });
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /another install already runs/u);
    assert.doesNotMatch(again.stdout, /migrating from the other install/u);
  } finally {
    box.cleanup();
  }
});

// -------------------------------------------------------------- uninstall

test('#337: uninstall removes what install wrote, keeps what it did not, and never deletes souls', () => {
  const box = machine('uninstall');
  try {
    const soulRoot = join(box.home, '.agent-bot', 'souls', 'Billy - Principal SW Engineer.soul');
    mkdirSync(soulRoot, { recursive: true });
    writeFileSync(join(soulRoot, 'soul.json'), '{"schema_version":1}\n');
    const space = join(box.home, '.agent-space', 'agent-1');
    mkdirSync(space, { recursive: true });
    writeFileSync(join(space, 'state.json'), '{}\n');
    // A file of the user's that lives beside the wrappers must survive.
    mkdirSync(join(box.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(box.home, '.local', 'bin', 'something-else'), '#!/bin/sh\n');

    writeFileSync(join(box.home, '.profile'), 'export EXISTING=1\n');
    assert.equal(box.install().status, 0);

    const result = box.uninstall();
    assert.equal(result.status, 0, result.stderr);

    // Removed: install tree, marked wrappers, the units this install wrote, and
    // exactly the marked PATH block.
    assert.equal(box.exists('.local/share/agent-bot'), false);
    for (const name of ['agent-bot', 'agent-comms', 'node']) {
      assert.equal(box.exists(`.local/bin/${name}`), false, `${name} wrapper survived uninstall`);
    }
    assert.equal(box.exists('.config/systemd/user/agent-bot-daemon.service'), false);
    assert.equal(box.exists('.config/systemd/user/agent-comms-broker.service'), false);
    assert.equal(box.read('.profile'), 'export EXISTING=1\n');
    assert.ok(systemctlCalls(box.log).includes('systemctl --user disable --now agent-bot-daemon.service'));

    // Kept: souls, the Agent Space, and anything of the user's.
    assert.equal(readFileSync(join(soulRoot, 'soul.json'), 'utf8'), '{"schema_version":1}\n');
    assert.equal(readFileSync(join(space, 'state.json'), 'utf8'), '{}\n');
    assert.ok(existsSync(join(box.home, '.local', 'bin', 'something-else')));
  } finally {
    box.cleanup();
  }
});

test('#337: a directory with no install manifest is reported, not guessed at', () => {
  const box = machine('uninstall-no-manifest');
  try {
    const other = '[Unit]\nDescription=someone else\n';
    mkdirSync(join(box.home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(box.home, '.config', 'systemd', 'user', 'agent-bot-daemon.service'), other);

    // Nothing ever recorded an install here, so every path below belongs to some
    // other install and none of them is ours to remove.
    const result = box.uninstall();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no agent-bot Linux bundle install is recorded/u);
    assert.equal(box.read('.config/systemd/user/agent-bot-daemon.service'), other);
    assert.ok(!systemctlCalls(box.log).some((call) => call.includes('disable')));
  } finally {
    box.cleanup();
  }
});

test('#337: uninstall reads the manifest, so a wrong --prefix cannot uninstall the wrong install', () => {
  const box = machine('uninstall-manifest');
  try {
    assert.equal(box.install(['--no-services']).status, 0);

    // A prefix that never held this install has no manifest. Uninstall reports
    // it and changes nothing, rather than deleting a directory some other
    // install owns.
    const elsewhere = box.uninstall(['--prefix', join(box.root, 'not-this-one')]);
    assert.equal(elsewhere.status, 0, elsewhere.stderr);
    assert.match(elsewhere.stdout, /no agent-bot Linux bundle install is recorded/u);
    assert.ok(existsSync(join(box.home, '.local', 'share', 'agent-bot', 'bundle', 'bin', 'agent-bot')));

    assert.equal(box.uninstall().status, 0);
    assert.equal(box.exists('.local/share/agent-bot'), false);
    assert.equal(box.exists('.local/bin/agent-bot'), false);
  } finally {
    box.cleanup();
  }
});

test('#337: a resolved install directory that is the home itself is refused', () => {
  const box = machine('uninstall-home-guard');
  try {
    const result = runScript(UNINSTALL, {
      home: box.home,
      cwd: box.archive,
      args: ['--prefix', box.home],
      systemctl: box.systemctl,
      ps: box.ps,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to remove the install tree/u);
  } finally {
    box.cleanup();
  }
});

test('#337: --help documents the flags and never installs anything', () => {
  const box = machine('help');
  try {
    for (const script of [INSTALL, UNINSTALL]) {
      const result = runScript(script, { home: box.home, cwd: box.archive, args: ['--help'] });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /--(?:prefix|bin-dir|replace|migrate|keep-tree)/u);
      assert.match(result.stdout, /never deletes souls|Never deletes souls/u);
    }
    const unknown = box.install(['--nope']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown option: --nope/u);
  } finally {
    box.cleanup();
  }
});

test('#337: the round trip works in every shell a login is likely to use', () => {
  // Two zsh traps hide in this script and only fire there: an unquoted expansion
  // is not word-split, so `for x in $LIST` sees one word and writes a single
  // wrapper; and the lowercase `path` array is PATH, so `path=$dir` repoints the
  // script's own PATH. Both pass under sh and fail under zsh, and both were
  // shipped-looking bugs until this ran the scripts under every shell present.
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/ksh'].filter((shell) => {
    try {
      execFileSync(shell, ['-c', ':']);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(shells.length >= 2, 'expected at least two shells to compare');

  for (const shell of shells) {
    const box = machine(`install-${shell.replaceAll('/', '')}`);
    try {
      writeFileSync(join(box.home, '.profile'), 'export EXISTING=1\n');
      const soul = join(box.home, '.agent-bot', 'souls', 'Test.soul', 'soul.json');
      mkdirSync(dirname(soul), { recursive: true });
      writeFileSync(soul, '{"schema_version":1}\n');

      const installed = spawnSync(shell, [INSTALL], {
        cwd: box.archive,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: box.home,
          SHELL: '/bin/bash',
          TMPDIR: join(box.home, 'tmp'),
          AGENT_BOT_SYSTEMCTL: box.systemctl,
          AGENT_BOT_PS: box.ps,
        },
      });
      assert.equal(installed.status, 0, `${shell} install: ${installed.stderr}`);
      // All three wrappers, not one named after the whole list.
      assert.deepEqual(
        readdirSync(join(box.home, '.local', 'bin')).sort(),
        ['agent-bot', 'agent-comms', 'node'],
        `${shell} wrote the wrong wrappers`,
      );
      assert.equal(countOccurrences(box.read('.profile'), PATH_BEGIN), 1, `${shell} PATH block count`);

      const removed = spawnSync(shell, [UNINSTALL], {
        cwd: box.archive,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: box.home,
          SHELL: '/bin/bash',
          TMPDIR: join(box.home, 'tmp'),
          AGENT_BOT_SYSTEMCTL: box.systemctl,
          AGENT_BOT_PS: box.ps,
        },
      });
      assert.equal(removed.status, 0, `${shell} uninstall: ${removed.stderr}`);
      // Both unit files, not just the first: a one-line service list read back
      // as words leaves the second unit running against a deleted tree.
      assert.deepEqual(
        readdirSync(join(box.home, '.config', 'systemd', 'user')),
        [],
        `${shell} left a unit behind`,
      );
      assert.equal(box.exists('.local/share/agent-bot'), false, `${shell} left the install tree`);
      assert.equal(box.read('.profile'), 'export EXISTING=1\n', `${shell} left the PATH block`);
      assert.ok(existsSync(soul), `${shell} deleted a soul`);
    } finally {
      box.cleanup();
    }
  }
});

// ------------------------------------------------------- repository invariants

test('#337: the smoke test exercises every archive in the directory, not the first', () => {
  // ci-smoke.sh installs into a throwaway box and changes directory between
  // archives, so a dist path it does not resolve absolutely stops matching and
  // the loop skips the rest. The second archive here is deliberately incomplete,
  // so a run that skips it passes when it must fail.
  const root = tempDir('smoke-all');
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  // An archive shaped like the real one — the installers ci-smoke.sh runs beside
  // the runtime tree install.sh checks — with its contents at the archive root,
  // exactly as the build's own tar call writes them.
  const assemble = (name, { withCommsEntry }) => {
    const stage = join(root, name);
    mkdirSync(stage, { recursive: true });
    cpSync(join(BUNDLE, 'install.sh'), join(stage, 'install.sh'));
    cpSync(join(BUNDLE, 'uninstall.sh'), join(stage, 'uninstall.sh'));
    cpSync(join(BUNDLE, 'lib'), join(stage, 'lib'), { recursive: true });
    cpSync(join(BUNDLE, 'systemd'), join(stage, 'systemd'), { recursive: true });
    fakeArchiveSource(stage);
    if (!withCommsEntry) rmSync(join(stage, 'bundle', 'lib', 'agent-comms'), { recursive: true, force: true });
    execFileSync('tar', ['-czf', join(dist, `agent-bot-linux-${name}-v9.9.9.tar.gz`), '-C', stage, '.']);
  };
  // arm64 sorts first and installs cleanly; x64 is missing the pinned
  // agent-comms entry, which is exactly what install.sh refuses.
  assemble('arm64', { withCommsEntry: true });
  assemble('x64', { withCommsEntry: false });

  const result = spawnSync('sh', [join(BUNDLE, 'ci-smoke.sh'), 'dist'], {
    // The relative argument is the bug: it is what `npm run bundle:linux:smoke`
    // passes, and it only resolves while the script is in this directory.
    cwd: root,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: root },
  });
  assert.notEqual(result.status, 0, 'an incomplete archive must fail the smoke test');
  // The first archive passed, so the run reached the second one at all.
  assert.match(result.stdout, /linux-bundle smoke: linux-arm64 ok/u);
  assert.match(result.stderr, /linux-x64: install\.sh failed for the wrong reason/u);
  assert.match(result.stderr, /the archive is incomplete: .*lib\/agent-comms\/bin\/agent-comms\.mjs is missing/u);
  rmSync(root, { recursive: true, force: true });
});

test('#337: the bundle ships POSIX sh, and every entry script is executable', () => {
  for (const script of ['install.sh', 'uninstall.sh', 'lib/common.sh']) {
    const body = readFileSync(join(BUNDLE, script), 'utf8');
    // Bashisms that dash and busybox ash reject.
    assert.doesNotMatch(body, /\[\[|\bfunction\s+\w+\s*\(\)|\blocal\s+\w+=|\becho\s+-e\b|\bsource\s+/u);
    assert.doesNotMatch(body, /\bsudo\b/u, `${script} must never reach for root`);
  }
  // The two scripts a user runs start with the POSIX shebang; the helper is
  // pulled in by them and must never be run on its own.
  for (const script of [INSTALL, UNINSTALL]) {
    assert.match(readFileSync(script, 'utf8'), /^#!\/bin\/sh$/mu);
    assert.ok(execFileSync('test', ['-x', script]), `${script} must be executable`);
  }
  assert.match(readFileSync(join(BUNDLE, 'lib', 'common.sh'), 'utf8'), /^# Shared POSIX helpers/mu);
  // The unit templates are what install.sh renders, so both halves of the pair
  // must exist and neither may hard-code a path.
  const units = readdirSync(join(BUNDLE, 'systemd'));
  assert.deepEqual(units.sort(), ['agent-bot-daemon.service.in', 'agent-comms-broker.service.in']);
  for (const unit of units) {
    const body = readFileSync(join(BUNDLE, 'systemd', unit), 'utf8');
    assert.match(body, /^\[Install\]\nWantedBy=default\.target$/mu);
    assert.doesNotMatch(body, /\/home\/|\/Users\//u);
  }
  // The broker unit names the command agent-comms' own service installer builds
  // (lib/platform/service-startup.mjs, single-account mode), so the two agree on
  // what runs the broker.
  assert.match(
    readFileSync(join(BUNDLE, 'systemd', 'agent-comms-broker.service.in'), 'utf8'),
    /^ExecStart=@AGENT_BOT_NODE@ @AGENT_BOT_COMMS_ENTRY@ broker run --single-account$/mu,
  );
});

test('#337: every systemctl and ps call the installer makes goes through an injectable command', () => {
  const raw = ['install.sh', 'uninstall.sh', 'lib/common.sh']
    .map((name) => readFileSync(join(BUNDLE, name), 'utf8'))
    .join('\n');
  // Comments name the seams in prose, and strings report what the installer
  // found; only executable positions are scanned, so neither can hide a call
  // that reaches the machine the suite runs on.
  const executable = raw
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .map((line) => line.replaceAll(/'[^']*'/gu, "''").replaceAll(/"[^"]*"/gu, '""'))
    .join('\n');
  assert.doesNotMatch(executable, /(^|[\s(;])systemctl[\s]/u);
  assert.doesNotMatch(executable, /(^|[\s(;])ps\s+-\w/u);
  assert.match(raw, /AGENT_BOT_SYSTEMCTL/u);
  assert.match(raw, /AGENT_BOT_PS/u);
});
