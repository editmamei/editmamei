import { describe, it, expect, beforeEach } from 'vitest';
import { createImageTools } from '@editmamei/tools/image-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { FakeDetectionClient, CANNED, EXPORT_RESULT } from '../fixtures/fake-detection-client.ts';

const textOf = (res: Awaited<ReturnType<typeof callTool>>): string =>
  res.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';

describe('createImageTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 3 well-formed tools', () => {
    const tools = createImageTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual([
      'ps_resize_image',
      'ps_crop_document',
      'ps_convert_image_mode',
    ]);
  });

  // 2026-06-20 — convert_image_mode (dev tier, from gap-backlog capture STEP-35).
  it('convert_image_mode dispatches convertImageMode with the mode', async () => {
    const tools = createImageTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_convert_image_mode', { mode: 'grayscale' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('convertImageMode');
    expect(build.params.mode).toBe('grayscale');
  });

  // 2026-06-20 — bitmap mode forwards the halftone screen params (STEP-36).
  it('convert_image_mode bitmap forwards halftone frequency/angle/shape', async () => {
    const tools = createImageTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_convert_image_mode', {
      mode: 'bitmap',
      frequency: 53,
      angle: 45,
      shape: 'round',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('convertImageMode');
    expect(build.params.mode).toBe('bitmap');
    expect(build.params.frequency).toBe(53);
    expect(build.params.shape).toBe('round');
  });

  it('resize_image embeds dimensions', async () => {
    const tools = createImageTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_resize_image', { width: 1024, height: 768 });
    const script = conn.lastScript();
    expect(script).toContain('1024');
    expect(script).toContain('768');
  });

  it('crop_document embeds the bounding box', async () => {
    const tools = createImageTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_crop_document', {
      left: 10,
      top: 20,
      right: 110,
      bottom: 220,
    });
    const script = conn.lastScript();
    for (const n of ['10', '20', '110', '220']) {
      expect(script).toContain(n);
    }
  });

  // ---- anchor-relational placement ----------------------
  it('crop placement: a region relation (gap of two dogs) crops to the region bbox', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED);
    const tools = createImageTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_crop_document', {
      placement: {
        anchors: [
          { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
          { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
        ],
        relation: { type: 'gap', anchors: ['d0', 'd1'] },
      },
    });
    expect(res.isError).toBeUndefined();
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('cropDocument');
    expect(build.params).toMatchObject({ left: 300, top: 100, right: 600, bottom: 300 });
    const sc = res.structuredContent as {
      placement?: { target?: string; gate?: { pass?: boolean } };
    };
    expect(sc.placement?.target).toBe('region');
    expect(sc.placement?.gate?.pass).toBe(true);
    expect(client.lastOpts).toMatchObject({ objects: true });
  });

  it('crop placement: a point relation errors (needs a region) and crops nothing', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED);
    const tools = createImageTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_crop_document', {
      placement: {
        anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
        relation: { type: 'centroid', anchor: 'a' },
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/needs a region/);
    expect(snippetClient.allBuilds().some((b) => b.name === 'cropDocument')).toBe(false);
  });

  it('crop errors when given neither placement nor bounds', async () => {
    const tools = createImageTools(conn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_crop_document', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/placement/);
  });
});
