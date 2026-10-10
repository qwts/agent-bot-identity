import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHALLENGE_LIFETIME, MAX_INPUT_BYTES, MAX_OWNER_KEYS, SSHSIG_NAMESPACE, STATEMENT_AUDIENCE, armorStatement, createOwnerChallenges,
  encodePayload, ed25519KeyLine, extractToken, ownerCommand, ownerKeysPath, parseSshPublicKey, promptOwnerChallenge, readOwnerKeys,
  readStatementFile, signChallenge, sshFingerprint, verifyOwnerChallenge, verifyStatement, writeOwnerKeys,
} from '../owner-statement.mjs';
import { assertOwnerAction, ownerActionSummary, presenceOrConsent } from '../owner-action.mjs';

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

test('an owner challenge binds the displayed action summary and can be answered once by an enrolled SSH key', () => {
  const key = securityKey();
  const pin = pinFor(key);
  const text = 'approve the pending soul revision';
  const challenges = createOwnerChallenges(text, [pin], { host: 'remote-host', now: NOW });
  assert.equal(challenges.length, 1);
  const challenge = challenges[0].payload;
  assert.equal(challenge.action, createHash('sha256').update(text).digest('hex'));
  assert.equal(challenge.text, text);
  assert.deepEqual(challenge.scope, { host: 'remote-host' });
  assert.equal(challenge.exp - challenge.iat, CHALLENGE_LIFETIME.default);
  assert.throws(() => createOwnerChallenges('😀'.repeat(126), [pin], { now: NOW }), { code: 'statement-invalid' });

  const signedPayload = { ...challenge, iat: challenge.iat + 1 };
  const segment = encodePayload(signedPayload);
  const reply = armorStatement(`s1.${segment}.${key.sshsig(Buffer.from(segment)).toString('base64url')}`);
  assert.deepEqual(verifyOwnerChallenge(reply, { challenges, keys: [pin], now: NOW + 1000 }), {
    method: 'statement', via: 'ssh', key: 'yubikey', fingerprint: key.fingerprint,
  });
  assert.throws(() => verifyOwnerChallenge(reply, {
    challenges: createOwnerChallenges(`${text} changed`, [pin], { host: 'remote-host', now: NOW }), keys: [pin], now: NOW + 1000,
  }), { code: 'statement-scope-mismatch' });

  for (const changed of [
    { ...challenge, action: `${challenge.action[0] === '0' ? '1' : '0'}${challenge.action.slice(1)}` },
    { ...challenge, scope: { host: 'another-host' } },
    { ...challenge, nonce: `${challenge.nonce.slice(0, -1)}${challenge.nonce.endsWith('a') ? 'b' : 'a'}` },
  ]) {
    const changedSegment = encodePayload(changed);
    const changedReply = armorStatement(`s1.${changedSegment}.${key.sshsig(Buffer.from(changedSegment)).toString('base64url')}`);
    assert.throws(() => verifyOwnerChallenge(changedReply, { challenges, keys: [pin], now: NOW + 1000 }), { code: 'statement-scope-mismatch' });
  }

  const longer = { ...challenge, iat: challenge.iat + 1, exp: challenge.exp + 1 };
  const longerSegment = encodePayload(longer);
  const longerReply = armorStatement(`s1.${longerSegment}.${key.sshsig(Buffer.from(longerSegment)).toString('base64url')}`);
  assert.throws(() => verifyOwnerChallenge(longerReply, { challenges, keys: [pin], now: NOW + 1000 }), { code: 'statement-scope-mismatch' });
});

test('a signer clock behind by less than the allowed skew can answer the original challenge', (t) => {
  const ctx = command(t);
  const key = securityKey();
  const keyPath = join(ctx.dir, 'owner-key');
  writeFileSync(`${keyPath}.pub`, `${key.line}\n`);
  const pin = pinFor(key);
  const [challenge] = createOwnerChallenges('approve revision p2', [pin], { host: 'remote-host', now: NOW });
  const { token, payload } = signChallenge(challenge.payload, keyPath, {
    now: NOW - 20_000,
    sign: (segment) => key.sshsig(Buffer.from(segment)),
  });
  assert.equal(payload.iat, challenge.payload.iat, 'the signer preserves the request issuance time');
  assert.deepEqual(verifyOwnerChallenge(armorStatement(token), { challenges: [challenge], keys: [pin], now: NOW + 5_000 }).via, 'ssh');
  const mismatchedAction = `${challenge.payload.action[0] === '0' ? '1' : '0'}${challenge.payload.action.slice(1)}`;
  assert.throws(() => signChallenge({ ...challenge.payload, action: mismatchedAction }, keyPath, {
    now: NOW, sign: () => assert.fail('a mismatched challenge template must be rejected before signing'),
  }), { code: 'statement-invalid' });
});

test('the owner CLI signs the challenge JSON and emits only the armored reply on stdout', async (t) => {
  if (!HAS_SSH_KEYGEN) return t.skip('ssh-keygen is not installed');
  const ctx = command(t);
  const keyPath = join(ctx.dir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
  const line = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const key = parseSshPublicKey(line);
  const pin = { ...pinFor({ line, fingerprint: sshFingerprint(key.blob) }), softwareKey: true };
  const challengeNow = Date.now();
  const [challenge] = createOwnerChallenges('approve the pending revision', [pin], { host: 'remote-host', now: challengeNow });
  const result = spawnSync(process.execPath, [CLI, 'owner', 'sign', '--challenge', JSON.stringify(challenge.payload), '--key', keyPath], {
    cwd: ctx.dir, env: { HOME: ctx.dir, PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^-----BEGIN AGENT-BOT OWNER STATEMENT-----\ns1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n-----END AGENT-BOT OWNER STATEMENT-----\n$/);
  assert.match(result.stderr, /approve the pending revision/);
  const verified = verifyStatement(result.stdout, { keys: [pin], now: Date.now() });
  assert.equal(verified.payload.action, challenge.payload.action);
  assert.equal(verified.payload.nonce, challenge.payload.nonce);
  assert.equal(verified.payload.exp, challenge.payload.exp);
});

test('the challenge gate reaches the terminal reply flow only after unavailable presence and local SSH pins', async (t) => {
  const ctx = command(t);
  const key = securityKey();
  const pin = pinFor(key);
  writeOwnerKeys([pin], { env: ctx.env });
  const action = 'soul revision approve agent_12345678-1234-4123-8123-123456789abc proposal_1';
  let asked = 0;
  let promptCount = 0;
  const now = () => NOW;
  const proof = await assertOwnerAction(action, {
    env: ctx.env, cwd: ctx.dir, markers: () => [], challengeNow: now, challengeHost: () => 'remote-host',
    presence: async () => { asked += 1; throw Object.assign(new Error('headless'), { code: 'presence-unavailable' }); },
    challengePrompt: async (challenges) => {
      promptCount += 1;
      const summary = challenges[0].payload.text;
      assert.equal(summary, ownerActionSummary(action, { env: ctx.env }));
      assert.equal(challenges[0].payload.action, createHash('sha256').update(summary).digest('hex'));
      const payload = { ...challenges[0].payload, iat: SECONDS + 1 };
      const segment = encodePayload(payload);
      return armorStatement(`s1.${segment}.${key.sshsig(Buffer.from(segment)).toString('base64url')}`);
    },
    fallbackConsent: () => assert.fail('an enrolled key uses the challenge path, not administrator fallback'),
  });
  assert.deepEqual(proof, { method: 'statement', via: 'ssh', key: pin.name, fingerprint: pin.fingerprint });
  assert.equal(asked, 1);
  assert.equal(promptCount, 1);
});

test('the owner-action presence wrapper checks presence once before the challenge flow', async (t) => {
  const ctx = command(t);
  const key = securityKey();
  const pin = pinFor(key);
  writeOwnerKeys([pin], { env: ctx.env });
  const action = 'soul revision approve agent_12345678-1234-4123-8123-123456789abc proposal_1';
  let presenceCalls = 0;
  let signedReply;
  let challengeCalls = 0;
  const options = {
    env: ctx.env, cwd: ctx.dir, markers: () => [], challengeNow: () => NOW, challengeHost: () => 'remote-host',
    presence: async () => { presenceCalls += 1; throw Object.assign(new Error('headless'), { code: 'presence-unavailable' }); },
    challengePrompt: async ([challenge]) => {
      challengeCalls += 1;
      if (signedReply) return signedReply;
      const payload = { ...challenge.payload, iat: challenge.payload.iat + 1 };
      const segment = encodePayload(payload);
      signedReply = armorStatement(`s1.${segment}.${key.sshsig(Buffer.from(segment)).toString('base64url')}`);
      return signedReply;
    },
    consent: () => assert.fail('a valid challenge should not reach the existing consent seam'),
  };
  const proof = await presenceOrConsent(action, options);
  assert.equal(proof.via, 'ssh');
  assert.equal(presenceCalls, 1);
  await assert.rejects(presenceOrConsent(action, options), { code: 'statement-scope-mismatch' });
  assert.equal(presenceCalls, 2);
  assert.equal(challengeCalls, 2);
});

test('challenge refusal, cancellation, and disabled challenge paths never approve or fall through', async (t) => {
  const ctx = command(t);
  const key = securityKey();
  writeOwnerKeys([pinFor(key)], { env: ctx.env });
  const action = 'owner remove yubikey fingerprint';
  let fallback = 0;
  const unavailable = async () => { throw Object.assign(new Error('headless'), { code: 'presence-unavailable' }); };
  await assert.rejects(assertOwnerAction(action, {
    env: ctx.env, cwd: ctx.dir, markers: () => [], presence: unavailable,
    challengePrompt: async (challenges) => {
      const altered = { ...challenges[0].payload, text: 'different action' };
      const segment = encodePayload(altered);
      return armorStatement(`s1.${segment}.${key.sshsig(Buffer.from(segment)).toString('base64url')}`);
    },
    fallbackConsent: () => { fallback += 1; return { method: 'consent' }; },
  }), { code: 'statement-scope-mismatch' });
  assert.equal(fallback, 0, 'an invalid reply is final');

  const disabled = await assertOwnerAction(action, {
    env: ctx.env, cwd: ctx.dir, markers: () => [], presence: unavailable, allowChallenge: false,
    challengePrompt: () => assert.fail('enrollment and removal never use the signed fallback'),
    fallbackConsent: async () => { fallback += 1; return { method: 'consent' }; },
  });
  assert.deepEqual(disabled, { method: 'consent' });
  assert.equal(fallback, 1, 'disabling challenge retains the old consent path');

  await assert.rejects(assertOwnerAction(action, {
    env: ctx.env, cwd: ctx.dir, markers: () => [], presence: async () => { throw Object.assign(new Error('declined'), { code: 'owner-declined' }); },
    challengePrompt: () => assert.fail('owner-declined is final'),
    fallbackConsent: () => assert.fail('owner-declined never reaches consent'),
  }), { code: 'owner-declined' });
});

test('hosts with no enrolled owner keys retain the existing administrator fallback', async (t) => {
  const ctx = command(t);
  let fallback = 0;
  const proof = await assertOwnerAction('owner action without enrolled pins', {
    env: ctx.env, cwd: ctx.dir, markers: () => [],
    presence: async () => { throw Object.assign(new Error('headless'), { code: 'presence-unavailable' }); },
    challengePrompt: () => assert.fail('an empty pin store does not produce a challenge'),
    fallbackConsent: async () => { fallback += 1; return { method: 'consent' }; },
  });
  assert.deepEqual(proof, { method: 'consent' });
  assert.equal(fallback, 1);
});

test('owner challenge refuses keyd-only pins and rechecks SSH pins after waiting', async (t) => {
  const ctx = command(t);
  const key = securityKey();
  const action = 'soul revision approve agent_12345678-1234-4123-8123-123456789abc proposal_1';
  const unavailable = async () => { throw Object.assign(new Error('headless'), { code: 'presence-unavailable' }); };
  let fallback = 0;

  writeOwnerKeys([pinFor(keydKey(), { store: 'keyd', name: 'local-keyd' })], { env: ctx.env });
  await assert.rejects(assertOwnerAction(action, {
    env: ctx.env, cwd: ctx.dir, markers: () => [], presence: unavailable,
    challengePrompt: () => assert.fail('keyd pins are not supported by this CLI challenge flow'),
    fallbackConsent: () => { fallback += 1; return { method: 'consent' }; },
  }), { code: 'owner-unreachable' });
  assert.equal(fallback, 0, 'any enrolled key disables administrator fallback');

  const pin = pinFor(key);
  writeOwnerKeys([pin], { env: ctx.env });
  await assert.rejects(assertOwnerAction(action, {
    env: ctx.env, cwd: ctx.dir, markers: () => [], presence: unavailable,
    challengePrompt: async ([challenge]) => {
      // Removing the key while the owner signs must invalidate the pending reply.
      writeOwnerKeys([], { env: ctx.env });
      const payload = { ...challenge.payload, iat: challenge.payload.iat + 1 };
      const segment = encodePayload(payload);
      return armorStatement(`s1.${segment}.${key.sshsig(Buffer.from(segment)).toString('base64url')}`);
    },
    fallbackConsent: () => { fallback += 1; return { method: 'consent' }; },
  }), { code: 'owner-unreachable' });
  assert.equal(fallback, 0, 'a revoked pin cannot authorize from a stale challenge');

  const replacement = pinFor(securityKey(), { name: pin.name });
  writeOwnerKeys([pin], { env: ctx.env });
  await assert.rejects(assertOwnerAction(action, {
    env: ctx.env, cwd: ctx.dir, markers: () => [], presence: unavailable,
    challengePrompt: async ([challenge]) => {
      writeOwnerKeys([replacement], { env: ctx.env });
      const payload = { ...challenge.payload, iat: challenge.payload.iat + 1 };
      const segment = encodePayload(payload);
      return armorStatement(`s1.${segment}.${key.sshsig(Buffer.from(segment)).toString('base64url')}`);
    },
    fallbackConsent: () => { fallback += 1; return { method: 'consent' }; },
  }), { code: 'owner-unreachable' });
  assert.equal(fallback, 0, 'a replacement key cannot inherit an old challenge');
});

test('owner challenge prompt refuses noninteractive input and has a finite wait', async () => {
  const output = { isTTY: false, write: () => assert.fail('noninteractive prompt must not write or read') };
  await assert.rejects(promptOwnerChallenge([], { input: { isTTY: false }, output }), { code: 'owner-unreachable' });

  const input = new PassThrough(); input.isTTY = true;
  const terminal = new PassThrough(); terminal.isTTY = true;
  await assert.rejects(promptOwnerChallenge([], { input, output: terminal, timeoutMs: 10 }), { code: 'owner-unreachable' });
  input.destroy(); terminal.destroy();

  const cancelInput = new PassThrough(); cancelInput.isTTY = true;
  const cancelOutput = new PassThrough(); cancelOutput.isTTY = true;
  const cancelled = promptOwnerChallenge([], { input: cancelInput, output: cancelOutput, timeoutMs: 60_000 });
  cancelInput.write('\n');
  await assert.rejects(cancelled, { code: 'owner-challenge-cancelled' });
  cancelInput.destroy(); cancelOutput.destroy();
});

test('the terminal prompt accepts and verifies one armored signed owner reply', async () => {
  const key = securityKey();
  const pin = pinFor(key);
  const challenges = createOwnerChallenges('approve pending change', [pin], { host: 'remote-host', now: NOW });
  const payload = challenges[0].payload;
  const segment = encodePayload(payload);
  const reply = armorStatement(`s1.${segment}.${key.sshsig(Buffer.from(segment)).toString('base64url')}`);
  const input = new PassThrough(); input.isTTY = true;
  const output = new PassThrough(); output.isTTY = true;
  const pending = promptOwnerChallenge(challenges, { input, output, timeoutMs: 60_000 });
  input.write(reply);
  const returned = await pending;
  assert.equal(returned, reply.trim());
  assert.deepEqual(verifyOwnerChallenge(returned, { challenges, keys: [pin], now: NOW + 1000 }), {
    method: 'statement', via: 'ssh', key: pin.name, fingerprint: pin.fingerprint,
  });
  input.destroy(); output.destroy();
});

test('owner challenge prompt bounds an unterminated terminal reply as bytes arrive', async () => {
  const input = new PassThrough(); input.isTTY = true;
  const output = new PassThrough(); output.isTTY = true;
  const pending = promptOwnerChallenge([], { input, output, timeoutMs: 60_000 });
  input.write(`s1.fake\n${'x'.repeat(MAX_INPUT_BYTES + 1)}`);
  await assert.rejects(pending, { code: 'statement-invalid' });
  assert.equal(input.destroyed, false, 'refusal does not destroy command stdin');
  input.destroy(); output.destroy();
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
