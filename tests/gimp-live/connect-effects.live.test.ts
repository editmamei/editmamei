/**
 * Pixel verifiers for gimp_add_effect's outline, outer_glow and surface_blur, the grain_extract /
 * grain_merge blend modes, and live filters on a text layer, against real headless GIMP. Same
 * bridge-op shape as effect-filters.live.test.ts. The fixtures are white on a transparent canvas,
 * and a flattening export fills the canvas white, so a BLACK ring or glow reads as a dip below 255.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  pixelAt,
  patchVariance,
  writeRgbaSquare,
  writeNoisyPatchBesideEdge,
  maxAbsDiff,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

interface FilterRec {
  filter_id: number;
  type: string | null;
  source: string;
  params: Record<string, unknown>;
}

describe.skipIf(!install)('outline, outer_glow, surface_blur, grain modes, text layers', () => {
  let workDir: string;
  let session: GimpSession;
  let whiteSquare: string; // opaque white 40x40 at (44,44) on a transparent 128x128
  let noisyPatch: string; // noisy dark left half, flat bright right half, hard edge at x=64

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-connect-fx-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    whiteSquare = join(workDir, 'white-square.png');
    writeRgbaSquare(whiteSquare, 128, 128, 44, 44, 40, [255, 255, 255]);
    noisyPatch = join(workDir, 'noisy-patch.png');
    writeNoisyPatchBesideEdge(noisyPatch, 128, 128);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function open(path: string): Promise<number> {
    return (await session.call<{ image: number }>('open', { path })).image;
  }

  async function render(image: number, tag: string) {
    const out = join(workDir, `${tag}.png`);
    await session.call('export', { image, path: out });
    return readPng(out);
  }

  async function filters(image: number): Promise<FilterRec[]> {
    return (await session.call<{ filters: FilterRec[] }>('filter', { image, op: 'list' })).filters;
  }

  // The square covers x,y in 44..83; row 64 runs through its middle.
  const ROW = 64;

  describe('outline', () => {
    it('draws a ring of `width` px of the color outside the alpha edge and leaves the interior alone', async () => {
      const image = await open(whiteSquare);
      try {
        await session.call('effect', { image, type: 'outline', width: 6, color: '#000000' });
        const ppm = await render(image, 'outline-black');
        for (let x = 38; x <= 43; x++) {
          expect(pixelAt(ppm, x, ROW)[0], `ring pixel x=${x}`).toBeLessThanOrEqual(2);
        }
        expect(pixelAt(ppm, 37, ROW)[0], 'just outside the ring').toBeGreaterThanOrEqual(253);
        expect(pixelAt(ppm, 20, ROW)[0]).toBe(255);
        // The interior, the 40x40 white square, is untouched.
        for (const [x, y] of [
          [44, 44],
          [64, 64],
          [83, 83],
          [50, 70],
        ] as const) {
          expect(pixelAt(ppm, x, y), `interior (${x},${y})`).toEqual([255, 255, 255]);
        }
        // A column through the square shows the same ring above it.
        expect(pixelAt(ppm, 64, 39)[0]).toBeLessThanOrEqual(2);
        expect(pixelAt(ppm, 64, 37)[0]).toBeGreaterThanOrEqual(253);
      } finally {
        await session.call('close', { image });
      }
    });

    it('honours the color: a red ring is red, not gray', async () => {
      const image = await open(whiteSquare);
      try {
        await session.call('effect', { image, type: 'outline', width: 4, color: '#ff0000' });
        const [r, g, b] = pixelAt(await render(image, 'outline-red'), 41, ROW);
        expect(r).toBeGreaterThanOrEqual(250);
        expect(g).toBeLessThanOrEqual(5);
        expect(b).toBeLessThanOrEqual(5);
      } finally {
        await session.call('close', { image });
      }
    });

    it('list reports the tool fields, describe shows the type, a re-edit with them changes nothing, and delete removes the ring', async () => {
      const image = await open(whiteSquare);
      try {
        const args = { width: 9, color: '#223344' };
        const created = await session.call<{ filter_id: number; type: string }>('effect', {
          image,
          type: 'outline',
          ...args,
        });
        expect(created.type).toBe('outline');
        const before = await render(image, 'outline-rt-before');

        const rec = (await filters(image)).find((f) => f.filter_id === created.filter_id)!;
        expect(rec.source).toBe('editmamei');
        expect(rec.type).toBe('outline');
        expect(rec.params).toEqual(args);

        const described = await session.call<FilterRec>('describe', {
          image,
          what: 'filter',
          filter_id: created.filter_id,
        });
        expect(described.type).toBe('outline');

        await session.call('effect', {
          image,
          type: 'outline',
          filter_id: created.filter_id,
          ...rec.params,
        });
        expect(maxAbsDiff(before, await render(image, 'outline-rt-after'))).toBe(0);

        // A merge re-edit of one field keeps the other.
        await session.call('effect', {
          image,
          type: 'outline',
          filter_id: created.filter_id,
          width: 3,
        });
        expect((await filters(image))[0]!.params).toEqual({ width: 3, color: '#223344' });

        const plain = await render(image, 'outline-rt-plain-ref');
        await session.call('filter', { image, op: 'delete', filter_id: created.filter_id });
        expect(await filters(image)).toHaveLength(0);
        const gone = await render(image, 'outline-rt-gone');
        expect(pixelAt(gone, 41, ROW)[0]).toBe(255);
        expect(pixelAt(plain, 41, ROW)[0]).toBeLessThan(255);
      } finally {
        await session.call('close', { image });
      }
    });

    it('refuses to re-edit an outline as a drop_shadow, and the other way round', async () => {
      const image = await open(whiteSquare);
      try {
        const outline = await session.call<{ filter_id: number }>('effect', {
          image,
          type: 'outline',
        });
        await expect(
          session.call('effect', {
            image,
            type: 'drop_shadow',
            filter_id: outline.filter_id,
            radius: 5,
          })
        ).rejects.toMatchObject({ code: 'invalid_argument' });
        const shadow = await session.call<{ filter_id: number }>('effect', {
          image,
          type: 'drop_shadow',
        });
        await expect(
          session.call('effect', { image, type: 'outline', filter_id: shadow.filter_id, width: 5 })
        ).rejects.toMatchObject({ code: 'invalid_argument' });
        // They list under their own types.
        const types = (await filters(image)).map((f) => f.type).sort();
        expect(types).toEqual(['drop_shadow', 'outline']);
      } finally {
        await session.call('close', { image });
      }
    });

    it('refuses a bad color and an out-of-range width at the bridge', async () => {
      const image = await open(whiteSquare);
      try {
        for (const args of [{ color: 'red' }, { width: 0 }, { width: 101 }, { offset_x: 5 }]) {
          await expect(
            session.call('effect', { image, type: 'outline', ...args })
          ).rejects.toMatchObject({ code: 'invalid_argument' });
        }
        expect(await filters(image)).toHaveLength(0);
      } finally {
        await session.call('close', { image });
      }
    });

    it('survives an arbitrary-angle rotate (no offset to misalign), unlike an offset drop_shadow', async () => {
      const image = await open(whiteSquare);
      const other = await open(whiteSquare);
      try {
        await session.call('effect', { image, type: 'outline', width: 4 });
        await session.call('rotate', { image, degrees: 15, expand: true });
        expect(await filters(image)).toHaveLength(1);

        await session.call('effect', { image: other, type: 'drop_shadow' }); // offset 20,20
        await expect(
          session.call('rotate', { image: other, degrees: 15, expand: true })
        ).rejects.toMatchObject({ code: 'invalid_argument' });
      } finally {
        await session.call('close', { image });
        await session.call('close', { image: other });
      }
    });

    it('a resize scales the width with the image', async () => {
      const image = await open(whiteSquare);
      try {
        await session.call('effect', { image, type: 'outline', width: 4 });
        await session.call('resize', { image, width: 256 });
        expect((await filters(image))[0]!.params).toEqual({ width: 8, color: '#000000' });
      } finally {
        await session.call('close', { image });
      }
    });

    it('proxy preview matches a full-resolution render (width is scaled onto the proxy)', async () => {
      const W = 2048;
      const H = 512;
      const big = join(workDir, 'outline-big.png');
      writeRgbaSquare(big, W, H, 700, 56, 400, [255, 255, 255]);
      const image = await open(big);
      try {
        await session.call('effect', { image, type: 'outline', width: 80 });
        const ref = join(workDir, 'outline-prev-ref.png');
        await session.call('preview', {
          image,
          max_px: 512,
          region: { x: 0, y: 0, width: W, height: H },
          out_path: ref,
        });
        const proxy = join(workDir, 'outline-prev-proxy.png');
        const res = await session.call<{ unmirrored_filters?: string[] }>('preview', {
          image,
          max_px: 512,
          out_path: proxy,
        });
        expect(res.unmirrored_filters ?? []).toEqual([]);
        const a = readPng(ref);
        const b = readPng(proxy);
        expect(b.width).toBe(a.width);
        let sum = 0;
        for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
        const withRing = sum / a.data.length;

        const plain = await open(big);
        try {
          const plainPath = join(workDir, 'outline-prev-plain.png');
          await session.call('preview', { image: plain, max_px: 512, out_path: plainPath });
          const c = readPng(plainPath);
          let s2 = 0;
          for (let i = 0; i < a.data.length; i++) s2 += Math.abs(a.data[i]! - c.data[i]!);
          const withoutRing = s2 / a.data.length;
          expect(withRing, `ring ${withRing} vs no ring ${withoutRing}`).toBeLessThan(
            withoutRing * 0.3
          );
        } finally {
          await session.call('close', { image: plain });
        }
      } finally {
        await session.call('close', { image });
      }
    });
  });

  describe('outer_glow', () => {
    it('is a soft falloff outside the edge, strongest at the edge, and leaves the interior alone', async () => {
      const image = await open(whiteSquare);
      try {
        await session.call('effect', {
          image,
          type: 'outer_glow',
          spread: 2,
          radius: 12,
          opacity: 0.8,
          color: '#000000',
        });
        const ppm = await render(image, 'glow');
        const out = [43, 40, 36, 30, 22, 10].map((x) => pixelAt(ppm, x, ROW)[0]);
        // Darkest at the edge, brightening monotonically outward, never a hard step.
        for (let i = 1; i < out.length; i++) {
          expect(out[i]!, `falloff at ${i}: ${out}`).toBeGreaterThan(out[i - 1]!);
        }
        expect(out[0]!).toBeLessThan(225); // visibly dark at the edge
        expect(out[0]! - out[1]!).toBeLessThan(40); // soft: no step between neighbours
        expect(out[out.length - 1]!).toBeGreaterThanOrEqual(250); // far side is clear
        expect(pixelAt(ppm, 64, 64)).toEqual([255, 255, 255]);
        expect(pixelAt(ppm, 44, 44)).toEqual([255, 255, 255]);
      } finally {
        await session.call('close', { image });
      }
    });

    it('defaults to a white glow; list round-trips every field and a re-edit changes nothing', async () => {
      const image = await open(whiteSquare);
      try {
        const args = { spread: 3, radius: 30, opacity: 0.6, color: '#00ffcc' };
        const created = await session.call<{ filter_id: number }>('effect', {
          image,
          type: 'outer_glow',
          ...args,
        });
        const before = await render(image, 'glow-rt-before');
        const rec = (await filters(image))[0]!;
        expect(rec.type).toBe('outer_glow');
        expect(rec.params).toEqual(args);
        await session.call('effect', {
          image,
          type: 'outer_glow',
          filter_id: created.filter_id,
          ...rec.params,
        });
        expect(maxAbsDiff(before, await render(image, 'glow-rt-after'))).toBe(0);
        await session.call('filter', { image, op: 'delete', filter_id: created.filter_id });
        expect(await filters(image)).toHaveLength(0);

        await session.call('effect', { image, type: 'outer_glow' });
        expect((await filters(image))[0]!.params).toEqual({
          spread: 4,
          radius: 20,
          opacity: 0.75,
          color: '#ffffff',
        });
      } finally {
        await session.call('close', { image });
      }
    });
  });

  describe('surface_blur', () => {
    async function stats(image: number, tag: string) {
      const ppm = await render(image, tag);
      return {
        sd: Math.sqrt(patchVariance(ppm, 8, 20, 40, 88)), // inside the noisy half
        left: pixelAt(ppm, 61, ROW)[0], // beside the edge, noisy side
        right: pixelAt(ppm, 67, ROW)[0], // beside the edge, flat side
      };
    }

    it('flattens noise next to a hard edge without softening the edge', async () => {
      const base = await open(noisyPatch);
      const baseline = await stats(base, 'sb-base');
      await session.call('close', { image: base });
      expect(baseline.sd).toBeGreaterThan(12); // the fixture really is noisy

      const image = await open(noisyPatch);
      try {
        await session.call('effect', { image, type: 'surface_blur', radius: 8 });
        const out = await stats(image, 'sb-out');
        expect(out.sd, `sd ${baseline.sd} -> ${out.sd}`).toBeLessThan(baseline.sd * 0.25);
        // The step across the edge keeps (nearly) its original size.
        const stepBefore = baseline.right - baseline.left;
        const stepAfter = out.right - out.left;
        expect(stepAfter, `step ${stepBefore} -> ${stepAfter}`).toBeGreaterThan(stepBefore * 0.85);
      } finally {
        await session.call('close', { image });
      }
    });

    it('a lower edge_preservation smooths harder', async () => {
      const results: number[] = [];
      for (const ep of [0.02, 0.5]) {
        const image = await open(noisyPatch);
        try {
          await session.call('effect', {
            image,
            type: 'surface_blur',
            radius: 8,
            edge_preservation: ep,
          });
          results.push((await stats(image, `sb-ep-${ep}`)).sd);
        } finally {
          await session.call('close', { image });
        }
      }
      expect(results[0]!).toBeLessThan(results[1]!);
    });

    it('list round trip, describe, re-edit unchanged, removal restores the noise', async () => {
      const image = await open(noisyPatch);
      try {
        const args = { radius: 12, edge_preservation: 0.2 };
        const created = await session.call<{ filter_id: number }>('effect', {
          image,
          type: 'surface_blur',
          ...args,
        });
        const before = await render(image, 'sb-rt-before');
        const rec = (await filters(image))[0]!;
        expect(rec).toMatchObject({ type: 'surface_blur', source: 'editmamei' });
        expect(rec.params).toEqual(args);
        await session.call('effect', {
          image,
          type: 'surface_blur',
          filter_id: created.filter_id,
          ...rec.params,
        });
        expect(maxAbsDiff(before, await render(image, 'sb-rt-after'))).toBe(0);
        await session.call('filter', { image, op: 'delete', filter_id: created.filter_id });
        expect((await stats(image, 'sb-rt-gone')).sd).toBeGreaterThan(12);
      } finally {
        await session.call('close', { image });
      }
    });

    it('its radius is scaled onto the preview proxy', async () => {
      const W = 2048;
      const H = 512;
      const big = join(workDir, 'sb-big.png');
      writeNoisyPatchBesideEdge(big, W, H);
      const image = await open(big);
      try {
        await session.call('effect', { image, type: 'surface_blur', radius: 40 });
        const res = await session.call<{ unmirrored_filters?: string[] }>('preview', {
          image,
          max_px: 512,
          out_path: join(workDir, 'sb-proxy.png'),
        });
        expect(res.unmirrored_filters ?? []).toEqual([]);
      } finally {
        await session.call('close', { image });
      }
    });
  });

  describe('text layers', () => {
    it('take a live outline and stay editable text; editing the text keeps the filter', async () => {
      const image = await open(noisyPatch);
      try {
        const text = await session.call<{ layer_id: number }>('text', {
          image,
          op: 'create',
          text: 'MEME',
          font_size: 40,
          x: 10,
          y: 10,
          red: 255,
          green: 255,
          blue: 255,
        });
        const isText = async () => {
          const d = await session.call<{
            layers: Array<{ layer_id: number; is_text_layer: boolean }>;
          }>('describe', { image, what: 'layers' });
          return d.layers.find((l) => l.layer_id === text.layer_id)?.is_text_layer;
        };
        expect(await isText()).toBe(true);

        const created = await session.call<{ filter_id: number }>('effect', {
          image,
          type: 'outline',
          width: 3,
          layer_id: text.layer_id,
        });
        expect(created.filter_id).toBeGreaterThan(0);
        expect(await isText()).toBe(true); // not rasterized
        expect(await filters(image)).toHaveLength(1);

        await session.call('text', {
          image,
          op: 'set_content',
          layer_id: text.layer_id,
          text: 'MEMES',
        });
        expect(await isText()).toBe(true);
        expect(await filters(image)).toHaveLength(1); // the outline followed the edit
      } finally {
        await session.call('close', { image });
      }
    });
  });

  describe('grain_extract / grain_merge blend modes', () => {
    it.each([
      ['grain_extract', 'grain-extract'],
      ['grain_merge', 'grain-merge'],
    ])('%s sets the non-legacy GIMP mode and reads back as %s', async (mode, nick) => {
      const image = await open(noisyPatch);
      try {
        const layer = await session.call<{ layer_id: number }>('layer', {
          image,
          op: 'create',
          name: 'Detail',
        });
        await session.call('layer', { image, op: 'set', layer_id: layer.layer_id, mode });
        const d = await session.call<{ layers: Array<{ layer_id: number; mode: string }> }>(
          'describe',
          { image, what: 'layers' }
        );
        expect(d.layers.find((l) => l.layer_id === layer.layer_id)!.mode).toBe(nick);
      } finally {
        await session.call('close', { image });
      }
    });

    it('existing mode names still map to the same GIMP modes', async () => {
      const image = await open(noisyPatch);
      try {
        const layer = await session.call<{ layer_id: number }>('layer', {
          image,
          op: 'create',
          name: 'Modes',
        });
        const expected: Array<[string, string]> = [
          ['multiply', 'multiply'],
          ['soft_light', 'softlight'],
          ['darken', 'darken-only'],
          ['color', 'hsl-color'],
          ['luminosity', 'luminance'],
        ];
        for (const [mode, nick] of expected) {
          await session.call('layer', { image, op: 'set', layer_id: layer.layer_id, mode });
          const d = await session.call<{ layers: Array<{ layer_id: number; mode: string }> }>(
            'describe',
            { image, what: 'layers' }
          );
          expect(d.layers.find((l) => l.layer_id === layer.layer_id)!.mode, mode).toBe(nick);
        }
      } finally {
        await session.call('close', { image });
      }
    });
  });
});
