// One place that knows how to register a directory on PATH for zsh, because
// there are two installers doing it and getting the shell files wrong is not
// obvious until a harness silently stops working.
//
// Which file matters more than the line. zsh reads:
//
//   .zshenv   every invocation, including non-login and non-interactive
//   .zprofile login shells only
//   .zshrc    interactive shells only
//
// A harness spawns its startup scripts in a non-login, non-interactive shell,
// so anything a harness must find belongs in .zshenv. Registering the CLI only
// in .zprofile is what made `command -v agent-bot` fail while the symlink sat
// in plain view at ~/.local/bin/agent-bot.
//
// Ordering is the other half, and pulls the other way: .zprofile is appended to
// after Homebrew's shellenv has run, so a login shell resolves our directory
// first. Both registrations are therefore needed, and neither replaces the
// other.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Where zsh actually reads its startup files. With ZDOTDIR exported — the
// XDG-style `~/.config/zsh` layout is common — zsh reads `$ZDOTDIR/.zshenv` and
// never looks at `$HOME/.zshenv`. Writing to the home copy in that case
// registers PATH in a file nothing reads, which is indistinguishable from not
// having fixed anything.
export function zshStartupDir(home, env = process.env) {
  const zdotdir = typeof env.ZDOTDIR === 'string' ? env.ZDOTDIR.trim() : '';
  return zdotdir === '' ? home : zdotdir;
}

// Appends one marker-guarded line, once. The marker is matched against the
// whole file rather than line by line so a hand-moved line is still recognised
// and never duplicated.
//
// A non-ENOENT read error is rethrown rather than swallowed: an unreadable
// dotfile means we cannot tell whether the line is already there, and appending
// blindly is how a PATH ends up with the same entry five times.
export function ensurePathLine({
  dir,
  filename,
  line,
  marker,
  read = readFileSync,
  append = appendFileSync,
  mkdir = mkdirSync,
}) {
  // A configured ZDOTDIR that does not exist yet is still where zsh will look,
  // so create it rather than silently writing nowhere.
  mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  let body = '';
  try {
    body = read(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const updated = !body.includes(marker);
  if (updated) append(path, `${body === '' || body.endsWith('\n') ? '' : '\n'}${line}\n`);
  return { path, updated };
}

// Ensures a managed block delimited by exact "# BEGIN <name>" / "# END <name>"
// lines, byte-for-byte the contract zsh-profile (qwts/zsh-functions) defines:
// an existing block is rewritten in place, position stable; a missing block is
// appended after a single blank separator with trailing blanks trimmed first,
// so repeated runs never grow whitespace. Other blocks and the lines between
// them are never touched; absorb markers delete only loose lines sitting
// outside any managed block (a hand-written legacy registration the block
// replaces). The file is rewritten via an exclusive-created, unique same-dir
// temp + rename with the mode preserved, and a rewrite is skipped entirely
// when the output is byte-identical to the current content.
//
// A dotfile that is a symlink is written through: the target is resolved and
// rewritten so the managed link stays a link — rename over the link itself
// would silently replace it with a regular file. The read/modify/write is
// also compare-and-retried: if the file changes between the read and the
// rename (another installer wrote the same file concurrently), the rewrite is
// recomputed from the fresh content instead of having the last rename discard
// the other write. Sustained contention gives up with an explicit error
// rather than silently dropping a registration.
//
// agent-bot installs before zsh-profile exists in the bootstrap chain, so this
// delegates to the shared implementation when it resolves on PATH and keeps
// this JS copy as the fallback. A missing zsh-profile is the only reason to
// fall back — anything else the shared implementation reports is rethrown, not
// masked.
export function ensureBlock({
  dir,
  filename,
  name,
  body,
  absorbMarkers = [],
  command = 'zsh-profile',
  execFile = execFileSync,
  read = readFileSync,
  write = writeFileSync,
  rename = renameSync,
  mkdir = mkdirSync,
  chmod = chmodSync,
  stat = statSync,
  lstat = lstatSync,
  realpath = realpathSync,
  remove = rmSync,
  random = randomUUID,
  maxAttempts = 10,
}) {
  mkdir(dir, { recursive: true });

  // `path` is where zsh reads the file the user actually sees (possibly a
  // symlink); `target` is the real file to rewrite. Delegation and the
  // fallback both operate on the resolved target so the link survives.
  let path = join(dir, filename);
  try {
    if (lstat(path).isSymbolicLink()) path = realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const readOrEmpty = () => {
    try {
      return read(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return '';
    }
  };

  try {
    const args = ['ensure-block', '--file', path, '--name', name];
    for (const marker of absorbMarkers) {
      if (marker !== '') args.push('--absorb-marker', marker);
    }
    const stdout = execFile(command, args, {
      input: body,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    // zsh-profile prints `ensured block` only when it rewrote the file and
    // `unchanged block` otherwise; that is the same `updated` the fallback
    // reports, and what the installers aggregate into their messages. The
    // shared implementation is single-shot, which is fine: it is the one tool
    // touched the file already, while the fallback path below is where
    // concurrent installers race.
    return { path, updated: stdout.startsWith('ensured block') };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const begin = `# BEGIN ${name}`;
  const end = `# END ${name}`;
  const bodyLines = body.split('\n');
  // `body` ends with a newline from every caller; the empty last element is
  // that terminator, not content.
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();

  for (let attempt = 0; ; attempt++) {
    const content = readOrEmpty();
    const lines = (content === '' ? [] : content.split('\n'));
    // awk reads line records, so a file ending in "\n" is one block of lines
    // with a terminator, not an extra empty record — drop the phantom ''.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const out = [];
    let inTarget = false;
    let inOther = '';
    let found = false;
    let emitted = false;
    for (const line of lines) {
      if (inTarget) {
        if (line === end) {
          if (!emitted) {
            out.push(begin, ...bodyLines, end);
            emitted = true;
          }
          inTarget = false;
        }
        continue;
      }
      if (inOther !== '') {
        out.push(line);
        if (line === inOther) inOther = '';
        continue;
      }
      if (line === begin) {
        inTarget = true;
        found = true;
        continue;
      }
      if (line.startsWith('# BEGIN ')) {
        inOther = `# END ${line.slice('# BEGIN '.length)}`;
        out.push(line);
        continue;
      }
      if (absorbMarkers.some((marker) => marker !== '' && line.includes(marker))) {
        continue;
      }
      out.push(line);
    }
    if (inTarget) throw new Error(`unterminated block "${begin}" in ${path}`);
    if (!found) {
      while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
      if (out.length > 0) out.push('');
      out.push(begin, ...bodyLines, end);
    }

    const next = `${out.join('\n')}\n`;
    if (next === content) return { path, updated: false };

    // Another process changed the file since our read: recompute from the new
    // content instead of overwriting their write. Bounded so a busy file never
    // loops forever — losing a registration is worse than a loud failure.
    if (readOrEmpty() !== content) {
      if (attempt >= maxAttempts - 1) {
        throw new Error(`refusing concurrent modification of ${path}`);
      }
      continue;
    }

    const tmp = join(dirname(path), `.${basename(path)}.${random()}.tmp`);
    try {
      write(tmp, next, { flag: 'wx' });
      try {
        chmod(tmp, stat(path).mode & 0o777);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      rename(tmp, path);
      return { path, updated: true };
    } finally {
      // Best-effort: an exclusive-created temp should never pre-exist, but
      // only leave one behind if commit itself failed.
      remove(tmp, { force: true });
    }
  }
}
