import { describe, it, expect, beforeEach } from 'vitest';
import { createLayerTransformTools } from '@editmamei/tools/layer-transform-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import {
  FakeDetectionClient,
  CANNED,
  CANNED_MESH,
  EXPORT_RESULT,
} from '../fixtures/fake-detection-client.ts';

const textOf = (res: Awaited<ReturnType<typeof callTool>>): string =>
  res.content.find((c): c is { type: 'text'; text: string } => c.type === 'text')?.text ?? '';

// 2026-06-20 Phase 1: fit/scale/move/rotate/flip collapsed into one
// ps_transform_layer(op). The per-op handlers (mode resolution,
// mutual-exclusivity validation, param forwarding) are unchanged; the snippet
// BODIES stay golden-verified in go-core. These tests pin the handler contract
// (name + params) reached via op:'…'.
describe('createLayerTransformTools', () => {
  let conn: FakePhotoshopConnection;
  let sc: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    sc = makeSnippetClient();
  });

  it('returns one consolidated transform_layer tool', () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_transform_layer']);
  });

  it('the op field enumerates the five transforms', () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
      required: string[];
    };
    expect(schema.properties.op.enum).toEqual([
      'fit',
      'scale',
      'move',
      'rotate',
      'flip',
      'skew',
      'free',
    ]);
    expect(schema.required).toContain('op');
  });

  it('an unknown op returns an error without dispatching', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_transform_layer', { op: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  it('op=scale forwards uniform scale percent', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', { op: 'scale', scale_percent: 175 });
    expect(sc.lastBuild().name).toBe('scaleLayer');
    expect(sc.lastBuild().params.scalePercent).toBe(175);
  });

  it('op=scale with x/y forwards non-uniform percentages', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', {
      op: 'scale',
      scale_x_percent: 150,
      scale_y_percent: 80,
    });
    const b = sc.lastBuild();
    expect(b.name).toBe('scaleLayer');
    expect(b.params.scaleXPercent).toBe(150);
    expect(b.params.scaleYPercent).toBe(80);
    expect(b.params.scalePercent).toBeUndefined();
  });

  it('op=flip forwards the axis', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', { op: 'flip', axis: 'horizontal' });
    expect(sc.lastBuild().name).toBe('flipLayer');
    expect(sc.lastBuild().params.axis).toBe('horizontal');
  });

  it('op=move in delta mode forwards delta mode + deltas (incl. negatives)', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', { op: 'move', delta_x: -30, delta_y: 60 });
    const b = sc.lastBuild();
    expect(b.name).toBe('moveLayer');
    expect(b.params.mode).toBe('delta');
    expect(b.params.deltaX).toBe(-30);
    expect(b.params.deltaY).toBe(60);
  });

  it('op=rotate forwards degrees', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', { op: 'rotate', degrees: 90 });
    expect(sc.lastBuild().name).toBe('rotateLayer');
    expect(sc.lastBuild().params.degrees).toBe(90);
  });

  // ===========================================================================
  // M2 (2026-06-21) — op=skew / op=free (raw-AM Trnf matrix), dev-tier.
  // ===========================================================================
  it('op=skew forwards mode + skew angles to transformLayerMatrix', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', {
      op: 'skew',
      skew_h_degrees: -10,
      skew_v_degrees: 5,
    });
    const b = sc.lastBuild();
    expect(b.name).toBe('transformLayerMatrix');
    expect(b.params.mode).toBe('skew');
    expect(b.params.skewH).toBe(-10);
    expect(b.params.skewV).toBe(5);
    // scale/rotate/offset default to identity
    expect(b.params.scaleXPercent).toBe(100);
    expect(b.params.scaleYPercent).toBe(100);
    expect(b.params.rotateDegrees).toBe(0);
  });

  it('op=skew without any skew angle errors before dispatching', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_transform_layer', { op: 'skew' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  it('op=free forwards mode + scale/rotate/offset (no Skew obj)', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', {
      op: 'free',
      scale_x_percent: 93,
      scale_y_percent: 90,
      degrees: 15,
      offset_x: -132,
      offset_y: 144,
    });
    const b = sc.lastBuild();
    expect(b.name).toBe('transformLayerMatrix');
    expect(b.params.mode).toBe('free');
    expect(b.params.scaleXPercent).toBe(93);
    expect(b.params.scaleYPercent).toBe(90);
    expect(b.params.rotateDegrees).toBe(15);
    expect(b.params.offsetX).toBe(-132);
    expect(b.params.offsetY).toBe(144);
    expect(b.params.skewH).toBe(0);
    expect(b.params.skewV).toBe(0);
  });

  // ===========================================================================
  // Move absolute + center positioning modes (now op=move).
  // ===========================================================================
  describe('op=move absolute / center modes', () => {
    it('absolute mode resolves to absolute + forwards target coords', async () => {
      const tools = createLayerTransformTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_transform_layer', {
        op: 'move',
        absolute_x: 1000,
        absolute_y: 500,
      });
      const b = sc.lastBuild();
      expect(b.params.mode).toBe('absolute');
      expect(b.params.absoluteX).toBe(1000);
      expect(b.params.absoluteY).toBe(500);
    });

    it('center mode resolves to center + forwards target coords', async () => {
      const tools = createLayerTransformTools(conn.asConnection(), sc);
      await callTool(tools, 'ps_transform_layer', {
        op: 'move',
        center_on_x: 2600,
        center_on_y: 1640,
      });
      const b = sc.lastBuild();
      expect(b.params.mode).toBe('center');
      expect(b.params.centerOnX).toBe(2600);
      expect(b.params.centerOnY).toBe(1640);
    });

    it('mixed modes (delta + absolute) returns a clear validation error', async () => {
      const tools = createLayerTransformTools(conn.asConnection(), sc);
      const result = await callTool(tools, 'ps_transform_layer', {
        op: 'move',
        delta_x: 10,
        delta_y: 10,
        absolute_x: 100,
        absolute_y: 100,
      });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toMatch(/mixed positioning modes/i);
    });

    it('no positioning mode at all returns a clear validation error', async () => {
      const tools = createLayerTransformTools(conn.asConnection(), sc);
      const result = await callTool(tools, 'ps_transform_layer', { op: 'move' });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toMatch(/no positioning mode specified/i);
    });

    it('half-set delta pair (delta_x only) rejected with a specific message', async () => {
      const tools = createLayerTransformTools(conn.asConnection(), sc);
      const result = await callTool(tools, 'ps_transform_layer', {
        op: 'move',
        delta_x: 10,
      });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toMatch(/delta mode requires both/i);
    });
  });

  // ===========================================================================
  // Discovery signals on the consolidated description / op field.
  // ===========================================================================
  it('description names center-on as the frame-placement answer', () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    const tool = tools[0];
    const desc = tool.tool.description ?? '';
    expect(desc).toContain('center_on');
    expect(desc).toMatch(/frame opening|inside.*frame|frame.*opening/i);
    // The op field lists the explicit coordinate field names.
    const opDesc = (
      tool.tool.inputSchema as unknown as { properties: { op: { description: string } } }
    ).properties.op.description;
    expect(opDesc).toContain('center_on_x');
    expect(opDesc).toContain('center_on_y');
  });

  it('description advertises background auto-promote', () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    const desc = tools[0].tool.description ?? '';
    expect(desc).toMatch(/auto-promote|background_promoted/i);
  });

  it('op=fit defaults to mode=fit (fillDocument=false)', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', { op: 'fit' });
    expect(sc.lastBuild().name).toBe('fitLayerToDocument');
    expect(sc.lastBuild().params.fillDocument).toBe(false);
  });

  it('op=fit with mode="fill" forwards fillDocument=true', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    await callTool(tools, 'ps_transform_layer', { op: 'fit', mode: 'fill' });
    expect(sc.lastBuild().params.fillDocument).toBe(true);
  });

  it('op=fit rejects mode values outside the enum', async () => {
    const tools = createLayerTransformTools(conn.asConnection(), sc);
    const result = await callTool(tools, 'ps_transform_layer', {
      op: 'fit',
      mode: 'stretch',
    });
    expect(result.isError).toBe(true);
  });

  // ---- anchor-relational placement on op=move ------------
  it('op=move placement: the layer center goes to the resolved point (center mode)', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const tools = createLayerTransformTools(
      c.asConnection(),
      sc,
      new FakeDetectionClient(CANNED_MESH)
    );
    const res = await callTool(tools, 'ps_transform_layer', {
      op: 'move',
      placement: {
        anchors: [{ id: 'n', kind: 'landmark', feature: 'nose_tip' }],
        relation: { type: 'centroid', anchor: 'n' },
      },
    });
    expect(res.isError).toBeUndefined();
    const b = sc.lastBuild();
    expect(b.name).toBe('moveLayer');
    expect(b.params.mode).toBe('center');
    expect(b.params.centerOnX).toBe(340); // nose_tip point
    expect(b.params.centerOnY).toBe(250);
    const g = res.structuredContent as {
      placement?: { target?: string; gate?: { pass?: boolean } };
    };
    expect(g.placement?.target).toBe('point');
    expect(g.placement?.gate?.pass).toBe(true);
  });

  it('op=move placement: a region relation errors (needs a point) and moves nothing', async () => {
    const c = makeConnection({ result: EXPORT_RESULT });
    const tools = createLayerTransformTools(c.asConnection(), sc, new FakeDetectionClient(CANNED));
    const res = await callTool(tools, 'ps_transform_layer', {
      op: 'move',
      placement: {
        anchors: [
          { id: 'd0', kind: 'object', label: 'dog', pick: 'leftmost' },
          { id: 'd1', kind: 'object', label: 'dog', pick: 'rightmost' },
        ],
        relation: { type: 'gap', anchors: ['d0', 'd1'] },
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/needs a point/);
    expect(sc.allBuilds().some((b) => b.name === 'moveLayer')).toBe(false);
  });
});
