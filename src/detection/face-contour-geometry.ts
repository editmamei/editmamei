/**
 * Face-contour geometry — turn the 468-point mesh into smooth BÉZIER PATHS for
 * the brush family (dodge/burn along the face's real geometry). The selection
 * side ships in face-feature-geometry.ts; this is the *path* side (L2.1).
 *
 * A "contour" (jawline, cheekbone, nose-bridge, under-eye) resolves to an ordered
 * polyline of mesh points, smoothed to tangent-continuous bézier anchors
 * (`{x, y, in, out}`) via Catmull-Rom → Bézier — exactly the anchor shape
 * `ps_apply_brush_stroke` consumes. The model never emits a coordinate;
 * the engine produces the path from the mesh. Pure + unit-tested; no PS, no I/O.
 *
 * Reliable contours (jawline, nose_bridge, under_eye) come straight from canonical
 * MediaPipe index sequences / the eye rings. Synthesized contours (cheekbones) are
 * built from trusted anchors — documented approximate, like the selection side's
 * under-eye/cheeks.
 *
 * Handedness follows MediaPipe (subject-relative): `cheekbone_left` is on the
 * subject's own left cheek.
 */
import type { LandmarkPoint } from './detection-client.js';
import { LANDMARK_GROUPS } from './landmark-spec.js';

/** A bézier anchor for a brush path: corner `{x,y}` or smooth with tangent handles. */
export interface PathAnchor {
  x: number;
  y: number;
  in?: [number, number];
  out?: [number, number];
}

/** The selectable face contours (stroke paths). */
export const FACE_CONTOURS = [
  'jawline',
  'nose_bridge',
  'cheekbone_left',
  'cheekbone_right',
  'cheekbones',
  'under_eye_left',
  'under_eye_right',
  'under_eyes',
] as const;
export type FaceContour = (typeof FACE_CONTOURS)[number];

/**
 * Canonical MediaPipe jaw silhouette, ordered subject's-right ear → chin (152) →
 * subject's-left ear. A real contour for jaw dodge/burn definition.
 */
const JAWLINE_IDX = [
  234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 454,
] as const;

/** Nose bridge top (between the brows) → tip, ordered down the ridge. */
const NOSE_BRIDGE_IDX = [168, 6, 197, 195, 5, 4, 1] as const;

/** An ala point per side (for cheekbone synthesis). */
const ALA_LEFT = 358; // subject's-left nostril side
const ALA_RIGHT = 129; // subject's-right

type Pt = [number, number];

/** Index list → ordered polyline, dropping any out-of-range index. */
function poly(points: LandmarkPoint[], idx: readonly number[]): Pt[] {
  const out: Pt[] = [];
  for (const i of idx) {
    const p = points[i];
    if (p) out.push([p.x, p.y]);
  }
  return out;
}

/** Centroid y of a point set (for lower-lid / cheek-height splits). */
function midY(pts: Pt[]): number {
  if (pts.length === 0) return 0;
  return pts.reduce((s, p) => s + p[1], 0) / pts.length;
}

/**
 * The lower-lid arc of an eye ring: the ring points below the eye's centre y,
 * kept in ring order (the eye rings are ordered, so the sub-run is contiguous)
 * and then sorted left→right so the stroke traces cleanly.
 */
function lowerLid(points: LandmarkPoint[], idx: readonly number[]): Pt[] {
  const ring = poly(points, idx);
  if (ring.length < 3) return [];
  const cy = midY(ring);
  const lower = ring.filter((p) => p[1] >= cy);
  lower.sort((a, b) => a[0] - b[0]);
  return lower;
}

/**
 * A synthesized cheekbone sweep on one side: from the apple of the cheek (below
 * the eye, beside the nose) up-and-out toward the temple. Built from trusted
 * anchors — the ala, the eye's lower edge, and the eye's outer corner — so it
 * follows the zygomatic diagonal without a dedicated cheek ring. Approximate.
 */
function cheekbone(points: LandmarkPoint[], eyeIdx: readonly number[], alaIdx: number): Pt[] {
  const ring = poly(points, eyeIdx);
  if (ring.length < 3) return [];
  const ala = points[alaIdx];
  if (!ala) return [];
  // Eye bbox to find the outer corner + the lower edge.
  let minX = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Outer corner = the eye x furthest from the nose (the ala x).
  const outerX = Math.abs(minX - ala.x) > Math.abs(maxX - ala.x) ? minX : maxX;
  const cy = midY(ring);
  // apple: below the inner eye, between the eye-bottom and the ala height.
  const innerX = outerX === minX ? maxX : minX;
  const apple: Pt = [(innerX + ala.x) / 2, (maxY + ala.y) / 2];
  const mid: Pt = [(apple[0] + outerX) / 2, (apple[1] + cy) / 2];
  const temple: Pt = [outerX, cy]; // up toward the outer-eye / temple
  return [apple, mid, temple];
}

/**
 * Catmull-Rom → Bézier: convert an ordered polyline into tangent-continuous
 * bézier anchors. Each interior anchor's handles are tangent to the curve
 * (`out` toward the next point, `in` toward the previous) at 1/6 of the
 * neighbour span — the standard uniform Catmull-Rom-to-Bézier conversion, which
 * is exactly the tangent-handle placement apply_brush_stroke wants. Endpoints
 * get one-sided handles (corner-like). A 2-point line stays two corners.
 */
export function catmullRomAnchors(line: Pt[]): PathAnchor[] {
  const n = line.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: line[0][0], y: line[0][1] }];
  if (n === 2) {
    return [
      { x: line[0][0], y: line[0][1] },
      { x: line[1][0], y: line[1][1] },
    ];
  }
  const anchors: PathAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = line[i];
    const prev = line[i - 1] ?? line[i];
    const next = line[i + 1] ?? line[i];
    // Tangent ∝ (next - prev); handles at 1/6 of that span (uniform CR→Bézier).
    const tx = (next[0] - prev[0]) / 6;
    const ty = (next[1] - prev[1]) / 6;
    const anchor: PathAnchor = { x, y };
    if (i > 0) anchor.in = [x - tx, y - ty];
    if (i < n - 1) anchor.out = [x + tx, y + ty];
    anchors.push(anchor);
  }
  return anchors;
}

/** Round an anchor's coords + handles to integers (document pixels). */
function roundAnchor(a: PathAnchor): PathAnchor {
  const r: PathAnchor = { x: Math.round(a.x), y: Math.round(a.y) };
  if (a.in) r.in = [Math.round(a.in[0]), Math.round(a.in[1])];
  if (a.out) r.out = [Math.round(a.out[0]), Math.round(a.out[1])];
  return r;
}

/**
 * Build the smooth bézier anchor path for `contour` from a face's mesh points
 * (document px). Returns null when the landmarks are missing (→ honest absence).
 * `under_eyes` / `cheekbones` return a single combined stroke is NOT done — those
 * are two separate strokes, so callers stroke each side; here we return the
 * concatenation only for the single-side contours. For the combined names the
 * tool strokes both sides.
 */
export function buildContourAnchors(
  points: LandmarkPoint[],
  contour: FaceContour
): PathAnchor[] | null {
  const line = contourPolyline(points, contour);
  if (!line || line.length < 2) return null;
  return catmullRomAnchors(line).map(roundAnchor);
}

/** The raw ordered polyline for a SINGLE-side contour (null for combined names). */
function contourPolyline(points: LandmarkPoint[], contour: FaceContour): Pt[] | null {
  switch (contour) {
    case 'jawline':
      return orNull(poly(points, JAWLINE_IDX));
    case 'nose_bridge':
      return orNull(poly(points, NOSE_BRIDGE_IDX));
    case 'cheekbone_left':
      return orNull(cheekbone(points, LANDMARK_GROUPS.leftEye, ALA_LEFT));
    case 'cheekbone_right':
      return orNull(cheekbone(points, LANDMARK_GROUPS.rightEye, ALA_RIGHT));
    case 'under_eye_left':
      return orNull(lowerLid(points, LANDMARK_GROUPS.leftEye));
    case 'under_eye_right':
      return orNull(lowerLid(points, LANDMARK_GROUPS.rightEye));
    // Combined names have no single polyline — the tool strokes both sides.
    case 'cheekbones':
    case 'under_eyes':
      return null;
    default:
      return null;
  }
}

function orNull(p: Pt[]): Pt[] | null {
  return p.length >= 2 ? p : null;
}

/** The per-side contours a combined name expands to (for the stroke tool). */
export function contourSides(contour: FaceContour): FaceContour[] {
  if (contour === 'cheekbones') return ['cheekbone_left', 'cheekbone_right'];
  if (contour === 'under_eyes') return ['under_eye_left', 'under_eye_right'];
  return [contour];
}
