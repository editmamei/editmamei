import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createSelectionTools } from '@editmamei/tools/selection-tools.ts';
import type { PhotoshopConnection } from '@editmamei/platform/connection.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { FakeDetectionClient, CANNED, EXPORT_RESULT } from '../fixtures/fake-detection-client.ts';

/**
 * Combined CE + Pro selection surface. 2026-06-20 Phase 1 consolidation:
 *  - select_rectangle / color_range / luminance_range / magic_wand / select_all /
 *    deselect / invert_selection → ps_select(mode)
 *  - feather_selection / refine_edge → ps_modify_selection(op)
 *  - save/load selection channel → ps_selection_channel(op)
 *  - create/delete/apply layer mask → ps_layer_mask(op)
 * get_selection_info merged into ps_inspect(what='selection_info') in
 * Phase 1b (2026-06-26); get_selection_preview stays separate (image-returning
 * verification primitive). The Sensei selectors (select_subject / select_sky) were
 * are community tier and live in createSelectionTools. Per-mode/op
 * handlers are unchanged; these tests pin the (name, params) forwarded to the
 * SnippetClient, reached via the discriminator.
 */
function createAllSelectionTools(conn: PhotoshopConnection, sc: FakeSnippetClient) {
  // Sensei is folded into createSelectionTools now; alias kept for the call sites below.
  return createSelectionTools(conn, sc);
}

describe('createSelectionTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('CE factory returns 7 tools including the re-tiered Sensei pair', () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    // get_selection_info merged into ps_inspect(what='selection_info') — Phase 1b.
    // ps_select_subject / ps_select_sky are community tier (now here).
    expect(tools.map((t) => t.tool.name)).toEqual([
      'ps_select',
      'ps_modify_selection',
      'ps_get_selection_preview',
      'ps_layer_mask',
      'ps_selection_channel',
      'ps_select_subject',
      'ps_select_sky',
    ]);
  });

  it('the re-tiered Sensei pair advertises idempotent + Sensei title', () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const sensei = tools.filter((t) =>
      ['ps_select_subject', 'ps_select_sky'].includes(t.tool.name)
    );
    expect(sensei.map((t) => t.tool.name)).toEqual(['ps_select_subject', 'ps_select_sky']);
    for (const t of sensei) {
      const ann = (t.tool.annotations ?? {}) as { idempotentHint?: boolean; title?: string };
      expect(ann.idempotentHint).toBe(true);
      expect(ann.title).toMatch(/Sensei/);
    }
  });

  it('the select mode field enumerates all thirteen modes', () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_select')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toEqual([
      'all',
      'none',
      'inverse',
      'rectangle',
      'ellipse',
      'color_range',
      'luminance_range',
      'magic_wand',
      'grow',
      'similar',
      'skin_tones',
      'out_of_gamut',
      'polygon',
    ]);
  });

  // get_selection_info now lives in ps_inspect(what='selection_info')
  // — see tests/tools/inspect-tools.test.ts. The getSelectionState dispatch +
  // the "no active selection" summary are covered there.

  // ---------- ps_select ----------

  it('mode=rectangle passes bounds and defaults selection_type to replace', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'rectangle',
      left: 10,
      top: 20,
      right: 110,
      bottom: 220,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectRectangle');
    expect(build.params.left).toBe(10);
    expect(build.params.bottom).toBe(220);
    expect(build.params.selectionType).toBe('replace');
  });

  it('mode=rectangle with selection_type=add passes the mapped type', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'rectangle',
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      selection_type: 'add',
    });
    expect(snippetClient.lastBuild().params.selectionType).toBe('add');
  });

  it('mode=rectangle rejects an out-of-enum selection_type at the schema layer', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_select', {
      mode: 'rectangle',
      left: 0,
      top: 0,
      right: 50,
      bottom: 50,
      selection_type: 'multiply',
    });
    expect(result.isError).toBe(true);
  });

  // ---------- grounded placement (rectangle/ellipse → region, magic_wand → point) ----------
  describe('grounded placement', () => {
    const groundedConn = () =>
      makeConnection({
        resultFor: (s: string) =>
          s.includes('__mcp_detect__') ? EXPORT_RESULT : { selected: true, selection_info: {} },
      });
    // Two dogs → their gap region → bbox [300,100,600,300] on the 1000² doc.
    const dogGap = {
      anchors: [
        { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
        { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
      ],
      relation: { type: 'gap', anchors: ['d0', 'd1'] },
    };
    const dogCentroid = {
      anchors: [{ id: 'd', kind: 'object', label: 'dog', pick: 'leftmost' }],
      relation: { type: 'centroid', anchor: 'd' },
    };

    it('rectangle placement resolves a region → the selection bbox (wins over raw edges)', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createSelectionTools(
        conn2.asConnection(),
        sc2,
        new FakeDetectionClient(CANNED)
      );
      const res = await callTool(tools, 'ps_select', {
        mode: 'rectangle',
        left: 9,
        top: 9,
        right: 9,
        bottom: 9,
        placement: dogGap,
      });
      expect(res.isError).toBeFalsy();
      const build = sc2.allBuilds().find((b) => b.name === 'selectRectangle')!;
      expect(build.params).toMatchObject({ left: 300, top: 100, right: 600, bottom: 300 });
      const pl = (res.structuredContent as { placement?: { gate: { pass: boolean } } }).placement;
      expect(pl?.gate.pass).toBe(true);
    });

    it('ellipse placement resolves a region → the bbox', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createSelectionTools(
        conn2.asConnection(),
        sc2,
        new FakeDetectionClient(CANNED)
      );
      await callTool(tools, 'ps_select', { mode: 'ellipse', placement: dogGap });
      expect(sc2.allBuilds().find((b) => b.name === 'selectEllipse')!.params).toMatchObject({
        left: 300,
        top: 100,
        right: 600,
        bottom: 300,
      });
    });

    it('magic_wand placement resolves a point → the click x/y', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createSelectionTools(
        conn2.asConnection(),
        sc2,
        new FakeDetectionClient(CANNED)
      );
      await callTool(tools, 'ps_select', { mode: 'magic_wand', placement: dogCentroid });
      // dog leftmost centroid → (200,200)
      expect(sc2.allBuilds().find((b) => b.name === 'magicWand')!.params).toMatchObject({
        x: 200,
        y: 200,
      });
    });

    it('rectangle without bounds or placement errors before dispatch', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createSelectionTools(
        conn2.asConnection(),
        sc2,
        new FakeDetectionClient(CANNED)
      );
      const res = await callTool(tools, 'ps_select', { mode: 'rectangle' });
      expect(res.isError).toBe(true);
      expect(sc2.allBuilds().some((b) => b.name === 'selectRectangle')).toBe(false);
    });

    it('rectangle placement resolving a POINT is fail-closed (needs a region)', async () => {
      const conn2 = groundedConn();
      const sc2 = makeSnippetClient();
      const tools = createSelectionTools(
        conn2.asConnection(),
        sc2,
        new FakeDetectionClient(CANNED)
      );
      const res = await callTool(tools, 'ps_select', { mode: 'rectangle', placement: dogCentroid });
      expect(res.isError).toBe(true); // a point ≠ region → LocateError, nothing selected
      expect(sc2.allBuilds().some((b) => b.name === 'selectRectangle')).toBe(false);
    });
  });

  it('mode=color_range passes RGB and fuzziness params to the snippet', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'color_range',
      red: 200,
      green: 50,
      blue: 50,
      fuzziness: 60,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectColorRange');
    expect(build.params.red).toBe(200);
    expect(build.params.fuzziness).toBe(60);
  });

  it('mode=luminance_range passes mode + limits to the snippet', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'luminance_range',
      luminance: 'highlights',
      fuzziness: 30,
      lower_limit: 190,
      selection_type: 'replace',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectLuminanceRange');
    expect(build.params.mode).toBe('highlights');
    expect(build.params.lowerLimit).toBe(190);
  });

  it('mode=ellipse passes bounds, anti_alias, feather and selection_type to the snippet', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'ellipse',
      left: 100,
      top: 150,
      right: 400,
      bottom: 450,
      feather_px: 12,
      anti_alias: false,
      selection_type: 'add',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectEllipse');
    expect(build.params.left).toBe(100);
    expect(build.params.bottom).toBe(450);
    expect(build.params.featherPx).toBe(12);
    expect(build.params.antiAlias).toBe(false);
    expect(build.params.selectionType).toBe('add');
  });

  it('mode=ellipse defaults anti_alias true, feather 0, selection_type replace', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'ellipse',
      left: 0,
      top: 0,
      right: 50,
      bottom: 50,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectEllipse');
    expect(build.params.antiAlias).toBe(true);
    expect(build.params.featherPx).toBe(0);
    expect(build.params.selectionType).toBe('replace');
  });

  it('mode=grow / similar dispatch growSelection with the right mode + tolerance', async () => {
    const cases = [
      { mode: 'grow', tolerance: 50 },
      { mode: 'similar', tolerance: 12 },
    ];
    for (const { mode, tolerance } of cases) {
      snippetClient = makeSnippetClient();
      const tools = createSelectionTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_select', { mode, tolerance });
      const build = snippetClient.lastBuild();
      expect(build.name, mode).toBe('growSelection');
      expect(build.params.mode, mode).toBe(mode);
      expect(build.params.tolerance, mode).toBe(tolerance);
    }
  });

  it('mode=grow defaults tolerance to 32 and anti_alias to true', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', { mode: 'grow' });
    const build = snippetClient.lastBuild();
    expect(build.params.tolerance).toBe(32);
    expect(build.params.antiAlias).toBe(true);
  });

  it('mode=skin_tones dispatches selectColorPreset with fuzziness + use_faces', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'skin_tones',
      fuzziness: 55,
      use_faces: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectColorPreset');
    expect(build.params.preset).toBe('skin_tones');
    expect(build.params.fuzziness).toBe(55);
    expect(build.params.useFaces).toBe(true);
  });

  it('mode=skin_tones defaults use_faces false (no Sensei dependency)', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', { mode: 'skin_tones' });
    const build = snippetClient.lastBuild();
    expect(build.params.useFaces).toBe(false);
    expect(build.params.fuzziness).toBe(40);
  });

  it('mode=out_of_gamut dispatches selectColorPreset with the out_of_gamut preset', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', { mode: 'out_of_gamut', selection_type: 'subtract' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectColorPreset');
    expect(build.params.preset).toBe('out_of_gamut');
    expect(build.params.selectionType).toBe('subtract');
  });

  it('mode=polygon forwards the points array + anti_alias + selection_type', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'polygon',
      points: [
        { x: 100, y: 100 },
        { x: 300, y: 120 },
        { x: 200, y: 280 },
      ],
      anti_alias: false,
      selection_type: 'add',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('selectPolygon');
    const pts = build.params.points as Array<{ x: number; y: number }>;
    expect(pts).toHaveLength(3);
    expect(pts[1]).toEqual({ x: 300, y: 120 });
    expect(build.params.antiAlias).toBe(false);
    expect(build.params.selectionType).toBe('add');
  });

  it('mode=polygon rejects fewer than 3 points', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_select', {
      mode: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
    });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  it('mode=magic_wand passes click point and flags to the snippet', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', {
      mode: 'magic_wand',
      x: 512,
      y: 384,
      tolerance: 18,
      contiguous: false,
      anti_alias: false,
      sample_all_layers: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('magicWand');
    expect(build.params.x).toBe(512);
    expect(build.params.tolerance).toBe(18);
    expect(build.params.contiguous).toBe(false);
    expect(build.params.sampleAllLayers).toBe(true);
  });

  it('mode=magic_wand defaults contiguous + anti_alias to true and sample_all_layers to false', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select', { mode: 'magic_wand', x: 100, y: 100 });
    const build = snippetClient.lastBuild();
    expect(build.params.tolerance).toBe(32);
    expect(build.params.contiguous).toBe(true);
    expect(build.params.antiAlias).toBe(true);
    expect(build.params.sampleAllLayers).toBe(false);
  });

  it('mode=all / none / inverse dispatch to their respective snippets', async () => {
    const cases = [
      { mode: 'all', snippetName: 'selectAll' },
      { mode: 'none', snippetName: 'deselect' },
      { mode: 'inverse', snippetName: 'invertSelection' },
    ];
    for (const { mode, snippetName } of cases) {
      snippetClient = makeSnippetClient();
      const tools = createSelectionTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_select', { mode });
      expect(snippetClient.lastBuild().name, mode).toBe(snippetName);
    }
  });

  it('an unknown select mode returns an error without dispatching', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_select', { mode: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- ps_modify_selection ----------

  it('op=feather passes the radius param to the snippet', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_modify_selection', { op: 'feather', radius_px: 80 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('featherSelection');
    expect(build.params.radiusPx).toBe(80);
  });

  it('op=refine_edge forwards the edge sliders', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_modify_selection', {
      op: 'refine_edge',
      smooth: 13,
      feather: 1.8,
      contrast: 12,
      shift_edge: 0,
      decontaminate: false,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('refineEdge');
    expect(build.params.smooth).toBe(13);
    expect(build.params.feather).toBe(1.8);
    expect(build.params.decontaminate).toBe(false);
  });

  it('the modify_selection op field enumerates all nine ops', () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_modify_selection')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
    };
    expect(schema.properties.op.enum).toEqual([
      'feather',
      'refine_edge',
      'expand',
      'contract',
      'border',
      'smooth',
      'transform',
      'grow',
      'similar',
    ]);
  });

  it('op=grow / similar dispatch growSelection with the right mode + tolerance', async () => {
    const cases = [
      { op: 'grow', tolerance: 50 },
      { op: 'similar', tolerance: 12 },
    ];
    for (const { op, tolerance } of cases) {
      snippetClient = makeSnippetClient();
      const tools = createSelectionTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_modify_selection', { op, tolerance });
      const build = snippetClient.lastBuild();
      expect(build.name, op).toBe('growSelection');
      expect(build.params.mode, op).toBe(op);
      expect(build.params.tolerance, op).toBe(tolerance);
    }
  });

  it('op=grow defaults tolerance to 32 and anti_alias to true', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_modify_selection', { op: 'grow' });
    const build = snippetClient.lastBuild();
    expect(build.params.tolerance).toBe(32);
    expect(build.params.antiAlias).toBe(true);
  });

  // The important equivalence: moving grow/similar from ps_select's mode to
  // ps_modify_selection's op must not change behaviour. Both paths dispatch
  // the identical growSelection snippet with the identical param object —
  // this is what proves the move is behaviour-preserving, not a rewrite.
  it('deprecated ps_select mode=grow/similar builds the identical snippet + params as ps_modify_selection op=grow/similar', async () => {
    for (const mode of ['grow', 'similar'] as const) {
      const selectClient = makeSnippetClient();
      const modifyClient = makeSnippetClient();
      const selectTools = createSelectionTools(conn.asConnection(), selectClient);
      const modifyTools = createSelectionTools(conn.asConnection(), modifyClient);

      await callTool(selectTools, 'ps_select', { mode, tolerance: 44, anti_alias: false });
      await callTool(modifyTools, 'ps_modify_selection', {
        op: mode,
        tolerance: 44,
        anti_alias: false,
      });

      const selectBuild = selectClient.lastBuild();
      const modifyBuild = modifyClient.lastBuild();
      expect(selectBuild.name, mode).toBe(modifyBuild.name);
      expect(selectBuild.name, mode).toBe('growSelection');
      expect(selectBuild.params, mode).toEqual(modifyBuild.params);
    }
  });

  it('op=transform forwards scale / rotate / offset (defaulting identity)', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_modify_selection', {
      op: 'transform',
      scale_x_percent: 120,
      rotate_degrees: 15,
      offset_y: 40,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('transformSelection');
    expect(build.params.scaleXPercent).toBe(120);
    expect(build.params.scaleYPercent).toBe(100);
    expect(build.params.rotateDegrees).toBe(15);
    expect(build.params.offsetX).toBe(0);
    expect(build.params.offsetY).toBe(40);
  });

  it('op=expand / contract / border / smooth dispatch modifySelectionEdge with mode + amount', async () => {
    const cases = [
      { op: 'expand', amount: 12, at_canvas_bounds: true },
      { op: 'contract', amount: 15, at_canvas_bounds: false },
      { op: 'border', amount: 8 },
      { op: 'smooth', amount: 6, at_canvas_bounds: false },
    ];
    for (const c of cases) {
      snippetClient = makeSnippetClient();
      const tools = createSelectionTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_modify_selection', c);
      const build = snippetClient.lastBuild();
      expect(build.name, c.op).toBe('modifySelectionEdge');
      expect(build.params.mode, c.op).toBe(c.op);
      expect(build.params.amount, c.op).toBe(c.amount);
      expect(build.params.atCanvasBounds, c.op).toBe(c.at_canvas_bounds ?? false);
    }
  });

  it('op=expand requires amount (schema rejects when missing)', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_modify_selection', { op: 'expand' });
    expect(result.isError).toBe(true);
  });

  it('an unknown modify_selection op returns an error without dispatching', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_modify_selection', { op: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- ps_selection_channel ----------

  it('op=save dispatches saveSelectionToChannel with the channel name', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_selection_channel', { op: 'save', channel_name: 'sky' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('saveSelectionToChannel');
    expect(build.params.channelName).toBe('sky');
  });

  it('op=load dispatches loadSelectionFromChannel with channel + operation', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_selection_channel', {
      op: 'load',
      channel_name: 'sky',
      operation: 'add',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('loadSelectionFromChannel');
    expect(build.params.channelName).toBe('sky');
    expect(build.params.operation).toBe('add');
  });

  it('selection_channel requires channel_name', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_selection_channel', { op: 'save' });
    expect(result.isError).toBe(true);
  });

  it('the selection_channel op field enumerates save/load/duplicate/delete', () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_selection_channel')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
    };
    expect(schema.properties.op.enum).toEqual(['save', 'load', 'duplicate', 'delete']);
  });

  // 2026-06-29 — duplicate/delete added after a ScriptListener capture
  // (DOM channel.duplicate() / .remove()).
  it('op=duplicate dispatches duplicateChannel with channel + optional new name', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_selection_channel', {
      op: 'duplicate',
      channel_name: 'sky',
      new_channel_name: 'sky-2',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('duplicateChannel');
    expect(build.params.channelName).toBe('sky');
    expect(build.params.newName).toBe('sky-2');
  });

  it('op=duplicate omits newName when new_channel_name is not given', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_selection_channel', { op: 'duplicate', channel_name: 'sky' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('duplicateChannel');
    expect(build.params.newName).toBeUndefined();
  });

  it('op=delete dispatches deleteChannel with the channel name', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_selection_channel', { op: 'delete', channel_name: 'sky' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('deleteChannel');
    expect(build.params.channelName).toBe('sky');
  });

  it('an unknown selection_channel op returns an error without dispatching', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_selection_channel', {
      op: 'bogus',
      channel_name: 'x',
    });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- ps_layer_mask ----------

  it('op=create / delete / apply dispatch to their mask snippets', async () => {
    const cases = [
      { op: 'create', snippetName: 'createLayerMask' },
      { op: 'delete', snippetName: 'deleteLayerMask' },
      { op: 'apply', snippetName: 'applyLayerMask' },
    ];
    for (const { op, snippetName } of cases) {
      snippetClient = makeSnippetClient();
      const tools = createSelectionTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_layer_mask', { op });
      expect(snippetClient.lastBuild().name, op).toBe(snippetName);
    }
  });

  // 2026-08 gradient build — op=gradient draws a fade into the mask via the
  // maskGradient snippet. Defaults + explicit params pinned across the bridge.
  it('op=gradient dispatches maskGradient with defaults', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_layer_mask', { op: 'gradient' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('maskGradient');
    expect(build.params.fade_to).toBe('bottom');
    expect(build.params.start).toBe(0);
    expect(build.params.end).toBe(1);
    expect(build.params.extent).toBe('layer');
  });

  it('op=gradient forwards fade_to / start / end / extent', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_layer_mask', {
      op: 'gradient',
      fade_to: 'top',
      start: 0.25,
      end: 0.9,
      extent: 'canvas',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('maskGradient');
    expect(build.params.fade_to).toBe('top');
    expect(build.params.start).toBe(0.25);
    expect(build.params.end).toBe(0.9);
    expect(build.params.extent).toBe('canvas');
  });

  it('layer_mask description keeps the adjustment-layer + frame-opening + execute_script guidance', () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_layer_mask')!;
    const desc = tool.tool.description ?? '';
    expect(desc).toMatch(/[Aa]djustment layers/);
    expect(desc).toMatch(/If a selection is active.*reveals the selection/i);
    expect(desc).toMatch(/frame opening/i);
    // The execute_script anti-pattern callout must survive so the LLM doesn't
    // hand-roll the Mk Chnl AM workaround.
    expect(desc).toMatch(/Mk Chnl|execute_script/i);
  });

  it('an unknown layer_mask op returns an error without dispatching', async () => {
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_layer_mask', { op: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- Sensei selectors (community tier) ----------

  it('select_subject dispatches the selectSubject snippet via the SnippetClient', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_subject', {});
    expect(snippetClient.lastBuild().name).toBe('selectSubject');
  });

  // Phase 3c — pre-existing inline 120000 literal, now centralized in
  // src/utils/operation-timeouts.ts. Pins the value survived the move.
  it('select_subject forwards a 120s timeout to the executor', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_subject', {});
    expect(conn.lastTimeout()).toBe(120000);
  });

  it('select_sky forwards a 120s timeout to the executor', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_sky', {});
    expect(conn.lastTimeout()).toBe(120000);
  });

  it('select_subject defaults sample_all_layers to TRUE (PS 2026 active-layer-only workaround)', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_subject', {});
    expect(snippetClient.lastBuild().params.sampleAllLayers).toBe(true);
  });

  it('select_subject with selection_type=subtract forwards the right token', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_subject', { selection_type: 'subtract' });
    expect(snippetClient.lastBuild().params.selectionType).toBe('subtract');
  });

  // Migrated from the deleted selection-tools-pro.test.ts — schema-validation paths
  // for the now-CE-shipped Sensei tool.
  it('select_subject honors sample_all_layers=false', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_subject', { sample_all_layers: false });
    expect(snippetClient.lastBuild().params.sampleAllLayers).toBe(false);
  });

  it('select_subject accepts "add" selection_type', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_subject', { selection_type: 'add' });
    expect(snippetClient.lastBuild().params.selectionType).toBe('add');
  });

  it('select_subject rejects an out-of-enum selection_type', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_select_subject', { selection_type: 'multiply' });
    expect(result.isError).toBe(true);
  });

  it('select_sky dispatches the selectSky snippet via the SnippetClient', async () => {
    const tools = createAllSelectionTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_select_sky', {});
    expect(snippetClient.lastBuild().name).toBe('selectSky');
  });

  it('select_sky surfaces connection failures as an error result', async () => {
    const errConn = makeConnection({ throwOnExecute: new Error('parameters not valid') });
    const tools = createSelectionTools(errConn.asConnection(), makeSnippetClient());
    const result = await callTool(tools, 'ps_select_sky', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/parameters not valid/);
  });

  // ---------- get_selection_preview (kept) ----------

  it('get_selection_preview returns both overlay + mask images when rendered', async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const resultFor = ((script: string) => {
      const paths = Array.from(script.matchAll(/"([^"]+\.jpg)"/g))
        .map((m) => m[1].replace(/\\\\/g, '\\'))
        .filter((p, i, arr) => arr.indexOf(p) === i);
      const writes = paths.map((p) =>
        mkdir(dirname(p), { recursive: true })
          .catch(() => undefined)
          .then(() => writeFile(p, fakeJpeg))
      );
      return Promise.all(writes).then(() => ({
        rendered: true,
        overlay_path: paths[0],
        mask_path: paths[1],
        max_dimension: 800,
        selection_info: {
          has_selection: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          pixel_count: 10000,
          area_percent: 25,
          edge_complexity: 0.05,
        },
      }));
    }) as unknown as (script: string) => unknown;

    conn = makeConnection({ resultFor });
    snippetClient = makeSnippetClient();
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_get_selection_preview', {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(3);
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(result.content[2]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
  });

  it('get_selection_preview returns text-only when no active selection', async () => {
    conn = makeConnection({
      result: {
        rendered: false,
        reason: 'no_active_selection',
        selection_info: { has_selection: false },
      },
    });
    snippetClient = makeSnippetClient();
    const tools = createSelectionTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_get_selection_preview', {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toMatch(/no_active_selection/);
  });
});
