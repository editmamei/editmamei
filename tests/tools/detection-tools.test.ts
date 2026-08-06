import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDetectionTools,
  drawBoxes,
  __clearDetectCache,
} from '@editmamei/tools/detection-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import type {
  DetectionClient,
  DetectOptions,
  DetectionResult,
} from '@editmamei/detection/detection-client.ts';
import type { DecodedImage } from '@editmamei/detection/runtime.ts';

// ps_detect (2026-06-22) — local-vision perception. The real client runs
// ONNX models (needs weights + can't run headless in this harness), so the tool
// is tested with an injected fake client; the export-script dispatch + the
// export→doc-pixel mapping are the load-bearing logic verified here.

const EXPORT_RESULT = {
  ok: true,
  export_width: 512,
  export_height: 683,
  doc_width: 3024,
  doc_height: 4032,
  context: { hasDocument: true },
};

const CANNED: DetectionResult = {
  image: { width: 512, height: 683 },
  backends: { faces: 'ultraface', objects: 'dfine-s' },
  faces: [{ bbox: [100, 100, 200, 200], confidence: 0.95 }],
  objects: [{ label: 'dog', class_id: 16, bbox: [50, 50, 400, 600], confidence: 0.8 }],
};

class FakeDetectionClient implements DetectionClient {
  public lastOpts?: DetectOptions;
  public lastPath?: string;
  constructor(private readonly canned: DetectionResult) {}
  async detect(imagePath: string, opts: DetectOptions): Promise<DetectionResult> {
    this.lastPath = imagePath;
    this.lastOpts = opts;
    // Mirror the real client: only the requested streams come back.
    const r: DetectionResult = { image: this.canned.image, backends: {} };
    if (opts.faces) {
      r.faces = this.canned.faces;
      r.backends.faces = 'ultraface';
    }
    if (opts.objects) {
      r.objects = this.canned.objects;
      r.backends.objects = 'dfine-s';
    }
    return r;
  }
}

describe('createDetectionTools', () => {
  let conn: FakePhotoshopConnection;
  beforeEach(() => {
    conn = makeConnection({ result: EXPORT_RESULT });
  });

  const make = (client = new FakeDetectionClient(CANNED)) => ({
    tools: createDetectionTools(conn.asConnection(), makeSnippetClient(), client),
    client,
  });

  it('returns one ps_detect tool', () => {
    const { tools } = make();
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_detect']);
  });

  it('is read-only + idempotent', () => {
    const { tools } = make();
    expect(tools[0].tool.annotations?.readOnlyHint).toBe(true);
    expect(tools[0].tool.annotations?.idempotentHint).toBe(true);
  });

  it('target enumerates faces|objects|both with default both', () => {
    const { tools } = make();
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { target: { enum: string[]; default: string } };
    };
    expect(schema.properties.target.enum).toEqual(['faces', 'objects', 'both']);
    expect(schema.properties.target.default).toBe('both');
  });

  it('dispatches a bounded export script (duplicate → resize → save)', async () => {
    const { tools } = make();
    await callTool(tools, 'ps_detect', { annotate: false });
    const s = conn.lastScript();
    expect(s).toContain('__mcp_detect__');
    expect(s).toContain('resizeImage');
    expect(s).toContain('saveAs');
    expect(s).toContain('doc_width');
  });

  it('forwards max_dimension into the export script', async () => {
    const { tools } = make();
    await callTool(tools, 'ps_detect', { annotate: false, max_dimension: 768 });
    expect(conn.lastScript()).toContain('768');
  });

  it('target=faces requests only faces from the client', async () => {
    const { tools, client } = make();
    await callTool(tools, 'ps_detect', { target: 'faces', annotate: false });
    expect(client.lastOpts).toMatchObject({ faces: true, objects: false });
  });

  it('target=objects requests only objects from the client', async () => {
    const { tools, client } = make();
    await callTool(tools, 'ps_detect', { target: 'objects', annotate: false });
    expect(client.lastOpts).toMatchObject({ faces: false, objects: true });
  });

  it('maps detection boxes from export px to document px', async () => {
    const { tools } = make();
    const res = await callTool(tools, 'ps_detect', { target: 'both', annotate: false });
    const sc = res.structuredContent as {
      image: { width: number; height: number };
      faces: Array<{ bbox: number[] }>;
      objects: Array<{ label: string; bbox: number[] }>;
    };
    expect(sc.image).toEqual({ width: 3024, height: 4032 });
    expect(sc.faces[0].bbox[0]).toBe(Math.round((100 * 3024) / 512));
    expect(sc.faces[0].bbox[2]).toBe(Math.round((200 * 3024) / 512));
    expect(sc.objects[0].label).toBe('dog');
    expect(sc.objects[0].bbox[0]).toBe(Math.round((50 * 3024) / 512));
  });

  it('forwards thresholds + max_objects to the client', async () => {
    const { tools, client } = make();
    await callTool(tools, 'ps_detect', {
      annotate: false,
      face_threshold: 0.5,
      object_threshold: 0.3,
      max_objects: 20,
    });
    expect(client.lastOpts).toMatchObject({
      faceThreshold: 0.5,
      objectThreshold: 0.3,
      maxObjects: 20,
    });
  });

  it('tallies repeated object labels (person×2, dog) in the summary text', async () => {
    const multi: DetectionResult = {
      image: { width: 512, height: 683 },
      backends: { faces: 'ultraface', objects: 'dfine-s' },
      faces: [
        { bbox: [10, 10, 50, 50], confidence: 0.9 },
        { bbox: [60, 10, 100, 50], confidence: 0.88 },
      ],
      objects: [
        { label: 'person', class_id: 0, bbox: [0, 0, 100, 200], confidence: 0.9 },
        { label: 'person', class_id: 0, bbox: [200, 0, 300, 200], confidence: 0.85 },
        { label: 'dog', class_id: 16, bbox: [120, 60, 260, 180], confidence: 0.7 },
      ],
    };
    const tools = createDetectionTools(
      conn.asConnection(),
      makeSnippetClient(),
      new FakeDetectionClient(multi)
    );
    const res = await callTool(tools, 'ps_detect', { target: 'both', annotate: false });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('2 faces');
    expect(text).toContain('3 objects');
    expect(text).toContain('person×2');
    expect(text).toContain('dog');
  });

  it('uses singular wording for a single face', async () => {
    const one: DetectionResult = {
      image: { width: 512, height: 683 },
      backends: { faces: 'ultraface' },
      faces: [{ bbox: [10, 10, 50, 50], confidence: 0.9 }],
    };
    const tools = createDetectionTools(
      conn.asConnection(),
      makeSnippetClient(),
      new FakeDetectionClient(one)
    );
    const res = await callTool(tools, 'ps_detect', { target: 'faces', annotate: false });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('1 face');
    expect(text).not.toContain('1 faces');
  });

  it('annotate:true is non-fatal when the export file is absent (still returns structured)', async () => {
    // The fake connection writes no real export, so drawBoxes' readFile fails;
    // the tool must swallow it and still return the structured detection.
    const { tools } = make();
    const res = await callTool(tools, 'ps_detect', { target: 'both', annotate: true });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as { faces?: unknown[]; objects?: unknown[] };
    expect(sc.faces).toBeDefined();
    expect(sc.objects).toBeDefined();
  });

  it('surfaces a no-document export error as isError', async () => {
    const failing = makeConnection({ throwOnExecute: new Error('No active document') });
    const tools = createDetectionTools(
      failing.asConnection(),
      makeSnippetClient(),
      new FakeDetectionClient(CANNED)
    );
    const res = await callTool(tools, 'ps_detect', { annotate: false });
    expect(res.isError).toBe(true);
  });
});

// ---------- drawBoxes — clone invariant (3-gap-1) ----------
//
// drawBoxes must never mutate the caller's DecodedImage in place (it may be a
// shared, reused-across-calls decode). Two calls on the same image with the
// same boxes must produce byte-identical output AND leave the input `data`
// array byte-identical before/after each call. Deleting the `Uint8Array.from`
// clone inside drawBoxes must fail this test.
describe('drawBoxes — clone invariant', () => {
  it('called twice on the same DecodedImage: byte-identical output, input untouched', () => {
    const w = 10;
    const h = 10;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256; // deterministic, non-trivial fill
    const img: DecodedImage = { width: w, height: h, data };
    const before = Uint8Array.from(data);

    const boxes: Array<{ bbox: [number, number, number, number]; rgb: [number, number, number] }> =
      [{ bbox: [1, 1, 6, 6], rgb: [255, 0, 220] }];

    const out1 = drawBoxes(img, boxes);
    expect(img.data).toEqual(before); // untouched after the first call

    const out2 = drawBoxes(img, boxes);
    expect(img.data).toEqual(before); // still untouched after the second call

    expect(Buffer.compare(out1, out2)).toBe(0); // deterministic, byte-identical output
  });
});

describe('ps_detect warm cache (2026-08-01)', () => {
  // ps_detect had NO cache: two identical back-to-back calls each re-ran full
  // ONNX inference. Measured live 2026-07-30 on a 51MP document — 3,125ms then
  // 3,440ms, the repeat SLOWER. The export+decode round trip still runs (it is
  // the freshness signal); only the inference underneath is skipped.
  //
  // The harness has no real PS export on disk, so decoded pixels are injected
  // through the same detectDeps seam scene-tools uses.
  const PIXELS = new Uint8Array(512 * 683 * 4).fill(7);
  const deps = {
    readFile: async () => Buffer.from([1, 2, 3]),
    decode: (): DecodedImage => ({ data: PIXELS, width: 512, height: 683 }),
  };

  class CountingClient extends FakeDetectionClient {
    public calls = 0;
    async detect(imagePath: string, opts: DetectOptions): Promise<DetectionResult> {
      this.calls++;
      return super.detect(imagePath, opts);
    }
  }

  // The shared EXPORT_RESULT's context is just { hasDocument: true } — no
  // document.name, so docKeyFrom() returns null and samePixelIdentity treats a
  // null docKey as ALWAYS-MISS (deliberate: two different documents on a
  // degraded context must never collide into a false hit). A cache test
  // therefore needs a realistic named-document context.
  const NAMED_EXPORT = {
    ...EXPORT_RESULT,
    context: { hasDocument: true, document: { name: 'cache-fixture.psd' } },
  };

  let conn: FakePhotoshopConnection;
  let client: CountingClient;
  const tools = () => createDetectionTools(conn.asConnection(), makeSnippetClient(), client, deps);

  beforeEach(() => {
    __clearDetectCache();
    conn = makeConnection({ result: NAMED_EXPORT });
    client = new CountingClient(CANNED);
  });

  it('skips ONNX on a pixel-identical repeat but still returns the same boxes', async () => {
    const first = await callTool(tools(), 'ps_detect', { annotate: false });
    const second = await callTool(tools(), 'ps_detect', { annotate: false });
    expect(client.calls).toBe(1);
    // A cache hit must serve real boxes, not the empty result detectActiveDoc
    // returns when inference never ran.
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect((second.structuredContent as { objects?: unknown[] }).objects).toHaveLength(1);
  });

  it('re-runs when the detector OPTIONS change, even on identical pixels', async () => {
    await callTool(tools(), 'ps_detect', { annotate: false });
    await callTool(tools(), 'ps_detect', { annotate: false, object_threshold: 0.9 });
    expect(client.calls).toBe(2);
  });

  it('a cache HIT still draws boxes on the annotated preview', async () => {
    // On a hit detectActiveDoc returns EMPTY detections (inference never ran),
    // so the preview must be drawn from the cached boxes. Drawing from det.raw
    // would silently produce a box-less preview on every repeat call.
    await callTool(tools(), 'ps_detect', { annotate: true });
    const second = await callTool(tools(), 'ps_detect', { annotate: true });
    expect(client.calls).toBe(1);
    const img = second.content.find((c) => c.type === 'image');
    expect(img).toBeDefined();
    // A drawn overlay differs from the untouched export; compare against a
    // no-box render of the same pixels to prove boxes actually landed.
    const bare = drawBoxes({ data: PIXELS, width: 512, height: 683 }, []);
    expect((img as { data: string }).data).not.toBe(bare.toString('base64'));
  });

  it('re-runs when the pixels change', async () => {
    await callTool(tools(), 'ps_detect', { annotate: false });
    const changed = new Uint8Array(512 * 683 * 4).fill(9);
    const movedTools = createDetectionTools(conn.asConnection(), makeSnippetClient(), client, {
      readFile: deps.readFile,
      decode: (): DecodedImage => ({ data: changed, width: 512, height: 683 }),
    });
    await callTool(movedTools, 'ps_detect', { annotate: false });
    expect(client.calls).toBe(2);
  });
});
