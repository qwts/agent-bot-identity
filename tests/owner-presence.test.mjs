import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertOwnerAction, ownerActionSummary, presenceOrConsent } from '../owner-action.mjs';
import { ANY_DEVELOPER_ID, keydSigner } from '../config.mjs';
import {
  ORGANIZATION_PROFILE_SCHEMA_VERSION, isProjectedRuntimeConfig, organizationProfileToConfig, validateOrganizationProfile,
} from '../organization-profile.mjs';
import {
  PRESENCE_AUDIENCE, PRESENCE_UNAVAILABLE_RPC, actionDigest, developerIdRequirement, keydAttestPins, keydPresence,
  pinSetDigest, pinnedPresenceKey, presencePinPath, presenceSignerPath, verifyPinsAttestation, verifyPresence,
} from '../owner-presence.mjs';

const ID = 'agent_121b5b35-0000-4000-8000-000000000000';
const NOW = Date.parse('2026-10-03T22:00:00Z');
const SECONDS = Math.floor(NOW / 1000);
const NONCE = 'abcdefghijklmnopqrstuvwx';
const TEAM = 'ABCDE12345';

// keyd's presence key, as the Rust side holds it.
function presenceKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const signed = (prefix, payload) => {
    const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${prefix}.${segment}.${sign(null, Buffer.from(segment), privateKey).toString('base64url')}`;
  };
  const assertion = (action, overrides = {}) => signed('p1', { v: 1, aud: 'agent-bot-owner', kind: 'presence',
    action: actionDigest(action), nonce: NONCE, iat: SECONDS, exp: SECONDS + 60, ...overrides });
  const pins = (overrides = {}) => signed('k1', { v: 1, aud: 'agent-bot-owner', kind: 'pins',
    digest: 'c'.repeat(64), generation: 2, nonce: NONCE, iat: SECONDS, exp: SECONDS + 60, ...overrides });
  return { raw, assertion, pins, signed };
}

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-presence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A configured team, as an organization profile projects it (#594).
  const env = { HOME: dir, AGENT_BOT_KEYD_TEAM_ID: TEAM };
  mkdirSync(join(dir, '.local', 'state', 'agent-bot', 'keyd'), { recursive: true, mode: 0o700 });
  return { dir, env };
}

test('the action digest matches keyd (sha256 hex)', () => {
  assert.equal(actionDigest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('an assertion verifies only for its key, action, nonce and time', () => {
  const key = presenceKey();
  const action = `turn agent comms off for Bill (${ID})`;
  const ok = { key: key.raw, action, nonce: NONCE, now: NOW };
  assert.equal(verifyPresence(key.assertion(action), ok).kind, 'presence');
  const refuse = (token, over = {}) => assert.throws(() => verifyPresence(token, { ...ok, ...over }), { code: 'presence-invalid' });
  refuse(key.assertion(action), { action: `turn agent comms on for Bill (${ID})` });
  refuse(key.assertion(action), { nonce: 'zyxwvutsrqponmlkjihgfedc' });
  refuse(key.assertion(action), { key: presenceKey().raw });
  refuse(key.assertion(action), { now: NOW + 120_000 });
  refuse(key.assertion(action, { aud: 'agent-bot-keyd' }));
  refuse(key.assertion(action, { exp: SECONDS + 600 }));
  refuse(key.assertion(action).replace(/^p1/, 'v1'));
  refuse(undefined);
});

// The verifier's bounds, separate from keyd's own issuing lifetime (#594): a
// declared lifetime of at most 120 s, and 30 s of clock skew on either side.
test('an assertion is accepted for up to 120 s of lifetime and 30 s of skew, and no more', () => {
  const key = presenceKey();
  const action = `turn agent comms off for Bill (${ID})`;
  const at = (token, now) => verifyPresence(token, { key: key.raw, action, nonce: NONCE, now });
  const accepts = (overrides, now = NOW) => assert.equal(at(key.assertion(action, overrides), now).kind, 'presence');
  const refuses = (overrides, now = NOW) => assert.throws(() => at(key.assertion(action, overrides), now), { code: 'presence-invalid' });
  accepts({ exp: SECONDS + 120 });
  refuses({ exp: SECONDS + 121 });
  refuses({ exp: SECONDS });
  refuses({ exp: SECONDS - 1 });
  // Through exp + 30 s, not a second later.
  accepts({}, (SECONDS + 60 + 30) * 1000);
  refuses({}, (SECONDS + 60 + 31) * 1000);
  // Issued up to 30 s in the verifier's future, not a second more.
  accepts({ iat: SECONDS + 30, exp: SECONDS + 90 });
  refuses({ iat: SECONDS + 31, exp: SECONDS + 91 });
  refuses({ kind: 'grant' });
  refuses({ v: 2 });
  refuses({ iat: SECONDS + 0.5 });
  refuses({ exp: String(SECONDS + 60) });
});

// The same vectors as keyd/src/pins.rs digests_the_canonical_key_set.
test('the owner key set digest matches keyd', () => {
  const pin = (name, fingerprint, more = {}) => ({ name, store: 'ssh', alg: 'sshsig', publicKey: 'ignored', fingerprint,
    verifyRequired: false, softwareKey: false, pinnedAt: '2026-10-10T00:00:00.000Z', ...more });
  const A = `SHA256:${'A'.repeat(43)}`;
  const B = `SHA256:${'B'.repeat(43)}`;
  assert.equal(pinSetDigest([pin('yubikey', A), pin('mac', B, { store: 'keyd', alg: 'ed25519', verifyRequired: true })]),
    'cb09d44b2df51fd95cbea3002bb477ac8c209f824089eaebda5c66d502325def');
  assert.equal(pinSetDigest([]), '84685a46b42aa9f320b192a3a3843fdaece0ef8613a76b7ba10660504ca772c4');
});

test('an owner key record verifies only for its key, nonce and time, and is never a presence assertion', () => {
  const key = presenceKey();
  const ok = { key: key.raw, nonce: NONCE, now: NOW };
  assert.deepEqual(verifyPinsAttestation(key.pins(), ok), { digest: 'c'.repeat(64), generation: 2 });
  assert.deepEqual(verifyPinsAttestation(key.pins({ digest: null, generation: 0 }), ok), { digest: null, generation: 0 });
  const refuse = (token, over = {}) => assert.throws(() => verifyPinsAttestation(token, { ...ok, ...over }), { code: 'pins-invalid' });
  refuse(key.pins(), { nonce: 'zyxwvutsrqponmlkjihgfedc' });
  refuse(key.pins(), { key: presenceKey().raw });
  refuse(key.pins(), { now: NOW + 120_000 });
  refuse(key.pins({ exp: SECONDS + 121 }));
  refuse(key.pins({ aud: 'agent-bot-keyd' }));
  refuse(key.pins({ digest: null, generation: 1 }));
  refuse(key.pins({ generation: 0 }));
  refuse(key.pins({ generation: -1 }));
  refuse(key.pins({ generation: '2' }));
  refuse(key.pins({ digest: 'C'.repeat(64) }));
  refuse(key.pins({ digest: 'c'.repeat(63) }));
  refuse(undefined);
  // Each kind under its own prefix: neither token passes for the other.
  refuse(key.pins().replace(/^k1/, 'p1'));
  refuse(key.signed('k1', { v: 1, aud: 'agent-bot-owner', kind: 'presence', action: actionDigest('x'), digest: 'c'.repeat(64),
    generation: 2, nonce: NONCE, iat: SECONDS, exp: SECONDS + 60 }));
  refuse(key.assertion('x'));
  assert.throws(() => verifyPresence(key.pins(), { ...ok, action: 'x' }), { code: 'presence-invalid' });
  assert.throws(() => verifyPresence(key.signed('p1', { v: 1, aud: 'agent-bot-owner', kind: 'pins', action: actionDigest('x'),
    nonce: NONCE, iat: SECONDS, exp: SECONDS + 60 }), { ...ok, action: 'x' }), { code: 'presence-invalid' });
});

test('the presence contract constants keyd and agent-bot share', () => {
  assert.equal(PRESENCE_AUDIENCE, 'agent-bot-owner');
  assert.equal(PRESENCE_UNAVAILABLE_RPC, -32001);
  // A Developer ID Application leaf from the configured team, on keyd's identifier (#594).
  assert.equal(developerIdRequirement({ teamId: TEAM }), 'anchor apple generic and identifier "agent-bot-keyd"'
    + ` and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM}"`);
});

test('the keyd signer comes from the environment, then the config; the Team ID has no default (#594)', (t) => {
  const { dir } = home(t);
  const env = { HOME: dir };
  assert.deepEqual(keydSigner({ env }), { teamId: null, identifier: 'agent-bot-keyd' });
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ settings: { keydTeamId: 'ABCDE12345', keydIdentifier: 'org.example.keyd' } }));
  const configured = { ...env, AGENT_BOT_CONFIG: config };
  assert.deepEqual(keydSigner({ env: configured }), { teamId: 'ABCDE12345', identifier: 'org.example.keyd' });
  assert.deepEqual(keydSigner({ env: { ...configured, AGENT_BOT_KEYD_TEAM_ID: 'ZZZZZ99999' } }),
    { teamId: 'ZZZZZ99999', identifier: 'org.example.keyd' });
  // Empty means unset, never "any Developer ID".
  assert.deepEqual(keydSigner({ env: { ...env, AGENT_BOT_KEYD_TEAM_ID: '', AGENT_BOT_KEYD_IDENTIFIER: ' ' } }),
    { teamId: null, identifier: 'agent-bot-keyd' });
  assert.equal(developerIdRequirement(keydSigner({ env: configured })), 'anchor apple generic and identifier "org.example.keyd"'
    + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"');
});

test('with no keyd Team ID configured nothing is verified, run or pinned', (t) => {
  const { dir } = home(t);
  const env = { HOME: dir };
  assert.equal(pinnedPresenceKey({ env, record: { bin: '/x/agent-bot-keyd' },
    verifyBinary: () => assert.fail('never verified without a team'), run: () => assert.fail('never run') }), null);
  assert.throws(() => readFileSync(presencePinPath({ env })), { code: 'ENOENT' });
});

test('only an explicit any-developer-id brings back the requirement from before #594', (t) => {
  const { dir, env } = home(t);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ settings: { keydTeamId: ANY_DEVELOPER_ID, keydIdentifier: ANY_DEVELOPER_ID } }));
  assert.equal(developerIdRequirement(keydSigner({ env: { HOME: env.HOME, AGENT_BOT_CONFIG: config } })),
    'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists');
  assert.equal(developerIdRequirement({ teamId: ANY_DEVELOPER_ID }),
    'anchor apple generic and identifier "agent-bot-keyd" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists');
});

test('a malformed keyd signer is refused, so nothing reaches the code-signing requirement', (t) => {
  const { dir, env } = home(t);
  for (const bad of ['z5dm34qs5u', 'Z5DM34QS5', 'Z5DM34QS5U" or anchor apple', 'any']) {
    assert.throws(() => keydSigner({ env: { ...env, AGENT_BOT_KEYD_TEAM_ID: bad } }), /invalid AGENT_BOT_KEYD_TEAM_ID/);
  }
  assert.throws(() => keydSigner({ env: { ...env, AGENT_BOT_KEYD_IDENTIFIER: 'keyd" or anchor apple' } }), /invalid AGENT_BOT_KEYD_IDENTIFIER/);
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ settings: { keydTeamId: 42 } }));
  const bare = { HOME: env.HOME, AGENT_BOT_CONFIG: config };
  assert.throws(() => keydSigner({ env: bare }), /settings\.keydTeamId/);
  // The config loads as a whole: overriding only the bad value is not enough,
  // while overriding both never reads it.
  assert.throws(() => keydSigner({ env: { ...bare, AGENT_BOT_KEYD_TEAM_ID: 'ABCDE12345' } }), /settings\.keydTeamId/);
  assert.deepEqual(keydSigner({ env: { ...bare, AGENT_BOT_KEYD_TEAM_ID: 'ABCDE12345',
    AGENT_BOT_KEYD_IDENTIFIER: 'org.example.keyd' } }), { teamId: 'ABCDE12345', identifier: 'org.example.keyd' });

  // pinnedPresenceKey treats it like an unsigned binary: nothing is run or pinned.
  assert.equal(pinnedPresenceKey({ env: { ...env, AGENT_BOT_KEYD_TEAM_ID: 'bad' }, record: { bin: '/x/agent-bot-keyd' },
    verifyBinary: () => assert.fail('never verified against a malformed requirement'),
    run: () => assert.fail('never run') }), null);
  assert.throws(() => readFileSync(presencePinPath({ env })), { code: 'ENOENT' });
});

test('the binary is verified against the configured team and identifier before it is run', (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const checked = [];
  assert.equal(pinnedPresenceKey({ env, record: { bin: '/x/agent-bot-keyd' },
    verifyBinary: (bin, requirement) => checked.push([bin, requirement]), run: () => key.raw,
    approve: () => assert.fail('a specific team is not a loosening') }), key.raw);
  assert.deepEqual(checked, [['/x/agent-bot-keyd', 'anchor apple generic and identifier "agent-bot-keyd"'
    + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "ABCDE12345"']]);
  assert.deepEqual(JSON.parse(readFileSync(presenceSignerPath({ env }), 'utf8')), { teamId: TEAM, identifier: 'agent-bot-keyd' });
  assert.equal(statSync(presenceSignerPath({ env })).mode & 0o777, 0o600);
});

// Loosening who may sign keyd is the owner's call (#594).
test('pinning under any Developer ID needs the owner and leaves a receipt', (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const loose = { ...env, AGENT_BOT_KEYD_TEAM_ID: ANY_DEVELOPER_ID };
  const receipts = [];
  const seams = { env: loose, record: { bin: '/x/agent-bot-keyd' }, verifyBinary: () => {}, run: () => key.raw,
    receipt: (entry) => receipts.push(entry) };

  assert.throws(() => pinnedPresenceKey({ ...seams, approve: () => { throw new Error('owner approval was cancelled'); },
    run: () => assert.fail('never run without the owner') }), { code: 'keyd-signer-unverified' });
  assert.throws(() => readFileSync(presencePinPath({ env })), { code: 'ENOENT' });
  assert.deepEqual(receipts.map(({ decision }) => decision), ['refused']);

  const asked = [];
  assert.equal(pinnedPresenceKey({ ...seams, approve: (signer, options) => asked.push([signer, options]) }), key.raw);
  assert.deepEqual(asked, [[{ teamId: ANY_DEVELOPER_ID, identifier: 'agent-bot-keyd' }, { previous: null }]]);
  assert.deepEqual(receipts.map(({ event, operation, decision }) => [event, operation, decision]),
    [['keyd-signer', 'pin-presence-key', 'refused'], ['keyd-signer', 'pin-presence-key', 'approved']]);
  assert.match(receipts[1].detail, /any Developer ID team as agent-bot-keyd/);
});

test('pinning again under another team than the pin was taken under needs the owner', (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const base = { record: { bin: '/x/agent-bot-keyd' }, verifyBinary: () => {}, run: () => key.raw, receipt: () => {} };
  assert.equal(pinnedPresenceKey({ ...base, env, approve: () => assert.fail('a first pin is not a change') }), key.raw);
  rmSync(presencePinPath({ env }));
  const other = { ...env, AGENT_BOT_KEYD_TEAM_ID: 'ZZZZZ99999' };
  assert.throws(() => pinnedPresenceKey({ ...base, env: other, approve: () => { throw new Error('no'); } }),
    { code: 'keyd-signer-unverified' });
  const asked = [];
  assert.equal(pinnedPresenceKey({ ...base, env: other, approve: (signer, options) => asked.push([signer, options]) }), key.raw);
  assert.deepEqual(asked, [[{ teamId: 'ZZZZZ99999', identifier: 'agent-bot-keyd' }, { previous: { teamId: TEAM, identifier: 'agent-bot-keyd' } }]]);
  assert.deepEqual(JSON.parse(readFileSync(presenceSignerPath({ env }), 'utf8')), { teamId: 'ZZZZZ99999', identifier: 'agent-bot-keyd' });
  // The same team again asks nobody.
  rmSync(presencePinPath({ env }));
  assert.equal(pinnedPresenceKey({ ...base, env: other, approve: () => assert.fail('same signer') }), key.raw);
});

test('an unapproved signer refuses the owner action with its code, never falling back to the dialog', async (t) => {
  const { env } = home(t);
  const pinned = () => { throw Object.assign(new Error('the keyd signer was not approved by the owner'), { code: 'keyd-signer-unverified' }); };
  const presence = (summary, options) => keydPresence(summary, { ...options, pinned });
  await assert.rejects(presenceOrConsent(`soul comms ${ID} off`, { env, presence,
    consent: () => assert.fail('a refusal never falls back'), summarize: (text) => text }), { code: 'keyd-signer-unverified' });
});

test('the presence key is pinned from the signed binary, once, and never from the socket', (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const runs = [];
  const seams = { env, record: { bin: '/Applications/GeniusBar.app/Contents/MacOS/agent-bot-keyd' },
    verifyBinary: (bin) => runs.push(['verify', bin]), run: (bin) => { runs.push(['run', bin]); return `${key.raw}\n`; } };
  assert.equal(pinnedPresenceKey(seams), key.raw);
  const file = presencePinPath({ env });
  assert.equal(readFileSync(file, 'utf8'), `${key.raw}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(pinnedPresenceKey({ ...seams, run: () => assert.fail('a pinned key is not asked again') }), key.raw);
  assert.deepEqual(runs.map(([what]) => what), ['verify', 'run']);
});

test('no keyd, an unsigned keyd or a malformed answer pins nothing', (t) => {
  const { env } = home(t);
  assert.equal(pinnedPresenceKey({ env, record: null }), null);
  assert.equal(pinnedPresenceKey({ env, record: { bin: '/x/agent-bot-keyd' },
    verifyBinary: () => { throw new Error('code object is not signed at all'); },
    run: () => assert.fail('an unsigned binary is never run') }), null);
  assert.equal(pinnedPresenceKey({ env, record: { bin: '/x/agent-bot-keyd' }, verifyBinary: () => {}, run: () => 'not a key' }), null);
  assert.throws(() => readFileSync(presencePinPath({ env })), { code: 'ENOENT' });
});

test('a corrupt pin is replaced from the binary and left owner-only', (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const file = presencePinPath({ env });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'not a key\n', { mode: 0o644 });
  assert.equal(pinnedPresenceKey({ env, record: { bin: '/x/agent-bot-keyd' }, verifyBinary: () => {},
    run: () => `${key.raw}\n` }), key.raw);
  assert.equal(readFileSync(file, 'utf8'), `${key.raw}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a pin that does not parse as a key is pinned again from the signed binary', (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const file = presencePinPath({ env });
  writeFileSync(file, 'not a key\n', { mode: 0o600 });
  const runs = [];
  assert.equal(pinnedPresenceKey({ env, record: { bin: '/x/agent-bot-keyd' },
    verifyBinary: () => runs.push('verify'), run: () => { runs.push('run'); return key.raw; } }), key.raw);
  assert.deepEqual(runs, ['verify', 'run']);
  assert.equal(readFileSync(file, 'utf8'), `${key.raw}\n`);
});

test('keydPresence asks keyd with the action and a fresh nonce, and checks the answer', async (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const action = `turn agent comms off for Bill (${ID})`;
  const calls = [];
  const request = async (socket, method, params, options) => {
    calls.push({ socket, method, params, options });
    return { assertion: key.assertion(params.action, { nonce: params.nonce }) };
  };
  const seams = { env, pinned: () => key.raw, request, now: () => NOW, nonce: () => NONCE };
  assert.deepEqual(await keydPresence(action, seams), { method: 'presence', via: 'agent-bot-keyd' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'owner/presence');
  assert.match(calls[0].socket, /keyd\/owner\.sock$/);
  assert.deepEqual(calls[0].params, { action, nonce: NONCE });

  // A socket that answers without keyd's key is refused, not trusted.
  await assert.rejects(keydPresence(action, { ...seams, request: async (s, m, params) => ({ assertion: presenceKey().assertion(params.action) }) }),
    { code: 'presence-invalid' });
  // A replayed assertion for another nonce is refused too.
  await assert.rejects(keydPresence(action, { ...seams, nonce: () => 'zyxwvutsrqponmlkjihgfedc', request: async () => ({ assertion: key.assertion(action) }) }),
    { code: 'presence-invalid' });
});

test('keydPresence tells "nobody can be asked" apart from "the owner said no"', async (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const failing = (error) => ({ env, pinned: () => key.raw, now: () => NOW, request: async () => { throw error; } });
  await assert.rejects(keydPresence('x', { env, pinned: () => null }), { code: 'presence-unavailable' });
  await assert.rejects(keydPresence('x', failing(Object.assign(new Error('agent-bot-keyd is not running'), { code: 'keyd-unavailable' }))),
    { code: 'presence-unavailable' });
  await assert.rejects(keydPresence('x', failing(Object.assign(new Error('the owner cannot be asked here (-1004)'), { code: 'keyd-refused', rpcCode: -32001 }))),
    { code: 'presence-unavailable' });
  await assert.rejects(keydPresence('x', failing(Object.assign(new Error('the owner did not approve (-2)'), { code: 'keyd-refused', rpcCode: -32000 }))),
    { code: 'owner-declined' });
  await assert.rejects(keydPresence('x', failing(Object.assign(new Error('agent-bot-keyd did not answer in time'), { code: 'keyd-timeout' }))),
    { code: 'owner-declined' });
});

test('keydAttestPins asks keyd to record the whole key set and checks the record is that set', async (t) => {
  const { env } = home(t);
  const key = presenceKey();
  const pins = [{ name: 'yubikey', store: 'ssh', alg: 'sshsig', publicKey: 'sk-ssh-ed25519@openssh.com AAAA', fingerprint: `SHA256:${'A'.repeat(43)}`,
    verifyRequired: false, softwareKey: false, pinnedAt: '2026-10-10T00:00:00.000Z' }];
  const calls = [];
  const recording = (digest = pinSetDigest(pins)) => async (socket, method, params, options) => {
    calls.push({ socket, method, params, options });
    return { attestation: key.pins({ digest, generation: 4, nonce: params.nonce }) };
  };
  const seams = { env, pinned: () => key.raw, request: recording(), now: () => NOW, nonce: () => NONCE };
  assert.deepEqual(await keydAttestPins(pins, seams), { digest: pinSetDigest(pins), generation: 4 });
  assert.equal(calls[0].method, 'owner/pins-attest');
  assert.match(calls[0].socket, /keyd\/owner\.sock$/);
  assert.deepEqual(calls[0].params, { pins, nonce: NONCE });
  assert.equal(calls[0].options.timeoutMs, 150_000);

  // keyd recorded some other set, or something without keyd's key answered.
  await assert.rejects(keydAttestPins(pins, { ...seams, request: recording(pinSetDigest([])) }), { code: 'pins-invalid' });
  await assert.rejects(keydAttestPins(pins, { ...seams, pinned: () => presenceKey().raw }), { code: 'pins-invalid' });
  // A presence assertion is not a record of the owner's keys.
  await assert.rejects(keydAttestPins(pins, { ...seams, request: async (s, m, params) => ({ attestation: key.assertion('x', { nonce: params.nonce }) }) }),
    { code: 'pins-invalid' });

  const failing = (error) => ({ ...seams, request: async () => { throw error; } });
  await assert.rejects(keydAttestPins(pins, { env, pinned: () => null }), { code: 'presence-unavailable' });
  await assert.rejects(keydAttestPins(pins, failing(Object.assign(new Error('agent-bot-keyd is not running'), { code: 'keyd-unavailable' }))),
    { code: 'presence-unavailable' });
  await assert.rejects(keydAttestPins(pins, failing(Object.assign(new Error('the owner cannot be asked here'), { code: 'keyd-refused', rpcCode: -32001 }))),
    { code: 'presence-unavailable' });
  // A keyd from before #753 does not know the method: nobody could be asked.
  await assert.rejects(keydAttestPins(pins, failing(Object.assign(new Error('method not found'), { code: 'keyd-refused', rpcCode: -32601 }))),
    { code: 'presence-unavailable', message: /cannot record owner keys/ });
  await assert.rejects(keydAttestPins(pins, failing(Object.assign(new Error('the owner did not approve (-2)'), { code: 'keyd-refused', rpcCode: -32000 }))),
    { code: 'owner-declined' });
});

test('the gate asks keyd first and falls back to the administrator dialog only when keyd cannot ask', async () => {
  const action = `soul comms ${ID} off`;
  const souls = [{ id: ID, name: 'Bill - Starter' }];
  const summarize = (text) => ownerActionSummary(text, { souls });
  const asked = [];
  const presence = (summary) => { asked.push(['presence', summary]); return { method: 'presence', via: 'agent-bot-keyd' }; };
  const consent = (text, { summary }) => { asked.push(['consent', text, summary]); return { method: 'consent' }; };
  assert.deepEqual(await presenceOrConsent(action, { presence, consent, summarize }), { method: 'presence', via: 'agent-bot-keyd' });
  assert.deepEqual(asked, [['presence', `turn agent comms off for Bill - Starter (${ID})`]]);

  asked.length = 0;
  const unavailable = () => { throw Object.assign(new Error('no GUI session'), { code: 'presence-unavailable' }); };
  assert.deepEqual(await presenceOrConsent(action, { presence: unavailable, consent, summarize }), { method: 'consent' });
  assert.deepEqual(asked, [['consent', action, `turn agent comms off for Bill - Starter (${ID})`]]);

  asked.length = 0;
  for (const code of ['owner-declined', 'presence-invalid']) {
    const refusing = () => { throw Object.assign(new Error(code), { code }); };
    await assert.rejects(presenceOrConsent(action, { presence: refusing, consent, summarize }), /was not approved/);
  }
  assert.deepEqual(asked, [], 'a refusal never falls back to another prompt');

  // A soul is refused before anyone is asked, keyd included.
  await assert.rejects(assertOwnerAction(action, { markers: () => ['Agent ID'], consent: () => assert.fail('never asked') }), /owner only/);
});

test('prompts name the soul by name and Agent ID, and the change', () => {
  const souls = [{ id: ID, name: 'Bill - Starter' }];
  const say = (action) => ownerActionSummary(action, { souls });
  const bill = `Bill - Starter (${ID})`;
  assert.equal(say(`soul comms ${ID} on`), `turn agent comms on for ${bill}`);
  assert.equal(say(`soul cold-wake ${ID} off`), `turn waking on new messages off for ${bill}`);
  assert.equal(say(`soul cold-wake ${ID} resume read-only`), `let ${bill} wake on new messages by resuming its session (read-only)`);
  assert.equal(say(`soul cold-wake ${ID} webhook`), `let a webhook wake ${bill} when messages arrive`);
  assert.equal(say(`soul confinement ${ID} deny`), `set file confinement to deny for ${bill}`);
  assert.equal(say(`soul revision approve ${ID}`), `approve a revision of ${bill}`);
  assert.equal(say(`identity migrate-credentials ${ID} --to keyd`), `move the GitHub App key of ${bill} to agent-bot-keyd`);
  assert.equal(say('identity migrate-credentials --all'), "move every soul's GitHub App key");
  assert.equal(say('identity migrate-credentials --all --from-namespace agent-bot'),
    "copy every soul's credentials from the agent-bot credential names to this host's");
  assert.equal(say(`identity migrate-credentials ${ID} --from-namespace agent-bot`),
    `copy the credentials of ${bill} from the agent-bot credential names to this host's`);
  assert.equal(say('identity migrate-credentials --all --from-vault Old Vault'),
    "copy every soul's credentials from the Old Vault pass-cli vault to this host's");
  assert.equal(say(`identity migrate-credentials ${ID} --from-namespace old.host --from-vault Old Vault`),
    `copy the credentials of ${bill} from the old.host credential names and the Old Vault pass-cli vault to this host's`);
  assert.equal(say(`soul remove ${ID}`), `remove ${bill} from this Mac (its folders are archived, not deleted)`);
  assert.equal(say(`soul remove ${ID} --scope team`), `remove ${bill} and every soul it leads from this Mac (their folders are archived, not deleted)`);
  const digest = 'ab'.repeat(32);
  assert.equal(say(`soul mode ${ID} autopilot repo sha256:${digest} /work/my repo/.claude/settings.json`),
    `let ${bill} run in Auto-Pilot, as its repo asks (/work/my repo/.claude/settings.json, sha256:abababababab)`);
  assert.equal(say(`soul mode ${ID} autopilot soul sha256:${digest} /souls/bill.soul/soul.json`),
    `let ${bill} run in Auto-Pilot, as its soul package asks (/souls/bill.soul/soul.json, sha256:abababababab)`);
  // Anything else keeps its words, with each soul named.
  assert.equal(say(`soul spawn ${ID}`), `soul spawn ${bill}`);
  // The name a launch or join gave the soul wins over its handle (#429).
  assert.equal(ownerActionSummary(`soul comms ${ID} off`, { souls: [{ id: ID, name: 'mild-rowan-48', displayName: 'VMStarter' }] }),
    `turn agent comms off for VMStarter (${ID})`);
  assert.equal(ownerActionSummary(`soul comms ${ID} off`, { souls: [] }), `turn agent comms off for ${ID}`);
  assert.ok(say(`trusting SOP repository ${'x'.repeat(500)}`).length <= 400);
});

test('with no keyd installed the gate uses the administrator dialog, as before', async (t) => {
  const { env } = home(t);
  const seen = [];
  const consent = (action, options) => presenceOrConsent(action, { ...options,
    consent: (text, { summary }) => { seen.push(summary); return { method: 'consent' }; } });
  assert.deepEqual(await assertOwnerAction(`soul comms ${ID} off`, { env, markers: () => [], consent }), { method: 'consent' });
  assert.deepEqual(seen, [`turn agent comms off for ${ID}`]);
});

test('a long prompt is cut by code point, never inside an emoji', () => {
  const action = `soul confinement ${ID} ${'a'.repeat(374)}😀😀`;
  const summary = ownerActionSummary(action, { souls: [] });
  assert.equal(Array.from(summary).length, 400); // 24 + 374 units put an emoji across the 399-unit cut
  assert.ok(summary.endsWith('…'));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(summary), false);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify({ summary })));
});

// The Team ID is the organization's to name (#594, #752): the profile
// projects it into config, names only a specific signer, and survives the
// projection check that lets a newer profile replace the config.
test('the organization profile names the keyd signer and never loosens it', () => {
  const profile = (settings) => ({
    schema_version: ORGANIZATION_PROFILE_SCHEMA_VERSION,
    organization: 'example-engineering',
    account_owner: 'example-owner',
    minimum_runtime_interface_version: 1,
    defaults: { claude: 'example-claude-agent' },
    identities: [{ slug: 'example-claude-agent', harness: 'claude', status: 'active' }],
    settings,
  });
  const config = organizationProfileToConfig(validateOrganizationProfile(profile({ keyd_team_id: TEAM, keyd_identifier: 'org.example.keyd' })));
  assert.deepEqual(config.settings, { keydTeamId: TEAM, keydIdentifier: 'org.example.keyd' });
  assert.deepEqual(keydSigner({ env: {}, config }), { teamId: TEAM, identifier: 'org.example.keyd' });
  assert.equal(isProjectedRuntimeConfig(config), true);
  for (const bad of [ANY_DEVELOPER_ID, 'abcde12345', 'ABCDE1234', 42]) {
    assert.throws(() => validateOrganizationProfile(profile({ keyd_team_id: bad })), /keyd_team_id/);
  }
  for (const bad of [ANY_DEVELOPER_ID, 'keyd" or anchor apple', '']) {
    assert.throws(() => validateOrganizationProfile(profile({ keyd_identifier: bad })), /keyd_identifier/);
  }
});
