/**
 * MediaPipe FaceMesh 468-point landmark spec — the named-group index map that is
 * the single source of truth for the `features` shape the Pro landmark backend
 * populates on `DetectedFace.features`.
 *
 * The model (`models/pro/face_mesh_468.onnx`, Apache-2.0, MediaPipe via the
 * Heliosoph ONNX conversion) emits 468 (x, y, z) points per face, normalized to
 * [0, 1] of its 192×192 input crop. This module does NOT touch coordinates — it
 * only declares which of the 468 indices form each anatomical feature, so the
 * detector can slice the flat point array into labelled groups.
 *
 * The index sets are the canonical MediaPipe `FACEMESH_*` connection vertex sets
 * (stable across MediaPipe versions). They are ORDERED as rings where MediaPipe
 * orders them (eye/lip/oval contours), so a consumer can draw a closed polyline;
 * the perception tool currently plots points (order-independent) to keep the
 * verification overlay robust.
 *
 * **Handedness:** `left`/`right` follow MediaPipe's convention — the SUBJECT's
 * own left/right, which is mirrored from the viewer. `leftEye` is the subject's
 * left eye (viewer's right). The annotated preview is the ground truth when it
 * matters; downstream masking is handedness-agnostic (it masks "an eye", not "the
 * viewer's-left eye").
 *
 * **No iris.** This is the 468-point (non-attention) mesh: eye/lip/brow CONTOURS,
 * jaw, nose, face oval — but not the +10 iris ring (478, "with attention"). Iris
 * centres are approximated from the eye-contour centroid (`deriveCenter`). The
 * attention model is a clean follow-up.
 */

/** Total landmark count emitted by the 468-point mesh. */
export const LANDMARK_COUNT = 468;

/** The model's square input edge (px); landmarks are normalized to [0,1] of it. */
export const MODEL_INPUT_SIZE = 192;

/**
 * Canonical MediaPipe `FACEMESH_*` vertex sets. Each is a list of 0-based indices
 * into the 468-point array. Contour groups are ordered as rings.
 */
export const LANDMARK_GROUPS = {
  /** Jaw + cheek + forehead silhouette (closed ring, 36 pts). */
  faceOval: [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
    148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
  ],
  /** Subject's-left eye contour ring (16 pts). */
  leftEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  /** Subject's-right eye contour ring (16 pts). */
  rightEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  /** Subject's-left eyebrow (10 pts). */
  leftEyebrow: [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
  /** Subject's-right eyebrow (10 pts). */
  rightEyebrow: [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
  /** Outer lip contour ring (20 pts). */
  lipsOuter: [
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
  ],
  /** Inner lip contour ring (20 pts) — bounds the mouth opening / teeth region. */
  lipsInner: [
    78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
  ],
  /** Nose bridge → tip → columella → nostrils → ala (16 pts). */
  nose: [168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 97, 326, 327, 129, 358],
} as const;

/** A named landmark group key. */
export type LandmarkGroupKey = keyof typeof LANDMARK_GROUPS;

/** All group keys in a stable order (drives iteration + preview colouring). */
export const LANDMARK_GROUP_KEYS = Object.keys(LANDMARK_GROUPS) as LandmarkGroupKey[];

/**
 * Single named anchor points useful for retouch targeting. Each is one index.
 * (Eye centres are NOT here — they're derived from the eye rings via
 * `deriveCenter` since the 468-point mesh has no iris point.)
 */
export const LANDMARK_ANCHORS = {
  noseTip: 1,
  chin: 152,
  foreheadTop: 10,
  betweenEyes: 168,
  upperLipTop: 0,
  lowerLipBottom: 17,
} as const;

/** A named anchor key. */
export type LandmarkAnchorKey = keyof typeof LANDMARK_ANCHORS;

export const LANDMARK_ANCHOR_KEYS = Object.keys(LANDMARK_ANCHORS) as LandmarkAnchorKey[];
