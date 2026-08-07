import { describe, it, expect } from 'vitest';
import {
  resampleByArcLength,
  sampleCurveAtLengths,
  curveLength,
  warpAlongCurve,
  warpRadial,
  farEndLift,
  smoothCurve,
  activeLayerBounds,
} from '@editmamei/perception/grounding-warp.ts';

/**
 * Grounded-warp geometry — the pure "curve → destination mesh" math. The PS quilt
 * application is the live-verified `warpMesh` RAW path; here we pin the geometry:
 * arc-length resampling, the centerline landing ON the curve, thickness offset by
 * the perpendicular normal, and the row-major ordering the snippet consumes.
 */

describe('resampleByArcLength', () => {
  it('spaces points evenly by arc length on a straight line, with the left-normal', () => {
    const s = resampleByArcLength(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      3
    );
    expect(s.map((p) => p.point.x)).toEqual([0, 5, 10]);
    expect(s.every((p) => p.point.y === 0)).toBe(true);
    // tangent (1,0) → left-normal (0,1)
    expect(Math.abs(s[0].normal.x)).toBeLessThan(1e-9);
    expect(s[0].normal.y).toBeCloseTo(1, 9);
  });

  it('walks segments by cumulative length on a multi-segment (L) curve', () => {
    // seg lengths 3 then 4, total 7; count 8 → targets at integer lengths 0..7.
    const s = resampleByArcLength(
      [
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 4, y: 3 },
      ],
      8
    );
    expect(s[3].point).toEqual({ x: 0, y: 3 }); // length 3 = the corner
    expect(s[4].point.x).toBeCloseTo(1, 9); // length 4 = 1 into the 2nd segment
    expect(s[4].point.y).toBeCloseTo(3, 9);
    expect(s[7].point).toEqual({ x: 4, y: 3 }); // full length = the end
  });

  it('rejects degenerate input', () => {
    expect(() => resampleByArcLength([{ x: 0, y: 0 }], 3)).toThrow(/at least 2 points/);
    expect(() =>
      resampleByArcLength(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        1
      )
    ).toThrow(/at least 2/);
    expect(() =>
      resampleByArcLength(
        [
          { x: 5, y: 5 },
          { x: 5, y: 5 },
        ],
        3
      )
    ).toThrow(/zero length/);
    expect(() =>
      resampleByArcLength(
        [
          { x: 0, y: 0 },
          { x: NaN, y: 1 },
        ],
        3
      )
    ).toThrow(/non-finite/);
  });
});

describe('curveLength / sampleCurveAtLengths', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  it('curveLength sums the segments', () => {
    expect(curveLength(line)).toBe(100);
    expect(
      curveLength([
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 4, y: 3 },
      ])
    ).toBe(7);
  });

  it('samples at explicit arc-lengths and clamps out-of-range to the endpoints', () => {
    const s = sampleCurveAtLengths(line, [0, 40, 100, 150, -10]);
    expect(s.map((p) => p.point.x)).toEqual([0, 40, 100, 100, 0]); // 150→end, −10→start
    expect(s.every((p) => p.point.y === 0)).toBe(true);
  });
});

describe('smoothCurve', () => {
  it('halves a single spike toward its neighbors, endpoints fixed', () => {
    const s = smoothCurve(
      [
        { x: 0, y: 0 },
        { x: 1, y: 10 },
        { x: 2, y: 0 },
      ],
      1
    );
    expect(s[0]).toEqual({ x: 0, y: 0 }); // endpoint fixed
    expect(s[2]).toEqual({ x: 2, y: 0 }); // endpoint fixed
    expect(s[1]).toEqual({ x: 1, y: 5 }); // ½·10 + ¼·0 + ¼·0
  });

  it('leaves an evenly-spaced straight line unchanged', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    expect(smoothCurve(line, 3)).toEqual(line);
  });

  it('is a no-op for <3 points or ≤0 iterations', () => {
    const two = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(smoothCurve(two, 5)).toEqual(two);
    const three = [
      { x: 0, y: 0 },
      { x: 1, y: 9 },
      { x: 2, y: 0 },
    ];
    expect(smoothCurve(three, 0)).toEqual(three);
  });

  it('progressively damps jitter with more passes (monotone toward the chord)', () => {
    const jagged = [
      { x: 0, y: 0 },
      { x: 1, y: 8 },
      { x: 2, y: 0 },
    ];
    const one = smoothCurve(jagged, 1)[1].y; // 4
    const three = smoothCurve(jagged, 3)[1].y; // < 4, still > 0
    expect(one).toBeCloseTo(4, 9);
    expect(three).toBeLessThan(one);
    expect(three).toBeGreaterThan(0);
  });
});

describe('warpAlongCurve', () => {
  it('fit=stretch spans the whole curve; fit=preserve runs at natural 1:1 scale', () => {
    // A length-100 straight curve, a layer only 40 wide (along = width for horizontal).
    const curve = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const bounds = { left: 0, top: 0, right: 40, bottom: 4 };
    const stretch = warpAlongCurve(bounds, curve, {
      runAxis: 'horizontal',
      alongCells: 1,
      acrossCells: 2,
      fit: 'stretch',
    });
    const preserve = warpAlongCurve(bounds, curve, {
      runAxis: 'horizontal',
      alongCells: 1,
      acrossCells: 2,
      fit: 'preserve',
    });
    // Centerline (rj=3, ncols=4): last point index 15. Stretch reaches the curve end
    // (x=100, full coverage); preserve reaches only the layer's own length (x=40).
    expect(stretch.curveCovered).toBe(1);
    expect(stretch.meshPoints[15].x).toBeCloseTo(100, 6);
    expect(preserve.curveCovered).toBeCloseTo(0.4, 6);
    expect(preserve.meshPoints[15].x).toBeCloseTo(40, 6);
  });

  it('fit=preserve caps at the curve end when the layer is longer than the curve', () => {
    const curve = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const bounds = { left: 0, top: 0, right: 200, bottom: 4 }; // along 200 > curve 100
    const res = warpAlongCurve(bounds, curve, {
      runAxis: 'horizontal',
      alongCells: 1,
      acrossCells: 2,
      fit: 'preserve',
    });
    expect(res.curveCovered).toBe(1); // can't exceed the curve → full coverage
    expect(res.meshPoints[15].x).toBeCloseTo(100, 6);
  });

  it('smooth>0 damps a jagged curve so the centerline pulls toward the chord', () => {
    // A single mid-spike; the centerline control point should move toward y=0 (the
    // endpoints' line) with smoothing vs. exactly following the spike without it.
    const jag = [
      { x: 0, y: 100 },
      { x: 5, y: 160 },
      { x: 10, y: 100 },
    ];
    const bounds = { left: 0, top: 0, right: 10, bottom: 2 };
    const raw = warpAlongCurve(bounds, jag, {
      runAxis: 'horizontal',
      alongCells: 1,
      acrossCells: 2,
      smooth: 0,
    });
    const sm = warpAlongCurve(bounds, jag, {
      runAxis: 'horizontal',
      alongCells: 1,
      acrossCells: 2,
      smooth: 3,
    });
    // Centerline row rj=3 (v=0.5 → offset 0): its control points sit ON the curve. The
    // spike's peak y (max, since y grows downward) is damped toward the endpoints (y=100).
    const peakRaw = Math.max(...raw.meshPoints.slice(12, 16).map((p) => p.y));
    const peakSm = Math.max(...sm.meshPoints.slice(12, 16).map((p) => p.y));
    expect(peakSm).toBeLessThan(peakRaw); // smoothing lowers the spike toward the chord
  });

  it('horizontal run: centerline lands on the curve, thickness offset by the normal', () => {
    // Layer 10×4 laid onto a horizontal curve at y=10 (length 10).
    const res = warpAlongCurve(
      { left: 0, top: 0, right: 10, bottom: 4 },
      [
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ],
      { runAxis: 'horizontal', alongCells: 1, acrossCells: 2 }
    );
    expect(res.ncx).toBe(1);
    expect(res.ncy).toBe(2);
    expect(res.ncols).toBe(4);
    expect(res.nrows).toBe(7);
    expect(res.meshPoints).toHaveLength(28);
    // Centerline row rj=3 (v=0.5): indices 12..15, on the curve (y=10), x by arc length.
    const centerline = res.meshPoints.slice(12, 16);
    expect(centerline.map((p) => Math.round(p.x * 100) / 100)).toEqual([0, 3.33, 6.67, 10]);
    expect(centerline.every((p) => Math.abs(p.y - 10) < 1e-9)).toBe(true);
    // Top row (rj=0, v=0) offset −H/2 along normal (0,1) → y=8; bottom row (rj=6) → y=12.
    expect(res.meshPoints[0].y).toBeCloseTo(8, 9);
    expect(res.meshPoints[24].y).toBeCloseTo(12, 9);
    expect(res.destBBox).toEqual({ left: 0, top: 8, right: 10, bottom: 12 });
  });

  it('vertical run: the layer HEIGHT follows the curve and ncx/ncy swap', () => {
    // Layer 4×10 laid onto a vertical curve at x=5 (length 10).
    const res = warpAlongCurve(
      { left: 0, top: 0, right: 4, bottom: 10 },
      [
        { x: 5, y: 0 },
        { x: 5, y: 10 },
      ],
      { runAxis: 'vertical', alongCells: 1, acrossCells: 2 }
    );
    // vertical → rows follow the curve: ncy = alongCells=1, ncx = acrossCells=2.
    expect(res.ncx).toBe(2);
    expect(res.ncy).toBe(1);
    expect(res.ncols).toBe(7);
    expect(res.nrows).toBe(4);
    // Centerline is col ci=3 (v=0.5): x on the curve (=5), y by arc length down the run.
    const centerCol = [0, 1, 2, 3].map((rj) => res.meshPoints[rj * 7 + 3]);
    expect(centerCol.every((p) => Math.abs(p.x - 5) < 1e-9)).toBe(true);
    expect(centerCol.map((p) => Math.round(p.y * 100) / 100)).toEqual([0, 3.33, 6.67, 10]);
    // Thickness spread across x: normal of the vertical (0,1) tangent is (-1,0) → x = 5 ± 2.
    expect(res.destBBox.left).toBeCloseTo(3, 9);
    expect(res.destBBox.right).toBeCloseTo(7, 9);
  });

  it('bends: a diagonal curve offsets the thickness perpendicular to it', () => {
    // 45° curve; the across offset must move along the (−0.707, 0.707) normal.
    const res = warpAlongCurve(
      { left: 0, top: 0, right: 10, bottom: 2 },
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      { runAxis: 'horizontal', alongCells: 1, acrossCells: 2 }
    );
    // Top row (rj=0, v=0, off=−1) at the along-start (ci=0, curve point (0,0)):
    // (0,0) + (−0.707,0.707)*(−1) = (0.707, −0.707).
    expect(res.meshPoints[0].x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(res.meshPoints[0].y).toBeCloseTo(-Math.SQRT1_2, 6);
  });
});

describe('warpRadial', () => {
  // 100×100 layer, center (50,50), radius 50, cells 2 → 7×7 grid with a control
  // point exactly at the center (index 24) and on the radius (index 27).
  const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
  const center = { x: 50, y: 50 };

  it('leaves the center point and points at/beyond the radius unmoved', () => {
    const res = warpRadial(bounds, center, 50, 0.5, { cells: 2 });
    expect(res.ncols).toBe(7);
    expect(res.nrows).toBe(7);
    expect(res.meshPoints).toHaveLength(49);
    expect(res.meshPoints[24]).toEqual({ x: 50, y: 50 }); // exact center → v=0 → no move
    expect(res.meshPoints[27]).toEqual({ x: 100, y: 50 }); // r=radius → w=0 → no move
    expect(res.meshPoints[0]).toEqual({ x: 0, y: 0 }); // corner, r>radius → no move
  });

  it('bulge (amount>0) pushes an interior point OUTWARD by v·amount·w', () => {
    const res = warpRadial(bounds, center, 50, 0.5, { cells: 2 });
    // point (ci=4, rj=3) home (66.67,50): v=(16.67,0), u=1/3, w=(1−1/9)²=0.7901
    // dx = 16.667·0.5·0.7901 = 6.58 → x ≈ 73.25, y stays 50.
    const p = res.meshPoints[3 * 7 + 4];
    expect(p.x).toBeCloseTo(73.25, 1);
    expect(p.y).toBeCloseTo(50, 6);
    expect(res.maxDisplacement).toBeGreaterThan(0);
    // The corners (r>radius) don't move and stay the bbox extremes; interior points
    // push outward but not past them → destBBox equals the layer bounds here.
    expect(res.destBBox).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
  });

  it('pinch (amount<0) pulls the same point INWARD toward the center', () => {
    const res = warpRadial(bounds, center, 50, -0.5, { cells: 2 });
    const p = res.meshPoints[3 * 7 + 4];
    expect(p.x).toBeCloseTo(60.08, 1); // 66.67 − 6.58
    expect(p.x).toBeLessThan(66.67);
  });
});

describe('farEndLift', () => {
  it('horizontal run (pin left/right): lift is target.y minus the vertical mid-line', () => {
    const bounds = { left: 0, top: 0, right: 100, bottom: 40 }; // mid-line y = 20
    expect(farEndLift(bounds, 'left', { x: 80, y: 5 })).toBe(-15); // raise far end up 15
    expect(farEndLift(bounds, 'right', { x: 10, y: 35 })).toBe(15); // lower far end down 15
  });

  it('vertical run (pin top/bottom): lift is target.x minus the horizontal mid-line', () => {
    const bounds = { left: 0, top: 0, right: 40, bottom: 100 }; // mid-line x = 20
    expect(farEndLift(bounds, 'top', { x: 35, y: 80 })).toBe(15);
    expect(farEndLift(bounds, 'bottom', { x: 5, y: 10 })).toBe(-15);
  });
});

describe('activeLayerBounds', () => {
  it('extracts finite layer bounds from a getContextInfo snapshot', () => {
    const ctx = { activeLayer: { bounds: { left: 10, top: 20, right: 110, bottom: 220 } } };
    expect(activeLayerBounds(ctx)).toEqual({ left: 10, top: 20, right: 110, bottom: 220 });
  });

  it('throws when bounds are missing or empty', () => {
    expect(() => activeLayerBounds(undefined)).toThrow(/active layer/i);
    expect(() => activeLayerBounds({})).toThrow(/active layer/i);
    expect(() =>
      activeLayerBounds({ activeLayer: { bounds: { left: 5, top: 5, right: 5, bottom: 50 } } })
    ).toThrow(/empty bounds/i);
  });
});
