/**
 * Per-effect pixel verifiers for `gimp_filter op=apply`'s allow-listed GEGL effects (vignette,
 * black_white, motion_blur, lens_blur, add_noise, drop_shadow) against real headless GIMP. Same
 * shape as `adjust.live.test.ts`'s own per-type verifiers, dispatched through the `filter` bridge
 * op (`op: 'apply'`) instead of `adjust`: known args -> `filter op=list` reports the SAME user
 * values -> re-editing with those listed values renders pixel-identical (maxAbsDiff 0) -> one
 * effect-specific pixel assertion -> (for the spatial effects) proxy-vs-full-res fidelity with a
 * negative control, the same shape `adjust.live.test.ts`'s gaussian_blur proxy-fidelity test uses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  pixelAt,
  patchVariance,
  writeCheckerboard,
  writeNoisyField,
  writeHardEdge,
  writeColorSwatches,
  maxAbsDiff,
  srgbToLinear,
  linearToSrgb,
  readySession,
  LIVE_READY_TIMEOUT_MS,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

/** A PNG signature + chunk writer, RGBA (color type 6) -- support.ts's own `writePng` is RGB-only
 * (every existing gimp-live fixture is opaque), and drop_shadow is the first effect here that
 * needs a real transparent region to cast a shadow through. Kept local to this file rather than
 * added to the shared support.ts, since other Spiral 1 PRs touch that file concurrently. */
function pngChunkLocal(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  let c = ~0;
  for (const byte of Buffer.concat([typeBuf, data])) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(~c >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** width x height RGBA PNG: an opaque `fill` square from (sx,sy) to (sx+size,sy+size), fully
 * transparent (alpha 0) everywhere else -- a real alpha edge for drop_shadow to cast a shadow
 * from, unlike every other fixture here (opaque RGB, no alpha channel at all). */
function writeRgbaSquare(
  path: string,
  width: number,
  height: number,
  sx: number,
  sy: number,
  size: number,
  fill: [number, number, number]
): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha (RGBA)
  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // per-scanline filter: None
    for (let x = 0; x < width; x++) {
      const inside = x >= sx && x < sx + size && y >= sy && y < sy + size;
      raw[offset++] = fill[0];
      raw[offset++] = fill[1];
      raw[offset++] = fill[2];
      raw[offset++] = inside ? 255 : 0;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunkLocal('IHDR', ihdr),
    pngChunkLocal('IDAT', deflateSync(raw)),
    pngChunkLocal('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

describe.skipIf(!install)('gimp_filter op=apply: allow-listed GEGL effect filters', () => {
  let workDir: string;
  let session: GimpSession;
  let swatchesPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-effects-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    await readySession(session);
    swatchesPath = join(workDir, 'swatches.png');
    writeColorSwatches(swatchesPath);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  // ---- gimp_filter op=apply reports values a re-edit can take back unchanged --------------------
  // One filter of every effect with known, non-default args; list it; re-edit it with exactly the
  // listed params; the render must not move by a single level -- the exact defect class
  // adjust.live.test.ts's own "list round trip" test guards for gimp_add_adjustment's types.

  const LIST_ROUND_TRIP_ARGS: Array<[string, Record<string, unknown>]> = [
    ['vignette', { radius: 1.5, softness: 0.5, gamma: 1.8, center_x: 0.4, center_y: 0.6 }],
    [
      'black_white',
      { red_weight: 0.6, green_weight: 1.2, blue_weight: 0.2, preserve_luminosity: true },
    ],
    ['motion_blur', { length: 25, angle: 45 }],
    ['lens_blur', { radius: 15, highlight_factor: 0.3 }],
    ['add_noise', { noise_amount: 0.4, alpha: 0.1, seed: 42 }],
    ['drop_shadow', { offset_x: -10, offset_y: 15, radius: 8, opacity: 0.7 }],
  ];

  it.each(LIST_ROUND_TRIP_ARGS)(
    'list round trip: re-editing a %s filter with its own listed params changes nothing',
    async (filter, args) => {
      const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
      try {
        const created = await session.call<{ filter_id: number }>('filter', {
          image: opened.image,
          op: 'apply',
          filter,
          ...args,
        });
        const before = join(workDir, `roundtrip-${filter}-before.png`);
        await session.call('export', { image: opened.image, path: before });

        const listed = await session.call<{
          filters: Array<{ filter_id: number; source: string; params: Record<string, unknown> }>;
        }>('filter', { image: opened.image, op: 'list' });
        const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
        expect(rec.source).toBe('editmamei');
        // The tool's own field names and units: exactly what was sent.
        expect(rec.params).toEqual(args);

        await session.call('filter', {
          image: opened.image,
          op: 'apply',
          filter,
          filter_id: created.filter_id,
          ...rec.params,
        });
        const after = join(workDir, `roundtrip-${filter}-after.png`);
        await session.call('export', { image: opened.image, path: after });
        const a = readPng(before);
        const b = readPng(after);
        expect(maxAbsDiff(a, b)).toBe(0);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
  );

  // ---- effect-specific pixel assertions ---------------------------------------------------------

  it('vignette: darkens the corners relative to the centre', async () => {
    const flatPath = join(workDir, 'vignette-flat.png');
    writeCheckerboard(flatPath, 256, 256, 1, 200, 200); // a uniform 200-gray field
    const opened = await session.call<{ image: number }>('open', { path: flatPath });
    try {
      await session.call('filter', {
        image: opened.image,
        op: 'apply',
        filter: 'vignette',
        radius: 0.6,
        softness: 0.3,
      });
      const outPath = join(workDir, 'vignette-flat-out.png');
      await session.call('export', { image: opened.image, path: outPath });
      const ppm = readPng(outPath);
      const [centre] = pixelAt(ppm, 128, 128);
      const [corner] = pixelAt(ppm, 4, 4);
      expect(corner).toBeLessThan(centre);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('black_white (mono-mixer): gray output equals the weighted channel sum, in linear light', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      await session.call('filter', {
        image: opened.image,
        op: 'apply',
        filter: 'black_white',
        red_weight: 0.5,
        green_weight: 0.3,
        blue_weight: 0.2,
      });
      const outPath = join(workDir, 'bw-swatches.png');
      await session.call('export', { image: opened.image, path: outPath });
      const ppm = readPng(outPath);
      // The 'red' swatch fixture color (support.ts's SWATCHES), sampled well inside its patch.
      const [r, g, b] = pixelAt(ppm, 3 * 16 + 8, 8);
      expect(r).toBe(g);
      expect(g).toBe(b); // a real gray: R=G=B
      const [srcR, srcG, srcB] = [200, 40, 40]; // support.ts's 'red' swatch color
      const linear = 0.5 * srgbToLinear(srcR) + 0.3 * srgbToLinear(srcG) + 0.2 * srgbToLinear(srcB);
      const expected = linearToSrgb(linear);
      expect(Math.abs(r - expected), `expected~${expected} got ${r}`).toBeLessThanOrEqual(3);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('motion_blur: reduces variance on a genuinely noisy fixture', async () => {
    const noisyPath = join(workDir, 'motion-noisy.png');
    writeNoisyField(noisyPath, 128, 128);
    const before = await (async () => {
      const opened = await session.call<{ image: number }>('open', { path: noisyPath });
      const outPath = join(workDir, 'motion-noisy-before.png');
      await session.call('export', { image: opened.image, path: outPath });
      await session.call('close', { image: opened.image });
      return readPng(outPath);
    })();
    const opened = await session.call<{ image: number }>('open', { path: noisyPath });
    try {
      await session.call('filter', {
        image: opened.image,
        op: 'apply',
        filter: 'motion_blur',
        length: 30,
        angle: 0,
      });
      const outPath = join(workDir, 'motion-noisy-after.png');
      await session.call('export', { image: opened.image, path: outPath });
      const after = readPng(outPath);
      const varBefore = patchVariance(before, 16, 16, 96, 96);
      const varAfter = patchVariance(after, 16, 16, 96, 96);
      expect(varAfter).toBeLessThan(varBefore);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('lens_blur: softens a hard edge (local variance across the edge drops; far pixels stay near their original extreme)', async () => {
    // A patchVariance before/after comparison (the same shape noise_reduction/sharpen already
    // use), not a direct before/after pixel comparison at the edge itself: gegl:focus-blur's own
    // blur kernel measured live as visibly ASYMMETRIC right at a hard edge (the black side pulls
    // toward white; the immediately adjacent white-side pixel barely moves, even at a large
    // blur-radius) -- a real property of this op, not a bug in this tool's own config. Variance
    // over a window straddling the edge is robust to that asymmetry.
    const edgePath = join(workDir, 'lens-edge.png');
    writeHardEdge(edgePath, 64, 16);
    const before = await (async () => {
      const opened = await session.call<{ image: number }>('open', { path: edgePath });
      const outPath = join(workDir, 'lens-edge-before.png');
      await session.call('export', { image: opened.image, path: outPath });
      await session.call('close', { image: opened.image });
      return readPng(outPath);
    })();
    const opened = await session.call<{ image: number }>('open', { path: edgePath });
    try {
      await session.call('filter', {
        image: opened.image,
        op: 'apply',
        filter: 'lens_blur',
        radius: 15,
      });
      const outPath = join(workDir, 'lens-edge-blurred.png');
      await session.call('export', { image: opened.image, path: outPath });
      const after = readPng(outPath);
      const varBefore = patchVariance(before, 24, 0, 17, 16); // straddles the x=32 edge
      const varAfter = patchVariance(after, 24, 0, 17, 16);
      expect(varAfter).toBeLessThan(varBefore);
      // Measured live: blur-radius 15 moves the far-black pixel to ~49 and the far-white pixel to
      // ~251 -- headroom above both, so this still catches the filter having no effect at all.
      expect(pixelAt(after, 2, 8)[0]).toBeLessThanOrEqual(80); // far from the edge: still ~black
      expect(pixelAt(after, 61, 8)[0]).toBeGreaterThanOrEqual(240); // and still ~white
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('add_noise: increases variance on a flat field', async () => {
    const flatPath = join(workDir, 'noise-flat.png');
    writeCheckerboard(flatPath, 128, 128, 1, 128, 128); // a uniform 128-gray field
    const opened = await session.call<{ image: number }>('open', { path: flatPath });
    try {
      const before = await (async () => {
        const outPath = join(workDir, 'noise-flat-before.png');
        await session.call('export', { image: opened.image, path: outPath });
        return readPng(outPath);
      })();
      await session.call('filter', {
        image: opened.image,
        op: 'apply',
        filter: 'add_noise',
        noise_amount: 0.4,
        seed: 1,
      });
      const outPath = join(workDir, 'noise-flat-after.png');
      await session.call('export', { image: opened.image, path: outPath });
      const after = readPng(outPath);
      const varBefore = patchVariance(before, 16, 16, 96, 96);
      const varAfter = patchVariance(after, 16, 16, 96, 96);
      expect(varAfter).toBeGreaterThan(varBefore);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('drop_shadow: darkens a point outside the opaque content, only once the filter is applied', async () => {
    const shapePath = join(workDir, 'shadow-shape.png');
    writeRgbaSquare(shapePath, 128, 128, 44, 44, 40, [128, 128, 128]);

    const before = await (async () => {
      const opened = await session.call<{ image: number }>('open', { path: shapePath });
      const outPath = join(workDir, 'shadow-before.png');
      await session.call('export', { image: opened.image, path: outPath });
      await session.call('close', { image: opened.image });
      return readPng(outPath);
    })();

    const opened = await session.call<{ image: number }>('open', { path: shapePath });
    try {
      await session.call('filter', {
        image: opened.image,
        op: 'apply',
        filter: 'drop_shadow',
        offset_x: 15,
        offset_y: 15,
        radius: 3,
        opacity: 0.9,
      });
      const outPath = join(workDir, 'shadow-after.png');
      await session.call('export', { image: opened.image, path: outPath });
      const after = readPng(outPath);
      // (95, 95) is well outside the 44..84 square itself, but inside where the +15/+15-offset,
      // blurred shadow lands (its own opaque region maps to roughly 59..99) -- transparent (and so
      // flattened to the background fill) before the filter, darkened by the shadow afterward.
      const [beforeVal] = pixelAt(before, 95, 95);
      const [afterVal] = pixelAt(after, 95, 95);
      expect(afterVal).toBeLessThan(beforeVal);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- proxy fidelity for a spatial effect: measured tolerance, pinned, negative control --------
  // Mirrors adjust.live.test.ts's own gaussian_blur proxy-fidelity test: motion_blur's `length` is
  // in `lib.SPATIAL_SCALE_PROPS`, so a re-edited filter_id's `length` gets scaled by the proxy
  // factor on the mirrored preview -- this is what actually exercises that code path for a NEW
  // spatial effect rather than trusting the existing gaussian_blur coverage to stand in for it.

  it('motion_blur proxy fidelity: length is scaled onto the proxy (negative control: an unscaled length is far off)', async () => {
    const WIDTH = 2048;
    const HEIGHT = 512;
    const SCALE = 512 / WIDTH;
    const LENGTH = 40;
    const checkerPath = join(workDir, 'motion-checker.png');
    writeCheckerboard(checkerPath, WIDTH, HEIGHT, 16, 60, 200);

    async function proxyVsReference(proxyLength: number, tag: string): Promise<number> {
      const opened = await session.call<{ image: number }>('open', { path: checkerPath });
      try {
        await session.call('filter', {
          image: opened.image,
          op: 'apply',
          filter: 'motion_blur',
          length: LENGTH,
          angle: 0,
        });
        const refPath = join(workDir, `${tag}-ref.png`);
        await session.call('preview', {
          image: opened.image,
          max_px: 512,
          region: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, // full-res render, then downscaled
          out_path: refPath,
        });
        const listed = await session.call<{ filters: Array<{ filter_id: number }> }>('filter', {
          image: opened.image,
          op: 'list',
        });
        await session.call('filter', {
          image: opened.image,
          op: 'apply',
          filter: 'motion_blur',
          filter_id: listed.filters[0]!.filter_id,
          length: proxyLength,
        });
        const proxyPath = join(workDir, `${tag}-proxy.png`);
        await session.call('preview', { image: opened.image, max_px: 512, out_path: proxyPath });
        const a = readPng(refPath);
        const b = readPng(proxyPath);
        expect(b.width).toBe(a.width);
        let sum = 0;
        for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
        return sum / a.data.length;
      } finally {
        await session.call('close', { image: opened.image });
      }
    }

    // The real path: the proxy scales LENGTH by SCALE on its own.
    const scaled = await proxyVsReference(LENGTH, 'motion-scaled');
    // What an unscaled proxy would render: a filter whose length, once scaled, lands on LENGTH
    // proxy pixels, i.e. LENGTH / SCALE at full resolution.
    const unscaled = await proxyVsReference(LENGTH / SCALE, 'motion-unscaled');
    expect(scaled, `scaled mean abs diff ${scaled}`).toBeLessThan(6);
    expect(unscaled, `unscaled mean abs diff ${unscaled}`).toBeGreaterThan(scaled * 4);
  });
});
