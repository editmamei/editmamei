/**
 * gimp_layer / gimp_bake against real headless GIMP, driven through the actual tool handlers and a
 * real `GimpBackend`/`GimpSession` — the same "drive the TOOLS, not the bridge" posture
 * `checkpoint.live.test.ts` takes (gimp_checkpoint sits alongside gimp_layer here since one test
 * exercises checkpoint -> flatten -> restore for the layer structure and its live filter).
 *
 * Verified-live assumptions this file pins as regression tests (see `bridge/ops.py`'s own
 * "layer management" section comment for the full probe record):
 *  - `layer.copy()` copies a layer's live filters under the SAME names, so `duplicate` refuses
 *    outright when the source (or, for a group, any descendant) carries an Editmamei filter.
 *  - `Item.set_offsets` is an ABSOLUTE move that does not carry a masked filter's confinement with
 *    it — `move` refuses under the same conditions gimp_transform_canvas already does.
 *  - `Image.merge_down` merges into the first VISIBLE layer below (a hidden one in between is
 *    skipped, not merged) and refuses on a group target or no visible target at all.
 *  - `Image.merge_down` / `Image.flatten` both bake every live filter they touch into real pixels
 *    first, masked ones included, correctly confined; flatten discards every hidden layer outright
 *    and refuses by default rather than doing that silently.
 *  - `Drawable.merge_filters()` (gimp_bake) bakes a masked filter into a layer's own pixels
 *    exactly, without merging it into anything else, and never rasterizes a text layer.
 *  - Every structural op drops the preview-proxy cache (the rewritten invariant at the top of
 *    `ops.py`'s PROXIES comment) — the "structural-op proxy matrix" below pins it directly.
 *  - Every refusal below leaves the document provably unchanged (its full layer tree, offsets
 *    included, compared before/after).
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
import { createGimpEffectTools } from '@editmamei/tools/gimp-effect-tools.ts';
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

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (layers)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

interface LayerNode {
  layer_id: number;
  name: string;
  opacity: number;
  mode: string;
  visible: boolean;
  offsets: { x: number | null; y: number | null };
  has_alpha: boolean;
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
    // opsPyPath: TEST_OPS_PY -- adds test_add_text_layer, used below.
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

  /** Full layer tree (ids, names, offsets, opacity/mode/visible, nesting) -- used to prove a
   * refused op left the document provably untouched, not just that it returned isError. */
  async function snapshot(image: number): Promise<LayerNode[]> {
    return layerTree(image);
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

  // ---- Q4: refusals leave the document provably unchanged -----------------------------------

  it('reorder refuses to nest a group inside itself, or inside its own DESCENDANT, leaving the tree unchanged', async () => {
    const image = await openRamp();
    try {
      const outer = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'SelfOuter',
      });
      const outerId = structuredOf(outer).layer_id as number;
      const inner = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'SelfInner',
      });
      const innerId = structuredOf(inner).layer_id as number;
      const nestIn = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: innerId,
        parent_group: outerId,
      });
      expect(nestIn.isError, JSON.stringify(nestIn.content)).toBeFalsy();

      const before = await snapshot(image);
      const intoSelf = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: outerId,
        parent_group: outerId,
      });
      expect(intoSelf.isError).toBe(true);
      const intoDescendant = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: outerId,
        parent_group: innerId,
      });
      expect(intoDescendant.isError).toBe(true);
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('duplicate refuses when the layer carries an Editmamei filter, and image is unchanged', async () => {
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

      const before = await snapshot(image);
      const dup = await callTool(tools, 'gimp_layer', { image, op: 'duplicate' });
      expect(dup.isError).toBe(true);
      const text = (dup.content?.[0] as { text: string }).text;
      expect(text).toContain('DrawableFilter.set_name');
      expect(text).toContain('Editmamei filter');
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('duplicate refuses a GROUP whose DESCENDANT (not itself) carries a filter, and image is unchanged', async () => {
    const image = await openRamp();
    try {
      const group = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'DupGroup',
      });
      const groupId = structuredOf(group).layer_id as number;
      const child = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'DupChild',
        parent_group: groupId,
      });
      const childId = structuredOf(child).layer_id as number;
      const adjust = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'curves',
        layer_id: childId,
        points: [
          [0, 5],
          [255, 250],
        ],
      });
      expect(adjust.isError, JSON.stringify(adjust.content)).toBeFalsy();

      const before = await snapshot(image);
      const dup = await callTool(tools, 'gimp_layer', {
        image,
        op: 'duplicate',
        layer_id: groupId,
      });
      expect(dup.isError).toBe(true);
      expect((dup.content?.[0] as { text: string }).text).toContain('Editmamei filter');
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('a layer_id from a DIFFERENT open image is refused, and neither image changes', async () => {
    const imageA = await openRamp();
    const imageB = await openRamp();
    try {
      const layerB = await callTool(tools, 'gimp_layer', {
        image: imageB,
        op: 'create',
        name: 'FromB',
      });
      const layerBId = structuredOf(layerB).layer_id as number;

      const beforeA = await snapshot(imageA);
      const beforeB = await snapshot(imageB);
      const crossed = await callTool(tools, 'gimp_layer', {
        image: imageA,
        op: 'set',
        layer_id: layerBId,
        opacity: 40,
      });
      expect(crossed.isError).toBe(true);
      expect(await snapshot(imageA)).toEqual(beforeA);
      expect(await snapshot(imageB)).toEqual(beforeB);
    } finally {
      await callTool(tools, 'gimp_close_document', { image: imageA });
      await callTool(tools, 'gimp_close_document', { image: imageB });
    }
  });

  it('a parent_group that is not a group is refused, and image is unchanged', async () => {
    const image = await openRamp();
    try {
      const plain = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'NotAGroup' });
      const plainId = structuredOf(plain).layer_id as number;
      const target = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'Target' });
      const targetId = structuredOf(target).layer_id as number;

      const before = await snapshot(image);
      const result = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: plainId,
        parent_group: targetId,
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('not a group layer');
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('merge_down refuses a GROUP target and refuses the LAST (bottommost) layer, image unchanged either way', async () => {
    const image = await openRamp();
    try {
      await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'MergeTargetGroup',
      });
      const top = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'MergeOntoGroup',
      });
      const topId = structuredOf(top).layer_id as number;

      const beforeGroupCase = await snapshot(image);
      const ontoGroup = await callTool(tools, 'gimp_layer', {
        image,
        op: 'merge_down',
        layer_id: topId,
      });
      expect(ontoGroup.isError).toBe(true);
      expect((ontoGroup.content?.[0] as { text: string }).text).toContain(
        'cannot merge a layer into a group'
      );
      expect(await snapshot(image)).toEqual(beforeGroupCase);

      // Now the bottommost layer of the image (Background, from the ramp fixture) has nothing
      // below it at all.
      const beforeBottomCase = await snapshot(image);
      const onBottom = await callTool(tools, 'gimp_layer', {
        image,
        op: 'merge_down',
        layer: 'Background',
      });
      expect(onBottom.isError).toBe(true);
      expect((onBottom.content?.[0] as { text: string }).text).toContain('no VISIBLE layer below');
      expect(await snapshot(image)).toEqual(beforeBottomCase);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('bake refuses a group target directly, and image is unchanged', async () => {
    const image = await openRamp();
    try {
      const group = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'BakeTargetGroup',
      });
      const groupId = structuredOf(group).layer_id as number;
      const before = await snapshot(image);
      const baked = await callTool(tools, 'gimp_bake', { image, layer_id: groupId });
      expect(baked.isError).toBe(true);
      expect((baked.content?.[0] as { text: string }).text).toContain('is a group');
      expect(await snapshot(image)).toEqual(before);
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

  it('move refuses when the layer carries a masked filter (image unchanged); baking clears the refusal', async () => {
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
      const before = await snapshot(image);
      const refused = await callTool(tools, 'gimp_layer', { image, op: 'move', x: 5, y: 5 });
      expect(refused.isError).toBe(true);
      expect((refused.content?.[0] as { text: string }).text).toContain('masked adjustment');
      expect(await snapshot(image)).toEqual(before);

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

  it('merge_down skips a HIDDEN layer in between and merges into the first VISIBLE layer below (B6)', async () => {
    const image = await openRamp();
    try {
      const hidden = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'HiddenMiddle',
        fill: 'black',
      });
      const hiddenId = structuredOf(hidden).layer_id as number;
      await callTool(tools, 'gimp_layer', { image, op: 'set', layer_id: hiddenId, visible: false });
      const top = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'TopForSkip',
        fill: 'white',
      });
      const topId = structuredOf(top).layer_id as number;

      const merged = await callTool(tools, 'gimp_layer', {
        image,
        op: 'merge_down',
        layer_id: topId,
      });
      expect(merged.isError, JSON.stringify(merged.content)).toBeFalsy();
      // Merged into Background (the first VISIBLE layer below TopForSkip), not HiddenMiddle.
      expect(structuredOf(merged).name).toBe('Background');

      const tree = await layerTree(image);
      // HiddenMiddle survives, untouched, still hidden -- it was skipped, not merged or removed.
      const survivor = tree.find((n) => n.layer_id === hiddenId);
      expect(survivor).toMatchObject({ name: 'HiddenMiddle', visible: false });
      expect(tree.some((n) => n.layer_id === topId)).toBe(false);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('flatten refuses by default when a layer is hidden, and discard_hidden: true proceeds and reports it (B7)', async () => {
    const image = await openRamp();
    try {
      const hidden = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'FlattenHidden',
      });
      const hiddenId = structuredOf(hidden).layer_id as number;
      await callTool(tools, 'gimp_layer', { image, op: 'set', layer_id: hiddenId, visible: false });

      const before = await snapshot(image);
      const refused = await callTool(tools, 'gimp_layer', { image, op: 'flatten' });
      expect(refused.isError).toBe(true);
      expect((refused.content?.[0] as { text: string }).text).toContain('FlattenHidden');
      expect(await snapshot(image)).toEqual(before);

      const flattened = await callTool(tools, 'gimp_layer', {
        image,
        op: 'flatten',
        discard_hidden: true,
      });
      expect(flattened.isError, JSON.stringify(flattened.content)).toBeFalsy();
      const discarded = structuredOf(flattened).discarded_hidden_layers as Array<{
        layer_id: number;
        name: string;
      }>;
      expect(discarded).toEqual([{ layer_id: hiddenId, name: 'FlattenHidden' }]);
      expect(await layerTree(image)).toHaveLength(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('flatten collapses to one layer, drops alpha, rasterizes a VISIBLE text layer, and prunes the ledger', async () => {
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

  // ---- Q3: a text layer carrying a live filter, through merge_down and through flatten ---------

  it('a text layer carrying a live filter merges down correctly: baked, rasterized, ledger clean (Q3)', async () => {
    const image = await openRamp();
    try {
      const text = await backend.call<{ layer_id: number; name: string }>('test_add_text_layer', {
        image,
        text: 'Q3',
      });
      const adjust = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'curves',
        layer_id: text.layer_id,
        points: [
          [0, 30],
          [255, 220],
        ],
      });
      expect(adjust.isError, JSON.stringify(adjust.content)).toBeFalsy();

      const merged = await callTool(tools, 'gimp_layer', {
        image,
        op: 'merge_down',
        layer_id: text.layer_id,
      });
      expect(merged.isError, JSON.stringify(merged.content)).toBeFalsy();
      expect(structuredOf(merged).rasterized_text).toBe(true);

      const tree = await layerTree(image);
      expect(tree.some((n) => n.is_text_layer)).toBe(false);
      const listAfter = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      expect(structuredOf(listAfter).filters).toEqual([]);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('a text layer carrying a live filter flattens correctly: baked, rasterized, ledger clean (Q3)', async () => {
    const image = await openRamp();
    try {
      const text = await backend.call<{ layer_id: number; name: string }>('test_add_text_layer', {
        image,
        text: 'Q3b',
      });
      const adjust = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'curves',
        layer_id: text.layer_id,
        points: [
          [0, 30],
          [255, 220],
        ],
      });
      expect(adjust.isError, JSON.stringify(adjust.content)).toBeFalsy();

      const flat = await callTool(tools, 'gimp_layer', { image, op: 'flatten' });
      expect(flat.isError, JSON.stringify(flat.content)).toBeFalsy();
      expect(structuredOf(flat).rasterized_text).toBe(true);

      const tree = await layerTree(image);
      expect(tree).toHaveLength(1);
      expect(tree[0]!.is_text_layer).toBe(false);
      const listAfter = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      expect(structuredOf(listAfter).filters).toEqual([]);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  // ---- Q2: deleting a non-empty group prunes exactly its own descendants' ledger records --------

  it("delete on a non-empty group prunes exactly its descendants' ledger records; a sibling filter survives (Q2)", async () => {
    const image = await openRamp();
    try {
      const group = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'DeleteGroup',
      });
      const groupId = structuredOf(group).layer_id as number;
      const child = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'DeleteChild',
        parent_group: groupId,
      });
      const childId = structuredOf(child).layer_id as number;
      const inGroupAdjust = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'curves',
        layer_id: childId,
        points: [
          [0, 10],
          [255, 245],
        ],
      });
      expect(inGroupAdjust.isError, JSON.stringify(inGroupAdjust.content)).toBeFalsy();
      const inGroupFilterName = structuredOf(inGroupAdjust).name as string;

      // A sibling filter, OUTSIDE the group, must survive the group's deletion untouched. Named
      // explicitly by layer: creating DeleteChild left IT selected, not Background, and
      // gimp_add_adjustment defaults to the selected layer when none is named.
      const siblingAdjust = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'saturation',
        scale: 0.7,
        layer: 'Background',
      });
      expect(siblingAdjust.isError, JSON.stringify(siblingAdjust.content)).toBeFalsy();
      const siblingFilterName = structuredOf(siblingAdjust).name as string;

      const deleted = await callTool(tools, 'gimp_layer', {
        image,
        op: 'delete',
        layer_id: groupId,
      });
      expect(deleted.isError, JSON.stringify(deleted.content)).toBeFalsy();

      const tree = await layerTree(image);
      expect(tree.some((n) => n.layer_id === groupId)).toBe(false);

      const listAfter = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      const namesAfter = (structuredOf(listAfter).filters as Array<{ name: string }>).map(
        (f) => f.name
      );
      expect(namesAfter).not.toContain(inGroupFilterName);
      expect(namesAfter).toContain(siblingFilterName);

      // The surviving sibling filter still renders correctly after the group's deletion: the
      // preview (proxy) agrees exactly with a full-resolution export, proving the proxy was
      // rebuilt rather than left stale from before the delete.
      const afterPath = join(workDir, 'delete-group-after.png');
      await callTool(tools, 'gimp_export', { image, file_path: afterPath });
      const after = readPng(afterPath);
      const previewPath = join(workDir, 'delete-group-preview.png');
      await backend.call('preview', { image, max_px: 512, out_path: previewPath });
      expect(maxAbsDiff(readPng(previewPath), after)).toBeLessThanOrEqual(1);
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

  it('bake all: true reports a group that carries its own filter under skipped_groups_with_filters (B9)', async () => {
    const image = await openRamp();
    try {
      const group = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'FilterCarryingGroup',
      });
      const groupId = structuredOf(group).layer_id as number;
      const onGroup = await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'curves',
        layer: 'FilterCarryingGroup',
        points: [
          [0, 0],
          [255, 255],
        ],
      });
      expect(onGroup.isError, JSON.stringify(onGroup.content)).toBeFalsy();

      const bakedAll = await callTool(tools, 'gimp_bake', { image, all: true });
      expect(bakedAll.isError, JSON.stringify(bakedAll.content)).toBeFalsy();
      const skipped = structuredOf(bakedAll).skipped_groups_with_filters as Array<{
        layer_id: number;
        name: string;
      }>;
      expect(skipped).toEqual([{ layer_id: groupId, name: 'FilterCarryingGroup' }]);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  // ---- permanent regression coverage for the smoke-probed QA fixes (S1-S3, B4, B8, B10, B16, B17)
  //
  // B5 (_assert_layer_attached walks the live tree instead of trusting Item.get_image()) has no
  // separate case here: every create/create_group/duplicate test above already exercises its
  // SUCCESS path (the returned layer_id must appear in gimp_inspect's own tree), and there is no
  // way to force GIMP to silently fail an insert from a live test -- that would need mocking GIMP
  // itself, which is what the fake-session unit tests are for. Covered implicitly.

  it('create refuses over the size cap (S1), image unchanged', async () => {
    const image = await openRamp();
    try {
      const before = await snapshot(image);
      const oversized = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        width: 40_000,
        height: 40_000,
      });
      expect(oversized.isError).toBe(true);
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('move refuses beyond the offset bound (S2), image unchanged', async () => {
    const image = await openRamp();
    try {
      const before = await snapshot(image);
      const tooFar = await callTool(tools, 'gimp_layer', { image, op: 'move', x: 999_999, y: 0 });
      expect(tooFar.isError).toBe(true);
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('merge_down refuses when the merged union bbox would exceed the size cap (S2), image unchanged', async () => {
    const image = await openRamp();
    try {
      const extra = await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'FarExtra' });
      const extraId = structuredOf(extra).layer_id as number;
      // Within move's own bound (canvas width + MAX_RESIZE_SIDE_PX = 64 + 30000), but far enough
      // that merging it with Background's own 0..64 extent unions to a width over 30000px.
      const moved = await callTool(tools, 'gimp_layer', {
        image,
        op: 'move',
        layer_id: extraId,
        x: 30_000,
        y: 0,
      });
      expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();

      const before = await snapshot(image);
      const merged = await callTool(tools, 'gimp_layer', {
        image,
        op: 'merge_down',
        layer_id: extraId,
      });
      expect(merged.isError).toBe(true);
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('a preview-proxy image id is refused as an `image` argument (S3)', async () => {
    const image = await openRamp();
    try {
      await backend.call('preview', {
        image,
        max_px: 512,
        out_path: join(workDir, 's3-warm.png'),
      });
      const documents = await callTool(tools, 'gimp_inspect', { what: 'documents' });
      expect(documents.isError, JSON.stringify(documents.content)).toBeFalsy();
      const ids = (structuredOf(documents).documents as Array<{ image: number }>).map(
        (d) => d.image
      );
      const proxyId = ids.find((id) => id !== image);
      expect(
        proxyId,
        `expected a second (proxy) image id alongside ${image}; got ${JSON.stringify(ids)}`
      ).toBeDefined();

      const result = await callTool(tools, 'gimp_layer', {
        image: proxyId,
        op: 'create',
        name: 'ShouldNotAttach',
      });
      expect(result.isError).toBe(true);
      expect((result.content?.[0] as { text: string }).text).toContain('no open image');
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('create on a grayscale image gives a GRAYA layer; indexed is refused (B4)', async () => {
    const gray = await backend.call<{ image: number }>('test_new_image', { base_type: 'gray' });
    try {
      const created = await callTool(tools, 'gimp_layer', {
        image: gray.image,
        op: 'create',
        name: 'GrayLayer',
      });
      expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
      const tree = await layerTree(gray.image);
      const node = tree.find((n) => n.layer_id === structuredOf(created).layer_id);
      expect(node?.has_alpha).toBe(true);
      // gimp_inspect doesn't report the raw GEGL layer type, but a GRAYA layer on a GRAY image
      // exports and previews without error, which an RGBA-on-GRAY mismatch would not survive
      // silently -- confirms the create path picked a type GIMP actually accepted for this image.
      const exportPath = join(workDir, 'b4-gray-export.png');
      const exported = await callTool(tools, 'gimp_export', {
        image: gray.image,
        file_path: exportPath,
      });
      expect(exported.isError, JSON.stringify(exported.content)).toBeFalsy();
    } finally {
      await callTool(tools, 'gimp_close_document', { image: gray.image });
    }

    const indexed = await backend.call<{ image: number }>('test_new_image', {
      base_type: 'indexed',
    });
    try {
      const refused = await callTool(tools, 'gimp_layer', {
        image: indexed.image,
        op: 'create',
        name: 'IndexedLayer',
      });
      expect(refused.isError).toBe(true);
      expect((refused.content?.[0] as { text: string }).text).toContain('indexed');
    } finally {
      await callTool(tools, 'gimp_close_document', { image: indexed.image });
    }
  });

  it("delete refuses the image's last remaining layer (B8), image unchanged", async () => {
    const image = await openRamp();
    try {
      const before = await snapshot(image);
      const result = await callTool(tools, 'gimp_layer', {
        image,
        op: 'delete',
        layer: 'Background',
      });
      expect(result.isError).toBe(true);
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('the (name, is_group) structural guard trips on a proxy left stale by a fixture reorder (B10)', async () => {
    const image = await openRamp();
    try {
      await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'GuardA' });
      await callTool(tools, 'gimp_layer', { image, op: 'create', name: 'GuardB' });
      // Warm the proxy against the CURRENT (pre-swap) structure.
      await backend.call('preview', {
        image,
        max_px: 512,
        out_path: join(workDir, 'b10-warm.png'),
      });
      // Reorder the live document WITHOUT going through gimp_layer (so _drop_proxies never runs) --
      // simulates a future op that forgets the invariant, which the guard exists to catch.
      await backend.call('test_reorder_without_dropping_proxy', { image });
      await expect(
        backend.call('preview', { image, max_px: 512, out_path: join(workDir, 'b10-stale.png') })
      ).rejects.toMatchObject({
        message: expect.stringContaining('drifted from the document'),
      });
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('set refuses an empty name (B16), image unchanged', async () => {
    const image = await openRamp();
    try {
      const before = await snapshot(image);
      const result = await callTool(tools, 'gimp_layer', { image, op: 'set', name: '   ' });
      expect(result.isError).toBe(true);
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('create refuses a negative position (B17), image unchanged', async () => {
    const image = await openRamp();
    try {
      const before = await snapshot(image);
      const result = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'NegativePosition',
        position: -1,
      });
      expect(result.isError).toBe(true);
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  // ---- gimp_layer/gimp_bake treat a gimp_add_effect filter exactly like any other ledgered
  // filter -- both dispatch through the SAME _apply_filter/ledger/_all_layers machinery, so none
  // of this section is new bridge behaviour; it exists to prove that generic treatment actually
  // holds for the effect family too, not just gimp_add_adjustment's own filters.

  it('move with a vignette effect present keeps the vignette locked to the LAYER content, not the canvas', async () => {
    // The ramp fixture is 64x64 with one layer the same size as the canvas -- moving it by (dx,
    // dy) shifts what the canvas shows at every point (a plain, expected consequence of moving a
    // same-size layer, nothing to do with the vignette), so comparing the two WHOLE-CANVAS exports
    // directly would always show a large diff regardless of correctness. What actually matters --
    // vignette center/radius are fractions of the LAYER's own extent, unaffected by a canvas-level
    // offset -- is that canvas pixel (x, y) BEFORE the move equals canvas pixel (x+dx, y+dy) AFTER
    // it, for any (x, y) that stays on-canvas both ways: the layer's rendered CONTENT simply slid
    // over, unchanged.
    const image = await openRamp();
    try {
      const effect = await callTool(tools, 'gimp_add_effect', { image, type: 'vignette' });
      expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();

      const beforePath = join(workDir, 'vignette-move-before.png');
      await callTool(tools, 'gimp_export', { image, file_path: beforePath });
      const before = readPng(beforePath);

      const dx = 5;
      const dy = 5;
      const moved = await callTool(tools, 'gimp_layer', { image, op: 'move', x: dx, y: dy });
      expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();

      const afterPath = join(workDir, 'vignette-move-after.png');
      await callTool(tools, 'gimp_export', { image, file_path: afterPath });
      const after = readPng(afterPath);

      for (const [x, y] of [
        [2, 2],
        [32, 32],
        [10, 50],
        [50, 10],
        [58, 58],
      ]) {
        expect(pixelAt(after, x! + dx, y! + dy)).toEqual(pixelAt(before, x!, y!));
      }
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('duplicate refuses a layer carrying a gimp_add_effect filter, the same as an adjustment filter', async () => {
    const image = await openRamp();
    try {
      const effect = await callTool(tools, 'gimp_add_effect', { image, type: 'black_white' });
      expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
      const before = await snapshot(image);

      const dup = await callTool(tools, 'gimp_layer', { image, op: 'duplicate' });
      expect(dup.isError).toBe(true);
      expect((dup.content?.[0] as { text: string }).text).toContain('Editmamei filter');
      expect(await snapshot(image)).toEqual(before);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('merge_down, flatten, and bake each remove an effect filter ledger record like any other', async () => {
    async function ledgerNames(image: number): Promise<string[]> {
      const listed = await callTool(tools, 'gimp_filter', { image, op: 'list' });
      return (structuredOf(listed).filters as Array<{ name: string }>).map((f) => f.name);
    }

    // merge_down
    const mergeImage = await openRamp();
    try {
      const top = await callTool(tools, 'gimp_layer', {
        image: mergeImage,
        op: 'create',
        name: 'EffectMergeTop',
      });
      const topId = structuredOf(top).layer_id as number;
      const effect = await callTool(tools, 'gimp_add_effect', {
        image: mergeImage,
        type: 'add_noise',
        layer: 'EffectMergeTop',
      });
      expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
      expect(await ledgerNames(mergeImage)).toContain(structuredOf(effect).name as string);
      const merged = await callTool(tools, 'gimp_layer', {
        image: mergeImage,
        op: 'merge_down',
        layer_id: topId,
      });
      expect(merged.isError, JSON.stringify(merged.content)).toBeFalsy();
      expect(await ledgerNames(mergeImage)).toEqual([]);
    } finally {
      await callTool(tools, 'gimp_close_document', { image: mergeImage });
    }

    // flatten
    const flattenImage = await openRamp();
    try {
      const effect = await callTool(tools, 'gimp_add_effect', {
        image: flattenImage,
        type: 'motion_blur',
      });
      expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
      const flattened = await callTool(tools, 'gimp_layer', { image: flattenImage, op: 'flatten' });
      expect(flattened.isError, JSON.stringify(flattened.content)).toBeFalsy();
      expect(await ledgerNames(flattenImage)).toEqual([]);
    } finally {
      await callTool(tools, 'gimp_close_document', { image: flattenImage });
    }

    // bake
    const bakeImage = await openRamp();
    try {
      const effect = await callTool(tools, 'gimp_add_effect', {
        image: bakeImage,
        type: 'vignette',
      });
      expect(effect.isError, JSON.stringify(effect.content)).toBeFalsy();
      const baked = await callTool(tools, 'gimp_bake', { image: bakeImage });
      expect(baked.isError, JSON.stringify(baked.content)).toBeFalsy();
      expect(structuredOf(baked).baked).toBe(true);
      expect(await ledgerNames(bakeImage)).toEqual([]);
    } finally {
      await callTool(tools, 'gimp_close_document', { image: bakeImage });
    }
  });

  // ---- Q1/Q6: the structural-op proxy matrix -----------------------------------------------
  //
  // Every gimp_layer sub-op except select, and gimp_bake, must drop the preview-proxy cache (the
  // rewritten ops.py PROXIES invariant). Each case below does its own SETUP first, warms the
  // proxy AFTER that setup is in place, then performs ONLY the one op under test -- so a preview
  // taken right after warming already reflects the full pre-op state, and any staleness the op
  // itself should have invalidated is what the after-op comparison actually exercises. Content is
  // chosen so a stale (un-rebuilt) proxy would visibly mismatch a fresh full-resolution export,
  // not just differ by rounding.
  //
  // gimp_get_preview (the TOOL) always renders JPEG -- fine for a human to look at, but lossy and
  // undecodable by this suite's PNG-only reader, so the proxy-vs-export comparison itself goes
  // straight through `backend.call('preview'/'export', ...)` with an explicit `.png` out_path,
  // the same route geometry-and-masks.live.test.ts's own `previewVsExport` uses. The STRUCTURAL
  // CHANGE under test still goes through the real gimp_layer/gimp_bake TOOLS.

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

  it('proxy matrix: a count-preserving REORDER that swaps two layers carrying DIFFERENT filters does not mis-attach either filter', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      // Setup FIRST: two opaque, full-canvas layers with markedly different content -- if a stale
      // proxy kept the PRE-swap arrangement, the composite would visibly show the wrong one on top.
      const swapTop = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'SwapTop',
        fill: 'white',
      });
      const swapTopId = structuredOf(swapTop).layer_id as number;
      await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'brightness_contrast',
        brightness: -70,
        layer_id: swapTopId,
      });
      const swapBottom = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'SwapBottom',
        fill: 'black',
      });
      const swapBottomId = structuredOf(swapBottom).layer_id as number;
      await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'brightness_contrast',
        brightness: 70,
        layer_id: swapBottomId,
      });

      await warmProxy(image);
      expect(await previewVsExport(image, 'reorder-swap-before')).toBeLessThanOrEqual(1);

      // ONLY the swap: bring SwapBottom above SwapTop, same top-level, same layer COUNT.
      const swapped = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: swapBottomId,
        position: 0,
      });
      expect(swapped.isError, JSON.stringify(swapped.content)).toBeFalsy();

      expect(await previewVsExport(image, 'reorder-swap-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: a count-preserving BAKE rebuilds the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
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
        brightness: 40,
        mask: 'ProxyBakeMask',
      });
      await warmProxy(image);
      expect(await previewVsExport(image, 'bake-before')).toBeLessThanOrEqual(1);

      const baked = await callTool(tools, 'gimp_bake', { image });
      expect(baked.isError, JSON.stringify(baked.content)).toBeFalsy();

      expect(await previewVsExport(image, 'bake-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: MERGE_DOWN rebuilds the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      const extra = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'ProxyMergeExtra',
        fill: 'white',
      });
      const extraId = structuredOf(extra).layer_id as number;
      await callTool(tools, 'gimp_add_adjustment', {
        image,
        type: 'brightness_contrast',
        brightness: -30,
        layer_id: extraId,
      });
      await warmProxy(image);
      expect(await previewVsExport(image, 'merge-proxy-before')).toBeLessThanOrEqual(1);

      const merged = await callTool(tools, 'gimp_layer', {
        image,
        op: 'merge_down',
        layer_id: extraId,
      });
      expect(merged.isError, JSON.stringify(merged.content)).toBeFalsy();

      expect(await previewVsExport(image, 'merge-proxy-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: DUPLICATE rebuilds the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      const created = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'ProxyDupTarget',
        fill: 'white',
      });
      const id = structuredOf(created).layer_id as number;
      await warmProxy(image);
      expect(await previewVsExport(image, 'dup-proxy-before')).toBeLessThanOrEqual(1);

      const dup = await callTool(tools, 'gimp_layer', { image, op: 'duplicate', layer_id: id });
      expect(dup.isError, JSON.stringify(dup.content)).toBeFalsy();

      expect(await previewVsExport(image, 'dup-proxy-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: DELETE rebuilds the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      const created = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'ProxyDeleteTarget',
        fill: 'black',
      });
      const id = structuredOf(created).layer_id as number;
      await warmProxy(image);
      expect(await previewVsExport(image, 'delete-proxy-before')).toBeLessThanOrEqual(1);

      const deleted = await callTool(tools, 'gimp_layer', { image, op: 'delete', layer_id: id });
      expect(deleted.isError, JSON.stringify(deleted.content)).toBeFalsy();

      expect(await previewVsExport(image, 'delete-proxy-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: SET visible rebuilds the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      const created = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'ProxySetVisible',
        fill: 'white',
      });
      const id = structuredOf(created).layer_id as number;
      await warmProxy(image);
      expect(await previewVsExport(image, 'set-visible-before')).toBeLessThanOrEqual(1);

      const hidden = await callTool(tools, 'gimp_layer', {
        image,
        op: 'set',
        layer_id: id,
        visible: false,
      });
      expect(hidden.isError, JSON.stringify(hidden.content)).toBeFalsy();

      expect(await previewVsExport(image, 'set-visible-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: SET mode rebuilds the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      const created = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'ProxySetMode',
        fill: 'white',
      });
      const id = structuredOf(created).layer_id as number;
      await callTool(tools, 'gimp_layer', { image, op: 'set', layer_id: id, opacity: 60 });
      await warmProxy(image);
      expect(await previewVsExport(image, 'set-mode-before')).toBeLessThanOrEqual(1);

      const modeChanged = await callTool(tools, 'gimp_layer', {
        image,
        op: 'set',
        layer_id: id,
        mode: 'multiply',
      });
      expect(modeChanged.isError, JSON.stringify(modeChanged.content)).toBeFalsy();

      expect(await previewVsExport(image, 'set-mode-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: SET name rebuilds the proxy (the internal structure-shape guard would otherwise fire)', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      const created = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'ProxySetName',
      });
      const id = structuredOf(created).layer_id as number;
      await warmProxy(image);
      expect(await previewVsExport(image, 'set-name-before')).toBeLessThanOrEqual(1);

      const renamed = await callTool(tools, 'gimp_layer', {
        image,
        op: 'set',
        layer_id: id,
        name: 'ProxySetNameRenamed',
      });
      expect(renamed.isError, JSON.stringify(renamed.content)).toBeFalsy();

      // A stale proxy here would fail LOUDLY (ops.py's _mirror_filters structure-shape guard
      // compares (name, is_group) at every position) rather than silently mismatch pixels -- this
      // call rejecting at all is itself the failure mode this test exists to catch.
      expect(await previewVsExport(image, 'set-name-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: CREATE, CREATE_GROUP, MOVE, and REORDER-into-a-group each rebuild the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      await callTool(tools, 'gimp_add_adjustment', { image, type: 'saturation', scale: 0.5 });
      await warmProxy(image);
      expect(await previewVsExport(image, 'create-before')).toBeLessThanOrEqual(1);

      const created = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create',
        name: 'MatrixExtra',
      });
      expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
      expect(await previewVsExport(image, 'create-after')).toBeLessThanOrEqual(1);

      const group = await callTool(tools, 'gimp_layer', {
        image,
        op: 'create_group',
        name: 'MatrixGroup',
      });
      expect(group.isError, JSON.stringify(group.content)).toBeFalsy();
      expect(await previewVsExport(image, 'create-group-after')).toBeLessThanOrEqual(1);

      const extraId = structuredOf(created).layer_id as number;
      const moved = await callTool(tools, 'gimp_layer', {
        image,
        op: 'move',
        layer_id: extraId,
        x: 4,
        y: 4,
      });
      expect(moved.isError, JSON.stringify(moved.content)).toBeFalsy();
      expect(await previewVsExport(image, 'move-after')).toBeLessThanOrEqual(1);

      const groupId = structuredOf(group).layer_id as number;
      const reordered = await callTool(tools, 'gimp_layer', {
        image,
        op: 'reorder',
        layer_id: extraId,
        parent_group: groupId,
      });
      expect(reordered.isError, JSON.stringify(reordered.content)).toBeFalsy();
      expect(await previewVsExport(image, 'reorder-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

  it('proxy matrix: FLATTEN rebuilds the proxy', async () => {
    const opened = await callTool(tools, 'gimp_open_document', { file_path: swatchesPath });
    const image = structuredOf(opened).image as number;
    try {
      await callTool(tools, 'gimp_add_adjustment', { image, type: 'saturation', scale: 0.5 });
      await warmProxy(image);
      expect(await previewVsExport(image, 'flatten-proxy-before')).toBeLessThanOrEqual(1);

      const flattened = await callTool(tools, 'gimp_layer', { image, op: 'flatten' });
      expect(flattened.isError, JSON.stringify(flattened.content)).toBeFalsy();

      expect(await previewVsExport(image, 'flatten-proxy-after')).toBeLessThanOrEqual(1);
    } finally {
      await callTool(tools, 'gimp_close_document', { image });
    }
  });

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
