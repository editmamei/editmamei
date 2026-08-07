import { describe, it, expect } from 'vitest';
import { mapDetectionToDoc, type DetectionResult } from '@editmamei/detection/detection-client.ts';

// mapDetectionToDoc is the coordinate-frame chokepoint: detection runs on a
// downscaled export, so every box must scale back to document pixels before a
// PS op acts on it. These pin that scaling + the self-describing image rewrite.

describe('mapDetectionToDoc', () => {
  it('scales faces + objects to doc px and rewrites image dims', () => {
    const r: DetectionResult = {
      image: { width: 500, height: 1000 },
      backends: { faces: 'ultraface', objects: 'dfine-s' },
      faces: [{ bbox: [50, 100, 150, 300], confidence: 0.9 }],
      objects: [{ label: 'dog', class_id: 16, bbox: [0, 0, 250, 500], confidence: 0.8 }],
    };
    const m = mapDetectionToDoc(r, 1000, 2000); // 2× on both axes
    expect(m.image).toEqual({ width: 1000, height: 2000 });
    expect(m.faces?.[0].bbox).toEqual([100, 200, 300, 600]);
    expect(m.objects?.[0].bbox).toEqual([0, 0, 500, 1000]);
  });

  it('scales x and y independently (non-uniform aspect)', () => {
    const r: DetectionResult = {
      image: { width: 100, height: 100 },
      backends: { objects: 'dfine-s' },
      objects: [{ label: 'car', class_id: 2, bbox: [10, 10, 20, 20], confidence: 0.7 }],
    };
    const m = mapDetectionToDoc(r, 300, 500); // sx=3, sy=5
    expect(m.objects?.[0].bbox).toEqual([30, 50, 60, 100]);
  });

  it('preserves label, class_id, confidence, and backends', () => {
    const r: DetectionResult = {
      image: { width: 100, height: 100 },
      backends: { faces: 'ultraface', objects: 'dfine-s' },
      objects: [{ label: 'cat', class_id: 15, bbox: [10, 10, 20, 20], confidence: 0.42 }],
    };
    const m = mapDetectionToDoc(r, 100, 100);
    expect(m.objects?.[0].label).toBe('cat');
    expect(m.objects?.[0].class_id).toBe(15);
    expect(m.objects?.[0].confidence).toBe(0.42);
    expect(m.backends).toEqual({ faces: 'ultraface', objects: 'dfine-s' });
  });

  it('omits an absent stream rather than emitting an empty key', () => {
    const r: DetectionResult = {
      image: { width: 100, height: 100 },
      backends: { faces: 'ultraface' },
      faces: [],
    };
    const m = mapDetectionToDoc(r, 200, 200);
    expect(m.faces).toEqual([]);
    expect(m.objects).toBeUndefined();
  });

  it('scales Pro face-mesh feature points to doc px (z carried through)', () => {
    const r: DetectionResult = {
      image: { width: 100, height: 200 },
      backends: { faces: 'ultraface+facemesh-468' },
      faces: [
        {
          bbox: [10, 20, 30, 40],
          confidence: 0.9,
          features: {
            backend: 'facemesh-468',
            score: 0.97,
            points: [
              { x: 10, y: 20, z: 5 },
              { x: 50, y: 100, z: -3 },
            ],
          },
        },
      ],
    };
    const m = mapDetectionToDoc(r, 300, 800); // sx=3, sy=4
    const feat = m.faces?.[0].features;
    expect(feat?.backend).toBe('facemesh-468');
    expect(feat?.score).toBe(0.97);
    expect(feat?.points).toEqual([
      { x: 30, y: 80, z: 5 },
      { x: 150, y: 400, z: -3 },
    ]);
    // bbox scales on the same factors.
    expect(m.faces?.[0].bbox).toEqual([30, 80, 90, 160]);
  });

  it('leaves a face without features unchanged (no empty features key)', () => {
    const r: DetectionResult = {
      image: { width: 100, height: 100 },
      backends: { faces: 'ultraface' },
      faces: [{ bbox: [10, 10, 20, 20], confidence: 0.8 }],
    };
    const m = mapDetectionToDoc(r, 200, 200);
    expect(m.faces?.[0]).not.toHaveProperty('features');
  });

  it('clamps an out-of-bounds detector box into doc bounds and normalizes order', () => {
    const r: DetectionResult = {
      image: { width: 100, height: 100 },
      backends: { objects: 'dfine-s' },
      objects: [
        // Box runs off both edges and is reversed (x2<x1) — must clamp to
        // [0, doc] and reorder to x1<=x2 / y1<=y2.
        { label: 'person', class_id: 0, bbox: [120, -20, -10, 130], confidence: 0.9 },
      ],
    };
    const m = mapDetectionToDoc(r, 100, 100); // sx=sy=1
    // x1=120→100, x2=-10→0 → reorder → [0, ..., 100]; y1=-20→0, y2=130→100.
    expect(m.objects?.[0].bbox).toEqual([0, 0, 100, 100]);
  });
});
