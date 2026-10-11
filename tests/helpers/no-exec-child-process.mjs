// `node:child_process` with execFileSync replaced (see no-exec.mjs). Every
// call is appended to NO_EXEC_LOG as one JSON line. `/usr/bin/codesign`
// verifies, `<bin> presence-key` prints NO_EXEC_PRESENCE_KEY, and anything
// else (osascript's administrator dialog included) is refused, as a dialog
// nobody answers would be.
import * as real from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

export * from 'node:child_process';

export function execFileSync(file, args = []) {
  if (process.env.NO_EXEC_LOG) appendFileSync(process.env.NO_EXEC_LOG, `${JSON.stringify({ file, args })}\n`);
  if (file === '/usr/bin/codesign') return '';
  if (args[0] === 'presence-key' && process.env.NO_EXEC_PRESENCE_KEY) return `${process.env.NO_EXEC_PRESENCE_KEY}\n`;
  throw Object.assign(new Error(`${file} is not run in this test`), { status: 1 });
}

export default { ...real, execFileSync };
