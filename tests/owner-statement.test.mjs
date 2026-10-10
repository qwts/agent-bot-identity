import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_INPUT_BYTES, MAX_OWNER_KEYS, SSHSIG_NAMESPACE, STATEMENT_AUDIENCE, armorStatement, encodePayload, ed25519KeyLine, extractToken,
  ownerCommand, ownerKeysPath, parseSshPublicKey, readOwnerKeys, readStatementFile, sshFingerprint, verifyStatement, writeOwnerKeys,
} from '../owner-statement.mjs';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'agent-bot.mjs');
const NOW = Date.parse('2026-10-09T22:00:00Z');
const SECONDS = Math.floor(NOW / 1000);
const NONCE = 'abcdefghijklmnopqrstuvwx';
const SCOPE = { repo: 'qwts/agent-bot-identity', number: 753 };
const HAS_SSH_KEYGEN = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-statement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { HOME: dir } };
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const str = (value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([u32(b.length), b]); };

function rawEd25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, raw: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url') };
}

// A FIDO sk-ssh-ed25519 key, signing the way OpenSSH's ssh-sk does
// (PROTOCOL.u2f): Ed25519 over sha256(application) || flags || counter ||
// sha256(SSHSIG signed data).
function securityKey({ application = 'ssh:' } = {}) {
  const { privateKey, raw } = rawEd25519();
  const type = 'sk-ssh-ed25519@openssh.com';
  const blob = Buffer.concat([str(type), str(raw), str(application)]);
  const sshsig = (message, { flags = 0x01, namespace = SSHSIG_NAMESPACE, hash = 'sha512' } = {}) => {
    const signed = Buffer.concat([Buffer.from('SSHSIG'), str(namespace), str(''), str(hash), str(createHash(hash).update(message).digest())]);
    const counter = u32(7);
    const data = Buffer.concat([createHash('sha256').update(application).digest(), Buffer.from([flags]), counter, createHash('sha256').update(signed).digest()]);
    const signature = Buffer.concat([str(type), str(sign(null, data, privateKey)), Buffer.from([flags]), counter]);
    return Buffer.concat([Buffer.from('SSHSIG'), u32(1), str(blob), str(namespace), str(''), str(hash), str(signature)]);
  };
  return { line: `${type} ${blob.toString('base64')}`, fingerprint: sshFingerprint(blob), sshsig };
}

// keyd's statement key: raw Ed25519 over the payload segment.
function keydKey() {
  const { privateKey, raw } = rawEd25519();
  const line = ed25519KeyLine(raw.toString('base64'));
  return { line, fingerprint: sshFingerprint(parseSshPublicKey(line).blob), sign: (segment) => sign(null, Buffer.from(segment), privateKey) };
}

const pinFor = (key, { name = 'yubikey', store = 'ssh', verifyRequired = false } = {}) => ({
  name, store, alg: store === 'keyd' ? 'ed25519' : 'sshsig', publicKey: key.line, fingerprint: key.fingerprint,
  verifyRequired, softwareKey: false, pinnedAt: '2026-10-09T21:00:00.000Z',
});

const payloadFor = (key, overrides = {}) => ({ v: 1, aud: STATEMENT_AUDIENCE, kind: 'statement', alg: 'sshsig', key: key.fingerprint,
  text: 'Ship the owner sign slice.', scope: SCOPE, action: null, nonce: NONCE, iat: SECONDS, exp: SECONDS + 7 * 86_400, ...overrides });

function skToken(key, overrides = {}, options = {}) {
  const segment = encodePayload(payloadFor(key, overrides));
  return `s1.${segment}.${key.sshsig(Buffer.from(segment), options).toString('base64url')}`;
}

// Bypasses encodePayload's checks, to hand the verifier what a forger would.
function rawToken(key, payload, options = {}) {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `s1.${segment}.${key.sshsig(Buffer.from(segment), options).toString('base64url')}`;
}

test('a security-key statement verifies for its pin, scope and lifetime', () => {
  const key = securityKey();
  const block = armorStatement(skToken(key));
  const { payload, pin } = verifyStatement(`Owner said:\n\n${block}\nthanks`, { keys: [pinFor(key)], now: NOW, repo: 'QWTS/agent-bot-identity', issue: 753 });
  assert.equal(payload.text, 'Ship the owner sign slice.');
  assert.equal(pin.name, 'yubikey');
});

test('the verifier refuses forgeries, other keys, expiry and other scopes', () => {
  const key = securityKey();
  const keys = [pinFor(key)];
  const code = (input, options = {}) => {
    try { verifyStatement(input, { keys, now: NOW, ...options }); } catch (error) { return error.code; }
    return 'verified';
  };
  const token = skToken(key);
  const [, segment, signature] = token.split('.');
  const edited = Buffer.from(JSON.stringify({ ...payloadFor(key), text: 'Delete every soul.' })).toString('base64url');
  assert.equal(code(`s1.${edited}.${signature}`), 'statement-invalid');
  assert.equal(code(skToken(securityKey())), 'statement-unknown-key');
  assert.equal(code(token, { now: NOW + 8 * 86_400_000 }), 'statement-expired');
  assert.equal(code(token, { repo: 'qwts/agent-bot-identity', issue: 754 }), 'statement-scope-mismatch');
  assert.equal(code(token, { repo: 'qwts/other', issue: 753 }), 'statement-scope-mismatch');
  assert.equal(code(`${armorStatement(token)}${armorStatement(token)}`), 'statement-invalid');
  assert.equal(code('the owner approved this'), 'statement-invalid');
  assert.equal(code(`s1.${segment}.${signature}x`), 'statement-invalid');
  // Each rule of the payload, signed by the pinned key so only the rule refuses.
  for (const overrides of [
    { extra: true }, { v: 2 }, { aud: 'agent-bot-owner' }, { kind: 'presence' }, { alg: 'ed25519' },
    { text: 'ok\u202edecided' }, { text: 'two\nlines' }, { text: 'x'.repeat(501) }, { text: ' ' },
    { scope: { repo: 'qwts/agent-bot-identity' } }, { scope: { ...SCOPE, host: 'mac' } }, { scope: { repo: 'nope', number: 1 } },
    { action: 'a'.repeat(64) }, { nonce: 'short' }, { exp: SECONDS + 31 * 86_400 }, { exp: SECONDS },
    { iat: SECONDS + 3600, exp: SECONDS + 7200 },
    { kind: 'challenge', scope: SCOPE, action: 'a'.repeat(64), exp: SECONDS + 600 },
    { kind: 'challenge', scope: { host: 'mac' }, action: 'a'.repeat(64), exp: SECONDS + 3600 },
  ]) assert.equal(code(rawToken(key, payloadFor(key, overrides))), 'statement-invalid', JSON.stringify(overrides));
  assert.equal(code(rawToken(key, payloadFor(key, { kind: 'challenge', scope: { host: 'mac' }, action: 'a'.repeat(64), exp: SECONDS + 600 }))), 'verified');
});

test('a security-key signature needs the presence flag, and verification when pinned so', () => {
  const key = securityKey();
  const code = (pin, options) => {
    try { verifyStatement(skToken(key, {}, options), { keys: [pin], now: NOW }); } catch (error) { return error.message; }
    return 'verified';
  };
  assert.match(code(pinFor(key), { flags: 0x00 }), /user-presence/);
  assert.match(code(pinFor(key, { verifyRequired: true }), { flags: 0x01 }), /user-verified/);
  assert.equal(code(pinFor(key, { verifyRequired: true }), { flags: 0x05 }), 'verified');
  assert.match(code(pinFor(key), { flags: 0x81 }), /extension data/);
  assert.match(code(pinFor(key), { namespace: 'git' }), /namespace/);
  assert.equal(code(pinFor(key), { hash: 'sha256' }), 'verified');
  // A signature from another key, even over the same payload, does not verify.
  const other = securityKey();
  const segment = encodePayload(payloadFor(key));
  const forged = other.sshsig(Buffer.from(segment));
  assert.throws(() => verifyStatement(`s1.${segment}.${forged.toString('base64url')}`, { keys: [pinFor(key)], now: NOW }), /another key/);
});

test('a keyd pin verifies raw Ed25519 statements and nothing signed for presence', () => {
  const key = keydKey();
  const segment = encodePayload(payloadFor(key, { alg: 'ed25519' }));
  const keys = [pinFor(key, { name: 'mac', store: 'keyd' })];
  assert.equal(verifyStatement(`s1.${segment}.${key.sign(segment).toString('base64url')}`, { keys, now: NOW }).pin.name, 'mac');
  const presence = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'presence', action: 'a'.repeat(64), nonce: NONCE, iat: SECONDS, exp: SECONDS + 60 })).toString('base64url');
  assert.throws(() => verifyStatement(`s1.${presence}.${key.sign(presence).toString('base64url')}`, { keys, now: NOW }), { code: 'statement-invalid' });
  assert.throws(() => verifyStatement(`p1.${presence}.${key.sign(presence).toString('base64url')}`, { keys, now: NOW }), { code: 'statement-invalid' });
});

test('the pin file is private, bounded and refused when damaged', (t) => {
  const { env } = home(t);
  assert.deepEqual(readOwnerKeys({ env }), []);
  const keys = Array.from({ length: MAX_OWNER_KEYS }, (_, i) => pinFor(securityKey(), { name: `key-${i}` }));
  writeOwnerKeys(keys, { env });
  assert.equal(statSync(ownerKeysPath({ env })).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(ownerKeysPath({ env }))).mode & 0o777, 0o700);
  assert.deepEqual(readOwnerKeys({ env }), keys);
  assert.throws(() => writeOwnerKeys([...keys, pinFor(securityKey(), { name: 'fifth' })], { env }), { code: 'owner-keys-full' });
  writeFileSync(ownerKeysPath({ env }), '{"v":1,"keys":[{"name":"x"}]}');
  assert.throws(() => readOwnerKeys({ env }), { code: 'owner-keys-invalid' });
  const lying = { ...pinFor(securityKey()), fingerprint: securityKey().fingerprint };
  writeFileSync(ownerKeysPath({ env }), JSON.stringify({ v: 1, keys: [lying] }));
  assert.throws(() => readOwnerKeys({ env }), /does not match its key/);
});

function command(t, { gate = async () => ({ method: 'presence' }), sign: signer, markers = () => [], env: extra = {} } = {}) {
  const { dir, env } = home(t);
  const out = [];
  const receipts = [];
  const run = (argv) => ownerCommand(argv, {
    env: { ...env, ...extra }, home: dir, now: () => NOW, write: (text) => out.push(text), writeErr: () => {},
    gate, markers, receipt: (fields) => receipts.push(fields), sign: signer, host: () => 'mac',
  });
  return { dir, env, out, receipts, run };
}

// An sk key on disk, as `ssh-keygen -t ed25519-sk` leaves its `.pub`, and a
// signer standing in for ssh-keygen -Y sign with it.
function skOnDisk(dir, key = securityKey()) {
  const file = join(dir, 'id_ed25519_sk');
  writeFileSync(`${file}.pub`, `${key.line} owner@laptop\n`);
  return { file, key, sign: (segment) => key.sshsig(Buffer.from(segment)) };
}

test('enroll pins a security key after the gate and a proof of possession', async (t) => {
  const asked = [];
  const ctx = command(t, { gate: async (action) => { asked.push(action); return { method: 'presence' }; } });
  const disk = skOnDisk(ctx.dir);
  const run = (argv) => ownerCommand(argv, { env: ctx.env, home: ctx.dir, now: () => NOW, write: () => {}, writeErr: () => {},
    gate: async (action) => { asked.push(action); }, receipt: (fields) => ctx.receipts.push(fields), sign: disk.sign, host: () => 'mac' });
  const pin = await run(['enroll', '--store', 'ssh', '--key', disk.file, '--name', 'yubikey']);
  assert.equal(pin.fingerprint, disk.key.fingerprint);
  assert.deepEqual(asked, [`owner enroll yubikey ${disk.key.fingerprint}`]);
  assert.deepEqual(readOwnerKeys({ env: ctx.env }).map((p) => p.name), ['yubikey']);
  assert.deepEqual(ctx.receipts.map((r) => [r.event, r.operation, r.decision]), [['owner-key', 'enroll', 'approved']]);
  await assert.rejects(run(['enroll', '--store', 'ssh', '--key', disk.file, '--name', 'again']), { code: 'owner-key-exists' });
  assert.equal(ctx.receipts.at(-1).decision, 'refused');
  // Removal asks the gate too, and the statement it signed no longer verifies.
  const statement = skToken(disk.key);
  await run(['remove', 'yubikey']);
  assert.equal(asked.at(-1), `owner remove yubikey ${disk.key.fingerprint}`);
  assert.throws(() => verifyStatement(statement, { keys: readOwnerKeys({ env: ctx.env }), now: NOW }), { code: 'statement-unknown-key' });
});

test('enroll pins nothing when the gate refuses or the key cannot prove possession', async (t) => {
  const refused = command(t, { gate: async () => { throw Object.assign(new Error('declined'), { code: 'owner-declined' }); } });
  const disk = skOnDisk(refused.dir);
  await assert.rejects(ownerCommand(['enroll', '--store', 'ssh', '--key', disk.file], {
    env: refused.env, home: refused.dir, now: () => NOW, write: () => {}, writeErr: () => {},
    gate: async () => { throw Object.assign(new Error('declined'), { code: 'owner-declined' }); },
    receipt: (fields) => refused.receipts.push(fields), sign: disk.sign, host: () => 'mac',
  }), { code: 'owner-declined' });
  assert.deepEqual(readOwnerKeys({ env: refused.env }), []);
  assert.equal(refused.receipts[0].decision, 'refused');

  // The key file names one key; whoever answers ssh-keygen signs with another.
  const swapped = command(t);
  const claimed = skOnDisk(swapped.dir);
  const impostor = securityKey();
  await assert.rejects(ownerCommand(['enroll', '--store', 'ssh', '--key', claimed.file], {
    env: swapped.env, home: swapped.dir, now: () => NOW, write: () => {}, writeErr: () => {}, gate: async () => {},
    receipt: (fields) => swapped.receipts.push(fields), sign: (segment) => impostor.sshsig(Buffer.from(segment)), host: () => 'mac',
  }), { code: 'statement-invalid' });
  assert.deepEqual(readOwnerKeys({ env: swapped.env }), []);
  assert.equal(swapped.receipts[0].decision, 'failed');
});

test('enroll refuses a software key unless asked, and the keyd store until it exists', async (t) => {
  const ctx = command(t);
  const file = join(ctx.dir, 'id_ed25519');
  writeFileSync(`${file}.pub`, `${keydKey().line} owner@laptop\n`);
  await assert.rejects(ctx.run(['enroll', '--store', 'ssh', '--key', file]), { code: 'owner-key-software' });
  await assert.rejects(ctx.run(['enroll', '--store', 'keyd']), { code: 'owner-store-unavailable' });
  await assert.rejects(ctx.run(['enroll', '--store', 'ssh', '--key', file, '--name', 'Bad Name', '--allow-software-key']), { code: 'owner-usage' });
  assert.deepEqual(readOwnerKeys({ env: ctx.env }), []);
});

test('sign refuses a soul or an agent process, and signs the text and scope it shows', async (t) => {
  const key = securityKey();
  const agent = command(t, { env: { CLAUDECODE: '1' } });
  const disk = skOnDisk(agent.dir, key);
  await assert.rejects(agent.run(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--key', disk.file]), /no agent runs.*CLAUDECODE/s);
  const soul = command(t, { markers: () => ['Agent ID'] });
  await assert.rejects(soul.run(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--key', skOnDisk(soul.dir, key).file]), /Agent ID/);

  const owner = command(t, { sign: disk.sign });
  const { token } = await owner.run(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--key', skOnDisk(owner.dir, key).file, '--expires', '2d']);
  assert.equal(owner.out.join(''), armorStatement(token));
  const { payload } = verifyStatement(owner.out.join(''), { keys: [pinFor(key)], now: NOW, repo: SCOPE.repo, issue: 753 });
  assert.deepEqual([payload.text, payload.scope, payload.exp - payload.iat], ['Ship it.', SCOPE, 2 * 86_400]);
  await assert.rejects(owner.run(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--key', disk.file, '--expires', '31d']), { code: 'owner-usage' });
  await assert.rejects(owner.run(['sign', 'Ship it.', '--key', disk.file]), { code: 'owner-usage' });
  await assert.rejects(owner.run(['sign', 'a\u202eb', '--repo', SCOPE.repo, '--issue', '753', '--key', disk.file]), { code: 'owner-usage' });
});

test('verify reads a token, a file or stdin and answers in JSON', async (t) => {
  const key = securityKey();
  const ctx = command(t);
  writeOwnerKeys([pinFor(key)], { env: ctx.env });
  const block = armorStatement(skToken(key));
  const file = join(ctx.dir, 'comment.md');
  writeFileSync(file, `See below.\n${block}`);
  const result = await ctx.run(['verify', file, '--repo', SCOPE.repo, '--issue', '753', '--json']);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(ctx.out.at(-1)).text, 'Ship the owner sign slice.');
  const stdin = await ownerCommand(['verify', '-'], { env: ctx.env, home: ctx.dir, now: () => NOW, write: () => {}, readStdin: () => block });
  assert.equal(stdin.key, 'yubikey');
  const refused = await ctx.run(['verify', block, '--repo', SCOPE.repo, '--issue', '1', '--json']);
  assert.deepEqual(refused, { ok: false, code: 'statement-scope-mismatch' });
  await assert.rejects(ctx.run(['verify', block, '--repo', SCOPE.repo]), { code: 'owner-usage' });
});

test('ssh-keygen signatures from a software key verify end to end', { skip: !HAS_SSH_KEYGEN && 'ssh-keygen is not installed' }, async (t) => {
  const ctx = command(t);
  const file = join(ctx.dir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'owner', '-f', file]);
  const run = (argv) => ownerCommand(argv, { env: ctx.env, home: ctx.dir, now: () => Date.now(), write: (text) => ctx.out.push(text),
    writeErr: () => {}, gate: async () => {}, receipt: () => {}, host: () => 'mac' });
  await run(['enroll', '--store', 'ssh', '--key', file, '--name', 'laptop', '--allow-software-key']);
  assert.equal(readOwnerKeys({ env: ctx.env })[0].softwareKey, true);
  await run(['sign', 'Accept the ssh store.', '--repo', SCOPE.repo, '--issue', '753', '--key', file]);
  const verified = await run(['verify', ctx.out.at(-1), '--repo', SCOPE.repo, '--issue', '753']);
  assert.deepEqual([verified.text, verified.key], ['Accept the ssh store.', 'laptop']);
  assert.equal(ctx.out.at(-1).split('\n')[1], 'Accept the ssh store.');
});

test('the agent-bot owner command verifies offline and exits non-zero on a refusal', (t) => {
  const key = securityKey();
  const { dir, env } = home(t);
  writeOwnerKeys([pinFor(key)], { env });
  const token = skToken(key, { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const cli = (args) => spawnSync(process.execPath, [CLI, 'owner', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
  const ok = cli(['verify', token, '--repo', SCOPE.repo, '--issue', '753']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^verified owner statement \(key yubikey\)/);
  const wrong = cli(['verify', token, '--repo', SCOPE.repo, '--issue', '9']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^agent-bot owner: statement-scope-mismatch: /);
  assert.equal(cli(['bogus']).status, 2);
  assert.match(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout, /^  owner +Owner-signed statements/m);
  assert.equal(extractToken(armorStatement(token)), token);
  assert.equal(readFileSync(ownerKeysPath({ env }), 'utf8').includes(key.fingerprint), true);
});

test('pins are changed under a lock, re-read after the owner answers', async (t) => {
  const ctx = command(t);
  const disk = skOnDisk(ctx.dir);
  const other = pinFor(securityKey(), { name: 'phone' });
  const enroll = (name, gate) => ownerCommand(['enroll', '--store', 'ssh', '--key', disk.file, '--name', name], {
    env: ctx.env, home: ctx.dir, now: () => NOW, write: () => {}, writeErr: () => {}, gate,
    receipt: (fields) => ctx.receipts.push(fields), sign: disk.sign, host: () => 'mac' });
  // Another command pins a key while this one waits on the owner: both stay.
  await enroll('yubikey', async () => { writeOwnerKeys([other], { env: ctx.env }); });
  assert.deepEqual(readOwnerKeys({ env: ctx.env }).map((p) => p.name), ['phone', 'yubikey']);
  assert.deepEqual(readdirSync(dirname(ownerKeysPath({ env: ctx.env }))).sort(), ['keys.json']);

  // The same key pinned meanwhile under another name: refused under the lock.
  writeOwnerKeys([other], { env: ctx.env });
  await assert.rejects(enroll('laptop', async () => {
    writeOwnerKeys([other, pinFor(disk.key, { name: 'sneaky' })], { env: ctx.env });
  }), { code: 'owner-key-exists' });
  assert.equal(ctx.receipts.at(-1).decision, 'failed');

  // A removal keeps a key added while it waited, and does not resurrect.
  writeOwnerKeys([pinFor(disk.key)], { env: ctx.env });
  await ownerCommand(['remove', 'yubikey'], { env: ctx.env, home: ctx.dir, write: () => {}, receipt: () => {},
    gate: async () => { writeOwnerKeys([pinFor(disk.key), other], { env: ctx.env }); } });
  assert.deepEqual(readOwnerKeys({ env: ctx.env }).map((p) => p.name), ['phone']);
  await assert.rejects(ownerCommand(['remove', 'phone'], { env: ctx.env, home: ctx.dir, write: () => {}, receipt: () => {},
    gate: async () => { writeOwnerKeys([], { env: ctx.env }); } }), { code: 'owner-key-missing' });
});

test('every enrolment refusal leaves a receipt, a policy refusal included', async (t) => {
  const ctx = command(t);
  const file = join(ctx.dir, 'id_ed25519');
  writeFileSync(`${file}.pub`, `${keydKey().line} owner@laptop\n`);
  await assert.rejects(ctx.run(['enroll', '--store', 'ssh', '--key', file]), { code: 'owner-key-software' });
  await assert.rejects(ctx.run(['remove', 'nothing']), { code: 'owner-key-missing' });
  assert.deepEqual(ctx.receipts.map((r) => [r.operation, r.decision]), [['enroll', 'refused'], ['remove', 'refused']]);
  assert.match(ctx.receipts[0].detail, /owner-key-software/);
});

test('verify reads only a bounded regular file', (t) => {
  const { dir } = home(t);
  const block = armorStatement(skToken(securityKey()));
  const file = join(dir, 'statement.md');
  writeFileSync(file, block);
  assert.equal(readStatementFile(file), block);
  const link = join(dir, 'link.md');
  symlinkSync(file, link);
  assert.throws(() => readStatementFile(link), { code: 'statement-invalid' });
  assert.throws(() => readStatementFile(dir), /not a regular file/);
  const big = join(dir, 'big.md');
  writeFileSync(big, 'x'.repeat(MAX_INPUT_BYTES + 1));
  assert.throws(() => readStatementFile(big), /larger than/);
  if (process.platform !== 'win32' && spawnSync('mkfifo', [join(dir, 'fifo')]).status === 0) {
    assert.throws(() => readStatementFile(join(dir, 'fifo')), /not a regular file/);
  }
});
