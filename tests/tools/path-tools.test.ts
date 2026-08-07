/**
 * ps_path — the path-interchange surface.
 *
 * These unit tests pin the TS→snippet (name, params) forwarding contract for
 * each op. The ExtendScript body (DOM makeWorkPath / makeSelection / strokePath /
 * fillPath / makeClippingPath, the savePath AM idiom) is validated by the Go
 * binary + live-smoke against a real Photoshop — these tests do not launch PS.
 *
 * Tier: 'dev' at landing per the dev-default-then-promote gate.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createPathTools } from '@editmamei/tools/path-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import {
  FakeDetectionClient,
  CANNED_MESH,
  EXPORT_RESULT,
} from '../fixtures/fake-detection-client.ts';

describe('createPathTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    // A generic result covering every field the per-op summary reads, so
    // callTool runs cleanly through the handler and we can assert lastBuild().
    conn = makeConnection({
      result: {
        created: true,
        saved: true,
        deleted: true,
        loaded: true,
        stroked: true,
        filled: true,
        clipping_path_set: true,
        name: 'Path 1',
        path_name: 'Path 1',
        tolerance: 2,
        operation: 'replace',
        tool: 'brush',
        mode: 'normal',
        count: 1,
        target_was_copy: true,
        target_layer_name: 'Stroke Path (Background)',
        path_info: { count: 1, paths: [{ name: 'Path 1', kind: 'work', subpaths: 1, anchors: 4 }] },
      },
    });
    snippetClient = makeSnippetClient();
  });

  it('exposes a single well-formed tool named ps_path', () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_path']);
  });

  it('op enum exposes all nine path operations', () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
    };
    expect(new Set(schema.properties.op.enum)).toEqual(
      new Set([
        'create_from_selection',
        'create_from_placement',
        'save',
        'list',
        'delete',
        'load_as_selection',
        'stroke',
        'fill',
        'set_clipping',
      ])
    );
  });

  it('is marked destructive (stroke/fill bake pixels) and non-idempotent', () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    const ann = tools[0].tool.annotations;
    expect(ann?.destructiveHint).toBe(true);
    expect(ann?.idempotentHint).toBe(false);
  });

  // ---------- per-op snippet dispatch ----------

  it('create_from_selection → createPathFromSelection with the tolerance', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'create_from_selection', tolerance: 4 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createPathFromSelection');
    expect(build.params.tolerance).toBe(4);
  });

  it('create_from_selection defaults tolerance to 2', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'create_from_selection' });
    expect(snippetClient.lastBuild().params.tolerance).toBe(2);
  });

  it('save → savePath with the name', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'save', name: 'Outline' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('savePath');
    expect(build.params.name).toBe('Outline');
  });

  it('save without a name returns an actionable isError (no snippet dispatched)', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_path', { op: 'save' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/requires a "name"/);
    expect(snippetClient.allBuilds()).toHaveLength(0);
  });

  it('list → listPaths with no params', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'list' });
    expect(snippetClient.lastBuild().name).toBe('listPaths');
  });

  it('delete with a name → deletePath carrying the name', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'delete', name: 'Old Path' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('deletePath');
    expect(build.params.name).toBe('Old Path');
  });

  it('delete without a name → deletePath with no name (targets the work path)', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'delete' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('deletePath');
    expect(build.params.name).toBeUndefined();
  });

  it('load_as_selection → loadPathAsSelection forwarding feather/antiAlias/operation', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', {
      op: 'load_as_selection',
      name: 'Outline',
      feather: 3,
      anti_alias: false,
      operation: 'add',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('loadPathAsSelection');
    expect(build.params).toMatchObject({
      name: 'Outline',
      feather: 3,
      antiAlias: false,
      operation: 'add',
    });
  });

  it('load_as_selection without a name omits it (targets the work path) + defaults', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'load_as_selection' });
    const build = snippetClient.lastBuild();
    expect(build.params.name).toBeUndefined();
    expect(build.params.feather).toBe(0);
    expect(build.params.antiAlias).toBe(true);
    expect(build.params.operation).toBe('replace');
  });

  it('stroke → strokePath forwarding tool + applyToActiveLayer', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', {
      op: 'stroke',
      tool: 'pencil',
      apply_to_active_layer: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('strokePath');
    expect(build.params.tool).toBe('pencil');
    expect(build.params.applyToActiveLayer).toBe(true);
  });

  it('stroke defaults: tool=brush, applyToActiveLayer=false', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'stroke' });
    const build = snippetClient.lastBuild();
    expect(build.params.tool).toBe('brush');
    expect(build.params.applyToActiveLayer).toBe(false);
  });

  it('fill → fillPath forwarding rgb color + opacity + mode + antiAlias + applyToActiveLayer', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', {
      op: 'fill',
      color: { red: 10, green: 20, blue: 30 },
      opacity: 80,
      mode: 'multiply',
      feather: 2,
      anti_alias: false,
      apply_to_active_layer: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('fillPath');
    expect(build.params).toMatchObject({
      red: 10,
      green: 20,
      blue: 30,
      opacity: 80,
      mode: 'multiply',
      feather: 2,
      antiAlias: false,
      applyToActiveLayer: true,
    });
  });

  it('fill defaults color to black + mode normal + opacity 100', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'fill' });
    const build = snippetClient.lastBuild();
    expect(build.params).toMatchObject({ red: 0, green: 0, blue: 0, mode: 'normal', opacity: 100 });
  });

  it('set_clipping → setClippingPath with name + flatness', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'set_clipping', name: 'Clip', flatness: 1.5 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setClippingPath');
    expect(build.params.name).toBe('Clip');
    expect(build.params.flatness).toBe(1.5);
  });

  it('set_clipping omits flatness when not provided', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_path', { op: 'set_clipping', name: 'Clip' });
    const build = snippetClient.lastBuild();
    expect(build.params.name).toBe('Clip');
    expect(build.params.flatness).toBeUndefined();
  });

  it('set_clipping without a name returns isError (no snippet dispatched)', async () => {
    const tools = createPathTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_path', { op: 'set_clipping' });
    expect(result.isError).toBe(true);
    expect(snippetClient.allBuilds()).toHaveLength(0);
  });

  // ---------- create_from_placement (grounded pen) ----------
  // A conn that routes the detect export (for the resolver) + the path result.
  const groundedConn = () =>
    makeConnection({
      resultFor: (script: string) =>
        script.includes('__mcp_detect__')
          ? EXPORT_RESULT
          : { created: true, name: 'Jaw Path', anchors: 9, closed: false, path_info: { count: 1 } },
    });
  // A landmark `along` the left-eye lower lid → a resolved PATH (CANNED_MESH:
  // starts at doc (300,200)).
  const lidAlong = {
    anchors: [{ id: 'lid', kind: 'landmark', feature: 'left_eye_lower' }],
    relation: { type: 'along', curve: 'lid' },
  };

  it('create_from_placement resolves a path placement → createPathFromPoints with the curve', async () => {
    const conn2 = groundedConn();
    const sc2 = makeSnippetClient();
    const tools = createPathTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED_MESH));
    const res = await callTool(tools, 'ps_path', {
      op: 'create_from_placement',
      name: 'Jaw Path',
      placement: lidAlong,
    });
    expect(res.isError).toBeFalsy();
    const build = sc2.allBuilds().find((b) => b.name === 'createPathFromPoints')!;
    expect(build.params.name).toBe('Jaw Path');
    const pts = build.params.points as { x: number; y: number }[];
    expect(Array.isArray(pts)).toBe(true);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[0]).toEqual({ x: 300, y: 200 }); // resolved lower-lid start
    const pl = (
      res.structuredContent as { placement?: { gate: { pass: boolean }; points: number } }
    ).placement;
    expect(pl?.gate.pass).toBe(true);
    expect(pl?.points).toBe(pts.length);
  });

  it('create_from_placement forwards closed=true', async () => {
    const conn2 = groundedConn();
    const sc2 = makeSnippetClient();
    const tools = createPathTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED_MESH));
    await callTool(tools, 'ps_path', {
      op: 'create_from_placement',
      name: 'Loop',
      placement: lidAlong,
      closed: true,
    });
    expect(sc2.allBuilds().find((b) => b.name === 'createPathFromPoints')!.params.closed).toBe(
      true
    );
  });

  it('create_from_placement without a name errors before any resolve/dispatch', async () => {
    const conn2 = groundedConn();
    const sc2 = makeSnippetClient();
    const tools = createPathTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED_MESH));
    const res = await callTool(tools, 'ps_path', {
      op: 'create_from_placement',
      placement: lidAlong,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/requires a "name"/);
    expect(conn2.executions.length).toBe(0); // no detect export, no path build
  });

  it('create_from_placement is fail-closed on a non-path (point) relation', async () => {
    const conn2 = groundedConn();
    const sc2 = makeSnippetClient();
    const tools = createPathTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED_MESH));
    const res = await callTool(tools, 'ps_path', {
      op: 'create_from_placement',
      name: 'X',
      placement: {
        anchors: [{ id: 'n', kind: 'landmark', feature: 'nose_tip' }],
        relation: { type: 'centroid', anchor: 'n' },
      },
    });
    expect(res.isError).toBe(true); // resolves a POINT, not a path → LocateError, nothing built
    expect(sc2.allBuilds().some((b) => b.name === 'createPathFromPoints')).toBe(false);
  });
});
