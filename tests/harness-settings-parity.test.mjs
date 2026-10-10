// permissionMode and model parity between a directly opened harness and a daemon-run
// turn (#379). A soul's declared mode is rendered into its home, which a
// direct open reads; the daemon resolves the same declaration through the
// settings precedence (docs/soul-builder.md): the owner's pick, then the
// repo, then the soul package. A tightening applies as declared; a loosening
// nobody picked asks the owner once per declaring file, and keeps the stricter
// mode with LOOSENING_NEEDS_OWNER when nobody can be asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACP_SPAWN_REGISTRY } from '../acp-registry.mjs';
import { createAcpExecutor } from '../acp-engine.mjs';
import { daemonModeFor, daemonModelFor, daemonReasoningEffortFor, LOOSENING_TOOL } from '../agent-daemon.mjs';
import { listProposals } from '../agent-jobs.mjs';
import { auditFile } from '../agent-principals.mjs';
import { populationFile, upsertSoul } from '../agent-population.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { packageModel, packageReasoningEffort, repoModel, repoReasoningEffort, resolveSoulModel, resolveSoulReasoningEffort, setSoulModel } from '../soul-model.mjs';
import { LOOSENING_NEEDS_OWNER, packagePermissionMode, repoPermissionMode, resolveSoulMode, setSoulMode } from '../soul-mode.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { acpExecutorFor } from '../wake-plane.mjs';
import { parseSshPublicKey, sshFingerprint, writeOwnerKeys } from '../owner-statement.mjs';

const ID = 'agent_37937937-9379-4379-8379-379379379379';
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const HAS_SSH_KEYGEN = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;
// The scripted fixture agent stands in for each adapter; the Codex row keeps
// the shipped row's session mode and env, which is what the daemon sends.
const REGISTRY = {
  claude: { harness: 'claude', enabled: true, command: process.execPath, args: [FIXTURE], stripEnv: [], mcpToolNaming: 'claude-meta' },
  codex: { harness: 'codex', enabled: true, command: process.execPath, args: [FIXTURE], stripEnv: [], mcpToolNaming: 'claude-meta',
    sessionMode: ACP_SPAWN_REGISTRY.codex.sessionMode, setEnv: ACP_SPAWN_REGISTRY.codex.setEnv },
};

function fixture(t, permissionMode, settings = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'settings-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), AGENT_BOT_SOULS_HOME: path.join(root, 'souls'),
    AGENT_BOT_CONFIG: path.join(root, 'config.json') };
  // A soul package declaring the mode, built in place the way `soul build` does.
  const soulDir = path.join(env.AGENT_BOT_SOULS_HOME, 'parity.soul');
  mkdirSync(soulDir, { recursive: true });
  const manifest = { formatVersion: 2, name: 'Parity', description: 'Settings parity', displaySeed: 'parity', preferredHarnesses: [],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, harness: { permissionMode, ...settings } };
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

// Nobody at this Mac: keyd cannot ask and the administrator dialog fails.
const headless = async () => { throw Object.assign(new Error('no GUI session'), { code: 'presence-unavailable' }); };

// One daemon turn through acpExecutorFor with the daemon's own modeFor. The
// owner's answer to a loosening comes from `ask`, never a real prompt.
async function daemonTurn({ harness, cwd, env, home, ask = headless, modeFor = null }) {
  const seen = { mode: null, approvals: [], chunks: [], log: [] };
  const executor = acpExecutorFor({
    identities: () => ({}), baseEnv: { ...process.env, HOME: home }, policy: { version: 1, rules: [], fallback: 'approval' },
    modeFor: modeFor ?? daemonModeFor({ env, home, config: {}, ask, log: (line) => seen.log.push(line) }),
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
    const manifest = path.join(soulDir, 'soul.json');
    assert.deepEqual(resolveSoulMode(ID, { harness, cwd: soulDir, soulDir, env, home }),
      { mode: 'safe', source: 'soul', declared: 'autopilot', code: LOOSENING_NEEDS_OWNER, file: manifest, digest: sha256(readFileSync(manifest, 'utf8')) });
    // No owner pick and nobody to ask: the turn keeps safe and every tool call goes to the owner.
    let seen = await daemonTurn({ harness, cwd: soulDir, env, home });
    assert.equal(seen.mode, 'safe');
    assert.deepEqual(seen.approvals, ['Bash']);
    assert.equal(seen.log.length, 1);
    assert.match(seen.log[0], new RegExp(`${LOOSENING_NEEDS_OWNER}: ${ID}: the soul declares autopilot; running safe, the owner could not be asked \\(no GUI session\\)`));
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

// What a direct open reads: the model rendered into the soul's native files.
function directModel(soulDir, harness) {
  if (harness === 'claude') return JSON.parse(readFileSync(path.join(soulDir, '.claude/settings.json'), 'utf8')).model;
  return readFileSync(path.join(soulDir, '.codex/config.toml'), 'utf8').match(/^model = "(.*)"$/m)[1];
}

// One daemon turn with the daemon's own modelFor: the model it sends, and the
// model the fixture agent then reports running (null when nothing was sent).
async function modelTurn({ harness, cwd, env, home, prior = null, acpEnv = {}, capture = false }) {
  let sent;
  const logs = [];
  const chunks = [];
  const executor = acpExecutorFor({
    identities: () => ({}), baseEnv: { ...process.env, HOME: home, ...acpEnv }, policy: { version: 1, rules: [], fallback: 'approval' },
    modeFor: () => 'safe', modelFor: daemonModelFor({ env, home, config: {} }),
    reasoningEffortFor: daemonReasoningEffortFor({ env, home, config: {} }),
    log: (line) => logs.push(line),
    createExecutor: (options) => {
      sent = options.model;
      const registry = { ...REGISTRY, [harness]: { ...REGISTRY[harness], setEnv: { ...REGISTRY[harness].setEnv, ...acpEnv } } };
      return createAcpExecutor({ ...options, getHarnessSession: prior ? async () => ({ harnessSessionId: prior }) : options.getHarnessSession, registry });
    },
  })({ agentId: ID, harness, cwd, env: {} });
  await executor({ invocation: { agentId: ID }, message: 'model-probe', attachments: [],
    appendEvent: (_type, data) => { if (data?.content?.text) chunks.push(data.content.text); return {}; },
    addArtifact: () => ({}), signal: new AbortController().signal, requestApproval: async () => ({ decision: 'deny' }) });
  const observed = JSON.parse(chunks.at(-1));
  return { sent, running: observed.model, ...(capture ? { observed, logs } : {}) };
}

for (const harness of ['claude', 'codex']) {
  test(`${harness}: the model follows the settings order on both paths`, async (t) => {
    const { root, env, home, soulDir } = fixture(t, 'safe', { model: 'soul-model' });
    // In the soul's home a direct open reads the rendering; the daemon sends the same model.
    assert.equal(directModel(soulDir, harness), 'soul-model');
    assert.equal(packageModel(soulDir, harness), 'soul-model');
    assert.deepEqual(resolveSoulModel(ID, { harness, cwd: soulDir, soulDir, env, home }), { model: 'soul-model', source: 'soul' });
    assert.deepEqual(await modelTurn({ harness, cwd: soulDir, env, home }), { sent: 'soul-model', running: 'soul-model' });
    // In a repo that names no model, the package's model still applies.
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    assert.deepEqual(await modelTurn({ harness, cwd: repo, env, home }), { sent: 'soul-model', running: 'soul-model' });
    // A repo that names one outranks the package, and is sent so a resumed session follows it too.
    if (harness === 'claude') {
      mkdirSync(path.join(repo, '.claude'));
      writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ model: 'repo-model' }));
    } else {
      mkdirSync(path.join(repo, '.codex'));
      writeFileSync(path.join(repo, '.codex/config.toml'), 'model = "repo-model"\n');
    }
    assert.equal(repoModel(repo, harness), 'repo-model');
    assert.deepEqual(resolveSoulModel(ID, { harness, cwd: repo, soulDir, env, home }), { model: 'repo-model', source: 'repo' });
    assert.deepEqual(await modelTurn({ harness, cwd: repo, env, home }), { sent: 'repo-model', running: 'repo-model' });
    // The owner's pick (`soul model`, GeniusBar's picker) wins over the repo.
    setSoulModel(ID, 'owner-model', { env, home });
    assert.deepEqual(await modelTurn({ harness, cwd: repo, env, home }), { sent: 'owner-model', running: 'owner-model' });
    // Clearing the pick goes back to the repo's model, and nothing is sent where no layer names one.
    setSoulModel(ID, null, { env, home });
    assert.deepEqual(await modelTurn({ harness, cwd: repo, env, home }), { sent: 'repo-model', running: 'repo-model' });
    writeFileSync(path.join(soulDir, 'soul.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(soulDir, 'soul.json'), 'utf8')), harness: { permissionMode: 'safe' } }));
    assert.deepEqual(await modelTurn({ harness, cwd: path.join(root, 'state'), env, home }), { sent: null, running: null });
  });
}

test('a package model is any nonempty string the package contract accepts', (t) => {
  const long = `provider/${'m'.repeat(200)}`;
  const { soulDir } = fixture(t, 'safe', { model: long });
  assert.equal(packageModel(soulDir, 'claude'), long);
  assert.equal(directModel(soulDir, 'claude'), long);
});

test('a repo model is read only from the files and keys the harness uses for it', (t) => {
  const { root, env, home } = fixture(t, 'safe');
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ model: 'shared' }));
  writeFileSync(path.join(repo, '.claude/settings.local.json'), JSON.stringify({ model: 'local' }));
  assert.equal(repoModel(repo, 'claude'), 'local');
  writeFileSync(path.join(repo, '.claude/settings.local.json'), '{ not json');
  assert.equal(repoModel(repo, 'claude'), 'shared');
  // A symlinked file is not read.
  writeFileSync(path.join(root, 'linked.json'), JSON.stringify({ model: 'linked' }));
  rmSync(path.join(repo, '.claude/settings.json'));
  rmSync(path.join(repo, '.claude/settings.local.json'));
  symlinkSync(path.join(root, 'linked.json'), path.join(repo, '.claude/settings.json'));
  assert.equal(repoModel(repo, 'claude'), null);
  // Nor is a FIFO, which would otherwise block the read.
  rmSync(path.join(repo, '.claude/settings.json'));
  assert.equal(spawnSync('mkfifo', [path.join(repo, '.claude/settings.json')]).status, 0);
  assert.equal(repoModel(repo, 'claude'), null);
  // Codex: root keys only, so a profile's model is not the repo's; quoted
  // keys and literal strings count, as TOML reads them.
  mkdirSync(path.join(repo, '.codex'));
  writeFileSync(path.join(repo, '.codex/config.toml'), '[profiles.x]\nmodel = "profile"\n');
  assert.equal(repoModel(repo, 'codex'), null);
  writeFileSync(path.join(repo, '.codex/config.toml'), "approval_policy = 'never'\n'model' = 'literal' # repo\n[profiles.x]\nmodel = \"profile\"\n");
  assert.equal(repoModel(repo, 'codex'), 'literal');
  writeFileSync(path.join(repo, '.codex/config.toml'), '"model" = "quoted \\"one\\""\n');
  assert.equal(repoModel(repo, 'codex'), 'quoted "one"');
  // Gemini and OpenCode read their own project files.
  assert.equal(repoModel(repo, 'gemini'), null);
  mkdirSync(path.join(repo, '.gemini'));
  writeFileSync(path.join(repo, '.gemini/settings.json'), JSON.stringify({ model: 'gemini-repo' }));
  assert.equal(repoModel(repo, 'gemini'), 'gemini-repo');
  writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ model: 'provider/opencode-repo' }));
  assert.equal(repoModel(repo, 'opencode'), 'provider/opencode-repo');
  assert.equal(repoModel(repo, 'devin'), null);
  // No census row: no package layer, so nothing is sent.
  const other = 'agent_77777777-7777-4777-8777-777777777777';
  const bare = path.join(root, 'bare');
  mkdirSync(bare);
  assert.deepEqual(resolveSoulModel(other, { harness: 'codex', cwd: bare, env, home }), { model: null, source: 'default' });
  assert.equal(daemonModelFor({ env, home, config: {} })(other, { harness: 'codex', cwd: bare }), null);
});

test('reasoning effort follows repo then package declarations without inventing an owner picker', (t) => {
  const { root, env, home, soulDir } = fixture(t, 'safe', { reasoningEffort: 'low' });
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.codex'), { recursive: true });
  writeFileSync(path.join(repo, '.codex/config.toml'), 'model_reasoning_effort = "xhigh"\n');
  assert.equal(packageReasoningEffort(soulDir, 'codex'), 'low');
  assert.equal(repoReasoningEffort(repo, 'codex'), 'xhigh');
  assert.deepEqual(resolveSoulReasoningEffort({ harness: 'codex', cwd: repo, soulDir }), { effort: 'xhigh', source: 'repo' });
  assert.deepEqual(resolveSoulReasoningEffort({ harness: 'codex', cwd: soulDir, soulDir }), { effort: 'low', source: 'soul' });
  assert.deepEqual(resolveSoulReasoningEffort({ harness: 'codex', cwd: repo, soulDir, ownerModel: 'gpt-5.2[high]' }), { effort: 'high', source: 'pick' });
  assert.deepEqual(resolveSoulReasoningEffort({ harness: 'codex', cwd: repo, soulDir, ownerModel: 'gpt-5.2' }), { effort: 'xhigh', source: 'repo' });
  assert.deepEqual(resolveSoulReasoningEffort({ harness: 'codex', cwd: path.join(root, 'bare') }), { effort: null, source: 'default' });
  assert.deepEqual(daemonReasoningEffortFor({ env, home, config: {} })(ID, { harness: 'codex', cwd: repo }), { effort: 'xhigh', source: 'repo' });
  const claudeRepo = path.join(root, 'claude-repo');
  mkdirSync(path.join(claudeRepo, '.claude'), { recursive: true });
  writeFileSync(path.join(claudeRepo, '.claude/settings.json'), JSON.stringify({ effortLevel: 'medium' }));
  writeFileSync(path.join(claudeRepo, '.claude/settings.local.json'), JSON.stringify({ effortLevel: 'high' }));
  assert.equal(repoReasoningEffort(claudeRepo, 'claude'), 'high');
  writeFileSync(path.join(claudeRepo, '.claude/settings.local.json'), '{ broken');
  assert.equal(repoReasoningEffort(claudeRepo, 'claude'), 'medium');
});

test('Claude effort is sent only when declared, on both new and resumed sessions', async (t) => {
  const { env, home, soulDir } = fixture(t, 'safe', { reasoningEffort: 'high' });
  const created = await modelTurn({ harness: 'claude', cwd: soulDir, env, home, capture: true });
  assert.deepEqual(created.observed.sessionMeta, { claudeCode: { options: { effort: 'high' } } });
  const resumed = await modelTurn({ harness: 'claude', cwd: soulDir, env, home, prior: 'fake-ses-prior', capture: true });
  assert.deepEqual(resumed.observed.sessionMeta, { claudeCode: { options: { effort: 'high' } } });
  const empty = fixture(t, 'safe');
  const absent = await modelTurn({ harness: 'claude', cwd: empty.root, env: empty.env, home: empty.home, capture: true });
  assert.equal(absent.observed.sessionMeta, null);
});

test('Codex refreshes advertised effort choices after a supported model change', async (t) => {
  const { root, env, home, soulDir } = fixture(t, 'safe', { reasoningEffort: 'high', model: 'gpt-new' });
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.codex'), { recursive: true });
  writeFileSync(path.join(repo, '.codex/config.toml'), 'model = "gpt-new"\nmodel_reasoning_effort = "high"\n');
  const initial = [
    { id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-old', options: [{ name: 'old', value: 'gpt-old' }, { name: 'new', value: 'gpt-new' }] },
    { id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'low', options: [{ name: 'low', value: 'low' }] },
  ];
  const refreshed = [
    { id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-new', options: [{ name: 'new', value: 'gpt-new' }] },
    { id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'medium', options: [{ name: 'high', value: 'high' }] },
  ];
  const turn = await modelTurn({ harness: 'codex', cwd: repo, env, home, acpEnv: {
    FAKE_ACP_MODELS: JSON.stringify({ currentModelId: 'gpt-old[low]' }),
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(initial),
    FAKE_ACP_CONFIG_OPTIONS_AFTER_MODEL: JSON.stringify(refreshed),
  }, capture: true });
  assert.deepEqual(turn.observed.configRequests.map(({ configId, value }) => ({ configId, value })), [
    { configId: 'model', value: 'gpt-new' }, { configId: 'reasoning_effort', value: 'high' },
  ]);
  assert.deepEqual(turn.observed.requests, []);
});

test('Codex omits unsupported or undeclared effort and preserves a composite owner model pick', async (t) => {
  const { root, env, home, soulDir } = fixture(t, 'safe', { reasoningEffort: 'low' });
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.codex'), { recursive: true });
  writeFileSync(path.join(repo, '.codex/config.toml'), 'model_reasoning_effort = "xhigh"\n');
  const options = [{ id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'high', options: [{ name: 'high', value: 'high' }] }];
  const unsupported = await modelTurn({ harness: 'codex', cwd: repo, env, home, acpEnv: { FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(options) }, capture: true });
  assert.deepEqual(unsupported.observed.configRequests, []);
  assert.match(unsupported.logs.join('\n'), /explicit reasoning effort is unsupported by fresh advertised options/);
  const empty = fixture(t, 'safe');
  const absent = await modelTurn({ harness: 'codex', cwd: empty.root, env: empty.env, home: empty.home, acpEnv: { FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(options) }, capture: true });
  assert.deepEqual(absent.observed.configRequests, []);
  setSoulModel(ID, 'gpt-5.2[high]', { env, home });
  const selected = await modelTurn({ harness: 'codex', cwd: repo, env, home, acpEnv: {
    FAKE_ACP_MODELS: JSON.stringify({ currentModelId: 'gpt-other' }),
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(options),
  }, capture: true });
  assert.equal(selected.sent, 'gpt-5.2[high]');
  assert.deepEqual(selected.observed.configRequests, []);
  assert.deepEqual(selected.observed.requests.map(({ modelId }) => modelId), ['gpt-5.2[high]']);
  const alreadySelected = await modelTurn({ harness: 'codex', cwd: repo, env, home, acpEnv: {
    FAKE_ACP_MODELS: JSON.stringify({ currentModelId: 'gpt-5.2[high]' }),
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(options),
  }, capture: true });
  assert.deepEqual(alreadySelected.observed.configRequests, []);
  assert.deepEqual(alreadySelected.observed.requests, []);
  assert.equal(repoReasoningEffort(repo, 'codex'), 'xhigh');
  assert.equal(packageReasoningEffort(soulDir, 'codex'), 'low');
});

test('Codex does not reuse effort choices after a legacy model change', async (t) => {
  const { root, env, home } = fixture(t, 'safe', { reasoningEffort: 'high' });
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.codex'), { recursive: true });
  writeFileSync(path.join(repo, '.codex/config.toml'), 'model = "gpt-new"\nmodel_reasoning_effort = "high"\n');
  const stale = [{ id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'low', options: [{ name: 'high', value: 'high' }] }];
  const turn = await modelTurn({ harness: 'codex', cwd: repo, env, home, capture: true, acpEnv: {
    FAKE_ACP_MODELS: JSON.stringify({ currentModelId: 'gpt-old[low]' }),
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(stale),
  } });
  assert.deepEqual(turn.observed.configRequests, []);
  assert.deepEqual(turn.observed.requests.map(({ modelId }) => modelId), ['gpt-new']);
  assert.match(turn.logs.join('\n'), /fresh advertised options/);
});

test('a model-only Codex turn keeps using session/set_model unchanged', async (t) => {
  const { root, env, home } = fixture(t, 'safe');
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.codex'), { recursive: true });
  writeFileSync(path.join(repo, '.codex/config.toml'), 'model = "gpt-new"\n');
  const options = [{ id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-old', options: [{ name: 'new', value: 'gpt-new' }] }];
  const turn = await modelTurn({ harness: 'codex', cwd: repo, env, home, capture: true, acpEnv: {
    FAKE_ACP_MODELS: JSON.stringify({ currentModelId: 'gpt-old[low]' }),
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(options),
  } });
  assert.deepEqual(turn.observed.configRequests, []);
  assert.deepEqual(turn.observed.requests.map(({ modelId }) => modelId), ['gpt-new']);
});

test('Codex applies a supported explicit effort on session/load', async (t) => {
  const { env, home, soulDir } = fixture(t, 'safe', { reasoningEffort: 'high' });
  const options = [{ id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'low', options: [{ name: 'high', value: 'high' }] }];
  const turn = await modelTurn({ harness: 'codex', cwd: soulDir, env, home, prior: 'fake-ses-resumed', capture: true, acpEnv: {
    FAKE_ACP_MODELS: JSON.stringify({ currentModelId: 'gpt-5.2[low]' }),
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(options),
  } });
  assert.deepEqual(turn.observed.configRequests.map(({ configId, value }) => ({ configId, value })), [
    { configId: 'reasoning_effort', value: 'high' },
  ]);
});

test('Codex config lookup tolerates malformed options and hides setter rejection details', async (t) => {
  const { env, home, soulDir } = fixture(t, 'safe', { reasoningEffort: 'high' });
  const malformed = await modelTurn({ harness: 'codex', cwd: soulDir, env, home, capture: true, acpEnv: {
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify({ id: 'reasoning_effort', options: [{ value: 'high' }] }),
  } });
  assert.deepEqual(malformed.observed.configRequests, []);
  assert.match(malformed.logs.join('\n'), /unsupported by fresh advertised options/);
  const nonSelect = await modelTurn({ harness: 'codex', cwd: soulDir, env, home, capture: true, acpEnv: {
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([{ id: 'reasoning_effort', name: 'Reasoning effort', type: 'boolean', currentValue: 'high', options: [{ name: 'high', value: 'high' }] }]),
  } });
  assert.deepEqual(nonSelect.observed.configRequests, []);
  assert.match(nonSelect.logs.join('\n'), /unsupported by fresh advertised options/);
  const refusal = [{ id: 'reasoning_effort', name: 'Reasoning effort', type: 'select', currentValue: 'low', options: [{ name: 'high', value: 'high' }] }];
  const rejected = await modelTurn({ harness: 'codex', cwd: soulDir, env, home, capture: true, acpEnv: {
    FAKE_ACP_CONFIG_OPTIONS: JSON.stringify(refusal), FAKE_ACP_CONFIG_ERROR: '1',
  } });
  assert.equal(rejected.observed.configRequests.length, 1);
  assert.match(rejected.logs.join('\n'), /explicit reasoning effort was not accepted/);
  assert.doesNotMatch(rejected.logs.join('\n'), /private option rejection/);
});

// The owner's answers kept for a soul, and its loosening receipts.
const answers = (env, home) => listProposals({}, { env, home }).filter((proposal) => proposal.tool === LOOSENING_TOOL);
// Proposals made in the same millisecond list in any order: compare as a set.
const statuses = (env, home) => answers(env, home).map(({ status }) => status).sort();
const receipts = (env, home) => {
  try { return readFileSync(auditFile({ env, home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.operation === 'loosen'); }
  catch { return []; }
};
const asker = (answer) => {
  const asked = [];
  return { asked, ask: async (action) => { asked.push(action); return answer(action); } };
};

test('an approved loosening runs autopilot, is remembered for that file, and leaves a receipt', async (t) => {
  const { env, home, soulDir } = fixture(t, 'autopilot');
  const { asked, ask } = asker(() => ({ method: 'presence', via: 'agent-bot-keyd' }));
  const modeFor = daemonModeFor({ env, home, config: {}, ask, log: () => assert.fail('no code when the owner answers') });
  let seen = await daemonTurn({ harness: 'claude', cwd: soulDir, env, home, modeFor });
  assert.equal(seen.mode, 'autopilot');
  assert.deepEqual(seen.approvals, []);
  const digest = sha256(readFileSync(path.join(soulDir, 'soul.json'), 'utf8'));
  assert.deepEqual(asked, [`soul mode ${ID} autopilot soul sha256:${digest} ${path.join(soulDir, 'soul.json')}`]);
  assert.deepEqual(answers(env, home).map(({ agentId, status, decidedBy }) => ({ agentId, status, decidedBy })), [{ agentId: ID, status: 'approved', decidedBy: 'owner' }]);
  assert.deepEqual(receipts(env, home).map(({ event, agentId, decision, detail, reason }) => ({ event, agentId, decision, detail, reason })),
    [{ event: 'soul-mode', agentId: ID, decision: 'approved', detail: `soul sha256:${digest}`, reason: 'presence' }]);
  // The next turn, and a restarted daemon, use the answer without asking.
  seen = await daemonTurn({ harness: 'claude', cwd: soulDir, env, home, modeFor });
  assert.equal(seen.mode, 'autopilot');
  seen = await daemonTurn({ harness: 'claude', cwd: soulDir, env, home, ask: () => assert.fail('remembered') });
  assert.equal(seen.mode, 'autopilot');
  assert.equal(asked.length, 1);
  // The owner's pick still wins over the remembered answer.
  setSoulMode(ID, 'safe', { env, home });
  seen = await daemonTurn({ harness: 'claude', cwd: soulDir, env, home, modeFor });
  assert.equal(seen.mode, 'safe');
  assert.equal(asked.length, 1);
});

test('a declined loosening runs safe and is remembered; a changed file asks again', async (t) => {
  const { root, env, home, soulDir } = fixture(t, 'safe');
  const repo = path.join(root, 'repo');
  mkdirSync(path.join(repo, '.claude'), { recursive: true });
  writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  const { asked, ask } = asker(() => { throw Object.assign(new Error('the owner did not approve (cancelled)'), { code: 'owner-declined' }); });
  const modeFor = daemonModeFor({ env, home, config: {}, ask, log: () => assert.fail('no code when the owner answers') });
  let seen = await daemonTurn({ harness: 'claude', cwd: repo, env, home, modeFor });
  assert.equal(seen.mode, 'safe');
  assert.deepEqual(seen.approvals, ['Bash']);
  assert.equal(asked.length, 1);
  assert.match(asked[0], new RegExp(`^soul mode ${ID} autopilot repo sha256:[0-9a-f]{64} `));
  assert.deepEqual(statuses(env, home), ['denied']);
  assert.deepEqual(receipts(env, home).map(({ decision }) => decision), ['declined']);
  seen = await daemonTurn({ harness: 'claude', cwd: repo, env, home, modeFor });
  assert.equal(seen.mode, 'safe');
  assert.equal(asked.length, 1);
  // A new file is a new question; this time the owner approves.
  writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' }, env: {} }));
  seen = await daemonTurn({ harness: 'claude', cwd: repo, env, home, ask: async () => ({ method: 'consent' }) });
  assert.equal(seen.mode, 'autopilot');
  assert.deepEqual(statuses(env, home), ['approved', 'denied']);
});

test('with nobody to ask the turn runs safe, nothing is kept, and the next turn asks again', async (t) => {
  const { env, home, soulDir } = fixture(t, 'autopilot');
  let calls = 0;
  const ask = async (action) => { calls += 1; return headless(action); };
  const log = [];
  const modeFor = daemonModeFor({ env, home, config: {}, ask, log: (line) => log.push(line) });
  for (let turn = 0; turn < 2; turn += 1) assert.equal((await daemonTurn({ harness: 'codex', cwd: soulDir, env, home, modeFor })).mode, 'safe');
  assert.equal(calls, 2);
  assert.equal(log.length, 2);
  assert.match(log[0], new RegExp(LOOSENING_NEEDS_OWNER));
  assert.deepEqual(answers(env, home), []);
  assert.deepEqual(receipts(env, home), []);
});

test('turns that start together share one question', async (t) => {
  const { env, home, soulDir } = fixture(t, 'autopilot');
  let release;
  const answered = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const modeFor = daemonModeFor({ env, home, config: {}, ask: async () => { calls += 1; await answered; return { method: 'presence' }; }, log: () => {} });
  const turns = [modeFor(ID, { harness: 'claude', cwd: soulDir }), modeFor(ID, { harness: 'claude', cwd: soulDir })];
  release();
  assert.deepEqual(await Promise.all(turns), ['autopilot', 'autopilot']);
  assert.equal(calls, 1);
});

test('the daemon asks through keyd alone: no administrator dialog, so nothing blocks it', async (t) => {
  const { env, home, soulDir } = fixture(t, 'autopilot');
  const log = [];
  // keyd cannot ask: the turn runs safe and nothing is kept, with no dialog fallback.
  let modeFor = daemonModeFor({ env, home, config: {}, log: (line) => log.push(line),
    presence: async () => { throw Object.assign(new Error('no GeniusBar'), { code: 'presence-unavailable' }); } });
  assert.equal(await modeFor(ID, { harness: 'claude', cwd: soulDir }), 'safe');
  assert.match(log[0], new RegExp(`${LOOSENING_NEEDS_OWNER}: .*no administrator-dialog fallback`));
  assert.deepEqual(answers(env, home), []);
  // keyd's refusal is kept as a decline.
  modeFor = daemonModeFor({ env, home, config: {}, log: () => {},
    presence: async () => { throw Object.assign(new Error('the owner did not approve'), { code: 'owner-declined' }); } });
  assert.equal(await modeFor(ID, { harness: 'claude', cwd: soulDir }), 'safe');
  assert.deepEqual(statuses(env, home), ['denied']);
  // keyd's approval is the answer, with the prompt naming the soul and file.
  writeFileSync(path.join(soulDir, 'soul.json'), `${readFileSync(path.join(soulDir, 'soul.json'), 'utf8')}\n`);
  const prompts = [];
  modeFor = daemonModeFor({ env, home, config: {}, log: () => {},
    presence: async (summary) => { prompts.push(summary); return { method: 'presence', via: 'agent-bot-keyd' }; } });
  assert.equal(await modeFor(ID, { harness: 'claude', cwd: soulDir }), 'autopilot');
  assert.match(prompts[0], /run in Auto-Pilot, as its soul package asks \(.*soul\.json, sha256:[0-9a-f]{12}\)$/);
  assert.deepEqual(statuses(env, home), ['approved', 'denied']);
});

test('the daemon does not open the interactive SSH challenge fallback', async (t) => {
  if (!HAS_SSH_KEYGEN) return t.skip('ssh-keygen is not installed');
  const { env, home, soulDir, root } = fixture(t, 'autopilot');
  const keyPath = path.join(root, 'owner-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const parsed = parseSshPublicKey(publicKey);
  writeOwnerKeys([{ name: 'test-key', store: 'ssh', alg: 'sshsig', publicKey, fingerprint: sshFingerprint(parsed.blob),
    verifyRequired: false, softwareKey: true, pinnedAt: '2026-10-09T00:00:00.000Z' }], { env });

  const log = [];
  const modeFor = daemonModeFor({ env, home, config: {}, presence: headless, log: (line) => log.push(line) });
  assert.equal(await modeFor(ID, { harness: 'claude', cwd: soulDir }), 'safe');
  assert.match(log[0], /no administrator-dialog fallback/);
  assert.doesNotMatch(log[0], /interactive terminal/);
});

test('an answer that cannot be receipted is neither applied nor kept', async (t) => {
  const { env, home, soulDir } = fixture(t, 'autopilot');
  // The audit log's path is a directory: the append fails.
  mkdirSync(auditFile({ env, home }), { recursive: true });
  const log = [];
  const modeFor = daemonModeFor({ env, home, config: {}, ask: async () => ({ method: 'presence' }), log: (line) => log.push(line) });
  assert.equal(await modeFor(ID, { harness: 'claude', cwd: soulDir }), 'safe');
  assert.match(log[0], /could not be receipted; running safe/);
  assert.deepEqual(answers(env, home), []);
});
