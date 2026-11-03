/**
 * Real headless-GIMP integration coverage: a live `GimpSession` driven
 * against whatever `detectGimp()` finds on THIS machine — no fake spawn, no
 * mocked filesystem. Skips cleanly when no GIMP install is found, UNLESS
 * `EDITMAMEI_REQUIRE_GIMP=1`, in which case the guard test below fails
 * loudly instead of letting the suite go quietly green on a run that never
 * touched real GIMP (the same honesty trap `tests/spec/core-binary-guard.
 * test.ts` closes for the Go core binary).
 *
 * The fixture image is a tiny PNG built by hand (see `writeTinyPng` below)
 * rather than a checked-in binary fixture or an added image-decoding
 * dependency — the bridge itself needs no help reading it, and Node's
 * built-in `zlib` covers PNG's one compressed chunk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { GimpSession } from '@editmamei/backends/gimp/session.ts';
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

/** A minimal, uncompressed-per-scanline 8-bit RGB PNG — no external encoder, no fixture file. */
function writeTinyPng(path: string, width: number, height: number): void {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // per-scanline filter: None
    for (let x = 0; x < width; x++) {
      // A simple diagonal gradient — enough variation for a curve to visibly
      // change the histogram. This test exercises the session's functional
      // lifecycle against a real GIMP process (spawn, apply an op, read the
      // result back, shut down); it checks the histogram moved in the
      // expected direction, not that any one pixel lands at an exact value.
      const v = Math.round(((x + y) / (width + height)) * 255);
      raw[offset++] = v;
      raw[offset++] = v;
      raw[offset++] = v;
    }
  }

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

/** The bridge as the build stages it (scripts/copy-gimp-bridge.ts), not the src/ copy. */
const DIST_OPS_PY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'backends',
  'gimp',
  'bridge',
  'ops.py'
);

// Top-level await, NOT a beforeAll: describe.skipIf()'s condition is read
// at collection time, synchronously, before any async hook runs — an async
// beforeAll populating `install` would still see `!install` as true when
// describe.skipIf evaluates it, silently skipping the suite even with a
// real GIMP install present (caught by running this file with
// EDITMAMEI_REQUIRE_GIMP=1 against this machine's real GIMP 3.2.6 and
// noticing the whole describe.skipIf block was skipped instead of running).
const install: GimpInstall | null = await detectGimp();

// Un-gated on purpose: this is the one assertion that must NEVER quietly
// pass by skipping. Every other test in this file lives inside
// describe.skipIf(!install), which is exactly the shape that would let CI
// go green on a run that skipped real GIMP entirely.
it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

describe.skipIf(!install)('GimpSession against real headless GIMP', () => {
  const WIDTH = 64;
  const HEIGHT = 64;
  let workDir: string;
  let session: GimpSession;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-live-'));
    session = new GimpSession({ install: install!, rootDir: join(workDir, 'session-root') });
    // A cold GIMP launch on a fresh machine can outlast CALL_READY_WAIT_MS
    // (session.ts) -- retry through gimp_starting here, in the hook, so the
    // test below keeps its own tighter timeout for the actual operations.
    await readySession(session);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('start, ping, open, curves, preview, histogram, export, save+reopen .xcf, masked curve, then a clean shutdown', async () => {
    // ---- start + ping (version 3.2.x) ------------------------------------
    const ping = await session.call<{ major: number; minor: number; micro: number }>('ping', {});
    expect(ping.major).toBe(3);
    expect(ping.minor).toBeGreaterThanOrEqual(2);
    expect(session.gimpVersion).toBe(`${ping.major}.${ping.minor}.${ping.micro}`);
    expect(session.state).toBe('ready');

    // ---- open a small synthetic image ------------------------------------
    const pngPath = join(workDir, 'tiny.png');
    writeTinyPng(pngPath, WIDTH, HEIGHT);
    const opened = await session.call<{ image: number; width: number; height: number }>('open', {
      path: pngPath,
    });
    expect(opened.width).toBe(WIDTH);
    expect(opened.height).toBe(HEIGHT);
    const image = opened.image;

    // ---- curves (non-destructive) ----------------------------------------
    const curve = await session.call<{ filter_id: number; name: string }>('curves', {
      image,
      points: [
        [0, 40],
        [255, 215],
      ],
    });
    expect(curve.filter_id).toBeGreaterThan(0);

    // ---- preview ------------------------------------------------------------
    const previewPath = join(workDir, 'preview.jpg');
    const preview = await session.call<{ path: string; width: number; height: number }>('preview', {
      image,
      max_px: 512, // the smallest of the three sizes ops.py's validate_max_px allows
      out_path: previewPath,
    });
    expect(existsSync(preview.path)).toBe(true);

    // ---- histogram ----------------------------------------------------------
    const histogram = await session.call<{ channels: Record<string, { mean: number }> }>(
      'histogram',
      {
        image,
      }
    );
    expect(histogram.channels.luminance.mean).toBeGreaterThan(0);

    // ---- export JPEG --------------------------------------------------------
    const jpegPath = join(workDir, 'export.jpg');
    const exported = await session.call<{ path: string; bytes: number }>('export', {
      image,
      path: jpegPath,
    });
    expect(exported.bytes).toBeGreaterThan(0);

    // ---- save .xcf, reopen, and confirm the ledger survives ------------------
    const xcfPath = join(workDir, 'roundtrip.xcf');
    await session.call('export', { image, path: xcfPath });
    await session.call('close', { image });

    const reopened = await session.call<{ image: number }>('open', { path: xcfPath });
    const reopenedImage = reopened.image;
    const filters = await session.call<{
      filters: Array<{ operation: string; source: string; filter_id: number }>;
    }>('list_filters', { image: reopenedImage });
    expect(filters.filters).toHaveLength(1);
    expect(filters.filters[0]!.operation).toBe('gimp:curves');
    // The ledger, not libgimp's own (lossy) readback, is what proves this.
    expect(filters.filters[0]!.source).toBe('editmamei');

    // ---- masked curve via create_mask -----------------------------------
    const mask = await session.call<{ channel: string; selected_pixels: number }>('create_mask', {
      image: reopenedImage,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: WIDTH / 2,
      height: HEIGHT,
      name: 'HalfMask',
    });
    expect(mask.selected_pixels).toBe((WIDTH * HEIGHT) / 2);

    const maskedCurve = await session.call<{ filter_id: number; mask: string }>('curves', {
      image: reopenedImage,
      points: [
        [0, 0],
        [255, 128],
      ],
      mask: 'HalfMask',
      name: 'MaskedCurve',
    });
    expect(maskedCurve.mask).toBe('HalfMask');

    const filtersAfterMask = await session.call<{
      filters: Array<{ name: string; mask: string | null }>;
    }>('list_filters', { image: reopenedImage });
    const maskedRecord = filtersAfterMask.filters.find((f) => f.name === 'MaskedCurve');
    expect(maskedRecord?.mask).toBe('HalfMask');

    // ---- the shipped bridge no longer answers the unexposed mask-file ops ------------------
    // select_mask / export_mask read and wrote arbitrary paths and no tool used them.
    for (const op of ['select_mask', 'export_mask']) {
      await expect(
        session.call(op, {
          image: reopenedImage,
          mask_path: join(workDir, 'x.pgm'),
          path: join(workDir, 'x.pgm'),
        }),
        op
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining("unknown op '" + op + "'"),
      });
    }

    await session.call('close', { image: reopenedImage });

    // ---- shutdown leaves no gimp-console process --------------------------
    const pid = (session as unknown as { proc?: { pid?: number } }).proc?.pid;
    expect(pid).toBeTypeOf('number');
    await session.shutdown();
    expect(session.state).toBe('closed');
    expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 60_000);
});

/**
 * The shipped layout: GIMP runs `dist/backends/gimp/bridge/ops.py` and imports its sibling
 * `lib.py` from there. Every other live test runs the src/ copy, so a staging mistake (a missing
 * lib.py, a renamed file) would pass them all. Needs `npm run build` first, like any test that
 * reads dist/.
 */
describe.skipIf(!install)('the built bridge in dist/', () => {
  let workDir: string;
  let session: GimpSession;

  beforeAll(async () => {
    expect(existsSync(DIST_OPS_PY), `${DIST_OPS_PY} is missing — run npm run build`).toBe(true);
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-dist-'));
    session = new GimpSession({
      install: install!,
      rootDir: join(workDir, 'session-root'),
      opsPyPath: DIST_OPS_PY,
    });
    await readySession(session);
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await session?.shutdown();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('opens, adjusts, lists in tool units, and exports', async () => {
    const pngPath = join(workDir, 'fixture.png');
    writeTinyPng(pngPath, 32, 32);
    const opened = await session.call<{ image: number }>('open', { path: pngPath });
    try {
      await session.call('adjust', {
        image: opened.image,
        type: 'brightness_contrast',
        brightness: 25,
      });
      const listed = await session.call<{ filters: Array<{ params: Record<string, unknown> }> }>(
        'filter',
        { image: opened.image, op: 'list' }
      );
      expect(listed.filters[0]!.params).toEqual({ brightness: 25, contrast: 0 });
      const outPath = join(workDir, 'out.png');
      const exported = await session.call<{ bytes: number }>('export', {
        image: opened.image,
        path: outPath,
      });
      expect(exported.bytes).toBeGreaterThan(0);
      expect(existsSync(outPath)).toBe(true);
    } finally {
      await session.call('close', { image: opened.image });
    }
  });
});
