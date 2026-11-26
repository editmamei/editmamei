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
  readPngRgba,
  writeRgbaSquare,
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

  it('renders one layer without its filters for the selection service', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: photo });
    const layer_id = (
      await session.call<{ layers: Array<{ layer_id: number }> }>('describe', {
        image,
        what: 'layers',
      })
    ).layers[0]!.layer_id;
    const plain = out();
    await session.call('render_layer', { image, layer_id, max_px: 512, out_path: plain });
    await session.call('adjust', { image, type: 'gaussian_blur', radius: 4 });
    const path = out();
    await session.call('render_layer', {
      image,
      layer_id,
      max_px: 512,
      filters: false,
      out_path: path,
    });
    expect(maxAbsDiff(readPng(path), readPng(plain))).toBeLessThanOrEqual(1);
    expect((await filterNames(image)).length).toBe(1);
  });

  it('leaves a masked filter on a layer with transparency to GIMP, exactly', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: photo });
    const sticker = join(workDir, 'sticker-alone.png');
    writeRgbaSquare(sticker, 200, 150, 40, 30, 120, [220, 40, 40]);
    await session.call('place_image', { image, path: sticker, x: 40, y: 300, name: 'Sticker' });
    await session.call('select', {
      image,
      mode: 'ellipse',
      x: 60,
      y: 320,
      width: 160,
      height: 130,
      name: 'Low',
      feather_px: 20,
    });
    await session.call('adjust', {
      image,
      layer: 'Sticker',
      type: 'gaussian_blur',
      radius: 6,
      mask: 'Low',
    });
    expect(maxAbsDiff(await exportPng(image), (await native(image)).ppm)).toBe(0);
  });

  it.each([
    ['at 40% opacity', { opacity: 40 }],
    ['in Multiply', { mode: 'multiply' }],
  ])(
    'clips a filtered layer past white before blending it, like GIMP (%s)',
    async (_label, set) => {
      const { image } = await session.call<{ image: number }>('open', { path: photo });
      const first = async () =>
        (
          await session.call<{ layers: Array<{ layer_id: number }> }>('describe', {
            image,
            what: 'layers',
          })
        ).layers[0]!.layer_id;
      await session.call('layer', { image, op: 'duplicate', layer_id: await first() });
      const copy = await first();
      await session.call('layer', { image, op: 'set', layer_id: copy, ...set });
      await session.call('adjust', { image, layer_id: copy, type: 'exposure', exposure: 1 });
      // On one layer the values past white are kept from filter to filter: +1 then -1 comes back.
      await session.call('adjust', { image, type: 'exposure', exposure: 1 });
      await session.call('adjust', { image, type: 'exposure', exposure: -1 });
      expect((await session.call<{ bakeable: boolean }>('test_bakeable', { image })).bakeable).toBe(
        true
      );
      expect(maxAbsDiff(await exportPng(image), (await native(image)).ppm)).toBeLessThanOrEqual(1);
    }
  );

  it('leaves a document with a layer group to GIMP, exactly', async () => {
    // A group of two visible layers, the upper one filtered at 60%: GIMP clips the group's own result
    // before blending it, which a float bake would not.
    const { image } = await session.call<{ image: number }>('open', { path: photo });
    await session.call('test_wrap_in_group', { image });
    await session.call('test_add_offset_layer', {
      image,
      name: 'Inside',
      width: 640,
      height: 480,
      x: 0,
      y: 0,
    });
    const tree = await session.call<{ layers: Array<{ layer_id: number; name: string }> }>(
      'describe',
      { image, what: 'layers' }
    );
    const group = tree.layers.find((l) => l.name === 'Group')!;
    const inside = tree.layers.find((l) => l.name === 'Inside')!;
    await session.call('layer', {
      image,
      op: 'reorder',
      layer_id: inside.layer_id,
      parent_group: group.layer_id,
      position: 0,
    });
    await session.call('layer', { image, op: 'set', layer_id: inside.layer_id, opacity: 60 });
    await session.call('adjust', {
      image,
      layer_id: inside.layer_id,
      type: 'exposure',
      exposure: 1,
    });
    expect((await session.call<{ bakeable: boolean }>('test_bakeable', { image })).bakeable).toBe(
      false
    );
    expect(maxAbsDiff(await exportPng(image), (await native(image)).ppm)).toBe(0);
  });

  describe('a document of several layers', () => {
    let image: number;
    let layerId: (name: string) => Promise<number>;

    /** A copy of the photo at 40% with a masked filter; a placed sticker with alpha and a blur; a small
     * offset layer with a layer mask and filters of its own; a text layer with a filter; and a hidden
     * layer on top. No layer group: GIMP renders a document with one itself. */
    beforeAll(async () => {
      image = (await session.call<{ image: number }>('open', { path: photo })).image;
      type Node = { layer_id: number; name: string; children?: Node[] };
      layerId = async (name: string) => {
        const doc = await session.call<{ layers: Node[] }>('describe', { image, what: 'layers' });
        const walk = (nodes: Node[]): Node | undefined => {
          for (const n of nodes) {
            if (n.name === name) return n;
            const found = n.children && walk(n.children);
            if (found) return found;
          }
          return undefined;
        };
        return walk(doc.layers)!.layer_id;
      };
      const photoLayer = (
        await session.call<{ layers: Node[] }>('describe', { image, what: 'layers' })
      ).layers[0]!.layer_id;
      // The copy first, while the photo has no filters (a copy of a filtered layer would share their names).
      await session.call('layer', { image, op: 'duplicate', layer_id: photoLayer });
      const copyLayer = (
        await session.call<{ layers: Node[] }>('describe', { image, what: 'layers' })
      ).layers[0]!.layer_id;
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
      await session.call('select', {
        image,
        mode: 'ellipse',
        x: 60,
        y: 320,
        width: 160,
        height: 130,
        name: 'Low',
        feather_px: 20,
      });
      await session.call('adjust', {
        image,
        layer_id: photoLayer,
        type: 'curves',
        points: [
          [0, 10],
          [128, 150],
          [255, 245],
        ],
      });
      await session.call('adjust', {
        image,
        layer_id: photoLayer,
        type: 'gaussian_blur',
        radius: 4,
        mask: 'Soft',
      });
      await session.call('effect', {
        image,
        layer_id: photoLayer,
        type: 'surface_blur',
        radius: 5,
        mask: 'Hard',
      });
      await session.call('layer', {
        image,
        op: 'set',
        layer_id: copyLayer,
        opacity: 40,
      });
      await session.call('adjust', {
        image,
        layer_id: copyLayer,
        type: 'exposure',
        exposure: 1,
        mask: 'Hard',
      });
      const sticker = join(workDir, 'sticker.png');
      writeRgbaSquare(sticker, 200, 150, 40, 30, 120, [220, 40, 40]);
      await session.call('place_image', { image, path: sticker, x: 40, y: 300, name: 'Sticker' });
      await session.call('adjust', {
        image,
        layer: 'Sticker',
        type: 'gaussian_blur',
        radius: 6,
      });
      await session.call('test_add_offset_layer', {
        image,
        name: 'Offset',
        width: 120,
        height: 100,
        x: 20,
        y: 20,
      });
      await session.call('adjust', { image, layer: 'Offset', type: 'exposure', exposure: -2 });
      await session.call('adjust', { image, layer: 'Offset', type: 'gaussian_blur', radius: 3 });
      await session.call('test_add_layer_mask', { image, layer_id: await layerId('Offset') });
      const text = await session.call<{ layer_id: number; name: string }>('test_add_text_layer', {
        image,
        text: 'Edit',
      });
      await session.call('adjust', {
        image,
        layer_id: text.layer_id,
        type: 'exposure',
        exposure: -1,
      });
      await session.call('test_add_offset_layer', {
        image,
        name: 'Hidden',
        width: 100,
        height: 100,
        x: 500,
        y: 350,
      });
      await session.call('layer', {
        image,
        op: 'set',
        layer_id: await layerId('Hidden'),
        visible: false,
      });
    });

    it('exports what GIMP renders, away from the canvas edges', async () => {
      expect((await session.call<{ bakeable: boolean }>('test_bakeable', { image })).bakeable).toBe(
        true
      );
      const baked = await exportPng(image);
      const ref = (await native(image)).ppm;
      const inside = apartInside(baked, ref, 24);
      expect(inside.max, JSON.stringify(inside)).toBeLessThanOrEqual(1);
    });

    it('keeps transparency like GIMP, with a hidden layer left out', async () => {
      const path = out();
      await session.call('export', { image, path, keep_alpha: true });
      const refPath = out();
      await session.call('test_native_render', { image, out_path: refPath, keep_alpha: true });
      const a = readPngRgba(path);
      const b = readPngRgba(refPath);
      let worst = 0;
      for (let y = 24; y < a.height - 24; y++) {
        for (let x = 24; x < a.width - 24; x++) {
          for (let c = 0; c < 4; c++) {
            const i = (y * a.width + x) * 4 + c;
            worst = Math.max(worst, Math.abs(a.data[i]! - b.data[i]!));
          }
        }
      }
      expect(worst).toBeLessThanOrEqual(1);
    });

    it('renders a region that leaves several layers out, as that part of the whole', async () => {
      const whole = await exportPng(image);
      // Far from the sticker and the offset layer: the padded crop drops them.
      const region = { x: 360, y: 120, width: 260, height: 180 };
      const path = out();
      await session.call('preview', { image, max_px: 512, region, out_path: path });
      const d = apart(readPng(path), crop(whole, region.x, region.y, region.width, region.height));
      expect(d.max, JSON.stringify(d)).toBeLessThanOrEqual(1);
    });

    it('renders a region for removal, with and without a hole', async () => {
      const whole = await exportPng(image);
      const box = [360, 120, 260, 180];
      const plain = out();
      await session.call('render_region', { image, box, out_path: plain });
      expect(maxAbsDiff(readPng(plain), crop(whole, 360, 120, 260, 180))).toBeLessThanOrEqual(1);
      const holed = out();
      await session.call('render_region', { image, box, hole_channel: 'Hard', out_path: holed });
      const rgba = readPngRgba(holed);
      expect([rgba.width, rgba.height]).toEqual([260, 180]);
      // (400, 150) is inside Hard, (380, 260) is below it.
      expect(rgba.data[((150 - 120) * 260 + (400 - 360)) * 4 + 3]).toBe(0);
      expect(rgba.data[((260 - 120) * 260 + (380 - 360)) * 4 + 3]).toBe(255);
    });
  });
});
