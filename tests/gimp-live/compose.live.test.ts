/**
 * gimp_create_document / gimp_place_image / gimp_canvas / gimp_convert_image_mode against real
 * headless GIMP, driven through the actual tool handlers and a real `GimpBackend`/`GimpSession` —
 * the same "drive the TOOLS, not the bridge" posture `layers.live.test.ts` and
 * `checkpoint.live.test.ts` take.
 *
 * Verified-live assumptions this file pins as regression tests (see `bridge/ops.py`'s own
 * "document composition" section comment for the full probe record):
 *  - `Image.resize(w, h, offx, offy)` repositions every existing layer by (offx, offy) without
 *    touching that layer's own pixels or size, so `gimp_canvas` refuses on a masked filter for the
 *    same reason gimp_resize_image/gimp_transform_canvas do, while an unmasked effect filter
 *    (keyed off the layer's own unchanged extent) is unaffected.
 *  - `Gimp.file_load_layer` converts a loaded file to the target image's own base type before
 *    insertion in both directions (grayscale<->rgb), and does not attach the source's own
 *    metadata to the target image.
 *  - `gimp_convert_image_mode` refuses an indexed source and refuses outright while any live
 *    filter is present, and is a reported no-op when the image is already the requested mode.
 *  - Every structural op here drops the preview-proxy cache, the same invariant
 *    `layers.live.test.ts`'s own proxy matrix pins for gimp_layer/gimp_bake.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
import { createGimpVerifyTools } from '@editmamei/tools/gimp-verify-tools.ts';
import { createGimpLayerTools } from '@editmamei/tools/gimp-layer-tools.ts';
import { createGimpCheckpointTools } from '@editmamei/tools/gimp-checkpoint-tools.ts';
import { createGimpComposeTools } from '@editmamei/tools/gimp-compose-tools.ts';
import type { ToolDefinition, ToolResult } from '@editmamei/core/tool-registry.ts';
import { callTool } from '../fixtures/tool-helpers.ts';
import {
  writeGrayRamp,
  writeColorSwatches,
  writeIndexedPng,
  writeGpsXmpJpeg,
  findJpegApp1Segments,
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

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (compose)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

interface LayerNode {
  layer_id: number;
  name: string;
  offsets: { x: number | null; y: number | null };
  is_group: boolean;
  visible: boolean;
  children: LayerNode[];
}

function structuredOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

const CANVAS_ANCHORS = [
  'top_left',
  'top_center',
  'top_right',
  'middle_left',
  'center',
  'middle_right',
  'bottom_left',
  'bottom_center',
  'bottom_right',
] as const;

/** Mirrors lib.py's `canvas_anchor_offset` -- the pure-arithmetic contract test_lib.py pins on the
 * Python side, re-derived here so this file can assert the BRIDGE actually applies it, not just
 * that the two implementations happen to agree by construction. */
function expectedAnchorOffset(
  anchor: (typeof CANVAS_ANCHORS)[number],
  oldW: number,
  oldH: number,
  newW: number,
  newH: number
): [number, number] {
  const fractions: Record<(typeof CANVAS_ANCHORS)[number], [number, number]> = {
    top_left: [0, 0],
    top_center: [0.5, 0],
    top_right: [1, 0],
    middle_left: [0, 0.5],
    center: [0.5, 0.5],
    middle_right: [1, 0.5],
    bottom_left: [0, 1],
    bottom_center: [0.5, 1],
    bottom_right: [1, 1],
  };
  // Floor, not round -- see lib.py's own `canvas_anchor_offset` comment (Python's round() is
  // round-half-to-EVEN, which floor sidesteps entirely).
  const [fx, fy] = fractions[anchor];
  return [Math.floor((newW - oldW) * fx), Math.floor((newH - oldH) * fy)];
}

describe.skipIf(!install)(
  'gimp_create_document / gimp_place_image / gimp_canvas / gimp_convert_image_mode against real headless GIMP',
  () => {
    let workDir: string;
    let backend: GimpBackend;
    let tools: ToolDefinition[];
    let rampPath: string;
    let swatchesPath: string;

    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'em-gimp-compose-'));
      // opsPyPath: TEST_OPS_PY -- adds test_metadata_tag and test_add_foreign_filter (the
      // unverifiable-filter case below), mirroring layers.live.test.ts's own reason for the same
      // option.
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
        ...createGimpVerifyTools(backend),
        ...createGimpLayerTools(backend),
        ...createGimpCheckpointTools(backend),
        ...createGimpComposeTools(backend),
      ];
      await readyGimpRegistry((name, args) => callTool(tools, name, args));
      rampPath = join(workDir, 'ramp.png');
      swatchesPath = join(workDir, 'swatches.png');
      writeGrayRamp(rampPath, 32, 32);
      writeColorSwatches(swatchesPath);
    }, LIVE_READY_TIMEOUT_MS);

    afterAll(async () => {
      await backend.shutdown();
      rmSync(workDir, { recursive: true, force: true });
    });

    async function layerTree(image: number): Promise<LayerNode[]> {
      const result = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      return structuredOf(result).layers as LayerNode[];
    }

    async function exportPng(image: number, tag: string): Promise<string> {
      const path = join(workDir, `${tag}-${image}-${Date.now()}.png`);
      const result = await callTool(tools, 'gimp_export', { image, file_path: path });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      return path;
    }

    // ---- gimp_create_document ---------------------------------------------------------------

    describe('gimp_create_document', () => {
      it('defaults to an 8-bit RGB image with a white background layer, and returns the open-document shape', async () => {
        const created = await callTool(tools, 'gimp_create_document', { width: 12, height: 8 });
        expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
        const r = structuredOf(created) as {
          image: number;
          width: number;
          height: number;
          base_type: string;
          precision: string;
          layers: string[];
        };
        expect(r.width).toBe(12);
        expect(r.height).toBe(8);
        expect(r.base_type).toBe('rgb');
        expect(r.precision).toBe('u8-non-linear');
        expect(r.layers).toEqual(['Background']);
        const png = await exportPng(r.image, 'create-default');
        const [red, green, blue] = pixelAt(readPng(png), 6, 4);
        expect([red, green, blue]).toEqual([255, 255, 255]);
        await callTool(tools, 'gimp_close_document', { image: r.image });
      });

      it('fill=black paints the background layer black', async () => {
        const created = await callTool(tools, 'gimp_create_document', {
          width: 10,
          height: 10,
          fill: 'black',
        });
        const r = structuredOf(created) as { image: number };
        const png = await exportPng(r.image, 'create-black');
        expect(pixelAt(readPng(png), 5, 5)).toEqual([0, 0, 0]);
        await callTool(tools, 'gimp_close_document', { image: r.image });
      });

      it('mode=grayscale creates a grayscale image', async () => {
        const created = await callTool(tools, 'gimp_create_document', {
          width: 10,
          height: 10,
          mode: 'grayscale',
        });
        const r = structuredOf(created) as { image: number; base_type: string };
        expect(r.base_type).toBe('gray');
        await callTool(tools, 'gimp_close_document', { image: r.image });
      });

      it('precision=16 promotes bit depth', async () => {
        const created = await callTool(tools, 'gimp_create_document', {
          width: 10,
          height: 10,
          precision: '16',
        });
        const r = structuredOf(created) as { image: number; precision: string };
        expect(r.precision).toBe('u16-non-linear');
        await callTool(tools, 'gimp_close_document', { image: r.image });
      });

      it('name sets the background layer name', async () => {
        const created = await callTool(tools, 'gimp_create_document', {
          width: 4,
          height: 4,
          name: 'Base',
        });
        const r = structuredOf(created) as { image: number; layers: string[] };
        expect(r.layers).toEqual(['Base']);
        await callTool(tools, 'gimp_close_document', { image: r.image });
      });

      it('rejects a non-positive dimension before ever touching GIMP', async () => {
        const result = await callTool(tools, 'gimp_create_document', { width: 0, height: 10 });
        expect(result.isError).toBe(true);
      });

      it("the megapixel cap is precision-aware -- refused over each precision's own (lower) cap", async () => {
        // Both refusals only -- the validator runs BEFORE Gimp.Image.new() is ever called, so
        // neither case actually allocates a huge buffer (kept fast and light on purpose).
        const over16 = Math.ceil(Math.sqrt(125_000_000)) + 200; // just over the 16-bit cap (125 MP)
        const overCap16 = await callTool(tools, 'gimp_create_document', {
          width: over16,
          height: over16,
          precision: '16',
        });
        expect(overCap16.isError).toBe(true);
        expect((overCap16.content?.[0] as { text: string }).text).toMatch(/16-bit document/);

        const over32 = Math.ceil(Math.sqrt(60_000_000)) + 200; // just over the 32-bit cap (60 MP)
        const overCap32 = await callTool(tools, 'gimp_create_document', {
          width: over32,
          height: over32,
          precision: '32',
        });
        expect(overCap32.isError).toBe(true);
        expect((overCap32.content?.[0] as { text: string }).text).toMatch(/32-bit document/);
        // The two refusals cite DIFFERENT megapixel figures (125 vs 60) for dimensions chosen
        // specifically to clear one cap and not the other -- proof enough that the ceiling is
        // precision-specific, without also needing a real, memory-heavy successful creation here
        // (the ordinary "precision=16 promotes bit depth" test above already proves a normal-sized
        // 16-bit create_document call succeeds).
      });
    });

    // ---- gimp_place_image ---------------------------------------------------------------------

    describe('gimp_place_image', () => {
      it('places at an explicit x/y offset and reports it back', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            x: 5,
            y: 7,
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
          const r = structuredOf(placed) as { layer_id: number; x: number; y: number };
          expect([r.x, r.y]).toEqual([5, 7]);
          const tree = await layerTree(image);
          const node = tree.find((n) => n.layer_id === r.layer_id)!;
          expect([node.offsets.x, node.offsets.y]).toEqual([5, 7]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('defaults x/y to (0, 0) when omitted', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', { image, file_path: rampPath });
          const r = structuredOf(placed) as { x: number; y: number };
          expect([r.x, r.y]).toEqual([0, 0]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('scales the placed layer: both dims stretch exactly, one alone keeps aspect', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 100, height: 100 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const both = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath, // 32x32, square
            width: 20,
            height: 10,
          });
          expect(structuredOf(both)).toMatchObject({ width: 20, height: 10 });

          const oneOnly = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            width: 16, // half of 32 -- height should derive to 16 too (square source)
          });
          expect(structuredOf(oneOnly)).toMatchObject({ width: 16, height: 16 });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('places into a group via parent_group', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const group = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create_group',
            name: 'Placed',
          });
          const groupId = structuredOf(group).layer_id as number;
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            parent_group: groupId,
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
          const placedId = structuredOf(placed).layer_id as number;
          const tree = await layerTree(image);
          const groupNode = tree.find((n) => n.layer_id === groupId)!;
          expect(groupNode.children.map((c) => c.layer_id)).toContain(placedId);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('enforces a unique name, suffixing on collision', async () => {
        const opened = await callTool(tools, 'gimp_create_document', {
          width: 40,
          height: 40,
          name: 'ramp',
        });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            name: 'ramp',
          });
          expect(structuredOf(placed).name).toBe('ramp 2');
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('an 8-bit source placed into a 16-bit-precision target does not corrupt its pixels', async () => {
        const opened = await callTool(tools, 'gimp_create_document', {
          width: 32,
          height: 32,
          precision: '16',
          fill: 'transparent',
        });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', { image, file_path: rampPath });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
          const png = await exportPng(image, 'sixteen-bit-place');
          const decoded = readPng(png);
          // writeGrayRamp's own formula: v = round(x / (width-1) * 255) -- checked at a few columns.
          for (const x of [0, 15, 31]) {
            const expectedV = Math.round((x / 31) * 255);
            const [r, g, b] = pixelAt(decoded, x, 16);
            expect([r, g, b], `x=${x}`).toEqual([expectedV, expectedV, expectedV]);
          }
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a grayscale source placed into an RGB target converts automatically (not refused)', async () => {
        const grayDoc = await callTool(tools, 'gimp_create_document', {
          width: 6,
          height: 6,
          mode: 'grayscale',
          fill: 'white',
        });
        const grayImage = (structuredOf(grayDoc) as { image: number }).image;
        const grayPath = join(workDir, 'gray-source.png');
        await callTool(tools, 'gimp_export', { image: grayImage, file_path: grayPath });
        await callTool(tools, 'gimp_close_document', { image: grayImage });

        const rgbTarget = await callTool(tools, 'gimp_create_document', { width: 20, height: 20 });
        const rgbImage = (structuredOf(rgbTarget) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', {
            image: rgbImage,
            file_path: grayPath,
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
          const png = await exportPng(rgbImage, 'gray-into-rgb');
          expect(pixelAt(readPng(png), 3, 3)).toEqual([255, 255, 255]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image: rgbImage });
        }
      });

      it('an RGB source placed into a grayscale target converts automatically (not refused)', async () => {
        const grayTarget = await callTool(tools, 'gimp_create_document', {
          width: 20,
          height: 20,
          mode: 'grayscale',
        });
        const grayImage = (structuredOf(grayTarget) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', {
            image: grayImage,
            file_path: swatchesPath,
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
        } finally {
          await callTool(tools, 'gimp_close_document', { image: grayImage });
        }
      });

      // ---- refusals leave the document UNCHANGED (dims, layer tree, and the selected layer --
      // gimp_bake with no layer/layer_id given reports whichever layer is CURRENTLY selected,
      // without mutating anything, as long as that layer has no filters to bake; used here purely
      // as a read of the current selection) ---------------------------------------------------

      async function selectedLayerId(image: number): Promise<number> {
        const baked = await callTool(tools, 'gimp_bake', { image });
        expect(baked.isError, JSON.stringify(baked.content)).toBeFalsy();
        expect(structuredOf(baked).baked).toBe(false); // proves this read didn't change anything
        return structuredOf(baked).layer_id as number;
      }

      it('a refusal after insert restores the PREVIOUSLY SELECTED layer, not the half-placed one', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const other = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'Other' });
          const otherId = structuredOf(other).layer_id as number;
          await callTool(tools, 'gimp_layer', { image, op: 'select', layer_id: otherId });
          expect(await selectedLayerId(image)).toBe(otherId);

          const before = await layerTree(image);
          // An out-of-range x refuses AFTER the layer is already loaded and named -- exactly the
          // failure window that must restore the previous selection, not leave the half-placed
          // layer selected.
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            x: 999_999,
          });
          expect(placed.isError).toBe(true);

          expect(await selectedLayerId(image)).toBe(otherId);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses an out-of-range x/y, leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            x: 999_999,
            y: 0,
          });
          expect(placed.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses a width over the resize-dims cap, leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            width: 30_001,
          });
          expect(placed.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses when a derived (aspect-kept) dimension overflows the cap, leaving the document unchanged', async () => {
        // rampPath is 32x32 (square); asking for height=1 alone derives width the same way, so a
        // huge WIDTH given alone derives an equally huge height and must be caught by the SAME
        // validate_resize_dims call as the explicit-width case above.
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            width: 30_001, // height derives to the same value (square source) -- still over the cap
          });
          expect(placed.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses a non-existent or non-group parent_group, leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const badId = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            parent_group: 999_999,
          });
          expect(badId.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);

          const plainLayer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'NotAGroup',
          });
          const plainLayerId = structuredOf(plainLayer).layer_id as number;
          const beforeSecond = await layerTree(image);
          const nonGroup = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            parent_group: plainLayerId,
          });
          expect(nonGroup.isError).toBe(true);
          expect(await layerTree(image)).toEqual(beforeSecond);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a garbage-bytes .png is refused WITHOUT echoing its full path or the session work dir', async () => {
        const garbage = join(workDir, 'garbage.png');
        writeFileSync(garbage, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', { image, file_path: garbage });
          expect(placed.isError).toBe(true);
          const text = (placed.content?.[0] as { text: string }).text;
          expect(text).not.toContain(garbage);
          expect(text).not.toContain(workDir);
          expect(text).not.toMatch(/[/\\]/); // no path separator of any kind survives
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      // ---- a filtered source layer is baked BEFORE it is placed -------------------------------

      it('a filtered .xcf source is baked before placing, reported as baked_filters, with no live filter left', async () => {
        const sourceDoc = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const sourceImage = (structuredOf(sourceDoc) as { image: number }).image;
        await callTool(tools, 'gimp_add_adjustment', {
          image: sourceImage,
          type: 'brightness_contrast',
          brightness: 50,
          name: 'Grade',
        });
        const sourceXcf = join(workDir, 'filtered-source.xcf');
        await callTool(tools, 'gimp_save_xcf', { image: sourceImage, file_path: sourceXcf });
        await callTool(tools, 'gimp_close_document', { image: sourceImage });

        const targetDoc = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const targetImage = (structuredOf(targetDoc) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', {
            image: targetImage,
            file_path: sourceXcf,
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
          const r = structuredOf(placed) as { layer_id: number; baked_filters?: string[] };
          expect(r.baked_filters).toEqual(['Grade']);

          const filters = await callTool(tools, 'gimp_filter', { op: 'list', image: targetImage });
          const onPlacedLayer = (
            filters.structuredContent as { filters: Array<{ layer_id: number }> }
          ).filters.filter((f) => f.layer_id === r.layer_id);
          expect(onPlacedLayer).toHaveLength(0); // no live filter left on the placed layer
        } finally {
          await callTool(tools, 'gimp_close_document', { image: targetImage });
        }
      });

      it("a same-named filter already on the target is untouched by baking the placed layer's own", async () => {
        const sourceDoc = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const sourceImage = (structuredOf(sourceDoc) as { image: number }).image;
        await callTool(tools, 'gimp_add_adjustment', {
          image: sourceImage,
          type: 'brightness_contrast',
          brightness: 50,
          name: 'Grade',
        });
        const sourceXcf = join(workDir, 'filtered-source-collision.xcf');
        await callTool(tools, 'gimp_save_xcf', { image: sourceImage, file_path: sourceXcf });
        await callTool(tools, 'gimp_close_document', { image: sourceImage });

        const targetDoc = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const targetImage = (structuredOf(targetDoc) as { image: number }).image;
        try {
          const targetAdjust = await callTool(tools, 'gimp_add_adjustment', {
            image: targetImage,
            type: 'brightness_contrast',
            brightness: -30,
            name: 'Grade', // SAME name as the source layer's own filter
          });
          const targetFilterId = structuredOf(targetAdjust).filter_id as number;

          const placed = await callTool(tools, 'gimp_place_image', {
            image: targetImage,
            file_path: sourceXcf,
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();

          const listed = await callTool(tools, 'gimp_filter', {
            op: 'list',
            image: targetImage,
          });
          const targetFilterStillThere = (
            listed.structuredContent as {
              filters: Array<{ filter_id: number; name: string; params: { brightness: number } }>;
            }
          ).filters.find((f) => f.filter_id === targetFilterId);
          expect(targetFilterStillThere).toBeDefined();
          expect(targetFilterStillThere!.params.brightness).toBe(-30); // untouched by the bake
        } finally {
          await callTool(tools, 'gimp_close_document', { image: targetImage });
        }
      });

      it('a raw-extension file with no loader is refused as gimp_unsupported_file, not a generic failure', async () => {
        const fakeRaw = join(workDir, 'not-really-raw.dng');
        writeFileSync(fakeRaw, Buffer.from([0, 1, 2, 3, 4]));
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', { image, file_path: fakeRaw });
          expect(placed.isError).toBe(true);
          expect((placed.content?.[0] as { text: string }).text).toMatch(/gimp_unsupported_file/);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a missing file is refused WITHOUT echoing its full path (just the basename, if anything)', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        const missing = join(workDir, 'does-not-exist.jpg');
        try {
          const placed = await callTool(tools, 'gimp_place_image', { image, file_path: missing });
          expect(placed.isError).toBe(true);
          const text = (placed.content?.[0] as { text: string }).text;
          expect(text).not.toContain(missing);
          expect(text).not.toContain(workDir);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it("placing a file with real GPS/XMP metadata attaches NOTHING to the target image's own metadata", async () => {
        const gpsJpegPath = join(workDir, 'gps-source.jpg');
        writeGpsXmpJpeg(gpsJpegPath);
        // Sanity: the FIXTURE itself really carries the GPS tag, or this test would pass vacuously.
        const fixtureTag = await backend.call<{ value: string | null }>('test_metadata_tag', {
          image: (
            structuredOf(
              await callTool(tools, 'gimp_open_document', { file_path: gpsJpegPath })
            ) as {
              image: number;
            }
          ).image,
          tag: 'Exif.GPSInfo.GPSLatitude',
        });
        expect(fixtureTag.value).toBeTruthy();

        const opened = await callTool(tools, 'gimp_create_document', { width: 40, height: 40 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await backend.call<{ value: string | null }>('test_metadata_tag', {
            image,
            tag: 'Exif.GPSInfo.GPSLatitude',
          });
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: gpsJpegPath,
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
          const after = await backend.call<{ value: string | null }>('test_metadata_tag', {
            image,
            tag: 'Exif.GPSInfo.GPSLatitude',
          });
          expect(after.value).toBe(before.value); // unchanged -- and, separately, never the leaked value
          expect(after.value).not.toBe(fixtureTag.value);

          // Belt-and-braces: the exported deliverable (which strips metadata unconditionally
          // regardless of source) carries no trace either.
          const outPath = join(workDir, 'gps-place-export.jpg');
          await callTool(tools, 'gimp_export', { image, file_path: outPath });
          const exportedSegments = findJpegApp1Segments(readFileSync(outPath));
          expect(exportedSegments.xmp).toHaveLength(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- gimp_canvas --------------------------------------------------------------------------

    describe('gimp_canvas', () => {
      it('refuses to shrink either dimension, leaving the image unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 20, height: 20 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          const shrink = await callTool(tools, 'gimp_canvas', { image, width: 10, height: 20 });
          expect(shrink.isError).toBe(true);
          const after = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          expect(structuredOf(after)).toMatchObject({
            width: (structuredOf(before) as { width: number }).width,
            height: (structuredOf(before) as { height: number }).height,
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses a non-transparent fill on an indexed image before the canvas resizes at all', async () => {
        const indexed = await backend.call<{ image: number }>('test_new_image', {
          base_type: 'indexed',
        });
        try {
          const before = await callTool(tools, 'gimp_inspect', {
            what: 'document',
            image: indexed.image,
          });
          const result = await callTool(tools, 'gimp_canvas', {
            image: indexed.image,
            width: 40,
            height: 40,
            fill: 'white',
          });
          expect(result.isError).toBe(true);
          expect((result.content?.[0] as { text: string }).text).toContain('indexed');
          const after = await callTool(tools, 'gimp_inspect', {
            what: 'document',
            image: indexed.image,
          });
          expect(structuredOf(after)).toMatchObject({
            width: (structuredOf(before) as { width: number }).width,
            height: (structuredOf(before) as { height: number }).height,
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image: indexed.image });
        }
      });

      it.each(CANVAS_ANCHORS)(
        'anchor=%s positions the existing content correctly',
        async (anchor) => {
          const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
          const image = (structuredOf(opened) as { image: number }).image;
          try {
            const canvas = await callTool(tools, 'gimp_canvas', {
              image,
              width: 20,
              height: 16,
              anchor,
            });
            expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();
            const [expectedX, expectedY] = expectedAnchorOffset(anchor, 10, 10, 20, 16);
            const r = structuredOf(canvas) as { offset_x: number; offset_y: number };
            expect([r.offset_x, r.offset_y]).toEqual([expectedX, expectedY]);
            const tree = await layerTree(image);
            const backgroundNode = tree.find((n) => n.name === 'Background')!;
            expect([backgroundNode.offsets.x, backgroundNode.offsets.y]).toEqual([
              expectedX,
              expectedY,
            ]);
          } finally {
            await callTool(tools, 'gimp_close_document', { image });
          }
        }
      );

      it('explicit offset_x/offset_y is honored, and anchor + offsets together is refused', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const both = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 20,
            anchor: 'center',
            offset_x: 3,
            offset_y: 3,
          });
          expect(both.isError).toBe(true);

          const explicit = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 15,
            offset_x: 4,
            offset_y: 2,
          });
          expect(explicit.isError, JSON.stringify(explicit.content)).toBeFalsy();
          expect(structuredOf(explicit)).toMatchObject({ offset_x: 4, offset_y: 2 });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses a negative or out-of-range explicit offset, leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const negative = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 20,
            offset_x: -1,
            offset_y: 0,
          });
          expect(negative.isError).toBe(true);
          const tooFar = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 20,
            offset_x: 11, // > new_w - old_w (10)
            offset_y: 0,
          });
          expect(tooFar.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses offset_x given without offset_y, leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const result = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 20,
            offset_x: 3,
          });
          expect(result.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses an invalid fill word live, leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const result = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 20,
            fill: 'not-a-real-fill',
          });
          expect(result.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses a target that grows neither dimension', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const result = await callTool(tools, 'gimp_canvas', { image, width: 10, height: 10 });
          expect(result.isError).toBe(true);
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses when a live filter is UNVERIFIABLE (not created by Editmamei), leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 20, height: 20 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          // test_add_foreign_filter (TEST_OPS_PY) attaches a filter with no ledger record at all
          // -- exactly what a filter added in the GIMP GUI looks like to this bridge, the same
          // fixture foreign-and-nested.live.test.ts uses for its own "unverifiable" cases.
          await backend.call('test_add_foreign_filter', {
            image,
            operation: 'gegl:brightness-contrast',
            name: 'GuiFilter',
          });
          const before = await layerTree(image);
          const result = await callTool(tools, 'gimp_canvas', { image, width: 40, height: 20 });
          expect(result.isError).toBe(true);
          expect((result.content?.[0] as { text: string }).text).toMatch(
            /not created by Editmamei/
          );
          expect(await layerTree(image)).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a non-transparent fill (black and hex) works correctly on a GRAYSCALE image', async () => {
        const opened = await callTool(tools, 'gimp_create_document', {
          width: 10,
          height: 10,
          mode: 'grayscale',
          fill: 'transparent',
        });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const black = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 10,
            anchor: 'top_left',
            fill: 'black',
          });
          expect(black.isError, JSON.stringify(black.content)).toBeFalsy();
          const blackPng = await exportPng(image, 'gray-canvas-black');
          expect(pixelAt(readPng(blackPng), 15, 5)).toEqual([0, 0, 0]);

          const hex = await callTool(tools, 'gimp_canvas', {
            image,
            width: 30,
            height: 10,
            anchor: 'top_left',
            fill: '#336699',
          });
          expect(hex.isError, JSON.stringify(hex.content)).toBeFalsy();
          const hexPng = await exportPng(image, 'gray-canvas-hex');
          // Rec 709-ish luminance of #336699 (51,102,153) is ~96-99; never one raw channel (51/102/153).
          const [r, g, b] = pixelAt(readPng(hexPng), 25, 5);
          expect(r).toBe(g);
          expect(g).toBe(b);
          expect(r).toBeGreaterThan(80);
          expect(r).toBeLessThan(110);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it("fill=white paints the BACKDROP LAYER's own pixels (checked in isolation, not just the composite)", async () => {
        const opened = await callTool(tools, 'gimp_create_document', {
          width: 10,
          height: 10,
          fill: 'black',
        });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const canvas = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 20,
            anchor: 'top_left',
            fill: 'white',
          });
          expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();
          const tree = await layerTree(image);
          const backdrop = tree[tree.length - 1]!;
          // Hide every OTHER layer so the export reflects the backdrop layer's own pixels alone,
          // not a composite that happens to look right for the wrong reason.
          for (const node of tree) {
            if (node.layer_id !== backdrop.layer_id) {
              await callTool(tools, 'gimp_layer', {
                image,
                op: 'set',
                layer_id: node.layer_id,
                visible: false,
              });
            }
          }
          const png = await exportPng(image, 'backdrop-isolated-white');
          const decoded = readPng(png);
          // Sample both where the original (now-hidden) content was AND in the padding -- the
          // backdrop spans the WHOLE canvas, so both must read the fill color.
          expect(pixelAt(decoded, 5, 5)).toEqual([255, 255, 255]);
          expect(pixelAt(decoded, 15, 15)).toEqual([255, 255, 255]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('fill=transparent is genuinely transparent only pre-flatten -- gimp_layer op=flatten and gimp_export both fill it with the background color instead', async () => {
        const opened = await callTool(tools, 'gimp_create_document', {
          width: 10,
          height: 10,
          fill: 'black',
        });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const canvas = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 10,
            anchor: 'top_left',
            fill: 'transparent',
          });
          expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();

          // gimp_export flattens internally (op_export -> _composite -> flatten) -- the padding
          // exports as GIMP's background color (white), never as transparency.
          const exportedPath = await exportPng(image, 'transparent-extend-export');
          expect(pixelAt(readPng(exportedPath), 15, 5)).toEqual([255, 255, 255]);

          // gimp_layer op=flatten does the exact same thing, explicitly, and drops alpha.
          const flattened = await callTool(tools, 'gimp_layer', { image, op: 'flatten' });
          expect(flattened.isError, JSON.stringify(flattened.content)).toBeFalsy();
          expect(structuredOf(flattened).has_alpha).toBe(false);
          const afterFlattenPath = await exportPng(image, 'transparent-extend-after-flatten');
          expect(pixelAt(readPng(afterFlattenPath), 15, 5)).toEqual([255, 255, 255]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('fill=transparent adds NO fill layer at all', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          const canvas = await callTool(tools, 'gimp_canvas', {
            image,
            width: 20,
            height: 20,
            fill: 'transparent',
          });
          expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();
          const after = await layerTree(image);
          expect(after.length).toBe(before.length);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it.each([
        ['white', [255, 255, 255]],
        ['black', [0, 0, 0]],
        ['#336699', [0x33, 0x66, 0x99]],
      ] as const)(
        'fill=%s paints a new bottom layer with that color',
        async (fill, expectedRgb) => {
          const opened = await callTool(tools, 'gimp_create_document', {
            width: 10,
            height: 10,
            fill: 'transparent',
          });
          const image = (structuredOf(opened) as { image: number }).image;
          try {
            const before = await layerTree(image);
            const canvas = await callTool(tools, 'gimp_canvas', {
              image,
              width: 20,
              height: 20,
              anchor: 'top_left',
              fill,
            });
            expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();
            const after = await layerTree(image);
            expect(after.length).toBe(before.length + 1);
            const bottomNode = after[after.length - 1]!;
            expect(bottomNode.offsets).toEqual({ x: 0, y: 0 });
            const png = await exportPng(image, `canvas-fill-${fill.replace('#', '')}`);
            // Sample well outside the original 10x10 (now transparent) content, in the padding.
            expect(pixelAt(readPng(png), 15, 15)).toEqual([...expectedRgb]);
          } finally {
            await callTool(tools, 'gimp_close_document', { image });
          }
        }
      );

      it('refuses outright when a masked adjustment is present, leaving the document unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 20, height: 20 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          await callTool(tools, 'gimp_create_mask', {
            image,
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 20,
            name: 'CanvasMask',
          });
          await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'brightness_contrast',
            brightness: 40,
            mask: 'CanvasMask',
          });
          const before = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          const canvas = await callTool(tools, 'gimp_canvas', { image, width: 40, height: 20 });
          expect(canvas.isError).toBe(true);
          expect((canvas.content?.[0] as { text: string }).text).toMatch(
            /any filter not created by Editmamei|masked/
          );
          const after = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          expect(structuredOf(after)).toMatchObject({
            width: (structuredOf(before) as { width: number }).width,
            height: (structuredOf(before) as { height: number }).height,
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('succeeds with a masked adjustment present when the resulting offset is (0,0) -- nothing moves', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 20, height: 20 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          await callTool(tools, 'gimp_create_mask', {
            image,
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 20,
            name: 'ZeroOffsetMask',
          });
          await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'brightness_contrast',
            brightness: 40,
            mask: 'ZeroOffsetMask',
          });
          const before = await exportPng(image, 'canvas-zero-offset-before');
          const beforeDecoded = readPng(before);

          // top_left anchor on a canvas that only grows -- offset_x/offset_y both land at 0, so
          // the existing content (and the mask confining the filter to it) never moves at all.
          const canvas = await callTool(tools, 'gimp_canvas', {
            image,
            width: 40,
            height: 40,
            anchor: 'top_left',
          });
          expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();
          expect(structuredOf(canvas)).toMatchObject({ offset_x: 0, offset_y: 0 });

          const after = await exportPng(image, 'canvas-zero-offset-after');
          const afterDecoded = readPng(after);
          // The masked darkening on the original 20x20 region is unchanged in place.
          for (const [x, y] of [
            [2, 2],
            [15, 2],
          ]) {
            expect(pixelAt(afterDecoded, x, y)).toEqual(pixelAt(beforeDecoded, x, y));
          }
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('an unmasked effect filter (vignette) renders identically on the original content after extending', async () => {
        const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          await callTool(tools, 'gimp_add_effect', { image, type: 'vignette' });
          const before = await exportPng(image, 'vignette-before-extend');
          const beforeDecoded = readPng(before);

          const canvas = await callTool(tools, 'gimp_canvas', {
            image,
            width: beforeDecoded.width + 20,
            height: beforeDecoded.height + 20,
            anchor: 'top_left', // (0,0) offset -- the original content stays at the same coordinates
            fill: 'white',
          });
          expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();

          const cropped = await callTool(tools, 'gimp_crop_document', {
            image,
            left: 0,
            top: 0,
            width: beforeDecoded.width,
            height: beforeDecoded.height,
          });
          expect(cropped.isError, JSON.stringify(cropped.content)).toBeFalsy();
          const after = await exportPng(image, 'vignette-after-extend-cropped');
          expect(maxAbsDiff(beforeDecoded, readPng(after))).toBe(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('an unmasked effect filter (vignette) is unaffected even when the anchor MOVES the layer (center)', async () => {
        const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          await callTool(tools, 'gimp_add_effect', { image, type: 'vignette' });
          const before = await exportPng(image, 'vignette-before-extend-center');
          const beforeDecoded = readPng(before);

          const canvas = await callTool(tools, 'gimp_canvas', {
            image,
            width: beforeDecoded.width + 20,
            height: beforeDecoded.height + 20,
            anchor: 'center', // unlike top_left, this genuinely shifts the layer's own offset
            fill: 'white',
          });
          expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();
          const r = structuredOf(canvas) as { offset_x: number; offset_y: number };
          expect(r.offset_x).toBeGreaterThan(0);
          expect(r.offset_y).toBeGreaterThan(0);

          const cropped = await callTool(tools, 'gimp_crop_document', {
            image,
            left: r.offset_x,
            top: r.offset_y,
            width: beforeDecoded.width,
            height: beforeDecoded.height,
          });
          expect(cropped.isError, JSON.stringify(cropped.content)).toBeFalsy();
          const after = await exportPng(image, 'vignette-after-extend-center-cropped');
          expect(maxAbsDiff(beforeDecoded, readPng(after))).toBe(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- gimp_convert_image_mode ---------------------------------------------------------------

    describe('gimp_convert_image_mode', () => {
      it('rgb -> grayscale -> rgb round trip reports converted: true each time', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const toGray = await callTool(tools, 'gimp_convert_image_mode', {
            image,
            mode: 'grayscale',
          });
          expect(toGray.isError, JSON.stringify(toGray.content)).toBeFalsy();
          expect(structuredOf(toGray)).toEqual({ mode: 'grayscale', converted: true });
          const described = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          expect((structuredOf(described) as { base_type: string }).base_type).toBe('gray');

          const toRgb = await callTool(tools, 'gimp_convert_image_mode', { image, mode: 'rgb' });
          expect(structuredOf(toRgb)).toEqual({ mode: 'rgb', converted: true });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('is a reported no-op when already the requested mode', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const result = await callTool(tools, 'gimp_convert_image_mode', { image, mode: 'rgb' });
          expect(structuredOf(result)).toEqual({ mode: 'rgb', converted: false });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('precision and alpha both survive an rgb -> grayscale -> rgb round trip', async () => {
        const opened = await callTool(tools, 'gimp_create_document', {
          width: 10,
          height: 10,
          precision: '16',
          fill: 'transparent', // an RGBA background layer, so has_alpha is real, not incidental
        });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const before = await layerTree(image);
          expect(before[0]!.is_group).toBe(false);

          await callTool(tools, 'gimp_convert_image_mode', { image, mode: 'grayscale' });
          const afterGray = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          expect((structuredOf(afterGray) as { precision: string }).precision).toBe(
            'u16-non-linear'
          );

          await callTool(tools, 'gimp_convert_image_mode', { image, mode: 'rgb' });
          const afterRgb = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          expect(structuredOf(afterRgb) as { precision: string; base_type: string }).toMatchObject({
            precision: 'u16-non-linear',
            base_type: 'rgb',
          });
          const finalTree = await layerTree(image);
          expect(finalTree[0]!.name).toBe(before[0]!.name);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses an indexed source image outright', async () => {
        const indexedPath = join(workDir, 'indexed.png');
        writeIndexedPng(indexedPath, 8, 8);
        const opened = await callTool(tools, 'gimp_open_document', { file_path: indexedPath });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          const described = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          expect((structuredOf(described) as { base_type: string }).base_type).toBe('indexed');
          const result = await callTool(tools, 'gimp_convert_image_mode', {
            image,
            mode: 'rgb',
          });
          expect(result.isError).toBe(true);
          expect((result.content?.[0] as { text: string }).text).toMatch(/indexed/);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a no-op (already the requested mode) succeeds even with a live filter present', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'brightness_contrast',
            brightness: 20,
          });
          const result = await callTool(tools, 'gimp_convert_image_mode', { image, mode: 'rgb' });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({ mode: 'rgb', converted: false });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses while any live filter is present, leaving the mode unchanged', async () => {
        const opened = await callTool(tools, 'gimp_create_document', { width: 10, height: 10 });
        const image = (structuredOf(opened) as { image: number }).image;
        try {
          await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'brightness_contrast',
            brightness: 20,
          });
          const result = await callTool(tools, 'gimp_convert_image_mode', {
            image,
            mode: 'grayscale',
          });
          expect(result.isError).toBe(true);
          const described = await callTool(tools, 'gimp_inspect', { what: 'document', image });
          expect((structuredOf(described) as { base_type: string }).base_type).toBe('rgb');
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- the structural-op proxy matrix, extended to these four ops --------------------------

    async function warmProxy(image: number): Promise<void> {
      await backend.call('preview', {
        image,
        max_px: 512,
        out_path: join(workDir, `warm-${image}.png`),
      });
    }

    async function previewVsExport(image: number, tag: string): Promise<number> {
      const previewPath = join(workDir, `${tag}-preview.png`);
      await backend.call('preview', { image, max_px: 512, out_path: previewPath });
      const exportPath = join(workDir, `${tag}-export.png`);
      await backend.call('export', { image, path: exportPath });
      return maxAbsDiff(readPng(previewPath), readPng(exportPath));
    }

    it('proxy matrix: PLACE_IMAGE rebuilds the proxy', async () => {
      const opened = await callTool(tools, 'gimp_create_document', { width: 64, height: 64 });
      const image = (structuredOf(opened) as { image: number }).image;
      try {
        await warmProxy(image);
        expect(await previewVsExport(image, 'place-before')).toBeLessThanOrEqual(1);

        const placed = await callTool(tools, 'gimp_place_image', {
          image,
          file_path: swatchesPath, // markedly different content from the plain white background
        });
        expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();

        expect(await previewVsExport(image, 'place-after')).toBeLessThanOrEqual(1);
      } finally {
        await callTool(tools, 'gimp_close_document', { image });
      }
    });

    it('proxy matrix: CANVAS extend rebuilds the proxy', async () => {
      const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
      const image = (structuredOf(opened) as { image: number }).image;
      try {
        await warmProxy(image);
        expect(await previewVsExport(image, 'canvas-before')).toBeLessThanOrEqual(1);

        const canvas = await callTool(tools, 'gimp_canvas', {
          image,
          width: 200,
          height: 100,
          anchor: 'center',
          fill: 'black',
        });
        expect(canvas.isError, JSON.stringify(canvas.content)).toBeFalsy();

        expect(await previewVsExport(image, 'canvas-after')).toBeLessThanOrEqual(1);
      } finally {
        await callTool(tools, 'gimp_close_document', { image });
      }
    });

    it('proxy matrix: CONVERT_IMAGE_MODE rebuilds the proxy', async () => {
      const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
      const image = (structuredOf(opened) as { image: number }).image;
      try {
        await warmProxy(image);
        expect(await previewVsExport(image, 'convert-before')).toBeLessThanOrEqual(1);

        const converted = await callTool(tools, 'gimp_convert_image_mode', {
          image,
          mode: 'grayscale',
        });
        expect(converted.isError, JSON.stringify(converted.content)).toBeFalsy();

        expect(await previewVsExport(image, 'convert-after')).toBeLessThanOrEqual(1);
      } finally {
        await callTool(tools, 'gimp_close_document', { image });
      }
    });

    // ---- end-to-end composite ------------------------------------------------------------------

    it(
      'open A -> place B -> masked grade -> effect -> .xcf round trip + re-edit -> checkpoint -> ' +
        'flatten (discard_hidden) -> restore -> bake -> export',
      async () => {
        const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
        let image = (structuredOf(opened) as { image: number }).image;
        try {
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: rampPath,
            x: 2,
            y: 2,
            width: 16,
            height: 8,
            name: 'PlacedRamp',
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();
          const placedId = structuredOf(placed).layer_id as number;

          await callTool(tools, 'gimp_create_mask', {
            image,
            type: 'rectangle',
            x: 2,
            y: 2,
            width: 8,
            height: 8,
            name: 'GradeMask',
          });
          const grade = await callTool(tools, 'gimp_add_adjustment', {
            image,
            layer_id: placedId,
            type: 'brightness_contrast',
            brightness: 30,
            mask: 'GradeMask',
            name: 'Grade',
          });
          expect(grade.isError, JSON.stringify(grade.content)).toBeFalsy();

          const effect = await callTool(tools, 'gimp_add_effect', {
            image,
            type: 'vignette',
            name: 'Vig',
          });
          expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();

          // .xcf round trip: save, close, reopen -- filters must still be live and re-editable,
          // by a NEW filter_id looked up by name (ids are not stable across a reopen).
          const xcfPath = join(workDir, 'composite-roundtrip.xcf');
          const saved = await callTool(tools, 'gimp_save_xcf', { image, file_path: xcfPath });
          expect(saved.isError, JSON.stringify(saved.content)).toBeFalsy();
          await callTool(tools, 'gimp_close_document', { image });

          const reopened = await callTool(tools, 'gimp_open_document', { file_path: xcfPath });
          expect(reopened.isError, JSON.stringify(reopened.content)).toBeFalsy();
          image = (structuredOf(reopened) as { image: number }).image;

          const filters = await callTool(tools, 'gimp_filter', { op: 'list', image });
          const gradeRecord = (
            filters.structuredContent as {
              filters: Array<{ name: string; filter_id: number; layer_id: number }>;
            }
          ).filters.find((f) => f.name === 'Grade')!;
          const reEdit = await callTool(tools, 'gimp_add_adjustment', {
            image,
            filter_id: gradeRecord.filter_id,
            type: 'brightness_contrast',
            brightness: 50, // merge-not-reset: contrast keeps whatever it was created with
          });
          expect(reEdit.isError, JSON.stringify(reEdit.content)).toBeFalsy();

          const checkpoint = await callTool(tools, 'gimp_checkpoint', { op: 'create', image });
          expect(checkpoint.isError, JSON.stringify(checkpoint.content)).toBeFalsy();
          const checkpointId = structuredOf(checkpoint).checkpoint_id as string;

          // Hide the placed layer so flatten needs discard_hidden -- exercises that branch, then
          // restore recovers the pre-flatten, still-multi-layer state from the checkpoint file.
          const hide = await callTool(tools, 'gimp_layer', {
            image,
            layer_id: gradeRecord.layer_id,
            op: 'set',
            visible: false,
          });
          expect(hide.isError, JSON.stringify(hide.content)).toBeFalsy();

          const refusedFlatten = await callTool(tools, 'gimp_layer', { image, op: 'flatten' });
          expect(refusedFlatten.isError).toBe(true);

          const flattened = await callTool(tools, 'gimp_layer', {
            image,
            op: 'flatten',
            discard_hidden: true,
          });
          expect(flattened.isError, JSON.stringify(flattened.content)).toBeFalsy();
          expect(structuredOf(flattened).discarded_hidden_layers).toHaveLength(1);

          const restored = await callTool(tools, 'gimp_checkpoint', {
            op: 'restore',
            checkpoint_id: checkpointId,
          });
          expect(restored.isError, JSON.stringify(restored.content)).toBeFalsy();
          image = structuredOf(restored).image as number;
          const restoredTree = await layerTree(image);
          expect(restoredTree.length).toBeGreaterThanOrEqual(2); // multi-layer state survived

          const baked = await callTool(tools, 'gimp_bake', { image, all: true });
          expect(baked.isError, JSON.stringify(baked.content)).toBeFalsy();

          const finalPath = join(workDir, 'composite-final.jpg');
          const exported = await callTool(tools, 'gimp_export', { image, file_path: finalPath });
          expect(exported.isError, JSON.stringify(exported.content)).toBeFalsy();
          expect((structuredOf(exported) as { bytes: number }).bytes).toBeGreaterThan(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      }
    );
  }
);
