/**
 * `fill` against real headless GIMP: solid and gradient layers read back from an independently
 * decoded PNG export, the gradient ramps (monotonic, midpoint, stop hits, radial ends), the layer
 * mask, and that no temporary gradient or context change survives a call. Also the histogram's
 * `mask`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import { readPng, pixelAt, readySession, LIVE_READY_TIMEOUT_MS, TEST_OPS_PY } from './support.ts';

vi.setConfig({ testTimeout: 60_000 });

const install: GimpInstall | null = await detectGimp();

const W = 256;
const H = 64;

interface FillResult {
  layer_id: number;
  layer_name: string;
  op: string;
  mode: string;
  opacity: number;
  masked: boolean;
}
interface LayerNode {
  layer_id: number;
  name: string;
  opacity: number;
  mode: string;
}
type Ppm = ReturnType<typeof readPng>;

describe.skipIf(!install)('fill: solid and gradient layers', () => {
  let workDir: string;
  let session: GimpSession;
  let counter = 0;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-fill-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function doc(fill = 'white', width = W, height = H): Promise<number> {
    const d = await session.call<{ image: number }>('create_document', { width, height, fill });
    return d.image;
  }

  async function render(image: number): Promise<Ppm> {
    const out = join(workDir, `render-${counter++}.png`);
    await session.call('export', { image, path: out });
    return readPng(out);
  }

  const fill = (image: number, args: Record<string, unknown>) =>
    session.call<FillResult>('fill', { image, ...args });

  async function layers(image: number): Promise<LayerNode[]> {
    const d = await session.call<{ layers: LayerNode[] }>('describe', { image, what: 'layers' });
    return d.layers;
  }

  const BW = [
    { offset: 0, color: '#000000' },
    { offset: 1, color: '#ffffff' },
  ];

  it('a solid layer: color, name, mode, opacity, stacked above the active layer', async () => {
    const image = await doc();
    const r = await fill(image, { op: 'solid', color: '#336699' });
    expect(r).toMatchObject({ op: 'solid', mode: 'normal', opacity: 100, masked: false });
    expect(r.layer_name).toBe('Fill');
    expect(pixelAt(await render(image), 100, 30)).toEqual([0x33, 0x66, 0x99]);
    const rows = await layers(image);
    expect(rows[0]!.layer_id).toBe(r.layer_id);
    expect(rows).toHaveLength(2);

    const half = await fill(image, {
      op: 'solid',
      color: '#ff0000',
      name: 'Tint',
      mode: 'multiply',
      opacity: 50,
    });
    expect(half.layer_name).toBe('Tint');
    const tint = (await layers(image))[0]!;
    expect(tint).toMatchObject({ layer_id: half.layer_id, mode: 'multiply', opacity: 50 });
  });

  it("'color' is HSL Color and 'lch_color' is LCh Color", async () => {
    const image = await doc();
    await fill(image, { op: 'solid', color: '#ff0000', mode: 'color' });
    expect((await layers(image))[0]!.mode).toBe('hsl-color');
    await fill(image, { op: 'solid', color: '#ff0000', mode: 'lch_color' });
    expect((await layers(image))[0]!.mode).toBe('lch-color');
  });

  it('goes directly above a named layer, inside its group position', async () => {
    const image = await doc();
    const top = await fill(image, { op: 'solid', color: '#111111', name: 'Top' });
    const mid = await fill(image, {
      op: 'solid',
      color: '#222222',
      name: 'Mid',
      layer: 'Background',
    });
    const names = (await layers(image)).map((l) => l.name);
    expect(names).toEqual(['Top', 'Mid', 'Background']);
    expect(top.layer_id).not.toBe(mid.layer_id);
  });

  it('a mask channel becomes the layer mask: white where selected', async () => {
    const image = await doc();
    await session.call('create_mask', {
      image,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: W / 2,
      height: H,
      name: 'Left',
    });
    const r = await fill(image, { op: 'solid', color: '#000000', mask: 'Left' });
    expect(r.masked).toBe(true);
    const ppm = await render(image);
    expect(pixelAt(ppm, 20, 30)).toEqual([0, 0, 0]);
    expect(pixelAt(ppm, W - 20, 30)).toEqual([255, 255, 255]);
    await expect(fill(image, { op: 'solid', color: '#000000', mask: 'Nope' })).rejects.toThrow(
      /no channel/
    );
    expect(await layers(image)).toHaveLength(2);
  });

  it('a 2-stop linear black to white ramp is monotonic with a midpoint near 128', async () => {
    const image = await doc();
    await fill(image, {
      op: 'linear_gradient',
      stops: BW,
      start: { x: 0, y: 0 },
      end: { x: W, y: 0 },
    });
    const ppm = await render(image);
    let prev = -1;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = pixelAt(ppm, x, 10);
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(Math.abs(pixelAt(ppm, W / 2, 10)[0] - 128)).toBeLessThanOrEqual(3);
    expect(pixelAt(ppm, 0, 10)[0]).toBeLessThanOrEqual(2);
    expect(pixelAt(ppm, W - 1, 10)[0]).toBeGreaterThanOrEqual(253);
    // Rows are identical: the ramp is horizontal.
    expect(pixelAt(ppm, 100, 0)).toEqual(pixelAt(ppm, 100, H - 1));
  });

  it('the default linear ramp runs top center to bottom center', async () => {
    const image = await doc();
    await fill(image, { op: 'linear_gradient', stops: BW });
    const ppm = await render(image);
    expect(pixelAt(ppm, 10, 0)[0]).toBeLessThanOrEqual(6);
    expect(pixelAt(ppm, 10, H - 1)[0]).toBeGreaterThanOrEqual(249);
    expect(pixelAt(ppm, 10, 20)).toEqual(pixelAt(ppm, W - 10, 20));
  });

  it('3 stops hit each stop color at its offset', async () => {
    const image = await doc();
    await fill(image, {
      op: 'linear_gradient',
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 0.25, color: '#00ff00' },
        { offset: 1, color: '#0000ff' },
      ],
      start: { x: 0, y: 0 },
      end: { x: W, y: 0 },
    });
    const ppm = await render(image);
    const near = (a: number[], b: number[], tol = 6) =>
      a.every((v, i) => Math.abs(v - b[i]!) <= tol);
    expect(near(pixelAt(ppm, 0, 5), [255, 0, 0])).toBe(true);
    expect(near(pixelAt(ppm, W * 0.25, 5), [0, 255, 0], 8)).toBe(true);
    expect(near(pixelAt(ppm, W - 1, 5), [0, 0, 255])).toBe(true);
    // Halfway between stop 2 (0.25) and stop 3 (1): an even green/blue mix.
    const mid = pixelAt(ppm, W * 0.625, 5);
    expect(Math.abs(mid[1] - 128)).toBeLessThanOrEqual(8);
    expect(Math.abs(mid[2] - 128)).toBeLessThanOrEqual(8);
  });

  // Stops far from an even split: GIMP clamps a segment edge between neighboring middles, so
  // these land at their offsets only if the gradient is built one segment at a time.
  it('uneven stops (0, 0.1, 0.9, 1) each hit their color at their offset', async () => {
    const image = await doc();
    await fill(image, {
      op: 'linear_gradient',
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 0.1, color: '#00ff00' },
        { offset: 0.9, color: '#0000ff' },
        { offset: 1, color: '#ffffff' },
      ],
      start: { x: 0, y: 0 },
      end: { x: W, y: 0 },
    });
    const ppm = await render(image);
    const near = (a: number[], b: number[], tol = 8) =>
      a.every((v, i) => Math.abs(v - b[i]!) <= tol);
    // Rounded to the nearest pixel: each ramp is steep, so the pixel beside a stop is off by ~10.
    expect(near(pixelAt(ppm, Math.round(W * 0.1), 5), [0, 255, 0])).toBe(true);
    expect(near(pixelAt(ppm, Math.round(W * 0.9), 5), [0, 0, 255])).toBe(true);
    // Halfway between 0.1 and 0.9: an even green/blue mix, no red.
    const mid = pixelAt(ppm, W * 0.5, 5);
    expect(mid[0]).toBeLessThanOrEqual(8);
    expect(Math.abs(mid[1] - 128)).toBeLessThanOrEqual(8);
    expect(Math.abs(mid[2] - 128)).toBeLessThanOrEqual(8);
  });

  it('two stops at the same offset make a hard edge', async () => {
    const image = await doc();
    await fill(image, {
      op: 'linear_gradient',
      stops: [
        { offset: 0, color: '#000000' },
        { offset: 0.5, color: '#000000' },
        { offset: 0.5, color: '#ffffff' },
        { offset: 1, color: '#ffffff' },
      ],
      start: { x: 0, y: 0 },
      end: { x: W, y: 0 },
    });
    const ppm = await render(image);
    expect(pixelAt(ppm, W * 0.5 - 3, 5)[0]).toBeLessThanOrEqual(6);
    expect(pixelAt(ppm, W * 0.5 + 3, 5)[0]).toBeGreaterThanOrEqual(249);
  });

  it('the end colors hold outside the first and last stop', async () => {
    const image = await doc();
    await fill(image, {
      op: 'linear_gradient',
      stops: [
        { offset: 0.25, color: '#000000' },
        { offset: 0.75, color: '#ffffff' },
      ],
      start: { x: 0, y: 0 },
      end: { x: W, y: 0 },
    });
    const ppm = await render(image);
    expect(pixelAt(ppm, 10, 5)).toEqual([0, 0, 0]);
    expect(pixelAt(ppm, W - 10, 5)).toEqual([255, 255, 255]);
  });

  it('stop opacity makes the gradient translucent over what is below', async () => {
    const image = await doc('black');
    await fill(image, {
      op: 'linear_gradient',
      stops: [
        { offset: 0, color: '#ffffff', opacity: 0 },
        { offset: 1, color: '#ffffff', opacity: 100 },
      ],
      start: { x: 0, y: 0 },
      end: { x: W, y: 0 },
    });
    const ppm = await render(image);
    // GIMP composites alpha in linear light, so 50% white over black reads brighter than 128:
    // compare with a plain 50% white layer in the same kind of document.
    const ref = await doc('black');
    await fill(ref, { op: 'solid', color: '#ffffff', opacity: 50 });
    const half = pixelAt(await render(ref), 5, 5)[0];
    expect(pixelAt(ppm, 0, 5)[0]).toBeLessThanOrEqual(15);
    expect(pixelAt(ppm, W - 1, 5)[0]).toBeGreaterThanOrEqual(251);
    expect(Math.abs(pixelAt(ppm, W / 2, 5)[0] - half)).toBeLessThanOrEqual(4);
  });

  it('a radial gradient: stop 0 at the center, the last stop from the radius out', async () => {
    const image = await doc('white', 200, 200);
    await fill(image, {
      op: 'radial_gradient',
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
      center: { x: 100, y: 100 },
      radius: 80,
    });
    const ppm = await render(image);
    const [r0, , b0] = pixelAt(ppm, 100, 100);
    expect(r0).toBeGreaterThanOrEqual(250);
    expect(b0).toBeLessThanOrEqual(5);
    const [r1, , b1] = pixelAt(ppm, 100 + 90, 100);
    expect(r1).toBeLessThanOrEqual(5);
    expect(b1).toBeGreaterThanOrEqual(250);
    const [, , bDiag] = pixelAt(ppm, 5, 5);
    expect(bDiag).toBeGreaterThanOrEqual(250);
    const half = pixelAt(ppm, 140, 100);
    expect(Math.abs(half[0] - 128)).toBeLessThanOrEqual(6);
  });

  it('an active selection neither clips the fill nor is lost', async () => {
    const image = await doc();
    await session.call('test_select_rect', { image, x: 10, y: 10, width: 20, height: 20 });
    await fill(image, { op: 'solid', color: '#000000' });
    const ppm = await render(image);
    expect(pixelAt(ppm, 200, 50)).toEqual([0, 0, 0]);
    const bounds = await session.call<Record<string, number | null>>('test_selection_bounds', {
      image,
    });
    expect(bounds).toMatchObject({ x: 10, y: 10, width: 20, height: 20 });
  });

  it('leaves no temporary gradient and does not change the paint context', async () => {
    const image = await doc();
    const names = () => session.call<{ names: string[] }>('test_gradient_names', {});
    const state = () => session.call<Record<string, unknown>>('test_context_state', {});
    const before = [await names(), await state()];
    await fill(image, { op: 'linear_gradient', stops: BW });
    await fill(image, { op: 'radial_gradient', stops: BW });
    await fill(image, { op: 'solid', color: '#abcdef' });
    // A refused call must clean up too.
    await expect(fill(image, { op: 'linear_gradient', stops: BW, mask: 'Nope' })).rejects.toThrow();
    expect([await names(), await state()]).toEqual(before);
    expect(await layers(image)).toHaveLength(4);
  });

  it('a failure after the layer, mask and gradient exist leaves no trace', async () => {
    const image = await doc();
    await session.call('create_mask', {
      image,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: W / 2,
      height: H,
      name: 'Left',
    });
    await session.call('test_select_rect', { image, x: 10, y: 10, width: 20, height: 20 });
    const snapshot = async () => ({
      layers: (await layers(image)).map((l) => l.layer_id),
      channels: (
        await session.call<{ channels: Array<{ name: string }> }>('describe', {
          image,
          what: 'channels',
        })
      ).channels.map((c) => c.name),
      gradients: await session.call('test_gradient_names', {}),
      context: await session.call('test_context_state', {}),
      selection: await session.call('test_selection_bounds', { image }),
    });
    const before = await snapshot();
    await session.call('test_arm_fill_failure', {});
    await expect(fill(image, { op: 'linear_gradient', stops: BW, mask: 'Left' })).rejects.toThrow(
      /injected/
    );
    expect(await snapshot()).toEqual(before);
    expect(before.selection).toMatchObject({ x: 10, y: 10, width: 20, height: 20 });
    // The hook was one-shot: the same call now succeeds.
    await fill(image, { op: 'linear_gradient', stops: BW, mask: 'Left' });
    expect(await layers(image)).toHaveLength(before.layers.length + 1);
  });

  it('refuses an unknown layer_id without leaving a layer behind', async () => {
    const image = await doc();
    const ids = await layers(image);
    await expect(fill(image, { op: 'solid', color: '#ffffff', layer_id: 999999 })).rejects.toThrow(
      /no layer/
    );
    expect(await layers(image)).toHaveLength(ids.length);
  });
});

describe.skipIf(!install)('histogram mask: measure only the selected pixels', () => {
  let workDir: string;
  let session: GimpSession;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-histmask-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  interface Hist {
    pixels: number;
    mask: string | null;
    channels: Record<string, { mean: number }>;
  }

  /** 200x100 white document, the left half painted #404040 through a channel mask. */
  async function twoTone(): Promise<number> {
    const d = await session.call<{ image: number }>('create_document', {
      width: 200,
      height: 100,
      fill: 'white',
    });
    for (const [name, x] of [
      ['Left', 0],
      ['Right', 100],
    ] as const) {
      await session.call('create_mask', {
        image: d.image,
        type: 'rectangle',
        x,
        y: 0,
        width: 100,
        height: 100,
        name,
      });
    }
    await session.call('fill', { image: d.image, op: 'solid', color: '#404040', mask: 'Left' });
    return d.image;
  }

  it('reports only the masked half, on the proxy and exactly', async () => {
    const image = await twoTone();
    const whole = await session.call<Hist>('histogram', { image, exact: true });
    expect(whole.channels['luminance']!.mean).toBeGreaterThan(150);
    for (const exact of [false, true]) {
      const left = await session.call<Hist>('histogram', { image, mask: 'Left', exact });
      expect(left.mask).toBe('Left');
      expect(left.pixels).toBe(100 * 100);
      expect(Math.abs(left.channels['luminance']!.mean - 64)).toBeLessThanOrEqual(1);
      expect(Math.abs(left.channels['red']!.mean - 64)).toBeLessThanOrEqual(1);
      const right = await session.call<Hist>('histogram', { image, mask: 'Right', exact });
      expect(right.channels['luminance']!.mean).toBeGreaterThanOrEqual(254);
    }
  });

  it('combines with a region, and refuses a missing or empty mask', async () => {
    const image = await twoTone();
    const r = await session.call<Hist>('histogram', {
      image,
      mask: 'Left',
      region: { x: 50, y: 0, width: 100, height: 100 },
      exact: true,
    });
    expect(r.pixels).toBe(50 * 100);
    expect(Math.abs(r.channels['luminance']!.mean - 64)).toBeLessThanOrEqual(1);
    await expect(session.call('histogram', { image, mask: 'Nope' })).rejects.toThrow(/no channel/);
    // The Left channel selects nothing inside a region that only covers the right half.
    await expect(
      session.call('histogram', {
        image,
        mask: 'Left',
        region: { x: 120, y: 0, width: 60, height: 60 },
        exact: true,
      })
    ).rejects.toThrow(/selects no pixels/);
  });
});

describe.skipIf(!install)('histogram mask on a proxy-sized image (wider than 1024 px)', () => {
  let workDir: string;
  let session: GimpSession;
  const BW_ = 2000;
  const BH_ = 800;
  /** The proxy is 1024 px on the long side, so areas shrink by this squared. */
  const AREA = (1024 / BW_) ** 2;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-histproxy-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  interface Hist {
    exact: boolean;
    pixels: number;
    channels: Record<string, { mean: number }>;
  }

  /** White 2000x800; #404040 painted through each named rectangle channel. */
  async function wide(rects: Record<string, [number, number, number, number]>): Promise<number> {
    const d = await session.call<{ image: number }>('create_document', {
      width: BW_,
      height: BH_,
      fill: 'white',
    });
    for (const [name, [x, y, width, height]] of Object.entries(rects)) {
      await session.call('create_mask', {
        image: d.image,
        type: 'rectangle',
        x,
        y,
        width,
        height,
        name,
      });
      await session.call('fill', { image: d.image, op: 'solid', color: '#404040', mask: name });
    }
    return d.image;
  }

  const near = (got: number, want: number, tol = 0.03) =>
    expect(Math.abs(got - want) / want).toBeLessThanOrEqual(tol);

  it('whole image on the proxy: the pixel count scales and the mean holds', async () => {
    const image = await wide({ Left: [0, 0, 1000, 800] });
    const h = await session.call<Hist>('histogram', { image, mask: 'Left' });
    expect(h.exact).toBe(false);
    near(h.pixels, 1000 * 800 * AREA);
    expect(Math.abs(h.channels['luminance']!.mean - 64)).toBeLessThanOrEqual(1);
  });

  it('a proxy-eligible region keeps the same behavior', async () => {
    const image = await wide({ Left: [0, 0, 1000, 800] });
    const h = await session.call<Hist>('histogram', {
      image,
      mask: 'Left',
      region: { x: 200, y: 100, width: 1600, height: 600 },
    });
    expect(h.exact).toBe(false);
    near(h.pixels, 800 * 600 * AREA);
    expect(Math.abs(h.channels['luminance']!.mean - 64)).toBeLessThanOrEqual(1);
  });

  it('a speck too small to survive the scale-down is measured at full resolution', async () => {
    const image = await wide({ Speck: [500, 400, 3, 2] });
    const h = await session.call<Hist>('histogram', { image, mask: 'Speck' });
    expect(h.exact).toBe(true);
    expect(h.pixels).toBe(6);
    expect(Math.abs(h.channels['luminance']!.mean - 64)).toBeLessThanOrEqual(1);
    // The same through a region.
    const r = await session.call<Hist>('histogram', {
      image,
      mask: 'Speck',
      region: { x: 100, y: 100, width: 1800, height: 600 },
    });
    expect(r.pixels).toBe(6);
  });

  it('a one-pixel line is never refused, and its mean is right', async () => {
    const image = await wide({ Line: [0, 400, BW_, 1] });
    const h = await session.call<Hist>('histogram', { image, mask: 'Line' });
    expect(h.pixels).toBeGreaterThan(0);
    expect(Math.abs(h.channels['luminance']!.mean - 64)).toBeLessThanOrEqual(2);
  });

  it('a mask that is empty at full resolution is still refused', async () => {
    const image = await wide({ Left: [0, 0, 1000, 800] });
    await session.call('create_mask', {
      image,
      type: 'rectangle',
      x: 1500,
      y: 0,
      width: 100,
      height: 100,
      name: 'Right',
    });
    await expect(
      session.call('histogram', {
        image,
        mask: 'Left',
        region: { x: 1200, y: 0, width: 800, height: 800 },
      })
    ).rejects.toThrow(/selects no pixels/);
  });
});
