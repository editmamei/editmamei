/**
 * Registry-level end-to-end coverage: drives the registered gimp_* TOOLS
 * (not the bridge/session directly — that's session.live.test.ts's job)
 * through the real `EditmameiServer` / `ToolRegistry` dispatch path, against
 * whatever `detectGimp()` finds on THIS machine. Same skip/require contract
 * as session.live.test.ts (skips cleanly with no GIMP; fails loudly instead
 * of skipping when `EDITMAMEI_REQUIRE_GIMP=1`), duplicated rather than
 * imported so this file makes no change to that one.
 *
 * Path: open -> add_adjustment -> preview -> histogram -> save_xcf ->
 * export -> close, on a small synthetic fixture — exercises tool-layer
 * validation (schema + absolute-path checks), the GimpBackend seam, and the
 * real bridge together, in one pass.
 *
 * Isolation: `homedir()` is mocked to a throwaway temp directory once GIMP
 * detection has run (detection needs the real home), so constructing a real `EditmameiServer` here reads
 * and writes a settings.json / session-log NDJSON under that temp home —
 * never the real `~/.editmamei`. `GimpBackend`'s own root dir follows
 * `userOwnedTempRoot()`, which is `%LOCALAPPDATA%\editmamei\tmp` on Windows
 * (not `homedir()`-derived there), so the GIMP session's own temp files are
 * unaffected by this mock either way.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fx = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  // The real home until fx.home is set: GIMP detection must see the real one (a Flatpak
  // `--user` install lives under it), while the server built below must see the fake one.
  return { ...actual, homedir: () => fx.home || actual.homedir() };
});

import { detectGimp, type GimpInstall } from '@editmamei/backends/gimp/detect.ts';
import { EditmameiServer } from '@editmamei/core/server.ts';
import type { ToolResult } from '@editmamei/core/tool-registry.ts';
import { readyGimpRegistry, LIVE_READY_TIMEOUT_MS } from './support.ts';

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
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

// Top-level await, not beforeAll — see session.live.test.ts's identical
// comment: describe.skipIf() reads its condition at collection time,
// synchronously, before any async hook runs. Detection runs against the REAL
// home (the macOS/Linux detectors look under it); the fake home is set right
// after, before anything constructs a server.
const install: GimpInstall | null = await detectGimp();
fx.home = mkdtempSync(join(tmpdir(), 'em-gimp-registry-e2e-home-'));

it('GIMP must actually be detected when EDITMAMEI_REQUIRE_GIMP=1 (registry e2e)', () => {
  if (!REQUIRE_GIMP) return;
  expect(install, 'EDITMAMEI_REQUIRE_GIMP=1 but detectGimp() found no install').not.toBeNull();
});

describe.skipIf(!install)('gimp_* tools through the real server registry', () => {
  let workDir: string;
  let server: EditmameiServer;
  let registry: {
    execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
    list(): Array<{ name: string }>;
  };

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'em-gimp-registry-e2e-'));
    server = new EditmameiServer({
      editors: {
        registerPhotoshop: false,
        registerGimp: true,
        gimpInstall: install,
        gimpDetectionTimedOut: false,
      },
    });
    registry = (server as unknown as { toolRegistry: typeof registry }).toolRegistry;
    // A cold GIMP launch can outlast CALL_READY_WAIT_MS -- this file drives
    // GIMP through the tool layer, so a slow first launch surfaces as
    // gimp_ping's `starting: true`, not a rejection; retry through that here.
    await readyGimpRegistry((name, args) => registry.execute(name, args));
  }, LIVE_READY_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(fx.home, { recursive: true, force: true });
  });

  it('the GIMP-only boot matrix registered exactly the 17 gimp_* tools plus the shared meta tools', () => {
    const names = registry.list().map((t) => t.name);
    expect(names.filter((n) => n.startsWith('gimp_'))).toHaveLength(17);
    expect(names).toContain('ps_list_capabilities');
    expect(names).toContain('ps_report_problem');
    expect(names).not.toContain('ps_ping');
  });

  it('open -> add_adjustment -> preview -> histogram -> save_xcf -> export -> close', async () => {
    const pngPath = join(workDir, 'tiny.png');
    writeTinyPng(pngPath, 64, 64);

    const openResult = await registry.execute('gimp_open_document', { file_path: pngPath });
    expect(openResult.isError, JSON.stringify(openResult.content)).toBeFalsy();
    const image = (openResult.structuredContent as { image: number }).image;
    expect(typeof image).toBe('number');

    const adjustResult = await registry.execute('gimp_add_adjustment', {
      image,
      type: 'curves',
      points: [
        [0, 40],
        [255, 215],
      ],
    });
    expect(adjustResult.isError, JSON.stringify(adjustResult.content)).toBeFalsy();

    const previewResult = await registry.execute('gimp_get_preview', { image, max_px: 512 });
    expect(previewResult.isError, JSON.stringify(previewResult.content)).toBeFalsy();

    const histogramResult = await registry.execute('gimp_get_histogram', { image });
    expect(histogramResult.isError, JSON.stringify(histogramResult.content)).toBeFalsy();
    const luminanceMean = (
      histogramResult.structuredContent as { channels: { luminance: { mean: number } } }
    ).channels.luminance.mean;
    expect(luminanceMean).toBeGreaterThan(0);

    const xcfPath = join(workDir, 'roundtrip.xcf');
    const saveResult = await registry.execute('gimp_save_xcf', { image, file_path: xcfPath });
    expect(saveResult.isError, JSON.stringify(saveResult.content)).toBeFalsy();
    expect(existsSync(xcfPath)).toBe(true);

    const jpegPath = join(workDir, 'export.jpg');
    const exportResult = await registry.execute('gimp_export', { image, file_path: jpegPath });
    expect(exportResult.isError, JSON.stringify(exportResult.content)).toBeFalsy();
    expect(existsSync(jpegPath)).toBe(true);

    const closeResult = await registry.execute('gimp_close_document', { image });
    expect(closeResult.isError, JSON.stringify(closeResult.content)).toBeFalsy();
  }, 60_000);

  it('gimp_open_document refuses a relative path before ever reaching the bridge', async () => {
    const result = await registry.execute('gimp_open_document', { file_path: 'not-absolute.jpg' });
    expect(result.isError).toBe(true);
  });
});
