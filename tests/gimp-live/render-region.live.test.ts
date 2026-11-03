/**
 * The bridge-only `render_region` op (an exact full-resolution RGBA crop of a region, with an
 * optional hole channel) and `export`'s `keep_alpha` option, against real headless GIMP. Pixels are
 * read back from independently decoded PNGs (`support.ts`'s `readPng` / `readPngRgba`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  readPngRgba,
  readGrayscalePgm,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

vi.setConfig({ testTimeout: 120_000 });

const install: GimpInstall | null = await detectGimp();

const SIZE = 300;

interface Region {
  path: string;
  width: number;
  height: number;
  box: number[];
}

describe.skipIf(!install)('render_region and export keep_alpha', () => {
  let workDir: string;
  let session: GimpSession;
  let counter = 0;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-region-'));
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

  const out = (ext = 'png') => join(workDir, `out-${counter++}.${ext}`);

  const texture = (extra: Record<string, unknown> = {}) =>
    session.call<{ image: number; layer_id: number }>('test_texture_image', {
      width: SIZE,
      height: SIZE,
      seed: 5,
      dots: [],
      ...extra,
    });

  async function composite(image: number) {
    const path = out();
    await session.call('export', { image, path });
    return readPng(path);
  }

  const rgbAt = (p: { width: number; data: Buffer }, x: number, y: number, ch = 3) => {
    const i = (y * p.width + x) * ch;
    return [p.data[i], p.data[i + 1], p.data[i + 2]];
  };

  const openIds = async () =>
    (await session.call<{ ids: number[] }>('test_open_image_ids', {})).ids;

  describe('render_region', () => {
    it('returns exactly the box at full resolution, pixel for pixel', async () => {
      const { image } = await texture();
      const full = await composite(image);
      const path = out();
      const r = await session.call<Region>('render_region', {
        image,
        box: [40, 60, 100, 80],
        out_path: path,
      });
      expect(r).toMatchObject({ width: 100, height: 80, box: [40, 60, 100, 80] });
      const png = readPngRgba(path);
      expect([png.width, png.height, png.channels]).toEqual([100, 80, 4]);
      for (let y = 0; y < 80; y++) {
        for (let x = 0; x < 100; x++) {
          expect(rgbAt(png, x, y, 4), `pixel ${x},${y}`).toEqual(rgbAt(full, 40 + x, 60 + y));
          expect(png.data[(y * 100 + x) * 4 + 3]).toBe(255);
        }
      }
    });

    it('clamps a box that runs past the canvas, and refuses one with nothing on it', async () => {
      const { image } = await texture();
      const r = await session.call<Region>('render_region', {
        image,
        box: [250, 270, 100, 100],
        out_path: out(),
      });
      expect(r).toMatchObject({ width: 50, height: 30, box: [250, 270, 50, 30] });
      await expect(
        session.call('render_region', { image, box: [400, 0, 10, 10], out_path: out() })
      ).rejects.toThrow(/does not overlap/);
      await expect(
        session.call('render_region', { image, box: [0, 0, 0, 10], out_path: out() })
      ).rejects.toThrow(/positive/);
      await expect(
        session.call('render_region', { image, box: [0, 0, 10, 10], out_path: out('jpg') })
      ).rejects.toThrow(/\.png/);
    });

    it('turns the hole channel into transparency: alpha is 255 minus the channel value', async () => {
      const { image } = await texture();
      await session.call('create_mask', {
        image,
        type: 'rectangle',
        name: 'Hole',
        x: 70,
        y: 80,
        width: 30,
        height: 20,
      });
      await session.call('create_mask', {
        image,
        type: 'gradient_linear',
        name: 'Ramp',
        x1: 0,
        y1: 0,
        x2: SIZE - 1,
        y2: 0,
      });
      const full = await composite(image);
      const box = [40, 60, 100, 80];
      const check = async (channel: string) => {
        const pgm = out('pgm');
        await session.call('export_mask', { image, channel, path: pgm });
        const values = readGrayscalePgm(pgm);
        const path = out();
        await session.call('render_region', { image, box, out_path: path, hole_channel: channel });
        const png = readPngRgba(path);
        let partial = 0;
        for (let y = 0; y < 80; y++) {
          for (let x = 0; x < 100; x++) {
            const v = values[(60 + y) * SIZE + 40 + x]!;
            const alpha = png.data[(y * 100 + x) * 4 + 3]!;
            expect(alpha, `${channel} alpha at ${x},${y}`).toBe(255 - v);
            if (v > 0 && v < 255) partial++;
            // color is the composite's wherever the pixel is still visible enough to compare
            if (alpha === 255) expect(rgbAt(png, x, y, 4)).toEqual(rgbAt(full, 40 + x, 60 + y));
          }
        }
        return partial;
      };
      expect(await check('Hole')).toBe(0);
      expect(await check('Ramp')).toBeGreaterThan(50);
      await expect(
        session.call('render_region', {
          image,
          box,
          out_path: out(),
          hole_channel: 'No such channel',
        })
      ).rejects.toThrow(/no channel named/);
    });

    it('renders one layer on its own, ignoring what covers it, and transparent where it is not', async () => {
      const base = await texture({ seed: 1 });
      const top = await session.call<{ layer_id: number }>('test_texture_image', {
        image: base.image,
        width: SIZE,
        height: SIZE,
        layer_width: 150,
        layer_height: 150,
        layer_x: 100,
        layer_y: 100,
        seed: 2,
        base: 220,
        name: 'Top',
        dots: [],
      });
      const composed = await composite(base.image);
      await session.call('layer', {
        image: base.image,
        op: 'set',
        layer_id: top.layer_id,
        visible: false,
      });
      const baseOnly = await composite(base.image);
      await session.call('layer', {
        image: base.image,
        op: 'set',
        layer_id: top.layer_id,
        visible: true,
      });

      const box = [90, 90, 100, 100];
      const ofBase = out();
      await session.call('render_region', {
        image: base.image,
        layer_id: base.layer_id,
        box,
        out_path: ofBase,
      });
      const b = readPngRgba(ofBase);
      const ofTop = out();
      await session.call('render_region', {
        image: base.image,
        layer: 'Top',
        box,
        out_path: ofTop,
      });
      const t = readPngRgba(ofTop);
      const whole = out();
      await session.call('render_region', { image: base.image, box, out_path: whole });
      const w = readPngRgba(whole);
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          const i = (y * 100 + x) * 4;
          // the base layer, even where Top covers it
          expect(rgbAt(b, x, y, 4), `base ${x},${y}`).toEqual(rgbAt(baseOnly, 90 + x, 90 + y));
          expect(b.data[i + 3]).toBe(255);
          // the whole composite shows Top where it lies
          expect(rgbAt(w, x, y, 4), `composite ${x},${y}`).toEqual(rgbAt(composed, 90 + x, 90 + y));
          // Top alone: transparent outside its 150x150 box at (100,100), opaque inside
          const inside = 90 + x >= 100 && 90 + y >= 100 && 90 + x < 250 && 90 + y < 250;
          expect(t.data[i + 3], `top alpha ${x},${y}`).toBe(inside ? 255 : 0);
          if (inside) expect(rgbAt(t, x, y, 4)).toEqual(rgbAt(composed, 90 + x, 90 + y));
        }
      }
    });

    it('is transparent where no layer covers the box', async () => {
      const { image } = await texture({
        layer_width: 100,
        layer_height: 100,
        layer_x: 100,
        layer_y: 100,
      });
      const path = out();
      await session.call('render_region', { image, box: [50, 50, 200, 200], out_path: path });
      const png = readPngRgba(path);
      expect(png.channels).toBe(4);
      for (const [x, y, a] of [
        [0, 0, 0],
        [199, 199, 0],
        [49, 100, 0],
        [60, 60, 255],
        [149, 149, 255],
        [150, 150, 0],
      ] as const) {
        expect(png.data[(y * 200 + x) * 4 + 3], `alpha ${x},${y}`).toBe(a);
      }
    });

    it('refuses a box past 4096 px a side and never downscales', async () => {
      const wide = await session.call<{ image: number }>('test_texture_image', {
        width: 4200,
        height: 20,
        seed: 1,
        dots: [],
      });
      const path = out();
      await expect(
        session.call('render_region', { image: wide.image, box: [0, 0, 4100, 20], out_path: path })
      ).rejects.toThrow(/at most 4096 px/);
      expect(existsSync(path)).toBe(false);
      const ok = await session.call<Region>('render_region', {
        image: wide.image,
        box: [0, 0, 4096, 20],
        out_path: path,
      });
      expect([ok.width, ok.height]).toEqual([4096, 20]);
      expect(readPngRgba(path).width).toBe(4096);
    });

    it('never leaves its temporary image open, on success or failure', async () => {
      const { image, layer_id } = await texture();
      const before = await openIds();
      expect(before).toContain(image);
      await session.call('render_region', { image, box: [0, 0, 50, 50], out_path: out() });
      await session.call('render_region', {
        image,
        layer_id,
        box: [0, 0, 50, 50],
        out_path: out(),
      });
      expect(await openIds()).toEqual(before);
      // the failure happens after the temporary image exists: no layer is visible
      await session.call('layer', { image, op: 'set', layer_id, visible: false });
      await expect(
        session.call('render_region', { image, box: [0, 0, 50, 50], out_path: out() })
      ).rejects.toThrow(/no visible layer/);
      await expect(
        session.call('render_region', {
          image,
          layer_id,
          box: [0, 0, 50, 50],
          out_path: out('jpg'),
        })
      ).rejects.toThrow();
      expect(await openIds()).toEqual(before);
    });

    it('converts to sRGB: an image assigned the linear profile comes out re-encoded', async () => {
      const { image } = await texture({ base: 150 });
      const path = out();
      await session.call('test_assign_linear_profile', { image });
      await session.call('render_region', { image, box: [0, 0, 20, 20], out_path: path });
      const png = readPngRgba(path);
      // a profile conversion moves a mid-gray-ish noise pixel; plain assignment would not
      const plain = await texture({ base: 150 });
      const plainPath = out();
      await session.call('render_region', {
        image: plain.image,
        box: [0, 0, 20, 20],
        out_path: plainPath,
      });
      const ref = readPngRgba(plainPath);
      let differing = 0;
      for (let i = 0; i < 20 * 20; i++)
        if (png.data[i * 4 + 1] !== ref.data[i * 4 + 1]) differing++;
      expect(differing).toBeGreaterThan(0);
      expect(png.channels).toBe(4);
    });
  });

  describe('gimp export keep_alpha', () => {
    const cutOut = () =>
      texture({ layer_width: 120, layer_height: 100, layer_x: 90, layer_y: 110 });

    it('exports a cut-out as RGBA with transparent corners', async () => {
      const { image } = await cutOut();
      const path = out();
      await session.call('export', { image, path, keep_alpha: true });
      const png = readPngRgba(path);
      expect([png.width, png.height, png.channels]).toEqual([SIZE, SIZE, 4]);
      const alpha = (x: number, y: number) => png.data[(y * SIZE + x) * 4 + 3];
      for (const [x, y] of [
        [0, 0],
        [SIZE - 1, 0],
        [0, SIZE - 1],
        [SIZE - 1, SIZE - 1],
        [89, 150],
        [210, 150],
        [150, 109],
        [150, 210],
      ] as const)
        expect(alpha(x, y), `outside ${x},${y}`).toBe(0);
      for (const [x, y] of [
        [90, 110],
        [209, 209],
        [150, 160],
      ] as const)
        expect(alpha(x, y), `inside ${x},${y}`).toBe(255);
      // the visible part is the same pixels a normal export has
      const flat = out();
      await session.call('export', { image, path: flat });
      const plain = readPng(flat);
      for (const [x, y] of [
        [90, 110],
        [150, 160],
        [209, 209],
      ] as const)
        expect(rgbAt(png, x, y, 4)).toEqual(rgbAt(plain, x, y));
    });

    it('still flattens onto white by default, as a 3-channel PNG', async () => {
      const { image } = await cutOut();
      const path = out();
      await session.call('export', { image, path });
      const png = readPngRgba(path);
      expect(png.channels).toBe(3);
      expect(rgbAt(png, 0, 0, 4)).toEqual([255, 255, 255]);
      await session.call('export', { image, path: out(), keep_alpha: false });
    });

    it('keeps the alpha of a half-transparent layer exactly', async () => {
      const { image } = await texture({ alpha: 100 });
      const path = out();
      await session.call('export', { image, path, keep_alpha: true });
      const png = readPngRgba(path);
      expect(png.data[3]).toBe(100);
      expect(png.data[(150 * SIZE + 150) * 4 + 3]).toBe(100);
    });

    it('writes a webp with an alpha channel only when asked', async () => {
      const { image } = await cutOut();
      const flags = (file: string) => {
        const buf = readFileSync(file);
        expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
        expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
        return buf.toString('ascii', 12, 16) === 'VP8X' ? buf[20]! & 0x10 : 0;
      };
      const kept = out('webp');
      await session.call('export', { image, path: kept, keep_alpha: true });
      expect(flags(kept)).toBeTruthy();
      const flat = out('webp');
      await session.call('export', { image, path: flat });
      expect(flags(flat)).toBe(0);
    });

    it('is refused for jpeg, tiff and xcf, and must be a boolean', async () => {
      const { image } = await cutOut();
      for (const ext of ['jpg', 'jpeg', 'tif', 'tiff', 'xcf']) {
        const path = out(ext);
        await expect(
          session.call('export', { image, path, keep_alpha: true }),
          ext
        ).rejects.toThrow(/keep_alpha only works with a \.png or \.webp/);
        expect(existsSync(path)).toBe(false);
      }
      await expect(
        session.call('export', { image, path: out(), keep_alpha: 'yes' })
      ).rejects.toThrow(/keep_alpha must be a boolean/);
    });
  });
});
