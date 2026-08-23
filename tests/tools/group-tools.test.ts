import { describe, it, expect, beforeEach } from 'vitest';
import { createGroupTools, GROUP_OP_SCHEMAS } from '@editmamei/tools/group-tools.ts';
import { makeConnection, FakePhotoshopConnection } from '../fixtures/fake-connection.ts';
import { assertToolShape, callTool, textOf } from '../fixtures/tool-helpers.ts';
import { makeSnippetClient, FakeSnippetClient } from '../fixtures/fake-snippet-client.ts';

describe('createGroupTools', () => {
  let conn: FakePhotoshopConnection;
  let snippetClient: FakeSnippetClient;

  beforeEach(() => {
    conn = makeConnection();
    snippetClient = makeSnippetClient();
  });

  it('returns 2 well-formed tools', () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name).sort()).toEqual(['ps_clipping_mask', 'ps_group']);
  });

  it('clipping_mask op=create dispatches the createClippingMask snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_clipping_mask', { op: 'create' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createClippingMask');
    expect(build.params).toEqual({});
  });

  it('clipping_mask op=release dispatches the releaseClippingMask snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_clipping_mask', { op: 'release' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('releaseClippingMask');
    expect(build.params).toEqual({});
  });

  it('clipping_mask rejects an unknown op without building or executing, naming the allowed set', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_clipping_mask', { op: 'invert' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Allowed: create, release/);
    expect(snippetClient.allBuilds().length).toBe(0);
    expect(conn.executions.length).toBe(0);
  });

  it('clipping_mask rejects a missing op the same way', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_clipping_mask', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Allowed: create, release/);
    expect(snippetClient.allBuilds().length).toBe(0);
    expect(conn.executions.length).toBe(0);
  });

  // The idempotent no-op branches are the user-visible half of the .grouped
  // guards — pin each branch's success text against its result flag so a
  // refactor of the flag names can't silently report a fresh clip/release
  // for a call that was actually a no-op.
  it('clipping_mask op=create reports the already-clipped no-op distinctly', async () => {
    conn = makeConnection({
      result: { clipped: true, already_clipped: true, layerName: 'Texture' },
    });
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_clipping_mask', { op: 'create' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/already clipped — nothing to do/);
    expect(textOf(result)).toContain('Texture');
  });

  it('clipping_mask op=create reports a fresh clip', async () => {
    conn = makeConnection({ result: { clipped: true, layerName: 'Texture' } });
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_clipping_mask', { op: 'create' });
    expect(textOf(result)).toMatch(/Clipped layer "Texture" to the layer below/);
  });

  it('clipping_mask op=release reports the not-clipped no-op distinctly', async () => {
    conn = makeConnection({ result: { released: false, layerName: 'Sky' } });
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_clipping_mask', { op: 'release' });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/not clipped — nothing to release/);
    expect(textOf(result)).toContain('Sky');
  });

  it('clipping_mask op=release reports a real release', async () => {
    conn = makeConnection({ result: { released: true, layerName: 'Sky' } });
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_clipping_mask', { op: 'release' });
    expect(textOf(result)).toMatch(/Released clipping mask on layer "Sky"/);
  });

  // ===========================================================================
  // ps_group — group lifecycle and membership under one op discriminator.
  // Each op strips `op` and hands the rest to its own handler, which
  // re-validates against its own per-op schema.
  // ===========================================================================

  it('group op=create dispatches the createGroup snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', { op: 'create', name: 'edits', layers: ['Sky'] });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createGroup');
    expect(build.params.name).toBe('edits');
    expect(build.params.layerNames).toEqual(['Sky']);
  });

  // ===========================================================================
  // Phase 4 (layer-placement bug) — into_active_group forwarding.
  //
  // The Go emitter hoists the new group out of an active group by default
  // (into_active_group defaults false); this harness can't observe the
  // emitted JSX (snippetClient.build() is faked to record {name, params}
  // only), so it just pins that the flag reaches the snippet params
  // correctly. See go-core/layer_placement_test.go for the emitted-fragment
  // assertions and the "community" live-smoke scenario's
  // create-nesting-test-group/adj-while-group-active/
  // layer-tree-nesting-check steps for the real-Photoshop verification.
  // ===========================================================================
  it('group op=create forwards into_active_group:true', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', {
      op: 'create',
      name: 'edits',
      into_active_group: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(true);
  });

  // The op=create dispatch test above passes the optional params explicitly,
  // which hides a defaulting drift. Call it with the bare minimum and pin the
  // defaults themselves — a hoist default that silently flips changes where
  // every group lands.
  it('group op=create with only a name applies the documented hoist default', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', { op: 'create', name: 'edits' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createGroup');
    expect(build.params).toEqual({ name: 'edits', into_active_group: false });
  });

  // ===========================================================================
  // Bug I (createGroup) — em-dash normalization regression pin
  //
  // Session 2026-06-04 (IMG_1022 grade) created a group with a layers list
  // ["Warm — 81", "Curves — S-pop", "Vibrance", "Levels — contrast"] and got
  // moved_count=1 — only "Vibrance" (no em-dash) matched. The other three
  // landed in notFound silently. moveLayerToGroup had been fixed for the same
  // class of bug, but the fix didn't propagate to createGroup. This pin matches
  // the existing one on op=add_layer below.
  // ===========================================================================
  it('group op=create passes em-dash layer names through to the snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', {
      op: 'create',
      name: 'Hero grade',
      layers: ['Warm — 81', 'Curves — S-pop', 'Vibrance', 'Levels — contrast'],
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createGroup');
    expect(build.params.layerNames as string[]).toContain('Warm — 81');
    expect(build.params.layerNames as string[]).toContain('Curves — S-pop');
  });

  it('group op=add_layer dispatches the moveLayerToGroup snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', {
      op: 'add_layer',
      layer_name: 'Curves 1',
      group_name: 'edits',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('moveLayerToGroup');
    expect(build.params.layerName).toBe('Curves 1');
    expect(build.params.groupName).toBe('edits');
  });

  // ===========================================================================
  // Bug I — add_layer em-dash normalization regression pin
  //
  // The Windows 2026-05-29 session created a group named "EDITS — Full Workup"
  // (em-dash U+2014) and a later move call passed "EDITS - Full Workup"
  // (hyphen-minus). The lookup did strict === and failed with "Group not
  // found." The fix normalizes all dash variants and folds case + whitespace
  // before comparing. That normalization is a Go binary test — the logic lives
  // in the Go implementation, not the JSON params, so what this pins is that
  // the names reach the snippet unmangled.
  // ===========================================================================
  it('group op=add_layer passes em-dash names through to the snippet verbatim', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', {
      op: 'add_layer',
      layer_name: 'High-Pass Sharpening',
      group_name: 'EDITS - Full Workup',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('moveLayerToGroup');
    expect(build.params.layerName).toBe('High-Pass Sharpening');
    expect(build.params.groupName).toBe('EDITS - Full Workup');
  });

  it('group op=set_blend_mode dispatches the setGroupBlendMode snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', {
      op: 'set_blend_mode',
      name: 'edits',
      blend_mode: 'NORMAL',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setGroupBlendMode');
    expect(build.params.groupName).toBe('edits');
    expect(build.params.blendMode).toBe('NORMAL');
  });

  it('group op=set_blend_mode rejects unknown blend modes at the schema layer', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_group', {
      op: 'set_blend_mode',
      name: 'edits',
      blend_mode: 'NOT_A_REAL_MODE',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/blend_mode/i);
  });

  it('group op=ungroup refuses without confirm:true', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_group', {
      op: 'ungroup',
      name: 'edits',
      confirm: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm:true/);
    expect(conn.executions.length).toBe(0);
  });

  it('group op=ungroup with confirm:true dispatches the ungroup snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', { op: 'ungroup', name: 'edits', confirm: true });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('ungroup');
    expect(build.params.groupName).toBe('edits');
  });

  it('group op=delete refuses without confirm:true', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_group', {
      op: 'delete',
      name: 'edits',
      confirm: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm:true/);
    expect(conn.executions.length).toBe(0);
  });

  it('group op=delete with confirm:true dispatches the deleteGroup snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', { op: 'delete', name: 'edits', confirm: true });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('deleteGroup');
    expect(build.params.name).toBe('edits');
  });

  it('group rejects an unknown op without building or executing, naming the allowed set', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_group', { op: 'rename' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Allowed: create, delete, ungroup, add_layer, set_blend_mode/);
    expect(snippetClient.allBuilds().length).toBe(0);
    expect(conn.executions.length).toBe(0);
  });

  // Each op is one round trip to Photoshop. A handler that grew a second
  // dispatch — a probe, a re-select, a retry — would double the cost of every
  // group call without changing a single param assertion above.
  it('every group op dispatches exactly one script per call', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', { op: 'create', name: 'g' });
    await callTool(tools, 'ps_group', { op: 'add_layer', layer_name: 'l', group_name: 'g' });
    await callTool(tools, 'ps_group', { op: 'set_blend_mode', name: 'g', blend_mode: 'NORMAL' });
    await callTool(tools, 'ps_group', { op: 'ungroup', name: 'g', confirm: true });
    await callTool(tools, 'ps_group', { op: 'delete', name: 'g', confirm: true });
    // 5 ops * 1 script each = 5 executions
    expect(conn.executions.length).toBe(5);
  });

  it('ps_group missing op errors with the unknown-discriminator message and dispatches nothing', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_group', { name: 'edits' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Allowed: create, delete, ungroup, add_layer, set_blend_mode/);
    expect(snippetClient.allBuilds().length).toBe(0);
    expect(conn.executions.length).toBe(0);
  });

  // The merged schema is what the caller reads in tools/list; the per-op
  // schema is what the handler validates against. A param present only in the
  // latter is invisible and un-passable. Driven off the per-op schemas' own
  // property keys so a rename there fails here instead of silently dropping
  // the param out of the advertised surface.
  it('the ps_group schema advertises every property the five per-op schemas validate', () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const merged = tools.find((t) => t.tool.name === 'ps_group')!.tool.inputSchema as unknown as {
      properties: Record<string, unknown>;
    };
    const advertised = Object.keys(merged.properties);
    for (const [op, schema] of Object.entries(GROUP_OP_SCHEMAS)) {
      for (const prop of Object.keys(schema.properties ?? {})) {
        expect(
          advertised,
          `ps_group op=${op} validates "${prop}", which the merged schema hides`
        ).toContain(prop);
      }
    }
  });
});
