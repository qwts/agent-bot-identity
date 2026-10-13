import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  assert.equal(result.entries, 3);
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
  await refused(gzipSync(tar([{ name: 'hole', type: 'S' }])), /hole is a sparse file/);
  await refused(gzipSync(tar([pax({ 'GNU.sparse.major': '1' }), { name: 'hole' }])), /sparse file/);
  await refused(gzipSync(tar([{ name: 'fifo', type: '6' }])), /fifo is a device or FIFO/);
  await refused(gzipSync(tar([{ name: 'dev', type: '3' }])), /device or FIFO/);
  await refused(gzipSync(Buffer.from('not a tar at all'.padEnd(1024, '!'))), /not a tar archive/);
});

test('a zip is budgeted from its central directory', async () => {
  assert.deepEqual(await checkArchiveBudget(file(zip([{ name: 'uv.exe', size: 100 }, { name: 'uvx.exe', size: 50 }])), limits), { format: 'zip', entries: 2, expandedBytes: 150 });
  await refused(zip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}` }))), /more than 4 entries/);
  await refused(zip([{ name: 'big', size: 70 * 1024 }]), /expands to more than 65536 bytes/);
  await refused(zip([{ name: 'a/b/c/d' }]), /nested deeper than 3/);
  await refused(zip([{ name: 'p', mode: 0o010644 }]), /device or FIFO/);
});

test('a format this reader cannot budget is left to tar', async () => {
  assert.deepEqual(await checkArchiveBudget(file(Buffer.from('{"json":"double"}')), limits), { format: null, entries: null, expandedBytes: null });
});
