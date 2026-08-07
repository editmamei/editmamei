/**
 * Face detection via Ultraface (version-RFB-320, MIT). Reliable on forward-
 * facing faces including glasses / tilt / edge crops — the cases a classic
 * cascade (Pigo) fundamentally misses. Returns face boxes only; precise
 * landmarks (iris / lip / mesh) are the Pro deep-model tier.
 *
 * Contract: input `input` [1,3,240,320] RGB, normalized (px-127)/128, CHW;
 * outputs `scores` [1,4420,2] (softmax [bg, face]) and `boxes` [1,4420,4]
 * already-decoded in normalized [0,1] xyxy. Post: threshold face prob, scale to
 * image px, NMS.
 */
import { loadModel, resolveModelPath, decodeJpeg, ort, type DecodedImage } from './runtime.js';
import { greedyNms, resizeToCHW, type Box } from './geometry.js';

const MODEL_FILE = 'ultraface-rfb-320.onnx';
const IN_W = 320;
const IN_H = 240;
const DEFAULT_THRESHOLD = 0.7;
const IOU_THRESHOLD = 0.4;

export interface RawFace {
  bbox: Box;
  confidence: number;
}

export interface FaceDetection {
  width: number;
  height: number;
  faces: RawFace[];
}

/**
 * Detect forward-facing faces in an exported JPEG. Coordinates are in the
 * EXPORT image's pixel space (carry `width`/`height` so the caller can scale to
 * document pixels). `decoded` is the export already decoded once by the caller
 * (detectActiveDoc) — when supplied, this skips its own decode (perf-audit H4).
 */
export async function detectFaces(
  imagePath: string,
  threshold = DEFAULT_THRESHOLD,
  decoded?: DecodedImage
): Promise<FaceDetection> {
  const img = decoded ?? decodeJpeg(imagePath);
  const session = await loadModel(resolveModelPath(MODEL_FILE));
  const input = resizeToCHW(img, IN_W, IN_H, (v) => (v - 127) / 128);
  const feeds = { input: new ort.Tensor('float32', input, [1, 3, IN_H, IN_W]) };
  const out = await session.run(feeds);

  const scores = out.scores.data as Float32Array;
  const boxes = out.boxes.data as Float32Array;
  const n = out.scores.dims[1];
  const cand: RawFace[] = [];
  for (let i = 0; i < n; i++) {
    const faceProb = scores[i * 2 + 1];
    if (faceProb > threshold) {
      cand.push({
        confidence: faceProb,
        bbox: [
          boxes[i * 4] * img.width,
          boxes[i * 4 + 1] * img.height,
          boxes[i * 4 + 2] * img.width,
          boxes[i * 4 + 3] * img.height,
        ],
      });
    }
  }
  cand.sort((p, q) => q.confidence - p.confidence);
  return { width: img.width, height: img.height, faces: greedyNms(cand, IOU_THRESHOLD) };
}
