/**
 * gimp_layer set's `blend_space` against real headless GIMP, driven through the tool handlers.
 *
 * Pins:
 *  - 50% grey at 50% opacity over black exports ~64 with `perceptual` (the browser/Photoshop
 *    result) and ~92 with `auto` (GIMP's linear default), for a layer and for a group.
 *  - Anti-aliased dark text on white exports darker with `perceptual`; a fully opaque layer is
 *    byte-identical either way.
 *  - A bad value refuses the whole set, leaving an opacity sent alongside it unapplied.
 *  - The setting survives an XCF save, close and reopen, is reported by gimp_inspect, is kept by
 *    duplicate, and is reset to auto by a mode change (as GIMP does).
 *  - The layered PSD export still works, and its may_blend_differently list ignores the setting.
 *  - gimp_modify_selection op=delete removes a saved selection.
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
import { createGimpSelectionTools } from '@editmamei/tools/gimp-selection-tools.ts';
import { createGimpLayerTools } from '@editmamei/tools/gimp-layer-tools.ts';
import { createGimpComposeTools } from '@editmamei/tools/gimp-compose-tools.ts';
import type { ToolDefinition, ToolResult } from '@editmamei/core/tool-registry.ts';
import { callTool } from '../fixtures/tool-helpers.ts';
import {
  writeRgbaFlat,
  readPng,
  pixelAt,
  maxAbsDiff,
  readyGimpRegistry,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

vi.setConfig({ testTimeout: 60_000 });

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (blend space)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

interface LayerNode {
  layer_id: number;
  name: string;
  opacity: number;
  blend_space: string;
  composite_space: string;
  children: LayerNode[];
}

function structuredOf(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function ok(result: ToolResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return structuredOf(result);
}

function findNode(nodes: LayerNode[], id: number): LayerNode | undefined {
  for (const n of nodes) {
    if (n.layer_id === id) return n;
    const hit = findNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return undefined;
}

describe.skipIf(!install)('gimp_layer blend_space against real headless GIMP', () => {
  let workDir: string;
  let backend: GimpBackend;
  let tools: ToolDefinition[];
  let blackPath: string;
  let whitePath: string;
  let greyPath: string;

  const call = (name: string, args: Record<string, unknown>) => callTool(tools, name, args);

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-blend-space-'));
    backend = new GimpBackend(install, {
      sessionOptions: { rootDir: join(workDir, 'session-root'), opsPyPath: TEST_OPS_PY },
    });
    tools = [
      ...createGimpCoreTools(backend),
      ...createGimpDocumentTools(backend),
      ...createGimpInspectTools(backend),
      ...createGimpSelectionTools(backend),
      ...createGimpLayerTools(backend),
      ...createGimpComposeTools(backend),
    ];
    await readyGimpRegistry(call);
    blackPath = join(workDir, 'black.png');
    whitePath = join(workDir, 'white.png');
    greyPath = join(workDir, 'grey.png');
    writeRgbaFlat(blackPath, 32, 32, [0, 0, 0], 255);
    writeRgbaFlat(whitePath, 160, 60, [255, 255, 255], 255);
    writeRgbaFlat(greyPath, 32, 32, [128, 128, 128], 255);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await backend.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function open(path: string): Promise<number> {
    return ok(await call('gimp_open_document', { file_path: path })).image as number;
  }

  async function layers(image: number): Promise<LayerNode[]> {
    return ok(await call('gimp_inspect', { what: 'layers', image })).layers as LayerNode[];
  }

  async function exportPng(image: number, label: string) {
    const path = join(workDir, `${label}.png`);
    ok(await call('gimp_export', { image, file_path: path }));
    return readPng(path);
  }

  /** Black base with a 50%-opacity grey layer on top; returns the grey layer's id. */
  async function greyOverBlack(image: number, parentGroup?: number): Promise<number> {
    const placed = ok(
      await call('gimp_place_image', {
        image,
        file_path: greyPath,
        name: 'Grey',
        ...(parentGroup !== undefined ? { parent_group: parentGroup } : {}),
      })
    );
    return placed.layer_id as number;
  }

  it('grey check on a layer: perceptual reads ~64, auto ~92', async () => {
    const image = await open(blackPath);
    try {
      const grey = await greyOverBlack(image);
      ok(await call('gimp_layer', { image, op: 'set', layer_id: grey, opacity: 50 }));
      const auto = pixelAt(await exportPng(image, 'layer-auto'), 16, 16)[0];
      expect(Math.abs(auto - 92)).toBeLessThanOrEqual(2);

      const set = ok(
        await call('gimp_layer', { image, op: 'set', layer_id: grey, blend_space: 'perceptual' })
      );
      expect(set.blend_space).toBe('perceptual');
      const perceptual = pixelAt(await exportPng(image, 'layer-perceptual'), 16, 16)[0];
      expect(Math.abs(perceptual - 64)).toBeLessThanOrEqual(2);

      const node = findNode(await layers(image), grey)!;
      expect(node.composite_space).toBe('perceptual');
      // Normal mode fixes its blend space; the composite space alone gives the 64.
      expect(node.blend_space).toBe('auto');

      ok(await call('gimp_layer', { image, op: 'set', layer_id: grey, blend_space: 'auto' }));
      const back = pixelAt(await exportPng(image, 'layer-auto-again'), 16, 16)[0];
      expect(back).toBe(auto);
      expect(findNode(await layers(image), grey)!.composite_space).toBe('auto');
    } finally {
      await call('gimp_close_document', { image });
    }
  });

  it('grey check on a group: perceptual reads ~64, auto ~92', async () => {
    const image = await open(blackPath);
    try {
      const group = ok(await call('gimp_layer', { image, op: 'create_group', name: 'G' }))
        .layer_id as number;
      await greyOverBlack(image, group);
      ok(await call('gimp_layer', { image, op: 'set', layer_id: group, opacity: 50 }));
      const auto = pixelAt(await exportPng(image, 'group-auto'), 16, 16)[0];
      expect(Math.abs(auto - 92)).toBeLessThanOrEqual(2);

      ok(
        await call('gimp_layer', { image, op: 'set', layer_id: group, blend_space: 'perceptual' })
      );
      const perceptual = pixelAt(await exportPng(image, 'group-perceptual'), 16, 16)[0];
      expect(Math.abs(perceptual - 64)).toBeLessThanOrEqual(2);
      expect(findNode(await layers(image), group)!.composite_space).toBe('perceptual');
    } finally {
      await call('gimp_close_document', { image });
    }
  });

  it('anti-aliased dark text on white is darker with perceptual; an opaque layer is identical', async () => {
    const image = await open(whitePath);
    try {
      const text = await backend.call<{ layer_id: number }>('test_add_text_layer', {
        image,
        text: 'Hi',
      });
      const before = await exportPng(image, 'text-auto');
      ok(
        await call('gimp_layer', {
          image,
          op: 'set',
          layer_id: text.layer_id,
          blend_space: 'perceptual',
        })
      );
      const after = await exportPng(image, 'text-perceptual');
      let sumBefore = 0;
      let sumAfter = 0;
      let darkest = 255;
      let darker = 0;
      let lighter = 0;
      for (let y = 0; y < before.height; y++) {
        for (let x = 0; x < before.width; x++) {
          const b = pixelAt(before, x, y)[0];
          const a = pixelAt(after, x, y)[0];
          sumBefore += b;
          sumAfter += a;
          darkest = Math.min(darkest, b);
          if (a < b) darker++;
          if (a > b) lighter++;
        }
      }
      expect(darkest, 'the fixture text must actually be dark').toBeLessThan(64);
      expect(darker, 'edge pixels must get darker').toBeGreaterThan(10);
      expect(lighter).toBe(0);
      expect(sumAfter).toBeLessThan(sumBefore);
    } finally {
      await call('gimp_close_document', { image });
    }

    const flat = await open(blackPath);
    try {
      const grey = await greyOverBlack(flat);
      const autoPng = await exportPng(flat, 'opaque-auto');
      ok(
        await call('gimp_layer', {
          image: flat,
          op: 'set',
          layer_id: grey,
          blend_space: 'perceptual',
        })
      );
      expect(maxAbsDiff(autoPng, await exportPng(flat, 'opaque-perceptual'))).toBe(0);
    } finally {
      await call('gimp_close_document', { image: flat });
    }
  });

  it('a bad blend_space refuses the whole set: an opacity sent with it is not applied', async () => {
    const image = await open(blackPath);
    try {
      const grey = await greyOverBlack(image);
      // Straight to the bridge: the tool's own enum would refuse this before dispatch.
      await expect(
        backend.call('layer', {
          image,
          op: 'set',
          layer_id: grey,
          opacity: 30,
          blend_space: 'gamma',
        })
      ).rejects.toThrow(/blend_space/);
      const node = findNode(await layers(image), grey)!;
      expect(node.opacity).toBe(100);
      expect(node.composite_space).toBe('auto');
    } finally {
      await call('gimp_close_document', { image });
    }
  });

  it('a mode change resets blend_space to auto; mode and blend_space in one call keeps both', async () => {
    const image = await open(blackPath);
    try {
      const grey = await greyOverBlack(image);
      ok(await call('gimp_layer', { image, op: 'set', layer_id: grey, blend_space: 'perceptual' }));
      ok(await call('gimp_layer', { image, op: 'set', layer_id: grey, mode: 'multiply' }));
      const reset = findNode(await layers(image), grey)!;
      expect([reset.blend_space, reset.composite_space]).toEqual(['auto', 'auto']);

      ok(
        await call('gimp_layer', {
          image,
          op: 'set',
          layer_id: grey,
          mode: 'screen',
          blend_space: 'perceptual',
        })
      );
      const both = findNode(await layers(image), grey)!;
      expect([both.blend_space, both.composite_space]).toEqual(['perceptual', 'perceptual']);
    } finally {
      await call('gimp_close_document', { image });
    }
  });

  it('survives an XCF save, close and reopen, and duplicate keeps it', async () => {
    const xcf = join(workDir, 'kept.xcf');
    const image = await open(blackPath);
    let reopened: number | undefined;
    try {
      const grey = await greyOverBlack(image);
      ok(
        await call('gimp_layer', {
          image,
          op: 'set',
          layer_id: grey,
          opacity: 50,
          blend_space: 'perceptual',
        })
      );
      const dup = ok(await call('gimp_layer', { image, op: 'duplicate', layer_id: grey }));
      expect(findNode(await layers(image), dup.layer_id as number)!.composite_space).toBe(
        'perceptual'
      );
      ok(await call('gimp_layer', { image, op: 'delete', layer_id: dup.layer_id }));
      ok(await call('gimp_save_xcf', { image, file_path: xcf }));
    } finally {
      await call('gimp_close_document', { image });
    }
    try {
      reopened = await open(xcf);
      const grey = (await layers(reopened)).find((n) => n.name === 'Grey')!;
      expect(grey.composite_space).toBe('perceptual');
      const value = pixelAt(await exportPng(reopened, 'reopened'), 16, 16)[0];
      expect(Math.abs(value - 64)).toBeLessThanOrEqual(2);
    } finally {
      if (reopened !== undefined) await call('gimp_close_document', { image: reopened });
    }
  });

  it('merge_down bakes the perceptual result; the merged layer is back at auto', async () => {
    const image = await open(blackPath);
    try {
      const grey = await greyOverBlack(image);
      ok(
        await call('gimp_layer', {
          image,
          op: 'set',
          layer_id: grey,
          opacity: 50,
          blend_space: 'perceptual',
        })
      );
      const merged = ok(await call('gimp_layer', { image, op: 'merge_down', layer_id: grey }));
      const node = findNode(await layers(image), merged.layer_id as number)!;
      // The merge bakes the perceptual result into the pixels; the merged layer itself is back
      // at GIMP's default spaces.
      const value = pixelAt(await exportPng(image, 'merged'), 16, 16)[0];
      expect(Math.abs(value - 64)).toBeLessThanOrEqual(2);
      expect([node.blend_space, node.composite_space]).toEqual(['auto', 'auto']);
    } finally {
      await call('gimp_close_document', { image });
    }
  });

  it('PSD export still works and may_blend_differently ignores blend_space', async () => {
    const image = await open(blackPath);
    try {
      const grey = await greyOverBlack(image);
      ok(await call('gimp_layer', { image, op: 'set', layer_id: grey, opacity: 50 }));
      const before = ok(
        await call('gimp_export', { image, file_path: join(workDir, 'before.psd') })
      );
      ok(await call('gimp_layer', { image, op: 'set', layer_id: grey, blend_space: 'perceptual' }));
      const after = ok(await call('gimp_export', { image, file_path: join(workDir, 'after.psd') }));
      expect(after.may_blend_differently).toEqual(before.may_blend_differently);
      expect(after.layers).toBe(before.layers);
    } finally {
      await call('gimp_close_document', { image });
    }
  });

  it('gimp_modify_selection op=delete removes a saved selection', async () => {
    const image = await open(blackPath);
    try {
      ok(
        await call('gimp_select', {
          image,
          mode: 'rectangle',
          name: 'Scratch',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
        })
      );
      const deleted = ok(
        await call('gimp_modify_selection', { image, channel: 'Scratch', op: 'delete' })
      );
      expect(deleted).toEqual({ channel: 'Scratch', deleted: true });
      const channels = ok(await call('gimp_inspect', { what: 'channels', image })).channels as {
        name: string;
      }[];
      expect(channels.map((c) => c.name)).not.toContain('Scratch');
      const again = await call('gimp_modify_selection', {
        image,
        channel: 'Scratch',
        op: 'delete',
      });
      expect(again.isError).toBe(true);
    } finally {
      await call('gimp_close_document', { image });
    }
  });

  it('op=delete refuses a saved selection a filter uses as its mask, and refuses output/px', async () => {
    const image = await open(blackPath);
    const names = async () =>
      (
        ok(await call('gimp_inspect', { what: 'channels', image })).channels as { name: string }[]
      ).map((c) => c.name);
    try {
      ok(
        await call('gimp_select', {
          image,
          mode: 'rectangle',
          name: 'Confines',
          x: 0,
          y: 0,
          width: 8,
          height: 8,
        })
      );
      await backend.call('adjust', { image, type: 'saturation', scale: 0.5, mask: 'Confines' });
      const refused = await call('gimp_modify_selection', {
        image,
        channel: 'Confines',
        op: 'delete',
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('mask');
      expect(await names()).toContain('Confines');

      await expect(
        backend.call('modify_mask', { image, channel: 'Confines', op: 'delete', output: 'X' })
      ).rejects.toThrow(/output/);
      await expect(
        backend.call('modify_mask', { image, channel: 'Confines', op: 'delete', px: 2 })
      ).rejects.toThrow(/px/);
      expect(await names()).toContain('Confines');
    } finally {
      await call('gimp_close_document', { image });
    }
  });
});
