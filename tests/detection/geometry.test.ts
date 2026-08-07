import { describe, it, expect } from 'vitest';
import { iou, greedyNms, orderBySpatialPick, type Box } from '@editmamei/detection/geometry.ts';

describe('iou', () => {
  it('is 1 for identical boxes', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1, 5);
  });
  it('is 0 for disjoint boxes', () => {
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBeCloseTo(0, 5);
  });
  it('computes partial overlap', () => {
    // two 10×10 boxes overlapping in a 5×5 corner: inter=25, union=175
    expect(iou([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(25 / 175, 4);
  });
});

describe('greedyNms', () => {
  const box = (b: Box, score: number, label = 'x') => ({ bbox: b, score, label });

  it('suppresses a lower-score overlapping box (class-free)', () => {
    const items = [box([0, 0, 10, 10], 0.9), box([1, 1, 11, 11], 0.8)];
    expect(greedyNms(items, 0.5)).toHaveLength(1);
  });

  it('keeps non-overlapping boxes', () => {
    const items = [box([0, 0, 10, 10], 0.9), box([50, 50, 60, 60], 0.8)];
    expect(greedyNms(items, 0.5)).toHaveLength(2);
  });

  it('class-aware NMS keeps overlapping boxes of different labels', () => {
    const items = [box([0, 0, 10, 10], 0.9, 'dog'), box([1, 1, 11, 11], 0.8, 'cat')];
    const kept = greedyNms(items, 0.5, (a, b) => a.label === b.label);
    expect(kept).toHaveLength(2);
  });

  it('class-aware NMS suppresses overlapping boxes of the same label', () => {
    const items = [box([0, 0, 10, 10], 0.9, 'dog'), box([1, 1, 11, 11], 0.8, 'dog')];
    const kept = greedyNms(items, 0.5, (a, b) => a.label === b.label);
    expect(kept).toHaveLength(1);
  });
});

describe('orderBySpatialPick', () => {
  // The canonical "which instance" convention shared by grounding-anchors'
  // Pick, mesh-face's pickFace, and select-subject-instance's resolveInstance:
  // leftmost/rightmost/topmost/bottommost sort by box CENTER, not edge.
  // A wide box (left edge 100, cx 350) nests a narrow box (left edge 200, cx
  // 250) in its x-range — an edge-based convention would call the WIDE box
  // leftmost (smaller left edge); the canonical center-based one calls the
  // NARROW box leftmost (smaller center-x).
  const wide = { bbox: [100, 100, 600, 300] as Box, id: 'wide' };
  const narrow = { bbox: [200, 100, 300, 300] as Box, id: 'narrow' };

  it('leftmost picks the narrow/center-250 candidate, not the wide box with the smaller left edge', () => {
    expect(orderBySpatialPick([wide, narrow], 'leftmost')[0].id).toBe('narrow');
  });

  it('rightmost picks the wide/center-350 candidate (symmetric)', () => {
    expect(orderBySpatialPick([wide, narrow], 'rightmost')[0].id).toBe('wide');
  });

  it('topmost/bottommost sort by box center-y', () => {
    const upper = { bbox: [0, 0, 100, 100] as Box, id: 'upper' }; // cy 50
    const lower = { bbox: [0, 300, 100, 500] as Box, id: 'lower' }; // cy 400
    expect(orderBySpatialPick([upper, lower], 'topmost')[0].id).toBe('upper');
    expect(orderBySpatialPick([upper, lower], 'bottommost')[0].id).toBe('lower');
  });

  it('largest/smallest order by area', () => {
    expect(orderBySpatialPick([wide, narrow], 'largest')[0].id).toBe('wide');
    expect(orderBySpatialPick([wide, narrow], 'smallest')[0].id).toBe('narrow');
  });

  it('does not mutate the input array', () => {
    const items = [wide, narrow];
    orderBySpatialPick(items, 'rightmost');
    expect(items).toEqual([wide, narrow]);
  });
});
