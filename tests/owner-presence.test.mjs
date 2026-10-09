import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertOwnerAction, ownerActionSummary, presenceOrConsent } from '../owner-action.mjs';
import { actionDigest, keydPresence, pinnedPresenceKey, presencePinPath, verifyPresence } from '../owner-presence.mjs';

const ID = 'agent_121b5b35-0000-4000-8000-000000000000';
const NOW = Date.parse('2026-10-03T22:00:00Z');
const SECONDS = Math.floor(NOW / 1000);
const NONCE = 'abcdefghijklmnopqrstuvwx';

// keyd's presence key, as the Rust side holds it.
function presenceKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const assert_ = (payload) => {
    const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `p1.${segment}.${sign(null, Buffer.from(segment), privateKey).toString('base64url')}`;
  };
  const assertion = (action, overrides = {}) => assert_({ v: 1, aud: 'agent-bot-owner', kind: 'presence',
    action: actionDigest(action), nonce: NONCE, iat: SECONDS, exp: SECONDS + 60, ...overrides });
  return { raw, assertion };
}

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-presence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir };
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
  assert.equal(say(`soul remove ${ID}`), `remove ${bill} from this Mac (its folders are archived, not deleted)`);
  assert.equal(say(`soul remove ${ID} --scope team`), `remove ${bill} and every soul it leads from this Mac (their folders are archived, not deleted)`);
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
