/**
 * ps_apply_image + ps_calculations — channel-compose tools.
 *
 * These unit tests pin the TS→snippet (name, params) forwarding contract. The
 * AM Apply Image / Calculations descriptors and the Clcn blend charIDs are
 * verified live against real Photoshop (the semantic gate); these tests cover the
 * mapping from tool args to the go-core emitter params.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createChannelComposeTools } from '@editmamei/tools/channel-compose-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createChannelComposeTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection({
      result: {
        applied: true,
        calculated: true,
        source_channel: 'RGB ',
        source_layer: 'merged',
        blend: 'Mltp',
        opacity: 100,
        target_layer_name: 'Apply Image (Layer 1)',
        new_channel_name: 'Alpha 1',
        channel_count: 5,
      },
    });
    snippetClient = makeSnippetClient();
  });

  it('exposes ps_apply_image + ps_calculations', () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_apply_image', 'ps_calculations']);
  });

  // ---------- ps_apply_image ----------

  it('apply_image forwards source + blend + opacity + apply_to_active_layer', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_image', {
      source_layer: 'merged',
      source_channel: 'green',
      blend: 'multiply',
      opacity: 80,
      apply_to_active_layer: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('applyImage');
    expect(build.params.sourceLayer).toBe('merged');
    expect(build.params.sourceChannel).toBe('green');
    expect(build.params.blend).toBe('multiply');
    expect(build.params.opacity).toBe(80);
    expect(build.params.applyToActiveLayer).toBe(true);
  });

  it('apply_image defaults: source rgb / merged, opacity 100, in-place false', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_image', { blend: 'screen' });
    const build = snippetClient.lastBuild();
    expect(build.params.sourceChannel).toBe('rgb');
    expect(build.params.sourceLayer).toBe('merged');
    expect(build.params.opacity).toBe(100);
    expect(build.params.applyToActiveLayer).toBe(false);
  });

  it('apply_image forwards source_alpha_name when channel=alpha', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_apply_image', {
      source_channel: 'alpha',
      source_alpha_name: 'mask1',
      blend: 'normal',
    });
    expect(snippetClient.lastBuild().params.sourceAlphaName).toBe('mask1');
  });

  it('apply_image errors when channel=alpha but no alpha name', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_image', {
      source_channel: 'alpha',
      blend: 'normal',
    });
    expect(result.isError).toBe(true);
  });

  it('apply_image requires blend', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_image', {});
    expect(result.isError).toBe(true);
  });

  it('apply_image is marked destructive', () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    const ann = tools.find((t) => t.tool.name === 'ps_apply_image')!.tool.annotations;
    expect(ann?.destructiveHint).toBe(true);
  });

  it('apply_image surfaces the caller-facing channel/blend, not the AM charID', async () => {
    // The fake connection returns the go-core echo (source_channel:'RGB ', blend:'Mltp');
    // the handler overrides both with what the caller asked for.
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_image', {
      source_channel: 'green',
      blend: 'multiply',
    });
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.source_channel).toBe('green');
    expect(sc.blend).toBe('multiply');
  });

  it('apply_image surfaces the alpha channel name when channel=alpha', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_apply_image', {
      source_channel: 'alpha',
      source_alpha_name: 'mask1',
      blend: 'screen',
    });
    expect((result.structuredContent as Record<string, unknown>).source_channel).toBe('mask1');
  });

  // ---------- ps_calculations ----------

  it('calculations forwards both sources + blend + opacity', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_calculations', {
      source1_layer: 'merged',
      source1_channel: 'red',
      source2_layer: 'Background',
      source2_channel: 'blue',
      blend: 'difference',
      opacity: 90,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('calculations');
    expect(build.params.source1Channel).toBe('red');
    expect(build.params.source2Layer).toBe('Background');
    expect(build.params.source2Channel).toBe('blue');
    expect(build.params.blend).toBe('difference');
    expect(build.params.opacity).toBe(90);
  });

  it('calculations forwards alpha names per source', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_calculations', {
      source1_channel: 'alpha',
      source1_alpha_name: 'a1',
      source2_channel: 'alpha',
      source2_alpha_name: 'a2',
      blend: 'multiply',
    });
    const build = snippetClient.lastBuild();
    expect(build.params.source1AlphaName).toBe('a1');
    expect(build.params.source2AlphaName).toBe('a2');
  });

  it('calculations errors when a source is alpha without a name', async () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_calculations', {
      source1_channel: 'alpha',
      blend: 'multiply',
    });
    expect(result.isError).toBe(true);
  });

  it('calculations does not offer rgb composite (single-channel only)', () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    const tool = tools.find((t) => t.tool.name === 'ps_calculations')!;
    const schema = tool.tool.inputSchema as unknown as {
      properties: { source1_channel: { enum: string[] } };
    };
    expect(schema.properties.source1_channel.enum).not.toContain('rgb');
  });

  it('both tools share the 12-mode blend enum', () => {
    const tools = createChannelComposeTools(conn.asConnection(), snippetClient);
    for (const name of ['ps_apply_image', 'ps_calculations']) {
      const tool = tools.find((t) => t.tool.name === name)!;
      const schema = tool.tool.inputSchema as unknown as {
        properties: { blend: { enum: string[] } };
      };
      expect(schema.properties.blend.enum).toContain('multiply');
      expect(schema.properties.blend.enum).toContain('difference');
      expect(schema.properties.blend.enum).toContain('add');
      expect(schema.properties.blend.enum.length).toBe(12);
    }
  });
});
