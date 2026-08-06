import { describe, it, expect } from 'vitest';
import {
  computeSkyMask,
  fillEnclosedHoles,
  type Box,
} from '@editmamei/perception/sky-ground-flood.ts';

// computeSkyMask is pure CV over an RGBA buffer + object boxes — no Photoshop. These
// synthetic images exercise the load-bearing structural steps: the sky/ground split,
// the bottom-connected-landmass fix (a dark blob floating in the sky is NOT ground),
// and the object-gated intrusion fill.

const W = 200;
const H = 200;

/** Build an RGBA buffer from a per-pixel colour function. */
function makeImage(fill: (x: number, y: number) => [number, number, number]): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return data;
}

const SKY: [number, number, number] = [120, 160, 220]; // bright blue
const GROUND: [number, number, number] = [40, 120, 40]; // green terrain
const at = (mask: Uint8Array, x: number, y: number): number => mask[y * W + x];

describe('computeSkyMask', () => {
  it('splits a top-sky / bottom-ground frame and returns the working dimensions', () => {
    // 200px input ⇒ no downscale (F=1), so the mask is full-size.
    const data = makeImage((_x, y) => (y < 100 ? SKY : GROUND));
    const { mask, width, height } = computeSkyMask(data, W, H, []);
    expect(width).toBe(W);
    expect(height).toBe(H);
    expect(at(mask, 100, 20)).toBe(1); // upper centre = sky
    expect(at(mask, 100, 180)).toBe(0); // lower centre = ground (bottom-connected)
  });

  it('treats a dark blob FLOATING in the sky as sky (bottom-connected landmass)', () => {
    // A dark-gray "storm cloud" scores like dark terrain to the colour cue, but it is
    // not connected to the bottom landmass — so it must come back as sky, not a gap.
    const data = makeImage((x, y) => {
      if (y >= 100) return GROUND;
      const inCloud = x >= 80 && x < 120 && y >= 20 && y < 50;
      return inCloud ? [60, 60, 70] : SKY;
    });
    const { mask } = computeSkyMask(data, W, H, []);
    expect(at(mask, 100, 35)).toBe(1); // the floating dark blob is filled as sky
    expect(at(mask, 100, 180)).toBe(0); // the real (bottom-connected) ground stays out
  });

  it('object-gate: a thin ground spur fills as sky UNLESS a detected box protects it', () => {
    // A thin terrain spur jutting up from the ground into the sky.
    const data = makeImage((x, y) => {
      if (y >= 100) return GROUND;
      const inSpur = x >= 98 && x < 102 && y >= 60;
      return inSpur ? GROUND : SKY;
    });
    // No object there → the close bridges the sky across the thin spur (fill it).
    const open = computeSkyMask(data, W, H, []);
    expect(at(open.mask, 100, 70)).toBe(1);
    // A detected object box over the spur → the close may not bridge it (stays out).
    const boxes: Box[] = [[95, 55, 105, 100]];
    const gated = computeSkyMask(data, W, H, boxes);
    expect(at(gated.mask, 100, 70)).toBe(0);
  });

  it('downscales when src > targetWidth and scales boxes by the same factor (F=2)', () => {
    // 1040px input → F = round(1040/520) = 2 → 520×390 working mask. Box coords are in
    // SOURCE px and must divide by F to land on the working spur — the coordinate frame.
    const SW = 1040;
    const SH = 780;
    const big = new Uint8Array(SW * SH * 4);
    for (let y = 0; y < SH; y++)
      for (let x = 0; x < SW; x++) {
        // top sky / bottom ground (src-y≥590), with an 8px ground spur poking UP from the
        // ground into the sky at src-x≈520, y∈[400,590).
        const inSpur = x >= 516 && x < 524 && y >= 400 && y < 590;
        const [r, g, b] = y >= 590 || inSpur ? GROUND : SKY;
        const i = (y * SW + x) * 4;
        big[i] = r;
        big[i + 1] = g;
        big[i + 2] = b;
        big[i + 3] = 255;
      }
    const open = computeSkyMask(big, SW, SH, []);
    expect(open.width).toBe(520);
    expect(open.height).toBe(390);
    expect(open.mask[20 * 520 + 260]).toBe(1); // upper centre = sky (downscale worked)
    expect(open.mask[370 * 520 + 260]).toBe(0); // lower centre = ground
    expect(open.mask[250 * 520 + 260]).toBe(1); // the thin spur (working x≈260, y≈250) filled, no box
    // A SOURCE-px box over the spur must protect it after the /F scale.
    const gated = computeSkyMask(big, SW, SH, [[505, 390, 535, 590]]);
    expect(gated.mask[250 * 520 + 260]).toBe(0); // spur protected at F=2
  });

  it('fillEnclosedHoles fills a sky-ringed pocket but leaves a border-connected hole', () => {
    const w = 10;
    const h = 10;
    const m = new Uint8Array(w * h).fill(1);
    m[5 * w + 5] = 0; // an interior hole fully ringed by sky
    m[0] = 0; // a hole touching the (top-left) border
    fillEnclosedHoles(m, w, h);
    expect(m[5 * w + 5]).toBe(1); // enclosed hole filled
    expect(m[0]).toBe(0); // border-connected hole left alone
  });
});
