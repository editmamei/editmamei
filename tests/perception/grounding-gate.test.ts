import { describe, it, expect } from 'vitest';
import { runGate, type GateSpec } from '@editmamei/perception/grounding-gate.ts';
import type { Polyline } from '@editmamei/perception/grounding-geometry.ts';

// The internal geometric gate, driven END-TO-END on REAL geometry (review W2):
// the gate MEASURES margin/side/intersection/area itself — the tests never hand
// it a pre-decided verdict. The under_eye defect is reproduced by CONSTRUCTING an
// overlapping curve and asserting the gate computes the negative clearance.

const CANVAS = { width: 2316, height: 3088 };

/** A realistic lower-eyelid source arc (shallow smile), sampled across x. */
function lowerLid(): Polyline {
  const pts: Polyline = [];
  for (let x = 300; x <= 500; x += 20) pts.push({ x, y: 1000 + 0.001 * (x - 400) ** 2 });
  return pts;
}
/** The proposed under-eye line, offset `dy` px below the lid (dy>0 = correct 'down' side). */
function underEyeLine(dy: number): Polyline {
  return lowerLid().map((p) => ({ x: p.x, y: p.y + dy }));
}

describe('grounding gate — point', () => {
  it('passes an in-canvas, well-separated midpoint', () => {
    const spec: GateSpec = {
      target: 'point',
      point: { x: 1090, y: 1025 },
      canvas: CANVAS,
      anchors: [
        { x: 698, y: 1191 },
        { x: 1482, y: 859 },
      ],
    };
    const r = runGate(spec);
    expect(r.pass).toBe(true);
    expect(r.measured.anchorSeparation).toBeGreaterThan(800);
  });

  it('rejects an off-canvas point (computed, not asserted)', () => {
    const r = runGate({ target: 'point', point: { x: -220, y: 40 }, canvas: CANVAS });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/outside canvas/);
  });

  it('rejects a degenerate midpoint by MEASURING anchor separation', () => {
    const r = runGate({
      target: 'point',
      point: { x: 100, y: 100 },
      canvas: CANVAS,
      anchors: [
        { x: 100, y: 100 },
        { x: 100.5, y: 100.5 },
      ],
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/degenerate/);
    expect(r.measured.anchorSeparation).toBeLessThan(2);
  });

  it('rejects a point outside the expected region for the relation', () => {
    const r = runGate({
      target: 'point',
      point: { x: 50, y: 50 },
      canvas: CANVAS,
      withinBounds: { left: 600, top: 800, right: 1500, bottom: 1300 },
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/expected region/);
  });
});

describe('grounding gate — offset-curve (the under_eye class)', () => {
  const source = lowerLid();

  it('passes a line placed the required distance BELOW the lid', () => {
    const r = runGate({
      target: 'path',
      kind: 'offset-curve',
      curve: underEyeLine(15),
      source,
      side: 'down',
      requiredMargin: 8,
      canvas: CANVAS,
    });
    expect(r.pass).toBe(true);
    expect(r.measured.minMargin).toBeCloseTo(15, 5);
  });

  it('reproduces the audited under_eye defect: a curve 22px ABOVE the lid → COMPUTED negative clearance', () => {
    // Construct the overlapping curve; the gate must MEASURE minMargin ≈ -22.
    const r = runGate({
      target: 'path',
      kind: 'offset-curve',
      curve: underEyeLine(-22),
      source,
      side: 'down',
      requiredMargin: 8,
      canvas: CANVAS,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/wrong side/);
    expect(r.measured.minMargin).toBeCloseTo(-22, 5);
    expect(r.measured.sideOk).toBe(false);
  });

  it('corruption sweep: verdict flips exactly where COMPUTED clearance crosses the required margin', () => {
    const required = 8;
    for (let dy = -30; dy <= 30; dy += 1) {
      const r = runGate({
        target: 'path',
        kind: 'offset-curve',
        curve: underEyeLine(dy),
        source,
        side: 'down',
        requiredMargin: required,
        canvas: CANVAS,
      });
      // measured clearance tracks the real translation, independent of the verdict
      expect(r.measured.minMargin as number).toBeCloseTo(dy, 5);
      if (dy >= required) expect(r.pass).toBe(true);
      else expect(r.pass).toBe(false);
      if (dy <= 0) expect(r.reason).toMatch(/wrong side/);
      else if (dy < required) expect(r.reason).toMatch(/clearance .* < required/);
    }
  });

  it('rejects a curve that enters an exclusion region even with positive clearance to the source', () => {
    // A blemish/eye box to avoid, sitting BELOW the lid where a valid-margin
    // curve could still clip it. Curve clears the lid (dy=20) but dips through the box.
    const curve: Polyline = [
      { x: 300, y: 1020 },
      { x: 400, y: 1200 }, // dips down into the box
      { x: 500, y: 1020 },
    ];
    const r = runGate({
      target: 'path',
      kind: 'offset-curve',
      curve,
      source,
      side: 'down',
      requiredMargin: 8,
      exclusion: { kind: 'box', box: { left: 360, top: 1150, right: 440, bottom: 1250 } },
      canvas: CANVAS,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/exclusion/);
    expect(r.measured.intersectsExclusion).toBe(true);
  });
});

describe('grounding gate — edge confidence + region', () => {
  const canvas = { width: 1000, height: 1000 };

  it('passes a strong edge, rejects a weak one by MEASURING the min confidence', () => {
    const curve: Polyline = [
      { x: 10, y: 10 },
      { x: 20, y: 12 },
      { x: 30, y: 11 },
    ];
    const strong = runGate({
      target: 'path',
      kind: 'edge',
      curve,
      confidences: [99, 120, 105],
      minConfidence: 40,
      canvas,
    });
    expect(strong.pass).toBe(true);
    const weak = runGate({
      target: 'path',
      kind: 'edge',
      curve,
      confidences: [99, 20, 105], // one weak point (the jaw-fails case)
      minConfidence: 40,
      canvas,
    });
    expect(weak.pass).toBe(false);
    expect(weak.measured.minConfidence).toBe(20);
    expect(weak.reason).toMatch(/weak\/absent boundary/);
  });

  it('rejects a confidence/curve length mismatch', () => {
    const r = runGate({
      target: 'path',
      kind: 'edge',
      curve: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
      confidences: [50],
      minConfidence: 40,
      canvas,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/count/);
  });

  it('passes a plausible region and rejects a whole-frame one by MEASURING area fraction', () => {
    const small: Polyline = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ];
    const ok = runGate({ target: 'region', polygon: small, canvas });
    expect(ok.pass).toBe(true);
    expect(ok.measured.area).toBe(10000);

    const whole: Polyline = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ];
    const big = runGate({ target: 'region', polygon: whole, canvas });
    expect(big.pass).toBe(false);
    expect(big.measured.areaFraction).toBe(1);
    expect(big.reason).toMatch(/implausibly large/);
  });

  it('rejects an empty/degenerate region', () => {
    const r = runGate({
      target: 'region',
      polygon: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      canvas,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/empty region/);
  });
});

describe('grounding gate — curve (trusted mesh/landmark contour)', () => {
  const canvas = { width: 1000, height: 1000 };

  it('passes an on-canvas, non-degenerate curve', () => {
    const r = runGate({
      target: 'path',
      kind: 'curve',
      curve: [
        { x: 100, y: 200 },
        { x: 300, y: 250 },
        { x: 500, y: 210 },
      ],
      canvas,
    });
    expect(r.pass).toBe(true);
    expect(r.measured.on_canvas).toBe(true);
    expect(r.measured.points).toBe(3);
  });

  it('rejects a curve that runs off canvas', () => {
    const r = runGate({
      target: 'path',
      kind: 'curve',
      curve: [
        { x: 100, y: 200 },
        { x: 1100, y: 250 }, // x > width → off-canvas (a face at the frame edge)
      ],
      canvas,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/off canvas/);
    expect(r.measured.on_canvas).toBe(false);
  });

  it('rejects a degenerate (near-zero-length) curve', () => {
    const r = runGate({
      target: 'path',
      kind: 'curve',
      curve: [
        { x: 500, y: 500 },
        { x: 500.5, y: 500 },
      ],
      canvas,
      minLength: 2,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/degenerate/);
  });
});
