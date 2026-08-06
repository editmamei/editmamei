import { describe, it, expect } from 'vitest';
import {
  buildFeaturePlan,
  convexHull,
  FACE_FEATURES,
  type Pt,
} from '@editmamei/detection/face-feature-geometry.ts';
import { LANDMARK_GROUPS, LANDMARK_COUNT } from '@editmamei/detection/landmark-spec.ts';
import type { LandmarkPoint } from '@editmamei/detection/detection-client.ts';

// The feature→selection-plan geometry is the bridge from mesh to selection: each
// feature must resolve to the right polygon ops (replace first, then add/subtract),
// and a missing-landmark face must degrade to null (honest absence).

/** 468 points placed non-collinearly so convex hulls are non-degenerate. */
function mesh(): LandmarkPoint[] {
  return Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
    x: (i * 37) % 211,
    y: (i * i) % 197,
    z: 0,
  }));
}

/** Expected ring polygon for a spec group under the mesh() mapping. */
function ringOf(points: LandmarkPoint[], indices: readonly number[]): Pt[] {
  return indices.map((i) => [points[i].x, points[i].y] as Pt);
}

describe('convexHull', () => {
  it('returns the 4 corners of a filled square (interior points dropped)', () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5], // interior
      [3, 7], // interior
    ]);
    expect(hull).toEqual(
      expect.arrayContaining([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ])
    );
    expect(hull).toHaveLength(4);
  });

  it('collapses collinear points to the two extremes', () => {
    expect(
      convexHull([
        [0, 0],
        [1, 1],
        [2, 2],
      ]).length
    ).toBeLessThanOrEqual(2);
  });
});

describe('buildFeaturePlan', () => {
  const points = mesh();

  it('covers every declared feature without throwing', () => {
    for (const f of FACE_FEATURES) {
      const plan = buildFeaturePlan(points, f);
      // every feature resolves to a usable plan on a full mesh
      expect(plan, f).not.toBeNull();
      expect(plan!.length, f).toBeGreaterThan(0);
      expect(plan![0].op, f).toBe('replace'); // first op always replace
    }
  });

  it('single-ring features are one replace polygon matching the spec ring', () => {
    expect(buildFeaturePlan(points, 'left_eye')).toEqual([
      { points: ringOf(points, LANDMARK_GROUPS.leftEye), op: 'replace' },
    ]);
    expect(buildFeaturePlan(points, 'teeth')).toEqual([
      { points: ringOf(points, LANDMARK_GROUPS.lipsInner), op: 'replace' },
    ]);
    expect(buildFeaturePlan(points, 'face')).toEqual([
      { points: ringOf(points, LANDMARK_GROUPS.faceOval), op: 'replace' },
    ]);
  });

  it('eyes = left replace + right add', () => {
    const plan = buildFeaturePlan(points, 'eyes')!;
    expect(plan.map((p) => p.op)).toEqual(['replace', 'add']);
  });

  it('lips = outer ring minus inner ring (the lip flesh)', () => {
    const plan = buildFeaturePlan(points, 'lips')!;
    expect(plan.map((p) => p.op)).toEqual(['replace', 'subtract']);
    expect(plan[0].points).toEqual(ringOf(points, LANDMARK_GROUPS.lipsOuter));
    expect(plan[1].points).toEqual(ringOf(points, LANDMARK_GROUPS.lipsInner));
  });

  it('skin = face oval with eyes/brows/lips subtracted (the retouch mask)', () => {
    const plan = buildFeaturePlan(points, 'skin')!;
    expect(plan[0].op).toBe('replace');
    expect(plan[0].points).toEqual(ringOf(points, LANDMARK_GROUPS.faceOval));
    // every remaining op is a subtract (the holes)
    expect(plan.slice(1).every((p) => p.op === 'subtract')).toBe(true);
    expect(plan.length).toBeGreaterThanOrEqual(4); // oval + ≥3 holes
  });

  it('under_eye and cheeks produce usable (≥3-pt) polygons', () => {
    for (const f of ['under_eye', 'cheeks'] as const) {
      const plan = buildFeaturePlan(points, f)!;
      for (const poly of plan) expect(poly.points.length, f).toBeGreaterThanOrEqual(3);
    }
  });

  it('returns null when the mesh is empty (honest absence)', () => {
    for (const f of FACE_FEATURES) {
      expect(buildFeaturePlan([], f), f).toBeNull();
    }
  });
});
