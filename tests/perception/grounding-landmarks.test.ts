import { describe, it, expect } from 'vitest';
import {
  landmarkAnchor,
  isLandmarkFeature,
  LANDMARK_FEATURE_NAMES,
} from '@editmamei/perception/grounding-landmarks.ts';
import { LANDMARK_COUNT } from '@editmamei/detection/landmark-spec.ts';
import type { DetectionResult, LandmarkPoint } from '@editmamei/detection/detection-client.ts';

// The landmark producer maps a named facial feature to a resolver primitive
// (point or polyline) from a detected face's mesh. Pure — a canned DetectionResult
// stands in for real detection.

const LEFT_LOWER = [263, 249, 390, 373, 374, 380, 381, 382, 362];

/** 468-point mesh with the given index → [x,y] overrides (rest at origin). */
function mesh(overrides: Record<number, [number, number]> = {}): LandmarkPoint[] {
  const pts: LandmarkPoint[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
  for (const [i, [x, y]] of Object.entries(overrides)) pts[Number(i)] = { x, y, z: 0 };
  return pts;
}

interface FaceLike {
  bbox: [number, number, number, number];
  confidence: number;
  features?: { points: LandmarkPoint[]; score: number; backend: string };
}
function det(faces: FaceLike[]): DetectionResult {
  return {
    image: { width: 100, height: 100 },
    backends: { faces: 'ultraface+facemesh-468' },
    faces,
  } as DetectionResult;
}
const meshedFace = (points: LandmarkPoint[]): FaceLike => ({
  bbox: [0, 0, 100, 100],
  confidence: 0.9,
  features: { points, score: 0.9, backend: 'facemesh-468' },
});

describe('landmarkAnchor', () => {
  it('maps an eye-lower feature to the ordered lower-lid polyline', () => {
    const pts = mesh(Object.fromEntries(LEFT_LOWER.map((idx, k) => [idx, [300 + 10 * k, 200]])));
    const prim = landmarkAnchor(det([meshedFace(pts)]), { feature: 'left_eye_lower' });
    expect(prim?.kind).toBe('polyline');
    if (prim?.kind !== 'polyline') throw new Error('expected polyline');
    expect(prim.polyline).toHaveLength(9);
    expect(prim.polyline[0]).toEqual({ x: 300, y: 200 }); // outer corner first
    expect(prim.polyline[8]).toEqual({ x: 380, y: 200 }); // inner corner last
  });

  it('maps a single-point feature (nose_tip) to a point', () => {
    const prim = landmarkAnchor(det([meshedFace(mesh({ 1: [340, 250] }))]), {
      feature: 'nose_tip',
    });
    expect(prim).toEqual({ kind: 'point', point: { x: 340, y: 250 } });
  });

  it('returns null for an unknown feature name', () => {
    expect(landmarkAnchor(det([meshedFace(mesh())]), { feature: 'left_earlobe' })).toBeNull();
    expect(isLandmarkFeature('left_earlobe')).toBe(false);
    expect(isLandmarkFeature('left_eye_lower')).toBe(true);
    expect(LANDMARK_FEATURE_NAMES).toContain('left_eye_lower');
  });

  it('returns null when no face carries a mesh', () => {
    expect(landmarkAnchor(det([]), { feature: 'nose_tip' })).toBeNull();
    const boxOnly: FaceLike = { bbox: [0, 0, 10, 10], confidence: 0.9 }; // no features
    expect(landmarkAnchor(det([boxOnly]), { feature: 'nose_tip' })).toBeNull();
  });

  it('the face index selects among meshed faces (0 = first)', () => {
    const f0 = meshedFace(mesh({ 1: [10, 10] }));
    const f1 = meshedFace(mesh({ 1: [90, 90] }));
    expect(landmarkAnchor(det([f0, f1]), { feature: 'nose_tip', face: 1 })).toEqual({
      kind: 'point',
      point: { x: 90, y: 90 },
    });
  });
});
