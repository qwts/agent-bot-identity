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

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Appends one marker-guarded line, once. The marker is matched against the
// whole file rather than line by line so a hand-moved line is still recognised
// and never duplicated.
//
// A non-ENOENT read error is rethrown rather than swallowed: an unreadable
// dotfile means we cannot tell whether the line is already there, and appending
// blindly is how a PATH ends up with the same entry five times.
export function ensurePathLine({
  home,
  filename,
  line,
  marker,
  read = readFileSync,
  append = appendFileSync,
}) {
  const path = join(home, filename);
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
