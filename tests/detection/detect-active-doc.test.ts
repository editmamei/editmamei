import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectActiveDoc,
  type DetectActiveDocDeps,
} from '@editmamei/detection/detect-active-doc.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { FakeDetectionClient, CANNED, EXPORT_RESULT } from '../fixtures/fake-detection-client.ts';

/**
 * detectActiveDoc — perf-audit H4's decode-once seam. The real flow (export via a
 * PS round trip, read the file, decode it) can't run in the unit harness (no real
 * PS export lands on disk), so `readFile`/`decode` are injectable — this proves the
 * decode-once invariant with a spy instead of a real JPEG: the export is read
 * EXACTLY once and decoded EXACTLY once regardless of what's requested (faces /
 * objects / both — the shape scene-model.ts always uses), and the SAME decoded
 * object is threaded into client.detect() instead of the detector re-decoding.
 */

const FAKE_DECODED: DecodedImage = { width: 512, height: 683, data: new Uint8Array(4) };

function countingDeps(overrides: Partial<DetectActiveDocDeps> = {}): {
  deps: DetectActiveDocDeps;
  readCount: () => number;
  decodeCount: () => number;
} {
  let reads = 0;
  let decodes = 0;
  const deps: DetectActiveDocDeps = {
    readFile: async (path: string) => {
      reads++;
      return overrides.readFile ? overrides.readFile(path) : Buffer.from('fake-jpeg-bytes');
    },
    decode: (bytes: Buffer) => {
      decodes++;
      return overrides.decode ? overrides.decode(bytes) : FAKE_DECODED;
    },
  };
  return { deps, readCount: () => reads, decodeCount: () => decodes };
}

describe('detectActiveDoc — decode-once (perf-audit H4)', () => {
  let conn: FakePhotoshopConnection;
  beforeEach(() => {
    conn = makeConnection({ result: EXPORT_RESULT });
  });

  it('reads the export exactly once and decodes it exactly once for a detect-both pass', async () => {
    const { deps, readCount, decodeCount } = countingDeps();
    const client = new FakeDetectionClient(CANNED);
    await detectActiveDoc(conn.asConnection(), client, { faces: true, objects: true }, deps);
    expect(readCount()).toBe(1);
    expect(decodeCount()).toBe(1);
  });

  it('still decodes exactly once for the read-scene-shaped opts (faces+objects+thresholds)', async () => {
    // scene-model.ts's buildSceneModel always calls detectActiveDoc with this exact
    // opts shape — pin that it doesn't cost more decodes than the plain both-pass.
    const { deps, readCount, decodeCount } = countingDeps();
    const client = new FakeDetectionClient(CANNED);
    await detectActiveDoc(
      conn.asConnection(),
      client,
      { faces: true, objects: true, maxDimension: 1024, objectThreshold: 0.4, faceThreshold: 0.7 },
      deps
    );
    expect(readCount()).toBe(1);
    expect(decodeCount()).toBe(1);
  });

  it('decodes exactly once even when only one modality is requested', async () => {
    const facesOnly = countingDeps();
    await detectActiveDoc(
      conn.asConnection(),
      new FakeDetectionClient(CANNED),
      { faces: true, objects: false },
      facesOnly.deps
    );
    expect(facesOnly.decodeCount()).toBe(1);

    const objectsOnly = countingDeps();
    await detectActiveDoc(
      conn.asConnection(),
      new FakeDetectionClient(CANNED),
      { faces: false, objects: true },
      objectsOnly.deps
    );
    expect(objectsOnly.decodeCount()).toBe(1);
  });

  it('threads the SAME decoded object into client.detect() (no re-decode downstream)', async () => {
    const { deps } = countingDeps();
    const client = new FakeDetectionClient(CANNED);
    const res = await detectActiveDoc(
      conn.asConnection(),
      client,
      { faces: true, objects: true },
      deps
    );
    expect(res.decoded).toBe(FAKE_DECODED);
    expect(client.lastDecoded).toBe(FAKE_DECODED); // the exact same reference, not a copy
  });

  it('a decode failure is non-fatal: decoded is undefined, detection still returns', async () => {
    const { deps } = countingDeps({
      decode: () => {
        throw new Error('bad jpeg');
      },
    });
    const client = new FakeDetectionClient(CANNED);
    const res = await detectActiveDoc(
      conn.asConnection(),
      client,
      { faces: true, objects: true },
      deps
    );
    expect(res.decoded).toBeUndefined();
    expect(client.lastDecoded).toBeUndefined();
    expect(res.result.faces).toBeDefined(); // detection itself still succeeded
  });

  it('a readFile failure is non-fatal and skips the decode attempt entirely', async () => {
    let decodeCalls = 0;
    const deps: DetectActiveDocDeps = {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      decode: () => {
        decodeCalls++;
        return FAKE_DECODED;
      },
    };
    const res = await detectActiveDoc(
      conn.asConnection(),
      new FakeDetectionClient(CANNED),
      { faces: true, objects: true },
      deps
    );
    expect(res.exportBytes.length).toBe(0);
    expect(res.decoded).toBeUndefined();
    expect(decodeCalls).toBe(0); // never attempted a decode on empty bytes
  });

  it('defaults to the real fs read + real jpeg-js decode when no deps are injected', async () => {
    // No deps → readFile(tempPath) hits a real (nonexistent) temp file and fails
    // non-fatally, same as the pre-refactor "annotate is non-fatal" behavior.
    const res = await detectActiveDoc(conn.asConnection(), new FakeDetectionClient(CANNED), {
      faces: true,
      objects: true,
    });
    expect(res.exportBytes.length).toBe(0);
    expect(res.decoded).toBeUndefined();
    expect(res.result.faces).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // shouldDetect — the warm-cache seam (scene-model.ts's pixel-identity cache).
  // ---------------------------------------------------------------------------

  describe('shouldDetect — the warm-cache skip seam', () => {
    it('calling shouldDetect returning false skips client.detect() entirely', async () => {
      const { deps } = countingDeps();
      let calls = 0;
      class CountingClient extends FakeDetectionClient {
        override async detect(
          p: string,
          o: Parameters<FakeDetectionClient['detect']>[1],
          d?: DecodedImage
        ) {
          calls++;
          return super.detect(p, o, d);
        }
      }
      const client = new CountingClient(CANNED);
      const res = await detectActiveDoc(
        conn.asConnection(),
        client,
        { faces: true, objects: true, shouldDetect: () => false },
        deps
      );
      expect(calls).toBe(0);
      expect(res.result.faces).toBeUndefined();
      expect(res.result.objects).toBeUndefined();
      // Export + decode still happened — the freshness probe is never skipped.
      expect(res.decoded).toBe(FAKE_DECODED);
      expect(res.raw.image).toEqual({ width: FAKE_DECODED.width, height: FAKE_DECODED.height });
    });

    it('shouldDetect returning true (or the option being omitted) detects normally', async () => {
      const { deps } = countingDeps();
      const client = new FakeDetectionClient(CANNED);
      const res = await detectActiveDoc(
        conn.asConnection(),
        client,
        { faces: true, objects: true, shouldDetect: () => true },
        deps
      );
      expect(res.result.faces).toBeDefined();
      expect(client.lastDecoded).toBe(FAKE_DECODED);
    });

    it('shouldDetect receives the decoded pixels, the export context, and doc dimensions', async () => {
      const { deps } = countingDeps();
      const client = new FakeDetectionClient(CANNED);
      let seen: {
        decoded: DecodedImage | undefined;
        context: Record<string, unknown> | undefined;
        docWidth: number;
        docHeight: number;
      } | null = null;
      await detectActiveDoc(
        conn.asConnection(),
        client,
        {
          faces: true,
          objects: true,
          shouldDetect: (info) => {
            seen = info;
            return true;
          },
        },
        deps
      );
      expect(seen).not.toBeNull();
      expect(seen!.decoded).toBe(FAKE_DECODED);
      expect(seen!.docWidth).toBe(EXPORT_RESULT.doc_width);
      expect(seen!.docHeight).toBe(EXPORT_RESULT.doc_height);
      expect(seen!.context).toEqual(EXPORT_RESULT.context);
    });

    it('an undecodable export still calls shouldDetect, with decoded undefined', async () => {
      const deps: DetectActiveDocDeps = {
        readFile: async () => Buffer.from('fake'),
        decode: () => {
          throw new Error('bad jpeg');
        },
      };
      const client = new FakeDetectionClient(CANNED);
      let sawDecoded: DecodedImage | undefined = FAKE_DECODED; // sentinel, overwritten below
      await detectActiveDoc(
        conn.asConnection(),
        client,
        {
          faces: true,
          objects: true,
          shouldDetect: (info) => {
            sawDecoded = info.decoded;
            return true;
          },
        },
        deps
      );
      expect(sawDecoded).toBeUndefined();
    });

    it('a shouldDetect that THROWS degrades to detecting normally (2f / 3-gap-3)', async () => {
      const { deps } = countingDeps();
      let calls = 0;
      class CountingClient extends FakeDetectionClient {
        override async detect(
          p: string,
          o: Parameters<FakeDetectionClient['detect']>[1],
          d?: DecodedImage
        ) {
          calls++;
          return super.detect(p, o, d);
        }
      }
      const client = new CountingClient(CANNED);
      const res = await detectActiveDoc(
        conn.asConnection(),
        client,
        {
          faces: true,
          objects: true,
          shouldDetect: () => {
            throw new Error('boom');
          },
        },
        deps
      );
      expect(calls).toBe(1); // degraded to detect, not skipped
      expect(res.result.faces).toBeDefined();
    });
  });
});
