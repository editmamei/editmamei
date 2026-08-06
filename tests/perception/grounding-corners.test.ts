import { describe, it, expect } from 'vitest';
import { findCorners, cornerAnchor } from '@editmamei/perception/grounding-corners.ts';
import type { RgbaImage } from '@editmamei/perception/grounding-review-crop.ts';
import { gridAnchor, frameBox } from '@editmamei/perception/grounding-grid.ts';
import { resolve, centerOf } from '@editmamei/perception/grounding-resolver.ts';
import { runGate } from '@editmamei/perception/grounding-gate.ts';

// Harris corners — pure, on a synthetic buffer. A black square on white has four
// corners; a flat region has none (self-flags, like the edge tracer).

/** 200×200 white with a black square [60..140]². */
function squareImage(): RgbaImage {
  const w = 200,
    h = 200;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = x >= 60 && x <= 140 && y >= 60 && y <= 140 ? 0 : 255;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}
const REGION = { left: 40, top: 40, right: 160, bottom: 160 };
const nearAny = (p: { x: number; y: number }, targets: [number, number][], tol = 8): boolean =>
  targets.some(([tx, ty]) => Math.abs(p.x - tx) <= tol && Math.abs(p.y - ty) <= tol);

describe('findCorners', () => {
  const img = squareImage();
  const squareCorners: [number, number][] = [
    [60, 60],
    [140, 60],
    [60, 140],
    [140, 140],
  ];

  it('finds the four square corners', () => {
    const corners = findCorners(img, REGION);
    expect(corners.length).toBeGreaterThanOrEqual(4);
    // every one of the four square corners is matched by some detected corner
    for (const sc of squareCorners) {
      expect(corners.some((c) => nearAny(c.point, [sc]))).toBe(true);
    }
    // the strongest few are all real square corners (not edge/flat noise)
    for (const c of corners.slice(0, 4)) expect(nearAny(c.point, squareCorners)).toBe(true);
  });

  it('cornerAnchor picks the corner nearest a hint', () => {
    const a = cornerAnchor(img, REGION, { near: { x: 62, y: 62 } });
    if (a?.kind !== 'point') throw new Error('unreachable');
    expect(nearAny(a.point, [[60, 60]])).toBe(true);
  });

  it('a flat region has no corners → empty / null', () => {
    const flat = { left: 10, top: 10, right: 40, bottom: 40 };
    expect(findCorners(img, flat)).toEqual([]);
    expect(cornerAnchor(img, flat)).toBeNull();
  });
});

describe('corner anchor composes into the spine', () => {
  it('midpoint of a corner and the frame centre resolves + gates', () => {
    const img = squareImage();
    const anchors = {
      corner: cornerAnchor(img, REGION, { near: { x: 60, y: 60 } })!,
      c: gridAnchor(frameBox(200, 200), 'center'),
    };
    const g = resolve({ type: 'midpoint', anchors: ['corner', 'c'] }, anchors, {
      frame: { width: 200, height: 200 },
    });
    if (g.target !== 'point') throw new Error('unreachable');
    const r = runGate({
      target: 'point',
      point: g.point,
      canvas: { width: 200, height: 200 },
      anchors: [centerOf(anchors.corner), centerOf(anchors.c)],
    });
    expect(r.pass).toBe(true);
  });
});
