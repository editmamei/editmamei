/**
 * Preview/histogram/compare against real headless GIMP: region variants, the proxy/exact split,
 * and proxy fidelity for a spatial filter (the one place the preview proxy is only an
 * approximation -- see `_mirror_filters` in `ops.py`).
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
  writeGrayRamp,
  writeCheckerboard,
  writeNoisyField,
  writeIndexedPng,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

describe.skipIf(!install)('verify ops: preview / histogram / compare', () => {
  // Bigger than the adjust-test ramp: region-histogram's proxy-vs-full-res branch needs a region
  // that maps to >= 64 proxy px on a side at the 1024px default proxy size, which only matters
  // once the source image is smaller than 1024px itself (scale=1) or big enough that a modest
  // region still clears 64 proxy px after scaling down.
  const WIDTH = 800;
  const HEIGHT = 200;
  let workDir: string;
  let session: GimpSession;
  let rampPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-verify-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    rampPath = join(workDir, 'ramp.png');
    writeGrayRamp(rampPath, WIDTH, HEIGHT);
  });

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('precision promotion (16-bit): preview, histogram, and export all still work', async () => {
    const opened = await session.call<{ image: number; precision: string }>('open', {
      path: rampPath,
      precision: '16',
    });
    try {
      expect(opened.precision).toBe('u16-non-linear');
      const preview = await session.call<{ width: number }>('preview', {
        image: opened.image,
        max_px: 512,
        out_path: join(workDir, 'p16.png'),
      });
      expect(preview.width).toBeGreaterThan(0);
      const hist = await session.call<{ channels: { luminance: { mean: number } } }>('histogram', {
        image: opened.image,
      });
      expect(hist.channels.luminance.mean).toBeGreaterThan(0);
      const exported = await session.call<{ bytes: number }>('export', {
        image: opened.image,
        path: join(workDir, 'p16.jpg'),
      });
      expect(exported.bytes).toBeGreaterThan(0);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('precision promotion (32-bit float): open reports the promoted precision', async () => {
    const opened = await session.call<{ image: number; precision: string }>('open', {
      path: rampPath,
      precision: '32',
    });
    try {
      expect(opened.precision).toBe('float-non-linear');
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('open rejects a precision promotion that GIMP itself refuses (indexed source), rather than silently reporting success at the original precision', async () => {
    // `Image.convert_precision` returns plain `False` on this failure instead of raising --
    // verified live -- so `open` explicitly checks the return value and raises `gimp_op_failed`;
    // this is also the practical trigger for `op_open`'s free-the-image-on-any-post-load-failure
    // guard (precision conversion, ledger pruning, and building the default proxy all share one
    // try/except now, not just precision conversion on its own).
    const indexedPath = join(workDir, 'indexed.png');
    writeIndexedPng(indexedPath, 4, 4);
    await expect(
      session.call('open', { path: indexedPath, precision: '16' })
    ).rejects.toMatchObject({ code: 'gimp_op_failed' });
    // The same file opens fine without a precision request -- confirms the fixture itself is
    // valid and loadable, so the rejection above is specifically about the precision request.
    const opened = await session.call<{ image: number; base_type: string }>('open', {
      path: indexedPath,
    });
    expect(opened.base_type).toBe('indexed');
    await session.call('close', { image: opened.image });
  });

  it('preview (whole image) is the proxy path and reports proxy: true', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const result = await session.call<{ proxy: boolean; width: number; height: number }>(
        'preview',
        {
          image: opened.image,
          max_px: 512,
          out_path: join(workDir, 'whole.png'),
        }
      );
      expect(result.proxy).toBe(true);
      expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(512);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('preview (region) is the exact full-res path and reports proxy: false', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const result = await session.call<{ proxy: boolean; width: number; height: number }>(
        'preview',
        {
          image: opened.image,
          max_px: 512,
          region: { x: 10, y: 10, width: 100, height: 100 },
          out_path: join(workDir, 'region.png'),
        }
      );
      expect(result.proxy).toBe(false);
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('histogram (exact) matches an independent per-pixel mean from a full-res PNG export', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const hist = await session.call<{ channels: { luminance: { mean: number } } }>('histogram', {
        image: opened.image,
        exact: true,
      });
      const ppmPath = join(workDir, 'exact-ref.png');
      await session.call('export', { image: opened.image, path: ppmPath });
      const ppm = readPng(ppmPath);
      let sum = 0;
      for (let x = 0; x < ppm.width; x++) sum += pixelAt(ppm, x, 100)[0]!;
      const independentMean = sum / ppm.width;
      // luminance uses babl's Y' (perceptual luma) weighting, not a flat R=G=B average, but on
      // this grayscale ramp (R=G=B everywhere) the two coincide.
      expect(Math.abs(hist.channels.luminance.mean - independentMean)).toBeLessThan(1);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('histogram region: a small region on a large image falls back to the full-res crop (exact: false in the request)', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      // 20x20 doc px at the default 1024 proxy maps to well under 64 proxy px on this 800-wide
      // image (scale = 1024/800, still under 64px for a 20px region), so this must fall back to
      // the full-res crop and report exact: true regardless of the request's exact: false.
      const result = await session.call<{ exact: boolean; width: number; height: number }>(
        'histogram',
        {
          image: opened.image,
          region: { x: 5, y: 5, width: 20, height: 20 },
          exact: false,
        }
      );
      expect(result.exact).toBe(true);
      expect(result.width).toBe(20);
      expect(result.height).toBe(20);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('histogram region: a large region uses the (approximate) proxy path when it clears the size floor', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const result = await session.call<{ exact: boolean }>('histogram', {
        image: opened.image,
        region: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, // the whole image as a "region"
        exact: false,
      });
      expect(result.exact).toBe(false);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('compare before_after reports a positive luminance delta for a brightening filter', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('adjust', { image: opened.image, type: 'exposure', exposure: 1.0 });
      const result = await session.call<{
        delta: { luminance: { mean: number } };
        proxy: boolean;
      }>('compare', { image: opened.image, mode: 'before_after' });
      expect(result.proxy).toBe(true);
      expect(result.delta.luminance.mean).toBeGreaterThan(0);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('compare regions reports independent stats for two disjoint rectangles', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const result = await session.call<{
        region_a: { luminance: { mean: number } };
        region_b: { luminance: { mean: number } };
      }>('compare', {
        image: opened.image,
        mode: 'regions',
        region_a: { x: 0, y: 0, width: 50, height: 50 },
        region_b: { x: WIDTH - 50, y: 0, width: 50, height: 50 },
      });
      // Column x near 0 is near-black on this ramp; column x near WIDTH is near-white.
      expect(result.region_a.luminance.mean).toBeLessThan(result.region_b.luminance.mean);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- out-of-bounds regions are rejected, live, by every op that takes one -------------------
  // `lib.validate_region` itself is unit-tested (see TestValidateRegion in test_lib.py); these
  // confirm each op actually WIRES that validation in, against the real bridge, rather than only
  // trusting the pure function is called somewhere.

  const OUT_OF_BOUNDS_REGION = { x: 0, y: 0, width: WIDTH + 100, height: HEIGHT };

  it('preview rejects an out-of-bounds region', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('preview', {
          image: opened.image,
          region: OUT_OF_BOUNDS_REGION,
          out_path: join(workDir, 'oob-preview.png'),
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('histogram rejects an out-of-bounds region', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('histogram', { image: opened.image, region: OUT_OF_BOUNDS_REGION })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('compare before_after rejects an out-of-bounds region', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('compare', {
          image: opened.image,
          mode: 'before_after',
          region: OUT_OF_BOUNDS_REGION,
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('compare regions rejects an out-of-bounds region_a or region_b', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('compare', {
          image: opened.image,
          mode: 'regions',
          region_a: OUT_OF_BOUNDS_REGION,
          region_b: { x: 0, y: 0, width: 50, height: 50 },
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      await expect(
        session.call('compare', {
          image: opened.image,
          mode: 'regions',
          region_a: { x: 0, y: 0, width: 50, height: 50 },
          region_b: OUT_OF_BOUNDS_REGION,
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- proxy fidelity for a spatial filter: measured tolerance, pinned -----------------------

  it('proxy fidelity: sharpen (unsharp-mask) on the 1024px proxy is within a measured tolerance of the full-res render, downscaled the same way', async () => {
    // A checkerboard, not a smooth ramp or a single hard edge: blurring a step edge and then
    // downscaling by a scale-compensated radius turns out to be near scale-invariant for a
    // CONTINUOUS edge (a Gaussian blur is scale-equivariant, and both fixtures measured a 0
    // difference here) -- a checkerboard's high-frequency detail is where downsampling first
    // (the proxy path) genuinely stops commuting with blurring first (the full-res path), which
    // is what gives this test a real, non-vacuous number to pin.
    const checkerPath = join(workDir, 'checker.png');
    writeCheckerboard(checkerPath, WIDTH, HEIGHT, 6);
    const opened = await session.call<{ image: number }>('open', { path: checkerPath });
    try {
      await session.call('adjust', {
        image: opened.image,
        type: 'sharpen',
        radius: 10, // std-dev, in FULL-RES px
        amount: 3.0,
        threshold: 0,
      });

      // The proxy path: op_preview's default (whole-image) route, which mirrors the filter onto
      // the cached downscaled base and scales `radius` by the proxy's own scale factor.
      // `out_path`'s extension drives the export format; .png exports losslessly so the compare
      // below is against real, independently-decoded bytes, not JPEG artifacts.
      const proxyPpmPath = join(workDir, 'sh-proxy.png');
      await session.call('preview', { image: opened.image, max_px: 512, out_path: proxyPpmPath });

      // The reference: a full-res render (a region covering the whole image, which goes through
      // the exact `_region_full_res` path -- filter applied natively, then scaled down the same
      // way `preview` would), the same "exact vs proxy" split `op_preview` itself makes.
      const refPpmPath = join(workDir, 'sh-ref.png');
      await session.call('preview', {
        image: opened.image,
        max_px: 512,
        region: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        out_path: refPpmPath,
      });
      const proxyPpm = readPng(proxyPpmPath);
      const refPpm = readPng(refPpmPath);
      expect(proxyPpm.width).toBe(refPpm.width);
      expect(proxyPpm.height).toBe(refPpm.height);

      let sumAbsDiff = 0;
      let maxDiff = 0;
      const n = proxyPpm.data.length;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(proxyPpm.data[i]! - refPpm.data[i]!);
        sumAbsDiff += d;
        if (d > maxDiff) maxDiff = d;
      }
      const meanAbsDiff = sumAbsDiff / n;
      // Measured live (this fixture/filter/proxy size): mean abs diff ~22.7, max diff ~163 --
      // a deliberately adversarial fine-detail case (a 6px checkerboard aliases hard once
      // downsampled before blurring), not a typical photo's error. Pinned with headroom above
      // the observed values so the test catches a real regression (e.g. the radius-scaling
      // allow-list silently dropped, which would make BOTH numbers far larger) without flaking
      // on ordinary GIMP-version noise.
      expect(meanAbsDiff, `mean abs diff ${meanAbsDiff}`).toBeLessThan(35);
      expect(maxDiff, `max diff ${maxDiff}`).toBeLessThan(200);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it("spatial scaling clamps to the property's own pspec minimum instead of leaving the unscaled value in place", async () => {
    // A genuinely 2D fixture (4096x4096, not a thin strip) so downscaling to the 512px proxy
    // still leaves real, non-degenerate detail to tell two renders apart -- a thin 8000x64 strip
    // scaled the same way collapses to a handful of rows and can pass this comparison for the
    // wrong reason (there's barely any structure left to differ on either side).
    //
    // MIDTONE values (60/200), not pure black/white: measured live that a pure 0/255 checkerboard
    // makes shadows_highlights's `radius` invisible at ANY value here (0.1 vs 5.0 vs 1000 all
    // rendered byte-identical, full-res) -- every pixel is already at a tonal extreme, so the
    // shadow/highlight remapping clips to the same result regardless of the local average `radius`
    // computes. A midtone checkerboard gives the local average somewhere real to move.
    //
    // At this fixture's proxy scale factor (512/4096 = 0.125), a shadows_highlights `radius` below
    // 0.8 lands under the property's own pspec minimum (0.1, verified live) once scaled --
    // GObject silently REJECTS a set_property below a property's minimum and leaves whatever
    // value was already there (the unscaled one, copied over just before scaling), so without an
    // explicit clamp the effective radius would be the raw, unscaled value instead.
    //
    // Two configs (radius 0.75 and 0.1) both scale below 0.1 here (0.09375 and 0.0125), so a
    // CORRECT clamp forces both to the SAME floor (0.1) and their proxy renders must be
    // pixel-identical; an unclamped bug would instead leave each at its own (different) unscaled
    // value. Two positive controls make that comparison mean something (rather than passing
    // vacuously because nothing here is visibly different at any radius):
    //   (a) the filter must visibly change the proxy render vs. no filter at all;
    //   (b) radius 0.75 vs 0.1, applied UNSCALED at full resolution (what an unclamped bug would
    //       effectively do -- GObject keeps the pre-scale value), must render measurably
    //       differently from each other -- otherwise an identical proxy result wouldn't prove the
    //       clamp did anything.
    // Measured live: (a) maxDiff 8, (b) maxDiff 9, main comparison maxDiff 0. Thresholds below are
    // set with headroom under the measured values, not AT them.
    const SIDE = 4096;
    const checkerPath = join(workDir, 'clamp-checker.png');
    writeCheckerboard(checkerPath, SIDE, SIDE, 6, 60, 200);

    async function proxyWithRadius(radius: number): Promise<ReturnType<typeof readPng>> {
      const opened = await session.call<{ image: number }>('open', { path: checkerPath });
      try {
        await session.call('adjust', {
          image: opened.image,
          type: 'shadows_highlights',
          shadows: 40,
          highlights: -40,
          radius,
        });
        const outPath = join(workDir, `clamp-proxy-r${radius}.png`);
        await session.call('preview', { image: opened.image, max_px: 512, out_path: outPath });
        return readPng(outPath);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }

    async function fullResWithRadius(radius: number): Promise<ReturnType<typeof readPng>> {
      const opened = await session.call<{ image: number }>('open', { path: checkerPath });
      try {
        await session.call('adjust', {
          image: opened.image,
          type: 'shadows_highlights',
          shadows: 40,
          highlights: -40,
          radius,
        });
        const outPath = join(workDir, `clamp-full-r${radius}.png`);
        await session.call('export', { image: opened.image, path: outPath });
        return readPng(outPath);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }

    function maxAbsDiffPng(a: ReturnType<typeof readPng>, b: ReturnType<typeof readPng>): number {
      let m = 0;
      for (let i = 0; i < a.data.length; i++) {
        const d = Math.abs(a.data[i]! - b.data[i]!);
        if (d > m) m = d;
      }
      return m;
    }

    const unfilteredOpened = await session.call<{ image: number }>('open', { path: checkerPath });
    const unfilteredPath = join(workDir, 'clamp-proxy-unfiltered.png');
    await session.call('preview', {
      image: unfilteredOpened.image,
      max_px: 512,
      out_path: unfilteredPath,
    });
    await session.call('close', { image: unfilteredOpened.image });
    const unfiltered = readPng(unfilteredPath);

    const proxyAt075 = await proxyWithRadius(0.75);
    const proxyAt01 = await proxyWithRadius(0.1);

    // (a) positive control: the filter has a real, visible effect on the proxy render.
    expect(
      maxAbsDiffPng(proxyAt075, unfiltered),
      'a clamped-but-real radius must still visibly change the proxy vs. no filter at all'
    ).toBeGreaterThan(3);

    // (b) positive control: the two raw radii, UNSCALED, are visibly different from each other
    // at full resolution -- so an unclamped bug (which would apply each one unscaled) really
    // would render differently, and the proxy result below proves something.
    const fullAt075 = await fullResWithRadius(0.75);
    const fullAt01 = await fullResWithRadius(0.1);
    expect(
      maxAbsDiffPng(fullAt075, fullAt01),
      'radius 0.75 vs 0.1 must be a real, visible difference at full resolution'
    ).toBeGreaterThan(3);

    // The actual clamp assertion: both correctly clamp to the SAME floor (0.1), so the proxy
    // renders must be identical.
    expect(proxyAt075.width).toBe(proxyAt01.width);
    expect(
      maxAbsDiffPng(proxyAt075, proxyAt01),
      'both should clamp to the same floor and render identically'
    ).toBe(0);
  });

  it('noise_reduction iterations are scaled by the proxy factor, not left at the unscaled count', async () => {
    // Same 2048x2048-class-fixture reasoning as the clamp test above: a genuinely 2D noisy field
    // with millions of independent pixels, not a thin strip, so a real difference in iteration
    // count stays statistically detectable after downscaling.
    //
    // Two `strength` values (2 and 5) that both round to the SAME iteration count (1) once scaled
    // down by this fixture's proxy factor (512/2048 = 0.25: 2*0.25=0.5 rounds to 0, floored to the
    // minimum of 1; 5*0.25=1.25 rounds to 1): if `iterations` is genuinely scaled (rounded,
    // floored at 1), both renders converge to the same effective iteration count and must be
    // pixel-identical; if left unscaled, 2 vs 5 real GEGL iterations measurably differ on a noisy
    // image. Two positive controls, same reasoning as the clamp test above:
    //   (a) the filter must visibly change the proxy render vs. no filter at all;
    //   (b) strength 2 vs 5, applied UNSCALED at full resolution (what an unclamped bug would
    //       effectively do), must render measurably differently from each other.
    // Measured live: (a) maxDiff 44, (b) maxDiff 51, main comparison maxDiff 0. Thresholds below
    // are set with headroom under the measured values, not AT them.
    const SIDE = 2048;
    const noisyPath = join(workDir, 'nr-scale-noisy.png');
    writeNoisyField(noisyPath, SIDE, SIDE, 60);

    async function proxyWithStrength(strength: number): Promise<ReturnType<typeof readPng>> {
      const opened = await session.call<{ image: number }>('open', { path: noisyPath });
      try {
        await session.call('adjust', { image: opened.image, type: 'noise_reduction', strength });
        const outPath = join(workDir, `nr-scale-proxy-${strength}.png`);
        await session.call('preview', { image: opened.image, max_px: 512, out_path: outPath });
        return readPng(outPath);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }

    async function fullResWithStrength(strength: number): Promise<ReturnType<typeof readPng>> {
      const opened = await session.call<{ image: number }>('open', { path: noisyPath });
      try {
        await session.call('adjust', { image: opened.image, type: 'noise_reduction', strength });
        const outPath = join(workDir, `nr-scale-full-${strength}.png`);
        await session.call('export', { image: opened.image, path: outPath });
        return readPng(outPath);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }

    function maxAbsDiffPng(a: ReturnType<typeof readPng>, b: ReturnType<typeof readPng>): number {
      let m = 0;
      for (let i = 0; i < a.data.length; i++) {
        const d = Math.abs(a.data[i]! - b.data[i]!);
        if (d > m) m = d;
      }
      return m;
    }

    const unfilteredOpened = await session.call<{ image: number }>('open', { path: noisyPath });
    const unfilteredPath = join(workDir, 'nr-scale-proxy-unfiltered.png');
    await session.call('preview', {
      image: unfilteredOpened.image,
      max_px: 512,
      out_path: unfilteredPath,
    });
    await session.call('close', { image: unfilteredOpened.image });
    const unfiltered = readPng(unfilteredPath);

    const proxyAt2 = await proxyWithStrength(2);
    const proxyAt5 = await proxyWithStrength(5);

    // (a) positive control: the filter has a real, visible effect on the proxy render.
    expect(
      maxAbsDiffPng(proxyAt2, unfiltered),
      'noise reduction at the scaled iteration count must still visibly change the proxy'
    ).toBeGreaterThan(10);

    // (b) positive control: the two raw strengths, UNSCALED, are visibly different from each
    // other at full resolution.
    const fullAt2 = await fullResWithStrength(2);
    const fullAt5 = await fullResWithStrength(5);
    expect(
      maxAbsDiffPng(fullAt2, fullAt5),
      'strength 2 vs 5 must be a real, visible difference at full resolution'
    ).toBeGreaterThan(10);

    // The actual scaling assertion: both correctly round to the SAME iteration count (1), so the
    // proxy renders must be identical.
    expect(proxyAt2.width).toBe(proxyAt5.width);
    expect(
      maxAbsDiffPng(proxyAt2, proxyAt5),
      'both should scale to the same rounded iteration count'
    ).toBe(0);
  });
});
