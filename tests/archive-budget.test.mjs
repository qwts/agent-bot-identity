import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ArchiveBudgetError, RUNTIME_ARCHIVE_LIMITS, checkArchiveBudget } from '../archive-budget.mjs';

// #1072: what a runtime archive expands to is read before tar runs.
function header(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
function tar(entries) {
  const parts = [];
  for (const { name, body = Buffer.alloc(0), type = '0', size } of entries) {
    parts.push(header(name, size ?? body.length, type), body, pad(body.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
function pax(records) {
  const body = Buffer.from(Object.entries(records).map(([k, v]) => {
    const line = ` ${k}=${v}\n`;
    let length = line.length + 1;
    while (`${length}${line}`.length !== length) length += 1;
    return `${length}${line}`;
  }).join(''));
  return { name: 'PaxHeader', type: 'x', body };
}
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, size = 0, mode = 0o100644 } of entries) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(n.length, 26);
    locals.push(local, n);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt32LE(size, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const dir = mkdtempSync(path.join(tmpdir(), 'archive-budget-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const file = (bytes) => { const f = path.join(dir, `a${seq += 1}`); writeFileSync(f, bytes); return f; };
const limits = { ...RUNTIME_ARCHIVE_LIMITS, maxEntries: 4, maxDepth: 3, maxExpandedBytes: 64 * 1024 };
const refused = (bytes, pattern) => assert.rejects(checkArchiveBudget(file(bytes), limits), (e) => e instanceof ArchiveBudgetError && pattern.test(e.message));

test('a tar.gz within budget reports its entries and expansion', async () => {
  const bytes = gzipSync(tar([{ name: 'go/', type: '5' }, { name: 'go/bin/go', body: Buffer.from('#!/bin/sh\n') }, { name: 'go/bin/gofmt', type: '2' }]));
  const result = await checkArchiveBudget(file(bytes), limits);
  assert.equal(result.format, 'tar.gz');
  // go/, the implied go/bin/, and the two entries in it.
  assert.equal(result.entries, 4);
  // The uncompressed stream as read: at least every header and body block.
  assert.ok(result.expandedBytes >= 512 * 4 && result.expandedBytes <= 512 * 4 + 1024, String(result.expandedBytes));
  assert.equal((await checkArchiveBudget(file(tar([{ name: 'a', body: Buffer.from('x') }])), limits)).format, 'tar');
});

test('tar archives over the entry, depth or byte budget are refused before extraction', async () => {
  await refused(gzipSync(tar(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}` })))), /more than 4 entries/);
  await refused(gzipSync(tar([{ name: 'a/b/c/d' }])), /nested deeper than 3/);
  await refused(gzipSync(tar([{ name: 'big', body: Buffer.alloc(70 * 1024) }])), /expands to more than 65536 bytes/);
  // A pax path or size cannot hide past the header fields.
  await refused(gzipSync(tar([pax({ path: 'a/b/c/d/e' }), { name: 'short' }])), /nested deeper than 3/);
  await refused(gzipSync(tar([{ name: 'L', type: 'L', body: Buffer.from('x/y/z/w\0') }, { name: 'short' }])), /nested deeper than 3/);
});

test('sparse files, devices and FIFOs are refused', async () => {
  await refused(gzipSync(tar([{ name: 'hole', type: 'S' }])), /hole has tar entry type "S"/);
  await refused(gzipSync(tar([pax({ 'GNU.sparse.major': '1' }), { name: 'hole' }])), /pax header with "GNU\.sparse\.major"/);
  await refused(gzipSync(tar([{ name: 'fifo', type: '6' }])), /fifo has tar entry type "6"/);
  await refused(gzipSync(tar([{ name: 'dev', type: '3' }])), /tar entry type "3"/);
  await refused(gzipSync(Buffer.from('not a tar at all'.padEnd(1024, '!'))), /not a tar archive/);
});

// Review of #1090, second round: the reviewer's bsdtar probes.
test('only allowlisted tar entry types and pax keys are read', async () => {
  // Solaris X: pax to bsdtar, so it can hide the headers that follow.
  await refused(gzipSync(tar([{ name: 'X', type: 'X', body: Buffer.alloc(0) }, { name: 'a' }])), /tar entry type "X"/);
  await refused(gzipSync(tar([{ name: 'X', type: 'X', body: Buffer.from('30 SCHILY.realsize=53687091200\n') }, { name: 'a' }])), /tar entry type "X"/);
  // Sparse declared by SCHILY.realsize in an ordinary pax header.
  await refused(gzipSync(tar([pax({ 'SCHILY.realsize': '53687091200' }), { name: 'a' }])), /pax header with "SCHILY\.realsize"/);
  // A global header with keys applies to every later entry.
  await refused(gzipSync(tar([{ ...pax({ size: '1' }), type: 'g' }, { name: 'a' }])), /global pax header/);
  // An old tar without the ustar magic, inside gzip.
  const v7 = tar([{ name: 'a', body: Buffer.from('x') }]);
  v7.fill(0, 257, 265);
  let sum = 0; for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : v7[i];
  v7.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  await refused(gzipSync(v7), /not a ustar tar/);
  // Allowed keys still pass.
  assert.equal((await checkArchiveBudget(file(gzipSync(tar([pax({ path: 'a', mtime: '1', uid: '0' }), { name: 'x' }]))), limits)).entries, 1);
});

test('a file that reads as both tar and zip is refused', async () => {
  // A tar whose first name begins with the zip magic, a zip appended.
  const polyglot = Buffer.concat([tar([{ name: 'PK\x03\x04', body: Buffer.from('x') }]), zip([{ name: 'a', size: 1 }])]);
  await refused(polyglot, /both a tar and a zip/);
  // A ustar tar with a zip appended.
  await refused(Buffer.concat([tar([{ name: 'a', body: Buffer.from('x') }]), zip([{ name: 'b', size: 1 }])]), /both a tar and a zip/);
});

test('a zip is budgeted from its central directory', async () => {
  assert.deepEqual(await checkArchiveBudget(file(zip([{ name: 'uv.exe', size: 100 }, { name: 'uvx.exe', size: 50 }])), limits), { format: 'zip', entries: 2, expandedBytes: 150 });
  await refused(zip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}` }))), /more than 4 entries/);
  await refused(zip([{ name: 'big', size: 70 * 1024 }]), /expands to more than 65536 bytes/);
  await refused(zip([{ name: 'a/b/c/d' }]), /nested deeper than 3/);
  await refused(zip([{ name: 'p', mode: 0o010644 }]), /device or FIFO/);
});

test('anything but a gzip tar, ustar tar or zip is refused', async () => {
  const unknown = /not a gzip tar, ustar tar or zip archive/;
  await refused(Buffer.from('{"json":"double"}'), unknown);
  await refused(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2, 3]), unknown); // xz
  await refused(Buffer.from('BZh91AY&SY'), unknown); // bzip2
  await refused(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]), unknown); // zstd
  await refused(Buffer.from('070701' + '0'.repeat(200)), unknown); // cpio
  // An old tar without the ustar magic, and a zip with bytes before it.
  const old = tar([{ name: 'a', body: Buffer.from('x') }]);
  old.fill(0, 257, 265);
  await refused(old, unknown);
  await refused(Buffer.concat([Buffer.from('#!/bin/sh\nexit 0\n'), zip([{ name: 'a', size: 1 }])]), unknown);
});

// Review of #1090: two reproduced bypasses.
test('a link that carries data is refused, and a lone zero block does not end the scan', async () => {
  const zeros = Buffer.alloc(70 * 1024);
  await refused(gzipSync(tar([{ name: 'a' }, { name: 'link', type: '1', body: zeros }])), /link is a link or directory that carries data/);
  await refused(gzipSync(tar([{ name: 'sym', type: '2', body: Buffer.from('x') }])), /carries data/);
  // One zero block, then more entries: tar keeps reading, so the scan does.
  const lone = Buffer.concat([header('a', 0), Buffer.alloc(512), header('b', zeros.length), zeros, Buffer.alloc(1024)]);
  await refused(gzipSync(lone), /expands to more than 65536 bytes/);
  // Bytes after a real end marker still count.
  await refused(gzipSync(Buffer.concat([tar([{ name: 'a' }]), zeros])), /expands to more than 65536 bytes/);
});

test('a zip whose end record understates its central directory is refused', async () => {
  const understate = (entries) => {
    const bytes = zip(entries);
    const end = bytes.length - 22;
    bytes.writeUInt16LE(1, end + 8); bytes.writeUInt16LE(1, end + 10);
    return bytes;
  };
  // Every entry in the directory is walked, whatever the end record says...
  await refused(understate([{ name: 'a', size: 10 }, { name: 'big', size: 70 * 1024 }]), /expands to more than 65536 bytes/);
  // ...and a count that disagrees with the directory is refused outright.
  await refused(understate([{ name: 'a', size: 10 }, { name: 'b', size: 10 }]), /holds 2 entries, its end record says 1/);
  const honest = zip([{ name: 'a', size: 10 }, { name: 'b', size: 10 }]);
  const end = honest.length - 22;
  // A directory size that does not reach the end record is refused too.
  const short = Buffer.from(honest);
  short.writeUInt32LE(short.readUInt32LE(end + 12) - 46 - 3, end + 12);
  await refused(short, /not where its end record says/);
});

// Review of #1090, third round: pax numbers are plain decimal, every record
// ends with its newline, and implied parent directories count.
test('pax lengths and sizes must be plain decimal records', async () => {
  const raw = (text) => ({ name: 'PaxHeader', type: 'x', body: Buffer.from(text) });
  for (const size of ['0x10000', '0b101', '1e3', '+5', ' 5', '5 ']) {
    const line = ` size=${size}\n`;
    let length = line.length + 1;
    while (`${length}${line}`.length !== length) length += 1;
    await refused(gzipSync(tar([raw(`${length}${line}`), { name: 'a' }])), /malformed pax/);
  }
  await refused(gzipSync(tar([raw('0x12 path=abcdefgh\n'), { name: 'a' }])), /malformed pax header/);
  // Exactly as long as it says, but not ending in its newline.
  await refused(gzipSync(tar([raw('12 path=abcX'), { name: 'a' }])), /malformed pax header/);
  await refused(gzipSync(tar([raw('11 path=abc\n trailing'), { name: 'a' }])), /malformed pax header/);
  // The reviewer's PoC: a hex pax size hid 203 files, a FIFO and an 8 GiB
  // sparse file from the scan while bsdtar extracted them.
  const poc = new URL('./fixtures/archive-budget/N_hexsize_hides.tgz', import.meta.url);
  await assert.rejects(checkArchiveBudget(fileURLToPath(poc)), (e) => e instanceof ArchiveBudgetError && /malformed pax/.test(e.message));
});

test('unlisted parent directories count as entries', async () => {
  await refused(gzipSync(tar([{ name: 'a/b/c' }, { name: 'd/e' }])), /more than 4 entries/);
  await refused(zip([{ name: 'a/b/c' }, { name: 'd/e' }]), /more than 4 entries/);
  assert.equal((await checkArchiveBudget(file(gzipSync(tar([{ name: 'a/b/c' }]))), limits)).entries, 3);
});
