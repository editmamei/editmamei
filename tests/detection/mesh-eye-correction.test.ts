import { describe, it, expect } from 'vitest';
import { correctMeshEyes } from '@editmamei/detection/mesh-eye-correction.ts';
import { LANDMARK_GROUPS, LANDMARK_COUNT } from '@editmamei/detection/landmark-spec.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';
import type { LandmarkPoint } from '@editmamei/detection/detection-client.ts';

// The correction: find the true pupil (dark iris) in a small window around each
// mesh eye and snap the eyes/brows/nose there; leave mouth/oval; no-op on bad input.

/** Gray canvas with dark discs (pupils). */
function image(W: number, H: number, discs: [number, number, number][]): DecodedImage {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 180;
    data[i * 4 + 3] = 255;
  }
  for (const [cx, cy, r] of discs)
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++)
        if (x * x + y * y <= r * r) {
          const px = cx + x,
            py = cy + y;
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          const i = (py * W + px) * 4;
          data[i] = data[i + 1] = data[i + 2] = 20;
        }
  return { width: W, height: H, data };
}

/** 468-point mesh: eye rings around the given eye centres; markers on a nose + lips point. */
function mesh(eyeL: [number, number], eyeR: [number, number]): LandmarkPoint[] {
  const pts: LandmarkPoint[] = Array.from({ length: LANDMARK_COUNT }, () => ({
    x: 200,
    y: 200,
    z: 0,
  }));
  const ringAround = (indices: readonly number[], cx: number, cy: number): void => {
    indices.forEach((idx, k) => {
      const a = (k / indices.length) * Math.PI * 2;
      pts[idx] = { x: cx + 15 * Math.cos(a), y: cy + 8 * Math.sin(a), z: 0 };
    });
  };
  ringAround(LANDMARK_GROUPS.leftEye, eyeL[0], eyeL[1]);
  ringAround(LANDMARK_GROUPS.rightEye, eyeR[0], eyeR[1]);
  pts[LANDMARK_GROUPS.nose[0]] = { x: 150, y: 150, z: 0 }; // rigid → should move
  pts[LANDMARK_GROUPS.lipsOuter[0]] = { x: 250, y: 260, z: 0 }; // NOT rigid → should stay
  return pts;
}
const centroidOf = (pts: LandmarkPoint[], idx: readonly number[]): { x: number; y: number } => {
  const g = idx.map((i) => pts[i]);
  return {
    x: g.reduce((s, p) => s + p.x, 0) / g.length,
    y: g.reduce((s, p) => s + p.y, 0) / g.length,
  };
};

describe('correctMeshEyes', () => {
  it('snaps the eyes to the true pupils and reports the drift', () => {
    // mesh eyes at (100,200)/(300,200); pupils 15/12px below
    const img = image(400, 400, [
      [100, 215, 7],
      [300, 212, 7],
    ]);
    const pts = mesh([100, 200], [300, 200]);
    const { points, correction } = correctMeshEyes(img, pts);
    expect(correction).not.toBeNull();
    const cl = centroidOf(points, LANDMARK_GROUPS.leftEye);
    const cr = centroidOf(points, LANDMARK_GROUPS.rightEye);
    expect(cl.x).toBeCloseTo(100, 0);
    expect(cl.y).toBeGreaterThan(210); // moved down onto the pupil
    expect(cr.y).toBeGreaterThan(207);
    expect(correction!.drift_left).toBeGreaterThan(10);
    expect(correction!.drift_left).toBeLessThan(22);
    expect(correction!.low_confidence).toBe(false);
  });

  it('moves the rigid nose but leaves the mouth (non-rigid) untouched', () => {
    const img = image(400, 400, [
      [100, 215, 7],
      [300, 212, 7],
    ]);
    const pts = mesh([100, 200], [300, 200]);
    const nose0 = LANDMARK_GROUPS.nose[0],
      lip0 = LANDMARK_GROUPS.lipsOuter[0];
    const noseBefore = { ...pts[nose0] },
      lipBefore = { ...pts[lip0] };
    const { points } = correctMeshEyes(img, pts);
    expect(points[nose0]).not.toEqual(noseBefore); // rigid → transformed
    expect(points[lip0]).toEqual(lipBefore); // non-rigid → unchanged
  });

  it('no-ops on a degenerate / mismatched image (safe)', () => {
    const bad: DecodedImage = { width: 400, height: 400, data: new Uint8Array(4) };
    const pts = mesh([100, 200], [300, 200]);
    const { points, correction } = correctMeshEyes(bad, pts);
    expect(correction).toBeNull();
    expect(points).toBe(pts); // unchanged reference
  });

  it('no-ops on an incomplete mesh', () => {
    const img = image(400, 400, [[100, 215, 7]]);
    const short = [{ x: 1, y: 1, z: 0 }];
    const { correction } = correctMeshEyes(img, short);
    expect(correction).toBeNull();
  });

  it('flags low_confidence when the finder hits its window edge (occlusion proxy)', () => {
    // A strong dark bar along the bottom edge of the eye windows pulls the finder
    // to the boundary → atEdge → low confidence (the true eye is occluded).
    const img = image(400, 400, []);
    // dark bars at the window's lower edge (~2 ring-heights below the mesh eye)
    for (const [cx, cy] of [
      [100, 200],
      [300, 200],
    ] as [number, number][])
      for (let x = cx - 14; x <= cx + 14; x++)
        for (let y = cy + 30; y <= cy + 32; y++) {
          const i = (y * 400 + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 15;
        }
    const pts = mesh([100, 200], [300, 200]);
    const { correction } = correctMeshEyes(img, pts);
    expect(correction).not.toBeNull();
    expect(correction!.low_confidence).toBe(true);
  });
});
