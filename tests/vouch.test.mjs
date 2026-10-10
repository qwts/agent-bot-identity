import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadOrCreateVouchKey,
  signSoulToken,
  verifySoulToken,
  vouchKeyPath,
  vouchStateDir,
} from '../vouch.mjs';
import { createWindowsAccountCustody, isWindowsSid } from '../windows-account-custody.mjs';

const AGENT_ID = 'agent_33333333-3333-4333-8333-333333333333';
const PARENT_ID = 'agent_22222222-2222-4222-8222-222222222222';
const DAEMON = fileURLToPath(new URL('../agent-daemon.mjs', import.meta.url));
const ISSUED_AT = new Date('2026-08-12T08:00:00.000Z');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-vouch-'));
  roots.push(root);
  return root;
}

function claims(overrides = {}) {
  return {
    account: 'ada',
    agentId: AGENT_ID,
    parent: PARENT_ID,
    ...overrides,
  };
}

test('the default vouch key path is the account state file (#254)', () => {
  assert.equal(
    vouchKeyPath(vouchStateDir({ env: {}, home: '/home/test' })),
    '/home/test/.local/state/agent-bot/vouch-key.pem',
  );
  assert.equal(
    vouchKeyPath(vouchStateDir({ env: { XDG_STATE_HOME: '/tmp/state' }, home: '/home/test' })),
    '/tmp/state/agent-bot/vouch-key.pem',
  );
});

test('loadOrCreateVouchKey writes one Ed25519 PKCS#8 key, mode 0600 (#254)', () => {
  const dir = scratchDir();
  const first = loadOrCreateVouchKey(dir);
  assert.equal(first.created, true);
  assert.equal(first.file, vouchKeyPath(dir));
  assert.equal(first.privateKey.asymmetricKeyType, 'ed25519');
  const pem = readFileSync(first.file, 'utf8');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  assert.match(pem, /-----END PRIVATE KEY-----\n$/);
  assert.equal(createPrivateKey(pem).asymmetricKeyType, 'ed25519');
  assert.match(first.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);

  chmodSync(first.file, 0o644);
  assert.equal(statSync(first.file).mode & 0o777, 0o644);
  const second = loadOrCreateVouchKey(dir);
  assert.equal(second.created, false);
  assert.equal(second.publicKeyPem, first.publicKeyPem);
  assert.equal(readFileSync(second.file, 'utf8'), pem);
  assert.equal(statSync(second.file).mode & 0o777, 0o600);
});

test('POSIX vouch key race loads the exclusive-create winner without replacing it', () => {
  const dir = scratchDir();
  const file = vouchKeyPath(dir);
  const { privateKey } = generateKeyPairSync('ed25519');
  const winnerPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  let raced = false;
  const writeKeyFile = (target, pem, options) => {
    if (!raced) {
      raced = true;
      writeFileSync(target, winnerPem, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    return writeFileSync(target, pem, options);
  };
  const loaded = loadOrCreateVouchKey(dir, { platform: 'linux', writeKeyFile });
  assert.equal(loaded.created, false);
  assert.equal(loaded.publicKeyPem, createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
  assert.equal(readFileSync(file, 'utf8'), winnerPem);
});

const WINDOWS_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const FOREIGN_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1002';

function fakeWindowsCustody({ sid = WINDOWS_SID, owners = new Map(), reparse = new Set(), malformed = null, failRestrict = false,
  foreignAllow = false, aclAnswer = null, failAcl = false, inspectFailure = null, env = process.env,
  failDirectoryCreate = false, directoryCreateAnswer = null, failPrivateFileCreate = false,
  privateFileCreateAnswer = null, racePrivateFilePem = null } = {}) {
  const calls = [];
  const unquote = (text) => text.replace(/''/g, "'");
  const run = (file, args, options = {}) => {
    calls.push({ file, args, input: options.input ?? null, env: options.env ?? null });
    if (file === 'whoami.exe') return { status: 0, stdout: `"DESK\\owner","${sid}"\r\n`, stderr: '' };
    if (file === 'icacls.exe') return { status: failRestrict ? 1 : 0, stdout: 'private path', stderr: 'private detail' };
    assert.equal(file, 'powershell.exe');
    if (options.input.includes('GetAccessRules')) {
      return { status: failAcl ? 1 : 0, stdout: aclAnswer ?? (foreignAllow ? 'refused' : 'owner-only'), stderr: 'private detail' };
    }
    const pathLiteral = /\$p = '((?:[^']|'')*)'/.exec(options.input)?.[1];
    if (options.input.includes('[System.IO.Directory]::CreateDirectory')) {
      if (directoryCreateAnswer !== null) return { status: failDirectoryCreate ? 1 : 0, stdout: directoryCreateAnswer, stderr: 'private detail' };
      if (failDirectoryCreate) return { status: 1, stdout: '', stderr: 'private detail' };
      assert.ok(pathLiteral, 'new directory path is passed as a quoted literal');
      const target = unquote(pathLiteral);
      try {
        if (statSync(target).isDirectory()) return { status: 0, stdout: 'existing', stderr: '' };
        return { status: 0, stdout: 'refused', stderr: 'private detail' };
      } catch {}
      mkdirSync(target, { recursive: true });
      owners.set(target, sid);
      return { status: 0, stdout: 'created', stderr: '' };
    }
    if (options.input.includes('[System.IO.FileStream]::new')) {
      if (privateFileCreateAnswer !== null) return { status: failPrivateFileCreate ? 1 : 0, stdout: privateFileCreateAnswer, stderr: 'private detail' };
      if (failPrivateFileCreate) return { status: 1, stdout: '', stderr: 'private detail' };
      assert.ok(pathLiteral, 'new private file path is passed as a quoted literal');
      const target = unquote(pathLiteral);
      if (racePrivateFilePem !== null) {
        writeFileSync(target, racePrivateFilePem, { encoding: 'utf8', flag: 'wx' });
        owners.set(target, sid);
        return { status: 0, stdout: 'exists', stderr: '' };
      }
      try {
        const fd = openSync(target, 'wx');
        closeSync(fd);
        owners.set(target, sid);
        return { status: 0, stdout: 'created', stderr: '' };
      } catch (error) {
        return { status: 0, stdout: error.code === 'EEXIST' ? 'exists' : 'refused', stderr: 'private detail' };
      }
    }
    if (inspectFailure !== null) return { status: 0, stdout: `failed|${inspectFailure}`, stderr: 'private detail' };
    if (malformed !== null) return { status: 0, stdout: malformed, stderr: '' };
    assert.ok(pathLiteral, 'Get-Acl path is passed as a quoted literal');
    const target = unquote(pathLiteral);
    let info;
    try { info = lstatSync(target); } catch { return { status: 0, stdout: 'missing', stderr: '' }; }
    const owner = owners.get(target) ?? sid;
    const kind = info.isDirectory() ? 'directory' : 'file';
    const link = reparse.has(target) || info.isSymbolicLink();
    return { status: 0, stdout: `${owner}|${kind}|${link ? 'link' : 'real'}\r\n`, stderr: '' };
  };
  return { custody: createWindowsAccountCustody({ run, env }), calls, owners, reparse };
}

test('Windows SID custody identifies one account and validates its strict SID form', () => {
  const { custody, calls } = fakeWindowsCustody();
  assert.equal(custody.currentSid(), WINDOWS_SID);
  assert.equal(custody.currentSid(), WINDOWS_SID);
  assert.equal(calls.length, 1, 'the account SID is resolved once per process');
  assert.ok(isWindowsSid(WINDOWS_SID));
  for (const invalid of ['S-1-5', 'S-1-5-abc', null, 1]) assert.equal(isWindowsSid(invalid), false);
});

test('Windows custody reports only a fixed inspection stage or a bounded refusal', () => {
  for (const stage of ['get-item', 'get-acl', 'get-owner', 'metadata']) {
    const { custody } = fakeWindowsCustody({ inspectFailure: stage });
    assert.throws(
      () => custody.assertOwnedDirectory('/private/path', WINDOWS_SID),
      (error) => {
        assert.equal(error.message, `Windows custody inspection failed at ${stage}`);
        assert.doesNotMatch(error.message, /private path|private detail|S-1-5/);
        return true;
      },
    );
  }

  const { custody } = fakeWindowsCustody({ malformed: 'private path; private detail; S-1-5-secret' });
  assert.throws(
    () => custody.assertOwnedDirectory('/private/path', WINDOWS_SID),
    (error) => {
      assert.equal(error.message, 'Windows custody returned an invalid ownership record');
      assert.doesNotMatch(error.message, /private path|private detail|S-1-5-secret/);
      return true;
    },
  );
});

test('Windows PowerShell child drops inherited PSModulePath variants without mutating caller env', () => {
  const callerEnv = {
    PSModulePath: 'C:\\pwsh7\\Modules',
    pSmOdUlEpAtH: 'C:\\second-pwsh7\\Modules',
    Path: 'C:\\Windows\\System32',
    KEEP_FOR_CHILD: 'preserved',
  };
  const originalEnv = { ...callerEnv };
  const dir = scratchDir();
  const { custody, calls } = fakeWindowsCustody({ env: callerEnv });
  loadOrCreateVouchKey(dir, { platform: 'win32', custody });

  const powershellCalls = calls.filter((call) => call.file === 'powershell.exe');
  assert.ok(powershellCalls.some((call) => call.input.includes('GetOwner(')), 'inspection invokes PowerShell');
  assert.ok(powershellCalls.some((call) => call.input.includes('GetAccessRules')), 'ACL verification invokes PowerShell');
  for (const call of powershellCalls) {
    assert.ok(call.env, 'PowerShell receives an explicit child environment');
    assert.equal(Object.keys(call.env).some((name) => name.toLowerCase() === 'psmodulepath'), false);
    assert.equal(call.env.Path, callerEnv.Path);
    assert.equal(call.env.KEEP_FOR_CHILD, 'preserved');
  }
  assert.deepEqual(callerEnv, originalEnv, 'the caller environment stays unchanged');
});

test('Windows directory creation secures only new paths and checks existing custody without rewriting ACLs', () => {
  const root = scratchDir();
  const newDirectory = path.join(root, 'state', 'agent-bot');
  const created = fakeWindowsCustody();
  created.custody.createOwnedDirectory(newDirectory, WINDOWS_SID);
  assert.equal(lstatSync(newDirectory).isDirectory(), true);
  assert.equal(created.owners.get(newDirectory), WINDOWS_SID);
  const creation = created.calls.find((call) => call.input?.includes('[System.IO.Directory]::CreateDirectory'));
  assert.ok(creation);
  assert.match(creation.input, /DirectorySecurity\]::new\(\)/);
  assert.match(creation.input, /SetOwner\(\$identity\)/);
  assert.match(creation.input, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(creation.input, /FileSystemAccessRule\]::new\(\$identity, .*FullControl/);
  assert.match(creation.input, /CreateDirectory\(\$p, \$security\)/);
  assert.equal(created.calls.some((call) => call.file === 'icacls.exe'), false);

  const existing = path.join(root, 'existing');
  mkdirSync(existing);
  const owners = new Map([[existing, WINDOWS_SID]]);
  const existingCustody = fakeWindowsCustody({ owners });
  existingCustody.custody.createOwnedDirectory(existing, WINDOWS_SID);
  assert.equal(owners.get(existing), WINDOWS_SID);
  assert.equal(existingCustody.calls.some((call) => call.file === 'icacls.exe'), false);
  assert.equal(existingCustody.calls.some((call) => call.input?.includes('Set-Acl')), false);

  const foreignDirectory = path.join(root, 'foreign');
  mkdirSync(foreignDirectory);
  const foreign = fakeWindowsCustody({ owners: new Map([[foreignDirectory, FOREIGN_SID]]) });
  assert.throws(() => foreign.custody.createOwnedDirectory(foreignDirectory, WINDOWS_SID), /owned by another account/);
});

test('Windows private file creation is exclusive, empty, SID-owned, and protected at creation', () => {
  const root = scratchDir();
  const file = path.join(root, 'vouch-key.pem');
  const { custody, calls, owners } = fakeWindowsCustody();
  custody.createPrivateFile(file, WINDOWS_SID);
  assert.equal(lstatSync(file).isFile(), true);
  assert.equal(statSync(file).size, 0);
  assert.equal(owners.get(file), WINDOWS_SID);
  const creation = calls.find((call) => call.input?.includes('[System.IO.FileStream]::new'));
  assert.ok(creation);
  assert.match(creation.input, /FileMode\]::CreateNew/);
  assert.match(creation.input, /FileSecurity\]::new\(\)/);
  assert.match(creation.input, /SetOwner\(\$identity\)/);
  assert.match(creation.input, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(creation.input, /FileSystemAccessRule\]::new\(\$identity, .*FullControl/);
  assert.match(creation.input, /FileShare\]::None/);
  assert.doesNotMatch(creation.input, /FileMode\]::Create,/);
  assert.match(creation.input, /\$depth -lt 8/);
  assert.match(creation.input, /\[System\.IO\.IOException\]/);
  assert.match(creation.input, /\$nativeCode -eq 80 -or \$nativeCode -eq 183/);

  writeFileSync(file, 'existing bytes');
  assert.throws(
    () => custody.createPrivateFile(file, WINDOWS_SID),
    (error) => error.code === 'EEXIST' && error.message === 'Windows private file already exists',
  );
  assert.equal(readFileSync(file, 'utf8'), 'existing bytes', 'exclusive collision never truncates the target');
});

test('Windows secure creation rejects malformed or unexpected fixed status markers', () => {
  const root = scratchDir();
  const directory = path.join(root, 'new-directory');
  const badDirectory = fakeWindowsCustody({ directoryCreateAnswer: 'private path and detail' });
  assert.throws(
    () => badDirectory.custody.createOwnedDirectory(directory, WINDOWS_SID),
    (error) => error.message === 'Windows custody directory could not be created safely'
      && !error.message.includes('private path'),
  );

  const file = path.join(root, 'new-file');
  const badFile = fakeWindowsCustody({ privateFileCreateAnswer: 'private path and detail' });
  assert.throws(
    () => badFile.custody.createPrivateFile(file, WINDOWS_SID),
    (error) => error.message === 'Windows private file could not be created safely'
      && !error.message.includes('private path'),
  );

  const deniedFile = fakeWindowsCustody({ privateFileCreateAnswer: 'refused' });
  assert.throws(
    () => deniedFile.custody.createPrivateFile(path.join(root, 'denied-file'), WINDOWS_SID),
    (error) => error.code !== 'EEXIST' && error.message === 'Windows private file could not be created safely',
  );
});

test('Windows vouch key preserves PKCS#8 bytes and identity, restricting the real file to its account', () => {
  const dir = scratchDir();
  const { custody, calls } = fakeWindowsCustody();
  const first = loadOrCreateVouchKey(dir, { platform: 'win32', custody });
  assert.equal(first.created, true);
  assert.equal(first.file, vouchKeyPath(dir));
  const pem = readFileSync(first.file, 'utf8');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(createPrivateKey(pem).asymmetricKeyType, 'ed25519');
  assert.equal(calls.filter((call) => call.file === 'icacls.exe').length, 0, 'new private ACL is set atomically at file creation');

  const second = loadOrCreateVouchKey(dir, { platform: 'win32', custody });
  assert.equal(second.created, false);
  assert.equal(second.publicKeyPem, first.publicKeyPem);
  assert.equal(readFileSync(second.file, 'utf8'), pem);
  assert.equal(calls.filter((call) => call.file === 'icacls.exe').length, 1, 'existing keys are verified through the compatibility path');
});

test('Windows vouch key adopts a raced exclusive-create winner without rotating it', () => {
  const dir = scratchDir();
  const file = vouchKeyPath(dir);
  const { privateKey } = generateKeyPairSync('ed25519');
  const winnerPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const { custody } = fakeWindowsCustody({ racePrivateFilePem: winnerPem });
  const loaded = loadOrCreateVouchKey(dir, { platform: 'win32', custody });
  assert.equal(loaded.created, false);
  assert.equal(loaded.publicKeyPem, createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
  assert.equal(readFileSync(file, 'utf8'), winnerPem);
});

test('Windows vouch key refuses a foreign or reparse-point file before reading it', () => {
  const dir = scratchDir();
  const file = vouchKeyPath(dir);
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(file, pem, { flag: 'wx' });

  const foreign = fakeWindowsCustody({ owners: new Map([[file, FOREIGN_SID]]) });
  assert.throws(() => loadOrCreateVouchKey(dir, { platform: 'win32', custody: foreign.custody }), /vouch key file custody or private access could not be verified/);

  const linked = fakeWindowsCustody({ reparse: new Set([file]) });
  assert.throws(() => loadOrCreateVouchKey(dir, { platform: 'win32', custody: linked.custody }), /vouch key file custody or private access could not be verified/);
  assert.equal(readFileSync(file, 'utf8'), pem, 'refusal leaves the existing file unchanged');
});

test('Windows vouch key refuses foreign, reparse, malformed, and unrestrictable custody', () => {
  const foreignDir = scratchDir();
  const foreign = fakeWindowsCustody({ owners: new Map([[foreignDir, FOREIGN_SID]]) });
  assert.throws(() => loadOrCreateVouchKey(foreignDir, { platform: 'win32', custody: foreign.custody }), /vouch key directory|Windows custody directory/);

  const linkedDir = scratchDir();
  const realDir = path.join(linkedDir, 'real');
  const aliasDir = path.join(linkedDir, 'alias');
  mkdirSync(realDir);
  symlinkSync(realDir, aliasDir);
  const linked = fakeWindowsCustody();
  assert.throws(() => loadOrCreateVouchKey(aliasDir, { platform: 'win32', custody: linked.custody }), /real directory/);

  const malformedDir = scratchDir();
  const malformed = fakeWindowsCustody({ malformed: 'owner|directory|real' });
  assert.throws(() => loadOrCreateVouchKey(malformedDir, { platform: 'win32', custody: malformed.custody }), /invalid ownership record/);

  const restrictedDir = scratchDir();
  const restrictedFile = vouchKeyPath(restrictedDir);
  const { privateKey: existingPrivateKey } = generateKeyPairSync('ed25519');
  const existingPem = existingPrivateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(restrictedFile, existingPem, { flag: 'wx' });
  const failRestrict = fakeWindowsCustody({ failRestrict: true });
  assert.throws(
    () => loadOrCreateVouchKey(restrictedDir, { platform: 'win32', custody: failRestrict.custody }),
    /vouch key file custody or private access could not be verified/,
  );
  assert.equal(readFileSync(restrictedFile, 'utf8'), existingPem, 'failed compatibility restriction never changes existing key bytes');

  const foreignAclDir = scratchDir();
  const foreignAcl = fakeWindowsCustody({ foreignAllow: true });
  assert.throws(() => loadOrCreateVouchKey(foreignAclDir, { platform: 'win32', custody: foreignAcl.custody }), /Windows private-file access could not be verified/);
  assert.equal(statSync(vouchKeyPath(foreignAclDir)).size, 0, 'a foreign allow ACE prevents private bytes from being written');

  for (const failure of [{ aclAnswer: '' }, { failAcl: true }]) {
    const aclFailureDir = scratchDir();
    const aclFailure = fakeWindowsCustody(failure);
    assert.throws(
      () => loadOrCreateVouchKey(aclFailureDir, { platform: 'win32', custody: aclFailure.custody }),
      (error) => {
        assert.match(error.message, /Windows private-file access could not be verified/);
        assert.doesNotMatch(error.message, /private detail|BEGIN PRIVATE KEY/);
        return true;
      },
    );
    assert.equal(statSync(vouchKeyPath(aclFailureDir)).size, 0, 'missing or failed ACL data prevents private bytes from being written');
  }
});

test('a corrupt vouch key is not replaced (#254)', () => {
  const dir = scratchDir();
  const file = vouchKeyPath(dir);
  writeFileSync(file, 'not a key\n', { mode: 0o600 });
  assert.throws(() => loadOrCreateVouchKey(dir), /Ed25519 PKCS#8/);
  assert.equal(readFileSync(file, 'utf8'), 'not a key\n');
});

test('signSoulToken builds a v1 token node:crypto verifies against the SPKI key (#254)', () => {
  const dir = scratchDir();
  const key = loadOrCreateVouchKey(dir);
  const token = signSoulToken(claims(), key, () => ISSUED_AT);
  const again = signSoulToken(claims({ parent: null }), key.privateKey, ISSUED_AT);
  const [version, payloadSegment, signatureSegment] = token.split('.');
  assert.equal(version, 'v1');
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload), ['v', 'aud', 'account', 'agentId', 'parent', 'iat', 'exp', 'nonce']);
  assert.equal(payload.aud, 'agent-comms');
  assert.equal(payload.account, 'ada');
  assert.equal(payload.agentId, AGENT_ID);
  assert.equal(payload.parent, PARENT_ID);
  assert.equal(payload.exp - payload.iat, 300);
  assert.equal(payload.iat, Math.floor(ISSUED_AT.getTime() / 1000));
  assert.equal(Buffer.from(payload.nonce, 'base64url').length, 16);
  assert.notEqual(token.split('.')[1], again.split('.')[1]);

  const publicKey = createPublicKey(key.publicKeyPem);
  const signature = Buffer.from(signatureSegment, 'base64url');
  assert.equal(verify(null, Buffer.from(payloadSegment), publicKey, signature), true);
  assert.equal(verify(null, Buffer.from(`v1.${payloadSegment}`), publicKey, signature), false);
  assert.deepEqual(verifySoulToken(token, key.publicKeyPem, () => ISSUED_AT), payload);
  assert.equal(verifySoulToken(again, key, () => ISSUED_AT).parent, null);

  const expMs = ISSUED_AT.getTime() + 300_000;
  assert.ok(verifySoulToken(token, publicKey, () => new Date(expMs - 1000)));
  assert.equal(verifySoulToken(token, publicKey, () => new Date(expMs)), null);
});

function craft(payload, privateKey) {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(segment), privateKey);
  return `v1.${segment}.${Buffer.from(signature).toString('base64url')}`;
}

test('verifySoulToken rejects a bad signature, a long lifetime, and expiry (#254)', () => {
  const key = loadOrCreateVouchKey(scratchDir());
  const iat = Math.floor(ISSUED_AT.getTime() / 1000);
  const minted = JSON.parse(Buffer.from(
    signSoulToken(claims(), key, () => ISSUED_AT).split('.')[1],
    'base64url',
  ).toString('utf8'));
  const payload = {
    v: 1,
    aud: 'agent-comms',
    account: 'ada',
    agentId: AGENT_ID,
    parent: null,
    iat,
    exp: iat + 300,
    nonce: minted.nonce,
  };
  const token = craft(payload, key.privateKey);
  assert.equal(verifySoulToken(token, key.publicKey, () => ISSUED_AT).account, 'ada');

  const longer = craft({ ...payload, exp: iat + 301 }, key.privateKey);
  assert.equal(verifySoulToken(longer, key.publicKey, () => ISSUED_AT), null);
  const shorter = craft({ ...payload, exp: iat + 299 }, key.privateKey);
  assert.equal(verifySoulToken(shorter, key.publicKey, () => ISSUED_AT).exp, iat + 299);
  const wrongAud = craft({ ...payload, aud: 'other' }, key.privateKey);
  assert.equal(verifySoulToken(wrongAud, key.publicKey, () => ISSUED_AT), null);

  const [version, segment, signatureSegment] = token.split('.');
  const flipped = `${version}.${segment.slice(0, -1)}${segment.endsWith('A') ? 'B' : 'A'}.${signatureSegment}`;
  assert.equal(verifySoulToken(flipped, key.publicKey, () => ISSUED_AT), null);
  const wrongBytes = sign(null, Buffer.from(`v1.${segment}`), key.privateKey);
  const prefixed = `${version}.${segment}.${Buffer.from(wrongBytes).toString('base64url')}`;
  assert.equal(verifySoulToken(prefixed, key.publicKey, () => ISSUED_AT), null);
  assert.equal(verifySoulToken('nope', key.publicKey, () => ISSUED_AT), null);
  assert.equal(verifySoulToken(token, 'not-a-key', () => ISSUED_AT), null);
});

test('daemon vouch-key prints the SPKI public key and creates it once (#254)', () => {
  const root = scratchDir();
  const env = {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: path.join(root, 'state'),
  };
  delete env.AGENT_BOT_DAEMON_STATE_PATH;
  const run = () => spawnSync(process.execPath, [DAEMON, 'vouch-key'], { encoding: 'utf8', env });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(first.stdout, /-----END PUBLIC KEY-----\n$/);
  assert.doesNotMatch(first.stdout, /PRIVATE KEY/);
  const file = vouchKeyPath(vouchStateDir({ env, home: root }));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const pem = readFileSync(file, 'utf8');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(readFileSync(file, 'utf8'), pem);

  const token = signSoulToken(claims(), loadOrCreateVouchKey(vouchStateDir({ env, home: root })), () => ISSUED_AT);
  const [, payloadSegment, signatureSegment] = token.split('.');
  assert.equal(
    verify(null, Buffer.from(payloadSegment), createPublicKey(first.stdout), Buffer.from(signatureSegment, 'base64url')),
    true,
  );

  const extra = spawnSync(process.execPath, [DAEMON, 'vouch-key', '--json'], { encoding: 'utf8', env });
  assert.equal(extra.status, 0, extra.stderr);
  assert.equal(extra.stdout, first.stdout);
  const rejected = spawnSync(process.execPath, [DAEMON, 'vouch-key', 'extra'], { encoding: 'utf8', env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /usage: agent-bot daemon vouch-key/);
});

test('a symlinked vouch key is refused, not read or chmodded through', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vouch-link-'));
  try {
    const real = path.join(dir, 'elsewhere.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(real, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o644 });
    symlinkSync(real, vouchKeyPath(dir));
    assert.throws(() => loadOrCreateVouchKey(dir), /not a regular file owned by this account/);
    assert.equal(statSync(real).mode & 0o777, 0o644);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
