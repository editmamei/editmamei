/**
 * Zoomed review crop — stage 2 of the two-stage spatial-grounding verification.
 *
 * After the internal geometric gate (stage 1) passes a resolved placement, this
 * renders a TIGHT crop around it with a marker, for the LLM to CONCUR or STEER
 * (nudge direction), never to read a coordinate. Relative judgment on a tight
 * crop is reliable where absolute readback is not (report E6).
 *
 * Design rule baked in from E6: a POINT placement is drawn as a HOLLOW RING (the
 * feature shows through the hole; "on target" = the feature centered in the ring)
 * — a solid dot let a symmetric near-hit read as a micro-offset. Curves/regions
 * are stroked as an outline in the same marker colour.
 *
 * Pure pixel arithmetic over a decoded RGBA image — no Photoshop, no encode (a
 * thin caller JPEG-encodes the result for the LLM), so it unit-tests on a
 * synthetic buffer. Document pixels throughout.
 */

import { type Point, type Polyline, boundsOf } from './grounding-geometry.js';
import { drawRing, fillDisc, type RGB } from './overlay.js';

/** A decoded RGBA image (jpeg-js decode output / detection DecodedImage shape). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type ReviewPlacement =
  | { kind: 'point'; point: Point }
  | { kind: 'curve'; curve: Polyline }
  | { kind: 'region'; polygon: Polyline };

export interface ReviewCropOptions {
  /** Context padding (px) around the placement bbox (default 120). */
  padding?: number;
  /** Minimum half-window so a bare point still gets real context (default 140). */
  minHalfWindow?: number;
  /** Cap on half-window so a huge placement doesn't blow up the crop (default 600). */
  maxHalfWindow?: number;
  /** Marker RGB (default the validated green). */
  markerColor?: [number, number, number];
  /** Point ring radius / thickness (default 13 / 2). */
  ringRadius?: number;
  ringThickness?: number;
  /** Curve/region stroke thickness (default 2). */
  strokeThickness?: number;
}

export interface ReviewCrop {
  image: RgbaImage;
  /** Source-pixel coordinate of the crop's top-left, for mapping back. */
  origin: Point;
  /** Crop side length (square). */
  size: number;
}

/** Thick polyline by sampling each segment at ~1px and stamping a disc. */
function drawPolyline(
  img: RgbaImage,
  pts: Polyline,
  thick: number,
  color: RGB,
  closed = false
): void {
  const r = Math.max(0, thick - 1);
  const seq = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i],
      b = seq[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      fillDisc(img, a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), r, color);
    }
  }
}

function placementBBox(p: ReviewPlacement): { center: Point; extent: number } {
  const b =
    p.kind === 'point'
      ? { left: p.point.x, top: p.point.y, right: p.point.x, bottom: p.point.y }
      : boundsOf(p.kind === 'curve' ? p.curve : p.polygon);
  return {
    center: { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 },
    extent: Math.max((b.right - b.left) / 2, (b.bottom - b.top) / 2),
  };
}

/**
 * Render a tight, marker-annotated review crop around a resolved placement.
 * Returns the decoded crop + its source origin (a caller JPEG-encodes it).
 */
export function renderReviewCrop(
  img: RgbaImage,
  placement: ReviewPlacement,
  opts: ReviewCropOptions = {}
): ReviewCrop {
  const padding = opts.padding ?? 120;
  const minHalf = opts.minHalfWindow ?? 140;
  const maxHalf = opts.maxHalfWindow ?? 600;
  const color = opts.markerColor ?? [40, 240, 90];

  const { center, extent } = placementBBox(placement);
  const half = Math.min(maxHalf, Math.max(minHalf, Math.round(extent + padding)));
  const size = 2 * half + 1;
  const ox = Math.round(center.x) - half;
  const oy = Math.round(center.y) - half;

  // copy the source window (out-of-source = opaque black)
  const out: RgbaImage = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = ox + x,
        sy = oy + y;
      const di = (y * size + x) * 4;
      out.data[di + 3] = 255;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      const si = (sy * img.width + sx) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
    }
  }

  // draw the marker in crop coordinates (source → crop = subtract origin)
  const toCrop = (p: Point): Point => ({ x: p.x - ox, y: p.y - oy });
  if (placement.kind === 'point') {
    const p = toCrop(placement.point);
    drawRing(out, p.x, p.y, opts.ringRadius ?? 13, opts.ringThickness ?? 2, color);
  } else if (placement.kind === 'curve') {
    drawPolyline(out, placement.curve.map(toCrop), opts.strokeThickness ?? 2, color);
  } else {
    drawPolyline(out, placement.polygon.map(toCrop), opts.strokeThickness ?? 2, color, true);
  }

  return { image: out, origin: { x: ox, y: oy }, size };
}
