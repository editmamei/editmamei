/**
 * OnnxLandmarkDetectionClient — the Pro detection backend that enriches each
 * detected face with the MediaPipe face mesh, behind the same `DetectionClient`
 * seam the CE backend implements. The portrait/scene handlers don't know which
 * engine produced the geometry; they just see `DetectedFace.features` populated.
 *
 * It composes (not replaces) the CE backend: the base client supplies face boxes
 * (Ultraface) + objects (D-FINE), then this client runs the face-mesh model once
 * per face on the same export image and attaches the mesh. Object detection is
 * untouched.
 *
 * Pro-tier: lives in a Pro-only module, its weight ships in the downloaded Pro
 * module (`models/pro/`, never staged into the CE bundle by `copyModels`).
 *
 * The model run (`detectLandmarks`) and image decode (`decodeJpeg`) are injectable
 * so the composition logic — the score gate, the per-face failure swallow, the
 * backend-tag append — is unit-testable without ONNX weights or a real export on
 * disk. Production uses the real implementations by default.
 */
import { decodeJpeg as realDecodeJpeg, type DecodedImage } from './runtime.js';
import {
  detectLandmarks as realDetectLandmarks,
  type DetectLandmarksOptions,
  type FaceMeshResult,
} from './landmark-detector.js';
import {
  OnnxDetectionClient,
  type BBox,
  type DetectionClient,
  type DetectOptions,
  type DetectionResult,
} from './detection-client.js';
import { correctMeshEyes } from './mesh-eye-correction.js';

const LANDMARK_BACKEND = 'facemesh-468';

export interface LandmarkClientOptions {
  /** Fraction of the face box added as crop context per side (default 0.25). */
  margin?: number;
  /**
   * Drop a face's mesh when the model's presence score is below this (default
   * 0.5). The face box + confidence still return; only `features` is omitted.
   */
  minScore?: number;
  /**
   * Refine the mesh eyes (+ rigid brows/nose) to the classical-CV pupils
   * (mesh-eye-correction.ts). Default true — the mesh's eyes can sit tens of px
   * off; the correction snaps them to the true pupils and flags occlusion.
   */
  correctEyes?: boolean;
}

/** Injectable model/decoder seams (defaults to the real ONNX + jpeg-js paths). */
export interface LandmarkClientDeps {
  detectLandmarks?: (
    img: DecodedImage,
    box: BBox,
    opts?: DetectLandmarksOptions
  ) => Promise<FaceMeshResult>;
  decodeJpeg?: (path: string) => DecodedImage;
}

export class OnnxLandmarkDetectionClient implements DetectionClient {
  private readonly base: DetectionClient;
  private readonly opts: LandmarkClientOptions;
  private readonly detectLandmarks: NonNullable<LandmarkClientDeps['detectLandmarks']>;
  private readonly decodeJpeg: NonNullable<LandmarkClientDeps['decodeJpeg']>;

  constructor(
    base: DetectionClient = new OnnxDetectionClient(),
    opts: LandmarkClientOptions = {},
    deps: LandmarkClientDeps = {}
  ) {
    this.base = base;
    this.opts = opts;
    this.detectLandmarks = deps.detectLandmarks ?? realDetectLandmarks;
    this.decodeJpeg = deps.decodeJpeg ?? realDecodeJpeg;
  }

  async detect(
    imagePath: string,
    opts: DetectOptions,
    decoded?: DecodedImage
  ): Promise<DetectionResult> {
    const result = await this.base.detect(imagePath, opts, decoded);
    if (!opts.faces || !result.faces || result.faces.length === 0) return result;

    // Reuse the caller's decode when supplied; else decode ONCE here, then run
    // the mesh per face (faces are few) — either way, exactly one decode.
    const img = decoded ?? this.decodeJpeg(imagePath);
    const minScore = this.opts.minScore ?? 0.5;
    const lmOpts: DetectLandmarksOptions = { margin: this.opts.margin };

    const correctEyes = this.opts.correctEyes ?? true;
    for (const face of result.faces) {
      try {
        const mesh = await this.detectLandmarks(img, face.bbox, lmOpts);
        if (mesh.score >= minScore) {
          face.features = { points: mesh.points, score: mesh.score, backend: LANDMARK_BACKEND };
          // Snap the mesh eyes (+ rigid brows/nose) to the true pupils. Safe
          // no-op on a bad image / incomplete mesh; carries the confidence flag.
          if (correctEyes) {
            const c = correctMeshEyes(img, face.features.points);
            face.features.points = c.points;
            if (c.correction) face.features.eyeCorrection = c.correction;
          }
        }
      } catch {
        // Per-face mesh failure is non-fatal: keep the box, omit `features`.
      }
    }
    // Note the mesh in the faces backend tag (e.g. 'ultraface+facemesh-468').
    result.backends.faces = result.backends.faces
      ? `${result.backends.faces}+${LANDMARK_BACKEND}`
      : LANDMARK_BACKEND;
    return result;
  }
}
