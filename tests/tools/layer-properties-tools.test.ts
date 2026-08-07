import { describe, it, expect, beforeEach } from 'vitest';
import { createLayerPropertiesTools } from '@editmamei/tools/layer-properties-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

// 2026-06-20 Phase 1 consolidation:
//  - set_layer_opacity / _blend_mode / _visibility / _locked / rename_layer
//    → ps_set_layer(property)
//  - merge_visible_layers / stamp_visible / flatten_image → ps_merge(mode)
// The per-property/per-mode handlers are unchanged; these tests pin the
// (name, params) forwarded to the SnippetClient, reached via the discriminator.

describe('createLayerPropertiesTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 8 well-formed tools', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.length).toBe(8);
    expect(tools.map((t) => t.tool.name)).toEqual([
      'ps_convert_to_smart_object',
      'ps_rasterize_layer',
      'ps_set_layer',
      'ps_duplicate_layer',
      'ps_copy_to_new_layer',
      'ps_merge',
      'ps_bake_layer',
      'ps_add_layer_style',
    ]);
  });

  it('convert_to_smart_object dispatches the convertToSmartObject snippet', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_convert_to_smart_object', {});
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('convertToSmartObject');
    expect(conn.executions.length).toBe(1);
  });

  it('convert_to_smart_object defaults mode=convert → convertToSmartObject', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_convert_to_smart_object', { mode: 'convert' });
    expect(snippetClient.lastBuild().name).toBe('convertToSmartObject');
  });

  // 2026-06-29 — new_via_copy added after the m4a STEP-02 capture
  // (placedLayerMakeCopy; independent SO copy).
  it('convert_to_smart_object mode=new_via_copy → newSmartObjectViaCopy', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_convert_to_smart_object', { mode: 'new_via_copy' });
    expect(snippetClient.lastBuild().name).toBe('newSmartObjectViaCopy');
  });

  it('convert_to_smart_object exposes a mode enum (convert/new_via_copy)', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_convert_to_smart_object')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { mode: { enum: string[]; default: string } };
    };
    expect(new Set(schema.properties.mode.enum)).toEqual(new Set(['convert', 'new_via_copy']));
    expect(schema.properties.mode.default).toBe('convert');
  });

  it('convert_to_smart_object description mentions Smart Filter and non-destructive', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_convert_to_smart_object')!;
    const desc = tool.tool.description ?? '';
    expect(desc).toMatch(/smart filter/i);
    expect(desc).toMatch(/non-destructive/i);
  });

  it('layer_via_copy dispatches the layerViaCopy snippet', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_copy_to_new_layer', {});
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('layerViaCopy');
    expect(conn.executions.length).toBe(1);
  });

  it('layer_via_copy description explains selection-to-new-layer behavior', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_copy_to_new_layer')!;
    const desc = tool.tool.description ?? '';
    expect(desc).toMatch(/selection/i);
    expect(desc).toMatch(/new layer/i);
  });

  // ===========================================================================
  // Phase 4 (layer-placement bug) — layer_via_copy's into_active_group
  // forwarding. The underlying CpTL event carries no placement target, so
  // with a group active PS nests the new layer INSIDE it; the Go emitter
  // hoists it back out by default (into_active_group defaults false). This
  // harness can't observe the emitted JSX (snippetClient.build() is faked to
  // record {name, params} only), so it just pins that the flag reaches the
  // snippet params correctly. See go-core/layer_placement_test.go for the
  // emitted-fragment assertions.
  // ===========================================================================
  it('layer_via_copy defaults into_active_group to false when omitted', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_copy_to_new_layer', {});
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(false);
  });

  it('layer_via_copy forwards into_active_group:true', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_copy_to_new_layer', { into_active_group: true });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(true);
  });

  // 2026-06-29 — layer-style family extension (capture m4b STEP-37/38/41).
  it('add_layer_style exposes the six styles incl. the m4b additions', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_add_layer_style')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { style: { enum: string[] } };
    };
    expect(schema.properties.style.enum).toEqual([
      'drop_shadow',
      'stroke',
      'outer_glow',
      'inner_shadow',
      'inner_glow',
      'color_overlay',
    ]);
  });

  it('add_layer_style inner_shadow forwards styleType + shadow params', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_layer_style', {
      style: 'inner_shadow',
      color: { r: 0, g: 0, b: 0 },
      opacity: 60,
      angle: 120,
      distance: 6,
      size: 10,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addLayerStyle');
    expect(build.params.styleType).toBe('inner_shadow');
    expect(build.params.angle).toBe(120);
    expect(build.params.size).toBe(10);
  });

  it('add_layer_style color_overlay forwards styleType + color', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_layer_style', {
      style: 'color_overlay',
      color: { r: 10, g: 40, b: 200 },
      opacity: 100,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addLayerStyle');
    expect(build.params.styleType).toBe('color_overlay');
    expect(build.params.color).toEqual({ r: 10, g: 40, b: 200 });
  });

  it('bake_layer dispatches the bakeLayer snippet', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_bake_layer', {});
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('bakeLayer');
    expect(conn.executions.length).toBe(1);
  });

  // ---------- ps_set_layer ----------

  it('the property field enumerates the five setters', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_set_layer')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { property: { enum: string[] } };
    };
    expect(schema.properties.property.enum).toEqual([
      'opacity',
      'blend_mode',
      'visibility',
      'locked',
      'name',
    ]);
  });

  it('set_layer outputSchema declares the context field', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_set_layer')!;
    const out = tool.tool.outputSchema as { properties: Record<string, unknown> };
    expect(out.properties).toHaveProperty('context');
  });

  it('property=opacity passes opacity value to the snippet', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_layer', { property: 'opacity', opacity: 75 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setLayerOpacity');
    expect(build.params.opacity).toBe(75);
  });

  it('property=opacity with fill_percent passes fillOpacity to the snippet', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_layer', { property: 'opacity', fill_percent: 50 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setLayerOpacity');
    expect(build.params.fillOpacity).toBe(50);
    expect(build.params.opacity).toBeUndefined();
  });

  it('property=blend_mode passes the blend mode to the snippet', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_layer', {
      property: 'blend_mode',
      blend_mode: 'MULTIPLY',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setLayerBlendMode');
    expect(build.params.blendMode).toBe('MULTIPLY');
  });

  it('property=visibility dispatches setLayerVisibility', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_layer', { property: 'visibility', visible: false });
    expect(conn.executions).toHaveLength(1);
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setLayerVisibility');
    expect(build.params.visible).toBe(false);
  });

  it('property=locked dispatches setLayerLocked', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_layer', { property: 'locked', locked: true });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setLayerLocked');
    expect(build.params.locked).toBe(true);
  });

  it('property=name passes the new name to the snippet', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_layer', { property: 'name', name: 'foo "bar"' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('renameLayer');
    expect(build.params.newName).toBe('foo "bar"');
  });

  it('an unknown set_layer property returns an error without dispatching', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_layer', { property: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- Fix 4 (Phase 2, 2026-07): prose reflects the verified ACTUAL
  // result, not the echoed request argument. Each snippet's structured
  // result would never actually disagree with the request in production
  // (a mismatch throws before the snippet returns — see Fix 3), but the
  // handler itself doesn't know that invariant; these tests set the fake
  // connection's result to a value that DIFFERS from what was requested to
  // prove the human-readable text is built from the result, not the arg.
  // ----------

  // These fixtures mirror the REAL return shapes of the two snippets behind
  // ps_set_layer property=opacity. They diverge, and an earlier fixture here
  // invented a hybrid ({ value, fill_opacity }) that neither snippet emits,
  // so it passed while production silently dropped the opacity value on the
  // fill path. Keep these aligned with vault.SetOpacity / vault.SetFillOp.
  it('property=opacity renders the verified actual value, not the requested arg', async () => {
    // setLayerOpacity (opacity only) → the value arrives as `value`.
    const c = makeConnection({
      result: { property: 'opacity', value: 40, requested: 75, verified: true },
    });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_layer', { property: 'opacity', opacity: 75 });
    const text = textOf(result);
    expect(text).toContain('opacity 40%');
    expect(text).not.toContain('75');
  });

  it('property=opacity with fill_percent renders BOTH verified values', async () => {
    // setLayerOpacityFull → the opacity value arrives as `opacity`, NOT
    // `value`. Reading `value` here drops it from the prose entirely.
    const c = makeConnection({
      result: {
        property: 'fillOpacity',
        fill_opacity: 60,
        requested_fill_opacity: 55,
        fill_opacity_verified: true,
        opacity: 40,
        requested_opacity: 75,
        opacity_verified: true,
      },
    });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_layer', {
      property: 'opacity',
      opacity: 75,
      fill_percent: 55,
    });
    const text = textOf(result);
    expect(text).toContain('opacity 40%');
    expect(text).toContain('fill 60%');
    expect(text).not.toContain('75');
    expect(text).not.toContain('55');
  });

  it('property=opacity with fill_percent only does not claim an opacity the caller never set', async () => {
    // requested_opacity is null on the fill-only branch and `opacity` is
    // just a fresh read of the layer's existing value — reporting it would
    // tell the caller they set something they didn't.
    const c = makeConnection({
      result: {
        property: 'fillOpacity',
        fill_opacity: 60,
        requested_fill_opacity: 60,
        fill_opacity_verified: true,
        opacity: 100,
        requested_opacity: null,
        opacity_verified: null,
      },
    });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_layer', {
      property: 'opacity',
      fill_percent: 60,
    });
    const text = textOf(result);
    expect(text).toContain('fill 60%');
    expect(text).not.toContain('opacity 100%');
  });

  it('property=opacity falls back to a generic label when the result carries no value fields', async () => {
    const c = makeConnection({ result: { property: 'opacity' } });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_layer', { property: 'opacity', opacity: 75 });
    expect(textOf(result)).toBe('Layer opacity set');
  });

  it('property=blend_mode renders the verified actual blend mode, not the requested arg', async () => {
    const c = makeConnection({ result: { value: 'SCREEN' } });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_layer', {
      property: 'blend_mode',
      blend_mode: 'MULTIPLY',
    });
    const text = textOf(result);
    expect(text).toContain('SCREEN');
    expect(text).not.toContain('MULTIPLY');
  });

  it('property=visibility renders the verified actual visibility, not the requested arg', async () => {
    const c = makeConnection({ result: { visible: true } });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    // Request asks to HIDE the layer; the (fake) result says it's shown.
    const result = await callTool(tools, 'ps_set_layer', {
      property: 'visibility',
      visible: false,
    });
    expect(textOf(result)).toBe('Layer shown');
  });

  it('property=locked renders the verified actual lock state, not the requested arg', async () => {
    const c = makeConnection({ result: { locked: false } });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    // Request asks to LOCK the layer; the (fake) result says it's unlocked.
    const result = await callTool(tools, 'ps_set_layer', { property: 'locked', locked: true });
    expect(textOf(result)).toBe('Layer unlocked');
  });

  it('property=name renders the verified actual new name, not the requested arg', async () => {
    const c = makeConnection({ result: { newName: 'Actually Renamed' } });
    const tools = createLayerPropertiesTools(c.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_layer', {
      property: 'name',
      name: 'Requested Name',
    });
    const text = textOf(result);
    expect(text).toContain('Actually Renamed');
    expect(text).not.toContain('Requested Name');
  });

  // ---------- ps_merge ----------

  it('the mode field enumerates the three merge modes', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_merge')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { mode: { enum: string[] } };
    };
    expect(schema.properties.mode.enum).toEqual(['visible', 'stamp', 'flatten']);
  });

  it('mode=visible dispatches mergeVisibleLayers', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_merge', { mode: 'visible' });
    expect(snippetClient.lastBuild().name).toBe('mergeVisibleLayers');
  });

  it('mode=stamp dispatches stampVisible', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_merge', { mode: 'stamp' });
    expect(snippetClient.lastBuild().name).toBe('stampVisible');
  });

  it('mode=flatten dispatches flattenImage', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_merge', { mode: 'flatten' });
    expect(snippetClient.lastBuild().name).toBe('flattenImage');
  });

  it('merge description contrasts the destructive vs non-destructive modes', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_merge')!;
    const desc = tool.tool.description ?? '';
    expect(desc).toMatch(/non-destructive/i);
    expect(desc).toMatch(/Ctrl\+Alt\+Shift\+E|stamp/i);
    expect(desc).toMatch(/destructive/i);
  });

  it('an unknown merge mode returns an error without dispatching', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_merge', { mode: 'bogus' });
    expect(result.isError).toBe(true);
    expect(conn.executions.length).toBe(0);
  });

  // ---------- kept tools ----------

  it('duplicate_layer is annotated idempotentHint: false (not safely retryable)', () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_duplicate_layer')!;
    const ann = tool.tool.annotations as Record<string, unknown>;
    expect(ann.idempotentHint).toBe(false);
  });

  it('rasterize_layer dispatches a script', async () => {
    const tools = createLayerPropertiesTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_rasterize_layer');
    expect(conn.executions).toHaveLength(1);
    expect(snippetClient.lastBuild().name).toBe('rasterizeLayer');
  });
});
