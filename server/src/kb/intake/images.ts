import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import UTIF from 'utif';

/** 交给模型看的图：模型只收这四种格式，每张最长边不超过 MAX_SIDE。 */
export interface VisionImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: Uint8Array;
  width: number;
  height: number;
}
export interface Raster {
  width: number;
  height: number;
  /** RGBA，每像素 4 字节 */
  data: Uint8Array;
}
export class ImageError extends Error {
  constructor(public code: 'heic' | 'corrupt' | 'tiny' | 'toolarge' | 'unsupported') {
    super(code);
  }
}

const MAX_SIDE = 2048;
const PASS_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 120_000_000;
export const MIN_SIDE = 40;

export function imageSize(b: Uint8Array): { width: number; height: number; orientation?: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50 && b.length > 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b[0] === 0x47 && b[1] === 0x49 && b.length > 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b[0] === 0x42 && b[1] === 0x4d && b.length > 26) return { width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) };
  if (b[0] === 0x52 && b[8] === 0x57 && b.length > 30) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2,
      orientation: number | undefined;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = dv.getUint16(i + 2);
      if (marker === 0xe1 && orientation === undefined) orientation = exifOrientation(b, i + 4, len - 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7), orientation };
      i += 2 + len;
    }
  }
  return null;
}

function exifOrientation(b: Uint8Array, start: number, len: number): number | undefined {
  if (String.fromCharCode(...b.subarray(start, start + 4)) !== 'Exif') return undefined;
  const t = start + 6;
  if (t + 8 > b.length || t + 8 > start + len) return undefined;
  const le = b[t] === 0x49;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const ifd = t + u32(t + 4);
  if (ifd + 2 > b.length) return undefined;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) break;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return undefined;
}

export function decodeRaster(b: Uint8Array): Raster[] {
  const kind = b[0] === 0x89 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpeg' : b[0] === 0x42 && b[1] === 0x4d ? 'bmp' : (b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d) ? 'tiff' : null;
  const size = imageSize(b);
  if (size && size.width * size.height > MAX_SOURCE_PIXELS) throw new ImageError('toolarge');
  try {
    if (kind === 'png') {
      const p = PNG.sync.read(Buffer.from(b));
      return [{ width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) }];
    }
    if (kind === 'jpeg') {
      const j = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 150, maxMemoryUsageInMB: 1200, tolerantDecoding: true });
      return [orient({ width: j.width, height: j.height, data: j.data }, size?.orientation)];
    }
    if (kind === 'bmp') return [decodeBmp(b)];
    if (kind === 'tiff') {
      const ifds = UTIF.decode(b);
      const pages: Raster[] = [];
      for (const ifd of ifds) {
        if (!ifd.t256 && !ifd.width) continue;
        UTIF.decodeImage(b, ifd);
        const w = ifd.width,
          h = ifd.height;
        if (!w || !h || w * h > MAX_SOURCE_PIXELS) continue;
        pages.push({ width: w, height: h, data: UTIF.toRGBA8(ifd) });
      }
      if (!pages.length) throw new ImageError('corrupt');
      return pages;
    }
  } catch (err) {
    if (err instanceof ImageError) throw err;
    throw new ImageError('corrupt');
  }
  throw new ImageError('unsupported');
}

/** 照片带的拍摄方向：转正再给模型看，不然竖着拍的讲义会被读成横的。 */
function orient(r: Raster, o?: number): Raster {
  if (!o || o === 1 || o > 8) return r;
  const { width: w, height: h, data } = r;
  const swap = o >= 5;
  const W = swap ? h : w,
    H = swap ? w : h;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let X = x,
        Y = y;
      switch (o) {
        case 2: X = w - 1 - x; break;
        case 3: X = w - 1 - x; Y = h - 1 - y; break;
        case 4: Y = h - 1 - y; break;
        case 5: X = y; Y = x; break;
        case 6: X = h - 1 - y; Y = x; break;
        case 7: X = h - 1 - y; Y = w - 1 - x; break;
        case 8: X = y; Y = w - 1 - x; break;
      }
      const s = (y * w + x) * 4,
        d = (Y * W + X) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  return { width: W, height: H, data: out };
}

function decodeBmp(b: Uint8Array): Raster {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const offset = dv.getUint32(10, true),
    header = dv.getUint32(14, true);
  const width = dv.getInt32(18, true),
    rawH = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true),
    compression = header >= 40 ? dv.getUint32(30, true) : 0;
  if (width <= 0 || !rawH || ![1, 4, 8, 24, 32].includes(bpp) || (compression !== 0 && compression !== 3)) throw new ImageError('unsupported');
  const height = Math.abs(rawH),
    topDown = rawH < 0;
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const palette: number[][] = [];
  if (bpp <= 8) {
    const colors = (header >= 40 ? dv.getUint32(46, true) : 0) || 1 << bpp;
    for (let k = 0; k < colors; k++) {
      const p = 14 + header + k * 4;
      palette.push([b[p + 2], b[p + 1], b[p]]);
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = offset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        bl = 0,
        a = 255;
      if (bpp === 24 || bpp === 32) {
        const p = row + x * (bpp / 8);
        bl = b[p];
        g = b[p + 1];
        r = b[p + 2];
        if (bpp === 32 && compression === 0) a = 255;
      } else {
        const bit = x * bpp,
          byte = b[row + (bit >> 3)];
        const idx = bpp === 8 ? byte : bpp === 4 ? (bit & 4 ? byte & 15 : byte >> 4) : (byte >> (7 - (bit & 7))) & 1;
        [r, g, bl] = palette[idx] || [0, 0, 0];
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = bl;
      out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}

/** 按面积平均缩小，字边不会像隔点取样那样断开。 */
export function resize(r: Raster, W: number, H: number): Raster {
  if (W >= r.width && H >= r.height) return r;
  const { width: w, height: h, data } = r;
  const out = new Uint8Array(W * H * 4);
  const sx = w / W,
    sy = h / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sy),
      y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sx),
        x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let rr = 0,
        gg = 0,
        bb = 0,
        aa = 0,
        n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          rr += data[p];
          gg += data[p + 1];
          bb += data[p + 2];
          aa += data[p + 3];
          n++;
        }
      }
      const o = (y * W + x) * 4;
      out[o] = rr / n;
      out[o + 1] = gg / n;
      out[o + 2] = bb / n;
      out[o + 3] = aa / n;
    }
  }
  return { width: W, height: H, data: out };
}

export function crop(r: Raster, y0: number, y1: number, x0 = 0, x1 = r.width): Raster {
  const W = x1 - x0,
    H = y1 - y0,
    out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) out.set(r.data.subarray(((y0 + y) * r.width + x0) * 4, ((y0 + y) * r.width + x1) * 4), y * W * 4);
  return { width: W, height: H, data: out };
}

/** 透明底的截图垫白底，再存成模型能收的格式。 */
export function toJpeg(r: Raster, quality = 82): VisionImage {
  const { width, height } = r;
  const flat = new Uint8Array(width * height * 4);
  for (let p = 0; p < flat.length; p += 4) {
    const a = r.data[p + 3] / 255;
    flat[p] = r.data[p] * a + 255 * (1 - a);
    flat[p + 1] = r.data[p + 1] * a + 255 * (1 - a);
    flat[p + 2] = r.data[p + 2] * a + 255 * (1 - a);
    flat[p + 3] = 255;
  }
  const enc = jpeg.encode({ data: flat, width, height }, quality);
  return { mime: 'image/jpeg', data: new Uint8Array(enc.data.buffer, enc.data.byteOffset, enc.data.byteLength), width, height };
}

/** 很长的截图按空白行切成几段，一段一段读，字不会被缩得看不清。 */
export function tiles(r: Raster): Raster[] {
  const { width: w, height: h } = r;
  const fit = (p: Raster) => {
    const s = Math.min(1, MAX_SIDE / Math.max(p.width, p.height));
    return resize(p, Math.max(1, Math.round(p.width * s)), Math.max(1, Math.round(p.height * s)));
  };
  if (h / w <= 3 && w / h <= 3) return [fit(r)];
  const vertical = h > w;
  const span = vertical ? h : w,
    side = vertical ? w : h;
  const parts = Math.min(40, Math.ceil(span / (side * 2.5)));
  const step = span / parts;
  const cuts = [0];
  for (let k = 1; k < parts; k++) cuts.push(quietLine(r, Math.round(k * step), Math.round(step * 0.12), vertical));
  cuts.push(span);
  const out: Raster[] = [];
  for (let k = 0; k < parts; k++) out.push(fit(vertical ? crop(r, cuts[k], cuts[k + 1]) : crop(r, 0, h, cuts[k], cuts[k + 1])));
  return out;
}

/** 在目标位置附近找颜色最均匀的一行（多半是行间空白）作切口。 */
function quietLine(r: Raster, at: number, radius: number, vertical: boolean): number {
  let best = at,
    bestScore = Infinity;
  const len = vertical ? r.width : r.height;
  const stride = Math.max(1, Math.floor(len / 400));
  for (let pos = Math.max(1, at - radius); pos < Math.min((vertical ? r.height : r.width) - 1, at + radius); pos++) {
    let sum = 0,
      sq = 0,
      n = 0;
    for (let k = 0; k < len; k += stride) {
      const p = (vertical ? pos * r.width + k : k * r.width + pos) * 4;
      const v = r.data[p] * 0.3 + r.data[p + 1] * 0.59 + r.data[p + 2] * 0.11;
      sum += v;
      sq += v * v;
      n++;
    }
    const variance = sq / n - (sum / n) ** 2 + Math.abs(pos - at) * 0.01;
    if (variance < bestScore) {
      bestScore = variance;
      best = pos;
    }
  }
  return best;
}

/** 文件本身就能直接给模型看时原样交，避免二次压缩。 */
export function prepareImage(b: Uint8Array): VisionImage[] {
  const isHeic = b.length > 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(String.fromCharCode(...b.subarray(8, 12)));
  if (isHeic) throw new ImageError('heic');
  const isTiff = (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a);
  if (isTiff) return decodeRaster(b).flatMap((r) => (r.width < MIN_SIDE || r.height < MIN_SIDE ? [] : tiles(r).map((t) => toJpeg(t))));
  const size = imageSize(b);
  if (!size) throw new ImageError(b.length < 32 ? 'corrupt' : 'unsupported');
  if (size.width < MIN_SIDE || size.height < MIN_SIDE) throw new ImageError('tiny');
  const passMime = b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : b[0] === 0x47 ? 'image/gif' : b[0] === 0x52 ? 'image/webp' : null;
  const fits = Math.max(size.width, size.height) <= MAX_SIDE && size.width / size.height <= 3 && size.height / size.width <= 3;
  if (passMime && fits && b.length <= PASS_BYTES && (!size.orientation || size.orientation === 1))
    return [{ mime: passMime, data: b, width: size.width, height: size.height }];
  if (passMime === 'image/gif' || passMime === 'image/webp') {
    if (b.length <= PASS_BYTES * 2 && Math.max(size.width, size.height) <= MAX_SIDE * 2) return [{ mime: passMime, data: b, width: size.width, height: size.height }];
    throw new ImageError('toolarge');
  }
  const rasters = decodeRaster(b);
  return rasters.flatMap((r) => (r.width < MIN_SIDE || r.height < MIN_SIDE ? [] : tiles(r).map((t) => toJpeg(t))));
}

/** 文档里取出来的原始像素（灰度、RGB、RGBA）统一成 RGBA。 */
export function fromChannels(width: number, height: number, data: Uint8Array | Uint8ClampedArray, channels: number): Raster {
  if (channels === 4) return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (channels === 1) out[o] = out[o + 1] = out[o + 2] = data[j];
    else {
      out[o] = data[j];
      out[o + 1] = data[j + 1];
      out[o + 2] = data[j + 2];
    }
    out[o + 3] = 255;
  }
  return { width, height, data: out };
}
