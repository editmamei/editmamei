import { describe, it, expect, beforeEach } from 'vitest';
import { createLayerTools } from '@editmamei/tools/layer-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createLayerTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 6 well-formed tools', () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    // get_layer_tree merged into ps_inspect(what='layer_tree') — Phase 1b.
    expect(tools.map((t) => t.tool.name)).toEqual([
      'ps_create_layer',
      'ps_delete_layer',
      'ps_create_text_layer',
      'ps_fill_layer',
      'ps_add_fill_layer',
      'ps_select_layer',
    ]);
  });

  // 2026-06-20 — add_fill_layer (dev tier, capture STEP-32). Makes a solid-color
  // content/fill layer (distinct from fill_layer which bakes into pixels).
  it('add_fill_layer passes the solid color to the snippet', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_fill_layer', { red: 204, green: 44, blue: 44 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addFillLayer');
    expect(build.params.red).toBe(204);
    expect(build.params.green).toBe(44);
    expect(build.params.blue).toBe(44);
  });

  // ===========================================================================
  // Phase 4 (layer-placement bug) — add_fill_layer's into_active_group
  // forwarding. With a group active, the bare Mk contentLayer descriptor has
  // no target reference, so PS nests the new fill layer INSIDE it; the Go
  // emitter hoists it back out by default (into_active_group defaults
  // false). This harness can't observe the emitted JSX (snippetClient.build()
  // is faked to record {name, params} only), so it just pins that the flag
  // reaches the snippet params correctly. See go-core/layer_placement_test.go
  // for the emitted-fragment assertions.
  // ===========================================================================
  it('add_fill_layer defaults into_active_group to false when omitted', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_fill_layer', { red: 204, green: 44, blue: 44 });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(false);
  });

  it('add_fill_layer forwards into_active_group:true', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_fill_layer', {
      red: 204,
      green: 44,
      blue: 44,
      into_active_group: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(true);
  });

  // ===========================================================================
  // 2026-08 gradient build — fill_type=gradient routes to the
  // addGradientFillLayer snippet (captures 2026-06-20 STEP-13/14); solid_color
  // keeps the original snippet with rgb enforced at the handler (the schema no
  // longer hard-requires them because gradient calls omit them).
  // ===========================================================================
  it('add_fill_layer fill_type=gradient dispatches addGradientFillLayer with defaults', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_fill_layer', { fill_type: 'gradient' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addGradientFillLayer');
    expect(build.params.gradient_type).toBe('linear');
    expect(build.params.angle).toBe(90);
    expect(build.params.scale).toBe(100);
    expect(build.params.reverse).toBe(false);
    expect(build.params.dither).toBe(true);
    expect(build.params.offset_x).toBe(0);
    expect(build.params.offset_y).toBe(0);
    expect(build.params.into_active_group).toBe(false);
    expect(build.params.stops).toBeUndefined();
    expect(build.params.opacity_stops).toBeUndefined();
  });

  it('add_fill_layer fill_type=gradient forwards gradient params + stops verbatim', async () => {
    const stops = [
      { red: 10, green: 20, blue: 200, location: 0 },
      { red: 255, green: 128, blue: 0, location: 100, midpoint: 60 },
    ];
    const opacityStops = [
      { opacity: 100, location: 0 },
      { opacity: 0, location: 100 },
    ];
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_add_fill_layer', {
      fill_type: 'gradient',
      gradient_type: 'radial',
      angle: 0,
      scale: 120,
      reverse: true,
      dither: false,
      stops,
      opacity_stops: opacityStops,
      into_active_group: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addGradientFillLayer');
    expect(build.params.gradient_type).toBe('radial');
    expect(build.params.angle).toBe(0);
    expect(build.params.scale).toBe(120);
    expect(build.params.reverse).toBe(true);
    expect(build.params.dither).toBe(false);
    expect(build.params.stops).toEqual(stops);
    expect(build.params.opacity_stops).toEqual(opacityStops);
    expect(build.params.into_active_group).toBe(true);
  });

  it('add_fill_layer solid_color without rgb errors and dispatches no snippet', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_add_fill_layer', {});
    expect(result.isError).toBe(true);
    expect(snippetClient.allBuilds()).toHaveLength(0);
  });

  it('add_fill_layer solid_color with partial rgb errors and dispatches no snippet', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_add_fill_layer', { red: 255 });
    expect(result.isError).toBe(true);
    expect(snippetClient.allBuilds()).toHaveLength(0);
  });

  it('create_layer with name passes the name param to the snippet', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_create_layer', { name: 'A "B" C' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('newLayer');
    expect(build.params.name).toBe('A "B" C');
  });

  it('create_text_layer passes text, coordinates, and font_size params', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_create_text_layer', {
      text: 'Greetings',
      x: 250,
      y: 350,
      font_size: 48,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createTextLayer');
    expect(build.params.text).toBe('Greetings');
    expect(build.params.x).toBe(250);
    expect(build.params.y).toBe(350);
    expect(build.params.fontSize).toBe(48);
  });

  it('fill_layer passes RGB triple params', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_fill_layer', { red: 12, green: 34, blue: 56 });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('fillLayer');
    expect(build.params.red).toBe(12);
    expect(build.params.green).toBe(34);
    expect(build.params.blue).toBe(56);
  });

  it('delete_layer without name passes no name param', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_delete_layer', {});
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('deleteLayer');
    expect(build.params.name).toBeUndefined();
  });

  it('delete_layer with a name passes the name param', async () => {
    const tools = createLayerTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_delete_layer', { name: 'Dead Curves 1' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('deleteLayer');
    expect(build.params.name).toBe('Dead Curves 1');
  });
});
