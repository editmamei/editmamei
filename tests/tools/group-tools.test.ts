import { describe, it, expect, beforeEach } from 'vitest';
import { createGroupTools } from '@editmamei/tools/group-tools.ts';
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

  it('returns 7 well-formed tools', () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    assertToolShape(tools);
    expect(tools.map((t) => t.tool.name).sort()).toEqual([
      'ps_clipping_mask',
      'ps_create_group',
      'ps_delete_group',
      'ps_group',
      'ps_move_layer_to_group',
      'ps_set_group_blend_mode',
      'ps_ungroup',
    ]);
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

  it('create_group passes name and dispatches the createGroup snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_create_group', { name: 'edits' });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createGroup');
    expect(build.params.name).toBe('edits');
  });

  it('create_group with layers list passes layers array param', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_create_group', {
      name: 'group A',
      layers: ['Sky', 'Foreground', 'Subject'],
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createGroup');
    expect(build.params.name).toBe('group A');
    expect(build.params.layerNames).toEqual(['Sky', 'Foreground', 'Subject']);
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
  it('create_group defaults into_active_group to false when omitted', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_create_group', { name: 'edits' });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(false);
  });

  it('create_group forwards into_active_group:true', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_create_group', { name: 'edits', into_active_group: true });
    const build = snippetClient.lastBuild();
    expect(build.params.into_active_group).toBe(true);
  });

  // ===========================================================================
  // Bug I (createGroup) — em-dash normalization regression pin
  //
  // Session 2026-06-04 (IMG_1022 grade) called create_group with a layers list
  // ["Warm — 81", "Curves — S-pop", "Vibrance", "Levels — contrast"] and got
  // moved_count=1 — only "Vibrance" (no em-dash) matched. The other three
  // landed in notFound silently. moveLayerToGroup had been fixed for the same
  // class of bug, but the fix didn't propagate to createGroup. This pin matches
  // the existing one on move_layer_to_group below.
  // ===========================================================================
  it('create_group passes em-dash layer names through to the snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_create_group', {
      name: 'Hero grade',
      layers: ['Warm — 81', 'Curves — S-pop', 'Vibrance', 'Levels — contrast'],
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createGroup');
    expect(build.params.layerNames as string[]).toContain('Warm — 81');
    expect(build.params.layerNames as string[]).toContain('Curves — S-pop');
  });

  it('move_layer_to_group passes both layer and group names', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_move_layer_to_group', {
      layer_name: 'Curves 1',
      group_name: 'edits',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('moveLayerToGroup');
    expect(build.params.layerName).toBe('Curves 1');
    expect(build.params.groupName).toBe('edits');
  });

  // ===========================================================================
  // Bug I — move_layer_to_group em-dash normalization regression pin
  //
  // The Windows 2026-05-29 session created a group named "EDITS — Full Workup"
  // (em-dash U+2014) and a later move_layer_to_group call passed "EDITS - Full
  // Workup" (hyphen-minus). The lookup did strict === and failed with "Group
  // not found." The fix normalizes all dash variants and folds case + whitespace
  // before comparing. This is now a Go binary test — the snippet normalization
  // logic lives in the Go implementation, not the JSON params.
  // ===========================================================================
  it('move_layer_to_group passes em-dash names through to the snippet verbatim', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_move_layer_to_group', {
      layer_name: 'High-Pass Sharpening',
      group_name: 'EDITS - Full Workup',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('moveLayerToGroup');
    expect(build.params.layerName).toBe('High-Pass Sharpening');
    expect(build.params.groupName).toBe('EDITS - Full Workup');
  });

  it('set_group_blend_mode passes name and blend_mode params', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_set_group_blend_mode', {
      name: 'edits',
      blend_mode: 'NORMAL',
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('setGroupBlendMode');
    expect(build.params.groupName).toBe('edits');
    expect(build.params.blendMode).toBe('NORMAL');
  });

  it('set_group_blend_mode rejects unknown blend modes at the schema layer', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_set_group_blend_mode', {
      name: 'edits',
      blend_mode: 'NOT_A_REAL_MODE',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/blend_mode/i);
  });

  it('ungroup refuses without confirm:true', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_ungroup', {
      name: 'edits',
      confirm: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm:true/);
    expect(conn.executions.length).toBe(0);
  });

  it('ungroup with confirm:true passes name to snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_ungroup', {
      name: 'edits',
      confirm: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('ungroup');
    expect(build.params.groupName).toBe('edits');
  });

  it('delete_group refuses without confirm:true', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    const result = await callTool(tools, 'ps_delete_group', {
      name: 'edits',
      confirm: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm:true/);
    expect(conn.executions.length).toBe(0);
  });

  it('delete_group with confirm:true passes name to snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_delete_group', {
      name: 'edits',
      confirm: true,
    });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('deleteGroup');
    expect(build.params.name).toBe('edits');
  });

  it('every group walker dispatches exactly one script per call', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    // Trigger each handler so we confirm each dispatches
    await callTool(tools, 'ps_create_group', { name: 'g' });
    await callTool(tools, 'ps_move_layer_to_group', { layer_name: 'l', group_name: 'g' });
    await callTool(tools, 'ps_set_group_blend_mode', { name: 'g', blend_mode: 'NORMAL' });
    await callTool(tools, 'ps_ungroup', { name: 'g', confirm: true });
    await callTool(tools, 'ps_delete_group', { name: 'g', confirm: true });
    // 5 tools * 1 script each = 5 executions
    expect(conn.executions.length).toBe(5);
  });

  // ===========================================================================
  // ps_group (2026-08-13) — the five names above consolidated into one
  // op-discriminated tool. Each op dispatches the exact same handler function
  // (and therefore the exact same snippet) the deprecated standalone tool
  // calls, so behavior-preservation is proven both by direct dispatch tests
  // here and by the equivalence tests below (old route vs new route, same
  // args in, same snippet + params out).
  // ===========================================================================

  it('group op=create dispatches the createGroup snippet', async () => {
    const tools = createGroupTools(conn.asConnection(), snippetClient);
    await callTool(tools, 'ps_group', { op: 'create', name: 'edits', layers: ['Sky'] });
    const build = snippetClient.lastBuild();
    expect(build.name).toBe('createGroup');
    expect(build.params.name).toBe('edits');
    expect(build.params.layerNames).toEqual(['Sky']);
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

  // The important equivalence: the five deprecated standalone tools and
  // ps_group's op dispatch must produce identical behavior. Both routes call
  // the same handler function, so this pins that fact rather than just
  // hoping the two code paths stay in sync.
  it('each deprecated standalone tool builds the identical snippet + params as the matching ps_group op', async () => {
    const cases: Array<{
      oldName: string;
      oldArgs: Record<string, unknown>;
      op: string;
      newArgs: Record<string, unknown>;
    }> = [
      {
        oldName: 'ps_create_group',
        oldArgs: { name: 'Hero grade', layers: ['Sky', 'Foreground'], into_active_group: true },
        op: 'create',
        newArgs: { name: 'Hero grade', layers: ['Sky', 'Foreground'], into_active_group: true },
      },
      {
        oldName: 'ps_delete_group',
        oldArgs: { name: 'edits', confirm: true },
        op: 'delete',
        newArgs: { name: 'edits', confirm: true },
      },
      {
        oldName: 'ps_ungroup',
        oldArgs: { name: 'edits', confirm: true },
        op: 'ungroup',
        newArgs: { name: 'edits', confirm: true },
      },
      {
        oldName: 'ps_move_layer_to_group',
        oldArgs: { layer_name: 'Curves 1', group_name: 'edits' },
        op: 'add_layer',
        newArgs: { layer_name: 'Curves 1', group_name: 'edits' },
      },
      {
        oldName: 'ps_set_group_blend_mode',
        oldArgs: { name: 'edits', blend_mode: 'MULTIPLY' },
        op: 'set_blend_mode',
        newArgs: { name: 'edits', blend_mode: 'MULTIPLY' },
      },
    ];

    for (const { oldName, oldArgs, op, newArgs } of cases) {
      const oldClient = makeSnippetClient();
      const newClient = makeSnippetClient();
      const oldTools = createGroupTools(conn.asConnection(), oldClient);
      const newTools = createGroupTools(conn.asConnection(), newClient);

      await callTool(oldTools, oldName, oldArgs);
      await callTool(newTools, 'ps_group', { op, ...newArgs });

      const oldBuild = oldClient.lastBuild();
      const newBuild = newClient.lastBuild();
      expect(oldBuild.name, op).toBe(newBuild.name);
      expect(oldBuild.params, op).toEqual(newBuild.params);
    }
  });
});
