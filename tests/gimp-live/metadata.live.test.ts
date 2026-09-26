/**
 * Metadata stripping, byte-level: every raster path that leaves the bridge (`export`, `preview`
 * -- whole-image and region -- and `compare`'s before/after outputs) goes through the single
 * `_export_stripped` writer in ops.py, and this file proves that writer actually removes EXIF/GPS
 * and XMP from a source image that genuinely carries both, by parsing the OUTPUT bytes directly
 * (JPEG APP1 segments, PNG chunks, WebP RIFF chunks, TIFF IFD0) rather than trusting anything the
 * bridge itself reports.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  writeGpsXmpJpeg,
  findJpegApp1Segments,
  findTiffIfd0,
  findPngChunks,
  pngHasXmpItxt,
  pngTextPayloads,
  gpsLatitudeBytes,
  findRiffChunks,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
  FIXTURE_GPS_LATITUDE,
} from './support.ts';
import { deflateSync } from 'node:zlib';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

const XMP_MARKER = 'editmamei-test-xmp-marker';
const GPS_IFD_POINTER_TAG = 0x8825;
const EXIF_IFD_POINTER_TAG = 0x8769;
const IPTC_TAG = 33723;
const XMP_TAG = 700;

/**
 * Every place in a PNG a GPS position or the XMP marker could hide: the raw file bytes, and every
 * text chunk's payload decompressed, searching both the raw GPS rational bytes and their hex
 * spelling (how a "Raw profile type exif" text chunk carries EXIF).
 */
function pngLeaks(png: Buffer, gpsBytes: Buffer): string[] {
  const leaks: string[] = [];
  const hex = gpsBytes.toString('hex');
  const haystacks: Array<[string, Buffer]> = [['file bytes', png]];
  for (const { keyword, text } of pngTextPayloads(findPngChunks(png))) {
    haystacks.push([`text chunk "${keyword}"`, text]);
  }
  for (const [where, buf] of haystacks) {
    if (buf.includes(XMP_MARKER)) leaks.push(`XMP marker in ${where}`);
    if (buf.includes(gpsBytes)) leaks.push(`GPS bytes in ${where}`);
    if (buf.toString('latin1').replace(/\s+/g, '').toLowerCase().includes(hex)) {
      leaks.push(`hex GPS bytes in ${where}`);
    }
  }
  return leaks;
}

describe.skipIf(!install)('metadata stripping (byte-level)', () => {
  let workDir: string;
  let session: GimpSession;
  let sourcePath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-metadata-'));
    // The test-only bridge (fixtures/test_ops.py): its test_metadata_tag op confirms GIMP loaded
    // the fixture's metadata. Every export still goes through the shipped writer.
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    sourcePath = join(workDir, 'gps-xmp-source.jpg');
    writeGpsXmpJpeg(sourcePath);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('fixture sanity: the source JPEG really carries GPS EXIF and an XMP packet before any export is trusted to strip it', () => {
    const { exif, xmp } = findJpegApp1Segments(readFileSync(sourcePath));
    expect(exif.length).toBeGreaterThan(0);
    expect(findTiffIfd0(exif[0]!).has(GPS_IFD_POINTER_TAG)).toBe(true);
    expect(findTiffIfd0(exif[0]!).has(EXIF_IFD_POINTER_TAG)).toBe(true);
    expect(gpsLatitudeBytes(exif[0]!)).toEqual(FIXTURE_GPS_LATITUDE);
    expect(xmp.length).toBeGreaterThan(0);
    expect(xmp[0]!.includes(XMP_MARKER)).toBe(true);
  });

  it('GIMP really loads the fixture GPS position (so a stripped export is not a vacuous pass)', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const lat = await session.call<{ value: string | null }>('test_metadata_tag', {
        image: opened.image,
        tag: 'Exif.GPSInfo.GPSLatitude',
      });
      expect(lat.value).toBeTruthy();
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('the PNG leak search finds metadata in a compressed zTXt EXIF profile and a compressed iTXt XMP packet (positive control)', () => {
    const { exif } = findJpegApp1Segments(readFileSync(sourcePath));
    const gps = gpsLatitudeBytes(exif[0]!);
    const chunk = (type: string, data: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length, 0);
      return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
    };
    const exifProfile = Buffer.concat([
      Buffer.from('Raw profile type exif\0\0', 'latin1'),
      deflateSync(
        Buffer.from(`\nexif\n  ${exif[0]!.length}\n${exif[0]!.toString('hex')}\n`, 'latin1')
      ),
    ]);
    const xmpPacket = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp\0\x01\x00\0\0', 'latin1'),
      deflateSync(Buffer.from(`<x:xmpmeta>${XMP_MARKER}</x:xmpmeta>`, 'utf8')),
    ]);
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', Buffer.alloc(13)),
      chunk('zTXt', exifProfile),
      chunk('iTXt', xmpPacket),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const leaks = pngLeaks(png, gps);
    expect(leaks).toContain('hex GPS bytes in text chunk "Raw profile type exif"');
    expect(leaks).toContain('XMP marker in text chunk "XML:com.adobe.xmp"');
  });

  it('export to jpeg strips EXIF/GPS and XMP', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const outPath = join(workDir, 'out.jpg');
      await session.call('export', { image: opened.image, path: outPath });
      const { exif, xmp } = findJpegApp1Segments(readFileSync(outPath));
      expect(exif).toEqual([]);
      expect(xmp).toEqual([]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('export to png strips the eXIf chunk and the XMP iTXt chunk', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const outPath = join(workDir, 'out.png');
      await session.call('export', { image: opened.image, path: outPath });
      const png = readFileSync(outPath);
      const chunks = findPngChunks(png);
      expect(chunks.has('eXIf')).toBe(false);
      expect(pngHasXmpItxt(chunks)).toBe(false);
      // And nowhere else: every tEXt/zTXt/iTXt payload, decompressed, and the raw bytes.
      const gps = gpsLatitudeBytes(findJpegApp1Segments(readFileSync(sourcePath)).exif[0]!);
      expect(pngLeaks(png, gps)).toEqual([]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('export to webp strips the EXIF and XMP RIFF chunks', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const outPath = join(workDir, 'out.webp');
      await session.call('export', { image: opened.image, path: outPath });
      const chunks = findRiffChunks(readFileSync(outPath));
      expect(chunks.has('EXIF')).toBe(false);
      expect(chunks.has('XMP ')).toBe(false);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('export to tiff strips the GPSInfo and EXIF IFD pointers, the XMP tag, and the IPTC tag', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const outPath = join(workDir, 'out.tiff');
      await session.call('export', { image: opened.image, path: outPath });
      const tiff = readFileSync(outPath);
      const tags = findTiffIfd0(tiff);
      expect(tags.has(GPS_IFD_POINTER_TAG)).toBe(false);
      expect(tags.has(EXIF_IFD_POINTER_TAG)).toBe(false);
      expect(tags.has(XMP_TAG)).toBe(false);
      expect(tags.has(IPTC_TAG)).toBe(false);
      const gps = gpsLatitudeBytes(findJpegApp1Segments(readFileSync(sourcePath)).exif[0]!);
      expect(tiff.includes(gps)).toBe(false);
      expect(tiff.includes(XMP_MARKER)).toBe(false);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('preview (whole-image) strips EXIF/GPS and XMP', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const outPath = join(workDir, 'preview.jpg');
      await session.call('preview', { image: opened.image, out_path: outPath });
      const { exif, xmp } = findJpegApp1Segments(readFileSync(outPath));
      expect(exif).toEqual([]);
      expect(xmp).toEqual([]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('preview (region, full-res crop path) strips EXIF/GPS and XMP', async () => {
    const opened = await session.call<{ image: number; width: number; height: number }>('open', {
      path: sourcePath,
    });
    try {
      const outPath = join(workDir, 'preview-region.jpg');
      await session.call('preview', {
        image: opened.image,
        out_path: outPath,
        region: { x: 0, y: 0, width: opened.width, height: opened.height },
      });
      const { exif, xmp } = findJpegApp1Segments(readFileSync(outPath));
      expect(exif).toEqual([]);
      expect(xmp).toEqual([]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('compare before_after strips EXIF/GPS and XMP from both the before and after preview outputs', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const beforePath = join(workDir, 'compare-before.jpg');
      const afterPath = join(workDir, 'compare-after.jpg');
      await session.call('adjust', {
        image: opened.image,
        type: 'brightness_contrast',
        brightness: 10,
        contrast: 10,
      });
      await session.call('compare', {
        image: opened.image,
        mode: 'before_after',
        before_path: beforePath,
        after_path: afterPath,
      });
      for (const p of [beforePath, afterPath]) {
        const { exif, xmp } = findJpegApp1Segments(readFileSync(p));
        expect(exif, p).toEqual([]);
        expect(xmp, p).toEqual([]);
      }
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // `_strip_metadata` raises `gimp_op_failed` loudly when a format's export config lacks
  // include-exif/include-xmp -- but on the real GIMP 3.2.6 install this suite runs against, every
  // exportable format (jpeg/png/webp/tiff) DOES declare both properties (verified live, see
  // ops.py's own comment on `_strip_metadata`), so that failure path has no live trigger here:
  // faking a missing property would mean mocking GIMP's own `Gimp.Config`, which this bridge does
  // not do anywhere (it is tested exclusively against the real install, never a mock). There is
  // no live scenario left to assert on beyond what the tests above already cover -- every format
  // this bridge actually exports to strips cleanly.
});
