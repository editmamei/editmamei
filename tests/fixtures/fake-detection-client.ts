import type {
  DetectionClient,
  DetectOptions,
  DetectionResult,
} from '@editmamei/detection/detection-client.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';
import { LANDMARK_COUNT } from '@editmamei/detection/landmark-spec.ts';

/**
 * Shared canned detections + a fake `DetectionClient` for the spatial-grounding
 * tools (the real ONNX backend needs weights, so tests inject this). Used by the
 * resolver front-end (grounding-locate) and its consumers (ps_resolve_placement,
 * ps_shape placement). The export itself is faked via the connection's
 * EXPORT_RESULT; this only stands in for the detector.
 */

/** The active-doc export result the fake connection returns (doc 1000², export 500²). */
export const EXPORT_RESULT = {
  ok: true,
  doc_width: 1000,
  doc_height: 1000,
  context: { hasDocument: true },
};

// Detection runs on a 500² export; mapDetectionToDoc scales boxes 2× to the 1000² doc.
export const CANNED: DetectionResult = {
  image: { width: 500, height: 500 },
  backends: { faces: 'ultraface', objects: 'dfine-s' },
  faces: [
    { bbox: [100, 100, 200, 200], confidence: 0.95 }, // → doc [200,200,400,400] centre (300,300)
    { bbox: [300, 300, 400, 400], confidence: 0.9 }, // → doc [600,600,800,800] centre (700,700)
  ],
  objects: [
    { label: 'dog', class_id: 16, bbox: [50, 50, 150, 150], confidence: 0.8 }, // → doc [100,100,300,300]
    { label: 'dog', class_id: 16, bbox: [300, 50, 450, 150], confidence: 0.7 }, // → doc [600,100,900,300]
  ],
};

// A face WITH a mesh, for landmark anchors. Image = doc (1000²) so scale is 1:1
// and mesh coords pass through unchanged. Left-eye ring: lower lid (first 9
// indices) at y=200, upper lid at y=160 → eye-height 40; nose tip at (340,250).
export const LEFT_EYE_FULL = [
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
];

export function meshPoints(): { x: number; y: number; z: number }[] {
  const pts = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
  LEFT_EYE_FULL.forEach((idx, k) => {
    const lower = k < 9;
    pts[idx] = { x: 300 + 10 * (lower ? k : k - 9), y: lower ? 200 : 160, z: 0 };
  });
  pts[1] = { x: 340, y: 250, z: 0 }; // nose_tip
  return pts;
}

export const CANNED_MESH: DetectionResult = {
  image: { width: 1000, height: 1000 },
  backends: { faces: 'ultraface+facemesh-468' },
  faces: [
    {
      bbox: [280, 140, 400, 260],
      confidence: 0.95,
      features: { points: meshPoints(), score: 0.9, backend: 'facemesh-468' },
    },
  ],
};

/** Returns the canned detections gated by the requested modalities, echoing opts. */
export class FakeDetectionClient implements DetectionClient {
  public lastOpts?: DetectOptions;
  /** The `decoded` image detectActiveDoc threaded into this call —
   *  a test can assert on this to prove the caller decoded once and passed it down,
   *  rather than this fake having to decode anything itself. */
  public lastDecoded?: DecodedImage;
  constructor(private readonly canned: DetectionResult) {}
  async detect(
    _path: string,
    opts: DetectOptions,
    decoded?: DecodedImage
  ): Promise<DetectionResult> {
    this.lastOpts = opts;
    this.lastDecoded = decoded;
    const r: DetectionResult = { image: this.canned.image, backends: {} };
    if (opts.faces) {
      r.faces = this.canned.faces;
      r.backends.faces = 'ultraface';
    }
    if (opts.objects) {
      r.objects = this.canned.objects;
      r.backends.objects = 'dfine-s';
    }
    return r;
  }
}
