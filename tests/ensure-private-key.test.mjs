import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensurePrivateKey, parseCliArgs, parsePassItemView, privateKeyPath,
  selectPrivateKeyAttachment,
} from '../ensure-private-key.mjs';

const VIEW = JSON.stringify({
  item: { id: 'item-1', share_id: 'share-1' },
  attachments: [{ id: 'attachment-1', content: { name: 'private-key.pem' } }],
});

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
  assert.equal(ensurePrivateKey({ slug: 'bot-app', home }).downloaded, false);
});
