/**
 * `match_layer` against real headless GIMP: a warm square placed on a cool background, matched
 * to its surround, then checked from an independently decoded PNG export (`support.ts`'s
 * `readPng`) rather than from GIMP's own histogram. Covers the transfer direction and size,
 * tone-only, strength 0, replace-not-stack, listing/deleting through the filter op, the edge
 * options, selection/visibility preservation, and the refusals.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  patchMean,
  writeRgbaSquare,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

vi.setConfig({ testTimeout: 60_000 });

const install: GimpInstall | null = await detectGimp();

const CANVAS = 200;
const BG: [number, number, number] = [80, 110, 170];
const WARM: [number, number, number] = [220, 150, 90];
const SUBJECT_X = 70;
const SUBJECT_Y = 70;
const SUBJECT_SIZE = 60;

interface MatchResult {
  layer_id: number;
  filters: Array<{ filter_id: number; name: string; channel: string }>;
  replaced_filter_ids: number[];
  measured: { layer_pixels: number; reference_pixels: number };
  channels: Record<
    string,
    {
      before: { mean: number; std: number };
      after: { mean: number; std: number };
      reference: { mean: number; std: number };
      gain: number;
    }
  >;
  edge: { contract_px: number; feather_px: number; mask_created: boolean } | null;
}

interface FilterRow {
  filter_id: number;
  name: string;
  type: string;
  source: string;
}

describe.skipIf(!install)('match_layer: pull a pasted layer toward its surround', () => {
  let workDir: string;
  let session: GimpSession;
  let bgPath: string;
  let subjectPath: string;
  let tinyPath: string;
  let counter = 0;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-match-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    bgPath = join(workDir, 'bg.png');
    subjectPath = join(workDir, 'subject.png');
    tinyPath = join(workDir, 'tiny.png');
    writeRgbaSquare(bgPath, CANVAS, CANVAS, 0, 0, CANVAS, BG);
    writeRgbaSquare(subjectPath, SUBJECT_SIZE, SUBJECT_SIZE, 0, 0, SUBJECT_SIZE, WARM);
    writeRgbaSquare(tinyPath, 10, 10, 0, 0, 10, WARM);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** A fresh scene: the background opened, the warm subject placed on top of it. */
  async function scene(path = subjectPath): Promise<{ image: number; layerId: number }> {
    const opened = await session.call<{ image: number }>('open', { path: bgPath });
    const placed = await session.call<{ layer_id: number }>('place_image', {
      image: opened.image,
      path,
      x: SUBJECT_X,
      y: SUBJECT_Y,
    });
    return { image: opened.image, layerId: placed.layer_id };
  }

  async function render(image: number) {
    const out = join(workDir, `render-${counter++}.png`);
    await session.call('export', { image, path: out });
    return readPng(out);
  }

  const subjectCenter = (ppm: ReturnType<typeof readPng>) =>
    patchMean(ppm, SUBJECT_X + 20, SUBJECT_Y + 20, 20, 20);

  async function filterRows(image: number): Promise<FilterRow[]> {
    const listed = await session.call<{ filters: FilterRow[] }>('filter', { image, op: 'list' });
    return listed.filters;
  }

  async function layersJson(image: number): Promise<string> {
    return JSON.stringify(await session.call('describe', { image, what: 'layers' }));
  }

  it('moves the layer toward the surround by about `strength` and reports the measured stats', async () => {
    const { image, layerId } = await scene();
    const before = subjectCenter(await render(image));
    expect(before).toEqual(WARM);

    const result = await session.call<MatchResult>('match_layer', {
      image,
      layer_id: layerId,
      strength: 70,
    });
    expect(result.filters.map((f) => f.name)).toEqual(['Match red', 'Match green', 'Match blue']);
    expect(result.measured.layer_pixels).toBe(SUBJECT_SIZE * SUBJECT_SIZE);
    expect(result.measured.reference_pixels).toBeGreaterThan(4000);
    expect(result.channels.red!.before.mean).toBeCloseTo(WARM[0], 0);
    expect(result.channels.red!.reference.mean).toBeCloseTo(BG[0], 0);

    const after = subjectCenter(await render(image));
    for (let c = 0; c < 3; c++) {
      const expected = WARM[c]! + (BG[c]! - WARM[c]!) * 0.7;
      expect(after[c]!, `channel ${c}`).toBeGreaterThan(Math.min(WARM[c]!, BG[c]!) - 1);
      expect(Math.abs(after[c]! - expected), `channel ${c}`).toBeLessThanOrEqual(3);
      // direction: strictly closer to the background than the original was
      expect(Math.abs(after[c]! - BG[c]!)).toBeLessThan(Math.abs(WARM[c]! - BG[c]!));
      expect(result.channels[['red', 'green', 'blue'][c]!]!.after.mean).toBeCloseTo(expected, 0);
    }
    // the background itself is untouched
    expect(patchMean(await render(image), 5, 5, 20, 20)).toEqual(BG);
  });

  it("reference 'below' agrees with 'surround' over a flat background", async () => {
    const { image, layerId } = await scene();
    await session.call('match_layer', { image, layer_id: layerId, reference: 'below' });
    const after = subjectCenter(await render(image));
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(after[c]! - (WARM[c]! + (BG[c]! - WARM[c]!) * 0.7))).toBeLessThanOrEqual(3);
    }
  });

  it('tone only adds one value curve: brightness moves, the colour balance stays', async () => {
    const { image, layerId } = await scene();
    const result = await session.call<MatchResult>('match_layer', {
      image,
      layer_id: layerId,
      match: 'tone',
      strength: 100,
    });
    expect(result.filters.map((f) => f.name)).toEqual(['Match value']);
    const after = subjectCenter(await render(image));
    // value (max of R,G,B) goes 220 -> 170: every channel shifts by the same -50
    expect(Math.abs(Math.max(...after) - 170)).toBeLessThanOrEqual(3);
    expect(Math.abs(after[0]! - after[2]! - (WARM[0] - WARM[2]))).toBeLessThanOrEqual(3);
    expect(Math.abs(after[0]! - after[1]! - (WARM[0] - WARM[1]))).toBeLessThanOrEqual(3);
  });

  it('strength 0 leaves the pixels unchanged', async () => {
    const { image, layerId } = await scene();
    await session.call('match_layer', { image, layer_id: layerId, strength: 0 });
    const after = subjectCenter(await render(image));
    for (let c = 0; c < 3; c++) expect(Math.abs(after[c]! - WARM[c]!)).toBeLessThanOrEqual(1);
  });

  it('re-running replaces its own filters instead of stacking, and they list and delete like any filter', async () => {
    const { image, layerId } = await scene();
    const first = await session.call<MatchResult>('match_layer', { image, layer_id: layerId });
    const second = await session.call<MatchResult>('match_layer', { image, layer_id: layerId });
    expect(second.replaced_filter_ids.sort()).toEqual(first.filters.map((f) => f.filter_id).sort());
    // measured against the layer WITHOUT the earlier match: same inputs, same answer
    expect(second.channels.red!.before.mean).toBeCloseTo(first.channels.red!.before.mean, 1);

    const rows = (await filterRows(image)).filter((f) => f.name.startsWith('Match'));
    expect(rows).toHaveLength(3);
    expect(rows.every((f) => f.type === 'curves' && f.source === 'editmamei')).toBe(true);
    expect(rows.map((f) => f.name).sort()).toEqual(['Match blue', 'Match green', 'Match red']);

    const red = rows.find((f) => f.name === 'Match red')!;
    await session.call('filter', { image, op: 'delete', filter_id: red.filter_id });
    expect((await filterRows(image)).filter((f) => f.name.startsWith('Match'))).toHaveLength(2);
    const after = subjectCenter(await render(image));
    expect(after[0]).toBe(WARM[0]); // red is back to its own value; green and blue still moved
    expect(after[1]).toBeLessThan(WARM[1]! - 10);
  });

  it('a layer with no filter-free tone of its own is measured as it renders, so a re-match after another match changes nothing else', async () => {
    const { image, layerId } = await scene();
    await session.call('match_layer', { image, layer_id: layerId });
    const once = subjectCenter(await render(image));
    await session.call('match_layer', { image, layer_id: layerId });
    const twice = subjectCenter(await render(image));
    for (let c = 0; c < 3; c++) expect(Math.abs(once[c]! - twice[c]!)).toBeLessThanOrEqual(1);
  });

  it('edge contract and feather refine a layer mask made from the alpha, leaving alpha alone', async () => {
    const { image, layerId } = await scene();
    expect(await session.call('test_layer_mask_stats', { image, layer_id: layerId })).toMatchObject(
      { has_mask: false }
    );
    const result = await session.call<MatchResult>('match_layer', {
      image,
      layer_id: layerId,
      edge_contract_px: 3,
      edge_feather_px: 4,
    });
    expect(result.edge).toEqual({ contract_px: 3, feather_px: 4, mask_created: true });
    const stats = await session.call<{
      has_mask: boolean;
      on: number;
      off: number;
      partial: number;
    }>('test_layer_mask_stats', { image, layer_id: layerId });
    expect(stats.has_mask).toBe(true);
    expect(stats.partial).toBeGreaterThan(0);
    expect(stats.off).toBeGreaterThan(0);
    expect(stats.on).toBeGreaterThan(0);
    // the layer's corner is hidden by the mask: the render there is the background
    const ppm = await render(image);
    expect(patchMean(ppm, SUBJECT_X, SUBJECT_Y, 1, 1)).toEqual(BG);
    // and a second run, with the mask now present, measures only what the mask shows
    const again = await session.call<MatchResult>('match_layer', { image, layer_id: layerId });
    expect(again.edge).toBeNull();
    expect(again.measured.layer_pixels).toBeLessThan(SUBJECT_SIZE * SUBJECT_SIZE);
  });

  it('leaves the selection and every layer property as they were', async () => {
    const { image, layerId } = await scene();
    const layersBefore = await layersJson(image);
    await session.call('test_select_rect', { image, x: 10, y: 10, width: 30, height: 30 });
    await session.call('match_layer', {
      image,
      layer_id: layerId,
      edge_contract_px: 2,
      edge_feather_px: 2,
    });
    expect(await session.call('test_selection_empty', { image })).toMatchObject({
      selection_empty: false,
    });
    // only the new mask differs; names, visibility, opacity, order are as before
    const before = JSON.parse(layersBefore) as { layers: Array<Record<string, unknown>> };
    const after = JSON.parse(await layersJson(image)) as { layers: Array<Record<string, unknown>> };
    expect(after.layers.map((l) => [l.name, l.visible, l.opacity])).toEqual(
      before.layers.map((l) => [l.name, l.visible, l.opacity])
    );

    const other = await scene();
    await session.call('match_layer', { image: other.image, layer_id: other.layerId });
    expect(await session.call('test_selection_empty', { image: other.image })).toMatchObject({
      selection_empty: true,
    });
  });

  it('leaves the document untouched when it refuses', async () => {
    const { image, layerId } = await scene();
    const before = await layersJson(image);

    await session.call('test_lock_layer', { image, layer_id: layerId });
    await expect(session.call('match_layer', { image, layer_id: layerId })).rejects.toThrow(
      /locked/
    );
    await session.call('test_lock_layer', { image, layer_id: layerId, locked: false });

    const text = await session.call<{ layer_id: number }>('test_add_text_layer', { image });
    await expect(session.call('match_layer', { image, layer_id: text.layer_id })).rejects.toThrow(
      /text layer/
    );
    await session.call('layer', { image, op: 'delete', layer_id: text.layer_id });

    // the background has nothing beneath it
    const bottom = await session.call<{ layers: Array<{ layer_id: number; name: string }> }>(
      'describe',
      { image, what: 'layers' }
    );
    const bgId = bottom.layers[bottom.layers.length - 1]!.layer_id;
    await expect(
      session.call('match_layer', { image, layer_id: bgId, reference: 'below' })
    ).rejects.toThrow(/no visible layers below/);

    await expect(
      session.call('match_layer', { image, layer_id: layerId, strength: 150 })
    ).rejects.toThrow(/strength/);

    expect(await layersJson(image)).toBe(before);
    expect(await filterRows(image)).toHaveLength(0);
    expect(await session.call('test_selection_empty', { image })).toMatchObject({
      selection_empty: true,
    });
  });

  it('refuses a layer with too few pixels to measure', async () => {
    const { image, layerId } = await scene(tinyPath);
    await expect(session.call('match_layer', { image, layer_id: layerId })).rejects.toThrow(
      /only 100 visible pixels/
    );
    expect(await filterRows(image)).toHaveLength(0);
  });
});
