import { describe, it, expect } from 'vitest';
import {
  LANDMARK_COUNT,
  MODEL_INPUT_SIZE,
  LANDMARK_GROUPS,
  LANDMARK_GROUP_KEYS,
  LANDMARK_ANCHORS,
  LANDMARK_ANCHOR_KEYS,
} from '@editmamei/detection/landmark-spec.ts';

// The spec is the static source of truth for the `features` shape: every index
// must address a real point in the 468-point mesh, and no group may repeat an
// index (a duplicate would double-plot / double-weight a point downstream).

describe('landmark-spec', () => {
  it('declares the 468-point mesh on a 192px square input', () => {
    expect(LANDMARK_COUNT).toBe(468);
    expect(MODEL_INPUT_SIZE).toBe(192);
  });

  it('every group index is within [0, LANDMARK_COUNT)', () => {
    for (const key of LANDMARK_GROUP_KEYS) {
      for (const i of LANDMARK_GROUPS[key]) {
        expect(Number.isInteger(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(LANDMARK_COUNT);
      }
    }
  });

  it('no group repeats an index within itself', () => {
    for (const key of LANDMARK_GROUP_KEYS) {
      const set = new Set(LANDMARK_GROUPS[key]);
      expect(set.size).toBe(LANDMARK_GROUPS[key].length);
    }
  });

  it('exposes the expected named groups with canonical MediaPipe sizes', () => {
    expect(LANDMARK_GROUP_KEYS).toEqual([
      'faceOval',
      'leftEye',
      'rightEye',
      'leftEyebrow',
      'rightEyebrow',
      'lipsOuter',
      'lipsInner',
      'nose',
    ]);
    expect(LANDMARK_GROUPS.faceOval).toHaveLength(36);
    expect(LANDMARK_GROUPS.leftEye).toHaveLength(16);
    expect(LANDMARK_GROUPS.rightEye).toHaveLength(16);
    expect(LANDMARK_GROUPS.lipsOuter).toHaveLength(20);
    expect(LANDMARK_GROUPS.lipsInner).toHaveLength(20);
  });

  it('every anchor index is within range', () => {
    for (const key of LANDMARK_ANCHOR_KEYS) {
      const i = LANDMARK_ANCHORS[key];
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(LANDMARK_COUNT);
    }
  });

  it('left and right eye rings are disjoint (no shared index)', () => {
    const left = new Set<number>(LANDMARK_GROUPS.leftEye);
    for (const i of LANDMARK_GROUPS.rightEye) expect(left.has(i)).toBe(false);
  });
});
