/**
 * Box-promptable segmentation via MobileSAM converted to ONNX
 * (`models/pro/mobile_sam_{encoder,decoder}.onnx`, Apache-2.0). Runs HEADLESS on
 * the same onnxruntime-web (WASM) backend as the CE detectors + the Pro face mesh.
 *
 * Pro-tier: a pixel-accurate organic MASK from a detection box — the augmentation
 * of PS's unreliable native "Select Object".
 * The CE detectors return boxes; SAM turns a box into a clean object cutout.
 *
 * Contract (verified live, 2026-07-04; spike scratch-smoke/sam/):
 *   ENCODER  in  `input_image`      [H,W,3]      float32 raw RGB 0-255 (Acly's
 *                                                wrapper resizes/normalizes/pads
 *                                                to 1024 internally)
 *            out `image_embeddings` [1,256,64,64]
 *   DECODER  in  `image_embeddings` [1,256,64,64]
 *            in  `point_coords`     [1,N,2]      prompt points in the 1024 frame
 *            in  `point_labels`     [1,N]        2 = box top-left, 3 = box bot-right
 *            in  `mask_input`       [1,1,256,256] (zeros; has_mask_input=0)
 *            in  `has_mask_input`   [1]
 *            in  `orig_im_size`     [2]          (H,W) — decoder upsamples to this
 *            out `masks`            [1,1,H,W]    >0 = object; iou_predictions [1,1]
 *
 * Encoder ~4.3s + decoder ~0.2s on single-threaded WASM. The encoder is the cost and
 * runs once per image; a caller segmenting several boxes on one image should reuse the
 * embedding (encodeImage → segmentBox). `OnnxSamSegmenter` also memoizes the most
 * recent embedding internally (single-entry, keyed on cheap image identity — see
 * `computeImageKey`), so repeat `segment`/`segmentPoints` single-shot calls on an
 * unchanged image (the only production caller's pattern, `ps_select_object`) skip the
 * encoder too, without the caller having to thread embeddings through manually. The
 * shipped weights are **FP16** (encoder
 * 13.7MB + decoder 8.0MB ≈ 21.8MB, converted from the 42.6MB FP32 export via ort's
 * float16 converter with keep_io_types — I/O stays float32, WASM up-casts compute, so
 * quality is lossless vs FP32; verified live). INT8 dynamic quant was tried and
 * REJECTED — it collapsed the TinyViT encoder to whole-frame masks. Remaining
 * ship-readiness lever: WASM SIMD-threads for encoder latency.
 */
import type { Tensor } from 'onnxruntime-web';
import { loadModel, resolveModelPath, ort, type DecodedImage } from './runtime.js';
import type { BBox } from './detection-client.js';

const MODEL_ENCODER = 'pro/mobile_sam_encoder.onnx';
const MODEL_DECODER = 'pro/mobile_sam_decoder.onnx';
/** SAM's fixed long-edge input frame; box coords scale into it (apply_coords). */
const SAM_INPUT = 1024;

export interface SamMaskResult {
  /** 1 = object, 0 = not, row-major at width×height (the SOURCE image's pixels). */
  mask: Uint8Array;
  width: number;
  height: number;
  /** The decoder's mask-quality estimate (0–1). */
  iou: number;
}

/** A prompt point in the image's pixel frame. */
export interface SamPoint {
  x: number;
  y: number;
}

/** The seam the object-select tool programs against (tests inject a fake). */
export interface SamSegmenter {
  /** Box prompt: the object bounded by [x1,y1,x2,y2]. */
  segment(img: DecodedImage, box: BBox): Promise<SamMaskResult>;
  /** Point prompt: the object at the foreground point(s), optionally refined by
   *  background points to exclude. "Select what's here." */
  segmentPoints(img: DecodedImage, fg: SamPoint[], bg?: SamPoint[]): Promise<SamMaskResult>;
}

/**
 * Scale a document/image-pixel box into SAM's 1024-long-edge frame and emit it as
 * the decoder's two prompt points (top-left label 2, bottom-right label 3). This
 * is `ResizeLongestSide.apply_coords`: a uniform scale by 1024/max(w,h).
 */
export function boxToPromptCoords(
  box: BBox,
  imgW: number,
  imgH: number
): { coords: Float32Array; labels: Float32Array } {
  const s = SAM_INPUT / Math.max(imgW, imgH);
  const [x1, y1, x2, y2] = box;
  return {
    coords: Float32Array.from([x1 * s, y1 * s, x2 * s, y2 * s]),
    labels: Float32Array.from([2, 3]),
  };
}

/**
 * Scale foreground/background prompt points into SAM's 1024 frame (apply_coords) and
 * emit the decoder's point tensors, INCLUDING the required padding point ([0,0], label
 * -1) that a point-only prompt (no box) needs for the decoder's positional encoding.
 * Labels: 1 = foreground (include), 0 = background (exclude), -1 = padding.
 */
export function pointsToPromptCoords(
  fg: SamPoint[],
  bg: SamPoint[],
  imgW: number,
  imgH: number
): { coords: Float32Array; labels: Float32Array } {
  const s = SAM_INPUT / Math.max(imgW, imgH);
  const pts = [...fg, ...bg, { x: 0, y: 0 }]; // trailing padding point
  const labels = [...fg.map(() => 1), ...bg.map(() => 0), -1];
  const coords = new Float32Array(pts.length * 2);
  pts.forEach((p, i) => {
    coords[i * 2] = p.x * s;
    coords[i * 2 + 1] = p.y * s;
  });
  return { coords, labels: Float32Array.from(labels) };
}

/** RGBA DecodedImage → the encoder's [H,W,3] raw-RGB float32 tensor data. */
export function toEncoderInput(img: DecodedImage): Float32Array {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(h * w * 3);
  for (let p = 0; p < h * w; p++) {
    out[p * 3] = data[p * 4];
    out[p * 3 + 1] = data[p * 4 + 1];
    out[p * 3 + 2] = data[p * 4 + 2];
  }
  return out;
}

/** Threshold the decoder's float mask (>0 = object) into a 0/1 Uint8Array. */
export function thresholdMask(maskData: ArrayLike<number>, n: number): Uint8Array {
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = maskData[i] > 0 ? 1 : 0;
  return mask;
}

/** Byte span sampled off each end of the buffer for the embedding-cache identity hash. */
const HASH_SAMPLE_BYTES = 4096;
/** Strided sample points taken across the full buffer for the identity hash. */
const HASH_STRIDE_SAMPLES = 1024;

/** FNV-1a over `data[start, end)`, continuing from `seed`. */
function fnv1a(data: Uint8Array, start: number, end: number, seed: number): number {
  let h = seed;
  for (let i = start; i < end; i++) {
    h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Cheap identity for a DecodedImage, used to key the single-entry embedding cache below:
 * dims + buffer length + a SPARSE content hash (FNV-1a over the first/last 4KB and a
 * ~1024-point stride across the rest). Full-buffer hashing is deliberately rejected —
 * these buffers run 4MB+ and this identity is computed on every `segment`/`segmentPoints`
 * call, so hashing the whole thing would eat back a meaningful slice of the win.
 * Tradeoff: a same-size edit that touches none of the sampled bytes could in theory
 * collide and reuse a stale embedding. Accepted — the case this targets (repeat selects
 * on a document that hasn't changed) has a byte-identical buffer, not a crafted one that
 * dodges the sample.
 */
interface ImageKey {
  width: number;
  height: number;
  byteLength: number;
  hash: number;
}

function computeImageKey(img: DecodedImage): ImageKey {
  const { width, height, data } = img;
  const n = data.length;
  let h = fnv1a(data, 0, Math.min(HASH_SAMPLE_BYTES, n), 0x811c9dc5);
  h = fnv1a(data, Math.max(0, n - HASH_SAMPLE_BYTES), n, h);
  const stride = Math.max(1, Math.floor(n / HASH_STRIDE_SAMPLES));
  for (let i = 0; i < n; i += stride) {
    h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  }
  return { width, height, byteLength: n, hash: h };
}

function sameImageKey(a: ImageKey, b: ImageKey): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.byteLength === b.byteLength &&
    a.hash === b.hash
  );
}

/** The real encoder call (loads + runs the encoder session). Default `runEncoder` dep. */
async function realRunEncoder(img: DecodedImage): Promise<Tensor> {
  const session = await loadModel(resolveModelPath(MODEL_ENCODER));
  const input = new ort.Tensor('float32', toEncoderInput(img), [img.height, img.width, 3]);
  const out = await session.run({ input_image: input });
  return out.image_embeddings as Tensor;
}

/** The real decoder call (loads + runs the decoder session, shapes mask/iou output) for
 *  pre-scaled (1024-frame) coords/labels of ANY point count (box = 2 corner points; a
 *  point prompt = fg/bg + a padding point). Default `runDecoder` dep. */
async function realRunDecoder(
  embedding: Tensor,
  coords: Float32Array,
  labels: Float32Array,
  imgW: number,
  imgH: number
): Promise<SamMaskResult> {
  const session = await loadModel(resolveModelPath(MODEL_DECODER));
  const nPts = labels.length;
  const out = await session.run({
    image_embeddings: embedding,
    point_coords: new ort.Tensor('float32', coords, [1, nPts, 2]),
    point_labels: new ort.Tensor('float32', labels, [1, nPts]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
    orig_im_size: new ort.Tensor('float32', Float32Array.from([imgH, imgW]), [2]),
  });
  const masks = out.masks;
  const [, , mh, mw] = masks.dims as number[];
  return {
    mask: thresholdMask(masks.data as Float32Array, mh * mw),
    width: mw,
    height: mh,
    iou: (out.iou_predictions.data as Float32Array)[0] ?? 0,
  };
}

/** Injectable ONNX seams (default to the real encoder/decoder sessions above) — same
 *  `deps` pattern as `OnnxLandmarkDetectionClient`. Tests fake these directly so the
 *  embedding-cache logic in `encodeImage` is exercised without ONNX weights or WASM. */
export interface SamSegmenterDeps {
  runEncoder?: (img: DecodedImage) => Promise<Tensor>;
  runDecoder?: (
    embedding: Tensor,
    coords: Float32Array,
    labels: Float32Array,
    imgW: number,
    imgH: number
  ) => Promise<SamMaskResult>;
}

/**
 * MobileSAM on the shared onnxruntime-web runtime. `encodeImage` runs the heavy
 * encoder, memoized on the last image's identity (see `computeImageKey`);
 * `segmentBox`/`segmentPointsAt` reuse an already-computed embedding per prompt.
 * `segment`/`segmentPoints` are the single-shot conveniences the tool uses, and now
 * benefit from the cache too when called repeatedly on the same image.
 */
export class OnnxSamSegmenter implements SamSegmenter {
  private readonly runEncoderImpl: NonNullable<SamSegmenterDeps['runEncoder']>;
  private readonly runDecoderImpl: NonNullable<SamSegmenterDeps['runDecoder']>;
  /** Single-entry, last-image embedding cache. */
  private cachedKey: ImageKey | null = null;
  private cachedEmbedding: Tensor | null = null;

  constructor(deps: SamSegmenterDeps = {}) {
    this.runEncoderImpl = deps.runEncoder ?? realRunEncoder;
    this.runDecoderImpl = deps.runDecoder ?? realRunDecoder;
  }

  async encodeImage(img: DecodedImage): Promise<Tensor> {
    const key = computeImageKey(img);
    if (this.cachedKey && sameImageKey(this.cachedKey, key)) return this.cachedEmbedding!;
    const embedding = await this.runEncoderImpl(img);
    this.cachedKey = key;
    this.cachedEmbedding = embedding;
    return embedding;
  }

  async segmentBox(embedding: Tensor, box: BBox, imgW: number, imgH: number) {
    const { coords, labels } = boxToPromptCoords(box, imgW, imgH);
    return this.runDecoderImpl(embedding, coords, labels, imgW, imgH);
  }

  async segmentPointsAt(
    embedding: Tensor,
    fg: SamPoint[],
    bg: SamPoint[],
    imgW: number,
    imgH: number
  ) {
    const { coords, labels } = pointsToPromptCoords(fg, bg, imgW, imgH);
    return this.runDecoderImpl(embedding, coords, labels, imgW, imgH);
  }

  async segment(img: DecodedImage, box: BBox): Promise<SamMaskResult> {
    const embedding = await this.encodeImage(img);
    return this.segmentBox(embedding, box, img.width, img.height);
  }

  async segmentPoints(
    img: DecodedImage,
    fg: SamPoint[],
    bg: SamPoint[] = []
  ): Promise<SamMaskResult> {
    const embedding = await this.encodeImage(img);
    return this.segmentPointsAt(embedding, fg, bg, img.width, img.height);
  }
}
