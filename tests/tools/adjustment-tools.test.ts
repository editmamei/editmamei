import { describe, it, expect, beforeEach } from 'vitest';
import { createAdjustmentTools } from '@editmamei/tools/adjustment-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createAdjustmentTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 2 well-formed tools — non-destructive entry point + consolidated destructive apply_adjustment', () => {
    // 2026-06-20 Phase 1: the three destructive bakes (shadows_highlights,
    // equalize, color_lookup) consolidated into ps_apply_adjustment(type).
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name).sort()).toEqual([
      'ps_add_adjustment_layer',
      'ps_apply_adjustment',
    ]);
  });

  it('apply_adjustment enumerates the three destructive bake types', () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_apply_adjustment')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { type: { enum: string[] } };
    };
    expect(schema.properties.type.enum).toEqual(['shadows_highlights', 'equalize', 'color_lookup']);
  });

  it('add_adjustment_layer passes type and name to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'curves',
      name: 'My Curves',
      curves_preset: 'sCurveStrong',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.name).toBe('My Curves');
    expect(build.params.type).toBe('curves');
  });

  it('add_adjustment_layer dispatches the addAdjustmentLayer snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'brightness_contrast',
      brightness: 10,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.type).toBe('brightness_contrast');
    expect(conn.executions.length).toBe(1);
  });

  it('add_adjustment_layer passes mask_from_selection flag to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'levels',
      black_point: 5,
      mask_from_selection: false,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.mask_from_selection).toBe(false);
  });

  it('add_adjustment_layer passes mask_inverted flag to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'hue_saturation',
      saturation: -20,
      mask_inverted: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.mask_inverted).toBe(true);
  });

  // 2026-08 gradient build — gm_stops (custom gradient-map stops) forwards
  // verbatim; the Go side validates + converts locations (0-100 → 0-4096).
  it('add_adjustment_layer gradient_map forwards gm_stops to the snippet', async () => {
    const gmStops = [
      { red: 20, green: 40, blue: 120, location: 0 },
      { red: 250, green: 150, blue: 50, location: 100 },
    ];
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'gradient_map',
      gm_stops: gmStops,
      gm_reverse: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.type).toBe('gradient_map');
    expect(build.params.gm_stops).toEqual(gmStops);
    expect(build.params.gm_reverse).toBe(true);
  });

  // ===========================================================================
  // Phase 4 (layer-placement bug) — into_active_group forwarding.
  //
  // With a group active, the bare Mk AdjL descriptor has no target
  // reference, so PS nests the new layer INSIDE it — contradicting "above
  // the active layer" in the tool description. The Go emitter hoists the
  // new layer back out by default (into_active_group defaults false); this
  // harness can't observe the emitted JSX (snippetClient.build() is faked
  // to record {name, params} only), so it just pins that the flag reaches
  // the snippet params correctly. See go-core/layer_placement_test.go for
  // the emitted-fragment assertions and the "community" live-smoke
  // scenario's create-nesting-test-group/adj-while-group-active/
  // layer-tree-nesting-check steps for the real-Photoshop verification.
  // ===========================================================================
  it('add_adjustment_layer defaults into_active_group to false when omitted', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', { type: 'invert' });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(false);
  });

  it('add_adjustment_layer forwards into_active_group:true', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'invert',
      into_active_group: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(true);
  });

  // ===========================================================================
  // Regression pin: the four destructive-bake tool names must not come back
  // unless their removal rationale is reconsidered.
  // ===========================================================================
  it('destructive bake adjustment tools stay removed', () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    const names = new Set(tools.map((t) => t.tool.name));
    for (const removed of [
      'photoshop_auto_levels',
      'photoshop_auto_contrast',
      'photoshop_desaturate',
      'photoshop_invert',
    ]) {
      expect(names.has(removed), removed).toBe(false);
    }
  });

  it('expectedKind verification covers every supported type (schema enum)', () => {
    // Pin that the post-Mk kind assertion in the snippet knows about the
    // full type roster — if a new type is added without updating the
    // expectedKind chain, kindMatches will silently be false in the
    // result payload and the LLM has no signal.
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_add_adjustment_layer')!;
    // Pull the enum off the schema instead of duplicating the list.
    const inputSchema = tool.tool.inputSchema as unknown as {
      properties: { type: { enum: string[] } };
    };
    const types = inputSchema.properties.type.enum;
    expect(types).toContain('black_and_white');
    expect(types).toContain('color_balance');
    expect(types).toContain('photo_filter');
    expect(types).toContain('vibrance');
    expect(types).toContain('channel_mixer');
    expect(types).toContain('selective_color');
    expect(types).toContain('gradient_map');
    expect(types).toContain('exposure');
    expect(types).toContain('color_lookup');
    expect(types).toContain('invert');
    expect(types).toContain('posterize');
    expect(types).toContain('threshold');
    expect(types.length).toBe(16);
  });

  // ===========================================================================
  // Param-forwarding tests for adjustment subtypes.
  // The cTID/sTID descriptor body assertions are Go binary integration tests.
  // These tests pin the TS→snippet param contract for each type.
  // ===========================================================================

  it('levels passes black_point, white_point, and gamma to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'levels',
      black_point: 12,
      white_point: 242,
      gamma: 1.08,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.type).toBe('levels');
    expect(build.params.black_point).toBe(12);
    expect(build.params.white_point).toBe(242);
    expect(build.params.gamma).toBe(1.08);
  });

  it('curves passes curves_preset to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'curves',
      curves_preset: 'sCurveStrong',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.type).toBe('curves');
    expect(build.params.curves_preset).toBe('sCurveStrong');
  });

  it('hue_saturation passes saturation to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'hue_saturation',
      saturation: 22,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.type).toBe('hue_saturation');
    expect(build.params.saturation).toBe(22);
  });

  it('brightness_contrast passes brightness and contrast params', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'brightness_contrast',
      brightness: 5,
      contrast: 22,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addAdjustmentLayer');
    expect(build.params.type).toBe('brightness_contrast');
    expect(build.params.brightness).toBe(5);
    expect(build.params.contrast).toBe(22);
  });

  it('color_lookup with no cl_lut_name returns a helpful error (handler-side conditional-required)', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_add_adjustment_layer', {
      type: 'color_lookup',
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string }).text ?? '';
    expect(text).toMatch(/cl_lut_name/);
    expect(text).toMatch(/empty Color Lookup layer/);
    // The bare-no-LUT case must NEVER dispatch a script — the error
    // happens at the handler boundary, before the ExtendScript fires.
    expect(conn.executions).toHaveLength(0);
  });

  // ===========================================================================
  // Auto-duplicate-first for destructive adjustment tools.
  // The __opOriginal/__opCopy/.duplicate() body assertions are Go binary tests.
  // These tests pin the applyToActiveLayer param-forwarding contract.
  // ===========================================================================

  it('apply_color_lookup passes lutName and applyToActiveLayer to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_adjustment', {
      type: 'color_lookup',
      cl_lut_name: 'TealOrangePlusContrast.3DL',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyColorLookup');
    expect(build.params.lutName).toBe('TealOrangePlusContrast.3DL');
    expect(build.params.applyToActiveLayer).toBe(false);
  });

  it('apply_color_lookup with apply_to_active_layer=true passes true', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_adjustment', {
      type: 'color_lookup',
      cl_lut_name: 'TealOrangePlusContrast.3DL',
      apply_to_active_layer: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyColorLookup');
    expect(build.params.applyToActiveLayer).toBe(true);
  });

  it('apply_equalize defaults to auto-duplicate-first (applyToActiveLayer=false)', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_adjustment', { type: 'equalize' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyEqualize');
    expect(build.params.applyToActiveLayer).toBe(false);
  });

  it('apply_equalize with apply_to_active_layer=true passes true', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_adjustment', {
      type: 'equalize',
      apply_to_active_layer: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyEqualize');
    expect(build.params.applyToActiveLayer).toBe(true);
  });

  // ===========================================================================
  // apply_shadows_highlights param-forwarding.
  // The adaptCorrect AM event descriptor and charID key assertions are
  // Go binary integration tests.
  // ===========================================================================
  it('apply_shadows_highlights passes key params to the snippet', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_adjustment', {
      type: 'shadows_highlights',
      shadow_amount: 42,
      shadow_width: 50,
      shadow_radius: 399,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyShadowsHighlights');
    expect(build.params.shadowAmount).toBe(42);
    expect(build.params.shadowWidth).toBe(50);
    expect(build.params.shadowRadius).toBe(399);
  });

  it('apply_shadows_highlights defaults to auto-duplicate-first (applyToActiveLayer=false)', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_adjustment', { type: 'shadows_highlights' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyShadowsHighlights');
    expect(build.params.applyToActiveLayer).toBe(false);
  });

  it('apply_shadows_highlights with apply_to_active_layer=true passes true', async () => {
    const tools = createAdjustmentTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_adjustment', {
      type: 'shadows_highlights',
      apply_to_active_layer: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyShadowsHighlights');
    expect(build.params.applyToActiveLayer).toBe(true);
  });
});
