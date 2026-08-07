/**
 * Path-driven brush-family stroke (apply_brush_stroke).
 *
 * Tests pin: schema shape, the ToolType enum mapping verified against the
 * 9-round capture spike, the source-point guard for clone_stamp / healing_brush,
 * the brush-preset fallback chain, the auto-duplicate-first wiring, the
 * background-promote pattern, and the cleanup of the temp PathItem on both
 * success + failure paths.
 *
 * Tier: 'dev' at landing per the dev-default-then-promote gate.
 *
 * NOTE: ExtendScript body assertions (PointKind, PathPointInfo,
 * leftDirection/rightDirection, charIDToTypeID descriptor content) are
 * Go binary integration tests. These unit tests pin the TS→snippet
 * param-forwarding contract.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createBrushTools } from '@editmamei/tools/brush-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import {
  FakeDetectionClient,
  CANNED,
  CANNED_MESH,
  EXPORT_RESULT,
} from '../fixtures/fake-detection-client.ts';

describe('createBrushTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    // Default fake result mirrors the snippet's return shape so callTool
    // succeeds through the handler and we can assert on text content.
    conn = makeConnection({
      result: {
        stroked: true,
        tool: 'brush',
        tool_type: 'ToolType.BRUSH',
        brush_size: 30,
        preset_applied: null,
        size_applied: true,
        clone_source_set: false,
        anchors: 2,
        closed: false,
        path_removed: true,
        background_promoted: false,
        target_was_copy: true,
        target_layer_name: 'Brush Stroke (Background)',
        original_layer_name: 'Background',
      },
    });
    snippetClient = makeSnippetClient();
  });

  it('exposes a single tool with a well-formed shape', () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_apply_brush_stroke']);
  });

  it('schema enum exposes all 16 PS-27.x-verified brush-family tools', () => {
    // From the 2026-06-09 Round 6 Test 3 v2 result (16 of 18 probed
    // constants accepted by strokePath). The two excluded — CLONESTAMPTOOL
    // and MAGICERASER — were forum-doc holdovers that don't exist as
    // ToolType enum values on PS 27.x at all. Pin the set so a future
    // refactor doesn't expand or shrink the surface silently.
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const def = tools[0];
    const schema = def.tool.inputSchema as unknown as {
      properties: { tool: { enum: string[] } };
    };
    expect(new Set(schema.properties.tool.enum)).toEqual(
      new Set([
        'healing_brush',
        'clone_stamp',
        'burn',
        'dodge',
        'blur',
        'sharpen',
        'smudge',
        'brush',
        'pencil',
        'eraser',
        'pattern_stamp',
        'art_history_brush',
        'history_brush',
        'color_replacement',
        'background_eraser',
        'sponge',
      ])
    );
  });

  it('is marked destructive (paints pixels) and non-idempotent', () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const ann = tools[0].tool.annotations;
    expect(ann?.destructiveHint).toBe(true);
    expect(ann?.idempotentHint).toBe(false);
  });

  it('dispatches the applyBrushStroke snippet with the correct tool param', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const cases: Array<[string, string]> = [
      ['healing_brush', 'ToolType.HEALINGBRUSH'],
      ['clone_stamp', 'ToolType.CLONESTAMP'],
      ['burn', 'ToolType.BURN'],
      ['brush', 'ToolType.BRUSH'],
      ['pencil', 'ToolType.PENCIL'],
      ['color_replacement', 'ToolType.COLORREPLACEMENTTOOL'],
      ['background_eraser', 'ToolType.BACKGROUNDERASER'],
      ['art_history_brush', 'ToolType.ARTHISTORYBRUSH'],
    ];
    for (const [tool, toolTypeConst] of cases) {
      snippetClient = makeSnippetClient();
      const freshTools = createBrushTools(conn.asConnection(), snippetClient);
      const extra =
        tool === 'clone_stamp' || tool === 'healing_brush'
          ? { source_point: { x: 100, y: 100 } }
          : {};
      await callTool(freshTools, 'ps_apply_brush_stroke', {
        tool,
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        brush_size: 30,
        ...extra,
      });
      const build = snippetClient.lastBuild();
      expect(build.name, `${tool} snippet name`).toBe('applyBrushStroke');
      expect(build.params.tool, `${tool} should map to ${toolTypeConst}`).toBe(tool);
    }
  });

  it('reports the objective stroke_envelope (path bbox + brush radius) for the check step', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      brush_size: 30,
    });
    const env = (
      res.structuredContent as {
        stroke_envelope: { left: number; top: number; right: number; bottom: number };
      }
    ).stroke_envelope;
    // path bbox [0,0,100,100] expanded by the brush radius (30/2 = 15).
    expect(env).toEqual({ left: -15, top: -15, right: 115, bottom: 115 });
  });

  it('source_placement grounds the clone/heal sample point (resolved + gated) → the snippet', async () => {
    // Grid anchors resolve without a real image; `centroid` of grid 'center' on a
    // 1000×800 doc → (500,400). resultFor routes the export vs the brush-stroke script.
    const conn2 = makeConnection({
      resultFor: (script: string) =>
        script.includes('__mcp_detect__')
          ? { ok: true, doc_width: 1000, doc_height: 800, context: { hasDocument: true } }
          : {
              stroked: true,
              tool: 'clone_stamp',
              tool_type: 'ToolType.CLONESTAMP',
              brush_size: 30,
              preset_applied: null,
              size_applied: true,
              clone_source_set: true,
              anchors: 2,
              closed: false,
              path_removed: true,
              background_promoted: false,
              target_was_copy: true,
              target_layer_name: 'X',
              original_layer_name: 'Y',
            },
    });
    const sc2 = makeSnippetClient();
    const tools = createBrushTools(conn2.asConnection(), sc2, new FakeDetectionClient(CANNED));
    const res = await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'clone_stamp',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      brush_size: 30,
      source_placement: {
        anchors: [{ id: 'g', kind: 'grid', at: 'center' }],
        relation: { type: 'centroid', anchor: 'g' },
      },
    });
    expect(res.isError).toBeFalsy();
    const build = sc2.allBuilds().find((b) => b.name === 'applyBrushStroke')!;
    expect(build.params.source_point).toEqual({ x: 500, y: 400 }); // resolved grid center
    const sp = (res.structuredContent as { source_placement?: { gate: { pass: boolean } } })
      .source_placement;
    expect(sp?.gate.pass).toBe(true);
  });

  // ---------- source-required guard (clone_stamp / healing_brush) ----------

  it('clone_stamp without source_point returns an actionable isError', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'clone_stamp',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      brush_size: 30,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/clone_stamp requires a sample location.*source_point/);
  });

  it('healing_brush without source_point returns an actionable isError', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'healing_brush',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      brush_size: 30,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/healing_brush requires a sample location.*source_point/);
  });

  it('clone_stamp WITH source_point passes source coords to the snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'clone_stamp',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      brush_size: 50,
      source_point: { x: 500, y: 500, layer_name: 'Source' },
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBrushStroke');
    const sp = build.params.source_point as { x: number; y: number; layer_name?: string };
    expect(sp.x).toBe(500);
    expect(sp.y).toBe(500);
    expect(sp.layer_name).toBe('Source');
  });

  it('clone_stamp source_point without layer_name passes undefined layer name', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'clone_stamp',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      brush_size: 30,
      source_point: { x: 200, y: 300 },
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBrushStroke');
    const sp2 = build.params.source_point as { x: number; y: number; layer_name?: string };
    expect(sp2.x).toBe(200);
    expect(sp2.y).toBe(300);
    // No layer name means the snippet uses active layer — undefined or absent
    expect(sp2.layer_name).toBeUndefined();
  });

  // ---------- brush size + preset wiring ----------

  it('passes brush_size to the snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
      ],
      brush_size: 42,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBrushStroke');
    expect(build.params.brush_size).toBe(42);
  });

  it('brush_preset passes preset name to the snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
      ],
      brush_size: 30,
      brush_preset: 'Custom Soft 22',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBrushStroke');
    expect(build.params.brush_preset).toBe('Custom Soft 22');
  });

  it('no brush_preset passes undefined/absent preset to the snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
      ],
      brush_size: 30,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBrushStroke');
    expect(build.params.brush_preset).toBeUndefined();
  });

  // ---------- path geometry — params forwarding ----------

  it('passes path anchors to the snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 10, y: 20 },
        { x: 110, y: 220 },
      ],
      brush_size: 30,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBrushStroke');
    expect(Array.isArray(build.params.path)).toBe(true);
    const path = build.params.path as Array<{ x: number; y: number }>;
    expect(path[0]).toMatchObject({ x: 10, y: 20 });
    expect(path[1]).toMatchObject({ x: 110, y: 220 });
  });

  it('closed=true passes closed flag to the snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      brush_size: 20,
      closed: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.closed).toBe(true);
  });

  it('closed defaults to false when omitted', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      brush_size: 30,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.closed).toBe(false);
  });

  // ---------- auto-duplicate-first ----------

  it('exposes apply_to_active_layer (auto-duplicate-first escape hatch)', () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as { properties: Record<string, unknown> };
    expect('apply_to_active_layer' in schema.properties).toBe(true);
  });

  it('default apply_to_active_layer=false passes applyToActiveLayer=false to snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
      ],
      brush_size: 30,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.apply_to_active_layer).toBe(false);
  });

  it('apply_to_active_layer=true passes applyToActiveLayer=true to snippet', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
      ],
      brush_size: 30,
      apply_to_active_layer: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.apply_to_active_layer).toBe(true);
  });

  // ---------- handler text payload ----------

  it('text response mentions tool + anchor count + size + target', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      path: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
      ],
      brush_size: 30,
    });
    const text = textOf(result);
    expect(text).toMatch(/brush stroke/i);
    expect(text).toMatch(/2 anchors/);
    expect(text).toMatch(/size 30px/);
    expect(text).toMatch(/copy ".*Brush Stroke/);
  });

  // ---------- jitter_px (hand-drawn perturbation) ----------
  //
  // jitter_px shifts every INTERIOR anchor by a deterministic
  // pseudo-random offset in [-jitter_px, +jitter_px]. Endpoints stay
  // exact, handles ride along with their anchor. Default 0 means the
  // tool emits the path verbatim (zero behavior change for callers
  // not opting in).
  describe('jitter_px', () => {
    /**
     * Pull every emitted anchor coordinate from the snippet params.
     * The path is serialized into params.path as an array of anchor objects.
     */
    function extractAnchors(build: { params: Record<string, unknown> }): Array<[number, number]> {
      const path = build.params.path as Array<{ x: number; y: number }>;
      return path.map((p) => [p.x, p.y] as [number, number]);
    }

    const baselinePath = [
      { x: 100, y: 200 },
      { x: 200, y: 200 },
      { x: 300, y: 200 },
      { x: 400, y: 200 },
      { x: 500, y: 200 },
    ];

    it('default jitter_px=0 emits the exact input coordinates (no perturbation)', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: baselinePath,
        brush_size: 12,
      });
      const anchors = extractAnchors(snippetClient.lastBuild());
      expect(anchors).toEqual([
        [100, 200],
        [200, 200],
        [300, 200],
        [400, 200],
        [500, 200],
      ]);
    });

    it('jitter_px > 0 leaves the first and last anchor exact (only interior shifts)', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: baselinePath,
        brush_size: 12,
        jitter_px: 5,
      });
      const anchors = extractAnchors(snippetClient.lastBuild());
      // Endpoints exact.
      expect(anchors[0]).toEqual([100, 200]);
      expect(anchors[anchors.length - 1]).toEqual([500, 200]);
      // Interior anchors shifted off their starting (.y === 200) positions.
      for (let i = 1; i < anchors.length - 1; i++) {
        expect(anchors[i][0]).not.toBe(baselinePath[i].x);
        expect(anchors[i][1]).not.toBe(baselinePath[i].y);
      }
    });

    it('jitter_px bounds: every interior shift stays within ±jitter_px on each axis', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      const jitter = 8;
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: baselinePath,
        brush_size: 12,
        jitter_px: jitter,
      });
      const anchors = extractAnchors(snippetClient.lastBuild());
      for (let i = 1; i < anchors.length - 1; i++) {
        const dx = anchors[i][0] - baselinePath[i].x;
        const dy = anchors[i][1] - baselinePath[i].y;
        expect(Math.abs(dx)).toBeLessThanOrEqual(jitter);
        expect(Math.abs(dy)).toBeLessThanOrEqual(jitter);
      }
    });

    it('jitter is deterministic: same call twice emits identical anchor coordinates', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      const args = {
        tool: 'brush',
        path: baselinePath,
        brush_size: 12,
        jitter_px: 5,
      };
      await callTool(tools, 'ps_apply_brush_stroke', args);
      const first = extractAnchors(snippetClient.lastBuild());
      conn = makeConnection();
      snippetClient = makeSnippetClient();
      const tools2 = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools2, 'ps_apply_brush_stroke', args);
      const second = extractAnchors(snippetClient.lastBuild());
      expect(second).toEqual(first);
    });

    it('jitter is a no-op on 2-anchor paths (nothing to jitter — both are endpoints)', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: [
          { x: 10, y: 20 },
          { x: 100, y: 200 },
        ],
        brush_size: 12,
        jitter_px: 10,
      });
      const anchors = extractAnchors(snippetClient.lastBuild());
      expect(anchors).toEqual([
        [10, 20],
        [100, 200],
      ]);
    });

    it('schema declares jitter_px with min 0, max 50, default 0', () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      const def = tools[0];
      const schema = def.tool.inputSchema as unknown as {
        properties: {
          jitter_px: { type: string; minimum: number; maximum: number; default: number };
        };
      };
      expect(schema.properties.jitter_px.type).toBe('number');
      expect(schema.properties.jitter_px.minimum).toBe(0);
      expect(schema.properties.jitter_px.maximum).toBe(50);
      expect(schema.properties.jitter_px.default).toBe(0);
    });
  });

  // ---------- brush dynamics (hardness / opacity / flow) ----------
  //
  // The get-mutate-set descriptor body (currentToolOptions, setd event,
  // brush sub-descriptor) is a Go binary integration test.
  // These tests pin the TS→snippet param-forwarding contract.
  describe('brush dynamics (hardness / opacity / flow)', () => {
    it('schema declares hardness_pct, opacity_pct, flow_pct as 0/1-100 numbers', () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      const def = tools[0];
      const schema = def.tool.inputSchema as unknown as {
        properties: {
          hardness_pct: { type: string; minimum: number; maximum: number };
          opacity_pct: { type: string; minimum: number; maximum: number };
          flow_pct: { type: string; minimum: number; maximum: number };
        };
      };
      expect(schema.properties.hardness_pct.type).toBe('number');
      expect(schema.properties.hardness_pct.minimum).toBe(0);
      expect(schema.properties.hardness_pct.maximum).toBe(100);
      expect(schema.properties.opacity_pct.type).toBe('number');
      expect(schema.properties.opacity_pct.minimum).toBe(1);
      expect(schema.properties.opacity_pct.maximum).toBe(100);
      expect(schema.properties.flow_pct.type).toBe('number');
      expect(schema.properties.flow_pct.minimum).toBe(1);
      expect(schema.properties.flow_pct.maximum).toBe(100);
    });

    it('omitting all dynamics params does not pass dynamics fields to the snippet', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        brush_size: 30,
      });
      const build = snippetClient.lastBuild();
      expect(build.params.hardnessPct).toBeUndefined();
      expect(build.params.opacityPct).toBeUndefined();
      expect(build.params.flowPct).toBeUndefined();
    });

    it('hardness_pct passes the value to the snippet', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        brush_size: 30,
        hardness_pct: 50,
      });
      const build = snippetClient.lastBuild();
      expect(build.params.hardness_pct).toBe(50);
    });

    it('opacity_pct passes the value to the snippet', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        brush_size: 30,
        opacity_pct: 75,
      });
      const build = snippetClient.lastBuild();
      expect(build.params.opacity_pct).toBe(75);
    });

    it('flow_pct passes the value to the snippet', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        brush_size: 30,
        flow_pct: 40,
      });
      const build = snippetClient.lastBuild();
      expect(build.params.flow_pct).toBe(40);
    });

    it('all three dynamics together pass all three values to the snippet', async () => {
      const tools = createBrushTools(conn.asConnection(), snippetClient);
      await callTool(tools, 'ps_apply_brush_stroke', {
        tool: 'brush',
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        brush_size: 30,
        hardness_pct: 80,
        opacity_pct: 60,
        flow_pct: 30,
      });
      const build = snippetClient.lastBuild();
      expect(build.params.hardness_pct).toBe(80);
      expect(build.params.opacity_pct).toBe(60);
      expect(build.params.flow_pct).toBe(30);
    });
  });

  // ---- anchor-relational placement ----------------------
  it('placement: the stroke path is the FULL resolved curve (along a landmark lower-lid)', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED_MESH);
    const tools = createBrushTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      brush_size: 20,
      placement: {
        anchors: [{ id: 'lid', kind: 'landmark', feature: 'left_eye_lower' }],
        relation: { type: 'along', curve: 'lid' },
      },
    });
    expect(res.isError).toBeUndefined();
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyBrushStroke');
    const path = build.params.path as Array<{ x: number; y: number }>;
    expect(path.length).toBe(9); // the full lower-lid polyline, not just endpoints
    expect(path[0]).toEqual({ x: 300, y: 200 });
    expect(path[8]).toEqual({ x: 380, y: 200 });
    const sc = res.structuredContent as { placement?: { target?: string; points?: number } };
    expect(sc.placement?.target).toBe('path');
    expect(sc.placement?.points).toBe(9);
    expect(client.lastOpts).toMatchObject({ faces: true });
  });

  it('placement: a point relation errors (needs a path) and strokes nothing', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const client = new FakeDetectionClient(CANNED);
    const tools = createBrushTools(c.asConnection(), snippetClient, client);
    const res = await callTool(tools, 'ps_apply_brush_stroke', {
      tool: 'brush',
      brush_size: 20,
      placement: {
        anchors: [{ id: 'a', kind: 'face', pick: 'leftmost' }],
        relation: { type: 'centroid', anchor: 'a' },
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/needs a path/);
    expect(snippetClient.allBuilds().some((b) => b.name === 'applyBrushStroke')).toBe(false);
  });

  it('errors when given neither a path nor a placement', async () => {
    const tools = createBrushTools(conn.asConnection(), snippetClient);
    const res = await callTool(tools, 'ps_apply_brush_stroke', { tool: 'brush', brush_size: 20 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/at least 2 anchors|placement/);
  });
});
