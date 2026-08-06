/**
 * Face-feature geometry — turn the 468-point mesh into SELECTION PLANS.
 *
 * A "feature" (eyes, lips, teeth, skin, …) resolves to an ordered list of polygon
 * ops ({ points, op }) that the polygon-select script applies in sequence
 * (replace → add/subtract). This is the bridge from the Pro mesh to a real,
 * loadable Photoshop selection — the spatial analog of how the adjustment tools
 * encode the right descriptor. Pure + unit-tested; no PS, no I/O.
 *
 * Contour features (eyes, lips, oval) use the canonical MediaPipe rings (ordered →
 * a clean polygon). Point-cloud features (brows, nose) use a convex hull (the
 * ordered ring isn't a simple polygon). Derived features (under-eye, cheeks) are
 * SYNTHESIZED from trusted anchors — lower confidence, documented as approximate.
 *
 * Handedness follows MediaPipe (subject-relative): `left_eye` is the subject's
 * own left eye. The annotated preview is the ground truth.
 */
import type { LandmarkPoint } from './detection-client.js';
import { LANDMARK_GROUPS } from './landmark-spec.js';

/** A 2D point in document pixels. */
export type Pt = [number, number];

/** How a polygon combines with the running selection. */
export type SelOp = 'replace' | 'add' | 'subtract';

/** One polygon + how it combines. */
export interface SelPoly {
  points: Pt[];
  op: SelOp;
}

/** An ordered selection plan: apply each poly in order. */
export type SelectionPlan = SelPoly[];

/** The selectable facial features. */
export const FACE_FEATURES = [
  'face',
  'skin',
  'eyes',
  'left_eye',
  'right_eye',
  'brows',
  'left_brow',
  'right_brow',
  'lips',
  'teeth',
  'nose',
  'under_eye',
  'cheeks',
] as const;
export type FaceFeature = (typeof FACE_FEATURES)[number];

// ---------- primitives ----------

/** Map spec indices → an ordered polygon (closed by the caller / PS). */
function ring(points: LandmarkPoint[], indices: readonly number[]): Pt[] {
  const out: Pt[] = [];
  for (const i of indices) {
    const p = points[i];
    if (p) out.push([p.x, p.y]);
  }
  return out;
}

/** Andrew's monotone-chain convex hull (for point-cloud features). */
export function convexHull(pts: Pt[]): Pt[] {
  const uniq = Array.from(new Set(pts.map((p) => `${p[0]},${p[1]}`))).map(
    (s) => s.split(',').map(Number) as Pt
  );
  if (uniq.length <= 2) return uniq;
  uniq.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Bounding box of a point set: [minX, minY, maxX, maxY]. */
function bbox(pts: Pt[]): [number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * An under-eye band below an eye ring: from the eye's lower edge down by
 * ~`drop`× the eye height. A quad spanning the eye's width. Approximate.
 */
function underEyeBand(eyeRing: Pt[], drop = 1.1): Pt[] | null {
  if (eyeRing.length < 3) return null;
  const [minX, minY, maxX, maxY] = bbox(eyeRing);
  const h = maxY - minY;
  if (h <= 0) return null;
  const top = maxY + h * 0.15; // start just under the lid
  const bottom = maxY + h * (0.15 + drop);
  return [
    [minX, top],
    [maxX, top],
    [maxX, bottom],
    [minX, bottom],
  ];
}

/**
 * A cheek patch as the convex hull of trusted anchors on one side: the eye's
 * lower-outer corner, the nose ala, and the mouth's outer corner — the triangle
 * of skin between eye, nose, and mouth. Approximate (no dedicated cheek ring in
 * the 468 mesh).
 */
function cheekPatch(eyeRing: Pt[], noseAla: Pt | null, mouthCorner: Pt | null): Pt[] | null {
  if (eyeRing.length < 3 || !noseAla || !mouthCorner) return null;
  const [minX, , maxX, maxY] = bbox(eyeRing);
  // Outer corner = the eye x furthest from the nose; pick by which side the ala is.
  const outerX = Math.abs(minX - noseAla[0]) > Math.abs(maxX - noseAla[0]) ? minX : maxX;
  const eyeOuterLow: Pt = [outerX, maxY];
  return convexHull([eyeOuterLow, noseAla, mouthCorner, [noseAla[0], mouthCorner[1]]]);
}

// ---------- feature → plan ----------

/** Convenience accessors for the rings used in multiple plans. */
function rings(points: LandmarkPoint[]): Record<string, Pt[]> {
  return {
    faceOval: ring(points, LANDMARK_GROUPS.faceOval),
    leftEye: ring(points, LANDMARK_GROUPS.leftEye),
    rightEye: ring(points, LANDMARK_GROUPS.rightEye),
    leftBrow: convexHull(ring(points, LANDMARK_GROUPS.leftEyebrow)),
    rightBrow: convexHull(ring(points, LANDMARK_GROUPS.rightEyebrow)),
    lipsOuter: ring(points, LANDMARK_GROUPS.lipsOuter),
    lipsInner: ring(points, LANDMARK_GROUPS.lipsInner),
    nose: convexHull(ring(points, LANDMARK_GROUPS.nose)),
  };
}

/** A polygon is usable only if it has ≥3 points. */
function ok(p: Pt[] | null | undefined): p is Pt[] {
  return Array.isArray(p) && p.length >= 3;
}

/**
 * Build the selection plan for `feature` from a face's mesh points (document px).
 * Returns null when the needed landmarks are missing (→ honest absence). The
 * first poly is always `replace`; the rest add/subtract.
 */
export function buildFeaturePlan(
  points: LandmarkPoint[],
  feature: FaceFeature
): SelectionPlan | null {
  const r = rings(points);
  const noseAla = points[129] ?? points[358] ?? null; // an ala point for cheek geometry
  const leftMouthCorner = points[61] ? ([points[61].x, points[61].y] as Pt) : null;
  const rightMouthCorner = points[291] ? ([points[291].x, points[291].y] as Pt) : null;
  const ala: Pt | null = noseAla ? [noseAla.x, noseAla.y] : null;

  switch (feature) {
    case 'face':
      return ok(r.faceOval) ? [{ points: r.faceOval, op: 'replace' }] : null;
    case 'skin': {
      if (!ok(r.faceOval)) return null;
      const plan: SelectionPlan = [{ points: r.faceOval, op: 'replace' }];
      for (const hole of [r.leftEye, r.rightEye, r.leftBrow, r.rightBrow, r.lipsOuter]) {
        if (ok(hole)) plan.push({ points: hole, op: 'subtract' });
      }
      return plan;
    }
    case 'left_eye':
      return ok(r.leftEye) ? [{ points: r.leftEye, op: 'replace' }] : null;
    case 'right_eye':
      return ok(r.rightEye) ? [{ points: r.rightEye, op: 'replace' }] : null;
    case 'eyes': {
      const plan: SelectionPlan = [];
      if (ok(r.leftEye)) plan.push({ points: r.leftEye, op: 'replace' });
      if (ok(r.rightEye)) plan.push({ points: r.rightEye, op: plan.length ? 'add' : 'replace' });
      return plan.length ? plan : null;
    }
    case 'left_brow':
      return ok(r.leftBrow) ? [{ points: r.leftBrow, op: 'replace' }] : null;
    case 'right_brow':
      return ok(r.rightBrow) ? [{ points: r.rightBrow, op: 'replace' }] : null;
    case 'brows': {
      const plan: SelectionPlan = [];
      if (ok(r.leftBrow)) plan.push({ points: r.leftBrow, op: 'replace' });
      if (ok(r.rightBrow)) plan.push({ points: r.rightBrow, op: plan.length ? 'add' : 'replace' });
      return plan.length ? plan : null;
    }
    case 'lips': {
      if (!ok(r.lipsOuter)) return null;
      const plan: SelectionPlan = [{ points: r.lipsOuter, op: 'replace' }];
      if (ok(r.lipsInner)) plan.push({ points: r.lipsInner, op: 'subtract' }); // lip flesh, not the opening
      return plan;
    }
    case 'teeth':
      return ok(r.lipsInner) ? [{ points: r.lipsInner, op: 'replace' }] : null; // mouth opening
    case 'nose':
      return ok(r.nose) ? [{ points: r.nose, op: 'replace' }] : null;
    case 'under_eye': {
      const plan: SelectionPlan = [];
      const lb = underEyeBand(r.leftEye);
      const rb = underEyeBand(r.rightEye);
      if (ok(lb)) plan.push({ points: lb, op: 'replace' });
      if (ok(rb)) plan.push({ points: rb, op: plan.length ? 'add' : 'replace' });
      return plan.length ? plan : null;
    }
    case 'cheeks': {
      const plan: SelectionPlan = [];
      const lc = cheekPatch(r.leftEye, ala, leftMouthCorner);
      const rc = cheekPatch(r.rightEye, ala, rightMouthCorner);
      if (ok(lc)) plan.push({ points: lc, op: 'replace' });
      if (ok(rc)) plan.push({ points: rc, op: plan.length ? 'add' : 'replace' });
      return plan.length ? plan : null;
    }
    default:
      return null;
  }
}
