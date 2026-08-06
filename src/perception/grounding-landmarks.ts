/**
 * Landmark anchor producer — bridges the Pro face mesh to the resolver's anchor
 * primitives, the missing piece for the "line under the eyes" class (Phase 4
 * of the spatial-grounding redesign).
 *
 * A `landmark` anchor names a facial feature; this localizes it against a
 * detected face's mesh (`DetectedFace.features.points`, already document pixels
 * via mapDetectionToDoc, and already EYE-CORRECTED by the landmark client) to a
 * resolver primitive:
 *   - a feature CURVE (eye-lower lid, eye ring, lip contour) → `polyline`, the
 *     source an `offset-curve` parallels — e.g. the lower-lid arc offset DOWN is
 *     the under-eye line;
 *   - a single named POINT (nose tip, chin, between-eyes) → `point`, usable as a
 *     midpoint / offset / centroid anchor.
 *
 * The model picks the feature by NAME; it never emits a coordinate. Coordinates
 * come from the corrected mesh. Unknown features return null (the caller lists
 * the valid names). Pure — no PS, no ONNX, no I/O.
 */
import type { DetectionResult } from '../detection/detection-client.js';
import { LANDMARK_GROUPS, LANDMARK_ANCHORS, LANDMARK_COUNT } from '../detection/landmark-spec.js';
import type { Primitive } from './grounding-resolver.js';
import type { Point } from './grounding-geometry.js';

/**
 * Canonical MediaPipe lower-lid arcs (outer→inner corner) — the first 9 indices
 * of each eye ring in LANDMARK_GROUPS, isolated here as an OPEN curve so
 * `offset-curve` down produces a clean under-eye line (the full ring would offset
 * the upper lid too). Kept in the grounding layer, not landmark-spec.ts, so
 * adding a derived feature doesn't grow the SSOT group set (which drives preview
 * colouring + tests).
 */
const LEFT_EYE_LOWER = [263, 249, 390, 373, 374, 380, 381, 382, 362] as const;
const RIGHT_EYE_LOWER = [33, 7, 163, 144, 145, 153, 154, 155, 133] as const;

type FeatureSpec = { as: 'polyline'; indices: readonly number[] } | { as: 'point'; index: number };

/**
 * The named features a `landmark` anchor can request. Curves are for `along` /
 * `offset-curve`; points are for `midpoint` / `centroid` / `offset`. Extend by
 * adding an entry — no other change needed.
 */
const LANDMARK_FEATURES: Record<string, FeatureSpec> = {
  // lower-lid arcs — the under-eye offset-curve source (the headline case)
  left_eye_lower: { as: 'polyline', indices: LEFT_EYE_LOWER },
  right_eye_lower: { as: 'polyline', indices: RIGHT_EYE_LOWER },
  // full eye rings — a natural `frac-of:<eye>:h` reference for the offset distance
  left_eye: { as: 'polyline', indices: LANDMARK_GROUPS.leftEye },
  right_eye: { as: 'polyline', indices: LANDMARK_GROUPS.rightEye },
  // lip contour — stroke `along` the lips
  lips_outer: { as: 'polyline', indices: LANDMARK_GROUPS.lipsOuter },
  // single-point anchors
  nose_tip: { as: 'point', index: LANDMARK_ANCHORS.noseTip },
  chin: { as: 'point', index: LANDMARK_ANCHORS.chin },
  between_eyes: { as: 'point', index: LANDMARK_ANCHORS.betweenEyes },
  upper_lip_top: { as: 'point', index: LANDMARK_ANCHORS.upperLipTop },
  lower_lip_bottom: { as: 'point', index: LANDMARK_ANCHORS.lowerLipBottom },
};

/** The valid `feature` names (for schema docs + error messages). */
export const LANDMARK_FEATURE_NAMES = Object.keys(LANDMARK_FEATURES);

/** Whether `feature` is a known landmark feature name. */
export function isLandmarkFeature(feature: string): boolean {
  return feature in LANDMARK_FEATURES;
}

export interface LandmarkSelector {
  /** A LANDMARK_FEATURE_NAMES entry (e.g. 'left_eye_lower'). */
  feature: string;
  /** Which detected face (0 = most-confident, the detection order). */
  face?: number;
}

/**
 * Localize a landmark selector to a document-pixel primitive, or null when the
 * face / mesh / feature is unavailable (the caller surfaces a missing anchor).
 */
export function landmarkAnchor(det: DetectionResult, sel: LandmarkSelector): Primitive | null {
  const spec = LANDMARK_FEATURES[sel.feature];
  if (!spec) return null; // unknown feature name
  const meshed = (det.faces ?? []).filter(
    (f) => f.features && f.features.points.length >= LANDMARK_COUNT
  );
  const face = meshed[sel.face ?? 0];
  if (!face || !face.features) return null;
  const pts = face.features.points;

  if (spec.as === 'point') {
    const p = pts[spec.index];
    return p ? { kind: 'point', point: { x: p.x, y: p.y } } : null;
  }
  const polyline: Point[] = [];
  for (const i of spec.indices) {
    const p = pts[i];
    if (p) polyline.push({ x: p.x, y: p.y });
  }
  return polyline.length >= 2 ? { kind: 'polyline', polyline } : null;
}
