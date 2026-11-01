import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CredentialReconciliationError,
  inspectAppCredentials,
  inspectLocalAppCredential,
  reconcileAppCredentials,
} from '../credential-reconciler.mjs';
import {
  CredentialPreparationError,
  PROVIDER_SESSION_REQUIRED,
  appIdPath,
  classifyPassCliFailure,
  ensurePrivateKey,
  inspectProtonPassSession,
  privateKeyPath,
  recoverCredentialTransaction,
} from '../ensure-private-key.mjs';

import { readManagedAppCredential } from '../identity-app-store.mjs';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'agent-credential-roster-'));
}

function writeCredential(home, slug, issuer = '4376641', key = 'valid key') {
  mkdirSync(dirname(appIdPath(slug, home)), { recursive: true });
  writeFileSync(appIdPath(slug, home), `${issuer}\n`);
  writeFileSync(privateKeyPath(slug, home), key);
}

test('valid local credentials are preserved without contacting the provider', () => {
  const home = tempHome();
  writeCredential(home, 'ready-agent');
  const beforeId = readFileSync(appIdPath('ready-agent', home), 'utf8');
  const beforeKey = readFileSync(privateKeyPath('ready-agent', home), 'utf8');
  const result = ensurePrivateKey({
    slug: 'ready-agent',
    home,
    validateKey: (value) => value === 'valid key',
    provider: { restore: () => assert.fail('provider was contacted') },
  });
  assert.equal(result.localStatus, 'ready');
  assert.deepEqual(result.restored, []);
  assert.equal(readFileSync(appIdPath('ready-agent', home), 'utf8'), beforeId);
  assert.equal(readFileSync(privateKeyPath('ready-agent', home), 'utf8'), beforeKey);
});

test('read-only local inspection reports every component without repair', () => {
  const home = tempHome();
  const missing = inspectLocalAppCredential({
    slug: 'missing-agent',
    home,
    validateKey: () => true,
  });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.code, 'missing-issuer');
  assert.deepEqual(missing.evidence.components, [
    { component: 'app-id', status: 'missing' },
    { component: 'private-key', status: 'missing' },
  ]);

  writeCredential(home, 'malformed-agent', 'not-an-id', 'secret-private-key');
  const before = readFileSync(privateKeyPath('malformed-agent', home), 'utf8');
  const malformed = inspectLocalAppCredential({
    slug: 'malformed-agent',
    home,
    validateKey: () => false,
  });
  assert.equal(malformed.code, 'malformed-issuer');
  assert.equal(readFileSync(privateKeyPath('malformed-agent', home), 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(malformed), /secret-private-key/);
});

test('diagnostic roster inspection gates live verification and never repairs', async () => {
  const verified = [];
  const results = await inspectAppCredentials({
    slugs: ['ready-agent', 'broken-agent'],
    inspect: ({ slug }) => slug === 'ready-agent'
      ? { status: 'ready', evidence: { components: [] } }
      : { status: 'failed', code: 'missing-private-key', action: 'repair key', evidence: { components: [] } },
    inspectSession: () => ({ status: 'ready' }),
    verify: async (slug) => {
      verified.push(slug);
      return { token: 'secret-token', installation_id: 1, expires_at: 'later' };
    },
  });
  assert.deepEqual(verified, []);
  assert.deepEqual(results.map(({ slug }) => slug), ['broken-agent', 'ready-agent']);
  assert.ok(results.every(({ live }) => live.status === 'skipped'));
  assert.doesNotMatch(JSON.stringify(results), /secret-token/);
});

test('a fake provider repairs malformed files only after both replacements validate', () => {
  const home = tempHome();
  writeCredential(home, 'repair-agent', 'not-an-id', 'bad key');
  const destinations = [];
  const result = ensurePrivateKey({
    slug: 'repair-agent',
    home,
    validateKey: (value) => value === 'replacement key',
    provider: {
      restore: ({ issuerDestination, privateKeyDestination }) => {
        destinations.push(issuerDestination, privateKeyDestination);
        writeFileSync(issuerDestination, '4394024\n');
        writeFileSync(privateKeyDestination, 'replacement key');
      },
    },
  });
  assert.deepEqual(result.restored, ['app-id', 'private-key']);
  assert.ok(destinations.every((path) => path.endsWith('.tmp')));
  assert.equal(readManagedAppCredential('repair-agent', { home }).appId, '4394024');
  assert.equal(readFileSync(appIdPath('repair-agent', home), 'utf8'), 'not-an-id\n');
  assert.ok(readManagedAppCredential('repair-agent', { home }).privateKeyPem === 'replacement key');
  assert.equal(readFileSync(privateKeyPath('repair-agent', home), 'utf8'), 'bad key');
});

test('provider or validation failure leaves existing credential files untouched', () => {
  const home = tempHome();
  writeCredential(home, 'broken-agent', 'not-an-id', 'old malformed key');
  assert.throws(() => ensurePrivateKey({
    slug: 'broken-agent',
    home,
    validateKey: () => false,
    provider: {
      restore: ({ issuerDestination, privateKeyDestination }) => {
        writeFileSync(issuerDestination, 'still-bad\n');
        writeFileSync(privateKeyDestination, 'new key');
      },
    },
  }), /restored App ID\/client ID is malformed/);
  assert.equal(readFileSync(appIdPath('broken-agent', home), 'utf8'), 'not-an-id\n');
  assert.equal(readFileSync(privateKeyPath('broken-agent', home), 'utf8'), 'old malformed key');
});

test('a managed-store publication failure leaves legacy credential halves untouched', () => {
  const home = tempHome();
  const slug = 'rollback-agent';
  const issuer = appIdPath(slug, home);
  const key = privateKeyPath(slug, home);
  writeCredential(home, slug, 'not-an-id', 'old malformed key');
  assert.throws(() => ensurePrivateKey({
    slug,
    home,
    validateKey: (value) => value === 'new valid key',
    provider: {
      restore: ({ issuerDestination, privateKeyDestination }) => {
        writeFileSync(issuerDestination, '4394024\n');
        writeFileSync(privateKeyDestination, 'new valid key');
      },
    },
    stores: { file: { read: () => null, write: () => { throw new Error('simulated store publication failure'); } } },
  }), /credential provider could not restore/);
  assert.equal(readFileSync(issuer, 'utf8'), 'not-an-id\n');
  assert.equal(readFileSync(key, 'utf8'), 'old malformed key');
});

test('an interrupted legacy pair publication is preserved for owner inspection', () => {
  const home = tempHome();
  const slug = 'interrupted-agent';
  const directory = dirname(appIdPath(slug, home));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'app-id'), 'new-issuer\n');
  writeFileSync(join(directory, '.app-id.agent-bot-backup'), '4376641\n');
  writeFileSync(join(directory, '.private-key.pem.agent-bot-backup'), 'old key');
  writeFileSync(join(directory, '.agent-bot-credential-transaction.json'), JSON.stringify({
    version: 1,
    issuerExisted: true,
    keyExisted: true,
  }));
  assert.throws(() => recoverCredentialTransaction({ slug, directory }), { code: 'credential-transaction-pending' });
  assert.equal(readFileSync(appIdPath(slug, home), 'utf8'), 'new-issuer\n');
  assert.equal(readFileSync(join(directory, '.private-key.pem.agent-bot-backup'), 'utf8'), 'old key');
});

test('roster reconciliation is sorted, deduplicated, and skips all minting after a local failure', async () => {
  const prepared = [];
  const verified = [];
  let failure;
  try {
    await reconcileAppCredentials({
      slugs: ['z-agent', 'a-agent', 'z-agent'],
      prepare: ({ slug }) => {
        prepared.push(slug);
        if (slug === 'a-agent') {
          throw new CredentialPreparationError('missing-issuer', slug, 'operator action without secret-value');
        }
        return { localStatus: 'ready', restored: [] };
      },
      verify: async (slug) => {
        verified.push(slug);
        return { token: 'must-not-escape', installation_id: 1, expires_at: 'later' };
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof CredentialReconciliationError);
  assert.deepEqual(prepared, ['a-agent', 'z-agent']);
  assert.deepEqual(verified, []);
  assert.doesNotMatch(JSON.stringify(failure.results), /must-not-escape|secret-value/);
  assert.match(failure.message, /a-agent.*missing-issuer/);
});

test('invalid roster slugs fail without reflecting the supplied value', async () => {
  const unsafe = 'secret-shaped value';
  await assert.rejects(
    reconcileAppCredentials({ slugs: [unsafe] }),
    (error) => {
      assert.match(error.message, /invalid GitHub App slug/);
      assert.doesNotMatch(error.message, new RegExp(unsafe));
      return true;
    },
  );
});

test('live verification checks every prepared App and never stores returned tokens', async () => {
  const verified = [];
  const observed = [];
  const results = await reconcileAppCredentials({
    slugs: ['two-agent', 'one-agent'],
    prepare: ({ slug }) => ({ localStatus: slug === 'one-agent' ? 'restored' : 'ready', restored: [] }),
    verify: async (slug) => {
      verified.push(slug);
      return { token: `secret-${slug}`, installation_id: 42, expires_at: 'later' };
    },
    onVerified: (slug, grant) => observed.push([slug, grant.token]),
  });
  assert.deepEqual(verified, ['one-agent', 'two-agent']);
  assert.deepEqual(observed, [
    ['one-agent', 'secret-one-agent'],
    ['two-agent', 'secret-two-agent'],
  ]);
  assert.doesNotMatch(JSON.stringify(results), /secret-/);
  assert.deepEqual(results.map((result) => result.live.installationId), [42, 42]);
});

test('live mismatch is App-specific and secret-safe after every App is checked', async () => {
  const verified = [];
  await assert.rejects(
    reconcileAppCredentials({
      slugs: ['good-agent', 'bad-agent'],
      prepare: () => ({ localStatus: 'ready', restored: [] }),
      verify: async (slug) => {
        verified.push(slug);
        if (slug === 'bad-agent') throw new Error('401 token=secret-live-token');
        return { token: 'secret-good-token', installation_id: 7, expires_at: 'later' };
      },
    }),
    (error) => {
      assert.ok(error instanceof CredentialReconciliationError);
      assert.match(error.message, /bad-agent.*credential-mismatch/);
      assert.doesNotMatch(`${error.message}${JSON.stringify(error.results)}`, /secret-live-token|secret-good-token/);
      return true;
    },
  );
  assert.deepEqual(verified, ['bad-agent', 'good-agent']);
});

test('a locked secret store is classified as a store gate, not an item defect', () => {
  assert.equal(classifyPassCliFailure({
    stderr: 'Error: This operation requires an authenticated client\nthere is no session\n',
  }).code, PROVIDER_SESSION_REQUIRED);
  assert.equal(classifyPassCliFailure({
    stderr: 'Error: the session is locked; unlock the current session\n',
  }).code, 'provider-locked');
  assert.equal(classifyPassCliFailure({ code: 'ENOENT' }).code, 'provider-unavailable');
  assert.equal(inspectProtonPassSession({
    run: () => {
      throw Object.assign(new Error('pass-cli'), {
        stderr: 'Error: This operation requires an authenticated client',
      });
    },
  }).code, PROVIDER_SESSION_REQUIRED);
});

test('roster inspection names unlock when local files are missing and the store is locked', async () => {
  const results = await inspectAppCredentials({
    slugs: ['ready-agent', 'cursor-agent'],
    inspect: ({ slug }) => slug === 'ready-agent'
      ? { status: 'ready', evidence: { components: [] } }
      : {
        status: 'failed',
        code: 'missing-issuer',
        action: 'add the App ID/client ID to the provider item and retry',
        evidence: { components: [{ component: 'app-id', status: 'missing' }] },
      },
    inspectSession: () => ({ status: 'failed', code: PROVIDER_SESSION_REQUIRED }),
    verify: async () => assert.fail('live mint must not run'),
  });
  const cursor = results.find((result) => result.slug === 'cursor-agent');
  assert.equal(cursor.local.code, PROVIDER_SESSION_REQUIRED);
  assert.match(cursor.local.action, /pass-cli login/);
  assert.deepEqual(cursor.local.evidence.components, [{ component: 'app-id', status: 'missing' }]);
  assert.equal(results.find((result) => result.slug === 'ready-agent').local.status, 'ready');
});

test('a locked store stops roster reconciliation before later Apps are prepared', async () => {
  const prepared = [];
  await assert.rejects(
    reconcileAppCredentials({
      slugs: ['alpha-agent', 'beta-agent'],
      prepare: ({ slug }) => {
        prepared.push(slug);
        throw new CredentialPreparationError(
          PROVIDER_SESSION_REQUIRED,
          slug,
          'secret store is unavailable (provider-session-required)',
        );
      },
      verify: async () => assert.fail('live mint must not run'),
    }),
    (error) => {
      assert.ok(error instanceof CredentialReconciliationError);
      assert.match(error.message, /alpha-agent.*provider-session-required/);
      assert.match(error.message, /beta-agent.*provider-session-required/);
      assert.match(error.message, /pass-cli login/);
      assert.deepEqual(error.results.map((result) => result.slug), ['alpha-agent', 'beta-agent']);
      assert.equal(error.results[1].local.code, PROVIDER_SESSION_REQUIRED);
      return true;
    },
  );
  assert.deepEqual(prepared, ['alpha-agent']);
});

test('roster inspection keeps unreadable-file diagnostics when the store is locked', async () => {
  const results = await inspectAppCredentials({
    slugs: ['broken-agent', 'missing-agent'],
    inspect: ({ slug }) => slug === 'broken-agent'
      ? {
        status: 'failed',
        code: 'unreadable-issuer',
        action: 'repair permissions on the local app-id file and retry',
        evidence: { components: [{ component: 'app-id', status: 'unreadable' }] },
      }
      : {
        status: 'failed',
        code: 'missing-issuer',
        action: 'add the App ID/client ID to the provider item and retry',
        evidence: { components: [{ component: 'app-id', status: 'missing' }] },
      },
    inspectSession: () => ({ status: 'failed', code: PROVIDER_SESSION_REQUIRED }),
    verify: async () => assert.fail('live mint must not run'),
  });
  const broken = results.find((result) => result.slug === 'broken-agent');
  assert.equal(broken.local.code, 'unreadable-issuer');
  assert.match(broken.local.action, /permissions/);
  const missing = results.find((result) => result.slug === 'missing-agent');
  assert.equal(missing.local.code, PROVIDER_SESSION_REQUIRED);
  assert.match(missing.local.action, /pass-cli login/);
});

test('server-enrolled Apps without local key files are ready in ensurePrivateKey and inspectLocalAppCredential (#1316)', () => {
  const home = tempHome();
  const stateDir = join(home, 'server-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'device.json'), JSON.stringify({
    deviceId: 'dev_test',
    harnesses: ['trueline-cursor-agent'],
  }));
  const env = {
    HOME: home,
    AGENT_BOT_SERVER: 'https://agents.true-line.ai',
    AGENT_BOT_SERVER_STATE: stateDir,
    AGENT_BOT_CONFIG: join(home, 'config.json'),
  };
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({
    settings: { agentBotServer: 'https://agents.true-line.ai' },
  }));

  const prepared = ensurePrivateKey({
    slug: 'trueline-cursor-agent',
    home,
    env,
    provider: { restore: () => assert.fail('provider must not be contacted for server-enrolled App') },
  });
  assert.equal(prepared.localStatus, 'ready');
  assert.equal(prepared.downloaded, false);
  assert.deepEqual(prepared.restored, []);

  const inspected = inspectLocalAppCredential({
    slug: 'trueline-cursor-agent',
    home,
    env,
  });
  assert.equal(inspected.status, 'ready');
});

test('server-enrolled Apps verify through /api/daemon/harness-apps and cache botUid without minting (#1331)', async () => {
  const { BASE, fakeServer, sleep } = await import('./helpers/fake-identity-server.mjs');
  const { enroll } = await import('../identity/server-client.mjs');
  const { readAppMetadata } = await import('../identity/identity-app-store.mjs');
  const home = tempHome();
  const stateDir = join(home, 'server-state');
  const env = {
    HOME: home,
    AGENT_BOT_SERVER: BASE,
    AGENT_BOT_SERVER_STATE: stateDir,
    AGENT_BOT_CONFIG: join(home, 'config.json'),
  };
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({
    settings: { agentBotServer: BASE },
  }));
  const srv = fakeServer();
  srv.harnessApps = [
    { slug: 'qwts-grokbot-agent', app_id: 5502500, bot_user_id: 349048923, owner: 'qwts' },
  ];
  await enroll({ base: BASE, env, harnesses: ['qwts-grokbot-agent'], fetchImpl: srv.fetch, sleep });

  const verifiedTokens = [];
  const reconciled = await reconcileAppCredentials({
    slugs: ['qwts-grokbot-agent'],
    home,
    env,
    fetchImpl: srv.fetch,
    onVerified: (_slug, grant) => verifiedTokens.push(grant.token),
  });
  assert.equal(reconciled[0].local.status, 'ready');
  assert.equal(reconciled[0].live.status, 'server-registered');
  assert.equal(reconciled[0].live.code, 'server-registered');
  assert.equal(reconciled[0].live.appId, 5502500);
  assert.equal(reconciled[0].live.botUserId, 349048923);
  assert.equal(reconciled[0].live.installationId, undefined);
  assert.deepEqual(verifiedTokens, [], 'server verification does not pass a dummy token to onVerified');
  assert.equal(srv.minted ?? 0, 0, 'no installation token was minted');

  const meta = readAppMetadata('qwts-grokbot-agent', { home, env });
  assert.equal(meta.botUid, '349048923');
  assert.equal(meta.botAvatarUrl, 'https://avatars.githubusercontent.com/in/5502500?v=4');

  const inspected = await inspectAppCredentials({
    slugs: ['qwts-grokbot-agent'],
    home,
    env,
    fetchImpl: srv.fetch,
  });
  assert.equal(inspected[0].live.status, 'server-registered');
  assert.equal(inspected[0].live.code, 'server-registered');
});
