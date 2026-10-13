// Resource budgets for runtime and harness archives (#1072). A package names
// its own archive by URL and digest, and a digest proves only that the bytes
// are the ones the package chose, not that they are a sane size. So the
// download is capped, and before `tar` touches an archive it is read here, in
// process and without writing anything, to check what it would expand to.
//
// The limits sit far above every archive the catalog pins: Go, the largest,
// is under 100 MiB compressed and about 15k entries, 300 MiB expanded.

import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { createGunzip } from 'node:zlib';

export const RUNTIME_ARCHIVE_LIMITS = Object.freeze({
  // Compressed bytes a download may carry.
  maxDownloadBytes: 1024 * 1024 * 1024,
  // Bytes the archive may expand to (for a tar: the whole uncompressed stream).
  maxExpandedBytes: 4 * 1024 * 1024 * 1024,
  maxEntries: 200_000,
  maxDepth: 64,
});

const BLOCK = 512;
const PAX_MAX_BYTES = 1024 * 1024;
const LONG_NAME_MAX_BYTES = 64 * 1024;
const ZIP_DIRECTORY_MAX_BYTES = 64 * 1024 * 1024;
// The tar entry types and pax keys a runtime archive may use, and nothing
// else (#1090 review): anything outside them is refused rather than guessed
// at, because tars disagree on what they mean (Solaris `X` is pax to bsdtar
// and a file to this scanner; `SCHILY.realsize` and `GNU.sparse.*` declare
// sparse files).
const TAR_TYPES = new Set(['0', '1', '2', '5', 'x', 'g', 'L', 'K']);
const PAX_KEYS = new Set(['path', 'linkpath', 'size', 'mtime', 'uid', 'gid', 'uname', 'gname', 'mode', 'atime', 'ctime']);

export class ArchiveBudgetError extends Error {}
const refuse = (message) => { throw new ArchiveBudgetError(message); };

// Entries count every file and directory extraction would create: a listed
// entry, and each parent directory tar makes for it even when the archive
// never lists it (#1090 review).
function counter(limits) {
  let entries = 0, expanded = 0;
  const directories = new Set();
  const count = () => { if (++entries > limits.maxEntries) refuse(`it has more than ${limits.maxEntries} entries`); };
  return {
    entry(name) {
      const parts = name.split('/').filter((part) => part && part !== '.');
      if (parts.length > limits.maxDepth) refuse(`an entry is nested deeper than ${limits.maxDepth} directories`);
      const path = parts.join('/');
      if (!directories.has(path)) count();
      // A listed directory is one entry; every ancestor is in the set once
      // its child is, so the walk up stops at the first one already counted.
      directories.add(path);
      for (let depth = parts.length - 1; depth >= 1; depth -= 1) {
        const parent = parts.slice(0, depth).join('/');
        if (directories.has(parent)) break;
        directories.add(parent);
        count();
      }
    },
    bytes(count) {
      expanded += count;
      if (expanded > limits.maxExpandedBytes) refuse(`it expands to more than ${limits.maxExpandedBytes} bytes`);
    },
    get entries() { return entries; },
    get expanded() { return expanded; },
  };
}

function cString(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function tarNumber(block, start, length) {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    // GNU base-256: big-endian, high bit set. Anything past 2^53 is over
    // budget anyway.
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i += 1) {
      value = value * 256 + field[i];
      if (value > Number.MAX_SAFE_INTEGER) return Infinity;
    }
    return value;
  }
  const text = cString(block, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) refuse('it is not a tar archive this installer can read');
  return parseInt(text, 8);
}

function checksumValid(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return tarNumber(block, 148, 8) === sum;
}

// bsdtar reads pax lengths and sizes as plain decimal only; anything else
// (0x…, 0b…, 1e3, a sign, spaces) is refused rather than read differently.
const DECIMAL = /^[0-9]+$/;

function paxRecords(body) {
  const records = {};
  const malformed = () => refuse('it has a malformed pax header');
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) malformed();
    const digits = body.subarray(at, space).toString('ascii');
    if (!DECIMAL.test(digits)) malformed();
    const length = Number(digits);
    if (!Number.isSafeInteger(length) || at + length > body.length || space + 1 >= at + length) malformed();
    // Each record ends with its newline, exactly where its length says.
    if (body[at + length - 1] !== 0x0a) malformed();
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) malformed();
    records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

// Walks a tar stream's headers, skipping bodies, enforcing the budget as it
// goes so a bomb is abandoned as soon as it is over.
async function scanTar(stream, limits) {
  const budget = counter(limits);
  let buffer = Buffer.alloc(0);
  let skip = 0;          // body bytes still to discard
  let capture = null;    // { remaining, chunks, done } for a pax or long-name body
  let pending = {};      // overrides from a pax 'x' or GNU 'L' header for the next entry
  let ended = false;
  for await (const chunk of stream) {
    budget.bytes(chunk.length);
    if (ended) continue;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (ended) break;
      if (skip > 0) {
        const take = Math.min(skip, buffer.length);
        if (capture) { capture.chunks.push(buffer.subarray(0, Math.min(take, capture.remaining))); capture.remaining -= Math.min(take, capture.remaining); }
        buffer = buffer.subarray(take);
        skip -= take;
        if (skip > 0) break;
        if (capture) { capture.done(Buffer.concat(capture.chunks)); capture = null; }
      }
      if (buffer.length < BLOCK) break;
      const header = buffer.subarray(0, BLOCK);
      if (header.every((byte) => byte === 0)) {
        // End of archive is two zero blocks. A lone zero block followed by
        // more data is not an end tar would stop at, so parsing goes on.
        if (buffer.length < 2 * BLOCK) break;
        buffer = buffer.subarray(BLOCK);
        if (buffer.subarray(0, BLOCK).every((byte) => byte === 0)) { ended = true; break; }
        continue;
      }
      buffer = buffer.subarray(BLOCK);
      if (!checksumValid(header)) refuse('it is not a tar archive this installer can read');
      // ustar (or GNU's \"ustar  \") on every header: an old tar is refused.
      if (header.subarray(257, 262).toString('ascii') !== 'ustar') refuse('it is not a ustar tar archive');
      const type = String.fromCharCode(header[156] || 0x30);
      if (!TAR_TYPES.has(type)) refuse(`${cString(header, 0, 100)} has tar entry type ${JSON.stringify(type)}, which a runtime archive may not use`);
      const prefix = cString(header, 345, 155);
      let name = pending.path ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
      const size = pending.size ?? tarNumber(header, 124, 12);
      pending = {};
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      // A global pax header would apply its keys to every later entry; one
      // with any keys at all is refused.
      if (type === 'g' && size !== 0) refuse('it has a global pax header');
      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        const cap = type === 'L' || type === 'K' ? LONG_NAME_MAX_BYTES : PAX_MAX_BYTES;
        if (size > cap) refuse(`it has a ${type === 'L' || type === 'K' ? 'long-name' : 'pax'} header larger than ${cap} bytes`);
        skip = padded;
        capture = { remaining: size, chunks: [], done: (body) => {
          if (type === 'x') {
            const records = paxRecords(body);
            const unknown = Object.keys(records).find((key) => !PAX_KEYS.has(key));
            if (unknown !== undefined) refuse(`it has a pax header with ${JSON.stringify(unknown)}, which a runtime archive may not use`);
            if (records.path !== undefined) pending.path = records.path;
            if (records.size !== undefined) {
              if (!DECIMAL.test(records.size)) refuse('it has a malformed pax size');
              const declared = Number(records.size);
              if (!Number.isSafeInteger(declared)) refuse('it has a malformed pax size');
              pending.size = declared;
            }
          } else if (type === 'L') pending.path = body.toString('utf8').replace(/\0+$/, '');
        } };
        if (skip === 0) { capture.done(Buffer.alloc(0)); capture = null; }
        continue;
      }
      budget.entry(name);
      // A link or directory with a body is read differently by different tars
      // (bsdtar extracts it, GNU tar takes it for the next header), so no
      // single reading of it can be budgeted: it is refused.
      if ((type === '1' || type === '2' || type === '5') && size !== 0) refuse(`${name} is a link or directory that carries data`);
      skip = padded;
      if (!Number.isFinite(size)) refuse(`it expands to more than ${limits.maxExpandedBytes} bytes`);
    }
    // Past the end marker nothing more is parsed, but every byte of the
    // stream still counts against the budget.
    if (ended) buffer = Buffer.alloc(0);
  }
  return { entries: budget.entries, expandedBytes: budget.expanded };
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  return buffer.subarray(0, read);
}

// A zip's central directory names every entry with its uncompressed size and
// Unix mode, so it is read without inflating anything.
function scanZip(file, limits) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLength, tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd === -1) refuse('it is not a zip archive this installer can read');
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locatorAt = eocd - 20;
      if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== 0x07064b50) refuse('it is not a zip archive this installer can read');
      const record = readAt(fd, Number(tail.readBigUInt64LE(locatorAt + 8)), 56);
      if (record.length < 56 || record.readUInt32LE(0) !== 0x06064b50) refuse('it is not a zip archive this installer can read');
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    if (count > limits.maxEntries) refuse(`it has more than ${limits.maxEntries} entries`);
    // tar walks the whole central directory, whatever the end record's count
    // says, so the directory must sit directly before its end records and
    // hold exactly `count` entries in exactly `directorySize` bytes.
    const endAt = size - tailLength + eocd;
    const zip64 = eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50;
    const directoryEnd = zip64 ? Number(tail.readBigUInt64LE(eocd - 20 + 8)) : endAt;
    if (directoryOffset + directorySize !== directoryEnd) refuse('its central directory is not where its end record says');
    if (directorySize > ZIP_DIRECTORY_MAX_BYTES) refuse(`its directory is larger than ${ZIP_DIRECTORY_MAX_BYTES} bytes`);
    const directory = readAt(fd, directoryOffset, directorySize);
    if (directory.length !== directorySize) refuse('its central directory is not where its end record says');
    const budget = counter(limits);
    let at = 0;
    let walked = 0;
    while (at < directory.length) {
      walked += 1;
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) refuse('it is not a zip archive this installer can read');
      let uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const mode = directory.readUInt32LE(at + 38) >>> 16;
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      if (uncompressed === 0xffffffff) {
        const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
        for (let e = 0; e + 4 <= extra.length;) {
          const id = extra.readUInt16LE(e), length = extra.readUInt16LE(e + 2);
          if (id === 0x0001 && length >= 8) { uncompressed = Number(extra.readBigUInt64LE(e + 4)); break; }
          e += 4 + length;
        }
      }
      const kind = mode & 0o170000;
      if (kind === 0o020000 || kind === 0o060000 || kind === 0o010000) refuse(`${name} is a device or FIFO`);
      budget.entry(name);
      budget.bytes(uncompressed);
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== directory.length || walked !== count) refuse(`its central directory holds ${walked} entries, its end record says ${count}`);
    return { entries: budget.entries, expandedBytes: budget.expanded };
  } finally { closeSync(fd); }
}

// Whether a zip end-of-central-directory record sits in the file's tail,
// as a tar with a zip appended would have.
function endsLikeZip(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - length, length);
    for (let i = tail.length - 22; i >= 0; i -= 1) if (tail.readUInt32LE(i) === 0x06054b50) return true;
    return false;
  } finally { closeSync(fd); }
}

/**
 * What an archive expands to, checked against `limits` before anything is
 * extracted: `{ format, entries, expandedBytes }`. Throws ArchiveBudgetError
 * naming the limit for an archive over budget, a tar entry type or pax key
 * outside the allowlists (so no sparse files, devices, FIFOs or Solaris
 * headers), a file that reads as both tar and zip, and any archive that is
 * not a gzip tar, ustar tar or zip.
 */
export async function checkArchiveBudget(file, limits = RUNTIME_ARCHIVE_LIMITS) {
  const fd = openSync(file, 'r');
  let head;
  try { head = readAt(fd, 0, BLOCK); } finally { closeSync(fd); }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    const source = createReadStream(file);
    const gunzip = createGunzip();
    source.on('error', (error) => gunzip.destroy(error));
    try {
      return { format: 'tar.gz', ...await scanTar(source.pipe(gunzip), limits) };
    } catch (error) {
      if (error instanceof ArchiveBudgetError) throw error;
      refuse(`it could not be read (${error.code ?? error.message})`);
    } finally { source.destroy(); gunzip.destroy(); }
  }
  // A file that reads as both a tar and a zip is read by tar as whichever it
  // bids higher, so it is refused rather than budgeted as one of them.
  const tarHeader = (() => { try { return head.length === BLOCK && checksumValid(head); } catch { return false; } })();
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) {
    if (tarHeader) refuse('it reads as both a tar and a zip archive');
    return { format: 'zip', ...scanZip(file, limits) };
  }
  if (head.length === BLOCK && head.subarray(257, 262).toString('ascii') === 'ustar') {
    if (endsLikeZip(file)) refuse('it reads as both a tar and a zip archive');
    const source = createReadStream(file);
    try { return { format: 'tar', ...await scanTar(source, limits) }; } finally { source.destroy(); }
  }
  // Only formats this reader can budget are installed (owner decision on
  // #1072): an old ustar-less tar, a zip with bytes before it, xz, bzip2,
  // zstd, cpio, 7z and anything else are refused rather than left to tar.
  refuse('it is not a gzip tar, ustar tar or zip archive, the only formats a runtime archive may use');
}
