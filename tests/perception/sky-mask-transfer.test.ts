import { describe, it, expect } from 'vitest';
import {
  loadMaskAsSelection,
  loadSkyMaskAsSelection,
  encodeMaskBmp,
  type MaskSelectionType,
} from '@editmamei/perception/sky-mask-transfer.ts';
import { makeConnection } from '../fixtures/fake-connection.ts';

// BMP header layout constants mirrored here (not imported) so the test pins the
// ACTUAL on-disk byte offsets, not whatever the source happens to compute them as.
const FILE_HEADER_SIZE = 14;
const INFO_HEADER_SIZE = 40;
const PALETTE_SIZE = 256 * 4;
const PIXEL_OFFSET = FILE_HEADER_SIZE + INFO_HEADER_SIZE + PALETTE_SIZE; // 1078

/**
 * loadMaskAsSelection — the tool-agnostic mask→selection loader. The full paste-
 * into-alpha-channel round-trip is live-verified against real PS; here we pin the
 * `selection_type` → ExtendScript `SelectionType` mapping (injection-safe fixed
 * enum names) and the sky back-compat alias.
 */

describe('loadMaskAsSelection', () => {
  const cases: Array<[MaskSelectionType, string]> = [
    ['replace', 'REPLACE'],
    ['add', 'EXTEND'],
    ['subtract', 'DIMINISH'],
    ['intersect', 'INTERSECT'],
  ];

  // The script template carries all four SelectionType branches, so the meaningful
  // signal is the build-time `combine` value the mapping selects (not enum presence).
  it.each(cases)('selection_type "%s" → combine = %s in the load script', async (type, enm) => {
    const conn = makeConnection({ result: { ok: true } });
    await loadMaskAsSelection(conn.asConnection(), new Uint8Array(4), 2, 2, 4, 4, type);
    expect(conn.lastScript()).toContain(`var combine = '${enm}'`);
  });

  it('defaults to REPLACE when no selection_type is given', async () => {
    const conn = makeConnection({ result: { ok: true } });
    await loadMaskAsSelection(conn.asConnection(), new Uint8Array(4), 2, 2, 4, 4);
    expect(conn.lastScript()).toContain("var combine = 'REPLACE'");
  });

  it('a combine op saves the prior selection (probe + store); REPLACE runs unconditionally', async () => {
    // The prior-save is a RUNTIME branch, so the fragment is always in the template —
    // its presence pins that the combine setup wasn't deleted; `combine` gates it live.
    const conn = makeConnection({ result: { ok: true } });
    await loadMaskAsSelection(conn.asConnection(), new Uint8Array(4), 2, 2, 4, 4, 'add');
    const s = conn.lastScript();
    expect(s).toContain('executeActionGet'); // the error-1302-safe selection probe
    expect(s).toContain('orig.selection.store(priorCh)'); // saves the prior before the mask setup
  });

  it('loadSkyMaskAsSelection alias still works (REPLACE, sky recipe back-compat)', async () => {
    const conn = makeConnection({ result: { ok: true } });
    await loadSkyMaskAsSelection(conn.asConnection(), new Uint8Array(4), 2, 2, 4, 4);
    expect(conn.lastScript()).toContain("var combine = 'REPLACE'");
  });

  it('writes the mask to a .bmp temp path (lossless replacement for the old .jpg)', async () => {
    const conn = makeConnection({ result: { ok: true } });
    await loadMaskAsSelection(conn.asConnection(), new Uint8Array(4), 2, 2, 4, 4);
    expect(conn.lastScript()).toContain('mask.bmp');
    expect(conn.lastScript()).not.toContain('mask.jpg');
  });

  it('converts the opened mask doc OUT of Indexed Color (changeMode GRAYSCALE) BEFORE the BICUBIC resizeImage', async () => {
    // encodeMaskBmp writes an 8bpp PALETTIZED bmp, so Photoshop opens it as
    // Indexed Color — a mode where resizeImage's ResampleMethod is ignored and
    // silently degrades to nearest-neighbor. changeMode(GRAYSCALE) must run first
    // or the upscale hard-edges the mask instead of the intended soft BICUBIC.
    const conn = makeConnection({ result: { ok: true } });
    await loadMaskAsSelection(conn.asConnection(), new Uint8Array(4), 2, 2, 4, 4);
    const script = conn.lastScript();
    expect(script).toContain('maskDoc.changeMode(ChangeMode.GRAYSCALE);');
    const changeModeIdx = script.indexOf('maskDoc.changeMode(ChangeMode.GRAYSCALE);');
    const resizeIdx = script.indexOf('maskDoc.resizeImage(');
    expect(changeModeIdx).toBeGreaterThan(-1);
    expect(resizeIdx).toBeGreaterThan(-1);
    expect(changeModeIdx).toBeLessThan(resizeIdx);
  });
});

/**
 * encodeMaskBmp — the hand-rolled uncompressed 8-bit grayscale BMP writer that
 * replaced the RGBA-JPEG-at-q92 mask transport (2026-07-30). 0/255 values must
 * survive pixel-exact — a JPEG-encoded mask rings near hard edges, which this
 * format cannot do (BI_RGB, no compression). Byte offsets are asserted directly
 * against the BITMAPFILEHEADER/BITMAPINFOHEADER spec, not re-derived from source.
 */
describe('encodeMaskBmp', () => {
  it('writes exact BITMAPFILEHEADER + BITMAPINFOHEADER bytes for a known 3x2 mask', () => {
    // row0 (y=0): [1,0,1]; row1 (y=1): [0,1,0] — row-major, w=3.
    const mask = new Uint8Array([1, 0, 1, 0, 1, 0]);
    const rowSize = 4; // 3 bytes padded up to a 4-byte boundary
    const pixelArraySize = rowSize * 2;
    const fileSize = PIXEL_OFFSET + pixelArraySize;

    const buf = encodeMaskBmp(mask, 3, 2);
    expect(buf.length).toBe(fileSize);

    // BITMAPFILEHEADER (14 bytes)
    expect(buf.toString('ascii', 0, 2)).toBe('BM');
    expect(buf.readUInt32LE(2)).toBe(fileSize);
    expect(buf.readUInt32LE(6)).toBe(0); // reserved1 + reserved2
    expect(buf.readUInt32LE(10)).toBe(PIXEL_OFFSET);

    // BITMAPINFOHEADER (40 bytes)
    expect(buf.readUInt32LE(14)).toBe(40); // biSize
    expect(buf.readInt32LE(18)).toBe(3); // biWidth
    expect(buf.readInt32LE(22)).toBe(2); // biHeight — POSITIVE = bottom-up
    expect(buf.readUInt16LE(26)).toBe(1); // biPlanes
    expect(buf.readUInt16LE(28)).toBe(8); // biBitCount (8bpp indexed)
    expect(buf.readUInt32LE(30)).toBe(0); // biCompression = BI_RGB
    expect(buf.readUInt32LE(34)).toBe(pixelArraySize); // biSizeImage
    expect(buf.readInt32LE(38)).toBe(0); // biXPelsPerMeter
    expect(buf.readInt32LE(42)).toBe(0); // biYPelsPerMeter
    expect(buf.readUInt32LE(46)).toBe(256); // biClrUsed
    expect(buf.readUInt32LE(50)).toBe(0); // biClrImportant (0 = all)
  });

  it('writes a 256-entry grayscale (B=G=R=i, reserved=0) palette after the info header', () => {
    const buf = encodeMaskBmp(new Uint8Array([0]), 1, 1);
    const paletteStart = FILE_HEADER_SIZE + INFO_HEADER_SIZE;
    for (const i of [0, 1, 87, 254, 255]) {
      const o = paletteStart + i * 4;
      expect(buf[o]).toBe(i); // blue
      expect(buf[o + 1]).toBe(i); // green
      expect(buf[o + 2]).toBe(i); // red
      expect(buf[o + 3]).toBe(0); // reserved
    }
  });

  it("pixel rows are BOTTOM-UP: the file starts with the mask's LAST row", () => {
    const mask = new Uint8Array([1, 0, 1, 0, 1, 0]); // row0=[1,0,1] row1=[0,1,0]
    const buf = encodeMaskBmp(mask, 3, 2);
    const rowSize = 4;
    // File's first pixel row = image's LAST row (row1 = [0,1,0] → [0,255,0]).
    expect([...buf.subarray(PIXEL_OFFSET, PIXEL_OFFSET + 3)]).toEqual([0, 255, 0]);
    // File's second pixel row = image's FIRST row (row0 = [1,0,1] → [255,0,255]).
    expect([...buf.subarray(PIXEL_OFFSET + rowSize, PIXEL_OFFSET + rowSize + 3)]).toEqual([
      255, 0, 255,
    ]);
  });

  it('pads each row to a 4-byte boundary with zero bytes (width=3 → 1 pad byte/row)', () => {
    const mask = new Uint8Array(6).fill(1); // 3x2, all sky
    const buf = encodeMaskBmp(mask, 3, 2);
    const rowSize = 4;
    expect(buf[PIXEL_OFFSET + 3]).toBe(0); // row0 padding byte
    expect(buf[PIXEL_OFFSET + rowSize + 3]).toBe(0); // row1 padding byte
  });

  it('adds NO padding when width is already a multiple of 4', () => {
    const mask = new Uint8Array(4 * 2).fill(1); // 4x2 — rowSize == width already
    const buf = encodeMaskBmp(mask, 4, 2);
    const pixelArraySize = 4 * 2;
    expect(buf.length).toBe(PIXEL_OFFSET + pixelArraySize);
  });

  it('preserves 0/255 pixel-exact — every pixel byte is 0 or 255, nothing in between', () => {
    const mask = new Uint8Array([1, 0, 0, 1, 0, 1, 1, 0]); // row0=[1,0,0,1] row1=[0,1,1,0]
    const buf = encodeMaskBmp(mask, 4, 2);
    const rowSize = 4;
    // Bottom-up: file row0 = image row1 = [0,1,1,0] → [0,255,255,0].
    expect([...buf.subarray(PIXEL_OFFSET, PIXEL_OFFSET + 4)]).toEqual([0, 255, 255, 0]);
    // file row1 = image row0 = [1,0,0,1] → [255,0,0,255].
    expect([...buf.subarray(PIXEL_OFFSET + rowSize, PIXEL_OFFSET + rowSize + 4)]).toEqual([
      255, 0, 0, 255,
    ]);
    for (const b of buf.subarray(PIXEL_OFFSET)) expect(b === 0 || b === 255).toBe(true);
  });

  // ---------- degenerate inputs (3-gap-5) ----------

  it('throws on w=0 or h=0 — Photoshop cannot open a 0-dimension BMP', () => {
    expect(() => encodeMaskBmp(new Uint8Array(0), 0, 5)).toThrow(/positive integers/);
    expect(() => encodeMaskBmp(new Uint8Array(0), 5, 0)).toThrow(/positive integers/);
    expect(() => encodeMaskBmp(new Uint8Array(0), 0, 0)).toThrow(/positive integers/);
  });

  it('throws on negative or non-integer dimensions', () => {
    expect(() => encodeMaskBmp(new Uint8Array(20), -5, 4)).toThrow(/positive integers/);
    expect(() => encodeMaskBmp(new Uint8Array(20), 5, 4.5)).toThrow(/positive integers/);
  });

  it('throws when the mask is shorter than w*h instead of silently encoding the tail as black', () => {
    // Needs 12 entries (4x3) but only 5 are supplied.
    expect(() => encodeMaskBmp(new Uint8Array(5), 4, 3)).toThrow(/mask\.length/);
  });

  it('does not throw when the mask is exactly w*h (boundary)', () => {
    expect(() => encodeMaskBmp(new Uint8Array(12).fill(1), 4, 3)).not.toThrow();
  });

  it.each([
    [5, 3], // 5 → padded to 8 (3 pad bytes)
    [6, 2], // 6 → padded to 8 (2 pad bytes)
    [7, 1], // 7 → padded to 8 (1 pad byte)
  ])('width=%i pads each row to a 4-byte boundary (%i pad bytes)', (w, padBytes) => {
    const mask = new Uint8Array(w).fill(1);
    const buf = encodeMaskBmp(mask, w, 1);
    const rowSize = (w + 3) & ~3;
    expect(rowSize).toBe(w + padBytes);
    expect(buf.length).toBe(PIXEL_OFFSET + rowSize);
    // The real pixel bytes are all 255 (mask all-1); the padding tail is 0.
    for (let i = 0; i < w; i++) expect(buf[PIXEL_OFFSET + i]).toBe(255);
    for (let i = w; i < rowSize; i++) expect(buf[PIXEL_OFFSET + i]).toBe(0);
  });
});
