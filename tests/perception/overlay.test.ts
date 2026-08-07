import { describe, it, expect } from 'vitest';
import {
  ANNOTATION_RGB,
  annotationThickness,
  drawBoxOutline,
  drawHLine,
  drawRing,
  fillDisc,
  fillSquare,
  setPx,
  type RgbaPixels,
} from '@editmamei/perception/overlay.ts';

/**
 * Audit finding 9: the shared overlay primitives replace four hand-copied
 * setPx implementations (detection-tools, scene-tools,
 * detect-landmarks-tools-pro, grounding-review-crop). These tests pin the
 * pixel semantics the four wrapper functions now delegate to.
 */

function makeImg(width: number, height: number): RgbaPixels {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function px(img: RgbaPixels, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

describe('setPx', () => {
  it('writes RGB with an opaque alpha', () => {
    const img = makeImg(4, 4);
    setPx(img, 2, 1, [10, 20, 30]);
    expect(px(img, 2, 1)).toEqual([10, 20, 30, 255]);
  });

  it('clips out-of-bounds writes silently', () => {
    const img = makeImg(4, 4);
    setPx(img, -1, 0, [255, 255, 255]);
    setPx(img, 0, -1, [255, 255, 255]);
    setPx(img, 4, 0, [255, 255, 255]);
    setPx(img, 0, 4, [255, 255, 255]);
    expect(img.data.every((b) => b === 0)).toBe(true);
  });
});

describe('annotationThickness', () => {
  it('floors at 2px for small exports', () => {
    expect(annotationThickness(makeImg(400, 300))).toBe(2);
  });

  it('scales with the long edge (~1/400)', () => {
    expect(annotationThickness(makeImg(4000, 1000))).toBe(10);
  });
});

describe('drawBoxOutline', () => {
  it('stamps the outline but leaves the interior untouched', () => {
    const img = makeImg(20, 20);
    drawBoxOutline(img, [2, 2, 17, 17], [255, 0, 0], 2);
    // Corner and edge pixels are set…
    expect(px(img, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(px(img, 10, 2)).toEqual([255, 0, 0, 255]); // top edge
    expect(px(img, 10, 3)).toEqual([255, 0, 0, 255]); // thickness row 2
    expect(px(img, 2, 10)).toEqual([255, 0, 0, 255]); // left edge
    // …the interior is not.
    expect(px(img, 10, 10)).toEqual([0, 0, 0, 0]);
  });

  it('rounds fractional coordinates', () => {
    const img = makeImg(10, 10);
    drawBoxOutline(img, [1.4, 1.4, 7.6, 7.6], [0, 255, 0], 1);
    expect(px(img, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(px(img, 8, 8)).toEqual([0, 255, 0, 255]);
  });
});

describe('drawHLine', () => {
  it('spans the full width, stamped downward from y', () => {
    const img = makeImg(6, 6);
    drawHLine(img, 2, [1, 2, 3], 2);
    for (let x = 0; x < 6; x++) {
      expect(px(img, x, 2)).toEqual([1, 2, 3, 255]);
      expect(px(img, x, 3)).toEqual([1, 2, 3, 255]);
      expect(px(img, x, 1)).toEqual([0, 0, 0, 0]);
      expect(px(img, x, 4)).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('fillSquare', () => {
  it('fills the (2r+1)² block centered on the point', () => {
    const img = makeImg(9, 9);
    fillSquare(img, 4, 4, 1, [9, 9, 9]);
    let set = 0;
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (px(img, x, y)[3] === 255) set++;
    expect(set).toBe(9);
    expect(px(img, 4, 4)[3]).toBe(255);
    expect(px(img, 3, 3)[3]).toBe(255);
    expect(px(img, 6, 4)[3]).toBe(0);
  });
});

describe('drawRing', () => {
  it('leaves the hole open so the feature shows through (E6 concur rule)', () => {
    const img = makeImg(41, 41);
    drawRing(img, 20, 20, 10, 2, [255, 255, 0]);
    expect(px(img, 20, 20)[3]).toBe(0); // center open
    expect(px(img, 30, 20)[3]).toBe(255); // on the radius
    expect(px(img, 20, 10)[3]).toBe(255);
    expect(px(img, 20, 33)[3]).toBe(0); // outside outer edge
  });
});

describe('fillDisc', () => {
  it('fills within the radius and not beyond', () => {
    const img = makeImg(21, 21);
    fillDisc(img, 10, 10, 4, [7, 7, 7]);
    expect(px(img, 10, 10)[3]).toBe(255);
    expect(px(img, 14, 10)[3]).toBe(255);
    expect(px(img, 14, 14)[3]).toBe(0); // corner beyond the circle
  });
});

describe('ANNOTATION_RGB', () => {
  it('pins the palette that tool descriptions promise ("faces cyan, objects magenta")', () => {
    expect(ANNOTATION_RGB.face).toEqual([0, 220, 255]);
    expect(ANNOTATION_RGB.object).toEqual([255, 0, 220]);
    expect(ANNOTATION_RGB.horizon).toEqual([255, 230, 0]);
  });
});
