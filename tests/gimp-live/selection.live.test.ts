/**
 * gimp_select / gimp_modify_selection / gimp_layer_mask / gimp_get_selection_preview, plus the
 * bridge-only `load_mask` / `render_layer` ops, against real headless GIMP. Driven through the
 * actual tool handlers (a real `GimpBackend`/`GimpSession`), the same "drive the TOOLS, not the
 * bridge" posture `layers.live.test.ts` takes -- except for `load_mask`/`render_layer`, which have
 * no gimp_* tool wrapper at all (they are bridge ops called by name through the backend; nothing
 * in this codebase wraps them as an MCP tool), so those two are called through `backend.call` the
 * same way this file's neighbors call test-only ops directly.
 *
 * Every assertion below reads a measured number (a channel's exact pixel content via the
 * test-only `export_mask` op, or a rendered composite's own pixels) rather than trusting a
 * `structuredContent.fraction` self-report alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpBackend } from '@editmamei/backends/gimp/backend.ts';
import { createGimpCoreTools } from '@editmamei/tools/gimp-core-tools.ts';
import { createGimpDocumentTools } from '@editmamei/tools/gimp-document-tools.ts';
import { createGimpInspectTools } from '@editmamei/tools/gimp-inspect-tools.ts';
import { createGimpVerifyTools } from '@editmamei/tools/gimp-verify-tools.ts';
import { createGimpAdjustmentTools } from '@editmamei/tools/gimp-adjustment-tools.ts';
import { createGimpLayerTools } from '@editmamei/tools/gimp-layer-tools.ts';
import { createGimpComposeTools } from '@editmamei/tools/gimp-compose-tools.ts';
import { createGimpSelectionTools } from '@editmamei/tools/gimp-selection-tools.ts';
import type { ToolDefinition, ToolResult } from '@editmamei/core/tool-registry.ts';
import { callTool } from '../fixtures/tool-helpers.ts';
import {
  readPng,
  readGrayscalePgm,
  pixelAt,
  writeColorSwatches,
  writeRgbaSquare,
  writeHardEdge,
  SWATCHES,
  SWATCH_SIZE,
  readyGimpRegistry,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

// 60s, not the 30s project default: each test opens a document, runs several tool calls, and
// exports at least one render. Some tests here run several GIMP sessions in parallel with the
// rest of the live suite, which is measurably slower than one session alone.
vi.setConfig({ testTimeout: 60_000 });

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (selection)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

function structuredOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** The bridge reports `fraction` rounded to 4 decimals (`_channel_coverage`), so an exact-count
 * expectation must round its own division the same way rather than compare against the raw
 * quotient. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

describe.skipIf(!install)(
  'gimp_select / gimp_modify_selection / gimp_layer_mask against real headless GIMP',
  () => {
    let workDir: string;
    let backend: GimpBackend;
    let tools: ToolDefinition[];
    let fileCounter = 0;

    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'em-gimp-selection-'));
      // opsPyPath: TEST_OPS_PY -- adds export_mask/test_selection_empty, used throughout to read a
      // channel's exact pixel content or confirm no stray selection, rather than trusting the
      // tool's own self-reported fraction.
      backend = new GimpBackend(install, {
        sessionOptions: { rootDir: join(workDir, 'session-root'), opsPyPath: TEST_OPS_PY },
      });
      tools = [
        ...createGimpCoreTools(backend),
        ...createGimpDocumentTools(backend),
        ...createGimpInspectTools(backend),
        ...createGimpVerifyTools(backend),
        ...createGimpAdjustmentTools(backend),
        ...createGimpLayerTools(backend),
        ...createGimpComposeTools(backend),
        ...createGimpSelectionTools(backend),
      ];
      await readyGimpRegistry((name, args) => callTool(tools, name, args));
    }, LIVE_READY_TIMEOUT_MS);

    afterAll(async () => {
      await backend.shutdown();
      rmSync(workDir, { recursive: true, force: true });
    });

    function tempFile(ext: string): string {
      return join(workDir, `t${fileCounter++}.${ext}`);
    }

    async function createDoc(
      width: number,
      height: number,
      fill: 'white' | 'black' | 'transparent' = 'white'
    ): Promise<number> {
      const opened = await callTool(tools, 'gimp_create_document', { width, height, fill });
      expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
      return structuredOf(opened).image as number;
    }

    async function exportComposite(image: number) {
      const p = tempFile('png');
      await backend.call('export', { image, path: p });
      return readPng(p);
    }

    async function exportChannel(image: number, channel: string): Promise<Buffer> {
      const p = tempFile('pgm');
      await backend.call('export_mask', { image, channel, path: p });
      return readGrayscalePgm(p);
    }

    async function selectionEmpty(image: number): Promise<boolean> {
      const r = await backend.call<{ selection_empty: boolean }>('test_selection_empty', { image });
      return r.selection_empty;
    }

    // ---- gimp_select: every mode produces a non-empty channel ----------------------------------

    describe('gimp_select', () => {
      it('mode=rectangle selects exactly its rectangle (pixel-exact, not just the reported fraction)', async () => {
        const image = await createDoc(64, 64, 'white');
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 16,
            name: 'Rect',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({
            channel: 'Rect',
            selected_pixels: 512,
            fraction: 0.125,
          });

          const pgm = await exportChannel(image, 'Rect');
          let wrong = 0;
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
              const inside = x < 32 && y < 16;
              if (pgm[y * 64 + x] !== (inside ? 255 : 0)) wrong++;
            }
          }
          expect(wrong, 'pixels not matching the exact rectangle').toBe(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=ellipse reports plausible coverage for its bounding box (~pi/4)', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'ellipse',
            x: 0,
            y: 0,
            width: 32,
            height: 32,
            name: 'Ellipse',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const boxFraction = (structuredOf(result).selected_pixels as number) / (32 * 32);
          expect(boxFraction).toBeGreaterThan(0.6);
          expect(boxFraction).toBeLessThan(0.9);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=polygon (an axis-aligned rectangle) selects close to its exact area', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'polygon',
            points: [
              [0, 0],
              [32, 0],
              [32, 32],
              [0, 32],
            ],
            name: 'Poly',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const frac = structuredOf(result).fraction as number;
          expect(frac).toBeGreaterThan(0.24);
          expect(frac).toBeLessThan(0.26); // 32*32/4096 = 0.25 exactly; small AA tolerance at the vertices
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=polygon refuses fewer than 3 points, dispatching nothing', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'polygon',
            points: [
              [0, 0],
              [32, 32],
            ],
            name: 'TooFew',
          });
          expect(result.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=color_range selects approximately one swatch by its exact color', async () => {
        const swatchesPath = tempFile('png');
        writeColorSwatches(swatchesPath);
        const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
        const image = structuredOf(opened).image as number;
        try {
          const target = SWATCHES[3]!; // 'red'
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'color_range',
            color: rgbToHex(target.rgb),
            threshold: 10,
            name: 'ColorSel',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const frac = structuredOf(result).fraction as number;
          expect(frac).toBeGreaterThan(0.1); // 1/6 of the 6-swatch strip, ~0.1667
          expect(frac).toBeLessThan(0.2);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=color_range rejects a non-hex color before dispatch', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'color_range',
            color: 'red',
            name: 'BadColor',
          });
          expect(result.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=magic_wand selects the contiguous swatch clicked, not its neighbors', async () => {
        const swatchesPath = tempFile('png');
        writeColorSwatches(swatchesPath);
        const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
        const image = structuredOf(opened).image as number;
        try {
          const swatchIndex = 4; // 'green'
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'magic_wand',
            x: swatchIndex * SWATCH_SIZE + SWATCH_SIZE / 2,
            y: SWATCH_SIZE / 2,
            name: 'WandSel',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          // Exactly one 16x16 swatch out of the 6x16x16 strip.
          expect(structuredOf(result)).toMatchObject({
            selected_pixels: SWATCH_SIZE * SWATCH_SIZE,
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it("mode=alpha selects exactly a layer's opaque region", async () => {
        const image = await createDoc(64, 64, 'transparent');
        try {
          const squarePath = tempFile('png');
          writeRgbaSquare(squarePath, 64, 64, 16, 16, 20, [255, 0, 0]);
          const placed = await callTool(tools, 'gimp_place_image', {
            image,
            file_path: squarePath,
            name: 'Square',
          });
          expect(placed.isError, JSON.stringify(placed.content)).toBeFalsy();

          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'alpha',
            layer: 'Square',
            name: 'Alpha',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({
            channel: 'Alpha',
            selected_pixels: 400,
            fraction: round4(400 / 4096),
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=channel copies another channel exactly, pixel for pixel', async () => {
        const image = await createDoc(64, 64);
        try {
          const first = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            name: 'Src',
          });
          const copy = await callTool(tools, 'gimp_select', {
            image,
            mode: 'channel',
            source: 'Src',
            name: 'Dst',
          });
          expect(copy.isError, JSON.stringify(copy.content)).toBeFalsy();
          expect(structuredOf(copy)).toMatchObject({
            selected_pixels: structuredOf(first).selected_pixels,
            fraction: structuredOf(first).fraction,
          });
          // Compare the actual buffers, not just the reported counts -- a copy that happened to
          // match totals but landed different pixels would pass a count-only check.
          const srcBuf = await exportChannel(image, 'Src');
          const dstBuf = await exportChannel(image, 'Dst');
          expect(dstBuf).toEqual(srcBuf);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('mode=all selects the entire canvas', async () => {
        const image = await createDoc(20, 10);
        try {
          const result = await callTool(tools, 'gimp_select', { image, mode: 'all' });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({
            channel: 'Selection',
            selected_pixels: 200,
            fraction: 1,
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('invert alone flips a plain rectangle exactly', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            invert: true,
            name: 'Inverted',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({
            channel: 'Inverted',
            selected_pixels: 32 * 64,
            fraction: 0.5,
          });
          const pgm = await exportChannel(image, 'Inverted');
          expect(pgm[10 * 64 + 10]).toBe(0); // inside the original rectangle -> now unselected
          expect(pgm[10 * 64 + 50]).toBe(255); // outside it -> now selected
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('feather_px alone softens the edge of a plain rectangle', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            feather_px: 6,
            name: 'Feathered',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const pgm = await exportChannel(image, 'Feathered');
          const edge = pgm[32 * 64 + 32]!;
          expect(edge).toBeGreaterThan(0);
          expect(edge).toBeLessThan(255);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('sample_merged:false samples only the named layer, not the visible composite', async () => {
        const image = await createDoc(32, 32, 'black');
        try {
          // A white top layer covering only the left half -- the composite (black+white) differs
          // from the background layer's OWN content (pure black everywhere) at x < 16.
          const top = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Top',
            width: 16,
            height: 32,
            fill: 'white',
          });
          expect(top.isError, JSON.stringify(top.content)).toBeFalsy();

          const layers = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
          const bg = (
            structuredOf(layers).layers as Array<{ layer_id: number; name: string }>
          ).find((l) => l.name !== 'Top')!;

          // Sampling the BACKGROUND layer directly (sample_merged: false) at a point under the
          // white top layer must see the background's own black, not the composite's white.
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'color_range',
            layer_id: bg.layer_id,
            x: 4,
            y: 4,
            sample_merged: false,
            threshold: 5,
            name: 'BgOnly',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          // The whole 32x32 background layer is flat black, so sampling it directly selects the
          // entire canvas -- if it had instead read the composite's white, the selection would
          // have been confined to (or excluded) the left half instead.
          expect(structuredOf(result)).toMatchObject({ selected_pixels: 32 * 32 });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it("color_range by sample point on an OFFSET layer reads that layer's own pixel, in its own local coordinates", async () => {
        const image = await createDoc(64, 64, 'black');
        try {
          const offset = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Offset',
            width: 10,
            height: 10,
            fill: 'white',
          });
          expect(offset.isError, JSON.stringify(offset.content)).toBeFalsy();
          const layerId = structuredOf(offset).layer_id as number;
          const moved = await callTool(tools, 'gimp_layer', {
            image,
            op: 'move',
            layer_id: layerId,
            x: 20,
            y: 20,
          });
          expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();

          // (25, 25) in document coordinates is (5, 5) local to the offset layer -- inside its
          // 10x10 bounds, and white.
          const inside = await callTool(tools, 'gimp_select', {
            image,
            mode: 'color_range',
            layer_id: layerId,
            x: 25,
            y: 25,
            sample_merged: false,
            threshold: 5,
            name: 'OffsetSample',
          });
          expect(inside.isError, JSON.stringify(inside.content)).toBeFalsy();
          expect(structuredOf(inside)).toMatchObject({ selected_pixels: 100 });

          // (5, 5) in document coordinates is OUTSIDE the offset layer's own 10x10x(20,20) bounds
          // entirely -- refused rather than silently sampling the wrong (or a garbage) pixel.
          const outside = await callTool(tools, 'gimp_select', {
            image,
            mode: 'color_range',
            layer_id: layerId,
            x: 5,
            y: 5,
            sample_merged: false,
            name: 'OutOfBounds',
          });
          expect(outside.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('gradient_linear ramps from black at x1 to white at x2', async () => {
        // A wide (256px) span, like the existing create_mask gradient live test uses -- a narrow
        // gradient measured close to its own endpoints is affected by the fill's own edge
        // softening, which a wider span makes proportionally negligible.
        const image = await createDoc(256, 32);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'gradient_linear',
            x1: 0,
            y1: 0,
            x2: 255,
            y2: 0,
            name: 'Grad',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const pgm = await exportChannel(image, 'Grad');
          // Sampled at the exact endpoints and the same <50/>200 tolerance the existing
          // create_mask gradient live test uses (edit_gradient_fill's own edge softening means a
          // point even a few px in from x=0 reads meaningfully above 0).
          const left = pgm[16 * 256 + 0]!;
          const mid = pgm[16 * 256 + 128]!;
          const right = pgm[16 * 256 + 255]!;
          expect(left).toBeLessThan(mid);
          expect(mid).toBeLessThan(right);
          expect(left).toBeLessThan(50);
          expect(right).toBeGreaterThan(200);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('gradient_linear invert swaps which end is black vs white', async () => {
        const image = await createDoc(256, 32);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'gradient_linear',
            x1: 0,
            y1: 0,
            x2: 255,
            y2: 0,
            invert: true,
            name: 'GradInv',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const pgm = await exportChannel(image, 'GradInv');
          const left = pgm[16 * 256 + 0]!;
          const right = pgm[16 * 256 + 255]!;
          expect(left).toBeGreaterThan(right);
          expect(left).toBeGreaterThan(200);
          expect(right).toBeLessThan(50);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('gradient_radial centers full effect and fades to none at the radius edge', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'gradient_radial',
            cx: 32,
            cy: 32,
            radius: 30,
            name: 'Radial',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const pgm = await exportChannel(image, 'Radial');
          expect(pgm[32 * 64 + 32]!).toBeGreaterThan(225); // center: full effect (white)
          expect(pgm[1 * 64 + 1]!).toBeLessThan(30); // far corner, past the radius: none (black)
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('combine=add unions two disjoint rectangles exactly', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 32,
            name: 'U',
          });
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 32,
            y: 0,
            width: 32,
            height: 32,
            name: 'U',
            combine: 'add',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({
            channel: 'U',
            selected_pixels: 64 * 32,
            fraction: 0.5,
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('combine=subtract removes the overlap exactly', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 64,
            height: 32,
            name: 'S',
          });
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 32,
            name: 'S',
            combine: 'subtract',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({
            channel: 'S',
            selected_pixels: 32 * 32,
            fraction: (32 * 32) / 4096,
          });
          const pgm = await exportChannel(image, 'S');
          expect(pgm[16 * 64 + 10]).toBe(0); // subtracted-away corner
          expect(pgm[16 * 64 + 50]).toBe(255); // remaining strip
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('combine=intersect keeps only the overlap exactly', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            name: 'I',
          });
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 20,
            y: 20,
            width: 40,
            height: 40,
            name: 'I',
            combine: 'intersect',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toEqual({
            channel: 'I',
            selected_pixels: 20 * 20,
            fraction: round4((20 * 20) / 4096),
          });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('combine != replace with no existing channel of that name is refused', async () => {
        const image = await createDoc(64, 64);
        try {
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            name: 'NeverMade',
            combine: 'add',
          });
          expect(result.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('invert applies to the NEW shape alone, before combine — not to the unioned result', async () => {
        // A 2x2 grid of 32x32 quadrants: TL, TR, BL, BR. Existing channel 'X' = TL. New call:
        // shape = BR, invert: true, combine: add. Per-shape invert (correct): invert(BR) = every
        // quadrant except BR = TL+TR+BL (0.75), unioned with the existing TL changes nothing
        // (already included) -> 0.75. Post-combine invert (the bug): invert(TL union BR) =
        // TR+BL (0.5). The two hypotheses predict different, measurable fractions.
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 32,
            name: 'X',
          });
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 32,
            y: 32,
            width: 32,
            height: 32,
            invert: true,
            combine: 'add',
            name: 'X',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          expect(structuredOf(result)).toMatchObject({ fraction: 0.75 });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('feather_px applies to the NEW shape alone, before combine — the seam with the existing shape is soft', async () => {
        // Existing channel 'X' = the left half (hard edges). New call: the right half, feathered,
        // combine: add. If feather applied to the right half's OWN shape first, its left edge (the
        // seam at x=32, touching the existing left half) is soft on ITS OWN copy -- visible in the
        // final union just to the right of the seam. If feather were instead applied to the FINAL
        // union (which covers the whole 64x64 canvas, no interior edge at x=32 at all), there would
        // be nothing to feather there and the seam would stay perfectly hard.
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'X',
          });
          const result = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 32,
            y: 0,
            width: 32,
            height: 64,
            feather_px: 6,
            combine: 'add',
            name: 'X',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const pgm = await exportChannel(image, 'X');
          expect(pgm[32 * 64 + 30]).toBe(255); // deep in the (unfeathered) left half
          expect(pgm[32 * 64 + 60]).toBe(255); // deep in the right half, away from its own edges
          const seam = pgm[32 * 64 + 33]!; // just right of the seam -- the right shape's own soft edge
          expect(seam, 'the seam should be soft, not hard 255').toBeLessThan(255);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a channel produced by gimp_select confines gimp_add_adjustment via mask, honouring layer_id', async () => {
        const image = await createDoc(64, 64, 'white');
        try {
          const before = await exportComposite(image);
          const sel = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'Left',
          });
          expect(sel.isError, JSON.stringify(sel.content)).toBeFalsy();

          const layers = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
          const bg = (structuredOf(layers).layers as Array<{ layer_id: number }>)[0]!;

          const added = await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'curves',
            layer_id: bg.layer_id,
            mask: 'Left',
            points: [
              [0, 0],
              [255, 0],
            ], // forces every masked pixel to pure black
          });
          expect(added.isError, JSON.stringify(added.content)).toBeFalsy();

          const after = await exportComposite(image);
          let wrong = 0;
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
              const [r, g, b] = pixelAt(after, x, y);
              if (x < 32) {
                if (r !== 0 || g !== 0 || b !== 0) wrong++;
              } else {
                const beforePixel = pixelAt(before, x, y);
                if (r !== beforePixel[0] || g !== beforePixel[1] || b !== beforePixel[2]) wrong++;
              }
            }
          }
          expect(wrong, 'pixels not matching the expected masked/unmasked split').toBe(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('requires image and mode, and rejects an unknown mode or combine before dispatch', async () => {
        const image = await createDoc(8, 8);
        try {
          const missing = await callTool(tools, 'gimp_select', { image });
          expect(missing.isError).toBe(true);
          const badMode = await callTool(tools, 'gimp_select', { image, mode: 'lasso' });
          expect(badMode.isError).toBe(true);
          const badCombine = await callTool(tools, 'gimp_select', {
            image,
            mode: 'all',
            combine: 'xor',
          });
          expect(badCombine.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a failed call leaves no stray active selection behind', async () => {
        const image = await createDoc(16, 16);
        try {
          const before = await selectionEmpty(image);
          expect(before).toBe(true);
          const failed = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 999,
            // height omitted -- lib.require fails mid-dispatch
          });
          expect(failed.isError).toBe(true);
          expect(await selectionEmpty(image), 'a failed gimp_select left a selection active').toBe(
            true
          );
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- gimp_modify_selection: every op changes the channel measurably ------------------------

    describe('gimp_modify_selection', () => {
      it('expand increases coverage and contract decreases it, without touching the source channel', async () => {
        const image = await createDoc(64, 64);
        try {
          const base = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 16,
            y: 16,
            width: 16,
            height: 16,
            name: 'M',
          });
          const baseFraction = structuredOf(base).fraction as number;

          const grown = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'M',
            op: 'expand',
            px: 4,
            output: 'Grown',
          });
          expect(grown.isError, JSON.stringify(grown.content)).toBeFalsy();
          expect(structuredOf(grown).fraction as number).toBeGreaterThan(baseFraction);

          const shrunk = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'M',
            op: 'contract',
            px: 4,
            output: 'Shrunk',
          });
          expect(shrunk.isError, JSON.stringify(shrunk.content)).toBeFalsy();
          expect(structuredOf(shrunk).fraction as number).toBeLessThan(baseFraction);

          // 'M' itself must be untouched (output was redirected to Grown/Shrunk both times).
          const untouched = await exportChannel(image, 'M');
          let wrong = 0;
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
              const inside = x >= 16 && x < 32 && y >= 16 && y < 32;
              if (untouched[y * 64 + x] !== (inside ? 255 : 0)) wrong++;
            }
          }
          expect(wrong, 'the source channel changed even though output was redirected').toBe(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('invert flips the channel exactly (coverage becomes 1 - original, spot-checked)', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'Inv',
          });
          const inverted = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'Inv',
            op: 'invert',
          });
          expect(inverted.isError, JSON.stringify(inverted.content)).toBeFalsy();
          expect(structuredOf(inverted)).toEqual({
            channel: 'Inv',
            selected_pixels: 32 * 64,
            fraction: 0.5,
          });

          const pgm = await exportChannel(image, 'Inv');
          expect(pgm[10 * 64 + 10]).toBe(0); // was selected, now not
          expect(pgm[10 * 64 + 50]).toBe(255); // was not selected, now is
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('border produces a ring straddling the original edge: interior and far-outside pixels are unselected', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 16,
            y: 16,
            width: 32,
            height: 32,
            name: 'Border',
          });
          const bordered = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'Border',
            op: 'border',
            px: 4,
          });
          expect(bordered.isError, JSON.stringify(bordered.content)).toBeFalsy();
          const f = structuredOf(bordered).fraction as number;
          expect(f).toBeGreaterThan(0);
          expect(f).toBeLessThan(1);

          const pgm = await exportChannel(image, 'Border');
          // Border straddles the edge in BOTH directions (verified live: the resulting ring can
          // cover MORE area than the original rectangle for a small shape and a wide radius), so
          // what actually defines "a ring" is that the interior and the far outside are both
          // unselected, and only a band around the original edge remains.
          expect(pgm[32 * 64 + 32], 'deep inside the original rectangle').toBe(0);
          expect(pgm[2 * 64 + 2], 'far outside the original rectangle').toBe(0);
          expect(pgm[32 * 64 + 16], 'right on the original left edge').toBe(255);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('feather produces intermediate (non-binary) values right at the formerly-hard edge', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'Feather',
          });
          const feathered = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'Feather',
            op: 'feather',
            px: 6,
          });
          expect(feathered.isError, JSON.stringify(feathered.content)).toBeFalsy();
          const pgm = await exportChannel(image, 'Feather');
          const edgeValue = pgm[32 * 64 + 32]!; // x=32, the exact former edge
          expect(edgeValue).toBeGreaterThan(0);
          expect(edgeValue).toBeLessThan(255);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('feather accepts a large radius (up to 1000px) with no cap — unlike expand/contract/border', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'BigFeather',
          });
          const result = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'BigFeather',
            op: 'feather',
            px: 500,
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('harden re-thresholds a soft (feathered) mask back to a hard 0/255 edge', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'Hard',
            feather_px: 6,
          });
          const hardened = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'Hard',
            op: 'harden',
          });
          expect(hardened.isError, JSON.stringify(hardened.content)).toBeFalsy();
          const pgm = await exportChannel(image, 'Hard');
          for (const x of [0, 10, 20]) {
            expect(pgm[32 * 64 + x], `x=${x} should be hard-selected`).toBe(255);
          }
          for (const x of [45, 55, 63]) {
            expect(pgm[32 * 64 + x], `x=${x} should be hard-unselected`).toBe(0);
          }
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('smooth measurably rounds a jagged (staircase) selection edge', async () => {
        const image = await createDoc(64, 64);
        try {
          // Build a staircase via three overlapping rectangles -- a real jagged edge, not just a
          // single rectangle's already-straight border.
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 8,
            y: 8,
            width: 8,
            height: 24,
            name: 'Stair',
          });
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 16,
            y: 16,
            width: 8,
            height: 24,
            name: 'Stair',
            combine: 'add',
          });
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 24,
            y: 24,
            width: 8,
            height: 24,
            name: 'Stair',
            combine: 'add',
          });
          const before = await exportChannel(image, 'Stair');
          const smoothed = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'Stair',
            op: 'smooth',
            px: 3,
          });
          expect(smoothed.isError, JSON.stringify(smoothed.content)).toBeFalsy();
          const after = await exportChannel(image, 'Stair');
          let changed = 0;
          for (let i = 0; i < before.length; i++) {
            if (before[i] !== after[i]) changed++;
          }
          expect(changed, 'smooth left the jagged edge completely unchanged').toBeGreaterThan(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('expand/contract/border refuse px <= 0, and px beyond the 150px cap', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            name: 'Cap',
          });
          for (const op of ['expand', 'contract', 'border'] as const) {
            const zero = await callTool(tools, 'gimp_modify_selection', {
              image,
              channel: 'Cap',
              op,
              px: 0,
            });
            expect(zero.isError, `${op} px=0`).toBe(true);
            const missing = await callTool(tools, 'gimp_modify_selection', {
              image,
              channel: 'Cap',
              op,
            });
            expect(missing.isError, `${op} with no px`).toBe(true);
            const tooBig = await callTool(tools, 'gimp_modify_selection', {
              image,
              channel: 'Cap',
              op,
              px: 151,
            });
            expect(tooBig.isError, `${op} px=151`).toBe(true);
            const atCap = await callTool(tools, 'gimp_modify_selection', {
              image,
              channel: 'Cap',
              op,
              px: 150,
              output: 'CapOut',
            });
            expect(atCap.isError, `${op} px=150`).toBeFalsy();
          }
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses to modify a channel already confining a live filter, leaving it unchanged', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            name: 'InUse',
          });
          const added = await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'exposure',
            exposure: 1,
            mask: 'InUse',
          });
          expect(added.isError, JSON.stringify(added.content)).toBeFalsy();

          const before = await exportChannel(image, 'InUse');
          const result = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'InUse',
            op: 'expand',
            px: 2,
          });
          expect(result.isError).toBe(true);
          const after = await exportChannel(image, 'InUse');
          expect(after).toEqual(before);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('requires image, channel, and op, rejects an unknown channel, and leaves no stray selection on failure', async () => {
        const image = await createDoc(8, 8);
        try {
          const missing = await callTool(tools, 'gimp_modify_selection', { image, op: 'expand' });
          expect(missing.isError).toBe(true);
          const ghost = await callTool(tools, 'gimp_modify_selection', {
            image,
            channel: 'Ghost',
            op: 'expand',
            px: 2,
          });
          expect(ghost.isError).toBe(true);
          expect(await selectionEmpty(image)).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- gimp_layer_mask: create / apply / delete / invert, proven by real compositing ----------

    describe('gimp_layer_mask', () => {
      async function blackWhiteDoc(): Promise<{ image: number; topId: number }> {
        const image = await createDoc(32, 32, 'black');
        const top = await callTool(tools, 'gimp_layer', {
          image,
          op: 'create',
          name: 'Top',
          fill: 'white',
        });
        expect(top.isError, JSON.stringify(top.content)).toBeFalsy();
        return { image, topId: structuredOf(top).layer_id as number };
      }

      it('create confines visibility to the channel; apply bakes it as a real cut-out', async () => {
        const { image, topId } = await blackWhiteDoc();
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            name: 'Reveal',
          });
          const created = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'Reveal',
            layer_id: topId,
          });
          expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
          expect(structuredOf(created)).toMatchObject({ has_mask: true });

          const afterCreate = await exportComposite(image);
          expect(pixelAt(afterCreate, 4, 4)).toEqual([255, 255, 255]); // inside reveal -> top layer (white)
          expect(pixelAt(afterCreate, 24, 24)).toEqual([0, 0, 0]); // outside -> background (black)

          const applied = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'apply',
            layer_id: topId,
          });
          expect(applied.isError, JSON.stringify(applied.content)).toBeFalsy();
          expect(structuredOf(applied)).toMatchObject({ has_mask: false });

          const afterApply = await exportComposite(image);
          expect(pixelAt(afterApply, 4, 4)).toEqual([255, 255, 255]);
          expect(pixelAt(afterApply, 24, 24)).toEqual([0, 0, 0]);

          // Adding a brand-new reveal-all mask must NOT bring back the previously hidden pixels --
          // proving `apply` really baked the cut, rather than leaving the old pixels recoverable.
          const revealAll = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            source: 'white',
            layer_id: topId,
          });
          expect(revealAll.isError, JSON.stringify(revealAll.content)).toBeFalsy();
          const afterRevealAll = await exportComposite(image);
          expect(pixelAt(afterRevealAll, 4, 4)).toEqual([255, 255, 255]);
          expect(pixelAt(afterRevealAll, 24, 24), 'the cut pixels must stay gone for good').toEqual(
            [0, 0, 0]
          );
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('create on a layer that ALREADY has a mask validates the new one before discarding the old', async () => {
        const { image, topId } = await blackWhiteDoc();
        try {
          // A first, working mask (top-left quadrant revealed).
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            name: 'Good',
          });
          const first = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'Good',
            layer_id: topId,
          });
          expect(first.isError, JSON.stringify(first.content)).toBeFalsy();
          const beforeComposite = await exportComposite(image);

          // Live test for D1: a bad channel name must be refused WITHOUT destroying the existing,
          // working mask -- neither its has_mask flag nor its rendered effect may change.
          const badReplace = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'DoesNotExist',
            layer_id: topId,
          });
          expect(badReplace.isError).toBe(true);

          const inspected = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
          const topNode = (
            structuredOf(inspected).layers as Array<{ layer_id: number; has_alpha: boolean }>
          ).find((l) => l.layer_id === topId);
          expect(topNode).toBeDefined();

          const afterComposite = await exportComposite(image);
          expect(afterComposite.data.equals(beforeComposite.data), 'the old mask changed').toBe(
            true
          );

          // A genuinely new, valid mask still replaces the old one afterward (proves the layer
          // isn't stuck, only that a BAD replacement is refused).
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 16,
            y: 16,
            width: 16,
            height: 16,
            name: 'Second',
          });
          const secondReplace = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'Second',
            layer_id: topId,
          });
          expect(secondReplace.isError, JSON.stringify(secondReplace.content)).toBeFalsy();
          const finalComposite = await exportComposite(image);
          expect(pixelAt(finalComposite, 4, 4)).toEqual([0, 0, 0]); // old reveal area now hidden
          expect(pixelAt(finalComposite, 24, 24)).toEqual([255, 255, 255]); // new reveal area visible
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it.each(['white', 'black', 'alpha', 'grayscale'] as const)(
        'create with source=%s attaches a mask without error',
        async (source) => {
          const { image, topId } = await blackWhiteDoc();
          try {
            const result = await callTool(tools, 'gimp_layer_mask', {
              image,
              op: 'create',
              source,
              layer_id: topId,
            });
            expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
            expect(structuredOf(result)).toMatchObject({ has_mask: true });
          } finally {
            await callTool(tools, 'gimp_close_document', { image });
          }
        }
      );

      it('create with source=white then invert produces a fully-hidden mask', async () => {
        const { image, topId } = await blackWhiteDoc();
        try {
          const result = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            source: 'white',
            invert: true,
            layer_id: topId,
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const after = await exportComposite(image);
          // white -> invert -> black mask: the top (white) layer is fully hidden everywhere.
          expect(pixelAt(after, 4, 4)).toEqual([0, 0, 0]);
          expect(pixelAt(after, 24, 24)).toEqual([0, 0, 0]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('create on an offset, smaller layer masks only within its own placement (place-then-mask)', async () => {
        const image = await createDoc(64, 64, 'black');
        try {
          const photo = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Photo',
            width: 20,
            height: 20,
            fill: 'white',
          });
          expect(photo.isError, JSON.stringify(photo.content)).toBeFalsy();
          const photoId = structuredOf(photo).layer_id as number;
          // Placed so it STRADDLES the mask boundary below (x in [20,40)): part of the layer
          // overlaps the selected half, part does not, and part of the canvas is outside the
          // layer's own placement entirely -- three distinct outcomes to check.
          await callTool(tools, 'gimp_layer', {
            image,
            op: 'move',
            layer_id: photoId,
            x: 20,
            y: 10,
          });

          // Select the LEFT half of the full canvas -- only the portion overlapping the layer's
          // own 20x20 placement can possibly show through once used as its mask.
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'HalfCanvas',
          });
          const created = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'HalfCanvas',
            layer_id: photoId,
          });
          expect(created.isError, JSON.stringify(created.content)).toBeFalsy();

          const after = await exportComposite(image);
          expect(pixelAt(after, 25, 15)).toEqual([255, 255, 255]); // inside the layer (x in [20,40)) AND inside the mask's left half (x<32)
          expect(pixelAt(after, 35, 15)).toEqual([0, 0, 0]); // inside the layer but x>=32 -> masked out
          expect(pixelAt(after, 50, 15)).toEqual([0, 0, 0]); // outside the layer's own placement entirely
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('apply on a layer with NO alpha channel still bakes correctly', async () => {
        // A flat opened PNG (color type 2, truecolor without alpha) -- unlike every layer this
        // bridge itself CREATES (always RGBA/GRAYA), this is how a real no-alpha layer arises.
        const flatPath = tempFile('png');
        writeColorSwatches(flatPath);
        const opened = await callTool(tools, 'gimp_open_document', { file_path: flatPath });
        const image = structuredOf(opened).image as number;
        try {
          const layers = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
          const bg = (
            structuredOf(layers).layers as Array<{ layer_id: number; has_alpha: boolean }>
          )[0]!;
          expect(bg.has_alpha, 'fixture assumption: the opened layer starts with no alpha').toBe(
            false
          );

          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: SWATCH_SIZE * 3,
            height: SWATCH_SIZE,
            name: 'HalfSwatches',
          });
          const created = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'HalfSwatches',
            layer_id: bg.layer_id,
          });
          expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
          const applied = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'apply',
            layer_id: bg.layer_id,
          });
          expect(applied.isError, JSON.stringify(applied.content)).toBeFalsy();
          expect(structuredOf(applied)).toMatchObject({ has_mask: false });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('delete removes the mask WITHOUT baking, restoring the layer fully', async () => {
        const { image, topId } = await blackWhiteDoc();
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            name: 'Reveal2',
          });
          await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'Reveal2',
            layer_id: topId,
          });
          const deleted = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'delete',
            layer_id: topId,
          });
          expect(deleted.isError, JSON.stringify(deleted.content)).toBeFalsy();
          expect(structuredOf(deleted)).toMatchObject({ has_mask: false });

          const after = await exportComposite(image);
          // no mask at all -> the WHOLE (opaque, white) top layer shows everywhere
          expect(pixelAt(after, 4, 4)).toEqual([255, 255, 255]);
          expect(pixelAt(after, 24, 24)).toEqual([255, 255, 255]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('invert flips which side of the mask is visible', async () => {
        const { image, topId } = await blackWhiteDoc();
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            name: 'Reveal3',
          });
          await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'Reveal3',
            layer_id: topId,
          });
          const inverted = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'invert',
            layer_id: topId,
          });
          expect(inverted.isError, JSON.stringify(inverted.content)).toBeFalsy();
          expect(structuredOf(inverted)).toMatchObject({ has_mask: true });

          const after = await exportComposite(image);
          expect(pixelAt(after, 4, 4)).toEqual([0, 0, 0]); // now hidden
          expect(pixelAt(after, 24, 24)).toEqual([255, 255, 255]); // now visible
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a layer with no mask refuses delete/apply/invert, and an unknown channel refuses create', async () => {
        const { image, topId } = await blackWhiteDoc();
        try {
          for (const op of ['delete', 'apply', 'invert'] as const) {
            const result = await callTool(tools, 'gimp_layer_mask', { image, op, layer_id: topId });
            expect(result.isError, op).toBe(true);
          }
          const ghost = await callTool(tools, 'gimp_layer_mask', {
            image,
            op: 'create',
            channel: 'Ghost',
            layer_id: topId,
          });
          expect(ghost.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- gimp_get_selection_preview: an actual, decodable image ---------------------------------

    describe('gimp_get_selection_preview', () => {
      it('returns a JPEG image matching the reported dimensions', async () => {
        const image = await createDoc(64, 64, 'white');
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 32,
            name: 'Prev',
          });
          const result = await callTool(tools, 'gimp_get_selection_preview', {
            image,
            channel: 'Prev',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
          const imageBlock = result.content?.find((c) => c.type === 'image') as
            { data: string } | undefined;
          expect(imageBlock).toBeDefined();
          const bytes = Buffer.from(imageBlock!.data, 'base64');
          expect(bytes.length).toBeGreaterThan(0);
          expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI marker
          expect(result.structuredContent).toEqual({ width: 64, height: 64 });
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('style=mask is an exact black/white render; style=overlay tints only the unselected area', async () => {
        const image = await createDoc(64, 64, 'white');
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 32,
            height: 64,
            name: 'PrevStyle',
          });

          // Called as a raw bridge op (not the gimp_get_selection_preview TOOL, which always
          // renders to a lossy .jpg): a .png out_path gives a lossless render to check pixels
          // against exactly.
          const maskPath = tempFile('png');
          await backend.call('mask_preview', {
            image,
            channel: 'PrevStyle',
            style: 'mask',
            out_path: maskPath,
          });
          const maskPng = readPng(maskPath);
          expect(pixelAt(maskPng, 5, 5)).toEqual([255, 255, 255]); // selected -> white
          expect(pixelAt(maskPng, 50, 5)).toEqual([0, 0, 0]); // unselected -> black

          const overlayPath = tempFile('png');
          await backend.call('mask_preview', {
            image,
            channel: 'PrevStyle',
            style: 'overlay',
            out_path: overlayPath,
          });
          const overlayPng = readPng(overlayPath);
          expect(pixelAt(overlayPng, 5, 5)).toEqual([255, 255, 255]); // selected -> untouched
          const [r, g, b] = pixelAt(overlayPng, 50, 5); // unselected -> 50% red wash over white
          expect(r).toBe(255);
          expect(g).toBeLessThan(200);
          expect(b).toBeLessThan(200);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('works on a non-RGB (grayscale) image', async () => {
        const opened = await callTool(tools, 'gimp_create_document', {
          width: 32,
          height: 32,
          mode: 'grayscale',
        });
        const image = structuredOf(opened).image as number;
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            name: 'GrayPrev',
          });
          const result = await callTool(tools, 'gimp_get_selection_preview', {
            image,
            channel: 'GrayPrev',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('works on an image carrying a live filter', async () => {
        const image = await createDoc(32, 32, 'white');
        try {
          const added = await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'exposure',
            exposure: 1,
          });
          expect(added.isError, JSON.stringify(added.content)).toBeFalsy();
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 16,
            height: 16,
            name: 'FilteredPrev',
          });
          const result = await callTool(tools, 'gimp_get_selection_preview', {
            image,
            channel: 'FilteredPrev',
          });
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('requires image and channel, and an unknown channel surfaces a bridge error', async () => {
        const image = await createDoc(8, 8);
        try {
          const missing = await callTool(tools, 'gimp_get_selection_preview', { image });
          expect(missing.isError).toBe(true);
          const ghost = await callTool(tools, 'gimp_get_selection_preview', {
            image,
            channel: 'Ghost',
          });
          expect(ghost.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- load_mask / render_layer: bridge ops called by name through the backend; no gimp_* tool
    // ---- wraps either.

    describe('load_mask', () => {
      it('round-trips a PNG mask into a channel, scaling to the document size (whole-image target)', async () => {
        const image = await createDoc(64, 64);
        try {
          const maskPath = tempFile('png');
          writeHardEdge(maskPath, 32, 16); // left half black, right half white -- a DIFFERENT size than the doc
          const result = await backend.call<{
            channel: string;
            selected_pixels: number;
            fraction: number;
          }>('load_mask', { image, path: maskPath, name: 'Loaded' });
          expect(result.channel).toBe('Loaded');
          expect(result.fraction).toBeCloseTo(0.5, 1);

          const pgm = await exportChannel(image, 'Loaded');
          expect(pgm[32 * 64 + 10]).toBe(0); // left half -> black -> unselected
          expect(pgm[32 * 64 + 50]).toBe(255); // right half -> white -> selected
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it("with a layer given, scopes the mask to that layer's own offset bounds, not the whole canvas", async () => {
        const image = await createDoc(64, 64);
        try {
          const layer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Offset',
            width: 20,
            height: 10,
          });
          expect(layer.isError, JSON.stringify(layer.content)).toBeFalsy();
          const layerId = structuredOf(layer).layer_id as number;
          const moved = await callTool(tools, 'gimp_layer', {
            image,
            op: 'move',
            layer_id: layerId,
            x: 5,
            y: 8,
          });
          expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();

          const maskPath = tempFile('png');
          writeHardEdge(maskPath, 40, 20); // scaled DOWN to the layer's own 20x10
          const result = await backend.call<{ selected_pixels: number; fraction: number }>(
            'load_mask',
            {
              image,
              layer_id: layerId,
              path: maskPath,
              name: 'LayerLoaded',
            }
          );
          // Scoped to the LAYER's 20x10 area (200px total), not the 64x64 canvas (4096px). A hard
          // 50/50 edge scaled down cleanly lands at (or extremely close to) exactly half.
          expect(result.selected_pixels).toBeGreaterThanOrEqual(90);
          expect(result.selected_pixels).toBeLessThanOrEqual(110);
          expect(result.fraction).toBeCloseTo(100 / 4096, 1);

          const pgm = await exportChannel(image, 'LayerLoaded');
          // The ENTIRE channel outside the layer's bounds is black -- not just the one sampled
          // point, every pixel.
          let outsideWrong = 0;
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
              const insideBounds = x >= 5 && x < 25 && y >= 8 && y < 18;
              if (!insideBounds && pgm[y * 64 + x] !== 0) outsideWrong++;
            }
          }
          expect(outsideWrong, 'pixels outside the layer bounds were selected').toBe(0);
          expect(pgm[8 * 64 + 7]).toBe(0); // inside the bounds, left (formerly black) half
          expect(pgm[8 * 64 + 22]).toBe(255); // inside the bounds, right (formerly white) half
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('with a layer partly off-canvas (negative offset), scopes the mask to the visible intersection', async () => {
        const image = await createDoc(64, 64);
        try {
          const layer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'NegOffset',
            width: 20,
            height: 20,
          });
          const layerId = structuredOf(layer).layer_id as number;
          await callTool(tools, 'gimp_layer', {
            image,
            op: 'move',
            layer_id: layerId,
            x: -10,
            y: -5,
          });

          const maskPath = tempFile('png');
          writeHardEdge(maskPath, 20, 20); // left half black, right half white, matching the layer's own size
          const result = await backend.call<{ selected_pixels: number }>('load_mask', {
            image,
            layer_id: layerId,
            path: maskPath,
            name: 'NegLoaded',
          });
          // Only the visible slice (document x in [0,10), y in [0,15)) can land in the channel at
          // all. In the LAYER's own local coordinates that slice is x in [10,20) (local_x =
          // doc_x - ox = doc_x + 10) -- entirely the mask's right (white) half, so the whole
          // visible slice is selected: 10 x 15 = 150 px.
          expect(result.selected_pixels).toBe(150);
          const pgm = await exportChannel(image, 'NegLoaded');
          expect(pgm[5 * 64 + 5]).toBe(255); // inside the visible slice -> selected
          expect(pgm[20 * 64 + 20]).toBe(0); // outside the layer's visible slice entirely
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('with a layer partly off-canvas (past the right/bottom edge), scopes the mask to the visible intersection', async () => {
        const image = await createDoc(64, 64);
        try {
          const layer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'FarOffset',
            width: 20,
            height: 20,
          });
          const layerId = structuredOf(layer).layer_id as number;
          await callTool(tools, 'gimp_layer', {
            image,
            op: 'move',
            layer_id: layerId,
            x: 55,
            y: 55,
          });

          const maskPath = tempFile('png');
          writeHardEdge(maskPath, 20, 20); // left half black, right half white
          const result = await backend.call<{ selected_pixels: number }>('load_mask', {
            image,
            layer_id: layerId,
            path: maskPath,
            name: 'FarLoaded',
          });
          // Visible slice: x in [55,64) i.e. the layer's local x in [0,9) -- entirely its own left
          // (black) half, so nothing is selected; and the channel must be all-black outside too.
          expect(result.selected_pixels).toBe(0);
          const pgm = await exportChannel(image, 'FarLoaded');
          expect(pgm.every((b) => b === 0)).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('an RGBA mask with transparency selects by luminance x alpha, not the raw luminance', async () => {
        const image = await createDoc(64, 64);
        try {
          const maskPath = tempFile('png');
          // A fully-opaque white 32x32 square in the top-left corner, fully-TRANSPARENT (but also
          // white, so a naive flatten-onto-white would wrongly select it too) everywhere else.
          writeRgbaSquare(maskPath, 64, 64, 0, 0, 32, [255, 255, 255]);
          const result = await backend.call<{ selected_pixels: number }>('load_mask', {
            image,
            path: maskPath,
            name: 'RgbaLoaded',
          });
          expect(result.selected_pixels).toBe(32 * 32);
          const pgm = await exportChannel(image, 'RgbaLoaded');
          expect(pgm[10 * 64 + 10]).toBe(255); // inside the opaque square -> selected
          expect(pgm[50 * 64 + 50]).toBe(0); // transparent (white RGB, alpha 0) -> NOT selected
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('refuses a mask name already confining a live filter', async () => {
        const image = await createDoc(64, 64);
        try {
          await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            name: 'InUseLoad',
          });
          await callTool(tools, 'gimp_add_adjustment', {
            image,
            type: 'exposure',
            exposure: 1,
            mask: 'InUseLoad',
          });
          const maskPath = tempFile('png');
          writeHardEdge(maskPath, 8, 8);
          await expect(
            backend.call('load_mask', { image, path: maskPath, name: 'InUseLoad' })
          ).rejects.toThrow();
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a missing source file is a clean error, not a stack trace', async () => {
        const image = await createDoc(8, 8);
        try {
          await expect(
            backend.call('load_mask', {
              image,
              path: join(workDir, 'does-not-exist.png'),
              name: 'Missing',
            })
          ).rejects.toThrow();
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    describe('render_layer', () => {
      it("renders ONLY the layer's own pixels and reports its bounds in document pixels", async () => {
        const image = await createDoc(64, 64, 'black');
        try {
          const layer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Patch',
            width: 20,
            height: 10,
            fill: 'white',
          });
          expect(layer.isError, JSON.stringify(layer.content)).toBeFalsy();
          const layerId = structuredOf(layer).layer_id as number;
          const moved = await callTool(tools, 'gimp_layer', {
            image,
            op: 'move',
            layer_id: layerId,
            x: 5,
            y: 8,
          });
          expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();

          const outPath = tempFile('png');
          const result = await backend.call<{
            width: number;
            height: number;
            layer_id: number;
            bounds: { x: number; y: number; width: number; height: number };
          }>('render_layer', { image, layer_id: layerId, out_path: outPath });
          expect(result.bounds).toEqual({ x: 5, y: 8, width: 20, height: 10 });
          expect(result.width).toBe(20);
          expect(result.height).toBe(10);

          const png = readPng(outPath);
          expect(png.width).toBe(20);
          expect(png.height).toBe(10);
          let wrong = 0;
          for (let y = 0; y < png.height; y++) {
            for (let x = 0; x < png.width; x++) {
              const [r, g, b] = pixelAt(png, x, y);
              if (r !== 255 || g !== 255 || b !== 255) wrong++; // the layer's own fill, not the black canvas
            }
          }
          expect(wrong, "pixels not matching the layer's own white fill").toBe(0);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('scales down to max_px when the layer exceeds it', async () => {
        const image = await createDoc(64, 64);
        try {
          const layer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Big',
            width: 3000,
            height: 1000,
            fill: 'white',
          });
          expect(layer.isError, JSON.stringify(layer.content)).toBeFalsy();
          const layerId = structuredOf(layer).layer_id as number;
          const outPath = tempFile('png');
          const result = await backend.call<{ width: number; height: number }>('render_layer', {
            image,
            layer_id: layerId,
            out_path: outPath,
            max_px: 512, // the only accepted values are 512/1024/2048 (GIMP_MAX_PX_PROP's enum)
          });
          expect(Math.max(result.width, result.height)).toBe(512);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('renders a HIDDEN layer as if it were visible', async () => {
        const image = await createDoc(16, 16, 'black');
        try {
          const layer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Hidden',
            width: 16,
            height: 16,
            fill: 'white',
          });
          const layerId = structuredOf(layer).layer_id as number;
          const set = await callTool(tools, 'gimp_layer', {
            image,
            op: 'set',
            layer_id: layerId,
            visible: false,
          });
          expect(set.isError, JSON.stringify(set.content)).toBeFalsy();

          const outPath = tempFile('png');
          await backend.call('render_layer', { image, layer_id: layerId, out_path: outPath });
          const png = readPng(outPath);
          expect(pixelAt(png, 8, 8)).toEqual([255, 255, 255]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('renders a 40%-opacity, Screen-mode layer at full opacity in Normal mode', async () => {
        const image = await createDoc(16, 16, 'black');
        try {
          const layer = await callTool(tools, 'gimp_layer', {
            image,
            op: 'create',
            name: 'Dim',
            width: 16,
            height: 16,
            fill: 'white',
          });
          const layerId = structuredOf(layer).layer_id as number;
          const set = await callTool(tools, 'gimp_layer', {
            image,
            op: 'set',
            layer_id: layerId,
            opacity: 40,
            mode: 'screen',
          });
          expect(set.isError, JSON.stringify(set.content)).toBeFalsy();

          const outPath = tempFile('png');
          await backend.call('render_layer', { image, layer_id: layerId, out_path: outPath });
          const png = readPng(outPath);
          // The layer's own content (opaque white) rendered plainly, not the dimmed/blended
          // result its 40%-opacity Screen compositing against the canvas would produce.
          expect(pixelAt(png, 8, 8)).toEqual([255, 255, 255]);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });

      it('a nonexistent layer_id is a clean error', async () => {
        const image = await createDoc(8, 8);
        try {
          const outPath = tempFile('png');
          await expect(
            backend.call('render_layer', { image, layer_id: 999_999, out_path: outPath })
          ).rejects.toThrow();
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });
  }
);
