import { describe, it, expect } from 'vitest';
import type { Tensor } from 'onnxruntime-web';
import {
  boxToPromptCoords,
  pointsToPromptCoords,
  toEncoderInput,
  thresholdMask,
  OnnxSamSegmenter,
  type SamMaskResult,
} from '@editmamei/detection/sam-segmenter.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';

/**
 * MobileSAM segmenter — the PURE helpers (coord/tensor math + mask thresholding).
 * The ONNX encoder/decoder need the real weights, so `segment` end-to-end mask
 * quality is live-verified against real Photoshop (the CV-tool testing pattern);
 * here we pin the geometry, plus (below) the embedding-memoization logic via the
 * injectable `runEncoder`/`runDecoder` deps — those are pure composition, not ONNX
 * inference, so they're fair game for the harness.
 */

describe('sam-segmenter helpers', () => {
  it('boxToPromptCoords scales the box into the 1024 long-edge frame (apply_coords)', () => {
    // square-long-edge: max(768,1024)=1024 → scale 1, coords unchanged
    const a = boxToPromptCoords([100, 200, 300, 400], 768, 1024);
    expect(Array.from(a.coords)).toEqual([100, 200, 300, 400]);
    expect(Array.from(a.labels)).toEqual([2, 3]); // box: top-left=2, bottom-right=3

    // wider image: max(2000,1000)=2000 → scale 1024/2000 = 0.512
    const b = boxToPromptCoords([100, 100, 200, 200], 2000, 1000);
    expect(b.coords[0]).toBeCloseTo(51.2, 3);
    expect(b.coords[2]).toBeCloseTo(102.4, 3);
  });

  it('pointsToPromptCoords scales fg/bg and appends the required [0,0]/-1 padding point', () => {
    // square long-edge (scale 1): one fg point + padding
    const a = pointsToPromptCoords([{ x: 100, y: 200 }], [], 768, 1024);
    expect(Array.from(a.coords)).toEqual([100, 200, 0, 0]); // fg, then [0,0] padding
    expect(Array.from(a.labels)).toEqual([1, -1]); // fg=1, padding=-1

    // fg + bg with a 0.512 scale (1024/2000) → labels fg=1, bg=0, padding=-1
    const b = pointsToPromptCoords([{ x: 10, y: 20 }], [{ x: 30, y: 40 }], 2000, 1000);
    expect(b.coords[0]).toBeCloseTo(5.12, 3);
    expect(b.coords[2]).toBeCloseTo(15.36, 3);
    expect(Array.from(b.labels)).toEqual([1, 0, -1]);
  });

  it('toEncoderInput drops alpha to a tight HWC RGB float array', () => {
    const img = {
      width: 2,
      height: 1,
      data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128]),
    };
    expect(Array.from(toEncoderInput(img))).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('thresholdMask keeps only >0 logits as 1', () => {
    expect(Array.from(thresholdMask([-3, 0, 0.01, 5, -0.001], 5))).toEqual([0, 0, 1, 1, 0]);
  });
});

/** A solid-fill DecodedImage — content is arbitrary, only its identity (dims + bytes)
 *  matters to the cache. */
function image(w: number, h: number, fill: number): DecodedImage {
  const data = new Uint8Array(w * h * 4);
  data.fill(fill);
  return { width: w, height: h, data };
}

const FAKE_MASK_RESULT: SamMaskResult = {
  mask: new Uint8Array([1]),
  width: 1,
  height: 1,
  iou: 0.9,
};

/** Fakes for OnnxSamSegmenter's injectable ONNX seam. `runEncoder` counts its own
 *  invocations (the thing under test); `runDecoder` just returns a fixed result — its
 *  own real-vs-fake distinction is exercised live, not here. */
function countingDeps() {
  const state = { encodeCalls: 0 };
  const runEncoder = async (_img: DecodedImage): Promise<Tensor> => {
    state.encodeCalls++;
    return { dims: [1, 256, 64, 64], data: new Float32Array(256 * 64 * 64) } as unknown as Tensor;
  };
  const runDecoder = async (): Promise<SamMaskResult> => FAKE_MASK_RESULT;
  return { state, runEncoder, runDecoder };
}

describe('OnnxSamSegmenter — embedding memoization', () => {
  it('two segment() calls on the same image run the encoder exactly once', async () => {
    const { state, runEncoder, runDecoder } = countingDeps();
    const seg = new OnnxSamSegmenter({ runEncoder, runDecoder });
    const img = image(4, 4, 10);
    await seg.segment(img, [0, 0, 2, 2]);
    await seg.segment(img, [1, 1, 3, 3]); // different box, same image → still cached
    expect(state.encodeCalls).toBe(1);
  });

  it('a different image (changed pixel content, same dims) re-encodes', async () => {
    const { state, runEncoder, runDecoder } = countingDeps();
    const seg = new OnnxSamSegmenter({ runEncoder, runDecoder });
    await seg.segment(image(4, 4, 10), [0, 0, 2, 2]);
    await seg.segment(image(4, 4, 200), [0, 0, 2, 2]); // same 4x4, different fill
    expect(state.encodeCalls).toBe(2);
  });

  it('different dims re-encode', async () => {
    const { state, runEncoder, runDecoder } = countingDeps();
    const seg = new OnnxSamSegmenter({ runEncoder, runDecoder });
    await seg.segment(image(4, 4, 10), [0, 0, 2, 2]);
    await seg.segment(image(8, 8, 10), [0, 0, 2, 2]);
    expect(state.encodeCalls).toBe(2);
  });

  it('segmentPoints() after segment() on the same image reuses the embedding', async () => {
    const { state, runEncoder, runDecoder } = countingDeps();
    const seg = new OnnxSamSegmenter({ runEncoder, runDecoder });
    const img = image(4, 4, 10);
    await seg.segment(img, [0, 0, 2, 2]);
    await seg.segmentPoints(img, [{ x: 1, y: 1 }]);
    expect(state.encodeCalls).toBe(1);
  });

  it('defaults to the real encoder/decoder deps when none are injected', () => {
    // Constructor-level seam is optional — production (select-object-tools-pro.ts)
    // calls `new OnnxSamSegmenter()` with no args.
    expect(() => new OnnxSamSegmenter()).not.toThrow();
  });
});
