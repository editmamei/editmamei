/**
 * Timing measurement against real headless GIMP on a ~24MP synthetic image —
 * the evidence behind `gimp_resize_image` / `gimp_transform_canvas`'s budgets
 * in `operation-timeouts.ts` (see that file's own comment for the numbers
 * and the headroom multiplier). Same skip/require contract as the other
 * `tests/gimp-live` files (skips cleanly with no GIMP; fails loudly instead
 * of skipping when `EDITMAMEI_REQUIRE_GIMP=1`); the PNG-writing helper is
 * duplicated rather than imported so this file makes no change to any
 * existing one.
 *
 * Opt-in: runs only with `EDITMAMEI_GIMP_PERF=1`. It builds a ~217 MP image
 * (several GB of RAM, tens of seconds), which is too heavy for every
 * `npm test` on a machine that happens to have GIMP installed.
 *
 * Always excluded from `npm run test:gimp` (vitest.config.ts) -- even an idle, immediately-
 * skipped describe block is a vitest worker file running alongside the REST of tests/gimp-live,
 * each driving its own real headless GIMP, and the resulting CPU/memory contention both skews
 * this file's own measurements and has pushed an unrelated file's live test past its own timeout.
 * `npm run test:gimp:timing` runs this file alone (still gated by `EDITMAMEI_GIMP_PERF=1` for the
 * heavy work itself); naming the file directly on the command line works the same way.
 *
 * This does not assert exact numbers (real GIMP performance varies by
 * machine) — it asserts each measured operation stays comfortably under the
 * configured budget (with margin, so a legitimately slower CI runner
 * doesn't flake), and prints every measurement so the actual numbers are
 * visible in the test log on every run, not just this session's report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
import {
  TOOL_TIMEOUT_BUDGETS_MS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
} from '@editmamei/utils/operation-timeouts.ts';
import { readySession, LIVE_READY_TIMEOUT_MS } from './support.ts';

const REQUIRE_GIMP = process.env.EDITMAMEI_REQUIRE_GIMP === '1';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** A ~24MP synthetic PNG (6016x4000 — a common photo resolution), same construction as the other gimp-live fixtures, just larger. */
function writeSyntheticPng(path: string, width: number, height: number): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const v = Math.round(((x + y) / (width + height)) * 255);
      raw[offset++] = v;
      raw[offset++] = v;
      raw[offset++] = v;
    }
  }

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    // level 1 (fastest) — this fixture only needs to be a valid, sizeable
    // image, not a small file; compression speed matters more than ratio.
    pngChunk('IDAT', deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  // eslint-disable-next-line no-console -- the whole point: numbers visible in the test log.
  console.log(`[timing] ${label}: ${ms}ms`);
  return { result, ms };
}

const install: GimpInstall | null = await detectGimp();

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (large-image timing)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

const PERF = process.env.EDITMAMEI_GIMP_PERF === '1';

describe.skipIf(!install || !PERF)(
  'gimp_resize_image / gimp_transform_canvas timing budgets',
  () => {
    const WIDTH = 6016;
    const HEIGHT = 4000; // ~24.1 MP
    // Resize up toward the bridge's own cap (250 MP / 30000 px per side,
    // bridge/lib.py's MAX_RESIZE_MEGAPIXELS / MAX_RESIZE_SIDE_PX) — the
    // worst-case direction for both tools' cost.
    const RESIZE_WIDTH = 30_000;
    const RESIZE_HEIGHT = 7_228; // ~216.8 MP

    let workDir: string;
    let session: GimpSession;

    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'em-gimp-large-timing-'));
      session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
      await readySession(session);
    }, LIVE_READY_TIMEOUT_MS);

    afterAll(async () => {
      await session.shutdown();
      rmSync(workDir, { recursive: true, force: true });
    });

    it('open (~24MP) -> resize (-> ~217MP) -> rotate+expand -> export, each within its configured budget (+ generous margin)', async () => {
      // Generous local timeouts for the MEASUREMENT itself — independent of
      // the tool budgets under test, which are asserted against separately
      // below. A hung op should still fail this test rather than hang the
      // whole suite.
      const MEASUREMENT_TIMEOUT_MS = 120_000;

      const pngPath = join(workDir, 'synthetic-24mp.png');
      writeSyntheticPng(pngPath, WIDTH, HEIGHT);

      const { result: opened, ms: openMs } = await timed('open (~24MP)', () =>
        session.call<{ image: number; width: number; height: number }>(
          'open',
          { path: pngPath },
          { timeoutMs: MEASUREMENT_TIMEOUT_MS }
        )
      );
      expect(opened.width).toBe(WIDTH);
      expect(opened.height).toBe(HEIGHT);
      const image = opened.image;

      const { ms: resizeMs } = await timed('resize ~24MP -> ~217MP', () =>
        session.call(
          'resize',
          { image, width: RESIZE_WIDTH, height: RESIZE_HEIGHT },
          { timeoutMs: MEASUREMENT_TIMEOUT_MS }
        )
      );

      const { ms: rotateMs } = await timed('rotate 15deg + expand (on the ~217MP result)', () =>
        session.call(
          'rotate',
          { image, degrees: 15, expand: true },
          { timeoutMs: MEASUREMENT_TIMEOUT_MS }
        )
      );

      const jpegPath = join(workDir, 'export-large.jpg');
      const { ms: exportMs } = await timed('export the ~217MP result (JPEG)', () =>
        session.call('export', { image, path: jpegPath }, { timeoutMs: MEASUREMENT_TIMEOUT_MS })
      );

      await session.call('close', { image }, { timeoutMs: MEASUREMENT_TIMEOUT_MS });

      // The actual assertion: every measured op fits comfortably inside its
      // tool's configured budget, cold-start included in the budget's own
      // headroom (this session already paid cold start on `open`, so these
      // numbers are the SAME shape a real gimp_resize_image /
      // gimp_transform_canvas call would see after the first gimp_* call of
      // a session). A margin factor (not an exact bound) keeps this from
      // flaking on a legitimately slower CI runner while still catching a
      // real regression (an op suddenly taking 5-10x longer).
      const MARGIN = 0.7; // measured must stay under 70% of the budget
      const resizeBudget = TOOL_TIMEOUT_BUDGETS_MS.gimp_resize_image ?? DEFAULT_SCRIPT_TIMEOUT_MS;
      const transformBudget =
        TOOL_TIMEOUT_BUDGETS_MS.gimp_transform_canvas ?? DEFAULT_SCRIPT_TIMEOUT_MS;

      expect(openMs, 'open').toBeLessThan(resizeBudget); // sanity — open alone must be cheap
      expect(resizeMs, 'resize (gimp_resize_image budget)').toBeLessThan(resizeBudget * MARGIN);
      expect(rotateMs, 'rotate (gimp_transform_canvas budget)').toBeLessThan(
        transformBudget * MARGIN
      );
      // export has its own generous budget (gimp_export); sanity-checked
      // here too since it ran on the same large result.
      const exportBudget = TOOL_TIMEOUT_BUDGETS_MS.gimp_export ?? DEFAULT_SCRIPT_TIMEOUT_MS;
      expect(exportMs, 'export').toBeLessThan(exportBudget * MARGIN);
    }, 180_000);

    it('gimp_select / gimp_modify_selection / gimp_layer_mask / gimp_get_selection_preview, each within its configured budget (+ generous margin)', async () => {
      const MEASUREMENT_TIMEOUT_MS = 120_000;

      const pngPath = join(workDir, 'synthetic-24mp-selection.png');
      writeSyntheticPng(pngPath, WIDTH, HEIGHT);
      const opened = await session.call<{ image: number }>(
        'open',
        { path: pngPath },
        { timeoutMs: MEASUREMENT_TIMEOUT_MS }
      );
      const image = opened.image;

      // Several live filters, stacked -- `color_range`'s sample_merged path reads the full
      // COMPOSITE (a whole-image duplicate + flatten through every live filter), so this is the
      // realistic worst case, not just a flat unfiltered image.
      await session.call(
        'adjust',
        { image, type: 'exposure', exposure: 0.5 },
        { timeoutMs: MEASUREMENT_TIMEOUT_MS }
      );
      await session.call(
        'adjust',
        { image, type: 'brightness_contrast', brightness: 20, contrast: 10 },
        { timeoutMs: MEASUREMENT_TIMEOUT_MS }
      );
      await session.call(
        'adjust',
        { image, type: 'gaussian_blur', radius: 5 },
        { timeoutMs: MEASUREMENT_TIMEOUT_MS }
      );

      const { ms: selectRectMs } = await timed(
        'gimp_select mode=rectangle (~24MP, 3 live filters)',
        () =>
          session.call(
            'select',
            {
              image,
              mode: 'rectangle',
              x: 0,
              y: 0,
              width: WIDTH,
              height: HEIGHT,
              name: 'PerfRect',
            },
            { timeoutMs: MEASUREMENT_TIMEOUT_MS }
          )
      );

      // The worst case for color_range's sample-point path: sample_merged reads the full
      // composite via `Image.pick_color` over every live filter (see ops.py's `_color_arg`).
      const { ms: selectColorMs } = await timed(
        'gimp_select mode=color_range by sample point, sample_merged (~24MP, 3 live filters)',
        () =>
          session.call(
            'select',
            { image, mode: 'color_range', x: 100, y: 100, sample_merged: true, name: 'PerfColor' },
            { timeoutMs: MEASUREMENT_TIMEOUT_MS }
          )
      );

      // The worst case for expand/contract/border: `border` (the most expensive of the three,
      // measured live) at px = MAX_MORPHOLOGY_PX (150, bridge/lib.py) -- the bridge's own cap,
      // chosen specifically so this stays well inside the tool's budget (see
      // operation-timeouts.ts's gimp_modify_selection comment for the scaling data behind it).
      const { ms: modifyMs } = await timed('gimp_modify_selection op=border px=150 (~24MP)', () =>
        session.call(
          'modify_mask',
          { image, channel: 'PerfRect', op: 'border', px: 150 },
          { timeoutMs: MEASUREMENT_TIMEOUT_MS }
        )
      );

      const { ms: layerMaskMs } = await timed(
        'gimp_layer_mask op=create from a channel (~24MP)',
        () =>
          session.call(
            'layer_mask',
            { image, op: 'create', source: 'channel', channel: 'PerfRect' },
            { timeoutMs: MEASUREMENT_TIMEOUT_MS }
          )
      );

      const previewPath = join(workDir, 'selection-preview-perf.jpg');
      const { ms: previewMs } = await timed(
        'gimp_get_selection_preview at max_px=2048 (~24MP)',
        () =>
          session.call(
            'mask_preview',
            { image, channel: 'PerfRect', max_px: 2048, out_path: previewPath },
            { timeoutMs: MEASUREMENT_TIMEOUT_MS }
          )
      );

      await session.call('close', { image }, { timeoutMs: MEASUREMENT_TIMEOUT_MS });

      const MARGIN = 0.7;
      const budget = (name: string) => TOOL_TIMEOUT_BUDGETS_MS[name] ?? DEFAULT_SCRIPT_TIMEOUT_MS;
      expect(selectRectMs, 'gimp_select (rectangle)').toBeLessThan(budget('gimp_select') * MARGIN);
      expect(selectColorMs, 'gimp_select (color_range sample_merged)').toBeLessThan(
        budget('gimp_select') * MARGIN
      );
      expect(modifyMs, 'gimp_modify_selection').toBeLessThan(
        budget('gimp_modify_selection') * MARGIN
      );
      expect(layerMaskMs, 'gimp_layer_mask').toBeLessThan(budget('gimp_layer_mask') * MARGIN);
      expect(previewMs, 'gimp_get_selection_preview').toBeLessThan(
        budget('gimp_get_selection_preview') * MARGIN
      );
    }, 180_000);

    it(
      'gimp_select (sample point) and gimp_modify_selection (border, the morphology cap) on the ' +
        'largest document the bridge allows (~217MP)',
      async () => {
        const MEASUREMENT_TIMEOUT_MS = 180_000;

        const pngPath = join(workDir, 'synthetic-24mp-for-resize.png');
        writeSyntheticPng(pngPath, WIDTH, HEIGHT);
        const opened = await session.call<{ image: number }>(
          'open',
          { path: pngPath },
          { timeoutMs: MEASUREMENT_TIMEOUT_MS }
        );
        const image = opened.image;
        await session.call(
          'resize',
          { image, width: RESIZE_WIDTH, height: RESIZE_HEIGHT },
          { timeoutMs: MEASUREMENT_TIMEOUT_MS }
        );

        // Same worst case as the ~24MP measurement above: sample_merged reads the full composite.
        const { ms: selectColorMs } = await timed(
          'gimp_select mode=color_range by sample point, sample_merged (~217MP)',
          () =>
            session.call(
              'select',
              {
                image,
                mode: 'color_range',
                x: 100,
                y: 100,
                sample_merged: true,
                name: 'PerfColorBig',
              },
              { timeoutMs: MEASUREMENT_TIMEOUT_MS }
            )
        );

        await session.call(
          'select',
          {
            image,
            mode: 'rectangle',
            x: 0,
            y: 0,
            width: RESIZE_WIDTH,
            height: RESIZE_HEIGHT,
            name: 'PerfRectBig',
          },
          { timeoutMs: MEASUREMENT_TIMEOUT_MS }
        );
        // The most expensive morphological op (border, measured live), run at the bridge's OWN
        // document-scaled cap for ~217MP (`lib.effective_morphology_px`, bridge/lib.py) -- 17px,
        // not the flat 150 a smaller document gets. A flat 150px cap measured live at ~30s on
        // ~24MP, ~73.5s on ~100MP, and an outright GIMP session timeout past 180s on this same
        // ~217MP document -- the scaling fix is what keeps this call inside budget at all.
        const SCALED_MORPHOLOGY_PX = 17;
        const { ms: borderMs } = await timed(
          `gimp_modify_selection op=border px=${SCALED_MORPHOLOGY_PX} (~217MP, the scaled morphology cap)`,
          () =>
            session.call(
              'modify_mask',
              { image, channel: 'PerfRectBig', op: 'border', px: SCALED_MORPHOLOGY_PX },
              { timeoutMs: MEASUREMENT_TIMEOUT_MS }
            )
        );

        await session.call('close', { image }, { timeoutMs: MEASUREMENT_TIMEOUT_MS });

        const MARGIN = 0.7;
        const budget = (name: string) => TOOL_TIMEOUT_BUDGETS_MS[name] ?? DEFAULT_SCRIPT_TIMEOUT_MS;
        expect(selectColorMs, 'gimp_select (color_range sample_merged, ~217MP)').toBeLessThan(
          budget('gimp_select') * MARGIN
        );
        expect(borderMs, 'gimp_modify_selection (border at the scaled cap, ~217MP)').toBeLessThan(
          budget('gimp_modify_selection') * MARGIN
        );
      },
      240_000
    );
  }
);
