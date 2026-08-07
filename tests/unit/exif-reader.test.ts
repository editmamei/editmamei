import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExif } from '@editmamei/utils/exif-reader.ts';

/**
 * Direct tests against the vendored EXIF reader. We build minimal but
 * structurally-valid JPEG and TIFF buffers in-memory so the harness needs
 * no fixture binaries on disk — every byte the test reads is the byte the
 * test wrote.
 */

async function withTempFile<T>(
  name: string,
  body: Buffer,
  fn: (path: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'editmamei-exif-test-'));
  const path = join(dir, name);
  try {
    await writeFile(path, body);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Build a little-endian TIFF buffer containing one IFD0 entry: Make =
 * "Canon\0". Returns the raw TIFF bytes; the caller wraps in JPEG APP1 or
 * uses it as a standalone .tiff body.
 */
function buildTinyTiff(): Buffer {
  // Header: 'II' (LE), magic 0x002A, IFD0 offset = 8
  // IFD0:   count=1, [tag=0x010F (Make), type=2 (ASCII), count=6, value-offset → 'Canon\0' at offset 0x1A]
  // Then 4-byte 'next IFD' offset = 0, then the string at the offset.
  const buf = Buffer.alloc(0x28, 0);
  // header
  buf.writeUInt16LE(0x4949, 0); // 'II'
  buf.writeUInt16LE(0x002a, 2);
  buf.writeUInt32LE(8, 4);
  // IFD0
  buf.writeUInt16LE(1, 8); // entry count
  // entry
  buf.writeUInt16LE(0x010f, 10); // Make tag
  buf.writeUInt16LE(2, 12); // ASCII
  buf.writeUInt32LE(6, 14); // count
  buf.writeUInt32LE(0x1a, 18); // value offset
  // next IFD = 0
  buf.writeUInt32LE(0, 22);
  // string 'Canon\0' at 0x1A
  buf.write('Canon\0', 0x1a, 'latin1');
  return buf;
}

/** Wrap a TIFF body inside a minimal JPEG with APP1 Exif segment. */
function wrapJpegAppOneExif(tiff: Buffer): Buffer {
  const exifPrefix = Buffer.from('Exif\0\0', 'latin1');
  const segPayload = Buffer.concat([exifPrefix, tiff]);
  const segLen = segPayload.length + 2; // 2 bytes for the length field itself
  const segHeader = Buffer.from([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff]);
  const soi = Buffer.from([0xff, 0xd8]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]); // minimal SOS marker
  return Buffer.concat([soi, segHeader, segPayload, sos]);
}

describe('exif-reader', () => {
  it('returns null for unsupported extensions (.psd, .png, .heic, .cr3)', async () => {
    for (const name of ['cover.psd', 'photo.png', 'phone.heic', 'cam.cr3']) {
      const out = await withTempFile(name, Buffer.from([0, 1, 2]), readExif);
      expect(out, name).toBeNull();
    }
  });

  it('reads a Make tag out of a JPEG APP1 EXIF segment', async () => {
    const jpeg = wrapJpegAppOneExif(buildTinyTiff());
    const out = await withTempFile('test.jpg', jpeg, readExif);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({ Make: 'Canon' });
  });

  it('reads a Make tag out of a standalone TIFF file', async () => {
    const out = await withTempFile('raw.tiff', buildTinyTiff(), readExif);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({ Make: 'Canon' });
  });

  it('returns {} for a JPEG whose APP1 segment is missing or unrecognized', async () => {
    // Minimal SOI + SOS only — no APP1 segment.
    const minimal = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    const out = await withTempFile('plain.jpg', minimal, readExif);
    expect(out).toEqual({});
  });

  it('extracts crs:* attributes from an APP1 XMP segment', async () => {
    const xmpPacket = Buffer.from(
      `<?xpacket?><x:xmpmeta xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">` +
        `<rdf:Description crs:Temperature="5500" crs:Exposure2012="0.5" crs:Saturation="-10"/>` +
        `</x:xmpmeta>`,
      'utf8'
    );
    const prefix = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
    const payload = Buffer.concat([prefix, xmpPacket]);
    const segLen = payload.length + 2;
    const header = Buffer.from([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff]);
    const soi = Buffer.from([0xff, 0xd8]);
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02]);
    const jpeg = Buffer.concat([soi, header, payload, sos]);

    const out = await withTempFile('xmp.jpg', jpeg, readExif);
    expect(out).not.toBeNull();
    expect(out!.crs).toMatchObject({
      Temperature: '5500',
      Exposure2012: '0.5',
      Saturation: '-10',
    });
  });

  it('returns null when the JPEG SOI marker is missing (lying extension)', async () => {
    // File claims to be a JPEG but has no SOI — parseJpeg returns null, the
    // caller treats this the same as "unsupported_format" and falls back.
    const notAJpeg = Buffer.from([0x00, 0x00, 0xff, 0xd8]);
    const out = await withTempFile('lying.jpg', notAJpeg, readExif);
    expect(out).toBeNull();
  });
});
