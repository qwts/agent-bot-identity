import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appIdPath, ensurePrivateKey, parseCliArgs, parsePassItemView, privateKeyPath,
  selectIssuer, selectPrivateKeyAttachment, validateIssuer,
} from '../ensure-private-key.mjs';

const VIEW = JSON.stringify({
  item: { id: 'item-1', share_id: 'share-1' },
  attachments: [{ id: 'attachment-1', content: { name: 'private-key.pem' } }],
});

function viewWith({ sections, extraFields, note } = {}) {
  return JSON.stringify({
    item: {
      id: 'item-1',
      share_id: 'share-1',
      content: {
        note: note ?? '',
        content: { Custom: { sections: sections ?? [] } },
        extra_fields: extraFields ?? [],
      },
    },
    attachments: [{ id: 'attachment-1', content: { name: 'private-key.pem' } }],
  });
}

test('private key CLI accepts positional/flag slugs and force', () => {
  assert.deepEqual(parseCliArgs(['bot-app']), { force: false, explicit: 'bot-app' });
  assert.deepEqual(parseCliArgs(['--force', '--app', 'bot-app']), {
    force: true, explicit: 'bot-app',
  });
  assert.throws(() => parseCliArgs(['--app']), /requires a slug/);
});

test('pass-cli JSON selects only an unambiguous pem attachment', () => {
  const parsed = parsePassItemView(VIEW);
  assert.equal(parsed.shareId, 'share-1');
  assert.equal(selectPrivateKeyAttachment(parsed.attachments).id, 'attachment-1');
  assert.throws(() => selectPrivateKeyAttachment([]), /no unambiguous/);
});

test('ensurePrivateKey is idempotent and downloads without reading key contents', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  const path = privateKeyPath('bot-app', home);
  const calls = [];
  const result = ensurePrivateKey({
    slug: 'bot-app', home,
    run: (args) => {
      calls.push(args);
      if (args[1] === 'view') return VIEW;
      writeFileSync(path, 'fixture material\n');
      return '';
    },
  });
  assert.equal(result.downloaded, true);
  assert.equal(calls.length, 2);
  assert.equal(readFileSync(path, 'utf8').length > 0, true);
  // No issuer in the vault item is a warning, not a failure: the key still lands.
  assert.equal(result.issuerMissing, true);
  writeFileSync(appIdPath('bot-app', home), '4376641\n');
  assert.equal(ensurePrivateKey({ slug: 'bot-app', home }).downloaded, false);
});

test('an issuer is accepted only as a numeric App ID or a client ID', () => {
  assert.equal(validateIssuer('4376641'), '4376641');
  assert.equal(validateIssuer('  Iv23liq8jJy0gS7h1nUg '), 'Iv23liq8jJy0gS7h1nUg');
  // A pasted PEM or a stray label must never reach the JWT `iss`.
  assert.equal(validateIssuer('-----BEGIN RSA PRIVATE KEY-----'), null);
  assert.equal(validateIssuer('app-id'), null);
  assert.equal(validateIssuer(undefined), null);
});

test('the issuer is read from a custom field, a flat field, or a note line', () => {
  const fromSection = parsePassItemView(viewWith({
    sections: [{ fields: [{ field_name: 'App ID', field_type: 'text', value: '4376641' }] }],
  }));
  assert.equal(selectIssuer(fromSection), '4376641');

  const fromExtra = parsePassItemView(viewWith({
    extraFields: [{ field_name: 'client_id', value: { text: 'Iv23liq8jJy0gS7h1nUg' } }],
  }));
  assert.equal(selectIssuer(fromExtra), 'Iv23liq8jJy0gS7h1nUg');

  const fromNote = parsePassItemView(viewWith({ note: 'github app\napp-id: 4394024\n' }));
  assert.equal(selectIssuer(fromNote), '4394024');

  // A field wins over the note, and the numeric App ID wins over a client ID.
  const both = parsePassItemView(viewWith({
    sections: [{ fields: [{ field_name: 'client-id', value: 'Iv23li5ONNO5JE3oN0nF' }] }],
    extraFields: [{ field_name: 'app-id', value: '4392447' }],
    note: 'app-id: 9999999',
  }));
  assert.equal(selectIssuer(both), '4392447');

  assert.equal(selectIssuer(parsePassItemView(viewWith({}))), null);
});

test('ensurePrivateKey writes the app-id beside the key from one item view', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  const calls = [];
  const result = ensurePrivateKey({
    slug: 'bot-app', home,
    run: (args) => {
      calls.push(args);
      if (args[1] === 'view') {
        return viewWith({ sections: [{ fields: [{ field_name: 'App ID', value: '4376641' }] }] });
      }
      writeFileSync(privateKeyPath('bot-app', home), 'fixture material\n');
      return '';
    },
  });
  assert.equal(result.appIdWritten, true);
  assert.equal(result.issuerMissing, false);
  assert.equal(readFileSync(appIdPath('bot-app', home), 'utf8'), '4376641\n');
  // Both present -> fully idempotent, no pass-cli call at all.
  const before = calls.length;
  assert.equal(ensurePrivateKey({ slug: 'bot-app', home }).downloaded, false);
  assert.equal(calls.length, before);
});

test('a present key with a missing app-id still triggers the issuer restore', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  mkdirSync(join(home, '.config', 'bot-app'), { recursive: true });
  writeFileSync(privateKeyPath('bot-app', home), 'existing key\n');
  const calls = [];
  const result = ensurePrivateKey({
    slug: 'bot-app', home,
    run: (args) => {
      calls.push(args);
      return viewWith({ note: 'app-id: 4469551' });
    },
  });
  assert.equal(result.downloaded, false);
  assert.equal(result.appIdWritten, true);
  assert.equal(readFileSync(appIdPath('bot-app', home), 'utf8'), '4469551\n');
  // Only the view — the existing key is never re-downloaded.
  assert.deepEqual(calls.map((args) => args[1]), ['view']);
});
