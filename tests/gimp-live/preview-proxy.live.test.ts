/**
 * The preview proxy's build and upkeep, against real headless GIMP: it is built without rendering
 * the document's live filters (they are hidden for the duplicate and shown again), and a saved
 * selection is put into the cached proxies instead of dropping them -- with the same render a
 * rebuilt proxy gives.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  readPng,
  writeGrayRamp,
  readySession,
  LIVE_READY_TIMEOUT_MS,
  TEST_OPS_PY,
  maxAbsDiff,
} from './support.ts';

vi.setConfig({ testTimeout: 60_000 });

const install: GimpInstall | null = await detectGimp();

type FilterRow = { filter_id: number; name: string; visible: boolean };

describe.skipIf(!install)('preview proxy', () => {
  let workDir: string;
  let session: GimpSession;
  let rampPath: string;
  let n = 0;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-proxy-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: TEST_OPS_PY,
    });
    await readySession(session);
    // Wider than 1024, so both proxy sizes are real downscales.
    rampPath = join(workDir, 'ramp.png');
    writeGrayRamp(rampPath, 2400, 600);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  const preview = async (image: number, maxPx: number) => {
    const path = join(workDir, `p${n++}.png`);
    await session.call('preview', { image, max_px: maxPx, out_path: path });
    return readPng(path);
  };
  const filters = async (image: number) =>
    (await session.call<{ filters: FilterRow[] }>('list_filters', { image })).filters;

  it('builds a filter-free proxy and leaves every filter on the document shown or hidden as it was', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: rampPath });
    await session.call('adjust', {
      image,
      type: 'curves',
      points: [
        [0, 0],
        [128, 170],
        [255, 255],
      ],
    });
    const hidden = await session.call<{ filter_id: number }>('adjust', {
      image,
      type: 'levels',
      gamma: 0.5,
    });
    await session.call('adjust', { image, type: 'exposure', exposure: 0.4 });
    await session.call('filter', {
      image,
      op: 'set_visibility',
      filter_id: hidden.filter_id,
      visible: false,
    });
    const before = await filters(image);
    expect(before.filter((f) => !f.visible).map((f) => f.filter_id)).toEqual([hidden.filter_id]);

    await session.call('test_drop_proxies', { image });
    const first = await preview(image, 1024); // builds the proxy
    expect(
      (await session.call<{ filters: number }>('test_proxy_filter_count', { image, max_px: 1024 }))
        .filters
    ).toBe(0);
    expect((await filters(image)).map((f) => [f.filter_id, f.visible])).toEqual(
      before.map((f) => [f.filter_id, f.visible])
    );
    // The hidden filter stays out of the render, the shown ones in: the same picture from a second build...
    await session.call('test_drop_proxies', { image });
    expect(maxAbsDiff(first, await preview(image, 1024))).toBe(0);
    // ...and as without that filter at all, while the shown ones visibly change the photo.
    await session.call('filter', { image, op: 'delete', filter_id: hidden.filter_id });
    await session.call('test_drop_proxies', { image });
    expect(maxAbsDiff(first, await preview(image, 1024))).toBe(0);
    const shown = (await filters(image)).map((f) => f.filter_id);
    await session.call('filter', { image, op: 'delete', filter_ids: shown });
    await session.call('test_drop_proxies', { image });
    expect(maxAbsDiff(first, await preview(image, 1024))).toBeGreaterThan(10);
    await session.call('close', { image });
  });

  it('puts a new selection into the cached proxies instead of rebuilding them, and a masked filter renders as on a rebuilt proxy', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: rampPath });
    await session.call('adjust', {
      image,
      type: 'curves',
      points: [
        [0, 0],
        [128, 150],
        [255, 255],
      ],
    });
    const unmasked = await preview(image, 1024);
    await preview(image, 512);
    const proxiesBefore = (await session.call<{ ids: number[] }>('test_proxy_ids', {})).ids;
    expect(proxiesBefore.length).toBeGreaterThanOrEqual(2);

    await session.call('select', {
      image,
      mode: 'ellipse',
      x: 600,
      y: 100,
      width: 1200,
      height: 400,
      name: 'Spot',
      feather_px: 30,
    });
    await session.call('adjust', { image, type: 'levels', gamma: 2.2, mask: 'Spot' });
    // Not rebuilt: the same proxy images are still cached.
    expect((await session.call<{ ids: number[] }>('test_proxy_ids', {})).ids.sort()).toEqual(
      [...proxiesBefore].sort()
    );

    const kept1024 = await preview(image, 1024);
    const kept512 = await preview(image, 512);
    await session.call('test_drop_proxies', { image });
    const rebuilt1024 = await preview(image, 1024);
    const rebuilt512 = await preview(image, 512);
    // The mask is resampled one way when put in and another when rebuilt (512 from the 1024 copy): a level or two at most.
    expect(maxAbsDiff(kept1024, rebuilt1024)).toBeLessThanOrEqual(2);
    expect(maxAbsDiff(kept512, rebuilt512)).toBeLessThanOrEqual(3);
    // And the mask is really there: the masked levels lifts the middle of the spot (x 1200, y 300 of 2400x600, so 512,128 at
    // 1024 wide) and leaves a corner outside it alone.
    const at = (img: ReturnType<typeof readPng>, x: number, y: number) =>
      img.data[(y * img.width + x) * 3]!;
    expect(at(kept1024, 512, 128)).toBeGreaterThan(at(unmasked, 512, 128) + 10);
    expect(Math.abs(at(kept1024, 1000, 10) - at(unmasked, 1000, 10))).toBeLessThanOrEqual(1);
    await session.call('close', { image });
  });

  it('an export counts its own clipped pixels, exactly as the full-resolution histogram does', async () => {
    const { image } = await session.call<{ image: number }>('open', { path: rampPath });
    // A ramp pushed to both ends: its darkest and brightest columns clip.
    await session.call('adjust', { image, type: 'levels', in_low: 30, in_high: 220 });
    const exact = await session.call<{
      pixels: number;
      channels: { luminance: { bins: number[] } };
    }>('histogram', {
      image,
      exact: true,
      channels: ['luminance'],
    });
    const bins = exact.channels.luminance.bins;
    const out = join(workDir, 'clipped.png');
    const result = await session.call<{ clipping?: { pixels: number; low: number; high: number } }>(
      'export',
      { image, path: out }
    );
    expect(result.clipping).toEqual({
      pixels: exact.pixels,
      low: bins[0]! + bins[1]!,
      high: bins[254]! + bins[255]!,
    });
    expect(result.clipping!.low).toBeGreaterThan(0);
    expect(result.clipping!.high).toBeGreaterThan(0);
    // A layered or live save has no flat picture to count.
    const xcf = await session.call<{ clipping?: unknown }>('export', {
      image,
      path: join(workDir, 'clipped.xcf'),
    });
    expect(xcf.clipping).toBeUndefined();
    await session.call('close', { image });
  });
});
