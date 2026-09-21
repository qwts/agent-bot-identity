import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
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

test('ensureBlock writes through a symlinked dotfile, keeping the link', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const dots = join(home, 'dots');
  const target = join(dots, 'zshenv');
  mkdirSync(dots, { recursive: true });
  writeFileSync(target, 'alias a=1\n');
  symlinkSync(target, join(home, '.zshenv'));
  const result = ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(result.updated, true);
  assert.equal(lstatSync(join(home, '.zshenv')).isSymbolicLink(), true, 'the link survives');
  assert.equal(realpathSync(join(home, '.zshenv')), realpathSync(target));
  assert.match(readFileSync(target, 'utf8'), /^# BEGIN agent-bot-cli$/m);
});

test('ensureBlock does not absorb lines that merely reference the shim directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const file = join(home, '.zshenv');
  writeFileSync(file,
    'export PATH="$HOME/.config/agent-bot/bin:$PATH"  # agent-bot gh shim\n'
    + 'export AGENT_TOOLCHAIN="$HOME/.config/agent-bot/bin/gh"\n');
  ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-gh-shim',
    body: 'typeset -U path PATH\npath=("$HOME/.config/agent-bot/bin" $path)\n',
    absorbMarkers: ['# agent-bot gh shim'],
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes('# agent-bot gh shim\n'), false, 'the legacy PATH line is absorbed');
  assert.match(text, /^export AGENT_TOOLCHAIN="\$HOME\/\.config\/agent-bot\/bin\/gh"$/m, 'unrelated reference survives');
});

test('ensureBlock recomputes from fresh content on a concurrent write (compare-and-retry)', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  const file = join(home, '.zshenv');
  writeFileSync(file, 'alias a=1\n');
  let reads = 0;
  const racingRead = (path, enc) => {
    reads += 1;
    // The compare read simulates another installer having just committed its
    // block while we were computing our rewrite.
    if (reads >= 2) {
      writeFileSync(file, 'alias a=1\n# BEGIN agent-bot-gh-shim\nsh\n# END agent-bot-gh-shim\n', enc);
    }
    return readFileSync(path, enc);
  };
  const result = ensureBlock({
    dir: home,
    filename: '.zshenv',
    name: 'agent-bot-cli',
    body: BODY,
    read: racingRead,
    execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
  });
  assert.equal(result.updated, true);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^# BEGIN agent-bot-cli$/m, 'target block present');
  assert.match(text, /^# BEGIN agent-bot-gh-shim$/m, 'the concurrent block is not dropped');
});

test('ensureBlock fails loudly rather than loop forever on sustained contention', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  writeFileSync(join(home, '.zshenv'), 'alias a=1\n');
  let n = 0;
  const churningRead = (path, enc) => `change ${n++}\n`;
  assert.throws(
    () => ensureBlock({
      dir: home,
      filename: '.zshenv',
      name: 'agent-bot-cli',
      body: BODY,
      read: churningRead,
      execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
    }),
    /refusing concurrent modification/,
  );
});

test('ensureBlock leaves no temp file behind after a failed write', () => {
  const home = mkdtempSync(join(tmpdir(), 'shell-path-'));
  writeFileSync(join(home, '.zshenv'), 'alias a=1\n');
  assert.throws(
    () => ensureBlock({
      dir: home,
      filename: '.zshenv',
      name: 'agent-bot-cli',
      body: BODY,
      rename: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      execFile: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); },
    }),
    { code: 'EACCES' },
  );
  assert.deepEqual(
    readdirSync(home).filter((entry) => entry.endsWith('.tmp')),
    [],
    'temp must be cleaned up',
  );
});