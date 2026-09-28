/**
 * Per-effect pixel verifiers for `gimp_add_effect`'s allow-listed GEGL effects (vignette,
 * black_white, motion_blur, lens_blur, add_noise, drop_shadow) against real headless GIMP. Same
 * shape as `adjust.live.test.ts`'s own per-type verifiers, dispatched through the bridge's
 * `effect` op (`bridge/ops.py`'s `op_effect`) instead of `adjust`: known args -> `filter op=list`
 * reports the SAME user values -> re-editing with those listed values renders pixel-identical
 * (maxAbsDiff 0) -> one effect-specific pixel assertion -> (for the spatial effects) proxy-vs-
 * full-res fidelity with a negative control, the same shape `adjust.live.test.ts`'s gaussian_blur
 * proxy-fidelity test uses. Uses the TEST_OPS_PY bridge (not the shipped one) so the append-guard
 * test below can drive `test_apply_raw_effect`; every other call here exercises the real,
 * shipped `op_effect`/`_apply_filter`/`_append_masked` unchanged (test_ops.py execs the real
 * ops.py first, then adds test-only ops on top).
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
  writeRgbaSquare,
  SWATCH_SIZE,
  maxAbsDiff,
  srgbToLinear,
  linearToSrgb,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

/** A PNG signature + chunk writer, RGB (color type 2) -- support.ts's own `writePng` is
 * function-per-pixel, awkward for a filled-region-on-background shape like this one. Kept local
 * to this file rather than added to the shared support.ts, since this is the only file that needs
 * an RGB (non-alpha) filled-region writer -- the RGBA one (`writeRgbaSquare`, for drop_shadow) is
 * shared, in support.ts, since geometry-and-masks.live.test.ts needs that one too. */
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

/** width x height RGB (opaque, no alpha) PNG: a `fg` square centered at (cx,cy) on a `bg`
 * background -- an isolated bright spot for lens_blur's `highlight_factor` (a bokeh-highlight
 * boost only visible against a plain background, unlike the checkerboard/edge fixtures above). */
function writeBrightSquare(
  path: string,
  width: number,
  height: number,
  cx: number,
  cy: number,
  size: number,
  bg: number,
  fg: number
): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  const half = size / 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // per-scanline filter: None
    for (let x = 0; x < width; x++) {
      const inside = Math.abs(x - cx) < half && Math.abs(y - cy) < half;
      const v = inside ? fg : bg;
      raw[offset++] = v;
      raw[offset++] = v;
      raw[offset++] = v;
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

describe.skipIf(!install)('gimp_add_effect: allow-listed GEGL effect filters', () => {
  let workDir: string;
  let session: GimpSession;
  let swatchesPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-effects-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    swatchesPath = join(workDir, 'swatches.png');
    writeColorSwatches(swatchesPath);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  // ---- gimp_add_effect reports values a re-edit can take back unchanged -------------------------
  // One filter of every effect with known, non-default args; list it (via gimp_filter's shared
  // stack); re-edit it with exactly the listed params; the render must not move by a single level
  // -- the exact defect class adjust.live.test.ts's own "list round trip" test guards for
  // gimp_add_adjustment's types.

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
    async (type, args) => {
      const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
      try {
        const created = await session.call<{ filter_id: number }>('effect', {
          image: opened.image,
          type,
          ...args,
        });
        const before = join(workDir, `roundtrip-${type}-before.png`);
        await session.call('export', { image: opened.image, path: before });

        const listed = await session.call<{
          filters: Array<{ filter_id: number; source: string; params: Record<string, unknown> }>;
        }>('filter', { image: opened.image, op: 'list' });
        const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
        expect(rec.source).toBe('editmamei');
        // The tool's own field names and units: exactly what was sent.
        expect(rec.params).toEqual(args);

        await session.call('effect', {
          image: opened.image,
          type,
          filter_id: created.filter_id,
          ...rec.params,
        });
        const after = join(workDir, `roundtrip-${type}-after.png`);
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
      await session.call('effect', {
        image: opened.image,
        type: 'vignette',
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
      await session.call('effect', {
        image: opened.image,
        type: 'black_white',
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
      await session.call('effect', {
        image: opened.image,
        type: 'motion_blur',
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
      await session.call('effect', {
        image: opened.image,
        type: 'lens_blur',
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

  it('lens_blur highlight_factor: a bright bokeh halo reaches farther at highlight_factor=1 than at 0', async () => {
    // gegl:focus-blur's own 'lens' mode: `highlight_factor` boosts bright pixels' contribution to
    // the blur kernel, so a small bright spot's halo spreads farther at highlight_factor=1 than at
    // 0 -- verified live during this cap's own sizing (build_lens_blur_params' own comment: "a
    // bright spot's halo reaching ~3x farther out at highlight_factor 1 vs 0"). Sampling a point
    // well outside the original bright square (where a plain blur's halo has mostly faded back to
    // background) isolates that highlight-boost specifically, rather than re-proving the filter
    // blurs at all (already covered by the edge-softening test above).
    const dotPath = join(workDir, 'lens-highlight-dot.png');
    writeBrightSquare(dotPath, 200, 200, 100, 100, 30, 20, 250);
    const FAR_X = 155; // 40px outside the square's own right edge at x=115
    async function renderWithHighlight(factor: number): Promise<number> {
      const opened = await session.call<{ image: number }>('open', { path: dotPath });
      try {
        await session.call('effect', {
          image: opened.image,
          type: 'lens_blur',
          radius: 60,
          highlight_factor: factor,
        });
        const outPath = join(workDir, `lens-highlight-${factor}.png`);
        await session.call('export', { image: opened.image, path: outPath });
        return pixelAt(readPng(outPath), FAR_X, 100)[0];
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
    const withoutHighlight = await renderWithHighlight(0);
    const withHighlight = await renderWithHighlight(1);
    expect(
      withHighlight,
      `far-halo pixel: highlight_factor=0 -> ${withoutHighlight}, highlight_factor=1 -> ${withHighlight}`
    ).toBeGreaterThan(withoutHighlight + 5);
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
      await session.call('effect', {
        image: opened.image,
        type: 'add_noise',
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

  it('add_noise: independent=False makes the grain monochrome (equal R/G/B deltas), not per-channel speckle', async () => {
    const flatPath = join(workDir, 'noise-mono-flat.png');
    writeCheckerboard(flatPath, 128, 128, 999, 128, 128); // a uniform 128-gray field (square bigger than the image)
    const opened = await session.call<{ image: number }>('open', { path: flatPath });
    try {
      const beforePath = join(workDir, 'noise-mono-before.png');
      await session.call('export', { image: opened.image, path: beforePath });
      const before = readPng(beforePath);
      await session.call('effect', {
        image: opened.image,
        type: 'add_noise',
        noise_amount: 0.5,
        seed: 7,
      });
      const afterPath = join(workDir, 'noise-mono-after.png');
      await session.call('export', { image: opened.image, path: afterPath });
      const after = readPng(afterPath);
      // At EVERY sampled pixel, the R/G/B delta from the flat 128 baseline must be the SAME value
      // on all three channels (monochrome grain) -- GEGL's own default (`independent=True`) would
      // instead draw three separate random deltas per pixel, only coincidentally equal.
      let sawNonZeroDelta = false;
      for (const [x, y] of [
        [10, 10],
        [40, 70],
        [90, 20],
        [60, 100],
        [15, 90],
      ] as const) {
        const [br, bg, bb] = pixelAt(before, x, y);
        const [ar, ag, ab] = pixelAt(after, x, y);
        const dr = ar - br;
        const dg = ag - bg;
        const db = ab - bb;
        expect(dg, `x=${x},y=${y}: green delta`).toBe(dr);
        expect(db, `x=${x},y=${y}: blue delta`).toBe(dr);
        if (dr !== 0) sawNonZeroDelta = true;
      }
      expect(
        sawNonZeroDelta,
        'every sampled pixel had a zero delta -- noise_amount had no effect'
      ).toBe(true);
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
      await session.call('effect', {
        image: opened.image,
        type: 'drop_shadow',
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

  // ---- proxy fidelity for the three spatial effects: measured tolerance, pinned, negative control
  // Mirrors adjust.live.test.ts's own gaussian_blur proxy-fidelity test: each of these fields is in
  // `lib.SPATIAL_SCALE_PROPS`, so a re-edited filter_id's field gets scaled by the proxy factor on
  // the mirrored preview -- this is what actually exercises that code path for each NEW spatial
  // effect rather than trusting the existing gaussian_blur coverage to stand in for all of them.

  /** Shared harness: create `type` with `field` = FIELD (full-res), compare the proxy preview
   * against a full-res reference downscaled the same way, once with the field scaled correctly
   * (the real path) and once "unscaled" (the negative control — what the proxy would render if
   * SPATIAL_SCALE_PROPS silently stopped covering this effect's operation/field). */
  async function proxyFidelity(
    type: string,
    field: string,
    baseArgs: Record<string, unknown>,
    fieldValue: number,
    checkerPath: string,
    width: number,
    height: number,
    scale: number,
    tagPrefix: string
  ): Promise<{ scaled: number; unscaled: number }> {
    async function proxyVsReference(proxyFieldValue: number, tag: string): Promise<number> {
      const opened = await session.call<{ image: number }>('open', { path: checkerPath });
      try {
        await session.call('effect', {
          image: opened.image,
          type,
          ...baseArgs,
          [field]: fieldValue,
        });
        const refPath = join(workDir, `${tag}-ref.png`);
        await session.call('preview', {
          image: opened.image,
          max_px: 512,
          region: { x: 0, y: 0, width, height }, // full-res render, then downscaled
          out_path: refPath,
        });
        const listed = await session.call<{ filters: Array<{ filter_id: number }> }>('filter', {
          image: opened.image,
          op: 'list',
        });
        await session.call('effect', {
          image: opened.image,
          type,
          filter_id: listed.filters[0]!.filter_id,
          [field]: proxyFieldValue,
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

    // The real path: the proxy scales the field by `scale` on its own.
    const scaled = await proxyVsReference(fieldValue, `${tagPrefix}-scaled`);
    // What an unscaled proxy would render: a filter whose field, once scaled, lands on
    // fieldValue proxy units, i.e. fieldValue / scale at full resolution.
    const unscaled = await proxyVsReference(fieldValue / scale, `${tagPrefix}-unscaled`);
    return { scaled, unscaled };
  }

  it('motion_blur proxy fidelity: length is scaled onto the proxy (negative control: an unscaled length is far off)', async () => {
    const WIDTH = 2048;
    const HEIGHT = 512;
    const SCALE = 512 / WIDTH;
    const checkerPath = join(workDir, 'motion-checker.png');
    writeCheckerboard(checkerPath, WIDTH, HEIGHT, 16, 60, 200);
    const { scaled, unscaled } = await proxyFidelity(
      'motion_blur',
      'length',
      { angle: 0 },
      40,
      checkerPath,
      WIDTH,
      HEIGHT,
      SCALE,
      'motion'
    );
    expect(scaled, `scaled mean abs diff ${scaled}`).toBeLessThan(6);
    expect(unscaled, `unscaled mean abs diff ${unscaled}`).toBeGreaterThan(scaled * 4);
  });

  it('lens_blur proxy fidelity: radius (blur-radius) is scaled onto the proxy (negative control: an unscaled radius is far off)', async () => {
    const WIDTH = 2048;
    const HEIGHT = 512;
    const SCALE = 512 / WIDTH;
    const checkerPath = join(workDir, 'lens-checker.png');
    writeCheckerboard(checkerPath, WIDTH, HEIGHT, 16, 60, 200);
    const { scaled, unscaled } = await proxyFidelity(
      'lens_blur',
      'radius',
      {},
      20, // kept well under the 150 cap even divided by SCALE (unscaled = 20 / 0.25 = 80)
      checkerPath,
      WIDTH,
      HEIGHT,
      SCALE,
      'lens'
    );
    expect(scaled, `scaled mean abs diff ${scaled}`).toBeLessThan(6);
    expect(unscaled, `unscaled mean abs diff ${unscaled}`).toBeGreaterThan(scaled * 4);
  });

  it('drop_shadow proxy fidelity: radius is scaled onto the proxy (negative control: an unscaled radius is far off)', async () => {
    // Unlike motion_blur/lens_blur (which blur EXISTING content regardless of alpha), a drop
    // shadow renders only from an alpha edge -- a fully opaque checkerboard (this file's other
    // proxy-fidelity fixtures) gives it nothing to cast, so both the "scaled" and "unscaled"
    // renders come back byte-identical (0 diff) for the wrong reason: not because the scaling is
    // correct, but because the filter has no visible effect on this fixture at all. A real alpha
    // edge (writeRgbaSquare) plus a real offset is what actually exercises the scaling.
    const WIDTH = 2048;
    const HEIGHT = 2048;
    const SCALE = 512 / WIDTH;
    const shapePath = join(workDir, 'shadow-proxy-shape.png');
    writeRgbaSquare(shapePath, WIDTH, HEIGHT, 624, 624, 800, [128, 128, 128]);
    const { scaled, unscaled } = await proxyFidelity(
      'drop_shadow',
      'radius',
      { offset_x: 60, offset_y: 60, opacity: 1.0 },
      40,
      shapePath,
      WIDTH,
      HEIGHT,
      SCALE,
      'shadow'
    );
    expect(scaled, `scaled mean abs diff ${scaled}`).toBeLessThan(6);
    expect(unscaled, `unscaled mean abs diff ${unscaled}`).toBeGreaterThan(scaled * 4);
  });

  it('drop_shadow proxy fidelity: offset_x is scaled onto the proxy in isolation (negative control: an unscaled offset is far off)', async () => {
    // The radius test above already proves SPATIAL_SCALE_PROPS covers `radius`; this proves it
    // covers the OFFSET fields (`x`/`y`, the GEGL properties `offset_x`/`offset_y` map to)
    // separately, since a proxy render scaling one and not the other would still pass that test.
    const WIDTH = 2048;
    const HEIGHT = 2048;
    const SCALE = 512 / WIDTH;
    const shapePath = join(workDir, 'shadow-offsetx-shape.png');
    writeRgbaSquare(shapePath, WIDTH, HEIGHT, 624, 624, 800, [128, 128, 128]);
    const { scaled, unscaled } = await proxyFidelity(
      'drop_shadow',
      'offset_x',
      { offset_y: 60, radius: 20, opacity: 1.0 },
      80, // kept well under the 500 cap even divided by SCALE (unscaled = 80 / 0.25 = 320)
      shapePath,
      WIDTH,
      HEIGHT,
      SCALE,
      'shadow-offsetx'
    );
    expect(scaled, `scaled mean abs diff ${scaled}`).toBeLessThan(6);
    expect(unscaled, `unscaled mean abs diff ${unscaled}`).toBeGreaterThan(scaled * 4);
  });

  // ---- append-guard: GIMP silently refusing to attach a filter must surface as a real error -----
  // gegl:lens-blur is the measured example (an 'aux'-pad op GIMP refuses to attach non-
  // destructively -- see lib.build_lens_blur_params' own comment) -- driven here through the REAL
  // `_apply_filter` (via the test-only `test_apply_raw_effect`, not `op_effect`'s allow-list, so
  // this works regardless of which effects are allow-listed) to prove `_append_masked`'s guard
  // fires from the production create path: an actionable `gimp_op_failed`, not a phantom filter_id
  // with nothing actually attached.

  it("_append_masked surfaces GIMP's silent attach refusal as gimp_op_failed, naming the operation, with no phantom filter left behind", async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      let error: unknown;
      try {
        await session.call('test_apply_raw_effect', {
          image: opened.image,
          operation: 'gegl:lens-blur',
          props: { radius: 10.0 },
        });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'gimp_op_failed' });
      // The operation name is captured BEFORE f.delete() runs (see _append_masked's own comment)
      // -- this proves that capture actually reaches the error message, not just that SOME
      // message comes back.
      expect((error as Error).message).toContain('gegl:lens-blur');
      // Both directions: the live filter stack is empty (nothing actually attached)...
      const listed = await session.call<{ filters: unknown[] }>('filter', {
        image: opened.image,
        op: 'list',
      });
      expect(listed.filters).toHaveLength(0);
      // ...AND the ledger itself has no record either, checked DIRECTLY (not by re-deriving it
      // from op=list, which would only prove the SAME thing twice) -- a phantom ledger record
      // with no live filter behind it is exactly the "list still says 0 filters, but the next
      // rotate/flip/resize refuses forever over a filter that isn't there" bug class
      // `_prune_stale_ledger_records` exists for; this proves the record was never written in
      // the first place, not merely pruned away by a later op.
      const dumped = await session.call<{ names: string[] }>('test_ledger_dump', {
        image: opened.image,
      });
      expect(dumped.names).toHaveLength(0);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- _mirror_filters' own catch-and-skip path (the OTHER caller of _append_masked's guard) ----
  // No real GEGL operation in this allow-list attaches on a full document yet refuses on its
  // (same-sized-class) preview proxy specifically -- gegl:lens-blur above refuses identically
  // everywhere, so it can never be live at all, on either image. `test_mirror_unattachable`
  // (fixtures/test_ops.py) exercises the actual code path directly instead: it sabotages
  // `_append_masked` for one NAMED filter only, then calls the real, unmodified `_proxy_render`.

  it('_mirror_filters skips (and reports) a filter it cannot re-attach on the proxy, rather than failing the whole render', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      const created = await session.call<{ filter_id: number; name: string }>('effect', {
        image: opened.image,
        type: 'vignette',
        radius: 0.6,
      });
      const result = await session.call<{ unmirrored_filters: string[] }>(
        'test_mirror_unattachable',
        { image: opened.image, filter_name: created.name }
      );
      expect(result.unmirrored_filters).toEqual([created.name]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('_mirror_filters skips an invisible filter entirely, without even attempting to re-attach it', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      const created = await session.call<{ filter_id: number; name: string }>('effect', {
        image: opened.image,
        type: 'vignette',
        radius: 0.6,
      });
      await session.call('filter', {
        image: opened.image,
        op: 'set_visibility',
        filter_id: created.filter_id,
        visible: false,
      });
      // Sabotaged by the SAME name -- if _mirror_filters attempted to re-attach it despite being
      // invisible, it would show up in unmirrored_filters (the sabotage always fails that name).
      // It must not even try.
      const result = await session.call<{ unmirrored_filters: string[] }>(
        'test_mirror_unattachable',
        { image: opened.image, filter_name: created.name }
      );
      expect(result.unmirrored_filters).toEqual([]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- op_effect's own re-edit/mask/type contracts, through the real bridge -----------------

  it('re-editing a filter with the wrong type is refused, naming both types', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      const created = await session.call<{ filter_id: number }>('effect', {
        image: opened.image,
        type: 'vignette',
        radius: 0.6,
      });
      let error: unknown;
      try {
        await session.call('effect', {
          image: opened.image,
          type: 'motion_blur',
          filter_id: created.filter_id,
          length: 10,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'invalid_argument' });
      const message = (error as Error).message;
      expect(message).toContain('vignette');
      expect(message).toContain('motion_blur');
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('a re-edit cannot add or change a mask -- it is fixed at creation', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      const created = await session.call<{ filter_id: number }>('effect', {
        image: opened.image,
        type: 'vignette',
        radius: 0.6,
      });
      await expect(
        session.call('effect', {
          image: opened.image,
          type: 'vignette',
          filter_id: created.filter_id,
          mask: 'DoesNotExist',
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('a partial re-edit keeps every field it did not mention (the merge contract), visible via list', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      const created = await session.call<{ filter_id: number }>('effect', {
        image: opened.image,
        type: 'vignette',
        radius: 1.2,
        softness: 0.6,
        gamma: 1.5,
        center_x: 0.3,
        center_y: 0.7,
      });
      await session.call('effect', {
        image: opened.image,
        type: 'vignette',
        filter_id: created.filter_id,
        radius: 0.4, // only this field mentioned
      });
      const listed = await session.call<{
        filters: Array<{ filter_id: number; params: Record<string, unknown> }>;
      }>('filter', { image: opened.image, op: 'list' });
      const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(rec.params).toEqual({
        radius: 0.4,
        softness: 0.6,
        gamma: 1.5,
        center_x: 0.3,
        center_y: 0.7,
      });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('a masked effect confines its change to exactly the mask (0px changed outside it)', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      const beforePath = join(workDir, 'effect-mask-before.png');
      await session.call('export', { image: opened.image, path: beforePath });
      const before = readPng(beforePath);
      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: SWATCH_SIZE,
        height: SWATCH_SIZE,
        name: 'FirstSwatchOnly',
      });
      await session.call('effect', {
        image: opened.image,
        type: 'black_white',
        red_weight: 1,
        green_weight: 1,
        blue_weight: 1,
        mask: 'FirstSwatchOnly',
      });
      const afterPath = join(workDir, 'effect-mask-after.png');
      await session.call('export', { image: opened.image, path: afterPath });
      const after = readPng(afterPath);
      let changedOutside = 0;
      for (let y = 0; y < after.height; y++) {
        for (let x = SWATCH_SIZE; x < after.width; x++) {
          const a = pixelAt(after, x, y);
          const b = pixelAt(before, x, y);
          if (a.some((c, i) => c !== b[i])) changedOutside++;
        }
      }
      expect(changedOutside, 'pixels outside the mask that changed').toBe(0);
      // Sanity: the mask itself DID do something (a real gray, R=G=B) inside its own rectangle --
      // otherwise "0 changed outside" would trivially pass for a filter that changed nothing at all.
      const [r, g, b] = pixelAt(after, 4, 4);
      expect(r).toBe(g);
      expect(g).toBe(b);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('re-editing a foreign (GUI-added, unledgered) gegl:vignette filter is refused, not silently accepted', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      const foreign = await session.call<{ filter_id: number }>('test_add_foreign_filter', {
        image: opened.image,
        operation: 'gegl:vignette',
        props: { radius: 1.0 },
      });
      await expect(
        session.call('effect', {
          image: opened.image,
          type: 'vignette',
          filter_id: foreign.filter_id,
          radius: 0.5,
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('an unknown effect type is refused at the bridge', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      await expect(
        session.call('effect', { image: opened.image, type: 'not_a_real_effect' })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('black_white preserve_luminosity rescales output to match the original brightness even with a non-unit weight sum', async () => {
    const flatPath = join(workDir, 'bw-luminosity-flat.png');
    writeCheckerboard(flatPath, 64, 64, 999, 128, 128); // a uniform 128-gray field
    async function renderWith(preserve: boolean): Promise<number> {
      const opened = await session.call<{ image: number }>('open', { path: flatPath });
      try {
        await session.call('effect', {
          image: opened.image,
          type: 'black_white',
          red_weight: 0.1,
          green_weight: 0.1,
          blue_weight: 0.1, // sums to 0.3, far from the 1.0 preserve_luminosity has to compensate for
          preserve_luminosity: preserve,
        });
        const outPath = join(workDir, `bw-luminosity-${preserve}.png`);
        await session.call('export', { image: opened.image, path: outPath });
        return pixelAt(readPng(outPath), 32, 32)[0];
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
    const withPreserve = await renderWith(true);
    const withoutPreserve = await renderWith(false);
    // preserve_luminosity=True rescales the result back toward the original 128; False leaves it
    // darkened by the (0.3x) weighted sum -- verified live, see build_black_white_params' comment.
    expect(
      Math.abs(withPreserve - 128),
      `with preserve -> ${withPreserve}, without -> ${withoutPreserve}`
    ).toBeLessThan(Math.abs(withoutPreserve - 128));
  });

  it('black_white with all-zero weights renders black either way, with no divide-by-zero crash', async () => {
    // GEGL's mono-mixer with weights summing to exactly 0 does NOT crash or produce NaN --
    // verified live (see build_black_white_params' own comment) -- so this bridge adds no extra
    // guard for it. This pins that finding against a real render rather than trusting the comment
    // alone to stay true across a future GIMP/GEGL upgrade.
    for (const preserve of [true, false]) {
      const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
      try {
        await session.call('effect', {
          image: opened.image,
          type: 'black_white',
          red_weight: 0,
          green_weight: 0,
          blue_weight: 0,
          preserve_luminosity: preserve,
        });
        const outPath = join(workDir, `bw-zero-sum-${preserve}.png`);
        await session.call('export', { image: opened.image, path: outPath });
        const [r, g, b] = pixelAt(readPng(outPath), 8, 8);
        expect(r, `preserve_luminosity=${preserve}`).toBeLessThanOrEqual(2);
        expect(g, `preserve_luminosity=${preserve}`).toBeLessThanOrEqual(2);
        expect(b, `preserve_luminosity=${preserve}`).toBeLessThanOrEqual(2);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
  });

  it('add_noise: changing seed changes the render (not just re-rolling the same pattern deterministically)', async () => {
    const flatPath = join(workDir, 'noise-seed-flat.png');
    writeCheckerboard(flatPath, 64, 64, 999, 128, 128);
    async function renderWithSeed(seed: number) {
      const opened = await session.call<{ image: number }>('open', { path: flatPath });
      try {
        await session.call('effect', {
          image: opened.image,
          type: 'add_noise',
          noise_amount: 0.5,
          seed,
        });
        const outPath = join(workDir, `noise-seed-${seed}.png`);
        await session.call('export', { image: opened.image, path: outPath });
        return readPng(outPath);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
    const a = await renderWithSeed(1);
    const b = await renderWithSeed(2);
    expect(maxAbsDiff(a, b)).toBeGreaterThan(0);
  });
});
