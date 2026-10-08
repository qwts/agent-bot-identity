import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { initAgentSpace } from '../agent-space.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { buildHarnessFiles, harnessReport } from '../soul-builder.mjs';
import { credentialStores, deleteSoulSecret, fileStore, keychainStore, keydStore, passCliStore, readSoulSecret, secretItem, writeSoulSecret } from '../soul-credentials.mjs';
import { ENV_CAPABILITIES, readSoulEnvironment } from '../soul-env.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { PROVIDERS, PROVIDER_HARNESSES, claudeProviderEnv, codexProviderConfig, declaredProviders, envKeyOrThrow, normalizeProvider, opencodeProviderConfig, providerIds, providerRenders, secretNameOrThrow, secretSetCommand, validateSecretsDeclaration } from '../soul-providers.mjs';
import { inspectSoulSecrets, pendingSoulProvider, checkSoulProvider, soulProviderEnv, soulSecretCommand, soulSecretsStatus } from '../soul-secrets.mjs';
import { GENERATED_HARNESS_MARKER as MARKER } from '../soul-harness-contract.mjs';
import { fakePassCli } from './fixtures/fake-pass-cli.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_SECURITY = path.join(ROOT, 'tests', 'fixtures', 'fake-security.mjs');
const SECRET = 'ghp_NEVER-PRINT-THIS-VALUE-0123456789';
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const entry = (p, content) => ({ path: p, mode: '100644', bytes: Buffer.from(content) });
const manifest = (extra = {}) => ({ formatVersion: 2, name: 'Billy', description: 'Provider tests', displaySeed: 'billy', preferredHarnesses: ['codex'],
  revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, ...extra });
const entries = (soul) => [entry('AGENTS.md', '# Billy\n'), entry('soul.json', JSON.stringify(soul))];
const GITHUB = { id: 'github', baseUrl: 'https://models.github.ai/inference', credential: 'github-models' };
const SECRETS = { 'github-models': { store: 'file' } };
// Everything that could leak the value: files under the soul, the census
// home, every receipt, and every line a command printed.
function assertNoLeak(root, label) {
  for (const file of readdirSync(root, { recursive: true }).map(String)) {
    const full = path.join(root, file);
    if (!statSync(full).isFile()) continue;
    assert.ok(!readFileSync(full, 'latin1').includes(SECRET), `${label}: ${file} holds the secret value`);
  }
}

// A hermetic census: identity, population row, souls root and state under
// one temp HOME; the keychain is the fake. Nothing touches the real HOME.
function fixture(t, { extra = {}, census = true } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-providers-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config'),
    AGENT_BOT_SECURITY_BIN: FAKE_SECURITY, FAKE_KEYCHAIN: path.join(home, 'keychain.json'), FAKE_KEYCHAIN_LOG: path.join(home, 'keychain.log') };
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy.soul');
  const soul = manifest(JSON.parse(JSON.stringify({ harnesses: { codex: { provider: GITHUB } }, credentials: { secrets: SECRETS }, ...extra })));
  put(path.join(dir, 'soul.json'), JSON.stringify(soul));
  put(path.join(dir, 'AGENTS.md'), '# Billy\n');
  put(path.join(dir, '.soul-state', 'agent-id'), `${ID}\n`);
  if (census) {
    mintAgentIdentity({ stateDir: stateDirectory({ env, home }), idFactory: () => ID, harness: 'codex', appSlug: null, useGithub: false });
    const space = initAgentSpace(ID, { env, home });
    upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: space.path, status: 'active', parentId: null, appSlug: null }, { file: env.AGENT_BOT_POPULATION_PATH });
  }
  const options = { env, home, cwd: home, file: env.AGENT_BOT_POPULATION_PATH, config: {}, platform: 'linux' };
  const writeManifest = (change) => { change(soul); put(path.join(dir, 'soul.json'), JSON.stringify(soul)); };
  return { home, env, dir, soul, options, writeManifest };
}

test('the provider schema accepts every documented id with its defaults and refuses the rest with the field path', () => {
  assert.deepEqual(PROVIDER_HARNESSES, ['codex', 'claude', 'opencode']);
  assert.deepEqual(providerIds('codex'), ['openai', 'github', 'openai-compatible']);
  assert.deepEqual(normalizeProvider('codex', { id: 'openai' }), { id: 'openai', name: 'OpenAI', baseUrl: null, envKey: 'OPENAI_API_KEY', wireApi: 'responses', credential: null });
  assert.deepEqual(normalizeProvider('codex', GITHUB), { id: 'github', name: 'GitHub', baseUrl: GITHUB.baseUrl, envKey: 'GITHUB_TOKEN', wireApi: 'chat', credential: 'github-models' });
  assert.deepEqual(normalizeProvider('codex', { id: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', envKey: 'OLLAMA_KEY', wireApi: 'responses' }),
    { id: 'openai-compatible', name: 'OpenAI-compatible', baseUrl: 'http://localhost:11434/v1', envKey: 'OLLAMA_KEY', wireApi: 'responses', credential: null });
  assert.deepEqual(normalizeProvider('claude', { id: 'anthropic' }), { id: 'anthropic', name: 'Anthropic', baseUrl: null, envKey: 'ANTHROPIC_API_KEY', wireApi: null, credential: null });
  assert.equal(normalizeProvider('opencode', { id: 'github', baseUrl: GITHUB.baseUrl }).envKey, 'GITHUB_TOKEN');
  for (const [harness, value, pattern] of [
    ['codex', 'github', /must be an object/], ['codex', {}, /\.id must be one of openai, github, openai-compatible/],
    ['codex', { id: 'azure' }, /\.id must be one of/], ['codex', { id: 'github' }, /\.baseUrl is required for github/],
    ['codex', { ...GITHUB, extra: 1 }, /accepts only id, baseUrl, envKey, wireApi, credential/],
    ['codex', { id: 'openai', baseUrl: 'http://api.example.com/v1' }, /https/], ['codex', { id: 'openai', baseUrl: 'https://user:pw@api.example.com/v1' }, /baseUrl/],
    ['codex', { id: 'openai', envKey: 'openai_key' }, /\.envKey must match/], ['codex', { id: 'openai', envKey: 'HOME' }, /reserved/],
    ['codex', { id: 'openai', envKey: 'AGENT_BOT_X' }, /reserved/], ['codex', { id: 'openai', wireApi: 'grpc' }, /\.wireApi must be one of chat, responses/],
    ['claude', { id: 'anthropic', wireApi: 'chat' }, /wireApi is only accepted for codex/], ['codex', { id: 'openai', credential: 'Bad Name' }, /credential must use lowercase/],
    ['gemini', { id: 'google' }, /gemini has no provider rendering/], ['kiro', { id: 'openai' }, /has no provider rendering/],
  ]) {
    assert.throws(() => normalizeProvider(harness, value), (error) => { assert.match(error.message, pattern, `${harness} ${JSON.stringify(value)}`); assert.match(error.message, /^soul\.json harnesses\./); return true; });
  }
  assert.deepEqual(validateSecretsDeclaration({ 'github-models': { store: 'keychain' }, 'ollama-key': {} }), { 'github-models': { store: 'keychain' }, 'ollama-key': { store: null } });
  for (const [value, pattern] of [[[], /must be an object/], [{ 'Bad Name': {} }, /must use lowercase letters/], [{ a: { store: 'keyd' } }, /keyd never returns a value/],
    [{ a: { store: 'vault' } }, /store must be one of keychain, file, pass-cli/], [{ a: { store: 'file', extra: 1 } }, /accepts only store/], [{ a: 'file' }, /must be an object/]]) {
    assert.throws(() => validateSecretsDeclaration(value), pattern);
  }
  assert.throws(() => envKeyOrThrow('XDG_DATA_HOME', 'x'), /reserved/);
  assert.throws(() => secretNameOrThrow('UPPER'), /secret name/);
  assert.equal(secretSetCommand(ID, 'github-models'), `agent-bot soul secret ${ID} set github-models`);
  // A manifest read never throws: what is wrong is listed with its path.
  const declared = declaredProviders({ harnesses: { codex: { provider: GITHUB }, claude: { provider: { id: 'anthropic', credential: 'nope' } }, gemini: { model: 'x' } }, credentials: { secrets: SECRETS } });
  assert.deepEqual(Object.keys(declared.providers), ['codex']);
  assert.deepEqual(declared.secrets, { 'github-models': { store: 'file' } });
  assert.deepEqual(declared.invalid, [{ path: 'harnesses.claude.provider', message: 'soul.json harnesses.claude.provider.credential names credentials.secrets.nope, which is not declared' }]);
  assert.deepEqual(declaredProviders({ credentials: { secrets: { a: { store: 'keyd' } } } }).invalid.map((e) => e.path), ['credentials.secrets']);
  assert.deepEqual(declaredProviders(null), { providers: {}, secrets: {}, invalid: [] });
  assert.ok(Object.isFrozen(PROVIDERS.codex.ids.github));
});

test('the package validator applies the provider schema under harnesses.<name> and credentials.secrets', (t) => {
  const accepted = fixture(t, { census: false, extra: { harnesses: { codex: { provider: GITHUB }, claude: { provider: { id: 'anthropic-compatible', baseUrl: 'https://proxy.example.com' } }, opencode: { provider: { id: 'openai' } } },
    credentials: { secrets: { 'github-models': { store: 'keychain' } } } } });
  accepted.writeManifest((soul) => { soul.revision = computePackageRevision(accepted.dir); });
  validateSoulPackage(accepted.dir);
  for (const [extra, field, pattern] of [
    [{ harnesses: { codex: { provider: { id: 'github' } } } }, 'harnesses.codex.provider', /baseUrl is required/],
    [{ harnesses: { codex: { provider: { id: 'bedrock' } } } }, 'harnesses.codex.provider', /id must be one of/],
    [{ harnesses: { codex: { provider: GITHUB } } }, 'harnesses.codex.provider', /credentials\.secrets\.github-models, which is not declared/],
    [{ harnesses: { gemini: { provider: { id: 'openai' } } } }, 'harnesses.gemini.provider', /has no provider rendering/],
    [{ harness: { provider: { id: 'openai' } } }, 'harness.provider', /only accepted under harnesses/],
    [{ credentials: { secrets: { 'github-models': { store: 'keyd' } } } }, 'credentials.secrets', /keyd/],
    [{ credentials: { github: { app: 'x', store: 'file' }, token: {} } }, 'credentials', /accepts only github and secrets/],
  ]) {
    const f = fixture(t, { census: false, extra: { harnesses: undefined, credentials: undefined, ...extra } });
    f.writeManifest((soul) => { for (const key of Object.keys(soul)) if (soul[key] === undefined) delete soul[key]; });
    // The manifest is read (and refused) wherever the package is read, the revision included.
    assert.throws(() => validateSoulPackage(f.dir), (error) => { assert.ok(error.message.includes(`soul.json ${field}`), error.message); assert.match(error.message, pattern); return true; });
  }
});

test('the builder renders the provider per harness without any secret, and --check reports a changed provider as drift', (t) => {
  const soul = manifest({ harnesses: {
    codex: { provider: GITHUB, env: { LOG_LEVEL: 'debug' } },
    claude: { provider: { id: 'anthropic-compatible', baseUrl: 'https://proxy.example.com/v1', credential: 'github-models' } },
    opencode: { provider: { id: 'github', baseUrl: GITHUB.baseUrl, credential: 'github-models' } },
  }, credentials: { secrets: SECRETS } });
  assert.deepEqual(codexProviderConfig(normalizeProvider('codex', GITHUB)), { model_provider: 'github', table: { name: 'GitHub', base_url: GITHUB.baseUrl, env_key: 'GITHUB_TOKEN', wire_api: 'chat' } });
  assert.deepEqual(codexProviderConfig(normalizeProvider('codex', { id: 'openai' })), { model_provider: 'openai', table: { name: 'OpenAI', env_key: 'OPENAI_API_KEY', wire_api: 'responses' } });
  assert.deepEqual(claudeProviderEnv(normalizeProvider('claude', { id: 'anthropic' })), {});
  assert.deepEqual(claudeProviderEnv(normalizeProvider('claude', { id: 'anthropic', baseUrl: 'https://proxy.example.com' })), { ANTHROPIC_BASE_URL: 'https://proxy.example.com' });
  assert.deepEqual(opencodeProviderConfig(normalizeProvider('opencode', { id: 'github', baseUrl: GITHUB.baseUrl, credential: 'github-models' })),
    { github: { npm: '@ai-sdk/openai-compatible', name: 'GitHub', options: { baseURL: GITHUB.baseUrl, apiKey: '{env:GITHUB_TOKEN}' } } });
  assert.equal(opencodeProviderConfig(normalizeProvider('opencode', { id: 'openai' })), null);
  assert.equal(providerRenders('claude', normalizeProvider('claude', { id: 'anthropic' })), false);
  const output = buildHarnessFiles(entries(soul));
  const toml = output.get('.codex/config.toml').toString();
  // The provider table sits after the generated MCP entry and before the env table.
  assert.ok(toml.startsWith(`# ${MARKER}\nmodel_provider = "github"\n\n[mcp_servers.agent-bot]\n`), toml);
  assert.ok(toml.endsWith(`\n[model_providers.github]\nname = "GitHub"\nbase_url = "${GITHUB.baseUrl}"\nenv_key = "GITHUB_TOKEN"\nwire_api = "chat"\n\n[shell_environment_policy.set]\nLOG_LEVEL = "debug"\n`), toml);
  assert.equal(toml.match(/model_provider/g).length, 2);
  assert.deepEqual(JSON.parse(output.get('.claude/settings.json').toString()).env, { ANTHROPIC_BASE_URL: 'https://proxy.example.com/v1' });
  assert.deepEqual(JSON.parse(output.get('opencode.json').toString()).provider, { github: { npm: '@ai-sdk/openai-compatible', name: 'GitHub', options: { baseURL: GITHUB.baseUrl, apiKey: '{env:GITHUB_TOKEN}' } } });
  for (const [file, bytes] of output) assert.ok(!bytes.toString().includes('github-models'), `${file} names the secret declaration`);
  const report = harnessReport(output, { manifest: soul });
  assert.deepEqual(report.codex.settings, { received: ['env', 'provider'], rendered: ['env', 'provider'] });
  assert.deepEqual(report.claude.settings, { received: ['provider'], rendered: ['provider'] });
  assert.deepEqual(report.opencode.settings, { received: ['provider'], rendered: ['provider'] });
  assert.deepEqual(report.gemini.unsupported.settings, []);
  // A plain OpenAI provider on Claude renders nothing and says so.
  const plain = buildHarnessFiles(entries(manifest({ harnesses: { claude: { provider: { id: 'anthropic' } }, codex: { provider: { id: 'openai' } } } })));
  assert.equal(plain.has('.claude/settings.json'), false, 'nothing to render for Claude');
  const plainToml = plain.get('.codex/config.toml').toString();
  assert.ok(plainToml.startsWith(`# ${MARKER}\nmodel_provider = "openai"\n`) && plainToml.endsWith(`\n[model_providers.openai]\nname = "OpenAI"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n`), plainToml);
  assert.ok(!plainToml.includes('base_url'));
  assert.deepEqual(harnessReport(plain, { manifest: manifest({ harnesses: { claude: { provider: { id: 'anthropic' } } } }) }).claude.settings, { received: ['provider'], rendered: [] });
  // Authored Codex settings keep their other tables; an inline provider table cannot be merged.
  const authored = new Map([['.codex/config.toml', Buffer.from('model = "gpt-5"\n[model_providers.github]\nbase_url = "https://old.example.com"\n\n[profiles.local]\nmodel = "m"\n')]]);
  const merged = buildHarnessFiles(entries(soul), { authored }).get('.codex/config.toml').toString();
  assert.ok(merged.includes('model = "gpt-5"\n') && merged.includes('[profiles.local]\nmodel = "m"\n'));
  assert.equal(merged.match(/\[model_providers\.github\]/g).length, 1);
  // The authored endpoint is replaced line for line (an exact match, not a substring of some other URL).
  assert.doesNotMatch(merged, /^base_url = "https:\/\/old\.example\.com"$/m);
  assert.throws(() => buildHarnessFiles(entries(soul), { authored: new Map([['.codex/config.toml', Buffer.from('model_providers = { github = { name = "x" } }\n')]]) }), /model_providers\.github must be a \[model_providers\.github\] table/);
  // Built into a soul folder, a provider change is drift until the next build.
  const f = fixture(t, { census: false, extra: { harnesses: { codex: { provider: GITHUB } } } });
  f.writeManifest((s) => { s.revision = computePackageRevision(f.dir); });
  buildSoulDirectory(f.dir);
  assert.ok(readFileSync(path.join(f.dir, '.codex', 'config.toml'), 'utf8').includes('model_provider = "github"'));
  assert.deepEqual(buildSoulDirectory(f.dir, { check: true }).drift, []);
  f.writeManifest((s) => { s.harnesses.codex.provider = { id: 'openai' }; s.revision = computePackageRevision(f.dir); });
  assert.deepEqual(buildSoulDirectory(f.dir, { check: true }).drift, ['.codex/config.toml']);
  buildSoulDirectory(f.dir);
  assert.ok(readFileSync(path.join(f.dir, '.codex', 'config.toml'), 'utf8').includes('model_provider = "openai"'));
});

test('every store keeps a provider secret under the soul\'s namespace and gives it back only to the store API', (t) => {
  const f = fixture(t, { census: false });
  assert.deepEqual(secretItem(ID, 'github-models'), { service: `agent-bot.soul.${ID}`, account: 'secret/github-models' });
  assert.throws(() => secretItem(ID, 'Bad'), /secret name/);
  const target = { agentId: ID, soulDir: f.dir, name: 'github-models' };
  const keychain = keychainStore({ env: f.env });
  assert.equal(keychain.readSecret(target), null);
  keychain.writeSecret(target, SECRET);
  assert.equal(keychain.readSecret(target), SECRET);
  const log = readFileSync(f.env.FAKE_KEYCHAIN_LOG, 'utf8');
  assert.ok(!log.includes(SECRET), 'the value is never on security\'s argv');
  assert.ok(log.includes('"secret/github-models"'));
  assert.equal(keychain.deleteSecret(target), true);
  assert.equal(keychain.deleteSecret(target), false);
  assert.equal(keychain.readSecret(target), null);
  const file = fileStore();
  file.writeSecret(target, SECRET);
  const stored = path.join(f.dir, '.soul-state', 'credentials', 'secret-github-models.json');
  assert.equal(statSync(stored).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(stored)).mode & 0o777, 0o700);
  assert.ok(!readFileSync(stored, 'utf8').includes(SECRET), 'the file holds an encoding, not the raw value');
  assert.equal(file.readSecret(target), SECRET);
  file.writeSecret(target, 'replaced');
  assert.equal(file.readSecret(target), 'replaced');
  assert.equal(file.deleteSecret(target), true);
  assert.equal(file.readSecret(target), null);
  chmodSync(path.dirname(stored), 0o755);
  file.writeSecret(target, SECRET);
  assert.equal(statSync(path.dirname(stored)).mode & 0o777, 0o700, 'a write re-tightens the directory');
  chmodSync(path.dirname(stored), 0o755);
  assert.throws(() => file.readSecret(target), /readable by others/);
  chmodSync(path.dirname(stored), 0o700);
  // The github-app item and the secret item never collide.
  assert.equal(file.read({ soulDir: f.dir, slug: 'github-models' }), null);
  assert.throws(() => keydStore().readSecret(target), (e) => e.code === 'keyd-held');
  // The declared store picks the implementation; an undeclared one is the platform default.
  const stores = credentialStores({ env: f.env });
  writeSoulSecret({ ...target, declaration: { store: 'keychain' } }, SECRET, { stores, platform: 'linux' });
  assert.equal(readSoulSecret({ ...target, declaration: { store: 'keychain' } }, { stores, platform: 'linux' }), SECRET);
  assert.equal(readSoulSecret({ ...target, declaration: { store: null } }, { stores, platform: 'linux' }), SECRET, 'linux defaults to the file store');
  assert.equal(readSoulSecret({ ...target, declaration: {} }, { stores, platform: 'darwin' }), SECRET, 'darwin defaults to the keychain');
  assert.throws(() => readSoulSecret({ ...target, declaration: { store: 'keyd' } }, { stores, platform: 'linux' }), (e) => e.code === 'keyd-held');
  assert.throws(() => readSoulSecret({ ...target, declaration: { store: 'vault' } }, { stores, platform: 'linux' }), (e) => e.code === 'secret-store-unsupported');
  assert.equal(deleteSoulSecret({ ...target, declaration: { store: 'keychain' } }, { stores, platform: 'linux' }), true);
  // pass-cli: one note per secret, absent is null, replaced in place.
  const fake = fakePassCli();
  const pass = passCliStore({ env: f.env, cwd: f.home, passRun: fake.run });
  assert.equal(pass.readSecret(target), null);
  pass.writeSecret(target, SECRET);
  assert.equal(pass.readSecret(target), SECRET);
  assert.equal(fake.items.size, 1);
  pass.writeSecret(target, 'rotated');
  assert.equal(pass.readSecret(target), 'rotated');
  assert.equal(fake.items.size, 1, 'a rotation replaces the one note');
  assert.equal(pass.deleteSecret(target), true);
  assert.equal(pass.deleteSecret(target), false);
  assert.equal(pass.readSecret(target), null);
  assert.ok(!JSON.stringify(fake.calls).includes(SECRET), 'the value is never on pass-cli argv');
  assert.throws(() => passCliStore({ env: { ...f.env, AGENT_BOT_ID: ID }, cwd: f.home, passRun: fake.run }).readSecret(target), (e) => e.code === 'owner-only');
  assertNoLeak(f.home, 'stores');
});

test('soul secret set|clear|status take the value on stdin, pass the owner gate, receipt name and action only, and never print the value', async (t) => {
  const f = fixture(t);
  const gates = [];
  const gate = async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; };
  let out = '';
  const write = (value) => { out += value; };
  const options = { ...f.options, gate, write };
  const status = await soulSecretCommand(['billy', 'status', '--json'], options);
  assert.deepEqual(JSON.parse(out), status);
  assert.deepEqual(Object.keys(status), ['schemaVersion', 'agentId', 'soulDir', 'providers', 'secrets', 'invalid', 'ready']);
  assert.deepEqual(status.providers, [{ harness: 'codex', id: 'github', name: 'GitHub', baseUrl: GITHUB.baseUrl, envKey: 'GITHUB_TOKEN', wireApi: 'chat', credential: 'github-models', store: 'file', status: 'secret-missing', reason: null }]);
  assert.deepEqual(status.secrets, [{ name: 'github-models', store: 'file', status: 'missing', reason: null, usedBy: ['codex'] }]);
  assert.deepEqual([status.agentId, status.soulDir, status.ready, gates], [ID, f.dir, false, []]);
  assert.deepEqual(pendingSoulProvider(ID, { ...f.options, harness: 'codex' }), ['codex:github']);
  assert.deepEqual(pendingSoulProvider(ID, { ...f.options, harness: 'claude' }), []);
  assert.throws(() => checkSoulProvider(ID, { ...f.options, harness: 'codex' }), (error) => {
    assert.equal(error.code, 'provider-secret-missing');
    assert.equal(error.action, `agent-bot soul secret ${ID} set github-models`);
    assert.match(error.message, /needs the secret "github-models" \(GITHUB_TOKEN\)/);
    return true;
  });
  out = '';
  const set = await soulSecretCommand([ID, 'set', 'github-models', '--json'], { ...options, readStdin: () => `${SECRET}\n` });
  assert.deepEqual(JSON.parse(out), set);
  assert.deepEqual([set.action, set.name, set.store, set.status, set.ready], ['set', 'github-models', 'file', 'present', true]);
  assert.equal(set.providers[0].status, 'ready');
  assert.deepEqual(gates, [[`set ${ID}'s provider secret "github-models" in its file store`, null]]);
  assert.ok(!out.includes(SECRET) && !out.includes(String(SECRET.length)), 'neither the value nor its length is printed');
  const receipts = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((r) => r.event === 'soul-secret');
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].agentId, receipts[0].operation, receipts[0].decision, receipts[0].detail], [ID, 'set', 'stored', 'secret: github-models (file)']);
  assertNoLeak(f.home, 'after set');
  // The launch reads it back for the launched harness alone.
  assert.deepEqual(soulProviderEnv(ID, { ...f.options, harness: 'codex' }), { env: { GITHUB_TOKEN: SECRET }, envKey: 'GITHUB_TOKEN', provider: { harness: 'codex', id: 'github', envKey: 'GITHUB_TOKEN', credential: 'github-models' } });
  assert.deepEqual(soulProviderEnv(ID, { ...f.options, harness: 'claude' }), { env: {}, envKey: null, provider: null });
  assert.deepEqual(soulProviderEnv(ID, { ...f.options, harness: null }), { env: {}, envKey: null, provider: null });
  assert.deepEqual(checkSoulProvider(ID, { ...f.options, harness: 'codex' }), { harness: 'codex', id: 'github', envKey: 'GITHUB_TOKEN', credential: 'github-models' });
  // The principal rides in the same JSON object as the value when stdin carries both.
  out = '';
  await soulSecretCommand(['billy', 'set', 'github-models', '--principal-stdin'], { ...options, readStdin: () => JSON.stringify({ principal: { principalId: 'p1' }, value: 'rotated-value' }) });
  assert.equal(gates.at(-1)[1].principalId, 'p1');
  assert.match(out, /^agentId: /);
  assert.ok(!out.includes('rotated-value'));
  assert.equal(soulProviderEnv(ID, { ...f.options, harness: 'codex' }).env.GITHUB_TOKEN, 'rotated-value');
  out = '';
  const cleared = await soulSecretCommand(['billy', 'clear', 'github-models', '--json', '--principal-stdin'], { ...options, readStdin: () => '{"principalId":"p2"}' });
  assert.deepEqual([cleared.action, cleared.status, cleared.secrets[0].status, cleared.providers[0].status], ['clear', 'missing', 'missing', 'secret-missing']);
  assert.deepEqual(gates.at(-1), [`clear ${ID}'s provider secret "github-models" in its file store`, { principalId: 'p2' }]);
  const again = await soulSecretCommand(['billy', 'clear', 'github-models', '--json'], { ...options, write: () => {} });
  assert.equal(again.status, 'missing');
  const all = readFileSync(auditFile({ env: f.env, home: f.home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((r) => r.event === 'soul-secret');
  assert.deepEqual(all.map((r) => [r.operation, r.decision]), [['set', 'stored'], ['set', 'stored'], ['clear', 'cleared'], ['clear', 'absent']]);
  assert.ok(!existsSync(path.join(f.dir, '.soul-state', 'credentials', 'secret-github-models.json')));
  // Refusals: undeclared names, empty or multi-line values, usage.
  await assert.rejects(soulSecretCommand(['billy', 'set', 'openai', '--json'], { ...options, readStdin: () => 'x' }), (e) => e.code === 'secret-not-declared' && /declare credentials\.secrets\.openai/.test(e.action));
  await assert.rejects(soulSecretCommand(['billy', 'set', 'github-models'], { ...options, readStdin: () => '\n' }), (e) => e.code === 'secret-value-invalid');
  await assert.rejects(soulSecretCommand(['billy', 'set', 'github-models'], { ...options, readStdin: () => 'line one\nline two\n' }), (e) => e.code === 'secret-value-invalid');
  await assert.rejects(soulSecretCommand(['billy', 'set', 'github-models', '--principal-stdin'], { ...options, readStdin: () => '{"principal":{}}' }), (e) => e.code === 'secret-value-invalid');
  await assert.rejects(soulSecretCommand(['billy', 'set', 'github-models', '--principal-stdin'], { ...options, readStdin: () => 'not json' }), /one JSON object/);
  await assert.rejects(soulSecretCommand(['billy', 'set', 'Bad-Name'], { ...options, readStdin: () => 'x' }), /secret name/);
  for (const args of [[], ['billy'], ['billy', 'status', 'name'], ['billy', 'set'], ['billy', 'status', '--principal-stdin'], ['billy', 'rotate', 'x'], ['billy', '--nope', 'status'], ['billy', 'set', 'a', 'b']]) {
    await assert.rejects(soulSecretCommand(args, options), /usage:/, args.join(' '));
  }
  await assert.rejects(soulSecretCommand(['nobody', 'status'], options), (e) => e.code === 'soul-not-found');
  assert.equal(gates.length, 4, 'refused commands never reached the gate');
  assertNoLeak(f.home, 'end');
});

test('a soul with a broken declaration, an unreadable store or no folder is reported, never guessed', (t) => {
  const f = fixture(t);
  f.writeManifest((soul) => { soul.credentials.secrets['github-models'].store = 'keyd'; });
  const status = soulSecretsStatus(ID, f.options);
  assert.deepEqual(status.invalid.map((e) => e.path), ['credentials.secrets', 'harnesses.codex.provider']);
  assert.deepEqual(status.providers, [], 'a provider naming an undeclarable secret is invalid, not guessed');
  assert.throws(() => checkSoulProvider(ID, { ...f.options, harness: 'codex' }), (e) => e.code === 'provider-declaration-invalid');
  assert.deepEqual(pendingSoulProvider(ID, { ...f.options, harness: 'codex' }), ['credentials.secrets', 'harnesses.codex.provider']);
  f.writeManifest((soul) => { soul.credentials.secrets['github-models'].store = 'file'; });
  const stored = path.join(f.dir, '.soul-state', 'credentials');
  mkdirSync(stored, { recursive: true, mode: 0o755 });
  put(path.join(stored, 'secret-github-models.json'), 'x');
  const loose = inspectSoulSecrets(f.dir, { agentId: ID, platform: 'linux' });
  assert.deepEqual([loose.secrets[0].status, loose.providers[0].status], ['unreadable', 'unsupported']);
  assert.match(loose.secrets[0].reason, /readable by others/);
  assert.throws(() => checkSoulProvider(ID, { ...f.options, harness: 'codex' }), (e) => e.code === 'provider-secret-unreadable' && e.action === secretSetCommand(ID, 'github-models'));
  rmSync(f.dir, { recursive: true, force: true });
  assert.deepEqual(soulSecretsStatus(ID, f.options).providers, []);
  assert.deepEqual(soulProviderEnv(ID, { ...f.options, harness: 'codex' }), { env: {}, envKey: null, provider: null });
});

test('soul env lists providers and secrets with a readiness problem that names the fixing command, and the CLI prints the same', (t) => {
  const f = fixture(t);
  assert.deepEqual([...ENV_CAPABILITIES], ['env', 'revision-prepare', 'runtimes', 'providers', 'tool-homes', 'memory', 'history', 'template-name', 'template-refresh', 'launch-parent', 'migrate-complete', 'env-clean', 'env-export', 'env-import', 'harnesses-into-runtimes']);
  const missing = readSoulEnvironment(ID, { env: f.env, home: f.home, platform: 'linux' });
  assert.deepEqual(missing.providers, {
    declared: [{ harness: 'codex', id: 'github', name: 'GitHub', baseUrl: GITHUB.baseUrl, envKey: 'GITHUB_TOKEN', wireApi: 'chat', credential: 'github-models', store: 'file', status: 'secret-missing' }],
    secrets: [{ name: 'github-models', store: 'file', status: 'missing', usedBy: ['codex'] }], invalid: [] });
  const problem = missing.readiness.problems.find((p) => p.code === 'provider-secret-missing');
  assert.deepEqual([problem.severity, problem.component, problem.action], ['error', 'credentials', `agent-bot soul secret ${ID} set github-models`]);
  assert.equal(missing.readiness.ready, false);
  assert.deepEqual(missing.components.find((c) => c.id === 'credentials').secrets, ['github-models']);
  assert.ok(missing.launch.routing.env.includes('GITHUB_TOKEN'));
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), ...args], { cwd: f.home, env: { ...f.env, PATH: process.env.PATH }, encoding: 'utf8', input: `${SECRET}\n`, timeout: 20000 });
  const before = cli('soul', 'secret', 'billy', 'status', '--json');
  assert.equal(before.status, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).secrets[0].status, 'missing');
  // The real CLI's set goes through the owner gate: a soul-marked caller is refused before anything is read or stored.
  const refused = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'secret', 'billy', 'set', 'github-models', '--json'],
    { cwd: f.home, env: { ...f.env, PATH: process.env.PATH, AGENT_BOT_ID: ID }, encoding: 'utf8', input: `${SECRET}\n`, timeout: 20000 });
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(!refused.stdout.includes(SECRET) && !refused.stderr.includes(SECRET));
  assert.match(JSON.parse(refused.stdout).error.message, /owner only/);
  assert.equal(existsSync(path.join(f.dir, '.soul-state', 'credentials', 'secret-github-models.json')), false);
  // Stored through the API, the descriptor and the CLI see it present.
  fileStore().writeSecret({ agentId: ID, soulDir: f.dir, name: 'github-models' }, SECRET);
  const ready = readSoulEnvironment(ID, { env: f.env, home: f.home, platform: 'linux' });
  assert.deepEqual([ready.providers.declared[0].status, ready.providers.secrets[0].status], ['ready', 'present']);
  assert.equal(ready.readiness.problems.some((p) => p.code.startsWith('provider-')), false);
  const envCli = cli('soul', 'env', 'billy', '--json');
  assert.equal(envCli.status, 0, envCli.stderr);
  assert.equal(JSON.parse(envCli.stdout).providers.declared[0].status, 'ready');
  assert.ok(!envCli.stdout.includes(SECRET));
  const text = cli('soul', 'secret', 'billy', 'status');
  assert.match(text.stdout, /^agentId: .*\nprovider codex: github https:\/\/models\.github\.ai\/inference GITHUB_TOKEN <- github-models ready\nsecret github-models: present \(file\) for codex\n/s);
  const unknown = cli('soul', 'secret', 'nobody', 'status', '--json');
  assert.deepEqual(JSON.parse(unknown.stdout), { error: { code: 'soul-not-found', message: 'Soul not found.', action: null } });
  const help = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /soul secret <agentId\|name> set\|clear <name> \[--json\] \[--principal-stdin\]/);
  assertNoLeak(path.join(f.home, 'state'), 'state');
  // A provider on another harness is a warning, not a blocker, for the selected one.
  f.writeManifest((soul) => { soul.harnesses.claude = { provider: { id: 'anthropic', credential: 'anthropic-key' } }; soul.credentials.secrets['anthropic-key'] = { store: 'file' }; });
  const other = readSoulEnvironment(ID, { env: f.env, home: f.home, platform: 'linux' });
  assert.equal(other.readiness.problems.find((p) => p.code === 'provider-secret-missing').severity, 'warning');
  assert.deepEqual(other.launch.routing.env.includes('ANTHROPIC_API_KEY'), false);
});
