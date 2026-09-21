import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBlock } from '../shell-path.mjs';

const BODY = 'typeset -U path PATH\npath=("$HOME/.local/bin" $path)\n';

test('ensureBlock appends a new block with a single blank separator', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const result = ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(result.updated, true);
  assert.equal(readFileSync(join(home, '.zshenv'), 'utf8'),
    '# BEGIN agent-bot-cli\n'
    + 'typeset -U path PATH\n'
    + 'path=("$HOME/.local/bin" $path)\n'
    + '# END agent-bot-cli\n');
});

test('ensureBlock rewrites an existing block in place, position stable', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const file = join(home, '.zprofile');
  writeFileSync(file,
    'unrelated one\n'
    + '# BEGIN agent-bot-cli\n'
    + 'export PATH="$HOME/.local/bin:$PATH"  # agent-bot CLI\n'
    + '# END agent-bot-cli\n'
    + 'unrelated two\n');
  const result = ensureBlock({
    dir: home,
    filename: '.zprofile',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(result.updated, true);
  assert.equal(readFileSync(file, 'utf8'),
    'unrelated one\n'
    + '# BEGIN agent-bot-cli\n'
    + 'typeset -U path PATH\n'
    + 'path=("$HOME/.local/bin" $path)\n'
    + '# END agent-bot-cli\n'
    + 'unrelated two\n');
});

test('ensureBlock is byte-identical on repeated runs', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const call = () => ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(call().updated, true);
  const once = readFileSync(join(home, '.zshenv'), 'utf8');
  assert.equal(call().updated, false);
  assert.equal(readFileSync(join(home, '.zshenv'), 'utf8'), once);
});

test('ensureBlock trims trailing blanks before appending and never grows them', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const file = join(home, '.zshenv');
  writeFileSync(file, 'alias a=1\n\n\n\n');
  const call = () => ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(call().updated, true);
  assert.equal(readFileSync(file, 'utf8'),
    'alias a=1\n'
    + '\n'
    + '# BEGIN agent-bot-cli\n'
    + 'typeset -U path PATH\n'
    + 'path=("$HOME/.local/bin" $path)\n'
    + '# END agent-bot-cli\n');
  call();
  assert.equal(readFileSync(file, 'utf8').match(/\n{3}/g), null);
});

test('ensureBlock absorbs loose lines only outside managed blocks', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const file = join(home, '.zshenv');
  writeFileSync(file,
    'export PATH="$HOME/.local/bin:$PATH"  # agent-bot CLI\n'
    + '# BEGIN agent-bot-gh-shim\n'
    + 'shim-line "$HOME/.config/agent-bot/bin" survivor\n'
    + '# END agent-bot-gh-shim\n'
    + 'tail\n');
  const result = ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    absorbMarkers: ['# agent-bot CLI'],
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(result.updated, true);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^# BEGIN agent-bot-gh-shim$/m);
  assert.match(text, /shim-line "\$HOME\/\.config\/agent-bot\/bin" survivor/);
  assert.equal(text.includes('export PATH="$HOME/.local/bin:$PATH"  # agent-bot CLI'), false);
});

test('ensureBlock delegates to zsh-profile with the body on stdin', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  let called = null;
  const result = ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    absorbMarkers: ['# agent-bot CLI'],
    execFile: (command, args, options) => {
      called = { command, args, input: options.input };
      return 'ensured block "agent-bot-cli" in /tmp/x/.zshenv\n';
    },
  });
  assert.equal(result.updated, true);
  assert.equal(called.command, 'zsh-profile');
  assert.deepEqual(called.args, [
    'ensure-block', '--file', join(home, '.zshenv'), '--name', 'agent-bot-cli', '--absorb-marker', '# agent-bot CLI',
  ]);
  assert.equal(called.input, BODY);
});

test('ensureBlock reports unchanged when zsh-profile did not rewrite', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const result = ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => 'unchanged block "agent-bot-cli" in /tmp/x/.zshenv\n',
  });
  assert.equal(result.updated, false);
});

test('ensureBlock falls back to the in-process rewrite when zsh-profile is absent', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const result = ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => { throw Object.assign(new Error('zsh-profile not found'), { code: 'ENOENT' }); },
  });
  assert.equal(result.updated, true);
  assert.match(readFileSync(join(home, '.zshenv'), 'utf8'), /^# BEGIN agent-bot-cli$/m);
});

test('ensureBlock rethrows zsh-profile failures other than ENOENT', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  assert.throws(
    () => ensureBlock({
      dir: home,
      filename: '.zshenv',
      name: 'agent-bot-cli',
      body: BODY,
      execFile: () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); },
    }),
    { code: 'EACCES' },
  );
});

test('ensureBlock errors on an unterminated target block', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  writeFileSync(join(home, '.zshenv'), '# BEGIN agent-bot-cli\nnever closed\n');
  assert.throws(
    () => ensureBlock({
      dir: home,
      filename: '.zshenv',
      name: 'agent-bot-cli',
      body: BODY,
      execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
    }),
    /unterminated block "# BEGIN agent-bot-cli"/,
  );
});

test('ensureBlock preserves the file mode when rewriting', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const file = join(home, '.zprofile');
  writeFileSync(file, 'export PATH="/usr/bin:$PATH"\n', { mode: 0o640 });
  chmodSync(file, 0o640);
  ensureBlock({
    dir: home,
    filename: '.zprofile',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(statSync(file).mode & 0o777, 0o640);
});