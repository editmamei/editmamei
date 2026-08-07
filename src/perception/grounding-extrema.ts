/**
 * Brightness/colour EXTREMUM anchors — a classical-CV point producer. The VLM
 * names "the brightest point" / "the darkest spot" / "the most saturated area"
 * within a region and this scans for it, yielding a point primitive the resolver
 * composes. Image-dependent, so it runs BEFORE the pure resolver (like detection
 * and the edge tracer) — extremum is an anchor producer, not a resolver relation.
 *
 * A small window-mean (not a single pixel) makes it robust to hot/dead pixels and
 * JPEG noise; a stride bounds cost on large regions. Pure over a decoded RGBA
 * image; unit-tests on synthetic buffers.
 */

import type { Point, Box } from './grounding-geometry.js';
import type { RgbaImage } from './grounding-review-crop.js';
import type { Primitive } from './grounding-resolver.js';

export type ExtremumMeasure = 'brightest' | 'darkest' | 'most-saturated';

export interface Extremum {
  point: Point;
  /** The measure value at the winning point (0–255). */
  value: number;
}

export interface ExtremumOptions {
  /** Sample step in px (default 2) — bounds cost on large regions. */
  stride?: number;
  /** Window half-size for the local mean (default 1 → 3×3). */
  window?: number;
}

const clampi = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Mean of `measure` over a (2w+1)² window centred at (x,y), clamped to the image. */
function windowMean(
  img: RgbaImage,
  x: number,
  y: number,
  w: number,
  measure: ExtremumMeasure
): number {
  let sum = 0,
    n = 0;
  for (let dy = -w; dy <= w; dy++) {
    for (let dx = -w; dx <= w; dx++) {
      const px = clampi(x + dx, 0, img.width - 1),
        py = clampi(y + dy, 0, img.height - 1);
      const i = (py * img.width + px) * 4;
      const r = img.data[i],
        g = img.data[i + 1],
        b = img.data[i + 2];
      const v =
        measure === 'most-saturated'
          ? Math.max(r, g, b) - Math.min(r, g, b)
          : 0.299 * r + 0.587 * g + 0.114 * b;
      sum += v;
      n++;
    }
  }
  return sum / n;
}

/**
 * Find the extremum of `measure` within `region`. `darkest` minimizes luma; the
 * others maximize. Returns the winning point (document pixels) + its value.
 */
export function findExtremum(
  img: RgbaImage,
  region: Box,
  measure: ExtremumMeasure,
  opts: ExtremumOptions = {}
): Extremum {
  const stride = Math.max(1, opts.stride ?? 2);
  const w = Math.max(0, opts.window ?? 1);
  const left = clampi(Math.round(region.left), 0, img.width - 1);
  const right = clampi(Math.round(region.right), 0, img.width - 1);
  const top = clampi(Math.round(region.top), 0, img.height - 1);
  const bottom = clampi(Math.round(region.bottom), 0, img.height - 1);
  const minimize = measure === 'darkest';

  let best = minimize ? Infinity : -Infinity;
  let bestPt: Point = { x: left, y: top };
  for (let y = top; y <= bottom; y += stride) {
    for (let x = left; x <= right; x += stride) {
      const v = windowMean(img, x, y, w, measure);
      if (minimize ? v < best : v > best) {
        best = v;
        bestPt = { x, y };
      }
    }
  }
  return { point: bestPt, value: Math.round(best) };
}

/** The extremum as a resolver anchor primitive. */
export function extremumAnchor(
  img: RgbaImage,
  region: Box,
  measure: ExtremumMeasure,
  opts?: ExtremumOptions
): Primitive {
  return { kind: 'point', point: findExtremum(img, region, measure, opts).point };
}
