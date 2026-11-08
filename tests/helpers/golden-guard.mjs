// `node --import ./tests/helpers/golden-guard.mjs`: the fence the golden
// surface tests (#1379) run agent-bot inside. It is passed on through
// NODE_OPTIONS, so every node child the CLI starts is fenced too.
//
// In a fenced process:
//   - child_process may start node (process.execPath) and nothing else, and
//     that child is fenced too, even when it is given an environment of its own;
//   - no connection leaves the box: only a local socket inside it may be
//     dialled, and tls and fetch refuse outright;
//   - nothing is written outside GOLDEN_GUARD_BOX (the test's sealed HOME
//     and temporary directory).
// A refused call throws, and is appended to GOLDEN_GUARD_LOG as one JSON line
// ({ kind, target, args }) so the test can fail on it, or, for the hook path,
// assert which file the dispatcher would have run. A command whose output
// depends on any of these is not a golden candidate; it belongs in a test
// with its own fixtures.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';

const box = process.env.GOLDEN_GUARD_BOX;
const log = process.env.GOLDEN_GUARD_LOG;
if (!box || !log) throw new Error('golden-guard needs GOLDEN_GUARD_BOX and GOLDEN_GUARD_LOG');

const realAppend = fs.appendFileSync;
const realReal = fs.realpathSync.native;
const boxes = [path.resolve(box)];
try { boxes.push(realReal(box)); } catch { /* the test creates it first */ }

function refuse(kind, target, args = []) {
  try { realAppend(log, `${JSON.stringify({ kind, target: String(target), args: args.map(String) })}\n`); } catch { /* still refuse */ }
  const error = new Error(`golden guard: ${kind} ${target} refused`);
  error.code = 'EGOLDENGUARD';
  return error;
}

// --- child_process: node only -------------------------------------------
const node = [process.execPath];
try { node.push(realReal(process.execPath)); } catch { /* keep the one we have */ }
const isNode = (file) => typeof file === 'string' && node.includes(file);
const argList = (args) => (Array.isArray(args) ? args : []);
const isOptions = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// However this process was fenced (NODE_OPTIONS or --import), its node
// children carry the same --import.
const self = `--import=${import.meta.url}`;
const fence = (process.env.NODE_OPTIONS ?? '').includes(import.meta.url)
  ? process.env.NODE_OPTIONS
  : [process.env.NODE_OPTIONS, self].filter(Boolean).join(' ');

// A child given its own, narrowed environment (minimalChildEnv and the like)
// would drop NODE_OPTIONS and run unfenced, so the fence is put back.
function fenced(env) {
  return { ...env, NODE_OPTIONS: fence, GOLDEN_GUARD_BOX: box, GOLDEN_GUARD_LOG: log };
}

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const real = childProcess[name];
  childProcess[name] = function guarded(file, ...rest) {
    if (!isNode(file)) throw refuse('exec', file, argList(rest[0]));
    const at = rest.findIndex(isOptions);
    if (at === -1) {
      const options = { env: fenced(process.env) };
      if (Array.isArray(rest[0])) rest.splice(1, 0, options); else rest.unshift([], options);
    } else {
      rest[at] = { ...rest[at], env: fenced(rest[at].env ?? process.env) };
    }
    return real.call(this, file, ...rest);
  };
}
for (const name of ['exec', 'execSync']) {
  childProcess[name] = (command) => { throw refuse('exec', command); };
}
childProcess.fork = (modulePath) => { throw refuse('exec', `fork ${modulePath}`); };

// --- network: only sockets inside the box --------------------------------
// net.connect, http(s) agents and fetch all end in Socket#connect. A local
// socket inside the box is allowed: nothing listens there, so the caller sees
// the same refusal it would on a machine where that service is not running.
function socketTarget(args) {
  const [first] = args;
  if (Array.isArray(first)) return socketTarget(first); // net.connect's normalized form
  if (first && typeof first === 'object') {
    return { local: typeof first.path === 'string', name: first.path ?? `${first.host ?? 'localhost'}:${first.port ?? ''}` };
  }
  return { local: typeof first === 'string' && path.isAbsolute(first), name: first };
}
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(...args) {
  const { local, name } = socketTarget(args);
  if (local && inside(name)) return realConnect.apply(this, args);
  throw refuse('connect', name);
};
tls.connect = (...args) => { throw refuse('connect', socketTarget(args).name); };
globalThis.fetch = async (url) => { throw refuse('connect', url?.url ?? url); };

// --- filesystem: writes stay in the box ---------------------------------
function inside(file) {
  if (typeof file === 'number') return true; // an fd we were allowed to open
  if (file instanceof URL) file = file.pathname;
  if (Buffer.isBuffer(file)) file = file.toString();
  if (typeof file !== 'string') return false;
  const resolved = path.resolve(file);
  if (resolved === '/dev/null' || resolved.startsWith('/dev/fd/')) return true;
  return boxes.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

const WRITE_FLAGS = /[wa+]/;
const writesFlags = (flags) => (typeof flags === 'number'
  ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
  : typeof flags === 'string' && WRITE_FLAGS.test(flags));

const oneTarget = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'chmod', 'chown', 'truncate', 'utimes', 'mkdtemp', 'lchown', 'lutimes'];
const twoTargets = ['rename', 'copyFile', 'symlink', 'link', 'cp'];

// A refused call fails the way its API reports failure: a throw (sync), a
// rejection (promises) or an error passed to the callback.
function wrap(object, name, check, style) {
  const real = object[name];
  if (typeof real !== 'function') return;
  object[name] = function guarded(...args) {
    const bad = check(args);
    if (bad === null) return real.apply(this, args);
    const error = refuse('write', bad);
    if (style === 'promise') return Promise.reject(error);
    const callback = args.at(-1);
    if (style === 'callback' && typeof callback === 'function') { process.nextTick(callback, error); return undefined; }
    throw error;
  };
}
const firstOutside = (args) => (inside(args[0]) ? null : args[0]);
const secondOutside = (args) => (inside(args[1]) ? null : args[1]);
const openOutside = (args) => (writesFlags(args[1]) && !inside(args[0]) ? args[0] : null);

for (const base of oneTarget) {
  wrap(fs, `${base}Sync`, firstOutside, 'sync');
  wrap(fs, base, firstOutside, 'callback');
  wrap(fs.promises, base, firstOutside, 'promise');
}
for (const base of twoTargets) {
  // rename changes both paths; the others write only their second.
  const check = base === 'rename' ? (args) => firstOutside(args) ?? secondOutside(args) : secondOutside;
  wrap(fs, `${base}Sync`, check, 'sync');
  wrap(fs, base, check, 'callback');
  wrap(fs.promises, base, check, 'promise');
}
wrap(fs, 'openSync', openOutside, 'sync');
wrap(fs, 'open', openOutside, 'callback');
wrap(fs.promises, 'open', openOutside, 'promise');
wrap(fs, 'createWriteStream', firstOutside, 'sync');

syncBuiltinESMExports();
