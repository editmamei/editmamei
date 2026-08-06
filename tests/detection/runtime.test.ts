import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'jpeg-js';
import { decodeJpeg, decodeJpegBuffer } from '@editmamei/detection/runtime.ts';

// decodeJpeg / decodeJpegBuffer — perf-audit H4 split a single decode path into a
// path-based entry (decodeJpeg, reads + decodes) and a buffer-based entry
// (decodeJpegBuffer, decodes only) so a caller that already holds the export bytes
// in memory (detectActiveDoc) can decode ONCE instead of re-reading the file per
// detector. These pin: both entries agree on the same pixels, both wrap decode
// failures in a descriptive Error (never a raw jpeg-js throw), and decodeJpeg
// really does read from disk (decodeJpegBuffer does not).

function makeJpeg(w: number, h: number, fill: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return encode({ data, width: w, height: h }, 90).data;
}

describe('decodeJpegBuffer', () => {
  it('decodes in-memory JPEG bytes to an RGBA DecodedImage', () => {
    const jpeg = makeJpeg(4, 3, (x) => (x < 2 ? [255, 0, 0] : [0, 0, 255]));
    const img = decodeJpegBuffer(jpeg);
    expect(img.width).toBe(4);
    expect(img.height).toBe(3);
    expect(img.data.length).toBe(4 * 3 * 4);
    // Left half red-ish, right half blue-ish (JPEG is lossy, so approximate).
    expect(img.data[0]).toBeGreaterThan(150); // R at x=0
    expect(img.data[2 * 4 + 2]).toBeGreaterThan(150); // B at x=2
  });

  it('wraps a decode failure in a descriptive Error (never a raw jpeg-js throw)', () => {
    expect(() => decodeJpegBuffer(Buffer.from('not a jpeg'))).toThrow(
      /failed to decode JPEG buffer/
    );
  });
});

describe('decodeJpeg', () => {
  it('reads the file and decodes it — matches decodeJpegBuffer on the same bytes', () => {
    const jpeg = makeJpeg(3, 2, () => [10, 20, 30]);
    const dir = mkdtempSync(join(tmpdir(), 'em-decodejpeg-'));
    const path = join(dir, 'test.jpg');
    writeFileSync(path, jpeg);

    const fromPath = decodeJpeg(path);
    const fromBuffer = decodeJpegBuffer(jpeg);
    expect(fromPath.width).toBe(fromBuffer.width);
    expect(fromPath.height).toBe(fromBuffer.height);
    expect(Array.from(fromPath.data)).toEqual(Array.from(fromBuffer.data));
  });

  it('wraps a missing-file failure in a descriptive Error naming the path', () => {
    const path = join(tmpdir(), 'em-decodejpeg-does-not-exist', 'nope.jpg');
    expect(() => decodeJpeg(path)).toThrow(/failed to decode JPEG at/);
  });

  it('wraps a truncated/non-JPEG file the same way decodeJpegBuffer does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'em-decodejpeg-bad-'));
    const path = join(dir, 'bad.jpg');
    writeFileSync(path, Buffer.from('not a jpeg'));
    expect(() => decodeJpeg(path)).toThrow(/failed to decode JPEG at/);
  });
});
