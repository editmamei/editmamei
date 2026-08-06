/**
 * Mesh eye-correction — refine the face mesh's EYES with classical CV, and carry
 * the eye-rigid features (eyebrows + nose) along.
 *
 * Why: the trained face mesh localizes the mouth/lips/oval well but can place the
 * EYES tens of pixels off (measured across faces, 2026-07). Classical CV, by
 * contrast, nails the pupil (a hard geometric feature). So we let the mesh be the
 * base, use a TIGHTLY-CONSTRAINED gradient eye-centre finder (Timm–Barth) to find
 * each true pupil in a small window around the mesh eye, and apply the 2-point
 * similarity that maps the mesh eyes onto the pupils — to the eyes, eyebrows, and
 * nose only. The mouth, lips, and face oval keep their (accurate) mesh positions.
 *
 * The finder is bounded to a fraction of the eye's own size, so an occlusion
 * (glasses) can't send it wandering — instead it hits the window edge, which we
 * surface as `lowConfidence` (glasses/occlusion may need manual edits).
 *
 * Pure over a decoded RGBA image; guards a bad/mismatched image → no-op.
 * Design: informed by a mesh-drift cross-check investigation.
 */
import type { DecodedImage } from './runtime.js';
import type { LandmarkPoint } from './detection-client.js';
import { LANDMARK_GROUPS, LANDMARK_COUNT } from './landmark-spec.js';

interface Pt2 {
  x: number;
  y: number;
}

/** Groups that move rigidly with the eyes (the upper/mid face). */
const EYE_RIGID_GROUPS = ['leftEye', 'rightEye', 'leftEyebrow', 'rightEyebrow', 'nose'] as const;
const EYE_RIGID_INDICES = new Set<number>();
for (const g of EYE_RIGID_GROUPS) for (const i of LANDMARK_GROUPS[g]) EYE_RIGID_INDICES.add(i);

export interface EyeCorrection {
  /** Pupil-vs-mesh drift the correction applied, per eye (px). */
  drift_left: number;
  drift_right: number;
  /**
   * A finder hit its search-window edge — the true eye was likely occluded
   * (glasses) and the correction may be unreliable. Surface as reduced
   * confidence: the feature may need manual edits.
   */
  low_confidence: boolean;
}

export interface CorrectionResult {
  /** Corrected mesh points (eyes/brows/nose moved; the rest unchanged). */
  points: LandmarkPoint[];
  /** null when correction was skipped (bad image / incomplete mesh). */
  correction: EyeCorrection | null;
}

const centroid = (pts: LandmarkPoint[]): Pt2 => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
const bbox = (pts: LandmarkPoint[]): { x0: number; y0: number; x1: number; y1: number } => ({
  x0: Math.min(...pts.map((p) => p.x)),
  y0: Math.min(...pts.map((p) => p.y)),
  x1: Math.max(...pts.map((p) => p.x)),
  y1: Math.max(...pts.map((p) => p.y)),
});
const dist = (a: Pt2, b: Pt2): number => Math.hypot(a.x - b.x, a.y - b.y);

interface ImgCtx {
  W: number;
  H: number;
  luma: (x: number, y: number) => number;
  clamp: (v: number, lo: number, hi: number) => number;
  blur: (x: number, y: number, r: number) => number;
}
function makeCtx(img: DecodedImage): ImgCtx {
  const { width: W, height: H, data } = img;
  const luma = (x: number, y: number): number => {
    const i = (y * W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const blur = (x: number, y: number, r: number): number => {
    let s = 0,
      n = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        s += luma(clamp(x + dx, 0, W - 1), clamp(y + dy, 0, H - 1));
        n++;
      }
    return s / n;
  };
  return { W, H, luma, clamp, blur };
}

/**
 * Gradient eye-centre (Timm–Barth) in a small window around the mesh eye — the
 * pupil is where displacement vectors best align with the iris-boundary gradients.
 * `atEdge` = the winning candidate sat at the window boundary (wanted to go
 * further → likely occluded).
 */
function findEyeCenter(
  ctx: ImgCtx,
  center: Pt2,
  ring: { x0: number; y0: number; x1: number; y1: number }
): { x: number; y: number; atEdge: boolean } {
  const { W, H, luma, clamp, blur } = ctx;
  const rw = ring.x1 - ring.x0,
    rh = ring.y1 - ring.y0;
  // The mesh reads HIGH (the true pupil is below), so the window reaches mostly
  // DOWNWARD (little upward, to stay clear of the eyebrow). Down-extent 2x the
  // ring height so a genuine large drift (~1.4x rh on the worst measured face)
  // sits COMFORTABLY inside and isn't false-flagged; a find pinned at the down/
  // side edge means the finder wanted to go further = occlusion.
  const x0 = clamp(Math.round(center.x - 0.55 * rw), 0, W - 1);
  const x1 = clamp(Math.round(center.x + 0.55 * rw), 0, W - 1);
  const y0 = clamp(Math.round(center.y - 0.5 * rh), 0, H - 1);
  const y1 = clamp(Math.round(center.y + 2.0 * rh), 0, H - 1);
  const ww = x1 - x0 + 1,
    wh = y1 - y0 + 1;
  if (ww < 5 || wh < 5) return { x: center.x, y: center.y, atEdge: false };
  const L = new Float32Array(ww * wh);
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) L[y * ww + x] = luma(x0 + x, y0 + y);
  const edges: { x: number; y: number; gx: number; gy: number }[] = [];
  const gg: { m: number; x: number; y: number; gx: number; gy: number }[] = [];
  let magSum = 0;
  for (let y = 1; y < wh - 1; y++)
    for (let x = 1; x < ww - 1; x++) {
      const gx = (L[y * ww + x + 1] - L[y * ww + x - 1]) / 2;
      const gy = (L[(y + 1) * ww + x] - L[(y - 1) * ww + x]) / 2;
      const m = Math.hypot(gx, gy);
      gg.push({ m, x, y, gx, gy });
      magSum += m;
    }
  const mean = magSum / (gg.length || 1);
  let v = 0;
  for (const g of gg) v += (g.m - mean) ** 2;
  const std = Math.sqrt(v / (gg.length || 1));
  const thr = mean + 0.3 * std;
  for (const g of gg) if (g.m > thr) edges.push({ x: g.x, y: g.y, gx: g.gx / g.m, gy: g.gy / g.m });
  let best = -Infinity,
    bx = Math.round(center.x - x0),
    by = Math.round(center.y - y0);
  for (let cy = 2; cy < wh - 2; cy += 2)
    for (let cx = 2; cx < ww - 2; cx += 2) {
      let s = 0;
      for (const e of edges) {
        const dx = e.x - cx,
          dy = e.y - cy,
          l = Math.hypot(dx, dy);
        if (l < 3) continue;
        const dot = (dx / l) * e.gx + (dy / l) * e.gy;
        if (dot > 0) s += dot * dot;
      }
      s *= 255 - blur(x0 + cx, y0 + cy, 3);
      if (s > best) {
        best = s;
        bx = cx;
        by = cy;
      }
    }
  // Only the down/side edges signal occlusion; a pupil slightly ABOVE the mesh
  // (small negative drift, near the top edge) is normal on an accurate mesh.
  const atEdge = bx <= 3 || bx >= ww - 4 || by >= wh - 4;
  return { x: x0 + bx, y: y0 + by, atEdge };
}

/** 2-point similarity mapping m1→t1, m2→t2. */
function similarity(m1: Pt2, m2: Pt2, t1: Pt2, t2: Pt2): (p: Pt2) => Pt2 {
  const dmx = m2.x - m1.x,
    dmy = m2.y - m1.y,
    dtx = t2.x - t1.x,
    dty = t2.y - t1.y;
  const s = Math.hypot(dtx, dty) / (Math.hypot(dmx, dmy) || 1);
  const th = Math.atan2(dty, dtx) - Math.atan2(dmy, dmx);
  const c = Math.cos(th) * s,
    sn = Math.sin(th) * s;
  return (p) => ({
    x: t1.x + c * (p.x - m1.x) - sn * (p.y - m1.y),
    y: t1.y + sn * (p.x - m1.x) + c * (p.y - m1.y),
  });
}

/**
 * Correct a face mesh's eyes (+ rigid brows/nose) to the classical-CV pupils.
 * Returns the corrected points; leaves the mesh unchanged and `correction: null`
 * when the mesh is incomplete or the image is bad/mismatched (safe no-op).
 */
export function correctMeshEyes(img: DecodedImage, points: LandmarkPoint[]): CorrectionResult {
  if (!points || points.length < LANDMARK_COUNT) return { points, correction: null };
  if (!img || !img.data || img.data.length < img.width * img.height * 4) {
    return { points, correction: null }; // degenerate / mismatched image
  }
  const ctx = makeCtx(img);
  const leftEye = LANDMARK_GROUPS.leftEye.map((i) => points[i]);
  const rightEye = LANDMARK_GROUPS.rightEye.map((i) => points[i]);
  const eyeLm = centroid(leftEye),
    eyeRm = centroid(rightEye);
  if (dist(eyeLm, eyeRm) < 4) return { points, correction: null }; // degenerate eye separation
  const eyeLc = findEyeCenter(ctx, eyeLm, bbox(leftEye));
  const eyeRc = findEyeCenter(ctx, eyeRm, bbox(rightEye));
  const T = similarity(eyeLm, eyeRm, eyeLc, eyeRc);
  const corrected = points.map((p, i) => (EYE_RIGID_INDICES.has(i) ? { ...T(p), z: p.z } : p));
  return {
    points: corrected,
    correction: {
      drift_left: Math.round(dist(eyeLc, eyeLm)),
      drift_right: Math.round(dist(eyeRc, eyeRm)),
      low_confidence: eyeLc.atEdge || eyeRc.atEdge,
    },
  };
}
