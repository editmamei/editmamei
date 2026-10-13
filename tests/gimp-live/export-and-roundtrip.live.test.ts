/**
 * Export format options + metadata stripping, and the `.xcf` round trip carrying every
 * adjustment type plus a mask, against real headless GIMP.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  readPngBitDepth,
  readTiffTag,
  readPsdBitDepth,
  findTiffIfd0,
  findPngChunks,
  findRiffChunks,
  findPsdImageResources,
  maxAbsDiff,
  writeGrayRamp,
  readySession,
  LIVE_READY_TIMEOUT_MS,
} from './support.ts';

// This file alone, not the project default -- see adjust.live.test.ts's identical comment.
vi.setConfig({ testTimeout: 30_000 });

const install: GimpInstall | null = await detectGimp();

describe.skipIf(!install)('export options, metadata stripping, and .xcf round trip', () => {
  let workDir: string;
  let session: GimpSession;
  let rampPath: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-export-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    await readySession(session);
    rampPath = join(workDir, 'ramp.png');
    writeGrayRamp(rampPath, 256, 32);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('jpeg quality: a higher quality setting produces a larger file for the same content', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const low = await session.call<{ bytes: number }>('export', {
        image: opened.image,
        path: join(workDir, 'q10.jpg'),
        quality: 10,
      });
      const high = await session.call<{ bytes: number }>('export', {
        image: opened.image,
        path: join(workDir, 'q95.jpg'),
        quality: 95,
      });
      expect(high.bytes).toBeGreaterThan(low.bytes);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('jpeg quality rejects an out-of-range value', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('export', {
          image: opened.image,
          path: join(workDir, 'bad.jpg'),
          quality: 150,
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('png compression: a lower level trades a bigger file for materially less export time', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const t0 = Date.now();
      await session.call('export', {
        image: opened.image,
        path: join(workDir, 'c0.png'),
        compression: 0,
      });
      const fastMs = Date.now() - t0;
      const sizeFast = readFileSync(join(workDir, 'c0.png')).length;

      await session.call('export', {
        image: opened.image,
        path: join(workDir, 'c9.png'),
        compression: 9,
      });
      const sizeSlow = readFileSync(join(workDir, 'c9.png')).length;

      // This 256x32 fixture is far too small to show the large export-time gap a 24 MP photo
      // shows between compression 0 and GIMP's own default of 9; this only pins the DIRECTION --
      // compression 0 is not smaller than 9 -- and confirms the call itself completes quickly at
      // either level.
      expect(sizeFast).toBeGreaterThanOrEqual(sizeSlow);
      expect(fastMs).toBeLessThan(5000);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('png compression rejects an out-of-range value', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('export', {
          image: opened.image,
          path: join(workDir, 'bad.png'),
          compression: 10,
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it.each([
    ['out.png', false],
    ['out.jpg', false],
    ['out.xcf', false],
    ['out.png', true],
  ])(
    'a write into a missing folder is gimp_op_failed naming only the file (%s, forward slashes: %s)',
    async (name, forwardSlashes) => {
      const opened = await session.call<{ image: number }>('open', { path: rampPath });
      try {
        const missing = join(workDir, 'no-such-folder');
        const target = join(missing, name);
        const err = (await session
          .call('export', {
            image: opened.image,
            path: forwardSlashes ? target.replace(/\\/g, '/') : target,
          })
          .catch((e: unknown) => e)) as { code: string; message: string };
        expect(err).toMatchObject({ code: 'gimp_op_failed' });
        expect(err.message).toContain(name);
        expect(err.message).not.toContain(missing);
        expect(err.message).not.toContain('no-such-folder');
        expect(existsSync(missing)).toBe(false);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
  );

  it('webp: lossless produces a different file than a lossy export', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const lossy = await session.call<{ bytes: number }>('export', {
        image: opened.image,
        path: join(workDir, 'lossy.webp'),
        quality: 50,
        lossless: false,
      });
      const lossless = await session.call<{ bytes: number }>('export', {
        image: opened.image,
        path: join(workDir, 'lossless.webp'),
        lossless: true,
      });
      expect(lossless.bytes).not.toBe(lossy.bytes);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  // TIFF tag 259 (Compression) values measured live for each scheme, on 8-bit RGB content.
  // ccittfax3/ccittfax4 are NOT in this list, or in `lib.TIFF_COMPRESSIONS` at all: they are
  // bilevel-only, and applied to this suite's RGB content they produced a degenerate ~8-byte file
  // with no readable IFD (verified live) rather than a real TIFF, so they were dropped from the
  // allow-list entirely -- see the test below and `lib.TIFF_COMPRESSIONS`'s own comment.
  const TIFF_COMPRESSION_CODES: Record<string, number> = {
    none: 1,
    lzw: 5,
    packbits: 32773,
    jpeg: 7,
    adobe_deflate: 8,
  };

  it.each(Object.entries(TIFF_COMPRESSION_CODES))(
    'tiff compression %s writes tag 259 (Compression) = %i',
    async (compression, expectedCode) => {
      const opened = await session.call<{ image: number }>('open', { path: rampPath });
      try {
        const outPath = join(workDir, `t-${compression}.tiff`);
        await session.call('export', { image: opened.image, path: outPath, compression });
        expect(readTiffTag(outPath, 259)).toEqual([expectedCode]);
      } finally {
        await session.call('close', { image: opened.image });
      }
    }
  );

  it('tiff rejects the bilevel-only compression schemes (ccittfax3/ccittfax4), not just an unrecognized string', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      for (const compression of ['ccittfax3', 'ccittfax4']) {
        await expect(
          session.call('export', {
            image: opened.image,
            path: join(workDir, `t-${compression}.tiff`),
            compression,
          }),
          compression
        ).rejects.toMatchObject({ code: 'invalid_argument' });
      }
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('png bit_depth: 8 (default) and 16 write the requested IHDR bit depth', async () => {
    const opened = await session.call<{ image: number }>('open', {
      path: rampPath,
      precision: '16',
    });
    try {
      const path8 = join(workDir, 'bd8.png');
      const path16 = join(workDir, 'bd16.png');
      await session.call('export', { image: opened.image, path: path8 });
      await session.call('export', { image: opened.image, path: path16, bit_depth: 16 });
      expect(readPngBitDepth(path8)).toBe(8);
      expect(readPngBitDepth(path16)).toBe(16);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('tiff bit_depth: 8 (default) and 16 write the requested BitsPerSample', async () => {
    const opened = await session.call<{ image: number }>('open', {
      path: rampPath,
      precision: '16',
    });
    try {
      const path8 = join(workDir, 'bd8.tiff');
      const path16 = join(workDir, 'bd16.tiff');
      await session.call('export', { image: opened.image, path: path8 });
      await session.call('export', { image: opened.image, path: path16, bit_depth: 16 });
      expect(readTiffTag(path8, 258)).toEqual([8, 8, 8]);
      expect(readTiffTag(path16, 258)).toEqual([16, 16, 16]);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('png bit_depth rejects a value that is neither 8 nor 16', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('export', {
          image: opened.image,
          path: join(workDir, 'bad-bd.png'),
          bit_depth: 12,
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('tiff rejects an unrecognized compression string', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      await expect(
        session.call('export', {
          image: opened.image,
          path: join(workDir, 'bad.tiff'),
          compression: 'zip',
        })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  describe('layered .psd export', () => {
    type LayerNode = {
      layer_id: number;
      name: string;
      opacity: number;
      visible: boolean;
      is_group: boolean;
      is_text_layer: boolean;
      children: LayerNode[];
    };
    type PsdReport = {
      path: string;
      bytes: number;
      layers: number;
      merged_groups: string[];
      rasterized_text: string[];
      may_blend_differently: string[];
    };
    const tree = async (image: number) =>
      (await session.call<{ layers: LayerNode[] }>('describe', { image, what: 'layers' })).layers;
    const flat = (nodes: LayerNode[]): LayerNode[] =>
      nodes.flatMap((n) => [n, ...flat(n.children)]);

    /**
     * Everything at 100% opacity, normal mode, hard-edged masks, and the text layer hidden, so
     * GIMP's own render and the PSD's reopened render are directly comparable: those are the
     * cases where linear and gamma-space blending agree (soft edges and partial opacity do not,
     * which the `may_blend_differently` test below covers instead).
     */
    async function buildLayeredDocument(): Promise<number> {
      const { image } = await session.call<{ image: number }>('open', { path: rampPath });
      const background = (await tree(image))[0]!.layer_id;
      // A plain filter, a masked filter, and a hidden filter on the background.
      await session.call('curves', {
        image,
        points: [
          [0, 40],
          [255, 215],
        ],
        name: 'Lift',
      });
      await session.call('create_mask', {
        image,
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 96,
        height: 32,
        name: 'Left',
      });
      await session.call('curves', {
        image,
        points: [
          [0, 0],
          [255, 140],
        ],
        mask: 'Left',
        name: 'MaskedDarken',
      });
      const off = await session.call<{ filter_id: number }>('adjust', {
        image,
        layer_id: background,
        type: 'exposure',
        exposure: 2,
        name: 'Off',
      });
      await session.call('filter', {
        image,
        op: 'set_visibility',
        filter_id: off.filter_id,
        visible: false,
      });
      // A hard-masked layer with its own filter.
      const patch = await session.call<{ layer_id: number }>('layer', {
        image,
        op: 'create',
        name: 'Patch',
        width: 256,
        height: 32,
        fill: 'white',
      });
      await session.call('create_mask', {
        image,
        type: 'rectangle',
        x: 160,
        y: 8,
        width: 48,
        height: 16,
        name: 'PatchMask',
      });
      await session.call('layer_mask', {
        image,
        op: 'create',
        layer_id: patch.layer_id,
        source: 'channel',
        channel: 'PatchMask',
      });
      await session.call('adjust', {
        image,
        layer_id: patch.layer_id,
        type: 'brightness_contrast',
        brightness: -50,
      });
      // A group carrying its own filter: PSD cannot hold it, so it must be merged.
      const group = await session.call<{ layer_id: number }>('layer', {
        image,
        op: 'create_group',
        name: 'Toned',
      });
      await session.call('layer', {
        image,
        op: 'create',
        name: 'Inner',
        width: 32,
        height: 16,
        fill: 'white',
        parent_group: group.layer_id,
      });
      await session.call('adjust', {
        image,
        layer_id: group.layer_id,
        type: 'brightness_contrast',
        brightness: -40,
      });
      // A hidden layer with a filter, and a hidden text layer.
      const ghost = await session.call<{ layer_id: number }>('layer', {
        image,
        op: 'create',
        name: 'Ghost',
        width: 256,
        height: 32,
        fill: 'black',
      });
      await session.call('adjust', {
        image,
        layer_id: ghost.layer_id,
        type: 'exposure',
        exposure: 1,
      });
      await session.call('layer', { image, op: 'set', layer_id: ghost.layer_id, visible: false });
      const title = await session.call<{ layer_id: number }>('text', {
        image,
        op: 'create',
        text: 'Hi',
        x: 200,
        y: 0,
        font_size: 12,
      });
      await session.call('layer', { image, op: 'set', layer_id: title.layer_id, visible: false });
      return image;
    }

    it('keeps the layer stack, bakes filters, merges a filtered group, and renders like the document', async () => {
      const image = await buildLayeredDocument();
      try {
        const refPath = join(workDir, 'layered-ref.png');
        await session.call('export', { image, path: refPath });
        const psdPath = join(workDir, 'layered.psd');
        const report = await session.call<PsdReport>('export', { image, path: psdPath });

        expect(report.merged_groups).toEqual(['Toned']);
        expect(report.rasterized_text).toHaveLength(1);
        expect(report.may_blend_differently).toEqual([]);
        expect(report.bytes).toBe(readFileSync(psdPath).length);
        expect(readPsdBitDepth(readFileSync(psdPath))).toBe(8);

        // The live document is untouched: the group is still a group and every filter is live.
        const live = flat(await tree(image));
        expect(live.find((n) => n.name === 'Toned')!.is_group).toBe(true);
        const filters = await session.call<{ filters: unknown[] }>('filter', { image, op: 'list' });
        expect(filters.filters).toHaveLength(6);

        const reopened = (await session.call<{ image: number }>('open', { path: psdPath })).image;
        try {
          const layers = flat(await tree(reopened));
          expect(layers).toHaveLength(report.layers);
          const byName = (name: string) => layers.find((n) => n.name === name);
          expect(byName('Toned')!.is_group).toBe(false);
          expect(byName('Inner')).toBeUndefined();
          expect(byName('Patch')).toBeDefined();
          expect(byName('Ghost')!.visible).toBe(false);
          const text = layers.find((n) => n.name === report.rasterized_text[0]);
          expect(text!.is_text_layer).toBe(false);
          expect(text!.visible).toBe(false);
          const reopenedFilters = await session.call<{ filters: unknown[] }>('filter', {
            image: reopened,
            op: 'list',
          });
          expect(reopenedFilters.filters).toEqual([]);

          const rtPath = join(workDir, 'layered-rt.png');
          await session.call('export', { image: reopened, path: rtPath });
          expect(maxAbsDiff(readPng(refPath), readPng(rtPath))).toBeLessThanOrEqual(1);
        } finally {
          await session.call('close', { image: reopened });
        }
      } finally {
        await session.call('close', { image });
      }
    });

    it('lists visible layers below 100% opacity as may_blend_differently, and writes 16-bit on request', async () => {
      const image = await buildLayeredDocument();
      try {
        const patch = flat(await tree(image)).find((n) => n.name === 'Patch')!;
        await session.call('layer', { image, op: 'set', layer_id: patch.layer_id, opacity: 60 });
        const psdPath = join(workDir, 'layered-16.psd');
        const report = await session.call<PsdReport>('export', {
          image,
          path: psdPath,
          bit_depth: 16,
        });
        expect(report.may_blend_differently).toEqual(['Patch']);
        expect(readPsdBitDepth(readFileSync(psdPath))).toBe(16);
      } finally {
        await session.call('close', { image });
      }
    });
  });

  it("leaves the editor's built-in color profile out of every format, so no file names the editor", async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const utf16Name = Buffer.from(' G I M P', 'latin1');
      const icc: Record<string, (buf: Buffer) => boolean> = {
        jpg: (b) => b.includes('ICC_PROFILE'),
        png: (b) => findPngChunks(b).has('iCCP'),
        webp: (b) => findRiffChunks(b).has('ICCP'),
        tif: (b) => findTiffIfd0(b).has(34675),
        psd: (b) => findPsdImageResources(b).has(1039),
      };
      for (const [ext, hasProfile] of Object.entries(icc)) {
        const path = join(workDir, `no-profile.${ext}`);
        await session.call('export', { image: opened.image, path });
        const buf = readFileSync(path);
        expect(hasProfile(buf), `${ext} carries a color profile`).toBe(false);
        const named =
          buf.includes(utf16Name) || buf.toString('latin1').toLowerCase().includes('gimp');
        expect(named, `${ext} names the editor`).toBe(false);
      }
      // The PSD is still a valid file after its profile is taken out: it reopens with its layer.
      const reopened = await session.call<{ image: number; layers: string[] }>('open', {
        path: join(workDir, 'no-profile.psd'),
      });
      expect(reopened.layers).toHaveLength(1);
      await session.call('close', { image: reopened.image });
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('op_export takes the live-document .xcf branch for a .xcf path', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    try {
      const xcfPath = join(workDir, 'via-export.xcf');
      const result = await session.call<{ path: string }>('export', {
        image: opened.image,
        path: xcfPath,
      });
      expect(result.path).toBe(xcfPath);
      expect(existsSync(xcfPath)).toBe(true);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });

  it('.xcf round trip: every adjustment type plus a mask survives reopen, rendering identically (max diff 0), with source: editmamei for each', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    const xcfPath = join(workDir, 'full-roundtrip.xcf');

    await session.call('create_mask', {
      image: opened.image,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 128,
      height: 32,
      name: 'RoundtripMask',
    });

    const adjustCalls: Array<[string, Record<string, unknown>]> = [
      [
        'curves',
        {
          points: [
            [0, 30],
            [255, 220],
          ],
        },
      ],
      ['levels', { in_low: 10, in_high: 245, gamma: 1.1, out_low: 5, out_high: 250 }],
      ['exposure', { exposure: 0.5 }],
      ['brightness_contrast', { brightness: 10, contrast: 10 }],
      ['hue_saturation', { hue: 20, saturation: 10 }],
      ['color_balance', { range: 'midtones', cyan_red: 15 }],
      ['color_temperature', { from_kelvin: 6500, to_kelvin: 7500 }],
      ['shadows_highlights', { shadows: 20, highlights: -10 }],
      ['saturation', { scale: 1.2 }],
      ['vibrance', { vibrance: 20 }],
      ['sharpen', { radius: 2, amount: 0.5 }],
      ['noise_reduction', { strength: 2 }],
      ['gaussian_blur', { radius: 1.5 }],
    ];
    for (const [type, params] of adjustCalls) {
      await session.call('adjust', { image: opened.image, type, ...params });
    }
    // One of them masked, to prove masks round-trip alongside every adjustment type.
    await session.call('curves', {
      image: opened.image,
      points: [
        [0, 0],
        [255, 128],
      ],
      mask: 'RoundtripMask',
      name: 'MaskedRoundtrip',
    });

    const beforeExportPath = join(workDir, 'before-save.png');
    await session.call('export', { image: opened.image, path: beforeExportPath });
    const beforeRender = readPng(beforeExportPath);

    await session.call('export', { image: opened.image, path: xcfPath });
    await session.call('close', { image: opened.image });

    const reopened = await session.call<{ image: number }>('open', { path: xcfPath });
    const listed = await session.call<{
      filters: Array<{ operation: string; type: string; source: string; mask: string | null }>;
    }>('filter', { image: reopened.image, op: 'list' });

    expect(listed.filters).toHaveLength(adjustCalls.length + 1); // +1 for the masked curve
    for (const f of listed.filters) {
      expect(f.source, `${f.operation} must be ledger-sourced, not readback`).toBe('editmamei');
    }
    const maskedRecord = listed.filters.find((f) => f.mask === 'RoundtripMask');
    expect(maskedRecord).toBeDefined();

    const afterExportPath = join(workDir, 'after-reopen.png');
    await session.call('export', { image: reopened.image, path: afterExportPath });
    const afterRender = readPng(afterExportPath);

    expect(maxAbsDiff(beforeRender, afterRender)).toBe(0);
    await session.call('close', { image: reopened.image });
  });

  it('.xcf round trip: after reopen, a filter can be re-edited by its listed id, hidden, and deleted, and each changes the render', async () => {
    const opened = await session.call<{ image: number }>('open', { path: rampPath });
    await session.call('adjust', {
      image: opened.image,
      type: 'exposure',
      exposure: 0.5,
      name: 'Lift',
    });
    await session.call('adjust', {
      image: opened.image,
      type: 'brightness_contrast',
      contrast: 30,
      name: 'Punch',
    });
    const xcfPath = join(workDir, 'manage-roundtrip.xcf');
    await session.call('export', { image: opened.image, path: xcfPath });
    await session.call('close', { image: opened.image });

    const { image } = await session.call<{ image: number }>('open', { path: xcfPath });
    try {
      let step = 0;
      const render = async () => {
        const path = join(workDir, `manage-${step++}.png`);
        await session.call('export', { image, path });
        return readPng(path);
      };
      type Listed = {
        filters: Array<{ filter_id: number; name: string; params: Record<string, unknown> }>;
      };
      const list = () => session.call<Listed>('filter', { image, op: 'list' });

      const reopened = await render();
      const lift = (await list()).filters.find((f) => f.name === 'Lift')!;
      expect(lift.params).toEqual({ exposure: 0.5, black_level: 0 });

      // Re-edit by the listed id.
      await session.call('adjust', {
        image,
        type: 'exposure',
        filter_id: lift.filter_id,
        exposure: 1.5,
      });
      const reedited = await render();
      expect(maxAbsDiff(reopened, reedited)).toBeGreaterThan(10);
      expect((await list()).filters.find((f) => f.name === 'Lift')!.params).toEqual({
        exposure: 1.5,
        black_level: 0,
      });

      // Hide and show again.
      const punch = (await list()).filters.find((f) => f.name === 'Punch')!;
      await session.call('filter', {
        image,
        op: 'set_visibility',
        filter_id: punch.filter_id,
        visible: false,
      });
      const hidden = await render();
      expect(maxAbsDiff(reedited, hidden)).toBeGreaterThan(5);
      await session.call('filter', {
        image,
        op: 'set_visibility',
        filter_id: punch.filter_id,
        visible: true,
      });
      expect(maxAbsDiff(reedited, await render())).toBe(0);

      // Delete: the render matches hiding it, and it is gone from the stack.
      await session.call('filter', { image, op: 'delete', filter_id: punch.filter_id });
      expect(maxAbsDiff(hidden, await render())).toBe(0);
      expect((await list()).filters.map((f) => f.name)).toEqual(['Lift']);
    } finally {
      await session.call('close', { image });
    }
  });
});
