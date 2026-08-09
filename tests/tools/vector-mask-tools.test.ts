/**
 * ps_vector_mask — vector-mask ops (the path consumer that turns a
 * real editable path into a layer's vector mask).
 *
 * These unit tests pin the TS→snippet (name, params) forwarding contract.
 * Vector masks are AM-only (no DOM API). add/delete/link/unlink + reveal_all/
 * hide_all + enable/disable are all ScriptListener-capture-verified and live-run
 * against real Photoshop (the semantic gate); the tool ships at community tier.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createVectorMaskTools } from '@editmamei/tools/vector-mask-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createVectorMaskTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection({
      result: {
        vector_mask_added: true,
        vector_mask_deleted: true,
        vector_mask_linked: true,
        source: 'from_current_path',
        layer_name: 'Layer 1',
      },
    });
    snippetClient = makeSnippetClient();
  });

  it('exposes a single well-formed tool named ps_vector_mask', () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name)).toEqual(['ps_vector_mask']);
  });

  it('op enum exposes add/delete/link/unlink/enable/disable', () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { op: { enum: string[] } };
    };
    expect(new Set(schema.properties.op.enum)).toEqual(
      new Set(['add', 'delete', 'link', 'unlink', 'enable', 'disable'])
    );
  });

  // 2026-06-29 — reveal_all/hide_all added after a ScriptListener capture.
  it('add source enum includes from_current_path + reveal_all/hide_all', () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    const schema = tools[0].tool.inputSchema as unknown as {
      properties: { source: { enum: string[]; default: string } };
    };
    expect(schema.properties.source.enum).toEqual(['from_current_path', 'reveal_all', 'hide_all']);
    expect(schema.properties.source.default).toBe('from_current_path');
  });

  it('add → addVectorMask forwarding the source', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'add', source: 'from_current_path' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('addVectorMask');
    expect(build.params.source).toBe('from_current_path');
  });

  it('add → addVectorMask forwards reveal_all / hide_all', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'add', source: 'reveal_all' });
    expect(snippetClient.lastBuild().params.source).toBe('reveal_all');
    await callTool(tools, 'ps_vector_mask', { op: 'add', source: 'hide_all' });
    expect(snippetClient.lastBuild().params.source).toBe('hide_all');
  });

  it('add defaults source to from_current_path', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'add' });
    expect(snippetClient.lastBuild().params.source).toBe('from_current_path');
  });

  it('delete → deleteVectorMask', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'delete' });
    expect(snippetClient.lastBuild().name).toBe('deleteVectorMask');
  });

  it('link → setVectorMaskLink with linked=true', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'link' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setVectorMaskLink');
    expect(build.params.linked).toBe(true);
  });

  it('unlink → setVectorMaskLink with linked=false', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'unlink' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setVectorMaskLink');
    expect(build.params.linked).toBe(false);
  });

  // 2026-06-29 — enable/disable added after a ScriptListener capture
  // (setd vectorMaskEnabled boolean).
  it('enable → setVectorMaskEnabled with enabled=true', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'enable' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setVectorMaskEnabled');
    expect(build.params.enabled).toBe(true);
  });

  it('disable → setVectorMaskEnabled with enabled=false', async () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_vector_mask', { op: 'disable' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setVectorMaskEnabled');
    expect(build.params.enabled).toBe(false);
  });

  it('is marked destructive and non-idempotent', () => {
    const tools = createVectorMaskTools(conn.asConnection(), snippetClient);
    const ann = tools[0].tool.annotations;
    expect(ann?.destructiveHint).toBe(true);
    expect(ann?.idempotentHint).toBe(false);
  });
});
