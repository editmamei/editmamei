import { describe, it, expect } from 'vitest';
import {
  resolve,
  resolveLength,
  trimByArcLength,
  centerOf,
  type Anchors,
  type ResolveContext,
} from '@editmamei/perception/grounding-resolver.ts';
import { runGate } from '@editmamei/perception/grounding-gate.ts';
import type { Polyline } from '@editmamei/perception/grounding-geometry.ts';

// The relation resolver — pure closed-form arithmetic over localized anchors —
// and the resolve→gate SPINE composed end-to-end (the redesign's core loop).

const CTX: ResolveContext = { frame: { width: 2316, height: 3088 } };
const CANVAS = { width: 2316, height: 3088 };

// Real detected face boxes from the two-face portrait (report E4).
const faceR = { kind: 'box' as const, box: { left: 1142, top: 367, right: 1822, bottom: 1350 } };
const faceL = { kind: 'box' as const, box: { left: 306, top: 645, right: 1090, bottom: 1738 } };

describe('resolver — point relations', () => {
  it('midpoint reproduces the E4 "halfway between the two faces" = (1090,1025)', () => {
    const g = resolve({ type: 'midpoint', anchors: ['faceL', 'faceR'] }, { faceL, faceR }, CTX);
    expect(g.target).toBe('point');
    if (g.target !== 'point') throw new Error('unreachable');
    expect(g.point.x).toBeCloseTo(1090, 0);
    expect(g.point.y).toBeCloseTo(1025, 0);
  });

  it('midpoint honors the t fraction', () => {
    const g = resolve(
      { type: 'midpoint', anchors: ['faceL', 'faceR'], t: 0 },
      { faceL, faceR },
      CTX
    );
    if (g.target !== 'point') throw new Error('unreachable');
    expect(g.point).toEqual(centerOf(faceL));
  });

  it('centroid = the anchor center', () => {
    const g = resolve({ type: 'centroid', anchor: 'faceR' }, { faceR }, CTX);
    if (g.target !== 'point') throw new Error('unreachable');
    expect(g.point).toEqual(centerOf(faceR));
  });

  it('offset moves the anchor center by a relative distance in a direction', () => {
    const eye = { kind: 'box' as const, box: { left: 700, top: 1000, right: 780, bottom: 1040 } }; // h=40
    // 0.5 * eye height = 20px down from the eye center (750,1020) -> (750,1040)
    const g = resolve(
      {
        type: 'offset',
        from: 'eye',
        direction: 'down',
        distance: { value: 0.5, unit: 'frac-of:eye:h' },
      },
      { eye },
      CTX
    );
    if (g.target !== 'point') throw new Error('unreachable');
    expect(g.point.x).toBeCloseTo(740, 0); // center x = (700+780)/2
    expect(g.point.y).toBeCloseTo(1040, 0);
  });

  it('offset toward another anchor points along the connecting line', () => {
    const a = { kind: 'point' as const, point: { x: 0, y: 0 } };
    const b = { kind: 'point' as const, point: { x: 100, y: 0 } };
    const g = resolve(
      { type: 'offset', from: 'a', direction: 'toward:b', distance: { value: 30, unit: 'px' } },
      { a, b },
      CTX
    );
    if (g.target !== 'point') throw new Error('unreachable');
    expect(g.point).toEqual({ x: 30, y: 0 });
  });

  it('segment — the path analog of midpoint — is a 2-point curve between the anchor centers', () => {
    const g = resolve({ type: 'segment', anchors: ['faceL', 'faceR'] }, { faceL, faceR }, CTX);
    expect(g.target).toBe('path');
    if (g.target !== 'path') throw new Error('unreachable');
    expect(g.kind).toBe('along');
    expect(g.curve).toEqual([centerOf(faceL), centerOf(faceR)]);
  });
});

describe('resolver — unit + curve helpers', () => {
  it('resolveLength: px / frac-diag / frac-of', () => {
    const frameDiag = Math.hypot(2316, 3088); // 3860
    const eye = { kind: 'box' as const, box: { left: 0, top: 0, right: 80, bottom: 40 } };
    expect(resolveLength({ value: 12, unit: 'px' }, {}, frameDiag)).toBe(12);
    expect(resolveLength({ value: 0.01, unit: 'frac-diag' }, {}, frameDiag)).toBeCloseTo(38.6, 1);
    expect(resolveLength({ value: 0.35, unit: 'frac-of:eye:h' }, { eye }, frameDiag)).toBeCloseTo(
      14,
      5
    );
    expect(resolveLength({ value: 0.5, unit: 'frac-of:eye:w' }, { eye }, frameDiag)).toBe(40);
  });

  it('trimByArcLength returns whole curve for [0,1] and a sub-span otherwise', () => {
    const line: Polyline = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(trimByArcLength(line, 0, 1)).toEqual(line);
    const half = trimByArcLength(line, 0.25, 0.75);
    expect(half[0].x).toBeCloseTo(25, 5);
    expect(half[half.length - 1].x).toBeCloseTo(75, 5);
  });
});

describe('resolver → gate SPINE (end to end)', () => {
  const lid: Polyline = [];
  for (let x = 300; x <= 500; x += 20) lid.push({ x, y: 1000 + 0.001 * (x - 400) ** 2 });
  const anchors: Anchors = {
    lid: { kind: 'polyline', polyline: lid },
    eye: { kind: 'box', box: { left: 300, top: 960, right: 500, bottom: 1000 } }, // h=40
  };

  it('offset-curve resolves a line 0.35·eyeH BELOW the lid and the gate PASSES', () => {
    const g = resolve(
      {
        type: 'offset-curve',
        curve: 'lid',
        side: 'down',
        distance: { value: 0.35, unit: 'frac-of:eye:h' },
      },
      anchors,
      CTX
    );
    if (g.target !== 'path' || g.kind !== 'offset-curve') throw new Error('unreachable');
    expect(g.margin).toBeCloseTo(14, 5); // 0.35 * 40
    const r = runGate({
      target: 'path',
      kind: 'offset-curve',
      curve: g.curve,
      source: g.source,
      side: g.side,
      requiredMargin: 8,
      canvas: CANVAS,
    });
    expect(r.pass).toBe(true);
    expect(r.measured.minMargin).toBeCloseTo(14, 5);
  });

  it('too-small an offset resolves a curve the gate REJECTS (clearance < required)', () => {
    const g = resolve(
      {
        type: 'offset-curve',
        curve: 'lid',
        side: 'down',
        distance: { value: 0.1, unit: 'frac-of:eye:h' },
      },
      anchors,
      CTX
    );
    if (g.target !== 'path' || g.kind !== 'offset-curve') throw new Error('unreachable');
    const r = runGate({
      target: 'path',
      kind: 'offset-curve',
      curve: g.curve,
      source: g.source,
      side: g.side,
      requiredMargin: 8,
      canvas: CANVAS,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/clearance .* < required/);
  });

  it('midpoint resolves a point the gate passes; coincident anchors → gate rejects degenerate', () => {
    const g = resolve({ type: 'midpoint', anchors: ['faceL', 'faceR'] }, { faceL, faceR }, CTX);
    if (g.target !== 'point') throw new Error('unreachable');
    const good = runGate({
      target: 'point',
      point: g.point,
      canvas: CANVAS,
      anchors: [centerOf(faceL), centerOf(faceR)],
    });
    expect(good.pass).toBe(true);
    const same = { kind: 'point' as const, point: { x: 500, y: 500 } };
    const gg = resolve({ type: 'midpoint', anchors: ['s', 's'] }, { s: same }, CTX);
    if (gg.target !== 'point') throw new Error('unreachable');
    const bad = runGate({
      target: 'point',
      point: gg.point,
      canvas: CANVAS,
      anchors: [same.point, same.point],
    });
    expect(bad.pass).toBe(false);
    expect(bad.reason).toMatch(/degenerate/);
  });
});

describe('resolver — region relations', () => {
  it('inside shrinks the anchor bbox and the gate passes a plausible region', () => {
    const obj = { kind: 'box' as const, box: { left: 100, top: 100, right: 300, bottom: 300 } };
    const g = resolve(
      { type: 'inside', anchor: 'obj', inset: { value: 10, unit: 'px' } },
      { obj },
      CTX
    );
    if (g.target !== 'region') throw new Error('unreachable');
    const r = runGate({ target: 'region', polygon: g.polygon, canvas: CANVAS });
    expect(r.pass).toBe(true);
    expect(r.measured.area).toBe(180 * 180);
  });

  it('gap between two separated boxes is the rectangle between them', () => {
    const a = { kind: 'box' as const, box: { left: 0, top: 0, right: 100, bottom: 100 } };
    const b = { kind: 'box' as const, box: { left: 200, top: 0, right: 300, bottom: 100 } };
    const g = resolve({ type: 'gap', anchors: ['a', 'b'] }, { a, b }, CTX);
    if (g.target !== 'region') throw new Error('unreachable');
    // rectangle x in [100,200], y in [0,100]
    const xs = g.polygon.map((p) => p.x);
    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBe(200);
  });

  it('gap between overlapping boxes is empty → gate rejects', () => {
    const a = { kind: 'box' as const, box: { left: 0, top: 0, right: 200, bottom: 200 } };
    const b = { kind: 'box' as const, box: { left: 100, top: 100, right: 300, bottom: 300 } };
    const g = resolve({ type: 'gap', anchors: ['a', 'b'] }, { a, b }, CTX);
    if (g.target !== 'region') throw new Error('unreachable');
    const r = runGate({ target: 'region', polygon: g.polygon, canvas: CANVAS });
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/empty region/);
  });
});

describe('resolver — structural mis-spec throws (caller bug, distinct from a geometric reject)', () => {
  it('unknown anchor', () => {
    expect(() => resolve({ type: 'centroid', anchor: 'nope' }, {}, CTX)).toThrow(/unknown anchor/);
  });
  it('wrong primitive kind for a curve relation', () => {
    const box = { kind: 'box' as const, box: { left: 0, top: 0, right: 10, bottom: 10 } };
    expect(() => resolve({ type: 'along', curve: 'box' }, { box }, CTX)).toThrow(
      /must be a polyline/
    );
  });
  it('bad length unit', () => {
    const p = { kind: 'point' as const, point: { x: 0, y: 0 } };
    expect(() =>
      resolve(
        { type: 'offset', from: 'p', direction: 'down', distance: { value: 1, unit: 'furlong' } },
        { p },
        CTX
      )
    ).toThrow(/unknown length unit/);
  });
});
