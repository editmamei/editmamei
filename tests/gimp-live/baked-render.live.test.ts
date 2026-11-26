/**
 * The baked render (ops.py `_baked_flat`), against real headless GIMP: an export, a flatten, an exact
 * histogram and a region preview bake the live filters one at a time onto a filter-free copy instead of
 * having GIMP render the whole stack at once, and must still show what GIMP shows. Also: a masked filter
 * reopened from an XCF renders as it did before the save, and a render without filters for the
 * selection service.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  writeNoisyField,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
  maxAbsDiff,
} from './support.ts';

vi.setConfig({ testTimeout: 120_000 });

const install: GimpInstall | null = await detectGimp();

type Ppm = ReturnType<typeof readPng>;
type FilterName = { layer: string; name: string; operation: string; visible: boolean };

/** How far two renders of the same size are apart: the worst channel difference, the share of
 * channel values within one level, and the mean absolute difference. */
function apart(a: Ppm, b: Ppm): { max: number; within1: number; mean: number } {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let max = 0;
  let within1 = 0;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i]! - b.data[i]!);
    if (d > max) max = d;
    if (d <= 1) within1++;
    sum += d;
  }
  return { max, within1: within1 / a.data.length, mean: sum / a.data.length };
}

/** `apart` over the pixels at least `border` from every edge of the canvas. */
function apartInside(a: Ppm, b: Ppm, border: number): ReturnType<typeof apart> {
  return apart(
    crop(a, border, border, a.width - 2 * border, a.height - 2 * border),
    crop(b, border, border, b.width - 2 * border, b.height - 2 * border)
  );
}

function crop(p: Ppm, x: number, y: number, w: number, h: number): Ppm {
  const data = Buffer.alloc(w * h * 3);
  for (let row = 0; row < h; row++) {
    p.data.copy(
      data,
      row * w * 3,
      ((y + row) * p.width + x) * 3,
      ((y + row) * p.width + x + w) * 3
    );
  }
  return { ...p, width: w, height: h, data };
}

describe.skipIf(!install)('baked render', () => {
  let workDir: string;
  let session: GimpSession;
  let photo: string;
  let n = 0;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-baked-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    photo = join(workDir, 'noisy.png');
    writeNoisyField(photo, 640, 480, 70);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  const out = (ext = 'png') => join(workDir, `r${n++}.${ext}`);
  const exportPng = async (image: number) => {
    const path = out();
    await session.call('export', { image, path });
    return readPng(path);
  };
  const native = async (image: number, extra: Record<string, unknown> = {}) => {
    const path = out();
    const r = await session.call<{ name: string }>('test_native_render', {
      image,
      out_path: path,
      ...extra,
    });
    return { ppm: readPng(path), name: r.name };
  };
  const filterNames = async (image: number) =>
    (await session.call<{ filters: FilterName[] }>('test_filter_names', { image })).filters;

  /** A tinted noisy photo with two masks (one feathered, one hard) and a stack of masked and
   * unmasked filters, spatial and per-pixel, including one blended in Overlay (clarity). With
   * `noise`, also two masked noise reductions: GIMP's own noise reduction comes out differently
   * wherever the area being rendered is split into chunks, so a stack with it matches only to
   * within that, along those seams. */
  async function stacked(noise = false): Promise<number> {
    const { image } = await session.call<{ image: number }>('open', { path: photo });
    await session.call('adjust', {
      image,
      type: 'color_temperature',
      from_kelvin: 6500,
      to_kelvin: 4000,
    });
    await session.call('select', {
      image,
      mode: 'ellipse',
      x: 120,
      y: 80,
      width: 360,
      height: 300,
      name: 'Soft',
      feather_px: 40,
    });
    await session.call('select', {
      image,
      mode: 'rectangle',
      x: 380,
      y: 0,
      width: 260,
      height: 200,
      name: 'Hard',
    });
    if (noise)
      await session.call('adjust', { image, type: 'noise_reduction', strength: 6, mask: 'Soft' });
    await session.call('effect', { image, type: 'surface_blur', radius: 5, mask: 'Hard' });
    await session.call('adjust', { image, type: 'hue_saturation', saturation: -60, mask: 'Soft' });
    await session.call('adjust', { image, type: 'gaussian_blur', radius: 2 });
    await session.call('adjust', { image, type: 'clarity', mask: 'Hard' });
    await session.call('adjust', { image, type: 'gaussian_blur', radius: 6, mask: 'Soft' });
    if (noise)
      await session.call('adjust', { image, type: 'noise_reduction', strength: 10, mask: 'Hard' });
    await session.call('adjust', {
      image,
      type: 'curves',
      points: [
        [0, 10],
        [128, 150],
        [255, 245],
      ],
    });
    return image;
  }

  it('exports exactly what GIMP itself renders, and leaves the document and its filters as they were', async () => {
    const image = await stacked();
    const before = await filterNames(image);
    const baked = await exportPng(image);
    const ref = (await native(image)).ppm;
    // Exact away from the canvas edges. Along them GIMP's single pass lets a spatial filter read the
    // filter below it past the edge, where a baked layer simply ends (as GIMP's own bake does).
    const inside = apartInside(baked, ref, 24);
    expect(inside.max, JSON.stringify(inside)).toBeLessThanOrEqual(1);
    expect(apart(baked, ref).within1).toBeGreaterThan(0.99);
    expect(await filterNames(image)).toEqual(before);
    // A second export is the same render again.
    expect(maxAbsDiff(await exportPng(image), baked)).toBe(0);
  });

  it('exports a stack with masked noise reductions to within their chunk seams', async () => {
    const image = await stacked(true);
    const d = apart(await exportPng(image), (await native(image)).ppm);
    // Measured on this extreme noise field: ~98% of values within one level; a photo comes far closer.
    expect(d.within1, JSON.stringify(d)).toBeGreaterThan(0.95);
    expect(d.mean).toBeLessThan(0.5);
  });

  it('renders a region exactly as that part of the whole render, spatial filters included', async () => {
    const image = await stacked();
    const whole = await exportPng(image);
    // Straddles both masks and an edge of the canvas, small enough not to be scaled down.
    const region = { x: 300, y: 0, width: 300, height: 260 };
    const path = out();
    const r = await session.call<{ proxy: boolean }>('preview', {
      image,
      max_px: 512,
      region,
      out_path: path,
    });
    expect(r.proxy).toBe(false);
    const d = apart(readPng(path), crop(whole, region.x, region.y, region.width, region.height));
    expect(d.max, JSON.stringify(d)).toBeLessThanOrEqual(1);
  });

  it('renders a region of a vignetted photo where the whole photo has it', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: photo });
    await session.call('select', {
      image,
      mode: 'ellipse',
      x: 100,
      y: 100,
      width: 300,
      height: 250,
      name: 'Soft',
      feather_px: 30,
    });
    await session.call('adjust', { image, type: 'noise_reduction', strength: 4, mask: 'Soft' });
    await session.call('effect', { image, type: 'vignette' });
    const whole = await exportPng(image);
    const region = { x: 400, y: 280, width: 240, height: 200 };
    const path = out();
    await session.call('preview', { image, max_px: 512, region, out_path: path });
    expect(
      maxAbsDiff(readPng(path), crop(whole, region.x, region.y, region.width, region.height))
    ).toBeLessThanOrEqual(1);
  });

  it('flattens to the export, with no filter left and the layer GIMP itself would make', async () => {
    const image = await stacked();
    const exported = await exportPng(image);
    const { name } = await native(image);
    const flat = await session.call<{ layer_id: number; name: string; has_alpha: boolean }>(
      'layer',
      { image, op: 'flatten' }
    );
    expect(flat.name).toBe(name);
    expect(flat.has_alpha).toBe(false);
    expect(await filterNames(image)).toEqual([]);
    const after = await exportPng(image);
    expect(maxAbsDiff(after, exported)).toBeLessThanOrEqual(1);
  });

  it('leaves a document with a filter the ledger does not know to GIMP, exactly', async () => {
    const image = await stacked();
    await session.call('test_add_foreign_filter', {
      image,
      operation: 'gegl:gaussian-blur',
      props: { 'std-dev-x': 3.0, 'std-dev-y': 3.0 },
    });
    expect(maxAbsDiff(await exportPng(image), (await native(image)).ppm)).toBe(0);
  });

  it('exports a reopened document exactly as before the save, masked filters included', async () => {
    const image = await stacked(true);
    // One filter hidden, so visibility must survive the reopen too.
    const listed = await session.call<{
      filters: Array<{ filter_id: number; name: string; type: string }>;
    }>('list_filters', { image });
    const hid = listed.filters.find((f) => f.type === 'gaussian_blur')!;
    await session.call('filter', {
      image,
      op: 'set_visibility',
      filter_id: hid.filter_id,
      visible: false,
    });
    const before = await exportPng(image);
    const names = await filterNames(image);
    const xcf = out('xcf');
    await session.call('export', { image, path: xcf });
    await session.call('close', { image });

    const reopened = (await session.call<{ image: number }>('open', { path: xcf })).image;
    expect(await filterNames(reopened)).toEqual(names);
    // GIMP renders a reopened document's softly masked filters differently from before the save; the
    // export reads the channels, which an XCF brings back unchanged.
    expect(maxAbsDiff(await exportPng(reopened), before)).toBeLessThanOrEqual(1);
  });

  it('renders the photo without its filters for the selection service, whole or a region', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: photo });
    const plain = out();
    await session.call('preview', { image, max_px: 512, out_path: plain });
    const plainRegion = out();
    const region = { x: 100, y: 100, width: 200, height: 150 };
    await session.call('preview', { image, max_px: 512, region, out_path: plainRegion });
    await session.call('adjust', { image, type: 'noise_reduction', strength: 8 });
    await session.call('adjust', { image, type: 'exposure', exposure: 1 });
    const path = out();
    const r = await session.call<{ filters: boolean }>('preview', {
      image,
      max_px: 512,
      filters: false,
      out_path: path,
    });
    expect(r.filters).toBe(false);
    expect(maxAbsDiff(readPng(path), readPng(plain))).toBeLessThanOrEqual(1);
    const regionPath = out();
    await session.call('preview', {
      image,
      max_px: 512,
      region,
      filters: false,
      out_path: regionPath,
    });
    expect(maxAbsDiff(readPng(regionPath), readPng(plainRegion))).toBeLessThanOrEqual(1);
    // The document keeps its filters.
    expect((await filterNames(image)).length).toBe(2);
  });
});
