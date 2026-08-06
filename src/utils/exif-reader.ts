import { open, FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';

/**
 * Focused EXIF/XMP reader for the Editmamei source-metadata path.
 *
 * Why this exists: the previous reader used `exifr`, a single-maintainer
 * npm package abandoned since 2021. Vendoring a focused parser eliminates
 * the supply-chain risk and gives us a surface we own.
 *
 * Coverage:
 *  - JPEG (`.jpg`, `.jpeg`): APP1 EXIF + APP1 XMP segments
 *  - TIFF (`.tif`, `.tiff`, `.dng`): bare TIFF directory structure
 *  - HEIC / HEIF / CR3 / vendor-specific raw containers: returns null —
 *    the `metadata-tools.ts` handler falls back to Photoshop's already-
 *    parsed `doc.info.exif`, so the LLM still gets camera basics.
 *
 * Only the first 256 KB of the file is read. EXIF and XMP segments live
 * early; if they don't fit in 256 KB, the file is unusual and we degrade
 * to the DOM fallback gracefully.
 *
 * Returned shape mirrors a flattened subset of the `exifr` schema so the
 * existing `extractCamera`/`extractGps`/`extractAcr` callers don't need
 * a rewrite. Field names use the canonical EXIF tag names so the lookup
 * tables stay portable.
 */

const READ_BYTES = 256 * 1024;

/**
 * Hard cap on per-tag `count` from the TIFF dictionary.
 *
 * The `dataStart + valueSize > buf.length` guard already keeps count
 * implicitly bounded by the read buffer (256 KB) divided by the per-type
 * size — but if `READ_BYTES` is widened later, or if a new 1-byte
 * type is added, a maliciously-large `count` could cause `Array.from
 * ({length: count}, ...)` to allocate the entire bounded buffer worth
 * of array entries. A flat cap keeps the worst-case allocation bounded
 * regardless of buffer-size changes.
 *
 * 64 K entries is generous for legitimate EXIF (the largest plausible
 * field is the MakerNote which clamps at ~16 KB bytes; UserComment
 * ~16 KB chars). Anything past this is a malformed file and we drop the
 * tag rather than allocate.
 */
const MAX_TAG_COUNT = 64 * 1024;

const JPEG_FORMATS = new Set(['.jpg', '.jpeg']);
const TIFF_FORMATS = new Set(['.tif', '.tiff', '.dng']);

type TagType = 1 | 2 | 3 | 4 | 5 | 7 | 9 | 10 | 11 | 12;

interface TagValue {
  tag: number;
  type: TagType;
  value: unknown;
}

interface TiffParseResult {
  ifd0: Map<number, TagValue>;
  exif: Map<number, TagValue>;
  gps: Map<number, TagValue>;
}

export type ExifReaderResult = Record<string, unknown> | null;

/** EXIF/XMP read result for a single file. `null` means the format isn't
 *  supported by this parser; the caller should fall back. */
export async function readExif(filePath: string): Promise<ExifReaderResult> {
  const ext = extname(filePath).toLowerCase();
  if (!JPEG_FORMATS.has(ext) && !TIFF_FORMATS.has(ext)) {
    return null;
  }

  let fh: FileHandle | undefined;
  try {
    fh = await open(filePath, 'r');
    const { bytesRead, buffer } = await fh.read({
      buffer: Buffer.alloc(READ_BYTES),
      length: READ_BYTES,
    });
    const head = buffer.subarray(0, bytesRead);

    if (JPEG_FORMATS.has(ext)) {
      return parseJpeg(head);
    }
    if (TIFF_FORMATS.has(ext)) {
      return parseStandaloneTiff(head);
    }
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// JPEG container
// ---------------------------------------------------------------------------

/**
 * Walk JPEG segments looking for APP1 EXIF (`Exif\0\0` prefix) and
 * APP1 XMP (`http://ns.adobe.com/xap/1.0/\0` prefix). Stop at SOS (FF DA).
 */
function parseJpeg(buf: Buffer): ExifReaderResult {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null; // Not a JPEG (missing SOI).
  }

  const result: Record<string, unknown> = {};
  let i = 2;

  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      break; // Marker stream desynced.
    }
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) {
      break; // SOS / EOI — past the metadata block.
    }
    if (marker === 0x00 || marker === 0xff) {
      i++;
      continue;
    }
    const segLen = buf.readUInt16BE(i + 2);
    const segStart = i + 4;
    const segEnd = i + 2 + segLen;
    if (segLen < 2 || segEnd > buf.length) {
      break;
    }

    if (marker === 0xe1) {
      const segment = buf.subarray(segStart, segEnd);
      if (matchesPrefix(segment, 'Exif\0\0')) {
        const tiff = parseTiff(segment.subarray(6));
        if (tiff) {
          mergeFlatTags(result, tiff);
        }
      } else if (matchesPrefix(segment, 'http://ns.adobe.com/xap/1.0/\0')) {
        const xmp = segment.subarray(29).toString('utf8');
        const acr = extractAcrFromXmp(xmp);
        if (acr) result.crs = acr;
      }
    }

    i = segEnd;
  }

  return Object.keys(result).length > 0 ? result : {};
}

// ---------------------------------------------------------------------------
// Standalone TIFF
// ---------------------------------------------------------------------------

function parseStandaloneTiff(buf: Buffer): ExifReaderResult {
  const tiff = parseTiff(buf);
  if (!tiff) return null;
  const result: Record<string, unknown> = {};
  mergeFlatTags(result, tiff);
  return result;
}

// ---------------------------------------------------------------------------
// TIFF directory parser (shared by JPEG APP1 EXIF and bare TIFF)
// ---------------------------------------------------------------------------

function parseTiff(buf: Buffer): TiffParseResult | null {
  if (buf.length < 8) return null;
  const byteOrder = buf.readUInt16BE(0);
  let littleEndian: boolean;
  if (byteOrder === 0x4949)
    littleEndian = true; // "II"
  else if (byteOrder === 0x4d4d)
    littleEndian = false; // "MM"
  else return null;

  const magic = u16(buf, 2, littleEndian);
  if (magic !== 0x002a) return null;

  const ifd0Offset = u32(buf, 4, littleEndian);
  if (ifd0Offset >= buf.length) return null;

  const ifd0 = readIfd(buf, ifd0Offset, littleEndian);
  const result: TiffParseResult = {
    ifd0,
    exif: new Map(),
    gps: new Map(),
  };

  const exifOffset = numericTag(ifd0.get(0x8769));
  if (exifOffset !== undefined && exifOffset < buf.length) {
    result.exif = readIfd(buf, exifOffset, littleEndian);
  }
  const gpsOffset = numericTag(ifd0.get(0x8825));
  if (gpsOffset !== undefined && gpsOffset < buf.length) {
    result.gps = readIfd(buf, gpsOffset, littleEndian);
  }

  return result;
}

function readIfd(buf: Buffer, offset: number, le: boolean): Map<number, TagValue> {
  const out = new Map<number, TagValue>();
  if (offset + 2 > buf.length) return out;
  const entryCount = u16(buf, offset, le);
  const base = offset + 2;

  for (let i = 0; i < entryCount; i++) {
    const entryOff = base + i * 12;
    if (entryOff + 12 > buf.length) break;
    const tag = u16(buf, entryOff, le);
    const type = u16(buf, entryOff + 2, le) as TagType;
    const count = u32(buf, entryOff + 4, le);
    // Drop tags with absurd counts before computing valueSize / allocating.
    // The downstream `dataStart + valueSize > buf.length` check would
    // catch unreadable overruns, but a count near the buffer-size limit
    // for a 1-byte type still tries to allocate ~256 KB of array. The
    // cap keeps allocation predictable for any future buffer widening.
    if (count > MAX_TAG_COUNT) continue;
    const valueSize = typeSize(type) * count;
    let dataStart: number;
    if (valueSize <= 4) {
      dataStart = entryOff + 8;
    } else {
      dataStart = u32(buf, entryOff + 8, le);
    }
    if (dataStart + valueSize > buf.length) continue;
    const value = readTagValue(buf, type, count, dataStart, le);
    if (value !== undefined) {
      out.set(tag, { tag, type, value });
    }
  }
  return out;
}

function readTagValue(
  buf: Buffer,
  type: TagType,
  count: number,
  offset: number,
  le: boolean
): unknown {
  switch (type) {
    case 1: // BYTE
    case 7: // UNDEFINED
      return count === 1 ? buf[offset] : Array.from(buf.subarray(offset, offset + count));
    case 2: {
      // ASCII null-terminated
      const slice = buf.subarray(offset, offset + count);
      const nul = slice.indexOf(0);
      const end = nul === -1 ? count : nul;
      return slice.subarray(0, end).toString('latin1');
    }
    case 3: // SHORT
      if (count === 1) return u16(buf, offset, le);
      return Array.from({ length: count }, (_, i) => u16(buf, offset + i * 2, le));
    case 4: // LONG
      if (count === 1) return u32(buf, offset, le);
      return Array.from({ length: count }, (_, i) => u32(buf, offset + i * 4, le));
    case 5: {
      // RATIONAL
      const reads: number[] = [];
      for (let i = 0; i < count; i++) {
        const n = u32(buf, offset + i * 8, le);
        const d = u32(buf, offset + i * 8 + 4, le);
        reads.push(d === 0 ? 0 : n / d);
      }
      return count === 1 ? reads[0] : reads;
    }
    case 9: // SLONG
      if (count === 1) return s32(buf, offset, le);
      return Array.from({ length: count }, (_, i) => s32(buf, offset + i * 4, le));
    case 10: {
      // SRATIONAL
      const reads: number[] = [];
      for (let i = 0; i < count; i++) {
        const n = s32(buf, offset + i * 8, le);
        const d = s32(buf, offset + i * 8 + 4, le);
        reads.push(d === 0 ? 0 : n / d);
      }
      return count === 1 ? reads[0] : reads;
    }
    default:
      return undefined;
  }
}

function typeSize(type: TagType): number {
  switch (type) {
    case 1:
    case 2:
    case 7:
      return 1;
    case 3:
      return 2;
    case 4:
    case 9:
      return 4;
    case 5:
    case 10:
      return 8;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Tag → human-name flattening (matches the shape the existing extractors
// expect — keys are the EXIF tag names `exifr` used)
// ---------------------------------------------------------------------------

const TAG_NAMES: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x9003: 'DateTimeOriginal',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISO',
  0x920a: 'FocalLength',
  0xa405: 'FocalLengthIn35mmFormat',
  0xa403: 'WhiteBalance',
  0x9209: 'Flash',
  0xa434: 'LensModel',
};

function mergeFlatTags(out: Record<string, unknown>, tiff: TiffParseResult): void {
  for (const dir of [tiff.ifd0, tiff.exif]) {
    for (const [tagId, entry] of dir) {
      const name = TAG_NAMES[tagId];
      if (name !== undefined) {
        out[name] = entry.value;
      }
    }
  }
  // GPS — convert to decimal degrees the way exifr surfaced them.
  const lat = signedCoord(tiff.gps.get(0x0002), tiff.gps.get(0x0001));
  const lon = signedCoord(tiff.gps.get(0x0004), tiff.gps.get(0x0003));
  if (lat !== undefined) out.latitude = lat;
  if (lon !== undefined) out.longitude = lon;
  // Altitude (single rational with byte sign in ref tag — 0 above sea, 1 below)
  const alt = numericTag(tiff.gps.get(0x0006));
  if (alt !== undefined) {
    const ref = numericTag(tiff.gps.get(0x0005));
    out.GPSAltitude = ref === 1 ? -alt : alt;
  }
}

function signedCoord(
  coordEntry: TagValue | undefined,
  refEntry: TagValue | undefined
): number | undefined {
  if (!coordEntry || !Array.isArray(coordEntry.value)) return undefined;
  const [deg, min, sec] = coordEntry.value as number[];
  if (typeof deg !== 'number' || typeof min !== 'number' || typeof sec !== 'number') {
    return undefined;
  }
  let decimal = deg + min / 60 + sec / 3600;
  if (typeof refEntry?.value === 'string') {
    const ref = refEntry.value.trim().toUpperCase();
    if (ref === 'S' || ref === 'W') decimal = -decimal;
  }
  return decimal;
}

function numericTag(entry: TagValue | undefined): number | undefined {
  if (!entry) return undefined;
  if (typeof entry.value === 'number') return entry.value;
  if (Array.isArray(entry.value) && typeof entry.value[0] === 'number') {
    return entry.value[0] as number;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// XMP packet → crs:* attribute extraction
// ---------------------------------------------------------------------------

/**
 * Extract the Camera Raw Settings namespace (`crs:*`) attributes from an
 * XMP packet. The packet has many variants — attributes on rdf:Description,
 * nested elements, etc. We support the two forms Lightroom/ACR actually
 * write: `crs:Field="value"` attribute syntax and `<crs:Field>value</crs:Field>`
 * element syntax.
 */
function extractAcrFromXmp(xmp: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const attrRe = /crs:([A-Za-z0-9_]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(xmp))) {
    out[m[1]] = m[2];
  }
  const elemRe = /<crs:([A-Za-z0-9_]+)>([^<]*)<\/crs:\1>/g;
  while ((m = elemRe.exec(xmp))) {
    out[m[1]] = m[2];
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Little-/big-endian helpers
// ---------------------------------------------------------------------------

function u16(buf: Buffer, off: number, le: boolean): number {
  return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
}
function u32(buf: Buffer, off: number, le: boolean): number {
  return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
}
function s32(buf: Buffer, off: number, le: boolean): number {
  return le ? buf.readInt32LE(off) : buf.readInt32BE(off);
}

function matchesPrefix(buf: Buffer, prefix: string): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}
