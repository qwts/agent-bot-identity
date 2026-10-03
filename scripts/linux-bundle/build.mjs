#!/usr/bin/env node
// Build one headless-Linux CLI bundle per platform (ADR-0332 decision 1).
//
// The archive holds a pinned Node, agent-bot and agent-comms, install.sh,
// uninstall.sh, the systemd --user unit templates, and the components it was
// built from. Node is verified against the sha256 in components.json before it
// is unpacked, and agent-comms is fetched by the full commit SHA that its
// release tag must resolve to, so a re-publish cannot enter an archive either.
//
// It runs on macOS. Nothing here executes a Linux binary: it downloads the
// Linux Node tarball, unpacks it, copies files, and runs agent-comms' own
// JavaScript CLI on the host Node to check what it dispatches.
//
//   node scripts/linux-bundle/build.mjs --platform linux-x64 --out dist
//   node scripts/linux-bundle/build.mjs --platform all --require-verified
//
// Overrides, for an operator with a vendored artifact or an air-gapped build:
//   AGENT_BOT_NODE_TARBALL=<path|url>    a Node tarball to use instead of the pin
//   AGENT_BOT_BUNDLE_SKIP_COMMS=1        build agent-bot and Node only
//   AGENT_BOT_BUNDLE_OFFLINE=1           never reach the network

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

export const BUNDLE_NAME = 'agent-bot';
export const ENTRY_MARKER = '# agent-bot-linux-bundle-entry';
export const SUPPORTED_PLATFORMS = ['linux-x64', 'linux-arm64'];
// The bundle carries the runtime tree and nothing that belongs to the
// development loop, so it matches what Formula/agent-bot.rb installs into
// libexec. `scripts` goes too: install.sh and uninstall.sh are shipped at the
// archive's top level, and nothing at runtime reads scripts/. `dist` is a build
// output that may already hold an earlier archive: copying it in would nest a
// release archive inside the next one, and a copy of this directory inside
// itself fails outright.
export const EXCLUDED_FROM_BUNDLE = [
  '.git',
  'dist',
  'Formula',
  'docs',
  'governance',
  'node_modules',
  'scripts',
  'tests',
  'tools',
];

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function log(message) {
  process.stdout.write(`linux-bundle: ${message}\n`);
}

function warn(message) {
  process.stderr.write(`linux-bundle: WARNING: ${message}\n`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

export function parseArgs(argv) {
  const options = {
    platform: null,
    out: 'dist',
    requireVerified: false,
    skipComms: false,
    offline: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
    const value = () => {
      if (inlineValue !== null) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    switch (flag) {
      case '--platform': options.platform = value(); break;
      case '--out': options.out = value(); break;
      case '--require-verified': options.requireVerified = true; break;
      case '--skip-comms': options.skipComms = true; break;
      case '--offline': options.offline = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function usage() {
  process.stdout.write(`build.mjs — assemble a headless-Linux CLI bundle

  node scripts/linux-bundle/build.mjs --platform <${SUPPORTED_PLATFORMS.join('|')}|all>
                                         [--out DIR] [--require-verified]
                                         [--skip-comms] [--offline]

Every artifact is verified against scripts/linux-bundle/components.json before it
is unpacked. --require-verified refuses to assemble an archive whose agent-comms
pin does not dispatch the verbs this runtime calls, or that carries no broker at
all; the release workflow passes it.
`);
}

export function readComponents(file = join(HERE, 'components.json')) {
  const components = JSON.parse(readFileSync(file, 'utf8'));
  if (components.schema_version !== 1) {
    throw new Error(`unsupported components schema_version: ${components.schema_version}`);
  }
  if (!components.node?.version || !components.node?.tarballs) {
    throw new Error('components.json pins no Node version');
  }
  for (const platform of SUPPORTED_PLATFORMS) {
    const pin = components.node.tarballs[platform];
    if (!pin?.url || !/^[0-9a-f]{64}$/u.test(pin.sha256 || '')) {
      throw new Error(`components.json pins no sha256 for node ${platform}`);
    }
  }
  // agent-comms is pinned the way GeniusBar pins it: a repository, the release
  // tag, and the full commit that tag must resolve to. A short SHA, a branch or
  // a version range is refused here rather than half-honoured by the fetch.
  const comms = components.agent_comms;
  if (!comms?.repo || !/^v\d+\.\d+\.\d+$/u.test(comms.tag || '') || !/^[0-9a-f]{40}$/u.test(comms.ref || '')) {
    throw new Error('components.json must pin agent-comms by repo, release tag and full commit SHA');
  }
  if (!comms.bin || comms.bin.startsWith('/') || comms.bin.split('/').includes('..')) {
    throw new Error(`components.json pins no agent-comms entry inside the repository: ${comms.bin}`);
  }
  return components;
}

// A local path or file:// URL is what an air-gapped build has; anything else is
// fetched, cached under .guard/ (already gitignored), and checksummed.
async function resolveSource({ source, url, sha256: expected, offline, cacheDir, label }) {
  if (source) {
    const local = source.startsWith('file://') ? fileURLToPath(source) : source;
    if (!existsSync(local)) throw new Error(`${label} override not found: ${local}`);
    const digest = sha256(local);
    if (expected && digest !== expected) {
      throw new Error(`checksum mismatch for ${label} override ${local}: expected ${expected}, got ${digest}`);
    }
    return local;
  }
  const name = url.split('/').pop();
  const cached = join(cacheDir, name);
  if (existsSync(cached) && sha256(cached) === expected) return cached;
  rmSync(cached, { force: true });
  if (offline) throw new Error(`offline, and ${name} is not in ${cacheDir}`);
  log(`downloading ${label} from ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed ${response.status} ${url}`);
  mkdirSync(cacheDir, { recursive: true });
  const temp = `${cached}.part`;
  writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  const digest = sha256(temp);
  if (digest !== expected) {
    rmSync(temp, { force: true });
    throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${digest}`);
  }
  renameSync(temp, cached);
  return cached;
}

function extractNode(archive, platform, bundle) {
  const target = join(bundle, 'node');
  mkdirSync(target, { recursive: true });
  // The tarball holds one node-v<version>-linux-<arch> directory.
  run('tar', ['-xzf', archive, '-C', target, '--strip-components', '1']);
  const nodeBinary = join(target, 'bin', 'node');
  if (!existsSync(nodeBinary)) throw new Error(`the Node tarball has no bin/node for ${platform}`);
  return nodeBinary;
}

// A component's package.json says what it ships: its own `files` entries, plus
// the manifest and the licence. A package that declares no `files` ships
// everything, less the directories no runtime ever reads.
const NEVER_SHIPPED = new Set(['.github', 'docs', 'tests', 'Formula', 'governance']);

export function commsKeepSet(manifest) {
  if (!Array.isArray(manifest?.files)) return null;
  return new Set([
    ...manifest.files.map((entry) => String(entry).replace(/\/$/u, '')),
    'package.json',
    'LICENSE',
    'LICENSE.md',
  ]);
}

// An annotated tag lists its commit as `tag^{}`; a lightweight tag is the commit.
export function tagCommit(lsRemote, tag) {
  const lines = String(lsRemote).split('\n').map((line) => line.split('\t'));
  const peeled = lines.find(([, name]) => name === `refs/tags/${tag}^{}`);
  const plain = lines.find(([, name]) => name === `refs/tags/${tag}`);
  return (peeled ?? plain)?.[0] ?? null;
}

// agent-comms is fetched from git, the way GeniusBar's fetch-components.mjs
// fetches the same component: the tag must resolve to the pinned commit before
// anything is fetched, that commit is fetched shallow, and only what the package
// declares it ships is copied out of the tree. The commit SHA is the integrity
// pin, so there is no checksum to compare and no registry to resolve. v0.3.2 has
// no npm dependencies, so nothing is installed and no install script ever runs.
function fetchCommsTree(pin, { cacheDir, offline }) {
  const cached = join(cacheDir, `agent-comms-${pin.ref}`);
  const stamp = `${cached}.stamp`;
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === pin.ref && existsSync(join(cached, 'package.json'))) {
    return cached;
  }
  if (offline) throw new Error(`offline, and agent-comms ${pin.tag} (${pin.ref}) is not in ${cacheDir}`);
  const work = mkdtempSync(join(tmpdir(), 'agent-bot-linux-comms-'));
  try {
    const git = (...args) => {
      try {
        return run('git', ['-C', work, ...args]);
      } catch (error) {
        throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr || error.message).trim()}`);
      }
    };
    const url = `https://github.com/${pin.repo}.git`;
    git('init', '-q');
    const listed = tagCommit(git('ls-remote', url, `refs/tags/${pin.tag}*`), pin.tag);
    if (listed !== pin.ref) {
      throw new Error(`${pin.repo} ${pin.tag} resolves to ${listed ?? 'nothing'}, expected ${pin.ref}`);
    }
    git('fetch', '-q', '--depth', '1', url, pin.ref);
    const tree = join(work, 'tree');
    mkdirSync(tree);
    const tarball = join(work, 'tree.tar');
    git('archive', '--format', 'tar', '-o', tarball, 'FETCH_HEAD');
    run('tar', ['-xf', tarball, '-C', tree]);
    const keep = commsKeepSet(JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')));
    const staged = join(work, 'component');
    mkdirSync(staged);
    for (const entry of readdirSync(tree)) {
      if (keep ? !keep.has(entry) : NEVER_SHIPPED.has(entry)) continue;
      cpSync(join(tree, entry), join(staged, entry), { recursive: true });
    }
    mkdirSync(cacheDir, { recursive: true });
    rmSync(cached, { recursive: true, force: true });
    cpSync(staged, cached, { recursive: true });
    writeFileSync(stamp, pin.ref);
    return cached;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function stageComms(components, { bundle, cacheDir, skipComms, offline }) {
  const commsRoot = join(bundle, 'lib', 'agent-comms');
  mkdirSync(commsRoot, { recursive: true });
  if (skipComms) {
    log('skipping agent-comms (--skip-comms): the archive carries no broker');
    return { pinned: null, verified: false, reason: 'skipped', provided: [], missing: components.agent_comms.required_verbs };
  }
  const pin = {
    repo: components.agent_comms.repo,
    tag: components.agent_comms.tag,
    ref: components.agent_comms.ref,
    bin: components.agent_comms.bin,
  };
  log(`fetching agent-comms ${pin.repo} ${pin.tag} (${pin.ref.slice(0, 12)})`);
  cpSync(fetchCommsTree(pin, { cacheDir, offline }), commsRoot, { recursive: true });
  // The pin and the package must agree on where the entry is, or the archive
  // would ship a launcher pointing at nothing.
  const manifest = JSON.parse(readFileSync(join(commsRoot, 'package.json'), 'utf8'));
  const declared = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {});
  if (!declared.includes(pin.bin) || !existsSync(join(commsRoot, pin.bin))) {
    throw new Error(`the pinned agent-comms ${pin.tag} has no ${pin.bin} executable`);
  }
  const entry = join(commsRoot, pin.bin);
  chmodSync(entry, 0o755);
  return {
    pinned: { repo: pin.repo, tag: pin.tag, ref: pin.ref },
    entry,
    verified: false,
    reason: null,
    provided: [],
    missing: components.agent_comms.required_verbs,
  };
}

// The runtime reaches agent-comms for exactly these verbs: `join`
// (agent-daemon.mjs:111), `inbox read` / `send` / `inbox ack`
// (comms-relay.mjs:36-38) and the broker it pairs with. A pin that dispatches
// none of them is a different product under the same name, and the archive must
// not claim a verified pair.
//
// The check runs the fetched CLI and reads what it says it can do, rather than
// grepping its source for a string. It runs on the build host's Node, never the
// bundled Linux binary: agent-comms is plain JavaScript, so what its help
// dispatches does not depend on the runtime that would execute it.
export function verifyCommsSurface({ entry, requiredVerbs, node = process.execPath }) {
  let help = '';
  let error = null;
  try {
    help = execFileSync(node, [entry, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (failure) {
    // A CLI that cannot print its help dispatches nothing, which is a failed
    // check rather than a crash.
    error = String(failure.stderr || failure.message).trim();
  }
  const provided = requiredVerbs.filter((verb) => new RegExp(String.raw`^[^\S\n]*agent-comms ${verb}(?![-\w])`, 'mu').test(help));
  return {
    provided: [...provided].sort(),
    missing: requiredVerbs.filter((verb) => !provided.includes(verb)),
    help_failed: error,
  };
}

function commsFailureMessage(comms) {
  if (!comms.entry) return 'agent-comms was skipped (--skip-comms), so the archive carries no broker';
  return `the pinned agent-comms ${comms.pinned.tag} (${comms.pinned.ref.slice(0, 12)}) does not dispatch: ${comms.missing.join(', ')}`;
}

function selfLocatingBody({ execLine, comment }) {
  return `#!/bin/sh
${ENTRY_MARKER}
# Written by scripts/linux-bundle/build.mjs. ${comment}
#
# It resolves its own directory so the install directory can be anything, and it
# pins the bundled Node so the pair can never straddle two runtimes or a stale
# PATH.
set -eu
self=$0
while [ -L "$self" ]; do
  self_dir=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd)
  self_target=$(readlink "$self")
  case "$self_target" in
    /*) self=$self_target ;;
    *) self=$self_dir/$self_target ;;
  esac
done
AGENT_BOT_BUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd)
export AGENT_BOT_BUNDLE_ROOT
PATH="$AGENT_BOT_BUNDLE_ROOT/bin:$PATH"
export PATH
AGENT_BOT_NODE="$AGENT_BOT_BUNDLE_ROOT/node/bin/node"
export AGENT_BOT_NODE
${execLine}
`;
}

function nodeLauncher(comment) {
  return selfLocatingBody({
    comment,
    execLine: 'exec "$AGENT_BOT_BUNDLE_ROOT/node/bin/node" "$@"',
  });
}

function scriptLauncher(relativeScript, comment) {
  return selfLocatingBody({
    comment,
    execLine: `exec "$AGENT_BOT_BUNDLE_ROOT/node/bin/node" "$AGENT_BOT_BUNDLE_ROOT/${relativeScript}" "$@"`,
  });
}

function readReleaseCommit() {
  try {
    return readFileSync(join(ROOT, 'RELEASE_COMMIT'), 'utf8').trim();
  } catch {
    return null;
  }
}

export async function buildPlatform(platform, options = {}) {
  const components = options.components ?? readComponents();
  const cacheDir = options.cacheDir ?? join(ROOT, '.guard', 'linux-bundle-cache');
  const outDir = resolve(ROOT, options.out ?? 'dist');
  const stage = join(outDir, `.stage-${platform}`);
  const bundle = join(stage, 'bundle');

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(bundle, 'bin'), { recursive: true });
  const report = { platform, node: null, agentComms: null, agentBot: null, archive: null, sha256: null, bytes: null };

  // ---- Node
  const nodePin = components.node.tarballs[platform];
  const nodeArchive = await resolveSource({
    source: process.env.AGENT_BOT_NODE_TARBALL,
    url: nodePin.url,
    sha256: nodePin.sha256,
    offline: options.offline,
    cacheDir,
    label: `node ${components.node.version}`,
  });
  const nodeBinary = extractNode(nodeArchive, platform, bundle);
  report.node = { version: components.node.version, sha256: nodePin.sha256 };

  // ---- agent-comms
  const comms = stageComms(components, {
    bundle,
    cacheDir,
    skipComms: options.skipComms,
    offline: options.offline,
  });
  const binDir = join(bundle, 'bin');
  writeFileSync(join(binDir, 'node'), nodeLauncher('Bundled Node.js, the one runtime both halves of the pair use.'));
  if (comms.entry) {
    const surface = verifyCommsSurface({ entry: comms.entry, requiredVerbs: components.agent_comms.required_verbs });
    Object.assign(comms, surface, { verified: surface.missing.length === 0 });
    if (!comms.verified) warn(commsFailureMessage(comms));
    const relativeEntry = relative(join(bundle, 'lib', 'agent-comms'), comms.entry);
    writeFileSync(join(binDir, 'agent-comms'), scriptLauncher(`lib/agent-comms/${relativeEntry}`, 'Bundled agent-comms broker and client.'));
  }
  // A release must ship a pair that works, so a pin that dispatches none of the
  // verbs, and an archive assembled without a broker at all, are both refused.
  if (!comms.verified && options.requireVerified) throw new Error(commsFailureMessage(comms));
  report.agentComms = comms;

  // ---- agent-bot, from this checkout, the way the formula installs it
  const agentBot = join(bundle, 'lib', 'agent-bot');
  mkdirSync(agentBot, { recursive: true });
  for (const name of readdirSync(ROOT)) {
    if (EXCLUDED_FROM_BUNDLE.includes(name) || name.startsWith('.')) continue;
    cpSync(join(ROOT, name), join(agentBot, name), { recursive: true, dereference: false });
  }
  writeFileSync(join(binDir, 'agent-bot'), selfLocatingBody({
    comment: 'Bundled agent-bot. Its own launcher resolves Node from AGENT_BOT_NODE.',
    execLine: 'exec "$AGENT_BOT_BUNDLE_ROOT/lib/agent-bot/agent-bot" "$@"',
  }));
  report.agentBot = { version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, releaseCommit: readReleaseCommit() };

  // ---- install.sh, uninstall.sh, units, provenance
  cpSync(join(HERE, 'install.sh'), join(stage, 'install.sh'));
  cpSync(join(HERE, 'uninstall.sh'), join(stage, 'uninstall.sh'));
  cpSync(join(HERE, 'lib'), join(stage, 'lib'), { recursive: true });
  mkdirSync(join(stage, 'systemd'), { recursive: true });
  for (const name of readdirSync(join(HERE, 'systemd'))) {
    cpSync(join(HERE, 'systemd', name), join(stage, 'systemd', name));
  }
  writeFileSync(join(stage, 'components.json'), `${JSON.stringify(components, null, 2)}\n`);
  writeFileSync(join(stage, 'bundle-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  cpSync(join(HERE, 'README.md'), join(stage, 'README.md'));

  chmodSync(join(stage, 'install.sh'), 0o755);
  chmodSync(join(stage, 'uninstall.sh'), 0o755);
  chmodSync(nodeBinary, 0o755);
  for (const name of readdirSync(binDir)) chmodSync(join(binDir, name), 0o755);
  chmodSync(join(bundle, 'lib', 'agent-bot', 'agent-bot'), 0o755);

  // ---- archive
  const version = report.agentBot.version;
  const archiveName = `${BUNDLE_NAME}-${platform}-v${version}.tar.gz`;
  mkdirSync(outDir, { recursive: true });
  const archive = join(outDir, archiveName);
  rmSync(archive, { force: true });
  run('tar', ['--numeric-owner', '--owner=0', '--group=0', '-czf', archive, '-C', stage, '.']);
  rmSync(stage, { recursive: true, force: true });

  report.archive = archiveName;
  report.sha256 = sha256(archive);
  report.bytes = statSync(archive).size;
  writeFileSync(join(outDir, `${archiveName}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
  log(`${platform}: ${archiveName} (${report.bytes} bytes)`);
  log(`${platform}: sha256 ${report.sha256}`);
  return report;
}

// SHA256SUMS covers every archive in the directory, so a downloader can verify
// the pair together and never pair a linux-x64 archive with an arm64 checksum.
export function writeChecksums(outDir, reports) {
  const lines = [...reports]
    .sort((left, right) => left.archive.localeCompare(right.archive))
    .map((report) => `${report.sha256}  ${report.archive}`);
  const file = join(resolve(ROOT, outDir), 'SHA256SUMS');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return [];
  }
  if (!options.platform) throw new Error('--platform is required');
  const platforms = options.platform === 'all' ? SUPPORTED_PLATFORMS : [options.platform];
  for (const platform of platforms) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(`unsupported platform: ${platform} (expected one of ${SUPPORTED_PLATFORMS.join(', ')}, or all)`);
    }
  }
  const components = readComponents();
  const reports = [];
  for (const platform of platforms) {
    reports.push(await buildPlatform(platform, { ...options, components }));
  }
  const checksums = writeChecksums(options.out, reports);
  log(`wrote SHA256SUMS for ${reports.length} archive(s) in ${checksums}`);
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`linux-bundle: ${error.message}\n`);
    process.exit(1);
  });
}
