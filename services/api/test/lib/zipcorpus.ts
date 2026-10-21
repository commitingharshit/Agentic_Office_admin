// Hand-rolled hostile zips for the supply-chain suite. fflate (the normal test builder) normalises names and refuses to lie, so
// anything that needs raw name bytes, unix mode bits, a lying declared size or an over-budget size is written here.
import { crc32, deflateRawSync } from 'node:zlib';

export interface RawEntry {
  /** A string is UTF-8 encoded; raw bytes are written as they are (overlong sequences, invalid UTF-8). */
  name: string | Uint8Array;
  /** The UNCOMPRESSED content. */
  data?: Uint8Array;
  /** Unix file type and permission bits for the central directory external attributes (e.g. 0o120777 = symlink). Default 0o100644. */
  mode?: number;
  /** General-purpose flags. Default 0x800 (UTF-8 names). */
  flags?: number;
  /** 0 = stored (default), 8 = deflate. */
  method?: 0 | 8;
  /** Overrides the uncompressed size written to the headers (to lie about it). */
  declared?: number;
}

export function rawZip(entries: RawEntry[]): Uint8Array {
  const te = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const e of entries) {
    const nb = typeof e.name === 'string' ? te.encode(e.name) : e.name;
    const data = e.data ?? new Uint8Array(0);
    const method = e.method ?? 0;
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const declared = e.declared ?? data.length, crc = crc32(data), flags = e.flags ?? 0x800;
    const lh = new Uint8Array(30 + nb.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, declared, true); lv.setUint16(26, nb.length, true);
    lh.set(nb, 30);
    const cd = new Uint8Array(46 + nb.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, (3 << 8) | 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, flags, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, declared, true); cv.setUint16(28, nb.length, true);
    cv.setUint32(38, (((e.mode ?? 0o100644) << 16) >>> 0), true); cv.setUint32(42, off, true);
    cd.set(nb, 46);
    parts.push(lh, body); central.push(cd);
    off += lh.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const out = new Uint8Array(off + cdSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, eocd]) { out.set(part, p); p += part.length; }
  return out;
}
