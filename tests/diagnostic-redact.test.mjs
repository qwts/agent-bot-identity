import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentSecrets, HOME_PATH, REDACTED, redactDiagnostic, redactError } from '../diagnostic-redact.mjs';

const HOME = '/Users/canary-person';
const opts = { env: {}, home: HOME };

// Canaries: none of these may survive redaction (#983).
const CANARIES = {
  github: 'ghs_CANARYcanary0123456789abcdefABCDEF',
  pat: 'github_pat_11CANARY0123456789_abcdefghijklmnopqrstuvwxyz',
  bearer: 'Authorization: Bearer CANARYbearer.0123456789-abc',
  jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJDQU5BUlkifQ.c2lnbmF0dXJlQ0FOQVJZ',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIICANARYkeymaterial\n-----END RSA PRIVATE KEY-----',
  anthropic: 'sk-ant-api03-CANARYkey0123456789abcdef',
  slack: 'xoxb-1234567890-CANARYslack',
  aws: 'AKIACANARY0123456789',
  telegram: '123456789:AAECANARYtelegramtoken0123456789abc',
  userinfo: 'https://x-access-token:CANARYurlpass@github.com/qwts/repo.git',
  query: 'https://example.test/hook?token=CANARYquery&ok=1',
};

test('known token shapes are redacted', () => {
  for (const [name, canary] of Object.entries(CANARIES)) {
    const out = redactDiagnostic(`failed: ${canary} (end)`, opts);
    assert.equal(/CANARY/i.test(out), false, `${name}: ${out}`);
    assert.ok(out.includes(REDACTED), name);
    assert.ok(out.startsWith('failed: ') && out.endsWith('(end)'), `${name} keeps the surrounding text: ${out}`);
  }
  assert.equal(redactDiagnostic(CANARIES.userinfo, opts), `https://${REDACTED}@github.com/qwts/repo.git`);
  assert.equal(redactDiagnostic(CANARIES.query, opts), `https://example.test/hook?token=${REDACTED}&ok=1`);
});

test('credential-named environment values and named secrets are redacted', () => {
  const env = { GH_TOKEN: 'opaque-canary-value-1', MY_API_KEY: 'opaque-canary-value-2', PATH: '/usr/bin:/bin', SHORT_TOKEN: 'abc' };
  assert.deepEqual(environmentSecrets(env).sort(), ['opaque-canary-value-1', 'opaque-canary-value-2']);
  const out = redactDiagnostic('a opaque-canary-value-1 b opaque-canary-value-2 c custom-canary d /usr/bin:/bin abc', {
    env, home: HOME, secrets: ['custom-canary'],
  });
  assert.equal(out, `a ${REDACTED} b ${REDACTED} c ${REDACTED} d /usr/bin:/bin abc`);
});

test('paths under any home directory are redacted, quoted ones whole', () => {
  const cases = [
    [`EACCES: permission denied, open '${HOME}/.claude/projects/-work repo/s.jsonl'`, `EACCES: permission denied, open '${HOME_PATH}'`],
    [`ENOENT ${HOME}/secret-project/file.txt next`, `ENOENT ${HOME_PATH} next`],
    [`stat "/private${HOME}/a b"`, `stat "${HOME_PATH}"`],
    ['other /Users/someone-else/x and /home/linuxuser/y', `other ${HOME_PATH} and ${HOME_PATH}`],
    ['win C:\\Users\\winuser\\AppData\\x.log', `win ${HOME_PATH}`],
    [`just ${HOME}`, `just ${HOME_PATH}`],
  ];
  for (const [input, expected] of cases) assert.equal(redactDiagnostic(input, opts), expected);
  // A custom home outside /Users is matched too; system paths are kept.
  assert.equal(redactDiagnostic('open /srv/home-x/.config/a and /usr/local/bin/node', { env: {}, home: '/srv/home-x/' }),
    `open ${HOME_PATH} and /usr/local/bin/node`);
});

test('output is one bounded line and never throws', () => {
  assert.equal(redactDiagnostic('a\nb\u0000c\u2028d', opts), 'a b c d');
  const long = redactDiagnostic('x'.repeat(2000), { ...opts, maxLength: 50 });
  assert.equal(long.length, 50);
  assert.ok(long.endsWith('…'));
  const hostile = { get message() { throw new Error('boom'); } };
  assert.equal(redactDiagnostic(hostile, opts), REDACTED);
  assert.equal(redactDiagnostic(undefined, opts), '');
  assert.equal(redactDiagnostic(new Error(`bad ${CANARIES.github}`), opts), `bad ${REDACTED}`);
});

test('redactError keeps only a short identifier code', () => {
  const error = Object.assign(new Error(`open '${HOME}/x'`), { code: 'EACCES' });
  assert.deepEqual(redactError(error, opts), { code: 'EACCES', message: `open '${HOME_PATH}'` });
  assert.equal(redactError(Object.assign(new Error('x'), { code: `bad code ${CANARIES.github}` }), { ...opts, fallbackCode: 'collect-failed' }).code, 'collect-failed');
  assert.equal(redactError('plain', opts).code, 'error');
});
