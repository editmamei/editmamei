/**
 * `retouch` against real headless GIMP: a seeded noise texture with dark dots, healed and cloned,
 * then checked from an independently decoded PNG export (`support.ts`'s `readPng`). Covers spot
 * heal landing near the surround's mean and spread, heal/clone footprints, an exact clone patch,
 * the Retouch layer being made once and reused, in_place, the user's selection surviving, the
 * paint context being left as found, the refusals, and a layer that sits at an offset.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import { readPng, readySession, LIVE_READY_TIMEOUT_MS, TEST_OPS_PY } from './support.ts';

vi.setConfig({ testTimeout: 120_000 });

const install: GimpInstall | null = await detectGimp();

const SIZE = 300;
const BASE = 120;
const AMP = 20;
const DOTS = [
  { x: 80, y: 80, radius: 6, value: 30 },
  { x: 200, y: 100, radius: 10, value: 30 },
  { x: 150, y: 220, radius: 8, value: 240 },
];

interface RetouchResult {
  layer_id: number;
  layer_name: string;
  created_layer: boolean;
  method: string;
  painted_bbox: [number, number, number, number];
  spots?: Array<{
    x: number;
    y: number;
    radius: number;
    source_dx: number;
    source_dy: number;
    score: number;
  }>;
}

type Ppm = ReturnType<typeof readPng>;

/** Mean and standard deviation of the green channel over a disc (image pixels). */
function discStats(ppm: Ppm, cx: number, cy: number, r: number, inner = 0) {
  const vals: number[] = [];
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r && d >= inner && x >= 0 && y >= 0 && x < ppm.width && y < ppm.height) {
        vals.push(ppm.data[(y * ppm.width + x) * 3 + 1]!);
      }
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { mean, std };
}

const px = (ppm: Ppm, x: number, y: number) => ppm.data[(y * ppm.width + x) * 3 + 1]!;

describe.skipIf(!install)('retouch: heal, clone and spot heal', () => {
  let workDir: string;
  let session: GimpSession;
  let counter = 0;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-retouch-'));
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

  async function texture(extra: Record<string, unknown> = {}) {
    return session.call<{ image: number; layer_id: number }>('test_texture_image', {
      width: SIZE,
      height: SIZE,
      base: BASE,
      amplitude: AMP,
      seed: 7,
      dots: DOTS,
      ...extra,
    });
  }

  async function render(image: number): Promise<Ppm> {
    const out = join(workDir, `render-${counter++}.png`);
    await session.call('export', { image, path: out });
    return readPng(out);
  }

  const layerNames = async (image: number) =>
    (await session.call<{ names: string[] }>('test_all_layers_order', { image })).names;

  it('spot_heal brings each spot to the surround mean and spread, on a Retouch layer', async () => {
    const { image, layer_id } = await texture();
    const before = await render(image);
    for (const d of DOTS)
      expect(Math.abs(discStats(before, d.x, d.y, d.radius - 1).mean - d.value)).toBeLessThan(3);

    const result = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: DOTS.map(({ x, y, radius }) => ({ x, y, radius })),
    });
    expect(result.created_layer).toBe(true);
    expect(result.layer_name).toBe('Retouch');
    expect(result.layer_id).not.toBe(layer_id);
    expect(result.spots).toHaveLength(3);
    for (const s of result.spots!) {
      expect(Math.hypot(s.source_dx, s.source_dy)).toBeGreaterThan(s.radius * 2);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThan(25);
    }
    expect(await layerNames(image)).toEqual(['Retouch', 'Texture']);

    const after = await render(image);
    for (const d of DOTS) {
      const spot = discStats(after, d.x, d.y, d.radius);
      const ring = discStats(after, d.x, d.y, d.radius * 1.6 + 6, d.radius * 1.3);
      expect(Math.abs(spot.mean - ring.mean), `dot ${d.x},${d.y} mean`).toBeLessThan(16);
      expect(spot.std, `dot ${d.x},${d.y} std`).toBeLessThan(ring.std * 2 + 3);
    }
    // the original layer still has its dots
    await session.call('layer', { image, op: 'set', layer_id: result.layer_id, visible: false });
    const hidden = await render(image);
    expect(discStats(hidden, 80, 80, 5).mean).toBeLessThan(60);
  });

  it('a spot too close to the edge for any source is refused, leaving no Retouch layer', async () => {
    const { image, layer_id } = await texture({ width: 60, height: 60, dots: [] });
    await expect(
      session.call('retouch', {
        image,
        layer_id,
        method: 'spot_heal',
        spots: [{ x: 30, y: 30, radius: 12 }],
      })
    ).rejects.toThrow(/no source area/);
    expect(await layerNames(image)).toEqual(['Texture']);
  });

  it('heal changes only near the stroke', async () => {
    const { image, layer_id } = await texture();
    const before = await render(image);
    const points = [
      [100, 150],
      [120, 150],
      [140, 150],
    ];
    const result = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'heal',
      points,
      source_offset: { dx: 0, dy: -60 },
      brush_size: 14,
      target: 'in_place',
    });
    expect(result.created_layer).toBe(false);
    expect(result.layer_id).toBe(layer_id);
    const [bx, by, bw, bh] = result.painted_bbox;
    expect(bw).toBeGreaterThanOrEqual(40);
    const after = await render(image);
    let changedInside = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const same = px(before, x, y) === px(after, x, y);
        const inside = x >= bx && x < bx + bw && y >= by && y < by + bh;
        if (!inside) expect(same, `pixel ${x},${y} outside the stroke`).toBe(true);
        else if (!same) changedInside++;
      }
    }
    expect(changedInside).toBeGreaterThan(100);
  });

  it('clone reproduces the source patch exactly at the destination', async () => {
    const { image, layer_id } = await texture({ dots: [] });
    const before = await render(image);
    const result = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'clone',
      points: [[220, 200]],
      source: { x: 60, y: 70 },
      brush_size: 20,
      hardness: 1,
      target: 'in_place',
    });
    expect(result.painted_bbox[2]).toBeGreaterThanOrEqual(20);
    const after = await render(image);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        expect(px(after, 220 + dx, 200 + dy), `offset ${dx},${dy}`).toBe(
          px(before, 60 + dx, 70 + dy)
        );
      }
    }
    // outside the brush nothing moved
    expect(px(after, 250, 200)).toBe(px(before, 250, 200));
  });

  it('reuses the Retouch layer on a second call instead of making another copy', async () => {
    const { image, layer_id } = await texture();
    const spot = { x: 80, y: 80, radius: 6 };
    const first = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [spot],
    });
    const second = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [{ x: 200, y: 100, radius: 10 }],
    });
    expect(first.created_layer).toBe(true);
    expect(second.created_layer).toBe(false);
    expect(second.layer_id).toBe(first.layer_id);
    expect(await layerNames(image)).toEqual(['Retouch', 'Texture']);
    const out = await render(image);
    expect(discStats(out, 80, 80, 5).mean).toBeGreaterThan(90);
    expect(discStats(out, 200, 100, 9).mean).toBeGreaterThan(90);
  });

  it('still reuses the Retouch layer after the image is saved and reopened (new layer ids)', async () => {
    const { image, layer_id } = await texture();
    const first = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [{ x: 80, y: 80, radius: 6 }],
    });
    expect(first.created_layer).toBe(true);
    const xcf = join(workDir, `reopen-${counter++}.xcf`);
    await session.call('export', { image, path: xcf });
    const reopened = await session.call<{ image: number }>('open', { path: xcf });
    expect(reopened.image).not.toBe(image);
    const second = await session.call<RetouchResult>('retouch', {
      image: reopened.image,
      layer: 'Texture',
      method: 'spot_heal',
      spots: [{ x: 200, y: 100, radius: 10 }],
    });
    expect(second.created_layer).toBe(false);
    expect(await layerNames(reopened.image)).toEqual(['Retouch', 'Texture']);
  });

  it('in_place paints the layer itself and adds no layer', async () => {
    const { image, layer_id } = await texture();
    const result = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [{ x: 80, y: 80, radius: 6 }],
      target: 'in_place',
    });
    expect(result.created_layer).toBe(false);
    expect(result.layer_id).toBe(layer_id);
    expect(await layerNames(image)).toEqual(['Texture']);
    expect(discStats(await render(image), 80, 80, 5).mean).toBeGreaterThan(90);
  });

  it('keeps the selection, and a selection that excludes the stroke does not clip it', async () => {
    const { image, layer_id } = await texture({ dots: [] });
    await session.call('test_select_rect', { image, x: 10, y: 10, width: 40, height: 40 });
    const before = await render(image);
    await session.call('retouch', {
      image,
      layer_id,
      method: 'clone',
      points: [[220, 200]],
      source: { x: 60, y: 70 },
      brush_size: 20,
      hardness: 1,
    });
    const after = await render(image);
    expect(px(after, 220, 200)).toBe(px(before, 60, 70));
    const sel = await session.call<{ selection_empty: boolean }>('test_selection_empty', { image });
    expect(sel.selection_empty).toBe(false);
    const bounds = await session.call<{ x: number; y: number; width: number; height: number }>(
      'test_selection_bounds',
      { image }
    );
    expect(bounds).toEqual({ x: 10, y: 10, width: 40, height: 40 });
  });

  it('leaves the paint context as it found it', async () => {
    const { image, layer_id } = await texture();
    const before = await session.call('test_brush_state', {});
    await session.call('retouch', {
      image,
      layer_id,
      method: 'heal',
      points: [[100, 150]],
      source_offset: { dx: 0, dy: -50 },
      brush_size: 37,
      hardness: 0.2,
    });
    await session.call('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [{ x: 80, y: 80, radius: 6 }],
    });
    expect(await session.call('test_brush_state', {})).toEqual(before);
  });

  it('refuses a layer group, a text layer, and points outside the layer', async () => {
    const { image, layer_id } = await texture();
    await session.call('test_wrap_in_group', { image });
    const names = await layerNames(image);
    expect(names).toContain('Group');
    await expect(
      session.call('retouch', {
        image,
        layer: 'Group',
        method: 'spot_heal',
        spots: [{ x: 80, y: 80, radius: 6 }],
      })
    ).rejects.toThrow(/layer group/);

    const text = await session.call<{ layer_id: number }>('test_add_text_layer', { image });
    await expect(
      session.call('retouch', {
        image,
        layer_id: text.layer_id,
        method: 'spot_heal',
        spots: [{ x: 80, y: 80, radius: 6 }],
      })
    ).rejects.toThrow(/text layer/);

    await expect(
      session.call('retouch', {
        image,
        layer_id,
        method: 'heal',
        points: [[400, 10]],
        source_offset: { dx: 0, dy: 20 },
      })
    ).rejects.toThrow(/outside the layer bounds x 0\.\.299, y 0\.\.299/);
    // the stroke is inside but its source (after the offset) is not
    await expect(
      session.call('retouch', {
        image,
        layer_id,
        method: 'heal',
        points: [[10, 10]],
        source_offset: { dx: -50, dy: 0 },
      })
    ).rejects.toThrow(/source point 0 .* outside the layer bounds/);
    await expect(
      session.call('retouch', { image, layer_id, method: 'clone', points: [[10, 10]] })
    ).rejects.toThrow(/exactly one of source/);
  });

  it('works in image pixels on a layer that sits at an offset', async () => {
    const { image, layer_id } = await texture({
      layer_width: 160,
      layer_height: 140,
      layer_x: 90,
      layer_y: 70,
      dots: [{ x: 150, y: 120, radius: 7, value: 30 }],
    });
    const before = await render(image);
    expect(discStats(before, 150, 120, 5).mean).toBeLessThan(60);

    const heal = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [{ x: 150, y: 120, radius: 7 }],
      target: 'in_place',
    });
    const [hx, hy, hw, hh] = heal.painted_bbox;
    expect(hx).toBeGreaterThanOrEqual(90);
    expect(hy).toBeGreaterThanOrEqual(70);
    expect(hx + hw).toBeLessThanOrEqual(250);
    expect(hy + hh).toBeLessThanOrEqual(210);
    expect(discStats(await render(image), 150, 120, 6).mean).toBeGreaterThan(90);

    // a clone with both ends in image pixels, exact
    const base = await render(image);
    await session.call('retouch', {
      image,
      layer_id,
      method: 'clone',
      points: [[200, 180]],
      source_offset: { dx: -60, dy: -50 },
      brush_size: 16,
      hardness: 1,
      target: 'in_place',
    });
    const after = await render(image);
    for (const [dx, dy] of [
      [0, 0],
      [2, -2],
      [-3, 3],
    ] as const) {
      expect(px(after, 200 + dx, 180 + dy)).toBe(px(base, 140 + dx, 130 + dy));
    }
    // a point in the canvas but outside the layer names the layer's bounds
    await expect(
      session.call('retouch', {
        image,
        layer_id,
        method: 'heal',
        points: [[50, 50]],
        source_offset: { dx: 10, dy: 10 },
      })
    ).rejects.toThrow(/x 90\.\.249, y 70\.\.209/);
  });

  it('refuses retouch_layer on a layer below 100% opacity and points at in_place', async () => {
    const { image, layer_id } = await texture();
    await session.call('layer', { image, op: 'set', layer_id, opacity: 50 });
    const call = (extra: Record<string, unknown>) =>
      session.call<RetouchResult>('retouch', {
        image,
        layer_id,
        method: 'spot_heal',
        spots: [{ x: 80, y: 80, radius: 6 }],
        ...extra,
      });
    await expect(call({})).rejects.toThrow(/in_place/);
    expect(await layerNames(image)).toEqual(['Texture']);
    const inPlace = await call({ target: 'in_place' });
    expect(inPlace.layer_id).toBe(layer_id);
  });

  it('refuses retouch_layer on a layer that is not in Normal mode or has a layer mask', async () => {
    const mode = await texture();
    await session.call('layer', {
      image: mode.image,
      op: 'set',
      layer_id: mode.layer_id,
      mode: 'multiply',
    });
    const spot = [{ x: 80, y: 80, radius: 6 }];
    await expect(
      session.call('retouch', { ...mode, method: 'spot_heal', spots: spot })
    ).rejects.toThrow(/in_place/);
    const masked = await texture();
    await session.call('test_add_layer_mask', { image: masked.image, layer_id: masked.layer_id });
    await expect(
      session.call('retouch', { ...masked, method: 'spot_heal', spots: spot })
    ).rejects.toThrow(/layer mask.*in_place/);
  });

  it('a Retouch layer leaves the composite alone outside the painted areas', async () => {
    // alpha 128 makes a stacked copy visible: without the mask, the copy would darken everything.
    const { image, layer_id } = await texture({ alpha: 128 });
    const before = await render(image);
    const heal = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'heal',
      points: [
        [100, 150],
        [130, 150],
      ],
      source_offset: { dx: 0, dy: -60 },
      brush_size: 16,
    });
    const spot = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [{ x: 220, y: 90, radius: 8 }],
    });
    expect(heal.created_layer).toBe(true);
    expect(spot.created_layer).toBe(false);
    const boxes = [heal.painted_bbox, spot.painted_bbox];
    const after = await render(image);
    let changedInside = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const same = px(before, x, y) === px(after, x, y);
        const inside = boxes.some(
          ([bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh
        );
        if (!inside) expect(same, `pixel ${x},${y} outside the painted areas`).toBe(true);
        else if (!same) changedInside++;
      }
    }
    expect(changedInside).toBeGreaterThan(50);
  });

  it('reveals the Retouch mask in the right place on a layer that sits at an offset', async () => {
    const { image, layer_id } = await texture({
      layer_width: 160,
      layer_height: 140,
      layer_x: 90,
      layer_y: 70,
      dots: [{ x: 150, y: 120, radius: 7, value: 30 }],
    });
    const before = await render(image);
    const strokes = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'heal',
      points: [
        [200, 180],
        [215, 180],
      ],
      source_offset: { dx: -40, dy: -30 },
      brush_size: 14,
    });
    const spot = await session.call<RetouchResult>('retouch', {
      image,
      layer_id,
      method: 'spot_heal',
      spots: [{ x: 150, y: 120, radius: 7 }],
    });
    const after = await render(image);
    const boxes = [strokes.painted_bbox, spot.painted_bbox];
    let changed = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const inside = boxes.some(
          ([bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh
        );
        const same = px(before, x, y) === px(after, x, y);
        if (!inside) expect(same, `pixel ${x},${y} outside the painted areas`).toBe(true);
        else if (!same) changed++;
      }
    }
    expect(changed).toBeGreaterThan(30);
    // the dot is gone: the spot's mask reveal landed on it
    expect(discStats(after, 150, 120, 5).mean).toBeGreaterThan(
      discStats(before, 150, 120, 5).mean + 30
    );
  });

  it('reuses a Retouch layer only for the layer it was made from', async () => {
    const a = await texture({ seed: 1 });
    const b = await session.call<{ layer_id: number }>('test_texture_image', {
      image: a.image,
      width: SIZE,
      height: SIZE,
      seed: 2,
      name: 'Other',
      dots: [],
    });
    const spot = [{ x: 80, y: 80, radius: 6 }];
    const first = await session.call<RetouchResult>('retouch', {
      image: a.image,
      layer_id: a.layer_id,
      method: 'spot_heal',
      spots: spot,
    });
    expect(await layerNames(a.image)).toEqual(['Other', 'Retouch', 'Texture']);
    // put Other's own place under that Retouch layer: the Retouch layer now sits directly above it
    await session.call('layer', {
      image: a.image,
      op: 'reorder',
      layer_id: first.layer_id,
      position: 0,
    });
    expect(await layerNames(a.image)).toEqual(['Retouch', 'Other', 'Texture']);
    const second = await session.call<RetouchResult>('retouch', {
      image: a.image,
      layer_id: b.layer_id,
      method: 'spot_heal',
      spots: spot,
    });
    expect(second.created_layer).toBe(true);
    expect(second.layer_id).not.toBe(first.layer_id);
    expect(await layerNames(a.image)).toHaveLength(4);
  });

  it('spot_heal is all or nothing: a spot with no source fails the call with nothing changed', async () => {
    const { image, layer_id } = await texture();
    const before = await render(image);
    await expect(
      session.call('retouch', {
        image,
        layer_id,
        method: 'spot_heal',
        target: 'in_place',
        spots: [
          { x: 80, y: 80, radius: 6 },
          { x: 150, y: 150, radius: 100 },
        ],
      })
    ).rejects.toThrow(/spot 1 .*no source area/);
    const after = await render(image);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++)
        expect(px(after, x, y), `pixel ${x},${y}`).toBe(px(before, x, y));
    expect(await layerNames(image)).toEqual(['Texture']);
  });

  it('refuses a hidden layer, an indexed image, and hardness on spot_heal', async () => {
    const { image, layer_id } = await texture();
    const spots = [{ x: 80, y: 80, radius: 6 }];
    await expect(
      session.call('retouch', { image, layer_id, method: 'spot_heal', spots, hardness: 0.5 })
    ).rejects.toThrow(/hardness does not apply/);
    await session.call('layer', { image, op: 'set', layer_id, visible: false });
    await expect(
      session.call('retouch', { image, layer_id, method: 'spot_heal', spots })
    ).rejects.toThrow(/hidden/);
    const indexed = await session.call<{ image: number }>('test_new_image', {
      base_type: 'indexed',
    });
    await expect(
      session.call('retouch', { image: indexed.image, method: 'spot_heal', spots })
    ).rejects.toThrow(/indexed/);
  });

  it('clones exactly from a source layer that sits at a different offset', async () => {
    const target = await texture({ seed: 4, dots: [] });
    const source = await session.call<{ layer_id: number }>('test_texture_image', {
      image: target.image,
      width: SIZE,
      height: SIZE,
      layer_width: 160,
      layer_height: 140,
      layer_x: 150,
      layer_y: 100,
      seed: 9,
      base: 200,
      name: 'Source',
      dots: [],
    });
    const before = await render(target.image);
    // the stroke is at (50, 50) on the target; its source is image point (200, 150), inside Source
    const result = await session.call<RetouchResult>('retouch', {
      image: target.image,
      layer_id: target.layer_id,
      method: 'clone',
      points: [[50, 50]],
      source: { x: 200, y: 150 },
      source_layer_id: source.layer_id,
      brush_size: 16,
      hardness: 1,
      target: 'in_place',
    });
    expect(result.layer_id).toBe(target.layer_id);
    const after = await render(target.image);
    // Source is opaque and on top, so the composite at its pixels is Source's own
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        expect(px(after, 50 + dx, 50 + dy), `offset ${dx},${dy}`).toBe(
          px(before, 200 + dx, 150 + dy)
        );
      }
    }
  });
});
