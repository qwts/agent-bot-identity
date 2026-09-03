import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_SESSION_REQUIRED,
  appIdPath, ensurePrivateKey, parseCliArgs, parsePassItemView, privateKeyPath,
  selectAppIdAttachment, selectIssuer, selectPrivateKeyAttachment, selectPrivateKeyField,
  validateIssuer,
} from '../ensure-private-key.mjs';

function passRun(handler) {
  return (args) => {
    if (args[0] === 'info') return '{}';
    return handler(args);
  };
}

const VIEW = JSON.stringify({
  item: { id: 'item-1', share_id: 'share-1' },
  attachments: [{ id: 'attachment-1', content: { name: 'private-key.pem' } }],
});

function viewWith({ sections, extraFields, note, attachments } = {}) {
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
    attachments: attachments ?? [{ id: 'attachment-1', content: { name: 'private-key.pem' } }],
  });
}

function writeDownload(args, content) {
  writeFileSync(args[args.indexOf('--output') + 1], content);
}

test('private key CLI accepts positional/flag slugs and force', () => {
  assert.deepEqual(parseCliArgs(['bot-app']), { force: false, explicit: 'bot-app' });
  assert.deepEqual(parseCliArgs(['--force', '--app', 'bot-app']), {
    force: true, explicit: 'bot-app',
  });
  assert.throws(() => parseCliArgs(['--app']), /requires a slug/);
});

test('the CLI honors GH_AGENT_APP in any checkout (ENG-0339)', () => {
  // Same policy as mint-token's appConfig: GH_AGENT_APP is a stated identity,
  // taken at face value wherever the process runs — a `.codex/worktrees`
  // layout is not a signal. The codex App has no key material in this fake
  // home, so resolving to the layout's harness would reach for the provider
  // and fail — a clean "already present" for the claude App proves
  // GH_AGENT_APP won.
  const root = mkdtempSync(join(tmpdir(), 'agent-key-layout-'));
  const repo = join(root, '.codex', 'worktrees', 'session', 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  const home = join(root, 'home');
  const dir = join(home, '.config', 'you-claude-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app-id'), '12345\n');
  writeFileSync(
    join(dir, 'private-key.pem'),
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ type: 'pkcs8', format: 'pem' }),
  );
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ prefix: 'you' }));
  const emptyGitConfig = join(root, 'gitconfig');
  writeFileSync(emptyGitConfig, '');
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../ensure-private-key.mjs', import.meta.url))],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        AGENT_BOT_CONFIG: configPath,
        GH_AGENT_APP: 'you-claude-agent',
        AGENT_BOT_ACCOUNT: 'user',
        GIT_CONFIG_GLOBAL: emptyGitConfig,
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  );
  assert.match(output, /already present .*you-claude-agent/);
});

test('pass-cli JSON selects only an unambiguous pem attachment', () => {
  const parsed = parsePassItemView(VIEW);
  assert.equal(parsed.shareId, 'share-1');
  assert.equal(selectPrivateKeyAttachment(parsed.attachments).id, 'attachment-1');
  assert.throws(() => selectPrivateKeyAttachment([]), /no unambiguous/);
});

// The live pass-cli prints sections as `section_fields` with typed value
// wrappers (`content.Text` / `content.Hidden`); older builds and fixtures use
// `fields` with bare values. Both spellings must resolve — items whose PEM
// lives in a hidden "Private Key" field are invisible under the old parser.
test('custom fields are read from the live section_fields and content.Text/Hidden shapes', () => {
  const parsed = parsePassItemView(viewWith({
    sections: [{
      section_fields: [
        { name: 'App ID', content: { Text: '4376641' } },
        { name: 'Private Key', content: { Hidden: '-----BEGIN KEY-----\nabc\n-----END KEY-----' } },
      ],
    }],
    attachments: [],
  }));
  assert.equal(selectIssuer(parsed), '4376641');
  // collectFields trims; the selector must hand back a newline-terminated PEM.
  assert.equal(
    selectPrivateKeyField(parsed.fields),
    '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
  );

  const fromExtra = parsePassItemView(viewWith({
    extraFields: [{ name: 'Private Key', content: { Text: 'pem material' } }],
  }));
  assert.equal(selectPrivateKeyField(fromExtra.fields), 'pem material\n');
  assert.equal(selectPrivateKeyField(parsePassItemView(viewWith({})).fields), null);
});

test('the key restores from the "Private Key" field when the item has no attachment', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  const calls = [];
  const result = ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun((args) => {
      calls.push(args);
      return viewWith({
        sections: [{
          section_fields: [
            { name: 'App ID', content: { Text: '4376641' } },
            { name: 'Private Key', content: { Hidden: 'field material' } },
          ],
        }],
        attachments: [],
      });
    }),
    validateKey: () => true,
  });
  assert.equal(result.appIdWritten, true);
  assert.equal(readFileSync(privateKeyPath('bot-app', home), 'utf8'), 'field material\n');
  assert.equal(statSync(privateKeyPath('bot-app', home)).mode & 0o777, 0o600);
  assert.ok(!calls.some((args) => args.includes('download')));
});

test('a private-key.pem attachment stays preferred over the field', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun((args) => {
      if (args[1] === 'view') {
        return viewWith({
          sections: [{
            section_fields: [
              { name: 'App ID', content: { Text: '4376641' } },
              { name: 'Private Key', content: { Hidden: 'field material' } },
            ],
          }],
        });
      }
      writeDownload(args, 'attachment material\n');
      return '';
    }),
    validateKey: () => true,
  });
  assert.equal(readFileSync(privateKeyPath('bot-app', home), 'utf8'), 'attachment material\n');
});

// Two conflicting .pem attachments must fail closed even when a "Private Key"
// field could answer — restoring the field would silently pick a third
// candidate the operator never chose.
test('ambiguous pem attachments never fall through to the field', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  assert.throws(() => ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun(() => viewWith({
      sections: [{
        section_fields: [
          { name: 'App ID', content: { Text: '4376641' } },
          { name: 'Private Key', content: { Hidden: 'field material' } },
        ],
      }],
      attachments: [
        { id: 'attachment-1', content: { name: 'old-key.pem' } },
        { id: 'attachment-2', content: { name: 'new-key.pem' } },
      ],
    })),
    validateKey: () => true,
  }), /multiple private-key\.pem candidates/);
  assert.equal(existsSync(privateKeyPath('bot-app', home)), false);
});

test('missing both the attachment and the field names both restore sources', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  assert.throws(() => ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun(() => viewWith({
      sections: [{ section_fields: [{ name: 'App ID', content: { Text: '4376641' } }] }],
      attachments: [],
    })),
    validateKey: () => true,
  }), /no private-key\.pem attachment or "Private Key" field/);
  assert.equal(existsSync(privateKeyPath('bot-app', home)), false);
});

test('ensurePrivateKey fails closed when the provider item has no issuer', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  const path = privateKeyPath('bot-app', home);
  assert.throws(() => ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun((args) => {
      if (args[1] === 'view') return VIEW;
      writeDownload(args, 'fixture material\n');
      return '';
    }),
    validateKey: () => true,
  }), /no App ID\/client ID/);
  assert.equal(existsSync(path), false);
});

test('an issuer is accepted only as a numeric App ID or a client ID', () => {
  assert.equal(validateIssuer('4376641'), '4376641');
  assert.equal(validateIssuer('  Iv23liq8jJy0gS7h1nUg '), 'Iv23liq8jJy0gS7h1nUg');
  // The legacy dotted client ID is still a valid issuer and still appears in
  // GitHub's own API docs, so the period must survive validation.
  assert.equal(validateIssuer('Iv1.8a61f9b3a7aba766'), 'Iv1.8a61f9b3a7aba766');
  // A pasted PEM or a stray label must never reach the JWT `iss`.
  assert.equal(validateIssuer('-----BEGIN RSA PRIVATE KEY-----'), null);
  assert.equal(validateIssuer('app-id'), null);
  assert.equal(validateIssuer('Iv1.'), null);
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
    run: passRun((args) => {
      calls.push(args);
      if (args[1] === 'view') {
        return viewWith({ sections: [{ fields: [{ field_name: 'App ID', value: '4376641' }] }] });
      }
      writeDownload(args, 'fixture material\n');
      return '';
    }),
    validateKey: () => true,
  });
  assert.equal(result.appIdWritten, true);
  assert.equal(readFileSync(appIdPath('bot-app', home), 'utf8'), '4376641\n');
  assert.equal(statSync(privateKeyPath('bot-app', home)).mode & 0o777, 0o600);
  // Both present -> fully idempotent, no pass-cli call at all.
  const before = calls.length;
  assert.equal(ensurePrivateKey({ slug: 'bot-app', home, validateKey: () => true }).downloaded, false);
  assert.equal(calls.length, before);
});

test('an app-id attachment is downloaded and validated when no field carries it', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  const view = JSON.stringify({
    item: { id: 'item-1', share_id: 'share-1' },
    attachments: [
      { id: 'attachment-1', content: { name: 'private-key.pem' } },
      { id: 'attachment-2', content: { name: 'app-id' } },
    ],
  });
  const downloads = [];
  const result = ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun((args) => {
      if (args[1] === 'view') return view;
      const id = args[args.indexOf('--attachment-id') + 1];
      const out = args[args.indexOf('--output') + 1];
      downloads.push(id);
      // Proton Pass stores the file verbatim, trailing newline and all.
      writeFileSync(out, id === 'attachment-2' ? '4376641\n' : 'fixture material\n');
      return '';
    }),
    validateKey: () => true,
  });
  assert.equal(result.appIdWritten, true);
  assert.equal(readFileSync(appIdPath('bot-app', home), 'utf8'), '4376641\n');
  assert.deepEqual(downloads, ['attachment-2', 'attachment-1']);
});

test('an app-id attachment holding junk fails without installing either credential half', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  const view = JSON.stringify({
    item: { id: 'item-1', share_id: 'share-1' },
    attachments: [
      { id: 'attachment-1', content: { name: 'private-key.pem' } },
      { id: 'attachment-2', content: { name: 'app-id' } },
    ],
  });
  assert.throws(() => ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun((args) => {
      if (args[1] === 'view') return view;
      const id = args[args.indexOf('--attachment-id') + 1];
      const out = args[args.indexOf('--output') + 1];
      writeFileSync(out, id === 'attachment-2' ? '-----BEGIN RSA PRIVATE KEY-----\n' : 'key\n');
      return '';
    }),
    validateKey: () => true,
  }), /restored App ID\/client ID is malformed/);
  assert.equal(existsSync(appIdPath('bot-app', home)), false);
  assert.equal(existsSync(privateKeyPath('bot-app', home)), false);
});

test('a field beats an attachment, so no second download happens', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  const view = JSON.stringify({
    item: {
      id: 'item-1',
      share_id: 'share-1',
      content: { content: { Custom: { sections: [{ fields: [{ field_name: 'app-id', value: '4394024' }] }] } } },
    },
    attachments: [
      { id: 'attachment-1', content: { name: 'private-key.pem' } },
      { id: 'attachment-2', content: { name: 'app-id' } },
    ],
  });
  const downloads = [];
  ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun((args) => {
      if (args[1] === 'view') return view;
      downloads.push(args[args.indexOf('--attachment-id') + 1]);
      writeFileSync(args[args.indexOf('--output') + 1], 'fixture material\n');
      return '';
    }),
    validateKey: () => true,
  });
  assert.equal(readFileSync(appIdPath('bot-app', home), 'utf8'), '4394024\n');
  assert.deepEqual(downloads, ['attachment-1']);
});

test('a present key with a missing app-id still triggers the issuer restore', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-'));
  mkdirSync(join(home, '.config', 'bot-app'), { recursive: true });
  writeFileSync(privateKeyPath('bot-app', home), 'existing key\n');
  const calls = [];
  const result = ensurePrivateKey({
    slug: 'bot-app', home,
    run: passRun((args) => {
      calls.push(args);
      return viewWith({ note: 'app-id: 4469551' });
    }),
    validateKey: () => true,
  });
  assert.equal(result.downloaded, false);
  assert.equal(result.appIdWritten, true);
  assert.equal(readFileSync(appIdPath('bot-app', home), 'utf8'), '4469551\n');
  // Session probe, then only the view — the existing key is never re-downloaded.
  assert.deepEqual(calls.map((args) => args[1]), ['view']);
});

test('a locked secret store fails closed before any item is read', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-key-locked-'));
  const calls = [];
  assert.throws(() => ensurePrivateKey({
    slug: 'bot-app',
    home,
    run: (args) => {
      calls.push(args);
      throw Object.assign(new Error('pass-cli'), {
        stderr: 'Error: This operation requires an authenticated client\nthere is no session\n',
      });
    },
    validateKey: () => true,
  }), (error) => {
    assert.equal(error.code, PROVIDER_SESSION_REQUIRED);
    assert.match(error.message, /secret store is unavailable/);
    return true;
  });
  assert.deepEqual(calls, [['info', '--output', 'json']]);
});
