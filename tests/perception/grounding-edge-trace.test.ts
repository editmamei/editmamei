import { describe, it, expect } from 'vitest';
import { traceEdge, edgeAnchor } from '@editmamei/perception/grounding-edge-trace.ts';
import type { RgbaImage } from '@editmamei/perception/grounding-review-crop.ts';
import { resolve } from '@editmamei/perception/grounding-resolver.ts';
import { runGate } from '@editmamei/perception/grounding-gate.ts';

// The classical-CV edge tracer — pure, on synthetic buffers. A strong edge traces
// cleanly with high confidence; a uniform region self-flags low (gate rejects).

function fill(w: number, h: number, at: (x: number, y: number) => number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = at(x, y);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}
const REGION = { left: 0, top: 0, right: 99, bottom: 99 };

describe('traceEdge', () => {
  it('traces a horizontal edge (black-over-white) with high confidence', () => {
    const img = fill(100, 100, (_x, y) => (y < 50 ? 0 : 255));
    const t = traceEdge(img, { region: REGION, orientation: 'horizontal-edge', samples: 10 });
    expect(t.polyline.length).toBe(10);
    for (const p of t.polyline) expect(p.y).toBeGreaterThanOrEqual(48);
    for (const p of t.polyline) expect(p.y).toBeLessThanOrEqual(52);
    expect(t.meanConfidence).toBeGreaterThan(200);
    expect(Math.min(...t.confidences)).toBeGreaterThan(200);
  });

  it('traces a vertical edge (left-black/right-white)', () => {
    const img = fill(100, 100, (x, _y) => (x < 50 ? 0 : 255));
    const t = traceEdge(img, { region: REGION, orientation: 'vertical-edge', samples: 10 });
    for (const p of t.polyline) {
      expect(p.x).toBeGreaterThanOrEqual(48);
      expect(p.x).toBeLessThanOrEqual(52);
    }
    expect(t.meanConfidence).toBeGreaterThan(200);
  });

  it('self-flags a uniform region with near-zero confidence (the jaw-fails class)', () => {
    const img = fill(100, 100, () => 128);
    const t = traceEdge(img, { region: REGION, orientation: 'horizontal-edge', samples: 10 });
    expect(t.meanConfidence).toBeLessThan(5);
  });
});

describe('edge tracer → anchor → resolve(along) → gate(edge) SPINE', () => {
  const canvas = { width: 100, height: 100 };

  it('a strong traced edge resolves + PASSES the gate', () => {
    const img = fill(100, 100, (_x, y) => (y < 50 ? 0 : 255));
    const t = traceEdge(img, { region: REGION, orientation: 'horizontal-edge', samples: 12 });
    const anchors = { edge: edgeAnchor(t) };
    const g = resolve({ type: 'along', curve: 'edge' }, anchors, { frame: canvas });
    if (g.target !== 'path' || g.kind !== 'along') throw new Error('unreachable');
    const r = runGate({
      target: 'path',
      kind: 'edge',
      curve: g.curve,
      confidences: t.confidences,
      minConfidence: 40,
      canvas,
    });
    expect(r.pass).toBe(true);
    expect(r.measured.minConfidence as number).toBeGreaterThan(40);
  });

  it('a weak (uniform) traced edge is REJECTED by the gate', () => {
    const img = fill(100, 100, () => 128);
    const t = traceEdge(img, { region: REGION, orientation: 'horizontal-edge', samples: 12 });
    const anchors = { edge: edgeAnchor(t) };
    const g = resolve({ type: 'along', curve: 'edge' }, anchors, { frame: canvas });
    if (g.target !== 'path' || g.kind !== 'along') throw new Error('unreachable');
    const r = runGate({
      target: 'path',
      kind: 'edge',
      curve: g.curve,
      confidences: t.confidences,
      minConfidence: 40,
      canvas,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/weak\/absent boundary/);
  });
});
