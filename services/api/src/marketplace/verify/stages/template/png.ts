// Deterministic, dependency-free PNG helpers for the template pipeline's visual stages: a bounded decoder (8-bit, non
// interlaced; gray, RGB, palette, gray+alpha, RGBA), luma-grid downscaling and two comparison measures. No model, no
// browser. The decoder is bounded on every axis (dimensions, pixel count, inflated size) because previews are untrusted.
import { inflateSync } from 'node:zlib';

export const MAX_PNG_SIDE = 8192;
export const MAX_PNG_PIXELS = 16_000_000;
export class PngError extends Error { constructor(msg: string) { super(msg); this.name = 'PngError'; } }
export interface Raster { width: number; height: number; rgb: Uint8Array } // rgb = width*height*3, alpha composited on white

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export function pngSize(b: Uint8Array): { width: number; height: number } {
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) throw new PngError('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export function decodePng(b: Uint8Array): Raster {
  const { width, height } = pngSize(b);
  if (!width || !height || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE || width * height > MAX_PNG_PIXELS) throw new PngError(`PNG dimensions ${width}x${height} are over the limit`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const depth = b[24], ctype = b[25], interlace = b[28];
  if (depth !== 8) throw new PngError(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new PngError('interlaced PNG is not supported');
  const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!chans) throw new PngError(`unsupported colour type ${ctype}`);
  const idat: Uint8Array[] = []; let plte: Uint8Array | undefined, off = 8, idatBytes = 0;
  while (off + 12 <= b.length) {
    const len = dv.getUint32(off), type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (off + 12 + len > b.length) throw new PngError('truncated chunk');
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') { idatBytes += len; if (idatBytes > 64 * 1024 * 1024) throw new PngError('IDAT too large'); idat.push(data); }
    else if (type === 'PLTE') plte = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!idat.length) throw new PngError('no image data');
  const stride = width * chans, expect = (stride + 1) * height;
  let raw: Uint8Array;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expect + 16 }); } catch { throw new PngError('image data is corrupt or inflates beyond its declared size'); }
  if (raw.length < expect) throw new PngError('image data is truncated');
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= chans ? px[dst + x - chans] : 0, up = y ? px[dst - stride + x] : 0, c = x >= chans && y ? px[dst - stride + x - chans] : 0;
      let v = raw[src + x];
      switch (f) {
        case 0: break; case 1: v += a; break; case 2: v += up; break; case 3: v += (a + up) >> 1; break;
        case 4: { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; break; }
        default: throw new PngError(`bad filter ${f}`);
      }
      px[dst + x] = v & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    let r: number, g: number, bl: number, al = 255;
    const p = i * chans;
    if (ctype === 0) r = g = bl = px[p];
    else if (ctype === 4) { r = g = bl = px[p]; al = px[p + 1]; }
    else if (ctype === 2) { r = px[p]; g = px[p + 1]; bl = px[p + 2]; }
    else if (ctype === 6) { r = px[p]; g = px[p + 1]; bl = px[p + 2]; al = px[p + 3]; }
    else { const k = px[p] * 3; if (!plte || k + 2 >= plte.length) throw new PngError('palette index out of range'); r = plte[k]; g = plte[k + 1]; bl = plte[k + 2]; }
    if (al !== 255) { r = (r * al + 255 * (255 - al)) / 255; g = (g * al + 255 * (255 - al)) / 255; bl = (bl * al + 255 * (255 - al)) / 255; }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = bl;
  }
  return { width, height, rgb };
}

/** Box-averaged BT.601 luma on a gw x gh grid (0..255). */
export function lumaGrid(r: Raster, gw: number, gh: number): Float64Array {
  const out = new Float64Array(gw * gh), cnt = new Uint32Array(gw * gh);
  for (let y = 0; y < r.height; y++) {
    const gy = Math.min(gh - 1, Math.floor(y * gh / r.height));
    for (let x = 0; x < r.width; x++) {
      const gx = Math.min(gw - 1, Math.floor(x * gw / r.width)), i = (y * r.width + x) * 3;
      out[gy * gw + gx] += 0.299 * r.rgb[i] + 0.587 * r.rgb[i + 1] + 0.114 * r.rgb[i + 2]; cnt[gy * gw + gx]++;
    }
  }
  for (let i = 0; i < out.length; i++) if (cnt[i]) out[i] /= cnt[i];
  return out;
}

/** Fraction of pixels that differ from the dominant (most common coarse-quantised) colour: ~0 for blank/solid renders. */
export function inkFraction(r: Raster): number {
  const hist = new Map<number, number>(); const n = r.width * r.height;
  const step = Math.max(1, Math.floor(n / 200_000));
  let seen = 0;
  for (let i = 0; i < n; i += step) { const k = ((r.rgb[i * 3] >> 4) << 8) | ((r.rgb[i * 3 + 1] >> 4) << 4) | (r.rgb[i * 3 + 2] >> 4); hist.set(k, (hist.get(k) ?? 0) + 1); seen++; }
  let top = 0; for (const v of hist.values()) if (v > top) top = v;
  return seen ? 1 - top / seen : 0;
}
export function meanLuma(r: Raster): number { let s = 0; const n = r.width * r.height; for (let i = 0; i < n; i++) s += 0.299 * r.rgb[i * 3] + 0.587 * r.rgb[i * 3 + 1] + 0.114 * r.rgb[i * 3 + 2]; return n ? s / n : 0; }
/** Exact-bytes fingerprint of the coarse grid, for "identical to the previous page". */
export function gridKey(g: Float64Array): string { let s = ''; for (const v of g) s += String.fromCharCode(Math.round(v)); return s; }

/** Mean absolute luma difference of two equal grids, 0..1 (0 = identical). */
export function gridMad(a: Float64Array, b: Float64Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length / 255; }
/** Mean SSIM over non-overlapping win x win windows of two gw x gh luma grids (standard constants for an 8-bit range). */
export function gridSsim(a: Float64Array, b: Float64Array, gw: number, gh: number, win = 4): number {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2; let total = 0, n = 0;
  for (let wy = 0; wy + win <= gh; wy += win) for (let wx = 0; wx + win <= gw; wx += win) {
    let ma = 0, mb = 0; const m = win * win;
    for (let y = 0; y < win; y++) for (let x = 0; x < win; x++) { const i = (wy + y) * gw + wx + x; ma += a[i]; mb += b[i]; }
    ma /= m; mb /= m; let va = 0, vb = 0, cov = 0;
    for (let y = 0; y < win; y++) for (let x = 0; x < win; x++) { const i = (wy + y) * gw + wx + x; va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; cov += (a[i] - ma) * (b[i] - mb); }
    va /= m - 1; vb /= m - 1; cov /= m - 1;
    total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
  }
  return n ? total / n : 0;
}
