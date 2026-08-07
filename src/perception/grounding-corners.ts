/**
 * Harris CORNER anchors — the last classical-CV point producer of the anchor
 * palette (Phase 2). The VLM names a corner feature ("the corner of the table",
 * "where the two walls meet") + a neighborhood; this finds it and yields a point
 * primitive the resolver composes. A corner is where the image gradient is strong
 * in TWO directions (unlike an edge, strong in one), so it localizes a precise
 * point — useful for structural/relational placement ("between two letters").
 *
 * Method: Harris response R = det(M) − k·trace(M)² over the local structure
 * tensor M = Σ[Ix² IxIy; IxIy Iy²] (Sobel gradients, box window), then threshold
 * (relative to the region max) + non-max suppression. Tuning-light, no neural
 * model. Pure over a decoded RGBA image; unit-tests on synthetic buffers.
 */

import { type Point, type Box, dist } from './grounding-geometry.js';
import type { RgbaImage } from './grounding-review-crop.js';
import type { Primitive } from './grounding-resolver.js';

export interface Corner {
  point: Point;
  /** Harris response (higher = stronger corner). */
  response: number;
}

export interface CornerOptions {
  /** Harris k (default 0.05). */
  k?: number;
  /** Structure-tensor box window radius, px (default 2). */
  windowRadius?: number;
  /** Non-max-suppression radius, px (default 3). */
  nmsRadius?: number;
  /** Keep corners with response ≥ threshold·maxResponse (default 0.05). */
  relThreshold?: number;
  /** Cap on returned corners, strongest first (default 32). */
  max?: number;
}

const clampi = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Find Harris corners within a region, strongest first. Pass a bounded
 * neighborhood — cost is ~O(region area). Empty if the region has no corner
 * above threshold (a flat/edge-only region self-flags, like the edge tracer).
 */
export function findCorners(img: RgbaImage, region: Box, opts: CornerOptions = {}): Corner[] {
  const k = opts.k ?? 0.05;
  const wr = Math.max(1, opts.windowRadius ?? 2);
  const nms = Math.max(1, opts.nmsRadius ?? 3);
  const relT = opts.relThreshold ?? 0.05;
  const cap = opts.max ?? 32;

  const rx0 = clampi(Math.round(region.left), 0, img.width - 1);
  const ry0 = clampi(Math.round(region.top), 0, img.height - 1);
  const rx1 = clampi(Math.round(region.right), 0, img.width - 1);
  const ry1 = clampi(Math.round(region.bottom), 0, img.height - 1);
  const rw = rx1 - rx0 + 1,
    rh = ry1 - ry0 + 1;
  if (rw < 3 || rh < 3) return [];

  // region-local luminance
  const lum = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const i = ((ry0 + y) * img.width + (rx0 + x)) * 4;
      lum[y * rw + x] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    }
  const L = (x: number, y: number): number => lum[clampi(y, 0, rh - 1) * rw + clampi(x, 0, rw - 1)];

  // Sobel gradients
  const Ix = new Float32Array(rw * rh),
    Iy = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      Ix[y * rw + x] =
        -L(x - 1, y - 1) -
        2 * L(x - 1, y) -
        L(x - 1, y + 1) +
        L(x + 1, y - 1) +
        2 * L(x + 1, y) +
        L(x + 1, y + 1);
      Iy[y * rw + x] =
        -L(x - 1, y - 1) -
        2 * L(x, y - 1) -
        L(x + 1, y - 1) +
        L(x - 1, y + 1) +
        2 * L(x, y + 1) +
        L(x + 1, y + 1);
    }

  // Harris response over a box window
  const R = new Float32Array(rw * rh);
  let maxR = 0;
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      let a = 0,
        b = 0,
        c = 0;
      for (let dy = -wr; dy <= wr; dy++)
        for (let dx = -wr; dx <= wr; dx++) {
          const xx = clampi(x + dx, 0, rw - 1),
            yy = clampi(y + dy, 0, rh - 1);
          const gx = Ix[yy * rw + xx],
            gy = Iy[yy * rw + xx];
          a += gx * gx;
          b += gx * gy;
          c += gy * gy;
        }
      const r = a * c - b * b - k * (a + c) * (a + c);
      R[y * rw + x] = r;
      if (r > maxR) maxR = r;
    }
  if (maxR <= 0) return [];

  // threshold + non-max suppression
  const threshold = relT * maxR;
  const corners: Corner[] = [];
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const r = R[y * rw + x];
      if (r < threshold) continue;
      let isMax = true;
      for (let dy = -nms; dy <= nms && isMax; dy++)
        for (let dx = -nms; dx <= nms; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= rw || yy >= rh) continue;
          if (R[yy * rw + xx] > r) {
            isMax = false;
            break;
          }
        }
      if (isMax) corners.push({ point: { x: rx0 + x, y: ry0 + y }, response: r });
    }
  corners.sort((p, q) => q.response - p.response);
  return corners.slice(0, cap);
}

/**
 * The corner anchor for the region — the corner nearest `near` if given, else the
 * strongest. Returns null if the region has no corner above threshold.
 */
export function cornerAnchor(
  img: RgbaImage,
  region: Box,
  opts: CornerOptions & { near?: Point } = {}
): Primitive | null {
  const corners = findCorners(img, region, opts);
  if (corners.length === 0) return null;
  const chosen = opts.near
    ? corners.reduce((best, c) =>
        dist(c.point, opts.near!) < dist(best.point, opts.near!) ? c : best
      )
    : corners[0];
  return { kind: 'point', point: chosen.point };
}
