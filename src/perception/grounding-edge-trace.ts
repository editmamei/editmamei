/**
 * Classical-CV edge tracer — the CRITICAL anchor producer of the spatial-grounding
 * redesign (Phase 2). The VLM NAMES an arbitrary geometric boundary that is not a
 * detectable object ("the horizon", "the jaw line", "the edge of the table") and a
 * neighborhood; this traces the actual pixels into a polyline anchor + a per-point
 * confidence. That anchor feeds the resolver (`along` / `offset-curve`) and the
 * gate's `edge` check (grounding-gate.ts) unchanged.
 *
 * Method: tuning-free directional boundary trace. Along each scan line in the
 * region, the boundary is the position of the STRONGEST luminance band-transition
 * (mean luma in a band before vs after) — the ridgeline metric validated in report
 * E1 (real edges Δ90–154; false traces Δ20–27). The transition strength IS the
 * confidence, so a weak/absent edge (the jaw-fails case) self-flags with low
 * confidence and the gate fail-closes on it. No neural model, near-zero cost.
 *
 * Pure over a decoded RGBA image; unit-tests on synthetic buffers.
 */

import { type Point, type Polyline, type Box } from './grounding-geometry.js';
import type { RgbaImage } from './grounding-review-crop.js';

/** A roughly-horizontal boundary (scan columns, vary y) or roughly-vertical (scan rows, vary x). */
export type EdgeOrientation = 'horizontal-edge' | 'vertical-edge';

export interface TraceOptions {
  region: Box;
  orientation: EdgeOrientation;
  /** How many scan lines across the region (default 24). */
  samples?: number;
  /** Half-width of the luma comparison band, px (default derived from region size). */
  band?: number;
}

export interface TracedEdge {
  /** The traced boundary, one point per sampled scan line, in document pixels. */
  polyline: Polyline;
  /** Per-point transition strength (luma band-Δ) — feeds the gate's edge check. */
  confidences: number[];
  meanConfidence: number;
}

const lumaAt = (img: RgbaImage, x: number, y: number): number => {
  const i = (y * img.width + x) * 4;
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
};

/** Mean luma of a vertical band [y-band, y-1] (before) vs [y+1, y+band] (after) at column x. */
function bandDeltaCol(img: RgbaImage, x: number, y: number, band: number): number {
  let a = 0,
    b = 0,
    na = 0,
    nb = 0;
  for (let k = 1; k <= band; k++) {
    if (y - k >= 0) {
      a += lumaAt(img, x, y - k);
      na++;
    }
    if (y + k < img.height) {
      b += lumaAt(img, x, y + k);
      nb++;
    }
  }
  if (na === 0 || nb === 0) return 0;
  return Math.abs(a / na - b / nb);
}

/** Mean luma of a horizontal band [x-band, x-1] vs [x+1, x+band] at row y. */
function bandDeltaRow(img: RgbaImage, x: number, y: number, band: number): number {
  let a = 0,
    b = 0,
    na = 0,
    nb = 0;
  for (let k = 1; k <= band; k++) {
    if (x - k >= 0) {
      a += lumaAt(img, x - k, y);
      na++;
    }
    if (x + k < img.width) {
      b += lumaAt(img, x + k, y);
      nb++;
    }
  }
  if (na === 0 || nb === 0) return 0;
  return Math.abs(a / na - b / nb);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Trace the strongest boundary through a region. Returns a polyline (one point per
 * scan line) plus the per-point transition strength — a monotonic high-contrast
 * edge traces cleanly with high confidence; a weak/ambiguous one self-flags low so
 * the gate rejects it.
 */
export function traceEdge(img: RgbaImage, opts: TraceOptions): TracedEdge {
  const r = opts.region;
  const left = clamp(Math.round(r.left), 0, img.width - 1);
  const right = clamp(Math.round(r.right), 0, img.width - 1);
  const top = clamp(Math.round(r.top), 0, img.height - 1);
  const bottom = clamp(Math.round(r.bottom), 0, img.height - 1);
  const samples = Math.max(2, opts.samples ?? 24);
  const polyline: Polyline = [];
  const confidences: number[] = [];

  if (opts.orientation === 'horizontal-edge') {
    const band = opts.band ?? Math.max(3, Math.round((bottom - top) / 20));
    for (let i = 0; i < samples; i++) {
      const x = Math.round(left + ((i + 0.5) / samples) * (right - left));
      let bestY = -1,
        best = -1;
      for (let y = top + band; y <= bottom - band; y++) {
        const d = bandDeltaCol(img, x, y, band);
        if (d > best) {
          best = d;
          bestY = y;
        }
      }
      if (bestY < 0) continue;
      polyline.push({ x, y: bestY });
      confidences.push(Math.round(best));
    }
  } else {
    const band = opts.band ?? Math.max(3, Math.round((right - left) / 20));
    for (let i = 0; i < samples; i++) {
      const y = Math.round(top + ((i + 0.5) / samples) * (bottom - top));
      let bestX = -1,
        best = -1;
      for (let x = left + band; x <= right - band; x++) {
        const d = bandDeltaRow(img, x, y, band);
        if (d > best) {
          best = d;
          bestX = x;
        }
      }
      if (bestX < 0) continue;
      polyline.push({ x: bestX, y });
      confidences.push(Math.round(best));
    }
  }

  const meanConfidence = confidences.length
    ? confidences.reduce((s, v) => s + v, 0) / confidences.length
    : 0;
  return { polyline, confidences, meanConfidence };
}

/** Convenience: the traced edge as a resolver anchor primitive. */
export function edgeAnchor(edge: TracedEdge): { kind: 'polyline'; polyline: Point[] } {
  return { kind: 'polyline', polyline: edge.polyline };
}
