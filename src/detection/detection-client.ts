/**
 * DetectionClient — the seam to local, headless computer vision.
 *
 * Backed by onnxruntime-web (WASM) running two models in-process: Ultraface for
 * faces and D-FINE-S for COCO-80 objects. Both are LOCAL — the image never
 * leaves the machine (the privacy-max "AI sees via local CV" path). The Pro
 * module swaps in deeper models (precise face landmarks, etc.) behind this same
 * interface, so the portrait/scene handlers don't know which engine produced the
 * coordinates.
 *
 * Detection always runs on a Photoshop-EXPORTED JPEG, so results are in
 * EXPORT-image pixel space; `mapDetectionToDoc` lifts them to document pixels.
 * Coordinates carry explicit width/height end-to-end — the coordinate-frame
 * discipline that makes the numbers safe to hand a PS op.
 */
import { detectFaces } from './face-detector.js';
import { detectObjects } from './object-detector.js';
import type { DecodedImage } from './runtime.js';

/** [x1, y1, x2, y2] in the result's coordinate frame. */
export type BBox = [number, number, number, number];

/** One landmark point in the result's coordinate frame (`z` is relative depth). */
export interface LandmarkPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Pro-only precise face geometry. `points` is the full mesh in the result's
 * coordinate frame; anatomical groups/anchors are resolved by index against the
 * static spec (`landmark-spec.ts`) by consumers, so the data carried here stays
 * flat (no duplicated point objects to keep in sync, no double-scaling when
 * `mapDetectionToDoc` lifts to document pixels).
 */
export interface FaceFeatures {
  /** Every mesh point (e.g. 468 for the non-attention model), in frame order. */
  points: LandmarkPoint[];
  /** Model face-presence / quality score for this face (0–1). */
  score: number;
  /** Which landmark model produced this (e.g. 'facemesh-468'). */
  backend: string;
  /**
   * Present when classical-CV eye-correction ran (mesh-eye-correction.ts): the
   * mesh's eyes/brows/nose were snapped to the true pupils. `low_confidence`
   * signals a likely occlusion (glasses) that may need manual edits.
   */
  eyeCorrection?: {
    drift_left: number;
    drift_right: number;
    low_confidence: boolean;
  };
}

/**
 * One detected face. The Pro backend returns this same shape plus an optional
 * `features` object (mesh points) — a superset, not a different schema.
 */
export interface DetectedFace {
  bbox: BBox;
  /** 0–1; orchestration confidence-gates on this. */
  confidence: number;
  /** Pro-only: precise landmark geometry (the face mesh). */
  features?: FaceFeatures;
}

/** One detected COCO-80 object. */
export interface DetectedObject {
  /** COCO class name (e.g. 'person', 'dog', 'chair'). */
  label: string;
  /** COCO class index, 0–79. */
  class_id: number;
  bbox: BBox;
  /** 0–1. */
  confidence: number;
}

export interface DetectionResult {
  image: { width: number; height: number };
  /** Present when faces were requested. */
  faces?: DetectedFace[];
  /** Present when objects were requested. */
  objects?: DetectedObject[];
  /** Which engine produced each stream — e.g. `{ faces: 'ultraface', objects: 'dfine-s' }`. */
  backends: { faces?: string; objects?: string };
}

export interface DetectOptions {
  faces?: boolean;
  objects?: boolean;
  /** Face score gate (default 0.7). */
  faceThreshold?: number;
  /** Object score gate (default 0.4). */
  objectThreshold?: number;
  /** Cap on returned objects, highest-confidence first (default 50). */
  maxObjects?: number;
}

/** Backend-agnostic seam; the Pro deep models implement this too. */
export interface DetectionClient {
  /**
   * `decoded` is the export already decoded ONCE by the caller
   * (detectActiveDoc) — pass it through to whatever does the actual model inference
   * instead of re-decoding `imagePath`. Optional so existing fakes/implementers
   * with the 2-arg signature stay valid.
   */
  detect(imagePath: string, opts: DetectOptions, decoded?: DecodedImage): Promise<DetectionResult>;
}

/** CE backend: in-process onnxruntime-web running Ultraface + D-FINE-S. */
export class OnnxDetectionClient implements DetectionClient {
  async detect(
    imagePath: string,
    opts: DetectOptions,
    decoded?: DecodedImage
  ): Promise<DetectionResult> {
    const wantFaces = opts.faces ?? false;
    const wantObjects = opts.objects ?? false;

    // Run the requested models concurrently; they share the cached sessions AND
    // the same pre-decoded image (when supplied) — neither re-decodes the export.
    const [faceRes, objRes] = await Promise.all([
      wantFaces ? detectFaces(imagePath, opts.faceThreshold, decoded) : Promise.resolve(null),
      wantObjects
        ? detectObjects(
            imagePath,
            { threshold: opts.objectThreshold, maxObjects: opts.maxObjects },
            decoded
          )
        : Promise.resolve(null),
    ]);

    // Image dims come from whichever ran; both decode the same export.
    const dims = faceRes ?? objRes;
    const result: DetectionResult = {
      image: { width: dims?.width ?? 0, height: dims?.height ?? 0 },
      backends: {},
    };
    if (faceRes) {
      result.faces = faceRes.faces.map((f) => ({ bbox: f.bbox, confidence: f.confidence }));
      result.backends.faces = 'ultraface';
    }
    if (objRes) {
      result.objects = objRes.objects.map((o) => ({
        label: o.label,
        class_id: o.class_id,
        bbox: o.bbox,
        confidence: o.confidence,
      }));
      result.backends.objects = 'dfine-s';
    }
    return result;
  }
}

/**
 * Lift a detection result from EXPORT-image pixels to DOCUMENT pixels (the space
 * PS ops act in). Scales every coordinate by doc/export and rewrites `image` so
 * the frame stays self-describing.
 */
export function mapDetectionToDoc(
  result: DetectionResult,
  docWidth: number,
  docHeight: number
): DetectionResult {
  // Guard the degenerate case where no detector ran (image dims 0) — scale by 1
  // rather than emitting Infinity/NaN coordinates.
  const sx = result.image.width ? docWidth / result.image.width : 1;
  const sy = result.image.height ? docHeight / result.image.height : 1;
  const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), max);
  // This is the single coordinate chokepoint feeding real PS ops, so clamp each
  // box into doc bounds ([0, docWidth] / [0, docHeight]) and normalize ordering
  // (x1<=x2, y1<=y2) — a detector box that runs off the export edge must not
  // hand a PS selection a negative or out-of-canvas coordinate.
  const rect = (r: BBox): BBox => {
    const x1 = clamp(Math.round(r[0] * sx), docWidth);
    const y1 = clamp(Math.round(r[1] * sy), docHeight);
    const x2 = clamp(Math.round(r[2] * sx), docWidth);
    const y2 = clamp(Math.round(r[3] * sy), docHeight);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  };
  // Scale the mesh into document pixels too. z is a relative depth (roughly
  // width-normalized), not a canvas coordinate, so it is carried through unscaled.
  const scaleFeatures = (feat: FaceFeatures): FaceFeatures => ({
    ...feat,
    points: feat.points.map((p) => ({ x: p.x * sx, y: p.y * sy, z: p.z })),
  });
  const mapFace = (f: DetectedFace): DetectedFace => ({
    ...f,
    bbox: rect(f.bbox),
    ...(f.features ? { features: scaleFeatures(f.features) } : {}),
  });
  return {
    image: { width: docWidth, height: docHeight },
    backends: result.backends,
    ...(result.faces ? { faces: result.faces.map(mapFace) } : {}),
    ...(result.objects
      ? { objects: result.objects.map((o) => ({ ...o, bbox: rect(o.bbox) })) }
      : {}),
  };
}
