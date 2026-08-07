/**
 * ps_shape — vector shape layers (m4a Tier-3, dev-tier).
 *
 * Pins the TS→snippet (name, params) forwarding contract. The AM shape descriptors
 * (Rctn/Elps/Ln) are verified live against real Photoshop; these tests cover the
 * arg→go-core param mapping and the per-type validation. Held at dev tier until the
 * coordinate-aiming primitive is strong enough for reliable placement.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createShapeTools } from '@editmamei/tools/shape-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import {
  FakeDetectionClient,
  CANNED,
  CANNED_MESH,
  EXPORT_RESULT,
} from '../fixtures/fake-detection-client.ts';

const textOf = (res: Awaited<ReturnType<typeof callTool>>): string =>
  res.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';

describe('createShapeTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection({
      result: { shape_created: true, shape_type: 'rectangle', layer_name: 'Rectangle 1' },
    });
    snippetClient = makeSnippetClient();
  });

  it('exposes a single tool named ps_shape', () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_shape']);
  });

  it('type enum is rectangle/ellipse/line', () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { type: { enum: string[] } };
    };
    expect(schema.properties.type.enum).toEqual(['rectangle', 'ellipse', 'line']);
  });

  it('rectangle forwards bounds + corner_radius + fill', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_shape', {
      type: 'rectangle',
      left: 10,
      top: 20,
      right: 110,
      bottom: 80,
      corner_radius: 12,
      fill_color: { r: 200, g: 100, b: 50 },
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createShape');
    expect(build.params.shapeType).toBe('rectangle');
    expect(build.params.left).toBe(10);
    expect(build.params.bottom).toBe(80);
    expect(build.params.cornerRadius).toBe(12);
    expect(build.params.fillR).toBe(200);
    expect(build.params.fillG).toBe(100);
    expect(build.params.fillB).toBe(50);
  });

  // ===========================================================================
  // Phase 4 (layer-placement bug) — into_active_group forwarding. The
  // underlying Mk contentLayer descriptor carries no placement target, so
  // with a group active PS nests the new shape layer INSIDE it; the Go
  // emitter hoists it back out by default (into_active_group defaults
  // false). This harness can't observe the emitted JSX (snippetClient.build()
  // is faked to record {name, params} only), so it just pins that the flag
  // reaches the snippet params correctly. See go-core/layer_placement_test.go
  // for the emitted-fragment assertions.
  // ===========================================================================
  it('defaults into_active_group to false when omitted', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_shape', {
      type: 'rectangle',
      left: 0,
      top: 0,
      right: 50,
      bottom: 50,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(false);
  });

  it('forwards into_active_group:true', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_shape', {
      type: 'rectangle',
      left: 0,
      top: 0,
      right: 50,
      bottom: 50,
      into_active_group: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(true);
  });

  it('rectangle forwards a stroke when stroke_width>0', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_shape', {
      type: 'rectangle',
      left: 0,
      top: 0,
      right: 50,
      bottom: 50,
      stroke_width: 4,
      stroke_color: { r: 0, g: 0, b: 255 },
    });
    const build = snippetClient.lastBuild();
    expect(build.params.strokeWidth).toBe(4);
    expect(build.params.strokeB).toBe(255);
  });

  it('ellipse forwards bounds and forces cornerRadius 0', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_shape', {
      type: 'ellipse',
      left: 5,
      top: 5,
      right: 105,
      bottom: 65,
      corner_radius: 99,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.shapeType).toBe('ellipse');
    expect(build.params.cornerRadius).toBe(0);
  });

  it('line forwards endpoints + weight and no stroke params', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_shape', {
      type: 'line',
      start_x: 10,
      start_y: 10,
      end_x: 200,
      end_y: 120,
      weight: 6,
      fill_color: { r: 255, g: 255, b: 255 },
    });
    const build = snippetClient.lastBuild();
    expect(build.params.shapeType).toBe('line');
    expect(build.params.startX).toBe(10);
    expect(build.params.endY).toBe(120);
    expect(build.params.weight).toBe(6);
    expect(build.params.fillR).toBe(255);
    expect(build.params.strokeWidth).toBeUndefined();
  });

  it('rectangle/ellipse error without bounds', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_shape', { type: 'rectangle', left: 0, top: 0 });
    expect(result.isError).toBe(true);
  });

  it('line errors without endpoints', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_shape', { type: 'line', start_x: 0, start_y: 0 });
    expect(result.isError).toBe(true);
  });

  it('fill defaults to black when fill_color omitted', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_shape', { type: 'ellipse', left: 0, top: 0, right: 10, bottom: 10 });
    const build = snippetClient.lastBuild();
    expect(build.params.fillR).toBe(0);
    expect(build.params.fillG).toBe(0);
    expect(build.params.fillB).toBe(0);
  });

  it('surfaces the go-core result as structuredContent', async () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_shape', {
      type: 'rectangle',
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
    });
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.shape_created).toBe(true);
    expect(sc.layer_name).toBe('Rectangle 1');
  });

  // ---- anchor-relational placement ----------------------
  interface PlacementSC {
    placement?: { target?: string; gate?: { pass?: boolean }; geometry?: Record<string, number> };
  }

  it('exposes an anchor-relational placement input', () => {
    const tools = createShapeTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.placement).toBeDefined();
  });

  it('placement: rectangle from a region relation (gap of two dogs) bakes the region bbox', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED);
    const tools = createShapeTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_shape', {
      type: 'rectangle',
      placement: {
        anchors: [
          { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
          { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
        ],
        relation: { type: 'gap', anchors: ['d0', 'd1'] },
      },
      fill_color: { r: 10, g: 20, b: 30 },
    });
    expect(res.isError).toBeUndefined();
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createShape');
    expect(build.params.shapeType).toBe('rectangle');
    // dog0.right=300, dog1.left=600, tops/bottoms 100/300 → the gap bbox.
    expect(build.params.left).toBe(300);
    expect(build.params.top).toBe(100);
    expect(build.params.right).toBe(600);
    expect(build.params.bottom).toBe(300);
    expect(build.params.fillR).toBe(10); // styling still applies over placement geometry
    expect(client.lastOpts).toMatchObject({ objects: true });
    const sc = res.structuredContent as PlacementSC;
    expect(sc.placement?.target).toBe('region');
    expect(sc.placement?.gate?.pass).toBe(true);
  });

  it('placement: line from a path relation (along a landmark lower-lid) bakes the curve endpoints', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED_MESH);
    const tools = createShapeTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_shape', {
      type: 'line',
      weight: 3,
      placement: {
        anchors: [{ id: 'lid', kind: 'landmark', feature: 'left_eye_lower' }],
        relation: { type: 'along', curve: 'lid' },
      },
    });
    expect(res.isError).toBeUndefined();
    const build = snippetClient.lastBuild();
    expect(build.params.shapeType).toBe('line');
    expect(build.params.startX).toBe(300); // lower-lid first point
    expect(build.params.startY).toBe(200);
    expect(build.params.endX).toBe(380); // lower-lid last point
    expect(build.params.endY).toBe(200);
    expect(build.params.weight).toBe(3);
    expect(build.params.strokeWidth).toBeUndefined();
    expect(client.lastOpts).toMatchObject({ faces: true });
  });

  it('placement: line from a segment relation is a line BETWEEN two anchors', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED);
    const tools = createShapeTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_shape', {
      type: 'line',
      placement: {
        anchors: [
          { id: 'a', kind: 'face', pick: 'leftmost' },
          { id: 'b', kind: 'face', pick: 'rightmost' },
        ],
        relation: { type: 'segment', anchors: ['a', 'b'] },
      },
    });
    expect(res.isError).toBeUndefined();
    const build = snippetClient.lastBuild();
    expect(build.params.shapeType).toBe('line');
    // segment between the two face centers (300,300)->(700,700).
    expect(build.params.startX).toBe(300);
    expect(build.params.startY).toBe(300);
    expect(build.params.endX).toBe(700);
    expect(build.params.endY).toBe(700);
  });

  it('placement: a gate REJECT creates no shape and surfaces the reason', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED_MESH);
    const tools = createShapeTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_shape', {
      type: 'line',
      placement: {
        anchors: [
          { id: 'eye', kind: 'landmark', feature: 'left_eye' },
          { id: 'lid', kind: 'landmark', feature: 'left_eye_lower' },
        ],
        relation: {
          type: 'offset-curve',
          curve: 'lid',
          side: 'down',
          distance: { value: 0.5, unit: 'frac-of:eye:h' },
          // the down-offset lands at y=220; a protected band there vetoes the shape.
          exclusion: [280, 210, 400, 240],
        },
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/gate REJECT/);
    expect(snippetClient.allBuilds().some((b) => b.name === 'createShape')).toBe(false);
  });

  it('placement: a rectangle with a point relation errors (needs a region) and creates no shape', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED);
    const tools = createShapeTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_shape', {
      type: 'rectangle',
      placement: {
        anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
        relation: { type: 'centroid', anchor: 'a' },
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/needs a region/);
    expect(snippetClient.allBuilds().some((b) => b.name === 'createShape')).toBe(false);
  });
});
