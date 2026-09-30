/**
 * gimp_select / gimp_modify_mask / gimp_layer_mask / gimp_get_mask_preview, plus the bridge-only
 * `load_mask` / `render_layer` ops, against real headless GIMP. Driven through the actual tool
 * handlers (a real `GimpBackend`/`GimpSession`), the same "drive the TOOLS, not the bridge"
 * posture `layers.live.test.ts` takes -- except for `load_mask`/`render_layer`, which have no
 * gimp_* tool wrapper at all (they exist for the mask-import/layer-render ceremony a non-gimp_*
 * caller drives directly), so those two are called through `backend.call` the same way this
 * file's neighbors call test-only ops directly.
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
// exports at least one render -- comfortably inside 60s even under parallel load on this machine,
// where a 30s cap has been observed to flake (see layers.live.test.ts's identical comment).
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
  'gimp_select / gimp_modify_mask / gimp_layer_mask against real headless GIMP',
  () => {
    let workDir: string;
    let backend: GimpBackend;
    let tools: ToolDefinition[];
    let fileCounter = 0;

    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'em-gimp-selection-'));
      // opsPyPath: TEST_OPS_PY -- adds export_mask, used throughout to read a channel's exact
      // pixel content rather than trusting the tool's own self-reported fraction.
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

      it('mode=channel copies another channel exactly (same coverage)', async () => {
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

      it('requires image and mode, and rejects an unknown mode/combine before dispatch', async () => {
        const image = await createDoc(8, 8);
        try {
          const missing = await callTool(tools, 'gimp_select', { image });
          expect(missing.isError).toBe(true);
          const badMode = await callTool(tools, 'gimp_select', { image, mode: 'lasso' });
          expect(badMode.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- gimp_modify_mask: every op changes the channel measurably ------------------------------

    describe('gimp_modify_mask', () => {
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

          const grown = await callTool(tools, 'gimp_modify_mask', {
            image,
            channel: 'M',
            op: 'expand',
            px: 4,
            output: 'Grown',
          });
          expect(grown.isError, JSON.stringify(grown.content)).toBeFalsy();
          expect(structuredOf(grown).fraction as number).toBeGreaterThan(baseFraction);

          const shrunk = await callTool(tools, 'gimp_modify_mask', {
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
          const inverted = await callTool(tools, 'gimp_modify_mask', {
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
          const bordered = await callTool(tools, 'gimp_modify_mask', {
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
          const feathered = await callTool(tools, 'gimp_modify_mask', {
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
          const hardened = await callTool(tools, 'gimp_modify_mask', {
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

      it('smooth keeps a plausible coverage (rounds jaggies without erasing the mask)', async () => {
        const image = await createDoc(64, 64);
        try {
          const base = await callTool(tools, 'gimp_select', {
            image,
            mode: 'rectangle',
            x: 8,
            y: 8,
            width: 24,
            height: 24,
            name: 'Smooth',
          });
          const baseFraction = structuredOf(base).fraction as number;
          const smoothed = await callTool(tools, 'gimp_modify_mask', {
            image,
            channel: 'Smooth',
            op: 'smooth',
            px: 2,
          });
          expect(smoothed.isError, JSON.stringify(smoothed.content)).toBeFalsy();
          const f = structuredOf(smoothed).fraction as number;
          expect(f).toBeGreaterThan(0);
          expect(Math.abs(f - baseFraction)).toBeLessThan(0.1);
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
          const result = await callTool(tools, 'gimp_modify_mask', {
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

      it('requires image, channel, and op, and rejects an unknown channel', async () => {
        const image = await createDoc(8, 8);
        try {
          const missing = await callTool(tools, 'gimp_modify_mask', { image, op: 'expand' });
          expect(missing.isError).toBe(true);
          const ghost = await callTool(tools, 'gimp_modify_mask', {
            image,
            channel: 'Ghost',
            op: 'expand',
          });
          expect(ghost.isError).toBe(true);
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

    // ---- gimp_get_mask_preview: an actual, decodable image ---------------------------------------

    describe('gimp_get_mask_preview', () => {
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
          const result = await callTool(tools, 'gimp_get_mask_preview', { image, channel: 'Prev' });
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

          // Called as a raw bridge op (not the gimp_get_mask_preview TOOL, which always renders to
          // a lossy .jpg): a .png out_path gives a lossless render to check pixels against exactly.
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

      it('requires image and channel, and an unknown channel surfaces a bridge error', async () => {
        const image = await createDoc(8, 8);
        try {
          const missing = await callTool(tools, 'gimp_get_mask_preview', { image });
          expect(missing.isError).toBe(true);
          const ghost = await callTool(tools, 'gimp_get_mask_preview', { image, channel: 'Ghost' });
          expect(ghost.isError).toBe(true);
        } finally {
          await callTool(tools, 'gimp_close_document', { image });
        }
      });
    });

    // ---- load_mask / render_layer: bridge ops behind the remote mask-import/layer-render ceremony

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
          // Scoped to the LAYER's 20x10 area (200px total), not the 64x64 canvas (4096px).
          expect(result.selected_pixels).toBeLessThanOrEqual(200);
          expect(result.fraction).toBeCloseTo(100 / 4096, 2);

          const pgm = await exportChannel(image, 'LayerLoaded');
          expect(pgm[0]).toBe(0); // entirely outside the layer's bounds
          expect(pgm[8 * 64 + 7]).toBe(0); // inside the bounds, left (formerly black) half
          expect(pgm[8 * 64 + 22]).toBe(255); // inside the bounds, right (formerly white) half
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
    });
  }
);
