#!/usr/bin/env node
// A stand-in for /usr/bin/security (#383 tests). It keeps generic passwords
// in FAKE_KEYCHAIN (JSON) and appends each argv to FAKE_KEYCHAIN_LOG, so a
// test can prove no secret ever reached a command line. Never the real one.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const store = process.env.FAKE_KEYCHAIN;
if (!store) { process.stderr.write('FAKE_KEYCHAIN is not set\n'); process.exit(2); }
const load = () => { try { return JSON.parse(readFileSync(store, 'utf8')); } catch { return {}; } };
if (process.env.FAKE_KEYCHAIN_LOG) appendFileSync(process.env.FAKE_KEYCHAIN_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);

function tokens(line) {
  const out = [];
  for (const match of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(match[1] ?? match[2]);
  return out;
}
function option(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
function run(args) {
  const [command, ...rest] = args;
  const items = load();
  const key = `${option(rest, '-s')}\u0000${option(rest, '-a')}`;
  if (command === 'find-generic-password') {
    if (!(key in items)) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'); return 44; }
    process.stdout.write(`${items[key]}\n`);
    return 0;
  }
  if (command === 'add-generic-password') {
    if (key in items && !rest.includes('-U')) return 45;
    items[key] = option(rest, '-w');
    writeFileSync(store, JSON.stringify(items));
    return 0;
  }
  process.stderr.write(`fake security: unsupported ${command}\n`);
  return 1;
}

const args = process.argv.slice(2);
if (args[0] === '-i') {
  let status = 0;
  for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) status = run(tokens(line)) || status;
  process.exit(status);
}
process.exit(run(args));
