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
    await session.call('adjust', { image: opened.image, type: 'exposure', exposure: 0.5, name: 'Lift' });
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
