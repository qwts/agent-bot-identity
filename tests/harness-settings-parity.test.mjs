// permissionMode parity between a directly opened harness and a daemon-run
// turn (#379). A soul's declared mode is rendered into its home, which a
// direct open reads; the daemon resolves the same declaration through the
// settings precedence (docs/soul-builder.md): the owner's pick, then the
// repo, then the soul package. A tightening applies as declared; a loosening
// nobody picked keeps the stricter mode with LOOSENING_NEEDS_OWNER.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACP_SPAWN_REGISTRY } from '../acp-registry.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { daemonModeFor } from '../agent-daemon.mjs';
import { populationFile, upsertSoul } from '../agent-population.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { LOOSENING_NEEDS_OWNER, packagePermissionMode, repoPermissionMode, resolveSoulMode, setSoulMode } from '../soul-mode.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { acpExecutorFor } from '../wake-plane.mjs';

const ID = 'agent_37937937-9379-4379-8379-379379379379';
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
// The scripted fixture agent stands in for each adapter; the Codex row keeps
// the shipped row's session mode and env, which is what the daemon sends.
const REGISTRY = {
  claude: { harness: 'claude', enabled: true, command: process.execPath, args: [FIXTURE], stripEnv: [], mcpToolNaming: 'claude-meta' },
  codex: { harness: 'codex', enabled: true, command: process.execPath, args: [FIXTURE], stripEnv: [], mcpToolNaming: 'claude-meta',
    sessionMode: ACP_SPAWN_REGISTRY.codex.sessionMode, setEnv: ACP_SPAWN_REGISTRY.codex.setEnv },
};

function fixture(t, permissionMode) {
  const root = mkdtempSync(path.join(tmpdir(), 'settings-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), AGENT_BOT_SOULS_HOME: path.join(root, 'souls'),
    AGENT_BOT_CONFIG: path.join(root, 'config.json') };
  // A soul package declaring the mode, built in place the way `soul build` does.
  const soulDir = path.join(env.AGENT_BOT_SOULS_HOME, 'parity.soul');
  mkdirSync(soulDir, { recursive: true });
  const manifest = { formatVersion: 2, name: 'Parity', description: 'Settings parity', displaySeed: 'parity', preferredHarnesses: [],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, harness: { permissionMode } };
  writeFileSync(path.join(soulDir, 'AGENTS.md'), '# Parity\n');
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(soulDir);
  writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify(manifest));
  buildSoulDirectory(soulDir);
  upsertSoul({ id: ID, name: 'parity', status: 'active', spacePath: path.join(root, 'space'), lastSeen: '2026-10-09T00:00:00.000Z' },
    { file: populationFile({ env, home: root }) });
  return { root, env, home: root, soulDir };
}

// What a direct open reads: the mode rendered into the soul's native files.
function directMode(soulDir, harness) {
  if (harness === 'claude') {
    return { default: 'safe', bypassPermissions: 'autopilot' }[JSON.parse(readFileSync(path.join(soulDir, '.claude/settings.json'), 'utf8')).permissions.defaultMode];
  }
  const policy = readFileSync(path.join(soulDir, '.codex/config.toml'), 'utf8').match(/^approval_policy = "(.*)"$/m)[1];
  return { 'on-request': 'safe', never: 'autopilot' }[policy];
}

// One daemon turn through acpExecutorFor with the daemon's own modeFor.
async function daemonTurn({ harness, cwd, env, home }) {
  const seen = { mode: null, approvals: [], chunks: [], log: [] };
  const executor = acpExecutorFor({
    identities: () => ({}), baseEnv: { ...process.env, HOME: home }, policy: { version: 1, rules: [], fallback: 'approval' },
    modeFor: daemonModeFor({ env, home, config: {}, log: (line) => seen.log.push(line) }),
    createExecutor: (options) => { seen.mode = options.mode; return createAcpExecutor({ ...options, registry: REGISTRY }); },
  })({ agentId: ID, harness, cwd, env: {} });
  await executor({ invocation: { agentId: ID }, message: 'need-permission', attachments: [],
    appendEvent: (_type, data) => { if (data?.content?.text) seen.chunks.push(data.content.text); return {}; },
    addArtifact: () => ({}), signal: new AbortController().signal,
    requestApproval: async (proposal) => { seen.approvals.push(proposal.tool); return { decision: 'deny' }; } });
  return seen;
}

for (const harness of ['claude', 'codex']) {
  test(`${harness}: a declared safe mode applies the same way directly and under the daemon`, async (t) => {
    const { env, home, soulDir } = fixture(t, 'safe');
    assert.equal(directMode(soulDir, harness), 'safe');
    assert.equal(packagePermissionMode(soulDir, harness), 'safe');
    const seen = await daemonTurn({ harness, cwd: soulDir, env, home });
    assert.equal(seen.mode, 'safe');
    assert.deepEqual(seen.approvals, ['Bash']);
    assert.deepEqual(seen.log, []);
  });

  test(`${harness}: a declared autopilot is the same declaration on both paths, and the daemon asks before loosening`, async (t) => {
    const { env, home, soulDir } = fixture(t, 'autopilot');
    assert.equal(directMode(soulDir, harness), 'autopilot');
    assert.deepEqual(resolveSoulMode(ID, { harness, cwd: soulDir, soulDir, env, home }),
      { mode: 'safe', source: 'soul', declared: 'autopilot', code: LOOSENING_NEEDS_OWNER });
    // No owner pick: the turn keeps safe and every tool call goes to the owner.
    let seen = await daemonTurn({ harness, cwd: soulDir, env, home });
    assert.equal(seen.mode, 'safe');
    assert.deepEqual(seen.approvals, ['Bash']);
    assert.equal(seen.log.length, 1);
    assert.match(seen.log[0], new RegExp(`${LOOSENING_NEEDS_OWNER}: ${ID}: the soul declares autopilot; running safe`));
    // The owner's pick (`soul mode`, GeniusBar's picker) is the decision.
    setSoulMode(ID, 'autopilot', { env, home });
    seen = await daemonTurn({ harness, cwd: soulDir, env, home });
    assert.equal(seen.mode, 'autopilot');
    assert.deepEqual(seen.approvals, []);
    assert.match(seen.chunks.at(-1), /opt-allow/);
    assert.deepEqual(seen.log, []);
  });

  test(`${harness}: the owner's pick of safe wins over a package's autopilot without a prompt`, async (t) => {
    const { env, home, soulDir } = fixture(t, 'autopilot');
    setSoulMode(ID, 'safe', { env, home });
    const seen = await daemonTurn({ harness, cwd: soulDir, env, home });
    assert.equal(seen.mode, 'safe');
    assert.deepEqual(seen.log, []);
  });

  test(`${harness}: a repo's own harness file outranks the soul package`, async (t) => {
    const { root, env, home, soulDir } = fixture(t, 'autopilot');
    const repo = path.join(root, 'repo');
    // The repo tightens: applied as declared, no code.
    if (harness === 'claude') {
      mkdirSync(path.join(repo, '.claude'), { recursive: true });
      writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
    } else {
      mkdirSync(path.join(repo, '.codex'), { recursive: true });
      writeFileSync(path.join(repo, '.codex/config.toml'), 'approval_policy = "on-request"\n[profiles.x]\napproval_policy = "never"\n');
    }
    assert.equal(repoPermissionMode(repo, harness), 'safe');
    assert.deepEqual(resolveSoulMode(ID, { harness, cwd: repo, soulDir, env, home }), { mode: 'safe', source: 'repo', declared: 'safe', code: null });
    // The repo loosens over a safe package: refused with the code.
    writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(soulDir, 'soul.json'), 'utf8')), harness: { permissionMode: 'safe' } }));
    if (harness === 'claude') writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    else writeFileSync(path.join(repo, '.codex/config.toml'), 'approval_policy = "never" # repo\n');
    assert.equal(repoPermissionMode(repo, harness), 'autopilot');
    const seen = await daemonTurn({ harness, cwd: repo, env, home });
    assert.equal(seen.mode, 'safe');
    assert.match(seen.log[0], /the repo declares autopilot; running safe/);
  });
}

test('unrecognised or unreadable layers declare nothing; a soul with no census row has no package layer', (t) => {
  const { root, env, home } = fixture(t, 'safe');
  const repo = path.join(root, 'odd');
  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(path.join(repo, '.claude/settings.json'), '{ not json');
  assert.equal(repoPermissionMode(repo, 'claude'), null);
  writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
  assert.equal(repoPermissionMode(repo, 'claude'), null);
  // A symlinked or oversized file is not read.
  writeFileSync(path.join(root, 'bypass.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  rmSync(path.join(repo, '.claude/settings.json'));
  symlinkSync(path.join(root, 'bypass.json'), path.join(repo, '.claude/settings.json'));
  assert.equal(repoPermissionMode(repo, 'claude'), null);
  mkdirSync(path.join(repo, '.codex'));
  writeFileSync(path.join(repo, '.codex/config.toml'), `approval_policy = "on-request"\n#${'x'.repeat(70 * 1024)}\n`);
  assert.equal(repoPermissionMode(repo, 'codex'), null);
  assert.equal(repoPermissionMode(repo, 'gemini'), null);
  assert.equal(packagePermissionMode(repo, 'claude'), null);
  const other = 'agent_77777777-7777-4777-8777-777777777777';
  assert.deepEqual(resolveSoulMode(other, { harness: 'claude', cwd: repo, env, home }), { mode: 'safe', source: 'default', declared: 'safe', code: null });
  assert.equal(daemonModeFor({ env, home, config: {}, log: () => assert.fail('no code') })(other, { harness: 'claude', cwd: repo }), 'safe');
});
