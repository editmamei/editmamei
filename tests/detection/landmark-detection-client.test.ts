import { describe, it, expect } from 'vitest';
import { OnnxLandmarkDetectionClient } from '@editmamei/detection/landmark-detection-client.ts';
import type {
  BBox,
  DetectionClient,
  DetectOptions,
  DetectionResult,
} from '@editmamei/detection/detection-client.ts';
import type { FaceMeshResult } from '@editmamei/detection/landmark-detector.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';

// OnnxLandmarkDetectionClient composes a base client (boxes) with the face-mesh
// model. The model + decode are injected here so the composition logic — the
// score gate, the per-face failure swallow, the backend-tag append, and the
// only-on-faces guard — is pinned without ONNX weights or a real export.

const POINTS = [
  { x: 1, y: 1, z: 0 },
  { x: 2, y: 2, z: 0 },
];

/** A base client that returns a FRESH result per call (the client mutates it). */
function fakeBase(make: () => DetectionResult): DetectionClient {
  return { detect: async (_p: string, _o: DetectOptions) => make() };
}

function facesResult(facesBackend?: string): DetectionResult {
  return {
    image: { width: 500, height: 400 },
    backends: facesBackend ? { faces: facesBackend } : {},
    faces: [
      { bbox: [10, 10, 50, 50], confidence: 0.9 },
      { bbox: [60, 10, 100, 50], confidence: 0.88 },
    ],
  };
}

const fakeDecode = (): DecodedImage => ({ width: 100, height: 100, data: new Uint8Array(4) });

/** Mesh fn that returns a fixed score, or throws for a given face index. */
function meshFn(score: number, throwAt?: number) {
  let i = 0;
  return async (_img: DecodedImage, _box: BBox): Promise<FaceMeshResult> => {
    const idx = i++;
    if (throwAt === idx) throw new Error('mesh failed for this face');
    return { score, points: POINTS };
  };
}

describe('OnnxLandmarkDetectionClient', () => {
  it('attaches features when the mesh score clears minScore', async () => {
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult('ultraface')),
      { minScore: 0.5 },
      { detectLandmarks: meshFn(0.9), decodeJpeg: fakeDecode }
    );
    const r = await client.detect('x.jpg', { faces: true });
    expect(r.faces?.[0].features).toEqual({ points: POINTS, score: 0.9, backend: 'facemesh-468' });
    expect(r.faces?.[1].features?.backend).toBe('facemesh-468');
  });

  it('omits features below minScore but keeps the box + confidence', async () => {
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult('ultraface')),
      { minScore: 0.6 },
      { detectLandmarks: meshFn(0.4), decodeJpeg: fakeDecode }
    );
    const r = await client.detect('x.jpg', { faces: true });
    expect(r.faces?.[0].features).toBeUndefined();
    expect(r.faces?.[0].bbox).toEqual([10, 10, 50, 50]);
    expect(r.faces?.[0].confidence).toBe(0.9);
  });

  it('uses a default minScore of 0.5 when unset', async () => {
    const pass = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult()),
      {},
      { detectLandmarks: meshFn(0.5), decodeJpeg: fakeDecode }
    );
    expect((await pass.detect('x.jpg', { faces: true })).faces?.[0].features).toBeDefined();
    const fail = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult()),
      {},
      { detectLandmarks: meshFn(0.49), decodeJpeg: fakeDecode }
    );
    expect((await fail.detect('x.jpg', { faces: true })).faces?.[0].features).toBeUndefined();
  });

  it('swallows a per-face mesh failure: that face keeps its box, others get a mesh', async () => {
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult('ultraface')),
      { minScore: 0.5 },
      { detectLandmarks: meshFn(0.9, 0), decodeJpeg: fakeDecode } // throw on face 0
    );
    const r = await client.detect('x.jpg', { faces: true });
    expect(r.faces?.[0].features).toBeUndefined();
    expect(r.faces?.[1].features).toBeDefined();
  });

  it("appends the mesh backend to an existing faces tag ('ultraface' → 'ultraface+facemesh-468')", async () => {
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult('ultraface')),
      {},
      { detectLandmarks: meshFn(0.9), decodeJpeg: fakeDecode }
    );
    expect((await client.detect('x.jpg', { faces: true })).backends.faces).toBe(
      'ultraface+facemesh-468'
    );
  });

  it('sets the faces tag to the mesh backend when there was none', async () => {
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult()),
      {},
      { detectLandmarks: meshFn(0.9), decodeJpeg: fakeDecode }
    );
    expect((await client.detect('x.jpg', { faces: true })).backends.faces).toBe('facemesh-468');
  });

  it('passes the configured margin through to the mesh call', async () => {
    let seen: unknown;
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult()),
      { margin: 0.4 },
      {
        detectLandmarks: async (_img, _box, opts) => {
          seen = opts;
          return { score: 0.9, points: POINTS };
        },
        decodeJpeg: fakeDecode,
      }
    );
    await client.detect('x.jpg', { faces: true });
    expect(seen).toEqual({ margin: 0.4 });
  });

  it('does not decode or run the mesh when faces are not requested', async () => {
    let decoded = 0;
    const objectsOnly: DetectionResult = {
      image: { width: 10, height: 10 },
      backends: { objects: 'dfine-s' },
      objects: [{ label: 'dog', class_id: 16, bbox: [0, 0, 5, 5], confidence: 0.8 }],
    };
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => objectsOnly),
      {},
      {
        detectLandmarks: meshFn(0.9),
        decodeJpeg: () => {
          decoded++;
          return fakeDecode();
        },
      }
    );
    const r = await client.detect('x.jpg', { objects: true });
    expect(decoded).toBe(0);
    expect(r.backends.faces).toBeUndefined();
    expect(r.objects?.[0].label).toBe('dog');
  });

  it('reuses a caller-supplied decoded image instead of decoding again (perf-audit H4)', async () => {
    // detectActiveDoc decodes the export ONCE and threads it through client.detect().
    // When that decoded image is supplied, this client must NOT call its own
    // decodeJpeg — composing detectFaces + detectObjects + the landmark mesh must
    // still cost exactly one decode, not three.
    let decoded = 0;
    const suppliedImg: DecodedImage = { width: 42, height: 24, data: new Uint8Array(4) };
    let seenByMesh: DecodedImage | undefined;
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => facesResult('ultraface')),
      { minScore: 0.5 },
      {
        detectLandmarks: async (img) => {
          seenByMesh = img;
          return { score: 0.9, points: POINTS };
        },
        decodeJpeg: () => {
          decoded++;
          return fakeDecode();
        },
      }
    );
    const r = await client.detect('x.jpg', { faces: true }, suppliedImg);
    expect(decoded).toBe(0); // never called its own decode
    expect(seenByMesh).toBe(suppliedImg); // the mesh ran on the SAME supplied object
    expect(r.faces?.[0].features).toBeDefined();
  });

  it('also threads the supplied decoded image down to the base client', async () => {
    let baseSawDecoded: DecodedImage | undefined;
    const suppliedImg: DecodedImage = { width: 10, height: 10, data: new Uint8Array(4) };
    const base: DetectionClient = {
      detect: async (_p, _o, decodedArg) => {
        baseSawDecoded = decodedArg;
        return facesResult('ultraface');
      },
    };
    const client = new OnnxLandmarkDetectionClient(base, {}, { detectLandmarks: meshFn(0.9) });
    await client.detect('x.jpg', { faces: true }, suppliedImg);
    expect(baseSawDecoded).toBe(suppliedImg);
  });

  it('returns the base result untouched when there are zero faces', async () => {
    let decoded = 0;
    const client = new OnnxLandmarkDetectionClient(
      fakeBase(() => ({
        image: { width: 10, height: 10 },
        backends: { faces: 'ultraface' },
        faces: [],
      })),
      {},
      {
        detectLandmarks: meshFn(0.9),
        decodeJpeg: () => {
          decoded++;
          return fakeDecode();
        },
      }
    );
    const r = await client.detect('x.jpg', { faces: true });
    expect(decoded).toBe(0);
    expect(r.backends.faces).toBe('ultraface');
  });
});
