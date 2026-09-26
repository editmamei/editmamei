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
  findRiffChunks,
  readySession,
  LIVE_READY_TIMEOUT_MS,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

const XMP_MARKER = 'editmamei-test-xmp-marker';
const GPS_IFD_POINTER_TAG = 0x8825;
const XMP_TAG = 700;

describe.skipIf(!install)('metadata stripping (byte-level)', () => {
  let workDir: string;
  let session: GimpSession;
  let sourcePath: string;

  beforeAll(
    async () => {
      workDir = mkdtempSync(join(tmpdir(), 'em-gimp-metadata-'));
      session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
      await readySession(session);
      sourcePath = join(workDir, 'gps-xmp-source.jpg');
      writeGpsXmpJpeg(sourcePath);
    },
    LIVE_READY_TIMEOUT_MS
  );

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('fixture sanity: the source JPEG really carries GPS EXIF and an XMP packet before any export is trusted to strip it', () => {
    const { exif, xmp } = findJpegApp1Segments(readFileSync(sourcePath));
    expect(exif.length).toBeGreaterThan(0);
    expect(findTiffIfd0(exif[0]!).has(GPS_IFD_POINTER_TAG)).toBe(true);
    expect(xmp.length).toBeGreaterThan(0);
    expect(xmp[0]!.includes(XMP_MARKER)).toBe(true);
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
      const chunks = findPngChunks(readFileSync(outPath));
      expect(chunks.has('eXIf')).toBe(false);
      expect(pngHasXmpItxt(chunks)).toBe(false);
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

  it('export to tiff strips the GPSInfo IFD pointer and the XMP tag', async () => {
    const opened = await session.call<{ image: number }>('open', { path: sourcePath });
    try {
      const outPath = join(workDir, 'out.tiff');
      await session.call('export', { image: opened.image, path: outPath });
      const tags = findTiffIfd0(readFileSync(outPath));
      expect(tags.has(GPS_IFD_POINTER_TAG)).toBe(false);
      expect(tags.has(XMP_TAG)).toBe(false);
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
