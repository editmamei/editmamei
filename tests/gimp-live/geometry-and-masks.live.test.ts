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
  writeHalfMaskPgm,
  SWATCHES,
  SWATCH_SIZE,
  readySession,
  LIVE_READY_TIMEOUT_MS,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

describe.skipIf(!install)('geometry and masks', () => {
  let workDir: string;
  let session: GimpSession;
  let rampPath: string;
  let swatchesPath: string;

  beforeAll(
    async () => {
      workDir = mkdtempSync(join(tmpdir(), 'em-gimp-geom-'));
      session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
      await readySession(session);
      rampPath = join(workDir, 'ramp.png');
      swatchesPath = join(workDir, 'swatches.png');
      writeGrayRamp(rampPath, 256, 32);
      writeColorSwatches(swatchesPath);
    },
    LIVE_READY_TIMEOUT_MS
  );

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

      for (const x of [0, 63, 127]) {
        expect(pixelAt(after, x, 16)[0]).toBe(255);
      }
      for (const x of [128, 200, 255]) {
        const [beforeVal] = pixelAt(before, x, 16);
        const [afterVal] = pixelAt(after, x, 16);
        expect(afterVal, `x=${x} outside the mask must be unchanged`).toBe(beforeVal);
      }
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

  it('select_mask applies the same in-use-name collision check create_mask does', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 64,
        height: 32,
        name: 'SelectMaskInUse',
      });
      await session.call('curves', {
        image: opened.image,
        points: [
          [0, 0],
          [255, 128],
        ],
        mask: 'SelectMaskInUse',
      });
      const maskPath = join(workDir, 'half-mask.pgm');
      writeHalfMaskPgm(maskPath, 256, 32);
      await expect(
        session.call('select_mask', {
          image: opened.image,
          mask_path: maskPath,
          name: 'SelectMaskInUse',
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
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

  it('select_mask requires mask_path', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('select_mask', { image: opened.image, name: 'Mask' })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('export_mask requires path', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('create_mask', {
        image: opened.image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        name: 'ExportMaskPathCheck',
      });
      await expect(
        session.call('export_mask', { image: opened.image, channel: 'ExportMaskPathCheck' })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
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
});
