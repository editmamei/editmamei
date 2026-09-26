/**
 * Shared fixtures and a tiny PNG decoder for the `tests/gimp-live` suite.
 *
 * PNG, not PPM: the bridge's `_export_stripped` (the one writer every export/preview/compare
 * raster save goes through) refuses any extension outside jpg/jpeg/png/webp/tif/tiff, so a `.ppm`
 * export is no longer reachable at all -- PNG is the lossless format actually available, and
 * decoding it ourselves (zlib inflate + per-scanline filter reversal, no image-decoding
 * dependency) is what gives every pixel-exact assertion below a real, independently-decoded
 * value rather than trusting GIMP's own histogram op to grade itself.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GimpSession, READY_TIMEOUT_MS } from '@editmamei/backends/gimp/session.ts';
import { GimpError } from '@editmamei/backends/gimp/errors.ts';

/**
 * The test-only bridge (`fixtures/test_ops.py`): the real ops.py plus ops no gimp_* tool exposes
 * (mask PGM load/export, and fixture builders). Pass as `opsPyPath` to a live GimpSession that
 * needs them; every other session runs the shipped ops.py.
 */
export const TEST_OPS_PY = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test_ops.py');

export interface Ppm {
  width: number;
  height: number;
  maxval: number;
  data: Buffer; // RGB triples, row-major, top-to-bottom
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a PNG (8-bit, non-interlaced; grayscale/RGB/gray+alpha/RGBA -- everything this suite's
 * own fixtures and GIMP's own PNG exporter produce) into the same `{width, height, data}` shape
 * `readPpm` used to, always as RGB triples (alpha, if any, is dropped -- every test fixture here
 * is opaque). */
export function readPng(path: string): Ppm {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }
  let pos = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0;
  const idatChunks: Buffer[] = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      const interlace = data[12]!;
      if (bitDepth !== 8)
        throw new Error(`only 8-bit PNG is supported (got bit depth ${bitDepth})`);
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 8 + length + 4; // length + type + data + CRC
  }
  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawPos++]!;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rawPos++]!;
      const a = i >= channels ? out[rowStart + i - channels]! : 0;
      const b = y > 0 ? out[prevRowStart + i]! : 0;
      const c = y > 0 && i >= channels ? out[prevRowStart + i - channels]! : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + Math.floor((a + b) / 2);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      out[rowStart + i] = value & 0xff;
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    const si = p * channels;
    const di = p * 3;
    if (channels === 1 || channels === 2) {
      rgb[di] = rgb[di + 1] = rgb[di + 2] = out[si]!;
    } else {
      rgb[di] = out[si]!;
      rgb[di + 1] = out[si + 1]!;
      rgb[di + 2] = out[si + 2]!;
    }
  }
  return { width, height, maxval: 255, data: rgb };
}

export function pixelAt(ppm: Ppm, x: number, y: number): [number, number, number] {
  if (x < 0 || x >= ppm.width || y < 0 || y >= ppm.height) {
    // A silent out-of-bounds read here used to just return whatever adjacent pixel the bad math
    // landed on (or undefined, coerced to NaN) -- exactly the kind of wrong-column bug the flip
    // test's own dimension check exists to catch instead, so this throws rather than guessing.
    throw new Error(`pixelAt(${x}, ${y}) is out of bounds for a ${ppm.width}x${ppm.height} image`);
  }
  const i = (y * ppm.width + x) * 3;
  return [ppm.data[i]!, ppm.data[i + 1]!, ppm.data[i + 2]!];
}

/** Mean R/G/B over a rectangle -- used for the color-swatch direction checks. */
export function patchMean(
  ppm: Ppm,
  x: number,
  y: number,
  w: number,
  h: number
): [number, number, number] {
  let r = 0,
    g = 0,
    b = 0;
  const n = w * h;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const [pr, pg, pb] = pixelAt(ppm, xx, yy);
      r += pr;
      g += pg;
      b += pb;
    }
  }
  return [r / n, g / n, b / n];
}

/** Sample variance of the luminance-ish (mean of R,G,B) channel over a rectangle -- used for the
 * sharpen/noise-reduction property checks (edge contrast up / variance down), since neither has
 * a single scalar transfer function to check against an exact value. */
export function patchVariance(ppm: Ppm, x: number, y: number, w: number, h: number): number {
  const values: number[] = [];
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const [r, g, b] = pixelAt(ppm, xx, yy);
      values.push((r + g + b) / 3);
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
}

/** Max per-channel absolute difference between two same-sized PPMs -- the `.xcf` round-trip
 * check's "reopen renders identically (max diff 0)". */
export function maxAbsDiff(a: Ppm, b: Ppm): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let max = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i]! - b.data[i]!);
    if (d > max) max = d;
  }
  return max;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function writePng(
  path: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number]
): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // per-scanline filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

/** A hard black|white vertical edge at the horizontal midpoint -- unlike a smooth ramp, this
 * gives a spatial (radius-based) filter real high-frequency content to blur, so a preview proxy
 * built at reduced resolution genuinely diverges from a full-res render without radius scaling. */
export function writeHardEdge(path: string, width: number, height: number): void {
  writePng(path, width, height, (x) => {
    const v = x < width / 2 ? 0 : 255;
    return [v, v, v];
  });
}

/** A tiny indexed-color (palette, PNG color type 3) PNG -- GIMP loads this as `base_type:
 * 'indexed'`, and verified live that `Image.convert_precision` fails outright for that base type
 * (a real GIMP-side "must not be of type 'indexed'" error, returned as a plain `False` rather than
 * raised as a Python exception -- see `op_open`'s own comment on this). Used to exercise that
 * failure path live, since a normal RGB/grayscale source never triggers it. */
export function writeIndexedPng(path: string, width: number, height: number): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: indexed (palette)
  const plte = Buffer.from([0, 0, 0, 255, 255, 255]); // a 2-color palette: black, white
  const raw = Buffer.alloc(height * (1 + width));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // per-scanline filter: None
    for (let x = 0; x < width; x++) {
      raw[offset++] = (x + y) % 2; // palette index 0 or 1
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

/** A fine checkerboard (small square size in px) -- unlike a single hard edge, this has
 * high-frequency detail at multiple points, which is where blur-before-downscale (a full-res
 * render) and downscale-before-blur-with-a-scaled-radius (the preview proxy) genuinely stop
 * commuting: downsampling first can alias/average away detail a native-resolution blur would
 * have smoothed differently. This is what actually gives the proxy-fidelity test a real,
 * non-vacuous number to pin. */
export function writeCheckerboard(
  path: string,
  width: number,
  height: number,
  square: number,
  low = 0,
  high = 255
): void {
  writePng(path, width, height, (x, y) => {
    const v = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0 ? low : high;
    return [v, v, v];
  });
}

/** A mid-gray field with deterministic per-pixel noise added (a seeded LCG, not `Math.random()`,
 * so the fixture is reproducible run to run) -- the high-frequency content `noise_reduction`
 * needs something real to measurably reduce; a smooth ramp or flat field has none to begin with. */
export function writeNoisyField(path: string, width: number, height: number, amplitude = 60): void {
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  writePng(path, width, height, () => {
    const v = Math.max(0, Math.min(255, Math.round(128 + (next() - 0.5) * 2 * amplitude)));
    return [v, v, v];
  });
}

/** A grayscale ramp, one exact luminance level per column (R=G=B=x when width===256), so a
 * curves/levels transfer function can be checked against an independently computed LUT at every
 * input level rather than a handful of samples. */
export function writeGrayRamp(path: string, width = 256, height = 32): void {
  writePng(path, width, height, (x) => {
    const v = Math.round((x / (width - 1)) * 255);
    return [v, v, v];
  });
}

export interface Swatch {
  name: string;
  x: number;
  rgb: [number, number, number];
}

export const SWATCH_SIZE = 16;
export const SWATCHES: ReadonlyArray<Swatch> = [
  // Deliberately not pure (0,0,0): GIMP's color-balance transfer functions weight their effect
  // by the pixel's own value and taper to ~zero at the true black/white endpoints (verified
  // live), so a shadows-range shift needs a swatch with room to move.
  { name: 'black', x: 0, rgb: [16, 16, 16] },
  { name: 'white', x: 1, rgb: [255, 255, 255] },
  { name: 'gray', x: 2, rgb: [128, 128, 128] },
  { name: 'red', x: 3, rgb: [200, 40, 40] },
  { name: 'green', x: 4, rgb: [40, 180, 40] },
  { name: 'blue', x: 5, rgb: [40, 60, 200] },
];

/** Six flat color patches side by side -- direction-of-effect checks (hue rotation, saturation,
 * color balance, color temperature, vibrance) read a patch's mean color rather than needing an
 * exact transfer function. */
export function writeColorSwatches(path: string): void {
  const width = SWATCHES.length * SWATCH_SIZE;
  writePng(path, width, SWATCH_SIZE, (x) => {
    const swatch = SWATCHES[Math.floor(x / SWATCH_SIZE)]!;
    return swatch.rgb;
  });
}

/** Binary 8-bit PGM (P5): left half selected (255), right half not (0) -- same fixture shape
 * `session.live.test.ts` already uses for `select_mask`. */
export function writeHalfMaskPgm(path: string, width: number, height: number): void {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  const data = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = x < width / 2 ? 255 : 0;
    }
  }
  writeFileSync(path, Buffer.concat([header, data]));
}

/** Decode a binary PGM (P5) -- the single-channel twin of `readPng`, used to read back
 * `export_mask`'s output. Same comment-skipping header parse. */
export function readGrayscalePgm(path: string): Buffer {
  const buf = readFileSync(path);
  let pos = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    tokens.push(buf.subarray(start, pos).toString('ascii'));
  }
  pos++;
  const [magic, w, h] = tokens;
  if (magic !== 'P5') throw new Error(`expected a binary PGM (P5), got ${magic}`);
  const width = Number(w);
  const height = Number(h);
  return buf.subarray(pos, pos + width * height);
}

/** Standard sRGB EOTF: 8-bit gamma-encoded [0,255] -> linear-light [0,1]. `op_histogram` and
 * `op_adjust`'s exposure/shadows-highlights type all operate on `"R'G'B' u8"`/GEGL buffers, which
 * is this same encoding -- what an exported PPM's bytes actually represent. */
export function srgbToLinear(encoded8: number): number {
  const c = encoded8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/** Linear interpolation between `points` ([x, y] pairs, 0-255, sorted by x) -- the independently
 * computed LUT curves/levels are checked against. */
export function lerpCurve(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= points[0]![0]) return points[0]![1];
  const last = points[points.length - 1]!;
  if (x >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    if (x >= x0 && x <= x1) {
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  throw new Error(`x=${x} out of range`);
}

/** The IHDR bit depth byte of a PNG file -- what `export`'s `bit_depth` option is checked
 * against directly, independent of anything the bridge itself reports. */
export function readPngBitDepth(path: string): number {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  // IHDR is always the first chunk: 8 (signature) + 4 (length) + 4 (type) + 8 (width/height)
  // lands exactly on the bit-depth byte.
  return buf[8 + 4 + 4 + 8]!;
}

/**
 * A minimal baseline TIFF IFD reader: just enough to pull tag value(s) out of a TIFF-structured
 * byte buffer, independent of anything the bridge itself reports (so a `compression` option that
 * silently didn't take effect, GIMP-side, still fails the test). Handles the common tag data
 * types (BYTE/SHORT/LONG and their inline-vs-offset storage); not a general-purpose TIFF library.
 *
 * Works on any TIFF-structured buffer, not just a whole `.tiff` file: a JPEG's EXIF APP1 segment
 * carries its tags as a miniature TIFF (byte-order marker, magic 42, IFD0) starting right after
 * the "Exif\0\0" prefix, and this same parser reads that too.
 */
export function findTiffIfd0(
  buf: Buffer
): Map<number, { type: number; count: number; values: number[] }> {
  const byteOrder = buf.subarray(0, 2).toString('ascii');
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') throw new Error('not TIFF-structured (bad byte order marker)');
  const readU16 = (o: number) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const readU32 = (o: number) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const magic = readU16(2);
  if (magic !== 42) throw new Error(`not TIFF-structured (bad magic ${magic})`);

  const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }; // BYTE/ASCII/SHORT/LONG/RATIONAL
  const tags = new Map<number, { type: number; count: number; values: number[] }>();
  const ifdOffset = readU32(4); // IFD0 only -- every check this suite needs lives there or is
  // reached via a pointer tag (GPSInfo/ExifIFD) IFD0 itself carries.
  const entryCount = readU16(ifdOffset);
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = readU16(entryOffset);
    const type = readU16(entryOffset + 2);
    const count = readU32(entryOffset + 4);
    const typeSize = typeSizes[type] ?? 4;
    const totalSize = typeSize * count;
    const valueOffset = totalSize <= 4 ? entryOffset + 8 : readU32(entryOffset + 8);
    const values: number[] = [];
    for (let j = 0; j < count && (type === 1 || type === 3 || type === 4); j++) {
      const at = valueOffset + j * typeSize;
      if (type === 3) values.push(readU16(at));
      else if (type === 4) values.push(readU32(at));
      else if (type === 1) values.push(buf[at]!);
    }
    tags.set(tag, { type, count, values });
  }
  return tags;
}

/** File-path convenience wrapper for a real `.tiff` file, returning one tag's numeric values
 * (throws if the tag is absent -- used where the tag is EXPECTED, e.g. Compression/BitsPerSample;
 * `findTiffIfd0` itself is used where ABSENCE is the thing under test). */
export function readTiffTag(path: string, tagId: number): number[] {
  const tags = findTiffIfd0(readFileSync(path));
  const entry = tags.get(tagId);
  if (!entry) throw new Error(`tag ${tagId} not found in TIFF IFD0`);
  return entry.values;
}

/** Every JPEG APP1 segment's payload, split into `exif` (payload after a leading "Exif\0\0",
 * itself a miniature TIFF `findTiffIfd0` can parse directly) and `xmp` (payload after a leading
 * "http://ns.adobe.com/xap/1.0/\0", the standard XMP packet signature) -- a real JPEG marker
 * scan, not a substring search, so a stray "Exif"-looking byte sequence inside unrelated
 * compressed image data could never be mistaken for a real segment. */
export function findJpegApp1Segments(buf: Buffer): { exif: Buffer[]; xmp: Buffer[] } {
  const exif: Buffer[] = [];
  const xmp: Buffer[] = [];
  const EXIF_SIG = Buffer.from('Exif\0\0', 'ascii');
  const XMP_SIG = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii');
  if (buf.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG file (bad SOI marker)');
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break; // not a marker -- reached entropy-coded data or EOF
    const marker = buf[pos + 1]!;
    if (marker === 0xd9 /* EOI */ || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2); // includes these 2 length bytes, excludes the marker
    const payload = buf.subarray(pos + 4, pos + 2 + length);
    if (marker === 0xe1 /* APP1 */) {
      if (payload.subarray(0, EXIF_SIG.length).equals(EXIF_SIG)) {
        exif.push(payload.subarray(EXIF_SIG.length));
      } else if (payload.subarray(0, XMP_SIG.length).equals(XMP_SIG)) {
        xmp.push(payload.subarray(XMP_SIG.length));
      }
    }
    if (marker === 0xda /* SOS: entropy-coded data follows, no more markers to scan */) break;
    pos += 2 + length;
  }
  return { exif, xmp };
}

/** PNG chunks by type -- reused by the metadata tests to find (or confirm the absence of) an
 * `eXIf` chunk or an `iTXt` chunk carrying the XMP keyword, using the same chunk walk `readPng`
 * does rather than a raw substring search. */
export function findPngChunks(buf: Buffer): Map<string, Buffer[]> {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');
  const chunks = new Map<string, Buffer[]>();
  let pos = 8;
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (!chunks.has(type)) chunks.set(type, []);
    chunks.get(type)!.push(Buffer.from(data));
    if (type === 'IEND') break;
    pos += 8 + length + 4;
  }
  return chunks;
}

/** True if any `iTXt` chunk's keyword (the first NUL-terminated field) is the standard keyword
 * GIMP and every other tool use for an embedded XMP packet. */
export function pngHasXmpItxt(chunks: Map<string, Buffer[]>): boolean {
  const KEYWORD = 'XML:com.adobe.xmp';
  for (const data of chunks.get('iTXt') ?? []) {
    const nul = data.indexOf(0);
    if (nul >= 0 && data.subarray(0, nul).toString('ascii') === KEYWORD) return true;
  }
  return false;
}

/** RIFF chunks by FourCC, for a WebP file -- used to find (or confirm the absence of) 'EXIF'/
 * 'XMP ' chunks the same way `findPngChunks` does for PNG. */
export function findRiffChunks(buf: Buffer): Map<string, Buffer[]> {
  if (
    buf.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buf.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    throw new Error('not a WebP file (bad RIFF/WEBP header)');
  }
  const chunks = new Map<string, Buffer[]>();
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const fourcc = buf.subarray(pos, pos + 4).toString('ascii');
    const size = buf.readUInt32LE(pos + 4);
    const data = buf.subarray(pos + 8, pos + 8 + size);
    if (!chunks.has(fourcc)) chunks.set(fourcc, []);
    chunks.get(fourcc)!.push(Buffer.from(data));
    pos += 8 + size + (size % 2); // chunks are padded to an even size
  }
  return chunks;
}

/**
 * A real (8x8) JPEG carrying genuine GPS EXIF (Exif.GPSInfo.GPSLatitude/Longitude with their
 * Ref tags, so IFD0 has a real GPSInfo IFD pointer, tag 0x8825) AND a real XMP packet
 * (Xmp.dc.description) -- generated once with GIMP's own metadata API and export config
 * (include-exif/include-xmp explicitly True), embedded here as base64 so the fixture is
 * self-contained. `findJpegApp1Segments` + `findTiffIfd0` on its own `exif` payload confirm
 * both are genuinely present before any test trusts this fixture to prove something is stripped.
 */
export const GPS_XMP_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEBLAEsAAD/4Qe+RXhpZgAASUkqAAgAAAAHABoBBQABAAAAYgAAABsBBQABAAAAagAAACgBAwABAAAAAgAAADEBAgALAAAAcgAAADIBAgAUAAAAfgAAAGmHBAABAAAAkgAAACWIBAABAAAAuAAAAMoAAAAsAQAAAQAAACwBAAABAAAAR0lNUCAzLjIuNgAAMjAyNjowOToyNiAwMToyNjozMwACABCQAgAHAAAAsAAAAAGgAwABAAAAAQAAAAAAAAAtMDQ6MDAAAAEAAQACAAIAAABOAAAAAAAAAAkA/gAEAAEAAAABAAAAAAEEAAEAAAAAAQAAAQEEAAEAAAAAAQAAAgEDAAMAAAA8AQAAAwEDAAEAAAAGAAAABgEDAAEAAAAGAAAAFQEDAAEAAAADAAAAAQIEAAEAAABCAQAAAgIEAAEAAABzBgAAAAAAAAgACAAIAP/Y/+AAEEpGSUYAAQEAAAEAAQAA/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgBAAEAAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A+f6KKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/9kA/+ENQmh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8APD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNC40LjAtRXhpdjIiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1sbnM6R0lNUD0iaHR0cDovL3d3dy5naW1wLm9yZy94bXAvIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIgeG1wTU06RG9jdW1lbnRJRD0iZ2ltcDpkb2NpZDpnaW1wOmYyMjI5MTZkLWFmMzctNGMwNi1hOTVmLWM4NmYzOTQ1N2Q3NiIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2ZDdmZDMyMi1iMmMxLTQ1MDMtODMyMS0wZmZiMjJjNWI1ODAiIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo5NTg4YTMyNS00NjBjLTQxZjktYmJiOS05NTJlYmJmNGM1YTciIEdJTVA6QVBJPSIzLjAiIEdJTVA6UGxhdGZvcm09IldpbmRvd3MiIEdJTVA6VGltZVN0YW1wPSIxNzkwNDAwMzkzNjYxNTE3IiBHSU1QOlZlcnNpb249IjMuMi42IiBkYzpGb3JtYXQ9ImltYWdlL2pwZWciIHhtcDpDcmVhdG9yVG9vbD0iR0lNUCIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNi0wOS0yNlQwMToyNjozMy0wNDowMCIgeG1wOk1vZGlmeURhdGU9IjIwMjYtMDktMjZUMDE6MjY6MzMtMDQ6MDAiPiA8eG1wTU06SGlzdG9yeT4gPHJkZjpTZXE+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6Y2hhbmdlZD0iLyIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo3OTRjM2I0Yi1hMmM1LTRiZTItODc2ZC1iNDI2ZjA5MThjNGYiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkdJTVAgMy4yLjYgKFdpbmRvd3MpIiBzdEV2dDp3aGVuPSIyMDI2LTA5LTI2VDAxOjI2OjMzLTA0Ii8+IDwvcmRmOlNlcT4gPC94bXBNTTpIaXN0b3J5PiA8ZGM6ZGVzY3JpcHRpb24+IDxyZGY6QWx0PiA8cmRmOmxpIHhtbDpsYW5nPSJ4LWRlZmF1bHQiPmVkaXRtYW1laS10ZXN0LXhtcC1tYXJrZXI8L3JkZjpsaT4gPC9yZGY6QWx0PiA8L2RjOmRlc2NyaXB0aW9uPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8P3hwYWNrZXQgZW5kPSJ3Ij8+/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8IAEQgAEAAQAwERAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAI/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAABlQAH/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABBQIf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPwEf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAgEBPwEf/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQAGPwIf/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPyEf/9oADAMBAAIAAwAAABCST//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8QH//Z';

/** Writes `GPS_XMP_JPEG_BASE64` to `path`. */
export function writeGpsXmpJpeg(path: string): void {
  writeFileSync(path, Buffer.from(GPS_XMP_JPEG_BASE64, 'base64'));
}

// ---- session readiness (a slow first GIMP launch) --------------------------
//
// A real GIMP's very first launch on a machine (font cache, plug-in scan,
// macOS Gatekeeper) can outlast `session.ts`'s per-call `CALL_READY_WAIT_MS`
// cap, in which case `GimpSession.call()` rejects with `gimp_starting`
// instead of hanging or failing outright — the caller is expected to retry.
// Every `gimp-live` file below constructs its own session and makes its
// first real call inside an `it()`, so without retrying here a cold runner
// (a fresh GitHub Actions VM has none of GIMP's own caches either) would
// fail that first test on `gimp_starting` alone, not on anything actually
// broken.

/**
 * `READY_TIMEOUT_MS` (the session's own overall start-attempt deadline) plus
 * a margin, for whatever in this suite needs to bound a `readySession`/
 * `readyGimpRegistry` wait — a `beforeAll` hook timeout, or the one test that
 * measures the cold start itself. Margin, not the bare deadline: comfortably
 * past the point `GimpSession` would already have classified a genuine start
 * failure on its own, so this never races that classification.
 */
export const LIVE_READY_TIMEOUT_MS = READY_TIMEOUT_MS + 20_000;

/**
 * Calls `ping` on a `GimpSession`, retrying while it reports `gimp_starting`
 * until the session connects or `LIVE_READY_TIMEOUT_MS` elapses (any other
 * rejection propagates immediately — this is not a generic retry-everything
 * helper). Every `gimp-live` file's `beforeAll` should `await` this right
 * after constructing its session, passing `LIVE_READY_TIMEOUT_MS` as that
 * hook's own timeout.
 */
export async function readySession(session: GimpSession): Promise<void> {
  const deadline = Date.now() + LIVE_READY_TIMEOUT_MS;
  for (;;) {
    try {
      await session.call('ping', {});
      return;
    } catch (err) {
      const code = err instanceof GimpError ? err.code : undefined;
      if (code !== 'gimp_starting' || Date.now() > deadline) throw err;
    }
  }
}

/**
 * The `registry.execute('gimp_ping', ...)` analogue of `readySession`, for
 * `registry-e2e.test.ts`: it drives GIMP through the tool layer
 * (`GimpBackend`), not a raw `GimpSession`, so `gimp_ping` never THROWS on a
 * slow first launch — it reports `structuredContent.starting: true` instead
 * (see `gimp-core-tools.ts`). Retries the same call until that flag is gone
 * or `LIVE_READY_TIMEOUT_MS` elapses.
 */
export async function readyGimpRegistry(
  execute: (name: string, args: Record<string, unknown>) => Promise<{ structuredContent?: unknown }>
): Promise<void> {
  const deadline = Date.now() + LIVE_READY_TIMEOUT_MS;
  for (;;) {
    const result = await execute('gimp_ping', {});
    const starting = (result.structuredContent as { starting?: boolean } | undefined)?.starting;
    if (!starting) return;
    if (Date.now() > deadline) {
      throw new Error(
        `gimp-live: gimp_ping still reports starting: true after LIVE_READY_TIMEOUT_MS (${LIVE_READY_TIMEOUT_MS}ms)`
      );
    }
  }
}
