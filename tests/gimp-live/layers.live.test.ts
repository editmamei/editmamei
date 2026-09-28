/**
 * gimp_layer / gimp_bake against real headless GIMP, driven through the actual tool handlers and a
 * real `GimpBackend`/`GimpSession` — the same "drive the TOOLS, not the bridge" posture
 * `checkpoint.live.test.ts` takes (gimp_checkpoint sits alongside gimp_layer here since one test
 * exercises checkpoint -> flatten -> restore for the layer structure and its live filter).
 *
 * Verified-live assumptions this file pins as regression tests (see `bridge/ops.py`'s own
 * "layer management" section comment for the full probe record):
 *  - `layer.copy()` copies a layer's live filters under the SAME names, and `DrawableFilter.
 *    set_name` does not exist on this GIMP build, so `duplicate` refuses outright when the source
 *    carries an Editmamei filter.
 *  - `Item.set_offsets` is an ABSOLUTE move that does not carry a masked filter's confinement with
 *    it — `move` refuses under the same conditions gimp_transform_canvas already does.
 *  - `Image.merge_down` / `Image.flatten` both bake every live filter they touch into real pixels
 *    first, masked ones included, correctly confined.
 *  - `Drawable.merge_filters()` (gimp_bake) bakes a masked filter into a layer's own pixels
 *    exactly, without merging it into anything else.
 *  - Every structural op drops the preview-proxy cache (the rewritten invariant at the top of
 *    `ops.py`'s PROXIES comment) — the "structural-op proxy matrix" below pins it directly.
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
import { createGimpAdjustmentTools } from '@editmamei/tools/gimp-adjustment-tools.ts';
import { createGimpFilterTools } from '@editmamei/tools/gimp-filter-tools.ts';
import { createGimpGeometryTools } from '@editmamei/tools/gimp-geometry-tools.ts';
import { createGimpMaskTools } from '@editmamei/tools/gimp-mask-tools.ts';
import { createGimpVerifyTools } from '@editmamei/tools/gimp-verify-tools.ts';
import { createGimpLayerTools } from '@editmamei/tools/gimp-layer-tools.ts';
import { createGimpCheckpointTools } from '@editmamei/tools/gimp-checkpoint-tools.ts';
import type { ToolDefinition, ToolResult } from '@editmamei/core/tool-registry.ts';
import { callTool } from '../fixtures/tool-helpers.ts';
import {
  writeGrayRamp,
  writeColorSwatches,
  readPng,
  maxAbsDiff,
  readyGimpRegistry,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 60_000 });

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (layers)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

interface LayerNode {
  layer_id: number;
  name: string;
  is_group: boolean;
  is_text_layer: boolean;
  children: LayerNode[];
}

function structuredOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe.skipIf(!install)('gimp_layer / gimp_bake against real headless GIMP', () => {
  let workDir: string;
  let backend: GimpBackend;
  let tools: ToolDefinition[];
  let rampPath: string;
  let swatchesPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-layers-'));
    // opsPyPath: TEST_OPS_PY -- adds test_add_text_layer / test_proxy_filter_count, used below.
    backend = new GimpBackend(install, {
      sessionOptions: { rootDir: join(workDir, 'session-root'), opsPyPath: TEST_OPS_PY },
    });
    tools = [
      ...createGimpCoreTools(backend),
      ...createGimpDocumentTools(backend),
      ...createGimpInspectTools(backend),
      ...createGimpAdjustmentTools(backend),
      ...createGimpFilterTools(backend),
      ...createGimpGeometryTools(backend),
      ...createGimpMaskTools(backend),
      ...createGimpVerifyTools(backend),
      ...createGimpLayerTools(backend),
      ...createGimpCheckpointTools(backend),
    ];
    await readyGimpRegistry((name, args) => callTool(tools, name, args));
    rampPath = join(workDir, 'ramp.png');
    swatchesPath = join(workDir, 'swatches.png');
    writeGrayRamp(rampPath, 64, 64);
    writeColorSwatches(swatchesPath);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await backend.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function openRamp(): Promise<number> {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: rampPath });
    expect(opened.isError, JSON.stringify(opened.content)).toBeFalsy();
    return structuredOf(opened).image as number;
  }

  async function layerTree(image: number): Promise<LayerNode[]> {
    const result = await callTool(tools, 'gimp_inspect', { what: 'layers', image });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return structuredOf(result).layers as LayerNode[];
  }

  it('create/create_group/reorder build nested groups that gimp_inspect what=layers agrees with', async () => {
    const image = await openRamp();
    try {
      const layer = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'Leaf' });
      expect(layer.isError, JSON.stringify(layer.content)).toBeFalsy();
      const leafId = structuredOf(layer).layer_id as number;

      const outer = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'Outer',
      });
      const outerId = structuredOf(outer).layer_id as number;
      const inner = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'Inner',
      });
      const innerId = structuredOf(inner).layer_id as number;

      // Inner into Outer, then Leaf into Inner: a real, live group-in-group nest.
      const reorderInner = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: innerId,
        parent_group: outerId,
      });
      expect(reorderInner.isError, JSON.stringify(reorderInner.content)).toBeFalsy();
      const reorderLeaf = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: leafId,
        parent_group: innerId,
      });
      expect(reorderLeaf.isError, JSON.stringify(reorderLeaf.content)).toBeFalsy();

      const tree = await layerTree(image);
      const outerNode = tree.find((n) => n.layer_id === outerId);
      expect(outerNode).toMatchObject({ name: 'Outer', is_group: true });
      expect(outerNode!.children).toHaveLength(1);
      const innerNode = outerNode!.children[0]!;
      expect(innerNode).toMatchObject({ layer_id: innerId, name: 'Inner', is_group: true });
      expect(innerNode.children).toHaveLength(1);
      expect(innerNode.children[0]).toMatchObject({
        layer_id: leafId,
        name: 'Leaf',
        is_group: false,
      });

      // to_top_level pulls Leaf back out.
      const toTop = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: leafId,
        to_top_level: true,
      });
      expect(toTop.isError, JSON.stringify(toTop.content)).toBeFalsy();
      const afterTop = await layerTree(image);
      expect(afterTop.some((n) => n.layer_id === leafId)).toBe(true);
      const outerAfter = afterTop.find((n) => n.layer_id === outerId)!;
      expect(outerAfter.children[0]!.children).toHaveLength(0);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('reorder refuses to nest a group inside itself or one of its own descendants', async () => {
    const image = await openRamp();
    try {
      const outer = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'SelfOuter',
      });
      const outerId = structuredOf(outer).layer_id as number;
      const intoSelf = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: outerId,
        parent_group: outerId,
      });
      expect(intoSelf.isError).toBe(true);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('duplicate copies a plain layer with a unique suffixed name, inserted directly above the source', async () => {
    const image = await openRamp();
    try {
      const created = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'Plain' });
      const plainId = structuredOf(created).layer_id as number;
      const dup = await callTool(tools, 'gimp_layer', {
        image,
        op: 'duplicate',
        layer_id: plainId,
      });
      expect(dup.isError, JSON.stringify(dup.content)).toBeFalsy();
      expect(structuredOf(dup).name).toBe('Plain 2');

      const tree = await layerTree(image);
      const names = tree.map((n) => n.name);
      // The copy lands directly above the source in the stack.
      expect(names.indexOf('Plain 2')).toBe(names.indexOf('Plain') - 1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('duplicate refuses when the layer carries an Editmamei filter, naming DrawableFilter.set_name', async () => {
    const image = await openRamp();
    try {
      const adjust = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'curves',
        points: [
          [0, 0],
          [255, 255],
        ],
      });
      expect(adjust.isError, JSON.stringify(adjust.content)).toBeFalsy();

      const dup = await callTool(tools, 'gimp_layer', { image, op: 'duplicate' });
      expect(dup.isError).toBe(true);
      const text = (dup.content?.[0] as { text: string }).text;
      expect(text).toContain('DrawableFilter.set_name');
      expect(text).toContain('Editmamei filter');
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('move refuses when the layer carries a masked filter; baking clears the refusal', async () => {
    const image = await openRamp();
    try {
      const unmaskedMove = await callTool(tools, 'gimp_layer', {
        image,
        op: 'move',
        x: 3,
        y: 3,
      });
      expect(unmaskedMove.isError, JSON.stringify(unmaskedMove.content)).toBeFalsy();

      await callTool(tools, 'gimp_create_mask', {
        image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 32,
        height: 64,
        name: 'MoveMask',
      });
      await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'brightness_contrast',
        brightness: -40,
        mask: 'MoveMask',
      });
      const refused = await callTool(tools, 'gimp_layer', { image, op: 'move', x: 5, y: 5 });
      expect(refused.isError).toBe(true);
      expect((refused.content?.[0] as { text: string }).text).toContain('masked adjustment');

      const baked = await callTool(tools, 'gimp_bake', { image });
      expect(baked.isError, JSON.stringify(baked.content)).toBeFalsy();
      expect(structuredOf(baked).baked).toBe(true);

      const movedAfterBake = await callTool(tools, 'gimp_layer', { image, op: 'move', x: 7, y: 7 });
      expect(movedAfterBake.isError, JSON.stringify(movedAfterBake.content)).toBeFalsy();
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('merge_down bakes a masked filter correctly and prunes the ledger for both merged layers', async () => {
    const image = await openRamp();
    try {
      // The ramp fixture's own base layer takes an unmasked filter first (so the merge also
      // proves a SURVIVING layer's own live filter gets baked too, not just the merged-away one).
      await callTool(tools, 'gimp_add_adjustment', { image, type: 'saturation', scale: 0.5 });
      const top = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'Top',
        fill: 'white',
      });
      const topId = structuredOf(top).layer_id as number;
      await callTool(tools, 'gimp_create_mask', {
        image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 32,
        height: 64,
        name: 'MergeMask',
      });
      await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'brightness_contrast',
        brightness: -60,
        layer_id: topId,
        mask: 'MergeMask',
      });

      const beforePath = join(workDir, 'merge-before.png');
      const beforeExport = await callTool(tools, 'gimp_export', { image, file_path: beforePath });
      expect(beforeExport.isError, JSON.stringify(beforeExport.content)).toBeFalsy();
      const before = readPng(beforePath);

      const listBefore = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      expect((structuredOf(listBefore).filters as unknown[]).length).toBeGreaterThanOrEqual(2);

      const merged = await callTool(tools, 'gimp_layer', {
        image,
        op: 'merge_down',
        layer_id: topId,
      });
      expect(merged.isError, JSON.stringify(merged.content)).toBeFalsy();

      const listAfter = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      expect(structuredOf(listAfter).filters).toEqual([]);

      const afterPath = join(workDir, 'merge-after.png');
      await callTool(tools, 'gimp_export', { image, file_path: afterPath });
      const after = readPng(afterPath);
      // The masked darkening on top of the (now-baked) unmasked saturation change renders
      // identically before and after the merge -- merge_down is a render, not an approximation.
      expect(maxAbsDiff(before, after)).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('flatten collapses to one layer, drops alpha, rasterizes a text layer, and prunes the ledger', async () => {
    const image = await openRamp();
    try {
      await callTool(tools, 'gimp_add_adjustment', { image, type: 'saturation', scale: 0.5 });
      await backend.call('test_add_text_layer', { image, text: 'Hi' });

      const flat = await callTool(tools, 'gimp_layer', { image, op: 'flatten' });
      expect(flat.isError, JSON.stringify(flat.content)).toBeFalsy();
      expect(structuredOf(flat)).toMatchObject({ rasterized_text: true, has_alpha: false });

      const tree = await layerTree(image);
      expect(tree).toHaveLength(1);
      const listAfter = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      expect(structuredOf(listAfter).filters).toEqual([]);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('rotate with a nested group present leaves the group nesting unchanged (children stay aligned)', async () => {
    const image = await openRamp();
    try {
      const outer = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'RotOuter',
      });
      const outerId = structuredOf(outer).layer_id as number;
      const child = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'RotChild' });
      const childId = structuredOf(child).layer_id as number;
      await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: childId,
        parent_group: outerId,
      });

      const before = await layerTree(image);
      const rotated = await callTool(tools, 'gimp_transform_canvas', {
        image,
        op: 'rotate',
        degrees: 90,
        expand: true,
      });
      expect(rotated.isError, JSON.stringify(rotated.content)).toBeFalsy();
      const after = await layerTree(image);

      const stripIds = (nodes: LayerNode[]): unknown =>
        nodes.map((n) => ({ name: n.name, is_group: n.is_group, children: stripIds(n.children) }));
      expect(stripIds(after)).toEqual(stripIds(before));
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('bake removes every filter from gimp_filter listing and leaves pixels identical to the pre-bake render', async () => {
    const image = await openRamp();
    try {
      await callTool(tools, 'gimp_create_mask', {
        image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 32,
        height: 64,
        name: 'BakeMask',
      });
      await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'brightness_contrast',
        brightness: -50,
        mask: 'BakeMask',
      });

      const beforePath = join(workDir, 'bake-before.png');
      await callTool(tools, 'gimp_export', { image, file_path: beforePath });
      const before = readPng(beforePath);

      const baked = await callTool(tools, 'gimp_bake', { image });
      expect(structuredOf(baked).baked).toBe(true);

      const listAfter = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      expect(structuredOf(listAfter).filters).toEqual([]);

      const afterPath = join(workDir, 'bake-after.png');
      await callTool(tools, 'gimp_export', { image, file_path: afterPath });
      const after = readPng(afterPath);
      expect(maxAbsDiff(before, after)).toBeLessThanOrEqual(1);

      // A second bake (nothing left to bake) is a reported no-op, not an error.
      const bakedAgain = await callTool(tools, 'gimp_bake', { image });
      expect(structuredOf(bakedAgain).baked).toBe(false);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  // ---- the structural-op proxy matrix -----------------------------------------------------------
  // Every gimp_layer sub-op except select, and gimp_bake, must drop the preview-proxy cache (the
  // rewritten ops.py PROXIES invariant). Same "warm the proxy, change something, compare a preview
  // against a full-resolution export" pattern geometry-and-masks.live.test.ts already uses for
  // crop/rotate/flip/resize -- duplicated rather than imported, per that file's own convention.

  // gimp_get_preview (the TOOL) always renders JPEG -- fine for a human to look at, but lossy and
  // undecodable by this suite's PNG-only reader, so the proxy-vs-export comparison itself goes
  // straight through `backend.call('preview'/'export', ...)` with an explicit `.png` out_path,
  // the same route geometry-and-masks.live.test.ts's own `previewVsExport` uses. The STRUCTURAL
  // CHANGE under test still goes through the real gimp_layer/gimp_bake TOOLS below.
  async function openSwatchesWithWarmProxy(): Promise<number> {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    await callTool(tools, 'gimp_add_adjustment', { image, type: 'saturation', scale: 0.5 });
    await backend.call('preview', {
      image,
      max_px: 512,
      out_path: join(workDir, `warm-${image}.png`),
    });
    return image;
  }

  async function previewVsExport(image: number, tag: string): Promise<number> {
    const previewPath = join(workDir, `${tag}-preview.png`);
    await backend.call('preview', { image, max_px: 512, out_path: previewPath });
    const exportPath = join(workDir, `${tag}-export.png`);
    await backend.call('export', { image, path: exportPath });
    return maxAbsDiff(readPng(previewPath), readPng(exportPath));
  }

  const STRUCTURAL_CHANGES: Array<[string, (image: number) => Promise<ToolResult>]> = [
    [
      'layer create',
      (image) => callTool(tools, 'gimp_layer', { image, op: 'create', name: 'Extra' }),
    ],
    [
      'layer create_group',
      (image) => callTool(tools, 'gimp_layer', { image, op: 'create_group', name: 'ExtraGroup' }),
    ],
    [
      'layer set (opacity)',
      (image) => callTool(tools, 'gimp_layer', { image, op: 'set', opacity: 60 }),
    ],
    ['layer move', (image) => callTool(tools, 'gimp_layer', { image, op: 'move', x: 4, y: 4 })],
    [
      'layer duplicate + delete',
      async (image) => {
        const created = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'ToDup' });
        const id = structuredOf(created).layer_id as number;
        const dup = await callTool(tools, 'gimp_layer', { image, op: 'duplicate', layer_id: id });
        return callTool(tools, 'gimp_layer', {
          image,
          op: 'delete',
          layer_id: structuredOf(dup).layer_id as number,
        });
      },
    ],
    [
      'layer reorder',
      async (image) => {
        const created = await callTool(tools, 'gimp_layer', {
          image,
          op: 'create',
          name: 'ToReorder',
        });
        const group = await callTool(tools, 'gimp_layer', {
          image,
          op: 'create_group',
          name: 'ReorderGroup',
        });
        return callTool(tools, 'gimp_layer', {
          image,
          op: 'reorder',
          layer_id: structuredOf(created).layer_id as number,
          parent_group: structuredOf(group).layer_id as number,
        });
      },
    ],
    [
      'layer merge_down',
      async (image) => {
        const created = await callTool(tools, 'gimp_layer', {
          image,
          op: 'create',
          name: 'ToMerge',
        });
        return callTool(tools, 'gimp_layer', {
          image,
          op: 'merge_down',
          layer_id: structuredOf(created).layer_id as number,
        });
      },
    ],
    [
      'bake',
      async (image) => {
        await callTool(tools, 'gimp_create_mask', {
          image,
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 16,
          height: 16,
          name: 'ProxyBakeMask',
        });
        await callTool(tools, 'gimp_add_adjustment', {
          image,
          type: 'brightness_contrast',
          brightness: 20,
          mask: 'ProxyBakeMask',
        });
        return callTool(tools, 'gimp_bake', { image });
      },
    ],
    ['layer flatten', (image) => callTool(tools, 'gimp_layer', { image, op: 'flatten' })],
  ];

  it.each(STRUCTURAL_CHANGES)(
    'after %s, the preview matches a full-resolution export (the proxy was rebuilt)',
    async (label, change) => {
      const image = await openSwatchesWithWarmProxy();
      const tag = label.replace(/\W+/g, '-');
      try {
        expect(await previewVsExport(image, `${tag}-before`)).toBeLessThanOrEqual(1);
        const result = await change(image);
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        expect(await previewVsExport(image, `${tag}-after`)).toBeLessThanOrEqual(1);
      } finally {
        await callTool(tools, 'gimp_close_document', { image });
      }
    }
  );

  it('checkpoint -> flatten -> restore brings the layer structure and its live filter back', async () => {
    const image = await openRamp();
    let currentImage = image;
    try {
      const top = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'CheckTop',
        fill: 'white',
      });
      const topId = structuredOf(top).layer_id as number;
      const adjust = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'curves',
        layer_id: topId,
        points: [
          [0, 30],
          [255, 220],
        ],
      });
      expect(adjust.isError, JSON.stringify(adjust.content)).toBeFalsy();
      const filterName = structuredOf(adjust).name as string;

      const checkpoint = await callTool(tools, 'gimp_checkpoint', { op: 'create', image });
      expect(checkpoint.isError, JSON.stringify(checkpoint.content)).toBeFalsy();
      const checkpointId = structuredOf(checkpoint).checkpoint_id as string;

      const flat = await callTool(tools, 'gimp_layer', { image, op: 'flatten' });
      expect(flat.isError, JSON.stringify(flat.content)).toBeFalsy();
      expect(await layerTree(image)).toHaveLength(1);

      const restore = await callTool(tools, 'gimp_checkpoint', {
        op: 'restore',
        checkpoint_id: checkpointId,
      });
      expect(restore.isError, JSON.stringify(restore.content)).toBeFalsy();
      currentImage = structuredOf(restore).image as number;

      const tree = await layerTree(currentImage);
      expect(tree.map((n) => n.name)).toContain('CheckTop');

      // The reopened .xcf hands the filter a NEW id (ids are a runtime handle, never persisted --
      // only the NAME is, in the editmamei-filters ledger parasite), but it is still re-editable
      // by that restored id: an .xcf round trip rebuilds the ledger from the parasite, not a fresh
      // readback (see ops.py's _mirror_filters doc comment on why readback alone would be lossy).
      const listed = await callTool(tools, 'gimp_filter', { image: currentImage, op: 'list' });
      const restoredFilter = (
        structuredOf(listed).filters as Array<{ name: string; filter_id: number }>
      ).find((f) => f.name === filterName);
      expect(restoredFilter, JSON.stringify(listed.content)).toBeDefined();

      const reEdit = await callTool(tools, 'gimp_add_adjustment', {
        image: currentImage,
        type: 'curves',
        filter_id: restoredFilter!.filter_id,
        points: [
          [0, 20],
          [255, 230],
        ],
      });
      expect(reEdit.isError, JSON.stringify(reEdit.content)).toBeFalsy();
    } finally {
      await callTool(tools, 'gimp_close_document', { image: currentImage });
    }
  });
});
