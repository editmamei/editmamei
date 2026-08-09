/**
 * Shared box geometry for the detectors — IoU, greedy NMS, and the
 * resize-to-CHW preprocessing skeleton. Both Ultraface and D-FINE need these;
 * keeping one copy avoids the drift a verbatim duplicate invites.
 */
import type { DecodedImage } from './runtime.js';

export type Box = [number, number, number, number];

/** Intersection-over-union of two [x1,y1,x2,y2] boxes. */
export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return inter / (ua + 1e-9);
}

/**
 * Canonical "which instance" spatial/size picks, shared by every instance
 * picker in the codebase (grounding-anchors' `Pick`, mesh-face's `pickFace`,
 * select-subject-instance's `resolveInstance`) so "leftmost" resolves to the
 * SAME candidate everywhere. leftmost/rightmost/topmost/bottommost sort by box
 * CENTER (not edge); largest/smallest by area. Confidence/score-based picks
 * ('best', 'confidence') and numeric-index picks are NOT part of this
 * convention — each caller has its own tie-break semantics for those and
 * handles them locally.
 */
export type SpatialPick =
  'leftmost' | 'rightmost' | 'topmost' | 'bottommost' | 'largest' | 'smallest';

const cx = (b: Box): number => (b[0] + b[2]) / 2;
const cy = (b: Box): number => (b[1] + b[3]) / 2;
const boxArea = (b: Box): number => (b[2] - b[0]) * (b[3] - b[1]);

/** Order candidates by `pick` (a copy; does not mutate `items`). */
export function orderBySpatialPick<T extends { bbox: Box }>(items: T[], pick: SpatialPick): T[] {
  const cmp: Record<SpatialPick, (a: T, b: T) => number> = {
    leftmost: (a, b) => cx(a.bbox) - cx(b.bbox),
    rightmost: (a, b) => cx(b.bbox) - cx(a.bbox),
    topmost: (a, b) => cy(a.bbox) - cy(b.bbox),
    bottommost: (a, b) => cy(b.bbox) - cy(a.bbox),
    largest: (a, b) => boxArea(b.bbox) - boxArea(a.bbox),
    smallest: (a, b) => boxArea(a.bbox) - boxArea(b.bbox),
  };
  return [...items].sort(cmp[pick]);
}

/**
 * Greedy non-max suppression. `items` must already be sorted by descending
 * confidence. `sameGroup` (optional) restricts suppression to items in the same
 * class — pass it for class-aware NMS (objects), omit for class-free (faces).
 */
export function greedyNms<T extends { bbox: Box }>(
  items: T[],
  iouThreshold: number,
  sameGroup?: (a: T, b: T) => boolean
): T[] {
  const keep: T[] = [];
  for (const item of items) {
    const overlaps = keep.some(
      (k) => (!sameGroup || sameGroup(k, item)) && iou(k.bbox, item.bbox) >= iouThreshold
    );
    if (!overlaps) keep.push(item);
  }
  return keep;
}

/**
 * Nearest-neighbour resize of an RGBA image to `outW`×`outH`, emitted as a
 * planar CHW float32 tensor with `normalize` applied per channel value. The two
 * detectors differ only in target size and the normalize formula.
 */
export function resizeToCHW(
  img: DecodedImage,
  outW: number,
  outH: number,
  normalize: (v: number) => number
): Float32Array {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(3 * outH * outW);
  const plane = outH * outW;
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / outW));
      const si = (sy * w + sx) * 4;
      const di = y * outW + x;
      out[di] = normalize(data[si]);
      out[plane + di] = normalize(data[si + 1]);
      out[2 * plane + di] = normalize(data[si + 2]);
    }
  }
  return out;
}
