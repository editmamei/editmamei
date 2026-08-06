import { describe, it, expect } from 'vitest';
import { meshFaces, pickFace, type MeshFace } from '@editmamei/detection/mesh-face.ts';
import type { DetectedFace } from '@editmamei/detection/detection-client.ts';

// pickFace delegates 'leftmost'/'rightmost'/'largest' to the canonical spatial
// picker in detection/geometry.ts (box CENTER, not edge). 'best' (mesh score,
// tie-broken by area) and the left-to-right numeric index stay local to this
// module and must NOT change.

function face(bbox: MeshFace['bbox'], score: number, confidence = 1): MeshFace {
  return { bbox, confidence, score, points: [] };
}

describe('pickFace', () => {
  // A wide box (left edge 100, cx 350) nests a narrow box (left edge 200, cx
  // 250) in its x-range — the edge-based/canonical divergence case.
  const wide = face([100, 100, 600, 300], 0.5);
  const narrow = face([200, 100, 300, 300], 0.5);

  it('leftmost picks the narrow/center-250 candidate, not the wide box with the smaller left edge', () => {
    expect(pickFace([wide, narrow], 'leftmost')).toBe(narrow);
  });

  it('rightmost picks the wide/center-350 candidate (symmetric)', () => {
    expect(pickFace([wide, narrow], 'rightmost')).toBe(wide);
  });

  it('largest picks by area', () => {
    expect(pickFace([wide, narrow], 'largest')).toBe(wide);
  });

  it("'best' stays mesh-score-based, unaffected by the spatial-pick convention", () => {
    const lowScore = face([100, 100, 600, 300], 0.4);
    const highScore = face([200, 100, 300, 300], 0.9);
    expect(pickFace([lowScore, highScore], 'best')).toBe(highScore);
  });

  it("'best' ties on score break by area", () => {
    const small = face([0, 0, 10, 10], 0.9);
    const big = face([0, 0, 100, 100], 0.9);
    expect(pickFace([small, big], 'best')).toBe(big);
  });

  it('numeric index counts left-to-right by box left edge (unchanged)', () => {
    expect(pickFace([wide, narrow], '0')).toBe(wide); // left edge 100 < 200
    expect(pickFace([wide, narrow], '1')).toBe(narrow);
  });

  it('returns undefined for an out-of-range index or empty input', () => {
    expect(pickFace([wide, narrow], '5')).toBeUndefined();
    expect(pickFace([], 'leftmost')).toBeUndefined();
  });
});

describe('meshFaces', () => {
  it('keeps only faces with a resolved mesh, flattened to bbox/confidence/score/points', () => {
    const withMesh: DetectedFace = {
      bbox: [1, 2, 3, 4],
      confidence: 0.9,
      features: { points: [], score: 0.8, backend: 'facemesh-468' },
    };
    const withoutMesh: DetectedFace = { bbox: [5, 6, 7, 8], confidence: 0.5 };
    expect(meshFaces([withMesh, withoutMesh])).toEqual([
      { bbox: [1, 2, 3, 4], confidence: 0.9, score: 0.8, points: [] },
    ]);
  });
});
