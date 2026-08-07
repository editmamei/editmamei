import { describe, it, expect } from 'vitest';
import {
  dist,
  boundsOf,
  interpolateCurveAt,
  signedGapToCurve,
  minSignedGap,
  polygonArea,
  pointInBox,
  pointInPolygon,
  segmentsIntersect,
  polylineIntersectsRegion,
  type Polyline,
} from '@editmamei/perception/grounding-geometry.ts';

// Pure geometry the grounding gate measures with — no Photoshop, no decode.
// These pin the math the gate's verdicts depend on.

describe('grounding-geometry primitives', () => {
  it('dist + boundsOf', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(
      boundsOf([
        { x: 1, y: 5 },
        { x: 9, y: 2 },
        { x: 4, y: 8 },
      ])
    ).toEqual({
      left: 1,
      top: 2,
      right: 9,
      bottom: 8,
    });
    expect(() => boundsOf([])).toThrow();
  });

  it('interpolateCurveAt reads the other coordinate, sorting + clamping', () => {
    const line: Polyline = [
      { x: 0, y: 100 },
      { x: 100, y: 200 },
    ];
    expect(interpolateCurveAt(line, 50, 'x')).toBe(150); // midpoint y
    expect(interpolateCurveAt(line, 0, 'x')).toBe(100); // endpoint
    expect(interpolateCurveAt(line, -20, 'x')).toBe(100); // clamp low
    expect(interpolateCurveAt(line, 999, 'x')).toBe(200); // clamp high
    // unsorted input still works
    const rev: Polyline = [
      { x: 100, y: 200 },
      { x: 0, y: 100 },
    ];
    expect(interpolateCurveAt(rev, 25, 'x')).toBe(125);
    // by y axis
    expect(interpolateCurveAt(line, 150, 'y')).toBe(50);
    // single point
    expect(interpolateCurveAt([{ x: 7, y: 9 }], 3, 'x')).toBe(9);
  });

  it('signedGapToCurve is positive on the requested side, negative on the wrong side', () => {
    const horiz: Polyline = [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    // 'down' = larger y is positive
    expect(signedGapToCurve({ x: 50, y: 130 }, horiz, 'down')).toBe(30);
    expect(signedGapToCurve({ x: 50, y: 80 }, horiz, 'down')).toBe(-20); // above = wrong side
    expect(signedGapToCurve({ x: 50, y: 80 }, horiz, 'up')).toBe(20);
    const vert: Polyline = [
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(signedGapToCurve({ x: 130, y: 50 }, vert, 'right')).toBe(30);
    expect(signedGapToCurve({ x: 70, y: 50 }, vert, 'right')).toBe(-30);
    expect(signedGapToCurve({ x: 70, y: 50 }, vert, 'left')).toBe(30);
  });

  it('minSignedGap returns the worst-case clearance over the whole curve', () => {
    const source: Polyline = [
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    const offset: Polyline = [
      { x: 0, y: 120 },
      { x: 50, y: 108 }, // the worst (closest) point
      { x: 100, y: 130 },
    ];
    expect(minSignedGap(offset, source, 'down')).toBe(8);
    expect(() => minSignedGap([], source, 'down')).toThrow();
  });

  it('polygonArea (shoelace)', () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ])
    ).toBe(100);
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ])
    ).toBe(50);
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ])
    ).toBe(0); // degenerate
  });

  it('pointInBox + pointInPolygon', () => {
    const box = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(pointInBox({ x: 5, y: 5 }, box)).toBe(true);
    expect(pointInBox({ x: 15, y: 5 }, box)).toBe(false);
    const poly: Polyline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, poly)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, poly)).toBe(false);
  });

  it('segmentsIntersect only for a proper crossing', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })
    ).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 })).toBe(
      false
    );
  });

  it('polylineIntersectsRegion catches vertex-inside AND pass-through', () => {
    const region = { kind: 'box' as const, box: { left: 0, top: 0, right: 10, bottom: 10 } };
    // passes vertically THROUGH the box with no vertex inside
    expect(
      polylineIntersectsRegion(
        [
          { x: 5, y: -5 },
          { x: 5, y: 15 },
        ],
        region
      )
    ).toBe(true);
    // a vertex lands inside
    expect(
      polylineIntersectsRegion(
        [
          { x: 5, y: 5 },
          { x: 50, y: 50 },
        ],
        region
      )
    ).toBe(true);
    // clear of the box
    expect(
      polylineIntersectsRegion(
        [
          { x: 20, y: 20 },
          { x: 30, y: 30 },
        ],
        region
      )
    ).toBe(false);
  });
});
