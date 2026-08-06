import { describe, it, expect } from 'vitest';
import { renderReviewCrop, type RgbaImage } from '@editmamei/perception/grounding-review-crop.ts';
import type { Polyline } from '@editmamei/perception/grounding-geometry.ts';

// The stage-2 review crop — pure pixel arithmetic, tested on a synthetic buffer.
// No Photoshop, no JPEG encode.

const GREEN: [number, number, number] = [40, 240, 90];

/** A solid-gray RGBA image. */
function grayImage(w: number, h: number, v = 100): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
function px(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
const isGreen = (p: [number, number, number, number]): boolean =>
  p[0] === GREEN[0] && p[1] === GREEN[1] && p[2] === GREEN[2];

describe('renderReviewCrop — point placement (hollow ring)', () => {
  const img = grayImage(600, 600);

  it('produces a square crop of the expected size and copies the source', () => {
    // mark a source pixel so we can verify the copy landed in the right spot
    const si = (300 * 600 + 310) * 4;
    img.data[si] = 200;
    img.data[si + 1] = 10;
    img.data[si + 2] = 10;

    const { image, origin, size } = renderReviewCrop(img, {
      kind: 'point',
      point: { x: 300, y: 300 },
    });
    // half = max(minHalf 140, round(0 + padding 120)) = 140 -> size 281, origin (160,160)
    expect(size).toBe(281);
    expect(image.width).toBe(281);
    expect(origin).toEqual({ x: 160, y: 160 });
    // the marked source pixel (310,300) maps to crop (150,140)
    expect(px(image, 150, 140)).toEqual([200, 10, 10, 255]);
  });

  it('draws a HOLLOW ring — the centre shows the source through, the annulus is green', () => {
    const { image } = renderReviewCrop(img, { kind: 'point', point: { x: 300, y: 300 } });
    // crop centre is (140,140); ring radius 13
    expect(isGreen(px(image, 140, 140))).toBe(false); // hole shows source
    expect(px(image, 140, 140)[0]).toBe(100); // gray source
    expect(isGreen(px(image, 140 + 13, 140))).toBe(true); // on the ring
    expect(isGreen(px(image, 140, 140 - 13))).toBe(true);
  });

  it('handles a placement near the edge — full-size crop, out-of-source is opaque black', () => {
    const { image, origin, size } = renderReviewCrop(img, { kind: 'point', point: { x: 5, y: 5 } });
    expect(size).toBe(281);
    expect(origin).toEqual({ x: -135, y: -135 });
    // top-left crop pixel maps to source (-135,-135) — off image → opaque black
    expect(px(image, 0, 0)).toEqual([0, 0, 0, 255]);
    // ring still drawn at crop centre (140,140)
    expect(isGreen(px(image, 140 + 13, 140))).toBe(true);
  });
});

describe('renderReviewCrop — curve + region', () => {
  const img = grayImage(600, 600);

  it('strokes a curve placement in the marker colour', () => {
    const curve: Polyline = [
      { x: 280, y: 300 },
      { x: 320, y: 300 },
    ];
    const { image } = renderReviewCrop(img, { kind: 'curve', curve });
    // curve maps to y=140 across x∈[120,160]; a midpoint is green, far away is not
    expect(isGreen(px(image, 140, 140))).toBe(true);
    expect(isGreen(px(image, 40, 40))).toBe(false);
  });

  it('strokes a region outline (closed)', () => {
    const polygon: Polyline = [
      { x: 280, y: 280 },
      { x: 320, y: 280 },
      { x: 320, y: 320 },
      { x: 280, y: 320 },
    ];
    const { image, origin } = renderReviewCrop(img, { kind: 'region', polygon });
    // a point on the top edge (300,280) → crop (300-ox, 280-oy)
    const p = { x: 300 - origin.x, y: 280 - origin.y };
    expect(isGreen(px(image, p.x, p.y))).toBe(true);
    // interior is NOT filled (outline only)
    const c = { x: 300 - origin.x, y: 300 - origin.y };
    expect(isGreen(px(image, c.x, c.y))).toBe(false);
  });
});

describe('renderReviewCrop — window sizing bounds', () => {
  const img = grayImage(3000, 3000);

  it('honours minHalfWindow for a tiny placement', () => {
    const { size } = renderReviewCrop(
      img,
      { kind: 'point', point: { x: 1500, y: 1500 } },
      { padding: 10, minHalfWindow: 50 }
    );
    expect(size).toBe(2 * 50 + 1); // 101
  });

  it('caps at maxHalfWindow for a huge placement', () => {
    const curve: Polyline = [
      { x: 100, y: 1500 },
      { x: 2900, y: 1500 },
    ];
    const { size } = renderReviewCrop(img, { kind: 'curve', curve }, { maxHalfWindow: 600 });
    expect(size).toBe(2 * 600 + 1); // 1201, capped
  });
});
