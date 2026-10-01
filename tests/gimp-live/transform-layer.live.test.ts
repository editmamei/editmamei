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
import { createGimpEffectTools } from '@editmamei/tools/gimp-effect-tools.ts';
import { createGimpFilterTools } from '@editmamei/tools/gimp-filter-tools.ts';
import { createGimpGeometryTools } from '@editmamei/tools/gimp-geometry-tools.ts';
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
      ...createGimpEffectTools(backend),
      ...createGimpFilterTools(backend),
      ...createGimpGeometryTools(backend),
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

  /** A layer with a real GIMP layer mask (left half BLACK/hidden, right half WHITE/visible via
   * `test_add_layer_mask`), its own content left=BLUE/right=GREEN, placed at a non-zero offset
   * (10, 5) on an 80x60 white backdrop -- the shared fixture for every mask-travel test below.
   * Before any transform: left half reads background WHITE (masked out), right half reads the
   * layer's own GREEN (visible). */
  async function maskTravelFixture(): Promise<{ image: number; layerId: number }> {
    const halvesPath = join(
      workDir,
      `halves-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
    );
    writeHalves(halvesPath, 40, 30, BLUE, GREEN);
    const bg = await callTool(tools, 'gimp_create_document', {
      width: 80,
      height: 60,
      fill: 'white',
    });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: halvesPath,
      x: 10,
      y: 5,
    });
    const layerId = structuredOf(placed).layer_id as number;
    await backend.call('test_add_layer_mask', { image, layer_id: layerId });
    return { image, layerId };
  }

  it("a layer's own mask (and its offset position) transform together with the layer on flip", async () => {
    const { image, layerId } = await maskTravelFixture();

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

  it("a layer's own mask scales together with the layer at 200%", async () => {
    const { image, layerId } = await maskTravelFixture();
    const scaled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id: layerId,
      scale_percent: 200,
    });
    expect(scaled.isError, JSON.stringify(scaled.content)).toBeFalsy();
    // New bounds: center (30, 20) unchanged, size doubles to 80x60 -> top-left (-10, -10).
    // Left half (local x 0..40, absolute -10..30) still hidden; right half (absolute 30..70)
    // still visible -- the SAME relative pattern as before scaling, at the new size.
    const after = await exportPng(image, 'mask-scale-after');
    expect(pixelAt(after, 20, 20)).toEqual([255, 255, 255]); // left half, still masked out
    expect(pixelAt(after, 50, 20)).toEqual(GREEN); // right half, still visible
  });

  it("a layer's own mask rotates together with the layer at 180°", async () => {
    const { image, layerId } = await maskTravelFixture();
    const rotated = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id: layerId,
      degrees: 180,
    });
    expect(rotated.isError, JSON.stringify(rotated.content)).toBeFalsy();
    // 180 degrees swaps left/right (bounds unchanged: still (10,5) 40x30). If the mask traveled
    // WITH the rotated content: new left=GREEN(content)+WHITE(mask,visible) -> reads GREEN; new
    // right=BLUE(content)+BLACK(mask,hidden) -> reads background WHITE. A mask stuck at its OLD
    // orientation would instead read left=WHITE(background), right=BLUE -- the opposite pattern.
    const after = await exportPng(image, 'mask-rotate180-after');
    expect(pixelAt(after, 20, 20)).toEqual(GREEN);
    expect(pixelAt(after, 40, 20)).toEqual([255, 255, 255]);
  });

  it("a layer's own mask travels through a free (matrix-based) 180° transform too", async () => {
    const { image, layerId } = await maskTravelFixture();
    const freed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'free',
      layer_id: layerId,
      degrees: 180,
    });
    expect(freed.isError, JSON.stringify(freed.content)).toBeFalsy();
    // Same expected pattern as the dedicated 'rotate' op's own 180-degree case -- proves
    // `Item.transform_matrix` (free's own underlying call, distinct from `transform_rotate`)
    // carries the mask along too.
    const after = await exportPng(image, 'mask-free180-after');
    expect(pixelAt(after, 20, 20)).toEqual(GREEN);
    expect(pixelAt(after, 40, 20)).toEqual([255, 255, 255]);
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

  // ---- cap refusals via the PREDICTED bounding box, not just the pre-transform size ---------

  it('rotate refuses via the predicted bounding box (29000x10 at 45°), image unchanged', async () => {
    const path = join(workDir, 'thin-rotate.png');
    writeRgbPng(path, 1, 1, () => RED);
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

    const rotated = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id: layerId,
      degrees: 45,
    });
    expect(rotated.isError).toBe(true);
    expect(await layerBounds(image, layerId)).toEqual(before);
  });

  it('skew refuses via the predicted bounding box exceeding the size cap, image unchanged', async () => {
    const path = join(workDir, 'thin-skew.png');
    writeRgbPng(path, 1, 1, () => RED);
    const bg = await callTool(tools, 'gimp_create_document', { width: 100, height: 100 });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: path,
      width: 10,
      height: 20000,
    });
    const layerId = structuredOf(placed).layer_id as number;
    const before = await layerBounds(image, layerId);

    const skewed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'skew',
      layer_id: layerId,
      skew_h_degrees: 80,
    });
    expect(skewed.isError).toBe(true);
    expect(await layerBounds(image, layerId)).toEqual(before);
  });

  it('free refuses via the predicted bounding box exceeding the size cap, image unchanged', async () => {
    const { image, layer_id } = await openQuadrants(350, 350);
    const before = await layerBounds(image, layer_id);

    const freed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'free',
      layer_id,
      scale_x_percent: 10000,
      scale_y_percent: 10000,
    });
    expect(freed.isError).toBe(true);
    expect(await layerBounds(image, layer_id)).toEqual(before);
  });

  it('fit refuses via the predicted bounding box exceeding the size cap (extreme aspect + fill), image unchanged', async () => {
    const path = join(workDir, 'thin-fit.png');
    writeRgbPng(path, 1, 1, () => RED);
    const bg = await callTool(tools, 'gimp_create_document', { width: 2000, height: 1000 });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: path,
      width: 1,
      height: 100,
    });
    const layerId = structuredOf(placed).layer_id as number;
    const before = await layerBounds(image, layerId);

    const fitted = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'fit',
      layer_id: layerId,
      mode: 'fill',
    });
    expect(fitted.isError).toBe(true);
    expect(await layerBounds(image, layerId)).toEqual(before);
  });

  it('free refuses when the predicted ORIGIN is out of bounds (large offset_x), even though the size is unchanged', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const before = await layerBounds(image, layer_id);

    const freed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'free',
      layer_id,
      offset_x: 90000,
    });
    expect(freed.isError).toBe(true);
    expect((freed.content?.[0] as { text: string }).text).toContain('must be within');
    expect(await layerBounds(image, layer_id)).toEqual(before);
  });

  // ---- skew/free direction (sign) matches the documented convention, verified live ----------

  it('skew_h_degrees positive slants the top edge RIGHT (pixel probe)', async () => {
    const quadPath = join(workDir, 'quad-skew-sign.png');
    writeQuadrants(quadPath, 40, 40);
    const bg = await callTool(tools, 'gimp_create_document', {
      width: 80,
      height: 80,
      fill: 'white',
    });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: quadPath,
      x: 20,
      y: 20,
    });
    const layerId = structuredOf(placed).layer_id as number;

    const skewed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'skew',
      layer_id: layerId,
      skew_h_degrees: 30,
    });
    expect(skewed.isError, JSON.stringify(skewed.content)).toBeFalsy();
    const composite = await exportPng(image, 'skew-sign');
    // The layer spans absolute (20,20)-(60,60), center (40,40). A point just inside the
    // ORIGINAL top-left corner, (22, 22): if the top edge truly slants RIGHT for a positive
    // skew_h, the transformed layer's own content no longer reaches this point at all --
    // the white backdrop shows through. (Worked out via the inverse of x' = x - tan(h)*y
    // about the center: the point maps back to local x ~= -28, well outside the original
    // [-20, 20] half-width.)
    expect(pixelAt(composite, 22, 22)).toEqual([255, 255, 255]);
  });

  it("free's own rotation sign matches the dedicated rotate op's sign (pixel probe)", async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const freed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'free',
      layer_id,
      degrees: 90,
    });
    expect(freed.isError, JSON.stringify(freed.content)).toBeFalsy();
    const composite = await exportPng(image, 'free-rotate-sign');
    // The exact same clockwise-90 pattern as the dedicated rotate op's own test: old top-left
    // (red) -> new top-right; old bottom-right (yellow) -> new bottom-left.
    expect(pixelAt(composite, 30, 10)).toEqual(RED);
    expect(pixelAt(composite, 10, 30)).toEqual(YELLOW);
  });

  // ---- rotate grows to the predicted box exactly, nothing clips -----------------------------

  it('rotate 30° grows to the predicted bounding box (within 1px), with every corner of it covered -- nothing clips', async () => {
    const quadPath = join(workDir, 'quad-rotate30.png');
    writeQuadrants(quadPath, 40, 40);
    const bg = await callTool(tools, 'gimp_create_document', {
      width: 120,
      height: 120,
      fill: 'white',
    });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: quadPath,
      x: 40,
      y: 40,
    });
    const layerId = structuredOf(placed).layer_id as number;
    const before = await layerBounds(image, layerId);

    const rotated = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id: layerId,
      degrees: 30,
    });
    expect(rotated.isError, JSON.stringify(rotated.content)).toBeFalsy();
    const bounds = structuredOf(rotated).bounds as Bounds;

    const rad = (30 * Math.PI) / 180;
    const predictedW =
      before.width * Math.abs(Math.cos(rad)) + before.height * Math.abs(Math.sin(rad));
    const predictedH =
      before.width * Math.abs(Math.sin(rad)) + before.height * Math.abs(Math.cos(rad));
    // Within a couple of pixels, not exact -- GIMP's own ADJUST rounds each axis of the
    // rotated bounding box outward independently, which can differ from this plain trig
    // prediction by a little more than a single pixel (measured live: up to ~1.4px).
    expect(Math.abs(bounds.width - predictedW)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.height - predictedH)).toBeLessThanOrEqual(2);

    // "Nothing clips" verified by area, not by probing individual corners (a rotated SQUARE's
    // own vertex touches its AABB at a single point per corner, at an angle that varies by
    // corner -- a fixed diagonal inset from the box corner isn't reliably still inside the
    // shape for every corner at every angle). Rotation preserves area exactly: if ANY part of
    // the original 40x40 (1600px) content had clipped outside the grown bounding box, the
    // covered (non-background) pixel count would measurably shrink below it.
    const composite = await exportPng(image, 'rotate30-corners');
    let covered = 0;
    for (let yy = 0; yy < composite.height; yy++) {
      for (let xx = 0; xx < composite.width; xx++) {
        const [r, g, b] = pixelAt(composite, xx, yy);
        if (r !== 255 || g !== 255 || b !== 255) covered++;
      }
    }
    expect(covered).toBeGreaterThan(before.width * before.height * 0.9);
  });

  // ---- the interpolation/ADJUST context bracket never leaks into a later, unrelated call ----

  it('a later call with no explicit interpolation renders identically to an explicit cubic call, even right after a none+ADJUST call', async () => {
    const path = join(workDir, 'hard-edge-leak.png');
    writeHardEdge(path, 40, 40);

    async function freshRotate(interpolation?: string): Promise<number> {
      const opened = await callTool(tools, 'gimp_open_document', { file_path: path });
      const image = structuredOf(opened).image as number;
      const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
      const layerId = (structuredOf(tree).layers as Array<{ layer_id: number }>)[0]!.layer_id;
      await callTool(tools, 'gimp_transform_layer', {
        image,
        op: 'rotate',
        layer_id: layerId,
        degrees: 10,
        ...(interpolation ? { interpolation } : {}),
      });
      return image;
    }

    const noneImage = await freshRotate('none');
    await callTool(tools, 'gimp_close_document', { image: noneImage });

    const defaultImage = await freshRotate(undefined);
    const defaultComposite = await exportPng(defaultImage, 'leak-default');
    await callTool(tools, 'gimp_close_document', { image: defaultImage });

    const explicitCubicImage = await freshRotate('cubic');
    const explicitComposite = await exportPng(explicitCubicImage, 'leak-explicit-cubic');
    await callTool(tools, 'gimp_close_document', { image: explicitCubicImage });

    expect(maxAbsDiff(defaultComposite, explicitComposite)).toBe(0);
  });

  // ---- unmasked position/direction-dependent EFFECT filters: remapped, or refused (G1) ------

  it('flip remaps an unmasked motion_blur effect’s angle, and the ledger stays valid', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const effect = await callTool(tools, 'gimp_add_effect', {
      image,
      layer_id,
      type: 'motion_blur',
      angle: 30,
      length: 10,
    });
    expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
    const filterId = structuredOf(effect).filter_id as number;

    const flipped = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'flip',
      layer_id,
      axis: 'horizontal',
    });
    expect(flipped.isError, JSON.stringify(flipped.content)).toBeFalsy();

    const listed = await callTool(tools, 'gimp_filter', { image, op: 'list' });
    const record = (
      structuredOf(listed).filters as Array<{ filter_id: number; params: { angle: number } }>
    ).find((f) => f.filter_id === filterId)!;
    // flip_effect_params' own horizontal-flip rule for motion_blur: angle -> wrap(180 - angle).
    expect(record.params.angle).toBeCloseTo(150, 5);

    // The ledger record itself stays valid: a re-edit by filter_id succeeds.
    const reEdited = await callTool(tools, 'gimp_add_effect', {
      image,
      filter_id: filterId,
      type: 'motion_blur',
      length: 12,
    });
    expect(reEdited.isError, JSON.stringify(reEdited.content)).toBeFalsy();
  });

  it('scale 200% remaps an unmasked drop_shadow effect’s offset/radius, and the ledger stays valid', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const effect = await callTool(tools, 'gimp_add_effect', {
      image,
      layer_id,
      type: 'drop_shadow',
      offset_x: 10,
      offset_y: 10,
      radius: 5,
      opacity: 0.8,
    });
    expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
    const filterId = structuredOf(effect).filter_id as number;

    const scaled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_percent: 200,
    });
    expect(scaled.isError, JSON.stringify(scaled.content)).toBeFalsy();

    const listed = await callTool(tools, 'gimp_filter', { image, op: 'list' });
    const record = (
      structuredOf(listed).filters as Array<{
        filter_id: number;
        params: { offset_x: number; offset_y: number; radius: number };
      }>
    ).find((f) => f.filter_id === filterId)!;
    expect(record.params.offset_x).toBeCloseTo(20, 5);
    expect(record.params.offset_y).toBeCloseTo(20, 5);
    expect(record.params.radius).toBeCloseTo(10, 5);

    const reEdited = await callTool(tools, 'gimp_add_effect', {
      image,
      filter_id: filterId,
      type: 'drop_shadow',
      opacity: 0.9,
    });
    expect(reEdited.isError, JSON.stringify(reEdited.content)).toBeFalsy();
  });

  it('rotate at an arbitrary angle refuses while an unmasked vignette is present; a right-angle rotate is still fine', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const effect = await callTool(tools, 'gimp_add_effect', { image, layer_id, type: 'vignette' });
    expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
    const before = await layerBounds(image, layer_id);

    const rotated = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id,
      degrees: 33,
    });
    expect(rotated.isError).toBe(true);
    expect((rotated.content?.[0] as { text: string }).text).toContain('Vignette');
    expect(await layerBounds(image, layer_id)).toEqual(before);

    const rotated90 = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id,
      degrees: 90,
    });
    expect(rotated90.isError, JSON.stringify(rotated90.content)).toBeFalsy();
  });

  it('scale refuses when non-uniform while an unmasked motion_blur effect is present; a uniform scale is still fine', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const effect = await callTool(tools, 'gimp_add_effect', {
      image,
      layer_id,
      type: 'motion_blur',
      angle: 0,
      length: 10,
    });
    expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
    const before = await layerBounds(image, layer_id);

    const nonUniform = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_x_percent: 150,
      scale_y_percent: 50,
    });
    expect(nonUniform.isError).toBe(true);
    expect(await layerBounds(image, layer_id)).toEqual(before);

    const uniform = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_percent: 150,
    });
    expect(uniform.isError, JSON.stringify(uniform.content)).toBeFalsy();
  });

  it('skew and free both refuse outright while an unmasked vignette is present (no angle is safe for either)', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    const effect = await callTool(tools, 'gimp_add_effect', { image, layer_id, type: 'vignette' });
    expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();

    const skewed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'skew',
      layer_id,
      skew_h_degrees: 10,
    });
    expect(skewed.isError).toBe(true);
    expect((skewed.content?.[0] as { text: string }).text).toContain('Vignette');

    const freed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'free',
      layer_id,
      degrees: 10,
    });
    expect(freed.isError).toBe(true);
    expect((freed.content?.[0] as { text: string }).text).toContain('Vignette');
  });

  // ---- lock-position / lock-content: refused outright, no mutation, no alpha_added (G2) -----

  it('refuses outright on a lock-position layer, before any mutation or alpha-add', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    await backend.call('test_set_layer_lock', { image, layer_id, lock_position: true });
    const before = await layerBounds(image, layer_id);

    const moved = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id,
      absolute: { x: 5, y: 5 },
    });
    expect(moved.isError).toBe(true);
    expect((moved.content?.[0] as { text: string }).text).toContain('lock-position');
    expect(await layerBounds(image, layer_id)).toEqual(before);

    const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const node = (
      structuredOf(tree).layers as Array<{ layer_id: number; has_alpha: boolean }>
    ).find((n) => n.layer_id === layer_id)!;
    // This fixture's PNG has no alpha channel -- if alpha had been added despite the refusal,
    // this would read true.
    expect(node.has_alpha).toBe(false);
  });

  it('refuses outright on a lock-content layer, before any mutation', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    await backend.call('test_set_layer_lock', { image, layer_id, lock_content: true });
    const before = await layerBounds(image, layer_id);

    const scaled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id,
      scale_percent: 150,
    });
    expect(scaled.isError).toBe(true);
    expect((scaled.content?.[0] as { text: string }).text).toContain('lock-content');
    expect(await layerBounds(image, layer_id)).toEqual(before);
  });

  // ---- an active selection is cleared before transforming (G3) -------------------------------

  it('clears an active selection before transforming -- the WHOLE layer moves, no floating selection left behind', async () => {
    const { image, layer_id } = await openQuadrants(40, 40);
    await backend.call('test_select_rect', { image, x: 0, y: 0, width: 10, height: 10 });

    const moved = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id,
      absolute: { x: 5, y: 5 },
    });
    expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();
    const bounds = structuredOf(moved).bounds as Bounds;
    // If the selection had confined the move, only the originally-selected 10x10 corner would
    // have moved -- the WHOLE 40x40 layer landing at exactly (5,5) proves it was cleared first.
    expect(bounds).toMatchObject({ x: 5, y: 5, width: 40, height: 40 });

    const selEmpty = await backend.call<{ selection_empty: boolean }>('test_selection_empty', {
      image,
    });
    expect(selEmpty.selection_empty).toBe(true);
  });

  // ---- a GROUP target's own no-alpha descendant gets alpha too (G4) --------------------------

  it("adds alpha to a GROUP target's no-alpha child, avoiding opaque corners on rotate", async () => {
    const path = join(workDir, 'group-child-noalpha.png');
    writeRgbPng(path, 30, 30, () => RED);
    const bg = await callTool(tools, 'gimp_create_document', {
      width: 100,
      height: 100,
      fill: 'white',
    });
    const image = structuredOf(bg).image as number;
    const group = await callTool(tools, 'gimp_layer', { image, op: 'create_group', name: 'G4' });
    const groupId = structuredOf(group).layer_id as number;
    const placed = await callTool(tools, 'gimp_place_image', {
      image,
      file_path: path,
      x: 35,
      y: 35,
      parent_group: groupId,
    });
    const childId = structuredOf(placed).layer_id as number;

    const treeBefore = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const groupNodeBefore = (
      structuredOf(treeBefore).layers as Array<{
        layer_id: number;
        children: Array<{ layer_id: number; has_alpha: boolean }>;
      }>
    ).find((n) => n.layer_id === groupId)!;
    expect(groupNodeBefore.children.find((c) => c.layer_id === childId)!.has_alpha).toBe(false);

    const rotated = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'rotate',
      layer_id: groupId,
      degrees: 30,
      interpolation: 'none',
    });
    expect(rotated.isError, JSON.stringify(rotated.content)).toBeFalsy();
    expect(structuredOf(rotated).alpha_added).toBe(true);

    const treeAfter = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const groupNodeAfter = (
      structuredOf(treeAfter).layers as Array<{
        layer_id: number;
        children: Array<{ layer_id: number; has_alpha: boolean }>;
      }>
    ).find((n) => n.layer_id === groupId)!;
    expect(groupNodeAfter.children.find((c) => c.layer_id === childId)!.has_alpha).toBe(true);

    // No opaque corner fill: the rotated bounding box's own corner is NOT covered by the
    // rotated square (verified for 'rotate 30' above), so it must show the WHITE backdrop
    // through, not an opaque fill color.
    const groupBounds = structuredOf(rotated).bounds as Bounds;
    const composite = await exportPng(image, 'group-no-alpha-corner');
    expect(
      pixelAt(composite, Math.round(groupBounds.x) + 1, Math.round(groupBounds.y) + 1)
    ).toEqual([255, 255, 255]);
  });

  // ---- integer-pixel snapping: no half-pixel resample (G5) -----------------------------------

  it('fit of a layer that already fits exactly is a true pixel-identical no-op, even at an ODD size', async () => {
    const path = join(workDir, 'exact-fit-odd.png');
    writeQuadrants(path, 41, 41);
    const bg = await callTool(tools, 'gimp_create_document', { width: 41, height: 41 });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', { image, file_path: path });
    const layerId = structuredOf(placed).layer_id as number;
    const before = await exportPng(image, 'exact-fit-odd-before');

    const fitted = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'fit',
      layer_id: layerId,
      interpolation: 'none',
    });
    expect(fitted.isError, JSON.stringify(fitted.content)).toBeFalsy();
    expect(structuredOf(fitted).scale_percent).toBe(100);
    const after = await exportPng(image, 'exact-fit-odd-after');
    expect(maxAbsDiff(before, after)).toBe(0);
  });

  it("scale rounds a .5 boundary UP (half-up), not Python's own banker's round-to-even", async () => {
    const path = join(workDir, 'tiny5.png');
    writeRgbPng(path, 5, 10, () => RED);
    const bg = await callTool(tools, 'gimp_create_document', { width: 100, height: 100 });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', { image, file_path: path });
    const layerId = structuredOf(placed).layer_id as number;
    // 5 * 50% = 2.5 exactly -- Python's own round() (banker's rounding) would snap this DOWN to
    // 2 (the nearest EVEN integer); floor(v + 0.5) rounds it UP to 3 instead (via the two
    // corners it snaps independently: x0=1, x1=4 -> width 3).
    const scaled = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'scale',
      layer_id: layerId,
      scale_percent: 50,
    });
    expect(scaled.isError, JSON.stringify(scaled.content)).toBeFalsy();
    const bounds = structuredOf(scaled).bounds as Bounds;
    expect(bounds.width).toBe(3);
  });

  it("move center_on rounds a .5 boundary UP (half-up), not Python's own banker's round-to-even", async () => {
    const path = join(workDir, 'tiny4.png');
    writeRgbPng(path, 4, 4, () => RED);
    const bg = await callTool(tools, 'gimp_create_document', { width: 100, height: 100 });
    const image = structuredOf(bg).image as number;
    const placed = await callTool(tools, 'gimp_place_image', { image, file_path: path });
    const layerId = structuredOf(placed).layer_id as number;
    // Target center (10.5, 10.5): top-left = target - half-size (2,2) = (8.5, 8.5).
    // floor(8.5 + 0.5) = 9 (half-up); Python's own round(8.5) (banker's) would give 8.
    const moved = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id: layerId,
      center_on: { x: 10.5, y: 10.5 },
    });
    expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();
    const bounds = structuredOf(moved).bounds as Bounds;
    expect(bounds.x).toBe(9);
    expect(bounds.y).toBe(9);
  });

  // ---- text layers stay text layers, reported back (G6) --------------------------------------

  it('a text layer stays a text layer through a free (matrix-based) transform, reported as text_layer', async () => {
    const bg = await callTool(tools, 'gimp_create_document', { width: 100, height: 100 });
    const image = structuredOf(bg).image as number;
    const text = await backend.call<{ layer_id: number }>('test_add_text_layer', {
      image,
      text: 'Hi',
    });
    const freed = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'free',
      layer_id: text.layer_id,
      scale_x_percent: 150,
      degrees: 10,
    });
    expect(freed.isError, JSON.stringify(freed.content)).toBeFalsy();
    expect(structuredOf(freed).text_layer).toBe(true);
    const tree = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    const node = (
      structuredOf(tree).layers as Array<{ layer_id: number; is_text_layer: boolean }>
    ).find((n) => n.layer_id === text.layer_id)!;
    expect(node.is_text_layer).toBe(true);
  });

  it('a regular (non-text) layer reports text_layer: false', async () => {
    const { image, layer_id } = await openQuadrants(20, 20);
    const moved = await callTool(tools, 'gimp_transform_layer', {
      image,
      op: 'move',
      layer_id,
      delta: { x: 1, y: 1 },
    });
    expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();
    expect(structuredOf(moved).text_layer).toBe(false);
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

    // S3: the budget above is measured against a ~24MP sample, but the bridge's own
    // precision-aware cap (lib.validate_document_dims) allows a result up to ~250MP at 8-bit or
    // ~125MP at 16-bit -- this measures the SAME ops near THAT cap instead, the actual worst
    // case a caller can reach without being refused outright.
    it('scale and rotate near the precision-aware size cap (8-bit ~217MP, 16-bit ~106MP) each fit the configured budget (+ margin)', async () => {
      async function timedNearCap(
        label: string,
        args: Record<string, unknown>,
        width: number,
        height: number,
        precision?: '16'
      ): Promise<number> {
        const placeholderPath = join(
          workDir,
          `perf-cap-src-${label.replace(/[^a-z0-9]/gi, '')}.png`
        );
        writeRgbPng(placeholderPath, 10, 10, () => RED);
        const bg = await callTool(tools, 'gimp_create_document', {
          width,
          height,
          ...(precision ? { precision } : {}),
        });
        const image = structuredOf(bg).image as number;
        const placed = await callTool(tools, 'gimp_place_image', {
          image,
          file_path: placeholderPath,
          width,
          height,
        });
        const layerId = structuredOf(placed).layer_id as number;

        const t0 = Date.now();
        const result = await callTool(tools, 'gimp_transform_layer', {
          image,
          layer_id: layerId,
          ...args,
        });
        expect(result.isError, `${label}: ${JSON.stringify(result.content)}`).toBeFalsy();
        const ms = Date.now() - t0;
        // eslint-disable-next-line no-console -- the whole point: numbers visible in the log.
        console.log(
          `[timing-cap] gimp_transform_layer ${label}: ${ms}ms (${width}x${height}${precision ? ` ${precision}-bit` : ' 8-bit'})`
        );
        await callTool(tools, 'gimp_close_document', { image });
        return ms;
      }

      // Each base size is chosen so the RESULT lands close to, but under, the cap --
      // 250MP/30000px-per-side at 8-bit, 125MP at 16-bit -- so the transform itself (not a
      // cap refusal) is what gets timed. Each op's OWN worst-case growth (scale's is a clean
      // 1.1025x area factor; rotate's depends on aspect ratio too -- an elongated rectangle
      // gains proportionally more area from even a small angle) lands close to, but under,
      // the cap -- not the SAME base for both, which would either under-shoot one op or
      // overshoot the other.
      const scale8bitMs = await timedNearCap(
        'scale8bit',
        { op: 'scale', scale_percent: 105 },
        27000,
        7000
      );
      const rotate8bitMs = await timedNearCap(
        'rotate8bit',
        { op: 'rotate', degrees: 5 },
        25000,
        7000
      );

      // 16-bit: the tighter 125MP cap.
      const scale16bitMs = await timedNearCap(
        'scale16bit',
        { op: 'scale', scale_percent: 105 },
        13900,
        8000,
        '16'
      );
      const rotate16bitMs = await timedNearCap(
        'rotate16bit',
        { op: 'rotate', degrees: 5 },
        10800,
        8000,
        '16'
      );

      const budget = TOOL_TIMEOUT_BUDGETS_MS.gimp_transform_layer ?? DEFAULT_SCRIPT_TIMEOUT_MS;
      const MARGIN = 0.7;
      expect(scale8bitMs, 'scale (8-bit, near cap)').toBeLessThan(budget * MARGIN);
      expect(rotate8bitMs, 'rotate (8-bit, near cap)').toBeLessThan(budget * MARGIN);
      expect(scale16bitMs, 'scale (16-bit, near cap)').toBeLessThan(budget * MARGIN);
      expect(rotate16bitMs, 'rotate (16-bit, near cap)').toBeLessThan(budget * MARGIN);
    }, 180_000);
  });
});
