import { describe, it, expect } from 'vitest';
import {
  buildContourAnchors,
  catmullRomAnchors,
  contourSides,
  FACE_CONTOURS,
} from '@editmamei/detection/face-contour-geometry.ts';
import { LANDMARK_COUNT } from '@editmamei/detection/landmark-spec.ts';
import type { LandmarkPoint } from '@editmamei/detection/detection-client.ts';

// The contour geometry turns mesh points into smooth bézier anchors for the brush
// path. These pin the Catmull-Rom tangent handles, the per-contour build, and the
// combined-name fan-out.

function mesh(): LandmarkPoint[] {
  return Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
    x: (i * 37) % 211,
    y: (i * i) % 197,
    z: 0,
  }));
}

describe('catmullRomAnchors', () => {
  it('keeps a 2-point line as two corner anchors (no handles)', () => {
    const a = catmullRomAnchors([
      [0, 0],
      [10, 0],
    ]);
    expect(a).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('gives interior anchors tangent in/out handles; endpoints one-sided', () => {
    const a = catmullRomAnchors([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    // endpoint 0: out only, toward the next point (x increases)
    expect(a[0].in).toBeUndefined();
    expect(a[0].out![0]).toBeGreaterThan(0);
    // middle: both handles, tangent ∝ (next - prev) = (20, 0) → out ahead, in behind
    expect(a[1].in![0]).toBeLessThan(10);
    expect(a[1].out![0]).toBeGreaterThan(10);
    expect(a[1].in![1]).toBe(0);
    expect(a[1].out![1]).toBe(0);
    // endpoint 2: in only
    expect(a[2].out).toBeUndefined();
    expect(a[2].in![0]).toBeLessThan(20);
  });
});

describe('buildContourAnchors', () => {
  const points = mesh();

  it('builds a usable bézier path for each single-side contour', () => {
    for (const c of [
      'jawline',
      'nose_bridge',
      'cheekbone_left',
      'cheekbone_right',
      'under_eye_left',
      'under_eye_right',
    ] as const) {
      const a = buildContourAnchors(points, c);
      expect(a, c).not.toBeNull();
      expect(a!.length, c).toBeGreaterThanOrEqual(2);
      // coords are integers (document px)
      for (const p of a!) {
        expect(Number.isInteger(p.x)).toBe(true);
        expect(Number.isInteger(p.y)).toBe(true);
      }
    }
  });

  it('returns null for combined names (the tool fans them out per side)', () => {
    expect(buildContourAnchors(points, 'cheekbones')).toBeNull();
    expect(buildContourAnchors(points, 'under_eyes')).toBeNull();
  });

  it('returns null when the mesh is empty (honest absence)', () => {
    for (const c of FACE_CONTOURS) {
      expect(buildContourAnchors([], c), c).toBeNull();
    }
  });
});

describe('contourSides', () => {
  it('fans combined names into the two single-side contours', () => {
    expect(contourSides('cheekbones')).toEqual(['cheekbone_left', 'cheekbone_right']);
    expect(contourSides('under_eyes')).toEqual(['under_eye_left', 'under_eye_right']);
  });
  it('leaves a single-side contour as itself', () => {
    expect(contourSides('jawline')).toEqual(['jawline']);
    expect(contourSides('nose_bridge')).toEqual(['nose_bridge']);
  });
});
