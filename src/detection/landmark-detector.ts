/**
 * Face-mesh landmark detection via the MediaPipe FaceMesh model converted to
 * ONNX (`models/pro/face_mesh_468.onnx`, Apache-2.0). Runs HEADLESS on the same
 * onnxruntime-web (WASM) backend as the CE detectors — the MediaPipe *model* on
 * our runtime, NOT the MediaPipe JS Tasks runtime (which needs a DOM and is the
 * documented headless-failure this avoids).
 *
 * Pro-tier (precise geometry → Pro). The CE detectors return boxes; this returns
 * the 468-point mesh per face.
 *
 * Contract (verified live, 2026-06-25):
 *   input  `image`     [1,3,192,192] NCHW float32, value range [0,1] (px/255)
 *   output `scores`    [1]            face-presence probability
 *   output `landmarks` [1,468,3]      (x,y,z) NORMALIZED to [0,1] of the crop
 *
 * The model expects a roughly-square, upright face crop. We crop the export to a
 * square padded box around the detector's face box and resize to 192×192 — no
 * eye-rotation alignment (the CE face detector gives a box, not keypoints), so
 * heavy in-plane tilt degrades accuracy. The live accuracy run is the gate, and
 * `margin` is the tuning knob.
 */
import { loadModel, resolveModelPath, ort, type DecodedImage } from './runtime.js';
import type { BBox, LandmarkPoint } from './detection-client.js';
import { LANDMARK_COUNT, MODEL_INPUT_SIZE } from './landmark-spec.js';

const MODEL_FILE = 'pro/face_mesh_468.onnx';
const DEFAULT_MARGIN = 0.25;

/** A square crop window in image pixels. */
export interface SquareCrop {
  x0: number;
  y0: number;
  side: number;
}

export interface FaceMeshResult {
  /** Face-presence / quality score from the model (0–1). */
  score: number;
  /** All `LANDMARK_COUNT` points in the SOURCE image's pixel space. */
  points: LandmarkPoint[];
}

/**
 * Largest square crop centred on the face box, expanded by `margin` on each
 * side, then shifted to stay inside the image. If the expanded square exceeds
 * the image, its side is clamped to the smaller image dimension. Keeping the
 * crop square avoids the aspect distortion that hurts mesh accuracy.
 */
export function squareCrop(box: BBox, imgW: number, imgH: number, margin: number): SquareCrop {
  const [x1, y1, x2, y2] = box;
  const bw = Math.max(0, x2 - x1);
  const bh = Math.max(0, y2 - y1);
  const cx = x1 + bw / 2;
  const cy = y1 + bh / 2;
  // Pad the larger edge by `margin` on BOTH sides → (1 + 2*margin) factor.
  let side = Math.max(bw, bh) * (1 + 2 * margin);
  side = Math.min(side, imgW, imgH);
  // Centre, then clamp the window inside the image without changing `side`.
  let x0 = cx - side / 2;
  let y0 = cy - side / 2;
  x0 = Math.max(0, Math.min(x0, imgW - side));
  y0 = Math.max(0, Math.min(y0, imgH - side));
  return { x0, y0, side };
}

/**
 * Nearest-neighbour resample of a square crop window to `out`×`out`, emitted as a
 * planar CHW float32 tensor normalized to [0,1] (px/255) — the model's input
 * contract. Reads from the RGBA `img` within the crop window.
 */
export function cropResizeToCHW(img: DecodedImage, crop: SquareCrop, out: number): Float32Array {
  const { width: w, height: h, data } = img;
  const tensor = new Float32Array(3 * out * out);
  const plane = out * out;
  for (let oy = 0; oy < out; oy++) {
    const syf = crop.y0 + ((oy + 0.5) / out) * crop.side;
    const sy = Math.min(h - 1, Math.max(0, Math.floor(syf)));
    for (let ox = 0; ox < out; ox++) {
      const sxf = crop.x0 + ((ox + 0.5) / out) * crop.side;
      const sx = Math.min(w - 1, Math.max(0, Math.floor(sxf)));
      const si = (sy * w + sx) * 4;
      const di = oy * out + ox;
      tensor[di] = data[si] / 255;
      tensor[plane + di] = data[si + 1] / 255;
      tensor[2 * plane + di] = data[si + 2] / 255;
    }
  }
  return tensor;
}

/**
 * Lift the model's crop-normalized [0,1] landmarks into the SOURCE image's pixel
 * space: `x = x0 + nx*side`, `y = y0 + ny*side`. z is scaled by `side` so it
 * stays in the same pixel-ish units (it is relative depth, not a canvas coord).
 */
export function mapLandmarks(rawFlat: ArrayLike<number>, crop: SquareCrop): LandmarkPoint[] {
  const points: LandmarkPoint[] = new Array(LANDMARK_COUNT);
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    points[i] = {
      x: crop.x0 + rawFlat[i * 3] * crop.side,
      y: crop.y0 + rawFlat[i * 3 + 1] * crop.side,
      z: rawFlat[i * 3 + 2] * crop.side,
    };
  }
  return points;
}

export interface DetectLandmarksOptions {
  /** Fraction of the face box added as crop context per side (default 0.25). */
  margin?: number;
}

/**
 * Run the face-mesh model on one already-decoded export image + a face box (in
 * that image's pixel space). Returns the mesh in the SAME pixel space — the
 * caller lifts it to document pixels (via `mapDetectionToDoc`). Throws if the
 * box is degenerate; the client decides whether to swallow per-face.
 */
export async function detectLandmarks(
  img: DecodedImage,
  box: BBox,
  opts: DetectLandmarksOptions = {}
): Promise<FaceMeshResult> {
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const crop = squareCrop(box, img.width, img.height, margin);
  if (crop.side <= 0) throw new Error('degenerate face box for landmark crop');

  const session = await loadModel(resolveModelPath(MODEL_FILE));
  const input = cropResizeToCHW(img, crop, MODEL_INPUT_SIZE);
  const feeds = {
    image: new ort.Tensor('float32', input, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]),
  };
  const out = await session.run(feeds);
  const score = (out.scores.data as Float32Array)[0] ?? 0;
  const landmarks = out.landmarks.data as Float32Array;
  return { score, points: mapLandmarks(landmarks, crop) };
}
