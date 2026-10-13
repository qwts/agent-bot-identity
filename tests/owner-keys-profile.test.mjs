// The organization profile's owner keys (ADR-0753 section 3, #753): an
// optional `settings.owner_keys` that projects into config like the other
// settings. Where it declares keys, a reader accepts a pinned key only if the
// profile lists it and keyd vouches for the pins; a pin it does not list is
// `pins-unlisted`, never the signed path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, ownerKeysSetting } from '../config.mjs';
import {
  ORGANIZATION_PROFILE_SCHEMA_VERSION,
  isProjectedRuntimeConfig,
  organizationProfileToConfig,
  validateOrganizationProfile,
} from '../organization-profile.mjs';
import { assertOwnerAction, createChallengeLedger } from '../owner-action.mjs';
import { attestedOwnerKeys, createPinsGenerationFloor, pinSetDigest } from '../owner-presence.mjs';
import {
  SSHSIG_NAMESPACE, armorStatement, encodePayload, ownerCommand, parseSshPublicKey, signPayload, sshFingerprint, writeOwnerKeys,
} from '../owner-statement.mjs';
import { rawEd25519 } from './helpers/ed25519-raw.mjs';

const SCOPE = { repo: 'qwts/agent-bot-identity', number: 753 };
const profile = (settings) => ({
  schema_version: ORGANIZATION_PROFILE_SCHEMA_VERSION,
  organization: 'example-engineering',
  account_owner: 'example-owner',
  minimum_runtime_interface_version: 1,
  defaults: { claude: 'example-claude-agent' },
  identities: [{ slug: 'example-claude-agent', harness: 'claude', status: 'active' }],
  settings,
});
const FP = (c) => `SHA256:${c.repeat(43)}`;
const declared = (key) => ({ name: key.name, store: key.store, alg: key.alg, fingerprint: key.fingerprint });

function scratch(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'owner-keys-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { HOME: home } };
}

// A hand-written config in the scratch HOME, as bootstrap would leave one.
function writeConfig(home, settings) {
  const dir = path.join(home, '.config', 'agent-bot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings }));
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const str = (value) => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([u32(b.length), b]); };

// A FIDO sk-ssh-ed25519 key pinned as the owner's, its `.pub` on disk, and a
// signer standing in for the hardware (PROTOCOL.u2f).
function ownerKey(home, name = 'yubikey') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(rawEd25519(publicKey), 'base64url');
  const type = 'sk-ssh-ed25519@openssh.com';
  const application = 'ssh:';
  const blob = Buffer.concat([str(type), str(raw), str(application)]);
  const line = `${type} ${blob.toString('base64')}`;
  const keyPath = path.join(home, `id_${name}_sk`);
  writeFileSync(`${keyPath}.pub`, `${line} ${name}\n`);
  const sshsig = (segment) => {
    const signed = Buffer.concat([Buffer.from('SSHSIG'), str(SSHSIG_NAMESPACE), str(''), str('sha512'), str(createHash('sha512').update(segment).digest())]);
    const counter = u32(7);
    const data = Buffer.concat([createHash('sha256').update(application).digest(), Buffer.from([0x01]), counter, createHash('sha256').update(signed).digest()]);
    const signature = Buffer.concat([str(type), str(sign(null, data, privateKey)), Buffer.from([0x01]), counter]);
    return Buffer.concat([Buffer.from('SSHSIG'), u32(1), str(blob), str(SSHSIG_NAMESPACE), str(''), str('sha512'), str(signature)]);
  };
  const pin = { name, store: 'ssh', alg: 'sshsig', publicKey: line, fingerprint: sshFingerprint(parseSshPublicKey(line).blob),
    verifyRequired: false, softwareKey: false, pinnedAt: '2026-10-11T00:00:00.000Z' };
  return { keyPath, pin, sign: (segment) => sshsig(Buffer.from(segment)) };
}

// The real attestedOwnerKeys against a keyd that recorded exactly `pins`;
// `declared` is left to its default, the config under the caller's home.
function keydRecording(pins, { generation = 1 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(rawEd25519(publicKey), 'base64url').toString('base64');
  const floor = createPinsGenerationFloor();
  const seen = [];
  const attest = async (asked, options) => {
    const result = await attestedOwnerKeys(asked, { ...options, floor, pinned: () => raw, request: async (socket, method, params) => {
      const iat = Math.floor(Date.now() / 1000);
      const segment = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'pins', digest: pinSetDigest(pins), generation,
        nonce: params.nonce, iat, exp: iat + 60 })).toString('base64url');
      return { attestation: `k1.${segment}.${sign(null, Buffer.from(segment), privateKey).toString('base64url')}` };
    } });
    seen.push(result);
    return result;
  };
  return { attest, seen };
}

test('the profile projects owner_keys into config and back', () => {
  const keys = [{ name: 'yubikey', store: 'ssh', alg: 'sshsig', fingerprint: FP('A') }, { name: 'mac', store: 'keyd', alg: 'ed25519', fingerprint: FP('B') }];
  const normalized = validateOrganizationProfile(profile({ owner_keys: keys }));
  assert.deepEqual(normalized.settings.owner_keys, keys);
  const config = organizationProfileToConfig(normalized);
  assert.deepEqual(config.settings.ownerKeys, keys);
  assert.deepEqual(ownerKeysSetting(config), keys);
  assert.equal(isProjectedRuntimeConfig(config), true);
  assert.equal(ownerKeysSetting({}), null);
  assert.equal(validateOrganizationProfile(profile({ unmanaged_authors: ['ai9d'] })).settings.owner_keys, undefined);
});

test('owner_keys must be 1 to 4 distinct keys, each exactly name, store, alg and fingerprint', () => {
  const ok = { name: 'yubikey', store: 'ssh', alg: 'sshsig', fingerprint: FP('A') };
  const bad = [
    [], [ok, { ...ok, name: 'b', fingerprint: FP('B') }, { ...ok, name: 'c', fingerprint: FP('C') }, { ...ok, name: 'd', fingerprint: FP('D') }, { ...ok, name: 'e', fingerprint: FP('E') }],
    'yubikey', null, [null], [{ ...ok, publicKey: 'sk-ssh-ed25519@openssh.com AAAA' }], [{ name: 'yubikey', store: 'ssh', alg: 'sshsig' }],
    [{ ...ok, name: 'YubiKey' }], [{ ...ok, store: 'phone' }], [{ ...ok, alg: 'ed25519' }], [{ ...ok, store: 'keyd' }],
    [{ ...ok, fingerprint: 'SHA256:short' }], [{ ...ok, fingerprint: FP('A').replace('SHA256', 'MD5') }],
    [ok, { ...ok, name: 'other' }], [ok, { ...ok, fingerprint: FP('B') }],
  ];
  for (const value of bad) {
    assert.throws(() => validateOrganizationProfile(profile({ owner_keys: value })), /owner_keys/, JSON.stringify(value));
    assert.throws(() => ownerKeysSetting({ settings: { ownerKeys: value } }), /invalid settings\.ownerKeys/, JSON.stringify(value));
  }
  const four = ['A', 'B', 'C', 'D'].map((c, i) => ({ ...ok, name: `k${i}`, fingerprint: FP(c) }));
  assert.equal(validateOrganizationProfile(profile({ owner_keys: four })).settings.owner_keys.length, 4);
});

test('a malformed owner key list in a hand-written config fails the config load', (t) => {
  const { home } = scratch(t);
  writeConfig(home, { ownerKeys: [{ name: 'x', store: 'ssh', alg: 'ed25519', fingerprint: FP('A') }] });
  assert.throws(() => loadConfig({ home, env: {} }), /invalid settings\.ownerKeys/);
});

test('attestedOwnerKeys accepts vouched pins only when the profile lists every one of them', async (t) => {
  const { home, env } = scratch(t);
  const a = ownerKey(home, 'yubikey').pin;
  const b = ownerKey(home, 'phone').pin;
  const { attest } = keydRecording([a, b]);
  const answer = async (listed) => {
    const options = { env, home };
    if (listed !== 'config') Object.assign(options, { declared: () => listed });
    return attest([a, b], options);
  };
  // No declaration: keyd alone, as before.
  assert.equal((await answer(null)).attested, true);
  // Exactly the pins, or more keys than this host pins (subset), is accepted.
  assert.equal((await answer([declared(a), declared(b)])).attested, true);
  assert.equal((await answer([declared(b), declared(a), { name: 'spare', store: 'keyd', alg: 'ed25519', fingerprint: FP('C') }])).attested, true);
  // A pin the profile does not list, or lists under another store, is refused.
  const missing = await answer([declared(a)]);
  assert.deepEqual([missing.attested, missing.code], [false, 'pins-unlisted']);
  assert.match(missing.reason, /does not list the owner key phone/);
  const otherStore = await answer([declared(a), { name: b.name, store: 'keyd', alg: 'ed25519', fingerprint: b.fingerprint }]);
  assert.equal(otherStore.code, 'pins-unlisted');
  // A declaration that cannot be read refuses rather than reading as none.
  const broken = await attest([a, b], { env, home, declared: () => { throw new Error('config is not valid JSON'); } });
  assert.deepEqual([broken.attested, broken.code], [false, 'pins-unlisted']);
  // keyd's own refusals come first: an unlisted pin keyd did not record is a mismatch.
  const other = keydRecording([a]);
  assert.equal((await other.attest([a, b], { env, home, declared: () => [declared(a)] })).code, 'pins-mismatch');

  // By default the declaration is read from the config under the caller's home.
  writeConfig(home, { ownerKeys: [declared(a)] });
  assert.equal((await answer('config')).code, 'pins-unlisted');
  writeConfig(home, { ownerKeys: [declared(a), declared(b)] });
  assert.equal((await answer('config')).attested, true);
  writeFileSync(path.join(home, '.config', 'agent-bot', 'config.json'), '{ not json');
  assert.equal((await answer('config')).code, 'pins-unlisted');
});

// Each reader inherits the check through its attester. A pin keyd vouches for
// but the profile does not list never answers: the gate and the ledger keep
// the dialog, and verify is not approval.
test('every reader refuses a vouched pin the profile does not list, and accepts one it does', async (t) => {
  const { home, env } = scratch(t);
  const owner = ownerKey(home);
  writeOwnerKeys([owner.pin], { env, home });
  const { attest, seen } = keydRecording([owner.pin]);
  const unlisted = { name: 'other', store: 'ssh', alg: 'sshsig', fingerprint: FP('Z') };
  const action = 'soul revision approve agent_12345678-1234-4123-8123-123456789abc proposal_1';
  const dialog = [];
  const gate = () => assertOwnerAction(action, {
    env, cwd: home, markers: () => [], attestPins: attest,
    presence: async () => { throw Object.assign(new Error('headless'), { code: 'presence-unavailable' }); },
    challengePrompt: async ([challenge]) => {
      const segment = encodePayload({ ...challenge.payload, iat: challenge.payload.iat + 1 });
      return armorStatement(`s1.${segment}.${owner.sign(segment).toString('base64url')}`);
    },
    fallbackConsent: async (asked) => { dialog.push(asked); return { method: 'consent' }; },
  });
  const ledger = createChallengeLedger({ env, home, attest });
  const { token } = await signPayload({ kind: 'statement', text: 'Ship the profile slice.', scope: SCOPE, action: null, lifetime: 3600 },
    { keyPath: owner.keyPath, sign: owner.sign });
  const verify = () => ownerCommand(['verify', token, '--repo', SCOPE.repo, '--issue', '753', '--json'],
    { env, home, write: () => {}, attestPins: attest });

  writeConfig(home, { ownerKeys: [unlisted] });
  assert.deepEqual(await gate(), { method: 'consent' });
  assert.equal(await ledger.hook({ request: 'p1' })(action, { summary: action }), null);
  const refused = await verify();
  assert.deepEqual([refused.ok, refused.code, refused.pins.code], [false, 'owner-pins-unprotected', 'pins-unlisted']);
  assert.deepEqual(seen.map((result) => result.code), ['pins-unlisted', 'pins-unlisted', 'pins-unlisted']);
  assert.equal(dialog.length, 1);

  writeConfig(home, { ownerKeys: [unlisted, declared(owner.pin)] });
  assert.equal((await gate()).method, 'statement');
  await assert.rejects(ledger.hook({ request: 'p2' })(action, { summary: action }), { code: 'owner-challenge-required' });
  assert.equal((await verify()).ok, true);
  assert.equal(dialog.length, 1);
});
