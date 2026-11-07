import { open, type FileHandle } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { decodeName } from './textcodec.js';

/**
 * 逐个读取压缩包里的文件，不把整个压缩包放进内存。
 * Windows 中文系统打的包，文件名是国标编码且没有标记，这里按内容判断编码，文件夹和名字不会乱码。
 */
export interface ZipEntry {
  name: string;
  dir: boolean;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  encrypted: boolean;
}
export class ZipUnsupported extends Error {}
export class ZipCorrupt extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array, prev = 0): number {
  if (typeof (zlib as any).crc32 === 'function') return (zlib as any).crc32(buf, prev) >>> 0;
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === len ? buf : buf.subarray(0, got);
}

export async function listZip(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65557 + 22);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new ZipCorrupt();
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64 = Number(tail.readBigUInt64LE(loc + 8));
        const rec = await readAt(fh, z64, 56);
        if (rec.readUInt32LE(0) !== 0x06064b50) throw new ZipCorrupt();
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }
    if (cdSize > 256 * 1024 * 1024 || cdOffset + cdSize > size) throw new ZipCorrupt();
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let k = 0; k < count && p + 46 <= cd.length; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipCorrupt();
      const flags = cd.readUInt16LE(p + 8),
        method = cd.readUInt16LE(p + 10),
        crc = cd.readUInt32LE(p + 16);
      let compressed = cd.readUInt32LE(p + 20),
        usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28),
        extraLen = cd.readUInt16LE(p + 30),
        commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let offset = cd.readUInt32LE(p + 42);
      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let unicodeName: string | null = null;
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e),
          len = extra.readUInt16LE(e + 2);
        const data = extra.subarray(e + 4, e + 4 + len);
        if (id === 0x0001) {
          let q = 0;
          if (usize === 0xffffffff && q + 8 <= data.length) (usize = Number(data.readBigUInt64LE(q))), (q += 8);
          if (compressed === 0xffffffff && q + 8 <= data.length) (compressed = Number(data.readBigUInt64LE(q))), (q += 8);
          if (offset === 0xffffffff && q + 8 <= data.length) offset = Number(data.readBigUInt64LE(q));
        } else if (id === 0x7075 && data.length > 5 && data[0] === 1) {
          if (data.readUInt32LE(1) === crc32(rawName)) unicodeName = data.subarray(5).toString('utf8');
        }
        e += 4 + len;
      }
      const name = (unicodeName ?? (flags & 0x800 ? rawName.toString('utf8') : decodeName(rawName))).replace(/\\/g, '/');
      entries.push({
        name,
        dir: name.endsWith('/') || (external & 0x10) !== 0,
        method,
        flags,
        crc,
        compressed,
        size: usize,
        offset,
        encrypted: (flags & 1) !== 0,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** 解出一个文件并核对校验和；不支持的压缩方式交给 7-Zip 处理整个压缩包。 */
export async function extractZipEntry(path: string, e: ZipEntry, out: string): Promise<void> {
  if (e.method !== 0 && e.method !== 8) throw new ZipUnsupported();
  const fh = await open(path, 'r');
  let start: number;
  try {
    const head = await readAt(fh, e.offset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) throw new ZipCorrupt();
    start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  let crc = 0,
    written = 0;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > e.size) return cb(new ZipCorrupt());
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  const source = e.compressed > 0 ? createReadStream(path, { start, end: start + e.compressed - 1 }) : Readable.from([]);
  try {
    if (e.method === 8) await pipeline(source, zlib.createInflateRaw(), check, createWriteStream(out));
    else await pipeline(source, check, createWriteStream(out));
  } catch (err) {
    if (err instanceof ZipCorrupt) throw err;
    throw new ZipCorrupt(String((err as Error)?.message || err));
  }
  if (written !== e.size || crc !== e.crc) throw new ZipCorrupt();
}
