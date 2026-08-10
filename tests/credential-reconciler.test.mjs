import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CredentialReconciliationError,
  reconcileAppCredentials,
} from '../credential-reconciler.mjs';
import {
  CredentialPreparationError,
  appIdPath,
  ensurePrivateKey,
  privateKeyPath,
  recoverCredentialTransaction,
} from '../ensure-private-key.mjs';

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
  assert.equal(readFileSync(appIdPath('repair-agent', home), 'utf8'), '4394024\n');
  assert.equal(readFileSync(privateKeyPath('repair-agent', home), 'utf8'), 'replacement key');
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

test('a second publication rename failure rolls both credential halves back', () => {
  const home = tempHome();
  const slug = 'rollback-agent';
  const issuer = appIdPath(slug, home);
  const key = privateKeyPath(slug, home);
  writeCredential(home, slug, 'not-an-id', 'old malformed key');
  let failKeyPublication = true;
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
    rename: (source, destination) => {
      if (failKeyPublication && destination === key && source.endsWith('.tmp')) {
        failKeyPublication = false;
        throw new Error('simulated second publication failure');
      }
      renameSync(source, destination);
    },
  }), /credential provider could not restore/);
  assert.equal(readFileSync(issuer, 'utf8'), 'not-an-id\n');
  assert.equal(readFileSync(key, 'utf8'), 'old malformed key');
});

test('the next reconciliation recovers a process interrupted between pair renames', () => {
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
  assert.equal(recoverCredentialTransaction({ slug, directory }), true);
  assert.equal(readFileSync(appIdPath(slug, home), 'utf8'), '4376641\n');
  assert.equal(readFileSync(privateKeyPath(slug, home), 'utf8'), 'old key');
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
