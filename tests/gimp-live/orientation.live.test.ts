/**
 * EXIF orientation against real headless GIMP: `open` and `place_image` turn a tagged photo
 * upright (dimensions and pixel placement), clear the image's own tag, and an export of the
 * result carries no orientation. Fixtures are the corner-marker picture stored the way a camera
 * stores it under each orientation, tagged by splicing an EXIF APP1 into a GIMP-exported JPEG.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  CORNER_COLORS,
  findJpegApp1Segments,
  LIVE_READY_TIMEOUT_MS,
  pixelAt,
  readPng,
  readySession,
  TEST_OPS_PY,
  withExifOrientation,
  writeCornerMarkers,
} from './support.ts';

vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

const W = 72; // upright size of every fixture
const H = 48;
const TOLERANCE = 40; // JPEG round-trip slack per channel

type Rgb = readonly [number, number, number];

describe.skipIf(!install)('EXIF orientation (live GIMP)', () => {
  let workDir: string;
  let session: GimpSession;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-orientation-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** A JPEG of the corner picture stored under `orientation`, tagged with it. */
  async function taggedJpeg(orientation: number): Promise<string> {
    const png = join(workDir, `stored-${orientation}.png`);
    writeCornerMarkers(png, W, H, orientation);
    const opened = await session.call<{ image: number }>('open', { path: png });
    const base = join(workDir, `stored-${orientation}-base.jpg`);
    await session.call('export', { image: opened.image, path: base, quality: 100 });
    await session.call('close', { image: opened.image });
    const out = join(workDir, `tagged-${orientation}.jpg`);
    writeFileSync(out, withExifOrientation(readFileSync(base), orientation));
    return out;
  }

  function near(actual: Rgb, expected: Rgb): boolean {
    return actual.every((v, i) => Math.abs(v - expected[i]!) <= TOLERANCE);
  }

  /** Asserts the four corner blocks of a PNG region sit where the upright picture puts them. */
  function expectUpright(png: string, ox: number, oy: number) {
    const img = readPng(png);
    const cx = (x: number) => ox + x;
    const cy = (y: number) => oy + y;
    const bw = Math.floor(W / 4);
    const bh = Math.floor(H / 4);
    const probes: Array<[string, number, number, Rgb]> = [
      ['top-left', bw / 2, bh / 2, CORNER_COLORS.topLeft],
      ['top-right', W - bw / 2, bh / 2, CORNER_COLORS.topRight],
      ['bottom-left', bw / 2, H - bh / 2, CORNER_COLORS.bottomLeft],
      ['bottom-right', W - bw / 2, H - bh / 2, CORNER_COLORS.bottomRight],
    ];
    for (const [name, x, y, color] of probes) {
      const got = pixelAt(img, cx(Math.floor(x)), cy(Math.floor(y)));
      expect(near(got, color), `${name}: got ${got}, want ${color}`).toBe(true);
    }
  }

  const orientations = [2, 3, 4, 5, 6, 7, 8];

  for (const orientation of orientations) {
    it(`open: orientation ${orientation} arrives upright, tag normalised, and exports clean`, async () => {
      const path = await taggedJpeg(orientation);
      const opened = await session.call<{
        image: number;
        width: number;
        height: number;
        orientation_applied?: number;
      }>('open', { path });
      try {
        expect([opened.width, opened.height]).toEqual([W, H]);
        expect(opened.orientation_applied).toBe(orientation);
        const tag = await session.call<{ value: string | null }>('test_metadata_tag', {
          image: opened.image,
          tag: 'Exif.Image.Orientation',
        });
        // An absent tag and a tag of 1 both mean normal.
        expect([null, '1']).toContain(tag.value);

        const png = join(workDir, `open-${orientation}.png`);
        await session.call('export', { image: opened.image, path: png });
        expectUpright(png, 0, 0);

        const jpg = join(workDir, `open-${orientation}-out.jpg`);
        await session.call('export', { image: opened.image, path: jpg });
        expect(findJpegApp1Segments(readFileSync(jpg)).exif).toHaveLength(0);
      } finally {
        await session.call('close', { image: opened.image });
      }
    });
  }

  for (const orientation of [6, 8, 3, 2, 5]) {
    it(`place_image: orientation ${orientation} lands upright at the requested offset`, async () => {
      const path = await taggedJpeg(orientation);
      const doc = await session.call<{ image: number }>('create_document', {
        width: 200,
        height: 160,
        fill: 'white',
      });
      try {
        const placed = await session.call<{
          width: number;
          height: number;
          x: number;
          y: number;
          orientation_applied?: number;
        }>('place_image', { image: doc.image, path, x: 30, y: 20 });
        expect([placed.width, placed.height]).toEqual([W, H]);
        expect([placed.x, placed.y]).toEqual([30, 20]);
        expect(placed.orientation_applied).toBe(orientation);
        const png = join(workDir, `place-${orientation}.png`);
        await session.call('export', { image: doc.image, path: png });
        expectUpright(png, 30, 20);
      } finally {
        await session.call('close', { image: doc.image });
      }
    });
  }

  it('an untagged JPEG and an orientation-1 JPEG open unchanged, with no orientation_applied', async () => {
    for (const orientation of [0, 1]) {
      const png = join(workDir, `plain-${orientation}.png`);
      writeCornerMarkers(png, W, H, 1);
      const src = await session.call<{ image: number }>('open', { path: png });
      const base = join(workDir, `plain-${orientation}-base.jpg`);
      await session.call('export', { image: src.image, path: base, quality: 100 });
      await session.call('close', { image: src.image });
      const path = orientation === 0 ? base : join(workDir, `plain-${orientation}.jpg`);
      if (orientation !== 0) writeFileSync(path, withExifOrientation(readFileSync(base), 1));
      const opened = await session.call<{
        image: number;
        width: number;
        height: number;
        orientation_applied?: number;
      }>('open', { path });
      try {
        expect([opened.width, opened.height]).toEqual([W, H]);
        expect(opened.orientation_applied).toBeUndefined();
        const out = join(workDir, `plain-${orientation}-out.png`);
        await session.call('export', { image: opened.image, path: out });
        expectUpright(out, 0, 0);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
  });

  it('a malformed orientation tag never fails an open', async () => {
    const png = join(workDir, 'bad-tag.png');
    writeCornerMarkers(png, W, H, 1);
    const src = await session.call<{ image: number }>('open', { path: png });
    const base = join(workDir, 'bad-tag-base.jpg');
    await session.call('export', { image: src.image, path: base, quality: 100 });
    await session.call('close', { image: src.image });
    const path = join(workDir, 'bad-tag.jpg');
    writeFileSync(path, withExifOrientation(readFileSync(base), 99));
    const opened = await session.call<{
      image: number;
      width: number;
      height: number;
      orientation_applied?: number;
    }>('open', { path });
    try {
      expect([opened.width, opened.height]).toEqual([W, H]);
      expect(opened.orientation_applied).toBeUndefined();
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('a HEIF file is not rotated a second time on top of its loader', async () => {
    // The image is stored sideways and tagged 6; GIMP's HEIF writer/loader pair hands back the
    // pixels unchanged with the tag already 1, so the bridge must leave them alone.
    const path = await taggedJpeg(6);
    const opened = await session.call<{ image: number }>('open', { path });
    const heic = join(workDir, 'tagged.heic');
    try {
      // `open` already made it upright and dropped the tag; put the tag back so the file carries one.
      await session.call('test_set_orientation_tag', { image: opened.image, value: 6 });
      await session.call('test_save_unstripped', { image: opened.image, path: heic });
    } finally {
      await session.call('close', { image: opened.image });
    }
    const reopened = await session.call<{
      image: number;
      width: number;
      height: number;
      orientation_applied?: number;
    }>('open', { path: heic });
    try {
      expect([reopened.width, reopened.height]).toEqual([W, H]);
      expect(reopened.orientation_applied).toBeUndefined();
      const png = join(workDir, 'heic-out.png');
      await session.call('export', { image: reopened.image, path: png });
      expectUpright(png, 0, 0);
    } finally {
      await session.call('close', { image: reopened.image });
    }
  });
});
