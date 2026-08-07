import { describe, it, expect, beforeEach } from 'vitest';
import { createPortraitTools } from '@editmamei/tools/portrait-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import type {
  DetectionClient,
  DetectOptions,
  DetectionResult,
} from '@editmamei/detection/detection-client.ts';

// ps_portrait_touchup orchestrates the face detector + PS primitives;
// the injected fake client supplies face boxes and the assertions pin the
// snippet sequence per op.

const EXPORT_RESULT = {
  ok: true,
  doc_width: 1000,
  doc_height: 800,
  context: { hasDocument: true },
};

const FACES: DetectionResult = {
  image: { width: 500, height: 400 },
  backends: { faces: 'ultraface' },
  faces: [
    { bbox: [100, 100, 200, 220], confidence: 0.99 },
    { bbox: [300, 120, 390, 240], confidence: 0.95 },
  ],
};

class FaceClient implements DetectionClient {
  constructor(private readonly faces = FACES.faces) {}
  async detect(_imagePath: string, opts: DetectOptions): Promise<DetectionResult> {
    const r: DetectionResult = { image: FACES.image, backends: {} };
    if (opts.faces) {
      r.faces = this.faces;
      r.backends.faces = 'ultraface';
    }
    return r;
  }
}

const names = (sc: FakeSnippetClient) => sc.allBuilds().map((b) => b.name);

describe('createPortraitTools', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection({ result: EXPORT_RESULT });
    sc = makeSnippetClient();
  });
  const tools = (client: DetectionClient = new FaceClient()) =>
    createPortraitTools(conn.asConnection(), sc, client);

  it('returns one ps_portrait_touchup tool', () => {
    const t = tools();
    assertToolShape(t);
    expect(t.map((x) => x.tool.name)).toEqual(['ps_portrait_touchup']);
  });

  it('op enumerates dodge_face|soften_skin', () => {
    const schema = tools()[0].tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
    };
    expect(schema.properties.op.enum).toEqual(['dodge_face', 'soften_skin']);
  });

  it('op=dodge_face selects face ellipses, brightens with a masked layer, deselects', async () => {
    await callTool(tools(), 'ps_portrait_touchup', { op: 'dodge_face', amount: 30 });
    const seq = names(sc);
    // 2 faces → 2 selectEllipse (replace then add), then adjustment, then deselect
    expect(seq).toEqual(['selectEllipse', 'selectEllipse', 'addAdjustmentLayer', 'deselect']);
    const adj = sc.allBuilds().find((b) => b.name === 'addAdjustmentLayer');
    expect(adj?.params.type).toBe('brightness_contrast');
    expect(adj?.params.brightness).toBe(30);
    expect(adj?.params.mask_from_selection).toBe(true);
  });

  it('op=soften_skin selects faces, blurs on a duplicate, deselects', async () => {
    await callTool(tools(), 'ps_portrait_touchup', { op: 'soften_skin' });
    expect(names(sc)).toEqual(['selectEllipse', 'selectEllipse', 'applyGaussianBlur', 'deselect']);
    const blur = sc.allBuilds().find((b) => b.name === 'applyGaussianBlur');
    expect(blur?.params.applyToActiveLayer).toBe(false); // auto-duplicate
  });

  it('the first face replaces, additional faces add to the selection', async () => {
    await callTool(tools(), 'ps_portrait_touchup', { op: 'dodge_face' });
    const ell = sc.allBuilds().filter((b) => b.name === 'selectEllipse');
    expect(ell[0].params.selectionType).toBe('replace');
    expect(ell[1].params.selectionType).toBe('add');
  });

  it('no faces detected errors without driving any edit', async () => {
    const res = await callTool(tools(new FaceClient([])), 'ps_portrait_touchup', {
      op: 'dodge_face',
    });
    expect(res.isError).toBe(true);
    expect(names(sc)).not.toContain('addAdjustmentLayer');
  });
});
