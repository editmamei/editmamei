import { describe, it, expect } from 'vitest';
import {
  bboxToBox,
  localizeAnchor,
  localizeAnchors,
} from '@editmamei/perception/grounding-anchors.ts';
import type { DetectionResult } from '@editmamei/detection/detection-client.ts';

// The detection→anchor adapter. Fake DetectionResult in doc pixels; no ONNX.

const det: DetectionResult = {
  image: { width: 2316, height: 3088 },
  backends: { faces: 'ultraface', objects: 'dfine-s' },
  faces: [
    { bbox: [1142, 367, 1822, 1350], confidence: 1.0 }, // right face (higher conf → index 0)
    { bbox: [306, 645, 1090, 1738], confidence: 0.99 }, // left face
  ],
  objects: [
    { label: 'boat', class_id: 8, bbox: [110, 14, 4000, 2985], confidence: 0.84 }, // huge
    { label: 'boat', class_id: 8, bbox: [750, 1276, 4032, 2995], confidence: 0.74 }, // smaller
    { label: 'person', class_id: 0, bbox: [1524, 1898, 2402, 3010], confidence: 0.9 },
  ],
};

describe('grounding-anchors adapter', () => {
  it('bboxToBox maps [x1,y1,x2,y2] → {left,top,right,bottom}', () => {
    expect(bboxToBox([10, 20, 30, 40])).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
  });

  it('picks a face by detection-order instance (confidence)', () => {
    const a = localizeAnchor(det, { kind: 'face', instance: 0 });
    expect(a).toEqual({ kind: 'box', box: { left: 1142, top: 367, right: 1822, bottom: 1350 } });
  });

  it('spatial picks: leftmost vs rightmost face (E7 referents)', () => {
    const left = localizeAnchor(det, { kind: 'face', pick: 'leftmost' });
    const right = localizeAnchor(det, { kind: 'face', pick: 'rightmost' });
    if (left?.kind !== 'box' || right?.kind !== 'box') throw new Error('unreachable');
    expect(left.box.left).toBe(306); // the x~700-centre face
    expect(right.box.left).toBe(1142); // the x~1480-centre face
  });

  it('size picks: largest vs smallest boat', () => {
    const big = localizeAnchor(det, { kind: 'object', label: 'boat', pick: 'largest' });
    const small = localizeAnchor(det, { kind: 'object', label: 'boat', pick: 'smallest' });
    if (big?.kind !== 'box' || small?.kind !== 'box') throw new Error('unreachable');
    expect(big.box.left).toBe(110); // the huge boat
    expect(small.box.left).toBe(750);
  });

  it('object label filter + null when absent', () => {
    expect(localizeAnchor(det, { kind: 'object', label: 'person' })).toEqual({
      kind: 'box',
      box: { left: 1524, top: 1898, right: 2402, bottom: 3010 },
    });
    expect(localizeAnchor(det, { kind: 'object', label: 'giraffe' })).toBeNull();
    expect(localizeAnchor(det, { kind: 'face', instance: 5 })).toBeNull();
  });

  it('leftmost/rightmost use box CENTER, not left edge (wide vs narrow overlap) — the canonical convention delegated from detection/geometry.ts', () => {
    // A wide box (left edge 100, cx 350) nests a narrow box (left edge 200, cx
    // 250) in its x-range. An edge-based convention would call the WIDE box
    // leftmost; this one calls the NARROW box leftmost.
    const detWideNarrow: DetectionResult = {
      image: { width: 1000, height: 1000 },
      backends: {},
      faces: [
        { bbox: [100, 0, 600, 100], confidence: 0.5 }, // wide, cx 350
        { bbox: [200, 0, 300, 100], confidence: 0.5 }, // narrow, cx 250
      ],
    };
    const left = localizeAnchor(detWideNarrow, { kind: 'face', pick: 'leftmost' });
    const right = localizeAnchor(detWideNarrow, { kind: 'face', pick: 'rightmost' });
    expect(left).toEqual({ kind: 'box', box: { left: 200, top: 0, right: 300, bottom: 100 } }); // narrow
    expect(right).toEqual({ kind: 'box', box: { left: 100, top: 0, right: 600, bottom: 100 } }); // wide
  });

  it("'confidence' pick stays detection-order, unaffected by the spatial-pick convention", () => {
    // Same wide/narrow pair, but detection order lists the NARROW box first —
    // 'confidence' (the default) must still return it by position, not by any
    // spatial measure.
    const detWideNarrow: DetectionResult = {
      image: { width: 1000, height: 1000 },
      backends: {},
      faces: [
        { bbox: [200, 0, 300, 100], confidence: 0.5 }, // narrow, listed first
        { bbox: [100, 0, 600, 100], confidence: 0.9 }, // wide, higher confidence but listed second
      ],
    };
    const a = localizeAnchor(detWideNarrow, { kind: 'face' });
    expect(a).toEqual({ kind: 'box', box: { left: 200, top: 0, right: 300, bottom: 100 } }); // narrow, index 0
  });

  it('localizeAnchors reports MISSING anchors instead of dropping them', () => {
    const { anchors, missing } = localizeAnchors(det, {
      faceL: { kind: 'face', pick: 'leftmost' },
      faceR: { kind: 'face', pick: 'rightmost' },
      dog: { kind: 'object', label: 'dog' },
    });
    expect(Object.keys(anchors).sort()).toEqual(['faceL', 'faceR']);
    expect(missing).toEqual(['dog']);
  });
});
