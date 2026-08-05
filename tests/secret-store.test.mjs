import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  SecretStoreError,
  createSecretProviderRegistry,
  getSecret,
  selectSecretField,
} from '../secret-store.mjs';
import {
  createProtonPassAdapter,
  protonPassAdapter,
} from '../secret-providers/proton-pass.mjs';
import {
  BUILTIN_SECRET_PROVIDERS,
  parseSecretArgs,
  secretHelpText,
} from '../secret.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

function provider(fields, { id = 'test-store' } = {}) {
  return { id, readFields: () => fields };
}

function currentView({
  title = 'anthropic',
  password = 'login-password',
  extraFields = [{ name: 'API Key', content: { Hidden: 'api-secret' } }],
  typed = null,
} = {}) {
  return {
    item: {
      id: 'item-1',
      share_id: 'share-1',
      vault_id: 'vault-1',
      content: {
        title,
        note: '',
        item_uuid: 'uuid-1',
        content: typed ?? { Login: { email: '', username: '', password, urls: [], totp_uri: '', passkeys: [] } },
        extra_fields: extraFields,
      },
      state: 'Active',
      flags: [],
    },
    attachments: [],
  };
}

function fixtureRun({
  collection = 'Agent Identities',
  item = 'anthropic',
  view = currentView({ title: item }),
  vaults = null,
  items = null,
} = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'vault') {
      return JSON.stringify({
        vaults: vaults ?? [{ name: collection, vault_id: 'vault-1', share_id: 'share-1' }],
      });
    }
    if (args[0] === 'item' && args[1] === 'list') {
      return JSON.stringify({
        items: items ?? [{ id: 'item-1', share_id: 'share-1', title: item, state: 'Active' }],
      });
    }
    if (args[0] === 'item' && args[1] === 'view') return JSON.stringify(view);
    throw new Error('unexpected fixture invocation');
  };
  return { run, calls };
}

test('built-in adapters satisfy the static registry contract', () => {
  assert.deepEqual(BUILTIN_SECRET_PROVIDERS, [protonPassAdapter]);
  const registry = createSecretProviderRegistry(BUILTIN_SECRET_PROVIDERS);
  assert.deepEqual([...registry.keys()], ['proton-pass']);
  assert.throws(
    () => createSecretProviderRegistry([provider([], { id: 'same' }), provider([], { id: 'same' })]),
    /duplicate secret provider/u,
  );
  assert.throws(() => createSecretProviderRegistry([{ id: 'missing-method' }]), /readFields/u);
  assert.throws(() => createSecretProviderRegistry([{ id: 'Bad ID', readFields() {} }]), /invalid id/u);
});

test('field lookup is exact and case-insensitive without normalizing secret values', () => {
  const value = '  line one\nline two  ';
  const fields = [{ name: 'API Key', path: 'API Key', value }];
  assert.equal(selectSecretField(fields, 'api key'), value);
  assert.equal(selectSecretField(fields, ' API KEY '), value);
  assert.throws(() => selectSecretField(fields, 'api_key'), /not found/u);
  assert.throws(() => selectSecretField([{ name: 'Empty', value: '' }], 'empty'), /empty/u);
});

test('unqualified duplicate labels fail while a qualified field remains selectable', () => {
  const fields = [
    { name: 'password', path: 'Staging.password', value: 'staging' },
    { name: 'password', path: 'Production.password', value: 'production' },
  ];
  assert.throws(() => selectSecretField(fields, 'password'), /ambiguous/u);
  assert.equal(selectSecretField(fields, 'production.PASSWORD'), 'production');
});

test('getSecret requires an explicit provider and never falls back', () => {
  let fallbackCalls = 0;
  const registry = createSecretProviderRegistry([
    { id: 'requested', readFields: () => { throw new SecretStoreError('requested failed'); } },
    { id: 'fallback', readFields: () => { fallbackCalls += 1; return [{ name: 'password', value: 'no' }]; } },
  ]);
  assert.throws(() => getSecret({
    provider: 'requested', collection: 'vault', item: 'item', field: 'password',
  }, { registry }), /requested failed/u);
  assert.equal(fallbackCalls, 0);
  assert.throws(() => getSecret({
    provider: 'unknown', collection: 'vault', item: 'item', field: 'password',
  }, { registry }), /unsupported secret provider/u);
  assert.throws(() => getSecret({
    provider: 'requested', collection: 'bad\nname', item: 'item', field: 'password',
  }, { registry }), /control character/u);
});

test('secret CLI parser requires one value for every supported selector', () => {
  assert.deepEqual(parseSecretArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseSecretArgs(['get', '--help']), { kind: 'help' });
  assert.deepEqual(parseSecretArgs([
    'get', '--provider', 'proton-pass', '--collection', 'Agent Identities',
    '--item', 'anthropic', '--field', 'api key',
  ]), {
    kind: 'get', provider: 'proton-pass', collection: 'Agent Identities', item: 'anthropic', field: 'api key',
  });
  assert.throws(() => parseSecretArgs(['get', '--provider']), /requires a value/u);
  assert.throws(() => parseSecretArgs(['get', '--provider', 'a', '--provider', 'b']), /duplicate option/u);
  assert.throws(() => parseSecretArgs(['get', '--vendor', 'proton']), /unknown option/u);
  assert.throws(() => parseSecretArgs(['read']), /unsupported secret operation/u);
  assert.throws(
    () => parseSecretArgs(['get', 'accidental-secret-marker']),
    (error) => !error.message.includes('accidental-secret-marker'),
  );
  assert.match(secretHelpText(), /without a trailing newline/u);
});

test('Proton adapter resolves unique IDs and passes hostile-looking names as inert argv', () => {
  const collection = '$(touch nope); "Agent Vault"';
  const item = '; rm -rf nope';
  const { run, calls } = fixtureRun({ collection, item, view: currentView({ title: item }) });
  const adapter = createProtonPassAdapter({ run });
  const fields = adapter.readFields({ collection, item });
  assert.deepEqual(calls, [
    ['vault', 'list', '--output', 'json'],
    ['item', 'list', '--share-id', 'share-1', '--filter-state', 'active', '--output', 'json'],
    ['item', 'view', '--share-id', 'share-1', '--item-id', 'item-1', '--output', 'json'],
  ]);
  assert.equal(selectSecretField(fields, 'password'), 'login-password');
  assert.equal(selectSecretField(fields, 'api key'), 'api-secret');
});

test('Proton adapter normalizes current and legacy custom field shapes', () => {
  const current = currentView({
    password: '',
    extraFields: [{ name: 'Top Level', content: { Text: '  top  ' } }],
    typed: {
      Custom: {
        sections: [{
          section_name: 'Production',
          section_fields: [{ name: 'API Key', content: { Hidden: '  current-secret\n' } }],
        }],
      },
    },
  });
  const currentFixture = fixtureRun({ view: current });
  const currentFields = createProtonPassAdapter({ run: currentFixture.run })
    .readFields({ collection: 'Agent Identities', item: 'anthropic' });
  assert.equal(selectSecretField(currentFields, 'Production.API Key'), '  current-secret\n');
  assert.equal(selectSecretField(currentFields, 'top level'), '  top  ');

  const legacy = {
    item: {
      id: 'item-1',
      share_id: 'share-1',
      content: {
        title: 'anthropic',
        content: {
          Custom: {
            sections: [{
              section_name: 'Production',
              fields: [
                { field_name: 'API Key', field_type: 'hidden', value: { text: 'legacy-secret' } },
                { field_name: 'TOTP', field_type: 'totp', value: 'otpauth://secret' },
              ],
            }],
          },
        },
        extra_fields: [{ field_name: 'Backup Key', value: { content: 'backup-secret' } }],
      },
    },
  };
  const legacyFixture = fixtureRun({ view: legacy });
  const legacyFields = createProtonPassAdapter({ run: legacyFixture.run })
    .readFields({ collection: 'Agent Identities', item: 'anthropic' });
  assert.equal(selectSecretField(legacyFields, 'production.api key'), 'legacy-secret');
  assert.equal(selectSecretField(legacyFields, 'backup key'), 'backup-secret');
  assert.throws(() => selectSecretField(legacyFields, 'totp'), /not found/u);
});

test('Proton adapter refuses ambiguous collections and items', () => {
  const duplicateVaults = fixtureRun({
    vaults: [
      { name: 'Agent Identities', share_id: 'share-1' },
      { name: 'Agent Identities', share_id: 'share-2' },
    ],
  });
  assert.throws(
    () => createProtonPassAdapter({ run: duplicateVaults.run })
      .readFields({ collection: 'Agent Identities', item: 'anthropic' }),
    /collection name is ambiguous/u,
  );

  const duplicateItems = fixtureRun({
    items: [
      { id: 'item-1', title: 'anthropic' },
      { id: 'item-2', title: 'anthropic' },
    ],
  });
  assert.throws(
    () => createProtonPassAdapter({ run: duplicateItems.run })
      .readFields({ collection: 'Agent Identities', item: 'anthropic' }),
    /item name is ambiguous/u,
  );
});

test('Proton adapter redacts provider failures and malformed responses', () => {
  const marker = 'provider-secret-marker';
  const adapter = createProtonPassAdapter({ run: () => { throw new Error(marker); } });
  assert.throws(
    () => adapter.readFields({ collection: 'Agent Identities', item: 'anthropic' }),
    (error) => error.message === 'proton-pass request failed' && !error.message.includes(marker),
  );
  const malformed = createProtonPassAdapter({ run: () => marker });
  assert.throws(
    () => malformed.readFields({ collection: 'Agent Identities', item: 'anthropic' }),
    (error) => /malformed JSON/u.test(error.message) && !error.message.includes(marker),
  );
  const unavailable = createProtonPassAdapter({ executable: '/definitely/missing/pass-cli' });
  assert.throws(
    () => unavailable.readFields({ collection: 'Agent Identities', item: 'anthropic' }),
    /pass-cli was not found/u,
  );
});

test('spawned provider failures and timeouts never expose child output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-secret-provider-'));
  const failed = join(dir, 'pass-cli-failed');
  const marker = 'child-secret-marker';
  writeFileSync(failed, `#!/usr/bin/env node\nprocess.stdout.write('${marker}');\nprocess.stderr.write('${marker}');\nprocess.exit(1);\n`);
  chmodSync(failed, 0o755);
  const failedAdapter = createProtonPassAdapter({ executable: failed });
  assert.throws(
    () => failedAdapter.readFields({ collection: 'Agent Identities', item: 'anthropic' }),
    (error) => error.message === 'proton-pass request failed' && !error.message.includes(marker),
  );

  const hanging = join(dir, 'pass-cli-hanging');
  writeFileSync(hanging, '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n');
  chmodSync(hanging, 0o755);
  const hangingAdapter = createProtonPassAdapter({ executable: hanging, timeoutMs: 20 });
  assert.throws(
    () => hangingAdapter.readFields({ collection: 'Agent Identities', item: 'anthropic' }),
    /timed out/u,
  );
});

test('stable CLI writes only the exact secret and does not persist retrieval state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-secret-cli-'));
  const fakeBin = join(dir, 'bin');
  const home = join(dir, 'home');
  const state = join(dir, 'state');
  const cwd = join(dir, 'worktree');
  mkdirSync(fakeBin);
  mkdirSync(home);
  mkdirSync(state);
  mkdirSync(cwd);
  const fake = join(fakeBin, 'pass-cli');
  const vaults = { vaults: [{ name: 'Agent Identities', vault_id: 'vault-1', share_id: 'share-1' }] };
  const items = { items: [{ id: 'item-1', share_id: 'share-1', title: 'anthropic', state: 'Active' }] };
  const view = currentView({ extraFields: [{ name: 'API Key', content: { Hidden: '  exact\nvalue  ' } }] });
  writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.PASS_CLI_FAIL === '1') {
  process.stdout.write('child-secret-marker');
  process.stderr.write('child-secret-marker');
  process.exit(1);
}
if (args[0] === 'vault') process.stdout.write(${JSON.stringify(JSON.stringify(vaults))});
else if (args[0] === 'item' && args[1] === 'list') process.stdout.write(${JSON.stringify(JSON.stringify(items))});
else if (args[0] === 'item' && args[1] === 'view') process.stdout.write(${JSON.stringify(JSON.stringify(view))});
else process.exit(2);
`);
  chmodSync(fake, 0o755);
  const env = {
    ...process.env,
    AGENT_BOT_STATE_HOME: state,
    HOME: home,
    PATH: `${fakeBin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  };
  const success = spawnSync(process.execPath, [
    CLI, 'secret', 'get', '--provider', 'proton-pass', '--collection', 'Agent Identities',
    '--item', 'anthropic', '--field', 'api key',
  ], { cwd, encoding: 'utf8', env });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, '  exact\nvalue  ');
  assert.equal(success.stderr, '');
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(readdirSync(state), []);
  assert.deepEqual(readdirSync(cwd), []);

  const failure = spawnSync(process.execPath, [
    CLI, 'secret', 'get', '--provider', 'proton-pass', '--collection', 'Agent Identities',
    '--item', 'anthropic', '--field', 'api key',
  ], { cwd, encoding: 'utf8', env: { ...env, PASS_CLI_FAIL: '1' } });
  assert.notEqual(failure.status, 0);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /^secret: proton-pass request failed\n$/u);
  assert.doesNotMatch(failure.stderr, /child-secret-marker/u);
});
