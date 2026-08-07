import { describe, it, expect, beforeEach } from 'vitest';
import { createLayerOrderingTools } from '@editmamei/tools/layer-ordering-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createLayerOrderingTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;
  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 1 well-formed tool — the consolidated ordering primitive', () => {
    // Was 5 before 2026-05-31. The four direction-specific helpers
    // (_to_top, _to_bottom, _up, _down) were strict subsets of
    // move_layer_to_position (TOP / BOTTOM / ABOVE+target / BELOW+target)
    // and saw zero usage in six months of session logs.
    const tools = createLayerOrderingTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_move_layer_to_position']);
  });

  it('move_layer_to_position embeds target name and the canonical uppercase position', async () => {
    const tools = createLayerOrderingTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_move_layer_to_position', {
      target_layer_name: 'Sketch',
      position: 'ABOVE',
    });
    const script = conn.lastScript();
    expect(script).toContain('Sketch');
    expect(script).toContain('ABOVE');
  });

  it('move_layer_to_position rejects lowercase position (schema enum is uppercase only)', async () => {
    const tools = createLayerOrderingTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_move_layer_to_position', {
      target_layer_name: 'Sketch',
      position: 'above',
    });
    expect(result.isError).toBe(true);
  });

  it('move_layer_to_position errors helpfully on ABOVE without target_layer_name', async () => {
    const tools = createLayerOrderingTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_move_layer_to_position', {
      position: 'ABOVE',
    });
    expect(result.isError).toBe(true);
  });

  it('move_layer_to_position TOP works without target_layer_name', async () => {
    const tools = createLayerOrderingTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_move_layer_to_position', {
      position: 'TOP',
    });
    expect(result.isError).toBeUndefined();
  });

  it('move_layer_to_position layer_to_move arg moves a named layer (not the active one)', async () => {
    const tools = createLayerOrderingTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_move_layer_to_position', {
      position: 'ABOVE',
      target_layer_name: 'Background',
      layer_to_move: 'EDIT_v2',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('moveLayerToPosition');
    expect(build.params.layerToMoveName).toBe('EDIT_v2');
    expect(build.params.targetLayerName).toBe('Background');
  });

  // Regression pin: the four direction-specific tool names must not come back
  // unless their removal rationale is reconsidered.
  it('per-direction ordering primitives stay removed', () => {
    const tools = createLayerOrderingTools(conn.asConnection(), snippetClient);
    const names = new Set(tools.map((t) => t.tool.name));
    for (const removed of [
      'photoshop_move_layer_to_top',
      'photoshop_move_layer_to_bottom',
      'photoshop_move_layer_up',
      'photoshop_move_layer_down',
    ]) {
      expect(names.has(removed), removed).toBe(false);
    }
  });
});
