import { describe, it, expect } from 'vitest';
import {
  squareCrop,
  cropResizeToCHW,
  mapLandmarks,
} from '@editmamei/detection/landmark-detector.ts';
import { LANDMARK_COUNT } from '@editmamei/detection/landmark-spec.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';
import type { BBox } from '@editmamei/detection/detection-client.ts';

// The detector's coordinate math is the load-bearing, harness-testable part (the
// ONNX run needs weights + WASM and is verified live). These pin the square crop,
// the [0,1]-normalized CHW resample, and the crop-normalized → source-px lift.

/** Build a solid-colour RGBA image. */
function solid(w: number, h: number, r: number, g: number, b: number): DecodedImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe('squareCrop', () => {
  it('centres a square crop on the box, padded by 2×margin on the larger edge', () => {
    const box: BBox = [100, 100, 200, 300]; // 100×200, centre (150, 200)
    const c = squareCrop(box, 1000, 1000, 0.25); // side = 200 * 1.5 = 300
    expect(c.side).toBe(300);
    expect(c.x0).toBe(0); // 150 - 150
    expect(c.y0).toBe(50); // 200 - 150
  });

  it('shifts the window inside the image rather than going negative', () => {
    const box: BBox = [0, 0, 40, 40]; // centre (20,20)
    const c = squareCrop(box, 1000, 1000, 0); // side = 40
    expect(c.side).toBe(40);
    expect(c.x0).toBe(0); // 20-20=0, already in range
    expect(c.y0).toBe(0);
  });

  it('clamps the window against the far edge', () => {
    const box: BBox = [960, 100, 1000, 140]; // centre x=980, near right edge
    const c = squareCrop(box, 1000, 1000, 0); // side 40
    expect(c.side).toBe(40);
    expect(c.x0).toBe(960); // 980-20=960, +40 = 1000 (exactly the edge)
  });

  it('shrinks side to the smaller image dimension when the box is huge', () => {
    const box: BBox = [0, 0, 800, 400];
    const c = squareCrop(box, 500, 300, 0.5); // raw side would be 800*2=1600
    expect(c.side).toBe(300); // min(1600, 500, 300)
    expect(c.x0).toBeGreaterThanOrEqual(0);
    expect(c.y0).toBeGreaterThanOrEqual(0);
    expect(c.x0 + c.side).toBeLessThanOrEqual(500);
    expect(c.y0 + c.side).toBeLessThanOrEqual(300);
  });
});

describe('cropResizeToCHW', () => {
  it('emits a planar CHW float32 tensor normalized to [0,1]', () => {
    const img = solid(10, 10, 255, 0, 0); // pure red
    const t = cropResizeToCHW(img, { x0: 0, y0: 0, side: 10 }, 2);
    expect(t).toHaveLength(3 * 2 * 2);
    // R plane (first 4) = 1, G plane = 0, B plane = 0.
    expect([t[0], t[1], t[2], t[3]]).toEqual([1, 1, 1, 1]);
    expect([t[4], t[5], t[6], t[7]]).toEqual([0, 0, 0, 0]);
    expect([t[8], t[9], t[10], t[11]]).toEqual([0, 0, 0, 0]);
  });

  it('samples within the crop window (a grey sub-rect reads grey, not the border)', () => {
    // 4×4 black image with a 2×2 grey block at (2,2)..(3,3).
    const img = solid(4, 4, 0, 0, 0);
    for (const [x, y] of [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ]) {
      const i = (y * 4 + x) * 4;
      img.data[i] = 128;
      img.data[i + 1] = 128;
      img.data[i + 2] = 128;
    }
    const t = cropResizeToCHW(img, { x0: 2, y0: 2, side: 2 }, 1); // sample the grey block centre
    expect(t[0]).toBeCloseTo(128 / 255, 5);
  });
});

describe('mapLandmarks', () => {
  it('lifts crop-normalized [0,1] points into source pixels (x0 + n*side)', () => {
    const raw = new Float32Array(LANDMARK_COUNT * 3);
    // point 0 at the crop origin; point 5 at (0.5, 0.25, 0.75). All three are
    // exact in float32, so the px math is exact (0.1 would round and fail toEqual).
    raw[0] = 0;
    raw[1] = 0;
    raw[2] = 0;
    raw[15] = 0.5;
    raw[16] = 0.25;
    raw[17] = 0.75;
    const pts = mapLandmarks(raw, { x0: 10, y0: 20, side: 100 });
    expect(pts).toHaveLength(LANDMARK_COUNT);
    expect(pts[0]).toEqual({ x: 10, y: 20, z: 0 });
    expect(pts[5]).toEqual({ x: 60, y: 45, z: 75 });
  });
});
