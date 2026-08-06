import { describe, it, expect } from 'vitest';
import { findExtremum, extremumAnchor } from '@editmamei/perception/grounding-extrema.ts';
import type { RgbaImage } from '@editmamei/perception/grounding-review-crop.ts';
import { gridAnchor, frameBox } from '@editmamei/perception/grounding-grid.ts';
import { resolve, centerOf } from '@editmamei/perception/grounding-resolver.ts';
import { runGate } from '@editmamei/perception/grounding-gate.ts';

// Brightness/colour extremum anchors — image scan on a synthetic buffer.

/** 200×200 gray with a white, a black, and a pure-red block. */
function scene(): RgbaImage {
  const w = 200,
    h = 200;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 100;
    data[i * 4 + 3] = 255;
  }
  const block = (cx: number, cy: number, r: number, g: number, b: number): void => {
    for (let y = cy - 4; y <= cy + 4; y++)
      for (let x = cx - 4; x <= cx + 4; x++) {
        const i = (y * w + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
  };
  block(72, 32, 255, 255, 255); // white (brightest)
  block(22, 152, 0, 0, 0); // black (darkest)
  block(124, 94, 255, 0, 0); // red (most saturated)
  return { width: w, height: h, data };
}
const REGION = { left: 0, top: 0, right: 199, bottom: 199 };
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 8;

describe('findExtremum', () => {
  const img = scene();

  it('brightest finds the white block', () => {
    const e = findExtremum(img, REGION, 'brightest');
    expect(near(e.point.x, 72) && near(e.point.y, 32)).toBe(true);
    expect(e.value).toBeGreaterThan(250);
  });

  it('darkest finds the black block', () => {
    const e = findExtremum(img, REGION, 'darkest');
    expect(near(e.point.x, 22) && near(e.point.y, 152)).toBe(true);
    expect(e.value).toBeLessThan(5);
  });

  it('most-saturated finds the red block', () => {
    const e = findExtremum(img, REGION, 'most-saturated');
    expect(near(e.point.x, 124) && near(e.point.y, 94)).toBe(true);
    expect(e.value).toBeGreaterThan(200);
  });

  it('respects the region — excluding the white block drops the max to gray', () => {
    const full = findExtremum(img, REGION, 'brightest');
    const sub = findExtremum(img, { left: 100, top: 60, right: 199, bottom: 199 }, 'brightest');
    expect(full.value).toBeGreaterThan(250);
    expect(sub.value).toBeLessThan(150); // no white block in the sub-region → ~gray 100
  });
});

describe('extremum + grid anchors compose into the spine', () => {
  it('midpoint of the frame centre and the brightest point resolves + gates', () => {
    const img = scene();
    const anchors = {
      c: gridAnchor(frameBox(200, 200), 'center'),
      bright: extremumAnchor(img, REGION, 'brightest'),
    };
    const g = resolve({ type: 'midpoint', anchors: ['c', 'bright'] }, anchors, {
      frame: { width: 200, height: 200 },
    });
    if (g.target !== 'point') throw new Error('unreachable');
    const r = runGate({
      target: 'point',
      point: g.point,
      canvas: { width: 200, height: 200 },
      anchors: [centerOf(anchors.c), centerOf(anchors.bright)],
    });
    expect(r.pass).toBe(true);
  });
});
