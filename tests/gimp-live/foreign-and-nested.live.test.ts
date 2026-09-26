/**
 * Documents the bridge did not build itself, against real headless GIMP: a layer inside a layer
 * group, a selection left active in a saved .xcf, and filters with no ledger record (what a
 * filter added in the GIMP GUI looks like). The fixture state comes from the test-only bridge
 * (fixtures/test_ops.py), since no gimp_* tool can create it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  maxAbsDiff,
  writeColorSwatches,
  writeGrayRamp,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
} from './support.ts';

vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

interface Listed {
  filters: Array<{
    layer: string;
    filter_id: number;
    name: string;
    source: string;
    mask: string | null;
    params: Record<string, unknown>;
  }>;
}

describe.skipIf(!install)('foreign and nested document state', () => {
  let workDir: string;
  let session: GimpSession;
  let swatchesPath: string;
  let rampPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-foreign-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    swatchesPath = join(workDir, 'swatches.png');
    rampPath = join(workDir, 'ramp.png');
    writeColorSwatches(swatchesPath);
    writeGrayRamp(rampPath, 256, 32);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function exportPng(image: number, tag: string) {
    const path = join(workDir, `${tag}.png`);
    await session.call('export', { image, path });
    return readPng(path);
  }

  // ---- a filter on a layer inside a layer group ---------------------------------------------

  it('a masked filter on a nested layer is listed, previewed, refused by rotate, and kept across a reopen', async () => {
    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    let image = opened.image;
    try {
      const wrapped = await session.call<{ layers: string[] }>('test_wrap_in_group', { image });
      expect(wrapped.layers).toContain('Nested');
      const unfiltered = await exportPng(image, 'nested-unfiltered');

      await session.call('create_mask', {
        image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 48,
        height: 16,
        name: 'NestedMask',
      });
      const created = await session.call<{ filter_id: number }>('adjust', {
        image,
        type: 'brightness_contrast',
        brightness: 70,
        layer: 'Nested',
        mask: 'NestedMask',
        name: 'NestedLift',
      });

      const listed = await session.call<Listed>('filter', { image, op: 'list' });
      const rec = listed.filters.find((f) => f.filter_id === created.filter_id);
      expect(rec, 'the nested filter is listed').toBeDefined();
      expect(rec).toMatchObject({ layer: 'Nested', source: 'editmamei', mask: 'NestedMask' });

      // The preview proxy mirrors it: preview == full-resolution export, and both differ from
      // the unfiltered render (so the match isn't two renders that both ignore the filter).
      const previewPath = join(workDir, 'nested-preview.png');
      await session.call('preview', { image, max_px: 512, out_path: previewPath });
      const exported = await exportPng(image, 'nested-filtered');
      expect(maxAbsDiff(readPng(previewPath), exported)).toBeLessThanOrEqual(1);
      expect(maxAbsDiff(exported, unfiltered)).toBeGreaterThan(20);

      await expect(
        session.call('rotate', { image, degrees: 5, expand: true })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining("'NestedLift'"),
      });

      // Reopen: the ledger record must survive (not pruned as stale because the walk missed it).
      const xcfPath = join(workDir, 'nested.xcf');
      await session.call('export', { image, path: xcfPath });
      await session.call('close', { image });
      image = (await session.call<{ image: number }>('open', { path: xcfPath })).image;
      const relisted = await session.call<Listed>('filter', { image, op: 'list' });
      const again = relisted.filters.find((f) => f.name === 'NestedLift');
      expect(again).toMatchObject({ layer: 'Nested', source: 'editmamei', mask: 'NestedMask' });
    } finally {
      await session.call('close', { image });
    }
  });

  // ---- a selection saved in the .xcf --------------------------------------------------------

  it('open clears a selection saved in the .xcf, so rotate turns the whole canvas', async () => {
    const plain = await session.call<{ image: number }>('open', { path: swatchesPath });
    await session.call('rotate', { image: plain.image, degrees: 90, expand: true });
    const reference = await exportPng(plain.image, 'rotate-reference');
    await session.call('close', { image: plain.image });

    const withSelection = await session.call<{ image: number }>('open', { path: swatchesPath });
    const selected = await session.call<{ selection_empty: boolean }>('test_select_rect', {
      image: withSelection.image,
      x: 0,
      y: 0,
      width: 20,
      height: 8,
    });
    expect(selected.selection_empty, 'the fixture really has a selection').toBe(false);
    const xcfPath = join(workDir, 'with-selection.xcf');
    await session.call('export', { image: withSelection.image, path: xcfPath });
    await session.call('close', { image: withSelection.image });

    const reopened = await session.call<{ image: number }>('open', { path: xcfPath });
    try {
      const after = await session.call<{ selection_empty: boolean }>('test_selection_empty', {
        image: reopened.image,
      });
      expect(after.selection_empty).toBe(true);
      await session.call('rotate', { image: reopened.image, degrees: 90, expand: true });
      expect(maxAbsDiff(await exportPng(reopened.image, 'rotate-reopened'), reference)).toBe(0);
    } finally {
      await session.call('close', { image: reopened.image });
    }
  });

  it('rotate clears a selection active in the session before transforming', async () => {
    const plain = await session.call<{ image: number }>('open', { path: swatchesPath });
    await session.call('rotate', { image: plain.image, degrees: 90, expand: true });
    const reference = await exportPng(plain.image, 'rotate-reference-2');
    await session.call('close', { image: plain.image });

    const opened = await session.call<{ image: number }>('open', { path: swatchesPath });
    try {
      await session.call('test_select_rect', {
        image: opened.image,
        x: 0,
        y: 0,
        width: 20,
        height: 8,
      });
      await session.call('rotate', { image: opened.image, degrees: 90, expand: true });
      expect(maxAbsDiff(await exportPng(opened.image, 'rotate-active-selection'), reference)).toBe(
        0
      );
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // ---- a filter Editmamei did not create ----------------------------------------------------

  async function openWithForeignBrightness() {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const foreign = await session.call<{ filter_id: number; name: string }>(
      'test_add_foreign_filter',
      {
        image: opened.image,
        operation: 'gimp:brightness-contrast',
        name: 'GUI Brightness',
        props: { brightness: 0.3, contrast: 0.2 },
      }
    );
    return { image: opened.image, filterId: foreign.filter_id };
  }

  it('rotate refuses while a filter Editmamei did not create is present, and says why', async () => {
    const { image } = await openWithForeignBrightness();
    try {
      await expect(
        session.call('rotate', { image, degrees: 5, expand: true })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('were not created by Editmamei'),
      });
    } finally {
      await session.call('close', { image });
    }
  });

  it('a re-edit of a filter Editmamei did not create is refused and leaves it unchanged', async () => {
    const { image, filterId } = await openWithForeignBrightness();
    try {
      const before = await session.call<Listed>('filter', { image, op: 'list' });
      const renderBefore = await exportPng(image, 'foreign-before');
      await expect(
        session.call('adjust', {
          image,
          type: 'brightness_contrast',
          filter_id: filterId,
          contrast: 50,
        })
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining(`filter ${filterId} was not created by Editmamei`),
      });
      const after = await session.call<Listed>('filter', { image, op: 'list' });
      expect(after.filters).toEqual(before.filters);
      expect(after.filters[0]).toMatchObject({ source: 'readback' });
      expect(maxAbsDiff(await exportPng(image, 'foreign-after'), renderBefore)).toBe(0);
    } finally {
      await session.call('close', { image });
    }
  });

  it('list still works when a foreign filter has a property JSON cannot carry (a Gegl.Color)', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await session.call('test_add_foreign_filter', {
        image: opened.image,
        operation: 'gegl:color-overlay',
        name: 'GUI Overlay',
      });
      const listed = await session.call<Listed>('filter', { image: opened.image, op: 'list' });
      const overlay = listed.filters.find((f) => f.name === 'GUI Overlay');
      expect(overlay).toMatchObject({ source: 'readback' });
      expect(typeof overlay!.params.value).toBe('string');
    } finally {
      await session.call('close', { image: opened.image });
    }
  });
});
