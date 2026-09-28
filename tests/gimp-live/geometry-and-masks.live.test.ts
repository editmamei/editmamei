/**
 * Geometry ops (crop/resize/rotate/flip) and mask creation, against real headless GIMP.
 *
 * Geometry-vs-live-state: verified live (GIMP 3.2.6) that an UNMASKED filter, named mask
 * channels, and the ledger all survive crop/rotate/flip/resize. A MASKED filter's own baked-in
 * confinement is a different story -- crop keeps it aligned, but rotate/flip/resize cannot (no
 * API exists to re-point an existing filter's mask at a channel's new content), so those three
 * refuse outright when a masked filter is present rather than silently misrendering it. See the
 * "---- geometry ----" comment block above `_classify_geometry_filters` in `ops.py` for the full
 * finding.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  readGrayscalePgm,
  pixelAt,
  writeGrayRamp,
  writeColorSwatches,
  writeCheckerboard,
  writeRgbaSquare,
  SWATCHES,
  SWATCH_SIZE,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
  maxAbsDiff,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

describe.skipIf(!install)('geometry and masks', () => {
  let workDir: string;
  let session: GimpSession;
  let rampPath: string;
  let swatchesPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-geom-'));
    // The test-only bridge (see fixtures/test_ops.py): export_mask reads a mask channel back.
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    rampPath = join(workDir, 'ramp.png');
    swatchesPath = join(workDir, 'swatches.png');
    writeGrayRamp(rampPath, 256, 32);
    writeColorSwatches(swatchesPath);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** A curves filter confined to the left half of the ramp -- used only where a masked filter's
   * behavior itself is under test (crop, and the rotate/flip/resize refusal tests): crop is
   * verified live to keep it pixel-aligned; rotate/flip/resize cannot, so they refuse instead. */
  async function openRampWithMaskedFilter() {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    await session.call('create_mask', {
      image: opened.image,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 128,
      height: 32,
      name: 'HalfMask',
    });
    const filter = await session.call<{ filter_id: number }>('curves', {
      image: opened.image,
      points: [
        [0, 0],
        [255, 200],
      ],
      mask: 'HalfMask',
      name: 'MaskedCurve',
    });
    return { image: opened.image, filterId: filter.filter_id };
  }

  /** An UNMASKED curves filter -- used for resize/rotate/flip's own "the filter survives"
   * checks, since those three ops cannot preserve a MASKED filter's alignment at all (see the
   * file header comment) and refuse outright when one is present instead. */
  async function openRampWithUnmaskedFilter() {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const filter = await session.call<{ filter_id: number }>('curves', {
      image: opened.image,
      points: [
        [0, 0],
        [255, 200],
      ],
      name: 'Curve',
    });
    return { image: opened.image, filterId: filter.filter_id };
  }

  it('crop preserves the live filter, its mask, and the ledger', async () => {
    const { image, filterId } = await openRampWithMaskedFilter();
    try {
      const cropped = await session.call<{ width: number; height: number }>('crop', {
        image,
        left: 10,
        top: 5,
        width: 100,
        height: 20,
      });
      expect(cropped).toEqual({ width: 100, height: 20 });
      const listed = await session.call<{
        filters: Array<{ filter_id: number; source: string; mask: string | null }>;
      }>('filter', { image, op: 'list' });
      expect(listed.filters).toHaveLength(1);
      expect(listed.filters[0]!.filter_id).toBe(filterId);
      expect(listed.filters[0]!.source).toBe('editmamei');
      expect(listed.filters[0]!.mask).toBe('HalfMask');
    } finally {
      await session.call('close', { image });
    }
  });

  it('resize (long_edge) preserves an unmasked live filter and scales the canvas', async () => {
    const { image } = await openRampWithUnmaskedFilter();
    try {
      const resized = await session.call<{ width: number; height: number }>('resize', {
        image,
        long_edge: 64,
      });
      expect(Math.max(resized.width, resized.height)).toBe(64);
      const listed = await session.call<{ filters: unknown[] }>('filter', { image, op: 'list' });
      expect(listed.filters).toHaveLength(1);
    } finally {
      await session.call('close', { image });
    }
  });

  // The refusal below (and rotate/flip's equivalents further down) is driven by
  // `_classify_geometry_filters`, which treats a LIVE filter as `unverifiable` -- refused exactly
  // like `masked`, since whether it's masked can't be checked -- when its ledger record is either
  // ABSENT or names a different operation than the live filter's own. Two scenarios that logic
  // exists for are not constructible through this bridge's own op surface, and are NOT covered by
  // a live test here for that reason (adding a test-only op just to force them is explicitly out
  // of scope): a stale ledger record surviving alongside a live filter of the SAME name (every
  // creation path this bridge exposes re-ledgers fresh, and `_prune_stale_ledger_records` removes
  // a name-mismatched record before this check ever runs), and a filter written to the image while
  // the ledger parasite itself was unwritable (nothing in this bridge's surface can force a
  // parasite write to fail). Both are covered at the pure-logic level instead, exhaustively and
  // deterministically, by `TestClassifyGeometryFilters` and `TestStaleLedgerNames` in
  // `test_lib.py`.
  it('resize refuses when a masked filter is present, rather than silently misaligning it', async () => {
    const { image } = await openRampWithMaskedFilter();
    try {
      await expect(session.call('resize', { image, long_edge: 64 })).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    } finally {
      await session.call('close', { image });
    }
  });

  it('rotate (arbitrary degrees, expand) preserves an unmasked live filter and grows the canvas', async () => {
    const { image } = await openRampWithUnmaskedFilter();
    try {
      const rotated = await session.call<{ width: number; height: number; degrees: number }>(
        'rotate',
        {
          image,
          degrees: 15,
          expand: true,
        }
      );
      expect(rotated.degrees).toBe(15);
      // A wide, short 256x32 rectangle rotated 15 degrees grows mostly in HEIGHT (a 256px-wide
      // side swinging up by sin(15deg) dominates); width barely moves off 256 at this aspect
      // ratio and angle (measured live), so height is the reliable "canvas grew" signal here.
      expect(rotated.height).toBeGreaterThan(32);
      const listed = await session.call<{ filters: unknown[] }>('filter', { image, op: 'list' });
      expect(listed.filters).toHaveLength(1);
    } finally {
      await session.call('close', { image });
    }
  });

  it('rotate refuses when a masked filter is present, rather than silently misaligning it', async () => {
    const { image } = await openRampWithMaskedFilter();
    try {
      await expect(
        session.call('rotate', { image, degrees: 15, expand: true })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image });
    }
  });

  it('rotate without expand keeps the canvas size', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const rotated = await session.call<{ width: number; height: number }>('rotate', {
        image: opened.image,
        degrees: 15,
        expand: false,
      });
      expect(rotated.width).toBe(256);
      expect(rotated.height).toBe(32);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('flip preserves an unmasked live filter, verified by pixel content (not just the ledger)', async () => {
    const { image, filterId } = await openRampWithUnmaskedFilter();
    try {
      const beforePath = join(workDir, 'flip-before.png');
      await session.call('export', { image, path: beforePath });
      const before = readPng(beforePath);

      await session.call('flip', { image, orientation: 'horizontal' });

      const listed = await session.call<{
        filters: Array<{ filter_id: number; source: string; mask: string | null }>;
      }>('filter', { image, op: 'list' });
      expect(listed.filters).toHaveLength(1);
      expect(listed.filters[0]!.filter_id).toBe(filterId);
      expect(listed.filters[0]!.source).toBe('editmamei');

      const afterPath = join(workDir, 'flip-after.png');
      await session.call('export', { image, path: afterPath });
      const after = readPng(afterPath);

      // A flip doesn't change canvas dimensions -- checked BEFORE the per-column pixel checks
      // below, since those hardcode x/y positions that assume this exact size; a silent
      // dimension change could otherwise make them compare the wrong pixels instead of failing.
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);

      // The filter is unmasked, so it applies uniformly regardless of position -- every column
      // must land at its mirrored position with the SAME rendered (filtered) value it had before.
      for (const x of [0, 50, 127, 128, 200, 255]) {
        const [beforeVal] = pixelAt(before, x, 16);
        const [afterVal] = pixelAt(after, 255 - x, 16);
        expect(afterVal, `x=${x} -> mirrored column ${255 - x}`).toBe(beforeVal);
      }
    } finally {
      await session.call('close', { image });
    }
  });

  it('flip refuses when a masked filter is present, rather than silently misaligning it', async () => {
    const { image } = await openRampWithMaskedFilter();
    try {
      await expect(
        session.call('flip', { image, orientation: 'horizontal' })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image });
    }
  });

  it('crop invalidates the preview proxy: a render after crop matches a full-res reference, not stale content', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      // Warm the proxy cache on the pre-crop image.
      await session.call('preview', {
        image: opened.image,
        max_px: 512,
        out_path: join(workDir, 'warm.png'),
      });
      await session.call('crop', { image: opened.image, left: 100, top: 0, width: 50, height: 32 });

      const previewPath = join(workDir, 'after-crop-preview.png');
      const preview = await session.call<{ width: number; height: number }>('preview', {
        image: opened.image,
        max_px: 512,
        out_path: previewPath,
      });
      // A stale proxy (built at the OLD 256x32 size) would report the old dimensions; the
      // rebuilt one must reflect the cropped 50x32 canvas.
      expect(preview.width).toBe(50);
      expect(preview.height).toBe(32);

      const exactPath = join(workDir, 'after-crop-exact.png');
      await session.call('export', { image: opened.image, path: exactPath });
      const exact = readPng(exactPath);
      expect(exact.width).toBe(50);
      expect(exact.height).toBe(32);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- the preview proxy is rebuilt after every geometry change -----------------------------
  // Previews render from a cached, filter-free downscale of the document (ops.py's PROXIES). Any
  // op that changes the canvas must drop it, or the next preview shows the OLD geometry. Each
  // case below warms the proxy, makes one change, then compares the preview pixel for pixel
  // against a full-resolution export: the swatches fixture is under max_px, so the proxy is
  // full-size and a correct preview matches the export exactly.

  /** Open the swatches with an unmasked filter on, and warm the proxy cache. */
  async function openSwatchesWithWarmProxy() {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    await session.call('adjust', { image: opened.image, type: 'saturation', scale: 0.5 });
    await session.call('preview', {
      image: opened.image,
      max_px: 512,
      out_path: join(workDir, `warm-${opened.image}.png`),
    });
    return opened.image;
  }

  /** Preview vs full-resolution export, both PNG. Returns the max per-channel difference. */
  async function previewVsExport(image: number, tag: string): Promise<number> {
    const previewPath = join(workDir, `${tag}-preview.png`);
    await session.call('preview', { image, max_px: 512, out_path: previewPath });
    const exportPath = join(workDir, `${tag}-export.png`);
    await session.call('export', { image, path: exportPath });
    return maxAbsDiff(readPng(previewPath), readPng(exportPath));
  }

  const PROXY_CHANGES: Array<[string, (image: number) => Promise<unknown>]> = [
    [
      'flip (same dimensions)',
      (image) => session.call('flip', { image, orientation: 'horizontal' }),
    ],
    [
      'rotate without expand',
      (image) => session.call('rotate', { image, degrees: 90, expand: false }),
    ],
    ['resize', (image) => session.call('resize', { image, width: 48 })],
    [
      'create_mask + a masked filter',
      async (image) => {
        await session.call('create_mask', {
          image,
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 32,
          height: 16,
          name: 'ProxyMask',
        });
        await session.call('adjust', {
          image,
          type: 'brightness_contrast',
          brightness: 60,
          mask: 'ProxyMask',
        });
      },
    ],
  ];

  it.each(PROXY_CHANGES)(
    'after %s, the preview matches a full-resolution export (the proxy was rebuilt)',
    async (label, change) => {
      const image = await openSwatchesWithWarmProxy();
      const tag = label.replace(/\W+/g, '-');
      try {
        // Positive control: before the change, preview and export already agree.
        expect(await previewVsExport(image, `${tag}-before`)).toBeLessThanOrEqual(1);
        await change(image);
        expect(await previewVsExport(image, `${tag}-after`)).toBeLessThanOrEqual(1);
      } finally {
        await session.call('close', { image });
      }
    }
  );

  // ---- masks ----------------------------------------------------------------------------------

  it('rectangle mask: a hard mask confines the filter to exactly its rectangle (0px changed outside)', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const beforePath = join(workDir, 'rect-before.png');
      await session.call('export', { image: opened.image, path: beforePath });
      const before = readPng(beforePath);

      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 128,
        height: 32,
        feather_px: 0,
        name: 'HardRect',
      });
      await session.call('curves', {
        image: opened.image,
        points: [
          [0, 255],
          [255, 255],
        ], // force everywhere inside the mask to pure white -- an obvious, checkable change
        mask: 'HardRect',
      });
      const afterPath = join(workDir, 'rect-after.png');
      await session.call('export', { image: opened.image, path: afterPath });
      const after = readPng(afterPath);

      // Asserted before the per-pixel checks below, which hardcode x/y positions relative to
      // this exact canvas size.
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);

      // Every pixel, both sides of the edge: inside forced to white, outside byte-identical.
      let changedOutside = 0;
      let notWhiteInside = 0;
      for (let y = 0; y < after.height; y++) {
        for (let x = 0; x < after.width; x++) {
          const a = pixelAt(after, x, y);
          if (x < 128) {
            if (a.some((c) => c !== 255)) notWhiteInside++;
          } else {
            const b = pixelAt(before, x, y);
            if (a.some((c, i) => c !== b[i])) changedOutside++;
          }
        }
      }
      expect(notWhiteInside, 'pixels inside the mask not forced to white').toBe(0);
      expect(changedOutside, 'pixels outside the mask that changed').toBe(0);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('feathered mask: pixels well outside the feather band are unchanged', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const beforePath = join(workDir, 'feather-before.png');
      await session.call('export', { image: opened.image, path: beforePath });
      const before = readPng(beforePath);

      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 64,
        height: 32,
        feather_px: 8,
        name: 'FeatherRect',
      });
      await session.call('curves', {
        image: opened.image,
        points: [
          [0, 255],
          [255, 255],
        ],
        mask: 'FeatherRect',
      });
      const afterPath = join(workDir, 'feather-after.png');
      await session.call('export', { image: opened.image, path: afterPath });
      const after = readPng(afterPath);

      // Asserted before the per-pixel checks below, which hardcode x/y positions relative to
      // this exact canvas size.
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);

      // Well past the feather radius (8px) beyond the 64px rectangle edge.
      for (const x of [200, 255]) {
        const [beforeVal] = pixelAt(before, x, 16);
        const [afterVal] = pixelAt(after, x, 16);
        expect(afterVal, `x=${x} is outside the feather band`).toBe(beforeVal);
      }
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('ellipse mask reports plausible coverage for its bounding geometry', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      // A 32x32 ellipse inscribed in its bounding box covers pi/4 (~78.5%) of that box.
      const result = await session.call<{ selected_pixels: number; fraction: number }>(
        'create_mask',
        { image: opened.image, type: 'ellipse', x: 0, y: 0, width: 32, height: 32, name: 'Ellipse' }
      );
      const boxFraction = result.selected_pixels / (32 * 32);
      expect(boxFraction).toBeGreaterThan(0.6);
      expect(boxFraction).toBeLessThan(0.9);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('gradient_linear mask confines a filter to a smooth black-to-white ramp, not a hard edge', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('create_mask', {
        image: opened.image,
        type: 'gradient_linear',
        x1: 0,
        y1: 0,
        x2: 255,
        y2: 0,
        name: 'Ramp',
      });
      await session.call('curves', {
        image: opened.image,
        points: [
          [0, 255],
          [255, 255],
        ],
        mask: 'Ramp',
      });
      const outPath = join(workDir, 'grad-mask.png');
      await session.call('export', { image: opened.image, path: outPath });
      const ppm = readPng(outPath);
      // Asserted before the per-pixel checks below, which hardcode x/y positions relative to
      // this exact canvas size.
      expect(ppm.width).toBe(256);
      expect(ppm.height).toBe(32);
      // Left end (mask ~black, ~0% applied) stays near the original ramp value; right end (mask
      // ~white, ~100% applied) is pulled toward the filter's 255 target -- a monotonic ramp of
      // effect, not a step.
      const [leftAfter] = pixelAt(ppm, 5, 16);
      const [midAfter] = pixelAt(ppm, 128, 16);
      const [rightAfter] = pixelAt(ppm, 250, 16);
      expect(leftAfter).toBeLessThan(midAfter);
      expect(midAfter).toBeLessThan(rightAfter);
      expect(rightAfter).toBeGreaterThan(240);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('gradient_radial mask centers its full effect and fades to none at the radius edge', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('create_mask', {
        image: opened.image,
        type: 'gradient_radial',
        cx: 128,
        cy: 16,
        radius: 100,
        name: 'Radial',
      });
      await session.call('curves', {
        image: opened.image,
        points: [
          [0, 255],
          [255, 255],
        ],
        mask: 'Radial',
      });
      const outPath = join(workDir, 'radial-mask.png');
      await session.call('export', { image: opened.image, path: outPath });
      const ppm = readPng(outPath);
      // Asserted before the per-pixel checks below, which hardcode x/y positions relative to
      // this exact canvas size.
      expect(ppm.width).toBe(256);
      expect(ppm.height).toBe(32);
      const [centerAfter] = pixelAt(ppm, 128, 16);
      const [edgeAfter] = pixelAt(ppm, 0, 16);
      expect(centerAfter).toBeGreaterThan(edgeAfter);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('invert swaps which end of a gradient mask is black vs white', async () => {
    // Not a simple ">=128 selected count" comparison: a forward and inverted ramp both cross the
    // 8-bit midpoint at the same distance from their own start point (mirrored, but the same
    // distance), so they'd end up with SIMILAR selected-pixel counts either way -- that comparison
    // would pass without actually distinguishing "inverted" from "not inverted". What invert
    // reliably flips is which endpoint is black and which is white, so this checks exactly that
    // instead.
    const openedA = await session.call<{ image: number }>('open', { path: rampPath });
    const openedB = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('create_mask', {
        image: openedA.image,
        type: 'gradient_linear',
        x1: 0,
        y1: 0,
        x2: 255,
        y2: 0,
        name: 'Fwd',
      });
      await session.call('export_mask', {
        image: openedA.image,
        channel: 'Fwd',
        path: join(workDir, 'fwd.pgm'),
      });
      await session.call('create_mask', {
        image: openedB.image,
        type: 'gradient_linear',
        x1: 0,
        y1: 0,
        x2: 255,
        y2: 0,
        invert: true,
        name: 'Inv',
      });
      await session.call('export_mask', {
        image: openedB.image,
        channel: 'Inv',
        path: join(workDir, 'inv.pgm'),
      });
      const fwdBytes = readGrayscalePgm(join(workDir, 'fwd.pgm'));
      const invBytes = readGrayscalePgm(join(workDir, 'inv.pgm'));
      expect(fwdBytes[0]!).toBeLessThan(50); // forward: black at the start point
      expect(invBytes[0]!).toBeGreaterThan(200); // inverted: white at the same point
      expect(fwdBytes[fwdBytes.length - 1]!).toBeGreaterThan(200); // forward: white at the end point
      expect(invBytes[invBytes.length - 1]!).toBeLessThan(50); // inverted: black at the end point
    } finally {
      await session.call('close', { image: openedA.image });
      await session.call('close', { image: openedB.image });
    }
  });

  it('a same-named mask replaces the previous one rather than stacking', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const first = await session.call<{ fraction: number }>('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        name: 'Reused',
      });
      const second = await session.call<{ fraction: number }>('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 256,
        height: 32,
        name: 'Reused',
      });
      expect(second.fraction).toBeGreaterThan(first.fraction);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('create_mask leaves no active selection: a following UNMASKED adjust reaches pixels far outside the mask rectangle', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      // A mask covering only the FIRST swatch (red) -- if create_mask (or _apply_filter) left
      // this rectangle selection active, an unmasked filter appended right after would silently
      // confine itself to it despite asking for none, while the ledger still (wrongly) reported
      // mask: null.
      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: SWATCH_SIZE,
        height: SWATCH_SIZE,
        name: 'FirstSwatchOnly',
      });
      const created = await session.call<{ mask: string | null }>('adjust', {
        image: opened.image,
        type: 'saturation',
        scale: 0,
      });
      expect(created.mask).toBeNull();

      const outPath = join(workDir, 'unmasked-swatch-after-create-mask.png');
      await session.call('export', { image: opened.image, path: outPath });
      const ppm = readPng(outPath);
      // 'blue' is the LAST swatch, far outside the first swatch's mask rectangle -- desaturated
      // (near-zero color spread) only if the filter reached it despite no `mask` being given.
      const blueSwatch = SWATCHES.find((s) => s.name === 'blue')!;
      const [r, g, b] = pixelAt(ppm, blueSwatch.x * SWATCH_SIZE + 4, 4);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('a mask name already used by an existing filter is refused (does not silently retarget that filter)', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 64,
        height: 32,
        name: 'InUse',
      });
      await session.call('curves', {
        image: opened.image,
        points: [
          [0, 0],
          [255, 128],
        ],
        mask: 'InUse',
      });
      await expect(
        session.call('create_mask', {
          image: opened.image,
          type: 'ellipse',
          x: 0,
          y: 0,
          width: 32,
          height: 32,
          name: 'InUse',
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('a mask name not used by any filter can still be freely replaced (the collision check is scoped to in-use masks)', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        name: 'NotYetUsed',
      });
      await expect(
        session.call('create_mask', {
          image: opened.image,
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 64,
          height: 32,
          name: 'NotYetUsed',
        })
      ).resolves.toMatchObject({ channel: 'NotYetUsed' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('filter set_visibility toggles a filter off, and describe/list reflect it', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const created = await session.call<{ filter_id: number }>('adjust', {
        image: opened.image,
        type: 'saturation',
        scale: 0,
      });
      const off = await session.call<{ visible: boolean }>('filter', {
        image: opened.image,
        op: 'set_visibility',
        filter_id: created.filter_id,
        visible: false,
      });
      expect(off.visible).toBe(false);
      const listed = await session.call<{
        filters: Array<{ filter_id: number; visible: boolean }>;
      }>('filter', { image: opened.image, op: 'list' });
      expect(listed.filters.find((f) => f.filter_id === created.filter_id)?.visible).toBe(false);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('filter delete removes it from the stack and the ledger', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const created = await session.call<{ filter_id: number }>('adjust', {
        image: opened.image,
        type: 'saturation',
        scale: 0,
      });
      const deleted = await session.call<{ deleted: boolean }>('filter', {
        image: opened.image,
        op: 'delete',
        filter_id: created.filter_id,
      });
      expect(deleted.deleted).toBe(true);
      const listed = await session.call<{ filters: unknown[] }>('filter', {
        image: opened.image,
        op: 'list',
      });
      expect(listed.filters).toHaveLength(0);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('filter reorder is refused with an actionable invalid_argument message', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('filter', { image: opened.image, op: 'reorder' })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- missing required args answer invalid_argument naming the field, not a bare KeyError ----

  it('crop requires left/top/width/height, one at a time', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const full = { image: opened.image, left: 0, top: 0, width: 10, height: 10 };
      for (const missing of ['left', 'top', 'width', 'height']) {
        const args = { ...full };
        delete (args as Record<string, unknown>)[missing];
        await expect(session.call('crop', args), missing).rejects.toMatchObject({
          code: 'invalid_argument',
        });
      }
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('crop rejects a rectangle that hangs off the edge of the current image', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      // rampPath is 256x32 -- this rectangle starts inside the image but its right edge (300)
      // runs past the 256px width, exactly the "partly outside" shape `Image.crop` itself would
      // silently accept (padding the overhang with blank space) without this bounds check.
      await expect(
        session.call('crop', { image: opened.image, left: 200, top: 0, width: 100, height: 32 })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('create_mask requires x/y/width/height for rectangle/ellipse, one at a time', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const full = { image: opened.image, type: 'rectangle', x: 0, y: 0, width: 10, height: 10 };
      for (const missing of ['x', 'y', 'width', 'height']) {
        const args = { ...full };
        delete (args as Record<string, unknown>)[missing];
        await expect(session.call('create_mask', args), missing).rejects.toMatchObject({
          code: 'invalid_argument',
        });
      }
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('filter set_visibility requires filter_id and visible', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const created = await session.call<{ filter_id: number }>('adjust', {
        image: opened.image,
        type: 'saturation',
        scale: 0,
      });
      await expect(
        session.call('filter', { image: opened.image, op: 'set_visibility', visible: true })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      await expect(
        session.call('filter', {
          image: opened.image,
          op: 'set_visibility',
          filter_id: created.filter_id,
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      // The string "false" is truthy in Python (`bool("false")` is True) -- `visible` must
      // reject it rather than silently setting the filter visible.
      await expect(
        session.call('filter', {
          image: opened.image,
          op: 'set_visibility',
          filter_id: created.filter_id,
          visible: 'false',
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('every op requires image', async () => {
    await expect(
      session.call('crop', { left: 0, top: 0, width: 10, height: 10 })
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('open requires path', async () => {
    await expect(session.call('open', {})).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  // Referenced so the swatches fixture (and its named constant) has at least one consumer here
  // for readers who land on this file first; the color-relationship checks live in adjust.live.test.ts.
  it('color swatches fixture opens as an image with the expected width', async () => {
    const opened = await session.call<{ image: number; width: number }>('open', {
      path: swatchesPath,
    });
    expect(opened.width).toBe(SWATCHES.length * SWATCH_SIZE);
    await session.call('close', { image: opened.image });
  });

  // ---- gimp_add_effect's direction/position-dependent filters track flip/rotate/resize --------
  // vignette (a center point), motion_blur (an angle), and drop_shadow (an offset vector) are all
  // direction- or position-dependent -- flip/rotate/resize transform their ledgered params
  // (lib.flip_effect_params/rotate_effect_params/resize_effect_params, unit-tested exhaustively at
  // the pure-math level in test_lib.py) so the effect stays locked to the content instead of
  // silently drifting relative to it as the canvas moves underneath it. These tests prove the
  // WIRING (op_flip/op_rotate/op_resize's own call into `_snapshot_effect_transform`/
  // `_apply_planned_effect_transform`) against a real render: applying the effect BEFORE the
  // transform must render the same as transforming a filter-free copy FIRST and then re-creating
  // the identical effect directly at the position/angle/length the transform is expected to
  // produce. Only exact cases are supported -- flip, an exact 90/180/270-degree rotate, and any
  // resize -- so every rotate test below uses a right angle; a separate test proves an arbitrary
  // angle is refused instead of approximated when one of these effects is present.

  /** Mean per-channel absolute difference between two same-sized PNGs -- looser than `maxAbsDiff`,
   * used wherever a real resample (resize) or interpolation (a non-lossless transform) means an
   * occasional edge pixel legitimately differs without the overall comparison being wrong. */
  function meanAbsDiff(a: ReturnType<typeof readPng>, b: ReturnType<typeof readPng>): number {
    let sum = 0;
    for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
    return sum / a.data.length;
  }

  it('flip mirrors an off-centre vignette so it stays locked to the (otherwise flat) content', async () => {
    const flatPath = join(workDir, 'vignette-flip-flat.png');
    writeCheckerboard(flatPath, 200, 200, 999, 150, 150); // a uniform 150-gray field
    // Path A: vignette, then flip.
    const a = await session.call<{ image: number }>('open', { path: flatPath });
    await session.call('effect', {
      image: a.image,
      type: 'vignette',
      center_x: 0.2,
      center_y: 0.5,
      radius: 0.4,
      softness: 0.3,
    });
    await session.call('flip', { image: a.image, orientation: 'horizontal' });
    const outA = join(workDir, 'vignette-flip-a.png');
    await session.call('export', { image: a.image, path: outA });
    await session.call('close', { image: a.image });
    // Path B: flip a filter-free copy first, then create the SAME vignette directly at the
    // mirrored center (1 - center_x) -- what `flip_effect_params` computes for `gegl:vignette`.
    const b = await session.call<{ image: number }>('open', { path: flatPath });
    await session.call('flip', { image: b.image, orientation: 'horizontal' });
    await session.call('effect', {
      image: b.image,
      type: 'vignette',
      center_x: 0.8,
      center_y: 0.5,
      radius: 0.4,
      softness: 0.3,
    });
    const outB = join(workDir, 'vignette-flip-b.png');
    await session.call('export', { image: b.image, path: outB });
    await session.call('close', { image: b.image });
    expect(maxAbsDiff(readPng(outA), readPng(outB))).toBeLessThanOrEqual(1);
  });

  it('rotate 90 (square canvas) moves an off-centre vignette to the position rotate_point_fraction predicts', async () => {
    // A square canvas so 90 degrees needs no `expand` (dimensions do not change) -- isolates the
    // rotation itself from the separate old/new-dimension bookkeeping `expand` would add.
    // rotate_point_fraction(0.2, 0.7, 90deg, 200, 200, 200, 200) = (0.3, 0.2) by the same formula
    // lib.py's own function computes: old_cx=old_cy=100; dx=-60,dy=40; rx=-40,ry=-60; new
    // center = (100-40, 100-60)/200 = (0.3, 0.2).
    const flatPath = join(workDir, 'vignette-rotate90-flat.png');
    writeCheckerboard(flatPath, 200, 200, 999, 150, 150);
    const a = await session.call<{ image: number }>('open', { path: flatPath });
    await session.call('effect', {
      image: a.image,
      type: 'vignette',
      center_x: 0.2,
      center_y: 0.7,
      radius: 0.4,
      softness: 0.3,
    });
    await session.call('rotate', { image: a.image, degrees: 90, expand: false });
    const outA = join(workDir, 'vignette-rotate90-a.png');
    await session.call('export', { image: a.image, path: outA });
    await session.call('close', { image: a.image });
    const b = await session.call<{ image: number }>('open', { path: flatPath });
    await session.call('rotate', { image: b.image, degrees: 90, expand: false });
    await session.call('effect', {
      image: b.image,
      type: 'vignette',
      center_x: 0.3,
      center_y: 0.2,
      radius: 0.4,
      softness: 0.3,
    });
    const outB = join(workDir, 'vignette-rotate90-b.png');
    await session.call('export', { image: b.image, path: outB });
    await session.call('close', { image: b.image });
    expect(maxAbsDiff(readPng(outA), readPng(outB))).toBeLessThanOrEqual(3);
  });

  it('rotate 90 turns a horizontal motion blur into a vertical one, matching a directly-applied 90deg blur', async () => {
    const stripesPath = join(workDir, 'motion-rotate90-stripes.png');
    writeCheckerboard(stripesPath, 200, 200, 8, 60, 200);
    // Path A: horizontal blur (angle 0), then rotate 90.
    const a = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('effect', { image: a.image, type: 'motion_blur', length: 30, angle: 0 });
    await session.call('rotate', { image: a.image, degrees: 90, expand: false });
    const outA = join(workDir, 'motion-rotate90-a.png');
    await session.call('export', { image: a.image, path: outA });
    await session.call('close', { image: a.image });
    // Path B: rotate 90 first (fresh), then blur directly at angle 90 (0 + 90, wrapped) --
    // `rotate_effect_params`'s own transform for `gegl:motion-blur-linear`.
    const b = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('rotate', { image: b.image, degrees: 90, expand: false });
    await session.call('effect', { image: b.image, type: 'motion_blur', length: 30, angle: 90 });
    const outB = join(workDir, 'motion-rotate90-b.png');
    await session.call('export', { image: b.image, path: outB });
    await session.call('close', { image: b.image });
    // Path C (negative control): rotate 90 first, but blur at the WRONG (unrotated) angle 0 --
    // proves angle actually matters for this fixture, so A~B matching isn't a fixture artifact.
    const c = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('rotate', { image: c.image, degrees: 90, expand: false });
    await session.call('effect', { image: c.image, type: 'motion_blur', length: 30, angle: 0 });
    const outC = join(workDir, 'motion-rotate90-c.png');
    await session.call('export', { image: c.image, path: outC });
    await session.call('close', { image: c.image });

    const ab = meanAbsDiff(readPng(outA), readPng(outB));
    const ac = meanAbsDiff(readPng(outA), readPng(outC));
    expect(ab, `A vs B (correct angle) mean abs diff ${ab}`).toBeLessThan(6);
    expect(ac, `A vs C (wrong angle) mean abs diff ${ac}`).toBeGreaterThan(ab * 3);
  });

  it('rotate 90 adds to a motion blur angle (30 -> 120, not the wrong-signed 60) -- regression pin', async () => {
    // The additive convention (angle + degrees) vs a wrong subtractive one (degrees - angle):
    // both are "real" angles a transcription slip could produce, so this specifically checks the
    // render lands on 120, with 60 as an explicit negative control, not just "some angle changed".
    const stripesPath = join(workDir, 'motion-rotate90-30plus90-stripes.png');
    writeCheckerboard(stripesPath, 200, 200, 8, 60, 200);
    const a = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('effect', { image: a.image, type: 'motion_blur', length: 30, angle: 30 });
    await session.call('rotate', { image: a.image, degrees: 90, expand: false });
    const outA = join(workDir, 'motion-rotate90-30plus90-a.png');
    await session.call('export', { image: a.image, path: outA });
    await session.call('close', { image: a.image });
    const b = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('rotate', { image: b.image, degrees: 90, expand: false });
    await session.call('effect', { image: b.image, type: 'motion_blur', length: 30, angle: 120 });
    const outB = join(workDir, 'motion-rotate90-30plus90-b.png');
    await session.call('export', { image: b.image, path: outB });
    await session.call('close', { image: b.image });
    const c = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('rotate', { image: c.image, degrees: 90, expand: false });
    await session.call('effect', { image: c.image, type: 'motion_blur', length: 30, angle: 60 });
    const outC = join(workDir, 'motion-rotate90-30plus90-c.png');
    await session.call('export', { image: c.image, path: outC });
    await session.call('close', { image: c.image });
    const ab = meanAbsDiff(readPng(outA), readPng(outB));
    const ac = meanAbsDiff(readPng(outA), readPng(outC));
    expect(ab, `A vs B (120, correct) mean abs diff ${ab}`).toBeLessThan(6);
    expect(ac, `A vs C (60, wrong) mean abs diff ${ac}`).toBeGreaterThan(ab * 3);
  });

  it("resize scales a motion blur's length isotropically under a UNIFORM scale, matching a directly-applied scaled-length blur", async () => {
    const stripesPath = join(workDir, 'motion-resize-stripes.png');
    writeCheckerboard(stripesPath, 400, 100, 8, 60, 200);
    // Path A: blur at full res, then resize to half width (aspect-locked, so half height too).
    const a = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('effect', { image: a.image, type: 'motion_blur', length: 40, angle: 0 });
    await session.call('resize', { image: a.image, width: 200 });
    const outA = join(workDir, 'motion-resize-a.png');
    await session.call('export', { image: a.image, path: outA });
    await session.call('close', { image: a.image });
    // Path B: resize first (fresh), then blur directly at the scaled length (40 * 0.5 = 20) --
    // `resize_effect_params`'s own isotropic scaling for `gegl:motion-blur-linear`.
    const b = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('resize', { image: b.image, width: 200 });
    await session.call('effect', { image: b.image, type: 'motion_blur', length: 20, angle: 0 });
    const outB = join(workDir, 'motion-resize-b.png');
    await session.call('export', { image: b.image, path: outB });
    await session.call('close', { image: b.image });
    // Path C (negative control): resize first, then blur at the UNSCALED length (40) -- proves
    // scaling actually matters for this fixture.
    const c = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('resize', { image: c.image, width: 200 });
    await session.call('effect', { image: c.image, type: 'motion_blur', length: 40, angle: 0 });
    const outC = join(workDir, 'motion-resize-c.png');
    await session.call('export', { image: c.image, path: outC });
    await session.call('close', { image: c.image });

    const ab = meanAbsDiff(readPng(outA), readPng(outB));
    const ac = meanAbsDiff(readPng(outA), readPng(outC));
    // Looser than the lossless flip/rotate90 comparisons above: resize is a real resample, and
    // blur-then-downsample doesn't perfectly commute with downsample-then-blur even at the
    // mathematically correct scaled length.
    expect(ab, `A vs B (scaled length) mean abs diff ${ab}`).toBeLessThan(12);
    expect(ac, `A vs C (unscaled length) mean abs diff ${ac}`).toBeGreaterThan(ab * 2);
  });

  it('resize scales a motion blur ANISOTROPICALLY at an oblique angle (length AND angle both change)', async () => {
    // scale_x=2 (200->400), scale_y=0.5 (200->100), angle=45: direction vector (cos45,sin45)
    // scales to (2*cos45, 0.5*sin45) -- length' = hypot(...) * 30, angle' = atan2(...) --
    // computed independently here (lib.resize_effect_params's own formula, not re-derived) so a
    // transcription error in the implementation would show up as a real pixel mismatch.
    const theta = Math.PI / 4;
    const vx = 2.0 * Math.cos(theta);
    const vy = 0.5 * Math.sin(theta);
    const expectedLength = 30 * Math.hypot(vx, vy);
    const expectedAngle = (Math.atan2(vy, vx) * 180) / Math.PI;
    const stripesPath = join(workDir, 'motion-resize-aniso-stripes.png');
    writeCheckerboard(stripesPath, 200, 200, 8, 60, 200);
    const a = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('effect', { image: a.image, type: 'motion_blur', length: 30, angle: 45 });
    await session.call('resize', { image: a.image, width: 400, height: 100 });
    const outA = join(workDir, 'motion-resize-aniso-a.png');
    await session.call('export', { image: a.image, path: outA });
    await session.call('close', { image: a.image });
    const b = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('resize', { image: b.image, width: 400, height: 100 });
    await session.call('effect', {
      image: b.image,
      type: 'motion_blur',
      length: expectedLength,
      angle: expectedAngle,
    });
    const outB = join(workDir, 'motion-resize-aniso-b.png');
    await session.call('export', { image: b.image, path: outB });
    await session.call('close', { image: b.image });
    // Negative control: resize first, but keep the ORIGINAL (unrotated-for-aspect) length/angle.
    const c = await session.call<{ image: number }>('open', { path: stripesPath });
    await session.call('resize', { image: c.image, width: 400, height: 100 });
    await session.call('effect', { image: c.image, type: 'motion_blur', length: 30, angle: 45 });
    const outC = join(workDir, 'motion-resize-aniso-c.png');
    await session.call('export', { image: c.image, path: outC });
    await session.call('close', { image: c.image });
    const ab = meanAbsDiff(readPng(outA), readPng(outB));
    const ac = meanAbsDiff(readPng(outA), readPng(outC));
    expect(ab, `A vs B (anisotropic formula) mean abs diff ${ab}`).toBeLessThan(12);
    expect(ac, `A vs C (unscaled length/angle) mean abs diff ${ac}`).toBeGreaterThan(ab * 2);
  });

  it('drop_shadow stays locked to the content under flip, rotate 90, and resize', async () => {
    const shapePath = join(workDir, 'shadow-transform-shape.png');
    writeRgbaSquare(shapePath, 200, 200, 44, 44, 40, [128, 128, 128]);
    const BASE_ARGS = { offset_x: 15, offset_y: -8, radius: 5, opacity: 0.9 } as const;

    // Flip: offset_x negates.
    {
      const a = await session.call<{ image: number }>('open', { path: shapePath });
      await session.call('effect', { image: a.image, type: 'drop_shadow', ...BASE_ARGS });
      await session.call('flip', { image: a.image, orientation: 'horizontal' });
      const outA = join(workDir, 'shadow-flip-a.png');
      await session.call('export', { image: a.image, path: outA });
      await session.call('close', { image: a.image });
      const b = await session.call<{ image: number }>('open', { path: shapePath });
      await session.call('flip', { image: b.image, orientation: 'horizontal' });
      await session.call('effect', {
        image: b.image,
        type: 'drop_shadow',
        ...BASE_ARGS,
        offset_x: -BASE_ARGS.offset_x,
      });
      const outB = join(workDir, 'shadow-flip-b.png');
      await session.call('export', { image: b.image, path: outB });
      await session.call('close', { image: b.image });
      expect(maxAbsDiff(readPng(outA), readPng(outB))).toBeLessThanOrEqual(1);
    }

    // Rotate 90 (square canvas, no expand needed): (dx,dy) -> (-dy,dx).
    {
      const a = await session.call<{ image: number }>('open', { path: shapePath });
      await session.call('effect', { image: a.image, type: 'drop_shadow', ...BASE_ARGS });
      await session.call('rotate', { image: a.image, degrees: 90, expand: false });
      const outA = join(workDir, 'shadow-rotate90-a.png');
      await session.call('export', { image: a.image, path: outA });
      await session.call('close', { image: a.image });
      const b = await session.call<{ image: number }>('open', { path: shapePath });
      await session.call('rotate', { image: b.image, degrees: 90, expand: false });
      await session.call('effect', {
        image: b.image,
        type: 'drop_shadow',
        ...BASE_ARGS,
        offset_x: -BASE_ARGS.offset_y,
        offset_y: BASE_ARGS.offset_x,
      });
      const outB = join(workDir, 'shadow-rotate90-b.png');
      await session.call('export', { image: b.image, path: outB });
      await session.call('close', { image: b.image });
      expect(maxAbsDiff(readPng(outA), readPng(outB))).toBeLessThanOrEqual(3);
    }

    // Resize (uniform 0.5x): offsets and radius both scale by 0.5.
    {
      const a = await session.call<{ image: number }>('open', { path: shapePath });
      await session.call('effect', { image: a.image, type: 'drop_shadow', ...BASE_ARGS });
      await session.call('resize', { image: a.image, width: 100, height: 100 });
      const outA = join(workDir, 'shadow-resize-a.png');
      await session.call('export', { image: a.image, path: outA });
      await session.call('close', { image: a.image });
      const b = await session.call<{ image: number }>('open', { path: shapePath });
      await session.call('resize', { image: b.image, width: 100, height: 100 });
      await session.call('effect', {
        image: b.image,
        type: 'drop_shadow',
        offset_x: BASE_ARGS.offset_x * 0.5,
        offset_y: BASE_ARGS.offset_y * 0.5,
        radius: BASE_ARGS.radius * 0.5,
        opacity: BASE_ARGS.opacity,
      });
      const outB = join(workDir, 'shadow-resize-b.png');
      await session.call('export', { image: b.image, path: outB });
      await session.call('close', { image: b.image });
      expect(meanAbsDiff(readPng(outA), readPng(outB))).toBeLessThan(6);
    }
  });

  it("rotate 90 with expand true AND false moves an off-centre vignette using the LAYER's own (not the canvas's) new extent", async () => {
    // A non-square canvas so canvas dims and layer dims can be told apart: with expand=false the
    // CANVAS stays 300x100, but the LAYER's own bounding box still becomes 100x300 (GIMP resizes
    // a rotated layer's own bounds regardless of whether the canvas follows) -- vignette's
    // center_x/center_y must be computed against THAT (100x300), not the unchanged 300x100
    // canvas, or this would land at the wrong point. rotate_point_fraction(0.75, 0.5, 90, 300,
    // 100, 100, 300) = (0.5, 0.75) (old_cx=150,old_cy=50; dx=75,dy=0; rx=0,ry=75; new center =
    // (50+0, 150+75)/(100,300)).
    const flatPath = join(workDir, 'vignette-rotate90-nonsquare-flat.png');
    writeCheckerboard(flatPath, 300, 100, 999, 150, 150);
    for (const expand of [false, true]) {
      const a = await session.call<{ image: number }>('open', { path: flatPath });
      await session.call('effect', {
        image: a.image,
        type: 'vignette',
        center_x: 0.75,
        center_y: 0.5,
        radius: 0.4,
        softness: 0.3,
      });
      await session.call('rotate', { image: a.image, degrees: 90, expand });
      const outA = join(workDir, `vignette-rotate90-nonsquare-${expand}-a.png`);
      await session.call('export', { image: a.image, path: outA });
      await session.call('close', { image: a.image });
      const b = await session.call<{ image: number }>('open', { path: flatPath });
      await session.call('rotate', { image: b.image, degrees: 90, expand });
      await session.call('effect', {
        image: b.image,
        type: 'vignette',
        center_x: 0.5,
        center_y: 0.75,
        radius: 0.4,
        softness: 0.3,
      });
      const outB = join(workDir, `vignette-rotate90-nonsquare-${expand}-b.png`);
      await session.call('export', { image: b.image, path: outB });
      await session.call('close', { image: b.image });
      expect(maxAbsDiff(readPng(outA), readPng(outB)), `expand=${expand}`).toBeLessThanOrEqual(3);
    }
  });

  it('vertical flip mirrors an off-centre vignette the same way horizontal flip does', async () => {
    const flatPath = join(workDir, 'vignette-vflip-flat.png');
    writeCheckerboard(flatPath, 200, 200, 999, 150, 150);
    const a = await session.call<{ image: number }>('open', { path: flatPath });
    await session.call('effect', {
      image: a.image,
      type: 'vignette',
      center_x: 0.5,
      center_y: 0.2,
      radius: 0.4,
      softness: 0.3,
    });
    await session.call('flip', { image: a.image, orientation: 'vertical' });
    const outA = join(workDir, 'vignette-vflip-a.png');
    await session.call('export', { image: a.image, path: outA });
    await session.call('close', { image: a.image });
    const b = await session.call<{ image: number }>('open', { path: flatPath });
    await session.call('flip', { image: b.image, orientation: 'vertical' });
    await session.call('effect', {
      image: b.image,
      type: 'vignette',
      center_x: 0.5,
      center_y: 0.8,
      radius: 0.4,
      softness: 0.3,
    });
    const outB = join(workDir, 'vignette-vflip-b.png');
    await session.call('export', { image: b.image, path: outB });
    await session.call('close', { image: b.image });
    expect(maxAbsDiff(readPng(outA), readPng(outB))).toBeLessThanOrEqual(1);
  });

  it('an effect on a layer NESTED IN A GROUP is tracked through flip too', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('test_wrap_in_group', { image: opened.image });
      const created = await session.call<{ filter_id: number }>('effect', {
        image: opened.image,
        type: 'vignette',
        center_x: 0.3,
        center_y: 0.5,
        layer: 'Nested',
      });
      await session.call('flip', { image: opened.image, orientation: 'horizontal' });
      const listed = await session.call<{
        filters: Array<{ filter_id: number; params: Record<string, unknown> }>;
      }>('filter', { image: opened.image, op: 'list' });
      const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(rec.params.center_x).toBeCloseTo(0.7, 9);
      expect(rec.params.center_y).toBe(0.5);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('an arbitrary (non-right-angle) rotate is refused while a position/direction-dependent effect is present', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('effect', { image: opened.image, type: 'vignette', radius: 0.6 });
      let error: unknown;
      try {
        await session.call('rotate', { image: opened.image, degrees: 15, expand: true });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'invalid_argument' });
      const message = (error as Error).message;
      // Names the filter (its own name, "Vignette" -- the same convention
      // _refuse_if_masked_filters already uses), not just a bare "refused".
      expect(message).toContain('Vignette');
      expect(message).toContain('15');
      // A right angle on the SAME image, with the SAME effect present, must NOT be refused for
      // this reason -- proves the refusal is scoped to the angle, not to the effect's mere
      // presence.
      await expect(
        session.call('rotate', { image: opened.image, degrees: 90, expand: true })
      ).resolves.toBeTruthy();
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('flip/rotate/resize update the ledger itself, not just the live render -- op=list reports the new values, and a later partial re-edit keeps them', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const created = await session.call<{ filter_id: number }>('effect', {
        image: opened.image,
        type: 'vignette',
        center_x: 0.2,
        center_y: 0.5,
        radius: 0.6,
        softness: 0.4,
      });
      await session.call('flip', { image: opened.image, orientation: 'horizontal' });
      const afterFlip = await session.call<{
        filters: Array<{ filter_id: number; params: Record<string, unknown> }>;
      }>('filter', { image: opened.image, op: 'list' });
      const recAfterFlip = afterFlip.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(recAfterFlip.params.center_x).toBeCloseTo(0.8, 9); // 1 - 0.2
      expect(recAfterFlip.params.center_y).toBe(0.5);

      // A partial re-edit (only `softness`) must keep the FLIPPED center, not the original.
      await session.call('effect', {
        image: opened.image,
        type: 'vignette',
        filter_id: created.filter_id,
        softness: 0.1,
      });
      const afterReedit = await session.call<{
        filters: Array<{ filter_id: number; params: Record<string, unknown> }>;
      }>('filter', { image: opened.image, op: 'list' });
      const recAfterReedit = afterReedit.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(recAfterReedit.params.center_x).toBeCloseTo(0.8, 9);
      expect(recAfterReedit.params.center_y).toBe(0.5);
      expect(recAfterReedit.params.softness).toBe(0.1);
      expect(recAfterReedit.params.radius).toBe(0.6); // untouched by either step
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('resize is refused BEFORE mutating anything when the scaled result would leave a valid range', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const created = await session.call<{ filter_id: number }>('effect', {
        image: opened.image,
        type: 'motion_blur',
        length: 900,
        angle: 0,
      });
      // 900 * (512/256) = 1800, over the 1000 cap -- must refuse, not silently clamp.
      let error: unknown;
      try {
        await session.call('resize', { image: opened.image, width: 512 });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'invalid_argument' });
      const message = (error as Error).message;
      expect(message).toContain('motion_blur');
      expect(message).toContain('length');
      // Nothing was mutated: the canvas is still the original size, and the filter's own length
      // is still exactly what it was created with.
      const unchangedPath = join(workDir, 'resize-refusal-unchanged.png');
      await session.call('export', { image: opened.image, path: unchangedPath });
      const exported = readPng(unchangedPath);
      expect(exported.width).toBe(256);
      expect(exported.height).toBe(32);
      const listed = await session.call<{
        filters: Array<{ filter_id: number; params: Record<string, unknown> }>;
      }>('filter', { image: opened.image, op: 'list' });
      const rec = listed.filters.find((f) => f.filter_id === created.filter_id)!;
      expect(rec.params.length).toBe(900);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('rotate/flip/resize refuse when a MASKED effect (not just a masked adjustment) is present', async () => {
    const rampWithMaskedVignette = async () => {
      const opened = await session.call<{ image: number }>('open', { path: rampPath });
      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 128,
        height: 32,
        name: 'VignetteMask',
      });
      await session.call('effect', {
        image: opened.image,
        type: 'vignette',
        radius: 0.6,
        mask: 'VignetteMask',
      });
      return opened.image;
    };
    for (const [label, call] of [
      // degrees: 90 (a right angle) isolates the masked-filter refusal specifically -- an
      // arbitrary angle would ALSO refuse now (see the dedicated test below), which would leave
      // this ambiguous about which of the two reasons actually fired.
      ['rotate', (image: number) => session.call('rotate', { image, degrees: 90, expand: true })],
      ['flip', (image: number) => session.call('flip', { image, orientation: 'horizontal' })],
      ['resize', (image: number) => session.call('resize', { image, long_edge: 64 })],
    ] as const) {
      const image = await rampWithMaskedVignette();
      try {
        await expect(call(image), label).rejects.toMatchObject({ code: 'invalid_argument' });
      } finally {
        await session.call('close', { image });
      }
    }
  });
});
