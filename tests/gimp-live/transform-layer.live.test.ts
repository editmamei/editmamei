/**
 * gimp_transform_layer against real headless GIMP, driven through the actual tool handlers and a
 * real `GimpBackend`/`GimpSession` — the same "drive the TOOLS, not the bridge" posture
 * `layers.live.test.ts` takes.
 *
 * Verified-live assumptions this file pins as regression tests (see `bridge/ops.py`'s own
 * "gimp_transform_layer" section comment for the full probe record):
 *  - `Item.transform_scale`/`transform_rotate`/`transform_flip_simple`/`transform_matrix` all
 *    carry a layer's own mask along automatically, repositioned and resized to match the layer's
 *    new bounds exactly.
 *  - Calling any of these on a GROUP layer transforms every descendant in lockstep with the
 *    group's own new bounds.
 *  - A layer with no alpha channel gets one before any op (`alpha_added: true`).
 *  - `interpolation` actually changes the resampled pixels (none vs cubic differ at a hard edge).
 *  - The masked-filter refusal reuses `_refuse_if_masked_filters_on` (the same check gimp_layer's
 *    own geometry ops apply), leaving the document unchanged.
 *  - An oversize scale is refused against the same size cap gimp_resize_image enforces.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
import { createGimpCoreTools } from '@editmamei/tools/gimp-core-tools.ts';
import { createGimpDocumentTools } from '@editmamei/tools/gimp-document-tools.ts';
import { createGimpInspectTools } from '@editmamei/tools/gimp-inspect-tools.ts';
import { createGimpAdjustmentTools } from '@editmamei/tools/gimp-adjustment-tools.ts';
import { createGimpMaskTools } from '@editmamei/tools/gimp-mask-tools.ts';
import { createGimpLayerTools } from '@editmamei/tools/gimp-layer-tools.ts';
import { createGimpComposeTools } from '@editmamei/tools/gimp-compose-tools.ts';
import { createGimpTransformLayerTools } from '@editmamei/tools/gimp-transform-layer-tools.ts';
import {
  TOOL_TIMEOUT_BUDGETS_MS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
} from '@editmamei/utils/operation-timeouts.ts';
import type { ToolDefinition, ToolResult } from '@editmamei/core/tool-registry.ts';
import { callTool } from '../fixtures/tool-helpers.ts';
import {
  writeGrayRamp,
  readPng,
  pixelAt,
  maxAbsDiff,
  readyGimpRegistry,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 60_000 });

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (transform-layer)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function writeRgbPng(
  path: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number]
): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

const RED: [number, number, number] = [220, 20, 20];
const GREEN: [number, number, number] = [20, 200, 20];
const BLUE: [number, number, number] = [20, 20, 220];
const YELLOW: [number, number, number] = [230, 220, 20];

/** TL=red, TR=green, BL=blue, BR=yellow -- flip swaps halves predictably, rotate 90 moves each
 * quadrant to the next corner. `width`/`height` must be even. */
function writeQuadrants(path: string, width: number, height: number): void {
  writeRgbPng(path, width, height, (x, y) => {
    const left = x < width / 2;
    const top = y < height / 2;
    if (top) return left ? RED : GREEN;
    return left ? BLUE : YELLOW;
  });
}

/** Left half `left`, right half `right` -- the mask-travel / offset-layer fixture. */
function writeHalves(
  path: string,
  width: number,
  height: number,
  left: [number, number, number],
  right: [number, number, number]
): void {
  writeRgbPng(path, width, height, (x) => (x < width / 2 ? left : right));
}

/** A hard black|white vertical edge -- for the interpolation none-vs-cubic check. */
function writeHardEdge(path: string, width: number, height: number): void {
  writeRgbPng(path, width, height, (x) => {
    const v = x < width / 2 ? 0 : 255;
    return [v, v, v];
  });
}

function structuredOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe.skipIf(!install)('gimp_transform_layer against real headless GIMP', () => {
  let workDir: string;
  let backend: GimpBackend;
  let tools: ToolDefinition[];

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-transform-layer-'));
    // opsPyPath: TEST_OPS_PY -- adds test_new_image, test_add_foreign_filter, test_add_layer_mask.
    backend = new GimpBackend(install, {
      sessionOptions: { rootDir: join(workDir, 'session-root'), opsPyPath: TEST_OPS_PY },
    });
    tools = [
      ...createGimpCoreTools(backend),
      ...createGimpDocumentTools(backend),
      ...createGimpInspectTools(backend),
      ...createGimpAdjustmentTools(backend),
      ...createGimpMaskTools(backend),
      ...createGimpLayerTools(backend),
      ...createGimpComposeTools(backend),
      ...createGimpTransformLayerTools(backend),
    ];
    await readyGimpRegistry((name, args) => callTool(tools, name, args));
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await backend.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function openQuadrants(
    width = 40,
    height = 40
  ): Promise<{ image: number; layer_id: number }> {
    const path = join(workDir, `quadrants-${width}x${height}.png`);
    writeQuadrants(path, width, height);
    const opened = await callTool(tools, 'gimp_open_document', { file_path: path });
    expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
    const image = structuredOf(opened).image as number;
    const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const layerId = (structuredOf(tree).layers as Array<{ layer_id: number }>)[0]!.layer_id;
    return { image, layer_id: layerId };
  }

  async function exportPng(image: number, label: string): Promise<ReturnType<typeof readPng>> {
    const path = join(workDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const result = await callTool(tools, 'gimp_export', { image, file_path: path });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return readPng(path);
  }

  /** A layer's current {x, y, width, height} WITHOUT mutating anything -- `gimp_inspect
   * what=layers` reports offsets but not width/height, and every real gimp_transform_layer op
   * mutates (so a zero-delta move would be refused by the SAME masked-filter check a test might
   * be probing). Goes straight to the bridge's own test-only probe instead. */
  async function layerBounds(image: number, layerId: number): Promise<Bounds> {
    return backend.call<Bounds>('test_layer_bounds', { image, layer_id: layerId });
  }

  // ---- fit / fill -------------------------------------------------------------------------

  it('fit letterboxes a landscape layer into a portrait canvas, filling into a landscape one, both centered', async () => {
    const path = join(workDir, 'fit-source.png');
    writeQuadrants(path, 40, 20); // 2:1 landscape
    const bg = await callTool(tools, 'gimp_create_document', {
      width: 40,
      height: 40,
      fill: 'white',
    });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', { image, file_path: path });
    const layerId = structuredOf(placed).layer_id as number;

    const fitted = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'fit',
      layer_id: layerId,
    });
    expect(fitted.isError, JSON.stringify(fitted.content)).toBeFalsy();
    const fitBounds = structuredOf(fitted).bounds as Bounds;
    // 40x20 into 40x40 'fit': scale is capped by the SHORTER ratio (height 40/20=2 vs width
    // 40/40=1) -- the width ratio wins, so the layer stays at its own 40px width, letterboxed
    // top/bottom (height becomes 20, centered).
    expect(fitBounds).toEqual({ x: 0, y: 10, width: 40, height: 20 });
    expect(structuredOf(fitted).scale_percent).toBe(100);

    const filled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'fit',
      layer_id: layerId,
      mode: 'fill',
    });
    expect(filled.isError, JSON.stringify(filled.content)).toBeFalsy();
    const fillBounds = structuredOf(filled).bounds as Bounds;
    // 'fill' covers: width ratio 1 vs height ratio 2 -- the LARGER wins (2x), giving an 80x40
    // layer centered (x=-20, y=0) over the 40x40 canvas.
    expect(fillBounds).toEqual({ x: -20, y: 0, width: 80, height: 40 });

    // fit is idempotent: re-applying the SAME mode to an already-fitted layer is a no-op scale
    // (100%) -- re-fitting with the OTHER mode is a real, different scale, so this re-applies
    // 'fill' again (the mode the layer is already sized for), not the default 'fit'.
    const refilled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'fit',
      layer_id: layerId,
      mode: 'fill',
    });
    expect(structuredOf(refilled).scale_percent).toBe(100);
    expect(structuredOf(refilled).bounds).toEqual(fillBounds);
  });

  // ---- scale --------------------------------------------------------------------------------

  it('scale 200% doubles the bounds and keeps the center fixed', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const before = await layerBounds(image, layer_id);
    const scaled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_percent: 200,
    });
    expect(scaled.isError, JSON.stringify(scaled.content)).toBeFalsy();
    const bounds = structuredOf(scaled).bounds as Bounds;
    expect(bounds).toEqual({ x: before.x - 20, y: before.y - 20, width: 80, height: 80 });
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    expect(centerX).toBe(before.x + before.width / 2);
    expect(centerY).toBe(before.y + before.height / 2);
  });

  it('non-uniform scale_x_percent/scale_y_percent stretches each axis independently', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const scaled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_x_percent: 150,
      scale_y_percent: 50,
    });
    expect(scaled.isError, JSON.stringify(scaled.content)).toBeFalsy();
    const bounds = structuredOf(scaled).bounds as Bounds;
    expect(bounds.width).toBe(60);
    expect(bounds.height).toBe(20);
  });

  it('scale refuses over the size cap, image unchanged', async () => {
    // A thin 29000x10 layer (0.29MP, cheap to create) scaled 200% lands at 58000x20 -- over
    // MAX_RESIZE_SIDE_PX (30000) on width -- without ever approaching the 250MP cap.
    const path = join(workDir, 'thin.png');
    writeRgbPng(path, 1, 1, () => RED); // placeholder-sized source; resized on place
    const bg = await callTool(tools, 'gimp_create_document', { width: 100, height: 100 });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: path,
      width: 29000,
      height: 10,
    });
    const layerId = structuredOf(placed).layer_id as number;
    const before = await layerBounds(image, layerId);

    const oversized = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id: layerId,
      scale_percent: 200,
    });
    expect(oversized.isError).toBe(true);
    const after = await layerBounds(image, layerId);
    expect(after).toEqual(before);
  });

  // ---- move -----------------------------------------------------------------------------

  it('move: delta (relative), absolute (top-left), and center_on (center) all land exactly', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const start = await layerBounds(image, layer_id);

    const delta = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id,
      delta: { x: 5, y: -3 },
    });
    expect(structuredOf(delta).bounds).toMatchObject({ x: start.x + 5, y: start.y - 3 });

    const absolute = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id,
      absolute: { x: 100, y: 200 },
    });
    expect(structuredOf(absolute).bounds).toMatchObject({ x: 100, y: 200 });

    const centerOn = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id,
      center_on: { x: 500, y: 500 },
    });
    const bounds = structuredOf(centerOn).bounds as Bounds;
    expect(bounds.x + bounds.width / 2).toBe(500);
    expect(bounds.y + bounds.height / 2).toBe(500);
  });

  it('move refuses when both delta and absolute are given, image unchanged', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const before = await layerBounds(image, layer_id);
    const result = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id,
      delta: { x: 1, y: 1 },
      absolute: { x: 2, y: 2 },
    });
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toContain('only ONE of');
    expect(await layerBounds(image, layer_id)).toEqual(before);
  });

  // ---- rotate / flip ----------------------------------------------------------------------

  it('rotate 90 moves each quadrant to the next corner and swaps width/height', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const rotated = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id,
      degrees: 90,
    });
    expect(rotated.isError, JSON.stringify(rotated.content)).toBeFalsy();
    const bounds = structuredOf(rotated).bounds as Bounds;
    expect([bounds.width, bounds.height]).toEqual([40, 40]); // square source -- size unchanged
    const composite = await exportPng(image, 'rotate90');
    // Clockwise 90: old top-left (red) -> new top-right; old top-right (green) -> new
    // bottom-right; old bottom-right (yellow) -> new bottom-left; old bottom-left (blue) ->
    // new top-left.
    expect(pixelAt(composite, 30, 10)).toEqual(RED);
    expect(pixelAt(composite, 30, 30)).toEqual(GREEN);
    expect(pixelAt(composite, 10, 30)).toEqual(YELLOW);
    expect(pixelAt(composite, 10, 10)).toEqual(BLUE);
  });

  it('flip horizontal/vertical mirror the quadrants, in place (bounds unchanged)', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const before = await layerBounds(image, layer_id);

    const flippedH = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'flip',
      layer_id,
      axis: 'horizontal',
    });
    expect(flippedH.isError, JSON.stringify(flippedH.content)).toBeFalsy();
    expect(structuredOf(flippedH).bounds).toEqual(before);
    const afterH = await exportPng(image, 'flip-h');
    expect(pixelAt(afterH, 10, 10)).toEqual(GREEN); // was red (top-left), now top-right's color
    expect(pixelAt(afterH, 30, 10)).toEqual(RED);

    const flippedV = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'flip',
      layer_id,
      axis: 'vertical',
    });
    expect(structuredOf(flippedV).bounds).toEqual(before);
    const afterV = await exportPng(image, 'flip-v');
    // After both flips (h then v), the ORIGINAL top-left (red) is now bottom-right.
    expect(pixelAt(afterV, 30, 30)).toEqual(RED);
  });

  it('rotate refuses a non-finite degrees value', async () => {
    const { image, layer_id } = await openQuadrants(20, 20);
    const result = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id,
      degrees: Number.POSITIVE_INFINITY,
    });
    expect(result.isError).toBe(true);
  });

  // ---- skew / free ------------------------------------------------------------------------

  it('skew grows the bounding box in the slant direction, bounds reflect it', async () => {
    const { image, layer_id } = await openQuadrants(40, 20);
    const before = await layerBounds(image, layer_id);
    const skewed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'skew',
      layer_id,
      skew_h_degrees: 30,
    });
    expect(skewed.isError, JSON.stringify(skewed.content)).toBeFalsy();
    const bounds = structuredOf(skewed).bounds as Bounds;
    // A horizontal shear widens the bounding box by height*tan(30deg) without changing height.
    expect(bounds.width).toBeGreaterThan(before.width);
    expect(bounds.height).toBe(before.height);
    expect(structuredOf(skewed).skew_h_degrees).toBe(30);
  });

  it('skew requires at least one of skew_h_degrees/skew_v_degrees', async () => {
    const { image, layer_id } = await openQuadrants(20, 20);
    const result = await callTool(tools, 'gimp_transform_layer', { image, op: 'skew', layer_id });
    expect(result.isError).toBe(true);
  });

  it('free combines scale, rotate, and offset in one call', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const before = await layerBounds(image, layer_id);
    const freed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'free',
      layer_id,
      scale_x_percent: 150,
      scale_y_percent: 150,
      degrees: 10,
      offset_x: 20,
      offset_y: -5,
    });
    expect(freed.isError, JSON.stringify(freed.content)).toBeFalsy();
    const result = structuredOf(freed);
    expect(result).toMatchObject({
      scale_x_percent: 150,
      scale_y_percent: 150,
      degrees: 10,
      offset_x: 20,
      offset_y: -5,
    });
    const bounds = result.bounds as Bounds;
    // A combined scale+rotate+offset moves the center by exactly offset_x/offset_y from where
    // a scale+rotate alone (no offset) would have left it -- the center stays fixed under
    // scale/rotate on their own, so the whole displacement is attributable to the offset.
    const oldCenterX = before.x + before.width / 2;
    const oldCenterY = before.y + before.height / 2;
    const newCenterX = bounds.x + bounds.width / 2;
    const newCenterY = bounds.y + bounds.height / 2;
    expect(Math.round(newCenterX - oldCenterX)).toBe(20);
    expect(Math.round(newCenterY - oldCenterY)).toBe(-5);
  });

  // ---- interpolation ------------------------------------------------------------------------

  it('interpolation none vs cubic render a rotated hard edge differently', async () => {
    const path = join(workDir, 'hard-edge.png');
    writeHardEdge(path, 40, 40);

    async function rotatedEdge(interpolation: string): Promise<ReturnType<typeof readPng>> {
      const opened = await callTool(tools, 'gimp_open_document', { file_path: path });
      const image = structuredOf(opened).image as number;
      const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
      const layerId = (structuredOf(tree).layers as Array<{ layer_id: number }>)[0]!.layer_id;
      await callTool(tools, 'gimp_transform_layer', {
        image,
        op: 'rotate',
        layer_id: layerId,
        degrees: 10,
        interpolation,
      });
      const composite = await exportPng(image, `interp-${interpolation}`);
      await callTool(tools, 'gimp_close_document', { image });
      return composite;
    }

    // 'none' (nearest-neighbor) produces a jagged, aliased edge after the rotation; 'cubic'
    // blends across it into intermediate gray values -- the two renders differ somewhere, not
    // necessarily at any ONE hand-picked pixel (several lie exactly on the rotation axis, where
    // both methods agree).
    const none = await rotatedEdge('none');
    const cubic = await rotatedEdge('cubic');
    expect(maxAbsDiff(none, cubic)).toBeGreaterThan(0);
  });

  // ---- a layer's own mask travels with it, at an offset ------------------------------------

  it("a layer's own mask (and its offset position) transform together with the layer on flip", async () => {
    const halvesPath = join(workDir, 'halves.png');
    writeHalves(halvesPath, 40, 30, BLUE, GREEN);
    const bg = await callTool(tools, 'gimp_create_document', {
      width: 80,
      height: 60,
      fill: 'white',
    });
    const image = structuredOf(bg).image as number;
    // Placed at a non-zero OFFSET -- proves the transform operates correctly in absolute
    // document coordinates, not just for a layer that happens to start at (0,0).
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: halvesPath,
      x: 10,
      y: 5,
    });
    const layerId = structuredOf(placed).layer_id as number;
    await backend.call('test_add_layer_mask', { image, layer_id: layerId });

    // Before any transform: mask's left half is BLACK (hidden -> background white shows),
    // right half WHITE (visible -> the layer's own GREEN content shows).
    const before = await exportPng(image, 'mask-before');
    expect(pixelAt(before, 20, 20)).toEqual([255, 255, 255]); // left half, masked out
    expect(pixelAt(before, 35, 20)).toEqual(GREEN); // right half, visible

    const flipped = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'flip',
      layer_id: layerId,
      axis: 'horizontal',
    });
    expect(flipped.isError, JSON.stringify(flipped.content)).toBeFalsy();

    // If the mask traveled WITH the flipped content: content becomes left=GREEN/right=BLUE, and
    // the mask becomes left=WHITE(visible)/right=BLACK(hidden) -- composite reads
    // left=GREEN, right=white (background). If the mask had stayed fixed in place instead,
    // the composite would read left=white, right=BLUE -- the opposite pattern.
    const after = await exportPng(image, 'mask-after');
    expect(pixelAt(after, 20, 20)).toEqual(GREEN);
    expect(pixelAt(after, 35, 20)).toEqual([255, 255, 255]);
  });

  // ---- background layer (no alpha) gets one ------------------------------------------------

  it('a layer with no alpha channel gets one (alpha_added: true); one that already has it does not', async () => {
    const rampPath = join(workDir, 'ramp-for-alpha.png');
    writeGrayRamp(rampPath, 32, 32);
    const opened = await callTool(tools, 'gimp_open_document', { file_path: rampPath });
    const image = structuredOf(opened).image as number;
    const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const layer = (
      structuredOf(tree).layers as Array<{ layer_id: number; name: string; has_alpha: boolean }>
    )[0]!;
    expect(layer.has_alpha).toBe(false); // a freshly opened flat PNG's base layer has no alpha

    const moved = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id: layer.layer_id,
      delta: { x: 1, y: 0 },
    });
    expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();
    expect(structuredOf(moved).alpha_added).toBe(true);

    const treeAfter = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const after = (structuredOf(treeAfter).layers as Array<{ has_alpha: boolean }>)[0]!;
    expect(after.has_alpha).toBe(true);

    // A second transform on the now-alpha-bearing layer reports alpha_added: false.
    const movedAgain = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id: layer.layer_id,
      delta: { x: 1, y: 0 },
    });
    expect(structuredOf(movedAgain).alpha_added).toBe(false);
  });

  // ---- masked-filter refusal ----------------------------------------------------------------

  it('refuses when the layer carries a masked filter (image unchanged); baking clears the refusal', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    await callTool(tools, 'gimp_create_mask', {
      image,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 20,
      height: 40,
      name: 'TransformMask',
    });
    await callTool(tools, 'gimp_add_adjustment', {
      image,
      type: 'brightness_contrast',
      brightness: -40,
      layer_id,
      mask: 'TransformMask',
    });

    const before = await layerBounds(image, layer_id);
    const refused = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_percent: 150,
    });
    expect(refused.isError).toBe(true);
    expect((refused.content?.[0] as { text: string }).text).toContain('masked adjustment');
    expect(await layerBounds(image, layer_id)).toEqual(before);

    const baked = await callTool(tools, 'gimp_bake', { image, layer_id });
    expect(baked.isError, JSON.stringify(baked.content)).toBeFalsy();

    const afterBake = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_percent: 150,
    });
    expect(afterBake.isError, JSON.stringify(afterBake.content)).toBeFalsy();
  });

  // ---- group layer: transforms as a unit ----------------------------------------------------

  it('transforming a GROUP scales every descendant along with it, in lockstep', async () => {
    const bg = await callTool(tools, 'gimp_create_document', {
      width: 100,
      height: 100,
      fill: 'white',
    });
    const image = structuredOf(bg).image as number;
    const group = await callTool(tools, 'gimp_layer', { image, op: 'create_group', name: 'G' });
    const groupId = structuredOf(group).layer_id as number;
    const child = await callTool(tools, 'gimp_layer', {
      image,
      op: 'create',
      name: 'Child',
      width: 20,
      height: 20,
      fill: 'black',
      parent_group: groupId,
    });
    const childId = structuredOf(child).layer_id as number;

    const scaled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id: groupId,
      scale_percent: 200,
    });
    expect(scaled.isError, JSON.stringify(scaled.content)).toBeFalsy();
    const groupBounds = structuredOf(scaled).bounds as Bounds;
    expect(groupBounds).toMatchObject({ width: 40, height: 40 });

    const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const groupNode = (
      structuredOf(tree).layers as Array<{
        layer_id: number;
        children: Array<{ layer_id: number; offsets: { x: number; y: number } }>;
      }>
    ).find((n) => n.layer_id === groupId)!;
    const childNode = groupNode.children.find((c) => c.layer_id === childId)!;
    // The child, originally the group's only content (20x20 at the group's own origin), scales
    // and repositions in lockstep with the group -- its own offsets end up at the group's new
    // top-left too.
    expect(childNode.offsets).toEqual({ x: groupBounds.x, y: groupBounds.y });
  });

  // ---- timing budget (opt-in, heavy) --------------------------------------------------------
  //
  // Gated behind EDITMAMEI_GIMP_PERF=1 like large-image-timing.test.ts's own block -- a ~24MP
  // image is too heavy for every `npm test` run on a machine that happens to have GIMP. Kept
  // out of the parallel pool entirely (the gate, not describe.sequential) so it never contends
  // with the rest of this suite for CPU while it runs.
  const PERF = process.env.EDITMAMEI_GIMP_PERF === '1';

  describe.skipIf(!PERF)('gimp_transform_layer timing budget', () => {
    const WIDTH = 6016;
    const HEIGHT = 4000; // ~24.1 MP

    // Each op measured on its OWN fresh ~24MP layer, not chained -- chaining would compound
    // each op's own growth (scale 2x, then rotate's own ADJUST growth on TOP of that, then
    // free's growth on top of THAT) until the bridge's 250MP cap refuses the last one, which
    // says nothing about any single op's real cost against the ~24MP input size this budget is
    // actually sized for.
    async function timedOnFreshLayer(
      label: string,
      args: Record<string, unknown>
    ): Promise<number> {
      const path = join(workDir, `perf-24mp-${label.replace(/[^a-z0-9]/gi, '')}.png`);
      writeRgbPng(path, WIDTH, HEIGHT, () => RED);
      const opened = await callTool(tools, 'gimp_open_document', { file_path: path });
      const image = structuredOf(opened).image as number;
      const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
      const layerId = (structuredOf(tree).layers as Array<{ layer_id: number }>)[0]!.layer_id;

      const t0 = Date.now();
      const result = await callTool(tools, 'gimp_transform_layer', {
        image,
        layer_id: layerId,
        ...args,
      });
      expect(result.isError, `${label}: ${JSON.stringify(result.content)}`).toBeFalsy();
      const ms = Date.now() - t0;
      // eslint-disable-next-line no-console -- the whole point: numbers visible in the log.
      console.log(`[timing] gimp_transform_layer ${label}: ${ms}ms`);
      await callTool(tools, 'gimp_close_document', { image });
      return ms;
    }

    it('scale 2x, rotate 33°, and free on a ~24MP layer each fit the configured budget (+ margin)', async () => {
      const scaleMs = await timedOnFreshLayer('scale2x', { op: 'scale', scale_percent: 200 });
      const rotateMs = await timedOnFreshLayer('rotate33', { op: 'rotate', degrees: 33 });
      const freeMs = await timedOnFreshLayer('free', {
        op: 'free',
        scale_x_percent: 120,
        scale_y_percent: 80,
        degrees: 15,
        offset_x: 50,
        offset_y: -20,
      });

      const budget = TOOL_TIMEOUT_BUDGETS_MS.gimp_transform_layer ?? DEFAULT_SCRIPT_TIMEOUT_MS;
      const MARGIN = 0.7; // measured must stay under 70% of the budget
      expect(scaleMs, 'scale').toBeLessThan(budget * MARGIN);
      expect(rotateMs, 'rotate').toBeLessThan(budget * MARGIN);
      expect(freeMs, 'free').toBeLessThan(budget * MARGIN);
    }, 120_000);
  });
});
